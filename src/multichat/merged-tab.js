// Merged tabs: twitch, kick and youtube in one pane.
//
// WHICH rows such a pane keeps is fairMerge's call (main.js), made inside
// renderMessages, and it stays the ONE policy: a firehose must not push a
// trickle out, so every platform is guaranteed its newest rows while all of
// them are live. This file is about how OFTEN that call has to be made.
//
// Asking costs a pass over every buffer and every row on screen, and it used
// to be asked once per frame while anyone was talking: 60 repaints a second
// on a busy tab. Now a plain live chat line is just appended, exactly where the
// render would have put it, and the render runs at most once a second (sooner
// when its answer could change). That is safe because of one fact about the policy:
//
//   while the same sources have rows and sit in the same live-or-stale mode,
//   a new row can only JOIN the kept set (pushing an older one out). It can
//   never bring back a row that was already dropped.
//
// So between renders the pane holds every row a render would keep, plus a few
// older ones the next render removes. The append itself never removes anything:
// the trim that makes room is always the real fair one, never a platform-blind
// slice off the top.
//
// Pure rules are exported for tests only (the build strips `export`).

const MT_RECONCILE_MS = 1000 // longest the pane may go without the real render
const MT_OVERSHOOT = 50 // most rows appended past a render (the single-platform pane's own slack)

// The sources of a merged tab, newest `take` rows of each, in the order
// fairMerge takes them: [twitch, kick, youtube]. ONE resolver for the render and
// for the append gate below, so they cannot disagree about what the tab shows.
// ensureJoined: the render also joins the live channels it is about to read.
function mergedTabSources(id, take, ensureJoined) {
  if (id === 'live') {
    const curCh = getLiveChannel()
    const platNames = getLivePlatformNames()
    // Use platform-specific names (may differ from curCh if overridden).
    // yt: no same-name fallback — curCh is a videoId/@handle, not a
    // twitch/kick channel (same rule as the boot auto-join; falling back
    // here silently re-joined the ghost videoId channel on every render).
    const urlChFallback = hostPlatform === 'yt' ? '' : curCh
    const twitchCh = platNames.twitch || urlChFallback
    const kickCh = platNames.kick || urlChFallback
    if (ensureJoined) {
      // Ensure channels are joined + history loaded
      if (twitchCh && irc && !irc.channels.has(twitchCh.toLowerCase())) irc.join(twitchCh)
      if (kickCh && kickChat && !kickChat.channels.has(kickCh.toLowerCase())) kickChat.join(kickCh)
    }
    // getTail (not getMessages/getAll): the render only ever shows the
    // newest SCROLLBACK_MAX rows (the hard DOM ceiling), so there's
    // no reason to copy the full 3000-cap buffer every render.
    const ircMsgs = twitchCh ? irc?.getTail(twitchCh, take) || [] : []
    let kickMsgs = kickCh ? kickChat?.getTail(kickCh, take) || [] : []
    if (!kickMsgs.length && curCh) {
      // Check if any config entry links current channel to a Kick channel
      const linked = config.channels.find((ch) => ch.twitch === curCh && ch.kick)
      if (linked) kickMsgs = kickChat?.getTail(linked.kick, take) || []
    }
    // On Kick, also pull messages from the URL channel (may differ from live override)
    if (!kickMsgs.length && hostPlatform === 'kick') {
      const urlCh = getCurrentChannel()
      if (urlCh && urlCh !== curCh) kickMsgs = kickChat?.getTail(urlCh, take) || []
    }
    // YouTube messages for live tab: auto-discovered or linked via config
    let ytMsgs = channelYtMessages.get('__live_yt_auto__') || []
    if (!ytMsgs.length && curCh) {
      const linkedYt = config.channels.find((ch) => (ch.twitch === curCh || ch.kick === curCh) && ch.youtube)
      if (linkedYt) ytMsgs = channelYtMessages.get(linkedYt.id) || []
    }
    return [ircMsgs, kickMsgs, ytMsgs]
  }
  // Channel tab — merge IRC + Kick + per-channel YouTube messages
  const ch = getChannelById(id)
  const ircMsgs = ch?.twitch ? irc?.getTail(ch.twitch, take) || [] : []
  const kickMsgs = ch?.kick ? kickChat?.getTail(ch.kick, take) || [] : []
  // YouTube ONLY from this channel's own explicit link. The global
  // __live_yt_auto__ bucket (the host page's auto-discovered YT, bound to
  // whatever stream is focused) must NOT merge into a per-channel tab — that
  // bleeds an unrelated stream's YT chat into this channel (e.g. a focused
  // jynxzi tab leaking into nl_kripp). __live_yt_auto__ is the live tab's
  // alone. Explicitly-linked channels already get their YT via
  // channelYtMessages[id]. See [[heatsync_yt_handle_guess_bleed]].
  return [ircMsgs, kickMsgs, channelYtMessages.get(id) || []]
}

