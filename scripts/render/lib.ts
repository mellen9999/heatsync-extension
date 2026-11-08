import { execFileSync } from 'node:child_process'

/**
 * Fixtures, one per platform.
 *
 * Each URL is chosen so main.js takes a BODY-MOUNT path and no React tree has
 * to be faked:
 *  - twitch: a non-channel url (no `.channel-root`).
 *  - kick:   a channel path (`/renderkick`). kick mounts only on channel routes
 *            (isKickChannelRoute, an allowlist since bdae2917) — a reserved path
 *            like `/browse` correctly never mounts.
 *  - youtube: a /watch url with a fake `ytd-live-chat-frame#chat` + a
 *    non-replay iframe src — checkYtLive() (main.js) reads exactly that DOM
 *    shape to decide "this page has its own live stream", which is what
 *    ungates the panel (`hs-offline` off). The panel is intentionally OFFLINE
 *    (display:none, #hs-mc-container gated by `:not(.hs-offline)`) on any
 *    other YouTube page by default — showing an empty 340px panel on every
 *    yt page including home/VODs/directory was the audit-1.7.75 bug; a
 *    genuinely non-live fixture here would (correctly) never mount and this
 *    whole check would be worthless.
 *
 * The twitch fixture also carries `.right-column.right-column--beside`, because
 * ensureUIElements starts a MutationObserver on that element whose callback
 * re-enters ensureUIElements. That re-entry is the only path that re-runs it
 * without first nulling resizeObserver.
 */
export const PLATFORMS = [
  {
    name: 'twitch',
    url: 'https://www.twitch.tv/directory',
    glob: 'https://www.twitch.tv/**',
    body: '<div id="host-content" style="height:100vh">host page</div><div class="right-column right-column--beside" id="rcol"></div>',
    rerender: true,
  },
  {
    name: 'kick',
    url: 'https://kick.com/renderkick',
    glob: 'https://kick.com/**',
    // a channel route mounts into kick's chatroom element (waitForMount in
    // main.js), so the fixture carries the same shape the send check uses
    body:
      '<div id="host-content" style="height:100vh">host page</div>' +
      '<div id="channel-chatroom"><div id="chatroom-messages"><div class="no-scrollbar"></div></div>' +
      '<div id="chatwrap"><div class="editor-input" contenteditable="true"></div></div></div>',
    rerender: false,
  },
  {
    name: 'youtube',
    url: 'https://www.youtube.com/watch?v=RENDERLIVEXX',
    glob: 'https://www.youtube.com/**',
    body:
      '<div id="host-content" style="height:100vh">host page</div>' +
      '<ytd-live-chat-frame id="chat"><iframe src="https://www.youtube.com/live_chat?is_popout=1&v=RENDERLIVEXX"></iframe></ytd-live-chat-frame>',
    rerender: false,
  },
]

export const fixtureHtml = (body: string) =>
  `<!doctype html><html><head><title>fixture</title></head><body style="margin:0">${body}</body></html>`


export const errors: string[] = []
export const checks: string[] = []

export function ok(msg: string) {
  checks.push(msg)
  console.log(`✓ ${msg}`)
}
export function fail(msg: string): never {
  throw new Error(msg)
}


/**
 * A 1x1 transparent png. Every seeded emote resolves to a real image, so the
 * input chip never drops into the broken-image recovery path and the thing
 * under test stays the completion itself.
 */
export const ONE_PX_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

/** Poll a predicate instead of sleeping. Returns false if it never held. */
export async function until(p: any, check: () => boolean | Promise<boolean>, ms = 20_000) {
  const step = 400
  for (let waited = 0; waited < ms; waited += step) {
    if (await check()) return true
    await p.waitForTimeout(step)
  }
  return false
}

/**
 * Wait until `sel` is on the page and has held the same box for `quietMs`: the
 * overlay finished mounting and nothing is still re-laying it out. This is what
 * a fixed "let it boot" sleep was standing in for. Returns false on timeout.
 */
export async function stable(p: any, sel: string, quietMs = 600, ms = 20_000) {
  return p
    .waitForFunction(
      ({ sel, quietMs }: { sel: string; quietMs: number }) => {
        const el = document.querySelector(sel)
        const r = el?.getBoundingClientRect()
        if (!r || !r.width || !r.height) return false
        const key = [r.x, r.y, r.width, r.height].map(Math.round).join(',')
        const w = window as any
        if (w.__hsStill?.sel !== sel || w.__hsStill.key !== key) {
          w.__hsStill = { sel, key, since: performance.now() }
          return false
        }
        return performance.now() - w.__hsStill.since >= quietMs
      },
      { sel, quietMs },
      { timeout: ms, polling: 100 },
    )
    .then(() => true)
    .catch(() => false)
}

/**
 * Do `act` (it must be safe to repeat) until `done()` holds. For a first action
 * the page may not be listening for yet: a content script that has not
 * registered its handler drops the message without a word, and a fixed sleep
 * only guessed how long that takes. Each try gets `every` ms to take effect.
 */
export async function retryUntil(
  p: any,
  act: () => Promise<unknown>,
  done: () => boolean | Promise<boolean>,
  { every = 1000, ms = 20_000 }: { every?: number; ms?: number } = {},
) {
  for (let waited = 0; waited < ms; waited += every) {
    await act()
    if (await until(p, done, every)) return true
  }
  return false
}

/**
 * A window in which something must NOT happen (a second click, a stray cue, a
 * list that should have stayed gone). There is no condition to wait for when
 * the expected outcome is nothing, so these stay as bounded, named waits.
 */
export async function observe(p: any, ms: number, why: string) {
  void why // read by the person who is about to shorten it
  await p.waitForTimeout(ms)
}

/**
 * Closing a persistent context that still holds a websocket to a local mock can
 * hang forever, and a harness that hangs is worse than one that fails: there is
 * nothing to read. Bounded, and it says so when it gives up.
 */
export async function closeContext(c: any, label: string, profile?: string) {
  const closed = await Promise.race([
    c
      .close()
      .then(() => true)
      .catch(() => true),
    new Promise((r) => setTimeout(() => r(false), 20_000)),
  ])
  if (closed) return
  // A chromium that will not close is not a cosmetic problem here: this script
  // launches nine of them in sequence, and every leaked one competes for the
  // machine with the checks that follow. That is what made the later checks
  // fail — a different platform each run, always the one that ran last — until
  // the leak itself was the thing fixed. Kill it by its profile directory,
  // which is unique per launch and cannot match anything else.
  if (profile) {
    try {
      execFileSync('pkill', ['-f', `user-data-dir=${profile}`], { stdio: 'ignore' })
      console.log(`  ! ${label}: the browser did not close in 20s — killed it by profile`)
      return
    } catch (_) {
      /* pkill exits non-zero when nothing matched, which is the good case */
      console.log(`  ! ${label}: the browser did not close in 20s — nothing left to kill`)
      return
    }
  }
  console.log(`  ! ${label}: the browser did not close in 20s — leaving it to the process exit`)
}
