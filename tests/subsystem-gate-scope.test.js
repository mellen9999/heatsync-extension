import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A subsystem kill-switch must disable its OWN subsystem and nothing else.
 *
 * listenForSocialEvents() registers one chrome.runtime.onMessage listener that
 * carries both the site's feed pushes and EVERY youtube message type —
 * youtube_chat_message, youtube_status, and both deletion paths. It was called
 * behind `gateAtBoot('feed')` alone, so a user who switched the feed subsystem
 * off silently lost YouTube chat. The panel says feed disables the feed; it
 * should not take a platform with it.
 *
 * The listener is shared by design (one registration, many types), so the fix
 * is the gate, not a split. This pins that the gate covers every subsystem the
 * listener actually serves.
 */

const MAIN = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'main.js'), 'utf8')
const SOCIAL = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'social.js'), 'utf8')

/** Message types handled inside listenForSocialEvents. */
function typesInListener() {
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
  const body = SOCIAL.slice(at, end)
  return [...body.matchAll(/msg\.type === '([^']+)'/g)].map((m) => m[1])
}

/** The gate expression guarding the call. */
function gateExpr() {
  // greedy to the LAST paren before the call — `[^)]*` stops inside gateAtBoot('feed')
  const m = MAIN.match(/if \((.*)\) listenForSocialEvents\(\)/)
  expect(m, 'listenForSocialEvents call site not found').toBeTruthy()
  return m[1]
}

describe('subsystem gate scope', () => {
  test('the listener really does carry youtube traffic', () => {
    const types = typesInListener()
    expect(types.some((t) => t.startsWith('youtube'))).toBe(true)
    expect(types.length).toBeGreaterThan(5)
  })

  test('turning off the feed does not take youtube chat with it', () => {
    expect(gateExpr()).toContain("gateAtBoot('chat-youtube')")
  })

  test('the feed still gates itself', () => {
    expect(gateExpr()).toContain("gateAtBoot('feed')")
  })

  test('both youtube deletion paths are reachable through that listener', () => {
    // server-sourced (by message id + banned author) and DOM-tap sourced (by
    // user). Either can be the only live source, so losing the listener loses
    // both at once.
    const types = typesInListener()
    expect(types).toContain('youtube_delete')
    expect(types).toContain('youtube_msg_deleted')
  })
})
