/**
 * Assert the overlay's real geometry in a real browser.
 *
 *   bun run test:render
 *
 * Why this exists: 143 of 145 test files never touch a DOM. The suite asserts
 * that source text contains expected substrings, which is a drift tripwire, not
 * a safety net — and every expensive bug in this project's history has been a
 * RENDERING bug found by eye, days later. Chip smear, blurry text, paints frozen
 * at frame 0, white video, the player-collapse trio, and an overlay showing an
 * inch of chat. Not one of them was catchable by grepping source.
 *
 * How it gets a page: Chrome matches content scripts on URL, not on who served
 * the bytes. So the request for a twitch URL is fulfilled locally with a
 * fixture, the page URL stays `https://www.twitch.tv/...`, and the extension
 * injects for real. A NON-CHANNEL twitch url is used deliberately — main.js has
 * a body-mount path for those (`Twitch non-channel page — body-mount overlay`),
 * so no React tree has to be faked.
 *
 * heatsync.org is routed to abort: the harness must never depend on, or write
 * to, production.
 *
 * Opt-in, like smoke-extension.ts: it needs a real browser binary, which the
 * unit suite deliberately does not depend on.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertBuilt, launchWithExtension } from './lib/chromium'

/**
 * Deliberately shaped:
 *  - NO `.channel-root`, so main.js takes its body-mount path and no React tree
 *    has to be faked.
 *  - WITH `.right-column.right-column--beside`, because ensureUIElements starts
 *    a MutationObserver on that element (attributes: class/style) whose callback
 *    calls ensureUIElements AGAIN. That re-entry — not the container-missing
 *    reinject — is the path the boot-latch bug lives on, and it is the only one
 *    that re-runs ensureUIElements without first nulling resizeObserver.
 */
const FIXTURE = `<!doctype html><html><head><title>fixture</title></head>
<body style="margin:0">
  <div id="host-content" style="height:100vh">host page</div>
  <div class="right-column right-column--beside" id="rcol"></div>
</body></html>`

const profile = mkdtempSync(join(tmpdir(), 'hs-ext-render-'))
const errors: string[] = []
const checks: string[] = []
let ctx: any = null

function ok(msg: string) {
  checks.push(msg)
  console.log(`✓ ${msg}`)
}
function fail(msg: string): never {
  throw new Error(msg)
}

/** Read every box the layout code writes, in one pass. */
async function geometry(p: any) {
  return p.evaluate(() => {
    const box = (id: string) => {
      const el = document.getElementById(id)
      if (!el) return null
      const r = el.getBoundingClientRect()
      return {
        h: Math.round(r.height),
        w: Math.round(r.width),
        // Content box. #hs-mc-container carries a 4px border under
        // box-sizing:border-box, so its border-box width is NOT the space its
        // children get — comparing against it makes a correct layout look 4px
        // short in the side docks.
        cw: el.clientWidth,
        ch: el.clientHeight,
        top: el.style.top || '',
        bottom: el.style.bottom || '',
      }
    }
    return {
      container: box('hs-mc-container'),
      tabbar: box('hs-mc-tabbar'),
      overlay: box('hs-mc-overlay'),
      inputbar: box('hs-mc-inputbar'),
      messages: box('hs-mc-messages'),
      hostContent: !!document.getElementById('host-content'),
    }
  })
}

