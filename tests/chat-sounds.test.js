import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compileFilterRules, evaluateFilterRules } from '../src/multichat/filter-rules.js'
import { mainSource } from './main-src.js'

/**
 * Chat sounds: presets or a picked audio file, per-rule volume, one rate limit.
 *
 * The engine (sounds.js) runs for real against a stand-in AudioContext, so the
 * numbers below are what the speakers would get: gain values, which nodes
 * start, whether a cue is dropped. The wiring in mentions.js / settings-ui.js /
 * sound-ui.js (not importable — they are concatenated into one scope) is run
 * from the shipped source with stubbed globals, the way mention-rules.test.js
 * does it.
 */

const ROOT = join(import.meta.dir, '..')
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8')

// ── a stand-in Web Audio ──────────────────────────────────────────────────────
let ctx
let store
let timers
let clock
let realNow

function makeCtx() {
  const c = {
    state: 'running',
    currentTime: 10,
    destination: { id: 'dest' },
    gains: [],
    oscs: [],
    sources: [],
    decodes: 0,
    resumes: 0,
    suspends: 0,
    resumeImpl: null,
    decodeImpl: null,
    createGain() {
      const g = {
        gain: {
          value: 1,
          sets: [],
          ramps: [],
          setValueAtTime(v, t) {
            g.gain.sets.push([v, t])
          },
          linearRampToValueAtTime(v, t) {
            g.gain.ramps.push([v, t])
          },
          exponentialRampToValueAtTime() {},
        },
        connect() {},
        disconnect() {},
      }
      c.gains.push(g)
      return g
    },
    createOscillator() {
      const o = {
        type: '',
        frequency: { setValueAtTime() {} },
        started: [],
        connect() {},
        start(t) {
          o.started.push(t)
        },
        stop() {},
      }
      c.oscs.push(o)
      return o
    },
    createBufferSource() {
      const s = {
        buffer: null,
        starts: 0,
        stops: 0,
        onended: null,
        connect() {},
        disconnect() {},
        start() {
          s.starts++
        },
        stop() {
          s.stops++
        },
      }
      c.sources.push(s)
      return s
    },
    async decodeAudioData(bytes) {
      c.decodes++
      if (c.decodeImpl) return c.decodeImpl(bytes)
      return { duration: 1.5, length: 66150, bytes: bytes.byteLength }
    },
    resume() {
      c.resumes++
      if (c.resumeImpl) return c.resumeImpl()
      c.state = 'running'
      return Promise.resolve()
    },
    suspend() {
      c.suspends++
      c.state = 'suspended'
      return Promise.resolve()
    },
  }
  return c
}

let importN = 0
async function fresh() {
  // a new module instance each time: the context, rate limits and decoded-file
  // cache are module state, and a test must not inherit the last one's
  return import(`../src/multichat/sounds.js?case=${++importN}`)
}

const flush = () => new Promise((r) => setTimeout(r, 0))
const b64 = (s) => btoa(s)
const audioFile = (over = {}) => {
  const bytes = over.bytes ?? new Uint8Array([1, 2, 3, 4, 5])
  return {
    name: 'airhorn.mp3',
    type: 'audio/mpeg',
    size: over.size ?? bytes.byteLength,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    ...over,
  }
}

beforeEach(() => {
  ctx = makeCtx()
  store = {}
  timers = []
  clock = 1_000_000
  realNow = Date.now
  Date.now = () => clock
  globalThis.AudioContext = function AudioContextStub() {
    return ctx
  }
  globalThis.cleanup = {
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms })
      return timers.length
    },
    clearTimeout: () => {},
    addListener: (target, fn) => {
      target.listeners.push(fn)
    },
  }
  globalThis.api = {
    storage: {
      onChanged: { listeners: [] },
      local: {
        get: async (key) => (key in store ? { [key]: store[key] } : {}),
        set: async (obj) => {
          Object.assign(store, JSON.parse(JSON.stringify(obj)))
        },
        remove: async (key) => {
          delete store[key]
        },
      },
    },
  }
})

afterEach(() => {
  Date.now = realNow
  delete globalThis.AudioContext
  delete globalThis.cleanup
  delete globalThis.api
})

