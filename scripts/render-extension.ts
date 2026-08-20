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
 * Fixtures, one per platform.
 *
 * Each URL is chosen so main.js takes a BODY-MOUNT path and no React tree has
 * to be faked:
 *  - twitch: a non-channel url (no `.channel-root`).
 *  - kick:   a RESERVED path (`/browse`), which main.js treats as non-channel.
 *  - youtube: any url — the yt panel body-mounts on every page by design.
 *
 * The twitch fixture also carries `.right-column.right-column--beside`, because
 * ensureUIElements starts a MutationObserver on that element whose callback
 * re-enters ensureUIElements. That re-entry is the only path that re-runs it
 * without first nulling resizeObserver.
 */
const PLATFORMS = [
  {
    name: 'twitch',
    url: 'https://www.twitch.tv/directory',
    glob: 'https://www.twitch.tv/**',
    body: '<div id="host-content" style="height:100vh">host page</div><div class="right-column right-column--beside" id="rcol"></div>',
    rerender: true,
  },
  {
    name: 'kick',
    url: 'https://kick.com/browse',
    glob: 'https://kick.com/**',
    body: '<div id="host-content" style="height:100vh">host page</div>',
    rerender: false,
  },
  {
    name: 'youtube',
    url: 'https://www.youtube.com/feed/subscriptions',
    glob: 'https://www.youtube.com/**',
    body: '<div id="host-content" style="height:100vh">host page</div>',
    rerender: false,
  },
]

