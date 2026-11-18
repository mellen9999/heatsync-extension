/**
 * Discover and pinned refresh themselves every 20s while on screen (src/multichat/polled-tab.js).
 * The refresh used to wipe the pane to "loading…" first, every time: the tab flashed, and a card
 * or a confirm open over it was replaced by "loading…" for good. And after a failed fetch the
 * render started the next one itself, at once, for as long as the api was down.
 *
 * Runs the real hsPolledTab against a model pane and a fetch the test answers by hand.
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'polled-tab.js'), 'utf8')

function tab() {
  const d = { fetches: 0, answer: null, drawn: [], ticks: [], cleared: 0, clears: 0, scope: null }
  d.scope = {
    currentTab: 'discover',
    cleanup: {
      setPageIntervalIfVisible: (fn, ms) => d.ticks.push({ fn, ms }) && d.ticks.length,
      clearInterval: () => d.cleared++,
    },
    t: (k) => k,
    document: { createElement: () => ({}) },
  }
  const { hsPolledTab, hsPolledNote } = new Function(
    'scope',
    `with (scope) { ${SRC}\n return { hsPolledTab, hsPolledNote } }`,
  )(d.scope)
  d.note = hsPolledNote
  d.list = hsPolledTab({
    tab: 'discover',
    fetch: () => {
      d.fetches++
      return new Promise(
        (res, rej) => (d.answer = { ok: () => res(true), bad: () => res(false), boom: () => rej(new Error('x')) }),
      )
    },
    // the renderer's first lines, as social.js writes them
    render: () => {
      d.list.poll()
      d.drawn.push(d.list.placeholder() || 'list')
    },
    clear: () => d.clears++,
  })
  d.settle = () => new Promise((r) => setImmediate(r))
  return d
}

test('first draw: "loading…" and one fetch, then the list', async () => {
  const d = tab()
  d.list.poll()
  expect(d.list.placeholder()).toBe('loading')
  expect(d.list.placeholder()).toBe('loading') // a second draw while it loads asks nothing new
  expect(d.fetches).toBe(1)
  d.answer.ok()
  await d.settle()
  expect(d.drawn).toEqual(['list'])
})

test('a refresh is silent: nothing is drawn until the new list is in', async () => {
  const d = tab()
  d.list.placeholder()
  d.answer.ok()
  await d.settle()
  d.drawn.length = 0
  d.ticks[0].fn() // 20s later
  expect([d.fetches, d.drawn]).toEqual([2, []])
  expect(d.list.placeholder()).toBe('') // a redraw in between still shows the list, not "loading…"
  d.answer.ok()
  await d.settle()
  expect(d.drawn).toEqual(['list'])
})

test('a refresh that fails keeps the list that was there', async () => {
  const d = tab()
  d.list.placeholder()
  d.answer.ok()
  await d.settle()
  for (const how of ['bad', 'boom']) {
    d.ticks[0].fn()
    d.answer[how]()
    await d.settle()
    expect([how, d.list.placeholder(), d.clears]).toEqual([how, '', 0])
  }
})

test('nothing to show after a failure: the tab says so, and only the timer asks again', async () => {
  const d = tab()
  d.list.poll()
  d.list.placeholder()
  d.answer.bad()
  await d.settle()
  expect(d.drawn).toEqual(['failed'])
  for (let i = 0; i < 5; i++) expect(d.list.placeholder()).toBe('failed')
  expect(d.fetches).toBe(1) // the render does not start the next try (it did, in a loop)
  d.ticks[0].fn()
  expect(d.fetches).toBe(2)
  d.answer.ok()
  await d.settle()
  expect(d.drawn.at(-1)).toBe('list')
})

test('one timer, 20s, and it stops once the tab is left', () => {
  const d = tab()
  d.list.poll()
  d.list.poll()
  expect(d.ticks.map((x) => x.ms)).toEqual([20000])
  d.scope.currentTab = 'feed'
  d.ticks[0].fn()
  expect([d.fetches, d.cleared, d.list.timer]).toEqual([0, 1, null])
})

test('an answer that lands after the tab was left draws nothing', async () => {
  const d = tab()
  d.list.placeholder()
  d.scope.currentTab = 'feed'
  d.answer.ok()
  await d.settle()
  expect(d.drawn).toEqual([])
  expect(d.list.loaded).toBe(true) // kept for when the tab comes back
})

test('signed in or out mid-flight: the old answer is dropped and the tab asks again', async () => {
  const d = tab()
  d.list.placeholder()
  const first = d.answer
  d.list.reset()
  expect(d.clears).toBe(1)
  first.ok()
  await d.settle()
  expect(d.list.loaded).toBe(false)
  expect(d.drawn).toEqual(['loading']) // the redraw found nothing held and started the new fetch
  expect(d.fetches).toBe(2)
})

test('the note is one line: loading, or that heatsync could not be reached', () => {
  const d = tab()
  const pane = {
    textContent: 'x',
    kids: [],
    appendChild(el) {
      this.kids.push(el)
    },
  }
  d.note(pane, 'loading')
  d.note(pane, 'failed')
  expect(pane.textContent).toBe('')
  expect(pane.kids.map((k) => [k.className, k.textContent])).toEqual([
    ['hs-mc-empty', 'common_loading'],
    ['hs-mc-empty', 'mc_whisper_hs_unreachable'],
  ])
})
