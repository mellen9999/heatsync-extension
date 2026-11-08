// part 7 of 8 of the multichat main body — storage, tabs position, settings listeners, offline detection.
// one scope with the other main-*.js parts and main.js at bundle time (build.js MAIN_PARTS, in list order).
// no wrapper here: the IIFE is the bundle's.

// ============================================
// STORAGE
// ============================================

// First-run seed, second half: adopt the same-name other leg when heatsync
// confirms the channel exists (never on a guess). Fire-and-forget; a failed
// probe leaves the entry single-leg.
const _healAttempted = new Set()
async function _adoptSeedLegs(entry) {
  try {
    const added = await mcSeedAdoptLegs(entry, async (path) => {
      const r = await safeSendMessage({ type: 'api_fetch', path })
      return r?.ok ? (r.data ?? r) : null
    })
    if (!added.length) return
    _channelLookup = null
    saveConfig()
    if (added.includes('twitch') && isEnabled('irc-twitch')) {
      irc?.join(entry.twitch)
      safeSendMessage({ type: 'join_channel', platform: 'twitch', channel: entry.twitch })
    }
    if (added.includes('kick') && isEnabled('chat-kick')) kickChat?.join(entry.kick)
  } catch (_) {}
}

async function loadConfig() {
  try {
    const s = await browser.storage.local.get([STORAGE_KEY])
    const _raw = s[STORAGE_KEY]
    config = { channels: [], enabled: true, ...(_raw && typeof _raw === 'object' ? _raw : {}) }
    // Guard: a persisted null channels field (corrupted storage) would propagate
    // through the spread and cause config.channels.some() to throw below.
    if (!Array.isArray(config.channels)) config.channels = []
    _channelLookup = null
    // Migrate old string channels to object format
    let needsSave = false
    if (config.channels.some((c) => typeof c === 'string')) {
      config.channels = config.channels.map((ch) =>
        typeof ch === 'string' ? { id: ch, twitch: ch, kick: '', youtube: '' } : ch,
      )
      needsSave = true
    }
    // Purge persisted ghost channels: reserved URL slugs that slipped in as
    // channel names before they were blocklisted (login/oauth2 from oauth
    // redirects). They IRC-join garbage, burn kick subscribe quota, and
    // shuffle the tab bar. Shape-valid logins, so only the blocklist knows.
    const _ghost = (name) => !!name && NON_CHANNEL_PATHS.has(String(name).toLowerCase())
    const _prePurge = config.channels.length
    config.channels = config.channels.filter((c) => !(_ghost(c.twitch) || _ghost(c.kick) || _ghost(c.id)))
    if (config.channels.length !== _prePurge) needsSave = true
    if (needsSave) saveConfig()
    // First-run seed: no channels yet AND we're on a real Twitch/Kick channel
    // page → add the current channel so the panel opens with working chat
    // instead of a blank list. getCurrentChannel() returns null on home/
    // directory/reserved pages, so this can never seed a garbage slug. YouTube
    // is skipped (it needs a URL form, not a bare slug); the empty-state CTA
    // covers that case.
    if (!config.channels.length) {
      try {
        const host = location.hostname
        const onTwitch = host.includes('twitch.tv')
        const onKick = host.includes('kick.com')
        if (onTwitch || onKick) {
          const cur = getCurrentChannel()
          if (cur) {
            config.channels = [
              onKick
                ? { id: cur, twitch: '', kick: cur, youtube: '' }
                : { id: cur, twitch: cur, kick: '', youtube: '' },
            ]
            saveConfig()
            _adoptSeedLegs(config.channels[0])
          }
        }
      } catch (_) {}
    }
    // Heal saved single-leg entries (the old seed left every existing user
    // twitch-only or kick-only): same probe, once per session, 3 at a time.
    void mcHealEntries(config.channels, _adoptSeedLegs, _healAttempted)
    // Subscribe per-channel YouTube links
    for (const ch of config.channels) {
      if (ch.youtube) {
        youtubeLinks.set(ch.id, { url: ch.youtube, videoId: '', channelName: '' })
        ytSubscribedUrls.set(ch.id, ch.youtube)
        ytChanLastSeen.set(ch.id, Date.now())
        // 7TV/BTTV YouTube channel emotes ride along — channelId is a hint
        // (the stored youtube URL/handle); background resolves the real UC id.
        ytSubscribe(ch.id, ch.youtube, ch.id)
      }
    }
  } catch (_) {}
}

let _skipNextConfigSync = false
// Snapshot of what we last wrote, so the cross-tab union below can tell
// "another tab added this" from "we deliberately removed this".
let _lastPersistedChannelKeys = null
let _lastPersistedLegs = null
// Serializes saveConfig bodies — two rapid saves must not interleave their
// read-then-write halves (the same lost-update the union above prevents
// cross-tab, but within one tab). Mirrors the ui_settings write mutex.
let _saveConfigChain = Promise.resolve()

function saveConfig() {
  _channelLookup = null
  if (typeof updateSendTag === 'function') updateSendTag()
  // Notify any open UI (profile card, etc.) that channel list may have changed
  try {
    document.dispatchEvent(new CustomEvent('hs-channels-changed'))
  } catch {}
  _saveConfigChain = _saveConfigChain.then(_saveConfigNow, _saveConfigNow)
  return _saveConfigChain
}

async function _saveConfigNow() {
  try {
    _skipNextConfigSync = true
    const persistable = { ...config, channels: config.channels || [] }
    // Union the channel list with what's in storage before writing. A blind
    // full-object set makes two tabs (twitch + kick, the normal setup) race:
    // whoever writes last wins, and the loser's just-added channel is both
    // dropped from storage AND parted locally when the onChanged diff sees
    // it missing. Reconcile on channelKey identity, ours winning on shape.
    try {
      const stored = (await browser.storage.local.get(STORAGE_KEY))?.[STORAGE_KEY]
      const theirs = Array.isArray(stored?.channels) ? stored.channels : null
      if (theirs?.length) {
        const key = (c) => `${c?.platform || 'twitch'}:${(c?.id || c?.twitch || c?.name || '').toLowerCase()}`
        const mine = new Set(persistable.channels.map(key))
        // A channel we deliberately removed this session must stay removed —
        // only adopt entries that appeared after our last known snapshot.
        const removed = _lastPersistedChannelKeys
        const prevById = _lastPersistedLegs
        for (const c of theirs) {
          const k = key(c)
          if (!mine.has(k) && !removed?.has(k)) persistable.channels.push(c)
          else if (mine.has(k)) {
            // same channel, maybe another tab added a leg (kick tab seeding a
            // twitch entry): merge it in, never replace
            const m = persistable.channels.find((x) => key(x) === k)
            if (m && typeof c === 'object') mcMergeLegs(m, c, prevById?.get(k))
          }
        }
      }
    } catch {}
    _lastPersistedLegs = new Map(
      persistable.channels.map((c) => [
        `${c?.platform || 'twitch'}:${(c?.id || c?.twitch || c?.name || '').toLowerCase()}`,
        { twitch: c?.twitch || '', kick: c?.kick || '', youtube: c?.youtube || '' },
      ]),
    )
    _lastPersistedChannelKeys = new Set(
      persistable.channels.map(
        (c) => `${c?.platform || 'twitch'}:${(c?.id || c?.twitch || c?.name || '').toLowerCase()}`,
      ),
    )
    await browser.storage.local.set({ [STORAGE_KEY]: persistable })
    // Sync to server for cross-device sync
    safeSendMessage({
      type: 'ws_send',
      data: { type: 'multichat:sync', channels: config.channels || [] },
    })
  } catch (e) {
    // A swallowed failure here looks like a saved channel — it isn't. See
    // reportStorageWriteFailure above.
    reportStorageWriteFailure('channel config', e, 'mc_main_config_save_failed')
  }
}

// ============================================
// TABS POSITION SETTING
// ============================================

async function loadTabsPosition() {
  try {
    const stored = await cachedUiSettings()
    if (stored.ui_settings?.tabPosition !== undefined) {
      tabPosition = stored.ui_settings.tabPosition
    }
    applyTabsPosition()
  } catch (e) {
    log('Error loading tabs position:', e)
  }
}

let _savedActiveTab = null
// native chat stays up across reloads until the viewer goes back to heatsync chat by hand
let _savedYtNative = false
// 'discover' is feed's second cell now, so it restores like any other tab.
// 'whispers' belongs here too — it's a real, restorable tab; leaving it out
// silently bounced you to 'live' every reload if that's where you were.
const BUILTIN_TABS = mcRestorableTabs()
/** The channel a twitch/kick popout window is locked to, from its path. */
function popoutUrlChannel() {
  return location.pathname.match(/^\/(?:popout|embed)\/([a-zA-Z0-9_-]+)/)?.[1] || null
}