const fixtureHtml = (body: string) =>
  `<!doctype html><html><head><title>fixture</title></head><body style="margin:0">${body}</body></html>`

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
  for (const plat of PLATFORMS) {
    await ctx.route(plat.glob, (r: any) =>
      r.fulfill({ status: 200, contentType: 'text/html', body: fixtureHtml(plat.body) }),
    )
  }

  for (const plat of PLATFORMS) {
    console.log(`\n── ${plat.name} ──`)
    const p = await ctx.newPage()
    p.on('pageerror', (e: unknown) => errors.push(`${plat.name}: ${String(e).slice(0, 300)}`))
    await p.goto(plat.url, { waitUntil: 'domcontentloaded' })

    await p.waitForSelector('#hs-mc-overlay', { timeout: 25_000 }).catch(() => {
      fail(`the overlay never mounted on ${plat.name} — nothing below can be trusted`)
    })
    ok(`${plat.name}: overlay mounts`)

  const g = await geometry(p)
  for (const [name, v] of Object.entries(g)) {
    if (v === null) fail(`#hs-mc-${name} is missing after mount`)
  }
  ok(`${plat.name}: tab bar, overlay, input bar and message list all present`)

  if (!g.hostContent) fail('the host page content was destroyed by the overlay')
  ok(`${plat.name}: the host page's own content survives`)

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
  ok(`${plat.name}: no dead band — overlay ${g.overlay.h}px fills container ${g.container.ch}px minus bars`)

  if (plat.rerender) {
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
    ok(`${plat.name}: bars are rebuilt after the host page tears them out`)

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
    ok(`${plat.name}: no dead band after a rebuild — overlay ${g2.overlay.h}px in container ${g2.container.ch}px`)
  }

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
    if (cov.overflow) fail(`${plat.name} "${pos}" dock: ${cov.overflow}`)
    if (cov.gap > 2) {
      fail(`${plat.name} "${pos}" dock leaves ${cov.gap}px of the container's ${cov.contentH}px uncovered — dead space`)
    }
    // A container fully covered by a collapsed overlay plus something else would
    // still be wrong: chat is the point.
    if (cov.overlayH < cov.contentH * 0.5) {
      fail(`${plat.name} "${pos}" dock: overlay is only ${cov.overlayH}px of ${cov.contentH}px — chat has been squeezed out`)
    }
    ok(`${plat.name}: "${pos}" dock has no dead space (overlay ${cov.overlayH}/${cov.contentH}px)`)
  }
  if (seen.size !== 4) fail(`rotate did not visit all four positions — saw ${[...seen].join(', ')}`)
  ok(`${plat.name}: rotate cycles through all four docking positions`)

  // ── geometry tracks a WRAPPING tab bar ───────────────────────────────────
  // The single most common real layout change: the user adds channels, the tab
  // bar wraps to more rows, and the overlay must give back exactly that much
  // height. This is the scenario the boot-latch bug lived in — the bar measured
  // ~307px mid-boot and settled to 55px, and the overlay kept the first number.
  //
  // Scope, measured not assumed: this asserts the INVARIANT the user feels (a
  // wrapped bar never leaves dead space), not the ResizeObserver specifically.
  // Removing the tab bar from the observer still passes — something else also
  // recomputes on child insertion — so do not read this as a guard on the
  // observer wiring. tests/overlay-layout-observer.test.js holds that line.
  // Only run where the fixture reaches the re-render path.
  if (plat.rerender) {
    for (const n of [6, 16]) {
      const wrapped = await p.evaluate(
        (count: number) =>
          new Promise((done) => {
            const tb = document.getElementById('hs-mc-tabbar')
            const scroll = tb?.querySelector('.hs-mc-tabs-scroll')
            if (!tb || !scroll) return done(null)
            scroll.querySelectorAll('.hs-probe').forEach((e) => e.remove())
            const addBtn = scroll.querySelector('[data-tab="add"]')
            for (let i = 0; i < count; i++) {
              const b = document.createElement('button')
              b.className = 'hs-mc-tab hs-probe'
              b.textContent = `chan${i}`
              scroll.insertBefore(b, addBtn)
            }
            // Let the ResizeObserver fire and the layout settle.
            setTimeout(
              () =>
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => {
                    const c = document.getElementById('hs-mc-container')
                    const cs = getComputedStyle(c)
                    const cr = c.getBoundingClientRect()
                    const top = cr.top + Number.parseFloat(cs.borderTopWidth || '0')
                    const bottom = cr.bottom - Number.parseFloat(cs.borderBottomWidth || '0')
                    const spans: Array<[number, number]> = []
                    for (const el of Array.from(c.children) as HTMLElement[]) {
                      const r = el.getBoundingClientRect()
                      if (r.height > 0 && r.width > 0) spans.push([r.top, r.bottom])
                    }
                    spans.sort((a, b) => a[0] - b[0])
                    let gap = 0
                    let cur = top
                    for (const [a, b] of spans) {
                      if (a > cur) gap += a - cur
                      cur = Math.max(cur, b)
                    }
                    if (cur < bottom) gap += bottom - cur
                    done({ tabbarH: Math.round(tb.getBoundingClientRect().height), gap: Math.round(gap) })
                  }),
                ),
              350,
            )
          }),
        n,
      )
      if (!wrapped) fail('could not reach the tab bar to test wrapping')
      const w = wrapped as { tabbarH: number, gap: number }
      if (w.gap > 2) {
        fail(
          `${plat.name}: with ${n} extra tabs the tab bar is ${w.tabbarH}px and ${w.gap}px of the container is uncovered — ` +
            'the overlay did not give back the height the tab bar took.',
        )
      }
      ok(`${plat.name}: geometry tracks a ${w.tabbarH}px wrapped tab bar (+${n} tabs, no dead space)`)
    }
    await p.evaluate(() => document.querySelectorAll('.hs-probe').forEach((e) => e.remove()))
  }

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
  ok(`${plat.name}: reply context keeps the message on the pixel grid (pill ${smear.pillWidth}px, caret ${smear.caretWidth}px)`)

    await p.close()
  }

  // ── emote effects must survive reduced-motion ────────────────────────────
  // These effects follow the animateEmotes SETTING and deliberately not
  // prefers-reduced-motion — mellen's chromium runs with reduced-motion forced,
  // so any rule keyed on that media query is permanently on for him and would
  // freeze every paint and effect at frame 0.
  //
  // Read duration and iteration-count, NOT animationName: a blanket
  // reduced-motion rule does not null the name, it collapses duration to
  // 0.01ms and iterations to 1. Checking the name reports green on a frozen
  // animation. (Learned the hard way twice today — once by the site session,
  // and once here, where `--force-prefers-reduced-motion` silently did not
  // apply at all and the probe had to assert the condition was active before
  // trusting the result.)
  {
    const rp = await ctx.newPage()
    rp.on('pageerror', (e: unknown) => errors.push(`reduced-motion: ${String(e).slice(0, 300)}`))
    await rp.emulateMedia({ reducedMotion: 'reduce' })
    await rp.goto(PLATFORMS[0].url, { waitUntil: 'domcontentloaded' })
    await rp.waitForSelector('#hs-mc-messages', { timeout: 25_000 })
    const fx = await rp.evaluate(() => {
      const msgs = document.getElementById('hs-mc-messages')
      if (!msgs) return null
      const d = document.createElement('div')
      d.className = 'hs-mc-msg'
      d.innerHTML =
        '<span class="hs-mc-emoji hs-fx-party">\u{1F525}</span>' +
        '<img class="hs-mc-emote hs-fx-party" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">' +
        '<span class="hs-mc-emoji" id="plain">\u{1F525}</span>'
      msgs.appendChild(d)
      const read = (el: Element) => {
        const cs = getComputedStyle(el)
        return { dur: cs.animationDuration, iter: cs.animationIterationCount, name: cs.animationName }
      }
      const out = {
        active: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
        emoji: read(d.querySelector('.hs-mc-emoji.hs-fx-party')),
        emote: read(d.querySelector('img')),
        plain: read(d.querySelector('#plain')),
      }
      d.remove()
      return out
    })
    await rp.close()

    if (!fx) fail('could not reach #hs-mc-messages to test reduced-motion')
    // Assert the CONDITION before trusting the result — a probe that silently
    // ran without reduced-motion would pass while proving nothing.
    if (!fx.active) fail('reduced-motion emulation did not apply — this check would prove nothing')
    for (const [what, m] of [['emoji', fx.emoji], ['emote', fx.emote]] as const) {
      if (!/^\d/.test(m.dur) || Number.parseFloat(m.dur) < 1) {
        fail(`${what} effect collapsed under reduced-motion: duration ${m.dur} (expected the real 1.5s)`)
      }
      if (m.iter !== 'infinite') {
        fail(`${what} effect collapsed under reduced-motion: iterations ${m.iter} (expected infinite)`)
      }
    }
    if (fx.plain.name !== 'none') fail(`an unmodified emoji picked up an animation (${fx.plain.name})`)
    ok(`emote effects survive reduced-motion (${fx.emoji.dur} x ${fx.emoji.iter}, unmodified emoji clean)`)
  }

  // ── the OFF switch must reach everything the effect does ─────────────────
  // animateEmotes is the first-party control for this motion. Its rules were
  // img-scoped while the effects themselves reach emoji, so setting it to
  // "never" left emoji still moving — a control that does not cover what it
  // claims to is worse than no control at all.
  {
    const ap = await ctx.newPage()
    await ap.goto(PLATFORMS[0].url, { waitUntil: 'domcontentloaded' })
    await ap.waitForSelector('#hs-mc-messages', { timeout: 25_000 })
    const sw = await ap.evaluate(() => {
      const msgs = document.getElementById('hs-mc-messages')
      if (!msgs) return null
      const d = document.createElement('div')
      d.className = 'hs-mc-msg'
      d.innerHTML =
        '<span class="hs-mc-emoji hs-fx-party">\u{1F525}</span>' +
        '<img class="hs-mc-emote hs-fx-party" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">'
      msgs.appendChild(d)
      const read = () => ({
        emoji: getComputedStyle(d.querySelector('.hs-mc-emoji') as Element).animationName,
        emote: getComputedStyle(d.querySelector('img') as Element).animationName,
      })
      const prev = document.documentElement.dataset.hsEmoteAnim
      const on = read()
      document.documentElement.dataset.hsEmoteAnim = 'never'
      const off = read()
      if (prev) document.documentElement.dataset.hsEmoteAnim = prev
      else document.documentElement.removeAttribute('data-hs-emote-anim')
      d.remove()
      return { on, off }
    })
    await ap.close()
    if (!sw) fail('could not reach #hs-mc-messages to test the animation switch')
    if (sw.on.emoji === 'none' || sw.on.emote === 'none') {
      fail(`effects are not running by default (emoji ${sw.on.emoji}, emote ${sw.on.emote})`)
    }
    if (sw.off.emote !== 'none') fail(`animateEmotes:never did not stop an emote (${sw.off.emote})`)
    if (sw.off.emoji !== 'none') {
      fail(`animateEmotes:never did not stop an EMOJI (${sw.off.emoji}) — the control is img-scoped again`)
    }
    ok('animateEmotes:never stops both an emote and an emoji')
  }

  // ── the instrumentation must not cry wolf ────────────────────────────────
  // diag.js reports selector rot and host-CSP blocks into the error ring
  // buffer, which the popup surfaces as "copy errors". That buffer holds 50
  // entries. If either reporter fires during ORDINARY operation, it evicts the
  // real errors it exists to preserve and trains the user to ignore it — a
  // false positive here is worse than no instrumentation at all.
  //
  // Read from the extension's own page, because chrome.storage is unreachable
  // from the host page's world.
  const worker = ctx.serviceWorkers()[0]
  const extId = worker?.url().match(/chrome-extension:\/\/([a-p]+)\//)?.[1]
  if (!extId) fail('could not resolve the extension id to read its error buffer')

  const ep = await ctx.newPage()
  await ep.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'load' })
  const buffered: Array<{ type?: string, msg?: string }> = await ep.evaluate(
    () =>
      new Promise((res) => {
        try {
          // @ts-ignore — extension page
          chrome.storage.local.get('hs_errors', (v: any) => res(v?.hs_errors || []))
        } catch (_) {
          res([])
        }
      }),
  )
  await ep.close()

  const rot = buffered.filter((e) => (e.msg || '').includes('selector stopped matching'))
  const csp = buffered.filter((e) => (e.msg || '').includes('host page CSP blocked'))
  if (rot.length) {
    fail(`selector-rot reporter fired during normal operation — false positives:\n  ${rot.map((e) => e.msg).join('\n  ')}`)
  }
  if (csp.length) {
    fail(`CSP reporter fired during normal operation — false positives:\n  ${csp.map((e) => e.msg).join('\n  ')}`)
  }
  ok(`instrumentation stayed quiet (${buffered.length} buffered entries, none from diag)`)
  if (buffered.length) {
    console.log(`  note: ${buffered.length} non-diag entries in the buffer:`)
    for (const e of buffered.slice(0, 6)) console.log(`    [${e.type}] ${(e.msg || '').slice(0, 150)}`)
  }

  if (errors.length) fail(`runtime errors:\n  ${errors.join('\n  ')}`)
  console.log(`\n✓ render checks passed — ${checks.length} assertions`)
} catch (e) {
  console.error(`\n✗ render checks FAILED: ${(e as Error).message}`)
  process.exitCode = 1
} finally {
  await ctx?.close().catch(() => {})
  rmSync(profile, { recursive: true, force: true })
}
