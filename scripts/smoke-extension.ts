/**
 * Load the BUILT extension in headless Chromium and prove it actually starts.
 *
 *   bun scripts/smoke-extension.ts
 *
 * Opt-in, not part of `bun test`: it needs a real browser binary, which the
 * unit suite deliberately does not depend on.
 *
 * What this catches that nothing else does: `node --check` proves each bundle
 * PARSES, and the unit tests prove the logic is right, but neither notices a
 * bundle that throws the moment it is evaluated, a manifest the browser
 * rejects, or a service worker that dies on registration. Those only show up
 * when a browser loads the artifact.
 *
 * What it does NOT cover: the multichat overlay's settings UI. That only
 * injects on twitch/kick/youtube, so exercising it means driving a live
 * external site — too slow and too flaky to gate a push on. The render logic
 * is covered instead by resolveOptions() in tests/font-grid.test.js, which is
 * why that narrowing lives in settings-schema.js rather than inline in the
 * renderer.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { assertBuilt, EXT_DIR, launchWithExtension } from './lib/chromium'

const EXT = EXT_DIR

const profile = mkdtempSync(join(tmpdir(), 'hs-ext-smoke-'))

const errors: string[] = []
let ctx: any = null

try {
  assertBuilt()
  ctx = await launchWithExtension(profile)
  ctx.on('page', (p: any) => p.on('pageerror', (e: unknown) => errors.push(`page: ${String(e).slice(0, 300)}`)))
  ctx.on('serviceworker', (w: any) =>
    w.on('console', (m: any) => {
      if (m.type() === 'error') errors.push(`sw: ${String(m.text()).slice(0, 300)}`)
    }),
  )

  // The MV3 service worker is the extension's first real execution.
  const deadline = Date.now() + 15_000
  while (ctx.serviceWorkers().length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250))
  }
  const worker = ctx.serviceWorkers()[0]
  if (!worker) throw new Error('no service worker — the extension never started (manifest rejected, or background.js threw)')

  const id = worker.url().match(/chrome-extension:\/\/([a-p]+)\//)?.[1]
  if (!id) throw new Error(`could not read extension id from ${worker.url()}`)
  // Registered is not the same as evaluated: a worker that throws partway
  // through is still a worker, and this script used to pass on one. background.js
  // sets __hsBootOk as its final statement, so this fails on a throw anywhere in
  // it — which is the failure the header claims to catch.
  const booted = await worker.evaluate(() => (self as any).__hsBootOk === true).catch(() => false)
  if (!booted) throw new Error('background.js registered but did not finish evaluating — it threw during boot')
  console.log(`✓ service worker started and fully evaluated (${worker.url().split('/').pop()})`)

  // Extension-origin pages: these evaluate the popup/welcome bundles for real.
  for (const page of ['popup.html', 'welcome.html']) {
    const p = await ctx.newPage()
    p.on('pageerror', (e: unknown) => errors.push(`${page}: ${String(e).slice(0, 300)}`))
    const res = await p.goto(`chrome-extension://${id}/${page}`, { waitUntil: 'load' })
    if (!res || res.status() !== 200) throw new Error(`${page} did not load (status ${res?.status()})`)
    console.log(`✓ ${page} loaded (${await p.title()})`)
    await p.close()
  }

  if (errors.length) throw new Error(`runtime errors:\n  ${errors.join('\n  ')}`)
  console.log('✓ extension smoke passed — no runtime errors')
} catch (e) {
  console.error(`✗ extension smoke FAILED: ${(e as Error).message}`)
  process.exitCode = 1
} finally {
  await ctx?.close().catch(() => {})
  rmSync(profile, { recursive: true, force: true })
}
