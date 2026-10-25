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

describe('cold list first paint', () => {
  test('paints the newest rows first, fills older rows in chunks, and finishes before a tab is cached', () => {
    const main = src('main.js')
    expect(main).toContain('const FIRST_PAINT_ROWS = 100')
    expect(main).toContain('growFirstPaint(id)')
    expect(main).toContain('toRender = toRender.slice(-_cap)')
    // the half-filled list must be whole before snapshotTabState caches it (a restore only appends)
    expect(main.indexOf('finishFirstPaint()\n    snapshotTabState(currentTab)')).toBeGreaterThan(-1)
    // older rows land above the viewport: a scrolled-up viewer is carried by the height delta
    expect(main).toContain('top0 + (el.scrollHeight - h0)')
  })
})

describe('style recalc cost', () => {
  test("the banner strip is a class derived from the container's children, not a :has() on the container", () => {
    const pos = src('styles/17-platform-position.css')
    expect(pos).toContain('#hs-mc-container.hs-has-banner {')
    expect(pos).not.toMatch(/#hs-mc-container:has\(> \.hs-mc-(auth|api)-banner/)
    expect(src('main.js')).toContain("'hs-has-banner'")
  })
})

describe('emote format', () => {
  test('7tv avif is rewritten to webp on every browser, not only firefox', () => {
    const e = src('emotes.js')
    expect(e).toContain("if (out.includes('cdn.7tv.app')) out = out.replace(/\\.avif(\\?|$)/i, '.webp$1')")
    expect(e).not.toContain('HS_IS_FF')
  })
})

describe('kick idle animation', () => {
  test("kick's forever-pulsing skeletons are stilled so hover is not a full repaint", () => {
    expect(src('styles/17-platform-position.css')).toMatch(
      /body\.hs-platform-kick \.animate-pulse \{\s*animation: none !important;/,
    )
  })
})

describe('hover hold', () => {
  const main = src('main.js')
  test('the feed stops sliding while the pointer is on an emote, name or badge, and lets go after a beat', () => {
    expect(main).toContain("el.closest('.hs-mc-emote-wrapper, .hs-mc-user, .hs-mc-badge-img')")
    expect(main).toContain('_hoverRelease = cleanup.setTimeout(releaseHold, 120)')
    expect(main).toContain("msgsEl.addEventListener('mouseleave', releaseHold")
  })
  test('a real scroll-up, the resume button and a scroll back to the bottom all end the hold cleanly', () => {
    expect(main).toMatch(/if \(_hoverHeld\) \{\s*_hoverHeld = false\s*isScrolledUp = false\s*\}/)
    expect(main).toMatch(/'click',\s*\(\) => \{\s*_hoverHeld = false/)
    expect(main).toMatch(/if \(checkAtBottom\(\)\) \{\s*_hoverHeld = false/)
  })
})

describe('native title tooltip', () => {
  test("a chat emote has no title: the browser's own tooltip came up after a second and duplicated the 4x preview", () => {
    const e = src('emotes.js')
    expect(e).not.toMatch(/<img [^>]*title="[^"]*"[^>]*class="hs-mc-emote /)
    expect(e).toContain('class="hs-mc-emote hs-emote-${state}"')
  })
})
