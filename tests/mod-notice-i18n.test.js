// the mod-toolbar's synthetic chat lines and the tab-mode hint are words a
// user reads — they come from the locale files, not from string literals.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', 'src')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')
const en = JSON.parse(read('_locales/en/messages.json'))

/** the chrome.i18n contract for the en catalog: $NAME$ → its placeholder's $n → subs[n-1] */
function t(key, subs = []) {
  const e = en[key]
  if (!e) throw new Error(`no en key ${key}`)
  return e.message.replace(/\$([A-Z_]+)\$/g, (_, n) => {
    const c = e.placeholders?.[n.toLowerCase()]?.content ?? ''
    return c.replace(/\$(\d)/, (_m, i) => subs[Number(i) - 1] ?? '')
  })
}

function noticeFields() {
  const src = read('multichat/mod-toolbar.js')
  const at = src.indexOf('function _modNoticeFields')
  const end = src.indexOf('// Twitch — route through irc._handleMsg')
  return new Function('t', `${src.slice(at, end)}\nreturn _modNoticeFields`)(t)
}

test('mod notices read the same in english as before, from the catalog', () => {
  const f = noticeFields()
  expect(f('ban', 'mod', 'bob').systemMsg).toBe('mod banned bob')
  expect(f('timeout', 'mod', 'bob', 30).systemMsg).toBe('mod timed out bob for 30s')
  expect(f('unban', 'mod', 'bob').systemMsg).toBe('mod unbanned bob')
  expect(f('delete', 'mod', 'bob').systemMsg).toBe('mod deleted a message from bob')
  expect(f('delete', 'mod', '').systemMsg).toBe('mod deleted a message')
  expect(f('delete', '', '').systemMsg).toBe('message deleted')
})

test('no english sentence left in the notice builder or the tab-mode hint', () => {
  const mod = read('multichat/mod-toolbar.js')
  const body = mod.slice(
    mod.indexOf('function _modNoticeFields'),
    mod.indexOf('// Twitch — route through irc._handleMsg'),
  )
  expect(body).not.toMatch(/systemMsg: [^\n]*[`'"][^`'"]*\b(banned|timed out|deleted)\b/)
  expect(read('multichat/tab-mode.js')).not.toContain('jk move')
})

test('tab-mode hint carries position, total and label', () => {
  expect(t('mc_tabmode_hint', ['2', '5', 'chat'])).toBe(
    '2/5 chat · jk move · enter open · JK reorder · d close · a add · esc',
  )
})
