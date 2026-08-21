// avatar/paint/badge cosmetics fetch+render+cache cluster — split out of
// main.js (2026-07-04). Covers 7TV/HeatSync-paint + native/BTTV/FFZ/Chatterino
// badge in-place patching, the mcUserCosmetics batch-fetch pipeline, and the
// avatar + yt-name/kick-name -> twitch-id resolvers that feed it.
// NOTE: HeatSync-native paints (queuePaintLookup/flushHsPaintBatch/paint cache)
// already live in paints.js — this file only holds the main.js-resident
// cosmetics cluster (7TV + native + third-party badges + avatar).

// Third-party cosmetics state (BTTV/FFZ/Chatterino badges, 7TV paints+badges)
let mcBttvBadgeMap = new Map()
let mcFfzBadgeMap = new Map()
let mcChatterinoBadgeMap = new Map()
const mcUserCosmetics = new Map()
// A channel buffer renders ~1500-2000 distinct users; caps below must clear
// that or a full-buffer rebuild silently drops most cosmetic lookups. (500/100
// meant switching to a busy/restored channel resolved only the first ~100
// users — everyone after, paints included, rendered plain.)
const MC_COSMETICS_MAX = 3000
function setMcCosmetic(uid, c) {
  mcUserCosmetics.set(uid, c)
  if (mcUserCosmetics.size > MC_COSMETICS_MAX) {
    mcUserCosmetics.delete(mcUserCosmetics.keys().next().value)
  }
}
const MC_COSMETICS_PENDING_MAX = 3000
const mcCosmeticsPending = new Set()
let mcCosmeticsTimer = null

// Avatar URL cache: username → CDN URL (fetched via BG resolveAvatarUrl)
const avatarCache = new Map()
const avatarFetching = new Set() // prevent duplicate fetches
let _activeAvatarFetches = 0
const MAX_AVATAR_FETCHES = 5
// Neutral initials avatar. Renders immediately so the fixed 18px avatar box
// is reserved from first paint — the real pfp (fetched async via first-party
// GQL (BG resolveAvatarUrl) for twitch, carried inline for yt, absent for kick)
// then swaps in IN PLACE with
// zero layout shift instead of popping the row sideways on arrival. A failed
// or absent fetch simply stays as the initial — no blank gap. `withDataUser`
// tags the twitch placeholder so fetchAvatar can find and replace it.
function avatarFallbackHtml(user, key, withDataUser) {
  const initial = (user || '?').charAt(0).toUpperCase()
  const palette = ['#808080', '#5f87ff', '#00d65a', '#ffff00', '#ff4f4d', '#af87ff']
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0
  const du = withDataUser ? ` data-user="${escapeHtml(key)}"` : ''
  return `<span class="hs-mc-avatar hs-mc-avatar-fallback"${du} style="background:${palette[h % palette.length]};color:#000">${escapeHtml(initial)}</span>`
}
function fetchAvatar(username) {
  const key = username.toLowerCase()
  if (avatarCache.has(key) || avatarFetching.has(key)) return
  if (_activeAvatarFetches >= MAX_AVATAR_FETCHES) return
  avatarFetching.add(key)
  _activeAvatarFetches++
  chrome.runtime
    .sendMessage({ type: 'resolve_avatar_url', username: key, platform: 'twitch' })
    .then((resp) => {
      avatarFetching.delete(key)
      _activeAvatarFetches--
      const safe = safeUrl((resp?.url || '').trim())
      if (!safe) return
      avatarCache.set(key, safe)
      if (avatarCache.size > 500) {
        avatarCache.delete(avatarCache.keys().next().value)
      }
      // Swap each initials placeholder for the real avatar img IN PLACE. The
      // placeholder span already holds the 18px box, so replacing it with an
      // equally-sized img produces zero layout shift (no pop).
      if (avatarsEnabled) {
        const safeSrc = avatarCache.get(key)
        document.querySelectorAll(`.hs-mc-avatar[data-user="${CSS.escape(key)}"]`).forEach((el) => {
          const img = document.createElement('img')
          img.className = 'hs-mc-avatar'
          img.src = safeSrc
          img.alt = ''
          img.loading = 'lazy'
          img.decoding = 'async'
          el.replaceWith(img)
        })
      }
    })
    .catch(() => {
      avatarFetching.delete(key)
      _activeAvatarFetches--
    })
}

// YT-name → twitch_id resolver. YouTube chat doesn't expose channel IDs in
// the DOM, so we look the user up on heatsync to get a twitchId, then feed
// that into the existing 7TV cosmetics pipeline. The map caches both hits
// (twitch_id) and misses (null) — LRU-evicted at YT_NAME_CACHE_MAX so a
// long stream session can't grow it without bound.
const ytNameToTwitchId = new Map() // ytUserKey → twitchId | null
const ytNameToTwitchUsername = new Map() // ytUserKey → twitchUsername | null (cross-platform alias)
const ytNameLookupPending = new Set()
let ytNameLookupTimer = null
const YT_NAME_BATCH = 8
const YT_NAME_CACHE_MAX = 1000

function evictYtNameCache() {
  if (ytNameToTwitchId.size >= YT_NAME_CACHE_MAX) {
    const oldest = ytNameToTwitchId.keys().next().value
    ytNameToTwitchId.delete(oldest)
    ytNameToTwitchUsername.delete(oldest)
  }
}

function ytNameKey(user) {
  return (user || '').toLowerCase().replace(/^@/, '')
}

