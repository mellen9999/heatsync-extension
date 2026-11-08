// background part 3 of 11 — identity resolvers, cosmetics and badges.
// build.js concatenates src/background/* in BG_PARTS order into background.js (the service worker cannot import);
// one scope, so a later part may read an earlier part's constants, never the reverse.

// Fetch user profile info for popup display
async function fetchUserInfo(retried = false) {
  try {
    const authToken = await getAuthCookie()
    if (!authToken) {
      browser.storage.local.remove('user_info')
      return
    }

    const response = await fetchWithTimeout(`${API_URL}/api/auth/me`, {
      credentials: 'include',
      headers: { Authorization: `Bearer ${authToken}` },
    })

    if (!response.ok) {
      response.body?.cancel()
      // Only an explicit auth rejection means "logged out" — wipe. A 5xx/429/
      // gateway blip is transient: keep stale user_info so mention aliases +
      // display identity survive instead of silently dying until next refetch.
      // Drop the TOKEN too, not just the identity. Clearing user_info alone
      // left the worst possible state: token present so every signed-out
      // affordance stays hidden (they all test the token), identity absent so
      // nothing matches you — signed out in fact, signed in on screen, silent
      // either way. Removing both makes the existing logged-out UI correct
      // again and lets the next cookie read re-authenticate cleanly.
      if (response.status === 401 || response.status === 403) {
        // a retired copy, not a logout — see tokenAfterRejection
        if (!retried && (await tokenAfterRejection(authToken))) return fetchUserInfo(true)
        await browser.storage.local.remove(['user_info', 'auth_token_encrypted', 'auth_token'])
        try {
          broadcastToTabs({ type: 'auth_changed', loggedIn: false, reason: 'session_expired' })
        } catch (_) {}
      }
      return
    }

    const bodyText = await response.text()
    if (!bodyText) return // empty 200 = server anomaly — keep stale identity
    let user
    try {
      user = JSON.parse(bodyText)
    } catch {
      return // unparseable = transient — keep stale identity
    }
    if (!user) {
      browser.storage.local.remove('user_info')
      return
    }

    const userInfo = {
      // Identity ids — the paint/colour/tenure lookups are keyed by them
      // (primeSelfHsCosmetics).
      id: user.id != null ? String(user.id) : '',
      twitch_id: user.twitch_id != null ? String(user.twitch_id) : '',
      kick_id: user.kick_id != null ? String(user.kick_id) : '',
      display_name: user.display_name || user.twitch_username || user.kick_username || '',
      username: user.username || user.twitch_username || '',
      twitch_username: user.twitch_username || '',
      kick_username: user.kick_username || '',
      youtube_username: user.youtube_username || '',
      youtube_channel_id: user.youtube_channel_id || '',
      avatar_url: user.twitch_profile_pic || user.kick_profile_pic || user.profile_image_url || '',
      heat: user.heat || 0,
      color: user.color || '',
      // Every batch key this HS account resolves as (server-computed). The
      // panel compares the identity it's chatting under against this list —
      // a miss means "your emotes can't render for anyone else here".
      sender_keys: Array.isArray(user.sender_keys)
        ? user.sender_keys.filter((k) => typeof k === 'string').slice(0, 10)
        : null,
      youtube_verified: !!user.youtube_verified,
    }
    currentUsername = userInfo.username
    // Persist HERE, not via a global the init batch happens to flush later.
    // This used to only set `pendingUserInfoToPersist`, which reached disk in
    // exactly one place: initialize()'s Promise.all tail. So logging in stored
    // your TOKEN but never your IDENTITY — the cookie-change login path and the
    // popup's refresh both fetched it and dropped it when the service worker
    // died. Overlay symptoms: no red mentions, no "replied to you", no mention
    // pings — while every signed-out affordance stayed hidden because those all
    // key off the token, which WAS present. Nothing on screen said anything.
    await browser.storage.local.set({ user_info: userInfo })
    log(' User info loaded:', userInfo.display_name)
  } catch (error) {
    console.error('[heatsync] fetchUserInfo failed:', error.message || error)
  }
}

// v1.6 — load the viewer's content filter settings. Falls back to stored
// value if the network call fails, then to defaults. Flags flow into every
// emote-fetch via withNsfwParam() below.
async function fetchViewerSettings() {
  try {
    const authToken = await getAuthCookie()
    if (!authToken) {
      viewerShowSexual = false
      viewerShowGore = false
      browser.storage.local.set({ viewer_show_sexual: false, viewer_show_gore: false, hs_age_blocked: false })
      return
    }
    const resp = await fetchWithTimeout(`${API_URL}/api/user/settings`, {
      credentials: 'include',
      headers: { Authorization: `Bearer ${authToken}` },
    })
    if (!resp.ok) {
      resp.body?.cancel()
      return
    }
    const data = await resp.json().catch(() => null)
    if (data && typeof data.show_sexual_emotes === 'boolean') {
      viewerShowSexual = data.show_sexual_emotes
      browser.storage.local.set({ viewer_show_sexual: viewerShowSexual })
    }
    if (data && typeof data.age_blocked === 'boolean') {
      browser.storage.local.set({ hs_age_blocked: data.age_blocked })
    }
    if (data && typeof data.show_gore_emotes === 'boolean') {
      viewerShowGore = data.show_gore_emotes
      browser.storage.local.set({ viewer_show_gore: viewerShowGore })
    }
    if (data && typeof data.show_weapon_emotes === 'boolean') {
      viewerShowWeapon = data.show_weapon_emotes
      browser.storage.local.set({ viewer_show_weapon: viewerShowWeapon })
    }
    if (data && typeof data.show_drug_emotes === 'boolean') {
      viewerShowDrug = data.show_drug_emotes
      browser.storage.local.set({ viewer_show_drug: viewerShowDrug })
    }
    if (data && typeof data.show_hate_emotes === 'boolean') {
      viewerShowHate = data.show_hate_emotes
      browser.storage.local.set({ viewer_show_hate: viewerShowHate })
    }
  } catch (error) {
    log(' fetchViewerSettings failed:', error?.message)
  }
}

