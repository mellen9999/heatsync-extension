// The vod tab: on twitch /videos/<id> the pane mirrors twitch's own replay rows into a temp tab.
// The module runs as shipped (the bundle's free identifiers are the harness's stubs); the DOM is
// the row structure read off a live VOD (kripp, 11-26).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { twitchPageKind, twitchVodId } from '../src/lib/reserved-paths.js'

const ROOT = join(import.meta.dir, '..')
const SRC = readFileSync(join(ROOT, 'src', 'multichat', 'vod-replay.js'), 'utf8').replace(/^export \{[^}]*\}\s*$/m, '')

const KAPPA = 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0'
const BTTV = 'https://cdn.betterttv.net/emote/abc/2x'
const row = (user, parts, { color = 'rgb(255, 0, 0)', badge = '' } = {}) => `
  <li><div class="vod-message">
    <div class="vod-message__header"><button>0:01:02</button></div>
    <div><div><div>
      ${badge ? `<span><img class="chat-badge" src="${badge}"></span>` : ''}
      <a class="tw-link" href="/${user.toLowerCase()}"><span><span data-a-target="chat-message-username" data-a-user="${user.toLowerCase()}" class="chat-author__display-name" style="color: ${color}">${user}</span></span></a>
      <div class="video-chat__message"><span>: </span><span>${parts}</span></div>
    </div></div></div>
    <div class="video-chat__message-menu"></div>
  </div></li>`
const kappa = `<span class="text-fragment">hi </span><div class="chat-line__message--emote-button"><span><img alt="Kappa" class="chat-line__message--emote" src="${KAPPA}"></span></div><span class="text-fragment"> there</span>`

let win
let h
let calls
let frames

function load(path = '/videos/2934223993', { link = true, listHtml = '', cap = 5 } = {}) {
  win = new Window()
  const d = win.document
  d.body.innerHTML = `
    <div id="hs-mc-tabbar"><button data-tab="vod" style="display:none"></button></div>
    ${link ? '<div class="channel-info-content"><a href="/nl_kripp">kripp</a></div>' : ''}
    <video></video><div id="hs-mc-new-msgs"></div>
    <div class="video-chat"><div class="video-chat__message-list-wrapper"><ol>${listHtml}</ol></div></div>`
  calls = []
  frames = []
  const timers = []
  const body = `
    let currentTab = 'feed'
    let _autoSwitching = false
    const hostPlatform = 'twitch'
    const SCROLLBACK_MAX = ${cap}
    const location = LOC
    const tabBarElement = document.getElementById('hs-mc-tabbar')
    const twitchBadgeUrls = new Map([['subscriber/1', 'https://static-cdn.jtvnw.net/badges/v1/aaa-111/1'], ['nl_kripp:moderator/1', 'https://static-cdn.jtvnw.net/badges/v1/bbb-222/1']])
    const sanitizeColor = (c) => c
    const t = (k) => k
    const escapeHtml = (x) => String(x).replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';')
    let isScrolledUp = false
    function rafOrTimeout(fn) { frames.push(fn) }
    function switchTab(id) { calls.push(['switch', id, _autoSwitching]); currentTab = id }
    function liveTarget() { return 'feed' }
    function updatePopoutBtnVisibility() {}
    function mcIsReservedTab(id) { return ['feed', 'live', 'mentions'].includes(id) }
    function getChannelById(id) { return id === 'xqc' ? { id } : null }
    // the pane's own contract: a scrolled-up reader's row is not appended, the caller renders
    function appendMessage(m, tab) { calls.push(['append', tab, m.id]); return !isScrolledUp }
    function renderMessages(tab, opts) { calls.push(['render', tab, vodBuffer.map((m) => m.text), opts]) }
    function _dropTabCache(tab) { calls.push(['drop', tab]) }
    async function fetchGlobalBadges() {}
    async function fetchChannelBadges(c) { calls.push(['badges', c]) }
    const config = { channels: [{ id: 'xqc', twitch: 'xqc' }] }
    const joinExtraChannel = (p, c) => calls.push(['join', c])
    const leaveExtraChannel = (p, c) => calls.push(['leave', c])
    const safeSendMessage = (m) => { calls.push(['send', m.type, m.path]); return Promise.resolve(API(m)) }
    const cleanup = {
      setTimeout: (fn) => { timers.push(fn); return timers.length },
      clearTimeout: (id) => { if (id > 0 && id <= timers.length) timers[id - 1] = () => {} },
      trackObserver() {},
      untrackObserver() {},
      addEventListener(target, ev, fn, opts) {
        target.addEventListener(ev, fn, opts)
        return () => target.removeEventListener(ev, fn, opts)
      },
    }
    ${SRC}
    return {
      vodSync, vodBuffer, vodRowToMsg, vodOffsetSecs, vodStampHtml, vodEmptyText,
      setTab: (x) => (currentTab = x), tab: () => currentTab, scrolledUp: (x) => (isScrolledUp = x),
    }`
  const loc = { pathname: path, hostname: 'www.twitch.tv' }
  const obsMade = []
  const MO = class extends win.MutationObserver {
    constructor(cb) {
      super(cb)
      obsMade.push(this)
    }
  }
  const api = (_m) => ({ ok: true, data: { channel_login: 'nl_kripp' } })
  h = new Function(
    'document',
    'getComputedStyle',
    'MutationObserver',
    'twitchPageKind',
    'twitchVodId',
    'calls',
    'frames',
    'timers',
    'LOC',
    'API',
    body,
  )(d, (el) => win.getComputedStyle(el), MO, twitchPageKind, twitchVodId, calls, frames, timers, loc, api)
  h.loc = loc
  h.timers = timers
  h.obsMade = obsMade
  h.list = () => d.querySelector('ol')
  h.add = (html) => d.querySelector('ol').insertAdjacentHTML('beforeend', html)
  h.runTimers = () => {
    for (const fn of timers.splice(0)) fn()
  }
}
const runFrames = () => {
  for (const fn of frames.splice(0)) fn()
}
// the observer's microtask, then the frame it queued
const flush = async () => {
  await new Promise((r) => setTimeout(r, 5))
  runFrames()
}
const has = (kind, ...rest) => calls.some((c) => c[0] === kind && rest.every((r, i) => c[i + 1] === r))

