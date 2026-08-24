#!/usr/bin/env bun

/**
 * Heatsync Extension Build Script
 *
 * Builds Chrome and Firefox versions from unified source.
 * - Bundles lib/ modules into content scripts
 * - Handles manifest differences (MV2 vs MV3)
 * - Copies assets
 *
 * Usage:
 *   bun run build.js                    # Build both
 *   bun run build.js chrome             # Chrome only
 *   bun run build.js --package          # Build + zip
 *   bun run build.js --deploy           # Build + zip + rsync to server
 */

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transformSync } from 'esbuild'

// Build stamp — swapped into bootstrap.js's '__HS_BUILD_STAMP__' literal so
// every hs_diag_ring boot event names the code it ran. Needed because a tab
// can run a build hours older than dist: a popout froze on code whose fix had
// landed 3h earlier but was never reloaded, and the ring couldn't show that.
const BUILD_STAMP = (() => {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: dirname(fileURLToPath(import.meta.url)) })
      .toString()
      .trim()
    const dirty = execFileSync('git', ['status', '--porcelain', '--', 'src'], {
      cwd: dirname(fileURLToPath(import.meta.url)),
    })
      .toString()
      .trim()
      ? '+'
      : ''
    return `${sha}${dirty}-${new Date().toISOString().slice(0, 16).replace(/[-T:]/g, '')}`
  } catch (_) {
    return `nogit-${Date.now()}`
  }
})()

// ── Pre-build guards ──────────────────────────────────────────────────────────
// All four checks run before any bundling and fail the build loudly on violation.

// Guard 1: version must match across package.json, chrome manifest, firefox manifest.
function checkVersionSync() {
  const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8'))
  const chrome = JSON.parse(readFileSync(join(__dirname, 'src', 'manifests', 'chrome.json'), 'utf8'))
  const firefox = JSON.parse(readFileSync(join(__dirname, 'src', 'manifests', 'firefox.json'), 'utf8'))
  const [pv, cv, fv] = [pkg.version, chrome.version, firefox.version]
  if (pv !== cv || pv !== fv) {
    throw new Error(`version mismatch: package.json=${pv} chrome=${cv} firefox=${fv}`)
  }
  console.log(`  Version sync: ${pv} ✓`)
}

// Guard 2: host permissions and content_scripts coverage must match between manifests.
// Intentional MV2/MV3 structural differences allowed: background service_worker vs scripts,
// action vs browser_action, and web_accessible_resources format. Host permission sets are
// now identical across both — no browser-only exceptions.
function checkManifestParity() {
  const chrome = JSON.parse(readFileSync(join(__dirname, 'src', 'manifests', 'chrome.json'), 'utf8'))
  const firefox = JSON.parse(readFileSync(join(__dirname, 'src', 'manifests', 'firefox.json'), 'utf8'))

  // --- host permissions ---
  // Chrome MV3: split into host_permissions[]. Firefox MV2: folded into permissions[].
  const URL_PATTERN = /^https?:\/\//

  const chromeHosts = new Set([
    ...(chrome.host_permissions || []),
    ...(chrome.permissions || []).filter((p) => URL_PATTERN.test(p)),
  ])
  const firefoxHosts = new Set((firefox.permissions || []).filter((p) => URL_PATTERN.test(p)))

  const onlyInChrome = [...chromeHosts].filter((h) => !firefoxHosts.has(h))
  const onlyInFirefox = [...firefoxHosts].filter((h) => !chromeHosts.has(h))
  if (onlyInChrome.length || onlyInFirefox.length) {
    const lines = []
    if (onlyInChrome.length) lines.push(`  chrome-only: ${onlyInChrome.join(', ')}`)
    if (onlyInFirefox.length) lines.push(`  firefox-only: ${onlyInFirefox.join(', ')}`)
    throw new Error(`manifest host_permissions diverge:\n${lines.join('\n')}`)
  }

  // --- content_scripts coverage ---
  // Canonicalize each entry to a key of matches+js+css+world+run_at+all_frames
  // (defaults normalized so absent == explicit default), then compare as sets.
  // Order-independent — coverage matters, not entry ordering.
  function csKey(entry) {
    const matches = [...(entry.matches || [])].sort().join('|')
    const js = [...(entry.js || [])].sort().join('|')
    const css = [...(entry.css || [])].sort().join('|')
    const world = entry.world || 'ISOLATED'
    const runAt = entry.run_at || 'document_idle'
    const allFrames = entry.all_frames === true
    return `${matches}::${js}::${css}::${world}::${runAt}::${allFrames}`
  }

  const chromeKeys = new Set((chrome.content_scripts || []).map(csKey))
  const firefoxKeys = new Set((firefox.content_scripts || []).map(csKey))

  const onlyInChromeCS = [...chromeKeys].filter((k) => !firefoxKeys.has(k))
  const onlyInFirefoxCS = [...firefoxKeys].filter((k) => !chromeKeys.has(k))
  if (onlyInChromeCS.length || onlyInFirefoxCS.length) {
    const lines = []
    if (onlyInChromeCS.length) lines.push(`  chrome-only entries:\n    ${onlyInChromeCS.join('\n    ')}`)
    if (onlyInFirefoxCS.length) lines.push(`  firefox-only entries:\n    ${onlyInFirefoxCS.join('\n    ')}`)
    throw new Error(`manifest content_scripts diverge:\n${lines.join('\n')}`)
  }

  console.log(`  Manifest parity: ${chromeHosts.size} host perms, ${chromeKeys.size} content_script entries ✓`)
}

// Guard 3: catch top-level name collisions between src/lib (outer IIFE scope)
// and src/multichat (nested block scope). const/let collisions are hard JS errors;
// function/var collisions shadow silently — warn loudly.
//
// NOTE: this is a regex-based parser. It only matches column-0 declarations so
// it works correctly for this codebase's flat style, but would miss declarations
// inside nested blocks, object literals, or continuation lines. It's a fast
// sanity check, not a full AST parse.
//
// Intentional shadows:
//   'log' — utils.js (lib, outer IIFE) declares `function log` for lib-internal use;
//            bootstrap.js (multichat, inner block) redeclares `function log` as the
//            multichat-specific logger. The inner block scope means no JS SyntaxError,
//            and the inner one takes precedence inside the block — intentional.
//   'cleanup' — cleanup.js (lib) re-exports `const cleanup = window.heatsyncCleanup`
//            so standalone bundles get a bare binding; bootstrap.js (multichat,
//            inner block) declares its own AbortController-wired `const cleanup`
//            that legally shadows it — intentional.
const SCOPE_COLLISION_ALLOWLIST = new Set(['log', 'cleanup'])

