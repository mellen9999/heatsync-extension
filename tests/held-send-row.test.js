// A send held for mod approval says so, and stops saying so once THAT message posts.
//
// Reported by a chatter whose message sat in automod: "put whether or not your message is pending mod
// approval". The row has to stay true — never claim a hold after the message went out, and never retire
// because some OTHER message of yours went out — so it is matched on the held text, not on "you spoke".
// These paths run inside the host page and can't be imported, so they are guarded at the source level.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = (f) => readFileSync(join(import.meta.dir, '..', 'src', f), 'utf8')
const authIrc = src('multichat/auth-irc.js')
const irc = src('multichat/irc.js')
const main = src('multichat/main.js')
const en = JSON.parse(src('_locales/en/messages.json'))

describe('held send row', () => {
  test('the hold row names the send it is about, in house copy', () => {
    expect(authIrc).toContain("if (msgId === 'msg_rejected')")
    expect(authIrc).toContain('parsed.heldText = globalThis.__hsPendingTextByChannel')
    expect(en.mc_irc_notice_rejected.message).toMatch(/held for mod approval/)
  })

  test('only the echo of the same text retires it', () => {
    expect(irc).toContain('heldTextKey(m.heldText) === echoed')
    expect(irc).toContain('m.resolved = true')
  })

  test('a retired row leaves the screen now and on every re-render', () => {
    expect(main).toContain("m?.type === 'notice' && m.resolved")
    expect(main).toContain('msg.resolvedHolds')
  })
})
