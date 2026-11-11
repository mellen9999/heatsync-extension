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

// user_info → alias set + the per-platform self names (self-identity.js)
function setMentionAliases(ui) {
  mentionAliases = new Set()
  if (ui?.username) mentionAliases.add(ui.username.toLowerCase())
  if (ui?.kick_username) mentionAliases.add(ui.kick_username.toLowerCase())
  if (ui?.youtube_username) mentionAliases.add(ui.youtube_username.toLowerCase())
  if (ui?.twitch_username) mentionAliases.add(ui.twitch_username.toLowerCase())
  setSelfHsNames(ui)
}

function getMentionTargets() {
  const out = []
  if (currentUsername) out.push(currentUsername)
  // Signed into kick but not heatsync: no user_info aliases, so the kick
  // session's own username is the only name that makes "@you" ping.
  if (selfKickName && !out.includes(selfKickName)) out.push(selfKickName)
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

function fireNotification(title, body, tag, icon, onClick) {
  if (!notificationsEnabled) return
  if (notificationPermission === 'denied') return
  try {
    const iconUrl = icon || api.runtime.getURL('icon-48.png')
    const n = new Notification(title, { body, icon: iconUrl, tag, silent: false })
    n.onclick = () => {
      if (onClick) onClick()
      else window.focus()
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

// Audio cues — the engine (presets, picked files, rate limit, suspended-context
// handling) is sounds.js; this file owns the settings it reads and the two ways
// a cue gets asked for. Both run every message through the same player, so a
// raid of matching messages is rate-limited there, once.
//
// @mention sound: ui_settings.mentionSound (a preset, or 'custom' = the file in
// hs_sfx_mention) at ui_settings.mentionSoundVolume (0..1, default 0.3, 0 =
// silent). `preview` plays it now, unthrottled — the settings controls use it.
function playMentionPing(volume, opts) {
  // junk in storage must never mute a mention: anything unknown plays the ping
  const picked = opts?.name || mentionSound
  const name = picked === SFX_CUSTOM || SFX_PRESETS[picked] ? picked : 'ping'
  return sfxPlay({ name, key: SFX_MENTION_KEY, volume, buf: opts?.buf }, 'mention', !!opts?.preview)
}

// Settings controls: hear the @mention sound now. The slider passes the volume
// it just set; the sound select passes the name it just picked (the module copy
// of either only catches up on the storage event, after this runs).
function previewMentionSound(volume, name) {
  return playMentionPing(volume ?? mentionSoundVolume, { name, preview: true })
}

// Highlight-rule cue: the rule's own sound at its own volume, or — for a rule
// that never set one — the shared mentionSoundVolume, exactly as before rules
// had volumes. `verdict` is evaluateFilterRules()'s result (filter-rules.js).
function playFilterRuleSound(verdict) {
  if (!verdict?.sound) return
  const volume = verdict.soundVolume == null ? mentionSoundVolume : verdict.soundVolume / 100
  return sfxPlay({ name: verdict.sound, key: sfxRuleKey(verdict.soundId), volume }, 'rule', false)
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
  _titleFlashTimer = cleanup.setPageInterval(() => {
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

// User-tunable settings — sound, volume, when the sound plays + flash toggle.
// Hydrated from sync ui_settings; sync onChanged keeps them current cross-tab.
// Defaults: ping, 0.3, only when away, flash on.
let mentionSound = 'ping'
let mentionSoundVolume = 0.3
let mentionTitleFlash = true
// 'away' = the mention sound only plays while this window is not focused (how it
// always worked); 'always' = every mention, focused or not
let mentionSoundWhen = 'away'
function readMentionUi(ui) {
  if (typeof ui.mentionSoundVolume === 'number') mentionSoundVolume = Math.max(0, Math.min(1, ui.mentionSoundVolume))
  if (typeof ui.mentionSound === 'string') mentionSound = ui.mentionSound
  if (typeof ui.mentionTitleFlash === 'boolean') mentionTitleFlash = ui.mentionTitleFlash
  if (ui.mentionSoundWhen === 'away' || ui.mentionSoundWhen === 'always') mentionSoundWhen = ui.mentionSoundWhen
}
api.storage.sync
  .get(['ui_settings'])
  .then((stored) => readMentionUi(stored?.ui_settings || {}))
  .catch(() => {})
if (!_onceGuardsMentions.mentionAudioStorageListener) {
  _onceGuardsMentions.mentionAudioStorageListener = true
  cleanup.addListener(api.storage.onChanged, (changes, area) => {
    if (area === 'sync' && changes.ui_settings?.newValue) readMentionUi(changes.ui_settings.newValue)
  })
}

// A highlight rule with "also notify me" counts as a mention without a heatsync
// login: it lands in the mentions tab, flashes the tab title and shows the
// desktop notice, exactly like an @you. Same gates as a real mention — the
// mentions switch, and a blocked user never pings. `verdict` is the row's
// evaluateFilterRules() result; own messages never get one.
function ruleAlertsMention(msg, verdict) {
  if (!verdict?.notify) return false
  if (!isEnabled('mentions')) return false
  if (typeof isUserBlocked === 'function' && isUserBlocked(msg.user, msg.platform)) return false
  return true
}

// viaRule: the alert is a highlight rule's "also notify me", not an @you — the
// rule already played its own sound on arrival, so the mention ping stays out of it.
function notifyMention(msg, viaRule) {
  // Screen reader: the quiet "mentions only" mode says these and nothing else
  // (sr-announce.js). First, and whatever the window's focus — it is not a popup.
  srAnnounceMention(msg)
  // Always evaluate audio + title-flash even when system notif disabled — they
  // have their own gates. The original "return if notifs off" check killed the
  // tab-title flash for users who didn't want OS popups but did want a visual
  // cue. Each cue is independently configurable.
  const unfocused = !document.hasFocus()
  if (!viaRule && (unfocused || mentionSoundWhen === 'always')) playMentionPing(mentionSoundVolume)
  if (unfocused && mentionTitleFlash) _titleFlashStart(msg.user || '')
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
    title = t('mc_mn_went_live', [channel])
    body = game || ''
  } else if (eventType === 'stream:update') {
    title = t('mc_mn_switched_game', [channel])
    body = game || ''
  } else {
    return
  }
  // The event is about the streamer — show their pfp, not the logo.
  resolveNotifIcon(channel, platform, null).then((icon) =>
    // Click lands on the streamer's page: their tab if one is open, else a new one.
    fireNotification(title, body, `hs-stream-${channel}-${Date.now()}`, icon, () =>
      safeSendMessage({ type: 'focus_channel_tab', platform: platform || 'twitch', channel }),
    ),
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

// A heatsync notification (background.js shapeHsNotif) as a row in the mentions
// tab: a reply to your post, an @ in a post, a fixed report. Rust shows the same in
// its notifs tab; the ext used to keep only the toolbar count.
const HS_NOTIF_KINDS = new Set(['reply', 'mention', 'feedback_fixed'])
function hsNotifText(d) {
  const who = d.anon ? `${t('mc_ircx_anonymous')}: ` : ''
  if (d.kind === 'reply') {
    const to = t(
      d.op === true ? 'mc_mention_reply_post' : d.op === false ? 'mc_mention_reply_reply' : 'mc_mention_reply_you',
    )
    return `${who}${d.text ? `${to}: ${d.text}` : to}`
  }
  if (d.kind === 'feedback_fixed') return d.text || t('mc_mention_fixed')
  return `${who}${d.text || t('mc_mention_in_post')}`
}

function hsNotifIn(d) {
  if (!isEnabled('mentions') || !HS_NOTIF_KINDS.has(d.kind)) return
  const msg = {
    type: 'inline-notif',
    kind: d.kind,
    postId: d.id || '',
    text: hsNotifText(d),
    user: 'heatsync',
    platform: 'heatsync',
    channel: 'heatsync',
    time: d.time || Date.now(),
    id: `hsn-${d.time || Date.now()}-${d.id || ''}`,
  }
  mentionsBuffer.push(msg)
  if (mentionsBuffer.length > MAX_BUFFER + 50) mentionsBuffer.splice(0, mentionsBuffer.length - MAX_BUFFER)
  persistMentions()
  notifyMention(msg)
  noteSeenEvent('mentions', msg.time)
  if (currentTab === 'mentions') {
    bumpSeen('mentions')
    hsNotifsRead()
    if (!appendMessage(msg, 'mentions')) renderMessages('mentions')
  } else {
    updateTabIndicator('mentions')
  }
}

// the server marks them read for every device; rows stay, just no longer unread
function hsNotifsRead() {
  let any = false
  for (const m of mentionsBuffer) {
    if (m.type === 'inline-notif' && !m.read) {
      m.read = true
      any = true
    }
  }
  if (any) safeSendMessage({ type: 'notifs_read' })
}