// ── picking a file: type and size are rejected before anything is read ────────
describe('picking a file', () => {
  test('rejects anything that is not audio, with the reason', async () => {
    const s = await fresh()
    expect(s.sfxCheckFile({ name: 'a.txt', type: 'text/plain', size: 10 })).toBe('type')
    expect(s.sfxCheckFile({ name: 'a.png', type: 'image/png', size: 10 })).toBe('type')
    expect(s.sfxCheckFile({ name: 'a.mp4', type: 'video/mp4', size: 10 })).toBe('type')
    expect(s.sfxCheckFile({ name: 'notes', type: '', size: 10 })).toBe('type')
    expect(s.sfxCheckFile(null)).toBe('type')
  })

  test('audio/* passes; so does an untyped file with an audio extension', async () => {
    const s = await fresh()
    expect(s.sfxCheckFile({ name: 'a.ogg', type: 'audio/ogg', size: 10 })).toBe(null)
    expect(s.sfxCheckFile({ name: 'a.wav', type: 'audio/x-wav', size: 10 })).toBe(null)
    expect(s.sfxCheckFile({ name: 'a.OPUS', type: '', size: 10 })).toBe(null)
  })

  test('256 kb is the hard cap: the limit passes, one byte over is refused', async () => {
    const s = await fresh()
    expect(s.SFX_MAX_BYTES).toBe(256 * 1024)
    expect(s.sfxCheckFile({ name: 'a.mp3', type: 'audio/mpeg', size: 256 * 1024 })).toBe(null)
    expect(s.sfxCheckFile({ name: 'a.mp3', type: 'audio/mpeg', size: 256 * 1024 + 1 })).toBe('size')
  })

  test('a wrong type is reported as a wrong type even when it is also huge', async () => {
    const s = await fresh()
    expect(s.sfxCheckFile({ name: 'a.zip', type: 'application/zip', size: 5_000_000 })).toBe('type')
  })

  test('the real byte count is checked too, not only the size the file claims', async () => {
    const s = await fresh()
    const liar = audioFile({ size: 100, bytes: new Uint8Array(256 * 1024 + 1) })
    expect(await s.sfxPrepareFile(liar)).toEqual({ ok: false, reason: 'size' })
    expect(ctx.decodes).toBe(0)
  })

  test('a file the browser cannot decode is refused as unreadable', async () => {
    const s = await fresh()
    ctx.decodeImpl = () => {
      throw new Error('EncodingError')
    }
    expect(await s.sfxPrepareFile(audioFile())).toEqual({ ok: false, reason: 'decode' })
  })

  test('an empty or zero-length decode is unreadable', async () => {
    const s = await fresh()
    ctx.decodeImpl = () => ({ duration: 0 })
    expect(await s.sfxPrepareFile(audioFile())).toEqual({ ok: false, reason: 'decode' })
  })

  test('a sound that rings for more than 10 seconds is refused', async () => {
    const s = await fresh()
    ctx.decodeImpl = () => ({ duration: 10 })
    expect((await s.sfxPrepareFile(audioFile())).ok).toBe(true)
    ctx.decodeImpl = () => ({ duration: 10.01 })
    expect(await s.sfxPrepareFile(audioFile())).toEqual({ ok: false, reason: 'long' })
  })

  test('a good file is prepared, not stored: nothing lands until the person commits', async () => {
    const s = await fresh()
    const res = await s.sfxPrepareFile(audioFile({ name: 'C:\\sounds\\air horn.mp3' }))
    expect(res.ok).toBe(true)
    expect(res.sound.n).toBe('air horn.mp3') // directories stripped
    expect(res.sound.t).toBe('audio/mpeg')
    expect(res.sound.b).toBe(b64('\x01\x02\x03\x04\x05'))
    expect(Object.keys(store)).toEqual([])
  })

  test('names are cleaned and capped', async () => {
    const s = await fresh()
    expect(s.sfxCleanName('a\u0000b\n.mp3')).toBe('ab.mp3')
    expect(s.sfxCleanName('x'.repeat(200)).length).toBe(60)
    expect(s.sfxCleanName('')).toBe('sound')
    expect(s.sfxCleanName('/')).toBe('sound')
  })
})

// ── volume → gain ─────────────────────────────────────────────────────────────
describe('gain mapping', () => {
  test('synth keeps today\u2019s loudness: volume x 0.35', async () => {
    const s = await fresh()
    expect(s.sfxGain(0.3)).toBe(Math.min(1, 0.3) * 0.35) // the mention ping's own expression
    expect(s.sfxGain(1)).toBe(0.35)
    expect(s.sfxGain(0)).toBe(0)
  })

  test('a picked file plays at volume x its own level', async () => {
    const s = await fresh()
    expect(s.sfxGain(0.5, true)).toBe(0.5)
    expect(s.sfxGain(1, true)).toBe(1)
  })

  test('out-of-range and junk volumes are clamped, never amplified', async () => {
    const s = await fresh()
    expect(s.sfxGain(7)).toBe(0.35)
    expect(s.sfxGain(7, true)).toBe(1)
    expect(s.sfxGain(-3)).toBe(0)
    expect(s.sfxGain('x')).toBe(0)
    expect(s.sfxGain(undefined, true)).toBe(0)
  })

  test('a preset at the default volume reaches the output at exactly today\u2019s gain', async () => {
    const s = await fresh()
    expect(await s.sfxPlay({ name: 'ping', volume: 0.3 }, 'rule', false)).toBe('played')
    // the rule ping is two tones, each ramped to the same peak the old player used
    expect(ctx.gains.map((g) => g.gain.ramps[0][0])).toEqual([0.3 * 0.35, 0.3 * 0.35])
    expect(ctx.oscs.length).toBe(2)
  })

  test('the @mention ping keeps its original voicing: one shared envelope, two oscillators', async () => {
    const s = await fresh()
    expect(await s.sfxPlay({ name: 'ping', volume: 0.3 }, 'mention', false)).toBe('played')
    expect(ctx.gains.length).toBe(1)
    expect(ctx.gains[0].gain.ramps[0][0]).toBe(Math.min(1, 0.3) * 0.35)
    expect(ctx.oscs.length).toBe(2)
  })

  test('a picked file is set at the volume given', async () => {
    const s = await fresh()
    store.hs_sfx_mention = { n: 'a.mp3', t: 'audio/mpeg', b: b64('abc') }
    expect(await s.sfxPlay({ name: 'custom', key: 'hs_sfx_mention', volume: 0.5 }, 'mention', false)).toBe('played')
    expect(ctx.sources.length).toBe(1)
    expect(ctx.sources[0].starts).toBe(1)
    expect(ctx.gains[0].gain.sets[0][0]).toBe(0.5)
  })

  test('volume 0 is silent: nothing is created, no context is even asked for', async () => {
    const s = await fresh()
    expect(await s.sfxPlay({ name: 'ping', volume: 0 }, 'rule', false)).toBe('silent')
    expect(ctx.gains.length + ctx.sources.length).toBe(0)
  })

  test('an unknown sound name is silent, as before', async () => {
    const s = await fresh()
    expect(await s.sfxPlay({ name: 'airhorn', volume: 1 }, 'rule', false)).toBe('silent')
    expect(ctx.gains.length).toBe(0)
  })
})

