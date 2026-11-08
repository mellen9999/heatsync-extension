import { describe, expect, test } from 'bun:test'
import { ytHasModItems, ytItemModEndpoint, ytItemText, ytMatchModAction, ytResolveModAction } from '../src/lib/utils.js'

// Fixtures model YouTube's live_chat get_item_context_menu response. A real mod
// gets Remove / Put user in timeout / Hide user / Unhide user (each with a
// moderate token) plus Report/Block; a non-mod gets only Report/Block. Verified
// live: a non-mod account returns exactly the Report (FLAG) item + one
// endpoint-less entry — see the moderation section of src/content/youtube-content.js.

const item = (icon, text, serviceEndpoint) => ({
  menuServiceItemRenderer: {
    icon: icon ? { iconType: icon } : undefined,
    text: { runs: [{ text }] },
    serviceEndpoint,
  },
})
const moderate = (params, apiUrl = '/youtubei/v1/live_chat/moderate') => ({
  commandMetadata: { webCommandMetadata: { apiUrl } },
  moderateEndpoint: { params },
})
// ban/hide is wrapped in a confirm dialog whose confirm button holds the token
const confirmModerate = (params) => ({
  confirmDialogEndpoint: {
    confirmDialogRenderer: {
      confirmButton: { buttonRenderer: { serviceEndpoint: moderate(params) } },
    },
  },
})

const REMOVE = item('DELETE', 'Remove', moderate('REMOVE_TOK'))
const TIMEOUT = item('HOURGLASS', 'Put user in timeout', moderate('TIMEOUT_TOK'))
const HIDE = item('REMOVE_CIRCLE', 'Hide user on this channel', confirmModerate('HIDE_TOK'))
const UNHIDE = item('ADD_CIRCLE', 'Unhide user on this channel', moderate('UNHIDE_TOK'))
const REPORT = item('FLAG', 'Report', { commandMetadata: {}, getReportFormEndpoint: {} })
const BLOCK = item(undefined, '', undefined) // the endpoint-less entry seen live

const MOD_MENU = [REMOVE, TIMEOUT, HIDE, UNHIDE, REPORT, BLOCK]
const NONMOD_MENU = [REPORT, BLOCK]

describe('ytHasModItems (mod detection)', () => {
  test('mod menu → true', () => expect(ytHasModItems(MOD_MENU)).toBe(true))
  test('non-mod menu (Report/Block only) → false', () => expect(ytHasModItems(NONMOD_MENU)).toBe(false))
  test('empty / null → false', () => {
    expect(ytHasModItems([])).toBe(false)
    expect(ytHasModItems(null)).toBe(false)
    expect(ytHasModItems(undefined)).toBe(false)
  })
  test('a lone timeout item is enough', () => expect(ytHasModItems([TIMEOUT, REPORT])).toBe(true))
})

describe('ytItemModEndpoint (moderate-token extraction)', () => {
  test('direct moderateEndpoint item → its endpoint', () => {
    expect(ytItemModEndpoint(REMOVE.menuServiceItemRenderer).moderateEndpoint.params).toBe('REMOVE_TOK')
  })
  test('confirm-dialog-wrapped (hide/ban) → unwrapped inner endpoint', () => {
    expect(ytItemModEndpoint(HIDE.menuServiceItemRenderer).moderateEndpoint.params).toBe('HIDE_TOK')
  })
  test('Report (no moderate token) → null', () => {
    expect(ytItemModEndpoint(REPORT.menuServiceItemRenderer)).toBeNull()
  })
  test('endpoint-less item → null (never throws)', () => {
    expect(ytItemModEndpoint(BLOCK.menuServiceItemRenderer)).toBeNull()
    expect(ytItemModEndpoint(undefined)).toBeNull()
    expect(ytItemModEndpoint({})).toBeNull()
  })
})

describe('ytResolveModAction (per-verb routing)', () => {
  test('delete → Remove token', () => {
    const { fireEp, sawMod } = ytResolveModAction(MOD_MENU, 'delete')
    expect(sawMod).toBe(true)
    expect(fireEp.moderateEndpoint.params).toBe('REMOVE_TOK')
  })
  test('timeout → Timeout token', () => {
    expect(ytResolveModAction(MOD_MENU, 'timeout').fireEp.moderateEndpoint.params).toBe('TIMEOUT_TOK')
  })
  test('ban → Hide token (unwrapped from confirm dialog)', () => {
    expect(ytResolveModAction(MOD_MENU, 'ban').fireEp.moderateEndpoint.params).toBe('HIDE_TOK')
  })
  test('unban → Unhide token', () => {
    expect(ytResolveModAction(MOD_MENU, 'unban').fireEp.moderateEndpoint.params).toBe('UNHIDE_TOK')
  })
  test('non-mod menu → no endpoint, sawMod false (fail loud as not_moderator)', () => {
    const { fireEp, sawMod } = ytResolveModAction(NONMOD_MENU, 'ban')
    expect(fireEp).toBeNull()
    expect(sawMod).toBe(false)
  })
  test('mod present but verb absent → sawMod true, fireEp null (action_unmapped)', () => {
    const { fireEp, sawMod } = ytResolveModAction([REMOVE, REPORT], 'ban')
    expect(sawMod).toBe(true)
    expect(fireEp).toBeNull()
  })
  test('never matches a non-moderation item even on a text/icon collision', () => {
    // A Report item whose text happened to contain "remove" must NOT be fired
    // for delete — it has no moderate token, so it is not a candidate at all.
    const trap = item('FLAG', 'Report and remove', { getReportFormEndpoint: {} })
    expect(ytResolveModAction([trap], 'delete').fireEp).toBeNull()
  })
})

describe('ytMatchModAction (icon OR text)', () => {
  test('matches by iconType (locale-independent)', () => {
    expect(ytMatchModAction('delete', { icon: { iconType: 'DELETE' } })).toBe(true)
    expect(ytMatchModAction('ban', { icon: { iconType: 'REMOVE_CIRCLE' } })).toBe(true)
  })
  test('matches by English text when icon is unknown', () => {
    expect(ytMatchModAction('timeout', { text: { runs: [{ text: 'Put user in timeout' }] } })).toBe(true)
    expect(ytMatchModAction('unban', { text: { simpleText: 'Unhide user on this channel' } })).toBe(true)
  })
  test('non-English text still routes via iconType', () => {
    // e.g. a Spanish-locale mod: unknown text, but DELETE icon still matches.
    expect(ytMatchModAction('delete', { icon: { iconType: 'DELETE' }, text: { runs: [{ text: 'Quitar' }] } })).toBe(
      true,
    )
  })
  test('does not cross verbs (timeout icon ≠ delete)', () => {
    expect(ytMatchModAction('delete', { icon: { iconType: 'HOURGLASS' } })).toBe(false)
  })
})

describe('ytItemText', () => {
  test('runs[0]', () => expect(ytItemText({ text: { runs: [{ text: 'Remove' }] } })).toBe('Remove'))
  test('simpleText fallback', () => expect(ytItemText({ text: { simpleText: 'Report' } })).toBe('Report'))
  test('absent → empty string', () => {
    expect(ytItemText({})).toBe('')
    expect(ytItemText(undefined)).toBe('')
  })
})
