// Bootstrap - lifecycle controller, cleanup utilities, debug log

const MC_DEBUG = false
function log(...args) {
  if (MC_DEBUG) console.log(LOG_PREFIX, ...args)
}

// Re-injection guard. background.js re-executes multichat.js on extension
// update/reload — without this, OLD + NEW both run: doubled observers, doubled
// IRC connections, doubled DOM nodes. Heavy CPU/memory load = Chrome crash.
try {
  if (typeof window.__heatsyncMcLifecycle?.abort === 'function') {
    window.__heatsyncMcLifecycle.abort()
  }
} catch (_) {}
// The previous sandbox may already be DEAD (firefox reinjects content scripts
// into open tabs on AMO auto-update): abort() above then throws on a dead
// object and the old cleanup listener never runs — but its _hsMc*/_hsEmote*
// install-once flags survive on the shared window (same-principal expandos
// outlive their sandbox), so this injection's gates would silently skip
// re-binding and leave zombie UI (dead composer, dead handlers). Sweep the
// flags unconditionally here; idempotent when the old abort DID run.
_hsSweepInstallOnceFlags()
function _hsSweepInstallOnceFlags() {
  for (const k of Object.keys(window)) {
    if (k.startsWith('_hsMc') || k.startsWith('_hsEmote')) {
      try {
        delete window[k]
      } catch (_) {}
    }
  }
}

// Lifecycle controller — abort() tears down ALL listeners, timers, observers
const lifecycle = new AbortController()
const mcSignal = lifecycle.signal
// `persistent` holds interval ids that must survive an SPA channel reinit
// (e.g. the module-load context-death detector below). fullSpaReinit() drains
// every other per-channel timer so they don't stack one set per navigation,
// but skips these. lifecycle.abort() (full teardown) still clears everything.
const _timers = { intervals: [], timeouts: [], observers: [], persistent: new Set() }
const _pendingRafs = new Set()
// Singleton DOM nodes appended to <body> (tooltips, toasts, overlays). On
// SPA reinit / pagehide, lifecycle.abort() removes them so they don't pile up
// across reload cycles.
const _trackedNodes = []
// Listeners on APIs that don't honor AbortSignal (chrome.runtime.onMessage,
// chrome.storage.onChanged). We track {target, fn} pairs and call removeListener
// on abort so reinit (SPA nav, hot-reload) doesn't leave stale handlers behind.
const _trackedListeners = []
mcSignal.addEventListener('abort', () => {
  _timers.intervals.forEach(clearInterval)
  _timers.timeouts.forEach(clearTimeout)
  _timers.observers.forEach((o) => {
    o.disconnect()
  })
  _pendingRafs.forEach(cancelAnimationFrame)
  _pendingRafs.clear()
  for (const { target, fn } of _trackedListeners) {
    try {
      target.removeListener(fn)
    } catch (_e) {}
  }
  _trackedListeners.length = 0
  for (const n of _trackedNodes) {
    try {
      n.remove()
    } catch (_e) {}
  }
  _trackedNodes.length = 0
  // typeof guards, not bare truth tests: teardown can fire BEFORE irc.js /
  // main.js evaluate (ctx-death watchdog aborts mid-bundle-eval on an
  // extension reload), and a bare `irc` read is a TDZ ReferenceError that
  // kills the rest of this function — leaving the auth-irc + whisper sockets
  // open, which is the exact leak the block below exists to prevent.
  try {
    if (typeof irc !== 'undefined' && irc) irc.destroy()
  } catch (_e) {}
  try {
    if (typeof kickChat !== 'undefined' && kickChat) kickChat.destroy()
  } catch (_e) {}
  cleanupAuthIrc(true)
  // Mirror auth-irc teardown for the EventSub whisper socket — without this its
  // WS stays open with a live reconnect timer after an extension reload, leaking
  // the whole prior IIFE per update cycle.
  try {
    eswCleanup(true)
  } catch {}
  // Wildcard reset of every _hsMc*/_hsEmote* install-once flag so reinit
  // (SPA nav, hot-reload) re-attaches handlers to the fresh IIFE state.
  // Without this, reinit gates re-bind on `!window._hsMcXxx` and silently
  // skips — old listeners stay attached and capture the now-dead old IIFE
  // closure, leaking it. Wildcard avoids the maintenance burden of listing
  // every flag (some are added in feature files I don't always edit here).
  // Same sweep also runs at module load for the dead-sandbox takeover case.
  _hsSweepInstallOnceFlags()
})
// Bug #4 (bfcache): only abort on REAL unloads. For bfcache-bound pagehide
// (ev.persisted) the page is frozen intact and may be restored — the
// AbortController is single-use, so aborting here would leave every
// { signal: mcSignal } listener permanently unattachable on restore and
// init() couldn't rewire the panel. Keeping the lifecycle alive means the
// restored page resumes with panel, observers and timers intact. If the
// page is instead evicted from bfcache, it's destroyed wholesale — nothing
// leaks. Non-persisted pagehide (real navigation/unload) aborts as before.
window.addEventListener('pagehide', (ev) => {
  if (!ev.persisted) lifecycle.abort()
})
// On bfcache restore, the panel survived the freeze but BG SW state may have
// moved (subs dropped, SW restarted) while we were suspended. Re-assert
// channel joins (idempotent server-side) + repaint — silent self-heal, no
// host-page reload. References main.js state: same bundled block scope,
// all defined long before a restore can fire.
window.addEventListener('pageshow', (ev) => {
  if (!ev.persisted) return
  try {
    if (typeof irc !== 'undefined' && irc?.channels) {
      for (const ch of irc.channels.keys()) {
        try {
          chrome.runtime.sendMessage({ type: 'bg_irc_join', channel: ch }).catch(() => {})
        } catch (_) {}
      }
    }
    if (typeof kickChat !== 'undefined' && kickChat?.channels) {
      for (const ch of kickChat.channels.keys()) {
        try {
          chrome.runtime
            .sendMessage({ type: 'ws_send', data: { type: 'channel:join', platform: 'kick', channel: ch } })
            .catch(() => {})
        } catch (_) {}
      }
    }
    if (typeof _dropAllTabCaches === 'function') _dropAllTabCaches()
    if (typeof renderMessages === 'function' && typeof currentTab !== 'undefined') renderMessages(currentTab)
  } catch (_) {}
})

