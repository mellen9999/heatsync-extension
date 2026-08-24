// @ts-check
/**
 * Centralized configuration for heatsync extension.
 * All URLs, timing constants, limits, selectors, CSS classes, and z-index values.
 *
 * Bundled at IIFE scope into content scripts — use window.heatsyncConfig to access.
 */

const CONFIG = {
  // ─── API / WebSocket ────────────────────────────────────────────────────────

  API_URL: 'https://heatsync.org',
  WS_URL: 'wss://heatsync.org', // /ws appended at connect time
  LINK_PREVIEW_API: 'https://heatsync.org/api/link-preview',
  LIVE_STATUS_API: 'https://heatsync.org/api/platform/live-status',

  // Third-party CDN / API base URLs
  CDN_7TV: 'https://cdn.7tv.app',
  CDN_BTTV: 'https://cdn.betterttv.net',
  API_7TV: 'https://7tv.io/v3',
  WS_7TV: 'wss://events.7tv.io/v3',
  API_BTTV: 'https://api.betterttv.net/3',
  API_FFZ: 'https://api.frankerfacez.com/v1',
  API_RESOLVE_TWITCH: 'https://heatsync.org/api/resolve/twitch',
  API_TWITCH_GQL: 'https://gql.twitch.tv/gql',
  API_TWITCH_HELIX: 'https://api.twitch.tv/helix',
  API_RECENT_MSGS: 'https://heatsync.org/api/recent-messages',
  API_CHATTERINO_BADGES: 'https://heatsync.org/api/chatterino-badges',
  WS_TWITCH_IRC: 'wss://irc-ws.chat.twitch.tv:443',

  // ─── Timing ─────────────────────────────────────────────────────────────────

  TIMING: {
    // Inventory + global emote refresh
    INVENTORY_REFRESH: 60000, // 1 min — background.js setInterval
    GLOBAL_EMOTES_REFRESH: 86400000, // 24 hr
    INVENTORY_REFRESH_DEBOUNCE: 2000, // debounce WS-triggered inventory refresh
    INVENTORY_SKIP_THRESHOLD: 10000, // skip fetch if last one was <10s ago

    // Cache TTLs (background.js)
    CHANNEL_EMOTES_TTL: 30 * 60 * 1000, // 30 min
    CHANNEL_EMOTES_EMPTY_TTL: 5 * 60 * 1000, // 5 min for zero-result channels
    BADGES_TTL: 24 * 60 * 60 * 1000, // 24 hr
    USER_COSMETICS_TTL: 30 * 60 * 1000, // 30 min

    // WS / connection (background.js)
    WS_CONNECT_TIMEOUT: 10000,
    WS_HEARTBEAT_INTERVAL: 90000, // well within server's 2 min idle timeout
    WS_RECONNECT_MAX_DELAY: 30000,
    WS_7TV_RECONNECT_MAX_DELAY: 30000,
    WS_7TV_RECONNECT_JITTER: 1000,
    WS_7TV_OFFLINE_TIMEOUT: 600000, // stop reconnecting after 10 min offline
    SEVENTV_POLL_INTERVAL: 30000,

    // Message queue (background.js — value mirrored there too)
    MESSAGE_QUEUE_TTL: 60000, // matches max reconnect backoff + jitter

    // Mute / prune
    MUTE_PRUNE_INTERVAL: 60000,

    // Content script timings (content.js)
    HEAT_CACHE_TTL: 120000, // 2 min
    HEAT_BATCH_INTERVAL: 2000, // debounce for heat batch fetches
    HEAT_CACHE_PRUNE_INTERVAL: 300000, // 5 min
    COSMETICS_TTL: 30 * 60 * 1000, // 30 min
    BROADCAST_TTL: 30000, // drop duplicate broadcasts after 30s
    BROADCAST_PRUNE_INTERVAL: 30000,
    REPROCESS_DEBOUNCE: 200,
    TOAST_DURATION: 2500,
    USERNAME_RETRY_BASE_DELAY: 2000, // backoff start for username detection
    USERNAME_RETRY_MAX_DELAY: 10000,
    PROFILE_TTL: 300000, // 5 min
    PROFILE_CACHE_MAX_AGE: 60000, // live channel profile TTL override: 60s
    FOLLOWAGE_CACHE_TTL: 300000, // 5 min

    // Multichat (multichat.js)
    MC_CONNECT_TIMEOUT: 10000,
    MC_FETCH_TIMEOUT: 15000,
    MC_RETRY_DELAY_BASE: 1500,
    MC_IRC_HEARTBEAT: 30000,
    MC_IRC_ZOMBIE_THRESHOLD: 90000, // silence before reconnect
    MC_IRC_RECONNECT_MAX_DELAY: 30000,
    MC_IRC_RECONNECT_INITIAL: 2000,
    MC_RECENT_MSGS_CACHE_TTL: 300000, // 5 min
    MC_PROFILE_CACHE_TTL: 60000,
    MC_EMOTE_SCAN_INTERVAL: 10000,
    MC_AUTH_RECONNECT_INITIAL: 1000,
    MC_AUTH_RECONNECT_MAX_DELAY: 30000,
    MC_WHISPER_SEND_TIMEOUT: 8000,

    // General fetch default
    FETCH_TIMEOUT: 10000,
    LINK_PREVIEW_TIMEOUT: 6000,
    LIVE_STATUS_TIMEOUT: 6000,
    KICK_API_TIMEOUT: 5000,
  },

  // ─── Limits / caps ──────────────────────────────────────────────────────────

  LIMITS: {
    // Emote caches (background.js)
    MAX_EMOTE_NAME_LEN: 100,
    MAX_EMOTES_PER_SOURCE: 5000,
    USER_COSMETICS_MAX: 500,
    TWITCH_ID_CACHE_MAX: 200,
    MAX_YT_VIDEO_ENTRIES: 100, // LRU cap for ytVideoToChannel map
    SEVENTV_MAX_RECONNECT_ATTEMPTS: 5,

    // Multichat (multichat.js)
    MAX_SEND_QUEUE: 50, // IRC send queue cap
    MC_EMOTE_CACHE_MAX: 2000,
    MC_GLOBAL_EMOTE_CACHE_MAX: 5000,
    ACTIVITY_EVENTS_MAX: 500,
    STREAM_EVENTS_MAX: 200,
    MC_AVATAR_FETCH_BATCH: 5,
    MC_CHANNEL_MSG_BUFFER: 500,
    MC_RECENT_MSGS_LIMIT: 800, // limit param for heatsync.org recent-messages (server caps at 800)
    MC_FEED_PAGE_SIZE: 30,
    MC_MENTIONS_PAGE_SIZE: 20,
    MC_EMOTE_RENDER_CHUNK: 80, // emotes rendered per animation frame
    HERMES_CHANNEL_ID_MAP_MAX: 200, // early-inject-main.js

    // Chat width (multichat.js)
    MIN_CHAT_WIDTH: 300,
    MAX_CHAT_WIDTH: 800,
  },

  // ─── DOM selectors ──────────────────────────────────────────────────────────

  SELECTORS: {
    // Twitch chat containers
    TWITCH_CHAT_CONTAINER: '.chat-scrollable-area__message-container',
    TWITCH_CHAT_FALLBACK: '.chat-list--default',
    TWITCH_CHAT_MESSAGES: '.chat-line__message',
    TWITCH_CHAT_ROOM: '[data-test-selector="chat-room-component"]',
    TWITCH_CHAT_ROOM_CONTENT: '[class*="chat-room__content"]',

    // Twitch chat layout wrappers — site builds vary the class suffix per release
    TWITCH_CHAT_SHELL: '[class*="chat-shell"]',
    TWITCH_STREAM_CHAT: '[class*="stream-chat"]',
    TWITCH_CHAT_AUTOCOMPLETE: '[class*="chat-autocomplete"]',
    TWITCH_CHAT_INPUT_WRAPPER: '[class*="chat-input"]',

    // Kick chat layout
    KICK_EDITOR_INPUT: '[class*="editor-input"]',
    KICK_CHATROOM_FOOTER: '[class*="chatroom-footer"]',
    KICK_CHAT_ENTRY_USERNAME: '[class*="chat-entry-username"]',
    KICK_CHAT_ENTRY_CONTENT: '[class*="chat-entry-content"]',
    KICK_CHAT_IDENTITY: '[class*="chat-identity"]',

    // Twitch message parts
    TWITCH_USERNAME: '.chat-author__display-name',
    TWITCH_USERNAME_ALT: '[data-a-target="chat-message-username"]',
    TWITCH_MSG_TEXT: '[data-a-target="chat-message-text"]',
    TWITCH_MSG_MENTION: '.mention-fragment',
    TWITCH_MSG_MENTION_ALT: '[data-a-target="chat-message-mention"]',
    TWITCH_TEXT_FRAGMENT: '.text-fragment',
    TWITCH_USER_MENU: '[data-a-target="user-menu-toggle"]',
    TWITCH_CHAT_INPUT: '[data-a-target="chat-input"]',
    TWITCH_VIEWERS_COUNT: '[data-a-target="animated-channel-viewers-count"]',
    TWITCH_STREAM_TITLE: '[data-a-target="stream-title"]',
    TWITCH_CHAT_HEADER: '[data-a-target="chat-room-header-label"]',
    TWITCH_CHANNEL_LEADERBOARD: '[class*="channel-leaderboard"]',
    TWITCH_MARQUEE: '[class*="marquee-animation"]',

    // Kick chat containers — fallback ARRAY consumed via qsArray/qsaArray
    // (src/lib/utils.js): tries each entry in order, first match wins.
    // Order preserves the priority already live in chrome/content.js's
    // findChatContainer() cascade (inner scrollable div, then the message
    // list root, then the outer room) with config.js's class-based
    // defensive fallbacks appended after — a strict superset, never a
    // narrower match than either prior form. Unifies 3 forms that had
    // drifted across config.js/platform-detector.js/content.js (2026-07-26).
    KICK_CHAT_CONTAINER: [
      '#chatroom-messages .no-scrollbar',
      '#chatroom-messages',
      '#channel-chatroom',
      '#channel-chatroom [class*="messages"]',
      '[class*="chat-messages-container"]',
    ],
    KICK_CHAT_CONTAINER_INNER:
      '#chatroom-messages .no-scrollbar, #chatroom-messages [class*="scroll"], [class*="chat-messages-container"] [class*="scroll"]',
    KICK_CHAT_ROOM: '#channel-chatroom, [class*="chat-room"], [class*="chatroom"]',
    KICK_CHAT_MESSAGES: '[data-index], [class*="chat-entry"]',
    // Kick username/identity element — same fallback-array treatment,
    // most-current-first: content.js's kickChatIdentity form (2026-06-09),
    // then this key's own prior CSV form (2026-05-25), then
    // platform-detector.js's form (2026-04-01). Unions all 3 divergent
    // forms found in the same audit as KICK_CHAT_CONTAINER above.
    KICK_IDENTITY: [
      '.chat-identity-name',
      '[class*="chat-identity"] span',
      '[class*="chat-identity"]',
      '[class*="chat-author"]',
      'button.inline.font-bold',
      '[class*="chat-entry-username"]',
      '[class*="chat-message-identity"] button',
    ],

    // Native emote selectors (combined via COMBINED_EMOTE_SELECTOR in content.js)
    NATIVE_EMOTE_IMG: 'img[data-a-target="emote-name"]',
    NATIVE_EMOTE_BUTTON_IMG: 'button[data-a-target="emote-button"] img',
    NATIVE_EMOTE_CLASS: '[class*="emote"] img',

    // YouTube chat (live_chat iframe)
    YT_CHAT_CONTAINER: 'yt-live-chat-item-list-renderer #items',
    YT_MESSAGE: 'yt-live-chat-text-message-renderer',
    YT_USERNAME: '#author-name',
    YT_MESSAGE_TEXT: '#message',
    YT_CHAT_INPUT: 'yt-live-chat-text-input-field-renderer div#input[contenteditable]',
    YT_SEND_BUTTON: '#send-button button, yt-button-shape button',
    YT_INPUT_RENDERER: 'yt-live-chat-text-input-field-renderer',
    YT_EMOJI_BUTTON: '#emoji-suggestions-button, #picker-buttons yt-live-chat-icon-toggle-button-renderer',
  },

  // ─── CSS classes injected by HeatSync ───────────────────────────────────────

  CLASSES: {
    // Emote wrappers
    EMOTE_WRAPPER: 'heatsync-emote-wrapper',
    EMOTE_OVERLAY: 'heatsync-overlay',
    EMOTE_STACK: 'heatsync-emote-stack',
    EMOTE_IMG: 'heatsync-emote',
    EMOTE_PREVIEW: 'heatsync-emote-preview',
    EMOTE_PREVIEW_SINGLETON: 'heatsync-emote-preview-singleton',
    EMOTE_STYLES_ID: 'heatsync-emote-styles',
    EMOTE_PREVIEW_NAME: 'heatsync-emote-preview-name',
    WYSIWYG_EMOTE: 'wysiwig-chat-input-emote',

    // Emote overlay state
    OVERLAY_OWNED: 'emote-overlay-owned',
    OVERLAY_UNADDED: 'emote-overlay-unadded',
    OVERLAY_BLOCKED: 'emote-overlay-blocked',
    OVERLAY_GLOBAL: 'emote-overlay-global',

    // Chat line states
    MENTIONED: 'hs-mentioned',
    USER_MUTED: 'hs-user-muted',
    BACKFILL: 'heatsync-backfill',
    PREVIEW_ACTIVE: 'heatsync-preview-active',
    USERNAME_COLORED: 'hs-username-colored',
    MENTION_COLORED: 'hs-mention-colored',
    HEAT_BREATHE: 'hs-heat-breathe', // animation class for tier 8+ emotes

    // Profile card
    PC_LOADING: 'hs-pc-loading',
    PC_AVATAR: 'hs-pc-avatar',
    PC_INFO: 'hs-pc-info',
    PC_HEADER_LINE: 'hs-pc-header-line',
    PC_PLATFORM: 'hs-pc-platform',
    PC_NAME: 'hs-pc-name',
    PC_ROLE: 'hs-pc-role',
    PC_VERIFIED: 'hs-pc-verified',
    PC_AGE: 'hs-pc-age',
    PC_LIVE: 'hs-pc-live',
    PC_BADGE_OP: 'hs-pc-badge-op',
    PC_OP: 'hs-pc-op',

    // Multichat container IDs / classes
    MC_CONTAINER: 'hs-mc-container',
    MC_OVERLAY: 'hs-mc-overlay',
    MC_INPUT: 'hs-mc-input',
    MC_TABBAR: 'hs-mc-tabbar',
    MC_EMOTE_PICKER: 'hs-mc-emote-picker',
    MC_INPUTBAR: 'hs-mc-inputbar',
    MC_USER: 'hs-mc-user',
    MC_LINK: 'hs-mc-link',
    MC_EMPTY: 'hs-mc-empty',
    MC_BADGE_IMG: 'hs-mc-badge-img',
    MC_REPLY_CTX: 'hs-mc-reply-ctx',
    NATIVE_HIDDEN: 'hs-native-hidden',
    FEED_AVATAR: 'hs-feed-avatar',
    FEED_USER: 'hs-feed-user',
    FEED_BODY: 'hs-feed-body',
    FEED_THREAD_LINK: 'hs-feed-thread-link',
    INPUT_STACK: 'hs-input-stack',
    KICK_RESIZE_HANDLE: 'hs-kick-resize-handle',

    // Tab layout variants
    TABS_TOP: 'hs-tabs-top',
    TABS_BOTTOM: 'hs-tabs-bottom',
    TABS_LEFT: 'hs-tabs-left',
    TABS_RIGHT: 'hs-tabs-right',

    // Collapsed state (persisted as hs_chat_collapsed)
    CHAT_COLLAPSED: 'hs-chat-collapsed',
  },

  // ─── Z-index layers ─────────────────────────────────────────────────────────

  Z_INDEX: {
    EMOTE_PREVIEW: 5000, // emote hover preview panel
    TOAST: 5000, // toast notifications
    DEBUG_BADGE: 10001, // dev-mode debug overlay badge
    AUTOCOMPLETE: 10001, // tab-completion dropdown
    MC_TOOLTIP: 1003, // multichat inline tooltip
    MC_CONTEXT_MENU: 99999, // right-click context menu
    MC_RESIZE_OVERLAY: 99999, // drag-resize capture overlay
    MC_PANEL: 10000, // multichat panel itself
    MC_EMOTE_PICKER: 10001, // emote picker flyout
  },
}

// Global export — matches pattern of browser-api.js / utils.js
if (typeof window !== 'undefined') {
  window.heatsyncConfig = CONFIG
}

export { CONFIG }
export default CONFIG
