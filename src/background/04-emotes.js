// background part 4 of 11 — emote fetch, 7tv event api, bttv polling.
// build.js concatenates src/background/* in BG_PARTS order into background.js (the service worker cannot import);
// one scope, so a later part may read an earlier part's constants, never the reverse.

// The channel-owner lookup. The same login is three different people across
// platforms (a twitch "ninja" is not a kick "ninja"), so the route is told which
// platform's channel this is; the bare-name form has to guess. A platform it has no
// word for (never expected) sends no param — the guess, as before.
function channelOwnerEmotesUrl(channelName, platform) {
  const p = canonPlatform(platform)
  const q = p === 'twitch' || p === 'kick' || p === 'youtube' ? `?platform=${p}` : ''
  return withNsfwParam(`${API_URL}/api/emotes/user/${encodeURIComponent(channelName)}${q}`)
}

// A channel-owner emote off the wire, kept to what render uses. `variants` (the
// smaller copies of the file) and width/height (the natural size — lets the chat
// reserve the emote's box before the file arrives) are optional: a server that
// sends neither yields exactly the {name,url,hash,provider} record this has
// always been. Everything is bounded here and re-checked where it is used
// (multichat emote-rungs.js), so a bad payload costs a missing optimisation,
// never a wrong picture.
//   variants  list ["1x","2x",...]  or  object {"1x": url, "2x": url, ...}
function mapChannelOwnerEmote(e) {
  const out = {
    name: e.name,
    url: absUrl(e.url),
    hash: e.hash || e.name,
    provider: e.provider || 'upload',
  }
  const v = e.variants
  if (Array.isArray(v)) {
    const rungs = v.filter((r) => typeof r === 'string' && /^[1-4]x$/.test(r)).slice(0, 4)
    if (rungs.length) out.variants = rungs
  } else if (v && typeof v === 'object') {
    const rungs = {}
    for (const r of ['1x', '2x', '3x', '4x']) {
      const u = typeof v[r] === 'string' ? absUrl(v[r]) : null
      if (u && u.length <= 300 && EMOTE_CDN_PATTERN.test(u)) rungs[r] = u
    }
    if (Object.keys(rungs).length) out.variants = rungs
  }
  const w = Number(e.width)
  const h = Number(e.height)
  if (Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0 && w <= 4096 && h <= 4096) {
    out.width = w
    out.height = h
  }
  return out
}

// Fetch channel owner's emotes (public API) + third-party channel emotes
async function fetchChannelOwnerEmotes(channelName, channelId = null, platform = 'twitch') {
  const key = chKey(platform, channelName)
  // Skip if already fetched, or currently loading (sentinel prevents race)
  const cached = channelEmotesMap[key]
  // Kept for the failure path: a failed refetch falls back to this instead of
  // erasing the channel's emotes (stale beats missing).
  const prevCached = Array.isArray(cached) ? cached : null
  if (cached === 'loading') {
    log(' Channel emotes currently loading for', channelName, '- skipping')
    return
  }
  if (Array.isArray(cached)) {
    const age = Date.now() - (channelEmotesFetchedAt[key] || 0)
    const ttl = cached.length > 0 ? CHANNEL_EMOTES_TTL : CHANNEL_EMOTES_EMPTY_TTL
    // Always broadcast cached data immediately — content script needs emotes NOW
    broadcastToTabs({ type: 'channel_emotes_update', emotes: cached, channelOwner: channelName, platform })
    if (age < ttl) {
      log(
        ' Channel emotes already fetched for',
        channelName,
        '- skipping (',
        cached.length,
        'emotes,',
        `${Math.round(age / 1000)}s old)`,
      )
      return
    }
    log(' Channel emotes stale for', channelName, '(', `${Math.round(age / 1000)}s) - refetching in background`)
  }
  channelEmotesMap[key] = 'loading'

  try {
    log(' 📺 Fetching channel emotes for:', channelName, 'id:', channelId, 'platform:', platform)

    // Show loading indicator
    broadcastToTabs({ type: 'loading_status', text: bgT('bg_loading_channel') })

    // Fetch heatsync emotes + resolve the platform channel ID in PARALLEL (both
    // needed before third-party fetch). IMPORTANT: each platform resolves its
    // OWN identity system here — a Twitch username must never be looked up via
    // lookupTwitchUserId for a Kick/YouTube channelName, that's a cross-platform
    // identity bleed (wrong user's emotes/cosmetics attached to this channel).
    const [heatsyncResult, resolvedChannelId] = await Promise.all([
      fetchWithTimeout(channelOwnerEmotesUrl(channelName, platform)).catch(() => null),
      platform === 'twitch' && !channelId
        ? lookupTwitchUserId(channelName)
        : platform === 'youtube' && !/^UC[\w-]{20,}$/i.test(String(channelId || ''))
          ? resolveYtChannelId(channelName, channelId)
          : Promise.resolve(channelId),
    ])
    let heatsyncEmotes = []
    if (heatsyncResult?.status === 429) {
      // Heatsync API rate-limited — skip the heatsync emote slot but DO NOT
      // bail the whole fetch. BTTV/FFZ/7TV/Twitch are independent providers;
      // a heatsync 429 should never starve the channel of its third-party
      // emote set. (Pre-fix this returned, leaving the cache empty until next
      // manual join — channels would silently lose all 7TV emotes.)
      console.warn(
        '[heatsync] fetchChannelOwnerEmotes: heatsync 429 for',
        channelName,
        '— continuing third-party fetch',
      )
      heatsyncResult.body?.cancel()
      // heatsyncEmotes stays [] (default); flow continues to third-party tasks
    } else if (heatsyncResult?.ok) {
      const data = await heatsyncResult.json()
      heatsyncEmotes = (data.emotes || []).map(mapChannelOwnerEmote)
    }
    channelId = resolvedChannelId

    // Fetch third-party emotes in PARALLEL — broadcast progressively as each provider
    // returns so the user sees BTTV/FFZ instantly while 7TV resolves (avoids "no emotes
    // until everything's done"). Keep slots fixed so priority order is stable.
    broadcastToTabs({ type: 'loading_status', text: bgT('bg_loading_third') })
    const slots = { bttv: [], ffz: [], sevenTV: [], twitch: [], kick: [] }
    const failed = { bttv: false, ffz: false, sevenTV: false, twitch: false, kick: false }
    let sevenTVResult = null
    let coalesceTimer = null
    // Refresh-class fetch (an existing non-empty set is being revalidated —
    // the 30min TTL or a post-SW-restart pass): suppress the per-provider
    // partial broadcasts and ship ONLY the final consolidated set. The
    // tab-side cache rebuilds from each payload as if it were complete, so a
    // BTTV-only partial wiped the other providers' entries and made them look
    // brand-new on the next partial — false hadAdds → full-row reprocess →
    // the "random ~30min full-panel flash". Cold joins keep the progressive
    // paints: nothing is rendered yet, so there is nothing to flash.
    const isRefresh = Array.isArray(prevCached) && prevCached.length > 0
    const broadcastCurrent = () => {
      if (isRefresh) return
      clearTimeout(coalesceTimer)
      coalesceTimer = setTimeout(() => {
        coalesceTimer = null
        const partial = [
          ...heatsyncEmotes,
          ...slots.bttv,
          ...slots.ffz,
          ...slots.sevenTV,
          ...slots.twitch,
          ...slots.kick,
        ]
        broadcastToTabs({ type: 'channel_emotes_update', emotes: partial, channelOwner: channelName, platform })
      }, 40)
    }

    const tasks = []
    if (platform === 'twitch') {
      tasks.push(
        fetchBTTVChannelEmotes(channelName, channelId, platform)
          .then((e) => {
            if (e === null) failed.bttv = true
            slots.bttv = e || []
            broadcastCurrent()
          })
          .catch(() => {
            failed.bttv = true
          }),
      )
      tasks.push(
        fetchFFZChannelEmotes(channelName)
          .then((e) => {
            if (e === null) failed.ffz = true
            slots.ffz = e || []
            broadcastCurrent()
          })
          .catch(() => {
            failed.ffz = true
          }),
      )
      tasks.push(
        fetchTwitchChannelEmotes(channelName)
          .then((e) => {
            if (e === null) failed.twitch = true
            slots.twitch = e || []
            broadcastCurrent()
          })
          .catch(() => {
            failed.twitch = true
          }),
      )
    } else if (platform === 'kick') {
      // No BTTV/FFZ for Kick (neither provider supports it). Kick-native
      // channel + Global emotes join the same pool Twitch-native does.
      tasks.push(
        fetchKickChannelEmotes(channelName)
          .then((e) => {
            if (e === null) failed.kick = true
            slots.kick = e || []
            broadcastCurrent()
          })
          .catch(() => {
            failed.kick = true
          }),
      )
    } else if (platform === 'youtube') {
      // No FFZ (no YouTube support) and no Twitch-native calls — those would
      // treat a YouTube handle/id as a Twitch identity.
      tasks.push(
        fetchBTTVChannelEmotes(channelName, channelId, platform)
          .then((e) => {
            if (e === null) failed.bttv = true
            slots.bttv = e || []
            broadcastCurrent()
          })
          .catch(() => {
            failed.bttv = true
          }),
      )
    }
    tasks.push(
      fetch7TVChannelEmotes(channelName, channelId, platform)
        .then((r) => {
          if (r === null) {
            failed.sevenTV = true
            slots.sevenTV = []
            broadcastCurrent()
            return
          }
          sevenTVResult = r
          slots.sevenTV = r?.emotes || (Array.isArray(r) ? r : []) || []
          broadcastCurrent()
        })
        .catch(() => {
          failed.sevenTV = true
        }),
    )

    await Promise.all(tasks)
    // Final consolidated broadcast (force-flush any pending coalesce)
    if (coalesceTimer) {
      clearTimeout(coalesceTimer)
      coalesceTimer = null
    }
    // Per-provider stale salvage — a transient provider failure during a
    // REFRESH must not strip that provider's emotes from the consolidated
    // set: an idle tab never re-joins, so the ~60s backdated retry only
    // fires on the next manual join and the loss sticks — the recurring
    // "emotes turned to text mid-session" report (7tv.io latency spikes past
    // the fetch timeout are the usual trigger). Stale beats missing, per
    // provider — same philosophy as the whole-fetch fallback in the catch
    // below. Third-party entries carry `source`; heatsync entries don't.
    if (isRefresh) {
      const SALVAGE = { bttv: 'bttv', ffz: 'ffz', sevenTV: '7tv', twitch: 'twitch', kick: 'kick' }
      for (const [slot, src] of Object.entries(SALVAGE)) {
        if (failed[slot] && slots[slot].length === 0) {
          slots[slot] = prevCached.filter((e) => e && e.source === src)
          if (slots[slot].length) log(` ♻️ ${src} refetch failed — keeping ${slots[slot].length} stale entries`)
        }
      }
      if (!heatsyncResult?.ok && heatsyncEmotes.length === 0) {
        heatsyncEmotes = prevCached.filter((e) => e && !e.source)
        if (heatsyncEmotes.length) log(` ♻️ heatsync refetch failed — keeping ${heatsyncEmotes.length} stale entries`)
      }
    }
    const sevenTVEmotes = slots.sevenTV
    const sevenTVSetId = sevenTVResult?.setId || null
    const bttvEmotes = slots.bttv
    const ffzEmotes = slots.ffz
    const twitchChannelEmotes = slots.twitch
    const kickChannelEmotes = slots.kick
    if (DEBUG)
      broadcastToTabs({
        type: 'debug_log',
        msg: `${channelName} BTTV:${bttvEmotes.length} FFZ:${ffzEmotes.length} 7TV:${sevenTVEmotes.length} Twitch:${twitchChannelEmotes.length} Kick:${kickChannelEmotes.length} HS:${heatsyncEmotes.length}`,
      })

    // Store emotes for this specific channel (prune old entries to bound memory)
    const emotes = rankEmotePool(
      [...heatsyncEmotes, ...bttvEmotes, ...ffzEmotes, ...sevenTVEmotes, ...twitchChannelEmotes, ...kickChannelEmotes],
      'channel',
    )
    const anyFailed = failed.bttv || failed.ffz || failed.sevenTV || failed.twitch || failed.kick
    await stampThirdPartyFlags(emotes, channelName, platform)
    channelEmotesMap[key] = emotes
    // If any provider had a transient failure, backdate fetchedAt so the next
    // channel join refetches within ~60s (regardless of empty/non-empty TTL).
    channelEmotesFetchedAt[key] = anyFailed ? Date.now() - CHANNEL_EMOTES_TTL + 60000 : Date.now()
    if (anyFailed) {
      log(' ⚠️ Channel emotes fetched with failures', failed, '— will retry in ~90s')
      scheduleEmoteRefetch()
    }
    const channelKeys = Object.keys(channelEmotesMap).filter((k) => channelEmotesMap[k] !== 'loading')
    if (channelKeys.length > 20) {
      for (const old of channelKeys.slice(0, channelKeys.length - 20)) {
        if (old !== key) {
          delete channelEmotesMap[old]
          delete channelEmotesFetchedAt[old]
          const evictedSetId = seventvEmoteSetIds.get(old)
          seventvEmoteSetIds.delete(old)
          release7TVEmoteSet(evictedSetId)
          seventvPolledChannels.delete(old)
          const evictedRoom = bttvRoomIds.get(old)
          if (evictedRoom) {
            bttvRoomIds.delete(old)
            partBTTVRoom(evictedRoom)
            browser.storage.local.set({ bttv_room_ids: Object.fromEntries(bttvRoomIds) }).catch(() => {})
          }
        }
      }
    }

    // Update channelOwner in all tab entries that match this channel
    let ownerUpdated = false
    for (const [_tabId, entry] of tabChannels) {
      if (entry.channel?.endsWith(`/${channelName}`)) {
        entry.channelOwner = channelName
        ownerUpdated = true
      }
    }
    if (ownerUpdated) saveTabChannels()
    log(
      ' ✅ Channel emotes loaded for',
      `${channelName}:`,
      emotes.length,
      `(heatsync: ${heatsyncEmotes.length}, bttv: ${bttvEmotes.length}, ffz: ${ffzEmotes.length}, 7tv: ${sevenTVEmotes.length}, twitch: ${twitchChannelEmotes.length}, kick: ${kickChannelEmotes.length})`,
    )

    // Hide loading indicator
    broadcastToTabs({ type: 'loading_status', done: true })

    // Broadcast to content scripts (include channel owner name for filtering)
    broadcastToTabs({ type: 'channel_emotes_update', emotes, channelOwner: channelName, platform })

    // Save per-channel map to storage for persistence (filter out 'loading' sentinels)
    await browser.storage.local.set({
      channel_emotes_map: getStorableChannelEmotes(),
      channel_emotes_fetched_at: channelEmotesFetchedAt,
    })

    // Store 7TV set ID per channel and subscribe on shared EventAPI connection
    if (sevenTVSetId) {
      seventvEmoteSetIds.set(key, sevenTVSetId)
      subscribe7TVEmoteSet(sevenTVSetId)
      start7TVPolling()
      // Persist so all channels survive service worker restart
      browser.storage.local.set({ seventv_emote_set_ids: Object.fromEntries(seventvEmoteSetIds) }).catch(() => {})
    }
    // BTTV/FFZ have no (or an unreliable) push channel — the poll is their
    // live-update guarantee. Unconditional: runs even for channels with no 7TV.
    startThirdPartyPolling()
  } catch (error) {
    log(' ❌ Channel emotes fetch failed:', error.message || error)
    broadcastToTabs({ type: 'loading_status', done: true })
    // A failed REFETCH must fall back to the stale copy, not erase it — the
    // old `delete` here threw away a restored cache on one transient 7TV/BTTV
    // flake during the post-reload herd, leaving the channel emote-less for
    // the whole session (and the deletion persisted on the next storage
    // write). Stale emotes render; missing emotes don't. fetchedAt stays old,
    // so the next join retries the refresh.
    if (Array.isArray(prevCached)) {
      channelEmotesMap[key] = prevCached
      broadcastToTabs({ type: 'channel_emotes_update', emotes: prevCached, channelOwner: channelName, platform })
    } else {
      // Nothing to fall back to — clear the sentinel so the next join retries.
      delete channelEmotesMap[key]
    }
    // Keep any existing 7TV set mapping + subscription: the set still exists
    // server-side, so live pushes keep flowing against the stale list, and the
    // retry alarm reconciles the set id on the next successful fetch. Deleting
    // it here orphaned the channel from BOTH the EventAPI and the fallback
    // poll (which iterates seventvEmoteSetIds) — a silent permanent blackout.
    scheduleEmoteRefetch()
  }
}

