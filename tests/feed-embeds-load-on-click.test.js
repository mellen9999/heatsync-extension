/**
 * Feed embeds are click-to-load: a rendered feed row names the host on a
 * button and holds the iframe's address back, so no third party sees the
 * viewer until they ask. Sliced from source, like embed-media-held.test.js.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { t } from './en-t.js'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'feed-embed.js'), 'utf8')
const slice = (a, b) => {
  const s = SRC.indexOf(a)
  const e = SRC.indexOf(b, s)
  if (s < 0 || e < 0) throw new Error(`marker drift: ${a} / ${b}`)
  return SRC.slice(s, e)
}
const escapeHtml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const EMBED_SANDBOX = 'allow-scripts'
const location = { hostname: 'www.twitch.tv' }
const { hsFacadeIframes, ytEmbed, vimeoEmbed, soundcloudEmbed } = new Function(
  'escapeHtml',
  't',
  'EMBED_SANDBOX',
  'location',
  'safeUrl',
  'hsProxyImg',
  `${slice('function hsFacadeIframes', '\nfunction attr(')}\n${slice('function ytEmbed', '\n// Giphy')}\nreturn { hsFacadeIframes, ytEmbed, vimeoEmbed, soundcloudEmbed }`,
)(
  escapeHtml,
  t,
  EMBED_SANDBOX,
  location,
  (u) => u,
  (u) => u,
)

describe('feed embeds load on click', () => {
  for (const [name, html, host] of [
    ['youtube', ytEmbed('dQw4w9WgXcQ'), 'youtube.com'],
    ['vimeo', vimeoEmbed('76979871'), 'player.vimeo.com'],
    ['soundcloud (src not first)', soundcloudEmbed('https://soundcloud.com/a/b'), 'w.soundcloud.com'],
  ]) {
    test(`${name}: no live src, a button naming ${host}`, () => {
      const out = hsFacadeIframes(html)
      expect(out).not.toMatch(/<iframe[^>]*\ssrc="/)
      expect(out).toMatch(/<iframe[^>]*\sdata-hs-src="https:\/\//)
      expect(out).toContain(`load from ${host}`)
      expect(out.indexOf('data-hs-embed-load')).toBeLessThan(out.indexOf('<iframe'))
    })
  }

  test('the feed render paths wrap their embeds and the click hook sets src', () => {
    expect(SRC.match(/hs-feed-media">\$\{hsFacadeIframes\(embedHtml\)\}/g)).toHaveLength(2)
    const hook = slice('function attachFeedFallbacks', "root.querySelectorAll('img[data-fallback-anon]')")
    expect(hook).toContain('frame.src = frame.dataset.hsSrc')
  })
})
