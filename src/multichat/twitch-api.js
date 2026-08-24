// Twitch API - GQL proxy, badges, predictions, rewards, polls, Twitch tab UI

// ═══ Predictions & Betting ═══

function parsePoints(str) {
  if (!str) return 0
  str = str.trim().toLowerCase()
  const m = str.match(/^(\d+(?:\.\d+)?)\s*(k|m)?$/)
  if (!m) return parseInt(str, 10) || 0
  const num = parseFloat(m[1])
  if (m[2] === 'k') return Math.floor(num * 1000)
  if (m[2] === 'm') return Math.floor(num * 1000000)
  return Math.floor(num)
}

function formatPoints(n) {
  if (n == null) return '?'
  if (n >= 1000000) return `${(n / 1000000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`
  return String(n)
}

// Curated launcher of native Twitch surfaces, sectioned by role. Items with
// `direct:true` route through triggerTwitchFeature() (existing handlers like
// sub-purchase + clip-create that aren't plain window.open). Audience gates:
// 'mod' shows when viewer mods the channel; 'broadcaster' when the channel
// IS the viewer (twilight-user.login === channel); dashboard deep-links only
// resolve for the owner, so they stay hidden until then.
function renderQuickLinks() {
  const wrap = document.createElement('div')
  wrap.className = 'hs-mc-pred-links'

  const ch = (getActiveTwitchChannel() || getCurrentChannel() || '').toString().toLowerCase()
  const own = getOwnTwitchLogin()
  const isBroadcaster = !!(ch && own && own === ch)
  const isMod = isBroadcaster || _twitchIsMod

  // Static SVG strings parsed once per item — no user input ever reaches
  // here (icons + labels are all from the SECTIONS list below). We use
  // DOMParser instead of innerHTML to satisfy the security-reminder hook.
  function svgNode(svgStr) {
    const doc = new DOMParser().parseFromString(svgStr, 'image/svg+xml')
    return doc.documentElement
  }

  const ICONS = {
    sub: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 20 20" fill="currentColor"><path d="M10 2l2.39 4.84 5.34.78-3.86 3.77.91 5.31L10 14.27l-4.78 2.51.91-5.31L2.27 7.62l5.34-.78L10 2z"/></svg>',
    clip: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 20 20"><path fill="currentColor" d="M18 7h-2V5a2 2 0 00-2-2H6a2 2 0 00-2 2v2H2v4l8 6 8-6V7zM6 5h8v2H6V5z"/></svg>',
    popout:
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 20 20"><path fill="currentColor" d="M4 4h6v2H6v8h8v-4h2v6H4V4zm8 0h4v4h-2V6.41l-4.3 4.3-1.4-1.42L12.58 6H11V4z"/></svg>',
    shield:
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 20 20"><path fill="currentColor" d="M10 2l6 2.7V9c0 4.4-2.5 8.3-6 10-3.5-1.7-6-5.6-6-10V4.7L10 2z"/></svg>',
    dashboard:
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 20 20"><path fill="currentColor" d="M3 3h6v6H3V3zm8 0h6v6h-6V3zM3 11h6v6H3v-6zm8 4h6v2h-6v-2zm0-4h6v2h-6v-2z"/></svg>',
    settings:
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 20 20"><path fill="currentColor" d="M10 6.5A3.5 3.5 0 1010 13.5 3.5 3.5 0 0010 6.5zm6.5 3.5a6.5 6.5 0 00-.1-1.1l2-1.5-1.5-2.6-2.3.8c-.6-.5-1.3-.9-2-1.2L12.2 2h-3l-.4 2.4c-.7.3-1.4.7-2 1.2l-2.3-.8L3 7.4l2 1.5a6.6 6.6 0 000 2.2L3 12.6l1.5 2.6 2.3-.8c.6.5 1.3.9 2 1.2l.4 2.4h3l.4-2.4c.7-.3 1.4-.7 2-1.2l2.3.8 1.5-2.6-2-1.5c.1-.4.1-.7.1-1.1z"/></svg>',
    chart:
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 20 20"><path fill="currentColor" d="M3 17V3h2v14h12v2H3zm4-3V8h2v6H7zm4 0V5h2v9h-2zm4 0V10h2v4h-2z"/></svg>',
    people:
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 20 20"><path fill="currentColor" d="M7 8a3 3 0 100-6 3 3 0 000 6zm6 1a2 2 0 100-4 2 2 0 000 4zM1 17v-1c0-2.5 4-4 6-4s6 1.5 6 4v1H1zm12-1c0-1.2-.8-2.2-2-2.9.6-.1 1.3-.1 2-.1 2 0 5 1 5 3v1h-5v-1z"/></svg>',
    cash: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 20 20"><path fill="currentColor" d="M10 2a8 8 0 100 16 8 8 0 000-16zm.5 12.5v1h-1v-1c-1.4-.2-2.5-1-2.7-2.5H8c.1.6.5 1 1.5 1 .8 0 1.5-.3 1.5-1 0-.5-.3-.8-1.5-1.1-1.5-.4-2.8-.9-2.8-2.4 0-1.1 1-1.9 2.3-2.1V5h1v1.4c1.2.2 2.2.8 2.5 2.1H11c-.1-.5-.5-1-1.5-1-.7 0-1.5.3-1.5.9 0 .6.4.9 1.5 1.2 1.7.5 2.8 1 2.8 2.4 0 1.2-1 2-2.3 2.4z"/></svg>',
    video:
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 20 20"><path fill="currentColor" d="M2 5h12v10H2V5zm14 2l4-2v10l-4-2V7z"/></svg>',
    calendar:
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 20 20"><path fill="currentColor" d="M4 4h2V2h2v2h4V2h2v2h2v14H4V4zm0 4v8h12V8H4z"/></svg>',
    info: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 20 20"><path fill="currentColor" d="M10 2a8 8 0 100 16 8 8 0 000-16zm0 4a1 1 0 110 2 1 1 0 010-2zm-1 4h2v6H9v-6z"/></svg>',
    user: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 20 20"><path fill="currentColor" d="M10 10a4 4 0 100-8 4 4 0 000 8zm0 2c-3 0-7 1.5-7 4.5V18h14v-1.5c0-3-4-4.5-7-4.5z"/></svg>',
    gift: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 20 20"><path fill="currentColor" d="M3 8v10h14V8H3zm0-3h14v2H3V5zm5-3a2 2 0 012 2 2 2 0 012-2 2 2 0 010 4h-4a2 2 0 010-4z"/></svg>',
    lock: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 20 20"><path fill="currentColor" d="M5 9V7a5 5 0 0110 0v2h1v9H4V9h1zm2 0h6V7a3 3 0 00-6 0v2z"/></svg>',
    arrow:
      '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  }

  const SECTIONS = [
    {
      label: null,
      show: true,
      items: [
        { action: 'sub', accent: '#e91916', icon: ICONS.sub, label: 'subscribe', direct: true },
        { action: 'popout', accent: '#4a90d9', icon: ICONS.popout, label: 'popout chat', direct: true },
      ],
    },
    {
      label: 'mod tools',
      show: isMod,
      items: [
        {
          accent: '#00c8af',
          icon: ICONS.shield,
          label: 'mod view (chat, automod, blocked terms)',
          url: (c) => `https://www.twitch.tv/moderator/${c}`,
          opts: 'width=1200,height=800',
        },
      ],
    },
    {
      label: 'broadcaster',
      show: isBroadcaster,
      items: [
        {
          accent: HS_PLAT_COLORS.twitch,
          icon: ICONS.dashboard,
          label: 'creator dashboard',
          url: (c) => `https://dashboard.twitch.tv/u/${c}/home`,
          opts: 'width=1200,height=800',
        },
        {
          accent: HS_PLAT_COLORS.twitch,
          icon: ICONS.video,
          label: 'stream manager',
          url: (c) => `https://dashboard.twitch.tv/u/${c}/stream-manager`,
          opts: 'width=1200,height=800',
        },
        {
          accent: HS_PLAT_COLORS.twitch,
          icon: ICONS.settings,
          label: 'moderation settings (automod, blocked terms)',
          url: (c) => `https://dashboard.twitch.tv/u/${c}/settings/moderation`,
          opts: 'width=1000,height=750',
        },
        {
          accent: HS_PLAT_COLORS.twitch,
          icon: ICONS.settings,
          label: 'channel settings',
          url: (c) => `https://dashboard.twitch.tv/u/${c}/settings/channel`,
          opts: 'width=1000,height=750',
        },
        {
          accent: HS_PLAT_COLORS.twitch,
          icon: ICONS.people,
          label: 'community (mods, vips, follows)',
          url: (c) => `https://dashboard.twitch.tv/u/${c}/community`,
          opts: 'width=1000,height=750',
        },
        {
          accent: HS_PLAT_COLORS.twitch,
          icon: ICONS.cash,
          label: 'monetization',
          url: (c) => `https://dashboard.twitch.tv/u/${c}/monetization`,
          opts: 'width=1000,height=750',
        },
        {
          accent: HS_PLAT_COLORS.twitch,
          icon: ICONS.chart,
          label: 'analytics',
          url: (c) => `https://dashboard.twitch.tv/u/${c}/analytics/stream-summary`,
          opts: 'width=1200,height=800',
        },
      ],
    },
    {
      label: 'channel pages',
      show: !!ch,
      items: [
        { accent: '#888', icon: ICONS.info, label: 'about page', url: (c) => `https://www.twitch.tv/${c}/about` },
        { accent: '#888', icon: ICONS.video, label: 'videos', url: (c) => `https://www.twitch.tv/${c}/videos` },
        { accent: '#888', icon: ICONS.video, label: 'clips', url: (c) => `https://www.twitch.tv/${c}/clips` },
        { accent: '#888', icon: ICONS.calendar, label: 'schedule', url: (c) => `https://www.twitch.tv/${c}/schedule` },
      ],
    },
    {
      label: 'your account',
      show: true,
      items: [
        { accent: '#888', icon: ICONS.gift, label: 'drops / inventory', url: () => 'https://www.twitch.tv/inventory' },
        {
          accent: '#888',
          icon: ICONS.sub,
          label: 'my subscriptions',
          url: () => 'https://www.twitch.tv/subscriptions',
        },
        {
          accent: '#888',
          icon: ICONS.user,
          label: 'following directory',
          url: () => 'https://www.twitch.tv/directory/following',
        },
        { accent: '#888', icon: ICONS.settings, label: 'twitch settings', url: () => 'https://www.twitch.tv/settings' },
        {
          accent: '#888',
          icon: ICONS.lock,
          label: 'privacy + security',
          url: () => 'https://www.twitch.tv/settings/security',
        },
      ],
    },
  ]

  for (const section of SECTIONS) {
    if (section.show === false) continue
    const visible = section.items.filter((it) => {
      if (it.audience === 'mod' && !isMod) return false
      if (it.audience === 'broadcaster' && !isBroadcaster) return false
      return true
    })
    if (!visible.length) continue
    if (section.label) {
      const h = document.createElement('div')
      h.className = 'hs-mc-quicklink-section'
      h.textContent = section.label
      wrap.appendChild(h)
    }
    for (const item of visible) {
      const el = document.createElement('div')
      el.className = 'hs-mc-menu-item hs-mc-pred-link'
      if (item.action) el.dataset.action = item.action
      el.style.setProperty('--menu-accent', item.accent)

      const iconWrap = document.createElement('div')
      iconWrap.className = 'hs-mc-menu-icon'
      iconWrap.appendChild(svgNode(item.icon))
      el.appendChild(iconWrap)

      const text = document.createElement('div')
      text.className = 'hs-mc-menu-text'
      const title = document.createElement('div')
      title.className = 'hs-mc-menu-title'
      title.textContent = item.label
      text.appendChild(title)
      el.appendChild(text)

      const arrow = svgNode(ICONS.arrow)
      arrow.setAttribute('class', 'hs-mc-menu-arrow')
      el.appendChild(arrow)

      el.addEventListener('click', (e) => {
        e.stopPropagation()
        if (item.direct) {
          triggerTwitchFeature(item.action)
          return
        }
        if (!ch) {
          showToast(t('mc_twitchapi_no_channel'), 'error')
          return
        }
        try {
          window.open(item.url(ch), '_blank', item.opts || 'noopener')
        } catch {}
      })
      wrap.appendChild(el)
    }
  }
  return wrap
}

// ─── Twitch chat modes ──────────────────────────────────────────────────────
// The web client can't call Helix /chat/settings (404). Every mode goes through
// ONE GQL mutation — `updateChatSettings(input: UpdateChatSettingsInput!)`.
// (`SetFollowersOnlyModeSetting` is only a client-side OPERATION name for a
// persisted document; there is no such field on Mutation. Schema-probed
// 2026-07-21: `updateChatSettings` exists, its input type is
// `UpdateChatSettingsInput!`, and `channelID` is a required String!.)
//
// ⚠ Twitch's GQL silently ACCEPTS unknown input fields — a typo'd field name
// returns success and changes nothing. That makes a blind "mutation didn't
// error, report success" fatally dishonest here. So every set is verified by
// reading the mode back and comparing; we only claim success when the channel
// actually changed. Wrong field name ⇒ honest failure, never a false success.
// read  = the field on user.chatSettings used to CONFIRM the change.
// write = the field name to send in UpdateChatSettingsInput, or null when we
//         have no proven way to set that mode on twitch.
//
// Only the DURATION modes are proven: followersOnlyDurationMinutes (long
// shipped) and slowModeDurationSeconds (verified live 2026-07-21 — /slow 5
// landed on a real channel and /slow off cleared it).
//
// The three BOOLEAN modes are deliberately NOT wired for twitch. Both the
// read-type spelling and the un-prefixed variant were sent and changed nothing,
// twitch's GQL exposes no other chat-mode mutation (probed), it silently
// accepts unknown input fields so the name can't be discovered by probing, and
// twitch's own chat-settings menu no longer offers emote-only / subs-only /
// unique-chat as controls — so there is no client request left to copy. Rather
// than ship three commands that fail while blaming the user's mod rights, they
// report plainly that twitch doesn't take them. Kick still sets emote-only and
// subs-only, and that path is proven.
const TWITCH_CHAT_MODE_SPEC = {
  followers: { read: 'followersOnlyDurationMinutes', write: 'followersOnlyDurationMinutes' },
  slow: { read: 'slowModeDurationSeconds', write: 'slowModeDurationSeconds' },
  emoteonly: { read: 'isEmoteOnlyModeEnabled', write: null },
  subscribers: { read: 'isSubscribersOnlyModeEnabled', write: null },
  unique: { read: 'isUniqueChatModeEnabled', write: null },
}

// Live chat-mode state. Verified against twitch's schema 2026-07-21:
// user.chatSettings — off reads back as null for the duration modes.
async function readTwitchChatSettings(channelLogin) {
  const lc = String(channelLogin || '')
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/[^a-z0-9_]/g, '')
  if (!lc) return null
  try {
    const data = await twitchGql(
      `{ user(login: "${lc}") { chatSettings { slowModeDurationSeconds followersOnlyDurationMinutes isEmoteOnlyModeEnabled isSubscribersOnlyModeEnabled isUniqueChatModeEnabled } } }`,
    )
    return data?.data?.user?.chatSettings || null
  } catch {
    return null
  }
}

// Did the channel land on what we asked for? Duration modes report "off" as
// null, so -1/0 (our off encodings) must accept null as a match.
function _twitchChatModeMatches(mode, want, got) {
  // The null checks are load-bearing: Number(null) is 0, so a lazy numeric
  // compare would read "mode is OFF" as proof that `/followers` (0 = any
  // follower, i.e. mode ON) applied — a false success in the exact case this
  // verification exists to catch.
  if (mode === 'followers') {
    if (want < 0) return got == null
    return got != null && Number(got) === Number(want)
  }
  if (mode === 'slow') {
    if (want <= 0) return got == null || Number(got) === 0
    return got != null && Number(got) === Number(want)
  }
  return !!got === !!want
}

// mode: followers|slow|emoteonly|subscribers|unique
// value: followers −1=off, 0=any follower, N=minutes · slow 0=off, N=seconds ·
//        booleans for the rest.
async function setTwitchChatMode(channelLogin, mode, value) {
  const spec = TWITCH_CHAT_MODE_SPEC[mode]
  if (!spec) return { ok: false, error: 'unknown chat mode' }
  // Honest refusal beats a mod action that quietly does nothing.
  if (!spec.write) return { ok: false, unsupported: true, error: 'twitch has no api for this mode' }
  const { id: channelID, transient } = await resolveTwitchChannelIdEx(channelLogin)
  if (!channelID) return { ok: false, error: transient ? 'twitch unreachable — try again' : 'channel not found' }
  try {
    const input = { channelID: String(channelID), [spec.write]: value }
    const res = await gqlMutation(
      'mutation($input: UpdateChatSettingsInput!) { updateChatSettings(input: $input) { __typename } }',
      { input },
    )
    const err = res?.errors?.[0]?.message || res?.data?.errors?.[0]?.message
    if (err) return { ok: false, error: err }
  } catch (e) {
    return { ok: false, error: e?.message || 'failed' }
  }
  // Read back — the ONLY thing that proves the change took. One retry covers
  // read-after-write lag before we call it a failure.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 400))
    const after = await readTwitchChatSettings(channelLogin)
    if (!after) continue
    if (_twitchChatModeMatches(mode, value, after[spec.read])) return { ok: true }
  }
  // Reached twitch, no error, and nothing changed: either we lack mod rights
  // (twitch answers some refusals without an error body) or the field name
  // drifted. Never report this as success.
  return { ok: false, error: 'twitch did not apply it (mod rights?)' }
}

// Back-compat wrapper — followers-only was the one mode already wired.
async function setTwitchFollowersMode(channelLogin, minutes) {
  return setTwitchChatMode(channelLogin, 'followers', minutes)
}

function makeCoinSvg(size) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('viewBox', '0 0 20 20')
  svg.style.verticalAlign = '-2px'
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.style.fill = 'var(--hs-gold)'
  path.setAttribute('d', 'M10 6a4 4 0 100 8 4 4 0 000-8zm0-4a8 8 0 110 16 8 8 0 010-16z')
  svg.appendChild(path)
  return svg
}

function outcomeColor(color) {
  const map = {
    PINK: '#f5009b',
    BLUE: '#387aff',
    ORANGE: '#fff',
    GREEN: '#00c853',
    TEAL: '#00bcd4',
    PURPLE: '#9c27b0',
    YELLOW: '#fdd835',
    LIGHT_BLUE: '#4fc3f7',
    RED: '#e53935',
    BROWN: '#795548',
  }
  return map[color] || '#387aff'
}

function makePointIcon(size, cpImage) {
  if (cpImage) {
    const img = document.createElement('img')
    img.src = cpImage
    img.width = size
    img.height = size
    img.style.verticalAlign = '-2px'
    img.style.borderRadius = '50%'
    return img
  }
  return makeCoinSvg(size)
}

