/**
 * Tab-complete ranking tests — compareAcMatches (src/multichat/input.js) and
 * the frecency store (src/multichat/emotes.js).
 *
 * Regression anchor: typing "kko" + Tab surfaced the channel's never-touched
 * KKonaLand above the user's habitual KKona. Two defects compounded:
 *   1. the old MRU signal ranked BELOW tier, so a channel emote always beat a
 *      habitual global on the first keypress, and
 *   2. the MRU store was a recency-only list capped at 24 — one stray
 *      completion outranked a hundred real uses, and habits silently fell off
 *      the cap.
 * The fix: a shared comparator (both sort sites had already drifted) with
 * used-before ranked directly under strong-exact, backed by a frecency store
 * (use count, half-life decay).
 *
 * compareAcMatches is a pure function inside the non-module content-script
 * bundle, so it's carved out of the source and evaluated standalone — same
 * "don't depend on bundled output" rationale as utils.test.js's fuzzyScore.
 */

import { beforeEach, describe, expect, setSystemTime, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ── carve compareAcMatches out of input.js ──────────────────────────────────
const INPUT_SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'input.js'), 'utf8')
const start = INPUT_SRC.indexOf('function compareAcMatches(')
const end = INPUT_SRC.indexOf('function findEmoteMatches(')
if (start === -1 || end === -1 || end <= start) throw new Error('compareAcMatches carve markers not found')
const compareAcMatches = new Function(`${INPUT_SRC.slice(start, end)}; return compareAcMatches`)()

const rank = (items, search, frecency = new Map()) =>
  [...items].sort((a, b) => compareAcMatches(a, b, search, frecency)).map((m) => m.name)

// helpers: tier 0 = channel, 1 = own set, 2 = global; priority 0 = prefix, 1 = substring
const emote = (name, tier, priority = 0, extra = {}) => ({ name, tier, priority, type: 'emote', ...extra })

describe('compareAcMatches — used-before beats structure', () => {
  test('kko regression: habitual global KKona beats untouched channel KKonaLand', () => {
    const frec = new Map([['KKona', 12]])
    expect(rank([emote('KKonaLand', 0), emote('KKona', 2)], 'kko', frec)).toEqual(['KKona', 'KKonaLand'])
  })

  test('among used: typed prefix outranks used substring', () => {
    const frec = new Map([
      ['monkaKKonaHmm', 50],
      ['KKona', 3],
    ])
    // user typed a PREFIX — the substring habit doesn't hijack it
    expect(rank([emote('monkaKKonaHmm', 0, 1), emote('KKona', 2, 0)], 'kko', frec)).toEqual(['KKona', 'monkaKKonaHmm'])
  })

  test('among used prefix matches: higher frecency wins', () => {
    const frec = new Map([
      ['KKonaLand', 1],
      ['KKona', 12],
    ])
    expect(rank([emote('KKonaLand', 0), emote('KKona', 2)], 'kko', frec)).toEqual(['KKona', 'KKonaLand'])
  })
})

describe('compareAcMatches — never-used ordering (channel culture leads)', () => {
  test('same tier, both prefix, neither used → shorter name first', () => {
    expect(rank([emote('KKonaLand', 0), emote('KKona', 0)], 'kko')).toEqual(['KKona', 'KKonaLand'])
  })

  test('channel emote beats global when neither is used', () => {
    expect(rank([emote('KKona', 2), emote('KKonaLand', 0)], 'kko')).toEqual(['KKonaLand', 'KKona'])
  })

  test('exact beats tier even never-used: "hug" → global HuG over channel peepoHug (reversed call: "nam" → NaM)', () => {
    expect(rank([emote('HuG', 2, 0), emote('peepoHug', 0, 1)], 'hug')).toEqual(['HuG', 'peepoHug'])
  })

  test('strong exact: a USED exact global escapes above channel fuzzy hits', () => {
    const frec = new Map([['Clap', 4]])
    expect(rank([emote('ClapHands', 0), emote('Clap', 2)], 'clap', frec)).toEqual(['Clap', 'ClapHands'])
  })

  test('kek / KEK: the channel emote beats a used global of the same name in another casing', () => {
    // ennortix typed "kek" and wanted the channel's KEK — a habit on the
    // lowercase lookalike must not lead.
    const frec = new Map([['kek', 9]])
    expect(rank([emote('kek', 2), emote('KEK', 0)], 'kek', frec)).toEqual(['KEK', 'kek'])
    expect(rank([emote('kek', 2, 0, { remote: true }), emote('KEK', 0)], 'kek', frec)).toEqual(['KEK', 'kek'])
  })

  test('two same-name exacts that are both off-channel still go by habit', () => {
    const frec = new Map([['kek', 9]])
    expect(rank([emote('KEK', 2), emote('kek', 1)], 'kek', frec)).toEqual(['kek', 'KEK'])
  })

  test('exact channel/own emote is strong without any usage', () => {
    expect(rank([emote('ClapHands', 0), emote('Clap', 1)], 'clap')).toEqual(['Clap', 'ClapHands'])
  })

  test('prefix beats substring within a tier', () => {
    expect(rank([emote('xKKona', 0, 1), emote('KKonaX', 0, 0)], 'kko')).toEqual(['KKonaX', 'xKKona'])
  })

  test('sub emote beats non-sub on an otherwise-equal never-used tie', () => {
    expect(rank([emote('KKonaA', 1), emote('KKonaB', 1, 0, { sub: true })], 'kko')).toEqual(['KKonaB', 'KKonaA'])
  })
})

