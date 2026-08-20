import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The overlay's core semantics for assistive tech.
 *
 * Live chat is the extension's main surface and it carried no role at all — a
 * screen reader saw an unlabelled div of divs. There were 16 `aria-` attributes
 * in the whole of src/, and 7 of the 8 `tabIndex` uses were -1, i.e. removing
 * things from the tab order.
 *
 * Two things are pinned here, both cheap and both easy to lose in a refactor:
 * the message list announces itself as a log, and the tab strip is a real
 * tablist whose selected state is exposed. A screen reader reads aria-selected,
 * never a css class, so the class and the attribute have to move together —
 * which is why every call site goes through setTabActive.
 */

const MAIN = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'main.js'), 'utf8')

describe('overlay aria', () => {
  test('the message list is a labelled log', () => {
    expect(MAIN).toMatch(/id="hs-mc-messages"[^>]*role="log"/)
    expect(MAIN).toMatch(/id="hs-mc-messages"[^>]*aria-label=/)
  })

  test('the chat tab strip is a labelled tablist', () => {
    expect(MAIN).toMatch(/class="hs-mc-tabs-scroll"[^>]*role="tablist"/)
    expect(MAIN).toMatch(/class="hs-mc-tabs-scroll"[^>]*aria-label=/)
  })

  test('every static chat tab is a tab with a selected state', () => {
    for (const tab of ['feed', 'whispers', 'mentions', 'pinned', 'modlog', 'live']) {
      const row = MAIN.match(new RegExp(`<button[^>]*data-tab="${tab}"[^>]*>`))
      expect(row, `no button for data-tab="${tab}"`).toBeTruthy()
      expect(row[0]).toContain('role="tab"')
      expect(row[0]).toContain('aria-selected=')
    }
  })

  test('the utility buttons do NOT claim to be tabs', () => {
    // settings/collapse/popout/subscribe share the .hs-mc-tab class for styling
    // but they switch nothing — role="tab" on them would lie about the tablist.
    for (const util of ['settings', 'collapse', 'popout', 'subscribe']) {
      const row = MAIN.match(new RegExp(`<button[^>]*data-tab="${util}"[^>]*>`))
      expect(row, `no button for data-tab="${util}"`).toBeTruthy()
      expect(row[0]).not.toContain('role="tab"')
    }
  })

  test('active state is only ever set through the one helper', () => {
    // The three hand-rolled `classList.toggle('active', …)` sites are exactly
    // how the class and aria-selected drift apart.
    expect(MAIN).toContain('function setTabActive(')
    const strays = [...MAIN.matchAll(/\.classList\.toggle\('active',\s*[a-z]?t?\.dataset\.tab/g)]
    expect(strays).toHaveLength(0)
  })

  test('setTabActive keeps aria-selected in lockstep with the class', () => {
    const at = MAIN.indexOf('function setTabActive(')
    const body = MAIN.slice(at, at + 400)
    expect(body).toContain("classList.toggle('active'")
    expect(body).toContain('aria-selected')
    // Guarded on role so a utility button sharing the class never gets it.
    expect(body).toContain("getAttribute('role')")
  })
})
