// fake `chrome` for the service-worker harness. the parts the worker leans on behave like
// the real ones: storage is async + JSON-cloned (a worker that mutates what it read does not
// change what is stored), onMessage follows chrome's response-channel rules, alarms and
// cookies fire their events. anything not listed here is undefined on purpose, so a worker
// that starts using a new chrome.* api fails with a plain "not a function" naming it.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** a chrome event: addListener / removeListener / hasListener, plus emit() for the harness */
function createEvent() {
  const listeners = []
  return {
    addListener: (fn) => {
      if (typeof fn === 'function' && !listeners.includes(fn)) listeners.push(fn)
    },
    removeListener: (fn) => {
      const i = listeners.indexOf(fn)
      if (i >= 0) listeners.splice(i, 1)
    },
    hasListener: (fn) => listeners.includes(fn),
    hasListeners: () => listeners.length > 0,
    /** harness side: forget every listener (sw.dispose) */
    clear: () => {
      listeners.length = 0
    },
    /** harness side: call every listener, return what they returned */
    emit(...args) {
      return [...listeners].map((fn) => {
        try {
          return fn(...args)
        } catch (e) {
          events.thrown.push(e)
          return undefined
        }
      })
    },
    get size() {
      return listeners.length
    },
  }
}
/** errors thrown synchronously out of event listeners (chrome logs them and moves on) */
const events = { thrown: [] }

