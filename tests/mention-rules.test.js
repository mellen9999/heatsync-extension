import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * mention-rules.js — the settings editor for server-side mention rules. The
 * shipped source runs with stubbed globals: the form→body mapping (every field,
 * bounds mirroring server/routes/mention-rules.ts), the list/hits markup and
 * the request each action sends.
 */
const ROOT = join(import.meta.dir, '..')
const SRC = readFileSync(join(ROOT, 'src', 'multichat', 'mention-rules.js'), 'utf8')

function load({ auth = true, replies = () => ({ ok: true, data: {} }), channels = [], tab = 'a' } = {}) {
  const calls = []
  const renders = []
  const toasts = []
  const g = {
    hsAuthToken: auth,
    apiFetch: async (path, opts = {}) => {
      calls.push({ path, method: opts.method || 'GET', body: opts.body })
      return replies(path, opts)
    },
    renderSettingsTab: () => renders.push(1),
    showToast: (m, k) => toasts.push([m, k]),
    t: (k) => k,
    escapeHtml: (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`),
    formatRelativeTime: () => '5m',
    hsXButtonHtml: (_c, _l, attrs) => `<button ${attrs}>x</button>`,
    FR_BTN: 'b',
    FR_SEL: 's',
    FR_INPUT: 'i',
    _setCollapsed: new Set(),
    config: { channels },
    currentTab: tab,
    currentTabRef: null,
    document: { querySelector: () => null },
  }
  const api = new Function(
    ...Object.keys(g),
    `${SRC}\nreturn { mrState, mrDraftToBody, mrRuleToDraft, mrBlankDraft, mrParseChannels, mrHitsHtml, mrHitUrl, mrRuleRowHtml, mrFormHtml, mrGroupHtml, mrSave, mrTest, mrHandleAction, mrLoad }`,
  )(...Object.values(g))
  return { ...api, calls, renders, toasts, g }
}

const base = () => ({
  rule_type: 'word',
  pattern: 'heatsync',
  channels: '',
  platforms: [],
  case_sensitive: false,
  notify_via: ['web'],
  cooldown_seconds: '',
})

describe('form → body', () => {
  test('every field maps; blanks become null so an edit can clear them', () => {
    const { mrDraftToBody } = load()
    const r = mrDraftToBody({
      rule_type: 'phrase',
      pattern: '  hello there ',
      channels: '#Chan, other, chan',
      platforms: ['twitch', 'kick', 'bogus'],
      case_sensitive: true,
      notify_via: ['web', 'push'],
      cooldown_seconds: '30',
    })
    expect(r).toEqual({
      ok: true,
      body: {
        rule_type: 'phrase',
        pattern: 'hello there',
        channels: ['chan', 'other'],
        platforms: ['twitch', 'kick'],
        case_sensitive: true,
        notify_via: ['web', 'push'],
        cooldown_seconds: 30,
      },
    })
    expect(mrDraftToBody(base()).body).toEqual({
      rule_type: 'word',
      pattern: 'heatsync',
      channels: null,
      platforms: null,
      case_sensitive: false,
      notify_via: ['web'],
    })
  })
  test('pattern bounds: 1..200', () => {
    const { mrDraftToBody } = load()
    expect(mrDraftToBody({ ...base(), pattern: '   ' }).error).toBe('mc_mr_err_pattern')
    expect(mrDraftToBody({ ...base(), pattern: 'a'.repeat(201) }).error).toBe('mc_mr_err_pattern')
    expect(mrDraftToBody({ ...base(), pattern: 'a'.repeat(200) }).ok).toBe(true)
  })
  test('cooldown bounds 5..3600, integers only', () => {
    const { mrDraftToBody } = load()
    for (const bad of ['4', '3601', '5.5', 'abc'])
      expect(mrDraftToBody({ ...base(), cooldown_seconds: bad }).error).toBe('mc_mr_err_cooldown')
    for (const good of ['5', '3600']) expect(mrDraftToBody({ ...base(), cooldown_seconds: good }).ok).toBe(true)
  })
  test('notify_via needs at least one valid value', () => {
    const { mrDraftToBody } = load()
    expect(mrDraftToBody({ ...base(), notify_via: [] }).error).toBe('mc_mr_err_notify')
    expect(mrDraftToBody({ ...base(), notify_via: ['sms'] }).error).toBe('mc_mr_err_notify')
  })
  test('channels: ≤50 each ≤60 chars', () => {
    const { mrDraftToBody } = load()
    const many = Array.from({ length: 51 }, (_, i) => `c${i}`).join(',')
    expect(mrDraftToBody({ ...base(), channels: many }).error).toBe('mc_mr_err_channels')
    expect(mrDraftToBody({ ...base(), channels: 'x'.repeat(61) }).error).toBe('mc_mr_err_channels')
  })
  test('a regex rule must compile; word rules are never compiled', () => {
    const { mrDraftToBody } = load()
    expect(mrDraftToBody({ ...base(), rule_type: 'regex', pattern: '(' }).error).toBe('mc_mr_err_regex')
    expect(mrDraftToBody({ ...base(), rule_type: 'regex', pattern: 'a+b' }).ok).toBe(true)
    expect(mrDraftToBody({ ...base(), rule_type: 'word', pattern: '(' }).ok).toBe(true)
  })
  test('rule → draft round-trips through the body', () => {
    const { mrRuleToDraft, mrDraftToBody } = load()
    const rule = {
      rule_type: 'regex',
      pattern: 'a+',
      channels: ['x', 'y'],
      platforms: ['youtube'],
      case_sensitive: true,
      notify_via: ['push'],
      cooldown_seconds: 60,
    }
    expect(mrDraftToBody(mrRuleToDraft(rule)).body).toEqual(rule)
  })
})

describe('markup', () => {
  test('hit rows link to the exact message on the site and escape the snippet', () => {
    const { mrHitsHtml, mrHitUrl } = load()
    const h = {
      platform: 'twitch',
      channel: 'chan',
      message_id: 'abc',
      matched_at: '2026-10-03T12:00:00Z',
      username: 'u',
      snippet: '<img src=x>',
    }
    expect(mrHitUrl(h)).toBe('https://heatsync.org/search/logs/twitch/chan/2026-10-03?m=abc')
    const html = mrHitsHtml([h])
    expect(html).toContain('href="https://heatsync.org/search/logs/twitch/chan/2026-10-03?m=abc"')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).not.toContain('<img')
    expect(mrHitsHtml([])).toContain('mc_mr_hits_none')
  })
  test('rule rows show state, scope, dormant, and escape the pattern', () => {
    const { mrRuleRowHtml } = load()
    const html = mrRuleRowHtml({
      id: 7,
      enabled: true,
      dormant: true,
      rule_type: 'word',
      pattern: '<b>',
      channels: ['c'],
      platforms: ['kick'],
    })
    expect(html).toContain('hs-mc-toggle-pill active')
    expect(html).toContain('#c K')
    expect(html).toContain('mc_mr_dormant')
    expect(html).not.toContain('<b>')
    expect(html).toContain('data-mr-id="7"')
  })
  test('the form offers the current tab’s channels as chips', () => {
    const e = load({ channels: [{ id: 'a', twitch: 'Foo', kick: 'bar' }], tab: 'a' })
    const html = e.mrFormHtml(e.mrBlankDraft(), false)
    expect(html).toContain('data-mr-chan="foo"')
    expect(html).toContain('data-mr-chan="bar"')
  })
  test('signed out: the sign-in line and no form, no request', () => {
    const e = load({ auth: false })
    const html = e.mrGroupHtml()
    expect(html).toContain('mc_mr_signin')
    expect(html).not.toContain('data-mr-field')
    expect(e.calls.length).toBe(0)
  })
})

describe('review fixes', () => {
  test('a hit with a bad date is listed without a link instead of throwing', () => {
    const { mrHitsHtml, mrHitUrl } = load()
    const h = { platform: 'twitch', channel: 'c', matched_at: 'garbage', username: 'u', snippet: 'hi' }
    expect(mrHitUrl(h)).toBe('')
    const html = mrHitsHtml([h, { ...h, matched_at: '2026-10-03T00:00:00Z' }])
    expect(html.match(/<a /g)?.length).toBe(1)
    expect(html).toContain('hi')
  })
  test('a failed load keeps it unloaded: 401 shows sign-in, other errors their text, retry after the wait', async () => {
    let status = 401
    const e = load({ replies: () => ({ ok: false, status, error: 'boom' }) })
    await e.mrLoad()
    expect(e.mrState.loaded).toBe(false)
    expect(e.mrGroupHtml()).toContain('mc_mr_signin')
    expect(e.mrGroupHtml()).not.toContain('mc_mr_none')
    status = 500
    await e.mrLoad()
    expect(e.mrGroupHtml()).toContain('boom')
    const calls = e.calls.length
    e.mrGroupHtml()
    expect(e.calls.length).toBe(calls) // inside the retry window: no request storm
    e.mrState.failedAt = Date.now() - 20000
    e.mrGroupHtml()
    await Promise.resolve()
    expect(e.calls.length).toBeGreaterThan(calls)
  })
  test('toggle keeps what was typed in the add form', async () => {
    const e = load({ replies: () => ({ ok: true, data: { rules: [] } }) })
    e.mrState.rules = [{ id: 3, enabled: true }]
    const form = {
      querySelector: (s) =>
        ({
          type: { value: 'regex' },
          pattern: { value: 'half typed' },
          channels: { value: '' },
          cs: { checked: false },
          cd: { value: '' },
          testmsg: { value: '' },
        })[s.match(/"(.+)"/)[1]],
      querySelectorAll: () => [],
    }
    await e.mrHandleAction({ dataset: { mrAction: 'toggle', mrId: '3' }, closest: () => form })
    expect(e.mrState.draft.pattern).toBe('half typed')
  })
})

describe('actions', () => {
  test('load fetches rules and the last 25 hits', async () => {
    const e = load({
      replies: (p) =>
        p.includes('hits')
          ? { ok: true, data: { hits: [{ id: 1 }] } }
          : { ok: true, data: { rules: [{ id: 1 }], limit: 5 } },
    })
    await e.mrLoad()
    expect(e.calls.map((c) => c.path).sort()).toEqual(['/api/mention-rules', '/api/mention-rules/hits?limit=25'])
    expect([e.mrState.rules.length, e.mrState.hits.length, e.mrState.limit]).toEqual([1, 1, 5])
  })
  test('save POSTs a new rule, PUTs an edit', async () => {
    const e = load()
    const form = { querySelector: () => null, querySelectorAll: () => [] }
    e.mrState.draft = { ...base(), pattern: '' }
    // an invalid form never reaches the network
    await e.mrSave(null)
    expect(e.calls.length).toBe(0)
    expect(e.mrState.error).toBe('mc_mr_err_pattern')
    e.mrState.error = ''
    e.mrState.draft = base()
    const d = base()
    const stub = {
      querySelector: (s) =>
        ({
          type: { value: 'word' },
          pattern: { value: d.pattern },
          channels: { value: '' },
          cs: { checked: false },
          cd: { value: '' },
          testmsg: { value: '' },
        })[s.match(/"(.+)"/)[1]],
      querySelectorAll: (s) => (s.includes('"via"') ? [{ checked: true, value: 'web' }] : []),
    }
    await e.mrSave(stub)
    expect(e.calls[0]).toMatchObject({ path: '/api/mention-rules', method: 'POST' })
    e.mrState.editId = 9
    await e.mrSave(stub)
    expect(e.calls.find((c) => c.method === 'PUT').path).toBe('/api/mention-rules/9')
    void form
  })
  test('a server refusal (cap reached) surfaces its own text and keeps the draft', async () => {
    const e = load({ replies: () => ({ ok: false, status: 403, error: 'free accounts run 5 alerts' }) })
    const stub = {
      querySelector: (s) =>
        ({
          type: { value: 'word' },
          pattern: { value: 'x' },
          channels: { value: '' },
          cs: { checked: false },
          cd: { value: '' },
          testmsg: { value: '' },
        })[s.match(/"(.+)"/)[1]],
      querySelectorAll: (s) => (s.includes('"via"') ? [{ checked: true, value: 'web' }] : []),
    }
    await e.mrSave(stub)
    expect(e.mrState.error).toBe('free accounts run 5 alerts')
    expect(e.mrState.draft.pattern).toBe('x')
  })
  test('toggle PUTs enabled, delete DELETEs, test posts the unsaved rule + message', async () => {
    const e = load({
      replies: (p) => (p.endsWith('/test') ? { ok: true, data: { matched: true } } : { ok: true, data: { rules: [] } }),
    })
    e.mrState.rules = [{ id: 3, enabled: true }]
    await e.mrHandleAction({ dataset: { mrAction: 'toggle', mrId: '3' }, closest: () => null })
    expect(e.calls[0]).toEqual({ path: '/api/mention-rules/3', method: 'PUT', body: { enabled: false } })
    e.mrState.rules = [{ id: 3, enabled: true }]
    await e.mrHandleAction({ dataset: { mrAction: 'delete', mrId: '3' }, closest: () => null })
    expect(e.calls.find((c) => c.method === 'DELETE').path).toBe('/api/mention-rules/3')
    e.mrState.testMsg = 'hello'
    const stub = {
      querySelector: (s) =>
        ({
          type: { value: 'word' },
          pattern: { value: 'hel' },
          channels: { value: '' },
          cs: { checked: true },
          cd: { value: '' },
          testmsg: { value: 'hello' },
        })[s.match(/"(.+)"/)[1]],
      querySelectorAll: () => [{ checked: true, value: 'web' }],
    }
    await e.mrTest(stub)
    const tc = e.calls.find((c) => c.path === '/api/mention-rules/test')
    expect(tc.body).toEqual({ message: 'hello', rule_type: 'word', pattern: 'hel', case_sensitive: true })
    expect(e.mrState.testResult).toBe(true)
  })
})

describe('wiring', () => {
  test('bundled after settings-ui, dispatched from its click handler, shown in the notifs pane', () => {
    const build = readFileSync(join(ROOT, 'build.js'), 'utf8')
    expect(build.indexOf("'mention-rules.js'")).toBeGreaterThan(build.indexOf("'settings-ui.js'"))
    const ui = readFileSync(join(ROOT, 'src', 'multichat', 'settings-ui.js'), 'utf8')
    expect(ui).toContain('mrHandleAction(mrEl)')
    expect(ui).toContain("cat === 'notifs'")
  })
})
