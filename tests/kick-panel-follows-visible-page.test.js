/**
 * Kick keeps the pages it left in the DOM, hidden by an inline display:none !important on the
 * copy's root, and draws the new page in a fresh copy with its own #channel-chatroom. Every
 * chatroom lookup must skip the hidden copies: the panel sat in one at 0x0 with no chat, and
 * /browse read as a channel page (s2 kick chain, 11-16). Runs the real kickPageHidden,
 * kickChatroom, kickChatroomLoose and rehomeKickPanel from src/multichat/kick-host.js.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'kick-host.js'), 'utf8')
const fn = (name) => {
  const s = SRC.indexOf(`function ${name}(`)
  if (s === -1) throw new Error(`not found: ${name}`)
  return SRC.slice(s, SRC.indexOf('\n}\n', s) + 3)
}

let win
afterEach(() => win?.happyDOM.close())

/** Kick's layout: page copies side by side, the panel beside the first copy's chatroom. */
function kickPage(newPage = '<div id="channel-chatroom"></div>') {
  win = new Window()
  const document = win.document
  document.body.innerHTML = `
    <div id="old" class="page"><div class="col"><div id="channel-chatroom"></div><div id="hs-mc-container"></div></div></div>
    <div id="new" class="page"><div class="col">${newPage}</div></div>`
  const calls = []
  const api = new Function(
    'document',
    'updateKickNoChannelClass',
    `${['kickPageHidden', 'kickChatroom', 'kickChatroomLoose', 'rehomeKickPanel'].map(fn).join('\n')}
     return { kickChatroom, kickChatroomLoose, rehomeKickPanel }`,
  )(document, () => calls.push('class'))
  const hideOld = () => document.getElementById('old').setAttribute('style', 'display: none !important;')
  const where = () => {
    const c = document.getElementById('hs-mc-container')
    return c.parentElement === document.body ? 'body' : c.closest('.page').id
  }
  return { document, api, hideOld, where, calls }
}

describe('kick: chatroom lookups skip the pages kick keeps hidden', () => {
  test('old copy hidden after the nav: the panel moves beside the new chatroom', () => {
    const { document, api, hideOld, where, calls } = kickPage()
    hideOld()
    expect(api.rehomeKickPanel()).toBe(true)
    expect(where()).toBe('new')
    expect(document.getElementById('hs-mc-container').previousElementSibling.id).toBe('channel-chatroom')
    expect(calls).toEqual(['class'])
  })

  test('the chatroom found is the one on screen, not the first in the document', () => {
    const { api, hideOld } = kickPage()
    hideOld()
    expect(api.kickChatroom().closest('.page').id).toBe('new')
  })

  test('left for /browse (no chatroom on screen): no chatroom, and the panel goes to the body', () => {
    const { api, hideOld, where } = kickPage('<div class="browse-grid"></div>')
    hideOld()
    expect(api.kickChatroom()).toBe(null)
    expect(api.kickChatroomLoose()).toBe(null)
    expect(api.rehomeKickPanel()).toBe(true)
    expect(where()).toBe('body')
  })

  test('chat the user hid (by class, not inline on the page) is not a hidden copy', () => {
    const { document, api, where } = kickPage()
    document.getElementById('hs-mc-container').classList.add('hs-hidden-by-user')
    expect(api.rehomeKickPanel()).toBe(false)
    expect(where()).toBe('old')
    expect(api.kickChatroom().closest('.page').id).toBe('old')
  })
})
