// part 2 of 8 of the multichat main body — settings store, bridge and gates, stream-event persistence.
// one scope with the other main-*.js parts and main.js at bundle time (build.js MAIN_PARTS, in list order).
// no wrapper here: the IIFE is the bundle's.

// Stream event user colors — login → color (populated from server on connect)
const streamColorMap = new Map()

// Init-time storage cache — load* functions all read the SAME `ui_settings`
// key. Without this, init() fires 17+ separate sync IPCs to chrome.storage.
// One `cachedUiSettings()` call boots a single in-flight Promise that every
// loader awaits. Cleared at end of init so post-load changes go to disk.
let _uiSettingsCachePromise = null
function cachedUiSettings() {
  if (!_uiSettingsCachePromise) {
    _uiSettingsCachePromise = chrome.storage.sync.get(['ui_settings'])
  }
  return _uiSettingsCachePromise
}
function invalidateUiSettingsCache() {
  _uiSettingsCachePromise = null
}

// Overflow cache — large/per-tab settings live in chrome.storage.local
// (unlimitedStorage permission) instead of sync (8 KB QUOTA_BYTES_PER_ITEM).
// Keeps sync featherweight for cross-device prefs and avoids ever-bloating
// the single ui_settings record with platformFilters[tabId] / keyword text.
let _uiOverflowCachePromise = null
function cachedUiOverflow() {
  if (!_uiOverflowCachePromise) {
    _uiOverflowCachePromise = chrome.storage.local.get(['platform_filters', 'chat_filter_rules'])
  }
  return _uiOverflowCachePromise
}
function invalidateUiOverflowCache() {
  _uiOverflowCachePromise = null
}

// One-shot migration: heal any chrome.storage.sync.ui_settings record that
// accumulated indexed-key bloat (server fanout used to merge raw payloads
// without validation, which once injected `{0:{},1:"...",...}` shaped data
// and pushed the record over the 8 KB QUOTA_BYTES_PER_ITEM ceiling).
// Idempotent + race-safe — multiple tabs running in parallel converge to
// the same cleaned record. Gated by ui_settings_migrated_v2 in local.
async function migrateUiSettingsOnce() {
  try {
    const flag = await browser.storage.local.get('ui_settings_migrated_v2')
    if (flag.ui_settings_migrated_v2) return
    const synced = await browser.storage.sync.get('ui_settings')
    const cleaned = sanitizeUiSettings(synced.ui_settings || {})
    const writes = []
    writes.push(browser.storage.sync.set({ ui_settings: cleaned }))
    writes.push(browser.storage.local.set({ ui_settings_migrated_v2: true }))
    await Promise.all(writes.map((p) => p.catch(() => {})))
    invalidateUiSettingsCache()
    invalidateUiOverflowCache()
  } catch {}
}

// Bound localStorage chat_history footprint. These keys can accumulate to
// 2 MB+ on heavy users (tracked across many channels over months). Keep
// newest N channels by savedAt/last-write timestamp; older keys evict.
// Runs once per session as an opportunistic janitor.
function pruneChatHistoryOnce() {
  try {
    const HISTORY_KEEP = 5
    const MSG_CACHE_KEEP = 5
    const collect = (prefix) => {
      const entries = []
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        if (!k?.startsWith(prefix)) continue
        let ts = 0
        try {
          const raw = localStorage.getItem(k)
          const parsed = raw ? JSON.parse(raw) : null
          ts = parsed?.savedAt || parsed?.ts || parsed?.timestamp || 0
        } catch {}
        entries.push({ k, ts, sz: (localStorage.getItem(k) || '').length })
      }
      return entries
    }
    const evict = (entries, keep) => {
      if (entries.length <= keep) return
      entries.sort((a, b) => a.ts - b.ts) // oldest first
      for (let i = 0; i < entries.length - keep; i++) {
        try {
          localStorage.removeItem(entries[i].k)
        } catch {}
      }
    }
    evict(collect('hs_chat_history_'), HISTORY_KEEP)
    evict(collect('hs_msg_cache_'), MSG_CACHE_KEEP)
  } catch {}
}

// Batched ui_settings writer — coalesces multiple saves into one read-modify-write
let _pendingSettings = null
let _settingsSaveTimer = null

// Layout-critical keys mirror to localStorage so early-layout.js can
// read them sync at document_start (before chrome.storage is available
// to content scripts). Eliminates the cold-boot flash on hard refresh.
const _LAYOUT_MIRROR_KEYS = new Set(['tabPosition', 'chatPosition'])
function _mirrorLayoutToLS(key, value) {
  try {
    localStorage.setItem(`hs_layout_${key}`, JSON.stringify(value))
  } catch {}
}

// Cross-fade the document_start prepaint pseudo-element with the real
// multichat container. Both transition over 200ms — prepaint opacity 1→0
// while container opacity 0→1 — so there's no visible black gap or
// tab-bar pop. Two rAFs before the fade guarantee the overlay has
// actually painted before the swap starts (rAF 1 = post-style commit,
// rAF 2 = post-paint).
function tearDownPrepaint() {
  const html = document.documentElement
  const container = document.getElementById('hs-mc-container')
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      // Always (re)apply on every call — container can be recreated on
      // SPA navigation, and a fresh element won't carry the class.
      if (container) container.classList.add('hs-mc-shown')
      // Clear whatever prepaint is currently up, not just the first one:
      // early-layout re-arms on SPA navigation into a chat page (booting on
      // /directory and clicking a stream), so a later mount must be able to
      // fade its bar out too. Without this the re-armed bar sat until the
      // 4s self-destruct. No-ops when nothing is armed.
      if (!html.classList.contains('hs-prepaint-active')) return
      html.classList.add('hs-prepaint-fade')
      setTimeout(() => {
        html.classList.remove('hs-prepaint-active')
        html.classList.remove('hs-prepaint-fade')
        document.getElementById('hs-early-layout')?.remove()
      }, 220)
    })
  })
}

// THE ui_settings writer. Every sync-scope write goes through the SW's
// serialized rmw chain — a content-script get→merge→set races that chain (and
// every other tab's), and the loser's keys vanish with no error. Direct write
// only as a last resort: when the SW is unreachable (context invalidated), a
// raced write still beats a silently dropped setting.
async function writeUiSettings(patch) {
  const resp = await safeSendMessage({ type: 'ui_settings_rmw', patch })
  if (resp?.ok) return true
  try {
    const s = await browser.storage.sync.get(['ui_settings'])
    await browser.storage.sync.set({ ui_settings: sanitizeUiSettings({ ...(s.ui_settings || {}), ...patch }) })
    return true
  } catch (_) {
    return false
  }
}

