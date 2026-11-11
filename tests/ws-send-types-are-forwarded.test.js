// Every frame type a page script hands the background as ws_send must be on the
// background's allowlist: anything else is dropped without a word, and the
// extension's own twitch [H] tag was (chat:origin_tag, 2026-11-11).
import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const walk = (d) =>
  readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]))
const pageFiles = walk('src').filter((f) => f.endsWith('.js') && !f.startsWith(join('src', 'background')))
const bg = readFileSync('src/background/07-handle-message.js', 'utf8')
const allow = bg.match(/const allowedWsTypes = \[([\s\S]*?)\]/)?.[1] ?? ''
const allowed = new Set([...allow.matchAll(/'([^']+)'/g)].map((m) => m[1]))

describe('ws_send frame types', () => {
  const sent = new Set()
  for (const f of pageFiles) {
    for (const m of readFileSync(f, 'utf8').matchAll(/type:\s*'ws_send',\s*data:\s*\{\s*type:\s*'([^']+)'/g))
      sent.add(m[1])
  }
  it('the scan finds the allowlist and the senders (guards the guard)', () => {
    expect(allowed.size).toBeGreaterThan(5)
    expect(sent.has('channel:join')).toBe(true)
    expect(sent.has('chat:origin_tag')).toBe(true)
  })
  it('every type a page sends is one the background forwards', () => {
    expect([...sent].filter((t) => !allowed.has(t))).toEqual([])
  })
})
