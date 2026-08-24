// @ts-check
// Error reporter — capture uncaught errors + unhandledrejection + console.error
// into a ring buffer in chrome.storage.local. Popup exposes "copy errors" so
// the user can paste a real repro context (stack + ver + platform + url) when
// reporting a bug, instead of trying to describe it from memory.
//
// Ring-buffer keyed `hs_errors`, cap 50. Writes debounced 500ms.
// Bundled into every content script; install-gated via window.__hsErrorReporter.
// Service worker has its own inline install in background.js (no window).

;(() => {
  if (typeof window === 'undefined' || window.__hsErrorReporter) return

  const MAX = 50
  const STORAGE_KEY = 'hs_errors'
  const MSG_CAP = 500
  const STACK_CAP = 2000
  const WRITE_DEBOUNCE_MS = 500

  let _ver = 'unknown'
  try {
    _ver = chrome?.runtime?.getManifest?.()?.version || _ver
  } catch (_) {}

  const _host = (typeof location !== 'undefined' && location.hostname) || ''
  const _plat = _host.includes('kick.com')
    ? 'kick'
    : _host.includes('youtube.com')
      ? 'yt'
      : _host.includes('twitch.tv')
        ? 'twitch'
        : 'other'

  let _reentry = false
  const _pending = []
  let _writeTimer = null

  function _truncate(s, n) {
    if (typeof s !== 'string') {
      try {
        s = String(s)
      } catch {
        return ''
      }
    }
    return s.length > n ? s.slice(0, n) : s
  }

  // Redact sensitive values from a URL's query string and hash fragment.
  // Keeps origin + path + non-sensitive params intact.
  const _SENSITIVE_PARAMS =
    /^(access_token|refresh_token|id_token|token|auth|authorization|key|apikey|api_key|password|passwd|secret|code|state|session|sig|signature)$/i
  function _scrubUrl(url) {
    if (typeof url !== 'string') return url
    try {
      // Handle both ? and # separators
      const qIdx = url.indexOf('?')
      const hIdx = url.indexOf('#')
      if (qIdx === -1 && hIdx === -1) return url
      const base = qIdx !== -1 ? url.slice(0, qIdx) : hIdx !== -1 ? url.slice(0, hIdx) : url
      const qPart = qIdx !== -1 ? url.slice(qIdx + 1, hIdx !== -1 ? hIdx : undefined) : ''
      const hPart = hIdx !== -1 ? url.slice(hIdx + 1) : ''
      function scrubPairs(str) {
        if (!str) return str
        return str.replace(/([^&=]+)=([^&]*)/g, (_, k, v) => {
          return _SENSITIVE_PARAMS.test(decodeURIComponent(k).trim()) ? `${k}=REDACTED` : `${k}=${v}`
        })
      }
      let result = base
      if (qPart) result += `?${scrubPairs(qPart)}`
      if (hPart) result += `#${scrubPairs(hPart)}`
      return result
    } catch (_) {
      return url
    }
  }

  // Redact token-like substrings from text (msg, stack).
  // Targets: Bearer tokens, oauth: prefixes, JWTs, long opaque secrets (24+ chars).
  // Normal prose and stack frame paths are NOT matched — they don't fit the patterns.
  //
  // Long-secret rule: require the run to start after = or whitespace (value context)
  // so chrome-extension:// IDs and /-delimited file paths are left intact.
  const _TEXT_SCRUB = [
    /Bearer\s+[\w.-]+/gi,
    /oauth:[\w.-]+/gi,
    /eyJ[\w-]+\.[\w-]+\.[\w-]+/g,
    /(?<=[=\s"':])[A-Za-z0-9_\-+/=]{24,}/g,
  ]
  function _scrubText(s) {
    if (typeof s !== 'string') return s
    for (const re of _TEXT_SCRUB) {
      s = s.replace(re, '[REDACTED]')
    }
    return s
  }

  function _fmtErr(e) {
    if (e == null) return { msg: '' }
    if (e instanceof Error || (typeof e === 'object' && e && 'stack' in e)) {
      let msg = ''
      let stack = ''
      try {
        msg = String(e.message || '')
      } catch (_) {}
      try {
        stack = String(e.stack || '')
      } catch (_) {}
      if (!msg) {
        try {
          msg = String(e)
        } catch (_) {
          msg = '[unreadable]'
        }
        if (msg === '[object Object]') msg = ''
      }
      return { msg: _truncate(_scrubText(msg), MSG_CAP), stack: _truncate(_scrubText(stack), STACK_CAP) }
    }
    if (typeof e === 'object') {
      try {
        const s = JSON.stringify(e)
        if (s && s !== '{}' && s !== '[]') return { msg: _truncate(_scrubText(s), MSG_CAP) }
      } catch (_) {}
      try {
        return { msg: _truncate(_scrubText(String(e)), MSG_CAP) }
      } catch {
        return { msg: '[unserializable]' }
      }
    }
    return { msg: _truncate(_scrubText(String(e)), MSG_CAP) }
  }

  // Synthesize a stack at the call-site so console-wrapped + reasonless rejection
  // entries still point somewhere useful. Two leading frames trimmed: this fn +
  // the caller wrapper.
  function _synthStack(skip) {
    try {
      const s = String(new Error().stack || '')
      const lines = s.split('\n')
      return lines.slice((skip || 0) + 1).join('\n')
    } catch (_) {
      return ''
    }
  }

  function _capture(rec) {
    if (_reentry) return
    // Drop entries with no useful payload — empty msg AND empty stack.
    // Keeps "Script error." cross-origin sanitization noise out of the buffer
    // and stops reasonless rejections from displacing real errors.
    if (!rec.msg && !rec.stack) return
    if (rec.msg === 'Script error.' && !rec.stack) return
    // Scrub any sensitive data that made it through — belt-and-suspenders so
    // direct capture() calls (e.g. from tests or external callers) are also clean.
    if (rec.url) rec = { ...rec, url: _scrubUrl(rec.url) }
    if (rec.msg) rec = { ...rec, msg: _scrubText(rec.msg) }
    if (rec.stack) rec = { ...rec, stack: _scrubText(rec.stack) }
    _reentry = true
    try {
      _pending.push(rec)
      if (_pending.length > MAX) _pending.splice(0, _pending.length - MAX)
      _scheduleWrite()
    } catch (_) {
    } finally {
      _reentry = false
    }
  }

  function _scheduleWrite() {
    if (_writeTimer) return
    _writeTimer = setTimeout(_flush, WRITE_DEBOUNCE_MS)
  }

  // Direct get→concat→set. Unserialized: two content scripts (or the SW) flushing
  // at once read the same base array and the last set() drops the other's batch.
  // Fallback only — see _flush.
  function _writeDirect(batch) {
    try {
      // `any`: @types/chrome dropped the callback overloads, but callback style
      // stays — it's the one form both chrome and firefox's chrome.* accept.
      const storage = /** @type {any} */ (chrome?.storage?.local)
      if (!storage) return
      storage.get(STORAGE_KEY, (cur) => {
        try {
          if (chrome?.runtime?.lastError) return
          const existing = Array.isArray(cur?.[STORAGE_KEY]) ? cur[STORAGE_KEY] : []
          const next = existing.concat(batch).slice(-MAX)
          storage.set({ [STORAGE_KEY]: next }, () => {
            void chrome?.runtime?.lastError
          })
        } catch (_) {}
      })
    } catch (_) {}
  }

  // Append via the service worker — it owns a serialized chain for this key, so
  // concurrent flushes from N tabs queue instead of clobbering each other.
  // Direct write only when messaging is unavailable (MAIN world, dead context,
  // SW unreachable): a raced append still beats a lost error report.
  function _flush() {
    _writeTimer = null
    if (_pending.length === 0) return
    const batch = _pending.splice(0, _pending.length)
    try {
      const p = chrome?.runtime?.id && chrome?.runtime?.sendMessage?.({ type: 'report_error', errors: batch })
      if (p && typeof p.then === 'function') {
        p.then((resp) => {
          if (resp?.ok !== true) _writeDirect(batch)
        }).catch(() => _writeDirect(batch))
        return
      }
    } catch (_) {}
    _writeDirect(batch)
  }

  // Host pages (Twitch/Kick/YouTube) throw their own errors constantly — keep them
  // out of the buffer unless the stack or filename traces back to extension code.
  function _isOurs(stack, file) {
    const s = `${stack || ''} ${file || ''}`
    return (
      s.includes('chrome-extension://') ||
      s.includes('moz-extension://') ||
      /\b(heatsync|content\.js|multichat\.js|heatsync-button\.js|autocomplete-hook\.js|chat-injector\.js)\b/.test(s)
    )
  }

  // Known-noise patterns that the browser raises regardless of our code,
  // OR transient API rejections that aren't actionable. Filter at capture
  // time so the buffer stays focused on real failures.
  function _isNoise(msg) {
    if (!msg) return false
    return (
      /^ResizeObserver loop/.test(msg) ||
      /Document is not focused/.test(msg) || // Clipboard API when window unfocused
      /signal is aborted/i.test(msg) || // AbortController teardown / our own fetch timeout (unanchored — our errors are prefixed "[heatsync] X failed: …")
      /context invalidated/i.test(msg) || // ext reload mid-call — incl. the lowercase JSON body {"error":"context invalidated"} from apiFetch/fetchFeed
      /Failed to fetch/.test(msg) || // MV3 SW torn down mid-fetch, or a transient network blip — never actionable
      /Feed fetch failed/.test(msg) || // downstream of the two above — same transient lifecycle causes
      /Could not establish connection.*Receiving end does not exist/.test(msg) || // cold SW wake — handled with retry
      /^Connection timeout$/.test(msg)
    ) // bg WS reconnect — scheduleReconnect handles recovery
  }

  // Context death recovery. When the extension reloads/updates, content scripts
  // in already-open tabs are orphaned. Firefox then throws cross-compartment
  // "Permission denied to access property 'then'" the moment any storage/api
  // promise is touched (the ~120 raw chrome.storage.*.get().then()/await sites);
  // chrome/firefox also surface "Extension context invalidated" / dead-object.
  // The runtime.sendMessage path already auto-reloads, but storage-only paths
  // never did, so they stayed broken until a manual reload. Catch the signature
  // here and fire the SAME deduped, visibility-aware reload — gated on the
  // context being provably dead so a page's own cross-compartment error can
  // never trigger a spurious reload.
  function _ctxDead() {
    try {
      return !chrome?.runtime?.id
    } catch (_) {
      return true
    }
  }
  function _isCtxDeathMsg(msg) {
    return /Extension context (was )?invalidated|Permission denied to access property|access dead object/i.test(
      msg || '',
    )
  }
  function _scheduleCtxReload() {
    try {
      if (typeof document === 'undefined' || window.__heatsyncReloadScheduled) return
      window.__heatsyncReloadScheduled = true
      const doReload = () => {
        try {
          location.reload()
        } catch (_) {}
      }
      if (document.visibilityState === 'visible') {
        setTimeout(doReload, 1000 + Math.random() * 4000)
      } else {
        // focus/pageshow escape hatches — popout windows can miss the
        // hidden→visible visibilitychange (see bootstrap.js ctx-death)
        const wake = () => {
          if (document.visibilityState !== 'visible' && !document.hasFocus()) return
          document.removeEventListener('visibilitychange', wake)
          window.removeEventListener('focus', wake)
          window.removeEventListener('pageshow', wake)
          setTimeout(doReload, 500 + Math.random() * 2000)
        }
        document.addEventListener('visibilitychange', wake)
        window.addEventListener('focus', wake)
        window.addEventListener('pageshow', wake)
      }
    } catch (_) {}
  }

  function _onError(e) {
    try {
      const f = _fmtErr(e.error != null ? e.error : e.message)
      if (_isCtxDeathMsg(f.msg) && _ctxDead()) {
        _scheduleCtxReload()
        return
      }
      if (_isNoise(f.msg)) return
      if (!_isOurs(f.stack, e.filename)) return
      _capture({
        ts: Date.now(),
        type: 'error',
        plat: _plat,
        ver: _ver,
        url: _truncate(_scrubUrl(location.href), 200),
        msg: f.msg,
        stack: f.stack,
        file: _truncate(e.filename || '', 200),
        line: e.lineno || 0,
      })
    } catch (_) {}
  }

  function _onRejection(e) {
    try {
      const f = _fmtErr(e.reason)
      if (_isCtxDeathMsg(f.msg) && _ctxDead()) {
        _scheduleCtxReload()
        return
      }
      const stack = f.stack || _synthStack(2)
      if (_isNoise(f.msg)) return
      if (!_isOurs(stack, '')) return
      _capture({
        ts: Date.now(),
        type: 'rejection',
        plat: _plat,
        ver: _ver,
        url: _truncate(_scrubUrl(location.href), 200),
        msg: f.msg || '(promise rejection with no reason)',
        stack,
      })
    } catch (_) {}
  }

  try {
    window.addEventListener('error', _onError, true)
  } catch (_) {}
  try {
    window.addEventListener('unhandledrejection', _onRejection, true)
  } catch (_) {}

  // Wrap console.error so explicit error logs land in the buffer too.
  // Skip console.warn/log — far too noisy. Pass-through to native so devtools
  // output is unchanged.
  try {
    const origErr = /** @type {any} */ (console.error) // property __hsWrapped added at runtime
    if (origErr && !origErr.__hsWrapped) {
      const wrapped = function (...args) {
        try {
          let derivedStack = ''
          const parts = args.map((a) => {
            if (a instanceof Error || (typeof a === 'object' && a && 'stack' in a)) {
              if (!derivedStack && a.stack) {
                try {
                  derivedStack = String(a.stack)
                } catch (_) {}
              }
              try {
                return String(a.message || a)
              } catch (_) {
                return '[unreadable]'
              }
            }
            if (typeof a === 'string') return a
            try {
              const s = JSON.stringify(a)
              return s && s !== '{}' ? s : String(a)
            } catch {
              return String(a)
            }
          })
          const msg = parts.filter((p) => p && p !== '[object Object]').join(' ')
          // Apply the same noise filter the window error/rejection handlers use —
          // console.error was bypassing it, so transient lifecycle spam (context
          // invalidated, Failed to fetch, aborted) was still filling the buffer.
          // Still prints to devtools; just not reported.
          if (_isNoise(msg)) return origErr.apply(this, args)
          if (!derivedStack) derivedStack = _synthStack(2)
          _capture({
            ts: Date.now(),
            type: 'console',
            plat: _plat,
            ver: _ver,
            url: _truncate(_scrubUrl(location.href), 200),
            msg: _truncate(_scrubText(msg), MSG_CAP),
            stack: _truncate(_scrubText(derivedStack), STACK_CAP),
          })
        } catch (_) {}
        return origErr.apply(this, args)
      }
      wrapped.__hsWrapped = true
      console.error = wrapped
    }
  } catch (_) {}

  window.__hsErrorReporter = {
    capture: _capture,
    flush: _flush,
    ver: _ver,
    plat: _plat,
  }
})()
