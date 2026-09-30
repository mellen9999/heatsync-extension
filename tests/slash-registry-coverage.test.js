/**
 * The registry and handleSlashCommand must describe the same set of commands.
 *
 * Both directions matter and both had real failures before this test existed:
 *   registry -> handler   a row nobody implemented is a lie on the /commands
 *                         page and in autocomplete
 *   handler -> registry   an implemented command with no row is invisible: it
 *                         never autocompletes and never appears in /help.
 *                         /modes and /announceblue|green|orange|purple were
 *                         both in exactly this state.
 *
 * This is the single-repo half of the drift guard. The cross-repo parity test
 * skips when the sibling checkout is missing (i.e. always, in CI), so this is
 * where the teeth are.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SLASH_REGISTRY, SLASH_SECTIONS, slashCommandsFor } from '../src/multichat/slash-registry.js'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'input.js'), 'utf8')

// The dispatch is an if/else chain over `cmd`, so the branch conditions are the
// only machine-readable statement of what is implemented. Collect every string
// literal compared against `cmd`.
const handlerSrc = SRC.slice(SRC.indexOf('async function handleSlashCommand'))
const implemented = new Set()
for (const m of handlerSrc.matchAll(/\bcmd === '([a-z?]+)'/g)) implemented.add(m[1])
for (const m of handlerSrc.matchAll(/\[([^\]]*)\]\.includes\(cmd\)/g)) {
  for (const lit of m[1].matchAll(/'([a-z?]+)'/g)) implemented.add(lit[1])
}
// Two commands are dispatched outside that if/else chain and would otherwise
// read as unimplemented: the five chat modes come off the CHAT_MODES table
// (`if (CHAT_MODES[cmd])`), and /me is special-cased before the slash router
// ever runs, because it is formatted onto the wire as a CTCP ACTION.
const modesSrc = SRC.slice(SRC.indexOf('const CHAT_MODES = {'), SRC.indexOf('const KICK_MODE_CMDS'))
for (const m of modesSrc.matchAll(/^ {2}([a-z]+):/gm)) implemented.add(m[1])
if (/\/me\\b/.test(SRC)) implemented.add('me')

const registryNames = new Set(SLASH_REGISTRY.map((c) => c.cmd))
const aliasNames = new Set(SLASH_REGISTRY.flatMap((c) => c.alias || []))

describe('slash registry covers the implementation', () => {
  test('every registry row is a real command name or has a handler branch', () => {
    // A row may be dispatched by its canonical name or reached only via a
    // grouped branch; what must never happen is a row with no trace at all.
    const ghosts = [...registryNames].filter((c) => !implemented.has(c) && !SRC.includes(`'${c}'`))
    expect(ghosts).toEqual([])
  })

  test('no implemented command is missing from the registry', () => {
    const undocumented = [...implemented].filter((c) => !registryNames.has(c) && !aliasNames.has(c))
    expect(undocumented).toEqual([])
  })

  test('every non-hidden row appears in exactly one section', () => {
    const sectioned = SLASH_SECTIONS.flatMap((s) => s.cmds)
    const dupes = sectioned.filter((c, i) => sectioned.indexOf(c) !== i)
    expect(dupes).toEqual([])

    const visible = SLASH_REGISTRY.filter((c) => !c.hidden).map((c) => c.cmd)
    expect(visible.filter((c) => !sectioned.includes(c))).toEqual([])
    expect(sectioned.filter((c) => !registryNames.has(c))).toEqual([])
  })

  test('hidden rows never reach a surface', () => {
    const hidden = SLASH_REGISTRY.filter((c) => c.hidden).map((c) => c.cmd)
    expect(hidden).toContain('testnotices') // debug-only; it used to ship in /help
    for (const surface of ['ext', 'web']) {
      const shown = slashCommandsFor(surface).map((c) => c.cmd)
      expect(shown.filter((c) => hidden.includes(c))).toEqual([])
    }
  })

  test('field values stay in the declared vocabulary', () => {
    const ON = ['ext', 'web', 'both']
    const NEEDS = ['none', 'login', 'twitch', 'mod', 'broadcaster']
    const DOES = ['local', 'heatsync', 'twitch', 'kick', 'twitch+kick', 'passthrough']
    const WARN = ['bits', 'destructive']
    for (const c of SLASH_REGISTRY) {
      expect(ON, c.cmd).toContain(c.on)
      expect(NEEDS, c.cmd).toContain(c.needs)
      expect(DOES, c.cmd).toContain(c.does)
      expect(typeof c.desc).toBe('string')
      expect(c.desc.length, c.cmd).toBeGreaterThan(0)
      if (c.warn) expect(WARN, c.cmd).toContain(c.warn)
    }
  })

  test('no duplicate command names, and no alias collides with a command', () => {
    const names = SLASH_REGISTRY.map((c) => c.cmd)
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([])

    const aliases = SLASH_REGISTRY.flatMap((c) => c.alias || [])
    expect(aliases.filter((a, i) => aliases.indexOf(a) !== i)).toEqual([])
    expect(aliases.filter((a) => registryNames.has(a))).toEqual([])
  })

  test('descriptions carry no metadata — that is what the fields are for', () => {
    // '(mod)', '(twitch broadcaster)' etc. used to be smuggled into desc, which
    // is why the old list could not be rendered or checked.
    const leaky = SLASH_REGISTRY.filter((c) => /\((mod|twitch (mod|broadcaster)|broadcaster)\)/.test(c.desc))
    expect(leaky.map((c) => c.cmd)).toEqual([])
  })
})
