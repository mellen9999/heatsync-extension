/**
 * A replayed youtube line renders and alerts nothing.
 *
 * On subscribe the background replays up to 200 buffered youtube lines to the
 * surface (bgYtReplayToTab, replay:true) and they run through the same handler
 * as live chat. Before the gate, every old line that mentioned you, or hit a
 * highlight rule with a sound, rang, notified, announced and landed in the
 * mentions tab again.
 *
 * handleYoutubeChatMsg is lifted out of social.js (bundle scope, not
 * importable) and run for real. Every name it closes over resolves through a
 * recording scope: functions record their calls, the few values that steer the
 * branch under test are given.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'social.js'), 'utf8')
const from = SRC.indexOf('function handleYoutubeChatMsg(msg) {')
const FN = SRC.slice(from, SRC.indexOf('\n}\n', from) + 2)

const BUILTINS = new Set([
  'undefined',
  'String',
  'Number',
  'Boolean',
  'Object',
  'Array',
  'Date',
  'Math',
  'JSON',
  'RegExp',
  'Set',
  'Map',
  'Promise',
  'Error',
  'console',
])

function run(msg, { mention = true, verdict = { hide: false, sound: 'ping', notify: false } } = {}) {
  const calls = []
  const rec =
    (name, ret) =>
    (...a) => {
      calls.push(name)
      return typeof ret === 'function' ? ret(...a) : ret
    }
  const mentionsBuffer = []
  const given = {
    config: { channels: [{ id: 'c1', twitch: 'streamer', youtube: '@streamer' }] },
    hostPlatform: 'twitch',
    location: { href: 'https://www.twitch.tv/streamer' },
    currentTab: 'c1',
    MAX_BUFFER: 500,
    mentionsBuffer: {
      push: (m) => {
        calls.push('mentionsBuffer.push')
        mentionsBuffer.push(m)
      },
      get length() {
        return mentionsBuffer.length
      },
    },
    isYtDuplicate: () => false,
    isSentEcho: () => false,
    peekSentHost: () => null,
    isSelf: () => false,
    evaluateFilterRules: rec('evaluateFilterRules', verdict),
    isMention: rec('isMention', mention),
    ruleAlertsMention: rec('ruleAlertsMention', verdict.notify),
    appendMessage: rec('appendMessage', true),
  }
  const scope = new Proxy(given, {
    // given names win; any other free name but a language builtin is a recorder —
    // never whatever another test file left on bun's one shared globalThis
    has: (t, k) => typeof k === 'string' && (k in t || !BUILTINS.has(k)),
    get: (t, k) => (k in t ? t[k] : rec(String(k))),
  })
  // sloppy-mode `with` routes every free name in the lifted handler through the scope
  given.__msg = msg
  new Function('scope', `with (scope) { ${FN}\n handleYoutubeChatMsg(__msg) }`)(scope)
  return calls
}

const line = (extra = {}) => ({ channelId: 'c1', user: 'alice', text: '@viewer hi', time: 1, id: 'yt1', ...extra })
const ALERTS = [
  'playFilterRuleSound',
  'mentionsBuffer.push',
  'persistMentions',
  'notifyMention',
  'noteSeenEvent',
  'bumpStreamStats',
]

describe('youtube replay', () => {
  test('a live line that mentions you and hits a sound rule alerts', () => {
    const calls = run(line())
    for (const step of ALERTS) expect(calls).toContain(step)
    expect(calls).toContain('enqueueYtForPacing')
  })

  test('the same line replayed renders and alerts nothing', () => {
    const calls = run(line({ replay: true }))
    for (const step of ALERTS) expect(calls).not.toContain(step)
    expect(calls).toContain('ingestReplayYtMsg')
  })

  test('a hide rule still hides a replayed line', () => {
    const calls = run(line({ replay: true }), { verdict: { hide: true, sound: null, notify: false } })
    expect(calls).not.toContain('ingestReplayYtMsg')
  })
})
