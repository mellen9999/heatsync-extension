// Mentions/notifications - keyword detection, browser notifications, scan existing chat

// module scope resets on re-injection, so a fresh instance re-registers
// after the old one's teardown; window-scope survives takeover and leaves
// handlers dead until hard refresh
const _onceGuardsMentions = {}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Aliases — kick + youtube usernames in addition to currentUsername (twitch).
// Populated by loadHsUsername() in social.js from user_info.kick_username etc.
let mentionAliases = new Set()
let _mentionReList = null
let _mentionReKey = ''

function getMentionTargets() {
  const out = []
  if (currentUsername) out.push(currentUsername)
  // currentUsername is null on cross-origin tabs (youtube.com/kick.com popout
  // — twitch storage unreachable). authState.nick is the twitch nick from the
  // auth-irc handshake and works everywhere; without it, "@you" tags on the
  // yt popout never highlight. Same hardening as the echo-confirm fallback.
  if (typeof authState !== 'undefined' && authState?.nick) {
    const n = authState.nick.toLowerCase()
    if (!out.includes(n)) out.push(n)
  }
  for (const a of mentionAliases) {
    if (a && !out.includes(a)) out.push(a)
  }
  return out
}

function isMention(msg) {
  if (!isEnabled('mentions')) return false // live subsystem gate
  const targets = getMentionTargets()
  if (!targets.length) return false
  const sender = msg.user?.toLowerCase()
  if (sender && targets.includes(sender)) return false
  // Blocked users can't ping you — gating here kills the notification, sound,
  // title-flash, mentions buffer AND the tab indicator in one place (every
  // mention surface routes through isMention).
  if (typeof isUserBlocked === 'function' && isUserBlocked(msg.user, msg.platform)) return false

  // Someone hit "reply" on YOUR message. Twitch and Kick carry that in the
  // reply tags and leave the text alone, so a plain "yeah agreed" reply used to
  // score false here — no sound, no notification, no mentions-tab entry, no tab
  // badge — while the row visibly rendered "↳ replying to you". Only YouTube
  // worked, and only because it has no reply API so the @name gets prepended
  // into the text by hand. Structural check, so every platform behaves alike.
  const repliedTo = msg.replyTo?.user?.toLowerCase()
  if (repliedTo && targets.includes(repliedTo)) return true

  const text = msg.text.toLowerCase()
  for (const t of targets) {
    if (text.includes(`@${t}`)) return true
  }
  const key = targets.join('|')
  if (_mentionReKey !== key) {
    _mentionReList = targets.map((t) => new RegExp(`\\b${escapeRegex(t)}\\b`, 'i'))
    _mentionReKey = key
  }
  for (const re of _mentionReList) {
    if (re.test(text)) return true
  }
  return false
}

// Browser notifications (gated by hs_notifications setting)
let notificationsEnabled = false
let notificationPermission = typeof Notification !== 'undefined' ? Notification.permission : 'denied'
api.storage.local
  .get('hs_notifications')
  .then((data) => {
    notificationsEnabled = data.hs_notifications === true
    // Request permission on Firefox (Chrome extensions get it automatically)
    if (notificationsEnabled && notificationPermission === 'default' && typeof Notification !== 'undefined') {
      Notification.requestPermission()
        .then((p) => {
          notificationPermission = p
        })
        .catch(() => {})
    }
  })
  .catch(() => {})
if (!_onceGuardsMentions.notifStorageListener) {
  _onceGuardsMentions.notifStorageListener = true
  cleanup.addListener(api.storage.onChanged, (changes) => {
    if (changes.hs_notifications) {
      notificationsEnabled = changes.hs_notifications.newValue === true
      if (notificationsEnabled && notificationPermission === 'default' && typeof Notification !== 'undefined') {
        Notification.requestPermission()
          .then((p) => {
            notificationPermission = p
          })
          .catch(() => {})
      }
    }
  })
}

function fireNotification(title, body, tag, icon) {
  if (!notificationsEnabled) return
  if (notificationPermission === 'denied') return
  try {
    const iconUrl = icon || api.runtime.getURL('icon-48.png')
    const n = new Notification(title, { body, icon: iconUrl, tag, silent: false })
    n.onclick = () => {
      window.focus()
      n.close()
    }
    cleanup.setTimeout(() => n.close(), 8000)
  } catch {}
}

