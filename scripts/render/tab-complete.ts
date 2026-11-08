import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchWithExtension } from '../lib/chromium'
import { startMockIrc } from '../lib/mock-irc'
import { ONE_PX_PNG, PLATFORMS, closeContext, errors, fail, fixtureHtml, ok, until } from './lib'

/**
 * Tab-complete, driven from a real keyboard.
 *
 * It is the most-used keystroke in the composer and the single most
 * bug-prone thing in it — the ranking alone carries four separate recorded
 * incidents — and until now nothing had ever pressed Tab. Every existing test
 * of it reads the source and checks that the comparator still contains the
 * words it used to.
 *
 * Four contracts, each one a bug that shipped:
 *
 *  1. RANKING — channel emotes beat the ones you own beat globals. The three
 *     tiers come from three different places (a channel map, your inventory,
 *     the global pool) and are merged by a memoized signature; "channel
 *     culture leads" is the user-chosen order and nothing enforced it.
 *  2. WHO JUST TALKED beats all of that. A name off the wire outranks every
 *     emote, which is why this check needs a live chat and not a fixture.
 *  3. SLASH COMMANDS WIN OUTRIGHT. Tab on "/op" completed to a random channel
 *     emote in a live incident whose root cause was never pinned down; the
 *     defence is a hand-written direct lookup with nothing testing it.
 *  4. A MODIFIER TOKEN IS NOT A COMPLETION. "Kappa w!" + Tab did nothing at
 *     all: two characters was over the completion threshold, and completion
 *     refuses modifier tokens, so the press fell down a hole.
 *
 * The emote pool is seeded through chrome.storage exactly as the background
 * writes it after a real fetch, so the load-and-merge path is under test too
 * rather than being bypassed with a hand-placed map.
 */
