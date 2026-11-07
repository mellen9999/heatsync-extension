/**
 * Native-chat remote-completion auto-add — trackRemoteCompletion /
 * flushRemoteCompletionsOnSend (chrome/autocomplete-hook.js).
 *
 * Regression anchor: tab-completing a remote 7TV catalog emote in NATIVE
 * twitch chat never added it to the viewer's set — the overlay input did
 * (trackCompletionForAutoAdd → auto-add-on-send), so the emote rendered live
 * but went out as bare text for everyone and vanished for the sender after
 * refresh. The hook now registers remote inserts and, on a passively observed
 * Enter, relays the ones still present in the input to the ISOLATED world,
 * which applies the overlay's own auto-add guards.
 *
 * Carved out of the non-module MAIN-world script and evaluated standalone
 * (same rationale as tab-complete-order.test.js's compareAcMatches carve).
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const HOOK_SRC = readFileSync(join(import.meta.dir, '..', 'chrome', 'autocomplete-hook.js'), 'utf8')
const start = HOOK_SRC.indexOf('const _remoteCompletions')
const end = HOOK_SRC.indexOf('// Track preloaded emote names')
if (start === -1 || end === -1 || end <= start) throw new Error('remote-completion carve markers not found')

let posted = []
const fakeWindow = { postMessage: (data, origin) => posted.push({ data, origin }) }
const fakeLocation = { origin: 'https://www.twitch.tv' }
const carved = new Function(
  'window',
  'location',
  `${HOOK_SRC.slice(start, end)}; return { trackRemoteCompletion, flushRemoteCompletionsOnSend, _remoteCompletions }`,
)(fakeWindow, fakeLocation)
const { trackRemoteCompletion, flushRemoteCompletionsOnSend, _remoteCompletions } = carved

// Minimal input element: text mode words via textContent, wysiwyg emotes via img alts
const fakeInput = (text, alts = []) => ({
  textContent: text,
  querySelectorAll: () => alts.map((alt) => ({ alt })),
})

beforeEach(() => {
  posted = []
  _remoteCompletions.clear()
})

describe('trackRemoteCompletion — only remote 7TV catalog hits register', () => {
  test('remote 7tv match registers', () => {
    trackRemoteCompletion({ remote: true, name: 'peepoSad', url: 'https://cdn.7tv.app/emote/x/1x.webp', source: '7tv' })
    expect(_remoteCompletions.has('peepoSad')).toBe(true)
  })

  test('local (bridge/native) matches never register', () => {
    trackRemoteCompletion({ name: 'Kappa', url: 'https://cdn.7tv.app/emote/x/1x.webp', source: '7tv' })
    trackRemoteCompletion({ remote: true, name: 'NoUrl', source: '7tv' })
    expect(_remoteCompletions.size).toBe(0)
  })
})

describe('flushRemoteCompletionsOnSend — presence-gated relay', () => {
  const reg = (name) =>
    trackRemoteCompletion({ remote: true, name, url: `https://cdn.7tv.app/emote/${name}/1x.webp`, source: '7tv' })

  test('emote present as wysiwyg img alt is relayed once, then cleared', () => {
    reg('peepoSad')
    flushRemoteCompletionsOnSend(fakeInput('hello ', ['peepoSad']))
    expect(posted.length).toBe(1)
    expect(posted[0].data.type).toBe('heatsync-remote-completion-used')
    expect(posted[0].data.emotes).toEqual([
      { name: 'peepoSad', url: 'https://cdn.7tv.app/emote/peepoSad/1x.webp', source: '7tv', zeroWidth: false },
    ])
    expect(posted[0].origin).toBe('https://www.twitch.tv')
    // consumed — a second send never re-relays
    flushRemoteCompletionsOnSend(fakeInput('again ', ['peepoSad']))
    expect(posted.length).toBe(1)
  })

  test('7TV overlay flag survives register → relay (zeroWidth not dropped)', () => {
    trackRemoteCompletion({
      remote: true,
      name: 'wavE',
      url: 'https://cdn.7tv.app/emote/wavE/1x.webp',
      source: '7tv',
      zeroWidth: true,
    })
    flushRemoteCompletionsOnSend(fakeInput('hi ', ['wavE']))
    expect(posted[0].data.emotes).toEqual([
      { name: 'wavE', url: 'https://cdn.7tv.app/emote/wavE/1x.webp', source: '7tv', zeroWidth: true },
    ])
  })

  test('emote present as plain text word is relayed (text mode)', () => {
    reg('peepoSad')
    flushRemoteCompletionsOnSend(fakeInput('gg peepoSad wp'))
    expect(posted.length).toBe(1)
  })

  test('cycled-past / deleted emotes are NOT relayed and stay registered', () => {
    reg('peepoSad')
    reg('peepoHappy')
    flushRemoteCompletionsOnSend(fakeInput('gg ', ['peepoHappy']))
    expect(posted[0].data.emotes.map((e) => e.name)).toEqual(['peepoHappy'])
    expect(_remoteCompletions.has('peepoSad')).toBe(true)
  })

  test('nothing registered or nothing present → no postMessage', () => {
    flushRemoteCompletionsOnSend(fakeInput('hello'))
    reg('peepoSad')
    flushRemoteCompletionsOnSend(fakeInput('hello'))
    expect(posted.length).toBe(0)
  })
})

describe('native relay → overlay add (rule 7)', () => {
  test('a relayed Tab pick is a deliberate variant, so it can swap a different emote you own', () => {
    const input = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'input.js'), 'utf8')
    const i = input.indexOf("event.data?.type !== 'heatsync-remote-completion-used'")
    const block = input.slice(i, input.indexOf('autoAddInputEmotes(names.join', i))
    expect(block).toMatch(/recentRemoteCompletions\.set\(e\.name, \{[^}]*variant: true/)
  })
})