beforeEach(() => {})
afterEach(() => win?.happyDOM?.close?.())

describe('a vod row becomes a message', () => {
  test('name, colour, text with twitch emotes kept, badges as twitch shows them', () => {
    load('/videos/1', { listHtml: row('Alice', kappa, { badge: 'https://static-cdn.jtvnw.net/badges/v1/bbb-222/3' }) })
    const el = win.document.querySelector('.vod-message')
    const m = h.vodRowToMsg(el, 'nl_kripp', 'vod:1:0')
    expect(m).toMatchObject({
      user: 'Alice',
      login: 'alice',
      text: 'hi Kappa there',
      channel: 'nl_kripp',
      id: 'vod:1:0',
      color: '#ff0000',
      badges: 'moderator/1',
    })
    expect(m.twitchEmotes).toEqual({ Kappa: KAPPA })
  })
  test('a third-party emote img contributes its code, never a twitch emote url', () => {
    load('/videos/1', { listHtml: row('Bob', `<span>yo </span><img alt="OMEGALUL" src="${BTTV}">`) })
    const m = h.vodRowToMsg(win.document.querySelector('.vod-message'), 'nl_kripp', 'x')
    expect(m.text).toBe('yo OMEGALUL')
    expect(m.twitchEmotes).toBeUndefined()
  })
  test('a row with no chatter is skipped', () => {
    load('/videos/1', { listHtml: '<li><div class="vod-message"><div class="video-chat__message">x</div></div></li>' })
    expect(h.vodRowToMsg(win.document.querySelector('.vod-message'), 'c', 'x')).toBeNull()
  })
})

