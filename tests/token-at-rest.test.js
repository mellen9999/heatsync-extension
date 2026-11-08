/**
 * The session token at rest: a real key, not one rebuilt from public values.
 *
 * The old scheme derived its AES key from the extension id (public) and kept the
 * salt beside the ciphertext, so anyone holding storage.local could decrypt.
 * Now: a non-extractable AES-GCM CryptoKey made once, held in IndexedDB, and an
 * upgrade moves a stored token onto it without a sign-in.
 *
 * The real source (02-auth-live.js, via bg-src.js) runs here against real
 * WebCrypto, a fake storage.local and a small fake IndexedDB.
 */
import { describe, expect, test } from 'bun:test'
import { bgSource } from './bg-src.js'
import { fakeIndexedDB } from './fake-idb.js'

const SRC = bgSource()
const EXT_ID = 'hsextensionidhsextensionidhsextens'

const START = SRC.indexOf('const TOKEN_BLOB_V2')
const END = SRC.indexOf('// HeatSync emotes are smuggled')
if (START < 0 || END < START) throw new Error('token-at-rest markers missing from the background source')
const SECTION = SRC.slice(START, END)

function fakeStorage(seed = {}) {
  const data = { ...seed }
  const pick = (keys) => {
    if (keys == null) return { ...data }
    const list = typeof keys === 'string' ? [keys] : keys
    const out = {}
    for (const k of list) if (k in data) out[k] = data[k]
    return out
  }
  return {
    data,
    local: {
      get: async (keys) => pick(keys),
      set: async (obj) => void Object.assign(data, obj),
      remove: async (keys) => {
        for (const k of [].concat(keys)) delete data[k]
      },
    },
  }
}

function load({ idb = fakeIndexedDB(), storage = fakeStorage() } = {}) {
  const logs = []
  const browser = { runtime: { id: EXT_ID }, storage: { local: storage.local } }
  const make = new Function(
    'browser',
    'indexedDB',
    'log',
    `let authToken = null\n${SECTION}\nreturn { encryptToken, decryptToken, storeToken, retrieveToken, tokenKey }`,
  )
  const api = make(browser, idb, (...a) => logs.push(a.join(' ')))
  return { ...api, idb, storage, logs }
}

// The retired scheme, as it was written: PBKDF2(extension id) + a salt kept in storage.
async function legacyBlob(token, salt) {
  const km = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`${EXT_ID}-heatsync-token-key`),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    km,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  )
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(token)))
  const all = new Uint8Array(12 + ct.length)
  all.set(iv)
  all.set(ct, 12)
  return btoa(String.fromCharCode(...all))
}
const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('')

describe('a new token', () => {
  test('is sealed under a random, non-extractable key kept in IndexedDB', async () => {
    const h = load()
    await h.storeToken('tok.en.value')
    const blob = h.storage.data.auth_token_encrypted
    expect(blob.startsWith('v2:')).toBe(true)
    const key = h.idb._dump().get('hs-token-key').get('keys').get('auth-token-aes-gcm')
    expect(key.type).toBe('secret')
    expect(key.extractable).toBe(false)
    expect(key.algorithm.name).toBe('AES-GCM')
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow()
    expect(await h.retrieveToken()).toBe('tok.en.value')
  })

  test('leaves no salt, no clear-text token and no plaintext in storage', async () => {
    const storage = fakeStorage({ auth_token: 'old.plain.token', encryption_salt: 'ab'.repeat(32) })
    const h = load({ storage })
    await h.storeToken('tok.en.value')
    expect(Object.keys(storage.data)).toEqual(['auth_token_encrypted'])
    expect(JSON.stringify(storage.data)).not.toContain('tok.en.value')
  })

  test('cannot be opened by rebuilding the old key from the public extension id', async () => {
    const h = load()
    await h.storeToken('tok.en.value')
    const raw = Uint8Array.from(atob(h.storage.data.auth_token_encrypted.slice(3)), (c) => c.charCodeAt(0))
    const km = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(`${EXT_ID}-heatsync-token-key`),
      'PBKDF2',
      false,
      ['deriveKey'],
    )
    // every salt an attacker could know: the static one the first release used, or any they guess
    for (const salt of [new TextEncoder().encode('heatsync-salt'), new Uint8Array(32)]) {
      const key = await crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
        km,
        { name: 'AES-GCM', length: 256 },
        false,
        ['decrypt'],
      )
      await expect(
        crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, key, raw.slice(12)),
      ).rejects.toThrow()
    }
  })

  test('two sealings of one token differ (fresh iv each time)', async () => {
    const h = load()
    const a = await h.encryptToken('same')
    const b = await h.encryptToken('same')
    expect(a).not.toBe(b)
    expect(await h.decryptToken(a)).toBe('same')
    expect(await h.decryptToken(b)).toBe('same')
  })

  test('parallel first calls settle on ONE key', async () => {
    const h = load()
    const blobs = await Promise.all([h.encryptToken('a'), h.encryptToken('b'), h.encryptToken('c')])
    expect((await Promise.all(blobs.map((b) => h.decryptToken(b)))).join('')).toBe('abc')
    // a worker restart (new module scope, same IndexedDB) reads the same key back
    const h2 = load({ idb: h.idb, storage: h.storage })
    expect(await h2.decryptToken(blobs[1])).toBe('b')
  })

  test('a blob with a flipped byte, or sealed for another purpose, does not open', async () => {
    const h = load()
    const blob = await h.encryptToken('tok')
    const raw = Uint8Array.from(atob(blob.slice(3)), (c) => c.charCodeAt(0))
    raw[20] ^= 1
    expect(await h.decryptToken(`v2:${btoa(String.fromCharCode(...raw))}`)).toBeNull()
    // same key, no AAD: not a login blob
    const key = await h.tokenKey()
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode('tok')),
    )
    const all = new Uint8Array(12 + ct.length)
    all.set(iv)
    all.set(ct, 12)
    expect(await h.decryptToken(`v2:${btoa(String.fromCharCode(...all))}`)).toBeNull()
  })
})