export async function tabCompleteCheck() {
  console.log('\n── tab-complete, from the keyboard ──')
  const irc = startMockIrc()
  if (!irc) {
    console.log('  ! SKIPPED — openssl not available, so there is no live chat to rank against.')
    console.log('    tab-complete ordering is going UNVERIFIED in this run.')
    return
  }

  const E = (n: string) => `https://cdn.heatsync.org/emote/${n}.png`
  const prof = mkdtempSync(join(tmpdir(), 'hs-ext-tabc-'))
  const c = await launchWithExtension(prof, [
    '--window-size=1500,900',
    `--host-resolver-rules=MAP irc-ws.chat.twitch.tv 127.0.0.1:${irc.port}`,
    '--ignore-certificate-errors',
    '--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests',
  ])
  try {
    // The FIRST Tab fires the 7TV/BTTV/FFZ catalog search unconditionally.
    // Left unrouted it leaves this machine, and the ranking under test would
    // then depend on what frankerfacez happens to return today. Refused here,
    // so every match is local and the order is the one the comparator decides.
    // (Routes match last-registered-first, hence the ordering.)
    await c.route('https://heatsync.org/**', (r: any) => r.abort())
    await c.route('https://api.frankerfacez.com/**', (r: any) => r.abort())
    await c.route('https://7tv.io/**', (r: any) => r.abort())
    await c.route('https://api.betterttv.net/**', (r: any) => r.abort())
    await c.route('https://cdn.heatsync.org/**', (r: any) =>
      r.fulfill({ status: 200, contentType: 'image/png', body: ONE_PX_PNG }),
    )
    await c.route(PLATFORMS[0].glob, (r: any) =>
      r.fulfill({ status: 200, contentType: 'text/html', body: fixtureHtml(PLATFORMS[0].body) }),
    )
    await c.addCookies([
      { name: 'auth-token', value: 'harnesstoken0000', domain: '.twitch.tv', path: '/', secure: true },
      { name: 'login', value: 'probeuser', domain: '.twitch.tv', path: '/', secure: true },
    ])

    let sw = c.serviceWorkers()[0]
    if (!sw) sw = await c.waitForEvent('serviceworker', { timeout: 20_000 })
    const id = sw.url().match(/chrome-extension:\/\/([a-p]+)\//)?.[1]
    if (!id) fail('could not resolve the extension id for the tab-complete check')

    const seed = await c.newPage()
    await seed.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'load' })
    await seed.evaluate(async (urls: Record<string, string>) => {
      // Written the way the background writes it after a real fetch — three
      // separate keys feeding three separate tiers, which is the whole point.
      // @ts-ignore — extension page
      await chrome.storage.local.set({
        heatsync_multichat: { channels: [{ id: 'probechan', twitch: 'probechan', kick: '', youtube: '' }] },
        user_info: { username: 'probeuser' },
        global_emotes: [
          { name: 'zorpGlobal', url: urls.zorpGlobal, source: '7tv' },
          { name: 'Kappa', url: urls.Kappa, source: 'twitch' },
        ],
        emote_inventory: [{ name: 'zorpOwn', url: urls.zorpOwn, source: 'heatsync' }],
        channel_emotes_map: {
          'twitch/probechan': [
            { name: 'zorpChannel', url: urls.zorpChannel, source: '7tv' },
            { name: 'opGrab', url: urls.opGrab, source: '7tv' },
          ],
        },
      })
    }, {
      zorpGlobal: E('zorpGlobal'),
      zorpOwn: E('zorpOwn'),
      zorpChannel: E('zorpChannel'),
      opGrab: E('opGrab'),
      Kappa: E('Kappa'),
    })
    await seed.close()

    const p = await c.newPage()
    p.on('pageerror', (e: unknown) => errors.push(`tabcomplete: ${String(e).slice(0, 300)}`))
    await p.goto('https://www.twitch.tv/probechan', { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('#hs-mc-input', { timeout: 25_000 })

    /** Whatever the cycle is currently showing — chip, mention span or raw text. */
    const readCycle = (): Promise<{ kind: string, value: string }> =>
      p.evaluate(() => {
        const inp = document.getElementById('hs-mc-input')
        if (!inp) return { kind: 'none', value: '' }
        const img = inp.querySelector('img.hs-cycling-emote') as HTMLImageElement | null
        if (img) return { kind: 'emote', value: img.alt || '' }
        const user = inp.querySelector('span.hs-cycling-user')
        if (user) return { kind: 'user', value: (user.textContent || '').trim() }
        const text = inp.querySelector('span.hs-cycling-text')
        if (text) return { kind: 'text', value: (text.textContent || '').trim() }
        return { kind: 'none', value: (inp.textContent || '').trim() }
      })

    const inputText = (): Promise<string> =>
      p.evaluate(() => (document.getElementById('hs-mc-input')?.textContent || '').replace(/ /g, ' '))

    // Clear by hand rather than with Escape: on an empty composer Escape means
    // "done here" and hides the whole input bar, which would take the next
    // phase down with it. Any typed character resets the cycle on its own.
    const resetInput = async () => {
      await p.evaluate(() => {
        const i = document.getElementById('hs-mc-input')
        if (!i) return
        i.innerHTML = ''
      })
      await p.click('#hs-mc-input')
    }

    const cycleStep = async (shift: boolean, want: string, what: string) => {
      const before = (await readCycle()).value
      await p.keyboard.press(shift ? 'Shift+Tab' : 'Tab')
      await until(p, async () => (await readCycle()).value === want, 8000)
      const got = await readCycle()
      if (got.value !== want) {
        fail(
          `${what}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got.value)} ` +
            `(the press before it left ${JSON.stringify(before)})`,
        )
      }
    }

    // ── 1. the three tiers, in order ────────────────────────────────────────
    // "zorp" prefix-matches exactly one emote in each tier and nothing else,
    // and none of them has ever been used, so the comparator has only the tier
    // to go on. Three Tabs must walk channel -> own -> global.
    //
    // Nothing else in the pool may even CONTAIN "zorp": a substring hit ranks
    // below its tier's prefix hits but still above the whole next tier, so the
    // slash decoy was first written as "opzorp" and landed between the channel
    // emote and the one you own. That is the ranking behaving correctly, and
    // it is exactly the kind of near-miss a fixture can hide.
    //
    // The channel set arrives over the background wire after the composer
    // mounts; on a loaded box the first Tab can beat it and (correctly) rank
    // only own + global. So the first Tab is retried from a fresh "zorp" until
    // the pool is complete, and the cycle it starts is the one walked below —
    // re-typing the same prefix over a script-cleared input does not reliably
    // restart the cycle, so a second fresh start would test the harness.
    const poolReady = Date.now() + 20_000
    let first = ''
    for (;;) {
      await resetInput()
      await p.keyboard.type('zorp')
      await p.keyboard.press('Tab')
      await until(p, async () => (await readCycle()).value === 'zorpChannel', 1000)
      first = (await readCycle()).value
      if (first === 'zorpChannel' || Date.now() > poolReady) break
    }
    if (first !== 'zorpChannel') {
      fail(`the first Tab should land on the CHANNEL emote: expected "zorpChannel", got ${JSON.stringify(first)}`)
    }
    await cycleStep(false, 'zorpOwn', 'the second Tab should land on the emote you OWN')
    await cycleStep(false, 'zorpGlobal', 'the third Tab should land on the GLOBAL emote')
    ok('tab-complete ranks channel over own over global (zorpChannel → zorpOwn → zorpGlobal)')

    await cycleStep(true, 'zorpOwn', 'Shift+Tab should walk the cycle back')
    ok('Shift+Tab walks the same cycle backwards')

    // ── 2. a slash command is never an emote ────────────────────────────────
    // The channel owns "opGrab" on purpose: if word extraction ever drops the
    // leading slash, there is something for a stray completion to grab.
    //
    // Two paths answer this press — the slash dropdown's own Tab branch, and a
    // direct lookup added afterwards as a backstop because the dropdown's
    // active flag was not reliably set for every command. Disabling either one
    // alone still passes, so this cannot say which one ran; disabling both
    // fails. That is the right shape: either path satisfies the user, and the
    // backstop is now known to carry the press on its own rather than being
    // decorative.
    await resetInput()
    await p.keyboard.type('/op')
    await p.keyboard.press('Tab')
    // The trailing space is load-bearing as evidence: it is what the command
    // inserter appends, so "/op " proves the slash path took the press.
    // Falling through to emote completion with no match leaves a bare "/op",
    // which trims to the same thing and would pass a sloppier compare.
    await until(p, async () => (await inputText()) === '/op ', 8000)
    const slashText = await inputText()
    const slashChip = await p.evaluate(
      () => !!document.getElementById('hs-mc-input')?.querySelector('img.hs-input-emote'),
    )
    if (slashText !== '/op ' || slashChip) {
      fail(
        `Tab on "/op" left the composer holding ${JSON.stringify(slashText)}` +
          `${slashChip ? ' plus an emote chip' : ''} — a partial slash command must complete the ` +
          'COMMAND. this exact press once inserted an unrelated channel emote in production.',
      )
    }
    ok('Tab on a partial slash command completes the command, not an emote')

    // ── 3. a modifier token applies, it does not complete ───────────────────
    await resetInput()
    await p.keyboard.type('Kappa')
    await cycleStep(false, 'Kappa', 'Tab on a full emote name should insert that emote')
    await p.keyboard.type('w!')
    await p.keyboard.press('Tab')
    await until(p, async () =>
      p.evaluate(() => {
        const img = document.getElementById('hs-mc-input')?.querySelector('img.hs-input-emote') as HTMLElement | null
        return !!img && (img.dataset.hsMods || '').split(',').includes('wide')
      }),
    )
    const mod = await p.evaluate(() => {
      const inp = document.getElementById('hs-mc-input')
      const img = inp?.querySelector('img.hs-input-emote') as HTMLElement | null
      return {
        mods: img?.dataset?.hsMods || '',
        transform: (img as HTMLElement | null)?.style?.transform || '',
        text: (inp?.textContent || '').replace(/ /g, ' '),
      }
    })
    if (!mod.mods.split(',').includes('wide')) {
      fail(
        'Tab after "Kappa w!" applied no modifier — the press went nowhere. that is the bug: ' +
          '"w!" is two characters, so it cleared the completion threshold, and completion ' +
          `refuses modifier tokens outright (mods=${JSON.stringify(mod.mods)}, input=${JSON.stringify(mod.text)})`,
      )
    }
    // The dataset alone would still pass if composing the transform broke; the
    // widening is the part the user sees. Read the x factor rather than pinning
    // the exact syntax — scale(2, 1) and scaleX(2) are the same picture.
    const sx = Number((mod.transform.match(/scaleX?\(\s*(-?[\d.]+)/) || [])[1])
    if (!(Math.abs(sx) > 1)) {
      fail(`"w!" recorded the modifier but painted no widening: transform=${JSON.stringify(mod.transform)}`)
    }
    if (/w!/.test(mod.text)) {
      fail(`the modifier applied but "w!" was left in the composer as literal text: ${JSON.stringify(mod.text)}`)
    }
    ok(`Tab applies an ffz modifier to the emote before it (mods="${mod.mods}", ${mod.transform})`)

    // ── 4. someone who just talked outranks every emote ─────────────────────
    // Straight off the socket, through the parser, into the channel buffer,
    // out again as the top completion. Nothing about this can be faked from a
    // fixture, which is why it lives here and not in a unit test.
    irc.push(
      '@display-name=ZorpChatter;color=#00FF00;user-id=77;id=zc1 ' +
        ':zorpchatter!z@z.tmi.twitch.tv PRIVMSG #probechan :hello\r\n',
    )
    await until(p, async () =>
      (await p.evaluate(() => document.getElementById('hs-mc-messages')?.textContent || '')).includes('ZorpChatter'),
    )

    await resetInput()
    await p.keyboard.type('zorp')
    await p.keyboard.press('Tab')
    await until(p, async () => (await readCycle()).value.toLowerCase() === 'zorpchatter', 8000)
    const lead = await readCycle()
    if (lead.value.toLowerCase() !== 'zorpchatter') {
      fail(
        `after ZorpChatter talked, "zorp" + Tab still completed to ${JSON.stringify(lead.value)}. ` +
          'whoever just spoke leads the cycle, above every emote tier — that is what makes Tab ' +
          'usable for replying to the person on screen.',
      )
    }
    ok(`someone who just talked leads the cycle, above all three emote tiers (${JSON.stringify(lead.value)})`)
  } finally {
    irc.stop()
    await closeContext(c, 'tab-complete', prof)
    rmSync(prof, { recursive: true, force: true })
  }
}