function saveUiSetting(key, value) {
  if (!_pendingSettings) _pendingSettings = {}
  _pendingSettings[key] = value
  if (_LAYOUT_MIRROR_KEYS.has(key)) _mirrorLayoutToLS(key, value)
  if (_settingsSaveTimer) cleanup.clearTimeout(_settingsSaveTimer)
  _settingsSaveTimer = cleanup.setTimeout(() => {
    const pending = _pendingSettings
    _pendingSettings = null
    _settingsSaveTimer = null

    // Split: blocklist keys go to chrome.storage.local (no quota cap).
    // Everything else goes to chrome.storage.sync. The ws fanout patch is
    // a third, overlapping view: syncPatch keys PLUS any blocklist key
    // that's a real cross-device preference (not DEVICE_LOCAL_KEYS) and
    // fits under LARGE_KEY_SYNC_MAX — chatFilterRules
    // ride the server channel this way even though they never touch
    // chrome.storage.sync directly (8KB ceiling).
    const localPatch = {}
    const syncPatch = {}
    const wsPatch = {}
    for (const k in pending) {
      const v = pending[k]
      if (UI_SYNC_BLOCKLIST.has(k)) {
        const mirrorKey = OVERFLOW_MIRROR_KEYS[k]
        if (mirrorKey) localPatch[mirrorKey] = v
        if (isLargeKeySyncEligible(k, v)) {
          // large free-text keys ride a SLOWER debounce (below) — the 100ms
          // flush is tuned for toggles; a keystroke-by-keystroke textarea
          // edit would otherwise fan a fresh up-to-32KB patch to every
          // device several times per edit session
          _pendingLargeWsPatch[k] = v
        } else if (!DEVICE_LOCAL_KEYS.has(k)) {
          warn(
            'settings sync: skipping',
            k,
            '—',
            estimateSettingSize(v),
            'bytes exceeds',
            LARGE_KEY_SYNC_MAX,
            'cap, staying device-local',
          )
        }
      } else {
        syncPatch[k] = v
        wsPatch[k] = v
      }
    }

    if (Object.keys(localPatch).length) {
      invalidateUiOverflowCache()
      browser.storage.local.set(localPatch).catch(() => {})
    }

    if (Object.keys(syncPatch).length) {
      invalidateUiSettingsCache()
      ;(async () => {
        // Quota guard: chrome.storage.sync caps each key at 8192 bytes.
        // Check usage before writing — warn + toast if near the ceiling.
        try {
          const used = await browser.storage.sync.getBytesInUse('ui_settings')
          if (used > 7000) {
            warn('ui_settings quota near limit:', used, '/ 8192 bytes')
            showToast(t('mc_main_quota_near_limit'), 'error')
          }
        } catch (_) {
          /* getBytesInUse unavailable (Firefox MV2) — skip check */
        }
        if (!(await writeUiSettings(syncPatch))) {
          warn('ui_settings write failed')
          showToast(t('mc_main_settings_save_failed'), 'error')
        }
      })()
    }

    if (Object.keys(wsPatch).length) {
      // Cross-surface insta-sync: server merges + fans out to every other
      // client of this user (other tabs, ext on Twitch/Kick/YT, heatsync.org).
      // chrome.storage.sync only syncs Chrome → Chrome with same Google
      // account; server-backed covers Firefox + heatsync.org + signed-out
      // Chrome profiles using the same heatsync login. Only DEVICE_LOCAL_KEYS
      // (platformFilters) are omitted — genuinely per-device, not a pref.
      safeSendMessage({
        type: 'ws_send',
        data: { type: 'ui-state:sync', patch: wsPatch },
      })
    }

    if (Object.keys(_pendingLargeWsPatch).length) {
      if (_largeWsPatchTimer) cleanup.clearTimeout(_largeWsPatchTimer)
      _largeWsPatchTimer = cleanup.setTimeout(() => {
        _largeWsPatchTimer = null
        const patch = _pendingLargeWsPatch
        _pendingLargeWsPatch = {}
        safeSendMessage({
          type: 'ws_send',
          data: { type: 'ui-state:sync', patch },
        })
      }, 1200)
    }
  }, 100)
}

// large-key ws fanout buffer — see saveUiSetting's slow-debounce comment
let _pendingLargeWsPatch = {}
let _largeWsPatchTimer = null

// ─── settings registry engine ─────────────────────────────────────────
// SETTINGS (src/lib/settings-schema.js) is the declarative catalog; this
// engine is the single runtime around it: hydrate (loadAllSettings), read
// (getSetting), write (setSetting → existing saveUiSetting/local storage
// paths, preserving the debounce, sync/local split, quota guard, and ws
// ui-state:sync fanout), reset (resetSettingsToDefaults). Legacy
// module-level `let` vars stay the in-render source of truth via
// _RUNTIME_BRIDGE until every reader moves to getSetting(); the bridge
// keeps both views of a value identical during the migration.
const _SETTINGS_BY_KEY = new Map(SETTINGS.map((d) => [d.key, d]))
const _settingsCache = {}
// True only once loadAllSettings() has actually finished writing the cache.
// Boot wraps that load in Promise.race(..., 5s), so a slow chrome.storage.sync
// lets init continue with an EMPTY cache — and getSetting() then silently
// returns registry defaults that look exactly like real user settings. Any
// one-shot migration that reads a setting must check this first, or it
// "migrates" against a default and burns its guard for good.
let _settingsHydrated = false
// locale option labels live in browser-api.js (single source of locale
// display names) — hydrate the schema's value-only options once
for (const _locOpt of _SETTINGS_BY_KEY.get('hs_ui_locale').options) {
  _locOpt.label = I18N_LOCALE_NAMES[_locOpt.value] || _locOpt.value
}

