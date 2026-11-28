/**
 * Runs shared/emote-notice.vectors.json against src/lib/emote-notice.js.
 *
 * What an app says when you add, remove, rename, swap, block or unblock an emote of yours is one
 * contract in every heatsync app: the site's file, copied here byte for byte. The extension says
 * it in its own notice (a toast) and its own language; the english is what is held to the file.
 *
 *   words    every id's line, rendered from the catalog the way chrome.i18n renders it, is the
 *            vector's line for the sample name and slot
 *   answers  every (op, status) the file lists is the id it says; a status it does not list is
 *            the op's failed id
 *
 * An id, an op or a field this runner does not know is a failure, never a skip: a client that
 * silently ignored a new line would pass while saying something else.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { EMOTE_NOTICE_KEYS, emoteNotice, emoteNoticeId, emoteNoticeOf } from '../src/lib/emote-notice.js'
import { t } from './t-stub.js'

// the lib says its lines through the bundle's t(); here it is the en catalog
beforeAll(() => {
  globalThis.t = t
})

// read as data, never imported: the file is the contract, not a module
const file = JSON.parse(readFileSync(resolve(import.meta.dir, '..', 'shared', 'emote-notice.vectors.json'), 'utf8'))

const TOP = ['about', 'answers', 'sample', 'words']
const ROW = ['op', 'says', 'status']
const OPS = ['add', 'remove', 'rename', 'swap', 'block', 'unblock']

describe('emote notices: the shared vectors', () => {
  test('the file has the fields this runner understands', () => {
    expect(Object.keys(file).sort()).toEqual(TOP)
    expect(Object.keys(file.sample).sort()).toEqual(['name', 'slot'])
    for (const row of file.answers) expect(Object.keys(row).sort(), JSON.stringify(row)).toEqual(ROW)
  })

  test('every op the file lists is one this client has, and every op this client has is listed', () => {
    expect([...new Set(file.answers.map((r) => r.op))].sort()).toEqual([...OPS].sort())
  })

  test('every id the file words is one this client has a catalog key for, and the other way round', () => {
    expect(Object.keys(EMOTE_NOTICE_KEYS).sort()).toEqual(Object.keys(file.words).sort())
  })

  for (const [id, line] of Object.entries(file.words)) {
    test(`says ${id}: ${line}`, () => {
      const want = line.replaceAll('{name}', file.sample.name).replaceAll('{slot}', String(file.sample.slot))
      const got = t(EMOTE_NOTICE_KEYS[id], id === 'add.ok' ? [file.sample.name, file.sample.slot] : [file.sample.name])
      expect(got).toBe(want)
    })
  }

  for (const row of file.answers) {
    test(`${row.op} answered ${row.status} says ${row.says}`, () => {
      expect(Object.hasOwn(file.words, row.says), `${row.says} is not a worded id`).toBe(true)
      expect(emoteNoticeId(row.op, row.status)).toBe(row.says)
      // and said whole: the id, the line and the kind of toast it is
      const n = emoteNotice(row.op, row.status, file.sample.name, file.sample.slot)
      expect(n.id).toBe(row.says)
      expect(n.text).toBe(
        file.words[row.says].replaceAll('{name}', file.sample.name).replaceAll('{slot}', String(file.sample.slot)),
      )
    })
  }

  test('an op it does not know is an error, never a quiet failure line', () => {
    expect(() => emoteNoticeId('pin', 200)).toThrow(/unknown op/)
  })

  test('a status the file does not list is the op failed, and a missing one is no answer at all', () => {
    for (const op of OPS) {
      const failed = file.answers.find((r) => r.op === op && r.status === 0).says
      expect(emoteNoticeId(op, 418)).toBe(failed)
      expect(emoteNoticeId(op, undefined)).toBe(failed)
      expect(emoteNoticeId(op, null)).toBe(failed)
    }
  })
})

describe('what the background answers is told by status', () => {
  test('a success is a 2xx whatever it carries; a refusal is its status; no status is no answer', () => {
    expect(emoteNoticeOf('add', { success: true, slot: 12 }, 'MeN').id).toBe('add.ok')
    expect(emoteNoticeOf('add', { success: false, status: 409 }, 'MeN').id).toBe('add.dupe')
    expect(emoteNoticeOf('add', { success: false, error: 'HTTP 500' }, 'MeN').id).toBe('add.failed')
    expect(emoteNoticeOf('add', undefined, 'MeN').id).toBe('add.failed')
  })

  test('an add that worked says its slot; one that did not say a slot says the plain added line', () => {
    expect(emoteNoticeOf('add', { success: true, slot: 12 }, 'MeN').text).toBe('added MeN to slot 12')
    expect(emoteNoticeOf('add', { success: true }, 'MeN').text).toBe('added: MeN')
    expect(emoteNoticeOf('add', { success: true, slot: 'x' }, 'MeN').text).toBe('added: MeN')
  })

  test('the toast is success for what worked, info for a login, error for the rest', () => {
    expect(emoteNotice('block', 200, 'MeN').kind).toBe('success')
    expect(emoteNotice('add', 401, 'MeN').kind).toBe('info')
    expect(emoteNotice('remove', 401, 'MeN').kind).toBe('info')
    expect(emoteNotice('add', 503, 'MeN').kind).toBe('error')
    expect(emoteNotice('unblock', 0, 'MeN').kind).toBe('error')
  })

  test('the server never gets to word the line: no raw error text reaches a notice', () => {
    const n = emoteNoticeOf(
      'add',
      { success: false, status: 500, error: 'Failed to add emote: relation "x" does not exist' },
      'MeN',
    )
    expect(n.text).toBe("couldn't add MeN")
  })
})