// ── the rate limit ────────────────────────────────────────────────────────────
describe('throttle', () => {
  test('a raid of matches plays once per 1.2 seconds, not once per message', async () => {
    const s = await fresh()
    const results = []
    for (let i = 0; i < 40; i++) {
      results.push(await s.sfxPlay({ name: 'blip', volume: 0.3 }, 'rule', false))
      clock += 20 // 40 messages inside 800ms
    }
    expect(results.filter((r) => r === 'played').length).toBe(1)
    expect(results.filter((r) => r === 'throttled').length).toBe(39)
    expect(ctx.oscs.length).toBe(1)
  })

  test('it opens again after the window', async () => {
    const s = await fresh()
    expect(await s.sfxPlay({ name: 'blip', volume: 0.3 }, 'rule', false)).toBe('played')
    clock += s.SFX_THROTTLE_MS - 1
    expect(await s.sfxPlay({ name: 'blip', volume: 0.3 }, 'rule', false)).toBe('throttled')
    clock += 1
    expect(await s.sfxPlay({ name: 'blip', volume: 0.3 }, 'rule', false)).toBe('played')
  })

  test('picked files are rate-limited the same way', async () => {
    const s = await fresh()
    store.hs_sfx_rule_r1 = { n: 'a.mp3', t: 'audio/mpeg', b: b64('abc') }
    const spec = { name: 'custom', key: 'hs_sfx_rule_r1', volume: 0.3 }
    expect(await s.sfxPlay(spec, 'rule', false)).toBe('played')
    expect(await s.sfxPlay(spec, 'rule', false)).toBe('throttled')
    expect(ctx.sources.length).toBe(1)
  })

  test('mentions and rules are limited separately: one message can sound both', async () => {
    const s = await fresh()
    expect(await s.sfxPlay({ name: 'blip', volume: 0.3 }, 'rule', false)).toBe('played')
    expect(await s.sfxPlay({ name: 'ping', volume: 0.3 }, 'mention', false)).toBe('played')
    expect(await s.sfxPlay({ name: 'ping', volume: 0.3 }, 'mention', false)).toBe('throttled')
  })

  test('a person pressing play is never rate-limited', async () => {
    const s = await fresh()
    expect(await s.sfxPlay({ name: 'blip', volume: 0.3 }, 'rule', true)).toBe('played')
    expect(await s.sfxPlay({ name: 'blip', volume: 0.3 }, 'rule', true)).toBe('played')
    expect(ctx.oscs.length).toBe(2)
  })

  test('a preview does not use up the window of a real cue', async () => {
    const s = await fresh()
    await s.sfxPlay({ name: 'blip', volume: 0.3 }, 'rule', true)
    expect(await s.sfxPlay({ name: 'blip', volume: 0.3 }, 'rule', false)).toBe('played')
  })

  test('only one picked file sounds at a time per bucket: the newer cuts the older', async () => {
    const s = await fresh()
    store.hs_sfx_rule_r1 = { n: 'a.mp3', t: 'audio/mpeg', b: b64('abc') }
    const spec = { name: 'custom', key: 'hs_sfx_rule_r1', volume: 0.3 }
    await s.sfxPlay(spec, 'rule', true)
    await s.sfxPlay(spec, 'rule', true)
    expect(ctx.sources.length).toBe(2)
    expect(ctx.sources[0].stops).toBe(1)
    expect(ctx.sources[1].stops).toBe(0)
  })
})

