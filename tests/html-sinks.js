// Finds every place the extension turns a string into live HTML, and says
// whether that string provably comes from constants and the escape helpers.
//
// Sinks: `x.innerHTML = e`, `x.innerHTML += e`, `x.outerHTML = e`,
// `x.insertAdjacentHTML(pos, e)`, `range.createContextualFragment(e)`,
// `new DOMParser().parseFromString(e, 'text/html')`, `x.setHTMLUnsafe(e)`,
// `document.write(e)`, and `x.srcdoc = e`.
//
// "Guarded" means the expression `e` is built only from:
//   - string / template literals, numbers, booleans, null
//   - calls to the escape helpers (escapeHtml, safeUrl, sanitizeColor …): whatever
//     goes in, what comes out is inert
//   - numeric-by-construction values: `.length`, `.size`, arithmetic, Number()/
//     Math.*/parseInt(), `.toFixed()`, Date getters, a `for (let i = 0; …)` counter
//   - t()/bgT() i18n lookups and String() over guarded parts
//   - `+`, `?:`, `||`, `??`, `&&`, `typeof` and parentheses over guarded parts
//   - string methods that only cut/trim/case/repeat a guarded string
//   - `list.map(fn).join('')` / `[…].join('')` where each piece is guarded
//   - `x.replace(/[^a-z0-9_-]/g, '')` (a global strip to a safe class) and escapeHtml spelled
//     out inline as a `.replace` chain
//   - `guarded.replace(re, guarded)`: re-shaping a guarded string with guarded text
//   - a read out of a constant table (a module-level object/array literal of literals)
//   - a property of an object a builder returns (`paint.cls` where the builder's returns are
//     object literals), and `const { a, b } = builder()`
//   - TRUSTED_RENDERERS / PASS_THROUGH names (each has a hostile-input test that runs it)
//   - a parse into a `<template>` that is only read back, or a DOMParser document that is only
//     queried, is "inert" (no script runs, nothing loads) and is not counted
//   - a call to an in-repo function whose every `return` is guarded WHEN ITS
//     PARAMETERS ARE BOUND TO THE ARGUMENTS ACTUALLY PASSED (a builder that
//     interpolates a raw parameter is guarded only for callers that pass
//     guarded arguments)
//   - an identifier whose every assignment in scope is guarded, or a
//     module-level const that is
// A bundle-global `let` is judged by every value any file assigns to it, and a callback by the
// arguments of the call chain it runs in. Anything else — a bare parameter, a property read
// off data, an unknown call —
// is unguarded, even if it happens to be safe today. Guarded-by-construction is
// the point: the next edit cannot quietly make it unsafe without the test
// noticing. It is a ratchet, not a proof: it reads syntax, not types.
//
// Uses the TypeScript parser only to get a syntax tree (no type checking).
import { readFileSync } from 'node:fs'
import ts from 'typescript'

/**
 * helpers whose output is safe in HTML text AND inside a quoted attribute. Only names that are
 * defined in this repo as real escapers: a name added here is trusted everywhere, so a weaker
 * look-alike (escapeTextHtml escapes `& < >` but not quotes) does not belong.
 */
export const ESCAPE_HELPERS = new Set([
  'escapeHtml', // src/lib/utils.js (and the identical copies in chrome/chat-injector.js, chrome/heatsync-button.js)
  'safeUrl', // http(s) only, returns the parsed href
  'sanitizeColor', // hex only
  'sanitizeEmbedId', // [A-Za-z0-9_-] only
  'encodeURIComponent',
  '_hsmEsc', // name-marks.js's private copy of escapeHtml
])
/** renderers that escape nothing themselves: their output is safe exactly when their first argument is (tests/process-emotes-hostile.test.js) */
export const PASS_THROUGH = new Set(['processEmotes'])
/**
 * Shared-lib renderers whose OUTPUT is safe for any input: they escape what they are
 * handed and print the rest as numbers. src/lib is mirrored byte-for-byte with the
 * site, so it can't be reshaped to be provable here — each name below has a hostile-
 * input test (paintNameHtmlFor: tests/html-sink-ratchet.test.js) that runs the real function.
 */
