import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { SETTINGS } from '../src/lib/settings-schema.js'
import { RETIRED_UI_KEYS } from '../src/lib/utils.js'

// The emote picker had a second settings panel that wrote chrome.storage.sync
// alone (the boot merge reverted it) and duplicated the overlay's own rows.
// It is gone; its one key with an overlay twin maps onto that twin.
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

test('the picker no longer writes settings at all', () => {
  const src = read('src/content/heatsync-button.js')
  for (const s of [
    'renderSettings',
    'saveExtensionSettings',
    'storage.sync.set',
    'ui_settings_rmw',
    'heatsync-settings-btn',
  ])
    expect(src).not.toContain(s)
})

test('emoteWysiwyg maps onto wysiwygEnabled', () => {
  const def = SETTINGS.find((d) => d.key === 'wysiwygEnabled')
  expect(def.legacy({ emoteWysiwyg: false }, {})).toBe(false)
  expect(def.legacy({}, {})).toBeUndefined()
  const hook = read('src/content/autocomplete-hook.js')
  expect(hook).not.toContain('emoteWysiwyg')
  expect(hook).toContain('settings.wysiwygEnabled')
})

test('the panel keys are retired', () => {
  for (const k of [
    'emoteWysiwyg',
    'emoteSpaceAfter',
    'rightClickBlockMode',
    'hideChatHeader',
    'compactChatInput',
    'highlightMentions',
    'showCosmetics',
  ])
    expect(RETIRED_UI_KEYS.has(k)).toBe(true)
})

test('nothing reads them any more', () => {
  const content = read('src/content/content.js')
  for (const k of ['hideChatHeader', 'highlightMentions', 'showCosmetics', 'rightClickBlockMode'])
    expect(content).not.toMatch(new RegExp(`\\b${k}\\b`))
})
