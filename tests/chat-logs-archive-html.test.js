/**
 * The logs panel used to draw only twitch/kick emotes (emote_refs), so a 7TV
 * emote like `1984` was plain text — "some emotes can't be hovered". It now
 * reads the server's message_html as DATA: an <img> only survives as one of
 * heatsync's own emote paths (or an allowed CDN host), never as free markup.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'chat-logs.js'), 'utf8')
const a = SRC.indexOf('const CL_HS_EMOTE_PATH')
const b = SRC.indexOf('/** True when the line was drawn from message_html')
const clEmoteUrlAllowed = (u) => /^https:\/\/(static-cdn\.jtvnw\.net|cdn\.7tv\.app)\//.test(u)
const clArchiveEmoteSrc = new Function('clEmoteUrlAllowed', `${SRC.slice(a, b)}\nreturn clArchiveEmoteSrc`)(
  clEmoteUrlAllowed,
)

describe('clArchiveEmoteSrc', () => {
  test('heatsync emote paths become absolute heatsync urls', () => {
    expect(clArchiveEmoteSrc('/e/7tv/01F6WDQ2EG00007614EPW3P4T6')).toBe(
      'https://heatsync.org/e/7tv/01F6WDQ2EG00007614EPW3P4T6',
    )
    expect(clArchiveEmoteSrc('/e/bttv/abc_DEF-1')).toBe('https://heatsync.org/e/bttv/abc_DEF-1')
  })

  test('allowed cdn hosts pass through', () => {
    expect(clArchiveEmoteSrc('https://cdn.7tv.app/emote/x/1x.webp')).toBe('https://cdn.7tv.app/emote/x/1x.webp')
  })

  test('anything else is refused', () => {
    expect(clArchiveEmoteSrc('/e/7tv/../../etc')).toBeNull()
    expect(clArchiveEmoteSrc('/api/logout')).toBeNull()
    expect(clArchiveEmoteSrc('//evil.example/x.png')).toBeNull()
    expect(clArchiveEmoteSrc('https://evil.example/x.png')).toBeNull()
    expect(clArchiveEmoteSrc('javascript:alert(1)')).toBeNull()
    expect(clArchiveEmoteSrc(null)).toBeNull()
  })

  test('the body prefers message_html and falls back to the old shapes', () => {
    expect(SRC).toContain('if (appendArchiveHtmlBody(host, r.message_html)) return')
  })
})

describe('live logs room + badge art', () => {
  const B = SRC.indexOf('const CL_BADGE_PATH')
  const badgePath = new Function(`${SRC.slice(B, SRC.indexOf('\n', B))}\nreturn CL_BADGE_PATH`)()
  test('only heatsync badge mirror paths pass', () => {
    expect(badgePath.test('/b/twitch/3267646d-33f0-4b17-b3df-f923a41db1d0')).toBe(true)
    expect(badgePath.test('/badges/kick/moderator.svg')).toBe(true)
    expect(badgePath.test('//evil.example/x.png')).toBe(false)
    expect(badgePath.test('/b/twitch/../../etc')).toBe(false)
    expect(badgePath.test('https://evil.example/b/twitch/x')).toBe(false)
  })
  test('the view joins its ulog room and leaves on close', () => {
    expect(SRC).toMatch(/`ulog:\$\{st\.platform\}:\$\{st\.username\}`/)
    expect(SRC).toMatch(/function dropChatLogsState\(\) \{\s*activeChatLogs = null\s*clLiveRoomSync\(\)/)
  })
})
