// Background script - Fetch emote inventory and manage WebSocket

// Chrome compatibility - Firefox uses 'browser', Chrome uses 'chrome'
const browser = globalThis.browser || chrome;

// Debug logging - set to false for production
const DEBUG = false;
const log = DEBUG ? console.log.bind(console, '[heatsync]') : () => {};

log('🔥 BACKGROUND SCRIPT LOADING...');

// Show welcome page on first install, clear stale intervals on update
browser.runtime.onInstalled.addListener((details) => {
  log(' 📦 onInstalled - extension installed/updated', details.reason);
  // Clear any stale intervals from previous version
  activeIntervals.forEach(clearInterval);
  activeIntervals.length = 0;
  if (details.reason === 'install') {
    browser.tabs.create({
      url: browser.runtime.getURL('welcome.html')
    });
  }
});

// One-time migration: ensure clean state
browser.storage.local.get('migrated_to_prod_v2').then(async (data) => {
  if (!data.migrated_to_prod_v2) {
    await browser.storage.local.set({ migrated_to_prod_v2: true });
    log(' Migration v2 complete');
  }
}).catch(err => log(' Migration check failed:', err?.message));

// Migrate old single channel_emotes to per-channel map
browser.storage.local.get(['channel_emotes', 'channel_emotes_owner']).then(async (data) => {
  if (data.channel_emotes && data.channel_emotes_owner) {
    const map = { [data.channel_emotes_owner]: data.channel_emotes };
    await browser.storage.local.set({ channel_emotes_map: map });
    await browser.storage.local.remove(['channel_emotes', 'channel_emotes_owner']);
    log(' Migrated channel_emotes to per-channel map');
  }
}).catch(err => log(' Channel emotes migration failed:', err?.message));

let emoteInventory = [];
let globalEmotes = []; // BTTV, FFZ, 7TV global emotes
let channelEmotesMap = {}; // Per-channel emotes: { channelName: emotes[] }
let currentChannelOwner = null; // Track last-fetched channel (for content.js tab)
let current7TVEmoteSetId = null; // Track current 7TV emote set ID for EventAPI
let blockedEmotes = new Set();
let localBlockedEmotes = new Set(); // Local blocks for anonymous users
let mutedUsers = new Map(); // username -> expiresAt (null = permanent)
let blockedUsers = new Set();
let followedUsers = []; // Users the current user follows
let socket = null;
let lastBroadcastWasEmpty = false; // Track to prevent spamming 0-emote broadcasts
let currentChannel = null;
let pendingChannelJoin = null; // Store channel join request if socket not ready
let unreadNotifCount = 0; // Unread notification count for extension badge
let activeYoutubeVideoId = null; // Currently subscribed YouTube videoId (for WS reconnect)
const ytVideoToChannel = new Map(); // videoId → channelId (for per-channel YouTube routing)
const MAX_YT_VIDEO_ENTRIES = 100; // LRU cap — evict oldest when full
function setYtVideoChannel(videoId, channelId) {
  ytVideoToChannel.delete(videoId) // Re-insert for LRU ordering
  ytVideoToChannel.set(videoId, channelId)
  if (ytVideoToChannel.size > MAX_YT_VIDEO_ENTRIES) {
    const oldest = ytVideoToChannel.keys().next().value
    ytVideoToChannel.delete(oldest)
  }
}

let authToken = null; // Will be set by content script or loaded from storage
let initPromise = null; // Track init completion for message handlers
const API_URL = 'https://heatsync.org'; // Production
const WS_URL = 'wss://heatsync.org'; // Production WebSocket

// Track intervals for cleanup (memory leak prevention)
const activeIntervals = [];
function trackInterval(id) {
  activeIntervals.push(id);
  return id;
}

// Fetch with 10s timeout to prevent hung requests
function fetchWithTimeout(url, opts = {}, ms = 10000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  if (opts.signal) {
    opts.signal.addEventListener('abort', () => ctrl.abort())
  }
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer))
}

// ============================================
// TOKEN ENCRYPTION (SubtleCrypto)
// ============================================
// Encrypts auth tokens at rest using extension ID as key derivation seed
// This prevents casual inspection of stored tokens

async function getEncryptionKey() {
  // Use extension ID as seed for key derivation (stable per-install)
  const extensionId = browser.runtime.id || 'heatsync-default';
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(extensionId + '-heatsync-token-key'),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: encoder.encode('heatsync-salt'), iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptToken(token) {
  if (!token) return null;
  try {
    const key = await getEncryptionKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoder = new TextEncoder();
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      encoder.encode(token)
    );
    // Store as base64: iv + encrypted data
    const combined = new Uint8Array(iv.length + encrypted.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(encrypted), iv.length);
    return btoa(String.fromCharCode(...combined));
  } catch (err) {
    log(' Encryption failed:', err.message);
    return null;
  }
}

async function decryptToken(encryptedBase64) {
  if (!encryptedBase64) return null;
  try {
    const key = await getEncryptionKey();
    const combined = Uint8Array.from(atob(encryptedBase64), c => c.charCodeAt(0));
    const iv = combined.slice(0, 12);
    const encrypted = combined.slice(12);
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      encrypted
    );
    return new TextDecoder().decode(decrypted);
  } catch (err) {
    log(' Decryption failed:', err.message);
    return null;
  }
}

// Secure token storage helpers
async function storeToken(token) {
  const encrypted = await encryptToken(token);
  if (encrypted) {
    await browser.storage.local.set({ auth_token_encrypted: encrypted });
    // Remove old unencrypted token if exists
    await browser.storage.local.remove('auth_token');
  }
}

async function retrieveToken() {
  const data = await browser.storage.local.get(['auth_token_encrypted', 'auth_token']);
  // Try encrypted first
  if (data.auth_token_encrypted) {
    const token = await decryptToken(data.auth_token_encrypted);
    if (token) return token;
  }
  // Fallback to unencrypted (migration) and re-encrypt
  if (data.auth_token) {
    log(' Migrating unencrypted token to encrypted storage');
    await storeToken(data.auth_token);
    return data.auth_token;
  }
  return null;
}

// Map of hash -> real emote URL (populated when emotes are loaded)
const emoteUrlMap = new Map();

// Intercept requests to Twitch CDN with our FFZ-style IDs and redirect to real URLs
// Format: __FFZ__999999::HASH__FFZ__ (numeric set ID for Twitch validation)
// NOTE: This only works in Firefox (MV2). Chrome MV3 doesn't support blocking webRequest.
try {
  if (browser.webRequest?.onBeforeRequest) {
    browser.webRequest.onBeforeRequest.addListener(
      (details) => {
        const url = details.url;
        const match = url.match(/__FFZ__999999::([a-f0-9]+)__FFZ__/);
        if (!match) return;

        const hash = match[1];
        const realUrl = emoteUrlMap.get(hash);
        log(' 🎯 webRequest intercepted:', hash.substring(0, 12), '-> found:', !!realUrl);

        if (realUrl) {
          return { redirectUrl: realUrl };
        }
        return {};
      },
      { urls: ['*://static-cdn.jtvnw.net/emoticons/v2/__FFZ__999999*'] },
      ['blocking']
    );
    log(' 🔄 WebRequest interceptor installed (Firefox)');
  }
} catch (e) {
  // Chrome MV3 doesn't support blocking webRequest - that's OK
  log('[heatsync] webRequest not available (Chrome MV3) - using direct URLs');
}

// Update the emote URL map
function updateEmoteUrlMap() {
  emoteUrlMap.clear();
  const allEmotes = [...emoteInventory, ...globalEmotes];
  // Include all channel emotes from every channel
  for (const emotes of Object.values(channelEmotesMap)) {
    if (Array.isArray(emotes)) allEmotes.push(...emotes);
  }
  for (const emote of allEmotes) {
    if (emote.hash && emote.url) {
      emoteUrlMap.set(emote.hash, emote.url);
    }
  }
  log(' 📍 Updated emoteUrlMap:', emoteUrlMap.size, 'entries');
}

// Get auth token (read from memory, storage, or fetch from API)
async function getAuthCookie() {
  if (authToken) {
    log(' Using auth token from memory');
    return authToken;
  }

  // Try reading from encrypted storage (persists across restarts)
  try {
    const stored = await retrieveToken();
    if (stored) {
      log(' Read auth token from encrypted storage');
      authToken = stored;
      return stored;
    }
  } catch (err) {
  }

  // Try production first (heatsync.org)
  try {
    log(' Trying token fetch from heatsync.org');
    const response = await fetchWithTimeout('https://heatsync.org/api/extension/token', {
      credentials: 'include'
    });

    if (response.ok) {
      const data = await response.json();
      if (data.token) {
        log(' ✓ Got token from heatsync.org');
        authToken = data.token;
        await storeToken(data.token);
        return data.token;
      }
    }
  } catch (err) {
    log(' Token fetch failed:', err.message);
  }

  log(' No auth token available');
  return null;
}

