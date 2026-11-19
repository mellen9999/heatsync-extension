import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'

/**
 * The history backfill for a site's own chat is twitch's: the lines come from twitch's recent
 * messages and the rows are built in twitch's shape. It read the channel from the address with
 * a pattern a kick pop-out matches too (/popout/<name>/chat), so on kick.com/popout/x/chat the
 * twitch channel "x" was fetched and its lines put into kick's own list. On a slow line they
 * landed before kick's React had hydrated that list: React #418 on the pop-out, the page redrawn
 * client-side (github's runner every night, 7 of 8 loads on a 1.5mbit line, 11-18).
 *
 * Runs the real backfillChatHistory from src/content/content.js.
 */
const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'content', 'content.js'), 'utf8')
const a = SRC.indexOf('  let _backfillWait = null')
const b = SRC.indexOf('\n  // Find Twitch or Kick chat container', a)
if (a < 0 || b < 0) throw new Error('carve: backfillChatHistory')
const CODE = SRC.slice(a, b)

function page(url, listHtml) {
  const win = new Window({ url })
  win.document.body.innerHTML = listHtml
  const asked = []
  const list = win.document.querySelector('[data-list]')
  const run = new Function(
    'window',
    'document',
    'isKick',
    'findChatContainer',
    'chrome',
    'cleanup',
    'TWITCH_EXCLUDED_PATHS',
    'log',
    `${CODE}\n return backfillChatHistory`,
  )(
    win,
    win.document,
    win.location.hostname.includes('kick.com'),
    () => list,
    {
      runtime: {
        sendMessage: (msg, cb) => {
          asked.push(msg)
          cb(null) // the fetch fails: this test is about whether it is asked for at all
        },
      },
    },
    { trackObserver: (o) => o },
    new Set(['directory']),
    () => {},
  )
  return { run, asked, list }
}

const KICK_LIST =
  '<div id="chatroom-messages"><div class="no-scrollbar" data-list><div data-index="0">hi</div></div></div>'
const TWITCH_LIST = '<div class="chat-scrollable-area__message-container" data-list></div>'

test("a kick pop-out: no twitch history is asked for and nothing is put into kick's list", async () => {
  const p = page('https://kick.com/popout/somechannel/chat', KICK_LIST)
  const before = p.list.innerHTML
  await p.run()
  expect(p.asked).toEqual([])
  expect(p.list.innerHTML).toBe(before)
  expect(p.list.dataset.heatsyncBackfilled).toBeUndefined()
})

test('a kick channel page: the same', async () => {
  const p = page('https://kick.com/somechannel', KICK_LIST)
  await p.run()
  expect(p.asked).toEqual([])
})

test('a twitch pop-out still asks for its channel', async () => {
  const p = page('https://www.twitch.tv/popout/somechannel/chat', TWITCH_LIST)
  await p.run()
  expect(p.asked).toEqual([{ type: 'fetch_recent_messages', channel: 'somechannel' }])
})

test('a twitch channel page still asks for its channel', async () => {
  const p = page('https://www.twitch.tv/somechannel', TWITCH_LIST)
  await p.run()
  expect(p.asked).toEqual([{ type: 'fetch_recent_messages', channel: 'somechannel' }])
})
