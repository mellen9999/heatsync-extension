import { join } from 'node:path'
import { errors, fail, ok } from './lib'

export async function diagQuietCheck(ctx: any) {
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
}
