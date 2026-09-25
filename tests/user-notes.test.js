import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  _hsNoteResetForTest,
  HS_NOTE_MAX,
  hsNoteDelete,
  hsNoteGet,
  hsNoteHas,
  hsNoteSave,
  hsNoteServerEligible,
  hsNoteSyncOnOpen,
} from '../src/multichat/user-notes.js'

// The module resolves a chatter to their alias set via the (bundle-global)
// identity helpers. In tests we inject them on globalThis to simulate the
// cross-platform identity graph, and clear them so files stay order-independent.
function setIdentity(map) {
  // map: primaryHandle -> full lowercased alias array
  const lookup = (u) => {
    const k = String(u).toLowerCase()
    for (const [, aliases] of Object.entries(map)) {
      if (aliases.includes(k)) return aliases
    }
    return [k]
  }
  globalThis.getUserAliases = (u) => lookup(u)
  globalThis.expandUserAliases = async (u) => lookup(u)
}

beforeEach(() => {
  _hsNoteResetForTest()
  globalThis.getUserAliases = undefined
  globalThis.expandUserAliases = undefined
})
afterEach(() => {
  globalThis.getUserAliases = undefined
  globalThis.expandUserAliases = undefined
})

test('save + get roundtrip (single handle, no identity graph)', async () => {
  await hsNoteSave('Bob', 'twitch', 'greifer, watch him')
  const n = hsNoteGet('bob', 'twitch')
  expect(n?.text).toBe('greifer, watch him')
  expect(hsNoteHas('bob', 'twitch')).toBe(true)
})

test('no note → get null, has false', () => {
  expect(hsNoteGet('nobody', 'twitch')).toBeNull()
  expect(hsNoteHas('nobody', 'twitch')).toBe(false)
})

test('note follows a person across platforms via the alias graph', async () => {
  setIdentity({ person: ['bob', 'bob_kick', 'bobtube'] })
  await hsNoteSave('bob', 'twitch', 'same guy everywhere')
  // Looked up from a DIFFERENT platform handle → same note.
  expect(hsNoteGet('bob_kick', 'kick')?.text).toBe('same guy everywhere')
  expect(hsNoteGet('bobtube', 'youtube')?.text).toBe('same guy everywhere')
  expect(hsNoteHas('bob_kick', 'kick')).toBe(true)
})

test('notes made from two platforms merge to one canonical record', async () => {
  // First noted before the graph linked them (only self-alias known).
  await hsNoteSave('bob', 'twitch', 'first')
  // Later the identity graph links the handles; a re-save from kick must not fork.
  setIdentity({ person: ['bob', 'bob_kick'] })
  await hsNoteSave('bob_kick', 'kick', 'updated')
  expect(hsNoteGet('bob', 'twitch')?.text).toBe('updated')
  expect(hsNoteGet('bob_kick', 'kick')?.text).toBe('updated')
})

test('empty / whitespace text deletes the note', async () => {
  await hsNoteSave('bob', 'twitch', 'temp')
  expect(hsNoteHas('bob', 'twitch')).toBe(true)
  await hsNoteSave('bob', 'twitch', '   ')
  expect(hsNoteGet('bob', 'twitch')).toBeNull()
})

test('delete removes across every alias', async () => {
  setIdentity({ person: ['bob', 'bob_kick'] })
  await hsNoteSave('bob', 'twitch', 'gone soon')
  await hsNoteDelete('bob_kick', 'kick')
  expect(hsNoteGet('bob', 'twitch')).toBeNull()
  expect(hsNoteGet('bob_kick', 'kick')).toBeNull()
})

test('text is trimmed and capped at HS_NOTE_MAX', async () => {
  await hsNoteSave('bob', 'twitch', '  padded  ')
  expect(hsNoteGet('bob', 'twitch')?.text).toBe('padded')
  await hsNoteSave('big', 'twitch', 'a'.repeat(HS_NOTE_MAX + 500))
  expect(hsNoteGet('big', 'twitch')?.text.length).toBe(HS_NOTE_MAX)
})

test('updatedAt is recorded (explicit clock for determinism)', async () => {
  await hsNoteSave('bob', 'twitch', 'stamped', 12345)
  expect(hsNoteGet('bob', 'twitch')?.updatedAt).toBe(12345)
})

test('save is case-insensitive on the handle', async () => {
  await hsNoteSave('BoB', 'twitch', 'mixedcase')
  expect(hsNoteGet('bob', 'twitch')?.text).toBe('mixedcase')
  expect(hsNoteGet('BOB', 'twitch')?.text).toBe('mixedcase')
})