// Export abort handle so a future re-injection of this script can tear us down.
// _hsMcTakenOver flips iff someone outside this closure called our abort —
// i.e. a NEW multichat.js instance took over. Internal aborts skip the flag.
let _hsMcTakenOver = false
window.__heatsyncMcLifecycle = {
  abort: () => {
    _hsMcTakenOver = true
    try {
      lifecycle.abort()
    } catch (_) {}
  },
  // Diagnostic probe — exposes IRC/Kick/YT chat state. Callable both from
  // isolated-world content scripts (via window.__heatsyncMcLifecycle.dbg())
  // AND from page MAIN world via a CustomEvent bridge:
  //   document.dispatchEvent(new CustomEvent('hs-dbg-probe'))
  //   then read document.documentElement.dataset.hsDbg
  // The MAIN-world dispatch is what makes this usable from devtools console
  // (which defaults to MAIN unless context is switched).
  dbg: () => _hsBuildDbg(),
}
function _hsBuildDbg() {
  const safeChans = (chat) => {
    if (!chat?.channels) return null
    const out = {}
    try {
      for (const [ch, buf] of chat.channels) {
        out[ch] = { count: buf?.getAll?.()?.length ?? 0 }
      }
    } catch (e) {
      return `err: ${e?.message}`
    }
    return out
  }
  const kickResolvedSample = (() => {
    try {
      if (typeof kickNameResolved === 'undefined') return 'no kickNameResolved'
      const entries = [...kickNameResolved.entries()].slice(0, 20)
      const hits = entries.filter(([, v]) => v != null).length
      return { size: kickNameResolved.size, hits, sample: entries.slice(0, 10) }
    } catch (e) {
      return `err: ${e?.message}`
    }
  })()
  const kickPending = (() => {
    try {
      if (typeof kickNameLookupPending === 'undefined') return 'no kickNameLookupPending'
      return { pending: kickNameLookupPending.size, sample: [...kickNameLookupPending].slice(0, 10) }
    } catch (e) {
      return `err: ${e?.message}`
    }
  })()
  return {
    irc: typeof irc !== 'undefined' ? safeChans(irc) : 'no irc',
    kick: typeof kickChat !== 'undefined' ? safeChans(kickChat) : 'no kickChat',
    currentTab: typeof currentTab !== 'undefined' ? currentTab : null,
    channels:
      typeof config !== 'undefined' && Array.isArray(config?.channels)
        ? config.channels.map((c) => ({ id: c.id, twitch: c.twitch, kick: c.kick, youtube: c.youtube }))
        : 'no config.channels',
    platformFilters: typeof platformFilters !== 'undefined' ? platformFilters : null,
    kickResolved: kickResolvedSample,
    kickPendingLookups: kickPending,
  }
}
// hs-dbg-* diagnostics — DEV BUILDS ONLY. These CustomEvent listeners are
// page-reachable (document.dispatchEvent crosses the isolated-world boundary)
// and expose privileged actions (real authenticated chat send via
// hs-dbg-test-send) plus private state (channel / mute / block lists, username,
// IRC state via documentElement.dataset). __HS_DEV_BUILD__ folds to false in
// every packaged/store build, so esbuild dead-code-eliminates this whole block —
// no listeners registered, zero attack surface for real users. The identifier is
// undefined in unpacked dev builds → the tools stay on for local debugging.
if (typeof __HS_DEV_BUILD__ !== 'undefined' ? __HS_DEV_BUILD__ : true) {
  // MAIN-world bridge: dispatchEvent('hs-dbg-probe') from page → content script
  // writes JSON snapshot to documentElement.dataset.hsDbg → MAIN reads.
  document.addEventListener(
    'hs-dbg-probe',
    () => {
      try {
        document.documentElement.dataset.hsDbg = JSON.stringify(_hsBuildDbg())
      } catch (e) {
        document.documentElement.dataset.hsDbg = `err:${e?.message || 'unknown'}`
      }
    },
    { capture: true, signal: mcSignal },
  )
  // hs-dbg-test-token → tests getTwitchAuthTokenAsync without exposing the
  // token value. Surfaces whether the BG cookie fetch is returning a token.
  // hs-dbg-test-send → invoke sendMessage() from isolated world with the test
  // text from event.detail.text. Times the call + reports whether IRC state
  // changed afterward. The event.detail.text is REAL text — caller is
  // responsible (only used by automation against safe channels).
  // hs-dbg-twitch-badges-lookup → resolve a specific (channel, name, version)
  // combo so we can see WHY a particular badge renders as text — is the URL
  // missing from the Map, or is renderBadges using a wrong key?
  document.addEventListener(
    'hs-dbg-twitch-badges-lookup',
    (e) => {
      try {
        const channel = e?.detail?.channel || 'nl_kripp'
        const name = e?.detail?.name || 'moderator'
        const version = e?.detail?.version || '1'
        const directChannel = twitchBadgeUrls.get(`${channel}:${name}/${version}`)
        let nearestVer = null
        let nearestUrl = null
        try {
          nearestVer = findNearestChannelBadgeVersion(channel, name, version)
          if (nearestVer) nearestUrl = twitchBadgeUrls.get(`${channel}:${name}/${nearestVer}`)
        } catch {}
        const globalExact = twitchBadgeUrls.get(`${name}/${version}`)
        const globalOne = twitchBadgeUrls.get(`${name}/1`)
        // Enumerate any keys containing the name
        const relatedKeys = [...twitchBadgeUrls.keys()].filter((k) => k.includes(name)).slice(0, 20)
        document.documentElement.dataset.hsDbgTwitchBadgesLookup = JSON.stringify({
          channel,
          name,
          version,
          directChannelHit: !!directChannel,
          nearestVer,
          nearestHit: !!nearestUrl,
          globalExactHit: !!globalExact,
          globalOneHit: !!globalOne,
          relatedKeys,
          mapTotal: twitchBadgeUrls.size,
        })
      } catch (err) {
        document.documentElement.dataset.hsDbgTwitchBadgesLookup = `err:${err?.message || 'unknown'}`
      }
    },
    { capture: true, signal: mcSignal },
  )
  // hs-dbg-twitch-badges → returns twitchBadgeUrls Map stats so we can see if
  // global + channel badges have populated. Helps diagnose "MOD/SUB as text"
  // regressions when running off-twitch.
  document.addEventListener(
    'hs-dbg-twitch-badges',
    () => {
      try {
        const urls = typeof twitchBadgeUrls !== 'undefined' ? [...twitchBadgeUrls.entries()] : null
        const fetched = typeof badgesFetchedChannels !== 'undefined' ? [...badgesFetchedChannels] : null
        const globalDone = typeof globalBadgesFetched !== 'undefined' ? globalBadgesFetched : null
        const sample = urls?.slice(0, 30).map(([k, v]) => [k, v?.slice(0, 50)])
        const modKeys = urls?.filter(([k]) => k.includes('moderator') || k.includes('broadcaster') || k.includes('vip'))
        document.documentElement.dataset.hsDbgTwitchBadges = JSON.stringify({
          total: urls?.length ?? null,
          globalDone,
          fetchedChannels: fetched,
          modVipBroadcasterKeys: modKeys?.length ?? null,
          sample,
        })
      } catch (e) {
        document.documentElement.dataset.hsDbgTwitchBadges = `err:${e?.message || 'unknown'}`
      }
    },
    { capture: true, signal: mcSignal },
  )
  // hs-dbg-test-irc-connect → invoke connectAuthIrc directly to test if the
  // IRC WebSocket can open from this origin. No PRIVMSG sent — just connect.
  document.addEventListener(
    'hs-dbg-test-irc-connect',
    () => {
      ;(async () => {
        try {
          const tokenFn = typeof getTwitchAuthTokenAsync === 'function' ? getTwitchAuthTokenAsync : null
          const connectFn = typeof connectAuthIrc === 'function' ? connectAuthIrc : null
          if (!tokenFn || !connectFn) {
            document.documentElement.dataset.hsDbgTestIrcConnect = JSON.stringify({ err: 'no fn(s)' })
            return
          }
          const t0 = Date.now()
          const { token, username } = await tokenFn()
          if (!token) {
            document.documentElement.dataset.hsDbgTestIrcConnect = JSON.stringify({ err: 'no token' })
            return
          }
          const nick = username || (typeof currentUsername !== 'undefined' ? currentUsername : null)
          if (!nick) {
            document.documentElement.dataset.hsDbgTestIrcConnect = JSON.stringify({ err: 'no nick' })
            return
          }
          const result = await Promise.race([
            connectFn(token, nick),
            new Promise((r) => setTimeout(() => r('timeout-5s'), 5000)),
          ])
          const wsState =
            typeof authState !== 'undefined' && authState?.ws
              ? ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][authState.ws.readyState]
              : 'no ws'
          document.documentElement.dataset.hsDbgTestIrcConnect = JSON.stringify({
            result: typeof result === 'boolean' ? result : String(result),
            ready: typeof authState !== 'undefined' ? !!authState.ready : null,
            wsState,
            elapsed: Date.now() - t0,
          })
        } catch (e) {
          document.documentElement.dataset.hsDbgTestIrcConnect = JSON.stringify({ err: e?.message })
        }
      })()
    },
    { capture: true, signal: mcSignal },
  )
  document.addEventListener(
    'hs-dbg-test-send',
    (e) => {
      document.documentElement.dataset.hsDbgTestSendStart = String(Date.now())
      ;(async () => {
        try {
          const input = document.getElementById('hs-mc-input')
          const text = String(e?.detail?.text || '')
          if (!input) {
            document.documentElement.dataset.hsDbgTestSend = JSON.stringify({ err: 'no input' })
            return
          }
          if (input.tagName === 'DIV') input.textContent = text
          else input.value = text
          const beforeReady = typeof authState !== 'undefined' ? !!authState.ready : null
          const t0 = Date.now()
          if (typeof sendMessage !== 'function') {
            document.documentElement.dataset.hsDbgTestSend = JSON.stringify({ err: 'no sendMessage fn' })
            return
          }
          try {
            sendMessage()
          } catch (sendErr) {
            document.documentElement.dataset.hsDbgTestSend = JSON.stringify({
              err: `sendMessage threw: ${sendErr?.message}`,
            })
            return
          }
          // Wait for async send pipeline
          await new Promise((r) => setTimeout(r, 2000))
          const afterReady = typeof authState !== 'undefined' ? !!authState.ready : null
          const wsState =
            typeof authState !== 'undefined' && authState?.ws
              ? ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][authState.ws.readyState]
              : 'no ws'
          const queueLen = typeof authState !== 'undefined' ? (authState.sendQueue?.length ?? null) : null
          document.documentElement.dataset.hsDbgTestSend = JSON.stringify({
            textLen: text.length,
            beforeReady,
            afterReady,
            wsState,
            queueLen,
            elapsed: Date.now() - t0,
            inputCleared: (input.tagName === 'DIV' ? input.textContent : input.value) === '',
          })
        } catch (err) {
          document.documentElement.dataset.hsDbgTestSend = JSON.stringify({ err: err?.message })
        }
      })()
    },
    { capture: true, signal: mcSignal },
  )
  // hs-dbg-kick-tap → round-trip to BG for pusher-tap/relay routing state
  // (subscribed chatrooms, per-slug delivery counters). Kick echo failures are
  // silent — this makes "which source delivered what" observable.
  document.addEventListener(
    'hs-dbg-kick-tap',
    () => {
      ;(async () => {
        try {
          const resp = await chrome.runtime.sendMessage({ type: 'dbg_kick_tap' })
          document.documentElement.dataset.hsDbgKickTap = JSON.stringify(resp)
        } catch (e) {
          document.documentElement.dataset.hsDbgKickTap = `err:${e?.message || 'unknown'}`
        }
      })()
    },
    { capture: true, signal: mcSignal },
  )
  document.addEventListener(
    'hs-dbg-test-token',
    () => {
      ;(async () => {
        try {
          const fn = typeof getTwitchAuthTokenAsync === 'function' ? getTwitchAuthTokenAsync : null
          if (!fn) {
            document.documentElement.dataset.hsDbgTestToken = JSON.stringify({ err: 'no fn' })
            return
          }
          const t0 = Date.now()
          // Race against 3s timeout so a hung await is observable
          const TIMEOUT = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 3s')), 3000))
          let result
          try {
            result = await Promise.race([fn(), TIMEOUT])
          } catch (raceErr) {
            document.documentElement.dataset.hsDbgTestToken = JSON.stringify({
              err: raceErr?.message || 'race-fail',
              elapsed: Date.now() - t0,
            })
            return
          }
          const elapsed = Date.now() - t0
          document.documentElement.dataset.hsDbgTestToken = JSON.stringify({
            hasToken: !!result?.token,
            tokenLen: result?.token ? result.token.length : 0,
            hasUsername: !!result?.username,
            elapsed,
          })
        } catch (e) {
          document.documentElement.dataset.hsDbgTestToken = JSON.stringify({ err: e?.message })
        }
      })()
    },
    { capture: true, signal: mcSignal },
  )
  // hs-dbg-auth-irc → returns Twitch IRC auth/WS state. Diagnoses cross-origin
  // send failures (kick.com viewer trying to send to a Twitch channel tab).
  document.addEventListener(
    'hs-dbg-auth-irc',
    () => {
      try {
        const wsState =
          typeof authState !== 'undefined' && authState?.ws
            ? ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][authState.ws.readyState]
            : 'no ws'
        const out = {
          hasAuthState: typeof authState !== 'undefined',
          ready: typeof authState !== 'undefined' ? !!authState.ready : null,
          wsState,
          joined: typeof authState !== 'undefined' ? [...(authState.joined || [])] : null,
          sendQueueLen: typeof authState !== 'undefined' ? (authState.sendQueue?.length ?? null) : null,
          currentUsername: typeof currentUsername !== 'undefined' ? currentUsername : null,
          hostPlatform: typeof hostPlatform !== 'undefined' ? hostPlatform : null,
        }
        document.documentElement.dataset.hsDbgAuthIrc = JSON.stringify(out)
      } catch (e) {
        document.documentElement.dataset.hsDbgAuthIrc = `err:${e?.message || 'unknown'}`
      }
    },
    { capture: true, signal: mcSignal },
  )
  // hs-dbg-kick-badge-urls → returns kickBadgeUrls Map state so we can verify
  // fetchKickChannelBadges populated entries for the current Kick channel(s).
  document.addEventListener(
    'hs-dbg-kick-badge-urls',
    () => {
      try {
        const urls = typeof kickBadgeUrls !== 'undefined' ? [...kickBadgeUrls.entries()] : null
        const fetched = typeof kickBadgesFetchedChannels !== 'undefined' ? [...kickBadgesFetchedChannels] : null
        const failed = typeof kickBadgesFailedAt !== 'undefined' ? [...kickBadgesFailedAt.entries()] : null
        const inflight = typeof kickBadgesInFlight !== 'undefined' ? [...kickBadgesInFlight] : null
        document.documentElement.dataset.hsDbgKickBadgeUrls = JSON.stringify({
          urlsCount: urls?.length ?? null,
          urlsSample: urls?.slice(0, 12),
          fetched,
          failed,
          inflight,
        })
      } catch (e) {
        document.documentElement.dataset.hsDbgKickBadgeUrls = `err:${e?.message || 'unknown'}`
      }
    },
    { capture: true, signal: mcSignal },
  )
  // hs-dbg-kick-badges → returns a sample of recent kick msgs with their .badges
  // string so we can see whether the WS payload actually carries badge types.
  document.addEventListener(
    'hs-dbg-kick-badges',
    () => {
      try {
        const out = []
        if (typeof kickChat !== 'undefined' && kickChat?.channels) {
          for (const [ch, buf] of kickChat.channels) {
            const all = buf?.getAll?.() || []
            for (const m of all.slice(-30)) {
              if (m?.badges && m.badges.length > 0) {
                out.push({ ch, u: m.user, badges: m.badges })
                if (out.length >= 12) break
              }
            }
            if (out.length >= 12) break
          }
        }
        document.documentElement.dataset.hsDbgKickBadges = JSON.stringify(out)
      } catch (e) {
        document.documentElement.dataset.hsDbgKickBadges = `err:${e?.message || 'unknown'}`
      }
    },
    { capture: true, signal: mcSignal },
  )
  // hs-dbg-alias-probe → returns getUserAliases() + mute/block state for a test
  // user. Lets MAIN-world verify the cross-platform alias resolution end-to-end.
  document.addEventListener(
    'hs-dbg-alias-probe',
    (e) => {
      try {
        const username = e?.detail?.username || ''
        const platform = e?.detail?.platform || null
        const aliases = typeof getUserAliases === 'function' ? getUserAliases(username, platform) : null
        const muted = typeof isUserMuted === 'function' ? isUserMuted(username, platform) : null
        const blocked = typeof isUserBlocked === 'function' ? isUserBlocked(username, platform) : null
        const mutedAll = typeof mutedUsers !== 'undefined' && mutedUsers instanceof Set ? [...mutedUsers] : null
        const blockedAll = typeof blockedUsers !== 'undefined' && blockedUsers instanceof Set ? [...blockedUsers] : null
        document.documentElement.dataset.hsDbgAlias = JSON.stringify({
          username,
          platform,
          aliases,
          muted,
          blocked,
          mutedCount: mutedAll?.length ?? null,
          blockedCount: blockedAll?.length ?? null,
          mutedAll: mutedAll?.slice(-20),
          blockedAll: blockedAll?.slice(-20),
        })
      } catch (err) {
        document.documentElement.dataset.hsDbgAlias = `err:${err?.message || 'unknown'}`
      }
    },
    { capture: true, signal: mcSignal },
  )
  document.addEventListener(
    'hs-dbg-render-trace',
    (e) => {
      try {
        const id = (e?.detail?.id || '').toLowerCase()
        const ch = typeof getChannelById === 'function' ? getChannelById(id) : null
        const tw = ch?.twitch
        const kk = ch?.kick
        const ircMsgs = tw && typeof irc !== 'undefined' ? irc?.getMessages(tw) || [] : []
        const kickMsgs = kk && typeof kickChat !== 'undefined' ? kickChat?.getMessages(kk) || [] : []
        const ytMsgs = typeof channelYtMessages !== 'undefined' ? channelYtMessages.get(id) || [] : []
        const filt = typeof getPlatformFilter === 'function' ? getPlatformFilter(id) : null
        const out = {
          id,
          ch_twitch: tw,
          ch_kick: kk,
          ircMsgs_len: ircMsgs.length,
          kickMsgs_len: kickMsgs.length,
          ytMsgs_len: ytMsgs.length,
          filt,
          ircTimes: ircMsgs.slice(-3).map((m) => ({ u: m.user, t: m.time, txt: (m.text || '').slice(0, 30) })),
          ytTimes: ytMsgs.slice(-3).map((m) => ({ u: m.user, t: m.time, txt: (m.text || '').slice(0, 30) })),
          ircHidden: ircMsgs.filter((m) => m?.hidden).length,
        }
        document.documentElement.dataset.hsDbg3 = JSON.stringify(out)
      } catch (err) {
        document.documentElement.dataset.hsDbg3 = `err:${err?.message || 'unknown'}`
      }
    },
    { capture: true, signal: mcSignal },
  )
  document.addEventListener(
    'hs-dbg-emotes',
    (e) => {
      try {
        const ch = (e?.detail?.ch || '').toLowerCase()
        const out = {
          globalCacheSize: typeof emoteCache !== 'undefined' ? emoteCache.size : -1,
          viewerPersonalSize: typeof viewerPersonalEmotes !== 'undefined' ? viewerPersonalEmotes.size : -1,
          channelKeys: typeof channelEmoteCaches !== 'undefined' ? Object.keys(channelEmoteCaches) : null,
          channelSizes: {},
          sampleNames: {},
        }
        if (typeof channelEmoteCaches !== 'undefined') {
          for (const [k, v] of Object.entries(channelEmoteCaches)) {
            out.channelSizes[k] = v?.size || 0
            if (k === ch) out.sampleNames[k] = [...v.keys()].slice(0, 12)
          }
        }
        out.emoteFirstLoad = typeof _emoteFirstLoad !== 'undefined' ? [..._emoteFirstLoad] : null
        out.dbgV = 3
        // renderProbe: run the probe name through the REAL chat render pipeline
        // and return the emitted html — proves what a live message would paint
        // without waiting for one to arrive.
        if (e?.detail?.renderProbe && typeof processEmotes === 'function') {
          out.renderHtml = processEmotes(
            String(e.detail.renderProbe),
            (e.detail.ch || '').toLowerCase(),
            null,
            null,
            Date.now(),
            true,
          )
        }
        // probe: resolve a single name through the real lookup chains — proves
        // the active tab actually sees a channel emote, not just that a pool
        // exists under some key.
        const probe = e?.detail?.probe
        if (probe && typeof lookupEmote === 'function') {
          out.probe = {
            name: probe,
            lookup: !!lookupEmote(probe),
            renderOrder: typeof lookupEmoteRenderOrder === 'function' ? !!lookupEmoteRenderOrder(probe) : null,
            pools: typeof activeTabEmotePools === 'function' ? activeTabEmotePools().map((m) => m.size) : null,
            // raw pool rows — which map has it, and with what state (the
            // autoAddInputEmotes global-state skip is invisible without this)
            cacheEntry: typeof emoteCache !== 'undefined' ? emoteCache.get(probe) || null : null,
            personalEntry: typeof viewerPersonalEmotes !== 'undefined' ? viewerPersonalEmotes.get(probe) || null : null,
            trackedForAutoAdd:
              typeof recentRemoteCompletions !== 'undefined' ? recentRemoteCompletions.has(probe) : null,
            inventoryHas: typeof inventoryEmotes !== 'undefined' ? inventoryEmotes.has(probe) : null,
          }
        }
        // async tail: raw storage row for the probed name — distinguishes
        // "BG persisted stale data" from "content ingestion dropped a field"
        if (probe && chrome?.storage?.local) {
          chrome.storage.local.get('global_emotes').then((st) => {
            out.storageRow = (st.global_emotes || []).find((e) => e.name === probe) || null
            document.documentElement.dataset.hsDbgEmotes = JSON.stringify(out)
          })
        }
        document.documentElement.dataset.hsDbgEmotes = JSON.stringify(out)
      } catch (err) {
        document.documentElement.dataset.hsDbgEmotes = `err:${err?.message || 'unknown'}`
      }
    },
    { capture: true, signal: mcSignal },
  )
  document.addEventListener(
    'hs-dbg-render-deep',
    (e) => {
      try {
        const id = (e?.detail?.id || '').toLowerCase()
        const ch = typeof getChannelById === 'function' ? getChannelById(id) : null
        const tw = ch?.twitch
        const kk = ch?.kick
        const ircMsgs = tw && typeof irc !== 'undefined' ? irc?.getMessages(tw) || [] : []
        const kickMsgs = kk && typeof kickChat !== 'undefined' ? kickChat?.getMessages(kk) || [] : []
        const ytMsgs = typeof channelYtMessages !== 'undefined' ? channelYtMessages.get(id) || [] : []
        const autoYt = typeof channelYtMessages !== 'undefined' ? channelYtMessages.get('__live_yt_auto__') || [] : []
        // per-channel tabs no longer merge __live_yt_auto__ (mirrors renderMessages — bleed fix)
        const ytAutoMerged = false
        const filt = typeof getPlatformFilter === 'function' ? getPlatformFilter(id) : null
        const fmInput = [filt?.twitch ? ircMsgs : [], filt?.kick ? kickMsgs : [], filt?.youtube ? ytMsgs : []]
        const merged = typeof fairMerge === 'function' ? fairMerge(fmInput) : []
        const out = {
          id,
          tw,
          kk,
          ircMsgs_len: ircMsgs.length,
          kickMsgs_len: kickMsgs.length,
          ytMsgs_len: ytMsgs.length,
          autoYt_len: autoYt.length,
          ytAutoMerged,
          filt,
          fmInputLens: fmInput.map((s) => s.length),
          merged_len: merged.length,
          mergedSampleTop: merged
            .slice(0, 3)
            .map((m) => ({ u: m.user, t: m.time, type: m.type, txt: (m.text || '').slice(0, 30) })),
          mergedSampleBottom: merged
            .slice(-3)
            .map((m) => ({ u: m.user, t: m.time, type: m.type, txt: (m.text || '').slice(0, 30) })),
          isMultiPlat: typeof isMultiPlatformTab === 'function' ? isMultiPlatformTab(id) : null,
          domRenderCap: typeof DOM_RENDER_CAP !== 'undefined' ? DOM_RENDER_CAP : null,
          currentTab: typeof currentTab !== 'undefined' ? currentTab : null,
          renderEpoch: typeof _renderEpoch !== 'undefined' ? _renderEpoch : null,
        }
        document.documentElement.dataset.hsDbgDeep = JSON.stringify(out)
      } catch (err) {
        document.documentElement.dataset.hsDbgDeep = `err:${err?.message || 'unknown'}`
      }
    },
    { capture: true, signal: mcSignal },
  )
  document.addEventListener(
    'hs-dbg-twitch-sample',
    (e) => {
      try {
        const ch = (e?.detail?.ch || '').toLowerCase()
        const buf = typeof irc !== 'undefined' ? irc?.channels?.get(ch) : null
        if (!buf) {
          document.documentElement.dataset.hsDbg2 = JSON.stringify({ err: 'no buf' })
          return
        }
        const all = buf.getAll()
        const times = all.map((m) => m.time || 0).filter((t) => t)
        const minT = times.length ? Math.min(...times) : 0
        const maxT = times.length ? Math.max(...times) : 0
        const sample = all.slice(-3).map((m) => ({
          user: m.user,
          time: m.time,
          text: m.text?.slice(0, 40),
          platform: m.platform,
          hidden: m.hidden,
          isHistory: m.isHistory,
          type: m.type,
        }))
        document.documentElement.dataset.hsDbg2 = JSON.stringify({
          total: all.length,
          noTime: all.length - times.length,
          minT,
          maxT,
          minISO: minT ? new Date(minT).toISOString() : null,
          maxISO: maxT ? new Date(maxT).toISOString() : null,
          sample,
        })
      } catch (err) {
        document.documentElement.dataset.hsDbg2 = `err:${err?.message || 'unknown'}`
      }
    },
    { capture: true, signal: mcSignal },
  )
}