// runtimeVar name → {get,set} over the legacy module-level binding.
// Closures only execute post-init, so referencing `let`s declared further
// down the file (or in modules) is TDZ-safe here.
const _RUNTIME_BRIDGE = {
  wysiwygEnabled: {
    get: () => wysiwygEnabled,
    set: (v) => {
      wysiwygEnabled = v
    },
  },
  linksEnabled: {
    get: () => linksEnabled,
    set: (v) => {
      linksEnabled = v
    },
  },
  linkPreviewsEnabled: {
    get: () => linkPreviewsEnabled,
    set: (v) => {
      linkPreviewsEnabled = v
    },
  },
  mediaEmbedsEnabled: {
    get: () => mediaEmbedsEnabled,
    set: (v) => {
      mediaEmbedsEnabled = v
    },
  },
  viModeEnabled: {
    get: () => viModeEnabled,
    set: (v) => {
      viModeEnabled = v
    },
  },
  platformBadgesEnabled: {
    get: () => platformBadgesEnabled,
    set: (v) => {
      platformBadgesEnabled = v
    },
  },
  textBadgesEnabled: {
    get: () => textBadgesEnabled,
    set: (v) => {
      textBadgesEnabled = v
    },
  },
  pronounsEnabled: {
    get: () => pronounsEnabled,
    set: (v) => {
      pronounsEnabled = v
    },
  },
  hoverReplyEnabled: {
    get: () => hoverReplyEnabled,
    set: (v) => {
      hoverReplyEnabled = v
      if (!v) hoverReplyOff()
    },
  },
  zebraEnabled: {
    get: () => zebraEnabled,
    set: (v) => {
      zebraEnabled = v
    },
  },
  whisperToastEnabled: {
    get: () => whisperToastEnabled,
    set: (v) => {
      whisperToastEnabled = v
    },
  },
  scrollWheelVolumeEnabled: {
    get: () => scrollWheelVolumeEnabled,
    set: (v) => {
      scrollWheelVolumeEnabled = v
    },
  },
  // setter also feeds the window flag content.js reads for timestamp paint
  timestampsEnabled: {
    get: () => timestampsEnabled,
    set: (v) => {
      timestampsEnabled = v
      window._hsTimestampsEnabled = v
    },
  },
  avatarsEnabled: {
    get: () => avatarsEnabled,
    set: (v) => {
      avatarsEnabled = v
    },
  },
  autoClaimPoints: {
    get: () => autoClaimPoints,
    set: (v) => {
      autoClaimPoints = v
    },
  },
  dimTimeouts: {
    get: () => dimTimeouts,
    set: (v) => {
      dimTimeouts = v
    },
  },
  modConfirmBan: {
    get: () => modConfirmBan,
    set: (v) => {
      modConfirmBan = v
    },
  },
  modBanReasons: {
    get: () => modBanReasons,
    set: (v) => {
      modBanReasons = v
    },
  },
  readableNamesEnabled: {
    get: () => readableNamesEnabled,
    set: (v) => {
      readableNamesEnabled = v
    },
  },
  autoHideInput: {
    get: () => autoHideInput,
    set: (v) => {
      autoHideInput = v
    },
  },
  firstChatterGlow: {
    get: () => firstChatterGlow,
    set: (v) => {
      firstChatterGlow = v
    },
  },
  emoteSize: {
    get: () => emoteSize,
    set: (v) => {
      emoteSize = v
    },
  },
  emojiSize: {
    get: () => emojiSize,
    set: (v) => {
      emojiSize = v
    },
  },
  emoteAnimationMode: {
    get: () => emoteAnimationMode,
    set: (v) => {
      emoteAnimationMode = v
    },
  },
  tabPosition: {
    get: () => tabPosition,
    set: (v) => {
      tabPosition = v
    },
  },
  chatPosition: {
    get: () => chatPosition,
    set: (v) => {
      chatPosition = v
    },
  },
  modToolbarButtons: {
    get: () => [...modToolbarButtons],
    set: (v) => {
      modToolbarButtons = v.filter((id) => MOD_BUTTON_CATALOG[id])
    },
  },
  hiddenTabs: {
    get: () => [...hiddenTabs],
    set: (v) => {
      hiddenTabs = new Set(v)
    },
  },
  // boolmap runtime objects — coercion already filtered to known subkeys
  inlineNotifs: {
    get: () => ({ ...inlineNotifs }),
    set: (v) => {
      for (const k in v) inlineNotifs[k] = !!v[k]
    },
  },
  hermesToggles: {
    get: () => ({ ...hermesToggles }),
    set: (v) => {
      for (const k in v) hermesToggles[k] = !!v[k]
    },
  },
}
// apply id → side-effect runner. Each mirrors the legacy toggle/save
// function's effects exactly. onLoad=true on the single init pass —
// skips work that only makes sense on an interactive change.
const _APPLIERS = {
  rebuildInput: () => rebuildInput(),
  spellcheck: (v) => hsApplySpellcheck(v),
  srAnnounce: (v) => srApplyMode(v),
  // Repaint every tab and start/stop the heat ticker to match the new mode.
  tabCounter: () => {
    refreshTabCounters()
  },
  namePaints: (v) => {
    // Toggle off: drop the injected <style id="hs-mc-paints"> sheet (rather
    // than leaving stale/orphaned rules behind — hygiene, no correctness
    // impact since bumpRenderEpoch's rebuild below already stops adding the
    // hsp-* class to any element). Cache entries are kept; a later toggle-on
    // recompiles fresh from the same spec.
    if (!v) clearHsPaintSheet()
    // toggle ON: cached specs kept their hsp-<hash> class on rows but the
    // sheet was dropped — re-inject so painted names aren't left unstyled.
    else if (typeof reinjectHsPaintSheet === 'function') reinjectHsPaintSheet()
  },
  viMode: (v) => {
    // mirror to localStorage + notify MAIN-world vi-mode.js
    try {
      const ls = JSON.parse(localStorage.getItem('heatsync-extension-settings') || '{}')
      ls.viMode = v
      localStorage.setItem('heatsync-extension-settings', JSON.stringify(ls))
    } catch (_) {}
    window.postMessage(
      { type: 'heatsync-settings-changed', nonce: window.HS?.getMainWorldNonce?.() || null, settings: { viMode: v } },
      location.origin,
    )
  },
  autoHide: (v) => {
    const bar = document.getElementById('hs-mc-inputbar')
    // Honor the pop-out override — never actually hide there even if the
    // setting is switched on (canAutoHideInput would keep it off anyway).
    // Switching auto-hide OFF still can't conjure a composer on a tab that
    // has nowhere to send.
    if ((v && !isYtPopout) || !tabAcceptsInput(currentTab)) {
      if (bar) bar.classList.add('hs-hidden')
      inputBarVisible = false
    } else {
      if (bar) bar.classList.remove('hs-hidden')
      inputBarVisible = true
    }
    // The composer just changed height — the open picker mirrors the message
    // list's box, so re-measure rather than leaving it short or overhanging.
    syncPickerBox()
  },
  autoClaim: (v) => {
    if (v) startAutoClaimPoller()
    else stopAutoClaimPoller()
  },
  ytSuggestions: (v) => {
    // YT-only body class; CSS un-collapses #secondary into a vertical strip
    // beside the title column (left/right dock). Harmless off-YT (no match).
    try {
      document.body.classList.toggle('hs-yt-suggestions', !!v)
    } catch (_) {}
    try {
      applyPlatformPositionOverrides()
    } catch (_) {}
  },
  ytNonLiveChat: (v) => {
    // YT-only, default ON: show the panel on every YT page (home/VOD/search),
    // not just livestreams. Opting out hides it everywhere except livestreams.
    // Harmless off-YT (no match).
    try {
      document.body.classList.toggle('hs-yt-nonlive-chat', !!v)
    } catch (_) {}
    // Mirror for early-layout.js: it stamps the boot body state (panel vs
    // hs-offline) at document_start, before chrome.storage is readable —
    // without this YT measures its grid during the wrong-state window and
    // strands a squeezed layout. Runs on load + change (applyOnLoad).
    try {
      localStorage.setItem('hs_layout_ytNonLiveChat', v ? '1' : '0')
    } catch (_) {}
  },
  filterRules: () => {
    let rules = []
    try {
      rules = JSON.parse(getSetting('chatFilterRules') || '[]')
    } catch {}
    compileFilterRules(Array.isArray(rules) ? rules : [])
  },
  fonts: () => {
    applyFontSettings(getSetting('fontFamily'), getSetting('fontSize'), getSetting('customFontName'))
  },
  emoteSize: (_v, _def, onLoad) => {
    applyEmoteSize()
    if (onLoad) return
    // URLs encode size — picker DOM is now stale
    markPickerDirty()
    prebuildPickerIdle()
  },
  emojiSize: () => {
    applyEmojiSize()
  },
  hiddenTabs: () => {
    applyHiddenTabs()
  },
  // density — pure CSS vars, no re-render needed
  density: () => {
    // the shared row layer's vertical gutter (brand tokens: compact 0, cozy 3px — as on the site)
    document.documentElement.style.setProperty(
      '--brand-row-pad-y',
      getSetting('messageDensity') === 'cozy' ? BRAND.row.padYCozy : BRAND.row.padY,
    )
  },
  // rendered html is cached per message — a src change needs a cache
  // flush before the re-render or old animated imgs survive the toggle
  emoteAnimation: (v, _def, onLoad) => {
    // Drives the hs-fx-* animation gate in 10-emotes.css (never → off,
    // hover → row-hover only). Set on load too, before the early return.
    document.documentElement.dataset.hsEmoteAnim = v || 'always'
    if (onLoad) return
    clearRenderedHtmlCache()
    renderMessages(currentTab)
    // Offscreen idle gate only exists for 'always' (hover/never already
    // render static). Leaving it: tear down now, don't wait for the next
    // scroll to notice the mode changed. Entering it: force one sweep so
    // the freshly-rendered rows get gated without waiting on a scroll.
    if ((v || 'always') === 'always') scheduleHsEmoteIdleSweep(true)
    else teardownHsEmoteIdleGate()
  },
  paintAnimation: (v, _def, onLoad) => {
    // Drives the paint kill-switch in paints.js / youtube-content.js. Set on
    // load too, before the early return — see applyOnLoad in the schema.
    // No re-render: the paints sheet is CSS-only, so the attribute flip is
    // the whole effect and every painted name on screen follows it live.
    document.documentElement.dataset.hsPaintAnim = v || 'always'
    if (onLoad) return
    // A composited fill's mounted mask/layers are pure overhead once every
    // animation is frozen — drop them; flipping back rebuilds from the
    // specs still cached (see paints.js's unmount/remountAllHsFillLayers).
    if ((v || 'always') === 'never') unmountAllHsFillLayers()
    else remountAllHsFillLayers()
  },
  locale: (v) => {
    setI18nLocale(v).catch(() => {})
  },
  modToolbar: () => {
    if (typeof _modToolbar !== 'undefined' && _modToolbar) rebuildModToolbarButtons()
  },
  tabPosition: () => {
    applyTabsPosition()
  },
  chatPosition: (v, _def, _onLoad, isRemote) => {
    if (chatHiddenLocal && v && v !== 'hidden') {
      if (isRemote) {
        // Another tab moved chat while THIS tab is \-hidden (tab-local).
        // Adopt the new position as the restore point but stay hidden here.
        chatPositionPrevious = v
        chatPosition = 'hidden'
        applyChatPosition()
        return
      }
      // Explicit position pick in THIS tab (settings dropdown / C rotate)
      // overrides the tab-local hide.
      chatHiddenLocal = false
      _saveChatHiddenLocal()
    }
    applyChatPosition()
    // visible positions become the hide-toggle restore point (mirrors
    // toggleChatHidden's previous-tracking). remote changes update the
    // local var but skip the write-back — the originating tab persisted it
    if (v && v !== 'hidden' && v !== chatPositionPrevious) {
      chatPositionPrevious = v
      if (!isRemote) saveUiSetting('chatPositionPrevious', v)
    }
  },
  notifPermission: (v) => {
    if (!v) return
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {})
    }
  },
  mentionPing: (v) => previewMentionSound(v), // slider: hear the level just set
  mentionSoundPick: (v) => previewMentionSound(undefined, v), // select: hear the sound just chosen
  // the file's name is the setting: emptied (remove, reset to defaults) = the file on this device goes too
  mentionSoundFile: (v) => v || sfxRemove(SFX_MENTION_KEY),
  // content-warning toggles PATCH the server; the local write is already
  // optimistic (setSetting persisted it) — roll back on failure. BG picks
  // up the storage change via onChanged and re-appends include_* params;
  // refresh_all flushes inline emote caches on success.
  // Subsystem pills — live gates apply immediately (their code paths
  // check isEnabled at use time); reload-tagged flips get a toast. Tab
  // affordances of gated subsystems hide/show right away.
  subsystemToggle: () => {
    applyHiddenTabs()
    // persistent [reload] chips (rendered per-row from _gatesAtBoot)
    // replace the old one-shot toast
    if (currentTab === 'settings') renderSettingsTab()
  },
  cwServerPatch: (v, def) => {
    _cwPatch(def, v, false)
    _cwRepaintOwnFlagged()
  },
}