// One-shot retry alarm for failed channel-emote fetches. chrome.alarms
// survives SW eviction (a bare setTimeout dies with the worker). Re-arming on
// every failure just pushes the retry out — fine, it stays one-shot.
function scheduleEmoteRefetch() {
  browser.alarms?.create?.('hs-emote-refetch', { delayInMinutes: 1.5 })
}

// Fetch BTTV global emotes
async function fetchBTTVEmotes() {
  try {
    const response = await fetchWithTimeout('https://api.betterttv.net/3/cached/emotes/global')
    if (!response.ok) {
      response.body?.cancel()
      return []
    }

    const emotes = await response.json()
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
  } catch (_error) {
    return []
  }
}

// Fetch FFZ global emotes
async function fetchFFZEmotes() {
  try {
    const response = await fetchWithTimeout('https://api.frankerfacez.com/v1/set/global')
    if (!response.ok) {
      response.body?.cancel()
      return []
    }

    const data = await response.json()
    const emotes = []

    const defaultSets = data?.default_sets || []
    for (const set of Object.values(data?.sets || {})) {
      if (defaultSets.includes(set.id)) {
        for (const emote of set.emoticons || []) {
          // Skip FFZ modifier emotes — see fetchFFZChannelEmotes. They're typed
          // tokens (modifiers.js), not pool images.
          if (emote.modifier) continue
          // FFZ exposes animated emotes under emote.animated (animated webp);
          // emote.urls is the static PNG first-frame. Prefer animated when present.
          const srcs = emote.animated || emote.urls
          if (!srcs) continue
          const rawUrl = srcs['1'] || srcs['2'] || srcs['4']
          if (!rawUrl) continue
          emotes.push({
            name: emote.name,
            url: rawUrl.startsWith('https:') ? rawUrl : `https:${rawUrl}`,
            source: 'ffz',
            hash: `ffz-${emote.id}`,
          })
        }
      }
    }

    return sanitizeEmoteList(emotes)
  } catch (_error) {
    return []
  }
}

