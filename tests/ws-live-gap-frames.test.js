// Server frames the extension used to ignore, through the real worker: the
// frame in, what the tabs are told out.
import { afterEach, describe, expect, test } from 'bun:test'
import { bootSw, disposeAll } from './harness/sw.js'

afterEach(disposeAll)

const AUTH = { name: 'auth', value: 'tok-1', domain: 'heatsync.org' }
const boot = () => bootSw({ cookies: [AUTH], tabs: [{ id: 7, url: 'https://www.twitch.tv/kripp' }], sockets: 'open' })
const got = async (frame, type) => {
  const sw = await boot()
  sw.socket().receive(frame)
  await sw.settle()
  return sw.broadcasts(type).map((m) => m.message)
}

describe('worker -> tabs', () => {
  test('stream:sub becomes a stream_event the overlay renders', async () => {
    const [m] = await got({ type: 'stream:sub', platform: 'twitch', channel: 'kripp', user: 'Alice' }, 'stream_event')
    expect(m).toMatchObject({ eventType: 'stream:sub', platform: 'twitch', channel: 'kripp', user: 'Alice' })
  })
  test('message:approved / message:flagged reach the tabs shaped', async () => {
    const [a] = await got({ type: 'message:approved', data: { id: '4a' } }, 'message_moderated')
    expect(a.data).toEqual({ id: '4a', categories: [], flagged: false })
    const [f] = await got({ type: 'message:flagged', data: { id: '4a', categories: ['nsfw'] } }, 'message_moderated')
    expect(f.data).toEqual({ id: '4a', categories: ['nsfw'], flagged: true })
    expect(await got({ type: 'message:approved', data: { id: 'no spaces' } }, 'message_moderated')).toEqual([])
  })
  test('dm:message / dm:thread-update / dm:typing reach the tabs', async () => {
    const [d] = await got(
      {
        type: 'dm:message',
        threadId: 't1',
        message: { id: '9', sender_id: '42', sender_display_name: 'Alice', content: 'hi' },
      },
      'dm_thread_message',
    )
    expect(d.data).toMatchObject({ threadId: 't1', from_user_id: '42', from_display_name: 'Alice', content: 'hi' })
    const [u] = await got({ type: 'dm:thread-update', threadId: 't1', lastMessageAt: 'x' }, 'dm_thread_update')
    expect(u.data).toEqual({ threadId: 't1' })
    const [t] = await got({ type: 'dm:typing', threadId: 't1', userId: 42 }, 'dm_typing')
    expect(t.data).toEqual({ threadId: 't1', userId: '42' })
  })
})

describe('overlay', () => {
  test('a single sub renders as an event-sub line, gated on the sub toggle, named', async () => {
    const main = (await Bun.file(`${import.meta.dir}/../src/multichat/main.js`).text()).replace(/\r/g, '')
    expect(main).toMatch(
      /msg\.eventType === 'stream:sub'\) \{\s*\n\s*if \(!hermesToggles\?\.sub \|\| !msg\.user\) return\s*\n\s*text = .*mc_main_ev_subscribed.*\s*\n\s*eventClass = 'event-sub'/,
    )
  })
})
