import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// A raw NUL byte in a source file makes grep and ripgrep call the whole file
// binary and skip it, so every audit and every source-reading test goes blind
// on it. main.js — the twitch + kick message handlers — carried one in a
// template literal. Write the escape (`\0`), never the byte.
const ROOT = join(import.meta.dir, '..')

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(js|ts|json|css|html)$/.test(name)) out.push(full)
  }
  return out
}

const files = [
  ...walk(join(ROOT, 'src')),
  ...walk(join(ROOT, 'tests')),
  ...walk(join(ROOT, 'scripts')),
  ...readdirSync(join(ROOT, 'chrome'))
    .filter((n) => /\.(js|html)$/.test(n))
    .map((n) => join(ROOT, 'chrome', n)),
]

describe('sources carry no raw NUL byte', () => {
  test('every source file is text to grep', () => {
    const hits = files.filter((f) => readFileSync(f).includes(0)).map((f) => f.slice(ROOT.length + 1))
    expect(hits).toEqual([])
  })
})