// Own flagged emotes flip visibility instantly on a cw toggle: their rows
// render from viewerPersonalEmotes (cwCats annotation) checked against the
// toggles at render time — invalidate + repaint is all it takes. Cross-user
// stubs heal separately via the sender-set refetch after refresh_all.
function _cwRepaintOwnFlagged() {
  const ownFlagged = []
  if (typeof viewerPersonalEmotes !== 'undefined') {
    for (const [name, e] of viewerPersonalEmotes) {
      if (Array.isArray(e?.cwCats) && e.cwCats.length) ownFlagged.push(name)
    }
  }
  if (!ownFlagged.length || typeof invalidateRenderedForEmotes !== 'function') return
  invalidateRenderedForEmotes(ownFlagged)
  if (!isScrolledUp && typeof renderMessages === 'function' && typeof currentTab !== 'undefined') {
    try {
      renderMessages(currentTab)
    } catch {}
  }
}

// Server PATCH for a content-warning toggle. Enabling an adult category
// (sexual/nsfw) 403s with AGE_REQUIRED until the account has a server-side
// 18+ affirmation — mirror the site flow: confirm dialog → POST
// /api/user/age-verify → retry the PATCH once. Decline rolls the pill back
// without the misleading "try again" toast.
async function _cwPatch(def, v, retried) {
  let resp
  try {
    resp = await safeSendMessage({
      type: 'api_fetch',
      path: '/api/user/settings',
      method: 'PATCH',
      auth: true,
      body: { [def.cw.serverBody]: v },
    })
  } catch (_) {
    resp = null
  }
  if (resp?.ok) {
    safeSendMessage({ type: 'refresh_all' }).catch(() => {})
    return
  }
  if (!retried && v === true && resp?.code === 'AGE_REQUIRED') {
    // an account the server already knows can't verify (under 18, or no birth
    // year) is never asked "are you 18?" — the refusal is the answer
    let blocked = false
    try {
      blocked = (await browser.storage.local.get('hs_age_blocked')).hs_age_blocked === true
    } catch {}
    if (!blocked) {
      const { ok } = await hsConfirm(t('mc_main_age_confirm'), t('mc_main_age_confirm_ok'))
      if (!ok) {
        _cwRollback(def, v, true)
        return
      }
    }
    const av = await safeSendMessage({
      type: 'api_fetch',
      path: '/api/user/age-verify',
      method: 'POST',
      auth: true,
    }).catch(() => null)
    if (av?.ok) {
      _cwPatch(def, v, true)
      return
    }
    // the server checks the birth year on file: an under-18 account (or one
    // with none) is refused, and its own words say which — not "try again"
    if (av?.code === 'AGE_REQUIRED' && av.error) {
      _cwRollback(def, v, true)
      showToast(av.error, 'error')
      return
    }
  }
  _cwRollback(def, v, false)
}

function _cwRollback(def, attempted, declined) {
  setSetting(def.key, !attempted, { silent: true })
  document.querySelectorAll(`.hs-mc-toggle-pill[data-set-key="${def.key}"]`).forEach((pill) => {
    pill.classList.toggle('active', !attempted)
  })
  // silent setSetting skips apply handlers — repaint own flagged rows here
  // or a failed PATCH leaves them rendered under the reverted toggle.
  _cwRepaintOwnFlagged()
  if (!declined) showToast(t('mc_main_cw_save_failed', [def.cw.noun]), 'error')
}

// Resolve the legacy runtime binding for an entry (entries without one
// are served from _settingsCache after hydration).
function _bridgeFor(def) {
  return def.runtimeVar ? _RUNTIME_BRIDGE[def.runtimeVar] : null
}

/**
 * @param {string} key registry storage key
 * @returns {*} current value (cache → runtime bridge → default)
 */
function getSetting(key) {
  const def = _SETTINGS_BY_KEY.get(key)
  if (!def) {
    warn('getSetting: unknown key', key)
    return undefined
  }
  if (key in _settingsCache) return _settingsCache[key]
  const bridge = _bridgeFor(def)
  return bridge ? bridge.get() : def.default
}

