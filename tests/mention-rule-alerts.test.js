import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SETTINGS } from '../src/lib/settings-schema.js'
import { compileFilterRules, evaluateFilterRules } from '../src/multichat/filter-rules.js'
import { mainSource } from './main-src.js'

/**
 * Two ways to be told about a message without an @you:
 *
 *   - a highlight rule with "also notify me" (works with no heatsync login): the
 *     verdict carries `notify`, ruleAlertsMention() turns it into a mention for
 *     the handlers, notifyMention() shows it without the mention ping
 *   - the setting "mention sound plays: only when i'm away / always"
 *
 * mentions.js is concatenated into one scope and can't be imported, so its real
 * functions are cut out of the shipped source and run against stubs.
 */
const ROOT = join(import.meta.dir, '..')
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8')
const MENTIONS = read('src', 'multichat', 'mentions.js')
const slice = (name) => {
  const at = MENTIONS.indexOf(`function ${name}(`)
  expect(at, `${name} not found`).toBeGreaterThan(-1)
  return MENTIONS.slice(at, MENTIONS.indexOf('\n}\n', at) + 3)
}

const msg = (over = {}) => ({ text: 'a big win', user: 'someone', platform: 'twitch', badges: '', ...over })
const rule = (over = {}) => ({
  id: Math.random().toString(36).slice(2),
  enabled: true,
  scope: 'all',
  match: { type: 'keyword', value: 'win', caseSensitive: false },
  action: 'highlight',
  color: '#ffff00',
  ...over,
})

beforeEach(() => compileFilterRules([]))

describe('the rule verdict carries notify', () => {
  test('a matching highlight rule that asks for it', () => {
    compileFilterRules([rule({ notify: true })])
    expect(evaluateFilterRules(msg(), null).notify).toBe(true)
  })

  test('false when the rule does not ask, when nothing matches, and with no rules', () => {
    compileFilterRules([rule()])
    expect(evaluateFilterRules(msg(), null).notify).toBe(false)
    compileFilterRules([rule({ notify: true })])
    expect(evaluateFilterRules(msg({ text: 'nothing here' }), null).notify).toBe(false)
    compileFilterRules([])
    expect(evaluateFilterRules(msg(), null).notify).toBe(false)
  })

  test('a hide rule never alerts, even with a stray notify flag', () => {
    compileFilterRules([rule({ action: 'hide', notify: true })])
    const v = evaluateFilterRules(msg(), null)
    expect(v.hide).toBe(true)
    expect(v.notify).toBe(false)
  })

  test('any matching highlight can ask: it does not matter which rule came first', () => {
    compileFilterRules([rule({ color: '#ff0000' }), rule({ color: '#00ff00', notify: true })])
    const v = evaluateFilterRules(msg(), null)
    expect(v.highlight).toBe('#ff0000') // first match still owns the colour
    expect(v.notify).toBe(true)
  })

  test('a disabled rule does not alert', () => {
    compileFilterRules([rule({ notify: true, enabled: false })])
    expect(evaluateFilterRules(msg(), null).notify).toBe(false)
  })

  test("the rule's own match is what asks: a scoped rule stays in its channel", () => {
    compileFilterRules([rule({ notify: true, scope: 'chan-1' })])
    expect(evaluateFilterRules(msg(), 'chan-2').notify).toBe(false)
    expect(evaluateFilterRules(msg(), 'chan-1').notify).toBe(true)
  })
})

describe('ruleAlertsMention', () => {
  function load({ mentionsOn = true, blocked = [] } = {}) {
    const g = {
      isEnabled: (k) => (k === 'mentions' ? mentionsOn : true),
      isUserBlocked: (u) => blocked.includes(u),
    }
    return new Function(...Object.keys(g), `${slice('ruleAlertsMention')}\nreturn ruleAlertsMention`)(
      ...Object.values(g),
    )
  }

  test('yes for a verdict that asks, no login involved', () => {
    expect(load()(msg(), { notify: true })).toBe(true)
  })
  test('no for a verdict that does not ask, or no verdict (own messages get none)', () => {
    expect(load()(msg(), { notify: false })).toBe(false)
    expect(load()(msg(), null)).toBe(false)
    expect(load()(msg(), undefined)).toBe(false)
  })
  test('no when the mentions switch is off', () => {
    expect(load({ mentionsOn: false })(msg(), { notify: true })).toBe(false)
  })
  test('no for a blocked user', () => {
    expect(load({ blocked: ['someone'] })(msg(), { notify: true })).toBe(false)
    expect(load({ blocked: ['other'] })(msg(), { notify: true })).toBe(true)
  })
})