try {
  assertBuilt()
  ctx = await launchWithExtension(profile, ['--window-size=1600,900'])
  ctx.on('page', (p: any) => p.on('pageerror', (e: unknown) => errors.push(`page: ${String(e).slice(0, 300)}`)))

  // Never touch production from a test.
  await ctx.route('https://heatsync.org/**', (r: any) => r.abort())
  await ctx.route('https://www.twitch.tv/**', (r: any) =>
    r.fulfill({ status: 200, contentType: 'text/html', body: FIXTURE }),
  )

  const p = await ctx.newPage()
  p.on('pageerror', (e: unknown) => errors.push(`page: ${String(e).slice(0, 300)}`))
  await p.goto('https://www.twitch.tv/directory', { waitUntil: 'domcontentloaded' })

  await p.waitForSelector('#hs-mc-overlay', { timeout: 20_000 }).catch(() => {
    fail('the overlay never mounted on a twitch page — nothing below can be trusted')
  })
  ok('overlay mounts on a twitch page')

  const g = await geometry(p)
  for (const [name, v] of Object.entries(g)) {
    if (v === null) fail(`#hs-mc-${name} is missing after mount`)
  }
  ok('tab bar, overlay, input bar and message list all present')

  if (!g.hostContent) fail('the host page content was destroyed by the overlay')
  ok("the host page's own content survives")

  // ── the invariant: no dead band ──────────────────────────────────────────
  // The overlay must fill the container minus the two bars. This is what the
  // boot-latch bug broke: 510px of chat inside an 828px space, with 318px of
  // nothing beneath it, because the overlay kept a stale inset.
  const expected = g.container.ch - g.tabbar.h - g.inputbar.h
  const drift = Math.abs(g.overlay.h - expected)
  if (drift > 2) {
    fail(
      `overlay height ${g.overlay.h}px but container(${g.container.ch}) - tabbar(${g.tabbar.h}) - input(${g.inputbar.h}) = ${expected}px — ${drift}px of dead space`,
    )
  }
  ok(`no dead band: overlay ${g.overlay.h}px fills container ${g.container.ch}px minus bars`)

  // ── the invariant survives a platform re-render ─────────────────────────
  // What this proves: the extension rebuilds its bars when the host page tears
  // them out, and the no-dead-band invariant above still holds afterwards.
  //
  // What it does NOT prove, stated plainly so nobody reads more into it: this
  // is not a regression test for the boot-latch bug. That bug needs a stale
  // ResizeObserver to survive across a rebuild, and it could not be reproduced
  // here — removing overlay nodes trips main.js's own reinject path, which
  // nulls resizeObserver before rebuilding and therefore self-heals. Measured,
  // not assumed: instrumenting the ResizeObserver constructor showed both the
  // fixed and the pre-fix build constructing a fresh observer on re-entry.
  // The `!resizeObserver` shape is still guarded, by
  // tests/overlay-layout-observer.test.js as a source contract.
  await p.evaluate(() => {
    document.getElementById('hs-mc-tabbar')?.remove()
    document.getElementById('hs-mc-inputbar')?.remove()
  })
  await p.evaluate(() => {
    const rc = document.getElementById('rcol')
    if (!rc) throw new Error('fixture lost its .right-column')
    rc.classList.add('right-column--nudge')
    rc.style.opacity = '0.99'
  })

  await p
    .waitForFunction(() => !!document.getElementById('hs-mc-tabbar'), null, { timeout: 15_000 })
    .catch(() => fail('the tab bar was never rebuilt after the host page removed it'))
  ok('bars are rebuilt after the host page tears them out')

  // Let the rebuild settle, then re-run the same measurement that bites.
  await p.waitForTimeout(1000)
  const g2 = await geometry(p)
  for (const [name, v] of Object.entries(g2)) {
    if (v === null) fail(`#hs-mc-${name} is missing after the rebuild`)
  }
  const expected2 = g2.container.ch - g2.tabbar.h - g2.inputbar.h
  const drift2 = Math.abs(g2.overlay.h - expected2)
  if (drift2 > 2) {
    fail(
      `after a rebuild the overlay is ${g2.overlay.h}px but container(${g2.container.ch}) - tabbar(${g2.tabbar.h}) - input(${g2.inputbar.h}) = ${expected2}px — ${drift2}px of dead space`,
    )
  }
  ok(`no dead band after a rebuild: overlay ${g2.overlay.h}px in container ${g2.container.ch}px`)

  // ── every docking position ───────────────────────────────────────────────
  // _updateMcLayout has four branches — top/right/bottom/left each write a
  // different set of insets — and only the default one was covered above.
  // Layout is this project's most expensive bug class, so all four get measured.
  //
  // Driven through the extension's own supported rotate message (main.js listens
  // for 'heatsync-rotate-tabs' from the page's own origin), not by poking
  // internals, so the test exercises the real path a user takes.
  const rotate = async () => {
    await p.evaluate(() => window.postMessage({ type: 'heatsync-rotate-tabs' }, location.origin))
    await p.waitForTimeout(600)
    return p.evaluate(() => {
      const c = [...document.body.classList].find((x) => x.startsWith('hs-tabs-'))
      return c ? c.replace('hs-tabs-', '') : '?'
    })
  }

  /**
   * Position-agnostic dead-space check.
   *
   * Naming each child in a formula is too brittle — the emote picker takes 12px
   * in the bottom dock and 0 in the top, and the next element added would break
   * the test rather than the layout. What actually matters is the property the
   * boot-latch bug violated: the container's content box must be fully covered
   * by its visible children, with nothing spilling outside it.
   */
  const coverage = () =>
    p.evaluate(() => {
      const c = document.getElementById('hs-mc-container')
      if (!c) return null
      const cr = c.getBoundingClientRect()
      const cs = getComputedStyle(c)
      const top = cr.top + Number.parseFloat(cs.borderTopWidth || '0')
      const bottom = cr.bottom - Number.parseFloat(cs.borderBottomWidth || '0')
      const left = cr.left + Number.parseFloat(cs.borderLeftWidth || '0')
      const right = cr.right - Number.parseFloat(cs.borderRightWidth || '0')

      const spans: Array<[number, number]> = []
      let overflow: string | null = null
      let overlayH = 0
      for (const el of Array.from(c.children) as HTMLElement[]) {
        const r = el.getBoundingClientRect()
        if (r.height <= 0 || r.width <= 0) continue
        if (el.id === 'hs-mc-overlay') overlayH = r.height
        if (r.top < top - 2 || r.bottom > bottom + 2 || r.left < left - 2 || r.right > right + 2) {
          overflow = `${el.id || el.className} spills outside the container`
        }
        spans.push([r.top, r.bottom])
      }
      // Merge the vertical spans and measure what the container is NOT covered by.
      spans.sort((a, b) => a[0] - b[0])
      let gap = 0
      let cursor = top
      for (const [a, b] of spans) {
        if (a > cursor) gap += a - cursor
        cursor = Math.max(cursor, b)
      }
      if (cursor < bottom) gap += bottom - cursor
      return { gap: Math.round(gap), overflow, contentH: Math.round(bottom - top), overlayH: Math.round(overlayH) }
    })

  const seen = new Set<string>()
  for (let i = 0; i < 4; i++) {
    const pos = await rotate()
    if (pos === '?') fail('no hs-tabs-* class on body — cannot tell which docking position is active')
    seen.add(pos)
    const cov = await coverage()
    if (!cov) fail(`the container vanished in the "${pos}" position`)
    if (cov.overflow) fail(`"${pos}" dock: ${cov.overflow}`)
    if (cov.gap > 2) {
      fail(`"${pos}" dock leaves ${cov.gap}px of the container's ${cov.contentH}px uncovered — dead space`)
    }
    // A container fully covered by a collapsed overlay plus something else would
    // still be wrong: chat is the point.
    if (cov.overlayH < cov.contentH * 0.5) {
      fail(`"${pos}" dock: overlay is only ${cov.overlayH}px of ${cov.contentH}px — chat has been squeezed out`)
    }
    ok(`"${pos}" dock: no dead space, overlay ${cov.overlayH}/${cov.contentH}px`)
  }
  if (seen.size !== 4) fail(`rotate did not visit all four positions — saw ${[...seen].join(', ')}`)
  ok('rotate cycles through all four docking positions')

  // ── bitmap crispness: the reply context must not smear the message ───────
  // CozetteVector is a 6x13 bitmap cell. It is crisp only when a glyph starts
  // on a whole pixel, so anything inline BEFORE the message text leaks its
  // advance into every glyph after it. The reply pill is an inline-block, so a
  // fractional child made the pill fractional and put the entire message on a
  // sub-pixel x — measured 0.625 with a reply, 0 without. That is invisible to
  // every other kind of test in this repo: the DOM is correct, the CSS is
  // correct, and the only symptom is that the letters look soft.
  //
  // The markup is copied verbatim from the reply-bar builder in main.js, and
  // the assertion below pins that it has not drifted from the renderer.
  const smear = await p.evaluate(() => {
    const msgs = document.getElementById('hs-mc-messages')
    if (!msgs) return null
    const keep = msgs.innerHTML
    const TAIL = 'florida is building charging stations for flying car launch pads'
    const pill =
      '<span class="hs-mc-reply-ctx" role="button" tabindex="0" aria-expanded="false" title="dongblob: hi">&#8618;' +
      '<a href="https://heatsync.org/user/dongblob" class="hs-mc-user hs-mc-reply-user" data-username="dongblob">@dongblob</a>' +
      '<span class="hs-mc-reply-caret" aria-hidden="true"></span></span> '
    const mk = (html: string) => {
      const d = document.createElement('div')
      d.className = 'hs-mc-msg'
      d.innerHTML = `<span class="hs-mc-user">mellen</span>: ${html}`
      msgs.appendChild(d)
      return d
    }
    const withReply = mk(pill + TAIL)
    const plain = mk(TAIL)
    const tailFrac = (el: HTMLElement) => {
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      let n: Node | null
      let last: Node | null = null
      while ((n = w.nextNode())) if ((n.textContent || '').trim().length > 3) last = n
      if (!last) return null
      const r = document.createRange()
      r.setStart(last, 0)
      r.setEnd(last, 1)
      return +(r.getBoundingClientRect().x % 1).toFixed(3)
    }
    const caret = withReply.querySelector('.hs-mc-reply-caret') as HTMLElement
    const pillEl = withReply.querySelector('.hs-mc-reply-ctx') as HTMLElement
    const out = {
      withReply: tailFrac(withReply),
      plain: tailFrac(plain),
      pillWidth: +pillEl.getBoundingClientRect().width.toFixed(3),
      caretWidth: +caret.getBoundingClientRect().width.toFixed(3),
      caretPx: getComputedStyle(caret).fontSize,
      pillPx: getComputedStyle(pillEl).fontSize,
    }
    msgs.innerHTML = keep
    return out
  })

  if (!smear) fail('could not reach #hs-mc-messages to measure bitmap crispness')
  if (smear.plain !== 0) {
    fail(`plain message text is already off the pixel grid (x-fraction ${smear.plain}) — the baseline is broken`)
  }
  if (smear.withReply !== 0) {
    fail(
      `a reply context smears the message: text starts at x-fraction ${smear.withReply} (plain text is ${smear.plain}). ` +
        `Reply pill is ${smear.pillWidth}px, caret ${smear.caretWidth}px at ${smear.caretPx}. ` +
        'CozetteVector is a bitmap face — a fractional advance before the text makes every glyph after it soft.',
    )
  }
  if (smear.caretWidth % 1 !== 0) {
    fail(`the reply caret has a fractional advance (${smear.caretWidth}px at ${smear.caretPx}) — it will smear whatever follows it`)
  }
  ok(`reply context keeps the message on the pixel grid (pill ${smear.pillWidth}px, caret ${smear.caretWidth}px)`)

  if (errors.length) fail(`runtime errors:\n  ${errors.join('\n  ')}`)
  console.log(`\n✓ render checks passed — ${checks.length} assertions`)
} catch (e) {
  console.error(`\n✗ render checks FAILED: ${(e as Error).message}`)
  process.exitCode = 1
} finally {
  await ctx?.close().catch(() => {})
  rmSync(profile, { recursive: true, force: true })
}
