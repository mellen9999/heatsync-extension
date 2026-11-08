import { expect, test } from 'bun:test'
import { classifyYtMembership, classifyYtRendererType, parseYtGiftCount } from '../src/lib/utils.js'

// ── classifyYtRendererType ────────────────────────────────────────────────────
// Tag names verified against src/content/youtube-content.js's SUPPORTED_RENDERERS
// allowlist + real yt-live-chat DOM renderer tags.

test('classifyYtRendererType: text message renderer falls to default text type', () => {
  expect(classifyYtRendererType('YT-LIVE-CHAT-TEXT-MESSAGE-RENDERER')).toBe('text')
})

test('classifyYtRendererType: paid message renderer is superchat', () => {
  expect(classifyYtRendererType('YT-LIVE-CHAT-PAID-MESSAGE-RENDERER')).toBe('superchat')
})

test('classifyYtRendererType: paid sticker renderer is supersticker', () => {
  expect(classifyYtRendererType('YT-LIVE-CHAT-PAID-STICKER-RENDERER')).toBe('supersticker')
})

test('classifyYtRendererType: membership item renderer is membership', () => {
  expect(classifyYtRendererType('YT-LIVE-CHAT-MEMBERSHIP-ITEM-RENDERER')).toBe('membership')
})

test('classifyYtRendererType: gift purchase announcement renderer is giftpurchase', () => {
  expect(classifyYtRendererType('YT-LIVE-CHAT-SPONSORSHIPS-GIFT-PURCHASE-ANNOUNCEMENT-RENDERER')).toBe('giftpurchase')
})

test('classifyYtRendererType: gift redemption announcement renderer is giftredemption', () => {
  expect(classifyYtRendererType('YT-LIVE-CHAT-SPONSORSHIPS-GIFT-REDEMPTION-ANNOUNCEMENT-RENDERER')).toBe(
    'giftredemption',
  )
})

test('classifyYtRendererType: sponsorships header renderer is giftheader', () => {
  expect(classifyYtRendererType('YT-LIVE-CHAT-SPONSORSHIPS-HEADER-RENDERER')).toBe('giftheader')
})

test('classifyYtRendererType: unknown/deleted-message renderer falls to default text type', () => {
  expect(classifyYtRendererType('YT-LIVE-CHAT-DELETED-MESSAGE-RENDERER')).toBe('text')
  expect(classifyYtRendererType('')).toBe('text')
  expect(classifyYtRendererType(undefined)).toBe('text')
})

// ── classifyYtMembership ──────────────────────────────────────────────────────

test('classifyYtMembership: welcome text is a new-member join', () => {
  expect(classifyYtMembership('Welcome to Tier 2!')).toBe('join')
  expect(classifyYtMembership('welcome to the channel!')).toBe('join')
})

test('classifyYtMembership: "member for N months/years" is a milestone', () => {
  expect(classifyYtMembership('Member for 11 months')).toBe('milestone')
  expect(classifyYtMembership('Member for 2 years')).toBe('milestone')
})

test('classifyYtMembership: bare duration mention without "member for" still counts as milestone', () => {
  expect(classifyYtMembership('6 months as a member')).toBe('milestone')
})

test('classifyYtMembership: empty/unrecognized text defaults to join (new member is the common case)', () => {
  expect(classifyYtMembership('')).toBe('join')
  expect(classifyYtMembership(null)).toBe('join')
  expect(classifyYtMembership(undefined)).toBe('join')
  expect(classifyYtMembership('some unrelated header text')).toBe('join')
})

test('classifyYtMembership: is case-insensitive', () => {
  expect(classifyYtMembership('WELCOME TO THE CLUB')).toBe('join')
  expect(classifyYtMembership('MEMBER FOR 3 YEARS')).toBe('milestone')
})

// ── parseYtGiftCount ───────────────────────────────────────────────────────────

test('parseYtGiftCount: extracts count from "gifted N ... memberships"', () => {
  expect(parseYtGiftCount('CoolViewer gifted 5 Channel memberships')).toBe(5)
  expect(parseYtGiftCount('CoolViewer gifted 25 Tier 3 memberships')).toBe(25)
})

test('parseYtGiftCount: falls back to any embedded number when "gifted N" pattern is absent', () => {
  expect(parseYtGiftCount('shared 3 gift memberships')).toBe(3)
})

test('parseYtGiftCount: singular phrasing with no number defaults to 1', () => {
  expect(parseYtGiftCount('CoolViewer gifted a membership')).toBe(1)
})

test('parseYtGiftCount: empty/missing text defaults to 1', () => {
  expect(parseYtGiftCount('')).toBe(1)
  expect(parseYtGiftCount(null)).toBe(1)
  expect(parseYtGiftCount(undefined)).toBe(1)
})

test('parseYtGiftCount: zero or negative-looking numbers still coerce to a sane minimum of 1', () => {
  expect(parseYtGiftCount('gifted 0 memberships')).toBe(1)
})
