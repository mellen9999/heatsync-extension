import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The twitch, kick and youtube chat handlers must run the same pipeline.
 *
 * Each platform carries its own copy of "a message arrived, now what" — echo
 * dedup, ownership attribution, automod, filter rules, mentions, stats, seen
 * state. Three copies drift, silently, and the drift is invisible until someone
 * notices a feature working on one platform and not another:
 *
 *   - restoreOwnReplyBar existed only on twitch, so replying on kick or youtube
 *     rendered your own message with no reply bar.
 *   - youtube folded evaluateFilterRules() into an if-condition and kept only
 *     .hide, so a highlight rule's SOUND fired on twitch and kick and was mute
 *     on youtube.
 *
 * Both were found by diffing the three handlers, so the diff is the test.
 *
 * This pins the pipeline STEPS, not the code — each handler still does its own
 * platform-specific work around them (kick queues its own cosmetics lookup,
 * youtube resolves a videoId to a channel bucket). What it refuses to allow is
 * one platform quietly losing a step the other two run.
 */

const SRC = (f) => readFileSync(join(import.meta.dir, '..', 'src', 'multichat', f), 'utf8')

/** Slice from an anchor to its matching closing brace. */
function spanFrom(src, anchor) {
  const start = src.indexOf(anchor)
  if (start === -1) throw new Error(`handler anchor not found: ${anchor}`)
  let i = src.indexOf('{', start)
  let depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  throw new Error(`unterminated handler: ${anchor}`)
}

function handlers() {
  const main = SRC('main.js')
  const social = SRC('social.js')
  return {
    twitch: spanFrom(main, "irc.on('message', (msg) => {"),
    kick: spanFrom(main, "kickChat.on('message', (msg) => {"),
    youtube: spanFrom(social, "if (msg.type === 'youtube_chat_message') {"),
  }
}

/**
 * Steps every platform's handler owes a message. Deliberately NOT exhaustive —
 * this is the list whose absence is a bug on any platform, not everything a
 * handler happens to call.
 *
 * confirmPending is absent on purpose: youtube echoes do not loop back through
 * a chat handler, so 'yt' only enters the pending tracker's awaiting set for a
 * pure-YT send, which the send path confirms itself (see registerPendingSend in
 * input.js). That is a documented asymmetry, not drift — which is exactly why
 * it has to be written down somewhere that fails if someone "fixes" it.
 */
const PIPELINE = [
  'isSentEcho', // own-send dedup
  'peekSentHost', // ownership → badge/platform attribution
  'restoreOwnReplyBar', // reply bar on our own echo
  'shouldAutomod', // automod gate
  'evaluateFilterRules', // user filter rules
  'playFilterRuleSound', // highlight rule audio cue
  'isMention', // mention detection
  'bumpStreamStats', // per-channel stats
  'mentionsBuffer.push', // mention buffering
  'persistMentions',
  'notifyMention',
  'noteSeenEvent', // unread bookkeeping
]

describe('chat handler parity', () => {
  test('all three handlers are found and are real spans', () => {
    for (const [name, src] of Object.entries(handlers())) {
      expect(src.length, `${name} handler looks too small to be the real one`).toBeGreaterThan(1000)
    }
  })

  for (const step of PIPELINE) {
    test(`every platform runs ${step}`, () => {
      const missing = Object.entries(handlers())
        .filter(([, src]) => !src.includes(step))
        .map(([name]) => name)
      expect(missing).toEqual([])
    })
  }

  test('the filter-rule verdict is kept, not collapsed to .hide', () => {
    // Folding the call into an if-condition is how youtube lost the sound: the
    // verdict object carries more than .hide, and an inline call discards it.
    for (const [name, src] of Object.entries(handlers())) {
      const inlineOnly = /evaluateFilterRules\([^)]*\)\.hide/.test(src)
      expect(inlineOnly, `${name} discards the filter-rule verdict`).toBe(false)
    }
  })
})
