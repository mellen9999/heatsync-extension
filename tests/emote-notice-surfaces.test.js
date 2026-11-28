/**
 * Every place the extension tells you how a change to your own emotes went says the contract
 * line (shared/emote-notice.vectors.json, src/lib/emote-notice.js): add, remove, rename, swap,
 * block, unblock, on the panel, the picker and the native page, for the status the server
 * answered. One action is one line, a refusal never prints the server's own words, and no
 * success or failure is silent.
 *
 * The functions are carved out of the bundles and run against scripted answers, as the other
 * emote tests do; the picker and the native page keep their handlers inside closures, so what
 * cannot be carved out is held at source level.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { emoteNotice, emoteNoticeOf } from '../src/lib/emote-notice.js'
import { bgSource } from './bg-src.js'
import { mainSource } from './main-src.js'
import { t } from './t-stub.js'

// the lib says its lines through the bundle's t(); here it is the en catalog
beforeAll(() => {
  globalThis.t = t
})

const SRC = join(import.meta.dir, '..', 'src')
const read = (p) => readFileSync(join(SRC, p), 'utf8')
const EMOTES = read('multichat/emotes.js')
const INPUT = read('multichat/input.js')
const CONTENT = read('content/content.js')
const PICKER = read('content/heatsync-button.js')
const YT = read('content/youtube-content.js')
const BG = bgSource()
const MAIN = mainSource()

const slice = (src, from, to) => {
  const a = src.indexOf(from)
  const b = src.indexOf(to, a)
  if (a === -1 || b === -1) throw new Error(`carve markers not found: ${from} .. ${to}`)
  return src.slice(a, b)
}
// a function from its head to its closing brace, which sits alone at the head's own indent
const fn = (src, head) => {
  const indent = /^ */.exec(head)[0]
  return `${slice(src, head, `\n${indent}}\n`)}\n${indent}}`
}
const dedent = (code, n) => code.replace(new RegExp(`^ {${n}}`, 'gm'), '')

const ADD_BG = slice(BG, 'async function addToInventory(', '// Coalesce concurrent removes')
const REMOVE_BG = fn(BG, 'async function _removeFromInventoryImpl(')
const BLOCK_BG = fn(BG, 'async function blockEmote(hash)')
const UNBLOCK_BG = fn(BG, 'async function unblockEmote(hash)')

const ADD = slice(EMOTES, '// Add emote to inventory (click-to-add', '// Swap what you own under a name')
const SWAP = slice(EMOTES, '// Swap what you own under a name', '// Sync block/unblock to heatsync.org API')
const SYNC = fn(EMOTES, 'async function syncBlockToAPI(')
const REMOVE = slice(EMOTES, '// Resolves true when the server dropped it', '// Re-run the hover on whatever')

const run = (body, env) => {
  const names = Object.keys(env)
  return new Function(...names, body)(...names.map((k) => env[k]))
}