describe('on a vod page', () => {
  test('the vod tab shows, becomes active as the page doing (not a pick), and holds the rows on screen', async () => {
    load('/videos/2934223993', { listHtml: row('A', 'one') + row('B', 'two') })
    h.vodSync()
    expect(win.document.querySelector('[data-tab=vod]').style.display).toBe('')
    expect(calls[0]).toEqual(['switch', 'vod', true])
    h.runTimers()
    await flush()
    expect(has('join', 'nl_kripp')).toBe(true) // the owner's emote sets
    expect(has('badges', 'nl_kripp')).toBe(true)
    expect(h.vodBuffer.map((m) => m.text)).toEqual(['one', 'two'])
    expect(has('render', 'vod')).toBe(true)
  })

  test('a row twitch draws later is appended once, however often the list changes', async () => {
    load('/videos/1', { listHtml: row('A', 'one') })
    h.vodSync()
    h.runTimers()
    await flush()
    calls.length = 0
    h.add(row('B', 'two'))
    await flush()
    h.add('<li>spacer</li>') // a mutation with no new row
    await flush()
    expect(calls.filter((c) => c[0] === 'append')).toHaveLength(1)
    expect(h.vodBuffer.map((m) => m.text)).toEqual(['one', 'two'])
  })

  test('a seek (twitch replaces the rows) rebuilds the tab to match the playhead', async () => {
    load('/videos/1', { listHtml: row('A', 'one') + row('B', 'two') })
    h.vodSync()
    h.runTimers()
    await flush()
    calls.length = 0
    h.list().innerHTML = row('C', 'three') + row('D', 'four')
    await flush()
    expect(h.vodBuffer.map((m) => m.text)).toEqual(['three', 'four'])
    expect(has('drop', 'vod')).toBe(true)
    expect(has('render', 'vod')).toBe(true)
  })

  test('twitch emptying the list empties the tab', async () => {
    load('/videos/1', { listHtml: row('A', 'one') })
    h.vodSync()
    h.runTimers()
    await flush()
    h.list().innerHTML = ''
    await flush()
    expect(h.vodBuffer).toHaveLength(0)
  })

  test('the tab is capped like any other', async () => {
    load('/videos/1', { listHtml: [1, 2, 3, 4, 5, 6, 7].map((n) => row('A', `m${n}`)).join('') })
    h.vodSync()
    h.runTimers()
    await flush()
    expect(h.vodBuffer.map((m) => m.text)).toEqual(['m3', 'm4', 'm5', 'm6', 'm7'])
  })

  test('no channel link on the page: the site names the owner', async () => {
    load('/videos/77', { link: false, listHtml: row('A', 'one') })
    h.vodSync()
    for (let i = 0; i < 8; i++) {
      h.runTimers()
      await flush()
    }
    expect(has('send', 'api_fetch', '/api/twitch/vod/77')).toBe(true)
    expect(has('join', 'nl_kripp')).toBe(true)
    expect(h.vodBuffer).toHaveLength(1)
  })
})

const pillClicks = () => calls.filter((c) => c[0] === 'pill').length
const renders = () => calls.filter((c) => c[0] === 'render')
const appends = () => calls.filter((c) => c[0] === 'append')
const playing = () => Object.defineProperty(win.document.querySelector('video'), 'paused', { value: false })

