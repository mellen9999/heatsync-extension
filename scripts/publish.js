#!/usr/bin/env bun
// one-command release publisher — chrome web store + amo (firefox listed channel).
//
// usage:
//   bun scripts/publish.js                          # dry-run, current version, both stores
//   bun scripts/publish.js --version 1.7.24 --publish   # bump + build + publish both
//   bun scripts/publish.js --chrome-only --publish
//   bun scripts/publish.js --firefox-only --publish
//   bun scripts/publish.js --cws-auth                # one-time: mint a CWS_REFRESH_TOKEN
//
// safe by default: without --publish, nothing is ever uploaded — every network
// call to a store api is skipped and logged instead. --dry-run forces that same
// no-network behavior even if --publish is also passed.
//
// credentials live in ~/.config/heatsync/publish.env (chmod 600, never in the
// repo). see README.md "releasing" for one-time setup.

import { execFileSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { amoFetchWithRetry, amoHealthy } from './lib/amo-retry.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(__dirname)

const CWS_ITEM_ID = 'afadollcanjpemaonbgnkhjddaebjeja'
const AMO_SLUG = 'heatsync-chat'
const REQUIRED_KEYS = ['AMO_JWT_ISSUER', 'AMO_JWT_SECRET', 'CWS_CLIENT_ID', 'CWS_CLIENT_SECRET', 'CWS_REFRESH_TOKEN']

// ── args ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--') && !a.includes('=')))
  function value(name) {
    const eq = argv.find((a) => a.startsWith(`--${name}=`))
    if (eq) return eq.slice(name.length + 3)
    const i = argv.indexOf(`--${name}`)
    if (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1]
    return null
  }
  const opts = {
    version: value('version'),
    chromeOnly: flags.has('--chrome-only'),
    firefoxOnly: flags.has('--firefox-only'),
    dryRun: flags.has('--dry-run'),
    publish: flags.has('--publish'),
    cwsAuth: flags.has('--cws-auth'),
    setCreds: flags.has('--set-creds'),
  }
  if (opts.chromeOnly && opts.firefoxOnly) {
    console.error('error: --chrome-only and --firefox-only are mutually exclusive')
    process.exit(1)
  }
  if (opts.version && !/^\d+\.\d+\.\d+$/.test(opts.version)) {
    console.error(`error: --version must be X.Y.Z, got "${opts.version}"`)
    process.exit(1)
  }
  return opts
}

// ── credentials ──────────────────────────────────────────────────────────────

function credsPath() {
  return join(homedir(), '.config', 'heatsync', 'publish.env')
}

function parseEnvFile(path) {
  if (!existsSync(path)) return null
  const map = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq === -1) continue
    map[t.slice(0, eq).trim()] = t.slice(eq + 1).trim()
  }
  return map
}

function printChecklist(missing, fileMissing) {
  const path = credsPath()
  console.error(fileMissing ? `no credentials file at ${path}` : `missing key(s) in ${path}: ${missing.join(', ')}`)
  console.error(`
create/edit ${path} (chmod 600) with:

  AMO_JWT_ISSUER=...
  AMO_JWT_SECRET=...
  CWS_CLIENT_ID=...
  CWS_CLIENT_SECRET=...
  CWS_REFRESH_TOKEN=...

1. amo (firefox) api keys
   https://addons.mozilla.org/en-US/developers/addon/api/key/
   generate credentials -> paste JWT issuer/secret into AMO_JWT_ISSUER / AMO_JWT_SECRET

2. chrome web store api
   a. Google Cloud Console -> project -> enable "Chrome Web Store API"
   b. APIs & Services -> Credentials -> Create Credentials -> OAuth client ID -> type "Desktop app"
   c. paste Client ID / Client Secret into CWS_CLIENT_ID / CWS_CLIENT_SECRET
   d. bun scripts/publish.js --cws-auth
      (prints a consent url, paste the code back — writes CWS_REFRESH_TOKEN for you, never printed)

3. chmod 600 ${path}
`)
}

