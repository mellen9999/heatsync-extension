// Full-panel btop-style profile card
// Triggered by clicking any username anywhere in the extension.
// Replaces #hs-mc-messages content. ESC, tab switch, or close button restores chat.

// module scope resets on re-injection, so a fresh instance re-registers
// after the old one's teardown; window-scope survives takeover and leaves
// handlers dead until hard refresh
const _onceGuardsProfileCard = {}

let activeProfileCard = null // { username, platform, data, ts }

// In-page LRU for fetched banners — survives card open/close within a session.
// Background SW caches authoritatively (12h); this layer just avoids the SW
// round-trip for repeat hovers/opens. Keyed `${platform}:${login}` so the
// same name on different platforms never collides.
const _bannerCache = new Map()
const BANNER_LOCAL_TTL = 10 * 60 * 1000

// Resolve a single platform banner via SW. Returns the banner record or null.
async function fetchChannelBanner(platform, login) {
  if (!platform || !login) return null
  const key = `${platform}:${String(login).toLowerCase()}`
  const hit = _bannerCache.get(key)
  if (hit && Date.now() - hit.ts < BANNER_LOCAL_TTL) return hit.data
  try {
    const data = await safeSendMessage({ type: 'fetch_channel_banner', platform, username: login })
    _bannerCache.set(key, { data: data || null, ts: Date.now() })
    if (_bannerCache.size > 300) _bannerCache.delete(_bannerCache.keys().next().value)
    return data || null
  } catch {
    return null
  }
}

// In-page LRU for fetched pronouns — background SW caches authoritatively
// (24h); this layer just avoids the SW round-trip for repeat hovers/opens.
// Twitch-only: pronoundb.org has no Kick/YouTube platform.
const _pronounCache = new Map()
const PRONOUN_LOCAL_TTL = 10 * 60 * 1000

// Resolve pronouns for a Twitch numeric user id via SW. Returns
// { pronouns: string[] } or null. No-ops (no fetch, no cache write) when the
// pronouns setting is off or the platform isn't twitch.
async function fetchPronouns(platform, userId) {
  if (typeof pronounsEnabled !== 'undefined' && !pronounsEnabled) return null
  if (platform !== 'twitch' || !userId) return null
  const key = `twitch:${userId}`
  const hit = _pronounCache.get(key)
  if (hit && Date.now() - hit.ts < PRONOUN_LOCAL_TTL) return hit.data
  try {
    const data = await safeSendMessage({ type: 'fetch_pronouns', platform: 'twitch', userId })
    _pronounCache.set(key, { data: data || null, ts: Date.now() })
    if (_pronounCache.size > 500) _pronounCache.delete(_pronounCache.keys().next().value)
    return data || null
  } catch {
    return null
  }
}

// Build the platform-preference chain for a profile + context. The context
// platform always wins — a user's identity belongs to the platform you were
// viewing them on. Cross-platform accent inheritance (a kick green ring on
// a twitch user just because they also have a kick account) is wrong: it
// reads as "this person is on kick" when chat says otherwise.
//
// Resolution order:
//   1) Explicit contextPlatform passed by the caller (data-platform on the
//      hovered chat message).
//   2) Hostname inference — multichat overlay runs on twitch.tv / kick.com /
//      youtube.com so the host is a natural fallback when no data-platform
//      attribute is present (mentions in feed posts, etc.).
//   3) Only when neither yields a platform: walk linked accounts on the
//      profile (twitch > kick > youtube).
function pickBannerChain(data, contextPlatform, username) {
  // Hostname fallback when caller didn't pass an explicit platform
  if (!contextPlatform && typeof location !== 'undefined') {
    const h = String(location.hostname || '')
    if (h.includes('twitch.tv')) contextPlatform = 'twitch'
    else if (h.includes('kick.com')) contextPlatform = 'kick'
    else if (h.includes('youtube.com')) contextPlatform = 'youtube'
  }

  const out = []
  const seen = new Set()
  const add = (p, l) => {
    if (!p || !l) return
    const k = `${p}:${String(l).toLowerCase()}`
    if (seen.has(k)) return
    seen.add(k)
    out.push({ platform: p, login: l })
  }

  // Step 1: the context platform — usually the only entry in the chain.
  if (contextPlatform === 'twitch') add('twitch', data?.twitch_username || username)
  else if (contextPlatform === 'kick') add('kick', data?.kick_username || username)
  else if (contextPlatform === 'youtube' || contextPlatform === 'yt') {
    add('youtube', data?.youtube_channel_id || data?.youtube_username || username)
  }

  // Step 2: only if no context resolved anything — walk linked accounts in
  // the profile-data fallback order. Keeps cross-platform users (e.g. a YT
  // chatter mentioned in a heatsync feed post with no platform context) able
  // to show *some* banner instead of nothing.
  if (!out.length) {
    add('twitch', data?.twitch_username)
    add('kick', data?.kick_username)
    add('youtube', data?.youtube_channel_id || data?.youtube_username)
  }

  // Step 3: last-ditch — raw username, guessing platform from shape.
  if (!out.length && username) {
    if (/^uc[a-z0-9_-]{20,}$/i.test(username)) add('youtube', username)
    else add('twitch', username)
  }
  return out
}

// Walk the chain until one platform returns a usable banner. "Usable" = a real
// bannerUrl/offlineUrl; an empty record is treated as continue. Returns the
// first hit or null after the chain exhausts.
async function fetchBannerChain(chain) {
  // Pass 1 — first real banner image wins, any platform in the chain.
  for (const c of chain) {
    const data = await fetchChannelBanner(c.platform, c.login)
    if (data && (data.bannerUrl || data.offlineUrl)) return data
  }
  // Pass 2 — accent-only fallback is restricted to the FIRST chain entry
  // (the context platform when available). This prevents a Kick brand-green
  // accent from leaking onto a Twitch user just because Twitch's GQL call
  // returned no banner image. Cross-platform accent inheritance is wrong:
  // a user's identity color belongs to the platform they were viewed on.
  if (chain.length) {
    const first = chain[0]
    const data = await fetchChannelBanner(first.platform, first.login)
    if (data && (data.accent || data.profileUrl)) return data
  }
  return null
}

// User notes live in user-notes.js (hs_user_notes_v1: alias-aware, shared
// with the native surface). The old profile-card-local hs_user_notes blob is
// migrated into it on first load — see _hsnLoad.

