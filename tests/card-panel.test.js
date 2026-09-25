/**
 * The overlay full card (src/multichat/profile-card.js renderProfileCardView)
 * is the second extension surface migrated onto the shared card model/
 * renderer (see tests/card-tooltip.test.js for the first — the hover
 * tooltip). This pins the panel-only host hooks introduced for it:
 *   - pcBuildSocials: Kick bio socials → payload.socials
 *   - pcBuildSessionSheetRows: local session stats → ctx.extraSheet
 *   - pcBuildModGroups: per-channel mod actions → ctx.modGroups (pure data;
 *     card-render.js renders it, pcHandleModAction — tested via source
 *     invariants below — wires the real behavior)
 *   - the model + hsCardHtml('panel') call itself, and that every OLD
 *     .hs-pcard-* class this surface used to build by hand is gone (except
 *     the explicitly-kept close button / notes-section chrome, still on old
 *     CSS pending the cleanup pass).
 *
 * profile-card.js has top-level side effects and cannot be imported (house
 * pattern — see reply-name-opens-card.test.js, native-name-opens-current-
 * card.test.js); the pure builders below are extracted as source text and
 * evaluated for real, same technique as card-tooltip.test.js.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const CARD = readFileSync(join(ROOT, 'src', 'multichat', 'profile-card.js'), 'utf8')

function slice(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker)
  if (start === -1) throw new Error(`marker not found: ${startMarker}`)
  const end = src.indexOf(endMarker, start)
  if (end === -1) throw new Error(`end marker not found: ${endMarker}`)
  return src.slice(start, end)
}

describe('pcBuildSocials — Kick bio socials as payload.socials', () => {
  const src = slice(CARD, 'function pcBuildSocials(data) {', '\n// Native chat badges')
  const pcBuildSocials = new Function(`${src}\nreturn pcBuildSocials`)()

  test('null with no _kick_socials at all', () => {
    expect(pcBuildSocials({})).toBeNull()
    expect(pcBuildSocials(null)).toBeNull()
  })

  test('null when _kick_socials is present but every field is empty', () => {
    expect(pcBuildSocials({ _kick_socials: {} })).toBeNull()
  })

  test('builds a link entry per populated field', () => {
    const out = pcBuildSocials({ _kick_socials: { twitter: 'xqc', instagram: 'xqc' } })
    expect(out).toEqual([
      { label: 'twitter', href: 'https://twitter.com/xqc' },
      { label: 'instagram', href: 'https://instagram.com/xqc' },
    ])
  })

  test('youtube/facebook pass an already-absolute URL through unmodified', () => {
    const out = pcBuildSocials({ _kick_socials: { youtube: 'https://youtube.com/@xqc' } })
    expect(out).toEqual([{ label: 'youtube', href: 'https://youtube.com/@xqc' }])
  })

  test('discord has no canonical URL shape — renders as a labeled entry with no href', () => {
    const out = pcBuildSocials({ _kick_socials: { discord: 'xqc#0001' } })
    expect(out).toEqual([{ label: 'discord: xqc#0001' }])
    expect(out[0].href).toBeUndefined()
  })
})

describe('pcBuildSessionSheetRows — local session stats as ctx.extraSheet', () => {
  const src = slice(CARD, 'function pcBuildSessionSheetRows(username) {', '\n\n// Kick bio socials')
  const makeFn = (stats) => new Function('getUserSessionStats', `${src}\nreturn pcBuildSessionSheetRows`)(() => stats)

  test('empty when the user has no buffered messages', () => {
    const fn = makeFn({ count: 0, firstTime: null, channels: new Set() })
    expect(fn('nobody')).toEqual([])
  })

  test('always includes a msgs row when count > 0', () => {
    const fn = makeFn({ count: 12, firstTime: null, channels: new Set() })
    const rows = fn('x')
    expect(rows).toEqual([{ k: 'session-msgs', label: 'session', value: '12' }])
  })

  test('channels row only when more than one channel was seen', () => {
    const fn = makeFn({ count: 3, firstTime: null, channels: new Set(['a', 'b']) })
    const rows = fn('x')
    expect(rows.find((r) => r.k === 'session-channels')).toEqual({
      k: 'session-channels',
      label: 'channels',
      value: '2',
    })
  })
})

describe('pcBuildModGroups — mod actions as ctx.modGroups (pure data)', () => {
  const src = slice(CARD, 'function pcBuildModGroups(username) {', '\n\n// Fires a mod-action')

  function makeFn({ recent, isMod = true, isKickMod = true, selfUsername = 'viewer' } = {}) {
    return new Function(
      'getRecentMessagesFromUser',
      'currentUsername',
      'isModForSync',
      'isKickModForSync',
      `${src}\nreturn pcBuildModGroups`,
    )(
      () => recent || [],
      selfUsername,
      () => isMod,
      () => isKickMod,
    )
  }

  test('empty on your own profile — self-mod buttons are nonsense', () => {
    const fn = makeFn({ recent: [{ platform: 'twitch', channel: 'forsen', id: 'm1', user: 'viewer' }] })
    expect(fn('viewer')).toEqual([])
  })

  test('empty with no recent messages', () => {
    const fn = makeFn({ recent: [] })
    expect(fn('x')).toEqual([])
  })

  test('empty when you do not mod any channel the chatter posted in', () => {
    const fn = makeFn({ recent: [{ platform: 'twitch', channel: 'forsen', id: 'm1', user: 'x' }], isMod: false })
    expect(fn('x')).toEqual([])
  })

  test('one group per channel you mod, with the full action set', () => {
    const fn = makeFn({ recent: [{ platform: 'twitch', channel: 'forsen', id: 'm1', user: 'x' }] })
    const groups = fn('x')
    expect(groups).toHaveLength(1)
    expect(groups[0].channel).toBe('forsen')
    expect(groups[0].platform).toBe('twitch')
    expect(groups[0].msgId).toBe('m1')
    expect(groups[0].actions.map((a) => a.action)).toEqual([
      'delete',
      'timeout',
      'timeout',
      'timeout',
      'timeout',
      'timeout',
      'ban',
      'unban',
    ])
  })

  test('role grants (mod/vip) are twitch-only', () => {
    const twitchFn = makeFn({ recent: [{ platform: 'twitch', channel: 'forsen', id: 'm1', user: 'x' }] })
    expect(twitchFn('x')[0].roleActions.map((a) => a.kind)).toEqual(['mod', 'mod', 'vip', 'vip'])
    const kickFn = makeFn({ recent: [{ platform: 'kick', channel: 'xqc', id: 'm1', user: 'x' }] })
    expect(kickFn('x')[0].roleActions).toEqual([])
  })

  test('a message with no id disables the delete action, not the whole group', () => {
    const fn = makeFn({ recent: [{ platform: 'twitch', channel: 'forsen', id: null, user: 'x' }] })
    const del = fn('x')[0].actions.find((a) => a.action === 'delete')
    expect(del.disabled).toBe(true)
  })
})

describe('renderProfileCardView runs through the shared card pipeline (source invariants)', () => {
  test('builds the model via hsCardModel and renders variant panel', () => {
    const view = slice(CARD, 'function renderProfileCardView() {', '\n\n// No-heatsync-profile view')
    expect(view).toContain('hsCardModel(')
    expect(view).toContain("variant: 'panel'")
    expect(view).toContain('modGroups: pcBuildModGroups(username)')
    expect(view).toContain('pcBuildSessionSheetRows(username)')
    expect(view).toContain('socials: pcBuildSocials(data)')
    expect(view).toContain('renderBadges: () => pcRenderBadgesHtml(data, username)')
  })

  test('followage is fetched once per card open and folded into extraSheet, never DOM-patched', () => {
    const view = slice(CARD, 'function renderProfileCardView() {', '\n\n// No-heatsync-profile view')
    expect(view).toContain('...(activeProfileCard.followageRows || [])')
    expect(view).toContain('followageFetchedFor !== username')
    expect(view).toContain('computeFollowageRows(channelLogin, isSelfChannel, result)')
    expect(view).toContain('renderProfileCardView()') // re-render, not a sheet-row DOM patch
  })

  test('every old .hs-pcard-id/.hs-pcard-mod/.hs-pcard-actions DOM-building class is gone', () => {
    const view = slice(CARD, 'function renderProfileCardView() {', '\n\n// No-heatsync-profile view')
    expect(view).not.toMatch(/hs-pcard-(id|mod|actions|sheet|hero|avatar|body)\b/)
  })

  test('every hotkey (t k y h f w d @ m b +) still resolves to a real button lookup', () => {
    const handlers = slice(CARD, 'function setupProfileCardHandlers() {', '\n\n// Dispatches a click')
    for (const k of ['t', 'k', 'y', 'h', 'f', 'w', 'd', '@', 'm', 'b', '+', '=']) {
      expect(handlers).toContain(`'${k}'`)
    }
    expect(handlers).toContain('.hs-card-plat-link[data-tone=')
    expect(handlers).toContain('.hs-card-action[data-hs-card-action=')
  })

  test('pcHandleCardAction dispatches every action key to its existing toggle/nav function', () => {
    const fn = slice(CARD, 'function pcHandleCardAction(actionKey, _btn) {', '\n}\n')
    for (const call of [
      'pcToggleFollow(',
      'pcDoWhisper(',
      'pcDoDm(',
      'pcMention(',
      'pcToggleMute(',
      'pcToggleBlock(',
      'pcAddAsChannel(',
    ]) {
      expect(fn).toContain(call)
    }
  })

  test('addchannel is dispatched, even though it is not a card-model.js ACTION_DEFS key', () => {
    const fn = slice(CARD, 'function pcHandleCardAction(actionKey, _btn) {', '\n}\n')
    expect(fn).toContain("case 'addchannel':")
  })
})

describe('pcApplyBanner/pcApplyPronouns target the new .hs-card-* markup', () => {
  test('no function in this file still queries the old .hs-pcard-hero/-avatar/-id-text/-pronoun classes', () => {
    expect(CARD).not.toMatch(/hs-pcard-(hero|avatar|id-text|id-chips|pronoun)\b/)
  })

  test('accent is applied via the shared hsExtApplyAccent (CSSOM-at-mount, not style=)', () => {
    const fn = slice(CARD, 'async function pcApplyBanner(card, chain) {', '\n}\n')
    expect(fn).toContain('hsExtApplyAccent(root, banner.accent)')
    expect(fn).not.toContain('style.setProperty')
  })
})
