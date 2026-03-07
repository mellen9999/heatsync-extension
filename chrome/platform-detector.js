// Platform detector - Detect Twitch vs Kick chat
(function() {
  'use strict';

  const DEBUG = false;
  const log = DEBUG ? console.log.bind(console, '[heatsync-platform]') : () => {};
  log(' Platform detector loaded');

  /**
   * Detect which platform the user is on
   * @returns {string|null} 'twitch' | 'kick' | null
   */
  function detectPlatform() {
    const hostname = window.location.hostname;

    if (hostname.includes('twitch.tv')) {
      return 'twitch';
    } else if (hostname.includes('kick.com')) {
      return 'kick';
    } else if (hostname.includes('youtube.com')) {
      return 'youtube';
    }

    return null;
  }

  /**
   * Get platform-specific chat selectors
   * @returns {object|null} { container, message, username, messageText } | null
   */
  function getPlatformSelectors() {
    const platform = detectPlatform();

    if (platform === 'twitch') {
      return {
        container: '.chat-scrollable-area__message-container',
        message: '.chat-line__message',
        username: '.chat-author__display-name',
        messageText: '.text-fragment',
        messageContainer: '.chat-line__no-background'
      };
    } else if (platform === 'kick') {
      return {
        container: '#chatroom .chat-entry-list',
        message: '.chat-entry',
        username: '.chat-entry-username',
        messageText: '.chat-entry-content',
        messageContainer: '.chat-entry'
      };
    } else if (platform === 'youtube') {
      return {
        container: 'yt-live-chat-item-list-renderer #items',
        message: 'yt-live-chat-text-message-renderer',
        username: '#author-name',
        messageText: '#message',
        messageContainer: 'yt-live-chat-text-message-renderer'
      };
    }

    return null;
  }

  /**
   * Wait for chat container to be ready
   * @returns {Promise<Element>} Chat container element
   */
  function waitForChatContainer() {
    const selectors = getPlatformSelectors();
    if (!selectors) {
      return Promise.reject(new Error('Unsupported platform'));
    }

    return new Promise((resolve, reject) => {
      let elapsed = 0
      const check = () => {
        const container = document.querySelector(selectors.container)
        if (container) {
          resolve(container)
        } else if (elapsed >= 15000) {
          reject(new Error('Chat container not found after 15s'))
        } else {
          elapsed += 500
          setTimeout(check, 500)
        }
      }
      check()
    });
  }

  // Export for use in other scripts
  window.heatsyncPlatform = {
    detectPlatform,
    getPlatformSelectors,
    waitForChatContainer
  };

  log(' Detected platform:', detectPlatform());
})();
