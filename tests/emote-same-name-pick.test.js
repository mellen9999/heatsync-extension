// Many emotes share one name (a channel's AYAYA, kick's AYAYA, the 7tv variant a chatter collected).
// The one the sender actually picked rides the message as a server-verified ref, so it must be looked
// up BEFORE the channel's same-name emote — otherwise a chosen variant renders as whatever the room
// happens to have. Names the message carries no ref for still resolve channel-first.
// processEmotes can't be imported on its own (host-page scope), so this is a source-level guard.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const emotes = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'emotes.js'), 'utf8')
const lookup = emotes.slice(
  emotes.indexOf('const _lookup = (name) => {'),
  emotes.indexOf('// Kick emote splits gated by indexOf'),
)

describe('same-name emote pick', () => {
  test("the message's own ref is looked up before the channel's emote", () => {
    const ref = lookup.indexOf('msgRefs?.get(name)')
    const channel = lookup.indexOf('channelEmoteCaches[channel]?.get(raw)')
    expect(ref).toBeGreaterThan(-1)
    expect(channel).toBeGreaterThan(-1)
    expect(ref).toBeLessThan(channel)
  })

  test('with no ref for a name, the channel still wins over the sender set and globals', () => {
    const channel = lookup.indexOf('channelEmoteCaches[channel]?.get(raw)')
    const sender = lookup.indexOf('_sGet(raw)')
    const globals = lookup.indexOf('emoteCache.get(raw)')
    expect(channel).toBeLessThan(sender)
    expect(sender).toBeLessThan(globals)
  })
})