export const TRUSTED_RENDERERS = new Set(['paintNameHtmlFor'])
const NUMERIC_CALLS = new Set(['Number', 'parseInt', 'parseFloat', 'Boolean', 'Date.now'])
const NUMERIC_METHODS = new Set([
  'toFixed',
  'toLocaleString',
  'toLocaleTimeString',
  'toLocaleDateString',
  'getHours',
  'getMinutes',
  'getSeconds',
  'getTime',
  'getFullYear',
  'getMonth',
  'getDate',
  'getDay',
  'indexOf',
  'charCodeAt',
])
/** string methods that only cut, trim, re-case or repeat their receiver */
const CUT_METHODS = new Set([
  'toString',
  'slice',
  'substring',
  'substr',
  'trim',
  'trimStart',
  'trimEnd',
  'repeat',
  'toLowerCase',
  'toUpperCase',
])
const PAD_METHODS = new Set(['padStart', 'padEnd'])
/** `.replace(/[^a-z0-9_-]/g, '')`: a global strip down to letters, digits, `_` and `-` */
const STRIP_RE = /^\/\[\^((?:[a-zA-Z0-9_]|[a-zA-Z0-9]-[a-zA-Z0-9]|-)+)\]\+?\/(\w*)$/
function stripsToSafeClass(call) {
  const [re, rep] = call.arguments
  if (!re || !rep || !ts.isRegularExpressionLiteral(re) || !ts.isStringLiteralLike(rep) || rep.text !== '') return false
  const m = STRIP_RE.exec(re.getText())
  return !!m && m[2].includes('g')
}

/**
 * `x.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')`:
 * escapeHtml spelled out inline. `&` must run first or the entities it writes get escaped again.
 */
const ENTITY_OF = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
function isInlineEscaper(node) {
  const seen = []
  let n = unwrap(node)
  while (
    ts.isCallExpression(n) &&
    ts.isPropertyAccessExpression(n.expression) &&
    n.expression.name.text === 'replace'
  ) {
    const [re, rep] = n.arguments
    if (!re || !rep || !ts.isRegularExpressionLiteral(re) || !ts.isStringLiteralLike(rep)) return false
    const m = /^\/(.)\/(\w*)$/.exec(re.getText())
    if (!m?.[2].includes('g') || ENTITY_OF[m[1]] !== rep.text) return false
    seen.unshift(m[1])
    n = unwrap(n.expression.expression)
  }
  return seen[0] === '&' && Object.keys(ENTITY_OF).every((c) => seen.includes(c))
}
const I18N_CALLS = new Set(['t', 'bgT'])
const GET_URL = /^(chrome|browser|api)\.runtime\.getURL$/

const SINK_PROPS = new Set(['innerHTML', 'outerHTML', 'srcdoc'])
const SINK_CALLS = new Map([
  ['insertAdjacentHTML', 1],
  ['createContextualFragment', 0],
  ['parseFromString', 0],
  ['setHTMLUnsafe', 0],
  ['write', 0],
  ['writeln', 0],
])

const K = ts.SyntaxKind

const unwrap = (n) => {
  while (n && (ts.isParenthesizedExpression(n) || ts.isNonNullExpression(n))) n = n.expression
  return n
}

const calleeName = (n) => {
  const e = n.expression
  if (ts.isIdentifier(e)) return e.text
  if (ts.isPropertyAccessExpression(e)) {
    const base = unwrap(e.expression)
    if (ts.isIdentifier(base)) return `${base.text}.${e.name.text}`
    if (ts.isPropertyAccessExpression(base) && ts.isIdentifier(unwrap(base.expression))) {
      return `${unwrap(base.expression).text}.${base.name.text}.${e.name.text}`
    }
    return `.${e.name.text}`
  }
  return ''
}

function propName(n) {
  if (ts.isPropertyAccessExpression(n)) return n.name.text
  if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression)) return n.argumentExpression.text
  return null
}

const isFn = (n) =>
  ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n)

/** names bound by a binding name / pattern */
function boundNames(b, out = []) {
  if (ts.isIdentifier(b)) out.push(b.text)
  else if (ts.isBindingElement(b)) boundNames(b.name, out)
  else if (ts.isObjectBindingPattern(b) || ts.isArrayBindingPattern(b)) for (const e of b.elements) boundNames(e, out)
  return out
}

/** return expressions of a function (arrow with expression body, or block with returns) */
function returnsOf(fn) {
  if (!fn.body) return null
  if (!ts.isBlock(fn.body)) return [fn.body]
  const rs = []
  const visit = (n) => {
    if (isFn(n)) return
    if (ts.isReturnStatement(n)) rs.push(n.expression || null)
    ts.forEachChild(n, visit)
  }
  visit(fn.body)
  return rs
}