describe('upgrading from the old scheme', () => {
  test('a token sealed with the per-user salt moves onto the real key, salt deleted', async () => {
    const salt = crypto.getRandomValues(new Uint8Array(32))
    const storage = fakeStorage({
      auth_token_encrypted: await legacyBlob('legacy.tok.en', salt),
      encryption_salt: hex(salt),
    })
    const h = load({ storage })
    expect(await h.retrieveToken()).toBe('legacy.tok.en')
    expect(storage.data.auth_token_encrypted.startsWith('v2:')).toBe(true)
    expect('encryption_salt' in storage.data).toBe(false)
    // and it is the real key doing the work now
    expect(await h.retrieveToken()).toBe('legacy.tok.en')
    expect(await h.decryptToken(storage.data.auth_token_encrypted)).toBe('legacy.tok.en')
  })

  test('a token from the first release (static salt, no salt stored) upgrades too', async () => {
    const storage = fakeStorage({
      auth_token_encrypted: await legacyBlob('first.release.tok', new TextEncoder().encode('heatsync-salt')),
    })
    const h = load({ storage })
    expect(await h.retrieveToken()).toBe('first.release.tok')
    expect(storage.data.auth_token_encrypted.startsWith('v2:')).toBe(true)
  })

  test('a clear-text token from the oldest installs is sealed and the clear copy removed', async () => {
    const storage = fakeStorage({ auth_token: 'plain.tok.en' })
    const h = load({ storage })
    expect(await h.retrieveToken()).toBe('plain.tok.en')
    expect(storage.data.auth_token_encrypted.startsWith('v2:')).toBe(true)
    expect('auth_token' in storage.data).toBe(false)
  })

  test('a leftover salt next to a v2 blob is swept', async () => {
    const h = load()
    await h.storeToken('tok')
    h.storage.data.encryption_salt = 'cd'.repeat(32)
    expect(await h.retrieveToken()).toBe('tok')
    expect('encryption_salt' in h.storage.data).toBe(false)
  })

  test('the upgrade runs once: a second start finds a v2 blob and does not rewrite it', async () => {
    const salt = crypto.getRandomValues(new Uint8Array(32))
    const storage = fakeStorage({ auth_token_encrypted: await legacyBlob('t', salt), encryption_salt: hex(salt) })
    const idb = fakeIndexedDB()
    await load({ storage, idb }).retrieveToken()
    const sealed = storage.data.auth_token_encrypted
    await load({ storage, idb }).retrieveToken()
    expect(storage.data.auth_token_encrypted).toBe(sealed)
  })
})

describe('when it cannot be read, the user signs in again — nothing crashes or loops', () => {
  test('garbage that is neither scheme: dropped, null, no throw', async () => {
    const storage = fakeStorage({ auth_token_encrypted: 'not base64 !!!', encryption_salt: 'zz' })
    const h = load({ storage })
    expect(await h.retrieveToken()).toBeNull()
    expect(Object.keys(storage.data)).toEqual([])
    // a second call is the same quiet answer, not a retry loop
    expect(await h.retrieveToken()).toBeNull()
  })

  test('a legacy blob whose salt is gone: dropped, null', async () => {
    const storage = fakeStorage({
      auth_token_encrypted: await legacyBlob('t', crypto.getRandomValues(new Uint8Array(32))),
    })
    const h = load({ storage })
    expect(await h.retrieveToken()).toBeNull()
    expect('auth_token_encrypted' in storage.data).toBe(false)
  })

  test('a v2 blob whose key is gone (IndexedDB wiped): dropped, null', async () => {
    const h = load()
    await h.storeToken('tok')
    const wiped = load({ storage: h.storage }) // a fresh IndexedDB: a different key
    expect(await wiped.retrieveToken()).toBeNull()
    expect('auth_token_encrypted' in h.storage.data).toBe(false)
  })

  test('IndexedDB itself unavailable: nothing is written in the clear, the blob is left for later, no throw', async () => {
    const good = load()
    await good.storeToken('tok')
    const blob = good.storage.data.auth_token_encrypted
    const h = load({ idb: fakeIndexedDB({ fail: 'open' }), storage: good.storage })
    expect(await h.retrieveToken()).toBeNull()
    expect(good.storage.data.auth_token_encrypted).toBe(blob)

    const empty = fakeStorage()
    const h2 = load({ idb: fakeIndexedDB({ fail: 'open' }), storage: empty })
    await h2.storeToken('tok.en.value')
    expect(empty.data).toEqual({})
  })

  test('a key store that failed once is tried again, not cached as dead', async () => {
    const idb = fakeIndexedDB({ fail: 'open' })
    const h = load({ idb })
    expect(await h.encryptToken('tok')).toBeNull()
    idb.open = fakeIndexedDB().open // the store recovers
    expect((await h.encryptToken('tok')).startsWith('v2:')).toBe(true)
  })
})
