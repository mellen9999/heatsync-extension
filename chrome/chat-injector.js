// OP Message Injector - Inject followed users' red OP posts into Twitch/Kick chat
(function() {
  'use strict';

  const DEBUG = false;
  const log = DEBUG ? console.log.bind(console, '[heatsync-injector]') : () => {};
  log(' Chat injector loaded');

  function sanitizeColor(color) {
    if (!color) return '#ffffff'
    if (/^#[0-9a-fA-F]{3,6}$/.test(color)) return color
    return '#ffffff'
  }

  // Lifecycle controller for cleanup
  const lifecycle = new AbortController()
  const injSignal = lifecycle.signal
  window.addEventListener('pagehide', () => lifecycle.abort())

  let followedUsers = new Set(); // Users the current user follows
  let injectedMessages = new Set(); // Track injected message IDs to prevent duplicates
  let chatReady = false;

  // Set up message listener IMMEDIATELY (not inside async init)
  chrome.runtime.onMessage.addListener((message) => {
  log(' 📬 Got runtime message:', message.type, message);
  if (message.type === 'new-message') {
    log(' 📬 Calling handleNewMessage with:', message.data);
    if (chatReady) {
      handleNewMessage(message.data);
    } else {
      log(' Chat not ready, queueing message');
      if (!window._queuedMessages) window._queuedMessages = [];
      if (window._queuedMessages.length < 200) {
        window._queuedMessages.push(message.data);
      }
    }
  } else if (message.type === 'followed_users_updated') {
    followedUsers = new Set(message.users);
    log(' Updated followed users:', followedUsers.size);
  }
});

/**
 * Inject CSS to prevent hover effects on injected messages
 */
function injectHoverBlockCSS() {
  if (document.getElementById('heatsync-hover-block')) return; // Already injected

  const style = document.createElement('style');
  style.id = 'heatsync-hover-block';
  style.textContent = `
    .heatsync-injected-message,
    .heatsync-injected-message:hover,
    .heatsync-injected-message *,
    .heatsync-injected-message *:hover {
      background: transparent !important;
      cursor: default !important;
    }
    .heatsync-injected-message .heatsync-clickable {
      background: #ff0000 !important;
      cursor: pointer !important;
    }
    .heatsync-injected-message .heatsync-clickable:hover:not(.emote-hovered) {
      background: #808000 !important;
    }
    .heatsync-injected-message .heatsync-emote {
      cursor: pointer !important;
      display: inline !important;
      vertical-align: middle !important;
      position: relative;
      z-index: 10;
    }
    .heatsync-injected-message .heatsync-emote:hover {
      filter: brightness(1.3);
    }
    /* Emote hover tooltip */
    #heatsync-emote-tooltip {
      position: fixed;
      z-index: 999999;
      background: rgba(0, 0, 0, 0.95);
      border-radius: 0;
      padding: 4px;
      pointer-events: none;
      display: none;
      transform: translate(-50%, calc(-100% - 8px));
    }
    #heatsync-emote-tooltip.active {
      display: block;
    }
    #heatsync-emote-tooltip img {
      display: block;
      max-width: 128px;
      max-height: 128px;
      image-rendering: pixelated;
      image-rendering: -moz-crisp-edges;
    }
    .heatsync-injected-message .heatsync-op-badge,
    .heatsync-injected-message .heatsync-op-badge:hover {
      background: #ff0000 !important;
    }
  `;
  document.head.appendChild(style);
}

/**
 * Get max quality URL for an emote based on its CDN
 */
function getMaxQualityEmoteUrl(url) {
  if (!url) return url;
  // BTTV: /1x → /3x
  if (url.includes('cdn.betterttv.net')) {
    return url.replace(/\/[12]x(\.webp)?/, '/3x$1');
  }
  // FFZ: /1 or /2 → /4
  if (url.includes('cdn.frankerfacez.com')) {
    return url.replace(/\/[123]$/, '/4');
  }
  // 7TV: /1x or /2x → /4x
  if (url.includes('cdn.7tv.app')) {
    return url.replace(/\/[123]x(\.webp)?/, '/4x$1');
  }
  // Twitch: /1.0 or /2.0 → /3.0
  if (url.includes('static-cdn.jtvnw.net')) {
    return url.replace(/\/[12]\.0/, '/3.0');
  }
  return url;
}

/**
 * Show emote tooltip with high-res preview
 */
function showEmoteTooltip(emote, event) {
  let tooltip = document.getElementById('heatsync-emote-tooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.id = 'heatsync-emote-tooltip';
    const img = document.createElement('img');
    tooltip.appendChild(img);
    document.body.appendChild(tooltip);
  }

  const highResUrl = getMaxQualityEmoteUrl(emote.src);
  const img = tooltip.querySelector('img');
  if (img.src !== highResUrl) {
    img.src = highResUrl;
  }

  const rect = emote.getBoundingClientRect();
  tooltip.style.left = (rect.left + rect.width / 2) + 'px';
  tooltip.style.top = (rect.top - 8) + 'px';
  tooltip.classList.add('active');
}

/**
 * Hide emote tooltip
 */
function hideEmoteTooltip() {
  const tooltip = document.getElementById('heatsync-emote-tooltip');
  if (tooltip) {
    tooltip.classList.remove('active');
  }
}

/**
 * Setup emote hover listeners for injected messages
 */
function setupEmoteHoverListeners(container) {
  container.querySelectorAll('.heatsync-emote').forEach(emote => {
    if (emote._tooltipSetup) return;
    emote._tooltipSetup = true;
    emote.addEventListener('mouseenter', (e) => showEmoteTooltip(emote, e), { signal: injSignal });
    emote.addEventListener('mouseleave', hideEmoteTooltip, { signal: injSignal });
  });
}

/**
 * Initialize chat injector - wait for platform detection and WebSocket
 */
async function initChatInjector() {
  try {
    // Wait for platform detection
    if (!window.heatsyncPlatform) {
      log(' Waiting for platform detector...');
      await new Promise((resolve) => {
        const checkInterval = setInterval(() => {
          if (window.heatsyncPlatform) {
            clearInterval(checkInterval);
            resolve();
          }
        }, 100);
        injSignal.addEventListener('abort', () => clearInterval(checkInterval));
      });
    }

    const platform = window.heatsyncPlatform.detectPlatform();
    if (!platform) {
      log(' Not on Twitch/Kick, skipping');
      return;
    }

    log(' Initializing on platform:', platform);

    // Wait for chat container
    const chatContainer = await window.heatsyncPlatform.waitForChatContainer();
    log(' Chat container ready:', chatContainer);

    // Inject CSS to prevent hover effects
    injectHoverBlockCSS();

    // Load followed users list
    await loadFollowedUsers();

    // Setup tab completion
    await setupTabCompletion(platform);

    chatReady = true;

    // Process queued messages
    if (window._queuedMessages?.length) {
      log(' Processing', window._queuedMessages.length, 'queued messages');
      window._queuedMessages.forEach(handleNewMessage);
      window._queuedMessages = [];
    }

    log(' ✅ Initialized successfully');
  } catch (error) {
  }
}

/**
 * Load followed users from background script
 */
async function loadFollowedUsers() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'get_followed_users' });
    if (response && response.users) {
      followedUsers = new Set(response.users);
      log(' Loaded followed users:', followedUsers.size);
    }
  } catch (error) {
  }
}

