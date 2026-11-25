// microsoft edge add-ons, publish api v1.1 (api key + client id from partner center → microsoft
// edge → publish api). two steps, each an async operation polled to the end: the package goes
// into the product's draft, then the draft is submitted for review.
// https://learn.microsoft.com/microsoft-edge/extensions/update/api/addons-api-reference

import { amoFetchWithRetry } from './amo-retry.js'

export const EDGE_API = 'https://api.addons.microsoftedge.microsoft.com/v1'

// the store holds one submission in review at a time (chrome's ITEM_NOT_UPDATABLE): come back later
export const EDGE_LOCKED = 'InProgressSubmission'
// the draft already is what is live or in review: nothing new to submit
export const EDGE_SAME = 'NoModulesUpdated'

export class EdgeError extends Error {
  constructor(message, code) {
    super(message)
    this.code = code
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** the operation id a 202 hands back in Location: the bare id, or a url ending in it */
export function operationId(res) {
  const id = (res.headers.get('location') || '').split('/').filter(Boolean).pop()
  if (!id) throw new EdgeError(`edge: ${res.status} with no operation id in Location`)
  return id
}

export function edgeClient({
  productId,
  clientId,
  apiKey,
  fetchImpl = fetch,
  pollMs = 5_000,
  timeoutMs = 10 * 60_000,
  retry = {},
}) {
  const base = `${EDGE_API}/products/${productId}/submissions`
  const req = (method, url, body, type) => () =>
    fetchImpl(url, {
      method,
      headers: { Authorization: `ApiKey ${apiKey}`, 'X-ClientID': clientId, ...(type && { 'Content-Type': type }) },
      body,
    })
  // reads and the upload are safe to repeat; a submit is sent once (a repeat could queue a second review)
  const retried = (doFetch) => amoFetchWithRetry(doFetch, { label: 'edge', ...retry })

  async function refused(res, what) {
    if (res.status === 401) {
      return new EdgeError(
        'edge: the api key was refused (expired or replaced). make a new one at partner center → microsoft edge → ' +
          'publish api, then: bun scripts/publish.js --set-creds',
        'Unauthorized',
      )
    }
    return new EdgeError(`edge: ${what} answered ${res.status} — ${(await res.text()).trim() || '(empty body)'}`)
  }

  async function accepted(res, what) {
    if (res.status === 202) return operationId(res)
    throw await refused(res, what)
  }

  async function finish(url, what) {
    const end = Date.now() + timeoutMs
    for (;;) {
      const res = await retried(req('GET', url))
      if (!res.ok) throw await refused(res, `${what} status`)
      const op = await res.json()
      if (op.status === 'Succeeded') return op
      if (op.status !== 'InProgress') {
        const errs = (op.errors || []).map((e) => e?.message || String(e)).join('; ')
        throw new EdgeError(
          `edge: ${what} failed${op.errorCode ? ` (${op.errorCode})` : ''}: ${op.message || 'no message'}${errs ? ` — ${errs}` : ''}`,
          op.errorCode || undefined,
        )
      }
      if (Date.now() >= end) throw new EdgeError(`edge: ${what} still in progress after ${Math.round(timeoutMs / 60_000)} min`)
      await sleep(pollMs)
    }
  }

  return {
    /** the zip becomes the product's draft package */
    async upload(zip) {
      const id = await accepted(await retried(req('POST', `${base}/draft/package`, zip, 'application/zip')), 'upload')
      return finish(`${base}/draft/package/operations/${id}`, 'upload')
    },
    /** the draft goes to review; notes are the certification notes, plain text */
    async submit(notes) {
      const id = await accepted(await req('POST', base, notes, 'text/plain; charset=utf-8')(), 'submit')
      return finish(`${base}/operations/${id}`, 'submit')
    },
  }
}