// Fast context-death detector. chrome.runtime.id becomes undefined sync on
// extension reload. Tear down lifecycle immediately, then defer reload to
// visibility — active tab reloads in 1–5s, background tabs wait until user
// focuses them. Avoids the N-tab thundering React mount herd that crashes
// Chrome. content.js sets __heatsyncReloadScheduled — dedupe across scripts.
const _hsMcCtxDeathTimer = setInterval(() => {
  // Nothing to do while the tab is hidden: the reload is deferred to
  // visibilitychange anyway, so probing 30 times a minute in a background tab
  // buys nothing and just wakes it. The port detector below still fires
  // synchronously on invalidation regardless of visibility.
  if (document.hidden) return
  // chrome.runtime?.id access can throw "Extension context invalidated" on
  // orphaned content scripts — without try/catch the detector silently dies
  // each tick and reload never arms.
  let alive = false
  try {
    alive = !!chrome.runtime?.id
  } catch (_) {
    alive = false
  }
  if (alive) return
  clearInterval(_hsMcCtxDeathTimer)
  try {
    lifecycle.abort()
  } catch (_) {}
  if (window.__heatsyncReloadScheduled) return
  window.__heatsyncReloadScheduled = true
  const doReload = () => {
    if (_hsMcTakenOver) return
    try {
      location.reload()
    } catch (_) {}
  }
  if (document.visibilityState === 'visible') {
    setTimeout(doReload, 1000 + Math.random() * 4000)
  } else {
    document.addEventListener('visibilitychange', function once() {
      if (document.visibilityState !== 'visible') return
      document.removeEventListener('visibilitychange', once)
      setTimeout(doReload, 500 + Math.random() * 2000)
    })
  }
}, 2000)
_timers.intervals.push(_hsMcCtxDeathTimer)
// Registered once at module load, NOT inside init() — must outlive SPA reinit.
_timers.persistent.add(_hsMcCtxDeathTimer)

