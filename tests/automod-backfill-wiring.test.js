/**
 * The AutoMod backfill has to travel the same pipe as a live hold.
 *
 * Held messages reach the extension two ways now — the websocket push, and the
 * pending list the watch call hands back on page load. Coercing the wire twice
 * is exactly how this codebase's other duplicated message pipelines drifted
 * (tests/handler-parity.test.js), and the backfill would be the copy nobody
 * notices is wrong: it is only exercised right after a reload. So both doors
 * must run the SAME normalizer, and the throttle that spares the keepalive
 * must not also swallow the one call a fresh page needs.
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const BG = readFileSync(join(import.meta.dir, '..', 'chrome', 'background.js'), 'utf8')
const QUEUE = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'automod-queue.js'), 'utf8')

test('background.js has exactly one hold normalizer', () => {
  expect(BG.match(/function normalizeAutomodHold\(/g) || []).toHaveLength(1)
})

test('the live push goes through it', () => {
  const live = BG.slice(BG.indexOf("case 'automod:hold'"), BG.indexOf("case 'automod:update'"))
  expect(live).toContain('normalizeAutomodHold(msg)')
  // and does not hand-roll the coercion a second time
  expect(live).not.toContain('Date.parse(msg.heldAt)')
})

test('the backfill goes through it too', () => {
  const watch = BG.slice(BG.indexOf('api/mod/automod-watch'))
  const body = watch.slice(0, watch.indexOf('automod_action'))
  expect(body).toContain('data?.pending')
  expect(body).toContain('.map(normalizeAutomodHold)')
})

test('a page asking for its backfill is not silenced by the keepalive throttle', () => {
  const gate = BG.slice(BG.indexOf('AUTOMOD_WATCH_THROTTLE_MS'), BG.indexOf('api/mod/automod-watch'))
  expect(gate).toContain('!message.wantPending')
})

test('the queue asks for the backfill once per channel, not on every sweep', () => {
  expect(QUEUE).toContain('_automodBackfilled')
  const sweep = QUEUE.slice(QUEUE.indexOf('async function automodSweep('))
  expect(sweep).toContain('wantPending')
  expect(sweep).toContain('injectPendingAutomodHolds(res.pending)')
})
