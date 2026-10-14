/**
 * Bundle-size gate — run after `bun run build.js chrome --minify` and
 * `bun run build.js firefox --minify`.
 *
 *   bun scripts/check-bundle-budget.ts            # judge dist/ against scripts/bundle-budgets.json
 *   bun scripts/check-bundle-budget.ts --measure  # print the budgets file for the current build
 *
 * Every shipped top-level file (scripts, css, html, manifest, icons) has its own
 * budget per browser, plus two totals over the whole folder: raw bytes, and
 * zip (each file deflated on its own, as a zip stores it). A shipped file with
 * no budget fails too, so a new entry cannot ride in unmeasured.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { deflateRawSync } from 'node:zlib'

const root = join(import.meta.dir, '..')
const BUDGETS = join(import.meta.dir, 'bundle-budgets.json')
const BROWSERS = ['chrome', 'firefox']
const HEADROOM = 0.02 // 2%, floor 256B: room for ordinary growth, not for a pasted dependency

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}

function measure(browser: string): Record<string, number> {
  const dir = join(root, 'dist', browser)
  const out: Record<string, number> = {}
  let raw = 0
  let zip = 0
  for (const p of walk(dir)) {
    const buf = readFileSync(p)
    raw += buf.length
    zip += deflateRawSync(buf).length
    const rel = relative(dir, p)
    if (!rel.includes('/')) out[rel] = buf.length // _locales roll into the totals
  }
  out['total raw'] = raw
  out['total zip'] = zip
  return out
}

const measured: Record<string, Record<string, number>> = {}
for (const b of BROWSERS) {
  try {
    measured[b] = measure(b)
  } catch {
    console.error(`no dist/${b} — run: bun run build.js ${b} --minify`)
    process.exit(1)
  }
}

if (process.argv.includes('--measure')) {
  const out: Record<string, any> = {
    _: `bytes, measured ${new Date().toISOString().slice(0, 10)} + ${HEADROOM * 100}% headroom (min 256B). lower to measured, never raise to go green; a raise needs the reason in its commit.`,
  }
  for (const b of BROWSERS) {
    out[b] = Object.fromEntries(
      Object.entries(measured[b]).map(([k, v]) => [k, v + Math.max(256, Math.ceil(v * HEADROOM))]),
    )
  }
  console.log(JSON.stringify(out, null, 2))
  process.exit(0)
}

const budgets = JSON.parse(readFileSync(BUDGETS, 'utf8'))
const over: string[] = []
for (const b of BROWSERS) {
  console.log(`── ${b}`)
  const want: Record<string, number> = budgets[b] ?? {}
  for (const [name, bytes] of Object.entries(measured[b])) {
    const max = want[name]
    if (max === undefined) {
      over.push(`${b}/${name} has no budget (${bytes}B) — add it to scripts/bundle-budgets.json`)
      continue
    }
    const slack = max - bytes
    const ok = slack >= 0
    if (!ok) over.push(`${b}/${name} is ${-slack}B over its budget (${bytes}B, budget ${max}B)`)
    console.log(`${ok ? '✓' : '✗'} ${name}: ${bytes}B, slack ${slack}B`)
  }
  for (const name of Object.keys(want)) {
    if (!(name in measured[b])) over.push(`${b}/${name} is budgeted but no longer shipped — remove it from the budgets file`)
  }
  const slacks = Object.entries(measured[b]).map(([n, v]) => [n, (want[n] ?? 0) - v] as const)
  const tightest = slacks.sort((a, c) => a[1] - c[1])[0]
  console.log(`  ${slacks.length} entries; tightest slack: ${tightest[0]} ${tightest[1]}B`)
}

if (over.length) {
  console.error(`\nbundle over budget:\n  ${over.join('\n  ')}`)
  console.error('lower the code, not the gate. a raise needs the reason in its commit.')
  process.exit(1)
}
console.log('bundle budget ok')
