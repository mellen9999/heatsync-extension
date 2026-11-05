// chat-lock.js — the composer says why you can't chat in a twitch channel
// (banned, timed out with the time left, a room rule you don't meet) and holds
// the send, instead of learning it from a toast after a refused send.
// Port of the site's chat/chat-lock.js + the rust app's lock.rs.
//
// No import/export: concatenated into the multichat bundle (see build.js
// MULTICHAT_MODULES) — top-level declarations are shared globals.
//
// Signals: a CLEARCHAT naming us (the moment it happens), and a NOTICE when a
// send is refused (also how a lock that began before this page loaded becomes
// known). A ban has no end and twitch never says it was lifted, so a ban shows
// but still lets a send through (twitch re-judges it); a room rule holds until
// ROOMSTATE turns the mode off, or CHAT_LOCK_RULE_RECHECK_MS passes.
// Memory only: a reload inside a timeout re-learns it from the first refusal.

const CHAT_LOCK_RULE_RECHECK_MS = 10 * 60 * 1000
const CHAT_LOCK_MAX = 200
const chatLocks = new Map() // channel -> { cause, until }

const CHAT_LOCK_NOTICE_CAUSE = {
  msg_banned: 'banned',
  msg_timedout: 'timeout',
  msg_subsonly: 'subs',
  msg_followersonly: 'followers',
  msg_followersonly_followed: 'followers',
  msg_followersonly_zero: 'followers',
  msg_emoteonly: 'emote',
}

function chatLockPut(channel, cause, until) {
  const k = String(channel || '').toLowerCase()
  if (!k || !cause) return
  chatLocks.delete(k)
  chatLocks.set(k, { cause, until: until ?? null })
  if (chatLocks.size > CHAT_LOCK_MAX) chatLocks.delete(chatLocks.keys().next().value)
}

function chatLockClear(channel) {
  chatLocks.delete(String(channel || '').toLowerCase())
}

/** @returns {{cause: string, until: number|null}|null} the lock in force */
function chatLockFor(channel, now = Date.now()) {
  const k = String(channel || '').toLowerCase()
  const v = chatLocks.get(k)
  if (!v) return null
  if (v.until != null && v.until <= now) {
    chatLocks.delete(k)
    return null
  }
  return v
}

// a refused-send NOTICE → the lock it implies, or null (slow mode, duplicate… are not a lock on you)
function chatLockFromNotice(msgId, line, now = Date.now()) {
  const cause = CHAT_LOCK_NOTICE_CAUSE[msgId]
  if (!cause) return null
  if (cause === 'banned') return { cause, until: null }
  if (cause === 'timeout') {
    const s = Number((String(line || '').match(/(\d+)\s+more\s+second/i) || [])[1])
    return Number.isFinite(s) && s > 0 ? { cause, until: now + s * 1000 } : null
  }
  return { cause, until: now + CHAT_LOCK_RULE_RECHECK_MS }
}

// CLEARCHAT aimed at us (the parsed timeout_success/ban_success notice) → lock, or null.
// Backlog replays of an old event must not lock us: a ban only counts when fresh.
function chatLockFromClearchat(msg, selfNames, now = Date.now()) {
  if (!msg || (msg.noticeType !== 'timeout_success' && msg.noticeType !== 'ban_success')) return null
  const target = String(msg.targetUser || '').toLowerCase()
  if (!target || !selfNames.includes(target)) return null
  const at = Number(msg.time) || now
  if (now - at > 60000) return null
  if (msg.noticeType === 'ban_success' || !(msg.banDuration > 0)) return { cause: 'banned', until: null }
  const until = at + msg.banDuration * 1000
  return until > now ? { cause: 'timeout', until } : null
}

// ROOMSTATE: a mode turned off frees whoever it was keeping out
function chatLockRoomstate(msg) {
  const v = msg?.channel ? chatLocks.get(String(msg.channel).toLowerCase()) : null
  if (!v) return
  if (
    (v.cause === 'subs' && msg.subsOnly === false) ||
    (v.cause === 'emote' && msg.emoteOnly === false) ||
    (v.cause === 'followers' && msg.followersOnly === -1)
  )
    chatLockClear(msg.channel)
}

function chatLockClock(secs) {
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = secs % 60
  return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(s).padStart(2, '0')}`
}

/** "timed out · 4:59", "banned from this channel", or the room rule. */
function chatLockLabel(lock, now = Date.now()) {
  if (!lock) return ''
  if (lock.cause === 'timeout')
    return t('mc_lock_timed_out', [chatLockClock(Math.max(0, Math.ceil((lock.until - now) / 1000)))])
  const key = {
    banned: 'mc_lock_banned',
    subs: 'mc_lock_subs',
    followers: 'mc_lock_followers',
    emote: 'mc_lock_emote',
  }[lock.cause]
  return key ? t(key) : ''
}

// red = out of the room, yellow = a rule of the room
function chatLockIsRule(lock) {
  return !!lock && lock.cause !== 'banned' && lock.cause !== 'timeout'
}

// a ban only tells; timeouts and room rules hold the send
function chatLockHoldsSend(lock) {
  return !!lock && lock.cause !== 'banned'
}

// the twitch channel the composer on this tab speaks to, or '' (kick/yt-only tab, feed, …)
function chatLockTabChannel() {
  if (typeof currentTab === 'undefined') return ''
  if (currentTab === 'live') {
    return typeof hostPlatform !== 'undefined' && hostPlatform === 'twitch' && typeof getLiveChannel === 'function'
      ? String(getLiveChannel() || '').toLowerCase()
      : ''
  }
  const ch = config?.channels?.find((c) => c.id === currentTab)
  return ch?.twitch ? String(ch.twitch).toLowerCase() : ''
}

// 1s repaint while a timeout counts down; stops itself
let chatLockTimer = null
function chatLockTick() {
  const ch = chatLockTabChannel()
  const lock = ch ? chatLockFor(ch) : null
  if (typeof updateInputPlaceholder === 'function') updateInputPlaceholder()
  if (!lock || lock.cause !== 'timeout') {
    clearInterval(chatLockTimer)
    chatLockTimer = null
  }
}
function chatLockArm() {
  if (chatLockTimer) return
  chatLockTimer = setInterval(chatLockTick, 1000)
}

// every signal funnels through here: store, then repaint the composer
function chatLockSet(channel, lock) {
  if (!lock) return
  chatLockPut(channel, lock.cause, lock.until)
  if (lock.cause === 'timeout') chatLockArm()
  if (typeof updateInputPlaceholder === 'function') updateInputPlaceholder()
}