/**
 * Get input state from either textarea or contenteditable (Slate)
 */
function getInputState(element) {
  const isContentEditable = element.getAttribute('contenteditable') === 'true' ||
                            element.hasAttribute('data-slate-editor');

  if (isContentEditable) {
    const selection = window.getSelection();
    if (!selection.rangeCount) return { text: '', cursorPos: 0, isSlate: true };

    const range = selection.getRangeAt(0);
    const text = (element.textContent || '').replace(/\n/g, '');

    // Calculate cursor position by walking text nodes
    let cursorPos = 0;
    const treeWalker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = treeWalker.nextNode())) {
      if (node === range.startContainer) {
        cursorPos += range.startOffset;
        break;
      }
      cursorPos += node.textContent.length;
    }

    return { text, cursorPos, isSlate: true };
  } else {
    return {
      text: element.value || '',
      cursorPos: element.selectionStart || 0,
      isSlate: false
    };
  }
}

/**
 * Set text in contenteditable (Slate) element
 */
function setSlateText(element, newText) {
  // Clear existing content
  element.textContent = newText;

  // Dispatch input event for React/Slate to sync
  element.dispatchEvent(new InputEvent('input', {
    bubbles: true,
    cancelable: true,
    inputType: 'insertText',
    data: newText
  }));

  // Move cursor to end
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false); // false = collapse to end
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * Setup tab completion for @username mentions
 */
