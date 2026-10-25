// YouTube's own chat stays visible when the user switched hs chat off for youtube — and ONLY then. A
// premiere or scheduled stream goes through the overlay like a live one (its chat frame relays the
// same way). One decision feeds the panel, the frame hide and the css, so they cannot disagree. These
// paths run inside the host page and can't be imported, so they are guarded at the source level.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = (f) => readFileSync(join(import.meta.dir, '..', 'src', f), 'utf8')
const main = src('multichat/main.js')
const css = src('multichat/styles/17-platform-position.css')

describe('youtube owns the chat', () => {
  test('one decision: the user switched youtube chat off — a premiere is not a reason', () => {
    expect(main).toContain("const ytOwnsChat = () => gateAtBoot('chat-youtube') === false")
    expect(main.match(/const ytOwnsChat = [^\n]*/)[0]).not.toContain('slate')
  })

  test('the panel, the frame hide and the css all follow it', () => {
    expect(main).toContain('if (ytOwnsChat()) return true') // mount-time frame hide
    expect(main).toContain("document.body.classList.toggle('hs-yt-owns-chat', ownsChat)")
    expect(main).toContain('(!ownsChat &&') // panel visibility
    expect(css).toContain('body:not(.hs-yt-owns-chat):not(.hs-yt-peek):has(#hs-mc-container) ytd-live-chat-frame#chat')
  })

  test('a premiere keeps its chat frame loaded: it is the only feed and the send path', () => {
    expect(main).toContain("'#movie_player .ytp-offline-slate'")
    const at = main.indexOf("!frameEl.hasAttribute('collapsed')")
    const cond = main.slice(at, main.indexOf(') {', at))
    expect(cond).toContain('!ytFrameIsTheFeed()')
    expect(cond).toContain('!ytPeeking()')
  })

  test("youtube's dark tokens are on while the panel is up, and its own choice returns after", () => {
    expect(main).toContain("html.setAttribute('dark', '')")
    expect(main).toContain('_hsForcedYtDark = true')
    expect(main).toMatch(/else if \(!showYtChat && _hsForcedYtDark\) \{\n\s*html\.removeAttribute\('dark'\)/)
  })
})