// Port-based ctx-death detector (mirrors content.js). chrome.runtime.connect()
// opens a long-lived port to BG; onDisconnect fires synchronously on ext
// invalidation, before chrome.runtime becomes undefined and before Chrome
// can suspend the orphaned setInterval. Catches the cases the 2s interval
// misses. Distinguishes "ext gone" from "SW idle-suspended" via the post-
// disconnect chrome.runtime?.id probe.
function _hsMcOpenCtxDeathPort() {
  let port
  try {
    if (!chrome?.runtime?.connect) return
    port = chrome.runtime.connect({ name: 'heatsync-ctx-death' })
  } catch (_) {
    return
  }
  port.onDisconnect.addListener(() => {
    let alive = false
    try {
      alive = !!chrome.runtime?.id
    } catch (_) {
      alive = false
    }
    if (alive) {
      setTimeout(_hsMcOpenCtxDeathPort, 500)
      return
    }
    try {
      lifecycle.abort()
    } catch (_) {}
    if (window.__heatsyncReloadScheduled) return
    window.__heatsyncReloadScheduled = true
    const doReload = () => {
      if (_hsMcTakenOver) return
      try {
        location.reload()
      } catch (_) {}
    }
    if (document.visibilityState === 'visible') {
      setTimeout(doReload, 1000 + Math.random() * 4000)
    } else {
      document.addEventListener('visibilitychange', function once() {
        if (document.visibilityState !== 'visible') return
        document.removeEventListener('visibilitychange', once)
        setTimeout(doReload, 500 + Math.random() * 2000)
      })
    }
  })
}
_hsMcOpenCtxDeathPort()

