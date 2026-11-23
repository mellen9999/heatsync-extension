/**
 * An emote in the box is an emote: a right-click on it acts on the picture the box shows, as it
 * does on a chat line. The chip read "yours" by its NAME, so the channel's emote under a name you
 * also own was removed from YOUR set; a block repainted every chip of the name, so blocking the
 * channel's W dashed a chip of your own W; and an emote you removed kept its picture in the box
 * while the line went out as a plain word. The real clicks run in scripts/render-emote-collisions.ts
 * (cases n-q); here the block repaint runs on the real source and the wiring is pinned.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'

const ROOT = join(import.meta.dir, '..')
const read = (f) => readFileSync(join(ROOT, 'src', 'multichat', f), 'utf8')
const EMOTES = read('emotes.js')
const INPUT = read('input.js')
const LAW = read('emote-law-send.js')

function fn(src, name) {
  const start = src.indexOf(`function ${name}(`)
  if (start === -1) throw new Error(`"${name}" not found`)
  return src.slice(start, src.indexOf('\n}', start) + 2)
}

const win = new Window()
const doc = win.document
// the pictures blocked right now, by url (the real emoteIsBlocked is keyed the same way)
const blockedUrls = new Set()
const repaint = new Function(
  'document',
  'emoteIsBlocked',
  `const HS_TRANSPARENT_PX = 'data:image/gif;base64,AA=='
${fn(EMOTES, 'markInputEmoteBlocked')}
${fn(EMOTES, 'applyInputEmoteBlockState')}
return applyInputEmoteBlockState`,
)(doc, (_name, e) => blockedUrls.has(e.url))

const chip = (name, url, extra = '') =>
  `<img class="hs-input-emote" src="${url}" alt="${name}" data-emote-name="${name}" data-hs-url="${url}" data-state="global"${extra}>`
function box(html) {
  doc.body.innerHTML = `<div id="hs-mc-input">${html}</div>`
  return [...doc.querySelectorAll('#hs-mc-input img')]
}
const dashed = (img) => img.dataset.hsInputBlocked === '1'

describe('a block repaints the chips of that picture', () => {
  test("blocking the channel's W leaves a chip of your own W alone", () => {
    const [room, mine] = box(chip('W', 'https://x/W_room.png') + chip('W', 'https://x/W_mine.png'))
    blockedUrls.add('https://x/W_room.png')
    repaint('W')
    expect(dashed(room)).toBe(true)
    expect(dashed(mine)).toBe(false)
    expect(mine.getAttribute('src')).toBe('https://x/W_mine.png')
  })

  test('unblocking it brings that chip back, with the state it had', () => {
    const [room] = box(chip('W', 'https://x/W_room.png'))
    blockedUrls.add('https://x/W_room.png')
    repaint('W')
    expect(room.dataset.state).toBe('blocked')
    blockedUrls.clear()
    repaint('W')
    expect(dashed(room)).toBe(false)
    expect(room.getAttribute('src')).toBe('https://x/W_room.png')
    expect(room.dataset.state).toBe('global')
  })

  test('one of two blocked pictures of a name unblocked: the other stays dashed', () => {
    const [a, b] = box(chip('W', 'https://x/W_a.png') + chip('W', 'https://x/W_b.png'))
    blockedUrls.add('https://x/W_a.png').add('https://x/W_b.png')
    repaint('W')
    expect([dashed(a), dashed(b)]).toEqual([true, true])
    blockedUrls.delete('https://x/W_a.png')
    repaint('W')
    expect([dashed(a), dashed(b)]).toEqual([false, true])
  })

  test('an overlay typed as name0 follows a block of its base name', () => {
    blockedUrls.clear()
    const [ov] = box(chip('Wave0', 'https://x/Wave.png', ' data-hs-key="Wave"'))
    blockedUrls.add('https://x/Wave.png')
    repaint('Wave')
    expect(dashed(ov)).toBe(true)
  })

  test('a chip of another name is never touched', () => {
    blockedUrls.clear()
    const [other] = box(chip('Other', 'https://x/W_room.png'))
    blockedUrls.add('https://x/W_room.png')
    repaint('W')
    expect(dashed(other)).toBe(false)
  })
})

describe('what a right-clicked emote is to you', () => {
  // mine = the pictures that are yours, by url (the real isViewerEmoteUrl compares the picture)
  const mine = new Set()
  const clickState = new Function('isViewerEmoteUrl', `${fn(LAW, 'emoteClickState')}\nreturn emoteClickState`)(
    (_name, url) => mine.has(url),
  )
  const chipOf = (state, url) => ({ chip: true, wrapper: null, state, emoteName: 'W', emoteUrl: url })
  test("the channel's picture under a name you own is not yours: it is blocked, never a removal", () => {
    mine.clear()
    mine.add('mine.png')
    expect(clickState(chipOf('owned', 'room.png'))).toBe('global')
    expect(clickState({ ...chipOf('owned', 'room.png'), chip: false, wrapper: {} })).toBe('global')
  })
  test('your own copy is yours, whatever its chip was stamped with (a Tab step stamps nothing)', () => {
    expect(clickState(chipOf('global', 'mine.png'))).toBe('owned')
    expect(clickState(chipOf('owned', 'mine.png'))).toBe('owned')
  })
  test('a blocked emote is blocked, yours or not: the click unblocks', () => {
    expect(clickState(chipOf('blocked', 'mine.png'))).toBe('blocked')
  })
  test('a chat line is never promoted to yours by a click, and a bare image keeps its own state', () => {
    expect(clickState({ chip: false, wrapper: {}, state: 'channel', emoteName: 'W', emoteUrl: 'mine.png' })).toBe(
      'channel',
    )
    expect(clickState({ chip: false, wrapper: null, state: 'owned', emoteName: 'W', emoteUrl: 'x.png' })).toBe('owned')
  })
})

describe('the picture a chip names', () => {
  const chipIs = new Function(`${fn(LAW, 'hsChipIs')}\nreturn hsChipIs`)()
  test('a reused chip never keeps the last picture', () => {
    const img = { dataset: { emoteName: 'W0' } }
    chipIs(img, 'a.png', 'hashA', 'W')
    expect(img.dataset).toEqual({ emoteName: 'W0', hsUrl: 'a.png', hsHash: 'hashA', hsKey: 'W' })
    img.dataset.emoteName = 'Other'
    chipIs(img, 'b.png', undefined, false)
    expect(img.dataset).toEqual({ emoteName: 'Other', hsUrl: 'b.png' })
    chipIs(img, 'c.png', undefined, 'Other')
    expect(img.dataset.hsKey).toBeUndefined()
  })
})

describe('wiring', () => {
  const build = fn(EMOTES, 'createInputEmoteImg')
  test('a chip is yours by its picture, never by its name, and carries that picture', () => {
    expect(build).toMatch(/isViewerEmote\(key \|\| emoteName, emote\)/)
    expect(build).not.toMatch(/inventoryEmotes\.has\(emoteName\) \? 'owned'/)
    expect(build).toMatch(/hsChipIs\(img, emote\.url, emote\.hash, key\)/)
  })

  test("the chip keeps its identity out of the page script's emote passes", () => {
    // content.js acts on every [data-emote-hash] in the page: a chip is not a chat emote
    expect(build).not.toMatch(/dataset\.emoteHash/)
  })

  test('a Tab step names its picture too, on a new chip and a reused one', () => {
    const step = INPUT.slice(
      INPUT.indexOf('const _applyInputBlock = (img) =>'),
      INPUT.indexOf('const cyclingImg = () =>'),
    )
    expect(step).toMatch(
      /hsChipIs\(img, match\.url, match\.hash, match\._synthOverlay && match\.name\.slice\(0, -1\)\)/,
    )
    expect(step).toMatch(/dataset\.source = match\.source/)
  })

  test('the right-click judges a box chip by its own picture at the click', () => {
    expect(INPUT).toMatch(/chip: target\.classList\.contains\('hs-input-emote'\)/)
    expect(INPUT).toMatch(/emoteUrl: d\.hsUrl \|\| d\.hsOrigSrc \|\| target\.src/)
    expect(INPUT).toMatch(/const state = emoteClickState\(emoteInfo, hash\)/)
    // the old guard only looked at chat wrappers, and the menu read the hash off the wrapper alone
    expect(INPUT).not.toMatch(/wrapper && !isViewerEmoteUrl/)
    expect(INPUT).not.toMatch(/hash: wrapper\?\.dataset\?\.emoteHash \|\| undefined/)
  })

  test("an unblock brings back each line's own picture, in its own state", () => {
    // the name's picture came back: under a name you also own, the room's emote on a chat line was
    // redrawn as YOUR copy and marked yours (render-emote-collisions.ts case o runs the real click)
    const unblock = fn(EMOTES, 'unblockEmote')
    expect(unblock).toMatch(/const own = w\.dataset\?\.emoteUrl\n\s*const url = own \|\| realUrl/)
    expect(unblock).toMatch(/!isViewerEmoteUrl\(emoteName, own, w\.dataset\.emoteHash\)/)
    expect(unblock).toMatch(/img\.src = url\n/)
    expect(unblock).not.toMatch(/img\.src = realUrl/)
  })

  test('an emote you removed is no picture in the box: its pick is dropped and the box is read again', () => {
    const removal = fn(EMOTES, 'applyLocalRemoval')
    expect(removal).toMatch(/dropPick\(\{ name: emoteName, url: _re\.url \}, lawBox\(\)\)\n\s*rereadInputChips\(\)/)
    expect(fn(EMOTES, 'lookupEmoteWithOverlay')).not.toMatch(/removedEmoteFallback/)
  })
})
