// Chrome compatibility polyfill
// Makes browser.* API work in Chrome by aliasing to chrome.*
if (typeof browser === 'undefined') {
  // Service workers use 'self' instead of 'window'
  const globalScope = typeof self !== 'undefined' ? self : window;
  globalScope.browser = chrome;
}