function renderPrediction(pred, balance, channelId, isMod, cpImage, cpName) {
  const frag = document.createDocumentFragment()
  const isLocked = pred.status === 'LOCKED'
  const isResolved = pred.status === 'RESOLVED'
  const isCanceled = pred.status === 'CANCELED'
  const isEnded = isResolved || isCanceled
  if (isEnded) _userBets.delete(pred.id)
  const totalPoints = pred.outcomes.reduce((s, o) => s + (o.totalPoints || 0), 0)
  const createdAt = new Date(pred.createdAt).getTime()
  const windowMs = (pred.predictionWindowSeconds || 120) * 1000
  const endsAt = createdAt + windowMs
  const userBet = _userBets.get(pred.id)
  const winningId = pred.winningOutcome?.id || null

  const wrapper = document.createElement('div')
  wrapper.className = `hs-mc-prediction${isResolved ? ' hs-mc-pred-resolved' : ''}${isCanceled ? ' hs-mc-pred-canceled' : ''}`
  wrapper.dataset.eventId = pred.id
  if (channelId) wrapper.dataset.channelId = channelId

  // Header
  const header = document.createElement('div')
  header.className = 'hs-mc-pred-header'
  const title = document.createElement('div')
  title.className = 'hs-mc-pred-title'
  // Render emotes/emoji in prediction title — content sanitized via escapeHtml() then processEmotes()
  // This is the same pattern used for all chat messages in main.js (existing safe innerHTML pattern)
  title.innerHTML =
    typeof processEmotes === 'function' ? processEmotes(escapeHtml(pred.title), null) : escapeHtml(pred.title)
  header.appendChild(title)

  if (isCanceled) {
    const badge = document.createElement('span')
    badge.className = 'hs-mc-pred-status hs-mc-pred-status-canceled'
    badge.textContent = t('mc_pred_refunded')
    header.appendChild(badge)
  } else if (isResolved) {
    const badge = document.createElement('span')
    badge.className = 'hs-mc-pred-status hs-mc-pred-status-resolved'
    badge.textContent = t('mc_pred_ended')
    header.appendChild(badge)
  } else if (isLocked) {
    const badge = document.createElement('span')
    badge.className = 'hs-mc-pred-locked'
    badge.textContent = t('mc_pred_locked')
    header.appendChild(badge)
  } else {
    const timer = document.createElement('span')
    timer.className = 'hs-mc-pred-timer'
    timer.dataset.ends = endsAt
    header.appendChild(timer)
  }
  wrapper.appendChild(header)

  // Balance
  if (balance != null && !isEnded) {
    const bal = document.createElement('div')
    bal.className = 'hs-mc-pred-balance'
    bal.appendChild(makePointIcon(14, cpImage))
    bal.appendChild(document.createTextNode(` ${formatPoints(balance)}${cpName ? ` ${cpName}` : ''}`))
    wrapper.appendChild(bal)
  }

  // User bet result banner
  if (isResolved && userBet && winningId) {
    const won = userBet.outcomeId === winningId
    const banner = document.createElement('div')
    banner.className = `hs-mc-pred-result ${won ? 'hs-mc-pred-result-won' : 'hs-mc-pred-result-lost'}`
    if (won) {
      const winOutcome = pred.outcomes.find((o) => o.id === winningId)
      const pct = totalPoints > 0 && winOutcome ? winOutcome.totalPoints / totalPoints : 1
      const payout = pct > 0 ? Math.floor(userBet.points / pct) : userBet.points
      banner.appendChild(makePointIcon(18, cpImage))
      const amt = document.createElement('span')
      amt.className = 'hs-mc-pred-result-amount'
      amt.textContent = ` +${formatPoints(payout)}`
      banner.appendChild(amt)
      const label = document.createElement('span')
      label.className = 'hs-mc-pred-result-label'
      label.textContent = ' won'
      banner.appendChild(label)
    } else {
      const amt = document.createElement('span')
      amt.className = 'hs-mc-pred-result-amount'
      amt.textContent = `-${formatPoints(userBet.points)}`
      banner.appendChild(amt)
      const label = document.createElement('span')
      label.className = 'hs-mc-pred-result-label'
      label.textContent = ' lost'
      banner.appendChild(label)
    }
    wrapper.appendChild(banner)
  } else if (isCanceled && userBet) {
    const banner = document.createElement('div')
    banner.className = 'hs-mc-pred-result hs-mc-pred-result-refund'
    banner.appendChild(makePointIcon(18, cpImage))
    const amt = document.createElement('span')
    amt.className = 'hs-mc-pred-result-amount'
    amt.textContent = ` +${formatPoints(userBet.points)}`
    banner.appendChild(amt)
    const label = document.createElement('span')
    label.className = 'hs-mc-pred-result-label'
    label.textContent = ` ${t('mc_pred_refunded')}`
    banner.appendChild(label)
    wrapper.appendChild(banner)
  } else if (isResolved && !userBet) {
    const banner = document.createElement('div')
    banner.className = 'hs-mc-pred-result hs-mc-pred-result-neutral'
    const winOutcome = pred.outcomes.find((o) => o.id === winningId)
    banner.textContent = winOutcome ? `\u2713 ${winOutcome.title}` : t('mc_pred_ended')
    wrapper.appendChild(banner)
  }

  // Outcomes
  const outcomesWrap = document.createElement('div')
  outcomesWrap.className = 'hs-mc-pred-outcomes'

  for (const outcome of pred.outcomes) {
    const pct = totalPoints > 0 ? Math.round((outcome.totalPoints / totalPoints) * 100) : 0
    const color = outcomeColor(outcome.color)
    const userCount = outcome.totalUsers || 0
    const points = outcome.totalPoints || 0
    const isWinner = winningId === outcome.id
    const isLoser = isResolved && !isWinner
    const isBetOn = userBet?.outcomeId === outcome.id

    const card = document.createElement('div')
    card.className =
      'hs-mc-pred-outcome' +
      (isWinner ? ' hs-mc-pred-outcome-won' : '') +
      (isLoser ? ' hs-mc-pred-outcome-lost' : '') +
      (isBetOn ? ' hs-mc-pred-outcome-yours' : '')
    card.style.setProperty('--oc', color)

    const head = document.createElement('div')
    head.className = 'hs-mc-pred-outcome-head'
    const titleSpan = document.createElement('span')
    titleSpan.className = 'hs-mc-pred-outcome-title'
    // Render emotes/emoji in outcome title — sanitized via escapeHtml() + processEmotes() (same as chat messages)
    titleSpan.innerHTML =
      typeof processEmotes === 'function' ? processEmotes(escapeHtml(outcome.title), null) : escapeHtml(outcome.title)
    if (isWinner) {
      const winBadge = document.createElement('span')
      winBadge.className = 'hs-mc-pred-winner-badge'
      winBadge.textContent = t('mc_pred_winner')
      titleSpan.appendChild(document.createTextNode(' '))
      titleSpan.appendChild(winBadge)
    }
    const pctSpan = document.createElement('span')
    pctSpan.className = 'hs-mc-pred-outcome-pct'
    pctSpan.textContent = `${pct}%`
    head.appendChild(titleSpan)
    head.appendChild(pctSpan)
    card.appendChild(head)

    const track = document.createElement('div')
    track.className = 'hs-mc-pred-bar-track'
    const fill = document.createElement('div')
    fill.className = 'hs-mc-pred-bar-fill'
    fill.style.width = `${pct}%`
    track.appendChild(fill)
    card.appendChild(track)

    const stats = document.createElement('div')
    stats.className = 'hs-mc-pred-outcome-stats'
    let statsText = `${formatPoints(points)} pts \u00b7 ${userCount} bettor${userCount !== 1 ? 's' : ''}`
    if (isBetOn) statsText += ` \u00b7 your bet: ${formatPoints(userBet.points)}`
    stats.textContent = statsText
    card.appendChild(stats)

    if (!isLocked && !isEnded && (!userBet || isBetOn)) {
      const betRow = document.createElement('div')
      betRow.className = 'hs-mc-pred-bet-row'
      for (const amt of [100, 1000, 5000]) {
        const btn = document.createElement('button')
        btn.className = 'hs-mc-pred-bet-btn'
        btn.dataset.outcome = outcome.id
        btn.dataset.points = amt
        btn.style.setProperty('--oc', color)
        if (balance != null && balance < amt) btn.disabled = true
        btn.textContent = formatPoints(amt)
        betRow.appendChild(btn)
      }

      // Max button
      if (balance != null && balance > 0) {
        const maxBtn = document.createElement('button')
        maxBtn.className = 'hs-mc-pred-bet-btn hs-mc-pred-bet-max'
        maxBtn.dataset.outcome = outcome.id
        maxBtn.dataset.points = balance
        maxBtn.style.setProperty('--oc', color)
        maxBtn.textContent = 'max'
        betRow.appendChild(maxBtn)
      }

      const customInput = document.createElement('input')
      customInput.className = 'hs-mc-pred-bet-custom'
      customInput.type = 'text'
      customInput.placeholder = 'amt'
      customInput.dataset.outcome = outcome.id
      if (balance != null && balance <= 0) customInput.disabled = true
      betRow.appendChild(customInput)

      const goBtn = document.createElement('button')
      goBtn.className = 'hs-mc-pred-bet-go'
      goBtn.dataset.outcome = outcome.id
      goBtn.style.setProperty('--oc', color)
      goBtn.textContent = 'bet'
      if (balance != null && balance <= 0) goBtn.disabled = true
      betRow.appendChild(goBtn)

      card.appendChild(betRow)
    }

    // Mod resolve button per outcome (when locked)
    if (isLocked && isMod) {
      const resolveBtn = document.createElement('button')
      resolveBtn.className = 'hs-mc-pred-mod-btn hs-mc-pred-resolve-btn'
      resolveBtn.dataset.outcome = outcome.id
      resolveBtn.style.setProperty('--oc', color)
      if (isBetOn) {
        resolveBtn.textContent = t('mc_pred_pick_winner_bet')
        resolveBtn.classList.add('hs-mc-pred-resolve-yours')
      } else {
        resolveBtn.textContent = t('mc_pred_pick_winner')
      }
      card.appendChild(resolveBtn)
    }

    outcomesWrap.appendChild(card)
  }

  wrapper.appendChild(outcomesWrap)

  // Mod conflict notice — mod bet on this prediction and needs to resolve it
  if (isLocked && isMod && userBet) {
    const notice = document.createElement('div')
    notice.className = 'hs-mc-pred-mod-notice'
    const betOutcome = pred.outcomes.find((o) => o.id === userBet.outcomeId)
    notice.textContent = `you bet ${formatPoints(userBet.points)} on ${betOutcome?.title || '?'} \u2014 pick the actual winner`
    wrapper.appendChild(notice)
  }

  // Mod controls
  if (!isEnded && isMod) {
    const modRow = document.createElement('div')
    modRow.className = 'hs-mc-pred-mod-row'

    if (!isLocked) {
      const lockBtn = document.createElement('button')
      lockBtn.className = 'hs-mc-pred-mod-btn hs-mc-pred-lock-btn'
      lockBtn.textContent = t('mc_pred_lock_betting')
      modRow.appendChild(lockBtn)
    }

    const cancelBtn = document.createElement('button')
    cancelBtn.className = 'hs-mc-pred-mod-btn hs-mc-pred-cancel-btn'
    cancelBtn.textContent = t('mc_pred_cancel_refund')
    modRow.appendChild(cancelBtn)

    wrapper.appendChild(modRow)
  }

  frag.appendChild(wrapper)
  return frag
}

function renderNoPrediction(balance, channelId, isMod, cpImage, cpName) {
  const wrap = document.createElement('div')
  wrap.className = 'hs-mc-pred-empty'
  if (channelId) wrap.dataset.channelId = channelId

  const text = document.createElement('div')
  text.className = 'hs-mc-pred-empty-text'
  text.textContent = t('mc_pred_no_active')
  wrap.appendChild(text)

  if (balance != null) {
    const bal = document.createElement('div')
    bal.className = 'hs-mc-pred-balance'
    bal.style.marginTop = '8px'
    bal.appendChild(makePointIcon(14, cpImage))
    bal.appendChild(document.createTextNode(` ${formatPoints(balance)}${cpName ? ` ${cpName}` : ''}`))
    wrap.appendChild(bal)
  }

  // Create prediction form (mod feature)
  if (!isMod) return wrap
  const createWrap = document.createElement('div')
  createWrap.className = 'hs-mc-pred-create'

  const toggle = document.createElement('button')
  toggle.className = 'hs-mc-pred-mod-btn hs-mc-pred-create-toggle'
  toggle.textContent = t('mc_pred_new')
  createWrap.appendChild(toggle)

  const form = document.createElement('div')
  form.className = 'hs-mc-pred-create-form'
  form.style.display = 'none'

  const titleInput = document.createElement('input')
  titleInput.className = 'hs-mc-pred-create-input'
  titleInput.placeholder = t('mc_pred_title_placeholder')
  titleInput.maxLength = 45
  form.appendChild(titleInput)

  const opt1 = document.createElement('input')
  opt1.className = 'hs-mc-pred-create-input hs-mc-pred-create-outcome'
  opt1.placeholder = t('mc_pred_option1')
  opt1.maxLength = 25
  form.appendChild(opt1)

  const opt2 = document.createElement('input')
  opt2.className = 'hs-mc-pred-create-input hs-mc-pred-create-outcome'
  opt2.placeholder = t('mc_pred_option2')
  opt2.maxLength = 25
  form.appendChild(opt2)

  const durRow = document.createElement('div')
  durRow.className = 'hs-mc-pred-create-dur-row'
  const durLabel = document.createElement('span')
  durLabel.className = 'hs-mc-pred-create-dur-label'
  durLabel.textContent = t('mc_pred_duration')
  durRow.appendChild(durLabel)
  for (const secs of [30, 60, 120, 300, 600, 1800]) {
    const btn = document.createElement('button')
    btn.className = `hs-mc-pred-create-dur${secs === 120 ? ' hs-mc-pred-create-dur-active' : ''}`
    btn.dataset.secs = secs
    btn.tabIndex = -1
    btn.textContent = secs < 60 ? `${secs}s` : `${secs / 60}m`
    durRow.appendChild(btn)
  }
  form.appendChild(durRow)

  const submitBtn = document.createElement('button')
  submitBtn.className = 'hs-mc-pred-mod-btn hs-mc-pred-create-submit'
  submitBtn.tabIndex = -1
  submitBtn.textContent = t('mc_pred_create')
  form.appendChild(submitBtn)

  createWrap.appendChild(form)
  wrap.appendChild(createWrap)

  return wrap
}

function renderRewards(rewards, balance, channelId) {
  const section = document.createElement('div')
  section.className = 'hs-mc-rewards'

  const header = document.createElement('div')
  header.className = 'hs-mc-rewards-header'
  const label = document.createElement('span')
  label.className = 'hs-mc-rewards-label'
  label.textContent = t('mc_reward_rewards')
  header.appendChild(label)
  if (balance != null) {
    const bal = document.createElement('span')
    bal.className = 'hs-mc-rewards-balance'
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('width', '12')
    svg.setAttribute('height', '12')
    svg.setAttribute('viewBox', '0 0 20 20')
    svg.style.verticalAlign = '-1px'
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.style.fill = 'var(--hs-gold)'
    path.setAttribute('d', 'M10 6a4 4 0 100 8 4 4 0 000-8zm0-4a8 8 0 110 16 8 8 0 010-16z')
    svg.appendChild(path)
    bal.appendChild(svg)
    bal.appendChild(document.createTextNode(` ${formatPoints(balance)}`))
    header.appendChild(bal)
  }
  section.appendChild(header)

  if (!rewards.length) {
    const empty = document.createElement('div')
    empty.className = 'hs-mc-rewards-empty'
    empty.textContent = t('mc_reward_none')
    section.appendChild(empty)
    return section
  }

  const grid = document.createElement('div')
  grid.className = 'hs-mc-rewards-grid'

  for (const reward of rewards) {
    const now = Date.now()
    const onCooldown = reward.cooldownExpiresAt && new Date(reward.cooldownExpiresAt).getTime() > now
    const available = !reward.isPaused && reward.isInStock && !onCooldown
    const card = document.createElement('div')
    card.className = `hs-mc-reward-card${available ? '' : ' hs-mc-reward-unavailable'}`
    card.dataset.rewardId = reward.id
    card.dataset.cost = reward.cost
    card.dataset.title = reward.title
    card.dataset.channelId = channelId
    if (reward.isUserInputRequired) card.dataset.textRequired = '1'
    if (reward.prompt) card.dataset.prompt = reward.prompt
    card.style.setProperty('--rc', reward.backgroundColor || '#9146ff')

    const imgUrl = reward.image?.url || reward.defaultImage?.url || ''
    if (imgUrl) {
      const img = document.createElement('img')
      img.className = 'hs-mc-reward-img'
      img.src = imgUrl
      img.width = 28
      img.height = 28
      card.appendChild(img)
    }

    const info = document.createElement('div')
    info.className = 'hs-mc-reward-info'
    const titleEl = document.createElement('div')
    titleEl.className = 'hs-mc-reward-title'
    titleEl.textContent = reward.title
    info.appendChild(titleEl)

    const costEl = document.createElement('div')
    costEl.className = 'hs-mc-reward-cost'
    const costSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    costSvg.setAttribute('width', '10')
    costSvg.setAttribute('height', '10')
    costSvg.setAttribute('viewBox', '0 0 20 20')
    costSvg.style.verticalAlign = '-1px'
    const costPath = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    costPath.style.fill = 'var(--hs-gold)'
    costPath.setAttribute('d', 'M10 6a4 4 0 100 8 4 4 0 000-8zm0-4a8 8 0 110 16 8 8 0 010-16z')
    costSvg.appendChild(costPath)
    costEl.appendChild(costSvg)
    costEl.appendChild(document.createTextNode(` ${formatPoints(reward.cost)}`))
    info.appendChild(costEl)

    if (!available) {
      const reason = document.createElement('div')
      reason.className = 'hs-mc-reward-reason'
      if (reward.isPaused) reason.textContent = t('mc_reward_paused')
      else if (!reward.isInStock) reason.textContent = t('mc_reward_out_of_stock')
      else if (onCooldown) {
        const secs = Math.ceil((new Date(reward.cooldownExpiresAt).getTime() - now) / 1000)
        reason.textContent = secs > 60 ? `${Math.ceil(secs / 60)}m cooldown` : `${secs}s cooldown`
        reason.dataset.cooldownEnds = new Date(reward.cooldownExpiresAt).getTime()
      }
      info.appendChild(reason)
    }

    card.appendChild(info)
    grid.appendChild(card)
  }

  section.appendChild(grid)
  return section
}

function attachRewardHandlers() {
  const container = document.getElementById('hs-mc-tab-twitch')
  if (!container) return

  container.querySelectorAll('.hs-mc-reward-card:not(.hs-mc-reward-unavailable)').forEach((card) => {
    card.addEventListener('click', async (e) => {
      e.stopPropagation()
      if (card.querySelector('.hs-mc-reward-input-row')) return

      if (card.dataset.textRequired === '1') {
        const existing = card.parentElement.querySelector('.hs-mc-reward-input-row')
        if (existing) existing.remove()
        const row = document.createElement('div')
        row.className = 'hs-mc-reward-input-row'
        const input = document.createElement('input')
        input.className = 'hs-mc-reward-input'
        input.type = 'text'
        input.placeholder = card.dataset.prompt || t('mc_reward_enter_text')
        const btn = document.createElement('button')
        btn.className = 'hs-mc-reward-submit'
        btn.textContent = t('mc_reward_redeem')
        row.appendChild(input)
        row.appendChild(btn)
        card.after(row)
        input.focus()

        btn.addEventListener('click', async (ev) => {
          ev.stopPropagation()
          const text = input.value.trim()
          if (!text) return
          btn.disabled = true
          btn.textContent = '...'
          const result = await redeemChannelReward(
            card.dataset.channelId,
            card.dataset.rewardId,
            parseInt(card.dataset.cost, 10),
            card.dataset.title,
            text,
          )
          if (result.error) {
            btn.textContent = '!'
            btn.title = result.error
            setTimeout(() => {
              btn.textContent = t('mc_reward_redeem')
              btn.disabled = false
              btn.title = ''
            }, 2000)
          } else {
            btn.textContent = '\u2713'
            _rewardsCache = null
            setTimeout(() => renderTwitchTab(), 500)
          }
        })
        return
      }

      const titleEl = card.querySelector('.hs-mc-reward-title')
      const origText = titleEl.textContent
      titleEl.textContent = '...'
      card.style.pointerEvents = 'none'
      const result = await redeemChannelReward(
        card.dataset.channelId,
        card.dataset.rewardId,
        parseInt(card.dataset.cost, 10),
        card.dataset.title,
      )
      if (result.error) {
        titleEl.textContent = '!'
        card.title = result.error
        setTimeout(() => {
          titleEl.textContent = origText
          card.style.pointerEvents = ''
          card.title = ''
        }, 2000)
      } else {
        titleEl.textContent = '\u2713'
        _rewardsCache = null
        setTimeout(() => renderTwitchTab(), 500)
      }
    })
  })

  // Cooldown timers
  container.querySelectorAll('.hs-mc-reward-reason[data-cooldown-ends]').forEach((el) => {
    const endsAt = parseInt(el.dataset.cooldownEnds, 10)
    const iv = cleanup.setIntervalIfVisible(() => {
      if (!el.isConnected) {
        cleanup.clearInterval(iv)
        return
      }
      const secs = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000))
      if (secs <= 0) {
        _rewardsCache = null
        renderTwitchTab()
        cleanup.clearInterval(iv)
        return
      }
      el.textContent = secs > 60 ? `${Math.ceil(secs / 60)}m cooldown` : `${secs}s cooldown`
    }, 1000)
  })
}

// Optimistic UI update after a bet — patches DOM immediately without server round-trip
function optimisticBetUpdate(container, outcomeId, points) {
  // Find which card has this outcome by checking all data-outcome elements
  const allOutcomeEls = container.querySelectorAll('[data-outcome]')
  const targetCards = new Set()
  const otherCards = new Set()
  allOutcomeEls.forEach((el) => {
    const card = el.closest('.hs-mc-pred-outcome')
    if (!card) return
    if (el.dataset.outcome === outcomeId) targetCards.add(card)
    else otherCards.add(card)
  })

  // Update target outcome stats
  targetCards.forEach((card) => {
    const statsEl = card.querySelector('.hs-mc-pred-outcome-stats')
    if (!statsEl) return
    const text = statsEl.textContent
    const ptsMatch = text.match(/([\d,.]+[KMB]?)\s*pts/i)
    const voterMatch = text.match(/(\d+)\s*bettor/)
    const betMatch = text.match(/your bet:\s*([\d,.]+[KMB]?)/i)
    const currentPts = ptsMatch ? parsePoints(ptsMatch[1]) : 0
    const currentVoters = voterMatch ? parseInt(voterMatch[1], 10) : 0
    const existingBet = betMatch ? parsePoints(betMatch[1]) : 0

    const newPts = currentPts + points
    const newVoters = existingBet ? currentVoters : currentVoters + 1
    const newBet = existingBet + points

    let newText = `${formatPoints(newPts)} pts \u00b7 ${newVoters} voter${newVoters !== 1 ? 's' : ''}`
    newText += ` \u00b7 your bet: ${formatPoints(newBet)}`
    statsEl.textContent = newText
    card.classList.add('hs-mc-pred-outcome-yours')
  })

  // Hide bet rows on other outcomes
  otherCards.forEach((card) => {
    if (targetCards.has(card)) return
    const betRow = card.querySelector('.hs-mc-pred-bet-row')
    if (betRow) betRow.style.display = 'none'
  })

  // Update bar percentages across all outcomes
  const pred = container.querySelector('.hs-mc-prediction')
  if (!pred) return
  const outcomes = pred.querySelectorAll('.hs-mc-pred-outcome')
  let total = 0
  const ptsArr = []
  outcomes.forEach((card) => {
    const text = card.querySelector('.hs-mc-pred-outcome-stats')?.textContent || ''
    const m = text.match(/([\d,.]+[KMB]?)\s*pts/i)
    ptsArr.push(m ? parsePoints(m[1]) : 0)
    total += ptsArr[ptsArr.length - 1]
  })
  outcomes.forEach((card, i) => {
    const pct = total > 0 ? Math.round((ptsArr[i] / total) * 100) : 0
    const pctEl = card.querySelector('.hs-mc-pred-outcome-pct')
    if (pctEl) pctEl.textContent = `${pct}%`
    const fill = card.querySelector('.hs-mc-pred-bar-fill')
    if (fill) fill.style.width = `${pct}%`
  })

  // Update balance
  const balEl = pred.querySelector('.hs-mc-pred-balance')
  if (balEl?.lastChild) {
    const currentBal = parsePoints(balEl.textContent.trim())
    balEl.lastChild.textContent = ` ${formatPoints(Math.max(0, currentBal - points))}`
  }
}

