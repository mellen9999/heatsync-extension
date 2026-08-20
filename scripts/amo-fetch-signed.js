// fetch an already-signed unlisted xpi from AMO by version.
// fallback for release.yml when web-ext sign 409s ("version already exists")
// after its own submission created the version — the file signs server-side;
// we just have to wait for it and download.
//
// usage: bun scripts/amo-fetch-signed.js <version> <out-path>
// env:   AMO_JWT_ISSUER, AMO_JWT_SECRET
import { createHmac } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { amoFetchWithRetry } from './lib/amo-retry.js'

const GUID = 'heatsync@heatsync.org'
const [version, outPath] = process.argv.slice(2)
const issuer = process.env.AMO_JWT_ISSUER
const secret = process.env.AMO_JWT_SECRET
if (!version || !outPath || !issuer || !secret) {
  console.error('usage: amo-fetch-signed.js <version> <out> (needs AMO_JWT_ISSUER/AMO_JWT_SECRET)')
  process.exit(2)
}

const b64u = (s) => Buffer.from(s).toString('base64url')
function jwt() {
  // AMO requires short-lived HS256 tokens (<=5 min)
  const now = Math.floor(Date.now() / 1000)
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = b64u(
    JSON.stringify({ iss: issuer, jti: `${now}-${Math.random()}`, iat: now, exp: now + 300 }),
  )
  const sig = createHmac('sha256', secret).update(`${head}.${payload}`).digest('base64url')
  return `${head}.${payload}.${sig}`
}

// `notFoundOk` because the two 404s here mean opposite things: the version
// lookup 404s while AMO has not registered the submission yet (keep waiting,
// the deadline below decides when to give up), whereas a 404 on the signed
// file itself is a real error. A fresh JWT per attempt — AMO caps them at five
// minutes and the backoff can outlast that.
async function amoGet(url, { notFoundOk = false } = {}) {
  const res = await amoFetchWithRetry(() => fetch(url, { headers: { Authorization: `JWT ${jwt()}` } }), {
    label: 'amo',
    log: console.log,
  })
  if (res.status === 404 && notFoundOk) return null
  if (!res.ok) throw new Error(`${url} -> ${res.status}`)
  return res
}

const versionUrl = `https://addons.mozilla.org/api/v5/addons/addon/${encodeURIComponent(GUID)}/versions/${encodeURIComponent(version)}/`
const deadline = Date.now() + 15 * 60 * 1000
for (;;) {
  const res = await amoGet(versionUrl, { notFoundOk: true })
  const info = res ? await res.json() : null
  const file = info?.file
  if (file && file.status === 'public' && file.url) {
    const bin = await amoGet(file.url)
    writeFileSync(outPath, Buffer.from(await bin.arrayBuffer()))
    console.log(`signed xpi for ${version} -> ${outPath} (${file.hash || 'no hash'})`)
    process.exit(0)
  }
  const state = file ? file.status : info ? 'no file' : 'version not registered yet'
  if (Date.now() > deadline) {
    console.error(`timed out waiting for signed file (status: ${state})`)
    process.exit(1)
  }
  console.log(`file status: ${state} — waiting…`)
  await new Promise((r) => setTimeout(r, 30_000))
}
