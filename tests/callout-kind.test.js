/**
 * A mod anniversary is not a resub.
 *
 * Twitch's mod-anniversary callout reads "Congrats on your 6 month Mod
 * Anniversary!". The resub fallback took the first "N month" it saw, so a
 * 100-month subscriber was told "celebrating 6 months as a subscriber" in
 * nl_kripp's chat (2026-11-08, read off the live callout: event
 * {type:"modiversary", months:6}).
 *
 * readCalloutKind is carved out of share-callouts.js (top-level side effects,
 * cannot be imported) and run for real.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('../src/multichat/share-callouts.js', import.meta.url), 'utf8')
const NOTIFS = readFileSync(new URL('../src/multichat/notifs.js', import.meta.url), 'utf8')

const readCalloutKind = (() => {
  const from = SRC.indexOf('function readCalloutKind(')
  expect(from).toBeGreaterThan(-1)
  return new Function(`${SRC.slice(from, SRC.indexOf('\n}', from) + 2)}\nreturn readCalloutKind`)()
})()

describe('readCalloutKind', () => {
  test('the live mod-anniversary text is a mod anniversary, not a resub', () => {
    expect(readCalloutKind('Congrats on your 6 month Mod Anniversary!Share')).toEqual({ type: 'modanniv', count: 6 })
  })

  test('a mod anniversary with no readable count still never becomes a resub', () => {
    expect(readCalloutKind('Happy Mod Anniversary!').type).toBe('modanniv')
  })

  test('a resub keeps its month count', () => {
    expect(readCalloutKind('Celebrating 100 months as a subscriber! Share')).toEqual({ type: 'resub', count: 100 })
  })

  test('a watch streak counts streams, even when a month is mentioned', () => {
    expect(readCalloutKind('You are on a 12 stream watch streak this month')).toEqual({
      type: 'watchstreak',
      count: 12,
    })
  })
})

describe('the mod anniversary has its own prompt', () => {
  test('surface() routes it to its own type before the resub path', () => {
    const i = SRC.indexOf("kind.type === 'modanniv'")
    const resub = SRC.indexOf("HsNotifs.emit('twitch-resub-share'")
    expect(i).toBeGreaterThan(-1)
    expect(i).toBeLessThan(resub)
    expect(SRC.slice(i, i + 400)).toContain("HsNotifs.emit('twitch-mod-anniversary-share'")
  })

  test('its share runs heatsync’s share mode, never twitch’s button', () => {
    // twitch's button only arms twitch's composer, which heatsync replaces:
    // the prompt closed and nothing was posted (2026-11-09, nl_kripp)
    const i = NOTIFS.indexOf("registerType('twitch-mod-anniversary-share'")
    expect(i).toBeGreaterThan(-1)
    const block = NOTIFS.slice(i, NOTIFS.indexOf('registerType(', i + 10))
    expect(block).not.toContain('clickNative')
    expect(block).toContain("'modanniv')")
    expect(block).toContain("t('mc_notif_mod_anniv'")
  })

  test('a mod anniversary share never posts a "months as a subscriber" line', () => {
    const c = SRC.indexOf('  consume: (text) => {')
    const body = SRC.slice(c, SRC.indexOf('_injectShareSynthetic(claim', c) + 40)
    expect(body).toContain("if (claim.kind !== 'modanniv')")
    expect(SRC).toContain("wasCtx.claim.kind !== 'modanniv'")
  })
})

describe('the mod anniversary send', () => {
  // twitch's own share (read from its bundle 2026-11-09): no token, its own
  // mutation, { channelID, noticeMessage }, a rejection in `error`
  const send = (reply) => {
    const from = SRC.indexOf('async function _sendModiversaryNotice(')
    const src = SRC.slice(from, SRC.indexOf('\n}', from) + 2)
    const calls = []
    const fn = new Function('resolveTwitchChannelId', 'gqlProxy', `${src}\nreturn _sendModiversaryNotice`)(
      async (login) => (login === 'nl_kripp' ? '29795919' : null),
      async (op, vars) => {
        calls.push([op, vars])
        return reply
      },
    )
    return { fn, calls }
  }

  test('sends the typed text with the channel id', async () => {
    const { fn, calls } = send({ data: { sendUserModiversaryNotice: { error: null, modiversary: { months: 6 } } } })
    await fn('nl_kripp', 'six months')
    expect(calls).toEqual([
      ['SendUserModiversaryNotice', { input: { channelID: '29795919', noticeMessage: 'six months' } }],
    ])
  })

  test('a rejection, an error list, no result or no channel id all throw — the caller rescues the text', async () => {
    await expect(
      send({ data: { sendUserModiversaryNotice: { error: 'ALREADY_SENT' } } }).fn('nl_kripp', 'x'),
    ).rejects.toThrow('ALREADY_SENT')
    await expect(send({ errors: [{ message: 'nope' }] }).fn('nl_kripp', 'x')).rejects.toThrow('nope')
    await expect(send({ data: {} }).fn('nl_kripp', 'x')).rejects.toThrow()
    await expect(send({}).fn('someone_else', 'x')).rejects.toThrow('channel id unknown')
  })

  test('the page-world proxy knows the operation and lets it through', () => {
    const MAIN = readFileSync(new URL('../src/content/early-inject-main.js', import.meta.url), 'utf8')
    expect(MAIN).toContain(
      "SendUserModiversaryNotice: '8ca37b26d3c9adc2e20c307adc689a74685acf57c1408d5736664c8ac536526c'",
    )
    const allow = MAIN.slice(
      MAIN.indexOf('const ALLOWED_GQL_OPS = ['),
      MAIN.indexOf(']', MAIN.indexOf('const ALLOWED_GQL_OPS = [')),
    )
    expect(allow).toContain("'SendUserModiversaryNotice'")
  })

  test('consume sends it before the no-token path, so twitch’s button is never pressed', () => {
    const c = SRC.indexOf('  consume: (text) => {')
    const mod = SRC.indexOf("if (claim.kind === 'modanniv') {", c)
    expect(mod).toBeGreaterThan(c)
    expect(mod).toBeLessThan(SRC.indexOf('if (!claim.resubToken) {', c))
    expect(SRC.slice(mod, mod + 300)).toContain('_sendModiversaryNotice(claim.channel, text)')
  })
})