// Optional perf tracer. window.__hsPerfTrace = true at runtime to log
// callbacks exceeding 50ms into window.__hsPerfLog. Source captured at
// registration so anonymous arrows still get a stable identifier.
function _hsPerfWrap(fn, ms, kind) {
  let src = ''
  try {
    const stack = new Error().stack || ''
    const lines = stack.split('\n')
    for (const line of lines) {
      if (!line || line.includes('bootstrap.js') || line.includes('_hsPerfWrap')) continue
      src = line.trim().slice(0, 160)
      break
    }
  } catch {}
  return function (...args) {
    // localStorage gate so the tracer is togglable from the page world too —
    // the isolated world's window.__hsPerfTrace is unreachable from devtools'
    // default context and from automation.
    if (!window.__hsPerfTrace && !localStorage.getItem('hs_perf_trace')) return fn.apply(this, args)
    const t = performance.now()
    try {
      return fn.apply(this, args)
    } finally {
      const d = performance.now() - t
      if (d > 50) {
        ;(window.__hsPerfLog ||= []).push({ side: 'mc', kind, ms, dur: Math.round(d), at: Math.round(t), src })
        if (window.__hsPerfLog.length > 300) window.__hsPerfLog.shift()
        // Mirror into a DOM node — same reachability problem as the gate above.
        try {
          let n = document.getElementById('hs-perf-log')
          if (!n) {
            n = document.createElement('script')
            n.type = 'text/hs-perf-log'
            n.id = 'hs-perf-log'
            document.documentElement.appendChild(n)
          }
          n.textContent += `${JSON.stringify({ kind, dur: Math.round(d), at: Math.round(t), src })}\n`
          if (n.textContent.length > 40000) n.textContent = n.textContent.slice(-20000)
        } catch {}
      }
    }
  }
}

