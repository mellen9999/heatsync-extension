/**
 * Our own panel draws a chat row for every message, and the watchers that wait on the HOST page's DOM
 * (twitch's persistent player, youtube's watch page, twitch's callout queue) sit on the app root, so each of those rows used to wake them for nothing. A batch that landed
 * entirely inside #hs-mc-container is now answered with one contains() per record, before any query.
 *
 * mutationsAreOurs is run for real; the youtube watcher, which can be lifted out of its file, runs in
 * happy-dom; the others are held to their call sites by reading the source (their bodies sit inside
 * functions that cannot be lifted). The kick player waiter and the youtube chat frame waiter ask the
 * page by id, which is cheaper than the check, and are left alone.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { Window } from 'happy-dom'

const read = (f) => readFileSync(new URL(`../src/multichat/${f}`, import.meta.url), 'utf8')

// bootstrap.js is a plain script in the bundle's one scope: lift the helper out of it as written
const boot = read('bootstrap.js')
const at = boot.indexOf('function mutationsAreOurs(')
expect(at).toBeGreaterThan(-1)
const mutationsAreOurs = new Function(`${boot.slice(at, boot.indexOf('\n}\n', at) + 3)}\nreturn mutationsAreOurs`)()
const tick = () => new Promise((r) => setTimeout(r, 5))

let win
const realDocument = globalThis.document
afterEach(() => {
  win?.close?.()
  globalThis.document = realDocument
})

/** a page with our panel (and its message list) in the body */
function page() {
  win = new Window({ url: 'https://www.youtube.com/' })
  globalThis.document = win.document
  const { document } = win
  const panel = document.createElement('div')
  panel.id = 'hs-mc-container'
  const list = document.createElement('div')
  list.id = 'hs-mc-messages'
  panel.appendChild(list)
  document.body.appendChild(panel)
  const rows = (n) => {
    for (let i = 0; i < n; i++) list.appendChild(document.createElement('div'))
  }
  return { document, panel, list, rows }
}

/** the records of one batch, the way a MutationObserver hands them over */
function batch(el, fn) {
  const got = []
  const mo = new win.MutationObserver((m) => got.push(...m))
  mo.observe(el, { childList: true, subtree: true, attributes: true })
  fn()
  return new Promise((r) =>
    setTimeout(() => {
      mo.disconnect()
      r(got)
    }, 5),
  )
}

describe('mutationsAreOurs', () => {
  test('a batch wholly inside our panel is ours', async () => {
    const { document, list } = page()
    const recs = await batch(document.body, () => {
      list.appendChild(document.createElement('div'))
      list.firstChild.setAttribute('class', 'x')
    })
    expect(recs.length).toBeGreaterThan(1)
    expect(mutationsAreOurs(recs)).toBe(true)
  })

  test('one record outside it makes the batch the page’s', async () => {
    const { document, list } = page()
    const recs = await batch(document.body, () => {
      list.appendChild(document.createElement('div'))
      document.body.appendChild(document.createElement('ytd-watch-flexy'))
    })
    expect(mutationsAreOurs(recs)).toBe(false)
  })

  test('the panel itself being added or removed is the page’s change (the target is its parent)', async () => {
    const { document, panel } = page()
    const recs = await batch(document.body, () => panel.remove())
    expect(recs[0].target).toBe(document.body)
    expect(mutationsAreOurs(recs)).toBe(false)
  })

  test('no panel on the page: nothing is ours, so nothing is skipped', async () => {
    const { document, panel } = page()
    panel.remove()
    const recs = await batch(document.body, () => document.body.appendChild(document.createElement('div')))
    expect(mutationsAreOurs(recs)).toBe(false)
  })
})

/** the text of `let name = ...` through the end of `function fn` (column-0 closing brace) */
function lift(src, startMarker, fn) {
  const from = src.indexOf(startMarker)
  expect(from, startMarker).toBeGreaterThan(-1)
  const at = src.indexOf(`function ${fn}(`, from)
  const end = src.indexOf('\n}\n', at) + 3
  expect(at).toBeGreaterThan(from)
  return src.slice(from, end)
}

describe('youtube: the watch page mounting is still noticed, our rows are not looked at', () => {
  function arm() {
    const env = page()
    const calls = { query: 0, position: 0, width: 0, untracked: 0 }
    const code = lift(read('youtube-host.js'), 'let _ytFlexyMountObs = null', 'watchYtFlexyMount')
    const watch = new Function(
      'hostPlatform',
      'hsQuery',
      'cleanup',
      'applyChatPosition',
      'applyYouTubeChatWidth',
      'mutationsAreOurs',
      'document',
      'MutationObserver',
      `${code}\nreturn watchYtFlexyMount`,
    )(
      'yt',
      (_name, sel) => {
        calls.query++
        return env.document.querySelector(sel)
      },
      { trackObserver: () => {}, untrackObserver: () => calls.untracked++ },
      () => calls.position++,
      () => calls.width++,
      mutationsAreOurs,
      env.document,
      win.MutationObserver,
    )
    return { ...env, calls, watch }
  }

  test('a flexy that mounts after our rows have been drawing is found', async () => {
    const { document, rows, calls, watch } = arm()
    watch()
    const looked = calls.query // the "already there?" look at arming
    rows(20)
    await tick()
    expect(calls.query).toBe(looked)
    document.body.appendChild(document.createElement('ytd-watch-flexy'))
    await tick()
    expect(calls.query).toBeGreaterThan(looked)
    expect(calls.position).toBe(1)
    expect(calls.width).toBe(1)
    expect(calls.untracked).toBe(1)
  })

  test('a flexy that mounts deep inside the page is found', async () => {
    const { document, calls, watch } = arm()
    watch()
    const app = document.createElement('div')
    document.body.appendChild(app)
    await tick()
    const manager = document.createElement('div')
    app.appendChild(manager)
    await tick()
    manager.appendChild(document.createElement('ytd-watch-flexy'))
    await tick()
    expect(calls.position).toBe(1)
  })
})

describe('the other watchers answer our own rows first', () => {
  // each callback opens with the early-out, before it asks the page anything
  const first = (who) =>
    new RegExp(
      `${who} = new MutationObserver\\(\\(muts\\) => \\{\\n\\s*(?://[^\\n]*\\n\\s*)*if \\(mutationsAreOurs\\(muts\\)\\) return`,
    )
  for (const [file, who, what] of [
    ['youtube-host.js', '_ytFlexyMountObs', 'the youtube watch page waiter'],
    ['twitch-host.js', '_ttvPpObserver', 'the twitch persistent player waiter'],
    ['share-callouts.js', '_hsCalloutCloseObs', 'the callout queue watcher'],
  ]) {
    test(`${what} (${file})`, () => {
      expect(read(file)).toMatch(first(who))
    })
  }

  test('the callout watcher no longer carries its own copy of the check', () => {
    expect(read('share-callouts.js')).not.toContain("getElementById('hs-mc-overlay')")
  })
})
