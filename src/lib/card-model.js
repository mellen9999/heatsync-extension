/**
 * card-model.js — the one user-card data model, shared by every surface on
 * both the site and the extension.
 *
 * Pure: no DOM, no `fetch`, no imports. `hsCardModel` takes whatever
 * `POST /api/card` (or a page's own richer profile fetch) returned, plus a
 * small `ctx` describing the viewer/session and a `deps` bag of the one host
 * dependency this file actually needs (a compact-number formatter — colors,
 * escaping and HTML hooks all live in card-render.js instead, since this
 * file never touches HTML). Every other host dependency (escapeHtml, paint/
 * badge HTML, sanitizer, DOM) is deliberately kept OUT of this file so it can
 * be mirrored byte-for-byte into the extension's non-ESM bundle.
 *
 * Replaces, in one pass:
 *  - 5 divergent "which platform/login is this card about" rules
 *    (hover-previews.js ~1423/~1605, profile-renderer.js's banner chain,
 *    utils/profile-route.js's resolveProfileRoute inlined at 2 more call
 *    sites) → `hsCardPickIdentity`, one rule.
 *  - the "not following" vs "unknown" bug: a degraded/absent followage
 *    result renders NOTHING, never a guessed "not following <channel>".
 *  - the flair-never-on-first-open bug: flair is read straight off the
 *    payload (server now includes it), not a separate client cache that
 *    misses on first paint.
 *  - `result.followerCount` read with no null guard.
 *
 * @module card/card-model
 */

// Mirrors client/config/colors.js HEAT_THRESHOLDS. Duplicated on purpose —
// importing that module would pull a host dependency into a leaf that has to
// mirror byte-for-byte into the extension bundle. Keep these two lists in
// sync if the heat ladder ever changes.
const HEAT_TIERS = [
  { min: 5000, tone: 'mythic' },
  { min: 1000, tone: 'erupting' },
  { min: 250, tone: 'hot' },
  { min: 50, tone: 'warm' },
  { min: 10, tone: 'spark' },
  { min: 1, tone: 'cold' },
]

function heatTone(heat) {
  if (!heat || heat <= 0) return null
  for (const t of HEAT_TIERS) if (heat >= t.min) return t.tone
  return null
}

/**
 * The one "which platform + login is this card about" rule.
 * @param {object|null} profile a /api/profile-shaped object, or null (chatter/shadow)
 * @param {{platform?: string|null, login?: string|null}} [hint] the surface's
 *   best guess — a chat row's data-platform/data-username, a slash-command
 *   argument, a click target's stamped attrs. Wins when the profile actually
 *   carries that identity; otherwise it's the literal fallback for a chatter
 *   with no heatsync account at all.
 * @returns {{platform: string|null, login: string|null}}
 */
export function hsCardPickIdentity(profile, hint = {}) {
  const displayId = profile?.display_identity || {}
  const loginFor = (p) => {
    if (p === 'twitch') return displayId.twitch || profile?.twitch_username || null
    if (p === 'kick') return displayId.kick || profile?.kick_username || null
    if (p === 'youtube') return displayId.youtube || profile?.youtube_username || null
    return null
  }
  if (hint.platform) {
    const l = loginFor(hint.platform)
    if (l) return { platform: hint.platform, login: l }
  }
  for (const p of ['twitch', 'kick', 'youtube']) {
    const l = loginFor(p)
    if (l) return { platform: p, login: l }
  }
  if (profile?.username) return { platform: profile.platform || 'twitch', login: profile.username }
  if (hint.platform && hint.login) return { platform: hint.platform, login: hint.login }
  if (hint.login) return { platform: 'twitch', login: hint.login }
  return { platform: null, login: null }
}

const later = (a, b) => {
  const ta = a ? new Date(a).getTime() : NaN
  const tb = b ? new Date(b).getTime() : NaN
  if (!Number.isFinite(ta)) return Number.isFinite(tb) ? b : null
  if (!Number.isFinite(tb)) return a
  return ta > tb ? a : b
}

const ACTION_DEFS = [
  { key: 'follow', hotkey: 'f' },
  { key: 'whisper', hotkey: 'w' },
  { key: 'dm', hotkey: 'd' },
  { key: 'mention', hotkey: '@' },
  { key: 'mute', hotkey: 'm' },
  { key: 'block', hotkey: 'b' },
  { key: 'report', hotkey: 'r' },
]

