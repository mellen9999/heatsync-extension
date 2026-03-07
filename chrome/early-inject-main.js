// Runs in MAIN world at document_start BEFORE Twitch's JS
// Intercepts image src/srcset setters to fix heatsync emote URLs
(function() {
  'use strict'

  const DEBUG = false
  const log = DEBUG ? console.log.bind(console, '[heatsync-early]') : () => {}

  // Store for emote URL mappings (populated by content script)
  window.__heatsyncEmoteUrls = window.__heatsyncEmoteUrls || {}
  let urlMapWasEmpty = true

  // Listen for URL map updates from content script
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin) return
    if (e.data?.type === 'heatsync-url-map' && e.data.urlMap) {
      const wasEmpty = urlMapWasEmpty
      Object.assign(window.__heatsyncEmoteUrls, e.data.urlMap)
      urlMapWasEmpty = Object.keys(window.__heatsyncEmoteUrls).length === 0

      if (wasEmpty && !urlMapWasEmpty) {
        fixExistingImages()
      }
    }
  })

  function fixExistingImages() {
    const images = document.querySelectorAll('img[src*="__FFZ__999999"], img[src*="jtvnw.net/emoticons/v2/"]')
    images.forEach(img => {
      if (img.dataset.heatsyncFixed) return
      const fixedUrl = fixUrl(img.src)
      if (fixedUrl) {
        img.src = fixedUrl
        img.dataset.heatsyncFixed = 'true'
      }
    })
  }

  function fixUrl(value) {
    if (!value || typeof value !== 'string') return null

    if (value.includes('__FFZ__999999::')) {
      const match = value.match(/__FFZ__999999::([a-zA-Z0-9]+)__FFZ__/)
      if (match) {
        const url = window.__heatsyncEmoteUrls?.[match[1]]
        if (url) return url
      }
    }

    if (value.includes('jtvnw.net/emoticons/v2/__FFZ__')) {
      const match = value.match(/__FFZ__999999::([a-f0-9]+)__FFZ__/)
      if (match) {
        const url = window.__heatsyncEmoteUrls?.[match[1]]
        if (url) return url
      }
    }

    if (value.includes('jtvnw.net/emoticons/v2/')) {
      const match = value.match(/emoticons\/v2\/([a-f0-9]{24})\/default/)
      if (match) {
        const url = window.__heatsyncEmoteUrls?.[match[1]]
        if (url) return url
      }
    }

    return null
  }

  // Override img.src setter
  const srcDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')
  if (srcDesc) {
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      get: function() { return srcDesc.get.call(this) },
      set: function(value) {
        const fixed = fixUrl(value)
        if (fixed) {
          this.dataset.heatsyncFixed = 'true'
          return srcDesc.set.call(this, fixed)
        }
        return srcDesc.set.call(this, value)
      },
      configurable: true,
      enumerable: true
    })
  }

  // Override setAttribute for src and srcset
  const origSetAttr = Element.prototype.setAttribute
  Element.prototype.setAttribute = function(name, value) {
    if (this.tagName === 'IMG' && (name === 'src' || name === 'srcset')) {
      const fixed = fixUrl(value)
      if (fixed) {
        this.dataset.heatsyncFixed = 'true'
        const fixedValue = name === 'srcset' ? fixed + ' 1x' : fixed
        return origSetAttr.call(this, name, fixedValue)
      }
    }
    return origSetAttr.call(this, name, value)
  }

  // Override srcset property setter
  const srcsetDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'srcset')
  if (srcsetDesc) {
    Object.defineProperty(HTMLImageElement.prototype, 'srcset', {
      get: function() { return srcsetDesc.get.call(this) },
      set: function(value) {
        const fixed = fixUrl(value)
        if (fixed) {
          this.dataset.heatsyncFixed = 'true'
          return srcsetDesc.set.call(this, fixed + ' 1x')
        }
        return srcsetDesc.set.call(this, value)
      },
      configurable: true,
      enumerable: true
    })
  }

  // Override Image constructor
  const OrigImage = window.Image
  window.Image = function(width, height) {
    const img = new OrigImage(width, height)
    const instSrcDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')
    Object.defineProperty(img, 'src', {
      get: function() { return instSrcDesc.get.call(img) },
      set: function(value) {
        const fixed = fixUrl(value)
        if (fixed) {
          img.dataset.heatsyncFixed = 'true'
          return instSrcDesc.set.call(img, fixed)
        }
        return instSrcDesc.set.call(img, value)
      },
      configurable: true,
      enumerable: true
    })
    return img
  }
  window.Image.prototype = OrigImage.prototype

  // Override createElement for img tags
  const origCreateElement = document.createElement.bind(document)
  document.createElement = function(tag, options) {
    const el = origCreateElement(tag, options)
    if (tag.toLowerCase() === 'img') {
      const instSrcDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')
      Object.defineProperty(el, 'src', {
        get: function() { return instSrcDesc.get.call(el) },
        set: function(value) {
          const fixed = fixUrl(value)
          if (fixed) {
            el.dataset.heatsyncFixed = 'true'
            return instSrcDesc.set.call(el, fixed)
          }
          return instSrcDesc.set.call(el, value)
        },
        configurable: true,
        enumerable: true
      })
    }
    return el
  }
})()
