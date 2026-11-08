// background part 6 of 11 — yt send bridge, the onMessage gate.
// build.js concatenates src/background/* in BG_PARTS order into background.js (the service worker cannot import);
// one scope, so a later part may read an earlier part's constants, never the reverse.

// ========== YOUTUBE SEND BRIDGE ==========
//
// YouTube has no send API usable at scale (Data API ≈ 50 msgs/day per project),
// so a send drives a real, logged-in youtube.com tab. When the user has none
// open, we silently open a hidden, pinned live_chat tab for the EXACT stream —
// it inherits their YouTube login cookies, so send "just works" whenever they're
// signed into YouTube in Chrome. We only ever open a tab for a concrete videoId
// (never a guess) so we can never send to the wrong stream. Tabs are cached per
// videoId and reused; cleaned up when closed.
const ytBridgeTabs = new Map() // videoId → tabId
// Bridge tabs used to live forever (one pinned tab per videoId ever sent to,
// surviving stream end). Stamp use on ensure + relay; the sweep alarm removes
// idle ones. Map loss on SW restart is fine — the sweep then closes on sight.
const ytBridgeLastUsed = new Map() // videoId → ms timestamp
const YT_BRIDGE_IDLE_MS = 20 * 60 * 1000
async function sweepYtBridgeTabs() {
  const now = Date.now()
  for (const [vid, tid] of [...ytBridgeTabs]) {
    const last = ytBridgeLastUsed.get(vid) || 0
    if (now - last < YT_BRIDGE_IDLE_MS) continue
    ytBridgeTabs.delete(vid)
    ytBridgeLastUsed.delete(vid)
    await browser.tabs.remove(tid).catch(() => {})
  }
  // Orphans: #hs-bridge-marked tabs the map doesn't know (SW restarted since
  // creation). An actively-used one gets re-adopted into the map by the send
  // path's URL match before the next sweep; anything still untracked is dead.
  const tracked = new Set(ytBridgeTabs.values())
  const marked = await browser.tabs.query({ url: '*://www.youtube.com/live_chat*' }).catch(() => [])
  for (const t of marked) {
    if ((t.url || '').includes('#hs-bridge') && !tracked.has(t.id)) await browser.tabs.remove(t.id).catch(() => {})
  }
}

browser.tabs.onRemoved.addListener((tabId) => {
  for (const [vid, tid] of ytBridgeTabs) {
    if (tid === tabId) {
      ytBridgeTabs.delete(vid)
      ytBridgeLastUsed.delete(vid)
    }
  }
})

function pingYtBridge(tabId) {
  return browser.tabs.sendMessage(tabId, { type: 'youtube_bridge_ping' }).catch(() => null)
}

