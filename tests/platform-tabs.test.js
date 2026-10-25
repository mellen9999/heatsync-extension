// The picker's kick and youtube tabs: each only on its own host, each pane emitted by the picker,
// and youtube's native-chat view is undone by a single exit that restores everything it set.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = (f) => readFileSync(join(import.meta.dir, '..', 'src', 'multichat', f), 'utf8')
const emotes = src('emotes.js')
const tabs = src('platform-tabs.js')
const css = src('styles/17-platform-position.css')

describe('platform picker tabs', () => {
  test('kick and youtube tabs show only on their own host', () => {
    expect(emotes).toContain("{ id: 'kick', label: 'kick', when: () => hostPlatform === 'kick' }")
    expect(emotes).toContain("{ id: 'youtube', label: 'youtube', when: () => hostPlatform === 'yt' }")
  })

  test('the picker renders each pane on all three show paths', () => {
    expect(emotes.match(/renderKickTab\(\)/g)).toHaveLength(3)
    expect(emotes.match(/renderYoutubeTab\(\)/g)).toHaveLength(3)
  })

  test('kick links are built only from a validated channel name', () => {
    expect(tabs).toContain('/^[a-z0-9_-]{1,40}$/.test(ch)')
  })

  test("youtube's join link is built only from the page's own owner link, in a known shape", () => {
    expect(tabs).toContain('/^\\/(@[\\w.-]+|channel\\/UC[\\w-]+)$/.test(href)')
  })

  test('the native-chat view undoes everything it set', () => {
    const back = tabs.slice(tabs.indexOf('function ytPeekBack'))
    for (const undone of ["'hs-yt-peek'", 'hs-yt-peek-bar', '--hs-peek-top', '_ytPeekKey'])
      expect(back).toContain(undone)
  })

  test('the hide rules and checkYtLive both stand down while it is up', () => {
    expect(css).toContain('body:not(.hs-yt-owns-chat):not(.hs-yt-peek):has(#hs-mc-container) ytd-live-chat-frame#chat')
    expect(css).toContain('body.hs-yt-peek ytd-live-chat-frame#chat {')
    expect(css).toContain('body.hs-yt-peek ytd-watch-flexy #secondary {') // its view-transition-name pins a stacking context
    expect(css).toContain('#secondary-inner > #chat-container {') // the sidebar sweep hides its parent
  })

  test('native chat stays up across reloads until the viewer goes back by hand', () => {
    const main = src('main.js')
    expect(tabs).toContain("saveUiSetting('ytNative', true)")
    expect(tabs).toContain("saveUiSetting('ytNative', false)")
    expect(tabs).not.toContain("addEventListener('resize', ytPeekBack") // a resize re-fits, it never exits
    expect(main).toContain('_savedYtNative = stored.ui_settings?.ytNative === true')
    expect(main).toContain('_savedYtNative && frameEl && !ytPeeking()')
  })

  test('twitch and kick get a native chat row that is the per-site switch, with the way back on the hs button', () => {
    const twitch = src('twitch-api.js')
    const btn = readFileSync(join(import.meta.dir, '..', 'chrome', 'heatsync-button.js'), 'utf8')
    expect(tabs).toContain('window.HS.setSiteOverlay(gate, false)')
    expect(tabs).toContain('prepend(nativeChatRow())')
    expect(twitch).toContain('nativeChatRow()')
    expect(btn).toContain('window.HS.setSiteOverlay(siteGate, true)')
  })
})

describe('kick native chat hide', () => {
  test("is a body class the css keys on, not a class on kick's own react-managed node", () => {
    const main = src('main.js')
    const feed = src('styles/16-social-feed.css')
    expect(main).toContain("document.body.classList.toggle('hs-kick-native-hidden', hidden)")
    expect(feed).not.toMatch(/#channel-chatroom:not\(\.hs-native-hidden\)/)
    expect(feed).not.toMatch(/\.hs-native-hidden#channel-chatroom/)
    expect(feed).toContain('body.hs-kick-native-hidden #channel-chatroom {')
  })
})

describe('twitch and kick with heatsync chat off', () => {
  test('no picker button, just a back bar over the native chat column', () => {
    const btn = readFileSync(join(import.meta.dir, '..', 'chrome', 'heatsync-button.js'), 'utf8')
    const init = btn.slice(btn.indexOf('async function init()'))
    expect(init.indexOf('mountNativeBackBar(gate)')).toBeGreaterThan(-1)
    expect(init.indexOf('mountNativeBackBar(gate)')).toBeLessThan(init.indexOf('cleanupOrphanedElements()'))
    expect(btn).toContain('back to heatsync chat')
    expect(btn).toContain('window.HS.setSiteOverlay(gate, true)')
  })
})