async function setupTabCompletion(platform) {
  // Tab completion state
  let autocompleteMatches = [];
  let autocompleteIndex = -1;
  let autocompleteActive = false;
  let autocompleteStartPos = 0;

  // Wait for chat input field
  let chatInput = null;
  const maxAttempts = 50;
  for (let i = 0; i < maxAttempts; i++) {
    if (platform === 'twitch') {
      chatInput = document.querySelector('[data-a-target="chat-input"]');
    } else if (platform === 'kick') {
      chatInput = document.querySelector('textarea[placeholder*="chat"]');
    }

    if (chatInput) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  if (!chatInput) {
    return;
  }

  log(' Tab completion enabled on', platform);

  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();

      const state = getInputState(chatInput);
      const textBeforeCursor = state.text.substring(0, state.cursorPos);

      // Find current word (from last space or @)
      const lastAtIndex = textBeforeCursor.lastIndexOf('@');
      const lastSpaceIndex = textBeforeCursor.lastIndexOf(' ');
      const wordStart = Math.max(lastAtIndex, lastSpaceIndex) + 1;
      const currentWord = textBeforeCursor.substring(wordStart);

      // If cycling through matches
      if (autocompleteActive && autocompleteMatches.length > 0) {
        autocompleteIndex = (autocompleteIndex + 1) % autocompleteMatches.length;
        completeUsername(chatInput, autocompleteMatches[autocompleteIndex], autocompleteStartPos, state.isSlate);
        return;
      }

      // New autocomplete session
      const partialWord = currentWord.replace(/^@/, '').toLowerCase();

      if (!partialWord || followedUsers.size === 0) {
        autocompleteActive = false;
        return;
      }

      // Find matching usernames
      autocompleteMatches = Array.from(followedUsers).filter(username =>
        username.toLowerCase().includes(partialWord)
      ).sort();

      if (autocompleteMatches.length > 0) {
        autocompleteStartPos = wordStart;
        autocompleteIndex = 0;
        autocompleteActive = true;
        completeUsername(chatInput, autocompleteMatches[0], wordStart, state.isSlate);
      } else {
        autocompleteActive = false;
      }
    } else if (e.key === 'Escape' && autocompleteActive) {
      e.preventDefault();
      autocompleteMatches = [];
      autocompleteIndex = -1;
      autocompleteActive = false;
    } else {
      // Any other key resets autocomplete
      autocompleteMatches = [];
      autocompleteIndex = -1;
      autocompleteActive = false;
    }
  }, { signal: injSignal });
}

/**
 * Complete username in input field
 */
function completeUsername(input, username, startPos, isSlate) {
  const state = getInputState(input);
  const prefix = state.text.substring(0, startPos);
  const textAfterWord = state.text.substring(state.cursorPos);
  const needsAt = !prefix.endsWith('@');
  const completedText = prefix + (needsAt ? '@' : '') + username + ' ' + textAfterWord;

  if (isSlate) {
    setSlateText(input, completedText);
  } else {
    input.value = completedText;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const newCursorPos = startPos + (needsAt ? 1 : 0) + username.length + 1;
    input.setSelectionRange(newCursorPos, newCursorPos);
  }
}

/**
 * Handle new message from WebSocket
 * @param {object} message - Message data from WebSocket
 */
