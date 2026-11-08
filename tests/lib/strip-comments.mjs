/**
 * Blank out JS comments without moving a single line.
 *
 * Every source-scanning guard in tests/client needs this, and the obvious
 * two-regex version is wrong in two ways that both hide bugs rather than
 * inventing them — the worse direction:
 *
 * 1. `src.replace(/\/\*[\s\S]*?\*\//g, '')` DELETES the block, so every line
 *    after it shifts up and the guard reports a line number that points at
 *    unrelated code. One guard reported :334 for an offence on :361.
 *
 * 2. Running that block-comment pass FIRST means a `/*` sitting inside a `//`
 *    line comment opens a comment that was never opened. `// /live/* + /tags.`
 *    in secondary-navbar.js swallowed everything up to the next `*␘/`
 *    — 263 lines of real code, invisible to the scanner. Measured across
 *    client/: five files, ~800 lines, including 302 of settings-manager.js.
 *    A guard blind over 800 lines passes for the wrong reason.
 *
 * So: one left-to-right pass that knows where it is. Comments become spaces,
 * newlines are preserved, and string/template contents are left alone so a
 * `'/*'` inside a string cannot open anything either.
 *
 * 3. Regex literals ARE handled, and skipping them was not survivable. The
 *    first version declared them out of scope on the grounds that a regex
 *    containing a block-comment opener does not occur here — but the case that
 *    actually bites is far more common: a regex containing a QUOTE. `/['"]/`
 *    put the stripper into string state, and everything to the next matching
 *    quote — comments included — came back as live code. Measured: 171 comment
 *    lines across client/ and server/ survived stripping, and the inverse
 *    (real code blanked because a stray quote opened a string that a later
 *    comment closed) is the same bug pointing the dangerous way. Telling regex
 *    from division needs the previous significant token, which is the small
 *    lookback below rather than a real parser.
 */

// A `/` starts a regex when the previous significant character cannot end an
// expression. After a value (identifier, number, `)`, `]`, `}`) it is division.
// The keyword list covers the cases where an identifier IS followed by a regex.
const REGEX_PRECEDERS = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>', '\n'])
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await'])

function startsRegex(out, i) {
  let j = i - 1
  while (j >= 0 && /\s/.test(out[j] ?? '')) j--
  if (j < 0) return true
  const c = out[j]
  if (REGEX_PRECEDERS.has(c)) return true
  if (/[A-Za-z0-9_$]/.test(c)) {
      let k = j
      while (k >= 0 && /[A-Za-z0-9_$]/.test(out[k] ?? '')) k--
      return REGEX_KEYWORDS.has(out.slice(k + 1, j + 1).join(''))
  }
  return false
}

/**
 * @param {string} src
 * @returns {string} same length, same line count, comments replaced by spaces
 */
export function stripComments(src) {
  const out = new Array(src.length)
  let state = 'code' // code | line | block | re | sq | dq | tpl
  let inClass = false // inside a regex character class, where `/` is literal
  // One frame per template literal we are inside. `sub` is true while we are in
  // that template's `${ … }`, where the contents are ordinary code that may open
  // strings, regexes, comments, or FURTHER templates. Treating a template as
  // opaque until the next backtick is what broke the previous version: the
  // backtick of a nested template closed the outer one, parity flipped, and the
  // rest of the file was read in the wrong state — 283 comment lines across 19
  // files came back as live code.
  const tpl = []

  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    const d = src[i + 1]
    const blank = () => { out[i] = c === '\n' ? '\n' : ' ' }
    const top = tpl.length ? tpl[tpl.length - 1] : null

    switch (state) {
      case 'code':
        if (c === '/' && d === '/') { state = 'line'; blank(); continue }
        if (c === '/' && d === '*') { state = 'block'; blank(); continue }
        if (c === '/' && startsRegex(out, i)) { state = 're'; inClass = false; out[i] = c; continue }
        if (c === "'") state = 'sq'
        else if (c === '"') state = 'dq'
        else if (c === '`') { state = 'tpl'; tpl.push({ sub: false, depth: 0 }) }
        else if (c === '{' && top?.sub) top.depth++
        else if (c === '}' && top?.sub) {
          if (top.depth === 0) { top.sub = false; state = 'tpl' }
          else top.depth--
        }
        out[i] = c
        continue

      case 'line':
        if (c === '\n') { state = 'code'; out[i] = '\n'; continue }
        blank()
        continue

      case 'block':
        if (c === '*' && d === '/') { out[i] = ' '; out[i + 1] = ' '; i++; state = 'code'; continue }
        blank()
        continue

      // A regex body is copied verbatim: quotes, slashes and comment openers
      // inside it are all just pattern characters. `/` closes it unless it sits
      // inside a character class, which is why `inClass` is tracked.
      case 're':
        out[i] = c
        if (c === '\\') { if (i + 1 < src.length) { out[i + 1] = src[i + 1]; i++ } continue }
        if (c === '[') inClass = true
        else if (c === ']') inClass = false
        else if (c === '/' && !inClass) state = 'code'
        // An unterminated regex cannot span a line — bail rather than eat the file.
        else if (c === '\n') { inClass = false; state = 'code' }
        continue

      case 'tpl':
        out[i] = c
        if (c === '\\') { if (i + 1 < src.length) { out[i + 1] = src[i + 1]; i++ } continue }
        if (c === '`') { state = 'code'; tpl.pop(); continue }
        if (c === '$' && d === '{') { out[i + 1] = d; i++; if (top) { top.sub = true; top.depth = 0 }; state = 'code' }
        continue

      // Inside a string the only things that matter are the escape and the
      // closing quote — a `/*` in here must not open anything.
      case 'sq':
      case 'dq': {
        out[i] = c
        if (c === '\\') { if (i + 1 < src.length) { out[i + 1] = src[i + 1]; i++ } continue }
        if (c === (state === 'sq' ? "'" : '"')) state = 'code'
        // An unterminated quote at end of line is a syntax error in real code,
        // but bail anyway rather than eating the rest of the file.
        else if (c === '\n') state = 'code'
        continue
      }
    }
  }
  return out.join('')
}

