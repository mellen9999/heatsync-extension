/**
 * The logs list holds 500 rows. A reader paging back gets older rows at the bottom and the
 * newest ones are let go at the top: right, but nothing said so. Scrolled back up, the list
 * began 100 lines into the past as if that were the newest line, and an export had the same hole.
 * The list now knows it was cut, says so at its top, and one press starts it from the newest.
 *
 * Runs the real fetchChatLogsPage and refreshChatLogs against an archive of numbered lines.
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'chat-logs.js'), 'utf8')
const fn = (name) => {
  const s = SRC.indexOf(`function ${name}(`)
  if (s < 0) throw new Error(`carve: ${name}`)
  return SRC.slice(SRC.lastIndexOf('\n', s) + 1, SRC.indexOf('\n}\n', s) + 3)
}

function logs(total) {
  // newest first, as the archive answers
  const archive = Array.from({ length: total }, (_, i) => ({ id: i, message: `line ${i}` }))
  const scope = {
    HS_CL_PAGE: 100,
    activeChatLogs: {
      platform: 'twitch',
      username: 'someone',
      channel: null,
      rows: [],
      cursor: null,
      loading: false,
      exhausted: false,
    },
    renders: 0,
    renderChatLogsView: () => scope.renders++,
    apiFetch: async (path) => {
      const q = new URLSearchParams(path.split('?')[1])
      const at = Number(q.get('cursor') || 0)
      const results = archive.slice(at, at + 100)
      return { ok: true, data: { results, next_cursor: at + 100 < total ? String(at + 100) : null } }
    },
  }
  const api = new Function(
    'scope',
    `with (scope) { ${fn('fetchChatLogsPage')}\n${fn('refreshChatLogs')}\n return { fetchChatLogsPage, refreshChatLogs } }`,
  )(scope)
  return { ...api, st: scope.activeChatLogs }
}

test('five pages fit: the list starts at the newest line and is not marked', async () => {
  const l = logs(2000)
  for (let i = 0; i < 5; i++) await l.fetchChatLogsPage()
  expect(l.st.rows).toHaveLength(500)
  expect(l.st.rows[0].id).toBe(0)
  expect(l.st.cut).toBeFalsy()
})

test('the sixth page lets the newest hundred go, and the list knows', async () => {
  const l = logs(2000)
  for (let i = 0; i < 6; i++) await l.fetchChatLogsPage()
  expect(l.st.rows).toHaveLength(500)
  expect(l.st.rows[0].id).toBe(100)
  expect(l.st.rows.at(-1).id).toBe(599)
  expect(l.st.cut).toBe(true)
})

test('a refresh starts from the newest line again, unmarked', async () => {
  const l = logs(2000)
  for (let i = 0; i < 7; i++) await l.fetchChatLogsPage()
  expect(l.st.cut).toBe(true)
  await l.refreshChatLogs()
  expect(l.st.rows[0].id).toBe(0)
  expect(l.st.rows).toHaveLength(100)
  expect(l.st.cut).toBe(false)
})

test('the view draws the mark at the top of the list, and pressing it is a refresh', () => {
  const draw = SRC.slice(SRC.indexOf('function renderChatLogsView() {'))
  const mark = draw.indexOf('if (activeChatLogs.cut) {')
  expect(mark).toBeGreaterThan(0)
  expect(mark).toBeLessThan(draw.indexOf('for (const r of rows) list.appendChild(clRow(r))'))
  expect(draw.slice(mark, mark + 400)).toContain("newer.addEventListener('click', refreshChatLogs)")
  // a search answer is a list of its own
  const search = fn('searchChatLogs')
  expect(search).toContain('state.cut = false')
})