// ── the file is not there / not usable → a preset plays, nothing throws ───────
describe('missing sound', () => {
  test('a rule whose file is not on this device plays the ping instead', async () => {
    const s = await fresh()
    expect(await s.sfxPlay({ name: 'custom', key: 'hs_sfx_rule_gone', volume: 0.3 }, 'rule', false)).toBe('fallback')
    expect(ctx.sources.length).toBe(0)
    expect(ctx.oscs.length).toBe(2) // the ping
  })

  test('a custom sound with no key at all falls back too', async () => {
    const s = await fresh()
    expect(await s.sfxPlay({ name: 'custom', volume: 0.3 }, 'rule', false)).toBe('fallback')
  })

  test('a stored file that will not decode falls back instead of staying silent', async () => {
    const s = await fresh()
    store.hs_sfx_mention = { n: 'a.mp3', t: 'audio/mpeg', b: b64('abc') }
    ctx.decodeImpl = () => {
      throw new Error('EncodingError')
    }
    expect(await s.sfxPlay({ name: 'custom', key: 'hs_sfx_mention', volume: 0.3 }, 'mention', false)).toBe('fallback')
    expect(ctx.oscs.length).toBe(2)
  })

  test('a mangled record (not a string, or far too big) is ignored', async () => {
    const s = await fresh()
    store.hs_sfx_a = { n: 'a', b: 42 }
    store.hs_sfx_b = { n: 'a', b: 'A'.repeat(400_000) }
    expect(await s.sfxPlay({ name: 'custom', key: 'hs_sfx_a', volume: 0.3 }, 'rule', true)).toBe('fallback')
    expect(await s.sfxPlay({ name: 'custom', key: 'hs_sfx_b', volume: 0.3 }, 'rule', true)).toBe('fallback')
    expect(ctx.decodes).toBe(0)
  })

  test('a storage read that throws falls back', async () => {
    const s = await fresh()
    globalThis.api.storage.local.get = async () => {
      throw new Error('context invalidated')
    }
    expect(await s.sfxPlay({ name: 'custom', key: 'hs_sfx_mention', volume: 0.3 }, 'mention', true)).toBe('fallback')
  })

  test('a file picked in another tab is heard on the next cue (decoded copy is dropped on change)', async () => {
    const s = await fresh()
    store.hs_sfx_mention = { n: 'a.mp3', t: 'audio/mpeg', b: b64('abc') }
    const spec = { name: 'custom', key: 'hs_sfx_mention', volume: 0.3 }
    await s.sfxPlay(spec, 'mention', true)
    await s.sfxPlay(spec, 'mention', true)
    expect(ctx.decodes).toBe(1) // second cue reused the decoded copy
    for (const fn of globalThis.api.storage.onChanged.listeners) fn({ hs_sfx_mention: {} }, 'local')
    await s.sfxPlay(spec, 'mention', true)
    expect(ctx.decodes).toBe(2)
  })

  test('removing a file drops it: the next cue falls back', async () => {
    const s = await fresh()
    store.hs_sfx_mention = { n: 'a.mp3', t: 'audio/mpeg', b: b64('abc') }
    const spec = { name: 'custom', key: 'hs_sfx_mention', volume: 0.3 }
    expect(await s.sfxPlay(spec, 'mention', true)).toBe('played')
    await s.sfxRemove('hs_sfx_mention')
    expect(store.hs_sfx_mention).toBeUndefined()
    expect(await s.sfxPlay(spec, 'mention', true)).toBe('fallback')
  })

  test('saving stores only name, type and bytes, never the decoded buffer', async () => {
    const s = await fresh()
    const prepared = (await s.sfxPrepareFile(audioFile())).sound
    expect(await s.sfxSave(s.sfxRuleKey('r9'), prepared)).toBe(true)
    expect(Object.keys(store)).toEqual(['hs_sfx_rule_r9'])
    expect(Object.keys(store.hs_sfx_rule_r9).sort()).toEqual(['b', 'n', 't'])
  })

  test('a failed save says so (and the caller adds no rule)', async () => {
    const s = await fresh()
    globalThis.api.storage.local.set = async () => {
      throw new Error('QUOTA_BYTES')
    }
    expect(await s.sfxSave('hs_sfx_mention', { n: 'a', t: '', b: 'AAAA' })).toBe(false)
  })
})

// ── the browser will not start audio without a user gesture ───────────────────
describe('suspended audio context', () => {
  test('no AudioContext at all: nothing throws, nothing plays', async () => {
    delete globalThis.AudioContext
    const s = await fresh()
    expect(await s.sfxPlay({ name: 'ping', volume: 0.3 }, 'rule', false)).toBe('blocked')
  })

  test('a suspended context is resumed, then the cue plays', async () => {
    const s = await fresh()
    ctx.state = 'suspended'
    expect(await s.sfxPlay({ name: 'blip', volume: 0.3 }, 'rule', false)).toBe('played')
    expect(ctx.resumes).toBe(1)
    expect(ctx.oscs.length).toBe(1)
  })

  test('autoplay refused (resume settles but stays suspended): dropped, no throw, nothing queued', async () => {
    const s = await fresh()
    ctx.state = 'suspended'
    ctx.resumeImpl = () => Promise.resolve() // allowed to settle, still suspended
    expect(await s.sfxPlay({ name: 'blip', volume: 0.3 }, 'rule', false)).toBe('blocked')
    expect(ctx.oscs.length + ctx.sources.length).toBe(0)
  })

  test('resume() that throws or rejects is swallowed', async () => {
    const s = await fresh()
    ctx.state = 'suspended'
    ctx.resumeImpl = () => {
      throw new Error('InvalidStateError')
    }
    expect(await s.sfxPlay({ name: 'blip', volume: 0.3 }, 'rule', true)).toBe('blocked')
    ctx.resumeImpl = () => Promise.reject(new Error('closed'))
    expect(await s.sfxPlay({ name: 'blip', volume: 0.3 }, 'rule', true)).toBe('blocked')
    expect(ctx.oscs.length).toBe(0)
  })

  test('a cue the browser only lets start long after it was asked for is dropped, not replayed', async () => {
    const s = await fresh()
    ctx.state = 'suspended'
    let release
    ctx.resumeImpl = () =>
      new Promise((resolve) => {
        release = () => {
          ctx.state = 'running'
          resolve()
        }
      })
    const pending = s.sfxPlay({ name: 'blip', volume: 0.3 }, 'rule', false)
    clock += 60_000 // the person finally clicks the page a minute later
    release()
    expect(await pending).toBe('blocked')
    expect(ctx.oscs.length).toBe(0)
  })

  test('the context parks itself after the last tone', async () => {
    const s = await fresh()
    await s.sfxPlay({ name: 'ping', volume: 0.3 }, 'mention', false)
    expect(timers.length).toBe(1)
    expect(timers[0].ms).toBeGreaterThan(2000)
    timers[0].fn()
    expect(ctx.suspends).toBe(1)
  })
})

