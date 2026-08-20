import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The `heatsync-emotes-updated` notification must not depend on which content
 * script ran first.
 *
 * The bug: `chrome/autocomplete-hook.js` attached its listener to the
 * `#heatsync-emote-bridge` element at load. That element is created by
 * `chrome/content.js` — which the manifest registers in a LATER content_scripts
 * group (autocomplete-hook is MAIN world, content.js is ISOLATED, both
 * document_end, and chrome runs same-run_at groups in manifest order). So the
 * lookup returned null, a silent `if (bridge)` skipped the whole registration,
 * and the listener never existed.
 *
 * It failed quietly because the other three bridge reads are query-time and
 * version-cached, so emote DATA still reached autocomplete. What was lost was
 * only the reactive re-inject: a newly added emote did not appear in Twitch's
 * native tab-complete until Twitch mutated props.emotes or the page reloaded.
 *
 * Both sides now use `document`, which is shared across worlds and exists from
 * document_start. This pins that, and pins the manifest ordering fact that
 * makes it necessary — if the groups are ever reordered, the reasoning in the
 * comments would silently stop being true.
 */

const ROOT = join(import.meta.dir, '..')
const HOOK = readFileSync(join(ROOT, 'chrome', 'autocomplete-hook.js'), 'utf8')
const CONTENT = readFileSync(join(ROOT, 'chrome', 'content.js'), 'utf8')
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'src', 'manifests', 'chrome.json'), 'utf8'))

const EVENT = 'heatsync-emotes-updated'

/** Index of the first content_scripts group containing `file`. */
function groupIndexOf(file) {
  return MANIFEST.content_scripts.findIndex((g) => g.js?.includes(file))
}

describe('emote bridge update event', () => {
  test('is dispatched on document, not on the bridge element', () => {
    expect(CONTENT).toContain(`document.dispatchEvent(new Event('${EVENT}'))`)
    expect(CONTENT).not.toContain(`bridge.dispatchEvent(new Event('${EVENT}'))`)
  })

  test('is listened for on document, not on the bridge element', () => {
    const at = HOOK.indexOf(`'${EVENT}'`)
    expect(at).toBeGreaterThan(-1)
    // The 220 chars before the event name carry the target expression.
    const before = HOOK.slice(Math.max(0, at - 220), at)
    expect(before).toContain('document.addEventListener(')
    expect(before).not.toMatch(/bridge\.addEventListener\($/)
  })

  test('the listener is not gated on the bridge element existing', () => {
    // `const bridge = getElementById(...)` immediately followed by `if (bridge)`
    // around the registration is the exact shape that silently did nothing.
    const at = HOOK.indexOf(`'${EVENT}'`)
    const before = HOOK.slice(Math.max(0, at - 400), at)
    expect(before).not.toContain("getElementById('heatsync-emote-bridge')")
  })

  test('autocomplete-hook still runs BEFORE content.js — the reason this matters', () => {
    const hookAt = groupIndexOf('autocomplete-hook.js')
    const contentAt = groupIndexOf('content.js')
    expect(hookAt).toBeGreaterThan(-1)
    expect(contentAt).toBeGreaterThan(-1)
    // If this ever flips, the element-targeted listener would start working and
    // the comments explaining why it cannot would become wrong. Either way the
    // document target stays correct — this is here so a reorder is noticed.
    expect(hookAt).toBeLessThan(contentAt)
  })

  test('the two scripts really are in different worlds', () => {
    const hookGroup = MANIFEST.content_scripts[groupIndexOf('autocomplete-hook.js')]
    const contentGroup = MANIFEST.content_scripts[groupIndexOf('content.js')]
    expect(hookGroup.world).toBe('MAIN')
    expect(contentGroup.world ?? 'ISOLATED').toBe('ISOLATED')
    // Cross-world DOM events are the whole mechanism; a shared node is required.
    expect(hookGroup.run_at).toBe(contentGroup.run_at)
  })
})