// Append content-filter params to an emote-fetch URL. URL may already have a query.
// Covers include_sexual + include_gore (default hide) + include_weapons/drugs/hate (default show).
function withNsfwParam(url) {
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}include_sexual=${viewerShowSexual ? 'true' : 'false'}&include_gore=${viewerShowGore ? 'true' : 'false'}&include_weapons=${viewerShowWeapon ? 'true' : 'false'}&include_drugs=${viewerShowDrug ? 'true' : 'false'}&include_hate=${viewerShowHate ? 'true' : 'false'}`
}

// Validate emote objects from third-party APIs to bound string sizes and URL patterns
// Allowlist of CDN hosts emote URLs can come from. cdn.heatsync.org is
// added explicitly — server-side toAbsoluteEmoteUrl rewrites /uploads/*
// to cdn.heatsync.org (CDN-cached subdomain), so leaving it off the
// allowlist silently dropped every self-hosted emote (including v1.6
// flagged emotes the user uploaded) from the ext inventory.
const EMOTE_CDN_PATTERN =
  /^https:\/\/(cdn\.(betterttv\.net|7tv\.app|frankerfacez\.com|heatsync\.org)|static-cdn\.jtvnw\.net|heatsync\.org|files\.kick\.com)\//
const MAX_EMOTE_NAME_LEN = 100
const MAX_EMOTES_PER_SOURCE = 5000
// BTTV declares per-emote 1x width/height; most are 28px tall but some globals
// (NaM = 38×40) are intentionally oversized and native BTTV renders them at
// that height. Carry the height→baseline ratio so render can raise its clamp.
// Clamped to 2× as a sanity bound against rogue API values.
function bttvOversize(e) {
  const h = Number(e?.height)
  return h > 28 ? Math.min(2, +(h / 28).toFixed(3)) : undefined
}
function sanitizeEmote(e) {
  if (!e || typeof e.name !== 'string' || typeof e.url !== 'string') return null
  if (e.name.length > MAX_EMOTE_NAME_LEN || e.name.length === 0) return null
  if (!EMOTE_CDN_PATTERN.test(e.url)) return null
  return e
}
function sanitizeEmoteList(emotes) {
  return emotes.slice(0, MAX_EMOTES_PER_SOURCE).map(sanitizeEmote).filter(Boolean)
}

// Fetch BTTV channel emotes
async function fetchBTTVChannelEmotes(channelName, channelId = null, platform = 'twitch') {
  try {
    if (platform === 'youtube') {
      // BTTV's YouTube endpoint (unlike 7TV's) is keyed under "youtube" and
      // needs the real UC... channel id — no handle lookup here either.
      if (!/^UC[\w-]{20,}$/i.test(String(channelId || ''))) {
        log(' BTTV: No resolvable YouTube channel ID for', channelName, '- skipping')
        return []
      }
      subscribeBTTVChannel(chKey('youtube', channelName), `youtube:${channelId}`)
      const ytResponse = await fetchWithTimeout(`https://api.betterttv.net/3/cached/users/youtube/${channelId}`)
      if (ytResponse.status === 404) {
        ytResponse.body?.cancel()
        return [] // genuine: user has no BTTV
      }
      if (!ytResponse.ok) {
        ytResponse.body?.cancel()
        return null // transient: 5xx etc.
      }
      const ytData = await ytResponse.json()
      const ytEmotes = [...(ytData.channelEmotes || []), ...(ytData.sharedEmotes || [])]
      return sanitizeEmoteList(
        ytEmotes.map((e) => ({
          name: e.code,
          url: `https://cdn.betterttv.net/emote/${e.id}/1x.webp`,
          animated: e.animated === true,
          source: 'bttv',
          os: bttvOversize(e),
          hash: e.id,
        })),
      )
    }
    // BTTV API requires numeric Twitch user ID, not username
    let twitchId = channelId
    if (!twitchId) {
      twitchId = await lookupTwitchUserId(channelName)
      if (!twitchId) {
        log(' BTTV: Could not resolve Twitch ID for', channelName)
        return null // transient: ID lookup failed, retry next time
      }
    }
    subscribeBTTVChannel(chKey('twitch', channelName), `twitch:${twitchId}`)
    const userResponse = await fetchWithTimeout(`https://api.betterttv.net/3/cached/users/twitch/${twitchId}`)
    if (userResponse.status === 404) {
      userResponse.body?.cancel()
      return []
    } // genuine: user has no BTTV
    if (!userResponse.ok) {
      userResponse.body?.cancel()
      return null
    } // transient: 5xx etc.

    const userData = await userResponse.json()
    const emotes = [...(userData.channelEmotes || []), ...(userData.sharedEmotes || [])]

    return sanitizeEmoteList(
      emotes.map((e) => ({
        name: e.code,
        url: `https://cdn.betterttv.net/emote/${e.id}/1x.webp`,
        animated: e.animated === true,
        source: 'bttv',
        hash: e.id,
        os: bttvOversize(e),
      })),
    )
  } catch (error) {
    log(' BTTV channel emotes error for:', channelName, error?.message)
    return null // transient: network/timeout
  }
}

// Negative cache for FFZ room 404s — a channel with no FFZ room 404s on
// EVERY visit, and the orchestrator's failure backdating (any sibling
// provider failing shortens the retry window to ~60s) was re-fetching the
// same dead room several times a minute. Session-scoped Map like
// ytChannelIdCache — cheap to rebuild after a SW restart.
const ffzRoom404At = new Map() // room key (lowercase) → ms timestamp of the 404
const FFZ_ROOM_404_TTL = 30 * 60 * 1000 // matches CHANNEL_EMOTES_TTL — new FFZ rooms are rare
const FFZ_ROOM_404_MAX = 500

// Fetch FFZ channel emotes
async function fetchFFZChannelEmotes(channelName) {
  const roomKey = String(channelName || '').toLowerCase()
  // FFZ rooms are TWITCH rooms only. YouTube identities — UC… channel ids,
  // @handles, hyphenated 11-char videoIds — contain chars a Twitch login
  // ([a-z0-9_], ≤25) never can. Do NOT also gate on ytChannelIdCache: linked
  // twitch channels resolve their yt id under the SAME bare-login key, so
  // that check silently killed FFZ for every twitch channel with a linked
  // youtube. A rare login-shaped videoId just 404s into ffzRoom404At.
  if (!/^[a-z0-9_]{1,25}$/.test(roomKey)) return []
  const negAt = ffzRoom404At.get(roomKey)
  if (negAt && Date.now() - negAt < FFZ_ROOM_404_TTL) return []
  try {
    const response = await fetchWithTimeout(`https://api.frankerfacez.com/v1/room/${roomKey}`)
    if (response.status === 404) {
      response.body?.cancel()
      if (ffzRoom404At.size >= FFZ_ROOM_404_MAX) ffzRoom404At.delete(ffzRoom404At.keys().next().value)
      ffzRoom404At.set(roomKey, Date.now())
      return []
    } // genuine: channel has no FFZ
    if (!response.ok) {
      response.body?.cancel()
      return null
    } // transient: 5xx etc.
    ffzRoom404At.delete(roomKey) // room exists (again) — drop any expired negative entry

    const data = await response.json()
    const emotes = []

    for (const setId in data.sets) {
      const set = data.sets[setId]
      for (const emote of set.emoticons || []) {
        // FFZ modifier emotes (ffzW/ffzX/ffzY/ffzCursed/ffzHyper…) aren't real
        // images — they transform the preceding emote. Handled as typed tokens
        // via src/lib/modifiers.js, so keep them out of the pool: otherwise they
        // resolve as base emotes (the FFZ arrow placeholder), pollute the picker,
        // and break overlay stacks (e.g. "LICK ffzW ALERT0").
        if (emote.modifier) continue
        // FFZ exposes animated emotes under emote.animated (animated webp);
        // emote.urls is the static PNG first-frame. Prefer animated when present.
        const srcs = emote.animated || emote.urls
        const rawUrl = srcs['1'] || srcs['2'] || srcs['4']
        emotes.push({
          name: emote.name,
          url: rawUrl.startsWith('https:') ? rawUrl : `https:${rawUrl}`,
          source: 'ffz',
          hash: `ffz-${emote.id}`,
        })
      }
    }
    return sanitizeEmoteList(emotes)
  } catch (error) {
    log(' FFZ channel emotes error for:', channelName, error?.message)
    return null // transient
  }
}

