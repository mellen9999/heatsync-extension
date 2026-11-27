// Finds the MutationObservers that watch a whole document, by reading source (no DOM).
// "whole document" = the target is `document`, `document.documentElement`, `document.body`, or a
// fallback chain that can end on one of those (`getElementById('root') || document.body`), seen
// through one `const x = ...` or `list.push(...)` hop, AND the options say `subtree: true`.
// Used by tests/no-whole-document-observers.test.js, which owns the allowlist.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

/** comments out, same length, so offsets and line numbers still line up */
export function blank(src) {
  const gap = (s) => s.replace(/[^\n]/g, ' ')
  return src.replace(/\/\*[\s\S]*?\*\//g, gap).replace(/(^|[^:\\'"`])\/\/[^\n]*/g, (m, p) => p + gap(m.slice(p.length)))
}

/** the text inside the bracket that opens at `at`, and where it closes */
function balanced(src, at) {
  let depth = 0
  let quote = ''
  for (let i = at; i < src.length; i++) {
    const c = src[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = ''
      continue
    }
    if (c === "'" || c === '"' || c === '`') quote = c
    else if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') {
      depth--
      if (depth === 0) return { text: src.slice(at + 1, i), end: i }
    }
  }
  return null
}

/** split on commas that sit at the top level of the argument list */
function splitArgs(text) {
  const out = []
  let depth = 0
  let quote = ''
  let from = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = ''
      continue
    }
    if (c === "'" || c === '"' || c === '`') quote = c
    else if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') depth--
    else if (c === ',' && depth === 0) {
      out.push(text.slice(from, i))
      from = i + 1
    }
  }
  out.push(text.slice(from))
  return out.map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean)
}

const IDENT = /^[A-Za-z_$][\w$]*$/

/** does this expression, read literally, name a whole document? */
function literalWholeDoc(expr) {
  for (const m of expr.matchAll(/\bdocument\b(?:\s*\.\s*(\w+))?/g)) {
    if (!m[1] || m[1] === 'documentElement' || m[1] === 'body' || m[1] === 'scrollingElement') return true
  }
  return false
}

const esc = (s) => s.replace(/[$]/g, '\\$')

/** the right-hand sides the file ever gives `name`, and the things pushed into an array of that name */
function sources(src, name) {
  const n = esc(name)
  const out = []
  for (const m of src.matchAll(new RegExp(`(?:^|[^.\\w$])${n}\\s*=(?!=)\\s*([^\\n;]+)`, 'g'))) out.push(m[1])
  for (const m of src.matchAll(new RegExp(`\\b${n}\\.push\\(([^)\\n]*)\\)`, 'g'))) out.push(m[1])
  for (const m of src.matchAll(new RegExp(`for\\s*\\(\\s*(?:const|let)\\s+${n}\\s+of\\s+([\\w$]+)\\s*\\)`, 'g')))
    out.push(m[1])
  return out
}

function wholeDoc(src, expr, depth = 0) {
  if (literalWholeDoc(expr)) return true
  if (depth >= 3) return false
  const ids = IDENT.test(expr) ? [expr] : []
  // a chain of plain names: `a || b || c`
  for (const part of expr.split('||').map((s) => s.trim())) if (IDENT.test(part) && !ids.includes(part)) ids.push(part)
  return ids.some((id) => sources(src, id).some((s) => wholeDoc(src, s, depth + 1)))
}

/** the options text, looking one `const opts = {...}` hop back */
function optionsText(src, arg) {
  if (!arg) return ''
  if (!IDENT.test(arg)) return arg
  const m = new RegExp(`(?:const|let|var)\\s+${esc(arg)}\\s*=\\s*\\{`).exec(src)
  if (!m) return ''
  const open = m.index + m[0].length - 1
  const b = balanced(src, open)
  return b ? src.slice(open, b.end + 1) : ''
}

/**
 * @param {string} src one file's text
 * @returns {{ line: number, target: string }[]} each whole-document subtree observe() call
 */
export function wholeDocObserversIn(src) {
  const code = blank(src)
  const hits = []
  for (const m of code.matchAll(/\.observe\(/g)) {
    const open = m.index + m[0].length - 1
    const b = balanced(code, open)
    if (!b) continue
    const [target, opts] = splitArgs(b.text)
    if (!target || !opts) continue // ResizeObserver / IntersectionObserver take no options
    if (!/\bsubtree\s*:\s*true\b/.test(optionsText(code, opts))) continue
    if (!wholeDoc(code, target)) continue
    hits.push({ line: code.slice(0, m.index).split('\n').length, target })
  }
  return hits
}

/** every whole-document subtree observer under `dir`, as { file (relative to root), line, target } */
export function wholeDocObservers(root, dir = 'src') {
  const out = []
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(js|mjs|ts)$/.test(e.name)) {
        for (const h of wholeDocObserversIn(readFileSync(p, 'utf8'))) {
          out.push({ file: relative(root, p), ...h })
        }
      }
    }
  }
  walk(join(root, dir))
  return out
}