/** where `name` is declared as seen from `use`, walking outward through real scopes */
function bindingOf(name, use) {
  for (let n = use.parent; n; n = n.parent) {
    if (isFn(n)) {
      const index = n.parameters.findIndex((p) => boundNames(p.name).includes(name))
      if (index >= 0) return { kind: 'param', fn: n, index, scope: n }
    }
    if (ts.isCatchClause(n) && n.variableDeclaration && boundNames(n.variableDeclaration.name).includes(name)) {
      return { kind: 'unknown' }
    }
    if (ts.isForOfStatement(n) || ts.isForInStatement(n)) {
      const init = n.initializer
      if (ts.isVariableDeclarationList(init) && init.declarations.some((d) => boundNames(d.name).includes(name))) {
        return { kind: 'unknown' }
      }
    }
    let decls = null
    if (ts.isBlock(n) || ts.isSourceFile(n) || ts.isModuleBlock(n)) decls = n.statements
    else if (ts.isCaseClause(n) || ts.isDefaultClause(n)) decls = n.statements
    else if (ts.isForStatement(n) && n.initializer && ts.isVariableDeclarationList(n.initializer)) {
      for (const d of n.initializer.declarations) {
        if (boundNames(d.name).includes(name)) return { kind: 'var', decl: d, scope: n }
      }
    }
    if (decls) {
      for (const st of decls) {
        if (ts.isVariableStatement(st)) {
          for (const d of st.declarationList.declarations) {
            if (boundNames(d.name).includes(name)) return { kind: 'var', decl: d, scope: n }
          }
        } else if (ts.isFunctionDeclaration(st) && st.name?.text === name) return { kind: 'fn', fn: st }
        else if (ts.isClassDeclaration(st) && st.name?.text === name) return { kind: 'unknown' }
      }
    }
  }
  return null
}

const ASSIGN_OPS = new Set([
  K.EqualsToken,
  K.PlusEqualsToken,
  K.BarBarEqualsToken,
  K.AmpersandAmpersandEqualsToken,
  K.QuestionQuestionEqualsToken,
])
/** compound assignments that always leave a number behind */
const NUMERIC_ASSIGN_OPS = new Set([
  K.MinusEqualsToken,
  K.AsteriskEqualsToken,
  K.SlashEqualsToken,
  K.PercentEqualsToken,
  K.AsteriskAsteriskEqualsToken,
  K.LessThanLessThanEqualsToken,
  K.GreaterThanGreaterThanEqualsToken,
  K.GreaterThanGreaterThanGreaterThanEqualsToken,
  K.AmpersandEqualsToken,
  K.BarEqualsToken,
  K.CaretEqualsToken,
])

/** every `name = e` / `name += e` under `scope`; `unknown` when it is written some way we cannot follow (destructuring target…) */
function assignmentsIn(scope, name) {
  const out = { assigns: [], unknown: false }
  const visit = (n) => {
    if (ts.isBinaryExpression(n) && ts.isIdentifier(n.left) && n.left.text === name) {
      const op = n.operatorToken.kind
      if (ASSIGN_OPS.has(op)) out.assigns.push(n.right)
      else if (!NUMERIC_ASSIGN_OPS.has(op)) {
        // `name + x`, `name === y`: a read, not a write
      }
    } else if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === K.EqualsToken &&
      (ts.isArrayLiteralExpression(n.left) || ts.isObjectLiteralExpression(n.left))
    ) {
      // `[a, b] = …`: a destructuring write we do not follow
      if (n.left.getText().includes(name)) out.unknown = true
    }
    ts.forEachChild(n, visit)
  }
  visit(scope)
  return out
}

/** Parse a set of files; `readSource` defaults to the disk. */
export function parseFiles(files, readSource = (f) => readFileSync(f, 'utf8')) {
  const parsed = new Map()
  for (const f of files)
    parsed.set(f, ts.createSourceFile(f, readSource(f), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS))
  return parsed
}

/**
 * Index the in-repo functions and module-level consts a classification may
 * need to look through. The multichat bundle (and the content scripts that
 * embed src/lib) is one scope with no imports, so a name resolves across files.
 */