// Fetch user's emote inventory via HTTP
async function fetchEmoteInventory() {
  try {
    const authToken = await getAuthCookie();
    if (!authToken) {
      log(' No auth token for inventory fetch');
      emoteInventory = [];
      // Only broadcast empty once to prevent spam (every 60s poll was flooding console)
      if (!lastBroadcastWasEmpty) {
        broadcastToTabs({ type: 'inventory_update', emotes: emoteInventory });
        lastBroadcastWasEmpty = true;
      }
      return;
    }

    log(' Fetching user inventory from API');
    const response = await fetchWithTimeout(`${API_URL}/api/user/emotes`, {
      headers: {
        'Authorization': `Bearer ${authToken}`
      }
    });

    if (!response.ok) {
      emoteInventory = [];
      // Only broadcast empty once
      if (!lastBroadcastWasEmpty) {
        broadcastToTabs({ type: 'inventory_update', emotes: emoteInventory });
        lastBroadcastWasEmpty = true;
      }
      return;
    }

    const data = await response.json();
    log(' API response:', data);
    log(' 🔍 API emotes array length:', data.emotes ? data.emotes.length : 'undefined');
    log(' 🔍 First emote from API:', data.emotes ? data.emotes[0] : 'none');

    // Transform the API response to match extension format
    // Backend returns 'custom_name', extension expects 'name'
    const inventoryEmotes = (data.emotes || []).map(emote => ({
      name: emote.custom_name,  // Map custom_name to name
      url: emote.url,
      hash: emote.hash,
      width: emote.width,
      height: emote.height,
      slot: emote.slot_number,
      usage_count: emote.usage_count
    }));
    log(' 🔍 Transformed inventory length:', inventoryEmotes.length);
    log(' 🔍 First transformed emote:', inventoryEmotes[0]);

    // Transform subscription emotes
    const subEmotes = (data.subscriptionEmotes || []).map(emote => ({
      name: emote.custom_name,
      url: emote.url,
      hash: emote.hash,
      width: emote.width || 28,
      height: emote.height || 28,
      tier: emote.tier,
      broadcaster: emote.broadcaster_name
    }));

    // Combine inventory + subscription emotes
    emoteInventory = [...inventoryEmotes, ...subEmotes];
    updateEmoteUrlMap();

    log(' Loaded', inventoryEmotes.length, 'inventory emotes');
    log(' Loaded', subEmotes.length, 'subscription emotes');
    if (emoteInventory.length > 0) {
      log(' Sample emotes:', emoteInventory.slice(0, 3).map(e => e.name));
    }
    lastBroadcastWasEmpty = false; // Reset - we have real emotes now
    broadcastToTabs({ type: 'inventory_update', emotes: emoteInventory });
  } catch (error) {
    emoteInventory = [];
    // Only broadcast empty once
    if (!lastBroadcastWasEmpty) {
      broadcastToTabs({ type: 'inventory_update', emotes: emoteInventory });
      lastBroadcastWasEmpty = true;
    }
  }
}

// Fetch blocked emotes
async function fetchBlockedEmotes() {
  try {
    const authToken = await getAuthCookie();
    if (!authToken) {
      // Not logged in - load local blocks only
      await loadLocalBlockedEmotes();
      return;
    }

    const response = await fetchWithTimeout(`${API_URL}/api/user/emotes/blocked`, {
      headers: {
        'Authorization': `Bearer ${authToken}`
      }
    });

    if (!response.ok) return;

    const data = await response.json();
    // Server returns blocked_emotes array with hash property
    blockedEmotes = new Set((data.blocked_emotes || []).map(b => b.hash));

    // Also load local blocks and merge them
    await loadLocalBlockedEmotes();
    const allBlocked = new Set([...blockedEmotes, ...localBlockedEmotes]);

    broadcastToTabs({ type: 'blocked_update', blocked: Array.from(allBlocked) });
  } catch (error) {
  }
}

// Load local blocked emotes from storage (for anonymous users)
async function loadLocalBlockedEmotes() {
  try {
    const stored = await browser.storage.local.get('local_blocked_emotes');
    if (stored.local_blocked_emotes && Array.isArray(stored.local_blocked_emotes)) {
      localBlockedEmotes = new Set(stored.local_blocked_emotes);
      log(' Loaded', localBlockedEmotes.size, 'local blocked emotes');
    }
  } catch (error) {
    log(' Failed to load local blocked emotes:', error.message);
  }
}

// Save local blocked emotes to storage
async function saveLocalBlockedEmotes() {
  try {
    await browser.storage.local.set({
      local_blocked_emotes: Array.from(localBlockedEmotes)
    });
    log(' Saved', localBlockedEmotes.size, 'local blocked emotes');
  } catch (error) {
    log(' Failed to save local blocked emotes:', error.message);
  }
}

// Fetch followed users
async function fetchFollowedUsers() {
  try {
    const authToken = await getAuthCookie();
    if (!authToken) {
      followedUsers = [];
      return;
    }

    const response = await fetchWithTimeout(`${API_URL}/api/user/following`, {
      headers: {
        'Authorization': `Bearer ${authToken}`
      }
    });

    if (!response.ok) {
      followedUsers = [];
      return;
    }

    const data = await response.json();
    followedUsers = data.following.map(f => f.username);
    log(' Followed users loaded:', followedUsers.length);
    broadcastToTabs({ type: 'followed_users_updated', users: followedUsers });
  } catch (error) {
    followedUsers = [];
  }
}

// Validate emote objects from third-party APIs to bound string sizes and URL patterns
const EMOTE_CDN_PATTERN = /^https:\/\/(cdn\.(betterttv\.net|7tv\.app|frankerfacez\.com)|static-cdn\.jtvnw\.net|heatsync\.org)\//
const MAX_EMOTE_NAME_LEN = 100
const MAX_EMOTES_PER_SOURCE = 5000
function sanitizeEmote(e) {
  if (!e || typeof e.name !== 'string' || typeof e.url !== 'string') return null
  if (e.name.length > MAX_EMOTE_NAME_LEN || e.name.length === 0) return null
  if (!EMOTE_CDN_PATTERN.test(e.url)) return null
  return e
}
function sanitizeEmoteList(emotes) {
  return emotes.slice(0, MAX_EMOTES_PER_SOURCE).map(sanitizeEmote).filter(Boolean)
}

// Fetch BTTV channel emotes
async function fetchBTTVChannelEmotes(channelName) {
  try {
    // First get Twitch user ID
    const userResponse = await fetchWithTimeout(`https://api.betterttv.net/3/cached/users/twitch/${channelName}`);
    if (!userResponse.ok) return [];

    const userData = await userResponse.json();
    const emotes = [...(userData.channelEmotes || []), ...(userData.sharedEmotes || [])];

    return sanitizeEmoteList(emotes.map(e => ({
      name: e.code,
      url: `https://cdn.betterttv.net/emote/${e.id}/1x.webp`,
      source: 'bttv',
      hash: e.id
    })));
  } catch (error) {
    log(' BTTV channel emotes not found for:', channelName);
    return [];
  }
}

// Fetch FFZ channel emotes
async function fetchFFZChannelEmotes(channelName) {
  try {
    const response = await fetchWithTimeout(`https://api.frankerfacez.com/v1/room/${channelName}`);
    if (!response.ok) return [];

    const data = await response.json();
    const emotes = [];

    for (const setId in data.sets) {
      const set = data.sets[setId];
      for (const emote of (set.emoticons || [])) {
        emotes.push({
          name: emote.name,
          url: emote.urls['1'] || emote.urls['2'] || emote.urls['4'],
          source: 'ffz',
          hash: `ffz-${emote.id}`
        });
      }
    }
    return sanitizeEmoteList(emotes);
  } catch (error) {
    log(' FFZ channel emotes not found for:', channelName);
    return [];
  }
}

// Lookup Twitch user ID from username using decapi.me (free, no auth needed)
async function lookupTwitchUserId(username) {
  try {
    const response = await fetchWithTimeout(`https://decapi.me/twitch/id/${encodeURIComponent(username)}`);
    if (!response.ok) return null;
    const text = await response.text();
    // decapi returns just the ID as plain text, or error message
    if (/^\d+$/.test(text.trim())) {
      return text.trim();
    }
    return null;
  } catch (e) {
    log(' Failed to lookup Twitch user ID:', e);
    return null;
  }
}

// Fetch 7TV channel emotes
// Note: 7TV API v3 requires Twitch user ID, not username
async function fetch7TVChannelEmotes(channelName, channelId = null) {
  try {
    // Use channelId if available, otherwise lookup via decapi.me
    let identifier = channelId;
    if (!identifier) {
      log(' 7TV: No channelId provided, looking up via decapi.me...');
      identifier = await lookupTwitchUserId(channelName);
      if (identifier) {
        log(' 7TV: Got user ID from decapi:', identifier);
      }
    }

    // Final fallback to username (rarely works but try anyway)
    if (!identifier) {
      identifier = channelName;
    }

    log(' 7TV: Fetching with identifier:', identifier, '(channelId:', channelId, ')');

    // Try Twitch ID lookup first
    let response = await fetchWithTimeout(`https://7tv.io/v3/users/twitch/${identifier}`);
    let data = null;

    if (!response.ok) {
      log(' 7TV: Twitch ID lookup failed (' + response.status + '), trying username fallback...');

      // Fallback to username-based lookup
      response = await fetchWithTimeout(`https://7tv.io/v3/users/${channelName}`);
      if (!response.ok) {
        log(' 7TV: Username lookup also failed (' + response.status + ')');
        return [];
      }

      data = await response.json();
      log(' ✅ 7TV: Username fallback succeeded!');
    } else {
      data = await response.json();
      log(' ✅ 7TV: Twitch ID lookup succeeded');
    }

    const emoteSet = data.emote_set;
    if (!emoteSet?.emotes) {
      log(' 7TV: No emote set found for', identifier);
      return [];
    }

    // Store emote set ID for EventAPI subscription
    current7TVEmoteSetId = emoteSet.id;
    log(' 7TV: Found', emoteSet.emotes.length, 'emotes for', identifier, '(set ID:', emoteSet.id + ')');

    // Connect to 7TV EventAPI for real-time updates
    connect7TVEventAPI(emoteSet.id);

    return sanitizeEmoteList(emoteSet.emotes.map(e => ({
      name: e.name,
      url: `https://cdn.7tv.app/emote/${e.id}/1x.webp`,
      source: '7tv',
      hash: e.id,
      flags: e.flags || e.data?.flags || 0,
      zeroWidth: !!((e.flags & 257) || (e.data?.flags & 257))
    })));
  } catch (error) {
    log(' 7TV channel emotes error for:', channelName, error);
    return [];
  }
}

