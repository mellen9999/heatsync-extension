// an inventory poll may drop owner-tier entries you no longer hold, never the channel's
// ffz/7tv/bttv/twitch/kick emotes, and nothing at all off your own channel.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(import.meta.dir, '..', 'chrome', 'content.js'), 'utf8')
const fn = (name) => {
  const i = src.indexOf(`  function ${name}(`)
  const j = src.indexOf('\n  }\n', i)
  return src.slice(i, j + 4)
}
const pruneOwnerTier = new Function(`${fn('pruneOwnerTier')}; return pruneOwnerTier`)()

test('sourced channel emotes survive an inventory poll', () => {
  const channel = [
    { name: 'A', hash: 'a' },
    { name: 'GONE', hash: 'g' },
    { name: 'KEKW', hash: 'k', source: '7tv' },
    { name: 'Pog', hash: 'p', source: 'bttv' },
  ]
  const out = pruneOwnerTier(channel, [{ hash: 'a' }])
  expect(out.map((e) => e.name)).toEqual(['A', 'KEKW', 'Pog'])
})

test('the poll handler only prunes on your own channel', () => {
  expect(src).toMatch(/channelEmotes\.length > 0 && isOwnChannelPage\(\)/)
  expect(src).not.toMatch(/channelEmotes\.filter\(\(e\) => inventoryHashes\.has\(e\.hash\)\)/)
})
