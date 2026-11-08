/**
 * The composer's spellcheck switch and its autocomplete ARIA (composer-attrs.js).
 *
 * SPELLCHECK. Off by default (the composer always was), one registry setting
 * for both composer shapes, and flipping it reaches the LIVE node: no reload, no
 * rebuild, the same element.
 *
 * ARIA. The ":" "@" "/" lists are the WAI-ARIA editable combobox with a list
 * popup. These run the real helpers against a small stand-in DOM and pin the
 * contract a screen reader reads: the composer names the open list
 * (aria-controls / aria-expanded), the highlighted row (aria-activedescendant,
 * an id that exists in that list), and each row says whether it is selected.
 * Tab-complete draws no list, so its candidate rides a polite live region.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SETTINGS } from '../src/lib/settings-schema.js'

const ROOT = join(import.meta.dir, '..')
const EN = JSON.parse(readFileSync(join(ROOT, 'src', '_locales', 'en', 'messages.json'), 'utf8'))
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

let settings
let nodes

/** Just enough element for the helpers: attributes, classes, children, scroll geometry. */
function el(id = '') {
  const attrs = new Map()
  const classes = new Set()
  const node = {
    id,
    children: [],
    style: {},
    scrollTop: 0,
    clientHeight: 0,
    offsetTop: 0,
    offsetHeight: 0,
    spellcheck: false,
    classList: {
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
      contains: (c) => classes.has(c),
    },
    setAttribute: (k, v) => attrs.set(k, String(v)),
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    hasAttribute: (k) => attrs.has(k),
    removeAttribute: (k) => attrs.delete(k),
  }
  if (id) nodes.set(id, node)
  return node
}

function list(id, n) {
  const dd = el(id)
  dd.style.display = 'block'
  for (let i = 0; i < n; i++) dd.children.push(el())
  return dd
}

beforeEach(() => {
  settings = {}
  nodes = new Map()
  globalThis.document = { getElementById: (id) => nodes.get(id) || null }
  globalThis.getSetting = (k) => settings[k]
  globalThis.t = (key) => {
    if (!EN[key]) throw new Error(`t('${key}') — no such message in en/messages.json`)
    return EN[key].message
  }
})

const attrs = await import(`../src/multichat/composer-attrs.js?t=${Date.now()}`)
const { hsApplySpellcheck, hsComposerCombobox, hsListboxHide, hsListboxReuse, hsListboxSelect, hsListboxSync } = attrs
const { hsSpellcheckOn } = attrs

describe('spellcheck setting', () => {
  test('is a registry setting, off by default, applied live', () => {
    const def = SETTINGS.find((d) => d.key === 'hs_spellcheck')
    expect(def).toBeTruthy()
    expect(def.type).toBe('bool')
    expect(def.default).toBe(false)
    expect(def.scope).toBe('local')
    expect(def.apply).toBe('spellcheck')
    expect(def.applyOnLoad).toBe(true)
    expect(read('src/multichat/main.js')).toMatch(/spellcheck: \(v\) => hsApplySpellcheck\(v\)/)
  })

  test('only an explicit true turns it on', () => {
    expect(hsSpellcheckOn()).toBe(false)
    settings.hs_spellcheck = 'yes'
    expect(hsSpellcheckOn()).toBe(false)
    settings.hs_spellcheck = true
    expect(hsSpellcheckOn()).toBe(true)
  })

  test('flipping it reaches the live composer, the same element, no rebuild', () => {
    const input = el('hs-mc-input')
    hsApplySpellcheck(true)
    expect(input.spellcheck).toBe(true)
    expect(nodes.get('hs-mc-input')).toBe(input)
    hsApplySpellcheck(false)
    expect(input.spellcheck).toBe(false)
  })

  test('no composer yet is not an error', () => {
    expect(() => hsApplySpellcheck(true)).not.toThrow()
  })

  test('both composer shapes read the setting at creation, none hardcodes it', () => {
    const src = read('src/multichat/input.js')
    expect(src).not.toMatch(/spellcheck\s*=\s*false/)
    expect(src).not.toMatch(/spellcheck="false"/)
    expect((src.match(/hsSpellcheckOn\(\)/g) || []).length).toBeGreaterThanOrEqual(4)
  })
})