async function openProfileCard(username, platform) {
  // Chokepoint for the profile-cards switch. Gating only the click handlers
  // (setupProfileCardHandlers) left every other opener live — the unified
  // context menu's "view profile" row called straight in here.
  if (gateAtBoot('profile-cards') === false) return
  if (!username) return
  username = String(username).toLowerCase()

  // The reply-thread stack renders as a fixed, max-z-index overlay above
  // everything else — a card opened underneath a lingering stack would be
  // invisible/unclickable behind it. Its dismiss logic lives in a closure
  // private to createOverlay() in main.js; this event is the bridge (same
  // idiom as hs-channels-changed below).
  document.dispatchEvent(new CustomEvent('hs-mc-close-overlays'))

  // Hide input bar — typing makes no sense in card view. Flag must move with
  // the class: a class-only hide leaves inputBarVisible=true, which makes
  // every later showInputBar() early-return — composer unreachable until a
  // full reload ("no way to type").
  const inputBar = document.getElementById('hs-mc-inputbar')
  if (inputBar) inputBar.classList.add('hs-hidden')
  inputBarVisible = false

  // followageRows/followageFetchedFor: filled in by renderProfileCardView's
  // own async lookupFollowage call (see its bottom) — the panel never had
  // followage before; now it's the same ctx.extraSheet mechanism the hover
  // tooltip uses (computeFollowageRows, tooltips.js, same bundle scope).
  activeProfileCard = {
    username,
    platform: platform || null,
    data: null,
    ts: Date.now(),
    followageRows: null,
    followageFetchedFor: null,
  }
  renderProfileCardView()

  // Try cache first (shared with tooltip via _profileCache)
  const cacheKey = `${platform || 'unknown'}:${username}`
  const ttl = typeof PROFILE_CACHE_TTL !== 'undefined' ? PROFILE_CACHE_TTL : 300000
  if (typeof _profileCache !== 'undefined') {
    const cached = _profileCache.get(cacheKey)
    if (cached && Date.now() - cached.ts < ttl) {
      activeProfileCard.data = cached.profile
      renderProfileCardView()
      return
    }
  }

  try {
    const platParam = platform ? `?platform=${encodeURIComponent(platform)}` : ''
    // Fire kick enrichment in parallel for kick-platform users — Kick API is
    // public/CORS-friendly and adds bio + socials + pfp + linked twitch even
    // when the user has no heatsync profile.
    const kickEnrichP = platform === 'kick' ? pcFetchKickEnrich(username).catch(() => null) : Promise.resolve(null)
    const resp = await apiFetch(`/api/profile/${encodeURIComponent(username)}${platParam}`)
    if (!activeProfileCard || activeProfileCard.username !== username) return
    let profile = resp?.ok && resp.data?.profile ? resp.data.profile : null
    // Cross-platform probe — kick chatters often share their handle on twitch;
    // a same-name twitch hit lands a full profile when the kick lookup misses.
    if (!profile && platform === 'kick') {
      const twResp = await apiFetch(`/api/profile/${encodeURIComponent(username)}?platform=twitch`)
      if (!activeProfileCard || activeProfileCard.username !== username) return
      if (twResp?.ok && twResp.data?.profile) profile = twResp.data.profile
    }
    const kickEnrich = await kickEnrichP
    if (!activeProfileCard || activeProfileCard.username !== username) return
    if (profile) {
      if (kickEnrich) pcMergeKickEnrich(profile, kickEnrich)
      activeProfileCard.data = profile
      if (typeof _profileCache !== 'undefined') {
        _profileCache.set(cacheKey, { profile, ts: Date.now() })
      }
    } else if (kickEnrich) {
      // Build a synthetic profile from Kick data so the card has something useful
      // instead of "no profile" — bio, socials, pfp, cross-link to twitch.
      activeProfileCard.data = pcSynthFromKickEnrich(username, kickEnrich)
    } else if (platform === 'youtube' || platform === 'yt') {
      // No enrichment API for YT (BUG 1b) — fall back to a UC id scraped off
      // one of this chatter's own messages, if we've seen one this session.
      const ucId = pcFindYtChannelId(username)
      activeProfileCard.data = ucId ? pcSynthFromYtContext(username, ucId) : { error: true, username }
    } else {
      activeProfileCard.data = { error: true, username }
    }
    renderProfileCardView()
  } catch {
    if (!activeProfileCard) return
    // A THROW is a transport failure (network blip, timeout, 5xx) — not proof
    // the person has no heatsync account. Both used to collapse to the same
    // {error:true}, so a registered user hit by a hiccup was shown the
    // "no profile" card with follow and block greyed out until manual reload.
    activeProfileCard.data = { error: true, transient: true, username }
    renderProfileCardView()
  }
}