// Recover a yt username's UC… channel id without threading it through
// main.js's queueYtNameToTwitchId call site (main.js is off-limits for this
// change). The id is already riding every yt message as social.js's
// `yt_<UCid>` hsPaintUid — read it back off whichever rendered row or
// buffered message this username last appeared in, same lookup shape as the
// data-uid backfill below.
function findYtChannelIdForUser(key) {
  const fromPaintUid = (puid) => (typeof puid === 'string' && puid.startsWith('yt_') ? puid.slice(3) : null)
  const container = document.getElementById('hs-mc-messages')
  if (container) {
    const sel = `.hs-mc-msg .hs-mc-user:not(.hs-mc-mention)[data-platform="yt"][data-username="${CSS.escape(`@${key}`)}"], .hs-mc-msg .hs-mc-user:not(.hs-mc-mention)[data-platform="yt"][data-username="${CSS.escape(key)}"]`
    for (const userEl of container.querySelectorAll(sel)) {
      const found = fromPaintUid(userEl.closest('.hs-mc-msg')?.dataset.hsPaintUid)
      if (found) return found
    }
  }
  const scanBuf = (buf) => {
    if (!buf) return null
    for (const m of buf) {
      if (m && m.platform === 'youtube' && m.user && ytNameKey(m.user) === key) {
        const found = fromPaintUid(m.hsPaintUid)
        if (found) return found
      }
    }
    return null
  }
  if (typeof channelYtMessages !== 'undefined') {
    for (const buf of channelYtMessages.values()) {
      const found = scanBuf(buf)
      if (found) return found
    }
  }
  if (typeof mentionsBuffer !== 'undefined') {
    const found = scanBuf(mentionsBuffer)
    if (found) return found
  }
  return null
}

function queueYtNameToTwitchId(user) {
  const key = ytNameKey(user)
  if (!key) return
  if (ytNameToTwitchId.has(key)) return
  if (ytNameLookupPending.has(key)) return
  ytNameLookupPending.add(key)
  if (ytNameLookupPending.size >= YT_NAME_BATCH) {
    if (ytNameLookupTimer) {
      cleanup.clearTimeout(ytNameLookupTimer)
      ytNameLookupTimer = null
    }
    flushYtNameLookups()
    return
  }
  if (!ytNameLookupTimer) {
    ytNameLookupTimer = cleanup.setTimeout(() => {
      ytNameLookupTimer = null
      flushYtNameLookups()
    }, 800)
  }
}

async function flushYtNameLookups() {
  if (!ytNameLookupPending.size) return
  const batch = [...ytNameLookupPending].slice(0, YT_NAME_BATCH)
  batch.forEach((k) => {
    ytNameLookupPending.delete(k)
  })
  // Serialize — Promise.all over the batch was firing 8 concurrent
  // /api/profile/X requests that monopolized the SW's heatsync slot pool
  // and starved channel-emote / cosmetics fetches. YT cosmetics aren't
  // time-critical; a slower-but-quieter walk is the right trade.
  const lookupOne = async (key) => {
    try {
      const resp = await safeSendMessage({
        type: 'api_fetch',
        path: `/api/profile/${encodeURIComponent(key)}`,
        method: 'GET',
      })
      const tid = resp?.data?.twitch_id || resp?.twitch_id || null
      const tuser = resp?.data?.twitch_username || resp?.twitch_username || null
      evictYtNameCache()
      ytNameToTwitchId.set(key, tid ? String(tid) : null)
      ytNameToTwitchUsername.set(key, tuser ? String(tuser).toLowerCase() : null)
      if (tid) {
        const tidStr = String(tid)
        // Backfill: stamp data-uid on all currently-rendered YT msgs by this
        // user so updateCosmeticsInPlace can find them once cosmetics resolve.
        const container = document.getElementById('hs-mc-messages')
        if (container) {
          const sel = `.hs-mc-msg .hs-mc-user:not(.hs-mc-mention)[data-platform="yt"][data-username="${CSS.escape(`@${key}`)}"], .hs-mc-msg .hs-mc-user:not(.hs-mc-mention)[data-platform="yt"][data-username="${CSS.escape(key)}"]`
          for (const userEl of container.querySelectorAll(sel)) {
            const div = userEl.closest('.hs-mc-msg')
            if (div && !div.dataset.uid) div.dataset.uid = tidStr
          }
        }
        // Patch buffered messages so the next render picks up the userId and
        // walks the cosmetics-aware path (otherwise the cached _renderedHtml
        // keeps the paint-less version forever).
        const patchBuf = (buf) => {
          if (!Array.isArray(buf) && !(buf && typeof buf[Symbol.iterator] === 'function')) return
          for (const m of buf) {
            if (m && m.platform === 'youtube' && m.user) {
              const mk = m.user.toLowerCase().replace(/^@/, '')
              if (mk === key) {
                m.userId = tidStr
                m._renderedHtml = null
              }
            }
          }
        }
        if (typeof channelYtMessages !== 'undefined') channelYtMessages.forEach(patchBuf)
        if (typeof mentionsBuffer !== 'undefined') patchBuf(mentionsBuffer)
        // Now feed through the existing cosmetics pipeline; it will resolve
        // 7TV paint/badge and call updateCosmeticsInPlace which paints by uid.
        if (!mcUserCosmetics.has(tidStr)) queueMcCosmeticsLookup(tidStr)
        return
      }

      // No linked Twitch account — a twitch-miss must never mask a possible
      // 7TV google-id hit, so fall back to 7TV's YouTube/"google" id space
      // right here rather than caching a bare negative and stopping. The
      // uid stays namespaced (`yt_<UCid>`) and never touches the twitch-space
      // _uidIndex/data-uid path (ID-SPACE SAFETY, see paints.js) — it applies
      // via the same data-hs-paint-uid rows social.js already stamps.
      // Best-effort: by flush time the triggering message is virtually always
      // already rendered/buffered (this only fires once per username — see
      // ytNameToTwitchId.has(key) above — so there's no later retry if the
      // scan comes up empty on a very fast-scrolling chat).
      const channelId = findYtChannelIdForUser(key)
      if (!channelId) return
      const ytUid = `yt_${channelId}`
      if (mcUserCosmetics.has(ytUid)) return
      // Third-party only. The name→twitch-id resolution ABOVE stays ungated:
      // it also feeds heatsync's own paints (it sets m.userId), and the switch
      // is named "third-party cosmetics". This 7TV google-id fetch is the only
      // part of this path the switch actually owns.
      if (gateAtBoot('cosmetics') === false) return
      let googleResp = null
      try {
        googleResp = await safeSendMessage({ type: 'get_youtube_user_cosmetics', channelIds: [channelId] })
      } catch {
        googleResp = null
      }
      const cosmetic = googleResp?.cosmetics?.[channelId]
      if (cosmetic) {
        setMcCosmetic(ytUid, cosmetic)
        updateCosmeticsInPlace([ytUid])
      }
    } catch {
      evictYtNameCache()
      ytNameToTwitchId.set(key, null)
      ytNameToTwitchUsername.set(key, null)
    }
  }
  for (const key of batch) await lookupOne(key)
  if (ytNameLookupPending.size > 0 && !ytNameLookupTimer) {
    ytNameLookupTimer = cleanup.setTimeout(() => {
      ytNameLookupTimer = null
      flushYtNameLookups()
    }, 1500)
  }
}