function attachPredictionHandlers() {
  const container = document.getElementById('hs-mc-tab-twitch')
  if (!container) return

  // Human-readable prediction error messages
  const predErrorMsg = (code) => {
    if (!code) return 'failed'
    const c = code.toUpperCase()
    if (c.includes('EVENT_MANAGER') || c.includes('OWNER')) return "can't bet on own"
    if (c.includes('ACCEPT') || c.includes('TOS')) return 'try again'
    if (c.includes('NOT_FOUND')) return 'prediction ended'
    if (c.includes('LOCKED')) return 'betting locked'
    if (c.includes('INSUFFICIENT') || c.includes('BALANCE')) return 'not enough points'
    if (c.includes('ALREADY')) return 'already bet'
    if (c.includes('FORBIDDEN')) return 'no permission'
    return code.toLowerCase().slice(0, 15)
  }

  // Bet button handlers
  container.querySelectorAll('.hs-mc-pred-bet-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation()
      const eventId = container.querySelector('.hs-mc-prediction')?.dataset.eventId
      if (!eventId) return
      btn.disabled = true
      btn.textContent = '...'
      const betPoints = parseInt(btn.dataset.points, 10)
      const result = await placePredictionBet(eventId, btn.dataset.outcome, betPoints)
      if (result.error) {
        btn.textContent = predErrorMsg(result.error)
        btn.title = result.error
        setTimeout(() => {
          btn.textContent = formatPoints(betPoints)
          btn.disabled = false
          btn.title = ''
        }, 4000)
      } else {
        btn.textContent = '\u2713'
        try {
          optimisticBetUpdate(container, btn.dataset.outcome, betPoints)
        } catch {}
        setTimeout(() => refreshPredictionSlot(), 3000)
      }
    })
  })

  // Custom bet "go" buttons
  container.querySelectorAll('.hs-mc-pred-bet-go').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation()
      const eventId = container.querySelector('.hs-mc-prediction')?.dataset.eventId
      if (!eventId) return
      const input = container.querySelector(`.hs-mc-pred-bet-custom[data-outcome="${btn.dataset.outcome}"]`)
      const points = parsePoints(input?.value)
      if (!points || points < 1) return
      btn.disabled = true
      btn.textContent = '...'
      const result = await placePredictionBet(eventId, btn.dataset.outcome, points)
      if (result.error) {
        btn.textContent = predErrorMsg(result.error)
        btn.title = result.error
        setTimeout(() => {
          btn.textContent = 'bet'
          btn.disabled = false
          btn.title = ''
        }, 3000)
      } else {
        btn.textContent = '\u2713'
        // Guard like the fixed-amount path: a detached container (slot re-rendered
        // during the await) would otherwise throw and skip the input clear + the
        // 3s refresh, leaving stale totals and the typed amount on screen.
        try {
          optimisticBetUpdate(container, btn.dataset.outcome, points)
        } catch {}
        input.value = ''
        setTimeout(() => refreshPredictionSlot(), 3000)
      }
    })
  })

  // Enter key in custom input triggers bet
  container.querySelectorAll('.hs-mc-pred-bet-custom').forEach((input) => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        const goBtn = container.querySelector(`.hs-mc-pred-bet-go[data-outcome="${input.dataset.outcome}"]`)
        if (goBtn && !goBtn.disabled) goBtn.click()
      }
    })
  })

  // Mod: lock betting
  container.querySelectorAll('.hs-mc-pred-lock-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation()
      const eventId =
        btn.closest('.hs-mc-prediction')?.dataset.eventId ||
        container.querySelector('.hs-mc-prediction')?.dataset.eventId
      if (!eventId) {
        btn.textContent = 'no event'
        return
      }
      btn.disabled = true
      btn.textContent = '...'
      const result = await lockPrediction(eventId)
      if (result.error) {
        btn.textContent = predErrorMsg(result.error)
        btn.title = result.error
        setTimeout(() => {
          btn.textContent = t('mc_pred_lock_betting')
          btn.disabled = false
          btn.title = ''
        }, 3000)
      } else {
        // Hide bet rows + lock button immediately, keep resolve/cancel
        const pred = btn.closest('.hs-mc-prediction') || container.querySelector('.hs-mc-prediction')
        if (pred) {
          pred.querySelectorAll('.hs-mc-pred-bet-row').forEach((el) => {
            el.remove()
          })
          pred.querySelector('.hs-mc-pred-lock-btn')?.remove()
        }
        btn.textContent = `\u2713 ${t('mc_pred_locked')}`
        setTimeout(() => refreshPredictionSlot(), 2000)
      }
    })
  })

  // Mod: resolve (pick winner)
  container.querySelectorAll('.hs-mc-pred-resolve-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation()
      const eventId =
        btn.closest('.hs-mc-prediction')?.dataset.eventId ||
        container.querySelector('.hs-mc-prediction')?.dataset.eventId
      if (!eventId) {
        btn.textContent = 'no event'
        return
      }
      const outcomeId = btn.dataset.outcome
      if (!outcomeId) {
        btn.textContent = 'no outcome'
        return
      }
      btn.disabled = true
      btn.textContent = '...'
      const result = await resolvePrediction(eventId, outcomeId)
      if (result.error) {
        btn.textContent = predErrorMsg(result.error)
        btn.title = result.error
        setTimeout(() => {
          btn.textContent = t('mc_pred_pick_winner')
          btn.disabled = false
          btn.title = ''
        }, 3000)
      } else {
        // Immediately clean up stale UI
        const pred = btn.closest('.hs-mc-prediction') || container.querySelector('.hs-mc-prediction')
        if (pred) {
          pred
            .querySelectorAll(
              '.hs-mc-pred-mod-row, .hs-mc-pred-mod-notice, .hs-mc-pred-bet-row, .hs-mc-pred-resolve-btn',
            )
            .forEach((el) => {
              el.remove()
            })
          pred.classList.add('hs-mc-pred-resolved')
        }
        btn.textContent = `\u2713 ${t('mc_pred_ended')}`
        setTimeout(() => refreshPredictionSlot(), 2000)
      }
    })
  })

  // Mod: cancel (refund)
  container.querySelectorAll('.hs-mc-pred-cancel-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation()
      const eventId =
        btn.closest('.hs-mc-prediction')?.dataset.eventId ||
        container.querySelector('.hs-mc-prediction')?.dataset.eventId
      if (!eventId) {
        btn.textContent = 'no event'
        return
      }
      btn.disabled = true
      btn.textContent = '...'
      const result = await cancelPrediction(eventId)
      if (result.error) {
        btn.textContent = predErrorMsg(result.error)
        btn.title = result.error
        setTimeout(() => {
          btn.textContent = t('mc_pred_cancel_refund')
          btn.disabled = false
          btn.title = ''
        }, 3000)
      } else {
        const pred = btn.closest('.hs-mc-prediction') || container.querySelector('.hs-mc-prediction')
        if (pred) {
          pred
            .querySelectorAll(
              '.hs-mc-pred-mod-row, .hs-mc-pred-mod-notice, .hs-mc-pred-bet-row, .hs-mc-pred-resolve-btn',
            )
            .forEach((el) => {
              el.remove()
            })
          pred.classList.add('hs-mc-pred-canceled')
        }
        btn.textContent = `\u2713 ${t('mc_pred_refunded')}`
        setTimeout(() => refreshPredictionSlot(), 2000)
      }
    })
  })

  // Create form: Tab cycles inputs, Enter submits, Escape closes
  const createInputs = [...container.querySelectorAll('.hs-mc-pred-create-input')]
  createInputs.forEach((input, i) => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault()
        createInputs[(i + (e.shiftKey ? createInputs.length - 1 : 1)) % createInputs.length].focus()
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        const submit = input.closest('.hs-mc-pred-create-form')?.querySelector('.hs-mc-pred-create-submit')
        if (submit && !submit.disabled) submit.click()
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        const toggle = input.closest('.hs-mc-pred-create')?.querySelector('.hs-mc-pred-create-toggle')
        if (toggle) toggle.click()
      }
    })
  })

  // Create prediction form toggle + submit
  container.querySelectorAll('.hs-mc-pred-create-toggle').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const form = btn.parentElement.querySelector('.hs-mc-pred-create-form')
      if (form) {
        const showing = form.style.display !== 'none'
        form.style.display = showing ? 'none' : 'flex'
        btn.textContent = showing ? t('mc_pred_new') : t('mc_pred_cancel_form')
      }
    })
  })

  // Duration picker
  container.querySelectorAll('.hs-mc-pred-create-dur').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      container.querySelectorAll('.hs-mc-pred-create-dur').forEach((b) => {
        b.classList.remove('hs-mc-pred-create-dur-active')
      })
      btn.classList.add('hs-mc-pred-create-dur-active')
    })
  })

  // Create submit
  container.querySelectorAll('.hs-mc-pred-create-submit').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation()
      const channelId = container.querySelector('[data-channel-id]')?.dataset.channelId
      if (!channelId) {
        btn.textContent = 'no channel'
        return
      }
      const form = btn.closest('.hs-mc-pred-create-form')
      const inputs = form.querySelectorAll('.hs-mc-pred-create-input')
      const title = inputs[0]?.value?.trim()
      const outcomes = [...form.querySelectorAll('.hs-mc-pred-create-outcome')]
        .map((i) => i.value.trim())
        .filter(Boolean)
      if (!title) {
        inputs[0].focus()
        return
      }
      if (outcomes.length < 2) {
        form.querySelectorAll('.hs-mc-pred-create-outcome')[outcomes.length]?.focus()
        return
      }
      const durBtn = form.querySelector('.hs-mc-pred-create-dur-active')
      const secs = parseInt(durBtn?.dataset.secs || '120', 10)
      btn.disabled = true
      btn.textContent = '...'
      const result = await createPrediction(channelId, title, secs, outcomes)
      if (result.error) {
        btn.textContent = '!'
        btn.title = result.error
        setTimeout(() => {
          btn.textContent = t('mc_pred_create')
          btn.disabled = false
          btn.title = ''
        }, 2000)
      } else {
        form.style.display = 'none'
        refreshPredictionSlot()
      }
    })
  })

  // Create prediction keyboard nav
  container.querySelectorAll('.hs-mc-pred-create-input').forEach((input) => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault()
        const inputs = [...container.querySelectorAll('.hs-mc-pred-create-input')]
        const idx = inputs.indexOf(input)
        const next = inputs[(idx + 1) % inputs.length]
        next?.focus()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        container.querySelector('.hs-mc-pred-create-submit')?.click()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        container.querySelector('.hs-mc-pred-create-toggle')?.click()
      }
    })
  })

  // Start countdown timers
  container.querySelectorAll('.hs-mc-pred-timer').forEach((el) => {
    const endsAt = parseInt(el.dataset.ends, 10)
    const update = () => {
      const remaining = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000))
      if (remaining <= 0) {
        el.textContent = 'closing...'
        el.classList.add('hs-mc-pred-locked')
        return
      }
      const m = Math.floor(remaining / 60)
      const s = remaining % 60
      el.textContent = m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`
    }
    update()
    const iv = cleanup.setIntervalIfVisible(() => {
      if (!el.isConnected) {
        cleanup.clearInterval(iv)
        return
      }
      update()
    }, 1000)
  })
}

// ═══ Chat overlay banners (predictions + polls at top of messages) ═══

let _bannerTimers = []
let _lastPredResult = null
let _lastPollData = null
let _hypeTrainActive = null // { level, startedAt }
let _bannerFingerprint = '' // avoid rebuilding if nothing changed
const _seenPredChannels = new Set() // channels we've fetched at least once
const _broadcastedPredIds = new Map() // channel → last broadcast pred id
const _seenPollChannels = new Set() // poll equivalents of the above
const _broadcastedPollIds = new Map()

// Emit a chat line when a new prediction starts. Suppresses on first observation
// per channel so opening a tab mid-prediction doesn't spam old events.
function maybeBroadcastNewPrediction(channel, pred) {
  if (!channel) return
  const ch = String(channel).toLowerCase()
  const wasSeen = _seenPredChannels.has(ch)
  _seenPredChannels.add(ch)
  const newId = pred?.id || null
  const prevId = _broadcastedPredIds.get(ch) || null
  if (newId === prevId) return
  _broadcastedPredIds.set(ch, newId)
  if (!wasSeen) return
  if (pred?.status !== 'ACTIVE') return
  try {
    window.postMessage(
      {
        type: 'heatsync-hermes-event',
        eventType: 'prediction-start',
        channel: ch,
        data: { title: pred.title || '', id: pred.id },
      },
      location.origin,
    )
  } catch {}
}

// Polls previously only got the passive chat banner — predictions also fired a
// "new prediction up" alert line, so a viewer who hid the native poll widget (or
// just missed the banner) never knew a poll opened. Mirror the prediction alert:
// dedup per channel, skip the very first fetch (so we don't alert on polls that
// were already live when you arrived), only fire for ACTIVE polls.
function maybeBroadcastNewPoll(channel, pollData) {
  if (!channel) return
  const ch = String(channel).toLowerCase()
  const wasSeen = _seenPollChannels.has(ch)
  _seenPollChannels.add(ch)
  const newId = pollData?.id || null
  const prevId = _broadcastedPollIds.get(ch) || null
  if (newId === prevId) return
  _broadcastedPollIds.set(ch, newId)
  if (!wasSeen) return
  if (pollData?.status !== 'ACTIVE') return
  try {
    window.postMessage(
      {
        type: 'heatsync-hermes-event',
        eventType: 'poll-start',
        channel: ch,
        data: { title: pollData.title || '', id: pollData.id },
      },
      location.origin,
    )
  } catch {}
}

function clearBannerTimers() {
  _bannerTimers.forEach((id) => {
    cleanup.clearInterval(id)
  })
  _bannerTimers = []
}

function _startBannerTimer(el, endsAt) {
  const update = () => {
    const remaining = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000))
    if (remaining <= 0) {
      el.textContent = 'closing'
      return
    }
    const m = Math.floor(remaining / 60)
    const s = remaining % 60
    el.textContent = m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`
  }
  update()
  const iv = cleanup.setIntervalIfVisible(() => {
    if (!el.isConnected) {
      cleanup.clearInterval(iv)
      return
    }
    update()
  }, 1000)
  _bannerTimers.push(iv)
}

function updateChatBanners(predResult, pollData) {
  // One hook keeps the full-area view current: this already runs on every
  // prediction/poll fetch and every pubsub update, so the view needs no second
  // polling loop of its own.
  if (typeof refreshPredViewIfOpen === 'function') refreshPredViewIfOpen()
  const msgsEl = document.getElementById('hs-mc-messages')
  if (!msgsEl) return
  // The banner is an absolute overlay hosted OUTSIDE the scroller (a sibling
  // under #hs-mc-overlay), so appearing/vanishing predictions/polls/hype never
  // reflow chat — it paints OVER the top rows the way #hs-mc-statusbar does.
  // Prepending into the scroller (the old behaviour) reserved layout space and
  // shoved every message row down on each start/end. See 03-overlay-container.
  const bannerHost = msgsEl.parentNode
  if (!bannerHost) return // detached mid-teardown; nothing to host the overlay
  const t = typeof hermesToggles !== 'undefined' ? hermesToggles : {}

  const pred = predResult?.prediction
  const hasPred = t.pred !== false && pred && (pred.status === 'ACTIVE' || pred.status === 'LOCKED')
  const hasPoll = t.poll !== false && pollData && pollData.status === 'ACTIVE'
  const hasHype = t.hype !== false && _hypeTrainActive

  // Fingerprint to avoid unnecessary rebuilds (prevents flash on bet/refresh)
  const userBet = pred ? _userBets.get(pred.id) : null
  const fp = [
    hasPred ? `${pred.id}:${pred.status}:${userBet?.points || 0}` : '',
    hasPoll ? `${pollData.id}:${pollData.status}` : '',
    hasHype ? `hype:${_hypeTrainActive.level}` : '',
  ].join('|')

  if (fp === _bannerFingerprint) return
  _bannerFingerprint = fp

  const old = bannerHost.querySelector('.hs-mc-chat-banner')
  clearBannerTimers()

  if (!hasPred && !hasPoll && !hasHype) {
    if (old) old.remove()
    return
  }

  const banner = old || document.createElement('div')
  banner.className = 'hs-mc-chat-banner'
  banner.innerHTML = ''

  // Clicking the banner opens the predictions/polls surface over the chat area.
  // It used to click the `live` TAB, which just switched channels and left the
  // actual prediction UI where it was — three clicks deep inside the emote
  // picker's twitch sub-tab. The banner is the thing you can see, so it is the
  // thing that should open it.
  const openPredictions = (_e) => {
    if (typeof openPredView === 'function') {
      openPredView(
        _predictionChannel || (typeof getActiveTwitchChannel === 'function' ? getActiveTwitchChannel() : null),
      )
      return
    }
    const twitchTab = document.querySelector('[data-tab="live"]')
    if (twitchTab) twitchTab.click()
  }

  // Prediction with vital info
  if (hasPred) {
    const row = document.createElement('div')
    row.className = 'hs-mc-chat-banner-item hs-mc-chat-banner-pred'
    row.style.cursor = 'pointer'
    row.addEventListener('click', openPredictions)

    // Build: 🔮 title · outcome1 45% vs outcome2 55% · [your bet: 100] · 2:30
    row.innerHTML = '<span class="hs-mc-chat-banner-icon">\u{1F52E}</span>'

    const info = document.createElement('span')
    info.className = 'hs-mc-chat-banner-title'
    const totalPts = pred.outcomes.reduce((s, o) => s + (o.totalPoints || 0), 0)
    const parts = pred.outcomes.map((o) => {
      const pct = totalPts > 0 ? Math.round((o.totalPoints / totalPts) * 100) : 0
      return `${o.title} ${pct}%`
    })
    let text = `${pred.title} \u00b7 ${parts.join(' vs ')}`
    if (userBet) {
      const betOutcome = pred.outcomes.find((o) => o.id === userBet.outcomeId)
      text += ` \u00b7 bet: ${formatPoints(userBet.points)}${betOutcome ? ` ${betOutcome.title}` : ''}`
    }
    info.textContent = text
    row.appendChild(info)

    if (pred.status === 'ACTIVE') {
      const timer = document.createElement('span')
      timer.className = 'hs-mc-chat-banner-timer'
      const createdAt = new Date(pred.createdAt).getTime()
      const windowMs = (pred.predictionWindowSeconds || 120) * 1000
      _startBannerTimer(timer, createdAt + windowMs)
      row.appendChild(timer)
    } else {
      const badge = document.createElement('span')
      badge.className = 'hs-mc-chat-banner-badge'
      badge.textContent = t('mc_pred_locked')
      row.appendChild(badge)
    }

    banner.appendChild(row)
  }

  // Poll with vital info
  if (hasPoll) {
    const row = document.createElement('div')
    row.className = 'hs-mc-chat-banner-item hs-mc-chat-banner-poll'
    row.style.cursor = 'pointer'
    row.addEventListener('click', openPredictions)

    row.innerHTML = '<span class="hs-mc-chat-banner-icon">\u{1F4CA}</span>'

    const info = document.createElement('span')
    info.className = 'hs-mc-chat-banner-title'
    const totalVotes = pollData.choices?.reduce((s, c) => s + (c.votes?.totalCount || c.totalVotes || 0), 0) || 0
    const choiceParts =
      pollData.choices?.slice(0, 4).map((c) => {
        const votes = c.votes?.totalCount || c.totalVotes || 0
        const pct = totalVotes > 0 ? Math.round((votes / totalVotes) * 100) : 0
        return `${c.title} ${pct}%`
      }) || []
    info.textContent = pollData.title + (choiceParts.length ? ` \u00b7 ${choiceParts.join(' vs ')}` : '')
    row.appendChild(info)

    const timer = document.createElement('span')
    timer.className = 'hs-mc-chat-banner-timer'
    const durMs = (pollData.durationSeconds || 60) * 1000
    const startTime = pollData.startedAt || pollData.createdAt
    const pollEndTime = startTime
      ? new Date(startTime).getTime() + durMs
      : Date.now() + (pollData.remainingDurationMilliseconds || durMs)
    _startBannerTimer(timer, pollEndTime)
    row.appendChild(timer)

    banner.appendChild(row)
  }

  // Hype train
  if (hasHype) {
    const row = document.createElement('div')
    row.className = 'hs-mc-chat-banner-item hs-mc-chat-banner-hype'
    row.innerHTML = `<span class="hs-mc-chat-banner-icon">\u{1F682}</span><span class="hs-mc-chat-banner-title">${t('mc_chat_hype_train')}</span>`
    const badge = document.createElement('span')
    badge.className = 'hs-mc-chat-banner-badge'
    badge.textContent = t('mc_chat_hype_level', [String(_hypeTrainActive.level || 1)])
    badge.style.color = '#fff'
    row.appendChild(badge)
    banner.appendChild(row)
  }

  if (!old) bannerHost.insertBefore(banner, msgsEl)
}

// Called from main.js hermes event handler
function onHypeTrainStart(level) {
  _hypeTrainActive = { level: level || 1, startedAt: Date.now() }
  updateChatBanners(_lastPredResult, _lastPollData)
}
function onHypeTrainEnd() {
  _hypeTrainActive = null
  updateChatBanners(_lastPredResult, _lastPollData)
}
// Get Twitch channel for the active multichat tab (channel tab → twitch name, live → URL channel)
function getActiveTwitchChannel() {
  if (currentTab === 'live' || currentTab === 'feed' || currentTab === 'mentions' || currentTab === 'whispers') {
    return getLiveChannel()
  }
  const ch = config.channels.find((c) => c.id === currentTab)
  if (!ch) return getLiveChannel()
  return ch.twitch || ch.id
}

// ── Twitch tab sub-tabs ──────────────────────────────────────────────────────
// The picker's "twitch" tab is split into four square-icon sub-tabs at the top
// so the user can pick which surface (bits / predictions / chat tools / links)
// instead of getting one giant vertical stack. Active sub-tab persists in
// module state so it survives picker re-opens.
let _hsTwSubtab = 'predictions'

const HS_TW_ICON_BITS_PATHS = [
  'M15 2h2v2h-2V2Zm5 10h2v2h-2v-2Zm0-8v2a1 1 0 0 1-1 1h-2v2h2a3 3 0 0 0 3-3V4h-2Z',
  'M13 9a1 1 0 0 0-1 1l7 7-14 5-3-3L7 5l3.438 3.438A2.998 2.998 0 0 1 13 7h2v2h-2Zm-5.18-.351-.725 2.03 3.762 7.106 2.572-.92-2.934-5.542L7.82 8.649Zm-2.976 8.334 1.235-3.458 2.67 5.012-2.592.926-1.313-2.48Z',
]
const HS_TW_ICON_PRED_PATHS = ['M3 3h2v18H3V3Zm4 10h2v8H7v-8Zm4-6h2v14h-2V7Zm4 9h2v5h-2v-5Zm4-12h2v17h-2V4Z']
const HS_TW_ICON_LINKS_PATHS = ['M14 3h7v7h-2V6.41l-9.3 9.3-1.4-1.42L17.58 5H14V3Zm-4 3H4v14h14v-6h2v8H2V4h8v2Z']

function hsTwBuildIconSvg(paths, size) {
  const arr = Array.isArray(paths) ? paths : [paths]
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', String(size || 20))
  svg.setAttribute('height', String(size || 20))
  svg.setAttribute('fill', 'currentColor')
  for (const d of arr) {
    const p = document.createElementNS(ns, 'path')
    p.setAttribute('d', d)
    svg.appendChild(p)
  }
  return svg
}