// ── legacy hs_user_notes migration (profile-card's retired local store) ──────

function fakeStorage(initial) {
  const store = { ...initial }
  const calls = { set: [], removed: [] }
  globalThis.chrome = {
    runtime: {},
    storage: {
      local: {
        get: (keys, cb) => {
          const out = {}
          for (const k of Array.isArray(keys) ? keys : [keys]) {
            if (k in store) out[k] = store[k]
          }
          cb(out)
        },
        set: (obj, cb) => {
          Object.assign(store, obj)
          calls.set.push(obj)
          if (cb) cb()
        },
        remove: (key, cb) => {
          delete store[key]
          calls.removed.push(key)
          if (cb) cb()
        },
      },
    },
  }
  return { store, calls }
}

afterEach(() => {
  delete globalThis.chrome
})

test('legacy notes migrate into v1 on first load, old key removed after persist', async () => {
  const { store, calls } = fakeStorage({
    hs_user_notes: { bob: { text: 'known evader', ts: 42 } },
  })
  _hsNoteResetForTest(true)
  await hsNoteSave('someoneelse', 'twitch', 'unrelated') // triggers _hsnLoad
  const n = hsNoteGet('bob', 'twitch')
  expect(n?.text).toBe('known evader')
  expect(n?.updatedAt).toBe(42)
  expect(calls.removed).toContain('hs_user_notes')
  expect(store.hs_user_notes).toBeUndefined()
  expect(store.hs_user_notes_v1.notes.bob.text).toBe('known evader')
})

test('migration never clobbers an existing v1 note (v1 wins)', async () => {
  const { store } = fakeStorage({
    hs_user_notes_v1: { notes: { bob: { text: 'v1 truth', updatedAt: 100 } }, index: { bob: 'bob' } },
    hs_user_notes: { bob: { text: 'stale legacy', ts: 42 } },
  })
  _hsNoteResetForTest(true)
  await hsNoteSave('someoneelse', 'twitch', 'unrelated')
  expect(hsNoteGet('bob', 'twitch')?.text).toBe('v1 truth')
  expect(store.hs_user_notes).toBeUndefined()
})

test('empty legacy blob is dropped without a persist', async () => {
  const { store, calls } = fakeStorage({ hs_user_notes: {} })
  _hsNoteResetForTest(true)
  await hsNoteSave('x', 'twitch', 'y')
  expect(calls.removed).toContain('hs_user_notes')
  expect(store.hs_user_notes).toBeUndefined()
})

// ── server sync (logged-in only) ────────────────────────────────────────────
// hsAuthToken/apiFetch are bundle-globals (social.js) — simulated here the
// same way getUserAliases/expandUserAliases are above.
describe('hsNoteServerEligible', () => {
  test('a real heatsync profile id is eligible', () => {
    expect(hsNoteServerEligible('42')).toBe(true)
    expect(hsNoteServerEligible(42)).toBe(true)
  })
  test('kick_/yt_ synth ids (unregistered chatters) are not — no server row exists', () => {
    expect(hsNoteServerEligible('kick_12345')).toBe(false)
    expect(hsNoteServerEligible('yt_UCabc123')).toBe(false)
  })
  test('no id at all is not eligible', () => {
    expect(hsNoteServerEligible(null)).toBe(false)
    expect(hsNoteServerEligible(undefined)).toBe(false)
    expect(hsNoteServerEligible('')).toBe(false)
  })
})

describe('server sync — logged out or no eligible id: local-only, untouched', () => {
  afterEach(() => {
    globalThis.hsAuthToken = undefined
    globalThis.apiFetch = undefined
  })

  test('hsNoteSave never calls apiFetch when logged out', async () => {
    globalThis.hsAuthToken = false
    let called = false
    globalThis.apiFetch = async () => {
      called = true
      return { ok: true }
    }
    const rec = await hsNoteSave('bob', 'twitch', 'local only', undefined, '42')
    expect(called).toBe(false)
    expect(rec.serverSynced).toBe(false)
    expect(hsNoteGet('bob', 'twitch')?.text).toBe('local only')
  })

  test('hsNoteSyncOnOpen is a no-op when logged out', async () => {
    globalThis.hsAuthToken = false
    await hsNoteSave('bob', 'twitch', 'stays local')
    const changed = await hsNoteSyncOnOpen('bob', 'twitch', '42')
    expect(changed).toBe(false)
    expect(hsNoteGet('bob', 'twitch')?.text).toBe('stays local')
  })

  test('hsNoteSyncOnOpen is a no-op for a kick/yt synth id even when logged in', async () => {
    globalThis.hsAuthToken = true
    let called = false
    globalThis.apiFetch = async () => {
      called = true
      return { ok: true, data: { note: 'server text' } }
    }
    await hsNoteSave('bob', 'twitch', 'local only')
    const changed = await hsNoteSyncOnOpen('bob', 'twitch', 'kick_999')
    expect(called).toBe(false)
    expect(changed).toBe(false)
    expect(hsNoteGet('bob', 'twitch')?.text).toBe('local only')
  })
})