// Fetch 7TV global emotes — uses ETag conditional GET so 7TV can answer 304
// when their global set hasn't changed (saves them ~30KB payload per check).
// On 304 we reuse the previously parsed list from chrome.storage.local.
const GLOBAL_7TV_CACHE_KEY = 'hs_7tv_global_cache'
async function fetch7TVEmotes() {
  try {
    const response = await fetchWithEtag('https://7tv.io/v3/emote-sets/global')
    if (response.notModified) {
      const got = await browser.storage.local.get(GLOBAL_7TV_CACHE_KEY)
      return Array.isArray(got[GLOBAL_7TV_CACHE_KEY]) ? got[GLOBAL_7TV_CACHE_KEY] : []
    }
    if (!response.ok) {
      response.body?.cancel?.()
      return []
    }

    const data = await response.json()
    stvCheckShape('global', data)
    const emotes = sanitizeEmoteList(
      (data?.emotes || []).map((e) => ({
        name: e.name,
        url: `https://cdn.7tv.app/emote/${e.id}/1x.avif`,
        source: '7tv',
        hash: e.id,
        animated: !!e.data?.animated,
        flags: e.flags || e.data?.flags || 0,
        zeroWidth: !!(e.flags & 257 || e.data?.flags & 257),
      })),
    )
    try {
      await browser.storage.local.set({ [GLOBAL_7TV_CACHE_KEY]: emotes })
    } catch {}
    return emotes
  } catch (_error) {
    stvCheckParse('global', _error)
    return []
  }
}

// Fetch Twitch native global emotes (Kappa, PogChamp, etc.)
async function fetchTwitchGlobalEmotes() {
  try {
    const response = await fetchWithTimeout(`${API_URL}/api/emotes/twitch/global`)
    if (!response.ok) {
      response.body?.cancel()
      log('⚠️ Twitch global emotes failed:', response.status)
      return []
    }

    const data = await response.json()
    const emotes = (data?.emotes || []).map((e) => ({
      name: e.name,
      url: e.url,
      url_2x: e.url_2x,
      url_4x: e.url_4x,
      source: 'twitch',
      hash: e.id,
    }))

    const validated = sanitizeEmoteList(emotes)
    log('✅ Loaded', validated.length, 'Twitch global emotes from server')
    return validated
  } catch (error) {
    log('❌ Twitch global emotes error:', error)
    return []
  }
}

// Fetch Twitch channel emotes (subscriber, follower, bits tier)
async function fetchTwitchChannelEmotes(channelName) {
  try {
    const response = await fetchWithTimeout(`${API_URL}/api/emotes/twitch/channel/${channelName}`)
    if (response.status === 404) {
      response.body?.cancel()
      return []
    } // genuine: channel has no twitch emotes
    if (!response.ok) {
      response.body?.cancel()
      log(' Twitch channel emotes failed for', channelName, ':', response.status)
      return null // transient: 5xx etc.
    }

    const data = await response.json()
    log(' Loaded', data.count, 'Twitch channel emotes for', channelName)

    return sanitizeEmoteList(
      (data?.emotes || []).map((e) => ({
        name: e.name,
        url: e.url,
        source: 'twitch',
        hash: e.id,
        url_2x: e.url_2x,
        url_4x: e.url_4x,
        tier: e.tier,
        emote_type: e.emote_type,
      })),
    )
  } catch (error) {
    log(' Twitch channel emotes error for', channelName, ':', error?.message)
    return null // transient
  }
}

// Fetch Kick channel-native emotes: the channel's own set + Kick's Global
// set (Kick has no separate global-emote fetch cycle anywhere in this
// codebase, so folding Global in here is the only way viewers ever see it —
// same call already merges BTTV's channelEmotes+sharedEmotes above). The
// "Emojis" set is Kick's built-in unicode-emoji reskin, not a real emote
// provider — skipped like every other provider skips emoji.
// Direct BG fetch, no tab relay: this is a public GET, same as
// resolveKickChannelIdBg/kick_channel_badges above — Cloudflare only gates
// credentialed kick.com mutations (those go through a kick.com tab for
// session cookies), not public reads from the service worker.
async function fetchKickChannelEmotes(channelName) {
  try {
    const response = await fetchWithTimeout(`https://kick.com/emotes/${encodeURIComponent(channelName)}`)
    if (response.status === 404) {
      response.body?.cancel()
      return [] // genuine: channel has no Kick emote sets
    }
    if (!response.ok) {
      response.body?.cancel()
      log(' Kick channel emotes failed for', channelName, ':', response.status)
      return null // transient: 5xx etc.
    }

    const data = await response.json()
    if (!Array.isArray(data)) return []

    const out = []
    for (const set of data) {
      if (set?.name === 'Emojis') continue
      for (const e of set?.emotes || []) {
        if (!e?.id || !e?.name) continue
        out.push({
          name: e.name,
          url: `https://files.kick.com/emotes/${e.id}/fullsize`,
          source: 'kick',
          hash: String(e.id),
          // Carried through so the client-side pool build can exclude these
          // the same way it excludes tier-gated Twitch emotes — mirrors
          // fetchTwitchChannelEmotes's tier/emote_type fields above.
          subscribersOnly: !!e.subscribers_only,
        })
      }
    }
    log(' Loaded', out.length, 'Kick channel emotes for', channelName)
    return sanitizeEmoteList(out)
  } catch (error) {
    log(' Kick channel emotes error for', channelName, ':', error?.message)
    return null // transient
  }
}

// Rule 3, winner first (bare word, no sender ref): a channel's set is ffz, 7tv, bttv; globals are
// 7tv, bttv, ffz, twitch. Mirrors EMOTE_TIER_ORDER / rankEmotePool in src/lib/utils.js (this file
// can't import lib — tests/emote-tier-order.test.js pins the two together). Entries with no
// `source` (the channel owner's heatsync set) stay in front.
const EMOTE_TIER_ORDER = {
  channel: ['ffz', '7tv', 'bttv', 'twitch', 'kick'],
  global: ['7tv', 'bttv', 'ffz', 'twitch'],
}
function rankEmotePool(list, tier) {
  const order = EMOTE_TIER_ORDER[tier] || EMOTE_TIER_ORDER.global
  const rank = (e) => {
    if (!e?.source) return tier === 'channel' ? -1 : order.length
    const i = order.indexOf(e.source)
    return i === -1 ? order.length : i
  }
  // Array.prototype.sort is stable: equal ranks keep their input order
  return [...(list || [])].sort((a, b) => rank(a) - rank(b))
}

function fetchGlobalEmotes() {
  if (globalEmotesFetchPromise) return globalEmotesFetchPromise
  globalEmotesFetchPromise = (async () => {
    try {
      log(' Fetching global emotes from', `${API_URL}/api/emotes`)
      // Try server API first (has all providers cached)
      const response = await fetchWithTimeout(withNsfwParam(`${API_URL}/api/emotes`))
      log(' Global emotes response:', response.status, response.ok)
      if (response.ok) {
        const data = await response.json()
        globalEmotes = sanitizeEmoteList(
          (data?.emotes || []).map((e) => ({
            name: e.name,
            url: e.url,
            source: e.provider,
            hash: e.hash,
            zeroWidth: !!e.zeroWidth,
            os: e.os > 1 ? Math.min(2, +e.os) : undefined,
          })),
        )
        log(' Loaded', globalEmotes.length, 'global emotes from server')
        log(
          ' Sample global emotes:',
          globalEmotes.slice(0, 5).map((e) => e.name),
        )

        // ALWAYS fetch Twitch + 7TV global emotes separately (server cache may be stale)
        log('📥 Fetching Twitch + 7TV globals separately...')
        const [twitchGlobals, seventvGlobals] = await Promise.all([fetchTwitchGlobalEmotes(), fetch7TVEmotes()])

        // Rebuild merged array (prevents duplicate accumulation on reconnects).
        // One name keeps ONE entry — the winner of the rule-3 global order (7tv, bttv, ffz,
        // twitch). 7TV's own fetch leads, so its authoritative zeroWidth flags beat the
        // server cache's.
        const seen = new Set()
        const merged = []
        for (const e of rankEmotePool([...seventvGlobals, ...twitchGlobals, ...globalEmotes], 'global')) {
          if (!seen.has(e.name)) {
            seen.add(e.name)
            merged.push(e)
          }
        }
        globalEmotes = merged
        log(
          '✅ Merged globals:',
          globalEmotes.length,
          '(twitch:',
          twitchGlobals.length,
          '7tv:',
          seventvGlobals.length,
          ')',
        )

        log('📊 Total global emotes:', globalEmotes.length)

        broadcastToTabs({ type: 'global_emotes_update', emotes: globalEmotes })
        return
      }
      log(' Server API failed, trying fallback')

      // Fallback: fetch directly from APIs
      const [bttv, ffz, sevenTV, twitchGlobal] = await Promise.all([
        fetchBTTVEmotes(),
        fetchFFZEmotes(),
        fetch7TVEmotes(),
        fetchTwitchGlobalEmotes(),
      ])

      globalEmotes = rankEmotePool([...bttv, ...ffz, ...sevenTV, ...twitchGlobal], 'global')
      log(' Loaded', globalEmotes.length, 'global emotes (fallback)')
      broadcastToTabs({ type: 'global_emotes_update', emotes: globalEmotes })
    } catch (error) {
      console.error('[heatsync] fetchGlobalEmotes failed:', error.message || error)
    } finally {
      globalEmotesFetchPromise = null
    }
  })()
  return globalEmotesFetchPromise
}

// ========== 7TV EventAPI WebSocket for Real-Time Emote Updates ==========
// Single shared connection, multiple subscriptions (one per channel's emote set).
// 7TV allows up to 500 subs per connection.
let seventvWebSocket = null
let seventvReconnectAttempts = 0
let seventvReconnectTimer = null
let seventvLastData = 0
let seventvZombieTimer = null
const seventvSubscribedSets = new Set() // Track which set IDs we've subscribed to
const seventvPendingSubs = new Set() // Queued while connection is opening
const SEVENTV_MAX_RECONNECT_ATTEMPTS = 5
// The Hello payload states how many subscriptions this connection may hold.
// Unknown until it lands, then honored for both set and user subscriptions.
let seventvSubLimit = Infinity
// Idle disconnect: the socket only carries emote/cosmetic deltas for open
// platform tabs — at zero tabs every event is discarded work, so we close
// after a short grace and reconnect when a tab returns (subs replay on open).
let seventvIdleClosed = false
let seventvIdleTimer = null
const SEVENTV_IDLE_GRACE_MS = 5000
const SEVENTV_PLATFORM_URLS = ['*://*.twitch.tv/*', '*://*.kick.com/*', '*://*.youtube.com/*', '*://*.heatsync.org/*']

