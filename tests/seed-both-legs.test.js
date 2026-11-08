import { describe, expect, test } from 'bun:test'
import { mcHealEntries, mcMergeLegs, mcSeedAdoptLegs } from '../src/multichat/seed-legs.js'
import { mainSource } from './main-src.js'

const reply =
  (body, ok = true) =>
  async () =>
    ok ? body : null

describe('first-run seed adopts the same-name other leg', () => {
  test('probe says exists: twitch seed gains kick', async () => {
    const e = { id: 'x', twitch: 'x', kick: '', youtube: '' }
    expect(await mcSeedAdoptLegs(e, reply({ exists: true }))).toEqual(['kick'])
    expect(e.kick).toBe('x')
  })
  test('probe says live (not exists): kick seed gains twitch', async () => {
    const e = { id: 'x', twitch: '', kick: 'x', youtube: '' }
    await mcSeedAdoptLegs(e, reply({ isLive: true }))
    expect(e.twitch).toBe('x')
  })
  test('negative probe, http error and throw all stay single-leg', async () => {
    for (const f of [
      reply({ exists: false, isLive: false }),
      reply({}, false),
      async () => {
        throw new Error('off')
      },
    ]) {
      const e = { id: 'x', twitch: 'x', kick: '', youtube: '' }
      expect(await mcSeedAdoptLegs(e, f)).toEqual([])
      expect(e.kick).toBe('')
    }
  })
  test('probes the missing platform by name through the background relay path', async () => {
    let seen
    await mcSeedAdoptLegs({ twitch: 'a_b', kick: '' }, async (path) => {
      seen = path
      return null
    })
    expect(seen).toBe('/api/live/info?platform=kick&channel=a_b')
  })
  test('a two-leg entry is never probed', async () => {
    let n = 0
    await mcSeedAdoptLegs({ twitch: 'x', kick: 'x' }, async () => {
      n++
      return { ok: false }
    })
    expect(n).toBe(0)
  })
})

describe('storage merge never loses a leg', () => {
  test('existing two-leg + kick-only incoming stays two-leg', () => {
    const mine = { id: 'x', twitch: '', kick: 'x', youtube: '' }
    mcMergeLegs(mine, { id: 'x', twitch: 'x', kick: 'x', youtube: '' }, null)
    expect(mine.twitch).toBe('x')
  })
  test('a leg another tab added (differs from last persisted) is adopted', () => {
    const mine = { id: 'x', twitch: 'x', kick: '' }
    mcMergeLegs(mine, { twitch: 'x', kick: 'x' }, { twitch: 'x', kick: '' })
    expect(mine.kick).toBe('x')
  })
  test('a leg we removed on purpose stays removed', () => {
    const mine = { id: 'x', twitch: 'x', kick: '' }
    mcMergeLegs(mine, { twitch: 'x', kick: 'x' }, { twitch: 'x', kick: 'x' })
    expect(mine.kick).toBe('')
  })
})

const src = mainSource()

describe('wiring', () => {
  test('seed calls the adopt probe and save merges legs', () => {
    expect(src).toContain('_adoptSeedLegs(config.channels[0])')
    expect(src).toContain('mcMergeLegs(m, c, prevById?.get(k))')
  })
})

describe('heal-on-load for existing single-leg entries', () => {
  test('probes exactly the one-leg entries, once per session', async () => {
    const entries = [
      { id: 'a', twitch: 'a', kick: '' },
      { id: 'b', twitch: '', kick: 'b' },
      { id: 'c', twitch: 'c', kick: 'c' },
      { id: 'd', twitch: '', kick: '' },
    ]
    const seen = []
    const attempted = new Set()
    expect(await mcHealEntries(entries, async (e) => seen.push(e.id), attempted)).toBe(2)
    expect(seen.sort()).toEqual(['a', 'b'])
    expect(await mcHealEntries(entries, async (e) => seen.push(e.id), attempted)).toBe(0)
    expect(seen.length).toBe(2)
  })
  test('never more than 3 probes in flight; one failure does not stop the rest', async () => {
    const entries = Array.from({ length: 8 }, (_, i) => ({ id: `c${i}`, twitch: `c${i}`, kick: '' }))
    let live = 0
    let peak = 0
    let done = 0
    await mcHealEntries(
      entries,
      async (e) => {
        live++
        peak = Math.max(peak, live)
        await new Promise((r) => setTimeout(r, 2))
        live--
        done++
        if (e.id === 'c1') throw new Error('x')
      },
      new Set(),
    )
    expect(peak).toBeLessThanOrEqual(3)
    expect(done).toBe(8)
  })
  test('wired into loadConfig', () => {
    expect(src).toContain('mcHealEntries(config.channels, _adoptSeedLegs, _healAttempted)')
  })
})