// Cache Twitch user IDs to avoid repeated lookups (especially for polling).
// Persisted to chrome.storage.local — IDs never change, so cross-SW survival
// eliminates the resolve/GQL cascade on every SW wake (critical at 30k users).
const twitchIdCache = new Map()
const TWITCH_ID_CACHE_MAX = 1000
const kickChannelIdCache = new Map()

// Kick channel slug → numeric channelId, LRU-cached (cap 100). Shared by the
// kick_resolve_channel runtime-message handler, the kick_send_message flow,
// and the kick:relay_send ws path (server-relayed sends from heatsync.org).
async function resolveKickChannelIdBg(slug) {
  if (!slug) return { error: 'no slug' }
  const cached = kickChannelIdCache.get(slug)
  if (cached) return { channelId: cached }
  try {
    const resp = await fetchWithTimeout(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`)
    if (!resp.ok) return { error: `kick api ${resp.status}` }
    const data = await resp.json()
    // messages/send/{id} takes the CHATROOM id, not the channel id. Kick's
    // backend stopped translating channel ids (2026-07): a channel-id send
    // returns 200 but broadcasts to no one — the message lands in the void
    // (proven live: send to channels.id silent, send to chatroom.id echoes
    // on chatrooms.<id>.v2). Fall back to data.id only if chatroom is absent.
    const channelId = data?.chatroom?.id || data?.id
    if (!channelId) return { error: 'no channel id' }
    if (kickChannelIdCache.size >= 100) {
      const oldest = kickChannelIdCache.keys().next().value
      kickChannelIdCache.delete(oldest)
    }
    kickChannelIdCache.set(slug, channelId)
    return { channelId }
  } catch (e) {
    return { error: e.message }
  }
}

// Rank kick.com tabs by relay viability: a discarded tab has NO content
// scripts (memory-saver unloads them) and a pre-reload tab holds an
// invalidated context — both throw "Receiving end does not exist" on
// tabs.sendMessage. Loaded+active tabs first; dead ones fail fast, so
// walking the whole list costs ~ms per corpse.
function rankKickRelayTabs(tabs) {
  return [...tabs].sort(
    (a, b) =>
      (a.discarded === true) - (b.discarded === true) ||
      (b.status === 'complete') - (a.status === 'complete') ||
      (b.active === true) - (a.active === true),
  )
}

// The kick login, as two cookies: XSRF-TOKEN (present = signed in) and the
// non-httpOnly session_token kick now wants as a Bearer. One read, shared by
// every kick relay and the logged-in probe.
async function readKickSession() {
  const [cookie, session] = await Promise.all([
    browser.cookies.get({ url: 'https://kick.com', name: 'XSRF-TOKEN' }),
    browser.cookies.get({ url: 'https://kick.com', name: 'session_token' }),
  ])
  return { cookie, session }
}

// A relay that provably never reached a page: nothing was listening, or the tab
// is gone. Only such a failure may be retried on another tab — one that took the
// message and died mid-way ("message port closed") may already have posted it.
const KICK_UNREACHED = /Receiving end does not exist|Could not establish connection|No tab with id/i

// One kick.com tab's answer to a relay message: { answer } from the page, or
// { error, unreached } when it never came. Never throws. deadlineMs > 0 caps the
// wait, so a hung renderer cannot hang the caller forever.
async function askKickTab(tabId, message, deadlineMs) {
  const asked = browser.tabs
    .sendMessage(tabId, message)
    .then((answer) => (answer ? { answer } : { error: 'no response from tab', unreached: true }))
    .catch((e) => ({ error: e?.message || 'kick relay failed', unreached: KICK_UNREACHED.test(e?.message || '') }))
  if (!deadlineMs) return asked
  return Promise.race([
    asked,
    new Promise((res) => setTimeout(() => res({ error: 'kick tab unresponsive — reload kick.com' }), deadlineMs)),
  ])
}

// Hand one relay message to a kick.com tab and resolve its answer; never throws.
// The open tabs go first, best-ranked first (prefer(tab) floats one to the
// front); when none could take it — no tab at all, or every one provably never
// saw it (discarded, pre-reload, signed-in-elsewhere pages) — the bridge tab
// carries it, opened on demand. A tab that took the message and then failed
// is NOT retried through the bridge: the post may be done.
async function relayViaKickTab(message, { prefer = null, deadlineMs = 0 } = {}) {
  let ranked = rankKickRelayTabs(await browser.tabs.query({ url: '*://*.kick.com/*' }).catch(() => []))
  const first = prefer ? ranked.find(prefer) : null
  if (first) ranked = [first, ...ranked.filter((t) => t !== first)]
  let lastError = 'no response from tab'
  let mayHaveLanded = false
  for (const tab of ranked) {
    // A bridge tab the map forgot (SW restart) goes back under management, or
    // the sweep would close it mid-use.
    if ((tab.url || '').includes(TAB_BRIDGE_MARK)) kickBridge.adopt(KICK_BRIDGE_KEY, tab.id)
    const r = await askKickTab(tab.id, message, deadlineMs)
    if (r.answer) return r.answer
    lastError = r.error
    if (!r.unreached) mayHaveLanded = true
  }
  if (mayHaveLanded) return { ok: false, error: lastError }
  try {
    const sent = await kickBridge.deliver(KICK_BRIDGE_KEY, message)
    if (sent.bridge) return { ok: false, error: sent.bridge.error || 'no_kick_tab' }
    return sent.answer || { ok: false, error: 'no response from tab' }
  } catch (e) {
    return { ok: false, error: e?.message || 'kick relay failed' }
  }
}

// Send a Kick chat message via a kick.com tab's session cookies. Any kick.com
// tab works as the messaging origin — the send is parameterized by channelId
// + XSRF token, not by which channel the tab happens to be viewing. With none
// open the hidden bridge tab (kickBridge, 06-message-gate.js) stands in. Shared
// by the kick_send_message runtime-message handler and the kick:relay_send ws
// path.
async function sendKickMessageViaTab(channelId, content, reply = null) {
  if (!channelId || !content) return { ok: false, error: 'missing params' }
  // Kick's send API demands Authorization: Bearer <session_token> (2026-07);
  // the laravel session cookie + XSRF alone 403s. Absent XSRF = logged out —
  // answered here, before any tab is opened for a send that cannot land.
  const { cookie, session } = await readKickSession()
  if (!cookie?.value) return { ok: false, error: 'kick_not_logged_in' }
  return relayViaKickTab({
    type: 'kick_send_relay',
    channelId,
    content,
    reply: reply || null,
    xsrfToken: cookie.value,
    sessionToken: session?.value || '',
  })
}

// Kick chat modes — PUT /api/v1/chatrooms/<chatroomId>. Route discovered
// read-only: a GET on it answers 405 "Supported methods: PUT". Same auth shape
// as sendKickMessageViaTab (XSRF cookie + Bearer session_token), same reason it
// must run inside a kick.com tab.
async function setKickChatModeViaTab(chatroomId, body) {
  if (!chatroomId || !body) return { ok: false, error: 'missing params' }
  const { cookie, session } = await readKickSession()
  if (!cookie?.value) return { ok: false, error: 'kick_not_logged_in' }
  return relayViaKickTab({
    type: 'kick_chatmode_relay',
    chatroomId,
    body,
    xsrfToken: cookie.value,
    sessionToken: session?.value || '',
  })
}

const kickChatroomIdCache = new Map()
// slug -> kick's CHANNEL id (v2 channels .id). The web.kick.com moderation
// routes key on it; the chat send/delete routes key on the chatroom id instead.
const kickChannelNumIdCache = new Map()

// The kick moderation routes on web.kick.com that kick's own dashboard calls
// (read out of its bundle; see kick-mod-calls.js). One whitelist: the relay tab
// only ever fetches what this returns, never a url the page handed it.
//   words_get / words_edit   banned words list / add + remove
//   rules_get / rules_set    kick's message-moderation levels (8 keys)
//   chatters                 who is chatting now (kick serves it to anyone)
const KICK_WEB_MOD_OPS = new Set(['words_get', 'words_edit', 'rules_get', 'rules_set', 'chatters'])
const KICK_RULE_KEYS = [
  'sexual_content',
  'hate_speech',
  'violence',
  'bullying',
  'drugs',
  'weapons',
  'gibberish',
  'spam',
]
function kickWebModRequest(op, channelId, a = {}) {
  const id = Number(channelId)
  if (!Number.isInteger(id) || id <= 0) return null
  const base = `https://web.kick.com/api/v1/channels/${id}/chat`
  const word = (w) => ({ word: String(w?.word || '').trim(), permission: String(w?.permission || 'PUBLIC') })
  if (op === 'words_get') return { method: 'GET', url: `${base}/banned-words` }
  if (op === 'chatters') return { method: 'GET', url: `${base}/active-chatters` }
  if (op === 'rules_get') return { method: 'GET', url: `${base}/moderation-rules` }
  if (op === 'words_edit') {
    const additions = (Array.isArray(a.add) ? a.add : []).map(word).filter((w) => w.word)
    const removals = (Array.isArray(a.remove) ? a.remove : []).map(word).filter((w) => w.word)
    if (!additions.length && !removals.length) return null
    return { method: 'PUT', url: `${base}/banned-words`, body: { additions, removals } }
  }
  if (op === 'rules_set') {
    const body = {}
    for (const k of KICK_RULE_KEYS) {
      const n = Number(a.rules?.[k])
      if (!Number.isInteger(n) || n < 0 || n > 3) return null
      body[k] = n
    }
    return { method: 'PUT', url: `${base}/moderation-rules`, body }
  }
  return null
}
const kickUsernameToIdCache = new Map()

// AutoMod hold-queue — per-broadcaster watch-registration throttle. Ext
// surfaces re-send automod_watch every ~25min as a keepalive; this caps the
// actual heatsync.org call to once per window (the server's own last_active_at
// bump is the real keepalive signal, not the HTTP call cadence).
const AUTOMOD_WATCH_THROTTLE_MS = 30 * 60 * 1000
const _automodWatchThrottle = new Map() // broadcasterId -> last-sent ts
// One shape for a held message, whichever door it came through: the live
// websocket push, or the pending backfill the watch call hands back. Two
// copies of this coercion would drift the way every duplicated message
// pipeline in this codebase has (see tests/handler-parity.test.js), and the
// backfill would be the copy nobody notices is wrong.
function normalizeAutomodHold(msg) {
  // heldAt arrives as an ISO 8601 string from the server (Helix timestamp
  // shape) — Number() on that NaNs, which silently always fell back to
  // Date.now(). Date.parse handles the string case; Number still covers a
  // server that ever sends an epoch ms number. It matters more for a backfill
  // than for a live push: a hold from 40 minutes ago must not read as now.
  const heldAtRaw = typeof msg.heldAt === 'string' ? Date.parse(msg.heldAt) : Number(msg.heldAt)
  const heldAt = Number.isFinite(heldAtRaw) && heldAtRaw > 0 ? heldAtRaw : Date.now()
  return {
    type: 'automod_hold',
    broadcasterId: String(msg.broadcasterId || ''),
    broadcasterLogin: String(msg.broadcasterLogin || '').toLowerCase(),
    msgId: String(msg.msgId || ''),
    senderId: String(msg.senderId || ''),
    senderLogin: String(msg.senderLogin || '').toLowerCase(),
    senderName: String(msg.senderName || msg.senderLogin || '').slice(0, 100),
    text: String(msg.text || '').slice(0, 2000),
    heldAt,
    reason: msg.reason === 'blocked_term' ? 'blocked_term' : 'automod',
    category: msg.category ? String(msg.category).slice(0, 100) : null,
    level: Number(msg.level) || 0,
    terms: Array.isArray(msg.terms)
      ? msg.terms
          .map((t) => String(t).slice(0, 100))
          .filter(Boolean)
          .slice(0, 10)
      : null,
  }
}
let _automodRelinkNotified = false // one 'automod_relink' broadcast per SW lifetime
function notifyAutomodRelinkOnce() {
  if (_automodRelinkNotified) return
  _automodRelinkNotified = true
  broadcastToTabs({ type: 'automod_relink' })
}
// Kick chatter profile_pic (username → url), captured from the SAME v1/users
// fetch that resolves the kick user_id — so real avatars cost zero extra
// requests. Populated in lockstep with kickUsernameToIdCache (both set only when
// v1/users runs), so an id-cache hit always implies a pfp-cache hit.
const kickUsernameToPfpCache = new Map()
// kick channel slug (lowercased) → numeric kick user id. 7TV's /v3/users/kick/{id}
// needs the numeric id; the initial fetch resolves it via GQL, the poll reuses it.
const channelOwnerKickId = new Map()

// channel-cache-key (lowercased, whatever "channel" string join_channel used —
// a handle, a videoId, or a config tab id) → resolved YouTube UC... channel id.
// Neither 7TV nor BTTV can look up YouTube channels by handle/videoId, only by
// the real UC id, and YouTube's own oEmbed only ever hands back a handle — so
// this is resolved once (scrape the channel page's canonical id) and cached.
// Not persisted (mirrors kickChannelIdCache — session-scoped is fine, cheap to
// re-resolve after a SW restart).
const ytChannelIdCache = new Map()
const YT_CHANNEL_ID_CACHE_MAX = 300

// Resolve the real YouTube channel id (UC...) for a channel-emote fetch.
// `channelName` is the cache key (handle/videoId/tab-id — whatever join_channel
// was called with); `hint` is anything more specific the caller already has
// (e.g. a stored `.../channel/UC.../` or `/@handle` URL). Never falls back to
// guessing a Twitch/Kick identity — an unresolved id means "skip, no emotes."
async function resolveYtChannelId(channelName, hint = null) {
  // A bare 11-char [\w-] name with no @handle in the hint is a videoId: ids are
  // case-sensitive, so it keys (and resolves) as-is, never lowercased.
  const rawName = String(channelName || '')
  const hintHandle = /@[\w.-]+/.test(String(hint || channelName || ''))
  const isVideoId = !hintHandle && /^[\w-]{11}$/.test(rawName)
  const key = isVideoId ? rawName : rawName.toLowerCase()
  if (!key) return null
  const cached = ytChannelIdCache.get(key)
  if (cached) return cached

  // Already have a UC id sitting in the hint or the channel name itself.
  const direct = (String(hint || '').match(/UC[\w-]{20,}/) || String(channelName || '').match(/UC[\w-]{20,}/))?.[0]
  if (direct) {
    ytChannelIdCache.set(key, direct)
    return direct
  }

  // Pull an @handle out of the hint/channelName; bare alnum strings (e.g. a
  // manually-typed handle with no @) count too. A raw 11-char videoId won't
  // match either pattern — resolve its handle via the existing oEmbed lookup
  // first (getYtChannelHandle is already used for the WS-subscribe path).
  const handleMatch = String(hint || channelName || '').match(/@([\w.-]+)/)
  let handle = handleMatch ? handleMatch[1] : !isVideoId && /^[\w.-]{3,30}$/.test(key) ? key : null
  if (!handle && isVideoId) {
    handle = await getYtChannelHandle(key)
    // lowercase-only 11-char names can be real handles; a wrong guess just 404s
    if (!handle && /^[a-z0-9._]+$/.test(key)) handle = key
  }
  if (!handle) return null // nothing to resolve from — skip quietly, no cross-platform guessing

  try {
    const resp = await fetchWithTimeout(`https://www.youtube.com/@${encodeURIComponent(handle)}`, {}, 6000)
    if (!resp.ok) {
      resp.body?.cancel()
      return null
    }
    const html = await resp.text()
    const m = html.match(/"externalId":"(UC[\w-]{20,})"/)
    const id = m?.[1] || null
    if (id) {
      if (ytChannelIdCache.size >= YT_CHANNEL_ID_CACHE_MAX)
        ytChannelIdCache.delete(ytChannelIdCache.keys().next().value)
      ytChannelIdCache.set(key, id)
    }
    return id
  } catch (e) {
    log(' YouTube channel ID resolve failed for', handle, ':', e?.message)
    return null
  }
}
let twitchIdPersistTimer = null
function persistTwitchIdCache() {
  if (twitchIdPersistTimer) return
  twitchIdPersistTimer = setTimeout(() => {
    twitchIdPersistTimer = null
    browser.storage.local.set({ twitch_id_cache: Object.fromEntries(twitchIdCache) }).catch(() => {})
  }, 5000)
}

// Lookup Twitch user ID from username — try Twitch GQL first (fast, no rate limit), first-party resolve fallback
async function lookupTwitchUserId(username) {
  const cached = twitchIdCache.get(username)
  if (cached) {
    twitchIdCache.delete(username)
    twitchIdCache.set(username, cached)
    return cached
  }
  try {
    // Twitch GQL — same client ID used by the website, no auth needed
    const gqlResp = await fetchWithTimeout('https://gql.twitch.tv/gql', {
      method: 'POST',
      headers: { 'Client-Id': 'kimne78kx3ncx6brgo4mv6wki5h1ko', 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: `{ user(login: "${username.replace(/[^a-z0-9_]/gi, '')}") { id } }` }),
    })
    if (gqlResp.ok) {
      const gqlData = await gqlResp.json()
      const id = gqlData?.data?.user?.id
      if (id) {
        if (twitchIdCache.size >= TWITCH_ID_CACHE_MAX) {
          twitchIdCache.delete(twitchIdCache.keys().next().value)
        }
        twitchIdCache.set(username, id)
        persistTwitchIdCache()
        log('[hs-bg] GQL lookup', username, '→', id)
        return id
      }
    }
  } catch (e) {
    log(' GQL user lookup failed, trying first-party resolve:', e.message)
  }
  // Fallback to first-party resolver
  try {
    const response = await fetchWithTimeout(
      `https://heatsync.org/api/resolve/twitch/${encodeURIComponent(username)}`,
      {},
      2000,
    )
    if (!response.ok) {
      response.body?.cancel()
      return null
    }
    const data = await response.json()
    const id = data?.id
    if (id && /^\d+$/.test(String(id))) {
      if (twitchIdCache.size >= TWITCH_ID_CACHE_MAX) {
        twitchIdCache.delete(twitchIdCache.keys().next().value)
      }
      twitchIdCache.set(username, String(id))
      persistTwitchIdCache()
      return String(id)
    }
    return null
  } catch (e) {
    log(' Failed to lookup Twitch user ID:', e)
    return null
  }
}

// id → login, the reverse of lookupTwitchUserId above. Shared-chat IRC tags
// (source-room-id) carry only the numeric channel id of the partner channel a
// message originated in — nothing resolves that to a displayable name without
// this. In-memory only (unlike twitchIdCache, not persisted to storage — a
// stale partner-channel name in a shared-chat chip is low-stakes and this
// avoids one more disk write on every shared-chat message).
const twitchLoginCache = new Map()
const TWITCH_LOGIN_CACHE_MAX = 500
async function resolveTwitchLoginById(userId) {
  const id = String(userId || '').replace(/[^0-9]/g, '')
  if (!id) return null
  const cached = twitchLoginCache.get(id)
  if (cached) {
    twitchLoginCache.delete(id)
    twitchLoginCache.set(id, cached)
    return cached
  }
  try {
    // Same public GQL endpoint + client-id as lookupTwitchUserId — no auth needed.
    const gqlResp = await fetchWithTimeout('https://gql.twitch.tv/gql', {
      method: 'POST',
      headers: { 'Client-Id': 'kimne78kx3ncx6brgo4mv6wki5h1ko', 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: `{ user(id: "${id}") { login } }` }),
    })
    if (gqlResp.ok) {
      const gqlData = await gqlResp.json()
      const login = gqlData?.data?.user?.login
      if (login) {
        if (twitchLoginCache.size >= TWITCH_LOGIN_CACHE_MAX) {
          twitchLoginCache.delete(twitchLoginCache.keys().next().value)
        }
        twitchLoginCache.set(id, login)
        return login
      }
    }
  } catch (e) {
    log(' GQL login-by-id lookup failed:', e.message)
  }
  return null
}

