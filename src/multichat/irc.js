// IRC - read-only IRC client, message parsing, CircularBuffer

// Raid windows: channel(lowercase) → ms timestamp until which incoming
// first-time chatters are flagged as raiders. Opened by a raid USERNOTICE and
// read in the PRIVMSG branch. Expired entries are pruned on each new raid —
// without that the map grows one entry per channel ever raided all session.
const _raidWindows = new Map()
const RAID_WINDOW_MS = 90 * 1000

// Kick sub/gift/KICKs celebrations reach us on TWO independent transports —
// the server's official webhook relay and BG's Pusher tap — and a channel can
// have both. Neither payload carries a stable event id to dedup on, so the key
// is the content itself inside a short window. Collapsing a genuine second
// identical gift within 30s costs one line; letting every celebration render
// twice costs trust in every line.
const KICK_CELEBRATION_DEDUP_MS = 30000
const _kickCelebrationSeen = new Map()
function kickCelebrationFresh(key) {
  const now = Date.now()
  if (_kickCelebrationSeen.size > 200) {
    for (const [k, t] of _kickCelebrationSeen) if (now - t > KICK_CELEBRATION_DEDUP_MS) _kickCelebrationSeen.delete(k)
  }
  const prev = _kickCelebrationSeen.get(key)
  if (prev && now - prev < KICK_CELEBRATION_DEDUP_MS) return false
  _kickCelebrationSeen.set(key, now)
  return true
}

// Short relay/tap event names → the notice ids main.js's noticeKind() actually
// styles (it was written against the server's webhook event strings).
const KICK_SUB_NOTICE_ID = {
  new: 'channel.subscription.new',
  renewal: 'channel.subscription.renewal',
  gift: 'channel.subscription.gifts',
}

function parseTags(tagStr) {
  const tags = {}
  for (const part of tagStr.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) {
      tags[part] = ''
      continue
    }
    // flatStr: values land on long-lived message objects — see above
    tags[part.slice(0, eq)] = flatStr(part.slice(eq + 1)) || ''
  }
  return tags
}