function loadCreds(required = REQUIRED_KEYS) {
  const path = credsPath()
  const map = parseEnvFile(path)
  const missing = map ? required.filter((k) => !map[k]) : required
  if (!map || missing.length) {
    printChecklist(missing, !map)
    process.exit(1)
  }
  const mode = statSync(path).mode & 0o777
  if (mode & 0o077) {
    console.error(`error: ${path} is mode ${mode.toString(8)} — secrets file must be chmod 600`)
    console.error(`  chmod 600 ${path}`)
    process.exit(1)
  }
  return map
}

function writeCredValue(path, key, value) {
  mkdirSync(dirname(path), { recursive: true })
  const kept = existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter((l) => l.trim() && !l.trim().startsWith(`${key}=`))
    : []
  kept.push(`${key}=${value}`)
  writeFileSync(path, `${kept.join('\n')}\n`)
  chmodSync(path, 0o600)
}

// ── set-creds: masked entry, so a secret never lands in a shell transcript ───

/** Prompt without echoing the typed characters. */
function promptSecret(label) {
  return new Promise((resolve) => {
    process.stdout.write(label)
    const stdin = process.stdin
    const wasRaw = stdin.isRaw
    stdin.setRawMode?.(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    let buf = ''
    const done = (value) => {
      stdin.setRawMode?.(wasRaw ?? false)
      stdin.pause()
      stdin.off('data', onData)
      process.stdout.write('\n')
      resolve(value)
    }
    const onData = (ch) => {
      if (ch === '\r' || ch === '\n' || ch === '\u0004') return done(buf.trim())
      if (ch === '\u0003') {
        // ctrl-c
        stdin.setRawMode?.(wasRaw ?? false)
        process.stdout.write('\n')
        process.exit(130)
      }
      if (ch === '\u007f' || ch === '\b') {
        buf = buf.slice(0, -1)
        return
      }
      // ignore other control chars (arrows/escape sequences) — no echo either way
      if (ch >= ' ') buf += ch
    }
    stdin.on('data', onData)
  })
}

/** Interactively fill the creds file. Values are never echoed or logged. */
async function setCredsFlow() {
  const path = credsPath()
  const existing = parseEnvFile(path) || {}
  const keys = ['AMO_JWT_ISSUER', 'AMO_JWT_SECRET', 'CWS_CLIENT_ID', 'CWS_CLIENT_SECRET']
  console.log(`writing to ${path} (chmod 600). input is hidden; blank keeps the current value.\n`)
  for (const key of keys) {
    const have = existing[key] ? ' [set]' : ''
    const value = await promptSecret(`${key}${have}: `)
    if (value) writeCredValue(path, key, value)
  }
  const after = parseEnvFile(path) || {}
  const still = keys.filter((k) => !after[k])
  console.log(still.length ? `\nstill missing: ${still.join(', ')}` : '\nall 4 keys set.')
  console.log(
    after.CWS_REFRESH_TOKEN
      ? 'CWS_REFRESH_TOKEN already present — you are ready to publish.'
      : 'next: bun scripts/publish.js --cws-auth   (gets CWS_REFRESH_TOKEN)',
  )
}

// ── cws-auth: one-time oauth code exchange, writes CWS_REFRESH_TOKEN ─────────

async function cwsAuthFlow() {
  const path = credsPath()
  const map = parseEnvFile(path) || {}
  if (!map.CWS_CLIENT_ID || !map.CWS_CLIENT_SECRET) {
    console.error(`CWS_CLIENT_ID / CWS_CLIENT_SECRET not found in ${path}`)
    console.error('create a Google Cloud OAuth client (type "Desktop app") and add both keys first')
    console.error('see README.md "releasing" for the exact steps')
    process.exit(1)
  }

  // Loopback, NOT urn:ietf:wg:oauth:2.0:oob — Google blocked the out-of-band
  // copy-paste-the-code flow (desktop clients must redirect to 127.0.0.1).
  const port = 8976
  const redirectUri = `http://127.0.0.1:${port}`
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
    client_id: map.CWS_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/chromewebstore',
    access_type: 'offline',
    prompt: 'consent',
  })}`

  console.log(`\nadd this EXACT redirect uri to the OAuth client first:\n  ${redirectUri}\n`)
  console.log('then open this url and approve access:\n')
  console.log(`  ${authUrl}\n`)
  console.log(`waiting for the redirect on ${redirectUri} …  (ctrl-c to abort)`)

  const code = await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, redirectUri)
      const got = url.searchParams.get('code')
      const err = url.searchParams.get('error')
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end(got ? 'ok — code received. close this tab.' : `failed: ${err || 'no code'}`)
      server.close()
      got ? resolve(got) : reject(new Error(err || 'no code in redirect'))
    })
    server.on('error', reject)
    server.listen(port, '127.0.0.1')
    setTimeout(() => {
      server.close()
      reject(new Error('timed out after 5min waiting for the oauth redirect'))
    }, 300_000).unref?.()
  }).catch((e) => {
    console.error(`oauth failed: ${e.message}`)
    process.exit(1)
  })

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: map.CWS_CLIENT_ID,
      client_secret: map.CWS_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  })
  const data = await res.json()
  if (!res.ok || !data.refresh_token) {
    console.error(`token exchange failed (${res.status}): ${data.error || 'unknown error'}`)
    if (res.ok && !data.refresh_token) {
      console.error(
        'no refresh_token in response — revoke prior access at https://myaccount.google.com/permissions and retry',
      )
    }
    process.exit(1)
  }

  writeCredValue(path, 'CWS_REFRESH_TOKEN', data.refresh_token)
  console.log(`\nwrote CWS_REFRESH_TOKEN to ${path} (chmod 600)`)
}

// ── version bump + build ─────────────────────────────────────────────────────

function getCurrentVersion() {
  return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
}

function bumpVersion(newVersion) {
  for (const rel of ['package.json', 'src/manifests/chrome.json', 'src/manifests/firefox.json']) {
    const p = join(ROOT, rel)
    const obj = JSON.parse(readFileSync(p, 'utf8'))
    obj.version = newVersion
    writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`)
  }
  console.log(`  bumped version -> ${newVersion} (package.json, chrome.json, firefox.json)`)
}