// ── filter-rule side: custom + volume survive compile, junk does not ──────────
describe('filter rules carry a sound and a volume', () => {
  const rule = (over = {}) => ({
    id: 'r1',
    enabled: true,
    scope: 'all',
    match: { type: 'keyword', value: 'hello', caseSensitive: false },
    action: 'highlight',
    color: '#ff0000',
    ...over,
  })
  const msg = { text: 'hello world', user: 'u', badges: '' }
  beforeEach(() => compileFilterRules([]))

  test('every engine preset, and custom, is a valid rule sound; nothing else is', async () => {
    const s = await fresh()
    for (const name of [...Object.keys(s.SFX_PRESETS), s.SFX_CUSTOM]) {
      compileFilterRules([rule({ sound: name })])
      expect(evaluateFilterRules(msg, null).sound).toBe(name)
    }
    compileFilterRules([rule({ sound: 'airhorn' })])
    expect(evaluateFilterRules(msg, null).sound).toBe(null)
  })

  test('the verdict names the rule (its picked file is keyed by id) and its volume', () => {
    compileFilterRules([rule({ sound: 'custom', soundVolume: 65 })])
    expect(evaluateFilterRules(msg, null)).toEqual({
      hide: false,
      highlight: '#ff0000',
      notify: false,
      sound: 'custom',
      soundId: 'r1',
      soundVolume: 65,
    })
  })

  test('no volume set = null = follow the shared volume, as every rule did before', () => {
    compileFilterRules([rule({ sound: 'ping' })])
    expect(evaluateFilterRules(msg, null).soundVolume).toBe(null)
  })

  test('volume is rounded and clamped to 0..100; junk is ignored', () => {
    const vol = (v) => {
      compileFilterRules([rule({ sound: 'ping', soundVolume: v })])
      return evaluateFilterRules(msg, null).soundVolume
    }
    expect(vol(64.6)).toBe(65)
    expect(vol(250)).toBe(100)
    expect(vol(-5)).toBe(0)
    expect(vol(0)).toBe(0)
    expect(vol('50')).toBe(null)
    expect(vol(Number.NaN)).toBe(null)
    expect(vol(null)).toBe(null)
  })

  test('hide rules and soundless rules carry no volume', () => {
    compileFilterRules([rule({ action: 'hide', sound: 'ping', soundVolume: 80, color: undefined })])
    expect(evaluateFilterRules(msg, null)).toEqual({
      hide: true,
      highlight: null,
      notify: false,
      sound: null,
      soundId: null,
      soundVolume: null,
    })
    compileFilterRules([rule({ soundVolume: 80 })])
    expect(evaluateFilterRules(msg, null).soundVolume).toBe(null)
  })

  test('first highlight still wins, and a colourless one still does not claim it', () => {
    compileFilterRules([
      rule({ id: 'a', color: undefined, sound: 'blip', soundVolume: 10 }),
      rule({ id: 'b', sound: 'chime', soundVolume: 90 }),
      rule({ id: 'c', sound: 'knock', soundVolume: 50 }),
    ])
    const v = evaluateFilterRules(msg, null)
    expect(v.soundId).toBe('b')
    expect(v.sound).toBe('chime')
    expect(v.soundVolume).toBe(90)
  })
})

