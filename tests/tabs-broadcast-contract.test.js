/**
 * Every message the background pushes to a tab must have a receiver.
 *
 * `broadcastToTabs` / `chrome.tabs.sendMessage` is the background's only way to
 * tell a content script something, and it is completely silent when nobody is
 * listening: no error, no rejected promise, no return value anyone checks. The
 * companion file tests/wire-contract-runtime.test.js covers the OTHER pipe
 * (content -> background) in both directions; this one had no coverage at all.
 *
 * Three types were being pushed to every tab on every occurrence with nothing
 * anywhere to receive them:
 *   ui_state_update      a settings change arriving from another device — the
 *                        overlay actually re-applies from storage.onChanged
 *   notification:new     a heatsync notification — the toolbar badge is the
 *                        surface; HsNotifs has no registered type for it
 *   emote_remove_failed  five sites, each a strict duplicate of the
 *                        { success:false, error } the same function returns,
 *                        which is what the picker reads
 *
 * None of them was load-bearing, which is the point: they cost a broadcast to
 * every open tab and they made three features look wired that were not.
 *
 * Two things this check has to get right, both learned by getting them wrong:
 *   · match the call's arguments by PAREN MATCHING, not a line-bounded regex —
 *     a lazy multi-line pattern happily pairs a `broadcastToTabs({` with an
 *     `emote_remove_failed` a thousand lines below it
 *   · `type:` must not match `eventType: 'gift'`, or a payload field is read as
 *     a message type
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const BG = readFileSync(join(ROOT, 'chrome', 'background.js'), 'utf8')

function contentScripts() {
  const out = []
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!['node_modules', '_locales', 'styles'].includes(e.name)) walk(join(dir, e.name))
        continue
      }
      if (!e.name.endsWith('.js')) continue
      if (/^multichat-(twitch|kick|youtube)\.js$/.test(e.name)) continue // build output
      if (e.name === 'background.js') continue
      out.push(readFileSync(join(dir, e.name), 'utf8'))
    }
  }
  walk(join(ROOT, 'src'))
  walk(join(ROOT, 'chrome'))
  return out
}

/** Message types background.js pushes to tabs, with the line they are pushed from. */
export function pushedToTabs(src = BG) {
  const found = new Map()
  for (const fname of ['broadcastToTabs', 'tabs.sendMessage']) {
    let i = src.indexOf(`${fname}(`)
    while (i >= 0) {
      let depth = 0
      let j = i + fname.length
      for (; j < src.length; j++) {
        const c = src[j]
        if (c === '(') depth++
        else if (c === ')' && --depth === 0) break
      }
      const args = src.slice(i, j + 1)
      // `(?<![A-Za-z_])` so `eventType: 'gift'` is not read as a type.
      for (const m of args.matchAll(/(?<![A-Za-z_])type:\s*'([a-z0-9_:.-]+)'/gi)) {
        const line = src.slice(0, i).split('\n').length
        if (!found.has(m[1])) found.set(m[1], [])
        found.get(m[1]).push(line)
      }
      i = src.indexOf(`${fname}(`, j)
    }
  }
  return found
}

/** Every literal type a content script dispatches on, in any of the spellings used here. */
function handledByContent() {
  const s = new Set()
  for (const src of contentScripts()) {
    // `msg.type === 'x'` AND `msg.type !== 'x'` — main.js's listeners are
    // written as early-return guards, and a check that only saw `===` reported
    // fourteen working types as orphans.
    for (const m of src.matchAll(/\.type\s*(?:===|!==|==|!=)\s*'([a-z0-9_:.-]+)'/gi)) s.add(m[1])
    for (const m of src.matchAll(/case '([a-z0-9_:.-]+)':/gi)) s.add(m[1])
    for (const m of src.matchAll(/\[\s*'([a-z0-9_:.-]+)'\s*\]\s*:/gi)) s.add(m[1])
  }
  return s
}

describe('background → tab broadcast contract', () => {
  const pushed = pushedToTabs()
  const handled = handledByContent()

  test('both extractions found something real', () => {
    expect(pushed.size).toBeGreaterThan(40)
    expect(handled.size).toBeGreaterThan(100)
    expect(pushed.has('emote_removed')).toBe(true)
    expect(handled.has('emote_removed')).toBe(true)
  })

  test('a payload field named *Type is not read as a message type', () => {
    const probe = "broadcastToTabs({ type: 'kick_sub_event', eventType: 'gift', username: u })"
    expect([...pushedToTabs(probe).keys()]).toEqual(['kick_sub_event'])
  })

  test('paren matching, so a later type cannot be pulled into an earlier call', () => {
    const probe = [
      "broadcastToTabs({ type: 'first' })",
      'function unrelated() {}',
      "broadcastToTabs({\n  type: 'second',\n})",
    ].join('\n')
    expect([...pushedToTabs(probe).keys()].sort()).toEqual(['first', 'second'])
  })

  test('nothing is pushed to tabs that no content script receives', () => {
    const orphans = [...pushed.entries()]
      .filter(([t]) => !handled.has(t))
      .map(([t, lines]) => `${t} — pushed from background.js:${[...new Set(lines)].join(', ')}`)
    expect(
      orphans,
      'broadcast to every tab with nobody listening — silent, and it makes the feature look wired',
    ).toEqual([])
  })
})