// Fetch channel owner's emotes (public API) + third-party channel emotes
async function fetchChannelOwnerEmotes(channelName, channelId = null) {
  // Skip if already fetched or currently fetching (sentinel prevents race)
  if (channelEmotesMap[channelName]) {
    log(' Channel emotes already fetched/loading for', channelName, '- skipping');
    return;
  }
  channelEmotesMap[channelName] = 'loading';

  try {
    log(' 📺 Fetching channel emotes for:', channelName, 'id:', channelId);

    // Show loading indicator
    broadcastToTabs({ type: 'loading_status', text: 'loading channel emotes...' });

    // Fetch heatsync emotes
    broadcastToTabs({ type: 'loading_status', text: 'fetching heatsync emotes...' });
    const response = await fetchWithTimeout(`${API_URL}/api/emotes/user/${encodeURIComponent(channelName)}`);
    let heatsyncEmotes = [];

    if (response.ok) {
      const data = await response.json();
      heatsyncEmotes = (data.emotes || []).map(e => ({
        name: e.name,
        url: e.url,
        hash: e.hash || e.name,
        provider: e.provider || 'upload'
      }));
    }

    // Fetch third-party emotes in PARALLEL for speed
    broadcastToTabs({ type: 'loading_status', text: 'fetching third-party emotes...' });
    const [bttvEmotes, ffzEmotes, sevenTVEmotes, twitchChannelEmotes] = await Promise.all([
      fetchBTTVChannelEmotes(channelName),
      fetchFFZChannelEmotes(channelName),
      fetch7TVChannelEmotes(channelName, channelId),
      fetchTwitchChannelEmotes(channelName)
    ]);
    log(' BTTV channel:', bttvEmotes.length);
    log(' FFZ channel:', ffzEmotes.length);
    log(' 7TV channel:', sevenTVEmotes.length);

    // Store emotes for this specific channel
    const emotes = [...heatsyncEmotes, ...bttvEmotes, ...ffzEmotes, ...sevenTVEmotes, ...twitchChannelEmotes];
    channelEmotesMap[channelName] = emotes;
    updateEmoteUrlMap();

    currentChannelOwner = channelName;
    log(' ✅ Channel emotes loaded for', channelName + ':', emotes.length,
      `(heatsync: ${heatsyncEmotes.length}, bttv: ${bttvEmotes.length}, ffz: ${ffzEmotes.length}, 7tv: ${sevenTVEmotes.length})`);

    // Hide loading indicator
    broadcastToTabs({ type: 'loading_status', done: true });

    // Broadcast to content scripts (include channel owner name for filtering)
    broadcastToTabs({ type: 'channel_emotes_update', emotes, channelOwner: channelName });

    // Save per-channel map to storage for persistence
    await browser.storage.local.set({ channel_emotes_map: channelEmotesMap });
  } catch (error) {
    log(' ❌ Channel emotes fetch failed:', error.message || error);
    broadcastToTabs({ type: 'loading_status', done: true });
    // Clear sentinel so retry works on next join_channel
    delete channelEmotesMap[channelName];
  }
}

// Fetch BTTV global emotes
async function fetchBTTVEmotes() {
  try {
    const response = await fetchWithTimeout('https://api.betterttv.net/3/cached/emotes/global');
    if (!response.ok) return [];

    const emotes = await response.json();
    return sanitizeEmoteList(emotes.map(e => ({
      name: e.code,
      url: `https://cdn.betterttv.net/emote/${e.id}/1x.webp`,
      source: 'bttv',
      hash: e.id
    })));
  } catch (error) {
    return [];
  }
}

// Fetch FFZ global emotes
async function fetchFFZEmotes() {
  try {
    const response = await fetchWithTimeout('https://api.frankerfacez.com/v1/set/global');
    if (!response.ok) return [];

    const data = await response.json();
    const emotes = [];

    for (const set of Object.values(data.sets)) {
      if (data.default_sets.includes(set.id)) {
        for (const emote of (set.emoticons || [])) {
          emotes.push({
            name: emote.name,
            url: `https:${emote.urls['1'] || emote.urls['2'] || emote.urls['4']}`,
            source: 'ffz',
            hash: String(emote.id)
          });
        }
      }
    }

    return sanitizeEmoteList(emotes);
  } catch (error) {
    return [];
  }
}

// Fetch 7TV global emotes
async function fetch7TVEmotes() {
  try {
    const response = await fetchWithTimeout('https://7tv.io/v3/emote-sets/global');
    if (!response.ok) return [];

    const data = await response.json();
    return sanitizeEmoteList(data.emotes.map(e => ({
      name: e.name,
      url: `https://cdn.7tv.app/emote/${e.id}/1x.webp`,
      source: '7tv',
      hash: e.id,
      flags: e.flags || e.data?.flags || 0,
      zeroWidth: !!((e.flags & 257) || (e.data?.flags & 257))
    })));
  } catch (error) {
    return [];
  }
}

// Fetch Twitch native global emotes (Kappa, PogChamp, etc.)
async function fetchTwitchGlobalEmotes() {
  try {
    // Use Twitch's public API directly (no auth required for global emotes)
    const response = await fetchWithTimeout('https://static-cdn.jtvnw.net/emoticons/v2/metadata');
    if (!response.ok) {
      log('⚠️ Twitch global emotes failed:', response.status);
      return [];
    }

    const data = await response.json();
    log('✅ Loaded', data.emoteSets?.length || 0, 'Twitch emote sets');

    // Twitch returns emote sets, flatten to individual emotes
    const emotes = [];
    for (const emoteSet of (data.emoteSets || [])) {
      for (const emote of (emoteSet.emotes || [])) {
        emotes.push({
          name: emote.token,
          url: `https://static-cdn.jtvnw.net/emoticons/v2/${emote.id}/default/dark/1.0`,
          source: 'twitch',
          hash: emote.id
        });
      }
    }

    const validated = sanitizeEmoteList(emotes)
    log('✅ Loaded', validated.length, 'Twitch global emotes directly from Twitch');
    return validated;
  } catch (error) {
    log('❌ Twitch global emotes error:', error);
    return [];
  }
}

// Fetch Twitch channel emotes (subscriber, follower, bits tier)
async function fetchTwitchChannelEmotes(channelName) {
  try {
    const response = await fetchWithTimeout(`${API_URL}/api/emotes/twitch/channel/${channelName}`);
    if (!response.ok) {
      log(' Twitch channel emotes failed for', channelName, ':', response.status);
      return [];
    }

    const data = await response.json();
    log(' Loaded', data.count, 'Twitch channel emotes for', channelName);

    return sanitizeEmoteList(data.emotes.map(e => ({
      name: e.name,
      url: e.url,
      source: 'twitch',
      hash: e.id,
      url_2x: e.url_2x,
      url_4x: e.url_4x,
      tier: e.tier,
      emote_type: e.emote_type
    })));
  } catch (error) {
    log(' Twitch channel emotes error for', channelName, ':', error);
    return [];
  }
}

async function fetchGlobalEmotes() {
  try {
    log(' Fetching global emotes from', `${API_URL}/api/emotes`);
    // Try server API first (has all providers cached)
    const response = await fetchWithTimeout(`${API_URL}/api/emotes`);
    log(' Global emotes response:', response.status, response.ok);
    if (response.ok) {
      const data = await response.json();
      globalEmotes = sanitizeEmoteList(data.emotes.map(e => ({
        name: e.name,
        url: e.url,
        source: e.provider,
        hash: e.hash
      })));
      updateEmoteUrlMap();
      log(' Loaded', globalEmotes.length, 'global emotes from server');
      log(' Sample global emotes:', globalEmotes.slice(0, 5).map(e => e.name));

      // Debug: check providers and CoffeeTime
      const providers = [...new Set(globalEmotes.map(e => e.source))];
      log(' Providers:', providers.join(', '));
      const coffeeTime = globalEmotes.find(e => e.name === 'CoffeeTime');
      if (coffeeTime) {
        log(' CoffeeTime found:', coffeeTime);
      } else {
        log(' CoffeeTime NOT in server response, fetching Twitch globals separately...');
        const coffeeEmotes = globalEmotes.filter(e => e.name.toLowerCase().includes('coffee'));
        log(' Emotes with "coffee":', coffeeEmotes.map(e => e.name).join(', '));
      }

      // ALWAYS fetch Twitch + 7TV global emotes separately (server cache may be stale)
      log('📥 Fetching Twitch + 7TV globals separately...');
      const [twitchGlobals, seventvGlobals] = await Promise.all([
        fetchTwitchGlobalEmotes(),
        fetch7TVEmotes()
      ]);

      // Merge with cached emotes (avoid duplicates by name)
      const existingNames = new Set(globalEmotes.map(e => e.name));

      if (twitchGlobals.length > 0) {
        const newTwitchEmotes = twitchGlobals.filter(e => !existingNames.has(e.name));
        globalEmotes.push(...newTwitchEmotes);
        log('✅ Added', newTwitchEmotes.length, 'Twitch globals');
        newTwitchEmotes.forEach(e => existingNames.add(e.name));
      }

      if (seventvGlobals.length > 0) {
        const new7TVEmotes = seventvGlobals.filter(e => !existingNames.has(e.name));
        globalEmotes.push(...new7TVEmotes);
        log('✅ Added', new7TVEmotes.length, '7TV globals');

        // Debug: check if BillyApprove is in 7TV globals
        const billyApprove = new7TVEmotes.find(e => e.name === 'BillyApprove');
        if (billyApprove) {
          log('🔍 BillyApprove found in 7TV globals:', billyApprove);
        } else {
          log('❌ BillyApprove NOT in new 7TV globals');
          const allBilly = seventvGlobals.find(e => e.name === 'BillyApprove');
          if (allBilly) {
            log('   But BillyApprove exists in raw 7TV response (duplicate?)');
          }
        }
      }

      updateEmoteUrlMap();
      log('📊 Total global emotes:', globalEmotes.length);

      broadcastToTabs({ type: 'global_emotes_update', emotes: globalEmotes });
      return;
    }
    log(' Server API failed, trying fallback');

    // Fallback: fetch directly from APIs
    const [bttv, ffz, sevenTV, twitchGlobal] = await Promise.all([
      fetchBTTVEmotes(),
      fetchFFZEmotes(),
      fetch7TVEmotes(),
      fetchTwitchGlobalEmotes()
    ]);

    globalEmotes = [...bttv, ...ffz, ...sevenTV, ...twitchGlobal];
    updateEmoteUrlMap();
    log(' Loaded', globalEmotes.length, 'global emotes (fallback)');
    broadcastToTabs({ type: 'global_emotes_update', emotes: globalEmotes });
  } catch (error) {
  }
}