function buildTwSubtabBar() {
  const bar = document.createElement('div')
  bar.className = 'hs-mc-tw-subtabs'
  const items = [
    { id: 'predictions', label: 'events', paths: HS_TW_ICON_PRED_PATHS },
    { id: 'bits', label: 'bits', paths: HS_TW_ICON_BITS_PATHS },
    { id: 'links', label: 'quick links', paths: HS_TW_ICON_LINKS_PATHS },
  ]
  for (const it of items) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = `hs-mc-tw-subtab${it.id === _hsTwSubtab ? ' active' : ''}`
    btn.dataset.twSubtab = it.id
    btn.title = it.label
    btn.setAttribute('aria-label', it.label)
    btn.appendChild(hsTwBuildIconSvg(it.paths, 20))
    btn.addEventListener('click', (e) => {
      // stopPropagation is critical — the picker has a document-level
      // outside-click close handler that fires AFTER this. If we let the
      // event propagate, renderTwitchTab() will have already cleared the
      // container before the outside-click handler runs, orphaning e.target
      // → picker.contains(e.target) returns false → picker closes.
      e.stopPropagation()
      if (_hsTwSubtab === it.id) return
      _hsTwSubtab = it.id
      renderTwitchTab()
    })
    bar.appendChild(btn)
  }
  return bar
}

async function renderTwitchTab() {
  const container = document.getElementById('hs-mc-tab-twitch')
  if (!container) return

  const channel = getActiveTwitchChannel()
  container.textContent = ''

  // Sub-tab bar always at top
  container.appendChild(buildTwSubtabBar())

  const content = document.createElement('div')
  content.className = 'hs-mc-tw-content'
  container.appendChild(content)

  if (!channel) {
    const empty = document.createElement('div')
    empty.className = 'hs-mc-pred-empty'
    const msg = document.createElement('div')
    msg.className = 'hs-mc-pred-empty-text'
    msg.textContent = 'no channel detected'
    empty.appendChild(msg)
    content.appendChild(empty)
    stopPredictionPoll()
    return
  }

  _predictionChannel = channel

  if (_hsTwSubtab === 'bits') {
    renderBitsSubtab(content, channel)
    stopPredictionPoll()
    return
  }

  if (_hsTwSubtab === 'links') {
    content.appendChild(renderQuickLinks())
    stopPredictionPoll()
    return
  }

  // Default: 'predictions' — predictions + polls + community-points rewards.
  const predSlot = document.createElement('div')
  predSlot.className = 'hs-mc-pred-loading'
  predSlot.dataset.predSlot = '1'
  predSlot.textContent = 'loading...'
  const pollSlot = document.createElement('div')
  pollSlot.dataset.pollSlot = '1'
  const rewardsSlot = document.createElement('div')
  content.appendChild(predSlot)
  content.appendChild(pollSlot)
  content.appendChild(rewardsSlot)

  const modBefore = _twitchIsMod
  fetchPrediction(channel).then((result) => {
    _lastPredResult = result
    maybeBroadcastNewPrediction(channel, result?.prediction)
    updateChatBanners(_lastPredResult, _lastPollData)
    predSlot.textContent = ''
    predSlot.className = ''
    if (!result) {
      const empty = document.createElement('div')
      empty.className = 'hs-mc-pred-empty'
      const msg = document.createElement('div')
      msg.className = 'hs-mc-pred-empty-text'
      msg.textContent = t('mc_pred_load_failed')
      empty.appendChild(msg)
      predSlot.appendChild(empty)
    } else if (result.prediction) {
      predSlot.appendChild(
        renderPrediction(
          result.prediction,
          result.balance,
          result.channelId,
          result.isMod,
          result.cpImage,
          result.cpName,
        ),
      )
    } else {
      predSlot.appendChild(
        renderNoPrediction(result.balance, result.channelId, result.isMod, result.cpImage, result.cpName),
      )
    }
    attachPredictionHandlers()
    if (_twitchIsMod && !modBefore) refreshPollSlot()
  })

  fetchPoll(channel).then((pollResult) => {
    _lastPollData = pollResult?.poll || pollResult
    updateChatBanners(_lastPredResult, _lastPollData)
    if (pollResult?.poll) {
      pollSlot.appendChild(renderPoll(pollResult.poll, pollResult.channelId, pollResult.isMod))
      attachPollHandlers()
    } else if (pollResult) {
      pollSlot.appendChild(renderNoPoll(pollResult.channelId, pollResult.isMod))
      attachPollHandlers()
    }
  })

  fetchChannelRewards(channel).then((rewardsResult) => {
    if (rewardsResult?.availableClaim && rewardsResult.channelId) {
      claimCommunityPoints(rewardsResult.availableClaim, rewardsResult.channelId, channel)
    }
    if (rewardsResult?.rewards?.length) {
      rewardsSlot.appendChild(renderRewards(rewardsResult.rewards, rewardsResult.balance, rewardsResult.channelId))
      attachRewardHandlers()
    }
  })

  startPredictionPoll()
}

// Bits sub-tab — single launcher that opens twitch's native bits modal via
// React-fiber onClick invocation. We CANNOT send bits programmatically via
// GQL (twitch's integrity service blocks it specifically for bits — verified
// live). The fiber-invoke path bypasses isTrusted because it calls the React
// handler directly instead of dispatching a synthetic event, so the real
// modal opens. Twitch handles auth/integrity/payment normally → real bit
// deducted → real bits-tagged echo → bulletproof cheermote renderer fires.
function renderBitsSubtab(parent, channel) {
  closeCheerPanel()

  const panel = document.createElement('div')
  panel.className = 'hs-mc-cheer-panel hs-mc-cheer-inline'
  panel.setAttribute('role', 'region')
  panel.setAttribute('aria-label', `Cheer bits to ${channel}`)

  const header = document.createElement('div')
  header.className = 'hs-mc-cheer-header'
  const title = document.createElement('div')
  title.className = 'hs-mc-cheer-title'
  title.textContent = `cheer bits to ${channel}`
  const balance = document.createElement('div')
  balance.className = 'hs-mc-cheer-balance'
  const bal = hsReadNativeBitsBalance()
  balance.textContent = bal ? `balance: ${bal}` : 'balance: —'
  header.appendChild(title)
  header.appendChild(balance)
  panel.appendChild(header)

  const launchBtn = document.createElement('button')
  launchBtn.type = 'button'
  launchBtn.className = 'hs-mc-cheer-send hs-mc-cheer-launch'
  launchBtn.textContent = 'open cheer modal'
  launchBtn.addEventListener('click', () => {
    // Open twitch's full chat popout in a separate window. The popout is a
    // complete twitch chat UI (chat-input + bits button + cheer modal + everything)
    // running in its own window — completely outside heatsync's overlay. User
    // cheers there normally; twitch handles auth/integrity/payment/UI. When
    // the cheer message lands, it echoes back through IRC to heatsync's
    // multichat overlay with the bits=N tag → bulletproof cheermote renders.
    //
    // Why this is the permanent answer:
    // - twitch's bits modal needs its chat-input ancestor visible to render
    // - heatsync's multichat covers the entire chat surface on the main tab
    // - we can't make the bits-button visible without ripping heatsync's UI
    // - a separate window has its OWN twitch chat surface with its OWN bits UI
    // - no fiber invocation, no DOM hacking, no CSS overrides, no anti-bot fights
    const safe = String(channel || '')
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '')
    if (!safe) {
      showToast(t('mc_twitchapi_invalid_channel'), 'error')
      return
    }
    const url = `https://www.twitch.tv/popout/${safe}/chat?popout=`
    const w = window.open(url, `hs-cheer-${safe}`, 'width=400,height=620,resizable=yes,scrollbars=yes')
    if (!w) {
      showToast(t('mc_twitchapi_popup_blocked'), 'error')
      return
    }
    showToast(t('mc_twitchapi_cheer_opened'), 'success')
  })
  panel.appendChild(launchBtn)

  parent.appendChild(panel)
}

function startPredictionPoll() {
  stopPredictionPoll()
  _predictionPollTimer = cleanup.setIntervalIfVisible(() => {
    const container = document.getElementById('hs-mc-tab-twitch')
    if (!container || container.style.display === 'none') {
      stopPredictionPoll()
      return
    }
    // Don't refresh while create form is open
    if (container.querySelector('.hs-mc-pred-create-form[style*="flex"]')) return
    refreshPredictionSlot()
    refreshPollSlot()
  }, 15000)
}

// Refresh only the prediction slot without tearing down the whole Twitch tab
async function refreshPredictionSlot() {
  _predResultCache = null // always fetch fresh on explicit refresh
  const container = document.getElementById('hs-mc-tab-twitch')
  if (!container) return
  const channel = getActiveTwitchChannel()
  if (!channel) return

  const result = await fetchPrediction(channel)

  // Update chat overlay banner
  _lastPredResult = result
  maybeBroadcastNewPrediction(channel, result?.prediction)
  updateChatBanners(_lastPredResult, _lastPollData)

  // Find the prediction slot — it's always a direct child of container marked with data-pred-slot
  let slot = container.querySelector('[data-pred-slot]')
  if (!slot) {
    // Fallback: find by class
    slot =
      container.querySelector('.hs-mc-prediction') ||
      container.querySelector('.hs-mc-pred-empty') ||
      container.querySelector('.hs-mc-pred-loading')
  }
  if (!slot) return

  const newSlot = document.createElement('div')
  newSlot.dataset.predSlot = '1'
  if (!result) {
    newSlot.className = 'hs-mc-pred-empty'
    const msg = document.createElement('div')
    msg.className = 'hs-mc-pred-empty-text'
    msg.textContent = t('mc_pred_load_failed')
    newSlot.appendChild(msg)
  } else if (result.prediction) {
    newSlot.appendChild(
      renderPrediction(
        result.prediction,
        result.balance,
        result.channelId,
        result.isMod,
        result.cpImage,
        result.cpName,
      ),
    )
  } else {
    newSlot.appendChild(
      renderNoPrediction(result.balance, result.channelId, result.isMod, result.cpImage, result.cpName),
    )
  }
  slot.replaceWith(newSlot)
  attachPredictionHandlers()
}

// Refresh only the poll slot without tearing down the whole Twitch tab
async function refreshPollSlot() {
  const container = document.getElementById('hs-mc-tab-twitch')
  if (!container) return
  const channel = getActiveTwitchChannel()
  if (!channel) return

  // Don't refresh while create form is open
  if (container.querySelector('.hs-mc-poll-create-form[style*="flex"]')) return
  const result = await fetchPoll(channel)
  _lastPollData = result?.poll || result
  maybeBroadcastNewPoll(channel, _lastPollData)
  updateChatBanners(_lastPredResult, _lastPollData)

  let slot = container.querySelector('[data-poll-slot]')
  if (!slot) {
    slot = container.querySelector('.hs-mc-poll') || container.querySelector('.hs-mc-poll-empty')
  }
  if (!slot) return

  const newSlot = document.createElement('div')
  newSlot.dataset.pollSlot = '1'
  if (result?.poll) {
    newSlot.appendChild(renderPoll(result.poll, result.channelId, result.isMod))
  } else if (result) {
    newSlot.appendChild(renderNoPoll(result.channelId, result.isMod))
  }
  slot.replaceWith(newSlot)
  attachPollHandlers()
}

function stopPredictionPoll() {
  if (_predictionPollTimer) {
    cleanup.clearInterval(_predictionPollTimer)
    _predictionPollTimer = null
  }
}

