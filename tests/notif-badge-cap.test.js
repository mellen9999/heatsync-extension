// the server counts unread notifications up to 201 and the site's nav badge says
// "200+" past 200 — the toolbar badge says the same, never "201" or a bigger local tally.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ws = readFileSync(join(import.meta.dir, '..', 'src', 'background', '05-ws.js'), 'utf8')

function fn(src, header) {
  const at = src.indexOf(header)
  if (at < 0) throw new Error(`no ${header}`)
  let i = src.indexOf('{', src.indexOf(')', at))
  let depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1)
  }
  throw new Error('unbalanced')
}

function badgeFor(live, notifs) {
  const texts = []
  const badgeApi = { setBadgeText: async ({ text }) => texts.push(text), setBadgeBackgroundColor: async () => {} }
  const run = new Function(
    'badgeApi',
    '_liveFollowedCount',
    'unreadNotifCount',
    `${fn(ws, 'function recomputeBadge(')}\nrecomputeBadge()`,
  )
  run(badgeApi, live, notifs)
  return texts.at(-1)
}

test('the notification badge reads the count up to 200, then 200+', () => {
  expect(badgeFor(0, 7)).toBe('7')
  expect(badgeFor(0, 200)).toBe('200')
  expect(badgeFor(0, 201)).toBe('200+')
  expect(badgeFor(0, 950)).toBe('200+')
  expect(badgeFor(0, 0)).toBe('')
})
