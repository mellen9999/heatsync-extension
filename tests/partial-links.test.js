// linkifyPartialLinks / defangedToHost — partial "watch?v=" youtube refs and
// defanged "(dot)"-style domains, rendered as an html post-pass that must
// never touch existing tags/anchors or emit unsafe attributes.

import { describe, expect, test } from 'bun:test'
import utils from '../src/lib/utils.js'

const { linkifyPartialLinks, defangedToHost } = utils

const A = (href, text) => `<a href="${href}" target="_blank" rel="noopener noreferrer" class="hs-mc-link">${text}</a>`

describe('defangedToHost', () => {
  test('canonical forms → dotted host', () => {
    expect(defangedToHost('heatsync (dot) org')).toBe('heatsync.org')
    expect(defangedToHost('heatsync(dot)org')).toBe('heatsync.org')
    expect(defangedToHost('HEATSYNC (DOT) ORG')).toBe('heatsync.org')
    expect(defangedToHost('site[.]com')).toBe('site.com')
    expect(defangedToHost('site (.) com')).toBe('site.com')
    expect(defangedToHost('site {dot} com')).toBe('site.com')
    expect(defangedToHost('a dot b dot com')).toBe('a.b.com')
  })

  test('rejects non-TLD tails', () => {
    expect(defangedToHost('3 dot 5')).toBeNull()
    expect(defangedToHost('v1 (dot) 2')).toBeNull()
    expect(defangedToHost('single')).toBeNull()
  })
})

describe('linkifyPartialLinks — youtube watch refs', () => {
  test('bare watch?v= becomes a youtube link, display text verbatim', () => {
    expect(linkifyPartialLinks('check watch?v=l9i0hDNBdZM out')).toBe(
      `check ${A('https://www.youtube.com/watch?v=l9i0hDNBdZM', 'watch?v=l9i0hDNBdZM')} out`,
    )
  })

  test('does not fire inside a full url or an existing anchor', () => {
    const full = `<a href="https://www.youtube.com/watch?v=l9i0hDNBdZM" class="hs-mc-link">youtube.com/watch?v=l9i0hDNBdZM</a>`
    expect(linkifyPartialLinks(full)).toBe(full)
    expect(linkifyPartialLinks('youtube.com/watch?v=l9i0hDNBdZM')).toBe('youtube.com/watch?v=l9i0hDNBdZM')
  })

  test('rejects wrong-length ids', () => {
    expect(linkifyPartialLinks('watch?v=short')).toBe('watch?v=short')
  })

  test('trailing params ride along, escaped & stays escaped', () => {
    expect(linkifyPartialLinks('watch?v=l9i0hDNBdZM&amp;t=30s')).toBe(
      A('https://www.youtube.com/watch?v=l9i0hDNBdZM&amp;t=30s', 'watch?v=l9i0hDNBdZM&amp;t=30s'),
    )
  })
})

describe('linkifyPartialLinks — bare youtube path fragments', () => {
  test("mellen's case: shorts/<id>", () => {
    expect(linkifyPartialLinks('lol shorts/e2B1_DNpsV4')).toBe(
      `lol ${A('https://www.youtube.com/shorts/e2B1_DNpsV4', 'shorts/e2B1_DNpsV4')}`,
    )
  })

  test('live / embed / legacy v keep their own path', () => {
    expect(linkifyPartialLinks('live/e2B1_DNpsV4')).toContain('href="https://www.youtube.com/live/e2B1_DNpsV4"')
    expect(linkifyPartialLinks('embed/e2B1_DNpsV4')).toContain('href="https://www.youtube.com/embed/e2B1_DNpsV4"')
    expect(linkifyPartialLinks('v/e2B1_DNpsV4')).toContain('href="https://www.youtube.com/watch?v=e2B1_DNpsV4"')
  })

  test('leading slash form works and is kept in display text', () => {
    expect(linkifyPartialLinks('/shorts/e2B1_DNpsV4')).toBe(
      A('https://www.youtube.com/shorts/e2B1_DNpsV4', '/shorts/e2B1_DNpsV4'),
    )
  })

  test('inside a real url it stays for the normal linkifier', () => {
    const url = 'youtube.com/shorts/e2B1_DNpsV4'
    expect(linkifyPartialLinks(url)).toBe(url)
  })

  test('prose and wrong-length ids stay text', () => {
    expect(linkifyPartialLinks('wearing shorts/pants today')).toBe('wearing shorts/pants today')
    expect(linkifyPartialLinks('live/nope')).toBe('live/nope')
  })

  test('playlist and channel ids', () => {
    expect(linkifyPartialLinks('playlist?list=PLl9i0hDNBdZMxx')).toContain(
      'href="https://www.youtube.com/playlist?list=PLl9i0hDNBdZMxx"',
    )
    expect(linkifyPartialLinks('channel/UCl9i0hDNBdZMxxxxxxxxxx')).toContain(
      'href="https://www.youtube.com/channel/UCl9i0hDNBdZMxxxxxxxxxx"',
    )
  })

  test('@handles are left to the mention pass', () => {
    expect(linkifyPartialLinks('@someverylonghandle')).toBe('@someverylonghandle')
  })
})