function ensure7TVConnection() {
  if (seventvWebSocket && seventvWebSocket.readyState !== WebSocket.CLOSED) {
    return // Already connected, connecting, or closing
  }
  // Any explicit connect intent (subscribe from a live tab, watchdog revive)
  // ends the idle state — only the automatic paths honor it.
  seventvIdleClosed = false

  clearTimeout(seventvReconnectTimer)
  seventvReconnectTimer = null
  seventvSubscribedSets.clear()
  // Drop any stale handler refs from a prior socket before creating a new one
  if (seventvWebSocket) {
    try {
      seventvWebSocket.onopen = null
      seventvWebSocket.onmessage = null
      seventvWebSocket.onerror = null
      seventvWebSocket.onclose = null
    } catch {}
    seventvWebSocket = null
  }
  if (seventvZombieTimer) {
    untrackInterval(seventvZombieTimer)
    seventvZombieTimer = null
  }

  log(' 7TV EventAPI: Connecting...')

  try {
    seventvWebSocket = new WebSocket('wss://events.7tv.io/v3')

    seventvWebSocket.onopen = () => {
      log(' 7TV EventAPI: Connected')
      seventvReconnectAttempts = 0
      seventvLastData = Date.now()
      // Zombie detection: force close if no data for 3 minutes
      if (seventvZombieTimer) {
        untrackInterval(seventvZombieTimer)
        seventvZombieTimer = null
      }
      seventvZombieTimer = trackInterval(
        setInterval(() => {
          if (seventvLastData && Date.now() - seventvLastData > 180000) {
            log(' 7TV EventAPI: Zombie detected, forcing reconnect')
            if (seventvWebSocket) {
              try {
                seventvWebSocket.close()
              } catch {}
            }
            if (seventvZombieTimer) {
              untrackInterval(seventvZombieTimer)
              seventvZombieTimer = null
            }
          }
        }, 60000),
      )

      // Subscribe all pending emote sets
      for (const setId of seventvPendingSubs) {
        send7TVSubscribe(setId)
      }
      seventvPendingSubs.clear()
      // Re-subscribe all known user cosmetic subs on (re)connect
      seventvUserSubs.clear()
      for (const userId of pendingUserSubs) {
        send7TVUserSubscribe(userId)
      }
      pendingUserSubs.clear()
      for (const userId of seventvToTwitchId.keys()) {
        send7TVUserSubscribe(userId)
      }
    }

    seventvWebSocket.onmessage = (event) => {
      seventvLastData = Date.now()
      try {
        const message = JSON.parse(event.data)
        const frameProblem = stvEnvelopeProblem(message)
        if (frameProblem) stvCanary('stv-canary:schema', 'events', frameProblem)

        if (message.op === 0) {
          // Dispatch event
          const eventData = message.d
          if (!eventData) return
          log(' 7TV EventAPI: Received event:', eventData.type)
          if (eventData.type === 'emote_set.update') {
            handle7TVEmoteSetUpdate(eventData.body)
          } else if (
            eventData.type === 'user.update' ||
            eventData.type === 'user.create' ||
            eventData.type === 'cosmetic.create' ||
            eventData.type === 'entitlement.create' ||
            eventData.type === 'entitlement.delete'
          ) {
            // User's cosmetics changed (badge/paint granted/revoked).
            // Bust the cache for that user so next lookup refetches fresh.
            handle7TVUserUpdate(eventData.body)
            // EMOTE_SET entitlements carry the chatter's PERSONAL set
            if (eventData.type === 'entitlement.create') capture7TVPersonalEntitlement(eventData.body)
          }
        } else if (message.op === 1) {
          if (message.d?.subscription_limit > 0) seventvSubLimit = message.d.subscription_limit
          log(' 7TV EventAPI: Hello received, session:', message.d.session_id)
        } else if (message.op === 2) {
          // Server heartbeat — no response needed
        } else if (message.op === 5) {
          const subType = message.d?.data?.type
          const subId = message.d?.data?.condition?.object_id
          log(' 7TV EventAPI: Subscription acknowledged:', subType, 'for', subId?.slice(0, 12))
        }
      } catch (err) {
        stvCheckParse('events', err)
        console.error('[heatsync] 7TV EventAPI: Parse error:', err)
      }
    }

    seventvWebSocket.onerror = () => {
      log(' 7TV EventAPI: WebSocket error (will reconnect)')
    }

    seventvWebSocket.onclose = (closeEvent) => {
      log(' 7TV EventAPI: Connection closed')
      const closing = closeEvent?.target
      if (closing) {
        try {
          closing.onopen = null
          closing.onmessage = null
          closing.onerror = null
          closing.onclose = null
        } catch {}
      }
      seventvWebSocket = null
      seventvSubscribedSets.clear()
      seventvUserSubs.clear()
      if (seventvZombieTimer) {
        untrackInterval(seventvZombieTimer)
        seventvZombieTimer = null
      }

      // Deliberate idle close — stay down until a platform tab returns
      // (schedule7TVIdleCheck / the next subscribe call reconnects).
      if (seventvIdleClosed) {
        log(' 7TV EventAPI: idle close (no platform tabs) — not reconnecting')
        return
      }

      if (seventvReconnectAttempts < SEVENTV_MAX_RECONNECT_ATTEMPTS && seventvEmoteSetIds.size > 0) {
        // Jitter scales with the base delay (capped at 30s). At 100k clients
        // a shared 7TV outage hits a wide spread, not a 1s synchronization
        // window — prevents thundering-herd reconnects against 7TV.
        const baseDelay = Math.min(1000 * 2 ** seventvReconnectAttempts, 30000)
        const jitter7tv = Math.random() * baseDelay
        const delay = baseDelay + jitter7tv
        seventvReconnectAttempts++
        log(
          ` 7TV EventAPI: Reconnecting in ${Math.round(delay)}ms (attempt ${seventvReconnectAttempts}/${SEVENTV_MAX_RECONNECT_ATTEMPTS})`,
        )
        clearTimeout(seventvReconnectTimer)
        seventvReconnectTimer = setTimeout(() => {
          seventvReconnectTimer = null
          // Re-subscribe all known sets on reconnect
          for (const setId of seventvEmoteSetIds.values()) {
            subscribe7TVEmoteSet(setId)
          }
        }, delay)
      } else if (seventvReconnectAttempts >= SEVENTV_MAX_RECONNECT_ATTEMPTS) {
        log(' 7TV EventAPI: Max reconnect attempts reached, giving up. Will retry in 10 minutes.')
        clearTimeout(seventvReconnectTimer)
        seventvReconnectAttempts = 0
        seventvWebSocket = null
        seventvReconnectTimer = setTimeout(() => {
          seventvReconnectTimer = null
          ensure7TVConnection()
        }, 600000)
      }
    }
  } catch (err) {
    console.error('[heatsync] 7TV EventAPI: Connection failed:', err)
  }
}

function send7TVSubscribe(setId) {
  if (!seventvWebSocket || seventvWebSocket.readyState !== WebSocket.OPEN) return
  if (seventvSubscribedSets.has(setId)) return
  if (seventvSubscribedSets.size + seventvUserSubs.size >= seventvSubLimit) {
    log(' 7TV EventAPI: subscription_limit reached, skipping set', setId.slice(0, 12))
    return
  }

  seventvWebSocket.send(
    JSON.stringify({
      op: 35,
      d: { type: 'emote_set.*', condition: { object_id: setId } },
    }),
  )
  seventvSubscribedSets.add(setId)
  log(' 7TV EventAPI: Subscribed to', setId.slice(0, 12))
}

/**
 * Drop a set subscription once no channel maps to it. Without the explicit
 * op 36 the subscription lingers on 7TV's side for the life of the socket —
 * a long session that hops channels would keep paying for dead sets and
 * eventually push against subscription_limit.
 */
function release7TVEmoteSet(setId) {
  if (!setId) return
  for (const id of seventvEmoteSetIds.values()) if (id === setId) return // still in use
  seventvPendingSubs.delete(setId)
  if (!seventvSubscribedSets.delete(setId)) return
  if (!seventvWebSocket || seventvWebSocket.readyState !== WebSocket.OPEN) return
  seventvWebSocket.send(
    JSON.stringify({
      op: 36,
      d: { type: 'emote_set.*', condition: { object_id: setId } },
    }),
  )
  log(' 7TV EventAPI: Unsubscribed from', setId.slice(0, 12))
}

// Track per-user 7TV subscriptions so we get real-time badge/paint changes
// for users we care about (logged-in user, currently-watched broadcaster, etc).
const seventvUserSubs = new Set() // 7TV user IDs subscribed for cosmetics
const pendingUserSubs = new Set() // queued while WS is opening

function send7TVUserSubscribe(seventvUserId) {
  if (!seventvWebSocket || seventvWebSocket.readyState !== WebSocket.OPEN) {
    pendingUserSubs.add(seventvUserId)
    return
  }
  if (seventvUserSubs.has(seventvUserId)) return
  if (seventvSubscribedSets.size + seventvUserSubs.size >= seventvSubLimit) {
    log(' 7TV EventAPI: subscription_limit reached, skipping user', seventvUserId.slice(0, 12))
    return
  }
  seventvWebSocket.send(
    JSON.stringify({
      op: 35,
      d: { type: 'user.*', condition: { object_id: seventvUserId } },
    }),
  )
  seventvUserSubs.add(seventvUserId)
  log(' 7TV EventAPI: Subscribed to user', seventvUserId.slice(0, 12))
}

