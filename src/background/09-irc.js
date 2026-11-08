// background part 9 of 11 — the background irc leg.
// build.js concatenates src/background/* in BG_PARTS order into background.js (the service worker cannot import);
// one scope, so a later part may read an earlier part's constants, never the reverse.

// ============================================================================
// BG TWITCH IRC READER — reload-safe connection
// ============================================================================
// Owns the read-only Twitch IRC connection. Survives content tab reloads —
// the WebSocket lives in the SW, persists across page navigations, and
// serves history instantly. Per-tab auth-irc.js still handles SENDING.
//
// Message flow:
//   tab → 'bg_irc_join' / 'bg_irc_part'      (channel subscription)
//   tab → 'bg_irc_history' (req)             (instant buffer hand-off)
//   bg  → 'bg_irc_msg' (broadcast)           (live + history backfill events)
//   bg  → 'bg_irc_history_merged' (broadcast) (robotty filled in late msgs)

const BG_IRC_PERSIST_MAX = 3000
const BG_IRC_PERSIST_DEBOUNCE_MS = 1500
const BG_IRC_COLOR_RE = /^#[0-9a-fA-F]{3,6}$/
// Bump whenever IRC parser semantics change. bgIrcRestoreFromStorage wipes
// hs_irc_* cached buffers + lastRobottyAt so robotty refetches everything
// through the new parser. v3: BG USERNOTICE parser now extracts tags.emotes,
// promotes viewermilestone+watch-streak → 'watchstreak' msgId, and carries
// streakCount — mirrors the content-script parser.
const BG_IRC_PARSER_VERSION = 3

function bgIrcSanitizeColor(c) {
  if (!c) return '#fff'
  return BG_IRC_COLOR_RE.test(c) ? c : '#fff'
}

function bgIrcParseEmotesTag(emotesTag, text) {
  if (!emotesTag) return null
  // Twitch positions count code points; slice counts UTF-16 units. Parity
  // copy of src/multichat/irc.js parseTwitchEmotesTag — keep in sync.
  const cps = /[\uD800-\uDFFF]/.test(text) ? Array.from(text) : null
  const out = {}
  for (const part of emotesTag.split('/')) {
    const [emoteId, posStr] = part.split(':')
    if (!emoteId || !posStr) continue
    const firstPos = posStr.split(',')[0]
    const [start, end] = firstPos.split('-').map(Number)
    if (Number.isNaN(start) || Number.isNaN(end)) continue
    const name = cps ? cps.slice(start, end + 1).join('') : text.slice(start, end + 1)
    if (name && !out[name]) {
      out[name] = `https://static-cdn.jtvnw.net/emoticons/v2/${emoteId}/default/dark/2.0`
    }
  }
  return Object.keys(out).length > 0 ? out : null
}

function bgIrcParseTags(tagStr) {
  const tags = {}
  for (const part of tagStr.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) {
      tags[part] = ''
      continue
    }
    tags[part.slice(0, eq)] = part.slice(eq + 1) || ''
  }
  return tags
}

// IRCv3 tag-value unescape: \s→space, \:→";", \\→"\", \r→CR, \n→LF.
// Tag values are backslash-escaped, NOT percent-encoded — decodeURIComponent
// throws URIError on any bare '%' (e.g. "im 100% sure") and silently corrupts
// valid-looking sequences like '%20'.
function bgIrcTagUnescape(v) {
  if (!v || v.indexOf('\\') === -1) return v
  let out = ''
  for (let i = 0; i < v.length; i++) {
    const c = v[i]
    if (c !== '\\') {
      out += c
      continue
    }
    const n = v[++i]
    if (n === 's') out += ' '
    else if (n === ':') out += ';'
    else if (n === '\\') out += '\\'
    else if (n === 'r') out += '\r'
    else if (n === 'n') out += '\n'
    else if (n !== undefined) out += n
  }
  return out
}