export function buildIndex(parsed) {
  const fns = new Map() // name → function nodes
  const consts = new Map() // name → initializer nodes (top-level const)
  const lets = new Map() // name → initializer nodes (top-level let / var)
  // name → every value written to a bundle-global by an assignment anywhere (null = written some way we cannot follow).
  // The multichat bundle is one scope: a `let` declared in one file is assigned from any other.
  const writes = new Map()
  const add = (m, k, v) => {
    if (!m.has(k)) m.set(k, [])
    m.get(k).push(v)
  }
  for (const sf of parsed.values()) {
    const visit = (n) => {
      if (ts.isFunctionDeclaration(n) && n.name) add(fns, n.name.text, n)
      else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
        const init = unwrap(n.initializer)
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) add(fns, n.name.text, init)
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)
    for (const st of sf.statements) {
      if (!ts.isVariableStatement(st)) continue
      const isConst = st.declarationList.flags & ts.NodeFlags.Const
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer) add(isConst ? consts : lets, d.name.text, d.initializer)
        else if (!ts.isIdentifier(d.name)) for (const nm of boundNames(d.name)) add(writes, nm, null)
      }
    }
  }
  for (const sf of parsed.values()) {
    const visit = (n) => {
      if (ts.isBinaryExpression(n) && ts.isIdentifier(n.left)) {
        const op = n.operatorToken.kind
        if (ASSIGN_OPS.has(op)) {
          const b = bindingOf(n.left.text, n.left)
          if (!b || (b.kind === 'var' && ts.isSourceFile(b.scope))) add(writes, n.left.text, n.right)
        }
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)
  }
  return { fns, consts, lets, writes }
}

