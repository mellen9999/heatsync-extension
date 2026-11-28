/**
 * M12: when you mod the room, the row menu opens with delete / timeout / ban / pin at the top,
 * above follow, block, copy. Runs the real openUserCtxMenu (sliced out of input.js) against a
 * stubbed page: every global it names is a no-op unless the test sets it.
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'input.js'), 'utf8')
const SLICE = SRC.slice(SRC.indexOf('function openUserCtxMenu('), SRC.indexOf('// Expand a username/platform pair'))

function labelsFor({ mod }) {
  let shown = null
  const over = {
    t: (k) => k,
    showHsCtxMenu: (_x, _y, _h, items) => {
      shown = items
    },
    isModForSync: () => mod,
    isKickModForSync: () => false,
    isYtModForSync: () => false,
    isSelf: () => false,
    isUserBlocked: () => false,
    isUserMuted: () => false,
    getChannelLookup: () => null,
    gateAtBoot: () => true,
    resolveIdentity: undefined,
    pinRoomOfRow: () => null,
    modToolsItem: () => ({ label: 'mod tools' }),
  }
  const scope = new Proxy(over, {
    has: (_, k) => typeof k === 'string' && k !== 'items' && k !== 'msg',
    get: (o, k) => (k in o ? o[k] : k === 'document' ? document : () => undefined),
  })
  const row = { dataset: { msgId: 'm1', msgChannel: 'chan', msgPlatform: 'twitch', msgLogin: 'viewer', msgUser: 'viewer' } }
  const run = new Function('scope', `with (scope) { ${SLICE}; return openUserCtxMenu }`)(scope)
  run(0, 0, 'viewer', 'twitch', { msg: row })
  return shown.map((i) => (i === 'sep' ? '-' : i.label))
}

test('as a mod: delete, timeout, ban lead the menu', () => {
  const l = labelsFor({ mod: true })
  expect(l.slice(0, 3)).toEqual(['mc_input_delete_msg', 'mc_input_timeout_10m', 'content_card_ban'])
  expect(l.indexOf('mc_input_delete_msg')).toBeLessThan(l.indexOf('content_card_follow'))
  expect(l.indexOf('content_card_ban')).toBeLessThan(l.indexOf('mc_input_copy_message'))
  expect(l.filter((x) => x === 'mc_input_delete_msg').length).toBe(1)
})

test('not a mod: the menu starts with follow, no mod rows', () => {
  const l = labelsFor({ mod: false })
  expect(l[0]).toBe('content_card_follow')
  expect(l).not.toContain('mc_input_delete_msg')
  expect(l).not.toContain('content_card_ban')
})

test('a separator sits between the mod block and the person rows', () => {
  const l = labelsFor({ mod: true })
  expect(l[l.indexOf('content_card_follow') - 1]).toBe('-')
})