// Guard: multichat's `cleanup` is a DELIBERATE shadow of src/lib/cleanup.js's
// export. The lib object lacks addListener/setIntervalIfVisible/persistInterval,
// so if bootstrap.js's binding is ever renamed (a biome/lint "unused shadow"
// autofix did exactly this on 2026-07-19), every multichat call site silently
// retargets the lib object and throws at module load — chat dead, no build error.
// Assert the binding exists and covers every method multichat actually calls.
function checkMultichatCleanupBinding() {
  const mcDir = join(__dirname, 'src', 'multichat')
  const bootstrap = readFileSync(join(mcDir, 'bootstrap.js'), 'utf8')
  if (!/^const cleanup = \{/m.test(bootstrap)) {
    throw new Error(
      'build: src/multichat/bootstrap.js must declare top-level `const cleanup = {` — it shadows\n' +
        '       src/lib/cleanup.js (which has no addListener). Renaming it breaks multichat at load.',
    )
  }
  // Methods the bootstrap object defines (shorthand `name(...)  {` at 2-space indent)
  const defined = new Set()
  const body = bootstrap.slice(bootstrap.search(/^const cleanup = \{/m))
  for (const m of body.matchAll(/^ {2}(?:get )?([A-Za-z0-9_$]+)\s*\(/gm)) defined.add(m[1])
  const missing = new Set()
  for (const file of MULTICHAT_MODULES.concat(['main.js', 'twitch-host.js', 'kick-host.js', 'youtube-host.js'])) {
    const p = join(mcDir, file)
    if (!existsSync(p)) continue
    for (const m of readFileSync(p, 'utf8').matchAll(/\bcleanup\.([A-Za-z0-9_$]+)\s*\(/g)) {
      if (!defined.has(m[1])) missing.add(m[1])
    }
  }
  if (missing.size) {
    throw new Error(
      `build: multichat calls cleanup.${[...missing].join('/')}() but bootstrap's cleanup doesn't define it`,
    )
  }
  checkMultichatOrphanedRenames(mcDir)
}

// Companion guard, whole-directory: EVERY multichat file shares one flat
// bundle scope (build.js concatenates them all — see MULTICHAT_MODULES), so
// a top-level function in irc.js/auth-irc.js/main.js/etc. is just as
// cross-file-callable as one in bootstrap.js. A lint autofix that prefixes an
// "unused-looking" declaration with `_` (biome did this to bootstrap's
// cleanup/hsSched/log on 2026-07-19, AND separately to auth-irc.js's
// sendIrcMessage — a real prod outage: /announce, and likely every twitch
// text send, silently no-op'd with zero visible error) leaves every OTHER
// file's caller referencing the now-dead bare name — a hard ReferenceError at
// call time that syntax checks and tests never catch. Rule: if file A
// declares `_foo` at top level and file B (any file) still references bare
// `foo`, the rename orphaned its callers.
function checkMultichatOrphanedRenames(mcDir) {
  const files = MULTICHAT_MODULES.concat(['main.js', 'twitch-host.js', 'kick-host.js', 'youtube-host.js']).filter((f) =>
    existsSync(join(mcDir, f)),
  )
  const sources = new Map(files.map((f) => [f, readFileSync(join(mcDir, f), 'utf8')]))
  // name -> declaring file, for every top-level `_foo` declaration
  const underscoredBy = new Map()
  for (const [file, src] of sources) {
    for (const m of src.matchAll(
      /^(?:export\s+)?(?:async\s+)?(?:const|let|var|function|class)\s+_([A-Za-z0-9$][A-Za-z0-9_$]*)/gm,
    )) {
      if (!underscoredBy.has(m[1])) underscoredBy.set(m[1], file)
    }
  }
  if (!underscoredBy.size) return
  // Any declaration (const/let/var/function, ANY indentation — covers local
  // vars and nested functions too) of the bare name ANYWHERE in the
  // directory means a bare usage could legitimately resolve to THAT binding
  // instead of the underscored one (a same-file local var/nested fn, or an
  // unrelated same-named top-level export elsewhere) — not proof of an
  // orphan. Two real false positives hit this exact shape: a
  // `const modRow = document.createElement(...)` local var in one file
  // colliding by name with an unrelated `_modRow` function in another, and a
  // legitimately separate public `removeEmoteFromInventory` wrapping its own
  // private `_removeEmoteFromInventory` helper in the same file.
  const bareDeclaredAnywhere = new Set()
  for (const [, src] of sources) {
    for (const m of src.matchAll(
      /^\s*(?:export\s+)?(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z0-9$][A-Za-z0-9_$]*)/gm,
    )) {
      bareDeclaredAnywhere.add(m[1])
    }
  }
  const orphans = []
  for (const [name, declFile] of underscoredBy) {
    if (bareDeclaredAnywhere.has(name)) continue
    const usageRe = new RegExp(`(?<![.\\w$])${name}\\s*[.(]`)
    for (const [file, src] of sources) {
      if (file === declFile) continue
      if (usageRe.test(src)) orphans.push(`${name} (used bare in ${file}, but ${declFile} declares _${name})`)
    }
  }
  if (orphans.length) {
    throw new Error(
      `build: a lint autofix orphaned callers by underscoring a shared declaration:\n  ${orphans.join('\n  ')}`,
    )
  }
}

function checkScopeCollisions() {
  const LIB_FILES = [
    'error-reporter.js',
    'config.js',
    'cleanup.js',
    'user-key.js',
    'utils.js',
    'diag.js',
    'font-grid.js',
    'settings-schema.js',
    'browser-api.js',
    'modifiers.js',
    'undo-manager.js',
    // paint-spec.js (+ its synced-copy imports paint-core.js/scene-spec.js)
    // isn't part of readLib()'s universal bundle (only the multichat overlay
    // embeds them — see readMultichatModules), but they land in the same
    // outer scope as the lib files there, so they're checked here too.
    'paint-core.js',
    'scene-spec.js',
    'paint-spec.js',
  ]
  const libDir = join(__dirname, 'src', 'lib')
  const mcDir = join(__dirname, 'src', 'multichat')

  // Map name → declaration kind ('const'|'let'|'var'|'function'|'class') for each layer
  function extractDecls(dir, files) {
    const map = new Map() // name → kind
    const KIND_RE = /^(?:export\s+)?(?:(async)\s+)?(function|const|let|var|class)\s+([A-Za-z0-9_$]+)/
    for (const file of files) {
      const p = join(dir, file)
      if (!existsSync(p)) continue
      for (const line of readFileSync(p, 'utf8').split('\n')) {
        const m = KIND_RE.exec(line)
        if (!m) continue
        const kind = m[1] === 'async' ? 'function' : m[2]
        const name = m[3]
        if (!map.has(name)) map.set(name, kind)
      }
    }
    return map
  }

  // multichat layer: all MULTICHAT_MODULES + per-platform host modules + main.js
  const mcFiles = [...MULTICHAT_MODULES, 'kick-host.js', 'youtube-host.js', 'twitch-host.js', 'main.js']
  const libDecls = extractDecls(libDir, LIB_FILES)
  const mcDecls = extractDecls(mcDir, mcFiles)

  let hardErrors = 0
  for (const [name, mcKind] of mcDecls) {
    if (!libDecls.has(name)) continue
    if (SCOPE_COLLISION_ALLOWLIST.has(name)) continue
    const libKind = libDecls.get(name)
    const isHard = (mcKind === 'const' || mcKind === 'let') && (libKind === 'const' || libKind === 'let')
    if (isHard) {
      console.error(`  x scope collision (SyntaxError): '${name}' is ${libKind} in lib and ${mcKind} in multichat`)
      hardErrors++
    } else {
      console.warn(
        `  warn: scope shadow: '${name}' is ${libKind} in lib, ${mcKind} in multichat (function/var — JS allows, but check intent)`,
      )
    }
  }
  if (hardErrors > 0) {
    throw new Error(`checkScopeCollisions: ${hardErrors} const/let collision(s) would cause SyntaxError at runtime`)
  }
  console.log(`  Scope collisions: none (allowlist: ${[...SCOPE_COLLISION_ALLOWLIST].join(', ')}) ✓`)
}

// Guard 4: run the test suite before bundling.
// Skippable with --no-test for fast iterative rebuilds.
// Always forced on --package and --deploy.
//
// Pre-build gate: runs the unit suite (logic). tests/build.test.js validates
// dist OUTPUT and self-skips here (gated on HS_VERIFY_DIST) — it runs only in
// the post-build verification step below, against freshly built dist. That
// keeps this gate free of recursion and of stale-dist false failures.
function runTests(args) {
  const flags = new Set(args.filter((a) => a.startsWith('--')))
  const forceRun = flags.has('--package') || flags.has('--deploy')
  const skipTest = flags.has('--no-test') && !forceRun
  if (skipTest) {
    console.log('  Tests: skipped (--no-test)')
    return
  }
  console.log('  Running tests...')
  try {
    execFileSync('bun', ['test'], { stdio: 'inherit', cwd: __dirname })
  } catch (_e) {
    throw new Error('runTests: test suite failed — fix before building')
  }
  console.log('  Tests: passed ✓')
}

// Guard 5: error reporter scrub-pattern parity.
// background.js inlines a copy of the scrub logic from src/lib/error-reporter.js
// (service workers can't import lib/ modules). This guard compares the two
// canonical patterns — SENSITIVE_PARAMS and TEXT_SCRUB — so a token-format
// change in error-reporter.js that isn't mirrored in background.js fails loud.
function checkErrorReporterParity() {
  const bgSrc = readFileSync(join(__dirname, 'chrome', 'background.js'), 'utf8')
  const erSrc = readFileSync(join(__dirname, 'src', 'lib', 'error-reporter.js'), 'utf8')

  // Extract the SENSITIVE_PARAMS regex body (between outer slashes, before /i)
  function sensitiveParams(src) {
    const m = src.match(/SENSITIVE_PARAMS\s*=\s*\n?\s*\/([\s\S]+?)\/i\b/)
    return m ? m[1] : null
  }

  // Extract TEXT_SCRUB array body with bracket-depth tracking so nested
  // character classes (e.g. [A-Za-z0-9_\-+/=]) don't prematurely end the match.
  function textScrubBody(src) {
    const idx = src.search(/TEXT_SCRUB\s*=\s*\[/)
    if (idx === -1) return null
    const open = src.indexOf('[', idx)
    let depth = 0
    for (let i = open; i < src.length; i++) {
      if (src[i] === '[') depth++
      else if (src[i] === ']') {
        depth--
        if (depth === 0)
          return src
            .slice(open + 1, i)
            .replace(/\s+/g, ' ')
            .trim()
      }
    }
    return null
  }

  const bgSP = sensitiveParams(bgSrc)
  const erSP = sensitiveParams(erSrc)
  const bgTS = textScrubBody(bgSrc)
  const erTS = textScrubBody(erSrc)

  if (!bgSP || !erSP)
    throw new Error(
      'checkErrorReporterParity: could not extract SENSITIVE_PARAMS from background.js or error-reporter.js',
    )
  if (!bgTS || !erTS)
    throw new Error('checkErrorReporterParity: could not extract TEXT_SCRUB from background.js or error-reporter.js')
  if (bgSP !== erSP)
    throw new Error(
      `checkErrorReporterParity: SENSITIVE_PARAMS drift detected\n  background.js: ${bgSP.slice(0, 80)}\n  error-reporter.js: ${erSP.slice(0, 80)}`,
    )
  if (bgTS !== erTS)
    throw new Error(
      `checkErrorReporterParity: TEXT_SCRUB drift detected\n  background.js: ${bgTS.slice(0, 120)}\n  error-reporter.js: ${erTS.slice(0, 120)}`,
    )

  console.log('  Error reporter parity: scrub patterns match ✓')
}

// Guard 6: UI-sync-blocklist parity between src/lib/utils.js and
// chrome/background.js. The service worker can't import lib/ (same reason as
// checkErrorReporterParity above) so it keeps a hand-duplicated copy of
// UI_SYNC_BLOCKLIST / DEVICE_LOCAL_KEYS / OVERFLOW_MIRROR_KEYS /
// LARGE_KEY_SYNC_MAX. A silent drift here already caused a real bug once
// (background.js's blocklist was missing 'chatFilterRules', so a value under
// that key could reach chrome.storage.sync unsanitized) — this guard fails
// the build the moment the two copies disagree.
// Extract a top-level `function name(...){...}` body, whitespace-normalized,
// for cross-file parity diffing (SW + standalone files can't share imports).
function extractFnBody(src, name) {
  const i = src.search(new RegExp(`function ${name}\\s*\\(`))
  if (i < 0) return null
  const open = src.indexOf('{', i)
  let depth = 0
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}') {
      depth--
      if (depth === 0)
        return src
          .slice(open + 1, j)
          .replace(/\s+/g, ' ')
          .trim()
    }
  }
  return null
}

function checkUiSyncBlocklistParity() {
  const utilsSrc = readFileSync(join(__dirname, 'src', 'lib', 'utils.js'), 'utf8')
  const bgSrc = readFileSync(join(__dirname, 'chrome', 'background.js'), 'utf8')

  function extractSet(src, name) {
    const m = src.match(new RegExp(`const ${name}\\s*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)`))
    if (!m) return null
    return m[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .sort()
      .join(',')
  }
  function extractObjectLiteral(src, name) {
    const idx = src.search(new RegExp(`const ${name}\\s*=\\s*\\{`))
    if (idx === -1) return null
    const open = src.indexOf('{', idx)
    let depth = 0
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') {
        depth--
        if (depth === 0)
          return src
            .slice(open + 1, i)
            .replace(/\s+/g, ' ')
            .trim()
      }
    }
    return null
  }
  function extractConstNumber(src, name) {
    const m = src.match(new RegExp(`const ${name}\\s*=\\s*(\\d+)`))
    return m ? m[1] : null
  }

  const checks = [
    ['UI_SYNC_BLOCKLIST', extractSet(utilsSrc, 'UI_SYNC_BLOCKLIST'), extractSet(bgSrc, 'UI_SYNC_BLOCKLIST')],
    ['DEVICE_LOCAL_KEYS', extractSet(utilsSrc, 'DEVICE_LOCAL_KEYS'), extractSet(bgSrc, 'DEVICE_LOCAL_KEYS')],
    [
      'OVERFLOW_MIRROR_KEYS',
      extractObjectLiteral(utilsSrc, 'OVERFLOW_MIRROR_KEYS'),
      extractObjectLiteral(bgSrc, 'OVERFLOW_MIRROR_KEYS'),
    ],
    [
      'LARGE_KEY_SYNC_MAX',
      extractConstNumber(utilsSrc, 'LARGE_KEY_SYNC_MAX'),
      extractConstNumber(bgSrc, 'LARGE_KEY_SYNC_MAX'),
    ],
    // the consumers of those literals must also stay in lockstep (byte-identical, ungated until now)
    [
      'estimateSettingSize',
      extractFnBody(utilsSrc, 'estimateSettingSize'),
      extractFnBody(bgSrc, 'estimateSettingSize'),
    ],
    ['sanitizeUiSettings', extractFnBody(utilsSrc, 'sanitizeUiSettings'), extractFnBody(bgSrc, 'sanitizeUiSettings')],
  ]

  for (const [label, a, b] of checks) {
    if (!a || !b) throw new Error(`checkUiSyncBlocklistParity: could not extract ${label} from both files`)
    if (a !== b) {
      throw new Error(
        `checkUiSyncBlocklistParity: ${label} drift detected\n  src/lib/utils.js: ${a}\n  chrome/background.js: ${b}`,
      )
    }
  }

  console.log('  UI-sync parity: blocklist + estimateSettingSize/sanitizeUiSettings match ✓')
}

