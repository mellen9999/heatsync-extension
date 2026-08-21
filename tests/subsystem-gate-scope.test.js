import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A subsystem kill-switch must disable its OWN subsystem, all of it, and
 * nothing else. Both halves of that have been broken here in turn.
 *
 * listenForSocialEvents() registers ONE chrome.runtime.onMessage listener that
 * carries the site's feed pushes, every youtube message type, DMs, seen-state
 * and send-origin tagging — four subsystems' worth. Any gate on the
 * REGISTRATION is wrong for three of them:
 *
 *   `gateAtBoot('feed')`                → feed off silently killed YOUTUBE CHAT
 *   `feed || chat-youtube`              → chat-youtube off no longer turned
 *                                         youtube chat OFF (measured live: a
 *                                         broadcast still rendered a row)
 *
 * The listener is shared by design, so the gate belongs in the dispatcher,
 * per message family. This pins that shape: registration unconditional, and
 * each family checking the switch that names it.
 */

const MAIN = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'main.js'), 'utf8')
const SOCIAL = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'social.js'), 'utf8')

/** Body of listenForSocialEvents, brace-matched from its declaration. */
function listenerBody() {
  const at = SOCIAL.indexOf('function listenForSocialEvents()')
  expect(at).toBeGreaterThan(-1)
  let depth = 0
  let end = SOCIAL.length
  for (let i = SOCIAL.indexOf('{', at); i < SOCIAL.length; i++) {
    if (SOCIAL[i] === '{') depth++
    else if (SOCIAL[i] === '}') {
      depth--
      if (depth === 0) {
        end = i + 1
        break
      }
    }
  }
  return SOCIAL.slice(at, end)
}

/** Message types handled inside listenForSocialEvents. */
function typesInListener() {
  return [...listenerBody().matchAll(/msg\.type === '([^']+)'/g)].map((m) => m[1])
}

describe('subsystem gate scope', () => {
  test('the listener really does carry youtube traffic', () => {
    const types = typesInListener()
    expect(types.some((t) => t.startsWith('youtube'))).toBe(true)
    expect(types.length).toBeGreaterThan(5)
  })

  test('registration is unconditional — no gate can be right for all four', () => {
    expect(MAIN).toContain('\n    listenForSocialEvents()')
    expect(MAIN).not.toMatch(/if \([^\n]*\) listenForSocialEvents\(\)/)
  })

  test('youtube traffic is gated on chat-youtube, in the dispatcher', () => {
    const body = listenerBody()
    expect(body).toMatch(/startsWith\('youtube_'\)[\s\S]{0,80}gateAtBoot\('chat-youtube'\)/)
    // …and that check must come BEFORE the first youtube handler, or it is
    // decoration rather than a gate.
    expect(body).toContain("msg.type === 'youtube_")
    expect(body.indexOf("gateAtBoot('chat-youtube')")).toBeLessThan(body.indexOf("msg.type === 'youtube_"))
  })

  test('every youtube handler is actually covered by that prefix check', () => {
    // The gate is written as a `youtube_` prefix test so a NEW youtube handler
    // is covered the day it is added. That only holds while every youtube type
    // really carries the prefix.
    for (const t of typesInListener().filter((x) => x.toLowerCase().includes('youtube'))) {
      expect(t.startsWith('youtube_')).toBe(true)
    }
  })

  test('feed traffic is gated on feed, and the set is explicit', () => {
    const body = listenerBody()
    expect(body).toContain("_FEED_EVENTS.has(msg?.type) && gateAtBoot('feed') === false")
    expect(body).toContain("msg.type === 'new-message'")
    expect(body.indexOf('_FEED_EVENTS.has')).toBeLessThan(body.indexOf("msg.type === 'new-message'"))
    for (const t of ['new-message', 'message-edited', 'message-deleted', 'message-updated']) {
      expect(SOCIAL).toMatch(new RegExp(`_FEED_EVENTS = new Set\\(\\[[^\\]]*'${t}'`))
    }
  })

  test('the cross-cutting handlers stay ungated, deliberately', () => {
    // These are not owned by any subsystem — [H] send-origin tagging, seen
    // state and DMs. The old feed-gated registration killed all three as a side
    // effect of a switch labelled "feed". If one ever gains a real subsystem,
    // this test is the place that says so.
    const body = listenerBody()
    for (const t of ['chat_origin_broadcast', 'seen_update', 'dm_new']) {
      expect(body).toContain(`msg.type === '${t}'`)
      expect(body).not.toMatch(new RegExp(`'${t}'[\\s\\S]{0,120}gateAtBoot\\(`))
    }
  })

  test('both youtube deletion paths are reachable through that listener', () => {
    const types = typesInListener()
    expect(types).toContain('youtube_delete')
    expect(types).toContain('youtube_msg_deleted')
  })
})