// Map: twitchId → 7tvUserId. Populated when a content script registers a twitch ID
// and we resolve it via the 7TV API. Used to bust cache on user.update events.
const twitchToSeventvId = new Map()
const seventvToTwitchId = new Map()

async function ensureSelfCosmeticSub(twitchId) {
  if (!twitchId) return
  // First time we see this twitch ID this session — force a fresh cosmetic
  // fetch (busts any stale negative cache from before they got their badge).
  if (!twitchToSeventvId.has(twitchId)) {
    userCosmeticsCache.delete(String(twitchId))
    broadcastToTabs({ type: 'cosmetics_invalidated', twitchId: String(twitchId) })
  } else {
    return // already subscribed
  }
  try {
    const resp = await fetchWithTimeout(`https://7tv.io/v3/users/twitch/${twitchId}`)
    if (!resp.ok) {
      resp.body?.cancel?.()
      return
    }
    const data = await resp.json()
    const seventvId = data?.user?.id
    if (!seventvId) return
    twitchToSeventvId.set(String(twitchId), seventvId)
    seventvToTwitchId.set(seventvId, String(twitchId))
    // LRU cap — these grew unbounded (one entry per distinct 7TV chatter) over
    // an 8h session. Evict the oldest pair together so the two stay in sync;
    // the next message from an evicted user just re-fetches their 7TV id.
    if (twitchToSeventvId.size > 2000) {
      const oldT = twitchToSeventvId.keys().next().value
      const oldS = twitchToSeventvId.get(oldT)
      twitchToSeventvId.delete(oldT)
      if (oldS) seventvToTwitchId.delete(oldS)
    }
    ensure7TVConnection()
    send7TVUserSubscribe(seventvId)
  } catch {}
}

// 7TV PERSONAL emote sets — paid-sub emotes usable in any chat. They are
// NOT in /v3/users/<platform>/<id> (that's the channel set); the EventAPI
// pushes an EMOTE_SET entitlement per active chatter. Capture → fetch the
// set once → merge into get_sender_emotes results so DonkMonk-class emotes
// render for other people's messages.
const seventvPersonalSets = new Map() // twitch uid -> { name: emoteData }
const _stvSetFetchAt = new Map() // set id -> ts (6h TTL)
async function capture7TVPersonalEntitlement(body) {
  try {
    const obj = body?.object || body
    const kind = obj?.kind || body?.kind
    if (String(kind).toUpperCase() !== 'EMOTE_SET') return
    const setId = obj?.ref_id || obj?.refId || obj?.id
    const conns = obj?.user?.connections || body?.user?.connections || []
    const twitchId = conns.find?.((c) => String(c?.platform).toUpperCase() === 'TWITCH')?.id
    if (!setId || !twitchId) return
    const last = _stvSetFetchAt.get(setId) || 0
    const cached = seventvPersonalSets.get(String(twitchId))
    if (cached && Date.now() - last < 6 * 3600_000) return
    _stvSetFetchAt.set(setId, Date.now())
    if (_stvSetFetchAt.size > 2000) _stvSetFetchAt.delete(_stvSetFetchAt.keys().next().value)
    const res = await fetchWithTimeout(`https://7tv.io/v3/emote-sets/${setId}`)
    if (!res.ok) return
    const data = await res.json()
    stvCheckShape('set', data)
    const out = {}
    for (const e of data?.emotes || []) {
      if (!e?.name || !e?.id) continue
      const flags = (e.flags || 0) | (e.data?.flags || 0)
      out[e.name] = {
        url: `https://cdn.7tv.app/emote/${e.id}/1x.avif`,
        source: '7tv',
        state: 'global',
        zeroWidth: !!(flags & 257),
        hash: e.id,
        animated: !!e.data?.animated,
      }
    }
    if (Object.keys(out).length) {
      seventvPersonalSets.set(String(twitchId), out)
      if (seventvPersonalSets.size > 2000) {
        const k0 = seventvPersonalSets.keys().next().value
        seventvPersonalSets.delete(k0)
      }
      log(' 7TV: personal set captured for', twitchId, '—', Object.keys(out).length, 'emotes')
    }
  } catch (e) {
    log('7TV personal-set capture err:', e?.message)
  }
}

function handle7TVUserUpdate(body) {
  const seventvId = body?.id || body?.object?.id || body?.user?.id || body?.user_id
  if (!seventvId) return
  const twitchId = seventvToTwitchId.get(seventvId)
  if (!twitchId) return
  // Bust cosmetics cache so next get_user_cosmetics refetches fresh data
  userCosmeticsCache.delete(twitchId)
  log(' 7TV: User cosmetic update for twitchId', twitchId, '— cache busted')
  // Tell tabs to drop their local cosmetic cache for this user and reapply
  broadcastToTabs({ type: 'cosmetics_invalidated', twitchId })
}

function subscribe7TVEmoteSet(setId) {
  if (!setId) return

  ensure7TVConnection()

  if (seventvWebSocket && seventvWebSocket.readyState === WebSocket.OPEN) {
    send7TVSubscribe(setId)
  } else {
    // Queue for when connection opens
    seventvPendingSubs.add(setId)
  }
}

// Debounced zero-tab check for BOTH long-lived sockets (7TV EventAPI +
// heatsync WS): close when the last platform tab goes away, reconnect when
// one returns. The grace window rides out reloads and channel switches.
// 7TV: emote-set subs park in seventvPendingSubs (replayed in onopen), user
// cosmetic subs re-derive from seventvToTwitchId. Heatsync: channel joins
// replay from tabChannels/joinedExtraChannels in the connect burst, and the
// toolbar badge resyncs via hydrateUnreadNotifCount on the next auth.
// Closing the heatsync WS also releases the SW keepalive (its 20s heartbeat
// pinned the worker in RAM forever) — the whole SW heap gets reclaimed.
function scheduleWsIdleCheck() {
  clearTimeout(seventvIdleTimer)
  seventvIdleTimer = setTimeout(async () => {
    seventvIdleTimer = null
    let tabs
    try {
      tabs = await browser.tabs.query({ url: SEVENTV_PLATFORM_URLS })
    } catch {
      return // can't tell — leave the sockets alone (fail open)
    }
    if (tabs.length === 0) {
      const ws = seventvWebSocket
      if (ws && ws.readyState !== WebSocket.CLOSED) {
        log(' 7TV EventAPI: no platform tabs — closing idle socket')
        seventvIdleClosed = true
        for (const setId of seventvSubscribedSets) seventvPendingSubs.add(setId)
        clearTimeout(seventvReconnectTimer)
        seventvReconnectTimer = null
        try {
          ws.close()
        } catch {}
      }
      if (typeof socket !== 'undefined' && socket && socket.readyState !== WebSocket.CLOSED && !hsWsIdleClosed) {
        log(' HS WS: no platform tabs — closing idle socket')
        hsWsIdleClosed = true // gates onclose→scheduleReconnect + watchdog + online
        clearTimeout(reconnectTimer)
        reconnectTimer = null
        try {
          socket.close() // onclose still runs: clears heartbeat, sets state
        } catch {}
      }
      // BG IRC reader rides its own 20s heartbeat — same SW-pinning rule as
      // the sockets above, so it idle-closes with them. Buffers are already
      // debounce-persisted to storage.local; reopen restores them.
      if (BG_IRC.ws && !BG_IRC.idleClosed) {
        log('BG IRC: no platform tabs — closing idle reader')
        bgIrcIdleClose()
      }
      // With every socket down, the 30s lifelines pin the SW alive on their
      // own, and the staggered tab-serving alarms (TAB_GATED_ALARMS) fire
      // <30s apart COMBINED — either set alone keeps the heap resident
      // forever. Clear both; alarms persist outside the SW, so the
      // else-branch below re-creates them when a platform tab returns.
      browser.alarms?.clear?.('keepalive')?.catch?.(() => {})
      browser.alarms?.clear?.('hs-ws-watchdog')?.catch?.(() => {})
      for (const name of Object.keys(TAB_GATED_ALARMS)) {
        browser.alarms?.clear?.(name)?.catch?.(() => {})
      }
    } else {
      ensureAlarm('keepalive', { periodInMinutes: 0.5 })
      ensureAlarm('hs-ws-watchdog', { periodInMinutes: 0.5 })
      for (const [name, opts] of Object.entries(TAB_GATED_ALARMS)) {
        ensureAlarm(name, opts())
      }
      if (seventvIdleClosed) ensure7TVConnection() // pending subs replay on open
      if (hsWsIdleClosed) {
        hsWsIdleClosed = false
        connectWebSocket().catch(() => {})
      }
      if (BG_IRC.idleClosed) {
        bgIrcRestoreFromStorage()
          .catch(() => {})
          .then(() => bgIrcConnect())
      }
    }
  }, SEVENTV_IDLE_GRACE_MS)
}
browser.tabs.onRemoved.addListener(scheduleWsIdleCheck)
browser.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.url) scheduleWsIdleCheck()
})
// Boot: reconcile alarm + reader state against actual tab presence. Without
// this, a SW woken by a non-tab event (alarm, notification click) after the
// browser restarted with zero platform tabs would keep stale lifeline alarms.
scheduleWsIdleCheck()

