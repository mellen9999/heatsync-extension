/**
 * Ratchet: no start-once timer guard may sit on a timer a channel switch kills.
 *
 * fullSpaReinit() (spa-nav.js) drains every timer registered through the
 * multichat `cleanup` object except the page timers (cleanup.setPageTimeout /
 * setPageInterval / setPageIntervalIfVisible), then re-runs init(). A module
 * variable that holds a timer handle and is also tested as a guard
 *
 *     let t = null
 *     function start() { if (t) return; t = cleanup.setInterval(poll, 5000) }
 *
 * keeps its dead handle: `t` stays truthy, start() returns early forever, and
 * the poll is gone until a page refresh. That was the whole class behind the
 * stale-twitch-chat, dead auto-claim, lost-persist and stuck-pin bugs.
 *
 * The scan runs over src/multichat as ONE scope (build.js concatenates it, so a
 * `let` in one file is read and nulled from another). A top-level let/var that
 * is assigned from cleanup.setTimeout / setInterval / setIntervalIfVisible AND
 * is tested as a guard (`if (x)`, `if (!x)`, `x ||`, `x &&`, `x ?`, `|| x)`) fails
 * unless one of these holds:
 *   - every such assignment uses a setPage* variant (the timer survives), or
 *   - fullSpaReinit nulls it (the timer's work is the panel's; init() restarts it), or
 *   - it is in ALLOWED below, with the reason.
 * `if (x) clearTimeout(x)` is not a guard: clear-then-set re-arms whatever
 * happens, a dead handle clears as a no-op.
 *
 * The fix for a failure is one of the first two. Do not add to ALLOWED to make
 * the test pass; add to it only when the guard is provably harmless.
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const MC = join(import.meta.dir, '..', 'src', 'multichat')

// name -> why a guarded, drainable handle is still safe. Each entry is checked
// to still be live (an entry that stops matching anything fails the test).
const ALLOWED = {
  // (empty on purpose: every guarded timer in the tree is a page timer or is nulled on reinit)
}

const PLAIN = 'cleanup\\.set(?:Timeout|Interval|IntervalIfVisible)\\('
const PAGE = 'cleanup\\.setPage(?:Timeout|Interval|IntervalIfVisible)\\('

// comments out, same length of newlines kept so line numbers still line up
function strip(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:\\'"`\w])\/\/.*$/gm, '$1')
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length
const esc = (name) => name.replace(/\$/g, '\\$')

/**
 * files: [{ name, src }] in one shared scope; reinitSrc: the text of fullSpaReinit.
 * Returns one row per top-level variable that holds a cleanup timer handle AND is guard-tested.
 */
export function scanTimerSentinels(files, reinitSrc) {
  const stripped = files.map((f) => ({ name: f.name, text: strip(f.src) }))
  const reinit = strip(reinitSrc)
  const names = new Set()
  for (const f of stripped) for (const m of f.text.matchAll(/^(?:let|var)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1])

  const rows = []
  for (const name of names) {
    const X = esc(name)
    const assign = (kind) => new RegExp(`(?<![\\w$.])${X}\\s*=\\s*${kind}`, 'g')
    const plain = []
    let page = 0
    for (const f of stripped) {
      for (const m of f.text.matchAll(assign(PLAIN))) plain.push(`${f.name}:${lineOf(f.text, m.index)}`)
      page += [...f.text.matchAll(assign(PAGE))].length
    }
    if (!plain.length && !page) continue

    const clearFirst = new RegExp(
      `if\\s*\\(\\s*${X}\\s*\\)\\s*\\{?\\s*(?:cleanup\\.)?clear(?:Timeout|Interval)\\(\\s*${X}\\s*\\)`,
      'y',
    )
    const guardRes = [
      new RegExp(`if\\s*\\(\\s*!?\\s*${X}\\s*(?:\\)|&&|\\|\\||\\?(?!\\.))`, 'g'),
      new RegExp(`(?<![\\w$.!=])!\\s*${X}(?![\\w$.(\\[])`, 'g'),
      new RegExp(`(?<![\\w$.])${X}\\s*(?:\\|\\||&&|\\?(?!\\.))`, 'g'),
      new RegExp(`(?:&&|\\|\\|)\\s*${X}\\s*\\)`, 'g'),
    ]
    const guards = []
    for (const f of stripped) {
      for (const re of guardRes) {
        for (const m of f.text.matchAll(re)) {
          clearFirst.lastIndex = m.index
          if (clearFirst.test(f.text)) continue
          guards.push(`${f.name}:${lineOf(f.text, m.index)}`)
        }
      }
    }
    if (!guards.length) continue

    const nulled = new RegExp(`(?<![\\w$.])${X}\\s*=\\s*null\\b`).test(reinit)
    const status = !plain.length ? 'page' : nulled ? 'nulled' : name in ALLOWED ? 'allowed' : 'BAD'
    rows.push({ name, status, plain, guards })
  }
  return rows
}

function readTree(dir) {
  const out = []
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (p.endsWith('.js')) out.push({ name: relative(MC, p), src: readFileSync(p, 'utf8') })
    }
  }
  walk(dir)
  return out
}

function reinitOf(files) {
  const spa = files.find((f) => f.name === 'spa-nav.js').src
  const at = spa.indexOf('function fullSpaReinit(')
  if (at === -1) throw new Error('fullSpaReinit not found in spa-nav.js')
  return spa.slice(at, spa.indexOf('\n}\n', at) + 3)
}

