import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { bgSource } from './bg-src.js'

// The per-site overlay switch (popup, the page's way back, the overlay's own
// hs-off) wrote chrome.storage.sync alone. The boot merge then pulled the
// server's ui_state — which never heard of the change — over it, so the
// switch flipped back on the next load. Every write now goes through the
// service worker, which stores it and sends the same ui-state:sync patch the
// settings page's writes ride.
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const BG = bgSource()

function extractFn(name) {
  const start = BG.indexOf(`function ${name}(`)
  if (start === -1) throw new Error(`${name} not found in background.js`)
  return BG.slice(start, BG.indexOf('\n}', start) + 2)
}
const gatesLine = BG.match(/^const SITE_OVERLAY_GATES\s*=.*$/m)?.[0]
const siteOverlayMerge = new Function(`${gatesLine}\n${extractFn('siteOverlayMerge')}\nreturn siteOverlayMerge`)()

test('merges one site into the stored map, keeping every other key', () => {
  const ui = { zebra: true, subsystems: { 'overlay-kick': false } }
  expect(siteOverlayMerge(ui, 'overlay-twitch', false)).toEqual({
    zebra: true,
    subsystems: { 'overlay-kick': false, 'overlay-twitch': false },
  })
  expect(ui.subsystems).toEqual({ 'overlay-kick': false })
})

test('refuses anything that is not a site overlay gate', () => {
  expect(siteOverlayMerge({}, 'feed', false)).toBeNull()
  expect(siteOverlayMerge({}, '__proto__', false)).toBeNull()
})

test('the popup and the page helper write through the service worker only', () => {
  const popup = read('chrome/popup.js')
  expect(popup).toContain("type: 'site_overlay_set'")
  expect(popup).not.toContain('storage.sync.set')
  const shared = read('chrome/shared-utils.js')
  const fn = shared.slice(shared.indexOf('async function setSiteOverlay('))
  expect(fn.slice(0, 600)).toContain("type: 'site_overlay_set'")
})