// ── Cheermote rendering ──────────────────────────────────────────────────────
// Twitch's universal "Cheer" cheermote has six tiers, each with its own color.
// CDN serves animated WebPs/GIFs at d3aqoihi2n8ty8.cloudfront.net. When twitch
// tags a chat message with bits>0, the `cheer<N>` token in the visible text
// should render as the tier-appropriate cheermote + colored bits amount.
const HS_CHEER_TIERS = [
  { min: 100000, tier: 100000, color: '#f43021' },
  { min: 10000, tier: 10000, color: '#fa0d72' },
  { min: 5000, tier: 5000, color: '#0099fe' },
  { min: 1000, tier: 1000, color: '#1db2a5' },
  { min: 100, tier: 100, color: '#9c3ee8' },
  { min: 1, tier: 1, color: '#979797' },
]
function hsCheerTier(amount) {
  for (const t of HS_CHEER_TIERS) if (amount >= t.min) return t
  return HS_CHEER_TIERS[HS_CHEER_TIERS.length - 1]
}
// BULLETPROOF: only render a cheermote when twitch's IRC tagged the message
// with bits=N (server-confirmed real cheer). No amount-cap heuristics, no
// loose "looks like a cheer" rendering — if the tag isn't there, the bit
// wasn't credited and it's just text. Heatsync's IRC connection requests
// CAP twitch.tv/tags so bits tags ARE preserved end-to-end for real cheers.
function renderCheermotesInText(html, totalBits) {
  if (!html || !totalBits || totalBits < 1) return html
  // Tag-split like the mention/hashtag passes: a literal "cheerN" inside an
  // earlier-emitted anchor (e.g. #cheer100 hashtag or @cheer100 mention) must
  // NOT be replaced, or the injected <img> quote breaks out of the href attr.
  // Only touch even-index text segments.
  const parts = html.split(/(<[^>]+>)/)
  for (let i = 0; i < parts.length; i += 2) {
    const seg = parts[i]
    if (!seg || !/cheer\d/i.test(seg)) continue
    // (?<![#@]) so a cheerN that is hashtag (#cheer1) or mention (@cheer1) text
    // stays as-is — only a bare cheer token becomes a cheermote.
    parts[i] = seg.replace(/(?<![#@])\bcheer(\d+)\b/gi, (match, n) => {
      const amount = parseInt(n, 10)
      if (!amount || amount < 1) return match
      const t = hsCheerTier(amount)
      const url = `https://d3aqoihi2n8ty8.cloudfront.net/actions/cheer/dark/animated/${t.tier}/2.gif`
      return (
        `<img class="hs-mc-cheermote" src="${url}" alt="cheer${amount}" title="${amount} bits" loading="lazy">` +
        `<span class="hs-mc-cheer-amt" style="color:${t.color}">${amount}</span>`
      )
    })
  }
  return parts.join('')
}

let _hsCheerPanelEl = null

function hsReadNativeBitsBalance() {
  const native = document.querySelector('[aria-label="Bits and Points Balances"]')
  if (!native) return null
  const txt = native.querySelector('[data-test-selector="bits-balance-string"]')?.textContent?.trim()
  return txt || null
}

function closeCheerPanel() {
  if (_hsCheerPanelEl) {
    _hsCheerPanelEl.remove()
    _hsCheerPanelEl = null
  }
}

function triggerTwitchFeature(action) {
  const channel = getActiveTwitchChannel() || getCurrentChannel()
  if (!channel) return false

  // Subscribe — opens twitch's real subscription product page in a popup window.
  // The actual subscribe modal can't be opened programmatically (browsers block
  // the trusted-event), and the flow requires payment processing we can't bypass.
  // The /products/<channel>/ticket URL is the canonical sub purchase entry.
  if (action === 'sub') {
    window.open(`https://www.twitch.tv/products/${channel}/ticket`, '_blank', 'width=520,height=720,noopener')
    return true
  }

  const actions = {
    popout: { url: `https://www.twitch.tv/popout/${channel}/chat?popout=`, opts: 'width=400,height=600' },
    mod: { url: `https://www.twitch.tv/moderator/${channel}`, opts: 'width=1200,height=800' },
  }

  const cfg = actions[action]
  if (!cfg) return false

  window.open(cfg.url, '_blank', cfg.opts || '')
  return true
}

// Fetch + render chat status (modes + stream info) for `channel`. Used by
// /status slash command. Modes come from the SW's cached IRC ROOMSTATE
// (always available once the channel is joined, works cross-host because
// IRC lives in the background service worker). Stream info comes from an
// unauthenticated Twitch GQL query (works on Twitch/Kick/YT via the SW
// gql_authed bridge). Either source can fail independently and the panel
// degrades gracefully (modes-only or stream-only is still useful).
async function buildChatStatusPanel(channel) {
  const ch = (channel || '').toString().toLowerCase()
  if (!ch || !/^[a-z0-9_]{2,40}$/.test(ch)) return null

  const [roomstateResp, gqlResp] = await Promise.all([
    safeSendMessage({ type: 'get_roomstate', channel: ch }).catch(() => null),
    twitchGql(
      `{ user(login:"${ch}") { id displayName stream { id type viewersCount createdAt game { name } } broadcastSettings { title language } } }`,
    ).catch(() => null),
  ])

  const rs = roomstateResp?.ok ? roomstateResp.state : null
  const u = gqlResp?.data?.user || null
  const stream = u?.stream || null
  const bs = u?.broadcastSettings || null
  if (!rs && !u) return null

  const panel = document.createElement('div')
  panel.className = 'hs-mc-status-panel'

  const title = document.createElement('div')
  title.className = 'hs-mc-status-title'
  title.textContent = `#${u?.displayName || ch}`
  panel.appendChild(title)

  const sub = document.createElement('div')
  sub.className = 'hs-mc-status-sub'
  if (stream && stream.type === 'live') {
    const started = new Date(stream.createdAt).getTime()
    const mins = Math.max(0, Math.floor((Date.now() - started) / 60000))
    const h = Math.floor(mins / 60),
      m = mins % 60
    const uptime = h ? `${h}h ${m}m` : `${m}m`
    const viewers = (stream.viewersCount || 0).toLocaleString('en-US')
    sub.textContent = `LIVE · ${uptime} · ${viewers} viewers`
    sub.classList.add('live')
  } else {
    sub.textContent = 'OFFLINE'
    sub.classList.add('off')
  }
  panel.appendChild(sub)

  if (bs?.title) {
    const t = document.createElement('div')
    t.className = 'hs-mc-status-streamtitle'
    t.textContent = `"${bs.title}"`
    panel.appendChild(t)
  }
  const metaParts = []
  if (stream?.game?.name) metaParts.push(stream.game.name)
  if (bs?.language) metaParts.push(bs.language)
  if (metaParts.length) {
    const meta = document.createElement('div')
    meta.className = 'hs-mc-status-meta'
    meta.textContent = metaParts.join(' · ')
    panel.appendChild(meta)
  }

  const modesHeader = document.createElement('div')
  modesHeader.className = 'hs-mc-status-section'
  modesHeader.textContent = 'chat modes'
  panel.appendChild(modesHeader)

  const grid = document.createElement('div')
  grid.className = 'hs-mc-status-modes'

  if (rs) {
    // followersOnly: -1 = off, 0 = on no min, N>0 = N min req
    const followerOn = rs.followersOnly != null && rs.followersOnly >= 0
    const followerDetail = followerOn && rs.followersOnly > 0 ? `${rs.followersOnly} min` : null
    const slowOn = rs.slow != null && rs.slow > 0
    const modes = [
      ['emote-only', rs.emoteOnly === true],
      ['follower-mode', followerOn, followerDetail],
      ['sub-mode', rs.subsOnly === true],
      ['slow-mode', slowOn, slowOn ? `${rs.slow}s` : null],
      ['unique-chat', rs.r9k === true],
    ]
    for (const [label, on, detail] of modes) {
      const row = document.createElement('div')
      row.className = 'hs-mc-status-row'
      const k = document.createElement('span')
      k.className = 'hs-mc-status-key'
      k.textContent = label
      const v = document.createElement('span')
      v.className = `hs-mc-status-val ${on ? 'on' : 'off'}`
      v.textContent = on ? (detail ? `on (${detail})` : 'on') : 'off'
      row.appendChild(k)
      row.appendChild(v)
      grid.appendChild(row)
    }
  } else {
    const empty = document.createElement('div')
    empty.className = 'hs-mc-status-note'
    empty.textContent = '(modes unknown — channel not joined yet)'
    grid.appendChild(empty)
  }
  panel.appendChild(grid)
  return panel
}

// Best-effort own twitch login — read Twitch's stored user blob if we're on
// twitch.tv; otherwise null. Used by renderQuickLinks to gate broadcaster-only
// dashboard deep-links (they only resolve for the channel owner).
function getOwnTwitchLogin() {
  try {
    const raw = localStorage.getItem('twilight-user')
    if (!raw) return null
    const obj = JSON.parse(raw)
    const login = (obj?.login || obj?.userName || '').toString().toLowerCase()
    return login || null
  } catch {
    return null
  }
}

// Twitch IRC badge rendering
const BADGE_STYLES = {
  broadcaster: { label: 'LIVE', bg: '#e91916', fg: '#fff' },
  moderator: { label: 'MOD', bg: '#00ad03', fg: '#fff' },
  vip: { label: 'VIP', bg: '#e005b9', fg: '#fff' },
  subscriber: { label: 'SUB', bg: '#8205b4', fg: '#fff' },
  predictions: { label: 'PRED', bg: '#1f69ff', fg: '#fff' },
  premium: { label: 'PRIME', bg: '#0d6efd', fg: '#fff' },
  admin: { label: 'ADMIN', bg: '#faaf19', fg: '#000' },
  staff: { label: 'STAFF', bg: '#faaf19', fg: '#000' },
  global_mod: { label: 'GMOD', bg: '#00ad03', fg: '#fff' },
  partner: { label: '✓', bg: '#9146ff', fg: '#fff' },
  'bits-leader': { label: 'BITS', bg: '#ffd700', fg: '#000' },
  'sub-gifter': { label: 'GIFT', bg: '#8205b4', fg: '#fff' },
  artist: { label: 'ART', bg: '#ff6b35', fg: '#fff' },
  turbo: { label: 'T+', bg: '#6441a5', fg: '#fff' },
  founder: { label: 'FND', bg: '#8205b4', fg: '#fff' },
  // Kick badges (underscore variants)
  sub_gifter: { label: 'GIFT', bg: '#8205b4', fg: '#fff' },
  og: { label: 'OG', bg: '#53fc18', fg: '#000' },
  verified: { label: '✓', bg: '#53fc18', fg: '#000' },
}

// Semantic background for a known badge type, applied to the <img> so the 18px
// slot always shows the badge's color — even before the image paints or if it
// fails to load in the page-load request burst. Without this, native/global
// badges (no CSS bg, unlike FFZ) went blank on history rows until a new message
// forced a fresh render (the "mod badge has no green bg on history" report).
// FFZ badges are white icons on transparent → keep the padded chip; native
// badges fill the slot → bg sits behind, invisible once the image loads.
function badgeBgStyle(name, isFFZ) {
  const s = BADGE_STYLES[name]
  if (!s) return ''
  return isFFZ ? `background:${s.bg};padding:1px;` : `background:${s.bg};`
}

// Twitch badge image URLs: "setID/version" → image_url
const twitchBadgeUrls = new Map()
const ffzBadgeKeys = new Set() // tracks which channel:badgeName entries are FFZ (need bg color)
const badgesFetchedChannels = new Set()
// Sorted numeric version lists per "channel:setID" — for nearest-tier fallback
// (e.g. user has subscriber/5 but channel only defines 0,3,6 → use 3).
const channelBadgeVersions = new Map()

function findNearestChannelBadgeVersion(channel, name, version) {
  const versions = channelBadgeVersions.get(`${channel}:${name}`)
  if (!versions || versions.length === 0) return null
  const v = parseInt(version, 10)
  if (!Number.isFinite(v)) return null
  // Subscriber versions encode tier in the thousands digit (2xxx = T2, 3xxx = T3).
  // Stay within the same tier when picking the nearest lower version.
  let tierMin = -Infinity,
    tierMax = Infinity
  if (name === 'subscriber') {
    if (v >= 3000) {
      tierMin = 3000
      tierMax = 3999
    } else if (v >= 2000) {
      tierMin = 2000
      tierMax = 2999
    } else {
      tierMin = 0
      tierMax = 1999
    }
  }
  let best = -1
  for (const vv of versions) {
    if (vv > v) break
    if (vv < tierMin || vv > tierMax) continue
    if (vv > best) best = vv
  }
  return best >= 0 ? String(best) : null
}
let globalBadgesFetched = false
const TWITCH_GQL = 'https://gql.twitch.tv/gql'
const TWITCH_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko'

// ═══ GQL Proxy — routes calls through MAIN world to use fresh hashes ═══
// Twitch rotates persisted query hashes; the MAIN world fetch interceptor
// captures them from Twitch's own code so we never hardcode stale hashes.

// Cache for intercepted GQL data pushed from MAIN world
const _gqlDataCache = {} // operationName → { data, ts }

// Listen for passively intercepted GQL data from MAIN world
window.addEventListener(
  'message',
  (e) => {
    // Same-origin frames (Twitch embeds) could otherwise poison the cache —
    // restrict to the top window (where early-inject-main.js runs).
    if (e.source !== window || e.origin !== location.origin) return
    if (e.data?.type === 'heatsync-gql-data') {
      // Verify the MAIN-world nonce (early-inject stamps it on the push). Without
      // this, page JS on twitch.tv could post a crafted heatsync-gql-data to
      // spoof poll/prediction state into the panel. Same check content.js uses.
      const expected = window.HS?.getMainWorldNonce?.()
      if (!expected || e.data.nonce !== expected) return
      const { operation, data, errors } = e.data
      if (data && !errors?.length) {
        _gqlDataCache[operation] = { data, ts: Date.now() }
        if (Object.keys(_gqlDataCache).length > 50) {
          const oldest = Object.entries(_gqlDataCache).reduce((a, b) => (a[1].ts < b[1].ts ? a : b))[0]
          delete _gqlDataCache[oldest]
        }
        // Auto-refresh individual slots when relevant GQL data arrives
        const container = document.getElementById('hs-mc-tab-twitch')
        if (container && container.style.display !== 'none') {
          const pollOps = ['ActivePoll', 'CreatePoll', 'ChannelPollContext']
          const predOps = ['ChannelPointsPredictionContext', 'MakePrediction']
          if (pollOps.includes(operation)) {
            refreshPollSlot()
          } else if (predOps.includes(operation)) {
            refreshPredictionSlot()
          } else {
            renderTwitchTab()
          }
        }
      }
    }
  },
  { signal: mcSignal },
)

// Send GQL request through MAIN world proxy (uses captured hashes + integrity)
function gqlProxy(operation, variables, opts) {
  return new Promise((resolve, reject) => {
    const id = Math.random().toString(36).slice(2)
    const ac = new AbortController()
    const signal = mcSignal ? AbortSignal.any([mcSignal, ac.signal]) : ac.signal
    const handler = (e) => {
      if (e.source !== window || e.origin !== location.origin) return
      if (e.data?.type === 'heatsync-gql-response' && e.data.id === id) {
        ac.abort()
        clearTimeout(timer)
        if (e.data.error) reject(new Error(e.data.error))
        else resolve(e.data.data)
      }
    }
    window.addEventListener('message', handler, { signal })
    const msg = {
      type: 'heatsync-gql-request',
      id,
      operation,
      variables,
      nonce: window.HS?.getMainWorldNonce?.() || null,
    }
    if (opts?.rawQuery) msg.rawQuery = opts.rawQuery
    if (opts?.batch) msg.batch = opts.batch
    window.postMessage(msg, location.origin)
    const timer = setTimeout(() => {
      ac.abort()
      reject(new Error('GQL proxy timeout'))
    }, 4000)
  })
}

async function fetchGlobalBadges() {
  if (globalBadgesFetched) return
  globalBadgesFetched = true
  try {
    // Route through twitchGql so off-twitch contexts (kick.com / youtube.com)
    // pick up global badges too — direct fetch to gql.twitch.tv from kick.com
    // origin fails silently (CORS/Origin headers), leaving moderator/vip/
    // broadcaster/premium badges as text-only "MOD" / "VIP" / "LIVE" chips.
    const data = await twitchGql('{ badges { imageURL(size: NORMAL) setID version } }')
    const badges = data?.data?.badges
    if (!badges) {
      globalBadgesFetched = false
      return
    }
    for (const b of badges) {
      twitchBadgeUrls.set(`${b.setID}/${b.version}`, b.imageURL)
    }
    log('Loaded global badges:', twitchBadgeUrls.size)
    // Patch live rows in-place instead of bumping epoch + full rebuild.
    // updateNativeBadgesInPlace upgrades text-fallback spans to imgs without
    // tearing down any row, so avatars/emotes never reload = no flash.
    if (typeof updateNativeBadgesInPlace === 'function') updateNativeBadgesInPlace(null)
  } catch (e) {
    globalBadgesFetched = false
    log('Failed to fetch global badges:', e.message)
  }
}

// Prediction state
let _predictionPollTimer = null
let _predictionChannel = null
let _twitchIsMod = false // cached from fetchPrediction (most reliable isMod source)
let _twitchChannelId = null
const _userBets = new Map() // eventId → { outcomeId, points } (capped at 50)

// Rewards state
let _rewardsCache = null
let _rewardsCacheChannel = null

// Prediction result cache — avoids redundant GQL on quick tab switches
let _predResultCache = null // { result, channel, ts }
const PRED_CACHE_TTL = 5000 // 5s — fresh enough to feel instant, short enough to stay current

const PRED_FIELDS =
  'id title status createdAt endedAt predictionWindowSeconds winningOutcome { id } outcomes { id title totalPoints totalUsers color } self { prediction { outcome { id } points } }'

// True when this content script is running on a twitch.tv page (cookies +
// MAIN-world Apollo client + integrity are all directly available).
const _isOnTwitchPage = () => /(^|\.)twitch\.tv$/i.test(location.hostname || '')

// GQL call — on Twitch: direct fetch / MAIN-world proxy. Off Twitch (Kick /
// YouTube): route through background.js so the request carries the user's
// twitch.tv auth cookie. This lets mod-state checks (isModerator etc.) work
// from any page the multichat overlay runs on.
async function twitchGql(query, variables) {
  if (!_isOnTwitchPage()) {
    try {
      const resp = await safeSendMessage({ type: 'twitch_gql_authed', query, variables: variables || null })
      if (resp?.ok && resp.data) return resp.data
      throw new Error(resp?.error || 'twitch_gql bridge failed')
    } catch (e) {
      throw new Error(`GQL bridge failed: ${e.message}`)
    }
  }
  // Try direct fetch (works in Chrome MV3 content scripts with host_permissions)
  try {
    const token = getTwitchAuthToken()
    const hdrs = { 'Content-Type': 'application/json', 'Client-Id': 'kimne78kx3ncx6brgo4mv6wki5h1ko' }
    if (token) hdrs.Authorization = `OAuth ${token}`
    const body = variables ? { query, variables } : { query }
    const resp = await fetch('https://gql.twitch.tv/gql', {
      method: 'POST',
      headers: hdrs,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    })
    if (!resp.ok) throw new Error(`GQL ${resp.status}`)
    return resp.json()
  } catch (directErr) {
    // Direct fetch failed (Firefox CORS) — fall back to MAIN world proxy
    try {
      const data = await gqlProxy('twitchGql', variables || {}, { rawQuery: query })
      const d = Array.isArray(data) ? data[0] : data
      // Proxy wraps in { data } or returns raw — normalize
      return d?.data ? d : { data: d }
    } catch (proxyErr) {
      throw new Error(`GQL failed: direct=${directErr.message} proxy=${proxyErr.message}`)
    }
  }
}

async function fetchPrediction(channelLogin) {
  const safe = channelLogin.replace(/[^a-z0-9_]/g, '')
  if (!safe) return null

  // Return cached result if fresh (avoids GQL on quick tab switches)
  if (_predResultCache && _predResultCache.channel === safe && Date.now() - _predResultCache.ts < PRED_CACHE_TTL) {
    return _predResultCache.result
  }

  try {
    let predEvent = null
    let balance = null
    let channelId = null
    let isMod = false
    let cpImage = null
    let cpName = null

    // Single combined GQL query — predictions + balance + channel points settings
    try {
      const data = await twitchGql(
        '{ user(login: "' +
          safe +
          '") { id self { isModerator } channel { activePredictionEvents { ' +
          PRED_FIELDS +
          ' } lockedPredictionEvents { ' +
          PRED_FIELDS +
          ' } resolvedPredictionEvents(first: 1) { edges { node { ' +
          PRED_FIELDS +
          ' } } } } } currentUser { id } channel(name: "' +
          safe +
          '") { communityPointsSettings { image { url url2x } name } self { communityPoints { balance } } } }',
      )
      const ch = data?.data?.user?.channel
      const userId = data?.data?.user?.id
      const currentUserId = data?.data?.currentUser?.id
      if (userId) channelId = userId
      isMod = data?.data?.user?.self?.isModerator || (userId && currentUserId && userId === currentUserId)

      // Priority: ACTIVE > LOCKED > recently RESOLVED (< 5 min ago)
      const active = ch?.activePredictionEvents
      const locked = ch?.lockedPredictionEvents
      const resolved = ch?.resolvedPredictionEvents?.edges?.[0]?.node

      if (Array.isArray(active) && active.length) {
        predEvent = active.find((e) => e.status === 'ACTIVE') || active[0]
      } else if (Array.isArray(locked) && locked.length) {
        predEvent = locked[0]
      } else if (resolved) {
        // Show resolved predictions briefly so users see the result
        const resolvedTime = resolved.endedAt || resolved.createdAt
        const resolvedAge = Date.now() - new Date(resolvedTime).getTime()
        if (resolvedAge < 300000) predEvent = resolved
      }

      // Populate _userBets from self.prediction
      if (predEvent?.self?.prediction) {
        const sp = predEvent.self.prediction
        if (sp.outcome?.id && sp.points) {
          if (_userBets.size > 50) _userBets.delete(_userBets.keys().next().value)
          _userBets.set(predEvent.id, { outcomeId: sp.outcome.id, points: sp.points })
        }
      }

      // Extract balance + channel points settings from same response
      const ch2 = data?.data?.channel
      balance = ch2?.self?.communityPoints?.balance ?? null
      cpImage = ch2?.communityPointsSettings?.image?.url2x || ch2?.communityPointsSettings?.image?.url || null
      cpName = ch2?.communityPointsSettings?.name || null
    } catch (e) {
      log('GQL prediction query failed:', e.message)
    }

    // Fallback: fetch balance via proxy if combined query didn't get it
    if (balance === null) {
      try {
        const data = await gqlProxy('CommunityPointsContext', { channelLogin: safe })
        const d = Array.isArray(data) ? data[0]?.data : data?.data || data
        balance = d?.community?.channel?.self?.communityPoints?.balance ?? null
      } catch {}
    }

    _twitchIsMod = isMod
    _twitchChannelId = channelId
    const result = { prediction: predEvent, balance, channelId, isMod, cpImage, cpName }
    _predResultCache = { result, channel: safe, ts: Date.now() }
    return result
  } catch (e) {
    log('Failed to fetch prediction:', e.message)
    return null
  }
}

// ═══ Mod prediction management (direct GQL — no MAIN world proxy) ═══

// Mod prediction mutations — try Apollo client (has integrity + correct hashes),
// fallback to raw query through MAIN world proxy (has integrity), final fallback direct fetch
async function predictionMutation(searchTerm, resultField, rawQuery, variables) {
  // Try Apollo client first (most reliable — uses Twitch's own persisted hashes)
  const apolloResult = await apolloMutate({ searchTerm, variables, resultField, rawQuery })
  if (apolloResult.ok) return { ok: true }
  // Apollo failed — try raw query through MAIN world proxy (has integrity)
  try {
    const data = await gqlMutation(rawQuery, variables)
    const err = data?.data?.[resultField]?.error
    if (err) return { error: err.code || `${resultField} failed` }
    return { ok: true }
  } catch (e) {
    return { error: apolloResult.error || e.message }
  }
}

async function lockPrediction(eventId) {
  return predictionMutation(
    'LockPredictionEvent',
    'lockPredictionEvent',
    'mutation($input: LockPredictionEventInput!) { lockPredictionEvent(input: $input) { error { code } } }',
    { input: { id: eventId } },
  )
}

async function resolvePrediction(eventId, outcomeId) {
  return predictionMutation(
    'ResolvePredictionEvent',
    'resolvePredictionEvent',
    'mutation($input: ResolvePredictionEventInput!) { resolvePredictionEvent(input: $input) { error { code } } }',
    { input: { eventID: eventId, outcomeID: outcomeId } },
  )
}

async function cancelPrediction(eventId) {
  return predictionMutation(
    'CancelPredictionEvent',
    'cancelPredictionEvent',
    'mutation($input: CancelPredictionEventInput!) { cancelPredictionEvent(input: $input) { error { code } } }',
    { input: { id: eventId } },
  )
}

async function createPrediction(channelId, title, windowSeconds, outcomes) {
  const colors = ['BLUE', 'PINK', 'ORANGE', 'GREEN', 'TEAL', 'PURPLE', 'YELLOW', 'LIGHT_BLUE', 'RED', 'BROWN']
  return predictionMutation(
    'CreatePredictionEvent',
    'createPredictionEvent',
    'mutation($input: CreatePredictionEventInput!) { createPredictionEvent(input: $input) { error { code } } }',
    {
      input: {
        channelID: channelId,
        title,
        predictionWindowSeconds: windowSeconds,
        outcomes: outcomes.map((t, i) => ({ title: t, color: colors[i] || colors[0] })),
      },
    },
  )
}

// Route a mutation through Twitch's own Apollo client in the MAIN world.
// searchTerm: string to find the webpack module (e.g. 'AcceptPredictionTerms')
// variables: GQL variables object
// resultField: the mutation's return field name (for error extraction)
// rawQuery: optional fallback raw query string
function apolloMutate({ searchTerm, variables, resultField, rawQuery }) {
  return new Promise((resolve) => {
    const id = Math.random().toString(36).slice(2)
    const ac = new AbortController()
    const signal = mcSignal ? AbortSignal.any([mcSignal, ac.signal]) : ac.signal
    const handler = (e) => {
      if (e.source !== window || e.origin !== location.origin) return
      if (e.data?.type === 'heatsync-apollo-mutate-response' && e.data.id === id) {
        ac.abort()
        clearTimeout(timer)
        resolve(e.data.data || { error: 'no response' })
      }
    }
    window.addEventListener('message', handler, { signal })
    // Only include rawQuery when caller provided one — the MAIN-world security
    // gate rejects any message that has the rawQuery field set, even if empty
    // string. Apollo path loads Document from webpack so rawQuery is optional.
    const msg = {
      type: 'heatsync-apollo-mutate',
      id,
      searchTerm,
      variables,
      resultField,
      nonce: window.HS?.getMainWorldNonce?.() || null,
    }
    if (rawQuery) msg.rawQuery = rawQuery
    window.postMessage(msg, location.origin)
    const timer = setTimeout(() => {
      ac.abort()
      resolve({ error: 'apollo mutation timeout' })
    }, 8000)
  })
}

async function acceptPredictionTerms() {
  const result = await apolloMutate({
    searchTerm: 'AcceptPredictionTerms',
    variables: { input: { hasAcceptedTOS: true } },
    resultField: 'updateUserPredictionSettings',
    rawQuery:
      'mutation($input: UpdateUserPredictionSettingsInput!) { updateUserPredictionSettings(input: $input) { error { code } settings { hasAcceptedTOS } } }',
  })
  return !!result.ok
}

// Known working persisted query hashes (from Twitch's own client). Hashes
// auto-update from live Twitch traffic on twitch.tv pages via early-inject
// gql.hashes capture; this map is the fallback seed for first-call before any
// page traffic, and for code paths that don't have MAIN-world access.
const TWITCH_HASHES = {
  MakePrediction: 'b44682ecc88358817009f20e69d75081b1e58825bb40aa53d5dbadcc17c881d8',
  // Follow / unfollow — needed for cross-platform follow propagation. Twitch
  // killed the public follow REST API in Aug 2023, so this is the only path.
  FollowButton_FollowUser: '800e7346bdf7e5278a3c1d3f21b2b56e2639928f86815677a7126b093b2fdd08',
  FollowButton_UnfollowUser: 'f7dae976ebf41c755ae2d758546bfd176b4eeb856656098bb40e0a672ca0d880',
  // Followers-only chat mode — the web client can't call Helix /chat/settings
  // (404), so chat modes go through this GQL persisted mutation. Captured from
  // twitch.tv. followersOnlyDurationMinutes: -1=off, 0=any follower, N=minutes.
  SetFollowersOnlyModeSetting: '0ee2e448691c84b4be72bcd1ae6c51fcf512414fe372e502fe67d3c7eaf8da31',
  // VIP / unVIP — captured live from twitch's Roles Manager 2026-07-22.
  // VIPUser input {channelID, granteeLogin}; UnVIPUser input {channelID, revokeeLogin}.
  VIPUser: 'e8c397f1ed8b1fdbaa201eedac92dd189ecfb2d828985ec159d4ae77f9920170',
  UnVIPUser: '2ce4fcdf6667d013aa1f820010e699d1d4abdda55e26539ecf4efba8aff2d661',
  // mod / unmod — captured live from twitch's Roles Manager 2026-07-22.
  // Both take input {channelID, targetLogin}.
  ModUser: '46da4ec4229593fe4b1bce911c75625c299638e228262ff621f80d5067695a8a',
  UnmodUser: '1ed42ccb3bc3a6e79f51e954a2df233827f94491fbbb9bd05b22b1aaaf219b8b',
}

// Route mutation through MAIN world proxy (has integrity token) with direct fetch fallback
async function gqlMutation(query, variables) {
  try {
    const data = await gqlProxy('twitchGql', variables || {}, { rawQuery: query })
    const d = Array.isArray(data) ? data[0] : data
    return d?.data ? d : { data: d }
  } catch {
    return twitchGql(query, variables)
  }
}

// Use persisted query hash for MakePrediction — raw queries are dead for mutations
async function gqlPersistedMutation(operationName, variables) {
  const hash = TWITCH_HASHES[operationName]
  if (!hash)
    return gqlMutation(
      'mutation ' +
        operationName +
        '($input: ' +
        operationName +
        'Input!) { ' +
        operationName.replace(/^[A-Z]/, (c) => c.toLowerCase()) +
        '(input: $input) { error { code } } }',
      variables,
    )
  const token = getTwitchAuthToken()
  const hdrs = { 'Content-Type': 'application/json', 'Client-Id': 'kimne78kx3ncx6brgo4mv6wki5h1ko' }
  if (token) hdrs.Authorization = `OAuth ${token}`
  try {
    const resp = await fetch('https://gql.twitch.tv/gql', {
      method: 'POST',
      headers: hdrs,
      body: JSON.stringify({
        operationName,
        variables,
        extensions: { persistedQuery: { version: 1, sha256Hash: hash } },
      }),
      signal: AbortSignal.timeout(8000),
    })
    if (!resp.ok) throw new Error(`GQL ${resp.status}`)
    return resp.json()
  } catch (directErr) {
    // Firefox CORS fallback — route through MAIN world proxy with hash
    try {
      const data = await gqlProxy(operationName, variables)
      const d = Array.isArray(data) ? data[0] : data
      return d?.data ? d : { data: d }
    } catch {
      throw directErr
    }
  }
}

async function placePredictionBet(eventId, outcomeId, points, _transactionId) {
  const token = getTwitchAuthToken()
  if (!token) return { error: 'not logged in' }
  try {
    const isTosError = (d) => {
      const msg = d?.errors?.[0]?.message || ''
      const code = d?.data?.makePrediction?.error?.code || ''
      return msg.includes('ACCEPT') || msg.includes('TOS') || code.includes('ACCEPT') || code.includes('TOS')
    }
    const tryBet = () => {
      const makeInput = { eventID: eventId, outcomeID: outcomeId, points, transactionID: crypto.randomUUID() }
      return gqlPersistedMutation('MakePrediction', { input: makeInput })
    }

    let data = await tryBet()
    if (isTosError(data)) {
      await acceptPredictionTerms()
      for (let attempt = 0; attempt < 3; attempt++) {
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)))
        data = await tryBet()
        if (!isTosError(data)) break
      }
    }
    if (data?.errors?.length) return { error: data.errors[0].message }
    const mutError = data?.data?.makePrediction?.error
    if (mutError) return { error: mutError.code || 'bet failed' }
    if (_userBets.size > 50) _userBets.delete(_userBets.keys().next().value)
    _userBets.set(eventId, { outcomeId, points })
    return { ok: true }
  } catch (e) {
    return { error: e.message }
  }
}

