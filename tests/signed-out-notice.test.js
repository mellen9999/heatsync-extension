/**
 * Signed-out notice: background.js noteSignedOut/noteSignedIn fire ONE
 * 'signed_out_notice' broadcast per browser session after a login lapse, never
 * for users who never signed in. Functions are extracted from the real source
 * (same marker pattern as background-helpers.test.js) and run against stubs.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('../chrome/background.js', import.meta.url), 'utf8')
const start = SRC.indexOf('function signedOutNoticeDue(')
const end = SRC.indexOf('function fetchEmoteInventory(')
if (start === -1 || end === -1) throw new Error('signed-out block markers missing in chrome/background.js')
const BLOCK = SRC.slice(start, end)

function mk({ local = {}, session = {}, inventory = [], tabs = [{ id: 1 }] } = {}) {
  const sent = []
  const browser = {
    tabs: {
      sendMessage: async (id, m) => {
        if (!env.tabs.length) throw new Error('no receiver')
        sent.push(m)
      },
    },
    storage: {
      local: {
        get: async () => ({ ...local }),
        set: async (o) => Object.assign(local, o),
      },
      session: {
        get: async () => ({ ...session }),
        set: async (o) => Object.assign(session, o),
        remove: async (k) => {
          delete session[k]
        },
      },
    },
  }
  const env = { emoteInventory: inventory, tabs }
  const api = new Function(
    'browser',
    'env',
    `const getMatchingTabs = async () => env.tabs
     const emoteInventory = env.emoteInventory
     ${BLOCK}
     return { signedOutNoticeDue, noteSignedOut, noteSignedIn }`,
  )(browser, env)
  return { api, sent, local, session, env }
}

describe('signedOutNoticeDue', () => {
  const { api } = mk()
  test('needs prior sign-in and not already shown', () => {
    expect(api.signedOutNoticeDue(true, false)).toBe(true)
    expect(api.signedOutNoticeDue(false, false)).toBe(false)
    expect(api.signedOutNoticeDue(true, true)).toBe(false)
  })
})

describe('noteSignedOut', () => {
  test('fresh install (no history) stays silent', async () => {
    const { api, sent } = mk()
    await api.noteSignedOut()
    expect(sent).toEqual([])
  })
  test.each([
    ['was_signed_in flag', { local: { hs_was_signed_in: true } }],
    ['stored user_info', { local: { user_info: { id: 1 } } }],
    ['warm inventory', { inventory: [{ name: 'shrujj' }] }],
  ])('prior sign-in via %s notifies once', async (_n, opts) => {
    const { api, sent, session } = mk(opts)
    await api.noteSignedOut()
    await api.noteSignedOut()
    await api.noteSignedOut()
    expect(sent).toEqual([{ type: 'signed_out_notice' }])
    expect(session.hs_signed_out_shown).toBe(true)
  })
  test('already shown this browser session (SW restarted) stays silent', async () => {
    const { api, sent } = mk({ local: { hs_was_signed_in: true }, session: { hs_signed_out_shown: true } })
    await api.noteSignedOut()
    expect(sent).toEqual([])
  })
})

describe('no tab open at broadcast time', () => {
  test('not marked shown; delivered on the next poll once a tab exists, then once only', async () => {
    const { api, sent, session, env } = mk({ local: { hs_was_signed_in: true }, tabs: [] })
    await api.noteSignedOut()
    expect(sent).toEqual([])
    expect(session.hs_signed_out_shown).toBeUndefined()
    env.tabs.push({ id: 7 })
    await api.noteSignedOut()
    await api.noteSignedOut()
    expect(sent).toEqual([{ type: 'signed_out_notice' }])
    expect(session.hs_signed_out_shown).toBe(true)
  })
})

describe('noteSignedIn', () => {
  test('records sign-in, clears the shown flag, re-arms the notice', async () => {
    const { api, sent, local, session } = mk({ local: { hs_was_signed_in: true } })
    await api.noteSignedOut()
    expect(sent.length).toBe(1)
    api.noteSignedIn()
    await Promise.resolve()
    expect(local.hs_was_signed_in).toBe(true)
    expect(session.hs_signed_out_shown).toBeUndefined()
    await api.noteSignedOut()
    expect(sent.length).toBe(2)
  })
  test('sign-in alone marks a never-logged-in profile as having signed in', async () => {
    const { api, local } = mk()
    api.noteSignedIn()
    await Promise.resolve()
    expect(local.hs_was_signed_in).toBe(true)
  })
})
