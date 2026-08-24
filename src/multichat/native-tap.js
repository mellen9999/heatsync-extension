// Native-chat tap — mirror messages Twitch's own page receives into the
// multichat buffer for the CURRENT channel.
//
// Why: Twitch starves third-party IRC reads on flagged IPs (vpn exits,
// datacenters) — the socket connects and JOINs fine but PRIVMSG delivery
// trickles to ~1 msg/20s, while history (robotty) loads normally, so chat
// looks frozen-after-history. The page's own delivery (Hermes/EventSub) is
// never throttled: the rows Twitch renders in native chat are the most
// reliable live source there is. We mine each new row's React fiber for the
// full message object (id, login, color, badges, emotes) and feed it through
// irc._handleMsg exactly like a PRIVMSG — same render path, same server
// archive relay (which also heals the site feed for watched channels) —
// deduped by message id against whatever IRC still delivers.
//
// Scope: the page's current channel only (background channels have no native
// DOM to tap — they need the server EventSub migration).

let _tapObserver = null
let _tapContainer = null
let _tapChannel = ''
let _tapRetryTimer = null // bind-retry while container missing
let _tapPollTimer = null // permanent remount watcher
const _tapStats = { mined: 0, fiberMiss: 0 }

function _tapFindContainer() {
  return hsQuery('twitch:chat-message-container', [
    CONFIG.SELECTORS.TWITCH_CHAT_CONTAINER,
    '[data-test-selector="chat-scrollable-area__message-container"]',
  ])
}

// Walk the row's fiber tree for memoizedProps.message (twitch's chat-line
// component). Shapes drift between twitch builds — every read is defensive.
function _tapMineMessage(rowEl) {
  if (typeof getFiber !== 'function') return null
  let f = null
  try {
    f = getFiber(rowEl)
  } catch (_) {
    return null
  }
  for (let i = 0; f && i < 30; i++, f = f.return) {
    const m = f.memoizedProps?.message
    if (m?.id && (m.user || m.message)) return m
  }
  return null
}

function _tapToMsg(m, channel) {
  const u = m.user || {}
  const display = u.userDisplayName || u.displayName || ''
  if (!display) return null
  // text + native twitch emotes from the typed fragment list
  let text = ''
  const emotes = {}
  const parts = m.messageParts || m.message?.messageParts || null
  if (Array.isArray(parts)) {
    for (const p of parts) {
      const c = p?.content
      if (typeof c === 'string') {
        text += c
        continue
      }
      if (c && typeof c === 'object') {
        const alt = c.alt || c.emoteName || ''
        if (alt) {
          text += alt
          const eid = c.emoteID || c.emoteId
          if (eid && !emotes[alt]) {
            emotes[alt] = `https://static-cdn.jtvnw.net/emoticons/v2/${eid}/default/dark/2.0`
          }
          continue
        }
        if (typeof c.text === 'string') {
          text += c.text
          continue
        }
        if (typeof c.url === 'string') {
          text += c.url
          continue
        }
        if (typeof c.displayName === 'string') {
          text += `@${c.displayName}`
          continue
        }
        if (typeof c.recipient === 'string') {
          text += `@${c.recipient}`
          continue
        }
        if (typeof p.text === 'string') {
          text += p.text
        }
      }
    }
  }
  if (!text && typeof m.messageBody === 'string') text = m.messageBody
  if (!text) return null

  const badges = m.badges || u.badges || null
  let badgeStr = ''
  if (Array.isArray(badges)) {
    badgeStr = badges
      .map((b) => (b?.setID ? `${b.setID}/${b.version || '1'}` : ''))
      .filter(Boolean)
      .join(',')
  } else if (badges && typeof badges === 'object') {
    badgeStr = Object.entries(badges)
      .map((kv) => `${kv[0]}/${kv[1]}`)
      .join(',')
  }

  // Reply context: twitch's message model carries a `reply` object (mirrors the
  // IRC reply-parent-* tags in irc.js). Without this, native-tapped replies —
  // the dominant source in popout / on throttled IPs — render with no "Replying
  // to" bar. Shapes drift across twitch builds, so every field is read
  // defensively with the known aliases.
  let replyTo = null
  const rp = m.reply || m.replyParent || null
  if (rp && (rp.parentDisplayName || rp.parentUserLogin || rp.parentMsgId)) {
    replyTo = {
      user: rp.parentDisplayName || rp.parentUserLogin || '',
      text: rp.parentMessageBody || rp.parentMsgBody || '',
      id: rp.parentMsgId || '',
      userId: String(rp.parentUid || rp.parentUserID || rp.parentUserId || ''),
      threadId: rp.threadParentMsgId || rp.parentMsgId || '',
    }
  }

  const msg = {
    user: display,
    login: (u.userLogin || u.login || display).toLowerCase(),
    userId: String(u.userID || u.userId || ''),
    text,
    color: u.color || '#fff',
    badges: badgeStr,
    channel,
    time: typeof m.timestamp === 'number' && m.timestamp > 1e12 ? m.timestamp : Date.now(),
    id: m.id,
    replyTo,
    fromNativeTap: true,
  }
  if (Object.keys(emotes).length) msg.twitchEmotes = emotes
  if (m.messageType === 1 || m.isAction) msg.isAction = true
  // shared-chat provenance (fiber + intercept relay both carry room ids;
  // names drift across twitch builds — check both casings)
  const roomID = m.roomID ?? m.roomId
  const srcRoomID = m.sourceRoomID ?? m.sourceRoomId
  if (roomID != null && srcRoomID != null && String(roomID) !== String(srcRoomID)) msg.sharedChat = true
  const subMatch = badgeStr.match(/subscriber\/(\d+)/)
  if (subMatch) msg.subMonths = parseInt(subMatch[1], 10)
  return msg
}