describe('the stamp is the video offset', () => {
  test('h:mm:ss, m:ss and ss all read as seconds; anything else is not an offset', () => {
    load()
    expect(h.vodOffsetSecs('2:00:14')).toBe(7214)
    expect(h.vodOffsetSecs('0:01:02')).toBe(62)
    expect(h.vodOffsetSecs('5:07')).toBe(307)
    expect(h.vodOffsetSecs('45')).toBe(45)
    expect(h.vodOffsetSecs(' 1:00 ')).toBe(60)
    for (const bad of ['', null, undefined, 'x', '1:xx', '1:2:3:4', '-5', '1.5', ':30'])
      expect(h.vodOffsetSecs(bad)).toBeNull()
  })

  test('the row carries the offset twitch prints in its header', () => {
    load('/videos/1', { listHtml: row('A', 'one') })
    const el = win.document.querySelector('.vod-message')
    expect(h.vodRowToMsg(el, 'c', 'x')).toMatchObject({ replay: true, replayAt: '0:01:02' })
    el.querySelector('.vod-message__header').innerHTML = '<button>2:00:14</button>'
    expect(h.vodRowToMsg(el, 'c', 'x').replayAt).toBe('2:00:14')
    el.querySelector('.vod-message__header').innerHTML = ''
    expect(h.vodRowToMsg(el, 'c', 'x').replayAt).toBe('')
  })

  test('the stamp shows the offset and says what a click does; no offset, no stamp (never a wall clock)', () => {
    load()
    const html = h.vodStampHtml({ replayAt: '2:00:14' })
    expect(html).toContain('class="hs-mc-ts"')
    expect(html).toContain('data-hs-seek="2:00:14"')
    expect(html).toContain('>2:00:14<')
    expect(html).toContain('mc_vod_seek')
    expect(h.vodStampHtml({ replayAt: '' })).toBe('')
    expect(h.vodStampHtml({})).toBe('')
    expect(h.vodStampHtml({ replayAt: '"><img src=x onerror=1>' })).toBe('')
  })

  test('a click on a stamp sets the page video to that second; a click elsewhere does nothing', () => {
    load('/videos/1', { listHtml: row('A', 'one') })
    h.vodSync()
    const d = win.document
    d.body.insertAdjacentHTML(
      'beforeend',
      `<div id="s">${h.vodStampHtml({ replayAt: '2:00:14' })}</div><p id="other">x</p>`,
    )
    const video = d.querySelector('video')
    video.currentTime = 3
    d.querySelector('#other').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
    expect(video.currentTime).toBe(3)
    d.querySelector('[data-hs-seek]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
    expect(video.currentTime).toBe(7214)
  })

  test('a stamp with no video on the page does nothing, quietly', () => {
    load('/videos/1')
    h.vodSync()
    const d = win.document
    d.querySelector('video').remove()
    d.body.insertAdjacentHTML('beforeend', h.vodStampHtml({ replayAt: '1:00' }))
    expect(() =>
      d.querySelector('[data-hs-seek]').dispatchEvent(new win.MouseEvent('click', { bubbles: true })),
    ).not.toThrow()
  })

  test('the click listener lives only while a vod page is open', () => {
    const clickAt = () => {
      const d = win.document
      d.body.insertAdjacentHTML('beforeend', h.vodStampHtml({ replayAt: '1:00' }))
      d.querySelector('video').currentTime = 0
      d.querySelector('[data-hs-seek]:last-of-type')?.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
      return d.querySelector('video').currentTime
    }
    load('/nl_kripp')
    h.vodSync()
    expect(clickAt()).toBe(0) // a channel page: nothing is listening
    load('/videos/1')
    h.vodSync()
    expect(clickAt()).toBe(60)
    h.loc.pathname = '/nl_kripp'
    h.vodSync()
    win.document.querySelector('video').currentTime = 0
    win.document.querySelector('[data-hs-seek]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
    expect(win.document.querySelector('video').currentTime).toBe(0) // left the vod: gone
  })
})

describe('a vod with no replay chat says so', () => {
  const quiet = () => h.timers[0]() // vodNew's own timer is the first one armed

  test('10s of the video playing with no row: one plain line, rendered', () => {
    load('/videos/1')
    h.vodSync()
    expect(h.vodEmptyText()).toBe('mc_no_messages')
    playing()
    calls.length = 0
    quiet()
    expect(h.vodEmptyText()).toBe('mc_vod_no_replay')
    expect(renders()).toHaveLength(1)
  })

  test("it waits for the 10 seconds (the timer is the module's one quiet clock)", () => {
    expect(SRC).toMatch(/VOD_QUIET_MS = 10000/)
    load('/videos/1')
    h.vodSync()
    expect(h.timers.length).toBeGreaterThan(0)
    expect(h.vodEmptyText()).toBe('mc_no_messages')
  })

  test('a paused or not-yet-playing video owes nothing: no line, the clock re-arms', () => {
    load('/videos/1')
    h.vodSync()
    const before = h.timers.length
    calls.length = 0
    quiet()
    expect(h.vodEmptyText()).toBe('mc_no_messages')
    expect(renders()).toHaveLength(0)
    expect(h.timers.length).toBe(before + 1)
  })

  test('a row arriving clears the line and redraws', async () => {
    load('/videos/1')
    h.vodSync()
    h.runTimers()
    await flush()
    playing()
    quiet()
    expect(h.vodEmptyText()).toBe('mc_vod_no_replay')
    calls.length = 0
    h.add(row('A', 'hello'))
    await flush()
    expect(h.vodEmptyText()).toBe('mc_no_messages')
    expect(h.vodBuffer.map((m) => m.text)).toEqual(['hello'])
  })

  test('a replay that is talking never gets the line', async () => {
    load('/videos/1', { listHtml: row('A', 'one') })
    h.vodSync()
    await flush()
    playing()
    quiet()
    expect(h.vodEmptyText()).toBe('mc_no_messages')
  })

  test('a seek into a stretch with no chat gets the line too', async () => {
    load('/videos/1', { listHtml: row('A', 'one') })
    h.vodSync()
    await flush() // the replay is talking: the first clock ends with nothing owed
    playing()
    h.runTimers()
    expect(h.vodEmptyText()).toBe('mc_no_messages')
    h.list().innerHTML = '' // seek into a stretch with no chat
    await flush()
    expect(h.vodBuffer).toHaveLength(0)
    h.runTimers()
    expect(h.vodEmptyText()).toBe('mc_vod_no_replay')
  })

  test('leaving the vod stops the clock', () => {
    load('/videos/1')
    h.vodSync()
    playing()
    h.loc.pathname = '/nl_kripp'
    h.vodSync()
    calls.length = 0
    h.runTimers()
    expect(renders()).toHaveLength(0)
    expect(h.vodEmptyText()).toBe('mc_no_messages')
  })
})

describe('a fast vod', () => {
  test('500 rows in one burst: one frame, one render, no per-row appends', async () => {
    load('/videos/1', { cap: 1000, listHtml: row('S', 'seed') })
    h.vodSync()
    h.runTimers()
    await flush()
    calls.length = 0
    // twitch draws in several turns before the next frame: each turn's mutation callback asks again
    for (let turn = 0; turn < 5; turn++) {
      for (let n = 0; n < 100; n++) h.add(row('A', `m${turn * 100 + n}`))
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(frames).toHaveLength(1) // 500 mutations, five callbacks, one frame
    runFrames()
    expect(h.vodBuffer).toHaveLength(501)
    expect(appends()).toHaveLength(0)
    expect(renders()).toHaveLength(1)
    expect(renders()[0][3]).toEqual({ added: 500 })
  })

  test('a burst past the cap reads only the rows the tab can hold', async () => {
    load('/videos/1', { cap: 50, listHtml: row('S', 'seed') })
    h.vodSync()
    h.runTimers()
    await flush()
    for (let n = 0; n < 500; n++) h.add(row('A', `m${n}`))
    await flush()
    expect(h.vodBuffer).toHaveLength(50)
    expect(h.vodBuffer[0].text).toBe('m450')
    expect(h.vodBuffer[49].text).toBe('m499')
  })

  test("a few rows in a frame are appended like a live tab's", async () => {
    load('/videos/1', { cap: 1000, listHtml: row('S', 'seed') })
    h.vodSync()
    h.runTimers()
    await flush()
    calls.length = 0
    for (let n = 0; n < 12; n++) h.add(row('A', `m${n}`))
    await flush()
    expect(appends()).toHaveLength(12)
    expect(renders()).toHaveLength(0)
  })

  test('exactly one observer: a vod → vod hop disconnects the old one', async () => {
    load('/videos/1', { listHtml: row('A', 'one') })
    h.vodSync()
    expect(h.obsMade).toHaveLength(1)
    h.add(row('B', 'two'))
    await new Promise((r) => setTimeout(r, 5))
    expect(frames).toHaveLength(1)
    runFrames()
    h.loc.pathname = '/videos/2'
    h.vodSync()
    expect(h.obsMade).toHaveLength(2)
    h.add(row('C', 'three'))
    await new Promise((r) => setTimeout(r, 5))
    expect(frames).toHaveLength(1) // the first observer is gone: one frame, not two
  })
})

describe("the reader's scroll", () => {
  test('a paused reader: the rows are not appended, the render holds them back and counts them', async () => {
    load('/videos/1', { cap: 1000, listHtml: row('S', 'seed') })
    h.vodSync()
    h.runTimers()
    await flush()
    h.scrolledUp(true)
    calls.length = 0
    h.add(row('A', 'one'))
    h.add(row('B', 'two'))
    h.add(row('C', 'three'))
    await flush()
    expect(renders()).toHaveLength(1)
    expect(renders()[0][3]).toEqual({ added: 3 })
    expect(pillClicks()).toBe(0) // the reader's place is never taken
  })

  test('a live reader keeps following: appended, no render', async () => {
    load('/videos/1', { cap: 1000, listHtml: row('S', 'seed') })
    h.vodSync()
    h.runTimers()
    await flush()
    calls.length = 0
    h.add(row('A', 'one'))
    await flush()
    expect(appends()).toHaveLength(1)
    expect(renders()).toHaveLength(0)
  })

  test('a seek while following: the tab is drawn again from the bottom', async () => {
    load('/videos/1', { listHtml: row('A', 'one') })
    h.vodSync()
    h.runTimers()
    await flush()
    calls.length = 0
    h.list().innerHTML = row('C', 'three')
    await flush()
    expect(renders().at(-1)[3]).toBeUndefined() // a whole render (lands at the bottom, as any tab render does)
    expect(pillClicks()).toBe(0)
  })

  test("a seek while scrolled up snaps back to the bottom through the pane's own pill", async () => {
    load('/videos/1', { listHtml: row('A', 'one') })
    win.document.querySelector('#hs-mc-new-msgs').addEventListener('click', () => calls.push(['pill']))
    h.vodSync()
    h.runTimers()
    await flush()
    h.scrolledUp(true)
    calls.length = 0
    h.list().innerHTML = row('C', 'three') + row('D', 'four')
    await flush()
    expect(h.vodBuffer.map((m) => m.text)).toEqual(['three', 'four'])
    expect(pillClicks()).toBe(1)
    expect(renders()).toHaveLength(0) // the pill's own jump renders: never twice
  })
})

describe('leaving the vod', () => {
  test('in-app hop to a channel: tab gone, watching stopped, reader back where they were', async () => {
    load('/videos/1', { listHtml: row('A', 'one') })
    h.setTab('xqc')
    h.vodSync()
    h.runTimers()
    await flush()
    h.loc.pathname = '/nl_kripp'
    calls.length = 0
    h.vodSync()
    expect(win.document.querySelector('[data-tab=vod]').style.display).toBe('none')
    expect(calls).toContainEqual(['switch', 'xqc', true])
    expect(has('leave', 'nl_kripp')).toBe(true) // the extra we added goes
    expect(h.vodBuffer).toHaveLength(0)
    h.add(row('Z', 'late')) // twitch's list changes after: nothing is watching
    await flush()
    expect(h.vodBuffer).toHaveLength(0)
  })

  test('a reader who already left the tab is not moved', async () => {
    load('/videos/1', { listHtml: row('A', 'one') })
    h.vodSync()
    h.setTab('mentions')
    h.loc.pathname = '/directory'
    calls.length = 0
    h.vodSync()
    expect(calls.filter((c) => c[0] === 'switch')).toHaveLength(0)
  })

  test('vod → vod keeps the tab and starts the new replay clean', async () => {
    load('/videos/1', { listHtml: row('A', 'one') })
    h.setTab('xqc')
    h.vodSync()
    h.runTimers()
    await flush()
    h.loc.pathname = '/videos/2'
    h.list().innerHTML = ''
    calls.length = 0
    h.vodSync()
    expect(h.vodBuffer).toHaveLength(0)
    expect(win.document.querySelector('[data-tab=vod]').style.display).toBe('')
    expect(calls.filter((c) => c[0] === 'switch')).toHaveLength(0)
    h.add(row('N', 'new replay'))
    h.runTimers()
    await flush()
    expect(h.vodBuffer.map((m) => m.text)).toEqual(['new replay'])
    h.loc.pathname = '/nl_kripp'
    h.vodSync()
    expect(h.tab()).toBe('xqc') // back to the tab from before the first vod
  })
})

describe('off a vod', () => {
  test('a channel page allocates and observes nothing', () => {
    load('/nl_kripp')
    h.vodSync()
    expect(h.obsMade).toHaveLength(0)
    expect(h.timers).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })
})

describe('wiring', () => {
  const read = (...p) => readFileSync(join(ROOT, 'src', 'multichat', ...p), 'utf8')
  test('the tab is in the registry, temp, and never restorable', () => {
    const reg = read('tab-registry.js')
    const m = /\{ id: 'vod'[^}]*\}/.exec(reg)?.[0] || ''
    expect(m).toContain('temp: true')
    expect(m).not.toContain('restorable')
    expect(m).not.toContain('hiddenByDefault')
  })
  test('the module never writes a setting or a saved tab', () => {
    expect(SRC).not.toMatch(/saveUiSetting|setSetting|saveConfig|localStorage|chrome\.storage|browser\.storage/)
  })
  test('the active tab is never persisted as vod', () => {
    expect(read('main-tabs.js')).toMatch(/id !== 'vod'/)
  })
  test('boot and every navigation sync the tab', () => {
    expect(read('main-live.js')).toMatch(/function bootSwitch\(\) \{[\s\S]*?vodSync\(\)/)
    expect(read('spa-nav.js')).toMatch(/vodSync\(\)/)
  })
  test('renderMessages reads the vod buffer', () => {
    expect(read('main-live.js')).toMatch(/id === 'vod'\) \{\s*msgs = vodBuffer/)
  })
  test("the pane counts a batched render by the rows it holds back, and the empty line is the vod's own", () => {
    const live = read('main-live.js')
    expect(live).toMatch(/newMessageCount \+= opts\?\.added \|\| 1/)
    expect(live).toMatch(/id === 'vod' \? vodEmptyText\(\) : t\('mc_no_messages'\)/)
  })
  test('the module is in the bundle, before spa-nav', () => {
    const b = readFileSync(join(ROOT, 'build.js'), 'utf8')
    expect(b.indexOf("'vod-replay.js'")).toBeGreaterThan(0)
    expect(b.indexOf("'vod-replay.js'")).toBeLessThan(b.indexOf("'spa-nav.js'"))
  })
})