describe('composer combobox', () => {
  test('the composer is a list-autocomplete combobox, collapsed until a list opens', () => {
    const input = el('hs-mc-input')
    hsComposerCombobox(input)
    expect(input.getAttribute('role')).toBe('combobox')
    expect(input.getAttribute('aria-autocomplete')).toBe('list')
    expect(input.getAttribute('aria-haspopup')).toBe('listbox')
    expect(input.getAttribute('aria-expanded')).toBe('false')
    expect(input.getAttribute('aria-label')).toBe(EN.mc_input_send_message.message)
  })

  test('re-running it on a rebuilt composer does not collapse an open list', () => {
    const input = el('hs-mc-input')
    hsComposerCombobox(input)
    input.setAttribute('aria-expanded', 'true')
    hsComposerCombobox(input)
    expect(input.getAttribute('aria-expanded')).toBe('true')
  })

  test('opening a list: listbox, options with ids, the composer points at both', () => {
    const input = el('hs-mc-input')
    hsComposerCombobox(input)
    const dd = list('hs-mc-emoji-dropdown', 3)
    hsListboxSync(dd, ['a', 'b', 'c'], 1)

    expect(dd.getAttribute('role')).toBe('listbox')
    expect(dd.getAttribute('aria-label')).toBe(EN.mc_a11y_ac_emotes.message)
    expect(dd.children.map((r) => r.getAttribute('role'))).toEqual(['option', 'option', 'option'])
    expect(dd.children.map((r) => r.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false'])
    expect(new Set(dd.children.map((r) => r.id)).size).toBe(3)

    expect(input.getAttribute('aria-expanded')).toBe('true')
    expect(input.getAttribute('aria-controls')).toBe('hs-mc-emoji-dropdown')
    expect(input.getAttribute('aria-activedescendant')).toBe(dd.children[1].id)
    expect(dd.children[1].classList.contains('selected')).toBe(true)
  })

  test('each list carries its own name', () => {
    el('hs-mc-input')
    const names = list('hs-mc-mention-dropdown', 1)
    const cmds = list('hs-mc-slash-dropdown', 1)
    hsListboxSync(names, ['x'], 0)
    hsListboxSync(cmds, ['y'], 0)
    expect(names.getAttribute('aria-label')).toBe(EN.mc_a11y_ac_names.message)
    expect(cmds.getAttribute('aria-label')).toBe(EN.mc_a11y_ac_commands.message)
  })

  test('arrowing moves aria-selected and the activedescendant, ids unchanged', () => {
    const input = el('hs-mc-input')
    const dd = list('hs-mc-emoji-dropdown', 3)
    hsListboxSync(dd, ['a', 'b', 'c'], 0)
    const ids = dd.children.map((r) => r.id)
    hsListboxSelect(dd, 2)
    expect(dd.children.map((r) => r.getAttribute('aria-selected'))).toEqual(['false', 'false', 'true'])
    expect(input.getAttribute('aria-activedescendant')).toBe(ids[2])
    expect(dd.children.map((r) => r.id)).toEqual(ids)
  })

  test('ids depend on position alone, so a rebuild hands back the same ones', () => {
    el('hs-mc-input')
    const dd = list('hs-mc-emoji-dropdown', 2)
    hsListboxSync(dd, ['a', 'b'], 0)
    const first = dd.children.map((r) => r.id)
    dd.children = [el(), el()]
    hsListboxSync(dd, ['c', 'd'], 0)
    expect(dd.children.map((r) => r.id)).toEqual(first)
  })

  test('an arrow press with the same matches moves the highlight without a rebuild', () => {
    const input = el('hs-mc-input')
    const dd = list('hs-mc-emoji-dropdown', 3)
    const matches = ['a', 'b', 'c']
    hsListboxSync(dd, matches, 0)
    const rows = [...dd.children]
    expect(hsListboxReuse(dd, matches, 2)).toBe(true)
    expect(dd.children).toEqual(rows)
    expect(input.getAttribute('aria-activedescendant')).toBe(rows[2].id)
  })

  test('a different match set, or a hidden list, is rebuilt not reused', () => {
    el('hs-mc-input')
    const dd = list('hs-mc-emoji-dropdown', 2)
    const matches = ['a', 'b']
    hsListboxSync(dd, matches, 0)
    expect(hsListboxReuse(dd, ['a', 'b'], 0)).toBe(false)
    dd.style.display = 'none'
    expect(hsListboxReuse(dd, matches, 1)).toBe(false)
    dd.style.display = 'block'
    dd.children.pop()
    expect(hsListboxReuse(dd, matches, 1)).toBe(false)
  })

  test('closing the list collapses the composer', () => {
    const input = el('hs-mc-input')
    hsComposerCombobox(input)
    const dd = list('hs-mc-emoji-dropdown', 2)
    hsListboxSync(dd, ['a', 'b'], 0)
    hsListboxHide(dd)
    expect(dd.style.display).toBe('none')
    expect(input.getAttribute('aria-expanded')).toBe('false')
    expect(input.hasAttribute('aria-controls')).toBe(false)
    expect(input.hasAttribute('aria-activedescendant')).toBe(false)
  })

  test("closing a list that is not the composer's current one leaves the composer alone", () => {
    const input = el('hs-mc-input')
    hsComposerCombobox(input)
    const emoji = list('hs-mc-emoji-dropdown', 1)
    const mention = list('hs-mc-mention-dropdown', 1)
    hsListboxSync(emoji, ['a'], 0)
    hsListboxSync(mention, ['b'], 0)
    hsListboxHide(emoji)
    expect(input.getAttribute('aria-expanded')).toBe('true')
    expect(input.getAttribute('aria-controls')).toBe('hs-mc-mention-dropdown')
  })
})

describe('wiring in input.js', () => {
  const src = read('src/multichat/input.js')

  test('all three lists sync on build, reuse on arrow, and release on hide', () => {
    expect((src.match(/hsListboxSync\(/g) || []).length).toBe(3)
    expect((src.match(/hsListboxReuse\(/g) || []).length).toBe(3)
    expect((src.match(/hsListboxHide\(/g) || []).length).toBe(3)
  })

  test('the composer is made a combobox on init, and the tab-cycle tooltip is a live region', () => {
    expect(src).toMatch(/hsComposerCombobox\(input\)/)
    expect(src).toMatch(/tt\.setAttribute\('role', 'status'\)/)
  })
})
