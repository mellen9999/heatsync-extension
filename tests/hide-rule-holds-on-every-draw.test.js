/**
 * A hide rule was only asked when a line arrived: the handler skipped the append and that was
 * all. The line was already in its channel's buffer (and in the worker's, which a reload reads
 * history from), and no redraw asked the rule again — so a hidden line came back on the next
 * full draw (a trim, older rows loading, a mute, a tab switch, a reload), and a rule written
 * after a line never touched it. Real twitch, kick and youtube, e2e s25, 11-17.
 *
 * Runs the real rule engine and the real ruleHides / ruleScopeOf / useFilterRules.
 */
import { afterAll, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compileFilterRules, evaluateFilterRules, filterRulesOn } from '../src/multichat/filter-rules.js'
import { mainSource } from './main-src.js'

const SRC = mainSource()
const cut = (src, from, to) => {
  const a = src.indexOf(from)
  const b = src.indexOf(to, a)
  if (a < 0 || b < 0) throw new Error(`carve: ${from}`)
  return src.slice(a, b)
}
const RULES = cut(SRC, 'function ruleScopeOf(m, tabId) {', 'function isMsgFiltered(m, f) {')
const UI = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'filter-rules-ui.js'), 'utf8')
const USE = `${cut(UI, 'function useFilterRules(json) {', '\n}\n')}\n}`

const rule = (value, more = {}) => ({
  id: value,
  enabled: true,
  match: { type: 'keyword', value },
  action: 'hide',
  ...more,
})

function chat({ me = 'me' } = {}) {
  const channels = [
    { id: 'tab-a', twitch: 'alpha', kick: 'alphak' },
    { id: 'tab-b', twitch: 'beta' },
    { id: 'tab-yt' }, // a youtube-only channel: its lines carry no channel of their own
  ]
  const look = {
    twitch: new Map(channels.filter((c) => c.twitch).map((c) => [c.twitch, c])),
    kick: new Map(channels.filter((c) => c.kick).map((c) => [c.kick, c])),
    byId: new Map(channels.map((c) => [c.id, c])),
  }
  const scope = {
    getChannelLookup: () => look,
    isSelf: (m) => m.user === me,
    evaluateFilterRules,
    filterRulesOn,
  }
  return new Function('scope', `with (scope) { ${RULES}\n return { ruleHides, ruleScopeOf } }`)(scope)
}

afterAll(() => compileFilterRules([]))

test('a line a rule hides stays hidden on a redraw, on every platform and in every tab it shows in', () => {
  compileFilterRules([rule('spoiler')])
  const { ruleHides } = chat()
  const line = (platform, channel) => ({ user: 'someone', text: 'big spoiler here', platform, channel })
  expect(ruleHides(line(undefined, 'alpha'), 'tab-a')).toBe(true) // twitch rows carry no platform
  expect(ruleHides(line('kick', 'alphak'), 'tab-a')).toBe(true)
  expect(ruleHides(line('youtube', 'youtube'), 'tab-yt')).toBe(true)
  expect(ruleHides(line('twitch', 'alpha'), 'live')).toBe(true)
  expect(ruleHides(line('twitch', 'alpha'), 'mentions')).toBe(true)
  expect(ruleHides({ user: 'someone', text: 'nothing to see', channel: 'alpha' }, 'tab-a')).toBe(false)
})

test('your own line is never hidden, and neither is an event row or a held message', () => {
  compileFilterRules([rule('spoiler')])
  const { ruleHides } = chat()
  expect(ruleHides({ user: 'me', text: 'my spoiler', channel: 'alpha' }, 'tab-a')).toBe(false)
  expect(ruleHides({ type: 'stream-event', text: 'spoiler went live', channel: 'alpha' }, 'tab-a')).toBe(false)
  expect(ruleHides({ type: 'automod-hold', user: 'x', text: 'spoiler', channel: 'alpha' }, 'tab-a')).toBe(false)
  expect(ruleHides({ inlineNotifType: 'follow', user: 'x', text: 'spoiler', channel: 'alpha' }, 'tab-a')).toBe(false)
})