describe('notifyMention + the mention sound setting', () => {
  function load({ focused = false, when = 'away', notifs = true, flash = true } = {}) {
    const calls = { ping: [], flash: [], fired: [], sr: [] }
    const g = {
      document: { hasFocus: () => focused },
      playMentionPing: (v) => calls.ping.push(v),
      _titleFlashStart: (u) => calls.flash.push(u),
      mentionSoundVolume: 0.5,
      mentionTitleFlash: flash,
      notificationsEnabled: notifs,
      truncateSafe: (s) => s,
      resolveNotifIcon: () => Promise.resolve('icon'),
      fireNotification: (title, body) => calls.fired.push([title, body]),
      srAnnounceMention: (m) => calls.sr.push(m),
    }
    const api = new Function(
      ...Object.keys(g),
      `let mentionSoundWhen = ${JSON.stringify(when)}
       ${slice('readMentionUi')}
       ${slice('notifyMention')}
       return { notifyMention, readMentionUi, get when() { return mentionSoundWhen } }`,
    )(...Object.values(g))
    api.calls = calls // (a spread would freeze the live `when` getter)
    return api
  }

  test('default is away-only: unfocused rings, focused stays quiet (how it always worked)', async () => {
    const away = load({ focused: false })
    away.notifyMention(msg({ text: '@me hi' }))
    expect(away.calls.ping).toEqual([0.5])
    const here = load({ focused: true })
    here.notifyMention(msg({ text: '@me hi' }))
    expect(here.calls.ping).toEqual([])
  })

  test('"always" rings while you are looking at the window too', () => {
    const here = load({ focused: true, when: 'always' })
    here.notifyMention(msg({ text: '@me hi' }))
    expect(here.calls.ping).toEqual([0.5])
    expect(here.calls.flash).toEqual([]) // the tab title only flashes while you are away
    expect(here.calls.fired).toEqual([]) // and so does the desktop notice
  })

  test('the setting is read from the synced settings, junk values are ignored', () => {
    const m = load({ when: 'away' })
    m.readMentionUi({ mentionSoundWhen: 'always' })
    expect(m.when).toBe('always')
    m.readMentionUi({ mentionSoundWhen: 'sometimes' })
    expect(m.when).toBe('always') // not a known value: unchanged
    m.readMentionUi({})
    expect(m.when).toBe('always')
    m.readMentionUi({ mentionSoundWhen: 'away' })
    expect(m.when).toBe('away')
  })

  test('a rule alert shows like a mention but never plays the mention ping', async () => {
    const m = load({ focused: false })
    m.notifyMention(msg({ user: 'ann', channel: 'chan', text: 'a big win' }), true)
    expect(m.calls.ping).toEqual([]) // the rule already played its own sound
    expect(m.calls.flash).toEqual(['ann'])
    await new Promise((r) => setTimeout(r, 0))
    expect(m.calls.fired).toEqual([['ann in #chan', 'a big win']])
  })

  test('a rule alert in a focused window stays quiet, even on "always"', () => {
    const m = load({ focused: true, when: 'always' })
    m.notifyMention(msg(), true)
    expect(m.calls.ping).toEqual([])
    expect(m.calls.flash).toEqual([])
    expect(m.calls.fired).toEqual([])
  })

  test('the desktop notice follows its own switch; the title flash follows its own', async () => {
    const m = load({ focused: false, notifs: false, flash: false })
    m.notifyMention(msg(), true)
    await new Promise((r) => setTimeout(r, 0))
    expect(m.calls.fired).toEqual([])
    expect(m.calls.flash).toEqual([])
  })
})

describe('the setting', () => {
  const def = SETTINGS.find((s) => s.key === 'mentionSoundWhen')
  test('is a plain two-way choice that defaults to how it always worked', () => {
    expect(def).toBeTruthy()
    expect(def.default).toBe('away')
    expect(def.type).toBe('enum')
    expect(def.options.map((o) => o.value)).toEqual(['away', 'always'])
    expect(def.basic).toBe(true)
  })
  test('every string it shows comes from the catalog, in every language', () => {
    const keys = [def.labelKey, def.tipKey, ...def.options.map((o) => o.labelKey)]
    for (const loc of ['en', 'de', 'ja', 'ar', 'pt_BR']) {
      const cat = JSON.parse(read('src', '_locales', loc, 'messages.json'))
      for (const k of keys) expect(cat[k]?.message?.length, `${loc} ${k}`).toBeGreaterThan(0)
    }
  })
})

describe('the three chat handlers (twitch + kick in main, youtube in social)', () => {
  const all = `${mainSource()}\n${read('src', 'multichat', 'social.js')}`
  const count = (needle) => all.split(needle).length - 1

  test('each asks ruleAlertsMention, and a rule alert goes to the mentions tab and the notice', () => {
    expect(count('ruleAlertsMention(')).toBe(3)
    expect(count('const isMent = _mentReal || _mentRule')).toBe(3)
    expect(count(', _mentRule)')).toBe(3) // notifyMention(msg, _mentRule): the ping stays out of it
  })

  test('only a real @you counts toward the stream stats mention total', () => {
    expect(count(', _mentReal)')).toBe(3) // bumpStreamStats(channel, msg, _mentReal)
    expect(count(', isMent)')).toBe(0) // the old call counted every alert
  })
})
