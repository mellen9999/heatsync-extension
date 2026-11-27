/**
 * kick-css-fix.js runs at document_start, usually before <head> exists (and, rarely, before <html>).
 * <head> is a direct child of <html> and <html> of the document, so it waits for a child and nothing
 * deeper; with `subtree` on the document it was handed a record for every node kick drew until the
 * head came, and it is only ever one early tick.
 *
 * The REAL file runs in happy-dom with the head (and once the whole <html>) taken away. The stylesheet
 * it then meets must still be swapped for the rewritten copy.
 */
import { afterEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { Window } from 'happy-dom'

const SRC = readFileSync(new URL('../src/content/kick-css-fix.js', import.meta.url), 'utf8')
const HEAVY = '.x:is(:where(.group\\/card):has(:focus) *){display:none}'

let win
afterEach(() => win?.close?.())

function start({ withoutHtml = false } = {}) {
  win = new Window({ url: 'https://kick.com/xqc' })
  const document = win.document
  document.documentElement.remove?.()
  if (!withoutHtml) {
    const html = document.createElement('html')
    document.appendChild(html)
  }
  const seen = []
  class SpyObserver extends win.MutationObserver {
    observe(target, opts) {
      seen.push({ target, opts })
      return super.observe(target, opts)
    }
  }
  const asked = []
  const chrome = {
    runtime: {
      sendMessage: async (m) => {
        asked.push(m.url)
        return HEAVY
      },
    },
  }
  new Function('window', 'document', 'location', 'MutationObserver', 'chrome', 'browser', SRC)(
    win,
    document,
    win.location,
    SpyObserver,
    chrome,
  )
  return { document, seen, asked }
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms))

function sheet(document, href = 'https://assets.kick.com/_next/static/css/app.css') {
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = href
  return link
}

test('a head that arrives late is found, and its stylesheet is swapped', async () => {
  const { document, asked } = start()
  expect(document.head).toBeNull()
  const head = document.createElement('head')
  document.documentElement.appendChild(head)
  await tick()
  const link = sheet(document)
  head.appendChild(link)
  await tick(30)
  expect(asked).toEqual([link.href])
  expect(link.disabled).toBe(true)
  expect(head.querySelector('style')?.textContent).toContain(':where(.group\\/card):has(:focus) .x')
})

test('a head that was already there takes its sheets at once', async () => {
  win = new Window({ url: 'https://kick.com/xqc' })
  const link = sheet(win.document)
  win.document.head.appendChild(link)
  const asked = []
  new Function('window', 'document', 'location', 'MutationObserver', 'chrome', 'browser', SRC)(
    win,
    win.document,
    win.location,
    win.MutationObserver,
    {
      runtime: {
        sendMessage: async (m) => {
          asked.push(m.url)
          return HEAVY
        },
      },
    },
  )
  await tick(30)
  expect(asked).toEqual([link.href])
})

test('it waits for a child of <html> and nothing deeper', async () => {
  const { document, seen } = start()
  const waits = seen.filter((s) => s.target === document.documentElement)
  expect(waits.length).toBe(1)
  expect(waits[0].opts.childList).toBe(true)
  expect(waits[0].opts.subtree).toBeFalsy()
  // nothing is ever watched below the head's own children
  for (const s of seen) expect(s.opts.subtree, 'a subtree watch').toBeFalsy()
})

test('even when <html> itself is not there yet', async () => {
  const { document, seen, asked } = start({ withoutHtml: true })
  expect(document.documentElement).toBeNull()
  for (const s of seen) expect(s.opts.subtree, 'a subtree watch').toBeFalsy()
  const html = document.createElement('html')
  document.appendChild(html)
  await tick()
  const head = document.createElement('head')
  html.appendChild(head)
  await tick()
  const link = sheet(document)
  head.appendChild(link)
  await tick(30)
  expect(asked).toEqual([link.href])
  for (const s of seen) expect(s.opts.subtree, 'a subtree watch').toBeFalsy()
})