// ─── Kick username → 7TV cosmetics + twitchId lookup ───
// Kick chat WS doesn't propagate user_id to the panel, but 7TV's /users/kick/{username}
// endpoint accepts the kick handle directly and returns the linked twitch connection.
// We use the returned twitchId as the cosmetics cache key so a chatter with linked
// accounts gets the same paint/badge across both platforms.
const kickNameResolved = new Map() // kickHandle → twitchId | null
const kickNameToTwitchUsername = new Map() // kickHandle → twitchUsername | null
// kickHandle → `kick_<kickid>` | null — the namespaced HeatSync paint lookup
// id (see the ID-SPACE SAFETY note in paints.js). Populated alongside
// kickNameResolved, same eviction, independent of whether a twitch link
// exists — a kick-origin HeatSync account can have its own paint with or
// without a linked twitch account.
const kickNamePaintUid = new Map()
const kickNameLookupPending = new Set()
let kickNameLookupTimer = null
const KICK_NAME_BATCH = 8
const KICK_NAME_CACHE_MAX = 1000

function evictKickNameCache() {
  if (kickNameResolved.size >= KICK_NAME_CACHE_MAX) {
    const oldest = kickNameResolved.keys().next().value
    kickNameResolved.delete(oldest)
    kickNameToTwitchUsername.delete(oldest)
    kickNamePaintUid.delete(oldest)
  }
}

// Exposed for profile-card.js / tooltips.js cross-platform identity render.
// Returns the linked twitch username if known, else null. Triggers a lookup
// when first asked so the second hover/right-click picks up the answer.
function getKickLinkedTwitch(kickUsername) {
  if (!kickUsername) return null
  const k = String(kickUsername).toLowerCase()
  if (kickNameToTwitchUsername.has(k)) return kickNameToTwitchUsername.get(k)
  queueKickNameToCosmetics(k)
  return null
}

function queueKickNameToCosmetics(user) {
  const key = (user || '').toLowerCase()
  if (!key) return
  if (kickNameResolved.has(key)) return
  if (kickNameLookupPending.has(key)) return
  kickNameLookupPending.add(key)
  if (kickNameLookupPending.size >= KICK_NAME_BATCH) {
    if (kickNameLookupTimer) {
      cleanup.clearTimeout(kickNameLookupTimer)
      kickNameLookupTimer = null
    }
    flushKickNameLookups()
    return
  }
  if (!kickNameLookupTimer) {
    kickNameLookupTimer = cleanup.setTimeout(() => {
      kickNameLookupTimer = null
      flushKickNameLookups()
    }, 800)
  }
}

