/**
 * A youtube mod action heatsync took shows its gray notice and lands in the mod log.
 *
 * Twitch and kick record mod notices in their chat handlers. YouTube actions
 * (delete / timeout / ban / unban, driven through youtube's own moderation flow)
 * never echo back through a chat handler, so they recorded nothing and showed
 * nothing: the mod log popout was blind to youtube.
 *
 * The injector (mod-toolbar.js) and the ingest (social.js) are lifted out of the
 * bundle-scope sources and run for real, against the real mod-log store
 * (mod-log.js) and the real en catalog.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createModLogStore } from '../src/multichat/mod-log.js'
import { t } from './en-t.js'

const read = (f) => readFileSync(join(import.meta.dir, '..', 'src', 'multichat', f), 'utf8')
// a top-level function in a flat bundle-scope file closes on a column-0 brace
const fn = (src, sig) => {
  const at = src.indexOf(sig)
  if (at === -1) throw new Error(`not found: ${sig}`)
  return src.slice(at, src.indexOf('\n}\n', at) + 3)
}
const MOD = read('mod-toolbar.js')
const SOCIAL = read('social.js')
const LIFTED = [
  fn(MOD, 'function _modNoticeFields('),
  MOD.slice(MOD.indexOf('const YT_TIMEOUT_SEC'), MOD.indexOf('\n', MOD.indexOf('const YT_TIMEOUT_SEC')) + 1),
  fn(MOD, 'function _injectYoutubeModNotice('),
  fn(SOCIAL, 'function ingestYtModNotice('),
].join('\n')

function setup({ self = 'modname' } = {}) {
  const log = []
  const modLogStore = createModLogStore({ log, storage: () => null, setTimer: () => 0, clearTimer: () => {} })
  const channelYtMessages = new Map([
    ['c1', [{ id: 'm1', user: 'Alice', text: 'spam', channel: 'streamer', hsPaintUid: 'yt_UCaaaaaaaaaaaaaaaaaaaaaa' }]],
  ])
  const committed = []
  const greyed = []
  const api = new Function(
    't',
    'modLogStore',
    'channelYtMessages',
    'commitPacedYtMsg',
    'applyYtDeletion',
    'ytSelfName',
    `${LIFTED}\nreturn { inject: _injectYoutubeModNotice }`,
  )(
    t,
    modLogStore,
    channelYtMessages,
    (tab, m) => committed.push([tab, m]),
    (d) => greyed.push(d),
    () => self,
  )
  return { ...api, log, committed, greyed }
}

describe('youtube mod notices', () => {
  test('a ban: gray notice in the row’s own tab, in the mod log, the author greyed', () => {
    const s = setup()
    s.inject({ action: 'ban', target: '@Alice', msgId: 'm1' })
    expect(s.committed).toHaveLength(1)
    const [tab, notice] = s.committed[0]
    expect(tab).toBe('c1')
    expect(notice).toMatchObject({
      type: 'notice',
      noticeType: 'ban_success',
      platform: 'youtube',
      channel: 'streamer',
    })
    expect(notice.systemMsg).toBe('modname banned Alice')
    expect(s.log).toHaveLength(1)
    expect(s.log[0]).toMatchObject({ action: 'ban', target: 'alice', actor: 'modname', platform: 'youtube' })
    expect(s.greyed).toEqual([{ authorChannelIds: ['UCaaaaaaaaaaaaaaaaaaaaaa'] }])
  })

  test('a delete greys that one message; a timeout logs youtube’s five minutes', () => {
    const s = setup()
    s.inject({ action: 'delete', target: 'alice', msgId: 'm1' })
    s.inject({ action: 'timeout', target: 'alice', msgId: 'm1' })
    expect(s.greyed[0]).toEqual({ messageIds: ['m1'] })
    expect(s.log.map((e) => e.action)).toEqual(['delete', 'timeout'])
    expect(s.log[1].durationSec).toBe(300)
  })

  test('no signed-in youtube name: the anonymous line, not a twitch name or the target', () => {
    const s = setup({ self: '' })
    s.inject({ action: 'ban', target: 'alice', msgId: 'm1' })
    expect(s.committed[0][1].systemMsg).toBe('alice was permanently banned')
    expect(s.log[0].actor).toBe('')
  })

  test('a row no longer buffered: nothing is logged or shown', () => {
    const s = setup()
    s.inject({ action: 'ban', target: 'alice', msgId: 'gone' })
    expect(s.committed).toEqual([])
    expect(s.log).toEqual([])
  })
})