function runBuild(target) {
  const args = ['build.js']
  if (target) args.push(target)
  args.push('--package')
  console.log(`\n$ bun ${args.join(' ')}\n`)
  execFileSync('bun', args, { stdio: 'inherit', cwd: ROOT })
}

function verifyCheckVersions() {
  execFileSync('bun', ['tests/check-versions.js'], { stdio: 'inherit', cwd: ROOT })
}

function zipPaths(ver) {
  return {
    chrome: join(ROOT, 'dist', `heatsync-chrome-${ver}.zip`),
    firefox: join(ROOT, 'dist', `heatsync-firefox-${ver}.zip`),
    source: join(ROOT, 'dist', `heatsync-source-${ver}.zip`),
  }
}

// ── release notes / approval notes ──────────────────────────────────────────

function composeReleaseNotes() {
  const placeholder = '(edit release notes before approving — see git log for changes in this version)'
  try {
    const tags = execFileSync('git', ['tag', '--sort=-v:refname'], { cwd: ROOT })
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean)
    const prevTag = tags[0]
    if (!prevTag) return placeholder
    const log = execFileSync('git', ['log', `${prevTag}..HEAD`, '--oneline', '--no-merges'], { cwd: ROOT })
      .toString()
      .trim()
    if (!log) return placeholder
    const notes = log
      .split('\n')
      .map((l) => `- ${l.replace(/^[0-9a-f]+\s+/, '')}`)
      .join('\n')
    // AMO caps release_notes at 3000 chars; a long release (dozens of commits)
    // blows past it and 400s at version-create. Truncate at a line boundary,
    // keeping the newest commits (git log is newest-first).
    const AMO_NOTES_MAX = 3000
    if (notes.length <= AMO_NOTES_MAX) return notes
    const marker = '\n- …see the full changelog in the repo'
    const budget = AMO_NOTES_MAX - marker.length
    const kept = notes.slice(0, budget)
    return kept.slice(0, kept.lastIndexOf('\n')) + marker
  } catch {
    return placeholder
  }
}

