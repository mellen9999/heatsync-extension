/**
 * Highlight words on native twitch/kick chat, with the overlay off.
 *
 * The old keyword highlighter in content.js was deleted when highlight words
 * became chat filter rules — but rules only ran inside the overlay, and the
 * one-shot fold of the old words only ran there too. With the overlay off a
 * user's words stopped highlighting and never moved into rules.
 *
 * native-filter-rules.js (embedded into content.js by build.js) runs here against
 * a happy-dom page with the REAL engine (filter-rules.js) and the REAL fold
 * (filter-rules-legacy.js) — the same files build.js embeds beside it.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { createNativeFilterRules } from '../src/content/native-filter-rules.js'
import { isLargeKeySyncEligible } from '../src/lib/utils.js'
import { compileFilterRules, evaluateFilterRules } from '../src/multichat/filter-rules.js'
import {
  foldLegacyFilters,
  LEGACY_LOCAL_KEYS,
  LEGACY_UI_KEYS,
  legacyFilterRules,
} from '../src/multichat/filter-rules-legacy.js'

function fakeChrome(sync, local) {
  const sent = []
  const get = (area) => async (keys) => {
    const out = {}
    for (const k of [].concat(keys)) if (k in area) out[k] = area[k]
    return out
  }
  return {
    sent,
    sync,
    local,
    storage: {
      sync: { get: get(sync) },
      local: {
        get: get(local),
        set: async (o) => Object.assign(local, o),
        remove: async (keys) => {
          for (const k of keys) delete local[k]
        },
      },
    },
    send: async (m) => {
      sent.push(m)
      return { ok: true }
    },
  }
}

let win
let doc
let me
function lift({ isKick = false, chrome = fakeChrome({}, {}) } = {}) {
  const n = createNativeFilterRules({
    document: doc,
    storage: chrome.storage,
    send: chrome.send,
    site: isKick ? 'kick' : 'twitch',
    me: () => me,
    engine: { compileFilterRules, evaluateFilterRules },
    legacy: { foldLegacyFilters, LEGACY_LOCAL_KEYS, LEGACY_UI_KEYS },
    syncEligible: isLargeKeySyncEligible,
  })
  return {
    loadNativeFilterRules: n.load,
    highlightRuleMatches: n.highlight,
    applyRuleHighlightsToVisibleMessages: n.repaint,
    foldLegacyFiltersHere: n.fold,
    start: n.start,
  }
}

// A twitch native row: .chat-line__message > username button + text fragment.
function row(user, text) {
  const line = doc.createElement('div')
  line.className = 'chat-line__message'
  line.innerHTML = `<span class="chat-line__username-container"><span class="chat-author__display-name"></span></span><span class="text-fragment"></span>`
  line.querySelector('.chat-author__display-name').textContent = user
  line.querySelector('.text-fragment').textContent = text
  doc.body.appendChild(line)
  return line
}
const lit = (el) => el.classList.contains('hs-keyword-match')

beforeEach(() => {
  win = new Window()
  doc = win.document
  me = 'viewer'
  compileFilterRules([])
})
afterEach(async () => {
  compileFilterRules([])
  await win.happyDOM.close()
})

describe('highlight rules on native rows', () => {
  test('an old highlight word, folded into a rule, lights the native row', () => {
    const n = lift()
    n.loadNativeFilterRules(foldLegacyFilters({}, { keyword_highlights: 'pog, gg' }))
    const hit = row('alice', 'that was a pog moment')
    const miss = row('alice', 'pogger is not the word')
    n.highlightRuleMatches(hit, 'alice')
    n.highlightRuleMatches(miss, 'alice')
    expect(lit(hit)).toBe(true)
    expect(lit(miss)).toBe(false)
  })

  test('the sender name is not message text: a word equal to a name only lights its mention', () => {
    const n = lift()
    n.loadNativeFilterRules(JSON.stringify(legacyFilterRules({ keywordHighlights: 'pog' })))
    const named = row('pog', 'hello there')
    n.highlightRuleMatches(named, 'pog')
    expect(lit(named)).toBe(false)
  })

  test('your own message never lights, as in the overlay', () => {
    const n = lift()
    n.loadNativeFilterRules(JSON.stringify(legacyFilterRules({ keywordHighlights: 'pog' })))
    const own = row('Viewer', 'pog')
    n.highlightRuleMatches(own, 'Viewer')
    expect(lit(own)).toBe(false)
  })

  test('hide rules and disabled rules do not light anything', () => {
    const n = lift()
    const rules = [
      { id: 'a', enabled: true, action: 'hide', scope: 'all', match: { type: 'keyword', value: 'pog' } },
      { id: 'b', enabled: false, action: 'highlight', scope: 'all', match: { type: 'keyword', value: 'gg' } },
    ]
    n.loadNativeFilterRules(JSON.stringify(rules))
    const a = row('alice', 'pog')
    const b = row('alice', 'gg')
    n.highlightRuleMatches(a, 'alice')
    n.highlightRuleMatches(b, 'alice')
    expect(lit(a)).toBe(false)
    expect(lit(b)).toBe(false)
  })

  test('a rules change repaints the rows already on screen, both ways', () => {
    const n = lift()
    const a = row('alice', 'pog')
    const b = row('bob', 'gg')
    n.loadNativeFilterRules(JSON.stringify(legacyFilterRules({ keywordHighlights: 'pog' })))
    n.applyRuleHighlightsToVisibleMessages()
    expect([lit(a), lit(b)]).toEqual([true, false])
    n.loadNativeFilterRules(JSON.stringify(legacyFilterRules({ keywordHighlights: 'gg' })))
    n.applyRuleHighlightsToVisibleMessages()
    expect([lit(a), lit(b)]).toEqual([false, true])
  })

  test('unreadable stored rules light nothing and do not throw', () => {
    const n = lift()
    n.loadNativeFilterRules('{not json')
    const a = row('alice', 'pog')
    n.highlightRuleMatches(a, 'alice')
    expect(lit(a)).toBe(false)
  })
})

describe('the fold runs with the overlay off', () => {
  test('overlay off on twitch: words become rules, synced, and every old copy lets go', async () => {
    const c = fakeChrome(
      { ui_settings: { subsystems: { 'overlay-twitch': false }, automodRegex: 'spam', keywordHighlights: 'old' } },
      { keyword_highlights: 'pog', hs_mute_keywords: 'bad', chat_filter_rules: '[]' },
    )
    const raw = await lift({ chrome: c }).foldLegacyFiltersHere()
    const rules = JSON.parse(c.local.chat_filter_rules)
    expect(raw).toBe(c.local.chat_filter_rules)
    // local highlight words win over the older sync copy, exactly as the overlay folds
    expect(rules.map((r) => `${r.action}:${r.match.value}`)).toEqual(['hide:spam', 'hide:bad', 'highlight:\\bpog\\b'])
    expect('keyword_highlights' in c.local || 'hs_mute_keywords' in c.local).toBe(false)
    const ws = c.sent.find((m) => m.type === 'ws_send')
    expect(ws.data).toEqual({ type: 'ui-state:sync', patch: { chatFilterRules: c.local.chat_filter_rules } })
    const drop = c.sent.find((m) => m.type === 'ui_settings_rmw')
    expect(drop).toEqual({ type: 'ui_settings_rmw', patch: {}, dropRetired: LEGACY_UI_KEYS })
  })

  test('a second run adds nothing — the old copies are gone', async () => {
    const c = fakeChrome({ ui_settings: { subsystems: { 'overlay-kick': false } } }, { keyword_highlights: 'pog' })
    const n = lift({ isKick: true, chrome: c })
    await n.foldLegacyFiltersHere()
    const once = c.local.chat_filter_rules
    c.sent.length = 0
    await n.foldLegacyFiltersHere()
    expect(c.local.chat_filter_rules).toBe(once)
    expect(c.sent).toEqual([])
  })

  test('overlay on: the overlay folds after its server seed, so native chat touches nothing', async () => {
    const c = fakeChrome(
      { ui_settings: { keywordHighlights: 'pog' } },
      { keyword_highlights: 'pog', chat_filter_rules: '[]' },
    )
    const raw = await lift({ chrome: c }).foldLegacyFiltersHere()
    expect(raw).toBe('[]')
    expect(c.local.keyword_highlights).toBe('pog')
    expect(c.sent).toEqual([])
  })

  test('unreadable stored rules: every old value stays put', async () => {
    const c = fakeChrome(
      { ui_settings: { subsystems: { 'overlay-twitch': false }, keywordHighlights: 'pog' } },
      { keyword_highlights: 'pog', chat_filter_rules: '{broken' },
    )
    await lift({ chrome: c }).foldLegacyFiltersHere()
    expect(c.local.keyword_highlights).toBe('pog')
    expect(c.local.chat_filter_rules).toBe('{broken')
    expect(c.sent).toEqual([])
  })
})

describe('content.js runs it', () => {
  test('build embeds the engine, the fold and this module into content.js, and content.js wires all three paths', () => {
    const root = join(import.meta.dir, '..')
    const build = readFileSync(join(root, 'build.js'), 'utf8')
    const entry = build.match(/'content\.js': \[([^\]]*)\]/g)?.find((m) => m.includes('filter-rules')) ?? ''
    for (const mod of [
      'multichat/filter-rules.js',
      'multichat/filter-rules-legacy.js',
      'content/native-filter-rules.js',
    ])
      expect(entry).toContain(`'${mod}'`)
    const content = readFileSync(join(root, 'src', 'content', 'content.js'), 'utf8')
    expect(content).toContain('nativeRules.start()')
    expect(content).toContain('nativeRules.highlight(messageElement, username, textElements)')
    expect(content).toMatch(/changes\.chat_filter_rules\) \{\n\s+nativeRules\.load\(/)
    expect(content).toContain('.hs-keyword-match {')
  })

  test('start: overlay off folds, then paints the rows already on screen', async () => {
    const c = fakeChrome({ ui_settings: { subsystems: { 'overlay-twitch': false } } }, { keyword_highlights: 'pog' })
    const a = row('alice', 'pog')
    await lift({ chrome: c }).start()
    expect(lit(a)).toBe(true)
  })
})