// Guard: userKey / userSetMatches are inlined in 3 files (src/lib/user-key.js,
// chrome/background.js, chrome/content.js) — the SW can't import and content.js
// must load standalone. A drift here would ship silently. Fail the build.
function checkUserKeyParity() {
  const files = [
    ['src/lib/user-key.js', readFileSync(join(__dirname, 'src', 'lib', 'user-key.js'), 'utf8')],
    ['chrome/background.js', readFileSync(join(__dirname, 'chrome', 'background.js'), 'utf8')],
    ['chrome/content.js', readFileSync(join(__dirname, 'chrome', 'content.js'), 'utf8')],
  ]
  for (const name of ['userKey', 'userSetMatches']) {
    const bodies = files.map(([label, src]) => [label, extractFnBody(src, name)])
    for (const [label, body] of bodies) {
      if (!body) throw new Error(`checkUserKeyParity: could not extract ${name} from ${label}`)
    }
    if (new Set(bodies.map(([, b]) => b)).size !== 1) {
      throw new Error(
        `checkUserKeyParity: ${name} drift across copies:\n` +
          bodies.map(([label, b]) => `  ${label}: ${b}`).join('\n'),
      )
    }
  }
  console.log('  user-key parity: user-key.js ⇄ background.js ⇄ content.js match ✓')
}

