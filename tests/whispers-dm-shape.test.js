/**
 * The whispers tab read resp.data as an array, but the site returns
 * { conversations: [...] } (list) and { messages: [...] } (thread), so the
 * DM backfill was always empty. Fixtures mirror server/routes/dm.ts.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'whispers.js'), 'utf8')
const start = SRC.indexOf('function whisperConversations(data) {')
const end = SRC.indexOf('function renderWhispersTab() {', start)
const { whisperConversations, whisperThreadMessages } = new Function(
  `${SRC.slice(start, end)}\nreturn { whisperConversations, whisperThreadMessages }`,
)()

const LIST = {
  conversations: [
    {
      id: '9',
      content: 'hi',
      emote_refs: null,
      is_read: false,
      created_at: '2026-09-29T00:00:00.000Z',
      other_user_id: 'hs_2',
      from_user_id: 'hs_2',
      to_user_id: 'hs_1',
      display_name: 'Alice',
      username: 'alice',
      user_color: '#ff8700',
      unread_count: 1,
    },
  ],
}
const THREAD = {
  messages: [
    {
      id: '9',
      from_user_id: 'hs_2',
      content: 'hi',
      from_display_name: 'Alice',
      created_at: '2026-09-29T00:00:00.000Z',
    },
  ],
  otherUser: null,
  total: 1,
  hasMore: false,
}

describe('whispers dm shapes', () => {
  test('reads the conversations list', () => {
    expect(whisperConversations(LIST)).toHaveLength(1)
    expect(whisperConversations(LIST)[0].other_user_id).toBe('hs_2')
  })
  test('reads the thread messages', () => {
    expect(whisperThreadMessages(THREAD)[0].content).toBe('hi')
  })
  test('defensive on missing or odd payloads', () => {
    for (const bad of [undefined, null, {}, [], { conversations: null }, { conversations: 'x' }]) {
      expect(whisperConversations(bad)).toEqual([])
    }
    for (const bad of [undefined, null, {}, [], { messages: 5 }]) expect(whisperThreadMessages(bad)).toEqual([])
  })
})
