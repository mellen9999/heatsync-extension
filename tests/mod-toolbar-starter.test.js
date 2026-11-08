import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'

/**
 * mod-toolbar.js, run for real against a happy-dom page:
 *
 *   - the first time the viewer is confirmed a moderator (twitch, kick or
 *     youtube) and the hover buttons were never customised, a small starter set
 *     is turned on and one toast says where to change it. Never again after an
 *     edit — including clearing the list — and never twice.
 *   - YouTube rows get the hover toolbar: delete, ONE timeout, ban and unban
 *     (youtube has no per-duration timeouts, no purge, no blocked terms), driven
 *     by the row's message id.
 */
const ROOT = join(import.meta.dir, '..')
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8')
const SRC = read('src', 'multichat', 'mod-toolbar.js')
const STARTER = ['delete_message', 'timeout_10m', 'ban']
const flush = () => new Promise((r) => setTimeout(r, 0))

let win
let disk // browser.storage.local, shared across "page loads" in one test
let writes // what setSetting was asked to write
let toasts
let sent // runtime messages
let timers // setTimeout callbacks the toolbar scheduled through cleanup
let ytStatus
let ytListeners

function load({ hydrated = true, setOk = true, getFails = false, gql = null, kick = null, yt = null } = {}) {
  const d = win.document
  const state = { hydrated, setOk, getFails }
  ytStatus = yt ? { hs_yt_mod_status: yt } : {}
  ytListeners = []
  const g = {
    document: d,
    window: win,
    t: (k, subs = []) => `${k}${subs.length ? `:${subs.join(',')}` : ''}`,
    showToast: (m, kind) => toasts.push([m, kind]),
    setSetting: (k, v) => {
      if (!state.setOk) return false
      writes.push([k, v])
      disk[k] = v
      return true
    },
    browser: {
      storage: {
        local: {
          get: async (k) => {
            if (state.getFails) throw new Error('storage down')
            return k in disk ? { [k]: disk[k] } : {}
          },
        },
      },
    },
    chrome: {
      runtime: { lastError: undefined },
      storage: {
        local: { get: (_k, cb) => cb(ytStatus) },
        onChanged: { addListener: (f) => ytListeners.push(f) },
      },
    },
    cleanup: { setTimeout: (f, ms) => timers.push([f, ms]) },
    twitchGql: async () => gql,
    safeSendMessage: async (m) => {
      sent.push(m)
      if (m.type === 'kick_mod_status') return kick
      return { ok: true }
    },
    isSelf: () => false,
    getChannelLookup: () => ({ byId: new Map(), twitch: new Map(), kick: new Map() }),
    currentYoutubeVideoId: () => 'vid1',
    currentUsername: 'me',
    modConfirmBan: false,
    modBanReasons: '',
    markClearedRow: () => {},
    hsConfirm: async () => ({ ok: true }),
    youtubeModErrorMessage: (e) => String(e),
    openBlockedTerms: () => {},
    openModSuite: () => {},
  }
  const api = new Function(
    ...Object.keys(g),
    `let _settingsHydrated = true
    ${SRC}
    return {
      isModFor, isKickModFor, wireModToolbarHover, buildModToolbarOnce, gateModButtons, runModAction,
      setHydrated: (v) => { _settingsHydrated = v },
      setButtons: (ids) => { modToolbarButtons = ids; rebuildModToolbarButtons() },
      bar: () => _modToolbar,
    }`,
  )(...Object.values(g))
  api.setHydrated(state.hydrated)
  api.state = state
  return api
}

beforeEach(() => {
  win = new Window({ url: 'https://example.test/' })
  disk = {}
  writes = []
  toasts = []
  sent = []
  timers = []
})
afterEach(() => win.close())

const twitchMod = { data: { user: { self: { isModerator: true } } } }

