/**
 * hsProxyImg (feed-embed.js) — rewrites external image URLs to our origin image
 * proxy so they render under the extension's strict img-src CSP, while passing
 * through hosts the CSP already allows. Sliced from source so the test tracks the
 * real function + its host allowlist (which must stay in sync with the manifest).
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'feed-embed.js'), 'utf8')

function sliceBetween(startMarker, endMarker) {
  const s = SRC.indexOf(startMarker)
  if (s === -1) throw new Error(`start marker not found: ${startMarker}`)
  const e = SRC.indexOf(endMarker, s)
  if (e === -1) throw new Error(`end marker not found: ${endMarker}`)
  return SRC.slice(s, e)
}

// Pull the const set + function together, verbatim.
const fnSrc = sliceBetween('const HS_IMG_DIRECT_HOSTS', '\nfunction ytEmbed')
const { hsProxyImg } = new Function(`${fnSrc}\nreturn { hsProxyImg }`)()

const PROXY = 'https://heatsync.org/api/img?url='

describe('hsProxyImg', () => {
  test('external host → proxied, full URL (incl. query) encoded', () => {
    const u = 'https://safebooru.org//images/4619/x.jpg?4816592'
    expect(hsProxyImg(u)).toBe(PROXY + encodeURIComponent(u))
  })
  test('bare-number query tail is preserved through the proxy', () => {
    expect(hsProxyImg('https://safebooru.org/x.jpg?4816592')).toContain(encodeURIComponent('?4816592'))
  })
  test('imgur is proxied: hotlinking it showed images nobody had scanned', () => {
    expect(hsProxyImg('https://i.imgur.com/abc.jpg')).toStartWith(PROXY)
  })
  test('yt thumbnail host is proxied (not in ext img-src)', () => {
    expect(hsProxyImg('https://i.ytimg.com/vi/abc/mqdefault.jpg')).toStartWith(PROXY)
  })
  test.each([
    'https://cdn.heatsync.org/uploads/x.webp',
    'https://heatsync.org/uploads/x.webp',
    'https://static-cdn.jtvnw.net/emote/1/2.0',
    'https://cdn.7tv.app/emote/1/2x.webp',
    'https://files.kick.com/emote/1',
    'https://d3aqoihi2n8ty8.cloudfront.net/x.png',
  ])('allowlisted host passes through untouched: %s', (u) => {
    expect(hsProxyImg(u)).toBe(u)
  })
  test('data: and blob: pass through (never proxied)', () => {
    expect(hsProxyImg('data:image/gif;base64,AAAA')).toBe('data:image/gif;base64,AAAA')
    expect(hsProxyImg('blob:https://heatsync.org/abc')).toBe('blob:https://heatsync.org/abc')
  })
  test('empty / non-string → empty string, no throw', () => {
    expect(hsProxyImg('')).toBe('')
    expect(hsProxyImg(null)).toBe('')
    expect(hsProxyImg(undefined)).toBe('')
  })
  test('unparseable input passes through (no throw)', () => {
    expect(hsProxyImg('not a url')).toBe('not a url')
  })
  test('subdomain of an allowlisted host is NOT auto-trusted (exact match)', () => {
    // evil.heatsync.org.attacker.com must be proxied, not passed through.
    expect(hsProxyImg('https://heatsync.org.attacker.com/x.jpg')).toStartWith(PROXY)
  })
})
