/**
 * Centralized configuration and constants for heatsync extension.
 * No more magic numbers scattered throughout the codebase.
 */

// ============================================
// API ENDPOINTS
// ============================================

export const API_URL = 'https://heatsync.org'
export const WS_URL = 'wss://heatsync.org'

// ============================================
// TIMING CONSTANTS
// ============================================

export const TIMING = {
  // Polling intervals
  EMOTE_SCAN_INTERVAL: 10000,     // Scan for new emotes
  HEALTH_CHECK_INTERVAL: 30000,   // Background health check
  RETRY_INTERVAL: 2000,           // Retry failed operations
  URL_CHECK_INTERVAL: 1000,       // SPA navigation detection

  // Debounce/throttle
  SCROLL_THROTTLE: 16,            // ~60fps for scroll handlers
  RESIZE_DEBOUNCE: 100,           // Resize handler debounce
  INPUT_DEBOUNCE: 150,            // Input handler debounce
  HOVER_DEBOUNCE: 100,            // Hover state debounce

  // Timeouts
  API_TIMEOUT: 10000,             // API request timeout
  ELEMENT_WAIT_TIMEOUT: 5000,     // Wait for DOM element
  RECONNECT_DELAY: 5000,          // WebSocket reconnect delay
  INIT_DELAY: 500,                // Initial setup delay

  // Animation
  TOOLTIP_DELAY: 200,             // Tooltip show delay
  FADE_DURATION: 150,             // Fade in/out duration
}

// ============================================
// LIMITS
// ============================================

export const LIMITS = {
  // Cache sizes
  MAX_CACHED_USERS: 200,          // Username autocomplete cache
  MAX_CACHED_EMOTES: 1000,        // Emote cache
  MAX_PROFILE_CACHE: 100,         // Profile preview cache

  // Message limits
  MAX_MESSAGE_LENGTH: 500,        // Chat message max length
  MAX_MESSAGES_BUFFER: 500,       // Circular buffer size

  // Performance
  MAX_DOM_BATCH: 50,              // Max DOM mutations per frame
  MAX_FIBER_DEPTH: 50,            // React fiber traversal depth
}

// ============================================
// DOM SELECTORS
// ============================================

export const SELECTORS = {
  // Twitch chat
  TWITCH_CHAT_CONTAINER: [
    '[class*="chat-room__content"]',
    '[data-test-selector="chat-room-component"]',
    '[class*="stream-chat"]',
    '.chat-shell',
    '.chat-room'
  ].join(', '),

  TWITCH_CHAT_INPUT: '[data-a-target="chat-input"]',
  TWITCH_CHAT_MESSAGES: '[class*="chat-scrollable-area__message-container"]',
  TWITCH_USERNAME: '.chat-author__display-name',

  // Kick chat
  KICK_CHAT_CONTAINER: '#chatroom',
  KICK_CHAT_INPUT: '[data-testid="chat-input"]',
  KICK_CHAT_MESSAGES: '#chatroom-messages',

  // Profile elements
  PROFILE_AVATAR: '[class*="avatar"]',
  PROFILE_CARD: '[class*="viewer-card"]',
}

// ============================================
// CSS CLASSES
// ============================================

export const CLASSES = {
  // Injected elements
  HEATSYNC_BUTTON: 'heatsync-emote-button',
  HEATSYNC_PANEL: 'heatsync-emote-panel',
  HEATSYNC_TOOLTIP: 'heatsync-tooltip',
  HEATSYNC_EMOTE: 'heatsync-emote',
  HEATSYNC_BADGE: 'heatsync-badge',

  // States
  ACTIVE: 'heatsync-active',
  LOADING: 'heatsync-loading',
  ERROR: 'heatsync-error',
  HIDDEN: 'heatsync-hidden',
}

// ============================================
// Z-INDEX LAYERS
// ============================================

export const Z_INDEX = {
  TOOLTIP: 10000,
  POPUP: 10001,
  PANEL: 10002,
  MODAL: 10003,
  OVERLAY: 10004,
}

// ============================================
// EMOTE PROVIDERS
// ============================================

export const EMOTE_PROVIDERS = {
  HEATSYNC: 'heatsync',
  BTTV: 'bttv',
  FFZ: 'ffz',
  SEVENTV: '7tv',
  TWITCH: 'twitch',
  KICK: 'kick',
}

// ============================================
// STORAGE KEYS
// ============================================

export const STORAGE_KEYS = {
  AUTH_TOKEN: 'auth_token',
  USER_SETTINGS: 'user_settings',
  EMOTE_CACHE: 'emote_cache',
  LAST_SYNC: 'last_sync',
  DEBUG_MODE: 'heatsync_debug',
}

// ============================================
// MESSAGE TYPES (for postMessage)
// ============================================

export const MESSAGE_TYPES = {
  AUTH_REQUEST: 'heatsync-auth-request',
  AUTH_RESPONSE: 'heatsync-auth-response',
  EMOTE_INSERT: 'heatsync-emote-insert',
  SETTINGS_UPDATE: 'heatsync-settings-update',
}

// Export all as default config object
const config = {
  API_URL,
  WS_URL,
  TIMING,
  LIMITS,
  SELECTORS,
  CLASSES,
  Z_INDEX,
  EMOTE_PROVIDERS,
  STORAGE_KEYS,
  MESSAGE_TYPES,
}

// Global export
if (typeof window !== 'undefined') {
  window.heatsyncConfig = config
}

export default config