// What fairMerge keys its choice on: which sources have rows (a bit each, in
// source order) and, with two or more, whether they are co-live. One small
// integer, so the per-message check allocates nothing.
function mtRegime(srcs) {
  let mask = 0
  const newest = []
  for (let i = 0; i < srcs.length; i++) {
    const s = srcs[i]
    if (!s.length) continue
    mask |= 1 << i
    newest.push(ordOf(s[s.length - 1]) || 0)
  }
  return mask * 2 + (newest.length > 1 && fairCoLive(newest) ? 1 : 0)
}

// The pane as the last real render left it: { tab, regime, at, n, timer }.
let mtState = null

// Every real render of a merged tab calls this with the sources it merged
// (null for any other tab), after the rows are in place.
function mtNoteRender(id, srcs) {
  if (mtState?.timer) cleanup.clearTimeout(mtState.timer)
  mtState = srcs ? { tab: id, regime: mtRegime(srcs), at: Date.now(), n: 0, timer: 0 } : null
}

// May this row be appended on its own, leaving the trim to the next render?
// All of: the last render was of this tab, and recent (MT_RECONCILE_MS) with
// room left (MT_OVERSHOOT); the row is a plain live chat line (carries an ord,
// so a render would also put it at the bottom; no `type`, so it is not a
// notice, event or receipt that changes what the render shows); and the
// sources are in the regime the render saw.
function mtAppendOk(state, tabId, msg, regime, now) {
  return (
    !!state &&
    state.tab === tabId &&
    !msg.type &&
    msg.ord != null &&
    state.n < MT_OVERSHOOT &&
    now - state.at <= MT_RECONCILE_MS &&
    regime === state.regime
  )
}

// The gate appendMessage asks. Two settings change what a render shows from
// one row to the next (duplicate suppression compares neighbours; a live
// search filters rows), and a scrollback window means the pane is deliberately
// longer than the cap — all three keep the render in charge.
function mtCanAppend(msg, tabId, hideDuplicates) {
  const s = mtState
  if (!s || s.tab !== tabId || hideDuplicates || _scrollbackWindow !== 0 || liveSearchQuery(tabId)) return false
  return mtAppendOk(s, tabId, msg, mtRegime(mergedTabSources(tabId, 1)), Date.now())
}

// A row was appended: make sure the real render follows, even if no more chat
// does. Sleeping while scrolled up is right: the pane is frozen then, and a
// render would count a phantom "new" message on the pill.
function mtNoteAppend() {
  const s = mtState
  if (!s) return
  s.n++
  if (!s.timer) {
    s.timer = cleanup.setTimeout(
      () => {
        s.timer = 0
        if (mtState === s && currentTab === s.tab && !isScrolledUp) renderMessages(s.tab)
      },
      Math.max(0, MT_RECONCILE_MS - (Date.now() - s.at)),
    )
  }
}

