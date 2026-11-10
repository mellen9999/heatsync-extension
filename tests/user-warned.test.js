// user-warned — a moderator warned this account; the panel shows the reason until read.
import { afterEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bootSw, disposeAll } from './harness/sw.js'

afterEach(disposeAll)
const ROOT = join(import.meta.dir, '..', 'src')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

const warn = async (frame) => {
  const sw = await bootSw({
    cookies: [{ name: 'auth', value: 'tok-1', domain: 'heatsync.org' }],
    tabs: [{ id: 7, url: 'https://www.twitch.tv/kripp' }],
    sockets: 'open',
  })
  sw.socket().receive(frame)
  await sw.settle()
  return sw.broadcasts('mod_warned').map((m) => m.message.reason)
}

test('the reason reaches the tabs, cleaned and bounded; an empty one says nothing', async () => {
  expect(await warn({ type: 'user-warned', reason: 'be nice\u0007', ts: 1 })).toEqual(['be nice'])
  expect(await warn({ type: 'user-warned', reason: 'x'.repeat(900), ts: 1 })).toEqual(['x'.repeat(300)])
  expect(await warn({ type: 'user-warned', reason: '   ', ts: 1 })).toEqual([])
  expect(await warn({ type: 'user-warned', ts: 1 })).toEqual([])
})

test('the panel shows it as a long-lived notice with its own copy', () => {
  expect(read('multichat/social.js')).toContain(
    "HsNotifs.emit('mod-warning', { text: t('mc_notif_mod_warned', [msg.reason]) })",
  )
  expect(read('multichat/notifs.js')).toMatch(/registerType\('mod-warning', \{[\s\S]*timeout: 20000/)
  const en = JSON.parse(read('_locales/en/messages.json'))
  expect(en.mc_notif_mod_warned.message).toBe('a mod warned you: $REASON$')
})
