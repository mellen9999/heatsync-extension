/**
 * Shared browser-harness plumbing for the opt-in scripts that load the BUILT
 * extension in a real Chromium (smoke-extension.ts, render-extension.ts).
 *
 * Lives here so the two scripts cannot drift on which artifact they load or how
 * they find a driver — the smoke script spent its life loading `chrome/` (the
 * source tree, whose content.js has no lib bundled) instead of `dist/chrome`,
 * and there is no reason for a second copy of that decision to exist.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** The built artifact — what actually goes in the zip. */
export const EXT_DIR = join(import.meta.dir, '..', '..', 'dist', 'chrome')
export const CHROME_BIN = process.env.CHROMIUM_BIN || '/home/mellen/.local/bin/chromium'

/**
 * playwright-core is a devDependency (it was borrowed from the sibling site
 * repo's node_modules, which meant the smoke and render scripts could not run
 * anywhere that repo was not checked out beside this one — ci included).
 * Override with PLAYWRIGHT_CORE to point at another copy.
 */
export async function loadChromium() {
  const candidates = ['playwright-core', process.env.PLAYWRIGHT_CORE].filter(Boolean) as string[]
  for (const spec of candidates) {
    try {
      return (await import(spec)).chromium
    } catch (_) {
      /* try the next one */
    }
  }
  throw new Error(`playwright-core not found. Tried:\n  ${candidates.join('\n  ')}\nSet PLAYWRIGHT_CORE to its index.js.`)
}

export function assertBuilt() {
  if (!existsSync(join(EXT_DIR, 'manifest.json'))) {
    throw new Error(`no built extension at ${EXT_DIR} — run \`bun run build.js chrome\` first`)
  }
}

/**
 * Launch a persistent context with the extension loaded.
 * `headless: false` + `--headless=new`: MV3 service workers need the new mode.
 */
export async function launchWithExtension(profile: string, extraArgs: string[] = []) {
  const chromium = await loadChromium()
  return chromium.launchPersistentContext(profile, {
    executablePath: CHROME_BIN,
    headless: false,
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      '--headless=new',
      '--no-sandbox',
      ...extraArgs,
    ],
  })
}

/**
 * A CDP call never times out on its own: a renderer that stops answering hangs
 * the whole run silently (e2e-live sat at "waiting 3min…" until killed, and the
 * kick/youtube checks after it never ran). Race every call that talks to a live
 * page so a stuck renderer is a FAIL line, not a hang.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<T>((_, rej) => {
      t = setTimeout(() => rej(new Error(`${label} timed out after ${ms / 1000}s — renderer unresponsive`)), ms)
    }),
  ])
}
