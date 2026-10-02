import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * hsConfirm is a full-pane panel (pane-panel.js): content in #hs-mc-messages, the
 * 2nd row (#hs-mc-subrow) holds just the shared ×, the buttons sit at the bottom.
 * Esc / × / cancel / tab switch close it and give the row back; Enter confirms.
 * Run for real against a happy-dom pane.
 */
const dir = join(import.meta.dir, '..', 'src', 'multichat')
const code = ['x-glyph.js', 'pane-panel.js'].map((f) => readFileSync(join(dir, f), 'utf8')).join('\n')

// happy-dom isn't an extension dependency; use the site checkout's copy when it is
// reachable (HS_SITE_DIR, as the build does) and skip loudly when it is not.
let Window = null
try {
  Window = (await import('happy-dom')).Window
} catch {
  try {
    const site = process.env.HS_SITE_DIR || join(import.meta.dir, '..', '..', 'heatsync')
    Window = (await import(join(site, 'node_modules', 'happy-dom', 'lib', 'index.js'))).Window
  } catch {}
}
const suite = Window ? describe : describe.skip

let win
let api
let repaints

beforeEach(() => {
  if (!Window) return
  win = new Window()
  const d = win.document
  d.body.innerHTML =
    '<div id="hs-mc-overlay"><div id="hs-mc-subrow"><button class="hs-mc-subcell" id="keep">chat</button></div><div id="hs-mc-messages"></div></div>'
  repaints = 0
  const prev = { document: globalThis.document }
  globalThis.document = d
  api = new Function(
    'document',
    'currentTab',
    'renderMessages',
    `${code}; return { hsConfirm, hsPanePanelOpen, hsPanePanelAbort }`,
  )(d, 'chan', () => repaints++)
  api._prev = prev
})
afterEach(() => {
  if (!Window) return
  globalThis.document = api._prev.document
})

const key = (k) =>
  win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
const row = () => win.document.getElementById('hs-mc-subrow')

suite('hsConfirm full-pane panel', () => {
  test('mounts in the message pane with the × alone in the row and buttons at the bottom', async () => {
    const p = api.hsConfirm('ban bob?', 'ban', ['spam'])
    const panel = win.document.querySelector('#hs-mc-messages > .hs-pane-panel')
    expect(panel).toBeTruthy()
    expect(panel.querySelector('.hs-pane-body').textContent).toContain('ban bob?')
    expect(panel.lastElementChild.className).toBe('hs-pane-actions')
    expect(panel.querySelectorAll('.hs-pane-actions button').length).toBe(2)
    expect(row().children.length).toBe(1)
    expect(row().firstElementChild.className).toContain('hs-x')
    expect(row().querySelector('svg')).toBeTruthy()
    expect(api.hsPanePanelOpen()).toBe(true)
    key('Escape')
    await p
  })

  test('Esc cancels and restores the row', async () => {
    const p = api.hsConfirm('x?')
    key('Escape')
    expect(await p).toEqual({ ok: false, reason: '' })
    expect(win.document.getElementById('keep')).toBeTruthy()
    expect(win.document.querySelector('.hs-pane-panel')).toBeNull()
    expect(api.hsPanePanelOpen()).toBe(false)
    expect(repaints).toBe(1)
  })

  test('× cancels and restores the row', async () => {
    const p = api.hsConfirm('x?')
    row().querySelector('.hs-x').click()
    expect((await p).ok).toBe(false)
    expect(win.document.getElementById('keep')).toBeTruthy()
  })

  test('Enter confirms and returns the chosen reason', async () => {
    const p = api.hsConfirm('ban?', 'ban', ['spam', 'bot'])
    win.document.querySelectorAll('.hs-mc-confirm-reason')[1].click()
    key('Enter')
    expect(await p).toEqual({ ok: true, reason: 'bot' })
  })

  test('the confirm button confirms, cancel cancels', async () => {
    let p = api.hsConfirm('a?')
    win.document.querySelector('.hs-mc-confirm-ok').click()
    expect((await p).ok).toBe(true)
    p = api.hsConfirm('b?')
    win.document.querySelector('.hs-mc-confirm-cancel').click()
    expect((await p).ok).toBe(false)
  })

  test('a tab switch (abort) cancels and leaves the row for the switch to repaint', async () => {
    const p = api.hsConfirm('x?')
    api.hsPanePanelAbort()
    expect((await p).ok).toBe(false)
    expect(win.document.querySelector('.hs-pane-panel')).toBeNull()
    expect(win.document.getElementById('keep')).toBeNull()
    expect(repaints).toBe(0)
  })

  test('no message pane = cancel, never a confirm nobody could see', async () => {
    win.document.getElementById('hs-mc-messages').remove()
    expect(await api.hsConfirm('x?')).toEqual({ ok: false, reason: '' })
  })
})