// Resolve a user's avatar (pfp) for notification toasts. A toast is about a
// specific person — their face is the recognizable signal, not the heatsync
// logo. Cached LRU (success only — never poison the cache on a transient
// failure, so a later mention can retry). Returns '' when unresolved; callers
// fall back to the extension icon.
const avatarCache = new Map()
const AVATAR_CACHE_MAX = 500
async function resolveAvatarUrl(username, platform) {
  if (!username) return ''
  const name = String(username).trim()
  if (!name) return ''
  const key = `${platform || 'twitch'}|${name.toLowerCase()}`
  const hit = avatarCache.get(key)
  if (hit !== undefined) {
    avatarCache.delete(key)
    avatarCache.set(key, hit)
    return hit
  }
  let url = ''
  try {
    if (platform === 'kick') {
      // Kick public v2 — channel slug (= username) → user.profile_pic.
      const r = await fetchWithTimeout(`https://kick.com/api/v2/channels/${encodeURIComponent(name)}`, {}, 3000)
      if (r.ok) {
        const j = await r.json()
        url = j?.user?.profile_pic || ''
      } else r.body?.cancel?.()
    } else if (platform === 'youtube' || platform === 'yt') {
      // No twitch GQL for a youtube identity — a yt handle that happens to
      // match an unrelated twitch login would return THAT user's avatar as the
      // toast icon. No cheap unauthenticated yt avatar endpoint, so leave blank
      // (toast falls back to the platform mark).
      url = ''
    } else {
      // Twitch GQL — same client-id as the website, unauthenticated, no rate limit.
      const r = await fetchWithTimeout(
        'https://gql.twitch.tv/gql',
        {
          method: 'POST',
          headers: { 'Client-Id': 'kimne78kx3ncx6brgo4mv6wki5h1ko', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: `{ user(login: "${name.replace(/[^a-z0-9_]/gi, '')}") { profileImageURL(width: 70) } }`,
          }),
        },
        3000,
      )
      if (r.ok) {
        const j = await r.json()
        url = j?.data?.user?.profileImageURL || ''
      } else r.body?.cancel?.()
    }
  } catch {}
  if (url) {
    if (avatarCache.size >= AVATAR_CACHE_MAX) avatarCache.delete(avatarCache.keys().next().value)
    avatarCache.set(key, url)
  }
  return url
}