function composeApprovalNotes(ver) {
  let bunVersion = 'latest'
  try {
    bunVersion = execFileSync('bun', ['--version']).toString().trim()
  } catch {}
  return [
    'reproducible build:',
    `  1. bun ${bunVersion} (https://bun.sh)`,
    '  2. git clone https://github.com/mellen9999/heatsync-extension.git && cd heatsync-extension',
    `  3. git checkout v${ver}`,
    '  4. bun install',
    '  5. bun run build.js firefox --package',
    `output: dist/firefox/ (unpacked), dist/heatsync-firefox-${ver}.zip (submitted build)`,
    '',
    'no remote code is executed at build or runtime — zero runtime dependencies ' +
      '(enforced by build.js checkNoRuntimeDeps), no eval()/new Function() anywhere in src/ or chrome/ ' +
      '(enforced by build.js checkNoDynamicCode). full source for this build is attached as the source zip.',
  ].join('\n')
}

// ── chrome web store ─────────────────────────────────────────────────────────

async function refreshChromeAccessToken(creds) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: creds.CWS_CLIENT_ID,
      client_secret: creds.CWS_CLIENT_SECRET,
      refresh_token: creds.CWS_REFRESH_TOKEN,
    }),
  })
  const data = await res.json()
  if (!res.ok || !data.access_token) {
    // invalid_grant on a token that used to work = google expired it. Refresh
    // tokens live only 7 days while the OAuth consent screen is in "Testing";
    // publishing the consent screen to production makes them permanent.
    if (data.error === 'invalid_grant') {
      throw new Error(
        'chrome token refresh failed: refresh token expired or revoked.\n' +
          '  re-mint it:  bun scripts/publish.js --cws-auth\n' +
          '  permanent fix: set the OAuth consent screen to "In production" (Testing expires tokens every 7 days)',
      )
    }
    throw new Error(
      `chrome token refresh failed: ${res.status} ${data.error || ''} ${data.error_description || ''}`.trim(),
    )
  }
  return data.access_token
}

async function uploadChromeZip(token, zipPath) {
  const res = await fetch(
    `https://www.googleapis.com/upload/chromewebstore/v1.1/items/${CWS_ITEM_ID}?uploadType=media`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'x-goog-api-version': '2' },
      body: readFileSync(zipPath),
    },
  )
  const data = await res.json()
  if (data.uploadState !== 'SUCCESS') {
    const errs = (data.itemError || []).map((e) => `${e.error_code}: ${e.error_detail}`).join('; ')
    throw new Error(`chrome upload failed (${data.uploadState || res.status}): ${errs || JSON.stringify(data)}`)
  }
}

// CWS needs a beat between "upload accepted" and "publishable" — publishing
// immediately after the PUT answers 400 with an empty body (hit on the 1.7.43
// release; the identical call succeeded a minute later). Retry rather than
// failing a release that only needed to wait, and print the raw body when it
// really is broken — an empty "400 — " told us nothing.
async function publishChromeItem(token) {
  const ATTEMPTS = 5
  const WAIT_MS = 8000
  let lastErr = ''
  for (let i = 1; i <= ATTEMPTS; i++) {
    const res = await fetch(`https://www.googleapis.com/chromewebstore/v1.1/items/${CWS_ITEM_ID}/publish`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'x-goog-api-version': '2', 'Content-Length': '0' },
    })
    const raw = await res.text()
    let data = {}
    try {
      data = JSON.parse(raw)
    } catch {}
    if ((data.status || []).includes('OK')) return
    lastErr = `${(data.status || []).join(',') || res.status} — ${(data.statusDetail || []).join('; ') || raw.trim() || '(empty body)'}`
    if (i < ATTEMPTS) {
      console.log(`  chrome: publish not ready (${lastErr}); retrying in ${WAIT_MS / 1000}s [${i}/${ATTEMPTS - 1}]`)
      await new Promise((r) => setTimeout(r, WAIT_MS))
    }
  }
  throw new Error(`chrome publish failed after ${ATTEMPTS} attempts: ${lastErr}`)
}

async function doChrome(zipPath, creds, willPublish) {
  if (!existsSync(zipPath)) throw new Error(`missing ${zipPath} — build failed?`)
  if (!willPublish) {
    console.log(`  [dry-run] chrome: would refresh token, upload ${basename(zipPath)}, publish item ${CWS_ITEM_ID}`)
    return { status: 'dry-run' }
  }
  console.log('  chrome: refreshing access token…')
  const token = await refreshChromeAccessToken(creds)
  console.log(`  chrome: uploading ${basename(zipPath)}…`)
  await uploadChromeZip(token, zipPath)
  console.log('  chrome: publishing…')
  await publishChromeItem(token)
  return { status: 'published' }
}

