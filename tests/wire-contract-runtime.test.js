import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * chrome.runtime.sendMessage does NOT reach content scripts.
 *
 * It delivers to the background and to extension pages. A content script that
 * sends one to another content script's onMessage listener is talking into the
 * void, and nothing anywhere reports it — no error, no rejected promise.
 *
 * Verified in a real chromium rather than taken from the docs: same message
 * type, same listener, same tab, sent both ways in one run.
 *   chrome.tabs.sendMessage    -> handler ran, emote inserted
 *   chrome.runtime.sendMessage -> nothing
 *
 * That is how clicking an emote in the picker on youtube did nothing at all:
 * heatsync-button.js posted `youtube_insert_emote` to youtube-content.js, the
 * only content-script-to-content-script message in the codebase. Both are
 * ISOLATED scripts in the same frame, so they share one window — the fix is a
 * direct call, the same shape content.js already uses to hand
 * heatsyncGetRecentChatters to the kick autocomplete hook.
 *
 * This test keeps that from coming back: every type sent with
 * runtime.sendMessage must have a handler in background.js.
 */

const ROOT = join(import.meta.dir, '..')
const BG = readFileSync(join(ROOT, 'chrome', 'background.js'), 'utf8')

function sources() {
  const out = []
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!['node_modules', '_locales', 'styles'].includes(e.name)) walk(join(dir, e.name))
        continue
      }
      if (!e.name.endsWith('.js')) continue
      if (/^multichat-(twitch|kick|youtube)\.js$/.test(e.name)) continue // build output
      if (e.name === 'background.js') continue
      out.push([e.name, readFileSync(join(dir, e.name), 'utf8')])
    }
  }
  walk(join(ROOT, 'src'))
  walk(join(ROOT, 'chrome'))
  return out
}

/** Message types background.js dispatches on. */
function handledByBackground() {
  const s = new Set()
  for (const m of BG.matchAll(/(?:message|msg|m)\.type === '([a-z0-9_:-]+)'/gi)) s.add(m[1])
  for (const m of BG.matchAll(/(?:message|msg|m)\.type !== '([a-z0-9_:-]+)'/gi)) s.add(m[1])
  for (const m of BG.matchAll(/case '([a-z0-9_:-]+)':/gi)) s.add(m[1])
  return s
}

// `foo` is a documentation example inside browser-api.js's own comments, not a
// real send. Named here so the exemption is visible rather than pattern-hidden.
const NOT_A_REAL_SEND = new Set(['foo'])

describe('runtime.sendMessage wire contract', () => {
  const handled = handledByBackground()

  test('the handler extraction actually found the router', () => {
    // Guards the test itself: an extraction that silently matches nothing would
    // make every assertion below vacuously pass.
    expect(handled.size).toBeGreaterThan(80)
    expect(handled.has('remove_from_inventory')).toBe(true)
  })

  test('nothing sends a runtime message the background cannot handle', () => {
    const orphans = []
    for (const [file, src] of sources()) {
      for (const m of src.matchAll(/sendMessage\(\s*\{\s*type:\s*'([a-z0-9_:-]+)'/gi)) {
        const t = m[1]
        if (handled.has(t) || NOT_A_REAL_SEND.has(t)) continue
        orphans.push(`${t} (${file})`)
      }
    }
    expect(
      [...new Set(orphans)],
      'sent with runtime.sendMessage but no background handler — if the intended reader is a ' +
        'content script it will never arrive, silently',
    ).toEqual([])
  })

  test('youtube emote insert is a direct call, not a message', () => {
    const btn = readFileSync(join(ROOT, 'chrome', 'heatsync-button.js'), 'utf8')
    const yt = readFileSync(join(ROOT, 'chrome', 'youtube-content.js'), 'utf8')
    expect(yt).toContain('window.__hsYtInsertEmote = handleInsertEmote')
    expect(btn).toContain('window.__hsYtInsertEmote(emoteName)')
    expect(btn).not.toContain("type: 'youtube_insert_emote'")
  })

  test('the caller guards on the function existing, and still inserts if it does not', () => {
    const btn = readFileSync(join(ROOT, 'chrome', 'heatsync-button.js'), 'utf8')
    const at = btn.indexOf("platform === 'youtube' && typeof window.__hsYtInsertEmote === 'function'")
    expect(at, 'the existence guard is gone — a missing function would throw').toBeGreaterThan(-1)
    // The else arm is the execCommand path, so an unloaded youtube-content.js
    // degrades to "inserts, maybe imperfectly" rather than back to "does nothing".
    expect(btn.slice(at, at + 1400)).toContain("document.execCommand('insertText'")
  })

  test('both scripts really are in the same isolated world', () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'src', 'manifests', 'chrome.json'), 'utf8'))
    // heatsync-button.js is registered more than once (twitch/kick get their
    // own group), so match on the page the picker shares with youtube-content,
    // not on "the first group that mentions the file".
    const LIVE_CHAT = 'https://www.youtube.com/live_chat*'
    const onLiveChat = (file) =>
      manifest.content_scripts.filter((g) => g.js?.includes(file) && (g.matches || []).includes(LIVE_CHAT))
    const btn = onLiveChat('heatsync-button.js')
    const yt = onLiveChat('youtube-content.js')
    expect(btn.length, 'heatsync-button.js no longer runs on /live_chat').toBeGreaterThan(0)
    expect(yt.length, 'youtube-content.js no longer runs on /live_chat').toBeGreaterThan(0)
    // A shared window is the whole mechanism — same page, same world, same frame.
    for (const g of [...btn, ...yt]) expect(g.world ?? 'ISOLATED').toBe('ISOLATED')
    expect(btn[0].all_frames).toBe(yt[0].all_frames)
  })
})
