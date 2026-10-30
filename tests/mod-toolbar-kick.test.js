import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('../src/multichat/mod-toolbar.js', import.meta.url), 'utf8')

test('purge is hidden on kick rows (kick cannot time out for 1s)', () => {
  const purge = SRC.slice(SRC.indexOf('  purge: {'), SRC.indexOf('  ban: {'))
  expect(purge).toContain('notKick: true')
  expect(SRC).toContain("if (ok && def.notKick && ctx.platform === 'kick') ok = false")
})

test('a kick delete notice names its message so the row dims', () => {
  const fn = SRC.slice(SRC.indexOf('function _injectKickModNotice'), SRC.indexOf('globalThis.__hsInjectModNotice'))
  expect(fn).toContain("targetMsgId: action === 'delete' ? msgId || '' : undefined")
})