async function flushKickNameLookups() {
  if (!kickNameLookupPending.size) return
  const batch = [...kickNameLookupPending].slice(0, KICK_NAME_BATCH)
  batch.forEach((k) => {
    kickNameLookupPending.delete(k)
  })
  let resp = null
  try {
    resp = await safeSendMessage({ type: 'get_kick_user_cosmetics', kickUsernames: batch })
  } catch {
    resp = null
  }
  const cosmetics = resp?.cosmetics || {}
  const changedIds = []
  for (const key of batch) {
    const c = cosmetics[key]
    evictKickNameCache()
    const tid = c?.twitchId ? String(c.twitchId) : null
    kickNameResolved.set(key, tid)
    kickNameToTwitchUsername.set(key, c?.twitchUsername || null)
    // Namespaced kick paint uid — independent of whether a twitch link
    // resolved. Queued directly (never via queueMcCosmeticsLookup, which is
    // twitch-space only) — see the ID-SPACE SAFETY note in paints.js.
    const paintUid = c?.kickId ? `kick_${c.kickId}` : null
    kickNamePaintUid.set(key, paintUid)
    if (paintUid && typeof queuePaintLookup === 'function') queuePaintLookup(paintUid)
    // Real avatar (profile_pic, free from the same v1/users fetch). Cache it and
    // swap the rendered kick rows' initials placeholder in place — same zero-shift
    // mechanism twitch's fetchAvatar uses. Runs regardless of 7TV cosmetics.
    const av = c?.avatar ? safeUrl(c.avatar) : null
    if (av && !avatarCache.has(key)) {
      avatarCache.set(key, av)
      if (avatarCache.size > 500) avatarCache.delete(avatarCache.keys().next().value)
      if (avatarsEnabled) {
        for (const el of document.querySelectorAll(`.hs-mc-avatar[data-user="${CSS.escape(key)}"]`)) {
          const img = document.createElement('img')
          img.className = 'hs-mc-avatar'
          img.src = av
          img.alt = ''
          img.loading = 'lazy'
          img.decoding = 'async'
          el.replaceWith(img)
        }
      }
    }
    if (!tid && !paintUid) continue
    if (tid) {
      // Fold the {paint, badge} into the twitch-id-keyed cosmetics cache so the
      // existing updateCosmeticsInPlace pipeline paints by uid.
      setMcCosmetic(tid, { paint: c.paint || null, badge: c.badge || null })
      changedIds.push(tid)
    }
    // Backfill data-uid (twitch) / data-hs-paint-uid (kick paint) on rendered
    // Kick msgs by lowercase username so updateCosmeticsInPlace / the HS-paint
    // in-place repaint find the right rows.
    const container = document.getElementById('hs-mc-messages')
    if (container) {
      const sel = `.hs-mc-msg .hs-mc-user:not(.hs-mc-mention)[data-platform="kick"][data-username="${CSS.escape(key)}"]`
      for (const userEl of container.querySelectorAll(sel)) {
        const div = userEl.closest('.hs-mc-msg')
        if (!div) continue
        if (tid && !div.dataset.uid) div.dataset.uid = tid
        if (paintUid) div.dataset.hsPaintUid = paintUid
      }
    }
    // Patch buffered Kick messages so the next render picks up userId/paint
    // uid and walks the cosmetics-aware path.
    const patchBuf = (buf) => {
      if (!buf || (!Array.isArray(buf) && !(buf && typeof buf[Symbol.iterator] === 'function'))) return
      for (const m of buf) {
        if (m && m.platform === 'kick' && m.user) {
          const mk = m.user.toLowerCase()
          if (mk === key) {
            if (tid) {
              m.userId = tid
              // marks userId as twitch-space: the render path refuses to feed
              // kick rows' userId into twitch-keyed badge/cosmetic/paint maps
              // until this stamp exists (raw numeric kick ids collide there)
              m._uidTwitch = tid
            }
            if (paintUid) m.hsPaintUid = paintUid
            m._renderedHtml = null
          }
        }
      }
    }
    if (typeof kickChat !== 'undefined' && kickChat?.channels) {
      for (const ch of kickChat.channels.keys()) patchBuf(kickChat.getMessages(ch))
    }
    if (typeof mentionsBuffer !== 'undefined') patchBuf(mentionsBuffer)
  }
  if (changedIds.length) updateCosmeticsInPlace(changedIds)
  if (kickNameLookupPending.size > 0 && !kickNameLookupTimer) {
    kickNameLookupTimer = cleanup.setTimeout(() => {
      kickNameLookupTimer = null
      flushKickNameLookups()
    }, 1500)
  }
}

// 7TV cosmetics queue — batch lookups to avoid per-message requests
function queueMcCosmeticsLookup(userId) {
  if (!userId) return
  // HeatSync paints ride the exact same choke point as 7TV cosmetics —
  // every call site here already only ever passes a resolved twitch-space
  // id (see the ID-SPACE SAFETY note atop paints.js). Independent cache/
  // dedup (hsPaintCache), so this is unconditional even when the 7TV lookup
  // below short-circuits on an already-cached (possibly negative) entry.
  queuePaintLookup(userId)
  // …and heatsync paints stay OUTSIDE the gate below on purpose: the switch is
  // named "third-party cosmetics" and must not take our own paints with it.
  //
  // The 7TV half is what `cosmetics` actually switches off. Only the boot pull
  // (loadBulkBadges) was gated, so this — the per-message chokepoint every
  // rendered row goes through — kept running and the switch never delivered
  // the ram it promises on a busy channel.
  if (gateAtBoot('cosmetics') === false) return
  if (mcUserCosmetics.has(userId)) return
  if (mcCosmeticsPending.size >= MC_COSMETICS_PENDING_MAX) return
  mcCosmeticsPending.add(userId)
  if (!mcCosmeticsTimer) {
    mcCosmeticsTimer = cleanup.setTimeout(() => {
      mcCosmeticsTimer = null
      flushMcCosmeticsBatch()
    }, 100)
  }
}

function flushMcCosmeticsBatch() {
  if (!mcCosmeticsPending.size) return
  // Drain newest-queued first: messages queue oldest→newest, but the user is
  // looking at the bottom (newest) of the buffer, so the visible viewport
  // resolves in the first batch instead of last. Off-screen/scrolled-away
  // users still fill in as the queue drains.
  const batch = [...mcCosmeticsPending].slice(-25)
  batch.forEach((id) => {
    mcCosmeticsPending.delete(id)
  })
  safeSendMessage({ type: 'get_user_cosmetics', twitchIds: batch })
    .then((resp) => {
      if (!resp?.cosmetics) return
      const changedIds = []
      for (const [uid, c] of Object.entries(resp.cosmetics)) {
        if (c) {
          setMcCosmetic(uid, c)
          changedIds.push(uid)
        }
      }
      if (changedIds.length) updateCosmeticsInPlace(changedIds)
    })
    .catch(() => {})
  if (mcCosmeticsPending.size > 0) {
    mcCosmeticsTimer = cleanup.setTimeout(() => {
      mcCosmeticsTimer = null
      flushMcCosmeticsBatch()
    }, 500)
  }
}

// 7TV badge imgs sometimes fail at insert-time: a burst of cdn.7tv.app
// requests races HTTP/3 and the CDN drops a few. The URL is valid (a fresh
// fetch succeeds), so retry up to 2x — cache-busted + staggered — before
// hiding, instead of leaving a permanent broken-image icon.
function retryOrHideBadgeImg(img) {
  if (!(img instanceof HTMLImageElement) || !img.classList.contains('hs-mc-badge-img')) return
  const n = +img.dataset.hsRetry || 0
  if (n >= 2) {
    img.style.display = 'none'
    return
  }
  img.dataset.hsRetry = String(n + 1)
  const base = img.dataset.hsSrc || (img.dataset.hsSrc = img.src.replace(/[?&]hsr=\d+$/, ''))
  cleanup.setTimeout(
    () => {
      img.src = `${base + (base.includes('?') ? '&' : '?')}hsr=${img.dataset.hsRetry}`
    },
    200 * (n + 1),
  )
}