describe('starter mod buttons', () => {
  test('the first confirmed twitch mod answer turns the starter set on and says where to change it', async () => {
    const m = load({ gql: twitchMod })
    expect(await m.isModFor('somechan')).toBe(true)
    await flush()
    expect(writes).toEqual([['hs_mod_toolbar_buttons', STARTER]])
    expect(toasts).toEqual([['mc_mtb_seeded', 'info']])
  })

  test('it happens once: more mod answers, in more channels, seed nothing more', async () => {
    const m = load({ gql: twitchMod })
    await m.isModFor('one')
    await m.isModFor('two')
    await m.isModFor('three')
    await flush()
    expect(writes.length).toBe(1)
    expect(toasts.length).toBe(1)
  })

  test('not a mod, or twitch not saying yet: nothing is turned on', async () => {
    await load({ gql: { data: { user: { self: { isModerator: false } } } } }).isModFor('chan')
    await load({ gql: { data: { user: { self: null } } } }).isModFor('chan')
    await flush()
    expect(writes).toEqual([])
    expect(toasts).toEqual([])
  })

  test('buttons the viewer already set up are never touched — even an empty list', async () => {
    for (const mine of [['ban'], []]) {
      disk = { hs_mod_toolbar_buttons: mine }
      const m = load({ gql: twitchMod })
      await m.isModFor('chan')
      await flush()
      expect(writes).toEqual([])
      expect(toasts).toEqual([])
      expect(disk.hs_mod_toolbar_buttons).toEqual(mine)
    }
  })

  test('seeded, then cleared by the viewer, then the page reloads: it does not come back', async () => {
    await load({ gql: twitchMod }).isModFor('chan')
    await flush()
    expect(disk.hs_mod_toolbar_buttons).toEqual(STARTER)
    disk.hs_mod_toolbar_buttons = [] // the viewer unticked everything in settings
    writes.length = 0
    toasts.length = 0
    const reloaded = load({ gql: twitchMod })
    await reloaded.isModFor('chan')
    await flush()
    expect(writes).toEqual([])
    expect(toasts).toEqual([])
    expect(disk.hs_mod_toolbar_buttons).toEqual([])
  })

  test('a confirmed kick mod gets it too; a failed kick answer does not', async () => {
    await load({ kick: { ok: false } }).isKickModFor('slug')
    await flush()
    expect(writes).toEqual([])
    await load({ kick: { ok: true, isMod: false } }).isKickModFor('slug')
    await flush()
    expect(writes).toEqual([])
    await load({ kick: { ok: true, isMod: true } }).isKickModFor('slug')
    await flush()
    expect(writes).toEqual([['hs_mod_toolbar_buttons', STARTER]])
  })

  test('a youtube mod gets it, whether the status was already stored or arrives later', async () => {
    load({ yt: { isMod: true } })
    await flush()
    expect(writes).toEqual([['hs_mod_toolbar_buttons', STARTER]])
    writes.length = 0
    disk = {}
    load({ yt: { isMod: false } })
    await flush()
    expect(writes).toEqual([])
    expect(ytListeners.length).toBe(1)
    ytListeners[0]({ hs_yt_mod_status: { newValue: { isMod: true } } }, 'local')
    await flush()
    expect(writes).toEqual([['hs_mod_toolbar_buttons', STARTER]])
  })

  test('waits for settings to finish loading, so the write is not overwritten by the load', async () => {
    const m = load({ gql: twitchMod, hydrated: false })
    await m.isModFor('chan')
    await flush()
    expect(writes).toEqual([]) // too early: the settings load would read storage from before
    expect(timers.length).toBe(1)
    m.setHydrated(true)
    timers.shift()[0]()
    await flush()
    expect(writes).toEqual([['hs_mod_toolbar_buttons', STARTER]])
  })

  test('gives up waiting for settings after a while instead of polling forever', async () => {
    const m = load({ gql: twitchMod, hydrated: false })
    await m.isModFor('chan')
    let rounds = 0
    while (timers.length && rounds < 100) {
      timers.shift()[0]()
      rounds++
    }
    expect(rounds).toBeGreaterThan(1)
    expect(rounds).toBeLessThan(100)
    expect(writes).toEqual([])
  })

  test('a write that did not land is retried on the next confirmed answer, not marked done', async () => {
    const m = load({ gql: twitchMod, setOk: false })
    await m.isModFor('one')
    await flush()
    expect(writes).toEqual([])
    expect(toasts).toEqual([]) // never claims buttons it could not add
    m.state.setOk = true
    await m.isModFor('two')
    await flush()
    expect(writes).toEqual([['hs_mod_toolbar_buttons', STARTER]])
  })

  test('a storage hiccup is retried too', async () => {
    const m = load({ gql: twitchMod, getFails: true })
    await m.isModFor('one')
    await flush()
    expect(writes).toEqual([])
    m.state.getFails = false
    await m.isModFor('two')
    await flush()
    expect(writes.length).toBe(1)
  })

  test('the tour card offers the same starter set', () => {
    const tour = read('src', 'multichat', 'tour.js')
    const m = /const TOUR_MOD_STARTER = (\[[^\]]*\])/.exec(tour)
    expect(m, 'TOUR_MOD_STARTER not found').toBeTruthy()
    expect(JSON.parse(m[1].replaceAll("'", '"'))).toEqual(STARTER)
  })
})