// ── the background answers with the status, never a broadcast ─────────────────────────────────
describe('the background answers with the HTTP status (0 = no answer) and the slot', () => {
  function addRig({ token = 'tok', status = 200, data = { hash: 'h', slot: 12 }, throws = false } = {}) {
    const sent = []
    const env = {
      getAuthCookie: async () => token,
      broadcastToTabs: (m) => sent.push(m),
      log() {},
      API_URL: 'https://x.test',
      fetchWithTimeout: async () => {
        if (throws) throw new Error('Failed to fetch')
        return { ok: status < 300, status, json: async () => data }
      },
      browser: { storage: { local: { set: async () => {} } } },
    }
    const { addToInventory } = run(
      `let emoteInventory = []
${ADD_BG}
return { addToInventory }`,
      env,
    )
    return { add: () => addToInventory('MeN', 'h', 'https://cdn.7tv.app/emote/x/2x.webp', false), sent }
  }

  test('add: a success carries its status and slot', async () => {
    const r = await addRig().add()
    expect(r).toMatchObject({ success: true, status: 200, slot: 12 })
  })

  test('add: not logged in is 401, a refusal is its status, a dead network is 0', async () => {
    expect((await addRig({ token: null }).add()).status).toBe(401)
    expect(await addRig({ status: 409, data: { error: 'emote name already in inventory' } }).add()).toMatchObject({
      success: false,
      status: 409,
    })
    expect((await addRig({ status: 403, data: { error: 'slot_limit_reached' } }).add()).status).toBe(403)
    expect((await addRig({ status: 503, data: { error: 'busy' } }).add()).status).toBe(503)
    expect((await addRig({ throws: true }).add()).status).toBe(0)
  })

  test('add: the refusal is not broadcast to every tab as a second toast', async () => {
    for (const rig of [
      addRig({ token: null }),
      addRig({ status: 409, data: { error: 'x' } }),
      addRig({ throws: true }),
    ]) {
      await rig.add()
      expect(rig.sent.filter((m) => m.type === 'emote_add_failed')).toEqual([])
    }
  })

  function removeRig({
    token = 'tok',
    inventory = [{ name: 'MeN', hash: 'h', slot: 4 }],
    status = 200,
    data = {},
  } = {}) {
    const env = {
      getAuthCookie: async () => token,
      broadcastToTabs() {},
      log() {},
      API_URL: 'https://x.test',
      fetchWithTimeout: async () => ({ ok: status < 300, status, json: async () => data }),
      fetchEmoteInventory: async () => {},
      tabChannels: new Map(),
      isSocketOpen: () => false,
      wsSend() {},
      browser: { storage: { local: { set: async () => {} } } },
    }
    const { go } = run(
      `let emoteInventory = ${JSON.stringify(inventory)}
let lastInventoryFetch = 0
${REMOVE_BG}
return { go: () => _removeFromInventoryImpl('h', 'MeN') }`,
      env,
    )
    return go()
  }

  test('remove: 401 without a token, the status on a refusal, 404 when it was not in your set', async () => {
    expect((await removeRig({ token: null })).status).toBe(401)
    expect(await removeRig({ status: 500, data: { error: 'Failed to remove emote' } })).toMatchObject({
      success: false,
      status: 500,
    })
    expect(await removeRig({ inventory: [] })).toMatchObject({ success: false, status: 404 })
  })

  function blockRig({ method, status = 200, throws = false }) {
    const env = {
      getAuthCookie: async () => 'tok',
      blockedEmotes: new Set(['h']),
      localBlockedEmotes: new Set(),
      markBlockToggle() {},
      saveLocalBlockedEmotes: async () => {},
      broadcastToTabs() {},
      persistServerBlockedEmotes() {},
      log() {},
      API_URL: 'https://x.test',
      fetchWithTimeout: async () => {
        if (throws) throw new Error('Failed to fetch')
        return { ok: status < 300, status, json: async () => ({ error: 'nope' }) }
      },
    }
    const o = run(`${BLOCK_BG}\n${UNBLOCK_BG}\nreturn { blockEmote, unblockEmote }`, env)
    return o[method]('h')
  }

  test('block and unblock: a refusal carries its status, a dead network is 0', async () => {
    expect(await blockRig({ method: 'blockEmote', status: 500 })).toMatchObject({ success: false, status: 500 })
    expect(await blockRig({ method: 'blockEmote', throws: true })).toMatchObject({ success: false, status: 0 })
    expect(await blockRig({ method: 'unblockEmote', status: 429 })).toMatchObject({ success: false, status: 429 })
    expect(await blockRig({ method: 'unblockEmote', throws: true })).toMatchObject({ success: false, status: 0 })
  })
})