// In-place repaint for HeatSync name paints (paints.js) — the counterpart
// to updateCosmeticsInPlace below, fired from its own independent batch
// (queuePaintLookup/flushHsPaintBatch in paints.js) once a paint resolves.
// Repaints both the sender username div (_uidIndex for a twitch-space uid, or
// a data-hs-paint-uid query for a kick-space `kick_<id>` uid — see
// flushKickNameLookups) and any inline @mention/reply-context anchors
// (_mentionIndex) for this uid.
function updateHsPaintsInPlace(userIds) {
  const container = document.getElementById('hs-mc-messages')
  if (!container) return
  for (const uid of userIds) {
    // A uid reaching here with no paint was CLEARED by its owner (a live
    // cosmetic push is the only way an unpainted uid gets into this list —
    // see hsForcedRepaint in paints.js). Strip ours instead of applying.
    const wasCleared = !getHsPaintClass(uid) || !getHsPaintSpec(uid)
    const mentionSet = _mentionIndex.get(uid)
    if (mentionSet) {
      for (const el of mentionSet) {
        if (wasCleared) clearHsPaintFromElement(el)
        else applyHsPaintToElement(el, uid)
      }
    }
    // kick_ AND yt_ paint uids are namespaced — never in data-uid/_uidIndex
    // (that stays twitch-id-space only, ID-SPACE SAFETY in paints.js). Find
    // their rows via the parallel data-hs-paint-uid attribute (kick via
    // flushKickNameLookups, yt via social.js). Without the yt_ case a resolved
    // youtube paint applied to nothing (updateCosmeticsInPlace already handles it).
    const isNamespacedUid = uid.startsWith('kick_') || uid.startsWith('yt_')
    const divs = isNamespacedUid
      ? container.querySelectorAll(`[data-hs-paint-uid="${CSS.escape(uid)}"]`)
      : _uidIndex.get(uid)
    if (!divs) continue
    for (const div of divs) {
      // The row's primary (twitch) uid resolving its own HS paint outranks
      // this kick-space fallback — matches buildMessageDiv's
      // hsPaintRender(m.userId) || hsPaintRender(m.hsPaintUid) precedence,
      // so a later-resolving kick paint can't clobber an applied twitch one.
      // (was `isKickUid` — an undeclared name that threw a ReferenceError on
      // the FIRST row and killed the whole in-place pass: restored history
      // rows of every painted user stayed on the static fallback color.)
      if (isNamespacedUid && hasResolvedHsPaint(div._hsMsg?.userId)) continue
      const userLink = div.querySelector('.hs-mc-user:not(.hs-mc-reply-user)')
      if (!userLink) continue
      if (wasCleared) clearHsPaintFromElement(userLink)
      else applyHsPaintToElement(userLink, uid)
    }
  }
}

// Apply a resolved PICKED name colour to visible youtube/kick rows in place.
// youtube + kick uids are namespaced (yt_<UCid> / kick_<id>) so their rows
// carry data-hs-paint-uid, never data-uid — same lookup updateHsPaintsInPlace
// uses. NEVER twitch (its rows use data-uid and its colour is the prime perk).
// A resolved HS paint owns the fill, so skip painted names.
function updateHsColorsInPlace(userIds) {
  const container = document.getElementById('hs-mc-messages')
  if (!container) return
  for (const uid of userIds) {
    // Cached colour is already validated #RRGGBB (setHsColorEntry), safe for
    // style.color without re-sanitizing.
    const colour = getHsPickedColor(uid)
    if (!colour) continue
    const divs = container.querySelectorAll(`[data-hs-paint-uid="${CSS.escape(uid)}"]`)
    for (const div of divs) {
      // A row's own resolved paint (twitch-uid or this namespaced uid) wins.
      if (hasResolvedHsPaint(div._hsMsg?.userId) || hasResolvedHsPaint(uid)) continue
      const userLink = div.querySelector('.hs-mc-user:not(.hs-mc-reply-user)')
      // paint class (hsp-) owns the fill via CSS — don't overwrite with a colour.
      if (userLink && !userLink.className.includes('hsp-')) userLink.style.color = colour
    }
  }
}

// Idempotent single-token placement — skips an anchor that already has a
// `.hs-plus-tenure` next sibling (a second resolution of the same batch, or a
// re-render that already inlined the token synchronously).
function _placeHsPlusTenureToken(el, since) {
  if (!el) return
  const next = el.nextElementSibling
  if (next?.classList.contains('hs-plus-tenure')) return
  const token = buildPlusTenureToken(since)
  if (token) el.insertAdjacentElement('afterend', token)
}

/**
 * Take the tenure token back off. Tenure is public only while entitled (the
 * server re-checks on every read), so "no tenure" for a uid that HAD a token
 * means the membership lapsed — leaving it would keep advertising a paid
 * membership that ended.
 */
function _removeHsPlusTenureToken(el) {
  const stale = el?.nextElementSibling
  if (stale?.classList?.contains('hs-plus-tenure')) stale.remove()
}

