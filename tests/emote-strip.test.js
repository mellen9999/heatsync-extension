import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

// kick and youtube inputs hold plain text only: the emotes in what you typed show in a strip above the box
test('kick and yt mount the shared emote strip', () => {
  expect(read('chrome/shared-utils.js')).toMatch(/mountEmoteStrip,/)
  expect(read('chrome/kick-autocomplete-hook.js')).toMatch(/window\.HS\?\.mountEmoteStrip\(/)
  expect(read('chrome/youtube-content.js')).toMatch(/window\.HS\?\.mountEmoteStrip\(/)
})

for (const name of ['chrome', 'firefox']) {
  test(`${name}: shared-utils loads on kick before the autocomplete hook that mounts the strip`, () => {
    const cs = JSON.parse(read(`src/manifests/${name}.json`)).content_scripts
    const idx = (file) => cs.findIndex((c) => c.js?.includes(file) && c.matches.some((m) => m.includes('kick.com')))
    expect(idx('shared-utils.js')).toBeGreaterThanOrEqual(0)
    expect(idx('shared-utils.js')).toBeLessThan(idx('kick-autocomplete-hook.js'))
  })
}
