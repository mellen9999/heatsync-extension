import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Does a setting cover what its label says?
 *
 * `dim timed-out messages` offers two treatments — "50% opacity instead of
 * hiding" — and in the overlay only ONE of them existed.
 *
 * With the setting off, a moderated message was neither dimmed nor hidden: it
 * stayed on screen, fully readable, exactly as if nothing had happened. Six
 * separate call sites patched the dim class into the live DOM, and youtube's
 * (added later) never checked the setting at all, so youtube kept dimming
 * while twitch and kick did nothing.
 *
 * The durable answer is the render filter — the one platform-blind place every
 * buffer's messages pass through. markClearedRow is the live-DOM half, shared
 * so the six sites cannot drift again.
 */

const ROOT = join(import.meta.dir, '..')
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8')
const MAIN = read('src', 'multichat', 'main.js')
const SOCIAL = read('src', 'multichat', 'social.js')
const TOOLBAR = read('src', 'multichat', 'mod-toolbar.js')

describe('dim-timeouts coverage', () => {
  test('hiding is implemented, at the platform-blind render filter', () => {
    expect(MAIN).toContain('if (m.cleared && !f.dim) return true')
    expect(MAIN).toContain('dim: dimTimeouts,')
  })

  test('the render filter reads the flag from the once-per-pass snapshot', () => {
    // isMsgFiltered runs per message over up to 1500 rows; a getSetting() call
    // in there would be a per-message registry lookup in the render hot path.
    const at = MAIN.indexOf('function isMsgFiltered(m, f) {')
    expect(at).toBeGreaterThan(-1)
    const fn = MAIN.slice(at, at + 1400)
    expect(fn).toContain('!f.dim')
    expect(fn).not.toContain("getSetting('hs_dim_timeouts')")
    expect(fn).not.toContain('dimTimeouts')
  })

  test('every live-DOM site goes through the shared treatment', () => {
    for (const [name, src] of [
      ['main.js', MAIN],
      ['social.js', SOCIAL],
      ['mod-toolbar.js', TOOLBAR],
    ]) {
      const direct = [...src.matchAll(/classList\.add\('hs-mc-msg-cleared'\)/g)].length
      const viaHelper = [...src.matchAll(/markClearedRow\(/g)].length
      if (name === 'main.js') {
        // main.js legitimately keeps three: buildMessageDiv (already inside an
        // `m.cleared && dimTimeouts` branch), the cached-fragment re-apply
        // (inside `if (dimTimeouts)`), and the helper's own body.
        expect(direct).toBeLessThanOrEqual(3)
        expect(viaHelper).toBeGreaterThan(1)
      } else {
        expect(direct, `${name} patches the dim class directly again`).toBe(0)
        expect(viaHelper).toBeGreaterThan(0)
      }
    }
  })

  test('the shared treatment implements BOTH halves', () => {
    const at = MAIN.indexOf('function markClearedRow(row, title) {')
    expect(at).toBeGreaterThan(-1)
    const fn = MAIN.slice(at, at + 500)
    expect(fn).toContain('if (!dimTimeouts) {')
    expect(fn).toContain('row.remove()')
    expect(fn).toContain("row.classList.add('hs-mc-msg-cleared')")
    // The hide branch must RETURN. Ordering alone is not enough: drop the
    // return and the row is removed AND handed the dim class, which the
    // position check above happily allows. (Caught by mutating the return away.)
    expect(fn).toMatch(/row\.remove\(\)\s*\n\s*return\b/)
    expect(fn.indexOf('row.remove()')).toBeLessThan(fn.indexOf("classList.add('hs-mc-msg-cleared')"))
  })

  test('youtube uses it too — it is the path that ignored the setting', () => {
    const at = SOCIAL.indexOf('function applyYtDeletion(')
    expect(at).toBeGreaterThan(-1)
    expect(SOCIAL.slice(at, at + 2000)).toContain('markClearedRow(')
  })

  test('an unban still lifts the dim', () => {
    // The hide branch removes the row; the buffer keeps m.cleared=false on
    // unban (irc.js), so the next render brings it back. The dim branch still
    // needs its explicit class removal for rows already on screen.
    expect(MAIN).toContain("row.classList.remove('hs-mc-msg-cleared')")
  })
})

describe('platform badges: the off state is deliberate, and the copy says so', () => {
  const EN = JSON.parse(read('src', '_locales', 'en', 'messages.json'))

  test('off hides only the badge for the platform you are on', () => {
    // Not a bug: a [K] on a twitch page is information, a [T] is noise. The
    // pin exists so nobody "fixes" this into hiding all three.
    expect(MAIN).toContain('platformBadgesEnabled || plat !== hostPlatform')
  })

  test('the description does not promise more than that', () => {
    // It used to read "[T] [K] [Y] labels on messages" full stop, which reads
    // as "off = no labels".
    const desc = EN.mc_settings_platform_badges_desc.message
    expect(desc.toLowerCase()).toContain('off')
  })
})
