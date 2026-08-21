import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Every subsystem switch in the kill panel must actually switch something off.
 *
 * A toggle that enforces nothing is worse than a missing feature: the user
 * turns it off, believes the subsystem is disabled, and it keeps running. All
 * 16 are enforced today — this stops the 17th from being added to the panel and
 * never wired up.
 *
 * There are FOUR different ways the codebase asks "is this on", which is why a
 * name-based check is the right shape here rather than matching call syntax:
 *   gateAtBoot('x')                       main.js, at boot
 *   isEnabled('x')                        automod-queue, mentions, kick tap…
 *   getSetting('subsystems')?.['x']       native-tap.js
 *   HS_GATES + hsGateOn('x')              content.js
 *
 * Four spellings of one question is how the feed gate ended up controlling
 * YouTube chat. If a fifth appears, this still passes — it only asks that the
 * key is referenced by something other than the schema that declares it.
 */

const ROOT = join(import.meta.dir, '..')
const SCHEMA = join(ROOT, 'src', 'lib', 'settings-schema.js')

function declaredSwitches() {
  const s = readFileSync(SCHEMA, 'utf8')
  const at = s.indexOf("default: {\n      'irc-twitch'")
  expect(at, 'the subsystem default block moved').toBeGreaterThan(-1)
  const block = s.slice(at, at + 900)
  const keys = [...block.matchAll(/'?([a-z][a-z-]+)'?\s*:\s*true,/g)].map((m) => m[1])
  return [...new Set(keys)].filter((k) => k !== 'default')
}

function enforcementCorpus() {
  const out = []
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && e.name !== 'styles' && e.name !== '_locales') walk(join(dir, e.name))
        continue
      }
      if (!e.name.endsWith('.js')) continue
      if (/^multichat-(twitch|kick|youtube)\.js$/.test(e.name)) continue // build output
      const p = join(dir, e.name)
      if (p === SCHEMA) continue // the declaration is not the enforcement
      out.push(readFileSync(p, 'utf8'))
    }
  }
  walk(join(ROOT, 'src'))
  walk(join(ROOT, 'chrome'))
  return out.join('\n')
}

describe('subsystem switches', () => {
  const keys = declaredSwitches()
  const corpus = enforcementCorpus()

  test('the panel declares the expected set', () => {
    expect(keys.length).toBeGreaterThanOrEqual(16)
    expect(keys).toContain('feed')
    expect(keys).toContain('chat-youtube')
  })

  test('every switch is enforced somewhere outside the schema', () => {
    const dead = keys.filter((k) => !corpus.includes(`'${k}'`) && !corpus.includes(`"${k}"`))
    expect(dead, 'declared in the kill panel and enforced nowhere — the toggle lies to the user').toEqual([])
  })

  // The other direction, which matters just as much: a gate whose id is not a
  // declared switch can never be turned off, so the branch behind it is dead
  // and its "subsystem gate" comment is false. `right-click-block` is the one
  // known case — content.js gates on it, nothing declares it, and the real
  // control is heatsync-button.js's `rightClickBlockMode` setting.
  const KNOWN_UNDECLARED = ['right-click-block']

  test('no gate names a switch that does not exist', () => {
    const used = [
      ...new Set([...corpus.matchAll(/(?:gateAtBoot|isEnabled|hsGateOn)\('([a-z][a-z-]+)'\)/g)].map((m) => m[1])),
    ]
    expect(used.length, 'no gate calls found — the extraction broke, not the code').toBeGreaterThan(8)
    const phantom = used.filter((k) => !keys.includes(k) && !KNOWN_UNDECLARED.includes(k))
    expect(phantom, 'gated on a subsystem the settings panel never declares — the branch is unreachable').toEqual([])
  })

  test('the known-undeclared list stays honest', () => {
    // If one of these is ever promoted to a real switch, drop it from the list
    // rather than leaving a permanent exemption behind.
    const stillUndeclared = KNOWN_UNDECLARED.filter((k) => !keys.includes(k))
    expect(stillUndeclared).toEqual(KNOWN_UNDECLARED)
  })
})
