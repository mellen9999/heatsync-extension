import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchWithExtension } from '../lib/chromium'
import { startMockIrc } from '../lib/mock-irc'
import { ONE_PX_PNG, PLATFORMS, closeContext, errors, fail, fixtureHtml, ok, until } from './lib'

/**
 * The chat, for someone who never touches the mouse or can't see the screen.
 *
 * Reply, mute, mod and profile lived behind a right-click and nowhere else, and
 * the right-click menu was a pile of divs. Every contract below is one a source
 * grep can say nothing true about, because it is about focus, painted colour
 * and what the browser does with keys:
 *
 *  1. ROW MODE — alt+r from the composer puts a cursor on the newest row. It is
 *     REAL focus (that is what a screen reader reads), painted reverse video,
 *     and j/k move it. It stays on its row while new messages land.
 *  2. THE MENU — enter opens the row's right-click menu as an ARIA menu with
 *     focus inside it; arrows move; esc closes it and focus goes back to the row.
 *  3. REPLY — r leaves the mode and drops you into the composer, replying.
 *  4. TYPING ALWAYS TYPES — leaving by esc returns focus to the composer, and
 *     clicking back into it ends the mode, so "jk" is text, not motion.
 *  5. A TAB'S MENU MOVES IT — right-click a tab, "move right", and the strip
 *     reorders (and an end tab is only offered the one way it can go).
 *  6. SCREEN READER MODES — the log is a polite live region by default; the
 *     setting "mentions only" silences it and a separate polite region says
 *     just the lines that @ you; flipping the setting takes effect live.
 */