function handle7TVEmoteSetUpdate(updateData) {
  // updateData.id is the emote set ID. Every channel mapped to it hears the
  // change — a twitch channel and its kick pair can share one 7TV set.
  const setId = updateData.id
  const keys = []
  for (const [k, id] of seventvEmoteSetIds) if (id === setId) keys.push(k)
  if (keys.length === 0) {
    log(' 7TV: Received update for unknown set:', setId)
    return
  }
  for (const key of keys) apply7TVEmoteSetUpdate(key, updateData)
}

function apply7TVEmoteSetUpdate(key, updateData) {
  const { platform, channel: channelName } = splitChKey(key)
  log(' 7TV: Emote set update for', channelName, '(', platform, ')')

  // The event says what changed on its own; the channel's list is only what we
  // patch. That list can be missing (a failed fetch with nothing to fall back
  // on) or mid-refetch ('loading'), and a patch onto nothing used to become
  // the WHOLE list — one live add left the channel with that single emote and
  // every other one unrendered, and a removal found nothing to remove and said
  // nothing. Without a list: announce, leave the map alone, and refetch.
  const loaded = Array.isArray(channelEmotesMap[key])
  const chEmotes = loaded ? channelEmotesMap[key] : null
  let updated = false
  const actor = updateData.actor?.display_name || updateData.actor?.username || ''

  // Handle added emotes
  if (updateData.pushed && updateData.pushed.length > 0) {
    // Large batch = likely initial sync on subscription, not real additions — suppress per-emote spam
    const isBulkSync = updateData.pushed.length > 3
    for (const item of updateData.pushed) {
      const emote = item.value
      if (!emote || typeof emote.id !== 'string' || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(emote.id)) continue
      const newEmote = {
        name: String(emote.name || '').slice(0, 100),
        url: `https://cdn.7tv.app/emote/${emote.id}/1x.avif`,
        source: '7tv',
        hash: emote.id,
        animated: !!emote.data?.animated,
        // Same flag decode as every other 7TV ingest — without it a zero-width
        // emote pushed live rendered inline until the next full refetch
        flags: emote.flags || emote.data?.flags || 0,
        zeroWidth: !!(emote.flags & 257 || emote.data?.flags & 257),
      }

      if (chEmotes?.some((e) => e.hash === emote.id)) continue
      if (chEmotes) {
        chEmotes.push(newEmote)
        updated = true
      }

      if (!isBulkSync) {
        log(' 7TV: Added emote:', emote.name, 'to', channelName)
        const msg = actor ? `${actor} added 7TV emote ${emote.name}` : `${emote.name} added to channel`
        broadcastToTabs({
          type: 'channel_emote_added',
          emote: newEmote,
          channel: channelName,
          platform,
          actor: actor || null,
          message: msg,
        })
      }
    }
    if (isBulkSync) {
      log(' 7TV: Bulk sync — added', updateData.pushed.length, 'emotes to', channelName, '(notifications suppressed)')
    }
  }

  // Handle removed emotes
  if (updateData.pulled && updateData.pulled.length > 0) {
    const isBulkRemoval = updateData.pulled.length > 3
    let removedCount = 0
    for (const item of updateData.pulled) {
      const emote = item.old_value
      if (!emote || typeof emote.id !== 'string') continue
      if (chEmotes) {
        const index = chEmotes.findIndex((e) => e.hash === emote.id)
        if (index === -1) continue
        chEmotes.splice(index, 1)
        updated = true
      }
      removedCount++

      if (!isBulkRemoval) {
        log(' 7TV: Removed emote:', emote.name, 'from', channelName)
        const msg = actor ? `${actor} removed 7TV emote ${emote.name}` : `${emote.name} removed from channel`
        broadcastToTabs({
          type: 'channel_emote_removed',
          emoteName: emote.name,
          emoteHash: emote.id,
          channel: channelName,
          platform,
          actor: actor || null,
          message: msg,
        })
      }
    }
    if (isBulkRemoval && removedCount > 0) {
      log(' 7TV: Bulk removal —', removedCount, 'emotes removed from', channelName, '(notifications suppressed)')
      broadcastToTabs({
        type: 'channel_emote_removed',
        emoteName: null,
        emoteHash: null,
        channel: channelName,
        platform,
        actor: actor || null,
        message: `${removedCount} 7TV emotes removed from channel (set changed)`,
      })
    }
  }

  if (!loaded) {
    // 'loading' lands on its own; a missing list is rebuilt from the source
    if (channelEmotesMap[key] !== 'loading') fetchChannelOwnerEmotes(channelName, null, platform).catch(() => {})
    return
  }

  if (updated) {
    broadcastToTabs({
      type: 'channel_emotes_update',
      emotes: chEmotes,
      channelOwner: channelName,
      platform,
    })

    browser.storage.local
      .set({ channel_emotes_map: getStorableChannelEmotes(), channel_emotes_fetched_at: channelEmotesFetchedAt })
      .catch(() => {})
    log(' 7TV: Channel emotes updated for', channelName, '(now', chEmotes.length, 'total)')
  }
}

// ========== BTTV Live Socket ==========
// BTTV's socket broadcasts channel emote add/remove/rename the way 7TV's
// EventAPI does. Without it a BTTV emote added mid-session only appears after
// the channel TTL refetch. Rooms are keyed 'twitch:<id>' / 'youtube:<UCid>',
// registered by fetchBTTVChannelEmotes once the provider id is known, and
// persisted so SW restarts rejoin (mirrors seventv_emote_set_ids). Unknown or
// malformed events no-op — the TTL refetch remains the correctness floor.
let bttvWebSocket = null
let bttvReconnectAttempts = 0
let bttvReconnectTimer = null
const BTTV_MAX_RECONNECT_ATTEMPTS = 5
const bttvRoomIds = new Map() // chKey → 'twitch:<id>' | 'youtube:<UCid>'
const bttvJoinedRooms = new Set()

function subscribeBTTVChannel(key, room) {
  if (!key || !room) return
  const known = bttvRoomIds.get(key)
  bttvRoomIds.set(key, room)
  if (known !== room) {
    browser.storage.local.set({ bttv_room_ids: Object.fromEntries(bttvRoomIds) }).catch(() => {})
  }
  if (bttvWebSocket && bttvWebSocket.readyState === WebSocket.OPEN) {
    if (!bttvJoinedRooms.has(room)) {
      try {
        bttvWebSocket.send(JSON.stringify({ name: 'join_channel', data: { name: room } }))
        bttvJoinedRooms.add(room)
      } catch {}
    }
  } else {
    connectBTTVSocket() // onopen replays every room in bttvRoomIds
  }
}

function partBTTVRoom(room) {
  if (!room) return
  // Another channel key may still map to the same room (rare, but cheap to guard)
  for (const r of bttvRoomIds.values()) if (r === room) return
  if (!bttvJoinedRooms.delete(room)) return
  if (bttvWebSocket && bttvWebSocket.readyState === WebSocket.OPEN) {
    try {
      bttvWebSocket.send(JSON.stringify({ name: 'part_channel', data: { name: room } }))
    } catch {}
  }
}

function connectBTTVSocket() {
  if (
    bttvWebSocket &&
    (bttvWebSocket.readyState === WebSocket.OPEN || bttvWebSocket.readyState === WebSocket.CONNECTING)
  )
    return
  if (bttvRoomIds.size === 0) return
  log(' BTTV Live: Connecting...')
  try {
    bttvWebSocket = new WebSocket('wss://sockets.betterttv.net/ws')

    bttvWebSocket.onopen = () => {
      log(' BTTV Live: Connected')
      bttvReconnectAttempts = 0
      bttvJoinedRooms.clear()
      for (const room of new Set(bttvRoomIds.values())) {
        try {
          bttvWebSocket.send(JSON.stringify({ name: 'join_channel', data: { name: room } }))
          bttvJoinedRooms.add(room)
        } catch {}
      }
    }

    bttvWebSocket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data)
        if (msg && typeof msg.name === 'string' && msg.data) handleBTTVSocketEvent(msg.name, msg.data)
      } catch (err) {
        console.error('[heatsync] BTTV Live: Parse error:', err)
      }
    }

    bttvWebSocket.onerror = () => {
      log(' BTTV Live: WebSocket error (will reconnect)')
    }

    bttvWebSocket.onclose = () => {
      bttvWebSocket = null
      bttvJoinedRooms.clear()
      if (bttvReconnectAttempts < BTTV_MAX_RECONNECT_ATTEMPTS && bttvRoomIds.size > 0) {
        // Jitter scales with the base delay — same herd-spread rationale as 7TV
        const baseDelay = Math.min(1000 * 2 ** bttvReconnectAttempts, 30000)
        const delay = baseDelay + Math.random() * baseDelay
        bttvReconnectAttempts++
        log(
          ` BTTV Live: Reconnecting in ${Math.round(delay)}ms (attempt ${bttvReconnectAttempts}/${BTTV_MAX_RECONNECT_ATTEMPTS})`,
        )
        clearTimeout(bttvReconnectTimer)
        bttvReconnectTimer = setTimeout(() => {
          bttvReconnectTimer = null
          connectBTTVSocket()
        }, delay)
      } else if (bttvReconnectAttempts >= BTTV_MAX_RECONNECT_ATTEMPTS) {
        log(' BTTV Live: Max reconnects reached — channel TTL refetch remains the fallback')
        bttvReconnectAttempts = 0
      }
    }
  } catch (err) {
    console.error('[heatsync] BTTV Live: Connect failed:', err)
    bttvWebSocket = null
  }
}

function bttvRoomToKey(room) {
  for (const [k, r] of bttvRoomIds) if (r === room) return k
  return null
}