async function fetchChannelRewards(channelLogin) {
  const safe = channelLogin.replace(/[^a-z0-9_]/g, '')
  if (!safe) return null
  if (_rewardsCacheChannel === safe && _rewardsCache && Date.now() - _rewardsCache.fetchedAt < 60000) {
    return _rewardsCache
  }
  const token = getTwitchAuthToken()
  if (!token) return null
  try {
    // Try proxy with captured ChannelPointsContext hash first
    const data = await gqlProxy('ChannelPointsContext', { channelLogin: safe }).catch(() => null)
    let user = null
    if (data) {
      const d = Array.isArray(data) ? data[0] : data
      user = d?.data?.community?.channel || d?.data?.user || d?.community?.channel || d?.user
    }
    // Fallback: try raw GQL (may work for some fields)
    if (!user) {
      const resp = await fetch(TWITCH_GQL, {
        method: 'POST',
        headers: {
          'Client-Id': TWITCH_CLIENT_ID,
          'Content-Type': 'application/json',
          Authorization: `OAuth ${token}`,
        },
        signal: AbortSignal.timeout(5000),
        body: JSON.stringify({
          query: `{
            user(login: "${safe}") {
              id
              communityPointsSettings {
                customRewards {
                  id title cost backgroundColor isEnabled isPaused isInStock
                  isUserInputRequired cooldownExpiresAt prompt
                  globalCooldownSetting { globalCooldownSeconds isEnabled }
                  image { url }
                  defaultImage { url }
                }
              }
              self {
                communityPoints {
                  balance
                  availableClaim { id }
                }
              }
            }
          }`,
        }),
      })
      if (resp.ok) {
        const raw = await resp.json()
        user = raw?.data?.user
      }
    }
    if (!user) return null
    const settings = user.communityPointsSettings || user.communityPointsSetting || {}
    const rewards = (settings.customRewards || []).filter((r) => r.isEnabled)
    const self = user.self || {}
    const cp = self.communityPoints || {}
    const balance = cp.balance ?? null
    const availableClaim = cp.availableClaim?.id ?? null
    _rewardsCache = { rewards, balance, availableClaim, channelId: user.id, fetchedAt: Date.now() }
    _rewardsCacheChannel = safe
    return _rewardsCache
  } catch (e) {
    log('Failed to fetch rewards:', e.message)
    return null
  }
}

async function redeemChannelReward(channelId, rewardId, cost, title, textInput) {
  const token = getTwitchAuthToken()
  if (!token) return { error: 'not logged in' }
  try {
    const input = {
      channelID: channelId,
      rewardID: rewardId,
      cost,
      title,
      transactionID: crypto.randomUUID(),
    }
    if (textInput) input.textInput = textInput
    // Try proxy first (uses captured hash + integrity)
    try {
      const data = await gqlProxy('RedeemCommunityPointsCustomReward', { input })
      const d = Array.isArray(data) ? data[0] : data
      if (d?.errors?.length) return { error: d.errors[0].message }
      const err = d?.data?.redeemCommunityPointsCustomReward?.error
      if (err) return { error: err.code || 'redemption failed' }
      return { ok: true }
    } catch (proxyErr) {
      console.warn('[hs] redeem gql proxy failed, raw fallback:', proxyErr?.message || proxyErr)
      // Fallback to raw GQL mutation
      const resp = await fetch(TWITCH_GQL, {
        method: 'POST',
        headers: {
          'Client-Id': TWITCH_CLIENT_ID,
          'Content-Type': 'application/json',
          Authorization: `OAuth ${token}`,
        },
        body: JSON.stringify({
          query: `mutation($input: RedeemCommunityPointsCustomRewardInput!) {
            redeemCommunityPointsCustomReward(input: $input) {
              redemption { id }
              error { code }
            }
          }`,
          variables: { input },
        }),
      })
      if (!resp.ok) return { error: `HTTP ${resp.status}` }
      const data = await resp.json()
      if (data?.errors?.length) return { error: data.errors[0].message }
      const err = data?.data?.redeemCommunityPointsCustomReward?.error
      if (err) return { error: err.code || 'redemption failed' }
      return { ok: true }
    }
  } catch (e) {
    return { error: e.message }
  }
}

// ═══ Highlight My Message (Bits power-up) ═══
// Twitch retired the channel-points "Highlight My Message" reward and replaced
// it with a Bits power-up. The send is a single GQL mutation that posts the
// message AND applies the highlight, deducting the power-up's Bits cost from
// the user's balance. Op shape reconstructed from the live web client's
// operation document: mutation SendHighlightedChatMessage($input:
// SendHighlightedChatMessageInput!) { sendHighlightedChatMessage(input) {
// balance error { code } } }. Input mirrors the normal send (channelID,
// message, nonce, replyParentMessageID) plus a client transactionID, same as
// redeemChannelReward. The highlighted message still echoes back through the
// normal IRC read socket, so the composer's pending-send tracker confirms
// delivery exactly like a plain send — we must NOT also PRIVMSG it (dupe).
//
// This spends the USER's own Bits (which they pre-purchased) on the platform's
// own feature — the same category as our existing prediction-betting and
// points-redemption. It is server-kill-switchable via __hsHealth.disabled
// containing 'highlight_send' so a hash/schema break can be neutralized
// without an extension update.
function _isHighlightSendKilled() {
  try {
    const h = (typeof window !== 'undefined' && window.__hsHealth) || null
    return !!(h && (h.kill || (Array.isArray(h.disabled) && h.disabled.includes('highlight_send'))))
  } catch {
    return false
  }
}

// The highlight power-up's Bits cost is per-channel and can move with surge
// pricing, so it must be read live and passed in the input (SendHighlightedChat-
// MessageInput.cost is required — omitting it fails with "Variable cost").
// Path confirmed from the live client: user.channel.communityPointsSettings
// .automaticRewards[] where type === 'SEND_HIGHLIGHTED_MESSAGE'. Cached briefly
// so a burst of highlights doesn't re-query per send.
const _highlightCostCache = new Map() // channelId -> { cost, ts }
async function fetchHighlightCost(channelId) {
  if (!channelId) return null
  const cached = _highlightCostCache.get(String(channelId))
  if (cached && Date.now() - cached.ts < 60000) return cached.cost
  try {
    const data = await twitchGql(
      `{ user(id: "${String(channelId).replace(/[^0-9]/g, '')}") { channel { communityPointsSettings { automaticRewards { type cost } } } } }`,
    )
    const rewards = data?.data?.user?.channel?.communityPointsSettings?.automaticRewards || []
    const hl = rewards.find((r) => r && /HIGHLIGHT/.test(r.type || ''))
    const cost = typeof hl?.cost === 'number' ? hl.cost : null
    if (cost != null) {
      if (_highlightCostCache.size > 100) _highlightCostCache.clear()
      _highlightCostCache.set(String(channelId), { cost, ts: Date.now() })
    }
    return cost
  } catch {
    return null
  }
}

// Highlight sends spend REAL Bits, and Twitch's `transactionID` is the bits
// idempotency key — the same id can land twice and Twitch charges once. The old
// code minted a fresh one every call, so a client-side timeout that surfaced
// "highlight failed" invited a resend that Twitch saw as a brand-new purchase →
// double charge for one highlight. Cache (nonce, transactionID) by message
// content so a manual resend of the same text reuses the same transaction and
// physically cannot double-spend. The entry is dropped on confirmed success, so
// a deliberate identical highlight later still gets a fresh charge.
const _highlightTxns = new Map()
const HIGHLIGHT_TXN_TTL_MS = 5 * 60 * 1000
function _highlightTxnFor(channelId, message, replyParentId) {
  const key = `${channelId}|${replyParentId || ''}|${message}`
  const now = Date.now()
  if (_highlightTxns.size > 200) {
    for (const [k, v] of _highlightTxns) if (now - v.ts > HIGHLIGHT_TXN_TTL_MS) _highlightTxns.delete(k)
  }
  const hit = _highlightTxns.get(key)
  if (hit && now - hit.ts < HIGHLIGHT_TXN_TTL_MS) return { key, ...hit }
  const fresh = { nonce: crypto.randomUUID(), transactionID: crypto.randomUUID(), ts: now }
  _highlightTxns.set(key, fresh)
  return { key, ...fresh }
}

async function sendHighlightedTwitchMessage(channelId, message, nonce, replyParentId) {
  if (_isHighlightSendKilled()) return { error: 'highlight disabled by server' }
  const token = getTwitchAuthToken()
  if (!token) return { error: 'not logged in' }
  if (!channelId) return { error: 'channel not resolved' }
  const cost = await fetchHighlightCost(channelId)
  if (cost == null) return { error: 'highlight unavailable on this channel' }
  // Reuse a recent transaction for the same message so a resend is idempotent
  // at Twitch's bits layer. An explicit nonce (caller-supplied) still wins.
  const txn = _highlightTxnFor(channelId, message, replyParentId)
  const input = {
    channelID: String(channelId),
    message,
    cost,
    nonce: nonce || txn.nonce,
    transactionID: txn.transactionID,
  }
  if (replyParentId) input.replyParentMessageID = replyParentId
  const readResult = (d) => {
    if (d?.errors?.length) return { error: d.errors[0].message }
    const payload = d?.data?.sendHighlightedChatMessage
    const err = payload?.error
    if (err) return { error: err.code || 'highlight failed' }
    return { ok: true, balance: payload?.balance ?? null }
  }
  // MUST go through the MAIN-world proxy: mutations require a Client-Integrity
  // token, which only the MAIN-world injector can mint (it also auto-refreshes +
  // retries once on integrity failure). A direct isolated-world fetch has no
  // integrity → "failed integrity check". Twitch's own client never fires this
  // op, so no persisted-query hash is captured; we send the full mutation as a
  // rawQuery (the proxy detects the leading `mutation` and mints integrity).
  const RAW_QUERY = `mutation SendHighlightedChatMessage($input: SendHighlightedChatMessageInput!) {
    sendHighlightedChatMessage(input: $input) { balance error { code } }
  }`
  try {
    const data = await gqlProxy('SendHighlightedChatMessage', { input }, { rawQuery: RAW_QUERY })
    const res = readResult(Array.isArray(data) ? data[0] : data)
    // Confirmed one way or the other: a structured response means Twitch
    // processed the mutation (charged + posted, or rejected before charging).
    // Either way this transaction is spent — drop it so a later deliberate
    // resend of the same text starts a fresh charge instead of being deduped.
    _highlightTxns.delete(txn.key)
    return res
  } catch (e) {
    // A throw is a CLIENT-side timeout/integrity/abort — we never heard back,
    // so the charge may or may not have happened. Keep the transaction cached
    // (untouched) so a resend reuses it and Twitch dedupes; tell the caller this
    // is unconfirmed, NOT a clean failure, so it doesn't frame a resend as a
    // repair the way an insufficient-bits error would.
    return { error: e.message, unconfirmed: true }
  }
}

async function claimCommunityPoints(claimId, channelId, channelLogin) {
  const token = getTwitchAuthToken()
  if (!token) return false
  let claimed = false
  try {
    await gqlProxy('ClaimCommunityPoints', {
      input: { claimID: claimId, channelID: channelId },
    }).catch(async () => {
      // Fallback to raw GQL
      const resp = await fetch(TWITCH_GQL, {
        method: 'POST',
        headers: {
          'Client-Id': TWITCH_CLIENT_ID,
          'Content-Type': 'application/json',
          Authorization: `OAuth ${token}`,
        },
        body: JSON.stringify({
          query: `mutation($input: ClaimCommunityPointsInput!) {
            claimCommunityPoints(input: $input) { claim { id } }
          }`,
          variables: { input: { claimID: claimId, channelID: channelId } },
        }),
        signal: AbortSignal.timeout(8000),
      })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    })
    claimed = true
  } catch (e) {
    log('Failed to claim bonus points:', e.message)
  }
  // Silent claim by design — a toast per claim was noisy when tracking multiple
  // channels; points still credit without one.
  return claimed
}

// Persist active poll to storage (survives reloads; Twitch has no public poll query)
function _savePollToStorage(poll, channelId) {
  if (!poll?.id) return
  try {
    chrome.storage.local.set({ hs_active_poll: { poll, channelId, savedAt: Date.now() } })
  } catch {}
}
function _clearPollFromStorage() {
  try {
    chrome.storage.local.remove('hs_active_poll')
  } catch {}
}

// Recompute remainingDurationMilliseconds from startedAt + durationSeconds
function _refreshPollTiming(poll) {
  if (!poll?.startedAt || !poll?.durationSeconds) return poll
  const elapsed = Date.now() - new Date(poll.startedAt).getTime()
  const totalMs = poll.durationSeconds * 1000
  poll.remainingDurationMilliseconds = Math.max(0, totalMs - elapsed)
  // Auto-mark as completed if time expired
  if (poll.remainingDurationMilliseconds <= 0 && poll.status === 'ACTIVE') {
    poll.status = 'COMPLETED'
  }
  return poll
}

async function fetchPoll(channelLogin) {
  const safe = channelLogin.replace(/[^a-z0-9_]/g, '')
  if (!safe) return null
  try {
    // 1. Check GQL interception cache (from Twitch's own traffic)
    for (const key of ['ActivePoll', 'ChannelPollContext']) {
      const c = _gqlDataCache[key]
      if (c && Date.now() - c.ts < 15000) {
        const poll = c.data?.user?.activePoll || c.data?.channel?.activePoll || null
        if (poll) {
          _refreshPollTiming(poll)
          _savePollToStorage(poll, c.data?.user?.id || _twitchChannelId)
          const isMod = c.data?.user?.self?.isModerator || _twitchIsMod
          return { poll, channelId: c.data?.user?.id || _twitchChannelId, isMod }
        }
      }
    }
    // 2. Check persistent storage (survives reloads, no 15s TTL)
    //    activePoll is persisted-query-only — no public GQL query exists
    try {
      const stored = await chrome.storage.local.get('hs_active_poll')
      const entry = stored?.hs_active_poll
      if (entry?.poll && entry.channelId === _twitchChannelId) {
        const poll = _refreshPollTiming(entry.poll)
        // Clear expired/completed polls from storage
        if (poll.status === 'COMPLETED' || poll.status === 'ARCHIVED' || poll.status === 'TERMINATED') {
          _clearPollFromStorage()
        } else {
          return { poll, channelId: entry.channelId, isMod: _twitchIsMod }
        }
      }
    } catch {}
    return { poll: null, channelId: _twitchChannelId, isMod: _twitchIsMod }
  } catch (e) {
    log('Failed to fetch poll:', e.message)
    return null
  }
}

async function votePoll(pollId, choiceId) {
  const token = getTwitchAuthToken()
  if (!token) return { error: 'not logged in' }
  try {
    // Try proxy first
    try {
      const data = await gqlProxy('VotePoll', {
        input: { pollID: pollId, choiceID: choiceId },
      })
      const d = Array.isArray(data) ? data[0] : data
      if (d?.errors?.length) return { error: d.errors[0].message }
      const err = d?.data?.votePoll?.error
      if (err) return { error: err.code || 'vote failed' }
      return { ok: true }
    } catch (proxyErr) {
      console.warn('[hs] votePoll gql proxy failed, raw fallback:', proxyErr?.message || proxyErr)
      // Fallback to raw GQL
      const resp = await fetch(TWITCH_GQL, {
        method: 'POST',
        headers: {
          'Client-Id': TWITCH_CLIENT_ID,
          'Content-Type': 'application/json',
          Authorization: `OAuth ${token}`,
        },
        body: JSON.stringify({
          query: 'mutation($input: VotePollInput!) { votePoll(input: $input) { error { code } } }',
          variables: { input: { pollID: pollId, choiceID: choiceId } },
        }),
        signal: AbortSignal.timeout(8000),
      })
      if (!resp.ok) return { error: `HTTP ${resp.status}` }
      const data = await resp.json()
      if (data?.errors?.length) return { error: data.errors[0].message }
      const err = data?.data?.votePoll?.error
      if (err) return { error: err.code || 'vote failed' }
      return { ok: true }
    }
  } catch (e) {
    return { error: e.message }
  }
}

const POLL_FIELDS =
  'id title status durationSeconds remainingDurationMilliseconds startedAt choices { id title totalVoters } totalVoters'

async function createTwitchPoll(channelId, title, durationSeconds, choices) {
  const rawQuery = `mutation($input: CreatePollInput!) { createPoll(input: $input) { poll { ${POLL_FIELDS} } error { code } } }`
  const variables = {
    input: { ownedBy: channelId, title, choices: choices.map((t) => ({ title: t })), durationSeconds },
  }
  try {
    const data = await gqlMutation(rawQuery, variables)
    const result = data?.data?.createPoll
    if (result?.error) return { error: result.error.code || 'create poll failed' }
    if (data?.errors?.length) return { error: data.errors[0].message || 'create poll failed' }
    const poll = result?.poll
    if (poll) {
      _gqlDataCache.ActivePoll = { data: { user: { activePoll: poll, id: channelId } }, ts: Date.now() }
      _savePollToStorage(poll, channelId)
    }
    return { ok: true, poll }
  } catch (e) {
    return { error: e.message }
  }
}

async function endTwitchPoll(pollId) {
  const rawQuery = `mutation($input: TerminatePollInput!) { terminatePoll(input: $input) { poll { ${POLL_FIELDS} } } }`
  const variables = { input: { pollID: pollId } }
  try {
    const data = await gqlMutation(rawQuery, variables)
    if (data?.errors?.length) return { error: data.errors[0].message || 'end poll failed' }
    const poll = data?.data?.terminatePoll?.poll
    if (poll) {
      _gqlDataCache.ActivePoll = { data: { user: { activePoll: poll, id: _twitchChannelId } }, ts: Date.now() }
    }
    _clearPollFromStorage()
    return { ok: true }
  } catch (e) {
    return { error: e.message }
  }
}

const _userPollVotes = new Map() // pollId → choiceId

function renderPoll(poll, channelId, isMod) {
  const section = document.createElement('div')
  section.className = 'hs-mc-poll'
  section.dataset.pollId = poll.id
  if (channelId) section.dataset.channelId = channelId

  const isCompleted = poll.status === 'COMPLETED' || poll.status === 'ARCHIVED'
  const totalVotes = poll.totalVoters || poll.choices.reduce((s, c) => s + (c.totalVoters || 0), 0)
  const userVote = _userPollVotes.get(poll.id)

  // Header
  const header = document.createElement('div')
  header.className = 'hs-mc-poll-header'
  const title = document.createElement('div')
  title.className = 'hs-mc-poll-title'
  title.textContent = poll.title
  header.appendChild(title)

  if (isCompleted) {
    const badge = document.createElement('span')
    badge.className = 'hs-mc-poll-status hs-mc-poll-status-ended'
    badge.textContent = t('mc_poll_ended')
    header.appendChild(badge)
  } else if (poll.remainingDurationMilliseconds != null) {
    const timer = document.createElement('span')
    timer.className = 'hs-mc-poll-timer'
    timer.dataset.ends = Date.now() + poll.remainingDurationMilliseconds
    header.appendChild(timer)
  }
  section.appendChild(header)

  // Total votes
  const meta = document.createElement('div')
  meta.className = 'hs-mc-poll-meta'
  meta.textContent = `${totalVotes} vote${totalVotes !== 1 ? 's' : ''}`
  section.appendChild(meta)

  // Choices
  const choicesWrap = document.createElement('div')
  choicesWrap.className = 'hs-mc-poll-choices'

  // Find top choice for winner highlight
  let topVotes = 0
  for (const c of poll.choices) {
    if ((c.totalVoters || 0) > topVotes) topVotes = c.totalVoters || 0
  }

  for (const choice of poll.choices) {
    const votes = choice.totalVoters || 0
    const pct = totalVotes > 0 ? Math.round((votes / totalVotes) * 100) : 0
    const isTop = isCompleted && votes === topVotes && topVotes > 0
    const isVoted = userVote === choice.id

    const row = document.createElement('div')
    row.className = `hs-mc-poll-choice${isTop ? ' hs-mc-poll-choice-top' : ''}${isVoted ? ' hs-mc-poll-choice-voted' : ''}`

    const track = document.createElement('div')
    track.className = 'hs-mc-poll-choice-track'
    const fill = document.createElement('div')
    fill.className = 'hs-mc-poll-choice-fill'
    fill.style.width = `${pct}%`
    track.appendChild(fill)

    const label = document.createElement('div')
    label.className = 'hs-mc-poll-choice-label'

    const nameSpan = document.createElement('span')
    nameSpan.className = 'hs-mc-poll-choice-name'
    nameSpan.textContent = choice.title
    if (isVoted) {
      const check = document.createElement('span')
      check.className = 'hs-mc-poll-voted-check'
      check.textContent = ' \u2713'
      nameSpan.appendChild(check)
    }
    label.appendChild(nameSpan)

    const pctSpan = document.createElement('span')
    pctSpan.className = 'hs-mc-poll-choice-pct'
    pctSpan.textContent = `${pct}%`
    label.appendChild(pctSpan)

    track.appendChild(label)
    row.appendChild(track)

    if (!isCompleted && !userVote) {
      const voteBtn = document.createElement('button')
      voteBtn.className = 'hs-mc-poll-vote-btn'
      voteBtn.dataset.pollId = poll.id
      voteBtn.dataset.choiceId = choice.id
      voteBtn.textContent = 'vote'
      row.appendChild(voteBtn)
    }

    choicesWrap.appendChild(row)
  }

  section.appendChild(choicesWrap)

  // Mod controls — end poll
  if (!isCompleted && isMod) {
    const modRow = document.createElement('div')
    modRow.className = 'hs-mc-poll-mod-row'
    const endBtn = document.createElement('button')
    endBtn.className = 'hs-mc-poll-mod-btn hs-mc-poll-end-btn'
    endBtn.dataset.pollId = poll.id
    endBtn.textContent = t('mc_poll_end')
    modRow.appendChild(endBtn)
    section.appendChild(modRow)
  }

  return section
}

function renderNoPoll(channelId, isMod) {
  const wrap = document.createElement('div')
  wrap.className = 'hs-mc-poll-empty'
  if (!isMod) return wrap

  const createWrap = document.createElement('div')
  createWrap.className = 'hs-mc-poll-create'
  if (channelId) createWrap.dataset.channelId = channelId

  const toggle = document.createElement('button')
  toggle.className = 'hs-mc-poll-mod-btn hs-mc-poll-create-toggle'
  toggle.textContent = t('mc_poll_new')
  createWrap.appendChild(toggle)

  const form = document.createElement('div')
  form.className = 'hs-mc-poll-create-form'
  form.style.display = 'none'

  const titleInput = document.createElement('input')
  titleInput.className = 'hs-mc-poll-create-input'
  titleInput.placeholder = t('mc_poll_question')
  titleInput.maxLength = 60
  form.appendChild(titleInput)

  for (let i = 0; i < 4; i++) {
    const opt = document.createElement('input')
    opt.className = 'hs-mc-poll-create-input hs-mc-poll-create-choice'
    opt.placeholder = t('mc_poll_choice', [String(i + 1)]) + (i < 2 ? '' : ` (${t('mc_poll_optional')})`)
    opt.maxLength = 25
    form.appendChild(opt)
  }

  const durRow = document.createElement('div')
  durRow.className = 'hs-mc-poll-create-dur-row'
  const durLabel = document.createElement('span')
  durLabel.className = 'hs-mc-poll-create-dur-label'
  durLabel.textContent = t('mc_pred_duration')
  durRow.appendChild(durLabel)
  for (const secs of [30, 60, 120, 300, 600, 1800]) {
    const btn = document.createElement('button')
    btn.className = `hs-mc-poll-create-dur${secs === 60 ? ' hs-mc-poll-create-dur-active' : ''}`
    btn.dataset.secs = secs
    btn.tabIndex = -1
    btn.textContent = secs < 60 ? `${secs}s` : `${secs / 60}m`
    durRow.appendChild(btn)
  }
  form.appendChild(durRow)

  const submitBtn = document.createElement('button')
  submitBtn.className = 'hs-mc-poll-mod-btn hs-mc-poll-create-submit'
  submitBtn.tabIndex = -1
  submitBtn.textContent = t('mc_poll_create')
  form.appendChild(submitBtn)

  createWrap.appendChild(form)
  wrap.appendChild(createWrap)
  return wrap
}

