/**
 * A copy only says "copied" when the text is really on the clipboard. The async clipboard refuses
 * when the page isn't focused or the site's permissions policy says no; the menus used to fire it
 * without waiting and say "copied" anyway, or say nothing at all. HS.copyText is the one write and
 * answers true/false; every copy in a content script goes through it.
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'

const ROOT = join(import.meta.dir, '..')
const SRC = readFileSync(join(ROOT, 'src', 'content', 'shared-utils.js'), 'utf8')

function load({ writeText, execOk = true }) {
  const copied = []
  const focused = []
  const ta = { style: {}, setAttribute() {}, select() {}, remove() {}, value: '' }
  const prev = { focus: () => focused.push('input') }
  const document = {
    activeElement: prev,
    createElement: () => ta,
    body: { appendChild() {} },
    execCommand: (cmd) => {
      if (cmd === 'copy' && execOk) copied.push(ta.value)
      return execOk
    },
    addEventListener() {},
  }
  const ctx = { chrome: {}, document, navigator: writeText ? { clipboard: { writeText } } : {} }
  ctx.window = ctx
  ctx.globalThis = ctx
  ctx.addEventListener = () => {}
  vm.createContext(ctx)
  vm.runInContext(SRC, ctx, { filename: 'shared-utils.js' })
  return { copyText: ctx.window.HS.copyText, copied, focused }
}

describe('HS.copyText', () => {
  test('true when the clipboard takes it', async () => {
    const got = []
    const { copyText } = load({ writeText: async (s) => got.push(s) })
    expect(await copyText('kappa')).toBe(true)
    expect(got).toEqual(['kappa'])
  })

  test('a refused clipboard falls back to a selection copy and hands focus back', async () => {
    const { copyText, copied, focused } = load({
      writeText: () => Promise.reject(new DOMException('Document is not focused', 'NotAllowedError')),
    })
    expect(await copyText('kappa')).toBe(true)
    expect(copied).toEqual(['kappa'])
    expect(focused).toEqual(['input'])
  })

  test('false, never a throw, when both ways are refused or there is no clipboard api', async () => {
    const refused = load({ writeText: () => Promise.reject(new Error('no')), execOk: false })
    expect(await refused.copyText('kappa')).toBe(false)
    const none = load({ writeText: null, execOk: false })
    expect(await none.copyText('kappa')).toBe(false)
  })

  test('nothing to copy is not a copy', async () => {
    const { copyText } = load({ writeText: async () => {} })
    expect(await copyText('')).toBe(false)
    expect(await copyText(undefined)).toBe(false)
  })
})

// The extension pages (popup) await the api themselves; the MAIN-world autocomplete hook can't see
// HS. Every other surface goes through HS.copyText.
const OWN_WRITE = new Set(['src/content/shared-utils.js', 'src/content/popup.js', 'src/content/autocomplete-hook.js'])

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.js')) out.push(p)
  }
  return out
}

test('no content script writes the clipboard behind HS.copyText', () => {
  const stray = walk(join(ROOT, 'src'))
    .map((p) => p.slice(ROOT.length + 1))
    .filter((p) => !OWN_WRITE.has(p))
    .filter((p) => /clipboard\.write(Text)?\(|execCommand\(\s*['"]copy/.test(readFileSync(join(ROOT, p), 'utf8')))
  expect(stray).toEqual([])
})
