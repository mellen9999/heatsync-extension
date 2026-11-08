// A small in-memory IndexedDB, just the slice the background's token key store
// uses: open → createObjectStore → transaction → objectStore get/put, with
// oncomplete after the last request. Values are held by reference, which is
// what a structured clone of a CryptoKey amounts to for a test (the handle
// stays the same non-extractable key).
//
// `fail: 'open'` makes every open() error, the way a blocked/private profile does.

export function fakeIndexedDB({ fail = null } = {}) {
  const dbs = new Map()
  const tick = (fn) => setTimeout(fn, 0)

  function makeRequest() {
    return { result: undefined, error: null, onsuccess: null, onerror: null }
  }

  function makeTx(stores) {
    const tx = { oncomplete: null, onerror: null, onabort: null, error: null }
    let pending = 0
    let done = false
    const settle = () =>
      tick(() => {
        if (done || pending > 0) return
        done = true
        tx.oncomplete?.()
      })
    tx.objectStore = (name) => {
      const store = stores.get(name)
      if (!store) throw new Error(`no such store ${name}`)
      const run = (work) => {
        const req = makeRequest()
        pending++
        tick(() => {
          req.result = work()
          pending--
          req.onsuccess?.()
          settle()
        })
        return req
      }
      return {
        get: (key) => run(() => store.get(key)),
        put: (value, key) =>
          run(() => {
            store.set(key, value)
            return key
          }),
      }
    }
    return tx
  }

  return {
    open(name) {
      const req = makeRequest()
      tick(() => {
        if (fail === 'open') {
          req.error = new Error('idb unavailable')
          req.onerror?.()
          return
        }
        let rec = dbs.get(name)
        const fresh = !rec
        if (!rec) {
          rec = { stores: new Map() }
          dbs.set(name, rec)
        }
        const db = {
          createObjectStore: (store) => rec.stores.set(store, new Map()),
          transaction: () => makeTx(rec.stores),
          close() {},
        }
        req.result = db
        if (fresh) req.onupgradeneeded?.()
        req.onsuccess?.()
      })
      return req
    },
    /** test peek: what the key store holds */
    _dump: () => new Map([...dbs].map(([n, r]) => [n, new Map([...r.stores].map(([s, m]) => [s, new Map(m)]))])),
    _wipe: () => dbs.clear(),
  }
}
