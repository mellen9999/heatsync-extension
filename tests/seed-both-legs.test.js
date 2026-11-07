import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { mcMergeLegs, mcSeedAdoptLegs } from '../src/multichat/seed-legs.js'

const reply =
  (body, ok = true) =>
  async () => ({ ok, json: async () => body })

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
  test('probes the missing platform by name, no credentials', async () => {
    let seen
    await mcSeedAdoptLegs({ twitch: 'a_b', kick: '' }, async (u, o) => {
      seen = [u, o]
      return { ok: false }
    })
    expect(seen[0]).toBe('https://heatsync.org/api/live/info?platform=kick&channel=a_b')
    expect(seen[1].credentials).toBe('omit')
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

describe('wiring', () => {
  const src = readFileSync(new URL('../src/multichat/main.js', import.meta.url), 'utf8')
  test('seed calls the adopt probe and save merges legs', () => {
    expect(src).toContain('_adoptSeedLegs(config.channels[0])')
    expect(src).toContain('mcMergeLegs(m, c, prevById?.get(k))')
  })
})