// One send to several platforms arrives once per platform: the twitch copy and
// the kick copy of the same line. The pane shows it once, by the site's rule:
// the same sender, the same words, on a platform that row does not stand for
// yet, within LEG_WINDOW_MS. Folding used to hang on the send being announced
// live (chat:origin_broadcast, then isSentEcho), so a pane opened after the
// send, or filled from history, never heard of it and showed every leg.
// A view-level fold: the buffers keep every leg, so a kick-only view still
// shows its own copy.
const LEG_WINDOW_MS = 5000
function legPlatform(m) {
  const p = m.badgePlatform || m.platform || 'twitch'
  return p === 'yt' ? 'youtube' : p
}
// Who a row stands for so far: the platforms its legs came from, the names
// they were sent under, and whether any of them is you.
function legGroup(legs, row) {
  let g = legs.get(row)
  if (!g) {
    g = {
      plats: new Set([legPlatform(row)]),
      names: new Set([String(row.user || '').toLowerCase()]),
      self: legIsSelf(row),
    }
    legs.set(row, g)
  }
  return g
}
function legIsSelf(m) {
  return typeof isSelf === 'function' && isSelf(m, legPlatform(m))
}
// the words as typed: kick's emote markup, twitch's duplicate-bypass mark and a
// reply's leading @name are what one platform adds and another doesn't
function legText(m) {
  let t = String(m.text || '')
  try {
    t = _unkickEmotes(stripDupBypass(t))
  } catch (_) {}
  if (m.replyTo?.user) t = t.replace(/^@\S+\s+/, '')
  return t.replace(/\s+/g, ' ').trim()
}
// true: same send id; false: both carry one and they differ; null: no verdict
function legSendVerdict(row, m) {
  if (typeof hsOriginStamp === 'function') {
    hsOriginStamp(row)
    hsOriginStamp(m)
  }
  if (!row.hsSendId || !m.hsSendId) return null
  return row.hsSendId === m.hsSendId
}
// Is `m` another platform's copy of `row`? One sender: a name one of its legs
// was sent under, or you under whatever name each platform knows you by.
// `legs` (row → legGroup) is the caller's, so a real repeat on a platform the
// row already stands for stays its own line.
function isSimulcastLeg(row, m, legs) {
  if (!row || row.type || m.type) return false
  // one send id = one send, at any distance; two different ids never fold. Only
  // rows with no id on one side fall back to the by-name rule below.
  const sid = legSendVerdict(row, m)
  if (sid != null) {
    if (!sid) return false
    const g = legGroup(legs, row)
    const p = legPlatform(m)
    if (g.plats.has(p)) return false
    g.plats.add(p)
    return true
  }
  if (!row.time || !m.time) return false
  if (Math.abs(m.time - row.time) > LEG_WINDOW_MS) return false
  if (legText(row) !== legText(m)) return false
  const g = legGroup(legs, row)
  const p = legPlatform(m)
  if (g.plats.has(p)) return false
  const name = String(m.user || '').toLowerCase()
  const self = legIsSelf(m)
  if (!(name && g.names.has(name)) && !(self && g.self)) return false
  g.plats.add(p)
  g.names.add(name)
  g.self ||= self
  return true
}
// A moderator removes ONE platform's copy, and the copy may be a leg that folded into
// another platform's row: that row is the line too, so it carries the removal.
function carryCleared(row, m) {
  if (!m.cleared || row.cleared) return
  row.cleared = true
  row.clearedReason = m.clearedReason
}
// msgs chronological (fairMerge's order); the earliest leg stands for the rest
function foldSimulcastLegs(msgs) {
  const out = []
  const legs = new Map()
  const bySend = new Map() // send id -> the row standing for it
  for (const m of msgs) {
    if (!m || m.type || typeof m.text !== 'string' || !m.time) {
      out.push(m)
      continue
    }
    let folded = false
    if (typeof hsOriginStamp === 'function') hsOriginStamp(m)
    const standing = m.hsSendId ? bySend.get(m.hsSendId) : null
    if (standing && isSimulcastLeg(standing, m, legs)) {
      carryCleared(standing, m)
      continue
    }
    for (let j = out.length - 1, n = 0; j >= 0 && n < 80; j--, n++) {
      const row = out[j]
      if (row?.time && m.time - row.time > LEG_WINDOW_MS) break
      if (isSimulcastLeg(row, m, legs)) {
        carryCleared(row, m)
        folded = true
        break
      }
    }
    if (!folded) {
      out.push(m)
      if (m.hsSendId) bySend.set(m.hsSendId, m)
    }
  }
  return out
}
// A removal reached a buffer but may have hit a leg folded into another platform's
// row, which has no row of its own to grey. When a send is on screen the render
// folds the legs again, the row carries the removal, and the row is greyed in place.
function refoldSimulcastRows(msgsEl) {
  for (const row of msgsEl?.children || []) {
    if (row._hsMsg?.hsSendId) {
      if (typeof scheduleMergedRender === 'function') scheduleMergedRender()
      return
    }
  }
}
// The append path's question: could `m` be a leg of a line already on screen?
// Then the render decides (it knows every leg each row stands for).
function mayBeSimulcastLeg(m, rowEls) {
  if (m.type || typeof m.text !== 'string' || !m.time) return false
  if (typeof hsOriginStamp === 'function') hsOriginStamp(m)
  if (m.hsSendId) {
    // any distance, same send id
    for (let i = rowEls.length - 1, n = 0; i >= 0 && n < 600; i--, n++) {
      const r = rowEls[i]?._hsMsg
      if (r && !r.type && isSimulcastLeg(r, m, new Map())) return true
    }
  }
  for (let i = rowEls.length - 1, n = 0; i >= 0 && n < 40; i--, n++) {
    const row = rowEls[i]?._hsMsg
    if (!row?.time) continue
    if (m.time - row.time > LEG_WINDOW_MS) break
    if (isSimulcastLeg(row, m, new Map())) return true
  }
  return false
}

export {
  foldSimulcastLegs,
  LEG_WINDOW_MS,
  MT_OVERSHOOT,
  MT_RECONCILE_MS,
  mayBeSimulcastLeg,
  mergedTabSources,
  mtAppendOk,
  mtRegime,
  refoldSimulcastRows,
}
