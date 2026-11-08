import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchWithExtension } from '../lib/chromium'
import { startMockIrc } from '../lib/mock-irc'
import { PLATFORMS, closeContext, errors, fail, fixtureHtml, ok, until } from './lib'

/** A 32x32 opaque tile, so picker tiles lay out like real emotes instead of 1px specks. */
const TILE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVR42u3NsQkAAAgDsJ7fr/UKByGQPWnnVAQCgUAgEAgEAsGXYAHc9Dx5h11nVgAAAABJRU5ErkJggg==',
  'base64',
)

/**
 * The composer and the emote picker, used the way a person who never touches
 * the mouse uses them.
 *
 *  1. SENT HISTORY SURVIVES A RELOAD. Send two messages over the wire, reload
 *     the page, press ArrowUp: the newest comes back, then the one before it.
 *     Memory-only history made every reload forget what you had just said.
 *  2. SPELLCHECK is a setting that reaches the live composer: flip it in
 *     storage and the same node changes, no reload.
 *  3. THE AUTOCOMPLETE LIST IS A COMBOBOX. ":nav" opens a listbox whose options
 *     have ids, the composer names the open list and the highlighted row, and
 *     arrowing moves aria-activedescendant to another real option.
 *  4. THE PICKER FROM THE KEYBOARD. Opened with Enter on the button, focus lands
 *     in the search box; ArrowDown engages the first tile, arrows/Home/End move
 *     a cyan cursor that stays in view and runs on across lazily-drawn chunks,
 *     Enter inserts exactly as a click does, and Escape closes the panel and
 *     gives the composer back. Then the same on SEARCH RESULTS, which replace
 *     the grid's contents. A mouse open must NOT steal focus.
 */