async function loadActiveTab() {
  try {
    const stored = await cachedUiSettings()
    const saved = stored.ui_settings?.activeTab || 'live'
    _savedYtNative = stored.ui_settings?.ytNative === true
    // Validate: must be a built-in tab or a configured channel (never restore 'add')
    const channelIds = config.channels.map((c) => c.id)
    _savedActiveTab = saved !== 'add' && (BUILTIN_TABS.includes(saved) || channelIds.includes(saved)) ? saved : 'live'
    // Opened from an event row (#hs-live): the click meant "go to that
    // channel", so land on its live tab, not whichever tab was last active.
    if (location.hash === '#hs-live') {
      _savedActiveTab = 'live'
      // ...and keep it: a saved tab, so every open surface (storage
      // onChanged) gets it and removing it anywhere removes it everywhere.
      const cur = getCurrentChannel()
      // Only the platform the row's page is on: a youtube-only streamer must not
      // get a twitch slot (a banned/absent twitch account). A youtube video id
      // (the /live redirect landed first) is not a channel, so it makes no tab.
      const plat = hostPlatform
      const chOk = plat !== 'yt' || parseYoutubeChannelType(location.pathname, location.search) === 'handle'
      const have = cur ? config.channels.find((c) => (c.id || '').toLowerCase() === cur) : null
      if (cur && chOk && !have) {
        config.channels.push(hsLiveChannelEntry(plat, cur))
        saveConfig()
      } else if (have && chOk && fillHsLiveLeg(have, plat, cur)) {
        // saved earlier as twitch-only: the row's platform fills its empty slot
        saveConfig()
      }
      if (cur && config.channels.some((c) => c.id === cur)) _savedActiveTab = cur
      try {
        history.replaceState(null, '', location.pathname + location.search)
      } catch (_) {}
    }
    // Popout window is locked to one channel by URL — ignore the parent
    // session's saved tab (which often points to a different channel and
    // produces a blank panel because that channel's pane was never built).
    if (document.body.classList.contains('hs-popout')) {
      const urlCh = popoutUrlChannel()
      if (urlCh) {
        _savedActiveTab = 'live'
        liveChannel = urlCh
      } else {
        // a youtube popout has no channel in its path: the page's own stream decides
        _savedActiveTab = 'live'
        liveChannel = null
      }
    }
  } catch (_) {
    _savedActiveTab = 'live'
  }
}

// One-time repair for tabs saved twitch-only before went-live rows kept their
// platform: a youtube/kick page whose channel owns a lone twitch leg that the
// directory says doesn't exist (suspended/banned/never made) gains the page's
// leg. Conservative: only a verified identity, only an EMPTY slot, nothing dropped.
async function repairTwitchOnlyTab() {
  try {
    const plat = hostPlatform
    if (plat !== 'yt' && plat !== 'kick') return
    const cur = getCurrentChannel()
    if (!cur || typeof resolveIdentity !== 'function') return
    const slot = plat === 'yt' ? 'youtube' : 'kick'
    const tab = config.channels.find(
      (c) => (c.id || '').toLowerCase() === cur && (c.twitch || '').toLowerCase() === cur && !c.kick && !c.youtube,
    )
    if (!tab) return
    const res = await resolveIdentity(cur, { platform: plat })
    if (!res?.ok || !res.identity || res.identity.twitch || !res.identity[plat === 'yt' ? 'youtube' : 'kick']) return
    if (tab[slot] || !config.channels.includes(tab)) return
    if (!fillHsLiveLeg(tab, plat, cur)) return
    saveConfig()
    // Join the new leg now, the way an edit in the channel dialog does —
    // saving alone left the tab on its dead twitch leg until the next load.
    if (slot === 'kick') kickChat?.join(tab.kick)
    else {
      youtubeLinks.set(tab.id, { url: tab.youtube, videoId: '', channelName: '' })
      ytSubscribedUrls.set(tab.id, tab.youtube)
      ytChanLastSeen.set(tab.id, Date.now())
      ytSubscribe(tab.id, tab.youtube, tab.id)
    }
    updateTabBar()
  } catch (_) {}
}

let _applyingPosition = false
function applyTabsPosition() {
  if (_applyingPosition) return
  _applyingPosition = true
  try {
    _applyTabsPositionInner()
  } finally {
    _applyingPosition = false
  }
}
function _applyTabsPositionInner() {
  document.body.classList.remove('hs-tabs-top', 'hs-tabs-right', 'hs-tabs-bottom', 'hs-tabs-left')
  document.body.classList.add(`hs-tabs-${tabPosition}`)

  // Re-run dynamic layout — clears stale inline rules + applies fresh ones for new position.
  try {
    _updateMcLayout()
  } catch (_) {}

  // Re-apply column width (accounts for vertical tab offset)
  applyChatWidth()

  log('Tabs position:', tabPosition)
}

function rotateTabPosition() {
  const positions = ['top', 'right', 'bottom', 'left']
  const currentIndex = positions.indexOf(tabPosition)
  const prev = tabPosition
  tabPosition = positions[(currentIndex + 1) % positions.length]
  log('rotate:', prev, '→', tabPosition)

  setSetting('tabPosition', tabPosition) // applier applies + rerender
}