describe('youtube rows get the hover toolbar', () => {
  const ALL = ['delete_message', 'timeout_1m', 'timeout_10m', 'purge', 'ban', 'unban', 'blocked_terms', 'mod_tools']
  const shown = (m) =>
    [...m.bar().querySelectorAll('.hs-mod-btn')].filter((b) => b.style.display !== 'none').map((b) => b.dataset.modBtn)
  const yt = { platform: 'youtube', user: 'viewer', msgId: 'ytmsg1', channel: '' }

  function ready() {
    const m = load()
    m.buildModToolbarOnce()
    m.setButtons(ALL)
    return m
  }

  test('delete, one timeout, ban and unban — and nothing youtube cannot do', () => {
    const m = ready()
    expect(m.gateModButtons(yt)).toBe(true)
    // purge, blocked terms and mod tools are twitch-only; the second timeout would repeat the first
    expect(shown(m)).toEqual(['delete_message', 'timeout_1m', 'ban', 'unban'])
  })

  test('purge never stands in for the youtube timeout, whatever order the buttons are in', () => {
    const m = load()
    m.buildModToolbarOnce()
    m.setButtons(['purge', 'timeout_10m'])
    m.gateModButtons(yt)
    expect(shown(m)).toEqual(['timeout_10m']) // a 1-second purge would not be one on youtube
  })

  test('the one timeout says "timeout", not a duration youtube would ignore', () => {
    const m = ready()
    m.gateModButtons(yt)
    const b = m.bar().querySelector('[data-mod-btn="timeout_1m"]')
    expect(b.textContent).toBe('mc_input_timeout')
    expect(b.title).toBe('mc_input_timeout')
  })

  test('the same toolbar moved to a twitch row is back to normal', () => {
    const m = ready()
    m.gateModButtons(yt)
    m.gateModButtons({ platform: 'twitch', user: 'viewer', msgId: 'x', channel: 'chan' })
    expect(shown(m)).toEqual(ALL)
    const b = m.bar().querySelector('[data-mod-btn="timeout_1m"]')
    expect(b.textContent).toBe('1m')
    expect(b.title).toBe('mc_mtb_t_to_1m')
  })

  test('a youtube row without a message id gets no toolbar (every action is addressed by it)', () => {
    const m = ready()
    expect(m.gateModButtons({ ...yt, msgId: '' })).toBe(false)
    expect(shown(m)).toEqual([])
  })

  test('kick still has no purge (unchanged)', () => {
    const m = ready()
    m.gateModButtons({ platform: 'kick', user: 'viewer', msgId: 'k1', channel: 'slug' })
    expect(shown(m)).not.toContain('purge')
    expect(shown(m)).toContain('timeout_1m')
  })

  describe('hovering a row', () => {
    function page(m, plat, { msgId = 'ytmsg1', channel = '' } = {}) {
      const msgs = win.document.createElement('div')
      const row = win.document.createElement('div')
      row.className = 'hs-mc-msg'
      row.dataset.msgPlatform = plat
      row.dataset.msgUser = 'viewer'
      row.dataset.msgLogin = 'viewer'
      row.dataset.msgChannel = channel
      if (msgId) row.dataset.msgId = msgId
      msgs.appendChild(row)
      win.document.body.appendChild(msgs)
      m.wireModToolbarHover(msgs)
      return row
    }
    const hover = (row) => row.dispatchEvent(new win.MouseEvent('mouseover', { bubbles: true }))

    test('a youtube mod sees the toolbar on a youtube row', () => {
      const m = load({ yt: { isMod: true } })
      m.setButtons(STARTER)
      const row = page(m, 'youtube')
      hover(row)
      expect(m.bar().parentElement).toBe(row)
      expect(shown(m)).toEqual(['delete_message', 'timeout_10m', 'ban'])
    })

    test('a youtube viewer who is not a mod sees nothing', () => {
      const m = load({ yt: { isMod: false } })
      m.setButtons(STARTER)
      hover(page(m, 'youtube'))
      expect(m.bar()?.parentElement ?? null).toBeNull()
    })

    test('clicking the timeout asks youtube to time out that message, with its id', async () => {
      const m = load({ yt: { isMod: true } })
      m.setButtons(STARTER)
      const row = page(m, 'youtube')
      hover(row)
      m.bar().querySelector('[data-mod-btn="timeout_10m"]').click()
      await flush()
      const call = sent.find((x) => x.type === 'youtube_mod_action')
      expect(call).toEqual({
        type: 'youtube_mod_action',
        action: 'timeout',
        msgId: 'ytmsg1',
        target: 'viewer',
        videoId: 'vid1',
      })
      // the toast names no duration: youtube's timeout is one fixed length
      expect(toasts.some(([msg]) => msg.includes('mc_input_timed_out'))).toBe(true)
      expect(toasts.some(([msg]) => msg.includes('600'))).toBe(false)
    })

    test('delete and ban go out as youtube actions too', async () => {
      const m = load({ yt: { isMod: true } })
      m.setButtons(STARTER)
      const row = page(m, 'youtube')
      hover(row)
      m.bar().querySelector('[data-mod-btn="delete_message"]').click()
      await flush()
      hover(row)
      m.bar().querySelector('[data-mod-btn="ban"]').click()
      await flush()
      expect(sent.filter((x) => x.type === 'youtube_mod_action').map((x) => x.action)).toEqual(['delete', 'ban'])
    })

    test('a twitch row is untouched by the youtube path', () => {
      const m = load({ yt: { isMod: true } }) // a youtube mod is not a twitch mod
      m.setButtons(STARTER)
      hover(page(m, 'twitch', { channel: 'chan' }))
      expect(m.bar()?.parentElement ?? null).toBeNull()
    })
  })
})