describe('server sync — logged in with a real profile id', () => {
  afterEach(() => {
    globalThis.hsAuthToken = undefined
    globalThis.apiFetch = undefined
  })

  test('hsNoteSave PUTs to the server and marks serverSynced on success', async () => {
    globalThis.hsAuthToken = true
    const calls = []
    globalThis.apiFetch = async (path, opts) => {
      calls.push({ path, opts })
      return { ok: true }
    }
    const rec = await hsNoteSave('bob', 'twitch', 'synced note', undefined, '42')
    expect(calls).toHaveLength(1)
    expect(calls[0].path).toBe('/api/user-notes/42')
    expect(calls[0].opts).toMatchObject({ method: 'PUT', auth: true, body: { note: 'synced note' } })
    expect(rec.serverSynced).toBe(true)
  })

  test('a save the server rejects still keeps the note locally, unsynced (never lose a note)', async () => {
    globalThis.hsAuthToken = true
    globalThis.apiFetch = async () => {
      throw new Error('network down')
    }
    const rec = await hsNoteSave('bob', 'twitch', 'kept locally', undefined, '42')
    expect(rec.serverSynced).toBe(false)
    expect(hsNoteGet('bob', 'twitch')?.text).toBe('kept locally')
  })

  test('hsNoteSyncOnOpen adopts a real server note over a stale/absent local one', async () => {
    globalThis.hsAuthToken = true
    globalThis.apiFetch = async () => ({ ok: true, data: { note: 'from the server' } })
    const changed = await hsNoteSyncOnOpen('bob', 'twitch', '42')
    expect(changed).toBe(true)
    expect(hsNoteGet('bob', 'twitch')?.text).toBe('from the server')
  })

  test('hsNoteSyncOnOpen uploads a local-only never-synced note once when the server has none', async () => {
    globalThis.hsAuthToken = false
    await hsNoteSave('bob', 'twitch', 'never synced yet') // saved while logged out
    globalThis.hsAuthToken = true
    const calls = []
    globalThis.apiFetch = async (path, opts) => {
      calls.push({ path, opts })
      if (opts.method === 'PUT') return { ok: true }
      return { ok: true, data: { note: '' } } // server has nothing yet
    }
    await hsNoteSyncOnOpen('bob', 'twitch', '42')
    const put = calls.find((c) => c.opts.method === 'PUT')
    expect(put).toBeTruthy()
    expect(put.opts.body).toEqual({ note: 'never synced yet' })
    expect(hsNoteGet('bob', 'twitch')?.serverSynced).toBe(true)
  })

  test('a failed server fetch never clobbers the good local note', async () => {
    globalThis.hsAuthToken = true
    await hsNoteSave('bob', 'twitch', 'good local note')
    globalThis.apiFetch = async () => {
      throw new Error('down')
    }
    const changed = await hsNoteSyncOnOpen('bob', 'twitch', '42')
    expect(changed).toBe(false)
    expect(hsNoteGet('bob', 'twitch')?.text).toBe('good local note')
  })

  test('an already-synced local note matching the server does not re-persist (no spurious repaint)', async () => {
    globalThis.hsAuthToken = true
    globalThis.apiFetch = async (_path, opts) =>
      opts.method === 'PUT' ? { ok: true } : { ok: true, data: { note: 'x' } }
    await hsNoteSave('bob', 'twitch', 'x', undefined, '42') // serverSynced: true
    const changed = await hsNoteSyncOnOpen('bob', 'twitch', '42')
    expect(changed).toBe(false)
  })

  test('deleting a note best-effort PUTs an empty note to the server too', async () => {
    globalThis.hsAuthToken = true
    const calls = []
    globalThis.apiFetch = async (path, opts) => {
      calls.push({ path, opts })
      return { ok: true }
    }
    await hsNoteSave('bob', 'twitch', 'goes away', undefined, '42')
    await hsNoteDelete('bob', 'twitch', '42')
    const del = calls.find((c) => c.opts.method === 'PUT' && c.opts.body.note === '')
    expect(del).toBeTruthy()
    expect(hsNoteGet('bob', 'twitch')).toBeNull()
  })
})
