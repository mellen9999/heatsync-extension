// a small in-memory IndexedDB for the service-worker harness: exactly what the worker's bgIdb* helpers
// (01-core.js) use. open / onupgradeneeded / createObjectStore, transaction -> objectStore, and
// put / get / delete / clear / openCursor (+ continue / delete). requests answer in microtasks and a
// transaction completes once its last request has answered, like the real thing. values are structured
// clones, so a test sees what really persisted. the data lives in `store` (owned by the harness), so a
// restarted worker (MV3 eviction) opens the same database.

export function createFakeIdb(store = { dbs: new Map() }) {
  const { dbs } = store

  function makeRequest(tx, run) {
    const req = { result: undefined, error: null, onsuccess: null, onerror: null }
    tx._pending++
    queueMicrotask(() => {
      try {
        req.result = run(req)
      } catch (e) {
        req.error = e
      }
      req.onsuccess?.({ target: req })
      tx._pending--
      tx._maybeDone()
    })
    return req
  }

  function makeStore(tx, data) {
    return {
      put: (value, key) => makeRequest(tx, () => void data.set(key, structuredClone(value)) ?? key),
      get: (key) => makeRequest(tx, () => (data.has(key) ? structuredClone(data.get(key)) : undefined)),
      delete: (key) => makeRequest(tx, () => void data.delete(key)),
      clear: () => makeRequest(tx, () => void data.clear()),
      openCursor() {
        const keys = [...data.keys()].sort()
        let i = 0
        const req = { result: null, onsuccess: null }
        const step = () => {
          tx._pending++
          queueMicrotask(() => {
            const key = keys[i++]
            req.result =
              key === undefined
                ? null
                : {
                    key,
                    get value() {
                      return structuredClone(data.get(key))
                    },
                    continue: step,
                    delete: () => void data.delete(key),
                  }
            req.onsuccess?.({ target: req })
            tx._pending--
            tx._maybeDone()
          })
        }
        step()
        return req
      },
    }
  }

  function makeTx(db, names) {
    const tx = {
      error: null,
      oncomplete: null,
      onerror: null,
      onabort: null,
      _pending: 0,
      _done: false,
      _maybeDone() {
        if (tx._pending > 0 || tx._done) return
        tx._done = true
        tx.oncomplete?.({ target: tx })
      },
      objectStore(name) {
        if (!names.includes(name) || !db._data.has(name)) throw new DOMException('no such store', 'NotFoundError')
        return makeStore(tx, db._data.get(name))
      },
    }
    // a transaction with no requests still completes
    queueMicrotask(() => queueMicrotask(() => tx._maybeDone()))
    return tx
  }

  const indexedDB = {
    open(name, version = 1) {
      const req = { result: null, error: null, onupgradeneeded: null, onsuccess: null, onerror: null }
      queueMicrotask(() => {
        let rec = dbs.get(name)
        const upgrade = !rec || rec.version < version
        if (!rec) rec = { version, data: new Map() }
        const db = {
          onclose: null,
          onversionchange: null,
          _data: rec.data,
          objectStoreNames: { contains: (n) => rec.data.has(n) },
          createObjectStore: (n) => {
            rec.data.set(n, new Map())
          },
          transaction: (names) => makeTx(db, [].concat(names)),
          close() {},
        }
        req.result = db
        if (upgrade) {
          rec.version = version
          dbs.set(name, rec)
          req.onupgradeneeded?.({ target: req })
        }
        req.onsuccess?.({ target: req })
      })
      return req
    },
  }
  return {
    indexedDB,
    store,
    /** what a store holds, as { key: value } */
    snapshot(dbName, storeName) {
      const m = dbs.get(dbName)?.data.get(storeName)
      return m ? Object.fromEntries([...m].map(([k, v]) => [k, structuredClone(v)])) : {}
    },
    /** put records straight into a store (creating it), as a past session would have left them */
    seed(dbName, storeName, records) {
      let rec = dbs.get(dbName)
      if (!rec) dbs.set(dbName, (rec = { version: 1, data: new Map() }))
      if (!rec.data.has(storeName)) rec.data.set(storeName, new Map())
      for (const [k, v] of Object.entries(records)) rec.data.get(storeName).set(k, structuredClone(v))
    },
  }
}
