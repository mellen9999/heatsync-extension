#!/usr/bin/env bun
// one-command release publisher — chrome web store, amo (firefox listed channel), edge add-ons.
//
// usage:
//   bun scripts/publish.js                          # dry-run, current version, all three stores
//   bun scripts/publish.js --version 1.7.24 --publish   # bump + build + publish all three
//   bun scripts/publish.js --chrome-only --publish
//   bun scripts/publish.js --firefox-only --publish
//   bun scripts/publish.js --edge-only --publish     # edge takes the chrome build as-is
//   bun scripts/publish.js --cws-auth                # one-time: mint a CWS_REFRESH_TOKEN
//   bun scripts/publish.js --sync-summaries --publish   # push _locales summaries to AMO only
//   bun scripts/publish.js --sync-previews <dir> --publish  # replace AMO screenshots with <dir>/*.png
//
// safe by default: without --publish, nothing is ever uploaded — every network
// call to a store api is skipped and logged instead. --dry-run forces that same
// no-network behavior even if --publish is also passed.
//
// credentials live in ~/.config/heatsync/publish.env (chmod 600, never in the
// repo). see docs/RELEASING.md for one-time setup.

import { execFileSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { amoFetchWithRetry, amoHealthy } from './lib/amo-retry.js'
import { EDGE_LOCKED, EDGE_SAME, edgeClient } from './lib/edge-addons.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(__dirname)

const CWS_ITEM_ID = 'afadollcanjpemaonbgnkhjddaebjeja'
const AMO_SLUG = 'heatsync-chat'
const EDGE_PRODUCT_ID = 'db3d12bb-778e-40b1-b112-8df75859a0b8'
const REQUIRED_KEYS = [
  'AMO_JWT_ISSUER',
  'AMO_JWT_SECRET',
  'CWS_CLIENT_ID',
  'CWS_CLIENT_SECRET',
  'CWS_REFRESH_TOKEN',
  'EDGE_CLIENT_ID',
  'EDGE_API_KEY',
]
const KEY_PREFIX = { chrome: 'CWS_', firefox: 'AMO_', edge: 'EDGE_' }
// a store still reviewing the last version takes no new one: the leg waits on the hourly retry
const STORE_LOCKED = { chrome: 'ITEM_NOT_UPDATABLE', edge: EDGE_LOCKED }

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
    edgeOnly: flags.has('--edge-only'),
    dryRun: flags.has('--dry-run'),
    publish: flags.has('--publish'),
    cwsAuth: flags.has('--cws-auth'),
    setCreds: flags.has('--set-creds'),
    syncSummaries: flags.has('--sync-summaries'),
    syncPreviews: value('sync-previews'),
  }
  const only = ['chrome', 'firefox', 'edge'].filter((s) => opts[`${s}Only`])
  if (only.length > 1) {
    console.error(`error: pick one of --chrome-only, --firefox-only, --edge-only (got ${only.join(' + ')})`)
    process.exit(1)
  }
  opts.only = only[0] || null
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
  EDGE_CLIENT_ID=...
  EDGE_API_KEY=...

1. amo (firefox) api keys
   https://addons.mozilla.org/en-US/developers/addon/api/key/
   generate credentials -> paste JWT issuer/secret into AMO_JWT_ISSUER / AMO_JWT_SECRET

2. chrome web store api
   a. Google Cloud Console -> project -> enable "Chrome Web Store API"
   b. APIs & Services -> Credentials -> Create Credentials -> OAuth client ID -> type "Web application"
      add http://127.0.0.1:8976 as an Authorized redirect URI
   c. paste Client ID / Client Secret into CWS_CLIENT_ID / CWS_CLIENT_SECRET
   d. bun scripts/publish.js --cws-auth
      (opens the consent flow, catches the redirect on 127.0.0.1:8976 — writes CWS_REFRESH_TOKEN for you, never printed)

3. edge add-ons api
   https://partner.microsoft.com/dashboard/microsoftedge/publishapi
   turn on the api (or "new api key") -> paste Client ID / the key into EDGE_CLIENT_ID / EDGE_API_KEY
   the key is shown once and expires: the page lists its expiry date

