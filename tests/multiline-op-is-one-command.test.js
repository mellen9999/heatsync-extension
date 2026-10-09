// A pasted multi-line /op is one command. The parse used `.`, which stops at
// the first newline, so the paste fell through as an orphan slash.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'input.js'), 'utf8')

describe('resolveSlashCmd', () => {
  test('the command pattern carries every line of a paste', () => {
    const body = SRC.slice(SRC.indexOf('function resolveSlashCmd'))
    const lit = body.match(/text\.match\((\/.+\/)\)/)?.[1]
    expect(lit).toBeTruthy()
    const re = new Function(`return ${lit}`)()
    const m = '/op patch notes\n\n- one\n- two'.match(re)
    expect(m?.[1]).toBe('op')
    expect(m?.[2]).toBe('patch notes\n\n- one\n- two')
  })
})
