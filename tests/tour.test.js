import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SETTINGS } from '../src/lib/settings-schema.js'
import { mainSource } from './main-src.js'

/**
 * First-run tour card (tour.js). The card is a thin skin over the real
 * settings: every switch writes the registry key the settings panel writes.
 * tour.js runs for real against a happy-dom document with the registry,
 * storage and mod caches faked; wiring checks read the sources.
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
    const keys = new Set([...SRC.matchAll(/\b(mc_[a-z_0-9]+)\b/g)].map((m) => m[1]))
    keys.add('mc_set_tour')
    keys.add('mc_set_tour_tip')
    keys.add('mc_set_tour_btn')
    for (const k of keys) expect(EN[k], k).toBeDefined()
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
    // .focus() appears exactly twice: back to the composer when the card closes, and on an explicit reopen
    expect([...SRC.matchAll(/\.focus\(\)/g)].length).toBe(2)
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
  let api

  const fire = (area, changes) => {
    for (const fn of onChanged) fn(changes, area)
  }
  const flush = () => new Promise((r) => setTimeout(r, 5))

  // a fresh module instance, like a fresh page load, over the shared storage
  async function boot({ seen, getFails, setFails } = {}) {
    if (seen !== undefined) store.hs_tour_seen = seen
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
              return k in store ? { [k]: store[k] } : {}
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
              const changes = { [k]: { oldValue: store[k] } }
              delete store[k]
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
      async (c) => modTwitch.has(c),
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
    api = await boot()
    api.initTour()
    await flush()
    const keys = [...card().querySelectorAll('.hs-mc-tour-row')].map((b) => b.dataset.tourKey)
    expect(keys).toEqual(['timestamps', 'hoverReply', 'viMode', 'hs_mod_toolbar_buttons'])
    expect(rowEl('timestamps').hidden).toBe(false)
    expect(rowEl('hs_mod_toolbar_buttons').hidden).toBe(true)
  })

  test('clicking a switch writes the REAL key, both directions, and repaints', async () => {
    api = await boot()
    api.initTour()
    await flush()
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
    api = await boot()
    api.initTour()
    await flush()
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
    api = await boot()
    api.initTour()
    await flush()
    rowEl('hoverReply').click()
    expect(api.calls.settingsRenders).toBe(1)
  })

  describe('the mod row', () => {
    test('a twitch mod sees it; it writes the starter list, and off clears the list', async () => {
      modTwitch.add('somechan')
      api = await boot()
      api.initTour()
      await flush()
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
      api = await boot()
      api.initTour()
      await flush()
      expect(rowEl('hs_mod_toolbar_buttons').hidden).toBe(false)
    })

    test('a viewer who mods a DIFFERENT channel does not see it here', async () => {
      modTwitch.add('elsewhere')
      api = await boot()
      api.initTour()
      await flush()
      expect(rowEl('hs_mod_toolbar_buttons').hidden).toBe(true)
    })

    test('a cold cache answers late: the row appears when the answer lands, and follows the tab', async () => {
      api = await boot()
      api.initTour()
      await flush()
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
      rowEl('timestamps').dispatchEvent(ev)
      await flush()
      expect(ev.defaultPrevented).toBe(true)
      expect(shown()).toBe(false)
      expect(store.hs_tour_seen).toBe(true)
    })

    test('focus that was in the card goes back to the composer, not nowhere', async () => {
      api = await boot()
      api.initTour()
      await flush()
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
    test('"show the tour again" clears the flag, shows the card, and puts focus on the first switch', async () => {
      api = await boot({ seen: true })
      api.initTour()
      await flush()
      expect(card()).toBeNull()
      api.tourReopen()
      await flush()
      expect('hs_tour_seen' in store).toBe(false)
      expect(shown()).toBe(true)
      expect(doc.activeElement).toBe(rowEl('timestamps'))
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
      api = await boot()
      api.initTour()
      await flush()
      const ctl = [...card().querySelectorAll('button')]
      expect(ctl.map((b) => b.className.split(' ')[0])).toEqual([
        'hs-mc-tour-row',
        'hs-mc-tour-row',
        'hs-mc-tour-row',
        'hs-mc-tour-row',
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
      api = await boot()
      api.initTour()
      await flush()
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
      api = await boot()
      api.initTour()
      await flush()
      card().querySelector('.hs-mc-tour-more').click()
      expect(api.calls.tabs).toEqual(['settings'])
    })
  })

  test('a repaint with nothing changed leaves the DOM alone', async () => {
    api = await boot()
    api.initTour()
    await flush()
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