describe('compareAcMatches — remote merge', () => {
  test('every local beats every remote, remotes keep catalog (_ai) order', () => {
    const items = [
      emote('KKonaRemoteB', undefined, 0, { remote: true, _ai: 1 }),
      emote('KKonaRemoteA', undefined, 0, { remote: true, _ai: 0 }),
      emote('KKonaLocal', 2),
    ]
    expect(rank(items, 'kko')).toEqual(['KKonaLocal', 'KKonaRemoteA', 'KKonaRemoteB'])
  })

  test('a remote the user has actually used beats unused remotes', () => {
    const frec = new Map([['KKonaRemoteB', 2]])
    const items = [
      emote('KKonaRemoteA', undefined, 0, { remote: true, _ai: 0 }),
      emote('KKonaRemoteB', undefined, 0, { remote: true, _ai: 1 }),
    ]
    expect(rank(items, 'kko', frec)).toEqual(['KKonaRemoteB', 'KKonaRemoteA'])
  })
})

describe('compareAcMatches — @user matches', () => {
  test('recent chatter (lower recencyRank) first, alpha as fallback', () => {
    const u = (name, recencyRank) => ({ name, priority: 0, type: 'user', recencyRank })
    expect(rank([u('@kkonafanB', 5), u('@kkonafanA', 1)], 'kkonafan')).toEqual(['@kkonafanA', '@kkonafanB'])
    expect(rank([u('@kkonafanB'), u('@kkonafanA')], 'kkonafan')).toEqual(['@kkonafanA', '@kkonafanB'])
  })

  test('recency outranks the shorter-name rule: longer recent chatter beats short stale name', () => {
    const u = (name, recencyRank) => ({ name, priority: 0, type: 'user', recencyRank })
    expect(rank([u('@asher'), u('@ashrubberyboi', 0)], 'as')).toEqual(['@ashrubberyboi', '@asher'])
    expect(rank([u('@bob'), u('@carl'), u('@recentlongname', 0)], '')).toEqual(['@recentlongname', '@bob', '@carl'])
  })
})

// ── frecency store (emotes.js) ──────────────────────────────────────────────
const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
}
globalThis.cleanup = { setIntervalIfVisible: () => {}, persistInterval: () => {} }
const mods = await import('../src/lib/modifiers.js')
globalThis.HS_MOD_TOKENS = mods.HS_MOD_TOKENS
globalThis.hsModClassify = mods.hsModClassify
globalThis.hsModBuildStyleAttr = mods.hsModBuildStyleAttr
globalThis.hsModInjectWrapperStyle = mods.hsModInjectWrapperStyle
globalThis.hsModComposeFilter = mods.hsModComposeFilter
globalThis.hsModHexToHue = mods.hsModHexToHue
globalThis.HS_MOD_C_HEX_RE = /^c!#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/
globalThis.currentTab = 'chan-a'
globalThis.getCurrentChannel = () => 'chan-a'
globalThis.getLiveChannel = () => 'chan-a'

const { bumpEmoteFrecency, loadEmoteFrecency, unbumpEmoteFrecency } = await import('../src/multichat/emotes.js')