// Optimistic UI update after voting — patch DOM immediately without round-trip
function optimisticPollVoteUpdate(pollSection, choiceId) {
  if (!pollSection) return
  const choices = pollSection.querySelectorAll('.hs-mc-poll-choice')
  const metaEl = pollSection.querySelector('.hs-mc-poll-meta')
  const totalMatch = metaEl?.textContent?.match(/(\d+)/)
  const oldTotal = totalMatch ? parseInt(totalMatch[1], 10) : 0

  // Reconstruct per-choice vote counts from percentages
  const entries = []
  for (const choice of choices) {
    const pctEl = choice.querySelector('.hs-mc-poll-choice-pct')
    const nameEl = choice.querySelector('.hs-mc-poll-choice-name')
    const voteBtn = choice.querySelector('.hs-mc-poll-vote-btn')
    const isTarget = voteBtn?.dataset?.choiceId === choiceId
    const oldPct = pctEl ? parseInt(pctEl.textContent, 10) : 0
    let votes = oldTotal > 0 ? Math.round((oldPct / 100) * oldTotal) : 0
    if (isTarget) votes += 1
    entries.push({ choice, votes, pctEl, nameEl, voteBtn, isTarget })
  }

  const total = entries.reduce((s, v) => s + v.votes, 0) || 1
  if (metaEl) metaEl.textContent = `${total} vote${total !== 1 ? 's' : ''}`

  for (const { choice, votes, pctEl, nameEl, voteBtn, isTarget } of entries) {
    const pct = Math.round((votes / total) * 100)
    if (pctEl) pctEl.textContent = `${pct}%`
    const fill = choice.querySelector('.hs-mc-poll-choice-fill')
    if (fill) fill.style.width = `${pct}%`
    if (isTarget) {
      choice.classList.add('hs-mc-poll-choice-voted')
      if (nameEl && !nameEl.querySelector('.hs-mc-poll-voted-check')) {
        const check = document.createElement('span')
        check.className = 'hs-mc-poll-voted-check'
        check.textContent = ' \u2713'
        nameEl.appendChild(check)
      }
    }
    // Remove all vote buttons (user already voted)
    if (voteBtn) voteBtn.remove()
  }
}

function attachPollHandlers() {
  const container = document.getElementById('hs-mc-tab-twitch')
  if (!container) return

  container.querySelectorAll('.hs-mc-poll-vote-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation()
      btn.disabled = true
      btn.textContent = '...'
      const result = await votePoll(btn.dataset.pollId, btn.dataset.choiceId)
      if (result.error) {
        btn.textContent = '!'
        btn.title = result.error
        setTimeout(() => {
          btn.textContent = 'vote'
          btn.disabled = false
          btn.title = ''
        }, 2000)
      } else {
        if (_userPollVotes.size > 50) _userPollVotes.delete(_userPollVotes.keys().next().value)
        _userPollVotes.set(btn.dataset.pollId, btn.dataset.choiceId)
        const pollSection = btn.closest('.hs-mc-poll')
        optimisticPollVoteUpdate(pollSection, btn.dataset.choiceId)
        setTimeout(() => refreshPollSlot(), 3000)
      }
    })
  })

  // End poll (mod)
  container.querySelectorAll('.hs-mc-poll-end-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation()
      btn.disabled = true
      btn.textContent = '...'
      const result = await endTwitchPoll(btn.dataset.pollId)
      if (result.error) {
        btn.textContent = result.error
        btn.title = result.error
        setTimeout(() => {
          btn.textContent = t('mc_poll_end')
          btn.disabled = false
          btn.title = ''
        }, 3000)
      } else {
        btn.textContent = '\u2713'
        refreshPollSlot()
      }
    })
  })

  // Create poll toggle
  container.querySelectorAll('.hs-mc-poll-create-toggle').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const form = btn.parentElement.querySelector('.hs-mc-poll-create-form')
      if (form) {
        const showing = form.style.display !== 'none'
        form.style.display = showing ? 'none' : 'flex'
        btn.textContent = showing ? t('mc_poll_new') : t('mc_pred_cancel_form')
      }
    })
  })

  // Create poll duration picker
  container.querySelectorAll('.hs-mc-poll-create-dur').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      container.querySelectorAll('.hs-mc-poll-create-dur').forEach((b) => {
        b.classList.remove('hs-mc-poll-create-dur-active')
      })
      btn.classList.add('hs-mc-poll-create-dur-active')
    })
  })

  // Create poll submit
  container.querySelectorAll('.hs-mc-poll-create-submit').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation()
      const createWrap = btn.closest('.hs-mc-poll-create')
      const channelId = createWrap?.dataset.channelId
      if (!channelId) {
        btn.textContent = 'no channel'
        return
      }
      const form = btn.closest('.hs-mc-poll-create-form')
      const inputs = form.querySelectorAll('.hs-mc-poll-create-input')
      const title = inputs[0]?.value?.trim()
      const choices = [...form.querySelectorAll('.hs-mc-poll-create-choice')].map((i) => i.value.trim()).filter(Boolean)
      if (!title) {
        inputs[0].focus()
        return
      }
      if (choices.length < 2) {
        form.querySelectorAll('.hs-mc-poll-create-choice')[choices.length]?.focus()
        return
      }
      const durBtn = form.querySelector('.hs-mc-poll-create-dur-active')
      const secs = parseInt(durBtn?.dataset.secs || '60', 10)
      btn.disabled = true
      btn.textContent = '...'
      const result = await createTwitchPoll(channelId, title, secs, choices)
      if (result.error) {
        const errMap = {
          POLL_ALREADY_ACTIVE: t('mc_error_poll_active'),
          FORBIDDEN: t('mc_error_no_permission'),
          UNAUTHORIZED: t('mc_error_not_logged_in'),
        }
        const msg = errMap[result.error] || result.error
        btn.textContent = msg
        btn.title = result.error
        setTimeout(() => {
          btn.textContent = t('mc_poll_create')
          btn.disabled = false
          btn.title = ''
        }, 3000)
      } else {
        // Close create form so refreshPollSlot's guard doesn't skip
        form.style.display = 'none'
        refreshPollSlot()
      }
    })
  })

  // Create poll keyboard nav
  container.querySelectorAll('.hs-mc-poll-create-input').forEach((input) => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault()
        const inputs = [...container.querySelectorAll('.hs-mc-poll-create-input')]
        const idx = inputs.indexOf(input)
        const next = inputs[(idx + 1) % inputs.length]
        next?.focus()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        container.querySelector('.hs-mc-poll-create-submit')?.click()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        container.querySelector('.hs-mc-poll-create-toggle')?.click()
      }
    })
  })

  // Poll timers
  container.querySelectorAll('.hs-mc-poll-timer').forEach((el) => {
    const endsAt = parseInt(el.dataset.ends, 10)
    const update = () => {
      const remaining = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000))
      if (remaining <= 0) {
        el.textContent = t('mc_poll_ended')
        el.classList.add('hs-mc-poll-status-ended')
        return
      }
      const m = Math.floor(remaining / 60)
      const s = remaining % 60
      el.textContent = m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`
    }
    update()
    const iv = cleanup.setIntervalIfVisible(() => {
      if (!el.isConnected) {
        cleanup.clearInterval(iv)
        return
      }
      update()
    }, 1000)
  })
}

const badgesInFlight = new Set()
const badgesFailedAt = new Map() // channelLogin -> ms (last failure) — LRU-capped at 100
const BADGE_FAILURE_BACKOFF_MS = 60000
const BADGES_FAILED_MAX = 100

async function fetchChannelBadges(channelLogin) {
  if (!channelLogin) return
  if (badgesFetchedChannels.has(channelLogin)) return
  if (badgesInFlight.has(channelLogin)) return
  // Backoff window after a failed fetch — without this, an early fetch that
  // failed (transient 5xx, network blip, empty data) used to permanently
  // poison the guard so badges fell back to the global star forever.
  const lastFail = badgesFailedAt.get(channelLogin)
  if (lastFail && Date.now() - lastFail < BADGE_FAILURE_BACKOFF_MS) return
  // Sanitize: Twitch logins are alphanumeric + underscore only
  const safe = channelLogin.replace(/[^a-z0-9_]/g, '')
  if (!safe) return
  badgesInFlight.add(channelLogin)
  let populated = false
  try {
    // Fetch channel badges (GQL broadcastBadges) + FFZ in parallel
    const [gqlResp, ffzResp] = await Promise.allSettled([
      twitchGql(`{ user(login:"${safe}") { broadcastBadges { imageURL(size: NORMAL) setID version } } }`),
      fetch(`https://api.frankerfacez.com/v1/room/${safe}`, { credentials: 'omit', signal: AbortSignal.timeout(5000) }),
    ])

    // Channel badges via GQL broadcastBadges (no Client-Integrity needed)
    if (gqlResp.status === 'fulfilled') {
      const badges = gqlResp.value?.data?.user?.broadcastBadges
      if (badges?.length) {
        const versionsBySet = new Map()
        for (const b of badges) {
          if (b.imageURL) {
            twitchBadgeUrls.set(`${channelLogin}:${b.setID}/${b.version}`, b.imageURL)
            populated = true
          }
          const v = parseInt(b.version, 10)
          if (Number.isFinite(v)) {
            let arr = versionsBySet.get(b.setID)
            if (!arr) {
              arr = []
              versionsBySet.set(b.setID, arr)
            }
            arr.push(v)
          }
        }
        for (const [setID, arr] of versionsBySet) {
          arr.sort((a, b) => a - b)
          channelBadgeVersions.set(`${channelLogin}:${setID}`, arr)
        }
      }
    }

    // FFZ custom mod/VIP badges — override Twitch versions
    if (ffzResp.status === 'fulfilled' && ffzResp.value.ok) {
      const ffz = await ffzResp.value.json()
      const room = ffz?.room
      if (room) {
        const modUrl = room.mod_urls?.['2'] || room.mod_urls?.['1'] || room.moderator_badge
        if (modUrl) {
          const src = modUrl.startsWith('//') ? `https:${modUrl}` : modUrl
          twitchBadgeUrls.set(`${channelLogin}:moderator/1`, src)
          ffzBadgeKeys.add(`${channelLogin}:moderator`)
          populated = true
        }
        const vipUrl = room.vip_badge?.['2'] || room.vip_badge?.['1']
        if (vipUrl) {
          const src = vipUrl.startsWith('//') ? `https:${vipUrl}` : vipUrl
          twitchBadgeUrls.set(`${channelLogin}:vip/1`, src)
          ffzBadgeKeys.add(`${channelLogin}:vip`)
          populated = true
        }
      }
    }

    if (populated) {
      badgesFetchedChannels.add(channelLogin)
      badgesFailedAt.delete(channelLogin)
      // Evict oldest channel if cache exceeds 20
      if (badgesFetchedChannels.size > 20) {
        const oldest = badgesFetchedChannels.values().next().value
        badgesFetchedChannels.delete(oldest)
        for (const key of twitchBadgeUrls.keys()) {
          if (key.startsWith(`${oldest}:`)) twitchBadgeUrls.delete(key)
        }
        for (const key of ffzBadgeKeys) {
          if (key.startsWith(`${oldest}:`)) ffzBadgeKeys.delete(key)
        }
        for (const key of channelBadgeVersions.keys()) {
          if (key.startsWith(`${oldest}:`)) channelBadgeVersions.delete(key)
        }
      }
      log('Loaded channel badges for', channelLogin)
      // Patch rows for this channel in-place: no epoch bump, no full rebuild,
      // no image-reload flash. Other tabs are invalidated via _dropAllTabCaches
      // inside updateNativeBadgesInPlace so they rebuild fresh on next switch.
      if (typeof updateNativeBadgesInPlace === 'function') updateNativeBadgesInPlace(channelLogin)
    } else {
      // No data populated — schedule retry after backoff
      if (badgesFailedAt.size >= BADGES_FAILED_MAX) {
        badgesFailedAt.delete(badgesFailedAt.keys().next().value)
      }
      badgesFailedAt.set(channelLogin, Date.now())
      log('No channel badges returned for', channelLogin, '— will retry after backoff')
    }
  } catch (e) {
    log('Failed to fetch channel badges:', e.message)
    if (badgesFailedAt.size >= BADGES_FAILED_MAX) {
      badgesFailedAt.delete(badgesFailedAt.keys().next().value)
    }
    badgesFailedAt.set(channelLogin, Date.now())
  } finally {
    badgesInFlight.delete(channelLogin)
  }
}

// Kick subscriber badges. Routes through BG (kick_channel_badges) so the
// cross-origin fetch isn't gated by the panel's CORS rules — panel may be on
// twitch.tv viewing a linked Kick channel. Populates twitchBadgeUrls under
// (slug):subscriber/(months) so renderBadges' channel-prefixed lookup picks
// them up without any caller change.
// Kick badges live in their own Map so dual-link channels don't collide with
// Twitch's tier-encoded sub badge versions (1000/2000/3000 for tiers vs Kick's
// linear month numbers 1/2/3/6/12). renderBadges checks platform to pick which
// Map to use.
const kickBadgeUrls = new Map()
const kickChannelBadgeVersions = new Map()
const kickBadgesFetchedChannels = new Set()
const kickBadgesInFlight = new Set()
const kickBadgesFailedAt = new Map()

function findNearestKickBadgeVersion(channel, name, version) {
  const versions = kickChannelBadgeVersions.get(`${channel}:${name}`)
  if (!versions || versions.length === 0) return null
  const v = parseInt(version, 10)
  if (!Number.isFinite(v)) return null
  let best = -1
  for (const vv of versions) {
    if (vv > v) break
    if (vv > best) best = vv
  }
  return best >= 0 ? String(best) : null
}

async function fetchKickChannelBadges(slug) {
  if (!slug) return
  slug = String(slug).toLowerCase()
  if (kickBadgesFetchedChannels.has(slug)) return
  if (kickBadgesInFlight.has(slug)) return
  const lastFail = kickBadgesFailedAt.get(slug)
  if (lastFail && Date.now() - lastFail < BADGE_FAILURE_BACKOFF_MS) return
  kickBadgesInFlight.add(slug)
  try {
    const resp = await safeSendMessage({ type: 'kick_channel_badges', slug })
    if (!resp?.ok || !Array.isArray(resp.badges) || resp.badges.length === 0) {
      if (kickBadgesFailedAt.size >= BADGES_FAILED_MAX) {
        kickBadgesFailedAt.delete(kickBadgesFailedAt.keys().next().value)
      }
      kickBadgesFailedAt.set(slug, Date.now())
      return
    }
    const monthsList = []
    for (const b of resp.badges) {
      if (Number.isFinite(b.months) && typeof b.src === 'string') {
        kickBadgeUrls.set(`${slug}:subscriber/${b.months}`, b.src)
        monthsList.push(b.months)
      }
    }
    if (monthsList.length) {
      monthsList.sort((a, b) => a - b)
      kickChannelBadgeVersions.set(`${slug}:subscriber`, monthsList)
      kickBadgesFetchedChannels.add(slug)
      kickBadgesFailedAt.delete(slug)
      if (kickBadgesFetchedChannels.size > 20) {
        const oldest = kickBadgesFetchedChannels.values().next().value
        kickBadgesFetchedChannels.delete(oldest)
        const prefix = `${oldest}:subscriber/`
        for (const key of [...kickBadgeUrls.keys()]) {
          if (key.startsWith(prefix)) kickBadgeUrls.delete(key)
        }
        kickChannelBadgeVersions.delete(`${oldest}:subscriber`)
      }
      // Patch rows for this channel in-place — same choke point the Twitch
      // fetchChannelBadges/fetchGlobalBadges paths already use. This one was
      // missing it entirely (see removed comment above): join()'s history
      // hydration resolves off BG's in-memory cache, reliably faster than this
      // real network round-trip, so backfilled Kick sub-badge rows always lost
      // the race and — with no patch call here — never got upgraded from the
      // TEXT-fallback chip to the styled image badge until something else
      // forced a full rebuild.
      if (typeof updateNativeBadgesInPlace === 'function') updateNativeBadgesInPlace(slug)
    }
  } catch (_) {
    if (kickBadgesFailedAt.size >= BADGES_FAILED_MAX) {
      kickBadgesFailedAt.delete(kickBadgesFailedAt.keys().next().value)
    }
    kickBadgesFailedAt.set(slug, Date.now())
  } finally {
    kickBadgesInFlight.delete(slug)
  }
}

// Pure: resolves a single badge's image URL following the exact priority
// chain — channel-specific exact match → channel-specific nearest tier (e.g.
// a 5mo sub on a channel that only defines 0/3/6 → use 3) → global exact →
// global "/1" generic-star fallback. Kick is a separate, simpler chain: its
// own Map, and it never falls through to Twitch URLs — Twitch sub badges are
// keyed by tier-encoded versions (1000/2000/3000) which mismatch Kick's
// linear month numbers (1/2/3/6/12); the Twitch findNearest would return e.g.
// "subscriber/0" for Kick's "subscriber/1", producing a wrong tier badge.
// Shared by renderBadges (initial render) and _patchBadgesInRoot (main.js —
// the late in-place patch once fetchGlobalBadges/fetchChannelBadges/
// fetchKickChannelBadges resolve) so the two can never drift apart on which
// URL a given badge/version resolves to.
function resolveBadgeImageUrl(isKick, channel, name, version) {
  if (isKick) {
    if (!channel) return null
    let url = kickBadgeUrls.get(`${channel}:${name}/${version}`)
    if (!url) {
      const nearest = findNearestKickBadgeVersion(channel, name, version)
      if (nearest != null) url = kickBadgeUrls.get(`${channel}:${name}/${nearest}`)
    }
    return url || null
  }
  let url = channel && twitchBadgeUrls.get(`${channel}:${name}/${version}`)
  if (!url && channel) {
    const nearest = findNearestChannelBadgeVersion(channel, name, version)
    if (nearest != null) url = twitchBadgeUrls.get(`${channel}:${name}/${nearest}`)
  }
  return url || twitchBadgeUrls.get(`${name}/${version}`) || twitchBadgeUrls.get(`${name}/1`) || null
}

function renderBadges(badgesStr, channel, platform) {
  if (!badgesStr) return ''
  const isKick = platform === 'kick'
  return badgesStr
    .split(',')
    .map((badge) => {
      const [name, version] = badge.split('/')
      const url = resolveBadgeImageUrl(isKick, channel, name, version)
      if (url) {
        // Semantic bg so the slot shows the badge color even before/without the
        // image (FFZ = padded chip for a transparent icon; native = bg behind).
        const isFFZ = channel && ffzBadgeKeys.has(`${channel}:${name}`)
        const bgStyle = badgeBgStyle(name, isFFZ)
        const label = BADGE_STYLES[name]?.label || name
        // NOT loading="lazy": badges are 18px and always at the row start next
        // to visible text. When the async channel-badge fetch lands and the
        // retro-paint (_patchBadgesInRoot) swaps the green text fallback for
        // this img, a lazy img wouldn't paint until the next reflow — so the
        // mod/vip/sub badge vanished until a new message or channel switch.
        return `<img class="hs-mc-badge-img" data-badge="${escapeHtml(name)}/${escapeHtml(version)}" src="${escapeHtml(safeUrl(url) || '')}" alt="${escapeHtml(name)}" title="${escapeHtml(label)}" decoding="async" width="18" height="18" style="width:18px;height:18px;${bgStyle}">`
      }
      // Text fallback
      const style = BADGE_STYLES[name]
      if (!style) return ''
      return `<span class="hs-mc-badge" data-badge="${escapeHtml(name)}/${escapeHtml(version)}" style="background:${style.bg};color:${style.fg}" title="${escapeHtml(style.label)}">${style.label}</span>`
    })
    .join('')
}

function renderThirdPartyBadges(userId) {
  if (!userId) return ''
  let html = ''
  // Per-provider classes (hs-mc-{bttv,ffz,chatterino}-badge) let
  // updateThirdPartyBadgesInPlace dedup against rows already carrying the badge,
  // so a late bulk-map arrival patches cold rows in place instead of forcing a
  // full rebuild (the "loads then shifts" flash on channel switch).
  const bttv = getSetting('bttvBadges') ? mcBttvBadgeMap.get(userId) : null
  if (bttv) {
    html += `<img class="hs-mc-badge-img hs-mc-bttv-badge" src="${escapeHtml(safeUrl(bttv.url) || '')}" alt="${escapeHtml(bttv.description)}" title="${escapeHtml(bttv.description)}" decoding="async" width="18" height="18" style="width:18px;height:18px;">`
  }
  const ffzList = getSetting('ffzBadges') ? mcFfzBadgeMap.get(userId) : null
  if (ffzList) {
    for (const b of ffzList) {
      const safeColor = /^#[0-9a-fA-F]{3,8}$/.test(b.color) ? b.color : ''
      html += `<img class="hs-mc-badge-img hs-mc-ffz-badge" src="${escapeHtml(safeUrl(b.url) || '')}" alt="${escapeHtml(b.title)}" title="${escapeHtml(b.title)}" decoding="async" width="18" height="18" style="width:18px;height:18px;${safeColor ? `background:${safeColor};` : ''}">`
    }
  }
  const chat = getSetting('chatterinoBadges') ? mcChatterinoBadgeMap.get(userId) : null
  if (chat) {
    html += `<img class="hs-mc-badge-img hs-mc-chatterino-badge" src="${escapeHtml(safeUrl(chat.url) || '')}" alt="Chatterino" title="${escapeHtml(chat.tooltip || 'Chatterino')}" decoding="async" width="18" height="18" style="width:18px;height:18px;">`
  }
  const cosmetic = getSetting('sevenTvPaints') ? mcUserCosmetics.get(userId) : null
  if (cosmetic?.badge) {
    const files = cosmetic.badge.host?.files || []
    const file =
      files.find((f) => f.name?.endsWith('.webp')) || files.find((f) => f.name?.endsWith('.avif')) || files[0]
    if (file) {
      const base = cosmetic.badge.host?.url || ''
      // 7TV returns protocol-relative URLs (//cdn.7tv.app/...) — promote to https
      // before validation so safeUrl doesn't drop them.
      const absBase = base.startsWith('//') ? `https:${base}` : base
      const rawUrl = (absBase.endsWith('/') ? absBase : `${absBase}/`) + file.name
      const url = safeUrl(rawUrl)
      if (url) {
        // Class includes hs-mc-7tv-badge so updateCosmeticsInPlace's dedup
        // selector finds it and doesn't insert a duplicate when the async
        // cosmetic fetch resolves after the inline render.
        html += `<img class="hs-mc-badge-img hs-mc-7tv-badge" src="${escapeHtml(safeUrl(url) || '')}" alt="7TV" title="${escapeHtml(cosmetic.badge.tooltip || '7TV')}" decoding="async" width="18" height="18" style="width:18px;height:18px;">`
      }
    }
  }
  return html
}

