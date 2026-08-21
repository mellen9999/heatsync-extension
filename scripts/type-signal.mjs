#!/usr/bin/env node
/**
 * The crash-class type errors in the BUILT extension, held at zero.
 *
 * WHY THE BUILT OUTPUT AND NOT src/: build.js concatenates src/lib/** and
 * src/multichat/** into each content script, so the files in chrome/ and src/
 * are fragments that reference names their siblings declare. Checking those
 * gives 2,175 "cannot find name" errors, all noise. dist/chrome/*.js is what
 * actually ships and what actually has to resolve — a missing name there is a
 * ReferenceError a user will hit.
 *
 * WHY ONLY THESE CODES: checkJs on the built output reports ~5,500 diagnostics,
 * nearly all DOM narrowing (querySelector returns Element, code reads .style).
 * None of those are bugs. The codes below are the ones where TypeScript is
 * *certain* the name or module does not exist, and certainty here means the
 * line throws when it runs. The first run of this check found four:
 *   · youtube-content.js called paintNeedsLetterSplit, renamed to
 *     paintNeedsSpans 2026-08-16 — HS paints stopped rendering on native
 *     youtube chat that day
 *   · the same file's paint embed shipped paint-spec.js WITHOUT paint-core.js
 *     and scene-spec.js, so 56 of the compiler's own helpers were undefined
 *   · autocomplete-hook.js assigned `cycleState.lastTime = now`, and `now` has
 *     no binding there — Tab-cycle aborted mid-handler
 *   · background.js read `userInfo?.twitch_username`, a const local to another
 *     function; optional chaining does not save an UNDECLARED name, so the
 *     twitch-token handler rejected and reported "signed out"
 *   · heatsync-button.js declared fetchHistoryStatus inside openPanel() while
 *     six callers sat outside it — import, restore, remove, rename, move
 *
 * Exit: 0 clean · 1 crash-class errors found · 2 the check did not really run.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const CRASH_CODES = {
  TS2304: "cannot find name — a typo'd or moved identifier throws ReferenceError when reached",
  TS2305: 'module has no exported member — the import is undefined',
  TS2306: 'file is not a module — the import resolves to nothing',
  TS2307: 'cannot find module — the import fails to resolve',
  TS2552: 'cannot find name, close match — almost always a typo',
  TS2724: 'no exported member, close match — a renamed export the caller never followed',
}

// Each bundle carries the shared modules plus ONE platform's host module, so
// multichat-kick.js contains calls to twitch-host.js functions it does not
// have. Every such call is behind a `hostPlatform === …` / `isKick` branch that
// cannot be true in that bundle — verified by hand across all 52 sites on
// 2026-08-20. Excused per (name, bundle) rather than globally, so a real
// missing name in the platform that OWNS the function still fails.
const PLATFORM_ONLY = {
  'twitch-host.js': 'twitch',
  'kick-host.js': 'kick',
  'youtube-host.js': 'youtube',
  'native-tap.js': 'twitch',
  'kick-native-tap.js': 'kick',
}

// Names that are deliberately absent. Each needs a reason, not just an entry.
const KNOWN_ABSENT = {
  // BTTV closed its shared-emote search: api.betterttv.net/3/emotes/shared/
  // search answers 403 {"message":"unauthorized"} without credentials we do
  // not have. input.js typeof-guards the call and drain() marks bttv exhausted
  // on the first page, so the cycle still terminates correctly. Removing the
  // branch outright would leave ex.bttv false forever and the cycle would
  // never wrap — the guard stays until BTTV is reachable again.
  mcSearchBttvApi: 'bttv search endpoint requires authorization (403)',
  // Service-worker global. lib WebWorker declares the Clients *type*, not the
  // `clients` value, and background.js is an MV3 service worker.
  clients: 'service worker global, present at runtime in an MV3 background',
}

const DIST = 'dist/chrome'
if (!existsSync(DIST) || readdirSync(DIST).filter((f) => f.endsWith('.js')).length < 10) {
  console.error(`type-signal: ${DIST} is missing or thin — run \`bun run build:chrome\` first`)
  process.exit(2)
}

const CANDIDATES = [
  ['node_modules/.bin/tsc', ['-p', 'tsconfig.signal.json', '--noEmit']],
  ['bunx', ['tsc', '-p', 'tsconfig.signal.json', '--noEmit']],
  ['npx', ['tsc', '-p', 'tsconfig.signal.json', '--noEmit']],
]

let raw = null
for (const [bin, args] of CANDIDATES) {
  if (bin.includes('/') && !existsSync(bin)) continue
  try {
    execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    raw = ''
    break
  } catch (err) {
    if (err.code === 'ENOENT') continue
    raw = `${err.stdout || ''}${err.stderr || ''}`
    break
  }
}
if (raw === null) {
  console.error('type-signal: could not run tsc (tried node_modules/.bin, bunx, npx) — the check did NOT run')
  process.exit(2)
}

const lines = raw.split('\n')
const diagnostics = lines.filter((l) => /error TS\d+:/.test(l))
// A pass with no diagnostics at all almost certainly means tsc never saw the
// tree. ~5,500 is the steady-state number; anything near zero is a non-run.
if (diagnostics.length < 100) {
  console.error(`type-signal: only ${diagnostics.length} diagnostics — tsc did not check the built tree`)
  process.exit(2)
}

/** Top-level declarations of each platform-only module, so a cross-platform
 *  call can be recognised without hardcoding 20 function names here. */
const platformDecls = new Map() // name -> owning platform
for (const [file, platform] of Object.entries(PLATFORM_ONLY)) {
  const p = join('src', 'multichat', file)
  if (!existsSync(p)) continue
  for (const m of readFileSync(p, 'utf8').matchAll(/^(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/gm)) {
    platformDecls.set(m[1], platform)
  }
}

const offences = []
for (const line of diagnostics) {
  const m = /^(.+?)\((\d+),\d+\): error (TS\d+): (.+)$/.exec(line)
  if (!m) continue
  const [, file, ln, code, msg] = m
  if (!CRASH_CODES[code]) continue
  const name = /'([^']+)'/.exec(msg)?.[1] ?? ''
  if (KNOWN_ABSENT[name]) continue
  const owner = platformDecls.get(name)
  if (owner && !file.includes(`multichat-${owner}.js`)) continue
  offences.push(`${file}:${ln} — ${name || msg} (${code}: ${CRASH_CODES[code]})`)
}

if (offences.length) {
  console.error(`type-signal: ${offences.length} crash-class error(s) in the built extension\n`)
  for (const o of offences) console.error(`  ${o}`)
  console.error('\nEach of these throws a ReferenceError the moment that line runs.')
  process.exit(1)
}
console.log(`type-signal: clean — 0 crash-class errors across ${diagnostics.length} diagnostics`)
