/**
 * Kick keeps the page it left in the DOM, hidden (display:none !important), and draws the
 * new page in a fresh copy with its own #channel-chatroom. The panel must end up beside the
 * chatroom on screen, never in the hidden copy (s2 kick chain, 11-16: panel 0x0, no chat).
 * Runs the real kickVisibleChatroom / rehomeKickPanel from src/multichat/kick-host.js.
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

/** Two page copies like kick's, the panel beside the first one's chatroom. */
function kickPage() {
  win = new Window()
  const document = win.document
  // a node draws when no ancestor (or itself) is display:none
  win.Element.prototype.checkVisibility = function () {
    for (let e = this; e; e = e.parentElement) if (e.style?.display === 'none') return false
    return true
  }
  document.body.innerHTML = `
    <div id="old" class="page"><div class="col"><div id="channel-chatroom"></div><div id="hs-mc-container"></div></div></div>
    <div id="new" class="page"><div class="col"><div id="channel-chatroom"></div></div></div>`
  const calls = []
  const api = new Function(
    'document',
    'updateKickNoChannelClass',
    `${fn('kickShown')}\n${fn('kickVisibleChatroom')}\n${fn('rehomeKickPanel')}\nreturn { kickVisibleChatroom, rehomeKickPanel }`,
  )(document, () => calls.push('class'))
  const panelPage = () => document.getElementById('hs-mc-container').closest('.page').id
  return { document, api, panelPage, calls }
}

describe('kick: the panel follows the page on screen', () => {
  test('old copy hidden after the nav: the panel moves beside the new chatroom', () => {
    const { document, api, panelPage, calls } = kickPage()
    document.getElementById('old').setAttribute('style', 'display: none !important;')
    expect(api.rehomeKickPanel()).toBe(true)
    expect(panelPage()).toBe('new')
    expect(document.getElementById('hs-mc-container').previousElementSibling.id).toBe('channel-chatroom')
    expect(calls).toEqual(['class'])
  })

  test('the nav picks the chatroom on screen, not the first one in the document', () => {
    const { document, api } = kickPage()
    document.getElementById('old').style.display = 'none'
    expect(api.kickVisibleChatroom().closest('.page').id).toBe('new')
  })

  test('host on screen: nothing moves (a panel the user hid stays where it is)', () => {
    const { document, api, panelPage } = kickPage()
    document.getElementById('hs-mc-container').style.display = 'none' // chat hidden by the user
    expect(api.rehomeKickPanel()).toBe(false)
    expect(panelPage()).toBe('old')
  })

  test('both copies hidden (new page not drawn yet): stays put until one shows', () => {
    const { document, api, panelPage } = kickPage()
    document.getElementById('old').style.display = 'none'
    document.getElementById('new').style.display = 'none'
    expect(api.rehomeKickPanel()).toBe(false)
    expect(panelPage()).toBe('old')
  })
})
