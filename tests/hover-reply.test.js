import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SETTINGS } from '../src/lib/settings-schema.js'

/**
 * hoverReply: opt-in ↪ on the hovered row, default OFF. hover-reply.js runs for
 * real against a happy-dom document; wiring checks read the source. The row
 * menu and the button share rowReplyState, so they reach the same rows.
 */
const ROOT = join(import.meta.dir, '..')
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8')
const SRC = read('src', 'multichat', 'hover-reply.js')
const INPUT = read('src', 'multichat', 'input.js')
const MAIN = read('src', 'multichat', 'main.js')

let Window = null
try {
  Window = (await import('happy-dom')).Window
} catch {
  try {
    const site = process.env.HS_SITE_DIR || join(ROOT, '..', 'heatsync')
    Window = (await import(join(site, 'node_modules', 'happy-dom', 'lib', 'index.js'))).Window
  } catch {}
}
const suite = Window ? describe : describe.skip

let win
let api
let replies
let ctl

function mount() {
  const d = win.document
  d.body.innerHTML = `<div id="hs-mc-messages">
    <div class="hs-mc-msg" data-msg-id="m1" data-msg-user="alice" data-msg-channel="chan" data-msg-platform="twitch"><span class="x">hi</span></div>
    <div class="hs-mc-msg"><span class="x">no id</span></div></div>`
  ctl = new AbortController()
  const state = { enabled: false }
  const make = new Function(
    'document',
    'mcSignal',
    'setReplyState',
    't',
    'state',
    `${SRC}
    var hoverReplyEnabled = false
    Object.defineProperty(state, 'enabled', { get: () => hoverReplyEnabled, set: (v) => { hoverReplyEnabled = v; if (!v) hoverReplyOff() } })
    return { initHoverReply, rowReplyState, state }`,
  )
  api = make(
    d,
    ctl.signal,
    (s) => replies.push(s),
    (k) => k,
    state,
  )
  api.initHoverReply()
  return d
}
const over = (el, type = 'mouse') =>
  el.dispatchEvent(new win.PointerEvent('pointerover', { bubbles: true, pointerType: type }))

suite('hoverReply', () => {
  beforeEach(() => {
    win = new Window()
    replies = []
  })
  afterEach(() => {
    ctl?.abort()
    win.close()
  })

  test('schema: a synced bool, default off, bridged to hoverReplyEnabled, no host filter', () => {
    const def = SETTINGS.find((s) => s.key === 'hoverReply')
    expect(def.type).toBe('bool')
    expect(def.default).toBe(false)
    expect(def.scope).toBe('sync')
    expect(def.hosts).toBeUndefined()
    expect(MAIN).toContain('hoverReplyEnabled: {')
  })

  test('off by default: hovering a row puts no button in the DOM', () => {
    const d = mount()
    over(d.querySelector('.x'))
    expect(d.querySelector('.hs-mc-hover-reply')).toBeNull()
  })

  test('on: hover shows it; click starts the same reply the menu does; id-less rows get none', () => {
    const d = mount()
    api.state.enabled = true
    over(d.querySelectorAll('.x')[1])
    expect(d.querySelector('.hs-mc-hover-reply')).toBeNull()
    over(d.querySelector('.x'))
    const btn = d.querySelector('.hs-mc-msg > .hs-mc-hover-reply')
    expect(btn).not.toBeNull()
    btn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
    expect(replies).toEqual([{ msgId: 'm1', user: 'alice', channel: 'chan', platform: 'twitch' }])
    expect(replies[0]).toEqual(api.rowReplyState(d.querySelector('.hs-mc-msg')))
  })

  test('touch never summons it', () => {
    const d = mount()
    api.state.enabled = true
    over(d.querySelector('.x'), 'touch')
    expect(d.querySelector('.hs-mc-hover-reply')).toBeNull()
  })

  test('toggled live: appears and disappears without a reload', () => {
    const d = mount()
    api.state.enabled = true
    over(d.querySelector('.x'))
    expect(d.querySelectorAll('.hs-mc-hover-reply').length).toBe(1)
    api.state.enabled = false
    expect(d.querySelector('.hs-mc-hover-reply')).toBeNull()
    over(d.querySelector('.x'))
    expect(d.querySelector('.hs-mc-hover-reply')).toBeNull()
  })

  test('the menu and the button read one source, wired at init', () => {
    expect(INPUT).toContain('rowReplyState(msg, username)')
    expect(INPUT).toContain('initHoverReply()')
    expect(SRC).toContain('rowReplyState(btn.closest')
    expect(read('build.js')).toContain("'hover-reply.js'")
  })
})