// chrome.notifications renders data: URLs reliably; remote https icons are
// flaky when Chrome hands the toast to a native daemon (mako on wlroots). Fetch
// the pfp in the SW and inline it as base64 so the face always shows. No
// FileReader in MV3 service workers — use arrayBuffer + btoa. Returns '' on any
// failure so the caller falls back to the extension icon.
async function toNotifIconDataUrl(url) {
  if (!url) return ''
  if (url.startsWith('data:')) return url
  try {
    const r = await fetchWithTimeout(url, {}, 4000)
    if (!r.ok) {
      r.body?.cancel?.()
      return ''
    }
    const blob = await r.blob()
    if (blob.size > 512 * 1024) return '' // sanity cap — pfps are tiny
    const bytes = new Uint8Array(await blob.arrayBuffer())
    let bin = ''
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
    return `data:${blob.type || 'image/png'};base64,${btoa(bin)}`
  } catch {
    return ''
  }
}

// 7TV v3: the user-lookup response's inline `emote_set` can be null even when
// the user has an active set — `emote_set_id` is then the id to fetch
// separately via /v3/emote-sets/:id (SevenTV/Extension#1253). Null `emote_set`
// AND no `emote_set_id` together mean the user genuinely has no active set.
// Throws on a failed follow-up fetch so callers' existing try/catch treats it
// as the same transient failure a failed user-lookup already is.
async function resolve7TVEmoteSet(data) {
  if (data?.emote_set) return data.emote_set
  const setId = data?.emote_set_id
  if (!setId) return null
  const res = await fetchWithTimeout(`https://7tv.io/v3/emote-sets/${setId}`, {}, 8000)
  if (!res.ok) {
    res.body?.cancel?.()
    throw new Error(`7TV emote-set ${setId} fetch failed (${res.status})`)
  }
  return await res.json()
}

