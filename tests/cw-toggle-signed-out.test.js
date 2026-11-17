import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// a content toggle saves to the account; signed out the server answers 401.
// The pill rolls back and the reader is told to sign in, never "try again"
// (that toast promised a retry that can never work, 11-17)
const src = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'main-settings.js'), 'utf8')
const from = src.indexOf('async function _cwPatch(')
const to = src.indexOf('\n}\n', src.indexOf('function _cwRollback(')) + 3
const carved = src.slice(from, to)

function run(answers) {
  const toasts = []
  const saved = []
  const sent = []
  const asked = []
  const fn = new Function(
    'safeSendMessage',
    'setSetting',
    'showToast',
    't',
    'hsConfirm',
    'document',
    'browser',
    '_cwRepaintOwnFlagged',
    `${carved}\nreturn _cwPatch`,
  )(
    async (m) => {
      sent.push(m.path || m.type)
      return m.type === 'refresh_all' ? {} : answers.shift()
    },
    (k, v) => saved.push([k, v]),
    (msg, level) => toasts.push([msg, level]),
    (k) => k,
    async (q) => {
      asked.push(q)
      return { ok: false }
    },
    { querySelectorAll: () => [] },
    { storage: { local: { get: async () => ({}) } } },
    () => {},
  )
  return { fn, toasts, saved, sent, asked }
}
const def = { key: 'viewer_show_gore', cw: { serverBody: 'show_gore_emotes', noun: 'gore emotes setting' } }

test('signed out: rolls back and says sign in, not try again', async () => {
  const r = run([{ ok: false, status: 401, error: 'unauthorized' }])
  await r.fn(def, true, false)
  expect(r.saved).toEqual([['viewer_show_gore', false]])
  expect(r.toasts).toEqual([['mc_main_cw_signin', 'error']])
  expect(r.asked).toEqual([])
})

test('a real save failure still says try again', async () => {
  const r = run([{ ok: false, status: 500 }])
  await r.fn(def, true, false)
  expect(r.saved).toEqual([['viewer_show_gore', false]])
  expect(r.toasts).toEqual([['mc_main_cw_save_failed', 'error']])
})

test('a save that lands keeps the value and refreshes', async () => {
  const r = run([{ ok: true }])
  await r.fn(def, true, false)
  expect(r.saved).toEqual([])
  expect(r.toasts).toEqual([])
  expect(r.sent).toEqual(['/api/user/settings', 'refresh_all'])
})

test('every locale has the sign-in line', () => {
  const dir = join(import.meta.dir, '..', 'src', '_locales')
  for (const l of require('node:fs').readdirSync(dir)) {
    const m = JSON.parse(readFileSync(join(dir, l, 'messages.json'), 'utf8'))
    expect(m.mc_main_cw_signin?.message, l).toBeTruthy()
  }
})