test("a rule for one channel judges that channel's lines wherever they are drawn, and no other", () => {
  compileFilterRules([rule('spoiler', { scope: 'tab-a' })])
  const { ruleHides, ruleScopeOf } = chat()
  const a = { user: 'x', text: 'a spoiler', platform: 'twitch', channel: 'alpha' }
  const ak = { user: 'x', text: 'a spoiler', platform: 'kick', channel: 'alphak' }
  const b = { user: 'x', text: 'a spoiler', platform: 'twitch', channel: 'beta' }
  expect(ruleHides(a, 'tab-a')).toBe(true)
  expect(ruleHides(a, 'live')).toBe(true) // the merged tab: the line's own channel, not the tab
  expect(ruleHides(ak, 'live')).toBe(true)
  expect(ruleHides(b, 'tab-b')).toBe(false)
  expect(ruleHides(b, 'live')).toBe(false)
  // youtube lines of a linked channel are named after it; a youtube-only tab's are judged by the tab
  expect(ruleScopeOf({ platform: 'youtube', channel: 'alpha' }, 'live')).toBe('tab-a')
  expect(ruleScopeOf({ platform: 'youtube', channel: 'youtube' }, 'tab-yt')).toBe('tab-yt')
  expect(ruleScopeOf({ platform: 'youtube', channel: 'youtube' }, 'live')).toBe(null)
  // a kick channel that shares a twitch channel's name is not that twitch channel
  expect(ruleScopeOf({ platform: 'kick', channel: 'beta' }, 'live')).toBe(null)
})

test('with no rules a redraw of every row asks nothing', () => {
  compileFilterRules([])
  let asked = 0
  const ask = (answer) => () => {
    asked++
    return answer
  }
  const scope = {
    getChannelLookup: ask({ twitch: new Map(), kick: new Map(), byId: new Map() }),
    isSelf: ask(false),
    evaluateFilterRules: ask({ hide: false }),
    filterRulesOn,
  }
  const { ruleHides } = new Function('scope', `with (scope) { ${RULES}\n return { ruleHides } }`)(scope)
  expect(ruleHides({ user: 'x', text: 'y', channel: 'alpha' }, 'tab-a')).toBe(false)
  expect(asked).toBe(0)
})

test('every draw asks: the full render, the single-line append, and the highlight reads the same channel', () => {
  expect(SRC).toMatch(/toRender = toRender\.filter\(\s*\(m\) => !isMsgFiltered\(m, _ff\) && !ruleHides\(m, id\) &&/)
  expect(SRC).toMatch(/if \(isMsgFiltered\(msg, _ff\) \|\| ruleHides\(msg, tabId\)\) return true/)
  expect(SRC).toMatch(/const _frHL = evaluateFilterRules\(m, ruleScopeOf\(m, tabId\)\)/)
})

function rulesUi() {
  const d = { order: [], scope: null }
  d.scope = {
    compileFilterRules,
    bumpRenderEpoch: () => d.order.push('stale'),
    renderMessages: (tab) => d.order.push(`draw:${tab}`),
    renderSettingsTab: () => d.order.push('settings'),
    currentTab: 'tab-a',
  }
  d.use = new Function('scope', `with (scope) { ${USE}\n return useFilterRules }`)(d.scope)
  return d
}

test('new rules restyle the rows already drawn: every row is marked stale before the redraw', () => {
  const d = rulesUi()
  d.use(JSON.stringify([rule('spoiler', { action: 'highlight', color: '#ff0000' })]))
  expect(d.order).toEqual(['stale', 'draw:tab-a'])
  expect(evaluateFilterRules({ user: 'x', text: 'a spoiler' }, null).highlight).toBe('#ff0000')
})

test('rules that are gone stop applying: a removed key, an empty list, a blob that does not parse', () => {
  for (const gone of [undefined, '[]', '{not json', '{"a":1}']) {
    const d = rulesUi()
    compileFilterRules([rule('spoiler')])
    expect(filterRulesOn()).toBe(true)
    d.use(gone)
    expect(filterRulesOn()).toBe(false)
    expect(d.order).toEqual(['stale', 'draw:tab-a'])
  }
})

test('a rules change from another tab goes through the same door, and so does the key being removed', () => {
  const at = SRC.indexOf('if (changes.chat_filter_rules) {')
  const block = SRC.slice(at, SRC.indexOf('\n    }\n', at) + 7)
  const run = (newValue) => {
    const got = []
    new Function('changes', 'useFilterRules', block)({ chat_filter_rules: { newValue } }, (v) => got.push(v))
    return got
  }
  expect(run('[1]')).toEqual(['[1]'])
  expect(run(undefined)).toEqual([undefined])
  expect(run(7)).toEqual([])
  // the editor's own save uses it too: one place compiles and redraws
  expect(UI.match(/compileFilterRules\(/g)?.length).toBe(1)
})