// Ensure a sendable live_chat tab exists for videoId; resolve when its chat
// input is present AND enabled. Returns { tabId } on ready, { tabId, error } when
// present-but-not-sendable (e.g. logged-out → 'chat_disabled'), or { error }.
// Inflight-deduped: concurrent sends for one videoId must share one creation —
// racing tabs.create calls each opened a pinned tab and orphaned the loser.
const _ytBridgeInflight = new Map() // videoId → Promise
function ensureYoutubeBridgeTab(videoId) {
  const inflight = _ytBridgeInflight.get(videoId)
  if (inflight) return inflight
  const p = _ensureYoutubeBridgeTab(videoId).finally(() => _ytBridgeInflight.delete(videoId))
  _ytBridgeInflight.set(videoId, p)
  return p
}
async function _ensureYoutubeBridgeTab(videoId) {
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId || '')) return { error: 'no_video' }
  let tabId = ytBridgeTabs.get(videoId)
  if (tabId != null) {
    const t = await browser.tabs.get(tabId).catch(() => null)
    if (!t) {
      ytBridgeTabs.delete(videoId)
      tabId = null
    }
  }
  if (tabId == null) {
    // #hs-bridge marks this tab as OURS: the multichat bundle sees the hash
    // and skips its entire boot. Without the marker the bridge booted a full
    // hidden popout overlay — it rebound the single __live_yt_auto__ slot to
    // the bridge's videoId (killing the watch tab's feed on WS reconnect) and
    // its overlay hid the native chat, so the "sign in here" tab we surface
    // on chat_disabled had no visible login UI.
    const created = await browser.tabs
      .create({ url: `https://www.youtube.com/live_chat?v=${videoId}#hs-bridge`, active: false, pinned: true })
      .catch(() => null)
    if (!created?.id) return { error: 'no_youtube_tab' }
    tabId = created.id
    ytBridgeTabs.set(videoId, tabId)
  }
  ytBridgeLastUsed.set(videoId, Date.now())
  // Poll for readiness — the YT SPA + auth-cookie load takes a couple seconds.
  const deadline = Date.now() + 12000
  let sawInput = false
  while (Date.now() < deadline) {
    const ping = await pingYtBridge(tabId)
    if (ping?.ok && ping.hasInput) {
      sawInput = true
      if (!ping.disabled) return { tabId }
      return { tabId, error: 'chat_disabled' } // present but logged-out / restricted
    }
    // No input + a restricted-participation banner = a terminal state
    // (subscribers-only / members-only), not "still loading" — fail fast with
    // the human reason instead of burning the full 12s into bridge_timeout.
    if (ping?.ok && !ping.hasInput && ping.restrictedMsg) {
      return { tabId, error: 'chat_restricted', reason: ping.restrictedMsg }
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  return { tabId, error: sawInput ? 'chat_disabled' : 'bridge_timeout' }
}

const YT_VIDEO_ID = /^[a-zA-Z0-9_-]{11}$/

// The one way a message reaches a youtube live chat frame: the overlay's
// composer, a send relayed from heatsync.org, and a mod action alike.
// Resolves the frame's answer ({ ok, error?, reason?, ... }); never throws.
//
// With a videoId, only ever drive a tab on THAT stream (a cached bridge tab →
// a matching open tab → an auto-opened bridge tab), so a send can't land in
// the wrong stream's chat. Without one, only the sender's own youtube tab —
// the old active-tab / any-tab fallbacks leaked messages into unrelated
// streams. Never guess a tab; fail loud instead.
async function driveYoutubeChat({ videoId, senderTabId, payload }) {
  try {
    const vidOk = YT_VIDEO_ID.test(videoId || '')
    let targetTabId = null
    if (vidOk) {
      const bridged = ytBridgeTabs.get(videoId)
      if (bridged != null && (await browser.tabs.get(bridged).catch(() => null))) {
        targetTabId = bridged
        ytBridgeLastUsed.set(videoId, Date.now())
      }
      if (!targetTabId) {
        const ytTabs = await browser.tabs.query({ url: '*://www.youtube.com/*' }).catch(() => [])
        const match = ytTabs.find((t) => (t.url || '').includes(videoId))
        if (match) {
          targetTabId = match.id
          // Re-adopt a bridge tab the map forgot (SW restart) — without
          // this the orphan sweep would close it mid-use.
          if ((match.url || '').includes('#hs-bridge')) {
            ytBridgeTabs.set(videoId, match.id)
            ytBridgeLastUsed.set(videoId, Date.now())
          }
        }
      }
    } else if (senderTabId != null) {
      const t = await browser.tabs.get(senderTabId).catch(() => null)
      if (t && /youtube\.com/.test(t.url || '')) targetTabId = senderTabId
    }
    if (!targetTabId && !vidOk) return { ok: false, error: 'no_youtube_tab' }

    if (targetTabId) {
      try {
        const result = await browser.tabs.sendMessage(targetTabId, payload)
        // youtube-content.js always answers. Nothing back means no chat frame
        // in that tab heard it: the overlay collapses native chat on a watch
        // tab, which unloads the live_chat iframe, and the page's other
        // scripts listen without answering — so it resolves empty, no error.
        if (result) return result
      } catch (e) {
        // Bridge only when it provably never reached a chat frame. A "message
        // port closed" means the frame got it and died mid-way — the post (or
        // the ban) may already be done, and re-driving a bridge would repeat it.
        if (!/Receiving end does not exist|Could not establish connection/i.test(e?.message || '')) {
          return { ok: false, error: e?.message || 'tab_send_failed' }
        }
      }
      if (!vidOk || targetTabId === ytBridgeTabs.get(videoId)) return { ok: false, error: 'no_chat_frame' }
    }
    const bridge = await ensureYoutubeBridgeTab(videoId)
    if (!bridge.tabId || bridge.error) {
      // Provisioned but not sendable (usually logged-out) — surface the tab
      // so the user can sign in, and report why.
      if (bridge.tabId && bridge.error === 'chat_disabled') {
        await browser.tabs.update(bridge.tabId, { active: true }).catch(() => {})
      }
      return { ok: false, error: bridge.error || 'no_youtube_tab', reason: bridge.reason }
    }
    return (await browser.tabs.sendMessage(bridge.tabId, payload)) || { ok: false, error: 'no_chat_frame' }
  } catch (e) {
    log('driveYoutubeChat error:', e?.message)
    return { ok: false, error: e?.message || 'send_failed' }
  }
}

// awaitConfirm makes youtube-content.js wait to see the line land, so a
// rate-limit / slow-mode / disabled button is reported, not called sent.
function sendYoutubeChat({ videoId, text, senderTabId }) {
  return driveYoutubeChat({ videoId, senderTabId, payload: { type: 'youtube_send_relay', text, awaitConfirm: true } })
}

// ========== COSMETICS ==========

// Handle messages from content scripts
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const senderUrl = sender?.tab?.url || sender?.url || ''
  const isFromPopup = !sender?.tab // popup/options pages have no tab
  // Reject messages from other extensions — must originate from this extension's
  // content scripts (sender.id matches) or our own popup/options (no tab).
  const isOwnExtension = sender?.id === browser.runtime.id
  const isValidOrigin =
    isFromPopup || /^https:\/\/([a-z0-9-]+\.)*(twitch\.tv|kick\.com|heatsync\.org|youtube\.com)(\/|$)/.test(senderUrl)
  const isValidSender = isOwnExtension && isValidOrigin

  if (!isValidSender) {
    sendResponse({ ok: false, error: 'unauthorized sender' })
    return true
  }

  // A surface the user opened, buffered for the next health check-in. Named
  // surfaces only, no ids and no timing — see noteSurfaceOpen.
  if (message.type === 'hs_surface_open') {
    noteSurfaceOpen(String(message.surface || ''))
    try {
      sendResponse({ ok: true })
    } catch {}
    return true
  }

  // Health check ping from content scripts
  if (message.type === 'extension_reload') {
    // Dev hook so an automation/page can reload the extension without manual
    // chrome://extensions clicking. Fired by content.js on receipt of
    // window.postMessage({type:'heatsync-reload-extension'}).
    log(' 🔁 extension_reload requested via page message')
    try {
      sendResponse({ ok: true })
    } catch {}
    setTimeout(() => {
      try {
        chrome.runtime.reload()
      } catch (e) {
        console.error('[heatsync] reload failed:', e)
      }
    }, 50)
    return true
  }
  if (message.type === 'blocked_terms') {
    // A twitch channel's blocked terms (blocked-terms-panel in multichat).
    // op: list | add | remove. The server's helix call is the moderator check,
    // so a 403 here means "not a mod of this channel", not a bad session.
    ;(async () => {
      try {
        const broadcasterId = String(message.broadcasterId || '').replace(/[^0-9]/g, '')
        const op = message.op === 'add' || message.op === 'remove' ? message.op : message.op === 'list' ? 'list' : ''
        if (!broadcasterId || !op) {
          sendResponse({ ok: false, error: 'missing params' })
          return
        }
        const authToken = await getAuthCookie()
        if (!authToken) {
          sendResponse({ ok: false, error: 'auth_required' })
          return
        }
        const url = `${API_URL}/api/mod/blocked-terms`
        const headers = { Authorization: `Bearer ${authToken}` }
        let res
        if (op === 'list') {
          res = await fetchWithTimeout(`${url}?broadcaster_id=${broadcasterId}`, { credentials: 'omit', headers })
        } else {
          const body =
            op === 'add'
              ? { broadcaster_id: broadcasterId, text: String(message.text || '').trim() }
              : { broadcaster_id: broadcasterId, id: String(message.id || '') }
          res = await fetchWithTimeout(url, {
            method: op === 'add' ? 'POST' : 'DELETE',
            credentials: 'omit',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
        }
        const data = await res.json().catch(() => null)
        if (res.ok) {
          sendResponse(
            op === 'list'
              ? { ok: true, terms: Array.isArray(data?.terms) ? data.terms : [] }
              : { ok: true, term: data?.term || null },
          )
        } else if (res.status === 401) {
          // relink_required (a flag, not an error string, on this route) = the
          // twitch grant lacks the blockedterms scopes; a bare 401 is OUR
          // expired session, which relinking twitch cannot fix.
          sendResponse({
            ok: false,
            error:
              data?.error === 'relink_required' || data?.relink_required === true ? 'relink_required' : 'auth_required',
          })
        } else if (res.status === 403) {
          sendResponse({ ok: false, error: 'not_moderator' })
        } else if (res.status === 404) {
          sendResponse({ ok: false, error: 'gone' })
        } else if (res.status === 429) {
          sendResponse({ ok: false, error: 'rate_limited' })
        } else {
          sendResponse({ ok: false, error: data?.error || `http ${res.status}` })
        }
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || 'network error' })
      }
    })()
    return true
  }
  if (message.type === 'pin') {
    // The pinned message of a twitch/kick room (pin-bar in multichat).
    // op: get (public) | set | clear (mod). The server resolves the pinned line
    // from its own archive, so set carries only the message id. Same bearer +
    // error vocabulary as blocked_terms; 409 = the line is not archived yet.
    ;(async () => {
      try {
        const platform = message.platform === 'kick' ? 'kick' : message.platform === 'twitch' ? 'twitch' : ''
        const channel = String(message.channel || '')
          .toLowerCase()
          .replace(/[^a-z0-9_-]/g, '')
        const op = message.op === 'set' || message.op === 'clear' ? message.op : message.op === 'get' ? 'get' : ''
        const messageId = String(message.messageId || '').slice(0, 100)
        if (!platform || !channel || !op || (op === 'set' && !messageId)) {
          sendResponse({ ok: false, error: 'missing params' })
          return
        }
        let res
        if (op === 'get') {
          res = await fetchWithTimeout(
            `${API_URL}/api/pin?platform=${platform}&channel=${encodeURIComponent(channel)}`,
            { credentials: 'omit' },
          )
        } else {
          const authToken = await getAuthCookie()
          if (!authToken) {
            sendResponse({ ok: false, error: 'auth_required' })
            return
          }
          res = await fetchWithTimeout(`${API_URL}/api/mod/pin`, {
            method: op === 'set' ? 'POST' : 'DELETE',
            credentials: 'omit',
            headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(op === 'set' ? { platform, channel, message_id: messageId } : { platform, channel }),
          })
        }
        const data = await res.json().catch(() => null)
        if (res.ok) {
          sendResponse({ ok: true, pin: data?.pin && typeof data.pin === 'object' ? data.pin : null })
        } else if (res.status === 401) {
          sendResponse({
            ok: false,
            error:
              data?.error === 'relink_required' || data?.relink_required === true ? 'relink_required' : 'auth_required',
          })
        } else if (res.status === 403) {
          sendResponse({ ok: false, error: 'not_moderator' })
        } else if (res.status === 409) {
          sendResponse({ ok: false, error: 'not_archived' })
        } else if (res.status === 429) {
          sendResponse({ ok: false, error: 'rate_limited' })
        } else {
          sendResponse({ ok: false, error: data?.error || `http ${res.status}` })
        }
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || 'network error' })
      }
    })()
    return true
  }
  if (message.type === 'chat_settings') {
    // A twitch channel's chat modes (modes cell + /slow /followers /emoteonly …).
    // op: get | set. Same bearer + error vocabulary as blocked_terms; the
    // server's helix call is the moderator check, so a 403 means "not a mod".
    ;(async () => {
      try {
        const channel = String(message.channel || '')
          .toLowerCase()
          .replace(/[^a-z0-9_]/g, '')
        const op = message.op === 'set' ? 'set' : message.op === 'get' ? 'get' : ''
        if (!channel || !op) {
          sendResponse({ ok: false, error: 'missing params' })
          return
        }
        const authToken = await getAuthCookie()
        if (!authToken) {
          sendResponse({ ok: false, error: 'auth_required' })
          return
        }
        const url = `${API_URL}/api/mod/chat-settings`
        const headers = { Authorization: `Bearer ${authToken}` }
        let res
        if (op === 'get') {
          res = await fetchWithTimeout(`${url}?channel=${encodeURIComponent(channel)}`, {
            credentials: 'omit',
            headers,
          })
        } else {
          // only the helix fields the site accepts — nothing else rides along
          const settings = {}
          for (const k of ['emote_mode', 'subscriber_mode', 'unique_chat_mode', 'slow_mode', 'follower_mode']) {
            if (typeof message.settings?.[k] === 'boolean') settings[k] = message.settings[k]
          }
          for (const k of ['slow_mode_wait_time', 'follower_mode_duration']) {
            if (Number.isFinite(message.settings?.[k])) settings[k] = Math.trunc(message.settings[k])
          }
          res = await fetchWithTimeout(url, {
            method: 'POST',
            credentials: 'omit',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ platform: 'twitch', channel, settings }),
          })
        }
        const data = await res.json().catch(() => null)
        if (res.ok) {
          // GET answers with the settings object itself; POST answers {success:true}
          sendResponse({ ok: true, settings: op === 'get' && data && typeof data === 'object' ? data : null })
        } else if (res.status === 401) {
          sendResponse({
            ok: false,
            error:
              data?.error === 'relink_required' || data?.relink_required === true ? 'relink_required' : 'auth_required',
          })
        } else if (res.status === 403) {
          sendResponse({ ok: false, error: 'not_moderator' })
        } else if (res.status === 429) {
          sendResponse({ ok: false, error: 'rate_limited' })
        } else {
          sendResponse({ ok: false, error: data?.error || `http ${res.status}` })
        }
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || 'network error' })
      }
    })()
    return true
  }
  if (message.type === 'mod_suite') {
    // A twitch channel's mod suite (mod-suite.js in multichat): shield, warn,
    // unban requests, automod settings, shoutout, chatters. One handler, one op
    // per server route; the server's helix call is the moderator check.
    // Failures carry a code (relink_required / auth_required / not_moderator /
    // rate_limited / gone / error) and `message`: the server's own words.
    ;(async () => {
      try {
        const clean = (v) =>
          String(v || '')
            .toLowerCase()
            .replace(/[^a-z0-9_]/g, '')
        const channel = clean(message.channel)
        const op = String(message.op || '')
        const lvl = (n) => (Number.isInteger(n) && n >= 0 && n <= 4 ? n : null)
        const AM = [
          'overall_level',
          'disability',
          'aggression',
          'sexuality_sex_or_gender',
          'misogyny',
          'bullying',
          'swearing',
          'race_ethnicity_or_religion',
          'sex_based_terms',
        ]
        const base = `${API_URL}/api/mod`
        const q = (path, extra = {}) => `${base}/${path}?${new URLSearchParams({ channel, ...extra })}`
        let req = null // [method, url, body?]
        if (op === 'shield_get') req = ['GET', q('shield')]
        else if (op === 'shield_set' && typeof message.active === 'boolean')
          req = ['POST', `${base}/shield`, { channel, is_active: message.active }]
        else if (op === 'warn' && clean(message.user) && String(message.reason || '').trim())
          req = [
            'POST',
            `${base}/warn`,
            { channel, user: clean(message.user), reason: String(message.reason).trim().slice(0, 500) },
          ]
        else if (op === 'shoutout' && clean(message.user))
          req = ['POST', `${base}/shoutout`, { channel, to_user: clean(message.user) }]
        else if (op === 'unban_list') {
          const status = ['pending', 'approved', 'denied'].includes(message.status) ? message.status : 'pending'
          req = ['GET', q('unban-requests', { status })]
        } else if (op === 'unban_resolve' && message.id && ['approved', 'denied'].includes(message.status)) {
          const body = { channel, id: String(message.id), status: message.status }
          const text = String(message.text || '')
            .trim()
            .slice(0, 500)
          if (text) body.resolution_text = text
          req = ['POST', `${base}/unban-requests/resolve`, body]
        } else if (op === 'automod_get') req = ['GET', q('automod-settings')]
        else if (op === 'automod_set' && AM.includes(message.key) && lvl(message.level) !== null)
          req = ['PUT', `${base}/automod-settings`, { channel, [message.key]: message.level }]
        else if (op === 'chatters') req = ['GET', q('chatters')]
        if (!channel || !req) {
          sendResponse({ ok: false, error: 'missing params' })
          return
        }
        const authToken = await getAuthCookie()
        if (!authToken) {
          sendResponse({ ok: false, error: 'auth_required' })
          return
        }
        const headers = { Authorization: `Bearer ${authToken}` }
        const init = { credentials: 'omit', headers }
        if (req[0] !== 'GET') {
          init.method = req[0]
          init.headers = { ...headers, 'Content-Type': 'application/json' }
          init.body = JSON.stringify(req[2])
        }
        const res = await fetchWithTimeout(req[1], init)
        const data = await res.json().catch(() => null)
        if (res.ok) {
          sendResponse({ ok: true, data: data && typeof data === 'object' ? data : {} })
          return
        }
        const words = typeof data?.error === 'string' ? data.error : ''
        // a 401 flagged relink_required = the twitch grant lacks the modsuite
        // pack; a bare 401 is OUR expired session, which relinking cannot fix
        const error =
          res.status === 401
            ? data?.relink_required === true || data?.error === 'relink_required'
              ? 'relink_required'
              : 'auth_required'
            : res.status === 403
              ? 'not_moderator'
              : res.status === 404
                ? 'gone'
                : res.status === 429
                  ? 'rate_limited'
                  : 'error'
        sendResponse({ ok: false, error, message: error === 'relink_required' ? '' : words, status: res.status })
      } catch (e) {
        sendResponse({ ok: false, error: 'error', message: e?.message || 'network error' })
      }
    })()
    return true
  }
  if (message.type === 'resolve_twitch_id') {
    // login → numeric twitch id for content scripts. They must not fetch
    // heatsync.org themselves — CF edge bot-checks 503 cross-origin
    // content-script requests (the origin never sees them); SW fetches pass.
    ;(async () => {
      const login = String(message.login || '')
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '')
      try {
        sendResponse({ id: login ? await lookupTwitchUserId(login) : null })
      } catch {
        sendResponse({ id: null })
      }
    })()
    return true
  }
  if (message.type === 'automod_watch') {
    // Register/keepalive the server-side AutoMod-hold watch for a channel this
    // user moderates (automod-queue.js sweeps its joined+modded channels on an
    // interval and calls this per channel). Throttled — see AUTOMOD_WATCH_THROTTLE_MS.
    ;(async () => {
      try {
        const broadcasterId = String(message.broadcasterId || '').replace(/[^0-9]/g, '')
        if (!broadcasterId) {
          sendResponse({ ok: false, error: 'missing broadcasterId' })
          return
        }
        const now = Date.now()
        const last = _automodWatchThrottle.get(broadcasterId) || 0
        // wantPending = a page that has just opened its queue and has nothing
        // in it. The throttle is there to keep the keepalive cheap, and it
        // does its job for the sweep — but a reload inside the window would
        // otherwise be handed no backfill at all, which is the exact case the
        // backfill exists for. One extra call per channel per page load.
        if (!message.wantPending && now - last < AUTOMOD_WATCH_THROTTLE_MS) {
          sendResponse({ ok: true, throttled: true })
          return
        }
        const authToken = await getAuthCookie()
        if (!authToken) {
          sendResponse({ ok: false, error: 'not logged in' })
          return
        }
        _automodWatchThrottle.set(broadcasterId, now)
        if (_automodWatchThrottle.size > 500) _automodWatchThrottle.delete(_automodWatchThrottle.keys().next().value)
        const res = await fetchWithTimeout(`${API_URL}/api/mod/automod-watch`, {
          method: 'POST',
          credentials: 'omit', // Bearer-only → CSRF-exempt (matches every other heatsync.org mutation)
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
          body: JSON.stringify({ broadcaster_id: broadcasterId }),
        })
        if (res.ok) {
          // The watch response carries whatever is STILL held on this channel.
          // Before this, a hold existed only in the websocket frame that
          // announced it: reload the page and the queue was empty while twitch
          // was still holding the messages. Normalized through the same
          // function as the live push so the two can't drift.
          const data = await res.json().catch(() => null)
          const pending = Array.isArray(data?.pending)
            ? data.pending
                .slice(0, 100)
                .map(normalizeAutomodHold)
                .filter((h) => h.msgId && h.broadcasterLogin)
            : []
          sendResponse({ ok: true, pending })
          return
        }
        if (res.status === 401) {
          // Two very different 401s arrive here and only one is about twitch.
          // `relink_required` means the twitch grant is missing the automod
          // scope. A BARE 401 is authRequired rejecting OUR bearer token — an
          // expired heatsync session. Reporting both as 'relink_required' sent
          // people to relink twitch over and over for a problem relinking
          // twitch cannot fix; the toast was already gated correctly, this
          // response was not.
          const data = await res.json().catch(() => null)
          if (data?.error === 'relink_required') {
            notifyAutomodRelinkOnce()
            sendResponse({ ok: false, error: 'relink_required' })
          } else {
            sendResponse({ ok: false, error: 'auth_required' })
          }
          return
        }
        log(' automod_watch failed:', res.status)
        sendResponse({ ok: false, error: 'subscribe_failed' })
      } catch (e) {
        log(' automod_watch error:', e?.message)
        sendResponse({ ok: false, error: e?.message || 'network error' })
      }
    })()
    return true
  }
  if (message.type === 'automod_action') {
    // Resolve a held message — allow/deny. automod-queue.js shows the
    // optimistic 'resolving…' state; the confirming automod:update broadcast
    // (any mod, any tab) is what actually flips the row to allowed/denied.
    ;(async () => {
      try {
        const msgId = String(message.msgId || '')
        const action = message.action === 'deny' ? 'deny' : message.action === 'allow' ? 'allow' : ''
        if (!msgId || !action) {
          sendResponse({ ok: false, error: 'missing params' })
          return
        }
        const authToken = await getAuthCookie()
        if (!authToken) {
          // No heatsync session — OUR cookie, not the twitch grant. Answering
          // 'relink_required' here put "automod queue needs a twitch relink"
          // in front of someone whose twitch link was perfectly fine, and no
          // amount of relinking could clear it. Same split the 401 branches
          // below already make.
          sendResponse({ ok: false, error: 'auth_required' })
          return
        }
        const res = await fetchWithTimeout(`${API_URL}/api/mod/automod-action`, {
          method: 'POST',
          credentials: 'omit',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
          body: JSON.stringify({ msg_id: msgId, action }),
        })
        if (res.ok) {
          sendResponse({ ok: true })
          return
        }
        if (res.status === 404 || res.status === 400) {
          // 400 too: msgId+action are validated before the request goes out,
          // so a 400 back is twitch rejecting the msg_id — a hold that was
          // already actioned (by this mod pre-refresh, another mod, or
          // expiry). Reporting it as a generic failure produced a red
          // "action failed" on a message that was in fact already handled.
          sendResponse({ ok: false, error: 'gone' })
        } else if (res.status === 401) {
          // Same split as automod_watch: only a server-declared
          // `relink_required` is about the twitch grant. A bare 401 is our own
          // expired session.
          const data = await res.json().catch(() => null)
          if (data?.error === 'relink_required') {
            notifyAutomodRelinkOnce()
            sendResponse({ ok: false, error: 'relink_required' })
          } else {
            sendResponse({ ok: false, error: 'auth_required' })
          }
        } else if (res.status === 403) {
          sendResponse({ ok: false, error: 'not_moderator' })
        } else {
          const data = await res.json().catch(() => null)
          sendResponse({ ok: false, error: data?.error || `http ${res.status}` })
        }
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || 'network error' })
      }
    })()
    return true
  }
  if (message.type === 'ping') {
    sendResponse({ ok: true })
    return true
  }
  if (message.type === 'yt_resolve_live_video') {
    // Resolve a channel-shaped youtube URL (/channel/UC…/live, /@handle/live)
    // to its CURRENT live videoId from THIS browser. YouTube serves
    // datacenter IPs a stale non-live page (observed 2026-08-23: prod fetched
    // …/live and got an old video with no isLiveNow), so the server's own
    // resolver dead-ends — a residential fetch is the only reliable answer.
    // Canonical link first (authoritative), bare videoId regex as fallback;
    // isLive gates on the live-now marker so an offline channel's latest VOD
    // never gets subscribed as if it were chat.
    ;(async () => {
      try {
        const url = String(message.url || '')
        if (!/^https:\/\/(www\.)?youtube\.com\//i.test(url)) {
          sendResponse({ ok: false })
          return
        }
        const cached = _ytLiveResolveCache.get(url)
        if (cached && Date.now() - cached.ts < YT_LIVE_RESOLVE_TTL) {
          sendResponse(cached.v)
          return
        }
        const resp = await fetchWithTimeout(url, { credentials: 'omit' }, 10000)
        if (!resp.ok) {
          sendResponse({ ok: false })
          return
        }
        const html = await resp.text()
        const isLive = html.includes('"isLiveNow":true')
        const canon = html.match(
          /<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})"/,
        )
        const bare = html.match(/"videoId":"([A-Za-z0-9_-]{11})"/)
        const videoId = isLive ? canon?.[1] || bare?.[1] || null : null
        const v = { ok: true, isLive, videoId }
        _ytLiveResolveCache.set(url, { v, ts: Date.now() })
        if (_ytLiveResolveCache.size > 50) _ytLiveResolveCache.delete(_ytLiveResolveCache.keys().next().value)
        sendResponse(v)
      } catch (_) {
        sendResponse({ ok: false })
      }
    })()
    return true
  }
  if (message.type === 'dbg_kick_tap') {
    // Read-only tap/relay state snapshot — reachable only from our own content
    // scripts (sender gate above); nothing secret, just routing liveness.
    try {
      sendResponse({
        enabled: KICK_PUSHER_TAP,
        wsState: _kpWs ? _kpWs.readyState : null,
        connected: _kpConnected,
        lastDataAgeMs: _kpLastData ? Date.now() - _kpLastData : null,
        channels: [..._kpChannels.entries()],
        chatroomCache: [..._kpChatroomCache.entries()],
        tap: [..._kickSrcStats.tap.entries()],
        relay: [..._kickSrcStats.relay.entries()],
        tapUnmatched: _kickSrcStats.tapUnmatched,
        // Mode-banner chain liveness — a swallowed ChatroomUpdatedEvent is
        // otherwise invisible (the exact silent failure that cost this session
        // a debug loop). events/broadcasts counters + last error surface it.
        modes: {
          slugs: [..._kpModes.keys()],
          events: _kpModeStats.events,
          broadcasts: _kpModeStats.broadcasts,
          baselines: _kpModeStats.baselines,
          lastError: _kpModeStats.lastError,
        },
        // Celebration events off the tap. `dropped` non-zero means kick is
        // shipping a payload shape we don't parse — the one failure mode that
        // would otherwise look identical to "nobody subscribed".
        events: { ..._kpEventStats },
      })
    } catch (e) {
      sendResponse({ error: e?.message || 'unknown' })
    }
    return true
  }

  // videoId → @handle, for naming a tab that was added by pasting a watch URL.
  // Thin wrapper over the same cached oEmbed lookup the subscribe path uses.
  if (message.type === 'yt_channel_handle') {
    const vid = String(message.videoId || '')
    if (!/^[\w-]{11}$/.test(vid)) {
      sendResponse({ handle: null })
      return true
    }
    getYtChannelHandle(vid)
      .then((handle) => sendResponse({ handle: handle || null }))
      .catch(() => sendResponse({ handle: null }))
    return true
  }

  // Chatroom id for a kick slug — used by the page-side fallback pusher
  // connection (kick-native-tap.js) so it can subscribe chatrooms.<id>.v2
  // without its own kick API round-trip when BG already knows the answer.
  if (message.type === 'kick_chatroom_id') {
    const slug = (message.slug || '').toLowerCase()
    sendResponse({ id: _kpChannels.get(slug) ?? _kpChatroomCache.get(slug) ?? null })
    return true
  }

  // Serialized ui_settings patch. Content scripts must NOT get→merge→set the
  // key themselves — they race this SW's uiSettingsRmw chain (and each other),
  // and the loser's write is silently overwritten. Keys are governed by the
  // settings registry via sanitizeUiSettings, so only the shape is checked here.
  if (message.type === 'ui_settings_rmw') {
    const patch = message.patch
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      sendResponse({ ok: false, error: 'patch must be a plain object' })
      return true
    }
    // dropRetired: the overlay has migrated this device's retired keys — clear them from the blob
    uiSettingsRmw((ui) => {
      const next = { ...ui, ...patch }
      if (message.dropRetired === true) for (const k of RETIRED_UI_KEYS) delete next[k]
      return sanitizeUiSettings(next)
    })
      .then((r) => sendResponse(r?.ok ? { ok: true } : { ok: false, error: r?.error || 'write failed' }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }))
    return true
  }

  // A per-site overlay switch. Stored through the same serialized rmw, then
  // sent as the same ui-state:sync patch the settings page's writes ride — a
  // storage-only write was reverted at the next boot, when the server's
  // ui_state (which never heard of it) won the merge.
  if (message.type === 'site_overlay_set') {
    let subsystems = null
    uiSettingsRmw((ui) => {
      const next = siteOverlayMerge(ui, message.gate, message.on)
      if (!next) throw new Error('unknown gate')
      subsystems = next.subsystems
      return sanitizeUiSettings(next)
    }).then((r) => {
      if (r?.ok) wsSend({ type: 'ui-state:sync', patch: { subsystems } })
      sendResponse(r?.ok ? { ok: true } : { ok: false, error: r?.error || 'write failed' })
    })
    return true
  }

  // Content-script error appends. Same rationale as ui_settings_rmw: the SW
  // owns the serialized hs_errors get→concat→set chain, so unserialized
  // content-script writes would drop whole batches.
  if (message.type === 'report_error') {
    try {
      const rep = globalThis.__hsErrorReporterSw
      const errs = Array.isArray(message.errors) ? message.errors.slice(0, 50) : []
      const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '')
      for (const r of errs) {
        if (!r || typeof r !== 'object' || Array.isArray(r)) continue
        rep?.capture({
          ts: typeof r.ts === 'number' ? r.ts : Date.now(),
          type: str(r.type, 20) || 'error',
          plat: str(r.plat, 20) || 'other',
          ver: str(r.ver, 20) || 'unknown',
          url: str(r.url, 200),
          msg: str(r.msg, 500),
          stack: str(r.stack, 2000),
          file: str(r.file, 200),
          line: typeof r.line === 'number' ? r.line : 0,
        })
      }
    } catch (_) {}
    sendResponse({ ok: true })
    return true
  }

  // Cached server health (kill-switch + version-floor). Fail-open default if
  // we've never successfully fetched. Synchronous content-script callers use
  // this to early-bail before painting any UI.
  if (message.type === 'get_health') {
    getCachedHealth()
      .then((h) => sendResponse({ ok: true, health: h }))
      .catch(() => sendResponse({ ok: true, health: HEALTH_DEFAULT }))
    return true
  }

  // Diag snapshot for bug reports — bundled with errors on copy.
  if (message.type === 'get_diag') {
    buildDiagSnapshot()
      .then((d) => sendResponse({ ok: true, diag: d }))
      .catch(() => sendResponse({ ok: false, diag: null }))
    return true
  }
  // Ensure in-memory state is populated before any handler reads it (MV3 SW restart race)
  ;(async () => {
    if (initPromise) await initPromise
    handleMessage(message, sender, sendResponse)
  })().catch((err) => {
    console.error('[heatsync-ext] onMessage dispatch error:', err)
    try {
      sendResponse({ ok: false, error: String(err?.message || err) })
    } catch {}
  })
  return true
})