// ── the registry offers exactly what the engine can play ─────────────────────
describe('settings registry', () => {
  test('mentionSound lists the engine presets plus "custom", defaults to ping, rejects junk', async () => {
    const { SETTINGS, validateSettingValue } = await import('../src/lib/settings-schema.js')
    const s = await fresh()
    const def = SETTINGS.find((d) => d.key === 'mentionSound')
    expect(def.options.map((o) => o.value)).toEqual([...Object.keys(s.SFX_PRESETS), s.SFX_CUSTOM])
    expect(def.default).toBe('ping')
    expect(validateSettingValue(def, 'chime')).toBe(true)
    expect(validateSettingValue(def, 'custom')).toBe(true)
    expect(validateSettingValue(def, 'airhorn')).toBe(false)
  })

  test('the file name is a short synced label; the bytes are not a setting at all', async () => {
    const { SETTINGS, validateSettingValue } = await import('../src/lib/settings-schema.js')
    const def = SETTINGS.find((d) => d.key === 'mentionSoundName')
    expect(def.scope).toBe('sync')
    expect(def.default).toBe('')
    expect(validateSettingValue(def, 'a'.repeat(60))).toBe(true)
    expect(validateSettingValue(def, 'a'.repeat(61))).toBe(false)
    expect(SETTINGS.some((d) => /sfx/i.test(d.key))).toBe(false)
  })

  test('the mention volume knob is the same 0-100 scale rules use', async () => {
    const { SETTINGS } = await import('../src/lib/settings-schema.js')
    const def = SETTINGS.find((d) => d.key === 'mentionSoundVolume')
    expect(def.default).toBe(0.3)
    expect(def.displayScale).toBe(100)
  })
})

// ── mentions.js: which sound, at what volume ──────────────────────────────────
describe('mentions.js wiring', () => {
  const SRC = read('src', 'multichat', 'mentions.js')
  const slice = (name) => {
    const at = SRC.indexOf(`function ${name}(`)
    expect(at, `${name} not found`).toBeGreaterThan(-1)
    return SRC.slice(at, SRC.indexOf('\n}\n', at) + 3)
  }
  function load({ mentionSound = 'ping', mentionSoundVolume = 0.3 } = {}) {
    const calls = []
    const g = {
      sfxPlay: (spec, bucket, preview) => {
        calls.push({ spec, bucket, preview })
        return Promise.resolve('played')
      },
      sfxRuleKey: (id) => `hs_sfx_rule_${id}`,
      SFX_MENTION_KEY: 'hs_sfx_mention',
      SFX_CUSTOM: 'custom',
      SFX_PRESETS: { ping: [], blip: [], knock: [], chime: [] },
      mentionSound,
      mentionSoundVolume,
    }
    const api = new Function(
      ...Object.keys(g),
      `${slice('playMentionPing')}\n${slice('previewMentionSound')}\n${slice('playFilterRuleSound')}\nreturn { playMentionPing, previewMentionSound, playFilterRuleSound }`,
    )(...Object.values(g))
    return { ...api, calls }
  }

  test('a rule with its own volume plays at that volume, on the rule bucket', () => {
    const { playFilterRuleSound, calls } = load()
    playFilterRuleSound({ sound: 'chime', soundId: 'r1', soundVolume: 50 })
    expect(calls).toEqual([
      { spec: { name: 'chime', key: 'hs_sfx_rule_r1', volume: 0.5 }, bucket: 'rule', preview: false },
    ])
  })

  test('a rule that never set a volume follows the shared mention volume (unchanged behaviour)', () => {
    const { playFilterRuleSound, calls } = load({ mentionSoundVolume: 0.8 })
    playFilterRuleSound({ sound: 'ping', soundId: 'r1', soundVolume: null })
    expect(calls[0].spec.volume).toBe(0.8)
  })

  test('volume 0 on a rule is honoured as silence, not mistaken for "unset"', () => {
    const { playFilterRuleSound, calls } = load({ mentionSoundVolume: 0.8 })
    playFilterRuleSound({ sound: 'ping', soundId: 'r1', soundVolume: 0 })
    expect(calls[0].spec.volume).toBe(0)
  })

  test('no sound on the verdict = no call', () => {
    const { playFilterRuleSound, calls } = load()
    playFilterRuleSound({ sound: null })
    playFilterRuleSound(null)
    expect(calls).toEqual([])
  })

  test('the mention plays its chosen sound at the given volume, on the mention bucket', () => {
    const { playMentionPing, calls } = load({ mentionSound: 'knock' })
    playMentionPing(0.3)
    expect(calls[0]).toEqual({
      spec: { name: 'knock', key: 'hs_sfx_mention', volume: 0.3, buf: undefined },
      bucket: 'mention',
      preview: false,
    })
  })

  test('junk in the setting never mutes a mention: it plays the ping', () => {
    const { playMentionPing, calls } = load({ mentionSound: 'airhorn' })
    playMentionPing(0.3)
    expect(calls[0].spec.name).toBe('ping')
  })

  test('"custom" is passed through (the engine falls back if the file is missing)', () => {
    const { playMentionPing, calls } = load({ mentionSound: 'custom' })
    playMentionPing(0.3)
    expect(calls[0].spec.name).toBe('custom')
  })

  test('previews are flagged so they skip the rate limit, and may name the sound', () => {
    const { playMentionPing, calls } = load({ mentionSound: 'ping' })
    playMentionPing(0.3, { name: 'chime', preview: true })
    expect(calls[0].spec.name).toBe('chime')
    expect(calls[0].preview).toBe(true)
  })

  test('the volume slider previews the level it just set, on the chosen sound, unthrottled', () => {
    const { previewMentionSound, calls } = load({ mentionSound: 'chime', mentionSoundVolume: 0.3 })
    previewMentionSound(0.9)
    expect(calls[0]).toEqual({
      spec: { name: 'chime', key: 'hs_sfx_mention', volume: 0.9, buf: undefined },
      bucket: 'mention',
      preview: true,
    })
  })

  test('the sound select previews the sound it just picked, at the current volume', () => {
    // the module copy of mentionSound is still the OLD pick when the applier runs
    const { previewMentionSound, calls } = load({ mentionSound: 'ping', mentionSoundVolume: 0.4 })
    previewMentionSound(undefined, 'knock')
    expect(calls[0].spec.name).toBe('knock')
    expect(calls[0].spec.volume).toBe(0.4)
    expect(calls[0].preview).toBe(true)
  })

  test('main.js wires the three appliers; the file goes only when its name is emptied', () => {
    const main = mainSource()
    expect(main).toContain('mentionPing: (v) => previewMentionSound(v)')
    expect(main).toContain('mentionSoundPick: (v) => previewMentionSound(undefined, v)')
    expect(main).toContain('mentionSoundFile: (v) => v || sfxRemove(SFX_MENTION_KEY)')
    const schema = read('src', 'lib', 'settings-schema.js')
    for (const id of ['mentionSoundPick', 'mentionSoundFile']) expect(schema).toContain(`apply: '${id}'`)
  })

  test('all three chat handlers hand the player the whole verdict', () => {
    for (const f of ['main.js', 'social.js']) {
      const src = f === 'main.js' ? mainSource() : read('src', 'multichat', f)
      expect(src).not.toMatch(/playFilterRuleSound\(_fr\w+\.sound\)/)
      expect(src).toMatch(/playFilterRuleSound\(_fr(Tw|Ki|Yt)\)/)
    }
  })
})

