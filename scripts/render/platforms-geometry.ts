import { join } from 'node:path'
import { PLATFORMS, errors, fail, fixtureHtml, ok, stable, until } from './lib'

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

export async function platformsGeometry(ctx: any) {
  // Never touch production from a test.
  await ctx.route('https://heatsync.org/**', (r: any) => r.abort())
  for (const plat of PLATFORMS) {
    await ctx.route(plat.glob, (r: any) => {
      // a kick channel page asks kick's api for the channel/chatroom ids;
      // answer as json so the mount path sees a real channel, not html
      const u = r.request().url()
      if (u.includes('/api/v2/channels/')) {
        return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 111, chatroom: { id: 222 } }) })
      }
      if (u.includes('/api/')) return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
      r.fulfill({ status: 200, contentType: 'text/html', body: fixtureHtml(plat.body) })
    })
  }

  // Seed one saved channel via an extension page (chrome.storage isn't
  // reachable from a fixture page's main-world evaluate — it only exists in
  // the content script's isolated world). The twitch fixture is a
  // non-channel url (/directory) on purpose (see the PLATFORMS doc comment),
  // and updateTwitchNoChannelClass now hides the panel there when
  // config.channels is empty — the audit-1.7.75 fix for an empty 340px panel
  // floating over pure browsing. Seeding one channel keeps this suite
  // testing what it always tested (persistent-overlay geometry on a
  // non-channel page with a real saved tab), same pattern the send-check
  // block below already uses for its own probechan fixture.
  {
    const sw = ctx.serviceWorkers()[0]
    const id = sw?.url().match(/chrome-extension:\/\/([a-p]+)\//)?.[1]
    if (!id) fail('could not resolve the extension id to seed a channel')
    const seed = await ctx.newPage()
    await seed.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'load' })
    await seed.evaluate(async () => {
      // @ts-ignore — extension page
      await chrome.storage.local.set({
        heatsync_multichat: { channels: [{ id: 'probechan', twitch: 'probechan', kick: '', youtube: '' }] },
      })
    })
    await seed.close()
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

    // Let the rebuild settle (the overlay holds one box for a beat), then re-run the measurement that bites.
    await stable(p, '#hs-mc-overlay', 500, 8000)
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
  const dock = () =>
    p.evaluate(() => {
      const c = [...document.body.classList].find((x) => x.startsWith('hs-tabs-'))
      return c ? c.replace('hs-tabs-', '') : '?'
    })
  const rotate = async () => {
    const before = await dock()
    await p.evaluate(() => window.postMessage({ type: 'heatsync-rotate-tabs' }, location.origin))
    // the body class names the new dock; the layout under it has to hold still before it is measured
    await until(p, async () => (await dock()) !== before, 5000)
    await stable(p, '#hs-mc-overlay', 400, 5000)
    return dock()
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

  // ── row geometry: the reply context must not break the message row ──────
  // System monospace has fractional advances, so an integer-pixel x is NOT
  // expected; what still matters is clipping, baseline and overlap.
  //
  // Baseline is taken inside the text's own line box (the reply pill is a block on its own line).
  // The markup is copied verbatim from the reply-bar builder in main.js.
  const geo = await p.evaluate(() => {
    const msgs = document.getElementById('hs-mc-messages')
    if (!msgs) return null
    const keep = msgs.innerHTML
    const TAIL = 'florida is building charging stations for flying car launch pads gypsy jumpy'
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
    const tailText = (el: HTMLElement) => {
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      let n: Node | null
      let last: Node | null = null
      while ((n = w.nextNode())) if ((n.textContent || '').trim().length > 3) last = n
      return last
    }
    // glyph box = the text's own line box (ascent+descent), baseline = a zero-height probe sitting on it
    const measure = (row: HTMLElement) => {
      const t = tailText(row)
      if (!t) return null
      const r = document.createRange()
      r.selectNodeContents(t)
      const first = r.getClientRects()[0]
      const probe = document.createElement('span')
      probe.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline'
      t.parentNode!.insertBefore(probe, t)
      const base = probe.getBoundingClientRect().bottom
      probe.remove()
      const rr = row.getBoundingClientRect()
      return { gTop: first.top, gBottom: first.bottom, left: first.left, top: rr.top, bottom: rr.bottom, base: base - first.top }
    }
    const mr = measure(withReply)
    const mp = measure(plain)
    const pillEl = withReply.querySelector('.hs-mc-reply-ctx') as HTMLElement
    const pr = pillEl.getBoundingClientRect()
    const out = {
      mr,
      mp,
      pillRight: pr.right,
      pillTop: pr.top,
      pillBottom: pr.bottom,
      pillWidth: +pr.width.toFixed(3),
      rowsOverlap: withReply.getBoundingClientRect().bottom > plain.getBoundingClientRect().top + 0.5,
    }
    msgs.innerHTML = keep
    return out
  })

  if (!geo || !geo.mr || !geo.mp) fail('could not reach #hs-mc-messages to measure row geometry')
  else {
    for (const [name, m] of [['reply', geo.mr], ['plain', geo.mp]] as const) {
      if (m.gTop < m.top - 0.5 || m.gBottom > m.bottom + 0.5) {
        fail(
          `${name} row clips its text: glyph box ${m.gTop.toFixed(2)}-${m.gBottom.toFixed(2)} vs row ${m.top.toFixed(2)}-${m.bottom.toFixed(2)} — descenders (p g j y) would be cut`,
        )
      }
    }
    if (Math.abs(geo.mr.base - geo.mp.base) > 0.5) {
      fail(`baselines differ row to row: ${geo.mr.base.toFixed(2)}px with a reply context vs ${geo.mp.base.toFixed(2)}px plain`)
    }
    // rect intersection: the pill and the message text must not share any pixels
    if (geo.pillBottom > geo.mr.gTop + 0.5 && geo.pillTop < geo.mr.gBottom - 0.5 && geo.pillRight > geo.mr.left + 0.5) {
      fail(`the reply pill overlaps the message text (pill ${geo.pillTop.toFixed(1)}-${geo.pillBottom.toFixed(1)}, text ${geo.mr.gTop.toFixed(1)}-${geo.mr.gBottom.toFixed(1)})`)
    }
    if (geo.rowsOverlap) fail('consecutive message rows overlap')
    ok(`${plat.name}: reply row keeps glyphs inside the row, one baseline, no overlap (pill ${geo.pillWidth}px)`)
  }

    await p.close()
  }
}
