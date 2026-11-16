/**
 * Kick keeps <video>s it never shows: its ad player sits hidden on every channel page, live or
 * offline, and in-page nav leaves the old page's player in a hidden copy. "Any <video> on the
 * page" read every offline kick channel as live within seconds (live dot lit, channel added to
 * the live set every 10s, 11-16), and the player guard measured a hidden video instead of the
 * one on screen. Runs the real shownVideo and playerEl from src/multichat/player-guard.js and
 * the real checkKickLive from src/multichat/main-storage.js.
 */
import { afterEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'

const read = (f) => readFileSync(join(import.meta.dir, '..', 'src', 'multichat', f), 'utf8')
const carve = (src, head, end) => {
  const s = src.indexOf(head)
  if (s === -1) throw new Error(`not found: ${head}`)
  return src.slice(s, src.indexOf(end, s) + end.length)
}
const GUARD = read('player-guard.js')
const STORAGE = read('main-storage.js')

let win
afterEach(() => win?.happyDOM.close())

/** A kick channel page: hidden ad player first in the DOM, then the page's own player, then the panel. */
function kickPage({ player }) {
  win = new Window()
  const document = win.document
  // the browser gives an element under display:none no boxes; happy-dom does no layout
  win.HTMLElement.prototype.getClientRects = function () {
    for (let e = this; e; e = e.parentElement) if (e.style?.getPropertyValue('display') === 'none') return []
    return [{ width: 1, height: 1 }]
  }
  document.body.innerHTML = `
    <div style="display: none;"><div class="ad"><video src="https://static.kick.com/ads/black_2s.mp4"></video></div></div>
    <div id="page"><div class="player">${player ? '<video id="live"></video>' : '<img alt="offline">'}</div></div>
    <div id="hs-mc-container"><div class="hs-mc-tab" data-tab="live"></div><div class="hs-mc-media"><video id="embed"></video></div></div>`
  const live = new Set()
  const api = new Function(
    'document',
    'tabBarElement',
    'getCurrentChannel',
    'liveChannelSet',
    'liveKey',
    `let kickLiveFound = false
     ${carve(GUARD, 'function shownVideo(', '\n}\n')}
     ${carve(GUARD, 'function playerEl(', '\n}\n')}
     ${carve(STORAGE, 'function checkKickLive(', '\n    }\n')}
     return { shownVideo, playerEl, checkKickLive, found: () => kickLiveFound }`,
  )(
    document,
    document.getElementById('hs-mc-container'),
    () => 'SomeChannel',
    live,
    (p, c) => `${p}/${c}`,
  )
  return { document, api, live, dot: () => document.querySelector('[data-tab="live"]').dataset.live }
}

test('an offline channel with only the hidden ad player reads offline', () => {
  const k = kickPage({ player: false })
  k.api.checkKickLive()
  expect(k.dot()).toBe('false')
  expect([...k.live]).toEqual([])
  expect(k.api.found()).toBe(false)
})

test('a live channel reads live from the player on screen', () => {
  const k = kickPage({ player: true })
  k.api.checkKickLive()
  expect(k.dot()).toBe('true')
  expect([...k.live]).toEqual(['kick/somechannel'])
  expect(k.api.found()).toBe(true)
})

test('the panel own media embeds never count as the page player', () => {
  const k = kickPage({ player: false })
  expect(k.api.shownVideo()).toBe(null)
})

test('a page kick hid on in-page nav keeps its player, which no longer counts', () => {
  const k = kickPage({ player: true })
  k.document.getElementById('page').setAttribute('style', 'display: none !important;')
  k.api.checkKickLive()
  expect(k.dot()).toBe('false')
})

test('the player guard measures the player on screen, not the hidden ad player before it', () => {
  const k = kickPage({ player: true })
  expect(k.api.playerEl()).toBe(k.document.querySelector('#page .player'))
})
