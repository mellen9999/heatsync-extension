/**
 * Pasting a gif has to survive the clipboard.
 *
 * Chromium's "copy image" puts TWO things on the clipboard: a bitmap, which for
 * an animated gif is one flattened frame with the animation already gone, and a
 * text/html fragment holding the original `<img src>` — which still points at
 * the live animated file. The old paste handler read only the bitmap, so every
 * copied gif posted as a still and the loss was invisible: you got a picture,
 * just a dead one.
 *
 * The way back is the source url, resolved server-side through /api/img — which
 * already fetches under SSRF pinning, moderates, stores through the same
 * pipeline as a direct upload, and answers 302 → /uploads/<hash>.webp with the
 * frames intact. This file locks that route in, plus the fallbacks that keep a
 * paste from ever being LOST when the route doesn't work.
 *
 * Behaviour test for the url policy; contract assertions (repo convention — a
 * content script can't be imported here) for the rest.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const INPUT_SRC = readFileSync(join(ROOT, 'src/multichat/input.js'), 'utf8')
const EMBED_SRC = readFileSync(join(ROOT, 'src/multichat/feed-embed.js'), 'utf8')
const MAIN_SRC = readFileSync(join(ROOT, 'src/multichat/main.js'), 'utf8')
const BG_SRC = readFileSync(join(ROOT, 'chrome/background.js'), 'utf8')

function sliceFn(src, name) {
  const start = src.indexOf(`function ${name}(`)
  if (start === -1) throw new Error(`function not found: ${name}`)
  // Walk braces from the signature's opening brace to its match.
  const open = src.indexOf('{', start)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1)
  }
  throw new Error(`unbalanced braces in ${name}`)
}

// ── clipboardImageSourceUrl: which source urls we're willing to trust ────────
// Sliced from the real module so the policy under test can't drift from the
// shipped one. (new Function over first-party source read off disk — the same
// slice-and-run harness as feed-render-fixes.test.js. No input reaches it.)
// DOMParser isn't in the bun runtime (and isn't a repo dep — see
// paints.test.js), so it's stubbed down to "find the img srcs"; the assertions
// below are all about the url policy, which the stub doesn't participate in.
const clipboardImageSourceUrl = new Function(
  'DOMParser',
  `${sliceFn(INPUT_SRC, 'clipboardImageSourceUrl')}; return clipboardImageSourceUrl`,
)(
  class {
    parseFromString(html) {
      const srcs = [...html.matchAll(/<img\b[^>]*\bsrc="([^"]*)"/gi)].map((m) => m[1])
      return { querySelectorAll: () => srcs.map((s) => ({ getAttribute: () => s })) }
    }
  },
)

const clip = (html) => clipboardImageSourceUrl({ getData: (t) => (t === 'text/html' ? html : '') })

describe('clipboardImageSourceUrl', () => {
  test('takes the src of a single copied image', () => {
    expect(clip('<meta charset="utf-8"><img src="https://media.tenor.com/x.gif">')).toBe(
      'https://media.tenor.com/x.gif',
    )
  })

  test('query strings survive — they are often the whole identity of a CDN url', () => {
    expect(clip('<img src="https://cdn.example.com/a.gif?w=400&v=2">')).toBe('https://cdn.example.com/a.gif?w=400&v=2')
  })

  test('a copy of page CONTENT is not a copied image', () => {
    // Two images means the user selected a region of the page, and guessing
    // which one they meant is how you post the wrong picture.
    expect(clip('<p>look <img src="https://a.example/1.gif"> <img src="https://a.example/2.gif"></p>')).toBe('')
  })

  test('no html flavor at all — a screenshot straight from a capture tool', () => {
    expect(clip('')).toBe('')
    expect(clipboardImageSourceUrl(null)).toBe('')
  })

  test('a relative src is unusable: we do not know what page it came from', () => {
    expect(clip('<img src="/img/a.gif">')).toBe('')
  })

  test('http and data: srcs are refused — /api/img takes https only', () => {
    expect(clip('<img src="http://insecure.example/a.gif">')).toBe('')
    expect(clip('<img src="data:image/gif;base64,R0lGOD">')).toBe('')
  })

  test('a hostile clipboard cannot make it throw', () => {
    expect(clip('<img src="ht!tp://[::bad">')).toBe('')
    expect(
      clipboardImageSourceUrl({
        getData: () => {
          throw new Error('denied')
        },
      }),
    ).toBe('')
  })
})

// ── the paste route ─────────────────────────────────────────────────────────
describe('paste prefers the source url, then falls back', () => {
  test('every image entry point passes the clipboard source through', () => {
    // Composer paste, paste with the bar hidden, and drag-drop. A drag out of a
    // page carries the same html flavor, so it gets the same route.
    const wired = INPUT_SRC.match(/handleMediaUpload\(file, clipboardImageSourceUrl\(/g) || []
    expect(wired).toHaveLength(3)
    expect(INPUT_SRC).not.toMatch(/handleMediaUpload\(file\)/)
  })

  test('the bitmap is still uploaded when the source url does not resolve', () => {
    // The fallback is the whole safety story: a hotlink-blocked or expiring
    // source must cost you animation, never the paste.
    const fn = sliceFn(INPUT_SRC, 'handleMediaUpload')
    expect(fn).toMatch(/if \(!url\) url = await uploadMediaFile\(file\)/)
  })

  test('storeRemoteMedia reports failure as empty, never as a thrown paste', () => {
    const fn = sliceFn(INPUT_SRC, 'storeRemoteMedia')
    expect(fn).toMatch(/catch \{\s*return ''/)
  })

  test('losing the animation is said out loud', () => {
    // The fallback posts a picture either way, so a silent failure leaves you
    // wondering why the gif came out frozen.
    const fn = sliceFn(INPUT_SRC, 'handleMediaUpload')
    expect(fn).toMatch(/lostAnimation/)
    expect(fn).toMatch(/showUploadStatus\([^)]*still frame/)
  })

  test('the status line owns its clear timer', () => {
    // Chained messages: "upload done" is replaced by a warning about what the
    // upload cost. Per-call-site timers meant the first wiped the second.
    expect(INPUT_SRC).not.toMatch(/setTimeout\(\(\) => showUploadStatus\(null\), \d/)
    expect(sliceFn(INPUT_SRC, 'showUploadStatus')).toMatch(/clearTimeout\(_mcStatusTimer\)/)
  })
})

describe('api_store_remote resolves a remote image to our stored copy', () => {
  const handler = BG_SRC.slice(BG_SRC.indexOf("message.type === 'api_store_remote'"))
  const body = handler.slice(0, handler.indexOf('register_self_twitch_id'))

  test('https only, and never a request for a url we already host', () => {
    expect(body).toMatch(/protocol !== 'https:'/)
    expect(body).toMatch(/hostname === 'heatsync\.org'/)
  })

  test('reads the redirect target, not the body', () => {
    // The stored path is the 302 target; the body is the full image, to 10MB.
    expect(body).toMatch(/res\.body\?\.cancel\(\)/)
    expect(body).toMatch(/\/uploads\//)
  })

  test('answers with an absolute url', () => {
    // A relative url in the composer sends a message starting with "/", and
    // twitch answers "Unrecognized command". See content-script-api-transport.
    expect(body).toMatch(/sendResponse\(\{ ok: true, url: absUrl\(/)
  })
})

// ── folding the url away once its own picture is on screen ──────────────────
describe('a rendered image folds its url out of the message', () => {
  test('only the image branch is marked', () => {
    const embed = EMBED_SRC.slice(EMBED_SRC.indexOf('function chatEmbedForUrl'))
    const marks = embed.match(/data-hs-src-url=/g) || []
    // Images only. A youtube/reddit/spotify CARD keeps its url — there you are
    // being asked to click through to somewhere and you get to see where. A
    // VIDEO keeps its url too: preload="none" means it never proves it exists,
    // so there is no moment at which the url has been replaced by anything.
    expect(marks).toHaveLength(1)
    expect(embed).not.toMatch(/hs-feed-embed-pending[^`]*data-hs-src-url/)
  })

  test('the image carries an anchor holding the REAL url', () => {
    // hsProxyImg rewrites unknown hosts to /api/img, so "copy image address"
    // off the <img> would hand back our proxy url instead of the source.
    expect(EMBED_SRC).toMatch(/class="hs-mc-media-link" href="\$\{attr\(safe\)\}"/)
  })

  test('video is left unwrapped so its controls still work', () => {
    const videoBranch = EMBED_SRC.slice(EMBED_SRC.indexOf('<video controls muted preload="none"'))
    expect(videoBranch.slice(0, 200)).not.toMatch(/hs-mc-media-link/)
  })

  test('the url goes on load, not on insert', () => {
    // The hole in "hide now, restore on error": chat images are loading="lazy",
    // so one rendered out of view never fetches and never errors. Hiding up
    // front left that row a blank line until it was scrolled into view.
    const fn = sliceFn(MAIN_SRC, 'foldEmbeddedMediaUrl')
    expect(fn).toMatch(/addEventListener\('load', fold, \{ once: true \}\)/)
    expect(fn).not.toMatch(/'error'/)
    // A cached image is already decoded and will fire no load event.
    expect(fn).toMatch(/img\.complete && img\.naturalWidth > 0/)
  })

  test('the url is folded, never removed from the DOM', () => {
    const fn = sliceFn(MAIN_SRC, 'foldEmbeddedMediaUrl')
    expect(fn).toMatch(/classList\.add\('hs-mc-url-folded'\)/)
    expect(fn).not.toMatch(/\.remove\(\)|removeChild/)
  })

  test('matching is by href, not by the visible text', () => {
    // Chat truncates long urls for display, and linkifyPartialLinks synthesizes
    // an href for a url that was never fully typed.
    const fn = sliceFn(MAIN_SRC, 'foldEmbeddedMediaUrl')
    expect(fn).toMatch(/getAttribute\('href'\) === src/)
    expect(fn).not.toMatch(/textContent/)
  })
})
