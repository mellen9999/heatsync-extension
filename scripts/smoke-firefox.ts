/**
 * Load the BUILT firefox add-on (MV2) in headless Firefox and prove it starts.
 *
 *   bun run test:smoke:firefox        (builds dist/firefox first)
 *   bun scripts/smoke-firefox.ts      (dist/firefox already built)
 *
 * The firefox twin of smoke-extension.ts, which loads dist/chrome in chromium.
 * Opt-in, not part of `bun test`: it needs firefox + geckodriver on the box.
 *
 * Firefox is not chromium with another manifest: it takes a background PAGE
 * where chrome takes a service worker, parses MV2 keys, enforces its own CSP,
 * and the world: MAIN content scripts only run as intended if it accepts them.
 * Every one of those can break a firefox-only release while the chromium smoke
 * stays green. Checked here, in order:
 *
 *   - every file the manifest names is in the build
 *   - firefox accepts the add-on (a manifest it rejects fails the install) and
 *     reports no manifest warnings (an ignored key never fails the install)
 *   - every content_scripts entry in the manifest is registered, in the same
 *     world, with the same files
 *   - popup.html and welcome.html load
 *   - the background page ran to the end (__hsBootOk, set by its last statement)
 *   - nothing logged an error: an uncaught error in an extension file, a CSP
 *     block, or a console.error
 *
 * Not covered, same as the chromium smoke: the overlay on a live twitch/kick/
 * youtube page. That needs those sites; render-extension.ts covers it in chromium.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { assertFirefoxBuilt, FF_EXT_DIR, type Firefox, launchFirefox } from './lib/firefox'

type Script = { world?: string; js: string[]; css?: string[] }
const manifest: {
  browser_specific_settings: { gecko: { id: string } }
  background: { scripts: string[] }
  browser_action: { default_popup: string }
  icons: Record<string, string>
  content_scripts: Script[]
} = JSON.parse(readFileSync(join(FF_EXT_DIR, 'manifest.json'), 'utf8'))
const ID = manifest.browser_specific_settings.gecko.id
// logged on purpose, to prove firefox's output is being read; never counted as an error
const CANARY = 'hs-smoke-canary'
const SETTLE_MS = 2_000
const DEADLINE_MS = 120_000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const shape = (c: Script) => `${c.world || 'ISOLATED'}  ${c.js.join(' + ')}`
/** `a` minus `b`, counting repeats: vi-mode.js is in two entries (different frames), so a plain set would hide a dropped one. */
const without = (a: string[], b: string[]) => {
  const rest = [...b]
  return a.filter((x) => {
    const i = rest.indexOf(x)
    if (i < 0) return true
    rest.splice(i, 1)
    return false
  })
}
/** `[JavaScript Error: "msg" {file: "url" line: n}]` (nsIScriptError) to `url:n: msg`. */
const oneLine = (m: string) => {
  const p = m.match(/^\[JavaScript Error: "(.*)" \{file: "(.*)" line: (\d+)/s)
  return (p ? `${p[2]}:${p[3]}: ${p[1]}` : m).split('\n')[0]
}

let ff: Firefox | null = null
let base = ''

/**
 * Everything firefox has logged as an error for the extension, canary aside. Two
 * places, because firefox splits them: uncaught errors and CSP blocks go to its
 * console service (never stdout); console.error goes to stdout (the pref in lib/firefox.ts).
 */
const errorsSeen = async (f: Firefox) => [
  ...(await f.consoleMessages(base))
    .filter((m) => m.startsWith('[JavaScript Error:') && !m.includes(CANARY))
    .map(oneLine),
  ...f
    .log()
    .split('\n')
    .filter((l) => l.startsWith('console.error: ') && !l.includes(CANARY)),
]

const watchdog = setTimeout(() => {
  console.error(`✗ firefox smoke FAILED: no result after ${DEADLINE_MS / 1000}s — firefox or geckodriver hung`)
  ff?.close().finally(() => process.exit(1))
}, DEADLINE_MS)

try {
  assertFirefoxBuilt()
  const named = [
    ...manifest.background.scripts,
    ...manifest.content_scripts.flatMap((c) => [...c.js, ...(c.css || [])]),
    manifest.browser_action.default_popup,
    ...Object.values(manifest.icons),
  ]
  const absent = named.filter((f) => !existsSync(join(FF_EXT_DIR, f)))
  if (absent.length) throw new Error(`the manifest names files that are not in the build: ${absent.join(', ')}`)
  console.log(`✓ all ${new Set(named).size} files the manifest names are in the build`)

  ff = await launchFirefox()

  try {
    const got = await ff.install(FF_EXT_DIR)
    if (got !== ID) throw new Error(`installed as ${got}, manifest says ${ID}`)
  } catch (e) {
    // "Extension is invalid" is all the install call says; firefox logs why to its console service
    const why = (await ff.consoleMessages(ID).catch(() => [])).map(
      (m) => (m.match(/ERROR\t(.+?)" \{file:/s)?.[1] ?? m).split('\n')[0],
    )
    throw new Error(
      `firefox rejected the add-on: ${(e as Error).message}\n  ${why.join('\n  ') || '(no reason in its console)'}`,
    )
  }

  const info = await ff.privileged<{
    active: boolean
    host: string
    warnings: string[] | null
    scripts: Script[]
  } | null>(
    `const p = WebExtensionPolicy.getByID(arguments[0])
     return p && {
       active: p.active,
       host: p.mozExtensionHostname,
       warnings: p.extension ? p.extension.warnings : null,
       scripts: p.contentScripts.map((c) => ({ world: c.world, js: c.jsPaths })),
     }`,
    [ID],
  )
  if (!info) throw new Error(`installed, but firefox has no extension ${ID} — it never registered`)
  if (!info.active) throw new Error('installed, but the extension is not active')
  if (!info.warnings) throw new Error('could not read manifest warnings — firefox internals changed, fix the smoke')
  if (info.warnings.length) throw new Error(`firefox warned about the manifest:\n  ${info.warnings.join('\n  ')}`)
  console.log(`✓ firefox ${ff.version} accepted ${ID} (no manifest warnings)`)

  base = `moz-extension://${info.host}/`
  const want = manifest.content_scripts.map(shape)
  const have = info.scripts.map((c) => shape({ world: c.world, js: c.js.map((u) => u.replace(base, '')) }))
  const missing = without(want, have)
  const extra = without(have, want)
  if (missing.length || extra.length) {
    throw new Error(
      `content scripts differ from the manifest:\n  not registered: ${missing.join(' | ') || 'none'}\n  unexpected: ${extra.join(' | ') || 'none'}`,
    )
  }
  const mainWorld = manifest.content_scripts.filter((c) => c.world === 'MAIN').length
  console.log(`✓ ${want.length} content script entries registered, ${mainWorld} of them in the page's own world`)

  // Extension-origin pages: these evaluate the popup/welcome bundles for real.
  for (const page of ['popup.html', 'welcome.html']) {
    await ff.goto(`${base}${page}`)
    const title = await ff.title()
    if (!title) throw new Error(`${page} loaded with no title — it did not render`)
    console.log(`✓ ${page} loaded (${title})`)
  }

  // Registered is not the same as evaluated: background.js sets __hsBootOk as its
  // final statement, so this fails on a throw anywhere in it.
  const booted = await ff.pageAsync<boolean | string>(
    `const done = arguments[arguments.length - 1]
     browser.runtime.getBackgroundPage().then((w) => done(!!w && w.__hsBootOk === true), (e) => done(String(e)))`,
  )
  if (typeof booted === 'string') throw new Error(`could not reach the background page: ${booted}`)
  if (!booted) throw new Error('background page loaded but did not finish evaluating — it threw during boot')
  console.log('✓ background page started and fully evaluated')

  // Prove both outputs are being read, so "no errors" cannot mean "nothing is listening".
  await ff.page(`setTimeout(() => { throw new Error('${CANARY}') }, 0); console.error('${CANARY}'); return true`)
  await sleep(SETTLE_MS)
  const heard =
    ff
      .log()
      .split('\n')
      .some((l) => l.startsWith('console.error: ') && l.includes(CANARY)) &&
    (await ff.consoleMessages(base)).some((m) => m.startsWith('[JavaScript Error:') && m.includes(CANARY))
  if (!heard)
    throw new Error('firefox\'s console output is not being captured, so "no errors" proves nothing — fix the smoke')

  if ((await errorsSeen(ff)).length) throw new Error('the extension logged errors while it ran')
  console.log('✓ firefox smoke passed — no runtime errors')
} catch (e) {
  console.error(`✗ firefox smoke FAILED: ${(e as Error).message}`)
  // whatever the extension logged is usually why a check above failed
  const seen = ff && base ? await errorsSeen(ff).catch(() => []) : []
  if (seen.length) {
    const shown = seen.slice(0, 8).map((l) => l.slice(0, 300))
    const more = seen.length > shown.length ? [`… and ${seen.length - shown.length} more`] : []
    console.error(`  errors firefox logged for the extension:\n  ${[...shown, ...more].join('\n  ')}`)
  }
  process.exitCode = 1
} finally {
  clearTimeout(watchdog)
  await ff?.close()
}
