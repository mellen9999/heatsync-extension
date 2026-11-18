/**
 * The add and edit channel forms save through one rule set (mcChannelInputs).
 * The edit form used to lowercase and save what was typed: a pasted
 * https://kick.com/name link became a tab that never drew anything, and a new
 * name could take another tab's id or a reserved one (11-17).
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/multichat/channel-mgmt.js', import.meta.url), 'utf8')
const piece = (from, to) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)))
const code = [
  piece('function channelAddError(', '\n/**\n * Add many'),
  piece('function parseTwitchLoginValue(', '\n// One "<platform>'),
].join('\n')

function forms(channels) {
  return new Function('config', 'mcIsReservedTab', 'normalizeYtUrl', `${code}\nreturn mcChannelInputs`)(
    { channels },
    (id) => ['live', 'feed', 'settings', 'add'].includes(id),
    (u) => (u.includes('youtube.com') ? u : ''),
  )
}

test('a pasted link saves the name in it', () => {
  const ci = forms([])
  expect(ci('https://www.twitch.tv/XQC?ref=x', 'https://kick.com/Sxb/videos', '')).toMatchObject({
    twitchVal: 'xqc',
    kickVal: 'sxb',
    err: null,
  })
  expect(ci('@Shroud', '', '').twitchVal).toBe('shroud')
})

test('a link that is not the channel page still gives its channel', () => {
  const ci = forms([])
  // kick's popped-out chat saved a channel called "popout"
  expect(ci('', 'https://kick.com/popout/Sxb/chat', '')).toMatchObject({ kickVal: 'sxb', err: null })
  expect(ci('', 'kick.com/sxb/chatroom', '').kickVal).toBe('sxb')
  expect(ci('', 'https://player.kick.com/sxb', '').kickVal).toBe('sxb')
  expect(ci('https://www.twitch.tv/popout/xQc/chat?popout=', '', '')).toMatchObject({ twitchVal: 'xqc', err: null })
  expect(ci('https://www.twitch.tv/embed/xqc/chat?parent=x', '', '').twitchVal).toBe('xqc')
  expect(ci('https://www.twitch.tv/moderator/xqc', '', '').twitchVal).toBe('xqc')
  expect(ci('https://dashboard.twitch.tv/u/xqc/stream-manager', '', '').twitchVal).toBe('xqc')
  expect(ci('https://player.twitch.tv/?channel=xQc&parent=example.com', '', '')).toMatchObject({
    twitchVal: 'xqc',
    err: null,
  })
  expect(ci('player.twitch.tv/?parent=example.com&channel=xqc', '', '').twitchVal).toBe('xqc')
})

test('a link to a site page is refused, not saved as a channel of that name', () => {
  const ci = forms([])
  for (const link of [
    'https://www.twitch.tv/directory',
    'twitch.tv/videos/2301234567',
    'https://www.twitch.tv/popout',
    'https://www.twitch.tv/settings/profile',
  ])
    expect(ci(link, '', '').err, link).toBe('mc_invalid_name')
  for (const link of ['https://kick.com/browse', 'kick.com/category/just-chatting', 'https://kick.com/popout'])
    expect(ci('', link, '').err, link).toBe('mc_invalid_name')
  // typed bare, the same
  expect(ci('directory', '', '').err).toBe('mc_invalid_name')
  // a real name next to one of those words is its own name
  expect(ci('videosgames', 'clipsy', '')).toMatchObject({ twitchVal: 'videosgames', kickVal: 'clipsy', err: null })
})

test('a name no platform allows is refused', () => {
  const ci = forms([])
  expect(ci('not a name', '', '').err).toBe('mc_invalid_name')
  expect(ci('', 'kick.com', '').err).toBe('mc_invalid_name')
  expect(ci('', '', '').err).toBe('mc_enter_platform')
})

test('edit: its own names are fine, another tab’s are not', () => {
  const a = { id: 'xqc', twitch: 'xqc', kick: 'xqc', youtube: '' }
  const b = { id: 'kripp', twitch: 'nl_kripp', kick: '', youtube: '' }
  const ci = forms([a, b])
  expect(ci('xqc', 'xqc', '', a).err).toBe(null)
  expect(ci('nl_kripp', '', '', a).err).toBe('mc_twitch_exists')
  // a new kick name that is another tab's id
  expect(ci('', 'kripp', '', a).err).toBe('mc_channel_exists')
  // a reserved id
  expect(ci('live', '', '', a).err).toBe('mc_reserved_name')
  // and add (no self) still refuses a repeat
  expect(ci('xqc', '', '').err).toBe('mc_channel_exists')
})

test('every form saves parsed names: add, edit, the live tab’s platforms', () => {
  expect(src.match(/mcChannelInputs\(twitch\.input\.value, kick\.input\.value, yt\.input\.value/g)?.length).toBe(2)
  const live = piece('function renderLivePlatformsPane(', '\n// One T/K/Y')
  expect(live).toContain('parseTwitchLoginValue(twitch.input.value)')
  expect(live).toContain('mcKickNameOk(ki)')
  // the paste list too: no form tests a name against the charset alone
  expect(src.match(/MC_(TWITCH_LOGIN|KICK_SLUG)\.test\(/g)?.length).toBe(2)
  expect(src).not.toContain('twitch.input.value.trim().toLowerCase()')
})
