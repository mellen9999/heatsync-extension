// The server answers an offline youtube channel with status `not-live` — its
// commonest answer, since tabs auto-guess a youtube handle. The tab dot only
// cleared on `ended` / `error`, so a youtube-only tab lit by an earlier
// `connected` kept its red dot through every later "not live" until a reload.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SOCIAL = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'social.js'), 'utf8')

test('a not-live answer turns a youtube-only tab dark', () => {
  const at = SOCIAL.indexOf("if (msg.type === 'youtube_status')")
  const block = SOCIAL.slice(at, SOCIAL.indexOf('upsertNotice', at))
  expect(block).toMatch(/msg\.status === 'not-live'\)\s*\{\s*if \(isYtOnly\) tabEl\.dataset\.live = 'false'/)
})
