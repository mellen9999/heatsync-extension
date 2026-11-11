/**
 * The "sending" checklist (send-status.js, settings › ?): per site, signed in ✓ / not signed in ✗ /
 * can't tell ?, and one click on the ✗ opens that site's sign-in page. It runs for real against a
 * happy-dom pane with the extension's own reads faked (twitch cookie, kick + youtube session checks,
 * youtube's name chip). The reads are the ones the composer already makes: no new network call.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { bgSource } from './bg-src.js'

const ROOT = join(import.meta.dir, '..')
const SRC = readFileSync(join(ROOT, 'src', 'multichat', 'send-status.js'), 'utf8')
const SETTINGS_UI = readFileSync(join(ROOT, 'src', 'multichat', 'settings-ui.js'), 'utf8')
const BUILD = readFileSync(join(ROOT, 'build.js'), 'utf8')
const EN = JSON.parse(readFileSync(join(ROOT, 'src', '_locales', 'en', 'messages.json'), 'utf8'))

const flush = () => new Promise((r) => setTimeout(r, 5))
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

describe('send-status: the checklist', () => {
  let win
  let doc
  let reads // what each read answers
  let asked // every message sent to the background
  let opened // every window.open
  let focusListeners
  let timers // cleanup.setTimeout callbacks, fired by hand

  function load() {
    const make = new Function(
      'document',
      'window',
      't',
      'escapeHtml',
      'safeSendMessage',
      '_selfYtChip',
      'cleanup',
      `let currentUsername = ''
      ${SRC}
      return { sendStatusGroupHtml, sendStatusFill, sendStatusLogin, sendStatusProbe, SEND_SITES }`,
    )
    return make(
      doc,
      {
        open: (...a) => opened.push(a),
        addEventListener: (...a) => focusListeners.push(a),
      },
      (k) => k,
      escapeHtml,
      async (msg) => {
        asked.push(msg.type)
        if (msg.type === 'twitch_auth_status') return reads.twitch()
        if (msg.type === 'kick_session_status') return reads.kick()
        if (msg.type === 'yt_session_status') return reads.yt()
        throw new Error(`unexpected message ${msg.type}`)
      },
      () => reads.chip,
      {
        setPageTimeout: (fn) => {
          timers.push(fn)
          return timers.length
        },
        addEventListener: (_target, ev, fn) => focusListeners.push([ev, fn]),
      },
    )
  }

  const pane = () => doc.getElementById('hs-mc-messages')
  const row = (id) => pane().querySelector(`[data-send-row="${id}"]`)
  const state = (id) => row(id).querySelector('.hs-mc-send-state')
  const go = (id) => row(id).querySelector('.hs-mc-send-go')

  beforeEach(() => {
    win = new Window()
    doc = win.document
    doc.body.innerHTML = '<div id="hs-mc-messages"></div>'
    reads = {
      twitch: () => ({ loggedIn: true, username: 'mellen' }),
      kick: () => ({ loggedIn: true, username: 'mellenkick' }),
      yt: () => ({ loggedIn: true }),
      chip: '',
    }
    asked = []
    opened = []
    focusListeners = []
    timers = []
  })

  test('everything signed in: three ticks with who you are, and no sign-in button anywhere', async () => {
    const m = load()
    pane().innerHTML = m.sendStatusGroupHtml()
    m.sendStatusFill(pane())
    await flush()
    expect(state('twitch').textContent).toBe('✓ mc_send_in · mellen')
    expect(state('kick').textContent).toBe('✓ mc_send_in · mellenkick')
    expect(state('youtube').textContent).toBe('✓ mc_send_in')
    expect(pane().querySelectorAll('.hs-mc-send-go').length).toBe(0)
    for (const id of ['twitch', 'kick', 'youtube']) expect(state(id).classList.contains('in')).toBe(true)
  })

  test('signed out of kick and youtube: those two say so and get a sign-in button, twitch does not', async () => {
    reads.kick = () => ({ loggedIn: false })
    reads.yt = () => ({ loggedIn: false })
    const m = load()
    pane().innerHTML = m.sendStatusGroupHtml()
    m.sendStatusFill(pane())
    await flush()
    expect(state('twitch').classList.contains('in')).toBe(true)
    expect(go('twitch')).toBeNull()
    for (const id of ['kick', 'youtube']) {
      expect(state(id).textContent).toBe('✗ mc_send_out')
      expect(state(id).classList.contains('out')).toBe(true)
      expect(go(id).dataset.plat).toBe(id)
      expect(go(id).textContent).toBe('mc_sign_in')
    }
  })

  test('a twitch with no token is a ✗ too', async () => {
    reads.twitch = () => ({ loggedIn: false, username: null })
    const m = load()
    pane().innerHTML = m.sendStatusGroupHtml()
    m.sendStatusFill(pane())
    await flush()
    expect(state('twitch').classList.contains('out')).toBe(true)
    expect(go('twitch')).not.toBeNull()
  })

  test('the first paint says "…" and offers nothing, until the answer lands', async () => {
    const m = load()
    pane().innerHTML = m.sendStatusGroupHtml()
    for (const id of ['twitch', 'kick', 'youtube']) expect(state(id).textContent).toBe('…')
    expect(pane().querySelectorAll('.hs-mc-send-go').length).toBe(0)
  })

  test('only the rows are repainted; the rest of the pane is the same nodes', async () => {
    const m = load()
    pane().innerHTML = `<div id="keep">other settings</div>${m.sendStatusGroupHtml()}`
    const keep = doc.getElementById('keep')
    const group = pane().querySelector('[data-send-status]')
    m.sendStatusFill(pane())
    await flush()
    expect(doc.getElementById('keep')).toBe(keep)
    expect(pane().querySelector('[data-send-status]')).toBe(group)
  })

  test('a name from the page is text, never markup', async () => {
    reads.kick = () => ({ loggedIn: true, username: '<img src=x onerror=alert(1)>' })
    const m = load()
    pane().innerHTML = m.sendStatusGroupHtml()
    m.sendStatusFill(pane())
    await flush()
    expect(pane().querySelector('img')).toBeNull()
    expect(state('kick').textContent).toContain('<img src=x onerror=alert(1)>')
  })

  describe('can’t tell is not "signed out"', () => {
    test('a background that errors or answers with no verdict reads as unknown, and still offers the way in', async () => {
      reads.kick = () => ({ ok: false, error: 'context invalidated' })
      reads.yt = () => ({ loggedIn: null })
      const m = load()
      pane().innerHTML = m.sendStatusGroupHtml()
      m.sendStatusFill(pane())
      await flush()
      for (const id of ['kick', 'youtube']) {
        expect(state(id).textContent).toBe('? mc_send_unknown')
        expect(state(id).classList.contains('unknown')).toBe(true)
        expect(go(id)).not.toBeNull()
      }
    })

    test('a read that throws is unknown for that site only', async () => {
      reads.kick = () => {
        throw new Error('boom')
      }
      const m = load()
      pane().innerHTML = m.sendStatusGroupHtml()
      m.sendStatusFill(pane())
      await flush()
      expect(state('kick').classList.contains('unknown')).toBe(true)
      expect(state('twitch').classList.contains('in')).toBe(true)
      expect(state('youtube').classList.contains('in')).toBe(true)
    })

    test('a read that never answers is given up on, so the list is never stuck on "…"', async () => {
      reads.yt = () => new Promise(() => {})
      const m = load()
      pane().innerHTML = m.sendStatusGroupHtml()
      m.sendStatusFill(pane())
      await flush()
      expect(state('youtube').textContent).toBe('…')
      for (const fire of timers) fire() // the timeout elapses
      await flush()
      expect(state('youtube').classList.contains('unknown')).toBe(true)
      expect(state('twitch').classList.contains('in')).toBe(true)
    })
  })

  describe('youtube', () => {
    test('the name chip in youtube’s own chat frame is proof enough: the background is not asked', async () => {
      reads.chip = 'Some Viewer'
      const m = load()
      pane().innerHTML = m.sendStatusGroupHtml()
      m.sendStatusFill(pane())
      await flush()
      expect(state('youtube').textContent).toBe('✓ mc_send_in · Some Viewer')
      expect(asked).not.toContain('yt_session_status')
    })

    test('with no chip it asks the background, which answers a boolean', async () => {
      reads.yt = () => ({ loggedIn: false })
      const m = load()
      pane().innerHTML = m.sendStatusGroupHtml()
      m.sendStatusFill(pane())
      await flush()
      expect(asked).toContain('yt_session_status')
      expect(state('youtube').classList.contains('out')).toBe(true)
    })
  })

  describe('signing in', () => {
    test('each button opens that site’s own sign-in page in a new tab, with no opener', async () => {
      reads.twitch = () => ({ loggedIn: false })
      reads.kick = () => ({ loggedIn: false })
      reads.yt = () => ({ loggedIn: false })
      const m = load()
      pane().innerHTML = m.sendStatusGroupHtml()
      m.sendStatusFill(pane())
      await flush()
      for (const id of ['twitch', 'kick', 'youtube']) m.sendStatusLogin(go(id).dataset.plat)
      expect(opened.map((a) => new URL(a[0]).hostname)).toEqual(['www.twitch.tv', 'kick.com', 'accounts.google.com'])
      for (const a of opened) {
        expect(a[1]).toBe('_blank')
        expect(a[2]).toBe('noopener')
        expect(new URL(a[0]).protocol).toBe('https:')
      }
      // youtube's page signs you in and sends you back to youtube
      expect(decodeURIComponent(new URL(opened[2][0]).search)).toContain('www.youtube.com')
    })

    test('an unknown site id opens nothing', () => {
      const m = load()
      m.sendStatusLogin('myspace')
      m.sendStatusLogin(undefined)
      expect(opened).toEqual([])
    })

    test('the answer is re-checked after a sign-in click, and when the viewer comes back to the page', async () => {
      reads.kick = () => ({ loggedIn: false })
      const m = load()
      pane().innerHTML = m.sendStatusGroupHtml()
      m.sendStatusFill(pane())
      await flush()
      expect(state('kick').classList.contains('out')).toBe(true)
      // they sign in over there...
      reads.kick = () => ({ loggedIn: true, username: 'nowin' })
      m.sendStatusLogin('kick')
      // ...and come back: the window gets focus
      const focus = focusListeners.find((l) => l[0] === 'focus')
      expect(focus).toBeDefined()
      focus[1]()
      await flush()
      expect(state('kick').textContent).toBe('✓ mc_send_in · nowin')
      expect(go('kick')).toBeNull()
    })
  })

  describe('cost', () => {
    test('a repaint inside a few seconds reuses the answer; the probe is not run per keystroke', async () => {
      const m = load()
      pane().innerHTML = m.sendStatusGroupHtml()
      m.sendStatusFill(pane())
      await flush()
      const n = asked.length
      pane().innerHTML = m.sendStatusGroupHtml() // the settings pane re-renders on every toggle
      // rendered straight from the last answer: no "…" flash
      expect(state('twitch').textContent).toBe('✓ mc_send_in · mellen')
      m.sendStatusFill(pane())
      await flush()
      expect(asked.length).toBe(n)
    })

    test('two fills at once share one probe', async () => {
      const m = load()
      pane().innerHTML = m.sendStatusGroupHtml()
      m.sendStatusFill(pane())
      m.sendStatusFill(pane())
      await flush()
      expect(asked.filter((a) => a === 'kick_session_status').length).toBe(1)
    })

    test('a pane with no checklist costs nothing: no probe, no listener', async () => {
      const m = load()
      pane().innerHTML = '<div>settings › display</div>'
      m.sendStatusFill(pane())
      await flush()
      expect(asked).toEqual([])
      expect(focusListeners).toEqual([])
    })

    test('the focus listener is wired once however often the pane is drawn', async () => {
      const m = load()
      for (let i = 0; i < 3; i++) {
        pane().innerHTML = m.sendStatusGroupHtml()
        m.sendStatusFill(pane())
      }
      await flush()
      expect(focusListeners.filter((l) => l[0] === 'focus').length).toBe(1)
    })
  })
})

describe('send-status: wiring', () => {
  test('the module is in the bundle ahead of the settings pane that draws it', () => {
    const list = BUILD.slice(BUILD.indexOf('const MULTICHAT_MODULES = ['))
    expect(list.indexOf("'send-status.js'")).toBeGreaterThan(0)
    expect(list.indexOf("'send-status.js'")).toBeLessThan(list.indexOf("'settings-ui.js'"))
  })

  test('settings › ? draws it under the tour row, searchable, and fills it after every pane draw', () => {
    expect(SETTINGS_UI).toContain('html: sendStatusGroupHtml()')
    expect(SETTINGS_UI).toMatch(/hay: 'sending send sign in[^']*youtube/)
    expect(SETTINGS_UI).toContain('sendStatusFill(msgsEl)')
    expect(SETTINGS_UI).toContain("action === 'send-login'")
    expect(SETTINGS_UI).toContain('sendStatusLogin(settingsActionBtn.dataset.plat)')
  })

  test('it reads only what the extension already reads: no fetch, no new permission', () => {
    expect(SRC).not.toMatch(/\bfetch\(|XMLHttpRequest|chrome\.permissions|cookies\./)
    expect(SRC).toContain("type: 'kick_session_status'")
    expect(SRC).toContain("type: 'yt_session_status'")
  })

  test('its words exist in en', () => {
    for (const k of ['mc_send_title', 'mc_send_hint', 'mc_send_in', 'mc_send_out', 'mc_send_unknown', 'mc_sign_in']) {
      expect(EN[k], k).toBeDefined()
    }
  })
})

describe('background: yt_session_status', () => {
  const bg = bgSource()
  const fn = bg.slice(
    bg.indexOf('async function readYoutubeSignedIn'),
    bg.indexOf('async function sendKickMessageViaTab'),
  )
  const make = (get) => new Function('browser', `${fn}; return readYoutubeSignedIn`)({ cookies: { get } })

  test('any one of youtube’s login cookies means signed in; none means not', async () => {
    const jar =
      (names) =>
      async ({ url, name }) =>
        url === 'https://www.youtube.com' && names.includes(name) ? { value: 'secret' } : null
    expect(await make(jar(['SAPISID']))()).toBe(true)
    expect(await make(jar(['__Secure-3PAPISID']))()).toBe(true)
    expect(await make(jar(['LOGIN_INFO']))()).toBe(true)
    expect(await make(jar(['VISITOR_INFO1_LIVE', 'YSC']))()).toBe(false)
    expect(await make(jar([]))()).toBe(false)
  })

  test('an unreadable cookie store is null ("can’t tell"), never false', async () => {
    expect(
      await make(async () => {
        throw new Error('no cookies api')
      })(),
    ).toBeNull()
  })

  test('only a boolean ever leaves it, never a cookie value', async () => {
    const got = await make(async () => ({ value: 'super-secret-session' }))()
    expect(got).toBe(true)
    expect(String(got)).not.toContain('secret')
  })

  test('the message handler answers { loggedIn } and nothing else, and no permission was added', () => {
    expect(bg).toContain("message.type === 'yt_session_status'")
    expect(bg).toContain('readYoutubeSignedIn().then((loggedIn) => sendResponse({ loggedIn }))')
    for (const m of ['chrome', 'firefox']) {
      const man = JSON.parse(readFileSync(join(ROOT, 'src', 'manifests', `${m}.json`), 'utf8'))
      expect([...(man.permissions || []), ...(man.host_permissions || [])]).toContain('https://www.youtube.com/*')
    }
  })
})