// Fetch 7TV channel emotes
// Supports Twitch (user ID or username) and Kick (username) lookups
async function fetch7TVChannelEmotes(channelName, channelId = null, platform = 'twitch') {
  try {
    let response, data, identifier

    if (platform === 'kick') {
      // Kick: 7TV requires numeric user ID, not slug — resolve via GQL search
      log(' 7TV: Fetching Kick channel emotes for:', channelName)
      // Accept channelId only when it looks like a numeric Kick user id — a slug
      // passed here would be cached and then cause 404s on every poll cycle.
      let kickId = channelId && /^\d+$/.test(String(channelId)) ? channelId : null
      if (!kickId) {
        try {
          const gqlResp = await fetchWithTimeout('https://7tv.io/v3/gql', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              query: `query { users(query: "${channelName.replace(/[^a-z0-9_-]/gi, '')}") { connections { platform id username } } }`,
            }),
          })
          if (gqlResp.ok) {
            const gqlData = await gqlResp.json()
            const users = gqlData?.data?.users || []
            for (const u of users) {
              const conn = u.connections?.find(
                (c) => c.platform === 'KICK' && c.username?.toLowerCase() === channelName.toLowerCase(),
              )
              // Validate that id is numeric — 7TV GQL id field is a string but must be
              // the Kick numeric user id; a slug here would cause 404s on every poll.
              if (conn && /^\d+$/.test(String(conn.id || ''))) {
                kickId = conn.id
                break
              }
            }
          }
        } catch (e) {
          log(' 7TV: GQL Kick lookup failed:', e.message)
        }
      }
      if (!kickId) {
        log(' 7TV: Could not resolve Kick user ID for', channelName)
        return null // transient: ID lookup failed
      }
      identifier = kickId
      // Cache the resolved numeric id so the 7TV poll can reuse it (the poll
      // only has the channel slug, and the kick endpoint rejects slugs).
      channelOwnerKickId.set(channelName.toLowerCase(), kickId)
      if (channelOwnerKickId.size > 500) channelOwnerKickId.delete(channelOwnerKickId.keys().next().value)
      response = await fetchWithTimeout(`https://7tv.io/v3/users/kick/${kickId}`)
      if (response.status === 404) {
        response.body?.cancel()
        return []
      } // genuine: user has no 7TV
      if (!response.ok) {
        response.body?.cancel()
        log(` 7TV: Kick lookup failed (${response.status})`)
        return null // transient: 5xx etc.
      }
      data = await response.json()
      log(' ✅ 7TV: Kick lookup succeeded (id:', `${kickId})`)
    } else if (platform === 'youtube') {
      // 7TV files YouTube accounts under the "google" platform slug (YouTube
      // sign-in is Google OAuth), keyed by the real UC... channel id — there is
      // no handle/username lookup on this endpoint. channelId must already be
      // a resolved UC id by the time we get here (fetchChannelOwnerEmotes
      // resolves it up front); if it isn't, we cannot safely identify the
      // channel, so return no emotes rather than guess or fall through to a
      // Twitch/username endpoint (that would be a cross-platform identity bleed).
      if (!/^UC[\w-]{20,}$/i.test(String(channelId || ''))) {
        log(' 7TV: No resolvable YouTube channel ID for', channelName, '- skipping (no cross-platform fallback)')
        return []
      }
      identifier = channelId
      log(' 7TV: Fetching YouTube channel emotes for:', channelName, '(id:', `${identifier})`)
      response = await fetchWithTimeout(`https://7tv.io/v3/users/google/${identifier}`, {}, 15000)
      if (response.status === 404) {
        response.body?.cancel()
        return [] // genuine: user has no 7TV
      }
      if (!response.ok) {
        response.body?.cancel()
        log(` 7TV: YouTube lookup failed (${response.status})`)
        return null // transient: 5xx etc.
      }
      data = await response.json()
      log(' ✅ 7TV: YouTube lookup succeeded (id:', `${identifier})`)
    } else {
      // Twitch: use channelId if available, otherwise lookup via GQL/first-party resolve
      identifier = channelId
      if (!identifier) {
        log(' 7TV: No channelId provided, looking up via lookupTwitchUserId...')
        identifier = await lookupTwitchUserId(channelName)
        if (identifier) {
          log(' 7TV: Got user ID:', identifier)
        }
      }

      // Final fallback to username (rarely works but try anyway)
      if (!identifier) {
        identifier = channelName
      }

      log(' 7TV: Fetching with identifier:', identifier, '(channelId:', channelId, ')')

      // Try Twitch ID lookup first — large channels (kripp, xqc) can be slow,
      // give 7TV 15s before timing out.
      const sevenTvUrl = `https://7tv.io/v3/users/twitch/${identifier}`
      response = await fetchWithTimeout(sevenTvUrl, {}, 15000)
      if (DEBUG)
        broadcastToTabs({ type: 'debug_log', msg: `7TV fetch ${channelName}: ${sevenTvUrl} → ${response.status}` })

      if (!response.ok) {
        const firstStatus = response.status
        response.body?.cancel()
        log(` 7TV: Twitch ID lookup failed (${firstStatus}), trying username fallback...`)

        // Fallback to username-based lookup
        response = await fetchWithTimeout(`https://7tv.io/v3/users/${channelName}`, {}, 15000)
        if (response.status === 404) {
          response.body?.cancel()
          // Both Twitch ID and username 404 = user genuinely has no 7TV account
          if (firstStatus === 404) return []
          return null // mixed: first was 5xx, second was 404 — treat as transient
        }
        if (!response.ok) {
          response.body?.cancel()
          log(` 7TV: Username lookup also failed (${response.status})`)
          return null // transient: 5xx etc.
        }

        data = await response.json()
        log(' ✅ 7TV: Username fallback succeeded!')
      } else {
        data = await response.json()
        log(' ✅ 7TV: Twitch ID lookup succeeded')
      }
    }

    stvCheckShape('user', data)
    const emoteSet = await resolve7TVEmoteSet(data)
    if (!emoteSet) {
      log(' 7TV: No emote set found for', identifier)
      return [] // genuine: user has no emote set
    }
    stvCheckShape('set', emoteSet)

    const emoteList = emoteSet.emotes || []
    log(' 7TV: Found', emoteList.length, 'emotes for', identifier, '(set ID:', `${emoteSet.id})`)

    const emotes = sanitizeEmoteList(
      emoteList.map((e) => ({
        name: e.name,
        url: `https://cdn.7tv.app/emote/${e.id}/1x.avif`,
        source: '7tv',
        hash: e.id,
        flags: e.flags || e.data?.flags || 0,
        zeroWidth: !!(e.flags & 257 || e.data?.flags & 257),
        animated: !!e.data?.animated,
      })),
    )
    const cosmeticIds = extract7TVCosmeticIds(data)
    // Resolve cosmetics async — dont block emote return
    if (cosmeticIds && channelId) {
      resolve7TVCosmeticIds(cosmeticIds)
        .then((cosmetic) => {
          if (cosmetic) setUserCosmetic(String(channelId), cosmetic)
        })
        .catch(() => {})
    }
    return { emotes, setId: emoteSet.id }
  } catch (error) {
    stvCheckParse('user', error)
    // Aborts (timeouts) are expected for slow channels; demote to log so the
    // console isn't spammed with red errors during normal operation.
    const isAbort = error?.name === 'AbortError' || /aborted/i.test(error?.message || '')
    if (isAbort) {
      log(' 7TV: timeout for', channelName, '(will retry on next fetch)')
    } else {
      console.error('[hs-bg] 7TV FETCH ERROR for', channelName, ':', error?.message || error)
    }
    if (DEBUG) broadcastToTabs({ type: 'debug_log', msg: `7TV ERROR ${channelName}: ${error?.message || error}` })
    return null // transient: network/timeout
  }
}

