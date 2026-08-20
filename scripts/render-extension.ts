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
  const expected = g.container.h - g.tabbar.h - g.inputbar.h
  const drift = Math.abs(g.overlay.h - expected)
  if (drift > 2) {
    fail(
      `overlay height ${g.overlay.h}px but container(${g.container.h}) - tabbar(${g.tabbar.h}) - input(${g.inputbar.h}) = ${expected}px — ${drift}px of dead space`,
    )
  }
  ok(`no dead band: overlay ${g.overlay.h}px fills container ${g.container.h}px minus bars`)

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
  const expected2 = g2.container.h - g2.tabbar.h - g2.inputbar.h
  const drift2 = Math.abs(g2.overlay.h - expected2)
  if (drift2 > 2) {
    fail(
      `after a rebuild the overlay is ${g2.overlay.h}px but container(${g2.container.h}) - tabbar(${g2.tabbar.h}) - input(${g2.inputbar.h}) = ${expected2}px — ${drift2}px of dead space`,
    )
  }
  ok(`no dead band after a rebuild: overlay ${g2.overlay.h}px in container ${g2.container.h}px`)

  if (errors.length) fail(`runtime errors:\n  ${errors.join('\n  ')}`)
  console.log(`\n✓ render checks passed — ${checks.length} assertions`)
} catch (e) {
  console.error(`\n✗ render checks FAILED: ${(e as Error).message}`)
  process.exitCode = 1
} finally {
  await ctx?.close().catch(() => {})
  rmSync(profile, { recursive: true, force: true })
}
