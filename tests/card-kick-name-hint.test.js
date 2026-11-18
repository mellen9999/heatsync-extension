/**
 * A follow or a block of a kick chatter from the card. The account is `kick_<id>`, and the server
 * cannot find a kick profile by id alone: without the row's name a chatter who never signed up
 * answered "user not found". The follow sent the name; the block did not.
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'profile-card.js'), 'utf8')
const cut = (name) => {
  const at = SRC.indexOf(`function ${name}(`)
  const from = SRC.lastIndexOf('\n', SRC.lastIndexOf('async', at) > at - 7 ? at - 7 : at) + 1
  return SRC.slice(from, SRC.indexOf('\n}\n', at) + 3)
}

function card() {
  const calls = []
  const scope = {
    apiFetch: async (path, opts) => {
      calls.push([opts.method, path])
      return { ok: true }
    },
    activeProfileCard: null,
    renderProfileCardView() {},
    _patchProfileCacheRel() {},
    showToast() {},
    t: (k) => k,
    _toggleMcBlock: async () => {},
    refreshBlockedSet() {},
    console,
  }
  const src = `${cut('pcKickNameHint')}\n${cut('pcToggleFollow')}\n${cut('pcToggleBlock')}`
  const fns = new Function(
    'scope',
    `with (scope) { ${src}\n return { pcKickNameHint, pcToggleFollow, pcToggleBlock } }`,
  )(
    new Proxy(scope, {
      has: (o, k) => k in o || (typeof k === 'string' && !(k in globalThis)),
      get: (o, k) => (k in o ? o[k] : () => {}),
    }),
  )
  return { calls, ...fns }
}

test('the hint: a kick_<id> account with a name, and nothing else', () => {
  const { pcKickNameHint } = card()
  expect(pcKickNameHint('kick_123', 'Some Name')).toBe('?kickUsername=Some%20Name')
  expect(pcKickNameHint('kick_123', '')).toBe('')
  expect(pcKickNameHint('123', 'name')).toBe('') // a twitch account
  expect(pcKickNameHint('yt_UCabc-def', 'name')).toBe('')
  expect(pcKickNameHint('kick_12x', 'name')).toBe('')
})

test('blocking a kick chatter sends the name, as following one does', async () => {
  const c = card()
  await c.pcToggleBlock('kick_42', 'chatter', false, 'kick')
  await c.pcToggleFollow('kick_42', 'chatter', false)
  expect(c.calls).toEqual([
    ['POST', '/api/user/block/kick_42?kickUsername=chatter'],
    ['POST', '/api/follow/kick_42?kickUsername=chatter'],
  ])
})

test('taking either back needs no name, and a twitch account never gets one', async () => {
  const c = card()
  await c.pcToggleBlock('kick_42', 'chatter', true, 'kick')
  await c.pcToggleFollow('kick_42', 'chatter', true)
  await c.pcToggleBlock('777', 'chatter', false, 'twitch')
  expect(c.calls).toEqual([
    ['DELETE', '/api/user/block/kick_42?sync_twitch=0'],
    ['DELETE', '/api/follow/kick_42'],
    ['POST', '/api/user/block/777'],
  ])
})