4. chmod 600 ${path}
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
  const keys = REQUIRED_KEYS.filter((k) => k !== 'CWS_REFRESH_TOKEN')
  console.log(`writing to ${path} (chmod 600). input is hidden; blank keeps the current value.\n`)
  for (const key of keys) {
    const have = existing[key] ? ' [set]' : ''
    const value = await promptSecret(`${key}${have}: `)
    if (value) writeCredValue(path, key, value)
  }
  const after = parseEnvFile(path) || {}
  const still = keys.filter((k) => !after[k])
  console.log(still.length ? `\nstill missing: ${still.join(', ')}` : `\nall ${keys.length} keys set.`)
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
    console.error('create a Google Cloud OAuth client (type "Web application", redirect URI http://127.0.0.1:8976) and add both keys first')
    console.error('see docs/RELEASING.md for the exact steps')
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
    // The tag for THIS release may already exist: the repo's own convention is
    // a `chore: release X` commit tagged and pushed BEFORE publishing, because
    // the approval notes tell a reviewer to `git checkout v<ver>`. A tag that
    // points at HEAD would make the range empty and ship the placeholder as the
    // public release notes, which is what happened on the first release that
    // followed that order.
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT }).toString().trim()
    const atHead = (tag) => {
      try {
        return execFileSync('git', ['rev-list', '-n', '1', tag], { cwd: ROOT }).toString().trim() === head
      } catch {
        return false
      }
    }
    const prevTag = tags.find((t) => !atHead(t))
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
    'reproducible build (needs zip and node on the path):',
    `  1. bun ${bunVersion} (https://bun.sh)`,
    `  2. unzip the attached heatsync-source-${ver}.zip into an empty folder and cd into it`,
    `     (or: git clone https://github.com/mellen9999/heatsync-extension.git && cd heatsync-extension && git checkout v${ver})`,
    '  3. bun install --frozen-lockfile',
    '  4. bun run build.js firefox --package',
    `output: dist/firefox/ (unpacked), dist/heatsync-firefox-${ver}.zip — same files, byte for byte, as the submitted build`,
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

// AMO's store-listing "summary" per locale is separate from the extension's
// own manifest description, set once by hand through AMO's dashboard and
// never touched again — a stale summary (old "unlimited emotes" pitch, wrong
// product name) can sit live for months after the real copy moved on. Source
// of truth for what the product actually says is src/_locales/*/messages.json
// manifest_description — push it with --sync-summaries after a release that
// changes the copy (not during one: it shares AMO's write throttle).
//
// Chrome's _locales directory names mostly match AMO's locale codes 1:1
// (ru, uk, ko, pl, fi, hu, sk, cs, el, he, …). The few that don't: Chrome
// spells regional variants with an underscore (pt_BR), AMO wants a hyphen
// (pt-BR); AMO's "default" locale is en-US, not bare en.
const AMO_LOCALE_OVERRIDES = {
  en: 'en-US',
  pt_BR: 'pt-BR',
  pt_PT: 'pt-PT',
  zh_CN: 'zh-CN',
  zh_TW: 'zh-TW',
  no: 'nb-NO',
  es: 'es-ES',
  sv: 'sv-SE',
}

function readLocaleSummaries() {
  const localesDir = join(ROOT, 'src', '_locales')
  const summaries = {}
  for (const dir of readdirSync(localesDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    const msgPath = join(localesDir, dir.name, 'messages.json')
    if (!existsSync(msgPath)) continue
    let messages
    try {
      messages = JSON.parse(readFileSync(msgPath, 'utf8'))
    } catch {
      continue
    }
    const desc = messages.manifest_description?.message
    if (!desc) continue
    const amoLocale = AMO_LOCALE_OVERRIDES[dir.name] || dir.name.replace('_', '-')
    summaries[amoLocale] = desc
  }
  return summaries
}

// summary/description are addon-level (not per-version) metadata — PATCH the
// addon resource directly. Deliberately non-fatal: a listing-copy hiccup
// must never block the actual version submission that follows it.
async function amoUpdateLocaleSummaries(creds) {
  const summaries = readLocaleSummaries()
  if (!Object.keys(summaries).length) {
    console.warn('  firefox: no locale summaries found under src/_locales — skipping AMO summary push')
    return
  }
  // AMO accepts only its own locale list, and answers a bad code with one 400
  // naming it ("The language code \"ar\" is invalid.") — the whole PATCH fails,
  // so one unsupported _locales dir used to leave every locale stale. Drop what
  // it names and retry; bounded by the locale count.
  const skipped = []
  try {
    for (let attempt = 0; attempt <= Object.keys(summaries).length; attempt++) {
      const res = await amoRequest('PATCH', `https://addons.mozilla.org/api/v5/addons/addon/${AMO_SLUG}/`, creds, {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ summary: summaries }),
      })
      if (res.ok) {
        const count = Object.keys(summaries).length
        console.log(
          `  firefox: synced ${count} locale summaries to AMO from src/_locales` +
            (skipped.length ? ` (amo has no locale for: ${skipped.join(', ')})` : ''),
        )
        return
      }
      const data = await res.json().catch(() => ({}))
      const bad = invalidAmoLocales(data).filter((code) => code in summaries)
      if (res.status !== 400 || !bad.length) throw new Error(`${res.status} ${JSON.stringify(data)}`)
      for (const code of bad) {
        delete summaries[code]
        skipped.push(code)
      }
    }
    throw new Error('gave up after dropping every rejected locale')
  } catch (e) {
    console.warn(`  firefox: AMO summary sync failed (non-fatal, listing copy may be stale): ${e.message}`)
  }
}

