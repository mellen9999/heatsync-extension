/**
 * A youtube member emote drew at 1.2em (~18px) beside 32px 7tv emotes on the same line, and from
 * youtube's smallest picture (24px), so it read as tiny and soft. It now takes the row's emote size
 * like every other emote, from a 64px picture.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const MSGS = readFileSync(new URL('../src/multichat/main-messages.js', import.meta.url), 'utf8')
const body = MSGS.match(/function ytEmoteAtSize\(url\) \{\n([\s\S]*?)\n\}/)?.[1]
const ytEmoteAtSize = new Function('url', body)

describe('youtube emotes draw at the emote size', () => {
  test('a ggpht picture is asked for at 64px', () => {
    expect(ytEmoteAtSize('https://yt3.ggpht.com/abcDEF_123=w24-h24-c-k-nd')).toBe(
      'https://yt3.ggpht.com/abcDEF_123=w64-h64-c-k-nd',
    )
    expect(ytEmoteAtSize('https://yt3.ggpht.com/abc=s24-c-k-nd')).toBe('https://yt3.ggpht.com/abc=s64-c-k-nd')
    expect(ytEmoteAtSize('https://yt4.googleusercontent.com/abc=w48-h48')).toBe(
      'https://yt4.googleusercontent.com/abc=w64-h64',
    )
  })

  test('any other host is left alone', () => {
    for (const u of [
      'https://cdn.7tv.app/emote/x/1x.webp',
      'https://www.youtube.com/s/gaming/emoji/abc.svg',
      'https://evil.example/yt3.ggpht.com/a=w24-h24',
    ]) {
      expect(ytEmoteAtSize(u)).toBe(u)
    }
  })

  test('the picture takes the row emote size, not an inline 1.2em', () => {
    expect(MSGS).not.toMatch(/height:1\.2em/)
    expect(MSGS).toMatch(/url = ytEmoteAtSize\(/)
  })
})