// match patterns: <scheme>://<host>/<path> with * wildcards
function matchPattern(pattern, url) {
  if (pattern === '<all_urls>') return true
  const m = /^(\*|https?|wss?|ftp|file):\/\/([^/]*)(\/.*)$/.exec(pattern)
  if (!m) return false
  let u
  try {
    u = new URL(url)
  } catch {
    return false
  }
  const [, scheme, host, path] = m
  if (scheme === '*' ? !/^https?:$/.test(u.protocol) : `${scheme}:` !== u.protocol) return false
  if (host !== '*') {
    if (host.startsWith('*.')) {
      const base = host.slice(2)
      if (u.hostname !== base && !u.hostname.endsWith(`.${base}`)) return false
    } else if (u.hostname !== host) return false
  }
  const re = new RegExp(`^${path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)
  return re.test(u.pathname + u.search)
}

const cookieMatches = (c, url) => {
  const host = new URL(url).hostname
  const dom = String(c.domain || '').replace(/^\./, '')
  return host === dom || host.endsWith(`.${dom}`)
}

/**
 * @param {{ clock: ReturnType<import('./clock.js').createClock>, ctxJson: {parse: Function, stringify: Function}, extensionId: string }} deps
 *   ctxJson is the worker realm's own JSON, so what storage hands back is made of the worker's objects
 */
export function createFakeChrome({ clock, ctxJson, extensionId }) {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'src', 'manifests', 'chrome.json'), 'utf8'))
  const en = JSON.parse(readFileSync(join(ROOT, 'src', '_locales', 'en', 'messages.json'), 'utf8'))

  // ---- storage ----
  const cloneIn = (v) => ctxJson.parse(ctxJson.stringify(v === undefined ? null : v))
  function createArea(name) {
    const data = new Map() // key -> JSON string (what chrome actually keeps)
    const faults = [] // { op, error, when } each consumed once, by the next call that matches
    const onChanged = createEvent()
    const take = (op, arg) => {
      const i = faults.findIndex((f) => f.op === op && (!f.when || f.when(arg)))
      return i >= 0 ? faults.splice(i, 1)[0].error : null
    }
    const done = (cb, result) => {
      if (typeof cb === 'function') {
        Promise.resolve().then(() => cb(result))
        return undefined
      }
      return Promise.resolve().then(() => result)
    }
    const fail = (cb, error) => {
      if (typeof cb === 'function') {
        Promise.resolve().then(() => cb(undefined))
        return undefined
      }
      return Promise.reject(error)
    }
    const pick = (keys) => {
      const out = {}
      const read = (k, dflt) => {
        if (data.has(k)) out[k] = ctxJson.parse(data.get(k))
        else if (dflt !== undefined) out[k] = cloneIn(dflt)
      }
      if (keys == null) for (const k of data.keys()) read(k)
      else if (typeof keys === 'string') read(keys)
      else if (Array.isArray(keys)) for (const k of keys) read(k)
      else if (typeof keys === 'object') for (const [k, d] of Object.entries(keys)) read(k, d)
      return out
    }
    const notify = (changes) => {
      if (!Object.keys(changes).length) return
      Promise.resolve().then(() => onChanged.emit(changes, name))
    }
    return {
      onChanged,
      get: (keys, cb) => {
        clock.touch()
        const err = take('get', keys)
        if (err) return fail(cb, err)
        return done(cb, pick(keys))
      },
      set: (items, cb) => {
        clock.touch()
        const err = take('set', items)
        if (err) return fail(cb, err)
        const changes = {}
        for (const [k, v] of Object.entries(items || {})) {
          if (v === undefined) continue
          const oldValue = data.has(k) ? ctxJson.parse(data.get(k)) : undefined
          data.set(k, ctxJson.stringify(v))
          changes[k] = { newValue: ctxJson.parse(data.get(k)), ...(oldValue === undefined ? {} : { oldValue }) }
        }
        notify(changes)
        return done(cb, undefined)
      },
      remove: (keys, cb) => {
        clock.touch()
        const err = take('remove', keys)
        if (err) return fail(cb, err)
        const changes = {}
        for (const k of [].concat(keys)) {
          if (!data.has(k)) continue
          changes[k] = { oldValue: ctxJson.parse(data.get(k)) }
          data.delete(k)
        }
        notify(changes)
        return done(cb, undefined)
      },
      clear: (cb) => {
        clock.touch()
        const changes = {}
        for (const [k, v] of data) changes[k] = { oldValue: ctxJson.parse(v) }
        data.clear()
        notify(changes)
        return done(cb, undefined)
      },
      getBytesInUse: (keys, cb) => {
        const ks = keys == null ? [...data.keys()] : [].concat(keys)
        return done(
          cb,
          ks.reduce((n, k) => n + (data.has(k) ? k.length + data.get(k).length : 0), 0),
        )
      },
      setAccessLevel: (_o, cb) => done(cb, undefined),
      // harness side
      _data: data,
      _fail: (op, error, when) => faults.push({ op, error, when }),
      _snapshot: () => Object.fromEntries([...data].map(([k, v]) => [k, JSON.parse(v)])),
      _seed(obj) {
        for (const [k, v] of Object.entries(obj || {})) data.set(k, JSON.stringify(v))
      },
    }
  }
  const areas = { local: createArea('local'), session: createArea('session'), sync: createArea('sync') }
  const storage = { ...areas, onChanged: createEvent() }
  for (const [name, area] of Object.entries(areas)) {
    // the aggregate event is what `storage.onChanged` listeners (the worker has two) hear
    area.onChanged.addListener((changes) => storage.onChanged.emit(changes, name))
  }

  // ---- runtime.onMessage: chrome's response-channel rules ----
  const onMessage = createEvent()
  /**
   * deliver one message the way chrome does. the handle is live: `responded`/`response` fill in when a
   * listener calls sendResponse (first call wins). `claimed` = some listener kept the channel open
   * (returned true or a promise). not claimed + not answered = the channel closed with no reply;
   * claimed + never answered = chrome leaves the sender's promise pending forever.
   */
  function deliver(message, sender) {
    clock.touch()
    const handle = { claimed: false, responded: false, response: undefined }
    const respond = (response) => {
      if (handle.responded) return
      handle.responded = true
      // a reply crosses the message boundary as JSON, same as in chrome
      handle.response = response === undefined ? undefined : JSON.parse(ctxJson.stringify(response))
    }
    for (const out of onMessage.emit(cloneIn(message), cloneIn(sender), respond)) {
      if (out === true || (out && typeof out.then === 'function')) handle.claimed = true
    }
    return handle
  }

  const runtime = {
    id: extensionId,
    lastError: undefined,
    onMessage,
    onInstalled: createEvent(),
    onStartup: createEvent(),
    onConnect: createEvent(),
    onSuspend: createEvent(),
    getManifest: () => JSON.parse(JSON.stringify(manifest)),
    getURL: (path) => `chrome-extension://${extensionId}/${String(path).replace(/^\//, '')}`,
    reload: () => {
      runtime._reloads++
    },
    sendMessage: () => Promise.reject(new Error('Could not establish connection. Receiving end does not exist.')),
    _reloads: 0,
  }

  const i18n = {
    getMessage(key, subs) {
      const m = en[key]
      if (!m) return ''
      let text = m.message
      const list = subs == null ? [] : [].concat(subs)
      // chrome's $1 placeholders; the catalog's own named placeholders map to them
      for (const [pname, p] of Object.entries(m.placeholders || {})) {
        text = text.replace(new RegExp(`\\$${pname}\\$`, 'gi'), p.content)
      }
      return text.replace(/\$(\d)/g, (_, n) => list[Number(n) - 1] ?? '')
    },
    getUILanguage: () => 'en',
  }

  // ---- alarms (ride the virtual clock) ----
  const alarmTable = new Map() // name -> { name, scheduledTime, periodInMinutes?, timerId }
  const onAlarm = createEvent()
  function armAlarm(name, info) {
    clearAlarm(name)
    const now = clock.now()
    const whenMs = info.when != null ? info.when : now + (info.delayInMinutes ?? info.periodInMinutes ?? 0) * 60000
    const period = info.periodInMinutes ? info.periodInMinutes * 60000 : null
    const entry = { name, scheduledTime: whenMs, ...(period ? { periodInMinutes: info.periodInMinutes } : {}) }
    const fire = () => {
      const a = alarmTable.get(name)
      if (!a || a !== entry) return
      if (!period) alarmTable.delete(name)
      else entry.scheduledTime = clock.now() + period
      onAlarm.emit({
        name,
        scheduledTime: entry.scheduledTime,
        ...(period ? { periodInMinutes: info.periodInMinutes } : {}),
      })
    }
    // first fire at `when`, then every period — one timer per alarm
    entry.timerId = clock.schedule(fire, Math.max(0, whenMs - now), period)
    alarmTable.set(name, entry)
  }
  function clearAlarm(name) {
    const a = alarmTable.get(name)
    if (!a) return false
    clock.clear(a.timerId)
    alarmTable.delete(name)
    return true
  }
  const publicAlarm = (a) => ({
    name: a.name,
    scheduledTime: a.scheduledTime,
    ...(a.periodInMinutes ? { periodInMinutes: a.periodInMinutes } : {}),
  })
  const alarms = {
    onAlarm,
    create(nameOrInfo, maybeInfo) {
      const [name, info] = typeof nameOrInfo === 'string' ? [nameOrInfo, maybeInfo || {}] : ['', nameOrInfo || {}]
      armAlarm(name, info)
      return Promise.resolve()
    },
    get: (name = '') => Promise.resolve(alarmTable.has(name) ? publicAlarm(alarmTable.get(name)) : undefined),
    getAll: () => Promise.resolve([...alarmTable.values()].map(publicAlarm)),
    clear: (name = '') => Promise.resolve(clearAlarm(name)),
    clearAll: () => {
      for (const n of [...alarmTable.keys()]) clearAlarm(n)
      return Promise.resolve(true)
    },
  }

  // ---- tabs ----
  const tabTable = new Map()
  const tabMessages = [] // { tabId, message }
  const tabHandlers = new Map() // tabId -> fn(message) -> reply (a tab with no entry = no content script)
  const tabs = {
    onRemoved: createEvent(),
    onUpdated: createEvent(),
    onActivated: createEvent(),
    onCreated: createEvent(),
    query(q = {}) {
      clock.touch()
      const patterns = q.url == null ? null : [].concat(q.url)
      const out = [...tabTable.values()].filter(
        (t) =>
          (patterns == null || patterns.some((p) => matchPattern(p, t.url))) &&
          (q.active == null || !!t.active === q.active) &&
          (q.windowId == null || t.windowId === q.windowId),
      )
      return Promise.resolve(out.map((t) => ({ ...t })))
    },
    get(id) {
      const t = tabTable.get(id)
      return t ? Promise.resolve({ ...t }) : Promise.reject(new Error(`No tab with id: ${id}.`))
    },
    sendMessage(tabId, message) {
      clock.touch()
      if (!tabTable.has(tabId) || !tabHandlers.has(tabId)) {
        return Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'))
      }
      const sent = cloneIn(message)
      tabMessages.push({ tabId, message: sent })
      return Promise.resolve().then(() => tabHandlers.get(tabId)(sent))
    },
    update(id, props = {}) {
      const t = tabTable.get(id)
      if (!t) return Promise.reject(new Error(`No tab with id: ${id}.`))
      Object.assign(t, props)
      return Promise.resolve({ ...t })
    },
    create(props = {}) {
      const id = Math.max(0, ...tabTable.keys()) + 1
      const t = { id, url: props.url || 'about:blank', active: props.active !== false, windowId: props.windowId || 1 }
      tabTable.set(id, t)
      tabs.onCreated.emit({ ...t })
      return Promise.resolve({ ...t })
    },
    remove(ids) {
      for (const id of [].concat(ids)) harness.removeTab(id)
      return Promise.resolve()
    },
  }

  // ---- cookies ----
  const jar = []
  const cookies = {
    onChanged: createEvent(),
    get: ({ url, name }) =>
      Promise.resolve(jar.find((c) => c.name === name && cookieMatches(c, url)) || null).then((c) =>
        c ? { ...c } : null,
      ),
    getAll: ({ url, name } = {}) =>
      Promise.resolve(
        jar.filter((c) => (!name || c.name === name) && (!url || cookieMatches(c, url))).map((c) => ({ ...c })),
      ),
    set(details) {
      const host = new URL(details.url).hostname
      const c = {
        name: details.name,
        value: details.value ?? '',
        domain: details.domain || host,
        path: details.path || '/',
        secure: !!details.secure,
        httpOnly: !!details.httpOnly,
        session: details.expirationDate == null,
      }
      harness.setCookie(c)
      return Promise.resolve({ ...c })
    },
    remove({ url, name }) {
      const c = jar.find((x) => x.name === name && cookieMatches(x, url))
      if (c) harness.removeCookie(c.name, c.domain)
      return Promise.resolve(c ? { url, name } : null)
    },
  }

  // ---- the quiet ones: they accept calls and remember them ----
  const calls = { notifications: [], badge: [] }
  const notifications = {
    onClicked: createEvent(),
    onClosed: createEvent(),
    create: (id, opts) => {
      calls.notifications.push({ id, opts })
      return Promise.resolve(id)
    },
    clear: () => Promise.resolve(true),
  }
  const action = {
    setBadgeText: (o) => {
      calls.badge.push({ text: o?.text })
      return Promise.resolve()
    },
    setBadgeBackgroundColor: () => Promise.resolve(),
    setBadgeTextColor: () => Promise.resolve(),
    setIcon: () => Promise.resolve(),
    setTitle: () => Promise.resolve(),
  }
  const windows = { WINDOW_ID_NONE: -1, onFocusChanged: createEvent() }
  const permissions = { contains: () => Promise.resolve(true) }

  const chrome = { runtime, storage, i18n, alarms, tabs, cookies, notifications, action, windows, permissions }

  const harness = {
    chrome,
    areas,
    events,
    deliver,
    calls,
    tabMessages,
    /** a tab. `reply` stands in for its content script (omit = no content script, sends reject) */
    addTab({ id, url, active = false, windowId = 1, reply = () => undefined }) {
      const t = { id, url, active, windowId }
      tabTable.set(id, t)
      if (reply) tabHandlers.set(id, reply)
      tabs.onCreated.emit({ ...t })
      return t
    },
    removeTab(id) {
      tabTable.delete(id)
      tabHandlers.delete(id)
      tabs.onRemoved.emit(id, { windowId: 1, isWindowClosing: false })
    },
    navigateTab(id, url) {
      const t = tabTable.get(id)
      if (!t) throw new Error(`harness: no tab ${id}`)
      t.url = url
      tabs.onUpdated.emit(id, { status: 'loading', url }, { ...t })
      tabs.onUpdated.emit(id, { status: 'complete' }, { ...t })
    },
    setCookie(c) {
      const i = jar.findIndex((x) => x.name === c.name && x.domain === c.domain)
      if (i >= 0) jar.splice(i, 1)
      jar.push(c)
      cookies.onChanged.emit({ removed: false, cookie: { ...c }, cause: 'explicit' })
    },
    removeCookie(name, domain) {
      const i = jar.findIndex((x) => x.name === name && x.domain === domain)
      if (i < 0) return
      const [c] = jar.splice(i, 1)
      cookies.onChanged.emit({ removed: true, cookie: { ...c }, cause: 'explicit' })
    },
    seedCookie(c) {
      jar.push(c)
    },
    // what survives a worker restart (see sw.restart)
    cookieJar: () => jar.map((c) => ({ ...c })),
    tabList: () => [...tabTable.values()].map((t) => ({ ...t, reply: tabHandlers.get(t.id) ?? null })),
    alarmList: () => [...alarmTable.values()].map(publicAlarm),
    tabUrl: (id) => tabTable.get(id)?.url,
    alarmNames: () => [...alarmTable.keys()],
    alarm: (name) => (alarmTable.has(name) ? publicAlarm(alarmTable.get(name)) : null),
    armAlarm,
    /** release everything the worker registered (sw.dispose): listeners, alarms, tabs, replies */
    dispose() {
      const walk = (obj, depth) => {
        if (!obj || typeof obj !== 'object' || depth > 3) return
        for (const v of Object.values(obj)) {
          if (v && typeof v === 'object' && typeof v.clear === 'function' && typeof v.addListener === 'function')
            v.clear()
          else walk(v, depth + 1)
        }
      }
      walk(chrome, 0)
      alarmTable.clear()
      tabTable.clear()
      tabHandlers.clear()
      tabMessages.length = 0
      jar.length = 0
    },
  }
  return harness
}