function handleNewMessage(message) {
  log(' 🔍 handleNewMessage called:', {
    base36_id: message.base36_id,
    is_op: message.is_op,
    content: message.content?.substring(0, 30),
    already_injected: injectedMessages.has(message.base36_id)
  });

  // Check if message qualifies for injection
  if (!message.is_op) {
    log(' ❌ Skipping: not an OP (is_op:', message.is_op, ')');
    return; // Not an OP message
  }

  if (injectedMessages.has(message.base36_id)) {
    log(' ❌ Skipping: already injected');
    return; // Already injected
  }

  log(' 🔥 Injecting OP message:', message.content);
  injectMessage(message);
  injectedMessages.add(message.base36_id);
  if (injectedMessages.size > 500) {
    const arr = [...injectedMessages]
    injectedMessages.clear()
    arr.slice(-250).forEach(id => injectedMessages.add(id))
  }
}

/**
 * Inject OP message into native chat
 * @param {object} message - Message to inject
 */
function injectMessage(message) {
  const selectors = window.heatsyncPlatform.getPlatformSelectors();
  if (!selectors) return;

  const container = document.querySelector(selectors.container);
  if (!container) {
    return;
  }

  const platform = window.heatsyncPlatform.detectPlatform();
  const messageElement = createMessageElement(message, platform);

  // Inject at the bottom of chat (new messages appear at bottom)
  container.appendChild(messageElement);

  // Setup emote hover tooltips for this message
  setupEmoteHoverListeners(messageElement);

  // Scroll to bottom if user is near bottom
  const scrollParent = container.parentElement || container;
  const isNearBottom = scrollParent.scrollTop + scrollParent.clientHeight >= scrollParent.scrollHeight - 100;

  if (isNearBottom) {
    setTimeout(() => {
      scrollParent.scrollTop = scrollParent.scrollHeight;
    }, 10);
  }
}

/**
 * Create fake message element matching platform style
 * @param {object} message - Message data
 * @param {string} platform - 'twitch' | 'kick'
 * @returns {HTMLElement} Message element
 */
function createMessageElement(message, platform) {
  const div = document.createElement('div');
  div.className = 'heatsync-injected-message';
  div.dataset.messageId = message.base36_id;

  if (platform === 'twitch') {
    div.className += ' heatsync-twitch-message';
    div.innerHTML = `
      <div class="chat-line__no-background" style="padding: 0 8px; transition: none !important; opacity: 1 !important; filter: none !important; background: transparent !important; min-height: 32px;">
        <div class="chat-line__message" style="transition: none !important; background: transparent !important;">
          <span class="heatsync-op-badge" style="display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; background: #ff0000; color: #ffffff; border-radius: 0 !important; font-size: 10px; font-weight: 400; font-family: monospace; margin: 0 1px; margin-right: 6px; vertical-align: middle; padding: 0; white-space: nowrap; box-sizing: border-box; line-height: 1;">OP</span>
          <span class="chat-author__display-name" style="font-weight: 700; color: ${sanitizeColor(message.user_color)}; transition: none !important;">
            ${escapeHtml(message.display_name || message.username)}
          </span>
          <span style="margin: 0 4px; transition: none !important;">:</span>
          <span class="text-fragment heatsync-clickable" style="background: #ff0000; color: #ffffff; padding: 2px 4px; font-weight: bold; transition: none !important; cursor: pointer;">${parseTwitchEmotes(message.content)}</span>
        </div>
      </div>
    `;
  } else if (platform === 'kick') {
    div.className += ' heatsync-kick-message';
    div.innerHTML = `
      <div class="chat-entry" style="padding: 8px; margin: 4px 0; min-height: 32px;">
        <span class="heatsync-op-badge" style="display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; background: #ff0000; color: #ffffff; border-radius: 0; font-size: 10px; font-weight: 400; font-family: monospace; margin-right: 6px;">OP</span>
        <span class="chat-entry-username" style="font-weight: 700; color: ${sanitizeColor(message.user_color) || '#00ff00'};">
          ${escapeHtml(message.display_name || message.username)}
        </span>
        <span style="margin: 0 4px;">:</span>
        <span class="chat-entry-content heatsync-clickable" style="background: #ff0000; color: #ffffff; padding: 2px 4px; font-weight: bold; cursor: pointer;">${parseTwitchEmotes(message.content)}</span>
      </div>
    `;
  }

  // Add click handler only to red text span
  const clickableSpan = div.querySelector('.heatsync-clickable');
  if (clickableSpan) {
    clickableSpan.addEventListener('click', (e) => {
      // Don't open post if clicking on an emote
      if (e.target.classList.contains('heatsync-emote')) {
        return;
      }
      const url = `https://heatsync.org/m/${message.base36_id}`;
      window.open(url, '_blank');
    }, { signal: injSignal });
  }

  // Stop emote clicks from bubbling to parent (prevents opening post when clicking emote)
  // Also handle hover state to prevent parent hover effect
  div.querySelectorAll('.heatsync-emote').forEach(emote => {
    emote.addEventListener('click', (e) => {
      e.stopPropagation();
      e.stopImmediatePropagation();
      e.preventDefault();
      log(' Emote clicked:', emote.alt);
      return false;
    }, { capture: true, signal: injSignal });
    emote.addEventListener('mouseenter', () => {
      clickableSpan?.classList.add('emote-hovered');
    }, { signal: injSignal });
    emote.addEventListener('mouseleave', () => {
      clickableSpan?.classList.remove('emote-hovered');
    }, { signal: injSignal });
  });

  return div;
}