// Single write path: coerce + validate, update cache + legacy binding,
// persist through the existing storage routes, run the applier.
// opts.silent skips applier + rerender (storage-change rehydration uses it
// to avoid re-applying a value the local write just set).
/**
 * @param {string} key registry storage key
 * @param {*} value coerced + validated before write
 * @param {{silent?: boolean}} [opts] silent skips appliers + re-renders
 * @returns {boolean} false when the key is unknown or the value invalid
 */
function setSetting(key, value, opts) {
  const def = _SETTINGS_BY_KEY.get(key)
  if (!def) {
    warn('setSetting: unknown key', key)
    return false
  }
  const v = coerceSettingValue(def, value)
  if (v === undefined || !validateSettingValue(def, v)) {
    warn('setSetting: invalid value for', key, value)
    return false
  }
  _settingsCache[key] = v
  const bridge = _bridgeFor(def)
  if (bridge) bridge.set(v)
  if (def.scope === 'local') {
    // Failure must be LOUD: the in-memory cache + UI already flipped, so a
    // silently-dropped write means the setting reverts on next load with
    // zero warning (NSFW filters + mute keywords live on this path).
    browser.storage.local.set({ [key]: v }).catch(() => {
      try {
        showToast(t('mc_main_settings_save_failed'), 'error')
      } catch {}
      warn('setSetting: local write failed for', key)
    })
  } else {
    // sync + local-mirror both route through saveUiSetting — it owns the
    // debounce, UI_SYNC_BLOCKLIST split, quota guard, and ws sync patch
    saveUiSetting(key, v)
  }
  if (!opts?.silent) {
    const applier = def.apply && _APPLIERS[def.apply]
    if (applier) {
      try {
        applier(v, def, false)
      } catch (e) {
        warn('applier failed:', def.apply, e)
      }
    }
    if (def.rerender) {
      // rows render through an insert-only DOM diff — existing rows are
      // never rebuilt without an epoch bump, so a visual toggle would
      // only affect newly arriving messages
      bumpRenderEpoch()
      renderMessages(currentTab)
    }
    // re-render the panel when the entry asks for it OR when another
    // entry's dependsOn watches this key (progressive disclosure)
    if ((def.rerenderSettings || _DEPENDS_PARENTS.has(key)) && currentTab === 'settings') renderSettingsTab()
  }
  return true
}
const _DEPENDS_PARENTS = new Set(SETTINGS.filter((d) => d.dependsOn).map((d) => d.dependsOn.key))

// ─── subsystem gates ────────────────────────────────────────────────────
// isEnabled(id): live read — server health kill-list wins, then the
// user's ui_settings.subsystems map (default ON). Live-tagged code paths
// (mentions, stream-stats) call this at use time.
// gateAtBoot(id): the init()-time snapshot — every init guard reads this
// so a mid-init storage write can't half-apply a subsystem.
let _gatesAtBoot = null
function isEnabled(id) {
  try {
    if (window.__hsHealth?.disabled?.includes(id)) return false
  } catch (_) {}
  if (SUBSYSTEMS_ALWAYS_ON.includes(id)) return true
  return getSetting('subsystems')[id] !== false
}
// Taken BEFORE the first consumer, which is loadConfig() — it subscribes a
// youtube stream for every saved channel, and an unsnapshotted gateAtBoot
// silently answered "enabled", so `chat-youtube: false` still opened them.
// A gate that defaults to ON when asked too early is not a gate.
//
// Reads the already-in-flight ui_settings prime directly rather than
// getSetting(): the settings registry is not hydrated this early and would
// hand back the all-true schema default — the same silent yes by another
// route. Merged OVER that default so an unknown/absent key still resolves.
// The per-site "hs off" (settings › subsystems › hs chat on <site>). Off means heatsync does not mount
// here at all and the page keeps its own chat — decided once, at boot, before anything paints.
function overlayEnabledHere(gates) {
  const gate = { twitch: 'overlay-twitch', kick: 'overlay-kick', yt: 'overlay-youtube' }[hostPlatform]
  return !gate || gates?.[gate] !== false
}
async function snapshotGates() {
  let stored = null
  try {
    stored = (await cachedUiSettings())?.ui_settings?.subsystems || null
  } catch (_) {}
  // Only the per-site overlay switches are the user's; anything else an older
  // panel stored (feed: false, plumbing ids, ...) is always on now.
  _gatesAtBoot = userSubsystemGates(stored)
  // Mirror to localStorage — pcard-early.js runs at document_start, before
  // this async snapshot resolves, and needs a synchronously-readable copy
  // to decide whether to swallow the native user-card click at all (a
  // reload-gated setting, so a page-stale value here is the same lag the
  // setting itself already has).
  try {
    localStorage.setItem('hs_gate_profile-cards', _gatesAtBoot['profile-cards'] !== false ? '1' : '0')
    // Same mirror for the per-site "hs off": early-layout.js must not prepaint the overlay's bar, and
    // pcard-early.js must leave the page's own user card alone, on a site where heatsync is off.
    // (pcard-early's own gate is the profile-cards one above, so off here switches that off too.)
    const overlayOn = overlayEnabledHere(_gatesAtBoot)
    localStorage.setItem('hs_gate_overlay', overlayOn ? '1' : '0')
    if (!overlayOn) localStorage.setItem('hs_gate_profile-cards', '0')
  } catch (_) {}
  // A `false` left in storage would still switch a feature off for content.js
  // and the background, which read their gates from there — keep only the switches.
  if (stored && Object.keys(stored).some((k) => !(k in _gatesAtBoot))) saveUiSetting('subsystems', _gatesAtBoot)
}
function gateAtBoot(id) {
  try {
    if (window.__hsHealth?.disabled?.includes(id)) return false
  } catch (_) {}
  // Snapshot missing means someone moved a consumer above snapshotGates().
  // Defer to the live read rather than inventing a yes.
  if (_gatesAtBoot == null) return isEnabled(id)
  if (SUBSYSTEMS_ALWAYS_ON.includes(id)) return true
  return _gatesAtBoot[id] !== false
}

