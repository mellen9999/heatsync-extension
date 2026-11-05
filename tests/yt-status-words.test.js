import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const SOCIAL = readFileSync(new URL('../src/multichat/social.js', import.meta.url), 'utf8')
const EN = JSON.parse(readFileSync(new URL('../src/_locales/en/messages.json', import.meta.url), 'utf8'))

describe('youtube status rows in plain words', () => {
  test('chat-off and no-slot each get a row, clearing on connected', () => {
    expect(SOCIAL).toContain("msg.status === 'chat-off' || msg.status === 'no-slot'")
    expect(SOCIAL).toContain("'mc_social_yt_chat_off'")
    expect(SOCIAL).toContain("'mc_social_yt_no_slot'")
    // 'connected' branch removes the one status row
    const i = SOCIAL.indexOf("if (msg.status === 'connected' || msg.status === 'ended') {")
    expect(SOCIAL.slice(i, i + 1400)).toContain("querySelectorAll('.hs-mc-empty[data-hs-yt-status]')")
  })
  test('copy is lowercase and terse', () => {
    expect(EN.mc_social_yt_chat_off.message).toBe('youtube: chat is off')
    expect(EN.mc_social_yt_no_slot.message).toBe('youtube: relay is full, retrying later')
  })
})
