/**
 * Native mode on kick: the site's renderer owns the text nodes of a message. When a mod deletes
 * the message kick takes every child out of the text span, one removeChild each — and a node we
 * had swapped for our own made that throw inside kick's renderer. Its error screen replaced the
 * whole chat ("We are sorry, but something went wrong") on every moderated channel, within a
 * minute (real kick, e2e s24 + a side-by-side run with no extension, 11-18).
 *
 * Runs src/content/site-nodes.js (the file build.js embeds into content.js) against a happy-dom
 * span built the way kick builds one, and plays kick's own delete on it.
 */
import { afterEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { createSiteText } from '../src/content/site-nodes.js'

let win
afterEach(() => win?.happyDOM.close())

/** kick's text span: words, one of its own emotes, more words */
function leaf() {
  win = new Window()
  const document = win.document
  document.body.innerHTML = `<div data-index="7" data-heatsync-generation="3"><span class="font-normal leading-[1.55]">hello KEKW <span class="relative mx-px inline-block"><img src="https://files.kick.com/emotes/1/fullsize" alt="kickEmote"></span> world</span></div>`
  const span = document.querySelector('span.font-normal')
  const [t1, emote, t2] = span.childNodes
  const redrawn = []
  const site = createSiteText({ MutationObserver: win.MutationObserver, onRedrawn: (l) => redrawn.push(l) })
  return { document, span, t1, emote, t2, site, redrawn }
}
const settle = () => new Promise((r) => setTimeout(r, 0))

test('the words move to a span of ours and the site node stays where the site put it', () => {
  const { span, t1, emote, t2, site } = leaf()
  const a = site.park(t1)
  const b = site.park(t2)
  expect(a.className).toBe('hs-textfrag')
  expect(a.textContent).toBe('hello KEKW ')
  expect([...span.childNodes]).toEqual([t1, a, emote, t2, b])
  expect(span.textContent).toBe('hello KEKW  world') // each word on screen once
})

test("kick's delete (every child out, one by one, a notice in) goes through and leaves only the notice", async () => {
  const { document, span, t1, emote, t2, site, redrawn } = leaf()
  // what the emote pass does with the span it gets back: its own children, replaced freely
  const a = site.park(t1)
  const img = document.createElement('span')
  img.className = 'heatsync-emote-wrapper'
  a.replaceChildren(document.createTextNode('hello '), img, document.createTextNode(' '))
  site.park(t2)

  // react's commit: removeChild on the parent it rendered them into, then the new child
  expect(() => {
    span.removeChild(t1)
    span.removeChild(emote)
    span.removeChild(t2)
  }).not.toThrow()
  span.className = 'text-neutral leading-[1.55]'
  const notice = document.createElement('span')
  notice.className = 'font-semibold'
  notice.textContent = '(Deleted)'
  span.appendChild(notice)

  await settle()
  expect([...span.childNodes]).toEqual([notice])
  expect(span.textContent).toBe('(Deleted)') // nothing of the deleted message is left to read
  expect(redrawn).toEqual([span])
})

test('a redraw that keeps one of its text nodes gives that node its words back', async () => {
  const { span, t1, emote, t2, site } = leaf()
  site.park(t1)
  site.park(t2)
  span.removeChild(emote) // the site took only its emote out
  await settle()
  expect([...span.childNodes]).toEqual([t1, t2])
  expect(span.textContent).toBe('hello KEKW  world')
})

test('our own changes inside the span are not a redraw', async () => {
  const { span, t1, site, redrawn } = leaf()
  const a = site.park(t1)
  a.replaceChildren('x')
  const stack = span.ownerDocument.createElement('span')
  stack.className = 'heatsync-emote-stack'
  a.after(stack)
  stack.remove()
  await settle()
  expect(redrawn).toEqual([])
  expect(t1.nodeValue).toBe('')
  expect(a.isConnected).toBe(true)
})

test('content.js never swaps a kick text node out: both ways into a message go through park', () => {
  const src = readFileSync(join(import.meta.dir, '..', 'src', 'content', 'content.js'), 'utf8')
  const fn = src.slice(
    src.indexOf('function replaceEmotesPreservingImgs'),
    src.indexOf('// Process individual message'),
  )
  expect(fn).toContain('siteText.park(node)')
  expect(fn).not.toContain('replaceWith')
  // a kick leaf with no picture in it takes the same path
  expect(src).toContain("if (isKick || textElement.querySelector('img')) {")
  // names are coloured inside our spans, never by swapping the site's node
  expect(src).toMatch(/const textFragments = isKick\s+\? messageElement\.querySelectorAll\('\.hs-textfrag'\)/)
  // an emote broadcast for a row already on screen is put into our spans, never into kick's node
  expect(src).toContain(
    "const hosts = isKick ? Array.from(textElement.querySelectorAll('.hs-textfrag')) : [textElement]",
  )
  // and kick's span is never removed as "empty": one holding only a parked text node matches :empty
  expect(src).toContain("const emptyContainers = isKick ? [] : messageElement.querySelectorAll('.text-fragment:empty')")
  expect(src).not.toContain('span.font-normal:empty')
  // and the build embeds the module
  expect(readFileSync(join(import.meta.dir, '..', 'build.js'), 'utf8')).toContain("'content/site-nodes.js',")
})

test('a span holding only an emptied text node matches :empty — why the empty-span cleanup skips kick', () => {
  win = new Window()
  win.document.body.innerHTML = '<span class="font-normal">hi</span>'
  const span = win.document.querySelector('span')
  span.firstChild.nodeValue = ''
  expect(span.matches(':empty')).toBe(true)
})