function listenForSettingsChanges() {
  if (_onceGuardsMain.settingsListener) return
  _onceGuardsMain.settingsListener = true

  // Listen for messages from popup — tracked through cleanup so SPA
  // reinit removes the prior handler and replaces it.
  cleanup.addListener(chrome.runtime?.onMessage, (msg) => {
    if (msg.type === 'ui_settings_changed' && msg.settings) {
      log('Settings changed via message:', msg.settings)
      if (msg.settings.tabPosition !== undefined && msg.settings.tabPosition !== tabPosition) {
        tabPosition = msg.settings.tabPosition
        applyTabsPosition()
      }
      if (msg.settings.chatPosition !== undefined && msg.settings.chatPosition !== chatPosition) {
        chatPosition = msg.settings.chatPosition
        applyChatPosition()
      }
    }
    if (msg.type === 'debug_log' && MC_DEBUG) console.log('[hs-bg]', msg.msg)
    if (msg.type === 'emote_add_failed') {
      // BG's collect POST failed (logged out — common right after an ext
      // reload — rate limit, server error). This was silent on the multichat
      // surface: the emote kept rendering locally from the session index and
      // vanished on refresh with no server row (the o7 bug). Fail loud.
      try {
        if (msg.notLoggedIn) {
          // The dominant cause of "emotes don't work / the ext sucks": the user
          // isn't signed into heatsync, so their added emotes render for nobody
          // and vanish on refresh. A disappearing toast doesn't fix the
          // confusion — show a persistent, one-click login nudge instead.
          showEmoteLoginNudge()
        } else {
          showToast(t('mc_main_emote_add_failed', [msg.emoteName || 'emote', msg.error || 'server error']), 'error')
        }
      } catch (_) {}
    }
    if (msg.type === 'api_status') {
      try {
        showApiStatusBanner(msg.source, msg.state)
      } catch (_) {}
    }
    // Server-enriched emote refs for a twitch message the native tap already
    // delivered (which lacks them). Merge onto the row by id and re-render it
    // in place so the sender's emotes resolve without a per-sender fetch.
    if (msg.type === 'bg_irc_enrich' && msg.id && msg.hsEmotes) {
      try {
        const ech = (msg.channel || '').toLowerCase()
        const rows = irc?.getMessages ? irc.getMessages(ech) : null
        if (rows) {
          for (const m of rows) {
            if (m && m.id === msg.id) {
              // ⛔ THIS WAS GATED ON `!m.hsEmotes` AND ASSIGNED THE WHOLE
              // OBJECT. hsEmotes is a MAP, so a row already carrying one name
              // discarded every other name the server had resolved — AND,
              // because the re-render lived inside that same gate, it did not
              // repaint either. The emote stayed a word on screen with the
              // ref sitting right there on the row.
              //
              // Additive by name, and repaint whenever anything was actually
              // gained (never on a no-op — this runs per enrich frame).
              if (!m.hsEmotes) m.hsEmotes = {}
              let gained = false
              for (const n in msg.hsEmotes) {
                if (msg.hsEmotes[n] && !m.hsEmotes[n]) {
                  m.hsEmotes[n] = msg.hsEmotes[n]
                  gained = true
                }
              }
              if (gained) {
                m._renderedHtml = null
                if (typeof queueImmediateReprocess === 'function') queueImmediateReprocess()
              }
              break
            }
          }
        }
      } catch (_) {}
    }
    if (msg.type === 'signed_out_notice') {
      try {
        HsNotifs.emit('signed-out', {})
      } catch (_) {}
      return
    }
    if (msg.type === 'auth_changed') {
      try {
        showAuthLoginBanner(!!msg.loggedIn)
        if (msg.loggedIn) {
          HsNotifs.dismissByKey?.('signed-out', 'signed-out')
          dismissEmoteLoginNudge()
          revealFreshInstallTabsOnce()
        }
      } catch (_) {}
    }
    // The `cosmetics` switch gated only the PULL (loadBulkBadges). This is
    // the PUSH — background re-broadcasts the bttv/ffz/chatterino maps on
    // every refresh — so with cosmetics off the maps were repopulated and
    // re-injected into live rows anyway. Gate the pull, miss the push: the
    // same shape that made irc-twitch a switch that turned nothing off.
    if (msg.type === 'cosmetics_update' && gateAtBoot('cosmetics') === false) return
    if (msg.type === 'cosmetics_update') {
      const bttv = Object.entries(msg.bttvBadges || {})
      const ffz = new BadgeIndex(msg.ffzBadges)
      const chat = new BadgeIndex(msg.chatterinoBadges)
      // Never let an empty broadcast wipe populated maps.
      if (bttv.length + ffz.size + chat.size > 0) {
        mcBttvBadgeMap = new Map(bttv)
        mcFfzBadgeMap = ffz
        mcChatterinoBadgeMap = chat
        // In-place patch instead of bumpRenderEpoch()+rebuild (the flash).
        // Current tab's live rows get badges injected now; other tabs drop
        // their snapshot caches so they rebuild fresh on switch (mirrors
        // invalidateRenderedForEmotes — no epoch bump, current tab untouched).
        updateThirdPartyBadgesInPlace()
        _dropAllTabCaches()
      }
    }
    // SW pushes its `/api/live/following` snapshot every ~60s. Consume it
    // here so we can skip /api/platform/live-status calls for the channels
    // it already covers — the bulk of the 100k-client live-poll load.
    if (msg.type === 'live_followed_updated') {
      try {
        _applyFollowedSnapshot(msg.snapshot)
      } catch {}
    }
    // 7TV EventAPI pushed user.update / entitlement.* — drop our local
    // cosmetic cache and re-queue lookup so badges/paint show up fresh.
    if (msg.type === 'cosmetics_invalidated' && msg.twitchId && gateAtBoot('cosmetics') !== false) {
      mcUserCosmetics.delete(String(msg.twitchId))
      // Re-queue lookup; updateCosmeticsInPlace fires on response and adds
      // the badge to all existing messages with this uid.
      queueMcCosmeticsLookup(String(msg.twitchId))
    }
    // Listen for emote updates from background
    if (msg.type === 'global_emotes_update' || msg.type === 'channel_emotes_update') {
      // Channel updates: take the broadcast payload at face value and populate
      // channelEmoteCaches synchronously. BG sends multiple coalesced broadcasts
      // during a fetch (one per provider) and only writes storage AFTER the
      // final one — the old loadEmotes-from-storage path raced with that write
      // and could leave the cache empty for a channel whose fetch completed
      // mid-debounce. Direct populate sidesteps the race entirely.
      if (msg.type === 'channel_emotes_update' && msg.channelOwner && Array.isArray(msg.emotes)) {
        // platform tag lets the panel keep both sets for a same-name twitch+kick
        // simulcast instead of one overwriting the other (merge-per-platform).
        const _ownerKey = msg.channelOwner.toLowerCase()
        // Additive diff BEFORE the rebuild: does this payload make any name
        // renderable that wasn't? Late payloads (a provider resolving after
        // the 25s cold window — deferred joins, slow 7TV, a refetch landing
        // minutes in) must still heal plain-text history rows; the time
        // window alone missed them. Upgrade-only: removal payloads add no
        // names, so they never trigger a history re-render ("history is
        // sacred" — the stale-ghost registry handles removals).
        const _prevCache = channelEmoteCaches[_ownerKey]
        for (const _e of msg.emotes) {
          if (_e?.name && _e.url && !(_prevCache instanceof Map && _prevCache.has(_e.name))) {
            _pendingEmoteAdds = true
            break
          }
        }
        _buildChannelEmoteCache(_ownerKey, msg.emotes, msg.platform)
        if (msg.platform === 'youtube') {
          // Alias the SAME Map under the shapes getCurrentChannel() yields on
          // yt pages — raw-case videoId (watch?v=) and bare handle (no @) —
          // so picker/lookup fallbacks hit. yt cache keys are videoId/@handle
          // (BG yt_ensure_channel_emotes derivation), never a channel name.
          for (const a of [msg.channelOwner, _ownerKey.replace(/^@/, '')]) {
            if (a && a !== _ownerKey) channelEmoteCaches[a] = channelEmoteCaches[_ownerKey]
          }
        }
        markPickerDirty()
      }
      // Cold-start (first emote payload for this scope) needs clear+rerender
      // so old plain-text messages from history pick up newly-loaded emotes.
      // Subsequent updates (add/remove via 7TV EventAPI) preserve _renderedHtml
      // — old messages keep their emote rendering even if an emote is removed.
      // History is sacred: what was rendered as an emote stays an emote.
      const scope = msg.type === 'channel_emotes_update' ? `ch:${msg.channelOwner || '_'}` : 'global'
      _pendingEmoteScopes.add(scope)
      cleanup.clearTimeout(emoteReloadTimer)
      emoteReloadTimer = cleanup.setTimeout(() => {
        const pending = _pendingEmoteScopes
        _pendingEmoteScopes = new Set()
        const hadAdds = _pendingEmoteAdds
        _pendingEmoteAdds = false
        loadEmotes()
          .then(() => {
            // Heal plain-text history rows whenever this flush made new names
            // renderable (additive diff), or during a scope's cold-load window
            // (covers global/inventory scopes with no diff). In-place text
            // swap instead of clearRenderedHtmlCache()→epoch bump→full
            // rebuild (the flash). Additive-only outside the window, so a
            // removal never re-renders history ("history is sacred").
            if (hadAdds || _emoteColdLoad(pending)) reloadEmotesInPlace()
          })
          .catch((e) => log('[heatsync-mc] loadEmotes error:', e))
      }, 300)
    }
    // Inventory changes: update membership + viewer's personal set.
    // CRITICAL: do NOT add inventory items to emoteCache (the global render
    // pool). emoteCache is consulted as a fallback for OTHER senders'
    // messages, so writing the viewer's inventory there made viewer-owned
    // emotes render for every sender's messages — exactly the "personal set
    // bleed" that viewerPersonalEmotes was built to prevent (see line 1389).
    // Lookups for own outgoing use senderEmotes=viewerPersonalEmotes; tab
    // completion / picker use lookupEmote() which checks viewerPersonalEmotes
    // first. emoteCache only needs the state flipped when the same name is
    // ALSO a heatsync global.
    if (msg.type === 'hs_moment') {
      try {
        handleMomentSpike(msg.data)
      } catch (_) {}
      return
    }
    if (msg.type === 'inventory_update') {
      const prevInventory = new Set(inventoryEmotes)
      inventoryEmotes.clear()
      inventoryHashes.clear()
      ;(msg.emotes || []).forEach((e) => {
        // a poll that raced the DELETE still lists it — the server catches up
        if (e.name && !isLocallyRemoved(e.name)) {
          inventoryEmotes.add(e.name)
          if (e.hash) inventoryHashes.set(e.name, e.hash)
          // Flip state for emotes that are ALSO in the heatsync globals pool;
          // do not ADD new entries to emoteCache here.
          if (emoteCache.has(e.name)) {
            const c = emoteCache.get(e.name)
            c.state = 'owned'
            if (e.slot != null) c.slot = e.slot
          }
          if (e.url) {
            // Recover overlay flag for rows added before the zero_width column (2026-05-23,
            // they read FALSE): the 7TV channel/global caches still carry it — borrow it so
            // a viewer's pre-existing CarrotTime/wavE stacks without re-adding.
            const zwFromAny = typeof zeroWidthFromAnyCache === 'function' ? zeroWidthFromAnyCache(e.name) : false
            viewerPersonalEmotes.set(e.name, {
              url: e.url,
              source: 'heatsync',
              state: 'owned',
              hash: e.hash,
              slot: e.slot,
              zeroWidth: !!(e.zero_width ?? e.zeroWidth ?? zwFromAny),
              variants: e.variants,
              // BG-normalized epoch ms — inventory-time render gate
              addedAt: e.addedAt || 0,
              // server CW annotation — own msgs hide these at render when
              // the owner's own viewer_show_* toggles say so
              cwCats: Array.isArray(e.cw_cats) && e.cw_cats.length ? e.cw_cats : null,
            })
          }
        }
      })
      // Remove emotes no longer in inventory from cache (if heatsync source)
      for (const [name, emote] of emoteCache) {
        if (emote.source === 'heatsync' && !inventoryEmotes.has(name)) {
          emoteCache.delete(name)
        }
      }
      for (const name of viewerPersonalEmotes.keys()) {
        if (!inventoryEmotes.has(name)) viewerPersonalEmotes.delete(name)
      }
      // Flip already-rendered wrappers in chat: owned ↔ unadded so a just-
      // posted emote that the viewer then removes turns orange instead of
      // staying green. No-op on names whose membership didn't change.
      const removed = [...prevInventory].filter((n) => !inventoryEmotes.has(n))
      const added = [...inventoryEmotes].filter((n) => !prevInventory.has(n))
      for (const n of removed) refreshEmoteWrappersState(n)
      for (const n of added) refreshEmoteWrappersState(n)
      // Newly-owned names also need _renderedHtml invalidated so a row that
      // rendered the name as plain text (because viewerPersonalEmotes was empty
      // at the time — startup race / inventory wipe before refetch) re-resolves
      // to an emote img on the next paint. refreshEmoteWrappersState only flips
      // existing wrappers; it can't conjure one out of a text node.
      if (added.length && typeof invalidateRenderedForEmotes === 'function') {
        invalidateRenderedForEmotes(added)
      }
      // First inventory_update after page load: the buffer may contain rows
      // rendered with an EMPTY viewerPersonalEmotes (any name now in inventory
      // would have processed as plain text). Brute-force invalidate everything
      // ONCE so those rows re-resolve to emote imgs. Subsequent updates use
      // the per-name path above (cheap).
      if (!window.__hsInventoryEverLoaded) {
        window.__hsInventoryEverLoaded = true
        if (typeof invalidateRenderedForEmotes === 'function' && inventoryEmotes.size) {
          invalidateRenderedForEmotes([...inventoryEmotes])
        }
      }
      log('inventory_update:', inventoryEmotes.size, 'emotes')
      // Inventory just changed emoteCache contents — picker is stale.
      markPickerDirty()
      prebuildPickerIdle()
      // Background probe: for owned 7TV emotes whose zeroWidth ended up FALSE
      // (DB row predates the column AND no loaded channel set carries the flag
      // — e.g. an emote added via picker search without subscribing to a
      // channel that owns it), hit 7tv.io/v3/emotes/{hash} to recover the
      // overlay flag and POST a sticky-true upgrade to the server. Cached in
      // window.__hsZwProbed so we don't re-probe across inventory polls.
      if (!window.__hsZwProbed) window.__hsZwProbed = new Set()
      const _probeTargets = []
      for (const [name, em] of viewerPersonalEmotes) {
        if (em.zeroWidth) continue
        if (window.__hsZwProbed.has(name)) continue
        // Only 7TV CDN URLs have a usable hash for the REST emote-by-id probe.
        if (!em.url?.includes('cdn.7tv.app/emote/')) continue
        const m = em.url.match(/cdn\.7tv\.app\/emote\/([A-Z0-9]+)/i)
        const sevenTvId = m?.[1] || em.hash
        if (!sevenTvId) continue
        window.__hsZwProbed.add(name)
        _probeTargets.push({ name, sevenTvId, em })
      }
      if (_probeTargets.length) {
        // Trickle 4-at-a-time so a viewer with 200 owned 7TV emotes doesn't
        // flash-fire 200 simultaneous 7TV fetches on every inventory_update.
        const _runProbeBatch = async (batch) => {
          await Promise.allSettled(
            batch.map(async ({ name, sevenTvId, em }) => {
              try {
                const r = await fetch(`https://7tv.io/v3/emotes/${sevenTvId}`).then((r) => (r.ok ? r.json() : null))
                const isZw = !!(r && (r.flags || 0) & 256)
                if (!isZw) return
                em.zeroWidth = true
                if (typeof invalidateRenderedForEmotes === 'function') invalidateRenderedForEmotes([name])
                // Sticky-true upgrade on the server so every other viewer of any
                // sender owning this emote inherits the flag too.
                try {
                  chrome.runtime.sendMessage(
                    {
                      type: 'add_to_inventory',
                      emoteName: name,
                      emoteHash: em.hash || sevenTvId,
                      emoteUrl: em.url,
                      zeroWidth: true,
                    },
                    () => {
                      void chrome.runtime.lastError
                    },
                  )
                } catch (_) {}
              } catch (_) {}
            }),
          )
        }
        ;(async () => {
          for (let i = 0; i < _probeTargets.length; i += 4) {
            await _runProbeBatch(_probeTargets.slice(i, i + 4))
          }
        })()
      }
    }

    // Cross-platform mute sync (from background.js — other tabs, server WS, or expiry)
    if (msg.type === 'user_muted') {
      const u = msg.username?.toLowerCase()
      if (u && !mutedUsers.has(u)) {
        mutedUsers.add(u)
        applyMcMutes()
      }
    }
    if (msg.type === 'user_unmuted') {
      // Key may be namespaced (twitch:alice) or legacy bare (alice). Delete both
      // so unmuting always clears the Set regardless of when the entry was written.
      const u = msg.username?.toLowerCase()
      const bare = u?.includes(':') ? u.split(':')[1] : null
      let changed = false
      if (u && mutedUsers.has(u)) {
        mutedUsers.delete(u)
        changed = true
      }
      if (bare && mutedUsers.has(bare)) {
        mutedUsers.delete(bare)
        changed = true
      }
      if (changed) {
        restoreMcUnmutedDom(bare || u)
        renderMessages(currentTab, { bypassScrollPause: true })
      }
    }
    // Server cleared the entire mute list (e.g. user clicked "clear all" on heatsync.org)
    if (msg.type === 'mutes_cleared' && mutedUsers.size > 0) {
      for (const u of mutedUsers) {
        // Keys may be namespaced — restoreMcUnmutedDom matches by bare display name
        const bare = u.includes(':') ? u.split(':')[1] : u
        restoreMcUnmutedDom(bare)
      }
      mutedUsers.clear()
      renderMessages(currentTab, { bypassScrollPause: true })
    }
    // Cross-surface block sync (content.js, other tabs). Full re-render so blocked
    // users drop out / reappear (buildMessageDiv filters them).
    if (msg.type === 'user_blocked') {
      const u = msg.username?.toLowerCase()
      if (u && !blockedUsers.has(u)) {
        blockedUsers.add(u)
        renderMessages(currentTab, { bypassScrollPause: true })
      }
    }
    if (msg.type === 'user_unblocked') {
      // Delete both namespaced key AND legacy bare form so unblock always lands.
      const u = msg.username?.toLowerCase()
      const bare = u?.includes(':') ? u.split(':')[1] : null
      const had = (u && blockedUsers.delete(u)) | (bare && blockedUsers.delete(bare))
      if (had) renderMessages(currentTab, { bypassScrollPause: true })
    }

    // A different user's emote set changed. New servers send senderKeys —
    // invalidate + refetch exactly that sender (v-busted past the CF edge);
    // the flush path's upgradeMessagesForSenders re-renders their rows.
    // Legacy shape (no senderKeys, incl. the reconnect-convergence nudge):
    // bust everyone — next render of any message refreshes.
    if (msg.type === 'emote_added_broadcast') {
      try {
        if (Array.isArray(msg.senderKeys) && msg.senderKeys.length) {
          for (const key of msg.senderKeys.slice(0, 30)) {
            if (typeof key !== 'string' || !key) continue
            senderEmoteFetchedAt.delete(key)
            senderEmoteVerified.delete(key)
            if (msg.ver != null) {
              setSenderEmoteBustVer(key, msg.ver)
              noteSenderVer(key, msg.ver)
            }
            // Only refetch senders we actually hold — a key never seen in
            // this panel has no rows to fix and would be pure fetch noise.
            if (typeof senderEmoteSets !== 'undefined' && senderEmoteSets.has(key)) {
              senderEmotePending.add(key)
            }
          }
          if (senderEmotePending.size) {
            if (senderEmoteTimer) {
              cleanup.clearTimeout(senderEmoteTimer)
              senderEmoteTimer = null
              senderEmoteTimerUrgent = false
            }
            flushSenderEmoteBatch()
          }
        } else {
          if (typeof senderEmoteFetchedAt !== 'undefined') senderEmoteFetchedAt.clear()
          // Freshness alone only helps FUTURE renders — if chat is quiet,
          // nothing re-renders and the already-painted rows stay text.
          // Actively re-queue the senders of recent buffered rows (same
          // buffers the removal path walks); the flush path's
          // upgradeMessagesForSenders() re-renders whatever changed.
          const requeue = (buf) => {
            if (!buf) return
            const arr = Array.isArray(buf) ? buf : typeof buf.values === 'function' ? [...buf.values()] : null
            if (!arr) return
            let queued = 0
            for (let i = arr.length - 1; i >= 0 && queued < 60; i--, queued++) {
              const m = arr[i]
              const key = m && typeof resolveSenderEmoteKey === 'function' ? resolveSenderEmoteKey(m) : null
              if (key) queueSenderEmoteFetch(key, m)
            }
          }
          try {
            for (const ch of irc?.channels?.keys?.() || []) requeue(irc.getMessages(ch))
          } catch (_) {}
          try {
            for (const ch of kickChat?.channels?.keys?.() || []) requeue(kickChat.getMessages(ch))
          } catch (_) {}
        }
      } catch (_) {}
    }

    // A different user removed an emote from their set. Background already
    // dropped __senderEmoteCache; tombstone the panel's persisted
    // senderEmoteSets (dropEmoteFromAllSenders stamps removedAt) so FUTURE
    // messages stop imagifying the name while already-owned history keeps
    // its render (_sGate interval). Re-render matching messages so each row
    // settles on its interval-correct form.
    if (msg.type === 'emote_removed_broadcast' && msg.emoteName) {
      // Precise path (new servers): strip the name from exactly the pushed
      // sender's keys — no collateral, no global freshness bust.
      const precise = Array.isArray(msg.senderKeys) && msg.senderKeys.length > 0
      const changed = precise
        ? typeof dropEmoteFromSenders === 'function' && dropEmoteFromSenders(msg.senderKeys.slice(0, 30), msg.emoteName)
        : typeof dropEmoteFromAllSenders === 'function' && dropEmoteFromAllSenders(msg.emoteName)
      if (precise) {
        for (const key of msg.senderKeys.slice(0, 30)) {
          if (typeof key === 'string' && key) {
            senderEmoteFetchedAt.delete(key)
            if (msg.ver != null) {
              setSenderEmoteBustVer(key, msg.ver)
              noteSenderVer(key, msg.ver)
            }
          }
        }
      }
      if (changed) {
        try {
          // Legacy path strips by NAME from every cached set — an innocent
          // sender who owns a same-named emote just lost it too. Bust
          // freshness so their next render refetches and restores it.
          if (!precise && typeof senderEmoteFetchedAt !== 'undefined') senderEmoteFetchedAt.clear()
          const inv = (buf) => {
            if (!buf) return
            const arr = typeof buf.forEach === 'function' && !Array.isArray(buf) ? null : buf
            const iter = arr || (typeof buf.values === 'function' ? buf.values() : null)
            if (!iter) return
            for (const m of iter) {
              if (m?.text?.includes(msg.emoteName)) m._renderedHtml = null
            }
          }
          // Twitch + Kick IRC buffers (per-channel)
          try {
            for (const ch of irc?.channels?.keys?.() || []) inv(irc.getMessages(ch))
          } catch (_) {}
          try {
            for (const ch of kickChat?.channels?.keys?.() || []) inv(kickChat.getMessages(ch))
          } catch (_) {}
          if (typeof mentionsBuffer !== 'undefined') inv(mentionsBuffer)
          if (typeof channelYtMessages !== 'undefined') channelYtMessages.forEach(inv)
          // Drawn rows can be orphaned from every buffer walked above (SPA
          // nav reinits chat state) — invalidate through the _hsMsg back-ref
          // too, same as upgradeMessagesForSenders, or they stay imagified
          // forever.
          const msgsEl = document.getElementById('hs-mc-messages')
          if (msgsEl) {
            for (const div of msgsEl.querySelectorAll('.hs-mc-msg[data-msg-key]')) {
              const m = div._hsMsg
              if (m?.text?.includes(msg.emoteName)) m._renderedHtml = null
            }
          }
          // In-place swap reaches orphans and never touches scroll; the full
          // re-render only when pinned to bottom (it snaps the viewport).
          queueImmediateReprocess()
          if (!isScrolledUp) renderMessages(currentTab)
        } catch (_) {}
      }
    }

    // Server-evaluated mention rule match — show as inline toast
    if (msg.type === 'mention_rule_match') {
      const channel = String(msg.channel || '').toLowerCase()
      const username = String(msg.username || '')
      const snippet = String(msg.snippet || '').slice(0, 200)
      const pattern = String(msg.pattern || '')
      // Blocked users can't ping you, even via a server-evaluated rule.
      if (typeof isUserBlocked === 'function' && isUserBlocked(username, msg.platform)) return
      try {
        HsNotifs.emit('server-mention-rule', { channel, username, snippet, pattern })
      } catch (_) {}
    }

    // 7TV emote add/remove — surface as an inline stream-event in the
    // matching channel tab (and live tab if it IS the live channel).
    if (msg.type === 'channel_emote_added' || msg.type === 'channel_emote_removed') {
      log('7TV emote change:', msg.message)
      const channel = (msg.channel || '').toLowerCase()
      if (!channel) return
      const actor = msg.actor || ''
      // Stale-emote ghost: when an emote leaves the channel set, mark
      // historical messages so the cached IMG renders dimmed + tagged with
      // who removed it. Restored on re-add. Persisted to chrome.storage so
      // it survives reload. 7-day TTL handled at read.
      const _staleReg = window._hsStaleEmotes || (window._hsStaleEmotes = new Map())
      const _ensureChannel = (ch) => {
        let m = _staleReg.get(ch)
        if (!m) {
          m = new Map()
          _staleReg.set(ch, m)
        }
        return m
      }
      const _persistStale = () => {
        try {
          const out = {}
          const cutoff = Date.now() - 7 * 86400000
          for (const [ch, m] of _staleReg) {
            const entries = []
            for (const [name, meta] of m) {
              if ((meta?.at || 0) >= cutoff) entries.push([name, meta])
            }
            if (entries.length) out[ch] = entries.slice(-100)
          }
          browser.storage.local.set({ hs_stale_emotes_v1: out }).catch(() => {})
        } catch (_) {}
      }
      const _patchDom = (emoteName, mode, meta) => {
        try {
          // Merged stream: only touch rows from THIS channel. Row keeps the
          // original casing, registry key is lowercased — match case-insensitively.
          const rows = document.querySelectorAll(`#hs-mc-messages [data-msg-channel="${CSS.escape(channel)}" i]`)
          const nameSel = `[data-emote-name="${CSS.escape(emoteName)}"]`
          for (const row of rows) {
            for (const node of row.querySelectorAll(nameSel)) {
              const w = node.classList.contains('hs-mc-emote-wrapper') ? node : node.closest('.hs-mc-emote-wrapper')
              if (!w) continue
              // Never ghost what you own or a heatsync copy: only the channel's
              // own 7TV emote went away.
              if (mode === 'mark' && (w.dataset.state === 'owned' || w.dataset.source === 'heatsync')) continue
              // Identity guard: don't ghost a same-name emote of different art.
              if (mode === 'mark' && meta?.hash && w.dataset.emoteHash && w.dataset.emoteHash !== meta.hash) continue
              if (mode === 'mark') {
                w.classList.add('hs-state-stale')
                if (meta?.actor) w.dataset.staleActor = meta.actor
                if (meta?.at) w.dataset.staleAt = String(meta.at)
              } else {
                w.classList.remove('hs-state-stale')
                delete w.dataset.staleActor
                delete w.dataset.staleAt
              }
            }
          }
        } catch (_) {}
      }
      if (msg.type === 'channel_emote_removed' && msg.emoteName) {
        _ensureChannel(channel).set(msg.emoteName, {
          at: Date.now(),
          actor,
          hash: msg.emoteHash || '',
          provider: '7tv',
        })
        _patchDom(msg.emoteName, 'mark', { actor, at: Date.now(), hash: msg.emoteHash || '' })
        _persistStale()
      } else if (msg.type === 'channel_emote_added' && msg.emote?.name) {
        const m = _staleReg.get(channel)
        if (m?.delete(msg.emote.name)) {
          if (m.size === 0) _staleReg.delete(channel)
          _patchDom(msg.emote.name, 'unmark', null)
          _persistStale()
        }
      }
      // Build clean action text (actor rendered separately as the username-link;
      // including it inside text would duplicate it via buildMessageDiv).
      let action
      if (msg.type === 'channel_emote_added') {
        action = msg.emote?.name ? `added 7TV emote ${msg.emote.name}` : msg.message || '7TV emote set updated'
      } else {
        action = msg.emoteName ? `removed 7TV emote ${msg.emoteName}` : msg.message || '7TV emote set updated'
      }
      // Strip leading "${actor} " duplicate that bg may include in single-emote case
      if (actor && action.toLowerCase().startsWith(`${actor.toLowerCase()} `)) {
        action = action.slice(actor.length + 1)
      }
      const dedup = window._hsStreamEventDedup || (window._hsStreamEventDedup = new Map())
      const text = `[${channel}] ◆ ${action}`
      const now = Date.now()
      if (dedup.has(text) && now - dedup.get(text) < 60000) return
      dedup.set(text, now)
      if (dedup.size > 100) {
        for (const [k, t] of dedup) {
          if (now - t > 60000) dedup.delete(k)
        }
      }
      const evt = { type: 'stream-event', eventClass: 'event-emote', text, channel, actor: actor || null, time: now }
      const liveChannel = getLiveChannel()
      const chBuffer = irc?.channels?.get(channel)
      if (chBuffer) {
        const existing = chBuffer.getAll()
        if (!existing.some((m) => m.type === 'stream-event' && sameStreamEvent(m, evt))) {
          chBuffer.push(evt)
          saveStreamEvent(evt)
        }
      }
      if (channel === liveChannel) {
        const liveBuffer = irc?.channels?.get(liveChannel)
        if (liveBuffer && liveBuffer !== chBuffer) {
          const existing = liveBuffer.getAll()
          if (!existing.some((m) => m.type === 'stream-event' && sameStreamEvent(m, evt))) {
            liveBuffer.push(evt)
            if (!chBuffer) saveStreamEvent(evt)
          }
        }
      }
      try {
        pushActivityEvent(evt)
      } catch (_) {}
      const activeTab = currentTab
      if (activeTab === 'live') {
        if (isLiveChannelMessage({ channel })) {
          if (!appendMessage(evt, activeTab)) renderMessages(activeTab)
        } else {
          const liveTab = tabBarElement?.querySelector('[data-tab="live"]')
          if (liveTab && channel === liveChannel) liveTab.classList.add('has-stream-event')
        }
      } else {
        const tabCh = getChannelById(activeTab)
        if (tabCh) {
          const tw = tabCh.twitch?.toLowerCase()
          const ki = tabCh.kick?.toLowerCase()
          if (tw === channel || ki === channel) {
            if (!appendMessage(evt, activeTab)) renderMessages(activeTab)
          } else {
            const matchTab = config.channels.find(
              (c) => c.twitch?.toLowerCase() === channel || c.kick?.toLowerCase() === channel,
            )
            if (matchTab) {
              const tabEl = tabBarElement?.querySelector(`[data-tab="${CSS.escape(matchTab.id)}"]`)
              if (tabEl) tabEl.classList.add('has-stream-event')
            }
          }
        }
      }
    }
  })

  // Also listen for storage changes (more reliable)
  // Remove previous storage listener to prevent accumulation on SPA nav
  if (_mcStorageListener) chrome.storage.onChanged.removeListener(_mcStorageListener)
  _mcStorageListener = (changes, area) => {
    // UI settings synced via storage.sync (cross-tab + cross-device)
    if (area === 'sync' && changes.ui_settings) {
      const ns = changes.ui_settings.newValue || {}
      log('Settings synced:', Object.keys(ns).join(', '))

      // Registry-driven rehydration — one loop replaces the old per-key
      // blocks: cache, runtime bridge, applier, and render flags all come
      // from the schema. Same-tab echoes no-op via the changed-compare
      // (our own setSetting updated the cache before the storage write
      // landed). syncSilent entries skip their applier on remote changes
      // (e.g. a synced volume change must not play the preview ping).
      let needsRender = false
      for (const def of SETTINGS) {
        if (def.scope !== 'sync' || ns[def.key] === undefined) continue
        const v = coerceSettingValue(def, ns[def.key])
        if (v === undefined || !validateSettingValue(def, v)) continue
        const changed = JSON.stringify(v) !== JSON.stringify(getSetting(def.key))
        _settingsCache[def.key] = v
        if (!changed) continue
        const bridge = _bridgeFor(def)
        if (bridge) bridge.set(v)
        if (def.apply && !def.syncSilent) {
          const applier = _APPLIERS[def.apply]
          // 4th arg isRemote — appliers with persist side-effects must not
          // write back (N receiving tabs would each rewrite ui_settings)
          if (applier) {
            try {
              applier(v, def, false, true)
            } catch (e) {
              warn('sync applier failed:', def.apply, e)
            }
          }
        }
        if (def.rerender) needsRender = true
      }

      if (needsRender) {
        bumpRenderEpoch() // insert-only diff: existing rows need the epoch
        renderMessages(currentTab)
      }
      // Update settings panel toggles if visible
      if (currentTab === 'settings') renderSettingsTab()
    }

    if (area !== 'local') return

    // Registry-driven rehydration for local-scope settings — same loop as
    // the sync branch above. Without it every scope:'local' setting (mute
    // keywords, emote size, notifications, …) was a dead toggle across
    // tabs: the writing tab applied it, every other tab ignored the change.
    {
      let needsRender = false
      for (const def of SETTINGS) {
        if (def.scope !== 'local' || changes[def.key] === undefined) continue
        const v = coerceSettingValue(def, changes[def.key].newValue)
        if (v === undefined || !validateSettingValue(def, v)) continue
        const changed = JSON.stringify(v) !== JSON.stringify(getSetting(def.key))
        _settingsCache[def.key] = v
        if (!changed) continue
        const bridge = _bridgeFor(def)
        if (bridge) bridge.set(v)
        if (def.apply && !def.syncSilent) {
          const applier = _APPLIERS[def.apply]
          if (applier) {
            try {
              applier(v, def, false, true)
            } catch (e) {
              warn('local applier failed:', def.apply, e)
            }
          }
        }
        if (def.rerender) needsRender = true
      }
      if (needsRender) {
        bumpRenderEpoch()
        renderMessages(currentTab)
        if (currentTab === 'settings') renderSettingsTab()
      }
    }

    // Overflow bucket — large/per-tab UI prefs that bypass the 8 KB sync
    // ceiling. Local-only, so cross-device sync intentionally skips them.
    if (changes.platform_filters) {
      const v = changes.platform_filters.newValue
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        platformFilters = v
        renderMessages(currentTab)
      }
    }
    if (changes.chat_filter_rules) {
      const v = changes.chat_filter_rules.newValue
      if (typeof v === 'string') {
        let rules = []
        try {
          rules = JSON.parse(v)
        } catch {}
        compileFilterRules(Array.isArray(rules) ? rules : [])
        renderMessages(currentTab)
        if (currentTab === 'settings') renderSettingsTab()
      }
    }

    // Identity switch — compare the fields render decisions actually read, so
    // an unrelated user_info refresh (avatar, heat) doesn't force a repaint.
    if (changes.user_info) {
      const _identityOf = (v) => `${JSON.stringify(v?.sender_keys ?? null)}|${v?.username ?? ''}`
      if (_identityOf(changes.user_info.oldValue) !== _identityOf(changes.user_info.newValue)) {
        log('identity changed — repainting rows for the new account')
        const _owner = String(changes.user_info.newValue?.username || '').toLowerCase()
        if (_owner !== mentionsOwner) {
          mentionsOwner = _owner
          mentionsBuffer.length = 0
          _writeMentionsNow()
        }
        repaintForIdentityChange()
      }
    }

    // Emote updates - reload when storage changes (debounced to avoid spam)
    if (
      changes.global_emotes ||
      changes.channel_emotes_map ||
      changes.emote_inventory ||
      changes.native_twitch_emotes
    ) {
      log(
        'storage changed:',
        changes.channel_emotes_map ? 'channel_emotes_map' : '',
        changes.global_emotes ? 'global_emotes' : '',
        changes.emote_inventory ? 'emote_inventory' : '',
        changes.native_twitch_emotes ? 'native_twitch_emotes' : '',
      )
      // Cold-start vs. update split: clear cache only on the first payload
      // per scope this session. Subsequent updates (add/remove) preserve
      // _renderedHtml so removed emotes stay rendered in old messages.
      const scope = changes.global_emotes
        ? 'global'
        : changes.channel_emotes_map
          ? 'ch:_storage'
          : changes.native_twitch_emotes
            ? 'native'
            : ''
      if (scope) _pendingEmoteScopes.add(scope)
      cleanup.clearTimeout(emoteReloadTimer)
      emoteReloadTimer = cleanup.setTimeout(() => {
        const pending = _pendingEmoteScopes
        _pendingEmoteScopes = new Set()
        loadEmotes()
          .then(() => {
            // cold-load: in-place text swap (no rebuild flash), skipping the
            // visible-row swap when scrolled up. non-cold emote edits render
            // now (only when at/near bottom, to not yank a scrolled-up reader).
            if (_emoteColdLoad(pending)) reloadEmotesInPlace(!isScrolledUp)
            else if (!isScrolledUp) renderMessages(currentTab)
          })
          .catch((e) => log('[heatsync-mc] loadEmotes error:', e))
      }, 300)
    }

    // Multichat config sync (cross-tab + cross-device)
    if (changes.heatsync_multichat) {
      if (_skipNextConfigSync) {
        _skipNextConfigSync = false
      } else {
        const newConfig = changes.heatsync_multichat.newValue || { channels: [], enabled: true }
        const oldChannels = config.channels || []
        const newChannels = newConfig.channels || []

        // Diff: find added and removed channels
        const oldIds = new Set(oldChannels.map((c) => c.id))
        const newIds = new Set(newChannels.map((c) => c.id))

        // Part removed channels
        for (const ch of oldChannels) {
          const id = ch.id
          if (!newIds.has(id)) {
            const twitchName = ch.twitch
            if (twitchName) irc?.part(twitchName)
            const kickName = ch.kick
            if (kickName) kickChat?.part(kickName)
            if (ch.youtube) {
              const link = youtubeLinks.get(id)
              chrome.runtime
                .sendMessage({
                  type: 'youtube_ws_unsubscribe',
                  videoId: link?.videoId || '',
                  url: ch.youtube,
                  channelId: id,
                })
                .catch(() => {})
              youtubeLinks.delete(id)
              channelYtMessages.delete(id)
            }
          }
        }

        // Join added channels (subsystem gates: a disabled platform feed
        // never joins)
        for (const ch of newChannels) {
          const id = ch.id
          if (!oldIds.has(id)) {
            const twitchName = ch.twitch
            if (twitchName && isEnabled('irc-twitch')) {
              irc?.join(twitchName)
              safeSendMessage({ type: 'join_channel', platform: 'twitch', channel: twitchName })
            }
            const kickName = ch.kick
            if (kickName && isEnabled('chat-kick')) kickChat?.join(kickName)
            if (ch.youtube && isEnabled('chat-youtube')) {
              youtubeLinks.set(id, { url: ch.youtube, videoId: '', channelName: '' })
              // Arm the watchdog — it reads ytChanLastSeen/ytSubscribedUrls,
              // so a sub added without them is never re-subscribed on silence.
              ytSubscribedUrls.set(id, ch.youtube)
              ytChanLastSeen.set(id, Date.now())
              ytSubscribe(id, ch.youtube, id)
            }
          }
        }

        // A leg another tab added to a channel we already show (kick page
        // seeding the twitch entry's partner) joins here too.
        for (const ch of newChannels) {
          const was = oldChannels.find((c) => c.id === ch.id)
          if (!was) continue
          if (ch.twitch && !was.twitch && isEnabled('irc-twitch')) {
            irc?.join(ch.twitch)
            safeSendMessage({ type: 'join_channel', platform: 'twitch', channel: ch.twitch })
          }
          if (ch.kick && !was.kick && isEnabled('chat-kick')) kickChat?.join(ch.kick)
        }

        // Update config and UI
        config.channels = newChannels
        _channelLookup = null
        config.enabled = newConfig.enabled !== undefined ? newConfig.enabled : config.enabled
        updateTabBar()
        // If current tab was removed, fall back (temp tab or a saved one covering it)
        if (
          currentTab !== 'live' &&
          currentTab !== 'feed' &&
          currentTab !== 'mentions' &&
          currentTab !== 'whispers' &&
          !newIds.has(currentTab)
        ) {
          switchTab(liveTarget())
        }
        log('Config synced from another tab/device:', newChannels.length, 'channels')
      }
    }

    // Blocked emotes — diff-apply only the hash changes. The previous code
    // reloaded the whole set from storage and re-rendered every message,
    // which caused chat-wide flicker on every block/unblock and could revert
    // optimistic toggles if storage lagged the user action.
    if (changes.blocked_emotes) {
      applyBlockedHashDelta(changes.blocked_emotes.newValue || [])
      // applyBlockedHashDelta patches chat rows + input chips but NOT the cached
      // picker grid/search tiles — mark it dirty so the next open re-derives each
      // tile's state from the now-current blockedEmoteNames. Without this a
      // cross-tab/device block left the picker tile clickable+pasteable (it reads
      // state straight off the stale tile dataset), a real bypass not just cosmetic.
      if (typeof markPickerDirty === 'function') markPickerDirty()
    }

    // Emote/emoji scale changes from options page propagate live.
    if (changes.hs_emote_size) {
      const v = changes.hs_emote_size.newValue
      if (v === 1 || v === 2 || v === 4) {
        emoteSize = v
        applyEmoteSize()
      }
    }
    if (changes.hs_emoji_size) {
      const v = changes.hs_emoji_size.newValue
      if (v === 1 || v === 2 || v === 4) {
        emojiSize = v
        applyEmojiSize()
      }
    }

    // Multi-tab seen-state merge — without this, three open tabs writing
    // hs_tab_seen_v1 in close succession last-write-wins and lose each
    // other's per-tab seen timestamps. Merge with max-per-key so any tab
    // marking a channel seen propagates instead of getting clobbered when
    // another tab flushes.
    if (changes.hs_tab_seen_v1?.newValue && typeof changes.hs_tab_seen_v1.newValue === 'object') {
      const remote = changes.hs_tab_seen_v1.newValue
      for (const k of Object.keys(remote)) {
        const v = remote[k]
        if (typeof v === 'number' && (!tabSeenAt[k] || v > tabSeenAt[k])) {
          tabSeenAt[k] = v
        }
      }
    }
    // Registry cache + bridge coherence for local-scoped keys (cw filters,
    // hs_notifications, dim/readable/auto-claim, sizes, overflow mirrors).
    // Runs AFTER the specific handlers above — some gate their re-render on
    // var inequality, which an early bridge write would defeat.
    for (const def of SETTINGS) {
      const change =
        def.scope === 'local' ? changes[def.key] : def.scope === 'local-mirror' ? changes[def.mirrorKey] : null
      if (!change) continue
      const v = coerceSettingValue(def, change.newValue)
      if (v === undefined || !validateSettingValue(def, v)) continue
      _settingsCache[def.key] = v
      const b = _bridgeFor(def)
      if (b) b.set(v)
      // content-warning pills flip live cross-tab (BG also writes these
      // keys when the server broadcasts a settings update)
      if (def.cw && typeof v === 'boolean') {
        document.querySelectorAll(`.hs-mc-toggle-pill[data-set-key="${def.key}"]`).forEach((pill) => {
          pill.classList.toggle('active', v)
        })
      }
    }
  }
  chrome.storage.onChanged.addListener(_mcStorageListener)
}

