/**
 * Heatsync Chat Button - FFZ-style button injection
 *
 * Injects a Heatsync button next to Twitch's emote picker button.
 * Opens panel for: importing channel emotes, quick picker, settings.
 *
 * Reference: FrankerFaceZ/src/sites/twitch-twilight/modules/chat/input.jsx
 */
(function() {
  'use strict';

  const DEBUG = false;
  const log = DEBUG ? console.log.bind(console, '[heatsync-btn]') : () => {};

  // mirrors src/lib/utils.js escapeHtml — kept local because this file may load
  // before lib bundling completes; the two must remain identical
  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c])
  }

  // Wait for shared-utils.js to expose window.HS before starting
  function waitForHS(cb, attempts = 0) {
    if (window.HS) return cb()
    if (attempts >= 50) return // give up after 5s
    setTimeout(() => waitForHS(cb, attempts + 1), 100)
  }

  waitForHS(() => {
  // Kill previous instance on extension reload
  if (window.__heatsyncBtnLifecycle) {
    try { window.__heatsyncBtnLifecycle.abort() } catch (_) {}
  }

  // Lifecycle controller — delegates to shared window.HS.createLifecycle
  const { signal: btnSignal, cleanup, abort: _abortLifecycle } = window.HS.createLifecycle()
  window.__heatsyncBtnLifecycle = { abort: _abortLifecycle }

  const BUTTON_ID = 'heatsync-chat-button';
  const PANEL_ID = 'heatsync-panel';
  const API_URL = 'https://heatsync.org';

  // bidi direction for the user's locale — resolved per-mount so manual locale override applies
  function HS_BTN_DIR() {
    try { return (typeof bidiDir === 'function' ? bidiDir() : (chrome?.i18n?.getMessage?.('@@bidi_dir'))) || 'ltr' } catch { return 'ltr' }
  }

  let buttonInjected = false;
  let panelOpen = false;
  let currentChannel = null;
  let channelEmotesCache = [];
  let cachedAuthToken = null;
  let inventoryEmotesCache = [];
  let _inventoryNames = new Set()
  let _inventoryHashes = new Set()
  let _inventoryIds = new Set()
  function rebuildInventoryIndex() {
    _inventoryNames = new Set(inventoryEmotesCache.map(e => e.name))
    _inventoryHashes = new Set(inventoryEmotesCache.filter(e => e.hash).map(e => e.hash))
    _inventoryIds = new Set(inventoryEmotesCache.filter(e => e.id).map(e => e.id))
  }
  let globalEmotesCache = [];
  let currentTab = 'channel';
  let searchQuery = '';
  let emotesPreloaded = false;
  let preloadingInProgress = false;
  let recentEmotes = []; // LRU list of recently-used emote names
  const RECENT_MAX = 20;
  let focusedEmoteIndex = -1; // keyboard nav tracking

  // Virtual scroll state
  let _virtualPickerEmotes = [] // current filtered emote list for virtual scroll
  let _virtualRecentCount = 0 // number of recent emotes rendered (non-virtualized)
  let _virtualScrollHandler = null // scroll listener reference
  let _virtualGridDelegated = false // whether event delegation is set up

  // Load recent emotes from storage
  chrome.storage.local.get('recent_emotes', (r) => {
    if (r.recent_emotes) recentEmotes = r.recent_emotes
  })

  function recordRecentEmote(emote) {
    const key = emote.isEmoji ? `:${emote.name}:` : emote.name
    recentEmotes = recentEmotes.filter(r => r.key !== key)
    recentEmotes.unshift({ key, name: emote.name, url: emote.url, emoji: emote.emoji, isEmoji: emote.isEmoji, provider: emote.provider, hash: emote.hash })
    if (recentEmotes.length > RECENT_MAX) recentEmotes.length = RECENT_MAX
    chrome.storage.local.set({ recent_emotes: recentEmotes })
  }

  // Fuzzy match scorer: sequential character match
  function fuzzyScore(query, name) {
    const lower = name.toLowerCase()
    if (lower.includes(query)) return 2 + (query.length / lower.length) // exact substring bonus
    let qi = 0
    for (let i = 0; i < lower.length && qi < query.length; i++) {
      if (lower[i] === query[qi]) qi++
    }
    if (qi < query.length) return 0 // not all chars matched
    return qi / lower.length // partial sequential match
  }

  // Error and loading state tracking
  // Keys MUST match currentTab values ('channel', 'global', 'mine', 'sets') so renderEmoteGrid()
  // can read state via loadErrors[currentTab].
  let loadErrors = {
    channel: null,
    global: null,
    mine: null,
    sets: null,
    history: null,
    discover: null
  };
  let isLoading = {
    channel: false,
    global: false,
    mine: false,
    sets: false,
    history: false,
    discover: false
  };
  let isOffline = false;
  let usingCachedData = {
    channel: false,
    global: false,
    mine: false,
    sets: false,
    history: false,
    discover: false
  };

  // Removed emotes history — lazy-loaded on first 'history' tab open
  let removedEmotesCache = []
  let historyLoaded = false

  // Saved emote sets — list of { id, name, emote_count, starred, source_type, source_username }
  // Loaded lazy on first 'sets' tab open via api_fetch through background.
  let savedSetsCache = []
  let setsLoaded = false

  // Share-set link — populated by the "share set" context-menu action.
  let discoverShareUrl = null

  // Direct provider API search. Each enabled chip fires its own API in parallel
  // (7TV GQL, BTTV REST, FFZ REST). Results are normalized to a uniform shape
  // and sorted by each provider's native popularity metric. AbortController
  // cancels stale in-flight requests when the query changes.
  const PROVIDER_NAMES = ['7tv', 'bttv', 'ffz']
  let providerResults = { '7tv': [], 'bttv': [], 'ffz': [] }
  let providerLastQuery = { '7tv': '', 'bttv': '', 'ffz': '' }
  let providerInFlight = { '7tv': false, 'bttv': false, 'ffz': false }
  let providerErrors = { '7tv': null, 'bttv': null, 'ffz': null }
  let _providerAborts = { '7tv': null, 'bttv': null, 'ffz': null }

  // Heatsync indexed search — supplements provider APIs with SQL substring
  // matches (ILIKE %q%). 7TV's API is prefix-ranked, so a query like "WTFF"
  // never returns "KEKWTFF" upstream. Heatsync's index catches those because
  // any popular substring emote will already be in the deduped DB from prior
  // imports. Provider chip determines which heatsync results contribute.
  let hsIndexResults = []
  let hsIndexQuery = ''
  let hsIndexInFlight = false
  let _hsIndexSeq = 0

  // Provider filter chips. Hidden until the user focuses the search input.
  // Local matches (channel + global + mine) are ALWAYS included — only the
  // provider toggles are user-controllable. Default: all three providers on.
  let pickerSources = (() => {
    try {
      const raw = localStorage.getItem('hs-picker-sources')
      if (raw) {
        const arr = JSON.parse(raw)
        if (Array.isArray(arr) && arr.length) {
          // Migrate old 'here' entries — local matches are now implicit.
          return new Set(arr.filter(s => s !== 'here'))
        }
      }
    } catch (_) {}
    return new Set(['7tv', 'bttv', 'ffz'])
  })()
  function saveSources() {
    try { localStorage.setItem('hs-picker-sources', JSON.stringify([...pickerSources])) } catch (_) {}
  }
  function hasExternalSource() {
    return pickerSources.has('7tv') || pickerSources.has('bttv') || pickerSources.has('ffz')
  }

  // IndexedDB cache for emote metadata
  const DB_NAME = 'heatsync-emote-cache';
  const DB_VERSION = 2; // Bumped to clear old cache
  const CACHE_TTL = 1000 * 60 * 30; // 30 minutes
  let dbInstance = null;

  async function openDB() {
    if (dbInstance) return dbInstance;
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        dbInstance = request.result;
        resolve(dbInstance);
      };
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        // Clear old store on upgrade
        if (db.objectStoreNames.contains('emotes')) {
          db.deleteObjectStore('emotes');
        }
        db.createObjectStore('emotes', { keyPath: 'key' });
      };
    });
  }

  async function getCachedEmotes(key) {
    try {
      const db = await openDB();
      return new Promise((resolve) => {
        const tx = db.transaction('emotes', 'readonly');
        const store = tx.objectStore('emotes');
        const request = store.get(key);
        request.onsuccess = () => {
          const result = request.result;
          if (result && Date.now() - result.timestamp < CACHE_TTL) {
            resolve(result.data);
          } else {
            resolve(null);
          }
        };
        request.onerror = () => resolve(null);
      });
    } catch {
      return null;
    }
  }

  async function setCachedEmotes(key, data) {
    try {
      const db = await openDB();
      return new Promise((resolve) => {
        const tx = db.transaction('emotes', 'readwrite');
        const store = tx.objectStore('emotes');
        store.put({ key, data, timestamp: Date.now() });
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      });
    } catch {
      return false;
    }
  }

  // Prune expired IndexedDB entries (prevents unbounded storage growth)
  async function pruneExpiredCache() {
    try {
      const db = await openDB()
      const tx = db.transaction('emotes', 'readwrite')
      const store = tx.objectStore('emotes')
      const request = store.openCursor()
      const now = Date.now()
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor) return
        if (now - cursor.value.timestamp > CACHE_TTL) {
          cursor.delete()
        }
        cursor.continue()
      }
    } catch {}
  }
  // Prune on load and every 5 minutes
  pruneExpiredCache()
  cleanup.setInterval(pruneExpiredCache, 300000)

  // Logged-in probe — read chrome.storage directly (this script is
  // ISOLATED world). The value only ever gates UI ("log in to add
  // emotes"); real API calls go through HS.apiFetch auth:true, where the
  // background attaches the token. Never lands in page-readable DOM.
  function getAuthToken() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(['auth_token', 'auth_token_encrypted'], (d) => {
          cachedAuthToken = d?.auth_token || (d?.auth_token_encrypted ? 'encrypted' : null) || null
          resolve(cachedAuthToken)
        })
      } catch {
        resolve(cachedAuthToken)
      }
    })
  }
  // Keep the cached logged-in state fresh across login/logout
  try {
    const _onAuthChange = (ch, area) => {
      if (area === 'local' && (ch.auth_token || ch.auth_token_encrypted)) getAuthToken()
    }
    chrome.storage.onChanged.addListener(_onAuthChange)
    btnSignal?.addEventListener('abort', () => chrome.storage.onChanged.removeListener(_onAuthChange), { once: true })
  } catch {}

  // Get extension icon URL (works in content script context)
  const getIconUrl = () => {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
        return chrome.runtime.getURL('icon-48.png');
      }
      if (typeof browser !== 'undefined' && browser.runtime?.getURL) {
        return browser.runtime.getURL('icon-48.png');
      }
    } catch (_) {}
    return null;
  };

  // Detect current channel from URL
  function detectChannel() {
    const path = window.location.pathname;
    const platform = window.heatsyncPlatform?.detectPlatform() || 'unknown';

    if (platform === 'kick') {
      // Handle popout/embed: /popout/channel/chat or /embed/channel/chat
      const popoutMatch = path.match(/^\/(popout|embed)\/([a-zA-Z0-9_-]+)/);
      if (popoutMatch) return popoutMatch[2].toLowerCase();
      // Kick channel pages: /channelname or /channelname/chatroom
      const match = path.match(/^\/([a-zA-Z0-9_-]+)/);
      if (match && !['categories', 'following', 'settings', 'browse', 'search', 'dashboard', 'popout', 'embed'].includes(match[1])) {
        return match[1].toLowerCase();
      }
      return null;
    }

    // Twitch
    // Handle popout chat: /popout/{channel}/chat
    const popoutMatch = path.match(/^\/popout\/([a-zA-Z0-9_]+)/);
    if (popoutMatch) {
      return popoutMatch[1].toLowerCase();
    }

    // Handle embed: /embed/{channel}/chat
    const embedMatch = path.match(/^\/embed\/([a-zA-Z0-9_]+)/);
    if (embedMatch) {
      return embedMatch[1].toLowerCase();
    }

    // Standard channel page: /{channel}
    const match = path.match(/^\/([a-zA-Z0-9_]+)/);
    if (match && !['directory', 'settings', 'subscriptions', 'inventory', 'wallet', 'drops', 'popout', 'embed'].includes(match[1])) {
      return match[1].toLowerCase();
    }
    return null;
  }

  // Create the Heatsync button element
  function createButton() {
    const btn = document.createElement('button');
    btn.id = BUTTON_ID;
    btn.className = 'heatsync-chat-btn';
    btn.removeAttribute('aria-label');
    btn.setAttribute('data-a-target', 'heatsync-button');
    btn.title = '';

    // Use extension logo — swap to black variant on hover
    const iconUrl = getIconUrl();
    const iconBlackUrl = (() => {
      try { return chrome?.runtime?.getURL?.('icon-48-black.png') } catch(_) {}
      try { return browser?.runtime?.getURL?.('icon-48-black.png') } catch(_) {}
      return null
    })();
    if (iconUrl) {
      const img = document.createElement('img');
      img.src = iconUrl;
      img.alt = 'heatsync';
      img.style.cssText = 'width: 20px; height: 20px; object-fit: contain;';
      btn.appendChild(img);
      if (iconBlackUrl) {
        btn.addEventListener('mouseenter', () => { img.src = iconBlackUrl }, { signal: btnSignal });
        btn.addEventListener('mouseleave', () => { img.src = iconUrl }, { signal: btnSignal });
      }
    } else {
      // Fallback: simple H
      btn.textContent = 'H';
      btn.style.fontWeight = 'bold';
    }

    btn.addEventListener('click', handleButtonClick, { signal: btnSignal });
    btn.addEventListener('contextmenu', handleRightClick, { signal: btnSignal });

    return btn;
  }

  // Inject styles for button and panel
  function injectStyles() {
    if (document.getElementById('heatsync-button-styles')) return;

    const style = document.createElement('style');
    style.id = 'heatsync-button-styles';
    style.textContent = `
      /* Button - matches Twitch's exact button style */
      .heatsync-chat-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: var(--button-size-default, 3.2rem);
        height: var(--button-size-default, 3.2rem);
        padding: 0;
        margin: 0;
        background: var(--color-background-button-text-default, transparent);
        border: none;
        border-radius: 0;
        color: var(--color-fill-button-icon, #fff);
        cursor: pointer;
        user-select: none;
        vertical-align: middle;
        font-weight: var(--font-weight-semibold, 600);
        overflow: hidden;
        position: relative;
      }

      .heatsync-chat-btn:hover {
        background-color: #fff;
        color: #000;
      }

      .heatsync-chat-btn:active {
        background-color: #fff;
        color: #000;
      }

      .heatsync-chat-btn img {
        width: 20px;
        height: 20px;
        object-fit: contain;
      }

      /* Panel - Full emote picker */
      .heatsync-panel {
        position: absolute;
        bottom: 100%;
        right: 0;
        width: 420px;
        max-height: calc(100vh - 10px);
        height: auto;
        margin-bottom: 8px;
        background: #000;
        border: 1px solid rgba(255,255,255,0.12);
        border-radius: 0;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
        z-index: 4999;
        overflow: hidden;
        font-family: Inter, -apple-system, BlinkMacSystemFont, sans-serif;
        display: flex;
        flex-direction: column;
      }

      .heatsync-panel-header {
        display: flex;
        flex-shrink: 0;
        align-items: center;
        justify-content: space-between;
        padding: 12px 16px;
        background: #000;
        border-bottom: 1px solid rgba(255,255,255,0.12);
      }

      .heatsync-panel-title {
        font-size: 14px;
        font-weight: 600;
        color: #fff;
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .heatsync-panel-title img {
        width: 16px;
        height: 16px;
        object-fit: contain;
      }

      .heatsync-panel-close {
        background: none;
        border: none;
        color: #808080;
        cursor: pointer;
        padding: 4px;
        border-radius: 0;
      }

      .heatsync-panel-close:hover {
        background: #fff;
        color: #000;
      }

      .heatsync-header-controls {
        display: flex;
        align-items: center;
        gap: 4px;
      }

      .heatsync-header-btn {
        background: none;
        border: 1px solid rgba(255,255,255,0.12);
        color: #808080;
        cursor: pointer;
        padding: 4px 8px;
        border-radius: 0;
        font-size: 13px;
        transition: none;
      }

      .heatsync-header-btn:hover {
        background: #fff;
        border-color: #fff;
        color: #000;
      }

      .heatsync-header-btn.active {
        background: #fff;
        border-color: #fff;
        color: #000;
      }

      /* Bottom section with search + footer */
      .heatsync-panel-bottom {
        flex-shrink: 0;
        background: #000;
        border-top: 1px solid rgba(255,255,255,0.12);
      }

      .heatsync-panel-bottom .heatsync-search {
        padding: 8px 12px 4px;
        border-bottom: none;
      }

      /* Footer with settings + size buttons */
      .heatsync-panel-footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 12px;
        flex-shrink: 0;
      }

      .heatsync-settings-cog {
        background: none;
        border: 1px solid rgba(255,255,255,0.12);
        color: #808080;
        cursor: pointer;
        padding: 6px;
        border-radius: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: none;
      }

      .heatsync-settings-cog:hover,
      .heatsync-settings-cog.active {
        background: #fff;
        border-color: #fff;
        color: #000;
      }

      .heatsync-settings-cog:disabled {
        opacity: 0.4;
        cursor: not-allowed;
        pointer-events: none;
      }

      .heatsync-settings-cog.hs-flash-err {
        border-color: #e53935;
        color: #e53935;
        background: none;
      }

      .heatsync-size-buttons {
        display: flex;
        gap: 4px;
      }

      .heatsync-size-btn {
        background: none;
        border: 1px solid rgba(255,255,255,0.12);
        color: #808080;
        cursor: pointer;
        padding: 6px 10px;
        border-radius: 0;
        font-size: 13px;
        min-width: 32px;
        transition: none;
      }

      .heatsync-size-btn:hover {
        background: #fff;
        border-color: #fff;
        color: #000;
      }

      .heatsync-size-btn.active {
        background: #fff;
        border-color: #fff;
        color: #000;
      }

      .heatsync-panel-content {
        flex: 1;
        overflow: hidden;
        display: flex;
        flex-direction: column;
      }

      /* Search bar */
      .heatsync-search {
        padding: 8px 12px;
        border-bottom: 1px solid rgba(255,255,255,0.12);
      }

      .heatsync-search input {
        width: 100%;
        padding: 8px 12px;
        background: #000;
        border: 1px solid rgba(255,255,255,0.12);
        border-radius: 0;
        color: #fff;
        font-size: 13px;
        outline: none;
      }

      .heatsync-search input:focus {
        border-color: #ff8700;
      }

      .heatsync-search input::placeholder {
        color: #808080;
      }

      /* Top search row — search input + source chips. Replaces the bottom search wrap. */
      .hs-top-search {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 8px;
        background: #000;
        border-bottom: 1px solid rgba(255,255,255,0.12);
        flex-shrink: 0;
      }
      .hs-top-search input {
        flex: 1;
        min-width: 0;
        background: #000;
        border: 1px solid rgba(255,255,255,0.12);
        border-radius: 0;
        color: #fff;
        font-size: 12px;
        padding: 5px 8px;
        outline: none;
        font-family: inherit;
      }
      .hs-top-search input:focus { border-color: #ff8700; }
      .hs-top-search input::placeholder { color: #808080; }

      .hs-src-chips {
        display: none;
        gap: 2px;
        flex-shrink: 0;
      }
      .hs-src-chips.visible {
        display: flex;
      }
      .hs-src-chip {
        background: none;
        border: 1px solid rgba(255,255,255,0.18);
        color: #808080;
        font-size: 13px;
        font-weight: 600;
        padding: 3px 6px;
        cursor: pointer;
        font-family: inherit;
        border-radius: 0;
        line-height: 1.2;
        text-transform: lowercase;
      }
      .hs-src-chip:hover { background: #fff; color: #000; border-color: #fff; }
      .hs-src-chip.active {
        background: #ff8700;
        border-color: #ff8700;
        color: #000;
      }
      .hs-src-chip.active:hover { background: #fff; border-color: #fff; }

      .hs-discover-item { cursor: pointer; }

      /* Tabs */
      .heatsync-tabs {
        display: flex;
        flex-shrink: 0;
        border-bottom: 1px solid rgba(255,255,255,0.12);
        background: #000;
      }

      .heatsync-tab {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        line-height: 1.1;
        padding: 3px 4px;
        background: none;
        border: none;
        color: #808080;
        font-size: 13px;
        cursor: pointer;
        border-bottom: 2px solid transparent;
        transition: none;
      }

      .heatsync-tab:hover {
        background: #fff;
        color: #000;
      }

      .heatsync-tab.active {
        background: #fff;
        color: #000;
      }

      .heatsync-tab-count {
        display: block;
        font-size: 10px;
        color: #808080;
        margin-left: 0;
      }

      /* Emote grid - virtual scrolling container */
      .heatsync-emote-grid {
        flex: 1;
        overflow-y: auto;
        padding: 8px;
        contain: strict;
        /* No floor — the grid is the ONLY element that shrinks when the panel
           is clamped to a small viewport, so the tabs/search/footer chrome
           always stays visible (smart sizing: fewer emotes, full UI). */
        min-height: 0;
      }

      /* Settings view - no min height, compact */
      .heatsync-emote-grid:has(.heatsync-settings) {
        min-height: auto;
        contain: none;
      }

      .heatsync-emote-row {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
      }

      .heatsync-emote-grid img {
        height: 32px;
        width: auto;
        cursor: pointer;
        border-radius: 0;
        display: block;
      }

      /* Emote size variants */
      .heatsync-emote-grid.size-1x img { height: 32px; }
      .heatsync-emote-grid.size-2x img { height: 56px; }
      .heatsync-emote-grid.size-4x img { height: 112px; }

      .heatsync-emote-grid.size-1x .heatsync-emote-wrap { min-width: 32px; min-height: 32px; }
      .heatsync-emote-grid.size-2x .heatsync-emote-wrap { min-width: 56px; min-height: 56px; }
      .heatsync-emote-grid.size-4x .heatsync-emote-wrap { min-width: 112px; min-height: 112px; }

      /* Emote wrapper - simple background hover */
      .heatsync-emote-wrap {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 0;
        cursor: pointer;
        flex-shrink: 0;
      }

      /* Keyboard focus highlight */
      .heatsync-emote-wrap.hs-kb-focus {
        outline: 2px solid #ff8700;
        outline-offset: -2px;
      }

      /* 2-state model: no per-state opacity dimming. Every pasteable emote
         renders at full opacity; only blocked uses the dashed outline below.
         Hover keeps the img visible (z-index: 1) on top of the white wrap
         bg — matches the multichat overlay convention. */
      .heatsync-emote-wrap img {
        position: relative;
        z-index: 1;
      }

      /* background-color cross-fades 0.25s so block↔unblock under cursor
         flows between legend colors. ease-out front-loads the change so
         hover-in still feels immediate. */
      .heatsync-emote-wrap {
        transition: background-color 0.25s ease-out;
      }

      /* 2-state model: every pasteable emote hovers white (project convention,
         matches the multichat overlay picker). Blocked has its own dashed
         outline rule below. The old green/orange tiers (owned vs unadded) are
         gone — slot membership is no longer a render-time distinction. */
      .heatsync-emote-wrap:hover {
        background: #fff;
      }

      /* Blocked emotes: dashed outline on the wrap (so the image's opacity
         doesn't drag the outline into invisibility), image hidden via
         visibility so the slot keeps its 32×32 layout. */
      .heatsync-emote-wrap.blocked {
        outline: 2px dashed #808080 !important;
        outline-offset: -2px !important;
      }
      .heatsync-emote-wrap.blocked img {
        visibility: hidden !important;
      }
      .heatsync-emote-wrap.blocked:hover {
        background: #ff0000;
      }

      /* Provider section headers */
      .heatsync-provider-section {
        width: 100%;
        margin-top: 8px;
        margin-bottom: 4px;
      }

      .heatsync-provider-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 6px 8px;
        background: #000;
        border-radius: 0;
        margin-bottom: 6px;
      }

      .heatsync-provider-label {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 11px;
        font-weight: 600;
        text-transform: lowercase;
        letter-spacing: 0.3px;
      }

      .heatsync-provider-label.seventv,
      .heatsync-provider-label.bttv,
      .heatsync-provider-label.ffz { color: #29b6f6; }

      .heatsync-provider-count {
        font-size: 10px;
        color: #808080;
        font-weight: normal;
      }

      .heatsync-add-all-btn {
        padding: 3px 8px;
        background: transparent;
        border: 1px solid #808080;
        border-radius: 0;
        color: #808080;
        font-size: 13px;
        cursor: pointer;
        transition: none;
      }

      .heatsync-add-all-btn:hover {
        background: #fff;
        border-color: #fff;
        color: #000;
      }

      .heatsync-add-all-btn.added {
        border-color: #00cc66;
        color: #00cc66;
      }

      .heatsync-add-all-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      /* Not logged in message */
      .heatsync-login-msg {
        padding: 20px;
        text-align: center;
        color: #808080;
        font-size: 13px;
      }

      .heatsync-login-msg a {
        color: #9147ff;
        text-decoration: none;
      }

      .heatsync-login-msg a:hover {
        background: #fff;
        color: #000;
        text-decoration: none;
      }

      /* Provider emotes container */
      .heatsync-provider-emotes {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
      }

      .heatsync-size-toggle {
        background: none;
        border: 1px solid #808080;
        border-radius: 0;
        color: #808080;
        font-size: 11px;
        padding: 2px 6px;
        cursor: pointer;
        margin-right: 8px;
      }

      .heatsync-size-toggle:hover {
        background: #fff;
        border-color: #fff;
        color: #000;
      }

      .heatsync-empty {
        padding: 40px 20px;
        text-align: center;
        color: #a0a0a0;
        font-size: 13px;
      }

      /* Empty-inventory cold-start CTA */
      .hs-coldstart {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 10px;
        padding: 28px 20px;
        text-align: center;
      }
      .hs-coldstart-title { color: #fff; font-size: 14px; font-weight: 600; }
      .hs-coldstart-sub { color: #a0a0a0; font-size: 13px; max-width: 260px; line-height: 1.4; }
      .hs-coldstart .hs-import-channel-btn { flex: none; padding: 6px 14px; }

      /* Saved emote sets list */
      .heatsync-sets-list {
        display: flex;
        flex-direction: column;
        gap: 0;
        padding: 0;
      }
      .heatsync-set-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
        padding: 2px 8px;
        background: transparent;
        border: none;
        border-bottom: 1px solid rgba(255,255,255,0.04);
        line-height: 1.3;
      }
      .heatsync-set-item:hover {
        background: rgba(255,135,0,0.07);
      }
      .heatsync-set-info {
        display: flex;
        flex-direction: row;
        gap: 6px;
        align-items: baseline;
        min-width: 0;
        flex: 1;
      }
      .heatsync-set-name {
        font-size: 13px;
        font-weight: 600;
        color: #fff;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        flex-shrink: 1;
      }
      .heatsync-set-meta {
        font-size: 10px;
        color: #808080;
        flex-shrink: 0;
        white-space: nowrap;
      }
      .heatsync-set-apply-btn {
        background: transparent;
        color: #ff8700;
        border: 1px solid #ff8700;
        padding: 0 6px;
        font: inherit;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        text-transform: lowercase;
        flex-shrink: 0;
        line-height: 1.4;
      }
      .heatsync-set-apply-btn:hover {
        background: #fff;
        color: #000;
        border-color: #fff;
      }
      .heatsync-set-apply-btn.confirming {
        background: #ff8700;
        color: #000;
        border-color: #ff8700;
      }
      .heatsync-set-apply-btn.applying {
        opacity: 0.6;
        cursor: wait;
      }
      .heatsync-set-apply-btn.applied {
        background: #00cc66;
        color: #000;
        border-color: #00cc66;
      }
      .heatsync-set-apply-btn.failed {
        background: #ff4444;
        color: #fff;
        border-color: #ff4444;
      }

      /* Removed emotes history list */
      .heatsync-history-list {
        display: flex;
        flex-direction: column;
        gap: 0;
        padding: 0;
      }
      .heatsync-history-item {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 1px 8px;
        background: transparent;
        border: none;
        border-bottom: 1px solid rgba(255,255,255,0.04);
        line-height: 1.3;
      }
      .heatsync-history-item:hover {
        background: rgba(255,135,0,0.07);
      }
      .heatsync-history-thumb {
        width: 18px;
        height: 18px;
        object-fit: contain;
        flex-shrink: 0;
        image-rendering: pixelated;
      }
      .heatsync-history-info {
        display: flex;
        flex-direction: row;
        gap: 6px;
        align-items: baseline;
        min-width: 0;
        flex: 1;
      }
      .heatsync-history-name {
        font-size: 13px;
        font-weight: 600;
        color: #fff;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        flex-shrink: 1;
      }
      .heatsync-history-meta {
        font-size: 10px;
        color: #808080;
        flex-shrink: 0;
        white-space: nowrap;
      }
      .heatsync-restore-btn {
        background: transparent;
        color: #ff8700;
        border: 1px solid #ff8700;
        padding: 0 6px;
        font: inherit;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        text-transform: lowercase;
        flex-shrink: 0;
        line-height: 1.4;
      }
      .heatsync-restore-btn:hover {
        background: #fff;
        color: #000;
        border-color: #fff;
      }
      .heatsync-restore-btn.confirming {
        background: #ff8700;
        color: #000;
        border-color: #ff8700;
      }
      .heatsync-restore-btn.restoring {
        opacity: 0.6;
        cursor: wait;
      }
      .heatsync-restore-btn.restored {
        background: #00cc66;
        color: #000;
        border-color: #00cc66;
      }
      .heatsync-restore-btn.failed {
        background: #ff4444;
        color: #fff;
        border-color: #ff4444;
      }

      .heatsync-loading {
        padding: 4px 8px;
        background: #000;
        border-radius: 0;
        color: #fff;
        font-size: 11px;
        margin-bottom: 4px;
      }

      /* Import section */
      .heatsync-import-section {
        margin-bottom: 16px;
      }

      .heatsync-import-btn {
        width: 100%;
        padding: 10px 16px;
        background: #ff8700;
        border: none;
        border-radius: 0;
        color: #fff;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        transition: none;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
      }

      .heatsync-import-btn:hover {
        background: #fff !important;
        color: #000 !important;
      }

      .heatsync-import-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .heatsync-import-btn svg {
        width: 16px;
        height: 16px;
      }

      .heatsync-channel-name {
        color: #bf94ff;
        font-weight: 700;
      }

      /* Emote preview grid */
      .heatsync-import-preview {
        display: grid;
        grid-template-columns: repeat(8, 1fr);
        gap: 4px;
        margin-top: 12px;
        padding: 8px;
        background: #000;
        border-radius: 0;
        max-height: 150px;
        overflow-y: auto;
      }

      .heatsync-import-preview img {
        width: 28px;
        height: 28px;
        object-fit: contain;
        border-radius: 0;
        cursor: pointer;
        transition: none;
      }

      .heatsync-import-preview img:hover {
        background: #fff;
      }

      /* Status messages */
      .heatsync-status {
        text-align: center;
        padding: 16px;
        color: #808080;
        font-size: 13px;
      }

      .heatsync-status.loading::after {
        content: '';
        display: inline-block;
        width: 12px;
        height: 12px;
        margin-left: 8px;
        border: 2px solid #808080;
        border-top-color: transparent;
        border-radius: 50%;
        animation: heatsync-spin 0.8s linear infinite;
      }

      @keyframes heatsync-spin {
        to { transform: rotate(360deg); }
      }

      /* Links section */
      .heatsync-links {
        display: flex;
        gap: 8px;
        margin-top: 12px;
        padding-top: 12px;
        border-top: 1px solid rgba(255,255,255,0.12);
      }

      .heatsync-link {
        flex: 1;
        padding: 8px;
        background: rgba(255,255,255,0.08);
        border: none;
        border-radius: 0;
        color: #808080;
        font-size: 12px;
        cursor: pointer;
        text-align: center;
        text-decoration: none;
        transition: none;
      }

      .heatsync-link:hover {
        background: #fff;
        color: #000;
      }

      /* Emote count badge */
      .heatsync-emote-count {
        display: inline-block;
        padding: 2px 6px;
        background: rgba(255,255,255,0.08);
        border-radius: 0;
        font-size: 12px;
        color: #808080;
        margin-left: 8px;
      }

      /* Provider badges */
      .heatsync-provider {
        display: inline-block;
        padding: 2px 6px;
        border-radius: 0;
        font-size: 10px;
        font-weight: 600;
        margin-right: 4px;
      }

      .heatsync-provider.seventv { background: #29b6f6; color: #000; }
      .heatsync-provider.bttv { background: #d50014; color: #fff; }
      .heatsync-provider.ffz { background: #6b54ff; color: #fff; }

      /* Section titles */
      .heatsync-section-title {
        font-size: 11px;
        font-weight: 600;
        color: #808080;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin-bottom: 8px;
      }

      .heatsync-inventory-section {
        margin-bottom: 16px;
        padding-bottom: 12px;
        border-bottom: 1px solid rgba(255,255,255,0.12);
      }

      /* Settings view - compact */
      .heatsync-settings {
        padding: 12px;
        overflow-y: auto;
      }

      .heatsync-setting-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 0;
        border-bottom: 1px solid rgba(255,255,255,0.06);
      }

      .heatsync-setting-row:last-child {
        border-bottom: none;
      }

      .heatsync-setting-label {
        color: #fff;
        font-size: 13px;
      }

      /* Square red/green toggle — identical to the overlay's .hs-mc-toggle-pill
         so toggles look the same in both modes. Square, ANSI red=off/green=on,
         no sliding knob (the slider was the only trendy-motion control left). */
      .heatsync-toggle {
        width: 16px;
        height: 16px;
        background: #cc0000;
        border: none;
        border-radius: 0;
        cursor: pointer;
        padding: 0;
        transition: none;
        flex-shrink: 0;
      }

      .heatsync-toggle.active {
        background: #00dd00;
      }

      /* Emote hover preview tooltip */
      .heatsync-emote-hover-preview {
        position: fixed;
        z-index: 5000;
        pointer-events: none;
        background: #000;
        border: 2px solid #ff8700;
        border-radius: 0;
        padding: 8px;
      }

      .heatsync-emote-hover-preview img {
        display: block;
        max-width: 256px;
        max-height: 128px;
        width: auto;
        height: auto;
        object-fit: contain;
      }

      .heatsync-emote-hover-preview-name {
        text-align: center;
        font-size: 11px;
        color: #fff;
        margin-top: 4px;
        font-weight: 600;
      }

      .heatsync-settings-section {
        margin-bottom: 20px;
      }

      .heatsync-settings-section-title {
        color: #ff8700;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin-bottom: 8px;
      }

      /* Auth banner - shown when not logged in */
      .heatsync-auth-banner {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 12px;
        background: rgba(145, 71, 255, 0.15);
        border-bottom: 1px solid #9147ff;
        color: #bf94ff;
        font-size: 12px;
      }

      .heatsync-auth-banner a {
        color: #9147ff;
        font-weight: 600;
        text-decoration: none;
      }

      .heatsync-auth-banner a:hover {
        background: #fff;
        color: #000;
        text-decoration: none;
      }

      /* Error state */
      .heatsync-error-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: 40px 20px;
        text-align: center;
        color: #808080;
      }

      .heatsync-error-icon {
        font-size: 32px;
        margin-bottom: 12px;
      }

      .heatsync-error-msg {
        font-size: 14px;
        margin-bottom: 16px;
        color: #ff6b6b;
      }

      .heatsync-retry-btn {
        padding: 8px 16px;
        background: rgba(255,255,255,0.06);
        border: none;
        border-radius: 0;
        color: #fff;
        font-size: 13px;
        cursor: pointer;
        transition: none;
      }

      .heatsync-retry-btn:hover {
        background: #fff;
        color: #000;
      }

      /* Cached data indicator */
      .heatsync-cached-badge {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 2px 6px;
        background: rgba(255, 204, 0, 0.2);
        border-radius: 0;
        color: #ffcc00;
        font-size: 10px;
        margin-left: 8px;
      }

      /* Connection status in header */
      .heatsync-connection-status {
        display: flex;
        align-items: center;
        gap: 4px;
        font-size: 10px;
        color: #808080;
      }

      .heatsync-status-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
      }

      .heatsync-status-dot.connected { background: #00cc66; }
      .heatsync-status-dot.disconnected { background: #ffcc00; }
      .heatsync-status-dot.error { background: #ff4444; }

      /* Disabled add buttons when not logged in */
      .heatsync-add-all-btn.disabled {
        opacity: 0.4;
        cursor: not-allowed;
        pointer-events: none;
      }

      /* Emote context menu */
      .hs-emote-ctx {
        position: fixed;
        z-index: 5001;
        background: #000;
        color: #fff;
        border: 1px solid #ff8700;
        padding: 0 0 4px;
        min-width: 200px;
        max-width: 280px;
        box-shadow: 0 6px 32px rgba(0,0,0,0.75);
        font-size: 13px;
      }
      .hs-emote-ctx-preview {
        display: flex; align-items: center; gap: 10px;
        padding: 8px 10px; margin-bottom: 4px;
        border-bottom: 1px solid #222;
        background: #0a0a0a;
      }
      .hs-emote-ctx-thumb {
        width: 56px; height: 56px; flex-shrink: 0;
        display: flex; align-items: center; justify-content: center;
        background-image:
          linear-gradient(45deg, #161616 25%, transparent 25%),
          linear-gradient(-45deg, #161616 25%, transparent 25%),
          linear-gradient(45deg, transparent 75%, #161616 75%),
          linear-gradient(-45deg, transparent 75%, #161616 75%);
        background-size: 12px 12px;
        background-position: 0 0, 0 6px, 6px -6px, -6px 0;
        border: 1px solid #222;
      }
      .hs-emote-ctx-thumb img { max-width: 100%; max-height: 100%; }
      .hs-emote-ctx-meta { flex: 1; min-width: 0; }
      .hs-emote-ctx-name {
        font-weight: 700; font-size: 13px; color: #fff;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .hs-emote-ctx-sub {
        font-size: 11px; color: #888; margin-top: 2px;
        display: flex; gap: 6px; align-items: center; flex-wrap: wrap;
      }
      .hs-emote-ctx-provider {
        display: inline-block; padding: 0 4px;
        border: 1px solid #444; color: #ff8700;
        font-size: 10px; line-height: 14px;
      }
      .hs-emote-ctx-item {
        display: block;
        width: 100%;
        padding: 6px 12px;
        background: none;
        border: none;
        color: #fff;
        text-align: left;
        cursor: pointer;
        font-size: 13px;
        white-space: nowrap;
      }
      .hs-emote-ctx-item:hover {
        background: #fff;
        color: #000;
      }
      .hs-emote-ctx-sep {
        height: 1px;
        background: #1a1a1a;
        margin: 4px 0;
      }

      /* Context menu inline input (rename/move) */
      .hs-emote-ctx-input {
        display: block;
        width: calc(100% - 16px);
        margin: 4px 8px;
        padding: 5px 8px;
        background: #1a1a1a;
        border: 1px solid #808080;
        border-radius: 2px;
        color: #fff;
        font-size: 12px;
        outline: none;
      }
      .hs-emote-ctx-input:focus { border-color: #ff8700; }
      .hs-emote-ctx-confirm {
        display: block;
        width: calc(100% - 16px);
        margin: 2px 8px 6px;
        padding: 4px 8px;
        background: #ff8700;
        border: none;
        border-radius: 2px;
        color: #000;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        text-align: center;
      }
      .hs-emote-ctx-confirm:hover { background: #fff; }

      /* Import-channel button above channel emote grid */
      .hs-import-channel-bar {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 8px;
        border-bottom: 1px solid rgba(255,255,255,0.08);
        flex-shrink: 0;
      }
      .hs-import-channel-btn {
        flex: 1;
        padding: 5px 10px;
        background: none;
        border: 1px solid #ff8700;
        color: #ff8700;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        text-align: center;
        border-radius: 0;
      }
      .hs-import-channel-btn:hover { background: #ff8700; color: #000; }
      .hs-import-channel-btn:disabled { opacity: 0.4; cursor: wait; }

      /* Discover tab list */
      .hs-discover-list {
        display: flex;
        flex-direction: column;
        gap: 0;
        padding: 0;
      }
      .hs-discover-item {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 1px 8px;
        background: transparent;
        border: none;
        border-bottom: 1px solid rgba(255,255,255,0.04);
        line-height: 1.3;
      }
      .hs-discover-item.blocked {
        outline: 2px dashed #808080;
        outline-offset: -2px;
        opacity: 0.5;
      }
      .hs-discover-item.blocked .hs-discover-thumb { filter: grayscale(1); }
      .hs-discover-item.blocked::after {
        content: 'blocked';
        margin-left: auto;
        font-size: 10px;
        color: #808080;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }
      .hs-discover-item.blocked:hover { background: #ff0000; color: #fff; opacity: 1; }
      .hs-discover-item:hover { background: #fff; color: #000; }
      .hs-discover-item:hover * { color: #000 !important; }
      .hs-discover-thumb {
        width: 18px;
        height: 18px;
        object-fit: contain;
        flex-shrink: 0;
      }
      .hs-discover-name {
        flex: 1;
        font-size: 13px;
        color: #fff;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .hs-discover-add-btn {
        background: none;
        border: 1px solid #ff8700;
        color: #ff8700;
        font-size: 13px;
        font-weight: 600;
        padding: 0 6px;
        cursor: pointer;
        flex-shrink: 0;
        border-radius: 0;
        line-height: 1.4;
      }
      .hs-discover-add-btn:hover { background: #ff8700; color: #000; }
      .hs-discover-add-btn.added { border-color: #00cc66; color: #00cc66; background: none; cursor: default; }
      .hs-discover-add-btn:disabled { opacity: 0.4; cursor: wait; }
      .hs-discover-hint {
        font-size: 10px;
        color: #888;
        padding: 4px 8px 6px;
        border-bottom: 1px solid rgba(255,255,255,0.06);
        line-height: 1.3;
      }
      .hs-search-all-cta {
        display: block;
        width: calc(100% - 16px);
        margin: 6px 8px;
        background: none;
        border: 1px solid #ff8700;
        color: #ff8700;
        font-size: 11px;
        font-weight: 600;
        padding: 6px 8px;
        cursor: pointer;
        border-radius: 0;
        text-align: center;
        font-family: inherit;
      }
      .hs-search-all-cta:hover { background: #fff; color: #000; border-color: #fff; }
      .hs-discover-prov {
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        padding: 0 4px;
        line-height: 1.5;
        border: 1px solid currentColor;
        flex-shrink: 0;
      }
      .hs-discover-prov.prov-7tv { color: #29d9ff; }
      .hs-discover-prov.prov-bttv { color: #ffaa00; }
      .hs-discover-prov.prov-ffz { color: #5c8bff; }
      .hs-discover-prov.prov-hs { color: #ff8700; }
      .hs-discover-item:hover .hs-discover-prov { color: #000 !important; border-color: #000 !important; }
      .hs-discover-uses {
        font-size: 10px;
        color: #888;
        flex-shrink: 0;
        min-width: 28px;
        text-align: right;
      }
      .hs-discover-item:hover .hs-discover-uses { color: #000 !important; }

    `;
    document.head.appendChild(style);
  }

  // UI hiding CSS (Chatterino-style)
  let uiHidingStyle = null;

  function applyUiHidingSettings(settings) {
    log(' applyUiHidingSettings called with:', settings);

    // Remove existing style (check both variable AND DOM in case of extension reload)
    if (uiHidingStyle) {
      uiHidingStyle.remove();
      uiHidingStyle = null;
    }
    // Also remove by ID in case variable was reset on reload
    document.getElementById('heatsync-ui-hiding-btn')?.remove();

    const rules = [];

    // hideChatHeader is handled by content.js - don't duplicate here
    // This prevents CSS conflicts and layout bugs

    // hideStreamTitle and hideViewerCount are handled by content.js:applyUiSettings()

    if (settings.compactChatInput) {
      // Compact chat input - inline useful buttons, hide useless ones
      const nuke = 'display: none !important; visibility: hidden !important; height: 0 !important; width: 0 !important; margin: 0 !important; padding: 0 !important;';

      // Hide emote picker button (we have our own fire button)
      rules.push('[data-a-target="emote-picker-button"] { ' + nuke + ' }');

      // Hide chat pause button (useless)
      rules.push('[data-a-target="chat-pause-button"] { ' + nuke + ' }');

      // Hide the entire second row of buttons below input (waste of space)
      rules.push('.chat-input__buttons-container { ' + nuke + ' }');
      rules.push('[data-a-target="chat-input-buttons-container"] { ' + nuke + ' }');

      // Make the input buttons container inline and compact
      rules.push('.chat-input { padding: 4px 0 !important; }');
      rules.push('[class*="chat-input-buttons"] { display: inline-flex !important; flex-direction: row !important; align-items: center !important; gap: 4px !important; }');

      // Make bits button compact and inline
      rules.push('[data-a-target="bits-button"] { margin: 0 2px !important; padding: 2px 6px !important; font-size: 12px !important; }');

      // Make settings button compact
      rules.push('[data-a-target="chat-settings"] { margin: 0 2px !important; padding: 2px !important; }');

      // Ensure our fire button stays on far right
      rules.push('#heatsync-fire-button { order: 999 !important; margin-left: auto !important; }');
    }

    if (settings.highlightMentions) {
      // Chatterino-style: Red background on ENTIRE message line when mentioned
      log(' 🔴 INJECTING RED BACKGROUND CSS FOR MENTIONS');

      // Primary rule: entire message line gets dark blood-red bg so full-color usernames read on top
      rules.push('.chat-line__message.hs-mentioned { background-color: #330808 !important; }');
      rules.push('.hs-mentioned.chat-line__message { background-color: #330808 !important; }');

      // All children must be transparent so red shows through
      rules.push('.chat-line__message.hs-mentioned * { background-color: transparent !important; background: transparent !important; }');

      // Generic fallback if class is on wrong element
      rules.push('.hs-mentioned { background-color: #330808 !important; }');
      rules.push('.hs-mentioned * { background-color: transparent !important; background: transparent !important; }');
    }

    // ALWAYS kill Twitch's ugly white mention backgrounds (even if highlight disabled)
    // These rules must be outside the if block to always apply
    rules.push('.mention-fragment { background-color: transparent !important; background: none !important; }');
    rules.push('[data-a-target="chat-message-mention"] { background-color: transparent !important; background: none !important; }');
    rules.push('[class*="mention-fragment"] { background-color: transparent !important; background: none !important; }');
    rules.push('.chat-line__message .mention-fragment { background: none !important; background-color: transparent !important; }');

    log(' CSS rules to apply:', rules.length);

    if (rules.length > 0) {
      uiHidingStyle = document.createElement('style');
      uiHidingStyle.id = 'heatsync-ui-hiding-btn';
      uiHidingStyle.textContent = rules.join('\n');
      document.head.appendChild(uiHidingStyle);
      log(' Applied UI hiding:', rules.length, 'rules');
    } else {
      log(' No rules to apply (all settings false)');
    }

  }

  // Cached settings (loaded async on init, updated on change)
  let cachedSettings = {
    emoteWysiwyg: true,
    emoteSpaceAfter: true,
    hideChatHeader: true,
    hideStreamTitle: false,
    hideViewerCount: false,
    compactChatInput: true,
    highlightMentions: true,
    viMode: false,               // Vim keybindings for chat input
    showPlatformBadges: true,    // Show [T]/[K]/[YT] badges on messages
    // 'menu'=rich context menu (default — open-on-provider, copy, block, +add),
    // 'instant'=block immediately on right-click (no menu), 'off'=disabled.
    rightClickBlockMode: 'menu',
  };

  // Get extension settings (sync - returns cached)
  function getExtensionSettings() {
    return { ...cachedSettings };
  }

  // Load settings from chrome.storage.local (async)
  async function loadExtensionSettings() {
    try {
      const stored = await chrome.storage.sync.get('ui_settings');
      if (stored.ui_settings) {
        cachedSettings = { ...cachedSettings, ...sanitizeUiSettings(stored.ui_settings) };
      }
      // ALSO sync to localStorage for autocomplete-hook.js (page context)
      try {
        localStorage.setItem('heatsync-extension-settings', JSON.stringify(cachedSettings));
      } catch (err) {
        console.error('[heatsync-button] Failed to sync to localStorage:', err);
      }
      log('Loaded settings from storage:', cachedSettings);
    } catch (e) {
      log('Failed to load extension settings:', e);
    }
    return cachedSettings;
  }

  // Save extension settings to chrome.storage.local
  function saveExtensionSettings(settings) {
    log(' saveExtensionSettings called with:', settings);
    try {
      cachedSettings = { ...sanitizeUiSettings(settings) };
      // Save to chrome.storage.local (same key as popup.js)
      chrome.storage.sync.set({ ui_settings: cachedSettings }).then(() => {
        log(' Settings saved to storage');
      }).catch(err => {
        console.error('[heatsync-button] Failed to save to storage:', err);
      });
      // ALSO save to localStorage so autocomplete-hook.js (page context) can read it
      try {
        localStorage.setItem('heatsync-extension-settings', JSON.stringify(settings));
      } catch (err) {
        console.error('[heatsync-button] Failed to save to localStorage:', err);
      }
      // Notify autocomplete-hook.js of settings change (postMessage crosses content/page boundary)
      window.postMessage({ type: 'heatsync-settings-changed', settings: settings }, location.origin);
      // Apply UI hiding immediately
      applyUiHidingSettings(settings);
      log('Saved settings:', settings);
    } catch (e) {
      console.error('[heatsync-button] Failed to save extension settings:', e);
      log('Failed to save extension settings:', e);
    }
  }

  // Listen for settings changes from popup.js or other tabs.
  // Settings are stored in chrome.storage.sync (browser-account synced),
  // not local — gate area check accordingly.
  function _onStorageChanged(changes, area) {
    if (area === 'sync' && changes.ui_settings) {
      const newSettings = changes.ui_settings.newValue;
      if (newSettings) {
        cachedSettings = { ...cachedSettings, ...sanitizeUiSettings(newSettings) };
        // ALSO sync to localStorage for autocomplete-hook.js (page context)
        try {
          localStorage.setItem('heatsync-extension-settings', JSON.stringify(cachedSettings));
        } catch (err) {
          console.error('[heatsync-button] Failed to sync to localStorage:', err);
        }
        applyUiHidingSettings(cachedSettings);
        log('Settings updated from storage:', cachedSettings);
      }
    }
  }
  chrome.storage.onChanged.addListener(_onStorageChanged);
  btnSignal.addEventListener('abort', () => {
    chrome.storage.onChanged.removeListener(_onStorageChanged);
  });

  // Render settings view
  function renderSettings() {
    log(' renderSettings called');
    const grid = document.getElementById('heatsync-emote-grid');
    if (!grid) {
      log(' Grid not found!');
      return;
    }

    const settings = getExtensionSettings();
    log(' Rendering settings with:', settings);

    grid.innerHTML = `
      <div class="heatsync-settings">
        <div class="heatsync-settings-section">
          <div class="heatsync-settings-section-title">mode</div>
          <div class="heatsync-setting-row">
            <div>
              <div class="heatsync-setting-label">multichat overlay</div>
              <div class="heatsync-setting-desc">off = lite mode — emotes in native chat, no panel</div>
            </div>
            <div class="heatsync-toggle ${cachedSettings.multichatOverlayEnabled !== false ? 'active' : ''}" data-overlay-toggle></div>
          </div>
        </div>

        <div class="heatsync-settings-section">
          <div class="heatsync-settings-section-title">${t('btn_settings_tab_completion')}</div>

          <div class="heatsync-setting-row">
            <div>
              <div class="heatsync-setting-label">${t('btn_settings_wysiwyg')}</div>
            </div>
            <div class="heatsync-toggle ${settings.emoteWysiwyg ? 'active' : ''}" data-setting="emoteWysiwyg"></div>
          </div>

          <div class="heatsync-setting-row">
            <div>
              <div class="heatsync-setting-label">${t('btn_settings_space_after')}</div>
            </div>
            <div class="heatsync-toggle ${settings.emoteSpaceAfter ? 'active' : ''}" data-setting="emoteSpaceAfter"></div>
          </div>

          <div class="heatsync-setting-row">
            <div>
              <div class="heatsync-setting-label">right-click block</div>
              <div class="heatsync-setting-desc">instant blocks immediately · menu shows block/cancel · off disables it</div>
            </div>
            <div class="heatsync-rcb-segmented" style="display:inline-flex;border:1px solid #808080;font-family:'CozetteVector',monospace;font-size:13px;-webkit-font-smoothing:none;font-smooth:never;font-synthesis:none;text-rendering:optimizeSpeed">
              ${['instant','menu','off'].map(v => `<button type="button" class="heatsync-rcb-opt" data-rcb="${v}" style="background:${(settings.rightClickBlockMode||'menu')===v?'#fff':'transparent'};color:${(settings.rightClickBlockMode||'menu')===v?'#000':'#fff'};border:none;cursor:pointer;padding:4px 10px;font-family:inherit;font-size:13px">${v}</button>`).join('')}
            </div>
          </div>
        </div>

        <div class="heatsync-settings-section">
          <div class="heatsync-settings-section-title">${t('btn_settings_chat_ui')}</div>

          <div class="heatsync-setting-row">
            <div>
              <div class="heatsync-setting-label">${t('btn_settings_hide_header')} <span style="color:#808080;font-size:11px">${t('btn_settings_always_popout')}</span></div>
            </div>
            <div class="heatsync-toggle ${settings.hideChatHeader ? 'active' : ''}" data-setting="hideChatHeader"></div>
          </div>

          <div class="heatsync-setting-row">
            <div>
              <div class="heatsync-setting-label">${t('btn_settings_compact_input')}</div>
            </div>
            <div class="heatsync-toggle ${settings.compactChatInput ? 'active' : ''}" data-setting="compactChatInput"></div>
          </div>

          <div class="heatsync-setting-row">
            <div>
              <div class="heatsync-setting-label">${t('btn_settings_highlight_mentions')}</div>
            </div>
            <div class="heatsync-toggle ${settings.highlightMentions ? 'active' : ''}" data-setting="highlightMentions"></div>
          </div>

          ${cachedSettings.multichatOverlayEnabled === false ? '' : `<div class="heatsync-setting-row">
            <div>
              <div class="heatsync-setting-label">${t('btn_settings_platform_badges')}</div>
              <div class="heatsync-setting-desc">${t('btn_settings_platform_badges_desc')}</div>
            </div>
            <div class="heatsync-toggle ${settings.showPlatformBadges ? 'active' : ''}" data-setting="showPlatformBadges"></div>
          </div>`}

          <div class="heatsync-setting-row">
            <div>
              <div class="heatsync-setting-label">${t('btn_settings_cosmetics')}</div>
              <div class="heatsync-setting-desc">${t('btn_settings_cosmetics_desc')}</div>
            </div>
            <div class="heatsync-toggle ${settings.showCosmetics !== false ? 'active' : ''}" data-setting="showCosmetics"></div>
          </div>
        </div>

        <div class="heatsync-settings-section">
          <div class="heatsync-settings-section-title">${t('btn_settings_input')}</div>

          <div class="heatsync-setting-row">
            <div>
              <div class="heatsync-setting-label">${t('btn_settings_vi_mode')}</div>
              <div class="heatsync-setting-desc">${t('btn_settings_vi_mode_desc')}</div>
            </div>
            <div class="heatsync-toggle ${settings.viMode ? 'active' : ''}" data-setting="viMode"></div>
          </div>
        </div>
      </div>
    `;

    // Add click handlers for toggles
    const toggles = grid.querySelectorAll('.heatsync-toggle');
    toggles.forEach(toggle => {
      toggle.addEventListener('click', () => {
        const settingKey = toggle.dataset.setting;
        if (!settingKey) return; // e.g. the overlay toggle below has its own handler
        const currentSettings = getExtensionSettings();
        currentSettings[settingKey] = !currentSettings[settingKey];
        saveExtensionSettings(currentSettings);
        toggle.classList.toggle('active');
        log(' Setting changed:', settingKey, '=', currentSettings[settingKey]);
      });
    });

    // Right-click block segmented control
    const rcbButtons = grid.querySelectorAll('.heatsync-rcb-opt');
    rcbButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const value = btn.dataset.rcb;
        const currentSettings = getExtensionSettings();
        currentSettings.rightClickBlockMode = value;
        saveExtensionSettings(currentSettings);
        rcbButtons.forEach(b => {
          const sel = b.dataset.rcb === value;
          b.style.background = sel ? '#fff' : 'transparent';
          b.style.color = sel ? '#000' : '#fff';
        });
        log(' rightClickBlockMode →', value);
      });
    });

    // Multichat-overlay (lite mode) toggle — lives in ui_settings (chrome.storage.sync),
    // NOT the local extension settings, so it needs its own read/write path. Active =
    // overlay on; off = lite mode. Mirrors the popup's toggle so they stay in lockstep.
    const overlayToggle = grid.querySelector('[data-overlay-toggle]');
    overlayToggle?.addEventListener('click', async () => {
      try {
        const d = await chrome.storage.sync.get('ui_settings');
        const ui = d.ui_settings || {};
        const turningOn = ui.multichatOverlayEnabled === false; // currently lite → turn overlay on
        await chrome.storage.sync.set({ ui_settings: { ...ui, multichatOverlayEnabled: turningOn } });
        overlayToggle.classList.toggle('active', turningOn);
        // Overlay mode needs a reload to inject/remove the panel (matches main.js's
        // own applier). In lite mode the engine's storage listener is skipped, so
        // reload here to guarantee the flip applies. (If the engine listener IS
        // active it'll reload first — idempotent, page just reloads once.)
        setTimeout(() => { try { location.reload() } catch (_) {} }, 150);
      } catch (e) { log(' overlay toggle failed:', e); }
    });
  }

  // Handle button click - toggle panel
  function handleButtonClick(e) {
    e.preventDefault();
    e.stopPropagation();

    if (panelOpen) {
      closePanel();
    } else {
      openPanel();
    }
  }

  // Handle right-click - open heatsync website
  function handleRightClick(e) {
    e.preventDefault();
    window.open('https://heatsync.org', '_blank');
  }

  // Open the panel
  // Flip the picker above/below the button based on available space, then clamp
  // its max-height to the space actually on that side. The emote grid (flex:1,
  // min-height:0) is the only element that shrinks/scrolls, so the tabs/search/
  // footer chrome stays fully visible even on small windows — fewer emotes, full UI.
  function _sizePickerPanel(panel, btn) {
    const r = btn.getBoundingClientRect();
    const spaceAbove = r.top;
    const spaceBelow = window.innerHeight - r.bottom;
    const GAP = 6, MARGIN = 6;
    const showBelow = spaceAbove < 500 && spaceBelow > spaceAbove;
    if (showBelow) {
      panel.style.bottom = 'auto'; panel.style.top = '100%';
      panel.style.marginBottom = '0'; panel.style.marginTop = GAP + 'px';
    } else {
      panel.style.bottom = '100%'; panel.style.top = 'auto';
      panel.style.marginBottom = GAP + 'px'; panel.style.marginTop = '0';
    }
    // Fill the available vertical space — no fixed cap, so a tall window gets a
    // tall picker that reaches (near) the top instead of wasting space above a
    // 500px panel. The grid (flex:1) expands to show more emotes.
    const avail = (showBelow ? spaceBelow : spaceAbove) - GAP - MARGIN;
    panel.style.maxHeight = Math.max(220, avail) + 'px';
  }

  async function openPanel() {
    const btn = document.getElementById(BUTTON_ID);
    if (!btn) return;

    // Hydrate blocked set from background — fire-and-forget so the panel
    // opens instantly even when the SW is cold (this awaited 100s+ of ms after sleep).
    chrome.runtime.sendMessage({ type: 'get_inventory' })
      .then(inv => {
        if (!inv?.blocked) return
        const next = new Set(inv.blocked)
        // Re-render only if the set actually changed and panel is still open
        const same = next.size === _blockedHashSet.size && [...next].every(h => _blockedHashSet.has(h))
        _blockedHashSet = next
        if (!same && panelOpen) renderEmoteGrid()
      })
      .catch(() => {})

    // Check if panel already exists (reuse for cached images)
    let panel = document.getElementById(PANEL_ID);
    const channel = detectChannel();

    if (panel) {
      // Reuse existing panel
      panel.style.display = 'flex';
      panelOpen = true;

      // Smart positioning + viewport-aware sizing (grid shrinks, chrome stays)
      _sizePickerPanel(panel, btn);

      // Only reload if channel changed
      if (channel !== currentChannel) {
        currentChannel = channel;
        await loadChannelEmotes(channel);
        if (currentTab === 'channel') renderEmoteGrid();
      }

      setTimeout(() => {
        document.removeEventListener('click', handleClickOutside);
        document.addEventListener('click', handleClickOutside, { signal: btnSignal });
      }, 10);
      return;
    }

    // Create new panel
    const container = btn.parentElement;
    if (!container) return;

    container.style.position = 'relative';

    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.className = 'heatsync-panel';
    panel.dir = HS_BTN_DIR();

    // Smart positioning + viewport-aware sizing (grid shrinks, chrome stays)
    _sizePickerPanel(panel, btn);

    currentChannel = channel;
    searchQuery = '';
    log(' Panel opened, detected channel:', channel, 'URL:', window.location.pathname);

    const iconUrl = getIconUrl();
    const isLoggedIn = cachedAuthToken !== null;

    panel.innerHTML = `
      <div class="heatsync-panel-header">
        <div class="heatsync-panel-title">
          ${iconUrl ? `<img src="${iconUrl}" alt="heatsync">` : '🔥'}
          <span>heatsync</span>
        </div>
        <button class="heatsync-panel-close" aria-label="Close">✕</button>
      </div>
      ${!isLoggedIn ? `
      <div class="heatsync-auth-banner">
        <span>🔑</span>
        <span><a href="https://heatsync.org/api/auth/login?return_to=%2F" target="_blank">${t('btn_auth_login')}</a> ${t('btn_auth_save_emotes')}</span>
      </div>
      ` : ''}
      <div class="hs-top-search">
        <input type="text" id="heatsync-search" placeholder="search emotes…" autocomplete="off">
        <div class="hs-src-chips" id="hs-src-chips" title="toggle which providers to search">
          <button class="hs-src-chip ${pickerSources.has('7tv') ? 'active' : ''}" data-src="7tv" title="include 7TV results">7tv</button>
          <button class="hs-src-chip ${pickerSources.has('bttv') ? 'active' : ''}" data-src="bttv" title="include BetterTTV results">bttv</button>
          <button class="hs-src-chip ${pickerSources.has('ffz') ? 'active' : ''}" data-src="ffz" title="include FrankerFaceZ results">ffz</button>
        </div>
      </div>
      <div class="heatsync-panel-content">
        <div class="heatsync-tabs">
          <button class="heatsync-tab active" data-tab="channel">
            ${t('btn_tab_channel')}<span class="heatsync-tab-count" id="count-channel">...</span>
          </button>
          <button class="heatsync-tab" data-tab="global">
            ${t('btn_tab_global')}<span class="heatsync-tab-count" id="count-global">...</span>
          </button>
          <button class="heatsync-tab" data-tab="mine">
            ${t('btn_tab_mine')}<span class="heatsync-tab-count" id="count-mine">...</span>
          </button>
          <button class="heatsync-tab" data-tab="sets">
            ${t('btn_tab_sets') || 'sets'}<span class="heatsync-tab-count" id="count-sets">...</span>
          </button>
          <button class="heatsync-tab" data-tab="history">
            history<span class="heatsync-tab-count" id="count-history">...</span>
          </button>
          <button class="heatsync-tab" data-tab="emoji">
            ${t('btn_tab_emoji')}<span class="heatsync-tab-count" id="count-emoji">...</span>
          </button>
        </div>
        <div class="heatsync-emote-grid" id="heatsync-emote-grid">
          <div class="heatsync-empty">${t('common_loading')}</div>
        </div>
      </div>
      <div class="heatsync-panel-bottom">
        <div class="heatsync-panel-footer">
          <div class="heatsync-size-buttons">
            <button class="heatsync-size-btn" data-size="1x">${t('btn_size_1x')}</button>
            <button class="heatsync-size-btn" data-size="2x">${t('btn_size_2x')}</button>
            <button class="heatsync-size-btn active" data-size="4x">${t('btn_size_4x')}</button>
          </div>
          <div style="display:flex;gap:4px;align-items:center;">
            <button class="heatsync-settings-cog" id="heatsync-undo-btn" title="Undo" disabled>
              <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z"/></svg>
            </button>
            <button class="heatsync-settings-cog" id="heatsync-redo-btn" title="Redo" disabled>
              <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M18.4 10.6C16.55 8.99 14.15 8 11.5 8c-4.65 0-8.58 3.03-9.96 7.22L3.9 16c1.05-3.19 4.05-5.5 7.6-5.5 1.95 0 3.73.72 5.12 1.88L13 16h9V7l-3.6 3.6z"/></svg>
            </button>
            <button class="heatsync-settings-cog" id="heatsync-rotate-btn" title="${t('btn_rotate_title')}">
              <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M7.11 8.53L5.7 7.11C4.8 8.27 4.24 9.61 4.07 11h2.02c.14-.87.49-1.72 1.02-2.47zM6.09 13H4.07c.17 1.39.72 2.73 1.62 3.89l1.41-1.42c-.52-.75-.88-1.6-1.01-2.47zM7.1 18.32c1.16.9 2.51 1.44 3.9 1.61V17.9c-.87-.15-1.71-.49-2.46-1.03L7.1 18.32zM13 4.07V1l-4 4 4 4V6.09c2.84.48 5 2.94 5 5.91s-2.16 5.43-5 5.91v2.02c3.95-.49 7-3.85 7-7.93s-3.05-7.44-7-7.93z"/></svg>
            </button>
            <button class="heatsync-settings-cog" id="heatsync-rotate-chat-btn" title="rotate chat panel (C)" style="font-weight:700;font-size:13px;font-family:monospace;">C</button>
            <button class="heatsync-settings-cog" id="heatsync-settings-btn" title="${t('btn_settings_title')}">
              <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>
            </button>
          </div>
        </div>
      </div>
    `;

    container.appendChild(panel);
    panelOpen = true;

    // Close button handler
    panel.querySelector('.heatsync-panel-close')?.addEventListener('click', closePanel);

    // Size buttons handler
    const grid = document.getElementById('heatsync-emote-grid');
    let currentSize = localStorage.getItem('heatsync-emote-size') || '1x';
    grid.classList.add(`size-${currentSize}`);

    // Set initial active state on correct button
    panel.querySelectorAll('.heatsync-size-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.size === currentSize);
    });

    panel.querySelectorAll('.heatsync-size-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        currentSize = btn.dataset.size;
        grid.classList.remove('size-1x', 'size-2x', 'size-4x');
        grid.classList.add(`size-${currentSize}`);
        panel.querySelectorAll('.heatsync-size-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        localStorage.setItem('heatsync-emote-size', currentSize);
        // Re-render to load appropriate resolution images
        if (currentTab !== 'settings') {
          renderEmoteGrid();
        }
      });
    });

    // Settings button handler (in header)
    const settingsBtn = panel.querySelector('#heatsync-settings-btn');
    settingsBtn?.addEventListener('click', () => {
      // Toggle settings view
      if (currentTab === 'settings') {
        // Go back to previous tab (default to channel)
        currentTab = 'channel';
        panel.querySelectorAll('.heatsync-tab').forEach(t => t.classList.remove('active'));
        panel.querySelector('.heatsync-tab[data-tab="channel"]')?.classList.add('active');
        settingsBtn?.classList.remove('active');
        renderEmoteGrid();
      } else {
        currentTab = 'settings';
        panel.querySelectorAll('.heatsync-tab').forEach(t => t.classList.remove('active'));
        settingsBtn?.classList.add('active');
        renderSettings();
      }
    });

    // Undo/redo buttons
    const undoBtn = panel.querySelector('#heatsync-undo-btn')
    const redoBtn = panel.querySelector('#heatsync-redo-btn')

    async function fetchHistoryStatus() {
      try {
        const resp = await chrome.runtime.sendMessage({
          type: 'api_fetch',
          path: '/api/user/emotes/history-status',
          method: 'GET',
          auth: true
        })
        if (!resp || resp.ok === false) return
        const data = resp.data || resp
        if (undoBtn) undoBtn.disabled = !data.canUndo
        if (redoBtn) redoBtn.disabled = !data.canRedo
      } catch (_) {}
    }

    function flashErr(btn) {
      btn.classList.add('hs-flash-err')
      setTimeout(() => btn.classList.remove('hs-flash-err'), 800)
    }

    async function doUndoRedo(path, btn) {
      const wasUndoDisabled = undoBtn.disabled
      const wasRedoDisabled = redoBtn.disabled
      undoBtn.disabled = true
      redoBtn.disabled = true
      try {
        const resp = await chrome.runtime.sendMessage({
          type: 'api_fetch',
          path,
          method: 'POST',
          auth: true
        })
        if (!resp || resp.ok === false) {
          flashErr(btn)
          undoBtn.disabled = wasUndoDisabled
          redoBtn.disabled = wasRedoDisabled
          return
        }
        await loadInventoryEmotes()
        await fetchHistoryStatus()
        renderEmoteGrid()
      } catch (_) {
        flashErr(btn)
        undoBtn.disabled = wasUndoDisabled
        redoBtn.disabled = wasRedoDisabled
      }
    }

    undoBtn?.addEventListener('click', () => doUndoRedo('/api/user/emotes/undo', undoBtn))
    redoBtn?.addEventListener('click', () => doUndoRedo('/api/user/emotes/redo', redoBtn))

    // Fetch initial history state
    fetchHistoryStatus()

    // Rotate tab position button (T) — fallback path that works even when
    // the chat-tabbar is not reachable (extreme drag, weird layout state).
    const rotateBtn = panel.querySelector('#heatsync-rotate-btn');
    rotateBtn?.addEventListener('click', () => {
      window.postMessage({ type: 'heatsync-rotate-tabs' }, location.origin);
    });

    // Rotate chat panel position button (C) — same fallback purpose.
    const rotateChatBtn = panel.querySelector('#heatsync-rotate-chat-btn');
    rotateChatBtn?.addEventListener('click', () => {
      window.postMessage({ type: 'heatsync-rotate-chat' }, location.origin);
    });

    // Lite mode (overlay off) has no tab bar or chat panel to rotate — these two
    // controls are dead there, so hide them when the multichat overlay is disabled.
    if (cachedSettings.multichatOverlayEnabled === false) {
      rotateBtn?.style.setProperty('display', 'none', 'important');
      rotateChatBtn?.style.setProperty('display', 'none', 'important');
    }

    // Tab handlers
    panel.querySelectorAll('.heatsync-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        currentTab = tab.dataset.tab;
        focusedEmoteIndex = -1;
        // Clear search input when switching to tabs that don't use searchQuery
        // (sets/history have their own pickers). The "all" tab (data-tab=discover)
        // uses the shared search bar to drive server-side emote search.
        if (['sets', 'history'].includes(currentTab)) {
          const si = panel.querySelector('#heatsync-search');
          if (si && si.value) { si.value = ''; searchQuery = ''; }
        }
        panel.querySelectorAll('.heatsync-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        settingsBtn.classList.remove('active');
        renderEmoteGrid();
      });
    });

    // Search handler. Local matches are filtered instantly; external providers
    // (7tv/bttv/ffz) hit their public APIs in parallel via triggerProviderSearches.
    let _searchDebounce = null
    const searchInput = panel.querySelector('#heatsync-search');
    const chipsBar = panel.querySelector('#hs-src-chips');
    function updateChipsVisibility() {
      const focused = document.activeElement === searchInput
      const hasValue = searchInput?.value.length > 0
      chipsBar?.classList.toggle('visible', focused || hasValue)
    }
    searchInput?.addEventListener('focus', updateChipsVisibility);
    searchInput?.addEventListener('blur', () => {
      // Defer so a chip click (which blurs the input) keeps the bar visible
      // long enough to process. updateChipsVisibility re-evaluates: if value
      // is non-empty the bar stays.
      setTimeout(updateChipsVisibility, 0)
    });
    // Clicking a chip blurs the input — preventDefault on mousedown keeps focus.
    chipsBar?.addEventListener('mousedown', (e) => {
      if (e.target.closest('.hs-src-chip')) e.preventDefault()
    });
    searchInput?.addEventListener('input', (e) => {
      searchQuery = e.target.value.toLowerCase();
      focusedEmoteIndex = -1;
      updateChipsVisibility();
      clearTimeout(_searchDebounce)
      const q = searchQuery.trim()
      if (q && hasExternalSource()) {
        _searchDebounce = setTimeout(() => triggerProviderSearches(q), 250)
      } else {
        triggerProviderSearches('')
        _searchDebounce = setTimeout(() => renderEmoteGrid(), 150)
      }
    });

    // Source chip handlers — toggle whether each source contributes to search.
    // Provider caches are keyed per-query; toggling a chip back on triggers a
    // fetch only when we don't yet have cached results for the current query.
    panel.querySelectorAll('.hs-src-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const src = chip.dataset.src
        if (pickerSources.has(src)) pickerSources.delete(src)
        else pickerSources.add(src)
        chip.classList.toggle('active', pickerSources.has(src))
        saveSources()
        const q = searchQuery.trim()
        if (!q) { renderEmoteGrid(); return }
        if (hasExternalSource()) triggerProviderSearches(q)
        else { triggerProviderSearches(''); renderEmoteGrid() }
      })
    });

    // Close on click outside
    setTimeout(() => {
      document.removeEventListener('click', handleClickOutside);
      document.addEventListener('click', handleClickOutside, { signal: btnSignal });
    }, 10);

    // Retry event listener for error states
    window.addEventListener('heatsync-retry', async (e) => {
      const tab = e.detail;
      log(' Retrying load for tab:', tab);
      if (tab === 'channel') {
        await loadChannelEmotes(currentChannel);
      } else if (tab === 'global') {
        await loadGlobalEmotes();
      } else if (tab === 'mine' || tab === 'inventory') {
        await loadInventoryEmotes();
      } else if (tab === 'sets') {
        setsLoaded = false
        loadErrors.sets = null
        await loadSets();
      } else if (tab === 'history') {
        historyLoaded = false
        loadErrors.history = null
        await loadHistory();
      }
      renderEmoteGrid();
    }, { signal: btnSignal });

    // Kick off independent loads — each tab repaints when its data lands.
    // No await: the panel renders the loading state immediately and stale IDB data
    // (if any) paints inside loadAllEmotesFromBackground.
    currentTab = 'channel';
    loadAllEmotesFromBackground(channel);
    // Set emoji count (synchronous, no fetch)
    if (typeof EMOJI_DATA !== 'undefined') {
      const countEl = document.getElementById('count-emoji')
      if (countEl) countEl.textContent = EMOJI_DATA.length
    }
    renderEmoteGrid();

    // Auto-focus the search bar — top search is the primary entry point.
    setTimeout(() => panel.querySelector('#heatsync-search')?.focus(), 30);
  }

  // Return URL as-is (upgrading causes CORS/ORB issues in content scripts)
  function getAnimatedUrl(url) {
    return url;
  }

  // Get URL with appropriate resolution for current size setting
  function getResolutionUrl(url, size) {
    if (!url) return url;

    // Fix relative URLs from heatsync API
    if (url.startsWith('/')) {
      url = 'https://heatsync.org' + url;
    }

    // Map size to resolution multiplier
    const resMap = { '1x': '1', '2x': '2', '4x': '4' };
    const res = resMap[size] || '1';

    // BTTV: /1x.webp -> /2x.webp or /3x.webp (max 3x)
    if (url.includes('cdn.betterttv.net')) {
      const bttvRes = res === '4' ? '3' : res;
      return url.replace(/\/[1-3]x\./, `/${bttvRes}x.`);
    }

    // 7TV: /1x.webp -> /2x.webp, /3x.webp, /4x.webp
    if (url.includes('cdn.7tv.app')) {
      return url.replace(/\/[1-4]x\./, `/${res}x.`);
    }

    // FFZ: /1 -> /2 or /4
    if (url.includes('cdn.frankerfacez.com')) {
      return url.replace(/\/emote\/(\d+)\/[124]$/, `/emote/$1/${res}`);
    }

    // Twitch: /1.0 -> /2.0 or /3.0 (max 3.0)
    if (url.includes('static-cdn.jtvnw.net')) {
      const twitchRes = res === '4' ? '3' : res;
      return url.replace(/\/[123]\.0$/, `/${twitchRes}.0`);
    }

    return url;
  }

  // Picker-specific URL: animate by default to match Twitch/Discord/7TV's
  // own pickers. IntersectionObserver below already viewport-gates loads, so
  // the perf hit is bounded. (Prior behaviour silently swapped animated 7TV
  // emotes to _static.webp — saved bandwidth but contradicted user
  // expectation.) Hover-preview still bumps to 4x animated unchanged.
  function pickerUrlFor(e, size) {
    return getResolutionUrl(getAnimatedUrl(e.url), size)
  }

  // Render the emote grid based on current tab and search
  let renderBatchTimeout = null;

  // Check if emote is in user's inventory
  function isInInventory(emote) {
    if (!inventoryEmotesCache || inventoryEmotesCache.length === 0) return false
    return _inventoryNames.has(emote.name) ||
      (emote.hash && _inventoryHashes.has(emote.hash)) ||
      (emote.id && _inventoryIds.has(emote.id))
  }

  // Get provider class name
  function getProviderClass(provider) {
    if (!provider) return 'provider-unknown';
    const p = provider.toLowerCase();
    if (p.includes('7tv') || p === 'seventv') return 'provider-7tv';
    if (p.includes('bttv') || p === 'betterttv') return 'provider-bttv';
    if (p.includes('ffz') || p === 'frankerfacez') return 'provider-ffz';
    return 'provider-unknown';
  }

  // One-click "import all of a channel's 7TV/BTTV/FFZ emotes into your set".
  // Shared by the channel-tab bar and the empty-inventory cold-start CTA.
  async function hsImportChannel(btn, channel, label, onSuccess) {
    btn.disabled = true
    btn.textContent = 'importing…'
    const reset = () => { btn.textContent = label; btn.style.borderColor = ''; btn.style.color = ''; btn.disabled = false }
    const fail = (msg) => { btn.textContent = msg || 'failed'; btn.style.borderColor = '#ff4444'; btn.style.color = '#ff4444'; setTimeout(reset, 2000) }
    try {
      const platform = window.heatsyncPlatform?.detectPlatform() || 'twitch'
      const resp = await chrome.runtime.sendMessage({
        type: 'api_fetch',
        path: '/api/user/emotes/import-channel',
        method: 'POST',
        auth: true,
        body: { channel, platform }
      })
      if (resp && resp.ok !== false) {
        const n = resp.data?.imported ?? resp.imported ?? resp.data?.count ?? '?'
        btn.textContent = `imported ${n}`
        btn.style.borderColor = '#00cc66'
        btn.style.color = '#00cc66'
        await loadInventoryEmotes()
        fetchHistoryStatus()
        if (onSuccess) onSuccess(n)
        else setTimeout(reset, 2000)
      } else {
        fail(resp?.error)
      }
    } catch (err) {
      fail()
    }
  }

  // Empty-inventory cold-start: the moment a logged-in user's set is empty, point
  // them straight at the one-click channel import (the feature already exists, it
  // was just unsurfaced) instead of a dead-end "no emotes" message.
  function renderInventoryColdStart(grid) {
    grid.innerHTML = ''
    const wrap = document.createElement('div')
    wrap.className = 'hs-coldstart'
    wrap.innerHTML = `<div class="hs-coldstart-title">your emotes, in every chat</div>`
    const sub = document.createElement('div')
    sub.className = 'hs-coldstart-sub'
    if (!currentChannel) {
      sub.textContent = 'open any twitch, kick or youtube stream, then import its emotes from the channel tab — one click, works in every chat.'
      wrap.appendChild(sub)
      grid.appendChild(wrap)
      return
    }
    sub.textContent = `pull every 7tv, bttv & ffz emote from ${currentChannel} into your set — one click, renders in every chat.`
    const btn = document.createElement('button')
    btn.className = 'hs-import-channel-btn'
    const label = `import all of ${currentChannel}'s emotes`
    btn.textContent = label
    btn.addEventListener('click', () => hsImportChannel(btn, currentChannel, label, () => renderEmoteGrid()))
    wrap.appendChild(sub)
    wrap.appendChild(btn)
    grid.appendChild(wrap)
  }

  function renderEmoteGrid(opts) {
    const grid = document.getElementById('heatsync-emote-grid');
    if (!grid) return;

    // Save scrollTop when this render is triggered by a background broadcast
    // (progressive channel_emotes_update arrivals). Without this the user gets
    // teleported to the top mid-scroll because clearing the grid shrinks its
    // scrollHeight to ~0 and the browser clamps scrollTop to 0. User-initiated
    // re-renders (tab switch, search) pass no opts so scroll resets normally.
    const preserveScroll = !!(opts && opts.preserveScroll)
    const savedScrollTop = preserveScroll ? grid.scrollTop : 0

    // Check login state
    const isLoggedIn = cachedAuthToken !== null;

    // Check for errors first
    const currentError = loadErrors[currentTab];
    const currentLoading = isLoading[currentTab];
    const isCached = usingCachedData[currentTab];

    if (currentError && !currentLoading) {
      _virtualPickerEmotes = []
      _virtualRecentCount = 0
      grid.innerHTML = `
        <div class="heatsync-error-state">
          <div class="heatsync-error-icon">⚠️</div>
          <div class="heatsync-error-msg">${escapeHtml(currentError)}</div>
          <button class="heatsync-retry-btn" onclick="window.dispatchEvent(new CustomEvent('heatsync-retry', {detail: '${escapeHtml(currentTab)}'}))">
            ${t('common_retry')}
          </button>
        </div>
      `;
      return;
    }

    if (currentLoading) {
      _virtualPickerEmotes = []
      _virtualRecentCount = 0
      grid.innerHTML = `<div class="heatsync-empty">${t('common_loading')}</div>`;
      return;
    }

    // Top search bar takes over whenever there's a query — across every tab.
    // Unified results from enabled source chips (here / 7tv / bttv / ffz).
    // Clear the search to return to per-tab browsing.
    if (searchQuery) {
      _virtualPickerEmotes = []
      _virtualRecentCount = 0
      renderSearchResults(grid, isLoggedIn)
      return
    }

    if (currentTab === 'sets') {
      _virtualPickerEmotes = []
      _virtualRecentCount = 0
      renderSetsList(grid, isLoggedIn)
      return
    }

    if (currentTab === 'history') {
      _virtualPickerEmotes = []
      _virtualRecentCount = 0
      renderHistoryList(grid, isLoggedIn)
      return
    }

    let emotes = [];
    if (currentTab === 'channel') {
      emotes = channelEmotesCache;
    } else if (currentTab === 'global') {
      // Channel emotes shadow globals — same name in both means channel wins.
      // Hide from the global tab so users find it under "channel".
      const channelNames = new Set(channelEmotesCache.map(e => e.name))
      emotes = globalEmotesCache.filter(e => !channelNames.has(e.name))
    } else if (currentTab === 'mine') {
      emotes = inventoryEmotesCache;
    } else if (currentTab === 'emoji') {
      // Use EMOJI_DATA from emoji-data.js
      if (typeof EMOJI_DATA !== 'undefined') {
        emotes = EMOJI_DATA.map(e => ({
          name: e.name,
          emoji: e.emoji,
          category: e.category,
          url: null,
          isEmoji: true
        }))
      }
    }

    // Filter by search (fuzzy matching)
    if (searchQuery) {
      emotes = emotes
        .map(e => ({ ...e, _score: fuzzyScore(searchQuery, e.name) }))
        .filter(e => e._score > 0)
        .sort((a, b) => b._score - a._score)
    }

    if (emotes.length === 0) {
      _virtualPickerEmotes = []
      _virtualRecentCount = 0
      if (currentTab === 'mine' && !isLoggedIn) {
        grid.innerHTML = `<div class="heatsync-login-msg">${t('btn_login_save_emotes')}</div>`;
      } else if (currentTab === 'mine' && isLoggedIn && !searchQuery) {
        // genuinely-empty inventory (not a no-match search) → cold-start CTA
        renderInventoryColdStart(grid)
      } else {
        grid.innerHTML = `<div class="heatsync-empty">${t('btn_no_emotes')}</div>`;
      }
      return;
    }

    // Show cached badge if using stale data
    if (isCached) {
      const countEl = document.getElementById(`count-${currentTab}`);
      if (countEl && !countEl.querySelector('.heatsync-cached-badge')) {
        countEl.innerHTML += `<span class="heatsync-cached-badge">${t('btn_cached')}</span>`;
      }
    }

    // Get current size for resolution
    const currentSize = localStorage.getItem('heatsync-emote-size') || '1x';

    // Prepare emotes with resolution-appropriate URLs.
    // For animated 7TV emotes use the static-frame variant in the picker —
    // it's ~15× smaller (e.g. RainTime: 13.6KB animated vs 0.9KB static)
    // and decodes a single frame instead of 15. Hover preview still uses
    // the animated 4x for recognition.
    const pickerEmotes = emotes.map(e => ({
      ...e,
      pickerUrl: pickerUrlFor(e, currentSize)
    }));

    while (grid.firstChild) grid.removeChild(grid.firstChild)

    // Import-channel bar (channel tab only, logged-in users)
    if (currentTab === 'channel' && isLoggedIn && currentChannel) {
      const bar = document.createElement('div')
      bar.className = 'hs-import-channel-bar'
      const importBtn = document.createElement('button')
      importBtn.className = 'hs-import-channel-btn'
      importBtn.textContent = 'import all channel emotes'
      importBtn.addEventListener('click', () => hsImportChannel(importBtn, currentChannel, 'import all channel emotes'))
      bar.appendChild(importBtn)
      grid.appendChild(bar)
    }

    // --- Virtual scroll helpers ---
    const GAP = 4
    const sizeMap = { '1x': 32, '2x': 56, '4x': 112 }
    const emoteSize = sizeMap[currentSize] || 32
    const gridPadding = 8 // padding on .heatsync-emote-grid

    function getItemsPerRow() {
      const gridWidth = grid.clientWidth - gridPadding * 2
      return Math.max(1, Math.floor((gridWidth + GAP) / (emoteSize + GAP)))
    }

    // Lazy image loader — only assigns src when the <img> intersects the
    // visible viewport. Native `loading="lazy"` is unreliable inside a
    // nested scroll container; an explicit IntersectionObserver rooted on
    // the grid itself is bulletproof. The 96px rootMargin gives a small
    // preload window so images fade in before they're visually in frame.
    if (grid._hsImgObserver) grid._hsImgObserver.disconnect()
    const imgObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const img = entry.target
        const src = img.dataset.src
        if (src && !img.src) img.src = src
        imgObserver.unobserve(img)
      }
    }, { root: grid, rootMargin: '96px 0px', threshold: 0 })
    grid._hsImgObserver = imgObserver
    function observeImg(wrap) {
      const img = wrap.querySelector('img')
      if (img && img.dataset.src) imgObserver.observe(img)
    }

    // Create emote element — no click/contextmenu listeners (delegated on grid)
    function createEmoteElement(e, index) {
      const wrap = document.createElement('div')
      const providerClass = getProviderClass(e.provider)
      const inInventory = isInInventory(e)
      const isGlobal = currentTab === 'global'

      wrap.className = `heatsync-emote-wrap ${providerClass}`
      wrap.style.minWidth = '32px'
      wrap.style.minHeight = '32px'
      wrap.dataset.index = index

      // 2-state model: no `unadded` class. Every pasteable emote looks the
       // same; the inventory/non-inventory split is no longer a render
       // distinction (auto-add-on-send fills slots silently anyway).

      // Mark blocked: keeps the emote in its slot with the dashed-outline style
      // (CSS at .heatsync-emote-wrap.blocked img). Without this, blockEmote
      // filtered the cache and surrounding emotes shifted into the empty slot.
      const _hash = e.hash || e.id || (e.url ? btoa(e.url || e.pickerUrl || '').slice(0, 24) : null)
      if (_hash && _blockedHashSet.has(_hash)) {
        wrap.classList.add('blocked')
        wrap.dataset.blockedHash = _hash
      }

      // Hover preview — must be per-element for positioning
      let previewTooltip = null
      wrap.addEventListener('mouseenter', () => {
        previewTooltip = document.createElement('div')
        previewTooltip.className = 'heatsync-emote-hover-preview'

        if (e.isEmoji) {
          const emojiPreview = document.createElement('span')
          emojiPreview.className = 'heatsync-emoji-preview'
          emojiPreview.textContent = e.emoji
          emojiPreview.style.fontSize = '48px'
          emojiPreview.style.lineHeight = '1'

          const nameLabel = document.createElement('div')
          nameLabel.className = 'heatsync-emote-hover-preview-name'
          nameLabel.textContent = `:${e.name}:`

          previewTooltip.appendChild(emojiPreview)
          previewTooltip.appendChild(nameLabel)
          document.body.appendChild(previewTooltip)

          const rect = wrap.getBoundingClientRect()
          const tooltipRect = previewTooltip.getBoundingClientRect()
          let left = rect.left + (rect.width / 2) - (tooltipRect.width / 2)
          let top = rect.top - tooltipRect.height - 8
          if (left < 8) left = 8
          if (left + tooltipRect.width > window.innerWidth - 8) left = window.innerWidth - tooltipRect.width - 8
          if (top < 8) top = rect.bottom + 8
          previewTooltip.style.left = `${left}px`
          previewTooltip.style.top = `${top}px`
          return
        }

        const previewImg = document.createElement('img')
        previewImg.referrerPolicy = 'no-referrer'
        const previewUrl = safeUrl(getResolutionUrl(getAnimatedUrl(e.url), '4x'))
        if (previewUrl) previewImg.src = previewUrl
        previewImg.alt = e.name

        const nameLabel = document.createElement('div')
        nameLabel.className = 'heatsync-emote-hover-preview-name'
        nameLabel.textContent = e.name

        previewTooltip.appendChild(previewImg)
        previewTooltip.appendChild(nameLabel)
        document.body.appendChild(previewTooltip)

        previewImg.onload = () => {
          if (!previewTooltip?.isConnected) return
          const rect = wrap.getBoundingClientRect()
          const tooltipRect = previewTooltip.getBoundingClientRect()
          let left = rect.left + (rect.width / 2) - (tooltipRect.width / 2)
          let top = rect.top - tooltipRect.height - 8
          const padding = 8
          if (left < padding) left = padding
          else if (left + tooltipRect.width > window.innerWidth - padding) left = window.innerWidth - tooltipRect.width - padding
          if (top < padding) top = rect.bottom + 8
          previewTooltip.style.left = `${left}px`
          previewTooltip.style.top = `${top}px`
        }

        const rect = wrap.getBoundingClientRect()
        previewTooltip.style.left = `${rect.left}px`
        previewTooltip.style.top = `${rect.top - 20}px`
      })

      wrap.addEventListener('mouseleave', () => {
        if (previewTooltip && previewTooltip.parentNode) {
          previewTooltip.remove()
          previewTooltip = null
        }
      })

      return wrap
    }

    function appendEmoteContent(wrap, e) {
      if (e.isEmoji) {
        const emojiSpan = document.createElement('span')
        emojiSpan.className = 'heatsync-emoji-cell'
        emojiSpan.textContent = e.emoji
        emojiSpan.title = `:${e.name}:`
        wrap.appendChild(emojiSpan)
      } else {
        const img = document.createElement('img')
        img.referrerPolicy = 'no-referrer'
        img.decoding = 'async'
        // Defer src until the emote actually intersects the visible viewport.
        // Without this, mounting the ±4 buffer rows fires ~150 simultaneous
        // image requests — and 7TV's CDN serves animated webp at 1x that's
        // both slower to fetch and slower to decode, jamming the pipeline.
        // The IntersectionObserver below promotes data-src → src on intersect.
        const url = safeUrl(e.pickerUrl) || ''
        img.dataset.src = url
        // One-shot fallback for 7TV _static.webp 404s (e.g. metadata wrongly
        // flags a static-source emote as animated). Retry the non-static URL.
        if (url.includes('cdn.7tv.app') && url.includes('_static.webp')) {
          img.addEventListener('error', () => {
            const fallback = url.replace('_static.webp', '.webp')
            if (img.src !== fallback) img.src = fallback
          }, { once: true })
        }
        img.alt = e.name
        img.title = e.name
        wrap.appendChild(img)
      }
    }

    // Store emotes for event delegation
    _virtualPickerEmotes = pickerEmotes

    // --- Set up event delegation on grid (once) ---
    if (!_virtualGridDelegated) {
      _virtualGridDelegated = true

      // Click delegation
      grid.addEventListener('click', (evt) => {
        const wrap = evt.target.closest('.heatsync-emote-wrap')
        if (!wrap) return
        const idx = parseInt(wrap.dataset.index, 10)
        if (isNaN(idx)) return

        // Determine which emote list this index refers to
        let e
        if (idx < _virtualRecentCount) {
          e = recentEmotes[idx]
          if (!e) return
          e = { ...e, pickerUrl: e.url ? getResolutionUrl(getAnimatedUrl(e.url), localStorage.getItem('heatsync-emote-size') || '1x') : null }
        } else {
          e = _virtualPickerEmotes[idx - _virtualRecentCount]
          if (!e) return
        }

        const inInventory = isInInventory(e)
        const isGlobal = currentTab === 'global'
        const isLoggedIn = cachedAuthToken !== null
        recordRecentEmote(e)
        if (e.isEmoji) {
          insertEmoteIntoChat(`:${e.name}:`)
        } else if (!isGlobal && !inInventory && isLoggedIn && currentTab !== 'mine') {
          addEmoteToInventorySilent(e).then(() => insertEmoteIntoChat(e.name)).catch(() => insertEmoteIntoChat(e.name))
        } else {
          insertEmoteIntoChat(e.name)
        }
      })

      // Context menu delegation — branches on rightClickBlockMode:
      //   'menu'    → existing block/cancel popup (default)
      //   'instant' → block immediately, no menu
      //   'off'     → preventDefault, do nothing (no native browser menu either)
      grid.addEventListener('contextmenu', (evt) => {
        const wrap = evt.target.closest('.heatsync-emote-wrap')
        if (!wrap) return
        const idx = parseInt(wrap.dataset.index, 10)
        if (isNaN(idx)) return

        let e
        if (idx < _virtualRecentCount) {
          e = recentEmotes[idx]
          if (!e) return
        } else {
          e = _virtualPickerEmotes[idx - _virtualRecentCount]
          if (!e) return
        }

        const mode = (cachedSettings.rightClickBlockMode || 'instant')
        if (mode === 'off') {
          evt.preventDefault()
          return
        }
        if (mode === 'instant' && currentTab !== 'mine') {
          evt.preventDefault()
          const hash = e.hash || e.id || btoa(e.url || e.pickerUrl || '').slice(0, 24)
          if (_blockedHashSet.has(hash)) {
            chrome.runtime.sendMessage({ type: 'unblock_emote', hash })
              .then(result => {
                if (result?.success) {
                  _blockedHashSet.delete(hash); renderEmoteGrid(); showPickerToast(t('btn_toast_unblocked'))
                } else {
                  showPickerToast(result?.error || 'unblock failed')
                }
              })
              .catch(err => log('Unblock failed:', err.message))
          } else {
            blockEmote(e)
            showPickerToast(t('btn_toast_blocked'))
          }
          return
        }
        showContextMenu(evt, e, currentTab)
      })
    }

    // --- Recent emotes section (non-virtualized, always small) ---
    const recentContainer = document.createElement('div')
    recentContainer.className = 'heatsync-recent-section'
    recentContainer.style.cssText = 'display: flex; flex-wrap: wrap; gap: 4px; align-content: start;'
    let globalIndex = 0
    _virtualRecentCount = 0

    if (!searchQuery && recentEmotes.length > 0 && (currentTab === 'channel' || currentTab === 'global' || currentTab === 'mine')) {
      const header = document.createElement('div')
      header.className = 'heatsync-section-header'
      header.textContent = t('btn_recent') || 'recent'
      header.style.cssText = 'width: 100%; font-size: 11px; color: #808080; padding: 2px 4px; margin-bottom: 2px;'
      recentContainer.appendChild(header)

      for (const r of recentEmotes) {
        const recentEmote = { ...r, pickerUrl: r.url ? getResolutionUrl(getAnimatedUrl(r.url), currentSize) : null }
        const wrap = createEmoteElement(recentEmote, globalIndex)
        appendEmoteContent(wrap, recentEmote)
        recentContainer.appendChild(wrap)
        observeImg(wrap)
        globalIndex++
      }
      _virtualRecentCount = recentEmotes.length

      const divider = document.createElement('div')
      divider.style.cssText = 'width: 100%; border-top: 1px solid #333; margin: 4px 0;'
      recentContainer.appendChild(divider)
    }

    grid.appendChild(recentContainer)

    // --- Virtual scroll container for main emotes ---
    let itemsPerRow = getItemsPerRow()
    let totalRows = Math.ceil(pickerEmotes.length / itemsPerRow)
    const rowHeight = emoteSize + GAP
    let totalHeight = totalRows * rowHeight

    const virtualContainer = document.createElement('div')
    virtualContainer.className = 'heatsync-virtual-container'
    virtualContainer.style.cssText = `position: relative; width: 100%; height: ${totalHeight}px;`
    grid.appendChild(virtualContainer)

    // Incremental rendering: keep a Map<emoteIndex, HTMLElement> of currently
    // mounted wraps. On scroll, only ADD new rows entering the viewport and
    // REMOVE rows leaving it — never touch elements that stay visible.
    // Recreating <img> nodes triggers re-decode and visible "unloaded" flicker
    // even on HTTP cache hits, which was the symptom the user saw.
    const mounted = new Map()
    let _renderedItemsPerRow = itemsPerRow
    // Wider buffer than before (was ±2). 4 rows of slack means small scrolls
    // (mouse wheel ticks) usually don't trigger any DOM mutation at all.
    const BUFFER_ROWS = 4

    function placeWrap(wrap, i) {
      const row = Math.floor(i / itemsPerRow)
      const col = i % itemsPerRow
      wrap.style.position = 'absolute'
      wrap.style.top = `${row * rowHeight}px`
      wrap.style.left = `${col * (emoteSize + GAP)}px`
      wrap.style.width = `${emoteSize}px`
      wrap.style.height = `${emoteSize}px`
    }

    function renderVisibleEmotes() {
      // Recompute itemsPerRow lazily — if the panel was resized, all mounted
      // wraps need repositioning. Cheap to detect, only acts when changed.
      const newItemsPerRow = getItemsPerRow()
      if (newItemsPerRow !== _renderedItemsPerRow) {
        itemsPerRow = newItemsPerRow
        _renderedItemsPerRow = newItemsPerRow
        totalRows = Math.ceil(pickerEmotes.length / itemsPerRow)
        totalHeight = totalRows * rowHeight
        virtualContainer.style.height = `${totalHeight}px`
        for (const [i, wrap] of mounted) placeWrap(wrap, i)
      }

      const scrollTop = grid.scrollTop - recentContainer.offsetHeight
      const viewHeight = grid.clientHeight
      const clampedScroll = Math.max(0, scrollTop)

      const startRow = Math.max(0, Math.floor(clampedScroll / rowHeight) - BUFFER_ROWS)
      const endRow = Math.min(totalRows, Math.ceil((clampedScroll + viewHeight) / rowHeight) + BUFFER_ROWS)
      const startIdx = startRow * itemsPerRow
      const endIdx = Math.min(endRow * itemsPerRow, pickerEmotes.length)

      // Drop wraps that scrolled out of the buffer window
      for (const [i, wrap] of mounted) {
        if (i < startIdx || i >= endIdx) {
          wrap.remove()
          mounted.delete(i)
        }
      }

      // Add wraps for indices that entered the buffer window
      const newWraps = []
      const fragment = document.createDocumentFragment()
      for (let i = startIdx; i < endIdx; i++) {
        if (mounted.has(i)) continue
        const e = pickerEmotes[i]
        const wrap = createEmoteElement(e, i + _virtualRecentCount)
        placeWrap(wrap, i)
        appendEmoteContent(wrap, e)
        mounted.set(i, wrap)
        fragment.appendChild(wrap)
        newWraps.push(wrap)
      }
      if (fragment.childNodes.length) {
        virtualContainer.appendChild(fragment)
        // Observe AFTER attach so layout is computed and IO can determine intersection
        for (const w of newWraps) observeImg(w)
      }
    }

    // Restore scroll BEFORE the initial render so renderVisibleEmotes mounts
    // the correct buffer window (the one matching what the user was looking at).
    // The browser clamps to the new scrollHeight automatically if the list shrank.
    if (preserveScroll && savedScrollTop > 0) grid.scrollTop = savedScrollTop

    // Initial render
    renderVisibleEmotes()

    // Remove old scroll handler, attach new one
    if (_virtualScrollHandler) {
      grid.removeEventListener('scroll', _virtualScrollHandler)
    }
    let _scrollRaf = 0
    _virtualScrollHandler = () => {
      if (_scrollRaf) return
      _scrollRaf = requestAnimationFrame(() => {
        _scrollRaf = 0
        renderVisibleEmotes()
      })
    }
    grid.addEventListener('scroll', _virtualScrollHandler, { passive: true });
  }

  // ===== Saved Sets =====
  // Render the user's saved emote sets as a list with apply buttons.
  // Uses safe DOM construction (no innerHTML with user content).
  function renderSetsList(grid, isLoggedIn) {
    while (grid.firstChild) grid.removeChild(grid.firstChild)

    if (!isLoggedIn) {
      const msg = document.createElement('div')
      msg.className = 'heatsync-login-msg'
      msg.textContent = t('btn_login_save_emotes')
      grid.appendChild(msg)
      return
    }

    if (!setsLoaded && !isLoading.sets) {
      isLoading.sets = true
      const loadingEl = document.createElement('div')
      loadingEl.className = 'heatsync-empty'
      loadingEl.textContent = t('common_loading')
      grid.appendChild(loadingEl)
      loadSets().finally(() => {
        isLoading.sets = false
        if (currentTab === 'sets') renderEmoteGrid()
      })
      return
    }

    if (loadErrors.sets) {
      const err = document.createElement('div')
      err.className = 'heatsync-empty'
      err.textContent = loadErrors.sets
      grid.appendChild(err)
      return
    }

    if (!savedSetsCache.length) {
      const empty = document.createElement('div')
      empty.className = 'heatsync-empty'
      empty.textContent = 'no saved sets — create one on heatsync.org'
      grid.appendChild(empty)
      return
    }

    // Delegate click once on the grid for the apply-button confirm flow
    if (!grid.dataset.hsSetsDelegated) {
      grid.dataset.hsSetsDelegated = '1'
      grid.addEventListener('click', handleSetApplyClick)
    }

    const list = document.createElement('div')
    list.className = 'heatsync-sets-list'
    for (const s of savedSetsCache) {
      const item = document.createElement('div')
      item.className = 'heatsync-set-item'

      const info = document.createElement('div')
      info.className = 'heatsync-set-info'
      const name = document.createElement('div')
      name.className = 'heatsync-set-name'
      name.textContent = (s.starred ? '★ ' : '') + (s.name || '(unnamed)')
      info.appendChild(name)

      const meta = document.createElement('div')
      meta.className = 'heatsync-set-meta'
      const count = s.emote_count || 0
      let metaText = `${count} ${count === 1 ? 'emote' : 'emotes'}`
      if (s.source_username) metaText += ` · from ${s.source_username}`
      meta.textContent = metaText
      info.appendChild(meta)

      item.appendChild(info)

      const applyBtn = document.createElement('button')
      applyBtn.className = 'heatsync-set-apply-btn'
      applyBtn.type = 'button'
      applyBtn.textContent = 'apply'
      applyBtn.dataset.setId = String(s.id)
      applyBtn.dataset.setName = s.name || '(unnamed)'
      applyBtn.dataset.setCount = String(count)
      item.appendChild(applyBtn)

      list.appendChild(item)
    }
    grid.appendChild(list)
  }

  async function handleSetApplyClick(e) {
    const btn = e.target.closest('.heatsync-set-apply-btn')
    if (!btn) return
    e.stopPropagation()
    if (btn.disabled) return

    if (!btn.classList.contains('confirming')) {
      btn.classList.add('confirming')
      btn.textContent = `replace ${btn.dataset.setCount} emotes?`
      const timer = setTimeout(() => {
        btn.classList.remove('confirming')
        btn.textContent = 'apply'
      }, 4000)
      btn.dataset.confirmTimer = String(timer)
      return
    }

    clearTimeout(parseInt(btn.dataset.confirmTimer || '0'))
    btn.classList.remove('confirming')
    btn.classList.add('applying')
    btn.disabled = true
    btn.textContent = 'applying…'
    const ok = await applySet(btn.dataset.setId)
    if (ok) {
      btn.classList.remove('applying')
      btn.classList.add('applied')
      btn.textContent = 'applied'
      // Show success state for ~1.5s, then refresh the list
      setTimeout(() => {
        if (currentTab === 'sets') renderEmoteGrid()
      }, 1500)
    } else {
      btn.classList.remove('applying')
      btn.classList.add('failed')
      btn.textContent = 'failed'
      setTimeout(() => {
        btn.classList.remove('failed')
        btn.disabled = false
        btn.textContent = 'apply'
      }, 2000)
    }
  }

  async function loadSets() {
    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'api_fetch',
        path: '/api/user/sets',
        method: 'GET',
        auth: true
      })
      if (!resp || resp.ok === false) {
        loadErrors.sets = resp?.error || 'failed to load sets'
        savedSetsCache = []
        return
      }
      const data = resp.data || resp
      savedSetsCache = Array.isArray(data?.sets) ? data.sets : []
      setsLoaded = true
      loadErrors.sets = null
      const countEl = document.getElementById('count-sets')
      if (countEl) countEl.textContent = String(savedSetsCache.length)
    } catch (err) {
      loadErrors.sets = 'failed to load sets'
      savedSetsCache = []
    }
  }

  async function applySet(setId) {
    // NOTE: do NOT call renderEmoteGrid() inside this function — the caller
    // handleSetApplyClick mutates the apply button's classes/text after the
    // promise resolves. Re-rendering here destroys the button before the
    // 'applied' state is shown. Caller is responsible for refresh.
    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'api_fetch',
        path: `/api/user/sets/${encodeURIComponent(setId)}/apply`,
        method: 'POST',
        auth: true
      })
      if (!resp || resp.ok === false) return false
      // Refresh inventory + sets list data (DOM not re-rendered yet)
      await Promise.all([loadInventoryEmotes(), loadSets()])
      return true
    } catch (err) {
      log(' applySet error:', err?.message)
      return false
    }
  }

  // ===== Removed Emotes History =====
  // Render list of removed emotes with inline confirm restore.
  function renderHistoryList(grid, isLoggedIn) {
    while (grid.firstChild) grid.removeChild(grid.firstChild)

    if (!isLoggedIn) {
      const msg = document.createElement('div')
      msg.className = 'heatsync-login-msg'
      msg.textContent = 'log in to view removed emotes'
      grid.appendChild(msg)
      return
    }

    if (!historyLoaded && !isLoading.history) {
      isLoading.history = true
      const loadingEl = document.createElement('div')
      loadingEl.className = 'heatsync-empty'
      loadingEl.textContent = t('common_loading')
      grid.appendChild(loadingEl)
      loadHistory().finally(() => {
        isLoading.history = false
        if (currentTab === 'history') renderEmoteGrid()
      })
      return
    }

    if (loadErrors.history) {
      const err = document.createElement('div')
      err.className = 'heatsync-empty'
      err.textContent = loadErrors.history
      grid.appendChild(err)
      return
    }

    if (!removedEmotesCache.length) {
      const empty = document.createElement('div')
      empty.className = 'heatsync-empty'
      empty.textContent = 'no removed emotes'
      grid.appendChild(empty)
      return
    }

    if (!grid.dataset.hsHistoryDelegated) {
      grid.dataset.hsHistoryDelegated = '1'
      grid.addEventListener('click', handleRestoreClick)
    }

    const list = document.createElement('div')
    list.className = 'heatsync-history-list'
    for (const e of removedEmotesCache) {
      const item = document.createElement('div')
      item.className = 'heatsync-history-item'

      // Server returns custom_name (snake_case) and url which may be relative
      const displayName = e.custom_name || e.name || '(unnamed)'
      const rawUrl = e.url || ''
      const absUrl = rawUrl.startsWith('/') ? `https://heatsync.org${rawUrl}` : rawUrl
      const imgUrl = safeUrl(absUrl)
      if (imgUrl) {
        const img = document.createElement('img')
        img.className = 'heatsync-history-thumb'
        img.src = imgUrl
        img.alt = displayName
        img.loading = 'lazy'
        img.referrerPolicy = 'no-referrer'
        item.appendChild(img)
      }

      const info = document.createElement('div')
      info.className = 'heatsync-history-info'

      const name = document.createElement('div')
      name.className = 'heatsync-history-name'
      name.textContent = displayName
      info.appendChild(name)

      const meta = document.createElement('div')
      meta.className = 'heatsync-history-meta'
      const removedAt = e.removed_at ? new Date(e.removed_at).toLocaleDateString() : ''
      meta.textContent = removedAt ? `removed ${removedAt}` : 'removed'
      info.appendChild(meta)

      item.appendChild(info)

      const restoreBtn = document.createElement('button')
      restoreBtn.className = 'heatsync-restore-btn'
      restoreBtn.type = 'button'
      restoreBtn.textContent = 'restore'
      restoreBtn.dataset.emoteId = String(e.id)
      restoreBtn.dataset.emoteName = displayName
      item.appendChild(restoreBtn)

      list.appendChild(item)
    }
    grid.appendChild(list)
  }

  async function handleRestoreClick(e) {
    const btn = e.target.closest('.heatsync-restore-btn')
    if (!btn) return
    e.stopPropagation()
    if (btn.disabled) return

    if (!btn.classList.contains('confirming')) {
      btn.classList.add('confirming')
      btn.textContent = 'restore?'
      const timer = setTimeout(() => {
        btn.classList.remove('confirming')
        btn.textContent = 'restore'
      }, 4000)
      btn.dataset.confirmTimer = String(timer)
      return
    }

    clearTimeout(parseInt(btn.dataset.confirmTimer || '0'))
    btn.classList.remove('confirming')
    btn.classList.add('restoring')
    btn.disabled = true
    btn.textContent = 'restoring…'
    const ok = await restoreEmote(btn.dataset.emoteId)
    if (ok) {
      btn.classList.remove('restoring')
      btn.classList.add('restored')
      btn.textContent = 'restored'
      // Remove from local cache so it disappears from list
      const id = parseInt(btn.dataset.emoteId)
      removedEmotesCache = removedEmotesCache.filter(x => x.id !== id)
      const countEl = document.getElementById('count-history')
      if (countEl) countEl.textContent = String(removedEmotesCache.length)
      // Refresh inventory so the emote shows up in mine tab
      loadInventoryEmotes()
      fetchHistoryStatus()
    } else {
      btn.classList.remove('restoring')
      btn.classList.add('failed')
      btn.textContent = 'failed'
      setTimeout(() => {
        btn.classList.remove('failed')
        btn.disabled = false
        btn.textContent = 'restore'
      }, 2000)
    }
  }

  async function loadHistory() {
    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'api_fetch',
        path: '/api/user/emotes/removed',
        method: 'GET',
        auth: true
      })
      if (!resp || resp.ok === false) {
        loadErrors.history = resp?.error || 'failed to load history'
        removedEmotesCache = []
        return
      }
      const data = resp.data || resp
      removedEmotesCache = Array.isArray(data?.emotes) ? data.emotes : (Array.isArray(data) ? data : [])
      historyLoaded = true
      loadErrors.history = null
      const countEl = document.getElementById('count-history')
      if (countEl) countEl.textContent = String(removedEmotesCache.length)
    } catch (err) {
      loadErrors.history = 'failed to load history'
      removedEmotesCache = []
    }
  }

  async function restoreEmote(emoteId) {
    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'api_fetch',
        path: `/api/user/emotes/removed/${encodeURIComponent(emoteId)}/restore`,
        method: 'POST',
        auth: true
      })
      return !!(resp && resp.ok !== false)
    } catch (err) {
      log(' restoreEmote error:', err?.message)
      return false
    }
  }

  // Unified search results view. Local (channel + global + mine) matches lead
  // when 'here' is on; provider results (7tv/bttv/ffz) are interleaved by their
  // native popularity ranking from the provider API. Dedupes by name across
  // sources so the same emote doesn't appear twice.
  function renderSearchResults(grid, isLoggedIn) {
    while (grid.firstChild) grid.removeChild(grid.firstChild)


    const q = searchQuery
    const seen = new Set()
    const keyOf = (e) => (e.hash || ('_n_' + (e.name || '').toLowerCase()))
    const localMatches = []

    // Local matches (channel + global + mine) always included — they're what
    // the user can paste right now without a network hop.
    {
      const channelNames = new Set(channelEmotesCache.map(e => e.name))
      const pools = [
        channelEmotesCache,
        globalEmotesCache.filter(e => !channelNames.has(e.name)),
        inventoryEmotesCache,
      ]
      for (const pool of pools) {
        for (const e of pool) {
          const s = fuzzyScore(q, e.name || '')
          if (s <= 0) continue
          const k = keyOf(e)
          if (seen.has(k)) continue
          seen.add(k)
          localMatches.push({ ...e, _score: s, _local: true })
        }
      }
      localMatches.sort((a, b) => b._score - a._score)
    }

    // Provider results — interleaved in chip order (7tv first), each block
    // preserving the provider's native popularity order.
    const providerMatches = []
    for (const p of PROVIDER_NAMES) {
      if (!pickerSources.has(p)) continue
      if (providerLastQuery[p] !== q) continue
      for (const e of providerResults[p]) {
        const k = keyOf(e)
        if (seen.has(k)) continue
        seen.add(k)
        providerMatches.push(e)
      }
    }

    // Heatsync indexed substring matches — fills the gap where provider APIs
    // do prefix-only matching. Filtered by chip so each provider's substring
    // matches respect the chip toggle.
    const hsMatches = []
    if (hsIndexQuery === q && hsIndexResults.length) {
      for (const e of hsIndexResults) {
        const p = (e.provider || '').toLowerCase()
        const tag = p.includes('7tv') || p === 'seventv' ? '7tv'
          : p.includes('bttv') || p === 'betterttv' ? 'bttv'
          : p.includes('ffz') || p === 'frankerfacez' ? 'ffz'
          : 'hs'
        // Skip if the matching chip is off. Uploads/hs ride along whenever any
        // external chip is on so heatsync's own emotes stay searchable.
        if (tag !== 'hs' && !pickerSources.has(tag)) continue
        if (tag === 'hs' && !hasExternalSource()) continue
        const k = keyOf(e)
        if (seen.has(k)) continue
        seen.add(k)
        hsMatches.push(e)
      }
    }

    const combined = localMatches.concat(providerMatches).concat(hsMatches)

    // Header — count + per-provider loading/error indicators
    const meta = document.createElement('div')
    meta.className = 'hs-discover-hint'
    const status = []
    if (localMatches.length) status.push(`${localMatches.length} owned`)
    for (const p of PROVIDER_NAMES) {
      if (!pickerSources.has(p)) continue
      if (providerInFlight[p]) status.push(`${p}: …`)
      else if (providerErrors[p]) status.push(`${p}: err`)
      else if (providerLastQuery[p] === q) status.push(`${p}: ${providerResults[p].length}`)
    }
    if (hasExternalSource()) {
      if (hsIndexInFlight) status.push('hs: …')
      else if (hsIndexQuery === q && hsMatches.length) status.push(`hs: +${hsMatches.length}`)
    }
    meta.textContent = status.length ? `“${q}” — ${status.join(' · ')}` : `“${q}” — searching…`
    grid.appendChild(meta)

    if (combined.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'heatsync-empty'
      const anyInFlight = PROVIDER_NAMES.some(p => pickerSources.has(p) && providerInFlight[p])
      if (anyInFlight) empty.textContent = t('common_loading')
      else empty.textContent = `no emotes match “${q}”`
      grid.appendChild(empty)
      return
    }

    renderEmoteResultList(grid, combined)
  }

  // Add (if needed) + paste + close — used by both the row click on search
  // results and the context-menu "+ add" path.
  async function pasteOrAddFromSearch(emote) {
    const inInv = isInInventory(emote)
    if (!inInv) {
      if (!cachedAuthToken) {
        showPickerToast('log in to add emotes')
        return
      }
      try {
        await addEmoteToInventorySilent(emote)
      } catch (_) {
        showPickerToast('failed to add')
        return
      }
    }
    recordRecentEmote(emote)
    insertEmoteIntoChat(emote.name)
    closePanel()
  }

  // Shared row renderer for search results. Whole row is the click target
  // (add to inventory if missing, paste into chat, close picker). Right-click
  // opens the rich context menu regardless of the global instant/menu setting.
  function renderEmoteResultList(grid, items) {
    const list = document.createElement('div')
    list.className = 'hs-discover-list'

    list.addEventListener('contextmenu', (evt) => {
      const row = evt.target.closest('.hs-discover-item')
      if (!row) return
      const idx = parseInt(row.dataset.idx, 10)
      if (isNaN(idx)) return
      const e = items[idx]
      if (!e) return
      showContextMenu(evt, e, 'discover')
    })

    list.addEventListener('click', (evt) => {
      const row = evt.target.closest('.hs-discover-item')
      if (!row) return
      const idx = parseInt(row.dataset.idx, 10)
      if (isNaN(idx)) return
      const e = items[idx]
      if (!e) return
      // Blocked result: left-click unblocks and restores it, mirroring the grid.
      const hash = e.hash || e.id || btoa(e.url || e.pickerUrl || '').slice(0, 24)
      if (_blockedHashSet.has(hash)) {
        chrome.runtime.sendMessage({ type: 'unblock_emote', hash })
          .then(result => {
            if (result?.success) {
              _blockedHashSet.delete(hash); renderEmoteGrid(); showPickerToast(t('btn_toast_unblocked'))
            } else {
              showPickerToast(result?.error || 'unblock failed')
            }
          })
          .catch(err => log('Unblock failed:', err.message))
        return
      }
      pasteOrAddFromSearch(e)
    })

    for (let i = 0; i < items.length; i++) {
      const e = items[i]
      const item = document.createElement('div')
      item.className = 'hs-discover-item'
      item.dataset.idx = String(i)

      // Reflect blocked state — same hash derivation as the grid/block path.
      // Without this the search list looked unchanged after a block, reading
      // as "not saving" even though the server-side block persisted fine.
      const _hash = e.hash || e.id || btoa(e.url || e.pickerUrl || '').slice(0, 24)
      if (_hash && _blockedHashSet.has(_hash)) item.classList.add('blocked')

      // Server can return relative paths like '/uploads/abc.webp' — absolutize
      const rawUrl = e.url || e.animated_url || ''
      const absUrl = rawUrl.startsWith('/') ? `https://heatsync.org${rawUrl}` : rawUrl
      const imgUrl = safeUrl(absUrl)
      if (imgUrl) {
        const img = document.createElement('img')
        img.className = 'hs-discover-thumb'
        img.src = imgUrl
        img.alt = escapeHtml(e.name)
        img.loading = 'lazy'
        img.referrerPolicy = 'no-referrer'
        item.appendChild(img)
      }

      const nameEl = document.createElement('div')
      nameEl.className = 'hs-discover-name'
      nameEl.textContent = e.name || ''
      item.appendChild(nameEl)

      // Provider chip (7TV / BTTV / FFZ / upload). Hide when unknown.
      const provRaw = (e.provider || '').toLowerCase()
      const provLabel = provRaw.includes('7tv') || provRaw === 'seventv' ? '7tv'
        : provRaw.includes('bttv') || provRaw === 'betterttv' ? 'bttv'
        : provRaw.includes('ffz') || provRaw === 'frankerfacez' ? 'ffz'
        : (provRaw === 'upload' || provRaw === 'imported') ? 'hs' : ''
      if (provLabel) {
        const chip = document.createElement('span')
        chip.className = `hs-discover-prov prov-${provLabel}`
        chip.textContent = provLabel
        item.appendChild(chip)
      }

      // Usage count (server-side trending signal). 0 hidden, large counts compacted.
      const usesCount = Number(e.uses || 0)
      if (usesCount > 0) {
        const uses = document.createElement('span')
        uses.className = 'hs-discover-uses'
        uses.textContent = usesCount >= 1000 ? `${(usesCount / 1000).toFixed(usesCount >= 10000 ? 0 : 1)}k` : String(usesCount)
        uses.title = `${usesCount.toLocaleString()} uses on heatsync`
        item.appendChild(uses)
      }

      list.appendChild(item)
    }

    grid.appendChild(list)
  }

  // ===== Provider-direct search APIs =====
  // 7TV v4 GraphQL — the v4 endpoint is what 7tv.app uses. perPage 200 is the
  // sweet spot for catching substring matches that appear deep in the ranked
  // result set (7TV's search prioritizes name-prefix matches first).
  const SEVEN_TV_V4_GQL = `query SearchEmotes($query: String!, $page: Int!, $perPage: Int!) {
    emotes {
      search(query: $query, sort: { sortBy: TOP_ALL_TIME, order: DESCENDING }, page: $page, perPage: $perPage) {
        totalCount
        items {
          id
          defaultName
          flags { animated }
        }
      }
    }
  }`

  async function search7tvApi(q, signal) {
    const resp = await fetch('https://api.7tv.app/v4/gql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        operationName: 'SearchEmotes',
        query: SEVEN_TV_V4_GQL,
        variables: { query: q, page: 1, perPage: 200 }
      })
    })
    if (!resp.ok) throw new Error(`7tv ${resp.status}`)
    const data = await resp.json()
    const items = (data && data.data && data.data.emotes && data.data.emotes.search && data.data.emotes.search.items) || []
    return items.map(e => ({
      name: e.defaultName,
      url: `https://cdn.7tv.app/emote/${e.id}/4x.webp`,
      provider: '7tv',
      id: e.id,
      animated: !!(e.flags && e.flags.animated),
    }))
  }

  // BTTV: REST search sorted by popularity (server-side default).
  async function searchBttvApi(q, signal) {
    const url = `https://api.betterttv.net/3/emotes/shared/search?query=${encodeURIComponent(q)}&offset=0&limit=200`
    const resp = await fetch(url, { signal })
    if (!resp.ok) throw new Error(`bttv ${resp.status}`)
    const items = await resp.json()
    if (!Array.isArray(items)) return []
    return items.map(e => ({
      name: e.code,
      url: `https://cdn.betterttv.net/emote/${e.id}/3x.${e.imageType || 'webp'}`,
      provider: 'bttv',
      id: e.id,
      animated: !!e.animated,
    }))
  }

  // FFZ: REST search sorted by usage count descending.
  async function searchFfzApi(q, signal) {
    const url = `https://api.frankerfacez.com/v1/emotes?q=${encodeURIComponent(q)}&sort=count-desc&per_page=200`
    const resp = await fetch(url, { signal })
    if (!resp.ok) throw new Error(`ffz ${resp.status}`)
    const data = await resp.json()
    const items = Array.isArray(data?.emoticons) ? data.emoticons : []
    return items.map(e => {
      // FFZ animated emotes live under e.animated (animated webp); e.urls is the
      // static PNG first-frame. Prefer animated so added/picked emotes don't freeze.
      const u = e.animated || e.urls || {}
      return {
        name: e.name,
        url: u['4'] || u['2'] || u['1'] || '',
        provider: 'ffz',
        id: String(e.id),
        animated: !!e.animated,
        uses: Number(e.usage_count || 0),
      }
    })
  }

  // Heatsync indexed substring search. Provider APIs are prefix-ranked which
  // means "WTFF" never returns "KEKWTFF" upstream. Heatsync's SQL ILIKE %q%
  // catches those — but only for emotes already in heatsync's deduped DB.
  // Server response shape: { results: [{ name, url, provider, hash, uses, ... }] }
  async function searchHsIndexFor(q) {
    const mySeq = ++_hsIndexSeq
    if (!q) {
      hsIndexResults = []
      hsIndexQuery = ''
      hsIndexInFlight = false
      return
    }
    if (hsIndexQuery === q && hsIndexResults.length > 0) return // cached
    hsIndexInFlight = true
    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'api_fetch',
        path: `/api/search?mode=emotes&q=${encodeURIComponent(q)}&limit=100`,
        method: 'GET',
        auth: false,
      })
      if (mySeq !== _hsIndexSeq) return
      if (!resp || resp.ok === false) {
        hsIndexResults = []
      } else {
        const data = resp.data || resp
        hsIndexResults = Array.isArray(data?.results) ? data.results : []
      }
      hsIndexQuery = q
    } catch (_) {
      if (mySeq !== _hsIndexSeq) return
      hsIndexResults = []
    } finally {
      if (mySeq === _hsIndexSeq) {
        hsIndexInFlight = false
        if (searchQuery === q) renderEmoteGrid()
      }
    }
  }

  // Fire all enabled provider searches in parallel. Each result lands as soon
  // as it returns and the grid re-renders with a partial picture. AbortController
  // cancels in-flight requests when the query changes mid-flight.
  function triggerProviderSearches(q) {
    // Fire heatsync indexed substring search alongside the provider APIs —
    // any enabled external chip benefits from it (filtered by result.provider).
    if (hasExternalSource() && q) searchHsIndexFor(q)
    else if (!q) searchHsIndexFor('')
    for (const p of PROVIDER_NAMES) {
      // Abort whatever was in flight for this provider — query changed.
      if (_providerAborts[p]) { try { _providerAborts[p].abort() } catch (_) {} }
      if (!q) {
        providerResults[p] = []
        providerLastQuery[p] = ''
        providerInFlight[p] = false
        providerErrors[p] = null
        continue
      }
      if (!pickerSources.has(p)) {
        // Chip is off — abort any in-flight fetch but keep cached results so
        // toggling back on doesn't trigger a refetch.
        providerInFlight[p] = false
        continue
      }
      // Already-aborted controller from the line above means we'll start fresh.
      if (providerLastQuery[p] === q && providerResults[p].length > 0) {
        // Cached for this query — no refetch.
        providerInFlight[p] = false
        continue
      }
      const ac = new AbortController()
      _providerAborts[p] = ac
      providerInFlight[p] = true
      providerErrors[p] = null
      const fn = p === '7tv' ? search7tvApi : p === 'bttv' ? searchBttvApi : searchFfzApi
      fn(q, ac.signal).then(items => {
        if (ac.signal.aborted) return
        providerResults[p] = items
        providerLastQuery[p] = q
        providerInFlight[p] = false
        providerErrors[p] = null
        if (searchQuery === q) renderEmoteGrid()
      }).catch(err => {
        if (ac.signal.aborted || err?.name === 'AbortError') return
        providerInFlight[p] = false
        providerErrors[p] = err?.message || 'failed'
        providerResults[p] = []
        if (searchQuery === q) renderEmoteGrid()
      })
    }
    if (searchQuery === q) renderEmoteGrid()
  }

  // Silent add to inventory (no UI feedback, used for click-to-use)
  async function addEmoteToInventorySilent(emote) {
    try {
      const token = await getAuthToken();
      if (!token) return;
      // Absolutize relative urls like '/uploads/...' that the server returns
      // for own-hosted emotes — import endpoint expects fully-qualified URLs.
      const rawUrl = emote.url || emote.pickerUrl || '';
      const url = rawUrl.startsWith('/') ? `https://heatsync.org${rawUrl}` : rawUrl;

      const resp = await HS.apiFetch('/api/user/emotes/import', {
        method: 'POST',
        auth: true,
        body: {
          emotes: [{
            name: emote.name,
            url,
            provider: emote.provider || 'imported',
            id: emote.id || emote.hash || ''
          }],
          source: `picker:click`
        }
      });

      // Surface server-side failures so callers can show 'failed' UI instead of
      // misleading 'added'. apiFetch returns the raw JSON; ok:false means error.
      if (resp && resp.ok === false) {
        throw new Error(resp.error || 'import failed');
      }

      // Refresh inventory
      await loadInventoryEmotes();
      fetchHistoryStatus();
    } catch (err) {
      throw err;
    }
  }

  // Update tab counts
  function updateTabCounts() {
    const countChannel = document.getElementById('count-channel');
    const countGlobal = document.getElementById('count-global');
    const countMine = document.getElementById('count-mine');
    if (countChannel) countChannel.textContent = channelEmotesCache.length || '0';
    if (countGlobal) {
      const channelNames = new Set(channelEmotesCache.map(e => e.name))
      const dedupedGlobal = globalEmotesCache.filter(e => !channelNames.has(e.name))
      countGlobal.textContent = dedupedGlobal.length || '0';
    }
    if (countMine) countMine.textContent = inventoryEmotesCache.length || '0';
  }

  // Block emote (hide from view)
  async function blockEmote(emote) {
    try {
      const hash = emote.hash || emote.id || btoa(emote.url || emote.pickerUrl).slice(0, 24);

      // Send message to background script (handles both logged in and anonymous)
      const result = await chrome.runtime.sendMessage({
        type: 'block_emote',
        hash: hash
      });

      if (!result || !result.success) {
        throw new Error(result?.error || 'Block failed');
      }

      if (result.local) {
        log('Blocked emote locally (not logged in):', emote.name);
      } else {
        log('Blocked emote:', emote.name);
      }

      // Keep the emote in the cache — let the renderer apply the .blocked class
      // so it stays in place with a dashed outline instead of shifting siblings.
      _blockedHashSet.add(hash);

      updateTabCounts();
      renderEmoteGrid();

    } catch (err) {
      if (err.message?.includes('Extension context invalidated')) {
        const toast = document.createElement('div');
        toast.textContent = t('common_extension_updated');
        toast.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#f44;color:#fff;padding:8px 16px;border-radius:0;z-index:99999;font-size:14px;';
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 5000);
      }
      log('Failed to block emote:', err.message);
    }
  }

  // --- Context menu ---
  let _ctxMenu = null;
  let _blockedHashSet = new Set();

  function dismissContextMenu() {
    if (!_ctxMenu) return;
    _ctxMenu.remove();
    _ctxMenu = null;
  }

  function showPickerToast(msg) {
    // Prefer dropping the toast into multichat's message stream when it's open,
    // but always show SOMETHING so users get feedback for context-menu actions
    // even when multichat is closed.
    const msgsEl = document.getElementById('hs-mc-messages');
    if (msgsEl) {
      const div = document.createElement('div');
      div.className = 'hs-mc-msg hs-mc-system';
      div.textContent = msg;
      msgsEl.appendChild(div);
      const excess = msgsEl.children.length - 150
      if (excess > 0) {
        const range = document.createRange()
        range.setStartBefore(msgsEl.firstChild)
        range.setEndBefore(msgsEl.children[excess])
        range.deleteContents()
      }
      requestAnimationFrame(() => { msgsEl.scrollTop = msgsEl.scrollHeight })
      return;
    }
    // Fallback: floating toast in the picker panel itself
    const panel = document.querySelector('#heatsync-emote-grid')?.closest('div');
    const host = panel || document.body;
    if (!host) return;
    let toast = host.querySelector('.heatsync-floating-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'heatsync-floating-toast';
      toast.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#000;color:#fff;border:1px solid #ff8700;padding:8px 14px;font-size:13px;z-index:99999;pointer-events:none;opacity:0;transition:opacity 0.15s';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.style.opacity = '1';
    clearTimeout(toast._hideTimer);
    toast._hideTimer = setTimeout(() => { toast.style.opacity = '0' }, 2200);
  }

  // Derive the provider's emote-detail page URL from a CDN url. Returns null
  // for providers without a canonical page (twitch, heatsync uploads).
  function emoteProviderPage(emote) {
    const url = emote?.url || emote?.pickerUrl || '';
    let m;
    if ((m = url.match(/cdn\.7tv\.app\/emote\/([a-zA-Z0-9]+)\//))) {
      return { label: '7tv', url: `https://7tv.app/emotes/${m[1]}` };
    }
    if ((m = url.match(/cdn\.betterttv\.net\/emote\/([a-zA-Z0-9]+)\//))) {
      return { label: 'bttv', url: `https://betterttv.com/emotes/${m[1]}` };
    }
    if ((m = url.match(/cdn\.frankerfacez\.com\/emote\/(\d+)\//))) {
      return { label: 'ffz', url: `https://www.frankerfacez.com/emoticon/${m[1]}` };
    }
    return null;
  }

  function showContextMenu(evt, emote, tab) {
    evt.preventDefault();
    evt.stopPropagation();
    dismissContextMenu();

    const menu = document.createElement('div');
    menu.className = 'hs-emote-ctx';
    _ctxMenu = menu;

    const hash = emote.hash || emote.id || btoa(emote.url || emote.pickerUrl || '').slice(0, 24);
    const inInv = isInInventory(emote);
    const isBlocked = _blockedHashSet.has(hash);

    // Open on provider (7TV / BTTV / FFZ). Skipped for twitch + heatsync uploads.
    // Copy-name / copy-url already live at the bottom of this menu.
    const provider = emoteProviderPage(emote);

    // Preview tile — thumbnail + name + provider/state, matches the page + panel menus
    const emoteUrl = emote.url || emote.pickerUrl || '';
    const preview = document.createElement('div');
    preview.className = 'hs-emote-ctx-preview';
    const thumb = document.createElement('div');
    thumb.className = 'hs-emote-ctx-thumb';
    const subEl = document.createElement('div');
    subEl.className = 'hs-emote-ctx-sub';
    if (emoteUrl) {
      const big = document.createElement('img');
      big.src = emoteUrl;
      big.alt = emote.name;
      big.decoding = 'async';
      big.referrerPolicy = 'no-referrer';
      big.addEventListener('load', () => {
        if (big.naturalWidth && big.naturalHeight) {
          const dim = document.createElement('span');
          dim.textContent = `${big.naturalWidth}×${big.naturalHeight}`;
          subEl.insertBefore(dim, subEl.firstChild);
        }
      });
      thumb.appendChild(big);
    }
    const meta = document.createElement('div');
    meta.className = 'hs-emote-ctx-meta';
    const nameEl = document.createElement('div');
    nameEl.className = 'hs-emote-ctx-name';
    nameEl.textContent = emote.name;
    const provLabel = provider?.label || (emote.source ? String(emote.source).toLowerCase() : (emoteUrl.includes('static-cdn.jtvnw.net') ? 'twitch' : 'heatsync'));
    if (provLabel) {
      const tag = document.createElement('span');
      tag.className = 'hs-emote-ctx-provider';
      tag.textContent = provLabel;
      subEl.appendChild(tag);
    }
    const stateTxt = document.createElement('span');
    stateTxt.textContent = isBlocked ? 'blocked' : (inInv ? 'in set' : 'not in set');
    subEl.appendChild(stateTxt);
    meta.appendChild(nameEl);
    meta.appendChild(subEl);
    preview.appendChild(thumb);
    preview.appendChild(meta);
    menu.appendChild(preview);

    if (provider) {
      const openBtn = document.createElement('button');
      openBtn.className = 'hs-emote-ctx-item';
      openBtn.textContent = `open on ${provider.label} →`;
      openBtn.addEventListener('click', () => {
        dismissContextMenu();
        window.open(provider.url, '_blank', 'noopener,noreferrer');
      });
      menu.appendChild(openBtn);
      const sep = document.createElement('div');
      sep.className = 'hs-emote-ctx-sep';
      menu.appendChild(sep);
    }

    // Block / unblock — green > orange > block. An emote in your set shows
    // "remove from set" (below), not block; you block it after removing. Globals
    // and 3rd-party channel emotes aren't in your set, so block shows directly.
    // Always allow unblock when already blocked.
    if (isBlocked || !inInv) {
      const blockBtn = document.createElement('button');
      blockBtn.className = 'hs-emote-ctx-item';
      blockBtn.textContent = isBlocked ? t('btn_ctx_unblock') : t('btn_ctx_block');
      blockBtn.addEventListener('click', async () => {
        dismissContextMenu();
        if (isBlocked) {
          try {
            const result = await chrome.runtime.sendMessage({ type: 'unblock_emote', hash });
            if (result?.success) {
              _blockedHashSet.delete(hash);
              renderEmoteGrid();
              showPickerToast(t('btn_toast_unblocked'));
            } else {
              showPickerToast(result?.error || 'unblock failed');
            }
          } catch (err) {
            if (err.message?.includes('Extension context invalidated')) {
              const toast = document.createElement('div');
              toast.textContent = t('common_extension_updated');
              toast.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#f44;color:#fff;padding:8px 16px;border-radius:0;z-index:99999;font-size:14px;';
              document.body.appendChild(toast);
              setTimeout(() => toast.remove(), 5000);
            }
            log('Unblock failed:', err.message);
          }
        } else {
          blockEmote(emote);
          _blockedHashSet.add(hash);
          showPickerToast(t('btn_toast_blocked'));
        }
      });
      menu.appendChild(blockBtn);
    }

    // Add / remove from inventory
    // Gate remove on real heatsync inventory membership (slot exists). The
    // 'mine' tab also surfaces sub entitlements + globals that aren't heatsync
    // slots — DELETE /api/user/emotes/:slot has nothing to target on those,
    // and the unconditional toast made it look like it "removed" while the
    // emote stayed visible. Subs/defaults get block only; reach for unsub on
    // Twitch if you actually want them out.
    if (inInv && !emote.subscription) {
      const removeBtn = document.createElement('button');
      removeBtn.className = 'hs-emote-ctx-item';
      removeBtn.textContent = t('btn_ctx_remove_inventory');
      removeBtn.addEventListener('click', async () => {
        dismissContextMenu();
        try {
          await chrome.runtime.sendMessage({ type: 'remove_from_inventory', emoteHash: hash, emoteName: emote.name });
          showPickerToast(t('btn_toast_removed'));
          if (tab === 'mine') {
            inventoryEmotesCache = inventoryEmotesCache.filter(e => e.name !== emote.name);
            rebuildInventoryIndex()
            updateTabCounts();
            renderEmoteGrid();
          }
          fetchHistoryStatus();
        } catch (err) {
          if (err.message?.includes('Extension context invalidated')) {
            const toast = document.createElement('div');
            toast.textContent = t('common_extension_updated');
            toast.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#f44;color:#fff;padding:8px 16px;border-radius:0;z-index:99999;font-size:14px;';
            document.body.appendChild(toast);
            setTimeout(() => toast.remove(), 5000);
          }
          log('Remove failed:', err.message);
        }
      });
      menu.appendChild(removeBtn);
    } else if (cachedAuthToken && !emote.subscription) {
      const addBtn = document.createElement('button');
      addBtn.className = 'hs-emote-ctx-item';
      addBtn.textContent = t('btn_ctx_add_inventory');
      addBtn.addEventListener('click', () => {
        dismissContextMenu();
        addEmoteToInventorySilent(emote);
        showPickerToast(t('btn_toast_added'));
      });
      menu.appendChild(addBtn);
    }

    // Rename / move / share set — mine tab + logged-in only
    if (tab === 'mine' && cachedAuthToken) {
      const sep0 = document.createElement('div');
      sep0.className = 'hs-emote-ctx-sep';
      menu.appendChild(sep0);

      // Rename
      const renameBtn = document.createElement('button');
      renameBtn.className = 'hs-emote-ctx-item';
      renameBtn.textContent = 'rename';
      renameBtn.addEventListener('click', () => {
        // Swap button row with inline input
        renameBtn.style.display = 'none';
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'hs-emote-ctx-input';
        input.value = emote.name;
        input.setAttribute('autocomplete', 'off');
        const confirmBtn = document.createElement('button');
        confirmBtn.className = 'hs-emote-ctx-confirm';
        confirmBtn.textContent = 'save';
        menu.insertBefore(input, renameBtn.nextSibling);
        menu.insertBefore(confirmBtn, input.nextSibling);
        input.focus();
        input.select();
        confirmBtn.addEventListener('click', async () => {
          const newName = input.value.trim();
          if (!newName || newName === emote.name) { dismissContextMenu(); return; }
          // Use the emote's actual slot_number (mapped to .slot in background) —
          // findIndex returns array position which may not equal slot when there
          // are gaps from deleted emotes.
          const slot = emote.slot ?? inventoryEmotesCache.find(e => e.hash === hash)?.slot;
          if (slot == null) { dismissContextMenu(); return; }
          dismissContextMenu();
          try {
            const resp = await chrome.runtime.sendMessage({
              type: 'api_fetch',
              path: `/api/user/emotes/${slot}/rename`,
              method: 'PUT',
              auth: true,
              body: { newName }
            });
            if (resp && resp.ok !== false) {
              showPickerToast(`renamed to ${newName}`);
              await loadInventoryEmotes();
              renderEmoteGrid();
              fetchHistoryStatus();
            } else {
              showPickerToast(resp?.error || 'rename failed');
            }
          } catch (_) { showPickerToast('rename failed'); }
        });
        input.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') confirmBtn.click();
          if (ev.key === 'Escape') dismissContextMenu();
          ev.stopPropagation();
        });
      });
      menu.appendChild(renameBtn);

      // Move to slot
      const moveBtn = document.createElement('button');
      moveBtn.className = 'hs-emote-ctx-item';
      moveBtn.textContent = 'move to slot…';
      moveBtn.addEventListener('click', () => {
        moveBtn.style.display = 'none';
        const input = document.createElement('input');
        input.type = 'number';
        input.min = '0';
        input.className = 'hs-emote-ctx-input';
        input.placeholder = 'slot number';
        const confirmBtn = document.createElement('button');
        confirmBtn.className = 'hs-emote-ctx-confirm';
        confirmBtn.textContent = 'move';
        menu.insertBefore(input, moveBtn.nextSibling);
        menu.insertBefore(confirmBtn, input.nextSibling);
        input.focus();
        // Use emote.slot (server slot_number); array index can drift from slot.
        const fromSlot = emote.slot ?? inventoryEmotesCache.find(e => e.hash === hash)?.slot;
        confirmBtn.addEventListener('click', async () => {
          const toSlot = parseInt(input.value, 10);
          if (isNaN(toSlot) || fromSlot == null) { dismissContextMenu(); return; }
          dismissContextMenu();
          try {
            const resp = await chrome.runtime.sendMessage({
              type: 'api_fetch',
              path: `/api/user/emotes/${fromSlot}/move`,
              method: 'PUT',
              auth: true,
              body: { toSlot }
            });
            if (resp && resp.ok !== false) {
              showPickerToast(`moved to slot ${toSlot}`);
              await loadInventoryEmotes();
              renderEmoteGrid();
              fetchHistoryStatus();
            } else {
              showPickerToast(resp?.error || 'move failed');
            }
          } catch (_) { showPickerToast('move failed'); }
        });
        input.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') confirmBtn.click();
          if (ev.key === 'Escape') dismissContextMenu();
          ev.stopPropagation();
        });
      });
      menu.appendChild(moveBtn);

      // Share set / unshare
      const shareBtn = document.createElement('button');
      shareBtn.className = 'hs-emote-ctx-item';
      shareBtn.textContent = discoverShareUrl ? 'unshare set' : 'share set';
      shareBtn.addEventListener('click', async () => {
        dismissContextMenu();
        if (discoverShareUrl) {
          // Unshare
          try {
            await chrome.runtime.sendMessage({
              type: 'api_fetch',
              path: '/api/user/emotes/share',
              method: 'DELETE',
              auth: true
            });
            discoverShareUrl = null;
            showPickerToast('set unshared');
          } catch (_) { showPickerToast('unshare failed'); }
        } else {
          // Share
          try {
            const resp = await chrome.runtime.sendMessage({
              type: 'api_fetch',
              path: '/api/user/emotes/share',
              method: 'POST',
              auth: true,
              body: {}
            });
            if (resp && resp.ok !== false) {
              const shortId = resp.data?.shortId || resp.shortId;
              if (shortId) {
                discoverShareUrl = `https://heatsync.org/s/${shortId}`;
                navigator.clipboard.writeText(discoverShareUrl).catch(() => {});
                showPickerToast(`share link copied: ${discoverShareUrl}`);
              } else {
                showPickerToast('share failed');
              }
            } else {
              showPickerToast(resp?.error || 'share failed');
            }
          } catch (_) { showPickerToast('share failed'); }
        }
      });
      menu.appendChild(shareBtn);
    }

    // Separator
    const sep = document.createElement('div');
    sep.className = 'hs-emote-ctx-sep';
    menu.appendChild(sep);

    // Copy name
    const copyName = document.createElement('button');
    copyName.className = 'hs-emote-ctx-item';
    copyName.textContent = t('btn_ctx_copy_name');
    copyName.addEventListener('click', () => {
      dismissContextMenu();
      navigator.clipboard.writeText(emote.name).catch(() => {});
      showPickerToast(t('btn_toast_copied'));
    });
    menu.appendChild(copyName);

    // Copy URL
    const copyUrl = document.createElement('button');
    copyUrl.className = 'hs-emote-ctx-item';
    copyUrl.textContent = t('btn_ctx_copy_url');
    copyUrl.addEventListener('click', () => {
      dismissContextMenu();
      navigator.clipboard.writeText(emote.url || emote.pickerUrl || '').catch(() => {});
      showPickerToast(t('btn_toast_copied'));
    });
    menu.appendChild(copyUrl);

    // Copy markdown
    const copyMd = document.createElement('button');
    copyMd.className = 'hs-emote-ctx-item';
    copyMd.textContent = 'copy markdown';
    copyMd.addEventListener('click', () => {
      dismissContextMenu();
      navigator.clipboard.writeText(`![${emote.name}](${emote.url || emote.pickerUrl || ''})`).catch(() => {});
      showPickerToast(t('btn_toast_copied'));
    });
    menu.appendChild(copyMd);

    document.body.appendChild(menu);

    // Position — clamp to viewport
    const rect = menu.getBoundingClientRect();
    let x = evt.clientX;
    let y = evt.clientY;
    if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 4;
    if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 4;
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
  }

  // Dismiss on click-outside or Escape (gated on menu existing)
  document.addEventListener('click', (e) => {
    if (_ctxMenu && !_ctxMenu.contains(e.target)) dismissContextMenu();
  }, { signal: btnSignal });
  document.addEventListener('keydown', (e) => {
    if (_ctxMenu && e.key === 'Escape') { dismissContextMenu(); return }

    // Keyboard navigation in emote picker
    if (!panelOpen) return
    const grid = document.getElementById('heatsync-emote-grid')
    if (!grid) return

    if (e.key === 'Escape') { closePanel(); e.preventDefault(); return }

    const totalEmotes = _virtualRecentCount + _virtualPickerEmotes.length
    if (totalEmotes === 0) return

    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter') {
      e.preventDefault()

      if (e.key === 'Enter' && focusedEmoteIndex >= 0 && focusedEmoteIndex < totalEmotes) {
        const focusedWrap = grid.querySelector(`.heatsync-emote-wrap[data-index="${focusedEmoteIndex}"]`)
        if (focusedWrap) focusedWrap.click()
        return
      }

      // Calculate items per row from grid width
      const sizeMap = { '1x': 32, '2x': 56, '4x': 112 }
      const emoteSize = sizeMap[localStorage.getItem('heatsync-emote-size') || '1x'] || 32
      const gridPadding = 8
      const gridWidth = grid.clientWidth - gridPadding * 2
      const itemsPerRow = Math.max(1, Math.floor((gridWidth + 4) / (emoteSize + 4)))

      let newIdx = focusedEmoteIndex
      if (e.key === 'ArrowRight') newIdx = Math.min(newIdx + 1, totalEmotes - 1)
      else if (e.key === 'ArrowLeft') newIdx = Math.max(newIdx - 1, 0)
      else if (e.key === 'ArrowDown') newIdx = Math.min(newIdx + itemsPerRow, totalEmotes - 1)
      else if (e.key === 'ArrowUp') newIdx = Math.max(newIdx - itemsPerRow, 0)

      if (newIdx < 0) newIdx = 0

      // Remove old focus
      const oldFocused = grid.querySelector('.hs-kb-focus')
      if (oldFocused) oldFocused.classList.remove('hs-kb-focus')
      focusedEmoteIndex = newIdx

      // For virtualized emotes, scroll to ensure the target is rendered
      if (newIdx >= _virtualRecentCount) {
        const virtualIdx = newIdx - _virtualRecentCount
        const rowHeight = emoteSize + 4
        const row = Math.floor(virtualIdx / itemsPerRow)
        const recentSection = grid.querySelector('.heatsync-recent-section')
        const recentHeight = recentSection ? recentSection.offsetHeight : 0
        const targetTop = recentHeight + row * rowHeight
        const targetBottom = targetTop + rowHeight

        // Scroll grid to show the target row
        if (targetTop < grid.scrollTop) {
          grid.scrollTop = targetTop
        } else if (targetBottom > grid.scrollTop + grid.clientHeight) {
          grid.scrollTop = targetBottom - grid.clientHeight
        }
      }

      // Find and focus the element (may need a frame for virtual scroll to render it)
      requestAnimationFrame(() => {
        const newFocused = grid.querySelector(`.heatsync-emote-wrap[data-index="${focusedEmoteIndex}"]`)
        if (newFocused) {
          newFocused.classList.add('hs-kb-focus')
          newFocused.scrollIntoView({ block: 'nearest' })
        }
      })
    }
  }, { signal: btnSignal });

  // Sync blocked hash set from content.js
  window.addEventListener('message', (event) => {
    if (event.source !== window) return
    if (event.origin !== location.origin) return;
    if (event.data?.type === 'heatsync-blocked-sync' && Array.isArray(event.data.hashes)) {
      _blockedHashSet = new Set(event.data.hashes);
    }
  }, { signal: btnSignal });

  // Independent loads for channel/global and inventory.
  // Inventory is in-memory in the background and resolves <50ms; channel/global
  // can wait on third-party APIs. Gating inventory on the picker fetch made the
  // "mine" tab show "loading…" for seconds even though 2k+ emotes were ready.
  // Each tab paints stale IDB data immediately, then re-renders when fresh data lands.
  function loadAllEmotesFromBackground(channel) {
    // Paint stale IDB data immediately (parallel reads, fire-and-forget render)
    ;(async () => {
      const [staleChannel, staleGlobal, staleInventory] = await Promise.all([
        channel ? getCachedEmotes(`channel:${channel}`) : Promise.resolve(null),
        getCachedEmotes('global'),
        getCachedEmotes('inventory')
      ])
      let painted = false
      if (staleChannel)   { channelEmotesCache   = staleChannel;   usingCachedData.channel = true; painted = true }
      if (staleGlobal)    { globalEmotesCache    = staleGlobal;    usingCachedData.global  = true; painted = true }
      if (staleInventory) { inventoryEmotesCache = staleInventory; usingCachedData.mine    = true; rebuildInventoryIndex(); painted = true }
      if (painted) {
        updateTabCounts()
        renderEmoteGrid({ preserveScroll: true })
      }
    })()

    // Loading flags only block the UI when we have NO stale data — otherwise the
    // tab keeps showing the stale grid until fresh arrives (no flicker).
    isLoading.channel = true
    isLoading.global  = true
    isLoading.mine    = true

    // --- Inventory load (fast, independent) ---
    chrome.runtime.sendMessage({ type: 'get_inventory' })
      .then(invResp => {
        inventoryEmotesCache = invResp?.emotes || []
        rebuildInventoryIndex()
        usingCachedData.mine = false
        loadErrors.mine = null
        if (inventoryEmotesCache.length > 0) setCachedEmotes('inventory', inventoryEmotesCache)
      })
      .catch(err => {
        log(' inventory load failed:', err?.message)
        // Keep stale IDB data if we had it; only flag error on cold-empty
        if (!inventoryEmotesCache.length) loadErrors.mine = 'failed to load your emotes'
      })
      .finally(() => {
        isLoading.mine = false
        updateTabCounts()
        if (currentTab === 'mine') renderEmoteGrid({ preserveScroll: true })
      })

    // --- Picker load (channel + global, may wait on 7TV/FFZ/BTTV) ---
    chrome.runtime.sendMessage({
      type: 'get_picker_emotes',
      channel: channel || null,
      platform: window.heatsyncPlatform?.detectPlatform() || 'unknown'
    })
      .then(pickerResp => {
        const ch = pickerResp?.channelEmotes
        const gl = pickerResp?.globalEmotes
        const channelStillLoading = !!pickerResp?.channelLoading
        if (Array.isArray(ch)) {
          channelEmotesCache = ch
          usingCachedData.channel = false
          loadErrors.channel = null
          if (channel && ch.length > 0) setCachedEmotes(`channel:${channel}`, ch)
        }
        if (Array.isArray(gl)) {
          globalEmotesCache = gl
          usingCachedData.global = false
          loadErrors.global = null
          if (gl.length > 0) setCachedEmotes('global', gl)
        }
        // Keep channel loading flag set if background just kicked off fetch —
        // the channel_emotes_update broadcast listener will clear it on arrival.
        isLoading.channel = channelStillLoading
        isLoading.global  = false
        updateTabCounts()
        if (currentTab === 'channel' || currentTab === 'global') renderEmoteGrid({ preserveScroll: true })
        // Watchdog: clear channel loading after 12s if the broadcast never
        // arrives (e.g. fetchChannelOwnerEmotes hit an exception path).
        if (channelStillLoading) {
          cleanup.setTimeout(() => {
            if (isLoading.channel) {
              isLoading.channel = false
              if (!channelEmotesCache.length) loadErrors.channel = 'channel emotes unavailable'
              updateTabCounts()
              if (currentTab === 'channel') renderEmoteGrid({ preserveScroll: true })
            }
          }, 12000)
        }
      })
      .catch(err => {
        log(' picker load failed:', err?.message)
        if (!channelEmotesCache.length) loadErrors.channel = 'failed to load channel emotes'
        if (!globalEmotesCache.length)  loadErrors.global  = 'failed to load global emotes'
        isLoading.channel = false
        isLoading.global  = false
        updateTabCounts()
        if (currentTab === 'channel' || currentTab === 'global') renderEmoteGrid({ preserveScroll: true })
      })
  }

  // Load user's inventory emotes — delegates to background cache via get_inventory
  // (kept as separate function so retry handlers and addEmoteToInventorySilent can call it).
  // Writes to IDB on success so cold opens after SW sleep paint stale instantly.
  async function loadInventoryEmotes() {
    isLoading.mine = true;
    loadErrors.mine = null;
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'get_inventory' });
      inventoryEmotesCache = resp?.emotes || [];
      rebuildInventoryIndex()
      loadErrors.mine = null;
      usingCachedData.mine = false;
      if (inventoryEmotesCache.length > 0) setCachedEmotes('inventory', inventoryEmotesCache)
      updateTabCounts();
    } catch (err) {
      // Don't wipe cached data on transient failure
      if (!inventoryEmotesCache.length) {
        rebuildInventoryIndex()
        loadErrors.mine = 'failed to load your emotes';
      }
      updateTabCounts();
    } finally {
      isLoading.mine = false;
    }
  }

  // Load channel emotes — reads from background's in-memory cache (no direct API fetch)
  // Falls back to IndexedDB stale data while background loads, then updates once ready.
  async function loadChannelEmotes(channel) {
    if (!channel) {
      channelEmotesCache = [];
      loadErrors.channel = null;
      updateTabCounts();
      return;
    }

    const cacheKey = `channel:${channel}`;
    isLoading.channel = true;
    loadErrors.channel = null;
    usingCachedData.channel = false;

    // Show IndexedDB stale data immediately while background fetches
    const stale = await getCachedEmotes(cacheKey);
    if (stale) {
      channelEmotesCache = stale;
      usingCachedData.channel = true;
      log(' Loaded', channelEmotesCache.length, 'channel emotes (stale idb)');
      updateTabCounts();
    }

    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'get_picker_emotes',
        channel,
        platform: window.heatsyncPlatform?.detectPlatform() || 'unknown'
      });
      const fresh = resp?.channelEmotes || [];
      channelEmotesCache = fresh;
      usingCachedData.channel = false;
      loadErrors.channel = null;
      log(' Updated', channelEmotesCache.length, 'channel emotes (background cache)');
      updateTabCounts();
      // persist to IndexedDB so next open is instant
      if (fresh.length > 0) setCachedEmotes(cacheKey, fresh);
    } catch (err) {
      if (!stale) {
        channelEmotesCache = [];
        loadErrors.channel = 'failed to load channel emotes';
        updateTabCounts();
      }
    } finally {
      isLoading.channel = false;
    }
  }

  // Load global emotes — reads from background's in-memory cache (no direct API fetch)
  async function loadGlobalEmotes() {
    const cacheKey = 'global';
    isLoading.global = true;
    loadErrors.global = null;
    usingCachedData.global = false;

    // Show IndexedDB stale data immediately
    const stale = await getCachedEmotes(cacheKey);
    if (stale) {
      globalEmotesCache = stale;
      usingCachedData.global = true;
      log(' Loaded', globalEmotesCache.length, 'global emotes (stale idb)');
      updateTabCounts();
    }

    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'get_picker_emotes',
        channel: null,
        platform: window.heatsyncPlatform?.detectPlatform() || 'unknown'
      });
      const fresh = resp?.globalEmotes || [];
      globalEmotesCache = fresh;
      usingCachedData.global = false;
      loadErrors.global = null;
      log(' Updated', globalEmotesCache.length, 'global emotes (background cache)');
      updateTabCounts();
      if (fresh.length > 0) setCachedEmotes(cacheKey, fresh);
    } catch (err) {
      if (!stale) {
        globalEmotesCache = [];
        loadErrors.global = 'failed to load global emotes';
        updateTabCounts();
      }
    } finally {
      isLoading.global = false;
    }
  }

  // Insert emote name into Twitch chat input
  function insertEmoteIntoChat(emoteName) {
    const platform = window.heatsyncPlatform?.detectPlatform() || 'unknown';

    let chatInput;
    if (platform === 'youtube') {
      chatInput = document.querySelector('yt-live-chat-text-input-field-renderer div#input[contenteditable]')
    } else if (platform === 'kick') {
      // Kick uses a regular input or textarea
      chatInput = document.querySelector('div.editor-input');
    } else {
      // Twitch uses contenteditable
      chatInput = document.querySelector('[data-a-target="chat-input"]');
    }

    if (!chatInput) {
      return;
    }

    if (platform === 'youtube') {
      // YouTube: delegate to youtube-content.js via message (execCommand deprecated)
      chrome.runtime.sendMessage({ type: 'youtube_insert_emote', emoteName })
    } else {
      // Twitch/Kick: contenteditable. Slate keeps phantom <p><br></p> blocks
      // when visually empty — textContent is "" but cursor sits in a later
      // paragraph, so plain insertText leaves a blank line above.
      const currentText = chatInput.textContent || '';
      chatInput.focus();
      if (currentText.trim() === '') {
        document.execCommand('selectAll');
        document.execCommand('insertText', false, emoteName + ' ');
      } else {
        const needsSpace = !currentText.endsWith(' ');
        document.execCommand('insertText', false, (needsSpace ? ' ' : '') + emoteName + ' ');
      }
    }

    // Close panel after inserting
    closePanel();
  }

  // Close the panel (hide, don't destroy - keeps images cached)
  function closePanel() {
    const panel = document.getElementById(PANEL_ID);
    if (panel) panel.style.display = 'none';
    panelOpen = false;
    document.removeEventListener('click', handleClickOutside);
  }

  // Handle click outside panel
  function handleClickOutside(e) {
    const panel = document.getElementById(PANEL_ID);
    const btn = document.getElementById(BUTTON_ID);
    // The emote context menu lives on document.body, outside the panel — clicks
    // on its items (block / remove from set / rename) must not close the picker.
    // The item handler dismisses the menu before this fires, so _ctxMenu is
    // already null; match the (now-detached) target by class instead.
    if (e.target.closest && e.target.closest('.hs-emote-ctx')) return;
    if (panel && !panel.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
      closePanel();
    }
  }

  // Inject button into chat
  function injectButton() {
    if (buttonInjected && document.getElementById(BUTTON_ID)) return;

    // Don't inject if already present
    if (document.getElementById(BUTTON_ID)) {
      buttonInjected = true;
      return;
    }

    // Find Twitch's emote picker button directly
    let anchor = document.querySelector('[data-a-target="emote-picker-button"]');
    let insertAfter = true;

    // Kick fallback — anchor near the chat input area
    if (!anchor && window.location.hostname.includes('kick.com')) {
      anchor = document.querySelector('.editor-input')?.parentElement ||
               document.querySelector('[class*="editor-input"]')?.parentElement ||
               document.querySelector('[class*="chatroom-footer"]') ||
               document.querySelector('.chat-footer') ||
               document.querySelector('[class*="chat-input"]')?.parentElement ||
               document.querySelector('#message-input')?.parentElement;
      insertAfter = false; // append inside the container on Kick
    }

    // YouTube live chat iframe — inject near the chat input
    if (!anchor && window.location.hostname.includes('youtube.com')) {
      anchor = document.querySelector('yt-live-chat-text-input-field-renderer #buttons') ||
               document.querySelector('yt-live-chat-text-input-field-renderer') ||
               document.querySelector('#chat-messages')?.closest('yt-live-chat-renderer')?.querySelector('#input-panel')
      insertAfter = false // append inside container
    }

    if (!anchor) {
      log(' Anchor element not found yet');
      return;
    }

    const btn = createButton();

    if (insertAfter) {
      // Twitch: insert right AFTER the emote button (keep both)
      anchor.parentElement.insertBefore(btn, anchor.nextSibling);
    } else {
      // Kick: append inside the chat footer/input area
      anchor.appendChild(btn);
    }

    buttonInjected = true;
    log(' 🔥 Button added next to emote picker');

    // Start preloading emotes in background once button is injected
    if (!emotesPreloaded && !preloadingInProgress) {
      preloadEmotesInBackground();
    }
  }

  // Preload all emotes in background when page loads
  async function preloadEmotesInBackground() {
    if (emotesPreloaded || preloadingInProgress) return;
    preloadingInProgress = true;

    const channel = detectChannel();
    if (!channel) {
      preloadingInProgress = false;
      return;
    }

    currentChannel = channel;
    log(' 🔄 Background preloading emotes for', channel);

    try {
      // Load all emote sources in parallel (uses IndexedDB cache)
      await loadAllEmotesFromBackground(channel);

      const totalEmotes = channelEmotesCache.length + globalEmotesCache.length + inventoryEmotesCache.length;
      log(' ✅ Preloaded', totalEmotes, 'emotes metadata');

      // Preloading disabled (ORB blocks, browser handles natively)
      emotesPreloaded = true;

    } catch (err) {
    }

    preloadingInProgress = false;
  }

  // Inject preconnect hints for CDN domains
  function injectPreconnectHints() {
    const domains = [
      'https://cdn.7tv.app',
      'https://cdn.betterttv.net',
      'https://cdn.frankerfacez.com'
    ];
    domains.forEach(href => {
      if (!document.querySelector(`link[rel="preconnect"][href="${href}"]`)) {
        const link = document.createElement('link');
        link.rel = 'preconnect';
        link.href = href;
        link.crossOrigin = 'anonymous';
        document.head.appendChild(link);
      }
    });
    log(' Preconnect hints injected');
  }

  // Cleanup orphaned elements from previous extension loads
  function cleanupOrphanedElements() {
    // Remove any duplicate style elements
    document.querySelectorAll('#heatsync-ui-hiding-btn').forEach((el, i) => {
      if (i > 0) el.remove(); // Keep first, remove rest
    });
    document.querySelectorAll('#heatsync-button-styles').forEach((el, i) => {
      if (i > 0) el.remove();
    });
    // Remove ALL loading indicators (feature disabled)
    document.querySelectorAll('#heatsync-loading-status').forEach(el => el.remove());
  }

  // Initialize
  async function init() {
    // picker-button subsystem gate — off = no button, no preload, no panel
    try {
      const d = await chrome.storage.sync.get('ui_settings')
      if (d?.ui_settings?.subsystems?.['picker-button'] === false) {
        log(' picker-button subsystem off — skipping button module');
        return;
      }
    } catch (_) {}
    log(' 🔥 Initializing button module on:', window.location.href);
    cleanupOrphanedElements();
    injectPreconnectHints();
    injectStyles();

    // Load and apply UI hiding settings on load (async)
    const settings = await loadExtensionSettings();
    applyUiHidingSettings(settings);

    // Start background preloading immediately (don't wait for button)
    setTimeout(() => {
      if (!emotesPreloaded && !preloadingInProgress) {
        preloadEmotesInBackground();
      }
    }, 100);

    // Try to inject immediately
    injectButton();

    // Re-try periodically (chat might load later)
    cleanup.setInterval(() => {
      if (!document.getElementById(BUTTON_ID)) {
        buttonInjected = false;
      }
      injectButton();
    }, 2000, 'button-retry');

    log(' Retry interval started');

    // SPA navigation — event-driven via early-inject-main.js history hooks
    let lastUrl = location.href;
    function handleButtonNav() {
      if (location.href === lastUrl) return
      lastUrl = location.href;
      injectStyles(); // SPA nav can sweep the style tag — idempotent re-assert
      buttonInjected = false;
      emotesPreloaded = false;
      closePanel();
      _virtualGridDelegated = false;
      cleanup.setTimeout(injectButton, 500);
    }
    window.addEventListener('message', (event) => {
      if (event.source !== window) return
      if (event.origin !== location.origin) return
      if (event.data?.type === 'heatsync-nav') handleButtonNav()
    }, { signal: btnSignal })
    cleanup.setInterval(() => handleButtonNav(), 5000, 'button-nav-fallback');

    // Listen for inventory updates from content script - refresh panel if open (debounced)
    let inventoryRefreshTimeout = null;
    window.addEventListener('message', (event) => {
      if (event.source !== window) return
      if (event.origin !== location.origin) return;
      if (event.data?.type === 'heatsync-inventory-update' && panelOpen) {
        // Debounce: only refresh once per 2 seconds
        if (inventoryRefreshTimeout) return;
        inventoryRefreshTimeout = cleanup.setTimeout(() => {
          inventoryRefreshTimeout = null;
        }, 2000);
        log(' 📦 Inventory updated, refreshing panel');
        loadInventoryEmotes();
      }
    }, { signal: btnSignal });

    // Live picker updates from background: channel emotes arrive progressively
    // (BTTV/FFZ/7TV/Twitch coalesced at 40ms), inventory updates broadcast on
    // every emote add/remove/sub. Listen directly — content script's isolated
    // world has chrome.runtime access, no postMessage bridge needed.
    if (chrome?.runtime?.onMessage) {
      const _onBgMessage = (msg) => {
        if (!msg?.type) return
        // preserveScroll prevents background-driven re-renders from teleporting
        // a mid-scroll user back to the top of the grid.
        const opts = { preserveScroll: true }
        if (msg.type === 'channel_emotes_update' && Array.isArray(msg.emotes)) {
          const owner = (msg.channelOwner || '').toLowerCase()
          if (currentChannel && owner && owner !== currentChannel) return
          channelEmotesCache = msg.emotes
          usingCachedData.channel = false
          isLoading.channel = false
          loadErrors.channel = null
          if (currentChannel && channelEmotesCache.length > 0) setCachedEmotes(`channel:${currentChannel}`, channelEmotesCache)
          updateTabCounts()
          if (panelOpen && currentTab === 'channel') renderEmoteGrid(opts)
        } else if (msg.type === 'global_emotes_update' && Array.isArray(msg.emotes)) {
          globalEmotesCache = msg.emotes
          usingCachedData.global = false
          isLoading.global = false
          loadErrors.global = null
          if (globalEmotesCache.length > 0) setCachedEmotes('global', globalEmotesCache)
          updateTabCounts()
          if (panelOpen && currentTab === 'global') renderEmoteGrid(opts)
        } else if (msg.type === 'inventory_update' && Array.isArray(msg.emotes)) {
          inventoryEmotesCache = msg.emotes
          rebuildInventoryIndex()
          usingCachedData.mine = false
          isLoading.mine = false
          loadErrors.mine = null
          if (inventoryEmotesCache.length > 0) setCachedEmotes('inventory', inventoryEmotesCache)
          updateTabCounts()
          if (panelOpen && currentTab === 'mine') renderEmoteGrid(opts)
        } else if (msg.type === 'blocked_update' && Array.isArray(msg.blocked)) {
          _blockedHashSet = new Set(msg.blocked)
          if (panelOpen) renderEmoteGrid(opts)
        }
      }
      chrome.runtime.onMessage.addListener(_onBgMessage)
      btnSignal.addEventListener('abort', () => chrome.runtime.onMessage.removeListener(_onBgMessage))
    }

    log(' 🔥 Button module initialized');
  }

  // Start when DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { signal: btnSignal });
  } else {
    init();
  }
  }) // end waitForHS
})();
