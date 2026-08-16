// Runs in MAIN world at document_start BEFORE Twitch's JS
// Intercepts image src/srcset setters to fix heatsync emote URLs
;(() => {
  // Re-entry guard: if script already ran, remove old listeners before re-registering
  if (window.__heatsyncEarlyInject) {
    const prev = window.__heatsyncEarlyInject
    if (prev.removeListeners) prev.removeListeners()
  }
  window.__heatsyncEarlyInject = {}

  const DEBUG = false
  const log = DEBUG ? console.log.bind(console, '[heatsync-early]') : () => {}

  // Firefox marks some globals (WebSocket, fetch, Image) as read-only
  function safeOverride(obj, prop, value) {
    try {
      obj[prop] = value
    } catch {
      Object.defineProperty(obj, prop, { value, writable: true, configurable: true })
    }
  }

  // Store for emote URL mappings (populated by content script)
  window.__heatsyncEmoteUrls = window.__heatsyncEmoteUrls || {}

  // ═══ Hermes Event Bus Interception ═══
  // Twitch's internal real-time event bus (replaced PubSub Apr 2025).
  // Passively read notifications from topics Twitch already subscribes to.
  // Capture the TRUE native WebSocket ONCE and stash it on a stable global. On a
  // re-inject (extension reload with no page nav) window.WebSocket is already our
  // wrapper from the prior run, so reading it here would wrap-the-wrapper — each
  // reload then added another handleHermesMessage listener per hermes socket →
  // duplicate raid/pin/redeem events and overlay churn. Reusing the persisted
  // native keeps it a single wrap no matter how many times we re-inject.
  if (!window.__hsNativeWebSocket) window.__hsNativeWebSocket = window.WebSocket
  const OrigWebSocket = window.__hsNativeWebSocket
  const channelIdToLogin = {}
  function setChannelId(id, login) {
    if (Object.keys(channelIdToLogin).length >= 200) {
      delete channelIdToLogin[Object.keys(channelIdToLogin)[0]]
    }
    channelIdToLogin[id] = login
    // Stamp dataset for ISOLATED-world content script to read synchronously when
    // the captured login matches the current URL channel.
    try {
      const slug = location.pathname.match(/^\/([^/]+)/)?.[1]?.toLowerCase()
      if (slug && login === slug && id) {
        document.documentElement.dataset.hsTwitchChannelId = String(id)
        document.documentElement.dataset.hsTwitchChannelLogin = login
        // Also broadcast — content.js can react instantly without polling.
        // Include nonce (set by content.js initMainWorldNonce and stored in _hsNonce)
        // so content.js can verify this came from our MAIN-world script and not
        // a rogue page script forging the same message type.
        window.postMessage(
          { type: 'heatsync-page-channel-id', channelId: String(id), login, nonce: _hsNonce },
          location.origin,
        )
      }
    } catch {}
  }

  function handleHermesMessage(e) {
    try {
      const msg = typeof e.data === 'string' ? JSON.parse(e.data) : e.data
      if (msg.type !== 'notification' || !msg.notification?.pubsub) return
      const pubsub =
        typeof msg.notification.pubsub === 'string' ? JSON.parse(msg.notification.pubsub) : msg.notification.pubsub
      const evtType = pubsub.type
      if (!evtType) return

      // Channel login from pubsub data or channelIdToLogin map
      const resolveChannel = (id) => channelIdToLogin[id] || location.pathname.split('/')[1]?.toLowerCase() || id

      if (evtType === 'raid_update_v5' && pubsub.raid) {
        const r = pubsub.raid
        window.postMessage(
          {
            type: 'heatsync-hermes-event',
            eventType: 'raid',
            channel: resolveChannel(r.source_id),
            data: {
              target: r.target_login || r.target_display_name || 'unknown',
              viewers: r.viewer_count || 0,
            },
          },
          location.origin,
        )
      } else if (evtType === 'hype-train-start' && pubsub.data) {
        const d = pubsub.data
        window.postMessage(
          {
            type: 'heatsync-hermes-event',
            eventType: 'hype-train-start',
            channel: resolveChannel(d.channel_id),
            data: {
              level: d.progress?.level?.value || 1,
            },
          },
          location.origin,
        )
      } else if (evtType === 'hype-train-progression' && pubsub.data) {
        // Skip progressions — too spammy, only show start/end
      } else if (evtType === 'hype-train-end' && pubsub.data) {
        const d = pubsub.data
        window.postMessage(
          {
            type: 'heatsync-hermes-event',
            eventType: 'hype-train-end',
            channel: resolveChannel(d.channel_id),
            data: {
              level: d.progress?.level?.value || 1,
            },
          },
          location.origin,
        )
      } else if (evtType === 'reward-redeemed' && pubsub.data?.redemption) {
        const r = pubsub.data.redemption
        window.postMessage(
          {
            type: 'heatsync-hermes-event',
            eventType: 'redeem',
            channel: resolveChannel(r.channel_id),
            data: {
              user: r.user?.display_name || r.user?.login || 'unknown',
              title: r.reward?.title || 'reward',
              cost: r.reward?.cost || 0,
              rewardId: r.reward?.id || '',
            },
          },
          location.origin,
        )
      }
      // Pinned messages
      else if ((evtType === 'pin-message' || evtType === 'pinned-chat') && pubsub.data) {
        const d = pubsub.data
        const text = d.message?.message?.text || d.message?.text || d.text || ''
        const sender = d.message?.sender?.displayName || d.message?.sender?.login || d.pinned_by?.display_name || ''
        if (text) {
          window.postMessage(
            {
              type: 'heatsync-hermes-event',
              eventType: 'pin',
              channel: resolveChannel(d.channel_id || ''),
              data: {
                message: text,
                sender,
                id: d.id || d.message?.id || '',
              },
            },
            location.origin,
          )
        }
      } else if (evtType === 'unpin-message' || evtType === 'unpinned-chat') {
        window.postMessage(
          {
            type: 'heatsync-hermes-event',
            eventType: 'unpin',
            channel: resolveChannel(pubsub.data?.channel_id || ''),
            data: {},
          },
          location.origin,
        )
      }
      // Sub gifts — exact payload TBD, add when discovered
    } catch (err) {
      log('Hermes parse error:', err)
    }
  }

  // MUST be a real function, not an arrow: page code calls `new WebSocket(...)`,
  // and arrow functions throw "not a constructor". A constructor that returns an
  // object yields that object from `new`, so we hand back the real OrigWebSocket
  // (instanceof still holds — HsWebSocket.prototype === OrigWebSocket.prototype
  // below). As an arrow this broke EVERY `new WebSocket()` on the page — killing
  // Twitch's own chat (Hermes auth timeout) and all live chat.
  function HsWebSocket(url, protocols) {
    const ws = protocols !== undefined ? new OrigWebSocket(url, protocols) : new OrigWebSocket(url)
    if (typeof url === 'string' && url.includes('hermes.twitch.tv')) {
      ws.addEventListener('message', handleHermesMessage)
      log('Hermes WebSocket intercepted')
    }
    return ws
  }
  HsWebSocket.prototype = OrigWebSocket.prototype
  HsWebSocket.CONNECTING = OrigWebSocket.CONNECTING
  HsWebSocket.OPEN = OrigWebSocket.OPEN
  HsWebSocket.CLOSING = OrigWebSocket.CLOSING
  HsWebSocket.CLOSED = OrigWebSocket.CLOSED

  safeOverride(window, 'WebSocket', HsWebSocket)

  // ═══ Eager channel ID discovery ═══
  // Twitch sometimes hydrates __NEXT_DATA__ or __APOLLO_STATE__ early; check periodically
  // until we have an ID for the current URL slug.
  function discoverChannelIdFromGlobals() {
    const slug = location.pathname.match(/^\/([^/]+)/)?.[1]?.toLowerCase()
    if (!slug) return
    if (document.documentElement.dataset.hsTwitchChannelLogin === slug) return // already found
    try {
      const apollo = window.__APOLLO_STATE__ || window.__APOLLO_CLIENT__?.cache?.extract?.()
      if (apollo) {
        for (const [_key, val] of Object.entries(apollo)) {
          // Apollo cache keys often look like "User:12345" or "Channel:12345"
          if (val?.login?.toLowerCase?.() === slug && val?.id) {
            setChannelId(String(val.id), slug)
            return
          }
          if (val?.__typename === 'User' && val?.login?.toLowerCase?.() === slug && val?.id) {
            setChannelId(String(val.id), slug)
            return
          }
        }
      }
    } catch {}
    try {
      const nextData = document.getElementById('__NEXT_DATA__')
      if (nextData?.textContent) {
        const data = JSON.parse(nextData.textContent)
        const ch =
          data?.props?.pageProps?.channelId || data?.props?.relayEnvironment?.store?.['client:root']?.channel?.id
        if (ch) setChannelId(String(ch), slug)
      }
    } catch {}
  }
  // Try once now, then poll briefly until found or 10s elapses
  discoverChannelIdFromGlobals()
  let _idDiscoveryAttempts = 0
  const _idDiscoveryPoll = setInterval(() => {
    discoverChannelIdFromGlobals()
    if (++_idDiscoveryAttempts >= 20 || document.documentElement.dataset.hsTwitchChannelLogin) {
      clearInterval(_idDiscoveryPoll)
    }
  }, 500)

  // ═══ Twitch GQL Interception ═══
  // Captures persisted query hashes, integrity tokens, and response data
  // from Twitch's own GQL calls. Proxies GQL requests from content scripts.
  const gql = {
    hashes: {
      // operationName → sha256Hash (seeded with known working hashes)
      MakePrediction: 'b44682ecc88358817009f20e69d75081b1e58825bb40aa53d5dbadcc17c881d8',
      ChannelPointsPredictionContext: 'beb846598256b75bd7c1fe54a80431335996153e358ca9c7837ce7bb83d7d383',
      // Resub/sub-anniversary "Share to chat" — fires the celebrated USERNOTICE
      // with the user's typed body. Tokens are formatted base64(userId:channelId:months:cumulative).
      // Captured live from Twitch; replaced automatically if Twitch ships a new hash.
      Chat_ShareResub_UseResubToken: '61045d4a4bb10d25080bc0a01a74232f1fa67a6a530e0f2ebf05df2f1ba3fa59',
      // Cheer bits — the canonical bits-send mutation twitch's own client fires
      // when the bits modal confirms. Captures auto-update if rotated.
      ChatInput_SendCheer: '57b0d6bd979e516ae3767f6586e7f23666d612d3a65af1d5436dba130c9426fd',
      // Follow / unfollow buttons. Twitch's public follow REST API was removed
      // Aug 2023; the only path left for "follow another user on twitch from
      // an extension" is this GQL mutation pair, called the same way Twitch's
      // own follow button does. Hashes auto-update if rotated. Used by
      // cross-follow.js to propagate heatsync follows onto twitch.
      FollowButton_FollowUser: '800e7346bdf7e5278a3c1d3f21b2b56e2639928f86815677a7126b093b2fdd08',
      FollowButton_UnfollowUser: 'f7dae976ebf41c755ae2d758546bfd176b4eeb856656098bb40e0a672ca0d880',
    },
    integrity: null, // Client-Integrity token
    // The integrity token is BOUND to the exact device-id + session-id + client
    // version twitch minted it with. Replaying the token with a different
    // X-Device-Id (our local_storage_device_id does NOT match twitch's actual
    // one) or without Client-Session-Id/Client-Version → "failed integrity
    // check" on every mutation. Capture twitch's real values and replay them as
    // a coherent set alongside the token (see the fetch hook + buildGqlHeaders).
    deviceId: null, // twitch's actual X-Device-Id (NOT local_storage_device_id)
    sessionId: null, // Client-Session-Id
    clientVersion: null, // Client-Version
    clientId: null, // Client-Id
    authToken: null, // OAuth token
    userId: null, // Logged-in user's twitch ID (resolved via currentUser GQL)
    userLogin: null, // Logged-in user's login
    cache: {}, // operationName → { data, ts }
    pendingRequests: new Map(), // queued requests waiting for hashes
  }

  // One-time self-identification: as soon as we have an auth token, fetch
  // currentUser via GQL and stamp the result on documentElement so content.js
  // (isolated world) can read it. Critical for popout chat where
  // localStorage.twilight.user is null and getCurrentUsername fails.
  let _selfFetchInFlight = false
  function ensureSelfIdentified() {
    if (gql.userId || _selfFetchInFlight || !gql.authToken) return
    _selfFetchInFlight = true
    const cid = gql.clientId || 'kimne78kx3ncx6brgo4mv6wki5h1ko'
    origFetch('https://gql.twitch.tv/gql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Client-Id': cid, Authorization: `OAuth ${gql.authToken}` },
      body: JSON.stringify({ query: '{ currentUser { id login displayName } }' }),
    })
      .then((r) => {
        if (!r.ok) {
          console.warn('[heatsync-gql] self-auth http', r.status)
          return null
        }
        return r.json()
      })
      .then((d) => {
        _selfFetchInFlight = false
        const cu = d?.data?.currentUser
        if (!cu?.id) return
        gql.userId = String(cu.id)
        gql.userLogin = cu.login
        try {
          document.documentElement.dataset.hsSelfTwitchId = String(cu.id)
          document.documentElement.dataset.hsSelfTwitchLogin = String(cu.login || '').toLowerCase()
          window.postMessage(
            {
              type: 'heatsync-self-twitch-id',
              twitchId: String(cu.id),
              login: String(cu.login || '').toLowerCase(),
              nonce: _hsNonce,
            },
            location.origin,
          )
        } catch {}
      })
      .catch((e) => {
        _selfFetchInFlight = false
        console.warn('[heatsync-gql] self-auth failed:', e?.message || e)
      })
  }

  const GQL_OPS_TO_CACHE = [
    'ChannelPointsPredictionContext',
    'CommunityPointsContext',
    'ChannelPointsContext',
    'ActivePoll',
    'CreatePoll',
    'MakePrediction',
    'ChannelPointsRewardRedemption',
  ]

  // Anon-chat presence-blocklist (FFZ-style read-only mode)
  const HS_ANON_OPS = new Set([
    'UpdateUserActivity',
    'UseLive',
    'PresenceMap',
    'UpdateChatPresence',
    'PresenceUpdate',
    'ChatPresence',
    'CurrentUserActiveChannel',
  ])

  // Hook fetch to intercept Twitch GQL traffic
  const origFetch = window.fetch
  const hsFetch = function (input, init) {
    const url = typeof input === 'string' ? input : input?.url
    // Anon mode: drop presence/activity GQL calls so Twitch stops broadcasting "online"
    if (
      url?.includes('gql.twitch.tv') &&
      init?.method === 'POST' &&
      document.documentElement.classList.contains('hs-anon-chat')
    ) {
      try {
        const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
        const ops = Array.isArray(body) ? body : body ? [body] : []
        if (ops.length && ops.every((op) => HS_ANON_OPS.has(op?.operationName))) {
          // Pretend it succeeded; return empty data array
          return Promise.resolve(
            new Response(JSON.stringify(ops.map(() => ({ data: null }))), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
          )
        }
      } catch {}
    }
    if (url?.includes('gql.twitch.tv') && init?.method === 'POST') {
      // Capture headers
      try {
        const hdrs = init.headers
        if (hdrs) {
          const get = (k) => {
            if (hdrs instanceof Headers) return hdrs.get(k)
            if (typeof hdrs === 'object') return hdrs[k] || hdrs[k.toLowerCase()]
            return null
          }
          const integ = get('Client-Integrity')
          if (integ) {
            // Twitch's OWN gql requests carry a proof-of-work-backed (Kasada)
            // integrity token — the only kind gql actually accepts for
            // mutations. Reuse it and stamp a freshness window so fetchIntegrity
            // PREFERS it over minting our own (a plain /integrity POST with no
            // KPSDK headers yields a token twitch rejects → "failed integrity
            // check" on /announce, /highlight, every mutation). Twitch fires gql
            // constantly, so the capture refreshes well inside this window.
            gql.integrity = integ
            gql.integrityTs = Date.now()
            gql.integrityExp = Date.now() + 5 * 60 * 1000
          }
          const cid = get('Client-Id') || get('Client-ID')
          if (cid) gql.clientId = cid
          // Capture the token's binding context so we can replay it intact.
          const dev = get('X-Device-Id') || get('X-Device-ID')
          if (dev) gql.deviceId = dev
          const sess = get('Client-Session-Id')
          if (sess) gql.sessionId = sess
          const ver = get('Client-Version')
          if (ver) gql.clientVersion = ver
          const auth = get('Authorization')
          if (auth?.startsWith('OAuth ')) {
            gql.authToken = auth.slice(6)
            // Trigger one-time self-identification once auth is available.
            ensureSelfIdentified()
          }
        }
      } catch (_e) {}

      // Capture operation hashes from request body
      try {
        const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
        if (body) {
          const ops = Array.isArray(body) ? body : [body]
          for (const op of ops) {
            const hash = op?.extensions?.persistedQuery?.sha256Hash
            if (hash && op.operationName) {
              gql.hashes[op.operationName] = hash
              log('GQL hash captured:', op.operationName)
            }
          }
        }
      } catch (_e) {}

      // Intercept response to cache data
      // biome-ignore lint/complexity/noArguments: transparent monkeypatch forward. `arguments` passes through every argument the host actually called with, including any we don't model, and keeps the wrapper's arity — rest params would change fn.length, which host code can branch on.
      const promise = origFetch.apply(this, arguments)
      promise
        .then((resp) => {
          if (!resp.ok) return
          const clone = resp.clone()
          clone
            .json()
            .then((data) => {
              const items = Array.isArray(data) ? data : [data]
              for (const item of items) {
                const opName = item?.extensions?.operationName
                if (!opName) continue
                if (Object.keys(gql.cache).length > 50) {
                  const oldest = Object.entries(gql.cache).reduce((a, b) => (a[1].ts < b[1].ts ? a : b))
                  delete gql.cache[oldest[0]]
                }
                gql.cache[opName] = { data: item.data, ts: Date.now() }
                // Extract user ID → login mappings for Hermes channel resolution
                try {
                  const u = item.data?.user || item.data?.channel?.owner
                  if (u?.id && u?.login) setChannelId(u.id, u.login.toLowerCase())
                } catch {}
                // Forward prediction/poll/points data to content script
                if (
                  GQL_OPS_TO_CACHE.some((n) => opName.includes(n) || opName.toLowerCase().includes(n.toLowerCase()))
                ) {
                  window.postMessage(
                    {
                      type: 'heatsync-gql-data',
                      operation: opName,
                      data: item.data,
                      errors: item.errors || null,
                      nonce: _hsNonce,
                    },
                    location.origin,
                  )
                }
              }
              // Flush any pending requests that now have hashes
              for (const [id, req] of gql.pendingRequests) {
                if (gql.hashes[req.operation]) {
                  gql.pendingRequests.delete(id)
                  executeGqlProxy(req)
                }
              }
            })
            .catch(() => {})
        })
        .catch(() => {})

      return promise
    }

    // Capture integrity token from Twitch's own /integrity calls
    if (url?.includes('gql.twitch.tv/integrity')) {
      // biome-ignore lint/complexity/noArguments: transparent monkeypatch forward. `arguments` passes through every argument the host actually called with, including any we don't model, and keeps the wrapper's arity — rest params would change fn.length, which host code can branch on.
      const promise = origFetch.apply(this, arguments)
      promise
        .then((resp) => {
          if (!resp.ok) return
          resp
            .clone()
            .json()
            .then((data) => {
              if (data.token) {
                // Twitch's own /integrity response — a valid KPSDK-backed token.
                // Stamp its real expiry so fetchIntegrity reuses it instead of
                // minting our own (which twitch rejects). See the header-capture
                // note above.
                gql.integrity = data.token
                gql.integrityTs = Date.now()
                gql.integrityExp =
                  typeof data.expiration === 'number' && data.expiration > Date.now()
                    ? data.expiration
                    : Date.now() + 5 * 60 * 1000
              }
            })
            .catch(() => {})
        })
        .catch(() => {})
      return promise
    }

    // biome-ignore lint/complexity/noArguments: transparent monkeypatch forward. `arguments` passes through every argument the host actually called with, including any we don't model, and keeps the wrapper's arity — rest params would change fn.length, which host code can branch on.
    return origFetch.apply(this, arguments)
  }
  safeOverride(window, 'fetch', hsFetch)

  // Read auth-token cookie as fallback when fetch interception missed it
  function getAuthToken() {
    if (gql.authToken) return gql.authToken
    try {
      const m = document.cookie.match(/(?:^|;\s*)auth-token=([^;]+)/)
      if (m) {
        gql.authToken = m[1]
        return m[1]
      }
    } catch {}
    return null
  }

  // Read Twitch's persistent device ID — needed for /integrity call signature.
  // Falls back to a random ID; Twitch accepts random IDs as long as they're stable.
  function getDeviceId() {
    try {
      const raw = localStorage.getItem('local_storage_device_id')
      if (raw) {
        const id = raw.replace(/^"|"$/g, '')
        // Persist to documentElement so content.js (isolated world) can copy it
        // to chrome.storage.local, where the SW reads it for off-twitch follows
        // that need to mint integrity without a twitch.tv tab open.
        try {
          if (document.documentElement.dataset.hsTwitchDeviceId !== id) {
            document.documentElement.dataset.hsTwitchDeviceId = id
          }
        } catch {}
        return id
      }
    } catch {}
    try {
      const m = document.cookie.match(/(?:^|;\s*)unique_id=([^;]+)/)
      if (m) return m[1]
    } catch {}
    if (!gql._fallbackDeviceId) gql._fallbackDeviceId = `heatsync-${Math.random().toString(36).slice(2, 18)}`
    return gql._fallbackDeviceId
  }

  // Fetch a fresh Client-Integrity token from Twitch's /integrity endpoint.
  // Mutations require this; reads work without. Cached + refreshed on demand.
  let _integrityRefreshPromise = null
  async function fetchIntegrity() {
    if (gql.integrity && gql.integrityExp && Date.now() < gql.integrityExp - 30000) {
      return gql.integrity
    }
    if (_integrityRefreshPromise) return _integrityRefreshPromise
    _integrityRefreshPromise = (async () => {
      const token = getAuthToken()
      if (!token) return null
      const cid = gql.clientId || 'kimne78kx3ncx6brgo4mv6wki5h1ko'
      try {
        const r = await origFetch('https://gql.twitch.tv/integrity', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Client-Id': cid,
            Authorization: `OAuth ${token}`,
            'X-Device-Id': gql.deviceId || getDeviceId(),
          },
          body: '{}',
        })
        if (!r.ok) return null
        const d = await r.json()
        if (!d?.token) return null
        gql.integrity = d.token
        // Twitch returns expiration as ms-since-epoch; fall back to +5min if missing/bogus
        gql.integrityExp =
          typeof d.expiration === 'number' && d.expiration > Date.now() ? d.expiration : Date.now() + 5 * 60 * 1000
        gql.integrityTs = Date.now()
        return d.token
      } catch {
        return null
      }
    })()
    try {
      return await _integrityRefreshPromise
    } finally {
      _integrityRefreshPromise = null
    }
  }

  function buildGqlHeaders() {
    const hdrs = { 'Content-Type': 'application/json' }
    if (gql.clientId) hdrs['Client-Id'] = gql.clientId
    else hdrs['Client-Id'] = 'kimne78kx3ncx6brgo4mv6wki5h1ko'
    const token = getAuthToken()
    if (token) hdrs.Authorization = `OAuth ${token}`
    if (gql.integrity) hdrs['Client-Integrity'] = gql.integrity
    // Replay the token's FULL binding context. The captured device-id is
    // twitch's real one (our local_storage_device_id fallback does NOT match it,
    // which alone fails integrity); session-id + version complete the binding.
    // Fall back to getDeviceId() only before the first capture.
    hdrs['X-Device-Id'] = gql.deviceId || getDeviceId()
    if (gql.sessionId) hdrs['Client-Session-Id'] = gql.sessionId
    if (gql.clientVersion) hdrs['Client-Version'] = gql.clientVersion
    return hdrs
  }

  async function executeGqlProxy(req) {
    const hash = gql.hashes[req.operation]
    if (!hash && !req.rawQuery) {
      window.postMessage(
        {
          type: 'heatsync-gql-response',
          id: req.id,
          error: `no hash for ${req.operation}`,
        },
        location.origin,
      )
      return
    }

    const body = req.rawQuery
      ? { query: req.rawQuery, variables: req.variables || {} }
      : {
          operationName: req.operation,
          extensions: { persistedQuery: { version: 1, sha256Hash: hash } },
          variables: req.variables || {},
        }

    // Support batched operations
    const payload = req.batch
      ? req.batch.map((op) => ({
          operationName: op.operation,
          extensions: { persistedQuery: { version: 1, sha256Hash: gql.hashes[op.operation] || hash } },
          variables: op.variables || {},
        }))
      : body

    if (!getAuthToken()) {
      window.postMessage(
        {
          type: 'heatsync-gql-response',
          id: req.id,
          error: 'no twitch auth token captured — refresh the page',
        },
        location.origin,
      )
      return
    }

    // Mutations need valid integrity — reads work without. Detect:
    //   rawQuery starting with "mutation", or non-cache GQL_OPS persisted query
    const isMutation = req.rawQuery ? /^\s*mutation\b/i.test(req.rawQuery) : !GQL_OPS_TO_CACHE.includes(req.operation)
    if (isMutation) {
      try {
        await fetchIntegrity()
      } catch {}
    }

    const doFetch = () =>
      origFetch('https://gql.twitch.tv/gql', {
        method: 'POST',
        headers: buildGqlHeaders(),
        body: JSON.stringify(payload),
      }).then((r) => {
        if (DEBUG) console.log('[heatsync-gql] response status:', r.status)
        return r.json()
      })

    try {
      let data = await doFetch()
      // On integrity failure, force-refresh integrity and retry once
      const items = Array.isArray(data) ? data : [data]
      const integrityFail = items.some(
        (it) => Array.isArray(it?.errors) && it.errors.some((e) => /integrity/i.test(e?.message || '')),
      )
      if (integrityFail) {
        gql.integrity = null
        gql.integrityExp = 0
        await fetchIntegrity()
        data = await doFetch()
      }
      if (DEBUG) console.log('[heatsync-gql] response data:', JSON.stringify(data).slice(0, 500))
      window.postMessage({ type: 'heatsync-gql-response', id: req.id, data }, location.origin)
    } catch (err) {
      console.error('[heatsync-gql] fetch error:', err?.message || err)
      window.postMessage(
        { type: 'heatsync-gql-response', id: req.id, error: err?.message || String(err) },
        location.origin,
      )
    }
  }

  // ═══ Nonce-based request authentication ═══
  // content.js (ISOLATED world) generates a random nonce on load and sends it here via
  // heatsync-init-nonce. All subsequent heatsync-gql-request / heatsync-apollo-mutate
  // messages must carry a matching nonce field.
  //
  // ARCHITECTURAL CONSTRAINT: this script runs in MAIN world (shared with the page), so
  // window.postMessage and the init-nonce message are observable by page JS. A nonce
  // cannot be kept truly secret in MAIN world. Mitigations applied:
  //   1. Rate-limiting on apollo-mutate and helix proxy handlers (below).
  //   2. Allowlists restricting which mutations/URLs are reachable.
  // Future direction: service-worker proxy could enforce auth without MAIN-world exposure.
  //
  // content.js MUST send on load:
  //   window.postMessage({ type: 'heatsync-init-nonce', nonce: <16-byte hex> }, location.origin)
  let _hsNonce = null

  // Rate-limit state for privileged proxy handlers.
  // Window: 10 s, cap: 10 calls per window (legit use is occasional, user-driven).
  // Apollo mutations are user-driven (mod/prediction actions) and rare, so
  // this keeps a tight cap to blunt spoofed-nonce spam.
  const _mutateRate = { ts: [], windowMs: 10000, max: 10 }
  // Separate bucket for the gql-request (Helix-style) proxy's mutation subset, so
  // follows/redeems/predictions don't share budget with apollo-proxy mod actions.
  const _gqlMutateRate = { ts: [], windowMs: 10000, max: 10 }
  function _proxyAllowed(bucket) {
    const now = Date.now()
    bucket.ts = bucket.ts.filter((t) => now - t < bucket.windowMs)
    if (bucket.ts.length >= bucket.max) return false
    bucket.ts.push(now)
    return true
  }

  // Handle GQL requests from content script
  // event.source === window: blocks cross-frame attacks; same-page scripts still pass (accepted MAIN-world limitation)
  const hsMessageHandler = (e) => {
    if (e.source !== window) return
    if (e.origin !== location.origin) return

    // Accept nonce from content script (ISOLATED world) on initialisation
    if (e.data?.type === 'heatsync-init-nonce' && typeof e.data.nonce === 'string') {
      // Freeze on first set. In MAIN world the nonce can't be kept secret, but
      // without this a co-resident page script could OVERWRITE it at will and then
      // forge privileged apollo/gql mutations carrying the matching nonce. Freezing
      // means only the first setter (content.js, which posts exactly once per
      // injection) wins; any later overwrite attempt is ignored. Pre-empting the
      // first set is still theoretically possible but far harder than
      // overwrite-anytime — the operation allowlist + rate limit remain the backstop.
      if (_hsNonce) return
      _hsNonce = e.data.nonce
      return
    }

    // ═══ Apollo mutation proxy ═══
    // Generic handler: find Twitch's Apollo client + webpack mutation document,
    // call client.mutate() with full auth/integrity context.
    // Used for AcceptPredictionTerms and any mutation that needs persisted query hashes.
    if (e.data?.type === 'heatsync-apollo-mutate') {
      if (!_hsNonce || e.data.nonce !== _hsNonce) {
        log('heatsync-apollo-mutate: rejected — missing or invalid nonce')
        return
      }
      if (!_proxyAllowed(_mutateRate)) {
        log('heatsync-apollo-mutate: rate limit exceeded')
        window.postMessage(
          { type: 'heatsync-apollo-mutate-response', id: e.data.id, data: { error: 'rate limit exceeded' } },
          location.origin,
        )
        return
      }
      if (e.data.rawQuery) {
        window.postMessage(
          { type: 'heatsync-apollo-mutate-response', id: e.data.id, data: { error: 'raw queries not allowed' } },
          location.origin,
        )
        return
      }
      const ALLOWED_MUTATIONS = [
        'ChannelPointsPrediction',
        'CommunityPointsClaim',
        'MakePrediction',
        'EventPrediction',
        'VotePoll',
        'CreatePoll',
        'RedeemCustomReward',
        'SendChatMessage',
        'JoinRaid',
        // Cross-platform follow: use Twitch's own Apollo client so the
        // integrity token + auth chain attach naturally. Direct GQL fetches
        // (even with manually-minted integrity) get rejected as "failed
        // integrity check" — Apollo links are what Twitch's anti-bot trusts.
        'FollowUser',
        'UnfollowUser',
        // Whispers: same story as follow — a direct gql.twitch.tv POST gets
        // "failed integrity check", so the send must ride Twitch's own Apollo
        // link chain. SendWhisper Document is loaded from webpack by searchTerm.
        'SendWhisper',
        // Mod actions (right-click → timeout/ban/unban/delete). These were
        // missed when this allowlist was introduced, silently breaking every
        // mod action: apolloMutate got "mutation not allowed" and the rawQuery
        // fallback is also blocked, so timeouts no-oped. Same risk class as
        // SendChatMessage above — the user's own session/mod status gates the
        // actual effect, and _mutateRate caps spoofed-nonce spam.
        'Chat_BanUserFromChatRoom',
        'Chat_UnbanUserFromChatRoom',
        'Chat_DeleteChatMessage',
        // Prediction terms-of-service accept (first-ever prediction per account)
        // — also missed; without it the predictions tab wedged on the ToS step.
        'AcceptPredictionTerms',
        // The broadcaster's four prediction verbs (/prediction, /lockpred,
        // /resolvepred, /cancelpred). MakePrediction above is the VIEWER's bet,
        // so betting worked while running a prediction was impossible — the
        // asymmetry is what made it look like a permissions problem. Both paths
        // were blocked: apolloMutate returned "mutation not allowed", and the
        // rawQuery fallback is dead for mutations anyway (see gqlPersistedMutation).
        // Same risk class as CreatePoll/VotePoll already here — twitch gates the
        // real effect on the caller's own broadcaster status, and _mutateRate
        // caps spoofed-nonce replay.
        'CreatePredictionEvent',
        'LockPredictionEvent',
        'ResolvePredictionEvent',
        'CancelPredictionEvent',
        // /announce — same missed-allowlist-entry bug as the mod actions above
        // (2026-07-20: silently broke every announce send, always burning the
        // full apolloMutate timeout before falling to a raw fetch that then
        // failed Twitch's integrity check anyway).
        'SendAnnouncementMessage',
        // VIP / unVIP — broadcaster role management (op names captured live from
        // twitch's Roles Manager). Same risk class as the other mod actions:
        // the user's own broadcaster status gates the real effect server-side.
        'VIPUser',
        'UnVIPUser',
        'ModUser',
        'UnmodUser',
      ]
      if (e.data.searchTerm && !ALLOWED_MUTATIONS.includes(e.data.searchTerm)) {
        log('heatsync-apollo-mutate: rejected — searchTerm not in allowlist:', e.data.searchTerm)
        window.postMessage(
          { type: 'heatsync-apollo-mutate-response', id: e.data.id, data: { error: 'mutation not allowed' } },
          location.origin,
        )
        return
      }
      const reqId = e.data.id
      const searchTerm = e.data.searchTerm // string to find in webpack module factory source
      const variables = e.data.variables || {}
      const resultField = e.data.resultField // e.g. 'updateUserPredictionSettings'
      ;(async () => {
        const respond = (data) =>
          window.postMessage(
            {
              type: 'heatsync-apollo-mutate-response',
              id: reqId,
              data,
            },
            location.origin,
          )
        try {
          // Find Apollo client from React fiber tree
          // React 18 uses __reactContainer$, React 17 uses __reactFiber$
          // Apollo client lives in a context provider's props.value (BFS down from root)
          const root = document.getElementById('root')
          const fiberKey =
            root && Object.keys(root).find((k) => k.startsWith('__reactContainer$') || k.startsWith('__reactFiber$'))
          let apolloClient = null
          if (fiberKey) {
            const queue = [root[fiberKey]]
            const visited = new Set()
            let steps = 0
            while (queue.length && steps < 500 && !apolloClient) {
              const node = queue.shift()
              if (!node || visited.has(node)) continue
              visited.add(node)
              steps++
              // Check memoizedState chain
              let state = node.memoizedState
              while (state) {
                const val = state.memoizedState
                if (val?.client?.mutate && val?.client?.query) {
                  apolloClient = val.client
                  break
                }
                state = state.next
              }
              // Check context provider props
              if (!apolloClient) {
                const ctx = node.memoizedProps?.value
                if (ctx?.client?.mutate && ctx?.client?.query) apolloClient = ctx.client
              }
              if (!apolloClient) {
                if (node.child) queue.push(node.child)
                if (node.sibling) queue.push(node.sibling)
              }
            }
          }

          if (apolloClient && searchTerm) {
            // Load the mutation Document from Twitch's webpack modules.
            // GQL operation Docs that reference fragments (e.g. FollowButton_FollowUser
            // spreads followButtonFragment) require RESOLVING webpack deps so the
            // fragment Documents get inlined into definitions[]. A naive empty-{}
            // require stub leaves the fragment unresolved, .mutate() then throws
            // "Unknown fragment", and the caller falls back to direct gql.twitch.tv
            // fetch which gets "failed integrity check". Recursive loader fixes both.
            const chunks = window.webpackChunktwitch_twilight || []
            const modCache = {}
            const findFactory = (id) => {
              for (const chunk of chunks) {
                const mods = chunk[1]
                if (mods && typeof mods === 'object' && typeof mods[id] === 'function') return mods[id]
              }
              return null
            }
            const proxyStub = () => {
              const t = () => proxyStub()
              return new Proxy(t, {
                get(_, p) {
                  if (p === 'default') return t
                  if (p === Symbol.iterator) return function* () {}
                  if (p === 'length') return 0
                  return proxyStub()
                },
                apply() {
                  return proxyStub()
                },
              })
            }
            const loadMod = (id) => {
              const key = String(id)
              if (modCache[key]) return modCache[key]
              const factory = findFactory(key)
              if (!factory) return proxyStub()
              const m = { exports: {} }
              const req = (depId) => {
                if (typeof depId === 'number' || /^\d+$/.test(String(depId))) return loadMod(depId)
                return proxyStub()
              }
              try {
                factory(m, m.exports, req)
              } catch {}
              modCache[key] = m.exports
              return m.exports
            }
            let doc = null
            for (const chunk of chunks) {
              const mods = chunk[1]
              if (!mods || typeof mods !== 'object') continue
              for (const [id, factory] of Object.entries(mods)) {
                if (typeof factory !== 'function') continue
                const src = factory.toString()
                if (!src.includes(searchTerm)) continue
                const exp = loadMod(id)
                if (exp?.kind === 'Document' && exp.definitions?.some((d) => d.name?.value === searchTerm)) {
                  doc = exp
                  break
                }
                if (
                  exp?.default?.kind === 'Document' &&
                  exp.default.definitions?.some((d) => d.name?.value === searchTerm)
                ) {
                  doc = exp.default
                  break
                }
              }
              if (doc) break
            }
            log(`apollo-mutate[${searchTerm}]: doc=${!!doc}`)

            if (doc) {
              const result = await apolloClient.mutate({ mutation: doc, variables })
              log(`apollo-mutate[${searchTerm}]: result=${JSON.stringify(result?.data).slice(0, 200)}`)
              if (resultField) {
                const field = result?.data?.[resultField]
                const err = field?.error
                respond(err ? { error: err.code || 'mutation error' } : { ok: true, data: result.data })
              } else {
                respond({ ok: true, data: result.data })
              }
              return
            }
          }

          respond({ error: 'apollo client or webpack module not found' })
        } catch (err) {
          log(`apollo-mutate: exception=${err.message}`)
          respond({ error: err.message })
        }
      })()
      return
    }

    // Content script requesting GQL proxy call
    if (e.data?.type === 'heatsync-gql-request') {
      if (!_hsNonce || e.data.nonce !== _hsNonce) {
        log('heatsync-gql-request: rejected — missing or invalid nonce')
        window.postMessage(
          {
            type: 'heatsync-gql-response',
            id: e.data.id,
            error: 'invalid nonce',
          },
          location.origin,
        )
        return
      }
      const req = e.data
      if (req.rawQuery) {
        window.postMessage(
          {
            type: 'heatsync-gql-response',
            id: req.id,
            error: 'raw queries not allowed',
          },
          location.origin,
        )
        return
      }
      // Explicit operation allowlist. gql.hashes auto-caches every operation
      // Twitch's own page fires, so without this a forged message (the nonce
      // can't be secret in MAIN world) could proxy ANY of them with the user's
      // OAuth+integrity token. Restrict to exactly what the extension calls.
      const ALLOWED_GQL_OPS = [
        'CommunityPointsContext',
        'ChannelPointsContext',
        'RedeemCommunityPointsCustomReward',
        'ClaimCommunityPoints',
        'VotePoll',
        'Chat_ShareResub_UseResubToken',
        'MakePrediction',
        'SetFollowersOnlyModeSetting',
        'FollowButton_FollowUser',
        'FollowButton_UnfollowUser',
      ]
      // Reads (points/context) stay unlimited so legit channel-load bursts never
      // throttle; everything else mutates and spends the user's token.
      const GQL_READ_OPS = new Set(['CommunityPointsContext', 'ChannelPointsContext'])
      const gqlOps = req.batch ? req.batch.map((o) => o?.operation) : [req.operation]
      if (!gqlOps.length || !gqlOps.every((op) => ALLOWED_GQL_OPS.includes(op))) {
        log(`heatsync-gql-request: operation not allowed — ${gqlOps.join(',')}`)
        window.postMessage(
          { type: 'heatsync-gql-response', id: req.id, error: 'operation not allowed' },
          location.origin,
        )
        return
      }
      // Rate-limit the mutation subset — matches the "allowlist + rate limit"
      // guarantee in SECURITY.md. A forged message (nonce is observable in MAIN
      // world) can therefore replay a mutation at most _gqlMutateRate.max / window.
      const isMutatingGql = gqlOps.some((op) => !GQL_READ_OPS.has(op))
      if (isMutatingGql && !_proxyAllowed(_gqlMutateRate)) {
        log(`heatsync-gql-request: rate limit exceeded — ${gqlOps.join(',')}`)
        window.postMessage({ type: 'heatsync-gql-response', id: req.id, error: 'rate limit exceeded' }, location.origin)
        return
      }
      if (gql.hashes[req.operation]) {
        executeGqlProxy(req)
      } else {
        // Queue request — hash might arrive soon from Twitch's own calls
        gql.pendingRequests.set(req.id, req)
        setTimeout(() => {
          if (gql.pendingRequests.has(req.id)) {
            gql.pendingRequests.delete(req.id)
            window.postMessage(
              {
                type: 'heatsync-gql-response',
                id: req.id,
                error: `hash not available for ${req.operation}`,
              },
              location.origin,
            )
          }
        }, 2000)
      }
      return
    }
  }
  window.addEventListener('message', hsMessageHandler)

  let urlMapWasEmpty = true

  // Listen for URL map updates from content script
  const hsUrlMapHandler = (e) => {
    if (e.source !== window) return
    if (e.origin !== location.origin) return
    if (e.data?.type === 'heatsync-url-map' && e.data.urlMap) {
      const wasEmpty = urlMapWasEmpty
      // These values become img.src via the native-element setter intercept, so a
      // spoofed url-map (page JS can post one — MAIN-world nonce is observable, see
      // the init-nonce note) could plant tracking-pixel URLs. Allowlist emote CDNs
      // only; drop anything else. Defends the sink regardless of nonce reachability.
      // Mirrors background.js EMOTE_CDN_PATTERN — cdn.heatsync.org/heatsync.org
      // and files.kick.com must be present or self-hosted + kick emotes silently
      // fail to patch native img.src through this path (the same omission that
      // once dropped every uploaded emote from the inventory).
      const EMOTE_CDN_RE =
        /^https:\/\/(static-cdn\.jtvnw\.net\/emoticons|cdn\.(7tv\.app|betterttv\.net|frankerfacez\.com|heatsync\.org)|heatsync\.org|files\.kick\.com)\//
      for (const [k, v] of Object.entries(e.data.urlMap)) {
        if (typeof v === 'string' && EMOTE_CDN_RE.test(v)) window.__heatsyncEmoteUrls[k] = v
      }
      urlMapWasEmpty = Object.keys(window.__heatsyncEmoteUrls).length === 0

      if (wasEmpty && !urlMapWasEmpty) {
        fixExistingImages()
      }
    }
  }
  window.addEventListener('message', hsUrlMapHandler)

  function fixExistingImages() {
    const images = document.querySelectorAll('img[src*="__FFZ__999999"]')
    images.forEach((img) => {
      if (img.dataset.heatsyncFixed) return
      const fixedUrl = fixUrl(img.src)
      if (fixedUrl) {
        img.src = fixedUrl
        img.dataset.heatsyncFixed = 'true'
      }
    })
  }

  function fixUrl(value) {
    if (!value || typeof value !== 'string') return null

    if (value.includes('__FFZ__999999::')) {
      const match = value.match(/__FFZ__999999::([a-zA-Z0-9]+)__FFZ__/)
      if (match) {
        const url = window.__heatsyncEmoteUrls?.[match[1]]
        if (url) return url
      }
    }

    if (value.includes('jtvnw.net/emoticons/v2/__FFZ__')) {
      const match = value.match(/__FFZ__999999::([a-f0-9]+)__FFZ__/)
      if (match) {
        const url = window.__heatsyncEmoteUrls?.[match[1]]
        if (url) return url
      }
    }

    return null
  }

  // Override img.src setter
  const srcDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')
  if (srcDesc) {
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      get: function () {
        return srcDesc.get.call(this)
      },
      set: function (value) {
        const fixed = fixUrl(value)
        if (fixed) {
          this.dataset.heatsyncFixed = 'true'
          return srcDesc.set.call(this, fixed)
        }
        return srcDesc.set.call(this, value)
      },
      configurable: true,
      enumerable: true,
    })
  }

  // Override setAttribute for src and srcset
  const origSetAttr = Element.prototype.setAttribute
  const hsSetAttribute = function (name, value) {
    if (this.tagName === 'IMG' && (name === 'src' || name === 'srcset')) {
      const fixed = fixUrl(value)
      if (fixed) {
        this.dataset.heatsyncFixed = 'true'
        const fixedValue = name === 'srcset' ? `${fixed} 1x` : fixed
        return origSetAttr.call(this, name, fixedValue)
      }
    }
    return origSetAttr.call(this, name, value)
  }
  safeOverride(Element.prototype, 'setAttribute', hsSetAttribute)

  // Override srcset property setter
  const srcsetDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'srcset')
  if (srcsetDesc) {
    Object.defineProperty(HTMLImageElement.prototype, 'srcset', {
      get: function () {
        return srcsetDesc.get.call(this)
      },
      set: function (value) {
        const fixed = fixUrl(value)
        if (fixed) {
          this.dataset.heatsyncFixed = 'true'
          return srcsetDesc.set.call(this, `${fixed} 1x`)
        }
        return srcsetDesc.set.call(this, value)
      },
      configurable: true,
      enumerable: true,
    })
  }

  // Override Image constructor
  // MUST be a real function, not an arrow — page code calls `new Image()`, and
  // arrows throw "not a constructor" (same trap as HsWebSocket above). A biome
  // format pass once converted this to an arrow and silently broke twitch's
  // video player bootstrap site-wide (`new Image()` threw, media never attached).
  const OrigImage = window.Image
  function HsImage(width, height) {
    const img = new OrigImage(width, height)
    const instSrcDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')
    Object.defineProperty(img, 'src', {
      get: () => instSrcDesc.get.call(img),
      set: (value) => {
        const fixed = fixUrl(value)
        if (fixed) {
          img.dataset.heatsyncFixed = 'true'
          return instSrcDesc.set.call(img, fixed)
        }
        return instSrcDesc.set.call(img, value)
      },
      configurable: true,
      enumerable: true,
    })
    return img
  }
  HsImage.prototype = OrigImage.prototype
  safeOverride(window, 'Image', HsImage)

  // Override createElement for img tags
  const origCreateElement = document.createElement.bind(document)
  const hsCreateElement = (tag, options) => {
    const el = origCreateElement(tag, options)
    if (tag.toLowerCase() === 'img') {
      const instSrcDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')
      Object.defineProperty(el, 'src', {
        get: () => instSrcDesc.get.call(el),
        set: (value) => {
          const fixed = fixUrl(value)
          if (fixed) {
            el.dataset.heatsyncFixed = 'true'
            return instSrcDesc.set.call(el, fixed)
          }
          return instSrcDesc.set.call(el, value)
        },
        configurable: true,
        enumerable: true,
      })
    }
    return el
  }
  safeOverride(document, 'createElement', hsCreateElement)

  // ========== NAVIGATION INTERCEPTION ==========
  // Hook history.pushState/replaceState + popstate BEFORE Twitch loads.
  // Content scripts listen for 'heatsync-nav' messages instead of polling location.href.

  const origPushState = history.pushState.bind(history)
  const origReplaceState = history.replaceState.bind(history)

  function notifyNav() {
    window.postMessage({ type: 'heatsync-nav', url: location.href }, location.origin)
  }

  history.pushState = (...args) => {
    origPushState(...args)
    notifyNav()
  }

  history.replaceState = (...args) => {
    origReplaceState(...args)
    notifyNav()
  }

  window.addEventListener('popstate', notifyNav)

  function hsRemoveListeners() {
    window.removeEventListener('message', hsMessageHandler)
    window.removeEventListener('message', hsUrlMapHandler)
    window.removeEventListener('message', hsUidNavHandler)
    window.removeEventListener('popstate', notifyNav)
    // Restore native WebSocket so we never leave a wrapper installed between a
    // removeListeners() and the next re-wrap (defense-in-depth against double-wrap).
    if (window.__hsNativeWebSocket) safeOverride(window, 'WebSocket', window.__hsNativeWebSocket)
  }
  window.__heatsyncEarlyInject.removeListeners = hsRemoveListeners

  // ═══ Stamp Twitch user IDs on chat messages (for cosmetics in content script) ═══
  // Content scripts can't see __reactFiber$ (isolated world), so we stamp data-user-id
  // from MAIN world where fibers are accessible.
  function stampUserIds(container) {
    const msgs = container.querySelectorAll('.chat-line__message:not([data-user-id])')
    for (const msg of msgs) {
      const key = Object.keys(msg).find((k) => k.startsWith('__reactFiber$'))
      if (!key) continue
      let fiber = msg[key]
      let depth = 0
      while (fiber && depth < 20) {
        const props = fiber.memoizedProps
        const uid =
          props?.message?.user?.userID ||
          props?.message?.user?.id ||
          props?.message?.userID ||
          props?.user?.userID ||
          props?.user?.id
        if (uid) {
          msg.setAttribute('data-user-id', String(uid))
          break
        }
        fiber = fiber.return
        depth++
      }
    }
  }

  const uidObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue
        if (node.classList?.contains('chat-line__message')) {
          const key = Object.keys(node).find((k) => k.startsWith('__reactFiber$'))
          if (key) {
            let fiber = node[key],
              depth = 0
            while (fiber && depth < 20) {
              const uid = fiber.memoizedProps?.message?.user?.userID
              if (uid) {
                node.setAttribute('data-user-id', uid)
                break
              }
              fiber = fiber.return
              depth++
            }
          }
        } else if (node.querySelector) {
          stampUserIds(node)
        }
      }
    }
  })

  // Start observing once chat container appears
  function startUidObserver() {
    const container = document.querySelector(
      '[class*="chat-scrollable-area__message-container"], [data-test-selector="chat-scrollable-area__message-container"]',
    )
    if (container) {
      stampUserIds(container)
      uidObserver.observe(container, { childList: true, subtree: true })
      return true
    }
    return false
  }

  // Poll for chat container (SPA — may not exist yet)
  let uidPollCount = 0
  let uidPollId = setInterval(() => {
    if (startUidObserver() || ++uidPollCount > 60) {
      clearInterval(uidPollId)
      uidPollId = null
    }
  }, 1000)

  // Re-attach uidObserver on SPA navigation (disconnect old, re-poll for new container)
  function resetUidObserver() {
    uidObserver.disconnect()
    uidPollCount = 0
    if (uidPollId !== null) clearInterval(uidPollId)
    uidPollId = setInterval(() => {
      if (startUidObserver() || ++uidPollCount > 60) {
        clearInterval(uidPollId)
        uidPollId = null
      }
    }, 1000)
  }

  // Listen for SPA navigation from our own history hooks.
  // Guard: notifyNav() always stamps url=location.href, so we reject messages
  // where the url doesn't match (stale or spoofed).  The 500ms throttle caps
  // the blast radius if same-origin page JS floods us — real SPA transitions
  // never arrive faster than that, so no legit nav event is suppressed.
  let _uidNavLastMs = 0
  const hsUidNavHandler = (e) => {
    if (e.source !== window || e.origin !== location.origin) return
    if (e.data?.type !== 'heatsync-nav') return
    if (e.data.url !== location.href) return
    const now = Date.now()
    if (now - _uidNavLastMs < 500) return
    _uidNavLastMs = now
    resetUidObserver()
  }
  window.addEventListener('message', hsUidNavHandler)

  window.addEventListener('pagehide', () => {
    if (uidPollId !== null) {
      clearInterval(uidPollId)
      uidPollId = null
    }
    uidObserver.disconnect()
    hsRemoveListeners()
  })
})()
