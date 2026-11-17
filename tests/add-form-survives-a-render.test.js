import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'

/**
 * The + tab's form is drawn by the same render pass as chat rows, and that pass is called from
 * all over: an emote set arriving, a setting or a filter rule changed in another tab. Each call
 * built the form again, so a channel name half typed (or a pasted list, or the picked follows)
 * was gone. The pass now leaves a view that is already up alone. The real form builders and the
 * real branch of the render pass run here on a real page.
 */
const read = (f) => readFileSync(join(import.meta.dir, '..', 'src', 'multichat', f), 'utf8')
const MGMT = read('channel-mgmt.js')
const LIVE = read('main-live.js')
const s = LIVE.indexOf("} else if (id === 'add') {")
const BRANCH = LIVE.slice(LIVE.indexOf('\n', s), LIVE.indexOf('\n    return\n', s))

function page() {
  const win = new Window()
  const document = win.document
  const frames = []
  const msgsEl = document.createElement('div')
  msgsEl.id = 'hs-mc-messages'
  document.body.appendChild(msgsEl)
  const api = new Function(
    'document',
    't',
    '_clearMessageIndices',
    'hideMultistreamBanner',
    'switchTab',
    'liveTarget',
    'cleanup',
    `${MGMT}
     function render(msgsEl) {${BRANCH}
     }
     return { render, renderPasteListForm }`,
  )(
    document,
    (k) => k,
    () => {},
    () => {},
    () => {},
    () => 'live',
    {
      raf: (fn) => frames.push(fn),
      setTimeout: () => 0,
      clearTimeout: () => {},
      addEventListener: (el, ev, fn) => el.addEventListener(ev, fn),
    },
  )
  // the next frame: everything queued with cleanup.raf runs
  const frame = () => {
    for (const fn of frames.splice(0)) fn()
  }
  return { msgsEl, frame, ...api }
}

test('a second render leaves the form and what was typed into it', () => {
  const { msgsEl, render } = page()
  render(msgsEl)
  const input = msgsEl.querySelector('input')
  expect(input).toBeTruthy()
  input.value = 'half a na'
  render(msgsEl)
  render(msgsEl)
  expect(msgsEl.querySelector('input')).toBe(input)
  expect(input.value).toBe('half a na')
  expect(msgsEl.children.length).toBe(1)
})

test('the paste view is left up too, with its text', () => {
  const { msgsEl, render, renderPasteListForm } = page()
  render(msgsEl)
  renderPasteListForm(msgsEl)
  const box = msgsEl.querySelector('textarea')
  expect(box).toBeTruthy()
  box.value = 'one\ntwo'
  render(msgsEl)
  expect(msgsEl.querySelector('textarea')).toBe(box)
  expect(box.value).toBe('one\ntwo')
})

test('coming from a chat tab, the rows go and the form is drawn', () => {
  const { msgsEl, render } = page()
  const row = msgsEl.ownerDocument.createElement('div')
  row.className = 'hs-mc-msg'
  msgsEl.appendChild(row)
  render(msgsEl)
  expect(msgsEl.querySelector('.hs-mc-msg')).toBeNull()
  expect(msgsEl.querySelectorAll('input').length).toBe(3)
})

test('the form takes the caret one frame later, but never out of a field the reader chose', () => {
  const a = page()
  a.render(a.msgsEl)
  a.frame()
  const twitch = a.msgsEl.querySelector('input')
  expect(a.msgsEl.ownerDocument.activeElement).toBe(twitch)

  // a slow frame: they are in the kick field before it comes (real twitch, 11-17: the link
  // typed for kick was appended to the twitch name)
  const b = page()
  b.render(b.msgsEl)
  const kickB = b.msgsEl.querySelectorAll('input')[1]
  kickB.focus()
  b.frame()
  expect(b.msgsEl.ownerDocument.activeElement).toBe(kickB)
})

test('the edit form uses the same rule: no bare focus on a later frame is left', () => {
  expect(MGMT).not.toMatch(/raf\(\(\) => [\w.]+\.focus\(\)\)/)
  expect(MGMT.match(/cmgFocusFirst\(wrapper, twitch\.input\)/g)?.length).toBe(2)
})
