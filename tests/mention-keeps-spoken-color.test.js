// A mentioned chatter we have heard speak keeps their real platform color; the
// heatsync-picked color from the profile lookup must not repaint them (a twitch
// line keeps twitch's color — mirrors the site's resolveNameColor).
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = (f) => readFileSync(join(import.meta.dir, '..', 'src', 'multichat', f), 'utf8')

test('the profile lookup writes through setKnownColor, flagged native only for a twitch GQL color', () => {
  const body = src('input.js').split('function hsResolveUserColor(lower) {')[1].split('\nfunction ')[0]
  expect(body).toContain("setKnownColor(lower, c, undefined, 'twitch', native)")
  expect(body).toContain('native = !!c')
})

test('a resolved mention repaints with the known color first', () => {
  const m = src('main.js')
  expect(m).toContain('sanitizeColor(knownColors.get(lower) || c)')
  expect(m).toContain("setKnownColor(lower, knownColors.get(lower) || c || '#fff', resolvedUid, 'twitch', false)")
})

test('a linked twitch account resolves to its twitch color before the heatsync pick', () => {
  const body = src('input.js').split('function hsResolveUserColor(lower) {')[1].split('\nfunction ')[0]
  expect(body.indexOf('gql.twitch.tv')).toBeGreaterThan(-1)
  expect(body.indexOf('gql.twitch.tv')).toBeLessThan(body.indexOf('profile?.color'))
})

test('setKnownColor: a real twitch color is never overwritten by a non-native one', () => {
  const m = src('main.js')
  const start = m.indexOf('const _nativeTwitchColor = new Set()')
  const body = m.slice(start, m.indexOf('// Live username-color sync', start))
  const run = new Function(
    `const knownColors = new Map(), knownUserIds = new Map(); ${body}; return { set: setKnownColor, knownColors }`,
  )()
  run.set('mellen', '#ff8700', null, 'twitch')
  run.set('mellen', '#53fc18', null, 'kick') // kick speaker, same name
  run.set('mellen', '#d7ff00', null, 'twitch', false) // heatsync pick
  expect(run.knownColors.get('mellen')).toBe('#ff8700')
  run.set('bob', '#ffffff', null, 'twitch') // unset white is not native
  run.set('bob', '#d7ff00', null, 'twitch', false)
  expect(run.knownColors.get('bob')).toBe('#d7ff00')
})