export function createClassifier(index) {
  const verdicts = new Map() // `${fnId}|${flags}` → boolean
  const inProgress = new Set()
  const frames = [] // { fn, flags } — the arguments a function body is being judged against
  const fnIds = new Map()
  const fnId = (fn) => {
    if (!fnIds.has(fn)) fnIds.set(fn, fnIds.size)
    return fnIds.get(fn)
  }
  /** the leaves that made the last classification fail, for the message a person reads */
  const fails = []
  let quiet = 0 // >0 while judging call arguments: a raw argument is a fact about the call, not yet a failure
  const fail = (node, why) => {
    if (!quiet && fails.length < 6) {
      const sf = node.getSourceFile()
      const text = node.getText(sf).replace(/\s+/g, ' ').slice(0, 70)
      fails.push(
        `${why} \`${text}\` (${sf.fileName.split('/').slice(-2).join('/')}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1})`,
      )
    }
    return false
  }

  /** how each argument of a call counts inside the callee: guarded, not, or an escape helper handed over by name ('E') */
  function argFlags(call, depth) {
    quiet++
    try {
      return call.arguments.map((a) => {
        const v = unwrap(a)
        return ts.isIdentifier(v) && ESCAPE_HELPERS.has(v.text) ? 'E' : safe(a, depth + 1)
      })
    } finally {
      quiet--
    }
  }

  /** a call to `esc(..)` where `esc` is a parameter every caller binds to an escape helper */
  function calleeIsEscaperParam(call) {
    if (!ts.isIdentifier(call.expression)) return false
    const b = bindingOf(call.expression.text, call.expression)
    if (b?.kind !== 'param') return false
    const frame = [...frames].reverse().find((f) => f.fn === b.fn)
    return frame?.flags[b.index] === 'E'
  }

  /** run `cb` with `fn`'s parameters bound to arguments of these safeties; memoised per fn/flags/tag */
  function inFrame(fn, flags, tag, cb) {
    // a callback closes over its enclosing function's parameters, so the verdict is only good for the
    // same call chain: the whole stack of frames is part of the key, not just this one
    const bits = (fl) => fl.map((f) => (f === 'E' ? 'E' : f ? 1 : 0)).join('')
    const key = `${frames.map((f) => `${fnId(f.fn)}:${bits(f.flags)}`).join('/')}>${fnId(fn)}:${bits(flags)}|${tag}`
    if (verdicts.has(key)) return verdicts.get(key)
    if (inProgress.has(key)) return false // recursion: not provable
    inProgress.add(key)
    frames.push({ fn, flags })
    let ok = false
    try {
      ok = cb()
    } finally {
      frames.pop()
      inProgress.delete(key)
    }
    verdicts.set(key, ok)
    return ok
  }

  /** is the function's return value guarded when called with arguments of these safeties? */
  function fnSafe(fn, flags, depth) {
    return inFrame(fn, flags, '', () => {
      const rs = returnsOf(fn)
      return !!rs && rs.length > 0 && rs.every((r) => r && safe(r, depth + 1))
    })
  }

  /**
   * Is property `prop` of the object `expr` evaluates to guarded? Follows a call to a
   * builder whose returns are object literals (`hsPaintRender(..)` → `{ cls, html, splitAttr }`),
   * `a ? b : null` / `a || b`, and a local holding either.
   */
  function objPropSafe(expr, prop, depth) {
    expr = unwrap(expr)
    if (!expr || depth > 40) return false
    if (ts.isObjectLiteralExpression(expr)) {
      for (const p of expr.properties) {
        if (ts.isSpreadAssignment(p)) return false
        const name = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) ? p.name.text : null
        if (name !== prop) continue
        if (ts.isShorthandPropertyAssignment(p)) return safe(p.name, depth + 1)
        if (ts.isPropertyAssignment(p)) return safe(p.initializer, depth + 1)
        return false
      }
      return true // not on the object: undefined
    }
    if (expr.kind === K.NullKeyword || (ts.isIdentifier(expr) && expr.text === 'undefined')) return true
    if (ts.isConditionalExpression(expr)) {
      return objPropSafe(expr.whenTrue, prop, depth + 1) && objPropSafe(expr.whenFalse, prop, depth + 1)
    }
    if (ts.isBinaryExpression(expr)) {
      const k = expr.operatorToken.kind
      if (k === K.BarBarToken || k === K.AmpersandAmpersandToken || k === K.QuestionQuestionToken) {
        return objPropSafe(expr.left, prop, depth + 1) && objPropSafe(expr.right, prop, depth + 1)
      }
      return false
    }
    if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
      const fns = resolveFns(expr.expression)
      if (!fns || fns.length === 0) return false
      const flags = argFlags(expr, depth)
      return fns.every((f) =>
        inFrame(f, flags, `.${prop}`, () => {
          const rs = returnsOf(f)
          return !!rs && rs.length > 0 && rs.every((r) => r && objPropSafe(r, prop, depth + 1))
        }),
      )
    }
    if (ts.isIdentifier(expr)) {
      const b = bindingOf(expr.text, expr)
      if (b?.kind !== 'var' || !ts.isIdentifier(b.decl.name)) return false
      const { assigns, unknown } = assignmentsIn(b.scope, expr.text)
      if (unknown) return false
      const all = [...(b.decl.initializer ? [b.decl.initializer] : []), ...assigns]
      return all.length > 0 && all.every((e) => objPropSafe(e, prop, depth + 1))
    }
    return false
  }

  function resolveFns(node) {
    node = unwrap(node)
    if (!node) return null
    if (isFn(node)) return [node]
    if (ts.isIdentifier(node)) {
      const b = bindingOf(node.text, node)
      if (b?.kind === 'fn') return [b.fn]
      if (b?.kind === 'var' && ts.isIdentifier(b.decl.name) && b.decl.initializer) {
        const init = unwrap(b.decl.initializer)
        if (isFn(init)) return [init]
      }
      if (!b) return index.fns.get(node.text) || null
    }
    return null
  }

  /** a list whose every element is guarded: [..], list.map(fn), list.filter(..), a local filled only with guarded pushes */
  function listSafe(node, depth) {
    node = unwrap(node)
    if (!node || depth > 40) return false
    if (ts.isArrayLiteralExpression(node)) return node.elements.every((e) => safe(e, depth + 1))
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const m = node.expression.name.text
      if (m === 'map') {
        const fns = resolveFns(node.arguments[0])
        // element unknown, index numeric
        return !!fns && fns.length > 0 && fns.every((f) => fnSafe(f, [false, true, false], depth))
      }
      if (m === 'filter' || m === 'slice' || m === 'concat' || m === 'reverse' || m === 'sort') {
        return listSafe(node.expression.expression, depth + 1)
      }
      return false
    }
    if (ts.isIdentifier(node)) {
      const b = bindingOf(node.text, node)
      if (b?.kind !== 'var' || !ts.isIdentifier(b.decl.name) || !b.decl.initializer) return false
      if (!listSafe(b.decl.initializer, depth + 1)) return false
      // every push() onto it carries guarded items
      let ok = true
      const visit = (n) => {
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
          const recv = unwrap(n.expression.expression)
          if (ts.isIdentifier(recv) && recv.text === node.text) {
            const m = n.expression.name.text
            if (m === 'push' || m === 'unshift') {
              if (!n.arguments.every((a) => safe(a, depth + 1))) ok = false
            } else if (
              ![
                'join',
                'map',
                'filter',
                'slice',
                'length',
                'forEach',
                'concat',
                'reverse',
                'sort',
                'indexOf',
                'includes',
              ].includes(m)
            ) {
              ok = false
            }
          }
        }
        ts.forEachChild(n, visit)
      }
      visit(b.scope)
      return ok
    }
    return false
  }

  /** a literal tree: object/array literals whose every leaf is a plain literal, or a name / table read that is itself one */
  function literalTree(node, depth = 0) {
    node = unwrap(node)
    if (!node || depth > 8) return false
    if (ts.isCallExpression(node) && calleeName(node) === 'Object.freeze' && node.arguments[0]) {
      return literalTree(node.arguments[0], depth + 1)
    }
    if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return true
    if (node.kind === K.TrueKeyword || node.kind === K.FalseKeyword || node.kind === K.NullKeyword) return true
    if (ts.isArrayLiteralExpression(node)) return node.elements.every((e) => literalTree(e, depth + 1))
    if (ts.isObjectLiteralExpression(node)) {
      return node.properties.every(
        (p) =>
          ts.isPropertyAssignment(p) && !ts.isComputedPropertyName(p.name) && literalTree(p.initializer, depth + 1),
      )
    }
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      return tableBase(node, depth + 1)
    }
    return false
  }

  /** `TABLE[x].bg` where TABLE is a module-level literal of literals: whatever x is, the leaf is one of ours */
  function tableSafe(node, depth = 0) {
    node = unwrap(node)
    if (!node || depth > 6) return false
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
      return tableBase(node.expression, depth + 1)
    return false
  }
  function tableBase(node, depth) {
    node = unwrap(node)
    if (!node || depth > 6) return false
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
      return tableBase(node.expression, depth + 1)
    if (ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node)) return literalTree(node, depth + 1)
    if (!ts.isIdentifier(node)) return false
    const b = bindingOf(node.text, node)
    if (b?.kind === 'var' && ts.isIdentifier(b.decl.name) && b.decl.initializer) {
      const sf = node.getSourceFile()
      const isConst = b.decl.parent.flags & ts.NodeFlags.Const
      if (!isConst && b.scope !== sf) return false
      return literalTree(b.decl.initializer) || tableSafe(b.decl.initializer, depth + 1)
    }
    if (!b) {
      const consts = index.consts.get(node.text)
      return !!consts && consts.length > 0 && consts.every((e) => literalTree(e))
    }
    return false
  }

  function safe(node, depth = 0) {
    node = unwrap(node)
    if (!node || depth > 60) return false
    if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return true
    if (node.kind === K.TrueKeyword || node.kind === K.FalseKeyword || node.kind === K.NullKeyword) return true
    if (ts.isTemplateExpression(node)) return node.templateSpans.every((s) => safe(s.expression, depth + 1))
    if (ts.isBinaryExpression(node)) {
      const k = node.operatorToken.kind
      if (
        k === K.PlusToken ||
        k === K.BarBarToken ||
        k === K.QuestionQuestionToken ||
        k === K.AmpersandAmpersandToken
      ) {
        // a `a + b + c + …` chain nests to the left; walking it is not "deeper"
        return safe(node.left, depth) && safe(node.right, depth + 1)
      }
      // arithmetic and comparisons produce numbers / booleans
      return (
        k === K.MinusToken ||
        k === K.AsteriskToken ||
        k === K.SlashToken ||
        k === K.PercentToken ||
        k === K.AsteriskAsteriskToken ||
        (k >= K.LessThanToken && k <= K.ExclamationEqualsEqualsToken) ||
        fail(node, 'unrecognised operator')
      )
    }
    if (ts.isConditionalExpression(node)) return safe(node.whenTrue, depth + 1) && safe(node.whenFalse, depth + 1)
    if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node) || ts.isTypeOfExpression(node))
      return true
    if (ts.isArrayLiteralExpression(node)) return node.elements.every((e) => safe(e, depth + 1))
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      if (ts.isPropertyAccessExpression(node) && (node.name.text === 'length' || node.name.text === 'size')) return true
      if (tableSafe(node)) return true
      if (ts.isPropertyAccessExpression(node)) {
        quiet++
        const viaBuilder = objPropSafe(node.expression, node.name.text, depth + 1)
        quiet--
        // a bare `x.p` with nothing known about `x` ends here; `x` must be a builder result
        if (viaBuilder && !ts.isIdentifier(unwrap(node.expression))) return true
        if (viaBuilder && ts.isIdentifier(unwrap(node.expression))) return true
      }
      return fail(node, 'unescaped property read')
    }
    if (ts.isCallExpression(node)) return callSafe(node, depth)
    if (ts.isIdentifier(node)) return identSafe(node, depth)
    return fail(node, 'unrecognised expression')
  }

  function callSafe(node, depth) {
    const name = calleeName(node)
    const bare = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name
    if (ESCAPE_HELPERS.has(name) || ESCAPE_HELPERS.has(bare)) return true
    if (calleeIsEscaperParam(node)) return true
    if (NUMERIC_CALLS.has(name) || name.startsWith('Math.')) return true
    if (ts.isPropertyAccessExpression(node.expression) && NUMERIC_METHODS.has(bare)) return true
    if (I18N_CALLS.has(name) || name === 'String' || GET_URL.test(name)) {
      return node.arguments.every((a) => safe(a, depth + 1)) || fail(node, 'argument not guarded')
    }
    if (TRUSTED_RENDERERS.has(name) || TRUSTED_RENDERERS.has(bare)) return true
    if (PASS_THROUGH.has(name))
      return (
        (node.arguments[0] ? safe(node.arguments[0], depth + 1) : true) || fail(node, 'pass-through input not guarded')
      )
    if (isInlineEscaper(node)) return true
    if (ts.isPropertyAccessExpression(node.expression)) {
      const recv = node.expression.expression
      // x.replace(/[^a-z0-9_-]/g, ''): only characters from the kept class survive, whatever x was
      if (bare === 'replace' && stripsToSafeClass(node)) return true
      // guarded.replace(re, guarded): reshaping a guarded string with guarded text adds nothing unguarded
      if ((bare === 'replace' || bare === 'replaceAll') && node.arguments.length === 2 && safe(recv, depth + 1)) {
        const rep = unwrap(node.arguments[1])
        if (isFn(rep))
          return (
            fnSafe(
              rep,
              rep.parameters.map(() => true),
              depth,
            ) || fail(node, 'replacement builds an unguarded value')
          )
        return safe(rep, depth + 1)
      }
      // [...].join('') / list.map(fn).join('')
      if (bare === 'join')
        return listSafe(recv, depth + 1) || fail(node, 'join over a list that is not provably guarded')
      if (CUT_METHODS.has(bare)) return safe(recv, depth + 1)
      if (PAD_METHODS.has(bare)) return safe(recv, depth + 1) && node.arguments.every((a) => safe(a, depth + 1))
    }
    // a plain call to an in-repo function: guarded when everything it returns is, for these arguments
    if (ts.isIdentifier(node.expression)) {
      const fns = resolveFns(node.expression)
      if (!fns || fns.length === 0) return fail(node, 'call to an unknown function')
      const flags = argFlags(node, depth)
      return fns.every((f) => fnSafe(f, flags, depth)) || fail(node, 'builder returns an unguarded value')
    }
    return fail(node, 'call to an unknown function')
  }

  const idSeen = new Set()
  function identSafe(node, depth) {
    if (node.text === 'undefined') return true
    const key = `${node.getSourceFile().fileName}:${node.text}@${node.pos}`
    if (idSeen.has(key)) return false
    idSeen.add(key)
    try {
      const b = bindingOf(node.text, node)
      if (!b) {
        // not bound in this file: a module-level const from the bundle
        const values = [
          ...(index.consts.get(node.text) || []),
          ...(index.lets.get(node.text) || []),
          ...(index.writes.get(node.text) || []),
        ]
        const declared = index.consts.has(node.text) || index.lets.has(node.text)
        if (!declared) return fail(node, 'unresolved name')
        return (
          values.every((e) => e && safe(e, depth + 1)) || fail(node, 'bundle global written with an unguarded value')
        )
      }
      if (b.kind === 'unknown') return fail(node, 'loop value / destructured / caught')
      if (b.kind === 'fn') return fail(node, 'function used as a value')
      if (b.kind === 'param') {
        const frame = [...frames].reverse().find((f) => f.fn === b.fn)
        const param = b.fn.parameters[b.index]
        if (!frame || !ts.isIdentifier(param.name) || param.dotDotDotToken) return fail(node, 'parameter')
        let flag =
          b.index < frame.flags.length
            ? frame.flags[b.index]
            : param.initializer
              ? safe(param.initializer, depth + 1)
              : true
        if (flag === 'E') return fail(node, 'an escape function used as a value')
        if (!flag) return fail(node, 'parameter bound to an unguarded argument')
        const { assigns, unknown } = assignmentsIn(b.fn.body, node.text)
        if (unknown) return fail(node, 'parameter reassigned')
        flag = assigns.every((e) => safe(e, depth + 1))
        return flag
      }
      // a var: its initializer and every later assignment
      const d = b.decl
      if (ts.isObjectBindingPattern(d.name) && d.initializer) {
        // `const { a, b } = builder(..)`: the property of the object it returns
        const el = d.name.elements.find(
          (e) => ts.isIdentifier(e.name) && e.name.text === node.text && !e.dotDotDotToken,
        )
        if (!el) return fail(node, 'destructured')
        const prop = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : node.text
        quiet++
        const okProp = objPropSafe(d.initializer, prop, depth + 1)
        quiet--
        return (
          (okProp && (!el.initializer || safe(el.initializer, depth + 1))) ||
          fail(node, 'destructured from something not provably guarded')
        )
      }
      if (!ts.isIdentifier(d.name)) return fail(node, 'destructured')
      const { assigns, unknown } = assignmentsIn(b.scope, node.text)
      if (unknown) return fail(node, 'reassigned another way')
      const outside =
        ts.isSourceFile(b.scope) && !(d.parent.flags & ts.NodeFlags.Const) ? index.writes.get(node.text) || [] : []
      const all = [...(d.initializer ? [d.initializer] : []), ...assigns, ...outside]
      if (all.length === 0) return true // declared, never given a value: undefined
      return all.every((e) => e && safe(e, depth + 1))
    } finally {
      idSeen.delete(key)
    }
  }

  return { safe, fails }
}

