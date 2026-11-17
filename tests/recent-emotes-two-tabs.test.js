import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The page button's emote picker keeps its recents in memory and writes the whole
 * list on every pick. Two tabs open: a pick in one, then a pick in the other, used
 * to write the second tab's stale list over the first's pick. The tab now adopts
 * another tab's write. The real record function and storage handler run here.
 */
const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'content', 'heatsync-button.js'), 'utf8')
const cut = (a, b) => {
  const s = SRC.indexOf(a)
  return SRC.slice(s, SRC.indexOf(b, s))
}
const RECORD = cut('function recordRecentEmote(', '\n    // Fuzzy match scorer')
const ON_CHANGE = cut('function _onStorageChanged(', '\n    chrome.storage.onChanged.addListener(_onStorageChanged)')

function tab(store) {
  const chrome = { storage: { local: { set: (v) => store.write(v) } } }
  return new Function(
    'chrome',
    'mirrorUiSettings',
    `const RECENT_MAX = 30\nlet recentEmotes = []\n${RECORD}\n${ON_CHANGE}\nreturn { pick: (name) => recordRecentEmote({ name }), heard: _onStorageChanged }`,
  )(chrome, () => {})
}

test("a pick in one tab survives the other tab's next pick", () => {
  let stored = []
  const tabs = []
  const store = {
    write: (v) => {
      stored = v.recent_emotes
      for (const t of tabs) t.heard({ recent_emotes: { newValue: stored } }, 'local')
    },
  }
  tabs.push(tab(store), tab(store))
  tabs[0].pick('KEKW')
  tabs[1].pick('Pog')
  expect(stored.map((r) => r.name)).toEqual(['Pog', 'KEKW'])
})
