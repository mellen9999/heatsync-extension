/**
 * Browser-harness plumbing for scripts that load the BUILT firefox (MV2) add-on
 * in a real headless Firefox. The firefox twin of lib/chromium.ts.
 *
 * Playwright cannot load an extension into Firefox, and `web-ext run` is a dev
 * server to babysit. geckodriver is on arch (extra/geckodriver) and on github's
 * ubuntu runners beside firefox, and it speaks plain HTTP (WebDriver), so this
 * needs no dependency: install the add-on as a temporary add-on, then drive
 * pages with the same calls any WebDriver client makes.
 *
 * `--allow-system-access` is what lets a script (a) open moz-extension:// pages
 * and (b) run privileged js in firefox's own process. WebDriver refuses both
 * otherwise, and the smoke needs both to look at the extension from outside it.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** The built artifact — what actually goes in the zip. */
export const FF_EXT_DIR = join(import.meta.dir, '..', '..', 'dist', 'firefox')

const CALL_MS = 30_000

export function assertFirefoxBuilt() {
  if (!existsSync(join(FF_EXT_DIR, 'manifest.json'))) {
    throw new Error(`no built extension at ${FF_EXT_DIR} — run \`bun run build.js firefox\` first`)
  }
}

function findDriver(): string {
  // github's ubuntu runners export GECKOWEBDRIVER (the dir holding geckodriver)
  const gecko = process.env.GECKOWEBDRIVER
  const hit = [process.env.GECKODRIVER_BIN, Bun.which('geckodriver'), gecko && join(gecko, 'geckodriver')].find(
    (p) => p && existsSync(p),
  )
  if (!hit) throw new Error('geckodriver not found — install it, or set GECKODRIVER_BIN to its path')
  return hit
}

export type Firefox = Awaited<ReturnType<typeof launchFirefox>>

/**
 * Start geckodriver + a fresh headless Firefox profile. `log()` is everything
 * either process printed so far: with devtools.console.stdout.content on, that
 * includes every console.* call the extension's pages make.
 * FIREFOX_BIN picks a binary other than the one geckodriver finds on PATH.
 */
export async function launchFirefox() {
  let log = ''
  const driver: ChildProcess = spawn(findDriver(), ['--port', '0', '--websocket-port', '0', '--allow-system-access'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  for (const s of [driver.stdout, driver.stderr]) s?.on('data', (d) => (log += d))

  const port = await new Promise<number>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`geckodriver never reported a port:\n${log}`)), 10_000)
    driver.once('exit', (c) => reject(new Error(`geckodriver exited (${c}) before it was ready:\n${log}`)))
    const poll = setInterval(() => {
      const m = log.match(/Listening on 127\.0\.0\.1:(\d+)/)
      if (!m) return
      clearInterval(poll)
      clearTimeout(t)
      resolve(Number(m[1]))
    }, 50)
  })

  let session = ''
  /** One WebDriver call. A webdriver error becomes a thrown Error with its first message line. */
  const call = async <T = unknown>(method: string, path: string, body?: unknown, ms = CALL_MS): Promise<T> => {
    const res = await fetch(`http://127.0.0.1:${port}${session ? `/session/${session}` : ''}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(ms),
    })
    const { value } = (await res.json()) as { value: T & { error?: string; message?: string } }
    if (value?.error) {
      throw new Error(`${method} ${path || '/session'}: ${value.error}: ${String(value.message).split('\n')[0]}`)
    }
    return value
  }

  const created = await call<{ sessionId: string; capabilities: { browserVersion: string } }>('POST', '/session', {
    capabilities: {
      alwaysMatch: {
        browserName: 'firefox',
        'moz:firefoxOptions': {
          args: ['-headless'],
          ...(process.env.FIREFOX_BIN ? { binary: process.env.FIREFOX_BIN } : {}),
          // console.* from extension pages go to stdout, so a console.error the
          // extension logs is seen here. chrome off: firefox's own modules log
          // console.error noise of their own (nimbus, remote settings), and with
          // no web page loaded every remaining line is the extension's.
          prefs: { 'devtools.console.stdout.content': true, 'devtools.console.stdout.chrome': false },
        },
      },
    },
  })
  session = created.sessionId
  await call('POST', '/timeouts', { script: 10_000 })

  const run = <T>(path: 'execute/sync' | 'execute/async', script: string, args: unknown[] = []) =>
    call<T>('POST', `/${path}`, { script, args })

  /** Run privileged js in firefox's own process (needs --allow-system-access). */
  async function privileged<T>(script: string, args?: unknown[]): Promise<T> {
    await call('POST', '/moz/context', { context: 'chrome' })
    try {
      return await run<T>('execute/sync', script, args)
    } finally {
      await call('POST', '/moz/context', { context: 'content' })
    }
  }

  return {
    version: created.capabilities.browserVersion,
    /** A raw WebDriver call on this session (windows, tabs: what the helpers here don't cover). */
    wd: <T = unknown>(method: string, path: string, body?: unknown) => call<T>(method, path, body),
    log: () => log,

    /** Install `dir` as a temporary add-on. A refusal says only "Extension is invalid"; the reason is in `consoleMessages()`. */
    install: (dir: string) => call<string>('POST', '/moz/addon/install', { path: dir, temporary: true }),

    goto: (url: string) => call('POST', '/url', { url }),
    title: () => call<string>('GET', '/title'),

    /** Run js in the current page. */
    page: <T>(script: string, args?: unknown[]) => run<T>('execute/sync', script, args),
    /** Run js in the current page; the script calls its last argument with the result. */
    pageAsync: <T>(script: string, args?: unknown[]) => run<T>('execute/async', script, args),

    privileged,

    /**
     * What firefox's console service has buffered that mentions `match`. This is where
     * uncaught errors, CSP blocks and manifest errors land — none of them reach stdout.
     */
    consoleMessages: (match: string) =>
      privileged<string[]>(
        'return Services.console.getMessageArray().map((m) => m.message).filter((m) => m.includes(arguments[0]))',
        [match],
      ),

    async close() {
      // ending the session is what quits firefox; killing geckodriver alone leaves it running
      await call('DELETE', '', undefined, 10_000).catch(() => {})
      driver.kill()
      await new Promise<void>((done) => {
        if (driver.exitCode !== null || driver.signalCode !== null) return done()
        const t = setTimeout(() => {
          driver.kill('SIGKILL')
          done()
        }, 5_000)
        driver.once('exit', () => {
          clearTimeout(t)
          done()
        })
      })
    },
  }
}