// Guard 7: escapeHtml coverage parity.
// Three local copies of escapeHtml exist (src/lib/utils.js, chrome/chat-injector.js,
// chrome/heatsync-button.js). Each must escape all five dangerous HTML chars.
// This guard fails the build if any copy drops an escape — preventing XSS regressions.
function checkEscapeHtmlCoverage() {
  const files = [
    { label: 'src/lib/utils.js', path: join(__dirname, 'src', 'lib', 'utils.js') },
    { label: 'chrome/chat-injector.js', path: join(__dirname, 'chrome', 'chat-injector.js') },
    { label: 'chrome/heatsync-button.js', path: join(__dirname, 'chrome', 'heatsync-button.js') },
  ]
  // Five required escape mappings: input char → at least one of the accepted output forms
  const REQUIRED = [
    { char: '&', outputs: ['&amp;'] },
    { char: '<', outputs: ['&lt;'] },
    { char: '>', outputs: ['&gt;'] },
    { char: '"', outputs: ['&quot;'] },
    { char: "'", outputs: ['&#x27;', '&#39;'] },
  ]

  // Extract the escapeHtml function body from source text.
  // Handles both multi-replace chain (utils.js) and single-regex map (injector/button).
  function extractBody(src) {
    const idx = src.search(/function escapeHtml\s*\(/)
    if (idx === -1) return null
    const open = src.indexOf('{', idx)
    let depth = 0
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') {
        depth--
        if (depth === 0) return src.slice(open + 1, i)
      }
    }
    return null
  }

  for (const { label, path } of files) {
    const src = readFileSync(path, 'utf8')
    const body = extractBody(src)
    if (!body) throw new Error(`checkEscapeHtmlCoverage: could not extract escapeHtml from ${label}`)
    for (const { char, outputs } of REQUIRED) {
      if (!outputs.some((out) => body.includes(out))) {
        throw new Error(
          `checkEscapeHtmlCoverage: ${label} escapeHtml does not escape '${char}' (expected one of: ${outputs.join(', ')})`,
        )
      }
    }
  }

  console.log('  EscapeHtml coverage: all 3 copies escape all 5 chars ✓')
}

const __dirname = dirname(fileURLToPath(import.meta.url))

const SRC_DIR = join(__dirname, 'src')
const CHROME_OUT = join(__dirname, 'dist', 'chrome')
const FIREFOX_OUT = join(__dirname, 'dist', 'firefox')

// Files that need lib bundled in (content scripts)
const CONTENT_SCRIPTS = [
  'content.js',
  'multichat-twitch.js',
  'multichat-kick.js',
  'multichat-youtube.js',
  'heatsync-button.js',
  'autocomplete-hook.js',
  'chat-injector.js',
  'youtube-content.js',
]

// Files to copy as-is (no lib bundling needed)
const COPY_FILES = [
  'background.js',
  'popup.js',
  'popup.html',
  'early-inject-main.js',
  'twitch-chat-intercept.js',
  'kick-nav-watcher.js',
  'kick-chat-intercept.js',
  'youtube-keyboard-guard.js',
  'yt-data-bridge.js',
  'platform-detector.js',
  'shared-utils.js',
  'emoji-data.js',
  'welcome.html',
  'welcome.js',
  'injected-message.css',
  'vi-mode.js',
  'kick-autocomplete-hook.js',
  'pcard-early.js',
  'early-layout.js',
]

// Assets (images, etc)
const ASSETS = ['icon-16.png', 'icon-48.png', 'icon-96.png', 'icon-128.png', 'icon-48-black.png']

// Strip ES module syntax from bundled files
function stripExports(content) {
  return (
    content
      .replace(/^export\s+default\s+\w+\s*;?\s*$/gm, '')
      .replace(/^export\s*\{[^}]*\}\s*;?\s*$/gm, '')
      .replace(/^export\s+(const|let|var|function|class)\s+/gm, '$1 ')
      // Relative imports between synced-copy modules (paint-spec.js imports
      // paint-core.js/scene-spec.js) — the bundle concatenates those files
      // into one scope in dependency order, so the import lines just go.
      // Multi-line `import { a,\n b } from './x.js'` included.
      .replace(/^import\s*\{[\s\S]*?\}\s*from\s*['"]\.\/[^'"]+['"];?\s*$/gm, '')
  )
}

// Lib concatenation order — dependency-sensitive:
// - diag after utils + error-reporter: hsQuery/hsQueryAll mirror qsArray/
//   qsaArray's contract and report into error-reporter's ring buffer.
// - font-grid before settings-schema: the schema's fontSize entry builds its
//   options from FONT_GRID, and these are concatenated into one scope in order.
const LIB_ORDER = [
  'error-reporter.js',
  'config.js',
  'cleanup.js',
  'user-key.js',
  'utils.js',
  'diag.js',
  'font-grid.js',
  'settings-schema.js',
  'browser-api.js',
  'modifiers.js',
  'undo-manager.js',
]

// Every content script gets the core: error-reporter/diag stay universal on
// purpose (crash observability is the whole reason they exist), utils/cleanup/
// browser-api are referenced everywhere. The rest is dead parse weight in the
// thin scripts (settings-schema alone is ~70KB), so it's opt-in per entry —
// verifyLibSlim() below fails the build if an entry starts referencing a lib
// file it doesn't embed.
const LIB_CORE = new Set(['error-reporter.js', 'cleanup.js', 'utils.js', 'diag.js', 'browser-api.js'])

// Opt-in lib files per non-multichat content script (multichat bundles embed
// the full lib). Derived from actual symbol use — keep in sync via the guard.
const LIB_EXTRAS = {
  'content.js': ['config.js', 'user-key.js', 'modifiers.js'],
  'youtube-content.js': ['config.js'],
  'autocomplete-hook.js': ['modifiers.js'],
  'heatsync-button.js': [],
  'chat-injector.js': [],
}

// Read lib files — full set by default, or core + the named extras.
function readLib(extras = null) {
  const libDir = join(SRC_DIR, 'lib')
  const files =
    extras === null ? LIB_ORDER : LIB_ORDER.filter((f) => LIB_CORE.has(f) || extras.includes(f))
  let combined = '// === HEATSYNC LIB (auto-bundled) ===\n'

  for (const file of files) {
    const content = readFileSync(join(libDir, file), 'utf8')
    combined += `\n// --- ${file} ---\n${stripExports(content)}\n`
  }

  combined += '// === END HEATSYNC LIB ===\n\n'
  return combined
}