// One hydration pass over the whole registry — replaces the per-setting
// loadXSetting() functions. Reads the shared init caches, fills
// cache + bridge, runs one-shot migrations, then runs each distinct
// applier once (onLoad=true).
async function loadAllSettings() {
  const localKeys = SETTINGS.filter((d) => d.scope === 'local').map((d) => d.key)
  const [synced, local, overflow] = await Promise.all([
    cachedUiSettings().catch(() => ({})),
    localKeys.length ? browser.storage.local.get(localKeys).catch(() => ({})) : {},
    cachedUiOverflow().catch(() => ({})),
  ])
  const ui = synced?.ui_settings || {}
  // applier id → def; dedupes shared ids (the three font keys all map to
  // 'fonts'). Only applyOnLoad entries run here — set-time-only effects
  // (rebuildInput, notification permission, ping preview) never fire on init.
  const appliersToRun = new Map()
  const firstRunLocal = {}

  for (const def of SETTINGS) {
    // one-shot default-flip migration (e.g. wysiwyg false→true retirement):
    // until the guard key is stamped, force the new default and persist both
    if (def.migrate && !ui[def.migrate]) {
      _settingsCache[def.key] = def.default
      const b = _bridgeFor(def)
      if (b) b.set(def.default)
      saveUiSetting(def.key, def.default)
      saveUiSetting(def.migrate, true)
      if (def.apply && def.applyOnLoad) appliersToRun.set(def.apply, def)
      continue
    }

    let raw
    if (def.scope === 'sync') raw = ui[def.key]
    else if (def.scope === 'local') raw = local[def.key]
    else raw = overflow[def.mirrorKey]

    // local-mirror one-shot migration: legacy installs still hold the
    // value in sync — adopt it and persist to the local overflow bucket
    if (raw === undefined && def.legacySyncFallback && ui[def.key] !== undefined) {
      raw = ui[def.key]
      if (validateSettingValue(def, coerceSettingValue(def, raw))) {
        browser.storage.local.set({ [def.mirrorKey]: coerceSettingValue(def, raw) }).catch(() => {})
      }
    }
    // retired-key migration (e.g. bigEmoji false → emoji size 1x)
    let legacyAdopted = false
    if (raw === undefined && def.legacy) {
      try {
        raw = def.legacy(ui, local)
      } catch (_) {}
      legacyAdopted = raw !== undefined
    }
    // first run for self-announcing local keys: persist the default so
    // other surfaces (options page) render the real state
    if (raw === undefined && def.firstRunPersist) firstRunLocal[def.key] = def.default

    const v = raw === undefined ? def.default : coerceSettingValue(def, raw)
    const value = v !== undefined && validateSettingValue(def, v) ? v : def.default
    // Persist the adopted legacy value — without this only this surface sees
    // the migration (in-memory), while every other reader of the real key
    // still gets the default (bigEmoji false → overlay 1x but native 2x).
    // One-shot: the write makes raw defined next boot, so legacy never re-fires.
    if (legacyAdopted) {
      if (def.scope === 'local') browser.storage.local.set({ [def.key]: value }).catch(() => {})
      else saveUiSetting(def.key, value)
    }
    _settingsCache[def.key] = value
    const bridge = _bridgeFor(def)
    if (bridge) bridge.set(value)
    if (def.apply && def.applyOnLoad) appliersToRun.set(def.apply, def)
  }

  if (Object.keys(firstRunLocal).length) {
    browser.storage.local.set(firstRunLocal).catch(() => {})
  }
  // one-shot: the retired F-/F+ buttons stored a per-device size override in
  // localStorage that quietly beat the fontSize setting. Fold the user's last
  // size into fontSize (the slider now owns it), then drop the legacy key so
  // this runs only once. Done before appliers so the fonts applier paints it.
  try {
    const ov = parseInt(localStorage.getItem('heatsync-chat-font-size'), 10)
    if (ov >= 10 && ov <= 22) {
      if (ov !== _settingsCache.fontSize) {
        _settingsCache.fontSize = ov
        saveUiSetting('fontSize', ov)
      }
      localStorage.removeItem('heatsync-chat-font-size')
    }
  } catch (_) {}
  // boot snapshot for reload-applied entries — drives the [reload] chip
  for (const def of SETTINGS) {
    if (def.reloadApply) _bootVals[def.key] = getSetting(def.key)
  }
  for (const [id, def] of appliersToRun) {
    const applier = _APPLIERS[id]
    if (applier) {
      try {
        applier(getSetting(def.key), def, true)
      } catch (e) {
        warn('load applier failed:', id, e)
      }
    }
  }

  _settingsHydrated = true
}

// The settings pass retired keys (RETIRED_UI_KEYS). Runs after the boot seed
// — the server's ui_state is written over local storage there, so anything
// migrated before it could be overwritten. A retired key's value was adopted
// at hydration (schema `legacy`); here the stored blob lets go of it. Skipped
// when hydration timed out: the values stay put for the next boot.
async function retireSettings() {
  if (!_settingsHydrated) return
  try {
    const [synced, local] = await Promise.all([
      browser.storage.sync.get('ui_settings'),
      browser.storage.local.get([...LEGACY_LOCAL_KEYS, 'chat_filter_rules']),
    ])
    const ui = synced?.ui_settings || {}
    // The four old text filters become chat filter rules (filter-rules-legacy.js).
    // The rules are written before the old values go, so a closed tab loses nothing.
    const json = foldLegacyFilters(ui, local)
    // unreadable rules: keep every old value and leave the rules alone
    if (json === false) return
    if (json) {
      await browser.storage.local.set({ chat_filter_rules: json })
      setSetting('chatFilterRules', json)
    }
    await browser.storage.local.remove(LEGACY_LOCAL_KEYS)
    if (!Object.keys(ui).some((k) => RETIRED_UI_KEYS.has(k))) return
    await safeSendMessage({ type: 'ui_settings_rmw', patch: {}, dropRetired: true })
    invalidateUiSettingsCache()
  } catch (e) {
    warn('retiring old settings failed:', e?.message)
  }
}

// Registry-derived reset — every entry returns to its default through the
// normal setSetting path (storage write + bridge + applier). noReset
// entries (server-coupled content-warning prefs) are left untouched.
// Sync writes coalesce into one debounced ui_settings patch.
// Optional `cat` scopes the reset to one settings page (per-page default
// button); no arg = everything (system page's all-settings button).
function resetSettingsToDefaults(cat) {
  for (const def of SETTINGS) {
    if (def.noReset) continue
    if (cat && def.category !== cat) continue
    setSetting(def.key, def.default)
  }
  renderSettingsTab()
}

// Generic control dispatch — resolves a clicked/changed element to its
// registry entry via data-set-key. Returns true when handled.
function handleRegistryControl(el, rawValue) {
  const ds = el.dataset
  const def = ds.setKey && _SETTINGS_BY_KEY.get(ds.setKey)
  if (!def) return false
  // boolmap subkey pill — flip one subkey, persist the whole map
  if (def.type === 'boolmap' && ds.setSub !== undefined) {
    const map = Object.assign({}, getSetting(def.key))
    map[ds.setSub] = !map[ds.setSub]
    if (setSetting(def.key, map)) {
      el.classList.toggle('active', map[ds.setSub])
      _syncRowModEdge(
        el,
        def,
        def.options.find((o) => String(o.value) === ds.setSub),
      )
    }
    return true
  }
  // multiselect member pill — toggle membership (invertDisplay = stored
  // set is "hidden" but pills show "visible")
  if (def.type === 'multiselect' && ds.setValue !== undefined) {
    const cur = getSetting(def.key)
    const val = ds.setValue
    const next = cur.includes(val) ? cur.filter((x) => x !== val) : cur.concat(val)
    if (setSetting(def.key, next)) {
      const member = next.includes(val)
      el.classList.toggle('active', def.invertDisplay ? !member : member)
      _syncRowModEdge(
        el,
        def,
        def.options.find((o) => String(o.value) === val),
      )
    }
    return true
  }
  // segmented enum button — value carried on the button
  if (def.type === 'enum' && ds.setValue !== undefined) {
    if (setSetting(def.key, ds.setValue)) {
      const row = el.closest('.hs-mc-setting-row')
      if (row) {
        const cur2 = String(getSetting(def.key))
        row.querySelectorAll('[data-set-value]').forEach((b) => {
          b.classList.toggle('active', b.dataset.setValue === cur2)
        })
      }
      _syncRowModEdge(el, def)
    }
    return true
  }
  if (def.type === 'bool') {
    const next = !getSetting(def.key)
    if (setSetting(def.key, next)) {
      el.classList.toggle('active', next)
      _syncRowModEdge(el, def)
    }
    return true
  }
  if (setSetting(def.key, rawValue !== undefined ? rawValue : el.value)) {
    _syncRowModEdge(el, def)
    return true
  }
  return false
}