export async function composerAndPickerCheck() {
  console.log('\n── composer history, spellcheck, autocomplete a11y, picker keyboard ──')
  const irc = startMockIrc()
  if (!irc) {
    console.log('  ! SKIPPED — openssl not available, so there is no live chat to send into.')
    console.log('    sent-history persistence and picker keyboard nav are going UNVERIFIED in this run.')
    return
  }
  const { frames } = irc

  const E = (n: string) => `https://cdn.heatsync.org/emote/${n}.png`
  const prof = mkdtempSync(join(tmpdir(), 'hs-ext-composer-'))
  const c = await launchWithExtension(prof, [
    '--window-size=1500,900',
    `--host-resolver-rules=MAP irc-ws.chat.twitch.tv 127.0.0.1:${irc.port}`,
    '--ignore-certificate-errors',
    '--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests',
  ])
  try {
    // Every catalog the picker search fans out to is refused, so what a query
    // returns is the seeded pool and nothing from this machine's network.
    await c.route('https://heatsync.org/**', (r: any) => r.abort())
    await c.route('https://api.frankerfacez.com/**', (r: any) => r.abort())
    await c.route('https://7tv.io/**', (r: any) => r.abort())
    await c.route('https://api.betterttv.net/**', (r: any) => r.abort())
    await c.route('https://cdn.heatsync.org/**', (r: any) =>
      r.fulfill({ status: 200, contentType: 'image/png', body: TILE_PNG }),
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
    if (!id) fail('could not resolve the extension id for the composer check')

    /** Run something on the extension's own page (chrome.storage is unreachable from the host page's world). */
    let p: any = null
    const onExt = async (fn: (arg: any) => any, arg?: any) => {
      const e = await c.newPage()
      try {
        await e.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'load' })
        return await e.evaluate(fn, arg)
      } finally {
        await e.close()
        // a hidden tab does not render, and every assertion below is a rendering one
        if (p) await p.bringToFront()
      }
    }

    // 250 global emotes = three chunks of the lazily-drawn grid, so End and a
    // long ArrowDown have to cross chunks that were never drawn.
    const globals = Array.from({ length: 250 }, (_, i) => {
      const name = `nav${String(i).padStart(3, '0')}`
      return { name, url: E(name), source: '7tv' }
    })
    const channel = Array.from({ length: 6 }, (_, i) => ({ name: `chan${i}`, url: E(`chan${i}`), source: '7tv' }))
    await onExt(
      async (seed: any) => {
        // @ts-ignore — extension page
        await chrome.storage.local.set({
          heatsync_multichat: { channels: [{ id: 'probechan', twitch: 'probechan', kick: '', youtube: '' }] },
          user_info: { username: 'probeuser' },
          global_emotes: seed.globals,
          channel_emotes_map: { 'twitch/probechan': seed.channel },
        })
      },
      { globals, channel },
    )

    p = await c.newPage()
    p.on('pageerror', (e: unknown) => errors.push(`composer: ${String(e).slice(0, 300)}`))
    await p.goto('https://www.twitch.tv/probechan', { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('#hs-mc-input', { timeout: 25_000 })
    if (!(await until(p, () => frames.some((f) => f.startsWith('PASS oauth:'))))) {
      fail(`the authenticated irc connection never handshook (frames: ${JSON.stringify(frames.slice(0, 8))})`)
    }

    const composerText = (): Promise<string> =>
      p.evaluate(() => (document.getElementById('hs-mc-input')?.textContent || '').replace(/ /g, ' '))
    const clearComposer = async () => {
      await p.evaluate(() => {
        const i = document.getElementById('hs-mc-input')
        if (i) i.innerHTML = ''
      })
      await p.click('#hs-mc-input')
    }

    // ── 1. sent history survives a reload ───────────────────────────────────
    const sent = ['first message from the harness', 'second message from the harness']
    for (const m of sent) {
      await p.click('#hs-mc-input')
      await p.keyboard.type(m)
      await p.keyboard.press('Enter')
      if (!(await until(p, () => frames.includes(`PRIVMSG #probechan :${m}`), 10_000))) {
        fail(`${JSON.stringify(m)} never left on the irc wire — nothing to remember`)
      }
    }
    const readStored = () =>
      onExt(
        () =>
          // @ts-ignore — extension page
          new Promise((res) => chrome.storage.local.get('hs_sent_history', (v: any) => res(v.hs_sent_history))),
      )
    if (!(await until(p, async () => JSON.stringify(await readStored()) === JSON.stringify([...sent].reverse()), 8000))) {
      fail(`chrome.storage.local hs_sent_history is ${JSON.stringify(await readStored())}, expected the two sends newest first`)
    }
    ok('sent messages are written to chrome.storage.local, newest first')

    await p.reload({ waitUntil: 'domcontentloaded' })
    await p.waitForSelector('#hs-mc-input', { timeout: 25_000 })
    await p.click('#hs-mc-input')
    if ((await composerText()) !== '') fail('the composer did not start empty after the reload')
    // The list loads without blocking boot, so the first ArrowUp(s) can land
    // before it does; a press with no history is a no-op, so pressing until the
    // newest line appears can only ever land on the newest line.
    let recalled = ''
    await until(
      p,
      async () => {
        await p.keyboard.press('ArrowUp')
        recalled = await composerText()
        return recalled !== ''
      },
      10_000,
    )
    if (recalled !== sent[1]) {
      fail(`after a reload ArrowUp recalled ${JSON.stringify(recalled)}, expected the newest send ${JSON.stringify(sent[1])}`)
    }
    await p.keyboard.press('ArrowUp')
    if ((await composerText()) !== sent[0]) fail(`the second ArrowUp did not reach the older send (${JSON.stringify(await composerText())})`)
    await p.keyboard.press('ArrowUp')
    if ((await composerText()) !== sent[0]) fail('ArrowUp past the oldest entry should stay on it')
    await p.keyboard.press('ArrowDown')
    if ((await composerText()) !== sent[1]) fail('ArrowDown did not walk back to the newer send')
    await p.keyboard.press('ArrowDown')
    if ((await composerText()) !== '') fail('ArrowDown past the newest entry should hand back the empty draft')
    ok('after a page reload ArrowUp/ArrowDown walk the sent history (newest, older, clamp, back to the draft)')

    // ── 1b. settings: "remember sent messages" is on, "clear sent history" clears ──
    await p.click('.hs-mc-tab[data-tab="settings"]')
    await p.waitForSelector('.hs-mc-settings-panel', { timeout: 10_000 })
    await p.click('.hs-mc-set-subtab[data-set-subtab="chat"]')
    const rememberPill = '.hs-mc-toggle-pill[data-set-key="hs_remember_sent"]'
    await p.waitForSelector(rememberPill, { timeout: 10_000 })
    if (!(await p.$eval(rememberPill, (el: any) => el.classList.contains('active')))) {
      fail('"remember sent messages" should be ON out of the box')
    }
    await p.click('.hs-mc-settings-btn[data-action="clear-sent-history"]')
    if (!(await until(p, async () => (await readStored()) === undefined, 8000))) {
      fail(`"clear sent history" left ${JSON.stringify(await readStored())} in chrome.storage.local`)
    }
    await p.reload({ waitUntil: 'domcontentloaded' })
    await p.waitForSelector('#hs-mc-input', { timeout: 25_000 })
    await p.click('#hs-mc-input')
    await p.waitForTimeout(1500) // long enough for a (wrongly) surviving list to have loaded
    await p.keyboard.press('ArrowUp')
    if ((await composerText()) !== '') fail('ArrowUp still recalled a message after "clear sent history" and a reload')
    ok('settings has "remember sent messages" (on) and "clear sent history" wipes the stored list for good')

    // ── 2. spellcheck is a live setting ─────────────────────────────────────
    const spell = (): Promise<boolean | null> =>
      p.evaluate(() => {
        const i = document.getElementById('hs-mc-input') as any
        return i ? !!i.spellcheck : null
      })
    await p.evaluate(() => {
      ;(document.getElementById('hs-mc-input') as any).__probe = 'same node'
    })
    if ((await spell()) !== false) fail('spellcheck should be OFF by default')
    ok('spellcheck is off by default')
    for (const want of [true, false]) {
      await onExt(
        // @ts-ignore — extension page
        (v: boolean) => chrome.storage.local.set({ hs_spellcheck: v }),
        want,
      )
      if (!(await until(p, async () => (await spell()) === want, 8000))) {
        fail(`setting hs_spellcheck=${want} never reached the live composer (spellcheck is ${await spell()})`)
      }
    }
    const sameNode = await p.evaluate(() => (document.getElementById('hs-mc-input') as any).__probe === 'same node')
    if (!sameNode) fail('flipping spellcheck rebuilt the composer instead of updating it in place')
    ok('flipping hs_spellcheck on then off reaches the live composer, same node, no reload')

    // ── 3. the autocomplete list is a combobox ──────────────────────────────
    await clearComposer()
    await p.keyboard.type(':nav00')
    const combo = () =>
      p.evaluate(() => {
        const i = document.getElementById('hs-mc-input') as HTMLElement
        const dd = document.getElementById('hs-mc-emoji-dropdown')
        const ad = i.getAttribute('aria-activedescendant')
        const target = ad ? document.getElementById(ad) : null
        return {
          role: i.getAttribute('role'),
          auto: i.getAttribute('aria-autocomplete'),
          expanded: i.getAttribute('aria-expanded'),
          controls: i.getAttribute('aria-controls'),
          ad,
          adInList: !!(target && dd?.contains(target)),
          adSelected: target?.getAttribute('aria-selected') ?? null,
          selectedCount: dd ? dd.querySelectorAll('[aria-selected="true"]').length : 0,
          listRole: dd?.getAttribute('role') ?? null,
          listLabel: dd?.getAttribute('aria-label') ?? '',
          optRoles: [...(dd?.children || [])].map((x) => x.getAttribute('role')),
          optIds: [...(dd?.children || [])].map((x) => x.id),
          shown: !!dd && getComputedStyle(dd).display !== 'none',
        }
      })
    if (!(await until(p, async () => (await combo()).shown, 8000))) fail('typing ":nav00" never opened the emote list')
    const open = await combo()
    if (open.role !== 'combobox' || open.auto !== 'list') fail(`the composer is not a list combobox: ${JSON.stringify(open)}`)
    if (open.expanded !== 'true' || open.controls !== 'hs-mc-emoji-dropdown') {
      fail(`an open list is not announced on the composer: ${JSON.stringify(open)}`)
    }
    if (open.listRole !== 'listbox' || !open.listLabel) fail(`the list is not a named listbox: ${JSON.stringify(open)}`)
    if (!open.optRoles.length || open.optRoles.some((r: string | null) => r !== 'option')) {
      fail(`list rows are not all options: ${JSON.stringify(open.optRoles)}`)
    }
    if (new Set(open.optIds).size !== open.optIds.length || open.optIds.some((x: string) => !x)) {
      fail(`list options need unique ids: ${JSON.stringify(open.optIds)}`)
    }
    if (!open.ad || !open.adInList || open.adSelected !== 'true' || open.selectedCount !== 1) {
      fail(`aria-activedescendant does not name the one selected option: ${JSON.stringify(open)}`)
    }
    await p.keyboard.press('ArrowDown')
    const moved = await combo()
    if (!moved.ad || moved.ad === open.ad || !moved.adInList || moved.adSelected !== 'true' || moved.selectedCount !== 1) {
      fail(`ArrowDown did not move aria-activedescendant to another option: ${open.ad} -> ${moved.ad}`)
    }
    await p.keyboard.press('Escape')
    const shut = await combo()
    if (shut.expanded !== 'false' || shut.controls !== null || shut.ad !== null) {
      fail(`closing the list left the composer claiming it is open: ${JSON.stringify(shut)}`)
    }
    ok(`":nav00" opens a listbox of ${open.optRoles.length} options; the composer names it and tracks the highlighted row; closing releases it`)

    // Tab-complete draws no list, so its candidate must be a live region.
    await clearComposer()
    await p.keyboard.type('nav01')
    await p.keyboard.press('Tab')
    const status = await until(
      p,
      () =>
        p.evaluate(() => {
          const tt = document.getElementById('hs-mc-cycle-tooltip')
          return tt?.getAttribute('role') === 'status' && /\d+\/\d+/.test(tt.textContent || '')
        }),
      8000,
    )
    if (!status) fail('the tab-complete candidate is not announced in a role=status region')
    ok('tab-complete announces its candidate (n/m name) through a role=status region')

    // ── 4. the picker from the keyboard ─────────────────────────────────────
    await clearComposer()
    await p.keyboard.type('hi ') // a draft keeps the composer from auto-hiding when focus moves to the button
    const pickerOpen = () => p.evaluate(() => !!document.getElementById('hs-mc-emote-picker')?.classList.contains('visible'))
    const searchFocused = () => p.evaluate(() => document.activeElement?.id === 'hs-mc-emote-search')
    const composerFocused = () => p.evaluate(() => document.activeElement?.id === 'hs-mc-input')

    // A mouse open must not move focus: the reader is mid-sentence.
    await p.click('#hs-mc-emote-btn')
    await p.waitForSelector('#hs-mc-emote-picker.visible', { timeout: 10_000 })
    if (await searchFocused()) fail('opening the picker with the MOUSE moved focus into its search box')
    ok('a mouse open leaves focus where it was')
    await p.click('#hs-mc-emote-btn')
    if (await pickerOpen()) fail('clicking the emote button a second time did not close the picker')

    await p.focus('#hs-mc-emote-btn')
    await p.keyboard.press('Enter')
    await p.waitForSelector('#hs-mc-emote-picker.visible', { timeout: 10_000 })
    if (!(await until(p, searchFocused, 4000))) fail('opening the picker with Enter on the button did not land in its search box')
    ok('Enter on the emote button opens the picker with focus in the search box')

    const grid = () =>
      p.evaluate(() => {
        const g = document.getElementById('hs-mc-emote-grid') as HTMLElement
        const input = document.getElementById('hs-mc-emote-search') as HTMLInputElement
        const tiles = [...g.querySelectorAll('.hs-mc-picker-emote-wrap')] as HTMLElement[]
        const sel = tiles.filter((t) => t.getAttribute('aria-selected') === 'true')
        const s = sel[0]
        const gr = g.getBoundingClientRect()
        const r = s?.getBoundingClientRect()
        const ad = input.getAttribute('aria-activedescendant')
        const before = s ? getComputedStyle(s, '::before') : null
        return {
          total: tiles.length,
          selCount: sel.length,
          idx: s ? tiles.indexOf(s) : -1,
          name: s?.dataset.name || '',
          adIsSel: !!s && !!ad && s.id === ad,
          cx: r ? Math.round(r.left + r.width / 2) : 0,
          top: r ? Math.round(r.top) : 0,
          inView: r ? r.top >= gr.top - 1 && r.bottom <= gr.bottom + 1 : false,
          scrollTop: g.scrollTop,
          focused: document.activeElement === input,
          plate: before ? before.backgroundColor : '',
          plateOpacity: before ? before.opacity : '',
          groups: g.querySelectorAll('[role="group"]').length,
          comboRole: input.getAttribute('role'),
          expanded: input.getAttribute('aria-expanded'),
          controls: input.getAttribute('aria-controls'),
          listOk: !!g.querySelector(`[role="listbox"]#${input.getAttribute('aria-controls')}`),
          optionRoles: tiles.slice(0, 8).every((t) => t.getAttribute('role') === 'option'),
          names: tiles.map((t) => t.dataset.name || ''),
        }
      })
    const key = async (k: string) => {
      await p.keyboard.press(k)
    }

    if (!(await until(p, async () => (await grid()).total > 0, 10_000))) fail('the picker drew no tiles')
    const idle = await grid()
    if (idle.comboRole !== 'combobox' || idle.expanded !== 'true' || !idle.listOk || !idle.optionRoles) {
      fail(`the picker's search box / grid are not a combobox over a listbox of options: ${JSON.stringify({ ...idle, names: undefined })}`)
    }
    if (idle.selCount !== 0) fail('a tile was selected before any key was pressed')
    ok('the picker is a combobox (search box) over a listbox of option tiles')

    await key('ArrowDown')
    let st = await grid()
    if (st.idx !== 0 || st.selCount !== 1 || !st.adIsSel || !st.focused) {
      fail(`ArrowDown should engage the first tile and keep focus in the box: ${JSON.stringify({ ...st, names: undefined })}`)
    }
    if (st.plate !== 'rgb(0, 255, 255)' || st.plateOpacity !== '1') {
      fail(`the cursor is not drawn as the cyan plate (got ${st.plate}, opacity ${st.plateOpacity})`)
    }
    ok('ArrowDown engages the first tile: aria-selected + aria-activedescendant, cyan plate, focus stays in the box')

    await key('ArrowRight')
    st = await grid()
    if (st.idx !== 1 || st.selCount !== 1 || !st.adIsSel) fail(`ArrowRight did not move to the second tile: ${st.idx}`)
    const rowStart = st
    await key('ArrowDown')
    st = await grid()
    if (!(st.top > rowStart.top) || Math.abs(st.cx - rowStart.cx) > 2 || !st.adIsSel) {
      fail(`ArrowDown should move one row down in the same column: ${JSON.stringify({ from: rowStart, to: st })}`)
    }
    const perRow = st.idx - rowStart.idx
    await key('ArrowUp')
    st = await grid()
    if (st.idx !== rowStart.idx) fail(`ArrowUp did not return to the tile above (${st.idx} vs ${rowStart.idx})`)
    ok(`arrows move the cursor by tile and by row (${perRow} tiles per row)`)

    await key('Home')
    await key('ArrowUp')
    st = await grid()
    if (st.idx !== 0) fail(`ArrowUp on the first row should stay put, got tile ${st.idx}`)

    // Hold ArrowDown past the first drawn chunk: the cursor must never run into
    // an empty placeholder, and must stay in view the whole way.
    let last = 0
    for (let i = 0; i < 22 && st.idx < 100; i++) {
      await key('ArrowDown')
      st = await grid()
      if (st.idx <= last && i > 0) fail(`ArrowDown stalled at tile ${st.idx} (step ${i}) — the next chunk was not there`)
      if (!st.inView) fail(`the cursor left the visible grid at tile ${st.idx}`)
      last = st.idx
    }
    if (st.idx < 96) fail(`22 ArrowDowns only reached tile ${st.idx}; expected to cross the first chunk (96)`)
    ok(`holding ArrowDown crosses the first lazily-drawn chunk (tile ${st.idx}) and stays in view`)

    await key('End')
    st = await grid()
    if (st.idx !== st.total - 1 || st.total < 200 || !st.inView || !st.adIsSel) {
      fail(`End should land on the last tile, in view: ${JSON.stringify({ ...st, names: undefined })}`)
    }
    ok(`End jumps to the last tile of ${st.total}, drawing the chunk that was still a placeholder`)
    await key('Home')
    st = await grid()
    if (st.idx !== 0 || st.scrollTop !== 0 || !st.inView) fail(`Home should land on the first tile at the top: ${JSON.stringify({ ...st, names: undefined })}`)
    ok('Home jumps back to the first tile and scrolls to the top')

    // ── Enter inserts exactly as a click does ───────────────────────────────
    await key('ArrowRight')
    st = await grid()
    const viaKeyboard = st.name
    await key('Enter')
    const chips = () =>
      p.evaluate(() =>
        [...(document.getElementById('hs-mc-input')?.querySelectorAll('img.hs-input-emote') || [])].map(
          (i) => (i as HTMLImageElement).alt,
        ),
      )
    if (!(await until(p, async () => (await chips()).includes(viaKeyboard), 5000))) {
      fail(`Enter on the engaged tile ${viaKeyboard} inserted nothing (composer chips: ${JSON.stringify(await chips())})`)
    }
    if (!(await pickerOpen())) fail('Enter closed the picker; a click leaves it open')
    if (!(await composerFocused())) fail('after Enter, focus should be in the composer, as it is after a click')
    ok(`Enter inserts the engaged tile (${viaKeyboard}) as a chip, picker stays open, focus returns to the composer`)

    const clickName = (await grid()).names[3]
    await p.click(`#hs-mc-emote-grid .hs-mc-picker-emote-wrap[data-name="${clickName}"]`)
    if (!(await until(p, async () => (await chips()).includes(clickName), 5000))) {
      fail(`a real mouse click on ${clickName} inserted nothing — the control for the Enter check`)
    }
    ok(`a mouse click on ${clickName} inserts the same kind of chip (the control for Enter)`)

    // ── the SEARCH surface: results replace the grid's contents ─────────────
    await p.click('#hs-mc-emote-search')
    await p.keyboard.type('nav01')
    if (
      !(await until(
        p,
        async () => {
          const g = await grid()
          return g.total > 0 && g.total <= 10 && g.names.every((n: string) => n.includes('nav01'))
        },
        8000,
      ))
    ) {
      fail(`searching "nav01" never narrowed the grid to its matches: ${JSON.stringify((await grid()).names.slice(0, 12))}`)
    }
    const found = await grid()
    if (found.groups !== 0) fail('search results should be one flat list, not the sectioned set')
    if (found.selCount !== 0) fail('typing a query should have released the cursor')
    // text is in the box, so Left/Right/Home/End still edit it until the cursor is engaged
    await key('ArrowLeft')
    const caret = await p.evaluate(() => (document.getElementById('hs-mc-emote-search') as HTMLInputElement).selectionStart)
    if (caret !== 4 || (await grid()).selCount !== 0) {
      fail(`ArrowLeft in a typed query should move the caret (caret ${caret}), not engage the grid`)
    }
    await key('End')
    await key('ArrowDown')
    st = await grid()
    if (st.idx !== 0 || !st.name.startsWith('nav01') || !st.adIsSel || !st.focused) {
      fail(`ArrowDown in search results should engage the first result: ${JSON.stringify({ ...st, names: undefined })}`)
    }
    await key('ArrowRight')
    await key('End')
    st = await grid()
    if (st.idx !== st.total - 1) fail(`End in search results should land on the last result (${st.idx}/${st.total})`)
    await key('Home')
    await key('ArrowRight')
    const pickedFromSearch = (await grid()).name
    await key('Enter')
    if (!(await until(p, async () => (await chips()).includes(pickedFromSearch), 5000))) {
      fail(`Enter on search result ${pickedFromSearch} inserted nothing`)
    }
    ok(`search results work the same: engage, move, Home/End, Enter inserts ${pickedFromSearch}; typed text keeps its caret keys`)

    // Enter with nothing engaged takes the best match, once the grid shows the query.
    await p.fill('#hs-mc-emote-search', 'nav02')
    if (!(await until(p, async () => (await grid()).names.length > 0 && (await grid()).names.every((n: string) => n.includes('nav02')), 8000))) {
      fail('searching "nav02" never narrowed the grid')
    }
    const best = (await grid()).names[0]
    await key('Enter')
    if (!(await until(p, async () => (await chips()).filter((x: string) => x === best).length >= 1, 5000))) {
      fail(`Enter on a typed query with nothing engaged should insert the best match ${best}`)
    }
    ok(`Enter on a typed query inserts the best match (${best})`)

    // ── Escape ──────────────────────────────────────────────────────────────
    await p.click('#hs-mc-emote-search')
    if (!(await searchFocused())) fail('could not put focus back in the search box for the Escape check')
    await key('Escape')
    if (await pickerOpen()) fail('Escape did not close the picker')
    if (!(await until(p, composerFocused, 3000))) fail('Escape closed the picker but did not return focus to the composer')
    ok('Escape closes the picker and returns focus to the composer')
  } finally {
    irc.stop()
    await closeContext(c, 'composer + picker', prof)
    rmSync(prof, { recursive: true, force: true })
  }
}