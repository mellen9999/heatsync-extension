// Your own youtube line shows the moment you send (youtube takes ~2s to echo it). The row is DOM only
// — never in a buffer, never through the echo dedup — so it cannot be a second copy; every exit removes
// it. These paths run inside the host page and can't be imported, so they are guarded at the source level.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = (f) => readFileSync(join(import.meta.dir, '..', 'src', 'multichat', f), 'utf8')
const main = src('main.js')
const input = src('input.js')
const social = src('social.js')

describe('optimistic youtube send', () => {
  test('the sending row never enters a buffer or the dedup', () => {
    const body = main.slice(main.indexOf('function showYtSendingRow'), main.indexOf('function clearYtSendingRow'))
    expect(body).toContain('div.dataset.hsSending')
    expect(body).not.toMatch(/trackSentMessage|channelYtMessages|sortedInsert|persistYt|_indexMessageDiv/)
  })

  test('every exit removes it: echo, failure, rejection, timeout', () => {
    expect(main).toContain('cleanup.setTimeout(() => clearYtSendingRow(id), 10000)')
    expect(social).toMatch(/isSentEcho\(ytMsg\.text, 'youtube'\)\) return\n\s*claimYtSendingRow\(ytMsg\.text\)/)
    expect(input).toContain('if (result !== true) clearYtSendingRow(_synthId)')
    expect(input).toMatch(/yt-only send rejected[^\n]*\n\s*clearYtSendingRow\(_synthId\)/)
  })

  test('only the youtube-only send shows one — a dual send already has the other platform echo', () => {
    expect(input.match(/showYtSendingRow\(/g)).toHaveLength(1)
    expect(input).toMatch(/if \(sendToYoutube && !sendToKick && !sendToTwitch\) \{\n\s*showYtSendingRow/)
  })

  test("a page that never subscribed to the watching stream does not take another tab's youtube chat", () => {
    expect(social).toContain("if (!ytSubscribedUrls.get('__live_yt_auto__')) return\n    const pageVid")
  })
})
