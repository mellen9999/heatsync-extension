import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { userSetMatches } from '../src/lib/user-key.js'

/**
 * A mute strips the muted person's rows already on screen (applyMcMutes, run on
 * every render and when another tab's mute arrives). A reply row starts with the
 * reply bar, whose "@name" link is also .hs-mc-user: the author has to be read
 * past it, or muting bob blanks everyone who replies to bob and leaves bob's own
 * replies readable. The real functions run against happy-dom.
 */
const INPUT = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'input.js'), 'utf8')
const s = INPUT.indexOf('function applyMcMutes()')
const e = INPUT.indexOf('\n// logged-out first run', s)
const SRC = INPUT.slice(s, e)

let win
let prevDocument
beforeAll(() => {
  win = new Window()
  prevDocument = globalThis.document
  globalThis.document = win.document
})
afterAll(() => {
  globalThis.document = prevDocument
})

const row = (author, replyTo) =>
  `<div class="hs-mc-msg">${
    replyTo
      ? `<span class="hs-mc-reply-ctx">&#8618;<a class="hs-mc-user hs-mc-reply-user" data-username="${replyTo}" data-platform="twitch">@${replyTo}</a></span> `
      : ''
  }<a class="hs-mc-user" data-username="${author}" data-platform="twitch">${author}</a>: <span class="hs-mc-text">hi from ${author}</span></div>`

function run(muted, html) {
  document.body.innerHTML = html
  const mutedUsers = new Set(muted)
  const fn = new Function('mutedUsers', 'isUserMuted', `${SRC}\nreturn applyMcMutes`)(mutedUsers, (u, p) =>
    userSetMatches(mutedUsers, u, p),
  ) // the panel's own match: drops a leading @
  fn()
  return [...document.querySelectorAll('.hs-mc-msg')].map((r) => ({
    author: r.querySelector('.hs-mc-user:not(.hs-mc-reply-user)').textContent,
    muted: r.classList.contains('hs-mc-muted'),
  }))
}

describe('a mute strips the author, never the person replied to', () => {
  test('someone replying to a muted person keeps their row', () => {
    expect(run(['bob'], row('alice', 'bob'))).toEqual([{ author: 'alice', muted: false }])
  })

  test("a muted person's reply is stripped", () => {
    expect(run(['bob'], row('bob', 'alice'))).toEqual([{ author: 'bob', muted: true }])
  })

  test('plain rows: only the muted author', () => {
    expect(run(['bob'], row('bob') + row('carol'))).toEqual([
      { author: 'bob', muted: true },
      { author: 'carol', muted: false },
    ])
  })
})