const FILES = readTree(MC)
const ROWS = scanTimerSentinels(FILES, reinitOf(FILES))

describe('drained timers: a start-once guard never sits on a handle the channel switch kills', () => {
  test('every guarded cleanup timer is a page timer or is nulled in fullSpaReinit', () => {
    const bad = ROWS.filter((r) => r.status === 'BAD').map(
      (r) =>
        `${r.name}: set at ${r.plain.join(', ')}, guarded at ${r.guards.slice(0, 3).join(', ')}` +
        ' (use cleanup.setPage*, or null it in fullSpaReinit)',
    )
    expect(bad, `drainable timer handles used as sentinels:\n${bad.join('\n')}`).toEqual([])
  })

  test('the scan sees the real tree (it has not silently gone blind)', () => {
    expect(FILES.length).toBeGreaterThan(80)
    const by = (s) => ROWS.filter((r) => r.status === s).length
    // known members of each safe class, so a regex that stops matching fails here
    const get = (n) => ROWS.find((r) => r.name === n)?.status
    expect(get('_tapPollTimer')).toBe('page')
    expect(get('_nsBeatTimer')).toBe('page')
    expect(get('hsPaintBatchTimer')).toBe('page')
    expect(get('liveStatusInterval')).toBe('nulled')
    expect(get('mcCosmeticsTimer')).toBe('nulled')
    expect(by('page')).toBeGreaterThan(15)
    expect(by('nulled')).toBeGreaterThan(5)
  })

  test('the allowlist holds no stale entries', () => {
    const live = new Set(ROWS.filter((r) => r.status === 'allowed').map((r) => r.name))
    for (const name of Object.keys(ALLOWED)) {
      expect(live.has(name), `${name} is allowlisted but no longer a guarded drainable timer — delete it`).toBe(true)
      expect(ALLOWED[name].length, `${name} needs a one-line reason`).toBeGreaterThan(8)
    }
  })

  // the scanner itself, on small made-up scopes
  const reinit = (body) => `function fullSpaReinit() {\n${body}\n}\n`
  const scan = (src, body = '') => scanTimerSentinels([{ name: 'x.js', src }], reinit(body))
  const status = (src, body) => scan(src, body)[0]?.status

  test('flags the start-once pattern on a plain cleanup timer', () => {
    const src = 'let t = null\nfunction go() {\n  if (t) return\n  t = cleanup.setInterval(poll, 5000)\n}\n'
    expect(status(src)).toBe('BAD')
    expect(status(src.replace('setInterval', 'setIntervalIfVisible'))).toBe('BAD')
  })

  test('flags every guard form', () => {
    const set = (guard) => `let t = null\nfunction go() {\n  ${guard}\n  t = cleanup.setTimeout(f, 1)\n}\n`
    for (const g of [
      'if (t) return',
      'if (!t) {}',
      'if (a && !t) {}',
      'if (a || t) {}',
      'x = t ? 1 : 2',
      'const y = t || 3',
    ]) {
      expect(status(set(g)), g).toBe('BAD')
    }
  })

  test('passes a page timer, however it is guarded', () => {
    const src = 'let t = null\nfunction go() {\n  if (t) return\n  t = cleanup.setPageTimeout(f, 1)\n}\n'
    expect(status(src)).toBe('page')
    expect(status(src.replace('setPageTimeout', 'setPageIntervalIfVisible'))).toBe('page')
  })

  test('one plain assignment among page ones still fails', () => {
    const src =
      'let t = null\nfunction a() {\n  if (t) return\n  t = cleanup.setPageTimeout(f, 1)\n}\nfunction b() {\n  t = cleanup.setTimeout(f, 1)\n}\n'
    expect(status(src)).toBe('BAD')
  })

  test('passes a handle fullSpaReinit nulls', () => {
    const src = 'let t = null\nfunction go() {\n  if (t) return\n  t = cleanup.setTimeout(f, 1)\n}\n'
    expect(status(src, '  t = null')).toBe('nulled')
    expect(status(src, '  other = null')).toBe('BAD')
  })

  test('clear-then-set is not a guard, in either layout', () => {
    expect(
      scan('let t = null\nfunction go() {\n  if (t) cleanup.clearTimeout(t)\n  t = cleanup.setTimeout(f, 1)\n}\n'),
    ).toEqual([])
    expect(
      scan(
        'let t = null\nfunction go() {\n  if (t) {\n    cleanup.clearTimeout(t)\n    t = null\n  }\n  t = cleanup.setTimeout(f, 1)\n}\n',
      ),
    ).toEqual([])
  })

  test('a handle that is never tested is fine, and so is a commented-out guard', () => {
    expect(scan('let t = null\nfunction go() {\n  t = cleanup.setTimeout(f, 1)\n}\n')).toEqual([])
    expect(scan('let t = null\nfunction go() {\n  // if (t) return\n  t = cleanup.setTimeout(f, 1)\n}\n')).toEqual([])
  })

  test('reads the guard from another file, as the one-scope bundle does', () => {
    const rows = scanTimerSentinels(
      [
        { name: 'a.js', src: 'let t = null\nfunction go() {\n  t = cleanup.setInterval(f, 1)\n}\n' },
        { name: 'b.js', src: 'function tab() {\n  if (!t) go()\n}\n' },
      ],
      reinit(''),
    )
    expect(rows.map((r) => [r.name, r.status])).toEqual([['t', 'BAD']])
    expect(rows[0].guards[0]).toBe('b.js:2')
  })
})
