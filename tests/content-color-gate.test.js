/**
 * content.js's COLOR_RE gates every colour it writes into native chat: two sinks build
 * style.cssText from it (a chatter's name, an @mention), two set a badge background. The
 * colours come from twitch's own rows and from heatsync.org name colours other users pick,
 * so the gate is the whole defence: it once accepted `rgb(.+)`, which let a second
 * declaration ride along (`rgb(1,2,3); background:url(…)`).
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'content', 'content.js'), 'utf8')
const decl = SRC.match(/const COLOR_RE =\s*(\/.+\/i)$/m)?.[1]
if (!decl) throw new Error('COLOR_RE declaration not found in src/content/content.js')
const COLOR_RE = new Function(`return ${decl}`)()

describe('native chat colour gate', () => {
  test('passes the colours twitch, kick and heatsync hand it', () => {
    for (const c of [
      '#fff',
      '#FF0000',
      '#ff000080',
      'rgb(255, 0, 0)',
      'rgb(1,2,3)',
      'rgba(0, 0, 0, 0.5)',
      'red',
      'rebeccapurple',
    ])
      expect(COLOR_RE.test(c)).toBe(true)
  })

  test('refuses anything that could carry a second declaration', () => {
    for (const c of [
      'rgb(1,2,3); background:url(https://x.invalid/b)',
      'rgb(1,2,3)) ; color:red',
      'red; background-image:url(//x.invalid)',
      'url(https://x.invalid)',
      'expression(alert(1))',
      'var(--x)',
      '#fff;',
      '',
    ])
      expect(COLOR_RE.test(c)).toBe(false)
  })

  test('every cssText sink reads its colour through the gate', () => {
    const sinks = [...SRC.matchAll(/style\.cssText = `color: \$\{(\w+)\}/g)].map((m) => m[1])
    expect(sinks.length).toBeGreaterThanOrEqual(2)
    for (const v of sinks) expect(SRC).toContain(`const ${v} = COLOR_RE.test(`)
  })
})