// hsSched — cooperative scheduler for boot-burst work in the multichat
// panel. Identical contract to content.js side: budget-yield chunking, pause
// while user is actively scrolling, scheduler.postTask priority. Keeps a
// 5-channel hydration from holding the main thread > ~4ms per slice.
const hsSched = (() => {
  let _scrollIdle = true
  let _scrollIdleTimer = null
  const markBusy = () => {
    _scrollIdle = false
    if (_scrollIdleTimer) clearTimeout(_scrollIdleTimer)
    _scrollIdleTimer = setTimeout(() => {
      _scrollIdle = true
      _scrollIdleTimer = null
    }, 180)
  }
  for (const ev of ['scroll', 'wheel', 'touchmove', 'pointerdown']) {
    try {
      window.addEventListener(ev, markBusy, { passive: true, capture: true, signal: mcSignal })
    } catch {}
  }
  const _yield = () => {
    if (typeof scheduler !== 'undefined' && typeof scheduler.yield === 'function') {
      return scheduler.yield()
    }
    return new Promise((r) => setTimeout(r, 0))
  }
  const untilIdle = async () => {
    let waited = 0
    while (!_scrollIdle && waited < 2000) {
      await new Promise((r) => setTimeout(r, 60))
      waited += 60
    }
  }
  const idle = (fn, { timeout = 2000, priority = 'background' } = {}) => {
    if (typeof scheduler !== 'undefined' && typeof scheduler.postTask === 'function') {
      return scheduler.postTask(fn, { priority })
    }
    if (typeof window.requestIdleCallback === 'function') {
      return new Promise((r) =>
        requestIdleCallback(
          () => {
            try {
              r(fn())
            } catch (_e) {
              r()
            }
          },
          { timeout },
        ),
      )
    }
    return new Promise((r) =>
      setTimeout(() => {
        try {
          r(fn())
        } catch (_e) {
          r()
        }
      }, 0),
    )
  }
  const chunk = async (items, fn, { budgetMs = 4, respectScroll = true } = {}) => {
    let t0 = performance.now()
    for (let i = 0; i < items.length; i++) {
      if (respectScroll && !_scrollIdle) await untilIdle()
      try {
        await fn(items[i], i)
      } catch (_e) {}
      if (performance.now() - t0 > budgetMs) {
        await _yield()
        t0 = performance.now()
      }
    }
  }
  return {
    yield: _yield,
    idle,
    chunk,
    untilIdle,
    get scrollIdle() {
      return _scrollIdle
    },
  }
})()