// Stream events persistence — survives tab switches AND page refresh
const STREAM_EVENTS_KEY = 'hs_stream_events'
const STREAM_EVENTS_MAX = 200
// 7TV emote add/remove notices are the channel's own history, not a go-live
// ping: they stay at their timestamp for a week and survive every reload.
const EMOTE_EVENT_TTL_MS = 7 * 86400000
const EMOTE_EVENT_DUP_MS = 60000
let streamEventsLoaded = false
const isEmoteEvent = (e) => !!e?.eventClass?.includes('event-emote')
// A non-twitch event keeps its platform on the row (twitch rows carry none, see
// isPlatformHiddenInTab): the row's link, hover card and badge all key off it.
const eventPlatformField = (p) => {
  const plat = streamEventPlatform(p)
  return plat === 'twitch' ? {} : { platform: plat }
}
// Same notice twice: identical text AND (for emote notices) within a minute.
// Text alone made a second removal of the same emote, days later, vanish.
const sameStreamEvent = (a, b) =>
  a.text === b.text && (!isEmoteEvent(a) || Math.abs((a.time || 0) - (b.time || 0)) < EMOTE_EVENT_DUP_MS)
// Over the cap, shed the oldest ordinary events first so a burst of go-live
// pings can't push emote notices out of storage.
function pruneStreamEvents(events) {
  let over = events.length - STREAM_EVENTS_MAX
  if (over <= 0) return events
  const out = []
  for (const e of events) {
    if (over > 0 && !isEmoteEvent(e)) over--
    else out.push(e)
  }
  return over > 0 ? out.slice(over) : out
}

// Inject stream events into IRC buffers + activityEvents (deduped)
// recentOnly: only inject events <15min old into chat buffers (on reload)
function injectStreamEventsIntoBuffers(events, recentOnly = false) {
  const liveCh = getLiveChannel()
  const liveBuffer = liveCh ? irc?.channels?.get(liveCh) : null
  const chatCutoff = recentOnly ? Date.now() - REPLAY_WINDOW_MS : 0
  let added = 0

  for (const evt of events) {
    const ch = evt.channel
    if (!ch) continue

    // On replay (overlay load / reconnect) drop "went live" events. They are,
    // by definition, channels that were ALREADY live when you opened — a wall
    // of online dumps (plus stale dupes when a channel switched games while
    // you were away). Genuine go-lives that happen DURING the session still
    // surface via the realtime stream_event / follow_stream_event listeners,
    // which don't go through this replay path. offline + game-switch replay
    // fine (low volume, useful context).
    if (recentOnly && evt.eventClass?.includes('event-online')) continue

    const injectToChat = !recentOnly || isEmoteEvent(evt) || (evt.time && evt.time > chatCutoff)
    const isFollowEvent = evt.eventClass?.includes('event-follow')

    // Inject into the channel's own buffer
    if (injectToChat) {
      const buffer = irc?.channels?.get(ch)
      if (buffer) {
        const existing = buffer.getAll()
        const isDupe = existing.some((m) => m.type === 'stream-event' && sameStreamEvent(m, evt))
        if (!isDupe) {
          // insertOrdered, not push: unlike the realtime stream-event
          // dispatchers (which always stamp time: Date.now()), evt.time
          // here is the event's REAL historical time (persisted storage /
          // reload replay) — it can legitimately be older than whatever
          // live messages already reached this buffer before boot restore
          // finished, so a blind push would break buffer sortedness.
          buffer.insertOrdered(evt)
          added++
        }
      }
    }

    // Follow events (went live, switched game) go into live buffer for all followed channels
    // Channel-specific events (redeems, raids, hype) only go to live buffer if channel matches
    if (injectToChat && liveBuffer) {
      const liveBufferMatch = isFollowEvent || ch === liveCh
      if (liveBufferMatch) {
        const chBuffer = irc?.channels?.get(ch)
        if (liveBuffer !== chBuffer) {
          const existing = liveBuffer.getAll()
          const isDupe = existing.some((m) => m.type === 'stream-event' && sameStreamEvent(m, evt))
          if (!isDupe) {
            liveBuffer.insertOrdered(evt)
            added++
          }
        }
      }
    }

    // Always push to activityEvents regardless of age
    pushActivityEvent(evt)
  }
  return added
}

async function loadStreamEvents() {
  try {
    const data = await api.storage.local.get(STREAM_EVENTS_KEY)
    const events = data[STREAM_EVENTS_KEY]
    if (!Array.isArray(events) || events.length === 0) return
    const now = Date.now()
    // Dedup (multi-tab race can create duplicate entries in storage)
    const valid = []
    for (const e of events) {
      if (e.time <= now - (isEmoteEvent(e) ? EMOTE_EVENT_TTL_MS : 86400000)) continue
      if (e.text && valid.some((v) => sameStreamEvent(v, e))) continue
      valid.push(e)
    }

    injectStreamEventsIntoBuffers(valid, true)

    // Seed dedup map so realtime handlers don't re-add loaded events.
    // Seed with the event's ORIGINAL time, not Date.now(): the 60s dedup
    // window is for echo-suppression of fresh broadcasts. Seeding with
    // `now` makes every loaded event look just-arrived and blocks legit
    // new same-text events for 60s after every reload.
    if (!window._hsStreamEventDedup) window._hsStreamEventDedup = new Map()
    for (const e of valid) {
      if (e.text && e.time) window._hsStreamEventDedup.set(e.text, e.time)
    }

    // Prune expired + deduped from storage
    if (valid.length < events.length) {
      await api.storage.local.set({ [STREAM_EVENTS_KEY]: valid })
    }
    streamEventsLoaded = true
  } catch {}
}

// Queued storage writer — prevents concurrent read-modify-write races
let saveQueue = Promise.resolve()

// ── went live, at the stream's start ──────────────────────────────────────
// A channel already live when its chat history loads has no realtime "went
// live" row (the ws holds back its first 90s, and a go-live before we ran never
// came). Twitch's public web gql (the /status query) says since when; the row
// goes in at that time, only if the loaded history reaches back that far. Gated
// on the online toggle; no notification, no tab highlight; its id is stable per
// stream, so a second answer or a history re-pull never doubles it. The row
// takes the same colour and paint chain as any stream line (userId = the
// channel's own twitch id, chatColor seeds the profile-lookup colour).
const wentLiveAsk = new Map() // login -> { at, p }
const WENT_LIVE_ASK_TTL = 5 * 60 * 1000
function askStreamStart(ch) {
  const hit = wentLiveAsk.get(ch)
  if (hit && Date.now() - hit.at < WENT_LIVE_ASK_TTL) return hit.p
  const p = twitchGql(`{ user(login:"${ch}") { id chatColor stream { type createdAt game { name } } } }`)
    .then((r) => {
      const u = r?.data?.user
      const st = u?.stream
      if (!st || st.type !== 'live') return null
      const start = Date.parse(st.createdAt)
      if (!Number.isFinite(start)) return null
      if (u.chatColor && typeof _hsUserColorCache !== 'undefined' && !_hsUserColorCache.get(ch)) {
        _hsUserColorCache.set(ch, String(u.chatColor))
      }
      return { start, game: st.game?.name || '', userId: u.id }
    })
    .catch(() => null)
  wentLiveAsk.set(ch, { at: Date.now(), p })
  if (wentLiveAsk.size > 100) wentLiveAsk.delete(wentLiveAsk.keys().next().value)
  return p
}