describe('linkifyPartialLinks — host-less tweets', () => {
  test('links name/status/id to x.com, not prose', () => {
    expect(linkifyPartialLinks('GripAshford/status/2107279328723484841'))
      .toBe(A('https://x.com/GripAshford/status/2107279328723484841', 'GripAshford/status/2107279328723484841'))
    expect(linkifyPartialLinks('my status/12345678 order')).toBe('my status/12345678 order')
    expect(linkifyPartialLinks('build/status/42')).toBe('build/status/42')
  })
})

describe('linkifyPartialLinks — reddit refs', () => {
  test('r/ and u/ and /user/', () => {
    expect(linkifyPartialLinks('see r/place')).toBe(`see ${A('https://www.reddit.com/r/place', 'r/place')}`)
    expect(linkifyPartialLinks('u/spez')).toBe(A('https://www.reddit.com/user/spez', 'u/spez'))
    expect(linkifyPartialLinks('/user/spez')).toBe(A('https://www.reddit.com/user/spez', '/user/spez'))
  })

  test('chat slashisms stay text', () => {
    expect(linkifyPartialLinks('w/e 24/7 and/or')).toBe('w/e 24/7 and/or')
  })

  test('does not fire inside a reddit url', () => {
    expect(linkifyPartialLinks('reddit.com/r/place')).toBe('reddit.com/r/place')
  })
})

describe('linkifyPartialLinks — bare hosts with no path', () => {
  test('common tlds link', () => {
    expect(linkifyPartialLinks('go to heatsync.org')).toBe(`go to ${A('https://heatsync.org', 'heatsync.org')}`)
    expect(linkifyPartialLinks('7tv.app')).toBe(A('https://7tv.app', '7tv.app'))
  })

  test('run-on chat prose does not become a link', () => {
    expect(linkifyPartialLinks('lol.im dead')).toBe('lol.im dead')
    expect(linkifyPartialLinks('wait.what')).toBe('wait.what')
    expect(linkifyPartialLinks('nice.jpg')).toBe('nice.jpg')
  })

  test('emails are not hosts', () => {
    expect(linkifyPartialLinks('mail me at x@heatsync.org')).toBe('mail me at x@heatsync.org')
  })

  test('with-path form is left to the normal linkifier', () => {
    expect(linkifyPartialLinks('heatsync.org/emotes')).toBe('heatsync.org/emotes')
  })
})

describe('linkifyPartialLinks — defanged domains', () => {
  test('mellen case: https://heatsync (DOT) org', () => {
    expect(linkifyPartialLinks('go to https://heatsync (DOT) org now')).toBe(
      `go to ${A('https://heatsync.org', 'https://heatsync (DOT) org')} now`,
    )
  })

  test('hxxps scheme is normalized in href, kept in display', () => {
    expect(linkifyPartialLinks('hxxps://evil[.]example')).toBe(A('https://evil.example', 'hxxps://evil[.]example'))
  })

  test('bare form with path', () => {
    expect(linkifyPartialLinks('heatsync(dot)org/emotes')).toBe(
      A('https://heatsync.org/emotes', 'heatsync(dot)org/emotes'),
    )
  })

  test('spaced dot word form', () => {
    expect(linkifyPartialLinks('join heatsync dot org today')).toBe(
      `join ${A('https://heatsync.org', 'heatsync dot org')} today`,
    )
  })

  test('number prose stays text', () => {
    expect(linkifyPartialLinks('rated 3 dot 5 stars')).toBe('rated 3 dot 5 stars')
  })

  test('never crosses tags — emote img splits the phrase', () => {
    const html = 'heatsync <img src="x.png"> (dot) org'
    expect(linkifyPartialLinks(html)).toBe(html)
  })

  test('painted-mention anchors with inner tags pass through whole', () => {
    const anchor = '<a href="https://heatsync.org/user/x" class="hs-mc-user"><span>x (dot) y</span></a>'
    expect(linkifyPartialLinks(anchor)).toBe(anchor)
  })

  test('escaped input stays attribute-safe', () => {
    const out = linkifyPartialLinks('&quot;heatsync (dot) org&quot;')
    expect(out).toContain(A('https://heatsync.org', 'heatsync (dot) org'))
    expect(out).not.toMatch(/href="[^"]*&quot;/)
  })
})
