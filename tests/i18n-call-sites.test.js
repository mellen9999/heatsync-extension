// Every t('key', [...]) call must pass exactly as many substitutions as the
// message declares placeholders. chrome.i18n returns '' on a mismatch, which
// used to render the RAW KEY in the UI; t() now falls back to the bare template,
// so a mismatch is invisible instead of loud — which is exactly why it needs a
// test. Caught mc_emote_blocked (tooltip copy, zero placeholders) being called
// with an emote name from two toast sites.
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const EN = JSON.parse(readFileSync(join(ROOT, 'src', '_locales', 'en', 'messages.json'), 'utf8'))

function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    const st = statSync(p)
    // chrome/multichat-*.js are build output — concatenations of src/multichat.
    if (st.isDirectory()) {
      if (f !== 'node_modules' && f !== '_locales') walk(p, out)
    } else if (f.endsWith('.js') && !/^multichat(-\w+)?\.js$/.test(f)) {
      out.push(p)
    }
  }
  return out
}

const FILES = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'chrome'))]

function countArgs(argStr) {
  const s = argStr.trim()
  if (!s) return 0
  let depth = 0
  let n = 1
  for (const ch of s) {
    if ('([{'.includes(ch)) depth++
    else if (')]}'.includes(ch)) depth--
    else if (ch === ',' && depth === 0) n++
  }
  return n
}

describe('t() call sites match their messages', () => {
  const sites = []
  for (const f of FILES) {
    const src = readFileSync(f, 'utf8')
    for (const m of src.matchAll(/\bt\('([a-z0-9_]+)',\s*\[([^\]]*)\]/g)) {
      sites.push({ file: f.replace(ROOT + '/', ''), key: m[1], args: countArgs(m[2]) })
    }
  }

  test('the scan actually found call sites (guards against a dead regex)', () => {
    expect(sites.length).toBeGreaterThan(50)
  })

  test('every key exists in the default locale', () => {
    const missing = sites.filter((s) => !EN[s.key]).map((s) => `${s.file}: ${s.key}`)
    expect(missing).toEqual([])
  })

  // Too FEW substitutions is the harmful direction: chrome.i18n returns '' and
  // the UI used to render the raw key (t() now falls back to the bare template,
  // so the user sees a literal "$NAME$" instead — quieter, still wrong).
  // Extra substitutions are harmless: unreferenced ones are simply ignored.
  test('no call site under-supplies substitutions', () => {
    const bad = []
    for (const s of sites) {
      const msg = EN[s.key]?.message
      if (msg == null) continue
      const need = new Set([...msg.matchAll(/\$([A-Z0-9_]+)\$/g)].map((m) => m[1])).size
      if (s.args < need) bad.push(`${s.file}: t('${s.key}', ${s.args} arg(s)) but message needs ${need} — "${msg}"`)
    }
    expect(bad).toEqual([])
  })
})