// ============================================
// OFFLINE DETECTION
// ============================================

function detectOfflineState() {
  // On Kick, detect live status from page and set the live tab dot
  if (isKick) {
    let kickLiveFound = false
    function checkKickLive() {
      const isLive = !!document.querySelector('video')
      const liveTab = tabBarElement?.querySelector('[data-tab="live"]')
      if (liveTab) liveTab.dataset.live = String(isLive)
      const curCh = getCurrentChannel()?.toLowerCase()
      if (curCh && isLive) liveChannelSet.add(liveKey('kick', curCh))
      if (isLive) kickLiveFound = true
    }
    checkKickLive()
    // Mirrors twitch's checkOffline: self-limits at 10 fast checks so a
    // channel that never goes live doesn't poll every 1s (hidden tab
    // included) forever — graduates to the same 10s steady poll it would
    // have reached on finding live anyway.
    let fastChecks = 0
    const fastPoll = cleanup.setInterval(() => {
      checkKickLive()
      if (kickLiveFound || ++fastChecks >= 10) {
        cleanup.clearInterval(fastPoll)
        cleanup.setIntervalIfVisible(checkKickLive, 10000)
      }
    }, 1000)
    return
  }
  // On YouTube, the live_chat iframe only loads on live streams; presence
  // there is the most reliable "is live" signal we can get without polling
  // the InnerTube API.
  if (hostPlatform === 'yt') {
    // True while WE collapsed yt's native chat (vs the user having done it
    // themselves) — gates the symmetric restore in checkYtLive.
    let _hsCollapsedNativeYt = false
    let _hsForcedYtDark = false // we set youtube's dark attribute, so we are the ones to take it off
    let _hsHidNativeYt = false
    let _hsYtFrameEmptySince = 0
    let _hsPrevShowYtChat = null
    function checkYtLive() {
      // Keep theatre state honest from the same 1.5s tick — the attribute
      // observer has been seen missing the [theater] flip (body stuck on
      // hs-mode-normal inside theatre), which strands every .hs-mode-theatre
      // rule. detectTheatreMode no-ops when nothing changed.
      try {
        detectTheatreMode()
      } catch (_) {}
      // A LIVE stream mounts ytd-live-chat-frame#chat with a LIVE chat iframe
      // (/live_chat). A VOD of a past stream mounts the SAME element but with a
      // chat-REPLAY iframe (/live_chat_replay) — so frame-presence alone wrongly
      // flags VODs as live and surfaced our panel on non-live videos. Distinguish
      // by the iframe src (the same signal youtube-content.js gates on): replay ⇒
      // treat as non-live so the panel stays hidden on VODs by default.
      const frameEl = document.querySelector('ytd-live-chat-frame#chat')
      const chatSrc = frameEl?.querySelector('iframe')?.getAttribute('src') || ''
      const isReplayChat = chatSrc.includes('live_chat_replay')
      // Require a RESOLVED src before treating this as live: the frame mounts
      // for both live and VOD before its iframe src populates, and an empty
      // src is not yet 'live_chat_replay' — so a bare !isReplayChat would
      // flash chat onto a VOD during that window. Empty src = inconclusive,
      // let the default hs-offline hold until the src truly resolves.
      const hasLiveChat = !!frameEl && !!chatSrc && !isReplayChat
      const _ytFlowing =
        typeof channelYtMessages !== 'undefined' ? channelYtMessages.get('__live_yt_auto__')?.length || 0 : 0
      // Live dot needs a CONFIRMED signal: resolved live src or messages
      // actually flowing. _autoYtVideoId is just the render gate — it's set
      // on EVERY /watch page, so counting it lit the dot on plain VODs.
      const isLive = hasLiveChat || _ytFlowing > 0
      const liveTab = tabBarElement?.querySelector('[data-tab="live"]')
      if (liveTab) liveTab.dataset.live = String(isLive)
      // Show the multichat panel on YT only when THIS page has its own LIVE
      // chat (a livestream), OR the user opted into chat on non-live pages
      // (ytChatOnNonLive → body.hs-yt-nonlive-chat). hs-offline drives both the
      // existing :not(.hs-offline) layout gating AND the panel-hide rule below,
      // so this single signal hides the panel on VODs/home/search by default.
      // Use hasLiveChat (THIS page, live-not-replay) — NOT isLive, which is true
      // whenever any tracked YT channel is live and would surface it on a VOD.
      // hasLiveChat relies on the live-chat iframe's `src` attribute — but
      // current YouTube leaves that src EMPTY on live streams (the frame mounts
      // and loads its chat without ever populating the src attr), so the src
      // check alone mis-flagged live streams as offline and hid the ENTIRE
      // panel (hs-offline → display:none). Ground truth instead: the server
      // only relays __live_yt_auto__ chat for a genuinely-live stream, so once
      // messages are flowing for THIS page it IS live, iframe src be damned.
      // The old gate required the live-chat iframe's `src` to be a populated
      // `/live_chat` url — but current YouTube leaves that src EMPTY on live
      // streams, so it hid the panel on EVERY livestream. Relax it: a chat
      // frame that is present and NOT a replay is a livestream (empty src =
      // not-yet-replay = live; a VOD's src resolves to `live_chat_replay` and
      // flips this off). Show immediately, no wait. Two more signals keep it
      // honest: chat actively flowing (server only relays for live) and the
      // non-live opt-in.
      const liveChatFramePresent = !!frameEl && !isReplayChat
      const ytAutoLiveMsgs = _ytFlowing
      const ownsChat = ytOwnsChat()
      document.body.classList.toggle('hs-yt-owns-chat', ownsChat)
      // YouTube's chat is the only chat on this page: give back a frame we hid on an earlier page
      if (ownsChat && frameEl?.dataset.hsHidden) {
        frameEl.style.display = frameEl.dataset.hsPrevDisplay || ''
        delete frameEl.dataset.hsHidden
        delete frameEl.dataset.hsPrevDisplay
      }
      const showYtChat =
        !isYtReplayPopout &&
        (isYtPopout ||
          (!ownsChat &&
            (liveChatFramePresent || ytAutoLiveMsgs > 0 || document.body.classList.contains('hs-yt-nonlive-chat'))))
      // YT sizes its grids/columns from a width measured once per resize —
      // the panel's reserve appearing/vanishing without one strands a
      // squeezed layout (3-col home grid + dead column where the panel
      // was). Nudge a re-measure whenever panel visibility actually flips.
      // First run compares against the early-layout BOOT stamp (the state
      // YT first measured under), so a stale localStorage mirror still
      // gets its correction resize.
      if (_hsPrevShowYtChat === null) {
        _hsPrevShowYtChat = !document.body.classList.contains('hs-offline')
      }
      document.body.classList.toggle('hs-offline', !showYtChat)
      // The panel's column is dark by design, and youtube's own light theme leaves its buttons, search bar
      // and menus dark-on-dark beside it. Flip youtube to its dark tokens while the panel is up (the
      // same set it uses for a dark-theme user) and hand its own choice back when the panel goes.
      {
        const html = document.documentElement
        const app = document.querySelector('ytd-app')
        if (showYtChat && !html.hasAttribute('dark')) {
          html.setAttribute('dark', '')
          app?.setAttribute('dark', '')
          _hsForcedYtDark = true
        } else if (!showYtChat && _hsForcedYtDark) {
          html.removeAttribute('dark')
          app?.removeAttribute('dark')
          _hsForcedYtDark = false
        }
      }
      if (_hsPrevShowYtChat !== showYtChat) {
        try {
          window.dispatchEvent(new Event('resize'))
        } catch (_) {}
      }
      _hsPrevShowYtChat = showYtChat
      // Watch-page detection: ytd-watch-flexy stays in DOM with `hidden`
      // attr off-watch — only count it as a watch page when visible.
      const onWatch = !!document.querySelector('ytd-watch-flexy:not([hidden])')
      document.body.classList.toggle('hs-yt-watch', onWatch)
      // Shorts pages render via ytd-shorts (never ytd-watch-flexy), so
      // without this class the generic non-watch squeeze rules fired there
      // and shrank the shorts UI with no compensation. Shorts gets neither
      // squeeze nor panel (17-platform-position.css gates on it).
      const onShorts = location.pathname.startsWith('/shorts/') || !!document.querySelector('ytd-shorts:not([hidden])')
      document.body.classList.toggle('hs-yt-shorts', onShorts)
      // CONFIRMED live only (resolved live src, messages flowing, or src
      // still empty after a grace window) — the destructive actions below
      // must never fire on the inconclusive empty-src window: collapsing
      // there UNLOADS the iframe, so a VOD's src can never resolve to
      // live_chat_replay and the page stays permanently misclassified as
      // live with its replay chat destroyed. A VOD's replay src populates
      // within a couple seconds of mount; live streams often leave it empty
      // FOREVER — so empty-past-8s counts as live (covers quiet streams
      // where no relayed message arrives to confirm).
      if (frameEl && !chatSrc) {
        if (!_hsYtFrameEmptySince) _hsYtFrameEmptySince = Date.now()
      } else {
        _hsYtFrameEmptySince = 0
      }
      const _emptySrcAged = _hsYtFrameEmptySince && Date.now() - _hsYtFrameEmptySince > 8000
      const confirmedLive = hasLiveChat || ytAutoLiveMsgs > 0 || !!_emptySrcAged
      // Hide native YT chat once it mounts — but ONLY when we're showing our
      // panel in its place AND the page is confirmed live. On a replay VOD
      // (no opt-in) we leave YT's chat replay visible.
      // Went native last time and never came back: the frame is up, so take the pane again.
      if (_savedYtNative && frameEl && !ytPeeking() && document.getElementById('hs-mc-container')) ytPeekNative()
      if (showYtChat && confirmedLive && frameEl && frameEl.style.display !== 'none' && !ytPeeking()) {
        frameEl.style.display = 'none'
        _hsHidNativeYt = true
      }
      // display:none alone never releases YT's LAYOUT reservation: flexy
      // sizes the player off its own chat-collapsed state, not CSS
      // visibility — so theatre kept the video ~300px narrow with a dead
      // gap where yt still reserved its chat column (live-verified: click
      // yt's own collapse → collapsed attr → player snaps to full row).
      // Drive yt's real collapse; the attr guard makes this a one-shot.
      if (
        showYtChat &&
        confirmedLive &&
        frameEl &&
        !frameEl.hasAttribute('collapsed') &&
        !ytFrameIsTheFeed() &&
        !ytPeeking()
      ) {
        try {
          frameEl.querySelector('#show-hide-button button')?.click()
          _hsCollapsedNativeYt = true
        } catch (_) {}
      }
      // Arrived on a premiere with the frame still collapsed by us on the page before: reopen it, the
      // relay inside it is this page's only feed.
      if (ytFrameIsTheFeed() && frameEl && _hsCollapsedNativeYt && frameEl.hasAttribute('collapsed')) {
        try {
          frameEl.querySelector('#show-hide-button button')?.click()
          _hsCollapsedNativeYt = false
        } catch (_) {}
      }
      // Symmetric restore — if the panel goes away (opt-out flip, stream
      // ends, or the page resolved to a VOD) and WE hid/collapsed native
      // chat, give it back.
      if (!showYtChat && frameEl && _hsHidNativeYt && frameEl.style.display === 'none') {
        frameEl.style.removeProperty('display')
        _hsHidNativeYt = false
      }
      if (!showYtChat && frameEl && _hsCollapsedNativeYt && frameEl.hasAttribute('collapsed')) {
        try {
          if (frameEl.style.display === 'none') frameEl.style.removeProperty('display')
          frameEl.querySelector('#show-hide-button button')?.click()
          _hsCollapsedNativeYt = false
        } catch (_) {}
      }
    }
    checkYtLive()
    // 1.5s steady poll (was 4s): catches live→offline transitions + (only
    // while visible) keeps the panel state honest.
    cleanup.setIntervalIfVisible(checkYtLive, 1500)
    // Fast initial detection: the live_chat iframe lazy-loads after first
    // paint, and the panel now defaults HIDDEN until detected — without this
    // burst the panel would pop in up to 1.5s late on every livestream. Plain
    // timeouts (not IfVisible) so a freshly-opened/focused livestream resolves
    // in ~300ms. Cheap (a few DOM checks); they no-op once steady-state holds.
    ;[250, 600, 1100, 2000, 3500].forEach((ms) => {
      cleanup.setTimeout(checkYtLive, ms)
    })
    return
  }
  // Popout chat has no video — don't mark as offline
  if (location.pathname.match(/^\/(popout|embed)\//)) return

  let wasOffline = null
  // Element caches: checkOffline fires on every player-region React flush
  // (rAF-coalesced) + the polls below; two full-document querySelectors per
  // call added up. Re-query only when the cached node left the DOM — same
  // semantics (a removed indicator/video re-queries and correctly reads
  // offline; a connected one means live either way). Per-mount scope, so
  // SPA nav resets both naturally.
  let _playerEl = null
  let _liveEl = null

  function checkOffline() {
    if (!_playerEl?.isConnected) _playerEl = document.querySelector('.channel-root__player')
    const playerOffline = _playerEl
      ? _playerEl.classList.contains('channel-root__player--offline')
      : !!document.querySelector('.channel-root__player--offline')
    if (_liveEl && !_liveEl.isConnected) _liveEl = null
    if (!playerOffline && !_liveEl) {
      _liveEl = document.querySelector(
        '[class*="stream-type-indicator"], [data-a-target="player-overlay-click-handler"] video, .video-player video',
      )
    }
    const isLive = !playerOffline && !!_liveEl
    const isOffline = !isLive
    document.body.classList.toggle('hs-offline', isOffline)
    // On state change, recalculate player width
    if (wasOffline !== null && wasOffline !== isOffline) {
      applyChatWidth()
    }
    wasOffline = isOffline
  }

  // Immediate check
  checkOffline()

  // Fast polling for first 10s (covers React paint delay)
  let fastChecks = 0
  const fastId = cleanup.setInterval(() => {
    checkOffline()
    if (++fastChecks >= 10) cleanup.clearInterval(fastId)
  }, 1000)

  // Steady-state polling
  cleanup.setIntervalIfVisible(checkOffline, 5000)

  // MutationObserver for instant transitions. Narrowed to the player region
  // (parent of .channel-root__player, so a wholesale player-node swap is
  // still a visible childList mutation) — observing the full channel-root
  // subtree meant record generation on every React flush anywhere on the
  // page (~2500 nodes) when only the player (~200) matters here. The 1s/5s
  // polls above remain the correctness backstop if the region itself is
  // replaced mid-view.
  const _playerForObs = document.querySelector('.channel-root__player')
  const root = _playerForObs?.parentElement || document.querySelector('[class*="channel-root"]')
  if (root) {
    // Coalesce to one check per frame — Twitch's React reconciler mutates this
    // subtree continuously; an unthrottled callback burns CPU on every flush.
    let offlineCheckQueued = false
    const observer = new MutationObserver(() => {
      if (offlineCheckQueued) return
      offlineCheckQueued = true
      cleanup.raf(() => {
        offlineCheckQueued = false
        checkOffline()
      })
    })
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })
    cleanup.trackObserver(observer)
  }
}