// Announcements (and some usernotices) mount as a WRAPPER node whose
// descendant is the chat-line__message — the strict class check on the added
// node itself silently dropped them from the tap (starved-IRC viewers never
// saw announcements at all). Detection is defensive against twitch build
// drift: wrapper class/test-selector, or a fiber-level marker.
function _tapIsAnnouncement(rowEl, mined) {
  try {
    const hint = String(mined?.msgId || mined?.messageType || '')
    if (/announce/i.test(hint)) return true
    if (rowEl.closest('[class*="announcement" i], [data-test-selector*="announcement" i]')) return true
  } catch (_) {}
  return false
}

function _tapHandleRow(rowEl) {
  if (rowEl?.nodeType !== 1) return
  if (!rowEl.classList?.contains('chat-line__message')) {
    // wrapper node (announcement container etc.) — recurse into the real row
    const inner = rowEl.querySelector?.('.chat-line__message')
    if (inner) _tapHandleRow(inner)
    return
  }
  // channel resolved at MINE time — twitch SPA navs change the page channel
  // without re-running init; a stale _tapChannel would file (and archive!)
  // messages under the previous channel
  let ch = _tapChannel
  try {
    ch = (getCurrentChannel() || _tapChannel || '').toLowerCase()
  } catch (_) {}
  if (!ch) return
  if (ch !== _tapChannel) _tapChannel = ch
  // richness guard: when IRC flow is HEALTHY for this channel (3+ msgs in
  // the last 10s) its copies are richer (replies/bits/highlights) — defer.
  // a starved trickle (1 msg/20s) must NOT suppress the tap.
  try {
    const ts = irc?._lastLiveAt?.get?.(ch)
    if (Array.isArray(ts) && ts.length >= 3 && Date.now() - ts[ts.length - 3] < 10_000) return
  } catch (_) {}
  const mined = _tapMineMessage(rowEl)
  if (!mined) {
    _tapStats.fiberMiss++
    return
  }
  const msg = _tapToMsg(mined, ch)
  if (!msg) return
  if (_tapIsAnnouncement(rowEl, mined)) {
    // tag so main.js classifies hs-mc-notice-announce — same shape irc.js
    // emits for USERNOTICE msg-id=announcement (systemMsg empty renders
    // "user: text" inside the announce-styled row)
    msg.type = 'usernotice'
    msg.msgId = 'announcement'
  }
  _tapStats.mined++
  try {
    irc?._handleMsg?.(msg)
  } catch (_) {}
}

function _tapBind() {
  const container = _tapFindContainer()
  if (!container) {
    if (!_tapRetryTimer)
      _tapRetryTimer = cleanup.setInterval(() => {
        const c = _tapFindContainer()
        if (c) {
          cleanup.clearInterval(_tapRetryTimer)
          _tapRetryTimer = null
          _tapBind()
        }
      }, 3000)
    return
  }
  if (_tapRetryTimer) {
    cleanup.clearInterval(_tapRetryTimer)
    _tapRetryTimer = null
  }
  if (container === _tapContainer && _tapObserver) return
  if (_tapObserver) {
    cleanup.untrackObserver(_tapObserver)
    _tapObserver = null
  }
  _tapContainer = container
  _tapObserver = new MutationObserver((muts) => {
    for (const mu of muts) {
      for (const node of mu.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue
        _tapHandleRow(node)
      }
    }
  })
  _tapObserver.observe(container, { childList: true })
  cleanup.trackObserver(_tapObserver)
  log('native-tap: bound to', _tapChannel)
}

// Public: start tapping the page's current channel. Re-call on SPA nav.
function startNativeTap(channel) {
  _tapChannel = (channel || '').toLowerCase()
  if (!_tapChannel) return
  _tapBind()
  // container re-mounts on theatre toggles / SPA settles — own timer slot so
  // the bind-retry can't shadow it (shared slot = poll never installed when
  // the container is missing at startup → tap dies on first remount)
  if (!_tapPollTimer)
    _tapPollTimer = cleanup.setInterval(() => {
      const c = _tapFindContainer()
      if (c && c !== _tapContainer) _tapBind()
    }, 5000)
  _nsStart()
}

