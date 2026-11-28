/**
 * In a popout window the window IS the chat, so the tab strip's collapse button (the `>` that docks the
 * panel away) has nothing to collapse: toggleChatHidden() returns at once on a popout. The strip hid it
 * with a plain `display: none`, but every util button sets `display: inline-block !important`, so the rule
 * never applied and the `>` showed in every twitch, kick and youtube popout window — and did nothing when
 * clicked. Real stylesheet, real cascade (happy-dom), popout and normal page.
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'

const STYLES = join(import.meta.dir, '..', 'src', 'multichat', 'styles')
const css = readdirSync(STYLES)
  .filter((f) => f.endsWith('.css'))
  .sort()
  .map((f) => readFileSync(join(STYLES, f), 'utf8'))
  .join('\n')

function displayOf(bodyClass, id) {
  const win = new Window({ url: 'https://www.twitch.tv/popout/x/chat' })
  const doc = win.document
  const style = doc.createElement('style')
  style.textContent = css
  doc.head.appendChild(style)
  doc.body.className = bodyClass
  doc.body.innerHTML = `<div id="hs-mc-tabbar">
    <button id="hs-mc-collapse-btn" class="hs-mc-tab hs-mc-util-btn" data-tab="collapse"></button>
    <button id="hs-mc-settings-btn" class="hs-mc-tab hs-mc-util-btn" data-tab="settings"></button></div>`
  return win.getComputedStyle(doc.getElementById(id)).display
}

describe('popout window tab strip', () => {
  test('the collapse button is gone in a popout window', () => {
    expect(displayOf('hs-platform-twitch hs-popout hs-tabs-top', 'hs-mc-collapse-btn')).toBe('none')
    expect(displayOf('hs-platform-kick hs-popout hs-tabs-top', 'hs-mc-collapse-btn')).toBe('none')
    expect(displayOf('hs-platform-yt hs-popout hs-tabs-top', 'hs-mc-collapse-btn')).toBe('none')
  })
  test('it is still there on a normal page, and the other util buttons stay in a popout', () => {
    expect(displayOf('hs-platform-twitch hs-chat-right hs-tabs-top', 'hs-mc-collapse-btn')).toBe('inline-block')
    expect(displayOf('hs-platform-twitch hs-popout hs-tabs-top', 'hs-mc-settings-btn')).toBe('inline-block')
  })
})