// ── the panel ────────────────────────────────────────────────────────────────────────────────
describe('the panel says the contract line for every add, swap, remove, block and unblock', () => {
  function addRig(resp) {
    const toasts = []
    const nudges = []
    const env = {
      mcRemoteEmoteIndex: new Map(),
      zeroWidthFromAnyCache: () => false,
      emoteBlockKey: (_n, u, h) => h || btoa(u),
      showToast: (text, kind) => toasts.push([text, kind]),
      showEmoteLoginNudge: () => nudges.push('nudge'),
      emoteNotice,
      emoteNoticeOf,
      t,
      pendingEmoteOps: new Set(),
      chrome: { runtime: { lastError: null, sendMessage: (_m, cb) => cb(resp) } },
      blockedEmoteNames: new Set(),
      removedEmoteFallback: new Map(),
      persistRemovedFallback() {},
      blockedEmoteFallback: new Map(),
      persistBlockedFallback() {},
      forgetBlockedFallback: () => false,
      localRemovals: new Map(),
      inventoryEmotes: new Set(),
      inventoryHashes: new Map(),
      viewerPersonalEmotes: new Map(),
      emoteCache: new Map(),
      emoteHashes: new Map(),
      hashToName: new Map(),
      queryEmoteWrappers: () => [],
      wrapperIsEmote: () => true,
      refreshEmoteTooltip() {},
      flashAllEmotes() {},
      log() {},
    }
    const { addEmoteToInventory } = run(`${ADD}; return { addEmoteToInventory }`, env)
    return {
      add: (...a) => addEmoteToInventory('MeN', 'https://cdn.7tv.app/emote/x/2x.webp', '7tv', null, false, ...a),
      toasts,
      nudges,
    }
  }

  test('an add that worked says the slot it landed in', async () => {
    const r = addRig({ success: true, status: 200, hash: 'h', slot: 12 })
    expect(await r.add(false)).toBe(true)
    expect(r.toasts).toEqual([['added MeN to slot 12', 'success']])
  })

  test('an add answered 401, 409, 403, 503, 500 or nothing says its own line and never the server text', async () => {
    const lines = {
      401: ['log in to add emotes', 'info'],
      409: ['already have an emote named MeN', 'error'],
      403: ['emote slots full — remove some first', 'error'],
      503: ['moderation busy, try again', 'error'],
      500: ["couldn't add MeN", 'error'],
      0: ["couldn't add MeN", 'error'],
    }
    for (const [status, line] of Object.entries(lines)) {
      const r = addRig({ success: false, status: Number(status), error: 'Failed to add emote: relation "x" missing' })
      expect(await r.add(true)).toBe(false) // even the silent auto-add on send says why it failed
      expect(r.toasts, `status ${status}`).toEqual([line])
    }
    const none = addRig(undefined) // the worker did not answer
    expect(await none.add(true)).toBe(false)
    expect(none.toasts).toEqual([["couldn't add MeN", 'error']])
  })

  test('a logged-out add also raises the one-click login banner', async () => {
    const r = addRig({ success: false, status: 401, error: 'Not logged in' })
    await r.add(true)
    expect(r.nudges).toEqual(['nudge'])
  })

  test('an add under replace is a swap: its refusals are the swap lines, and it says nothing on success', async () => {
    const kept = addRig({ success: false, status: 409, error: 'name held by your upload' })
    expect(await kept.add(true, true)).toBe(false)
    expect(kept.toasts).toEqual([['MeN is your upload — kept it', 'error']])
    const failed = addRig({ success: false, status: 500, error: 'x' })
    await failed.add(true, true)
    expect(failed.toasts).toEqual([["couldn't swap MeN — kept yours", 'error']])
    const ok = addRig({ success: true, status: 200, hash: 'h', slot: 3 })
    expect(await ok.add(true, true)).toBe(true)
    expect(ok.toasts).toEqual([])
  })

  function swapRig(addResult) {
    const toasts = []
    const env = {
      viewerPersonalEmotes: new Map([['MeN', { url: 'https://x/old', hash: 'oldhash' }]]),
      hashToName: new Map(),
      addEmoteToInventory: async () => addResult,
      showToast: (text, kind) => toasts.push([text, kind]),
      emoteNotice,
      t,
    }
    const { swapEmoteInInventory } = run(`${SWAP}; return { swapEmoteInInventory }`, env)
    return { swap: () => swapEmoteInInventory('MeN', 'https://x/new', '7tv', false), toasts }
  }

  test('a swap that worked says so once', async () => {
    const r = swapRig(true)
    expect(await r.swap()).toBe(true)
    expect(r.toasts).toEqual([['MeN swapped to your pick', 'success']])
  })

  function removeRig(response, { throws = false } = {}) {
    const toasts = []
    const undone = []
    const env = {
      pendingEmoteOps: new Set(),
      inventoryHashes: new Map([['MeN', 'h']]),
      emoteHashes: new Map(),
      lookupEmote: () => null,
      applyLocalRemoval: () => () => undone.push('undo'),
      chrome: {
        runtime: {
          lastError: throws ? { message: 'Extension context invalidated' } : null,
          sendMessage: (_m, cb) => cb(response),
        },
      },
      showToast: (text, kind) => toasts.push([text, kind]),
      emoteNotice,
      emoteNoticeOf,
      t,
    }
    const { removeEmoteFromInventory } = run(`${REMOVE}; return { removeEmoteFromInventory }`, env)
    return { remove: (...a) => removeEmoteFromInventory('MeN', null, ...a), toasts, undone }
  }

  test('a remove that worked says removed, a missing slot is a remove that worked', async () => {
    const ok = removeRig({ success: true })
    expect(await ok.remove()).toBe(true)
    expect(ok.toasts).toEqual([['removed MeN', 'success']])
    const gone = removeRig({ success: false, status: 404, error: 'Emote not found in your set' })
    expect(await gone.remove()).toBe(true)
    expect(gone.toasts).toEqual([['removed MeN', 'success']])
    expect(gone.undone).toEqual([])
  })

  test('a remove that failed puts the emote back and says login or failed, never the server text', async () => {
    const login = removeRig({ success: false, status: 401, error: 'Not logged in' })
    expect(await login.remove()).toBe(false)
    expect(login.undone).toEqual(['undo'])
    expect(login.toasts).toEqual([['log in to manage inventory', 'info']])
    const failed = removeRig({ success: false, status: 500, error: 'Failed to remove emote' })
    expect(await failed.remove({ silent: true })).toBe(false) // the reason shows even when quiet
    expect(failed.toasts).toEqual([['remove failed: MeN', 'error']])
    const dead = removeRig(undefined)
    expect(await dead.remove()).toBe(false)
    expect(dead.toasts).toEqual([['remove failed: MeN', 'error']])
  })

  function syncRig(resp) {
    const toasts = []
    const calls = []
    const env = {
      browser: { runtime: { sendMessage: async () => resp } },
      emoteHashes: new Map([['MeN', 'h']]),
      lookupEmote: () => null,
      emoteBlockKey: () => 'k',
      log() {},
      showToast: (text, kind) => toasts.push([text, kind]),
      emoteNotice,
      emoteNoticeOf,
      t,
      console: { warn() {} },
      blockEmote: (...a) => calls.push(['block', a[3]]),
      unblockEmote: (...a) => calls.push(['unblock', a[1]]),
    }
    const { syncBlockToAPI } = run(`${SYNC}\nreturn { syncBlockToAPI }`, env)
    return { sync: (block, ctx = {}) => syncBlockToAPI('MeN', block, ctx), toasts, calls }
  }

  test('a block or unblock the account took says so; one it refused is undone and says that', async () => {
    const ok = syncRig({ success: true })
    await ok.sync(true)
    await ok.sync(false)
    expect(ok.toasts).toEqual([
      ['blocked MeN', 'success'],
      ['unblocked MeN', 'success'],
    ])
    const no = syncRig({ success: false, status: 500, error: 'HTTP 500' })
    await no.sync(true)
    await no.sync(false)
    expect(no.toasts).toEqual([
      ["couldn't block MeN — try again", 'error'],
      ["couldn't unblock MeN — try again", 'error'],
    ])
    expect(no.calls.map((c) => c[0])).toEqual(['unblock', 'block'])
  })

  test('the panel carries no emote line of its own: the old keys and the raw error toast are gone', () => {
    for (const gone of [
      'mc_emote_blocked_toast',
      'mc_emote_unblocked',
      'mc_emote_block_failed',
      'mc_emote_unblock_failed',
    ]) {
      expect(EMOTES, gone).not.toContain(`'${gone}'`)
    }
    expect(EMOTES).not.toContain('showToast(response?.error')
    expect(EMOTES).not.toContain('showToast(addErr')
    expect(EMOTES).not.toContain('mc_emote_add_error')
    expect(EMOTES).not.toContain('mc_emote_remove_error')
  })

  test('the background no longer broadcasts a failed add, so the panel and the page do not echo the answer', () => {
    expect(MAIN).not.toContain('emote_add_failed')
    expect(CONTENT).not.toContain('emote_add_failed')
    expect(BG).not.toContain('emote_add_failed')
  })

  test('the send that auto-adds a catalog pick says so (the site does)', () => {
    expect(INPUT).toContain(
      'addEmoteToInventory(word, rec.url, rec.source, undefined, !!rec.zeroWidth, /* silent */ false)',
    )
  })
})