// ========== 7TV EventAPI WebSocket for Real-Time Emote Updates ==========
let seventvWebSocket = null;
let seventvReconnectAttempts = 0;
const SEVENTV_MAX_RECONNECT_ATTEMPTS = 5;

function connect7TVEventAPI(emoteSetId) {
  if (!emoteSetId) {
    log(' 7TV EventAPI: No emote set ID provided');
    return;
  }

  // Close existing connection if any (null onclose to prevent reconnect loop)
  if (seventvWebSocket) {
    seventvWebSocket.onclose = null;
    seventvWebSocket.close();
    seventvWebSocket = null;
  }

  log(' 7TV EventAPI: Connecting for emote set:', emoteSetId);

  try {
    seventvWebSocket = new WebSocket('wss://events.7tv.io/v3');

    seventvWebSocket.onopen = () => {
      log(' 7TV EventAPI: Connected');
      seventvReconnectAttempts = 0;

      // Subscribe to emote_set.update events (opcode 35)
      const subscribeMessage = {
        op: 35,
        d: {
          type: 'emote_set.update',
          condition: {
            object_id: emoteSetId
          }
        }
      };

      seventvWebSocket.send(JSON.stringify(subscribeMessage));
      log(' 7TV EventAPI: Subscribed to emote set updates');
    };

    seventvWebSocket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);

        // Opcode 0 = Dispatch (actual event)
        if (message.op === 0) {
          const eventData = message.d;
          log(' 7TV EventAPI: Received event:', eventData.type);

          if (eventData.type === 'emote_set.update') {
            handle7TVEmoteSetUpdate(eventData.body);
          }
        }
        // Opcode 1 = Hello (connection established)
        else if (message.op === 1) {
          log(' 7TV EventAPI: Hello received, heartbeat:', message.d.heartbeat_interval, 'ms');
        }
        // Opcode 4 = Ack (subscription confirmed)
        else if (message.op === 4) {
          log(' 7TV EventAPI: Subscription acknowledged');
        }
      } catch (err) {
        console.error('[heatsync] 7TV EventAPI: Parse error:', err);
      }
    };

    seventvWebSocket.onerror = () => {
      log(' 7TV EventAPI: WebSocket error (will reconnect)');
    };

    seventvWebSocket.onclose = () => {
      log(' 7TV EventAPI: Connection closed');
      seventvWebSocket = null;

      // Attempt reconnect with exponential backoff
      if (seventvReconnectAttempts < SEVENTV_MAX_RECONNECT_ATTEMPTS && current7TVEmoteSetId) {
        const delay = Math.min(1000 * Math.pow(2, seventvReconnectAttempts), 30000);
        seventvReconnectAttempts++;
        log(` 7TV EventAPI: Reconnecting in ${delay}ms (attempt ${seventvReconnectAttempts}/${SEVENTV_MAX_RECONNECT_ATTEMPTS})`);
        setTimeout(() => connect7TVEventAPI(current7TVEmoteSetId), delay);
      }
    };
  } catch (err) {
    console.error('[heatsync] 7TV EventAPI: Connection failed:', err);
  }
}

function handle7TVEmoteSetUpdate(updateData) {
  // updateData structure:
  // {
  //   id: "<emote_set_id>",
  //   actor: { id, username, display_name },
  //   pushed: [{ key: "emote_name", value: { id, name, ... } }], // Added emotes
  //   pulled: [{ key: "emote_name", old_value: { id, name, ... } }] // Removed emotes
  // }

  log(' 7TV: Emote set update:', updateData);

  let updated = false;
  const actor = updateData.actor?.display_name || updateData.actor?.username || '';

  // Handle added emotes
  if (updateData.pushed && updateData.pushed.length > 0) {
    for (const item of updateData.pushed) {
      const emote = item.value;
      const newEmote = {
        name: emote.name,
        url: `https://cdn.7tv.app/emote/${emote.id}/1x.webp`,
        source: '7tv',
        hash: emote.id
      };

      // Add to channel emotes if not already present
      const chEmotes = Array.isArray(channelEmotesMap[currentChannelOwner]) ? channelEmotesMap[currentChannelOwner] : [];
      if (!chEmotes.some(e => e.hash === emote.id)) {
        chEmotes.push(newEmote);
        channelEmotesMap[currentChannelOwner] = chEmotes;
        updated = true;
        log(' 7TV: Added emote:', emote.name);

        const msg = actor ? `${actor} added 7TV emote ${emote.name}` : `${emote.name} added to channel`;
        broadcastToTabs({
          type: 'channel_emote_added',
          emote: newEmote,
          message: msg
        });
      }
    }
  }

  // Handle removed emotes
  if (updateData.pulled && updateData.pulled.length > 0) {
    for (const item of updateData.pulled) {
      const emote = item.old_value;
      const chEmotes = channelEmotesMap[currentChannelOwner] || [];
      const index = chEmotes.findIndex(e => e.hash === emote.id);

      if (index !== -1) {
        chEmotes.splice(index, 1);
        channelEmotesMap[currentChannelOwner] = chEmotes;
        updated = true;
        log(' 7TV: Removed emote:', emote.name);

        const msg = actor ? `${actor} removed 7TV emote ${emote.name}` : `${emote.name} removed from channel`;
        broadcastToTabs({
          type: 'channel_emote_removed',
          emoteName: emote.name,
          emoteHash: emote.id,
          message: msg
        });
      }
    }
  }

  if (updated) {
    updateEmoteUrlMap();

    // Broadcast updated channel emotes to all tabs
    const updatedEmotes = Array.isArray(channelEmotesMap[currentChannelOwner]) ? channelEmotesMap[currentChannelOwner] : [];
    broadcastToTabs({
      type: 'channel_emotes_update',
      emotes: updatedEmotes,
      channelOwner: currentChannelOwner
    });

    // Persist per-channel map
    browser.storage.local.set({ channel_emotes_map: channelEmotesMap }).catch(() => {});

    log(' 7TV: Channel emotes updated for', currentChannelOwner, '(now', updatedEmotes.length, 'total)');
  }
}

// Block emote via HTTP - returns success/failure
async function blockEmote(hash) {
  try {
    const authToken = await getAuthCookie();
    if (!authToken) {
      // Not logged in - use local storage
      localBlockedEmotes.add(hash);
      await saveLocalBlockedEmotes();

      const allBlocked = new Set([...blockedEmotes, ...localBlockedEmotes]);
      broadcastToTabs({ type: 'blocked_update', blocked: Array.from(allBlocked) });
      broadcastToTabs({ type: 'emote_blocked', hash });
      return { success: true, local: true };
    }

    const response = await fetchWithTimeout(`${API_URL}/api/user/emotes/block`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify({ emote_hash: hash })
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      return { success: false, error: error.error || `HTTP ${response.status}` };
    }

    // Only update local state AFTER server confirms
    blockedEmotes.add(hash);

    // Also remove from local inventory if present (server does this too)
    const removedEmote = emoteInventory.find(e => e.hash === hash);
    if (removedEmote) {
      emoteInventory = emoteInventory.filter(e => e.hash !== hash);
      log(' Removed blocked emote from local inventory:', removedEmote.name);
    }

    broadcastToTabs({ type: 'emote_blocked', hash });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message || 'Network error' };
  }
}

// Unblock emote via HTTP - returns success/failure
async function unblockEmote(hash) {
  try {
    const authToken = await getAuthCookie();
    if (!authToken) {
      // Not logged in - use local storage
      localBlockedEmotes.delete(hash);
      await saveLocalBlockedEmotes();

      // Broadcast update
      const allBlocked = new Set([...blockedEmotes, ...localBlockedEmotes]);
      broadcastToTabs({ type: 'blocked_update', blocked: Array.from(allBlocked) });
      broadcastToTabs({ type: 'emote_unblocked', hash });

      log(' 🔓 Unblocked emote locally (not logged in):', hash);
      return { success: true, local: true };
    }

    const response = await fetchWithTimeout(`${API_URL}/api/user/emotes/blocked/${hash}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${authToken}`
      }
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      return { success: false, error: error.error || `HTTP ${response.status}` };
    }

    // Only update local state AFTER server confirms
    blockedEmotes.delete(hash);
    broadcastToTabs({ type: 'emote_unblocked', hash });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message || 'Network error' };
  }
}