// Resolve a person's pfp for a toast — a face beats the logo. Uses the avatar
// already on the message (YouTube author photo) when present; otherwise asks
// the background to look it up (Twitch GQL / Kick API, cached). Returns '' on
// any failure so the caller falls back to the extension icon.
async function resolveNotifIcon(name, platform, knownAvatar) {
  // YouTube messages carry the author photo inline; the page-context Web
  // Notification renders that remote URL fine (and it lives on a CDN the SW
  // can't fetch), so use it directly.
  if (knownAvatar) return knownAvatar
  if (!name) return ''
  try {
    // Background resolves (twitch GQL / kick API) and inlines the image as a
    // data URL — remote icons render unreliably on some notification daemons
    // (mako); data URLs always do.
    const r = await api.runtime.sendMessage({ type: 'resolve_avatar', username: name, platform })
    return r?.url || ''
  } catch {
    return ''
  }
}

// Mention audio cue — pure Web Audio synth (no asset shipped, can't fail to
// load). Two-tone 880→1175 Hz ping with quick decay envelope. Volume gated by
// ui_settings.mentionSoundVolume (0..1, default 0.3). 0 = silent.
let _mentionAudioCtx = null
let _mentionAudioIdleTimer = null
// Grace before parking the context after the last tone. A running AudioContext
// holds the audio render thread and the output device open for as long as it is
// resumed — so a single mention used to leave a wakeup source running for the
// rest of the session. The grace keeps a burst of pings from thrashing
// resume/suspend, and it is generous because suspending is only worth doing
// once the room has actually gone quiet.
const MENTION_AUDIO_IDLE_MS = 2000
function _getMentionAudioCtx() {
  if (_mentionAudioCtx) return _mentionAudioCtx
  try {
    const AC = window.AudioContext || window.webkitAudioContext
    if (!AC) return null
    _mentionAudioCtx = new AC()
    return _mentionAudioCtx
  } catch {
    return null
  }
}

/** Resume the context to play, and schedule it back to suspended once the tail
 * of the sound has finished. `tailSec` is the end of the last scheduled tone,
 * relative to now. Called again before the timer fires, it just re-arms. */
function _armMentionAudio(ctx, tailSec) {
  try {
    if (ctx.state === 'suspended') ctx.resume()
  } catch {}
  if (_mentionAudioIdleTimer) {
    cleanup.clearTimeout(_mentionAudioIdleTimer)
    _mentionAudioIdleTimer = null
  }
  const waitMs = Math.max(0, tailSec * 1000) + MENTION_AUDIO_IDLE_MS
  _mentionAudioIdleTimer = cleanup.setTimeout(() => {
    _mentionAudioIdleTimer = null
    try {
      if (_mentionAudioCtx?.state === 'running') _mentionAudioCtx.suspend()
    } catch {}
  }, waitMs)
}
function playMentionPing(volume) {
  if (!(volume > 0)) return
  const ctx = _getMentionAudioCtx()
  if (!ctx) return
  try {
    _armMentionAudio(ctx, 0.32)
    const now = ctx.currentTime
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0, now)
    gain.gain.linearRampToValueAtTime(Math.min(1, volume) * 0.35, now + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.3)
    gain.connect(ctx.destination)
    const o1 = ctx.createOscillator()
    o1.type = 'sine'
    o1.frequency.setValueAtTime(880, now)
    o1.connect(gain)
    o1.start(now)
    o1.stop(now + 0.32)
    const o2 = ctx.createOscillator()
    o2.type = 'sine'
    o2.frequency.setValueAtTime(1175, now + 0.08)
    o2.connect(gain)
    o2.start(now + 0.08)
    o2.stop(now + 0.32)
  } catch {}
}

