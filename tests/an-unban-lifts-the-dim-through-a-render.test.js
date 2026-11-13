/**
 * A render greys any drawn row whose line its buffer holds removed (a leg that
 * folded into another platform's row has no row of its own to grey). So a twitch
 * unban must lift the ban from the buffer, as kick's does, or the next render
 * greys the line the unban just lifted. A deleted line stays deleted.
 *
 * The branch is lifted from irc.js and run on a fake buffer: irc.js is a bundle
 * fragment, the idiom youtube-deletion.test.js uses.
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'irc.js'), 'utf8')
const HEAD = "if (msg.noticeType === 'unban_success' && msg.targetUser) {"

function liftBranch() {
  const at = SRC.indexOf(HEAD)
  if (at === -1) throw new Error('unban branch not found')
  let depth = 0
  for (let i = SRC.indexOf('{', at); i < SRC.length; i++) {
    if (SRC[i] === '{') depth++
    else if (SRC[i] === '}' && --depth === 0) return new Function('msg', 'buf', SRC.slice(at, i + 1))
  }
  throw new Error('unbalanced')
}

test('a twitch unban lifts the ban from the buffer, never a delete, never someone else', () => {
  const notice = { type: 'notice', noticeType: 'timeout_success', targetUser: 'Bob' }
  const banned = { user: 'Bob', text: 'a', cleared: true, clearedReason: 'timed out (600s)' }
  const deleted = { user: 'bob', text: 'b', cleared: true, clearedReason: 'deleted' }
  const other = { user: 'alice', text: 'c', cleared: true, clearedReason: 'banned' }
  liftBranch()(
    { type: 'notice', noticeType: 'unban_success', targetUser: 'bob' },
    { getAll: () => [notice, banned, deleted, other] },
  )
  expect(notice._supersededByUnban).toBe(true)
  expect(banned.cleared).toBe(false)
  expect(banned.clearedReason).toBeUndefined()
  expect(deleted.cleared).toBe(true)
  expect(other.cleared).toBe(true)
})

test('the render greys a drawn row whose line was removed, only under dim', () => {
  const live = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'main-live.js'), 'utf8')
  expect(live).toMatch(/dimTimeouts && _rm\?\.cleared && !placed\.classList\.contains\('hs-mc-msg-cleared'\)/)
})
