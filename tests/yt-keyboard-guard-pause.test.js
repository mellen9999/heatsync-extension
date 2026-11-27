/**
 * youtube-keyboard-guard.js (page world, document_start): while the multichat input has focus, a
 * <video>'s pause() does nothing, so youtube's own state machine cannot stop the video under a
 * reader who is typing. It used to find each <video> with a document-wide MutationObserver that ran
 * querySelectorAll('video') on EVERY change youtube made to the page (the player redraws its clock
 * all day). The patch now sits on the prototype, so every video has it, whenever it is made.
 *
 * The REAL file runs in happy-dom.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { Window } from 'happy-dom'

const SRC = readFileSync(new URL('../src/content/youtube-keyboard-guard.js', import.meta.url), 'utf8')

let win
afterEach(() => win?.close?.())

/** the page, with a pause() that only counts, then the guard loaded over it */
let n = 0
const video = (document) => {
  const v = document.createElement('video')
  v.id = `v${++n}`
  return v
}

function load() {
  win = new Window({ url: 'https://www.youtube.com/watch?v=abc' })
  const document = win.document
  const pauses = []
  win.HTMLMediaElement.prototype.pause = function () {
    pauses.push(this.id)
  }
  const watched = []
  class SpyObserver extends win.MutationObserver {
    observe(target, opts) {
      watched.push({ target, opts })
      return super.observe(target, opts)
    }
  }
  // the class the document really inherits addEventListener from (happy-dom hands out a copy as win.EventTarget)
  const EventTargetOfNode = Object.getPrototypeOf(win.Node.prototype).constructor
  new Function('window', 'document', 'EventTarget', 'HTMLMediaElement', 'HTMLVideoElement', 'MutationObserver', SRC)(
    win,
    document,
    EventTargetOfNode,
    win.HTMLMediaElement,
    win.HTMLVideoElement,
    SpyObserver,
  )
  const input = document.createElement('input')
  input.id = 'hs-mc-input'
  document.body.appendChild(input)
  return { document, pauses, watched, input }
}
const tick = () => new Promise((r) => setTimeout(r, 5))

describe('pause() while we are typing', () => {
  test('is a no-op on a video that was there from the start', () => {
    const { document, pauses, input } = load()
    const v = video(document)
    document.body.appendChild(v)
    input.focus()
    v.pause()
    expect(pauses).toEqual([])
  })

  test('is a no-op on a video youtube makes later, with no watching needed', async () => {
    const { document, pauses, input } = load()
    input.focus()
    await tick()
    const v = video(document)
    v.pause() // not even attached to the page yet: the same prototype
    document.querySelector('body').appendChild(v)
    v.pause()
    expect(pauses).toEqual([])
  })

  test('still pauses when the focus is anywhere else, so a click on the player works', () => {
    const { document, pauses, input } = load()
    const v = video(document)
    document.body.appendChild(v)
    const other = document.createElement('button')
    document.body.appendChild(other)
    other.focus()
    v.pause()
    expect(pauses).toEqual([v.id])
    input.focus()
    v.pause()
    expect(pauses).toEqual([v.id])
    other.focus()
    v.pause()
    expect(pauses).toEqual([v.id, v.id])
  })

  test('only a <video> is guarded, not other media', () => {
    const { document, pauses, input } = load()
    const a = document.createElement('audio')
    a.id = 'a1'
    document.body.appendChild(a)
    input.focus()
    a.pause()
    expect(pauses).toEqual([a.id])
  })

  test('a descendant of the input counts as the input', () => {
    const { document, pauses } = load()
    const wrap = document.createElement('div')
    wrap.id = 'hs-mc-input'
    wrap.tabIndex = 0
    const inner = document.createElement('span')
    inner.tabIndex = 0
    wrap.appendChild(inner)
    document.body.appendChild(wrap)
    const v = video(document)
    document.body.appendChild(v)
    inner.focus()
    v.pause()
    expect(pauses).toEqual([])
  })

  test('the patch looks like the native one: a method, not an enumerable own property of the element', () => {
    const { document } = load()
    const v = video(document)
    expect(Object.keys(v)).not.toContain('pause')
    expect(Object.getOwnPropertyDescriptor(v, 'pause')).toBeUndefined()
    expect(typeof v.pause).toBe('function')
  })
})

describe('the page is not watched for videos', () => {
  test('no observer at all: the video is reached through the prototype', async () => {
    const { document, watched } = load()
    document.body.appendChild(video(document))
    await tick()
    expect(watched).toEqual([])
  })
})

describe('the key-event wrap it also does is untouched', () => {
  test('a page key handler is skipped for events inside the input, and runs for the rest', () => {
    const { document, input } = load()
    const seen = []
    document.addEventListener('keydown', (e) => seen.push(e.target.id || e.target.tagName), true)
    input.dispatchEvent(new win.KeyboardEvent('keydown', { bubbles: true }))
    document.body.dispatchEvent(new win.KeyboardEvent('keydown', { bubbles: true }))
    expect(seen).toEqual(['BODY'])
  })
})
