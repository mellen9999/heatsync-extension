/**
 * An answer that comes back for a card lands on THAT card. The open card was told apart by name
 * only: the same name on another platform is another person, and a twitch answer filled the
 * kick card opened right after. A failed follow or block wrote its "undo" onto whatever card was
 * open by then, so someone else's card flipped to "not following".
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'profile-card.js'), 'utf8')
const fn = (name) => {
  const at = SRC.indexOf(`async function ${name}(`)
  return SRC.slice(at, SRC.indexOf('\n}\n', at) + 3)
}
const hintAt = SRC.indexOf('function pcKickNameHint(')
const HINT = SRC.slice(hintAt, SRC.indexOf('\n}\n', hintAt) + 3)

function cards() {
  const d = { answer: null, draws: 0 }
  d.scope = {
    activeProfileCard: null,
    apiFetch: () => new Promise((res) => (d.answer = res)),
    renderProfileCardView: () => d.draws++,
    _patchProfileCacheRel() {},
    showToast() {},
    safeSendMessage() {},
    expandUserAliasKeys: async () => [],
    _toggleMcBlock: async () => {},
    t: (k) => k,
  }
  const src = `${HINT}\n${fn('pcToggleFollow')}\n${fn('pcToggleBlock')}`
  Object.assign(d, new Function('scope', `with (scope) { ${src}\n return { pcToggleFollow, pcToggleBlock } }`)(d.scope))
  d.card = (rel) => ({ data: { relationship: { ...rel } }, platform: 'twitch' })
  return d
}

test('a follow that fails undoes itself on its own card', async () => {
  const d = cards()
  const a = (d.scope.activeProfileCard = d.card({ youFollow: false }))
  const p = d.pcToggleFollow('1', 'alice', false)
  expect(a.data.relationship.youFollow).toBe(true) // shown at once
  d.answer({ ok: false, error: 'boom' })
  await p
  expect(a.data.relationship.youFollow).toBe(false)
})

test('a follow that fails after another card was opened leaves that card alone', async () => {
  const d = cards()
  d.scope.activeProfileCard = d.card({ youFollow: false })
  const p = d.pcToggleFollow('1', 'alice', false)
  const b = (d.scope.activeProfileCard = d.card({ youFollow: true }))
  const draws = d.draws
  d.answer({ ok: false, error: 'boom' })
  await p
  expect(b.data.relationship.youFollow).toBe(true)
  expect(d.draws).toBe(draws)
})

test('a block that fails after another card was opened leaves that card alone', async () => {
  const d = cards()
  d.scope.activeProfileCard = d.card({ youBlock: false, isBlocked: false, youFollow: true })
  const p = d.pcToggleBlock('1', 'alice', false, 'twitch')
  const b = (d.scope.activeProfileCard = d.card({ youBlock: true, isBlocked: true }))
  d.answer({ ok: false, error: 'boom' })
  await p
  expect(b.data.relationship).toEqual({ youBlock: true, isBlocked: true })
})

test('the card fetch tells its card apart by the card, not by the name on it', () => {
  const at = SRC.indexOf('function openProfileCard(')
  const open = SRC.slice(at, SRC.indexOf('// Fetch kick.com/api/v1/users/{name}', at))
  expect(open).toContain('const open = activeProfileCard')
  expect(open.match(/if \(activeProfileCard !== open\) return/g)?.length).toBe(4)
  expect(open).not.toContain('activeProfileCard.username !== username')
})