// Cache of resolved 7TV cosmetic objects by ID (paint_id/badge_id → full object)
const cosmeticObjectCache = new Map()

function extract7TVCosmeticIds(data) {
  const style = data?.user?.style || data?.style
  if (!style) return null
  // Old API returned full objects; new API returns IDs only
  if (style.paint || style.badge) return { paint: style.paint || null, badge: style.badge || null }
  const paintId = style.paint_id || null
  const badgeId = style.badge_id || null
  if (!paintId && !badgeId) return null
  return { paintId, badgeId }
}

async function resolve7TVCosmeticIds(ids) {
  if (!ids) return null
  // Already resolved (old API format)
  if (ids.paint !== undefined && ids.badge !== undefined && !ids.paintId) return ids

  const toFetch = []
  const result = { paint: null, badge: null }

  // Check cache first
  if (ids.paintId) {
    const cached = cosmeticObjectCache.get(ids.paintId)
    if (cached) {
      // Move to end for LRU ordering
      cosmeticObjectCache.delete(ids.paintId)
      cosmeticObjectCache.set(ids.paintId, cached)
      result.paint = cached
    } else {
      toFetch.push(ids.paintId)
    }
  }
  if (ids.badgeId) {
    const cached = cosmeticObjectCache.get(ids.badgeId)
    if (cached) {
      // Move to end for LRU ordering
      cosmeticObjectCache.delete(ids.badgeId)
      cosmeticObjectCache.set(ids.badgeId, cached)
      result.badge = cached
    } else {
      toFetch.push(ids.badgeId)
    }
  }
  if (toFetch.length === 0) return result

  try {
    const query = `query($list:[ObjectID!]){cosmetics(list:$list){paints{id name function color stops{at color}angle shape image_url repeat shadows{x_offset y_offset radius color}}badges{id name tooltip tag host{url files{name format width height}}}}}`
    const resp = await fetchWithTimeout('https://7tv.io/v3/gql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { list: toFetch } }),
    })
    if (!resp.ok) return result
    const data = await resp.json()
    const paints = data?.data?.cosmetics?.paints || []
    const badges = data?.data?.cosmetics?.badges || []
    for (const p of paints) {
      cosmeticObjectCache.set(p.id, p)
      if (p.id === ids.paintId) result.paint = p
    }
    for (const b of badges) {
      cosmeticObjectCache.set(b.id, b)
      if (b.id === ids.badgeId) result.badge = b
    }
    // Cap cache
    if (cosmeticObjectCache.size > 200) {
      let count = 0
      for (const key of cosmeticObjectCache.keys()) {
        if (count++ >= 50) break
        cosmeticObjectCache.delete(key)
      }
    }
  } catch (e) {
    log(' resolve7TVCosmeticIds failed:', e?.message)
  }
  return result
}

let cosmeticsSaveTimer = null
let cosmeticsLastFlushAt = 0
const COSMETICS_STORAGE_MAX = USER_COSMETICS_MAX // match in-memory cap so eviction doesn't lose data
const COSMETICS_FORCE_FLUSH_INTERVAL = 30000 // when at-cap, flush at most every 30s

function flushCosmeticsToStorage() {
  cosmeticsLastFlushAt = Date.now()
  const entries = [...userCosmeticsCache.entries()]
    // Persist only positive results — never negatives. A blank entry that
    // survives a restart re-serves "no cosmetics" for users who actually have
    // them; they're cheap to recheck, so let restart re-resolve them fresh.
    .filter(([, v]) => (v.paint || v.badge) && Date.now() - v.fetchedAt < USER_COSMETICS_TTL)
    .slice(-COSMETICS_STORAGE_MAX)
  browser.storage.local
    .set({
      // Persist twitchId so Kick→Twitch ID linkage survives SW restart;
      // otherwise BTTV/FFZ badge lookup falls back to no-op until the 30min
      // TTL forces a refetch from 7TV.
      user_cosmetics_cache: entries.map(([k, v]) => [
        k,
        { paint: v.paint, badge: v.badge, twitchId: v.twitchId, fetchedAt: v.fetchedAt },
      ]),
    })
    .catch(() => {})
}