// ── amo (firefox, listed channel) ───────────────────────────────────────────

function amoJwt(issuer, secret) {
  const b64u = (s) => Buffer.from(s).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = b64u(JSON.stringify({ iss: issuer, jti: `${now}-${Math.random()}`, iat: now, exp: now + 300 }))
  const sig = createHmac('sha256', secret).update(`${head}.${payload}`).digest('base64url')
  return `${head}.${payload}.${sig}`
}

// Retries 5xx and network errors; 4xx still fails fast. A fresh JWT is minted
// per attempt because AMO caps them at five minutes and the backoff can outlast
// that. Every caller below throws on !res.ok, so without this one 503 from a
// wobbling AMO ends the whole submission — which is exactly what happened on
// 2026-08-20.
async function amoRequest(method, url, creds, { body, headers } = {}) {
  return amoFetchWithRetry(
    () =>
      fetch(url, {
        method,
        headers: { Authorization: `JWT ${amoJwt(creds.AMO_JWT_ISSUER, creds.AMO_JWT_SECRET)}`, ...headers },
        body,
      }),
    { label: 'firefox', log: console.log },
  )
}

async function amoUploadZip(creds, zipPath) {
  const form = new FormData()
  form.append('channel', 'listed')
  form.append('upload', new Blob([readFileSync(zipPath)]), basename(zipPath))
  const res = await amoRequest('POST', 'https://addons.mozilla.org/api/v5/addons/upload/', creds, { body: form })
  const data = await res.json()
  if (!res.ok) throw new Error(`amo upload failed: ${res.status} ${JSON.stringify(data)}`)
  return data.uuid
}

async function amoPollUpload(creds, uuid) {
  const url = `https://addons.mozilla.org/api/v5/addons/upload/${uuid}/`
  const deadline = Date.now() + 10 * 60 * 1000
  for (;;) {
    const res = await amoRequest('GET', url, creds)
    const data = await res.json()
    if (!res.ok) throw new Error(`amo upload status check failed: ${res.status}`)
    if (data.processed) {
      if (!data.valid) {
        const msgs = (data.validation?.messages || []).map((m) => m.message).join('\n  ')
        throw new Error(`amo validation failed:\n  ${msgs || 'no messages returned'}`)
      }
      return
    }
    if (Date.now() > deadline) throw new Error('amo upload processing timed out after 10min')
    await new Promise((r) => setTimeout(r, 15_000))
  }
}

// version create takes JSON (upload uuid + localized release/approval notes).
// source can only be null in that JSON body — it's attached via a separate
// multipart PATCH to the created version. confirmed against:
// https://mozilla.github.io/addons-server/topics/api/addons.html
async function amoCreateVersion(creds, uuid, releaseNotes, approvalNotes) {
  const res = await amoRequest('POST', `https://addons.mozilla.org/api/v5/addons/addon/${AMO_SLUG}/versions/`, creds, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      upload: uuid,
      release_notes: { 'en-US': releaseNotes },
      approval_notes: approvalNotes,
    }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`amo create version failed: ${res.status} ${JSON.stringify(data)}`)
  return data
}

async function amoAttachSource(creds, versionId, sourceZipPath) {
  const form = new FormData()
  form.append('source', new Blob([readFileSync(sourceZipPath)]), basename(sourceZipPath))
  const res = await amoRequest(
    'PATCH',
    `https://addons.mozilla.org/api/v5/addons/addon/${AMO_SLUG}/versions/${versionId}/`,
    creds,
    { body: form },
  )
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(`amo attach source failed: ${res.status} ${JSON.stringify(data)}`)
  }
}