// BTTV Pro PERSONAL emotes. BTTV has no per-user lookup endpoint to ask (its
// REST answers /3/cached/users/<provider>/<id> with the CHANNEL set only): a Pro
// user's personal set reaches other clients as one `lookup_user` push on this
// socket, sent when that user's own client announces itself in a room we have
// joined. So this is push-only, and coverage is whoever has announced while we
// were listening — a Pro chatter we have not heard yet renders as text, exactly
// as before. Captured per twitch id and merged into get_sender_emotes beside the
// 7tv personal sets (the same cross-user pipeline).
//   { name, providerId, channel: 'twitch:<room>', pro, emotes: [{ id, code, animated, width, height, … }] }
const bttvPersonalSets = new Map() // twitch uid -> { name: emoteData }
function captureBTTVPersonalSet(data) {
  // a twitch room's announcement is a twitch user's (BTTV also serves youtube)
  if (!String(data?.channel || '').startsWith('twitch:')) return
  const uid = String(data.providerId || '')
  if (!/^\d{1,20}$/.test(uid) || !Array.isArray(data.emotes)) return
  const out = {}
  for (const e of data.emotes.slice(0, 100)) {
    // same id and name bounds the channel emotes get (emote_create above)
    if (!e || typeof e.id !== 'string' || !/^[a-f0-9]{24}$/i.test(e.id)) continue
    if (typeof e.code !== 'string' || !e.code || e.code.length > 100) continue
    out[e.code] = {
      url: `https://cdn.betterttv.net/emote/${e.id}/1x.webp`,
      source: 'bttv',
      state: 'global',
      zeroWidth: false,
      hash: e.id,
      animated: e.animated === true,
      os: bttvOversize(e),
    }
  }
  // an announcement with no emotes is the user dropping their set
  if (Object.keys(out).length) {
    bttvPersonalSets.set(uid, out)
    if (bttvPersonalSets.size > 2000) bttvPersonalSets.delete(bttvPersonalSets.keys().next().value)
    log(' BTTV Live: personal set captured for', uid, '—', Object.keys(out).length, 'emotes')
  } else if (!bttvPersonalSets.delete(uid)) return
  // a sender's emotes are cached for minutes — drop this one so the next message sees the change
  globalThis.__senderEmoteCache?.delete?.(`twitch:${uid}`)
}

function handleBTTVSocketEvent(name, data) {
  if (name === 'lookup_user') return captureBTTVPersonalSet(data)
  if (name !== 'emote_create' && name !== 'emote_delete' && name !== 'emote_update') return
  const key = bttvRoomToKey(String(data.channel || ''))
  if (!key) return
  const chEmotes = Array.isArray(channelEmotesMap[key]) ? channelEmotesMap[key] : null
  if (!chEmotes) return
  const { platform, channel: channelName } = splitChKey(key)
  let updated = false

  if (name === 'emote_create') {
    const e = data.emote
    if (!e || typeof e.id !== 'string' || !/^[a-f0-9]{24}$/i.test(e.id) || !e.code) return
    if (!chEmotes.some((x) => x.hash === e.id)) {
      const newEmote = {
        name: String(e.code).slice(0, 100),
        url: `https://cdn.betterttv.net/emote/${e.id}/1x.webp`,
        animated: e.animated === true,
        source: 'bttv',
        hash: e.id,
        os: bttvOversize(e),
      }
      chEmotes.push(newEmote)
      updated = true
      log(' BTTV Live: Added emote:', newEmote.name, 'to', channelName)
      broadcastToTabs({
        type: 'channel_emote_added',
        emote: newEmote,
        channel: channelName,
        platform,
        actor: null,
        message: `${newEmote.name} added to channel`,
      })
    }
  } else if (name === 'emote_delete') {
    const id = String(data.emoteId || '')
    const index = chEmotes.findIndex((x) => x.source === 'bttv' && x.hash === id)
    if (index !== -1) {
      const [gone] = chEmotes.splice(index, 1)
      updated = true
      log(' BTTV Live: Removed emote:', gone.name, 'from', channelName)
      broadcastToTabs({
        type: 'channel_emote_removed',
        emoteName: gone.name,
        emoteHash: gone.hash,
        channel: channelName,
        platform,
        actor: null,
        message: `${gone.name} removed from channel`,
      })
    }
  } else if (name === 'emote_update') {
    const e = data.emote
    if (!e || typeof e.id !== 'string' || typeof e.code !== 'string' || !e.code) return
    const hit = chEmotes.find((x) => x.source === 'bttv' && x.hash === e.id)
    if (hit && hit.name !== e.code) {
      hit.name = String(e.code).slice(0, 100)
      updated = true
    }
  }

  if (updated) {
    channelEmotesMap[key] = chEmotes
    broadcastToTabs({ type: 'channel_emotes_update', emotes: chEmotes, channelOwner: channelName, platform })
    browser.storage.local
      .set({ channel_emotes_map: getStorableChannelEmotes(), channel_emotes_fetched_at: channelEmotesFetchedAt })
      .catch(() => {})
    log(' BTTV Live:', name, 'applied for', channelName, '(now', chEmotes.length, 'total)')
  }
}

// ========== BTTV/FFZ Polling ==========
// FFZ has no live socket we speak, and the BTTV socket can drop — this poll is
// the delivery guarantee for both, mirroring the 7TV poll fallback. BTTV skips
// channels whose room is joined on a healthy socket (pushes supersede polling);
// FFZ always polls (it's the primary live path). Runs only while platform tabs
// exist, 60s base + jitter, and reuses the fetchers (their sanitizers, 404
// negcaches and id lookups) so the poll can't drift from the join-time fetch.
let thirdPartyPollTimer = null
const THIRD_PARTY_POLL_INTERVAL = 60000
const thirdPartyPolledChannels = new Set() // first tick per channel = baseline, no toasts

function startThirdPartyPolling() {
  if (thirdPartyPollTimer) return
  const jittered = THIRD_PARTY_POLL_INTERVAL + Math.random() * THIRD_PARTY_POLL_INTERVAL
  thirdPartyPollTimer = trackInterval(setInterval(pollThirdPartyEmotes, jittered))
  log(' BTTV/FFZ Poll: Started (interval', Math.round(jittered / 1000), 's)')
}

function isBttvSocketHealthy() {
  return bttvWebSocket && bttvWebSocket.readyState === WebSocket.OPEN
}

function applyThirdPartyDiff(key, source, fetched) {
  // fetched = sanitized emote list for ONE source; diff it against that
  // source's slice of the channel cache and apply through the same broadcast
  // pipeline every other emote mutation uses.
  const chEmotes = Array.isArray(channelEmotesMap[key]) ? channelEmotesMap[key] : null
  if (!chEmotes) return
  const { platform, channel: channelName } = splitChKey(key)
  const fetchedByHash = new Map()
  for (const e of fetched) if (e?.hash) fetchedByHash.set(e.hash, e)
  const added = []
  const removed = []
  for (const [hash, emote] of fetchedByHash) {
    if (!chEmotes.some((e) => e.source === source && e.hash === hash)) added.push(emote)
  }
  for (const e of chEmotes) {
    if (e.source === source && !fetchedByHash.has(e.hash)) removed.push(e)
  }
  if (!added.length && !removed.length) return

  const updatedEmotes = chEmotes.filter((e) => e.source !== source || fetchedByHash.has(e.hash))
  updatedEmotes.push(...added)
  channelEmotesMap[key] = updatedEmotes

  const label = source === 'bttv' ? 'BTTV' : 'FFZ'
  const baselined = thirdPartyPolledChannels.has(`${key}|${source}`)
  if (baselined) {
    const isBulk = added.length > 3 || removed.length > 3
    if (isBulk) {
      log(` ${label} Poll: Bulk change for`, channelName, '—', added.length, 'added,', removed.length, 'removed')
      if (added.length) {
        broadcastToTabs({
          type: 'channel_emote_added',
          emote: null,
          channel: channelName,
          platform,
          message: `${added.length} ${label} emotes added to channel (set changed)`,
        })
      }
      if (removed.length) {
        broadcastToTabs({
          type: 'channel_emote_removed',
          emoteName: null,
          emoteHash: null,
          channel: channelName,
          platform,
          message: `${removed.length} ${label} emotes removed from channel (set changed)`,
        })
      }
    } else {
      for (const emote of added) {
        log(` ${label} Poll: Added emote:`, emote.name, 'to', channelName)
        broadcastToTabs({
          type: 'channel_emote_added',
          emote,
          channel: channelName,
          platform,
          message: `${emote.name} added to channel (${label})`,
        })
      }
      for (const emote of removed) {
        log(` ${label} Poll: Removed emote:`, emote.name, 'from', channelName)
        broadcastToTabs({
          type: 'channel_emote_removed',
          emoteName: emote.name,
          emoteHash: emote.hash,
          channel: channelName,
          platform,
          message: `${emote.name} removed from channel (${label})`,
        })
      }
    }
  }

  broadcastToTabs({ type: 'channel_emotes_update', emotes: updatedEmotes, channelOwner: channelName, platform })
  browser.storage.local
    .set({ channel_emotes_map: getStorableChannelEmotes(), channel_emotes_fetched_at: channelEmotesFetchedAt })
    .catch(() => {})
}