/**
 * Build the normalized card model.
 * @param {object} payload `POST /api/card`'s `{profile, followage, corpus,
 *   note, recent}` — any key may be absent/null (page variant callers, who
 *   fetch a richer `profile` up front and skip the rest, pass only that).
 * @param {object} [ctx]
 * @param {string|null} [ctx.viewerId] the signed-in viewer's own user id
 * @param {string|null} [ctx.channel] the channel the card was opened from,
 *   for scoping corpus "also in" + naming channel-follow/sub rows
 * @param {number|null} [ctx.chSubMonths] local IRC sub-tenure for `channel`
 *   (host-only data — never comes from the server)
 * @param {{platform?: string, login?: string}} [ctx.hint] identity hint —
 *   the surface's data-platform/data-username, or a slash-command argument
 * @param {boolean} [ctx.liveHint] force platforms[twitch].live true (a
 *   went-live notif's own platform can lag the profile snapshot by minutes)
 * @param {Record<string, boolean>} [ctx.capabilities] which actions this
 *   host can perform (site: follow/report/block; ext adds whisper/dm/mute/…)
 * @param {{formatCompactNumber: (n: number) => string}} deps
 * @returns {object} the card model — see module doc for shape
 */
export function hsCardModel(payload = {}, ctx = {}, deps) {
  const fmt = deps.formatCompactNumber
  const profile = payload.profile || null
  const capabilities = ctx.capabilities || {}

  // ---- identity / kind ---------------------------------------------------
  const hint = ctx.hint || {}
  if (!profile) {
    if (hint.platform && hint.login) {
      return {
        kind: 'chatter',
        identity: { platform: hint.platform, login: hint.login, userId: null, isAnonymous: false },
        displayName: hint.login,
        isOwnProfile: false,
        corpus: buildCorpusRow(payload.corpus, ctx, fmt),
        links: { chatterUrl: `/chatter/${encodeURIComponent(hint.platform)}/${encodeURIComponent(hint.login)}` },
        actions: [],
        sheet: [], platforms: [], channel: null, note: null, recent: null, topEmotes: null,
      }
    }
    return { kind: 'not-found', identity: { platform: null, login: null, userId: null, isAnonymous: false }, sheet: [], platforms: [], actions: [] }
  }

  const isAnonymous = !!profile.is_anonymous
  const identity = { ...hsCardPickIdentity(profile, hint), userId: profile.id ?? profile.userId ?? null, isAnonymous }
  const isOwnProfile = !isAnonymous && ctx.viewerId != null && String(identity.userId) === String(ctx.viewerId)

  // ---- platforms / links row ---------------------------------------------
  const displayId = profile.display_identity || {}
  const liveStatus = profile.live_status || {}
  const platforms = []
  const twitchLogin = displayId.twitch || profile.twitch_username
  if (twitchLogin) {
    platforms.push({
      key: 'ttv', hotkey: 't', login: twitchLogin,
      live: !!(ctx.liveHint || profile.twitch_is_live || liveStatus.twitch),
      viewers: profile.twitch_viewer_count || null,
      verified: !!profile.twitch_verified,
      url: `https://twitch.tv/${encodeURIComponent(twitchLogin)}`,
    })
  }
  const kickLogin = displayId.kick || profile.kick_username
  if (kickLogin) {
    platforms.push({
      key: 'kick', hotkey: 'k', login: kickLogin,
      live: !!(profile.kick_is_live || liveStatus.kick),
      viewers: profile.kick_viewer_count || null,
      verified: !!profile.kick_verified,
      url: `https://kick.com/${encodeURIComponent(kickLogin)}`,
    })
  }
  const ytLogin = displayId.youtube || profile.youtube_username
  if (ytLogin) {
    platforms.push({
      key: 'yt', hotkey: 'y', login: ytLogin,
      live: !!(liveStatus.youtube ?? false),
      viewers: null, verified: false,
      url: `https://youtube.com/${encodeURIComponent(ytLogin)}`,
    })
  }
  if (!isAnonymous && profile.username) {
    platforms.push({ key: 'hs', hotkey: 'h', login: profile.username, live: false, viewers: null, verified: false, url: `/u/${encodeURIComponent(profile.username)}` })
  }

  // ---- sheet rows ----------------------------------------------------------
  const sheet = []
  const row = (k, label, value, tone) => { if (value != null && value !== '') sheet.push({ k, label, value, tone: tone || '' }) }

  const dates = [profile.twitch_created_at, profile.kick_created_at].filter(Boolean)
  const oldest = dates.length ? dates.reduce((a, b) => (new Date(b) < new Date(a) ? b : a)) : null
  row('acctage', 'age', oldest, 'age') // value is the raw date; render formats it

  const broadcaster = profile.twitch_broadcaster_type
  if (broadcaster === 'partner') row('type', 'type', 'partner', 'partner')
  else if (broadcaster === 'affiliate') row('type', 'type', 'affiliate', 'affiliate')
  else if (profile.role === 'admin') row('type', 'type', 'admin', 'admin')
  else if (profile.role === 'staff') row('type', 'type', 'staff', 'staff')

  const heat = profile.stats?.user_heat || 0
  const peakHeat = profile.stats?.total_heat || 0
  if (heat > 0 && !isOwnProfile) row('heat', 'heat', fmt(heat), `heat-${heatTone(heat)}`)
  if (peakHeat > 0 && !isOwnProfile) row('peak', 'peak', fmt(peakHeat), 'peak')

  const opCount = profile.stats?.op_count || profile.opCount || 0
  const reCount = profile.stats?.re_count || profile.reCount || 0
  const mopCount = profile.stats?.mop_count || profile.mopCount || 0
  const posts = opCount + mopCount + reCount
  if (posts > 0) row('posts', 'posts', fmt(posts), '')

  const followersCount = Math.max(profile.stats?.followers || 0, profile.twitch_followers || 0, profile.kick_followers || 0)
  if (followersCount > 0) row('followers', 'followers', fmt(followersCount), 'followers')
  const followingCount = Math.max(profile.stats?.following || 0, profile.twitch_following_count || 0, profile.kick_following_count || 0)
  if (followingCount > 0) row('following', 'following', fmt(followingCount), '')

  // relationship — space-joined, no dots (settled)
  const rel = profile.relationship
  if (rel) {
    const followsYou = rel.followsYou || rel.profileFollowsViewerOnTwitch
    const followsYouSince = rel.followsYouSince || rel.profileFollowsViewerOnTwitchSince
    const subsToYou = rel.subscribesToYou || rel.profileSubbedToViewerOnTwitch
    const subsToYouSince = rel.subscribesToYouSince || rel.profileTwitchSubSince
    const subsToYouTier = rel.subscribesToYouTier || rel.profileTwitchSubTier
    const youFollow = rel.isFollowing || rel.followsOnTwitch || rel.followsOnKick
    const youFollowSince = rel.followedAt || rel.followsOnTwitchSince || rel.followsOnKickSince
    const youSub = rel.isSubscribed || rel.subscribedOnTwitch
    const youSubTier = rel.subTier || rel.twitchSubTier
    const youSubSince = rel.subscribedAt || rel.twitchSubSince

    if (followsYou && youFollow) row('rel-follow', 'rel', { text: 'mutual', since: later(followsYouSince, youFollowSince) }, 'mutual')
    else if (youFollow) row('rel-follow', 'you', { text: 'follow', since: youFollowSince }, 'you-follow')
    else if (followsYou) row('rel-follow', 'they', { text: 'follow you', since: followsYouSince }, 'they-follow')

    const tierNum = (t) => (typeof t === 'string' ? Math.round(Number(t) / 1000) : t) || 1
    if (subsToYou && youSub) row('rel-sub', 'rel', { text: 'mutual sub', since: later(subsToYouSince, youSubSince) }, 'mutual-sub')
    else if (youSub) row('rel-sub', 'you', { text: `sub T${tierNum(youSubTier)}`, since: youSubSince }, 'you-sub')
    else if (subsToYou) {
      const t = tierNum(subsToYouTier)
      row('rel-sub', 'they', { text: `sub to you${t > 1 ? ' T' + t : ''}`, since: subsToYouSince }, 'they-sub')
    }
    if (rel.mutuals?.count > 0) row('mutuals', 'mutuals', rel.mutuals, 'mutual')
  }

  // ---- channel section (only when known — never a guess from degraded data)
  let channel = null
  if (ctx.channel) {
    const rows = []
    if (ctx.chSubMonths) rows.push({ k: 'ch-sub', label: 'ch sub', months: ctx.chSubMonths, tone: 'ch' })
    const fa = payload.followage
    if (fa && !fa.degraded) {
      rows.push({ k: 'ch-follow', label: 'ch follow', since: fa.followedAt || null, notFollowing: !fa.followedAt, tone: fa.followedAt ? 'ch' : 'dim' })
      if (fa.channelFollowedAt) rows.push({ k: 'ch-follows-you', label: 'follower', since: fa.channelFollowedAt, tone: 'ch' })
      if (fa.followerCount != null) row('followers-live', 'followers', fmt(fa.followerCount), 'followers')
      if (fa.followingCount != null) row('following-live', 'following', fmt(fa.followingCount), '')
    }
    if (rows.length) channel = { name: ctx.channel, rows }
  }

  const corpusRow = buildCorpusRow(payload.corpus, ctx, fmt)

  // ---- note ------------------------------------------------------------------
  // capabilities.notes is the host's own echo of "authed + not own profile +
  // not anonymous" (the same gate the server used to decide whether to
  // compute `payload.note` at all). `payload.note` is the raw note text (or
  // null — unset or unauthorized are the same answer, on purpose).
  const note = (capabilities.notes && !isOwnProfile && !isAnonymous)
    ? { text: payload.note || '', canEdit: true }
    : null

  // ---- recent logs -----------------------------------------------------------
  const recent = Array.isArray(payload.recent)
    ? payload.recent.map(r => ({
        timestamp: r.timestamp,
        channel: r.channel || null,
        message: r.message || '',
        messageHtml: r.message_html || null,
        permalink: r.permalink || null,
      }))
    : null

  // ---- top emotes ------------------------------------------------------------
  const topEmotes = Array.isArray(profile.top_emotes) && profile.top_emotes.length ? profile.top_emotes : null

  // ---- flair / plus / achievements -------------------------------------------
  const flair = profile.flair ? { badgeUrl: profile.flair.badge_url, broadcasterLogin: profile.flair.broadcaster_login } : null
  const ember = (profile.achievements || []).find(a => a.id === 'ember') || null

  // ---- actions -----------------------------------------------------------------
  const actions = isAnonymous || isOwnProfile ? [] : ACTION_DEFS
    .filter(a => capabilities[a.key])
    .map(a => ({ ...a, blocked: a.key === 'block' ? !!capabilities.isBlocked : undefined, following: a.key === 'follow' ? !!rel?.isFollowing : undefined }))

  return {
    kind: 'profile',
    identity,
    isOwnProfile,
    displayName: profile.display_name || profile.displayName || 'Anonymous',
    color: profile.color || profile.userColor || '#ffffff',
    avatarUrl: profile.twitch_profile_pic || profile.kick_profile_pic || profile.profile_image_url || profile.avatarUrl || '/anon.webp',
    pronouns: profile.pronouns || null,
    plusSince: profile.plus_since || null,
    flair,
    ember: ember ? { name: ember.name } : null,
    bio: profile.bio || '',
    platforms,
    sheet,
    channel,
    corpus: corpusRow,
    note,
    recent,
    topEmotes,
    links: {
      profileUrl: !isAnonymous && profile.username ? `/u/${encodeURIComponent(profile.username)}` : null,
      chatterUrl: identity.platform && identity.login ? `/chatter/${encodeURIComponent(identity.platform)}/${encodeURIComponent(identity.login)}` : null,
      logsUrl: identity.platform && identity.login && identity.login.toLowerCase() !== 'anonymous'
        ? `/${identity.platform}/${encodeURIComponent(identity.login.toLowerCase())}/logs` : null,
    },
    actions,
  }
}

function buildCorpusRow(corpus, ctx, fmt) {
  if (!corpus) return null
  const parts = []
  if (corpus.messages > 0) parts.push(`${fmt(corpus.messages)} msgs`)
  if (corpus.firstDay) parts.push(corpus.firstChannel ? `since ${corpus.firstDay} ${corpus.firstChannel}` : `since ${corpus.firstDay}`)
  const skip = ctx.channel ? String(ctx.channel).toLowerCase() : null
  const also = (corpus.also || []).filter(c => c.toLowerCase() !== skip)
  let alsoText = null
  if (also.length) {
    const shown = also.slice(0, 3).map(c => `#${c}`).join(' ')
    alsoText = also.length > 3 ? `${shown} +${also.length - 3}` : shown
  }
  if (!parts.length && !alsoText) return null
  return { label: 'logs', text: parts.join(' · '), also: alsoText }
}
