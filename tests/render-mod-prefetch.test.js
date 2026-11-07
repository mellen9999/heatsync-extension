import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// a built-in tab (feed, live, add…) is not a twitch login: rendering it must not ask twitch
// "is the viewer a mod of feed" (an extra gql call, and its answer cached forever)
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
const main = read('../src/multichat/main.js')
const registry = read('../src/multichat/tab-registry.js')

const a = main.indexOf('// Pre-fetch isMod for the active channel')
const line = main.slice(a, main.indexOf('\n', main.indexOf('prefetchModFor(id)', a)))

function prefetched(id) {
  const asked = []
  new Function(
    'id',
    'asked',
    `${registry.slice(0, registry.indexOf('function mcDefaultHiddenTabs'))}
     const prefetchModFor = (c) => asked.push(c)
     ${line}`,
  )(id, asked)
  return asked
}

describe('render prefetches mod state only for channel tabs', () => {
  test('a channel tab is prefetched', () => expect(prefetched('forsen')).toEqual(['forsen']))
  for (const id of ['feed', 'live', 'add', 'settings', 'mentions', 'whispers'])
    test(`${id} is not a twitch login`, () => expect(prefetched(id)).toEqual([]))
})