// Apply a resolved PLUS TENURE token beside visible rows in place — the
// counterpart to updateHsPaintsInPlace above, fired from its own independent
// batch (queuePlusTenureLookup/flushHsPaintBatch in paints.js) once tenure
// resolves. Repaints both the sender username anchor (_uidIndex for a
// twitch-space uid, or a data-hs-paint-uid query for a kick/yt-space uid —
// same lookup updateHsPaintsInPlace uses) and any inline @mention/reply-
// context anchors (_mentionIndex) for this uid.
function applyHsPlusTenureToVisible(userIds) {
  const container = document.getElementById('hs-mc-messages')
  if (!container) return
  for (const uid of userIds) {
    const since = getHsPlusTenureSince(uid)
    const mentionSet = _mentionIndex.get(uid)
    if (mentionSet) {
      // The "+" tenure token is a sender-identity mark, not part of a name
      // wherever it appears. Keep it on the reply-context anchor (a reply
      // header), but NOT on inline @mentions inside message content — a name
      // typed in someone's message shouldn't sprout a "+".
      for (const el of mentionSet) {
        if (!el.classList.contains('hs-mc-reply-user')) continue
        if (since) _placeHsPlusTenureToken(el, since)
        else _removeHsPlusTenureToken(el)
      }
    }
    const isNamespacedUid = uid.startsWith('kick_') || uid.startsWith('yt_')
    const divs = isNamespacedUid
      ? container.querySelectorAll(`[data-hs-paint-uid="${CSS.escape(uid)}"]`)
      : _uidIndex.get(uid)
    if (!divs) continue
    for (const div of divs) {
      const userLink = div.querySelector('.hs-mc-user:not(.hs-mc-reply-user)')
      if (since) _placeHsPlusTenureToken(userLink, since)
      else _removeHsPlusTenureToken(userLink)
    }
  }
}

// Update cosmetics (badges + paint) in-place without full re-render.
// O(1) lookup via _uidIndex / _mentionIndex instead of querySelectorAll over
// the full message container — at 25-user batches × 500 children that was
// 50 full DOM scans per cosmetic flush.
function updateCosmeticsInPlace(userIds) {
  const container = document.getElementById('hs-mc-messages')
  if (!container) return
  for (const uid of userIds) {
    const cosmetic = mcUserCosmetics.get(uid)
    if (!cosmetic) continue
    // Precedence: a HeatSync paint (this user's own choice on our platform)
    // always wins over their 7TV paint. If one is already resolved for this
    // uid, skip the 7TV inline style entirely — applyHsPaintToElement (via
    // updateHsPaintsInPlace) owns painting this element from here on,
    // whichever batch (7TV or HS) resolves first or last.
    const paintStyle = hasResolvedHsPaint(uid) ? '' : getMcPaintStyle(uid)
    // Repaint inline @mentions of this user across all visible messages
    if (paintStyle) {
      const mentionSet = _mentionIndex.get(uid)
      if (mentionSet) {
        for (const mention of mentionSet) mention.setAttribute('style', paintStyle)
      }
    }
    // A `yt_<UCid>` uid (flushYtNameLookups' google-id fallback for yt
    // chatters with no linked Twitch) is never in data-uid — that attribute
    // stays twitch-id-space only (ID-SPACE SAFETY, paints.js) — so it's never
    // in _uidIndex either. Find its rows via the parallel data-hs-paint-uid
    // attribute social.js already stamps, same technique updateHsPaintsInPlace
    // uses for kick_ ids.
    const isNamespacedUid = uid.startsWith('yt_')
    const divSet = isNamespacedUid
      ? container.querySelectorAll(`[data-hs-paint-uid="${CSS.escape(uid)}"]`)
      : _uidIndex.get(uid)
    if (!divSet) continue
    for (const div of divSet) {
      // Update paint on the SENDER's username link — exclude the reply
      // target (.hs-mc-reply-user) which also has .hs-mc-user but is a
      // different person and would get the wrong paint/badge.
      const userLink = div.querySelector('.hs-mc-user:not(.hs-mc-reply-user)')
      if (userLink) {
        if (paintStyle) {
          userLink.setAttribute('style', paintStyle)
        }
      }
      // Add 7TV badge if not already present and cosmetic has one
      if (cosmetic.badge && !div.querySelector('.hs-mc-7tv-badge')) {
        const files = cosmetic.badge.host?.files || []
        const file =
          files.find((f) => f.name?.endsWith('.webp')) || files.find((f) => f.name?.endsWith('.avif')) || files[0]
        if (file) {
          const base = cosmetic.badge.host?.url || ''
          // 7TV returns protocol-relative URLs (//cdn.7tv.app/...) — promote
          // to https before validation so safeUrl doesn't drop them.
          const absBase = base.startsWith('//') ? `https:${base}` : base
          const rawUrl = (absBase.endsWith('/') ? absBase : `${absBase}/`) + file.name
          const url = safeUrl(rawUrl)
          if (url) {
            const img = document.createElement('img')
            img.className = 'hs-mc-badge-img hs-mc-7tv-badge'
            img.alt = '7TV'
            img.title = cosmetic.badge.tooltip || '7TV'
            img.style.cssText = 'width:18px;height:18px;'
            img.dataset.hsSrc = url
            // Insert FIRST, then set src — so an immediate QUIC-drop error
            // fires while the img is already under msgsEl and the capture-phase
            // error handler (→ retryOrHideBadgeImg) catches it.
            if (userLink) userLink.parentNode.insertBefore(img, userLink)
            img.src = url
          }
        }
      }
    }
  }
}

