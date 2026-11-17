import { expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { hsCardModel } from '../src/lib/card-model.js'
import { makeCardL10n } from './card-l10n-env.js'

/**
 * The shared card renderer names heatsync's own pictures from the root: "/anon.webp" for a
 * chatter with no picture, and as the fallback when a picture fails. On twitch, kick and youtube
 * "/" is the host, so a card for anyone without a picture showed a broken image (kick + youtube
 * cards, e2e s23, 11-17), and the fallback was an attribute nothing read. The extension's wrap
 * of the renderer puts both on heatsync's origin, and one listener does the swap.
 */
const { hsCardHtmlL10n, cardAbsAssets, cardImgFallback } = makeCardL10n()
const opts = { escapeHtml: (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`) }
const card = (profile, variant) =>
  hsCardHtmlL10n(hsCardModel({ profile }, { hint: { platform: 'kick', login: 'nopic' } }, {}), { ...opts, variant })
const NOPIC = { id: 7, username: 'nopic', display_name: 'NoPic', kick_username: 'nopic' }

const imgs = (html) => {
  const doc = new Window().document
  const t = doc.createElement('template')
  t.innerHTML = html
  return [...t.content.querySelectorAll('img')]
}

for (const variant of ['panel', 'full', 'peek']) {
  test(`${variant} card, chatter with no picture: every picture is asked of heatsync, none of the host`, () => {
    const all = imgs(card(NOPIC, variant))
    expect(all.length).toBeGreaterThan(0)
    for (const img of all) {
      expect(img.getAttribute('src')).toMatch(/^https:\/\//)
      const fb = img.getAttribute('data-imgerr-src')
      if (fb != null) expect(fb).toBe('https://heatsync.org/anon.webp')
    }
    expect(all.some((i) => i.getAttribute('src') === 'https://heatsync.org/anon.webp')).toBe(true)
  })
}

test('a chatter with a picture keeps it, with the heatsync fallback behind it', () => {
  const [av] = imgs(
    card({ ...NOPIC, kick_profile_pic: 'https://files.kick.com/images/user/1/pic.webp' }, 'panel'),
  ).filter((i) => i.className === 'hs-card-avatar')
  expect(av.getAttribute('src')).toBe('https://files.kick.com/images/user/1/pic.webp')
  expect(av.getAttribute('data-imgerr-src')).toBe('https://heatsync.org/anon.webp')
})

test('only root paths move: full urls, protocol-relative urls and text are left alone', () => {
  expect(cardAbsAssets('<img src="https://a.b/c.png"><img src="//cdn.x/y.png">')).toBe(
    '<img src="https://a.b/c.png"><img src="//cdn.x/y.png">',
  )
  expect(cardAbsAssets('<a href="/u/alice">src=&quot;/x&quot;</a>')).toBe('<a href="/u/alice">src=&quot;/x&quot;</a>')
  expect(cardAbsAssets('<img src="/a.webp" data-imgerr-src="/anon.webp">')).toBe(
    '<img src="https://heatsync.org/a.webp" data-imgerr-src="https://heatsync.org/anon.webp">',
  )
})

test('a picture that fails falls back once, and a failing fallback does not loop', () => {
  const doc = new Window().document
  const img = doc.createElement('img')
  img.setAttribute('src', 'https://files.kick.com/gone.webp')
  img.setAttribute('data-imgerr-src', 'https://heatsync.org/anon.webp')
  cardImgFallback({ target: img })
  expect(img.getAttribute('src')).toBe('https://heatsync.org/anon.webp')
  expect(img.hasAttribute('data-imgerr-src')).toBe(false)
  cardImgFallback({ target: img })
  expect(img.getAttribute('src')).toBe('https://heatsync.org/anon.webp')
})

test('errors from anything else are not touched', () => {
  const doc = new Window().document
  const plain = doc.createElement('img')
  plain.setAttribute('src', 'https://x.y/z.png')
  cardImgFallback({ target: plain })
  expect(plain.getAttribute('src')).toBe('https://x.y/z.png')
  cardImgFallback({ target: doc.createElement('script') })
  cardImgFallback({ target: doc })
})
