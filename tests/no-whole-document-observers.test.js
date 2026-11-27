/**
 * A MutationObserver on the whole document is paid for by every mutation the host page makes: twitch
 * redraws chat rows, the player, ads and tooltips all day, and each of those queues a record (and runs
 * the callback) for every such observer, in every open tab. The MAP counted eight (D63). This guard
 * lists them in the open: a new one fails, and so does an entry that no longer matches code.
 *
 * Gone for good, so do not put them back: player-volume.js and youtube-keyboard-guard.js hear the
 * <video> itself (media events / the prototype), early-layout.js and kick-css-fix.js wait for a direct
 * child of <html> and never needed the subtree.
 *
 * Adding one? First try: the narrowest container the thing lives in (re-attach when navigation swaps
 * it), an event the page already fires, or no `subtree`. Only when none of those can see it, add it
 * below with the reason, and make its callback cheap (return before any querySelector).
 *
 * The scanner (tests/observer-scan.js) reads source, so it is proven on snippets first.
 */
import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { wholeDocObservers, wholeDocObserversIn } from './observer-scan.js'

const ROOT = join(import.meta.dir, '..')

// `file::target` -> how many call sites, and why the document is the only place that can see it.
// "bounded" = disconnects itself on a timer; "on mount" = disconnects the moment the thing mounts.
const ALLOWED = {
  'src/content/yt-data-bridge.js::document.documentElement': {
    why: 'the live_chat frame is nothing but chat: a row (also the pinned banner and the ticker, not only #items) is stamped the moment it inserts, or it is never stamped',
  },
  'src/multichat/chat-position.js::t': {
    why: 'the theatre flag sits on ancestors the platforms move (kick did in 1.7.31); attributes only, attributeFilter, class pre-filter, 5s poll as the backstop',
  },
  'src/multichat/kick-host.js::document.body': {
    why: 'waits for #injected-channel-player, which kick mounts at no fixed depth; disconnects on mount; the callback is one id lookup',
  },
  "src/multichat/kick-host.js::document.getElementById('__next') || document.body": {
    n: 2,
    why: 'bounded: the chatroom watch (15s) and the soft-nav reparent (4s); kick has no narrower ancestor present before the chatroom',
  },
  'src/multichat/main-tabs.js::document.documentElement': {
    why: 'waits for the late youtube chat frame, which youtube moves between #secondary and #below; disconnects on find and on abort; the callback is one id lookup',
  },
  'src/multichat/main.js::mountRoot': {
    why: 'bounded 15s, on mount: the kick chatroom waiter, on the app root when there is one',
  },
  'src/multichat/main.js::document.documentElement': {
    why: 'bounded 15s, on mount: the twitch chat room waiter, before the app root is known to hold the chat',
  },
  "src/multichat/share-callouts.js::document.getElementById('root') || document.body": {
    why: 'twitch draws the callout queue wherever the chat column lands; on the app root until one is seen, then on its parent; our own rows return early',
  },
  "src/multichat/twitch-host.js::document.getElementById('root') || document.documentElement": {
    n: 2,
    why: 'the persistent-player waiter (on mount, then the parent only) and the soft-nav reparent (bounded 4s), both on the app root',
  },
  'src/multichat/youtube-host.js::document.body': {
    why: 'waits for ytd-watch-flexy to mount on a youtube navigation; disconnects on mount; our own rows return early',
  },
}

const key = (h) => `${h.file}::${h.target}`

describe('whole-document subtree observers are listed, with a reason', () => {
  const found = wholeDocObservers(ROOT)
  const counts = {}
  for (const h of found) counts[key(h)] = (counts[key(h)] || 0) + 1

  test('every one in src/ is in the allowlist', () => {
    const fresh = Object.keys(counts).filter((k) => !ALLOWED[k])
    expect(fresh, 'a new whole-document observer — read the header of this file before adding it').toEqual([])
  })

  test('every allowlist entry still matches code, the same number of times', () => {
    const stale = Object.entries(ALLOWED)
      .filter(([k, v]) => (counts[k] || 0) !== (v.n || 1))
      .map(([k, v]) => `${k}: found ${counts[k] || 0}, listed ${v.n || 1}`)
    expect(stale, 'an observer moved or went away: update the list').toEqual([])
  })

  test('every entry says why', () => {
    for (const [k, v] of Object.entries(ALLOWED)) expect(v.why.length, k).toBeGreaterThan(30)
  })
})

describe('the scanner sees each way a whole document gets observed', () => {
  const t = (code) => wholeDocObserversIn(code).map((h) => h.target)

  test('the plain forms', () => {
    expect(t('new MutationObserver(f).observe(document.documentElement, { childList: true, subtree: true })')).toEqual([
      'document.documentElement',
    ])
    expect(t('o.observe(document.body, { subtree: true, attributes: true })')).toEqual(['document.body'])
    expect(t('o.observe(document, { childList: true, subtree: true })')).toEqual(['document'])
  })

  test('a fallback chain that can end on the document', () => {
    expect(t("o.observe(document.getElementById('root') || document.body, { subtree: true })")).toEqual([
      "document.getElementById('root') || document.body",
    ])
  })

  test('a target named once and observed later, an array of targets, options held in a const', () => {
    expect(t('const root = document.body\no.observe(root, { subtree: true })')).toEqual(['root'])
    expect(t('const ts = []\nts.push(document.body)\nfor (const x of ts) o.observe(x, { subtree: true })')).toEqual([
      'x',
    ])
    expect(t('const cfg = { childList: true, subtree: true }\no.observe(document.body, cfg)')).toEqual([
      'document.body',
    ])
  })

  test('what is fine stays fine', () => {
    // no subtree: a direct-child watch
    expect(t('o.observe(document.documentElement, { childList: true })')).toEqual([])
    // a container, however deep it is read from
    expect(t("o.observe(document.getElementById('hs-mc-messages'), { childList: true, subtree: true })")).toEqual([])
    expect(t("const el = document.querySelector('.chat')\no.observe(el, { subtree: true })")).toEqual([])
    expect(t('o.observe(document.head, { childList: true, subtree: true })')).toEqual([])
    // Resize/IntersectionObserver take no options
    expect(t('ro.observe(document.documentElement)')).toEqual([])
    // a comment is not code
    expect(t('// o.observe(document.body, { subtree: true })')).toEqual([])
    expect(t('/* o.observe(document.body, { subtree: true }) */')).toEqual([])
  })

  test('the scan is not vacuous', () => {
    // 16 stood here before the four were removed; far fewer would mean the scanner broke, not the code
    expect(wholeDocObservers(ROOT).length).toBeGreaterThanOrEqual(10)
  })
})