/**
 * The CSS equivalent: blank `/* … *␘/` without moving a line.
 *
 * CSS has no `//`, so one regex is genuinely enough here — but it has to BLANK
 * rather than delete, for the same reason the JS one does: a scanner that
 * reports the wrong line sends the next reader to the wrong place. Four
 * stylesheet guards each had their own copy of the deleting version.
 *
 * @param {string} src
 * @returns {string} same length, same line count, comments replaced by spaces
 */
export function stripCssComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
}

/**
 * HTML comments, blanked in place.
 *
 * Needed because `stripComments` copies template-literal contents verbatim —
 * correct for JS, wrong for a scanner reading markup out of a TS template. An
 * `<!-- … -->` inside one survives, and prose in it reads as markup: the
 * sentence "data-default marks the order the server already rendered" in
 * server/routes/global-best.ts registered `data-default` as an attribute
 * something writes. It happened to be true there; the next one will not be.
 *
 * @param {string} src
 * @returns {string} same length, same line count, comments replaced by spaces
 */
export function stripHtmlComments(src) {
  return src.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
}

/**
 * SQL comments, blanked in place — `--` to end of line, and `/* … *␘/`, which
 * postgres NESTS.
 *
 * A one-regex version is wrong here in a way CSS's is not, and the reason is
 * dollar quoting. Every trigger function and every `DO` block in
 * migrations/baseline/schema-baseline.sql is a `$$ … $$` body full of `--`
 * comments and apostrophes, and a scanner that blanks by regex either eats
 * into one or comes back out of it in the wrong state. String literals do the
 * same on a smaller scale: `'it''s'` and `'50% -- not a comment'` both exist
 * in this tree.
 *
 * So the same left-to-right pass as the JS one, with SQL's three quoting
 * forms: single-quoted strings (doubled `''` escapes, not backslashes),
 * double-quoted identifiers, and `$tag$ … $tag$` bodies.
 *
 * @param {string} src
 * @returns {string} same length, same line count, comments replaced by spaces
 */
export function stripSqlComments(src) {
  const out = src.split('')
  const blank = (i) => { if (src[i] !== '\n') out[i] = ' ' }
  let i = 0
  while (i < src.length) {
    const c = src[i]

    // $tag$ … $tag$ — copied verbatim, tag included. A body is code to
    // postgres and prose to us; either way nothing in it is a comment we own.
    const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(src.slice(i))
    if (c === '$' && dollar) {
      const end = src.indexOf(dollar[0], i + dollar[0].length)
      i = end === -1 ? src.length : end + dollar[0].length
      continue
    }

    if (c === "'" || c === '"') {
      const quote = c
      i++
      while (i < src.length) {
        // '' inside a single-quoted string is one literal quote, not the end.
        if (src[i] === quote && src[i + 1] === quote) { i += 2; continue }
        if (src[i] === quote) { i++; break }
        i++
      }
      continue
    }

    if (c === '-' && src[i + 1] === '-') {
      while (i < src.length && src[i] !== '\n') { blank(i); i++ }
      continue
    }

    if (c === '/' && src[i + 1] === '*') {
      // Nested, per the SQL standard and postgres: /* /* */ */ is ONE comment,
      // and a non-counting scanner ends it at the first `*/` and reads the
      // rest of the outer comment as live SQL.
      let depth = 0
      do {
        if (src[i] === '/' && src[i + 1] === '*') { depth++; blank(i); blank(i + 1); i += 2; continue }
        if (src[i] === '*' && src[i + 1] === '/') { depth--; blank(i); blank(i + 1); i += 2; continue }
        blank(i); i++
      } while (i < src.length && depth > 0)
      continue
    }

    i++
  }
  return out.join('')
}
