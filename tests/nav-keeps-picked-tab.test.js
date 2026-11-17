/**
 * A tab the reader picked keeps its own chat when the page moves to another channel. The soft
 * navs on twitch and kick repainted the live tab into the pane whatever tab was open: a picked
 * saved channel blanked to "connecting" on every channel the page moved to (e2e s2, 11-16).
 * Runs the real softTwitchNav / softKickNav against a happy-dom page, every other name stubbed.
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'

const carve = (file, name) => {
  const src = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', file), 'utf8')
  const s = src.indexOf(`function ${name}(`)
  if (s < 0) throw new Error(`no ${name} in ${file}`)
  return src.slice(s, src.indexOf('\n}\n', s) + 3)
}

// any name the nav touches and the test does not care about: callable, readable, falsy result
const any = new Proxy(() => {}, { get: (_t, k) => (k === Symbol.toPrimitive ? () => '' : any), apply: () => undefined })

function nav(file, name, tab) {
  const win = new Window({ url: 'https://example.test/' })
  const doc = win.document
  doc.body.innerHTML =
    // the panel sits apart from both mount points, the way a nav finds it
    '<div id="channel-chatroom"></div><div class="chat-shell"></div><div id="hs-mc-container"><div id="hs-mc-messages"></div></div>'
  const renders = []
  const own = {
    document: doc,
    MutationObserver: win.MutationObserver,
    currentTab: tab,
    renderMessages: (id) => renders.push(id),
    hsQuery: () => doc.querySelector('.chat-shell'),
    kickChatroom: () => doc.getElementById('channel-chatroom'),
    getCurrentChannel: () => 'next_channel',
    config: { channels: [] },
    cleanup: { setTimeout: () => 0, trackObserver: () => {}, untrackObserver: () => {} },
  }
  const scope = new Proxy(own, {
    has: () => true,
    // (with() asks for Symbol.unscopables: none, or every name would skip the scope)
    get: (o, k) => (k === Symbol.unscopables ? undefined : k in o ? o[k] : k in globalThis ? globalThis[k] : any),
    set: (o, k, v) => {
      o[k] = v
      return true
    },
  })
  new Function('scope', `with (scope) { ${carve(file, name)}; ${name}('prev_channel') }`)(scope)
  return renders
}

for (const [file, name] of [
  ['twitch-host.js', 'softTwitchNav'],
  ['kick-host.js', 'softKickNav'],
]) {
  test(`${name}: a picked saved tab is not repainted with the page's channel`, () => {
    expect(nav(file, name, 'caseoh_')).not.toContain('live')
  })
  test(`${name}: the live tab still follows the page`, () => {
    expect(nav(file, name, 'live')).toContain('live')
  })
}