// Filter-rule highlight cues — same pure Web Audio synth, a few named presets so
// a highlight rule can carry an optional audible tag. Throttled (one per 1.2s)
// so a burst of matches can't machine-gun. Shares ui_settings.mentionSoundVolume
// (one "chat sounds" knob); 0 = silent. Unknown name → no-op.
const FILTER_SOUND_PRESETS = {
  ping: [
    { f: 880, t0: 0, d: 0.32 },
    { f: 1175, t0: 0.08, d: 0.24 },
  ],
  blip: [{ f: 1320, t0: 0, d: 0.12 }],
  knock: [
    { f: 200, t0: 0, d: 0.1 },
    { f: 200, t0: 0.13, d: 0.1 },
  ],
  chime: [
    { f: 660, t0: 0, d: 0.18 },
    { f: 880, t0: 0.09, d: 0.18 },
    { f: 1318, t0: 0.18, d: 0.26 },
  ],
}
let _lastFilterSoundMs = 0
function playFilterRuleSound(name) {
  const preset = FILTER_SOUND_PRESETS[name]
  if (!preset) return
  const volume = mentionSoundVolume
  if (!(volume > 0)) return
  const now = Date.now()
  if (now - _lastFilterSoundMs < 1200) return // throttle bursty matches
  _lastFilterSoundMs = now
  const ctx = _getMentionAudioCtx()
  if (!ctx) return
  try {
    _armMentionAudio(ctx, Math.max(...preset.map((tone) => tone.t0 + tone.d)) + 0.02)
    const t = ctx.currentTime
    for (const tone of preset) {
      const gain = ctx.createGain()
      gain.gain.setValueAtTime(0, t + tone.t0)
      gain.gain.linearRampToValueAtTime(Math.min(1, volume) * 0.35, t + tone.t0 + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + tone.t0 + tone.d)
      gain.connect(ctx.destination)
      const o = ctx.createOscillator()
      o.type = 'sine'
      o.frequency.setValueAtTime(tone.f, t + tone.t0)
      o.connect(gain)
      o.start(t + tone.t0)
      o.stop(t + tone.t0 + tone.d + 0.02)
    }
  } catch {}
}

// Tab title flash — when an @mention arrives while the tab is unfocused,
// flip document.title between "@you ← original" and the original on a 1.2s
// timer until the tab regains focus. Persists across many mentions (queue
// the latest sender's name). Restores original on visibilitychange.
let _titleFlashOriginal = null
let _titleFlashTimer = null
let _titleFlashFrom = ''
function _titleFlashStop() {
  if (_titleFlashTimer) {
    cleanup.clearInterval(_titleFlashTimer)
    _titleFlashTimer = null
  }
  if (_titleFlashOriginal != null) {
    try {
      document.title = _titleFlashOriginal
    } catch {}
    _titleFlashOriginal = null
  }
  _titleFlashFrom = ''
}
function _titleFlashStart(fromUser) {
  _titleFlashFrom = fromUser || 'mention'
  if (_titleFlashTimer) return // already flashing — let it pick up the new name on next tick
  try {
    _titleFlashOriginal = document.title
  } catch {
    return
  }
  let on = false
  _titleFlashTimer = cleanup.setInterval(() => {
    if (document.hasFocus()) {
      _titleFlashStop()
      return
    }
    on = !on
    try {
      document.title = on ? `@${_titleFlashFrom} ← ${_titleFlashOriginal}` : _titleFlashOriginal
    } catch {}
  }, 1200)
}
// Restore title the moment the tab regains focus
if (!_onceGuardsMentions.titleFlashFocusWired) {
  _onceGuardsMentions.titleFlashFocusWired = true
  window.addEventListener('focus', _titleFlashStop, { signal: mcSignal })
  document.addEventListener(
    'visibilitychange',
    () => {
      if (!document.hidden) _titleFlashStop()
    },
    { signal: mcSignal },
  )
}

// User-tunable settings — volume + flash toggle. Hydrated from sync
// ui_settings; sync onChanged keeps them current cross-tab. Defaults: sound
// 0.3, flash on.
let mentionSoundVolume = 0.3
let mentionTitleFlash = true
api.storage.sync
  .get(['ui_settings'])
  .then((stored) => {
    const ui = stored?.ui_settings || {}
    if (typeof ui.mentionSoundVolume === 'number') mentionSoundVolume = Math.max(0, Math.min(1, ui.mentionSoundVolume))
    if (typeof ui.mentionTitleFlash === 'boolean') mentionTitleFlash = ui.mentionTitleFlash
  })
  .catch(() => {})