// Guard for the slim lib: if an entry's source references any top-level
// declaration from a lib file it does NOT embed, fail loudly at build time
// instead of shipping a runtime ReferenceError. Comment mentions count as
// references — conservative on purpose.
function verifyLibSlim(entryName, entrySrc, extras) {
  const libDir = join(SRC_DIR, 'lib')
  const KIND_RE = /^(?:export\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/
  const dropped = LIB_ORDER.filter((f) => !LIB_CORE.has(f) && !extras.includes(f))
  const offenders = []
  for (const file of dropped) {
    for (const line of readFileSync(join(libDir, file), 'utf8').split('\n')) {
      const m = KIND_RE.exec(line)
      if (m && new RegExp(`\\b${m[1]}\\b`).test(entrySrc)) offenders.push(`${m[1]} (${file})`)
    }
  }
  if (offenders.length) {
    throw new Error(
      `build: ${entryName} references lib symbols it no longer embeds — add the file(s) to LIB_EXTRAS['${entryName}']:\n  ${offenders.join('\n  ')}`,
    )
  }
}

// Read multichat module files (only bundled into multichat-<platform>.js)
const MULTICHAT_MODULES = [
  'bootstrap.js',
  'palette.js',
  'kick-native-tap.js',
  'send-targets.js',
  'tab-messages.js',
  'notifs.js',
  'styles.js',
  'seen-state.js',
  'filter-rules.js',
  'user-notes.js',
  'mod-log.js',
  'live-search.js',
  'automod.js',
  'stream-stats.js',
  'player-guard.js',
  'mentions.js',
  'irc.js',
  'native-tap.js',
  'auth-irc.js',
  'kick-send.js',
  'emotes.js',
  'tooltips.js',
  'twitch-api.js',
  'feed-embed.js',
  'social.js',
  'whispers.js',
  'eventsub-whispers.js',
  'cross-follow.js',
  'input.js',
  'profile-card.js',
  'chat-logs.js',
  'pred-view.js',
  'paints.js',
  'cosmetics.js',
  'mod-toolbar.js',
  'automod-queue.js',
  'resize.js',
  'settings-ui.js',
  'channel-mgmt.js',
  'spa-nav.js',
  'type-to-focus.js',
]

// native-tap.js reads Twitch's React fiber tree — twitch-only, exclude on kick/youtube
// kick-native-tap.js pairs with chrome/kick-chat-intercept.js — kick-only
// kick-host.js / youtube-host.js / twitch-host.js: per-platform host DOM modules
const PLATFORM_MODULES = {
  twitch: [...MULTICHAT_MODULES.filter((f) => f !== 'kick-native-tap.js'), 'twitch-host.js'],
  kick: [...MULTICHAT_MODULES.filter((f) => f !== 'native-tap.js'), 'kick-host.js'],
  youtube: [...MULTICHAT_MODULES.filter((f) => f !== 'native-tap.js' && f !== 'kick-native-tap.js'), 'youtube-host.js'],
}

function readMultichatModules(platform) {
  const mcDir = join(SRC_DIR, 'multichat')
  // Note: __HS_HOST__ is intentionally NOT declared here as a const.
  // It is a free (global-scope) reference so esbuild's define option can
  // substitute it at minification time and constant-fold platform branches.
  // At dev/unminified runtime, typeof __HS_HOST__ !== 'undefined' → false,
  // so main.js falls back to location.hostname detection — correct for dev.
  let combined = '// === MULTICHAT MODULES (auto-bundled) ===\n'

  // emoji-data.js is NOT embedded: the isolated-world copy injected by the
  // manifest (content.js group on twitch/kick, own group on youtube) always
  // precedes the multichat bundle — same world, same run_at, earlier manifest
  // entry — so bare EMOJI_DATA references resolve through the scope chain.
  // Consumers are typeof/_emojiMap-guarded, so a missing global degrades to
  // no emoji autocomplete instead of throwing. Embedding it cost 124KB parse
  // per bundle per tab, on top of the manifest copies.

  // Paint spec compiler (src/lib/paint-spec.js) — only the multichat overlay
  // needs a CSS compiler, so it's embedded here (like emoji-data.js above)
  // rather than added to readLib()'s universal file list, which would bloat
  // every content script (autocomplete-hook, chat-injector, ...) with a
  // module none of them use.
  // Dependency order matters: paint-core (shared helpers) → scene-spec
  // (scene catalog/compiler) → paint-spec (validator/compiler, imports both).
  // stripExports drops the relative import lines; concatenation puts all
  // three in one scope, same shape the site gets from real ESM.
  for (const mod of ['paint-core.js', 'scene-spec.js', 'paint-spec.js']) {
    const p = join(SRC_DIR, 'lib', mod)
    if (existsSync(p)) {
      combined += `\n// --- lib/${mod} ---\n${stripExports(readFileSync(p, 'utf8'))}\n`
    }
  }

  // Plus-tenure token helpers (src/lib/plus-tenure.js) — same reasoning as
  // paint-spec.js above: only the multichat overlay renders the token, and
  // paints.js (below, in the modules loop) calls buildPlusTenureToken /
  // renderPlusTenureToken, so this must land in the bundle before it.
  const plusTenurePath = join(SRC_DIR, 'lib', 'plus-tenure.js')
  if (existsSync(plusTenurePath)) {
    combined += `\n// --- lib/plus-tenure.js ---\n${stripExports(readFileSync(plusTenurePath, 'utf8'))}\n`
  }

  const modules = PLATFORM_MODULES[platform] ?? MULTICHAT_MODULES
  for (const file of modules) {
    const filePath = join(mcDir, file)
    if (!existsSync(filePath)) continue
    let content = readFileSync(filePath, 'utf8')
    // styles.js holds no CSS — it's split into src/multichat/styles/*.css
    // fragments (so a stray backtick in a CSS comment can't silently terminate
    // the literal and break the bundle, as it killed v1.3.7). Concatenate the
    // fragments in filename order and re-embed as the css template literal here.
    if (file === 'styles.js') {
      const stylesDir = join(mcDir, 'styles')
      const cssFrags = readdirSync(stylesDir)
        .filter((f) => f.endsWith('.css'))
        .sort()
      if (!cssFrags.length) throw new Error('build: src/multichat/styles/ has no .css fragments')
      let cssBody = cssFrags.map((f) => readFileSync(join(stylesDir, f), 'utf8')).join('')
      // Packaged builds: minify the CSS here, at embed time — minifyDist's JS
      // pass can't touch string contents, so without this the shipped bundle
      // carries the full commented stylesheet (~437KB raw → ~215KB minified).
      // Dev builds stay unminified so greps against dist css keep working.
      // The __HS_FONT_COZETTE__ url() placeholder survives (quotes may drop —
      // styles.js replaces the bare token, so that's fine).
      if (shouldMinify) {
        // charset utf8: keep glyphs literal — the default ascii mode rewrites
        // them as \NN css escapes, which are illegal octal escapes inside the
        // JS template literal this css gets embedded into.
        cssBody = transformSync(cssBody, { loader: 'css', minify: true, charset: 'utf8' }).code
        if (!cssBody.includes('__HS_FONT_COZETTE__')) {
          throw new Error('build: css minify lost the __HS_FONT_COZETTE__ placeholder — font would silently die')
        }
      }
      if (cssBody.includes('`') || cssBody.includes('${')) {
        throw new Error(
          'build: a styles/*.css fragment contains a backtick or ${ — unsafe to embed in the css template literal',
        )
      }
      if (!content.includes("'__HS_STYLES_BUNDLE__'")) {
        throw new Error('build: styles.js missing __HS_STYLES_BUNDLE__ placeholder')
      }
      // function replacement avoids $-pattern interpretation in the CSS
      content = content.replace("'__HS_STYLES_BUNDLE__'", () => `\`${cssBody}\``)
    }
    combined += `\n// --- multichat/${file} ---\n${stripExports(content)}\n`
  }

  combined += '// === END MULTICHAT MODULES ===\n\n'
  return combined
}

// Inject lib at top of content script
// Lib goes at IIFE scope, original content gets a nested block scope
// so const/let declarations (DEBUG, cleanup, etc.) don't conflict
function bundleContentScript(srcPath, lib, mcModules) {
  let content = readFileSync(srcPath, 'utf8')

  // Check if already has lib bundled (from previous build of src file)
  if (content.includes('=== HEATSYNC LIB')) {
    content = content.replace(/\/\/ === HEATSYNC LIB[\s\S]*?\/\/ === END HEATSYNC LIB ===\n\n/, '')
  }
  if (content.includes('=== MULTICHAT MODULES')) {
    content = content.replace(/\/\/ === MULTICHAT MODULES[\s\S]*?\/\/ === END MULTICHAT MODULES ===\n\n/, '')
  }

  // Strip the module's own IIFE wrapper so its top-level declarations merge
  // into the bundle's shared block scope.
  let body = content
  const closeRe = /\}\s*\)\s*\(\s*\)\s*;?\s*$/
  if (mcModules != null) {
    // MULTICHAT bundle ONLY. Sibling modules (input.js, emotes.js, …) are
    // concatenated alongside main.js and reference its globals, so main.js's
    // wrapper MUST be stripped or every global is scope-trapped → the whole
    // bundle throws "X is not defined" and chat never loads. main.js opens
    // with `;(() => {` (biome's ASI-guard semicolon + arrow form); the old
    // gate only matched a bare `(() =>`, so the `;` slipped it past the strip
    // — that was the long-standing chat-break. Tolerate the leading `;` here.
    const stripped = content
      .replace(/^\s*\/\*[\s\S]*?\*\/\s*/, '')
      .replace(/^[\s;]+/, '')
      .trim()
    if ((stripped.startsWith('(function') || stripped.startsWith('(()')) && closeRe.test(content.trimEnd())) {
      body = content.replace(/^[\s\S]*?\((?:function\s*\(\)|(?:\(\)\s*=>))\s*\{[\s\n]*(?:'use strict';?\s*)?/, '')
      body = body.replace(closeRe, '')
      // Bulletproof: if either end survived, globals stay scope-trapped and the
      // bundle throws at runtime. Fail the build loudly instead.
      if (closeRe.test(body.trimEnd()) || body.length === content.length) {
        throw new Error(`build: IIFE wrapper not fully stripped in ${srcPath} — globals would be scope-trapped`)
      }
    }
  } else {
    // STANDALONE content scripts (chat-injector, autocomplete-hook, …) are
    // self-contained and have always run as nested IIFEs inside the lib
    // wrapper — they have no sibling modules, so there is nothing to merge
    // scopes with, and stripping them changes their scope and breaks them.
    // Keep the original conservative gate verbatim (does NOT match `;(() =>`).
    const stripped = content.replace(/^\s*\/\*[\s\S]*?\*\/\s*/, '').trim()
    if (stripped.startsWith('(function()') || stripped.startsWith('(() =>')) {
      body = content.replace(/^[\s\S]*?\((?:function\s*\(\)|(?:\(\)\s*=>))\s*\{[\s\n]*(?:'use strict';?\s*)?/, '')
      body = body.replace(closeRe, '')
    }
  }

  // Build: IIFE > lib at outer scope > content in block scope
  // Multichat modules go before body: bootstrap.js declares cleanup/log first,
  // then modules declare their state + functions, then body has state + init()
  const modules = mcModules ? `${mcModules}\n` : ''
  // Cheer-popup short-circuit: if this window was opened by heatsync's cheer
  // launcher (via window.open with name 'hs-cheer-<channel>'), skip ALL
  // heatsync content scripts so the popup runs pure twitch — chat, gem icon,
  // cheer modal all work in their native UI without heatsync's overlay
  // covering anything. Cheermote echoes still arrive in the MAIN tab's
  // multichat through the IRC stream, so renderer still fires there.
  const cheerPopupGuard = `if (typeof window !== 'undefined' && typeof window.name === 'string' && window.name.indexOf('hs-cheer-') === 0) return;`
  return `(function() {\n'use strict';\n${cheerPopupGuard}\n\n${lib}\n{\n${modules}${body}\n}\n})();`.replaceAll(
    '__HS_BUILD_STAMP__',
    BUILD_STAMP,
  )
}

// Build for a specific browser — into a STAGING dir, never the live one.
// dist/chrome is what a running Chromium has loaded as the unpacked ext; the
// old clean-then-repopulate flow left that dir torn (missing/half-written
// files) for the several seconds a build takes, and an MV3 service-worker
// restart landing inside that window reads a broken extension (see the
// 08-23/24 freeze incidents). Callers minify + syntax-check the staging dir,
// then swapDist() renames it into place — the live path is never torn.
function build(browser) {
  const finalDir = browser === 'chrome' ? CHROME_OUT : FIREFOX_OUT
  const outDir = `${finalDir}.staging`
  const manifestSrc = join(SRC_DIR, 'manifests', `${browser}.json`)

  // Clean and create output dir
  if (existsSync(outDir)) {
    rmSync(outDir, { recursive: true })
  }
  mkdirSync(outDir, { recursive: true })

  // Use Chrome source as base (it has the latest fixes)
  const chromeDir = join(__dirname, 'chrome')

  // Read lib
  const lib = readLib()
  const mcSrcPath = join(SRC_DIR, 'multichat', 'main.js')

  // Self-heal: chrome/multichat.js is the retired single-bundle name (pre
  // per-platform split) — unreferenced by any manifest, gitignored, excluded
  // from zips. A stale copy still bloats unpacked dev loads (~2.2MB), so
  // remove it whenever we build.
  const staleMc = join(chromeDir, 'multichat.js')
  if (existsSync(staleMc)) {
    rmSync(staleMc)
    console.log('  Removed stale chrome/multichat.js')
  }

  // Emit per-platform multichat bundles
  const PLATFORMS = ['twitch', 'kick', 'youtube']
  for (const platform of PLATFORMS) {
    const outFile = `multichat-${platform}.js`
    const mcModules = readMultichatModules(platform)
    const bundled = bundleContentScript(mcSrcPath, lib, mcModules)
    writeFileSync(join(outDir, outFile), bundled)
    // Write to chrome/ so unpacked extension loads the bundled version
    if (browser === 'chrome') {
      writeFileSync(join(chromeDir, outFile), bundled)
    }
    console.log(`  Bundled multichat-${platform}.js`)
  }

  // Bundle remaining content scripts (non-multichat)
  for (const file of CONTENT_SCRIPTS) {
    if (file.startsWith('multichat-')) continue // already handled above
    const srcPath = join(chromeDir, file)
    if (!existsSync(srcPath)) {
      console.log(`  Skip ${file} (not found)`)
      continue
    }
    // Slim lib per entry: core + only the lib files this script references
    // (LIB_EXTRAS). verifyLibSlim fails the build if the source drifts.
    const extras = LIB_EXTRAS[file] ?? []
    verifyLibSlim(file, readFileSync(srcPath, 'utf8'), extras)
    // youtube-content renders HeatSync spec paints on the NATIVE yt surface,
    // so it gets the paint-spec compiler appended to its lib — same embed the
    // multichat bundles use (readMultichatModules). Other content scripts
    // don't pay for it.
    //
    // ALL THREE, in dependency order. This used to append paint-spec.js alone
    // while claiming to match the multichat embed. stripExports removes the
    // `import { … } from './paint-core.js'` lines, so what landed in the
    // bundle was a compiler whose every helper — fnv1a, HEX_RE, isPlainObject,
    // syncDelayCalc, buildSceneCss, validateSceneSpec — was undefined: 56
    // ReferenceErrors waiting in one file. The typeof guard the old comment
    // relied on only covers the entry points, and an entry point that EXISTS
    // and throws is exactly what a typeof guard cannot see.
    let libFor = readLib(extras)
    if (file === 'youtube-content.js') {
      for (const mod of ['paint-core.js', 'scene-spec.js', 'paint-spec.js']) {
        const p = join(SRC_DIR, 'lib', mod)
        if (existsSync(p)) {
          libFor = `${libFor}\n// --- lib/${mod} ---\n${stripExports(readFileSync(p, 'utf8'))}\n`
        }
      }
    }
    const bundled = bundleContentScript(srcPath, libFor, null)
    writeFileSync(join(outDir, file), bundled)
    console.log(`  Bundled ${file}`)
  }

  // Copy other files
  for (const file of COPY_FILES) {
    const srcPath = join(chromeDir, file)
    if (!existsSync(srcPath)) continue
    cpSync(srcPath, join(outDir, file))
  }
  console.log(`  Copied ${COPY_FILES.filter((f) => existsSync(join(chromeDir, f))).length} files`)

  // emoji-data.iso.js: byte-identical copy of emoji-data.js for ISOLATED-world
  // content_scripts entries. Chrome injects a given FILE once per frame — on
  // twitch, the MAIN-world registration of emoji-data.js (autocomplete-hook
  // block) wins that dedupe and every ISOLATED entry listing the same filename
  // is silently skipped, leaving EMOJI_DATA undefined in the multichat world
  // (all consumers are typeof-guarded, so emoji autocomplete just vanished —
  // no error). Distinct filename per world sidesteps the dedupe while keeping
  // the single-parse win that 43f297b's unbundling was after.
  cpSync(join(chromeDir, 'emoji-data.js'), join(outDir, 'emoji-data.iso.js'))
  // Also write the iso copy into chrome/ — manifest.json (mirrored below for
  // the unpacked dev extension) references emoji-data.iso.js in its
  // content_scripts entries; without it the dev-loaded chrome/ dir is
  // un-loadable.
  if (browser === 'chrome') cpSync(join(chromeDir, 'emoji-data.js'), join(chromeDir, 'emoji-data.iso.js'))

  // Copy assets
  for (const file of ASSETS) {
    const srcPath = join(chromeDir, file)
    if (!existsSync(srcPath)) continue
    cpSync(srcPath, join(outDir, file))
  }
  console.log(`  Copied ${ASSETS.length} assets`)

  // Copy manifest
  cpSync(manifestSrc, join(outDir, 'manifest.json'))
  // Also write to chrome/ so unpacked extension loads the updated manifest
  if (browser === 'chrome') {
    cpSync(manifestSrc, join(__dirname, 'chrome', 'manifest.json'))
  }
  console.log(`  Copied manifest (${browser})`)

  // Copy _locales
  const localesDir = join(SRC_DIR, '_locales')
  if (existsSync(localesDir)) {
    cpSync(localesDir, join(outDir, '_locales'), { recursive: true })
    cpSync(localesDir, join(chromeDir, '_locales'), { recursive: true })
    console.log(`  Copied _locales`)
  }

  // Copy fonts (bundled bitmap font: CozetteVector)
  const fontsDir = join(chromeDir, 'fonts')
  if (existsSync(fontsDir)) {
    cpSync(fontsDir, join(outDir, 'fonts'), { recursive: true })
    console.log(`  Copied fonts`)
  }

  console.log(`✓ Built ${browser} → ${outDir}`)
  return outDir
}

// Atomically promote a finished staging dir to the live path. Two renames —
// the live dir is missing only for the microseconds between them, instead of
// the seconds a full rebuild takes. Any crash-leftover .old is reaped first.
function swapDist(stageDir, liveDir) {
  const old = `${liveDir}.old`
  if (existsSync(old)) rmSync(old, { recursive: true })
  if (existsSync(liveDir)) renameSync(liveDir, old)
  renameSync(stageDir, liveDir)
  rmSync(old, { recursive: true, force: true })
}

// Read version from chrome manifest (single source of truth)
function getVersion() {
  const manifest = JSON.parse(readFileSync(join(SRC_DIR, 'manifests', 'chrome.json'), 'utf8'))
  return manifest.version
}

// Run `node --check` over every JS file in the built output. Catches
// template-literal termination bugs (a CSS comment with a stray backtick
// killed v1.3.7 content.js silently). Hard-fails the build on first error.
function syntaxCheck(outDir, browser) {
  const files = readdirSync(outDir).filter((f) => f.endsWith('.js'))
  let failed = 0
  for (const f of files) {
    const p = join(outDir, f)
    try {
      execFileSync('node', ['--check', p], { stdio: 'pipe' })
    } catch (e) {
      failed++
      const stderr = (e.stderr || '').toString().split('\n').slice(0, 4).join('\n')
      console.error(`  x ${browser}/${f} parse error:\n${stderr}`)
    }
  }
  if (failed > 0) {
    throw new Error(`syntaxCheck: ${failed} file(s) failed to parse in ${browser} build`)
  }
  console.log(`  Syntax check: ${files.length} files clean`)
}

// Build a source zip suitable for AMO source-code review:
// - everything needed to reproduce the build (chrome/, src/, build.js, lockfile, package.json)
// - reviewer-facing docs (README, CHANGELOG, LICENSE, TESTER-GUIDE, etc.)
// - excludes generated multichat.js (regenerated from src/multichat/), dist/, node_modules/, .git/
function buildSourceZip() {
  const version = getVersion()
  const zipName = `heatsync-source-${version}.zip`
  const zipPath = join(__dirname, 'dist', zipName)
  if (existsSync(zipPath)) rmSync(zipPath)

  const include = [
    'chrome',
    'src',
    'build.js',
    'bun.lock',
    'package.json',
    'README.md',
    'CHANGELOG.md',
    'CONTRIBUTING.md',
    'LICENSE',
    'SECURITY.md',
    'TESTER-GUIDE.md',
  ].filter((p) => existsSync(join(__dirname, p)))

  const excludes = [
    'chrome/multichat-twitch.js',
    'chrome/multichat-kick.js',
    'chrome/multichat-youtube.js',
    'dist/*',
    'node_modules/*',
    '.git/*',
    '*/.DS_Store',
  ]
  const args = ['-rq', zipPath, ...include]
  for (const ex of excludes) args.push('-x', ex)
  execFileSync('zip', args, { cwd: __dirname, stdio: 'inherit' })
  console.log(`  ${zipName}`)
  return zipPath
}

// Zip a built extension directory
function packageBrowser(browser) {
  const version = getVersion()
  const outDir = browser === 'chrome' ? CHROME_OUT : FIREFOX_OUT
  const zipName = `heatsync-${browser}-${version}.zip`
  const zipPath = join(__dirname, 'dist', zipName)

  if (!existsSync(outDir)) {
    console.error(`  ✗ ${outDir} not found — build first`)
    process.exit(1)
  }

  // Remove old zip if exists
  if (existsSync(zipPath)) rmSync(zipPath)

  // Zip from inside the build dir so paths are relative
  execFileSync('zip', ['-r', zipPath, '.'], { cwd: outDir, stdio: 'inherit' })
  console.log(`  ${zipName}`)
  return zipPath
}

// Deploy zips to production server
function deploy() {
  const distDir = join(__dirname, 'dist')
  console.log('\nDeploying to server...')
  const zips = readdirSync(distDir)
    .filter((f) => f.startsWith('heatsync-') && f.endsWith('.zip'))
    .map((f) => join(distDir, f))
  if (zips.length === 0) {
    console.error('  no zips to deploy')
    return
  }
  execFileSync('rsync', ['-avz', '--chmod=F644,D755', ...zips, 'heatsync:/opt/heatsync/dist/downloads/'], {
    stdio: 'inherit',
  })
  console.log('Deployed')
}

// Minify a content script in place inside its dist dir.
// Preserves the IIFE wrapper; safe-mode flags so we don't break runtime semantics.
// extraDefines: passed for per-platform multichat bundles so esbuild can constant-fold
// __HS_HOST__ and dead-code-eliminate cross-platform branches at minification time.
function minifyDistFile(outDir, file, extraDefines) {
  const path = join(outDir, file)
  if (!existsSync(path)) return
  const src = readFileSync(path, 'utf8')
  try {
    const result = transformSync(src, {
      loader: 'js',
      minify: true,
      target: 'es2020',
      legalComments: 'none',
      keepNames: true, // helps stack traces in prod
      ...(extraDefines ? { define: extraDefines } : {}),
    })
    writeFileSync(path, result.code)
  } catch (e) {
    console.warn(`  ⚠ minify ${file} skipped: ${e.message?.split('\n')[0]}`)
  }
}

// Map multichat-<platform>.js filenames to their platform string for define injection
const MULTICHAT_PLATFORM_DEFINE = {
  'multichat-twitch.js': 'twitch',
  'multichat-kick.js': 'kick',
  'multichat-youtube.js': 'youtube',
}

function minifyDist(outDir) {
  const targets = [...CONTENT_SCRIPTS, ...COPY_FILES.filter((f) => f.endsWith('.js'))]
  let bytesBefore = 0,
    bytesAfter = 0
  for (const f of targets) {
    const p = join(outDir, f)
    if (!existsSync(p)) continue
    bytesBefore += readFileSync(p).length
    const platform = MULTICHAT_PLATFORM_DEFINE[f]
    // __HS_DEV_BUILD__ → false in every minified (packaged/released/store) bundle,
    // so the nonce-less dev reload relaxation in content.js is dead-code-eliminated
    // for real users. Dev builds skip minify → the identifier stays undefined →
    // content.js's `typeof` guard treats it as dev-mode-on. Fail-closed: only the
    // packaged build path (which minifies) flips it off, and that's exactly the
    // store artifact.
    const extraDefines = { __HS_DEV_BUILD__: 'false', ...(platform ? { __HS_HOST__: JSON.stringify(platform) } : {}) }
    minifyDistFile(outDir, f, extraDefines)
    bytesAfter += readFileSync(p).length
  }
  // Fail-closed: the nonce-less dev-reload relaxation MUST be compiled out of
  // every minified (packaged/store) build. minifyDistFile swallows esbuild
  // transform errors (warn + continue), so a failed fold would silently leave
  // the raw __HS_DEV_BUILD__ identifier in content.js → devBuild=true would ship
  // to real users. Refuse to build instead of risking it.
  const _contentOut = join(outDir, 'content.js')
  if (existsSync(_contentOut) && readFileSync(_contentOut, 'utf8').includes('__HS_DEV_BUILD__')) {
    throw new Error(
      'build: content.js still references __HS_DEV_BUILD__ after minify — dev-reload guard not folded; refusing to ship a build that could enable nonce-less reload for store users',
    )
  }
  // Fail-closed: the page-reachable hs-dbg-* diagnostic listeners (real authed
  // chat send via hs-dbg-test-send + private-state dumps) MUST be dead-code-
  // eliminated from every packaged multichat bundle. If the __HS_DEV_BUILD__ fold
  // failed, the sentinel string survives — refuse to ship rather than expose it.
  for (const f of Object.keys(MULTICHAT_PLATFORM_DEFINE)) {
    const p = join(outDir, f)
    if (existsSync(p) && readFileSync(p, 'utf8').includes('hs-dbg-test-send')) {
      throw new Error(
        `build: ${f} still contains hs-dbg-test-send after minify — dev-only diagnostic listeners not stripped; refusing to ship a bundle that lets any page script send chat as the user`,
      )
    }
  }
  if (bytesBefore > 0) {
    const pct = ((1 - bytesAfter / bytesBefore) * 100).toFixed(1)
    console.log(
      `  Minified ${targets.length} files: ${(bytesBefore / 1024).toFixed(0)}KB → ${(bytesAfter / 1024).toFixed(0)}KB (${pct}% smaller)`,
    )
  }
}

// Main
const args = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith('--')))
const targets = args.filter((a) => !a.startsWith('--'))
const target = targets[0] || null
const shouldPackage = flags.has('--package') || flags.has('--deploy')
const shouldDeploy = flags.has('--deploy')
const shouldMinify = flags.has('--minify') || shouldPackage || shouldDeploy
const shouldSource = flags.has('--source') || shouldPackage

// Zero-supply-chain gate: the extension ships hand-written vanilla JS with no
// runtime dependencies. Any runtime dep is a supply-chain attack surface, so
// fail the build to keep the invariant from silently regressing.
function checkNoRuntimeDeps() {
  const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8'))
  const deps = Object.keys(pkg.dependencies || {})
  if (deps.length) {
    throw new Error(
      `checkNoRuntimeDeps: ${deps.length} runtime dependency(ies) present (${deps.join(', ')}); extension ships zero runtime deps`,
    )
  }
  console.log('  Zero runtime dependencies ✓')
}

// No-dynamic-code gate: we ship no eval()/new Function(). Extension-page CSP
// blocks eval, but MAIN-world scripts run under the host page's CSP, so enforce
// it at build time too. Comments are stripped before scanning.
function checkNoDynamicCode() {
  const offenders = []
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name)
      if (ent.isDirectory()) walk(p)
      else if (ent.name.endsWith('.js')) {
        const code = readFileSync(p, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/[^\n]*/g, '')
        if (/\beval\s*\(|\bnew\s+Function\s*\(/.test(code)) offenders.push(p)
      }
    }
  }
  for (const r of ['chrome', 'src']) {
    const root = join(__dirname, r)
    if (existsSync(root)) walk(root)
  }
  if (offenders.length) {
    throw new Error(`checkNoDynamicCode: dynamic code execution found in:\n  ${offenders.join('\n  ')}`)
  }
  console.log('  No eval()/new Function() ✓')
}

