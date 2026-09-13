/**
 * Paste-a-list bulk add: the parsers and the partial-success rule. One bad line
 * in twenty must never throw the other nineteen away.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('../src/multichat/channel-mgmt.js', import.meta.url), 'utf8')

function slice(startMarker, endMarker) {
  const s = SRC.indexOf(startMarker)
  if (s === -1) throw new Error(`start marker not found: ${startMarker}`)
  const e = SRC.indexOf(endMarker, s)
  if (e === -1) throw new Error(`end marker not found: ${endMarker}`)
  return SRC.slice(s, e)
}

const PARSERS = slice('function parseTwitchLoginValue', 'function renderAddChannelForm')
const { parseTwitchLoginValue, parseKickSlugValue } = new Function(
  `${PARSERS}\nreturn { parseTwitchLoginValue, parseKickSlugValue }`,
)()

// The splitter the paste form uses, mirrored.
const splitLines = (v) =>
  (v || '')
    .split(/[\n,]+/)
    .map((x) => x.trim())
    .filter(Boolean)

const TWITCH_OK = /^[a-z0-9_]{1,25}$/
const KICK_OK = /^[a-z0-9_-]{1,25}$/

describe('paste parsing', () => {
  test('newlines and commas both separate', () => {
    expect(splitLines('xqc\nforsen, sodapoppin')).toEqual(['xqc', 'forsen', 'sodapoppin'])
  })

  test('a space is NOT a separator — a pasted sentence stays one bad line', () => {
    // Splitting on spaces made "not a name!" into three entries, two of which
    // ("not", "a") pass the charset check and become real dead tabs.
    expect(splitLines('not a name!')).toEqual(['not a name!'])
  })

  test('a pasted twitch url reduces to the slug', () => {
    expect(parseTwitchLoginValue('https://twitch.tv/xqc')).toBe('xqc')
    expect(parseTwitchLoginValue('twitch.tv/popout/forsen/chat')).toBe('forsen')
    expect(parseTwitchLoginValue('@Sodapoppin')).toBe('sodapoppin')
  })

  test('a pasted kick url reduces to the slug', () => {
    expect(parseKickSlugValue('https://kick.com/some-body')).toBe('some-body')
  })

  test('a hyphen is legal on kick and illegal on twitch', () => {
    expect(KICK_OK.test(parseKickSlugValue('some-body'))).toBe(true)
    expect(TWITCH_OK.test(parseTwitchLoginValue('some-body'))).toBe(false)
  })
})

describe('partial success', () => {
  test('bad lines are counted, good lines still parse', () => {
    const raw = 'xqc\nnot a name!\ntwitch.tv/forsen\n\nway_too_long_a_channel_name_for_twitch'
    const good = []
    const bad = []
    for (const line of splitLines(raw)) {
      const v = parseTwitchLoginValue(line)
      if (TWITCH_OK.test(v)) good.push(v)
      else bad.push(line)
    }
    expect(good).toEqual(['xqc', 'forsen'])
    expect(bad).toEqual(['not a name!', 'way_too_long_a_channel_name_for_twitch'])
    // The rule that matters: a bad line never blocks a good one.
    expect(good.length).toBeGreaterThan(0)
  })

  test('an empty paste yields nothing rather than a junk entry', () => {
    expect(splitLines('   \n\n  ')).toEqual([])
  })
})
