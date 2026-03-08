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

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c])
  }

  // Lifecycle controller — abort() tears down ALL listeners, timers, observers
  const lifecycle = new AbortController()
  const btnSignal = lifecycle.signal
  const _timers = { intervals: [], timeouts: [], observers: [] }
  btnSignal.addEventListener('abort', () => {
    _timers.intervals.forEach(clearInterval)
    _timers.timeouts.forEach(clearTimeout)
    _timers.observers.forEach(o => o.disconnect())
  })
  window.addEventListener('pagehide', () => lifecycle.abort())

  const cleanup = {
    setInterval(fn, ms) { const id = setInterval(fn, ms); _timers.intervals.push(id); return id },
    setTimeout(fn, ms) { const id = setTimeout(fn, ms); _timers.timeouts.push(id); return id },
    addEventListener(target, event, handler) {
      target.addEventListener(event, handler, { signal: btnSignal })
    },
    trackObserver(obs) { _timers.observers.push(obs); return obs },
  }

  const BUTTON_ID = 'heatsync-chat-button';
  const PANEL_ID = 'heatsync-panel';
  const COGGERS_URL = 'https://cdn.betterttv.net/emote/5ab6f0eba80c0b25ff2495fc/2x';

  const API_URL = 'https://heatsync.org';

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

  // Error and loading state tracking
  let loadErrors = {
    channel: null,
    global: null,
    inventory: null
  };
  let isLoading = {
    channel: false,
    global: false,
    inventory: false
  };
  let isOffline = false;
  let usingCachedData = {
    channel: false,
    global: false,
    inventory: false
  };
  let retryListenerAdded = false; // Prevent duplicate event listeners

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

  // Read auth token from DOM bridge (set by content script, no postMessage leak)
  function getAuthToken() {
    return new Promise((resolve) => {
      const readBridge = () => {
        const bridge = document.getElementById('__heatsync_auth_bridge')
        if (bridge?.dataset.ready === '1') {
          cachedAuthToken = bridge.dataset.token || null
          resolve(cachedAuthToken)
          return true
        }
        return false
      }
      // Bridge may already be ready
      if (readBridge()) return
      // Poll briefly — content script creates it on load
      let attempts = 0
      const interval = setInterval(() => {
        if (readBridge() || ++attempts >= 20) {
          clearInterval(interval)
          if (attempts >= 20) resolve(cachedAuthToken)
        }
      }, 50)
    })
  }

  // Get extension icon URL (works in content script context)
  const getIconUrl = () => {
    if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
      return chrome.runtime.getURL('icon-48.png');
    }
    if (typeof browser !== 'undefined' && browser.runtime?.getURL) {
      return browser.runtime.getURL('icon-48.png');
    }
    return null;
  };

  // Detect current platform
  function detectPlatform() {
    if (window.location.hostname.includes('twitch.tv')) return 'twitch';
    if (window.location.hostname.includes('kick.com')) return 'kick';
    return null;
  }

  // Detect current channel from URL
  function detectChannel() {
    const path = window.location.pathname;
    const platform = detectPlatform();

    if (platform === 'kick') {
      // Kick channel pages: /channelname or /channelname/chatroom
      const match = path.match(/^\/([a-zA-Z0-9_-]+)/);
      if (match && !['categories', 'following', 'settings', 'browse', 'search', 'dashboard'].includes(match[1])) {
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
    btn.setAttribute('aria-label', 'Heatsync');
    btn.setAttribute('data-a-target', 'heatsync-button');
    btn.title = 'heatsync';

    // Use extension logo
    const iconUrl = getIconUrl();
    if (iconUrl) {
      const img = document.createElement('img');
      img.src = iconUrl;
      img.alt = 'heatsync';
      img.style.cssText = 'width: 20px; height: 20px; object-fit: contain;';
      btn.appendChild(img);
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
        border-radius: var(--border-radius-rounded, 9000px);
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
        background-color: var(--color-background-button-text-active, rgba(128, 128, 128, 0.55));
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
        max-height: 500px;
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
        font-size: 12px;
        transition: none;
      }

      .heatsync-header-btn:hover {
        background: #fff;
        border-color: #fff;
        color: #000;
      }

      .heatsync-header-btn.active {
        background: rgba(255, 107, 53, 0.2);
        border-color: #ff6b35;
        color: #ff6b35;
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
        font-size: 12px;
        min-width: 32px;
        transition: none;
      }

      .heatsync-size-btn:hover {
        background: #fff;
        border-color: #fff;
        color: #000;
      }

      .heatsync-size-btn.active {
        background: #ff6b35;
        border-color: #ff6b35;
        color: #fff;
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
        border-color: #ff6b35;
      }

      .heatsync-search input::placeholder {
        color: #808080;
      }

      /* Tabs */
      .heatsync-tabs {
        display: flex;
        border-bottom: 1px solid rgba(255,255,255,0.12);
        background: #000;
      }

      .heatsync-tab {
        flex: 1;
        padding: 10px 8px;
        background: none;
        border: none;
        color: #808080;
        font-size: 12px;
        cursor: pointer;
        border-bottom: 2px solid transparent;
        transition: none;
      }

      .heatsync-tab:hover {
        background: #fff;
        color: #000;
      }

      .heatsync-tab.active {
        color: #fff;
        border-bottom-color: #ff6b35;
      }

      .heatsync-tab-count {
        font-size: 10px;
        color: #808080;
        margin-left: 4px;
      }

      /* Emote grid - virtual scrolling container */
      .heatsync-emote-grid {
        flex: 1;
        overflow-y: auto;
        padding: 8px;
        contain: strict;
        min-height: 300px;
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
      }

      /* Unadded = slightly dimmed */
      .heatsync-emote-wrap.unadded img {
        opacity: 0.7;
      }

      /* Hover: hide image, show background color */
      .heatsync-emote-wrap:hover img {
        visibility: hidden;
      }

      /* Default hover = gold */
      .heatsync-emote-wrap:hover {
        background: #ffcc00;
      }

      /* Unadded emotes = blue */
      .heatsync-emote-wrap.unadded:hover {
        background: #0088ff;
      }

      /* In inventory = green */
      .heatsync-emote-wrap.in-inventory:hover {
        background: #00ff00;
      }

      .heatsync-emote-wrap.in-inventory img {
        opacity: 1;
      }

      /* Blocked emotes: outline on img content area, not wrapper */
      .heatsync-emote-wrap.blocked img {
        opacity: 0;
        outline: 2px dashed #808080 !important;
        outline-offset: -2px !important;
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
        font-size: 10px;
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

      .heatsync-size-toggle:hover,
      .heatsync-refresh-btn:hover {
        background: #fff;
        border-color: #fff;
        color: #000;
      }

      .heatsync-refresh-btn {
        background: none;
        border: 1px solid #808080;
        border-radius: 0;
        color: #808080;
        font-size: 11px;
        padding: 2px 6px;
        cursor: pointer;
        margin-right: 8px;
      }

      .heatsync-refresh-btn.loading {
        opacity: 0.5;
        pointer-events: none;
      }


      .heatsync-empty {
        padding: 40px 20px;
        text-align: center;
        color: #808080;
        font-size: 13px;
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
        background: linear-gradient(135deg, #ff6b35 0%, #f7931a 100%);
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
      .heatsync-emote-preview {
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

      .heatsync-emote-preview img {
        width: 28px;
        height: 28px;
        object-fit: contain;
        border-radius: 0;
        cursor: pointer;
        transition: none;
      }

      .heatsync-emote-preview img:hover {
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

      .heatsync-toggle {
        position: relative;
        width: 40px;
        height: 22px;
        background: rgba(255,255,255,0.06);
        border-radius: 0;
        cursor: pointer;
        transition: none;
        flex-shrink: 0;
      }

      .heatsync-toggle.active {
        background: #ff6b35;
      }

      .heatsync-toggle::after {
        content: '';
        position: absolute;
        top: 2px;
        left: 2px;
        width: 18px;
        height: 18px;
        background: #fff;
        border-radius: 50%;
        transition: none;
      }

      .heatsync-toggle.active::after {
        transform: translateX(18px);
      }

      /* Emote hover preview tooltip */
      .heatsync-emote-hover-preview {
        position: fixed;
        z-index: 5000;
        pointer-events: none;
        background: #000;
        border: 2px solid #ff6b35;
        border-radius: 0;
        padding: 8px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
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
        color: #ff6b35;
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
        background: #1a1a2e;
        border: 1px solid #808080;
        border-radius: 4px;
        padding: 4px 0;
        min-width: 160px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.6);
        font-size: 13px;
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
        background: #808080;
        margin: 4px 0;
      }

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

      // Primary rule: entire message line gets red bg
      rules.push('.chat-line__message.hs-mentioned { background-color: #7f0000 !important; }');
      rules.push('.hs-mentioned.chat-line__message { background-color: #7f0000 !important; }');

      // All children must be transparent so red shows through
      rules.push('.chat-line__message.hs-mentioned * { background-color: transparent !important; background: transparent !important; }');

      // Generic fallback if class is on wrong element
      rules.push('.hs-mentioned { background-color: #7f0000 !important; }');
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

    // DISABLED - welcome message removal was breaking chat layout
    // The parent-walking logic was too aggressive and removed important containers
    // if (settings.hideChatHeader) {
    //   startWelcomeMessageRemoval();
    // } else {
    //   stopWelcomeMessageRemoval();
    // }
    stopWelcomeMessageRemoval(); // Always stop, never start
  }

  // Aggressive welcome message removal
  let welcomeRemovalInterval = null;

  function removeWelcomeMessage() {
    // Only target the specific welcome message element
    const selectors = [
      '[data-a-target="chat-welcome-message"]'
    ];

    let removed = 0;
    selectors.forEach(selector => {
      document.querySelectorAll(selector).forEach(el => {
        // Walk up and remove empty parent wrappers too
        let current = el;
        while (current && current.parentElement) {
          const parent = current.parentElement;
          current.remove();
          removed++;
          // Stop if parent has other children or is a main container
          if (parent.children.length > 0 ||
              parent.classList.contains('chat-scrollable-area__message-container') ||
              parent.classList.contains('chat-list--default') ||
              parent.classList.contains('scrollable-area')) {
            break;
          }
          current = parent;
        }
      });
    });

    if (removed > 0) {
      log(' Removed', removed, 'welcome message elements');
    }
    return removed;
  }

  function startWelcomeMessageRemoval() {
    // Stop any existing interval
    stopWelcomeMessageRemoval();

    // Remove immediately
    removeWelcomeMessage();

    // Keep checking for 10 seconds (Twitch might re-add it)
    let attempts = 0;
    welcomeRemovalInterval = setInterval(() => {
      removeWelcomeMessage();
      attempts++;
      if (attempts >= 20) { // 10 seconds (500ms * 20)
        clearInterval(welcomeRemovalInterval);
        welcomeRemovalInterval = null;
      }
    }, 500);
  }

  function stopWelcomeMessageRemoval() {
    if (welcomeRemovalInterval) {
      clearInterval(welcomeRemovalInterval);
      welcomeRemovalInterval = null;
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
    emotePlaceholderMode: false  // Show colored rectangles instead of emote images
  };

  // Get extension settings (sync - returns cached)
  function getExtensionSettings() {
    return { ...cachedSettings };
  }

  // Load settings from chrome.storage.local (async)
  async function loadExtensionSettings() {
    try {
      const stored = await chrome.storage.local.get('ui_settings');
      if (stored.ui_settings) {
        cachedSettings = { ...cachedSettings, ...stored.ui_settings };
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
      cachedSettings = { ...settings };
      // Save to chrome.storage.local (same key as popup.js)
      chrome.storage.local.set({ ui_settings: settings }).then(() => {
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

  // Listen for settings changes from popup.js or other tabs
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.ui_settings) {
      const newSettings = changes.ui_settings.newValue;
      if (newSettings) {
        cachedSettings = { ...cachedSettings, ...newSettings };
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
          <div class="heatsync-settings-section-title">tab completion</div>

          <div class="heatsync-setting-row">
            <div>
              <div class="heatsync-setting-label">wysiwyg emotes</div>
            </div>
            <div class="heatsync-toggle ${settings.emoteWysiwyg ? 'active' : ''}" data-setting="emoteWysiwyg"></div>
          </div>

          <div class="heatsync-setting-row">
            <div>
              <div class="heatsync-setting-label">space after emote</div>
            </div>
            <div class="heatsync-toggle ${settings.emoteSpaceAfter ? 'active' : ''}" data-setting="emoteSpaceAfter"></div>
          </div>

          <div class="heatsync-setting-row">
            <div>
              <div class="heatsync-setting-label">placeholder mode</div>
              <div class="heatsync-setting-desc">show colored boxes</div>
            </div>
            <div class="heatsync-toggle ${settings.emotePlaceholderMode ? 'active' : ''}" data-setting="emotePlaceholderMode"></div>
          </div>
        </div>

        <div class="heatsync-settings-section">
          <div class="heatsync-settings-section-title">chat ui</div>

          <div class="heatsync-setting-row">
            <div>
              <div class="heatsync-setting-label">hide header <span style="color:#808080;font-size:11px">(always on in popout)</span></div>
            </div>
            <div class="heatsync-toggle ${settings.hideChatHeader ? 'active' : ''}" data-setting="hideChatHeader"></div>
          </div>

          <div class="heatsync-setting-row">
            <div>
              <div class="heatsync-setting-label">compact input</div>
            </div>
            <div class="heatsync-toggle ${settings.compactChatInput ? 'active' : ''}" data-setting="compactChatInput"></div>
          </div>

          <div class="heatsync-setting-row">
            <div>
              <div class="heatsync-setting-label">highlight mentions</div>
            </div>
            <div class="heatsync-toggle ${settings.highlightMentions ? 'active' : ''}" data-setting="highlightMentions"></div>
          </div>
        </div>
      </div>
    `;

    // Add click handlers for toggles
    const toggles = grid.querySelectorAll('.heatsync-toggle');
    toggles.forEach(toggle => {
      toggle.addEventListener('click', () => {
        const settingKey = toggle.dataset.setting;
        const currentSettings = getExtensionSettings();
        currentSettings[settingKey] = !currentSettings[settingKey];
        saveExtensionSettings(currentSettings);
        toggle.classList.toggle('active');
        log(' Setting changed:', settingKey, '=', currentSettings[settingKey]);
      });
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
  async function openPanel() {
    const btn = document.getElementById(BUTTON_ID);
    if (!btn) return;

    // Hydrate blocked set from background
    try {
      const inv = await chrome.runtime.sendMessage({ type: 'get_inventory' });
      if (inv?.blocked) _blockedHashSet = new Set(inv.blocked);
    } catch (err) {}

    // Check if panel already exists (reuse for cached images)
    let panel = document.getElementById(PANEL_ID);
    const channel = detectChannel();

    if (panel) {
      // Reuse existing panel
      panel.style.display = 'flex';
      panelOpen = true;

      // Smart positioning: flip to bottom if button is too high
      const btnRect = btn.getBoundingClientRect();
      const spaceAbove = btnRect.top;
      const spaceBelow = window.innerHeight - btnRect.bottom;
      const panelHeight = 500; // max-height from CSS

      if (spaceAbove < panelHeight && spaceBelow > spaceAbove) {
        // Not enough space above, show below instead
        panel.style.bottom = 'auto';
        panel.style.top = '100%';
        panel.style.marginBottom = '0';
        panel.style.marginTop = '8px';
      } else {
        // Reset to default (above)
        panel.style.bottom = '100%';
        panel.style.top = 'auto';
        panel.style.marginBottom = '8px';
        panel.style.marginTop = '0';
      }

      // Only reload if channel changed
      if (channel !== currentChannel) {
        currentChannel = channel;
        await loadChannelEmotes(channel);
        if (currentTab === 'channel') renderEmoteGrid();
      }

      setTimeout(() => {
        document.addEventListener('click', handleClickOutside);
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

    // Smart positioning: flip to bottom if button is too high
    const btnRect = btn.getBoundingClientRect();
    const spaceAbove = btnRect.top;
    const spaceBelow = window.innerHeight - btnRect.bottom;
    const panelHeight = 500; // max-height from CSS

    if (spaceAbove < panelHeight && spaceBelow > spaceAbove) {
      // Not enough space above, show below instead
      panel.style.bottom = 'auto';
      panel.style.top = '100%';
      panel.style.marginBottom = '0';
      panel.style.marginTop = '8px';
    }

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
        <span><a href="https://heatsync.org" target="_blank">log in</a> to save emotes to your set</span>
      </div>
      ` : ''}
      <div class="heatsync-panel-content">
        <div class="heatsync-tabs">
          <button class="heatsync-tab active" data-tab="channel">
            channel<span class="heatsync-tab-count" id="count-channel">...</span>
          </button>
          <button class="heatsync-tab" data-tab="global">
            global<span class="heatsync-tab-count" id="count-global">...</span>
          </button>
          <button class="heatsync-tab" data-tab="mine">
            mine<span class="heatsync-tab-count" id="count-mine">...</span>
          </button>
        </div>
        <div class="heatsync-emote-grid" id="heatsync-emote-grid">
          <div class="heatsync-empty">loading...</div>
        </div>
      </div>
      <div class="heatsync-panel-bottom">
        <div class="heatsync-search">
          <input type="text" id="heatsync-search" placeholder="search emotes..." autocomplete="off">
        </div>
        <div class="heatsync-panel-footer">
          <div class="heatsync-size-buttons">
            <button class="heatsync-size-btn" data-size="1x">1x</button>
            <button class="heatsync-size-btn" data-size="2x">2x</button>
            <button class="heatsync-size-btn active" data-size="4x">4x</button>
          </div>
          <div style="display:flex;gap:4px;align-items:center;">
            <button class="heatsync-settings-cog" id="heatsync-rotate-btn" title="rotate tab bar position">
              <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M7.11 8.53L5.7 7.11C4.8 8.27 4.24 9.61 4.07 11h2.02c.14-.87.49-1.72 1.02-2.47zM6.09 13H4.07c.17 1.39.72 2.73 1.62 3.89l1.41-1.42c-.52-.75-.88-1.6-1.01-2.47zM7.1 18.32c1.16.9 2.51 1.44 3.9 1.61V17.9c-.87-.15-1.71-.49-2.46-1.03L7.1 18.32zM13 4.07V1l-4 4 4 4V6.09c2.84.48 5 2.94 5 5.91s-2.16 5.43-5 5.91v2.02c3.95-.49 7-3.85 7-7.93s-3.05-7.44-7-7.93z"/></svg>
            </button>
            <button class="heatsync-settings-cog" id="heatsync-settings-btn" title="settings">
              <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>
            </button>
          </div>
        </div>
      </div>
    `;

    container.appendChild(panel);
    panelOpen = true;

    // Close button handler
    panel.querySelector('.heatsync-panel-close').addEventListener('click', closePanel);

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
    settingsBtn.addEventListener('click', () => {
      // Toggle settings view
      if (currentTab === 'settings') {
        // Go back to previous tab (default to channel)
        currentTab = 'channel';
        panel.querySelectorAll('.heatsync-tab').forEach(t => t.classList.remove('active'));
        panel.querySelector('.heatsync-tab[data-tab="channel"]').classList.add('active');
        settingsBtn.classList.remove('active');
        renderEmoteGrid();
      } else {
        currentTab = 'settings';
        panel.querySelectorAll('.heatsync-tab').forEach(t => t.classList.remove('active'));
        settingsBtn.classList.add('active');
        renderSettings();
      }
    });

    // Rotate tab position button
    const rotateBtn = panel.querySelector('#heatsync-rotate-btn');
    rotateBtn.addEventListener('click', () => {
      window.postMessage({ type: 'heatsync-rotate-tabs' }, location.origin);
    });

    // Tab handlers
    panel.querySelectorAll('.heatsync-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        currentTab = tab.dataset.tab;
        panel.querySelectorAll('.heatsync-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        settingsBtn.classList.remove('active');
        renderEmoteGrid();
      });
    });

    // Search handler (debounced 150ms)
    let _searchDebounce = null
    const searchInput = panel.querySelector('#heatsync-search');
    searchInput.addEventListener('input', (e) => {
      searchQuery = e.target.value.toLowerCase();
      clearTimeout(_searchDebounce)
      _searchDebounce = setTimeout(() => renderEmoteGrid(), 150)
    });

    // Close on click outside
    setTimeout(() => {
      document.addEventListener('click', handleClickOutside);
    }, 10);

    // Retry event listener for error states (only add once)
    if (!retryListenerAdded) {
      retryListenerAdded = true;
      window.addEventListener('heatsync-retry', async (e) => {
        const tab = e.detail;
        log(' Retrying load for tab:', tab);
        if (tab === 'channel') {
          await loadChannelEmotes(currentChannel);
        } else if (tab === 'global') {
          await loadGlobalEmotes();
        } else if (tab === 'mine' || tab === 'inventory') {
          await loadInventoryEmotes();
        }
        renderEmoteGrid();
      });
    }

    // Load all emotes
    currentTab = 'channel';
    await Promise.all([
      loadChannelEmotes(channel),
      loadGlobalEmotes(),
      loadInventoryEmotes()
    ]);
    renderEmoteGrid();
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

  // Preloading disabled — new Image() in content scripts uses moz-extension:// origin,
  // Firefox ORB blocks those opaque responses and poisons the browser cache, causing
  // actual <img> elements in chat to show as broken. Browser caches images natively
  // after first render in the emote picker grid.
  function preloadImages(urls, showProgress = false) {
    return Promise.resolve();
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

  function renderEmoteGrid() {
    const grid = document.getElementById('heatsync-emote-grid');
    if (!grid) return;

    // Check login state
    const isLoggedIn = cachedAuthToken !== null;

    // Check for errors first
    const currentError = loadErrors[currentTab];
    const currentLoading = isLoading[currentTab];
    const isCached = usingCachedData[currentTab];

    if (currentError && !currentLoading) {
      grid.innerHTML = `
        <div class="heatsync-error-state">
          <div class="heatsync-error-icon">⚠️</div>
          <div class="heatsync-error-msg">${currentError}</div>
          <button class="heatsync-retry-btn" onclick="window.dispatchEvent(new CustomEvent('heatsync-retry', {detail: '${currentTab}'}))">
            retry
          </button>
        </div>
      `;
      return;
    }

    if (currentLoading) {
      grid.innerHTML = `<div class="heatsync-empty">loading...</div>`;
      return;
    }

    let emotes = [];
    if (currentTab === 'channel') {
      emotes = channelEmotesCache;
    } else if (currentTab === 'global') {
      emotes = globalEmotesCache;
    } else if (currentTab === 'mine') {
      emotes = inventoryEmotesCache;
    }

    // Filter by search
    if (searchQuery) {
      emotes = emotes.filter(e => e.name.toLowerCase().includes(searchQuery));
    }

    if (emotes.length === 0) {
      if (currentTab === 'mine' && !isLoggedIn) {
        grid.innerHTML = `<div class="heatsync-login-msg">log in at <a href="https://heatsync.org" target="_blank">heatsync.org</a> to save emotes</div>`;
      } else {
        grid.innerHTML = `<div class="heatsync-empty">${searchQuery ? 'no matches' : 'no emotes'}</div>`;
      }
      return;
    }

    // Show cached badge if using stale data
    if (isCached) {
      const countEl = document.getElementById(`count-${currentTab}`);
      if (countEl && !countEl.querySelector('.heatsync-cached-badge')) {
        countEl.innerHTML += `<span class="heatsync-cached-badge">cached</span>`;
      }
    }

    // Get current size for resolution
    const currentSize = localStorage.getItem('heatsync-emote-size') || '1x';

    // Prepare emotes with resolution-appropriate URLs
    const pickerEmotes = emotes.map(e => ({
      ...e,
      pickerUrl: getResolutionUrl(getAnimatedUrl(e.url), currentSize)
    }));

    grid.innerHTML = '';
    grid.style.display = 'flex';
    grid.style.flexWrap = 'wrap';
    grid.style.gap = '4px';
    grid.style.alignContent = 'start';

    // Create emote element (placeholder until visible)
    function createEmoteElement(e, index) {
      const wrap = document.createElement('div');
      const providerClass = getProviderClass(e.provider);
      const inInventory = isInInventory(e);
      const isGlobal = currentTab === 'global';

      wrap.className = `heatsync-emote-wrap ${providerClass}`;
      wrap.style.minWidth = '32px';
      wrap.style.minHeight = '32px';
      wrap.dataset.index = index;

      if (isGlobal) {
        wrap.classList.add('global-emote');
      } else if (inInventory) {
        wrap.classList.add('in-inventory');
      } else if (currentTab !== 'mine') {
        wrap.classList.add('unadded');
      }

      // Click to insert
      wrap.addEventListener('click', () => {
        if (!isGlobal && !inInventory && isLoggedIn && currentTab !== 'mine') {
          addEmoteToInventorySilent(e).then(() => insertEmoteIntoChat(e.name));
        } else {
          insertEmoteIntoChat(e.name);
        }
      });

      // Right-click context menu
      wrap.addEventListener('contextmenu', (evt) => {
        showContextMenu(evt, e, currentTab);
      });

      // Hover preview - show 4x version above emote
      let previewTooltip = null;
      wrap.addEventListener('mouseenter', () => {
        // Create preview tooltip
        previewTooltip = document.createElement('div');
        previewTooltip.className = 'heatsync-emote-hover-preview';

        const previewImg = document.createElement('img');
        previewImg.referrerPolicy = 'no-referrer';
        const previewUrl = getResolutionUrl(getAnimatedUrl(e.url), '4x');
        previewImg.src = previewUrl;
        previewImg.alt = e.name;

        const nameLabel = document.createElement('div');
        nameLabel.className = 'heatsync-emote-hover-preview-name';
        nameLabel.textContent = e.name;

        previewTooltip.appendChild(previewImg);
        previewTooltip.appendChild(nameLabel);
        document.body.appendChild(previewTooltip);

        // Wait for image to load to get accurate dimensions
        previewImg.onload = () => {
          // Position above the emote
          const rect = wrap.getBoundingClientRect();
          const tooltipRect = previewTooltip.getBoundingClientRect();

          // Center horizontally above the emote
          let left = rect.left + (rect.width / 2) - (tooltipRect.width / 2);
          let top = rect.top - tooltipRect.height - 8;

          // Keep tooltip within viewport horizontally
          const padding = 8;
          if (left < padding) {
            left = padding;
          } else if (left + tooltipRect.width > window.innerWidth - padding) {
            left = window.innerWidth - tooltipRect.width - padding;
          }

          // Keep tooltip within viewport vertically
          if (top < padding) {
            // If not enough space above, show below instead
            top = rect.bottom + 8;
          }

          previewTooltip.style.left = `${left}px`;
          previewTooltip.style.top = `${top}px`;
        };

        // Set initial position immediately (will be adjusted after image loads)
        const rect = wrap.getBoundingClientRect();
        previewTooltip.style.left = `${rect.left}px`;
        previewTooltip.style.top = `${rect.top - 20}px`;
      });

      wrap.addEventListener('mouseleave', () => {
        if (previewTooltip && previewTooltip.parentNode) {
          previewTooltip.remove();
          previewTooltip = null;
        }
      });

      return wrap;
    }

    // Build all emotes at once with images - no lazy loading
    const fragment = document.createDocumentFragment();

    for (let i = 0; i < pickerEmotes.length; i++) {
      const e = pickerEmotes[i];
      const wrap = createEmoteElement(e, i);

      // Create img immediately
      const img = document.createElement('img');
      img.referrerPolicy = 'no-referrer';
      img.loading = 'eager';
      img.decoding = 'async';
      img.src = e.pickerUrl;
      img.alt = e.name;
      img.title = e.name;
      wrap.appendChild(img);

      fragment.appendChild(wrap);
    }

    // Single DOM write
    grid.appendChild(fragment);
  }

  // Silent add to inventory (no UI feedback, used for click-to-use)
  async function addEmoteToInventorySilent(emote) {
    try {
      const token = await getAuthToken();
      if (!token) return;

      await HS.apiFetch('/api/user/emotes/import', {
        method: 'POST',
        auth: true,
        body: {
          emotes: [{
            name: emote.name,
            url: emote.url || emote.pickerUrl,
            provider: emote.provider || 'imported',
            id: emote.id || emote.hash || ''
          }],
          source: `picker:click`
        }
      });

      // Refresh inventory
      await loadInventoryEmotes();
    } catch (err) {
    }
  }

  // Update tab counts
  function updateTabCounts() {
    const countChannel = document.getElementById('count-channel');
    const countGlobal = document.getElementById('count-global');
    const countMine = document.getElementById('count-mine');
    if (countChannel) countChannel.textContent = channelEmotesCache.length || '0';
    if (countGlobal) countGlobal.textContent = globalEmotesCache.length || '0';
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

      // Remove from current view
      if (currentTab === 'channel') {
        channelEmotesCache = channelEmotesCache.filter(e => e.name !== emote.name);
      } else if (currentTab === 'global') {
        globalEmotesCache = globalEmotesCache.filter(e => e.name !== emote.name);
      }

      updateTabCounts();
      renderEmoteGrid();

    } catch (err) {
      if (err.message?.includes('Extension context invalidated')) {
        const toast = document.createElement('div');
        toast.textContent = 'Extension updated — please refresh the page';
        toast.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#f44;color:#fff;padding:8px 16px;border-radius:4px;z-index:99999;font-size:14px;';
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
    const msgsEl = document.getElementById('hs-mc-messages');
    if (!msgsEl) return;
    const div = document.createElement('div');
    div.className = 'hs-mc-msg hs-mc-system';
    div.textContent = msg;
    msgsEl.appendChild(div);
    // Trim oldest
    while (msgsEl.children.length > 150) msgsEl.removeChild(msgsEl.firstChild);
    // Auto-scroll if not scrolled up
    msgsEl.scrollTop = msgsEl.scrollHeight;
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

    // Block / unblock
    if (tab !== 'mine') {
      const blockBtn = document.createElement('button');
      blockBtn.className = 'hs-emote-ctx-item';
      blockBtn.textContent = isBlocked ? 'unblock emote' : 'block emote';
      blockBtn.addEventListener('click', async () => {
        dismissContextMenu();
        if (isBlocked) {
          try {
            await chrome.runtime.sendMessage({ type: 'unblock_emote', hash });
            _blockedHashSet.delete(hash);
            showPickerToast('unblocked');
          } catch (err) {
            if (err.message?.includes('Extension context invalidated')) {
              const toast = document.createElement('div');
              toast.textContent = 'Extension updated — please refresh the page';
              toast.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#f44;color:#fff;padding:8px 16px;border-radius:4px;z-index:99999;font-size:14px;';
              document.body.appendChild(toast);
              setTimeout(() => toast.remove(), 5000);
            }
            log('Unblock failed:', err.message);
          }
        } else {
          blockEmote(emote);
          _blockedHashSet.add(hash);
          showPickerToast('blocked');
        }
      });
      menu.appendChild(blockBtn);
    }

    // Add / remove from inventory
    if (tab === 'mine' || inInv) {
      const removeBtn = document.createElement('button');
      removeBtn.className = 'hs-emote-ctx-item';
      removeBtn.textContent = 'remove from inventory';
      removeBtn.addEventListener('click', async () => {
        dismissContextMenu();
        try {
          await chrome.runtime.sendMessage({ type: 'remove_from_inventory', emoteHash: hash, emoteName: emote.name });
          showPickerToast('removed');
          if (tab === 'mine') {
            inventoryEmotesCache = inventoryEmotesCache.filter(e => e.name !== emote.name);
            rebuildInventoryIndex()
            updateTabCounts();
            renderEmoteGrid();
          }
        } catch (err) {
          if (err.message?.includes('Extension context invalidated')) {
            const toast = document.createElement('div');
            toast.textContent = 'Extension updated — please refresh the page';
            toast.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#f44;color:#fff;padding:8px 16px;border-radius:4px;z-index:99999;font-size:14px;';
            document.body.appendChild(toast);
            setTimeout(() => toast.remove(), 5000);
          }
          log('Remove failed:', err.message);
        }
      });
      menu.appendChild(removeBtn);
    } else if (cachedAuthToken) {
      const addBtn = document.createElement('button');
      addBtn.className = 'hs-emote-ctx-item';
      addBtn.textContent = 'add to inventory';
      addBtn.addEventListener('click', () => {
        dismissContextMenu();
        addEmoteToInventorySilent(emote);
        showPickerToast('added');
      });
      menu.appendChild(addBtn);
    }

    // Separator
    const sep = document.createElement('div');
    sep.className = 'hs-emote-ctx-sep';
    menu.appendChild(sep);

    // Copy name
    const copyName = document.createElement('button');
    copyName.className = 'hs-emote-ctx-item';
    copyName.textContent = 'copy emote name';
    copyName.addEventListener('click', () => {
      dismissContextMenu();
      navigator.clipboard.writeText(emote.name).catch(() => {});
      showPickerToast('copied!');
    });
    menu.appendChild(copyName);

    // Copy URL
    const copyUrl = document.createElement('button');
    copyUrl.className = 'hs-emote-ctx-item';
    copyUrl.textContent = 'copy emote url';
    copyUrl.addEventListener('click', () => {
      dismissContextMenu();
      navigator.clipboard.writeText(emote.url || emote.pickerUrl || '').catch(() => {});
      showPickerToast('copied!');
    });
    menu.appendChild(copyUrl);

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
    if (_ctxMenu && e.key === 'Escape') dismissContextMenu();
  }, { signal: btnSignal });

  // Sync blocked hash set from content.js
  window.addEventListener('message', (event) => {
    if (event.origin !== location.origin) return;
    if (event.data?.type === 'heatsync-blocked-sync' && Array.isArray(event.data.hashes)) {
      _blockedHashSet = new Set(event.data.hashes);
    }
  }, { signal: btnSignal });

  // Load user's inventory emotes
  async function loadInventoryEmotes() {
    isLoading.inventory = true;
    loadErrors.inventory = null;

    try {
      const token = await getAuthToken();
      if (!token) {
        inventoryEmotesCache = [];
        rebuildInventoryIndex()
        loadErrors.inventory = null; // Not an error, just not logged in
        updateTabCounts();
        return;
      }

      const data = await HS.apiFetch('/api/user/emotes', { auth: true });
      inventoryEmotesCache = data.emotes || [];
      rebuildInventoryIndex()
      loadErrors.inventory = null;
      updateTabCounts();

    } catch (err) {
      inventoryEmotesCache = [];
      rebuildInventoryIndex()
      loadErrors.inventory = 'failed to load your emotes';
      updateTabCounts();
    } finally {
      isLoading.inventory = false;
    }
  }

  // Load channel emotes (7TV/BTTV/FFZ) - stale-while-revalidate
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

    // Show cached immediately if available
    const cached = await getCachedEmotes(cacheKey);
    if (cached) {
      channelEmotesCache = cached;
      usingCachedData.channel = true;
      log(' Loaded', channelEmotesCache.length, 'channel emotes (cached)');
      updateTabCounts();
      // Don't render here - let openPanel() handle single render after all loads
    }

    // Always fetch fresh in background
    try {
      const data = await HS.apiFetch(`/api/channel/${channel}/emotes`);
      const freshEmotes = data.emotes || [];

      // Update if different (skip expensive JSON comparison, just update)
      channelEmotesCache = freshEmotes;
      log(' Updated', channelEmotesCache.length, 'channel emotes (fresh)');
      updateTabCounts();

      // Clear cached flag and error
      usingCachedData.channel = false;
      loadErrors.channel = null;

      // Always update cache
      setCachedEmotes(cacheKey, freshEmotes);

    } catch (err) {
      if (!cached) {
        channelEmotesCache = [];
        loadErrors.channel = 'failed to load channel emotes';
        updateTabCounts();
      }
      // If we have cached data, keep using it but don't show error
    } finally {
      isLoading.channel = false;
    }
  }

  // Load global emotes (BTTV/FFZ globals) - stale-while-revalidate
  async function loadGlobalEmotes() {
    const cacheKey = 'global';
    isLoading.global = true;
    loadErrors.global = null;
    usingCachedData.global = false;

    // Show cached immediately if available
    const cached = await getCachedEmotes(cacheKey);
    if (cached) {
      globalEmotesCache = cached;
      usingCachedData.global = true;
      log(' Loaded', globalEmotesCache.length, 'global emotes (cached)');
      updateTabCounts();
    }

    // Always fetch fresh in background
    try {
      const data = await HS.apiFetch('/api/emotes/global');
      const freshEmotes = data.emotes || [];

      globalEmotesCache = freshEmotes;
      log(' Updated', globalEmotesCache.length, 'global emotes (fresh)');
      updateTabCounts();

      // Clear cached flag and error
      usingCachedData.global = false;
      loadErrors.global = null;

      // Always update cache
      setCachedEmotes(cacheKey, freshEmotes);

    } catch (err) {
      if (!cached) {
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
    const platform = detectPlatform();

    let chatInput;
    if (platform === 'kick') {
      // Kick uses a regular input or textarea
      chatInput = document.querySelector('#message-input, [data-chat-entry-input], textarea[placeholder*="message"], input[placeholder*="message"]');
    } else {
      // Twitch uses contenteditable
      chatInput = document.querySelector('[data-a-target="chat-input"]');
    }

    if (!chatInput) {
      return;
    }

    if (platform === 'kick') {
      // Kick: regular input/textarea
      const currentText = chatInput.value || '';
      const needsSpace = currentText.length > 0 && !currentText.endsWith(' ');
      const textToInsert = (needsSpace ? ' ' : '') + emoteName + ' ';

      chatInput.focus();
      chatInput.value = currentText + textToInsert;

      // Trigger input event for React
      chatInput.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      // Twitch: contenteditable
      const currentText = chatInput.textContent || '';
      const needsSpace = currentText.length > 0 && !currentText.endsWith(' ');
      const textToInsert = (needsSpace ? ' ' : '') + emoteName + ' ';

      chatInput.focus();
      document.execCommand('insertText', false, textToInsert);
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
    if (panel && !panel.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
      closePanel();
    }
  }

  // Load channel emote preview (7TV, BTTV, FFZ)
  async function loadChannelEmotePreview(channel) {
    log(' loadChannelEmotePreview called for:', channel);
    const previewEl = document.getElementById('heatsync-emote-preview');
    if (!previewEl) {
      log(' previewEl not found, aborting');
      return;
    }

    const importBtn = document.getElementById('heatsync-import-channel');
    if (importBtn) {
      importBtn.disabled = true;
      importBtn.innerHTML = `<span class="heatsync-status loading">loading emotes</span>`;
    }

    try {
      // Fetch from our API (aggregates 7TV, BTTV, FFZ)
      const fetchUrl = `/api/channel/${channel}/emotes`;
      log(' Fetching:', fetchUrl);
      const data = await HS.apiFetch(fetchUrl);
      log(' API returned:', data.count, 'emotes');
      const emotes = data.emotes || [];
      channelEmotesCache = emotes;

      if (emotes.length === 0) {
        previewEl.innerHTML = '<div class="heatsync-status">no third-party emotes found</div>';
        previewEl.style.display = 'block';
        if (importBtn) {
          importBtn.disabled = true;
          importBtn.textContent = 'no emotes to import';
        }
        return;
      }

      // Build provider summary
      const providers = {};
      emotes.forEach(e => {
        const p = e.provider || 'unknown';
        providers[p] = (providers[p] || 0) + 1;
      });

      // Show preview grid (first 24 emotes)
      const previewEmotes = emotes.slice(0, 24);
      previewEl.innerHTML = previewEmotes.map(e =>
        `<img src="${e.url}" alt="${escapeHtml(e.name)}" title="${escapeHtml(e.name)} (${escapeHtml(e.provider)})" loading="lazy" referrerpolicy="no-referrer">`
      ).join('');
      previewEl.style.display = 'grid';

      // Update import button
      if (importBtn) {
        importBtn.disabled = false;
        const providerBadges = Object.entries(providers)
          .map(([p, count]) => `<span class="heatsync-provider ${escapeHtml(p.toLowerCase())}">${escapeHtml(p)}</span>`)
          .join('');
        importBtn.innerHTML = `
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 5v14M5 12h14"/>
          </svg>
          import ${emotes.length} emotes
          <span class="heatsync-emote-count">${providerBadges}</span>
        `;
      }

    } catch (err) {
      previewEl.innerHTML = '<div class="heatsync-status">failed to load emotes</div>';
      previewEl.style.display = 'block';
      if (importBtn) {
        importBtn.disabled = false;
        importBtn.innerHTML = `
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 5v14M5 12h14"/>
          </svg>
          retry loading
        `;
      }
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
    const emoteBtn = document.querySelector('[data-a-target="emote-picker-button"]');
    if (!emoteBtn) {
      log(' Emote picker button not found yet');
      return;
    }

    const btn = createButton();

    // Insert our button right AFTER Twitch's emote button (keep both)
    emoteBtn.parentElement.insertBefore(btn, emoteBtn.nextSibling);

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
      await Promise.all([
        loadChannelEmotes(channel),
        loadGlobalEmotes(),
        loadInventoryEmotes()
      ]);

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

    // Watch for SPA navigation
    let lastUrl = location.href;
    cleanup.trackObserver(new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        buttonInjected = false;
        emotesPreloaded = false; // Reset so emotes reload for new channel
        closePanel();
        cleanup.setTimeout(injectButton, 500, 'button-nav-reinject');
      }
    }), 'button-nav-observer').observe(document.body, { childList: true, subtree: true });

    // Listen for inventory updates from content script - refresh panel if open (debounced)
    let inventoryRefreshTimeout = null;
    window.addEventListener('message', (event) => {
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

    log(' 🔥 Button module initialized');
  }

  // Start when DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { signal: btnSignal });
  } else {
    init();
  }
})();