// NOTE: the name `cleanup` is load-bearing and INTENTIONALLY shadows
// src/lib/cleanup.js's `const cleanup = window.heatsyncCleanup` inside the
// multichat block (see build.js SCOPE_COLLISION_ALLOWLIST). The lib object has
// no addListener/setIntervalIfVisible/persistInterval — renaming this binding
// silently reroutes 15 multichat call sites to the lib object and throws
// "cleanup.addListener is not a function" at module load. Do not rename.
const cleanup = {
  setInterval(fn, ms) {
    const id = setInterval(_hsPerfWrap(fn, ms, 'interval'), ms)
    _timers.intervals.push(id)
    return id
  },
  setIntervalIfVisible(fn, ms) {
    const w = _hsPerfWrap(fn, ms, 'intervalIfVisible')
    const id = setInterval(() => {
      if (!document.hidden) w()
    }, ms)
    _timers.intervals.push(id)
    return id
  },
  clearInterval(id) {
    clearInterval(id)
    const i = _timers.intervals.indexOf(id)
    if (i !== -1) _timers.intervals.splice(i, 1)
  },
  // Mark a module-load interval as surviving SPA reinit's drain — init()
  // won't re-register it (see spa-nav.js).
  persistInterval(id) {
    _timers.persistent.add(id)
  },
  setTimeout(fn, ms) {
    const w = _hsPerfWrap(fn, ms, 'timeout')
    const id = setTimeout(() => {
      const idx = _timers.timeouts.indexOf(id)
      if (idx !== -1) _timers.timeouts.splice(idx, 1)
      w()
    }, ms)
    _timers.timeouts.push(id)
    return id
  },
  clearTimeout(id) {
    clearTimeout(id)
    const i = _timers.timeouts.indexOf(id)
    if (i !== -1) _timers.timeouts.splice(i, 1)
  },
  // `opts` is merged, with signal always forced to mcSignal so teardown can
  // never be opted out of. It used to be absent from the signature while
  // callers passed one anyway (paints.js hover passes { passive: true }), so
  // production silently dropped it — while the non-cleanup fallback branch in
  // those callers forwarded it to the real addEventListener. That split meant a
  // future { once: true } or { capture: true } would behave correctly under a
  // test harness and be ignored in the browser. Non-object args (emotes.js
  // passes a debug label) are ignored, as they always were.
  addEventListener(target, event, handler, opts) {
    const o = opts && typeof opts === 'object' ? { ...opts, signal: mcSignal } : { signal: mcSignal }
    target.addEventListener(event, _hsPerfWrap(handler, 0, `event:${event}`), o)
  },
  // For chrome.runtime.onMessage / chrome.storage.onChanged etc — APIs that
  // expose addListener/removeListener but ignore AbortSignal.
  addListener(target, fn) {
    if (!target?.addListener) return
    const w = _hsPerfWrap(fn, 0, 'listener')
    target.addListener(w)
    _trackedListeners.push({ target, fn: w })
  },
  trackObserver(obs) {
    _timers.observers.push(obs)
    return obs
  },
  untrackObserver(obs) {
    if (!obs) return
    try {
      obs.disconnect()
    } catch (_e) {}
    const i = _timers.observers.indexOf(obs)
    if (i !== -1) _timers.observers.splice(i, 1)
  },
  raf(fn) {
    let id
    const w = _hsPerfWrap(fn, 0, 'raf')
    id = requestAnimationFrame(() => {
      _pendingRafs.delete(id)
      w()
    })
    _pendingRafs.add(id)
    return id
  },
  cancelRaf(id) {
    cancelAnimationFrame(id)
    _pendingRafs.delete(id)
  },
  // Track a singleton body-level node (tooltip, toast, overlay) so that
  // lifecycle.abort() removes it. Returns the node for chaining:
  //   document.body.appendChild(cleanup.trackNode(el))
  trackNode(node) {
    if (!node) return node
    _trackedNodes.push(node)
    return node
  },
}