describe('emote frecency store', () => {
  beforeEach(() => store.clear())

  test('repeated use beats a single later stray insert', () => {
    for (let i = 0; i < 5; i++) bumpEmoteFrecency('KKona')
    bumpEmoteFrecency('KKonaLand')
    const f = loadEmoteFrecency()
    expect(f.get('KKona')).toBeGreaterThan(f.get('KKonaLand'))
  })

  test('score halves per week since last use', () => {
    bumpEmoteFrecency('KKona')
    const raw = JSON.parse(store.get('hs-mc-emote-frecency'))
    raw.KKona.t = Date.now() - 7 * 24 * 3600e3
    store.set('hs-mc-emote-frecency', JSON.stringify(raw))
    const s = loadEmoteFrecency().get('KKona')
    expect(s).toBeGreaterThan(0.45)
    expect(s).toBeLessThan(0.55)
  })

  test('seeds from the legacy MRU list on first run, preserving its order', () => {
    store.set('hs-mc-recent-emotes', JSON.stringify(['Newer', 'Older']))
    const f = loadEmoteFrecency()
    expect(f.get('Newer')).toBeGreaterThan(f.get('Older'))
    expect(f.get('Older')).toBeGreaterThan(0)
  })

  test('caps the store at 200 names, evicting lowest scores', () => {
    for (let i = 0; i < 210; i++) bumpEmoteFrecency(`emote${i}`)
    const raw = JSON.parse(store.get('hs-mc-emote-frecency'))
    expect(Object.keys(raw).length).toBeLessThanOrEqual(200)
    // the most recent bumps survived
    expect(raw.emote209).toBeDefined()
  })

  test('unbump reverts a bump exactly — cycling PAST an emote leaves no trace', () => {
    // Pin the clock: frecency scores decay with Date.now(), so the two
    // loadEmoteFrecency() calls only agree to 1e-10 when they land on the
    // SAME millisecond — un-pinned this failed ~1/10 runs on a ms tick
    // (blocked a cw-land and a build gate on 2026-07-05).
    setSystemTime(new Date('2026-07-05T00:00:00Z'))
    try {
      bumpEmoteFrecency('KKona')
      const before = loadEmoteFrecency().get('KKona')
      // cycle visits KKonaLand then moves on: bump + unbump must cancel out
      bumpEmoteFrecency('KKonaLand')
      unbumpEmoteFrecency('KKonaLand')
      const f = loadEmoteFrecency()
      expect(f.get('KKonaLand')).toBeUndefined()
      expect(f.get('KKona')).toBeCloseTo(before, 10)
    } finally {
      setSystemTime()
    }
  })

  test('unbump only removes one use — real habit survives a cycle-past', () => {
    bumpEmoteFrecency('KKona')
    bumpEmoteFrecency('KKona')
    bumpEmoteFrecency('KKona')
    unbumpEmoteFrecency('KKona')
    expect(loadEmoteFrecency().get('KKona')).toBeGreaterThan(1.9)
  })

  // findEmoteMatches calls loadEmoteFrecency() on every debounced keystroke —
  // it's cached (keyed off the raw localStorage string) instead of re-reading
  // + JSON.parsing + rebuilding the decayed Map every call.
  describe('loadEmoteFrecency caching', () => {
    test('repeated calls with no write between them return the same Map instance', () => {
      bumpEmoteFrecency('KKona')
      const a = loadEmoteFrecency()
      const b = loadEmoteFrecency()
      expect(a).toBe(b)
    })

    test('a bump invalidates the cache — the next read sees the new value', () => {
      bumpEmoteFrecency('KKona')
      const before = loadEmoteFrecency()
      bumpEmoteFrecency('KKona')
      const after = loadEmoteFrecency()
      expect(after).not.toBe(before)
      expect(after.get('KKona')).toBeGreaterThan(before.get('KKona'))
    })

    test('an unbump invalidates the cache too', () => {
      bumpEmoteFrecency('KKona')
      bumpEmoteFrecency('KKona')
      const before = loadEmoteFrecency()
      unbumpEmoteFrecency('KKona')
      const after = loadEmoteFrecency()
      expect(after).not.toBe(before)
      expect(after.get('KKona')).toBeLessThan(before.get('KKona'))
    })

    test('a write to the store bypassing bump/unbump still invalidates (self-healing signature check)', () => {
      bumpEmoteFrecency('KKona')
      const before = loadEmoteFrecency()
      const raw = JSON.parse(store.get('hs-mc-emote-frecency'))
      raw.KKonaLand = { n: 99, t: Date.now() }
      store.set('hs-mc-emote-frecency', JSON.stringify(raw))
      const after = loadEmoteFrecency()
      expect(after).not.toBe(before)
      expect(after.get('KKonaLand')).toBeCloseTo(99, 0)
    })
  })
})

// ── native-chat hook (chrome/autocomplete-hook.js) parity guards ────────────
// The MAIN-world hook can't import emotes.js/input.js, so its frecency store
// and all three of its completion sorts (getMatches dropdown, remote-merge
// cycle, local cycle rebuild) duplicate the logic by design. These guards
// keep the copies from drifting — the original kko bug shipped exactly
// because two sort sites disagreed.
const HOOK_SRC = readFileSync(join(import.meta.dir, '..', 'chrome', 'autocomplete-hook.js'), 'utf8')

