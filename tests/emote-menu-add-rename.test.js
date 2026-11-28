/**
 * M16: the emote menu (shift + right-click an emote) has add (an emote you do not own) and rename
 * (one you do), next to block / remove / open on / copy. The real openEmoteCtxMenu and
 * renameEmoteInInventory run against a stubbed page; the lines the viewer reads are the shared
 * emote notice's (src/lib/emote-notice.js), not worded here.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { t } from './en-t.js'

const ml = (f) => readFileSync(join(import.meta.dir, '..', 'src', 'multichat', f), 'utf8')
const INPUT = ml('input.js')
const MENU = INPUT.slice(INPUT.indexOf('  function openEmoteCtxMenu('), INPUT.indexOf('  // Right-click menu for emoji.'))
const RENAME = ml('emote-rename.js')
const NOTICE = readFileSync(join(import.meta.dir, '..', 'src', 'lib', 'emote-notice.js'), 'utf8').replace(/export /g, '')

function scopeOf(over) {
  return new Proxy(over, {
    has: (_, k) => typeof k === 'string' && !['emoteName', 'emoteUrl', 'state', 'source', 'targetEl', 'wrapper', 'hash', 'x', 'y'].includes(k),
    get: (o, k) => (k in o ? o[k] : k in globalThis ? globalThis[k] : () => undefined),
  })
}

function menuFor(state, { owned = false } = {}) {
  let shown = null
  const calls = []
  const scope = scopeOf({
    t,
    getHighResUrl: (u) => u,
    hsFavMenuItems: () => [],
    inventoryEmotes: new Set(owned ? ['KEKW'] : []),
    showHsCtxMenu: (_x, _y, _h, items) => {
      shown = items
    },
    addEmoteToInventory: (...a) => calls.push(['add', ...a]),
    emoteRenamePrompt: async (n) => `${n}2`,
    renameEmoteInInventory: (...a) => calls.push(['rename', ...a]),
    removeEmoteFromInventory: () => calls.push(['remove']),
  })
  const open = new Function('scope', `with (scope) { ${MENU}; return openEmoteCtxMenu }`)(scope)
  open(0, 0, { emoteName: 'KEKW', emoteUrl: 'https://cdn.7tv.app/emote/abc/1x.webp', state, source: '7tv', targetEl: null, wrapper: null, hash: 'h' })
  return { items: shown.filter((i) => i !== 'sep'), calls }
}
const labels = (m) => m.items.map((i) => i.label)

describe('menu items', () => {
  test('an emote you do not own offers add, not rename', async () => {
    const m = menuFor('unadded')
    expect(labels(m)).toContain('add to inventory')
    expect(labels(m)).not.toContain('rename')
    m.items.find((i) => i.label === 'add to inventory').fn()
    expect(m.calls[0].slice(0, 4)).toEqual(['add', 'KEKW', 'https://cdn.7tv.app/emote/abc/1x.webp', '7tv'])
  })

  test('one you own offers rename + remove, not add', async () => {
    const m = menuFor('owned', { owned: true })
    expect(labels(m)).toContain('rename')
    expect(labels(m)).toContain('remove from set')
    expect(labels(m)).not.toContain('add to inventory')
    await m.items.find((i) => i.label === 'rename').fn()
    expect(m.calls).toEqual([['rename', 'KEKW', 'KEKW2']])
  })

  test('a blocked emote offers neither', () => {
    const m = menuFor('blocked')
    expect(labels(m)).not.toContain('add to inventory')
    expect(labels(m)).not.toContain('rename')
    expect(labels(m)).toContain('unblock')
  })

  test('a locked (sub) emote cannot be added from here', () => {
    expect(labels(menuFor('locked'))).not.toContain('add to inventory')
  })
})

describe('renameEmoteInInventory', () => {
  let sent
  let reply
  let toasts
  let personal
  let api
  beforeEach(() => {
    sent = []
    toasts = []
    reply = { ok: true }
    personal = new Map([['KEKW', { url: 'u', slot: 3 }]])
    const inventoryEmotes = new Set(['KEKW'])
    const inventoryHashes = new Map([['KEKW', 'hh']])
    const emoteHashes = new Map()
    const hashToName = new Map()
    const chrome = {
      runtime: {
        lastError: null,
        sendMessage: (m, cb) => {
          sent.push(m)
          cb(reply)
        },
      },
    }
    const scope = scopeOf({
      t,
      chrome,
      viewerPersonalEmotes: personal,
      inventoryEmotes,
      inventoryHashes,
      emoteHashes,
      hashToName,
      pendingEmoteOps: new Set(),
      showToast: (text, kind) => toasts.push([text, kind]),
    })
    api = new Function('scope', `with (scope) { ${NOTICE}\n${RENAME}; return { renameEmoteInInventory } }`)(scope)
    api.maps = { inventoryEmotes, inventoryHashes, hashToName }
  })

  test('PUTs the slot, says the shared line, and the maps follow the new name', async () => {
    expect(await api.renameEmoteInInventory('KEKW', 'KEKX')).toBe(true)
    expect(sent[0]).toMatchObject({ type: 'api_fetch', path: '/api/user/emotes/3/rename', method: 'PUT', body: { newName: 'KEKX' } })
    expect(toasts).toEqual([[t('hsbtn_renamed_to', ['KEKX']), 'success']])
    expect(personal.has('KEKW')).toBe(false)
    expect(personal.get('KEKX').slot).toBe(3)
    expect(api.maps.inventoryEmotes.has('KEKX')).toBe(true)
    expect(api.maps.hashToName.get('hh')).toBe('KEKX')
  })

  test('a name already taken says so, and nothing local changes', async () => {
    reply = { ok: false, status: 409 }
    expect(await api.renameEmoteInInventory('KEKW', 'POG')).toBe(false)
    expect(toasts[0][0]).toBe(t('mc_emote_add_dupe', ['POG']))
    expect(personal.has('KEKW')).toBe(true)
  })

  test('no slot known: refuses without calling the server', async () => {
    personal.set('KEKW', { url: 'u' })
    expect(await api.renameEmoteInInventory('KEKW', 'KEKX')).toBe(false)
    expect(sent).toEqual([])
    expect(toasts[0][0]).toBe(t('hsbtn_rename_failed', ['KEKX']))
  })
})