function debounceSaveCosmetics() {
  if (cosmeticsSaveTimer) clearTimeout(cosmeticsSaveTimer)
  cosmeticsSaveTimer = setTimeout(() => {
    cosmeticsSaveTimer = null
    flushCosmeticsToStorage()
  }, 5000)
}

function setUserCosmetic(twitchId, cosmetic) {
  if (userCosmeticsCache.size >= USER_COSMETICS_MAX) {
    userCosmeticsCache.delete(userCosmeticsCache.keys().next().value)
    // At-cap path: flush immediately (rate-limited) so eviction can't lose data
    // before the 5s debounce fires.
    if (Date.now() - cosmeticsLastFlushAt > COSMETICS_FORCE_FLUSH_INTERVAL) {
      if (cosmeticsSaveTimer) {
        clearTimeout(cosmeticsSaveTimer)
        cosmeticsSaveTimer = null
      }
      userCosmeticsCache.set(twitchId, { ...(cosmetic || { paint: null, badge: null }), fetchedAt: Date.now() })
      flushCosmeticsToStorage()
      return
    }
  }
  userCosmeticsCache.set(twitchId, { ...(cosmetic || { paint: null, badge: null }), fetchedAt: Date.now() })
  debounceSaveCosmetics()
}

function setPaintCache(twitchId, spec, color = null, plus = null, badge = null) {
  if (_paintsCache.size >= PAINTS_CACHE_MAX) {
    _paintsCache.delete(_paintsCache.keys().next().value)
  }
  // color = the user's picked name colour (users.color); plus = their ISO
  // plus_since (active HeatSync Plus tenure) — both ride the same
  // /api/paints response, cached alongside the spec so the fetch_paints reply
  // can return parallel colors/plus maps without a second request/inflight chain.
  // badge = the one heatsync badge id they show (rides the same response too)
  _paintsCache.set(twitchId, {
    spec: spec ?? null,
    color: color ?? null,
    plus: plus ?? null,
    badge: badge ?? null,
    fetchedAt: Date.now(),
  })
}

async function fetchBulkBadges() {
  const mapsPopulated = ffzBadgeList.length > 0 || bttvBadgeMap.size > 0 || chatterinoBadgeList.length > 0
  if (mapsPopulated && Date.now() - badgesFetchedAt < BADGES_TTL) return
  badgesFetchedAt = Date.now()
  try {
    const [bttvResp, ffzResp, chatterinoResp] = await Promise.allSettled([
      fetchWithTimeout('https://api.betterttv.net/3/cached/badges'),
      fetchWithTimeout('https://api.frankerfacez.com/v1/badges/ids'),
      fetchWithTimeout('https://heatsync.org/api/chatterino-badges'),
    ])
    if (bttvResp.status === 'fulfilled' && bttvResp.value.ok) {
      const data = await bttvResp.value.json()
      bttvBadgeMap.clear()
      for (const entry of data) {
        let url = entry.badge?.svg || entry.badge?.png
        if (url && !url.startsWith('https://')) url = url.startsWith('//') ? `https:${url}` : null
        if (entry.providerId && url) {
          bttvBadgeMap.set(entry.providerId, { description: entry.badge.description || 'BTTV', url })
        }
      }
      log(' BTTV badges loaded:', bttvBadgeMap.size)
    }
    if (ffzResp.status === 'fulfilled' && ffzResp.value.ok) {
      const data = await ffzResp.value.json()
      const badgeById = {}
      for (const b of data.badges || []) badgeById[b.id] = b
      const list = []
      for (const [badgeId, userIds] of Object.entries(data.users || {})) {
        const badge = badgeById[badgeId]
        if (!badge || !Array.isArray(userIds)) continue
        const url = badge.urls?.['2'] || badge.urls?.['1'] || badge.urls?.['4']
        if (!url) continue
        const normalizedUrl = url.startsWith('//') ? `https:${url}` : url
        if (!/^https:\/\//.test(normalizedUrl)) continue
        list.push({ title: badge.title || 'FFZ', color: badge.color || null, url: normalizedUrl, ids: userIds })
      }
      ffzBadgeList = list
      log(' FFZ badges loaded:', list.length, 'badges')
    }
    if (chatterinoResp.status === 'fulfilled' && chatterinoResp.value.ok) {
      const data = await chatterinoResp.value.json()
      const list = []
      for (const badge of data.badges || []) {
        const url = badge.image2 || badge.image1
        if (!url || !Array.isArray(badge.users) || !/^https:\/\//.test(url)) continue
        list.push({ tooltip: badge.tooltip || 'Chatterino', url, ids: badge.users })
      }
      chatterinoBadgeList = list
      log(' Chatterino badges loaded:', list.length, 'badges')
    }
    broadcastBadgeMaps()
    // Persist badge maps + timestamp so they survive MV3 service worker restarts
    const bttvObj = {}
    for (const [k, v] of bttvBadgeMap) bttvObj[k] = v
    browser.storage.local
      .set({
        badges_fetched_at: badgesFetchedAt,
        bttv_badge_map: bttvObj,
        ffz_badges: ffzBadgeList,
        chatterino_badges: chatterinoBadgeList,
      })
      .catch(() => {})
  } catch (e) {
    log(' fetchBulkBadges failed:', e.message)
    badgesFetchedAt = 0
  }
}

function badgeMapsPayload() {
  const bttvObj = {}
  for (const [k, v] of bttvBadgeMap) bttvObj[k] = v
  return { bttvBadges: bttvObj, ffzBadges: ffzBadgeList, chatterinoBadges: chatterinoBadgeList }
}

function broadcastBadgeMaps() {
  broadcastToTabs({ type: 'cosmetics_update', ...badgeMapsPayload() })
}

// The channel's 7tv/bttv/ffz sets come straight from the providers, so they
// carry none of what heatsync's own scan knows (weapons, drugs, gore, hate, and
// its sexual verdicts beyond 7tv's flag). The site's public, edge-cached
// /api/channel/:c/emotes answers exactly that per emote as `cw_cats`; stamp it
// on by (provider, name) so the render gate can hide the category the viewer
// turned off. Best effort by design: a failed lookup leaves the sets exactly as
// the providers sent them — it never costs a channel its emotes.
async function stampThirdPartyFlags(emotes, channelName, platform) {
  if (platform !== 'twitch' && platform !== 'kick') return
  try {
    const q = platform === 'kick' ? '?platform=kick' : ''
    const r = await fetchWithTimeout(`${API_URL}/api/channel/${encodeURIComponent(channelName)}/emotes${q}`, {
      credentials: 'omit',
      noBackoff: true,
    })
    if (!r.ok) return
    const body = await r.json()
    const flagged = new Map()
    for (const e of body?.emotes || []) {
      if (Array.isArray(e?.cw_cats) && e.cw_cats.length) flagged.set(`${e.provider}:${e.name}`, e.cw_cats)
    }
    if (!flagged.size) return
    for (const e of emotes) {
      const cats = e && flagged.get(`${e.source}:${e.name}`)
      if (cats) e.cw_cats = cats
    }
  } catch (err) {
    log(' ⚠️ third-party emote flags unavailable for', channelName, err?.message || err)
  }
}