const TEMPLATE_READS = new Set(['childNodes', 'children', 'querySelector', 'querySelectorAll', 'textContent'])

/**
 * A parse into a `<template>`'s inert content (never attached, no scripts, no loads) that is
 * only read back as data: the template is touched through `.innerHTML =` and `.content.<read>`
 * and nothing else — no append, clone or hand-over of the template or its content.
 */
function inertTemplate(target) {
  target = unwrap(target)
  if (!ts.isIdentifier(target)) return false
  const b = bindingOf(target.text, target)
  if (b?.kind !== 'var' || !ts.isIdentifier(b.decl.name) || !b.decl.initializer) return false
  const init = unwrap(b.decl.initializer)
  if (
    !(ts.isCallExpression(init) && calleeName(init).endsWith('createElement') && init.arguments[0]?.text === 'template')
  ) {
    return false
  }
  let ok = true
  const visit = (n) => {
    if (ts.isIdentifier(n) && n.text === target.text && n !== b.decl.name) {
      const p = n.parent
      const viaInner = ts.isPropertyAccessExpression(p) && p.expression === n && p.name.text === 'innerHTML'
      const viaContent =
        ts.isPropertyAccessExpression(p) &&
        p.expression === n &&
        p.name.text === 'content' &&
        ts.isPropertyAccessExpression(p.parent) &&
        p.parent.expression === p &&
        TEMPLATE_READS.has(p.parent.name.text)
      if (!viaInner && !viaContent) ok = false
    }
    ts.forEachChild(n, visit)
  }
  visit(b.scope)
  return ok
}

