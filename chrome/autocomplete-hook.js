(function() {
  'use strict';

  const DEBUG = false
  const log = DEBUG ? console.log.bind(console, '[heatsync-ac]') : () => {}

  // Kill previous instance on extension reload (old hooks accumulate otherwise)
  if (window.__heatsyncAcLifecycle) {
    try { window.__heatsyncAcLifecycle.abort() } catch (_) {}
  }

  // Lifecycle controller — abort() tears down ALL listeners, timers, observers
  const lifecycle = new AbortController()
  window.__heatsyncAcLifecycle = lifecycle
  const acSignal = lifecycle.signal
  const _timers = { intervals: [], timeouts: [], observers: [] }
  acSignal.addEventListener('abort', () => {
    _timers.intervals.forEach(clearInterval)
    _timers.timeouts.forEach(clearTimeout)
    _timers.observers.forEach(o => o.disconnect())
    _timers.intervals.length = 0
    _timers.timeouts.length = 0
    _timers.observers.length = 0
  })
  window.addEventListener('pagehide', () => lifecycle.abort())

  const cleanup = {
    setInterval(fn, ms) { const id = setInterval(fn, ms); _timers.intervals.push(id); return id },
    setTimeout(fn, ms) { const id = setTimeout(fn, ms); _timers.timeouts.push(id); return id },
    addEventListener(target, event, handler) {
      target.addEventListener(event, handler, { signal: acSignal })
    },
    trackObserver(obs) { _timers.observers.push(obs); return obs },
  }

  // Inject CSS to make chat input emote spans auto-size to their content
  // BULLETPROOF: Wide emotes must expand span to fit, never clip
  const style = document.createElement('style');
  style.textContent = `
    /* Emote void elements in chat input - must be inline-block to stay on same line */
    [data-slate-editor="true"] [data-slate-void="true"] {
      display: inline-block !important;
      vertical-align: middle !important;
    }
    /* Emote button wrapper - fit content width */
    [data-slate-editor="true"] .chat-line__message--emote-button {
      display: inline-block !important;
      width: auto !important;
      min-width: auto !important;
      padding: 0 !important;
      margin: 0 !important;
      vertical-align: middle !important;
    }
    /* Emote images - respect Twitch's emote size setting */
    [data-slate-editor="true"] img.chat-line__message--emote {
      display: inline-block !important;
      vertical-align: middle !important;
      /* No forced size - inherits from Twitch settings */
    }
    /* 7TV/BTTV emotes - no forced size, respect user's Twitch setting */
    img[src*="7tv.app"],
    img[src*="betterttv.net"],
    img[src*="frankerfacez"] {
      /* Inherit from Twitch's emote size setting */
    }
    /* Hide autocomplete dropdown during heatsync cycling */
    body.heatsync-cycling .chat-input-tray__open {
      display: none !important;
    }
    /* Hide ALL text in void elements during cycling - prevents flash completely */
    body.heatsync-cycling [data-slate-editor="true"] [data-slate-void="true"] {
      color: transparent !important;
    }
    body.heatsync-cycling [data-slate-editor="true"] [data-slate-void="true"] span {
      color: transparent !important;
    }
  `;
  document.head.appendChild(style);

  // ========== CRITICAL: Intercept img.src setter to fix broken URLs ==========
  // Use FFZ's exact format for preview creation
  // Format: __FFZ__setId::emoteId__FFZ__ where setId must be numeric for Twitch validation
  const HEATSYNC_SET_ID = '999999'; // Fake FFZ set ID (high number to avoid collision)
  const HEATSYNC_PREFIX = '__FFZ__' + HEATSYNC_SET_ID + '::';
  const HEATSYNC_SUFFIX = '__FFZ__';

  // Track insertion state to prevent autocomplete pollution (7TV-style approach)
  // After inserting an emote, Twitch re-reads input and may trigger autocomplete with emote name
  const recentlyInserted = new Set();  // Track recently inserted emote names
  let lastInsertedEmote = null;  // Name of last inserted emote
  let insertionCount = 0;  // Incrementing counter to track unique insertions
  let lastUserInput = '';  // Track actual user typing to detect real input vs pollution

  // Username tracking for tab completion
  const recentUsernames = new Set();  // Track usernames from chat (max 200)
  const MAX_USERNAMES = 200;

  // Clean up tracking sets on page teardown
  acSignal.addEventListener('abort', () => {
    recentlyInserted.clear()
    recentUsernames.clear()
    lastInsertedEmote = null
    insertionCount = 0
    lastUserInput = ''
  })

  /**
   * Find a username matching the search term
   * Uses window.heatsyncKnownChatters from content.js (populated from chat messages)
   */
  function findUsernameMatch(search) {
    if (!search || search.length < 2) return null;
    const searchLower = search.toLowerCase();

    // Get chatters from content.js
    const chatters = window.heatsyncKnownChatters;
    if (!chatters || chatters.size === 0) {
      log(' 👤 No known chatters for username completion');
      return null;
    }

    // Find prefix match first (exact start)
    for (const [username] of chatters) {
      if (username.toLowerCase().startsWith(searchLower)) {
        return username;
      }
    }

    // Then try substring match
    for (const [username] of chatters) {
      if (username.toLowerCase().includes(searchLower)) {
        return username;
      }
    }

    return null;
  }

  // Emoji shortcodes for :name: autocomplete (Discord/Slack style)
  const EMOJI_MAP = {
    // Smileys
    smile: '😊', grin: '😁', joy: '😂', rofl: '🤣', wink: '😉', blush: '😊',
    heart_eyes: '😍', kissing_heart: '😘', yum: '😋', stuck_out_tongue: '😛',
    thinking: '🤔', neutral_face: '😐', expressionless: '😑', unamused: '😒',
    sweat: '😓', pensive: '😔', confused: '😕', upside_down: '🙃', money_mouth: '🤑',
    astonished: '😲', flushed: '😳', frowning: '😦', anguished: '😧', fearful: '😨',
    cold_sweat: '😰', disappointed_relieved: '😥', cry: '😢', sob: '😭', scream: '😱',
    tired_face: '😫', sleepy: '😪', sleeping: '😴', drooling: '🤤', mask: '😷',
    nerd: '🤓', sunglasses: '😎', cowboy: '🤠', clown: '🤡', poop: '💩',
    skull: '💀', ghost: '👻', alien: '👽', robot: '🤖', smiling_imp: '😈', imp: '👿',
    angry: '😠', rage: '😡', triumph: '😤', exploding_head: '🤯', hot: '🥵', cold: '🥶',
    woozy: '🥴', shushing: '🤫', lying: '🤥', no_mouth: '😶', zipper_mouth: '🤐',
    vomiting: '🤮', sneezing: '🤧', partying: '🥳', pleading: '🥺', rolling_eyes: '🙄',
    smirk: '😏', persevere: '😣', confounded: '😖', worried: '😟', slightly_frowning: '🙁',
    slightly_smiling: '🙂', innocent: '😇', angel: '😇', devil: '😈', star_struck: '🤩',
    zany: '🤪', monocle: '🧐', raised_eyebrow: '🤨', // Faces
    // Gestures
    thumbsup: '👍', thumbsdown: '👎', ok_hand: '👌', pinching: '🤏', victory: '✌️',
    crossed_fingers: '🤞', love_you: '🤟', metal: '🤘', call_me: '🤙', point_left: '👈',
    point_right: '👉', point_up: '👆', point_down: '👇', middle_finger: '🖕',
    raised_hand: '✋', wave: '👋', clap: '👏', open_hands: '👐', raised_hands: '🙌',
    palms_up: '🤲', pray: '🙏', handshake: '🤝', nail_care: '💅', selfie: '🤳',
    muscle: '💪', fist: '✊', punch: '👊', writing_hand: '✍️', // Gestures
    // Hearts
    heart: '❤️', orange_heart: '🧡', yellow_heart: '💛', green_heart: '💚',
    blue_heart: '💙', purple_heart: '💜', black_heart: '🖤', white_heart: '🤍',
    brown_heart: '🤎', broken_heart: '💔', heart_exclamation: '❣️', two_hearts: '💕',
    revolving_hearts: '💞', heartbeat: '💓', heartpulse: '💗', sparkling_heart: '💖',
    cupid: '💘', gift_heart: '💝', // Hearts
    // Nature
    sun: '☀️', sunny: '☀️', sunset: '🌅', sunrise: '🌅', rainbow: '🌈',
    cloud: '☁️', rain: '🌧️', thunder: '⛈️', snow: '❄️', snowflake: '❄️',
    fire: '🔥', droplet: '💧', ocean: '🌊', star: '⭐', sparkles: '✨',
    moon: '🌙', full_moon: '🌕', crescent_moon: '🌙', earth: '🌍', globe: '🌎',
    comet: '☄️', // Nature
    // Animals
    dog: '🐕', cat: '🐈', mouse: '🐁', hamster: '🐹', rabbit: '🐰', fox: '🦊',
    bear: '🐻', panda: '🐼', koala: '🐨', tiger: '🐯', lion: '🦁', cow: '🐄',
    pig: '🐷', frog: '🐸', monkey: '🐵', see_no_evil: '🙈', hear_no_evil: '🙉',
    speak_no_evil: '🙊', chicken: '🐔', penguin: '🐧', bird: '🐦', eagle: '🦅',
    duck: '🦆', owl: '🦉', bat: '🦇', wolf: '🐺', horse: '🐴', unicorn: '🦄',
    bee: '🐝', bug: '🐛', butterfly: '🦋', snail: '🐌', shell: '🐚',
    crab: '🦀', shrimp: '🦐', squid: '🦑', octopus: '🐙', turtle: '🐢',
    snake: '🐍', lizard: '🦎', scorpion: '🦂', spider: '🕷️', whale: '🐳',
    dolphin: '🐬', fish: '🐟', shark: '🦈', elephant: '🐘', gorilla: '🦍',
    deer: '🦌', zebra: '🦓', giraffe: '🦒', hedgehog: '🦔', sloth: '🦥',
    otter: '🦦', skunk: '🦨', kangaroo: '🦘', badger: '🦡', // Animals
    // Food
    apple: '🍎', pear: '🍐', orange: '🍊', lemon: '🍋', banana: '🍌', watermelon: '🍉',
    grapes: '🍇', strawberry: '🍓', blueberries: '🫐', melon: '🍈', cherries: '🍒',
    peach: '🍑', mango: '🥭', pineapple: '🍍', coconut: '🥥', kiwi: '🥝',
    tomato: '🍅', eggplant: '🍆', avocado: '🥑', broccoli: '🥦', carrot: '🥕',
    corn: '🌽', hot_pepper: '🌶️', cucumber: '🥒', garlic: '🧄', onion: '🧅',
    potato: '🥔', sweet_potato: '🍠', croissant: '🥐', baguette: '🥖', bread: '🍞',
    pretzel: '🥨', bagel: '🥯', pancakes: '🥞', waffle: '🧇', cheese: '🧀',
    egg: '🥚', bacon: '🥓', steak: '🥩', poultry_leg: '🍗', burger: '🍔',
    fries: '🍟', pizza: '🍕', hotdog: '🌭', sandwich: '🥪', taco: '🌮',
    burrito: '🌯', falafel: '🧆', sushi: '🍣', ramen: '🍜', spaghetti: '🍝',
    curry: '🍛', rice: '🍚', bento: '🍱', dumpling: '🥟', cookie: '🍪',
    cake: '🎂', cupcake: '🧁', pie: '🥧', chocolate: '🍫', candy: '🍬',
    lollipop: '🍭', donut: '🍩', icecream: '🍦', shaved_ice: '🍧', coffee: '☕',
    tea: '🍵', beer: '🍺', wine: '🍷', cocktail: '🍸', champagne: '🍾',
    milk: '🥛', juice: '🧃', // Food
    // Activities
    soccer: '⚽', basketball: '🏀', football: '🏈', baseball: '⚾', tennis: '🎾',
    volleyball: '🏐', rugby: '🏉', bowling: '🎳', golf: '⛳', ping_pong: '🏓',
    badminton: '🏸', hockey: '🏒', cricket: '🏏', lacrosse: '🥍', boxing: '🥊',
    martial_arts: '🥋', wrestling: '🤼', fencing: '🤺', ski: '🎿', snowboard: '🏂',
    sled: '🛷', curling: '🥌', dart: '🎯', billiards: '🎱', video_game: '🎮',
    joystick: '🕹️', slot_machine: '🎰', game_die: '🎲', chess: '♟️', jigsaw: '🧩',
    teddy_bear: '🧸', // Activities
    // Objects
    phone: '📱', computer: '💻', keyboard: '⌨️', mouse_computer: '🖱️', laptop: '💻',
    camera: '📷', video_camera: '📹', tv: '📺', radio: '📻', microphone: '🎤',
    headphones: '🎧', speaker: '🔊', mute: '🔇', bell: '🔔', no_bell: '🔕',
    bulb: '💡', flashlight: '🔦', candle: '🕯️', money: '💰', dollar: '💵',
    credit_card: '💳', gem: '💎', wrench: '🔧', hammer: '🔨', gear: '⚙️',
    link: '🔗', lock: '🔒', unlock: '🔓', key: '🔑', magnet: '🧲',
    bomb: '💣', gun: '🔫', knife: '🔪', sword: '⚔️', shield: '🛡️',
    pill: '💊', syringe: '💉', dna: '🧬', microscope: '🔬', telescope: '🔭',
    satellite: '📡', rocket: '🚀', ufo: '🛸', // Objects
    // Symbols
    check: '✅', x: '❌', warning: '⚠️', no_entry: '⛔', stop: '🛑',
    question: '❓', exclamation: '❗', interrobang: '⁉️', hundred: '💯',
    plus: '➕', minus: '➖', multiply: '✖️', divide: '➗', infinity: '♾️',
    dollar_sign: '💲', copyright: '©️', registered: '®️', tm: '™️',
    recycle: '♻️', fleur_de_lis: '⚜️', trident: '🔱', name_badge: '📛',
    beginner: '🔰', o: '⭕', white_check_mark: '✅', ballot_box: '☑️',
    heavy_check: '✔️', cross: '✝️', star_of_david: '✡️', yin_yang: '☯️',
    peace: '☮️', atom: '⚛️', wheel_of_dharma: '☸️', // Symbols
    // Misc
    trophy: '🏆', medal: '🏅', first_place: '🥇', second_place: '🥈', third_place: '🥉',
    crown: '👑', ring: '💍', lipstick: '💄', kiss: '💋', eyes: '👀',
    eye: '👁️', ear: '👂', nose: '👃', tongue: '👅', brain: '🧠',
    heart_suit: '♥️', diamond_suit: '♦️', club_suit: '♣️', spade_suit: '♠️',
    joker: '🃏', mahjong: '🀄', flower: '🌸', cherry_blossom: '🌸', rose: '🌹',
    hibiscus: '🌺', sunflower: '🌻', tulip: '🌷', cactus: '🌵', palm: '🌴',
    tree: '🌲', herb: '🌿', shamrock: '☘️', four_leaf_clover: '🍀', maple_leaf: '🍁',
    leaves: '🍃', mushroom: '🍄', chestnut: '🌰', crab_emoji: '🦀', // Misc
    // Flags/Symbols
    flag_white: '🏳️', flag_black: '🏴', checkered_flag: '🏁', rainbow_flag: '🏳️‍🌈',
    pirate_flag: '🏴‍☠️', // Flags
    // Common shorthand
    lol: '😂', lmao: '🤣', omg: '😱', wtf: '🤯', gg: '🎮', ez: '😎',
    pog: '😮', poggers: '😮', sadge: '😢', copium: '🤡', hopium: '🙏',
    based: '🗿', cringe: '😬', kek: '😂', pepe: '🐸', monka: '😰',
    stonks: '📈', notstonks: '📉', sus: '🤨', amogus: '🤨', bruh: '😐',
    oof: '😣', rip: '⚰️', f: '🪦', w: '🏆', l: '💀', ratio: '📉',
    cap: '🧢', no_cap: '🙅', sheesh: '🥶', bussin: '😋', slay: '💅',
    yeet: '🚀', vibe: '✨', mood: '💭', bet: '🤝', facts: '📠', // Slang
  };
  // Pre-computed entries array — avoids Object.entries() allocation per keystroke
  const EMOJI_ENTRIES = Object.entries(EMOJI_MAP);

  // Extract usernames from chat messages
  function trackUsernamesFromChat() {
    // Observe chat for new messages
    const chatContainer = document.querySelector('[data-test-selector="chat-scrollable-area__message-container"]') ||
                          document.querySelector('.chat-scrollable-area__message-container');

    if (!chatContainer) return;

    cleanup.trackObserver(new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== 1) continue;

          // Find username - try data attribute first (most reliable)
          let username = null;

          // Try data-a-user attribute (contains clean username)
          const usernameEl = node.querySelector('[data-a-user]');
          if (usernameEl) {
            username = usernameEl.getAttribute('data-a-user');
          }

          // Fallback: try innerText of username span (only direct text, not children)
          if (!username) {
            const displayNameEl = node.querySelector('.chat-author__display-name');
            if (displayNameEl) {
              // Get only direct text nodes, not child elements
              for (const child of displayNameEl.childNodes) {
                if (child.nodeType === 3) {  // Text node
                  const text = child.textContent.trim();
                  if (text.length > 0 && !text.includes(':')) {
                    username = text;
                    break;
                  }
                }
              }
            }
          }

          if (username && username.length > 0 && username.length < 30) {
            recentUsernames.add(username);
            log('👤 Tracked username:', username, '(total:', recentUsernames.size + ')');

            // Keep only last 200 usernames (memory efficient)
            if (recentUsernames.size > MAX_USERNAMES) {
              const firstItem = recentUsernames.values().next().value;
              recentUsernames.delete(firstItem);
            }
          }
        }
      }
    }), 'username-tracker').observe(chatContainer, { childList: true, subtree: true });
    log('✅ Username tracking started');
  }

  // Start tracking after DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', trackUsernamesFromChat, { signal: acSignal });
  } else {
    setTimeout(trackUsernamesFromChat, 1000);  // Delay for Twitch to render chat
  }

  // ========== Extension Settings ==========
  // Read settings from localStorage (synced with heatsync-button.js panel)
  let cachedSettings = null;
  let settingsLastRead = 0;
  const SETTINGS_CACHE_MS = 500; // Only re-read every 500ms

  function getExtensionSettings() {
    const now = Date.now();
    // Use cached if fresh enough
    if (cachedSettings && (now - settingsLastRead) < SETTINGS_CACHE_MS) {
      return cachedSettings;
    }
    try {
      const stored = localStorage.getItem('heatsync-extension-settings');
      if (stored) {
        cachedSettings = JSON.parse(stored);
        settingsLastRead = now;
        return cachedSettings;
      }
    } catch (e) {
      log('Failed to parse extension settings:', e);
    }
    // Defaults match main heatsync app
    return {
      emoteWysiwyg: true,
      emoteSpaceAfter: true
    };
  }

  // Listen for settings changes from the panel (postMessage crosses content/page boundary)
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin) return;
    if (e.data?.type === 'heatsync-settings-changed' && e.data.settings) {
      // Clone to avoid any cross-origin wrapper issues
      cachedSettings = JSON.parse(JSON.stringify(e.data.settings));
      log(' Settings updated:', cachedSettings);
    }

    // Handle emote insertion requests from content.js (e.g., clicking emotes in stacks)
    if (e.data?.type === 'heatsync-insert-emote' && e.data.name) {
      log(' 📨 Received insert-emote request:', e.data.name);
      const emote = {
        name: e.data.name,
        hash: e.data.hash || e.data.name,
        url: e.data.url || ''
      };
      const inst = chatInputInstance || findChatInput();
      if (inst && typeof insertEmoteViaSlate === 'function') {
        if (insertEmoteViaSlate(emote, inst)) {
          log(' ✅ Inserted emote via Slate:', emote.name);
          const inputEl = getInputElement();
          if (inputEl) inputEl.focus();
        } else {
          log(' ❌ Slate insertion failed, falling back to clipboard');
          navigator.clipboard.writeText(emote.name + ' ').catch(() => {});
        }
      } else {
        log(' ❌ No chat input found, copying to clipboard');
        navigator.clipboard.writeText(emote.name + ' ').catch(() => {});
      }
    }
  }, { signal: acSignal });

  // Cache for getEmotesForFix to avoid re-parsing JSON on every image fix
  let _fixEmotesCache = [];
  let _fixEmotesData = '';
  // URL lookup cache - maps ID (hash or name) to resolved URL
  const _urlCache = new Map()

  // Clean up caches on page teardown
  acSignal.addEventListener('abort', () => {
    _urlCache.clear()
    _fixEmotesCache = []
    _fixEmotesData = ''
  })

  function getEmotesForFix() {
    const bridge = document.getElementById('heatsync-emote-bridge');
    if (!bridge) return [];
    try {
      const rawData = bridge.dataset.emotes || '[]';
      if (rawData === _fixEmotesData) return _fixEmotesCache;
      _fixEmotesData = rawData;
      _fixEmotesCache = JSON.parse(rawData);
      // Clear URL cache when emotes change
      _urlCache.clear();
      return _fixEmotesCache;
    } catch { return []; }
  }

  function fixHeatsyncUrl(value) {
    if (!value || typeof value !== 'string' || !value.includes(HEATSYNC_PREFIX)) return null;
    const match = value.match(/__FFZ__999999::(.+?)__FFZ__/);
    if (!match) return null;
    const id = match[1];

    // Check URL cache first (instant lookup)
    if (_urlCache.has(id)) {
      return _urlCache.get(id);
    }

    const emotes = getEmotesForFix();
    // Check both hash and name - some emotes use name as ID when hash is missing
    const emote = emotes.find(e => e.hash === id || e.name === id);
    if (emote) {
      // Cache the resolved URL
      _urlCache.set(id, emote.url);
      log(' 🔧 INTERCEPTED, fixing:', emote.name);
      return emote.url;
    }
    log(' ⚠️ ID not found:', id.substring(0, 20), 'emotes:', emotes.length);
    return null;
  }

  // Override img.src property setter and setAttribute
  // NOTE: These overrides only work in Chrome MAIN world. On Firefox MV2 (isolated world),
  // Xray wrappers make prototypes read-only — catch and skip gracefully.
  try {
    const origSrcDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    if (origSrcDesc) {
      Object.defineProperty(HTMLImageElement.prototype, 'src', {
        get: function() { return origSrcDesc.get.call(this); },
        set: function(value) {
          const fixed = fixHeatsyncUrl(value);
          if (fixed) {
            this.dataset.heatsyncFixed = 'true';
            return origSrcDesc.set.call(this, fixed);
          }
          return origSrcDesc.set.call(this, value);
        },
        configurable: true,
        enumerable: true
      });
    }

    const origSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function(name, value) {
      if (this.tagName === 'IMG' && name === 'src') {
        const fixed = fixHeatsyncUrl(value);
        if (fixed) {
          this.dataset.heatsyncFixed = 'true';
          return origSetAttribute.call(this, name, fixed);
        }
      }
      return origSetAttribute.call(this, name, value);
    };

    log(' ✅ Image src interceptors installed');
  } catch (e) {
    // Firefox MV2: prototype overrides fail on Xray wrappers — emote URL fixing
    // relies on early-inject-main.js in MAIN world instead (Chrome-only feature)
    log(' ⚠️ Image src interceptors skipped (isolated world)');
  }

  let chatInputInst = null;

  // Cached emotes to avoid repeated JSON parsing
  let _cachedEmotes = [];
  let _lastEmoteData = '';

  // Get heatsync emotes from bridge (cached)
  function getHeatsyncEmotes() {
    const bridge = document.getElementById('heatsync-emote-bridge');
    if (!bridge) return [];
    try {
      const rawData = bridge.dataset.emotes || '[]';
      // Only re-parse if data changed
      if (rawData === _lastEmoteData) return _cachedEmotes;
      _lastEmoteData = rawData;

      const emotes = JSON.parse(rawData);
      // Pre-index lowercase names for O(1) lookups (avoids 50k toLowerCase() calls per search)
      for (const e of emotes) {
        e.nameLower = e.name.toLowerCase();
      }
      _cachedEmotes = emotes;

      // Debug: check if CoffeeTime is in the autocomplete emotes
      const coffeeTest = emotes.find(e => e.name === 'CoffeeTime');
      if (coffeeTest) {
        log('🔍 [autocomplete-hook] CoffeeTime found:', coffeeTest);
      } else {
        log('❌ [autocomplete-hook] CoffeeTime NOT found in', emotes.length, 'emotes');
      }

      // Debug: check if BillyApprove is in autocomplete emotes
      const billyTest = emotes.find(e => e.name === 'BillyApprove');
      if (billyTest) {
        log('🔍 [autocomplete-hook] BillyApprove found:', billyTest);
      } else {
        log('❌ [autocomplete-hook] BillyApprove NOT found in', emotes.length, 'emotes');
        // Show emotes with "approve" in name
        const approveEmotes = emotes.filter(e => e.name.toLowerCase().includes('approve'));
        log('   Emotes with "approve":', approveEmotes.map(e => e.name).join(', '));
      }
      // Populate URL map for early-inject.js interceptor (both in MAIN world)
      if (emotes.length > 0) {
        window.__heatsyncEmoteUrls = {};
        for (const e of emotes) {
          if (e.hash && e.url) {
            window.__heatsyncEmoteUrls[e.hash] = e.url;
          }
        }
      }
      return emotes;
    } catch (e) {
      return [];
    }
  }

  // React fiber walking (FFZ-style)
  function getFiber(el) {
    if (!el) return null
    const key = Object.keys(el).find(k =>
      k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
    )
    return key ? el[key] : null
  }

  // Find React ChatInput instance
  function findChatInput() {
    const el = document.querySelector('[data-a-target="chat-input"]');
    if (!el) return null;

    let fiber = getFiber(el);
    if (!fiber) return null;
    let depth = 0;

    while (fiber && depth < 100) {
      const inst = fiber.stateNode;
      if (inst?.autocompleteInputRef?.setValue) {
        // Add our own helper methods if FFZ hasn't added them
        if (!inst.hsGetValue) {
          inst.hsGetValue = function() {
            if (inst.chatInputRef && typeof inst.chatInputRef.value === 'string')
              return inst.chatInputRef.value;
            if (inst.state?.value && typeof inst.state.value === 'string')
              return inst.state.value;
            // For Slate editor, get text content
            const slateEl = document.querySelector('[data-slate-editor="true"]');
            if (slateEl) return slateEl.textContent || '';
            return '';
          };
          inst.hsGetSelection = function() {
            // Simple approach: use DOM selection
            const sel = window.getSelection();
            if (!sel.rangeCount) return [0, 0];
            const slateEl = document.querySelector('[data-slate-editor="true"]');
            if (!slateEl) return [0, 0];

            const range = sel.getRangeAt(0);
            const preRange = document.createRange();
            preRange.selectNodeContents(slateEl);
            preRange.setEnd(range.startContainer, range.startOffset);
            const start = preRange.toString().length;
            const end = start + range.toString().length;
            return [start, end];
          };
        }
        return inst;
      }
      fiber = fiber.return;
      depth++;
    }
    return null;
  }

  // Create fake emote set for Twitch to recognize (like FFZ does)
  function createFakeEmoteSet() {
    const emotes = getHeatsyncEmotes();
    if (!emotes.length) return null;

    // Include ALL emotes with full structure including images
    // This prevents Twitch from having to look up images separately (which causes text flash)
    const out = emotes.map(emote => {
      let url = emote.url;
      if (url && (url.startsWith('/uploads/') || url.startsWith('/emotes/'))) {
        url = 'https://heatsync.org' + url;
      }
      return {
        __typename: 'Emote',
        id: HEATSYNC_PREFIX + (emote.hash || emote.name) + HEATSYNC_SUFFIX,
        modifiers: null,
        setID: 'HeatSyncEmotes',
        token: emote.name,
        // Include srcSet to prevent image lookup delay
        srcSet: url ? `${url} 1x` : undefined
      };
    });

    log(' Created fake emote set with', out.length, 'emotes');

    return {
      __typename: 'EmoteSet',
      emotes: out,
      id: 'HeatSyncEmotes',
      owner: null
    };
  }

  // Inject fake emotes into Twitch's emote array
  let chatInputInstance = null; // Store instance for forceUpdate calls

  function injectFakeEmotes(inst) {
    if (!inst?.props?.emotes) {
      log(' ⚠️ No props.emotes array found on instance');
      return;
    }

    chatInputInstance = inst; // Store for later updates

    const idx = inst.props.emotes.findIndex(s => s?.id === 'HeatSyncEmotes');
    const data = createFakeEmoteSet();
    let changed = false;

    if (idx === -1 && data) {
      inst.props.emotes.push(data);
      changed = true;
      log(' ✅ Injected', data.emotes.length, 'fake emotes for inline rendering');
      log(' Sample fake emote:', data.emotes[0]);
      log(' Total emote sets now:', inst.props.emotes.length);
      // Debug: show native Twitch emote for comparison
      const nativeSet = inst.props.emotes.find(s => s?.id !== 'HeatSyncEmotes' && s?.emotes?.length > 0);
      if (nativeSet?.emotes?.[0]) {
        log(' 📊 Native Twitch emote for comparison:', JSON.stringify(nativeSet.emotes[0], null, 2));
      }
    } else if (idx !== -1 && data) {
      inst.props.emotes.splice(idx, 1, data);
      changed = true;
      log(' 🔄 Updated fake emotes');
    } else if (idx !== -1 && !data) {
      inst.props.emotes.splice(idx, 1);
      changed = true;
    } else if (!data) {
      log(' ⚠️ No fake emote data created (emotes empty?)');
    }

    // Force React to re-render with new emotes (critical for preview creation!)
    if (changed && typeof inst.forceUpdate === 'function') {
      log(' 🔄 Calling forceUpdate() to re-render component');
      inst.forceUpdate();
    }
  }

  // Override emote provider's getMatches to include heatsync emotes (FFZ-style)
  function overrideEmoteProvider(inst) {
    if (!inst?.autocompleteInputRef?.providers) {
      log(' ⚠️ No autocomplete providers found');
      return;
    }

    for (const provider of inst.autocompleteInputRef.providers) {
      if (provider.autocompleteType !== 'emote') continue;
      if (provider._heatsync_hooked) continue;

      // Enable tab completion without colon prefix (FFZ-style)
      provider.canBeTriggeredByTab = true;
      log(' Setting canBeTriggeredByTab on provider:', provider.autocompleteType, 'props:', Object.keys(provider));

      const origGetMatches = provider.getMatches;
      if (typeof origGetMatches !== 'function') continue;

      provider.getMatches = function(input, pressedTab, ...args) {
        // Get original Twitch results first
        let results = origGetMatches.call(this, input, pressedTab, ...args);
        if (!Array.isArray(results)) results = [];

        log(' getMatches:', input, 'twitch results:', results.length, 'recentlyInserted:', [...recentlyInserted]);

        // Bulletproof pollution prevention:
        // If Twitch sends a polluted query (emote name instead of what user typed),
        // extract actual user input and return matches for THAT instead
        let actualInput = input;
        if (recentlyInserted.has(input)) {
          // Twitch is polluted - find what user actually typed
          const inputEl = document.querySelector('[data-slate-editor="true"]');
          if (inputEl) {
            const text = inputEl.textContent || '';
            // Find text after the last recently inserted emote
            // IMPORTANT: Find LONGEST match first to avoid "Kappa" matching inside "KappaRoss"
            let lastIdx = -1;
            let lastEmoteName = '';
            // Sort by length descending so longer names are checked first
            const sortedEmotes = [...recentlyInserted].sort((a, b) => b.length - a.length);
            for (const emoteName of sortedEmotes) {
              const idx = text.lastIndexOf(emoteName);
              if (idx > lastIdx) {
                lastIdx = idx;
                lastEmoteName = emoteName;
              }
            }
            if (lastIdx >= 0) {
              const afterEmote = text.substring(lastIdx + lastEmoteName.length);
              const cleanAfter = afterEmote.replace(/[\s\u200b\ufeff]/g, '');
              if (cleanAfter && cleanAfter.length >= 2) {
                log(' 🔄 Pollution detected! Twitch says:', input, 'but user typed:', cleanAfter);

                // CRITICAL: If we're currently cycling and the "new input" is a suffix of the cycled emote,
                // this is NOT new user input - it's Twitch picking up part of our emote name.
                // Return empty to hide dropdown and preserve cycleState for Tab cycling.
                if (cycleState.lastCycledEmote) {
                  const cycledLower = cycleState.lastCycledEmote.toLowerCase();
                  const cleanLower = cleanAfter.toLowerCase();
                  if (cycledLower.endsWith(cleanLower) || cycledLower === cleanLower) {
                    log(' ⏭️ Skipping suffix pollution during cycle:', cleanAfter, 'from', cycleState.lastCycledEmote);
                    return [];
                  }
                }

                actualInput = cleanAfter;
                // DON'T clear recentlyInserted here - Twitch will call getMatches again
                // and we need to keep detecting pollution until insertReplacement clears it
              } else {
                // No new user input, just skip and hide dropdown
                log(' ⏭️ Skipping - pollution with no new input:', input);
                document.body.classList.add('heatsync-cycling');
                return [];
              }
            }
          } else {
            log(' ⏭️ Skipping - exact match to recently inserted:', input);
            document.body.classList.add('heatsync-cycling');
            return [];
          }
        }

        // DEBUG: Log structure of first result's element (7TV-style fix needs this)
        if (results.length > 0 && results[0].element) {
          const elem = results[0].element;
          log(' 🔍 Result element structure:',
            'isArray:', Array.isArray(elem),
            'length:', elem?.length,
            'elem[0].key:', elem?.[0]?.key,
            'elem[0].props:', Object.keys(elem?.[0]?.props || {}));
          if (elem?.[0]?.props?.children?.props) {
            log(' 🔍 children.props:', Object.keys(elem[0].props.children.props));
          }
        }

        // Strip colon prefix if present for search - use actualInput (corrected for pollution)
        let search = actualInput.startsWith(':') ? actualInput.slice(1) : actualInput;
        if (search.length < 2) return results;

        // Get heatsync emotes
        const hsEmotes = getHeatsyncEmotes();
        const searchLower = search.toLowerCase();

        // Filter matching heatsync emotes (array, not Map — avoids allocation per keystroke)
        const hsMatches = [];
        for (const emote of hsEmotes) {
          if (!emote.hash) continue;
          if (!emote.nameLower.includes(searchLower)) continue;
          hsMatches.push(emote);
        }

        // Add usernames that match (with or without @ prefix)
        const usernameMatches = [];
        const searchWithoutAt = searchLower.startsWith('@') ? searchLower.slice(1) : searchLower;

        log('🔍 Searching usernames for:', searchWithoutAt, '| Total tracked:', recentUsernames.size);
        for (const username of recentUsernames) {
          const usernameLower = username.toLowerCase();
          if (usernameLower.includes(searchWithoutAt)) {
            usernameMatches.push(username);
            log('✅ Username match:', username);
          }
        }
        log('📋 Found', usernameMatches.length, 'username matches');

        // Debug: check if CoffeeTime matched for "coffee" search
        if (searchLower === 'coffee') {
          const coffeeMatch = hsMatches.find(e => e.name === 'CoffeeTime');
          if (coffeeMatch) {
            log('✅ [autocomplete] "coffee" matched CoffeeTime');
          } else {
            log('❌ [autocomplete] "coffee" did NOT match CoffeeTime');
            // Check if CoffeeTime exists in hsEmotes at all
            const coffeeExists = hsEmotes.find(e => e.name === 'CoffeeTime');
            if (coffeeExists) {
              log('   CoffeeTime exists in hsEmotes but failed .includes() check');
              log('   coffeeExists.nameLower:', coffeeExists.nameLower, 'searchLower:', searchLower);
            } else {
              log('   CoffeeTime does not exist in hsEmotes array');
            }
          }
        }

        // 7TV-style fix: Modify srcSet on React elements for our emotes
        results.forEach((m) => {
          if (!m.element || !Array.isArray(m.element) || !m.element[0]) return;
          const elem = m.element[0];
          const key = elem.key || '';

          // Check if this is a heatsync emote (key contains our fake FFZ ID)
          if (key.includes('__FFZ__999999::')) {
            const match = key.match(/__FFZ__999999::(.+?)__FFZ__/);
            if (match) {
              const hash = match[1];
              const emote = hsEmotes.find(e => e.hash === hash);
              if (emote) {
                // Log what Twitch generated so we can see the URL format
                const currentSrcSet = elem.props?.children?.props?.srcSet;
                log(' 🎯 Fixing srcSet for:', emote.name);
                log(' 📊 Twitch generated srcSet:', currentSrcSet?.substring?.(0, 120) || 'undefined');
                log(' 📊 Our URL:', emote.url);
                // Try different paths to srcSet AND src (both needed for display)
                if (elem.props?.children?.props) {
                  elem.props.children.props.srcSet = emote.url + ' 1x, ' + emote.url + ' 2x';
                  elem.props.children.props.src = emote.url;  // Also set src for fallback
                  log(' ✅ Set srcSet+src on children.props');
                }
                if (elem.props?.srcSet !== undefined) {
                  elem.props.srcSet = emote.url + ' 1x, ' + emote.url + ' 2x';
                  elem.props.src = emote.url;
                  log(' ✅ Set srcSet+src on props directly');
                }
              }
            }
          }
        });

        // Add heatsync emotes that aren't already in results
        for (const emote of hsMatches) {
          // Check if already in results
          if (results.some(r => r.emote?.token === emote.name)) continue;

          results.push({
            current: input,
            replacement: emote.name,
            element: null,
            emote: {
              id: HEATSYNC_PREFIX + emote.hash + HEATSYNC_SUFFIX,
              setID: 'HeatSyncEmotes',
              token: emote.name,
              srcSet: emote.url + ' 1x, ' + emote.url + ' 2x'
            }
          });
        }

        // Add username matches (only ones that START with search, not substring)
        for (const username of usernameMatches) {
          const usernameLower = username.toLowerCase();
          // Only add usernames that START with search (not substring matches)
          if (!usernameLower.startsWith(searchWithoutAt)) continue;

          // Check if already in results
          if (results.some(r => r.replacement === username || r.replacement === '@' + username)) continue;

          results.push({
            current: input,
            replacement: username,
            element: null  // No emote, just text insertion
          });
        }

        // Add emoji matches when searching with :prefix (Discord/Slack style)
        if (actualInput.startsWith(':') && search.length >= 2) {
          const emojiMatches = [];
          for (const [name, emoji] of EMOJI_ENTRIES) {
            if (name.includes(searchLower)) {
              emojiMatches.push({ name, emoji, isExact: name === searchLower, isPrefix: name.startsWith(searchLower) });
            }
          }
          // Sort: exact > prefix > contains, then alphabetical
          emojiMatches.sort((a, b) => {
            if (a.isExact && !b.isExact) return -1;
            if (!a.isExact && b.isExact) return 1;
            if (a.isPrefix && !b.isPrefix) return -1;
            if (!a.isPrefix && b.isPrefix) return 1;
            return a.name.localeCompare(b.name);
          });
          // Add top 10 emoji matches
          for (const { name, emoji } of emojiMatches.slice(0, 10)) {
            results.push({
              current: input,
              replacement: emoji + ' ',  // Insert emoji + space
              isEmoji: true,
              emojiName: name,
              element: null
            });
          }
          if (emojiMatches.length > 0) {
            log(' 😀 Found', emojiMatches.length, 'emoji matches for:', search);
          }
        }

        // Sort results: EMOTES first, then EMOJIS, then USERNAMES
        // Pre-compute sort keys to avoid repeated toLowerCase() in comparator
        for (const r of results) {
          r._sortKey = (r.emojiName || r.replacement || r.emote?.token || '').toLowerCase()
          r._sortType = r.emote ? 0 : r.isEmoji ? 1 : 2 // 0=emote, 1=emoji, 2=username
        }
        results.sort((a, b) => {
          // Category sort: emotes < emojis < usernames
          if (a._sortType !== b._sortType) return a._sortType - b._sortType;

          // Usernames: alphabetical only
          if (a._sortType === 2) return a._sortKey.localeCompare(b._sortKey);

          // Emotes/emojis: exact > prefix > contains > shorter > alpha
          const aExact = a._sortKey === searchLower;
          const bExact = b._sortKey === searchLower;
          if (aExact !== bExact) return aExact ? -1 : 1;

          const aPrefix = a._sortKey.startsWith(searchLower);
          const bPrefix = b._sortKey.startsWith(searchLower);
          if (aPrefix !== bPrefix) return aPrefix ? -1 : 1;

          if (a._sortKey.length !== b._sortKey.length) return a._sortKey.length - b._sortKey.length;
          return a._sortKey.localeCompare(b._sortKey);
        });
        // Clean up sort keys
        for (const r of results) { delete r._sortKey; delete r._sortType; }

        if (results.length > 0) {
          log(' getMatches returning:', results.length, 'total, first:', results[0]?.replacement || results[0]?.emote?.token);
          // Track that dropdown is visible with results (for insertReplacement check)
          lastDropdownVisibleTime = Date.now();
        }
        return results;
      };
      provider._heatsync_hooked = true;
      log(' ✅ Hooked emote provider (canBeTriggeredByTab enabled)');
    }
  }

  // Hook componentDidUpdate to re-inject emotes when props change (FFZ-style)
  function hookComponentDidUpdate(inst) {
    if (inst._heatsync_cdu_hooked) return;

    const orig = inst.componentDidUpdate;
    inst.componentDidUpdate = function(prevProps, ...args) {
      try {
        if (prevProps.emotes !== this.props.emotes && Array.isArray(this.props.emotes)) {
          injectFakeEmotes(this);
        }
      } catch (e) {
      }
      if (orig) orig.call(this, prevProps, ...args);
    };
    inst._heatsync_cdu_hooked = true;
    log(' ✅ Hooked componentDidUpdate');
  }

  // Hook insertReplacement (pass-through to native)
  // Track state to enable Tab cycling through matches
  let cycleState = {
    lastEmote: null,
    lastTime: 0,
    matchesTime: 0,   // When matches list was populated (for initial Tab window)
    matches: [],      // All matching emotes for current search
    index: 0,         // Current position in matches
    lastCycledEmote: null, // Name of emote we just cycled to (to detect suffix pollution)
    searchTerm: ''    // Original search term (cleaned)
  };

  // Track when dropdown was last visible (for insertReplacement check)
  let lastDropdownVisibleTime = 0;

  // (lastEnterPressTime removed — Enter is never touched by this module)

  // Track preloaded emote names (Image() preloading disabled — ORB blocks in content scripts)
  const preloadedImages = new Map();
  const MAX_PRELOADED = 500;
  function preloadEmoteImages(emotes) {
    for (const emote of emotes) {
      if (!emote.url || preloadedImages.has(emote.name)) continue
      let url = emote.url
      if (url.startsWith('/uploads/') || url.startsWith('/emotes/')) {
        url = 'https://heatsync.org' + url
      }
      preloadedImages.set(emote.name, { src: url })
    }
    // Evict oldest if over cap
    if (preloadedImages.size > MAX_PRELOADED) {
      const excess = preloadedImages.size - MAX_PRELOADED
      const keys = [...preloadedImages.keys()].slice(0, excess)
      for (const k of keys) preloadedImages.delete(k)
    }
  }

  acSignal.addEventListener('abort', () => preloadedImages.clear())

  // Cycle indicator tooltip (shows "1/5 emotename" above input)
  let cycleTooltip = null;
  let cycleTooltipTimeout = null;

  function showCycleTooltip(index, total, emoteName) {
    // Create tooltip if needed
    if (!cycleTooltip) {
      cycleTooltip = document.createElement('div');
      cycleTooltip.id = 'heatsync-cycle-tooltip';
      cycleTooltip.style.cssText = `
        position: fixed;
        background: rgba(0, 0, 0, 0.95);
        color: #fff;
        padding: 4px 8px;
        border-radius: 0;
        font-size: 13px;
        font-family: inherit;
        z-index: 10000;
        pointer-events: none;
        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
        border: 1px solid rgba(255,255,255,0.1);
        opacity: 0;
        transition: opacity 0.15s;
      `;
      document.body.appendChild(cycleTooltip);
    }

    // Hide Twitch's native dropdown while cycling via body class
    document.body.classList.add('heatsync-cycling');

    // Update content
    cycleTooltip.textContent = `${index}/${total} ${emoteName}`;

    // Position above input
    const input = document.querySelector('[data-slate-editor="true"]');
    if (input) {
      const rect = input.getBoundingClientRect();
      cycleTooltip.style.left = `${rect.left}px`;
      cycleTooltip.style.top = `${rect.top - 30}px`;
    }

    // Show
    cycleTooltip.style.opacity = '1';

    // Auto-hide after 1.5s
    if (cycleTooltipTimeout) clearTimeout(cycleTooltipTimeout);
    cycleTooltipTimeout = setTimeout(() => {
      if (cycleTooltip) cycleTooltip.style.opacity = '0';
      // Restore dropdown visibility
      document.body.classList.remove('heatsync-cycling');
    }, 1500);
  }

  function hookInsertReplacement(inst) {
    const autocomplete = inst?.autocompleteInputRef;
    if (!autocomplete || autocomplete._heatsync_ir_hooked) return;

    const origInsertReplacement = autocomplete.insertReplacement;
    if (!origInsertReplacement) return;

    // Restore original on abort (extension reload) so hooks don't stack
    acSignal.addEventListener('abort', () => {
      autocomplete.insertReplacement = origInsertReplacement;
      autocomplete._heatsync_ir_hooked = false;
    });

    autocomplete.insertReplacement = function(args) {
      // BULLETPROOF: Always pass through to native. NEVER intercept.
      // Intercepting this function breaks Twitch's message send flow.
      return origInsertReplacement.call(this, args);
    };

    autocomplete._heatsync_ir_hooked = true;
    log(' ✅ Hooked insertReplacement');
  }

  // Shared function to insert emote via Slate API (used by click and keydown handlers)
  // isCycling: if true, delete the last emote node instead of partial text
  function insertEmoteViaSlate(matchedEmote, inst, isCycling = false) {
    const slateEditor = inst?.chatInputRef?.state?.slateEditor;
    if (!slateEditor) {
      log(' ⚠️ No Slate editor for insertion');
      return false;
    }

    // Normalize URL - convert relative paths to absolute
    let emoteUrl = matchedEmote.url;
    if (emoteUrl && (emoteUrl.startsWith('/uploads/') || emoteUrl.startsWith('/emotes/'))) {
      emoteUrl = 'https://heatsync.org' + emoteUrl;
    }
    const emoteNode = {
      type: 'emote',
      emoteData: {
        type: 6,
        content: {
          images: {
            dark: { '1x': emoteUrl, '2x': emoteUrl, '4x': emoteUrl },
            light: { '1x': emoteUrl, '2x': emoteUrl, '4x': emoteUrl },
            themed: false
          },
          alt: matchedEmote.name,
          // CRITICAL: Must match the ID format in fake emote set for Twitch to find it on re-render
          emoteID: HEATSYNC_PREFIX + (matchedEmote.hash || matchedEmote.name) + HEATSYNC_SUFFIX
        }
      },
      emoteName: matchedEmote.name,
      children: [{ text: '' }]
    };

    log(' 🎯 Inserting emote via Slate:', matchedEmote.name, 'URL:', emoteUrl.substring(0, 60), 'hash:', matchedEmote.hash, isCycling ? '(cycling)' : '');

    // Move to end
    const endPoint = slateEditor.end([]);
    slateEditor.select(endPoint);

    // Get settings early for deletion behavior
    const settings = getExtensionSettings();
    const useWysiwyg = settings.emoteWysiwyg !== false; // default true
    const addSpace = settings.emoteSpaceAfter !== false; // default true
    log(' [autocomplete-hook] INSERTION - useWysiwyg:', useWysiwyg, 'addSpace:', addSpace, 'emote:', matchedEmote.name);

    if (isCycling) {
      if (useWysiwyg) {
        // FFZ-STYLE: Update the existing preview image directly instead of delete/insert
        // This prevents the flash because we're not destroying the DOM element
        const inputEl = document.querySelector('[data-slate-editor="true"]');
        const previewImg = inputEl?.querySelector('img.chat-line__message--emote, img[alt]');

        if (previewImg) {
          // Update the image directly for instant visual feedback
          previewImg.dataset.heatsyncFixed = 'true';
          previewImg.src = emoteUrl;
          previewImg.alt = matchedEmote.name;
          previewImg.dataset.emoteName = matchedEmote.name;
          if (previewImg.srcset) {
            previewImg.srcset = `${emoteUrl} 1x`;
          }

          // CRITICAL: Also update the Slate node data so correct emote is sent
          // Find the LAST emote node (the one just before cursor) instead of first
          const findLastEmotePath = (nodes, path = []) => {
            let lastEmotePath = null;
            for (let i = 0; i < nodes.length; i++) {
              const node = nodes[i];
              if (node.type === 'emote') {
                lastEmotePath = [...path, i];
              }
              if (node.children) {
                const found = findLastEmotePath(node.children, [...path, i]);
                if (found) lastEmotePath = found;
              }
            }
            return lastEmotePath;
          };

          const emotePath = findLastEmotePath(slateEditor.children);
          if (emotePath) {
            // Update the emote node properties using Slate's apply
            const newEmoteData = {
              type: 6,
              content: {
                images: {
                  dark: { '1x': emoteUrl, '2x': emoteUrl, '4x': emoteUrl },
                  light: { '1x': emoteUrl, '2x': emoteUrl, '4x': emoteUrl },
                  themed: false
                },
                alt: matchedEmote.name,
                emoteID: HEATSYNC_PREFIX + (matchedEmote.hash || matchedEmote.name) + HEATSYNC_SUFFIX
              }
            };

            try {
              slateEditor.apply({
                type: 'set_node',
                path: emotePath,
                properties: {},
                newProperties: {
                  emoteData: newEmoteData,
                  emoteName: matchedEmote.name
                }
              });
              log(' 🔄 FFZ-style: Updated Slate node for', matchedEmote.name);
            } catch (err) {
              log(' ⚠️ set_node failed:', err.message);
            }
          }

          return true;
        }

        // Fallback: delete and re-insert if no preview found
        log(' ⚠️ No preview image found, falling back to delete/insert');
        try {
          const endPt = slateEditor.end([]);
          slateEditor.select(endPt);

          // Delete trailing space/ZWS
          slateEditor.deleteBackward('character');

          // Delete the emote void element (Slate treats voids as single units)
          slateEditor.deleteBackward('character');

          log(' 🗑️ Deleted emote + trailing char for cycling');
        } catch (err) {
          log(' ❌ Error deleting for cycling:', err.message);
        }
      } else {
        // Text mode cycling: delete the previous emote text + optional space
        const prevEmote = cycleState.lastCycledEmote;
        if (prevEmote) {
          const deleteLen = prevEmote.length + (addSpace ? 1 : 0);
          for (let i = 0; i < deleteLen; i++) {
            slateEditor.deleteBackward('character');
          }
          log(' 🗑️ Deleted text emote for cycling:', prevEmote, '(' + deleteLen + ' chars)');
        }
      }
    } else {
      // Delete partial text (the search term like ":kap" or "kap")
      // Try multiple methods to get current input value
      let currentValue = inst.hsGetValue?.() || inst.ffzGetValue?.() || '';

      // Fallback: get from DOM if inst methods don't work
      if (!currentValue) {
        const inputEl = getInputElement();
        if (inputEl) {
          currentValue = inputEl.textContent || '';
        }
      }

      log(' 🔍 Deleting partial text, currentValue:', JSON.stringify(currentValue));

      const matchResult = currentValue.match(/(:?\w+)$/);
      const partialText = matchResult ? matchResult[0] : '';

      log(' 🔍 partialText to delete:', JSON.stringify(partialText), 'length:', partialText.length);

      if (partialText && partialText.length > 0) {
        // Move cursor to end first
        const endPt = slateEditor.end([]);
        slateEditor.select(endPt);

        for (let i = 0; i < partialText.length; i++) {
          slateEditor.deleteBackward('character');
        }
        log(' 🗑️ Deleted', partialText.length, 'chars of partial text');
      }
    }

    // Insert emote based on WYSIWYG setting
    if (useWysiwyg) {
      // Insert emote node as inline void element (WYSIWYG mode)
      log(' [autocomplete-hook] WYSIWYG MODE - Inserting emote node for:', matchedEmote.name);
      slateEditor.insertNode(emoteNode);

      // After emote, insert space using Slate apply (like 7TV does)
      if (addSpace) {
        try {
          // Get cursor position after emote insertion
          const point = slateEditor.end([]);
          slateEditor.apply({
            type: 'insert_text',
            path: point.path,
            offset: point.offset,
            text: ' '
          });
          log(' 📝 Inserted space via Slate apply');
        } catch (err) {
          log(' ❌ Slate apply failed:', err.message);
          // Fallback: try insertText
          slateEditor.insertText(' ');
        }
      }
    } else {
      // Insert emote name as text only (text mode) - include space in text
      const textToInsert = addSpace ? matchedEmote.name + ' ' : matchedEmote.name;
      log(' [autocomplete-hook] TEXT MODE - Inserting text:', textToInsert);

      slateEditor.insertText(textToInsert);
      log(' [autocomplete-hook] TEXT MODE - insertText() completed');
    }

    // Move cursor to absolute end
    const afterEmotePoint = slateEditor.end([]);
    slateEditor.select(afterEmotePoint);

    // Add to recently inserted set - getMatches will skip exact matches
    // This prevents Twitch's polluted state from inserting wrong emotes
    recentlyInserted.add(matchedEmote.name);
    lastInsertedEmote = matchedEmote.name;
    insertionCount++;

    // Limit set size to prevent memory leaks (keep last 10)
    if (recentlyInserted.size > 10) {
      const first = recentlyInserted.values().next().value;
      recentlyInserted.delete(first);
    }

    log(' ✅ Slate emote inserted:', matchedEmote.name, 'insertion #', insertionCount);
    return true;
  }

  // Keydown handler for Tab in autocomplete dropdown (Tab only, Enter never touched)
  let documentKeyHandlerInstalled = false;
  function installAutocompleteKeyHandler() {
    if (documentKeyHandlerInstalled) return;
    documentKeyHandlerInstalled = true;

    // Use WINDOW-level handler (not document) to fire before any other listeners
    // Use CAPTURE phase to fire before Twitch's handlers
    log('🎯 Installing window keydown handler');
    window.addEventListener('keydown', (e) => {
      // ONLY intercept Tab. NEVER touch Enter — let Twitch handle sending.
      if (e.key !== 'Tab') return;
      log('🔑 TAB PRESSED! target:', e.target?.tagName, e.target?.className);

      // Check if we're in the chat input
      const inputEl = getInputElement();
      if (!inputEl) {
        log(' ⌨️ No input element found');
        return;
      }
      const isInInput = inputEl.contains(e.target) || e.target === inputEl;
      if (!isInInput) {
        // Tab when not in input = focus input
        if (e.key === 'Tab' && !e.shiftKey) {
          e.preventDefault();
          inputEl.focus();
          log(' ⌨️ Tab focused input');
          return;
        }
        log(' ⌨️ Not in input, target:', e.target?.tagName);
        return;
      }

      log(' ⌨️ Key pressed:', e.key, 'shiftKey:', e.shiftKey);

      // CRITICAL: Tab should NEVER exit the input box (but let event propagate for completion)
      if (e.key === 'Tab') {
        e.preventDefault(); // Stop focus from leaving input
        // Don't stopPropagation - Twitch needs the event for autocomplete
      }

      // TAB CYCLING: If we recently inserted an emote and have multiple matches,
      // cycle through them even if Twitch's dropdown is closed
      if (e.key === 'Tab' && !e.shiftKey) {
        const now = Date.now();
        const isRecentEnough = (now - cycleState.lastTime) < 2000;
        let hasMultipleMatches = cycleState.matches.length > 1;

        // Check if Twitch's dropdown is NOT visible (we need to handle cycling ourselves)
        const dropdown = document.querySelector('[class*="chat-autocomplete"]') ||
                         document.querySelector('[role="listbox"]');
        const dropdownVisible = dropdown && dropdown.offsetParent !== null;

        // CRITICAL: Detect if user typed NEW text after last emote
        // If so, this is a new completion, NOT a cycle continuation
        if (cycleState.lastCycledEmote) {
          const inputEditor = document.querySelector('[data-slate-editor="true"]');
          if (inputEditor) {
            // Check if there are ANY emote images in the input
            const emoteImgs = inputEditor.querySelectorAll('.chat-line__message--emote, img[alt]');
            // Also check for text mode (emote name as text, not image)
            const inputText = inputEditor.textContent || '';
            const textContainsEmote = inputText.includes(cycleState.lastCycledEmote);

            if (emoteImgs.length === 0 && !textContainsEmote) {
              // No emotes in input (image or text) - user must have deleted it
              log(' 🔄 No emote in input - resetting cycle state');
              cycleState.lastCycledEmote = null;
            } else if (textContainsEmote) {
              // TEXT MODE: Emote exists as text, continue cycling
              log(' 🔄 Text mode: emote found as text, continuing cycle');
            } else {
              // Check if the last cycled emote is still in the input (by alt text)
              const emoteStillExists = Array.from(emoteImgs).some(img =>
                img.alt === cycleState.lastCycledEmote
              );
              if (!emoteStillExists) {
                log(' 🔄 Last cycled emote not found in input - resetting cycle state');
                cycleState.lastCycledEmote = null;
              } else {
                // WYSIWYG mode: Check if text was typed AFTER the last emote image in DOM
                // (textContent won't contain emote names, so we use DOM traversal)
                const lastEmoteImg = Array.from(emoteImgs).reverse().find(img =>
                  img.alt === cycleState.lastCycledEmote
                );
                if (lastEmoteImg) {
                  // Walk siblings after the emote's container to find text
                  let container = lastEmoteImg.closest('[data-slate-node]') || lastEmoteImg.parentElement;
                  let textAfter = '';
                  let sibling = container?.nextSibling;
                  while (sibling) {
                    if (sibling.nodeType === Node.TEXT_NODE) {
                      textAfter += sibling.textContent || '';
                    } else if (sibling.textContent) {
                      textAfter += sibling.textContent;
                    }
                    sibling = sibling.nextSibling;
                  }
                  const cleanAfter = textAfter.replace(/[\s\u200b\ufeff]/g, '');
                  if (cleanAfter.length >= 2) {
                    log(' 🔄 New text detected after emote (DOM walk):', cleanAfter, '- resetting cycle');
                    cycleState.lastCycledEmote = null;
                  }
                }
              }
            }
          }
        }

        // CRITICAL: Check if current input matches stored search term
        // If not, we have stale matches from a previous search - reset!
        const currentInputText = inputEl.textContent || '';
        const currentSearch = currentInputText.trim().toLowerCase().split(/\s+/).pop() || '';
        const searchMatches = cycleState.searchTerm &&
          (currentSearch.includes(cycleState.searchTerm) || cycleState.searchTerm.includes(currentSearch));

        // If user typed something NEW, reset stale matches
        if (hasMultipleMatches && !searchMatches && currentSearch.length >= 2) {
          log(' 🔄 Current input "' + currentSearch + '" doesn\'t match stored "' + cycleState.searchTerm + '" - rebuilding matches');
          // Build fresh matches for current input
          const hsEmotes = getEmotesForFix();
          const prefixMatches = [];
          const substringMatches = [];
          for (const em of hsEmotes) {
            if (em.nameLower?.startsWith(currentSearch)) {
              prefixMatches.push(em);
            } else if (em.nameLower?.includes(currentSearch)) {
              substringMatches.push(em);
            }
            if (prefixMatches.length + substringMatches.length >= 50) break;
          }
          prefixMatches.sort((a, b) => a.name.length - b.name.length);
          substringMatches.sort((a, b) => a.name.length - b.name.length);
          cycleState.matches = [...prefixMatches, ...substringMatches];
          cycleState.searchTerm = currentSearch;
          cycleState.index = 0;
          cycleState.lastCycledEmote = null;
          hasMultipleMatches = cycleState.matches.length > 1;
          log(' 🔄 Rebuilt', cycleState.matches.length, 'matches for "' + currentSearch + '"');
        }

        // Allow cycling if:
        // - Multiple matches exist AND
        // - Either: emote was already inserted (justCycled), OR no dropdown visible (handle first Tab ourselves)
        const justCycled = cycleState.lastCycledEmote !== null;
        const shouldCycle = hasMultipleMatches && (justCycled || !dropdownVisible);

        log(' 🔍 Tab pressed - cycling check:', {
          hasMultipleMatches,
          matchCount: cycleState.matches.length,
          justCycled,
          dropdownVisible,
          shouldCycle,
          searchTerm: cycleState.searchTerm
        });

        if (shouldCycle) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();

          // On FIRST Tab (justCycled false): insert first match (index 0)
          // On subsequent Tabs: cycle to next match
          if (justCycled) {
            cycleState.index = (cycleState.index + 1) % cycleState.matches.length;
          } else {
            cycleState.index = 0; // First Tab - start at first match
          }
          const nextEmote = cycleState.matches[cycleState.index];
          cycleState.lastTime = now;

          log(' ⌨️ Manual Tab cycling:', cycleState.index + 1, '/', cycleState.matches.length, '→', nextEmote.name, justCycled ? '(cycling)' : '(first)');
          showCycleTooltip(cycleState.index + 1, cycleState.matches.length, nextEmote.name);

          const inst = chatInputInst || findChatInput();
          if (!inst) {
            log(' ❌ Manual Tab cycling failed - no chat input found');
            return;
          }
          // CRITICAL: Pass justCycled - first Tab deletes search text, subsequent Tabs update existing emote
          if (insertEmoteViaSlate(nextEmote, inst, justCycled)) {
            // Track cycled emote to detect suffix pollution (e.g., "Cool" from "KappaCool")
            cycleState.lastCycledEmote = nextEmote.name;
            // Add to recently inserted
            recentlyInserted.add(nextEmote.name);
            if (recentlyInserted.size > 10) {
              const first = recentlyInserted.values().next().value;
              recentlyInserted.delete(first);
            }
            // CRITICAL: Refocus input to ensure next Tab is captured
            const inputEl = getInputElement();
            if (inputEl) {
              inputEl.focus();
            }
            log(' ✅ Cycle complete, justCycled now:', cycleState.lastCycledEmote);
            return;
          }
        }

        // USERNAME COMPLETION FALLBACK: If no emote matches, try username
        if (!hasMultipleMatches || cycleState.matches.length === 0) {
          const inputText = inputEl.textContent || '';
          // Get the last word (partial username)
          const lastWordMatch = inputText.match(/(\w+)\s*$/);
          if (lastWordMatch && lastWordMatch[1].length >= 2) {
            const searchTerm = lastWordMatch[1];
            const usernameMatch = findUsernameMatch(searchTerm);
            if (usernameMatch) {
              e.preventDefault();
              e.stopPropagation();
              e.stopImmediatePropagation();

              log(' 👤 Tab username completion:', searchTerm, '→', usernameMatch);

              const inst = chatInputInst || findChatInput();
              const slateEditor = inst?.chatInputRef?.state?.slateEditor;
              if (slateEditor) {
                // Delete the partial text
                const endPt = slateEditor.end([]);
                slateEditor.select(endPt);
                for (let i = 0; i < searchTerm.length; i++) {
                  slateEditor.deleteBackward('character');
                }
                // Insert @username with space
                slateEditor.insertText('@' + usernameMatch + ' ');
                log(' ✅ Username inserted:', usernameMatch);
                return;
              }
            }
          }
        }
      }

      // SHIFT+TAB CYCLING: Cycle backwards through matches
      if (e.key === 'Tab' && e.shiftKey) {
        const hasMultipleMatches = cycleState.matches.length > 1;
        const justCycled = cycleState.lastCycledEmote !== null;

        if (hasMultipleMatches && justCycled) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();

          // Cycle backwards (wrap around)
          cycleState.index = (cycleState.index - 1 + cycleState.matches.length) % cycleState.matches.length;
          const prevEmote = cycleState.matches[cycleState.index];
          cycleState.lastTime = Date.now();

          log(' ⌨️ Shift+Tab cycling backwards:', cycleState.index + 1, '/', cycleState.matches.length, '→', prevEmote.name);
          showCycleTooltip(cycleState.index + 1, cycleState.matches.length, prevEmote.name);

          const inst = chatInputInst || findChatInput();
          if (!inst) {
            log(' ❌ Shift+Tab cycling failed - no chat input found');
            return;
          }
          if (insertEmoteViaSlate(prevEmote, inst, true)) {
            cycleState.lastCycledEmote = prevEmote.name;
            recentlyInserted.add(prevEmote.name);
            if (recentlyInserted.size > 10) {
              const first = recentlyInserted.values().next().value;
              recentlyInserted.delete(first);
            }
            const inputEl = getInputElement();
            if (inputEl) inputEl.focus();
            log(' ✅ Backwards cycle complete');
            return;
          }
        }
      }

      // Check if autocomplete dropdown is visible (Tab only from here)
      const dropdown = document.querySelector('[class*="chat-autocomplete"]') ||
                       document.querySelector('[class*="Autocomplete"]') ||
                       document.querySelector('[role="listbox"]');

      if (!dropdown) {
        // No dropdown visible - Tab already prevented above, just return
        log(' 🔍 No dropdown found, returning');
        return;
      }
      log(' 🔍 Dropdown found:', dropdown.className);

      // Check if dropdown is actually visible (not just in DOM)
      // Use OR - if EITHER condition indicates hidden, let Tab through
      const isHidden = dropdown.offsetParent === null ||
                       dropdown.style.display === 'none' ||
                       dropdown.style.visibility === 'hidden' ||
                       dropdown.style.opacity === '0' ||
                       getComputedStyle(dropdown).display === 'none';
      if (isHidden) {
        log(' 🔍 Dropdown exists but hidden, letting Tab through');
        return;
      }

      // Find highlighted/selected item with our emote image
      const highlighted = dropdown.querySelector('[aria-selected="true"]') ||
                          dropdown.querySelector('[class*="selected"]') ||
                          dropdown.querySelector('[class*="highlighted"]') ||
                          dropdown.querySelector('[data-highlighted="true"]');

      // Look for our emote in highlighted item or first item if nothing highlighted
      const targetItem = highlighted || dropdown.querySelector('[role="option"]');


      if (!targetItem) return;

      const img = targetItem.querySelector('img');
      if (!img) {
        return;
      }

      const src = img.src || img.srcset || '';
      log(' 🔍 Tab - img src:', src.substring(0, 80));
      if (!src.includes('betterttv') && !src.includes('7tv') && !src.includes('frankerfacez')) {
        // Not our emote, let Twitch handle it
        log(' 🔍 Tab - img not heatsync emote, letting Twitch handle');
        return;
      }

      // Find which emote this is
      const itemText = targetItem.textContent?.trim();
      const hsEmotes = getHeatsyncEmotes();
      const matchedEmote = hsEmotes.find(em =>
        itemText?.includes(em.name) ||
        src.includes(em.hash)
      );

      if (!matchedEmote) {
        return;
      }

      log(' ⌨️ Tab on our emote:', matchedEmote.name);

      // Prevent Twitch's handler
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      // Insert via Slate
      const inst = chatInputInst || findChatInput();
      if (insertEmoteViaSlate(matchedEmote, inst)) {
        // Close dropdown by clicking elsewhere
        const inputEl = getInputElement();
        if (inputEl) inputEl.focus();
      }
    }, { capture: true, signal: acSignal }); // Capture phase

    log(' ✅ Autocomplete key handler installed (Tab only, Enter never touched)');
  }

  // Click handler for autocomplete items (Twitch can't resolve our fake IDs)
  function installAutocompleteClickHandler() {
    // Use capturing to intercept before Twitch's handler
    document.addEventListener('click', (e) => {
      // Debug: log all clicks to see structure
      const target = e.target;
      const parent = target.parentElement;
      const grandparent = parent?.parentElement;

      // CRITICAL: Ignore clicks inside heatsync panel (import button, settings, etc)
      if (target.closest('#heatsync-panel') || target.closest('.heatsync-panel')) {
        return;
      }

      // CRITICAL: Ignore clicks on emotes already in the input field (not dropdown)
      const isInInputField = e.target.closest('.chat-wysiwyg-input__editor') ||
                             e.target.closest('[data-slate-editor="true"]') ||
                             e.target.closest('[data-slate-node="element"]');
      if (isInInputField) {
        log(' 🔍 Click is in input field, ignoring');
        return;
      }

      // CRITICAL: Ignore clicks on emote stacks/wrappers in chat - let content.js handle
      const isInEmoteStack = e.target.closest('.heatsync-emote-stack');
      const isInChatMessage = e.target.closest('.chat-line__message') ||
                              e.target.closest('[class*="chat-scrollable"]');
      if (isInEmoteStack || (isInChatMessage && e.target.closest('.heatsync-emote-wrapper'))) {
        log(' 🔍 Click is on chat emote/stack, letting content.js handle');
        return;
      }

      // CRITICAL: Ignore ALL clicks in chat message area (not autocomplete dropdown)
      // This prevents blank space clicks from triggering emote insertion
      if (isInChatMessage) {
        log(' 🔍 Click is in chat message area, ignoring');
        return;
      }

      // Check if click is in autocomplete dropdown - try multiple selectors
      const autocomplete = e.target.closest('[class*="chat-autocomplete"]') ||
                          e.target.closest('[class*="autocomplete"]') ||
                          e.target.closest('[role="listbox"]') ||
                          e.target.closest('[class*="Autocomplete"]');

      // Only look for emote images when inside autocomplete dropdown
      // DO NOT use querySelector fallback outside dropdowns - it catches nearby emotes on blank space clicks
      let img = null;
      if (autocomplete) {
        // Inside autocomplete: can use querySelector to find emote in clicked item
        img = target.tagName === 'IMG' ? target :
              target.querySelector('img') ||
              parent?.querySelector('img');
      } else {
        // Outside autocomplete: ONLY direct clicks on img elements
        img = target.tagName === 'IMG' ? target : null;
      }

      if (!autocomplete && !img) {
        // Not in autocomplete and didn't click directly on an img
        return;
      }

      // Check if this looks like an autocomplete click (has emote image with our URL)
      if (img) {
        const src = img.src || img.srcset || '';
        if (src.includes('betterttv') || src.includes('7tv') || src.includes('frankerfacez')) {
          log(' 🔍 Click on BTTV/7TV/FFZ img:', {
            target: target.tagName + '.' + target.className?.split(' ')[0],
            inAutocomplete: !!autocomplete,
            imgSrc: src.substring(0, 60)
          });
        } else {
          // Not our emote
          return;
        }
      } else if (!autocomplete) {
        return;
      }

      // Find the clicked suggestion item - try multiple selectors
      const item = e.target.closest('[role="option"]') ||
                   e.target.closest('[class*="suggestion"]') ||
                   e.target.closest('[class*="Suggestion"]') ||
                   e.target.closest('[data-test-selector*="emote"]') ||
                   (img ? img.closest('div[class*="Layout"]') : null);
      if (!item) {
        log(' 🔍 No item found for click');
        return;
      }

      // Check if this item has our emote (look for FFZ marker in img src or item text)
      const itemImg = item.querySelector('img') || img;
      const itemText = item.textContent?.trim();
      const hsEmotes = getHeatsyncEmotes();

      // Match by image URL (most reliable)
      let matchedEmote = null;
      if (itemImg) {
        const src = itemImg.src || itemImg.srcset || '';
        for (const emote of hsEmotes) {
          if (src.includes(emote.hash) || src.includes(encodeURIComponent(emote.url))) {
            matchedEmote = emote;
            break;
          }
        }
      }

      // Fallback: match by text content
      if (!matchedEmote && itemText) {
        matchedEmote = hsEmotes.find(e => itemText.includes(e.name));
      }

      if (!matchedEmote) return;

      log(' 🖱️ Intercepted click on our emote:', matchedEmote.name);

      // Prevent Twitch's handler - it won't create preview for our fake IDs
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      const inst = chatInputInstance || findChatInput();
      if (!inst) {
        return;
      }

      // Use shared Slate insertion function
      if (insertEmoteViaSlate(matchedEmote, inst)) {
        const inputEl = getInputElement();
        if (inputEl) inputEl.focus();
        return;
      }

      // Fallback: Use insertReplacement for text insertion
      const autocompleteInput = inst.autocompleteInputRef;
      if (autocompleteInput && typeof autocompleteInput.insertReplacement === 'function') {
        const currentValue = inst.hsGetValue?.() || inst.ffzGetValue?.() || '';
        const matchResult = currentValue.match(/(:?\w+)$/);
        const current = matchResult ? matchResult[0] : '';

        log(' 🎯 Using insertReplacement fallback:', {
          replacement: matchedEmote.name,
          current: current
        });

        autocompleteInput.insertReplacement({
          current: current,
          replacement: matchedEmote.name
        });

        const inputEl = getInputElement();
        if (inputEl) inputEl.focus();
        return;
      }

      log(' ⚠️ No insertion method found')

    }, { capture: true, signal: acSignal }); // Capture phase but don't prevent propagation

    log(' ✅ Autocomplete click handler installed');
  }

  // MutationObserver to fix heatsync emote images in input (FFZ-style)
  let imageObserver = null;
  function installImageObserver() {
    if (imageObserver) return;

    imageObserver = cleanup.trackObserver(new MutationObserver(mutations => {
      for (const mut of mutations) {
        // Check added nodes
        for (const node of mut.addedNodes) {
          if (node instanceof Element) {
            // FFZ-style: Check for input preview elements
            const previewSpan = node.matches?.('[data-a-target="chat-input-emote-preview"]') ? node :
                                node.querySelector?.('[data-a-target="chat-input-emote-preview"]');
            if (previewSpan) {
              log(' 🎯 Found input preview span!', previewSpan);
              const previewImg = previewSpan.querySelector('img');
              if (previewImg) {
                log(' 🖼️ Preview img src:', previewImg.src?.substring(0, 80));
                fixEmoteImage(previewImg);
              }
            }

            // Also check for emote images in input area
            const inputPreviewImg = node.matches?.('img.chat-line__message--emote') ? node :
                                    node.querySelector?.('img.chat-line__message--emote');
            if (inputPreviewImg) {
              log(' 🎯 Found input emote img:', inputPreviewImg.src?.substring(0, 80));
              fixEmoteImage(inputPreviewImg);
            }

            // Debug: log autocomplete-related elements
            if (node.className?.includes?.('autocomplete') ||
                node.closest?.('[class*="autocomplete"]') ||
                node.querySelector?.('img')) {
              log(' 🔍 MutationObserver saw:', node.tagName, node.className);
            }
            checkForHeatsyncImages(node);
          }
        }
        // Also check attribute changes (src or srcset being set)
        if (mut.type === 'attributes' && (mut.attributeName === 'src' || mut.attributeName === 'srcset') && mut.target.tagName === 'IMG') {
          const val = mut.attributeName === 'src' ? mut.target.src : mut.target.srcset;
          log(' 🔍', mut.attributeName, 'attr changed:', val?.substring(0, 80));
          fixEmoteImage(mut.target);
        }
        // Re-apply styles when React resets them
        if (mut.type === 'attributes' && mut.attributeName === 'style') {
          const target = mut.target;
          // Check if this is a heatsync-fixed image or its container
          if (target.dataset?.heatsyncFixed || target.dataset?.heatsyncWide) {
            log(' 🔄 Style reset detected, re-fixing');
            if (target.tagName === 'IMG') {
              fixEmoteImage(target);
            } else {
              // It's a container - find the image inside and re-fix
              const img = target.querySelector('img[data-heatsync-fixed]');
              if (img) fixEmoteImage(img);
            }
          }
        }
      }
    }), 'autocomplete-image-observer');

    imageObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'srcset', 'style']
    });

    log(' ✅ Image observer installed (FFZ-style)');

    // Also watch for error events on images (failed loads = broken srcset)
    cleanup.addEventListener(document.body, 'error', (e) => {
      if (e.target?.tagName === 'IMG') {
        const img = e.target;
        const src = img.src || img.srcset || '';
        if (src.includes('__FFZ__999999::') || src.includes('jtvnw.net')) {
          log(' ❌ Image load error, attempting fix:', src.substring(0, 80));
          fixEmoteImage(img);
        }
      }
    }, 'image-error-handler', true);

    // Safety-net polling for emote image fixes the MutationObserver might miss
    // (pre-existing images, CSS background-images on autocomplete items)
    cleanup.setInterval(() => {
      const emotes = getHeatsyncEmotes();
      if (!emotes.length) return;

      const emoteByHash = new Map();
      for (const e of emotes) {
        if (e.hash) emoteByHash.set(e.hash, e);
      }

      for (const img of document.querySelectorAll('img')) {
        const src = img.src || '';
        const srcset = img.srcset || '';
        const srcsetNeedsFix = srcset.includes('jtvnw.net');
        if (img.dataset.heatsyncFixed && !srcsetNeedsFix) continue;

        const checkStr = src + ' ' + srcset;

        if (checkStr.includes('__FFZ__999999::')) {
          const match = checkStr.match(/__FFZ__999999::([a-zA-Z0-9]+)__FFZ__/);
          if (match) {
            const emote = emoteByHash.get(match[1]);
            if (emote) {
              img.src = emote.url;
              img.srcset = emote.url + ' 1x';
              img.dataset.heatsyncFixed = 'true';
            }
          }
        }

        if (checkStr.includes('jtvnw.net/emoticons/v2/')) {
          const match = checkStr.match(/emoticons\/v2\/([a-f0-9]{24})\/default/);
          if (match) {
            const emote = emoteByHash.get(match[1]);
            if (emote) {
              img.src = emote.url;
              img.srcset = emote.url + ' 1x';
              img.dataset.heatsyncFixed = 'true';
            }
          }
        }

        if (srcsetNeedsFix && (src.includes('betterttv.net') || src.includes('7tv.app') || src.includes('frankerfacez'))) {
          img.srcset = src + ' 1x';
          img.dataset.heatsyncFixed = 'true';
        }
      }

      // Fix CSS background-image on autocomplete dropdown items
      for (const el of document.querySelectorAll('.emote-autocomplete-provider__image, [class*="emote"][class*="image"]')) {
        if (el.dataset.heatsyncBgFixed) continue;
        const bgImg = window.getComputedStyle(el).backgroundImage;
        if (bgImg?.includes('__FFZ__999999::')) {
          const match = bgImg.match(/__FFZ__999999::([a-zA-Z0-9]+)__FFZ__/);
          if (match) {
            const emote = emoteByHash.get(match[1]);
            if (emote) {
              el.style.backgroundImage = `url("${emote.url}")`;
              el.dataset.heatsyncBgFixed = 'true';
            }
          }
        }
      }
    }, 2000, 'image-polling');
  }

  function checkForHeatsyncImages(node) {
    const allImages = node.querySelectorAll?.('img') ?? [];
    for (const img of allImages) fixEmoteImage(img);
    if (node.tagName === 'IMG') fixEmoteImage(node);

    // Also check tooltip layer for any images
    const tooltipImages = document.querySelectorAll('.tw-tooltip-layer img');
    for (const img of tooltipImages) {
      fixEmoteImage(img);
    }

    // Check autocomplete dropdown
    const autocompleteImages = document.querySelectorAll('[class*="autocomplete"] img, [class*="Autocomplete"] img');
    for (const img of autocompleteImages) {
      fixEmoteImage(img);
    }
  }

  // Fix a single emote image if it has a heatsync fake ID
  function fixEmoteImage(img) {
    if (!img || img.dataset.heatsyncFixed) return;

    // Skip images in our preview tooltips - we intentionally use max size there
    if (img.closest('.heatsync-emote-preview, .heatsync-emote-hover-preview, #heatsync-tab-preview, #heatsync-tab-tooltip')) return;

    const src = img.src || '';
    const srcset = img.srcset || '';
    const checkStr = src + ' ' + srcset;
    const emotes = getHeatsyncEmotes();

    // Check for pending preview from click handler (FFZ-style)
    const pending = window.__heatsyncPendingPreview;
    if (pending && Date.now() - pending.timestamp < 2000) {
      // Check if this img is in the input area (likely the preview we're waiting for)
      const isInInput = img.closest('[data-slate-editor="true"]') ||
                        img.closest('.chat-wysiwyg-input__editor');
      if (isInInput) {
        log(' 🎯 Found pending preview img, fixing:', pending.name);
        img.src = pending.url;
        img.srcset = pending.url + ' 1x';
        img.dataset.heatsyncFixed = 'true';
        img.style.height = '28px';
        img.style.width = 'auto';
        window.__heatsyncPendingPreview = null; // Clear pending
        return;
      }
    }

    // Check if this is a Twitch URL with our fake ID (in src OR srcset)
    // Format: https://static-cdn.jtvnw.net/emoticons/v2/__FFZ__999999::hash__FFZ__/...
    if (checkStr.includes('__FFZ__999999::')) {
      const match = checkStr.match(/__FFZ__999999::(.+?)__FFZ__/);
      if (match) {
        const hash = match[1];
        const emote = emotes.find(e => e.hash === hash);
        if (emote) {
          log(' 🖼️ Fixing emote image:', emote.name, 'hash:', hash, 'from:', src ? 'src' : 'srcset');
          img.src = emote.url;
          img.srcset = emote.url + ' 1x';
          img.dataset.heatsyncFixed = 'true';

          // Preserve aspect ratio with consistent height (match input line-height to prevent box expansion)
          img.style.height = '20px';
          img.style.width = 'auto';

          // Fix all parent containers to allow wide emotes
          const cont = img.closest('.chat-image__container');
          const span = img.closest('.wysiwig-chat-input-emote');

          // Set containers to auto width initially
          if (cont) {
            cont.style.height = '28px';
            cont.style.width = 'auto';
            cont.style.maxWidth = 'none';
            cont.style.overflow = 'visible';
          }
          if (span) {
            span.style.width = 'auto';
            span.style.minWidth = 'auto';
            span.style.maxWidth = 'none';
            span.style.overflow = 'visible';
            span.style.display = 'inline-block';
          }

          // After image loads, set proper dimensions on all containers
          const fixWidth = () => {
            if (img.naturalWidth && img.naturalHeight) {
              const aspectRatio = img.naturalWidth / img.naturalHeight;
              // Use 28px as base height (matches actual display height)
              const width = Math.round(28 * aspectRatio);
              const isWide = aspectRatio > 1.2;
              log(' 📐 Emote:', emote.name, 'aspect:', aspectRatio.toFixed(2), 'width:', width, 'wide:', isWide);

              // Re-find elements in case DOM changed
              const currentSpan = img.closest('.wysiwig-chat-input-emote');
              const currentCont = img.closest('.chat-image__container');

              // Mark as fixed for CSS targeting
              img.dataset.heatsyncFixed = 'true';

              // Set explicit dimensions and positioning on image - ensure left-aligned, no clipping
              img.style.cssText = `width: ${width}px !important; height: 28px !important; max-width: none !important; min-width: ${width}px !important; margin: 0 !important; padding: 0 !important; position: relative !important; left: 0 !important; right: auto !important; transform: none !important; float: none !important; display: inline-block !important; vertical-align: middle !important; object-position: left center !important;`;

              // Set dimensions on container using cssText for atomic update
              if (currentCont) {
                currentCont.style.cssText = `width: ${width}px !important; min-width: ${width}px !important; height: 28px !important; overflow: visible !important; display: inline-block !important; text-align: left !important; margin: 0 !important; padding: 0 !important; vertical-align: middle !important;`;
              }

              // Set dimensions on span wrapper using cssText for atomic update
              if (currentSpan) {
                currentSpan.style.cssText = `width: ${width}px !important; min-width: ${width}px !important; height: 28px !important; overflow: visible !important; display: inline-block !important; text-align: left !important; vertical-align: middle !important; margin: 0 !important; padding: 0 !important;`;
                if (isWide) {
                  currentSpan.dataset.heatsyncWide = 'true';
                }
                log(' 📐 Set span width:', width + 'px');
              }
            }
          };

          if (img.complete && img.naturalWidth) {
            fixWidth();
          } else {
            img.addEventListener('load', fixWidth, { once: true });
          }
          return;
        }
      }
    }

    // Also check jtvnw URLs that might be broken (404ing) - match by alt text
    const alt = img.alt || '';
    if (alt && (src.includes('jtvnw.net') || !src || img.complete === false)) {
      const emote = emotes.find(e => e.name === alt);
      if (emote) {
        log(' 🖼️ Fixing emote by alt:', emote.name);
        img.src = emote.url;
        img.srcset = emote.url + ' 1x';
        img.dataset.heatsyncFixed = 'true';

        // Same wide emote fix
        img.style.height = '28px';
        img.style.width = 'auto';

        const cont = img.closest('.chat-image__container');
        const span = img.closest('.wysiwig-chat-input-emote');

        if (cont) {
          cont.style.height = '28px';
          cont.style.width = 'auto';
          cont.style.maxWidth = 'none';
          cont.style.overflow = 'visible';
        }
        if (span) {
          span.style.width = 'auto';
          span.style.minWidth = 'auto';
          span.style.maxWidth = 'none';
          span.style.overflow = 'visible';
          span.style.display = 'inline-block';
        }

        const fixWidth = () => {
          if (img.naturalWidth && img.naturalHeight) {
            const aspectRatio = img.naturalWidth / img.naturalHeight;
            // Use 28px as base height (matches actual display height)
            const width = Math.round(28 * aspectRatio);
            const isWide = aspectRatio > 1.2;
            log(' 📐 Emote (alt):', emote.name, 'aspect:', aspectRatio.toFixed(2), 'width:', width, 'wide:', isWide);

            // Re-find elements in case DOM changed
            const currentSpan = img.closest('.wysiwig-chat-input-emote');
            const currentCont = img.closest('.chat-image__container');

            // Mark as fixed for CSS targeting
            img.dataset.heatsyncFixed = 'true';

            // Set explicit dimensions and positioning on image - ensure left-aligned, no clipping
            img.style.cssText = `width: ${width}px !important; height: 28px !important; max-width: none !important; min-width: ${width}px !important; margin: 0 !important; padding: 0 !important; position: relative !important; left: 0 !important; right: auto !important; transform: none !important; float: none !important; display: inline-block !important; vertical-align: middle !important; object-position: left center !important;`;

            // Set dimensions on container using cssText for atomic update
            if (currentCont) {
              currentCont.style.cssText = `width: ${width}px !important; min-width: ${width}px !important; height: 28px !important; overflow: visible !important; display: inline-block !important; text-align: left !important; margin: 0 !important; padding: 0 !important; vertical-align: middle !important;`;
            }

            // Set dimensions on span wrapper using cssText for atomic update
            if (currentSpan) {
              currentSpan.style.cssText = `width: ${width}px !important; min-width: ${width}px !important; height: 28px !important; overflow: visible !important; display: inline-block !important; text-align: left !important; vertical-align: middle !important; margin: 0 !important; padding: 0 !important;`;
              if (isWide) {
                currentSpan.dataset.heatsyncWide = 'true';
              }
              log(' 📐 Set span width (alt):', width + 'px');
            }
          }
        };

        if (img.complete && img.naturalWidth) {
          fixWidth();
        } else {
          img.addEventListener('load', fixWidth, { once: true });
        }
      }
    }
  }

  // Get the chat input DOM element
  function getInputElement() {
    return document.querySelector('[data-slate-editor="true"]') ||
           document.querySelector('.chat-wysiwyg-input__editor') ||
           document.querySelector('[data-a-target="chat-input"]');
  }

  // Hook Slate normalizer to prevent emote conversion when WYSIWYG is off
  function hookNormalizer(inst) {
    const slateEditor = inst?.chatInputRef?.state?.slateEditor;
    if (!slateEditor || slateEditor._heatsyncNormalizerHooked) return;

    const originalNormalize = slateEditor.normalizeNode;
    slateEditor._heatsyncOriginalNormalize = originalNormalize;
    slateEditor._heatsyncNormalizerHooked = true;

    // Restore original on abort (extension reload)
    acSignal.addEventListener('abort', () => {
      slateEditor.normalizeNode = originalNormalize;
      slateEditor._heatsyncNormalizerHooked = false;
    });

    slateEditor.normalizeNode = function(entry) {
      const settings = getExtensionSettings();
      // If WYSIWYG is OFF, skip ALL emote normalization (Twitch + ours)
      if (settings.emoteWysiwyg === false) {
        const [node, path] = entry;
        // Block normalization of text nodes - prevents ALL emote conversions
        if (node.text) {
          return;
        }
        // Also block emote node normalization
        if (node.type === 'emote') {
          return;
        }
      }
      return originalNormalize.call(this, entry);
    };
    log(' ✅ Hooked Slate normalizer for WYSIWYG text mode');
  }

  // Main init
  let clickHandlerInstalled = false;
  function init() {
    log('🚀 init() called');
    chatInputInst = findChatInput();
    if (chatInputInst) {
      log('✅ Chat input FOUND, installing handlers');
      overrideEmoteProvider(chatInputInst); // Override getMatches like FFZ
      hookComponentDidUpdate(chatInputInst); // Re-inject when props change
      hookInsertReplacement(chatInputInst);  // Pass-through hook (cleanup on reload)
      hookNormalizer(chatInputInst);         // Block emote conversion when WYSIWYG off
      injectFakeEmotes(chatInputInst); // Inject fake emotes for inline rendering
      installImageObserver(); // Watch for images to fix
      if (!clickHandlerInstalled) {
        installAutocompleteClickHandler(); // Handle clicks on our emotes
        installAutocompleteKeyHandler();   // Handle Tab on our emotes (Enter never touched)
        clickHandlerInstalled = true;
        log('✅ Key handlers installed');
      }
    } else {
      log('❌ Chat input NOT found');
    }
  }

  // Handle navigation
  let lastUrl = location.href;
  cleanup.trackObserver(new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      cleanup.setTimeout(init, 500, 'autocomplete-nav-reinit');
    }
  }), 'autocomplete-nav-observer').observe(document, { subtree: true, childList: true });

  // Initial run
  cleanup.setTimeout(init, 1000, 'autocomplete-initial');

  // Listen for emote updates - re-inject fake emotes when inventory changes
  const bridge = document.getElementById('heatsync-emote-bridge');
  if (bridge) {
    bridge.addEventListener('heatsync-emotes-updated', () => {
      // Re-inject fake emotes to reflect inventory changes (added/removed emotes)
      if (chatInputInstance) {
        injectFakeEmotes(chatInputInstance);
      }
      log(' Emotes updated (tab state preserved)');
    }, { signal: acSignal });
  }

  log(' 🎯 FFZ-style inline tab completion initialized');
})();