// ═══ Followage Lookup ═══

const _followageCache = new Map() // "user:channel" → { result, ts }
const FOLLOWAGE_CACHE_TTL = 300000 // 5min

async function lookupFollowage(username, channelLogin) {
  if (!username || !channelLogin) return null
  if (username.toLowerCase() === channelLogin.toLowerCase()) return null
  const key = `${username.toLowerCase()}:${channelLogin.toLowerCase()}`
  const cached = _followageCache.get(key)
  if (cached && Date.now() - cached.ts < FOLLOWAGE_CACHE_TTL) return cached.result

  try {
    // Try server-side API first (works everywhere, including multichat on heatsync.org)
    const resp =
      typeof apiFetch === 'function'
        ? await apiFetch(
            `/api/twitch/followage?user=${encodeURIComponent(username)}&channel=${encodeURIComponent(channelLogin)}`,
          )
        : null
    // degraded=true means twitch integrity-gated the follow field for the
    // server's IP — its nulls are "couldn't see", not "not following". Fall
    // through to the in-browser GQL proxy, which rides the user's own
    // session integrity and still resolves.
    if (resp?.ok && resp.data && !resp.data.degraded) {
      const d = resp.data
      const result = {
        followedAt: d.followedAt || null,
        followerCount: d.followerCount ?? null,
        channelFollowedAt: d.channelFollowedAt || null,
      }
      _followageCache.set(key, { result, ts: Date.now() })
      if (_followageCache.size > 500) {
        _followageCache.delete(_followageCache.keys().next().value)
      }
      return result
    }

    // Fallback: direct GQL proxy (works on Twitch tabs with MAIN world script)
    const safeUser = username.replace(/[^a-z0-9_]/gi, '')
    const safeChan = channelLogin.replace(/[^a-z0-9_]/gi, '')
    const data = await gqlProxy(null, null, {
      rawQuery: `{ user(login: "${safeUser}") { follow(targetLogin: "${safeChan}") { followedAt } followers { totalCount } } channel: user(login: "${safeChan}") { follow(targetLogin: "${safeUser}") { followedAt } } }`,
    })
    const user = data?.data?.user
    const result = {
      followedAt: user?.follow?.followedAt || null,
      followerCount: user?.followers?.totalCount ?? null,
      channelFollowedAt: data?.data?.channel?.follow?.followedAt || null,
    }
    _followageCache.set(key, { result, ts: Date.now() })
    if (_followageCache.size > 500) {
      _followageCache.delete(_followageCache.keys().next().value)
    }
    return result
  } catch {
    return null
  }
}

// ═══ Mod actions (ban/unban/timeout/delete) ═══
// Twitch deprecated /ban /unban /timeout /clear /delete and most mod chat commands
// via IRC PRIVMSG in Feb 2023; sending them as text now silently no-ops. We route
// via the existing apolloMutate → gqlMutation fallback chain (same pattern as
// predictionMutation), so the user's normal Twitch session integrity covers it.
// Mutation names (Chat_BanUserFromChatRoom etc.) are the long-standing ones used
// by Twitch's own web client and reflected in FFZ/Chatterino integrations.

const _twChannelIdCache = new Map() // login(lc) → { id, ts }

// Returns { id, transient }. `id` is the numeric channel id or null; `transient`
// is true when null means "couldn't reach Twitch" (GQL/relay threw, or the hard
// ceiling fired) rather than "no such channel". Mod actions MUST split these —
// telling a mod "channel not found" on a 4s network blip stops them acting on a
// channel that plainly exists (the /dm-resolve bug's twin, one layer over).
async function resolveTwitchChannelIdEx(channelLogin) {
  return Promise.race([
    _resolveTwitchChannelIdInner(channelLogin),
    // Hard ceiling: the second fallback below is a raw chrome.runtime.sendMessage
    // (no built-in timeout) — if the background SW's handler exists but never
    // calls sendResponse, this hangs forever and blocks every mod command that
    // needs a channel id (2026-07-20 live incident: /announce read as "Enter
    // does nothing" with zero feedback because this never resolved). A ceiling
    // hit is transient by definition — the resolve never completed.
    new Promise((resolve) => setTimeout(() => resolve({ id: null, transient: true }), 6000)),
  ])
}

// Back-compat: value consumers that only want the id string (or null).
async function resolveTwitchChannelId(channelLogin) {
  return (await resolveTwitchChannelIdEx(channelLogin)).id
}

async function _resolveTwitchChannelIdInner(channelLogin) {
  const lc = (channelLogin || '')
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/[^a-z0-9_]/g, '')
  if (!lc) return { id: null, transient: false } // empty/garbage login — not a lookup that can succeed
  const cached = _twChannelIdCache.get(lc)
  if (cached && Date.now() - cached.ts < 3600000) return { id: cached.id, transient: false }
  // Bound the cache — every distinct channel modded in a session adds an entry;
  // without a cap it grows unbounded over a long-lived tab. Evict oldest-inserted.
  const _cacheChannelId = (id) => {
    if (_twChannelIdCache.size >= 200) {
      const oldest = _twChannelIdCache.keys().next().value
      if (oldest !== undefined) _twChannelIdCache.delete(oldest)
    }
    _twChannelIdCache.set(lc, { id, ts: Date.now() })
  }
  // First-party first: Twitch GQL (relayed through a twitch.tv tab when
  // off-Twitch). heatsync.org/api/resolve is our own first-party fallback for
  // the rare case GQL is unreachable — no third-party call in this path.
  let transient = false
  let sawCleanNull = false
  try {
    const data = await gqlProxy(null, null, { rawQuery: `{ user(login: "${lc}") { id } }` })
    const id = data?.data?.user?.id || (Array.isArray(data) ? data[0]?.data?.user?.id : null)
    if (id) {
      _cacheChannelId(id)
      return { id, transient: false }
    }
    // GQL answered with no user → a real "no such login". Still try the relay,
    // but remember this was a definitive miss, not a network fault.
    sawCleanNull = true
  } catch (_) {
    transient = true // proxy timeout / integrity / abort — we never got an answer
  }
  try {
    // Relay via the background SW — a direct heatsync.org fetch from this
    // ISOLATED content-script context gets 503'd by the CF edge bot-check
    // (the origin never sees it), so the fallback would always dead-end.
    const resp = await chrome.runtime.sendMessage({ type: 'resolve_twitch_id', login: lc })
    const id = resp?.id
    if (id && /^\d+$/.test(String(id))) {
      _cacheChannelId(String(id))
      return { id: String(id), transient: false }
    }
    // Relay came back empty. If GQL also gave a clean null, both sources agree
    // the login doesn't exist → definitive. Otherwise (GQL threw, relay empty)
    // we still never got a real answer → transient.
  } catch (_) {
    transient = true
  }
  return { id: null, transient: transient && !sawCleanNull }
}

// Server kill-switch — refuses every mod mutation when the 'mutations' feature
// is flagged. Used when a regression in our ban/timeout pipeline is shipping
// false-positive actions; flip the server flag, no extension update needed.
function _isMutationsKilled() {
  try {
    const h = (typeof window !== 'undefined' && window.__hsHealth) || null
    return !!(h && (h.kill || (Array.isArray(h.disabled) && h.disabled.includes('mutations'))))
  } catch {
    return false
  }
}

async function _modActionMutationInner(searchTerm, resultField, rawQuery, variables) {
  if (_isMutationsKilled()) return { error: 'mod actions disabled by server' }
  // Off-Twitch (Kick/YouTube pages): relay through a twitch.tv tab — Apollo +
  // Client-Integrity only exist in Twitch's page context. The relay runs this
  // same function inside the Twitch tab and returns the result.
  if (!_isOnTwitchPage()) {
    const resp = await safeSendMessage({
      type: 'twitch_relay',
      op: 'mod_action',
      args: { searchTerm, resultField, rawQuery, variables },
    })
    if (resp?.ok && resp.result) return resp.result
    if (resp?.error === 'no_twitch_tab') return { error: 'open a twitch.tv tab to use mod actions' }
    if (resp?.error === 'stale_twitch_tab') return { error: 'refresh your twitch.tv tab (extension was updated)' }
    return { error: resp?.error || 'relay failed' }
  }
  const apolloResult = await apolloMutate({ searchTerm, variables, resultField, rawQuery })
  if (apolloResult.ok) return { ok: true }
  try {
    // Prefer the persisted-hash path when we have one (VIP/unVIP, etc.) — raw
    // queries are dead for mutations, so gqlMutation(rawQuery) only works for
    // the ops whose Document Apollo already found. gqlPersistedMutation returns
    // the same {data,errors} shape, so the parsing below is unchanged.
    const data = TWITCH_HASHES[searchTerm]
      ? await gqlPersistedMutation(searchTerm, variables)
      : await gqlMutation(rawQuery, variables)
    if (data?.errors?.length) return { error: data.errors[0].message || `${resultField} failed` }
    const err = data?.data?.[resultField]?.error
    // error is a {code} object for most mod mutations, but a bare enum for
    // some (SendAnnouncementMessageError) — handle both shapes.
    if (err) return { error: (typeof err === 'string' ? err : err.code) || `${resultField} failed` }
    return { ok: true }
  } catch (e) {
    return { error: apolloResult.error || e.message }
  }
}

// Hard ceiling on top of the inner fallback chain's own timeouts (apolloMutate
// 8s → gqlMutation's direct-fetch 8s → its gqlProxy fallback 4s = 20s
// theoretical worst case, and that's assuming every layer's OWN timeout fires
// cleanly). 2026-07-20: every mod command (ban/timeout/unban/delete/nuke/
// announce) shares this function, and a live hang here reads to the user as
// "Enter does nothing" with zero feedback — no toast, no clear, no error —
// because nothing upstream ever gets a value to act on. This is the
// bulletproof backstop: no mod action can silently hang past 12s again,
// whatever the inner cause turns out to be.
function _modActionMutation(searchTerm, resultField, rawQuery, variables) {
  return Promise.race([
    _modActionMutationInner(searchTerm, resultField, rawQuery, variables),
    new Promise((resolve) => setTimeout(() => resolve({ error: 'mod action timed out — try again' }), 12000)),
  ])
}

// VIP / unVIP a user. Op names + input shapes captured live from twitch's Roles
// Manager (VIPUser {channelID, granteeLogin}; UnVIPUser {channelID,
// revokeeLogin}); persisted hashes seeded in TWITCH_HASHES. Broadcaster-only —
// twitch gates it server-side; we surface the error. Rides the same
// _modActionMutation path as ban/timeout (Apollo+integrity → persisted-hash
// fallback → off-twitch relay → 12s timeout).
async function vipTwitchUser(channelId, login, add) {
  if (!channelId || !login) return { error: 'missing channel or user' }
  const op = add ? 'VIPUser' : 'UnVIPUser'
  const resultField = add ? 'vipUser' : 'unvipUser'
  const input = add ? { channelID: channelId, granteeLogin: login } : { channelID: channelId, revokeeLogin: login }
  const rawQuery = `mutation ${op}($input: ${op}Input!) { ${resultField}(input: $input) { error { code } } }`
  return _modActionMutation(op, resultField, rawQuery, { input })
}

// mod / unmod a user. Op names + shapes captured live from twitch's Roles
// Manager (ModUser / UnmodUser, both input {channelID, targetLogin}); persisted
// hashes in TWITCH_HASHES. Broadcaster-only — rides the same _modActionMutation
// path as vip/ban/timeout.
async function modTwitchUser(channelId, login, add) {
  if (!channelId || !login) return { error: 'missing channel or user' }
  const op = add ? 'ModUser' : 'UnmodUser'
  const resultField = add ? 'modUser' : 'unmodUser'
  const input = { channelID: channelId, targetLogin: login }
  const rawQuery = `mutation ${op}($input: ${op}Input!) { ${resultField}(input: $input) { error { code } } }`
  return _modActionMutation(op, resultField, rawQuery, { input })
}

// Twitch-tab-only: respond to relay requests from off-Twitch pages.
// Runs ban/timeout/delete/follow locally (has integrity), returns the result.
if (_isOnTwitchPage() && typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== 'twitch_relay_exec') return false
    ;(async () => {
      try {
        if (msg.op === 'mod_action') {
          const { searchTerm, resultField, rawQuery, variables } = msg.args || {}
          const result = await _modActionMutation(searchTerm, resultField, rawQuery, variables)
          sendResponse({ ok: true, result })
        } else if (msg.op === 'follow_action') {
          const { targetID, follow, disableNotifications } = msg.args || {}
          const result = await _followMutation(targetID, follow, disableNotifications)
          sendResponse({ ok: true, result })
        } else {
          sendResponse({ ok: false, error: 'unknown op' })
        }
      } catch (e) {
        sendResponse({ ok: false, error: e.message })
      }
    })()
    return true
  })
}

// Twitch follow / unfollow mutation. On a twitch.tv page, fires the persisted
// query through the MAIN-world GQL proxy (handles auth + integrity + hash
// rotation). Off-twitch, relays through a twitch.tv tab — the MAIN world
// only exists on twitch.tv so a relay is mandatory. No-tab → queueable.
//
// IMPORTANT: must call gqlProxy with operationName + variables ONLY (no
// rawQuery). The MAIN-world handler explicitly rejects rawQuery messages for
// security; it serves persisted queries via gql.hashes lookup. The
// FollowButton_FollowUser / FollowButton_UnfollowUser hashes are seeded in
// early-inject-main.js and auto-updated from page traffic.
//
// Idempotency: TARGET_ALREADY_FOLLOWED / TARGET_NOT_FOLLOWED treated as
// success so heatsync→twitch state stays consistent across retries.
async function _followMutation(targetID, follow, disableNotifications) {
  if (!targetID) return { error: 'no target id' }
  const operationName = follow ? 'FollowButton_FollowUser' : 'FollowButton_UnfollowUser'
  const resultField = follow ? 'followUser' : 'unfollowUser'
  const variables = follow
    ? { input: { targetID: String(targetID), disableNotifications: !!disableNotifications } }
    : { input: { targetID: String(targetID) } }

  if (!_isOnTwitchPage()) {
    const resp = await safeSendMessage({
      type: 'twitch_relay',
      op: 'follow_action',
      args: { targetID, follow, disableNotifications },
    })
    if (resp?.ok && resp.result) return resp.result
    if (resp?.error === 'no_twitch_tab') return { error: 'no_twitch_tab', queueable: true }
    if (resp?.error === 'stale_twitch_tab')
      return { error: 'stale_twitch_tab', queueable: true, reloaded: !!resp.reloaded }
    return { error: resp?.error || 'relay failed', queueable: true }
  }

  // On Twitch: use Twitch's OWN Apollo client (MAIN-world apolloMutate path).
  // Direct gql.twitch.tv POSTs — even with freshly-minted integrity JWT —
  // get rejected as "failed integrity check" because the token only validates
  // when attached via Apollo's link chain (which handles fingerprinting,
  // session-id correlation, etc.). apolloMutate finds the GQL Document from
  // Twitch's webpack modules and calls apolloClient.mutate, identical to
  // what Twitch's own follow button does. No rawQuery — MAIN-world security
  // gate rejects rawQuery messages, and the Document is loaded from webpack
  // instead. searchTerm matches the FollowUser/UnfollowUser allowlist entry.
  const apolloResult = await apolloMutate({ searchTerm: operationName, variables, resultField })
  if (apolloResult?.ok) return { ok: true }
  if (apolloResult?.error) {
    const eMsg = String(apolloResult.error).toLowerCase()
    if (
      eMsg.includes('already') ||
      eMsg.includes('not following') ||
      eMsg.includes('not_followed') ||
      eMsg.includes('already_followed')
    ) {
      return { ok: true, idempotent: true }
    }
    if (eMsg.includes('two_factor') || eMsg === '2fa_required') return { error: '2fa_required' }
    // Fall through to gqlProxy as last-ditch on apollo failure
  }

  // Last-resort fallback: direct gqlProxy persisted query. Rarely works when
  // Apollo path didn't (integrity tokens generally don't validate raw), but
  // try before queueing in case of transient Apollo lookup issues.
  try {
    const data = await gqlProxy(operationName, variables)
    const d = Array.isArray(data) ? data[0] : data
    if (d?.errors?.length) {
      const msg = String(d.errors[0].message || '').toLowerCase()
      if (msg.includes('already') || msg.includes('not followed') || msg.includes('not following')) {
        return { ok: true, idempotent: true }
      }
      return { error: d.errors[0].message || `${resultField} failed` }
    }
    const err = d?.data?.[resultField]?.error
    if (err) {
      const code = String(err.code || '')
      if (code === 'TARGET_ALREADY_FOLLOWED' || code === 'TARGET_NOT_FOLLOWED') return { ok: true, idempotent: true }
      if (code === 'TARGET_TWO_FACTOR_REQUIRED') return { error: '2fa_required' }
      return { error: code || `${resultField} failed` }
    }
    return { ok: true }
  } catch (e) {
    const msg = String(e?.message || '').toLowerCase()
    if (msg.includes('no hash') || msg.includes('hash not available')) {
      return { error: 'twitch_hash_stale', queueable: true }
    }
    if (msg.includes('timeout')) return { error: 'twitch_gql_timeout', queueable: true }
    return { error: e?.message || 'twitch follow failed', queueable: true }
  }
}

async function followTwitchUserById(targetID, follow = true, disableNotifications = false) {
  return _followMutation(targetID, follow, disableNotifications)
}

async function banTwitchUser(channelLogin, targetLogin, reason) {
  const { id: channelID, transient } = await resolveTwitchChannelIdEx(channelLogin)
  if (!channelID) return { error: transient ? 'twitch unreachable — try again' : 'channel not found', transient }
  const bannedUserLogin = (targetLogin || '').toLowerCase().replace(/^@/, '')
  if (!bannedUserLogin) return { error: 'no target user' }
  return _modActionMutation(
    'Chat_BanUserFromChatRoom',
    'banUserFromChatRoom',
    'mutation($input: BanUserFromChatRoomInput!) { banUserFromChatRoom(input: $input) { error { code } } }',
    { input: { channelID, bannedUserLogin, expiresIn: null, reason: reason || '' } },
  )
}

async function timeoutTwitchUser(channelLogin, targetLogin, durationSec, reason) {
  const { id: channelID, transient } = await resolveTwitchChannelIdEx(channelLogin)
  if (!channelID) return { error: transient ? 'twitch unreachable — try again' : 'channel not found', transient }
  const bannedUserLogin = (targetLogin || '').toLowerCase().replace(/^@/, '')
  if (!bannedUserLogin) return { error: 'no target user' }
  return _modActionMutation(
    'Chat_BanUserFromChatRoom',
    'banUserFromChatRoom',
    'mutation($input: BanUserFromChatRoomInput!) { banUserFromChatRoom(input: $input) { error { code } } }',
    { input: { channelID, bannedUserLogin, expiresIn: Math.max(1, durationSec | 0), reason: reason || '' } },
  )
}

async function unbanTwitchUser(channelLogin, targetLogin) {
  const { id: channelID, transient } = await resolveTwitchChannelIdEx(channelLogin)
  if (!channelID) return { error: transient ? 'twitch unreachable — try again' : 'channel not found', transient }
  const bannedUserLogin = (targetLogin || '').toLowerCase().replace(/^@/, '')
  if (!bannedUserLogin) return { error: 'no target user' }
  return _modActionMutation(
    'Chat_UnbanUserFromChatRoom',
    'unbanUserFromChatRoom',
    'mutation($input: UnbanUserFromChatRoomInput!) { unbanUserFromChatRoom(input: $input) { error { code } } }',
    { input: { channelID, bannedUserLogin } },
  )
}

// /announce — GQL mutation (same op the twitch web client fires). Announcement
// echoes back as USERNOTICE msg-id=announcement, so no local synth needed.
// color: PRIMARY | BLUE | GREEN | ORANGE | PURPLE.
async function announceTwitchChat(channelLogin, message, color) {
  const { id: channelID, transient } = await resolveTwitchChannelIdEx(channelLogin)
  if (!channelID) return { error: transient ? 'twitch unreachable — try again' : 'channel not found', transient }
  const text = (message || '').trim()
  if (!text) return { error: 'no message' }
  return _modActionMutation(
    'SendAnnouncementMessage',
    'sendAnnouncementMessage',
    // SendAnnouncementMessageError is a bare enum, unlike the {code} object
    // shape every other mod mutation's error type uses — confirmed live via
    // the GQL server's own schema-validation error (2026-07-20).
    'mutation($input: SendAnnouncementMessageInput!) { sendAnnouncementMessage(input: $input) { error } }',
    { input: { channelID, message: text, color: color || 'PRIMARY' } },
  )
}

async function deleteTwitchMessage(channelLogin, messageID) {
  const { id: channelID, transient } = await resolveTwitchChannelIdEx(channelLogin)
  if (!channelID) return { error: transient ? 'twitch unreachable — try again' : 'channel not found', transient }
  if (!messageID) return { error: 'no message id' }
  return _modActionMutation(
    'Chat_DeleteChatMessage',
    'deleteChatMessage',
    'mutation($input: DeleteChatMessageInput!) { deleteChatMessage(input: $input) { error { code } } }',
    { input: { channelID, messageID } },
  )
}
