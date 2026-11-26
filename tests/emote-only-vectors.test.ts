/**
 * Runs shared/emote-only.vectors.json against shared/emote-only.ts.
 *
 * The same file is copied into every app that draws chat pictures; each runs it against its own
 * port, so a client that answers differently fails its own tests. A kind or a field this runner
 * does not know is a failure, never a skip: a client that silently ignored a new rule would pass
 * while breaking it.
 *
 * The row renderer runs the same lines in tests/big-emote-lines.test.js.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { BIG_MAX, BIG_SCALE, emoteOnly, type Kind } from '../shared/emote-only'

// read as data, never imported: the file is the contract, not a module
const file = JSON.parse(readFileSync(resolve(import.meta.dir, '..', 'shared', 'emote-only.vectors.json'), 'utf8'))

const KINDS = ['emote', 'emoji', 'overlay', 'mod', 'text']
const CASE_FIELDS = ['name', 'line', 'read', 'want', 'pictures']

describe('big emote-only lines: the shared vectors', () => {
  test('the file has the fields this runner understands, and enough cases to mean something', () => {
    expect(Object.keys(file).sort()).toEqual(['about', 'cases', 'rules'])
    expect(Object.keys(file.rules).sort()).toEqual(['max', 'scale'])
    expect(file.cases.length).toBeGreaterThanOrEqual(49)
  })

  test('the constants are the vectors', () => {
    expect(BIG_MAX).toBe(file.rules.max)
    expect(BIG_SCALE).toBe(file.rules.scale)
  })

  for (const c of file.cases) {
    test(c.name, () => {
      const extra = Object.keys(c).filter((k) => !CASE_FIELDS.includes(k))
      expect(extra, `field(s) this runner does not understand: ${extra.join(', ')}`).toEqual([])
      for (const k of c.read) expect(KINDS, `unknown kind ${JSON.stringify(k)}`).toContain(k)
      expect(emoteOnly(c.read as Kind[])).toEqual({ size: c.want, pictures: c.pictures })
    })
  }

  test('a kind the rule does not know is an error, never a normal line', () => {
    expect(() => emoteOnly(['emote', 'sticker' as Kind])).toThrow(/unknown kind/)
  })
})
