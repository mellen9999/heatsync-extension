import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The feed, discover and pinned views draw into the same pane as chat. Each had callers that
 * come back late with no look at which tab is up by then: the answer to a saved post edit, a
 * thread fetch, the redraw 1.5s after "sync follows". Switch tabs inside that wait and the view
 * painted itself over the chat (rows then appended under it). Each renderer now draws only when
 * its own tab is on screen. The real functions run; on another tab they must touch nothing.
 */
const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'social.js'), 'utf8')
const fn = (name) => {
  const s = SRC.indexOf(`function ${name}(`)
  if (s < 0) throw new Error(`carve: ${name}`)
  return SRC.slice(s, SRC.indexOf('\n}\n', s) + 3)
}

// every name the function reads comes from here; anything but the tab is a touch
function run(name, tab) {
  const touched = []
  const scope = new Proxy(
    { currentTab: tab },
    {
      has: (_, k) => typeof k === 'string',
      get: (t, k) => {
        if (k === Symbol.unscopables) return undefined
        if (k in t) return t[k]
        touched.push(String(k))
        throw new Error(`touched ${String(k)}`)
      },
    },
  )
  const f = new Function('scope', `with (scope) { ${fn(name)}; return ${name} }`)(scope)
  let threw = null
  try {
    f()
  } catch (e) {
    threw = e.message
  }
  return { touched, threw }
}

for (const [name, own] of [
  ['renderFeed', 'feed'],
  ['renderDiscoverTab', 'discover'],
  ['renderPinnedTab', 'pinned'],
]) {
  test(`${name} on another tab reads nothing, draws nothing, fetches nothing`, () => {
    for (const tab of ['live', 'kripp', 'settings', 'add', own === 'feed' ? 'discover' : 'feed']) {
      expect(run(name, tab)).toEqual({ touched: [], threw: null })
    }
  })
  test(`${name} on its own tab goes on to draw`, () => {
    // it reaches for the pane (the first thing past the guard), which this bare scope does not have
    const r = run(name, own)
    expect(r.touched.length).toBeGreaterThan(0)
  })
}
