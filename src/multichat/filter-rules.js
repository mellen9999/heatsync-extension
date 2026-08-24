// Chat filter/highlight rule engine — per-rule hide or highlight for incoming messages.
// Compiles once on settings change; evaluates cheaply per message.
// Self-contained — no imports. Mirrors automod.js shape (compileX / evaluateX).

// ── ReDoS guard (same heuristic as automod.js) ────────────────────────────────
// Inlined so this module is testable without the bundle scope.
function _frIsDangerous(p) {
  if (p.length > 512) return true
  if (/\([^)]*[+*][^)]*\)\s*[*+{]/.test(p)) return true
  if (/\([^)]*\|[^)]*\)\s*[*+{]/.test(p)) return true
  // bounded repetition ≥ 10 reps is exponential with any nested quantifier
  if (/\{\s*\d{2,}/.test(p)) return true
  return false
}
function _frEscapeLiteral(p) {
  return p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
// Empirical backstop behind the denylist heuristic (mirrors automod.js): run the
// compiled regex against short pathological probes under a time budget; a pattern
// that trips it is unsafe regardless of shape. See automod.js for the rationale.
const _FR_REDOS_PROBES = ['a'.repeat(28), '0'.repeat(28), 'ab'.repeat(14), 'a1'.repeat(14), ' '.repeat(28)].map(
  (s) => `${s} !`,
)
function _frTripsCatastrophic(re) {
  try {
    const start = performance.now()
    for (const probe of _FR_REDOS_PROBES) {
      re.test(probe)
      if (performance.now() - start > 20) return true
    }
  } catch {
    return true
  }
  return false
}
function _frSafeRegex(src, flags) {
  const safe = _frIsDangerous(src) ? _frEscapeLiteral(src) : src
  try {
    const re = new RegExp(safe, flags)
    if (_frTripsCatastrophic(re)) return new RegExp(_frEscapeLiteral(src), flags)
    return re
  } catch {
    try {
      return new RegExp(_frEscapeLiteral(src), flags)
    } catch {
      return null
    }
  }
}

// Valid highlight-sound names — kept in sync with FILTER_SOUND_PRESETS in
// mentions.js (the player). An unknown/absent name compiles to null = silent.
// Inlined (not imported) so this module stays self-contained + unit-testable.
const FR_SOUNDS = new Set(['ping', 'blip', 'knock', 'chime'])

// ── boolean expression engine (match type 'expr') ─────────────────────────────
// Chatterino-style composable filters — "user:bob && !badge:subscriber", "first
// || contains:\"first time\"", "bits > 100". Compiled once to a tiny AST and
// evaluated cheaply per message. No eval(), no user regex except via a guarded
// regex: term. Parse failure → rule is dropped (fail-safe), same as any invalid
// rule. Grammar (case-insensitive operators):
//   expr    := or
//   or      := and ( ('||'|'or') and )*
//   and     := unary ( ('&&'|'and') unary )*
//   unary   := ('!'|'not') unary | primary
//   primary := '(' expr ')' | term
//   term    := FLAG | FIELD ':' VALUE | 'bits' OP NUMBER
//   FLAG    := first | action | reply | cheer
//   FIELD   := user | badge | type | contains | regex
//   VALUE   := "quoted string" | bareword   (quote anything with spaces/specials)
const FR_MAX_EXPR_DEPTH = 40
const FR_FLAGS = new Set(['first', 'action', 'reply', 'cheer'])
const FR_FIELDS = new Set(['user', 'badge', 'type', 'msgtype', 'contains', 'has', 'regex'])

function _frTokenizeExpr(src) {
  if (typeof src !== 'string' || src.length > 512) return null
  const toks = []
  let i = 0
  const n = src.length
  const STRUCT = new Set([' ', '\t', '\n', '(', ')', '!', ':', '"', '<', '>', '=', '&', '|'])
  while (i < n) {
    const c = src[i]
    if (c === ' ' || c === '\t' || c === '\n') {
      i++
      continue
    }
    if (c === '(' || c === ')' || c === '!' || c === ':') {
      toks.push({ t: c })
      i++
      continue
    }
    if (c === '&' && src[i + 1] === '&') {
      toks.push({ t: '&&' })
      i += 2
      continue
    }
    if (c === '|' && src[i + 1] === '|') {
      toks.push({ t: '||' })
      i += 2
      continue
    }
    if (c === '>' || c === '<' || c === '=') {
      const two = src.slice(i, i + 2)
      if (two === '>=' || two === '<=' || two === '==') {
        toks.push({ t: 'op', v: two })
        i += 2
      } else if (c === '>' || c === '<') {
        toks.push({ t: 'op', v: c })
        i++
      } else {
        return null // bare '=' is invalid
      }
      continue
    }
    if (c === '"') {
      let j = i + 1
      let s = ''
      while (j < n && src[j] !== '"') {
        s += src[j]
        j++
      }
      if (j >= n) return null // unterminated string
      toks.push({ t: 'str', v: s })
      i = j + 1
      continue
    }
    // bareword — run of non-structural chars
    let w = ''
    while (i < n && !STRUCT.has(src[i])) {
      w += src[i]
      i++
    }
    if (!w) return null
    toks.push({ t: 'word', v: w })
    if (toks.length > 256) return null
  }
  return toks
}

function _frParseExpr(toks) {
  if (!toks?.length) return null
  let pos = 0
  const peek = () => toks[pos]
  const next = () => toks[pos++]
  const isWord = (tok, w) => tok && tok.t === 'word' && tok.v.toLowerCase() === w

  function parseOr(depth) {
    if (depth > FR_MAX_EXPR_DEPTH) return null
    let node = parseAnd(depth + 1)
    if (!node) return null
    while (peek() && (peek().t === '||' || isWord(peek(), 'or'))) {
      next()
      const r = parseAnd(depth + 1)
      if (!r) return null
      node = { op: 'or', l: node, r }
    }
    return node
  }
  function parseAnd(depth) {
    if (depth > FR_MAX_EXPR_DEPTH) return null
    let node = parseUnary(depth + 1)
    if (!node) return null
    while (peek() && (peek().t === '&&' || isWord(peek(), 'and'))) {
      next()
      const r = parseUnary(depth + 1)
      if (!r) return null
      node = { op: 'and', l: node, r }
    }
    return node
  }
  function parseUnary(depth) {
    if (depth > FR_MAX_EXPR_DEPTH) return null
    if (peek() && (peek().t === '!' || isWord(peek(), 'not'))) {
      next()
      const x = parseUnary(depth + 1)
      return x ? { op: 'not', x } : null
    }
    return parsePrimary(depth + 1)
  }
  function parsePrimary(depth) {
    if (depth > FR_MAX_EXPR_DEPTH) return null
    const tok = peek()
    if (tok && tok.t === '(') {
      next()
      const e = parseOr(depth + 1)
      if (!e || !peek() || peek().t !== ')') return null
      next()
      return e
    }
    return parseTerm()
  }
  function parseTerm() {
    const tok = next()
    if (tok?.t !== 'word') return null
    const kw = tok.v.toLowerCase()
    // bits comparison: bits OP number
    if (kw === 'bits' && peek() && peek().t === 'op') {
      const cmp = next().v
      const numTok = next()
      if (numTok?.t !== 'word') return null
      const num = Number(numTok.v)
      if (!Number.isFinite(num)) return null
      return { op: 'bits', cmp, n: num }
    }
    // field:value
    if (peek() && peek().t === ':') {
      if (!FR_FIELDS.has(kw)) return null
      next() // consume ':'
      const valTok = next()
      if (!valTok || (valTok.t !== 'word' && valTok.t !== 'str')) return null
      const val = valTok.v
      switch (kw) {
        case 'user':
          return { op: 'user', v: val.toLowerCase() }
        case 'badge':
          return { op: 'badge', v: val.toLowerCase() }
        case 'type':
        case 'msgtype':
          return { op: 'type', v: val.toLowerCase() }
        case 'contains':
        case 'has':
          return { op: 'contains', v: val.toLowerCase() }
        case 'regex': {
          const re = _frSafeRegex(val, 'i')
          return re ? { op: 'regex', re } : null
        }
        default:
          return null
      }
    }
    // bare flag
    if (FR_FLAGS.has(kw)) return { op: 'flag', name: kw }
    return null
  }

  const ast = parseOr(0)
  if (!ast || pos !== toks.length) return null // trailing tokens = malformed
  return ast
}

function _frEvalNode(node, m) {
  switch (node.op) {
    case 'or':
      return _frEvalNode(node.l, m) || _frEvalNode(node.r, m)
    case 'and':
      return _frEvalNode(node.l, m) && _frEvalNode(node.r, m)
    case 'not':
      return !_frEvalNode(node.x, m)
    case 'flag':
      if (node.name === 'first') return !!m.isFirstMsg
      if (node.name === 'action') return !!m.isAction
      if (node.name === 'reply') return !!m.replyTo?.user
      if (node.name === 'cheer') return !!(m.bits && Number(m.bits) > 0)
      return false
    case 'user':
      return !!m.user && String(m.user).toLowerCase() === node.v
    case 'badge': {
      if (!m.badges || typeof m.badges !== 'string') return false
      const badges = m.badges.split(',')
      for (let i = 0; i < badges.length; i++) if (badges[i].split('/')[0].toLowerCase() === node.v) return true
      return false
    }
    case 'type':
      if (node.v === 'first-message' || node.v === 'first') return !!m.isFirstMsg
      if (node.v === 'action') return !!m.isAction
      if (node.v === 'reply') return !!m.replyTo?.user
      if (node.v === 'cheer') return !!(m.bits && Number(m.bits) > 0)
      return false
    case 'contains': {
      if (typeof m.text !== 'string') return false
      const t = m.text.length > 256 ? m.text.slice(0, 256) : m.text
      return t.toLowerCase().includes(node.v)
    }
    case 'regex': {
      if (typeof m.text !== 'string') return false
      const t = m.text.length > 256 ? m.text.slice(0, 256) : m.text
      return node.re.test(t)
    }
    case 'bits': {
      const b = Number(m.bits) || 0
      if (node.cmp === '>') return b > node.n
      if (node.cmp === '>=') return b >= node.n
      if (node.cmp === '<') return b < node.n
      if (node.cmp === '<=') return b <= node.n
      if (node.cmp === '==') return b === node.n
      return false
    }
    default:
      return false
  }
}

// ── module state ──────────────────────────────────────────────────────────────
// Two buckets: all-scope rules run on every message; per-channel rules run only
// when channelKey matches. Compiled once → evaluated with no allocation per call.
let _frAllRules = [] // compiled rules with scope 'all'
let _frByChannel = new Map() // compiled rules keyed by channel tab id
let _frMergedByChannel = new Map() // all-rules + channel bucket, precomputed at compile

// ── compile helpers ───────────────────────────────────────────────────────────
function _frCompileOne(rule) {
  if (!rule || typeof rule !== 'object') return null
  if (!rule.id || !rule.enabled) return null
  const m = rule.match
  if (!m || typeof m.type !== 'string' || typeof m.value !== 'string') return null
  const val = m.value.trim()
  if (!val) return null
  const action = rule.action === 'hide' ? 'hide' : rule.action === 'highlight' ? 'highlight' : null
  if (!action) return null
  const scope = rule.scope === 'all' || !rule.scope ? 'all' : String(rule.scope)
  const cs = !!m.caseSensitive
  const flags = cs ? '' : 'i'

  const c = {
    id: String(rule.id),
    action,
    color: action === 'highlight' && rule.color && /^#[0-9a-f]{3,8}$/i.test(rule.color) ? rule.color : null,
    sound: action === 'highlight' && typeof rule.sound === 'string' && FR_SOUNDS.has(rule.sound) ? rule.sound : null,
    scope,
    matchType: m.type,
    caseSensitive: cs,
    value: '',
    re: null,
    ast: null,
  }

  switch (m.type) {
    case 'keyword': {
      // Word-boundary–ish: allow leading/trailing whitespace or line boundary,
      // but don't require \b so emoji/Unicode words also match. Case-insensitive
      // by default. RegExp compiled once; never touches user-supplied raw regex.
      const esc = _frEscapeLiteral(val)
      try {
        c.re = new RegExp(`(?:^|[\\s,!?.:;'"])${esc}(?=$|[\\s,!?.:;'"])`, flags)
      } catch {
        c.re = null
      }
      break
    }
    case 'regex':
      // User-supplied pattern — guard against ReDoS, then compile.
      c.re = _frSafeRegex(val, flags)
      break
    case 'expr': {
      // Boolean composition over the typed vars. Parse once to an AST.
      const ast = _frParseExpr(_frTokenizeExpr(val))
      if (!ast) return null // malformed expression → drop the rule (fail-safe)
      c.ast = ast
      break
    }
    case 'user':
      c.value = cs ? val : val.toLowerCase()
      break
    case 'badge':
      c.value = val.toLowerCase()
      break
    case 'msgtype':
      c.value = val.toLowerCase()
      break
    default:
      return null // unknown match type — skip
  }

  return c
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Validate + pre-compile an array of raw rule objects into module state.
 * Must be called once on load and again whenever chatFilterRules changes.
 * Safe to call with null / undefined / non-array (treated as empty).
 * @param {Array} rules  raw chatFilterRules array
 */
function compileFilterRules(rules) {
  _frAllRules = []
  _frByChannel = new Map()
  if (!Array.isArray(rules)) return
  for (const rule of rules) {
    const c = _frCompileOne(rule)
    if (!c) continue
    if (c.scope === 'all') {
      _frAllRules.push(c)
    } else {
      let bucket = _frByChannel.get(c.scope)
      if (!bucket) {
        bucket = []
        _frByChannel.set(c.scope, bucket)
      }
      bucket.push(c)
    }
  }
  // Merge once here so the per-message path never concatenates — global rules
  // evaluate first, matching the pre-merge ordering.
  _frMergedByChannel = new Map()
  for (const [key, bucket] of _frByChannel) {
    _frMergedByChannel.set(key, _frAllRules.concat(bucket))
  }
}

/**
 * Evaluate applicable compiled rules against an incoming message.
 * Hot path — no per-call allocation when there are no rules for this scope.
 * @param {object} m           message object (text, user, badges, isFirstMsg, isAction, bits, replyTo)
 * @param {string|null} channelKey  channel tab id (ch.id) or null
 * @returns {{ hide: boolean, highlight: string|null, sound: string|null }}
 */
function evaluateFilterRules(m, channelKey) {
  const hasChannel = channelKey && _frByChannel.has(channelKey)
  if (!_frAllRules.length && !hasChannel) return { hide: false, highlight: null, sound: null }

  const rules = hasChannel ? _frMergedByChannel.get(channelKey) : _frAllRules

  let highlight = null
  let sound = null
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i]
    if (!_frTest(rule, m)) continue
    if (rule.action === 'hide') return { hide: true, highlight: null, sound: null }
    if (rule.action === 'highlight' && highlight === null) {
      highlight = rule.color
      sound = rule.sound
    }
  }
  return { hide: false, highlight, sound }
}

function _frTest(rule, m) {
  switch (rule.matchType) {
    case 'keyword':
    case 'regex': {
      if (!rule.re || typeof m.text !== 'string') return false
      const t = m.text.length > 256 ? m.text.slice(0, 256) : m.text
      return rule.re.test(t)
    }
    case 'expr':
      return rule.ast ? _frEvalNode(rule.ast, m) : false
    case 'user': {
      if (!m.user) return false
      const u = rule.caseSensitive ? String(m.user) : String(m.user).toLowerCase()
      return u === rule.value
    }
    case 'badge': {
      if (!m.badges || typeof m.badges !== 'string') return false
      const badges = m.badges.split(',')
      for (let i = 0; i < badges.length; i++) {
        if (badges[i].split('/')[0].toLowerCase() === rule.value) return true
      }
      return false
    }
    case 'msgtype': {
      const mt = rule.value
      if (mt === 'first-message') return !!m.isFirstMsg
      if (mt === 'action') return !!m.isAction
      if (mt === 'reply') return !!m.replyTo?.user
      if (mt === 'cheer') return !!(m.bits && Number(m.bits) > 0)
      return false
    }
    default:
      return false
  }
}

export { compileFilterRules, evaluateFilterRules }
