/**
 * Tag hover card (src/multichat/tag-card.js): model rows, 404/error => nothing,
 * relative time, 60s cache, abort. The file has top-level declarations only
 * (setupTagCardHandlers is never called here), so it is evaluated for real
 * with stand-ins for the globals the bundle provides.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8')
const TIME = read('src', 'lib', 'card-time.js').replace(/^export /gm, '')
const SRC = read('src', 'multichat', 'tag-card.js')

const LABELS = {
  mc_tagcard_posts: 'posts',
  mc_tagcard_followers: 'followers',
  mc_tagcard_last: 'last',
  mc_tagcard_you: 'you',
  mc_tagcard_following: 'following',
  mc_tagcard_not_following: 'not following',
}

function load() {
  const calls = []
  const pending = []
  const env = {
    apiFetch: (path, opts) => {
      calls.push({ path, opts })
      return new Promise((resolve) => pending.push(resolve))
    },
    t: (k) => LABELS[k] || k,
    formatCompact: (n) => String(n),
    escapeHtml: (s) =>
      String(s).replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
      ),
  }
  const body = `${TIME}\n${SRC}\nreturn { hsTagCardModel, hsTagCardHtml, fetchTagCard, _tagCardCache }`
  const api = new Function(...Object.keys(env), body)(...Object.values(env))
  return { ...api, calls, resolve: (resp) => pending.shift()(resp) }
}

const ago = (ms) => new Date(Date.now() - ms).toISOString()
const card = (extra = {}) => ({
  ok: true,
  data: { name: 'cats', post_count: 12, follower_count: 3, last_used_at: ago(2 * 3600e3 + 5e3), ...extra },
})
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('hsTagCardModel', () => {
  let m
  beforeEach(() => {
    m = load()
  })

  test('stats row with relative time', () => {
    const model = m.hsTagCardModel(card(), (k) => LABELS[k])
    expect(model.name).toBe('cats')
    expect(model.stats.map((r) => `${r.label}: ${r.value}`)).toEqual(['posts: 12', 'followers: 3', 'last: 2h'])
  })

  test('anonymous (no following field) omits the you row', () => {
    expect(m.hsTagCardModel(card(), (k) => LABELS[k]).you).toBeNull()
  })

  test('signed in: you: following / not following', () => {
    const yes = m.hsTagCardModel(card({ following: true }), (k) => LABELS[k])
    const no = m.hsTagCardModel(card({ following: false }), (k) => LABELS[k])
    expect(yes.you).toEqual({ label: 'you', value: 'following' })
    expect(no.you).toEqual({ label: 'you', value: 'not following' })
  })

  test('no last_used_at drops the last stat', () => {
    const model = m.hsTagCardModel(card({ last_used_at: null }), (k) => LABELS[k])
    expect(model.stats.map((r) => r.label)).toEqual(['posts', 'followers'])
  })

  test('404 / error / junk => nothing', () => {
    const tr = (k) => LABELS[k]
    expect(m.hsTagCardModel({ ok: false, status: 404, error: 'Tag not found' }, tr)).toBeNull()
    expect(m.hsTagCardModel({ ok: false, error: 'network' }, tr)).toBeNull()
    expect(m.hsTagCardModel({ ok: true, data: null }, tr)).toBeNull()
    expect(m.hsTagCardModel({ ok: true, data: { post_count: 1 } }, tr)).toBeNull()
    expect(m.hsTagCardModel(undefined, tr)).toBeNull()
  })

  test('html escapes the tag name and has no buttons', () => {
    const html = m.hsTagCardHtml(m.hsTagCardModel(card({ name: '<b>x' }), (k) => LABELS[k]))
    expect(html).toContain('#&lt;b&gt;x')
    expect(html).not.toContain('<button')
    expect(html).toContain('hs-card-sheet-row')
  })
})

describe('fetchTagCard', () => {
  test('requests the card path through apiFetch, authed by default (bg holds the token)', async () => {
    const m = load()
    const p = m.fetchTagCard('Cats')
    expect(m.calls[0].path).toBe('/api/tags/cats/card')
    expect(m.calls[0].opts).toBeUndefined()
    m.resolve(card())
    expect((await p).name).toBe('cats')
  })

  test('cache: second hover inside 60s makes no request; after ttl it refetches', async () => {
    const m = load()
    const p = m.fetchTagCard('cats')
    m.resolve(card())
    await p
    await m.fetchTagCard('cats')
    expect(m.calls.length).toBe(1)
    m._tagCardCache.get('cats').ts = Date.now() - 61e3
    const p2 = m.fetchTagCard('cats')
    expect(m.calls.length).toBe(2)
    m.resolve(card())
    await p2
  })

  test('in-flight dedupe', async () => {
    const m = load()
    const a = m.fetchTagCard('cats')
    const b = m.fetchTagCard('cats')
    expect(m.calls.length).toBe(1)
    m.resolve(card())
    expect(await a).toBe(await b)
  })

  test('404 => null and cached; network error => null and retried', async () => {
    const m = load()
    const a = m.fetchTagCard('nope')
    m.resolve({ ok: false, status: 404, error: 'Tag not found' })
    expect(await a).toBeNull()
    expect(await m.fetchTagCard('nope')).toBeNull()
    expect(m.calls.length).toBe(1)
    const b = m.fetchTagCard('flaky')
    m.resolve({ ok: false, error: 'network' })
    expect(await b).toBeNull()
    const c = m.fetchTagCard('flaky')
    expect(m.calls.length).toBe(3)
    m.resolve(card({ name: 'flaky' }))
    expect((await c).name).toBe('flaky')
  })

  test('abort: resolves null at once, makes no request if already aborted', async () => {
    const m = load()
    const dead = new AbortController()
    dead.abort()
    expect(await m.fetchTagCard('cats', dead.signal)).toBeNull()
    expect(m.calls.length).toBe(0)
    const ctl = new AbortController()
    const p = m.fetchTagCard('cats', ctl.signal)
    ctl.abort()
    expect(await p).toBeNull()
    m.resolve(card())
    await flush()
    expect((await m.fetchTagCard('cats')).name).toBe('cats') // late answer still cached
    expect(m.calls.length).toBe(1)
  })
})

describe('wiring', () => {
  test('built into the bundle and started at init', () => {
    expect(read('build.js')).toContain("'tag-card.js'")
    expect(read('src', 'multichat', 'main.js')).toContain('setupTagCardHandlers()')
  })
  test('touch and scroll never fetch', () => {
    expect(SRC).toContain('firesTouchEvents')
    expect(SRC).toContain('TAG_CARD_SCROLL_QUIET_MS')
  })
})
