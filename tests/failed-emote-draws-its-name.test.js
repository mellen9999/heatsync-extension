// An emote whose picture cannot be loaded from any address drew the browser's broken-picture
// icon, in rows and on cards (a kick gif the mirror refused, real kick, 11-18). It draws as its
// name now. The retries that swap in another address still come first.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mainSource } from './main-src.js'

const SRC = mainSource()
const fnSrc = (name) => {
  const a = SRC.indexOf(`function ${name}(`)
  const b = SRC.indexOf('\n}\n', a)
  if (a < 0 || b < 0) throw new Error(`carve: ${name}`)
  return SRC.slice(a, b + 3)
}

function emote({ name = 'KEKW', alt = 'KEKW', wrapped = true } = {}) {
  const out = { replaced: null, by: null }
  const wrap = wrapped
    ? {
        dataset: { emoteName: name },
        replaceWith(n) {
          out.replaced = 'wrapper'
          out.by = n
        },
      }
    : null
  const img = {
    alt,
    closest: () => wrap,
    replaceWith(n) {
      out.replaced = 'img'
      out.by = n
    },
  }
  return { img, out }
}
const hsEmoteAsName = new Function('document', `${fnSrc('hsEmoteAsName')}\nreturn hsEmoteAsName`)({
  createTextNode: (t) => ({ text: t }),
})

describe('an emote picture that cannot be loaded', () => {
  test('its box becomes its name', () => {
    const { img, out } = emote()
    hsEmoteAsName(img)
    expect(out).toEqual({ replaced: 'wrapper', by: { text: 'KEKW' } })
  })

  test('a name with markup in it stays text', () => {
    const { img, out } = emote({ name: '<b>x</b>' })
    hsEmoteAsName(img)
    expect(out.by).toEqual({ text: '<b>x</b>' }) // a text node, never html
  })

  test('a bare picture (no box) falls back to its alt', () => {
    const { img, out } = emote({ wrapped: false, alt: 'peepoHey' })
    hsEmoteAsName(img)
    expect(out).toEqual({ replaced: 'img', by: { text: 'peepoHey' } })
  })

  test('nothing to say: left alone', () => {
    const { img, out } = emote({ wrapped: false, alt: '' })
    hsEmoteAsName(img)
    expect(out.replaced).toBe(null)
  })
})

describe('the list hands a failed emote over only when no retry took it', () => {
  const at = SRC.indexOf('const onImgLoadOrError = (e) => {')
  const handler = SRC.slice(at, SRC.indexOf("if (e?.type === 'load')", at))

  test('the address is read before the retries and compared after them', () => {
    const order = [
      'const src0 =',
      'hsProxyFell',
      'hsStaticFell',
      'hsAvifFell',
      't.src === src0 &&',
      'hsEmoteAsName(t)',
    ].map((s) => handler.indexOf(s))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  test('only emote pictures: a badge or an avatar keeps its own handling', () => {
    const last = handler.slice(handler.indexOf('// no other address left to try'))
    expect(last).toContain("t.classList.contains('hs-mc-emote') || t.closest('.hs-card-log-body')")
    expect(last).not.toMatch(/badge|avatar/)
  })

  // hover-to-animate swaps in the animated twin and keeps the still's address: a twin that
  // fails gives the still back, it does not turn a picture that was fine into text
  test('an animated twin that fails under a hover puts the still back', () => {
    const last = handler.slice(handler.indexOf('// no other address left to try'))
    const run = (stash) => {
      const t = { dataset: stash ? { hsStaticSrc: stash } : {}, src: 'https://cdn/anim.webp' }
      const named = []
      const body = last.slice(
        last.indexOf('const still ='),
        last.indexOf('} else hsEmoteAsName(t)') + '} else hsEmoteAsName(t)'.length,
      )
      new Function('t', 'src0', 'hsEmoteAsName', body)(t, 'https://cdn/anim.webp', (x) => named.push(x))
      return { t, named }
    }
    const held = run('https://cdn/still.webp')
    expect(held.t.src).toBe('https://cdn/still.webp')
    expect(held.t.dataset.hsStaticSrc).toBeUndefined()
    expect(held.named).toEqual([])
    const bare = run(null)
    expect(bare.named.length).toBe(1)
  })

  // the server draws a card's history lines itself: a kick gif its mirror refused sat there as
  // four broken icons while the same emote in the list read as its name (real kick, e2e s23)
  test("a card's history line and a logs line get the same stand-in", () => {
    expect(handler).toContain("t.closest('.hs-card-log-body')")
    const cl = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'chat-logs.js'), 'utf8')
    const logs = cl.slice(cl.indexOf('function clEmoteImg('), cl.indexOf('function clEmoteBlocked('))
    expect(logs).toContain("img.addEventListener('error', () => hsEmoteAsName(img), { once: true })")
  })
})