// In-place third-party badge injection (BTTV/FFZ/Chatterino). Mirrors
// updateCosmeticsInPlace's 7TV-badge path: when the bulk badge maps arrive
// late (cold service worker, or the ~24h cosmetics_update broadcast), patch
// the badges into already-rendered rows via _uidIndex (keyed by twitch uid,
// same key renderThirdPartyBadges uses) instead of bumpRenderEpoch()+full
// rebuild — that rebuild tore down every row and reloaded every avatar/emote
// image = the "loads then shifts" flash on channel switch. Per-provider class
// dedups so a warm row (built after the maps populated) isn't double-badged.
// Anchor = before the avatar (or username when avatars are off) so injected
// badges land exactly where buildMessageDiv's ${badges} sits: after native
// badges, before ${avatarHtml}${userLink}.
function updateThirdPartyBadgesInPlace() {
  if (!document.getElementById('hs-mc-messages')) return
  const wantBttv = getSetting('bttvBadges')
  const wantFfz = getSetting('ffzBadges')
  const wantChat = getSetting('chatterinoBadges')
  if (!wantBttv && !wantFfz && !wantChat) return
  const mkBadge = (cls, url, title, bg) => {
    const safe = safeUrl(url)
    if (!safe) return null
    const img = document.createElement('img')
    img.className = `hs-mc-badge-img ${cls}`
    img.alt = title || ''
    img.title = title || ''
    img.decoding = 'async'
    img.width = 18
    img.height = 18
    img.style.cssText = `width:18px;height:18px;${bg ? `background:${bg};` : ''}`
    // Insert FIRST, then set src (caller) — so an immediate QUIC-drop error
    // fires while the img is already under msgsEl and the capture-phase error
    // handler (retryOrHideBadgeImg) catches it. Mirrors updateCosmeticsInPlace.
    img.dataset.hsSrc = safe
    return img
  }
  for (const [uid, divSet] of _uidIndex) {
    const bttv = wantBttv ? mcBttvBadgeMap.get(uid) : null
    const ffzList = wantFfz ? mcFfzBadgeMap.get(uid) : null
    const chat = wantChat ? mcChatterinoBadgeMap.get(uid) : null
    if (!bttv && !ffzList && !chat) continue
    for (const div of divSet) {
      const anchor = div.querySelector('.hs-mc-avatar') || div.querySelector('.hs-mc-user:not(.hs-mc-reply-user)')
      if (!anchor) continue
      const insert = (img) => {
        if (img) {
          anchor.parentNode.insertBefore(img, anchor)
          img.src = img.dataset.hsSrc
        }
      }
      if (bttv && !div.querySelector('.hs-mc-bttv-badge')) {
        insert(mkBadge('hs-mc-bttv-badge', bttv.url, bttv.description))
      }
      if (ffzList && !div.querySelector('.hs-mc-ffz-badge')) {
        for (const b of ffzList) {
          const safeColor = /^#[0-9a-fA-F]{3,8}$/.test(b.color) ? b.color : ''
          insert(mkBadge('hs-mc-ffz-badge', b.url, b.title, safeColor))
        }
      }
      if (chat && !div.querySelector('.hs-mc-chatterino-badge')) {
        insert(mkBadge('hs-mc-chatterino-badge', chat.url, chat.tooltip || 'Chatterino'))
      }
    }
  }
}

// Patch native Twitch/Kick badge imgs into already-rendered rows when
// fetchGlobalBadges, fetchChannelBadges, or fetchKickChannelBadges resolve
// late (cold-load race). Mirrors updateThirdPartyBadgesInPlace: no
// _renderEpoch bump, no full rebuild, no image-reload flash. renderBadges
// now stamps data-badge="name/version" on every badge element (both imgs
// and text-fallback spans) so we can find each slot precisely via
// querySelector.
//
// Dedup: if an img with the correct data-badge already exists (row built
// after badges loaded), we update its src in case a better URL is now
// available (e.g. channel-specific sub badge overrides the global star).
// If only a text-fallback span exists, we replace it with the img.
// If neither exists (badge had no URL + no BADGE_STYLES at render time),
// we insert a new img before the avatar/username anchor — same position
// as build-time.
//
// Per-row patch body — factored out so it can run against BOTH the live
// #hs-mc-messages DOM and every snapshotted (inactive-tab) DocumentFragment
// sitting in _tabCache. Backfill/history rows for a channel that finished
// rendering (join()'s history hydration, which resolves fast off BG's
// in-memory cache) BEFORE fetchGlobalBadges/fetchChannelBadges/
// fetchKickChannelBadges resolve (real network round-trips, reliably
// slower) always lose that race — this in-place patch is what upgrades
// them afterward. Without also covering _tabCache, only whichever tab
// happened to be the live/active one at resolve-time got fixed; any other
// tab the user had already switched away from (snapshotted, detached from
// the document — querySelectorAll on #hs-mc-messages can't see it) stayed
// on stale text-fallback badges until something forced a full rebuild.
function _patchBadgesInRoot(root, channelLogin) {
  for (const div of root.querySelectorAll('.hs-mc-msg')) {
    const m = div._hsMsg
    if (!m?.badges || typeof m.badges !== 'string') continue
    // YouTube badge arrays are not in twitchBadgeUrls — skip
    if (m.platform === 'youtube') continue
    // Channel-specific update: only touch rows for the fetched channel
    if (channelLogin && m.channel !== channelLogin) continue
    const ch = m.channel || null
    const isKick = (m.badgePlatform || m.platform) === 'kick'
    const anchor = div.querySelector('.hs-mc-avatar') || div.querySelector('.hs-mc-user:not(.hs-mc-reply-user)')
    if (!anchor) continue
    for (const badge of m.badges.split(',')) {
      const sep = badge.indexOf('/')
      if (sep < 1) continue
      const name = badge.slice(0, sep)
      const version = badge.slice(sep + 1)
      // Same priority chain renderBadges uses at initial render — shared via
      // resolveBadgeImageUrl (twitch-api.js) so the two can never drift apart.
      const url = resolveBadgeImageUrl(isKick, ch, name, version)
      if (!url) continue
      const safeU = safeUrl(url)
      if (!safeU) continue
      const key = `${name}/${version}`
      // Dedup: img already present — update src if a better URL is available
      const existingImg = div.querySelector(`img.hs-mc-badge-img[data-badge="${key}"]`)
      if (existingImg) {
        if (existingImg.getAttribute('src') !== safeU) {
          existingImg.dataset.hsSrc = safeU
          existingImg.src = safeU
        }
        continue
      }
      // Build replacement img matching renderBadges output
      const isFFZ = ch && ffzBadgeKeys.has(`${ch}:${name}`)
      const img = document.createElement('img')
      img.className = 'hs-mc-badge-img'
      img.dataset.badge = key
      img.alt = name
      img.title = BADGE_STYLES[name]?.label || name
      img.decoding = 'async'
      img.width = 18
      img.height = 18
      img.style.cssText = `width:18px;height:18px;${badgeBgStyle(name, isFFZ)}`
      img.dataset.hsSrc = safeU
      // Replace text-fallback span if present; else insert before anchor.
      // Set src after DOM insertion so the capture-phase retryOrHideBadgeImg
      // error handler fires while the img is already attached.
      const existingSpan = div.querySelector(`span.hs-mc-badge[data-badge="${key}"]`)
      if (existingSpan) {
        existingSpan.parentNode.replaceChild(img, existingSpan)
      } else {
        anchor.parentNode.insertBefore(img, anchor)
      }
      img.src = safeU
    }
  }
}

