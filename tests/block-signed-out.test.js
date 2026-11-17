import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Block from a chatter's menu or card. Every twitch chatter resolves to a heatsync
 * profile, so the block goes to the account; signed out, the server answers 401 and
 * the block used to end there ("block failed"), leaving no way to block anyone. It now
 * stays in this browser instead, the way a mute does. pcToggleBlock runs for real.
 */
const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'profile-card.js'), 'utf8')
const s = SRC.indexOf('async function pcToggleBlock(')
const BODY = SRC.slice(s, SRC.indexOf('\nfunction pcDoWhisper', s))

function harness(resp) {
  const calls = { local: [], toasts: [], sent: [] }
  const fn = new Function(
    'apiFetch',
    '_toggleMcBlock',
    'showToast',
    'safeSendMessage',
    '_patchProfileCacheRel',
    'renderProfileCardView',
    'expandUserAliasKeys',
    't',
    `let activeProfileCard = null\n${BODY}\nreturn pcToggleBlock`,
  )(
    async () => resp,
    async (u, p) => calls.local.push([u, p]),
    (m, type) => calls.toasts.push(type),
    (m) => calls.sent.push(m.type),
    () => {},
    () => {},
    async (u, p) => [`${p}:${u}`],
    (k) => k,
  )
  return { block: fn, calls }
}

describe('a block while signed out', () => {
  test('stays in this browser, for the platform the name came from', async () => {
    const { block, calls } = harness({ ok: false, status: 401, error: 'unauthorized' })
    await block('536754551', 'luzif6r', false, 'twitch')
    expect(calls.local).toEqual([['luzif6r', 'twitch']])
    expect(calls.toasts).not.toContain('error')
  })

  test('any other refusal still says it failed, nothing saved locally', async () => {
    const { block, calls } = harness({ ok: false, status: 500, error: 'boom' })
    await block('1', 'bob', false, 'twitch')
    expect(calls.local).toEqual([])
    expect(calls.toasts).toEqual(['error'])
  })

  test('signed in: the account block, and the live hide for its platform', async () => {
    const { block, calls } = harness({ ok: true })
    await block('1', 'bob', false, 'kick')
    expect(calls.local).toEqual([])
    expect(calls.sent).toContain('block_user')
  })
})