/**
 * Escape HTML to prevent XSS
 * @param {string} text - Text to escape
 * @returns {string} Escaped text
 */
function escapeHtml(text) {
  return text.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

// Twitch global emotes - map of text codes to emote IDs
const TWITCH_GLOBAL_EMOTES = {
  '<3': '9',           // Heart (escaped as &lt;3 from server)
  ':)': '1',
  ':(': '2',
  ':o': '7',
  ':O': '7',
  ':z': '5',
  ':Z': '5',
  'B)': '3',
  ':\\': '10',
  ':/': '10',
  ';)': '11',
  ';p': '13',
  ';P': '13',
  ':p': '12',
  ':P': '12',
  'R)': '14',
  'o_O': '6',
  'O_o': '6',
  '>(' : '4',
  '<]': '8',
  'Kappa': '25',
  'PogChamp': '305954156',
  'LUL': '425618',
  '4Head': '354',
  'HeyGuys': '30259',
  'NotLikeThis': '58765',
  'BibleThump': '86',
  'ResidentSleeper': '245',
  'Kreygasm': '41',
  'PJSalt': '36',
  'TriHard': '120232',
  'CoolStoryBob': '123171',
  'SeemsGood': '64138',
  'VoHiYo': '81274'
};

/**
 * Parse Twitch emotes in text and replace with img tags
 * @param {string} text - Text content (already HTML escaped from server)
 * @returns {string} Text with emote img tags
 */
// Pre-compiled regex + replacement HTML for each emote (built once, reused per message)
const _emoteReplacements = Object.entries(TWITCH_GLOBAL_EMOTES)
  .filter(([code]) => code !== '<3')
  .map(([code, id]) => {
    const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return {
      regex: new RegExp(`(?<=^|\\s|>)${escaped}(?=$|\\s|<)`, 'g'),
      html: `<img class="chat-image chat-line__message--emote heatsync-emote" src="https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/1.0" alt="${escapeHtml(code)}" style="height: 28px; vertical-align: middle;">`
    };
  });

function parseTwitchEmotes(text) {
  let result = escapeHtml(text)

  // Handle &lt;3 (escaped <3)
  result = result.replace(/&lt;3/g,
    '<img class="chat-image chat-line__message--emote heatsync-emote" src="https://static-cdn.jtvnw.net/emoticons/v2/9/default/dark/1.0" alt="<3" style="height: 28px; vertical-align: middle;">');

  // Use pre-compiled regexes
  for (const { regex, html } of _emoteReplacements) {
    result = result.replace(regex, html);
  }

  return result;
}

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initChatInjector, { signal: injSignal });
  } else {
    initChatInjector();
  }
})();
