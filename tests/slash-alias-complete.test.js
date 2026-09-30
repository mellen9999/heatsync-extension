/**
 * Slash Tab-complete must resolve ALIASES, not just canonical command names.
 * Reported live: typing "/hl" + Tab did nothing because the matcher only
 * checked cmd names ("highlight" doesn't start with "hl"). matchSlashCommands
 * folds SLASH_ALIASES in so a documented alias completes to its real command.
 *
 * Carves the two registries + the matcher from input.js (non-module bundle).
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { slashAliasMap, slashCommandsFor } from '../src/multichat/slash-registry.js'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'input.js'), 'utf8')

function slice(start, end) {
  const s = SRC.indexOf(start)
  const e = SRC.indexOf(end, s)
  if (s === -1 || e === -1) throw new Error(`markers not found: ${start} .. ${end}`)
  return SRC.slice(s, e)
}

// The matcher still lives in input.js and is still carved out. Its two data
// inputs now come from the registry instead of being re-eval'd from source —
// same values the bundle sees, minus the string surgery.
const matcherSrc = slice('function matchSlashCommands(q)', '\nfunction checkSlashAutocomplete')

const matchSlashCommands = new Function(
  't',
  'SLASH_COMMANDS',
  'SLASH_ALIASES',
  `${matcherSrc}\nreturn matchSlashCommands`,
)(() => '', slashCommandsFor('ext'), slashAliasMap('ext'))

describe('matchSlashCommands resolves aliases', () => {
  test('/hl → highlight (the reported case)', () => {
    const names = matchSlashCommands('hl').map((c) => c.cmd)
    expect(names).toContain('highlight')
  })

  test('/to → timeout (alias), /b → ban (alias)', () => {
    expect(matchSlashCommands('to').map((c) => c.cmd)).toContain('timeout')
    expect(matchSlashCommands('b').map((c) => c.cmd)).toContain('ban')
  })

  test('canonical names still match and rank first', () => {
    const names = matchSlashCommands('hi').map((c) => c.cmd)
    expect(names).toContain('highlight') // via cmd prefix "hi"
    // "help" starts with "h" not "hi", so a "hi" query is highlight-only here
    expect(matchSlashCommands('help').map((c) => c.cmd)[0]).toBe('help')
  })

  test('no duplicate when cmd and an alias both resolve to it', () => {
    const names = matchSlashCommands('un').map((c) => c.cmd)
    const dupes = names.filter((n, i) => names.indexOf(n) !== i)
    expect(dupes).toEqual([])
  })

  test('empty query returns the full canonical list, no alias noise', () => {
    const all = matchSlashCommands('')
    expect(all.length).toBeGreaterThan(10)
    expect(all.every((c) => typeof c.cmd === 'string')).toBe(true)
  })

  test('unknown prefix → no matches', () => {
    expect(matchSlashCommands('zzzz')).toEqual([])
  })
})