console.log('Building heatsync extension...\n')

// ── Pre-build gate ────────────────────────────────────────────────────────────
console.log('Pre-build checks:')
checkVersionSync()
checkManifestParity()
checkScopeCollisions()
checkMultichatCleanupBinding()
checkErrorReporterParity()
checkUiSyncBlocklistParity()
checkUserKeyParity()
checkEscapeHtmlCoverage()
checkNoRuntimeDeps()
checkNoDynamicCode()
runTests(args)
console.log()

// Settings-registry lint — duplicate keys, invalid defaults, sync-quota
// budget, UI_SYNC_BLOCKLIST mismatches. Hard-fails before any bundling.
{
  const { SETTINGS, lintSettings } = await import('./src/lib/settings-schema.js')
  const { UI_SYNC_BLOCKLIST } = await import('./src/lib/utils.js')
  const problems = lintSettings(UI_SYNC_BLOCKLIST)
  if (problems.length) {
    for (const p of problems) console.error(`  x settings-schema: ${p}`)
    throw new Error(`settings-schema lint: ${problems.length} problem(s)`)
  }
  console.log(`Settings registry: ${SETTINGS.length} entries clean`)
}

if (!target || target === 'chrome') {
  console.log('Chrome:')
  const stage = build('chrome')
  if (shouldMinify) minifyDist(stage)
  syntaxCheck(stage, 'chrome')
  swapDist(stage, CHROME_OUT)
}