if (!_onceGuardsMentions.mentionAudioStorageListener) {
  _onceGuardsMentions.mentionAudioStorageListener = true
  cleanup.addListener(api.storage.onChanged, (changes, area) => {
    if (area === 'sync' && changes.ui_settings?.newValue) {
      const ui = changes.ui_settings.newValue
      if (typeof ui.mentionSoundVolume === 'number')
        mentionSoundVolume = Math.max(0, Math.min(1, ui.mentionSoundVolume))
      if (typeof ui.mentionTitleFlash === 'boolean') mentionTitleFlash = ui.mentionTitleFlash
    }
  })
}

function notifyMention(msg) {
  // Always evaluate audio + title-flash even when system notif disabled — they
  // have their own gates. The original "return if notifs off" check killed the
  // tab-title flash for users who didn't want OS popups but did want a visual
  // cue. Each cue is independently configurable.
  const unfocused = !document.hasFocus()
  if (unfocused) {
    playMentionPing(mentionSoundVolume)
    if (mentionTitleFlash) _titleFlashStart(msg.user || '')
  }
  if (!notificationsEnabled || !unfocused) return
  const channel = msg.channel ? ` in #${msg.channel}` : ''
  const title = `${msg.user}${channel}`
  const body = msg.text.length > 200 ? `${truncateSafe(msg.text, 200)}...` : msg.text
  resolveNotifIcon(msg.user, msg.platform, msg.avatar).then((icon) =>
    fireNotification(title, body, `hs-mention-${Date.now()}`, icon),
  )
}

function notifyStreamEvent(channel, eventType, game, platform) {
  if (!notificationsEnabled) return
  if (document.hasFocus()) return
  let title, body
  if (eventType === 'stream:online') {
    title = `${channel} went live`
    body = game || ''
  } else if (eventType === 'stream:update') {
    title = `${channel} switched game`
    body = game || ''
  } else {
    return
  }
  // The event is about the streamer — show their pfp, not the logo.
  resolveNotifIcon(channel, platform, null).then((icon) =>
    fireNotification(title, body, `hs-stream-${channel}-${Date.now()}`, icon),
  )
}

/**
 * Scan existing chat messages in DOM for mentions (on load)
 */
function scanExistingMentions() {
  const targets = getMentionTargets()
  if (!targets.length) {
    log('Cannot scan mentions - no username')
    return
  }

  // Twitch + Kick message selectors
  const messages = document.querySelectorAll('[data-a-target="chat-line-message"], #chatroom-messages [data-index]')
  log('Scanning', messages.length, 'existing messages for mentions of', targets.join(','))

  let found = 0
  const mentionRes = targets.map((t) => new RegExp(`\\b${escapeRegex(t)}\\b`, 'i'))
  messages.forEach((msgEl) => {
    // Only check message text, not the full element (which includes sender name)
    const messageEl = msgEl.querySelector('[data-a-target="chat-message-text"], span.font-normal')
    const text = messageEl?.textContent || ''
    const textLower = text.toLowerCase()
    let matched = false
    for (const t of targets) {
      if (textLower.includes(`@${t}`)) {
        matched = true
        break
      }
    }
    if (!matched) {
      for (const re of mentionRes) {
        if (re.test(textLower)) {
          matched = true
          break
        }
      }
    }
    if (matched) {
      const usernameEl = msgEl.querySelector('[data-a-target="chat-message-username"], button.inline.font-bold')
      const username = usernameEl?.textContent || 'unknown'
      // Skip own messages
      if (targets.includes(username.toLowerCase())) return
      // Skip blocked users — they don't get to seed the mentions buffer either.
      // Pass the platform like the live path does: a block scoped to one
      // platform only matches when it's supplied, so omitting it let a blocked
      // user's backlog message through on page load that live chat suppressed.
      // Which selector the row matched IS the platform — this scan covers both.
      const rowPlatform = msgEl.matches('[data-a-target="chat-line-message"]') ? 'twitch' : 'kick'
      if (typeof isUserBlocked === 'function' && isUserBlocked(username, rowPlatform)) return

      mentionsBuffer.push({
        user: username,
        text: text,
        color: '#fff',
        channel: getCurrentChannel() || 'live',
        time: Date.now() - (messages.length - found) * 1000, // Approximate time
      })
      if (mentionsBuffer.length > MAX_BUFFER) mentionsBuffer.splice(0, mentionsBuffer.length - MAX_BUFFER)
      found++
    }
  })

  if (found > 0) {
    log('Found', found, 'existing mentions')
    updateTabIndicator('mentions')
  }
}