// Extension badge for unread notifications
function updateExtensionBadge() {
  const text = unreadNotifCount > 0 ? String(unreadNotifCount) : ''
  browser.action.setBadgeText({ text }).catch(() => {})
  if (unreadNotifCount > 0) {
    browser.action.setBadgeBackgroundColor({ color: '#ff6b35' }).catch(() => {})
  }
}

// Persist muted users to storage as { username, expiresAt } objects
function persistMutedUsers() {
  const arr = Array.from(mutedUsers.entries()).map(([username, expiresAt]) => ({ username, expiresAt }));
  browser.storage.local.set({ muted_users: arr });
}

// Remove expired mutes and broadcast unmutes
function pruneExpiredMutes() {
  const now = Date.now();
  const expired = [];
  for (const [username, expiresAt] of mutedUsers) {
    if (expiresAt !== null && expiresAt <= now) {
      expired.push(username);
    }
  }
  if (expired.length > 0) {
    expired.forEach(u => {
      mutedUsers.delete(u);
      broadcastToTabs({ type: 'user_unmuted', username: u });
    });
    persistMutedUsers();
    log(' Pruned', expired.length, 'expired mutes');
  }
}

// Prune expired mutes every 60s
trackInterval(setInterval(pruneExpiredMutes, 60000));

// Broadcast updates to all content scripts AND update storage
async function broadcastToTabs(message) {
  // Update storage for instant access
  if (message.type === 'inventory_update') {
    await browser.storage.local.set({ emote_inventory: message.emotes });
  } else if (message.type === 'global_emotes_update') {
    await browser.storage.local.set({ global_emotes: message.emotes });
  } else if (message.type === 'blocked_update') {
    await browser.storage.local.set({ blocked_emotes: message.blocked });
  }

  // Broadcast to streaming tabs only (filtered query instead of all-tabs scan)
  try {
    const tabs = await browser.tabs.query({ url: ['*://*.twitch.tv/*', '*://*.kick.com/*', '*://*.youtube.com/*'] })
    for (const tab of tabs) {
      browser.tabs.sendMessage(tab.id, message).catch(() => {})
    }
  } catch (e) {}
}

// =============================================================================
// BULLETPROOF WEBSOCKET CONNECTION
// =============================================================================
// Features:
// - Message queue for when socket isn't ready
// - Connection state machine
// - Automatic retry with exponential backoff
// - Flush queued messages on connect

const WS_STATE = {
  DISCONNECTED: 0,
  CONNECTING: 1,
  CONNECTED: 2,
  AUTHENTICATED: 3
};

let wsState = WS_STATE.DISCONNECTED;
let isAuthenticated = false;
let socketAuthToken = null;
let reconnectAttempts = 0;
let heartbeatInterval = null; // Keep connection alive
let reconnectTimer = null;
let messageQueue = []; // Queue messages when socket not ready
let connectionPromise = null; // Track ongoing connection attempt

function isSocketOpen() {
  return socket && socket.readyState === WebSocket.OPEN;
}

// Flush queued messages when socket becomes ready
function flushMessageQueue() {
  if (!isSocketOpen()) return;

  const queued = messageQueue.length;
  if (queued > 0) {
    log(` 📤 Flushing ${queued} queued messages`);
  }

  while (messageQueue.length > 0 && isSocketOpen()) {
    const msg = messageQueue.shift();
    try {
      socket.send(JSON.stringify(msg));
      log(` 📤 Sent queued: ${msg.type}`);
    } catch (err) {
      messageQueue.unshift(msg); // Put it back
      break;
    }
  }
}

async function connectWebSocket() {
  // If already connecting, wait for that attempt
  if (wsState === WS_STATE.CONNECTING && connectionPromise) {
    log(' Connection in progress, waiting...');
    return connectionPromise;
  }

  // If already connected with SAME token, skip
  if (isSocketOpen() && socketAuthToken === authToken && wsState >= WS_STATE.CONNECTED) {
    log(' Already connected with same token');
    return Promise.resolve();
  }

  // If connected with DIFFERENT token, disconnect first
  if (isSocketOpen() && socketAuthToken !== authToken) {
    log(' 🔄 Token changed, reconnecting...');
    socket.close();
    wsState = WS_STATE.DISCONNECTED;
    isAuthenticated = false;
  }

  // Make sure we have auth token before connecting
  if (!authToken) {
    log(' Loading auth token before connecting...');
    await getAuthCookie();
  }

  socketAuthToken = authToken;
  wsState = WS_STATE.CONNECTING;

  const wsEndpoint = `${WS_URL.replace('https://', 'wss://').replace('http://', 'ws://')}/ws`;
  log(' 🔌 Connecting to WebSocket:', wsEndpoint, 'with auth:', !!authToken);

  connectionPromise = new Promise((resolve, reject) => {
    try {
      socket = new WebSocket(wsEndpoint);
    } catch (err) {
      wsState = WS_STATE.DISCONNECTED;
      connectionPromise = null;
      scheduleReconnect();
      reject(err);
      return;
    }

    // Connection timeout (10 seconds)
    const connectTimeout = setTimeout(() => {
      if (wsState === WS_STATE.CONNECTING) {
        socket.close();
        wsState = WS_STATE.DISCONNECTED;
        connectionPromise = null;
        scheduleReconnect();
        reject(new Error('Connection timeout'));
      }
    }, 10000);

    socket.onopen = () => {
      clearTimeout(connectTimeout);
      log(' ✅ WebSocket connected');
      reconnectAttempts = 0;
      wsState = WS_STATE.CONNECTED;
      connectionPromise = null;

      // Start heartbeat to keep connection alive (server has 2min idle timeout)
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      heartbeatInterval = setInterval(() => {
        if (isSocketOpen()) {
          try {
            socket.send(JSON.stringify({ type: 'presence:heartbeat' }));
          } catch (err) {
            log(' Heartbeat send failed:', err?.message);
          }
        }
      }, 30000); // Every 30 seconds

      // Join channel immediately
      if (currentChannel) {
        const [platform, channel] = currentChannel.split('/');
        log(' 📺 Joining channel:', { platform, channel });
        wsSendDirect({ type: 'channel:join', platform, channel });
      }

      // Authenticate if we have a token
      if (authToken) {
        log(' 🔐 Authenticating...');
        wsSendDirect({ type: 'authenticate', token: authToken });
      } else {
        log(' ℹ️ No auth token - viewer mode');
        // Flush queue even without auth (for channel joins etc)
        flushMessageQueue();
      }

      // Re-subscribe to YouTube channels (global + per-channel)
      log('[hs-bg] WS connected, re-subscribing YouTube channels...')
      browser.storage.local.get(['youtube_url', 'youtube_channel_urls']).then(data => {
        log('[hs-bg] stored youtube data:', JSON.stringify(data))
        // Global YouTube (live tab)
        if (data.youtube_url) {
          const vidMatch = data.youtube_url.match(/[?&]v=([^&]+)/) || data.youtube_url.match(/\/live\/([^?&\/]+)/) || data.youtube_url.match(/youtu\.be\/([^?&]+)/)
          if (vidMatch) setYtVideoChannel(vidMatch[1], 'global')
          wsSend({ type: 'youtube:subscribe', url: data.youtube_url })
        }
        // Per-channel YouTube URLs
        if (data.youtube_channel_urls) {
          for (const [channelId, url] of Object.entries(data.youtube_channel_urls)) {
            const vidMatch = url.match(/[?&]v=([^&]+)/) || url.match(/\/live\/([^?&\/]+)/) || url.match(/youtu\.be\/([^?&]+)/)
            if (vidMatch) setYtVideoChannel(vidMatch[1], channelId)
            wsSend({ type: 'youtube:subscribe', url, channelId })
          }
        }
      }).catch(() => {})

      resolve();
    };

    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleWSMessage(msg);
      } catch (err) {
        log(' WS message parse error:', err?.message);
      }
    };

    socket.onclose = (event) => {
      clearTimeout(connectTimeout);
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }
      log(' ⚠️ WebSocket disconnected:', event.code, event.reason);
      wsState = WS_STATE.DISCONNECTED;
      isAuthenticated = false;
      connectionPromise = null;
      scheduleReconnect();
    };

    socket.onerror = (err) => {
      log(' WebSocket error:', err?.message || 'unknown')
    };
  });

  return connectionPromise;
}

// Direct send (bypasses queue) - used internally
function wsSendDirect(msg) {
  if (!isSocketOpen()) {
    log(' Cannot send direct - socket not open');
    return false;
  }
  try {
    socket.send(JSON.stringify(msg));
    return true;
  } catch (err) {
    return false;
  }
}

// Send JSON message over WebSocket (queues if not ready)
function wsSend(msg) {
  // If socket is open and ready, send immediately
  if (isSocketOpen()) {
    try {
      socket.send(JSON.stringify(msg));
      return true;
    } catch (err) {
    }
  }

  // Queue the message and ensure we're connecting
  log(` 📥 Queueing message: ${msg.type}`);
  messageQueue.push(msg);

  // Limit queue size to prevent memory issues
  if (messageQueue.length > 50) {
    messageQueue.shift(); // Remove oldest
  }

  // Trigger connection if not already connecting
  if (wsState === WS_STATE.DISCONNECTED) {
    connectWebSocket().catch(err => log(' WS connect failed:', err?.message));
  }

  return false;
}

