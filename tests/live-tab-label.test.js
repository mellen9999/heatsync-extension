import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const main = readFileSync(new URL('../src/multichat/main.js', import.meta.url), 'utf8')

// the channel tab beside "watching" already names the channel — the label
// stays one word, and the name rides the tooltip
test('the watching tab says only "watching" and keeps the channel in its title', () => {
  expect(main).toContain("liveTab.textContent = t('mc_tab_live')")
  expect(main).toContain('liveTab.title = name')
  expect(main).not.toContain('mc_tab_live_channel')
})
