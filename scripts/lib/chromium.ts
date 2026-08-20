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
 * playwright-core is NOT a dependency of this repo — a browser driver is a lot
 * of weight for opt-in scripts. It is resolved from the sibling heatsync repo,
 * which already has it. Override with PLAYWRIGHT_CORE.
 *
 * The sibling lookup must survive being run from a worktree: inside
 * `.worktrees/<name>/`, `../..` is the worktrees dir, not the projects dir, so
 * the plain sibling path misses and the script reports "not found" on a machine
 * that has playwright installed. Both roots are tried.
 */
export async function loadChromium() {
  const repoRoot = join(import.meta.dir, '..', '..')
  const siblingFrom = (root: string) => join(root, '..', 'heatsync', 'node_modules', 'playwright-core', 'index.js')
  const candidates = [
    'playwright-core',
    process.env.PLAYWRIGHT_CORE,
    siblingFrom(repoRoot),
    // worktree: <projects>/heatsync-extension/.worktrees/<name>
    siblingFrom(join(repoRoot, '..', '..')),
  ].filter(Boolean) as string[]
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
