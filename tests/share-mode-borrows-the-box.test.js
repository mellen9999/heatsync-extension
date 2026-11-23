/**
 * A share mode (resub, watch streak) borrows the composer: its class on the bar and the box, its
 * prompt over the box's own placeholder. The two modes each carried their own copy of that code;
 * it is one pair of helpers now (_shareBoxEnter / _shareBoxLeave), carved from the real source.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'share-callouts.js'), 'utf8')
function fn(name) {
  const start = SRC.indexOf(`function ${name}(`)
  if (start === -1) throw new Error(`"${name}" not found`)
  return SRC.slice(start, SRC.indexOf('\n}', start) + 2)
}
const win = new Window()
const doc = win.document
const { enter, leave } = new Function(
  'document',
  `${fn('_shareBoxEnter')}\n${fn('_shareBoxLeave')}\nreturn { enter: _shareBoxEnter, leave: _shareBoxLeave }`,
)(doc)

function stage(attrs = 'placeholder="say something" data-placeholder="say something"') {
  doc.body.innerHTML = `<div id="hs-mc-inputbar"><div id="hs-mc-input" ${attrs}></div></div>`
  return { box: doc.getElementById('hs-mc-input'), bar: doc.getElementById('hs-mc-inputbar') }
}

describe('a share mode borrows the composer', () => {
  test('its class goes on the bar and the box, its prompt over the placeholder; leaving gives both back', () => {
    const { box, bar } = stage()
    expect(enter('hs-mc-resub-share', 'share your 3 months')).toBe(box)
    expect(bar.classList.contains('hs-mc-resub-share') && box.classList.contains('hs-mc-resub-share')).toBe(true)
    expect([box.getAttribute('placeholder'), box.getAttribute('data-placeholder')]).toEqual(
      Array(2).fill('share your 3 months'),
    )
    leave('hs-mc-resub-share')
    expect(bar.classList.contains('hs-mc-resub-share') || box.classList.contains('hs-mc-resub-share')).toBe(false)
    expect([box.getAttribute('placeholder'), box.getAttribute('data-placeholder')]).toEqual(
      Array(2).fill('say something'),
    )
    expect(box.dataset.hsOrigPlaceholder).toBeUndefined()
    expect(box.dataset.hsOrigDataPlaceholder).toBeUndefined()
  })

  test("a second mode taking over never saves the first one's prompt as the box's own", () => {
    const { box } = stage()
    enter('hs-mc-resub-share', 'share your 3 months')
    enter('hs-mc-watchstreak-share', 'share your streak')
    expect(box.getAttribute('placeholder')).toBe('share your streak')
    leave('hs-mc-watchstreak-share')
    expect(box.getAttribute('placeholder')).toBe('say something')
  })

  test('a box that had no data-placeholder ends with none', () => {
    const { box } = stage('placeholder="say something"')
    enter('hs-mc-resub-share', 'share')
    expect(box.getAttribute('data-placeholder')).toBe('share')
    leave('hs-mc-resub-share')
    expect(box.hasAttribute('data-placeholder')).toBe(false)
  })

  test('no composer on the page: nothing to borrow, and leaving is a no-op', () => {
    doc.body.innerHTML = ''
    expect(enter('hs-mc-resub-share', 'share')).toBeNull()
    expect(() => leave('hs-mc-resub-share')).not.toThrow()
  })

  test('both modes go through the one pair', () => {
    expect(SRC).toContain("if (!_shareBoxEnter('hs-mc-resub-share', placeholder)) return")
    expect(SRC).toContain("_shareBoxLeave('hs-mc-resub-share')")
    expect(SRC).toMatch(/if \(!_shareBoxEnter\('hs-mc-watchstreak-share', t\('mc_misc_streak_placeholder'/)
    expect(SRC).toContain("_shareBoxLeave('hs-mc-watchstreak-share')")
    expect(SRC.match(/hsOrigPlaceholder = /g).length).toBe(1)
  })
})
