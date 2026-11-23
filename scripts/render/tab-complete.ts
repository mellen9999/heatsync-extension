import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchWithExtension } from '../lib/chromium'
import { startMockIrc } from '../lib/mock-irc'
import { ONE_PX_PNG, PLATFORMS, closeContext, errors, fail, fixtureHtml, ok, retryUntil, until } from './lib'

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

    // A fresh profile runs two one-time wipes of the channel sets at worker start (the install
    // reset and the v1.5.4 cache migration). Both are async; on a loaded box they land after the seed
    // and erase it (the CI flake: sw map=empty, then a failed refetch saved an empty set). Wait for
    // the migration's done-flag, and for any fetch already in flight, then seed.
    // The background refetches a channel on every join and writes its answer over its saved copy. With every
    // provider refused above, that answer is an empty set, which erases zorpChannel whenever the
    // fetch lands after the seed (6/6 on a loaded box). A real background already holds a channel it
    // fetched a moment ago (it restores the sets at start), and answers a join from that copy without
    // refetching — so seed that copy too, rather than let the harness race the fetch.
    await sw.evaluate(
      async ([key, emotes]: [string, unknown[]]) => {
        // @ts-ignore — service worker globals
        const wait = () => new Promise((r) => setTimeout(r, 50))
        // @ts-ignore
        for (let i = 0; i < 300 && !(await chrome.storage.local.get('migrated_emote_cache_v154')).migrated_emote_cache_v154; i++) await wait()
        // @ts-ignore
        for (let i = 0; i < 300 && channelEmotesMap[key] === 'loading'; i++) await wait()
        // @ts-ignore
        channelEmotesMap[key] = emotes
        // @ts-ignore
        channelEmotesFetchedAt[key] = Date.now()
        // @ts-ignore — and into its IndexedDB, which is where a woken worker restores them from
        return bgPersistChannelEmotes(key)
      },
      ['twitch/probechan', [
        { name: 'zorpChannel', url: E('zorpChannel'), source: '7tv' },
        { name: 'opGrab', url: E('opGrab'), source: '7tv' },
      ]] as [string, unknown[]],
    )
    const seed = await c.newPage()
    await seed.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'load' })
    await seed.evaluate(async (urls: Record<string, string>) => {
      // Written the way the background writes it after a real fetch — three
      // separate tiers (global, own, channel), which is the whole point. The channel tier is
      // seeded below, in the background's own memory + IndexedDB (storage.local never holds it).
      // @ts-ignore — extension page
      await chrome.storage.local.set({
        heatsync_multichat: { channels: [{ id: 'probechan', twitch: 'probechan', kick: '', youtube: '' }] },
        user_info: { username: 'probeuser' },
        global_emotes: [
          { name: 'zorpGlobal', url: urls.zorpGlobal, source: '7tv' },
          { name: 'Kappa', url: urls.Kappa, source: 'twitch' },
        ],
        emote_inventory: [{ name: 'zorpOwn', url: urls.zorpOwn, source: 'heatsync' }],
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
    // The channel set reaches the overlay a beat after the composer mounts (a storage read plus the
    // background's own refetch), and a Tab that beats it correctly ranks only own + global. So wait
    // for the real signal that the pool is in: a line naming the channel emote draws it as an
    // image (history rows heal when the set lands). Nothing here presses Tab before that, so the
    // cycle walked below is the first and only one.
    let gateN = 0
    const rendered = await retryUntil(
      p,
      async () => {
        irc.push(
          `@display-name=Gate${gateN};color=#00FF00;user-id=${900 + gateN};id=gate${gateN} ` +
            `:gate${gateN}!g@g.tmi.twitch.tv PRIVMSG #probechan :zorpChannel\r\n`,
        )
        gateN++
      },
      () => p.evaluate(() => !!document.querySelector('#hs-mc-messages img[alt="zorpChannel"]')),
      { every: 1500, ms: 20_000 },
    )
    if (!rendered) {
      // Say where the set went missing, so the next red names its own cause instead of a guess.
      const live = c.serviceWorkers()[0]
      const state = live
        ? await live
            .evaluate(async () => {
              const key = 'twitch/probechan'
              // @ts-ignore — service worker globals
              const mem = channelEmotesMap[key]
              // @ts-ignore
              const at = channelEmotesFetchedAt[key]
              // @ts-ignore — the copy a woken worker restores from
              const kept = await bgIdbGet(BG_IDB_EMOTES, key).catch(() => null)
              const names = (v: unknown) => (Array.isArray(v) ? v.map((e: any) => e?.name).join(',') || 'empty' : String(v))
              return `sw map=${names(mem)} age=${at ? Date.now() - at : 'none'}ms · saved map=${names(kept?.emotes)} at=${kept?.at ? 'set' : 'none'}`
            })
            .catch((e: unknown) => `sw unreadable: ${String(e).slice(0, 120)}`)
        : 'no service worker'
      fail(
        `the channel emote set never reached the overlay: a line naming zorpChannel stayed plain text (${state}; ` +
          `${live === sw ? 'same' : 'restarted'} service worker)`,
      )
    }
    await resetInput()
    await p.keyboard.type('zorp')
    await p.keyboard.press('Tab')
    await until(p, async () => (await readCycle()).value !== '', 4000)
    const first = (await readCycle()).value
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

    // ── 4. someone who just talked joins the cycle right after the room's emotes ──
    // Straight off the socket, through the parser, into the channel buffer,
    // out again in the cycle. Nothing about this can be faked from a fixture,
    // which is why it lives here and not in a unit test.
    //
    // The order is the emote law's (site docs/emote-law.md, "people in Tab"): a bare
    // word is the room's emote first, then the people in the room, then yours and
    // the globals. `@` is people only. Before the law any recent talker led every
    // emote, so "zorp" stopped sending the channel's zorpChannel the moment a
    // ZorpChatter spoke.
    irc.push(
      '@display-name=ZorpChatter;color=#00FF00;user-id=77;id=zc1 ' +
        ':zorpchatter!z@z.tmi.twitch.tv PRIVMSG #probechan :hello\r\n',
    )
    await until(p, async () =>
      (await p.evaluate(() => document.getElementById('hs-mc-messages')?.textContent || '')).includes('ZorpChatter'),
    )

    const isPerson = (v: string) => v.replace(/^@/, '').toLowerCase() === 'zorpchatter'
    await resetInput()
    await p.keyboard.type('zorp')
    await p.keyboard.press('Tab')
    await until(p, async () => (await readCycle()).value !== '', 8000)
    const lead = await readCycle()
    if (lead.value !== 'zorpChannel') {
      fail(
        `after ZorpChatter talked, "zorp" + Tab completed to ${JSON.stringify(lead.value)}. ` +
          "a bare word is the room's emote first: someone speaking must not change what the word completes to.",
      )
    }
    await p.keyboard.press('Tab')
    await until(p, async () => isPerson((await readCycle()).value), 8000)
    const person = await readCycle()
    if (!isPerson(person.value)) {
      fail(
        `the second Tab on "zorp" gave ${JSON.stringify(person.value)}. whoever just spoke comes right after the ` +
          "room's emotes, ahead of your own and the globals — that is what keeps Tab usable for replying to the person on screen.",
      )
    }
    await cycleStep(false, 'zorpOwn', 'after the person, the cycle goes on to the emote you own')
    ok(`someone who just talked joins the cycle after the room's emote, ahead of yours (zorpChannel → ${person.value} → zorpOwn)`)

    await resetInput()
    await p.keyboard.type('@zorp')
    await p.keyboard.press('Tab')
    await until(p, async () => isPerson((await readCycle()).value), 8000)
    const at = await readCycle()
    if (!isPerson(at.value)) fail(`"@zorp" + Tab gave ${JSON.stringify(at.value)}: @ is people only, so the person leads`)
    await p.keyboard.press('Tab')
    await p.waitForTimeout(400)
    const at2 = await readCycle()
    if (!isPerson(at2.value)) fail(`a second Tab on "@zorp" left the people for ${JSON.stringify(at2.value)}: @ never offers an emote`)
    ok(`@ is people only (${JSON.stringify(at.value)}, and the next Tab stays on people)`)

    // ── 5. the "tab opens the list" setting ─────────────────────────────────
    // Off by default: everything above ran with it off. Switched on from
    // another extension page, the way a second tab's settings change lands,
    // the first Tab must open the ranked list instead of completing, without
    // touching the typed word; the list's own keys then take over.
    const list = (): Promise<{ shown: boolean; names: string[]; sel: number }> =>
      p.evaluate(() => {
        const dd = document.getElementById('hs-mc-emoji-dropdown') as HTMLElement | null
        const rows = [...(dd?.querySelectorAll('.hs-mc-emoji-row') || [])]
        return {
          shown: !!dd && dd.style.display !== 'none' && rows.length > 0,
          names: rows.map((r) => r.querySelector('.hs-mc-emoji-name')?.textContent || ''),
          sel: rows.findIndex((r) => r.classList.contains('selected')),
        }
      })
    const setTabList = async (on: boolean) => {
      const s = await c.newPage()
      await s.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'load' })
      await s.evaluate(async (v: boolean) => {
        // @ts-ignore — extension page
        const cur = (await chrome.storage.sync.get('ui_settings')).ui_settings || {}
        // @ts-ignore
        await chrome.storage.sync.set({ ui_settings: { ...cur, tabOpensEmoteList: v } })
      }, on)
      await s.close()
    }
    await setTabList(true)
    await p.bringToFront()
    let opened = false
    for (let i = 0; i < 10 && !opened; i++) {
      await resetInput()
      await p.keyboard.type('zorp')
      await p.keyboard.press('Tab')
      opened = await until(p, async () => (await list()).shown, 800)
    }
    const l1 = await list()
    if (!opened)
      fail(
        `with tabOpensEmoteList on, Tab on "zorp" never opened the list (composer: ${JSON.stringify(await inputText())})`,
      )
    if (l1.names[0]?.toLowerCase() !== lead.value.toLowerCase() || !l1.names.includes('zorpChannel')) {
      fail(
        `the list must rank like the Tab cycle: expected ${JSON.stringify(lead.value)} first and zorpChannel in it, got ${JSON.stringify(l1.names)}`,
      )
    }
    if ((await inputText()).trim() !== 'zorp') {
      fail(`opening the list completed the word anyway: composer=${JSON.stringify(await inputText())}`)
    }
    ok(`with the setting on, Tab opens the ranked list and leaves the word alone (${l1.names.join(' → ')})`)

    const pick = l1.names.indexOf('zorpChannel')
    for (let i = 0; i < pick; i++) await p.keyboard.press('ArrowDown')
    await until(p, async () => (await list()).sel === pick, 4000)
    await p.keyboard.press('Tab')
    await until(p, async () => !(await list()).shown && (await readCycle()).value === 'zorpChannel', 4000)
    const taken = await readCycle()
    if (taken.value !== 'zorpChannel' || (await list()).shown) {
      fail(
        `arrow to zorpChannel + Tab should insert it and close the list: cycle=${JSON.stringify(taken)}, list ${(await list()).shown ? 'still open' : 'closed'}`,
      )
    }
    const next = l1.names[pick + 1]
    if (next) await cycleStep(false, next, 'after a pick from the list, Tab keeps cycling the same ranked list')
    ok(`arrows move, Tab takes the pick (zorpChannel), and the next Tab cycles on from it${next ? ` (${next})` : ''}`)

    await resetInput()
    await p.keyboard.type('zorp')
    await p.keyboard.press('Tab')
    await until(p, async () => (await list()).shown, 4000)
    await p.keyboard.press('Escape')
    await until(p, async () => !(await list()).shown, 4000)
    const afterEsc = await inputText()
    const barUp = await p.evaluate(() => !!document.getElementById('hs-mc-input')?.offsetParent)
    if ((await list()).shown || afterEsc.trim() !== 'zorp' || !barUp) {
      fail(
        `Escape should close only the list: list ${(await list()).shown ? 'open' : 'closed'}, composer=${JSON.stringify(afterEsc)}, composer ${barUp ? 'shown' : 'hidden'}`,
      )
    }
    ok('Escape closes the list and keeps the word and the composer')

    await p.keyboard.press('Tab')
    await until(p, async () => (await list()).shown, 4000)
    await p.keyboard.type('x')
    await until(p, async () => !(await list()).shown, 4000)
    if ((await list()).shown || (await inputText()).trim() !== 'zorpx') {
      fail(
        `typing should close the list and keep the keystroke: list ${(await list()).shown ? 'open' : 'closed'}, composer=${JSON.stringify(await inputText())}`,
      )
    }
    ok('typing closes the list and the keystroke lands in the word')
    await setTabList(false)
  } finally {
    irc.stop()
    await closeContext(c, 'tab-complete', prof)
    rmSync(prof, { recursive: true, force: true })
  }
}