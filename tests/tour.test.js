import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SETTINGS } from '../src/lib/settings-schema.js'
import { mainSource } from './main-src.js'

/**
 * First-run tour card (tour.js): six cards, one idea each (the row menu, commands, search, tabs,
 * settings, then four switches). The switches are a thin skin over the real settings: every one
 * writes the registry key the settings panel writes. tour.js runs for real against a happy-dom
 * document with the registry, storage and mod caches faked; wiring checks read the sources.
 */
const ROOT = join(import.meta.dir, '..')
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8')
const SRC = read('src', 'multichat', 'tour.js')
const MAIN = mainSource()
const SETTINGS_UI = read('src', 'multichat', 'settings-ui.js')
const BUILD = read('build.js')
const EN = JSON.parse(read('src', '_locales', 'en', 'messages.json'))
const MOD_TOOLBAR = read('src', 'multichat', 'mod-toolbar.js')
const CATALOG = MOD_TOOLBAR.slice(MOD_TOOLBAR.indexOf('const MOD_BUTTON_CATALOG = {'), MOD_TOOLBAR.indexOf('\n}\n'))
const CATALOG_IDS = [...CATALOG.matchAll(/^ {2}([a-z_0-9]+): \{/gm)].map((m) => m[1])

import { Window } from 'happy-dom'

const def = (key) => SETTINGS.find((s) => s.key === key)
const STEPS = JSON.parse(/const TOUR_STEPS = (\[[^\]]*\])/.exec(SRC)[1].replace(/'/g, '"'))

describe('tour: the switches are the real settings', () => {
  const ROWS = ['timestamps', 'hoverReply', 'viMode', 'hs_mod_toolbar_buttons']

  test('every row key is a registry key, and the tour source names exactly these', () => {
    for (const key of ROWS) expect(def(key), key).toBeDefined()
    const named = [...SRC.matchAll(/key: ('[A-Za-z_]+'|TOUR_MOD_KEY)/g)].map((m) => m[1])
    expect(named.length).toBe(ROWS.length)
    expect(SRC).toContain("const TOUR_MOD_KEY = 'hs_mod_toolbar_buttons'")
    for (const key of ROWS.slice(0, 3)) expect(named).toContain(`'${key}'`)
  })

  test('nothing the tour offers had its default changed: all four ship off', () => {
    expect(def('timestamps').default).toBe(false)
    expect(def('hoverReply').default).toBe(false)
    expect(def('viMode').default).toBe(false)
    expect(def('hs_mod_toolbar_buttons').default).toEqual([])
  })

  test("each row wears the settings' own label, so the two places read the same", () => {
    for (const key of ROWS) {
      const label = def(key).labelKey
      expect(SRC).toContain(
        `key: ${key === 'hs_mod_toolbar_buttons' ? 'TOUR_MOD_KEY' : `'${key}'`}, labelKey: '${label}'`,
      )
      expect(EN[label], label).toBeDefined()
    }
  })

  test('the mod starter set is real buttons, from the catalog and the settings options', () => {
    const starter = JSON.parse(/const TOUR_MOD_STARTER = (\[[^\]]*\])/.exec(SRC)[1].replace(/'/g, '"'))
    expect(starter.length).toBeGreaterThan(0)
    const options = def('hs_mod_toolbar_buttons').options.map((o) => o.value)
    for (const id of starter) {
      expect(CATALOG_IDS, id).toContain(id)
      expect(options, id).toContain(id)
    }
  })

  test('every string the card and its settings row use exists in en', () => {
    const keys = new Set([...SRC.matchAll(/\b(mc_[a-z_0-9]+)\b/g)].map((m) => m[1]).filter((k) => !k.endsWith('_')))
    keys.add('mc_set_tour')
    keys.add('mc_set_tour_tip')
    keys.add('mc_set_tour_btn')
    for (const id of STEPS) {
      keys.add(`mc_tour_${id}_t`)
      if (id !== STEPS.at(-1)) keys.add(`mc_tour_${id}_d`)
    }
    for (const k of keys) expect(EN[k], k).toBeDefined()
  })

  test('the cards teach what the audit said a new viewer cannot find', () => {
    expect(STEPS).toEqual(['menu', 'cmd', 'find', 'tabs', 'settings', 'switches'])
    const body = (id) => EN[`mc_tour_${id}_d`].message
    expect(body('menu')).toMatch(/right-click|menu/)
    expect(`${EN.mc_tour_menu_t.message} ${body('menu')}`).toContain('right-click')
    expect(`${EN.mc_tour_cmd_t.message} ${body('cmd')}`).toContain('/help')
    expect(body('find') + EN.mc_tour_find_t.message).toMatch(/search|find/)
    expect(body('tabs')).toContain('alt+1')
    expect(body('tabs')).toContain('alt+9')
    expect(body('tabs')).toContain('+')
    expect(body('settings')).toContain('⚙')
  })

  test('each teaching card is one or two short lines', () => {
    for (const id of STEPS.slice(0, -1)) {
      expect(EN[`mc_tour_${id}_t`].message.length, `${id} title`).toBeLessThanOrEqual(30)
      expect(EN[`mc_tour_${id}_d`].message.length, `${id} line`).toBeLessThanOrEqual(90)
    }
  })
})

describe('tour: wiring', () => {
  test('tour.js is in the build list, after the pin bar', () => {
    const list = BUILD.slice(BUILD.indexOf('const MULTICHAT_MODULES = ['))
    expect(list.indexOf("'tour.js'")).toBeGreaterThan(list.indexOf("'pin-bar.js'"))
    expect(list.indexOf("'tour.js'")).toBeLessThan(list.indexOf("'settings-ui.js'"))
  })

  test('main.js starts it once at init and re-syncs it on every render', () => {
    expect(MAIN).toContain("if (typeof initTour === 'function') initTour()")
    expect(MAIN).toContain("if (typeof tourSync === 'function') tourSync(id)")
  })

  test('settings › ? carries the "show the tour again" button, and search finds it', () => {
    expect(SETTINGS_UI).toContain('data-action="show-tour"')
    expect(SETTINGS_UI).toContain("action === 'show-tour'")
    expect(SETTINGS_UI).toContain('tourReopen()')
    expect(SETTINGS_UI).toContain('_setHelpActionRows()')
    expect(SETTINGS_UI).toMatch(/hay: '[^']*\btour\b/)
  })

  test('nothing in the card takes focus on its own or listens at the document', () => {
    expect(SRC).not.toMatch(/document\.addEventListener|window\.addEventListener/)
    // .focus() appears exactly three times: back to the composer when the card closes, on an explicit
    // reopen, and when the control the viewer was on hides itself (back on card 1, next on the last)
    expect([...SRC.matchAll(/\.focus\(\)/g)].length).toBe(3)
    // no printable key is bound: the composer owns those
    expect(SRC).not.toMatch(/e\.key === '[a-zA-Z0-9]'/)
  })
})

describe('tour: behavior', () => {
  let win
  let doc
  let store // the fake chrome.storage.local
  let onChanged // listeners
  let values // the fake settings registry
  let sets // every setSetting call, in order
  let toasts
  let tab
  let modTwitch
  let modKick
  let rooms
  let modAsks
  let api

  const fire = (area, changes) => {
    for (const fn of onChanged) fn(changes, area)
  }
  const flush = () => new Promise((r) => setTimeout(r, 5))

  // a fresh module instance, like a fresh page load, over the shared storage
  async function boot({ seen, step, getFails, setFails } = {}) {
    if (seen !== undefined) store.hs_tour_seen = seen
    if (step !== undefined) store.hs_tour_step = step
    const make = new Function(
      'document',
      't',
      'getSetting',
      'setSetting',
      'MC_WIRE_CTX',
      'scheduleScrollPin',
      'showToast',
      'browser',
      'chrome',
      'cleanup',
      'pinRoomsFor',
      'isModForSync',
      'isKickModForSync',
      'isModFor',
      'isKickModFor',
      'switchTab',
      'renderSettingsTab',
      `let currentTab = ${JSON.stringify(tab)}
      let isScrolledUp = false
      ${SRC}
      return {
        initTour, tourSync, tourReopen,
        setTab: (v) => { currentTab = v },
        seenNow: () => tourSeen,
      }`,
    )
    const calls = { tabs: [], settingsRenders: 0, pins: 0 }
    const m = make(
      doc,
      (k) => k,
      (k) => values[k],
      (k, v) => {
        sets.push([k, v])
        values[k] = v
        return true
      },
      'ctx-a',
      () => {
        calls.pins++
      },
      (msg, kind) => toasts.push([msg, kind]),
      {
        storage: {
          local: {
            get: async (k) => {
              if (getFails) throw new Error('storage down')
              const out = {}
              for (const key of [].concat(k)) if (key in store) out[key] = store[key]
              return out
            },
            set: async (o) => {
              if (setFails) throw new Error('quota')
              const changes = {}
              for (const [k, v] of Object.entries(o)) {
                changes[k] = { oldValue: store[k], newValue: v }
                store[k] = v
              }
              fire('local', changes)
            },
            remove: async (k) => {
              const changes = {}
              for (const key of [].concat(k)) {
                changes[key] = { oldValue: store[key] }
                delete store[key]
              }
              fire('local', changes)
            },
          },
        },
      },
      { storage: { onChanged: { addListener: (fn) => onChanged.push(fn) } } },
      { addListener: (target, fn) => target.addListener(fn), setTimeout: (fn, ms) => setTimeout(fn, ms) },
      () => rooms,
      (c) => modTwitch.has(c),
      (c) => modKick.has(c),
      async (c) => {
        modAsks.push(c)
        return modTwitch.has(c)
      },
      async (c) => modKick.has(c),
      (id) => calls.tabs.push(id),
      () => {
        calls.settingsRenders++
      },
    )
    m.calls = calls
    return m
  }

  const card = () => doc.getElementById('hs-mc-tour')
  const rowEl = (key) => card()?.querySelector(`[data-tour-key="${key}"]`)
  const shown = () => !!card() && !card().hidden
  const btn = (name) => card()?.querySelector(`.hs-mc-tour-${name}`)
  const stepNow = () => Number(card()?.dataset.tourShown)
  const LAST = STEPS.length - 1
  // the card the viewer is on, as they read it
  const reading = () => ({
    n: card().querySelector('.hs-mc-tour-n').textContent,
    title: card().querySelector('.hs-mc-tour-t').textContent,
    line: card().querySelector('.hs-mc-tour-d').hidden ? '' : card().querySelector('.hs-mc-tour-d').textContent,
  })
  // start on the switches card (the one the old tour was all about)
  const bootSwitches = async (opts = {}) => {
    const m = await boot({ ...opts, step: LAST })
    m.initTour()
    await flush()
    return m
  }

  beforeEach(() => {
    win = new Window()
    doc = win.document
    doc.body.innerHTML =
      '<div id="hs-mc-overlay"><div id="hs-mc-pinbar" hidden></div><div id="hs-mc-messages"></div></div>' +
      '<div id="hs-mc-inputbar"><div id="hs-mc-input" contenteditable="true" tabindex="0"></div></div>'
    store = {}
    onChanged = []
    values = { timestamps: false, hoverReply: false, viMode: false, hs_mod_toolbar_buttons: [] }
    sets = []
    toasts = []
    tab = 'live'
    modTwitch = new Set()
    modKick = new Set()
    rooms = ['twitch/somechan']
    modAsks = []
    api = null
  })
  afterEach(() => {
    win.close()
  })

  test('first open: the card appears once the flag says unseen, above the pane, never inside it', async () => {
    api = await boot()
    api.initTour()
    expect(card()).toBeNull() // flag not read yet: nothing drawn
    await flush()
    expect(shown()).toBe(true)
    const msgs = doc.getElementById('hs-mc-messages')
    expect(card().nextElementSibling).toBe(msgs)
    expect(msgs.contains(card())).toBe(false)
    expect(doc.getElementById('hs-mc-inputbar').contains(card())).toBe(false)
  })

  test('it never takes focus: the composer keeps it while the card appears', async () => {
    const input = doc.getElementById('hs-mc-input')
    input.focus()
    api = await boot()
    api.initTour()
    await flush()
    expect(shown()).toBe(true)
    expect(doc.activeElement).toBe(input)
  })

  test('an unreadable flag means no card (do not nag when we cannot tell)', async () => {
    api = await boot({ getFails: true })
    api.initTour()
    await flush()
    expect(card()).toBeNull()
    expect(api.seenNow()).toBe(true)
  })

  test('already seen: no card, now or after a render', async () => {
    api = await boot({ seen: true })
    api.initTour()
    await flush()
    api.tourSync('live')
    expect(card()).toBeNull()
  })

  test('four rows: timestamps, reply, vim, and the mod row only for mods', async () => {
    api = await bootSwitches()
    const keys = [...card().querySelectorAll('.hs-mc-tour-row')].map((b) => b.dataset.tourKey)
    expect(keys).toEqual(['timestamps', 'hoverReply', 'viMode', 'hs_mod_toolbar_buttons'])
    expect(rowEl('timestamps').hidden).toBe(false)
    expect(rowEl('hs_mod_toolbar_buttons').hidden).toBe(true)
  })

  test('the switches live on the last card only: every earlier card is plain words', async () => {
    api = await boot()
    api.initTour()
    await flush()
    for (let i = 0; i < LAST; i++) {
      expect(stepNow()).toBe(i)
      for (const b of card().querySelectorAll('.hs-mc-tour-row')) expect(b.hidden, `card ${i + 1}`).toBe(true)
      expect(card().querySelector('.hs-mc-tour-d').hidden).toBe(false)
      btn('next').click()
    }
    expect(stepNow()).toBe(LAST)
    expect(rowEl('timestamps').hidden).toBe(false)
    expect(card().querySelector('.hs-mc-tour-d').hidden).toBe(true)
  })

  test('clicking a switch writes the REAL key, both directions, and repaints', async () => {
    api = await bootSwitches()
    for (const key of ['timestamps', 'hoverReply', 'viMode']) {
      expect(rowEl(key).getAttribute('aria-checked')).toBe('false')
      rowEl(key).click()
      expect(sets.at(-1)).toEqual([key, true])
      expect(rowEl(key).getAttribute('aria-checked')).toBe('true')
      expect(rowEl(key).classList.contains('on')).toBe(true)
      rowEl(key).click()
      expect(sets.at(-1)).toEqual([key, false])
      expect(rowEl(key).getAttribute('aria-checked')).toBe('false')
    }
    expect(sets.length).toBe(6)
  })

  test('a switch flipped in settings (or another tab) shows up on the card', async () => {
    api = await bootSwitches()
    values.timestamps = true
    fire('sync', { ui_settings: { oldValue: {}, newValue: { timestamps: true } } })
    await flush()
    expect(rowEl('timestamps').getAttribute('aria-checked')).toBe('true')
    values.hs_mod_toolbar_buttons = ['ban']
    fire('local', { hs_mod_toolbar_buttons: { newValue: ['ban'] } })
    await flush()
    // the mod row stays hidden for a non-mod, but its state is kept current
    expect(rowEl('hs_mod_toolbar_buttons').getAttribute('aria-checked')).toBe('true')
  })

  test('the settings panel is re-rendered when it is the tab on screen, so its switch flips too', async () => {
    tab = 'settings'
    rooms = []
    api = await bootSwitches()
    rowEl('hoverReply').click()
    expect(api.calls.settingsRenders).toBe(1)
  })

  describe('the cards', () => {
    test('card 1 is the row menu, counted "1/6", with next and skip but no back', async () => {
      api = await boot()
      api.initTour()
      await flush()
      expect(reading()).toEqual({
        n: '1/6',
        title: 'mc_tour_menu_t',
        line: 'mc_tour_menu_d',
      })
      expect(btn('back').hidden).toBe(true)
      expect(btn('next').hidden).toBe(false)
      expect(btn('more').hidden).toBe(true)
      expect(btn('done').textContent).toBe('mc_tour_skip')
    })

    test('next walks every card in order, each with its own words, and the last says "got it"', async () => {
      api = await boot()
      api.initTour()
      await flush()
      const seen = []
      for (let i = 0; i < STEPS.length; i++) {
        seen.push(reading().title)
        expect(reading().n).toBe(`${i + 1}/${STEPS.length}`)
        if (i < LAST) expect(reading().line).toBe(`mc_tour_${STEPS[i]}_d`)
        if (i < LAST) btn('next').click()
      }
      expect(seen).toEqual(STEPS.map((id) => `mc_tour_${id}_t`))
      expect(btn('next').hidden).toBe(true)
      expect(btn('back').hidden).toBe(false)
      expect(btn('more').hidden).toBe(false)
      expect(btn('done').textContent).toBe('mc_tour_done')
    })

    test('back goes back, and cannot go before the first card or past the last', async () => {
      api = await boot()
      api.initTour()
      await flush()
      btn('back').click() // hidden on card 1, but a stray click must be harmless
      expect(stepNow()).toBe(0)
      btn('next').click()
      btn('next').click()
      btn('back').click()
      expect(stepNow()).toBe(1)
    })

    test('progress is remembered: a fresh page load resumes on the card the viewer stopped at', async () => {
      api = await boot()
      api.initTour()
      await flush()
      btn('next').click()
      btn('next').click()
      await flush()
      expect(store.hs_tour_step).toBe(2)
      doc.getElementById('hs-mc-tour')?.remove()
      const again = await boot() // new module instance, same storage
      again.initTour()
      await flush()
      expect(stepNow()).toBe(2)
      expect(reading().n).toBe('3/6')
    })

    test('a saved step that is not a card starts over rather than showing a blank one', async () => {
      for (const bad of [99, -1, 2.5, 'x', null]) {
        doc.getElementById('hs-mc-tour')?.remove()
        store = { hs_tour_step: bad }
        const m = await boot()
        m.initTour()
        await flush()
        expect(stepNow(), String(bad)).toBe(0)
      }
    })

    test('skip on any card is the same as "got it": seen for good, and the step is forgotten', async () => {
      api = await boot()
      api.initTour()
      await flush()
      btn('next').click()
      btn('next').click()
      await flush()
      expect(store.hs_tour_step).toBe(2)
      btn('done').click()
      await flush()
      expect(shown()).toBe(false)
      expect(store.hs_tour_seen).toBe(true)
      expect('hs_tour_step' in store).toBe(false)
      doc.getElementById('hs-mc-tour')?.remove()
      const again = await boot()
      again.initTour()
      await flush()
      expect(card()).toBeNull()
    })

    test('a step that cannot be saved is not worth a toast, and the card still moves', async () => {
      api = await boot({ setFails: true })
      api.initTour()
      await flush()
      btn('next').click()
      await flush()
      expect(stepNow()).toBe(1)
      expect(toasts).toEqual([])
    })

    test('the arrow keys go next / back from inside the card, and nothing else is bound', async () => {
      api = await boot()
      api.initTour()
      await flush()
      const key = (k, extra = {}) => {
        const ev = new win.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra })
        btn('next').dispatchEvent(ev)
        return ev
      }
      expect(key('ArrowRight').defaultPrevented).toBe(true)
      expect(stepNow()).toBe(1)
      key('ArrowRight')
      key('ArrowLeft')
      expect(stepNow()).toBe(1)
      // a modified arrow belongs to the browser
      expect(key('ArrowRight', { altKey: true }).defaultPrevented).toBe(false)
      expect(stepNow()).toBe(1)
      // letters are the composer's: a printable key does nothing here
      expect(key('n').defaultPrevented).toBe(false)
      expect(key('j').defaultPrevented).toBe(false)
      expect(stepNow()).toBe(1)
    })

    test('in a right-to-left layout the arrows mirror: left is next', async () => {
      doc.getElementById('hs-mc-overlay').dir = 'rtl'
      api = await boot()
      api.initTour()
      await flush()
      btn('next').dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }))
      expect(stepNow()).toBe(1)
      btn('next').dispatchEvent(
        new win.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
      )
      expect(stepNow()).toBe(0)
    })

    test('a keyboard viewer is never left on a button that just hid itself', async () => {
      api = await boot({ step: LAST - 1 })
      api.initTour()
      await flush()
      btn('next').focus()
      expect(doc.activeElement).toBe(btn('next'))
      btn('next').click() // next hides on the last card: focus moves to the button that is still there
      expect(stepNow()).toBe(LAST)
      expect(doc.activeElement).toBe(btn('done'))
      // and the other end: back hides on the first card, the viewer lands on next
      api = null
      doc.getElementById('hs-mc-tour')?.remove()
      store = {}
      const m = await boot({ step: 1 })
      m.initTour()
      await flush()
      btn('back').focus()
      btn('back').click()
      expect(stepNow()).toBe(0)
      expect(doc.activeElement).toBe(btn('next'))
    })

    test('focus stays in the composer when the viewer clicks through with the mouse elsewhere', async () => {
      const input = doc.getElementById('hs-mc-input')
      input.focus()
      api = await boot()
      api.initTour()
      await flush()
      btn('next').click() // a click never focuses in happy-dom; the composer must still hold focus
      expect(doc.activeElement).toBe(input)
    })

    test('the mod question is asked only once the switches card is on screen', async () => {
      modTwitch.add('somechan')
      api = await boot()
      api.initTour()
      await flush()
      expect(modAsks).toEqual([]) // five cards of plain words: no network for a row nobody can see
      for (let i = 0; i < LAST; i++) btn('next').click()
      await flush()
      expect(modAsks).toEqual(['somechan'])
      expect(rowEl('hs_mod_toolbar_buttons').hidden).toBe(false)
    })

    test('the "more in settings" link is the last card only', async () => {
      api = await boot()
      api.initTour()
      await flush()
      expect(btn('more').hidden).toBe(true)
      for (let i = 0; i < LAST; i++) btn('next').click()
      expect(btn('more').hidden).toBe(false)
    })
  })

  describe('the mod row', () => {
    test('a twitch mod sees it; it writes the starter list, and off clears the list', async () => {
      modTwitch.add('somechan')
      api = await bootSwitches()
      const row = rowEl('hs_mod_toolbar_buttons')
      expect(row.hidden).toBe(false)
      row.click()
      expect(sets.at(-1)[0]).toBe('hs_mod_toolbar_buttons')
      expect(sets.at(-1)[1]).toEqual(['delete_message', 'timeout_10m', 'ban'])
      expect(row.getAttribute('aria-checked')).toBe('true')
      row.click()
      expect(sets.at(-1)).toEqual(['hs_mod_toolbar_buttons', []])
      expect(row.getAttribute('aria-checked')).toBe('false')
    })

    test('a kick mod sees it too (kick rooms ask the kick cache)', async () => {
      rooms = ['kick/some-slug']
      modKick.add('some-slug')
      api = await bootSwitches()
      expect(rowEl('hs_mod_toolbar_buttons').hidden).toBe(false)
    })

    test('a viewer who mods a DIFFERENT channel does not see it here', async () => {
      modTwitch.add('elsewhere')
      api = await bootSwitches()
      expect(rowEl('hs_mod_toolbar_buttons').hidden).toBe(true)
    })

    test('a cold cache answers late: the row appears when the answer lands, and follows the tab', async () => {
      api = await bootSwitches()
      expect(rowEl('hs_mod_toolbar_buttons').hidden).toBe(true)
      modTwitch.add('somechan')
      // same tab, inside the retry window: nothing re-asked, but a tab change re-asks at once
      api.setTab('other')
      rooms = ['twitch/somechan']
      api.tourSync('other')
      await flush()
      expect(rowEl('hs_mod_toolbar_buttons').hidden).toBe(false)
      rooms = ['twitch/nomod']
      api.setTab('third')
      api.tourSync('third')
      await flush()
      expect(rowEl('hs_mod_toolbar_buttons').hidden).toBe(true)
    })
  })

  describe('closing it', () => {
    test('"got it" hides the card and stores the flag; a fresh page load never shows it again', async () => {
      api = await boot()
      api.initTour()
      await flush()
      card().querySelector('.hs-mc-tour-done').click()
      await flush()
      expect(shown()).toBe(false)
      expect(store.hs_tour_seen).toBe(true)
      api.tourSync('live')
      expect(shown()).toBe(false)

      doc.getElementById('hs-mc-tour')?.remove()
      const again = await boot() // new module instance, same storage
      again.initTour()
      await flush()
      expect(card()).toBeNull()
    })

    test('Esc closes it for good, the same as "got it"', async () => {
      api = await boot()
      api.initTour()
      await flush()
      const ev = new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      btn('next').dispatchEvent(ev)
      await flush()
      expect(ev.defaultPrevented).toBe(true)
      expect(shown()).toBe(false)
      expect(store.hs_tour_seen).toBe(true)
    })

    test('focus that was in the card goes back to the composer, not nowhere', async () => {
      api = await bootSwitches()
      rowEl('viMode').focus()
      expect(doc.activeElement).toBe(rowEl('viMode'))
      card().querySelector('.hs-mc-tour-done').click()
      expect(doc.activeElement).toBe(doc.getElementById('hs-mc-input'))
    })

    test('closing it in one tab closes it in the others', async () => {
      api = await boot()
      api.initTour()
      await flush()
      fire('local', { hs_tour_seen: { newValue: true } })
      expect(shown()).toBe(false)
    })

    test('a failed save is loud, and the card still closes for this page', async () => {
      api = await boot({ setFails: true })
      api.initTour()
      await flush()
      card().querySelector('.hs-mc-tour-done').click()
      await flush()
      expect(shown()).toBe(false)
      expect(toasts).toEqual([['mc_main_settings_save_failed', 'error']])
    })
  })

  describe('reopening', () => {
    test('"show the tour again" clears the flag, shows the first card, and puts focus on its next button', async () => {
      api = await boot({ seen: true })
      api.initTour()
      await flush()
      expect(card()).toBeNull()
      api.tourReopen()
      await flush()
      expect('hs_tour_seen' in store).toBe(false)
      expect(shown()).toBe(true)
      expect(stepNow()).toBe(0)
      expect(doc.activeElement).toBe(btn('next'))
    })

    test('a reopen starts over from the first card, even from the last, and forgets the saved step', async () => {
      api = await boot({ seen: true, step: 4 })
      api.initTour()
      await flush()
      api.tourReopen()
      await flush()
      expect(stepNow()).toBe(0)
      expect('hs_tour_step' in store).toBe(false)
    })

    test('after a reopen, "got it" closes it again for good', async () => {
      api = await boot({ seen: true })
      api.initTour()
      await flush()
      api.tourReopen()
      await flush()
      card().querySelector('.hs-mc-tour-done').click()
      await flush()
      expect(store.hs_tour_seen).toBe(true)
      expect(shown()).toBe(false)
    })
  })

  describe('keyboard', () => {
    test('every control is a real button, in order, and none jumps the tab order', async () => {
      modTwitch.add('somechan')
      api = await bootSwitches()
      const ctl = [...card().querySelectorAll('button')]
      expect(ctl.map((b) => b.className.split(' ')[0])).toEqual([
        'hs-mc-tour-row',
        'hs-mc-tour-row',
        'hs-mc-tour-row',
        'hs-mc-tour-row',
        'hs-mc-tour-back',
        'hs-mc-tour-next',
        'hs-mc-tour-more',
        'hs-mc-tour-done',
      ])
      for (const b of ctl) {
        expect(b.getAttribute('tabindex')).toBeNull()
        expect(b.type).toBe('button')
      }
      for (const b of card().querySelectorAll('.hs-mc-tour-row')) expect(b.getAttribute('role')).toBe('switch')
    })

    test('Space toggles once, and is claimed so the page does not type it into the composer', async () => {
      api = await bootSwitches()
      const down = new win.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
      rowEl('timestamps').dispatchEvent(down)
      expect(down.defaultPrevented).toBe(true)
      expect(sets).toEqual([['timestamps', true]])
      const up = new win.KeyboardEvent('keyup', { key: ' ', bubbles: true, cancelable: true })
      rowEl('timestamps').dispatchEvent(up)
      expect(up.defaultPrevented).toBe(true)
      expect(sets.length).toBe(1)
      // a held key does not flicker the switch
      const held = new win.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true, repeat: true })
      rowEl('timestamps').dispatchEvent(held)
      expect(sets.length).toBe(1)
    })

    test('"more in settings" opens the settings tab', async () => {
      api = await bootSwitches()
      card().querySelector('.hs-mc-tour-more').click()
      expect(api.calls.tabs).toEqual(['settings'])
    })
  })

  test('a repaint with nothing changed leaves the DOM alone', async () => {
    api = await bootSwitches()
    const before = rowEl('viMode').firstChild
    api.tourSync('live')
    api.tourSync('live')
    expect(rowEl('viMode').firstChild).toBe(before)
  })

  test('a card left by a dead injection is replaced, not reused', async () => {
    api = await boot()
    api.initTour()
    await flush()
    const old = card()
    old.dataset.hsCtx = 'someone-else'
    api.tourSync('live')
    expect(card()).not.toBe(old)
    expect(doc.querySelectorAll('#hs-mc-tour').length).toBe(1)
  })
})