function bgIrcParseLine(raw, channelHint) {
  try {
    const tagsMatch = raw.match(/^@([^ ]+)/)
    if (!tagsMatch) return null
    const tags = bgIrcParseTags(tagsMatch[1])

    const privmsg = raw.match(/PRIVMSG #([^ ]+) :(.+)$/)
    if (privmsg) {
      const displayName = tags['display-name'] || 'anonymous'
      // Extract IRC source login (correct for unicode display names where
      // display.toLowerCase() ≠ login). Format: :user!user@user.tmi.twitch.tv
      const loginMatch = raw.match(/^@[^ ]+ :([^!]+)!/)
      const login = loginMatch ? loginMatch[1] : ''
      let text = privmsg[2]
      let isAction = false
      if (text.charCodeAt(0) === 1 && text.startsWith('\x01ACTION ')) {
        text = text.slice(8, text.endsWith('\x01') ? -1 : undefined)
        isAction = true
      }
      const msg = {
        user: displayName,
        login,
        userId: tags['user-id'] || '',
        text,
        color: bgIrcSanitizeColor(tags.color || '#fff'),
        badges: tags.badges || '',
        channel: channelHint || privmsg[1].toLowerCase(),
        time: parseInt(tags['tmi-sent-ts'], 10) || parseInt(tags['rm-received-ts'], 10) || Date.now(),
        id: tags.id || '',
        // display-name can be absent on replayed/relayed copies while the login
        // is not — key the bar on either so the reply never degrades to plain.
        replyTo:
          tags['reply-parent-display-name'] || tags['reply-parent-user-login']
            ? {
                user: bgIrcTagUnescape(tags['reply-parent-display-name'] || tags['reply-parent-user-login']),
                text: tags['reply-parent-msg-body'] ? bgIrcTagUnescape(tags['reply-parent-msg-body']) : '',
                id: tags['reply-parent-msg-id'] || '',
                // Twitch-resolved id — lets the multichat renderer paint the reply
                // target with their own cosmetic synchronously, without waiting on
                // the async name→uid resolve (see src/multichat/irc.js's parseIrcLine,
                // which already carries this; this copy had drifted from it).
                userId: tags['reply-parent-user-id'] || '',
                threadId: tags['reply-thread-parent-msg-id'] || tags['reply-parent-msg-id'] || '',
              }
            : null,
      }
      const twitchEmotes = bgIrcParseEmotesTag(tags.emotes, text)
      if (twitchEmotes) msg.twitchEmotes = twitchEmotes
      if (isAction) msg.isAction = true
      const bits = parseInt(tags.bits, 10) || 0
      if (bits > 0) msg.bits = bits
      if (tags['custom-reward-id']) {
        msg.redeemed = true
        msg.rewardId = tags['custom-reward-id']
      }
      if (tags['msg-id'] === 'highlighted-message') msg.isHighlighted = true
      if (tags['first-msg'] === '1') msg.isFirstMsg = true
      const badgeInfo = tags['badge-info']
      if (badgeInfo) {
        const subMatch = badgeInfo.match(/subscriber\/(\d+)/)
        if (subMatch) msg.subMonths = parseInt(subMatch[1], 10)
      }
      return msg
    }

    const usernotice = raw.match(/USERNOTICE #([^ ]+)(?: :(.+))?$/)
    if (usernotice) {
      const displayName = tags['display-name'] || 'system'
      const subPlan = tags['msg-param-sub-plan'] || ''
      const tier =
        subPlan === '2000' ? '2' : subPlan === '3000' ? '3' : subPlan === 'Prime' ? 'prime' : subPlan ? '1' : ''
      const months = parseInt(tags['msg-param-cumulative-months'], 10) || parseInt(tags['msg-param-months'], 10) || 0
      const giftCount = parseInt(tags['msg-param-mass-gift-count'], 10) || 0
      const recipient = tags['msg-param-recipient-display-name']
        ? bgIrcTagUnescape(tags['msg-param-recipient-display-name'])
        : ''
      const raidViewers = parseInt(tags['msg-param-viewerCount'], 10) || 0
      const raidFrom = tags['msg-param-displayName'] ? bgIrcTagUnescape(tags['msg-param-displayName']) : ''
      const announceColor = tags['msg-param-color'] || ''
      const bitsTier = parseInt(tags['msg-param-threshold'], 10) || 0
      const category = tags['msg-param-category'] || ''
      const rawMsgId = tags['msg-id'] || ''
      const msgId = rawMsgId === 'viewermilestone' && category === 'watch-streak' ? 'watchstreak' : rawMsgId
      const streakCount = msgId === 'watchstreak' ? parseInt(tags['msg-param-value'], 10) || 0 : 0
      const userText = usernotice[2] || ''
      const twitchEmotes = bgIrcParseEmotesTag(tags.emotes, userText)
      return {
        user: displayName,
        text: userText,
        systemMsg: bgIrcTagUnescape(tags['system-msg'] || ''),
        color: bgIrcSanitizeColor(tags.color || '#fff'),
        badges: tags.badges || '',
        channel: channelHint || usernotice[1].toLowerCase(),
        time: parseInt(tags['tmi-sent-ts'], 10) || parseInt(tags['rm-received-ts'], 10) || Date.now(),
        type: 'usernotice',
        msgId,
        subTier: tier,
        subMonths: months,
        giftCount,
        recipient,
        raidViewers,
        raidFrom,
        announceColor,
        bitsTier,
        streakCount,
        twitchEmotes: twitchEmotes || undefined,
        id: tags.id || '',
      }
    }

    const notice = raw.match(/NOTICE #([^ ]+) :(.+)$/)
    if (notice) {
      const ch = channelHint || notice[1].toLowerCase()
      const time = parseInt(tags['tmi-sent-ts'], 10) || parseInt(tags['rm-received-ts'], 10) || Date.now()
      const noticeType = tags['msg-id'] || ''
      const detId = `notice-${ch}-${time}-${notice[2].slice(0, 64)}`
      return {
        type: 'notice',
        noticeType,
        user: 'system',
        text: notice[2],
        color: '#ffffff',
        badges: '',
        channel: ch,
        time,
        id: tags.id || detId,
        systemMsg: notice[2],
      }
    }

    const roomstate = raw.match(/ROOMSTATE #([^ ]+)/)
    if (roomstate) {
      const ch = channelHint || roomstate[1].toLowerCase()
      return {
        type: 'roomstate',
        channel: ch,
        time: Date.now(),
        slow: tags.slow != null ? parseInt(tags.slow, 10) : null,
        subsOnly: tags['subs-only'] != null ? tags['subs-only'] === '1' : null,
        emoteOnly: tags['emote-only'] != null ? tags['emote-only'] === '1' : null,
        followersOnly: tags['followers-only'] != null ? parseInt(tags['followers-only'], 10) : null,
        r9k: tags.r9k != null ? tags.r9k === '1' : null,
      }
    }

    const userstate = raw.match(/USERSTATE #([^ ]+)/)
    if (userstate) {
      const ch = channelHint || userstate[1].toLowerCase()
      const badgeNames = []
      for (const part of (tags.badges || '').split(',')) {
        const name = part.split('/')[0]
        if (name) badgeNames.push(name)
      }
      // rawBadges keeps tier suffixes (`subscriber/40`) for our synthetic
      // celebrations to stamp the right sub badge before the user has sent
      // a message on this channel. badges Set drops tiers, used elsewhere
      // for membership gating.
      return { type: 'userstate', channel: ch, badges: badgeNames, rawBadges: tags.badges || '', time: Date.now() }
    }

    const clearchat = raw.match(/CLEARCHAT #([^ ]+)(?: :(.+))?$/)
    if (clearchat) {
      const target = clearchat[2] || ''
      const duration = tags['ban-duration']
      const text = target
        ? duration
          ? `${target} timed out for ${duration}s`
          : `${target} was permanently banned`
        : 'chat cleared'
      const ch = channelHint || clearchat[1].toLowerCase()
      const time = parseInt(tags['tmi-sent-ts'], 10) || parseInt(tags['rm-received-ts'], 10) || Date.now()
      const detId = `clearchat-${ch}-${target}-${duration || 'perma'}-${time}`
      return {
        type: 'notice',
        noticeType: duration ? 'timeout_success' : 'ban_success',
        user: 'system',
        text,
        color: '#ffffff',
        badges: '',
        channel: ch,
        time,
        id: tags.id || detId,
        systemMsg: text,
        targetUser: target,
        targetUserId: tags['target-user-id'] || '',
        banDuration: duration ? parseInt(duration, 10) : 0,
      }
    }

    const clearmsg = raw.match(/CLEARMSG #([^ ]+) :(.+)$/)
    if (clearmsg) {
      const targetMsgId = tags['target-msg-id']
      const text = `${tags.login || 'unknown'}'s message was deleted`
      return {
        type: 'notice',
        noticeType: 'delete_message_success',
        user: 'system',
        text,
        color: '#ffffff',
        badges: '',
        channel: channelHint || clearmsg[1].toLowerCase(),
        time: parseInt(tags['tmi-sent-ts'], 10) || parseInt(tags['rm-received-ts'], 10) || Date.now(),
        id: targetMsgId || `clearmsg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        systemMsg: text,
        targetUser: tags.login || '',
        targetMsgId: targetMsgId || '',
      }
    }

    return null
  } catch (_e) {
    return null
  }
}

class BGCircularBuffer {
  constructor(cap = BG_IRC_PERSIST_MAX) {
    this.buf = new Array(cap)
    this.cap = cap
    this.head = 0
    this.size = 0
  }
  push(item) {
    this.buf[this.head] = item
    this.head = (this.head + 1) % this.cap
    if (this.size < this.cap) this.size++
  }
  getAll() {
    if (this.size === 0) return []
    if (this.size < this.cap) return this.buf.slice(0, this.size)
    return this.buf.slice(this.head).concat(this.buf.slice(0, this.head))
  }
  clear() {
    this.buf = new Array(this.cap)
    this.head = 0
    this.size = 0
  }
}

const BG_IRC = {
  ws: null,
  partial: '',
  nick: `justinfan${Math.floor(Math.random() * 99999)}`,
  // Authed-reader upgrade: twitch periodically starves anonymous (justinfan)
  // IRC connections (ecosystem-wide anti-scrape throttling — history loads
  // via robotty but live delivery trickles). When a twitch tab hands us the
  // user's chat token we reconnect the reader authenticated; auth failure
  // falls straight back to anonymous, never worse than today.
  authToken: null,
  authNick: null,
  authFailed: false,
  authFailedAt: 0,
  channels: new Map(), // ch -> BGCircularBuffer
  tabInterest: new Map(), // tabId -> Set<channel>
  channelTabs: new Map(), // channel -> Set<tabId>
  lastData: 0,
  destroyed: false,
  idleClosed: false, // reader parked by scheduleWsIdleCheck (no platform tabs)
  reconnectTimer: null,
  reconnectAttempts: 0,
  heartbeatTimer: null,
  connectTimeout: null,
  chanLastSeen: new Map(),
  chanRejoinAttempts: new Map(),
  // channels twitch answered "does not exist or has been suspended" / blocked: a
  // refusal is not traffic, so they stay out of the silence watchdog and say so once
  deadChannels: new Set(),
  roomstates: new Map(),
  historyInFlight: new Map(), // ch -> Promise<void> (awaitable in-flight robotty fetch)
  lastRobottyAt: new Map(), // ch -> ts (last successful/attempted robotty fetch)
  persistTimers: new Map(),
  releaseTimers: new Map(), // ch -> timeout (bgIrcScheduleRelease)
  joining: new Map(), // ch -> Promise (bg_irc_join reading the persisted ring)
  storageRestored: false,
  // Tabs that have requested live broadcasts. Empty initially — we don't
  // broadcast until at least one tab has joined a channel, so a freshly
  // installed extension with no chat tabs open isn't running for nothing.
  liveTabs: new Set(),
}

async function bgIrcRestoreFromStorage() {
  if (BG_IRC.storageRestored) return
  BG_IRC.storageRestored = true
  // authed-reader creds survive SW restarts (session storage; cleared when
  // the browser closes — the next twitch tab re-supplies them)
  try {
    const sess = await browser.storage.session?.get?.('hs_irc_auth')
    const a = sess?.hs_irc_auth
    if (a?.token && a?.nick && !BG_IRC.authToken) {
      BG_IRC.authToken = a.token
      BG_IRC.authNick = a.nick
    }
  } catch {}
  try {
    const all = await browser.storage.local.get(null)
    const storedVer = all.hs_irc_parser_version | 0
    if (storedVer !== BG_IRC_PARSER_VERSION) {
      const stale = Object.keys(all).filter(
        (k) => k.startsWith('hs_irc_') && !k.startsWith('hs_irc_sync_') && k !== 'hs_irc_parser_version',
      )
      if (stale.length) await browser.storage.local.remove(stale).catch(() => {})
      await browser.storage.local.set({ hs_irc_parser_version: BG_IRC_PARSER_VERSION }).catch(() => {})
      await browser.storage.session?.remove?.('hs_irc_last_robotty').catch?.(() => {})
      log(
        'BG IRC parser version bump',
        storedVer,
        '→',
        BG_IRC_PARSER_VERSION,
        '— wiped',
        stale.length,
        'cached channel buffers',
      )
      return
    }
    // Purge only. Buffers are read one channel at a time on join
    // (bgIrcReadPersisted): restoring every ring here put every channel
    // watched in the last day back in RAM and JOINed on each SW wake.
    const expired = []
    for (const [k, v] of Object.entries(all)) {
      if (!k.startsWith('hs_irc_') || k.startsWith('hs_irc_sync_') || k === 'hs_irc_parser_version') continue
      const ch = k.slice('hs_irc_'.length)
      // A key written before channel sanitization existed could carry protocol
      // characters straight back into the JOIN loop on restore — drop any key
      // whose channel isn't already in canonical form instead of trusting it.
      if (ch !== bgIrcSafeChannel(ch)) {
        expired.push(k)
        continue
      }
      // Missing/invalid ts counts as stale — unknown-age data fails safe.
      if (!ch || !v?.msgs?.length || !(Date.now() - (v.ts || 0) < 86400000)) {
        // Skipped buffers were previously left in storage forever — every
        // channel ever watched kept its full ring in storage.local unbounded.
        expired.push(k)
      }
    }
    if (expired.length) await browser.storage.local.remove(expired).catch(() => {})
    if (expired.length) log('BG IRC purged', expired.length, 'stale channel buffers')
  } catch (e) {
    log('BG IRC restore failed:', e.message)
  }
  // Restore lastRobottyAt from session storage — survives SW eviction within
  // the same browser session. Without this, every SW wake refetched robotty
  // for every joined channel, hammering a community-run free service.
  try {
    const sess = await browser.storage.session?.get?.('hs_irc_last_robotty')
    const obj = sess?.hs_irc_last_robotty
    if (obj && typeof obj === 'object') {
      for (const [ch, ts] of Object.entries(obj)) {
        if (typeof ts === 'number') BG_IRC.lastRobottyAt.set(ch, ts)
      }
    }
  } catch {}
}

const ROBOTTY_PERSIST_DEBOUNCE_MS = 2000
const ROBOTTY_TS_MAX_CHANNELS = 200
const COOLDOWN_TS_MAX_CHANNELS = 200
const MAX_BG_IRC_CHANNELS = 100
const MAX_BG_KICK_CHANNELS = 50
const MAX_BG_YT_CHANNELS = 30

function pruneMap(map, max) {
  if (map.size <= max) return
  const excess = map.size - max
  const it = map.keys()
  for (let i = 0; i < excess; i++) map.delete(it.next().value)
}
let _robottyPersistTimer = null
function bgIrcPersistRobottyTs() {
  if (_robottyPersistTimer) return
  _robottyPersistTimer = setTimeout(() => {
    _robottyPersistTimer = null
    try {
      // Cap entries — long-running SW with channel churn shouldn't grow forever.
      if (BG_IRC.lastRobottyAt.size > ROBOTTY_TS_MAX_CHANNELS) {
        const excess = BG_IRC.lastRobottyAt.size - ROBOTTY_TS_MAX_CHANNELS
        const it = BG_IRC.lastRobottyAt.keys()
        for (let i = 0; i < excess; i++) BG_IRC.lastRobottyAt.delete(it.next().value)
      }
      const obj = Object.fromEntries(BG_IRC.lastRobottyAt)
      chrome.storage.session?.set?.({ hs_irc_last_robotty: obj })?.catch?.(() => {})
    } catch {}
  }, ROBOTTY_PERSIST_DEBOUNCE_MS)
}

function bgIrcPersistChannel(ch) {
  if (BG_IRC.persistTimers.has(ch)) return
  BG_IRC.persistTimers.set(
    ch,
    setTimeout(() => {
      BG_IRC.persistTimers.delete(ch)
      try {
        const buf = BG_IRC.channels.get(ch)
        if (!buf) return
        const msgs = buf.getAll()
        browser.storage.local.set({ [`hs_irc_${ch}`]: { msgs, ts: Date.now() } }).catch(() => {})
      } catch {}
    }, BG_IRC_PERSIST_DEBOUNCE_MS),
  )
}

// One channel's persisted ring (≤24h old), for its first join after a SW
// wake or a release — so a reopened channel still paints history instantly.
async function bgIrcReadPersisted(ch) {
  const key = `hs_irc_${ch}`
  let v = null
  try {
    v = (await browser.storage.local.get(key))[key]
  } catch {}
  if (!v?.msgs?.length || !(Date.now() - (v.ts || 0) < 86400000)) return null
  const buf = new BGCircularBuffer(BG_IRC_PERSIST_MAX)
  // Purge non-renderable types from legacy persisted buffers. Earlier
  // backfill paths pushed ROOMSTATE/USERSTATE/WHISPER into the ring;
  // they fill 500-msg toRender slots with null divs → chat appears empty.
  for (const m of v.msgs) {
    if (m?.type === 'roomstate' || m?.type === 'userstate' || m?.type === 'whisper') continue
    buf.push(m)
  }
  return buf
}

// A channel no tab wants any more is let go: PARTed, its ring flushed to disk
// (bgIrcReadPersisted hydrates a reopen) and dropped from RAM. Dropping only
// the interest used to leave the 3000-msg ring JOINed, persisting every 1.5s
// and re-JOINed on every reconnect — the SW carried every channel watched
// that day. The grace absorbs reloads and channel hops that part, then join.
const BG_IRC_RELEASE_GRACE_MS = 60_000

function bgIrcScheduleRelease(ch) {
  if (BG_IRC.releaseTimers.has(ch)) return
  BG_IRC.releaseTimers.set(
    ch,
    setTimeout(() => bgIrcReleaseChannel(ch), BG_IRC_RELEASE_GRACE_MS),
  )
}

function bgIrcCancelRelease(ch) {
  const t = BG_IRC.releaseTimers.get(ch)
  if (!t) return
  clearTimeout(t)
  BG_IRC.releaseTimers.delete(ch)
}

function bgIrcReleaseChannel(ch) {
  BG_IRC.releaseTimers.delete(ch)
  if (BG_IRC.channelTabs.get(ch)?.size) return
  const buf = BG_IRC.channels.get(ch)
  if (!buf) return
  const pending = BG_IRC.persistTimers.get(ch)
  if (pending) {
    clearTimeout(pending)
    BG_IRC.persistTimers.delete(ch)
  }
  const msgs = buf.getAll()
  if (msgs.length) browser.storage.local.set({ [`hs_irc_${ch}`]: { msgs, ts: Date.now() } }).catch(() => {})
  BG_IRC.channels.delete(ch)
  BG_IRC.chanLastSeen.delete(ch)
  BG_IRC.chanRejoinAttempts.delete(ch)
  BG_IRC.deadChannels.delete(ch)
  BG_IRC.roomstates.delete(ch)
  if (BG_IRC.ws?.readyState === WebSocket.OPEN) {
    try {
      BG_IRC.ws.send(`PART #${ch}\r\n`)
    } catch {}
  }
  try {
    wsSend({ type: 'irc:part', channel: ch })
  } catch {}
  log('BG IRC released', ch)
}

// The command of a line twitch's server sent itself (`:tmi.twitch.tv <CMD> …`,
// tags first or not), or null for anything a user said or a relayed message.
function bgIrcServerCommand(line) {
  let rest = line
  if (rest.startsWith('@')) {
    const sp = rest.indexOf(' ')
    if (sp < 0) return null
    rest = rest.slice(sp + 1)
  }
  if (!rest.startsWith(':tmi.twitch.tv ')) return null
  const cmd = rest.slice(':tmi.twitch.tv '.length).split(' ', 1)[0]
  return cmd || null
}

function bgIrcConnect() {
  if (BG_IRC.destroyed) return
  BG_IRC.idleClosed = false // any explicit connect un-parks the reader
  if (BG_IRC.ws && BG_IRC.ws.readyState === WebSocket.CONNECTING) return
  bgIrcStopHeartbeat()
  if (BG_IRC.reconnectTimer) {
    clearTimeout(BG_IRC.reconnectTimer)
    BG_IRC.reconnectTimer = null
  }
  if (BG_IRC.ws) {
    try {
      BG_IRC.ws.onopen = null
      BG_IRC.ws.onmessage = null
      BG_IRC.ws.onerror = null
      BG_IRC.ws.onclose = null
      BG_IRC.ws.close()
    } catch {}
    BG_IRC.ws = null
  }
  BG_IRC.partial = ''
  if (BG_IRC.connectTimeout) clearTimeout(BG_IRC.connectTimeout)
  BG_IRC.connectTimeout = setTimeout(() => {
    if (BG_IRC.ws?.readyState !== WebSocket.OPEN) {
      log('BG IRC: connect timeout')
      try {
        BG_IRC.ws?.close()
      } catch {}
    }
  }, 10000)

  BG_IRC.ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443')
  BG_IRC.ws.onopen = () => {
    clearTimeout(BG_IRC.connectTimeout)
    log('BG IRC: connected')
    BG_IRC.reconnectAttempts = 0
    BG_IRC.lastData = Date.now()
    const now = Date.now()
    for (const ch of BG_IRC.channels.keys()) BG_IRC.chanLastSeen.set(ch, now)
    BG_IRC.chanRejoinAttempts.clear()
    // transient login failures un-stick after 30min (token may have healed)
    if (BG_IRC.authFailed && Date.now() - (BG_IRC.authFailedAt || 0) > 30 * 60_000) BG_IRC.authFailed = false
    if (BG_IRC.authToken && BG_IRC.authNick && !BG_IRC.authFailed) {
      BG_IRC.ws.send(`PASS oauth:${BG_IRC.authToken}\r\n`)
      BG_IRC.ws.send(`NICK ${BG_IRC.authNick}\r\n`)
      log('BG IRC: authed as', BG_IRC.authNick)
    } else {
      BG_IRC.ws.send(`NICK ${BG_IRC.nick}\r\n`)
    }
    BG_IRC.ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands\r\n')
    for (const ch of BG_IRC.channels.keys()) {
      if (BG_IRC.ws.readyState !== WebSocket.OPEN) return
      BG_IRC.ws.send(`JOIN #${ch}\r\n`)
    }
    bgIrcStartHeartbeat()
    // Gap-fill: SW eviction + WS dropout can lose minutes of chat. On every
    // (re)connect, refetch robotty for each channel to backfill the gap.
    // 60s per-channel cooldown keeps us polite during flappy reconnects;
    // historyInFlight prevents concurrent fetches when ensureChannel races.
    const reconnectGapMs = 60_000
    const now2 = Date.now()
    for (const ch of BG_IRC.channels.keys()) {
      const last = BG_IRC.lastRobottyAt.get(ch) || 0
      if (now2 - last < reconnectGapMs) continue
      bgIrcFetchRobotty(ch)
    }
  }
  BG_IRC.ws.onmessage = (e) => bgIrcOnData(e.data)
  BG_IRC.ws.onerror = () => {
    clearTimeout(BG_IRC.connectTimeout)
  }
  BG_IRC.ws.onclose = () => {
    clearTimeout(BG_IRC.connectTimeout)
    bgIrcStopHeartbeat()
    if (BG_IRC.destroyed) return
    bgIrcScheduleReconnect()
  }
}

function bgIrcScheduleReconnect() {
  if (BG_IRC.destroyed) return
  if (BG_IRC.reconnectTimer) clearTimeout(BG_IRC.reconnectTimer)
  const base = Math.min(2000 * 2 ** BG_IRC.reconnectAttempts, 15000)
  const delay = base + Math.random() * 2000
  BG_IRC.reconnectAttempts++
  log('BG IRC: reconnect in', Math.round(delay), 'ms (attempt', BG_IRC.reconnectAttempts, ')')
  BG_IRC.reconnectTimer = setTimeout(() => {
    if (!BG_IRC.destroyed) bgIrcConnect()
  }, delay)
}

function bgIrcForceReconnect() {
  bgIrcStopHeartbeat()
  if (BG_IRC.ws) {
    try {
      BG_IRC.ws.onclose = null
      BG_IRC.ws.close()
    } catch {}
    BG_IRC.ws = null
  }
  if (!BG_IRC.destroyed) bgIrcConnect()
}

// Park the reader when the last platform tab closes (scheduleWsIdleCheck).
// Its 20s heartbeat otherwise extends the SW lifetime forever (Chrome 116+
// WS-activity rule), pinning every BG buffer in RAM for a user who isn't on
// any chat site. Buffers are already debounce-persisted per message, so the
// reopen path (idle-check else-branch / bg_irc_join) loses nothing.
function bgIrcIdleClose() {
  BG_IRC.idleClosed = true
  bgIrcStopHeartbeat()
  if (BG_IRC.reconnectTimer) {
    clearTimeout(BG_IRC.reconnectTimer)
    BG_IRC.reconnectTimer = null
  }
  if (BG_IRC.connectTimeout) clearTimeout(BG_IRC.connectTimeout)
  if (BG_IRC.ws) {
    try {
      BG_IRC.ws.onopen = null
      BG_IRC.ws.onmessage = null
      BG_IRC.ws.onerror = null
      BG_IRC.ws.onclose = null
      BG_IRC.ws.close()
    } catch {}
    BG_IRC.ws = null
  }
}

function bgIrcStartHeartbeat() {
  bgIrcStopHeartbeat()
  BG_IRC.heartbeatTimer = trackInterval(
    setInterval(() => {
      if (!BG_IRC.ws || BG_IRC.ws.readyState !== WebSocket.OPEN) {
        bgIrcStopHeartbeat()
        if (!BG_IRC.destroyed) bgIrcScheduleReconnect()
        return
      }
      const now = Date.now()
      const silence = now - BG_IRC.lastData
      if (silence > 90000) {
        log('BG IRC: zombie detected —', Math.round(silence / 1000), 's silence')
        bgIrcForceReconnect()
        return
      }
      try {
        BG_IRC.ws.send('PING :heatsync\r\n')
      } catch {
        bgIrcForceReconnect()
        return
      }
      // Per-channel watchdog
      for (const ch of BG_IRC.channels.keys()) {
        const last = BG_IRC.chanLastSeen.get(ch) || 0
        if (!last || BG_IRC.deadChannels.has(ch)) continue
        const chSilence = now - last
        if (chSilence < 120000) continue
        const attempts = BG_IRC.chanRejoinAttempts.get(ch) || 0
        if (attempts >= 2) {
          log('BG IRC: channel', ch, 'unresponsive — full reconnect')
          BG_IRC.chanRejoinAttempts.clear()
          bgIrcForceReconnect()
          return
        }
        log('BG IRC: channel', ch, 'silent — PART+JOIN')
        try {
          BG_IRC.ws.send(`PART #${ch}\r\n`)
          BG_IRC.ws.send(`JOIN #${ch}\r\n`)
          BG_IRC.chanLastSeen.set(ch, now)
          BG_IRC.chanRejoinAttempts.set(ch, attempts + 1)
        } catch {
          bgIrcForceReconnect()
          return
        }
      }
      // 20s interval (was 30s) — Chrome 116+ extends SW lifetime as long as any
      // WS frame in/out happens within a 30s window. 20s gives 10s safety margin.
    }, 20000),
  )
}

function bgIrcStopHeartbeat() {
  if (BG_IRC.heartbeatTimer) {
    untrackInterval(BG_IRC.heartbeatTimer)
    BG_IRC.heartbeatTimer = null
  }
}

function bgIrcOnData(data) {
  BG_IRC.lastData = Date.now()
  BG_IRC.partial += data
  if (BG_IRC.partial.length > 65536) BG_IRC.partial = ''
  const lines = BG_IRC.partial.split('\r\n')
  BG_IRC.partial = lines.pop()
  for (const line of lines) {
    if (!line) continue
    if (line.startsWith('PING')) {
      try {
        BG_IRC.ws.send('PONG :tmi.twitch.tv\r\n')
      } catch {}
      continue
    }
    // Server commands are read from the command position, never from anywhere
    // in the line: a chatter typing "RECONNECT" (the whole chat does when a
    // stream drops) used to tear the reader down and lose the rest of the frame.
    const cmd = bgIrcServerCommand(line)
    // Authed-reader login rejected (expired/revoked token) — flag and fall
    // back to anonymous so the reader is never worse than the old default.
    if (
      cmd === 'NOTICE' &&
      (line.includes('Login authentication failed') || line.includes('Improperly formatted auth'))
    ) {
      log('BG IRC: auth login failed — falling back to anonymous reader')
      BG_IRC.authFailed = true
      BG_IRC.authFailedAt = Date.now()
      bgIrcConnect()
      continue
    }
    if (line.startsWith(':tmi.twitch.tv PONG') || line.startsWith('PONG')) continue
    if (cmd === 'RECONNECT') {
      log('BG IRC: server requested RECONNECT')
      bgIrcForceReconnect()
      return
    }
    bgIrcHandleLine(line)
  }
}

// Collapse duplicate moderation notices (timeout/ban) for the same target that
// arrive across transports. A single `!vanish`/timeout reaches us from BOTH the
// direct IRC CLEARCHAT and the server EventSub fanout; the EventSub channel.ban
// path can also drop the timeout duration, surfacing a bogus "permanently
// banned" line next to the real "timed out for Ns". Each transport mints a
// different id, so id-dedupe misses these — match on (target, type, window)
// instead. First notice for a target wins within the window.
function bgIrcDupModNotice(buf, msg) {
  if (!buf || !msg || msg.type !== 'notice') return false
  if (msg.noticeType !== 'timeout_success' && msg.noticeType !== 'ban_success') return false
  const targetLc = (msg.targetUser || '').toLowerCase()
  if (!targetLc) return false
  const t = msg.time || 0
  for (const m of buf.getAll()) {
    if (m.type !== 'notice') continue
    if (m.noticeType !== 'timeout_success' && m.noticeType !== 'ban_success') continue
    if ((m.targetUser || '').toLowerCase() !== targetLc) continue
    if (Math.abs((m.time || 0) - t) > 10000) continue
    return true
  }
  return false
}

function bgIrcHandleLine(line) {
  const msg = bgIrcParseLine(line)
  if (!msg) return
  // The refusal used to count as healthy traffic: it reset the strike count, the
  // 120s silence watchdog then PART+JOINed, twitch refused again, and the chat
  // got the same notice every ~140s forever.
  if (
    msg.type === 'notice' &&
    msg.channel &&
    (msg.noticeType === 'msg_channel_suspended' || msg.noticeType === 'msg_channel_blocked')
  ) {
    BG_IRC.chanLastSeen.delete(msg.channel)
    BG_IRC.chanRejoinAttempts.delete(msg.channel)
    if (BG_IRC.deadChannels.has(msg.channel)) return
    BG_IRC.deadChannels.add(msg.channel)
  } else if (msg.channel) {
    BG_IRC.chanLastSeen.set(msg.channel, Date.now())
    // Healthy traffic clears the rejoin strike count — without this, two
    // historical lulls escalate the next quiet spell straight to a full
    // reconnect of every joined channel.
    BG_IRC.chanRejoinAttempts.delete(msg.channel)
  }

  if (msg.type === 'roomstate') {
    const prev = BG_IRC.roomstates.get(msg.channel) || {}
    const changes = []
    if (msg.slow != null && msg.slow !== prev.slow)
      changes.push(msg.slow > 0 ? `slow mode on (${msg.slow}s)` : 'slow mode off')
    if (msg.subsOnly != null && msg.subsOnly !== prev.subsOnly)
      changes.push(msg.subsOnly ? 'sub-only mode on' : 'sub-only mode off')
    if (msg.emoteOnly != null && msg.emoteOnly !== prev.emoteOnly)
      changes.push(msg.emoteOnly ? 'emote-only mode on' : 'emote-only mode off')
    if (msg.followersOnly != null && msg.followersOnly !== prev.followersOnly) {
      if (msg.followersOnly === -1) changes.push('follower-only mode off')
      else if (msg.followersOnly === 0) changes.push('follower-only mode on')
      else changes.push(`follower-only mode on (${msg.followersOnly}m)`)
    }
    if (msg.r9k != null && msg.r9k !== prev.r9k) changes.push(msg.r9k ? 'unique-chat mode on' : 'unique-chat mode off')
    const newState = { ...prev }
    for (const k of ['slow', 'subsOnly', 'emoteOnly', 'followersOnly', 'r9k']) {
      if (msg[k] != null) newState[k] = msg[k]
    }
    BG_IRC.roomstates.set(msg.channel, newState)
    if (changes.length && Object.keys(prev).length) {
      const buf = BG_IRC.channels.get(msg.channel)
      for (const text of changes) {
        const evt = {
          type: 'notice',
          noticeType: 'mode_change',
          user: 'system',
          text,
          color: '#ffffff',
          badges: '',
          channel: msg.channel,
          time: Date.now(),
          id: `mode-${msg.channel}-${Date.now()}-${text.slice(0, 16)}`,
          systemMsg: text,
        }
        if (buf) buf.push(evt)
        bgIrcPersistChannel(msg.channel)
        bgIrcBroadcast({ type: 'bg_irc_msg', msg: evt })
      }
    }
    bgIrcBroadcast({ type: 'bg_irc_msg', msg })
    return
  }

  if (msg.type === 'userstate' || msg.type === 'whisper') {
    bgIrcBroadcast({ type: 'bg_irc_msg', msg })
    return
  }

  // Apply CLEARCHAT/CLEARMSG annotations to existing buffer entries
  const buf = msg.channel ? BG_IRC.channels.get(msg.channel) : null
  // Drop a mod notice already delivered by another transport (the first wins +
  // ran the annotation/persist/broadcast below).
  if (bgIrcDupModNotice(buf, msg)) return
  if (buf && msg.type === 'notice' && (msg.noticeType === 'ban_success' || msg.noticeType === 'timeout_success')) {
    const targetLc = (msg.targetUser || '').toLowerCase()
    if (targetLc) {
      for (const m of buf.getAll()) {
        if (m.user && m.user.toLowerCase() === targetLc && !m.cleared) {
          m.cleared = true
          m.clearedReason = msg.banDuration ? `timed out (${msg.banDuration}s)` : 'banned'
        }
      }
    }
  }
  if (buf && msg.type === 'notice' && msg.noticeType === 'delete_message_success' && msg.targetMsgId) {
    const id = msg.targetMsgId
    for (const m of buf.getAll()) {
      if (m.id === id) {
        m.cleared = true
        m.clearedReason = 'deleted'
        break
      }
    }
  }

  // PRIVMSG, USERNOTICE, NOTICE → store + broadcast.
  // Plain chat with an id marks the cross-source dedupe set (server
  // irc:message fanout may deliver the same message).
  if ((!msg.type || msg.type === 'usernotice') && msg.id && bgIrcSeenLiveId(`${msg.channel}:${msg.id}`)) return
  if (buf && (!msg.type || msg.type === 'usernotice' || msg.type === 'notice')) {
    buf.push(msg)
    bgIrcPersistChannel(msg.channel)
  }
  bgIrcBroadcast({ type: 'bg_irc_msg', msg })
}

// Cross-reference CLEARCHAT/CLEARMSG notices in a buffer against PRIVMSGs
// from the same window, so banned/deleted historical messages render cleared
// instead of as normal text. Live IRC handles this on the fly in
// bgIrcHandleLine, but the robotty backfill merges everything in one shot —
// without this pass, a user's pre-ban history shows up un-struck.
function bgIrcReconcileCleared(buf) {
  if (!buf) return
  const all = buf.getAll()
  if (!all.length) return
  const byId = new Map()
  for (const m of all) {
    if (!m.id) continue
    if (m.type === 'notice' || m.type === 'usernotice') continue
    byId.set(m.id, m)
  }
  // First pass: handle delete_message_success (O(1) per via byId) and build a
  // banMap of userLc -> {reason, eventTime} for ban/timeout notices (O(n)).
  const banMap = new Map()
  for (const m of all) {
    if (m.type !== 'notice') continue
    if (m.noticeType === 'delete_message_success' && m.targetMsgId) {
      const target = byId.get(m.targetMsgId)
      if (target && !target.cleared) {
        target.cleared = true
        target.clearedReason = 'deleted'
      }
      continue
    }
    if (m.noticeType !== 'timeout_success' && m.noticeType !== 'ban_success') continue
    const targetLc = (m.targetUser || '').toLowerCase()
    if (!targetLc) continue
    const eventTime = m.time || 0
    const reason = m.banDuration ? `timed out (${m.banDuration}s)` : 'banned'
    // Keep latest eventTime — last ban/timeout wins, clearing all prior msgs
    const existing = banMap.get(targetLc)
    if (!existing || eventTime > existing.eventTime) {
      banMap.set(targetLc, { reason, eventTime })
    }
  }
  // Second pass: single linear scan to apply ban/timeout clearings (O(n)).
  if (banMap.size > 0) {
    for (const v of all) {
      if (v.cleared || v.type === 'notice' || v.type === 'usernotice' || !v.user) continue
      const entry = banMap.get(v.user.toLowerCase())
      if (entry && (v.time || 0) <= entry.eventTime) {
        v.cleared = true
        v.clearedReason = entry.reason
      }
    }
  }
}

function bgIrcFetchRobotty(ch) {
  if (BG_IRC.historyInFlight.has(ch)) return BG_IRC.historyInFlight.get(ch)
  // 30s per-channel cooldown — protects robotty + our SW from thrash on
  // rapid page reloads / channel switches. Survives SW eviction via
  // chrome.storage.session (bgIrcPersistRobottyTs). At 100k users, SW-eviction
  // waves used to refetch robotty for every joined channel — this kills that.
  const lastAt = BG_IRC.lastRobottyAt.get(ch) || 0
  if (Date.now() - lastAt < 30_000) return Promise.resolve()
  BG_IRC.lastRobottyAt.set(ch, Date.now())
  bgIrcPersistRobottyTs()
  const p = (async () => {
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 15000)
      const resp = await fetch(
        `https://heatsync.org/api/recent-messages/${ch}?limit=1000&hide_moderation_messages=false&hide_moderated_messages=false&clearchatToNotice=true`,
        { signal: ctrl.signal, credentials: 'omit' },
      )
      clearTimeout(timer)
      if (!resp.ok) return
      const data = await resp.json()
      if (!data.messages?.length) return
      const buf = BG_IRC.channels.get(ch)
      if (!buf) return
      const existing = buf.getAll()
      const existingIds = new Set(existing.filter((m) => m.id).map((m) => m.id))
      const fpKey = (m) => `${m.user}|${m.time}|${(m.text || '').slice(0, 60)}`
      const existingFp = new Set(existing.filter((m) => !m.id).map(fpKey))
      const toAdd = []
      for (const line of data.messages) {
        const msg = bgIrcParseLine(line, ch)
        if (!msg) continue
        // Non-renderable types (roomstate/userstate/whisper) belong in their
        // dedicated maps, not the chat buffer. Live path filters them; without
        // this skip the backfill paths flooded the ring with mode-toggle dupes.
        if (msg.type === 'roomstate' || msg.type === 'userstate' || msg.type === 'whisper') continue
        msg.isHistory = true
        if (msg.id && existingIds.has(msg.id)) continue
        if (!msg.id && existingFp.has(fpKey(msg))) continue
        toAdd.push(msg)
      }
      if (toAdd.length === 0) {
        // Even on a no-op merge, reconcile — a live CLEARCHAT may have landed
        // for a user whose backfilled msgs predate it; this paints them cleared.
        bgIrcReconcileCleared(buf)
        return
      }
      const all = [...existing, ...toAdd].sort((a, b) => (a.time || 0) - (b.time || 0))
      buf.clear()
      for (const m of all) buf.push(m)
      bgIrcReconcileCleared(buf)
      bgIrcPersistChannel(ch)
      bgIrcBroadcast({ type: 'bg_irc_history_merged', channel: ch, count: toAdd.length })
      log('BG IRC robotty merged', toAdd.length, 'msgs for', ch)
    } catch (e) {
      log('BG IRC robotty fetch failed for', ch, ':', e.message)
    } finally {
      BG_IRC.historyInFlight.delete(ch)
    }
  })()
  BG_IRC.historyInFlight.set(ch, p)
  return p
}

// justlog — public Twitch chat archive going back years for any opted-in channel
// (~50k popular channels). Pulls the most recent msgs in raw IRC format (parseable
// by our existing parser). Fetched through heatsync.org/api/justlog/:ch — a
// first-party proxy that walks the justlog forks server-side, so a chatter's IP
// never touches a third party. Channels not in any archive return {messages:[]}.
const BG_IRC_JUSTLOG_COOLDOWN_MS = 5 * 60 * 1000
function bgIrcFetchJustlog(ch) {
  ch = (ch || '').toLowerCase()
  if (!ch) return Promise.resolve()
  const last = BG_IRC.lastJustlogAt?.get?.(ch) || 0
  if (Date.now() - last < BG_IRC_JUSTLOG_COOLDOWN_MS) return Promise.resolve()
  if (!BG_IRC.lastJustlogAt) BG_IRC.lastJustlogAt = new Map()
  BG_IRC.lastJustlogAt.set(ch, Date.now())
  pruneMap(BG_IRC.lastJustlogAt, COOLDOWN_TS_MAX_CHANNELS)
  return (async () => {
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 15000)
      const resp = await fetch(`https://heatsync.org/api/justlog/${encodeURIComponent(ch)}`, {
        signal: ctrl.signal,
        credentials: 'omit',
      })
      clearTimeout(timer)
      if (!resp.ok) return
      const data = await resp.json()
      const list = Array.isArray(data?.messages) ? data.messages : []
      if (list.length === 0) return
      const buf = BG_IRC.channels.get(ch)
      if (!buf) return
      const existing = buf.getAll()
      const existingIds = new Set(existing.filter((m) => m.id).map((m) => m.id))
      const fpKey = (m) => `${m.user}|${m.time}|${(m.text || '').slice(0, 60)}`
      const existingFp = new Set(existing.filter((m) => !m.id).map(fpKey))
      const toAdd = []
      for (const item of list) {
        const raw = typeof item === 'string' ? item : item?.raw || ''
        if (!raw) continue
        const msg = bgIrcParseLine(raw, ch)
        if (!msg) continue
        if (msg.type === 'roomstate' || msg.type === 'userstate' || msg.type === 'whisper') continue
        msg.isHistory = true
        if (msg.id && existingIds.has(msg.id)) continue
        if (!msg.id && existingFp.has(fpKey(msg))) continue
        existingIds.add(msg.id)
        if (!msg.id) existingFp.add(fpKey(msg))
        toAdd.push(msg)
      }
      if (toAdd.length === 0) return
      const all = [...existing, ...toAdd].sort((a, b) => (a.time || 0) - (b.time || 0))
      buf.clear()
      for (const m of all) buf.push(m)
      bgIrcReconcileCleared(buf)
      bgIrcPersistChannel(ch)
      bgIrcBroadcast({ type: 'bg_irc_history_merged', channel: ch, count: toAdd.length })
      log('BG IRC justlog merged', toAdd.length, 'msgs for', ch)
    } catch (e) {
      log('BG IRC justlog fetch failed for', ch, ':', e?.message)
    }
  })()
}

// Convert one heatsync server-side IrcRecord (structured shape) into the ext's
// own msg shape used by BG_IRC buffers + tab renderer. Heatsync persists a
// 500-msg Redis ring per channel for 24h — way more reach than robotty's
// instant-API endpoint. Records cover privmsg / usernotice / clearchat /
// clearmsg / notice; ext only renders the first three meaningfully.
function bgIrcRecordToExt(rec, channelHint) {
  if (!rec || typeof rec !== 'object') return null
  const ch = channelHint || (typeof rec.channel === 'string' ? rec.channel.toLowerCase() : '')
  if (!ch) return null
  const t = rec.type
  if (t === 'privmsg') {
    // /me actions: the IRC transport persists the raw \x01ACTION…\x01 wrapper
    // (EventSub strips it). Mirror bgIrcParseLine — strip for display, flag
    // isAction, and slice the STRIPPED text for emote names so positions align
    // exactly as on the live IRC path. A record that arrives already-stripped
    // just no-ops the guard.
    let content = rec.content || ''
    let isAction = false
    if (content.charCodeAt(0) === 1 && content.startsWith('\x01ACTION ')) {
      content = content.slice(8, content.endsWith('\x01') ? -1 : undefined)
      isAction = true
    }
    const msg = {
      user: rec.displayName || rec.username || 'anonymous',
      userId: rec.userId || '',
      text: content,
      color: bgIrcSanitizeColor(rec.color || '#fff'),
      badges: rec.badges || '',
      channel: ch,
      time: rec.timestamp || Date.now(),
      id: rec.id || '',
      isHistory: true,
      replyTo: rec.replyTo
        ? {
            user: rec.replyTo.username || '',
            text: rec.replyTo.content || '',
            id: rec.replyTo.messageId || '',
            // Twitch-resolved id, mirroring rec.userId's convention above — the
            // server relays reply-parent-user-id under this same camelCase field.
            // Lets the renderer paint the reply target synchronously instead of
            // falling back to an async name→uid lookup.
            userId: rec.replyTo.userId || '',
            threadId: rec.replyTo.threadId || rec.replyTo.messageId || '',
          }
        : null,
    }
    if (rec.emotes) {
      const twitchEmotes = {}
      for (const part of String(rec.emotes).split('/')) {
        const [emoteId, posStr] = part.split(':')
        if (!emoteId || !posStr) continue
        const firstPos = posStr.split(',')[0]
        const [start, end] = firstPos.split('-').map(Number)
        if (Number.isNaN(start) || Number.isNaN(end)) continue
        const name = content.slice(start, end + 1)
        if (name && !twitchEmotes[name]) {
          twitchEmotes[name] = `https://static-cdn.jtvnw.net/emoticons/v2/${emoteId}/default/dark/2.0`
        }
      }
      if (Object.keys(twitchEmotes).length > 0) msg.twitchEmotes = twitchEmotes
    }
    // Server-enriched third-party emote refs (name→{url,provider,zeroWidth}) —
    // authoritative per-message set the sender actually used, so the panel
    // renders them without fetching the sender's set. See emote-enrich.ts.
    if (rec.hsEmotes && typeof rec.hsEmotes === 'object') msg.hsEmotes = rec.hsEmotes
    if (rec.bits && rec.bits > 0) msg.bits = rec.bits
    if (rec.isHighlighted) msg.isHighlighted = true
    if (rec.isFirstMsg) msg.isFirstMsg = true
    if (rec.isRedemption) msg.redeemed = true
    const subMatch = (rec.badgeInfo || '').match?.(/subscriber\/(\d+)/)
    if (subMatch) msg.subMonths = parseInt(subMatch[1], 10)
    if (isAction) msg.isAction = true
    return msg
  }
  if (t === 'usernotice') {
    return {
      user: rec.displayName || rec.username || 'system',
      text: rec.content || '',
      systemMsg: rec.systemMessage || '',
      color: bgIrcSanitizeColor(rec.color || '#fff'),
      badges: rec.badges || '',
      channel: ch,
      time: rec.timestamp || Date.now(),
      type: 'usernotice',
      msgId: rec.subType || '',
      subTier: '',
      subMonths: 0,
      giftCount: 0,
      recipient: '',
      raidViewers: 0,
      raidFrom: '',
      announceColor: '',
      bitsTier: 0,
      id: rec.id || '',
      isHistory: true,
    }
  }
  if (t === 'clearchat') {
    const target = rec.targetUsername || ''
    const duration = rec.banDuration
    // A LIVE CLEARCHAT line with no ban-duration tag means permanent, per
    // twitch's protocol. A REPLAYED record with no duration FIELD means we
    // never stored one — those are not the same thing, and this shared
    // string-builder used to treat them identically, manufacturing
    // "permanently banned" for a 1s timeout. Explicit 0 = recorded permanent
    // ban; null/undefined = unknown, so say something true instead.
    const durationKnown = duration != null
    const text = target
      ? duration
        ? `${target} timed out for ${duration}s`
        : durationKnown
          ? `${target} was permanently banned`
          : `${target} was removed from chat`
      : 'Chat was cleared'
    return {
      type: 'notice',
      noticeType: duration ? 'timeout_success' : 'ban_success',
      user: 'system',
      text,
      color: '#ffffff',
      badges: '',
      channel: ch,
      time: rec.timestamp || Date.now(),
      id: rec.id || `clearchat-${ch}-${target}-${duration || 'perma'}-${rec.timestamp || 0}`,
      systemMsg: text,
      targetUser: target,
      targetUserId: rec.targetUserId || '',
      banDuration: duration || 0,
      isHistory: true,
    }
  }
  return null
}

// Merge a heatsync `irc:backlog` payload into BG_IRC. Dedupes by id (PRIVMSG
// ids overlap with Twitch tag.id, so this catches what robotty also saw).
function bgIrcMergeServerBacklog(ch, records) {
  ch = (ch || '').toLowerCase()
  if (!ch || !Array.isArray(records) || records.length === 0) return
  // Joins create the ring before asking for backlog; no ring = released
  // (or never joined) — a late reply must not bring a dropped channel back.
  const buf = BG_IRC.channels.get(ch)
  if (!buf) return
  const existing = buf.getAll()
  const existingIds = new Set(existing.filter((m) => m.id).map((m) => m.id))
  const fpKey = (m) => `${m.user}|${m.time}|${(m.text || '').slice(0, 60)}`
  const existingFp = new Set(existing.filter((m) => !m.id).map(fpKey))
  const toAdd = []
  for (const rec of records) {
    const msg = bgIrcRecordToExt(rec, ch)
    if (!msg) continue
    if (msg.id && existingIds.has(msg.id)) continue
    if (!msg.id && existingFp.has(fpKey(msg))) continue
    // Mod notices need the (target, type, window) check too, not just id +
    // fingerprint: two history sources describe ONE timeout with different
    // wording and different ids, so both slipped through and the same action
    // rendered twice. bgIrcDupModNotice is the same collapse the live path uses.
    if (bgIrcDupModNotice(buf, msg)) continue
    toAdd.push(msg)
  }
  if (toAdd.length === 0) return
  const all = [...existing, ...toAdd].sort((a, b) => (a.time || 0) - (b.time || 0))
  buf.clear()
  for (const m of all) buf.push(m)
  bgIrcReconcileCleared(buf)
  bgIrcPersistChannel(ch)
  bgIrcBroadcast({ type: 'bg_irc_history_merged', channel: ch, count: toAdd.length })
  log('BG IRC heatsync backlog merged', toAdd.length, 'msgs for', ch)
}

// Cross-source live dedupe — the same PRIVMSG can arrive from our own IRC
// socket AND the heatsync server's EventSub-fed fanout (irc:message). FIFO.
const _bgLiveIds = new Set()
const _bgLiveIdOrder = []
function bgIrcSeenLiveId(id) {
  if (!id) return false
  if (_bgLiveIds.has(id)) return true
  _bgLiveIds.add(id)
  _bgLiveIdOrder.push(id)
  if (_bgLiveIdOrder.length > 6000) {
    for (let i = 0; i < 1000; i++) _bgLiveIds.delete(_bgLiveIdOrder[i])
    _bgLiveIdOrder.splice(0, 1000)
  }
  return false
}

async function bgIrcBroadcast(payload) {
  try {
    // Route to only the tabs that registered interest in this message's
    // channel (bgIrcRegisterTabInterest) instead of every platform tab.
    // 'open_channels' and other channel-less payloads have no ch to route
    // on; a channel with no tracked interest yet (race on join, or a tab
    // that predates BG_IRC.channelTabs) falls back to the full broadcast
    // so delivery is never silently dropped.
    const ch = payload?.channel || payload?.msg?.channel || null
    const tabSet = ch ? BG_IRC.channelTabs.get(ch) : null
    if (ch && tabSet && tabSet.size) {
      for (const tabId of tabSet) {
        browser.tabs.sendMessage(tabId, payload).catch(() => {})
      }
      return
    }
    const tabs = await getMatchingTabs()
    for (const tab of tabs) {
      browser.tabs.sendMessage(tab.id, payload).catch(() => {})
    }
  } catch {}
}

function bgIrcRegisterTabInterest(tabId, ch) {
  bgIrcCancelRelease(ch)
  if (!BG_IRC.tabInterest.has(tabId)) BG_IRC.tabInterest.set(tabId, new Set())
  BG_IRC.tabInterest.get(tabId).add(ch)
  if (!BG_IRC.channelTabs.has(ch)) BG_IRC.channelTabs.set(ch, new Set())
  BG_IRC.channelTabs.get(ch).add(tabId)
}

function bgIrcUnregisterTabInterest(tabId, ch) {
  const tabSet = BG_IRC.channelTabs.get(ch)
  if (tabSet) {
    tabSet.delete(tabId)
    if (tabSet.size === 0) {
      BG_IRC.channelTabs.delete(ch)
      bgIrcScheduleRelease(ch)
    }
  }
  const interest = BG_IRC.tabInterest.get(tabId)
  if (interest) interest.delete(ch)
}

// Twitch logins are [a-z0-9_]{1,25}. Every JOIN/PART below interpolates the
// channel into a raw IRC protocol line, so a name carrying \r\n would inject
// a second command onto the user's own authenticated connection. Anything
// non-conforming is stripped to empty and the join is dropped — the manual
// add-channel form and the join_channel handler already enforce this shape;
// the profile-card "add as channel" path (server-supplied twitch_username)
// did not, which is what this closes.
function bgIrcSafeChannel(ch) {
  // Non-strings are rejected outright rather than stringified — String({})
  // would otherwise yield a bogus but "valid-looking" channel that passes the
  // caller's truthiness guard and joins a channel nobody asked for.
  if (typeof ch !== 'string') return ''
  return ch
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 25)
}

function bgIrcEnsureChannel(ch, restored = null) {
  ch = bgIrcSafeChannel(ch)
  if (!ch) return
  const isNew = !BG_IRC.channels.has(ch)
  if (isNew) {
    BG_IRC.channels.set(ch, restored || new BGCircularBuffer(BG_IRC_PERSIST_MAX))
    BG_IRC.chanLastSeen.set(ch, Date.now())
    if (BG_IRC.channels.size > MAX_BG_IRC_CHANNELS) {
      const oldest = BG_IRC.channels.keys().next().value
      BG_IRC.channels.delete(oldest)
      BG_IRC.chanLastSeen.delete(oldest)
      BG_IRC.lastJustlogAt?.delete?.(oldest)
      BG_IRC.chanRejoinAttempts.delete(oldest)
      browser.storage.local.remove(`hs_irc_${oldest}`).catch(() => {})
    }
    if (BG_IRC.ws?.readyState === WebSocket.OPEN) {
      try {
        BG_IRC.ws.send(`JOIN #${ch}\r\n`)
      } catch {}
    }
  }
  // External history sources fire regardless of whether the channel already
  // exists in our in-memory map. A channel restored from chrome.storage on
  // SW boot has the buffer but never had this SW's external fetches run —
  // without firing them on every join, restored channels permanently miss
  // the deeper sources (justlog / heatsync irc:resume / fresh robotty).
  // All three have internal cooldowns to prevent hammering.
  try {
    wsSend({ type: 'irc:join', channel: ch })
  } catch {}
  try {
    const buf = BG_IRC.channels.get(ch)
    const all = buf?.getAll() || []
    const lastTs = all.length > 0 ? all[all.length - 1].time || 0 : 0
    wsSend({ type: 'irc:resume', channel: ch, since: lastTs })
  } catch {}
  try {
    bgIrcFetchJustlog(ch)
  } catch {}
  bgIrcFetchRobotty(ch)
}

// Tab cleanup — drop interest when a tab closes
chrome.tabs.onRemoved.addListener((tabId) => {
  BG_IRC.liveTabs.delete(tabId)
  const interest = BG_IRC.tabInterest.get(tabId)
  if (!interest) return
  for (const ch of interest) {
    const tabSet = BG_IRC.channelTabs.get(ch)
    if (tabSet) {
      tabSet.delete(tabId)
      if (tabSet.size === 0) {
        BG_IRC.channelTabs.delete(ch)
        bgIrcScheduleRelease(ch)
      }
    }
  }
  BG_IRC.tabInterest.delete(tabId)
})

// Ctx-death detector port (companion to content.js + multichat bootstrap).
// Each content script opens this port at startup; BG just accepts and holds
// it. When the ext is invalidated, the content side gets a SYNCHRONOUS
// onDisconnect — fires before chrome.runtime becomes undefined or Chrome
// suspends the orphaned script's setInterval, giving a reliable recovery
// signal that the 2s interval detector misses. No messaging on this port.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'heatsync-ctx-death') return
  // SW idle-suspension disconnects the port; content side re-opens (which
  // also wakes the SW). No-op handler on our end.
})

// Listener — handles bg_irc_join / bg_irc_part / bg_irc_history
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false
  // Reject messages from other extensions — must be this extension's own scripts.
  const _senderUrl = sender?.tab?.url || sender?.url || ''
  const _isFromPopup = !sender?.tab
  const _isOwnExt = sender?.id === chrome.runtime.id
  const _isValidOrigin =
    _isFromPopup || /^https:\/\/([a-z0-9-]+\.)*(twitch\.tv|kick\.com|heatsync\.org|youtube\.com)(\/|$)/.test(_senderUrl)
  if (!(_isOwnExt && _isValidOrigin)) {
    sendResponse({ ok: false, error: 'unauthorized sender' })
    return true
  }
  const tabId = sender?.tab?.id
  if (message.type === 'bg_irc_auth') {
    // Twitch chat token from a twitch tab (same internal channel the GQL
    // relay uses). Reconnect the reader authed when creds arrive/change.
    const token = typeof message.token === 'string' ? message.token : ''
    const nick = (message.nick || '').toLowerCase()
    if (token && nick && /^[a-z0-9_]{1,30}$/.test(nick)) {
      const changed = token !== BG_IRC.authToken || nick !== BG_IRC.authNick
      BG_IRC.authToken = token
      BG_IRC.authNick = nick
      // survive SW restarts within the browser session — otherwise the
      // reader silently reverts to starved-anonymous until a twitch tab
      // happens to re-init
      try {
        chrome.storage.session?.set?.({ hs_irc_auth: { token, nick } })
      } catch {}
      if (changed) BG_IRC.authFailed = false
      const anonOrStale = changed || !BG_IRC.ws || BG_IRC.ws.readyState !== WebSocket.OPEN
      if (anonOrStale && !BG_IRC.authFailed) {
        log('BG IRC: upgrading reader to authed connection')
        // Force, not plain connect: a plain bgIrcConnect() early-returns while
        // the anon socket is still CONNECTING, silently dropping the upgrade —
        // the reader then stays anonymous until something else reconnects it.
        bgIrcForceReconnect()
      }
    }
    sendResponse({ ok: true })
    return true
  }
  if (message.type === 'bg_submit_feedback') {
    // Popup feedback form. Server re-validates everything; the slices here
    // just keep an oversized payload from 422ing on schema caps.
    const kind = message.kind === 'bug' ? 'bug' : 'feedback'
    const body = typeof message.body === 'string' ? message.body.trim().slice(0, 4000) : ''
    if (body.length < 3) {
      sendResponse({ ok: false, error: 'too short' })
      return true
    }
    const rawCtx = message.context && typeof message.context === 'object' ? message.context : {}
    const context = {}
    for (const [key, max] of [
      ['url', 2000],
      ['ua', 500],
      ['version', 50],
      ['platform', 50],
      ['viewport', 50],
    ]) {
      if (typeof rawCtx[key] === 'string' && rawCtx[key]) context[key] = rawCtx[key].slice(0, max)
    }
    ;(async () => {
      try {
        const token = await retrieveToken()
        const headers = { 'Content-Type': 'application/json' }
        if (token) headers.Authorization = `Bearer ${token}`
        const r = await fetchWithTimeout(
          `${API_URL}/api/feedback`,
          { method: 'POST', headers, body: JSON.stringify({ kind, body, source: 'ext', context }) },
          10000,
        )
        sendResponse({ ok: r.ok })
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) })
      }
    })()
    return true
  }
  if (message.type === 'bg_irc_join') {
    const ch = bgIrcSafeChannel(message.channel)
    if (!ch) {
      sendResponse({ ok: false, error: 'no channel' })
      return true
    }
    ;(async () => {
      try {
        if (!BG_IRC.storageRestored) await bgIrcRestoreFromStorage()
        // Interest first: a release armed by a part moments ago must not
        // fire while the persisted ring is being read.
        if (tabId) bgIrcRegisterTabInterest(tabId, ch)
        if (!BG_IRC.channels.has(ch)) {
          let p = BG_IRC.joining.get(ch)
          if (!p) {
            p = bgIrcReadPersisted(ch)
              .then((restored) => bgIrcEnsureChannel(ch, restored))
              .finally(() => BG_IRC.joining.delete(ch))
            BG_IRC.joining.set(ch, p)
          }
          await p
        } else {
          bgIrcEnsureChannel(ch)
        }
        // Reader may be parked (SW booted with no platform tabs) — a join is
        // live interest, connect now; onopen re-JOINs every known channel.
        if (!BG_IRC.ws && !BG_IRC.reconnectTimer) bgIrcConnect()
        BG_IRC.liveTabs.add(tabId)
        sendResponse({ ok: true })
      } catch (e) {
        // Always respond — a thrown restore/join would otherwise leave the
        // content script's await hanging (no port reply) and the join silently dead.
        sendResponse({ ok: false, error: e?.message || String(e) })
      }
    })()
    return true
  }
  // A tab re-asserting which channels it still shows. The BG's per-tab interest
  // map lives in memory, so a service-worker restart empties it — and the first
  // tab to join afterwards then became the ONLY recipient of that channel
  // (bgIrcBroadcast routes to the tracked tabs), starving every older tab and
  // popout until it was refreshed. Tabs repeat this on a timer, so interest is
  // rebuilt within seconds instead of never.
  if (message.type === 'bg_irc_interest') {
    const list = Array.isArray(message.channels) ? message.channels.slice(0, 60) : []
    if (tabId) {
      for (const raw of list) {
        const ch = bgIrcSafeChannel(raw)
        if (!ch) continue
        bgIrcRegisterTabInterest(tabId, ch)
        if (!BG_IRC.channels.has(ch) && BG_IRC.storageRestored) bgIrcEnsureChannel(ch)
      }
      // A tab still watching is live interest, every 15s. The reader can be
      // parked (the idle check saw zero platform tabs mid-navigation) or dead
      // with no retry armed, and only a join used to bring it back — joins go
      // out once per channel, so the feed stayed stale until a page refresh.
      if (list.length && !BG_IRC.ws && !BG_IRC.reconnectTimer) bgIrcConnect()
      BG_IRC.liveTabs.add(tabId)
    }
    sendResponse({ ok: true })
    return true
  }
  if (message.type === 'bg_irc_part') {
    const ch = (message.channel || '').toLowerCase()
    if (ch && tabId) bgIrcUnregisterTabInterest(tabId, ch)
    sendResponse({ ok: true })
    return true
  }
  if (message.type === 'bg_irc_history') {
    const ch = (message.channel || '').toLowerCase()
    ;(async () => {
      try {
        if (!BG_IRC.storageRestored) await bgIrcRestoreFromStorage()
        const joining = BG_IRC.joining.get(ch)
        if (joining) await joining.catch(() => {})
        // If a robotty backfill is in flight (cold SW / fresh channel), wait
        // for it so the tab's first paint already has full history instead of
        // depending on the later bg_irc_history_merged broadcast. Cap the wait
        // so a slow robotty doesn't block the page indefinitely.
        const pending = BG_IRC.historyInFlight.get(ch)
        if (pending) {
          try {
            await Promise.race([pending, new Promise((r) => setTimeout(r, 4000))])
          } catch {}
        }
        const buf = BG_IRC.channels.get(ch)
        sendResponse({ ok: true, msgs: buf ? buf.getAll() : [], hasBg: true })
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e), msgs: [], hasBg: true })
      }
    })()
    return true
  }
  return false
})

// Boot — restore + connect on SW startup, but ONLY when a platform tab
// exists. This IIFE runs on EVERY SW wake (any alarm, any event); connecting
// unconditionally gave the SW a permanent WS heartbeat → the whole heap
// stayed pinned forever even for a user on zero chat sites. With no tabs the
// reader stays parked; bg_irc_join / scheduleWsIdleCheck un-park it.
;(async () => {
  let tabs = null
  try {
    tabs = await browser.tabs.query({ url: SEVENTV_PLATFORM_URLS })
  } catch {} // query failed → fail open, connect as before
  if (tabs && tabs.length === 0) {
    BG_IRC.idleClosed = true
    return
  }
  await bgIrcRestoreFromStorage()
  bgIrcConnect()
  // A woken SW has lost every tab's interest and holds no rings (they are
  // read per join), so open tabs re-assert the channels they show.
  for (const tab of tabs || (await getMatchingTabs().catch(() => []))) {
    browser.tabs.sendMessage(tab.id, { type: 'bg_irc_rejoin' }).catch(() => {})
  }
})()
