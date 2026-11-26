/**
 * Runs shared/filter-rules.vectors.json against src/multichat/filter-rules.js.
 *
 * The same file is copied into every app that runs the rules (the site, the desktop app); each runs it
 * against its own engine, so a client that answers differently fails its own tests. A field or a verdict
 * this runner does not know is a failure, never a skip: a client that silently ignored a new rule would
 * pass while breaking it.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { compileFilterRules, evaluateFilterRules } from '../src/multichat/filter-rules.js'

// read as data, never imported: the file is the contract, not a module
const file = JSON.parse(readFileSync(resolve(import.meta.dir, '..', 'shared', 'filter-rules.vectors.json'), 'utf8'))

const CASE_FIELDS = ['name', 'rules', 'msg', 'channel', 'want']
const WANT_FIELDS = ['color', 'hide', 'notify', 'sound', 'soundVolume']
const MSG_DEFAULT = {
  user: 'alice',
  badges: '',
  platform: 'twitch',
  isFirstMsg: false,
  isAction: false,
  bits: 0,
  replyTo: null,
}

beforeEach(() => compileFilterRules([]))

describe('filter-rules vectors', () => {
  test('the file has the fields this runner reads, and enough cases to mean something', () => {
    expect(Object.keys(file).sort()).toEqual(['about', 'cases'])
    expect(file.cases.length).toBeGreaterThanOrEqual(100)
    expect(new Set(file.cases.map((c) => c.want.hide))).toEqual(new Set([true, false]))
  })
  for (const c of file.cases) {
    test(c.name, () => {
      expect(
        Object.keys(c).filter((k) => !CASE_FIELDS.includes(k)),
        'a field this runner does not know',
      ).toEqual([])
      expect(
        Object.keys(c.msg).filter((k) => k !== 'text' && !(k in MSG_DEFAULT)),
        'a msg field this runner does not know',
      ).toEqual([])
      expect(Object.keys(c.want).sort()).toEqual(WANT_FIELDS)
      compileFilterRules(c.rules)
      const v = evaluateFilterRules({ ...MSG_DEFAULT, ...c.msg }, c.channel || null)
      expect({
        hide: v.hide,
        color: v.highlight,
        notify: v.notify,
        sound: v.sound,
        soundVolume: v.soundVolume,
      }).toEqual(c.want)
    })
  }
})
