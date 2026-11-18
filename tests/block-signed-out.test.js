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
const h = SRC.indexOf('function pcKickNameHint(')
const HINT = SRC.slice(h, SRC.indexOf('\n}\n', h) + 3) // the name a kick account's block carries
const BODY = HINT + SRC.slice(s, SRC.indexOf('\nfunction pcDoWhisper', s))

function harness(resp, card = null) {
  const calls = { local: [], toasts: [], sent: [], order: [] }
  const fn = new Function(
    'apiFetch',
    '_toggleMcBlock',
    'showToast',
    'safeSendMessage',
    '_patchProfileCacheRel',
    'renderProfileCardView',
    'expandUserAliasKeys',
    't',
    'activeProfileCard',
    `${BODY}\nreturn pcToggleBlock`,
  )(
    async () => resp,
    async (u, p) => {
      calls.local.push([u, p])
      calls.order.push('block set')
    },
    (_m, type) => calls.toasts.push(type),
    (m) => calls.sent.push(m.type),
    () => {},
    () => calls.order.push(`draw ${JSON.stringify(card?.data?.relationship)}`),
    async (u, p) => [`${p}:${u}`],
    (k) => k,
    card,
  )
  return { block: fn, calls }
}

// the card's own answer to "is this person blocked"
const IS = SRC.slice(SRC.indexOf('function pcIsBlocked('), SRC.indexOf('\nfunction renderProfileCardView'))
const isBlockedWith = (local) =>
  new Function('isUserBlocked', `${IS}\nreturn pcIsBlocked`)((u, p) => local.includes(`${p}:${u}`))

describe('a block while signed out', () => {
  test('stays in this browser, for the platform the name came from', async () => {
    const { block, calls } = harness({ ok: false, status: 401, error: 'unauthorized' })
    await block('536754551', 'luzif6r', false, 'twitch')
    expect(calls.local).toEqual([['luzif6r', 'twitch']])
    expect(calls.toasts).not.toContain('error')
  })

  test('the open card is drawn last, from the block set: it had kept offering "block"', async () => {
    const card = { data: { relationship: {} } }
    const { block, calls } = harness({ ok: false, status: 401, error: 'unauthorized' }, card)
    await block('536754551', 'luzif6r', false, 'twitch')
    // first the optimistic word, then the block set changes, then the card is drawn
    // with no account block claimed in either direction
    expect(calls.order.at(-2)).toBe('block set')
    expect(calls.order.at(-1)).toBe('draw {"youBlock":false,"isBlocked":false,"youFollow":false,"isFollowing":false}')
  })

  test('the card reads a block kept in this browser as blocked, so the next press unblocks', () => {
    const blocked = isBlockedWith(['twitch:luzif6r'])
    expect(blocked({}, 'luzif6r', 'twitch')).toBe(true)
    expect(blocked({}, 'someone', 'twitch')).toBe(false)
    expect(blocked({ isBlocked: true }, 'someone', 'twitch')).toBe(true)
    expect(blocked({ youBlock: true }, 'someone', 'kick')).toBe(true)
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