// channelLogin: null  = global badges just loaded (update all rows)
//               string = channel badges for that specific channel only
function updateNativeBadgesInPlace(channelLogin) {
  const msgsEl = document.getElementById('hs-mc-messages')
  if (msgsEl) _patchBadgesInRoot(msgsEl, channelLogin)
  // Also patch every OTHER tab's snapshotted fragment (see _patchBadgesInRoot's
  // comment) instead of the old approach of just _dropAllTabCaches()-ing them —
  // that forced a full rebuild (avatar/emote/badge image reload flash) on next
  // visit just to fix a handful of badge imgs. A DocumentFragment supports the
  // same querySelectorAll surface as a live Element, so this is exactly as cheap.
  for (const cache of _tabCache.values()) {
    if (cache?.frag) _patchBadgesInRoot(cache.frag, channelLogin)
  }
}

// 7TV paint → CSS style string
// 7TV paint → CSS is static per paint object but getMcPaintStyle runs per
// sender + per @mention + inside updateCosmeticsInPlace, re-deriving the same
// gradient/shadow string (map/join/toFixed churn) every render. Memoize on the
// paint object: a WeakMap auto-evicts when the cosmetic is dropped, and keying
// on identity means a replaced paint recomputes with no manual invalidation.
const _mcPaintStyleCache = new WeakMap()
function getMcPaintStyle(userId) {
  if (!getSetting('sevenTvPaints')) return ''
  const cosmetic = mcUserCosmetics.get(userId)
  const paint = cosmetic?.paint
  if (!paint?.function) return ''
  const cached = _mcPaintStyleCache.get(paint)
  if (cached !== undefined) return cached
  const style = _computeMcPaintStyle(paint)
  _mcPaintStyleCache.set(paint, style)
  return style
}
function _computeMcPaintStyle(paint) {
  const fn = paint.function.toLowerCase()
  if (fn === 'url' && paint.image_url) {
    if (!/^https:\/\//.test(paint.image_url)) return ''
    const safeCssUrl = paint.image_url.replace(/[()'"\\;{}]/g, encodeURIComponent)
    let style = `background-image:url(${safeCssUrl});background-size:cover;-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text`
    if (paint.shadows?.length) {
      style +=
        ';filter:' +
        paint.shadows
          .map((s) => {
            const r = (s.color >>> 24) & 0xff
            const g = (s.color >>> 16) & 0xff
            const b = (s.color >>> 8) & 0xff
            const a = (s.color & 0xff) / 255
            return `drop-shadow(${Number(s.x_offset) || 0}px ${Number(s.y_offset) || 0}px ${Number(s.radius) || 0}px rgba(${r},${g},${b},${a.toFixed(2)}))`
          })
          .join(' ')
    }
    return style
  }
  if (
    (fn === 'linear-gradient' || fn === 'radial-gradient' || fn === 'linear_gradient' || fn === 'radial_gradient') &&
    paint.stops?.length
  ) {
    const stops = paint.stops
      .map((s) => {
        const r = (s.color >>> 24) & 0xff
        const g = (s.color >>> 16) & 0xff
        const b = (s.color >>> 8) & 0xff
        const a = (s.color & 0xff) / 255
        return `rgba(${r},${g},${b},${a.toFixed(2)}) ${Math.round(s.at * 100)}%`
      })
      .join(', ')
    const safeAngle = Number.isFinite(Number(paint.angle)) ? Number(paint.angle) : 0
    const safeShape = /^(circle|ellipse)$/.test(paint.shape) ? paint.shape : 'circle'
    const grad =
      fn === 'linear-gradient' || fn === 'linear_gradient'
        ? `linear-gradient(${safeAngle}deg, ${stops})`
        : `radial-gradient(${safeShape}, ${stops})`
    let style = `background:${grad};-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text`
    if (paint.shadows?.length) {
      style +=
        ';filter:' +
        paint.shadows
          .map((s) => {
            const r = (s.color >>> 24) & 0xff
            const g = (s.color >>> 16) & 0xff
            const b = (s.color >>> 8) & 0xff
            const a = (s.color & 0xff) / 255
            return `drop-shadow(${Number(s.x_offset) || 0}px ${Number(s.y_offset) || 0}px ${Number(s.radius) || 0}px rgba(${r},${g},${b},${a.toFixed(2)}))`
          })
          .join(' ')
    }
    return style
  }
  if (paint.color) {
    const r = (paint.color >>> 24) & 0xff
    const g = (paint.color >>> 16) & 0xff
    const b = (paint.color >>> 8) & 0xff
    const a = (paint.color & 0xff) / 255
    return `color:rgba(${r},${g},${b},${a.toFixed(2)})`
  }
  return ''
}

// Resolve a 7TV paint CSS string for any username surface (reply context,
// whispers, DMs, profile cards). Prefers an explicit Twitch userId; falls
// back to the lowercase-name → uid map (same path as inline @mentions).
// Queues a cosmetics lookup when the uid is known but not yet cached, so the
// paint lands on the next render/in-place repaint. Returns '' when no paint
// is available — callers fall back to their plain color.
function userPaintStyle(uid, lower, platform) {
  if (!uid && lower) uid = knownUserIds.get(userKey(lower, platform)) || ''
  if (!uid) return ''
  if (!mcUserCosmetics.has(uid)) queueMcCosmeticsLookup(uid)
  return getMcPaintStyle(uid)
}