// ── native chat takeover ─────────────────────────────────────────────────
// Partner of twitch-chat-intercept.js (MAIN world). While the overlay covers
// twitch chat, the MAIN-world hook swallows plain chat messages before
// Twitch's React renders them (the hidden column otherwise piles up untrimmed
// rows — measured +118MB on a busy channel) and relays each one here via
// postMessage. This side (a) feeds relayed messages through the same
// irc._handleMsg path as the DOM tap, and (b) owns the takeover signal: a
// body-dataset flag plus a heartbeat the MAIN world treats as a dead-man
// switch — beat goes stale for 45s → Twitch resumes rendering natively.
// The beat interval deliberately uses cleanup.setInterval, NOT the
// visibility-gated variant: a hidden tab must KEEP suppressing (that's the
// biggest RAM case), and overlay teardown clears the interval anyway, which
// stales the beat and fails open.
let _nsBeatTimer = null
let _nsRxBound = false

// Render-success gate: `#hs-mc-overlay` existing in the DOM is NOT proof it
// painted anything — a thrown ensureUIElements/switchTab/startLayoutWatcher
// pass (see main.js's tryHookReact/waitForMount) can leave a dead, empty
// husk that still passes `getElementById`. main.js flips this via
// setOverlayRenderOk() only after a render pass completes without throwing.
// Starts false so a not-yet-rendered or failed overlay never suppresses
// native chat — fail-open is the point.
let _nsOverlayRenderOk = false
function setOverlayRenderOk(ok) {
  _nsOverlayRenderOk = !!ok
}

function _nsTakeoverEnabled() {
  try {
    return getSetting('subsystems')?.['native-takeover'] !== false
  } catch (_) {
    return true
  }
}

function _nsNativeChatVisible() {
  const c = _tapFindContainer()
  if (!c) return false
  try {
    if (typeof c.checkVisibility === 'function')
      return c.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
  } catch (_) {}
  return c.getClientRects().length > 0
}

function _updateNativeSuppress() {
  const ds = document.body?.dataset
  if (!ds) return
  let on = false
  try {
    // Suppress only while the overlay exists AND actually rendered (not just
    // present-but-empty) AND twitch's own chat is actually invisible — the
    // moment the user reveals native chat (overlay hidden, position modes
    // that show it, teardown) rendering hands back.
    on =
      _nsTakeoverEnabled() &&
      !!document.getElementById('hs-mc-overlay') &&
      _nsOverlayRenderOk &&
      !_nsNativeChatVisible()
  } catch (_) {}
  if (on) {
    ds.hsSuppressNative = '1'
    ds.hsSuppressBeat = String(Date.now())
  } else if (ds.hsSuppressNative) {
    ds.hsSuppressNative = '0'
  }
  // Mirror the decision for early-layout.js's next-load pre-arm (twitch
  // renders its history backlog before the overlay boots; the mirror lets
  // document_start suppress it on pages that took over last time).
  try {
    localStorage.setItem('hs_layout_nativeTakeover', on ? '1' : '0')
  } catch (_) {}
}

// Stage counters, window-exposed (isolated world only — invisible to the
// page) so field debugging can read them over CDP/devtools without a rebuild.
const _nsStats = { rx: 0, dropOrigin: 0, dropShape: 0, dropNoCh: 0, dropRich: 0, nullMsg: 0, fed: 0, feedErr: 0 }
try {
  window.__hsNsStats = _nsStats
} catch (_) {}

function _nsStart() {
  if (!_nsRxBound) {
    _nsRxBound = true
    cleanup.addEventListener(window, 'message', (e) => {
      const d = e.data
      if (d?.__hsNativeMsg !== 1 || !d.m) return
      _nsStats.rx++
      if (e.source !== window || e.origin !== location.origin) {
        _nsStats.dropOrigin++
        return
      }
      // channel resolved at receive time — same SPA-nav rationale as the tap
      let ch = ''
      try {
        ch = (getCurrentChannel() || _tapChannel || '').toLowerCase()
      } catch (_) {}
      if (!ch) {
        _nsStats.dropNoCh++
        return
      }
      // richness guard, same as the DOM tap: healthy IRC delivers richer
      // copies (replies/bits/highlights) — let its copy win the id-dedup.
      try {
        const ts = irc?._lastLiveAt?.get?.(ch)
        if (Array.isArray(ts) && ts.length >= 3 && Date.now() - ts[ts.length - 3] < 10_000) {
          _nsStats.dropRich++
          return
        }
      } catch (_) {}
      const msg = _tapToMsg(d.m, ch)
      if (!msg) {
        _nsStats.nullMsg++
        return
      }
      _tapStats.mined++
      try {
        irc?._handleMsg?.(msg)
        _nsStats.fed++
      } catch (_) {
        _nsStats.feedErr++
      }
    })
  }
  if (!_nsBeatTimer) {
    _updateNativeSuppress()
    // Purely cosmetic recompute — skip ticks while hidden, catch up the
    // moment the tab is visible again (twitch can remount chat while hidden).
    _nsBeatTimer = cleanup.setIntervalIfVisible(_updateNativeSuppress, 15000)
    cleanup.addEventListener(document, 'visibilitychange', () => {
      if (!document.hidden) _updateNativeSuppress()
    })
  }
}

export { _tapToMsg }