// ── settings export / import must not carry the files ─────────────────────────
describe('export and import leave the sound files on the device', () => {
  const SRC = read('src', 'multichat', 'settings-ui.js')
  const start = SRC.indexOf('var _SETTINGS_PRIVATE_KEY_RE')
  const end = SRC.indexOf('async function _importAllSettings')
  expect(start).toBeGreaterThan(-1)
  const BLOCK = SRC.slice(start, end)

  async function runExport(local) {
    let json = ''
    const g = {
      SETTINGS: [{ key: 'chatFilterRules', mirrorKey: 'chat_filter_rules' }],
      browser: {
        storage: {
          sync: { get: async () => ({ ui_settings: { mentionSound: 'custom', mentionSoundName: 'air horn.mp3' } }) },
          local: { get: async () => local },
        },
      },
      Blob: class {
        constructor(parts) {
          json = parts.join('')
        }
      },
      URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
      document: { createElement: () => ({ click() {}, remove() {} }), body: { appendChild() {} } },
      setTimeout: () => 0,
      showToast: () => {},
      t: (k) => k,
    }
    new Function(...Object.keys(g), `${BLOCK}\nreturn _exportAllSettings()`)(...Object.values(g))
    await flush()
    await flush()
    return json
  }

  const rules = JSON.stringify([
    {
      id: 'r1',
      enabled: true,
      match: { type: 'keyword', value: 'hi' },
      action: 'highlight',
      sound: 'custom',
      soundName: 'air horn.mp3',
      soundVolume: 40,
    },
  ])
  const bigB64 = 'A'.repeat(349_000)
  const local = {
    hs_sfx_mention: { n: 'air horn.mp3', t: 'audio/mpeg', b: bigB64 },
    hs_sfx_rule_r1: { n: 'air horn.mp3', t: 'audio/mpeg', b: bigB64 },
    chat_filter_rules: rules,
    hs_notifications: true,
    hs_mentions_v2: { msgs: [] },
  }

  test('export has the rule, its sound name and volume, the mention pick, and none of the bytes', async () => {
    const out = await runExport(local)
    const bundle = JSON.parse(out)
    expect(Object.keys(bundle.local).sort()).toEqual(['chat_filter_rules', 'hs_notifications'])
    expect(bundle.local.chat_filter_rules).toContain('air horn.mp3')
    expect(bundle.local.chat_filter_rules).toContain('"soundVolume":40')
    expect(bundle.sync.ui_settings).toEqual({ mentionSound: 'custom', mentionSoundName: 'air horn.mp3' })
    expect(out).not.toContain('AAAAAAAA')
  })

  test('with two 256 kb files on the device the export stays tiny', async () => {
    const out = await runExport(local)
    expect(out.length).toBeLessThan(2000)
  })

  test('the private-key filter names the sound files, for export and import alike', () => {
    const re = new Function(`${BLOCK.slice(0, BLOCK.indexOf('\n// local-mirror'))}\nreturn _SETTINGS_PRIVATE_KEY_RE`)()
    expect(re.test('hs_sfx_mention')).toBe(true)
    expect(re.test('hs_sfx_rule_abc123')).toBe(true)
    expect(re.test('hs_notifications')).toBe(false)
    // the import loop applies the very same filter, so a crafted file cannot plant one
    const imp = SRC.slice(end, SRC.indexOf('// _loadServerFilters removed'))
    expect(imp).toContain('_SETTINGS_PRIVATE_KEY_RE.test(k)')
  })
})

