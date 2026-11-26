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

function load(path = '/videos/2934223993', { link = true, listHtml = '' } = {}) {
  win = new Window()
  const d = win.document
  d.body.innerHTML = `
    <div id="hs-mc-tabbar"><button data-tab="vod" style="display:none"></button></div>
    ${link ? '<div class="channel-info-content"><a href="/nl_kripp">kripp</a></div>' : ''}
    <div class="video-chat"><div class="video-chat__message-list-wrapper"><ol>${listHtml}</ol></div></div>`
  calls = []
  const timers = []
  const body = `
    let currentTab = 'feed'
    let _autoSwitching = false
    const hostPlatform = 'twitch'
    const SCROLLBACK_MAX = 5
    const location = LOC
    const tabBarElement = document.getElementById('hs-mc-tabbar')
    const twitchBadgeUrls = new Map([['subscriber/1', 'https://static-cdn.jtvnw.net/badges/v1/aaa-111/1'], ['nl_kripp:moderator/1', 'https://static-cdn.jtvnw.net/badges/v1/bbb-222/1']])
    const sanitizeColor = (c) => c
    const t = (k) => k
    function switchTab(id) { calls.push(['switch', id, _autoSwitching]); currentTab = id }
    function liveTarget() { return 'feed' }
    function mcIsReservedTab(id) { return ['feed', 'live', 'mentions'].includes(id) }
    function getChannelById(id) { return id === 'xqc' ? { id } : null }
    function appendMessage(m, tab) { calls.push(['append', tab, m.id]); return true }
    function renderMessages(tab) { calls.push(['render', tab, vodBuffer.map((m) => m.text)]) }
    function _dropTabCache(tab) { calls.push(['drop', tab]) }
    async function fetchGlobalBadges() {}
    async function fetchChannelBadges(c) { calls.push(['badges', c]) }
    const config = { channels: [{ id: 'xqc', twitch: 'xqc' }] }
    const joinExtraChannel = (p, c) => calls.push(['join', c])
    const leaveExtraChannel = (p, c) => calls.push(['leave', c])
    const safeSendMessage = (m) => { calls.push(['send', m.type, m.path]); return Promise.resolve(API(m)) }
    const cleanup = { setTimeout: (fn) => { timers.push(fn); return timers.length }, clearTimeout: () => {}, trackObserver() {}, untrackObserver() {} }
    ${SRC}
    return { vodSync, vodBuffer, vodRowToMsg, setTab: (x) => (currentTab = x), tab: () => currentTab }`
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
    'timers',
    'LOC',
    'API',
    body,
  )(d, (el) => win.getComputedStyle(el), MO, twitchPageKind, twitchVodId, calls, timers, loc, api)
  h.loc = loc
  h.timers = timers
  h.obsMade = obsMade
  h.list = () => d.querySelector('ol')
  h.add = (html) => d.querySelector('ol').insertAdjacentHTML('beforeend', html)
  h.runTimers = () => {
    for (const fn of timers.splice(0)) fn()
  }
}
const flush = () => new Promise((r) => setTimeout(r, 5))
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
  test('the module is in the bundle, before spa-nav', () => {
    const b = readFileSync(join(ROOT, 'build.js'), 'utf8')
    expect(b.indexOf("'vod-replay.js'")).toBeGreaterThan(0)
    expect(b.indexOf("'vod-replay.js'")).toBeLessThan(b.indexOf("'spa-nav.js'"))
  })
})
