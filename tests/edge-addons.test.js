/**
 * The edge add-ons leg of a release: the package goes into the draft, the draft goes to review,
 * each an operation polled to its end. A fake api answers here; nothing leaves the box.
 */
import { describe, expect, test } from 'bun:test'
import { EDGE_API, EDGE_LOCKED, EdgeError, edgeClient, operationId } from '../scripts/lib/edge-addons.js'

const P = 'db3d12bb-778e-40b1-b112-8df75859a0b8'
const BASE = `${EDGE_API}/products/${P}/submissions`
const op = (status, extra = {}) => new Response(JSON.stringify({ id: 'x', status, ...extra }), { status: 200 })
const accepted = (loc) => new Response('', { status: 202, headers: { Location: loc } })

/** a fake api: answers from a script of [method, url, response] in order, records every call */
function fakeApi(script) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, ...init })
    const next = script.shift()
    if (!next) throw new Error(`unexpected call ${init.method} ${url}`)
    const [method, want, res] = next
    expect(init.method).toBe(method)
    expect(url).toBe(want)
    return typeof res === 'function' ? res() : res
  }
  return { calls, fetchImpl }
}

const client = (fetchImpl, extra = {}) =>
  edgeClient({
    productId: P,
    clientId: 'cid',
    apiKey: 'key',
    fetchImpl,
    pollMs: 1,
    retry: { baseDelayMs: 1, log: () => {} },
    ...extra,
  })

describe('edge add-ons', () => {
  test('upload: the zip goes to the draft with the api key headers, and the operation is polled to its end', async () => {
    const zip = new Uint8Array([80, 75, 3, 4])
    const api = fakeApi([
      ['POST', `${BASE}/draft/package`, accepted('op1')],
      ['GET', `${BASE}/draft/package/operations/op1`, op('InProgress')],
      ['GET', `${BASE}/draft/package/operations/op1`, op('Succeeded', { message: 'Successfully updated package' })],
    ])
    const done = await client(api.fetchImpl).upload(zip)
    expect(done.status).toBe('Succeeded')
    const post = api.calls[0]
    expect(post.headers).toEqual({
      Authorization: 'ApiKey key',
      'X-ClientID': 'cid',
      'Content-Type': 'application/zip',
    })
    expect(post.body).toBe(zip)
    expect(api.calls[1].headers).toEqual({ Authorization: 'ApiKey key', 'X-ClientID': 'cid' })
  })

  test('submit: the certification notes go as plain text', async () => {
    const api = fakeApi([
      ['POST', BASE, accepted('op2')],
      ['GET', `${BASE}/operations/op2`, op('Succeeded')],
    ])
    await client(api.fetchImpl).submit('heatsync v1.2.3')
    expect(api.calls[0].body).toBe('heatsync v1.2.3')
    expect(api.calls[0].headers['Content-Type']).toBe('text/plain; charset=utf-8')
  })

  test('a version still in review is its own code, so the retry can wait instead of crying failure', async () => {
    const api = fakeApi([
      ['POST', BASE, accepted('op3')],
      [
        'GET',
        `${BASE}/operations/op3`,
        op('Failed', {
          errorCode: EDGE_LOCKED,
          message: "Can't publish extension as your extension submission is in progress.",
        }),
      ],
    ])
    const err = await client(api.fetchImpl)
      .submit('n')
      .catch((e) => e)
    expect(err).toBeInstanceOf(EdgeError)
    expect(err.code).toBe('InProgressSubmission')
    // the retry script reads the code from publish.js's output
    expect(err.message).toContain('InProgressSubmission')
  })

  test('a refused key says where to make a new one', async () => {
    const api = fakeApi([['POST', `${BASE}/draft/package`, new Response('', { status: 401 })]])
    const err = await client(api.fetchImpl)
      .upload(new Uint8Array())
      .catch((e) => e)
    expect(err.code).toBe('Unauthorized')
    expect(err.message).toMatch(/publish api.*--set-creds/)
  })

  test('a submit is sent once: a 503 fails loud instead of queueing a second review', async () => {
    const api = fakeApi([['POST', BASE, new Response('busy', { status: 503 })]])
    const err = await client(api.fetchImpl)
      .submit('n')
      .catch((e) => e)
    expect(err.message).toContain('503')
    expect(api.calls).toHaveLength(1)
  })

  test('an upload survives a 503 (it only replaces the draft)', async () => {
    const api = fakeApi([
      ['POST', `${BASE}/draft/package`, new Response('', { status: 503 })],
      ['POST', `${BASE}/draft/package`, accepted('op4')],
      ['GET', `${BASE}/draft/package/operations/op4`, op('Succeeded')],
    ])
    expect((await client(api.fetchImpl).upload(new Uint8Array())).status).toBe('Succeeded')
  })

  test('an operation that never ends times out instead of hanging the release', async () => {
    const api = fakeApi([
      ['POST', `${BASE}/draft/package`, accepted('op5')],
      ...Array.from({ length: 50 }, () => ['GET', `${BASE}/draft/package/operations/op5`, () => op('InProgress')]),
    ])
    const err = await client(api.fetchImpl, { timeoutMs: 5 })
      .upload(new Uint8Array())
      .catch((e) => e)
    expect(err.message).toContain('still in progress')
  })

  test('the operation id is read from a bare id or a url ending in it', () => {
    expect(operationId(accepted('abc'))).toBe('abc')
    expect(operationId(accepted(`${BASE}/draft/package/operations/abc/`))).toBe('abc')
    expect(() => operationId(new Response('', { status: 202 }))).toThrow(/no operation id/)
  })
})