async function doFirefox(zipPath, sourceZipPath, creds, willPublish, ver) {
  if (!existsSync(zipPath)) throw new Error(`missing ${zipPath} — build failed?`)
  if (!existsSync(sourceZipPath)) throw new Error(`missing ${sourceZipPath} — build failed?`)
  if (!willPublish) {
    console.log(
      `  [dry-run] firefox: would upload ${basename(zipPath)} (channel=listed), poll validation, ` +
        `create a version on "${AMO_SLUG}", attach ${basename(sourceZipPath)} as source`,
    )
    return { status: 'dry-run' }
  }

  // Ask AMO whether it is up before pushing a 10MB zip at it. Their heartbeat
  // is the only probe that tracked the 2026-08-20 outage — the addon read API
  // and the upload endpoint both came back while validation was still down.
  if (!(await amoHealthy())) {
    throw new Error(
      'amo is not healthy (https://addons.mozilla.org/__heartbeat__ is not 200) — ' +
        'mozilla is having an outage, not us. re-run when it answers 200.',
    )
  }

  console.log(`  firefox: uploading ${basename(zipPath)} to amo (channel=listed)…`)
  const uuid = await amoUploadZip(creds, zipPath)
  console.log(`  firefox: polling validation (uuid=${uuid})…`)
  await amoPollUpload(creds, uuid)

  console.log('  firefox: validation passed, creating version…')
  const releaseNotes = composeReleaseNotes()
  const approvalNotes = composeApprovalNotes(ver)
  let versionData
  try {
    versionData = await amoCreateVersion(creds, uuid, releaseNotes, approvalNotes)
  } catch (e) {
    throw new Error(`amo version create failed: ${e.message}`)
  }

  console.log(`  firefox: version ${versionData.version} created (id=${versionData.id}), attaching source…`)
  try {
    await amoAttachSource(creds, versionData.id, sourceZipPath)
  } catch (e) {
    throw new Error(
      `amo version ${versionData.version} (id ${versionData.id}) created but source attach FAILED: ${e.message} — ` +
        `attach dist/${basename(sourceZipPath)} manually at https://addons.mozilla.org/developers/addon/${AMO_SLUG}/versions/`,
    )
  }

  return { status: 'submitted', versionId: versionData.id, versionNumber: versionData.version }
}

// ── summary ──────────────────────────────────────────────────────────────────

function printSummary(ver, results, willPublish) {
  console.log(`\n${'─'.repeat(48)}`)
  console.log(`heatsync v${ver} — ${willPublish ? 'LIVE release' : 'dry-run (no store calls made)'}`)
  const line = (label, r) => {
    if (!r) return console.log(`  ${label}: not attempted`)
    if (r.status === 'dry-run') return console.log(`  ${label}: dry-run — would publish`)
    if (r.status === 'published') return console.log(`  ${label}: published — pending review (hours-to-days)`)
    if (r.status === 'submitted') {
      return console.log(`  ${label}: submitted v${r.versionNumber} (id ${r.versionId}) — pending listed review (days)`)
    }
  }
  line('chrome ', results.chrome)
  line('firefox', results.firefox)
  if (!willPublish) console.log('\nnothing was uploaded — re-run with --publish for a real release')
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.setCreds) return setCredsFlow()
  if (opts.cwsAuth) return cwsAuthFlow()

  // Only demand the keys for the store(s) actually being published — a
  // chrome-only release must not block on absent AMO keys (and vice versa).
  const requiredKeys = opts.chromeOnly
    ? REQUIRED_KEYS.filter((k) => k.startsWith('CWS_'))
    : opts.firefoxOnly
      ? REQUIRED_KEYS.filter((k) => k.startsWith('AMO_'))
      : REQUIRED_KEYS
  const creds = loadCreds(requiredKeys)
  const willPublish = opts.publish && !opts.dryRun
  console.log(
    `mode: ${willPublish ? 'LIVE — will publish to stores' : 'dry-run — no store network calls'}` +
      (!opts.publish && !opts.dryRun ? ' (pass --publish for a real release)' : ''),
  )

  if (opts.version) bumpVersion(opts.version)

  const target = opts.chromeOnly ? 'chrome' : opts.firefoxOnly ? 'firefox' : null
  runBuild(target)
  verifyCheckVersions()

  const ver = getCurrentVersion()
  const zips = zipPaths(ver)
  const results = { chrome: null, firefox: null }

  try {
    if (!opts.firefoxOnly) results.chrome = await doChrome(zips.chrome, creds, willPublish)
    if (!opts.chromeOnly) results.firefox = await doFirefox(zips.firefox, zips.source, creds, willPublish, ver)
  } finally {
    printSummary(ver, results, willPublish)
  }
}

main().catch((e) => {
  console.error(`\nerror: ${e.message}`)
  process.exit(1)
})
