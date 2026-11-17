import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'

/**
 * A native emote (twitch sub / kick channel emote) is blocked by name with a right-click, and the
 * names live in one stored list. Each tab wrote its own copy of the list back, as old as the
 * tab's load: block one name in tab A, another in tab B, and A's was gone. And a tab never
 * heard of a name blocked elsewhere until it was reloaded. The toggle now builds on the stored
 * list and every tab follows the change. Both helpers run for real, on a real page.
 */
const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'content', 'content.js'), 'utf8')
const s = SRC.indexOf('  const NATIVE_EMOTE_IMG =')
const HELPERS = SRC.slice(s, SRC.indexOf('\n  // Tracks user-initiated block/unblock', s))

function tab(doc, own = []) {
  return new Function(
    'document',
    `let localBlockedEmoteNames = new Set(${JSON.stringify(own)})
     ${HELPERS}
     return { blockedNamesWith, applyBlockedEmoteNames, names: () => [...localBlockedEmoteNames] }`,
  )(doc)
}
const page = (...alts) => {
  const doc = new Window().document
  for (const alt of alts) {
    const im = doc.createElement('img')
    im.setAttribute('src', 'https://static-cdn.jtvnw.net/emoticons/v2/1/default/dark/1.0')
    im.setAttribute('alt', alt)
    doc.body.appendChild(im)
  }
  return doc
}
const marked = (doc) => [...doc.querySelectorAll('img[data-hs-name-blocked]')].map((i) => i.getAttribute('alt'))

test('two tabs each block a name: both names are kept', () => {
  let stored = []
  const a = tab(page())
  const b = tab(page()) // loaded before a blocked anything: its own copy is empty
  stored = a.blockedNamesWith(stored, 'Kappa', true)
  stored = b.blockedNamesWith(stored, 'LUL', true)
  expect(stored.sort()).toEqual(['Kappa', 'LUL'])
})

test('an unblock takes one name out of the stored list and leaves the rest', () => {
  const t = tab(page())
  expect(t.blockedNamesWith(['Kappa', 'LUL', 'PogChamp'], 'LUL', false)).toEqual(['Kappa', 'PogChamp'])
  expect(t.blockedNamesWith(['Kappa'], 'Kappa', true)).toEqual(['Kappa'])
  expect(t.blockedNamesWith(undefined, 'Kappa', true)).toEqual(['Kappa'])
  expect(t.blockedNamesWith(['Kappa', 7, null, ''], 'LUL', true)).toEqual(['Kappa', 'LUL'])
})

test('a list written by another tab marks and unmarks the emotes on this page', () => {
  const doc = page('Kappa', 'LUL', 'Kappa')
  const t = tab(doc)
  t.applyBlockedEmoteNames(['Kappa'])
  expect(marked(doc)).toEqual(['Kappa', 'Kappa'])
  expect(t.names()).toEqual(['Kappa'])
  t.applyBlockedEmoteNames(['LUL'])
  expect(marked(doc)).toEqual(['LUL'])
  t.applyBlockedEmoteNames(undefined)
  expect(marked(doc)).toEqual([])
})

test('the right-click reads the stored list first, and the storage listener applies a change', () => {
  const at = SRC.indexOf("'native-twitch-block-contextmenu'")
  const handler = SRC.slice(SRC.lastIndexOf("'contextmenu'", at), at)
  expect(handler).toMatch(
    /storage\.local\.get\('local_blocked_emote_names'\)[\s\S]*blockedNamesWith\(stored, name, blocking\)[\s\S]*storage\.local\.set/,
  )
  expect(handler).not.toContain('Array.from(localBlockedEmoteNames)')
  const l = SRC.indexOf('function _onStorageChanged(')
  expect(SRC.slice(l, SRC.indexOf('chrome.storage.onChanged.addListener(_onStorageChanged)', l))).toContain(
    'applyBlockedEmoteNames(changes.local_blocked_emote_names.newValue)',
  )
})
