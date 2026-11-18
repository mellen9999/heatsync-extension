/**
 * A hard load can reach the overlay before twitch has drawn anything: no top nav, no
 * .channel-root, no chat shell (2 of 28 fresh loads, e2e 11-18). The blank page was read as the
 * answer: "no channel" (the panel pinned over the full height, the page squeezed beside it) and
 * a top nav 0px tall with no observer on it, so the tab bar sat under twitch's top bar until a
 * reload. Kick had the same and got armKickChatroomWatch; this is twitch's.
 *
 * Runs the real tryHookReact, twitchDrawn, rereadTwitchPage, watchTwitchLateChannel,
 * updateTwitchTopNavHeight and setupTwitchTopNavObserver against a page that is drawn in steps.
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mainSource } from './main-src.js'

const MAIN = mainSource()
const HOST = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'twitch-host.js'), 'utf8')
const cut = (src, from, to) => {
  const a = src.indexOf(from)
  const b = src.indexOf(to, a)
  if (a < 0 || b < 0) throw new Error(`carve: ${from}`)
  return src.slice(a, b)
}
// old source has no twitchDrawn: the carve falls back to the nav code alone so the test fails on what it checks
const hostFrom = HOST.includes('const twitchDrawn = ') ? 'const twitchDrawn = ' : 'let _twitchTopNavObs = null'
const CODE = [
  cut(HOST, hostFrom, '// Twitch SPA nav: zero-flicker soft refresh.'),
  cut(MAIN, 'function tryHookReact() {', '/**\n * Watch for layout changes'),
].join('\n')

function page(pathname = '/somechannel') {
  const drawn = new Set()
  const MARKS = ['top-nav', 'side-nav', 'channel-root', 'chat-shell', 'chat-room']
  const el = { getBoundingClientRect: () => ({ height: 50, width: 240 }) }
  const find = (sel) =>
    String(sel)
      .split(',')
      .some((part) => MARKS.some((m) => part.includes(m) && drawn.has(m)))
      ? el
      : null
  const bodyClasses = new Set()
  const timers = []
  const scope = {
    hostPlatform: 'twitch',
    mcSignal: { aborted: false },
    log() {},
    CONFIG: { SELECTORS: { TWITCH_STREAM_CHAT: '.stream-chat', TWITCH_CHAT_SHELL: '.chat-shell-alt' } },
    location: { pathname },
    document: {
      querySelector: find,
      getElementById: () => scope.panel,
      documentElement: {
        style: { vars: {}, setProperty: (k, v) => (scope.document.documentElement.style.vars[k] = v) },
      },
      body: { classList: { contains: (c) => bodyClasses.has(c) } },
    },
    panel: null,
    hsQuery: (_k, sel) => find(sel),
    getComputedStyle: () => ({ display: 'block' }),
    ResizeObserver: class {
      observe(t) {
        scope.navWatched = t
      }
      disconnect() {}
    },
    MutationObserver: class {
      constructor(cb) {
        scope.onMutation = cb
      }
      observe() {}
      disconnect() {
        scope.onMutation = null
      }
    },
    cleanup: { trackObserver() {}, setTimeout: (fn, ms) => timers.push({ fn, ms }) },
    TWITCH_TOP_NAV_HEIGHT: 50,
    _twitchTopNavH: 50,
    chatPosition: 'right',
    applyPlatformPositionOverrides() {},
    calls: [],
    setupTwitchSideNavObserver: () => scope.calls.push('side-nav'),
    // the page kind, as the real one reads it
    updateTwitchNoChannelClass: () => {
      scope.calls.push('page-kind')
      if (find('.channel-root')) bodyClasses.delete('hs-twitch-no-channel')
      else bodyClasses.add('hs-twitch-no-channel')
    },
    findChatRoomComponent: () => (drawn.has('chat-room') ? { instance: {} } : null),
    patchChatRoomRender() {},
    ensureUIElements() {},
    bootSwitch() {},
    startLayoutWatcher() {},
    mounts: [],
    // the body mount parks the panel on body; the others put it in twitch's chat column
    _runOverlayMountPass: (label, fn) => {
      scope.calls.push('mount')
      scope.mounts.push(label)
      scope.panel = { parentElement: label.includes('body-mount') ? scope.document.body : {} }
      fn()
    },
    softNavs: 0,
    softTwitchNav: () => {
      scope.softNavs++
      bodyClasses.delete('hs-twitch-no-channel')
      scope.panel = { parentElement: {} }
    },
  }
  const api = new Function(
    'scope',
    `with (scope) { ${CODE}\n return { tryHookReact, rereadTwitchPage: typeof rereadTwitchPage === 'function' ? rereadTwitchPage : null, setupTwitchTopNavObserver } }`,
  )(scope)
  const draw = (...marks) => {
    for (const m of marks) drawn.add(m)
    scope.onMutation?.()
  }
  // run the timers due within `ms`, oldest first, as a clock would
  let now = Date.now()
  const realNow = Date.now
  const pass = (ms) => {
    const end = now + ms
    Date.now = () => now
    try {
      for (;;) {
        for (const t of timers) if (t.at === undefined) t.at = now + t.ms
        const next = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0]
        if (!next) break
        timers.splice(timers.indexOf(next), 1)
        now = next.at
        next.fn()
      }
      now = end
    } finally {
      Date.now = realNow
    }
  }
  const navVar = () => scope.document.documentElement.style.vars['--hs-twitch-topnav-h']
  return { ...api, scope, draw, pass, timers, bodyClasses, navVar }
}

test('a page twitch has not drawn yet is not a page with no channel: nothing mounts until it is drawn', () => {
  const p = page()
  // boot already read the blank page
  p.scope.updateTwitchNoChannelClass()
  p.setupTwitchTopNavObserver()
  expect(p.bodyClasses.has('hs-twitch-no-channel')).toBe(true)
  expect(p.navVar()).toBe('0px')
  p.tryHookReact()
  expect(p.scope.mounts).toEqual([])
  p.draw('top-nav', 'side-nav', 'channel-root', 'chat-shell', 'chat-room')
  expect(p.scope.mounts).toEqual(['twitch react hook'])
  // what boot read is read again, before anything is mounted
  expect(p.bodyClasses.has('hs-twitch-no-channel')).toBe(false)
  expect(p.navVar()).toBe('50px')
  expect(p.scope.navWatched).toBeTruthy()
  expect(p.scope.calls.indexOf('page-kind', 1)).toBeLessThan(p.scope.calls.indexOf('mount'))
  expect(p.scope.softNavs).toBe(0)
})

test('a drawn page with no channel on it gets its overlay at once, under a nav that was measured', () => {
  const p = page('/directory')
  p.scope.updateTwitchNoChannelClass()
  p.setupTwitchTopNavObserver()
  expect(p.navVar()).toBe('0px')
  p.tryHookReact()
  expect(p.scope.mounts).toEqual([])
  p.draw('top-nav', 'side-nav')
  expect(p.scope.mounts).toEqual(['twitch non-channel body-mount'])
  expect(p.navVar()).toBe('50px')
  expect(p.bodyClasses.has('hs-twitch-no-channel')).toBe(true)
  // nothing more of twitch's arrives: asked for a while, then never again
  p.pass(20_000)
  expect(p.scope.softNavs).toBe(0)
  expect(p.timers.filter((t) => t.ms === 250).length).toBe(0)
})

test('the shell drawn first and the channel after it: the channel arriving is handled like a navigation onto it, once', () => {
  const p = page()
  p.tryHookReact()
  p.draw('top-nav', 'side-nav')
  expect(p.scope.mounts).toEqual(['twitch non-channel body-mount'])
  p.pass(1000)
  expect(p.scope.softNavs).toBe(0)
  p.draw('channel-root', 'chat-shell')
  p.pass(1000)
  expect(p.scope.softNavs).toBe(1)
  p.pass(20_000)
  expect(p.scope.softNavs).toBe(1)
  expect(p.scope.mounts.length).toBe(1)
})

test('the class is not what says the panel is still parked: another re-read clearing it does not end the watch', () => {
  const p = page()
  p.tryHookReact()
  p.draw('top-nav', 'side-nav')
  p.draw('channel-root', 'chat-shell')
  // a theatre flip re-read the page kind before the watch looked
  p.scope.updateTwitchNoChannelClass()
  expect(p.bodyClasses.has('hs-twitch-no-channel')).toBe(false)
  p.pass(1000)
  expect(p.scope.softNavs).toBe(1)
})

test('a panel something else already moved off body is left where it is', () => {
  const p = page()
  p.tryHookReact()
  p.draw('top-nav', 'side-nav')
  p.scope.panel = { parentElement: {} }
  p.draw('channel-root', 'chat-shell')
  p.pass(20_000)
  expect(p.scope.softNavs).toBe(0)
  expect(p.timers.length).toBe(0)
})

test("a real navigation in that window is the navigation handler's: the late watch stands down", () => {
  const p = page('/directory')
  p.tryHookReact()
  p.draw('top-nav')
  p.scope.location.pathname = '/somechannel'
  p.draw('channel-root', 'chat-shell')
  p.pass(20_000)
  expect(p.scope.softNavs).toBe(0)
})

test("a page that never draws anything of twitch's still gets the overlay when the wait is over, as before", () => {
  const p = page('/some-odd-page')
  p.tryHookReact()
  p.pass(14_000)
  expect(p.scope.mounts).toEqual([])
  p.pass(2000)
  expect(p.scope.mounts).toEqual(['twitch non-channel body-mount'])
})

test('a channel page whose chat never comes is left alone when the wait is over', () => {
  const p = page()
  p.tryHookReact()
  p.draw('top-nav', 'channel-root')
  p.pass(16_000)
  expect(p.scope.mounts).toEqual([])
})