// ── the picker ───────────────────────────────────────────────────────────────────────────────
describe('the picker says the contract line, for the status the answer carried', () => {
  const ADD_PICK = dedent(fn(PICKER, '    async function addEmoteFromPicker('), 4)
  const SAY = dedent(fn(PICKER, '    function sayEmote('), 4)

  function pickRig({ token = 'tok', resp, err }) {
    const said = []
    const env = {
      getAuthToken: async () => token,
      HS: {
        apiFetch: async () => {
          if (err) throw err
          return resp
        },
      },
      showPickerToast: (m) => said.push(m),
      loadInventoryEmotes: async () => {},
      fetchHistoryStatus() {},
      log() {},
      emoteNoticeOf,
      t,
    }
    const o = run(`${SAY}\n${ADD_PICK}\nreturn { addEmoteFromPicker }`, env)
    return { add: () => o.addEmoteFromPicker({ name: 'MeN', url: 'https://cdn.7tv.app/emote/x/2x.webp' }), said }
  }

  test('an import that landed says its slot', async () => {
    const r = pickRig({ resp: { success: true, imported: 1, skipped: 0, emotes: [{ name: 'MeN', slot: 12 }] } })
    expect(await r.add()).toBe(true)
    expect(r.said).toEqual(['added MeN to slot 12'])
  })

  test('an import that skipped the emote says it is a name you hold; a full set says full', async () => {
    const dupe = pickRig({ resp: { success: true, imported: 0, skipped: 1, full: false, emotes: [] } })
    expect(await dupe.add()).toBe(false)
    expect(dupe.said).toEqual(['already have an emote named MeN'])
    const full = pickRig({ resp: { success: true, imported: 0, skipped: 0, full: true, emotes: [] } })
    await full.add()
    expect(full.said).toEqual(['emote slots full — remove some first'])
  })

  test('a refusal says by status, and logged out says log in', async () => {
    const e503 = pickRig({ err: Object.assign(new Error('Service unavailable'), { status: 503 }) })
    await e503.add()
    expect(e503.said).toEqual(['moderation busy, try again'])
    const e500 = pickRig({ err: Object.assign(new Error('Failed to import emotes'), { status: 500 }) })
    await e500.add()
    expect(e500.said).toEqual(["couldn't add MeN"])
    const out = pickRig({ token: null })
    expect(await out.add()).toBe(false)
    expect(out.said).toEqual(['log in to add emotes'])
  })

  test('every emote toast in the picker goes through the one helper, none through raw server text', () => {
    for (const op of ['add', 'remove', 'rename', 'block', 'unblock']) expect(PICKER, op).toContain(`sayEmote('${op}'`)
    // btn_toast_blocked / btn_toast_removed stay: they label a menu row and a removed-emote row, not a toast
    for (const gone of [
      'btn_toast_added',
      'btn_toast_unblocked',
      'btn_toast_block_failed',
      'btn_toast_remove_failed',
      'hsbtn_add_failed',
      'hsbtn_unblock_failed',
      'hsbtn_login_add',
      'hsbtn_renamed_to',
      'hsbtn_rename_failed',
    ]) {
      expect(PICKER, gone).not.toContain(`'${gone}'`)
    }
    // (the move and share rows are not one of the six ops: they keep their own lines)
    expect(PICKER).not.toMatch(/showPickerToast\(\s*result\?\.error/)
    expect(PICKER).not.toContain('addEmoteToInventorySilent')
  })

  test('the add that used to say "added" before it ran says it after, from the answer', () => {
    const at = PICKER.indexOf("t('btn_ctx_add_inventory')")
    const menuAdd = PICKER.slice(at, PICKER.indexOf('menu.appendChild(addBtn)', at))
    expect(menuAdd).toContain('addEmoteFromPicker(emote)')
    expect(menuAdd).not.toContain("showPickerToast('")
  })
})

// ── the native page ──────────────────────────────────────────────────────────────────────────
describe('the native page says the contract line', () => {
  const REMOVE_OWNED = dedent(fn(CONTENT, '  function removeOwnedEmote('), 2)
  const SAY = dedent(fn(CONTENT, '  function sayEmote('), 2)

  function removeOwnedRig(result, { rejects = false } = {}) {
    const toasts = []
    const wrapper = { dataset: {}, firstElementChild: null }
    const env = {
      inventoryHashSet: new Set(['h']),
      pendingOperations: new Set(),
      safeSendMessage: () =>
        rejects ? Promise.reject(new Error('Extension context invalidated')) : Promise.resolve(result),
      showToast: (text, kind) => toasts.push([text, kind]),
      extensionContextValid: true,
      emoteNoticeOf,
      t,
    }
    const { removeOwnedEmote } = run(`${SAY}\n${REMOVE_OWNED}\nreturn { removeOwnedEmote }`, env)
    return {
      remove: async () => {
        removeOwnedEmote(wrapper, 'h', 'MeN')
        await new Promise((r) => setTimeout(r, 0))
      },
      toasts,
    }
  }

  test('a right-click remove says removed, log in, or failed by status', async () => {
    const ok = removeOwnedRig({ success: true })
    await ok.remove()
    expect(ok.toasts).toEqual([['removed MeN', 'success']])
    const login = removeOwnedRig({ success: false, status: 401, error: 'Not logged in' })
    await login.remove()
    expect(login.toasts).toEqual([['log in to manage inventory', 'info']])
    const failed = removeOwnedRig({ success: false, status: 500, error: 'Failed to remove emote' })
    await failed.remove()
    expect(failed.toasts).toEqual([['remove failed: MeN', 'error']])
    const dead = removeOwnedRig(undefined, { rejects: true })
    await dead.remove()
    expect(dead.toasts).toEqual([['remove failed: MeN', 'error']])
  })

  test('no handler prints the server text or says "added" in a joined list; unblock by right-click says so', () => {
    for (const gone of [
      'content_toast_failed_add',
      'content_toast_failed_block',
      'content_toast_failed_unblock',
      'cs_remove_failed',
      "'mc_emote_added'",
    ]) {
      expect(CONTENT, gone).not.toContain(gone)
    }
    expect(CONTENT).not.toMatch(/showToast\(\s*t\('cs_login_manage'/)
    for (const op of ['add', 'block', 'unblock']) expect(CONTENT, op).toContain(`sayEmote('${op}'`)
    // the right-click unblock was silent on success: it has a line now
    const at = CONTENT.indexOf("const restoredState = isGlobalEmote ? 'global' : 'neutral'")
    const rc = CONTENT.slice(at, CONTENT.indexOf('} else if (removeOwnedEmote(', at))
    expect(rc).toContain("sayEmote('unblock'")
  })

  test('the block-all button says what the account took, after it answered, not before', () => {
    const at = CONTENT.indexOf('blockAllBtn.textContent = allBlocked')
    const body = CONTENT.slice(at, CONTENT.indexOf('// Click anywhere on a stack', at))
    expect(body.indexOf('sayEmote(')).toBeGreaterThan(body.indexOf('Promise.all('))
  })

  test('the youtube chat says the same keys the contract names for block and unblock', () => {
    const keys = { block: 'content_toast_blocked', unblock: 'content_toast_unblocked' }
    expect(YT).toContain(`'${keys.unblock}'`)
    expect(YT).toContain(`'${keys.block}'`)
    expect(emoteNotice('block', 200, 'MeN').text).toBe(t(keys.block, ['MeN']))
    expect(emoteNotice('unblock', 200, 'MeN').text).toBe(t(keys.unblock, ['MeN']))
    expect(emoteNotice('block', 0, 'MeN').text).toBe(t('content_toast_block_failed', ['MeN']))
    expect(emoteNotice('unblock', 0, 'MeN').text).toBe(t('content_toast_unblock_failed', ['MeN']))
  })
})