describe('autocomplete-hook.js — stays in lockstep with the multichat', () => {
  test('shares the frecency localStorage key and half-life with emotes.js', () => {
    expect(HOOK_SRC).toContain("'hs-mc-emote-frecency'")
    expect(HOOK_SRC).toContain('7 * 24 * 3600e3')
  })

  test('hook frecency math matches emotes.js (carved + behavior-compared)', () => {
    const s = HOOK_SRC.indexOf('const HS_FRECENCY_CAP') // includes the half-life const
    const e = HOOK_SRC.indexOf('function _hsFrecRaw(')
    const hookScore = new Function(`${HOOK_SRC.slice(s, e)}; return _hsFrecScore`)()
    const now = Date.now()
    const entry = { n: 5, t: now - 3 * 24 * 3600e3 }
    // emotes.js equivalent: n * 2^(-age/halfLife)
    expect(hookScore(entry, now)).toBeCloseTo(5 * 2 ** (-3 / 7), 10)
    expect(hookScore(null, now)).toBe(0)
    expect(hookScore({ n: 0, t: now }, now)).toBe(0)
  })

  test('both ranking sort sites consult frecency (used-before beats tier)', () => {
    // getMatches dropdown sort
    expect(HOOK_SRC).toContain('const aUsed = a._frec > 0')
    // local cycle rebuild sort
    expect(HOOK_SRC).toContain('const frecCyc = readEmoteFrecency()')
    // The remote merge deliberately does NOT rank (so no frecency there): it
    // is append-only, because a mid-cycle full re-sort reordered entries under
    // the user and ran the tooltip backwards (4/4 → 2/70). Guard the invariant.
    expect(HOOK_SRC).toContain('Append-only merge')
    expect(HOOK_SRC).not.toContain('const frecCycle = readEmoteFrecency()')
  })

  test('every sort that ranks exacts puts the channel emote first among same-name exacts', () => {
    // two sorts in autocomplete-hook.js (dropdown + local cycle rebuild) and kick's
    expect(HOOK_SRC.match(/\(a\.(_tier|tier) === 0\) !== \(b\.\1 === 0\)/g)?.length).toBe(2)
    const KICK_SRC = readFileSync(join(import.meta.dir, '..', 'chrome', 'kick-autocomplete-hook.js'), 'utf8')
    expect(KICK_SRC).toContain('(a.tier === 0) !== (b.tier === 0)')
  })

  test('inserts keep feeding both stores (MRU list for the picker + frecency)', () => {
    const s = HOOK_SRC.indexOf('function recordRecentEmoteMru(')
    const body = HOOK_SRC.slice(s, s + 700)
    expect(body).toContain('bumpEmoteFrecency(name)')
    expect(body).toContain('HS_RECENT_EMOTES_KEY')
  })

  test('usage records where the user STOPS, not on every cycle step', () => {
    // single recording authority inside insertEmoteViaSlate, cycle-aware
    expect(HOOK_SRC).toContain('if (isCycling && _frecSessionBumped && _frecSessionBumped !== matchedEmote.name)')
    // the cycle path must NOT also record (that double-bumped every step and
    // let the #1-ranked emote entrench itself on each failed "kko"+Tab attempt)
    expect(HOOK_SRC).not.toContain('recordRecentEmoteMru(nextEmote.name)')
    // multichat mirrors the same commit semantics
    const inputSrc = INPUT_SRC
    expect(inputSrc).toContain('unbumpEmoteFrecency(acState._frecBumped)')
    expect(inputSrc).toContain('acState._frecBumped = null // session over — whatever was last bumped is the commit')
  })
})

describe('moment ¶ shift-click paste (main.js) — in-chat visibility loop', () => {
  const MAIN_SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'main.js'), 'utf8')
  test('shift-click pastes into the input, never auto-sends, and appends to a draft', () => {
    const s = MAIN_SRC.indexOf("if (m.type === 'moment')")
    const body = MAIN_SRC.slice(s, s + 3000)
    expect(body).toContain("closest?.('a.hs-mc-moment-perma')")
    expect(body).toContain('e.shiftKey')
    expect(body).toContain('e.preventDefault()')
    expect(body).toContain('restoreWysiwygText(input, next)')
    expect(body).not.toContain('sendMessage(')
    expect(body).toContain('shift-click to paste into chat')
  })
})
