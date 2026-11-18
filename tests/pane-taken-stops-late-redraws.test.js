/**
 * One pane, many views. A tab's renderer that runs late (a fetch answer, a refresh timer, a
 * setting echoed back from storage, a search result) must not paint over what took the pane
 * since: a card, a confirm panel, the prediction view, a full-size picture, the edit-channel
 * form. Each renderer had its own partial list of those (settings had none: a setting synced
 * from another device rebuilt the tab under its own "are you sure"), so they ask one question.
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (f) => readFileSync(join(import.meta.dir, '..', 'src', 'multichat', f), 'utf8')
const PANEL = read('pane-panel.js')
const at = PANEL.indexOf('function hsPaneTaken() {')
const TAKEN = PANEL.slice(at, PANEL.indexOf('\n}\n', at) + 3)

const taken = (state) =>
  new Function(
    'hsPanePanelOpen',
    'activeProfileCard',
    'predViewOpen',
    'imgViewOpen',
    'editingChannel',
    `${TAKEN}\nreturn hsPaneTaken()`,
  )(
    () => !!state.panel,
    state.card || null,
    () => !!state.pred,
    () => !!state.img,
    !!state.editing,
  )

test('the pane is taken by a panel, a card, the prediction view, a picture or the edit form', () => {
  expect(taken({})).toBe(false)
  for (const what of ['panel', 'card', 'pred', 'img', 'editing'])
    expect([what, taken({ [what]: {} })]).toEqual([what, true])
})

test('every tab renderer that can run late asks before it touches the pane', () => {
  const head = (file, name, lines = 6) => {
    const src = read(file)
    const i = src.indexOf(`function ${name}(`)
    expect([name, i > -1]).toEqual([name, true])
    return src.slice(i).split('\n').slice(0, lines).join('\n')
  }
  for (const [file, name] of [
    ['social.js', 'renderFeed'],
    ['social.js', 'renderDiscoverTab'],
    ['social.js', 'renderPinnedTab'],
    ['whispers.js', 'renderWhispersTab'],
    ['settings-ui.js', 'renderSettingsTab'],
    ['main-overlay.js', 'renderSearchResults'],
  ]) {
    const h = head(file, name)
    expect([name, h.includes('if (hsPaneTaken()) return')]).toEqual([name, true])
    // and asks BEFORE anything is wiped
    const wipe = h.search(/textContent = ''|innerHTML =|_clearMessageIndices\(\)/)
    expect([name, wipe === -1 || h.indexOf('hsPaneTaken()') < wipe]).toEqual([name, true])
  }
  // the feed's "could not load" line is written after an await, outside renderFeed
  expect(read('social.js')).toContain("if (currentTab === 'feed' && !hsPaneTaken()) {")
})

test('a tab switch closes the prediction view with the card, before the old tab is cached', () => {
  const tabs = read('main-tabs.js')
  const drop = tabs.indexOf('if (_predWasOpen) predViewDrop()')
  const cache = tabs.indexOf('_dropTabCache(currentTab)', drop)
  const flip = tabs.indexOf('currentTab = id', drop)
  expect(drop).toBeGreaterThan(-1)
  expect(cache).toBeGreaterThan(drop)
  expect(flip).toBeGreaterThan(cache) // while currentTab is still the tab that showed it
  const pred = read('pred-view.js')
  const d = pred.indexOf('function predViewDrop() {')
  expect(pred.slice(d, pred.indexOf('\n}\n', d))).toContain('activePredView = null')
})