async function pollThirdPartyEmotes() {
  const keys = Object.keys(channelEmotesMap).filter((k) => Array.isArray(channelEmotesMap[k]))
  if (!keys.length) return
  // Same tab gate as the 7TV idle close — no platform tabs, no polling
  try {
    const tabs = await browser.tabs.query({ url: SEVENTV_PLATFORM_URLS })
    if (tabs.length === 0) return
  } catch {} // can't tell — fail open, poll anyway

  for (const key of keys) {
    const { platform, channel: channelName } = splitChKey(key)

    // FFZ: twitch rooms only (the fetcher rejects non-login shapes itself)
    if (platform === 'twitch') {
      try {
        const ffz = await fetchFFZChannelEmotes(channelName)
        if (Array.isArray(ffz)) {
          applyThirdPartyDiff(key, 'ffz', ffz)
          thirdPartyPolledChannels.add(`${key}|ffz`)
        }
      } catch {}
    }

    // BTTV: only when the live socket can't be trusted for this room
    if (platform === 'twitch' || platform === 'youtube') {
      const room = bttvRoomIds.get(key)
      if (isBttvSocketHealthy() && room && bttvJoinedRooms.has(room)) continue
      // youtube needs the UC id the join-time fetch resolved; never resolve here
      const ucid = platform === 'youtube' ? ytChannelIdCache.get(channelName) : null
      if (platform === 'youtube' && !ucid) continue
      try {
        const bttv = await fetchBTTVChannelEmotes(channelName, ucid, platform)
        if (Array.isArray(bttv)) {
          applyThirdPartyDiff(key, 'bttv', bttv)
          thirdPartyPolledChannels.add(`${key}|bttv`)
        }
      } catch {}
    }
  }
}

// ========== 7TV Polling Fallback ==========
// EventAPI works but can be unreliable. Poll as backup — both paths diff against
// channelEmotesMap so they naturally deduplicate (no double-fire).
let seventvPollTimer = null
const SEVENTV_POLL_INTERVAL = 30000
// Track channels that have completed their first poll in this session
// Prevents spammy "removed" notifications when diffing stale cache on startup
const seventvPolledChannels = new Set()

function start7TVPolling() {
  stop7TVPolling()
  if (seventvEmoteSetIds.size === 0) return
  log(' 7TV Poll: Starting for', seventvEmoteSetIds.size, 'channel(s)')
  // Jitter the interval per-client to spread 30k clients across the window
  // instead of synchronizing on whatever instant start7TVPolling fires.
  const jittered = SEVENTV_POLL_INTERVAL + Math.random() * SEVENTV_POLL_INTERVAL
  seventvPollTimer = trackInterval(setInterval(poll7TVEmoteSet, jittered))
}

// EventAPI is healthy when the WS is OPEN and we received data in the last 3min.
// When healthy + the channel's set is subscribed, the poll is redundant.
function isSeventvEventApiHealthy() {
  return (
    seventvWebSocket &&
    seventvWebSocket.readyState === WebSocket.OPEN &&
    seventvLastData &&
    Date.now() - seventvLastData < 180000
  )
}

function stop7TVPolling() {
  if (seventvPollTimer) {
    untrackInterval(seventvPollTimer)
    seventvPollTimer = null
  }
}

// Tracks when EventAPI first became unhealthy. Gates polling so brief
// WS hiccups don't trigger a 100k-client REST burst against 7TV.
let seventvUnhealthySince = 0
const SEVENTV_UNHEALTHY_GRACE_MS = 60000

async function poll7TVEmoteSet() {
  // Poll ALL channels that have an active 7TV emote set ID
  const channels = Array.from(seventvEmoteSetIds.keys())
  if (channels.length === 0) return
  const eventApiHealthy = isSeventvEventApiHealthy()
  if (eventApiHealthy) {
    seventvUnhealthySince = 0
  } else {
    if (!seventvUnhealthySince) seventvUnhealthySince = Date.now()
    // Within the grace window, skip the entire poll — reconnect is in progress.
    if (Date.now() - seventvUnhealthySince < SEVENTV_UNHEALTHY_GRACE_MS) return
  }

  for (const key of channels) {
    // Skip channels whose emote set is actively subscribed via EventAPI —
    // pushes from the WS supersede polling. Falls back to poll only when
    // EventAPI is degraded or this set isn't subscribed yet.
    const setId = seventvEmoteSetIds.get(key)
    if (eventApiHealthy && setId && seventvSubscribedSets.has(setId)) continue

    const { platform, channel: channelName } = splitChKey(key)

    try {
      let response
      if (platform === 'kick') {
        // 7TV's kick endpoint needs the numeric id, not the slug. Reuse the id
        // the initial fetch resolved; skip this cycle if it's not cached yet.
        const kid = channelOwnerKickId.get(channelName)
        if (!kid) continue
        response = await fetchWithTimeout(`https://7tv.io/v3/users/kick/${kid}`)
      } else if (platform === 'youtube') {
        // Only poll if we already resolved a real UC id for this exact key —
        // never resolve fresh here (this is a fallback poll path; resolving on
        // every cycle would hammer youtube.com). No id cached = skip, no bleed.
        const ucid = ytChannelIdCache.get(channelName)
        if (!ucid) continue
        response = await fetchWithTimeout(`https://7tv.io/v3/users/google/${ucid}`)
      } else {
        const channelId = await lookupTwitchUserId(channelName)
        if (!channelId) continue
        response = await fetchWithTimeout(`https://7tv.io/v3/users/twitch/${channelId}`)
      }
      if (!response.ok) continue
      const data = await response.json()
      // A user answer the parser cannot read means "no emotes" below — and the diff
      // after it would then call every emote removed. Record it and sit this one out.
      if (stvCheckShape('user', data)) continue

      const emoteSet = await resolve7TVEmoteSet(data)
      if (!emoteSet?.emotes) continue
      if (stvCheckShape('set', emoteSet)) continue

      // Check if emote set ID changed (user recreated their set)
      const knownSetId = seventvEmoteSetIds.get(key)
      if (emoteSet.id !== knownSetId) {
        log(' 7TV Poll: Emote set ID changed for', channelName, ':', knownSetId, '→', emoteSet.id)
        seventvEmoteSetIds.set(key, emoteSet.id)
        subscribe7TVEmoteSet(emoteSet.id)
      }

      // Build current 7TV emote map from fetched data
      const fetchedEmotes = new Map()
      for (const e of emoteSet.emotes) {
        fetchedEmotes.set(e.id, {
          name: e.name,
          url: `https://cdn.7tv.app/emote/${e.id}/1x.avif`,
          source: '7tv',
          hash: e.id,
          flags: e.flags || e.data?.flags || 0,
          zeroWidth: !!(e.flags & 257 || e.data?.flags & 257),
          animated: !!e.data?.animated,
        })
      }

      // Get existing 7TV emotes for this channel
      const chEmotes = Array.isArray(channelEmotesMap[key]) ? channelEmotesMap[key] : []
      const existing7TV = new Map()
      for (const e of chEmotes) {
        if (e.source === '7tv') existing7TV.set(e.hash, e)
      }

      // Diff: find added and removed
      const added = []
      const removed = []
      for (const [id, emote] of fetchedEmotes) {
        if (!existing7TV.has(id)) added.push(emote)
      }
      for (const [id, emote] of existing7TV) {
        if (!fetchedEmotes.has(id)) removed.push(emote)
      }

      if (added.length === 0 && removed.length === 0) continue

      log(' 7TV Poll: Detected changes for', channelName, '— added:', added.length, 'removed:', removed.length)

      // Apply changes to channelEmotesMap
      const updatedEmotes = chEmotes.filter((e) => e.source !== '7tv' || fetchedEmotes.has(e.hash))
      updatedEmotes.push(...added)
      channelEmotesMap[key] = updatedEmotes

      // Only broadcast individual notifications after first successful poll this session
      // Prevents spammy "removed" notifications when diffing stale cache on startup
      if (seventvPolledChannels.has(key)) {
        const isBulk = added.length > 3 || removed.length > 3
        if (isBulk) {
          log(
            ' 7TV Poll: Bulk set change for',
            channelName,
            '—',
            added.length,
            'added,',
            removed.length,
            'removed (notifications suppressed)',
          )
          if (added.length > 0) {
            broadcastToTabs({
              type: 'channel_emote_added',
              emote: null,
              channel: channelName,
              platform,
              message: `${added.length} 7TV emotes added to channel (set changed)`,
            })
          }
          if (removed.length > 0) {
            broadcastToTabs({
              type: 'channel_emote_removed',
              emoteName: null,
              emoteHash: null,
              channel: channelName,
              platform,
              message: `${removed.length} 7TV emotes removed from channel (set changed)`,
            })
          }
        } else {
          for (const emote of added) {
            log(' 7TV Poll: Added emote:', emote.name, 'to', channelName)
            broadcastToTabs({
              type: 'channel_emote_added',
              emote,
              channel: channelName,
              platform,
              message: `${emote.name} added to channel (7TV)`,
            })
          }
          for (const emote of removed) {
            log(' 7TV Poll: Removed emote:', emote.name, 'from', channelName)
            broadcastToTabs({
              type: 'channel_emote_removed',
              emoteName: emote.name,
              emoteHash: emote.hash,
              channel: channelName,
              platform,
              message: `${emote.name} removed from channel (7TV)`,
            })
          }
        }
      } else {
        log(
          ' 7TV Poll: Skipping notifications for initial load of',
          channelName,
          `(${added.length} added,`,
          removed.length,
          'removed)',
        )
        seventvPolledChannels.add(key)
      }

      // Broadcast full update
      broadcastToTabs({
        type: 'channel_emotes_update',
        emotes: updatedEmotes,
        channelOwner: channelName,
        platform,
      })

      browser.storage.local
        .set({ channel_emotes_map: getStorableChannelEmotes(), channel_emotes_fetched_at: channelEmotesFetchedAt })
        .catch(() => {})
      log(' 7TV Poll: Channel emotes updated for', channelName, '(now', updatedEmotes.length, 'total)')
    } catch (_err) {
      // Silent fail — poll will retry next interval
    }
  }
}
