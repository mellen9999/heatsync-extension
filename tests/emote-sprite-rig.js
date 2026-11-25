// The sprite rung as the bundle runs it, minus the browser.
//
// Three pieces, all REAL source: the site's animated-texture.js (wrapped by build.js's own
// scopeSiteModule, so the text under test is the text that ships), emotes.js's idle gate (sliced
// out by name, as emote-idle-gate.test.js does — the file cannot be imported whole), and
// multichat/emote-sprite.js, concatenated after it in ONE function scope the way the bundle does.
// What is faked is only what a browser supplies: the decoder, fetch, a canvas, Image.decode.
//
// happy-dom has no ImageDecoder, which is why the module short-circuits to the <img> in every
// other suite and why this rig has to build the decoder itself rather than assume it.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { scopeSiteModule } from '../scripts/lib/scope-site-module.mjs'

const ROOT = join(import.meta.dir, '..')
const TEXTURE = readFileSync(join(ROOT, 'src', 'lib', 'animated-texture.js'), 'utf8')
const EMOTES = readFileSync(join(ROOT, 'src', 'multichat', 'emotes.js'), 'utf8')
const SPRITE = readFileSync(join(ROOT, 'src', 'multichat', 'emote-sprite.js'), 'utf8')

const GATE_START = "let emoteAnimationMode = 'always'"
const GATE_END = '\n// Scroll is when visibility changes'

export const ANIM = 'https://cdn.7tv.app/emote/abc/2x.webp'

export function makeRig() {
  const win = new Window()
  const doc = win.document
  const s = {
    decodeCalls: [],
    fetchCalls: [],
    frameCount: 4,
    contentType: 'image/webp',
    animated: true,
    hidden: false,
    frame: 500,
    warned: [],
  }

  // MATCHES THE REAL API, INCLUDING THE PART THAT BIT THE SITE: `completed` answers "have the bytes
  // decoded", `tracks.ready` answers "is the track list populated", and selectedTrack is null until
  // the second settles. It settles on a MACROtask so code awaiting only `completed` loses the race
  // here the way it does in a browser.
  class FakeImageDecoder {
    constructor({ type }) {
      s.decodeCalls.push(type)
      this.completed = Promise.resolve()
      this.tracks = {
        selectedTrack: null,
        ready: new Promise((res) =>
          setTimeout(() => {
            this.tracks.selectedTrack = { animated: s.animated, frameCount: s.frameCount }
            res()
          }, 0),
        ),
      }
    }
    async decode() {
      return { image: { displayWidth: 32, displayHeight: 32, duration: 50_000, close() {} } }
    }
    close() {}
  }
  FakeImageDecoder.prototype.constructor = FakeImageDecoder
  const fakeFetch = async (url) => {
    s.fetchCalls.push(url)
    return {
      ok: true,
      headers: { get: (h) => (h === 'content-type' ? s.contentType : null) },
      arrayBuffer: async () => new ArrayBuffer(8),
    }
  }
  class FakeCanvas {
    getContext() {
      return { drawImage() {} }
    }
    convertToBlob() {
      return Promise.resolve(new Blob(['x'], { type: 'image/webp' }))
    }
  }
  // Deterministic blob urls, so an assertion can name one. Passed in as `URL`, never patched onto the
  // real global, which every other test file in this process shares.
  let n = 0
  const URLish = { createObjectURL: () => `blob:strip-${++n}`, revokeObjectURL() {} }
  // A strip is only shown once a detached Image proves it can paint (so a row never flashes).
  class FakeImage {
    set src(v) {
      this._src = v
    }
    get src() {
      return this._src
    }
    decode() {
      return Promise.resolve()
    }
  }

  Object.defineProperty(doc, 'timeline', { get: () => ({ currentTime: s.frame }), configurable: true })
  Object.defineProperty(doc, 'hidden', { get: () => s.hidden, configurable: true })

  const texture = new Function(
    'document',
    'ImageDecoder',
    'createImageBitmap',
    'fetch',
    'OffscreenCanvas',
    'Image',
    'requestIdleCallback',
    'caches',
    'URL',
    'logger',
    `${scopeSiteModule(TEXTURE, 'hsSpriteTexture', { logger: 'logger' })}\nreturn hsSpriteTexture`,
  )(
    doc,
    FakeImageDecoder,
    () => Promise.resolve({}),
    fakeFetch,
    FakeCanvas,
    FakeImage,
    (fn) => setTimeout(fn, 0),
    undefined, // Cache Storage: absent, so every case runs a real build, not a stored one
    URLish,
    { warn: (...a) => s.warned.push(a), debug() {} },
  )

  s.anchored = []
  const sliceStart = EMOTES.indexOf(GATE_START)
  const sliceEnd = EMOTES.indexOf(GATE_END)
  if (sliceStart < 0 || sliceEnd < sliceStart) throw new Error('emotes.js idle gate moved — update emote-sprite-rig.js')
  const gate = new Function(
    'document',
    'IntersectionObserver',
    'requestAnimationFrame',
    'hsSpriteTexture',
    'cleanup',
    'anchorWhenStarted',
    `${EMOTES.slice(sliceStart, sliceEnd)}\n${SPRITE}
    return {
      hsSwapRowEmotesForIdle, teardownHsEmoteIdleGate, hsSpriteDropAll,
      setMode: (m) => { emoteAnimationMode = m },
    }`,
  )(
    doc,
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    (fn) => setTimeout(fn, 0),
    texture,
    { addEventListener: (t, e, f) => t.addEventListener(e, f) },
    (els) => s.anchored.push(...els),
  )

  /** One emote row, shaped the way the renderer builds it (emotes.js: wrapper span + img). */
  function emote(url = ANIM, { wrapCls = '', wrapAttrs = {}, imgCls = '', animated = true } = {}) {
    const row = doc.createElement('div')
    row.className = 'hs-mc-msg'
    const wrap = doc.createElement('span')
    wrap.className = `hs-mc-emote-wrapper hs-state-channel ${wrapCls}`.trim()
    wrap.dataset.emoteUrl = url
    wrap.dataset.state = 'channel'
    if (animated) wrap.dataset.animated = '1'
    for (const [k, v] of Object.entries(wrapAttrs)) wrap.setAttribute(k, v)
    const img = doc.createElement('img')
    img.className = `hs-mc-emote hs-emote-channel ${imgCls}`.trim()
    img.setAttribute('src', url)
    wrap.appendChild(img)
    row.appendChild(wrap)
    doc.body.appendChild(row)
    return { row, wrap, img }
  }

  const flush = async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0))
  }

  return {
    s,
    win,
    doc,
    texture,
    gate,
    swap: gate.hsSwapRowEmotesForIdle,
    emote,
    flush,
    visibility(hidden) {
      s.hidden = hidden
      doc.dispatchEvent(new win.Event('visibilitychange'))
    },
    spriteOf: (wrap) => wrap.querySelector(':scope > .hs-sprite'),
    delayOf: (wrap) => wrap.querySelector('.hs-sprite > i').style.getPropertyValue('--hs-sp-delay'),
    reset() {
      texture._resetForTests()
      doc.body.innerHTML = ''
    },
  }
}
