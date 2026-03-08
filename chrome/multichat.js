/**
 * Heatsync MultiChat - FFZ-style React-aware implementation
 *
 * KEY PRINCIPLE: Work WITHIN React, not around it.
 * - Never manipulate DOM after React renders
 * - Hook into React components and modify render output
 * - Use forceUpdate() to trigger re-renders
 * - Inject UI as React children, not DOM insertions
 */

(function() {
  'use strict';

  const STORAGE_KEY = 'heatsync_multichat';
  const LOG_PREFIX = '[heatsync-mc]';

  // Safe chrome.runtime.sendMessage wrapper (context invalidation guard)
  function safeSendMessage(message) {
    try {
      return chrome.runtime.sendMessage(message);
    } catch (e) {
      log('sendMessage failed:', e.message);
      return Promise.resolve({ ok: false, error: 'context invalidated' });
    }
  }

  // State
  let config = { channels: [], enabled: true };
  let currentTab = 'live';
  let irc = null;
  let kickChat = null;
  let currentUsername = null;
  let chatRoomComponent = null;
  let originalRender = null;
  let tabBarElement = null;
  let overlayElement = null;
  let inputBarElement = null;  // Separate input bar (always visible)
  let pendingMessage = '';     // Persists across tab switches
  let isHooked = false;
  let tabPosition = 'top'; // 'top', 'right', 'bottom', 'left'
  let resizeObserver = null; // Tracks overlay top sync observer

  // Muted users (right-click to hide) — loaded async from chrome.storage.local
  let mutedUsers = new Set();

  // Buffers
  const mentionsBuffer = [];
  const postsBuffer = [];
  const MAX_BUFFER = 500;

  // Scoped emote wrapper query (avoids full-document scan)
  function queryEmoteWrappers(emoteName) {
    const scope = document.getElementById('hs-mc-overlay') || document
    return scope.querySelectorAll(`.hs-mc-emote-wrapper[data-emote-name="${CSS.escape(emoteName)}"]`)
  }

  // Batch-remove excess children using a Range (single reflow instead of N)
  function trimChildren(el, limit) {
    const excess = el.children.length - limit
    if (excess > 0) {
      const range = document.createRange()
      range.setStartBefore(el.firstChild)
      range.setEndBefore(el.children[excess])
      range.deleteContents()
    }
  }

  let mentionsSeenCount = 0; // Track how many mentions user has seen
  let postsSeenCount = 0;

  // Per-channel YouTube: messages and links
  const channelYtMessages = new Map();  // channelTabId → message[]
  const youtubeLinks = new Map();       // channelTabId → { url, videoId, channelName }

  // YouTube global state (per-channel only now — global removed)

  // Feed & notifications state
  let feedMessages = [];
  let feedLoaded = false;
  let feedLoading = false;
  let feedPage = 1;
  let feedHasMore = true;
  let feedLastFetch = 0; // Timestamp of last feed fetch
  const FEED_STALE_MS = 120000; // 2 minutes
  let notifications = { mentions: 0, op_replies: 0, re_replies: 0, total: 0 };
  let notifMessages = []; // Actual notification messages for display
  let notifLoaded = false;
  let unreadNotifCount = 0;
  let expandedThreadId = null; // Currently expanded thread in feed
  let threadReplies = []; // Replies for expanded thread
  let isKick = location.hostname.includes('kick.com');
  const hostPlatform = isKick ? 'kick' : location.hostname.includes('youtube.com') ? 'yt' : 'twitch';
  let hsAuthToken = null; // Heatsync auth state (loaded from storage)

  // Username cache for tab completion
  const usernameCache = new Set();
  // Username → color map for @mention coloring (LRU-bounded)
  const knownColors = new Map();

  // Emote size (1, 2, or 4)
  let emoteSize = 1;

  // Dedup: track recent server-sourced YouTube messages to skip content-script duplicates
  const ytServerMsgHashes = new Set();

  // Normalize YouTube URL — accepts full URLs or bare username
  const normalizeYtUrl = (raw) => {
    // Bare username (no slashes, no dots) → /@name/live
    if (/^@?[\w-]+$/.test(raw)) {
      const name = raw.startsWith('@') ? raw.slice(1) : raw
      return 'https://www.youtube.com/@' + name + '/live'
    }
    try {
      const u = new URL(raw)
      const v = u.searchParams.get('v')
      if (v) return 'https://www.youtube.com/watch?v=' + v
      const liveMatch = raw.match(/\/live\/([^?&\/]+)/)
      if (liveMatch) return 'https://www.youtube.com/live/' + liveMatch[1]
      const shortMatch = raw.match(/youtu\.be\/([^?&]+)/)
      if (shortMatch) return 'https://www.youtube.com/watch?v=' + shortMatch[1]
    } catch {}
    return raw
  }

  const MC_DEBUG = false;
  function log(...args) {
    if (MC_DEBUG) console.log(LOG_PREFIX, ...args);
  }

  // Lifecycle controller — abort() tears down ALL listeners, timers, observers
  const lifecycle = new AbortController()
  const mcSignal = lifecycle.signal
  const _timers = { intervals: [], timeouts: [], observers: [] }
  mcSignal.addEventListener('abort', () => {
    _timers.intervals.forEach(clearInterval)
    _timers.timeouts.forEach(clearTimeout)
    _timers.observers.forEach(o => o.disconnect())
    // Disconnect IRC + Kick on teardown
    if (irc) { irc.destroy(); }
    if (kickChat) { kickChat.destroy(); }
    // Clear handler guards so they re-register on re-init
    delete window._hsMcEmoteContextHandler
    delete window._hsMcEmoteClickHandler
    delete window._hsEmoteTooltipSetup
    delete window._hsMcSettingsListener
  })
  window.addEventListener('pagehide', () => lifecycle.abort())

  const cleanup = {
    setInterval(fn, ms) { const id = setInterval(fn, ms); _timers.intervals.push(id); return id },
    setTimeout(fn, ms) { const id = setTimeout(fn, ms); _timers.timeouts.push(id); return id },
    addEventListener(target, event, handler) {
      target.addEventListener(event, handler, { signal: mcSignal })
    },
    trackObserver(obs) { _timers.observers.push(obs); return obs },
    raf(fn) { return requestAnimationFrame(fn) },
  }

  // ============================================
  // CIRCULAR BUFFER FOR CHANNEL MESSAGES
  // ============================================
  class CircularBuffer {
    constructor(cap = 500) {
      this.buf = new Array(cap);
      this.cap = cap;
      this.head = 0;
      this.size = 0;
    }
    push(item) {
      this.buf[this.head] = item;
      this.head = (this.head + 1) % this.cap;
      if (this.size < this.cap) this.size++;
    }
    getAll() {
      if (this.size === 0) return [];
      if (this.size < this.cap) return this.buf.slice(0, this.size);
      // Concat instead of spread — avoids 2 temporary arrays
      return this.buf.slice(this.head).concat(this.buf.slice(0, this.head));
    }
  }

  // ============================================
  // TWITCH IRC CLIENT (READ-ONLY)
  // ============================================
  class IRC {
    constructor() {
      this.ws = null;
      this.channels = new Map();
      this.handlers = new Map();
      this.partial = '';
      this.nick = `justinfan${Math.floor(Math.random() * 99999)}`;
      this._destroyed = false;
    }

    connect() {
      if (this._destroyed) return;
      if (this.ws?.readyState === WebSocket.OPEN) return;
      this.ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
      this.ws.onopen = async () => {
        log('IRC connected');
        // Fetch badges BEFORE joining channels so first messages render with images
        await fetchGlobalBadges()
        const currentCh = getCurrentChannel()
        if (currentCh) await fetchChannelBadges(currentCh)
        if (this.ws.readyState !== WebSocket.OPEN) return
        this.ws.send(`NICK ${this.nick}\r\n`);
        this.ws.send('CAP REQ :twitch.tv/tags\r\n');
        for (const ch of this.channels.keys()) {
          if (this.ws.readyState !== WebSocket.OPEN) return
          this.ws.send(`JOIN #${ch}\r\n`);
        }
      };
      this.ws.onmessage = (e) => this.parse(e.data);
      this.ws.onclose = () => {
        if (this._destroyed) return;
        log('IRC disconnected, reconnecting...');
        setTimeout(() => this.connect(), 3000);
      };
    }

    destroy() {
      this._destroyed = true;
      try { this.ws?.close(); } catch {}
    }

    parse(data) {
      this.partial += data;
      const lines = this.partial.split('\r\n');
      this.partial = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        if (line.startsWith('PING')) {
          this.ws.send('PONG :tmi.twitch.tv\r\n');
          continue;
        }
        const m = line.match(/@([^ ]+) :([^!]+)![^ ]+ PRIVMSG #(\w+) :(.+)/);
        if (m) {
          const tags = {};
          m[1].split(';').forEach(t => { const [k,v] = t.split('='); tags[k] = v; });
          const username = tags['display-name'] || m[2];
          const msg = {
            user: username,
            text: m[4],
            color: sanitizeColor(tags.color || '#fff'),
            badges: tags.badges || '',
            channel: m[3].toLowerCase(),
            time: Date.now(),
            replyTo: tags['reply-parent-display-name'] ? {
              user: decodeURIComponent(tags['reply-parent-display-name']),
              text: tags['reply-parent-msg-body'] ? decodeURIComponent(tags['reply-parent-msg-body'].replace(/\\s/g, ' ')) : ''
            } : null
          };

          // Cache username for tab completion + color (cap at 500)
          usernameCache.add(username);
          knownColors.set(username.toLowerCase(), msg.color);
          if (usernameCache.size > 500) {
            usernameCache.delete(usernameCache.values().next().value);
            const oldest = knownColors.keys().next().value;
            knownColors.delete(oldest);
          }

          // Fetch channel badges by login name (GQL uses login, not room-id)
          const ch = m[3].toLowerCase();
          fetchChannelBadges(ch)
          // Detect channel point redeems
          if (tags['custom-reward-id']) msg.redeemed = true

          if (this.channels.has(ch)) {
            this.channels.get(ch).push(msg);
            this.emit('message', msg);
          }
        }

        // USERNOTICE — resubs, gift subs, raids, announcements
        const un = line.match(/@([^ ]+) :tmi\.twitch\.tv USERNOTICE #(\w+)(?: :(.+))?/);
        if (un) {
          const tags = {};
          un[1].split(';').forEach(t => { const [k,v] = t.split('='); tags[k] = v; });
          const displayName = tags['display-name'] || 'system';
          const ch = un[2].toLowerCase();
          const systemMsg = decodeURIComponent((tags['system-msg'] || '').replace(/\\s/g, ' '));
          const msg = {
            user: displayName,
            text: un[3] || '',
            systemMsg,
            color: sanitizeColor(tags.color || '#fff'),
            badges: tags.badges || '',
            channel: ch,
            time: parseInt(tags['tmi-sent-ts']) || Date.now(),
            type: 'usernotice',
            msgId: tags['msg-id'] || ''
          };
          usernameCache.add(displayName);
          knownColors.set(displayName.toLowerCase(), msg.color);
          fetchChannelBadges(ch);
          if (this.channels.has(ch)) {
            this.channels.get(ch).push(msg);
            this.emit('message', msg);
          }
        }
      }
    }

    join(ch) {
      ch = ch.toLowerCase();
      if (this.channels.has(ch)) return;
      this.channels.set(ch, new CircularBuffer(500));
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(`JOIN #${ch}\r\n`);
      }
      log('Joined', ch);
      // Load message history
      this.loadHistory(ch);
    }

    async loadHistory(ch) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      try {
        log('Loading history for', ch);
        const resp = await fetch(`https://recent-messages.robotty.de/api/v2/recent-messages/${ch}?limit=100`, { signal: ctrl.signal });
        log('History response status:', resp.status);
        if (!resp.ok) {
          log('History fetch failed:', resp.status, resp.statusText);
          return;
        }
        const data = await resp.json();
        log('History data:', data.messages?.length, 'messages');
        if (!data.messages || !Array.isArray(data.messages)) {
          log('No messages array in response');
          return;
        }

        const buffer = this.channels.get(ch);
        if (!buffer) {
          log('No buffer for channel', ch);
          return;
        }

        // Fetch channel badges before parsing so badge images are ready for render
        await fetchChannelBadges(ch)

        let parsed = 0;
        // Parse IRC format messages
        for (const line of data.messages) {
          const m = line.match(/@([^ ]+) :([^!]+)![^ ]+ PRIVMSG #(\w+) :(.+)/);
          if (m) {
            const tags = {};
            m[1].split(';').forEach(t => { const [k,v] = t.split('='); tags[k] = v; });
            const username = tags['display-name'] || m[2];
            const msg = {
              user: username,
              text: m[4],
              color: sanitizeColor(tags.color || '#fff'),
              badges: tags.badges || '',
              channel: m[3].toLowerCase(),
              time: parseInt(tags['tmi-sent-ts']) || Date.now(),
              isHistory: true,
              replyTo: tags['reply-parent-display-name'] ? {
                user: decodeURIComponent(tags['reply-parent-display-name']),
                text: tags['reply-parent-msg-body'] ? decodeURIComponent(tags['reply-parent-msg-body'].replace(/\\s/g, ' ')) : ''
              } : null
            };
            // Detect channel point redeems in history
            if (tags['custom-reward-id']) msg.redeemed = true

            usernameCache.add(username);
            knownColors.set(username.toLowerCase(), msg.color);
            buffer.push(msg);
            parsed++;
            continue;
          }

          // USERNOTICE in history
          const un = line.match(/@([^ ]+) :tmi\.twitch\.tv USERNOTICE #(\w+)(?: :(.+))?/);
          if (un) {
            const tags = {};
            un[1].split(';').forEach(t => { const [k,v] = t.split('='); tags[k] = v; });
            const displayName = tags['display-name'] || 'system';
            const systemMsg = decodeURIComponent((tags['system-msg'] || '').replace(/\\s/g, ' '));
            const msg = {
              user: displayName,
              text: un[3] || '',
              systemMsg,
              color: sanitizeColor(tags.color || '#fff'),
              badges: tags.badges || '',
              channel: un[2].toLowerCase(),
              time: parseInt(tags['tmi-sent-ts']) || Date.now(),
              isHistory: true,
              type: 'usernotice',
              msgId: tags['msg-id'] || ''
            };
            usernameCache.add(displayName);
            knownColors.set(displayName.toLowerCase(), msg.color);
            buffer.push(msg);
            parsed++;
          }
        }

        log('Loaded history for', ch, '- parsed:', parsed, 'total in buffer:', buffer.getAll().length);

        // Re-render if viewing this channel or live tab
        if (currentTab === ch || (currentTab === 'live' && getCurrentChannel() === ch)) {
          renderMessages(currentTab);
        }
      } catch (e) {
        log('Failed to load history for', ch, e.message);
      } finally {
        clearTimeout(timer);
      }
    }

    part(ch) {
      ch = ch.toLowerCase();
      if (!this.channels.has(ch)) return;
      this.channels.delete(ch);
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(`PART #${ch}\r\n`);
      }
      log('Parted', ch);
    }

    getMessages(ch) {
      return this.channels.get(ch?.toLowerCase())?.getAll() || [];
    }

    on(e, fn) {
      if (!this.handlers.has(e)) this.handlers.set(e, new Set());
      this.handlers.get(e).add(fn);
    }

    emit(e, d) {
      this.handlers.get(e)?.forEach(fn => fn(d));
    }
  }

  // ============================================
  // KICK CHAT CLIENT (VIA HEATSYNC WEBHOOK)
  // ============================================
  class KickChat {
    constructor() {
      this.channels = new Map() // kickUsername → CircularBuffer
      this.handlers = new Map()
      this._destroyed = false
      this._listener = null
    }

    connect() {
      if (this._destroyed) return
      if (this._listener) return

      // Listen for kick chat messages relayed from background.js
      this._listener = (message) => {
        if (message.type === 'kick_chat_message' && message.data) {
          const d = message.data
          const channel = d.channel?.toLowerCase()
          if (!channel || !this.channels.has(channel)) return
          const msg = {
            user: d.username || 'unknown',
            text: d.content || '',
            color: d.color || '#53fc18',
            badges: '',
            channel,
            time: d.timestamp || Date.now(),
            platform: 'kick',
            replyTo: d.replyTo ? {
              user: d.replyTo.username,
              text: d.replyTo.content || ''
            } : null
          }
          this.channels.get(channel).push(msg)
          this.emit('message', msg)
        }
      }
      chrome.runtime.onMessage.addListener(this._listener)
      log('Kick chat listener registered (webhook mode)')
    }

    destroy() {
      this._destroyed = true
      if (this._listener) {
        chrome.runtime.onMessage.removeListener(this._listener)
        this._listener = null
      }
      // Leave all channels
      for (const username of this.channels.keys()) {
        safeSendMessage({ type: 'ws_send', data: { type: 'channel:leave', platform: 'kick', channel: username } })
      }
      this.channels.clear()
    }

    async join(kickUsername) {
      kickUsername = kickUsername.toLowerCase()
      if (this.channels.has(kickUsername)) return
      this.channels.set(kickUsername, new CircularBuffer(500))
      // Tell background to join kick channel via HeatSync WS
      safeSendMessage({ type: 'ws_send', data: { type: 'channel:join', platform: 'kick', channel: kickUsername } })
      log('Kick joined', kickUsername, '(webhook mode)')
    }

    part(kickUsername) {
      kickUsername = kickUsername.toLowerCase()
      if (!this.channels.has(kickUsername)) return
      safeSendMessage({ type: 'ws_send', data: { type: 'channel:leave', platform: 'kick', channel: kickUsername } })
      this.channels.delete(kickUsername)
      log('Kick parted', kickUsername)
    }

    getMessages(kickUsername) {
      return this.channels.get(kickUsername?.toLowerCase())?.getAll() || []
    }

    on(e, fn) {
      if (!this.handlers.has(e)) this.handlers.set(e, new Set())
      this.handlers.get(e).add(fn)
    }

    emit(e, d) {
      this.handlers.get(e)?.forEach(fn => fn(d))
    }
  }

  // ============================================
  // REACT UTILITIES (FFZ-STYLE)
  // ============================================

  function getFiber(el) {
    if (!el) return null
    const key = Object.keys(el).find(k =>
      k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
    )
    return key ? el[key] : null
  }

  function findComponent(startEl, predicate, maxDepth = 50) {
    let fiber = getFiber(startEl)
    let depth = 0
    while (fiber && depth < maxDepth) {
      try {
        const inst = fiber.stateNode
        if (inst && predicate(inst, fiber)) {
          return { instance: inst, fiber }
        }
      } catch (e) {}
      fiber = fiber.return
      depth++
    }
    return null
  }

  /**
   * Find the chat room container component
   */
  function findChatRoomComponent() {
    // Try multiple starting points (including popout chat selectors)
    const selectors = [
      '[class*="chat-room"]',
      '[class*="stream-chat"]',
      '[data-test-selector="chat-room-component"]',
      '[data-a-target="chat-room-component"]',
      '[class*="chat-shell"]',
      '.chat-room'
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (!el) continue;

      // Look for component with render method and chat-related props
      const result = findComponent(el, (inst, fiber) => {
        // Check if this is a class component with render
        if (typeof inst?.render !== 'function') return false;

        // Check fiber type name for chat-related components
        const typeName = fiber?.type?.displayName || fiber?.type?.name || '';
        if (typeName.toLowerCase().includes('chat')) return true;

        // Check for chat-related props
        if (inst.props) {
          const propStr = JSON.stringify(Object.keys(inst.props));
          if (propStr.includes('channel') || propStr.includes('room')) return true;
        }

        return false;
      }, 30);

      if (result) return result;
    }

    return null;
  }

  // ============================================
  // UI CREATION (React-compatible elements)
  // ============================================

  function createTabBar() {
    const container = document.createElement('div');
    container.id = 'hs-mc-tabbar';
    // Static hardcoded tab buttons — no user input, safe innerHTML
    // Kick: only live/feed/notifs (no IRC tabs)
    // Static hardcoded tab buttons — no user input, safe innerHTML
    container.innerHTML = isKick ? `
      <button class="hs-mc-tab active" data-tab="live">live</button>
      <button class="hs-mc-tab" data-tab="feed">feed</button>
      <button class="hs-mc-tab" data-tab="notifs">notifs</button>
      <button class="hs-mc-tab hs-mc-rotate" data-tab="rotate" title="rotate tabs (T)">T</button>
      <button class="hs-mc-tab hs-mc-font-btn" data-font-dir="-1" title="smaller text">A-</button>
      <button class="hs-mc-tab hs-mc-font-btn" data-font-dir="1" title="larger text">A+</button>
    ` : `
      <button class="hs-mc-tab active" data-tab="live">live</button>
      <button class="hs-mc-tab" data-tab="feed">feed</button>
      <button class="hs-mc-tab" data-tab="notifs">notifs</button>
      <button class="hs-mc-tab" data-tab="mentions">mentions</button>
      <button class="hs-mc-tab" data-tab="posts">posts</button>
      <button class="hs-mc-tab" data-tab="add">+</button>
      <button class="hs-mc-tab hs-mc-rotate" data-tab="rotate" title="rotate tabs (T)">T</button>
      <button class="hs-mc-tab hs-mc-font-btn" data-font-dir="-1" title="smaller text">A-</button>
      <button class="hs-mc-tab hs-mc-font-btn" data-font-dir="1" title="larger text">A+</button>
    `;

    // Event delegation for tab clicks
    container.addEventListener('click', (e) => {
      const tab = e.target.closest('.hs-mc-tab');
      if (!tab || tab.classList.contains('hs-mc-font-btn')) return;

      const tabId = tab.dataset.tab;
      log('Tab clicked:', tabId);
      if (tabId === 'add') {
        switchTab('add');
      } else if (tabId === 'rotate') {
        rotateTabPosition();
      } else {
        switchTab(tabId);
      }
    });

    // Font size controls
    container.addEventListener('click', (e) => {
      const fontBtn = e.target.closest('.hs-mc-font-btn');
      if (!fontBtn) return;
      const dir = parseInt(fontBtn.dataset.fontDir);
      const msgsEl = document.getElementById('hs-mc-messages');
      if (!msgsEl) return;
      const current = parseInt(getComputedStyle(msgsEl).fontSize) || 13;
      const next = Math.max(10, Math.min(22, current + dir));
      msgsEl.style.setProperty('--hs-chat-font', next + 'px');
      localStorage.setItem('heatsync-chat-font-size', next);
    });

    // Right-click channel tabs → context menu (edit youtube / remove)
    container.addEventListener('contextmenu', (e) => {
      const tab = e.target.closest('.hs-mc-tab');
      if (!tab) return;
      const tabId = tab.dataset.tab;
      const reserved = ['live', 'feed', 'notifs', 'mentions', 'posts', 'add', 'rotate'];
      if (reserved.includes(tabId)) return;
      e.preventDefault();

      // Remove any existing context menu
      document.getElementById('hs-mc-ctx-menu')?.remove();

      const ch = config.channels.find(c => (typeof c === 'string' ? c : c.id) === tabId);
      const menu = document.createElement('div');
      menu.id = 'hs-mc-ctx-menu';
      menu.style.cssText = 'position:fixed;z-index:99999;background:#000;border:1px solid #444;border-radius:0;padding:4px 0;min-width:150px;font-size:12px;font-family:inherit;';

      const mkItem = (label, color, fn) => {
        const item = document.createElement('div');
        item.textContent = label;
        item.style.cssText = `padding:6px 12px;cursor:pointer;color:${color};`;
        item.addEventListener('mouseenter', () => item.style.background = 'rgba(255,255,255,0.06)');
        item.addEventListener('mouseleave', () => item.style.background = '');
        item.addEventListener('click', () => { menu.remove(); fn(); });
        menu.appendChild(item);
      };

      // Show YouTube URL if configured
      const hasYt = ch && typeof ch !== 'string' && ch.youtube;
      if (hasYt) {
        const ytInfo = document.createElement('div');
        ytInfo.textContent = 'yt: ' + (youtubeLinks.get(tabId)?.channelName || ch.youtube.slice(0, 40));
        ytInfo.style.cssText = 'padding:4px 12px;color:#808080;font-size:10px;border-bottom:1px solid #808080;margin-bottom:2px;';
        menu.appendChild(ytInfo);
        mkItem('edit youtube url', '#fff', () => showEditYoutubePrompt(tabId));
      }
      mkItem('remove channel', '#ff4444', () => removeChannel(tabId));

      // Append then clamp to viewport so it doesn't overflow off-screen
      document.body.appendChild(menu);
      const mw = menu.offsetWidth, mh = menu.offsetHeight;
      menu.style.left = Math.min(e.clientX, window.innerWidth - mw - 4) + 'px';
      menu.style.top = Math.min(e.clientY, window.innerHeight - mh - 4) + 'px';

      const dismiss = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', dismiss); } };
      setTimeout(() => document.addEventListener('click', dismiss), 0);
    });

    return container;
  }

  // Autocomplete state (Tab-only cycling, no dropdown)
  let acState = {
    matches: [],
    index: 0,
    active: false,  // true when cycling through matches
    wordStart: 0,   // Position where the completion word starts
    afterText: ''   // Text after the completion
  };

  // Track scroll state for "new messages" button
  let isScrolledUp = false;
  let newMessageCount = 0;
  let isProgrammaticScroll = false; // Flag to ignore programmatic scrolls

  // WYSIWYG mode (inline emote images in input)
  let wysiwygEnabled = false;

  // Chat width state
  let chatWidth = 340; // Default width
  const DEFAULT_CHAT_WIDTH = 340;
  const MIN_CHAT_WIDTH = 300;
  const MAX_CHAT_WIDTH = 800;

  function createOverlay() {
    const overlay = document.createElement('div');
    overlay.id = 'hs-mc-overlay';
    // Static hardcoded layout — no user input, safe innerHTML
    overlay.innerHTML = `
      <div id="hs-mc-messages">
        <div class="hs-mc-empty">no messages yet</div>
      </div>
      <button id="hs-mc-new-msgs" style="display:none"></button>
    `;

    // Apply saved font size
    const savedFontSize = localStorage.getItem('heatsync-chat-font-size');
    if (savedFontSize) {
      const msgsDiv = overlay.querySelector('#hs-mc-messages');
      if (msgsDiv) msgsDiv.style.setProperty('--hs-chat-font', savedFontSize + 'px');
    }

    // Setup scroll detection after DOM insertion
    setTimeout(() => {
      const msgsEl = document.getElementById('hs-mc-messages');
      const newBtn = document.getElementById('hs-mc-new-msgs');
      if (!msgsEl || !newBtn) return;

      // scroll event only used for scrollbar drag detection (not wheel — wheel has its own handler)
      msgsEl.addEventListener('scrollend', () => {
        if (isProgrammaticScroll) return;
        const atBottom = msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < 50;
        if (atBottom) {
          isScrolledUp = false;
          newMessageCount = 0;
          newBtn.style.display = 'none';
        }
      });

      // Use wheel event to detect intentional user scrolling
      msgsEl.addEventListener('wheel', (e) => {
        if (e.deltaY < 0) {
          // Scrolling up with wheel = user intent
          isScrolledUp = true;
        } else if (e.deltaY > 0) {
          // Scrolling down - check if we're now at bottom to re-lock
          setTimeout(() => {
            const atBottom = msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < 50;
            if (atBottom) {
              isScrolledUp = false;
              newMessageCount = 0;
              newBtn.style.display = 'none';
            }
          }, 50); // Small delay to let scroll finish
        }
      });

      newBtn.addEventListener('click', () => {
        // Reset scroll state FIRST, then re-render to catch up on skipped messages
        isScrolledUp = false;
        newMessageCount = 0;
        newBtn.style.display = 'none';
        // Re-render will scroll to bottom automatically since isScrolledUp is now false
        renderMessages(currentTab);
      });
    }, 100);

    return overlay;
  }

  /**
   * Setup resize handle for dragging chat width
   */
  function setupResizeHandle() {
    // Create handle on the left edge of the right column
    const rightCol = document.querySelector('.right-column.right-column--beside')
    if (!rightCol || document.getElementById('hs-mc-resize-handle')) return

    const handle = document.createElement('div')
    handle.id = 'hs-mc-resize-handle'
    rightCol.insertBefore(handle, rightCol.firstChild)

    let isResizing = false
    let startX = 0
    let startWidth = 0

    handle.addEventListener('mousedown', (e) => {
      isResizing = true
      startX = e.clientX
      startWidth = chatWidth
      document.body.style.cursor = 'ew-resize'
      document.body.style.userSelect = 'none'
      e.preventDefault()
    })

    cleanup.addEventListener(document, 'mousemove', (e) => {
      if (!isResizing) return
      // Dragging left = bigger chat, dragging right = smaller chat
      const delta = startX - e.clientX
      const newWidth = Math.min(MAX_CHAT_WIDTH, Math.max(MIN_CHAT_WIDTH, startWidth + delta))
      chatWidth = newWidth
      applyChatWidth()
      updateWidthInput()
    })

    cleanup.addEventListener(document, 'mouseup', () => {
      if (isResizing) {
        isResizing = false
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        saveChatWidth()
      }
    })

    // Load saved width
    loadChatWidth()
  }

  function updateWidthInput() {
    const input = document.getElementById('hs-mc-width-input')
    if (input && document.activeElement !== input) input.value = chatWidth
  }

  function applyChatWidth() {
    const rightCol = document.querySelector('.right-column')
    if (!rightCol) return
    const collapsed = rightCol.classList.contains('right-column--collapsed')

    if (collapsed) {
      rightCol.style.removeProperty('width')
      rightCol.style.removeProperty('min-width')
      rightCol.style.removeProperty('flex-shrink')
      // Force parent wrapper (Twitch sets inline width: fit-content) to 0
      // overflow must be visible so the collapse/expand arrow can render
      const parent = rightCol.parentElement
      if (parent && parent !== document.body) {
        parent.style.setProperty('width', '0px', 'important')
        parent.style.setProperty('min-width', '0px', 'important')
        parent.style.setProperty('overflow', 'visible', 'important')
      }
      return
    }

    // Restore parent when expanded
    const parent = rightCol.parentElement
    if (parent && parent !== document.body) {
      parent.style.removeProperty('width')
      parent.style.removeProperty('min-width')
      parent.style.removeProperty('overflow')
    }

    const isVertical = tabPosition === 'left' || tabPosition === 'right'
    const colWidth = chatWidth + (isVertical ? 90 : 0)

    // Parent is display:block, so flex-basis alone won't work — need inline width.
    // Don't override display — Twitch's native display:block works correctly.
    // Setting display:flex breaks internal child layout (flex-direction:row default).
    // Player sizing fix is handled by CSS rule in injected-message.css.
    rightCol.style.setProperty('width', colWidth + 'px', 'important')
    rightCol.style.setProperty('min-width', colWidth + 'px', 'important')
    rightCol.style.setProperty('flex-shrink', '0', 'important')

    // Vertical tabs: widen the inner column chain so .stream-chat fills the
    // wider .right-column. The bottleneck is .channel-root__right-column
    // (position:absolute, Twitch sizes it to default chat width).
    const innerCol = rightCol.querySelector('.channel-root__right-column')
    if (innerCol) {
      if (isVertical) {
        innerCol.style.setProperty('width', '100%', 'important')
      } else {
        innerCol.style.removeProperty('width')
      }
    }
  }

  function saveChatWidth() {
    chrome.storage.local.set({ hs_chat_width: chatWidth });
    log('Saved chat width:', chatWidth);
  }

  async function loadChatWidth() {
    try {
      const data = await chrome.storage.local.get(['hs_chat_width']);
      if (data.hs_chat_width) {
        chatWidth = data.hs_chat_width;
        applyChatWidth();
        updateWidthInput();
        log('Loaded chat width:', chatWidth);
      }
    } catch (e) {
      log('Error loading chat width:', e);
    }
  }

  // Emote size functions
  function setEmoteSize(size) {
    if ([1, 2, 4].includes(size)) {
      emoteSize = size;
      saveEmoteSize();
      applyEmoteSize();
    }
  }

  function saveEmoteSize() {
    chrome.storage.local.set({ hs_emote_size: emoteSize });
  }

  async function loadEmoteSize() {
    try {
      const data = await chrome.storage.local.get(['hs_emote_size']);
      if (data.hs_emote_size) {
        emoteSize = data.hs_emote_size;
        applyEmoteSize();
      }
    } catch (e) {
      log('Error loading emote size:', e);
    }
  }

  function applyEmoteSize() {
    const targets = [document.documentElement, document.getElementById('hs-mc-messages')].filter(Boolean);
    const baseEmote = 32;
    const vars = {
      '--hs-emote-size': (baseEmote * emoteSize) + 'px',
      '--hs-chat-font': (13 * emoteSize) + 'px',
      '--hs-time-font': (10 * emoteSize) + 'px',
      '--hs-badge-size': (18 * emoteSize) + 'px',
      '--hs-badge-font': (10 * emoteSize) + 'px',
      '--hs-stat-badge-font': (9 * emoteSize) + 'px',
      '--hs-stat-badge-line': (16 * emoteSize) + 'px',
      '--hs-badge-img': (18 * emoteSize) + 'px',
    };
    for (const el of targets) {
      for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v);
    }
    renderMessages(currentTab);
  }

  // Upgrade emote URL to match current emote size setting
  function getChatResUrl(url) {
    if (!url || emoteSize === 1) return url;
    if (emoteSize === 2) {
      if (url.includes('cdn.7tv.app')) return url.replace('/1x', '/2x');
      if (url.includes('cdn.betterttv.net')) return url.replace('/1x', '/2x');
      if (url.includes('cdn.frankerfacez.com')) return url.replace(/\/1(?=\.|$)/, '/2');
      if (url.includes('static-cdn.jtvnw.net')) return url.replace('/1.0', '/2.0');
    } else if (emoteSize === 4) {
      if (url.includes('cdn.7tv.app')) return url.replace('/1x', '/4x').replace('/2x', '/4x');
      if (url.includes('cdn.betterttv.net')) return url.replace('/1x', '/3x').replace('/2x', '/3x');
      if (url.includes('cdn.frankerfacez.com')) return url.replace(/\/[12](?=\.|$)/, '/4');
      if (url.includes('static-cdn.jtvnw.net')) return url.replace(/\/[12]\.0/, '/3.0');
    }
    return url;
  }

  // WYSIWYG setting
  async function loadWysiwygSetting() {
    try {
      const stored = await chrome.storage.local.get(['ui_settings']);
      if (stored.ui_settings?.wysiwygEnabled !== undefined) {
        wysiwygEnabled = stored.ui_settings.wysiwygEnabled;
      }
    } catch (e) {
      log('Error loading WYSIWYG setting:', e);
    }
  }

  async function saveWysiwygSetting() {
    try {
      const stored = await chrome.storage.local.get(['ui_settings']);
      const settings = stored.ui_settings || {};
      settings.wysiwygEnabled = wysiwygEnabled;
      await chrome.storage.local.set({ ui_settings: settings });
    } catch (e) {
      log('Error saving WYSIWYG setting:', e);
    }
  }

  function toggleWysiwyg() {
    wysiwygEnabled = !wysiwygEnabled;
    saveWysiwygSetting();
    rebuildInput();
    log('WYSIWYG:', wysiwygEnabled ? 'enabled' : 'disabled');
  }

  function rebuildInput() {
    const bar = document.getElementById('hs-mc-inputbar');
    if (!bar) return;

    // Save current text
    const oldInput = document.getElementById('hs-mc-input');
    const savedText = oldInput ? getInputText() : pendingMessage;

    // Remove old input
    if (oldInput) oldInput.remove();

    // Create new input element
    const emoteBtn = bar.querySelector('#hs-mc-emote-btn');
    if (wysiwygEnabled) {
      const div = document.createElement('div');
      div.id = 'hs-mc-input';
      div.contentEditable = 'true';
      div.setAttribute('data-placeholder', 'send a message...');
      div.spellcheck = false;
      if (emoteBtn) bar.insertBefore(div, emoteBtn);
    } else {
      const input = document.createElement('input');
      input.type = 'text';
      input.id = 'hs-mc-input';
      input.placeholder = 'send a message...';
      input.autocomplete = 'off';
      input.spellcheck = false;
      if (emoteBtn) bar.insertBefore(input, emoteBtn);
    }

    // Restore text and reinit
    const newInput = document.getElementById('hs-mc-input');
    if (newInput && savedText) {
      if (wysiwygEnabled) {
        newInput.textContent = savedText;
      } else {
        newInput.value = savedText;
      }
    }
    initInput();
    updateCharCount();
  }

  /**
   * Create unified input bar - ALWAYS visible, text persists across tabs
   */
  function createInputBar() {
    const bar = document.createElement('div');
    bar.id = 'hs-mc-inputbar';
    const iconUrl = chrome.runtime.getURL('icon-16.png');

    const inputHtml = wysiwygEnabled
      ? `<div id="hs-mc-input" contenteditable="true" data-placeholder="send a message..." spellcheck="false"></div>`
      : `<input type="text" id="hs-mc-input" placeholder="send a message..." autocomplete="off" spellcheck="false">`;

    bar.innerHTML = `
      ${inputHtml}
      <button id="hs-mc-emote-btn" title="heatsync emotes & settings"><img src="${iconUrl}" alt="hs" style="width:24px;height:24px;vertical-align:middle;"></button>
    `;

    // Initialize input after DOM insertion
    setTimeout(() => initInput(), 0);
    return bar;
  }

  /**
   * Group emotes by state+source into ordered sections
   */
  const SECTION_ORDER = [
    'channel-7tv', 'channel-bttv', 'channel-ffz', 'channel-twitch',
    '7tv', 'bttv', 'ffz', 'twitch', 'heatsync'
  ]
  const SECTION_LABELS = {
    'channel-7tv': 'channel 7tv', 'channel-bttv': 'channel bttv',
    'channel-ffz': 'channel ffz', 'channel-twitch': 'channel twitch',
    '7tv': '7tv global', 'bttv': 'bttv global', 'ffz': 'ffz global',
    'twitch': 'twitch global', 'heatsync': 'heatsync'
  }

  function groupEmotes(allEmotes) {
    const groups = {}
    for (const [name, emote] of allEmotes) {
      const key = emote.state === 'channel' ? `channel-${emote.source}` : emote.source
      if (!groups[key]) groups[key] = []
      groups[key].push([name, emote])
    }
    return SECTION_ORDER
      .filter(k => groups[k]?.length)
      .map(k => ({ key: k, label: SECTION_LABELS[k] || k, emotes: groups[k] }))
  }

  function renderEmoteSections(sections, emptyMsg = 'no emotes loaded') {
    if (!sections.length) return `<div class="hs-mc-picker-empty">${escapeHtml(emptyMsg)}</div>`
    // Only render section headers + first CHUNK_SIZE emotes per section for instant open
    // Rest gets appended via chunkedRenderRemaining()
    return sections.map(s => {
      const initial = s.emotes.slice(0, EMOTE_CHUNK_SIZE)
      return `
      <div class="hs-mc-picker-section" data-section-key="${escapeHtml(s.key)}">
        <div class="hs-mc-picker-section-header">${escapeHtml(s.label)} <span class="hs-mc-picker-section-count">${s.emotes.length}</span></div>
        <div class="hs-mc-picker-section-grid">${initial.map(emoteImgHtml).join('')}</div>
      </div>`
    }).join('')
  }

  const EMOTE_CHUNK_SIZE = 80
  let _chunkedRafId = null

  function emoteImgHtml([name, emote]) {
    return `<img src="${escapeHtml(emote.url)}" alt="${escapeHtml(name)}" title="${escapeHtml(name)} (${escapeHtml(emote.source)})" class="hs-mc-picker-emote hs-emote-${escapeHtml(emote.source)}" data-name="${escapeHtml(name)}" data-source="${escapeHtml(emote.source)}" loading="lazy">`
  }

  /** Append remaining emotes in rAF chunks so the picker opens instantly */
  function chunkedRenderRemaining(sections, container) {
    if (_chunkedRafId) cancelAnimationFrame(_chunkedRafId)
    // Build queue of {gridEl, emotes} for sections with remaining emotes
    const queue = []
    for (const s of sections) {
      if (s.emotes.length <= EMOTE_CHUNK_SIZE) continue
      const gridEl = container.querySelector(`[data-section-key="${CSS.escape(s.key)}"] .hs-mc-picker-section-grid`)
      if (!gridEl) continue
      queue.push({ gridEl, emotes: s.emotes.slice(EMOTE_CHUNK_SIZE), offset: 0 })
    }
    function renderNext() {
      const item = queue[0]
      if (!item) return
      const chunk = item.emotes.slice(item.offset, item.offset + EMOTE_CHUNK_SIZE)
      if (!chunk.length) { queue.shift(); renderNext(); return }
      // Use DocumentFragment for minimal reflows
      const frag = document.createDocumentFragment()
      for (const entry of chunk) {
        const tmp = document.createElement('template')
        tmp.innerHTML = emoteImgHtml(entry)
        frag.appendChild(tmp.content)
      }
      item.gridEl.appendChild(frag)
      item.offset += EMOTE_CHUNK_SIZE
      if (item.offset >= item.emotes.length) queue.shift()
      if (queue.length) _chunkedRafId = requestAnimationFrame(renderNext)
    }
    _chunkedRafId = requestAnimationFrame(renderNext)
  }

  /**
   * Create emote picker popup
   */
  let pickerTab = 'emotes'; // 'emotes', 'twitch', or 'settings'
  let _pickerCloseHandler = null; // Tracked to prevent duplicate close handlers

  function showEmotePicker(tab = null) {
    const picker = document.getElementById('hs-mc-emote-picker');
    if (!picker) return;

    // If tab specified, switch to it; otherwise toggle
    if (tab) {
      pickerTab = tab;
    } else if (picker.classList.contains('visible')) {
      picker.classList.remove('visible');
      adjustOverlayForPicker(false);
      if (_chunkedRafId) { cancelAnimationFrame(_chunkedRafId); _chunkedRafId = null; }
      return;
    }

    // Build tabbed UI — merge channel emotes first (so they keep 'channel' state), then globals
    // Note: all emote names/urls are pre-sanitized via escapeHtml in render helpers
    const allEmotes = new Map();
    const chCache = channelEmoteCaches[currentTab] || channelEmoteCaches[getCurrentChannel()];
    if (chCache) for (const [k, v] of chCache) allEmotes.set(k, v);
    for (const [k, v] of emoteCache) if (!allEmotes.has(k)) allEmotes.set(k, v);
    const sections = groupEmotes(allEmotes);
    picker.innerHTML = `
      <div class="hs-mc-tab-content" id="hs-mc-tab-emotes" style="display: ${pickerTab === 'emotes' ? 'flex' : 'none'}; flex-direction: column;">
        <div class="hs-mc-picker-header">
          <div class="hs-mc-search-wrap">
            <svg class="hs-mc-search-icon" width="14" height="14" viewBox="0 0 20 20"><path fill="#000" d="M13.74 12.33l4.04 4.04a1 1 0 01-1.42 1.42l-4.04-4.04a7 7 0 111.42-1.42zM9 14A5 5 0 109 4a5 5 0 000 10z"/></svg>
            <input type="text" id="hs-mc-emote-search" placeholder="search emotes..." autocomplete="off">
          </div>
        </div>
        <div class="hs-mc-picker-scroll" id="hs-mc-emote-grid">
          ${renderEmoteSections(sections)}
        </div>
      </div>
      <div class="hs-mc-tab-content" id="hs-mc-tab-twitch" style="display: ${pickerTab === 'twitch' ? 'flex' : 'none'}; flex-direction: column; padding: 8px 0;">
        <div class="hs-mc-pred-loading">loading...</div>
      </div>
      <div class="hs-mc-tab-content" id="hs-mc-tab-settings" style="display: ${pickerTab === 'settings' ? 'flex' : 'none'}; flex-direction: column; padding: 0; gap: 0;">
        <div class="hs-mc-settings-group">
          <div class="hs-mc-settings-group-title">display</div>
          <div class="hs-mc-setting-row">
            <span class="hs-mc-setting-label">emote size</span>
            <div class="hs-mc-size-btns">
              <button class="hs-mc-size-btn ${emoteSize === 1 ? 'active' : ''}" data-size="1">1x</button>
              <button class="hs-mc-size-btn ${emoteSize === 2 ? 'active' : ''}" data-size="2">2x</button>
              <button class="hs-mc-size-btn ${emoteSize === 4 ? 'active' : ''}" data-size="4">4x</button>
            </div>
          </div>
          <div class="hs-mc-setting-row">
            <span class="hs-mc-setting-label">input preview</span>
            <button class="hs-mc-toggle-pill ${wysiwygEnabled ? 'active' : ''}" id="hs-mc-wysiwyg-toggle"><span class="hs-mc-toggle-knob"></span></button>
          </div>
        </div>
        <div class="hs-mc-settings-group">
          <div class="hs-mc-settings-group-title">layout</div>
          <div class="hs-mc-setting-row">
            <span class="hs-mc-setting-label">chat width</span>
            <div class="hs-mc-width-row">
              <input type="number" id="hs-mc-width-input" class="hs-mc-width-input" value="${chatWidth}" min="${MIN_CHAT_WIDTH}" max="${MAX_CHAT_WIDTH}" step="10">
              <span class="hs-mc-settings-unit">px</span>
            </div>
          </div>
        </div>
      </div>
      <div class="hs-mc-picker-tabs">
        <button class="hs-mc-picker-tab ${pickerTab === 'emotes' ? 'active' : ''}" data-tab="emotes"><svg width="14" height="14" viewBox="0 0 20 20"><path fill="currentColor" d="M7 11a1 1 0 100-2 1 1 0 000 2zm6-1a1 1 0 11-2 0 1 1 0 012 0zm-3 5.5a4 4 0 01-4-4h2a2 2 0 004 0h2a4 4 0 01-4 4zM10 2a8 8 0 110 16 8 8 0 010-16z"></path></svg> emotes</button>
        <button class="hs-mc-picker-tab ${pickerTab === 'twitch' ? 'active' : ''}" data-tab="twitch"><svg width="14" height="14" viewBox="0 0 20 20"><path fill="currentColor" d="M4.3 1L2 4.5V17h4.5v2.5H9L11.5 17H15l4-4V1H4.3zM17 12l-3 3h-4l-2.5 2.5V15H4V3h13v9z"/><path fill="currentColor" d="M12 6.5h2v5h-2zm-4 0h2v5H8z"/></svg> twitch</button>
        <button class="hs-mc-picker-tab ${pickerTab === 'settings' ? 'active' : ''}" data-tab="settings"><svg width="14" height="14" viewBox="0 0 20 20"><path fill="currentColor" d="M10 8a2 2 0 100 4 2 2 0 000-4zm7.9 1.44l-1.27-.25a6.9 6.9 0 00-.59-1.42l.74-1.06a.5.5 0 00-.07-.6l-1.12-1.12a.5.5 0 00-.6-.07l-1.06.74a6.9 6.9 0 00-1.42-.59l-.25-1.27a.5.5 0 00-.49-.4h-1.54a.5.5 0 00-.49.4l-.25 1.27a6.9 6.9 0 00-1.42.59l-1.06-.74a.5.5 0 00-.6.07L5.29 6.11a.5.5 0 00-.07.6l.74 1.06a6.9 6.9 0 00-.59 1.42l-1.27.25a.5.5 0 00-.4.49v1.54a.5.5 0 00.4.49l1.27.25c.14.5.34.97.59 1.42l-.74 1.06a.5.5 0 00.07.6l1.12 1.12a.5.5 0 00.6.07l1.06-.74c.45.25.92.45 1.42.59l.25 1.27a.5.5 0 00.49.4h1.54a.5.5 0 00.49-.4l.25-1.27a6.9 6.9 0 001.42-.59l1.06.74a.5.5 0 00.6-.07l1.12-1.12a.5.5 0 00.07-.6l-.74-1.06c.25-.45.45-.92.59-1.42l1.27-.25a.5.5 0 00.4-.49v-1.54a.5.5 0 00-.4-.49z"/></svg> settings</button>
      </div>
    `;

    // Chunked render remaining emotes after initial paint
    const grid = document.getElementById('hs-mc-emote-grid');
    if (grid) chunkedRenderRemaining(sections, grid);

    // Search functionality (debounced)
    let _searchTimer = null;
    const searchInput = document.getElementById('hs-mc-emote-search');
    searchInput?.addEventListener('input', (e) => {
      clearTimeout(_searchTimer);
      _searchTimer = setTimeout(() => {
        const query = e.target.value.toLowerCase();
        const grid = document.getElementById('hs-mc-emote-grid');
        if (!grid) return;

        const searchEmotes = new Map();
        const searchChCache = channelEmoteCaches[currentTab] || channelEmoteCaches[getCurrentChannel()];
        if (searchChCache) for (const [k, v] of searchChCache) searchEmotes.set(k, v);
        for (const [k, v] of emoteCache) if (!searchEmotes.has(k)) searchEmotes.set(k, v);
        const filtered = new Map();
        for (const [name, emote] of searchEmotes) {
          if (name.toLowerCase().includes(query)) filtered.set(name, emote);
        }
        const filteredSections = groupEmotes(filtered);
        grid.innerHTML = renderEmoteSections(filteredSections, 'no matches');
        chunkedRenderRemaining(filteredSections, grid);
      }, 150);
    });

    // Emote size controls
    picker.querySelectorAll('.hs-mc-size-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const size = parseInt(btn.dataset.size, 10);
        setEmoteSize(size);
        // Update active state
        picker.querySelectorAll('.hs-mc-size-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    // WYSIWYG toggle
    const wysiwygToggle = document.getElementById('hs-mc-wysiwyg-toggle');
    wysiwygToggle?.addEventListener('click', () => {
      toggleWysiwyg();
      wysiwygToggle.classList.toggle('active', wysiwygEnabled);
    });

    // Chat width input
    const widthInput = document.getElementById('hs-mc-width-input')
    widthInput?.addEventListener('change', () => {
      const val = Math.min(MAX_CHAT_WIDTH, Math.max(MIN_CHAT_WIDTH, parseInt(widthInput.value) || DEFAULT_CHAT_WIDTH))
      widthInput.value = val
      chatWidth = val
      applyChatWidth()
      saveChatWidth()
    })

    // Tab switching
    picker.querySelectorAll('.hs-mc-picker-tab').forEach(tabBtn => {
      tabBtn.addEventListener('click', () => {
        const newTab = tabBtn.dataset.tab;
        const oldTab = pickerTab;
        pickerTab = newTab;
        picker.querySelectorAll('.hs-mc-picker-tab').forEach(t => t.classList.remove('active'));
        tabBtn.classList.add('active');
        picker.querySelectorAll('.hs-mc-tab-content').forEach(c => c.style.display = 'none');
        const display = (newTab === 'emotes' || newTab === 'settings' || newTab === 'twitch') ? 'flex' : 'block';
        document.getElementById(`hs-mc-tab-${newTab}`).style.display = display;
        if (newTab === 'twitch') renderTwitchTab();
        if (oldTab === 'twitch' && newTab !== 'twitch') stopPredictionPoll();
      });
    });

    // Event delegation for emote clicks (single handler, works for chunked rendering)
    if (!picker._hsDelegated) {
      picker._hsDelegated = true;
      picker.addEventListener('click', (e) => {
        const img = e.target.closest('.hs-mc-picker-emote');
        if (!img) return;
        const name = img.dataset.name;
        const input = document.getElementById('hs-mc-input');
        if (!input || !name) return;
        if (wysiwygEnabled || !('value' in input)) {
          const sel = window.getSelection();
          const text = input.textContent || '';
          let insertPos = text.length;
          if (sel.rangeCount && input.contains(sel.anchorNode)) {
            const range = sel.getRangeAt(0);
            const preRange = document.createRange();
            preRange.selectNodeContents(input);
            preRange.setEnd(range.startContainer, range.startOffset);
            insertPos = preRange.toString().length;
          }
          const before = text.slice(0, insertPos);
          const after = text.slice(insertPos);
          const space = before.length > 0 && !before.endsWith(' ') ? ' ' : '';
          const inserted = space + name + ' ';
          input.textContent = before + inserted + after;
          pendingMessage = input.textContent;
          const newPos = insertPos + inserted.length;
          const newRange = document.createRange();
          const textNode = input.firstChild;
          if (textNode) {
            newRange.setStart(textNode, Math.min(newPos, textNode.length));
            newRange.collapse(true);
            sel.removeAllRanges();
            sel.addRange(newRange);
          }
        } else {
          const pos = input.selectionStart || input.value.length;
          const before = input.value.slice(0, pos);
          const after = input.value.slice(pos);
          const space = before.length > 0 && !before.endsWith(' ') ? ' ' : '';
          input.value = before + space + name + ' ' + after;
          pendingMessage = input.value;
        }
        input.focus();
        picker.classList.remove('visible');
        adjustOverlayForPicker(false);
      });
    }

    picker.classList.add('visible');
    adjustOverlayForPicker(true);

    if (pickerTab === 'twitch') renderTwitchTab();

    // Close when clicking outside (remove any previous handler first)
    if (_pickerCloseHandler) document.removeEventListener('click', _pickerCloseHandler);
    setTimeout(() => {
      _pickerCloseHandler = (e) => {
        if (mcSignal?.aborted) { document.removeEventListener('click', _pickerCloseHandler); _pickerCloseHandler = null; return; }
        if (!picker.contains(e.target) && !e.target.closest('#hs-mc-emote-btn')) {
          picker.classList.remove('visible');
          adjustOverlayForPicker(false);
          stopPredictionPoll();
          document.removeEventListener('click', _pickerCloseHandler);
          _pickerCloseHandler = null;
        }
      };
      document.addEventListener('click', _pickerCloseHandler);
    }, 0);
  }

  /** Adjust overlay bottom to make room for picker panel */
  function adjustOverlayForPicker(open) {
    const overlay = document.getElementById('hs-mc-overlay');
    if (!overlay) return;
    const container = document.getElementById('hs-mc-container');
    const hasBottomTabs = container?.classList.contains('hs-tabs-bottom');
    const baseBottom = hasBottomTabs ? 90 : 52;
    const pickerHeight = 400;
    overlay.style.bottom = open ? (baseBottom + pickerHeight) + 'px' : baseBottom + 'px';
  }


  // ═══ Predictions & Betting ═══

  function formatPoints(n) {
    if (n == null) return '?'
    if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M'
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K'
    return String(n)
  }

  function renderQuickLinks() {
    const links = document.createElement('div')
    links.className = 'hs-mc-pred-links'

    const items = [
      { action: 'popout', accent: '#4a90d9', icon: '<svg width="16" height="16" viewBox="0 0 20 20"><path fill="currentColor" d="M4 4h6v2H6v8h8v-4h2v6H4V4zm8 0h4v4h-2V6.41l-4.3 4.3-1.4-1.42L12.58 6H11V4z"></path></svg>', label: 'popout chat' },
      { action: 'mod', accent: '#00c8af', icon: '<svg width="16" height="16" viewBox="0 0 20 20"><path fill="currentColor" d="M10 2l6 2.7V9c0 4.4-2.5 8.3-6 10-3.5-1.7-6-5.6-6-10V4.7L10 2z"/></svg>', label: 'mod view' }
    ]

    for (const item of items) {
      const el = document.createElement('div')
      el.className = 'hs-mc-menu-item hs-mc-pred-link'
      el.dataset.action = item.action
      el.style.setProperty('--menu-accent', item.accent)
      el.innerHTML = `<div class="hs-mc-menu-icon">${item.icon}</div><div class="hs-mc-menu-text"><div class="hs-mc-menu-title">${item.label}</div></div><svg class="hs-mc-menu-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`
      links.appendChild(el)
    }
    return links
  }

  function renderPrediction(pred, balance) {
    const frag = document.createDocumentFragment()
    const isLocked = pred.status === 'LOCKED'
    const totalPoints = pred.outcomes.reduce((s, o) => s + (o.totalPoints || 0), 0)
    const createdAt = new Date(pred.createdAt).getTime()
    const windowMs = (pred.predictionWindowSeconds || 120) * 1000
    const endsAt = createdAt + windowMs

    const wrapper = document.createElement('div')
    wrapper.className = 'hs-mc-prediction'
    wrapper.dataset.eventId = pred.id

    // Header
    const header = document.createElement('div')
    header.className = 'hs-mc-pred-header'
    const title = document.createElement('div')
    title.className = 'hs-mc-pred-title'
    title.textContent = pred.title
    header.appendChild(title)

    if (isLocked) {
      const badge = document.createElement('span')
      badge.className = 'hs-mc-pred-locked'
      badge.textContent = 'locked'
      header.appendChild(badge)
    } else {
      const timer = document.createElement('span')
      timer.className = 'hs-mc-pred-timer'
      timer.dataset.ends = endsAt
      header.appendChild(timer)
    }
    wrapper.appendChild(header)

    // Balance
    if (balance != null) {
      const bal = document.createElement('div')
      bal.className = 'hs-mc-pred-balance'
      bal.innerHTML = `<svg width="14" height="14" viewBox="0 0 20 20" style="vertical-align: -2px"><path fill="#ffbf00" d="M10 6a4 4 0 100 8 4 4 0 000-8zm0-4a8 8 0 110 16 8 8 0 010-16z"/></svg> `
      bal.appendChild(document.createTextNode(formatPoints(balance)))
      wrapper.appendChild(bal)
    }

    // Outcomes
    const outcomesWrap = document.createElement('div')
    outcomesWrap.className = 'hs-mc-pred-outcomes'

    for (const outcome of pred.outcomes) {
      const pct = totalPoints > 0 ? Math.round((outcome.totalPoints / totalPoints) * 100) : 0
      const color = outcome.color === 'PINK' ? '#f5009b' : '#387aff'
      const userCount = outcome.totalUsers || 0
      const points = outcome.totalPoints || 0

      const card = document.createElement('div')
      card.className = 'hs-mc-pred-outcome'
      card.style.setProperty('--oc', color)

      const head = document.createElement('div')
      head.className = 'hs-mc-pred-outcome-head'
      const titleSpan = document.createElement('span')
      titleSpan.className = 'hs-mc-pred-outcome-title'
      titleSpan.textContent = outcome.title
      const pctSpan = document.createElement('span')
      pctSpan.className = 'hs-mc-pred-outcome-pct'
      pctSpan.textContent = `${pct}%`
      head.appendChild(titleSpan)
      head.appendChild(pctSpan)
      card.appendChild(head)

      const track = document.createElement('div')
      track.className = 'hs-mc-pred-bar-track'
      const fill = document.createElement('div')
      fill.className = 'hs-mc-pred-bar-fill'
      fill.style.width = `${pct}%`
      track.appendChild(fill)
      card.appendChild(track)

      const stats = document.createElement('div')
      stats.className = 'hs-mc-pred-outcome-stats'
      stats.textContent = `${formatPoints(points)} pts · ${userCount} voter${userCount !== 1 ? 's' : ''}`
      card.appendChild(stats)

      if (!isLocked) {
        const betRow = document.createElement('div')
        betRow.className = 'hs-mc-pred-bet-row'
        for (const amt of [100, 1000, 5000]) {
          const btn = document.createElement('button')
          btn.className = 'hs-mc-pred-bet-btn'
          btn.dataset.outcome = outcome.id
          btn.dataset.points = amt
          btn.style.setProperty('--oc', color)
          btn.textContent = formatPoints(amt)
          betRow.appendChild(btn)
        }
        const customInput = document.createElement('input')
        customInput.className = 'hs-mc-pred-bet-custom'
        customInput.type = 'number'
        customInput.min = '1'
        customInput.placeholder = 'amt'
        customInput.dataset.outcome = outcome.id
        betRow.appendChild(customInput)

        const goBtn = document.createElement('button')
        goBtn.className = 'hs-mc-pred-bet-go'
        goBtn.dataset.outcome = outcome.id
        goBtn.style.setProperty('--oc', color)
        goBtn.textContent = 'bet'
        betRow.appendChild(goBtn)

        card.appendChild(betRow)
      }

      outcomesWrap.appendChild(card)
    }

    wrapper.appendChild(outcomesWrap)
    frag.appendChild(wrapper)
    return frag
  }

  function renderNoPrediction(balance) {
    const wrap = document.createElement('div')
    wrap.className = 'hs-mc-pred-empty'
    const text = document.createElement('div')
    text.className = 'hs-mc-pred-empty-text'
    text.textContent = 'no active prediction'
    wrap.appendChild(text)
    if (balance != null) {
      const bal = document.createElement('div')
      bal.className = 'hs-mc-pred-balance'
      bal.style.marginTop = '8px'
      bal.innerHTML = `<svg width="14" height="14" viewBox="0 0 20 20" style="vertical-align: -2px"><path fill="#ffbf00" d="M10 6a4 4 0 100 8 4 4 0 000-8zm0-4a8 8 0 110 16 8 8 0 010-16z"/></svg> `
      bal.appendChild(document.createTextNode(formatPoints(balance)))
      wrap.appendChild(bal)
    }
    return wrap
  }

  function attachPredictionHandlers() {
    const container = document.getElementById('hs-mc-tab-twitch')
    if (!container) return

    // Quick link handlers
    container.querySelectorAll('.hs-mc-pred-link').forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation()
        triggerTwitchFeature(item.dataset.action)
      })
    })

    // Bet button handlers
    container.querySelectorAll('.hs-mc-pred-bet-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation()
        const eventId = container.querySelector('.hs-mc-prediction')?.dataset.eventId
        if (!eventId) return
        btn.disabled = true
        btn.textContent = '...'
        const result = await placePredictionBet(eventId, btn.dataset.outcome, parseInt(btn.dataset.points))
        if (result.error) {
          btn.textContent = '!'
          btn.title = result.error
          setTimeout(() => { btn.textContent = formatPoints(parseInt(btn.dataset.points)); btn.disabled = false; btn.title = '' }, 2000)
        } else {
          btn.textContent = '\u2713'
          setTimeout(() => renderTwitchTab(), 500)
        }
      })
    })

    // Custom bet "go" buttons
    container.querySelectorAll('.hs-mc-pred-bet-go').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation()
        const eventId = container.querySelector('.hs-mc-prediction')?.dataset.eventId
        if (!eventId) return
        const input = container.querySelector(`.hs-mc-pred-bet-custom[data-outcome="${btn.dataset.outcome}"]`)
        const points = parseInt(input?.value)
        if (!points || points < 1) return
        btn.disabled = true
        btn.textContent = '...'
        const result = await placePredictionBet(eventId, btn.dataset.outcome, points)
        if (result.error) {
          btn.textContent = '!'
          btn.title = result.error
          setTimeout(() => { btn.textContent = 'bet'; btn.disabled = false; btn.title = '' }, 2000)
        } else {
          btn.textContent = '\u2713'
          input.value = ''
          setTimeout(() => renderTwitchTab(), 500)
        }
      })
    })

    // Start countdown timers
    container.querySelectorAll('.hs-mc-pred-timer').forEach(el => {
      const endsAt = parseInt(el.dataset.ends)
      const update = () => {
        const remaining = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000))
        if (remaining <= 0) {
          el.textContent = 'closing...'
          el.classList.add('hs-mc-pred-locked')
          return
        }
        const m = Math.floor(remaining / 60)
        const s = remaining % 60
        el.textContent = m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`
      }
      update()
      const iv = cleanup.setInterval(() => {
        if (!el.isConnected) { clearInterval(iv); return }
        update()
      }, 1000)
    })
  }

  async function renderTwitchTab() {
    const container = document.getElementById('hs-mc-tab-twitch')
    if (!container) return

    const channel = getCurrentChannel()
    if (!channel) {
      container.textContent = ''
      const empty = document.createElement('div')
      empty.className = 'hs-mc-pred-empty'
      const msg = document.createElement('div')
      msg.className = 'hs-mc-pred-empty-text'
      msg.textContent = 'no channel detected'
      empty.appendChild(msg)
      container.appendChild(empty)
      container.appendChild(renderQuickLinks())
      return
    }

    _predictionChannel = channel

    if (!container.querySelector('.hs-mc-prediction, .hs-mc-pred-empty')) {
      container.textContent = ''
      const loading = document.createElement('div')
      loading.className = 'hs-mc-pred-loading'
      loading.textContent = 'loading...'
      container.appendChild(loading)
    }

    const result = await fetchPrediction(channel)

    container.textContent = ''

    if (!result) {
      const empty = document.createElement('div')
      empty.className = 'hs-mc-pred-empty'
      const msg = document.createElement('div')
      msg.className = 'hs-mc-pred-empty-text'
      msg.textContent = "couldn't load predictions"
      empty.appendChild(msg)
      container.appendChild(empty)
      container.appendChild(renderQuickLinks())
      attachPredictionHandlers()
      startPredictionPoll()
      return
    }

    if (result.prediction) {
      container.appendChild(renderPrediction(result.prediction, result.balance))
    } else {
      container.appendChild(renderNoPrediction(result.balance))
    }
    container.appendChild(renderQuickLinks())
    attachPredictionHandlers()
    startPredictionPoll()
  }

  function startPredictionPoll() {
    stopPredictionPoll()
    _predictionPollTimer = cleanup.setInterval(() => {
      const container = document.getElementById('hs-mc-tab-twitch')
      if (!container || container.style.display === 'none') {
        stopPredictionPoll()
        return
      }
      renderTwitchTab()
    }, 15000)
  }

  function stopPredictionPoll() {
    if (_predictionPollTimer) {
      clearInterval(_predictionPollTimer)
      _predictionPollTimer = null
    }
  }

  function triggerTwitchFeature(action) {
    const channel = getCurrentChannel();
    if (!channel) return false;

    const actions = {
      popout: { url: `https://www.twitch.tv/popout/${channel}/chat?popout=`, opts: 'width=400,height=600' },
      mod:    { url: `https://www.twitch.tv/moderator/${channel}`, opts: 'width=1200,height=800' },
    };

    const cfg = actions[action];
    if (!cfg) return false;

    window.open(cfg.url, '_blank', cfg.opts || '');
    return true;
  }

  // Get text from input (handles both input and contenteditable)
  function getInputText() {
    const input = document.getElementById('hs-mc-input');
    if (!input) return '';
    if (wysiwygEnabled) {
      // Convert emote images back to text names
      let text = '';
      for (const node of input.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
          text += node.textContent;
        } else if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'IMG') {
          text += node.dataset.emoteName || node.alt || '';
        }
      }
      return text.replace(/\u00A0/g, ' ');
    }
    return input.value || '';
  }

  function initInput() {
    const input = document.getElementById('hs-mc-input');
    const sendBtn = document.getElementById('hs-mc-send');
    log('🎯 initInput called, input found:', !!input);
    if (!input) {
      log('❌ Input not found in DOM yet, retrying...');
      setTimeout(initInput, 100);
      return;
    }
    // Mark input as initialized to avoid duplicate handlers
    if (input._hsInitialized) {
      log('⚠️ Input already initialized');
      return;
    }
    input._hsInitialized = true;
    log('✅ Initializing input handlers, WYSIWYG:', wysiwygEnabled);

    // Restore pending message
    if (pendingMessage) {
      if (wysiwygEnabled) {
        input.textContent = pendingMessage;
      } else {
        input.value = pendingMessage;
      }
    }

    input.addEventListener('keydown', handleInputKeydown);
    input.addEventListener('input', handleInputChange);
    input.addEventListener('input', updateCharCount);
    input.addEventListener('blur', () => setTimeout(hideAutocomplete, 150));
    sendBtn?.addEventListener('click', sendMessage);

    // WYSIWYG: handle paste to strip formatting
    if (wysiwygEnabled) {
      input.addEventListener('paste', (e) => {
        e.preventDefault();
        const text = e.clipboardData.getData('text/plain');
        document.execCommand('insertText', false, text);
      });
    }

    // Initialize character counter
    updateCharCount();

    // Emote picker button (includes twitch features in tabs)
    const emoteBtn = document.getElementById('hs-mc-emote-btn');
    if (emoteBtn && !emoteBtn._hsInitialized) {
      emoteBtn._hsInitialized = true;
      emoteBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const picker = document.getElementById('hs-mc-emote-picker');
        if (picker?.classList.contains('visible')) {
          picker.classList.remove('visible');
          adjustOverlayForPicker(false);
          if (_pickerCloseHandler) {
            document.removeEventListener('click', _pickerCloseHandler);
            _pickerCloseHandler = null;
          }
        } else {
          showEmotePicker();
        }
      });
    }

    // Update placeholder based on current tab
    updateInputPlaceholder();

    // Global Tab key to focus input from anywhere
    if (!window._hsMcTabHandler) {
      window._hsMcTabHandler = true;
      document.addEventListener('keydown', (e) => {
        if (e.key !== 'Tab') return;
        const input = document.getElementById('hs-mc-input');
        if (!input) return;

        // If not already in our input, focus it
        if (document.activeElement !== input) {
          e.preventDefault();
          input.focus();
        }
      }, { capture: true, signal: mcSignal });
    }

    // Helper: find emote wrapper or img from event target
    function findEmoteTarget(target) {
      // Check wrapper first (our emotes)
      const wrapper = target.closest('.hs-mc-emote-wrapper');
      if (wrapper) {
        return {
          wrapper,
          emoteName: wrapper.dataset.emoteName || wrapper.querySelector('img')?.alt || 'emote',
          state: wrapper.dataset.state || 'global',
          emoteUrl: wrapper.dataset.emoteUrl || wrapper.querySelector('img')?.src || '',
          source: wrapper.dataset.source || 'unknown'
        };
      }
      // Fallback: direct IMG (Twitch/7TV/BTTV native emotes, picker emotes)
      if (target.tagName === 'IMG' && (
        target.classList.contains('hs-mc-emote') ||
        target.classList.contains('hs-mc-picker-emote') ||
        target.classList.contains('chat-line__message--emote') ||
        target.classList.contains('chat-image') ||
        target.src?.includes('7tv.app') ||
        target.src?.includes('betterttv.net') ||
        target.src?.includes('frankerfacez') ||
        target.src?.includes('static-cdn.jtvnw.net/emoticons')
      )) {
        return {
          wrapper: null,
          emoteName: target.alt || target.dataset.emoteName || target.title?.split(' ')[0] || 'emote',
          state: target.dataset.state || 'global',
          emoteUrl: target.src || '',
          source: target.dataset.source || 'unknown'
        };
      }
      return null;
    }

    // Global right-click handler for ALL emotes
    if (!window._hsMcEmoteContextHandler) {
      window._hsMcEmoteContextHandler = true;
      document.addEventListener('contextmenu', (e) => {
        // Stack expand on right-click
        const collapsedStack = e.target.closest('.hs-mc-emote-stack:not(.expanded)');
        if (collapsedStack) {
          e.preventDefault();
          e.stopPropagation();
          collapsedStack.classList.add('expanded');
          collapsedStack.removeAttribute('title');
          return;
        }

        const emoteInfo = findEmoteTarget(e.target);
        if (!emoteInfo) return;
        log('Emote right-click:', emoteInfo.emoteName, emoteInfo.state);

        e.preventDefault();
        e.stopPropagation();

        const { emoteName, state } = emoteInfo;

        if (state === 'blocked') {
          // Blocked → unblock + yellow flash
          unblockEmote(emoteName);
        } else if (state === 'owned') {
          // Owned → remove from inventory + white flash
          removeEmoteFromInventory(emoteName, e.target);
        } else {
          // Global or unadded → block + red flash
          blockEmote(emoteName);
        }
      }, { capture: true, signal: mcSignal });
    }

    // Global left-click handler for ALL emotes
    if (!window._hsMcEmoteClickHandler) {
      window._hsMcEmoteClickHandler = true;
      document.addEventListener('click', (e) => {
        // Stack collapse button
        if (e.target.closest('.hs-mc-stack-collapse')) {
          e.preventDefault();
          e.stopPropagation();
          const stack = e.target.closest('.hs-mc-emote-stack');
          if (stack) {
            stack.classList.remove('expanded');
            stack.setAttribute('title', 'expand');
          }
          return;
        }
        // Stack block-all button
        if (e.target.closest('.hs-mc-stack-block-all')) {
          e.preventDefault();
          e.stopPropagation();
          const stack = e.target.closest('.hs-mc-emote-stack');
          if (stack) blockAllEmotesInStack(stack);
          return;
        }
        // Stack expand on left-click (collapsed)
        const collapsedStack = e.target.closest('.hs-mc-emote-stack:not(.expanded)');
        if (collapsedStack) {
          e.preventDefault();
          e.stopPropagation();
          collapsedStack.classList.add('expanded');
          collapsedStack.removeAttribute('title');
          return;
        }

        const emoteInfo = findEmoteTarget(e.target);
        if (!emoteInfo) return;

        e.preventDefault();
        e.stopPropagation();

        const { emoteName, state, emoteUrl, source } = emoteInfo;

        if (state === 'blocked') {
          // Blocked → unblock + yellow flash
          unblockEmote(emoteName);
        } else if (state === 'owned' || state === 'global' || state === 'channel') {
          // Owned, global, or channel → paste to input + white flash
          pasteEmoteToInput(emoteName);
          flashAllEmotes(emoteName, 'hs-flash-paste');
        } else if (state === 'unadded') {
          // Unadded → add to inventory + green flash
          addEmoteToInventory(emoteName, emoteUrl, source, e.target);
          flashAllEmotes(emoteName, 'hs-flash-add');
        }
      }, { capture: true, signal: mcSignal });
    }

    // Right-click on message → mute/unmute user
    if (!window._hsMcMsgContextHandler) {
      window._hsMcMsgContextHandler = true;
      document.addEventListener('contextmenu', (e) => {
        const msg = e.target.closest('.hs-mc-msg');
        if (!msg) return;
        // Don't intercept if clicking an emote (let emote handler handle it)
        if (findEmoteTarget(e.target)) return;

        e.preventDefault();
        const userEl = msg.querySelector('.hs-mc-user');
        const username = userEl?.textContent?.trim()?.toLowerCase();
        if (!username) return;

        if (mutedUsers.has(username)) {
          mutedUsers.delete(username);
          showToast(`unmuted ${username}`);
        } else {
          mutedUsers.add(username);
          showToast(`muted ${username}`);
        }
        chrome.storage.local.set({ heatsync_mc_muted: [...mutedUsers] });
        applyMcMutes();
      }, { signal: mcSignal });
    }
  }

  function applyMcMutes() {
    document.querySelectorAll('.hs-mc-msg').forEach(msg => {
      const userEl = msg.querySelector('.hs-mc-user');
      const username = userEl?.textContent?.trim()?.toLowerCase();
      if (username && mutedUsers.has(username)) {
        msg.style.opacity = '0.15';
        msg.style.filter = 'blur(2px)';
      } else {
        msg.style.opacity = '';
        msg.style.filter = '';
      }
    });
  }

  function updateInputPlaceholder() {
    const input = document.getElementById('hs-mc-input');
    if (!input) return;

    let placeholder;
    if (currentTab === 'feed') {
      placeholder = 'post to heatsync...';
    } else if (currentTab === 'notifs') {
      placeholder = 'post to heatsync...';
    } else if (currentTab === 'live') {
      const channel = getCurrentChannel();
      placeholder = channel ? `send to #${channel}` : 'send a message...';
    } else if (currentTab === 'mentions' || currentTab === 'posts') {
      const channel = getCurrentChannel();
      placeholder = channel ? `send to #${channel}` : 'send a message...';
    } else if (currentTab === 'add') {
      placeholder = '';
    } else {
      // Channel tab — resolve twitch name for placeholder
      const ch = config.channels.find(c => (typeof c === 'string' ? c : c.id) === currentTab);
      const twitchName = typeof ch === 'string' ? ch : ch?.twitch;
      placeholder = twitchName ? `send to #${twitchName}` : `send to #${currentTab}`;
    }

    if (wysiwygEnabled) {
      input.dataset.placeholder = placeholder;
    } else {
      input.placeholder = placeholder;
    }
  }

  function getCurrentChannel() {
    // Get current channel from URL (works for both Twitch and Kick, including popout/embed)
    const match = location.pathname.match(/^\/(?:popout\/|embed\/)?([a-zA-Z0-9_]+)/);
    if (match && match[1]) {
      const ch = match[1].toLowerCase();
      if (['directory', 'settings', 'videos', 'moderator', 'subscriptions'].includes(ch)) return null;
      return ch;
    }
    return null;
  }

  function handleInputKeydown(e) {
    const input = e.target;

    // Tab - cycle through emote completions
    if (e.key === 'Tab') {
      e.preventDefault();

      if (acState.active && acState.matches.length > 0) {
        // Already cycling - go to next match
        acState.index = (acState.index + 1) % acState.matches.length;
        insertCompletionKeepOpen(acState.matches[acState.index]);
        showCycleTooltip();
      } else {
        // First Tab - find matches
        const word = getCurrentWord(input);
        if (word.length >= 2) {
          const matches = findEmoteMatches(word);
          if (matches.length > 0) {
            // Save state for cycling (WYSIWYG handles positions internally)
            acState.matches = matches;
            acState.index = 0;
            acState.active = true;

            if (!wysiwygEnabled) {
              // Calculate positions for text input cycling
              const text = input.value;
              const pos = input.selectionStart;
              const before = text.slice(0, pos);
              const wordStart = before.search(/\S+$/);
              acState.wordStart = wordStart >= 0 ? wordStart : pos;
              acState.afterText = text.slice(pos);
            }

            insertCompletionKeepOpen(matches[0]);
            showCycleTooltip();
          }
        }
      }
      return;
    }

    // Any other key resets autocomplete cycling
    if (acState.active) {
      hideAutocomplete();
    }

    // Enter - send message
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
      return;
    }

    // Escape - ensure autocomplete is hidden
    if (e.key === 'Escape') {
      hideAutocomplete();
      return;
    }
  }

  function handleInputChange(e) {
    // Save pending message (persists across tab switches)
    pendingMessage = getInputText();

    // Reset autocomplete cycling on any text change
    if (acState.active) {
      hideAutocomplete();
    }
  }

  function updateCharCount() {
    const input = document.getElementById('hs-mc-input');
    if (!input) return;
    const len = getInputText().length;
    input.classList.toggle('over-limit', len > 500)
  }

  function getCurrentWord(input) {
    if (wysiwygEnabled) {
      // For contenteditable, get text up to cursor
      const sel = window.getSelection();
      if (!sel.rangeCount) return '';
      const range = sel.getRangeAt(0);
      // Get text before cursor in current text node
      if (range.startContainer.nodeType === Node.TEXT_NODE) {
        const before = range.startContainer.textContent.slice(0, range.startOffset);
        const match = before.match(/(\S+)$/);
        return match ? match[1] : '';
      }
      return '';
    }
    const text = input.value;
    const pos = input.selectionStart;
    const before = text.slice(0, pos);
    const match = before.match(/(\S+)$/);
    return match ? match[1] : '';
  }

  function findEmoteMatches(search) {
    const matches = [];

    // Check if searching for username (starts with @)
    const isUserSearch = search.startsWith('@');
    const searchTerm = isUserSearch ? search.slice(1) : search;
    const searchLower = searchTerm.toLowerCase();

    // Search usernames if @ prefix or if it could be a username
    if (isUserSearch || searchTerm.length >= 2) {
      for (const username of usernameCache) {
        const userLower = username.toLowerCase();
        if (userLower.startsWith(searchLower)) {
          matches.push({ name: '@' + username, url: null, priority: isUserSearch ? 0 : 2, type: 'user' });
        } else if (!isUserSearch && userLower.includes(searchLower)) {
          matches.push({ name: '@' + username, url: null, priority: 3, type: 'user' });
        }
      }
    }

    // Search emote cache (unless explicitly searching users with @)
    if (!isUserSearch) {
      // Search global + channel emotes for current tab
      const acEmotes = new Map(emoteCache);
      const acChCache = channelEmoteCaches[currentTab] || channelEmoteCaches[getCurrentChannel()];
      if (acChCache) for (const [k, v] of acChCache) acEmotes.set(k, v);
      for (const [name, emote] of acEmotes) {
        if (name.toLowerCase().startsWith(searchLower)) {
          matches.push({ name, url: emote.url, source: emote.source, priority: 0, type: 'emote' });
        } else if (name.toLowerCase().includes(searchLower)) {
          matches.push({ name, url: emote.url, source: emote.source, priority: 1, type: 'emote' });
        }
      }
    }

    // Sort: prefix matches first, then alphabetical
    matches.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.name.localeCompare(b.name);
    });

    return matches;
  }

  // Insert completion and keep cycling state
  function insertCompletionKeepOpen(match) {
    const input = document.getElementById('hs-mc-input');
    if (!input || !match) return;

    if (wysiwygEnabled) {
      insertCompletionWysiwyg(match);
      return;
    }

    // Use saved positions from acState for consistent cycling
    const beforeWord = input.value.slice(0, acState.wordStart);
    const newValue = beforeWord + match.name + ' ' + acState.afterText;

    input.value = newValue;
    pendingMessage = input.value;

    // Position cursor after the inserted word
    const newPos = beforeWord.length + match.name.length + 1;
    input.selectionStart = input.selectionEnd = newPos;
    input.focus();

    updateCharCount();
  }

  // WYSIWYG emote insertion
  function insertCompletionWysiwyg(match) {
    const input = document.getElementById('hs-mc-input');
    if (!input) return;

    // Check if we're replacing an existing cycling emote
    const existingEmote = input.querySelector('img.hs-cycling-emote');
    if (existingEmote) {
      // Update existing image
      if (match.url) {
        existingEmote.src = match.url;
        existingEmote.alt = match.name;
        existingEmote.dataset.emoteName = match.name;
      } else {
        // User completion - replace with text
        const textNode = document.createTextNode(match.name + ' ');
        existingEmote.replaceWith(textNode);
        placeCaretAfter(textNode);
      }
      pendingMessage = getInputText();
      updateCharCount();
      return;
    }

    // First Tab: replace word with emote image
    const sel = window.getSelection();
    if (!sel.rangeCount) return;

    const range = sel.getRangeAt(0);
    if (range.startContainer.nodeType !== Node.TEXT_NODE) return;

    const textNode = range.startContainer;
    const offset = range.startOffset;
    const text = textNode.textContent;

    // Find word start
    let wordStart = offset;
    while (wordStart > 0 && !/\s/.test(text[wordStart - 1])) wordStart--;

    // Split text: before | word | after
    const before = text.slice(0, wordStart);
    const after = text.slice(offset);

    // Save afterText for cycling
    acState.afterText = after;

    if (match.url) {
      // Create emote image
      const img = document.createElement('img');
      img.src = match.url;
      img.alt = match.name;
      img.dataset.emoteName = match.name;
      img.className = 'hs-input-emote hs-cycling-emote';
      img.draggable = false;

      // Rebuild: beforeText + img + nbsp + afterText
      // Use \u00A0 (nbsp) so contenteditable doesn't collapse the space visually
      textNode.textContent = before;
      const space = document.createTextNode('\u00A0' + after);

      // Insert after current text node
      const parent = textNode.parentNode;
      const nextSibling = textNode.nextSibling;
      if (nextSibling) {
        parent.insertBefore(img, nextSibling);
        parent.insertBefore(space, nextSibling);
      } else {
        parent.appendChild(img);
        parent.appendChild(space);
      }

      // Place caret after the space
      placeCaretAfter(space, 1);
    } else {
      // User completion - just insert text
      const newText = before + match.name + ' ' + after;
      textNode.textContent = newText;
      const newPos = before.length + match.name.length + 1;
      range.setStart(textNode, newPos);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    }

    pendingMessage = getInputText();
    updateCharCount();
    input.focus();
  }

  function placeCaretAfter(node, offset = 0) {
    const sel = window.getSelection();
    const range = document.createRange();
    if (node.nodeType === Node.TEXT_NODE) {
      range.setStart(node, Math.min(offset, node.length));
    } else {
      range.setStartAfter(node);
    }
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }


  function showCycleTooltip() {
    let tt = document.getElementById('hs-mc-cycle-tooltip');
    if (!tt) {
      tt = document.createElement('div');
      tt.id = 'hs-mc-cycle-tooltip';
      tt.style.cssText = 'position:absolute;bottom:100%;left:8px;background:#000;color:#fff;padding:4px 8px;font-size:12px;border-radius: 0;z-index:1003;margin-bottom:4px;';
      document.getElementById('hs-mc-inputbar')?.appendChild(tt);
    }
    const m = acState.matches[acState.index];
    tt.textContent = `${acState.index + 1}/${acState.matches.length} ${m.name}`;
    tt.style.display = 'block';
  }

  function hideCycleTooltip() {
    const tt = document.getElementById('hs-mc-cycle-tooltip');
    if (tt) tt.style.display = 'none';
  }

  function hideAutocomplete() {
    acState.active = false;
    acState.matches = [];
    acState.index = 0;
    acState.wordStart = 0;
    acState.afterText = '';
    hideCycleTooltip();

    // WYSIWYG: finalize cycling emote (remove cycling class so it's permanent)
    if (wysiwygEnabled) {
      const input = document.getElementById('hs-mc-input');
      const cyclingEmote = input?.querySelector('.hs-cycling-emote');
      if (cyclingEmote) {
        cyclingEmote.classList.remove('hs-cycling-emote');
      }
    }
  }

  // Get Twitch auth token from cookie
  function getTwitchAuthToken() {
    const cookies = document.cookie.split(';');
    for (const cookie of cookies) {
      const eqIdx = cookie.indexOf('=');
      if (eqIdx === -1) continue;
      const key = cookie.slice(0, eqIdx).trim();
      const value = cookie.slice(eqIdx + 1).trim();
      if (key === 'auth-token' && value) {
        return decodeURIComponent(value);
      }
    }
    return null;
  }

  // Send message to current tab's channel
  async function sendMessage() {
    const input = document.getElementById('hs-mc-input');
    if (!input) { if (MC_DEBUG) console.warn('[HS] SEND BAIL: no input element'); return; }

    const text = getInputText().trim();
    if (!text) { if (MC_DEBUG) console.warn('[HS] SEND BAIL: empty text, wysiwyg=' + wysiwygEnabled, 'raw=', input.textContent || input.value); return; }

    // Feed/notifs tab → post to heatsync API
    if (currentTab === 'feed' || currentTab === 'notifs') {
      postFeedMessage(text);
      return;
    }

    // Determine target channel
    let targetChannel;
    if (currentTab === 'live' || currentTab === 'mentions' || currentTab === 'posts') {
      targetChannel = getCurrentChannel();
    } else if (currentTab === 'add') {
      if (MC_DEBUG) console.warn('[HS] SEND BAIL: on add tab');
      return;
    } else {
      // Resolve twitch name from channel config (object or legacy string)
      const ch = config.channels.find(c => (typeof c === 'string' ? c : c.id) === currentTab);
      targetChannel = typeof ch === 'string' ? ch : ch?.twitch || currentTab;
    }

    if (!targetChannel) {
      if (MC_DEBUG) console.warn('[HS] SEND BAIL: no target channel, currentTab=' + currentTab);
      return;
    }

    // Get auth token
    const token = getTwitchAuthToken();
    if (!token) {
      if (MC_DEBUG) console.warn('[HS] SEND BAIL: no auth token (cookie missing)');
      if (wysiwygEnabled) {
        input.dataset.placeholder = 'not logged in';
      } else {
        input.placeholder = 'not logged in';
      }
      setTimeout(() => updateInputPlaceholder(), 2000);
      return;
    }

    // Send via IRC (fast async) — always log connection state for debugging
    const wsState = authState.ws ? ['CONNECTING','OPEN','CLOSING','CLOSED'][authState.ws.readyState] : 'null';
    console.warn(`[HS] IRC SEND → #${targetChannel} ws=${wsState} ready=${authState.ready} queue=${authState.sendQueue.length}`);
    sendIrcMessage(targetChannel, text, token).then(result => {
      if (result === true) {
        // If ws wasn't OPEN when we sent, message was likely queued — show yellow indicator
        if (wsState !== 'OPEN') {
          input.style.borderColor = '#ff0';
          setTimeout(() => { input.style.borderColor = ''; }, 1500);
        }
        if (wysiwygEnabled) {
          input.textContent = '';
        } else {
          input.value = '';
        }
        pendingMessage = '';
        updateCharCount();
      } else {
        // Show specific error feedback
        input.style.borderColor = '#f44';
        const msg = result === 'no_user' ? 'no username detected'
          : result === 'auth_failed' ? 'auth failed — re-login to twitch'
          : result === 'connect_failed' ? 'connection failed — try again'
          : 'send failed — try again';
        if (wysiwygEnabled) {
          input.dataset.placeholder = msg;
        } else {
          input.placeholder = msg;
        }
        setTimeout(() => {
          input.style.borderColor = '';
          updateInputPlaceholder();
        }, 2500);
      }
    });
  }

  // ============================================
  // AUTHENTICATED IRC — BULLETPROOF SEND ENGINE
  // ============================================
  // Connection kept alive proactively. Dead sockets detected in <70s
  // via PING/PONG. Auto-reconnect with backoff. Messages queued during
  // reconnect window and drained when ready. SPA nav does NOT kill this.

  const authState = {
    ws: null,
    ready: false,
    connecting: false,
    destroyed: false,
    joined: new Set(),
    joinWaiters: new Map(),
    lastData: 0,
    pongPending: false,
    token: null,
    nick: null,
    keepaliveTimer: null,
    reconnectTimer: null,
    reconnectDelay: 1000,
    sendQueue: [], // Capped at 50 — drop oldest if full
  }
  const MAX_SEND_QUEUE = 50

  function authIrcAlive() {
    return authState.ws?.readyState === WebSocket.OPEN && authState.ready
  }

  function cleanupAuthIrc(destroy = false) {
    if (destroy) authState.destroyed = true;
    if (authState.keepaliveTimer) { clearInterval(authState.keepaliveTimer); authState.keepaliveTimer = null; }
    if (authState.reconnectTimer) { clearTimeout(authState.reconnectTimer); authState.reconnectTimer = null; }
    const prevJoined = [...authState.joined];
    if (authState.ws) {
      authState.ws.onclose = null;
      authState.ws.onerror = null;
      authState.ws.onmessage = null;
      try { authState.ws.close(); } catch {}
    }
    authState.ws = null;
    authState.ready = false;
    authState.connecting = false;
    authState.lastData = 0;
    authState.pongPending = false;
    authState.joined.clear();
    for (const [, w] of authState.joinWaiters) {
      clearTimeout(w.timer);
      w.resolve(false);
    }
    authState.joinWaiters.clear();
    return prevJoined;
  }

  function handleAuthIrcMessage(event) {
    authState.lastData = Date.now();
    for (const line of event.data.split('\r\n')) {
      if (!line) continue;
      if (line.startsWith('PING')) {
        try { authState.ws.send(line.replace('PING', 'PONG') + '\r\n'); } catch {}
        continue;
      }
      if (line.includes('PONG')) { authState.pongPending = false; continue; }

      const joinMatch = line.match(/:(\w+)!\w+@\w+\.tmi\.twitch\.tv JOIN #(\w+)/);
      if (joinMatch) {
        const ch = joinMatch[2].toLowerCase();
        authState.joined.add(ch);
        const w = authState.joinWaiters.get(ch);
        if (w) { clearTimeout(w.timer); w.resolve(true); authState.joinWaiters.delete(ch); }
        continue;
      }
      const partMatch = line.match(/:(\w+)!\w+@\w+\.tmi\.twitch\.tv PART #(\w+)/);
      if (partMatch) { authState.joined.delete(partMatch[2].toLowerCase()); continue; }
      if (line.includes('NOTICE') && MC_DEBUG) console.warn('[HS] Auth IRC NOTICE:', line.slice(0, 200));
      if (line.includes('RECONNECT')) {
        log('Auth IRC: Twitch sent RECONNECT');
        const prev = cleanupAuthIrc();
        scheduleReconnect(prev);
        return;
      }
      if (line.includes(' 353 ') || line.includes(' 366 ') || line.includes('ROOMSTATE')) continue;
      if (MC_DEBUG) console.warn('[HS] IRC ←', line.slice(0, 200));
    }
  }

  function scheduleReconnect(prevChannels) {
    if (authState.destroyed || !authState.token || !authState.nick) return;
    if (authState.reconnectTimer) return;
    const delay = authState.reconnectDelay;
    authState.reconnectDelay = Math.min(delay * 2, 30000);
    log(`Auth IRC reconnect in ${delay}ms...`);
    authState.reconnectTimer = setTimeout(async () => {
      authState.reconnectTimer = null;
      if (authState.destroyed || authIrcAlive()) return;
      const ok = await connectAuthIrc(authState.token, authState.nick);
      if (ok === true) {
        for (const ch of (prevChannels || [])) await joinChannel(ch);
        drainSendQueue();
        log('Auth IRC reconnected, rejoined:', (prevChannels || []).join(', ') || '(none)');
      } else if (ok !== 'auth_failed') {
        scheduleReconnect(prevChannels);
      }
    }, delay);
  }

  async function connectAuthIrc(token, nick) {
    if (authState.connecting) {
      for (let i = 0; i < 80; i++) {
        await new Promise(r => setTimeout(r, 100));
        if (authIrcAlive()) return true;
        if (!authState.connecting) break;
      }
      return authIrcAlive();
    }
    cleanupAuthIrc();
    authState.connecting = true;
    authState.token = token;
    authState.nick = nick;
    authState.destroyed = false;
    try {
      const ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
      authState.ws = ws;
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('timeout')), 8000);
        ws.onopen = () => {
          ws.send(`PASS oauth:${token}\r\n`);
          ws.send(`NICK ${nick}\r\n`);
          ws.send('CAP REQ :twitch.tv/commands twitch.tv/tags\r\n');
        };
        ws.onmessage = (event) => {
          if (event.data.includes(' 001 ')) {
            authState.ready = true;
            authState.lastData = Date.now();
            authState.reconnectDelay = 1000;
            clearTimeout(timeout);
            resolve();
          }
          if (event.data.includes('Login authentication failed') || event.data.includes('Login unsuccessful')) {
            clearTimeout(timeout);
            reject(new Error('auth_failed'));
          }
          for (const l of event.data.split('\r\n')) {
            if (l.startsWith('PING')) try { ws.send(l.replace('PING', 'PONG') + '\r\n'); } catch {}
          }
        };
        ws.onerror = () => { clearTimeout(timeout); reject(new Error('ws_error')); };
        ws.onclose = () => { clearTimeout(timeout); reject(new Error('ws_closed')); };
      });
      ws.onmessage = handleAuthIrcMessage;
      ws.onclose = () => {
        log('Auth IRC disconnected');
        const prev = cleanupAuthIrc();
        scheduleReconnect(prev);
      };
      ws.onerror = () => {};
      // Keepalive PING every 60s — detect dead sockets fast
      authState.keepaliveTimer = cleanup.setInterval(() => {
        if (!authState.ws || authState.ws.readyState !== WebSocket.OPEN) return;
        if (authState.pongPending) {
          log('Auth IRC: PONG timeout, reconnecting');
          const prev = cleanupAuthIrc();
          scheduleReconnect(prev);
          return;
        }
        authState.pongPending = true;
        try { authState.ws.send('PING :hs\r\n'); } catch {}
      }, 60000);
      authState.connecting = false;
      return true;
    } catch (e) {
      log('Auth IRC connect failed:', e.message);
      authState.connecting = false;
      cleanupAuthIrc();
      return e.message === 'auth_failed' ? 'auth_failed' : false;
    }
  }

  function joinChannel(channel) {
    channel = channel.toLowerCase();
    if (authState.joined.has(channel)) return Promise.resolve(true);
    if (!authIrcAlive()) return Promise.resolve(false);
    try { authState.ws.send(`JOIN #${channel}\r\n`); } catch { return Promise.resolve(false); }
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        authState.joinWaiters.delete(channel);
        authState.joined.add(channel);
        resolve(true);
      }, 3000);
      authState.joinWaiters.set(channel, { resolve, timer });
    });
  }

  function drainSendQueue() {
    while (authState.sendQueue.length && authIrcAlive()) {
      const { channel, text } = authState.sendQueue.shift();
      try {
        authState.ws.send(`PRIVMSG #${channel} :${text}\r\n`);
        log('Drained queued msg to #' + channel);
      } catch {
        authState.sendQueue.unshift({ channel, text });
        break;
      }
    }
  }

  async function sendIrcMessage(channel, text, token) {
    const nick = currentUsername || getCurrentUsername();
    if (!nick) { if (MC_DEBUG) console.warn('[HS] SEND FAIL: no username'); return 'no_user'; }
    channel = channel.toLowerCase();

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (!authIrcAlive()) {
          const result = await connectAuthIrc(token, nick);
          if (result === 'auth_failed') return 'auth_failed';
          if (!result) {
            if (attempt < 2) continue;
            if (authState.sendQueue.length < MAX_SEND_QUEUE) authState.sendQueue.push({ channel, text });
            scheduleReconnect([channel]);
            log('Queued message for reconnect');
            return true;
          }
        }
        if (!authState.joined.has(channel)) await joinChannel(channel);
        if (!authIrcAlive()) {
          if (attempt < 2) { cleanupAuthIrc(); continue; }
          if (authState.sendQueue.length < MAX_SEND_QUEUE) authState.sendQueue.push({ channel, text });
          scheduleReconnect([channel]);
          return true;
        }
        authState.ws.send(`PRIVMSG #${channel} :${text}\r\n`);
        if (MC_DEBUG) console.warn('[HS] IRC SEND →', `#${channel}`, `nick=${nick}`, text.slice(0, 40));
        return true;
      } catch (e) {
        log('Send error attempt', attempt, ':', e.message || e);
        cleanupAuthIrc();
        if (attempt === 2) {
          if (authState.sendQueue.length < MAX_SEND_QUEUE) authState.sendQueue.push({ channel, text });
          scheduleReconnect([channel]);
          return true;
        }
      }
    }
    return 'send_error';
  }

  function updateTabBar() {
    if (!tabBarElement) return;

    // Clear existing channel tabs (keep built-in tabs)
    const existingChannelTabs = tabBarElement.querySelectorAll('.hs-mc-tab[data-tab]:not([data-tab="live"]):not([data-tab="feed"]):not([data-tab="notifs"]):not([data-tab="mentions"]):not([data-tab="posts"]):not([data-tab="add"]):not([data-tab="rotate"])');
    existingChannelTabs.forEach(t => t.remove());

    // Add channel tabs before the + button (or append if no + button, e.g. Kick)
    const addBtn = tabBarElement.querySelector('[data-tab="add"]');
    const rotateBtn = tabBarElement.querySelector('[data-tab="rotate"]');
    const insertBefore = addBtn || rotateBtn;
    config.channels.forEach(ch => {
      const tab = document.createElement('button');
      tab.className = 'hs-mc-tab';
      const id = typeof ch === 'string' ? ch : ch.id;
      tab.dataset.tab = id;
      tab.textContent = id;
      if (insertBefore) insertBefore.before(tab);
      else tabBarElement.appendChild(tab);
    });

    // Update active state
    tabBarElement.querySelectorAll('.hs-mc-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.tab === currentTab);
    });
  }

  // ============================================
  // STYLES (injected once)
  // ============================================

  function injectStyles() {
    if (document.getElementById('hs-mc-styles')) return;

    const style = document.createElement('style');
    style.id = 'hs-mc-styles';
    style.textContent = `
      /* Tab bar - positioned at top of chat via render injection */
      #hs-mc-tabbar {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        padding: 6px 10px;
        background: #000;
        border-bottom: 1px solid #fff;
        flex-shrink: 0;
        order: -1;
        z-index: 10;
      }

      /* Chatterino-style composable tab states: idle → has-new → active */
      .hs-mc-tab {
        padding: 3px 8px !important;
        background: #000 !important;
        color: #808080 !important;
        border: 1px solid #808080 !important;
        border-radius: 0 !important;
        cursor: pointer !important;
        font-family: inherit;
        font-size: 12px !important;
        line-height: 1 !important;
        transition: background 150ms, color 150ms, border-color 150ms;
        text-align: center;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      /* Idle hover — subtle brighten */
      .hs-mc-tab:not(.active):not(.has-new):hover {
        color: #808080 !important;
        background: #000 !important;
      }
      /* New messages — activity indicator */
      .hs-mc-tab.has-new {
        background: #000 !important;
        color: #ffff00 !important;
        border-color: #808080 !important;
      }
      /* Has-new hover */
      .hs-mc-tab.has-new:not(.active):hover {
        background: #000 !important;
      }
      /* Active — focused tab */
      .hs-mc-tab.active {
        background: #fff !important;
        color: #000 !important;
        border-color: #fff !important;
        font-weight: 600;
      }
      /* Active ignores hover */
      .hs-mc-tab.active:hover {
        background: #fff !important;
        color: #000 !important;
      }
      .hs-mc-tab.has-new.active {
        color: #000 !important;
      }
      /* Live dot — red indicator, composes with any state */
      .hs-mc-tab {
        position: relative !important;
      }
      .hs-mc-tab[data-live="true"]::after {
        content: '';
        position: absolute;
        top: 2px;
        right: 2px;
        width: 6px;
        height: 6px;
        background: #f00;
        border-radius: 50%;
        pointer-events: none;
      }
      .hs-mc-tab.active[data-live="true"]::after {
        background: #cc0000;
      }

      /* Overlay - fills chat container (below tab bar, above input bar) */
      #hs-mc-overlay {
        position: absolute;
        top: 38px; /* Default; dynamically adjusted by ResizeObserver */
        left: 0;
        right: 0;
        bottom: 52px; /* Leave room for input bar */
        background: #000;
        z-index: 1000;
        display: none;
        flex-direction: column;
        overflow: hidden;
      }
      #hs-mc-overlay.visible {
        display: flex;
      }

      /* Resize drag bar on left edge of chat column */
      #hs-mc-resize-handle {
        position: absolute;
        top: 0;
        left: 0;
        width: 5px;
        height: 100%;
        cursor: ew-resize;
        z-index: 2000;
        background: transparent;
        transition: background 0.15s;
      }
      #hs-mc-resize-handle:hover,
      #hs-mc-resize-handle:active {
        background: #9147ff;
      }

      #hs-mc-messages {
        flex: 1;
        overflow-y: auto;
        overflow-x: hidden;
        padding: 8px;
        font-size: var(--hs-chat-font, 13px) !important;
        line-height: 1.4 !important;
        word-wrap: break-word;
        word-break: break-word;
        max-width: 100%;
        box-sizing: border-box;
      }

      /* New messages button - floats above messages */
      #hs-mc-new-msgs {
        position: absolute;
        bottom: 12px;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(255, 255, 0, 0.95);
        color: #000;
        border: none;
        border-radius: 0;
        padding: 8px 16px;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        z-index: 1005;
        box-shadow: 0 2px 12px rgba(0,0,0,0.6);
        backdrop-filter: blur(4px);
        transition: background 0.15s;
      }
      #hs-mc-new-msgs:hover {
        background: rgba(230, 230, 0, 0.95);
      }

      /* UNIFIED INPUT BAR - always visible at bottom */
      #hs-mc-inputbar {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        display: flex;
        gap: 6px;
        padding: 8px;
        background: #000;
        border-top: 1px solid #808080;
        z-index: 1002;
        box-sizing: border-box;
      }

      /* NUKE native Twitch chat when our overlay is active (FFZ-style class toggle) */
      /* Hide native chat messages container */
      .hs-native-hidden [class*="chat-scrollable-area__message-container"],
      .hs-native-hidden [class*="chat-list--default"],
      .hs-native-hidden [class*="chat-list--other"],
      .hs-native-hidden [data-a-target="chat-scroller"] {
        display: none !important;
      }
      /* Hide native chat input area */
      .hs-native-hidden [class*="chat-input-container"],
      .hs-native-hidden [data-a-target="chat-input"] {
        display: none !important;
      }
      /* Hide native chat header/room content — our elements are in #hs-mc-container (sibling) */
      .hs-native-hidden [class*="chat-room__content"] > * {
        display: none !important;
      }
      /* Collapse the native chat container itself so #hs-mc-container gets flex space */
      [class*="chat-room__content"].hs-native-hidden {
        display: none !important;
      }
      /* HeatSync container — sibling of React's chat-room__content, outside React's tree */
      #hs-mc-container {
        position: relative;
        display: flex;
        flex-direction: column;
        flex: 1;
        width: 100%;
        min-height: 0;
        overflow: hidden;
        background: #000;
      }

      /* Vertical tabs: container gets row direction */
      .hs-tabs-left #hs-mc-container,
      .hs-tabs-right #hs-mc-container {
        flex-direction: row;
      }
      /* Keep chat-shell visible (our #hs-mc-container lives inside it) but hide native children */
      .chat-shell.hs-native-hidden,
      [class*="chat-shell"].hs-native-hidden {
        display: flex !important;
        flex-direction: column !important;
        height: 100% !important;
        min-width: 0 !important;
        background: #000 !important;
      }
      .chat-shell.hs-native-hidden > *:not(#hs-mc-container),
      [class*="chat-shell"].hs-native-hidden > *:not(#hs-mc-container) {
        display: none !important;
      }
      /* Ensure stream-chat ancestor also stays sized */
      [class*="stream-chat"].hs-native-hidden {
        display: flex !important;
        flex-direction: column !important;
        height: 100% !important;
      }
      .hs-native-hidden {
        background: #000 !important;
      }

      /* Never hide Twitch's native collapse/expand arrows — user needs them.
         Hide HS UI when chat is collapsed so it doesn't interfere with layout. */
      .right-column--collapsed #hs-mc-container {
        display: none !important;
      }
      /* Collapsed chat: width 0 but overflow visible so the toggle arrow
         (which is a grandchild) can still render outside the box */
      .right-column--collapsed {
        width: 0px !important;
        min-width: 0px !important;
        overflow: visible !important;
      }
      .right-column--collapsed > *:not(:has(.right-column__toggle-visibility)) {
        overflow: hidden !important;
        width: 0px !important;
        min-width: 0px !important;
      }
      .right-column--collapsed > *:has(.right-column__toggle-visibility) {
        overflow: visible !important;
      }
      .right-column--collapsed .right-column__toggle-visibility {
        transform: none !important;
        left: -32px !important;
        z-index: 50 !important;
      }
      div:has(> .right-column--collapsed) {
        width: 0px !important;
        min-width: 0px !important;
        overflow: visible !important;
      }
      /* Force collapse/expand arrow to white — Twitch light theme leaks
         into the toggle wrapper, making it black on dark background */
      .right-column__toggle-visibility button {
        color: #fff !important;
      }
      .right-column__toggle-visibility svg {
        fill: #fff !important;
      }

      /* Ensure our elements are visible */
      #hs-mc-tabbar,
      #hs-mc-inputbar {
        display: flex !important;
      }

      .hs-mc-msg {
        padding: 2px 4px;
        border-radius: 0;
        font-size: var(--hs-chat-font, 13px) !important;
        line-height: 1.4 !important;
        word-wrap: break-word;
        word-break: break-word;
        overflow-wrap: anywhere;
        overflow: hidden;
        max-width: 100%;
        box-sizing: border-box;
        color: #ffffff;
      }
      .hs-mc-msg:hover {
        background: #000;
      }
      .hs-mc-msg.hs-mc-system {
        border-left: 3px solid #9147ff;
        padding-left: 8px;
        background: rgba(145, 71, 255, 0.08);
      }
      .hs-mc-system-text {
        color: #b0b0b0;
        font-size: 12px;
        font-style: italic;
        display: block;
      }
      .hs-mc-msg.hs-mc-redeemed {
        background: rgba(145, 71, 255, 0.15);
        border-left: 3px solid #9147ff;
        padding-left: 8px;
      }
      .hs-mc-reply-ctx {
        font-size: 11px;
        color: #808080;
        padding: 1px 0 1px 8px;
        border-left: 2px solid #808080;
        margin-bottom: 1px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .hs-mc-reply-user {
        color: #808080;
        font-weight: 600;
      }
      .hs-mc-msg.mention {
        background: rgba(212, 73, 73, 0.3);
      }
      .hs-mc-msg.tweet {
        background: rgba(212, 73, 73, 0.3);
      }
      .hs-mc-user {
        font-weight: 600;
        text-decoration: none;
        cursor: pointer;
      }
      .hs-mc-platform-badge {
        font-size: var(--hs-badge-font, 10px);
        margin-right: 3px;
        font-weight: 700;
        vertical-align: middle;
      }
      .hs-mc-platform-badge.hs-mc-pb-twitch { color: #9146ff; }
      .hs-mc-platform-badge.hs-mc-pb-kick { color: #53fc18; }
      .hs-mc-platform-badge.hs-mc-pb-yt { color: #ff0000; }
      .hs-mc-badge {
        display: inline-block;
        font-size: var(--hs-stat-badge-font, 9px);
        padding: 0 3px;
        border-radius: 0;
        margin-right: 2px;
        font-weight: 700;
        vertical-align: middle;
        line-height: var(--hs-stat-badge-line, 16px);
        letter-spacing: 0.3px;
      }
      .hs-mc-badge-img {
        width: var(--hs-badge-img, 18px);
        height: var(--hs-badge-img, 18px);
        vertical-align: middle;
        margin-right: 2px;
      }

      /* Username hover tooltip - profile preview */
      #hs-user-tooltip {
        position: fixed;
        z-index: 5000;
        pointer-events: none;
        background: #000;
        border: 1px solid #808080;
        border-radius: 0;
        padding: 10px 6px 6px 6px;
        display: none;
        min-width: 240px;
        max-width: 400px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.6);
      }
      #hs-user-tooltip.visible {
        display: flex;
      }
      #hs-user-tooltip .hs-pc-avatar {
        width: 32px;
        height: 32px;
        min-width: 32px;
        border: 1px solid #000;
        object-fit: cover;
        flex-shrink: 0;
        align-self: flex-start;
      }
      #hs-user-tooltip .hs-pc-info {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 1px;
        margin-left: 6px;
      }
      #hs-user-tooltip .hs-pc-header {
        display: flex;
        align-items: center;
        gap: 4px;
        flex-wrap: wrap;
        line-height: 1.2;
      }
      #hs-user-tooltip .hs-pc-platform {
        font-size: 10px;
        padding: 1px 2px;
        font-weight: 900;
        border: 1px solid #000;
        white-space: nowrap;
        letter-spacing: 0.2px;
      }
      #hs-user-tooltip .hs-pc-platform.twitch {
        background: #9146ff;
        color: #fff;
      }
      #hs-user-tooltip .hs-pc-platform.kick {
        background: #53fc18;
        color: #000;
      }
      #hs-user-tooltip .hs-pc-name {
        font-size: 14px;
        font-weight: 600;
        white-space: nowrap;
        background: #fff;
        border: 1px solid #000;
        padding: 2px 3px;
        color: #000;
      }
      #hs-user-tooltip .hs-pc-role {
        padding: 2px 3px;
        font-size: 10px;
        font-weight: 900;
        white-space: nowrap;
        border: 1px solid #000;
        letter-spacing: 0.3px;
      }
      #hs-user-tooltip .hs-pc-role.admin { background: #ff0000; color: #fff; }
      #hs-user-tooltip .hs-pc-role.staff { background: #ff8800; color: #000; }
      #hs-user-tooltip .hs-pc-role.partner { background: #ffaa00; color: #000; }
      #hs-user-tooltip .hs-pc-role.affiliate { background: #808080; color: #fff; }
      #hs-user-tooltip .hs-pc-age {
        padding: 2px 3px;
        font-size: 10px;
        font-weight: 900;
        border: 1px solid #000;
        background: #cc5500;
        color: #000;
        white-space: nowrap;
        letter-spacing: 0.3px;
      }
      #hs-user-tooltip .hs-pc-bio {
        font-size: 12px;
        color: #fff;
        line-height: 1.3;
        margin: 2px 0;
        word-break: break-word;
      }
      #hs-user-tooltip .hs-pc-stats {
        display: flex;
        align-items: center;
        gap: 4px;
        flex-wrap: wrap;
        font-size: 10px;
        color: #fff;
        line-height: 1.2;
      }
      #hs-user-tooltip .hs-pc-stat {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 2px 6px;
        font-size: 11px;
        font-weight: 500;
        border: 1px solid #fff;
        background: transparent;
        color: #fff;
        white-space: nowrap;
        letter-spacing: 0.3px;
      }
      #hs-user-tooltip .hs-pc-stat.heat {
        background: #000;
        border: 1px solid #fff;
        padding: 2px 8px;
        font-size: 12px;
      }
      #hs-user-tooltip .hs-pc-stat.heat .hs-pc-num {
        font-weight: 900;
        font-size: 13px;
      }
      #hs-user-tooltip .hs-pc-stat.op,
      #hs-user-tooltip .hs-pc-stat.re {
        background: #fff;
        color: #000;
        border: 1px solid #000;
      }
      #hs-user-tooltip .hs-pc-stat.op .hs-pc-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 14px;
        height: 14px;
        font-size: 9px;
        background: #fff;
        color: #f00;
        font-weight: 700;
        border: 1px solid #f00;
      }
      #hs-user-tooltip .hs-pc-stat.re .hs-pc-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 14px;
        height: 14px;
        font-size: 9px;
        background: #88ccff;
        color: #000;
        font-weight: 700;
      }
      #hs-user-tooltip .hs-pc-rel {
        display: flex;
        align-items: center;
        gap: 4px;
        flex-wrap: wrap;
        font-size: 10px;
        line-height: 1.2;
      }
      #hs-user-tooltip .hs-pc-rel-badge {
        padding: 2px 3px;
        font-size: 10px;
        font-weight: 900;
        white-space: nowrap;
        letter-spacing: 0.3px;
      }
      #hs-user-tooltip .hs-pc-rel-badge.mutual { background: #00ffff; color: #8800ff; }
      #hs-user-tooltip .hs-pc-rel-badge.supporter { background: #ff0000; color: #ffff00; }
      #hs-user-tooltip .hs-pc-loading {
        color: #808080;
        font-size: 11px;
      }
      .hs-mc-channel {
        color: #808080;
        font-size: 11px;
        margin-left: 4px;
      }
      .hs-mc-time {
        color: #808080;
        font-size: var(--hs-time-font, 10px);
        margin-right: 4px;
      }
      .hs-mc-empty {
        color: #808080;
        padding: 20px;
        text-align: center;
      }
      .hs-mc-emote {
        height: var(--hs-emote-size, 32px);
        width: auto;
        vertical-align: middle;
        margin: 0 2px;
        padding: 4px;
        border-radius: 0;
        transition: background 0.1s, transform 0.1s;
        cursor: pointer;
        box-sizing: content-box;
      }
      .hs-mc-picker-emote {
        height: var(--hs-emote-size, 32px);
        vertical-align: middle;
        margin: 0 2px;
        padding: 4px;
        border-radius: 0;
        transition: background 0.1s, transform 0.1s;
        cursor: pointer;
        box-sizing: content-box;
      }

      /* 7TV ZERO-WIDTH OVERLAY EMOTE STACKING */
      .hs-mc-emote-stack {
        display: inline-block;
        position: relative;
        vertical-align: middle;
      }
      .hs-mc-emote-stack-emotes {
        display: inline-grid;
        place-items: center;
      }
      .hs-mc-emote-stack-emotes > .hs-mc-emote-wrapper {
        grid-area: 1 / 1;
      }
      .hs-mc-emote-stack-emotes > .hs-mc-emote-wrapper:first-child {
        z-index: 1;
      }
      .hs-mc-emote-stack-emotes > .hs-mc-emote-wrapper:not(:first-child) {
        z-index: 2;
        pointer-events: auto;
      }
      /* Overlay emote at native size, not constrained to base */
      .hs-mc-overlay-emote {
        height: auto !important;
        margin: 0 !important;
        pointer-events: auto;
      }

      /* EMOTE STACK EXPAND/COLLAPSE */
      .hs-mc-stack-collapse,
      .hs-mc-stack-block-all {
        display: none;
        cursor: pointer;
        font-size: 14px;
        line-height: 1;
        padding: 0 2px;
        user-select: none;
      }
      .hs-mc-emote-stack.expanded {
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }
      .hs-mc-emote-stack.expanded .hs-mc-emote-stack-emotes {
        background: #808080;
        border-radius: 0;
        padding: 2px 6px;
        display: inline-flex;
        gap: 4px;
        align-items: center;
      }
      .hs-mc-emote-stack.expanded > .hs-mc-emote-stack-emotes > .hs-mc-emote-wrapper {
        grid-area: auto;
      }
      .hs-mc-emote-stack.expanded .hs-mc-stack-collapse,
      .hs-mc-emote-stack.expanded .hs-mc-stack-block-all {
        display: inline-block;
      }
      .hs-mc-stack-collapse:hover {
        filter: invert(1);
      }
      .hs-mc-stack-block-all:hover {
        color: #ff0000;
      }

      /* STATE-BASED EMOTE COLORS (website parity) */
      /* Wrapper spans for solid color hover rectangles */
      .hs-mc-emote-wrapper {
        display: inline-block;
        position: relative;
        vertical-align: middle;
        cursor: pointer;
        line-height: 0;
        font-size: 0;
      }
      .hs-mc-emote-wrapper > img {
        display: block;
      }
      .hs-mc-emote-wrapper::before {
        content: '';
        position: absolute;
        inset: 4px;
        border-radius: 0;
        opacity: 0;
        transition: opacity 0.1s;
        z-index: 1;
        pointer-events: none;
      }
      /* Hover: show solid color rect, hide image */
      .hs-mc-emote-wrapper.hs-emote-highlight::before {
        opacity: 1;
      }
      .hs-mc-emote-wrapper.hs-emote-highlight > img {
        visibility: hidden;
      }

      /* State colors via ::before */
      .hs-mc-emote-wrapper.hs-state-global::before { background: #ffcc00; }
      .hs-mc-emote-wrapper.hs-state-owned::before { background: #00ff00; }
      .hs-mc-emote-wrapper.hs-state-unadded::before { background: #0088ff; }
      .hs-mc-emote-wrapper.hs-state-channel::before { background: #ffcc00; }
      .hs-mc-emote-wrapper.hs-state-blocked::before { background: #ff0000; }

      /* Blocked emotes: hide img (keeps natural dimensions), dashed line via ::before */
      .hs-mc-emote-wrapper.hs-state-blocked > img {
        visibility: hidden;
      }
      .hs-mc-emote-wrapper.hs-state-blocked::before {
        opacity: 1;
        background: none;
        border: 2px dashed #808080;
      }
      .hs-mc-emote-wrapper.hs-state-blocked.hs-emote-highlight::before {
        background: #ff0000;
        border: none;
      }

      /* Flash animations */
      @keyframes hs-flash-paste { 0% { box-shadow: 0 0 12px 4px #fff; } 100% { box-shadow: none; } }
      @keyframes hs-flash-add { 0% { box-shadow: 0 0 12px 4px #00ff00; } 100% { box-shadow: none; } }
      @keyframes hs-flash-block { 0% { box-shadow: 0 0 12px 4px #ff0000; } 100% { box-shadow: none; } }
      @keyframes hs-flash-unblock { 0% { box-shadow: 0 0 12px 4px #ffff00; } 100% { box-shadow: none; } }
      @keyframes hs-flash-remove { 0% { box-shadow: 0 0 12px 4px #fff; } 100% { box-shadow: none; } }
      .hs-flash-paste { animation: hs-flash-paste 0.4s ease-out; }
      .hs-flash-add { animation: hs-flash-add 0.4s ease-out; }
      .hs-flash-block { animation: hs-flash-block 0.4s ease-out; }
      .hs-flash-unblock { animation: hs-flash-unblock 0.4s ease-out; }
      .hs-flash-remove { animation: hs-flash-remove 0.4s ease-out; }

      /* Legacy img classes (for picker, tooltips) */
      .hs-mc-emote, .hs-mc-picker-emote {
        position: relative;
      }

      /* Emote hover tooltip - 4x preview */
      #hs-emote-tooltip {
        position: fixed;
        z-index: 5000;
        pointer-events: none;
        background: #000;
        border: 2px solid #808080;
        border-radius: 0;
        padding: 8px;
        display: none;
        flex-direction: column;
        align-items: center;
        gap: 6px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.6);
      }
      #hs-emote-tooltip.visible {
        display: flex;
      }
      #hs-emote-tooltip img {
        object-fit: contain;
        image-rendering: pixelated;
      }
      #hs-emote-tooltip .tooltip-name {
        color: #fff;
        font-size: 13px;
        font-weight: 600;
      }
      #hs-emote-tooltip .tooltip-source {
        font-size: 11px;
        padding: 2px 6px;
        border-radius: 0;
        color: #fff;
      }
      #hs-emote-tooltip .tooltip-source.owned { background: #00ff00; color: #000; }
      #hs-emote-tooltip .tooltip-source.unadded { background: #0088ff; color: #fff; }
      #hs-emote-tooltip .tooltip-source.global { background: #ffcc00; color: #000; }
      #hs-emote-tooltip .tooltip-source.channel { background: #ffcc00; color: #000; }
      #hs-emote-tooltip .tooltip-source.blocked { background: #ff0000; color: #fff; }

      /* Input styles (used in #hs-mc-inputbar) */
      #hs-mc-input {
        flex: 1;
        padding: 8px 12px;
        background: #fff;
        color: #000;
        border: 1px solid #808080;
        border-radius: 0;
        font-size: 13px;
        font-family: inherit;
        outline: none;
      }
      #hs-mc-input:focus {
        border-color: #9147ff;
      }
      #hs-mc-input::placeholder {
        color: #808080;
      }
      /* Contenteditable placeholder */
      #hs-mc-input[contenteditable]:empty::before {
        content: attr(data-placeholder);
        color: #808080;
        pointer-events: none;
      }
      /* WYSIWYG emote images in input */
      #hs-mc-input .hs-input-emote {
        height: var(--hs-emote-size, 32px);
        vertical-align: middle;
        margin: 0 2px;
      }
      /* Toggle button */
      .hs-mc-toggle-btn {
        padding: 4px 10px;
        background: #000;
        color: #808080;
        border: none;
        border-radius: 0;
        font-size: 11px;
        cursor: pointer;
        transition: all 0.15s;
      }
      .hs-mc-toggle-btn:hover {
        background: rgba(255,255,255,0.06);
      }
      .hs-mc-toggle-btn.active {
        background: #9147ff;
        color: #fff;
      }
      #hs-mc-input.over-limit {
        color: #ff4444 !important;
      }
      #hs-mc-send {
        padding: 8px 12px;
        background: #9147ff;
        color: #fff;
        border: none;
        border-radius: 0;
        cursor: pointer;
        font-size: 14px;
      }
      #hs-mc-send:hover {
        background: #772ce8;
      }

      /* Heatsync button */
      #hs-mc-emote-btn {
        padding: 6px 8px;
        background: #000;
        color: #fff;
        border: none;
        border-radius: 0;
        cursor: pointer;
        transition: background 0.15s;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
      }
      #hs-mc-emote-btn:hover {
        background: rgba(255,255,255,0.06);
      }

      /* Emote picker panel — full-width section above inputbar */
      #hs-mc-emote-picker {
        display: none;
        position: absolute;
        left: 0;
        right: 0;
        bottom: 52px;
        height: 400px;
        background: #000;
        border-top: 1px solid #808080;
        z-index: 1003;
        overflow: hidden;
        flex-direction: column;
        font-family: inherit;
        box-sizing: border-box;
      }
      #hs-mc-emote-picker.visible {
        display: flex;
      }

      /* Picker tabs — pinned to bottom */
      #hs-mc-emote-picker .hs-mc-picker-tabs {
        display: flex !important;
        border-top: 1px solid rgba(255,255,255,0.08);
        flex-shrink: 0 !important;
        min-height: 40px !important;
        visibility: visible !important;
        opacity: 1 !important;
        background: #000 !important;
      }
      #hs-mc-emote-picker .hs-mc-picker-tab {
        flex: 1 !important;
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        gap: 5px !important;
        padding: 8px !important;
        background: transparent !important;
        color: #808080 !important;
        border: none !important;
        cursor: pointer;
        font-size: 11px !important;
        font-weight: 500;
        text-align: center;
        visibility: visible !important;
        opacity: 1 !important;
        height: auto !important;
        width: auto !important;
        overflow: visible !important;
        position: relative !important;
        transition: color 0.15s, background 0.15s;
      }
      #hs-mc-emote-picker .hs-mc-picker-tab svg {
        opacity: 0.5;
        transition: opacity 0.15s;
      }
      #hs-mc-emote-picker .hs-mc-picker-tab:hover {
        color: #808080 !important;
        background: rgba(255,255,255,0.04) !important;
      }
      #hs-mc-emote-picker .hs-mc-picker-tab:hover svg {
        opacity: 0.8;
      }
      #hs-mc-emote-picker .hs-mc-picker-tab.active {
        color: #ff6b35 !important;
        background: transparent !important;
      }
      #hs-mc-emote-picker .hs-mc-picker-tab.active svg {
        opacity: 1;
      }
      #hs-mc-emote-picker .hs-mc-picker-tab.active::after {
        content: '';
        position: absolute;
        top: 0;
        left: 20%;
        right: 20%;
        height: 2px;
        background: #ff6b35;
      }
      .hs-mc-tab {
        flex: 1;
        padding: 12px;
        background: transparent;
        color: #808080;
        border: none;
        cursor: pointer;
        font-size: 15px;
        font-weight: 500;
        transition: color 0.15s, background 0.15s;
        text-align: center;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      .hs-mc-tab:hover {
        color: #fff;
        background: #000;
      }
      .hs-mc-tab.active {
        color: #fff;
        background: #9147ff;
        border-bottom: 2px solid #9147ff;
        margin-bottom: -1px;
      }
      .hs-mc-tab-content {
        flex: 1 1 0 !important;
        min-height: 0 !important;
        max-height: calc(400px - 42px) !important;
        overflow-y: auto !important;
      }
      /* Custom scrollbar */
      .hs-mc-tab-content::-webkit-scrollbar,
      .hs-mc-picker-scroll::-webkit-scrollbar {
        width: 4px;
      }
      .hs-mc-tab-content::-webkit-scrollbar-track,
      .hs-mc-picker-scroll::-webkit-scrollbar-track {
        background: transparent;
      }
      .hs-mc-tab-content::-webkit-scrollbar-thumb,
      .hs-mc-picker-scroll::-webkit-scrollbar-thumb {
        background: rgba(255,255,255,0.12);
        border-radius: 0;
      }
      .hs-mc-tab-content::-webkit-scrollbar-thumb:hover,
      .hs-mc-picker-scroll::-webkit-scrollbar-thumb:hover {
        background: rgba(255,255,255,0.2);
      }
      .hs-mc-picker-scroll {
        flex: 1;
        overflow-y: auto;
        min-height: 0;
      }
      .hs-mc-picker-section-header {
        position: sticky;
        top: 0;
        background: #000;
        padding: 6px 10px;
        font-size: 11px;
        color: #808080;
        text-transform: lowercase;
        z-index: 1;
        border-bottom: 1px solid rgba(255,255,255,0.06);
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .hs-mc-picker-section-count {
        color: #808080;
        font-size: 10px;
        background: rgba(255,255,255,0.06);
        padding: 1px 5px;
        border-radius: 0;
      }
      .hs-mc-picker-section-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(44px, 44px));
        gap: 2px;
        padding: 6px;
      }
      .hs-mc-picker-header {
        padding: 8px !important;
        border-bottom: 1px solid rgba(255,255,255,0.08) !important;
        display: block !important;
        visibility: visible !important;
        background: #000 !important;
      }
      .hs-mc-search-wrap {
        position: relative;
        display: flex;
        align-items: center;
      }
      .hs-mc-search-icon {
        position: absolute;
        left: 10px;
        pointer-events: none;
        opacity: 0.4;
      }
      #hs-mc-emote-search {
        width: 100%;
        padding: 8px 12px 8px 32px;
        background: #fff;
        color: #000;
        border: 1px solid #808080;
        border-radius: 0;
        font-size: 13px;
        outline: none;
        box-sizing: border-box;
        transition: border-color 0.15s;
      }
      #hs-mc-emote-search:focus {
        border-color: #ff6b35;
      }
      #hs-mc-emote-search::placeholder {
        color: #808080;
      }
      .hs-mc-picker-emote {
        width: 36px !important;
        height: 36px !important;
        object-fit: contain !important;
        cursor: pointer !important;
        border-radius: 0 !important;
        padding: 4px !important;
        transition: background 0.1s, transform 0.1s;
        display: inline-block !important;
        visibility: visible !important;
      }
      .hs-mc-picker-emote:hover {
        background: rgba(255,107,53,0.15);
        transform: scale(1.15);
      }
      .hs-mc-picker-empty {
        padding: 32px !important;
        text-align: center !important;
        color: #808080 !important;
        font-size: 13px !important;
        visibility: visible !important;
      }
      .hs-mc-picker-divider {
        height: 1px;
        background: rgba(255,255,255,0.06);
        margin: 4px 0;
      }

      /* Emote sizing default */
      :root {
        --hs-emote-size: 32px;
      }

      /* ═══ Twitch menu ═══ */
      .hs-mc-menu-item {
        display: flex !important;
        align-items: center !important;
        gap: 12px !important;
        padding: 10px 14px !important;
        cursor: pointer !important;
        color: #fff !important;
        transition: background 0.15s, border-color 0.15s;
        visibility: visible !important;
        border-left: 3px solid transparent;
        margin: 0 6px;
      }
      .hs-mc-menu-item:hover {
        background: rgba(255,255,255,0.06) !important;
        border-left-color: var(--menu-accent, #ff6b35);
      }
      .hs-mc-menu-item:active {
        background: rgba(255,255,255,0.1) !important;
      }
      .hs-mc-menu-icon {
        width: 36px;
        height: 36px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(255,107,53,0.12);
        background: color-mix(in srgb, var(--menu-accent, #ff6b35) 12%, transparent);
        color: var(--menu-accent, #ff6b35);
        flex-shrink: 0;
        transition: background 0.15s, transform 0.15s;
      }
      .hs-mc-menu-item:hover .hs-mc-menu-icon {
        background: rgba(255,107,53,0.22);
        background: color-mix(in srgb, var(--menu-accent, #ff6b35) 22%, transparent);
        transform: scale(1.08);
      }
      .hs-mc-menu-text {
        flex: 1;
        min-width: 0;
      }
      .hs-mc-menu-title {
        font-size: 13px;
        font-weight: 500;
        color: #fff;
        line-height: 1.3;
      }
      .hs-mc-menu-desc {
        font-size: 11px;
        color: #808080;
        line-height: 1.3;
        margin-top: 1px;
      }
      .hs-mc-menu-item:hover .hs-mc-menu-desc {
        color: #808080;
      }
      .hs-mc-menu-arrow {
        color: #808080;
        flex-shrink: 0;
        transition: color 0.15s, transform 0.15s;
      }
      .hs-mc-menu-item:hover .hs-mc-menu-arrow {
        color: var(--menu-accent, #ff6b35);
        transform: translateX(2px);
      }
      .hs-mc-menu-divider {
        height: 1px;
        background: rgba(255,255,255,0.06);
        margin: 4px 20px;
      }

      /* ═══ Predictions ═══ */
      .hs-mc-pred-loading {
        padding: 20px;
        text-align: center;
        color: #808080;
        font-size: 13px;
      }
      .hs-mc-pred-empty {
        padding: 20px;
        text-align: center;
      }
      .hs-mc-pred-empty-text {
        color: #808080;
        font-size: 13px;
      }
      .hs-mc-prediction {
        padding: 10px 12px;
      }
      .hs-mc-pred-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 6px;
      }
      .hs-mc-pred-title {
        font-size: 13px;
        font-weight: 600;
        color: #fff;
        line-height: 1.3;
        flex: 1;
      }
      .hs-mc-pred-locked {
        font-size: 10px;
        padding: 2px 6px;
        border-radius: 0;
        background: rgba(255,255,255,0.1);
        color: #808080;
        white-space: nowrap;
        flex-shrink: 0;
      }
      .hs-mc-pred-timer {
        font-size: 12px;
        color: #ff6b35;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
        flex-shrink: 0;
      }
      .hs-mc-pred-balance {
        font-size: 12px;
        color: #808080;
        margin-bottom: 8px;
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .hs-mc-pred-outcomes {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .hs-mc-pred-outcome {
        background: rgba(255,255,255,0.04);
        border-radius: 0;
        padding: 8px 10px;
        border-left: 3px solid var(--oc, #387aff);
      }
      .hs-mc-pred-outcome-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 4px;
      }
      .hs-mc-pred-outcome-title {
        font-size: 12px;
        color: #fff;
        font-weight: 500;
      }
      .hs-mc-pred-outcome-pct {
        font-size: 13px;
        font-weight: 700;
        color: var(--oc, #387aff);
        font-variant-numeric: tabular-nums;
      }
      .hs-mc-pred-bar-track {
        height: 4px;
        background: rgba(255,255,255,0.08);
        border-radius: 0;
        overflow: hidden;
        margin-bottom: 4px;
      }
      .hs-mc-pred-bar-fill {
        height: 100%;
        background: var(--oc, #387aff);
        border-radius: 0;
        transition: width 0.3s ease;
      }
      .hs-mc-pred-outcome-stats {
        font-size: 10px;
        color: #808080;
        margin-bottom: 6px;
      }
      .hs-mc-pred-bet-row {
        display: flex;
        gap: 4px;
        align-items: center;
        flex-wrap: wrap;
      }
      .hs-mc-pred-bet-btn {
        background: rgba(255,255,255,0.08);
        border: none;
        color: #808080;
        font-size: 11px;
        padding: 3px 8px;
        border-radius: 0;
        cursor: pointer;
        transition: background 0.15s, color 0.15s;
      }
      .hs-mc-pred-bet-btn:hover {
        background: color-mix(in srgb, var(--oc, #387aff) 30%, transparent);
        color: #fff;
      }
      .hs-mc-pred-bet-btn:disabled {
        opacity: 0.5;
        cursor: default;
      }
      .hs-mc-pred-bet-custom {
        width: 52px;
        background: rgba(255,255,255,0.08);
        border: 1px solid rgba(255,255,255,0.1);
        color: #808080;
        font-size: 11px;
        padding: 2px 6px;
        border-radius: 0;
        outline: none;
      }
      .hs-mc-pred-bet-custom:focus {
        border-color: var(--oc, #387aff);
      }
      .hs-mc-pred-bet-custom::-webkit-inner-spin-button,
      .hs-mc-pred-bet-custom::-webkit-outer-spin-button {
        -webkit-appearance: none;
        margin: 0;
      }
      .hs-mc-pred-bet-go {
        background: var(--oc, #387aff);
        border: none;
        color: #fff;
        font-size: 11px;
        font-weight: 600;
        padding: 3px 10px;
        border-radius: 0;
        cursor: pointer;
        transition: opacity 0.15s;
      }
      .hs-mc-pred-bet-go:hover {
        opacity: 0.85;
      }
      .hs-mc-pred-bet-go:disabled {
        opacity: 0.5;
        cursor: default;
      }
      .hs-mc-pred-links {
        border-top: 1px solid rgba(255,255,255,0.06);
        margin-top: 8px;
        padding-top: 4px;
      }
      .hs-mc-pred-links .hs-mc-menu-item {
        padding: 6px 14px !important;
      }
      .hs-mc-pred-links .hs-mc-menu-icon {
        width: 28px;
        height: 28px;
      }

      /* ═══ Settings tab ═══ */
      .hs-mc-settings-group {
        padding: 4px 0;
      }
      .hs-mc-settings-group + .hs-mc-settings-group {
        border-top: 1px solid rgba(255,255,255,0.06);
      }
      .hs-mc-settings-group-title {
        font-size: 10px;
        font-weight: 600;
        color: #808080;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        padding: 10px 14px 4px;
      }
      .hs-mc-setting-row {
        display: flex !important;
        align-items: center !important;
        justify-content: space-between !important;
        padding: 8px 14px !important;
        font-size: 12px !important;
        color: #fff !important;
        visibility: visible !important;
      }
      .hs-mc-setting-label {
        color: #808080 !important;
        font-size: 13px !important;
      }
      .hs-mc-size-btns {
        display: flex;
        gap: 2px;
        background: #000;
        padding: 2px;
      }
      .hs-mc-size-btn {
        padding: 4px 10px !important;
        background: transparent !important;
        color: #808080 !important;
        border: none !important;
        border-radius: 0 !important;
        font-size: 11px !important;
        cursor: pointer !important;
        display: inline-block !important;
        visibility: visible !important;
        transition: all 0.15s;
      }
      .hs-mc-size-btn:hover {
        background: rgba(255,255,255,0.08) !important;
        color: #fff !important;
      }
      .hs-mc-size-btn.active {
        background: #ff6b35 !important;
        color: #fff !important;
      }
      .hs-mc-toggle-pill {
        position: relative;
        width: 36px;
        height: 20px;
        background: #000;
        border: none;
        border-radius: 0;
        cursor: pointer;
        padding: 0;
        transition: background 0.2s;
        flex-shrink: 0;
      }
      .hs-mc-toggle-pill.active {
        background: #ff6b35;
      }
      .hs-mc-toggle-knob {
        position: absolute;
        top: 3px;
        left: 3px;
        width: 14px;
        height: 14px;
        background: #fff;
        border-radius: 50%;
        transition: transform 0.2s;
        pointer-events: none;
      }
      .hs-mc-toggle-pill.active .hs-mc-toggle-knob {
        transform: translateX(16px);
      }
      .hs-mc-width-row {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      #hs-mc-width-input {
        width: 56px !important;
        padding: 4px 8px !important;
        background: #fff !important;
        color: #000 !important;
        border: 1px solid #808080 !important;
        border-radius: 0 !important;
        font-size: 12px !important;
        -moz-appearance: textfield;
        display: inline-block !important;
        visibility: visible !important;
        transition: border-color 0.15s;
      }
      #hs-mc-width-input:focus {
        border-color: #ff6b35 !important;
      }
      #hs-mc-width-input::-webkit-inner-spin-button,
      #hs-mc-width-input::-webkit-outer-spin-button {
        -webkit-appearance: none;
        margin: 0;
      }
      .hs-mc-settings-unit {
        color: #808080 !important;
        font-size: 11px !important;
      }


      /* Ensure parent has relative positioning for overlay */
      .chat-scrollable-area__message-container {
        position: relative !important;
      }

      /* Parent of scrollable area needs proper sizing for absolute overlay */
      [class*="chat-room"] [class*="scrollable-area"] {
        position: relative !important;
      }

      /* Hide Twitch's native tab arrows when our tabs are present */
      #hs-mc-tabbar ~ [class*="tabs-buttons"],
      [class*="chat-header__tabs-buttons"],
      [class*="tabs__scroll-button"],
      .chat-room__content [class*="scroll-button"] {
        display: none !important;
      }

      /* Hide leaderboard carousel arrows */
      [aria-label="Previous leaderboard set"],
      [aria-label="Next leaderboard set"],
      .channel-leaderboard-header-rotating__users ~ button,
      [class*="channel-leaderboard"] button[aria-label*="leaderboard"] {
        display: none !important;
      }

      /* Rotation button styling */
      .hs-mc-rotate {
        margin-left: auto;
        background: #000 !important;
        font-weight: bold;
      }
      .hs-mc-rotate:hover {
        background: #9147ff !important;
      }

      /* RIGHT SIDE TABS LAYOUT - absolute position at right edge */
      .hs-tabs-right #hs-mc-tabbar {
        position: absolute !important;
        left: auto !important;
        right: 0 !important;
        top: 0 !important;
        bottom: 0 !important;
        width: 90px;
        flex-direction: column;
        flex-shrink: 0;
        padding: 4px;
        gap: 2px;
        border-bottom: none;
        border-left: 1px solid #fff;
        border-radius: 0;
        background: #000;
        overflow-y: auto;
        z-index: 1001;
      }
      .hs-tabs-right .hs-mc-tab {
        padding: 4px 6px;
        font-size: 11px;
        min-width: auto;
        width: 100%;
        text-align: center;
        box-sizing: border-box;
        flex: 0 0 auto;
      }
      .hs-tabs-right .hs-mc-rotate {
        margin-left: 0;
        margin-top: auto;
      }
      .hs-tabs-right #hs-mc-overlay {
        top: 0;
        left: 0;
        right: 90px;
        bottom: 52px;
      }
      .hs-tabs-right #hs-mc-inputbar {
        left: 0;
        right: 90px;
        z-index: 1002;
      }
      .hs-tabs-right #hs-mc-emote-picker {
        left: 0;
        right: 90px;
      }

      /* BOTTOM TABS LAYOUT */
      .hs-tabs-bottom #hs-mc-tabbar {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 52px;
        top: auto;
        padding: 6px 10px;
        border-top: 1px solid #fff;
        border-bottom: none;
        z-index: 1001;
      }
      .hs-tabs-bottom #hs-mc-overlay {
        top: 0;
        bottom: 90px; /* tab bar + input bar */
      }
      .hs-tabs-bottom #hs-mc-emote-picker {
        bottom: 90px; /* tab bar + input bar */
      }

      /* LEFT SIDE TABS LAYOUT - flex child, no fixed positioning */
      .hs-tabs-left #hs-mc-tabbar {
        position: relative !important;
        left: auto !important;
        right: auto !important;
        top: auto !important;
        bottom: auto !important;
        width: 90px;
        flex-direction: column;
        flex-shrink: 0;
        order: -1;
        padding: 4px;
        gap: 2px;
        border-bottom: none;
        border-right: 1px solid #fff;
        border-radius: 0;
        background: #000;
        overflow-y: auto;
      }
      .hs-tabs-left .hs-mc-tab {
        padding: 4px 6px;
        font-size: 11px;
        min-width: auto;
        width: 100%;
        text-align: center;
        box-sizing: border-box;
        flex: 0 0 auto;
      }
      .hs-tabs-left .hs-mc-rotate {
        margin-left: 0;
        margin-top: auto;
      }
      .hs-tabs-left #hs-mc-overlay {
        top: 0;
        left: 90px;
        right: 0;
        bottom: 52px;
      }
      .hs-tabs-left #hs-mc-inputbar {
        left: 90px;
        right: 0;
        z-index: 1002;
      }
      .hs-tabs-left #hs-mc-emote-picker {
        left: 90px;
        right: 0;
      }

      /* Popout mode - full width (respects tab bar position) */
      .hs-popout #hs-mc-overlay {
        left: 0 !important;
        right: 0 !important;
        width: auto !important;
      }
      .hs-popout #hs-mc-inputbar {
        left: 0 !important;
        right: 0 !important;
        width: auto !important;
      }
      .hs-popout #hs-mc-resize-handle {
        display: none !important;
      }
      .hs-popout #hs-mc-emote-picker {
        left: 0 !important;
        right: 0 !important;
      }
      /* Popout with tabs on right - adjust for tab bar */
      .hs-popout.hs-tabs-right #hs-mc-overlay {
        right: 90px !important;
      }
      .hs-popout.hs-tabs-right #hs-mc-inputbar {
        right: 90px !important;
      }
      .hs-popout.hs-tabs-right #hs-mc-emote-picker {
        right: 90px !important;
      }
      /* Popout with tabs on left */
      .hs-popout.hs-tabs-left #hs-mc-overlay {
        left: 90px !important;
      }
      .hs-popout.hs-tabs-left #hs-mc-inputbar {
        left: 90px !important;
      }
      .hs-popout.hs-tabs-left #hs-mc-emote-picker {
        left: 90px !important;
      }

      /* ---- FEED MESSAGE CARDS ---- */
      .hs-feed-msg {
        padding: 8px 12px;
        border-bottom: 1px solid #808080;
        transition: background 0.1s;
      }
      .hs-feed-msg:hover {
        background: rgba(255,255,255,0.04);
      }
      .hs-feed-header {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-bottom: 4px;
      }
      .hs-feed-avatar {
        width: 20px;
        height: 20px;
        border-radius: 50%;
        flex-shrink: 0;
      }
      .hs-feed-user {
        font-weight: 600;
        font-size: 13px;
        color: #fff;
        text-decoration: none;
      }
      .hs-feed-user:hover {
        text-decoration: underline;
      }
      .hs-feed-time {
        font-size: 11px;
        color: #808080;
        margin-left: auto;
      }
      .hs-feed-body {
        font-size: 13px;
        color: #fff;
        line-height: 1.4;
        word-wrap: break-word;
        word-break: break-word;
      }
      .hs-feed-stats {
        display: flex;
        gap: 12px;
        margin-top: 4px;
        font-size: 11px;
        color: #808080;
      }
      .hs-feed-stat {
        cursor: default;
      }
      .hs-feed-reply {
        margin-left: 16px;
        border-left: 2px solid #808080;
        padding-left: 8px;
      }
      .hs-feed-loader {
        cursor: default;
        font-size: 12px;
      }

      /* ---- NOTIFICATIONS ---- */
      .hs-notif {
        padding: 10px 12px;
        border-bottom: 1px solid #808080;
        cursor: pointer;
        transition: background 0.1s;
      }
      .hs-notif:hover {
        background: rgba(255,255,255,0.04);
      }
      .hs-notif-header {
        padding: 8px 12px;
        font-size: 12px;
        color: #ff6b35;
        border-bottom: 1px solid #808080;
      }

      /* ---- TAB BADGE ---- */
      .hs-mc-tab .hs-badge {
        background: #ff6b35;
        color: #fff;
        border-radius: 50%;
        font-size: 10px;
        min-width: 14px;
        height: 14px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        margin-left: 4px;
        padding: 0 3px;
      }

      /* ---- KICK NATIVE CHAT HIDING ---- */
      .hs-native-hidden .chat-entry-list,
      .hs-native-hidden [class*="chat-entry-list"],
      .hs-native-hidden [class*="chatroom-footer"],
      .hs-native-hidden [class*="chat-input"] {
        display: none !important;
      }
      .hs-native-hidden#chatroom > *:not(#hs-mc-container) {
        display: none !important;
      }

      /* Prevent channel accent color bleed on offline/home pages */
      .channel-root--home {
        background-color: #000 !important;
      }
      .root-scrollable__content {
        background: #000;
      }
      /* Collapsed chat rules moved to injectStyles() so they're always active */
    `;
    document.head.appendChild(style);
  }

  // ============================================
  // RENDER PATCHING (FFZ-STYLE CORE)
  // ============================================

  /**
   * Patch a component's render method to inject our UI
   * This is the FFZ approach - modify render output, don't manipulate DOM
   */
  function patchChatRoomRender(component) {
    if (!component?.instance?.render) {
      log('Cannot patch - no render method');
      return false;
    }

    const inst = component.instance;
    if (inst._hs_multichat_patched) {
      log('Already patched');
      return true;
    }

    originalRender = inst.render.bind(inst);

    inst.render = function() {
      const result = originalRender();

      // If result is null or not an object, return as-is
      if (!result || typeof result !== 'object') return result;

      // Clone the result to avoid mutating React's internals
      // We'll inject our tab bar at the top level
      // Elements are in #hs-mc-container (outside React's tree)
      // so no need to re-inject on every render

      return result;
    };

    inst._hs_multichat_patched = true;
    log('✅ Patched chat room render');

    // Force initial re-render
    if (typeof inst.forceUpdate === 'function') {
      inst.forceUpdate();
    }

    return true;
  }

  /**
   * FFZ-style: Fix chat column transform bug
   * Twitch applies translateX(-34rem) even when --expanded class is set
   * We fix this persistently via multiple layers
   */

  // Layer 1: CSS override (always active, catches most cases)
  function injectTransformOverrideCss() {
    if (document.getElementById('hs-chat-transform-fix')) return;
    const style = document.createElement('style');
    style.id = 'hs-chat-transform-fix';
    style.textContent = `
      /* Fix inner column transform — must be 'none', not translateX(0),
         because any transform value creates a containing block that breaks
         position:fixed on descendant elements (tab bar goes off-screen) */
      .channel-root__right-column--expanded {
        transform: none !important;
      }
      /* Fix collapse/expand arrow — Twitch applies translateX(-340px) to
         slide it with the chat panel animation, but our layout changes make
         the transform wrong. Kill both transform and its transition (the
         transition fights !important by interpolating from the old value). */
      .right-column__toggle-visibility {
        transform: none !important;
        transition: none !important;
      }
    `;
    document.head.appendChild(style);
    log('✅ Injected chat column CSS fixes');
  }

  // Fix inline transform that Twitch's CSS-in-JS sets on the inner column.
  // CSS rule handles the class-based override; this catches inline style overrides.
  function fixChatTransform() {
    const expanded = document.querySelector('.channel-root__right-column--expanded');
    if (!expanded) return false;

    const transform = expanded.style.transform || getComputedStyle(expanded).transform;
    if (transform && transform !== 'none') {
      expanded.style.setProperty('transform', 'none', 'important');
      return true;
    }
    return false;
  }

  // Layer 3: Watch for class/style changes on BOTH column elements
  let columnObserver = null;
  function startColumnClassWatcher() {
    if (columnObserver) return; // Already watching

    const inner = document.querySelector('.channel-root__right-column');
    const outer = document.querySelector('.right-column.right-column--beside');

    if (!inner && !outer) return;

    columnObserver = cleanup.trackObserver(new MutationObserver(() => {
      // When class/style changes, fix both elements
      cleanup.raf(() => {
        fixChatTransform();
        applyChatWidth()
      }, 'column-transform-fix');
    }), 'column-class-watcher');

    const config = { attributes: true, attributeFilter: ['class', 'style'] };

    if (inner) columnObserver.observe(inner, config);
    if (outer) columnObserver.observe(outer, config);

    log('✅ Started column watchers (inner + outer)');
  }

  // Polling removed — CSS rule + MutationObserver handle all cases.
  // The 500ms polling was redundant and caused layout fighting.

  function ensureChatColumnVisible() {
    // CSS override + observer (no polling, no parent walking)
    injectTransformOverrideCss();
    startColumnClassWatcher();

    // One-time fix for current state
    fixChatTransform();

    // Return the chat column for injection purposes
    return document.querySelector('[data-a-target="right-column-chat-bar"]') ||
           document.querySelector('.channel-root__right-column');
  }

  /**
   * Alternative approach: Use MutationObserver + strategic element injection
   * This is more reliable than render patching for layout elements
   */
  /**
   * Get or create the HeatSync container OUTSIDE React's DOM tree.
   * Placed as a sibling of chatRoom so React can't destroy our elements.
   */
  function getOrCreateHsContainer(chatRoom) {
    let container = document.getElementById('hs-mc-container')
    if (container && document.contains(container)) return container
    container = document.createElement('div')
    container.id = 'hs-mc-container'
    // Insert directly into chat-shell (which has proper dimensions from Twitch)
    // rather than deep in the tree where intermediate divs collapse to 0 height
    const chatShell = document.querySelector('.chat-shell') || document.querySelector('[class*="chat-shell"]')
    const parent = chatShell || chatRoom.parentElement
    parent.appendChild(container)
    log('Created #hs-mc-container in', parent.tagName + '.' + [...parent.classList].join('.'))
    return container
  }

  function ensureUIElements() {
    // Always watch for collapse/expand class changes so we can clean up
    // inline styles when the user clicks the expand arrow
    startColumnClassWatcher();

    // Don't fight Twitch when chat is collapsed — let the native expand arrow work
    const rightCol = document.querySelector('.right-column')
    const collapsed = rightCol && rightCol.classList.contains('right-column--collapsed')

    if (collapsed) return

    // Make sure chat column is visible (only when expanded)
    ensureChatColumnVisible();

    // Find the React-controlled chat room
    const chatRoom = isKick
      ? (document.getElementById('chatroom') || document.querySelector('[class*="chatroom"]'))
      : (document.querySelector('[class*="chat-room__content"]') ||
         document.querySelector('[data-a-target="chat-room-component"]') ||
         document.querySelector('.chat-shell') ||
         document.querySelector('[class*="stream-chat"]') ||
         document.querySelector('.chat-room'));

    if (!chatRoom) return;

    // Transform fix handled by CSS (#hs-chat-transform-fix) + MutationObserver.
    // No parent tree walking — it displaced the collapse arrow.

    // Get our container outside React's tree
    const container = getOrCreateHsContainer(chatRoom)

    // Ensure tab bar exists
    if (!tabBarElement || !document.contains(tabBarElement)) {
      const existing = document.getElementById('hs-mc-tabbar');
      if (existing) {
        tabBarElement = existing;
        log('Reclaimed existing tab bar');
      } else {
        tabBarElement = createTabBar();
        updateTabBar();
        if (!liveStatusInterval) startLiveStatusPolling();
        log('Created tab bar');
      }
    }
    if (!container.contains(tabBarElement)) {
      container.insertBefore(tabBarElement, container.firstChild);
      log('Inserted tab bar into container');
    }

    // Ensure overlay exists
    if (!overlayElement || !document.contains(overlayElement)) {
      const existing = document.getElementById('hs-mc-overlay');
      if (existing) {
        overlayElement = existing;
        log('Reclaimed existing overlay');
      } else {
        overlayElement = createOverlay();
        log('Created overlay');
      }
    }
    if (!container.contains(overlayElement)) {
      container.appendChild(overlayElement);
      log('Injected overlay into container');
    }

    // Ensure emote picker panel exists (between overlay and inputbar)
    let pickerEl = document.getElementById('hs-mc-emote-picker');
    if (!pickerEl) {
      pickerEl = document.createElement('div');
      pickerEl.id = 'hs-mc-emote-picker';
    }
    if (!container.contains(pickerEl)) {
      container.appendChild(pickerEl);
    }

    // Ensure input bar exists
    if (!inputBarElement || !document.contains(inputBarElement)) {
      inputBarElement = createInputBar();
      log('Created input bar');
    }
    if (!container.contains(inputBarElement)) {
      container.appendChild(inputBarElement);
      log('Injected input bar into container');

      // Restore pending message if any
      const input = document.getElementById('hs-mc-input');
      if (input && pendingMessage) {
        input.value = pendingMessage;
      }
    }

    // Sync overlay top with tabbar height (handles wrapped tabs)
    // Skip for vertical tabs — CSS handles positioning
    if (tabBarElement && overlayElement && !resizeObserver) {
      resizeObserver = new ResizeObserver(() => {
        if (!tabBarElement || !overlayElement) return
        if (tabPosition === 'left' || tabPosition === 'right') {
          overlayElement.style.top = '0';
          return;
        }
        const h = tabBarElement.getBoundingClientRect().height;
        if (h > 0) overlayElement.style.top = h + 'px';
      });
      resizeObserver.observe(tabBarElement);
      cleanup.trackObserver(resizeObserver);
      if (tabPosition !== 'left' && tabPosition !== 'right') {
        const h = tabBarElement.getBoundingClientRect().height;
        if (h > 0) overlayElement.style.top = h + 'px';
      }
    }

    // Auto-show overlay if not already visible
    if (overlayElement && !overlayElement.classList.contains('visible')) {
      overlayElement.classList.add('visible');
      if (!currentTab) {
        currentTab = 'live';
        if (tabBarElement) {
          tabBarElement.querySelectorAll('.hs-mc-tab').forEach(t => {
            t.classList.toggle('active', t.dataset.tab === 'live');
          });
        }
      }
      renderMessages(currentTab);
      log('Auto-showed overlay on load');
    }

    // Ensure resize handle exists on right column edge (Twitch only)
    if (!isKick) {
      setupResizeHandle()
    }

    // Always ensure native chat is hidden when our UI is active
    if (!(isKick && currentTab === 'live')) {
      setNativeChatHidden(true);
    }
  }

  // ============================================
  // SOCIAL TABS (FEED & NOTIFICATIONS)
  // ============================================

  // API proxy — routes through background.js to bypass CORS + attach auth
  function apiFetch(path, opts = {}) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({
          type: 'api_fetch',
          path,
          method: opts.method || 'GET',
          auth: opts.auth !== false,
          body: opts.body
        }, (resp) => resolve(resp || { ok: false, error: 'no response' }));
      } catch (e) {
        resolve({ ok: false, error: 'context invalidated' });
      }
    });
  }

  // Load heatsync auth state from storage
  async function loadHsAuth() {
    try {
      const data = await chrome.storage.local.get(['auth_token_encrypted', 'auth_token']);
      hsAuthToken = !!(data.auth_token_encrypted || data.auth_token);
      log('Heatsync auth:', hsAuthToken ? 'logged in' : 'anonymous');
    } catch (e) {
      hsAuthToken = false;
    }

    // Watch for auth changes (login/logout on heatsync.org)
    if (!window._hsMcAuthWatcher) {
      window._hsMcAuthWatcher = true;
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes.auth_token_encrypted || changes.auth_token) {
          const wasAuthed = hsAuthToken;
          hsAuthToken = !!(
            changes.auth_token_encrypted?.newValue ||
            changes.auth_token?.newValue
          );
          if (wasAuthed !== hsAuthToken) {
            log('Auth state changed:', hsAuthToken ? 'logged in' : 'logged out');
            // Reset feed/notif data on auth change
            feedLoaded = false;
            feedMessages = [];
            notifLoaded = false;
            notifMessages = [];
            unreadNotifCount = 0;
            updateNotifBadge();
            if (currentTab === 'feed' || currentTab === 'notifs') {
              renderMessages(currentTab);
            }
          }
        }
      });
    }
  }

  // Listen for social events from background (new messages, notifications)
  function listenForSocialEvents() {
    // Guard: only register once (survives SPA reinit via chrome listener persistence)
    if (window._hsMcSocialListener) return;
    window._hsMcSocialListener = true;

    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === 'new-message' && msg.data) {
        if (!feedLoaded) return;
        // Dedup: skip if already in feed
        const id = msg.data.base36_id;
        if (id && feedMessages.some(m => m.base36_id === id)) return;

        feedMessages.unshift(msg.data);
        if (feedMessages.length > 150) feedMessages.pop();

        if (currentTab === 'feed') {
          renderFeed();
        } else {
          updateTabIndicator('feed');
        }
      }
      if (msg.type === 'youtube_chat_message') {
        // Bidirectional dedup: skip if we already displayed this message from either source
        if (isYtDuplicate(msg.user, msg.text)) return

        // Track for dedup (both server and content script messages)
        trackYtServerMsg(msg.user, msg.text)

        const ytMsg = {
          user: msg.user,
          text: msg.text,
          color: msg.color || '#ff0000',
          channel: 'youtube',
          time: msg.time,
          platform: 'youtube',
          emotes: msg.emotes || [],
          msgType: msg.msgType || 'text',
          amount: msg.amount || '',
          scColor: msg.scColor || '',
          sticker: msg.sticker || null,
        }

        const targetChannelId = msg.channelId
        if (targetChannelId && targetChannelId !== 'global') {
          // Per-channel YouTube → route to that channel tab
          if (!channelYtMessages.has(targetChannelId)) channelYtMessages.set(targetChannelId, [])
          const buf = channelYtMessages.get(targetChannelId)
          buf.push(ytMsg)
          if (buf.length > MAX_BUFFER + 50) buf.splice(0, buf.length - MAX_BUFFER)
          if (currentTab === targetChannelId) {
            appendMessage(ytMsg, targetChannelId) || renderMessages(currentTab)
          } else {
            updateTabIndicator(targetChannelId)
          }
        }
      }
      if (msg.type === 'youtube_status') {
        const targetChannelId = msg.channelId
        if (targetChannelId && targetChannelId !== 'global') {
          // Per-channel YouTube status
          const link = youtubeLinks.get(targetChannelId) || { url: '', videoId: '', channelName: '' }
          if (msg.status === 'connected') {
            link.videoId = msg.videoId || ''
            link.channelName = msg.channelName || ''
            youtubeLinks.set(targetChannelId, link)
            log('YouTube connected for channel', targetChannelId, ':', link.channelName)
          }
          // Show status in channel tab if viewing it
          if (currentTab === targetChannelId) {
            const msgsEl = document.getElementById('hs-mc-messages')
            if (msgsEl && msg.status === 'connected' && !(channelYtMessages.get(targetChannelId)?.length)) {
              const el = document.createElement('div')
              el.className = 'hs-mc-empty'
              el.textContent = 'youtube connected: ' + (link.channelName || msg.videoId) + ' — waiting for messages...'
              msgsEl.appendChild(el)
              trimChildren(msgsEl, 150)
            } else if (msgsEl && (msg.status === 'ended' || msg.status === 'error')) {
              const el = document.createElement('div')
              el.className = 'hs-mc-empty'
              el.textContent = msg.status === 'ended' ? 'youtube stream ended' : (msg.error || 'youtube connection error')
              el.style.color = '#ff4444'
              msgsEl.appendChild(el)
              trimChildren(msgsEl, 150)
            }
          }
        }
      }
      if (msg.type === 'notification:new') {
        unreadNotifCount++;
        updateNotifBadge();
        if (currentTab === 'notifs') {
          notifLoaded = false;
          renderNotifs();
        }
      }
    });
  }

  // Update notif tab badge (reuse existing element to avoid DOM churn)
  function updateNotifBadge() {
    if (!tabBarElement) return
    const tab = tabBarElement.querySelector('[data-tab="notifs"]')
    if (!tab) return
    let badge = tab.querySelector('.hs-badge')
    if (unreadNotifCount > 0) {
      if (!badge) {
        badge = document.createElement('span')
        badge.className = 'hs-badge'
        tab.appendChild(badge)
      }
      badge.textContent = unreadNotifCount > 99 ? '99+' : unreadNotifCount
    } else if (badge) {
      badge.remove()
    }
  }

  // ---- FEED ----

  async function fetchFeed(append = false) {
    if (feedLoading) return;
    feedLoading = true;
    const page = append ? feedPage + 1 : 1;
    const resp = await apiFetch(`/api/messages?sort=time&limit=30&page=${page}`, { auth: false });
    feedLoading = false;
    if (!resp.ok) {
      log('Feed fetch failed:', resp.status || resp.error);
      if (currentTab === 'feed') {
        const msgsEl = document.getElementById('hs-mc-messages');
        if (msgsEl && feedMessages.length === 0) {
          msgsEl.innerHTML = `<div class="hs-mc-empty">failed to load feed${resp.status === 401 ? ' — log in at heatsync.org' : ''}</div>`;
        }
      }
      return;
    }
    const msgs = resp.data?.messages || [];
    if (append) {
      feedMessages.push(...msgs);
      feedPage = page;
    } else {
      feedMessages = msgs;
      feedPage = 1;
    }
    feedHasMore = resp.data?.pagination?.hasMore ?? msgs.length >= 30;
    feedLoaded = true;
    feedLastFetch = Date.now();
    if (currentTab === 'feed') renderFeed();
  }

  function renderFeed() {
    const msgsEl = document.getElementById('hs-mc-messages');
    if (!msgsEl) return;

    // Feed is public — no auth required to view, only to post
    const isStale = feedLoaded && (Date.now() - feedLastFetch > FEED_STALE_MS);
    if ((!feedLoaded || isStale) && !feedLoading) {
      msgsEl.innerHTML = '<div class="hs-mc-empty">loading feed...</div>';
      fetchFeed();
      return;
    }

    if (feedMessages.length === 0) {
      msgsEl.innerHTML = '<div class="hs-mc-empty">no posts yet</div>';
      return;
    }

    isProgrammaticScroll = true;
    msgsEl.textContent = '';
    const frag = document.createDocumentFragment();
    const feedToRender = feedMessages.slice(-150);
    for (const m of feedToRender) {
      frag.appendChild(buildFeedMessageDiv(m));
      // If this message is expanded, show thread replies
      if (expandedThreadId === m.base36_id && threadReplies.length > 0) {
        for (const r of threadReplies) {
          const replyDiv = buildFeedMessageDiv(r);
          replyDiv.classList.add('hs-feed-reply');
          frag.appendChild(replyDiv);
        }
      }
    }
    if (feedHasMore) {
      const loader = document.createElement('div');
      loader.className = 'hs-mc-empty hs-feed-loader';
      loader.textContent = 'scroll for more...';
      frag.appendChild(loader);
    }
    msgsEl.appendChild(frag);

    // Feed scrolls to top (newest-first), not bottom like IRC
    isProgrammaticScroll = true;
    msgsEl.scrollTop = 0;
    requestAnimationFrame(() => { isProgrammaticScroll = false; });

    // Setup infinite scroll
    if (!msgsEl._hsFeedScroll) {
      msgsEl._hsFeedScroll = true;
      let feedScrollTimer = null
      msgsEl.addEventListener('scroll', () => {
        if (mcSignal?.aborted) return;
        if (currentTab !== 'feed' || feedLoading || !feedHasMore) return;
        if (feedScrollTimer) return // Throttle: one check per 200ms
        feedScrollTimer = cleanup.setTimeout(() => {
          feedScrollTimer = null
          const { scrollTop, scrollHeight, clientHeight } = msgsEl;
          if (scrollHeight - scrollTop - clientHeight < 100) {
            fetchFeed(true);
          }
        }, 200)
      });
    }
  }

  function buildFeedMessageDiv(m) {
    const div = document.createElement('div');
    div.className = 'hs-feed-msg';
    div.dataset.msgId = m.base36_id;

    const time = formatRelativeTime(m.created_at);
    const avatarUrl = `https://heatsync.org/api/avatar/${encodeURIComponent(m.username)}`;
    const heat = m.heat || 0;
    const replies = m.reply_count || 0;
    const content = renderFeedContent(m.content, m.emote_refs);

    // Safe: avatarUrl from our API, username/time through escapeHtml, content through renderFeedContent
    div.innerHTML = `
      <div class="hs-feed-header">
        <img class="hs-feed-avatar" src="${avatarUrl}" alt="" loading="lazy" onerror="this.style.display='none'">
        <a href="https://heatsync.org/u/${encodeURIComponent(m.username)}" target="_blank" class="hs-feed-user" style="color:${sanitizeColor(m.user_color || '#fff')}">${escapeHtml(m.username || 'anon')}</a>
        <span class="hs-feed-time">${escapeHtml(time)}</span>
      </div>
      <div class="hs-feed-body">${content}</div>
      <div class="hs-feed-stats">
        <span class="hs-feed-stat" title="heat">${heat > 0 ? '🔥 ' + heat : ''}</span>
        <span class="hs-feed-stat hs-feed-replies" title="replies">${replies > 0 ? '💬 ' + replies : ''}</span>
      </div>
    `;

    // Click replies to expand thread
    const repliesEl = div.querySelector('.hs-feed-replies');
    if (repliesEl && replies > 0) {
      repliesEl.style.cursor = 'pointer';
      repliesEl.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleThread(m.base36_id);
      });
    }

    return div;
  }

  function renderFeedContent(content, emoteRefs) {
    if (!content) return '';
    let html = escapeHtml(String(content));
    // Render emote refs as inline images
    if (emoteRefs && typeof emoteRefs === 'object') {
      for (const [name, url] of Object.entries(emoteRefs)) {
        const escaped = escapeHtml(name);
        const safeUrl = escapeHtml(url);
        html = html.replace(
          new RegExp(`\\b${escaped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'),
          `<img class="hs-mc-emote" src="${safeUrl}" alt="${escaped}" title="${escaped}" loading="lazy">`
        );
      }
    }
    return html;
  }

  function formatRelativeTime(isoDate) {
    if (!isoDate) return '';
    const diff = Date.now() - new Date(isoDate).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'now';
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    return `${days}d`;
  }

  async function toggleThread(msgId) {
    if (expandedThreadId === msgId) {
      expandedThreadId = null;
      threadReplies = [];
      renderFeed();
      return;
    }
    expandedThreadId = msgId;
    threadReplies = [];
    renderFeed(); // Show loading state

    const resp = await apiFetch(`/api/messages/${msgId}/replies`);
    if (resp.ok) {
      threadReplies = resp.data?.replies || [];
    }
    renderFeed();
  }

  async function postFeedMessage(text) {
    const input = document.getElementById('hs-mc-input');
    if (!input) return;

    if (!hsAuthToken) {
      if (wysiwygEnabled) {
        input.dataset.placeholder = 'log in at heatsync.org first';
      } else {
        input.placeholder = 'log in at heatsync.org first';
      }
      setTimeout(() => updateInputPlaceholder(), 2000);
      return;
    }

    const body = { content: text };
    // If replying to an expanded thread, set reply_to
    if (expandedThreadId) {
      body.reply_to = expandedThreadId;
    }

    const resp = await apiFetch('/api/messages', { method: 'POST', auth: true, body });
    if (resp.ok) {
      if (wysiwygEnabled) {
        input.innerHTML = '';
      } else {
        input.value = '';
      }
      pendingMessage = '';
      updateCharCount();
      // Message will appear via WebSocket real-time
    } else {
      input.style.borderColor = '#f44';
      const errMsg = resp.status === 401 ? 'log in first'
        : resp.status === 429 ? 'slow down'
        : resp.status === 409 ? 'duplicate message'
        : 'failed to post';
      showToast(errMsg);
      setTimeout(() => { input.style.borderColor = ''; }, 1500);
      log('Post failed:', resp.status || resp.error);
    }
  }

  // ---- NOTIFICATIONS ----

  async function fetchNotifications() {
    try {
      const resp = await apiFetch('/api/notifications');
      if (resp.ok) {
        notifications = resp.data || { mentions: 0, op_replies: 0, re_replies: 0, total: 0 };
        unreadNotifCount = notifications.total || 0;
        updateNotifBadge();
      } else if (resp.status === 401) {
        notifLoaded = true;
        return; // Not logged in
      }
      // Fetch actual notification messages (mentions, op replies, re replies)
      const msgResp = await apiFetch('/api/messages?filter_type=mentions&limit=20');
      if (msgResp.ok) {
        notifMessages = msgResp.data?.messages || [];
      }
    } catch (e) {
      log('Notification fetch error:', e);
    }
    notifLoaded = true;
  }

  function renderNotifs() {
    const msgsEl = document.getElementById('hs-mc-messages');
    if (!msgsEl) return;

    if (!hsAuthToken) {
      msgsEl.innerHTML = '<div class="hs-mc-empty">log in at <a href="https://heatsync.org" target="_blank" style="color:#ff6b35">heatsync.org</a> to see notifications</div>';
      return;
    }

    if (!notifLoaded) {
      msgsEl.innerHTML = '<div class="hs-mc-empty">loading notifications...</div>';
      fetchNotifications().then(() => {
        if (currentTab === 'notifs') renderNotifs();
      });
      return;
    }

    // Mark as read when viewing
    if (unreadNotifCount > 0) {
      apiFetch('/api/notifications/mark-read', { method: 'POST', body: { type: 'all' } });
      unreadNotifCount = 0;
      updateNotifBadge();
      try { chrome.runtime.sendMessage({ type: 'notifs_viewed' }); } catch (e) {}
    }

    if (notifMessages.length === 0) {
      msgsEl.innerHTML = '<div class="hs-mc-empty">no notifications</div>';
      return;
    }

    msgsEl.textContent = '';
    const frag = document.createDocumentFragment();

    // Summary header
    if (notifications.total > 0) {
      const header = document.createElement('div');
      header.className = 'hs-notif-header';
      const parts = [];
      if (notifications.mentions > 0) parts.push(`${notifications.mentions} mention${notifications.mentions > 1 ? 's' : ''}`);
      if (notifications.op_replies > 0) parts.push(`${notifications.op_replies} OP repl${notifications.op_replies > 1 ? 'ies' : 'y'}`);
      if (notifications.re_replies > 0) parts.push(`${notifications.re_replies} RE repl${notifications.re_replies > 1 ? 'ies' : 'y'}`);
      header.textContent = parts.join(', ');
      frag.appendChild(header);
    }

    const notifsToRender = notifMessages.slice(-150);
    for (const m of notifsToRender) {
      const div = buildNotifDiv(m);
      frag.appendChild(div);
    }
    msgsEl.appendChild(frag);
  }

  function buildNotifDiv(m) {
    const div = document.createElement('div');
    div.className = 'hs-notif';
    const time = formatRelativeTime(m.created_at);
    const content = escapeHtml((m.content || '').slice(0, 120));

    div.innerHTML = `
      <div class="hs-feed-header">
        <a href="https://heatsync.org/u/${encodeURIComponent(m.username)}" target="_blank" class="hs-feed-user" style="color:${sanitizeColor(m.user_color || '#fff')}">${escapeHtml(m.username || 'anon')}</a>
        <span class="hs-feed-time">${escapeHtml(time)}</span>
      </div>
      <div class="hs-feed-body">${content}</div>
    `;

    // Click to switch to feed and show this thread
    div.addEventListener('click', () => {
      const threadId = m.reply_to || m.base36_id;
      expandedThreadId = threadId;
      threadReplies = [];
      switchTab('feed');
      // Fetch thread after switching
      toggleThread(threadId);
    });

    return div;
  }

  // ============================================
  // TAB/CHANNEL MANAGEMENT
  // ============================================

  function switchTab(id) {
    log('switchTab called:', id);

    // Reset expanded thread when leaving feed
    if (currentTab === 'feed' && id !== 'feed') {
      expandedThreadId = null;
      threadReplies = [];
    }

    currentTab = id;

    // Mark mentions/posts as seen when switching to those tabs
    if (id === 'mentions') {
      mentionsSeenCount = mentionsBuffer.length;
      updateTabBadges();
    } else if (id === 'posts') {
      postsSeenCount = postsBuffer.length;
      updateTabBadges();
    }

    // Persist active tab across refreshes/popouts (skip transient tabs)
    if (id !== 'add') {
      chrome.storage.local.get(['ui_settings']).then(stored => {
        const settings = stored.ui_settings || {};
        settings.activeTab = id;
        chrome.storage.local.set({ ui_settings: settings });
      }).catch(() => {})
    }

    // Update tab bar active state
    if (tabBarElement) {
      tabBarElement.querySelectorAll('.hs-mc-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.tab === id);
        if (t.dataset.tab === id) {
          t.classList.remove('has-new');
        }
      });
    }

    // Reset scroll state BEFORE rendering - always start at bottom when switching tabs
    isScrolledUp = false;
    newMessageCount = 0;
    const newBtn = document.getElementById('hs-mc-new-msgs');
    if (newBtn) newBtn.style.display = 'none';

    // Kick live tab: show native chat, hide overlay + our input
    if (isKick && id === 'live') {
      setNativeChatHidden(false);
      if (overlayElement) overlayElement.classList.remove('visible');
      if (inputBarElement) inputBarElement.style.display = 'none';
      return;
    }

    // Hide input bar on add-channel form, show for everything else
    if (inputBarElement) inputBarElement.style.display = id === 'add' ? 'none' : '';

    if (overlayElement) {
      overlayElement.classList.add('visible');
      renderMessages(id);
    } else {
      log('No overlay element to show!');
    }

    // Update input placeholder for new tab
    updateInputPlaceholder();

    // Hide native chat when our overlay is active
    setNativeChatHidden(true);
  }

  /**
   * Toggle native Twitch chat visibility (FFZ-style)
   * Adds class to parent container rather than relying on :has() selector
   */
  function setNativeChatHidden(hidden) {
    if (isKick) {
      // Kick selectors
      const chatroom = document.getElementById('chatroom') ||
                       document.querySelector('[class*="chatroom"]');
      if (chatroom) chatroom.classList.toggle('hs-native-hidden', hidden);
      return;
    }

    // Twitch: Add class to chat-shell (outermost container)
    const chatShell = document.querySelector('.chat-shell') ||
                      document.querySelector('[class*="chat-shell"]');
    if (chatShell) {
      chatShell.classList.toggle('hs-native-hidden', hidden);
    }

    // Add class to chat-room__content (where our elements are injected)
    const chatRoom = document.querySelector('[class*="chat-room__content"]') ||
                     document.querySelector('[data-a-target="chat-room-component"]');
    if (chatRoom) {
      chatRoom.classList.toggle('hs-native-hidden', hidden);
    }

    // Also try stream-chat for popout mode
    const streamChat = document.querySelector('.stream-chat') ||
                       document.querySelector('[class*="stream-chat"]');
    if (streamChat) {
      streamChat.classList.toggle('hs-native-hidden', hidden);
    }
  }

  function updateTabBadges() {
    if (!tabBarElement) return;
    const mentionsTab = tabBarElement.querySelector('[data-tab="mentions"]');
    const postsTab = tabBarElement.querySelector('[data-tab="posts"]');
    if (mentionsTab) {
      const unseenMentions = mentionsBuffer.length - mentionsSeenCount;
      mentionsTab.textContent = unseenMentions > 0 ? `mentions(${unseenMentions})` : 'mentions';
    }
    if (postsTab) {
      const unseenPosts = postsBuffer.length - postsSeenCount;
      postsTab.textContent = unseenPosts > 0 ? `posts(${unseenPosts})` : 'posts';
    }
  }



  // Dedup helper: hash user+text for 5s window
  function ytMsgHash(user, text) {
    return `${user}:${text.slice(0, 50)}`
  }

  function trackYtServerMsg(user, text) {
    const hash = ytMsgHash(user, text)
    ytServerMsgHashes.add(hash)
    // auto-clean after 5s
    setTimeout(() => ytServerMsgHashes.delete(hash), 5000)
  }

  function isYtDuplicate(user, text) {
    return ytServerMsgHashes.has(ytMsgHash(user, text))
  }

  // Build a message div element (shared by full rebuild and incremental append)
  // Note: innerHTML here is safe — badges/emotes are from extension data, user text
  // goes through escapeHtml() and processEmotes() which sanitize content
  function buildMessageDiv(m, tabId) {
    const showChannel = tabId === 'mentions';
    const isSuperChat = m.platform === 'youtube' && (m.msgType === 'superchat' || m.msgType === 'supersticker')
    const cls = tabId === 'mentions' ? 'hs-mc-msg mention' :
                tabId === 'posts' ? 'hs-mc-msg tweet' :
                m.type === 'usernotice' ? 'hs-mc-msg hs-mc-system' :
                m.redeemed ? 'hs-mc-msg hs-mc-redeemed' :
                isSuperChat ? 'hs-mc-msg hs-mc-superchat' :
                isMention(m) ? 'hs-mc-msg mention' : 'hs-mc-msg';
    const channelSpan = showChannel && m.channel ? `<span class="hs-mc-channel">${escapeHtml(m.channel)}</span>` : '';
    const badges = renderBadges(m.badges, m.channel)
    const plat = m.platform === 'youtube' ? 'yt' : m.platform === 'kick' ? 'kick' : 'twitch'
    const platLabel = plat === 'yt' ? '[YT]' : plat === 'kick' ? '[K]' : '[T]'
    const platColors = { twitch: '#9146ff', kick: '#53fc18', yt: '#ff0000' }
    const platformBadge = plat !== hostPlatform ? `<span style="font-size:10px;margin-right:3px;font-weight:700;vertical-align:middle;color:${platColors[plat]}">${platLabel}</span>` : ''
    const safeScColor = sanitizeColor(m.scColor || '#ffd600')
    const scBadge = isSuperChat && m.amount ? `<span class="hs-mc-sc-badge" style="background:${safeScColor};color:#000;padding:0 4px;border-radius:0;font-size:10px;font-weight:700;margin-right:3px;">${escapeHtml(m.amount)}</span>` : ''
    const userLink = `<a href="https://heatsync.org/u/${encodeURIComponent(m.user)}" target="_blank" class="hs-mc-user" style="color:${sanitizeColor(m.color || '#fff')}">${escapeHtml(m.user)}</a>`;

    // Process text: replace YouTube emoji with inline images
    let processedText = processEmotes(m.text, m.channel)
    if (m.emotes && m.emotes.length > 0) {
      processedText = processYtEmotes(m.text, m.emotes)
    }

    // Sticker for super stickers
    let stickerHtml = ''
    if (m.sticker && m.sticker.url) {
      stickerHtml = ` <img src="${escapeHtml(m.sticker.url)}" alt="${escapeHtml(m.sticker.alt || 'sticker')}" style="height:48px;vertical-align:middle;" />`
    }

    const div = document.createElement('div');
    div.className = cls;
    if (isSuperChat && m.scColor) {
      const safeBg = sanitizeColor(m.scColor)
      div.style.background = safeBg + '22'
      div.style.borderLeft = `3px solid ${safeBg}`
      div.style.paddingLeft = '4px'
    }
    // Reply context bar (Chatterino-style) — all values escaped via escapeHtml
    const replyBar = m.replyTo ? `<div class="hs-mc-reply-ctx">&#8618; Replying to <span class="hs-mc-reply-user">@${escapeHtml(m.replyTo.user)}</span>${m.replyTo.text ? ': ' + escapeHtml(m.replyTo.text.length > 80 ? m.replyTo.text.slice(0, 80) + '...' : m.replyTo.text) : ''}</div>` : ''
    // USERNOTICE system line (all values go through escapeHtml — same pattern as existing innerHTML above)
    const systemLine = m.systemMsg ? `<span class="hs-mc-system-text">${escapeHtml(m.systemMsg)}</span>` : ''
    const msgBody = m.type === 'usernotice' && !m.text
      ? `${systemLine}`
      : `${systemLine}${platformBadge}${scBadge}${badges}${userLink}${channelSpan}: ${processedText}${stickerHtml}`
    div.innerHTML = `${replyBar}${msgBody}`;
    return div;
  }

  // Process YouTube emotes (inline emoji images from innertube)
  function processYtEmotes(text, emotes) {
    if (!emotes || emotes.length === 0) return escapeHtml(text)

    // Build result by replacing emoji alt text with img tags
    let result = escapeHtml(text)
    for (const emote of emotes) {
      if (emote.alt && emote.url) {
        const escaped = escapeHtml(emote.alt).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const re = new RegExp(escaped, 'g')
        result = result.replace(re, `<img src="${escapeHtml(emote.url)}" alt="${escapeHtml(emote.alt)}" class="hs-mc-emote" style="height:1.2em;vertical-align:middle;" />`)
      }
    }
    return result
  }

  // Scroll helper — reused by both renderMessages and appendMessage
  function scrollMsgsToBottom(msgsEl) {
    const scrollToBottom = () => {
      if (isScrolledUp) return;
      isProgrammaticScroll = true;
      msgsEl.scrollTop = msgsEl.scrollHeight + 10000;
      requestAnimationFrame(() => { isProgrammaticScroll = false; });
    };

    const newBtn = document.getElementById('hs-mc-new-msgs');
    newMessageCount = 0;
    if (newBtn) newBtn.style.display = 'none';

    scrollToBottom();
    requestAnimationFrame(() => {
      scrollToBottom();
      setTimeout(scrollToBottom, 50);
    });

    msgsEl.querySelectorAll('.hs-mc-emote').forEach(img => {
      if (!img.complete) {
        img.addEventListener('load', scrollToBottom, { once: true });
      }
    });
  }

  // Incremental append for single messages on the active tab (hot path)
  // Returns true if handled, false if full rebuild needed
  function appendMessage(msg, tabId) {
    if (isScrolledUp || currentTab !== tabId) return false;
    const msgsEl = document.getElementById('hs-mc-messages');
    if (!msgsEl) return false;

    // Remove "no messages" placeholder
    const empty = msgsEl.querySelector('.hs-mc-empty');
    if (empty) empty.remove();

    const div = buildMessageDiv(msg, tabId);
    msgsEl.appendChild(div);

    // Trim oldest messages beyond 150
    trimChildren(msgsEl, 150);

    // Apply mute to just this message
    const username = div.querySelector('.hs-mc-user')?.textContent?.trim()?.toLowerCase();
    if (username && mutedUsers.has(username)) {
      div.style.opacity = '0.15';
      div.style.filter = 'blur(2px)';
    }

    updateTabBadges();
    scrollMsgsToBottom(msgsEl);
    return true;
  }

  // Full rebuild — used for tab switches, scroll resume, and initial load
  function renderMessages(id) {
    // Social tabs have their own renderers
    if (id === 'feed') { renderFeed(); return; }
    if (id === 'notifs') { renderNotifs(); return; }

    const msgsEl = document.getElementById('hs-mc-messages');
    if (!msgsEl) return;

    const newBtn = document.getElementById('hs-mc-new-msgs');

    if (isScrolledUp) {
      newMessageCount++;
      if (newBtn) {
        newBtn.textContent = `↓ ${newMessageCount} new`;
        newBtn.style.display = 'block';
      }
      return;
    }

    let msgs = [];

    if (id === 'mentions') {
      msgs = mentionsBuffer;
    } else if (id === 'posts') {
      msgs = postsBuffer;
    } else if (id === 'add') {
      renderAddChannelForm(msgsEl);
      return;
    } else if (id === 'live') {
      const curCh = getCurrentChannel();
      const ircMsgs = curCh ? (irc?.getMessages(curCh) || []) : [];
      // Kick messages for live tab: same channel name, or linked via config
      let kickMsgs = curCh ? (kickChat?.getMessages(curCh) || []) : [];
      if (!kickMsgs.length && curCh) {
        // Check if any config entry links current channel to a Kick channel
        const linked = config.channels.find(ch => typeof ch !== 'string' && ch.twitch === curCh && ch.kick);
        if (linked) kickMsgs = kickChat?.getMessages(linked.kick) || [];
      }
      if (kickMsgs.length > 0) {
        msgs = [...ircMsgs, ...kickMsgs].sort((a, b) => a.time - b.time);
      } else {
        msgs = ircMsgs;
      }
    } else {
      // Channel tab — merge IRC + Kick + per-channel YouTube messages
      const ch = config.channels.find(c => (typeof c === 'string' ? c : c.id) === id);
      const twitchName = typeof ch === 'string' ? ch : ch?.twitch;
      const kickName = typeof ch === 'string' ? null : ch?.kick;
      const ircMsgs = twitchName ? (irc?.getMessages(twitchName) || []) : [];
      const kickMsgs = kickName ? (kickChat?.getMessages(kickName) || []) : [];
      const ytMsgs = channelYtMessages.get(id) || [];
      const extraMsgs = [...kickMsgs, ...ytMsgs];
      if (extraMsgs.length > 0) {
        msgs = [...ircMsgs, ...extraMsgs].sort((a, b) => a.time - b.time);
      } else {
        msgs = ircMsgs;
      }
    }

    updateTabBadges();

    if (msgs.length === 0) {
      msgsEl.innerHTML = '<div class="hs-mc-empty">no messages yet</div>';
      return;
    }

    const toRender = msgs.slice(-150);
    isProgrammaticScroll = true;
    msgsEl.textContent = '';
    const frag = document.createDocumentFragment();
    for (const m of toRender) frag.appendChild(buildMessageDiv(m, id));
    msgsEl.appendChild(frag);
    applyMcMutes();

    requestAnimationFrame(() => { isProgrammaticScroll = false; });

    if (!isScrolledUp) {
      scrollMsgsToBottom(msgsEl);
    }
  }

  function escapeHtml(str) {
    return str.replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  function sanitizeColor(color) {
    return /^#[0-9a-fA-F]{3,6}$/.test(color) ? color : '#ffffff';
  }

  // Twitch IRC badge rendering
  const BADGE_STYLES = {
    broadcaster: { label: 'LIVE', bg: '#e91916', fg: '#fff' },
    moderator: { label: 'MOD', bg: '#00ad03', fg: '#fff' },
    vip: { label: 'VIP', bg: '#e005b9', fg: '#fff' },
    subscriber: { label: 'SUB', bg: '#8205b4', fg: '#fff' },
    predictions: { label: 'PRED', bg: '#1f69ff', fg: '#fff' },
    premium: { label: 'PRIME', bg: '#0d6efd', fg: '#fff' },
    admin: { label: 'ADMIN', bg: '#faaf19', fg: '#000' },
    staff: { label: 'STAFF', bg: '#faaf19', fg: '#000' },
    global_mod: { label: 'GMOD', bg: '#00ad03', fg: '#fff' },
    partner: { label: '✓', bg: '#9147ff', fg: '#fff' },
    'bits-leader': { label: 'BITS', bg: '#ffd700', fg: '#000' },
    'sub-gifter': { label: 'GIFT', bg: '#8205b4', fg: '#fff' },
    artist: { label: 'ART', bg: '#ff6b35', fg: '#fff' },
    turbo: { label: 'T+', bg: '#6441a5', fg: '#fff' },
    founder: { label: 'FND', bg: '#8205b4', fg: '#fff' },
  }

  // Twitch badge image URLs: "setID/version" → image_url
  const twitchBadgeUrls = new Map()
  const badgesFetchedChannels = new Set()
  let globalBadgesFetched = false
  const TWITCH_GQL = 'https://gql.twitch.tv/gql'
  const TWITCH_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko'

  async function fetchGlobalBadges() {
    if (globalBadgesFetched) return
    globalBadgesFetched = true
    try {
      const resp = await fetch(TWITCH_GQL, {
        method: 'POST',
        headers: { 'Client-Id': TWITCH_CLIENT_ID, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: '{ badges { imageURL(size: NORMAL) setID version } }' })
      })
      if (!resp.ok) return
      const data = await resp.json()
      const badges = data?.data?.badges
      if (!badges) return
      for (const b of badges) {
        twitchBadgeUrls.set(`${b.setID}/${b.version}`, b.imageURL)
      }
      log('Loaded global badges:', twitchBadgeUrls.size)
    } catch (e) {
      globalBadgesFetched = false
      log('Failed to fetch global badges:', e.message)
    }
  }

  // Prediction state
  let _predictionPollTimer = null
  let _predictionChannel = null

  async function fetchPrediction(channelLogin) {
    const safe = channelLogin.replace(/[^a-z0-9_]/g, '')
    if (!safe) return null
    const token = getTwitchAuthToken()
    const headers = { 'Client-Id': TWITCH_CLIENT_ID, 'Content-Type': 'application/json' }
    if (token) headers['Authorization'] = `OAuth ${token}`
    try {
      const resp = await fetch(TWITCH_GQL, {
        method: 'POST',
        headers,
        body: JSON.stringify([
          {
            operationName: 'ChannelPointsPredictionContext',
            extensions: {
              persistedQuery: {
                version: 1,
                sha256Hash: '9324cd5cde62cbb1e3455d7c0e2a22ab44d498cd4a498a0e51cb0caafcc36b35'
              }
            },
            variables: { channelLogin: safe }
          },
          {
            operationName: 'CommunityPointsContext',
            extensions: {
              persistedQuery: {
                version: 1,
                sha256Hash: '1530a003a7d374b0380b79db0be0534f30ff46e61cffa2571ed39571c9de2a30'
              }
            },
            variables: { channelLogin: safe }
          }
        ])
      })
      if (!resp.ok) return null
      const data = await resp.json()
      const predEvent = data?.[0]?.data?.user?.activePredictionEvent || null
      const balance = data?.[1]?.data?.community?.channel?.self?.communityPoints?.balance ?? null
      return { prediction: predEvent, balance }
    } catch (e) {
      log('Failed to fetch prediction:', e.message)
      return null
    }
  }

  async function placePredictionBet(eventId, outcomeId, points, transactionId) {
    const token = getTwitchAuthToken()
    if (!token) return { error: 'not logged in' }
    try {
      const resp = await fetch(TWITCH_GQL, {
        method: 'POST',
        headers: {
          'Client-Id': TWITCH_CLIENT_ID,
          'Content-Type': 'application/json',
          'Authorization': `OAuth ${token}`
        },
        body: JSON.stringify({
          operationName: 'MakePrediction',
          extensions: {
            persistedQuery: {
              version: 1,
              sha256Hash: 'b44682ecc88358817009f20f69cc0571d8f3b4e1e290472c1c0c6c2ea9b1f0bb'
            }
          },
          variables: {
            input: {
              eventID: eventId,
              outcomeID: outcomeId,
              points: points,
              transactionID: transactionId || crypto.randomUUID()
            }
          }
        })
      })
      if (!resp.ok) return { error: `HTTP ${resp.status}` }
      const data = await resp.json()
      if (data?.errors?.length) return { error: data.errors[0].message }
      return { ok: true }
    } catch (e) {
      return { error: e.message }
    }
  }

  async function fetchChannelBadges(channelLogin) {
    if (!channelLogin || badgesFetchedChannels.has(channelLogin)) return
    // Sanitize: Twitch logins are alphanumeric + underscore only
    const safe = channelLogin.replace(/[^a-z0-9_]/g, '')
    if (!safe) return
    badgesFetchedChannels.add(channelLogin)
    // Evict oldest channel if cache exceeds 20
    if (badgesFetchedChannels.size > 20) {
      const oldest = badgesFetchedChannels.values().next().value;
      badgesFetchedChannels.delete(oldest);
      // Remove that channel's badge entries
      for (const key of twitchBadgeUrls.keys()) {
        if (key.startsWith(`${oldest}:`)) twitchBadgeUrls.delete(key);
      }
    }
    try {
      const resp = await fetch(TWITCH_GQL, {
        method: 'POST',
        headers: { 'Client-Id': TWITCH_CLIENT_ID, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: `{ user(login: "${safe}") { broadcastBadges { imageURL(size: NORMAL) setID version } } }` })
      })
      if (!resp.ok) return
      const data = await resp.json()
      const badges = data?.data?.user?.broadcastBadges
      if (!badges) return
      for (const b of badges) {
        // Prefix with channel to avoid cross-channel collisions
        twitchBadgeUrls.set(`${channelLogin}:${b.setID}/${b.version}`, b.imageURL)
      }
      log('Loaded channel badges for', channelLogin)
    } catch (e) {
      badgesFetchedChannels.delete(channelLogin)
      log('Failed to fetch channel badges:', e.message)
    }
  }

  function renderBadges(badgesStr, channel) {
    if (!badgesStr) return ''
    return badgesStr.split(',').map(badge => {
      const [name, version] = badge.split('/')
      // Channel-specific first, then global fallback
      const url = (channel && twitchBadgeUrls.get(`${channel}:${name}/${version}`))
        || twitchBadgeUrls.get(`${name}/${version}`)
        || twitchBadgeUrls.get(`${name}/1`)
      if (url) {
        return `<img class="hs-mc-badge-img" src="${url}" alt="${name}" title="${name}" style="width:18px;height:18px;">`
      }
      // Text fallback
      const style = BADGE_STYLES[name]
      if (!style) return ''
      return `<span class="hs-mc-badge" style="background:${style.bg};color:${style.fg}" title="${escapeHtml(name)}">${style.label}</span>`
    }).join('')
  }

  // Blocked emotes: stored by HASH (matches background.js/server)
  // blockedEmoteHashes = Set of hashes from storage
  // blockedEmoteNames = Set of names (derived via hashToName lookup, for processEmotes)
  let blockedEmoteHashes = new Set();
  let blockedEmoteNames = new Set();

  function rebuildBlockedNames() {
    blockedEmoteNames.clear();
    for (const hash of blockedEmoteHashes) {
      const name = hashToName.get(hash);
      if (name) blockedEmoteNames.add(name);
    }
    log('Blocked names rebuilt:', blockedEmoteNames.size, 'from', blockedEmoteHashes.size, 'hashes');
  }

  async function loadBlockedEmotes() {
    try {
      const data = await chrome.storage.local.get(['blocked_emotes']);
      blockedEmoteHashes = new Set(data.blocked_emotes || []);
      rebuildBlockedNames();
      log('Loaded', blockedEmoteHashes.size, 'blocked emote hashes');
    } catch (e) {
      log('Error loading blocked emotes:', e);
    }
  }

  // Flash all wrappers for a given emote name
  function flashAllEmotes(emoteName, flashClass) {
    const wrappers = queryEmoteWrappers(emoteName)
    if (wrappers.length === 0) return
    // Batch read/write to avoid per-element reflow
    for (const w of wrappers) {
      w.classList.remove('hs-flash-paste', 'hs-flash-add', 'hs-flash-block', 'hs-flash-unblock', 'hs-flash-remove');
    }
    // Single reflow trigger for all elements
    void document.body.offsetWidth
    for (const w of wrappers) {
      w.classList.add(flashClass);
      w.addEventListener('animationend', () => w.classList.remove(flashClass), { once: true });
    }
  }

  // Paste emote name to input
  function pasteEmoteToInput(emoteName) {
    const input = document.getElementById('hs-mc-input');
    if (!input) return;
    if (wysiwygEnabled || !('value' in input)) {
      const text = input.textContent || '';
      const space = text.length > 0 && !text.endsWith(' ') ? ' ' : '';
      input.textContent = text + space + emoteName + ' ';
      pendingMessage = input.textContent;
      // Move cursor to end
      const range = document.createRange();
      const sel = window.getSelection();
      range.selectNodeContents(input);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      const pos = input.selectionStart || input.value.length;
      const before = input.value.slice(0, pos);
      const after = input.value.slice(pos);
      const space = before.length > 0 && !before.endsWith(' ') ? ' ' : '';
      input.value = before + space + emoteName + ' ' + after;
      pendingMessage = input.value;
      input.selectionStart = input.selectionEnd = pos + space.length + emoteName.length + 1;
    }
    input.focus();
  }

  // Remove emote from inventory via background.js
  async function removeEmoteFromInventory(emoteName, targetEl) {
    if (!emoteName) return;
    const hash = inventoryHashes.get(emoteName);
    if (!hash) {
      // Fallback: generate from emote URL
      const emote = lookupEmote(emoteName);
      const fallbackHash = emote?.url ? btoa(emote.url).slice(0, 32) : emoteName;
      try {
        const response = await new Promise((resolve) => {
          chrome.runtime.sendMessage({
            type: 'remove_from_inventory',
            emoteHash: fallbackHash,
            emoteName
          }, resolve);
        });
        if (response?.success) handleRemoveSuccess(emoteName, targetEl);
        else showToast(response?.error || `failed to remove: ${emoteName}`);
      } catch (e) {
        showToast(`error removing: ${emoteName}`);
      }
      return;
    }
    try {
      const response = await new Promise((resolve) => {
        chrome.runtime.sendMessage({
          type: 'remove_from_inventory',
          emoteHash: hash,
          emoteName
        }, resolve);
      });
      if (response?.success) handleRemoveSuccess(emoteName, targetEl);
      else showToast(response?.error || `failed to remove: ${emoteName}`);
    } catch (e) {
      showToast(`error removing: ${emoteName}`);
    }
  }

  function handleRemoveSuccess(emoteName, targetEl) {
    inventoryEmotes.delete(emoteName);
    inventoryHashes.delete(emoteName);
    const cachedEmote = lookupEmote(emoteName);
    if (cachedEmote) {
      cachedEmote.state = ['7tv', 'bttv', 'ffz', 'twitch', 'kick'].includes(cachedEmote.source) ? 'global' : 'unadded';
    }
    // Update all wrappers in DOM
    const newState = cachedEmote?.state || 'unadded';
    queryEmoteWrappers(emoteName).forEach(w => {
      w.classList.remove('hs-state-global', 'hs-state-channel', 'hs-state-owned', 'hs-state-blocked', 'hs-state-unadded');
      w.classList.add(`hs-state-${newState}`);
      w.dataset.state = newState;
    });
    showToast(`removed: ${emoteName}`);
    flashAllEmotes(emoteName, 'hs-flash-remove');
  }

  function blockAllEmotesInStack(stack) {
    const wrappers = stack.querySelectorAll('.hs-mc-emote-wrapper');
    let count = 0;
    wrappers.forEach(w => {
      const name = w.dataset.emoteName;
      if (name && w.dataset.state !== 'blocked') {
        blockEmote(name);
        count++;
      }
    });
    if (count > 0) showToast(`blocked ${count} emotes`);
    stack.classList.remove('expanded');
    stack.setAttribute('title', 'expand');
  }

  function blockEmote(emoteName) {
    if (!emoteName) return;

    // Update local name-based tracking
    blockedEmoteNames.add(emoteName);

    // Get hash for API - prefer known hash, fallback to URL-derived
    const hash = emoteHashes.get(emoteName) ||
      (lookupEmote(emoteName)?.url ? btoa(lookupEmote(emoteName).url).slice(0, 32) : emoteName);
    blockedEmoteHashes.add(hash);

    // Sync to heatsync.org API via background.js (it handles storage)
    syncBlockToAPI(emoteName, true);

    // Instant DOM update - CSS visibility:hidden hides the img, no src swap needed
    queryEmoteWrappers(emoteName).forEach(w => {
      w.classList.remove('hs-state-global', 'hs-state-channel', 'hs-state-owned', 'hs-state-unadded');
      w.classList.add('hs-state-blocked');
      w.dataset.state = 'blocked';
      const img = w.querySelector('img');
      if (img) {
        img.classList.remove('hs-emote-global', 'hs-emote-channel', 'hs-emote-owned', 'hs-emote-unadded');
        img.classList.add('hs-emote-blocked');
        img.dataset.state = 'blocked';
      }
    });

    showToast(`blocked: ${emoteName}`);
    flashAllEmotes(emoteName, 'hs-flash-block');
  }

  function unblockEmote(emoteName) {
    if (!emoteName) return;

    // Update local tracking
    blockedEmoteNames.delete(emoteName);
    const hash = emoteHashes.get(emoteName) ||
      (lookupEmote(emoteName)?.url ? btoa(lookupEmote(emoteName).url).slice(0, 32) : emoteName);
    blockedEmoteHashes.delete(hash);

    // Sync to heatsync.org API via background.js
    syncBlockToAPI(emoteName, false);

    // Instant DOM update - restore images
    const emote = lookupEmote(emoteName);
    const realUrl = emote?.url || '';
    const newState = emote ? getEmoteState(emoteName, emote.source) : 'global';
    queryEmoteWrappers(emoteName).forEach(w => {
      w.classList.remove('hs-state-global', 'hs-state-channel', 'hs-state-owned', 'hs-state-blocked', 'hs-state-unadded');
      w.classList.add(`hs-state-${newState}`);
      w.dataset.state = newState;
      w.style.outline = '';
      const img = w.querySelector('img');
      if (img && realUrl) {
        img.src = realUrl;
        img.style.width = '';
        img.style.height = '';
        img.classList.remove('hs-emote-global', 'hs-emote-channel', 'hs-emote-owned', 'hs-emote-blocked', 'hs-emote-unadded');
        img.classList.add(`hs-emote-${newState}`);
        img.dataset.state = newState;
      }
    });

    showToast(`unblocked: ${emoteName}`);
    flashAllEmotes(emoteName, 'hs-flash-unblock');
  }

  // Add emote to inventory (click-to-add for unadded emotes)
  async function addEmoteToInventory(emoteName, emoteUrl, emoteSource, targetEl) {
    if (!emoteName) return;

    try {
      // Generate a hash from the URL for the API
      const emoteHash = emoteUrl ? btoa(emoteUrl).slice(0, 32) : emoteName;

      // Send to background script for API call with auth
      const response = await new Promise((resolve) => {
        chrome.runtime.sendMessage({
          type: 'add_to_inventory',
          emoteName: emoteName,
          emoteHash: emoteHash,
          emoteUrl: emoteUrl
        }, resolve);
      });

      if (response?.success) {
        // Update local cache - change from unadded to owned
        inventoryEmotes.add(emoteName);
        if (response.hash) inventoryHashes.set(emoteName, response.hash);
        if (emoteCache.has(emoteName)) {
          const emote = emoteCache.get(emoteName);
          emote.state = 'owned';
          emoteCache.set(emoteName, emote);
        }

        // Update all wrappers in DOM (no full re-render)
        queryEmoteWrappers(emoteName).forEach(w => {
          w.classList.remove('hs-state-global', 'hs-state-unadded', 'hs-state-blocked');
          w.classList.add('hs-state-owned');
          w.dataset.state = 'owned';
        });

        showToast(`added: ${emoteName}`);
        flashAllEmotes(emoteName, 'hs-flash-add');
      } else {
        showToast(response?.error || `failed to add: ${emoteName}`);
      }
    } catch (e) {
      log('Add emote error:', e);
      showToast(`error adding: ${emoteName}`);
    }
  }

  // Sync block/unblock to heatsync.org API via background script
  async function syncBlockToAPI(emoteName, block) {
    try {
      // Background script expects message.hash - use emoteHashes (most complete mapping)
      const hash = emoteHashes.get(emoteName) ||
        (lookupEmote(emoteName)?.url ? btoa(lookupEmote(emoteName).url).slice(0, 32) : emoteName);
      chrome.runtime.sendMessage({
        type: block ? 'block_emote' : 'unblock_emote',
        hash: hash,
        emoteName: emoteName
      });
      log('Synced', block ? 'block' : 'unblock', emoteName, '(hash:', hash.substring(0, 8) + '...) to API');
    } catch (e) {
      log('API sync error:', e);
    }
  }

  function showToast(msg) {
    const existing = document.getElementById('hs-mc-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'hs-mc-toast';
    toast.textContent = msg;
    toast.style.cssText = `
      position: fixed;
      bottom: 70px;
      right: 20px;
      background: #000;
      color: #fff;
      border: 1px solid #fff;
      padding: 6px 14px;
      border-radius: 0;
      font: bold 12px monospace;
      z-index: 5000;
      pointer-events: none;
    `;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 1500);
  }

  // Emote hover tooltip (4x preview with source color)
  let emoteTooltip = null;

  function ensureEmoteTooltip() {
    if (!emoteTooltip || !document.contains(emoteTooltip)) {
      emoteTooltip = document.createElement('div');
      emoteTooltip.id = 'hs-emote-tooltip';
      emoteTooltip.innerHTML = `
        <img src="" alt="">
        <span class="tooltip-name"></span>
        <span class="tooltip-source"></span>
      `;
      document.body.appendChild(emoteTooltip);
    }
    return emoteTooltip;
  }

  // Upgrade emote URL to highest resolution for tooltip
  function getHighResUrl(url) {
    if (!url) return url;
    // 7TV: /1x → /4x
    if (url.includes('cdn.7tv.app')) {
      return url.replace('/1x', '/4x').replace('/2x', '/4x').replace('/3x', '/4x');
    }
    // BTTV: /1x → /3x (max)
    if (url.includes('cdn.betterttv.net')) {
      return url.replace('/1x', '/3x').replace('/2x', '/3x');
    }
    // FFZ: /1 → /4
    if (url.includes('cdn.frankerfacez.com')) {
      return url.replace(/\/1(?=\.|$)/, '/4').replace(/\/2(?=\.|$)/, '/4');
    }
    // Twitch: /1.0 → /3.0 (max)
    if (url.includes('static-cdn.jtvnw.net')) {
      return url.replace('/1.0', '/3.0').replace('/2.0', '/3.0');
    }
    return url;
  }

  function showEmoteTooltip(e, emoteName, emoteUrl, state, source, hoveredImg) {
    const tooltip = ensureEmoteTooltip();
    const img = tooltip.querySelector('img');
    const nameEl = tooltip.querySelector('.tooltip-name');
    const stateEl = tooltip.querySelector('.tooltip-source');

    // Show 1x immediately (no stale image), upgrade to hi-res in background
    const w4 = (hoveredImg?.offsetWidth || 28) * 4;
    const h4 = (hoveredImg?.offsetHeight || 28) * 4;
    img.style.width = w4 + 'px';
    img.style.height = h4 + 'px';
    img.src = emoteUrl;
    img.alt = emoteName;
    // Try loading hi-res — swap in if it works, keep 1x if it fails
    const hiResUrl = getHighResUrl(emoteUrl);
    if (hiResUrl !== emoteUrl) {
      const hiRes = new Image();
      hiRes.onload = () => { if (img.alt === emoteName) img.src = hiResUrl; };
      hiRes.src = hiResUrl;
    }
    nameEl.textContent = emoteName;

    // Show state with source for globals
    let label;
    if (state === 'owned') {
      label = 'in your set';
    } else if (state === 'unadded') {
      label = 'click to add';
    } else if (state === 'blocked') {
      label = 'blocked (click to unblock)';
    } else {
      // Global or channel - show source
      const sourceLabels = {
        '7tv': '7TV',
        'bttv': 'BTTV',
        'ffz': 'FFZ',
        'twitch': 'Twitch',
        'kick': 'Kick',
        'heatsync': 'Heatsync'
      };
      const sourceName = sourceLabels[source] || source || 'unknown';
      const scope = state === 'channel' ? 'channel' : 'global';
      label = `${scope} (${sourceName})`;
    }
    stateEl.textContent = label;
    stateEl.className = 'tooltip-source ' + (state || 'global');

    // Position: show tooltip above the emote, offset right of cursor
    // First make visible off-screen to measure height
    tooltip.style.left = '-9999px';
    tooltip.style.top = '-9999px';
    tooltip.classList.add('visible');

    const rect = tooltip.getBoundingClientRect();
    const tooltipH = rect.height;
    const tooltipW = rect.width;
    const gap = 12; // px gap between cursor and tooltip

    // Prefer above cursor; if no room, go below
    let x = Math.min(e.clientX + 15, window.innerWidth - tooltipW - 10);
    x = Math.max(10, x);
    let y;
    if (e.clientY - tooltipH - gap > 10) {
      y = e.clientY - tooltipH - gap; // above
    } else {
      y = e.clientY + gap + 20; // below (20px for emote height)
    }
    y = Math.max(10, Math.min(y, window.innerHeight - tooltipH - 10));

    tooltip.style.left = x + 'px';
    tooltip.style.top = y + 'px';
  }

  function hideEmoteTooltip() {
    if (emoteTooltip) {
      emoteTooltip.classList.remove('visible');
    }
  }

  function setupEmoteTooltipHandlers() {
    if (window._hsEmoteTooltipSetup) return;
    window._hsEmoteTooltipSetup = true;

    cleanup.addEventListener(document, 'mouseover', (e) => {
      const target = e.target;
      // Check wrapper first, then IMG
      const wrapper = target.closest('.hs-mc-emote-wrapper');
      const img = wrapper ? wrapper.querySelector('img') : (
        target.tagName === 'IMG' && (target.classList.contains('hs-mc-emote') || target.classList.contains('hs-mc-picker-emote')) ? target : null
      );
      if (!img && !wrapper) return;

      const emoteName = wrapper?.dataset.emoteName || img?.alt || img?.dataset.emoteName || img?.title?.split(' ')[0];
      if (!emoteName) return;

      const emoteUrl = wrapper?.dataset.emoteUrl || img?.src;
      const state = wrapper?.dataset.state || img?.dataset.state || 'global';
      const source = wrapper?.dataset.source || img?.dataset.source || detectEmoteSource(emoteUrl);

      showEmoteTooltip(e, emoteName, emoteUrl, state, source, img);

      // Cross-highlight: add highlight to all wrappers with same emote name
      queryEmoteWrappers(emoteName).forEach(w => {
        w.classList.add('hs-emote-highlight');
      });
    }, 'mc-emote-tooltip-mouseover');

    cleanup.addEventListener(document, 'mouseout', (e) => {
      const target = e.target;
      const wrapper = target.closest('.hs-mc-emote-wrapper');
      const img = wrapper ? wrapper.querySelector('img') : (
        target.tagName === 'IMG' && (target.classList.contains('hs-mc-emote') || target.classList.contains('hs-mc-picker-emote')) ? target : null
      );
      if (!img && !wrapper) return;

      hideEmoteTooltip();

      // Remove cross-highlight from all wrappers
      const emoteName = wrapper?.dataset.emoteName || img?.alt || img?.dataset.emoteName;
      if (emoteName) {
        queryEmoteWrappers(emoteName).forEach(w => {
          w.classList.remove('hs-emote-highlight');
        });
      }
    }, 'mc-emote-tooltip-mouseout');

    let _tooltipRafPending = false
    cleanup.addEventListener(document, 'mousemove', (e) => {
      // RAF-batch tooltip position updates to avoid per-mousemove style writes
      if (_tooltipRafPending) return
      _tooltipRafPending = true
      const cx = e.clientX, cy = e.clientY, target = e.target
      requestAnimationFrame(() => {
        _tooltipRafPending = false
        const onEmote = target?.closest?.('.hs-mc-emote-wrapper') ||
          (target?.tagName === 'IMG' && (target.classList?.contains('hs-mc-emote') || target.classList?.contains('hs-mc-picker-emote')))
        const onUser = target?.closest?.('.hs-mc-user')

        // Kill emote tooltip instantly if not on an emote
        if (emoteTooltip?.classList.contains('visible')) {
          if (!onEmote) {
            hideEmoteTooltip()
            document.querySelectorAll('.hs-emote-highlight').forEach(w => w.classList.remove('hs-emote-highlight'))
          } else {
            const tooltipH = emoteTooltip.offsetHeight
            const tooltipW = emoteTooltip.offsetWidth
            const gap = 12
            let x = Math.min(cx + 15, window.innerWidth - tooltipW - 10)
            x = Math.max(10, x)
            let y = cy - tooltipH - gap > 10 ? cy - tooltipH - gap : cy + gap + 20
            y = Math.max(10, Math.min(y, window.innerHeight - tooltipH - 10))
            emoteTooltip.style.left = x + 'px'
            emoteTooltip.style.top = y + 'px'
          }
        }

        // Kill user tooltip instantly if not on a username
        if (userTooltip?.classList.contains('visible')) {
          if (!onUser && !target?.closest?.('#hs-user-tooltip')) {
            hideUserTooltip()
          } else {
            const x = Math.min(cx + 15, window.innerWidth - 220)
            const y = Math.max(cy - 60, 10)
            userTooltip.style.left = x + 'px'
            userTooltip.style.top = y + 'px'
          }
        }
      })
    }, 'mc-tooltip-mousemove');
  }

  // User hover tooltip (profile preview)
  let userTooltip = null;
  const _profileCache = new Map(); // username -> { profile, ts }
  const PROFILE_CACHE_TTL = 60000; // 60s
  let _profileGen = 0; // generation counter to prevent stale renders

  function ensureUserTooltip() {
    if (!userTooltip || !document.contains(userTooltip)) {
      userTooltip = document.createElement('div');
      userTooltip.id = 'hs-user-tooltip';
      document.body.appendChild(userTooltip);
    }
    return userTooltip;
  }

  function formatCompact(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(n);
  }

  function getAccountAge(dateStr) {
    if (!dateStr) return null;
    const d = new Date(dateStr);
    const now = new Date();
    const y = now.getFullYear() - d.getFullYear();
    const m = now.getMonth() - d.getMonth();
    const days = now.getDate() - d.getDate();
    if (y > 0) return y + 'y';
    if (m > 0) return m + 'm';
    return Math.max(0, days) + 'd';
  }

  function getCompactRelTime(dateStr) {
    if (!dateStr) return '';
    const ms = Date.now() - new Date(dateStr).getTime();
    const d = Math.floor(ms / 86400000);
    if (d > 365) return Math.floor(d / 365) + 'y ago';
    if (d > 30) return Math.floor(d / 30) + 'mo ago';
    if (d > 0) return d + 'd ago';
    const h = Math.floor(ms / 3600000);
    if (h > 0) return h + 'h ago';
    return 'just now';
  }

  function renderProfileCard(p) {
    const pfp = p.twitch_profile_pic || p.kick_profile_pic || p.profile_image_url || '';
    const displayName = p.display_name || p.username || 'unknown';

    // Platform badges
    let platforms = '';
    if (p.twitch_username) {
      let ttv = `<span class="hs-pc-platform twitch">ttv:${escapeHtml(p.twitch_username)}</span>`;
      if (p.twitch_verified) ttv += ' ✓';
      if (p.twitch_is_live) {
        const vc = p.twitch_viewer_count || 0;
        ttv += ` <span style="color:#f00">🔴${vc > 0 ? ' ' + formatCompact(vc) : ''}</span>`;
      }
      platforms += ttv;
    }
    if (p.kick_username) {
      let kk = `<span class="hs-pc-platform kick">kick:${escapeHtml(p.kick_username)}</span>`;
      if (p.kick_verified) kk += ' ✓';
      if (p.kick_is_live) {
        const vc = p.kick_viewer_count || 0;
        kk += ` <span style="color:#f00">🔴${vc > 0 ? ' ' + formatCompact(vc) : ''}</span>`;
      }
      platforms += kk;
    }
    if (!platforms) {
      platforms = `<span class="hs-pc-name">${escapeHtml(displayName)}</span>`;
    }

    // Role badge
    let role = '';
    const bt = p.twitch_broadcaster_type;
    if (bt === 'partner') role = '<span class="hs-pc-role partner">partner</span>';
    else if (bt === 'affiliate') role = '<span class="hs-pc-role affiliate">affiliate</span>';
    else if (p.role === 'admin') role = '<span class="hs-pc-role admin">admin</span>';
    else if (p.role === 'staff') role = '<span class="hs-pc-role staff">staff</span>';

    // Account age
    const dates = [p.twitch_created_at, p.kick_created_at].filter(Boolean);
    const oldest = dates.length ? dates.reduce((a, b) => new Date(b) < new Date(a) ? b : a) : null;
    const age = getAccountAge(oldest);
    const ageHtml = age ? `<span class="hs-pc-age">${age}</span>` : '';

    // Bio
    const bio = p.bio ? `<div class="hs-pc-bio">${escapeHtml(p.bio)}</div>` : '';

    // Stats
    const stats = p.stats || {};
    const heat = stats.total_heat || 0;
    const op = stats.op_count || 0;
    const re = stats.re_count || 0;
    const followers = Math.max(stats.followers || 0, p.twitch_followers || 0, p.kick_followers || 0);
    const following = Math.max(stats.following || 0, p.twitch_following_count || 0, p.kick_following_count || 0);

    const statBadges = [];
    statBadges.push(`<span class="hs-pc-stat heat"><span class="hs-pc-num">${formatCompact(heat)}</span>°</span>`);
    if (op > 0) statBadges.push(`<span class="hs-pc-stat op"><span class="hs-pc-num">${formatCompact(op)}</span> <span class="hs-pc-badge">OP</span></span>`);
    if (re > 0) statBadges.push(`<span class="hs-pc-stat re"><span class="hs-pc-num">${formatCompact(re)}</span> <span class="hs-pc-badge">RE</span></span>`);
    if (followers > 0) statBadges.push(`<span class="hs-pc-stat"><span class="hs-pc-num">${formatCompact(followers)}</span> followers</span>`);
    if (following > 0) statBadges.push(`<span class="hs-pc-stat">following <span class="hs-pc-num">${formatCompact(following)}</span></span>`);

    // Relationship
    const rel = p.relationship || {};
    const relBadges = [];
    const followsYou = rel.profileFollowsViewerOnTwitch || rel.profileFollowsViewerOnKick || rel.followsYou;
    if (followsYou) {
      const since = rel.profileFollowsViewerOnTwitchSince || rel.followsYouSince;
      relBadges.push(`<span class="hs-pc-rel-badge mutual">follows you${since ? ' ' + getCompactRelTime(since) : ''}</span>`);
    }
    if (rel.profileSubbedToViewerOnTwitch || rel.subscribesToYou) {
      const since = rel.profileTwitchSubSince || rel.subscribesToYouSince;
      relBadges.push(`<span class="hs-pc-rel-badge supporter">subs to you${since ? ' ' + getCompactRelTime(since) : ''}</span>`);
    }

    return `
      ${pfp ? `<img class="hs-pc-avatar" src="${escapeHtml(pfp)}" alt="${escapeHtml(displayName)}">` : ''}
      <div class="hs-pc-info">
        <div class="hs-pc-header">${platforms} ${role} ${ageHtml}</div>
        ${bio}
        ${statBadges.length ? `<div class="hs-pc-stats">${statBadges.join('')}</div>` : ''}
        ${relBadges.length ? `<div class="hs-pc-rel">${relBadges.join(' ')}</div>` : ''}
      </div>`;
  }

  async function showUserTooltip(e, username, color) {
    const tooltip = ensureUserTooltip();
    const gen = ++_profileGen;

    // Show loading state immediately
    tooltip.innerHTML = `<div class="hs-pc-loading" style="color:${color || '#fff'}">${escapeHtml(username)}...</div>`;

    const x = Math.min(e.clientX + 15, window.innerWidth - 280);
    const y = Math.max(e.clientY - 80, 10);
    tooltip.style.left = x + 'px';
    tooltip.style.top = y + 'px';
    tooltip.classList.add('visible');

    // Check cache
    const cached = _profileCache.get(username.toLowerCase());
    if (cached && Date.now() - cached.ts < PROFILE_CACHE_TTL) {
      if (gen !== _profileGen) return;
      tooltip.innerHTML = renderProfileCard(cached.profile);
      repositionTooltip(tooltip, e);
      return;
    }

    // Fetch profile
    const resp = await apiFetch(`/api/profile/${encodeURIComponent(username)}`);
    if (gen !== _profileGen) return; // user moved away

    if (resp?.ok && resp.data?.profile) {
      const profile = resp.data.profile;
      _profileCache.set(username.toLowerCase(), { profile, ts: Date.now() });
      // Prune cache
      if (_profileCache.size > 100) {
        const oldest = [..._profileCache.entries()].sort((a, b) => a[1].ts - b[1].ts).slice(0, 50);
        for (const [k] of oldest) _profileCache.delete(k);
      }
      tooltip.innerHTML = renderProfileCard(profile);
      repositionTooltip(tooltip, e);
    } else {
      // Fallback — show basic info
      tooltip.innerHTML = `<div class="hs-pc-info"><div class="hs-pc-header"><span class="hs-pc-name">${escapeHtml(username)}</span></div></div>`;
    }
  }

  function repositionTooltip(tooltip, e) {
    // Re-position after content changes size
    const rect = tooltip.getBoundingClientRect();
    const x = Math.min(e.clientX + 15, window.innerWidth - rect.width - 10);
    const y = e.clientY - rect.height - 10 > 0
      ? e.clientY - rect.height - 10
      : e.clientY + 20;
    tooltip.style.left = Math.max(5, x) + 'px';
    tooltip.style.top = Math.max(5, y) + 'px';
  }

  function hideUserTooltip() {
    _profileGen++;
    if (userTooltip) {
      userTooltip.classList.remove('visible');
    }
  }

  function setupUserTooltipHandlers() {
    if (window._hsUserTooltipSetup) return;
    window._hsUserTooltipSetup = true;

    cleanup.addEventListener(document, 'mouseover', (e) => {
      const target = e.target.closest('.hs-mc-user');
      if (target) {
        const username = target.textContent;
        const color = target.style.color;
        showUserTooltip(e, username, color);
      }
    }, 'mc-user-tooltip-mouseover');

    cleanup.addEventListener(document, 'mouseout', (e) => {
      const target = e.target.closest('.hs-mc-user');
      if (target) {
        hideUserTooltip();
      }
    }, 'mc-user-tooltip-mouseout');
  }

  // Emote cache (loaded from storage)
  // Format: Map<name, {url, source, state}>
  // States: 'owned' (in inventory), 'global' (third-party), 'unadded' (heatsync, not owned)
  let emoteCache = new Map(); // Global + inventory emotes (no channel emotes!)
  let channelEmoteCaches = {}; // Per-channel emotes: { channelName: Map<name, emoteData> }
  let inventoryEmotes = new Set(); // Names of emotes in user's inventory

  // Look up emote from global cache + current channel cache
  function lookupEmote(name) {
    return emoteCache.get(name) || channelEmoteCaches[currentTab]?.get(name) || channelEmoteCaches[getCurrentChannel()]?.get(name);
  }
  let inventoryHashes = new Map(); // name → hash for remove_from_inventory
  let emoteHashes = new Map(); // name → hash for ALL emotes (block/unblock API)
  let hashToName = new Map(); // hash → name (reverse lookup for loading blocked from storage)

  // Detect emote source from URL
  function detectEmoteSource(url, hint = null) {
    if (!url) return hint || 'unknown';
    if (url.includes('cdn.7tv.app')) return '7tv';
    if (url.includes('cdn.betterttv.net')) return 'bttv';
    if (url.includes('cdn.frankerfacez.com')) return 'ffz';
    if (url.includes('static-cdn.jtvnw.net')) return 'twitch';
    if (url.includes('kick.com') || url.includes('kick-static')) return 'kick';
    if (url.includes('heatsync.org')) return 'heatsync';
    return hint || 'unknown';
  }

  // Determine emote state: owned > global > unadded
  function getEmoteState(name, source) {
    if (inventoryEmotes.has(name)) return 'owned';
    // Third-party emotes are always "global" (can't add to heatsync inventory)
    if (['7tv', 'bttv', 'ffz', 'twitch', 'kick'].includes(source)) return 'global';
    // Heatsync emotes not in inventory are "unadded"
    return 'unadded';
  }

  async function loadEmotes() {
    try {
      const stored = await chrome.storage.local.get(['global_emotes', 'emote_inventory', 'channel_emotes_map']);
      emoteCache.clear();
      channelEmoteCaches = {};
      inventoryEmotes.clear();
      inventoryHashes.clear();
      emoteHashes.clear();
      hashToName.clear();

      // Helper to register hash↔name mapping
      const registerHash = (name, hash) => {
        if (name && hash) {
          emoteHashes.set(name, hash);
          hashToName.set(hash, name);
        }
      };

      // First, build inventory set (emotes user owns)
      (stored.emote_inventory || []).forEach(e => {
        if (e.name) {
          inventoryEmotes.add(e.name);
          if (e.hash) {
            inventoryHashes.set(e.name, e.hash);
            registerHash(e.name, e.hash);
          }
        }
      });

      // Add global emotes (heatsync globals - may or may not be in inventory)
      (stored.global_emotes || []).forEach(e => {
        if (e.name && e.url) {
          const source = e.source || detectEmoteSource(e.url, 'heatsync');
          const state = getEmoteState(e.name, source);
          emoteCache.set(e.name, { url: e.url, source, state, zeroWidth: !!e.zeroWidth });
          if (e.hash) registerHash(e.name, e.hash);
        }
      });

      // Add inventory emotes (definitely owned)
      (stored.emote_inventory || []).forEach(e => {
        if (e.name && e.url) {
          const source = e.source || 'heatsync';
          emoteCache.set(e.name, { url: e.url, source, state: 'owned', zeroWidth: !!e.zeroWidth });
        }
      });

      // Load per-channel emotes into separate caches (prevents cross-channel leaking)
      const map = stored.channel_emotes_map || {};
      for (const [ch, emotes] of Object.entries(map)) {
        const chCache = new Map();
        (emotes || []).forEach(e => {
          if (e.name && e.url) {
            const source = e.source || detectEmoteSource(e.url, '7tv');
            chCache.set(e.name, { url: e.url, source, state: 'channel', zeroWidth: !!e.zeroWidth });
            if (e.hash) registerHash(e.name, e.hash);
          }
        });
        channelEmoteCaches[ch] = chCache;
      }
      // Evict oldest channel emote caches if exceeds 20
      const channelKeys = Object.keys(channelEmoteCaches);
      if (channelKeys.length > 20) {
        for (const old of channelKeys.slice(0, channelKeys.length - 20)) {
          delete channelEmoteCaches[old];
        }
      }
      log('Channel emote caches:', Object.entries(channelEmoteCaches).map(([c, m]) => `${c}: ${m.size}`).join(', '));

      // Rebuild blockedEmoteNames from loaded hashes
      rebuildBlockedNames();

      log('Loaded', emoteCache.size, 'emotes (inventory:', inventoryEmotes.size, ', hashes:', emoteHashes.size, ')');
    } catch (e) {
      log('Error loading emotes:', e);
    }

    // Also scan DOM for third-party emotes (BTTV, FFZ, 7TV)
    scanDomForEmotes();
  }

  // Scan DOM for emotes rendered in chat — route to the current channel's cache, not global
  function scanDomForEmotes() {
    const ch = getCurrentChannel();
    if (!ch) return;

    // Ensure channel cache exists
    if (!channelEmoteCaches[ch]) channelEmoteCaches[ch] = new Map();
    // Evict oldest if exceeds 20
    const chKeys = Object.keys(channelEmoteCaches);
    if (chKeys.length > 20) {
      delete channelEmoteCaches[chKeys[0]];
    }
    const cache = channelEmoteCaches[ch];

    // Cap per-channel to prevent unbounded growth
    if (cache.size >= 5000) return;

    // Single combined selector — one DOM scan instead of 7 separate querySelectorAll calls
    const combinedSelector = '.chat-line__message img[alt], [class*="chat-line"] img[alt], .seventv-emote, .bttv-emote, .ffz-emote, img.emote, img[data-a-target="emote-name"]';

    let found = 0;
    for (const img of document.querySelectorAll(combinedSelector)) {
      if (cache.size >= 5000) break;
      const name = img.alt || img.getAttribute('data-emote-name');
      const url = img.src;
      if (name && url && !cache.has(name) && !emoteCache.has(name)) {
        const source = detectEmoteSource(url);
        cache.set(name, { url, source, state: 'channel', zeroWidth: false });
        found++;
      }
    }

    if (found > 0) {
      log('Scanned', found, 'emotes from DOM →', ch, ', total:', cache.size);
    }
  }

  // Periodically scan for new emotes
  cleanup.setInterval(scanDomForEmotes, 10000, 'emote-scan');

  // Process text and replace emote codes with images
  // Supports 7TV zero-width (overlay) emotes that stack on base emotes
  function processEmotes(text, channel) {
    if (emoteCache.size === 0 && !channelEmoteCaches[channel]) return escapeHtml(text);

    // Split by whitespace, process each token
    const words = text.split(/(\s+)/);
    const result = [];
    let pendingStack = null; // { base: html, overlays: [html...] }
    let pendingWhitespace = ''; // Accumulate whitespace - don't flush stack on spaces

    for (const word of words) {
      // Whitespace - accumulate, don't flush yet (overlays are space-separated)
      if (/^\s+$/.test(word)) {
        pendingWhitespace += word;
        continue;
      }

      const emote = emoteCache.get(word) || (channel && channelEmoteCaches[channel]?.get(word));
      if (emote) {
        const isBlocked = blockedEmoteNames.has(word);
        const state = isBlocked ? 'blocked' : (emote.state || 'global');
        const source = escapeHtml(emote.source || 'unknown');
        const imgSrc = escapeHtml(getChatResUrl(emote.url)); // Upgrade to 2x/4x based on emote size setting
        const safeHash = emote.hash ? escapeHtml(emote.hash) : '';
        const imgHtml = `<span class="hs-mc-emote-wrapper hs-state-${state}" data-emote-name="${escapeHtml(word)}" data-emote-url="${imgSrc}" data-state="${state}" data-source="${source}"${safeHash ? ` data-emote-hash="${safeHash}"` : ''}><img src="${imgSrc}" alt="${escapeHtml(word)}" title="${escapeHtml(word)}" class="hs-mc-emote hs-emote-${state}" data-emote-name="${escapeHtml(word)}" data-state="${state}" data-source="${source}"></span>`;

        if (emote.zeroWidth) {
          // Overlay emote - stack on previous base (discard whitespace between)
          log('FOUND zeroWidth emote:', word, '| hasBase:', !!pendingStack);
          if (pendingStack) {
            pendingStack.overlays.push(imgHtml);
            pendingWhitespace = '';
          } else {
            // No base to stack on - render standalone
            if (pendingWhitespace) {
              result.push(pendingWhitespace);
              pendingWhitespace = '';
            }
            result.push(imgHtml);
          }
        } else {
          // Base emote - flush previous stack, start new one
          if (pendingStack) {
            result.push(renderEmoteStack(pendingStack));
          }
          if (pendingWhitespace) {
            result.push(pendingWhitespace);
            pendingWhitespace = '';
          }
          pendingStack = { base: imgHtml, overlays: [] };
        }
      } else {
        // Text - flush stack and add text
        if (pendingStack) {
          result.push(renderEmoteStack(pendingStack));
          pendingStack = null;
        }
        if (pendingWhitespace) {
          result.push(pendingWhitespace);
          pendingWhitespace = '';
        }
        // Color @mentions using known chatter colors
        if (word.startsWith('@') && word.length > 1) {
          const name = word.slice(1).replace(/[,.:!?]+$/, '').toLowerCase();
          const color = knownColors.get(name);
          if (color) {
            result.push(`<span style="color:${color};font-weight:bold">${escapeHtml(word)}</span>`);
          } else {
            result.push(escapeHtml(word));
          }
        } else {
          result.push(escapeHtml(word));
        }
      }
    }

    // Flush any remaining stack
    if (pendingStack) {
      result.push(renderEmoteStack(pendingStack));
    }
    if (pendingWhitespace) {
      result.push(pendingWhitespace);
    }

    return result.join('');
  }

  // Render an emote stack (base + overlays)
  function renderEmoteStack(stack) {
    if (stack.overlays.length === 0) {
      return stack.base;
    }
    const overlayHtml = stack.overlays.map(o =>
      o.replace('class="hs-mc-emote ', 'class="hs-mc-emote hs-mc-overlay-emote ')
    ).join('');
    const count = stack.overlays.length + 1;
    return `<span class="hs-mc-emote-stack" data-stack-count="${count}" title="expand"><span class="hs-mc-emote-stack-emotes">${stack.base}${overlayHtml}</span><span class="hs-mc-stack-collapse" title="collapse">\u00d7</span><span class="hs-mc-stack-block-all" title="block all">\u2298</span></span>`;
  }

  function renderAddChannelForm(msgsEl) {
    msgsEl.textContent = ''
    const wrapper = document.createElement('div')
    wrapper.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:10px;color:#808080;font-size:13px;padding:16px;box-sizing:border-box;'

    const title = document.createElement('div')
    title.textContent = 'add channel'
    title.style.cssText = 'font-size:15px;font-weight:700;color:#fff;'
    wrapper.appendChild(title)

    const desc = document.createElement('div')
    desc.textContent = 'enter at least one platform'
    desc.style.cssText = 'font-size:11px;color:#808080;margin-bottom:4px;'
    wrapper.appendChild(desc)

    const makeRow = (label, placeholder) => {
      const row = document.createElement('div')
      row.style.cssText = 'display:flex;align-items:center;gap:6px;width:100%;max-width:320px;'
      const lbl = document.createElement('span')
      lbl.textContent = label
      lbl.style.cssText = 'font-size:11px;font-weight:700;min-width:56px;color:#808080;'
      const input = document.createElement('input')
      input.type = 'text'
      input.placeholder = placeholder
      input.style.cssText = 'flex:1;background:#fff;color:#000;border:1px solid #808080;padding:5px 8px;border-radius:0;font-size:12px;outline:none;font-family:inherit;'
      row.appendChild(lbl)
      row.appendChild(input)
      return { row, input }
    }

    const twitch = makeRow('twitch', 'username')
    const kick = makeRow('kick', 'username')
    const yt = makeRow('youtube', 'username or url')

    wrapper.appendChild(twitch.row)
    wrapper.appendChild(kick.row)
    wrapper.appendChild(yt.row)

    // Error message (between inputs and buttons)
    const errEl = document.createElement('div')
    errEl.style.cssText = 'font-size:11px;color:#ff4444;display:none;'
    errEl.setAttribute('role', 'alert')
    wrapper.appendChild(errEl)

    const btnRow = document.createElement('div')
    btnRow.style.cssText = 'display:flex;gap:8px;margin-top:2px;'

    const addBtn = document.createElement('button')
    addBtn.textContent = 'add'
    addBtn.style.cssText = 'background:#fff;color:#000;border:none;padding:7px 20px;border-radius:0;cursor:pointer;font-weight:600;font-size:12px;font-family:inherit;min-width:80px;'

    const cancelBtn = document.createElement('button')
    cancelBtn.textContent = 'cancel'
    cancelBtn.style.cssText = 'background:#808080;color:#fff;border:none;padding:7px 20px;border-radius:0;cursor:pointer;font-size:12px;font-family:inherit;min-width:80px;'

    btnRow.appendChild(addBtn)
    btnRow.appendChild(cancelBtn)
    wrapper.appendChild(btnRow)

    msgsEl.appendChild(wrapper)

    cancelBtn.addEventListener('click', () => switchTab('live'))

    const showErr = (msg) => { errEl.textContent = msg; errEl.style.display = 'block'; }

    const doAdd = () => {
      errEl.style.display = 'none'
      const twitchVal = twitch.input.value.trim().toLowerCase().replace(/^@/, '')
      const kickVal = kick.input.value.trim().toLowerCase().replace(/^@/, '')
      const ytVal = yt.input.value.trim() ? normalizeYtUrl(yt.input.value.trim()) : ''

      if (!twitchVal && !kickVal && !ytVal) {
        showErr('enter at least one platform')
        return
      }

      const id = twitchVal || kickVal || ('yt-' + Date.now())
      const reserved = ['live', 'feed', 'notifs', 'mentions', 'posts', 'add', 'rotate']
      if (reserved.includes(id)) {
        showErr('reserved name')
        return
      }
      if (config.channels.some(c => (typeof c === 'string' ? c : c.id) === id)) {
        showErr('channel already exists')
        return
      }
      // Check duplicate Twitch username across channels
      if (twitchVal && config.channels.some(c => (typeof c === 'string' ? c : c.twitch) === twitchVal)) {
        showErr('twitch channel already added')
        return
      }

      const channel = { id, twitch: twitchVal, kick: kickVal, youtube: ytVal }
      config.channels.push(channel)
      saveConfig()

      if (twitchVal) {
        irc?.join(twitchVal)
        try {
          chrome.runtime.sendMessage({ type: 'join_channel', platform: 'twitch', channel: twitchVal })
        } catch (e) { /* context invalidated */ }
      }
      if (kickVal) {
        kickChat?.join(kickVal)
      }
      if (ytVal) {
        youtubeLinks.set(id, { url: ytVal, videoId: '', channelName: '' })
        chrome.runtime.sendMessage({ type: 'youtube_ws_subscribe', url: ytVal, channelId: id }).catch(() => {})
      }

      updateTabBar()
      switchTab(id)
    }

    addBtn.addEventListener('click', doAdd)
    // Tab cycles inputs, Enter submits, Escape cancels
    const inputs = [twitch.input, kick.input, yt.input]
    inputs.forEach((inp, i) => {
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') {
          e.preventDefault()
          inputs[(i + (e.shiftKey ? inputs.length - 1 : 1)) % inputs.length].focus()
        }
        if (e.key === 'Enter') doAdd()
        if (e.key === 'Escape') switchTab('live')
      })
    })

    // Auto-focus twitch input
    requestAnimationFrame(() => twitch.input.focus())
  }

  function removeChannel(tabId) {
    const ch = config.channels.find(c => (typeof c === 'string' ? c : c.id) === tabId);
    config.channels = config.channels.filter(c => (typeof c === 'string' ? c : c.id) !== tabId);
    saveConfig();

    const twitchName = typeof ch === 'string' ? ch : ch?.twitch;
    if (twitchName) irc?.part(twitchName);

    const kickName = typeof ch === 'string' ? null : ch?.kick;
    if (kickName) kickChat?.part(kickName);

    // Unsubscribe per-channel YouTube (pass URL as fallback if videoId not yet received)
    if (ch && typeof ch !== 'string' && ch.youtube) {
      const link = youtubeLinks.get(tabId);
      chrome.runtime.sendMessage({
        type: 'youtube_ws_unsubscribe',
        videoId: link?.videoId || '',
        url: ch.youtube,
        channelId: tabId,
      }).catch(() => {});
      youtubeLinks.delete(tabId);
      channelYtMessages.delete(tabId);
    }

    updateTabBar();
    if (currentTab === tabId) switchTab('live');
  }

  function showEditYoutubePrompt(tabId) {
    const ch = config.channels.find(c => (typeof c === 'string' ? c : c.id) === tabId);
    if (!ch || typeof ch === 'string') return;

    const msgsEl = document.getElementById('hs-mc-messages');
    if (!msgsEl) return;
    msgsEl.textContent = '';

    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:10px;color:#808080;font-size:13px;padding:16px;box-sizing:border-box;';

    const title = document.createElement('div');
    title.textContent = 'edit youtube for ' + tabId;
    title.style.cssText = 'font-size:15px;font-weight:700;color:#fff;';
    wrapper.appendChild(title);

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;width:100%;max-width:320px;';
    const lbl = document.createElement('span');
    lbl.textContent = 'youtube';
    lbl.style.cssText = 'font-size:11px;font-weight:700;min-width:56px;color:#808080;';
    const input = document.createElement('input');
    input.type = 'text';
    input.value = ch.youtube || '';
    input.placeholder = 'username or url (leave empty to remove)';
    input.style.cssText = 'flex:1;background:#fff;color:#000;border:1px solid #808080;padding:5px 8px;border-radius:0;font-size:12px;outline:none;font-family:inherit;';
    row.appendChild(lbl);
    row.appendChild(input);
    wrapper.appendChild(row);

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;margin-top:4px;';
    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'save';
    saveBtn.style.cssText = 'background:#fff;color:#000;border:none;padding:7px 20px;border-radius:0;cursor:pointer;font-weight:600;font-size:12px;font-family:inherit;min-width:80px;';
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'cancel';
    cancelBtn.style.cssText = 'background:#808080;color:#fff;border:none;padding:7px 20px;border-radius:0;cursor:pointer;font-size:12px;font-family:inherit;min-width:80px;';
    btnRow.appendChild(saveBtn);
    btnRow.appendChild(cancelBtn);
    wrapper.appendChild(btnRow);
    msgsEl.appendChild(wrapper);

    cancelBtn.addEventListener('click', () => switchTab(tabId));
    const doSave = () => {
      const newUrl = input.value.trim();
      // Unsubscribe old (pass URL as fallback if videoId not yet received)
      const oldLink = youtubeLinks.get(tabId);
      const oldUrl = ch.youtube || oldLink?.url || '';
      chrome.runtime.sendMessage({
        type: 'youtube_ws_unsubscribe',
        videoId: oldLink?.videoId || '',
        url: oldUrl,
        channelId: tabId,
      }).catch(() => {});
      youtubeLinks.delete(tabId);
      channelYtMessages.delete(tabId);

      const normalizedUrl = newUrl ? normalizeYtUrl(newUrl) : ''
      ch.youtube = normalizedUrl;
      saveConfig();

      if (normalizedUrl) {
        youtubeLinks.set(tabId, { url: normalizedUrl, videoId: '', channelName: '' });
        chrome.runtime.sendMessage({ type: 'youtube_ws_subscribe', url: normalizedUrl, channelId: tabId }).catch(() => {});
      }
      switchTab(tabId);
    };
    saveBtn.addEventListener('click', doSave);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSave(); if (e.key === 'Escape') switchTab(tabId); });
    requestAnimationFrame(() => { input.focus(); input.select(); });
  }

  function updateTabIndicator(tabId) {
    const tab = tabBarElement?.querySelector(`[data-tab="${tabId}"]`);
    if (tab && currentTab !== tabId) {
      tab.classList.add('has-new');
    }
  }

  // ============================================
  // LIVE STATUS POLLING
  // ============================================

  let liveStatusInterval = null;

  function startLiveStatusPolling() {
    updateLiveStatus();
    liveStatusInterval = cleanup.setInterval(updateLiveStatus, 30000);
  }

  async function updateLiveStatus() {
    if (!tabBarElement) return;
    const channels = config.channels
      .map(ch => typeof ch === 'string' ? ch : ch.twitch || ch.id)
      .filter(Boolean);
    if (channels.length === 0) return;

    try {
      const data = await chrome.runtime.sendMessage({ type: 'fetch_live_status', channels });
      if (!data?.live) return;
      const liveSet = new Set(data.live.map(c => c.toLowerCase()));

      config.channels.forEach(ch => {
        const id = typeof ch === 'string' ? ch : ch.id;
        const twitch = typeof ch === 'string' ? ch : ch.twitch || ch.id;
        const tab = tabBarElement?.querySelector(`[data-tab="${id}"]`);
        if (tab) tab.dataset.live = String(liveSet.has(twitch.toLowerCase()));
      });
    } catch (e) { /* network error, skip */ }
  }

  // ============================================
  // USERNAME & MENTIONS
  // ============================================

  /**
   * Get current channel from URL
   */
  function getCurrentChannel() {
    // Match /username or /popout/username/chat or /embed/username/chat
    const match = location.pathname.match(/^\/(?:popout\/|embed\/)?([a-zA-Z0-9_]+)/);
    if (match && match[1]) {
      const channel = match[1].toLowerCase();
      // Skip non-channel pages
      if (['directory', 'settings', 'videos', 'moderator', 'subscriptions'].includes(channel)) {
        return null;
      }
      return channel;
    }
    return null;
  }

  function getCurrentUsername() {
    // Method 1: localStorage displayName
    try {
      const displayName = localStorage.getItem('twilight.user.displayName');
      if (displayName) {
        const name = displayName.replace(/"/g, '').trim();
        if (name && name.length > 0 && name.length < 30) {
          return name.toLowerCase();
        }
      }
    } catch (e) {}

    // Method 2: localStorage user object
    try {
      const twilight = localStorage.getItem('twilight.user');
      if (twilight) {
        const data = JSON.parse(twilight);
        if (data?.displayName) return data.displayName.toLowerCase();
      }
    } catch (e) {}

    // Method 3: Twitch 'name' cookie (works in popout chat)
    try {
      const cookies = document.cookie.split(';');
      for (const cookie of cookies) {
        const [key, value] = cookie.trim().split('=');
        if (key === 'name' && value) {
          const name = decodeURIComponent(value).toLowerCase();
          if (name.length > 0 && name.length < 30) {
            log('Found username from cookie:', name);
            return name;
          }
        }
      }
    } catch (e) {}

    return null;
  }

  function isMention(msg) {
    if (!currentUsername) return false;
    const text = msg.text.toLowerCase();
    return text.includes('@' + currentUsername) ||
           new RegExp(`\\b${currentUsername}\\b`, 'i').test(text);
  }

  /**
   * Scan existing chat messages in DOM for mentions (on load)
   */
  function scanExistingMentions() {
    if (!currentUsername) {
      log('Cannot scan mentions - no username');
      return;
    }

    const messages = document.querySelectorAll('[data-a-target="chat-line-message"]');
    log('Scanning', messages.length, 'existing messages for mentions of', currentUsername);

    let found = 0;
    messages.forEach(msgEl => {
      const textContent = msgEl.textContent?.toLowerCase() || '';
      if (textContent.includes('@' + currentUsername) ||
          new RegExp(`\\b${currentUsername}\\b`, 'i').test(textContent)) {
        // Extract username and message
        const usernameEl = msgEl.querySelector('[data-a-target="chat-message-username"]');
        const username = usernameEl?.textContent || 'unknown';
        const messageEl = msgEl.querySelector('[data-a-target="chat-message-text"]');
        const text = messageEl?.textContent || textContent;

        mentionsBuffer.push({
          user: username,
          text: text,
          color: '#fff',
          channel: getCurrentChannel() || 'live',
          time: Date.now() - (messages.length - found) * 1000 // Approximate time
        });
        found++;
      }
    });

    if (found > 0) {
      log('Found', found, 'existing mentions');
      updateTabIndicator('mentions');
    }
  }

  // ============================================
  // STORAGE
  // ============================================

  async function loadConfig() {
    try {
      const s = await chrome.storage.local.get([STORAGE_KEY]);
      config = { channels: [], enabled: true, ...s[STORAGE_KEY] };
      // Migrate old string channels to object format
      let needsSave = false;
      if (config.channels.some(c => typeof c === 'string')) {
        config.channels = config.channels.map(ch =>
          typeof ch === 'string' ? { id: ch, twitch: ch, kick: '', youtube: '' } : ch
        );
        needsSave = true;
      }
      if (needsSave) saveConfig();
      // Subscribe per-channel YouTube links
      for (const ch of config.channels) {
        if (typeof ch !== 'string' && ch.youtube) {
          youtubeLinks.set(ch.id, { url: ch.youtube, videoId: '', channelName: '' });
          chrome.runtime.sendMessage({ type: 'youtube_ws_subscribe', url: ch.youtube, channelId: ch.id }).catch(() => {});
        }
      }
    } catch (e) {}
  }

  async function saveConfig() {
    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: config });
    } catch (e) {}
  }

  // ============================================
  // POST LISTENER
  // ============================================

  function listenForPosts() {
    cleanup.addEventListener(window, 'message', (e) => {
      if (e.origin !== location.origin) return;
      if (e.data?.type === 'heatsync-tweet') {
        const post = e.data.tweet;
        postsBuffer.push({
          user: post.username,
          text: post.content,
          color: '#f23c3c',
          time: Date.now()
        });
        if (postsBuffer.length > MAX_BUFFER + 50) postsBuffer.splice(0, postsBuffer.length - MAX_BUFFER);

        if (currentTab === 'posts') {
          renderMessages('posts');
        } else {
          updateTabIndicator('posts');
        }
      }
    });
  }

  // ============================================
  // TABS POSITION SETTING
  // ============================================

  async function loadTabsPosition() {
    try {
      const stored = await chrome.storage.local.get(['ui_settings']);
      // Migration: tabsOnRight → tabPosition
      if (stored.ui_settings?.tabsOnRight !== undefined && stored.ui_settings?.tabPosition === undefined) {
        tabPosition = stored.ui_settings.tabsOnRight ? 'right' : 'top';
        stored.ui_settings.tabPosition = tabPosition;
        delete stored.ui_settings.tabsOnRight;
        await chrome.storage.local.set({ ui_settings: stored.ui_settings });
        log('Migrated tabsOnRight to tabPosition:', tabPosition);
      } else if (stored.ui_settings?.tabPosition !== undefined) {
        tabPosition = stored.ui_settings.tabPosition;
      }
      applyTabsPosition();
    } catch (e) {
      log('Error loading tabs position:', e);
    }
  }

  let _savedActiveTab = null;
  const BUILTIN_TABS = ['live', 'feed', 'notifs', 'mentions', 'posts', 'add'];
  async function loadActiveTab() {
    try {
      const stored = await chrome.storage.local.get(['ui_settings']);
      const saved = stored.ui_settings?.activeTab || 'live';
      // Validate: must be a built-in tab or a configured channel (never restore 'add')
      const channelIds = config.channels.map(c => typeof c === 'string' ? c : c.id);
      _savedActiveTab = (saved !== 'add' && (BUILTIN_TABS.includes(saved) || channelIds.includes(saved)))
        ? saved : 'live';
    } catch (e) {
      _savedActiveTab = 'live';
    }
  }

  let _applyingPosition = false
  function applyTabsPosition() {
    if (_applyingPosition) return
    _applyingPosition = true
    try { _applyTabsPositionInner() } finally { _applyingPosition = false }
  }
  function _applyTabsPositionInner() {
    document.body.classList.remove('hs-tabs-top', 'hs-tabs-right', 'hs-tabs-bottom', 'hs-tabs-left');
    if (tabPosition !== 'top') {
      document.body.classList.add(`hs-tabs-${tabPosition}`);
    }

    // Re-apply column width (accounts for vertical tab offset)
    applyChatWidth()

    log('Tabs position:', tabPosition);
  }

  function rotateTabPosition() {
    const positions = ['top', 'right', 'bottom', 'left'];
    const currentIndex = positions.indexOf(tabPosition);
    const prev = tabPosition
    tabPosition = positions[(currentIndex + 1) % positions.length];
    log('rotate:', prev, '→', tabPosition)

    applyTabsPosition();
    saveTabPosition();
    renderMessages(currentTab);
  }

  async function saveTabPosition() {
    try {
      const stored = await chrome.storage.local.get(['ui_settings']);
      const settings = stored.ui_settings || {};
      settings.tabPosition = tabPosition;
      delete settings.tabsOnRight; // Remove old setting
      await chrome.storage.local.set({ ui_settings: settings });
    } catch (e) {
      log('Error saving tab position:', e);
    }
  }

  function listenForSettingsChanges() {
    if (window._hsMcSettingsListener) return;
    window._hsMcSettingsListener = true;

    // Listen for messages from popup
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === 'ui_settings_changed' && msg.settings) {
        log('Settings changed via message:', msg.settings);
        if (msg.settings.tabPosition !== undefined && msg.settings.tabPosition !== tabPosition) {
          tabPosition = msg.settings.tabPosition;
          applyTabsPosition();
        }
      }
      // Listen for emote updates from background
      if (msg.type === 'global_emotes_update' || msg.type === 'channel_emotes_update') {
        log('Emotes updated via message, reloading...');
        loadEmotes().then(() => renderMessages(currentTab));
      }
    });

    // Also listen for storage changes (more reliable)
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;

      // UI settings
      if (changes.ui_settings) {
        const newSettings = changes.ui_settings.newValue || {};
        log('Settings changed via storage:', newSettings);
        if (newSettings.tabPosition !== undefined && newSettings.tabPosition !== tabPosition) {
          tabPosition = newSettings.tabPosition;
          applyTabsPosition();
        }
      }

      // Emote updates - reload when storage changes
      if (changes.global_emotes || changes.channel_emotes_map || changes.emote_inventory) {
        log('Emotes updated via storage, reloading...');
        loadEmotes().then(() => {
          // Re-render current tab to show new emotes
          if (!isScrolledUp) {
            renderMessages(currentTab);
          }
        });
      }

      // Blocked emotes
      if (changes.blocked_emotes) {
        loadBlockedEmotes().then(() => {
          if (!isScrolledUp) {
            renderMessages(currentTab);
          }
        });
      }
    });
  }

  // ============================================
  // OFFLINE DETECTION
  // ============================================

  function detectOfflineState() {
    if (isKick) return
    // Popout chat has no video — don't mark as offline
    if (location.pathname.match(/^\/(popout|embed)\//)) return

    let wasOffline = null

    function checkOffline() {
      const playerOffline = !!document.querySelector('.channel-root__player--offline')
      const isLive = !playerOffline && !!document.querySelector(
        '[class*="stream-type-indicator"], [data-a-target="player-overlay-click-handler"] video, .video-player video'
      )
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
      if (++fastChecks >= 10) clearInterval(fastId)
    }, 1000)

    // Steady-state polling
    cleanup.setInterval(checkOffline, 5000)

    // MutationObserver for instant transitions
    const root = document.querySelector('[class*="channel-root"]') || document.body
    const observer = new MutationObserver(() => checkOffline())
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })
    cleanup.trackObserver(observer)
  }

  // ============================================
  // MAIN INITIALIZATION
  // ============================================

  let mcInitialized = false;
  async function init() {
    let isPopout = false;
    if (isKick) {
      // Kick: run on channel pages (/<channel>) or popout
      const isKickChannel = location.pathname.match(/^\/[a-zA-Z0-9_-]+\/?$/);
      if (!isKickChannel) return;
      const kickPath = location.pathname.replace(/\/$/, '').slice(1).toLowerCase();
      if (['categories', 'following', 'search', 'settings'].includes(kickPath)) return;
    } else {
      // Twitch: Run on channel pages AND popout chat
      const isChannelPage = location.pathname.match(/^\/[a-zA-Z0-9_]+\/?$/);
      isPopout = !!location.pathname.match(/^\/(popout|embed)\/[a-zA-Z0-9_]+\/chat/);
      if (!isChannelPage && !isPopout) return;
      const pathName = location.pathname.replace(/\/$/, '').slice(1).toLowerCase();
      if (['directory', 'settings', 'videos', 'moderator', 'subscriptions', 'downloads', 'search'].includes(pathName)) return;

    }
    if (mcInitialized) return;
    mcInitialized = true;

    await loadConfig();
    if (!config.enabled) return;

    log('Initializing...');

    // Add popout class to body for CSS targeting
    if (isPopout) {
      document.body.classList.add('hs-popout');
    }

    currentUsername = getCurrentUsername();
    log('Username:', currentUsername);

    // Load muted users from chrome.storage.local
    try {
      const stored = await chrome.storage.local.get(['heatsync_mc_muted']);
      if (stored.heatsync_mc_muted && Array.isArray(stored.heatsync_mc_muted)) {
        mutedUsers = new Set(stored.heatsync_mc_muted);
      }
    } catch (e) {
      log('Error loading muted users:', e);
    }

    injectStyles();
    detectOfflineState();
    await loadActiveTab();
    await loadTabsPosition();
    await loadEmoteSize();
    await loadWysiwygSetting();
    await loadBlockedEmotes();
    await loadEmotes();

    // Request background to re-send channel emotes (may have been fetched before we loaded)
    try {
      chrome.runtime.sendMessage({ type: 'get_channel_emotes' });
    } catch (e) { /* context invalidated */ }

    setupEmoteTooltipHandlers();
    setupUserTooltipHandlers();
    listenForPosts();
    listenForSettingsChanges();

    // Load heatsync auth state
    loadHsAuth();

    // Listen for social tab events from background
    listenForSocialEvents();

    // Initialize IRC (runs on both Twitch and Kick — cross-platform relay)
    irc = new IRC();
    irc.connect();

    // Initialize Kick chat (runs on both platforms — cross-platform relay)
    kickChat = new KickChat();
    kickChat.connect();

    // Auto-join current channel on native platform
    const currentChannel = getCurrentChannel();
    if (currentChannel) {
      if (hostPlatform === 'twitch') {
        irc.join(currentChannel);
        kickChat.join(currentChannel); // Join same-name Kick channel if it exists
      } else if (hostPlatform === 'kick') {
        kickChat.join(currentChannel);
      }
      log('Auto-joined current channel:', currentChannel);
    }

    config.channels.forEach(ch => {
      const twitchName = typeof ch === 'string' ? ch : ch.twitch;
      const kickName = typeof ch === 'string' ? null : ch.kick;
      if (twitchName) {
        irc.join(twitchName);
        try {
          chrome.runtime.sendMessage({ type: 'join_channel', platform: 'twitch', channel: twitchName });
        } catch (e) { /* context invalidated */ }
      }
      if (kickName) {
        kickChat.join(kickName);
      }
    });

    // Scan existing chat for mentions (before IRC catches new ones)
    if (hostPlatform === 'twitch') {
      setTimeout(() => scanExistingMentions(), 2000);
    }

    // Handle incoming IRC messages
    irc.on('message', (msg) => {
      if (isMention(msg)) {
        mentionsBuffer.push(msg);
        if (mentionsBuffer.length > MAX_BUFFER + 50) mentionsBuffer.splice(0, mentionsBuffer.length - MAX_BUFFER);

        if (currentTab === 'mentions') {
          if (!appendMessage(msg, 'mentions')) renderMessages('mentions');
        } else {
          updateTabIndicator('mentions');
        }
      }

      // Channel tab routing
      const chTabId = config.channels.find(ch => (typeof ch === 'string' ? ch : ch.twitch) === msg.channel);
      const tabId = typeof chTabId === 'string' ? chTabId : chTabId?.id;
      if (tabId && currentTab === tabId) {
        if (!appendMessage(msg, tabId)) renderMessages(tabId);
      } else if (tabId) {
        updateTabIndicator(tabId);
      }

      // Live tab: show if this is the current channel's Twitch chat
      if (currentTab === 'live' && msg.channel === getCurrentChannel()) {
        if (!appendMessage(msg, 'live')) renderMessages('live');
      }
    });

    // Handle incoming Kick messages
    kickChat.on('message', (msg) => {
      if (isMention(msg)) {
        mentionsBuffer.push(msg);
        if (mentionsBuffer.length > MAX_BUFFER + 50) mentionsBuffer.splice(0, mentionsBuffer.length - MAX_BUFFER);

        if (currentTab === 'mentions') {
          if (!appendMessage(msg, 'mentions')) renderMessages('mentions');
        } else {
          updateTabIndicator('mentions');
        }
      }

      // Channel tab routing — find config entry where ch.kick matches
      const chConfig = config.channels.find(ch => typeof ch !== 'string' && ch.kick === msg.channel);
      const tabId = chConfig?.id;
      if (tabId && currentTab === tabId) {
        if (!appendMessage(msg, tabId)) renderMessages(tabId);
      } else if (tabId) {
        updateTabIndicator(tabId);
      }

      // Live tab: on Kick, show if channel matches; on Twitch, show if config maps current channel
      const curCh = getCurrentChannel();
      if (currentTab === 'live') {
        if (hostPlatform === 'kick' && msg.channel === curCh) {
          if (!appendMessage(msg, 'live')) renderMessages('live');
        } else if (hostPlatform === 'twitch') {
          // Show Kick messages on live tab if current Twitch channel has a linked Kick channel
          const linkedKick = config.channels.find(ch => typeof ch !== 'string' && ch.twitch === curCh && ch.kick === msg.channel);
          if (linkedKick || msg.channel === curCh) {
            if (!appendMessage(msg, 'live')) renderMessages('live');
          }
        }
      }
    });

    if (isKick) {
      // Kick: no React hook needed, just inject directly
      let kickAttempts = 0;
      const tryInjectKick = () => {
        kickAttempts++;
        const chatroom = document.getElementById('chatroom') || document.querySelector('[class*="chatroom"]');
        if (chatroom) {
          ensureUIElements();
          switchTab(_savedActiveTab || 'live');
          startLayoutWatcher();
        } else if (kickAttempts < 30) {
          setTimeout(tryInjectKick, 500);
        } else {
          log('Failed to find Kick chatroom after 30 attempts');
        }
      };
      tryInjectKick();
    } else {
      // Twitch: try to hook into React, fall back to MutationObserver
      tryHookReact();
    }
  }

  /**
   * Attempt to hook React components, with fallback
   */
  function tryHookReact() {
    let attempts = 0;
    const maxAttempts = 30;

    const tryHook = () => {
      attempts++;

      // First, try to find and patch the chat room component
      const chatRoom = findChatRoomComponent();
      if (chatRoom) {
        log('Found chat room component');
        chatRoomComponent = chatRoom;
        patchChatRoomRender(chatRoom);
        ensureUIElements();
        switchTab(_savedActiveTab || 'live');
        startLayoutWatcher();
        return;
      }

      // Fallback: just inject elements directly (support popout chat)
      const chatContainer = document.querySelector('[class*="chat-room__content"]') ||
                           document.querySelector('[data-a-target="chat-room-component"]') ||
                           document.querySelector('.chat-shell') ||
                           document.querySelector('[class*="stream-chat"]') ||
                           document.querySelector('.chat-room');

      if (chatContainer) {
        log('Using fallback DOM injection');
        ensureUIElements();
        switchTab(_savedActiveTab || 'live');
        startLayoutWatcher();
        return;
      }

      if (attempts < maxAttempts) {
        setTimeout(tryHook, 500);
      } else {
        log('Failed to find chat components after', maxAttempts, 'attempts');
      }
    };

    tryHook();
  }

  /**
   * Watch for layout changes and re-inject elements if needed
   * This handles theatre mode, popouts, SPA navigation
   */
  function startLayoutWatcher() {
    // Periodic check — only needed for container removal (rare, SPA nav)
    cleanup.setInterval(() => {
      if (spaReinitializing) return;
      if (!document.getElementById('hs-mc-container')) {
        log('Container missing, re-injecting...');
        tabBarElement = null;
        overlayElement = null;
        inputBarElement = null;
        resizeObserver = null;
        ensureUIElements();
        updateTabBar();
        renderMessages(currentTab);
      }
    }, 1000, 'layout-check');

    // MutationObserver — only watch for container removal
    cleanup.trackObserver(new MutationObserver((mutations) => {
      if (spaReinitializing) return;
      for (const mutation of mutations) {
        for (const node of mutation.removedNodes) {
          if (node.id === 'hs-mc-container' && !document.contains(node)) {
            log('Container removed, re-injecting...');
            tabBarElement = null;
            overlayElement = null;
            inputBarElement = null;
            resizeObserver = null;
            cleanup.setTimeout(() => {
              ensureUIElements();
              updateTabBar();
              renderMessages(currentTab);
            }, 100, 'container-reinject');
            return;
          }
        }
      }
    }), 'layout-observer').observe(document.body, { childList: true, subtree: true });
  }

  // ============================================
  // STARTUP
  // ============================================

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { signal: mcSignal });
  } else {
    init();
  }

  // SPA navigation handler
  let lastPath = location.pathname;
  let spaReinitializing = false;
  cleanup.setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      log('Navigation detected, reinitializing...');

      // Flag prevents layout watcher from re-injecting elements we're about to remove
      spaReinitializing = true;

      // Close old read-only IRC to prevent zombie WebSocket reconnect loops
      // NOTE: auth IRC (for sending) is NOT killed here — it survives SPA navigation
      if (irc?.ws) {
        irc.ws.onclose = null; // prevent auto-reconnect
        irc.ws.close();
      }
      irc = null;

      // Clean up — remove entire container (our elements are inside it)
      document.getElementById('hs-mc-container')?.remove();
      tabBarElement = null;
      overlayElement = null;
      inputBarElement = null;
      if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
      isHooked = false;
      mcInitialized = false; // Allow init() to run again

      // Reset social tab state (stale on nav)
      feedLoaded = false;
      feedLoading = false;
      feedMessages = [];
      feedPage = 1;
      feedHasMore = true;
      feedLastFetch = 0;
      notifLoaded = false;
      notifMessages = [];
      expandedThreadId = null;
      threadReplies = [];
      // Reset feed scroll listener flag (new DOM element)
      const oldMsgs = document.getElementById('hs-mc-messages');
      if (oldMsgs) oldMsgs._hsFeedScroll = false;

      // Reinitialize after short delay
      cleanup.setTimeout(() => {
        spaReinitializing = false;
        init();
      }, 1000, 'spa-reinit');
    }
  }, 500, 'spa-nav-check');

})();
