import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Disabling a platform must disable ALL of its transports.
 *
 * Kick has three: the server relay, the background Pusher tap, and a
 * page-level tap that exists as a fallback. The first two are gated on
 * chat-kick; the page tap was gated only on its own kick-native-tap toggle and
 * on the host page. So switching the chat-kick subsystem off skipped
 * kickChat.connect() and left the page tap running.
 *
 * That is worse than an ordinary leak. The page tap is documented as inert
 * WHILE the relay is delivering — so turning kick off is exactly the condition
 * that wakes it. The user disables kick chat and kick messages keep arriving.
 *
 * Twitch's native tap has always been gated on its platform (`gTwitch &&
 * hostPlatform === 'twitch'`); kick simply drifted. This pins the symmetry.
 */

const MAIN = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'main.js'), 'utf8')

const callGuard = (needle) => {
  const at = MAIN.indexOf(needle)
  expect(at, `${needle} call site not found`).toBeGreaterThan(-1)
  const line = MAIN.lastIndexOf('if (', at)
  return MAIN.slice(line, at)
}

describe('platform transports respect their platform gate', () => {
  test('the kick page tap is gated on kick', () => {
    expect(callGuard('initKickNativeTap === ')).toContain('gKick')
  })

  test('the twitch native tap is gated on twitch', () => {
    expect(callGuard('startNativeTap(')).toContain('gTwitch')
  })

  test('each platform connects only under its own gate', () => {
    expect(MAIN).toMatch(/if \(gTwitch\) irc\.connect\(\)/)
    expect(MAIN).toMatch(/if \(gKick\) kickChat\.connect\(\)/)
  })
})