// Fetch kick.com/api/v1/users/{name} → bio, twitter, facebook, instagram,
// youtube, discord, tiktok, profilepic. Also captures linked twitch username
// via getKickLinkedTwitch (populated by the 7TV-via-kick cosmetics path).
async function pcFetchKickEnrich(username) {
  if (!username) return null
  const u = String(username).toLowerCase()
  try {
    // Fetch user record + channel record in parallel — most Kick users have
    // both (their channel slug == username). Channel returns follower_count,
    // recent_categories, livestream state. User has bio + socials. Combined
    // gives an S-tier profile-card.
    const [userRes, chanRes] = await Promise.allSettled([
      fetch(`https://kick.com/api/v1/users/${encodeURIComponent(u)}`, { credentials: 'omit' }),
      fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(u)}`, { credentials: 'omit' }),
    ])
    const data =
      userRes.status === 'fulfilled' && userRes.value.ok ? await userRes.value.json().catch(() => null) : null
    const chan =
      chanRes.status === 'fulfilled' && chanRes.value.ok ? await chanRes.value.json().catch(() => null) : null
    if (!data?.id && !chan?.id) return null
    return {
      kick_user_id: data?.id || chan?.user_id || null,
      kick_username: data?.username || chan?.slug || u,
      kick_profile_pic: data?.profilepic || chan?.user?.profile_pic || null,
      kick_bio: data?.bio || chan?.user?.bio || null,
      kick_socials: {
        twitter: data?.twitter || chan?.user?.twitter || null,
        facebook: data?.facebook || chan?.user?.facebook || null,
        instagram: data?.instagram || chan?.user?.instagram || null,
        youtube: data?.youtube || chan?.user?.youtube || null,
        discord: data?.discord || chan?.user?.discord || null,
        tiktok: data?.tiktok || chan?.user?.tiktok || null,
      },
      kick_followers: chan?.followers_count || null,
      kick_is_live: !!chan?.livestream,
      kick_live_viewers: chan?.livestream?.viewer_count || null,
      kick_live_title: chan?.livestream?.session_title || null,
      kick_recent_categories: Array.isArray(chan?.recent_categories)
        ? chan.recent_categories.slice(0, 3).map((c) => ({ name: c.name, slug: c.slug }))
        : null,
      kick_verified: !!chan?.verified,
      linked_twitch_username: typeof getKickLinkedTwitch === 'function' ? getKickLinkedTwitch(u) : null,
    }
  } catch {
    return null
  }
}

function pcMergeKickEnrich(profile, kickEnrich) {
  if (!profile.bio && kickEnrich.kick_bio) profile.bio = kickEnrich.kick_bio
  if (!profile.kick_profile_pic && kickEnrich.kick_profile_pic) profile.kick_profile_pic = kickEnrich.kick_profile_pic
  if (!profile.kick_username && kickEnrich.kick_username) profile.kick_username = kickEnrich.kick_username
  // Merge to canonical Kick fields so the existing stats render picks them up
  if (kickEnrich.kick_followers && !profile.kick_followers) profile.kick_followers = kickEnrich.kick_followers
  if (typeof kickEnrich.kick_is_live === 'boolean' && profile.kick_is_live == null)
    profile.kick_is_live = kickEnrich.kick_is_live
  if (kickEnrich.kick_live_viewers && !profile.kick_viewer_count)
    profile.kick_viewer_count = kickEnrich.kick_live_viewers
  if (kickEnrich.kick_verified && !profile.kick_verified) profile.kick_verified = true
  profile._kick_socials = kickEnrich.kick_socials
  profile._kick_live_title = kickEnrich.kick_live_title
  profile._kick_recent_categories = kickEnrich.kick_recent_categories
  profile._linked_twitch_username = kickEnrich.linked_twitch_username || profile.twitch_username || null
}

function pcSynthFromKickEnrich(username, kickEnrich) {
  return {
    // kick_<id> lets the follow button resolve a profileId even though this
    // chatter has no heatsync account — POST /api/follow/kick_<id> with the
    // ?kickUsername= hint (added in pcToggleFollow) materializes a shadow
    // user server-side. Without this the card had bio/pfp/socials but the
    // follow button stayed permanently disabled (BUG 1a).
    id: kickEnrich.kick_user_id ? `kick_${kickEnrich.kick_user_id}` : null,
    kick_user_id: kickEnrich.kick_user_id || null,
    display_name: kickEnrich.kick_username || username,
    kick_username: kickEnrich.kick_username || username,
    kick_profile_pic: kickEnrich.kick_profile_pic || null,
    bio: kickEnrich.kick_bio || null,
    kick_followers: kickEnrich.kick_followers || null,
    kick_is_live: kickEnrich.kick_is_live,
    kick_viewer_count: kickEnrich.kick_live_viewers || null,
    kick_verified: kickEnrich.kick_verified || false,
    _kick_socials: kickEnrich.kick_socials,
    _kick_live_title: kickEnrich.kick_live_title,
    _kick_recent_categories: kickEnrich.kick_recent_categories,
    _linked_twitch_username: kickEnrich.linked_twitch_username,
    _synth_kick_only: true,
  }
}

// YouTube has no public "resolve username → channel id" API reachable client-
// side (no app-token shortcut like Kick's public API), so the only source of
// a UC channel id for an unregistered YT chatter is one we already saw scrape
// off their own chat message. social.js stamps `hsPaintUid: 'yt_<UCid>'` on
// every YT message with a well-formed author channel id (see the UC regex
// there) and main.js copies it onto the rendered row's `dataset.hsPaintUid` —
// callers with a live DOM row (ctx-menu) should prefer that over this scan.
function pcFindYtChannelId(username) {
  try {
    const recent = getRecentMessagesFromUser(username)
    for (const m of recent) {
      if (m.platform === 'youtube' && typeof m.hsPaintUid === 'string' && m.hsPaintUid.startsWith('yt_')) {
        return m.hsPaintUid.slice(3)
      }
    }
  } catch {}
  return null
}

// Symmetric to pcSynthFromKickEnrich (BUG 1b) — no bio/socials available for
// YT (no enrichment API), but a known UC id is enough to synthesize a
// followable profileId. Server materializes the yt_<UCid> shadow user on
// POST /api/follow — self-verifying scrape, no hint needed (unlike Kick).
function pcSynthFromYtContext(username, ucId) {
  return {
    id: `yt_${ucId}`,
    display_name: username,
    youtube_channel_id: ucId,
    _synth_yt_only: true,
  }
}

// Shared follow-target resolver — BUG 1c. Both the profile-card follow button
// (via openProfileCard's synth paths above) and the right-click follow-from-
// menu path (hsFollowFromMenu in input.js) need to resolve a followable id
// for a chatter with no heatsync profile. Keeping it in one place means a fix
// to one surface can't drift from the other.
//   platform: 'kick' | 'youtube' | 'yt' — anything else returns null.
//   ids.youtubeChannelId: an already-known UC id (e.g. off the clicked
//     message's dataset.hsPaintUid) — skips the buffer scan when present.
async function resolveFollowTargetId(platform, username, ids = {}) {
  if (!username) return null
  const u = String(username).toLowerCase()
  if (platform === 'kick') {
    const enrich = await pcFetchKickEnrich(u).catch(() => null)
    if (enrich?.kick_user_id) return { id: `kick_${enrich.kick_user_id}` }
  } else if (platform === 'youtube' || platform === 'yt') {
    const ucId = ids.youtubeChannelId || pcFindYtChannelId(u)
    if (ucId) return { id: `yt_${ucId}` }
  }
  return null
}

function closeProfileCard() {
  if (!activeProfileCard) return
  activeProfileCard = null
  // switchTab isn't called here, so restore the bar ourselves — through
  // showInputBar, which owns the "may this tab have a composer" call and keeps
  // the visible flag in step. (The local tab list this replaced was a copy
  // that never learned about modlog.)
  showInputBar()
  renderMessages(currentTab)
}

function getRecentMessagesFromUser(username) {
  const lower = username.toLowerCase()
  const out = []
  try {
    if (typeof irc !== 'undefined' && irc?.channels) {
      for (const [, buf] of irc.channels) {
        for (const m of buf.getAll()) {
          if (m.user?.toLowerCase() === lower && m.text) out.push(m)
        }
      }
    }
    if (typeof kickChat !== 'undefined' && kickChat?.channels) {
      for (const [, buf] of kickChat.channels) {
        for (const m of buf.getAll()) {
          if (m.user?.toLowerCase() === lower && m.text) out.push(m)
        }
      }
    }
    if (typeof channelYtMessages !== 'undefined' && channelYtMessages) {
      for (const [, buf] of channelYtMessages) {
        for (const m of buf) {
          if (m.user?.toLowerCase() === lower && m.text) out.push(m)
        }
      }
    }
  } catch {}
  return out.sort((a, b) => (b.time || 0) - (a.time || 0)).slice(0, 12)
}

// Scan the same buffers as getRecentMessagesFromUser and return aggregate
// session stats for this user — total message count, earliest/latest timestamp,
// and the set of distinct channels they appeared in. Read-only, zero API calls.
function getUserSessionStats(username) {
  const lower = username.toLowerCase()
  let count = 0
  let firstTime = null
  let lastTime = null
  const channels = new Set()
  try {
    if (typeof irc !== 'undefined' && irc?.channels) {
      for (const [ch, buf] of irc.channels) {
        for (const m of buf.getAll()) {
          if (m.user?.toLowerCase() !== lower) continue
          count++
          if (m.time) {
            if (firstTime === null || m.time < firstTime) firstTime = m.time
            if (lastTime === null || m.time > lastTime) lastTime = m.time
          }
          if (ch) channels.add(ch)
        }
      }
    }
    if (typeof kickChat !== 'undefined' && kickChat?.channels) {
      for (const [ch, buf] of kickChat.channels) {
        for (const m of buf.getAll()) {
          if (m.user?.toLowerCase() !== lower) continue
          count++
          if (m.time) {
            if (firstTime === null || m.time < firstTime) firstTime = m.time
            if (lastTime === null || m.time > lastTime) lastTime = m.time
          }
          if (ch) channels.add(ch)
        }
      }
    }
    if (typeof channelYtMessages !== 'undefined' && channelYtMessages) {
      for (const [ch, buf] of channelYtMessages) {
        for (const m of buf) {
          if (m.user?.toLowerCase() !== lower) continue
          count++
          if (m.time) {
            if (firstTime === null || m.time < firstTime) firstTime = m.time
            if (lastTime === null || m.time > lastTime) lastTime = m.time
          }
          if (ch) channels.add(ch)
        }
      }
    }
  } catch {}
  return { count, firstTime, lastTime, channels }
}

function pcFmt(n) {
  n = Number(n) || 0
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`
  return String(n)
}

// Bio autolinking now goes through hsExtRenderBio (tooltips.js, same
// concatenated bundle scope) — the one bio autolinker every card surface
// uses, passed as hsCardHtml's renderBio hook below. No DOM-node version
// needed anymore (hsCardHtml wants a trusted HTML string).

function pcMakeSection(title) {
  const sec = document.createElement('div')
  sec.className = 'hs-pcard-section'
  const t = document.createElement('div')
  t.className = 'hs-pcard-section-title'
  t.textContent = title
  sec.appendChild(t)
  return sec
}

// Top-of-card mod actions — left-click username on a chatter in a channel you
// mod surfaces delete/timeout/ban right at the top, replacing the bulky inline
// hover toolbar on every row. Twitch-only (Kick/YT mod GQL not wired) for role
// grants; delete/timeout/ban/unban work on both via dispatchModAction.
//
// Pure data now (ctx.modGroups — see card-model.js's doc) — card-render.js
// renders the reason input + buttons as escaped HTML with data-hs-card-mod-*
// attributes; pcHandleModAction below wires the real behavior via the
// delegated click listener in setupProfileCardHandlers. Returns [] when not
// applicable (own profile, no recent messages, no channel you mod) so
// hsCardModel's `ctx.modGroups.length` check skips the section entirely.
function pcBuildModGroups(username) {
  if (typeof getRecentMessagesFromUser !== 'function' || !username) return []
  // Don't surface mod actions on your own profile — self-mod buttons are nonsense.
  if (
    typeof currentUsername !== 'undefined' &&
    currentUsername &&
    username.toLowerCase() === currentUsername.toLowerCase()
  )
    return []
  const recent = getRecentMessagesFromUser(username)
  if (!recent.length) return []
  // Group by channel+platform — most recent msgId per channel where I'm a mod.
  // Twitch gates on GQL mod-state, Kick on kick_mod_status; the key keeps the
  // two namespaces apart (a twitch login and kick slug can collide).
  const groups = new Map()
  for (const m of recent) {
    const plat = m.platform || 'twitch'
    if (plat !== 'twitch' && plat !== 'kick') continue
    const ch = (m.channel || '').toLowerCase()
    if (!ch) continue
    const amMod =
      plat === 'kick'
        ? typeof isKickModForSync === 'function' && isKickModForSync(ch)
        : typeof isModForSync === 'function' && isModForSync(ch)
    if (!amMod) {
      if (plat === 'kick') {
        if (typeof prefetchKickModFor === 'function') prefetchKickModFor(ch)
      } else if (typeof prefetchModFor === 'function') prefetchModFor(ch)
      continue
    }
    const key = `${plat}:${ch}`
    if (!groups.has(key))
      groups.set(key, {
        channel: ch,
        platform: plat,
        msgId: m.id || null,
        login: (m.login || m.user || '').toLowerCase(),
      })
  }
  if (!groups.size) return []
  const out = []
  for (const { channel, platform, msgId, login } of groups.values()) {
    const target = login || (username || '').toLowerCase()
    const actions = [
      { action: 'delete', label: 'del msg', title: "delete this user's latest message", disabled: !msgId },
      { action: 'timeout', label: '1m', title: 'timeout 1 minute', durationSec: 60 },
      { action: 'timeout', label: '10m', title: 'timeout 10 minutes', durationSec: 600 },
      { action: 'timeout', label: '1h', title: 'timeout 1 hour', durationSec: 3600 },
      { action: 'timeout', label: '24h', title: 'timeout 24 hours', durationSec: 86400 },
      { action: 'timeout', label: '7d', title: 'timeout 7 days', durationSec: 604800 },
      { action: 'ban', label: 'ban', title: 'permanent ban', danger: true },
      { action: 'unban', label: 'unban', title: 'unban user' },
    ]
    // Role grants — mod/unmod/vip/unvip. Separate mutation pair (VIPUser/
    // UnVIPUser, ModUser/UnmodUser in twitch-api.js) from the ban/timeout/
    // delete union dispatchModAction covers above. Twitch only (same
    // restriction as input.js's /mod /vip slash commands this reuses —
    // Kick/YT have no equivalent GQL wired). Twitch itself restricts
    // mod/unmod to the broadcaster; that's enforced server-side and
    // surfaced as a failed toast, same as any other row action — no
    // client-side broadcaster pre-check to keep this in step with
    // whatever Twitch's own rule is.
    const roleActions =
      platform === 'twitch'
        ? [
            { kind: 'mod', add: true, label: 'mod', title: 'grant moderator (broadcaster only)' },
            { kind: 'mod', add: false, label: 'unmod', title: 'remove moderator (broadcaster only)' },
            { kind: 'vip', add: true, label: 'vip', title: 'grant VIP' },
            { kind: 'vip', add: false, label: 'unvip', title: 'remove VIP' },
          ]
        : []
    out.push({ channel, platform, msgId, login: target, actions, roleActions })
  }
  return out
}

// Fires a mod-action or role-grant button click — reads the data-hs-card-mod-*
// attributes card-render.js's renderMod stamped on the button, and the
// optional reason from the same .hs-card-mod section's reason input.
// Optional reason — applied to every ban/timeout fired from this card. Empty
// = none. Click surfaces (right-click/hover) stay reason-free for speed;
// this is the considered surface where a reason makes sense.
async function pcHandleModAction(btn) {
  const ds = btn.dataset
  const channel = ds.hsCardModChannel
  const platform = ds.hsCardModPlatform
  const login = ds.hsCardModLogin
  const msgId = ds.hsCardModMsgId || null

  if (ds.hsCardModRole) {
    const kind = ds.hsCardModRole
    const add = ds.hsCardModAdd === '1'
    if (typeof getTwitchAuthToken !== 'function' || !getTwitchAuthToken()) {
      if (typeof showToast === 'function') showToast(t('mc_input_pp_login') || 'log into twitch.tv first', 'error')
      return
    }
    btn.disabled = true
    const orig = btn.textContent
    btn.textContent = '…'
    let r
    try {
      const { id: channelId } = await resolveTwitchChannelIdEx(channel)
      if (!channelId) throw new Error('could not resolve channel')
      r = kind === 'vip' ? await vipTwitchUser(channelId, login, add) : await modTwitchUser(channelId, login, add)
    } catch (err) {
      r = { error: err?.message || 'error' }
    }
    if (typeof showToast === 'function') {
      showToast(r?.ok ? `${orig}: ${login}` : `${orig} failed: ${r?.error || 'unknown'}`, r?.ok ? 'success' : 'error')
    }
    btn.textContent = orig
    btn.disabled = false
    return
  }

  const action = ds.hsCardModAction
  const durationSec = ds.hsCardModDuration ? Number(ds.hsCardModDuration) : undefined
  const reason = btn.closest('.hs-card-mod')?.querySelector('.hs-card-mod-reason')?.value.trim() || ''
  btn.disabled = true
  const orig = btn.textContent
  btn.textContent = '…'
  let r
  try {
    r = await dispatchModAction({ channel, platform, action, target: login, durationSec, msgId, reason })
  } catch (err) {
    r = { anyOk: false, tResp: { error: err?.message || 'error' } }
  }
  btn.textContent = orig
  if (action === 'delete') {
    if (typeof showToast === 'function') {
      showToast(
        r?.anyOk
          ? t('mc_profile_deleted_message')
          : t('mc_profile_delete_failed', [(r?.tResp || r?.kResp)?.error || t('mc_common_unknown')]),
        r?.anyOk ? 'success' : 'error',
      )
    }
  } else {
    const label =
      action === 'ban'
        ? t('mc_mod_label_banned')
        : action === 'unban'
          ? t('mc_mod_label_unbanned')
          : t('mc_mod_label_timed_out', [String(durationSec)])
    if (typeof showModResultToast === 'function') showModResultToast(label, login, r)
  }
  btn.disabled = action === 'delete' ? !msgId : false
}

// Session stats (local buffers, zero API calls) as ctx.extraSheet rows —
// same shape pcMakeSection's old DOM sheet built, now data hsCardModel folds
// into the one sheet every variant renders.
function pcBuildSessionSheetRows(username) {
  const { count, firstTime, channels } = getUserSessionStats(username)
  if (!count) return []
  const rows = [{ k: 'session-msgs', label: 'session', value: String(count) }]
  if (firstTime) {
    rows.push({
      k: 'session-first',
      label: 'first',
      value: new Date(firstTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    })
  }
  if (channels.size) rows.push({ k: 'session-channels', label: 'channels', value: String(channels.size) })
  return rows
}

// Kick bio socials (from pcFetchKickEnrich/pcMergeKickEnrich's `_kick_socials`)
// as payload.socials-shaped links. Discord has no single canonical URL shape
// (tag vs invite vs username) so it renders as plain text, same as before.
function pcBuildSocials(data) {
  const s = data?._kick_socials
  if (!s) return null
  const out = []
  if (s.twitter) out.push({ label: 'twitter', href: `https://twitter.com/${s.twitter}` })
  if (s.instagram) out.push({ label: 'instagram', href: `https://instagram.com/${s.instagram}` })
  if (s.youtube)
    out.push({ label: 'youtube', href: s.youtube.startsWith('http') ? s.youtube : `https://youtube.com/${s.youtube}` })
  if (s.tiktok) out.push({ label: 'tiktok', href: `https://tiktok.com/@${s.tiktok}` })
  if (s.facebook)
    out.push({
      label: 'facebook',
      href: s.facebook.startsWith('http') ? s.facebook : `https://facebook.com/${s.facebook}`,
    })
  if (s.discord) out.push({ label: `discord: ${s.discord}` })
  return out.length ? out : null
}

// Native chat badges + 7TV/BTTV/FFZ/Chatterino chips for the identity row —
// hsCardHtml's renderBadges hook. Closes over `data`/`username` (not the
// trimmed model card-render.js passes) since the raw twitch_user_id these
// need lives on the profile payload, not the shared model.
function pcRenderBadgesHtml(data, username) {
  try {
    const userId = data?.twitch_user_id || data?.twitch_id || null
    const recent = typeof getRecentMessagesFromUser === 'function' ? getRecentMessagesFromUser(username) : []
    const recentTwitch = recent.find((m) => (m.platform || 'twitch') === 'twitch' && m.badges)
    let html = ''
    if (recentTwitch && typeof renderBadges === 'function')
      html += renderBadges(recentTwitch.badges, recentTwitch.channel)
    if (userId && typeof renderThirdPartyBadges === 'function') html += renderThirdPartyBadges(String(userId))
    return html
  } catch {
    return ''
  }
}

// The full overlay card — the shared card model + renderer, variant 'panel'.
// Ext-only enhancements not on the shared model go through its host hooks
// the same way the hover tooltip (tooltips.js) does: ctx.extraSheet (session
// stats), ctx.modGroups (mod actions), payload.socials (kick bio links),
// opts.renderBadges (native/7TV/BTTV/FFZ chips) — all pure data/string
// builders above. Mute-state labeling and the ext-only "+add channel"
// action (channels/tabs have no site equivalent) are the two things that
// stay small post-render DOM patches, same discipline as the tooltip's
// banner/pronoun patches: real DOM interactivity (notes editing) or purely
// local, ephemeral, host-only state with no shared-model slot to earn.
function renderProfileCardView() {
  const msgsEl = document.getElementById('hs-mc-messages')
  if (!msgsEl || !activeProfileCard) return
  msgsEl.textContent = ''

  const { username, data, platform } = activeProfileCard

  if (!data) {
    const loading = document.createElement('div')
    loading.className = 'hs-pcard-loading' // old CSS, not yet deleted — see the CSS-cleanup TODO
    loading.textContent = `${data?.display_name || username}…`
    msgsEl.appendChild(loading)
    return
  }
  if (data.error) {
    renderProfileCardErrorView(msgsEl, username, data)
    return
  }

  // Normalize relationship field names — the ext's own fetch/synth paths
  // have historically read youFollow/youBlock as primary (with isFollowing/
  // isBlocked as fallback); hsCardModel's actions read isFollowing/isBlocked
  // (the site's own names). Same idea as pcAddAsChannel's shapeIdentity call
  // — adapting host data to the shared contract, never the other way round.
  const rel = data.relationship || {}
  const isFollowing = !!(rel.isFollowing ?? rel.youFollow)
  const isBlocked = !!(rel.isBlocked ?? rel.youBlock)
  const normalizedProfile =
    rel.isFollowing === isFollowing && rel.isBlocked === isBlocked
      ? data
      : { ...data, relationship: { ...rel, isFollowing, isBlocked } }

  const model = hsCardModel(
    { profile: normalizedProfile, socials: pcBuildSocials(data) },
    {
      hint: { platform: platform || undefined, login: (username || '').toLowerCase() },
      capabilities: { follow: true, whisper: true, dm: true, mention: true, mute: true, block: true, isBlocked },
      extraSheet: [...pcBuildSessionSheetRows(username), ...(activeProfileCard.followageRows || [])],
      modGroups: pcBuildModGroups(username),
    },
    { formatCompactNumber: pcFmt },
  )

  const html = hsCardHtml(model, {
    variant: 'panel',
    escapeHtml,
    renderBio: hsExtRenderBio,
    renderPlusBadge: typeof renderPlusTenureToken === 'function' ? renderPlusTenureToken : undefined,
    paintColor: typeof sanitizeColor === 'function' ? sanitizeColor : undefined,
    renderBadges: () => pcRenderBadgesHtml(data, username),
  })

  // NOTE: innerHTML XSS-safe — hsCardHtml escapes every untrusted field
  const wrap = document.createElement('div')
  wrap.innerHTML = html
  const card = wrap.firstElementChild
  if (!card) return

  // Sticky close — pinned top-right, stays in place while card scrolls.
  // Redundant with ESC, but discoverability is king. hs-pcard-close is old
  // CSS (09/12), not yet deleted — no shared-card equivalent exists since
  // peek/full/page never show a visible X (ESC/outside-click dismiss).
  const closeBtn = document.createElement('button')
  closeBtn.className = 'hs-pcard-close'
  closeBtn.type = 'button'
  closeBtn.title = 'close (Esc)'
  closeBtn.setAttribute('aria-label', 'close profile')
  closeBtn.textContent = '×'
  closeBtn.addEventListener('click', closeProfileCard)
  card.prepend(closeBtn)

  msgsEl.appendChild(card)

  // Mute label — local-only ephemeral state (chrome.storage), never part of
  // the shared model: unlike follow/block it isn't server-authoritative, and
  // the site has no equivalent capability at all.
  const isMuted = typeof isUserMuted === 'function' ? isUserMuted(username, platform) : mutedUsers.has(username)
  if (isMuted) {
    const muteBtn = card.querySelector('.hs-card-action[data-hs-card-action="mute"]')
    if (muteBtn) {
      muteBtn.textContent = 'unmute'
      muteBtn.classList.add('hs-card-active')
    }
  }

  // "+add channel" — ext-only (channels/tabs are a multichat concept the
  // site has no equivalent of), so it isn't in card-model.js's ACTION_DEFS.
  // Appended after the shared action row, same visual family.
  const inChannels = config.channels.some((c) => {
    const id = c.id?.toLowerCase()
    const lower = (username || '').toLowerCase()
    return id === lower || c.twitch?.toLowerCase() === lower || c.kick?.toLowerCase() === lower
  })
  if (!inChannels) {
    const actionsRow = card.querySelector('.hs-card-actions')
    if (actionsRow) {
      const addBtn = document.createElement('button')
      addBtn.type = 'button'
      addBtn.className = 'hs-card-action'
      addBtn.dataset.hsCardAction = 'addchannel'
      addBtn.innerHTML = `${hk('+add channel', escapeHtml)}`
      actionsRow.appendChild(addBtn)
    }
  }

  // Notes — still the ext's own local/chrome.storage system (server sync +
  // migration is a separate pass, tracked in the phase-2 plan's step 5); not
  // wired to the shared model's `note` field yet on purpose. Appended as its
  // own section, same as before.
  if (typeof hsNoteRenderCardSection === 'function') {
    const nsec = hsNoteRenderCardSection(username, platform, pcMakeSection)
    if (nsec) card.querySelector('.hs-card-body')?.appendChild(nsec)
  }

  // Hero banner + pronouns — same async progressive-enhancement pattern as
  // the hover tooltip (tooltips.js's applyTooltipBanner/applyTooltipPronouns),
  // retargeted at this card's own root instead of #hs-user-tooltip.
  const idUid = String(data.twitch_user_id || data.twitch_id || '')
  const chain = pickBannerChain(data, platform, username)
  if (chain.length) pcApplyBanner(card, chain)
  if (idUid) pcApplyPronouns(card, idUid)

  // Live Twitch followage — the panel never had this before (team-lead ask:
  // "the overlay card currently has none"). Reuses computeFollowageRows +
  // lookupFollowage (tooltips.js, same bundle scope — lookupFollowage
  // already tries the server first and falls back to gqlProxy on a
  // degraded answer). Fetched once per card open — followageFetchedFor
  // guards against refiring on every renderProfileCardView() re-render
  // (follow/mute toggles, hs-channels-changed, etc).
  if (
    (!platform || platform === 'twitch') &&
    activeProfileCard.followageFetchedFor !== username &&
    typeof getTooltipChannelContext === 'function' &&
    typeof lookupFollowage === 'function' &&
    typeof computeFollowageRows === 'function'
  ) {
    const channelLogin = getTooltipChannelContext(platform)
    if (channelLogin) {
      activeProfileCard.followageFetchedFor = username
      const openedFor = activeProfileCard
      lookupFollowage(username, channelLogin).then((result) => {
        if (activeProfileCard !== openedFor || !result) return
        const isSelfChannel =
          typeof currentUsername === 'string' &&
          currentUsername &&
          channelLogin.toLowerCase() === currentUsername.toLowerCase()
        activeProfileCard.followageRows = computeFollowageRows(channelLogin, isSelfChannel, result)
        renderProfileCardView()
      })
    }
  }
}

// No-heatsync-profile view — still surfaces the platform identity so the
// card has at least one useful link, and a retry when the failure was
// transient (network blip, not "this person has no account").
function renderProfileCardErrorView(msgsEl, username, data) {
  const wrap = document.createElement('div')
  wrap.className = 'hs-card hs-card-panel hs-card-empty'
  const closeBtn = document.createElement('button')
  closeBtn.className = 'hs-pcard-close'
  closeBtn.type = 'button'
  closeBtn.title = 'close (Esc)'
  closeBtn.setAttribute('aria-label', 'close profile')
  closeBtn.textContent = '×'
  closeBtn.addEventListener('click', closeProfileCard)
  wrap.appendChild(closeBtn)
  const name = document.createElement('div')
  name.className = 'hs-card-name'
  name.textContent = username
  wrap.appendChild(name)
  if (data.transient) {
    const retry = document.createElement('button')
    retry.type = 'button'
    retry.className = 'hs-card-action'
    retry.textContent = 'couldn’t load — retry'
    retry.addEventListener('click', () => {
      if (!activeProfileCard) return
      openProfileCard(username, activeProfileCard.platform)
    })
    wrap.appendChild(retry)
  }
  msgsEl.appendChild(wrap)
}

// Async pronoun application — fetches via SW and drops a chip into the
// identity chip row. Same no-gen-check tradeoff as pcApplyBanner: re-resolves
// the live element off the messages root each call, so a closed/replaced
// card is simply a no-op (querySelector on the new card's own chip row).
async function pcApplyPronouns(card, twitchUserId) {
  const data = await fetchPronouns('twitch', twitchUserId)
  const words = data?.pronouns
  if (!words?.length) return
  const root = document.getElementById('hs-mc-messages')?.querySelector('.hs-card-panel') || card
  const identity = root.querySelector('.hs-card-identity')
  if (!identity || identity.querySelector('.hs-card-pronouns')) return
  const chip = document.createElement('span')
  chip.className = 'hs-card-pronouns'
  chip.textContent = words.join('/').toLowerCase()
  const name = identity.querySelector('.hs-card-name')
  if (name?.nextSibling) identity.insertBefore(chip, name.nextSibling)
  else identity.appendChild(chip)
}

// Async banner application — walks the platform chain and applies the first
// real banner. No-op when the card was closed/re-rendered while in-flight
// (we re-resolve the element off the live messages root each call).
async function pcApplyBanner(card, chain) {
  const banner = await fetchBannerChain(chain)
  if (!banner) return
  const root = document.getElementById('hs-mc-messages')?.querySelector('.hs-card-panel') || card
  const hero = root.querySelector('.hs-card-hero')
  if (!hero) return
  const heroImg = hero.querySelector('.hs-card-hero-img')
  if (!heroImg) return
  // safeUrl gates protocol (http/https only); escape quote+backslash so a
  // crafted banner URL (kick/yt-sourced) can't break out of url("…") and
  // inject CSS.
  const safe = safeUrl(banner.bannerUrl || banner.offlineUrl)
  if (safe) heroImg.style.backgroundImage = `url("${safe.replace(/\\/g, '%5C').replace(/"/g, '%22')}")`
  // Fill avatar from banner fetch's profile_pic when the card landed on the
  // anon placeholder (no heatsync profile pic). Kick API returns profile_pic
  // alongside the banner so unregistered kick chatters get a real face.
  if (banner.profileUrl) {
    const avatar = root.querySelector('.hs-card-avatar')
    // safeUrl-gate like every other avatar path (tooltips.js/social.js/main.js):
    // profileUrl is Kick v2 profile_pic / YT og:image, neither URL-validated by
    // the BG, so a javascript:/data: value must not reach img.src. On reject,
    // leave the anon placeholder rather than blank it.
    const safeAv = safeUrl(banner.profileUrl)
    if (avatar && safeAv && (avatar.src || '').includes('anon.webp')) {
      avatar.src = safeAv
    }
  }
  // Same CSSOM-at-mount discipline as data-color/data-accent — see
  // hsExtApplyAccent (tooltips.js, shared bundle scope).
  if (banner.accent) hsExtApplyAccent(root, banner.accent)
}

async function pcToggleMute(username) {
  username = username.toLowerCase()
  const platform = activeProfileCard?.platform
  // Namespaced keys (async: includes heatsync-profile linked identities) prevent
  // twitch:alice / kick:alice collisions while still covering linked accounts.
  const aliasKeys =
    typeof expandUserAliasKeys === 'function'
      ? await expandUserAliasKeys(username, platform)
      : typeof getUserAliasKeys === 'function'
        ? getUserAliasKeys(username, platform)
        : [username]
  const wasMuted = typeof isUserMuted === 'function' ? isUserMuted(username, platform) : mutedUsers.has(username)
  if (wasMuted) {
    for (const k of aliasKeys) mutedUsers.delete(k)
    // Also clear legacy forms: bare (pre-namespace), yt: (pre-canonPlatform,
    // still matched by enforcement), heatsync: — so unmute always lands.
    const _bare = String(username || '')
      .toLowerCase()
      .replace(/^@/, '')
    const _legacy = _bare ? [_bare, `yt:${_bare}`, `heatsync:${_bare}`] : []
    for (const k of _legacy) mutedUsers.delete(k)
    for (const k of [...aliasKeys, ..._legacy]) safeSendMessage({ type: 'unmute_user', username: k })
  } else {
    for (const k of aliasKeys) mutedUsers.add(k)
    const exp = Date.now() + 86400000
    for (const k of aliasKeys) safeSendMessage({ type: 'mute_user', username: k, expiresAt: exp })
  }
  persistMcMuted()
  renderProfileCardView()
}

// Heatsync follow/unfollow — POST/DELETE /api/follow/{userId}. Server returns
// 400 'Already following' / 'Not following' for no-op state which we treat as
// idempotent success. After success, ping background to refresh followedUsers
// so the new follow shows up in live notifications + badge immediately.
// Mutate every _profileCache entry for this user so subsequent reads (ctx
// menu's hsRelPeek, tooltip rehover, profile card reopen) see fresh state.
// Without this, after pcToggleFollow the cached profile keeps the pre-toggle
// youFollow and the next right-click still says "follow".
// Best-effort lookup of whatever profile data we already have cached for a
// username — the open card's data, or a prior hover/ctx-menu resolveIdentity
// hit sharing _profileCache. Used only to decide whether a cross-platform
// follow-propagation skip is "expected" (BUG 2) — never trust this for
// anything privacy-sensitive, it's a UX heuristic, not a source of truth.
function _pcKnownCrossLinks(username) {
  if (activeProfileCard?.data && !activeProfileCard.data.error) return activeProfileCard.data
  if (typeof _profileCache === 'undefined' || !username) return {}
  const u = String(username).toLowerCase()
  for (const [k, v] of _profileCache) {
    if (k.endsWith(`:${u}`)) return v?.profile || {}
  }
  return {}
}

function _patchProfileCacheRel(username, patch) {
  if (typeof _profileCache === 'undefined' || !_profileCache) return
  const u = String(username).toLowerCase()
  for (const [k, v] of _profileCache) {
    if (!k.endsWith(`:${u}`)) continue
    const prof = v?.profile
    if (!prof) continue
    prof.relationship = { ...(prof.relationship || {}), ...patch }
  }
}

async function pcToggleFollow(profileId, username, currentlyFollowing) {
  if (!profileId) {
    if (typeof showToast === 'function') showToast(t('mc_profile_not_registered'), 'error')
    return
  }
  const targetFollowing = !currentlyFollowing
  const method = targetFollowing ? 'POST' : 'DELETE'
  // Optimistic UI
  if (activeProfileCard?.data) {
    activeProfileCard.data.relationship = { ...(activeProfileCard.data.relationship || {}), youFollow: targetFollowing }
    renderProfileCardView()
  }
  _patchProfileCacheRel(username, { youFollow: targetFollowing, isFollowing: targetFollowing })
  try {
    // kick_ ids need the username hint — the server can't resolve a kick id
    // to a profile on its own (app-token API limitation); it verifies the pair.
    const hint =
      method === 'POST' && username && /^kick_\d+$/.test(String(profileId))
        ? `?kickUsername=${encodeURIComponent(username)}`
        : ''
    const resp = await apiFetch(`/api/follow/${encodeURIComponent(profileId)}${hint}`, { method, auth: true })
    if (!resp?.ok) {
      const msg = String(resp?.error || '').toLowerCase()
      if (!msg.includes('already following') && !msg.includes('not following')) {
        // Real failure — revert optimistic state
        if (activeProfileCard?.data?.relationship) {
          activeProfileCard.data.relationship.youFollow = currentlyFollowing
          renderProfileCardView()
        }
        _patchProfileCacheRel(username, { youFollow: currentlyFollowing, isFollowing: currentlyFollowing })
        if (typeof showToast === 'function')
          showToast(t('mc_profile_follow_failed', [resp?.error || t('mc_common_unknown')]), 'error')
        return
      }
    }
    if (typeof showToast === 'function')
      showToast(t(targetFollowing ? 'mc_profile_following' : 'mc_profile_unfollowed', [username]), 'success')
    // Tell background to refetch followedUsers — pollFollowedLive runs after,
    // so live notifications + badge include the new follow within ~60s.
    safeSendMessage({ type: 'refresh_followed_users' })
    // Cross-platform propagation — server returns target.{twitch_id, kick_username}
    // on success. Fire and forget; failures queue locally for next platform tab.
    const tgt = resp?.data?.target || resp?.target || null
    if (tgt && typeof propagateFollow === 'function') {
      propagateFollow(targetFollowing, tgt)
        .then((res) => {
          // BUG 2 — the server redacts a private cross-platform linkage by
          // simply omitting it from `tgt`, so propagateFollow's skip is
          // silent by design (privacy decision: keep the redaction). But
          // when WE already know (client-side, pre-follow) this chatter has
          // an account on another platform — a plain profile field, or
          // Kick's public-API cross-link — and propagation still skipped,
          // that's a real sync gap the user should hear about. Only on a
          // fresh follow, never unfollow; never for a plain same-platform
          // follow (the platform just followed is excluded from "expected").
          if (!targetFollowing || !res || typeof showToast !== 'function') return
          const known = _pcKnownCrossLinks(username)
          const contextPlat = activeProfileCard?.platform
          const expectTwitch = contextPlat !== 'twitch' && !!(known.twitch_username || known._linked_twitch_username)
          const expectKick = contextPlat !== 'kick' && !!known.kick_username
          const skippedPrivate =
            (expectTwitch && res.twitch?.skipped === 'no twitch id') ||
            (expectKick && res.kick?.skipped === 'no kick username')
          if (skippedPrivate) showToast(t('mc_profile_cross_sync_unavailable'), 'info')
        })
        .catch(() => {})
    }
  } catch (e) {
    if (activeProfileCard?.data?.relationship) {
      activeProfileCard.data.relationship.youFollow = currentlyFollowing
      renderProfileCardView()
    }
    _patchProfileCacheRel(username, { youFollow: currentlyFollowing, isFollowing: currentlyFollowing })
    if (typeof showToast === 'function')
      showToast(t('mc_profile_follow_failed', [e?.message || t('mc_common_unknown')]), 'error')
  }
}

// Heatsync block/unblock — POST/DELETE /api/user/block/{userId}. Server's
// idempotent error responses ('User already blocked' / no record) are treated
// as success. After block, profile auto-unfollows server-side, so we mirror
// that in the relationship object.
async function pcToggleBlock(profileId, username, currentlyBlocked) {
  if (!profileId) {
    if (typeof showToast === 'function') showToast(t('mc_profile_not_registered'), 'error')
    return
  }
  const targetBlocked = !currentlyBlocked
  // Optimistic UI
  if (activeProfileCard?.data) {
    const rel = { ...(activeProfileCard.data.relationship || {}) }
    rel.youBlock = targetBlocked
    rel.isBlocked = targetBlocked
    if (targetBlocked) {
      // Server auto-unfollows on block — mirror locally
      rel.youFollow = false
      rel.isFollowing = false
    }
    activeProfileCard.data.relationship = rel
    renderProfileCardView()
  }
  _patchProfileCacheRel(
    username,
    targetBlocked
      ? { youBlock: true, isBlocked: true, youFollow: false, isFollowing: false }
      : { youBlock: false, isBlocked: false },
  )
  try {
    const path = `/api/user/block/${encodeURIComponent(profileId)}`
    const resp = targetBlocked
      ? await apiFetch(path, { method: 'POST', auth: true, body: {} })
      : await apiFetch(`${path}?sync_twitch=0`, { method: 'DELETE', auth: true })
    if (!resp?.ok) {
      const msg = String(resp?.error || '').toLowerCase()
      if (!msg.includes('already blocked') && !msg.includes('not blocked')) {
        // Real failure — revert optimistic state
        if (activeProfileCard?.data?.relationship) {
          activeProfileCard.data.relationship.youBlock = currentlyBlocked
          activeProfileCard.data.relationship.isBlocked = currentlyBlocked
          renderProfileCardView()
        }
        _patchProfileCacheRel(username, { youBlock: currentlyBlocked, isBlocked: currentlyBlocked })
        if (typeof showToast === 'function')
          showToast(t('mc_profile_block_failed', [resp?.error || t('mc_common_unknown')]), 'error')
        return
      }
    }
    if (typeof showToast === 'function')
      showToast(t(targetBlocked ? 'mc_profile_blocked' : 'mc_profile_unblocked', [username]), 'success')
    // Hide/restore the user's live messages immediately. block_user → bg →
    // user_blocked broadcast → main.js updates blockedUsers + re-renders. Mirrors
    // the chat right-click path; without it a profile-card block only took
    // effect on next reload. Fans out across linked twitch/kick aliases.
    try {
      const platform = activeProfileCard?.platform
      // Use namespaced keys so block_user/unblock_user messages carry platform scope,
      // preventing twitch:alice from hiding an unrelated kick:alice.
      const aliasKeys =
        typeof expandUserAliasKeys === 'function'
          ? await expandUserAliasKeys(String(username).toLowerCase(), platform)
          : typeof getUserAliasKeys === 'function'
            ? getUserAliasKeys(String(username).toLowerCase(), platform)
            : [String(username).toLowerCase()]
      const blockMsg = targetBlocked ? 'block_user' : 'unblock_user'
      for (const k of aliasKeys) safeSendMessage({ type: blockMsg, username: k })
    } catch (_) {
      /* best-effort live hide */
    }
    // Block side-effects unfollow on server — re-fetch followedUsers in background
    safeSendMessage({ type: 'refresh_followed_users' })
    // Block always implies platform-unfollow (server auto-unfollowed heatsync).
    // Mirror on twitch/kick so the relationship stays consistent across surfaces.
    // No corresponding "block on twitch/kick" — those are separate user actions
    // intentionally not auto-propagated (block is a user-level decision).
    if (targetBlocked) {
      const tgt = resp?.data?.target || resp?.target || null
      if (tgt && typeof propagateFollow === 'function') {
        propagateFollow(false, tgt).catch(() => {})
      }
    }
  } catch (e) {
    if (activeProfileCard?.data?.relationship) {
      activeProfileCard.data.relationship.youBlock = currentlyBlocked
      activeProfileCard.data.relationship.isBlocked = currentlyBlocked
      renderProfileCardView()
    }
    _patchProfileCacheRel(username, { youBlock: currentlyBlocked, isBlocked: currentlyBlocked })
    if (typeof showToast === 'function')
      showToast(t('mc_profile_block_failed', [e?.message || t('mc_common_unknown')]), 'error')
  }
}

function pcDoWhisper(username, platform) {
  closeProfileCard()
  // _openWhisperFor handles platform-aware twitch-handle resolution + tab switch + prefill.
  cleanup.setTimeout(() => _openWhisperFor(username, platform), 50)
}

function setupProfileCardHandlers() {
  if (_onceGuardsProfileCard.profileCardSetup) return
  _onceGuardsProfileCard.profileCardSetup = true

  // Primary path — pcard-early.js (document_start) intercepts the click before
  // Twitch/Kick can react and dispatches this event.
  cleanup.addEventListener(
    document,
    'hs-pcard-open',
    (e) => {
      const { username, platform } = e.detail || {}
      if (username) openProfileCard(username, platform || null)
    },
    { signal: mcSignal },
  )

  // Channel list changed (right-click remove, add via pill, server sync, etc.) —
  // re-render the open card so the [+] action reflects the new in-channels state.
  cleanup.addEventListener(
    document,
    'hs-channels-changed',
    () => {
      if (activeProfileCard) renderProfileCardView()
    },
    { signal: mcSignal },
  )

  // Username click → open card. Capture phase so we beat Twitch/Kick native user-card handlers.
  // Allow ctrl/meta/shift/middle/alt to fall through to the <a target="_blank"> default nav.
  cleanup.addEventListener(
    document,
    'click',
    (e) => {
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return
      const userEl = e.target.closest('.hs-mc-user')
      if (!userEl) return
      if (e.target.closest('[data-pcard-pill]')) return
      // Composer mention chips (#hs-mc-input) are editable text, not an author
      // reference — clicking one places the caret to edit, never opens a card.
      if (userEl.closest('#hs-mc-input')) return
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()
      const username = (userEl.dataset.username || userEl.textContent.replace(/^@/, '')).trim()
      const platform = userEl.dataset.platform || null
      openProfileCard(username, platform)
    },
    { capture: true, signal: mcSignal },
  )

  // Twitch attaches mousedown handlers too — block those at capture so the native card never opens
  cleanup.addEventListener(
    document,
    'mousedown',
    (e) => {
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return
      const userEl = e.target.closest('.hs-mc-user')
      if (!userEl) return
      if (e.target.closest('[data-pcard-pill]')) return
      // Composer mention chips are editable — don't swallow their mousedown, or
      // the caret can't land in the input to edit the @mention you're typing.
      if (userEl.closest('#hs-mc-input')) return
      e.stopPropagation()
      e.stopImmediatePropagation()
    },
    { capture: true, signal: mcSignal },
  )

  // Action/mod button clicks — delegated, since card-render.js's output is
  // inert escaped HTML (data-hs-card-action / data-hs-card-mod-* attributes,
  // no listeners of its own). pcHandleCardAction/pcHandleModAction (above)
  // read the attributes and dispatch to the same fetch/toggle functions the
  // old per-button addEventListener calls used.
  cleanup.addEventListener(
    document,
    'click',
    (e) => {
      if (!activeProfileCard) return
      const modBtn = e.target.closest('.hs-card-mod-btn')
      if (modBtn) {
        e.preventDefault()
        e.stopPropagation()
        pcHandleModAction(modBtn)
        return
      }
      const actionBtn = e.target.closest('.hs-card-action')
      if (actionBtn?.dataset.hsCardAction) {
        e.preventDefault()
        e.stopPropagation()
        pcHandleCardAction(actionBtn.dataset.hsCardAction, actionBtn)
      }
    },
    { signal: mcSignal },
  )

  // ESC closes the card; single-letter hotkeys trigger actions while open
  cleanup.addEventListener(
    document,
    'keydown',
    (e) => {
      if (!activeProfileCard) return
      // Ignore keys while typing in inputs/textareas
      const t = e.target
      const inEditable = t?.tagName === 'INPUT' || t?.tagName === 'TEXTAREA' || t?.isContentEditable
      if (inEditable) {
        if (e.key === 'Escape') {
          e.preventDefault()
          closeProfileCard()
        }
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        closeProfileCard()
        return
      }
      // Keymap: t/k/y/h jump to platform pills (twitch/kick/youtube/heatsync),
      // f follow, w whisper, d dm, @ mention, m mute, b block, + add channel.
      // '=' aliases '+' (shifted on US keyboards) for one-handed access.
      const key = e.key.toLowerCase()
      const allowed = new Set(['t', 'k', 'y', 'h', 'f', 'w', 'd', '@', 'm', 'b', '+', '='])
      if (!allowed.has(key)) return
      const target = key === '=' ? '+' : key
      let btn
      if (target === 't' || target === 'k' || target === 'y' || target === 'h') {
        // Platform pills — card-render.js's renderPlatformsRow (.hs-card-plat-link[data-tone]).
        const tone = { t: 'ttv', k: 'kick', y: 'yt', h: 'hs' }[target]
        btn = document.querySelector(`.hs-card-plat-link[data-tone="${tone}"]`)
      } else if (target === '+') {
        btn = document.querySelector('.hs-card-action[data-hs-card-action="addchannel"]')
      } else {
        const action = { f: 'follow', w: 'whisper', d: 'dm', '@': 'mention', m: 'mute', b: 'block' }[target]
        btn = document.querySelector(`.hs-card-action[data-hs-card-action="${action}"]`)
      }
      if (btn && !btn.disabled) {
        e.preventDefault()
        btn.click()
      }
    },
    'mc-pcard-keys',
  )
}

// Dispatches a click on a .hs-card-action button (data-hs-card-action) to
// the same fetch/toggle functions the old per-button addEventListener calls
// used — the delegated click handler above is the one call site.
function pcHandleCardAction(actionKey, _btn) {
  if (!activeProfileCard) return
  const { username, data, platform } = activeProfileCard
  const rel = data?.relationship || {}
  const profileId = data?.id || data?.userId || null
  switch (actionKey) {
    case 'follow':
      pcToggleFollow(profileId, username, !!(rel.isFollowing ?? rel.youFollow))
      break
    case 'whisper':
      pcDoWhisper(username, platform)
      break
    case 'dm':
      pcDoDm(username, platform)
      break
    case 'mention':
      pcMention(data?.display_name || username)
      break
    case 'mute':
      pcToggleMute(username)
      break
    case 'block':
      pcToggleBlock(profileId, username, !!(rel.isBlocked ?? rel.youBlock))
      break
    case 'addchannel':
      pcAddAsChannel(username)
      break
  }
}

function pcMention(name) {
  closeProfileCard()
  // Mentioning someone means chatting to them — move to a tab that reaches a
  // real chat first (the social tabs refuse a bare send).
  if (!tabSendsToChat(currentTab)) switchTab('live')
  cleanup.setTimeout(() => {
    showInputBar()
    const input = document.getElementById('hs-mc-input')
    if (!input) return
    const tag = `@${name} `
    if (input.tagName === 'INPUT') {
      const cur = input.value || ''
      const sep = cur && !cur.endsWith(' ') ? ' ' : ''
      input.value = cur + sep + tag
      input.focus()
      input.setSelectionRange(input.value.length, input.value.length)
    } else {
      const cur = input.textContent || ''
      const sep = cur && !cur.endsWith(' ') ? ' ' : ''
      input.textContent = cur + sep + tag
      input.focus()
      // Place caret at end
      const range = document.createRange()
      range.selectNodeContents(input)
      range.collapse(false)
      const sel = window.getSelection()
      sel.removeAllRanges()
      sel.addRange(range)
    }
  }, 60)
}

function pcDoDm(username, platform) {
  closeProfileCard()
  // _openDmFor handles platform-aware heatsync-handle resolution + tab switch + prefill.
  cleanup.setTimeout(() => _openDmFor(username, platform), 50)
}

async function pcAddAsChannel(username) {
  if (!config?.channels) return
  const id = username.toLowerCase()
  const exists = config.channels.some((c) => {
    const cid = c.id?.toLowerCase()
    return cid === id
  })
  if (exists) {
    closeProfileCard()
    switchTab(id)
    return
  }

  // Use cached profile on the active card if present (avoids round-trip).
  // Otherwise resolve via /api/profile so we populate ALL linked platforms.
  let res = null
  if (activeProfileCard?.data && !activeProfileCard.data.error) {
    res = shapeIdentity(activeProfileCard.data)
  } else if (typeof resolveIdentity === 'function') {
    const plat = activeProfileCard?.platform
    res = await resolveIdentity(username, plat ? { platform: plat } : {})
  }

  // Fallback when no heatsync profile: assume the typed name is twitch (consistent
  // with prior behaviour when adding e.g. a Twitch-only channel from chat).
  // EXCEPT from a youtube card: a yt author name is not a twitch login — same
  // explicit-only rule as resolveLiveCandidateToTab (kripparrian's yt vs
  // twitch nl_kripp; the guess joins/sends to a stranger's channel).
  const fromYt = activeProfileCard?.platform === 'youtube'
  const id2 = res?.identity?.heatsync?.toLowerCase() || id
  const channel = {
    id: id2,
    twitch: (res?.identity?.twitch || (fromYt ? '' : username)).toLowerCase(),
    kick: (res?.identity?.kick || '').toLowerCase(),
    youtube: typeof identityYtLiveUrl === 'function' ? identityYtLiveUrl(res) : '',
  }
  if (!channel.twitch && !channel.kick && !channel.youtube) {
    // yt card with no heatsync linkage — nothing safe to bind. Fail loud,
    // never push a dead tab or guess a twitch channel.
    if (typeof showToast === 'function') showToast(t('mc_profile_no_linked_channels', [username]), 'error')
    closeProfileCard()
    return
  }

  config.channels.push(channel)
  saveConfig()
  if (typeof updateTabBar === 'function') updateTabBar()
  if (channel.twitch) {
    irc?.join(channel.twitch)
    safeSendMessage({ type: 'join_channel', platform: 'twitch', channel: channel.twitch })
  }
  if (channel.kick) kickChat?.join(channel.kick)
  if (channel.youtube) {
    youtubeLinks.set(channel.id, { url: channel.youtube, videoId: '', channelName: '' })
    // Arm the watchdog — it reads ytChanLastSeen/ytSubscribedUrls, so a sub
    // added without them is never re-subscribed when the stream goes silent.
    ytSubscribedUrls.set(channel.id, channel.youtube)
    ytChanLastSeen.set(channel.id, Date.now())
    ytSubscribe(channel.id, channel.youtube)
  }
  closeProfileCard()
  switchTab(channel.id)
}