// ── sound-ui.js: the pick flow and the form ───────────────────────────────────
describe('sound-ui.js', () => {
  const SRC = read('src', 'multichat', 'sound-ui.js')

  function load({ prepare, volume = 0.3 } = {}) {
    const toasts = []
    const inputs = []
    const g = {
      document: {
        createElement: () => {
          const el = {
            style: {},
            handlers: {},
            files: [],
            removed: false,
            addEventListener(ev, fn) {
              el.handlers[ev] = fn
            },
            remove() {
              el.removed = true
            },
            click() {},
          }
          inputs.push(el)
          return el
        },
        body: { appendChild() {} },
      },
      sfxPrepareFile:
        prepare || (async () => ({ ok: true, sound: { n: 'a.mp3', t: 'audio/mpeg', b: 'AAAA', buf: {} } })),
      showToast: (m, k) => toasts.push([m, k]),
      t: (k) => k,
      escapeHtml: (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`),
      SFX_PRESETS: { ping: [], blip: [], knock: [], chime: [] },
      SFX_CUSTOM: 'custom',
      FR_BTN: 'btn',
      mentionSoundVolume: volume,
    }
    const api = new Function(
      ...Object.keys(g),
      `${SRC}\nreturn { sfxPickFile, sfxFormSoundOptions, sfxRuleFormHtml, sfxNoteHtml, setPending: (v) => { sfxPending = v } }`,
    )(...Object.values(g))
    return { ...api, toasts, inputs }
  }

  const pickWith = async (h, file) => {
    const p = h.sfxPickFile()
    const input = h.inputs[0]
    input.files = file ? [file] : []
    await input.handlers.change()
    return { result: await p, input }
  }

  test('the dialog only offers audio, and a good pick resolves the prepared sound', async () => {
    const h = load()
    const p = h.sfxPickFile()
    expect(h.inputs[0].accept).toBe('audio/*')
    h.inputs[0].files = [{ name: 'a.mp3' }]
    await h.inputs[0].handlers.change()
    expect((await p).n).toBe('a.mp3')
    expect(h.inputs[0].removed).toBe(true)
    expect(h.toasts).toEqual([])
  })

  test.each([
    ['type', 'mc_sfx_err_type'],
    ['size', 'mc_sfx_err_size'],
    ['decode', 'mc_sfx_err_decode'],
    ['long', 'mc_sfx_err_long'],
  ])('a %s problem tells the person in plain words (%s) and resolves null', async (reason, key) => {
    const h = load({ prepare: async () => ({ ok: false, reason }) })
    const { result } = await pickWith(h, { name: 'x' })
    expect(result).toBe(null)
    expect(h.toasts).toEqual([[key, 'error']])
  })

  test('cancelling the dialog resolves null and cleans up', async () => {
    const h = load()
    const p = h.sfxPickFile()
    h.inputs[0].handlers.cancel()
    expect(await p).toBe(null)
    expect(h.inputs[0].removed).toBe(true)
    expect(h.toasts).toEqual([])
  })

  test('the form offers silent, every preset, and "my file" only once a file is picked', () => {
    const h = load()
    expect(h.sfxFormSoundOptions()).toContain('<option value="none">')
    for (const n of ['ping', 'blip', 'knock', 'chime']) expect(h.sfxFormSoundOptions()).toContain(`value="${n}"`)
    expect(h.sfxFormSoundOptions()).toMatch(/value="custom" disabled>/)
    h.setPending({ n: 'a.mp3' })
    expect(h.sfxFormSoundOptions()).toMatch(/value="custom" selected>/)
  })

  test('a new rule\u2019s volume starts at the shared mention volume', () => {
    expect(load({ volume: 0.3 }).sfxRuleFormHtml()).toContain('value="30"')
    expect(load({ volume: 0.85 }).sfxRuleFormHtml()).toContain('value="85"')
    expect(load({ volume: 0 }).sfxRuleFormHtml()).toContain('value="0"')
  })

  test('the form says the file stays on this device, and a file name cannot inject markup', () => {
    const h = load()
    expect(h.sfxNoteHtml()).toContain('mc_sfx_note')
    h.setPending({ n: '"><img src=x onerror=1>' })
    const html = h.sfxRuleFormHtml()
    expect(html).not.toContain('<img')
  })

  test('the form has a play control and a volume 0-100 slider', () => {
    const html = load().sfxRuleFormHtml()
    expect(html).toContain('data-fr-action="preview"')
    expect(html).toContain('data-fr-action="pick"')
    expect(html).toMatch(/data-fr-field="vol" min="0" max="100"/)
  })

  test('build.js bundles both new files, engine before the wrappers that call it', () => {
    const build = read('build.js')
    expect(build.indexOf("'sounds.js'")).toBeGreaterThan(-1)
    expect(build.indexOf("'sounds.js'")).toBeLessThan(build.indexOf("'mentions.js'"))
    expect(build.indexOf("'sound-ui.js'")).toBeGreaterThan(build.indexOf("'settings-ui.js'"))
  })
})
