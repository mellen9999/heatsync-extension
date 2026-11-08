/**
 * twitch_gql_authed only runs the fixed query shapes the overlay sends.
 * Every twitchGql( / gqlMutation( call site in src/ is evaluated and must be
 * allowed, so a new caller fails loud here until it is added to
 * TWITCH_GQL_ALLOWED in 02-auth-live.js.
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bgSource } from './bg-src.js'

const SRC = bgSource()
const START = SRC.indexOf('const TWITCH_GQL_PRED_FIELDS')
const END = SRC.indexOf('// The twitch cookie, read fresh each time')
if (START < 0 || END < START) throw new Error('TWITCH_GQL_ALLOWED markers missing')
const { twitchGqlAllowed } = new Function(`${SRC.slice(START, END)}; return { twitchGqlAllowed }`)()

const EXT = join(import.meta.dir, '..', 'src')
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.js') ? [join(dir, e.name)] : [],
  )
}

/** the first argument text of each `name(` call, balanced over quotes/templates/brackets */
function firstArgs(src, name) {
  const out = []
  const re = new RegExp(`(?<![\\w.])${name}\\(`, 'g')
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const before = src.slice(Math.max(0, m.index - 20), m.index)
    if (/function\s+$|typeof\s+$/.test(before)) continue
    let i = m.index + m[0].length
    const start = i
    let depth = 0
    for (; i < src.length; i++) {
      const c = src[i]
      if (c === "'" || c === '"' || c === '`') {
        for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++
        continue
      }
      if ('([{'.includes(c)) depth++
      else if (')]}'.includes(c)) {
        if (depth === 0) break
        depth--
      } else if (c === ',' && depth === 0) break
    }
    out.push(src.slice(start, i).trim())
  }
  return out
}

const PRED_FIELDS =
  'id title status createdAt endedAt predictionWindowSeconds winningOutcome { id } outcomes { id title totalPoints totalUsers color } self { prediction { outcome { id } points } }'
const POLL_FIELDS =
  'id title status durationSeconds remainingDurationMilliseconds startedAt choices { id title totalVoters } totalVoters'
const evalArg = (arg) =>
  new Function('lc', 'me', 'ch', 'safe', 'channelId', 'PRED_FIELDS', 'POLL_FIELDS', `return (${arg})`)(
    'someone',
    'someone',
    'someone',
    'someone',
    '123',
    PRED_FIELDS,
    POLL_FIELDS,
  )

const sites = []
for (const f of walk(EXT)) {
  const src = readFileSync(f, 'utf8')
  for (const name of ['twitchGql', 'gqlMutation'])
    for (const arg of firstArgs(src, name)) {
      // identifier args (query/rawQuery variables) are the relayed mod mutations
      if (/^[A-Za-z_$][\w$]*$/.test(arg)) continue
      // gqlPersistedMutation's no-hash fallback builds the name at runtime: prediction mutations, refused off-twitch by design
      if (/operationName/.test(arg)) continue
      sites.push({ file: f.slice(EXT.length + 1), name, arg })
    }
}

// the poll mutations build their text in a const right above the call
const pollConsts = [
  ...readFileSync(join(EXT, 'multichat', 'twitch-api.js'), 'utf8').matchAll(
    /const rawQuery = (`mutation\(\$input[^`]*`)/g,
  ),
]

describe('twitch_gql_authed allowlist', () => {
  test('callers were found (the scan itself works)', () => {
    expect(sites.filter((s) => s.name === 'twitchGql').length).toBeGreaterThanOrEqual(12)
    expect(pollConsts.length).toBeGreaterThanOrEqual(2)
  })

  for (const s of sites) {
    test(`allowed: ${s.name} in ${s.file}: ${s.arg.slice(0, 50).replace(/\s+/g, ' ')}`, () => {
      expect(twitchGqlAllowed(evalArg(s.arg))).toBe(true)
    })
  }

  test('poll mutations (built in a const) are allowed', () => {
    for (const m of pollConsts) expect(twitchGqlAllowed(evalArg(m[1]))).toBe(true)
  })

  test('the quoted login does not matter, the shape does', () => {
    expect(twitchGqlAllowed('{ user(login:"someone_else") { chatColor } }')).toBe(true)
  })

  const refused = {
    'an unknown field': '{ user(login: "x") { email } }',
    'a read with extra fields tacked on': '{ user(login: "x") { chatColor email } }',
    'an unknown mutation': 'mutation($input: BanUserInput!) { banUser(input: $input) { __typename } }',
    'a second query appended': '{ user(login: "x") { chatColor } } { currentUser { email } }',
    'currentUser email': '{ currentUser { email } }',
    empty: '',
    'a persisted-query name': 'FollowButton_FollowUser',
  }
  for (const [name, q] of Object.entries(refused)) {
    test(`refused: ${name}`, () => {
      expect(twitchGqlAllowed(q)).toBe(false)
    })
  }

  test('refused: non-strings and oversized queries', () => {
    for (const q of [
      null,
      undefined,
      5,
      { toString: () => '{ currentUser { login } }' },
      [],
      `{ badges ${'x'.repeat(5000)} }`,
    ])
      expect(twitchGqlAllowed(q)).toBe(false)
  })
})