/** `new DOMParser().parseFromString(x, 'text/html').querySelector…`: an inert document asked questions and dropped */
function inertParse(call) {
  const p = call.parent
  return (
    ts.isPropertyAccessExpression(p) &&
    p.expression === call &&
    (p.name.text === 'querySelector' || p.name.text === 'querySelectorAll')
  )
}

/** @returns {{ line: number, kind: string, guarded: boolean, text: string, why: string[] }[]} */
export function findSinks(sf, classifier) {
  const { safe, fails } = classifier
  const sinks = []
  const lineOf = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
  const record = (n, kind, expr) => {
    fails.length = 0
    const guarded = safe(expr)
    sinks.push({ line: lineOf(n), kind, guarded, text: expr.getText(sf).slice(0, 120), why: guarded ? [] : [...fails] })
  }
  const visit = (n) => {
    if (ts.isBinaryExpression(n)) {
      const k = n.operatorToken.kind
      if ((k === K.EqualsToken || k === K.PlusEqualsToken) && SINK_PROPS.has(propName(n.left))) {
        if (propName(n.left) === 'innerHTML' && inertTemplate(n.left.expression)) {
          sinks.push({
            line: lineOf(n),
            kind: 'innerHTML = (inert template)',
            guarded: true,
            text: n.right.getText(sf).slice(0, 120),
            why: [],
          })
        } else record(n, `${propName(n.left)}${k === K.PlusEqualsToken ? ' +=' : ' ='}`, n.right)
      }
    } else if (ts.isCallExpression(n)) {
      const callee = n.expression
      const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ''
      if (SINK_CALLS.has(name)) {
        const idx = SINK_CALLS.get(name)
        const recv = callee.expression.getText(sf)
        // write/writeln only count on `document`
        const isDoc = !(name === 'write' || name === 'writeln') || /^(window\.)?document$/.test(recv)
        // parseFromString only counts as html when asked for html
        const isHtml = name !== 'parseFromString' || /text\/html/.test(n.arguments[1]?.getText(sf) || '')
        if (isDoc && isHtml && n.arguments[idx]) {
          if (name === 'parseFromString' && inertParse(n)) {
            sinks.push({
              line: lineOf(n),
              kind: 'parseFromString (inert document)',
              guarded: true,
              text: n.arguments[idx].getText(sf).slice(0, 120),
              why: [],
            })
          } else record(n, name, n.arguments[idx])
        }
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return sinks
}
