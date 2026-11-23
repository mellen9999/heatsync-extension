// a 7tv personal set is tagged `personal: true` when captured: the emote law reads those above the room
// (everything else a sender holds reads below it), and a tag nobody sets would quietly demote them.

import { expect, test } from 'bun:test'
import { bgSource } from './bg-src.js'

const SRC = bgSource()
const a = SRC.indexOf('async function capture7TVPersonalEntitlement(')
const body = SRC.slice(a, SRC.indexOf('\n}\n', a) + 3)

test('a captured 7tv personal set marks every entry personal', async () => {
  const run = new Function(
    'fetchWithTimeout',
    'stvCheckShape',
    'log',
    `const seventvPersonalSets = new Map()\nconst _stvSetFetchAt = new Map()\n${body}\nreturn { seventvPersonalSets, capture7TVPersonalEntitlement }`,
  )
  const set = { emotes: [{ id: '01ABCDEFGHJKMNPQRSTVWXYZ00', name: 'Donk', flags: 0, data: { animated: false } }] }
  const { seventvPersonalSets, capture7TVPersonalEntitlement } = run(
    async () => ({ ok: true, json: async () => set }),
    () => {},
    () => {},
  )
  await capture7TVPersonalEntitlement({
    object: { kind: 'EMOTE_SET', ref_id: 'set1', user: { connections: [{ platform: 'TWITCH', id: '123' }] } },
  })
  const got = seventvPersonalSets.get('123')
  expect(got.Donk.personal).toBe(true)
  expect(got.Donk.source).toBe('7tv')
})