if (!target || target === 'firefox') {
  console.log('\nFirefox:')
  const stage = build('firefox')
  if (shouldMinify) minifyDist(stage)
  syntaxCheck(stage, 'firefox')
  swapDist(stage, FIREFOX_OUT)
}

if (shouldPackage) {
  console.log('\nPackaging:')
  if (!target || target === 'chrome') packageBrowser('chrome')
  if (!target || target === 'firefox') packageBrowser('firefox')
}

if (shouldSource) {
  console.log('\nSource zip:')
  buildSourceZip()
}

// ── Post-build verification ────────────────────────────────────────────────
// Validate the freshly built dist/ (required files, manifest fields, version
// sync, CSP). Runs only on a full both-target build and when tests aren't
// skipped — single-target builds leave the other dist stale, which would fail
// the cross-target assertions. Gated env var ensures tests/build.test.js runs
// ONLY here, against fresh output (never recursive, never on stale dist).
if (!target && !(flags.has('--no-test') && !shouldPackage)) {
  console.log('\nPost-build verification:')
  try {
    execFileSync('bun', ['test', 'tests/build.test.js'], {
      stdio: 'inherit',
      cwd: __dirname,
      env: { ...process.env, HS_VERIFY_DIST: '1' },
    })
  } catch (_e) {
    throw new Error('post-build verification failed — dist output invalid')
  }
}

if (shouldDeploy) deploy()

console.log('\nDone!')