async function historyWentLive(channel) {
  const ch = String(channel || '').toLowerCase()
  if (!hermesToggles?.online || !/^[a-z0-9_]{2,40}$/.test(ch)) return
  const info = await askStreamStart(ch)
  if (!info) return
  const buf = irc?.channels?.get(ch)
  if (!buf) return
  const all = buf.getAll()
  const oldest = all.find((m) => m.type !== 'stream-event')?.time
  const evt = historyWentLiveEvent(ch, info, oldest)
  if (!evt) return
  // already there: this row, or the realtime one for the same go-live
  const dupe = all.some(
    (m) =>
      m.type === 'stream-event' &&
      (m.id === evt.id ||
        (m.eventClass?.includes('event-online') && m.channel === ch && (m.time || 0) >= evt.time - 120000)),
  )
  if (dupe) return
  buf.insertOrdered(evt)
  try {
    _dropAllTabCaches()
  } catch {}
  if (currentTab === ch || (currentTab === 'live' && getLiveChannel() === ch)) scheduleRenderMessages()
}

async function saveStreamEvent(evt) {
  saveQueue = saveQueue.then(async () => {
    try {
      const data = await api.storage.local.get(STREAM_EVENTS_KEY)
      const events = data[STREAM_EVENTS_KEY] || []
      // Dedup by text before saving
      if (!events.some((e) => sameStreamEvent(e, evt))) {
        events.push(evt)
      }
      await api.storage.local.set({ [STREAM_EVENTS_KEY]: pruneStreamEvents(events) })
    } catch {}
  })
  return saveQueue
}

async function saveStreamEventsBatch(evts) {
  saveQueue = saveQueue.then(async () => {
    try {
      const data = await api.storage.local.get(STREAM_EVENTS_KEY)
      const events = data[STREAM_EVENTS_KEY] || []
      const existingTexts = new Set(events.map((e) => e.text))
      for (const evt of evts) {
        if (!existingTexts.has(evt.text)) {
          events.push(evt)
          existingTexts.add(evt.text)
        }
      }
      if (events.length > STREAM_EVENTS_MAX) events.splice(0, events.length - STREAM_EVENTS_MAX)
      await api.storage.local.set({ [STREAM_EVENTS_KEY]: events })
    } catch {}
  })
  return saveQueue
}

// Inline [OP]/[RE] rows persistence — a feed post surfaced in chat stays at
// its timestamp across an ext reload, like stream events do. Only feed-post
// rows: the other inline kinds are receipts for things you just did.
const INLINE_NOTIF_KEY = 'hs_inline_notifs_v1'
const INLINE_NOTIF_MAX = 200
const INLINE_NOTIF_TTL_MS = 7 * 86400000
const _inlineNotifPick = (m) => ({
  type: 'feed-post',
  base36_id: m.base36_id,
  feedUser: m.feedUser,
  text: m.text,
  color: m.color,
  time: m.time,
  heat: m.heat,
  reply_to: m.reply_to,
  emote_refs: m.emote_refs,
  is_op: m.is_op,
  is_thread_op: m.is_thread_op,
  mediaTag: m.mediaTag,
  mediaSrc: m.mediaSrc,
  mediaCats: m.mediaCats,
})

function saveInlineNotif(notifType, msg) {
  if (!msg?.base36_id || !msg.time) return
  saveQueue = saveQueue.then(async () => {
    try {
      const data = await api.storage.local.get(INLINE_NOTIF_KEY)
      const rows = Array.isArray(data[INLINE_NOTIF_KEY]) ? data[INLINE_NOTIF_KEY] : []
      if (rows.some((r) => r.msg?.base36_id === msg.base36_id && r.notifType === notifType)) return
      rows.push({ notifType, msg: _inlineNotifPick(msg) })
      if (rows.length > INLINE_NOTIF_MAX) rows.splice(0, rows.length - INLINE_NOTIF_MAX)
      await api.storage.local.set({ [INLINE_NOTIF_KEY]: rows })
    } catch {}
  })
  return saveQueue
}

// Put saved rows back into every channel buffer at their real time. Idempotent
// (skips ids a buffer already holds), so it can run again once slower
// buffers have joined. Returns how many rows were added.
async function restoreInlineNotifs() {
  try {
    const data = await api.storage.local.get(INLINE_NOTIF_KEY)
    const rows = data[INLINE_NOTIF_KEY]
    if (!Array.isArray(rows) || rows.length === 0) return 0
    const cutoff = Date.now() - INLINE_NOTIF_TTL_MS
    const fresh = rows.filter((r) => r?.msg?.time > cutoff && INLINE_NOTIF_TYPES[r.notifType])
    if (fresh.length < rows.length) await api.storage.local.set({ [INLINE_NOTIF_KEY]: fresh })
    const live = fresh.filter((r) => inlineNotifs[r.notifType])
    let added = 0
    for (const ch of config.channels) {
      const buffer = (ch?.twitch && irc?.channels?.get(ch.twitch)) || (ch.kick && kickChat?.channels?.get(ch.kick))
      const ytBuf = ch?.id && channelYtMessages.get(ch.id)
      const seenIn = (list) => new Set(list.filter((m) => m.type === 'feed-post').map((m) => m.base36_id))
      const bufSeen = buffer ? seenIn(buffer.getAll()) : null
      const ytSeen = ytBuf ? seenIn(ytBuf) : null
      for (const r of live) {
        const typeDef = INLINE_NOTIF_TYPES[r.notifType]
        const m = {
          ...r.msg,
          inlineNotifType: r.notifType,
          inlineNotifColor: typeDef.color,
          inlineNotifBorderColor: typeDef.borderColor,
          inlineNotifLabel: typeDef.tag,
        }
        if (bufSeen && !bufSeen.has(m.base36_id)) {
          buffer.insertOrdered(m)
          bufSeen.add(m.base36_id)
          added++
        }
        if (ytSeen && !ytSeen.has(m.base36_id)) {
          const i = ytBuf.findIndex((x) => (x.time || 0) > m.time)
          if (i === -1) ytBuf.push(m)
          else ytBuf.splice(i, 0, m)
          ytSeen.add(m.base36_id)
          added++
        }
      }
    }
    return added
  } catch {
    return 0
  }
}

// Dedup: track recent server-sourced YouTube messages to skip content-script duplicates

// Normalize YouTube URL — accepts full URLs or bare username
const normalizeYtUrl = (raw) => {
  // Bare UC channel id → /channel/<id>/live (mirrors identityYtLiveUrl)
  if (/^UC[\w-]{20,}$/.test(raw)) return `https://www.youtube.com/channel/${raw}/live`
  // Bare username (no slashes; handles allow . _ -) → /@name/live
  if (/^@?[\w.-]{3,30}$/.test(raw)) {
    const name = raw.startsWith('@') ? raw.slice(1) : raw
    return `https://www.youtube.com/@${name}/live`
  }
  try {
    const u = new URL(raw)
    const v = u.searchParams.get('v')
    if (v) return `https://www.youtube.com/watch?v=${v}`
    const liveMatch = raw.match(/\/live\/([^?&/]+)/)
    if (liveMatch) return `https://www.youtube.com/live/${liveMatch[1]}`
    const shortMatch = raw.match(/youtu\.be\/([^?&]+)/)
    if (shortMatch) return `https://www.youtube.com/watch?v=${shortMatch[1]}`
  } catch {}
  return raw
}