export async function rowKeysCheck() {
  console.log('\n── row mode, the row menu, the tab menu, screen reader modes ──')
  const irc = startMockIrc()
  if (!irc) {
    console.log('  ! SKIPPED — openssl not available, so there is no live chat to walk a cursor over.')
    console.log('    keyboard row access is going UNVERIFIED in this run.')
    return
  }

  const prof = mkdtempSync(join(tmpdir(), 'hs-ext-rowkeys-'))
  const c = await launchWithExtension(prof, [
    '--window-size=1500,900',
    `--host-resolver-rules=MAP irc-ws.chat.twitch.tv 127.0.0.1:${irc.port}`,
    '--ignore-certificate-errors',
    '--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests',
  ])
  try {
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
    if (!id) fail('could not resolve the extension id for the row-keys check')

    const seed = await c.newPage()
    await seed.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'load' })
    await seed.evaluate(async () => {
      // @ts-ignore — extension page
      await chrome.storage.local.set({
        heatsync_multichat: {
          channels: [
            { id: 'probechan', twitch: 'probechan', kick: '', youtube: '' },
            { id: 'otherchan', twitch: 'otherchan', kick: '', youtube: '' },
          ],
        },
        user_info: { username: 'probeuser' },
      })
    })
    const setSetting = (key: string, value: string) =>
      seed.evaluate(
        async ([k, v]: string[]) => {
          // @ts-ignore — extension page
          await chrome.storage.local.set({ [k]: v })
        },
        [key, value],
      )

    const p = await c.newPage()
    p.on('pageerror', (e: unknown) => errors.push(`rowkeys: ${String(e).slice(0, 300)}`))
    await p.goto('https://www.twitch.tv/probechan', { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('#hs-mc-input', { timeout: 25_000 })

    let n = 0
    const say = (user: string, text: string) =>
      irc.push(
        `@display-name=${user};color=#00FF00;user-id=${100 + n};id=rk${++n} ` +
          `:${user.toLowerCase()}!u@u.tmi.twitch.tv PRIVMSG #probechan :${text}\r\n`,
      )
    const rowCount = () => p.evaluate(() => document.querySelectorAll('#hs-mc-messages > .hs-mc-msg').length)
    const waitRows = async (want: number, what: string) => {
      await until(p, async () => (await rowCount()) >= want, 15_000)
      if ((await rowCount()) < want) fail(`${what}: expected ${want} rows, have ${await rowCount()}`)
    }
    // the row that holds focus, as text + whether it wears the cursor
    const at = () =>
      p.evaluate(() => {
        const a = document.activeElement as HTMLElement | null
        return {
          text: (a?.textContent || '').replace(/\s+/g, ' ').trim(),
          cursor: !!a?.classList?.contains('hs-mc-row-cursor'),
          id: a?.id || '',
          role: a?.getAttribute?.('role') || '',
        }
      })
    const cursors = () => p.evaluate(() => document.querySelectorAll('.hs-mc-row-cursor').length)
    const press = async (k: string) => {
      await p.keyboard.press(k)
      await p.waitForTimeout(120)
    }

    // the socket must have joined the channel before anything is pushed down it
    await until(p, async () => irc.frames.some((f: string) => /JOIN #probechan/i.test(f)), 25_000)
    await p.waitForTimeout(500)

    // ── 1. row mode ─────────────────────────────────────────────────────────
    say('Alice', 'first line')
    say('Bob', 'second line')
    say('Carol', 'third line')
    await waitRows(3, 'three chat lines')

    const log = await p.evaluate(() => {
      const l = document.getElementById('hs-mc-messages')
      const m = document.getElementById('hs-mc-sr-mentions')
      const r = m?.getBoundingClientRect()
      return {
        role: l?.getAttribute('role'),
        live: l?.getAttribute('aria-live'),
        mRole: m?.getAttribute('role'),
        mLive: m?.getAttribute('aria-live'),
        mW: r ? Math.round(r.width) : -1,
        mH: r ? Math.round(r.height) : -1,
      }
    })
    if (log.role !== 'log' || log.live !== null) {
      fail(`by default the message log is a plain polite live region: ${JSON.stringify(log)}`)
    }
    if (log.mRole !== 'log' || log.mLive !== 'polite' || log.mW > 1 || log.mH > 1) {
      fail(`the mentions region must exist, be polite, and take no room: ${JSON.stringify(log)}`)
    }
    ok('screen reader default: the log is a polite live region, the mentions region is there and takes no room')

    await p.click('#hs-mc-input')
    await p.keyboard.press('Alt+r')
    await until(p, async () => (await cursors()) === 1, 5000)
    const first = await at()
    if ((await cursors()) !== 1 || !first.cursor || !first.text.includes('third line')) {
      fail(`alt+r from the composer should put the cursor, and focus, on the NEWEST row: ${JSON.stringify(first)}`)
    }
    ok('alt+r from the composer: the cursor is on the newest row and that row holds real focus')

    const paint = await p.evaluate(() => {
      const row = document.querySelector('.hs-mc-row-cursor') as HTMLElement
      const name = row.querySelector('.hs-mc-user') as HTMLElement | null
      return {
        bg: getComputedStyle(row).backgroundColor,
        fg: getComputedStyle(row).color,
        name: name ? getComputedStyle(name).color : 'none',
        tag: document.querySelector('.hs-mc-tabmode-tag')?.textContent || '',
        hint: document.querySelector('.hs-mc-tabmode-hint')?.textContent || '',
      }
    })
    if (paint.bg !== 'rgb(0, 255, 255)' || paint.fg !== 'rgb(0, 0, 0)' || (paint.name !== 'none' && paint.name !== 'rgb(0, 0, 0)')) {
      fail(`the cursor row must be reverse video, name included (cyan plate, black text): ${JSON.stringify(paint)}`)
    }
    if (paint.tag !== '-- ROWS --' || !paint.hint.startsWith('3/3')) {
      fail(`the mode line should say -- ROWS -- and the position: ${JSON.stringify(paint)}`)
    }
    ok(`the cursor row is reverse video and the mode line reads "${paint.tag} ${paint.hint}"`)

    await press('k')
    if (!(await at()).text.includes('second line') || (await cursors()) !== 1) {
      fail(`k should move the cursor up one row: ${JSON.stringify(await at())}`)
    }
    await press('ArrowUp')
    if (!(await at()).text.includes('first line')) fail(`ArrowUp should move up too: ${JSON.stringify(await at())}`)
    await press('j')
    if (!(await at()).text.includes('second line')) fail(`j should move back down: ${JSON.stringify(await at())}`)
    ok('k / ArrowUp / j move the cursor, one row at a time, exactly one cursor')

    say('Dave', 'fourth line')
    await waitRows(4, 'a fourth chat line')
    await p.waitForTimeout(400)
    const stay = await at()
    if (!stay.text.includes('second line') || !stay.cursor || (await cursors()) !== 1) {
      fail(`a new message must not move the cursor off its row (rows never move): ${JSON.stringify(stay)}`)
    }
    ok('a new message arrives and the cursor stays on its row')

    // ── 2. the menu ─────────────────────────────────────────────────────────
    await press('Enter')
    await p.waitForSelector('#hs-mc-msg-ctx', { timeout: 5000 })
    const menu = await p.evaluate(() => {
      const m = document.getElementById('hs-mc-msg-ctx') as HTMLElement
      const a = document.activeElement as HTMLElement | null
      return {
        role: m.getAttribute('role'),
        name: m.getAttribute('aria-label') || '',
        items: m.querySelectorAll('[role="menuitem"]').length,
        focusInside: !!a && m.contains(a),
        focusRole: a?.getAttribute('role') || '',
        focusText: (a?.textContent || '').trim(),
      }
    })
    if (menu.role !== 'menu' || !menu.name || menu.items < 2 || !menu.focusInside || menu.focusRole !== 'menuitem') {
      fail(`enter on a row must open an ARIA menu with focus on an item: ${JSON.stringify(menu)}`)
    }
    ok(`enter opens the row's menu: role=menu, named "${menu.name}", ${menu.items} items, focus on "${menu.focusText}"`)

    await press('ArrowDown')
    const moved = (await at()).text
    if (moved === menu.focusText || (await at()).role !== 'menuitem') {
      fail(`ArrowDown should move focus to the next menu item (was "${menu.focusText}", now "${moved}")`)
    }
    await press('Escape')
    const back = await at()
    const gone = await p.evaluate(() => !document.getElementById('hs-mc-msg-ctx'))
    if (!gone || !back.cursor || !back.text.includes('second line')) {
      fail(`esc should close the menu and give focus back to the row: gone=${gone} ${JSON.stringify(back)}`)
    }
    ok('arrows move inside the menu; esc closes it and focus goes back to the row')

    // ── 3. reply ────────────────────────────────────────────────────────────
    await press('r')
    await p.waitForSelector('#hs-mc-reply-indicator', { timeout: 5000 })
    const reply = await p.evaluate(() => ({
      text: document.getElementById('hs-mc-reply-indicator')?.textContent || '',
      focus: document.activeElement?.id || '',
      cursors: document.querySelectorAll('.hs-mc-row-cursor').length,
    }))
    if (!/bob/i.test(reply.text) || reply.focus !== 'hs-mc-input' || reply.cursors !== 0) {
      fail(`r should reply to the row under the cursor, leave the mode and land in the composer: ${JSON.stringify(reply)}`)
    }
    ok(`r replies to the row under the cursor ("${reply.text.trim()}") and the composer has focus`)
    await p.click('#hs-mc-reply-cancel')

    // ── 4. typing always types ──────────────────────────────────────────────
    await p.click('#hs-mc-input')
    await p.keyboard.press('Alt+r')
    await until(p, async () => (await cursors()) === 1, 5000)
    await press('Escape')
    const out = await p.evaluate(() => ({
      cursors: document.querySelectorAll('.hs-mc-row-cursor').length,
      focus: document.activeElement?.id || '',
    }))
    if (out.cursors !== 0 || out.focus !== 'hs-mc-input') {
      fail(`esc leaves row mode and hands focus back to the composer it came from: ${JSON.stringify(out)}`)
    }
    ok('esc leaves row mode and focus returns to the composer')

    await p.keyboard.press('Alt+r')
    await until(p, async () => (await cursors()) === 1, 5000)
    await p.click('#hs-mc-input')
    await p.keyboard.type('jkr')
    await p.waitForTimeout(150)
    const typed = await p.evaluate(() => ({
      text: (document.getElementById('hs-mc-input')?.textContent || '').trim(),
      cursors: document.querySelectorAll('.hs-mc-row-cursor').length,
    }))
    if (typed.text !== 'jkr' || typed.cursors !== 0) {
      fail(`clicking back into the composer must end the mode so letters are TEXT: ${JSON.stringify(typed)}`)
    }
    ok('click back into the composer while in row mode: "jkr" is typed as text, the mode is over')
    await p.evaluate(() => {
      const i = document.getElementById('hs-mc-input')
      if (i) i.innerHTML = ''
    })

    // ── 5. the tab's menu ───────────────────────────────────────────────────
    const order = () =>
      p.evaluate(() =>
        [...document.querySelectorAll('.hs-mc-tabs-scroll .hs-mc-tab')]
          .map((t) => (t as HTMLElement).dataset.tab || '')
          .filter((t) => t === 'probechan' || t === 'otherchan'),
      )
    const tabMenu = async (tab: string) => {
      await p.click(`.hs-mc-tab[data-tab="${tab}"]`, { button: 'right' })
      await p.waitForSelector('#hs-mc-ctx-menu', { timeout: 5000 })
      return p.evaluate(() =>
        [...document.querySelectorAll('#hs-mc-ctx-menu [role="menuitem"]')].map((i) => (i.textContent || '').trim()),
      )
    }
    if ((await order()).join() !== 'probechan,otherchan') fail(`unexpected starting tab order: ${await order()}`)
    const firstMenu = await tabMenu('probechan')
    if (firstMenu.join('|') !== 'edit|move right|remove') {
      fail(`the first tab's menu offers edit, move right (it has nowhere left to go), remove: ${firstMenu.join('|')}`)
    }
    await p.click('#hs-mc-ctx-menu [role="menuitem"]:nth-child(2)')
    await until(p, async () => (await order()).join() === 'otherchan,probechan', 5000)
    if ((await order()).join() !== 'otherchan,probechan') {
      fail(`"move right" should put probechan after otherchan: ${await order()}`)
    }
    const lastMenu = await tabMenu('probechan')
    if (lastMenu.join('|') !== 'edit|move left|remove') {
      fail(`now the last tab: edit, move left, remove — got ${lastMenu.join('|')}`)
    }
    await p.click('#hs-mc-ctx-menu [role="menuitem"]:nth-child(2)')
    await until(p, async () => (await order()).join() === 'probechan,otherchan', 5000)
    if ((await order()).join() !== 'probechan,otherchan') fail(`"move left" should undo it: ${await order()}`)
    ok('right-click a tab: "move right" / "move left" reorder the strip; an end tab is only offered its one way')

    // ── 6. screen reader modes ──────────────────────────────────────────────
    await setSetting('hs_sr_announce', 'mentions')
    await p.reload({ waitUntil: 'domcontentloaded' })
    await p.waitForSelector('#hs-mc-input', { timeout: 25_000 })
    say('Erin', 'just chatting')
    await waitRows(1, 'a line after the reload')
    const quiet = await p.evaluate(() => ({
      live: document.getElementById('hs-mc-messages')?.getAttribute('aria-live'),
      said: (document.getElementById('hs-mc-sr-mentions')?.textContent || '').trim(),
    }))
    if (quiet.live !== 'off' || quiet.said !== '') {
      fail(`mentions only: the log is silent and the region says nothing for a plain line: ${JSON.stringify(quiet)}`)
    }
    say('Frank', '@probeuser are you there')
    await until(
      p,
      async () => (await p.evaluate(() => document.getElementById('hs-mc-sr-mentions')?.children.length || 0)) > 0,
      10_000,
    )
    const said = await p.evaluate(() => ({
      lines: [...(document.getElementById('hs-mc-sr-mentions')?.children || [])].map((x) => x.textContent || ''),
      live: document.getElementById('hs-mc-messages')?.getAttribute('aria-live'),
    }))
    if (said.lines.length !== 1 || !/Frank mentioned you: @probeuser are you there/.test(said.lines[0]) || said.live !== 'off') {
      fail(`mentions only: exactly the mention is said, through the region: ${JSON.stringify(said)}`)
    }
    ok(`mentions only: the log is silent, the region says "${said.lines[0]}" and nothing for plain chat`)

    await setSetting('hs_sr_announce', 'all')
    await until(
      p,
      async () => (await p.evaluate(() => document.getElementById('hs-mc-messages')?.getAttribute('aria-live'))) === null,
      10_000,
    )
    const live = await p.evaluate(() => ({
      live: document.getElementById('hs-mc-messages')?.getAttribute('aria-live'),
      left: document.getElementById('hs-mc-sr-mentions')?.children.length,
    }))
    if (live.live !== null || live.left !== 0) {
      fail(`switching back to "all" takes effect live and empties the mentions region: ${JSON.stringify(live)}`)
    }
    ok('switching the setting back to "all" takes effect live: the log is polite again, the region is emptied')
  } finally {
    irc.stop()
    await closeContext(c, 'row-keys', prof)
    rmSync(prof, { recursive: true, force: true })
  }
}