/** Locale codes AMO's 400 body calls invalid. */
function invalidAmoLocales(body) {
  const msgs = Array.isArray(body?.summary) ? body.summary : []
  const out = []
  for (const m of msgs) for (const hit of String(m).matchAll(/language code "([^"]+)" is invalid/g)) out.push(hit[1])
  return out
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

  // no summary sync here: AMO's write throttle (3/min, 10/hour per user) is
  // shared by addon PATCH and version create, and the summary sync's
  // drop-a-bad-locale retries burned it before the version could be created.
  // listing copy goes out on its own: publish.js --sync-summaries

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

// ── edge add-ons ─────────────────────────────────────────────────────────────

// notes for edge's reviewers (not public). edge takes the chrome build byte for byte
function composeEdgeNotes(ver) {
  return [
    `heatsync v${ver}: an update built from the same source as the chrome web store version.`,
    'no account is needed to test: open any live channel on twitch.tv or kick.com and the heatsync panel shows in the chat column.',
    `source: https://github.com/mellen9999/heatsync-extension/tree/v${ver}`,
    '',
    'changes:',
    composeReleaseNotes(),
  ]
    .join('\n')
    .slice(0, 2000)
}

async function doEdge(zipPath, creds, willPublish, ver) {
  if (!existsSync(zipPath)) throw new Error(`missing ${zipPath} — build failed?`)
  if (!willPublish) {
    console.log(`  [dry-run] edge: would upload ${basename(zipPath)} to product ${EDGE_PRODUCT_ID}, then submit it for review`)
    return { status: 'dry-run' }
  }
  const edge = edgeClient({ productId: EDGE_PRODUCT_ID, clientId: creds.EDGE_CLIENT_ID, apiKey: creds.EDGE_API_KEY })
  console.log(`  edge: uploading ${basename(zipPath)}…`)
  await edge.upload(readFileSync(zipPath))
  console.log('  edge: submitting for review…')
  try {
    await edge.submit(composeEdgeNotes(ver))
  } catch (e) {
    if (e.code !== EDGE_SAME) throw e
    // the draft already is the version in review or live: this leg's work is done
    return { status: 'same' }
  }
  return { status: 'published' }
}

// a locked store retries on its own: heatsync-store-retry@<store>.timer runs the leg hourly and
// switches itself off once the store takes it (scripts/store-retry-publish.sh). The version it
// retries is written down here: at arm time main may not hold the release commit yet
function armRetry(store, ver) {
  const timer = `heatsync-store-retry@${store}.timer`
  try {
    const state = join(homedir(), '.local', 'state', 'heatsync')
    mkdirSync(state, { recursive: true })
    writeFileSync(join(state, `store-retry-${store}.version`), `${ver}\n`)
    execFileSync('systemctl', ['--user', 'enable', '--now', timer], { stdio: 'ignore' })
    console.log(`  ${store}: still reviewing the last version — ${timer} retries hourly until it takes this one`)
  } catch {
    console.log(
      `  ${store}: still reviewing the last version. to retry hourly on its own:\n` +
        '    cp scripts/systemd/heatsync-store-retry@.* ~/.config/systemd/user/ && systemctl --user daemon-reload\n' +
        `    systemctl --user enable --now ${timer}`,
    )
  }
}

// ── summary ──────────────────────────────────────────────────────────────────

function printSummary(ver, results, willPublish) {
  console.log(`\n${'─'.repeat(48)}`)
  console.log(`heatsync v${ver} — ${willPublish ? 'LIVE release' : 'dry-run (no store calls made)'}`)
  const line = (label, r) => {
    if (!r) return console.log(`  ${label}: not attempted`)
    if (r.status === 'dry-run') return console.log(`  ${label}: dry-run — would publish`)
    if (r.status === 'published') return console.log(`  ${label}: published — pending review (hours-to-days)`)
    if (r.status === 'same') return console.log(`  ${label}: already holds this version — nothing new to submit`)
    if (r.status === 'failed') return console.log(`  ${label}: FAILED — ${r.error}`)
    if (r.status === 'submitted') {
      return console.log(`  ${label}: submitted v${r.versionNumber} (id ${r.versionId}) — pending listed review (days)`)
    }
  }
  line('chrome ', results.chrome)
  line('firefox', results.firefox)
  line('edge   ', results.edge)
  if (!willPublish) console.log('\nnothing was uploaded — re-run with --publish for a real release')
}

// Screenshots are addon-level too. Upload the new set first, then delete the
// old one, so a failure halfway leaves extra shots on the listing, never none.
// Files go up in name order (01-…, 02-…), which AMO keeps as display order.
function readPreviewFiles(dir) {
  if (!existsSync(dir)) throw new Error(`no such dir: ${dir}`)
  const files = readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.png'))
    .sort()
  if (!files.length) throw new Error(`no .png files in ${dir}`)
  return files.map((f) => join(dir, f))
}

async function amoReplacePreviews(creds, files) {
  const base = `https://addons.mozilla.org/api/v5/addons/addon/${AMO_SLUG}/`
  const current = await amoRequest('GET', base, creds)
  if (!current.ok) throw new Error(`firefox: read addon ${current.status}`)
  const oldIds = ((await current.json()).previews || []).map((p) => p.id)
  for (const [i, file] of files.entries()) {
    const form = new FormData()
    form.append('image', new Blob([readFileSync(file)], { type: 'image/png' }), basename(file))
    form.append('position', String(i))
    const res = await amoRequest('POST', `${base}previews/`, creds, { body: form })
    if (!res.ok) throw new Error(`firefox: upload ${basename(file)} ${res.status} ${await res.text()}`)
    console.log(`  firefox: uploaded ${basename(file)}`)
  }
  for (const id of oldIds) {
    const res = await amoRequest('DELETE', `${base}previews/${id}/`, creds)
    if (!res.ok) throw new Error(`firefox: delete old preview ${id} ${res.status}`)
  }
  console.log(`  firefox: listing now shows ${files.length} screenshots (${oldIds.length} old removed)`)
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.setCreds) return setCredsFlow()
  if (opts.cwsAuth) return cwsAuthFlow()
  // Listing copy only — no build, no version. Same safe-by-default rule as a
  // release: without --publish it only says what it would push.
  if (opts.syncSummaries) {
    if (!opts.publish || opts.dryRun) {
      console.log(`[dry-run] would sync ${Object.keys(readLocaleSummaries()).length} AMO locale summaries (pass --publish)`)
      return
    }
    return amoUpdateLocaleSummaries(loadCreds(REQUIRED_KEYS.filter((k) => k.startsWith('AMO_'))))
  }
  if (opts.syncPreviews) {
    const files = readPreviewFiles(opts.syncPreviews)
    if (!opts.publish || opts.dryRun) {
      console.log(`[dry-run] would replace AMO screenshots with: ${files.map((f) => basename(f)).join(', ')} (pass --publish)`)
      return
    }
    return amoReplacePreviews(loadCreds(REQUIRED_KEYS.filter((k) => k.startsWith('AMO_'))), files)
  }

  // Only demand the keys for the store(s) actually being published — a
  // chrome-only release must not block on absent AMO keys (and vice versa).
  const stores = opts.only ? [opts.only] : ['chrome', 'firefox', 'edge']
  const creds = loadCreds(REQUIRED_KEYS.filter((k) => stores.some((s) => k.startsWith(KEY_PREFIX[s]))))
  const willPublish = opts.publish && !opts.dryRun
  console.log(
    `mode: ${willPublish ? 'LIVE — will publish to stores' : 'dry-run — no store network calls'}` +
      (!opts.publish && !opts.dryRun ? ' (pass --publish for a real release)' : ''),
  )

  if (opts.version) bumpVersion(opts.version)

  // edge ships the chrome build; a firefox-only run builds only firefox
  runBuild(opts.only === 'firefox' ? 'firefox' : opts.only ? 'chrome' : null)
  verifyCheckVersions()

  const ver = getCurrentVersion()
  const zips = zipPaths(ver)
  const legs = {
    chrome: () => doChrome(zips.chrome, creds, willPublish),
    firefox: () => doFirefox(zips.firefox, zips.source, creds, willPublish, ver),
    edge: () => doEdge(zips.chrome, creds, willPublish, ver),
  }
  // each store on its own: one holding a review (or down) never keeps the others from this version
  const results = {}
  for (const store of stores) {
    try {
      results[store] = await legs[store]()
    } catch (e) {
      console.error(`  ${store}: ${e.message}`)
      results[store] = { status: 'failed', error: e.message.split('\n')[0] }
      if (willPublish && STORE_LOCKED[store] && e.message.includes(STORE_LOCKED[store])) armRetry(store, ver)
    }
  }
  printSummary(ver, results, willPublish)
  if (Object.values(results).some((r) => r.status === 'failed')) process.exitCode = 1
}

main().catch((e) => {
  console.error(`\nerror: ${e.message}`)
  process.exit(1)
})
