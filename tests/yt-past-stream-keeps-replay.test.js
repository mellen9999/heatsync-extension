// A past youtube stream has a chat replay, collapsed behind youtube's "show chat replay" button.
// Our panel stays down there (hs-offline), but its container sits on every youtube page: the
// native-chat hide keyed on the container alone, plus an inline hide at mount that nothing gave
// back, took the replay and its button away on every past stream (seen on two nasa streams,
// 11-17). The real-site check is s2-youtube; this pins the three places.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (...p) => readFileSync(join(import.meta.dir, '..', 'src', 'multichat', ...p), 'utf8')
const css = read('styles', '17-platform-position.css')
const tabs = read('main-tabs.js')
const storage = read('main-storage.js')

describe('youtube keeps its own chat where our panel is down', () => {
  test('every native-chat hide rule stands down on hs-offline', () => {
    const rules = css.match(/^.*:has\(#hs-mc-container\) (ytd-live-chat-frame|ytd-watch-flexy #chat-container).*$/gm)
    expect(rules.length).toBe(3)
    for (const r of rules) expect(r).toContain('body:not(.hs-offline)')
  })

  test('the mount does not hide the frame on a page the panel is down on', () => {
    const fn = tabs.slice(tabs.indexOf('const hideYtFrame = () => {'), tabs.indexOf('if (!hideYtFrame())'))
    const gate = fn.indexOf("if (document.body.classList.contains('hs-offline')) return true")
    expect(gate).toBeGreaterThan(0)
    expect(gate).toBeLessThan(fn.indexOf("f.style.display = 'none'"))
  })

  test('a frame hidden by the mount comes back when the panel goes down', () => {
    // the restore runs for real, carved out of checkYtLive
    const s = storage.indexOf('      // data-hs-hidden: a frame the panel')
    const body = storage.slice(s, storage.indexOf('\n      }\n', s) + 9)
    const run = (frameEl, showYtChat, hid = false) =>
      new Function('frameEl', 'showYtChat', '_hsHidNativeYt', `${body}; return _hsHidNativeYt`)(
        frameEl,
        showYtChat,
        hid,
      )
    const frame = (display, ds) => {
      const style = { display, removeProperty: () => (style.display = '') }
      return { style, dataset: { ...ds } }
    }

    const mounted = frame('none', { hsHidden: '1', hsPrevDisplay: '' })
    run(mounted, false)
    expect(mounted.style.display).toBe('')
    expect(mounted.dataset).toEqual({})

    const shown = frame('none', { hsHidden: '1', hsPrevDisplay: '' })
    run(shown, true) // our panel is up: the frame stays hidden
    expect(shown.style.display).toBe('none')

    const notOurs = frame('none', {})
    run(notOurs, false) // youtube's own hide: not ours to undo
    expect(notOurs.style.display).toBe('none')

    const byTick = frame('none', {})
    expect(run(byTick, false, true)).toBe(false) // hidden by checkYtLive itself, as before
    expect(byTick.style.display).toBe('')
  })
})