// Handle incoming WebSocket messages
function handleWSMessage(msg) {
  try {
  log(' 📨 WS message received:', msg.type, msg);

  switch (msg.type) {
    case 'authenticated':
      log(' ✅ Authenticated, userId:', msg.userId);
      isAuthenticated = true;
      wsState = WS_STATE.AUTHENTICATED;
      pendingChannelJoin = null;
      // Flush any queued messages now that we're authenticated
      flushMessageQueue();
      break;

    case 'authentication_failed':
      isAuthenticated = false;
      break;

    case 'emote:broadcast':
      log(' 📢 EMOTE BROADCAST RECEIVED:', {
        username: msg.username,
        emoteName: msg.emoteName,
        currentChannel: currentChannel,
        emoteUrl: msg.emoteData?.url
      });
      broadcastToTabs({
        type: 'emote_broadcast',
        username: msg.username,
        emoteName: msg.emoteName,
        emoteData: msg.emoteData
      });
      break;

    case 'emote:removed':
      // Could be broadcast (other users) OR personal inventory removal
      if (msg.slot !== undefined) {
        // Personal inventory removal (has slot number)
        log(' 🗑️ EMOTE REMOVED FROM YOUR INVENTORY:', msg.name, 'slot:', msg.slot);
        fetchEmoteInventory();
      } else if (msg.username) {
        // Broadcast from other user
        log(' 🗑️ EMOTE REMOVED BROADCAST:', msg);
        broadcastToTabs({
          type: 'emote_removed_broadcast',
          username: msg.username,
          emoteName: msg.emoteName
        });
      }
      break;

    case 'emote:added':
      // Server notifies when emote is added to YOUR inventory (e.g., uploaded on website)
      log(' ✅ EMOTE ADDED TO INVENTORY:', msg.name, 'slot:', msg.slot);
      // Refresh inventory to get the new emote
      fetchEmoteInventory();
      break;

    case 'emote:blocked':
      if (msg.hash && !blockedEmotes.has(msg.hash)) {
        blockedEmotes.add(msg.hash)
        const blockedEmote = emoteInventory.find(e => e.hash === msg.hash)
        if (blockedEmote) {
          emoteInventory = emoteInventory.filter(e => e.hash !== msg.hash)
          broadcastToTabs({ type: 'inventory_update', emotes: emoteInventory })
        }
        broadcastToTabs({ type: 'blocked_update', blocked: Array.from(blockedEmotes) })
        broadcastToTabs({ type: 'emote_blocked', hash: msg.hash })
      }
      break

    case 'emote:unblocked':
      if (msg.hash && blockedEmotes.has(msg.hash)) {
        blockedEmotes.delete(msg.hash)
        broadcastToTabs({ type: 'blocked_update', blocked: Array.from(blockedEmotes) })
        broadcastToTabs({ type: 'emote_unblocked', hash: msg.hash })
      }
      break

    case 'new-message':
      log(' New message received:', msg);
      broadcastToTabs({
        type: 'new-message',
        data: msg
      });
      break;

    case 'notification:new':
      log(' Notification received:', msg);
      unreadNotifCount++;
      updateExtensionBadge();
      broadcastToTabs({
        type: 'notification:new',
        data: msg.data
      });
      break;

    case 'youtube:chat':
      // Relay YouTube chat messages to all Twitch/Kick tabs
      if (msg.messages && Array.isArray(msg.messages)) {
        // Use server-echoed channelId, fall back to local map
        const channelId = msg.channelId || ytVideoToChannel.get(msg.videoId) || 'global'
        // Update local map if server provided channelId
        if (msg.channelId && msg.videoId) setYtVideoChannel(msg.videoId, msg.channelId)
        for (const ytMsg of msg.messages) {
          broadcastToTabs({
            type: 'youtube_chat_message',
            videoId: msg.videoId,
            channelId,
            user: ytMsg.user,
            text: ytMsg.text,
            color: '#ff0000',
            time: ytMsg.timestamp || Date.now(),
            platform: 'youtube',
            emotes: ytMsg.emotes || [],
            msgType: ytMsg.type, // 'text', 'superchat', 'supersticker'
            amount: ytMsg.amount || '',
            scColor: ytMsg.color || '',
            sticker: ytMsg.sticker || null,
            source: 'server', // distinguish from content script messages
          })
        }
      }
      break

    case 'youtube:status':
      if (msg.status === 'connected') {
        activeYoutubeVideoId = msg.videoId
        // Map videoId → channelId from server-echoed channelId
        if (msg.channelId && msg.videoId) setYtVideoChannel(msg.videoId, msg.channelId)
      } else if (msg.status === 'ended' || msg.status === 'error') {
        if (activeYoutubeVideoId === msg.videoId) activeYoutubeVideoId = null
        ytVideoToChannel.delete(msg.videoId)
      }
      broadcastToTabs({
        type: 'youtube_status',
        videoId: msg.videoId,
        channelId: msg.channelId || ytVideoToChannel.get(msg.videoId) || 'global',
        status: msg.status,
        channelName: msg.channelName || '',
        title: msg.title || '',
        error: msg.error || '',
      })
      break

    case 'kick-chat-message':
      // Relay Kick chat messages (via server webhook) to content scripts
      broadcastToTabs({
        type: 'kick_chat_message',
        data: msg.data
      })
      break

    case 'error':
      break;

    default:
      log(' Unknown message type:', msg.type);
  }
  } catch (err) {
    console.error('[HS] handleWSMessage error:', err.message, 'type:', msg?.type);
  }
}