// IRCv3 tag-value unescape: \s→space, \:→";", \\→"\", \r→CR, \n→LF.
// Tag values are backslash-escaped, NOT percent-encoded — decodeURIComponent
// throws URIError on any bare '%' (e.g. "im 100% sure") and silently corrupts
// valid-looking sequences like '%20'.
function ircTagUnescape(v) {
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

// Parse the IRC `emotes=` tag (emoteId:start-end,start-end/...) into a
// { name: cdnUrl } map keyed off positions in the message text. Shared by
// PRIVMSG and USERNOTICE — the latter's user-typed portion (e.g. a watchstreak
// share message) carries the same tag and follower/sub emotes only render
// when this map is populated.
function parseTwitchEmotesTag(emotesTag, text) {
  if (!emotesTag) return null
  // Twitch emote positions count UNICODE CODE POINTS; String#slice counts
  // UTF-16 code units. Any astral char (emoji) before an emote shifts the
  // boundaries and slices a garbage name. Fast path: no surrogates → the two
  // index spaces coincide, keep the zero-alloc slice. Otherwise split once
  // into code points and slice that.
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

function parseIrcLine(raw, channel) {
  try {
    const tagsMatch = raw.match(/^@([^ ]+)/)
    if (!tagsMatch) return null
    const tags = parseTags(tagsMatch[1])

    // PRIVMSG: @tags :user!user@user.tmi.twitch.tv PRIVMSG #channel :message
    // The trailing colon is OPTIONAL in IRC when the message is a single word —
    // robotty's recent-messages replay serializes one-word lines without it
    // (`PRIVMSG #ch Gladge`), and requiring the colon silently dropped every
    // emote-only/one-word message from history (2026-08-10, same fix as site).
    const privmsg = raw.match(/PRIVMSG #([^ ]+) (?::(.*)|([^\s:][^ ]*))$/)
    if (privmsg) {
      privmsg[2] = privmsg[2] ?? privmsg[3]
      const displayName = tags['display-name'] || 'anonymous'
      // /me sends as \x01ACTION text\x01
      let text = flatStr(privmsg[2])
      let isAction = false
      if (text.charCodeAt(0) === 1 && text.startsWith('\x01ACTION ')) {
        text = text.slice(8, text.endsWith('\x01') ? -1 : undefined)
        isAction = true
      }
      // True login from the IRC prefix (:login!login@login.tmi.twitch.tv).
      // display-name ≠ login for non-Latin names; mod actions + notice dedup need
      // the login, not the display name.
      // Anchored at line start (optional @tags, then the IRC prefix) so a message
      // body containing ":x!y@" can never be captured instead of the real prefix.
      const _loginM = raw.match(/^(?:@[^ ]+ )?:([a-zA-Z0-9_]+)![a-zA-Z0-9_]+@/)
      const login = flatStr(_loginM ? _loginM[1].toLowerCase() : displayName.toLowerCase())
      const msg = {
        user: displayName,
        login,
        userId: tags['user-id'] || '',
        text: text,
        color: sanitizeColor(tags.color || '#fff'),
        badges: tags.badges || '',
        channel: channel || flatStr(privmsg[1].toLowerCase()),
        time: parseInt(tags['tmi-sent-ts'], 10) || parseInt(tags['rm-received-ts'], 10) || Date.now(),
        id: tags.id || '',
        replyTo: tags['reply-parent-display-name']
          ? {
              user: ircTagUnescape(tags['reply-parent-display-name']),
              text: tags['reply-parent-msg-body'] ? ircTagUnescape(tags['reply-parent-msg-body']) : '',
              id: tags['reply-parent-msg-id'] || '',
              userId: tags['reply-parent-user-id'] || '',
              threadId: tags['reply-thread-parent-msg-id'] || tags['reply-parent-msg-id'] || '',
            }
          : null,
      }
      const twitchEmotes = parseTwitchEmotesTag(tags.emotes, text)
      if (twitchEmotes) msg.twitchEmotes = twitchEmotes
      if (isAction) msg.isAction = true
      const bits = parseInt(tags.bits, 10) || 0
      if (bits > 0) msg.bits = bits
      // No own-cheer fallbacks — the renderer is bulletproof-strict: only
      // server-confirmed `bits=N` tags from twitch's IRC count. If the user
      // sent a cheer and bits weren't credited, no cheermote shows (which is
      // honest — the bit didn't deduct). The send-side wiring (native lexical
      // chat input → twitch GQL sendChatMessage) is what credits bits; if it
      // fails, that's the bug to fix, not the renderer.
      if (tags['custom-reward-id']) {
        msg.redeemed = true
        msg.rewardId = tags['custom-reward-id']
      }
      if (tags['msg-id'] === 'highlighted-message') msg.isHighlighted = true
      if (tags['msg-id'] === 'user-intro') msg.userIntro = true
      // Power-ups (paid): gigantified emote + message effects (animation-id
      // names the effect, e.g. rainbow-eclipse / simmer / cosmic-abyss)
      if (tags['msg-id'] === 'gigantified-emote-message') msg.gigantified = true
      if (tags['msg-id'] === 'animated-message') msg.animationId = tags['animation-id'] || 'effect'
      // Shared chat: source-room-id differing from room-id = partner-channel origin
      if (tags['source-room-id'] && tags['room-id'] && tags['source-room-id'] !== tags['room-id']) msg.sharedChat = true
      if (tags['first-msg'] === '1') msg.isFirstMsg = true
      if (tags['returning-chatter'] === '1') msg.isReturningChatter = true
      // Raider: a first-time chatter arriving inside the window opened by a raid
      // USERNOTICE for this channel (see below). Regulars chatting during a raid
      // aren't flagged — only the incoming wave (first-msg ∩ raid window).
      if (msg.isFirstMsg) {
        const raidUntil = _raidWindows.get(msg.channel)
        if (raidUntil && msg.time <= raidUntil) msg.isRaider = true
      }
      // Extract sub tenure from badge-info (subscriber/N = cumulative months)
      const badgeInfo = tags['badge-info']
      if (badgeInfo) {
        const subMatch = badgeInfo.match(/subscriber\/(\d+)/)
        if (subMatch) msg.subMonths = parseInt(subMatch[1], 10)
      }
      return msg
    }

    // USERNOTICE: @tags :tmi.twitch.tv USERNOTICE #channel :optional message
    const usernotice = raw.match(/USERNOTICE #([^ ]+)(?: :(.+))?$/)
    if (usernotice) {
      const displayName = tags['display-name'] || 'system'
      const subPlan = tags['msg-param-sub-plan'] || ''
      const tier =
        subPlan === '2000' ? '2' : subPlan === '3000' ? '3' : subPlan === 'Prime' ? 'prime' : subPlan ? '1' : ''
      const months = parseInt(tags['msg-param-cumulative-months'], 10) || parseInt(tags['msg-param-months'], 10) || 0
      const giftCount = parseInt(tags['msg-param-mass-gift-count'], 10) || 0
      const recipient = tags['msg-param-recipient-display-name']
        ? ircTagUnescape(tags['msg-param-recipient-display-name'])
        : ''
      const raidViewers = parseInt(tags['msg-param-viewerCount'], 10) || 0
      const raidFrom = tags['msg-param-displayName'] ? ircTagUnescape(tags['msg-param-displayName']) : ''
      const announceColor = tags['msg-param-color'] || ''
      const bitsTier = parseInt(tags['msg-param-threshold'], 10) || 0
      const category = tags['msg-param-category'] || ''
      const rawMsgId = tags['msg-id'] || ''
      // Watch-streak: Twitch ships it under viewermilestone w/ category=watch-streak.
      // Promote to its own msgId so renderers + dedupe can distinguish.
      const msgId = rawMsgId === 'viewermilestone' && category === 'watch-streak' ? 'watchstreak' : rawMsgId
      const streakCount = msgId === 'watchstreak' ? parseInt(tags['msg-param-value'], 10) || 0 : 0
      const userText = flatStr(usernotice[2]) || ''
      // Open a raid window so the incoming wave's first messages get flagged.
      if (rawMsgId === 'raid') {
        const uncChannel = channel || flatStr(usernotice[1].toLowerCase())
        const uncTime = parseInt(tags['tmi-sent-ts'], 10) || parseInt(tags['rm-received-ts'], 10) || Date.now()
        const nowMs = Date.now()
        for (const [ch, until] of _raidWindows) if (until < nowMs) _raidWindows.delete(ch)
        _raidWindows.set(uncChannel, uncTime + RAID_WINDOW_MS)
      }
      const twitchEmotes = parseTwitchEmotesTag(tags.emotes, userText)
      return {
        user: displayName,
        text: userText,
        systemMsg: ircTagUnescape(tags['system-msg'] || ''),
        color: sanitizeColor(tags.color || '#fff'),
        badges: tags.badges || '',
        channel: channel || flatStr(usernotice[1].toLowerCase()),
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
        // shared-chat wrapper: real event type rides in source-msg-id
        sourceMsgId: tags['source-msg-id'] || undefined,
        sharedChat:
          tags['source-room-id'] && tags['room-id'] && tags['source-room-id'] !== tags['room-id'] ? true : undefined,
        id: tags.id || '',
      }
    }

    // NOTICE: @tags :tmi.twitch.tv NOTICE #channel :message
    // (also used by clearchatToNotice=true from recent-messages API)
    const notice = raw.match(/NOTICE #([^ ]+) :(.+)$/)
    if (notice) {
      const ch = channel || flatStr(notice[1].toLowerCase())
      const time = parseInt(tags['tmi-sent-ts'], 10) || parseInt(tags['rm-received-ts'], 10) || Date.now()
      const noticeType = tags['msg-id'] || ''
      // Deterministic ID when server doesn't provide one — same notice from live IRC
      // and robotty history dedupes correctly (both share tmi-sent-ts).
      const detId = `notice-${ch}-${time}-${notice[2].slice(0, 64)}`
      return {
        type: 'notice',
        noticeType,
        user: 'system',
        text: flatStr(notice[2]),
        color: '#808080',
        badges: '',
        channel: ch,
        time,
        id: tags.id || detId,
        systemMsg: flatStr(notice[2]),
      }
    }

    // ROOMSTATE: @tags :tmi.twitch.tv ROOMSTATE #channel
    // (slow/subs-only/emote-only/followers-only/r9k mode toggles + initial state on JOIN)
    const roomstate = raw.match(/ROOMSTATE #([^ ]+)/)
    if (roomstate) {
      const ch = channel || roomstate[1].toLowerCase()
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

    // USERSTATE: @badges=...;color=...;display-name=... :tmi.twitch.tv USERSTATE #channel
    // Sent on JOIN + after every viewer PRIVMSG. Tells us the viewer's own
    // per-channel badges — used to detect entitlement for this channel's
    // sub emotes (subscriber/N or founder/N badge).
    const userstate = raw.match(/USERSTATE #([^ ]+)/)
    if (userstate) {
      const ch = channel || userstate[1].toLowerCase()
      const badgeNames = new Set()
      for (const part of (tags.badges || '').split(',')) {
        const name = part.split('/')[0]
        if (name) badgeNames.add(name)
      }
      return { type: 'userstate', channel: ch, badges: badgeNames, time: Date.now() }
    }

    // CLEARCHAT: @tags :tmi.twitch.tv CLEARCHAT #channel :username
    // (timeout/ban of a user)
    const clearchat = raw.match(/CLEARCHAT #([^ ]+)(?: :(.+))?$/)
    if (clearchat) {
      const target = flatStr(clearchat[2]) || ''
      const duration = tags['ban-duration']
      const text = target
        ? duration
          ? `${target} timed out for ${duration}s`
          : `${target} was permanently banned`
        : t('mc_irc_chat_cleared')
      const ch = channel || flatStr(clearchat[1].toLowerCase())
      const time = parseInt(tags['tmi-sent-ts'], 10) || parseInt(tags['rm-received-ts'], 10) || Date.now()
      // Deterministic ID — dedupes live CLEARCHAT vs robotty NOTICE replay of same event.
      const detId = `clearchat-${ch}-${target}-${duration || 'perma'}-${time}`
      return {
        type: 'notice',
        noticeType: duration ? 'timeout_success' : 'ban_success',
        user: 'system',
        text,
        color: '#808080',
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

    // CLEARMSG: @tags :tmi.twitch.tv CLEARMSG #channel :deleted message text
    // (single message deletion)
    const clearmsg = raw.match(/CLEARMSG #([^ ]+) :(.+)$/)
    if (clearmsg) {
      const targetMsgId = tags['target-msg-id']
      return {
        type: 'notice',
        noticeType: 'delete_message_success',
        user: 'system',
        text: t('mc_irc_msg_deleted', [tags.login || 'unknown']),
        color: '#808080',
        badges: '',
        channel: channel || flatStr(clearmsg[1].toLowerCase()),
        time: parseInt(tags['tmi-sent-ts'], 10) || parseInt(tags['rm-received-ts'], 10) || Date.now(),
        id: targetMsgId || `clearmsg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        systemMsg: t('mc_irc_msg_deleted', [tags.login || 'unknown']),
        targetUser: tags.login || '',
        targetMsgId: targetMsgId || '',
      }
    }

    // WHISPER: @tags :user!user@user.tmi.twitch.tv WHISPER yourname :message
    const whisper = raw.match(/WHISPER \S+ :(.+)$/)
    if (whisper) {
      return {
        type: 'whisper',
        user: tags['display-name'] || 'anonymous',
        userId: tags['user-id'],
        text: flatStr(whisper[1]),
        color: sanitizeColor(tags.color || '#fff'),
        badges: tags.badges || '',
        time: parseInt(tags['tmi-sent-ts'], 10) || parseInt(tags['rm-received-ts'], 10) || Date.now(),
        id: tags['message-id'] || '',
      }
    }

    return null
  } catch (_) {
    return null
  }
}

// V8 represents substrings/regex captures over ~13 chars as SlicedString —
// a pointer into the PARENT string, which stays fully alive for GC purposes.
// Message fields built that way pin the entire raw IRC line (300-1000B of tag
// soup) in the 3000-msg buffers for the field's whole lifetime. Concat+slice
// forces a flat copy that drops the parent reference. Measured on the real
// parser: 1282 → 947 B/msg retained (-26%, ~1MB per full buffer). Lives HERE
// (after parseIrcLine, before CircularBuffer) so send-reject-inline-row's
// source-carve of parseTags+parseIrcLine picks it up via hoisting.
function flatStr(s) {
  return s && s.length > 12 ? (' ' + s).slice(1) : s
}

// ============================================
// CIRCULAR BUFFER FOR CHANNEL MESSAGES
// ============================================
class CircularBuffer {
  constructor(cap = 1500) {
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
    // Concat instead of spread — avoids 2 temporary arrays
    return this.buf.slice(this.head).concat(this.buf.slice(0, this.head))
  }
  // Newest `n` items only (fewer if size < n) — O(n) instead of getAll()'s
  // O(size) (up to `cap`, 3000 on the twitch/kick buffers). The render path
  // never needs more than its DOM cap + scrollback window, so callers that
  // only paint the tail should use this instead of getAll().
  tail(n) {
    const count = Math.min(n, this.size)
    if (count === 0) return []
    const out = new Array(count)
    let idx = (this.head - 1 + this.cap) % this.cap
    for (let i = count - 1; i >= 0; i--) {
      out[i] = this.buf[idx]
      idx = (idx - 1 + this.cap) % this.cap
    }
    return out
  }
  // Ordered-insert counterpart to push() — keeps the ring non-decreasing by
  // ordOf (see src/lib/utils.js) instead of blindly appending. Fast path
  // (item is newest-or-tied, the overwhelming common case) is push()'s exact
  // O(1). The rare out-of-order arrival (backfill/replay/native-tap race)
  // rebuilds the ring from a sorted-array splice; if the item is older than
  // everything AND the ring is already full, it's dropped outright — the
  // ring would evict it right back out anyway, so this is a no-op, not a loss.
  insertOrdered(item, getOrd = ordOf) {
    if (this.size === 0) {
      this.push(item)
      return
    }
    const lastIdx = (this.head - 1 + this.cap) % this.cap
    if (getOrd(this.buf[lastIdx]) <= getOrd(item)) {
      this.push(item)
      return
    }
    const all = this.getAll()
    const idx = findOrdInsertIndex(all, getOrd(item), getOrd)
    if (idx === 0 && all.length >= this.cap) return // older than the oldest kept slot
    all.splice(idx, 0, item)
    if (all.length > this.cap) all.shift()
    this.head = 0
    this.size = 0
    for (const m of all) this.push(m)
  }
  clear() {
    this.buf = new Array(this.cap)
    this.head = 0
    this.size = 0
  }
}

// ============================================
// TWITCH IRC CLIENT (READ-ONLY)
// ============================================
// Shared base for the two chat transports (IRC, KickChat). Holds the surface
// they duplicate verbatim: per-channel CircularBuffer map, listener registry,
// and the O(1)/copy accessors main.js consumes. Transport wiring, dedup, and
// persistence stay in the subclasses — they genuinely differ.
class ChatClient {
  constructor(logTag) {
    this._logTag = logTag
    this.channels = new Map() // channel -> CircularBuffer
    this.handlers = new Map()
    this._destroyed = false
  }

  getMessages(ch) {
    return this.channels.get(ch?.toLowerCase())?.getAll() || []
  }

  // Bounded copy of just the newest `n` messages — see CircularBuffer.tail().
  // Render call sites that only ever paint a tail window should use this
  // instead of getMessages()/getAll() (which copy the whole buffer, up to
  // `cap`, every call).
  getTail(ch, n) {
    return this.channels.get(ch?.toLowerCase())?.tail(n) || []
  }

  // O(1) message count — "any messages?" hot-path callers must not
  // materialize ~6000-element buffer copies per live message (Kripp scale).
  getCount(ch) {
    return this.channels.get(ch?.toLowerCase())?.size || 0
  }

  on(e, fn) {
    if (!this.handlers.has(e)) this.handlers.set(e, new Set())
    this.handlers.get(e).add(fn)
  }

  emit(e, d) {
    this.handlers.get(e)?.forEach((fn) => {
      try {
        fn(d)
      } catch (err) {
        console.error(`[${this._logTag}] handler err:`, err)
      }
    })
  }
}

class IRC extends ChatClient {
  // SW-owned mode: BG SW owns the WebSocket. This class is a thin client —
  // it joins/parts via runtime messages, mirrors per-channel buffers locally
  // so existing main.js code can keep using `irc.channels.get(ch).getAll()`
  // synchronously, and forwards live events from BG to local listeners.
  // Authenticated send still flows through auth-irc.js (per-tab, OAuth).
  constructor() {
    super('heatsync-irc')
    // Message-id dedupe — live messages can now arrive from BOTH the BG IRC
    // relay and the native-chat tap; history merges seed it so replays never
    // double-render. FIFO-capped.
    this._seenIds = new Set()
    this._seenIdOrder = []
    // per-channel last NON-TAP live delivery — the native tap defers to IRC
    // when this is fresh (IRC copies carry replies/bits/highlight richness)
    this._lastLiveAt = new Map()
    // O(1) mod-notice dedup indices — keyed by "ch:targetLc" and "ch:targetMsgId"
    // respectively. Each stores the first-wins notice object so time-window and
    // _supersededByUnban checks can be done without scanning the full buffer.
    // Capped at 500 entries (FIFO eviction) so they can't grow unbounded.
    this._modNoticeIndex = new Map()
    this._deleteNoticeIndex = new Map()
    this._listener = (message) => {
      if (this._destroyed || !message || typeof message !== 'object') return
      if (message.type === 'bg_irc_msg') {
        this._handleMsg(message.msg)
      } else if (message.type === 'bg_irc_history_merged') {
        this._refreshFromBg(message.channel)
      }
    }
    cleanup.addListener(chrome.runtime?.onMessage, this._listener)
    // Global twitch badges (mod sword, vip diamond, subscriber/0 star, etc.)
    // were previously fetched in irc.ws.onopen — removed when WebSocket moved
    // to BG. Without this, mod/sub fall back to TEXT badges instead of images.
    try {
      fetchGlobalBadges()
    } catch {}
  }

  _seenId(id) {
    if (!id) return false
    if (this._seenIds.has(id)) return true
    this._seenIds.add(id)
    this._seenIdOrder.push(id)
    if (this._seenIdOrder.length > 6000) {
      for (let i = 0; i < 1000; i++) this._seenIds.delete(this._seenIdOrder[i])
      this._seenIdOrder.splice(0, 1000)
    }
    return false
  }

  _handleMsg(msg) {
    if (!msg) return
    // dedupe plain chat by (channel, id) — same id is legit across channels
    // in shared-chat sessions; BG IRC vs native tap is the real dupe source
    if (!msg.type && msg.id && this._seenId(`${msg.channel}:${msg.id}`)) {
      // A duplicate is not always redundant. The same message arrives twice —
      // once over IRC (carries reply-parent tags) and once from the native DOM
      // tap (best-effort reply extraction off an undocumented twitch internal
      // shape that "drifts across twitch builds"). Whichever lands FIRST claims
      // the id and the other copy was dropped whole, so when the tap won, the
      // reply context was gone: no "replying to" bar, and — since a native
      // reply to you became a mention — no red either.
      //
      // Don't re-render the message; just hand the missing piece upward. The
      // repair that already existed for this only covered messages YOU sent
      // (gated on sentHost), never someone else's reply to you.
      if (msg.replyTo?.user) this.emit('reply-ctx', msg)
      return
    }
    if (!msg.type && !msg.fromNativeTap && !msg.isHistory && msg.channel) {
      // rolling window of recent non-tap deliveries — the tap defers only to
      // HEALTHY flow (3+ msgs in 10s), not to a starved trickle where a
      // single message would otherwise carve 10s holes in coverage
      let ts = this._lastLiveAt.get(msg.channel)
      if (!Array.isArray(ts)) {
        ts = []
        this._lastLiveAt.set(msg.channel, ts)
      }
      ts.push(Date.now())
      if (ts.length > 5) ts.splice(0, ts.length - 5)
      if (this._lastLiveAt.size > 300) {
        const k0 = this._lastLiveAt.keys().next().value
        this._lastLiveAt.delete(k0)
      }
    }
    // USERSTATE: viewer's per-channel badges (used to gate sub-emote rendering)
    if (msg.type === 'userstate') {
      if (typeof viewerBadgesPerChannel !== 'undefined') {
        const badges = msg.badges instanceof Set ? msg.badges : new Set(Array.isArray(msg.badges) ? msg.badges : [])
        viewerBadgesPerChannel.set(msg.channel, badges)
        if (viewerBadgesPerChannel.size > 300) {
          const k0 = viewerBadgesPerChannel.keys().next().value
          viewerBadgesPerChannel.delete(k0)
        }
      }
      // rawBadges carries the full tag string with tier suffixes — feed it
      // into the per-channel own-badges cache so synthetic resub/watchstreak
      // celebrations render with the right sub tier on first-render (before
      // the user has sent a PRIVMSG on this channel).
      if (typeof _ownBadgesByChannel !== 'undefined' && msg.rawBadges) {
        _ownBadgesByChannel.set(String(msg.channel).toLowerCase(), msg.rawBadges)
      }
      return
    }
    if (msg.type === 'whisper') return // whispers come via EventSub now
    if (msg.type === 'roomstate') return // BG already converted to mode_change notice
    const ch = msg.channel
    if (!ch || !this.channels.has(ch)) return
    if (msg.user) {
      try {
        addUsername(msg.user)
      } catch {}
      try {
        setKnownColor(msg.user.toLowerCase(), msg.color, msg.userId, 'twitch')
      } catch {}
    }
    if (msg.subMonths) {
      try {
        trackSubTenure(ch, msg.user, msg.subMonths)
      } catch {}
    }
    try {
      fetchChannelBadges(ch)
    } catch {}
    if (!msg.type || msg.type === 'usernotice' || msg.type === 'notice') {
      const buf = this.channels.get(ch)
      // A single timeout/ban reaches us many ways: the CLEARCHAT (everyone), the
      // mod-only timeout_success/ban_success NOTICE, the direct-IRC vs server
      // EventSub fanout, and the native tap. EventSub can even drop the timeout
      // duration, surfacing a bogus "permanently banned" beside the real "timed
      // out for Ns". Collapse them all: the first mod notice for a target wins
      // within the window (matched across timeout/ban since they're the same act).
      if (msg.type === 'notice' && (msg.noticeType === 'timeout_success' || msg.noticeType === 'ban_success')) {
        const tm = (msg.text || '').match(/^(\S+) has been/)
        const targetLc = (msg.targetUser || '').toLowerCase() || (tm ? tm[1].toLowerCase() : '')
        if (targetLc) {
          const idxKey = `${ch}:${targetLc}`
          const existing = this._modNoticeIndex.get(idxKey)
          // A later unban for this target retired the prior ban — don't collapse
          // a fresh re-ban against it (ban→unban→ban must show every step).
          if (existing && !existing._supersededByUnban) {
            // A local synthetic carries client Date.now(); the real IRC copy
            // carries Twitch's server tmi-sent-ts. Under clock skew those can
            // differ by >10s, defeating the collapse and double-rendering. Widen
            // to 30s whenever a synthetic is on either side; keep the tight 10s
            // for real-vs-real (multi-transport fanout of one server event).
            const win = existing.isSynthetic || msg.isSynthetic ? 30000 : 10000
            if (Math.abs((existing.time || 0) - (msg.time || 0)) <= win) return
          }
          // First/winning notice for this target in this window — record it.
          if (this._modNoticeIndex.size >= 500) this._modNoticeIndex.delete(this._modNoticeIndex.keys().next().value)
          this._modNoticeIndex.set(idxKey, msg)
        }
      }
      // Same first-wins collapse for deletes: our optimistic local inject and the
      // real CLEARMSG carry the same target-msg-id. Keep whichever lands first
      // (the actor-attributed local line, or the IRC line if it raced ahead) —
      // never render both for one deletion. target-msg-id is unique per message,
      // so the window only separates a synthetic from its own real echo.
      if (msg.type === 'notice' && msg.noticeType === 'delete_message_success' && msg.targetMsgId) {
        const idxKey = `${ch}:${msg.targetMsgId}`
        const existing = this._deleteNoticeIndex.get(idxKey)
        if (existing) {
          const win = existing.isSynthetic || msg.isSynthetic ? 30000 : 10000
          if (Math.abs((existing.time || 0) - (msg.time || 0)) <= win) return
        }
        // First/winning delete for this msg-id — record it.
        if (this._deleteNoticeIndex.size >= 500)
          this._deleteNoticeIndex.delete(this._deleteNoticeIndex.keys().next().value)
        this._deleteNoticeIndex.set(idxKey, msg)
      }
      // Ordered insert, not blind push — a BG history merge or native-tap
      // copy can race a live PRIVMSG and land here with an OLDER tmi-sent-ts,
      // which would otherwise silently break the buffer's sortedness that
      // fairMerge/mergeSortedRuns (main.js) depend on.
      buf.insertOrdered(msg)
      // Relay PRIVMSGs to server archive (ON CONFLICT DO NOTHING dedupes across
      // multiple viewers). Skip replays from BG history merge.
      if (!msg.type && !msg.isHistory && !msg.isSynthetic && msg.user && msg.text && msg.id) {
        try {
          chrome.runtime
            .sendMessage({
              type: 'ws_send',
              data: {
                type: 'twitch:chat:relay',
                channel: ch,
                username: msg.login || String(msg.user).toLowerCase(),
                display_name: msg.user,
                message: msg.text,
                message_id: msg.id,
                timestamp: msg.time || Date.now(),
                emote_refs: msg.twitchEmotes ? { twitch: msg.twitchEmotes } : null,
                reply_to_id: msg.replyTo?.id || null,
              },
            })
            .catch((e) => log('archive relay failed:', e?.message || e))
        } catch (e) {
          log('archive relay failed:', e?.message || e)
        }
      }
      if (msg.type === 'notice') {
        // An unban retires any prior ban/timeout notice for this target so the
        // dedup above won't suppress a subsequent re-ban within the window.
        if (msg.noticeType === 'unban_success' && msg.targetUser) {
          const tlc = msg.targetUser.toLowerCase()
          for (const m of buf.getAll()) {
            if (
              m.type === 'notice' &&
              (m.noticeType === 'ban_success' || m.noticeType === 'timeout_success') &&
              (m.targetUser || '').toLowerCase() === tlc
            ) {
              m._supersededByUnban = true
            }
          }
        }
        if (msg.noticeType === 'ban_success' || msg.noticeType === 'timeout_success') {
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
        if (msg.noticeType === 'delete_message_success' && msg.targetMsgId) {
          const id = msg.targetMsgId
          for (const m of buf.getAll()) {
            if (m.id === id) {
              m.cleared = true
              m.clearedReason = 'deleted'
              break
            }
          }
        }
      }
      this.emit('message', msg)
    }
  }

  // BG performed a robotty merge — reflect the updated buffer locally.
  // Per-msg work is staged through hsSched.chunk: a fat bg buffer (up to 3000
  // msgs/channel after hours of SW uptime) ingested in one synchronous loop
  // froze the page ~0.5-1s on reload. Overlapping merges for the same channel
  // coalesce via a busy/dirty pair instead of racing the buffer swap.
  async _refreshFromBg(ch) {
    if (!this.channels.has(ch)) return
    this._refreshBusy ||= new Set()
    this._refreshDirty ||= new Set()
    if (this._refreshBusy.has(ch)) {
      this._refreshDirty.add(ch)
      return
    }
    this._refreshBusy.add(ch)
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'bg_irc_history', channel: ch })
      if (!resp?.ok) return
      const wasSize = this.channels.get(ch)?.size ?? 0
      try {
        if (typeof _recentSentHydrated !== 'undefined') await _recentSentHydrated
      } catch {}
      const staged = []
      await hsSched.chunk(
        resp.msgs || [],
        (m) => {
          if (m?.type === 'roomstate' || m?.type === 'userstate' || m?.type === 'whisper') return
          m.isHistory = true
          if (m.user) {
            try {
              addUsername(m.user)
            } catch {}
            try {
              setKnownColor(m.user.toLowerCase(), m.color, m.userId, 'twitch')
            } catch {}
          }
          if (m.subMonths) {
            try {
              trackSubTenure(ch, m.user, m.subMonths)
            } catch {}
          }
          try {
            const sentHost = peekSentHost(m.text)
            if (sentHost) {
              // Cross-device simulcast replay: only ONE leg per send renders.
              if (claimHydratedEcho(m.text, 'twitch', m.time)) m.hidden = true
              m.badgePlatform = 'twitch'
              m.platform = sentHost === 'yt' ? 'youtube' : sentHost
            }
          } catch {}
          if (m.id) this._seenId(`${ch}:${m.id}`)
          staged.push(m)
        },
        { budgetMs: 5, respectScroll: false },
      )
      const buf = this.channels.get(ch)
      if (!buf) return // channel left during staging
      // Snapshot live messages AFTER staging — anything that arrived while we
      // yielded (or during the sendMessage await) stays newest, not buried
      // behind history.
      const liveSnap = buf.getAll().filter((m) => !m.isHistory)
      buf.clear()
      for (const m of staged) buf.push(m)
      for (const m of liveSnap) buf.push(m)
      try {
        _dropAllTabCaches()
      } catch {}
      // Rebuild when empty OR when a real backfill landed (delta ≥ 5). Small
      // incremental merges skip to avoid streamer-switch flash; large history
      // hydrations always rebuild so the DOM matches the buffer.
      const isCurrent = currentTab === ch || (currentTab === 'live' && getLiveChannel() === ch)
      const delta = buf.size - wasSize
      if (isCurrent && (isMsgsElEmpty() || delta >= 5)) {
        scheduleRenderMessages()
      }
    } catch (e) {
      log('BG history refresh failed:', e?.message)
    } finally {
      this._refreshBusy.delete(ch)
      if (this._refreshDirty.delete(ch)) this._refreshFromBg(ch)
    }
  }

  connect() {
    /* BG owns the WebSocket */
  }

  async join(ch) {
    ch = ch.toLowerCase()
    if (this.channels.has(ch)) return
    this.channels.set(ch, new CircularBuffer(3000))
    log('Joined', ch)
    // Pre-warm channel badges (sub tiers, FFZ custom mod/vip overrides) so
    // restored history from BG renders with proper images on first paint.
    try {
      fetchChannelBadges(ch)
    } catch {}
    // Route through safeSendMessage so cold-SW wake retries — direct sendMessage
    // here silently lost the join on SW eviction, BG never joined the channel,
    // own PRIVMSG echoes never returned, user had to refresh to recover.
    // safeSendMessage never rejects (resolves {ok:false} on failure), so inspect
    // the result and retry with backoff — a SW restart longer than its budget
    // otherwise loses the join forever (channels.set above blocks re-entry).
    const sendJoin = (attempt) => {
      safeSendMessage({ type: 'bg_irc_join', channel: ch }).then((r) => {
        if (r && r.ok !== false) return
        if (!this.channels.has(ch)) {
          // Channel was removed (tab closed) during the retry backoff — not
          // our failure to report, nothing left to clean up.
          log('BG join failed for', ch, '(already removed)')
          return
        }
        if (attempt >= 3) {
          log('BG join failed for', ch, '- giving up after', attempt + 1, 'attempts')
          // channels.set() above blocks join()'s re-entry guard forever —
          // without this a failed join permanently empties the tab until the
          // user manually refreshes. Delete so a later join(ch) can retry.
          this.channels.delete(ch)
          try {
            showToast(t('mc_irc_join_failed', [ch]), 'error')
          } catch (_) {}
          return
        }
        setTimeout(() => sendJoin(attempt + 1), 2000 * (attempt + 1))
      })
    }
    try {
      sendJoin(0)
    } catch {}
    // Pull initial buffer from BG (in-memory; instant on warm SW). Await the
    // sent-message storage hydration first so own-message [K]/[H]/[Y] badges
    // survive page refresh — otherwise peekSentHost can race with this load
    // and miss the host override, reverting the badge to the echo's actual
    // origin (twitch).
    try {
      if (typeof _recentSentHydrated !== 'undefined') await _recentSentHydrated
    } catch {}
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'bg_irc_history', channel: ch })
      if (resp?.ok && Array.isArray(resp.msgs) && resp.msgs.length > 0) {
        const buf = this.channels.get(ch)
        for (const m of resp.msgs) {
          if (m?.type === 'roomstate' || m?.type === 'userstate' || m?.type === 'whisper') continue
          m.isHistory = true
          if (m.user) {
            try {
              addUsername(m.user)
            } catch {}
            try {
              setKnownColor(m.user.toLowerCase(), m.color, m.userId, 'twitch')
            } catch {}
          }
          if (m.subMonths) {
            try {
              trackSubTenure(ch, m.user, m.subMonths)
            } catch {}
          }
          // Host attribution override — IRC echo arrives as platform='twitch';
          // if we tracked this exact text as a kick/yt/heatsync send, retag.
          try {
            const sentHost = peekSentHost(m.text)
            if (sentHost) {
              // Cross-device simulcast replay: only ONE leg per send renders.
              if (claimHydratedEcho(m.text, 'twitch', m.time)) m.hidden = true
              m.badgePlatform = 'twitch'
              m.platform = sentHost === 'yt' ? 'youtube' : sentHost
            }
          } catch {}
          buf.push(m)
        }
        log('BG history hydrated:', resp.msgs.length, 'msgs for', ch)
        try {
          _dropAllTabCaches()
        } catch {}
        // Always render if we just hydrated any history and panel is current —
        // a few live msgs may have painted before this resolved, but the buf
        // now has more (history below them) and must be reflected in DOM.
        const isCurrent = currentTab === ch || (currentTab === 'live' && getLiveChannel() === ch)
        if (isCurrent && resp.msgs.length > 0) {
          scheduleRenderMessages()
        }
      }
    } catch (e) {
      log('BG history fetch failed:', e?.message)
    }
    // Self-healing: if BG returned 0 msgs (cold SW / robotty still in flight)
    // OR broadcast was lost, re-pull at 3s + 8s + 20s. Cheap (single message,
    // no fetch) and idempotent — _refreshFromBg only mutates when SW has data.
    for (const delay of [3000, 8000, 20000]) {
      cleanup.setTimeout(() => {
        if (this._destroyed || !this.channels.has(ch)) return
        if ((this.channels.get(ch)?.size || 0) >= 200) return
        this._refreshFromBg(ch)
      }, delay)
    }
  }

  part(ch) {
    ch = ch.toLowerCase()
    if (!this.channels.has(ch)) return
    this.channels.delete(ch)
    // Purge mod-notice index entries for the parted channel to prevent stale
    // accumulation; spread to avoid mutating the map during iteration.
    const prefix = `${ch}:`
    for (const k of [...this._modNoticeIndex.keys()]) if (k.startsWith(prefix)) this._modNoticeIndex.delete(k)
    for (const k of [...this._deleteNoticeIndex.keys()]) if (k.startsWith(prefix)) this._deleteNoticeIndex.delete(k)
    log('Parted', ch)
    try {
      chrome.runtime.sendMessage({ type: 'bg_irc_part', channel: ch }).catch(() => {})
    } catch {}
  }

  // getMessages/getCount/on/emit inherited from ChatClient

  destroy() {
    this._destroyed = true
    if (this._listener) {
      try {
        chrome.runtime?.onMessage?.removeListener(this._listener)
      } catch {}
      this._listener = null
    }
  }
}

// ============================================
// KICK CHAT CLIENT (VIA HEATSYNC WEBHOOK)
// ============================================
class KickChat extends ChatClient {
  constructor() {
    super('heatsync-kick')
    this._listener = null
    this._persistTimers = {}
    this._PERSIST_MAX = 1500
    this._PERSIST_DEBOUNCE_MS = 1500
    this._SYNC_BACKUP_MAX = 200
    this._pendingChannels = new Set()
    this._recentLiveIds = new Set() // Kick message-id dedup across server-relay + Pusher-tap sources
    // Self-inflicted mod actions (toolbar/slash) inject a synthetic notice
    // immediately; the Pusher tap then reflects the same action back —
    // without this index every self-mod on a tapped channel prints twice.
    this._selfModIndex = new Map() // `${slug}|${noticeType}|${target}` → ts
    // Per-channel watchdog. Kick traffic flows BG → runtime.sendMessage →
    // this._listener; if anything between us and the heatsync server drops
    // a sub silently (BG WS reconnected before our ws_send made it through,
    // server lost the join state, etc.) we'd never know. Watchdog re-asserts
    // channel:join when a channel goes too quiet.
    this._chanLastSeen = new Map()
    this._chanRejoinAttempts = new Map() // ch -> escalation count
    this._watchdogTimer = null
    // Synchronous flush of pending channel buffers on tear-down — closes the
    // chrome.storage.local debounce gap that was eating ~5s of pre-reload chat.
    this._pagehideHandler = () => this._flushPendingSync()
    window.addEventListener('pagehide', this._pagehideHandler)
  }

  // Record a self-inflicted mod action so the Pusher-tap reflection of the
  // same action is collapsed instead of printing a second system line.
  noteSelfMod(slug, noticeType, target) {
    const key = `${(slug || '').toLowerCase()}|${noticeType}|${(target || '').toLowerCase()}`
    const now = Date.now()
    for (const [k, ts] of this._selfModIndex) if (now - ts > 10000) this._selfModIndex.delete(k)
    if (this._selfModIndex.size >= 50) this._selfModIndex.delete(this._selfModIndex.keys().next().value)
    this._selfModIndex.set(key, now)
  }

  // Consume a matching self-mod record (±10s). One-shot: a match deletes the
  // entry so a genuine repeat action a moment later still prints.
  _consumeSelfMod(slug, noticeType, target) {
    const key = `${(slug || '').toLowerCase()}|${noticeType}|${(target || '').toLowerCase()}`
    const ts = this._selfModIndex.get(key)
    if (ts === undefined) return false
    this._selfModIndex.delete(key)
    return Date.now() - ts <= 10000
  }

  _serializeMsg(m) {
    if (m?.type === 'moment') return null // ephemeral alert — broken after restore (loses click target)
    // id/userId/cleared must survive persistence — the BG SW writes the same
    // hs_kick_ key with full msgs, and restored rows without ids break id-dedup
    // (backfill duplicates), moderation dimming, and reply-parent lookup.
    return {
      id: m.id || undefined,
      userId: m.userId || undefined,
      user: m.user,
      text: m.text,
      color: m.color,
      badges: m.badges,
      channel: m.channel,
      time: m.time,
      platform: 'kick',
      type: m.type || undefined,
      systemMsg: m.systemMsg || undefined,
      replyTo: m.replyTo || undefined,
      kicksEvent: m.kicksEvent || undefined,
      cleared: m.cleared || undefined,
      clearedReason: m.clearedReason || undefined,
    }
  }

  _flushPendingSync() {
    // Kick chat history is backed exclusively by chrome.storage.local (NOT
    // host-page localStorage, which would expose it to kick.com scripts and
    // co-resident extensions). On pagehide we drain every debounced write
    // synchronously — the storage.local.set is dispatched to the extension
    // backend and survives the page unload, closing the ~1.5s debounce gap that
    // was silently dropping the tail of Kick chat on reload/close.
    for (const ch of [...this._pendingChannels]) {
      const t = this._persistTimers[ch]
      if (t) {
        cleanup.clearTimeout(t)
        delete this._persistTimers[ch]
      }
      this._pendingChannels.delete(ch)
      this._persistChannelNow(ch)
    }
  }

  _touchChannel(ch) {
    if (!ch) return
    this._chanLastSeen.set(ch, Date.now())
    if (this._chanRejoinAttempts.size) this._chanRejoinAttempts.delete(ch)
  }

  // One kick chat payload (server-relay/BG-tap shape) → buffer + render emit.
  // Extracted from the kick_chat_message listener so the page-level native
  // tap (kick-native-tap.js) can feed the SAME path. opts.fromNativeTap
  // skips the watchdog touch — tap traffic must not mask a dead primary
  // (the watchdog's escalation rungs are what bring the primary back), and
  // stamps the msg for provenance, mirroring twitch's native-tap flag.
  ingestChatPayload(d, opts) {
    const channel = d.channel?.toLowerCase()
    const fromNativeTap = !!opts?.fromNativeTap
    if (!fromNativeTap) this._touchChannel(channel)
    if (!channel || !this.channels.has(channel)) return
    // Dedup by Kick message id — the same message can arrive from the server
    // webhook relay, the BG Pusher tap, AND the page-level native tap; keep
    // only the first. (touchChannel above still ran so the watchdog sees
    // primary liveness.)
    if (d.id) {
      if (this._recentLiveIds.has(d.id)) return
      this._recentLiveIds.add(d.id)
      if (this._recentLiveIds.size > 800) this._recentLiveIds.delete(this._recentLiveIds.values().next().value)
    }
    // Convert Kick badge objects to Twitch-style "name/version" string.
    // Kick WS payload uses {type, text, count} per badge; some pass-through
    // paths re-shape to {name, version}. Accept BOTH so type-shape payloads
    // don't collapse to 'badge/1' (which has no BADGE_STYLES entry → blank).
    const badgeStr = Array.isArray(d.badges)
      ? d.badges.map((b) => `${b.type || b.name || 'badge'}/${b.version || b.count || '1'}`).join(',')
      : ''
    const msg = {
      id: d.id || '',
      user: d.username || 'unknown',
      text: d.content || '',
      color: d.color || '#53fc18',
      badges: badgeStr,
      channel,
      time: d.timestamp || Date.now(),
      platform: 'kick',
      // numeric kick USER id (pusher tap + server relay both forward it);
      // setKnownColor below already read msg.userId — it was undefined
      // for every kick message until this landed
      userId: d.senderId != null ? String(d.senderId) : '',
      replyTo: d.replyTo
        ? {
            user: d.replyTo.username || 'unknown',
            text: d.replyTo.content || '',
            // `messageId` first — that is what the heatsync server actually
            // sends for kick (kick-chat-webhooks builds {messageId, content,
            // username}). Reading only .id/.message_id matched neither, so the
            // bar rendered from username/content while the id came out empty:
            // reply-thread hover was dead on kick, and ext-archived kick
            // replies wrote a null reply_to_id. The other two spellings stay as
            // fallbacks for the raw-payload paths.
            id: d.replyTo.messageId || d.replyTo.id || d.replyTo.message_id || '',
            threadId: d.replyTo.thread_id || d.replyTo.messageId || d.replyTo.id || d.replyTo.message_id || '',
          }
        : null,
    }
    // Server-enriched third-party emote refs (name→{url,provider,zeroWidth}) —
    // the sender's inventory emotes resolved server-side, so they render without
    // a per-sender fetch. Absent on native-tap payloads (server-only). See
    // emote-enrich.ts.
    if (d.hsEmotes && typeof d.hsEmotes === 'object') msg.hsEmotes = d.hsEmotes
    if (fromNativeTap) msg.fromNativeTap = true
    // Ordered insert — the server webhook relay, the BG Pusher tap, and the
    // native tap can each deliver the same window's messages with a
    // slightly different arrival order; insertOrdered keeps the buffer
    // sorted by real timestamp instead of raw arrival.
    this.channels.get(channel).insertOrdered(msg)
    if (msg.user) {
      addUsername(msg.user)
      setKnownColor(msg.user.toLowerCase(), msg.color, msg.userId, 'kick')
    }
    this.persistBuffer(channel)
    this.emit('message', msg)
  }

  // One kick moderation event (ban/timeout/delete/unban) → buffer dims +
  // notice emit. Extracted from the kick_moderation listener so the page-
  // level native tap can feed the SAME path.
  ingestModeration(message) {
    const channel = message.channel.toLowerCase()
    if (!this.channels.has(channel)) return
    const buf = this.channels.get(channel)
    const action = message.action
    const targetLc = (message.targetUser || '').toLowerCase()
    if ((action === 'ban' || action === 'timeout') && targetLc) {
      const reason = message.banDuration ? `timed out (${message.banDuration}s)` : 'banned'
      for (const m of buf.getAll()) {
        if (!m.cleared && (m.user || '').toLowerCase() === targetLc) {
          m.cleared = true
          m.clearedReason = reason
        }
      }
    } else if (action === 'delete' && message.targetMsgId) {
      for (const m of buf.getAll()) {
        if (m.id === message.targetMsgId && !m.cleared) {
          m.cleared = true
          m.clearedReason = 'deleted'
          break
        }
      }
    } else if (action === 'unban' && targetLc) {
      // Best-effort un-dim: only lift ban/timeout dims (not deletes).
      for (const m of buf.getAll()) {
        if (m.cleared && (m.user || '').toLowerCase() === targetLc && m.clearedReason !== 'deleted') {
          m.cleared = false
          delete m.clearedReason
        }
      }
    }
    this.persistBuffer(channel)
    const target = message.targetUser || ''
    const noticeType =
      action === 'delete'
        ? 'delete_message_success'
        : action === 'unban'
          ? 'unban_success'
          : action === 'timeout'
            ? 'timeout_success'
            : 'ban_success'
    // Self-mod dedup: the toolbar already injected a synthetic notice for
    // this exact action — the buffer dim above still applies, but a second
    // system line (and duplicate mod-log entry) must not.
    if (this._consumeSelfMod(channel, noticeType, action === 'delete' ? message.targetMsgId : targetLc)) return
    const text =
      action === 'delete'
        ? `a message was deleted`
        : action === 'unban'
          ? `${target} was unbanned`
          : action === 'timeout'
            ? `${target} timed out for ${message.banDuration || 1}s`
            : `${target} was banned`
    this.emit('message', {
      type: 'notice',
      noticeType,
      platform: 'kick',
      channel,
      user: 'system',
      text,
      systemMsg: text,
      color: '#808080',
      badges: '',
      time: Date.now(),
      id: `kickmod-${channel}-${target || message.targetMsgId || ''}-${noticeType}-${Date.now()}`,
      targetUser: target,
      targetUserId: message.targetUserId || '',
      targetMsgId: message.targetMsgId || '',
      banDuration: message.banDuration || 0,
      // Kick's AI moderation deletes messages constantly — a visible line per
      // deletion would flood chat, and the dim already conveys it. So a delete
      // is dim-only (hidden line); bans/timeouts/unbans keep their system line.
      hidden: action === 'delete',
    })
    return
  }

  _startWatchdog() {
    if (this._watchdogTimer) return
    this._watchdogTimer = cleanup.setInterval(() => {
      if (this._destroyed) return
      const now = Date.now()
      for (const ch of this.channels.keys()) {
        const last = this._chanLastSeen.get(ch) || 0
        if (!last) continue
        // Escalate the response when a Kick channel keeps coming up silent.
        // Each rung is more invasive but recovers a different failure class:
        //   1) re-assert join — server forgot us, idempotent on Kick
        //   2) leave+join — server thinks we're already subbed; force fresh
        //   3) BG WS force-reconnect — BG itself is in zombie state
        // Tick is 30s, so worst-case dead window before rung 1 is 120s.
        if (now - last <= 90000) continue
        const attempts = this._chanRejoinAttempts.get(ch) || 0
        const silenceS = Math.round((now - last) / 1000)
        if (attempts === 0) {
          log('Kick channel', ch, 'silent', silenceS, 's — re-asserting channel:join')
          safeSendMessage({ type: 'ws_send', data: { type: 'channel:join', platform: 'kick', channel: ch } })
        } else if (attempts === 1) {
          log('Kick channel', ch, 'still silent', silenceS, 's after re-join — leave+join to force fresh sub')
          safeSendMessage({ type: 'ws_send', data: { type: 'channel:leave', platform: 'kick', channel: ch } })
          safeSendMessage({ type: 'ws_send', data: { type: 'channel:join', platform: 'kick', channel: ch } })
        } else {
          log('Kick channel', ch, 'unresponsive', silenceS, 's after', attempts, 'attempts — asking BG to reconnect WS')
          safeSendMessage({ type: 'ws_force_reconnect', source: 'kick_watchdog', channel: ch })
          // After this we let the BG cycle do its thing; reset attempt counter
          // so the next watchdog tick doesn't immediately escalate again
          // (BG reconnect takes ~1-3s, fresh traffic should disarm us).
          this._chanRejoinAttempts.set(ch, 0)
          this._chanLastSeen.set(ch, now)
          continue
        }
        this._chanRejoinAttempts.set(ch, attempts + 1)
        // Disarm one cycle; real traffic resumes _chanLastSeen via the listener.
        this._chanLastSeen.set(ch, now)
      }
    }, 30000)
  }

  _stopWatchdog() {
    if (this._watchdogTimer) {
      cleanup.clearInterval(this._watchdogTimer)
      this._watchdogTimer = null
    }
  }

  connect() {
    if (this._destroyed) return
    if (this._listener) return

    // Listen for kick chat messages relayed from background.js
    this._listener = (message) => {
      // BG ingested a server-side backfill batch — refresh our local mirror
      // from BG so the DOM reflects the newly merged history.
      if (message.type === 'bg_kick_history_merged' && message.channel) {
        this._refreshFromBg(message.channel)
        return
      }
      if (message.type === 'kick_chat_message' && message.data) {
        this.ingestChatPayload(message.data)
        return
      }

      // Kick moderation (ban/timeout/delete/unban) observed on the Pusher tap —
      // reflect it like Twitch's CLEARCHAT/CLEARMSG: flag the offender's buffer
      // entries `cleared` (so re-renders keep the dim) and emit a notice-shaped
      // message so main.js's irc.on('message') dims the live DOM, prints the
      // system line, and records the mod-action log — all shared, platform-blind.
      if (message.type === 'kick_moderation' && message.channel) {
        this.ingestModeration(message)
        return
      }

      // Kick chat-mode banners (slow/sub-only/emote-only/followers) — BG
      // already converted the Pusher ChatroomUpdatedEvent into a mode_change
      // notice shaped exactly like Twitch's ROOMSTATE→mode_change (see
      // main.js's noticeKind mapping), platform-tagged kick.
      if (message.type === 'kick_mode_change' && message.channel && message.msg) {
        const channel = message.channel.toLowerCase()
        if (!this.channels.has(channel)) return
        const msg = message.msg
        this.channels.get(channel).push(msg)
        this.persistBuffer(channel)
        this.emit('message', msg)
        return
      }

      // Kick pinned messages — same gold notice line twitch's pinned-chat
      // pubsub renders (main.js noticeKind 'pin'), shaped like the mode_change
      // branch above so it rides the shared usernotice path.
      if (message.type === 'kick_pin_event' && message.channel) {
        const channel = message.channel.toLowerCase()
        if (!this.channels.has(channel)) return
        const by = message.sender ? ` ${message.sender}:` : ':'
        const msg = {
          user: message.sender || 'system',
          text: '',
          systemMsg: message.pinned ? `pinned${by} ${message.text}`.trim() : 'message unpinned',
          // feeds sanitizeColor()/COLOR_RE downstream (main.js) — literal hex only, no var().
          color: '#ffd700',
          badges: '',
          channel,
          time: Date.now(),
          type: 'usernotice',
          msgId: 'pin',
          platform: 'kick',
          id: `hs-kick-pin-${channel}-${message.pinned ? 1 : 0}-${Date.now()}`,
        }
        this.channels.get(channel).push(msg)
        this.persistBuffer(channel)
        this.emit('message', msg)
        return
      }

      // KICKs gifted events (Kick's equivalent of Twitch Bits)
      if (message.type === 'kick_kicks_event') {
        if (!kickCelebrationFresh(`k|${message.channel}|${message.username}|${message.amount}`)) return
        const channel = message.channel?.toLowerCase()
        this._touchChannel(channel)
        if (!channel || !this.channels.has(channel)) return
        const msg = {
          user: message.username || 'anonymous',
          text: message.message || '',
          systemMsg: `${message.username || 'Anonymous'} gifted ${message.amount} KICKs${message.giftName ? ` (${message.giftName})` : ''}!`,
          // feeds sanitizeColor()/COLOR_RE downstream (main.js) — must stay literal hex, no var(). Canonical gold.
          color: '#ffd700',
          badges: '',
          channel,
          time: Date.now(),
          type: 'usernotice',
          msgId: 'kicks_gifted',
          platform: 'kick',
          kicksEvent: true,
          id: '',
        }
        this.channels.get(channel).push(msg)
        this.persistBuffer(channel)
        this.emit('message', msg)
      }

      // Kick subscription events (new sub, resub, gift subs)
      if (message.type === 'kick_sub_event') {
        if (
          !kickCelebrationFresh(
            `s|${message.channel}|${message.eventType}|${message.username}|${message.months || 0}|${(message.giftees || []).length}`,
          )
        )
          return
        const channel = message.channel?.toLowerCase()
        this._touchChannel(channel)
        if (!channel || !this.channels.has(channel)) return
        const msg = {
          user: message.username || 'system',
          text: '',
          systemMsg: message.message || '',
          // feeds sanitizeColor()/COLOR_RE downstream (main.js) — must stay literal hex, no var(). Already canonical kick green.
          color: '#53fc18',
          badges: '',
          channel,
          time: Date.now(),
          type: 'usernotice',
          // main.js's noticeKind() styles kick subs off the server's webhook
          // event names, but the relay hands us the short form — so every kick
          // sub notice rendered with no sub/gift treatment at all. Normalize
          // here, the one place both transports pass through.
          msgId: KICK_SUB_NOTICE_ID[message.eventType] || message.eventType || '',
          platform: 'kick',
          id: '',
        }
        this.channels.get(channel).push(msg)
        this.persistBuffer(channel)
        this.emit('message', msg)
      }
    }
    chrome.runtime?.onMessage?.addListener(this._listener)
    this._startWatchdog()
    log('Kick chat listener registered (webhook mode)')
  }

  // Serialize + write one channel's buffer to chrome.storage.local NOW. Shared
  // by the debounced timer and the synchronous pagehide flush.
  _persistChannelNow(ch) {
    try {
      if (!chrome?.runtime?.id) return
      const buffer = this.channels.get(ch)
      if (!buffer) return
      const msgs = buffer
        .getAll()
        .slice(-this._PERSIST_MAX)
        .map((m) => this._serializeMsg(m))
        .filter(Boolean)
      const p = chrome.storage.local.set({ [`hs_kick_${ch}`]: { msgs, ts: Date.now() } })
      if (p && typeof p.catch === 'function') p.catch((e) => log('Kick history persist failed:', ch, e?.message || e))
    } catch {}
  }

  persistBuffer(ch) {
    this._pendingChannels.add(ch)
    if (this._persistTimers[ch]) return
    this._persistTimers[ch] = cleanup.setTimeout(() => {
      delete this._persistTimers[ch]
      this._pendingChannels.delete(ch)
      this._persistChannelNow(ch)
    }, this._PERSIST_DEBOUNCE_MS)
  }

  // BG merged a server-side backfill — re-pull merged buffer into local
  // mirror. Mirrors IRC._refreshFromBg semantics: render when empty OR when
  // the buffer grew meaningfully (real backfill). Same chunked staging +
  // busy/dirty coalescing as the twitch side — fat buffers froze reloads.
  async _refreshFromBg(ch) {
    ch = ch.toLowerCase()
    if (!this.channels.has(ch)) return
    this._refreshBusy ||= new Set()
    this._refreshDirty ||= new Set()
    if (this._refreshBusy.has(ch)) {
      this._refreshDirty.add(ch)
      return
    }
    this._refreshBusy.add(ch)
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'bg_kick_history', channel: ch })
      if (!resp?.ok || !Array.isArray(resp.msgs)) return
      const wasSize = this.channels.get(ch)?.size ?? 0
      try {
        if (typeof _recentSentHydrated !== 'undefined') await _recentSentHydrated
      } catch {}
      const staged = []
      await hsSched.chunk(
        resp.msgs,
        (m) => {
          m.isHistory = true
          if (m.user) {
            try {
              addUsername(m.user)
            } catch {}
            try {
              setKnownColor(m.user.toLowerCase(), m.color, m.userId, 'kick')
            } catch {}
          }
          try {
            const sentHost = peekSentHost(m.text)
            if (sentHost) {
              // Cross-device simulcast replay: only ONE leg per send renders.
              if (claimHydratedEcho(m.text, 'kick', m.time)) m.hidden = true
              m.badgePlatform = 'kick'
              m.platform = sentHost === 'yt' ? 'youtube' : sentHost
            }
          } catch {}
          staged.push(m)
        },
        { budgetMs: 5, respectScroll: false },
      )
      const buf = this.channels.get(ch)
      if (!buf) return // channel left during staging
      // Snapshot live messages AFTER staging so mid-ingest arrivals stay newest.
      const liveSnap = buf.getAll().filter((m) => !m.isHistory)
      buf.clear()
      for (const m of staged) buf.push(m)
      for (const m of liveSnap) buf.push(m)
      try {
        _dropAllTabCaches()
      } catch {}
      const isCurrent = currentTab === ch || (currentTab === 'live' && getLiveChannel() === ch)
      const delta = buf.size - wasSize
      if (isCurrent && (isMsgsElEmpty() || delta >= 5)) {
        scheduleRenderMessages()
      }
    } catch (e) {
      log('Kick BG refresh failed:', e?.message)
    } finally {
      this._refreshBusy.delete(ch)
      if (this._refreshDirty.delete(ch)) this._refreshFromBg(ch)
    }
  }

  async loadHistory(ch) {
    const buffer = this.channels.get(ch)
    if (!buffer) return
    const storageKey = `hs_kick_${ch}`
    const syncKey = `hs_kick_sync_${ch}`

    let chromeMsgs = null,
      syncMsgs = null
    try {
      const stored = await chrome.storage.local.get(storageKey)
      const data = stored[storageKey]
      if (data?.msgs?.length > 0 && Date.now() - data.ts < 86400000) chromeMsgs = data.msgs
    } catch {}
    try {
      const raw = localStorage.getItem(syncKey)
      if (raw) {
        const data = JSON.parse(raw)
        if (data?.msgs?.length > 0 && Date.now() - data.ts < 86400000) syncMsgs = data.msgs
      }
    } catch {}

    if (!chromeMsgs && !syncMsgs) return

    // Merge by user+time+text fingerprint — works for id-less legacy rows too.
    const seen = new Set()
    const all = []
    const fp = (m) => `${m.user || ''}|${m.time || 0}|${(m.text || '').slice(0, 80)}`
    const ingest = (arr) => {
      if (!arr) return
      for (const m of arr) {
        const k = fp(m)
        if (seen.has(k)) continue
        seen.add(k)
        all.push(m)
      }
    }
    ingest(chromeMsgs)
    ingest(syncMsgs)
    all.sort((a, b) => (a.time || 0) - (b.time || 0))

    // Filter out 7TV emote change system messages and dedup stream events
    const seenEventTexts = new Set()
    const filtered = all.filter((m) => {
      const t = m.text || m.systemMsg || ''
      if (
        t.includes('removed from channel') ||
        t.includes('added to channel') ||
        t.includes('removed 7TV emote') ||
        t.includes('added 7TV emote')
      )
        return false
      const isStreamEvent = m.type === 'stream-event' || (m.text?.includes('◆') && !m.user)
      if (isStreamEvent && m.text) {
        if (!m.type) m.type = 'stream-event'
        if (!m.text.startsWith('[')) {
          const em = m.text.match(/^([a-zA-Z0-9_]+) ◆/)
          if (em) m.text = `[${em[1]}]${m.text.slice(em[1].length)}`
        }
        if (seenEventTexts.has(m.text)) return false
        seenEventTexts.add(m.text)
      }
      return true
    })
    log(
      'Kick storage hit:',
      filtered.length,
      'msgs for',
      ch,
      `chrome:${chromeMsgs?.length || 0}`,
      `sync:${syncMsgs?.length || 0}`,
    )
    for (const msg of filtered) {
      msg.isHistory = true
      if (msg.user) {
        addUsername(msg.user)
        setKnownColor(msg.user.toLowerCase(), msg.color, msg.userId, 'kick')
      }
      buffer.push(msg)
    }
    // Always render when history hydrates and panel is current — even if a
    // couple live msgs already painted, the buffer just grew and the DOM
    // must reflect it.
    const isCurrent = currentTab === ch || (currentTab === 'live' && getLiveChannel() === ch)
    if (isCurrent && filtered.length > 0) {
      scheduleRenderMessages()
    }
  }

  destroy() {
    this._destroyed = true
    this._stopWatchdog()
    if (this._listener) {
      chrome.runtime?.onMessage?.removeListener(this._listener)
      this._listener = null
    }
    if (this._pagehideHandler) {
      window.removeEventListener('pagehide', this._pagehideHandler)
      this._pagehideHandler = null
    }
    for (const id of Object.values(this._persistTimers)) cleanup.clearTimeout(id)
    this._persistTimers = {}
    // Leave all channels
    for (const username of this.channels.keys()) {
      safeSendMessage({ type: 'ws_send', data: { type: 'channel:leave', platform: 'kick', channel: username } })
    }
    this.channels.clear()
    this._chanLastSeen.clear()
    this._chanRejoinAttempts.clear()
  }

  async join(kickUsername) {
    kickUsername = kickUsername.toLowerCase()
    if (this.channels.has(kickUsername)) return
    this.channels.set(kickUsername, new CircularBuffer(3000))
    // Seed watchdog clock — full grace period before re-asserting.
    this._chanLastSeen.set(kickUsername, Date.now())
    // Pre-warm Kick subscriber badges (defer past init so any panel mount
    // races finish before the populate). No render side-effects in the
    // helper — natural re-render picks up the new entries.
    setTimeout(() => {
      try {
        fetchKickChannelBadges(kickUsername)
      } catch {}
    }, 1500)
    // ask BG for in-memory buffer first (always fresher than the
    // chrome.storage.local debounced write). Fall back to local persisted
    // history if BG is cold.
    let hydrated = false
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'bg_kick_history', channel: kickUsername })
      if (resp?.ok && Array.isArray(resp.msgs) && resp.msgs.length > 0) {
        const buf = this.channels.get(kickUsername)
        try {
          if (typeof _recentSentHydrated !== 'undefined') await _recentSentHydrated
        } catch {}
        for (const m of resp.msgs) {
          m.isHistory = true
          if (m.user) {
            try {
              addUsername(m.user)
            } catch {}
            try {
              setKnownColor(m.user.toLowerCase(), m.color, m.userId, 'kick')
            } catch {}
          }
          try {
            const sentHost = peekSentHost(m.text)
            if (sentHost) {
              // Cross-device simulcast replay: only ONE leg per send renders.
              if (claimHydratedEcho(m.text, 'kick', m.time)) m.hidden = true
              m.badgePlatform = 'kick'
              m.platform = sentHost === 'yt' ? 'youtube' : sentHost
            }
          } catch {}
          buf.push(m)
        }
        hydrated = true
        log('Kick BG history hydrated:', resp.msgs.length, 'msgs for', kickUsername)
        try {
          _dropAllTabCaches()
        } catch {}
        const isCurrent = currentTab === kickUsername || (currentTab === 'live' && getLiveChannel() === kickUsername)
        if (isCurrent && resp.msgs.length > 0) {
          scheduleRenderMessages()
        }
      }
    } catch (e) {
      log('Kick BG history fetch failed:', e?.message)
    }
    if (!hydrated) await this.loadHistory(kickUsername)
    safeSendMessage({ type: 'ws_send', data: { type: 'channel:join', platform: 'kick', channel: kickUsername } })
    log('Kick joined', kickUsername, '(webhook mode)')
    for (const delay of [3000, 8000, 20000]) {
      cleanup.setTimeout(() => {
        if (this._destroyed || !this.channels.has(kickUsername)) return
        if ((this.channels.get(kickUsername)?.size || 0) >= 200) return
        this._refreshFromBg(kickUsername)
      }, delay)
    }
  }

  part(kickUsername) {
    kickUsername = kickUsername.toLowerCase()
    if (!this.channels.has(kickUsername)) return
    safeSendMessage({ type: 'ws_send', data: { type: 'channel:leave', platform: 'kick', channel: kickUsername } })
    this.channels.delete(kickUsername)
    this._chanLastSeen.delete(kickUsername)
    this._chanRejoinAttempts.delete(kickUsername)
    log('Kick parted', kickUsername)
  }

  // getMessages/getCount/on/emit inherited from ChatClient
}

export { CircularBuffer, parseIrcLine, parseTags, parseTwitchEmotesTag }
