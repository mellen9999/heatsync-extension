/**
 * C16: a line you sent that did not land leaves a mark in the chat, like the site's rails:
 * refused = red, unconfirmed (no echo in time, it may have posted) = yellow. A line that posts is
 * just its echo, so there is no third mark. Runs the real send-mark.js on a happy-dom page with a
 * fake irc client; the wiring into the send tracker is read from input.js / main-messages.js.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { t } from './en-t.js'

const ml = (f) => readFileSync(join(import.meta.dir, '..', 'src', 'multichat', f), 'utf8')
const MARK = ml('send-mark.js')

let win
let heard
let removed
let irc
let kickBuf
let api

beforeEach(() => {
  win = new Window()
  heard = []
  removed = []
  const store = []
  irc = {
    channels: new Map([['chan', {}]]),
    _handleMsg: (m) => {
      heard.push(m)
      store.push(m)
    },
    getMessages: () => store,
  }
  kickBuf = []
  kickBuf.getAll = () => kickBuf
  const kickChat = { channels: new Map([['kslug', kickBuf]]), emit: (_e, m) => heard.push(m) }
  api = new Function(
    't',
    'irc',
    'kickChat',
    'document',
    'CSS',
    'removeRow',
    `${MARK}\nreturn { sendMarkKind, sendFailWhy, injectSendMark, retireSendMark }`,
  )(t, irc, kickChat, win.document, { escape: (s) => s }, (el) => removed.push(el))
})

const entry = (over = {}) => ({
  synthId: 's1',
  text: 'hello there',
  channel: 'Chan',
  platforms: ['twitch'],
  ...over,
})

describe('which mark', () => {
  test('no echo / unconfirmed reasons are yellow, everything else is red', () => {
    for (const r of ['no_echo', 'kick_unconfirmed', 'send_not_confirmed', 'bridge_timeout'])
      expect(api.sendMarkKind(r)).toBe('unconfirmed')
    for (const r of ['kick_not_logged_in', 'chat_disabled', 'send_failed', 'auth_failed'])
      expect(api.sendMarkKind(r)).toBe('refused')
  })

  test('the why is the toast words, naming the platform that never answered', () => {
    expect(api.sendFailWhy('no_echo', ['kick'])).toBe(t('mc_notif_r_no_echo', ['kick']))
    expect(api.sendFailWhy('kick_not_logged_in')).toBe(t('mc_notif_r_kick_not_logged_in'))
  })
})

describe('the row', () => {
  test('a refused send puts a red-rail notice in the room, saying why and what you said', () => {
    const id = api.injectSendMark(entry(), 'send_failed')
    expect(id).toBe('hs-synth-send-refused-s1')
    expect(heard).toHaveLength(1)
    expect(heard[0]).toMatchObject({ type: 'notice', sendMark: 'refused', channel: 'chan', isSynthetic: true, id })
    expect(heard[0].text.startsWith('✗ ')).toBe(true)
    expect(heard[0].text).toContain('hello there')
  })

  test('an unconfirmed send is the yellow one, marked ?', () => {
    api.injectSendMark(entry(), 'no_echo')
    expect(heard[0].sendMark).toBe('unconfirmed')
    expect(heard[0].text.startsWith('? ')).toBe(true)
  })

  test('a long line is cut, not dumped', () => {
    api.injectSendMark(entry({ text: 'x'.repeat(200) }), 'send_failed')
    expect(heard[0].text.length).toBeLessThan(140)
    expect(heard[0].text).toContain('…')
  })

  test('a kick room takes it through its own buffer', () => {
    const id = api.injectSendMark(entry({ channel: 'kslug', platforms: ['kick'] }), 'kick_not_logged_in')
    expect(id).toBeTruthy()
    expect(kickBuf).toHaveLength(1)
    expect(kickBuf[0].platform).toBe('kick')
  })

  test('a room with no buffer gets nothing and no id (the toast stays)', () => {
    expect(api.injectSendMark(entry({ channel: 'nowhere' }), 'send_failed')).toBe('')
  })
})

describe('retire', () => {
  test('a late echo marks the notice resolved and pulls its row', () => {
    const e = entry()
    e.markId = api.injectSendMark(e, 'no_echo')
    const row = win.document.createElement('div')
    row.className = 'hs-mc-msg'
    row.dataset.msgId = e.markId
    win.document.body.appendChild(row)
    api.retireSendMark(e)
    expect(heard[0].resolved).toBe(true)
    expect(removed).toEqual([row])
    expect(e.markId).toBe('')
  })

  test('nothing to retire is fine', () => {
    expect(() => api.retireSendMark(entry())).not.toThrow()
  })
})

describe('wiring', () => {
  const INPUT = ml('input.js')
  test('a failed send leaves a mark; an echo or a retry retires it', () => {
    expect(INPUT).toContain('entry.markId = injectSendMark(entry, reason)')
    const confirm = INPUT.slice(INPUT.indexOf('function confirmPending('), INPUT.indexOf('function findPendingByEchoText('))
    expect(confirm).toContain('retireSendMark(entry)')
    const retry = INPUT.slice(INPUT.indexOf('function retryPendingSend('), INPUT.indexOf('function retryPendingSend(') + 400)
    expect(retry).toContain('retireSendMark(entry)')
  })
  test('the row paints with the rails, refusals from twitch included', () => {
    expect(ml('main-messages.js')).toContain("m.sendMark === 'refused'")
    expect(ml('auth-irc.js')).toContain("parsed.sendMark = 'refused'")
    expect(ml('styles/08-message-rows.css')).toContain('.hs-mc-send-unconfirmed')
  })
})