// Reconnect with exponential backoff
function scheduleReconnect() {
  if (reconnectTimer) return; // Already scheduled

  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000); // Max 30s
  reconnectAttempts++;
  log(` Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWebSocket();
  }, delay);
}

// Join channel room for emote broadcasting
async function joinChannel(platform, channelName, channelId = null) {
  currentChannel = `${platform}/${channelName}`;
  log(' 🚪 Setting channel:', currentChannel, 'id:', channelId);

  // Fetch channel owner's emotes (runs in parallel)
  fetchChannelOwnerEmotes(channelName, channelId);

  // Ensure we're connected first
  if (!isSocketOpen()) {
    await connectWebSocket();
  }

  // Always send channel:join (wsSend queues if not ready)
  wsSend({ type: 'channel:join', platform, channel: channelName });
  log(' 🚪 Joined channel:', currentChannel);
}

// Broadcast emote usage - returns success status
function broadcastEmoteUsage(emoteName, emoteHash) {
  if (!isSocketOpen() || !isAuthenticated || !currentChannel) {
    log(' ⚠️ Cannot broadcast emote - socket open:', isSocketOpen(), 'authenticated:', isAuthenticated, 'channel:', currentChannel);
    return { success: false, reason: 'not_ready', socketOpen: isSocketOpen(), authenticated: isAuthenticated, channel: currentChannel };
  }

  // Parse platform and channel from combined format
  const [platform, channel] = currentChannel.split('/');

  log(' 📤 BROADCASTING EMOTE USAGE:', {
    emoteName,
    platform,
    channel
  });

  wsSend({
    type: 'emote:used',
    platform,
    channel,
    emoteName,
    emoteHash
  });

  return { success: true };
}

// Add emote to your set (for global emotes clicked in chat) - returns success/failure
async function addToInventory(emoteName, emoteHash, emoteUrl) {
  try {
    const authToken = await getAuthCookie();
    if (!authToken) {
      broadcastToTabs({
        type: 'emote_add_failed',
        emoteName,
        error: 'Not logged in - visit heatsync.org to log in'
      });
      return { success: false, error: 'Not logged in' };
    }

    log(' Adding to your set via API:', emoteName);

    // Call server API to add emote
    const response = await fetchWithTimeout(`${API_URL}/api/user/emotes`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify({
        emoteUrl,
        emoteName,
        customName: emoteName,
        source: 'extension',
        sourceId: emoteHash
      })
    });

    const data = await response.json().catch(() => ({ error: 'Invalid response' }));

    if (!response.ok) {
      broadcastToTabs({
        type: 'emote_add_failed',
        emoteName,
        error: data.error || `Server error (${response.status})`
      });
      return { success: false, error: data.error || `HTTP ${response.status}` };
    }

    log(' ✅ Added to server inventory:', data);

    // Update local inventory immediately
    const newEmote = {
      name: emoteName,
      hash: data.hash || emoteHash,
      url: emoteUrl,
      slot: data.slot
    };

    // Check if already in your set (by hash) to avoid duplicates
    if (!emoteInventory.some(e => e.hash === newEmote.hash)) {
      emoteInventory.push(newEmote);
    }

    // Broadcast success to tabs
    broadcastToTabs({
      type: 'emote_added',
      emoteName: emoteName,
      hash: data.hash || emoteHash,
      url: emoteUrl,
      slot: data.slot,
      alreadyExists: data.alreadyExists
    });

    // Also update storage for persistence
    await browser.storage.local.set({ emote_inventory: emoteInventory });

    return { success: true, slot: data.slot, alreadyExists: data.alreadyExists };
  } catch (error) {
    broadcastToTabs({
      type: 'emote_add_failed',
      emoteName,
      error: error.message || 'Network error'
    });
    return { success: false, error: error.message || 'Network error' };
  }
}

// Remove emote from your set - returns success/failure
async function removeFromInventory(emoteHash, emoteName) {
  try {
    const authToken = await getAuthCookie();
    if (!authToken) {
      broadcastToTabs({
        type: 'emote_remove_failed',
        emoteName,
        error: 'Not logged in'
      });
      return { success: false, error: 'Not logged in' };
    }

    log(' Removing from your set via API:', emoteName, 'hash:', emoteHash?.substring(0, 8));

    // Find slot number by hash or name
    const emote = emoteInventory.find(e => e.hash === emoteHash || e.name === emoteName);
    if (!emote) {
      // Still try to refetch in case local state is stale
      await fetchEmoteInventory();
      broadcastToTabs({
        type: 'emote_remove_failed',
        emoteName,
        error: 'Emote not found in your set'
      });
      return { success: false, error: 'Emote not found in your set' };
    }

    if (!emote.slot) {
      // Refetch to get correct slot numbers
      await fetchEmoteInventory();
      // Try again after refetch
      const refreshedEmote = emoteInventory.find(e => e.hash === emoteHash || e.name === emoteName);
      if (!refreshedEmote?.slot) {
        broadcastToTabs({
          type: 'emote_remove_failed',
          emoteName,
          error: 'Could not determine emote slot'
        });
        return { success: false, error: 'Could not determine emote slot' };
      }
      emote.slot = refreshedEmote.slot;
    }

    // Call server API to remove emote
    const response = await fetchWithTimeout(`${API_URL}/api/user/emotes/${emote.slot}`, {
      method: 'DELETE',
      credentials: 'include',
      headers: {
        'Authorization': `Bearer ${authToken}`
      }
    });

    const data = await response.json().catch(() => ({ error: 'Invalid response' }));

    if (!response.ok) {
      broadcastToTabs({
        type: 'emote_remove_failed',
        emoteName,
        error: data.error || `Server error (${response.status})`
      });
      return { success: false, error: data.error || `HTTP ${response.status}` };
    }

    log(' ✅ Removed from server inventory:', data);

    // Update local inventory
    emoteInventory = emoteInventory.filter(e => e.hash !== emoteHash && e.name !== emoteName);
    await browser.storage.local.set({ emote_inventory: emoteInventory });

    // Broadcast success to tabs
    broadcastToTabs({
      type: 'emote_removed',
      emoteName,
      hash: emoteHash,
      slot: emote.slot
    });

    // Broadcast removal to other clients so they clear pending broadcasts
    if (isSocketOpen() && currentChannel) {
      const [platform, channel] = currentChannel.split('/');
      wsSend({
        type: 'emote:removed',
        platform,
        channel,
        emoteName: emoteName
      });
      log(' 📤 Broadcasted emote removal:', emoteName);
    }

    return { success: true, slot: emote.slot };
  } catch (error) {
    broadcastToTabs({
      type: 'emote_remove_failed',
      emoteName,
      error: error.message || 'Network error'
    });
    return { success: false, error: error.message || 'Network error' };
  }
}

// ========== COSMETICS (FFZ Badges, BTTV Badges) ==========

// Cosmetics data stores (FFZ + BTTV badges)
const cosmeticsData = {
  // FFZ badges: badgeId -> { name, title, color, urls, userIds: Set }
  ffzBadges: new Map(),
  // FFZ user lookup: twitchId -> [badgeId, ...]
  ffzUserBadges: new Map(),
  // BTTV badges: twitchId -> { type, description, svg }
  bttvUserBadges: new Map(),
}

// Fetch FFZ badges (bulk endpoint - all users in one call)
async function fetchFFZBadges() {
  try {
    const response = await fetchWithTimeout('https://api.frankerfacez.com/v1/badges/ids')
    if (!response.ok) return

    const data = await response.json()
    cosmeticsData.ffzBadges.clear()
    cosmeticsData.ffzUserBadges.clear()

    // data.badges = array of badge definitions
    // data.users = { badgeId: [userId, ...] }
    for (const badge of (data.badges || [])) {
      cosmeticsData.ffzBadges.set(badge.id, {
        id: badge.id,
        name: badge.name,
        title: badge.title,
        color: badge.color,
        urls: badge.urls
      })
    }

    // Build user -> badges lookup
    for (const [badgeId, userIds] of Object.entries(data.users || {})) {
      const id = parseInt(badgeId)
      for (const userId of userIds) {
        const uid = String(userId)
        if (!cosmeticsData.ffzUserBadges.has(uid)) {
          cosmeticsData.ffzUserBadges.set(uid, [])
        }
        cosmeticsData.ffzUserBadges.get(uid).push(id)
      }
    }

    log(' FFZ badges loaded:', cosmeticsData.ffzBadges.size, 'badges,', cosmeticsData.ffzUserBadges.size, 'users')
  } catch (err) {
    log(' FFZ badges error:', err.message)
  }
}

// Fetch BTTV badges (bulk endpoint - ~158 users)
async function fetchBTTVBadges() {
  try {
    const response = await fetchWithTimeout('https://api.betterttv.net/3/cached/badges')
    if (!response.ok) return

    const data = await response.json()
    cosmeticsData.bttvUserBadges.clear()

    for (const entry of data) {
      cosmeticsData.bttvUserBadges.set(String(entry.providerId), {
        type: entry.badge?.type || entry.type,
        description: entry.badge?.description || entry.description,
        svg: entry.badge?.svg || entry.svg
      })
    }

    log(' BTTV badges loaded:', cosmeticsData.bttvUserBadges.size, 'users')
  } catch (err) {
    log(' BTTV badges error:', err.message)
  }
}

// Handle messages from content scripts
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const senderUrl = sender?.tab?.url || sender?.url || ''
  const isFromPopup = !sender?.tab // popup/background have no tab
  const isValidSender = isFromPopup || /^https:\/\/(www\.)?(twitch\.tv|kick\.com|heatsync\.org|youtube\.com)/.test(senderUrl)

  // Validate ALL content script senders, not just sensitive types
  if (!isValidSender) {
    sendResponse({ ok: false, error: 'unauthorized sender' })
    return true
  }

  // YouTube chat relay — forward to Twitch/Kick tabs only (not back to YouTube)
  if (message.type === 'youtube_chat_message' && !message.source) {
    // Only relay content-script-sourced messages (no source field)
    browser.tabs.query({ url: ['*://*.twitch.tv/*', '*://*.kick.com/*'] }).then(tabs => {
      for (const tab of tabs) {
        browser.tabs.sendMessage(tab.id, message).catch(() => {})
      }
    }).catch(() => {})
    return
  }

  // Proxy fetch for live status (avoids CORS in content script)
  if (message.type === 'fetch_live_status') {
    const channels = message.channels
    if (!channels?.length) { sendResponse(null); return true }
    fetch(`https://heatsync.org/api/platform/live-status?channels=${encodeURIComponent(channels.join(','))}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => sendResponse(data))
      .catch(() => sendResponse(null))
    return true // async sendResponse
  }

  // YouTube subscribe via WS server — from multichat content script
  if (message.type === 'youtube_ws_subscribe') {
    const url = message.url
    const channelId = message.channelId || 'global'
    log('[hs-bg] youtube_ws_subscribe received:', { url, channelId, socketOpen: isSocketOpen() })
    if (url) {
      // Extract videoId from URL for routing (always, even if socket is down)
      const vidMatch = url.match(/[?&]v=([^&]+)/) || url.match(/\/live\/([^?&\/]+)/) || url.match(/youtu\.be\/([^?&]+)/)
      if (vidMatch) setYtVideoChannel(vidMatch[1], channelId)
      // Send subscribe if socket is open
      if (isSocketOpen()) {
        log('[hs-bg] sending youtube:subscribe to WS:', { url, channelId })
        wsSend({ type: 'youtube:subscribe', url, channelId })
      } else {
        log('[hs-bg] socket NOT open, queuing youtube:subscribe')
      }
      // Always persist for reconnect (even if socket is currently down)
      if (channelId === 'global') {
        browser.storage.local.set({ youtube_url: url })
      } else {
        browser.storage.local.get(['youtube_channel_urls']).then(data => {
          const urls = data.youtube_channel_urls || {}
          urls[channelId] = url
          browser.storage.local.set({ youtube_channel_urls: urls })
        }).catch(() => {})
      }
      log(' YouTube subscribe:', url, 'channel:', channelId, isSocketOpen() ? '' : '(queued for reconnect)')
    }
    sendResponse({ ok: true })
    return
  }

  // YouTube unsubscribe
  if (message.type === 'youtube_ws_unsubscribe') {
    const channelId = message.channelId || 'global'
    // Try videoId from message first, then extract from stored URL
    let videoId = message.videoId
    if (!videoId && message.url) {
      const vidMatch = message.url.match(/[?&]v=([^&]+)/) || message.url.match(/\/live\/([^?&\/]+)/) || message.url.match(/youtu\.be\/([^?&]+)/)
      if (vidMatch) videoId = vidMatch[1]
    }
    if (videoId && isSocketOpen()) {
      wsSend({ type: 'youtube:unsubscribe', videoId })
    }
    if (videoId) {
      ytVideoToChannel.delete(videoId)
      if (activeYoutubeVideoId === videoId) activeYoutubeVideoId = null
    }
    // Clean up storage
    if (channelId === 'global') {
      browser.storage.local.remove(['youtube_url'])
    } else {
      browser.storage.local.get(['youtube_channel_urls']).then(data => {
        const urls = data.youtube_channel_urls || {}
        delete urls[channelId]
        browser.storage.local.set({ youtube_channel_urls: urls })
      }).catch(() => {})
    }
    log(' YouTube unsubscribe:', videoId || '(no videoId)', 'channel:', channelId)
    sendResponse({ ok: true })
    return
  }

  // Forward arbitrary WS message from content scripts (used by multichat kick channels)
  if (message.type === 'ws_send') {
    if (message.data) wsSend(message.data)
    sendResponse({ ok: true })
    return
  }

  if (message.type === 'set_auth_token') {
    authToken = message.token;
    log(' Received auth token from content script');
    // Clear old cached inventory before setting new token (prevents wrong user's emotes)
    emoteInventory = [];
    blockedEmotes = new Set();
    followedUsers = [];
    browser.storage.local.remove(['emote_inventory', 'blocked_emotes']);
    // Persist new token to encrypted storage
    storeToken(message.token);
    // Fetch inventory now that we have token
    fetchEmoteInventory();
    fetchBlockedEmotes();
    fetchFollowedUsers();
    // IMPORTANT: Reconnect WebSocket with new token (fixes stale auth after login switch)
    log(' 🔄 Reconnecting WebSocket with new auth token...');
    connectWebSocket();
  } else if (message.type === 'block_emote') {
    // Async - send response when done
    blockEmote(message.hash).then(result => {
      sendResponse(result);
    });
    return true; // Keep channel open for async response
  } else if (message.type === 'unblock_emote') {
    // Async - send response when done
    unblockEmote(message.hash).then(result => {
      sendResponse(result);
    });
    return true; // Keep channel open for async response
  } else if (message.type === 'add_to_inventory') {
    // Async - send response when done
    addToInventory(message.emoteName, message.emoteHash, message.emoteUrl).then(result => {
      sendResponse(result);
    });
    return true; // Keep channel open for async response
  } else if (message.type === 'remove_from_inventory') {
    // Async - send response when done
    removeFromInventory(message.emoteHash, message.emoteName).then(result => {
      sendResponse(result);
    });
    return true; // Keep channel open for async response
  } else if (message.type === 'mute_user') {
    const expiresAt = message.expiresAt || null;
    mutedUsers.set(message.username, expiresAt);
    persistMutedUsers();
    broadcastToTabs({ type: 'user_muted', username: message.username });
    log(' Muted user:', message.username, expiresAt ? `(expires ${new Date(expiresAt).toISOString()})` : '(permanent)');
  } else if (message.type === 'unmute_user') {
    mutedUsers.delete(message.username);
    persistMutedUsers();
    broadcastToTabs({ type: 'user_unmuted', username: message.username });
    log(' Unmuted user:', message.username);
  } else if (message.type === 'get_muted_users') {
    sendResponse({ users: Array.from(mutedUsers.keys()) });
  } else if (message.type === 'block_user') {
    blockedUsers.add(message.username);
    browser.storage.local.set({ blocked_users: Array.from(blockedUsers) });
    broadcastToTabs({ type: 'user_blocked', username: message.username });
    log(' Blocked user:', message.username);
  } else if (message.type === 'unblock_user') {
    blockedUsers.delete(message.username);
    browser.storage.local.set({ blocked_users: Array.from(blockedUsers) });
    broadcastToTabs({ type: 'user_unblocked', username: message.username });
    log(' Unblocked user:', message.username);
  } else if (message.type === 'get_blocked_users') {
    sendResponse({ users: Array.from(blockedUsers) });
  } else if (message.type === 'get_inventory') {
    // Async - wait for init to complete first
    (async () => {
      if (initPromise) {
        await initPromise;
      }
      log(' Background: get_inventory request - responding with', emoteInventory.length, 'personal,', globalEmotes.length, 'global');
      sendResponse({
        emotes: emoteInventory,
        globalEmotes: globalEmotes,
        blocked: Array.from(blockedEmotes)
      });
    })();
    return true; // Keep channel open for async response
  } else if (message.type === 'get_followed_users') {
    sendResponse({
      users: followedUsers
    });
    return true;
  } else if (message.type === 'join_channel') {
    // Content script detected channel change
    log(' 📺 Content script requesting channel join:', message.platform, '/', message.channel, 'id:', message.channelId);
    joinChannel(message.platform, message.channel, message.channelId);
    sendResponse({ received: true });
  } else if (message.type === 'emote_sent') {
    // Content script detected user sent emote
    log(' 💬 Content script detected emote sent:', message.emoteName);
    const result = broadcastEmoteUsage(message.emoteName, message.emoteHash);
    log(' 📤 Broadcast result:', result);
    sendResponse(result || { success: false, reason: 'unknown' });
    return true; // Keep channel open for response
  } else if (message.type === 'get_channel_emotes') {
    // Multichat/content requesting channel emotes (may have missed the broadcast)
    const totalEmotes = Object.values(channelEmotesMap).reduce((sum, e) => sum + (Array.isArray(e) ? e.length : 0), 0);
    if (totalEmotes > 0) {
      browser.storage.local.set({ channel_emotes_map: channelEmotesMap });
      for (const [ch, emotes] of Object.entries(channelEmotesMap)) {
        if (Array.isArray(emotes)) broadcastToTabs({ type: 'channel_emotes_update', emotes, channelOwner: ch });
      }
    }
    sendResponse({ count: totalEmotes });
  } else if (message.type === 'refresh_all') {
    // Refresh all emotes (called from popup)
    (async () => {
      await Promise.all([
        fetchGlobalEmotes(),
        fetchEmoteInventory(),
        fetchBlockedEmotes()
      ]);
      sendResponse({ success: true });
    })();
    return true;
  } else if (message.type === 'clear_blocked') {
    // Clear all blocked emotes
    blockedEmotes.clear();
    browser.storage.local.set({ blocked_emotes: [] });
    if (authToken) {
      fetchWithTimeout(`${API_URL}/api/user/emotes/blocks/clear`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${authToken}` }
      }).catch(err => log(' Clear blocked emotes failed:', err?.message));
    }
    broadcastToTabs({ type: 'blocked_update', blocked: [] });
    sendResponse({ success: true });
  } else if (message.type === 'notifs_viewed') {
    unreadNotifCount = 0;
    updateExtensionBadge();
  } else if (message.type === 'api_fetch') {
    // Generic API proxy — content scripts route through here to bypass CORS
    if (!message.path || !message.path.startsWith('/api/')) {
      sendResponse({ ok: false, error: 'invalid path' });
      return true;
    }
    (async () => {
      try {
        const opts = { method: message.method || 'GET', headers: {} }
        if (message.auth && authToken) {
          opts.headers['Authorization'] = `Bearer ${authToken}`
        }
        if (message.body) {
          opts.headers['Content-Type'] = 'application/json'
          opts.body = JSON.stringify(message.body)
        }
        const resp = await fetchWithTimeout(`${API_URL}${message.path}`, opts)
        if (!resp.ok) {
          sendResponse({ ok: false, status: resp.status })
          return
        }
        const data = await resp.json()
        sendResponse({ ok: true, data })
      } catch (err) {
        sendResponse({ ok: false, error: err.message })
      }
    })()
    return true
  }
});

// Initialize on startup
async function initialize() {
  log(' 🚀 Starting background script...');

  // Load stored auth token (from encrypted storage)
  try {
    const stored = await retrieveToken();
    if (stored) {
      authToken = stored;
      log(' ✓ Loaded auth token from encrypted storage');
    }
  } catch (err) {
    log(' Could not load auth token:', err.message);
  }

  // Load muted users from storage (migrate old array format to map)
  try {
    const stored = await browser.storage.local.get('muted_users');
    if (stored.muted_users && Array.isArray(stored.muted_users)) {
      mutedUsers = new Map();
      for (const entry of stored.muted_users) {
        if (typeof entry === 'string') {
          // Old format: plain string → permanent mute
          mutedUsers.set(entry, null);
        } else if (entry && entry.username) {
          mutedUsers.set(entry.username, entry.expiresAt || null);
        }
      }
      // Re-persist in new format if migrated
      if (stored.muted_users.length > 0 && typeof stored.muted_users[0] === 'string') {
        persistMutedUsers();
      }
      pruneExpiredMutes();
      log(' ✓ Loaded', mutedUsers.size, 'muted users from storage');
    }
  } catch (err) {
    log(' Could not load muted users:', err.message);
  }

  // Load blocked users from storage
  try {
    const stored = await browser.storage.local.get('blocked_users');
    if (stored.blocked_users && Array.isArray(stored.blocked_users)) {
      blockedUsers = new Set(stored.blocked_users);
      log(' ✓ Loaded', blockedUsers.size, 'blocked users from storage');
    }
  } catch (err) {
    log(' Could not load blocked users:', err.message);
  }

  broadcastToTabs({ type: 'loading_status', text: 'loading emotes...' });
  log(' Fetching emotes in parallel...');

  // Fetch everything in parallel for speed
  await Promise.all([
    fetchGlobalEmotes(),
    fetchEmoteInventory(),
    fetchBlockedEmotes(),
    fetchFollowedUsers(),
    fetchFFZBadges(),
    fetchBTTVBadges()
  ]);

  log(' ✓ All fetches complete - global:', globalEmotes.length, 'personal:', emoteInventory.length);
  broadcastToTabs({ type: 'loading_status', done: true });

  // Store in browser.storage for instant access by content scripts
  await browser.storage.local.set({
    global_emotes: globalEmotes,
    emote_inventory: emoteInventory,
    blocked_emotes: Array.from(blockedEmotes)
  });
  log(' ✅ READY - Stored in browser.storage');
  log(' Storage check:', globalEmotes.length, 'global,', emoteInventory.length, 'personal');

  connectWebSocket();

  // Refresh inventory every 60 seconds
  trackInterval(setInterval(fetchEmoteInventory, 60000));

  // Refresh global emotes every 24 hours
  trackInterval(setInterval(fetchGlobalEmotes, 86400000));

  // Refresh FFZ/BTTV badge definitions every hour
  trackInterval(setInterval(() => {
    fetchFFZBadges()
    fetchBTTVBadges()
  }, 3600000));
}

log(' 🚀 Calling initialize()...');
initPromise = initialize().catch(err => {
  console.error('[heatsync] Initialize failed:', err);
});
