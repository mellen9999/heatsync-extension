// background part 7 of 11 — handleMessage — every message type the tabs send.
// build.js concatenates src/background/* in BG_PARTS order into background.js (the service worker cannot import);
// one scope, so a later part may read an earlier part's constants, never the reverse.

async function handleMessage(message, sender, sendResponse) {
  // YouTube chat relay — forward native-tap copies to every multichat host.
  // youtube-content.js scrapes the YT live_chat iframe and sends `channelId: videoId`.
  // Remap to the real extension channelId so the receiving tab can route — otherwise
  // messages bucket under a videoId key that no tab is listening on.
  // youtube.com tabs are included (minus the SENDER tab, whose overlay already
  // gets the same-tab copies directly) so a yt surface watching stream A still
  // sees stream B's chat when the server relay goes quiet — the DOM tap is the
  // yt resilience line, and innertube-id dedup drops the copies while the
  // relay is healthy.
  if (message.type === 'youtube_chat_message' && !message.source) {
    const vId = message.videoId
    // DOM tap is the second primary — its deliveries count the same as the
    // server relay for the innertube fallback tap's silence clock.
    if (vId) _ytTapLastDelivery.set(vId, Date.now())
    const senderTabId = sender?.tab?.id
    let mapped = ytChannelsFor(vId)
    if (!mapped.length && vId && vId === activeYoutubeVideoId) mapped = ['__live_yt_auto__']
    const relays = mapped.length
      ? mapped.map((cid) => (cid !== message.channelId ? { ...message, channelId: cid } : message))
      : [message]
    browser.tabs
      .query({ url: ['*://*.twitch.tv/*', '*://*.kick.com/*', '*://www.youtube.com/*'] })
      .then((tabs) => {
        for (const tab of tabs) {
          if (tab.id === senderTabId) continue
          for (const relay of relays) browser.tabs.sendMessage(tab.id, relay).catch(() => {})
        }
      })
      .catch(() => {})
    sendResponse({ ok: true })
    return true
  }

  // YouTube moderator deletion — relay to all extension tabs so they can dim
  if (message.type === 'youtube_msg_deleted') {
    const bound = ytChannelsFor(message.videoId)
    for (const channelId of bound.length ? bound : ['global']) {
      broadcastToTabs({
        type: 'youtube_msg_deleted',
        videoId: message.videoId,
        channelId,
        user: message.user,
        reason: message.reason || '',
      })
    }
    sendResponse({ ok: true })
    return true
  }

  // Link preview — proxy through heatsync.org server (avoids CORS)
  if (message.type === 'fetch_link_preview') {
    const url = message.url
    if (!url || !/^https?:\/\//i.test(url)) {
      sendResponse(null)
      return true
    }
    // Block internal/private URLs from being proxied through the server
    try {
      const parsed = new URL(url)
      // hostname keeps IPv6 brackets ([::1]) — strip so the v6 checks match
      const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase()
      if (
        /^(localhost|127\.|0\.|10\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(host) ||
        /^(::1$|::ffff:|fe[89ab][0-9a-f]:|f[cd][0-9a-f]{2}:)/.test(host) ||
        /^(\d+|0x[0-9a-f]+)$/.test(host)
      ) {
        sendResponse(null)
        return true
      }
    } catch {
      sendResponse(null)
      return true
    }
    fetch(`${LINK_PREVIEW_API}?url=${encodeURIComponent(url)}`, {
      signal: AbortSignal.timeout(6000),
      credentials: 'include',
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => sendResponse(data))
      .catch(() => sendResponse(null))
    return true
  }

  // Proxy recent-messages backfill through SW — cross-origin content-script
  // fetches trip Cloudflare bot heuristics (edge 503 before the origin ever
  // sees them); SW requests pass clean.
  // Kick's stylesheet text for kick-css-fix.js: the page can't read it
  // cross-origin and a content-script fetch is CORS-blocked, the worker is not.
  if (message.type === 'kick_css_text') {
    const url = String(message.url || '')
    if (!/^https:\/\/assets\.kick\.com\/[\w./%-]+\.css(\?[\w=&.%-]*)?$/.test(url)) {
      sendResponse(null)
      return true
    }
    fetch(url, { signal: AbortSignal.timeout(15000), credentials: 'omit' })
      .then((r) => (r.ok ? r.text() : null))
      .then((css) => sendResponse(css && css.length < 4e6 ? css : null))
      .catch(() => sendResponse(null))
    return true
  }

  if (message.type === 'fetch_recent_messages') {
    const ch = String(message.channel || '').toLowerCase()
    if (!/^[a-z0-9_]{1,25}$/.test(ch)) {
      sendResponse(null)
      return true
    }
    fetch(`https://heatsync.org/api/recent-messages/${ch}?limit=500`, {
      signal: AbortSignal.timeout(15000),
      credentials: 'omit',
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => sendResponse(data))
      .catch(() => sendResponse(null))
    return true
  }

  // Proxy /api/embed/resolve through SW — content-script fetches in MV3 still
  // get blocked by CORS even with host_permissions; SW bypasses it.
  // 1hr in-memory cache keyed by URL so re-renders (tab switch, scrollback)
  // don't re-hit the heatsync server. Cache cleared on SW restart, which is
  // fine — this is a UX cache, not correctness.
  if (message.type === 'fetch_embed_resolve') {
    const url = message.url
    if (!url || !/^https?:\/\//i.test(url)) {
      sendResponse(null)
      return true
    }
    const cached = _embedResolveCache.get(url)
    if (cached && Date.now() - cached.ts < EMBED_RESOLVE_TTL) {
      sendResponse(cached.data)
      return true
    }
    fetch(`https://heatsync.org/api/embed/resolve?url=${encodeURIComponent(url)}`, {
      signal: AbortSignal.timeout(6000),
      credentials: 'include',
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data) {
          _embedResolveCache.set(url, { data, ts: Date.now() })
          // LRU trim — Map iteration order is insertion order
          if (_embedResolveCache.size > 500) {
            const first = _embedResolveCache.keys().next().value
            _embedResolveCache.delete(first)
          }
        }
        sendResponse(data)
      })
      .catch(() => sendResponse(null))
    return true
  }

  // Channel banner — multi-platform (twitch/kick/youtube). All routes return
  // { bannerUrl, offlineUrl, accent, profileUrl } and respect a shared 12h LRU
  // keyed by `${platform}:${login}`. Banners rarely change so a stale URL is
  // tolerable; cache also survives SW wake (in-memory only by design — this is
  // pure UX-warming, not correctness state).
  if (message.type === 'fetch_channel_banner') {
    const platform = String(message.platform || '').toLowerCase()
    let username = String(message.username || '').toLowerCase()
    if (!platform || !username) {
      sendResponse(null)
      return true
    }
    // Sanitization differs per platform — Twitch is the strictest (a–z, 0–9,
    // underscore); Kick allows hyphens; YouTube handles and channel IDs allow
    // a-z, 0-9, dot, dash, underscore. Be conservative but permissive enough
    // to handle real names without false-negatives.
    if (platform === 'twitch') username = username.replace(/[^a-z0-9_]/g, '')
    else if (platform === 'kick') username = username.replace(/[^a-z0-9_-]/g, '')
    else if (platform === 'youtube') username = username.replace(/[^a-z0-9._-]/g, '')
    else {
      sendResponse(null)
      return true
    }
    if (!username) {
      sendResponse(null)
      return true
    }
    const cacheKey = `${platform}:${username}`
    const cached = _channelBannerCache.get(cacheKey)
    if (cached && Date.now() - cached.ts < CHANNEL_BANNER_TTL) {
      sendResponse(cached.data)
      return true
    }
    const handle = (data) => {
      _channelBannerCache.set(cacheKey, { data, ts: Date.now() })
      if (_channelBannerCache.size > CHANNEL_BANNER_MAX) {
        _channelBannerCache.delete(_channelBannerCache.keys().next().value)
      }
      sendResponse(data)
    }
    // A network blip / timeout / 5xx / 429 is NOT proof the channel has no
    // banner. Caching null here would blank the banner for 12h (CHANNEL_BANNER_TTL)
    // with no retry — same negative-cache-poisoning the cosmetics + sender-emote
    // fetches below explicitly guard against. Respond null (no banner this time)
    // but leave the cache empty so the next hover retries.
    const handleTransient = () => sendResponse(null)
    if (platform === 'twitch') {
      // Public GQL — kimne client id is the same one twitch.tv uses, no token
      // required for read-only profile fields.
      fetchWithTimeout(
        'https://gql.twitch.tv/gql',
        {
          method: 'POST',
          headers: { 'Client-Id': 'kimne78kx3ncx6brgo4mv6wki5h1ko', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: `{ user(login: "${username}") { bannerImageURL offlineImageURL primaryColorHex profileImageURL(width: 600) } }`,
          }),
        },
        5000,
      )
        .then(async (r) => {
          if (!r.ok) {
            // 404 = definitively no such channel (safe to cache the negative);
            // 5xx / 429 / anything else = transient, must not poison the cache.
            if (r.status === 404) handle(null)
            else handleTransient()
            return
          }
          const json = await r.json()
          const u = json?.data?.user
          if (!u) {
            handle(null)
            return
          }
          handle({
            bannerUrl: u.bannerImageURL || null,
            offlineUrl: u.offlineImageURL || null,
            accent: u.primaryColorHex ? `#${u.primaryColorHex.replace(/^#/, '')}` : null,
            profileUrl: u.profileImageURL || null,
            sourcePlatform: 'twitch',
          })
        })
        .catch(() => handleTransient())
      return true
    }
    if (platform === 'kick') {
      // Kick public v2 — channel slug → banner_image.url and user.profile_pic.
      // Kick provides no accent so we default to the platform brand green.
      fetchWithTimeout(
        `https://kick.com/api/v2/channels/${encodeURIComponent(username)}`,
        {
          headers: { Accept: 'application/json' },
        },
        5000,
      )
        .then(async (r) => {
          if (!r.ok) {
            if (r.status === 404) handle(null)
            else handleTransient()
            return
          }
          const j = await r.json()
          if (!j) {
            handle(null)
            return
          }
          const banner = j.banner_image?.url || j.banner_image?.responsive?.split(' ')[0] || null
          const offline = j.offline_banner_image?.src || j.offline_banner_image?.url || null
          handle({
            bannerUrl: banner,
            offlineUrl: offline,
            accent: '#53fc18',
            profileUrl: j.user?.profile_pic || null,
            sourcePlatform: 'kick',
          })
        })
        .catch(() => handleTransient())
      return true
    }
    if (platform === 'youtube') {
      // YouTube has no documented public banner API without OAuth/key, so we
      // fetch the channel page HTML and pull bannerExternalUrl out of the
      // embedded ytInitialData JSON. Works for both @handles and UC* channel
      // IDs because youtube.com routes both to the same page shape.
      const path = /^uc[a-z0-9_-]{20,}$/i.test(username) ? `/channel/${username}` : `/@${username}`
      fetchWithTimeout(
        `https://www.youtube.com${path}`,
        {
          headers: { Accept: 'text/html', 'Accept-Language': 'en' },
        },
        8000,
      )
        .then(async (r) => {
          if (!r.ok) {
            if (r.status === 404) handle(null)
            else handleTransient()
            return
          }
          const html = await r.text()
          if (!html) {
            handle(null)
            return
          }
          let banner = null
          // First match wins — bannerExternalUrl is the desktop hero banner;
          // banner.thumbnails[] (last entry = highest res) is the mobile path.
          const m1 = html.match(/"bannerExternalUrl":"([^"]+)"/)
          if (m1) banner = m1[1].replace(/\\u002F/g, '/').replace(/\\\//g, '/')
          if (!banner) {
            const all = [...html.matchAll(/"banner":\s*\{\s*"thumbnails":\s*\[([^\]]+)\]/g)]
            for (const m of all) {
              const last = [...m[1].matchAll(/"url":"([^"]+)"/g)].pop()
              if (last) {
                banner = last[1].replace(/\\u002F/g, '/').replace(/\\\//g, '/')
                break
              }
            }
          }
          let avatar = null
          const av = html.match(/"avatar":\s*\{\s*"thumbnails":\s*\[\s*\{\s*"url":"([^"]+)"/)
          if (av) avatar = av[1].replace(/\\u002F/g, '/').replace(/\\\//g, '/')
          if (!avatar) {
            const og = html.match(/<meta property="og:image" content="([^"]+)"/)
            if (og) avatar = og[1]
          }
          handle({
            bannerUrl: banner,
            offlineUrl: null,
            accent: '#ff0000', // doctrine: --hs-plat-youtube
            profileUrl: avatar,
            sourcePlatform: 'youtube',
          })
        })
        .catch(() => handleTransient())
      return true
    }
    sendResponse(null)
    return true
  }

  // Pronoun lookup — self-declared pronouns for a Twitch numeric user id, via
  // heatsync's first-party proxy (content-script fetches to heatsync.org trip
  // the edge, so this stays a BG fetch). Response: { pronouns: string[] } |
  // null. 24h LRU cache above absorbs repeat hovers. A `degraded` answer means
  // the proxy could not find out: an absent id then is NOT "has none", so it
  // is answered null without being remembered.
  if (message.type === 'fetch_pronouns') {
    const platform = String(message.platform || '').toLowerCase()
    const userId = String(message.userId || '').replace(/[^0-9]/g, '')
    if (platform !== 'twitch' || !userId) {
      sendResponse(null)
      return true
    }
    const cacheKey = `${platform}:${userId}`
    const cached = _pronounCache.get(cacheKey)
    if (cached && Date.now() - cached.ts < PRONOUN_TTL) {
      sendResponse(cached.data)
      return true
    }
    fetchWithTimeout(
      `${API_URL}/api/pronouns?platform=twitch&ids=${userId}`,
      { headers: { Accept: 'application/json' } },
      5000,
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        const words = json?.pronouns?.[userId]
        const data =
          Array.isArray(words) && words.length
            ? { pronouns: words.filter((w) => typeof w === 'string').slice(0, 3) }
            : null
        if (json && (data || json.degraded !== true)) {
          _pronounCache.set(cacheKey, { data, ts: Date.now() })
          if (_pronounCache.size > PRONOUN_CACHE_MAX) _pronounCache.delete(_pronounCache.keys().next().value)
        }
        sendResponse(data)
      })
      .catch(() => sendResponse(null))
    return true
  }

  // Chat-row name marks (src/multichat/name-marks-data.js): sub flair by twitch id, heat by login. Public
  // endpoints; this must stay a BG fetch (content-script fetches to heatsync.org trip the edge). The content
  // script validates and bounds every field of the answer, this only caps and shapes the ask.
  if (message.type === 'fetch_name_marks') {
    const flair = message.kind === 'flair'
    const ok = flair ? /^\d{1,20}$/ : /^[a-z0-9_]{1,25}$/
    const ids = Array.from(
      new Set((Array.isArray(message.ids) ? message.ids : []).filter((x) => typeof x === 'string' && ok.test(x))),
    ).slice(0, flair ? 50 : 25)
    if (!ids.length || (message.kind !== 'flair' && message.kind !== 'heat')) {
      sendResponse({ ok: false })
      return true
    }
    ;(flair
      ? fetchWithTimeout(`${API_URL}/api/users/flair?ids=${ids.join(',')}`, {}, 10000)
      : fetchWithTimeout(
          `${API_URL}/api/users/heat`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usernames: ids }) },
          10000,
        )
    )
      .then(async (r) => {
        if (!r.ok) {
          r.body?.cancel?.()
          return sendResponse({ ok: false })
        }
        const body = await r.json().catch(() => null)
        sendResponse(body && typeof body === 'object' ? { ok: true, body } : { ok: false })
      })
      .catch(() => sendResponse({ ok: false }))
    return true
  }

  // Query all open Twitch/Kick tabs to find channels the user is watching
  if (message.type === 'get_watching_channels') {
    const skip = RESERVED_PATHS
    browser.tabs
      .query({ url: ['*://*.twitch.tv/*', '*://kick.com/*', '*://*.kick.com/*', '*://*.youtube.com/*'] })
      .then(async (tabs) => {
        const channels = []
        const seen = new Set()
        const ytPending = [] // {idx, videoId} — needs oEmbed lookup to resolve handle
        for (const tab of tabs) {
          try {
            const url = new URL(tab.url)
            let match
            if (url.hostname.includes('twitch.tv')) {
              match = url.pathname.match(/^\/(?:popout\/)?([a-zA-Z0-9_]+)/)
            } else if (url.hostname.includes('kick.com')) {
              match = url.pathname.match(/^\/(popout|embed)\/([a-zA-Z0-9_-]+)/)
              if (match)
                match = [null, match[2]] // normalize to [_, channel]
              else match = url.pathname.match(/^\/([a-zA-Z0-9_-]+)/)
            } else if (url.hostname.includes('youtube.com')) {
              // Only count tabs on a live stream URL — handle, /live/<id>, or /watch?v=<id>.
              const v = url.searchParams.get('v')
              const liveHandleMatch = url.pathname.match(/^\/@([^/]+)\/live/)
              const liveIdMatch = url.pathname.match(/^\/live\/([^/?]+)/)
              if (liveHandleMatch) {
                const handle = liveHandleMatch[1]
                const key = `yt:${handle.toLowerCase()}`
                if (!seen.has(key)) {
                  seen.add(key)
                  channels.push({
                    name: handle,
                    platform: 'youtube',
                    youtubeUrl: `https://www.youtube.com/@${handle}/live`,
                  })
                }
              } else if (liveIdMatch || (v && url.pathname === '/watch')) {
                const videoId = liveIdMatch ? liveIdMatch[1] : v
                const ytUrl = liveIdMatch
                  ? `https://www.youtube.com/live/${videoId}`
                  : `https://www.youtube.com/watch?v=${videoId}`
                const idx = channels.length
                // Placeholder — name will be resolved to channel handle via oEmbed below.
                channels.push({ name: videoId, platform: 'youtube', youtubeUrl: ytUrl, _videoId: videoId })
                ytPending.push({ idx, videoId })
              }
              continue
            }
            if (match?.[1]) {
              const ch = match[1].toLowerCase()
              if (!skip.has(ch) && ch !== 'popout' && ch !== 'embed' && !seen.has(ch)) {
                seen.add(ch)
                channels.push({ name: ch, platform: url.hostname.includes('kick') ? 'kick' : 'twitch' })
              }
            }
          } catch (_e) {}
        }

        // Resolve YT handles via oEmbed — public, no auth, CORS-friendly.
        if (ytPending.length) {
          await Promise.all(
            ytPending.map(async (p) => {
              const handle = await getYtChannelHandle(p.videoId)
              if (!handle) return
              const key = `yt:${handle.toLowerCase()}`
              if (seen.has(key)) {
                channels[p.idx] = null // duplicate — prefer the existing entry
              } else {
                seen.add(key)
                channels[p.idx].name = handle
                delete channels[p.idx]._videoId
              }
            }),
          )
          for (let i = channels.length - 1; i >= 0; i--) {
            if (channels[i] === null) channels.splice(i, 1)
          }
        }

        sendResponse({ channels })
      })
      .catch(() => sendResponse({ channels: [] }))
    return true
  }

  // Proxy fetch for live status (avoids CORS in content script)
  // "fill my cockpit" — the user's twitch follow list, so a fresh install does
  // not have to type in every channel it wants by hand. The three error shapes
  // are kept distinct all the way to the UI: an empty cockpit, a logged-out
  // session and a dead twitch link need three different sentences, and
  // flattening them is how you tell someone to re-authorise a working account.
  if (message.type === 'get_twitch_followed_channels') {
    ;(async () => {
      try {
        const authToken = await getAuthCookie()
        if (!authToken) {
          sendResponse({ error: 'login_required' })
          return
        }
        const r = await fetch(`${API_URL}/api/twitch/followed-channels`, {
          headers: { Authorization: `Bearer ${authToken}` },
          signal: AbortSignal.timeout(15000),
        })
        const data = await r.json().catch(() => null)
        if (!r.ok) {
          sendResponse({
            error: data?.error || (r.status === 401 ? 'login_required' : 'twitch_unavailable'),
            // 'scope' (link works, never included follows) vs 'expired' (token
            // dead) — the cockpit says a different sentence for each.
            reason: data?.reason || undefined,
          })
          return
        }
        sendResponse(data)
      } catch {
        sendResponse({ error: 'twitch_unavailable' })
      }
    })()
    return true // async sendResponse
  }

  // Kick follows for the cockpit import: kick only answers a browser holding the
  // session_token cookie, so this runs here (same read the follow mirror uses).
  if (message.type === 'get_kick_followed_channels') {
    ;(async () => {
      try {
        const session = await browser.cookies.get({ url: 'https://kick.com', name: 'session_token' })
        const token = session?.value ? decodeURIComponent(session.value) : null
        if (!token) {
          sendResponse({ channels: [] })
          return
        }
        const slugs = await kickFollowedSlugs(token)
        sendResponse({ channels: slugs.map((login) => ({ login: login.toLowerCase() })) })
      } catch {
        sendResponse({ channels: [] })
      }
    })()
    return true // async sendResponse
  }

  if (message.type === 'fetch_live_status') {
    const channels = message.channels || []
    const kickChannels = message.kickChannels || []
    if (!channels.length && !kickChannels.length) {
      sendResponse(null)
      return true
    }
    const params = []
    if (channels.length) params.push(`channels=${encodeURIComponent(channels.join(','))}`)
    if (kickChannels.length) params.push(`kick_channels=${encodeURIComponent(kickChannels.join(','))}`)
    fetch(`https://heatsync.org/api/platform/live-status?${params.join('&')}`, { signal: AbortSignal.timeout(6000) })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => sendResponse(data))
      .catch(() => sendResponse(null))
    return true // async sendResponse
  }

  // Auth state probe — multichat content script asks for current state on init
  // so it can show the login banner immediately on a tab opened after the
  // auth_changed broadcast already fired.
  if (message.type === 'get_auth_state') {
    // Lazy-fetch the auth cookie if memory cache is empty.
    // cookies.onChanged only fires on cookie mutations — if the user logged in
    // before the extension started watching, the listener never ran and
    // chrome.storage.local stays empty until any feature calls getAuthCookie().
    // Multichat content scripts ask for auth state at startup; honor that by
    // proactively reading the cookie here and storing the token.
    if (!authToken && !authFailedBlock) {
      getAuthCookie()
        .then((t) => {
          sendResponse({ loggedIn: !!t && !authFailedBlock })
        })
        .catch(() => sendResponse({ loggedIn: false }))
      return true
    }
    sendResponse({ loggedIn: !!authToken && !authFailedBlock })
    return true
  }

  // YouTube subscribe via WS server — from multichat content script
  if (message.type === 'youtube_ws_subscribe') {
    const url = message.url
    const channelId = message.channelId || 'global'
    log('[hs-bg] youtube_ws_subscribe received:', { url, channelId, socketOpen: isSocketOpen() })
    if (url && /^https:\/\/(www\.)?youtube\.com\//i.test(url)) {
      // Extract videoId from URL for routing (always, even if socket is down)
      const vidMatch = url.match(/[?&]v=([^&]+)/) || url.match(/\/live\/([^?&/]+)/) || url.match(/youtu\.be\/([^?&]+)/)
      if (vidMatch) {
        setYtVideoChannel(vidMatch[1], channelId)
        ytTapMarkWanted(vidMatch[1])
      } else {
        // No videoId in URL — server resolves it. Track for status-fallback attribution.
        pendingYtSubscribes.push({ channelId, url, ts: Date.now() })
        if (pendingYtSubscribes.length > 20) pendingYtSubscribes.shift()
      }
      // wsSend handles both immediate send and queue-on-reconnect; previous
      // gating let subscribes silently drop when the socket was closing.
      log('[hs-bg] youtube:subscribe (open?', isSocketOpen(), '):', { url, channelId })
      wsSend({ type: 'youtube:subscribe', url, channelId })
      // Always persist for reconnect (even if socket is currently down)
      if (channelId === 'global') {
        browser.storage.local.set({ youtube_url: url })
      } else {
        youtubeChannelUrls[channelId] = url
        const ytUrlKeys = Object.keys(youtubeChannelUrls)
        if (ytUrlKeys.length > 50) {
          delete youtubeChannelUrls[ytUrlKeys[0]]
        }
        // __live_yt_auto__ is an EPHEMERAL binding to whatever stream is open
        // right now. Persisting it resurrects a stale stream's YT chat on the
        // next SW wake — e.g. an @<name>/live guess for a focused tab bleeds
        // into an unrelated channel forever. Keep it in memory for mid-session
        // reconnects, but never write it to storage; the content script re-binds
        // it per page from the current channel's explicit YT link.
        const { __live_yt_auto__: _omitAuto, ...persistUrls } = youtubeChannelUrls
        browser.storage.local.set({ youtube_channel_urls: persistUrls })
      }
      log(' YouTube subscribe:', url, 'channel:', channelId, isSocketOpen() ? '' : '(queued for reconnect)')
      // Fire-and-forget real-history backfill — _ytRecentFetched gates this to
      // once per channelId per SW lifetime (this handler re-fires on every
      // reconnect/reload, unlike kick's join-gated _kpChannels check). After
      // the fetch settles (or the one-shot no-ops), replay the buffer to the
      // SUBSCRIBING tab so surfaces that boot after the one-shot still get
      // history without a hard refresh.
      const ytSubTabId = sender?.tab?.id
      bgYtFetchRecentArchive(channelId, url)
        .catch(() => {})
        .then(() => bgYtReplayToTab(ytSubTabId, channelId))
        .catch(() => {})
    }
    sendResponse({ ok: true })
    return
  }

  // YouTube unsubscribe
  if (message.type === 'youtube_ws_unsubscribe') {
    const channelId = message.channelId || 'global'
    // Try videoId from message first, then extract from stored URL
    let videoId = message.videoId
    if (!videoId && message.url) {
      const vidMatch =
        message.url.match(/[?&]v=([^&]+)/) ||
        message.url.match(/\/live\/([^?&/]+)/) ||
        message.url.match(/youtu\.be\/([^?&]+)/)
      if (vidMatch) videoId = vidMatch[1]
    }
    if (videoId) {
      deleteYtVideoChannel(videoId, channelId)
      // Only tear down the server poller (and the tap's wantedness) when no
      // other channel is still bound to this video — the same stream can
      // back multiple bindings.
      if (!ytVideoToChannel.has(videoId)) {
        ytTapUnmarkWanted(videoId)
        if (isSocketOpen()) wsSend({ type: 'youtube:unsubscribe', videoId })
      }
      if (activeYoutubeVideoId === videoId) activeYoutubeVideoId = null
    }
    // Clean up storage
    if (channelId === 'global') {
      browser.storage.local.remove(['youtube_url'])
    } else {
      delete youtubeChannelUrls[channelId]
      browser.storage.local.set({ youtube_channel_urls: { ...youtubeChannelUrls } })
      // Channel removed from config — drop its persisted history buffer too,
      // else hs_yt_<channelId> storage entries accumulate forever across every
      // channel the user has ever added and removed (BG_YT only caps total
      // channel COUNT, it never ages one out on removal).
      BG_YT.channels.delete(channelId)
      browser.storage.local.remove(`hs_yt_${channelId}`).catch(() => {})
    }
    log(' YouTube unsubscribe:', videoId || '(no videoId)', 'channel:', channelId)
    sendResponse({ ok: true })
    return
  }

  // Content-script escalation: a per-channel watchdog has decided the BG WS
  // is in zombie state. Close the socket and let scheduleReconnect fire a
  // fresh connection, which replays joins from joinedExtraChannels.
  if (message.type === 'ws_force_reconnect') {
    log(' 🚨 ws_force_reconnect requested:', message.source, message.channel || '')
    if (socket) {
      try {
        socket.onclose = null
        socket.close()
      } catch {}
    }
    wsState = WS_STATE.DISCONNECTED
    isAuthenticated = false
    reconnectAttempts = 0
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (heartbeatInterval) {
      untrackInterval(heartbeatInterval)
      heartbeatInterval = null
    }
    connectWebSocket().catch((err) => log(' force-reconnect failed:', err?.message))
    sendResponse({ ok: true })
    return
  }

  // Forward WS message from content scripts (used by multichat kick channels)
  if (message.type === 'ws_send') {
    const allowedWsTypes = [
      'channel:join',
      'channel:leave',
      'emote:used',
      'youtube:subscribe',
      'youtube:unsubscribe',
      'multichat:sync',
      'ui-state:sync',
      'twitch:chat:relay',
    ]
    if (message.data && allowedWsTypes.includes(message.data.type)) {
      // Track multichat-added channel joins so we can replay on WS reconnect
      // (server restarts, network blips, SW resume — any of these orphan the join).
      if (message.data.type === 'channel:join' && message.data.platform && message.data.channel) {
        const key = `${message.data.platform}/${message.data.channel.toLowerCase()}`
        if (isGhostChannelKey(key)) {
          sendResponse?.({ ok: false, error: 'reserved path' })
          return true
        }
        if (!joinedExtraChannels.has(key)) {
          joinedExtraChannels.add(key)
          saveJoinedExtraChannels()
        }
        // Multichat extra channels get their emote sets HERE — this join is the
        // only signal BG ever receives for them (content-side join_channel only
        // fires for the page channel; the SW-boot refetch loop only covers
        // channels known at boot). TTL-gating inside fetchChannelOwnerEmotes
        // makes repeat joins cheap, and it re-broadcasts the cache immediately.
        try {
          fetchChannelOwnerEmotes(message.data.channel.toLowerCase(), null, message.data.platform.toLowerCase()).catch(
            () => {},
          )
        } catch {}
        // Kick: pull deep archive from postgres alongside the server's 200-msg
        // ring backfill. Internal cooldown prevents duplicate fetches on
        // rapid switches.
        if (message.data.platform.toLowerCase() === 'kick') {
          try {
            bgKickFetchArchive(message.data.channel.toLowerCase()).catch(() => {})
          } catch {}
          try {
            kickPusherJoin(message.data.channel.toLowerCase())
          } catch {}
        }
      } else if (message.data.type === 'channel:leave' && message.data.platform && message.data.channel) {
        const key = `${message.data.platform}/${message.data.channel.toLowerCase()}`
        if (joinedExtraChannels.delete(key)) saveJoinedExtraChannels()
        if (message.data.platform.toLowerCase() === 'kick') {
          const kch = message.data.channel.toLowerCase()
          try {
            kickPusherLeave(kch)
          } catch {}
          // Channel removed from config — drop its persisted history buffer too,
          // else hs_kick_<ch> storage entries accumulate forever across every
          // channel the user has ever added and removed (BG_KICK only caps total
          // channel COUNT, it never ages one out on removal).
          BG_KICK.channels.delete(kch)
          browser.storage.local.remove(`hs_kick_${kch}`).catch(() => {})
        }
      }
      wsSend(message.data)
    }
    sendResponse({ ok: true })
    return
  }

  if (message.type === 'set_auth_token') {
    // Async: verify state nonce + confirm token via /api/auth/me before touching caches
    ;(async () => {
      try {
        // State nonce check (defense against identity fixation)
        const stored = await browser.storage.local.get('hs_login_state')
        const storedState = stored?.hs_login_state
        if (storedState) {
          // One-time: always consume regardless of match
          await browser.storage.local.remove('hs_login_state')
          // A pending login (storedState present) means THIS extension opened
          // the flow with ext_state=nonce (see heatsync-button.js), and the
          // backend echoes it back — so a legit callback ALWAYS carries a
          // matching state. Require it: reject a MISSING or mismatched state.
          // Closes the window where an attacker's crafted heatsync.org/?auth_token=
          // link (no / forged ext_state) lands while a login is pending.
          // (A token arriving with NO pending login is still accepted after the
          // /api/auth/me check below; fully closing that needs every login entry
          // point to seed a nonce — tracked separately.)
          if (message.state !== storedState) {
            log(' ⚠ set_auth_token rejected — missing or mismatched state nonce')
            sendResponse({ ok: false, error: 'state mismatch' })
            return
          }
        }
        // Verify token against /api/auth/me before wiping any caches
        const verifyResp = await fetchWithTimeout(`${API_URL}/api/auth/me`, {
          credentials: 'include',
          headers: { Authorization: `Bearer ${message.token}` },
        })
        if (!verifyResp.ok) {
          verifyResp.body?.cancel()
          log(' ⚠ set_auth_token rejected — /api/auth/me returned', verifyResp.status)
          sendResponse({ ok: false, error: 'token verification failed' })
          return
        }
        let meUser
        try {
          meUser = JSON.parse(await verifyResp.text())
        } catch {
          meUser = null
        }
        if (!meUser) {
          log(' ⚠ set_auth_token rejected — invalid /api/auth/me response')
          sendResponse({ ok: false, error: 'invalid auth response' })
          return
        }
        const newUsername = (meUser.username || meUser.twitch_username || '').toLowerCase()
        // Notify on identity switch so user is aware
        if (currentUsername && newUsername && newUsername !== currentUsername.toLowerCase()) {
          log(` set_auth_token: account switch ${currentUsername} → ${newUsername}`)
          try {
            chrome.notifications.create(`hs-account-switch-${Date.now()}`, {
              type: 'basic',
              iconUrl: 'icon-48.png',
              title: bgT('bg_acct_title'),
              message: bgT('bg_acct_msg', [currentUsername, newUsername]),
            })
          } catch {}
        }
        // Token verified — adopt it and refresh caches
        authToken = message.token
        authFailedBlock = false
        log(' Received and verified auth token from content script')
        emoteInventory = []
        blockedEmotes = new Set()
        followedUsers = []
        browser.storage.local.remove(['emote_inventory', 'blocked_emotes'])
        storeToken(message.token).catch((err) => log('storeToken failed:', err?.message))
        fetchEmoteInventory().catch(() => {})
        fetchBlockedEmotes().catch(() => {})
        fetchFollowedUsers().catch(() => {})
        log(' 🔄 Reconnecting WebSocket with new auth token...')
        connectWebSocket().catch(() => {})
        sendResponse({ ok: true })
      } catch (err) {
        log(' set_auth_token error:', err?.message || err)
        sendResponse({ ok: false, error: err?.message || 'unknown error' })
      }
    })()
    return true // async sendResponse
  } else if (message.type === 'block_emote') {
    // Async - send response when done
    blockEmote(message.hash).then((result) => {
      sendResponse(result)
    })
    return true // Keep channel open for async response
  } else if (message.type === 'unblock_emote') {
    // Async - send response when done
    unblockEmote(message.hash).then((result) => {
      sendResponse(result)
    })
    return true // Keep channel open for async response
  } else if (message.type === 'add_to_inventory') {
    // Async - send response when done
    addToInventory(
      message.emoteName,
      message.emoteHash,
      message.emoteUrl,
      message.zeroWidth,
      message.replace === true,
      message.upload
        ? {
            source: 'upload',
            quiet: true,
            phash: message.upload.phash,
            width: message.upload.width,
            height: message.upload.height,
          }
        : {},
    ).then((result) => {
      // A fresh upload is only usable once the content scripts hold the server's
      // row for it (size, smaller copies): refetch now rather than wait out the throttle.
      if (message.upload && result?.success) {
        lastInventoryFetch = 0
        fetchEmoteInventory().catch(() => {})
      }
      sendResponse(result)
    })
    return true // Keep channel open for async response
  } else if (message.type === 'remove_from_inventory') {
    // Async - send response when done
    removeFromInventory(message.emoteHash, message.emoteName).then((result) => {
      sendResponse(result)
    })
    return true // Keep channel open for async response
  } else if (message.type === 'mute_user') {
    const expiresAt = message.expiresAt || null
    mutedUsers.set(message.username, expiresAt)
    persistMutedUsers()
    broadcastToTabs({ type: 'user_muted', username: message.username, expiresAt })
    // Sync to server via REST /api/mutes — writes to user_mutes table and
    // broadcasts mute:added WS event so heatsync.org tabs + other ext sockets
    // pick up the mute instantly. Replaces the old `user:mute` WS path which
    // wrote to user_blocks (different table, never read by chat-mute UI).
    syncMuteToServer(message.username, expiresAt).catch((err) => log(' syncMuteToServer failed:', err?.message))
    log(' Muted user:', message.username, expiresAt ? `(expires ${new Date(expiresAt).toISOString()})` : '(permanent)')
    sendResponse({ ok: true })
  } else if (message.type === 'unmute_user') {
    mutedUsers.delete(message.username)
    persistMutedUsers()
    broadcastToTabs({ type: 'user_unmuted', username: message.username })
    // Sync to server via REST DELETE /api/mutes/:username — broadcasts
    // mute:removed WS event for cross-device + cross-surface unmute.
    syncUnmuteToServer(message.username).catch((err) => log(' syncUnmuteToServer failed:', err?.message))
    log(' Unmuted user:', message.username)
    sendResponse({ ok: true })
  } else if (message.type === 'block_user') {
    blockedUsers.add(message.username)
    persistBlockedUsers()
    broadcastToTabs({ type: 'user_blocked', username: message.username })
    log(' Blocked user:', message.username)
    sendResponse({ ok: true })
  } else if (message.type === 'unblock_user') {
    blockedUsers.delete(message.username)
    persistBlockedUsers()
    broadcastToTabs({ type: 'user_unblocked', username: message.username })
    log(' Unblocked user:', message.username)
    sendResponse({ ok: true })
  } else if (message.type === 'twitch_auth_status') {
    // Is there a twitch login, and whose. The cookie's value stays here.
    if (!twitchSessionSenderOk(sender)) {
      sendResponse({ loggedIn: false, username: null, error: 'unauthorized sender' })
      return true
    }
    readTwitchSession()
      .then(({ token, username }) => sendResponse({ loggedIn: !!token, username }))
      .catch(() => sendResponse({ loggedIn: false, username: null }))
    return true
  } else if (message.type === 'twitch_helix') {
    // A named helix call made from here, so the twitch token never reaches a
    // content script for it (see TWITCH SESSION in 02-auth-live.js).
    if (!twitchSessionSenderOk(sender)) {
      sendResponse({ ok: false, error: 'unauthorized sender' })
      return true
    }
    twitchHelix(String(message.op || ''), message.args || {})
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: e?.message || 'helix failed' }))
    return true
  } else if (message.type === 'get_twitch_auth_token') {
    // The raw twitch login, for ONE job: the authed chat socket on a kick or
    // youtube page, which has to send `PASS oauth:<token>` from the page's own
    // WebSocket. Handed only to the overlay's top frame on a twitch / kick /
    // youtube tab; heatsync.org, subframes, the popup and anything outside the
    // extension get nothing. Presence checks use twitch_auth_status and helix
    // lookups use twitch_helix, so they never see the value.
    if (!twitchSessionSenderOk(sender)) {
      sendResponse({ token: null, username: null, error: 'unauthorized sender' })
      return true
    }
    readTwitchSession()
      .then((session) => sendResponse(session))
      .catch(() => sendResponse({ token: null, username: null }))
    return true
  } else if (message.type === 'get_inventory') {
    // Async - wait for init to complete first
    ;(async () => {
      if (initPromise) {
        await initPromise
      }
      log(
        ' Background: get_inventory request - responding with',
        emoteInventory.length,
        'personal,',
        globalEmotes.length,
        'global',
      )
      // Merged set — picker needs to surface BOTH server and local blocks so
      // anon-era hashes (now lingering in localBlockedEmotes after login) can
      // still be unblocked from the UI. unblockEmote handles either layer.
      sendResponse({
        emotes: emoteInventory,
        globalEmotes: globalEmotes,
        blocked: Array.from(new Set([...blockedEmotes, ...localBlockedEmotes])),
      })
    })()
    return true // Keep channel open for async response
  } else if (message.type === 'get_followed_users') {
    sendResponse({
      users: followedUsers,
    })
    return true
  } else if (message.type === 'get_live_followed') {
    // Cached snapshot from background poll — popup/content can read instantly
    sendResponse({
      snapshot: _liveFollowedSnapshot,
      count: _liveFollowedCount,
    })
    return true
  } else if (message.type === 'refresh_followed_users') {
    // Triggered after a follow/unfollow action elsewhere — re-fetches the
    // canonical list from server and re-runs live poll so badge/notifications
    // reflect the change immediately.
    fetchFollowedUsers().catch(() => {})
    sendResponse({ ok: true })
    return true
  } else if (message.type === 'feed_thread') {
    // The tab's open thread changed: one room at a time per tab, null leaves.
    const room = typeof message.room === 'string' ? message.room.toLowerCase() : null
    if (sender.tab?.id != null && (room === null || FEED_THREAD_ROOM_RE.test(room))) feedThreadSet(sender.tab.id, room)
    sendResponse({ ok: true })
    return true
  } else if (message.type === 'join_channel') {
    // Content script detected channel change — wait for init so cached channel emotes are available
    // Defence in depth: validate platform + channel before forwarding to WS server
    const VALID_PLATFORMS = new Set(['twitch', 'kick', 'youtube'])
    const safePlatform = VALID_PLATFORMS.has(message.platform) ? message.platform : null
    // YouTube handles can contain periods (e.g. "@mr.beast") — allow them so the
    // sanitized key still matches what the content script reads back via
    // getCurrentChannel() (which doesn't strip periods). Twitch/Kick names never
    // contain periods, so this is a no-op for those platforms.
    const safeChannel = String(message.channel || '')
      .toLowerCase()
      .replace(/[^a-z0-9_.-]/g, '')
      .slice(0, 50)
    if (!safePlatform || !safeChannel) {
      sendResponse({ received: false, error: 'invalid platform/channel' })
      return true
    }
    log(' 📺 Content script requesting channel join:', safePlatform, '/', safeChannel, 'id:', message.channelId)
    ;(async () => {
      // sendResponse must run on every path: if initPromise rejects (WS
      // constructor throw, 10s connect timeout, offline) the rejection used
      // to escape this IIFE and the message port just hung, leaving the
      // caller's callback waiting forever. joinChannel is intentionally not
      // awaited, but it IS async — catch it too so a failed join doesn't
      // surface as an unhandled rejection.
      try {
        if (initPromise) await initPromise
      } catch (e) {
        log(' 📺 join_channel: init failed, joining anyway:', e?.message || e)
      }
      try {
        const p = joinChannel(safePlatform, safeChannel, message.channelId, sender.tab?.id)
        if (p && typeof p.catch === 'function') p.catch(() => {})
      } catch (_) {}
      sendResponse({ received: true })
    })()
    return true // Keep channel open for async response
  } else if (message.type === 'yt_ensure_channel_emotes') {
    // Native yt live_chat surface (youtube-content.js). join_channel only
    // fires for channels added to the multichat overlay, so a viewer just
    // watching youtube.com never loaded the streamer's 7TV/BTTV set. Resolve
    // videoId → UC id and fetch; the channel_emotes_update broadcast feeds
    // the iframe's listener. Deliberately NOT joinChannel(): no tabChannels
    // write (would clobber the overlay's primary-channel tracking for the
    // tab) and no WS room join.
    // Channel key: the iframe's ?v= when present (popout chat), else derive
    // from the sender tab's URL — embedded watch-page chat iframes only carry
    // ?continuation=, so the top frame's watch?v=/@handle is the identity.
    // sender.tab.url is browser-provided (not page-controlled).
    const ytVid = String(message.videoId || '')
    const ytTabUrl = String(sender?.tab?.url || '')
    const ytChanKey = /^[\w-]{11}$/.test(ytVid)
      ? ytVid
      : (ytTabUrl.match(/[?&]v=([\w-]{11})/)?.[1] ??
        (ytTabUrl.match(/youtube\.com\/@([\w.-]{3,30})/)
          ? `@${ytTabUrl.match(/youtube\.com\/@([\w.-]{3,30})/)[1]}`
          : null))
    if (ytChanKey) {
      ;(async () => {
        if (initPromise) await initPromise
        fetchChannelOwnerEmotes(ytChanKey, null, 'youtube').catch(() => {})
      })()
      // channelKey tells the iframe which broadcast owner is its own (see youtube-content.js)
      sendResponse({ received: true, channelKey: ytChanKey })
    } else {
      sendResponse({ received: false, error: 'no channel identity' })
    }
    return true
  } else if (message.type === 'update_channel_id') {
    // Content script late-discovered the Twitch channel ID via early-inject MAIN-world.
    // Cache it so subsequent fetches skip the GQL roundtrip; if current fetch is in flight
    // without an ID, it stays in flight (we don't abort) but emote map will refresh on next nav.
    if (message.channel && message.channelId) {
      const ch = message.channel.toLowerCase()
      twitchIdCache.set(ch, String(message.channelId))
      log(' 📺 Late channel ID cached:', ch, '→', message.channelId)
    }
    sendResponse({ ok: true })
    return true
  } else if (message.type === 'emote_sent') {
    // Content script detected user sent emote
    log(' 💬 Content script detected emote sent:', message.emoteName)
    const result = broadcastEmoteUsage(message.emoteName, message.emoteHash, sender.tab?.id)
    log(' 📤 Broadcast result:', result)
    sendResponse(result || { success: false, reason: 'unknown' })
    return true // Keep channel open for response
  } else if (message.type === 'get_channel_emotes') {
    // Multichat/content requesting channel emotes (may have missed the broadcast).
    // Await init like get_picker_emotes/get_inventory beside it — a cold SW
    // must finish restoring channel_emotes_map before we count/broadcast, else
    // we return count:0 and the client's retry just spins. Async → return true.
    ;(async () => {
      if (initPromise) await initPromise
      // Self-heal: any joined channel with no cache entry (evicted, wiped by a
      // past failed refetch, never fetched) gets a fetch kicked off NOW — the
      // result arrives via the progressive channel_emotes_update broadcasts.
      // Without this, a missing channel stayed missing for the whole session:
      // this handler only ever REPORTED the cache, and nothing else re-fetched.
      try {
        const wanted = new Set(joinedExtraChannels)
        for (const t of tabChannels.values()) {
          // tabChannels .channel is already a "platform/name" key (joinChannel)
          if (t?.channel?.includes('/')) wanted.add(t.channel.toLowerCase())
        }
        for (const k of wanted) {
          const state = channelEmotesMap[k]
          if (!Array.isArray(state) && state !== 'loading') {
            const { platform, channel } = splitChKey(k)
            if (channel) fetchChannelOwnerEmotes(channel, null, platform).catch(() => {})
          }
        }
      } catch {}
      const totalEmotes = Object.values(channelEmotesMap).reduce((sum, e) => sum + (Array.isArray(e) ? e.length : 0), 0)
      if (totalEmotes > 0) {
        browser.storage.local.set({
          channel_emotes_map: getStorableChannelEmotes(),
          channel_emotes_fetched_at: channelEmotesFetchedAt,
        })
        for (const [k, emotes] of Object.entries(channelEmotesMap)) {
          if (Array.isArray(emotes)) {
            const { platform, channel } = splitChKey(k)
            broadcastToTabs({ type: 'channel_emotes_update', emotes, channelOwner: channel, platform })
          }
        }
      }
      sendResponse({ count: totalEmotes })
    })()
    return true
  } else if (message.type === 'get_picker_emotes') {
    // Return immediately with whatever's cached. If channel emotes aren't
    // ready, trigger the fetch but DON'T poll-wait — fetchChannelOwnerEmotes
    // broadcasts channel_emotes_update progressively as each provider
    // (BTTV/FFZ/7TV/Twitch) lands, and the picker listens for that broadcast.
    // The old 8s poll-wait gated the entire panel render on the slowest
    // third-party API.
    ;(async () => {
      if (initPromise) await initPromise
      const channel = message.channel?.toLowerCase()
      const pickerPlatform = message.platform || (sender?.url?.includes('kick.com') ? 'kick' : 'twitch')
      const chState = channel ? channelEmotesMap[chKey(pickerPlatform, channel)] : null
      const chEmotes = Array.isArray(chState) ? chState : null
      if (channel && !chEmotes && chState !== 'loading') {
        // Fire-and-forget: result will arrive via channel_emotes_update broadcast
        fetchChannelOwnerEmotes(channel, null, pickerPlatform)
      }
      // channelLoading lets the picker keep showing "loading…" instead of
      // "no emotes" while the third-party fetch is still in flight.
      const channelLoading = !!channel && !chEmotes
      sendResponse({
        channelEmotes: chEmotes || [],
        channelLoading,
        globalEmotes: globalEmotes,
        inventoryEmotes: emoteInventory,
        blocked: Array.from(new Set([...blockedEmotes, ...localBlockedEmotes])),
      })
    })()
    return true
  } else if (message.type === 'refresh_all') {
    // Refresh all emotes — called from popup AND from the NSFW toggle
    // click path (chat needs to repaint with the new filter without
    // waiting for the 5min sender-emote LRU TTL). Clear sender cache
    // here so cross-user emote sets re-fetch fresh on next message.
    try {
      if (globalThis.__senderEmoteCache?.clear) globalThis.__senderEmoteCache.clear()
    } catch {}
    ;(async () => {
      await Promise.all([
        fetchGlobalEmotes(),
        fetchEmoteInventory(),
        fetchBlockedEmotes(),
        fetchUserInfo(),
        fetchViewerSettings(),
      ])
      sendResponse({ success: true })
    })()
    return true
  } else if (message.type === 'notifs_read') {
    markNotifsRead()
  } else if (message.type === 'notifs_viewed') {
    unreadNotifCount = 0
    browser.storage.session?.set({ unread_notif_count: 0 }).catch(() => {})
    updateExtensionBadge()
  } else if (message.type === 'get_follow_history') {
    // Content scripts request cached follow history (handles race condition on load)
    sendResponse({
      history: cachedFollowHistory,
      colors: cachedFollowColors,
    })
    return true // Required for Firefox — sendResponse ignored without this
  } else if (message.type === 'focus_channel_tab') {
    // multichat's went-live toast was clicked: same landing as the system one
    const url = channelPageUrl(message.platform, message.channel, true)
    if (url) focusOrOpenTab(url)
    sendResponse({ ok: !!url })
    return true
  } else if (message.type === 'get_roomstate') {
    // Return cached IRC ROOMSTATE for a channel (modes from the JOIN tag set).
    // Available as soon as the SW's IRC connection has joined the channel —
    // works from any host (Twitch/Kick/YT) because IRC is shared.
    const ch = (message.channel || '').toString().toLowerCase()
    if (!ch) {
      sendResponse({ ok: false, error: 'no channel' })
      return true
    }
    const state = BG_IRC?.roomstates?.get(ch) || null
    sendResponse({ ok: true, state })
    return true
  } else if (message.type === 'twitch_gql_authed') {
    // Cross-platform Twitch GQL: queries authenticated with the twitch.tv
    // auth-token cookie, so content scripts on Kick/YouTube can read mod
    // state and other authed data without a Twitch tab being open.
    // Mutations that need Client-Integrity should go through twitch_relay
    // instead (relays through a live Twitch tab).
    // Runs the caller's query as the twitch login, so only the overlay's top
    // frame on a twitch / kick / youtube tab may ask — not heatsync.org, not an
    // iframe, not the popup.
    if (!twitchSessionSenderOk(sender)) {
      sendResponse({ ok: false, error: 'unauthorized sender' })
      return true
    }
    ;(async () => {
      try {
        const cookie = await browser.cookies.get({ url: 'https://www.twitch.tv', name: 'auth-token' }).catch(() => null)
        const hdrs = {
          'Content-Type': 'application/json',
          'Client-Id': 'kimne78kx3ncx6brgo4mv6wki5h1ko',
        }
        if (cookie?.value) hdrs.Authorization = `OAuth ${cookie.value}`
        const body = message.variables
          ? { query: message.query, variables: message.variables }
          : { query: message.query }
        const resp = await fetchWithTimeout(
          'https://gql.twitch.tv/gql',
          {
            method: 'POST',
            headers: hdrs,
            body: JSON.stringify(body),
          },
          8000,
        )
        if (!resp.ok) {
          sendResponse({ ok: false, error: `GQL ${resp.status}` })
          return
        }
        const data = await resp.json()
        sendResponse({ ok: true, data })
      } catch (e) {
        sendResponse({ ok: false, error: e.message })
      }
    })()
    return true
  } else if (message.type === 'twitch_relay') {
    // Relay a Twitch API call through an open twitch.tv tab. Used for
    // mutations (ban/timeout/delete/follow) that require a Client-Integrity
    // token which can only be minted from a Twitch page context.
    ;(async () => {
      try {
        const tabs = await browser.tabs.query({ url: '*://*.twitch.tv/*' })
        if (!tabs || tabs.length === 0) {
          sendResponse({ ok: false, error: 'no_twitch_tab' })
          return
        }
        // Try every Twitch tab — after an extension reload, content scripts
        // in existing tabs become orphans (no listener for new message types)
        // until the page is refreshed.
        const candidates = [...tabs.filter((t) => t.active), ...tabs.filter((t) => !t.active)]
        let lastErr = null
        for (const tab of candidates) {
          try {
            const result = await browser.tabs.sendMessage(tab.id, {
              type: 'twitch_relay_exec',
              op: message.op,
              args: message.args || {},
            })
            if (result) {
              sendResponse(result)
              return
            }
          } catch (e) {
            lastErr = e?.message || ''
            if (/Could not establish connection|Receiving end does not exist/i.test(lastErr)) continue
            sendResponse({ ok: false, error: lastErr })
            return
          }
        }
        sendResponse({ ok: false, error: 'stale_twitch_tab' })
      } catch (e) {
        sendResponse({ ok: false, error: e.message })
      }
    })()
    return true
  } else if (message.type === 'kick_channel_badges') {
    // Fetch kick.com/api/v2/channels/{slug}.subscriber_badges → [{months, src}].
    // Run from BG so kick.com fetch isn't gated by the panel's cross-origin
    // CORS rules (panel may be on twitch.tv/youtube.com viewing a linked Kick
    // channel). Cached per-slug for the SW lifetime via reuse of the
    // kickChannelIdCache pattern.
    ;(async () => {
      try {
        const slug = String(message.slug || '')
          .toLowerCase()
          .replace(/[^a-z0-9_-]/g, '')
          .slice(0, 64)
        if (!slug) {
          sendResponse({ ok: false, error: 'missing slug' })
          return
        }
        const resp = await fetchWithTimeout(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`)
        if (!resp.ok) {
          resp.body?.cancel?.()
          sendResponse({ ok: false, error: `kick api ${resp.status}` })
          return
        }
        const data = await resp.json().catch(() => null)
        const sub = Array.isArray(data?.subscriber_badges) ? data.subscriber_badges : []
        const badges = []
        for (const b of sub) {
          const months = parseInt(b?.months, 10)
          const src = b?.badge_image?.src
          if (Number.isFinite(months) && typeof src === 'string' && /^https?:\/\//i.test(src)) {
            badges.push({ months, src })
          }
        }
        sendResponse({ ok: true, badges })
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || 'fetch_failed' })
      }
    })()
    return true
  } else if (message.type === 'kick_resolve_channel') {
    // Resolve Kick channel slug → numeric channelId
    ;(async () => {
      const slug = message.slug?.toLowerCase()
      sendResponse(await resolveKickChannelIdBg(slug))
    })()
    return true
  } else if (message.type === 'resolve_twitch_login_by_id') {
    // Shared-chat chip: source-room-id → the partner channel's login
    ;(async () => {
      sendResponse({ login: await resolveTwitchLoginById(message.userId) })
    })()
    return true
  } else if (message.type === 'kick_session_status') {
    // Composer placeholder probe: is the user signed in on kick? Answers the
    // boolean plus the account's username (self rows, mentions for users with
    // no heatsync login) — never the cookie values. Same Bearer + credentialed
    // GET as kick_mod_status; the username is best-effort ('' when kick's
    // /api/v1/user body has no string `username`, which only costs the self
    // identity, never the login state).
    ;(async () => {
      try {
        const { cookie, session } = await readKickSession()
        if (!cookie?.value) {
          sendResponse({ loggedIn: false })
          return
        }
        let username = ''
        try {
          const headers = { Accept: 'application/json' }
          if (session?.value) headers.Authorization = `Bearer ${decodeURIComponent(session.value)}`
          const resp = await fetchWithTimeout('https://kick.com/api/v1/user', { credentials: 'include', headers }, 5000)
          if (resp.ok) {
            const data = await resp.json().catch(() => null)
            if (typeof data?.username === 'string') username = data.username
          } else resp.body?.cancel()
        } catch {}
        sendResponse({ loggedIn: true, username })
      } catch {
        sendResponse({ loggedIn: false })
      }
    })()
    return true
  } else if (message.type === 'yt_session_status') {
    // The "sending" checklist (settings › ?): signed in to youtube? true / false, or null when the
    // cookie store could not be read. A boolean only — never a cookie value.
    readYoutubeSignedIn().then((loggedIn) => sendResponse({ loggedIn }))
    return true
  } else if (message.type === 'kick_send_message') {
    // Route Kick chat send through a kick.com tab (same-origin cookies)
    ;(async () => {
      try {
        sendResponse(await sendKickMessageViaTab(message.channelId, message.content, message.reply))
      } catch (e) {
        log('kick_send_message error:', e.message)
        sendResponse({ ok: false, error: e.message })
      }
    })()
    return true
  } else if (message.type === 'kick_set_chat_mode') {
    ;(async () => {
      try {
        sendResponse(await setKickChatModeViaTab(message.chatroomId, message.body))
      } catch (e) {
        log('kick_set_chat_mode error:', e.message)
        sendResponse({ ok: false, error: e.message })
      }
    })()
    return true
  } else if (message.type === 'kick_follow') {
    // Kick has no public follow API. We POST/DELETE /api/v2/channels/{slug}/follow
    // with the user's own session cookies + XSRF token. SW direct fetch with
    // credentials:include works because manifest grants kick.com/* host access.
    // No tab-relay required (unlike kick_send_message which needs a kick.com
    // tab as the messaging origin); SW is fine here because Kick's follow
    // endpoint doesn't enforce a same-origin Referer check.
    ;(async () => {
      try {
        const slug = String(message.slug || '')
          .toLowerCase()
          .replace(/[^a-z0-9_-]/g, '')
          .slice(0, 64)
        const follow = !!message.follow
        if (!slug) {
          sendResponse({ ok: false, error: 'missing slug' })
          return
        }
        const cookie = await browser.cookies.get({ url: 'https://kick.com', name: 'XSRF-TOKEN' })
        if (!cookie?.value) {
          sendResponse({ ok: false, error: 'kick_not_logged_in' })
          return
        }
        // Bearer required since kick's 2026-07 auth change (see sendKickMessageViaTab)
        const session = await browser.cookies.get({ url: 'https://kick.com', name: 'session_token' })
        const url = `https://kick.com/api/v2/channels/${encodeURIComponent(slug)}/follow`
        const followHeaders = {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-XSRF-TOKEN': decodeURIComponent(cookie.value),
        }
        if (session?.value) followHeaders.Authorization = `Bearer ${decodeURIComponent(session.value)}`
        const resp = await fetchWithTimeout(url, {
          method: follow ? 'POST' : 'DELETE',
          credentials: 'include',
          headers: followHeaders,
        })
        // Kick returns 200/204 on success; treat "already following" / "not following"
        // signals as idempotent success. Other 4xx/5xx surface as errors.
        if (resp.ok || resp.status === 204) {
          sendResponse({ ok: true })
          return
        }
        // 422 with "already" in body → idempotent
        let bodyText = ''
        try {
          bodyText = await resp.text()
        } catch {}
        if (/already|not.*follow/i.test(bodyText)) {
          sendResponse({ ok: true, idempotent: true })
          return
        }
        sendResponse({ ok: false, error: `kick ${resp.status}`, body: bodyText.slice(0, 200) })
      } catch (e) {
        log('kick_follow error:', e?.message)
        sendResponse({ ok: false, error: e?.message || 'fetch failed' })
      }
    })()
    return true
  } else if (message.type === 'kick_mod_action') {
    // Kick moderation — ban / timeout / unban / delete-message.
    // Routed through a kick.com tab so same-origin XSRF + session cookies apply.
    // Shape: { action: 'ban'|'timeout'|'unban'|'delete', slug, username?, durationMin?, reason?, messageId? }
    ;(async () => {
      try {
        const action = String(message.action || '')
        const slug = String(message.slug || '')
          .toLowerCase()
          .replace(/[^a-z0-9_-]/g, '')
          .slice(0, 64)
        if (!action || !slug) {
          sendResponse({ ok: false, error: 'missing params' })
          return
        }
        const webOp = KICK_WEB_MOD_OPS.has(action)
        const cookie = await browser.cookies.get({ url: 'https://kick.com', name: 'XSRF-TOKEN' })
        if (!cookie?.value) {
          sendResponse({ ok: false, error: 'kick_not_logged_in' })
          return
        }
        // Bearer required since kick's 2026-07 auth change (see sendKickMessageViaTab)
        const session = await browser.cookies.get({ url: 'https://kick.com', name: 'session_token' })
        // For delete we need the chatroomId — resolve once per slug, cached.
        let chatroomId = null
        if (action === 'delete') {
          chatroomId = kickChatroomIdCache.get(slug)
          if (!chatroomId) {
            const resp = await fetchWithTimeout(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`)
            if (resp.ok) {
              const data = await resp.json().catch(() => null)
              chatroomId = data?.chatroom?.id || null
              if (chatroomId) {
                if (kickChatroomIdCache.size >= 100) {
                  kickChatroomIdCache.delete(kickChatroomIdCache.keys().next().value)
                }
                kickChatroomIdCache.set(slug, chatroomId)
              }
            }
            if (!chatroomId) {
              sendResponse({ ok: false, error: 'no_chatroom' })
              return
            }
          }
        }
        // web.kick.com routes want the CHANNEL id (not the chatroom id).
        let webReq = null
        if (webOp) {
          let channelId = kickChannelNumIdCache.get(slug)
          if (!channelId) {
            const resp = await fetchWithTimeout(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`)
            if (resp.ok) {
              const data = await resp.json().catch(() => null)
              channelId = data?.id || null
              if (channelId) {
                if (kickChannelNumIdCache.size >= 100) {
                  kickChannelNumIdCache.delete(kickChannelNumIdCache.keys().next().value)
                }
                kickChannelNumIdCache.set(slug, channelId)
              }
            }
          }
          if (!channelId) {
            sendResponse({ ok: false, error: 'no_channel' })
            return
          }
          webReq = kickWebModRequest(action, channelId, message)
          if (!webReq) {
            sendResponse({ ok: false, error: 'missing params' })
            return
          }
        }
        // Prefer a tab actually on the target channel (most likely live + the
        // relevant session) over an arbitrary kick.com tab. The API call is
        // slug-parameterized and cookie-authed so any logged-in kick tab CAN
        // execute it, but a frozen/unrelated tab is a worse bet. Then the rest,
        // health-ranked, then the hidden bridge tab when none can hear it
        // (relayViaKickTab). The 12s deadline keeps a hung renderer from
        // hanging the mod command with no feedback: fail loud.
        sendResponse(
          await relayViaKickTab(
            {
              type: 'kick_mod_relay',
              action,
              slug,
              chatroomId,
              web: webReq,
              username: message.username || '',
              durationMin: message.durationMin || 0,
              reason: message.reason || '',
              messageId: message.messageId || '',
              xsrfToken: cookie.value,
              sessionToken: session?.value || '',
            },
            { prefer: (t) => (t.url || '').toLowerCase().includes(`/${slug}`), deadlineMs: 12000 },
          ),
        )
      } catch (e) {
        log('kick_mod_action error:', e.message)
        sendResponse({ ok: false, error: e.message })
      }
    })()
    return true
  } else if (message.type === 'kick_mod_status') {
    // Is the authed Kick viewer a mod/broadcaster on this channel? Gates the
    // kick mod UI the way isModFor (twitch GQL) gates the twitch one. A plain
    // credentialed GET on kick.com (no XSRF/relay needed — same as kick_follow
    // and _kpResolveChatroomId) returns the viewer's role on the channel object.
    // Fails closed (isMod:false) on any error so the UI just doesn't surface.
    ;(async () => {
      try {
        const slug = String(message.slug || '')
          .toLowerCase()
          .replace(/[^a-z0-9_-]/g, '')
          .slice(0, 64)
        if (!slug) {
          sendResponse({ ok: true, isMod: false })
          return
        }
        const cookie = await browser.cookies.get({ url: 'https://kick.com', name: 'XSRF-TOKEN' })
        if (!cookie?.value) {
          sendResponse({ ok: true, isMod: false })
          return
        } // not logged in
        // Bearer so the response carries the VIEWER's chatroom_user role —
        // without it kick treats the request as anon (2026-07 auth change)
        // and mod status permanently fails closed.
        const session = await browser.cookies.get({ url: 'https://kick.com', name: 'session_token' })
        const statusHeaders = { Accept: 'application/json' }
        if (session?.value) statusHeaders.Authorization = `Bearer ${decodeURIComponent(session.value)}`
        const resp = await fetchWithTimeout(
          `https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`,
          { credentials: 'include', headers: statusHeaders },
          5000,
        )
        if (!resp.ok) {
          sendResponse({ ok: false, isMod: false, error: `kick api ${resp.status}` })
          return
        }
        const data = await resp.json().catch(() => null)
        // ONLY trust the viewer-specific `chatroom_user` object (the authed
        // viewer's relationship to this chatroom). Do NOT probe data.user /
        // data.role / data.chatroom.* — those are the BROADCASTER's / channel's
        // fields (data.user is the channel owner, role always 'broadcaster'), so
        // trusting them would mark every viewer a mod. Field path is community-
        // documented but unconfirmed live; under-showing (no UI) is the safe
        // failure, never showing ban buttons to a non-mod.
        const cu = data?.chatroom_user || null
        const role = String(cu?.role || cu?.user_role || '').toLowerCase()
        const isMod =
          role === 'moderator' ||
          role === 'broadcaster' ||
          role === 'mod' ||
          cu?.is_moderator === true ||
          cu?.is_broadcaster === true
        // log() is a no-op unless DEBUG — flip DEBUG to confirm the field path live
        // (logs the raw viewer object whether mod or not).
        try {
          log('kick_mod_status', slug, `isMod=${isMod}`, JSON.stringify(cu))
        } catch (_) {}
        sendResponse({ ok: true, isMod })
      } catch (e) {
        sendResponse({ ok: false, isMod: false, error: e?.message || 'fetch failed' })
      }
    })()
    return true
  } else if (message.type === 'youtube_mod_action') {
    // A mod action takes the same road as a send (driveYoutubeChat): with a
    // videoId only ever THAT stream's tabs, without one only the sender's own
    // tab — a ban/delete must never land on the wrong stream's chat.
    ;(async () => {
      const { action, msgId, target, videoId } = message
      if (!action || !msgId) {
        sendResponse({ ok: false, error: 'missing params' })
        return
      }
      sendResponse(
        await driveYoutubeChat({
          videoId,
          senderTabId: sender?.tab?.id,
          payload: { type: 'youtube_mod_relay', action, msgId, target },
        }),
      )
    })()
    return true
  } else if (message.type === 'youtube_history_request') {
    // the overlay mounted: ask the chat frame in its own tab to play the list again
    if (sender?.tab?.id != null)
      browser.tabs.sendMessage(sender.tab.id, { type: 'youtube_history_request' }).catch(() => {})
    sendResponse({ ok: true })
    return true
  } else if (message.type === 'youtube_send_message') {
    ;(async () => {
      try {
        const { text, videoId } = message
        if (!text) {
          sendResponse({ ok: false, error: 'missing params' })
          return
        }
        sendResponse(await sendYoutubeChat({ videoId, text, senderTabId: sender?.tab?.id }))
      } catch (e) {
        log('youtube_send_message error:', e.message)
        sendResponse({ ok: false, error: e.message })
      }
    })()
    return true
  } else if (message.type === 'api_fetch') {
    // Generic API proxy — content scripts route through here to bypass CORS
    // Strict path validation: catch literal `..` AND URL-encoded variants
    // (%2e%2e, %2E, etc) by decoding before the check
    let _decodedPath
    try {
      _decodedPath = decodeURIComponent(message.path || '')
    } catch {
      _decodedPath = ''
    }
    if (!message.path?.startsWith('/api/') || /\.\./.test(_decodedPath)) {
      sendResponse({ ok: false, error: 'invalid path' })
      return true
    }
    const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
    const reqMethod = String(message.method || 'GET').toUpperCase()
    if (!ALLOWED_METHODS.has(reqMethod)) {
      sendResponse({ ok: false, error: 'invalid method' })
      return true
    }
    ;(async () => {
      const doFetch = async (token) => {
        const opts = { method: reqMethod, headers: {} }
        if (message.auth && token) opts.headers.Authorization = `Bearer ${token}`
        if (message.body) {
          opts.headers['Content-Type'] = 'application/json'
          opts.body = JSON.stringify(message.body)
        }
        const resp = await fetchWithTimeout(`${API_URL}${message.path}`, opts)
        const data = await resp.json().catch(() => null)
        return { resp, data }
      }
      try {
        const token = message.auth ? authToken || (await getAuthCookie()) : null
        let { resp, data } = await doFetch(token)
        // Self-heal: a 401 with auth may be a retired copy of the token
        // (see tokenAfterRejection) — retry once under the live cookie.
        if (message.auth && resp.status === 401) {
          const live = await tokenAfterRejection(token)
          if (live) ({ resp, data } = await doFetch(live))
        }
        if (!resp.ok) {
          sendResponse({ ok: false, status: resp.status, error: data?.error || `${resp.status}`, code: data?.code })
          return
        }
        sendResponse(data?.ok !== undefined ? data : { ok: true, data })
      } catch (err) {
        sendResponse({ ok: false, error: err.message })
      }
    })()
    return true
  } else if (message.type === 'api_upload') {
    // Multipart sibling of api_fetch. Same reason for existing: a content
    // script cannot reach heatsync.org directly — the host page's CORS applies
    // and twitch/kick/youtube are not allowed origins. api_fetch can't serve
    // this one because it is JSON-only, so the file arrives here as a data URL
    // and is rebuilt into a real multipart body on this side.
    ;(async () => {
      try {
        const dataUrl = String(message.dataUrl || '')
        const comma = dataUrl.indexOf(',')
        if (!dataUrl.startsWith('data:') || comma < 0) {
          sendResponse({ ok: false, error: 'bad file data' })
          return
        }
        // Trust the declared mime only as far as its shape — the server
        // re-derives the real type from the bytes, but there is no reason to
        // relay something that isn't claiming to be media in the first place.
        const mime = String(message.mime || '').toLowerCase()
        if (!/^(image|video)\/[a-z0-9.+-]+$/.test(mime)) {
          sendResponse({ ok: false, error: 'only images/videos allowed' })
          return
        }
        const bin = atob(dataUrl.slice(comma + 1))
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        const form = new FormData()
        form.append('file', new Blob([bytes], { type: mime }), String(message.name || 'paste'))
        // The picker's emote upload: the server stores it as an emote (128px
        // tall, smaller copies beside it) and the answer carries what the add
        // that follows needs.
        if (message.emote === true) form.append('type', 'emote')

        const doUpload = async (token) => {
          const opts = { method: 'POST', body: form, headers: {} }
          // No Content-Type header — fetch sets it WITH the multipart boundary,
          // and overriding it here makes the body unparseable server-side.
          if (token) opts.headers.Authorization = `Bearer ${token}`
          const resp = await fetchWithTimeout(`${API_URL}/api/upload`, opts, 120000)
          const data = await resp.json().catch(() => null)
          return { resp, data }
        }
        const token = authToken || (await getAuthCookie())
        let { resp, data } = await doUpload(token)
        // Same self-heal as api_fetch — see tokenAfterRejection.
        if (resp.status === 401) {
          const live = await tokenAfterRejection(token)
          if (live) ({ resp, data } = await doUpload(live))
        }
        if (!resp.ok || !data?.url) {
          sendResponse({
            ok: false,
            status: resp.status,
            error: data?.error || (resp.status === 401 ? 'log in to upload' : `http ${resp.status}`),
          })
          return
        }
        // Absolutize before it leaves the relay. The server answers with an
        // origin-relative '/uploads/<file>', and the only consumer drops that
        // string straight into the chat composer — where a leading '/' makes
        // Twitch read the whole message as a slash command and answer
        // "Unrecognized command: /uploads/...". The message never reaches chat.
        // The render chokepoint already absolutizes for feed/thread, but a chat
        // send has no chokepoint: the raw text is the wire payload.
        sendResponse({
          ok: true,
          url: absUrl(data.url),
          ...(message.emote === true
            ? {
                phash: data.phash,
                width: data.width,
                height: data.height,
                // categories the scan flagged but still hosted (a content warning, not a block)
                flagged: Array.isArray(data.moderationResult?.flaggedCategories)
                  ? data.moderationResult.flaggedCategories.slice(0, 8)
                  : [],
              }
            : {}),
        })
      } catch (err) {
        sendResponse({ ok: false, error: err.message })
      }
    })()
    return true
  } else if (message.type === 'api_store_remote') {
    // Store a remote image by URL and answer with OUR copy of it.
    //
    // Why this exists: Chromium's "copy image" rasterizes an animated gif to a
    // single frame before the bytes ever reach the clipboard, so the paste
    // handler uploads a still and the gif arrives dead. The same copy also
    // offers a text/html flavor holding the original <img src> — that url still
    // points at the real animated file, and fetching it server-side is the only
    // way back to the frames.
    //
    // /api/img is that fetch, already built and already hardened: SSRF-pinned
    // per redirect hop, byte-capped, moderated, and stored through the same
    // handleUpload pipeline as a direct upload — then it answers 302 to
    // /uploads/<hash>.webp with animation intact. So this is a URL resolve, not
    // a second upload path, and it needs no permission the ext doesn't have.
    ;(async () => {
      try {
        const src = String(message.url || '')
        let parsed
        try {
          parsed = new URL(src)
        } catch {
          sendResponse({ ok: false, error: 'bad url' })
          return
        }
        // /api/img is https-only and refuses its own origin. Answer both here
        // rather than spending a round trip to be told.
        if (parsed.protocol !== 'https:') {
          sendResponse({ ok: false, error: 'https only' })
          return
        }
        if (parsed.hostname === 'heatsync.org' || parsed.hostname.endsWith('.heatsync.org')) {
          sendResponse({ ok: true, url: src })
          return
        }
        // Emote CDNs are hotlinked, never mirrored. Storing a copy would put
        // someone else's emote artwork in our bucket, and the standing posture
        // is that the risk on unlicensed creator art stays with the host that
        // chose to serve it. These hosts also render directly (they're in
        // HS_IMG_DIRECT_HOSTS), so the link works untouched — and it's already
        // animated, which was the entire point of resolving a source url.
        if (HOTLINK_ONLY_HOSTS.has(parsed.hostname)) {
          sendResponse({ ok: true, url: src })
          return
        }
        // noBackoff: a cached, read-only GET. Under the shared heatsync backoff
        // an unrelated 429 somewhere else would fake-429 this one, and the only
        // symptom would be gifs quietly going still for the next minute.
        // 30s: a cold url is a real fetch + moderation pass on our side.
        const res = await fetchWithTimeout(
          `${API_URL}/api/img?url=${encodeURIComponent(src)}`,
          { noBackoff: true },
          30000,
        )
        // The stored path is the redirect TARGET, not the body — and the body is
        // the full image, up to 10MB. Take the identity and drop the bytes.
        const finalUrl = res.url || ''
        try {
          await res.body?.cancel()
        } catch {}
        const stored = finalUrl.match(/\/uploads\/[\w.-]+$/)
        if (!res.ok || !stored) {
          sendResponse({ ok: false, error: `http ${res.status}` })
          return
        }
        sendResponse({ ok: true, url: absUrl(stored[0]) })
      } catch (err) {
        sendResponse({ ok: false, error: err.message })
      }
    })()
    return true
  } else if (message.type === 'register_self_twitch_id') {
    // Content script discovered the user's own twitch ID. Subscribe to 7TV
    // EventAPI so badge/paint changes push in real-time (no polling needed).
    if (message.twitchId && /^\d+$/.test(String(message.twitchId))) {
      ensureSelfCosmeticSub(String(message.twitchId))
    }
    sendResponse({ ok: true })
    return false
  } else if (message.type === 'get_user_cosmetics') {
    const ids = (message.twitchIds || []).slice(0, 25)
    ;(async () => {
      const result = {}
      const toFetch = []
      // Per-id inflight dedup — concurrent get_user_cosmetics calls (multi-tab
      // or rapid chat) used to fan out as N separate /api/cosmetics/batch POSTs
      // even when IDs overlapped, each one a fresh 429 candidate. Share promises.
      if (!globalThis.__cosmeticsInflight) globalThis.__cosmeticsInflight = new Map()
      const inflightMap = globalThis.__cosmeticsInflight
      const pendingInflight = []
      for (const id of ids) {
        const cached = userCosmeticsCache.get(id)
        const isNegative = cached && !cached.paint && !cached.badge
        const ttl = isNegative ? COSMETICS_NEGATIVE_TTL : USER_COSMETICS_TTL
        if (cached && Date.now() - cached.fetchedAt < ttl) {
          result[id] = { paint: cached.paint, badge: cached.badge }
        } else if (inflightMap.has(id)) {
          pendingInflight.push(id)
        } else {
          toFetch.push(id)
        }
      }

      if (toFetch.length > 0) {
        // Try heatsync proxy first — single request, server-side cache, no 7TV
        // IP exposure. Retry once: switching to a busy/frozen channel rebuilds
        // its whole buffer and floods this with ~60 batches at once; a single
        // 6s timeout under that burst failed whole batches, fell to the direct
        // 7TV path, and CACHED the empty result as "no cosmetics" — which stuck
        // users who actually have a paint until the negative TTL expired.
        // Wrapped in one shared per-id promise so concurrent overlapping batch
        // calls don't each re-fire the same id.
        const batchPromise = (async () => {
          let proxied = null
          for (let attempt = 0; attempt < 2 && !proxied; attempt++) {
            try {
              const resp = await fetchWithTimeout(
                `${API_URL}/api/cosmetics/batch`,
                {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ twitchIds: toFetch }),
                },
                10000,
              )
              if (resp.ok) {
                const data = await resp.json()
                if (data?.cosmetics) proxied = data.cosmetics
              } else {
                resp.body?.cancel?.()
              }
            } catch (_e) {
              /* retry, then fall through */
            }
          }
          if (proxied) {
            const out = {}
            for (const id of toFetch) {
              const c = proxied[id] ?? null
              setUserCosmetic(id, c)
              out[id] = c
            }
            return out
          }
          // Proxy unreachable — fall back to direct 7TV. CRITICAL: only cache a
          // negative on a definitive 404 (no 7TV account). A 503/timeout/network
          // error must NOT be cached, or one transient blip blanks a user's
          // cosmetics for the whole negative-TTL window; leave it unset to retry.
          const out = {}
          await Promise.all(
            toFetch.map(async (id) => {
              try {
                const resp = await fetchWithTimeout(`https://7tv.io/v3/users/twitch/${id}`)
                if (resp.status === 404) {
                  resp.body?.cancel?.()
                  setUserCosmetic(id, null)
                  out[id] = null
                  return
                }
                if (!resp.ok) {
                  resp.body?.cancel?.()
                  out[id] = null
                  return
                }
                const data = await resp.json()
                const ids7tv = extract7TVCosmeticIds(data)
                const cosmetic = await resolve7TVCosmeticIds(ids7tv)
                setUserCosmetic(id, cosmetic)
                out[id] = cosmetic
              } catch (_e) {
                out[id] = null
              }
            }),
          )
          return out
        })()
        // Register each id as inflight before awaiting — overlapping concurrent
        // callers see the same promise and skip refiring.
        for (const id of toFetch) {
          const idP = batchPromise.then((m) => m[id] || null)
          inflightMap.set(id, idP)
          idP.finally(() => {
            if (inflightMap.get(id) === idP) inflightMap.delete(id)
          })
        }
        const batchResult = await batchPromise
        for (const id of toFetch) result[id] = batchResult[id] || null
      }

      // Collect from any other in-flight requests (started by sibling calls)
      if (pendingInflight.length > 0) {
        await Promise.all(
          pendingInflight.map(async (id) => {
            const p = inflightMap.get(id)
            if (p) result[id] = (await p) || null
          }),
        )
      }

      sendResponse({ cosmetics: result })
    })()
    return true
  } else if (message.type === 'get_kick_user_cosmetics') {
    // 7TV's /v3/users/kick/{id} expects the numeric Kick user_id, not the
    // username — username lookups return 404 user_not_found. Resolve via
    // kick.com/api/v1/users/{username} first (returns {id, username, ...}),
    // cache that id forever (LRU), then hit 7TV with the id to pull cosmetics
    // and the linked Twitch connection.
    //
    // message.kickIds: optional { username → numeric kick user id }, threaded
    // through from the Pusher tap / server relay, which already carry the
    // sender's numeric id on every chat message. When present, Step 1 is
    // skipped entirely — this is what took a busy Kick channel from ~2
    // kick.com+7TV round-trips per chatter down to one.
    const usernames = (message.kickUsernames || []).slice(0, 10)
    const kickIds = message.kickIds || {}
    ;(async () => {
      const result = {}
      await Promise.all(
        usernames.map(async (username) => {
          const cacheKey = `kick:${username}`
          const cached = userCosmeticsCache.get(cacheKey)
          // A transient (429/5xx/network) failure gets a short negative-TTL
          // cache entry, NOT the long confirmed-negative TTL and NOT forever —
          // it fails fast on repeat asks within the window instead of
          // re-hitting a rate-limited endpoint, but forgets quickly so a real
          // cosmetic isn't masked. While cooling down, the key is left OUT of
          // `result` (undefined, not null) so the client knows to retry later
          // rather than caching a permanent "no cosmetics".
          if (cached?.transient) {
            if (Date.now() - cached.fetchedAt < KICK_TRANSIENT_NEGATIVE_TTL) return
          } else {
            const isNegative = cached && !cached.paint && !cached.badge
            const ttl = isNegative ? COSMETICS_NEGATIVE_TTL : USER_COSMETICS_TTL
            if (cached && Date.now() - cached.fetchedAt < ttl) {
              // kickId is absent on cache entries written before this field
              // existed — omit it rather than force a re-fetch (graceful).
              result[username] = {
                paint: cached.paint,
                badge: cached.badge,
                twitchId: cached.twitchId || null,
                ...(cached.kickId ? { kickId: cached.kickId } : {}),
                avatar: kickUsernameToPfpCache.get(username) || null,
              }
              return
            }
          }
          try {
            // Step 1 — username → kick user_id. Skip the fetch entirely when
            // the caller already knows the numeric id (pusher/relay) or it's
            // cached from a prior resolve; only a cold, id-less lookup pays
            // for kick.com.
            const providedId = String(kickIds[username] || '')
            let kickUserId = /^\d+$/.test(providedId) ? providedId : kickUsernameToIdCache.get(username)
            if (!kickUserId) {
              const userResp = await fetchKickCom(`https://kick.com/api/v1/users/${encodeURIComponent(username)}`)
              if (!userResp.ok) {
                userResp.body?.cancel?.()
                // Only a 404 is proof the user has no cosmetics — cache that
                // long. A 429/5xx is transient — short negative TTL (see above).
                if (userResp.status === 404) setUserCosmetic(cacheKey, null)
                else setUserCosmetic(cacheKey, { paint: null, badge: null, transient: true })
                return
              }
              const userData = await userResp.json().catch(() => null)
              kickUserId = userData?.id || null
              if (!kickUserId) {
                setUserCosmetic(cacheKey, null)
                return
              }
              // Capture the real avatar from the same response (free — no extra
              // fetch). NOTE: v1/users spells it `profilepic` (no underscore) —
              // v2/channels uses `profile_pic`; accept both to be safe.
              const _pfp = userData?.profilepic || userData?.profile_pic
              if (_pfp) {
                if (kickUsernameToPfpCache.size >= 1000) {
                  kickUsernameToPfpCache.delete(kickUsernameToPfpCache.keys().next().value)
                }
                kickUsernameToPfpCache.set(username, _pfp)
              }
            }
            if (kickUsernameToIdCache.size >= 1000) {
              kickUsernameToIdCache.delete(kickUsernameToIdCache.keys().next().value)
            }
            kickUsernameToIdCache.set(username, kickUserId)
            // Step 2 — kick user_id → 7TV cosmetics + twitch connection.
            // Most kick chatters have no 7TV account (404) — the resolved
            // kickId + avatar must still flow back so kick-origin heatsync
            // paints and real avatars render without a 7TV account.
            const resp = await fetchWithTimeout(`https://7tv.io/v3/users/kick/${kickUserId}`)
            if (!resp.ok) {
              resp.body?.cancel?.()
              if (resp.status === 404) {
                const bare = { paint: null, badge: null, twitchId: null, twitchUsername: null, kickId: kickUserId }
                setUserCosmetic(cacheKey, bare) // genuine: no 7TV account
                result[username] = { ...bare, avatar: kickUsernameToPfpCache.get(username) || null }
              } else {
                setUserCosmetic(cacheKey, { paint: null, badge: null, transient: true })
              }
              return
            }
            const data = await resp.json()
            const ids7tv = extract7TVCosmeticIds(data)
            const cosmetic = await resolve7TVCosmeticIds(ids7tv)
            const twitchConn = data?.user?.connections?.find((c) => c.platform === 'TWITCH')
            const twitchId = twitchConn?.id || null
            const twitchUsername = twitchConn?.username || null
            // kickUserId is the raw numeric kick id — safe to hand back here
            // (this response only ever feeds cosmetics.js's kickId field,
            // never a paint lookup directly; see queuePaintLookup's ID-SPACE
            // SAFETY note in src/multichat/paints.js for the namespacing rule
            // callers must apply before using it for a paint lookup).
            const full = cosmetic
              ? { ...cosmetic, twitchId, twitchUsername, kickId: kickUserId }
              : { paint: null, badge: null, twitchId, twitchUsername, kickId: kickUserId }
            setUserCosmetic(cacheKey, full)
            result[username] = { ...full, avatar: kickUsernameToPfpCache.get(username) || null }
          } catch (_e) {
            // transient: network/timeout — short negative TTL, key omitted
            setUserCosmetic(cacheKey, { paint: null, badge: null, transient: true })
          }
        }),
      )
      sendResponse({ cosmetics: result })
    })()
    return true
  } else if (message.type === 'get_youtube_user_cosmetics') {
    // Per-chatter 7TV cosmetics for YouTube-only accounts (no linked Twitch).
    // 7TV files YouTube under the "google" platform slug keyed by the real UC
    // channel id (see fetch7TVChannelEmotes's youtube branch for the id-format
    // rationale). Mirrors get_kick_user_cosmetics: direct-to-7TV from the BG SW
    // (no server proxy exists for non-twitch platforms — cosmetics.ts only
    // validates numeric twitch ids), same cache/TTL posture, own key prefix so
    // it can never collide with a twitch_id or a kick_id.
    const channelIds = Array.from(
      new Set((message.channelIds || []).filter((id) => /^UC[\w-]{20,}$/i.test(String(id || '')))),
    ).slice(0, 25)
    ;(async () => {
      const result = {}
      await Promise.all(
        channelIds.map(async (ucid) => {
          const cacheKey = `yt:${ucid}`
          const cached = userCosmeticsCache.get(cacheKey)
          const isNegative = cached && !cached.paint && !cached.badge
          const ttl = isNegative ? COSMETICS_NEGATIVE_TTL : USER_COSMETICS_TTL
          if (cached && Date.now() - cached.fetchedAt < ttl) {
            result[ucid] = { paint: cached.paint, badge: cached.badge }
            return
          }
          try {
            const resp = await fetchWithTimeout(`https://7tv.io/v3/users/google/${ucid}`)
            if (resp.status === 404) {
              resp.body?.cancel?.()
              setUserCosmetic(cacheKey, null) // genuine: no 7TV account
              result[ucid] = null
              return
            }
            if (!resp.ok) {
              resp.body?.cancel?.()
              result[ucid] = null // transient: don't cache 5xx
              return
            }
            const data = await resp.json()
            const ids7tv = extract7TVCosmeticIds(data)
            const cosmetic = await resolve7TVCosmeticIds(ids7tv)
            setUserCosmetic(cacheKey, cosmetic)
            result[ucid] = cosmetic
          } catch (_e) {
            result[ucid] = null // transient: network/timeout — don't cache
          }
        }),
      )
      sendResponse({ cosmetics: result })
    })()
    return true
  } else if (message.type === 'fetch_paints') {
    // Relay for GET /api/paints?ids=... (public, ≤50/batch) — CRITICAL: this
    // must stay a BG fetch, never a content-script one. Cross-origin
    // content-script fetches to heatsync.org trip Cloudflare's bot heuristics
    // (edge 503 before the origin ever sees them; see fetch_recent_messages
    // above for the same reasoning). Mirrors get_user_cosmetics's shape:
    // per-id TTL cache + in-flight promise sharing so concurrent overlapping
    // batches (multi-tab, rapid chat) don't each re-fire the same ids.
    const ids = Array.from(
      // Allow '-': yt paint uids are `yt_<UCid>` and UC channel ids are
      // base64url, so a hyphen is common (kson = yt_UC9ruVYPv7yJmV0Rh0NKA-Lw).
      // The old no-hyphen guard silently dropped ~half of yt paint lookups.
      // Matches the server /api/paints ID_RE (paint.ts). twitch/kick/heatsync
      // ids are unaffected (no hyphens).
      new Set((message.userIds || []).filter((id) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(id))),
    ).slice(0, 50)
    ;(async () => {
      if (!ids.length) {
        sendResponse({ paints: {}, colors: {}, plus: {}, badges: {} })
        return
      }
      const result = {}
      const toFetch = []
      if (!globalThis.__paintsInflight) globalThis.__paintsInflight = new Map()
      const inflightMap = globalThis.__paintsInflight
      const pendingInflight = []
      for (const id of ids) {
        const cached = _paintsCache.get(id)
        if (cached && Date.now() - cached.fetchedAt < PAINTS_TTL) {
          result[id] = cached.spec
        } else if (inflightMap.has(id)) {
          pendingInflight.push(id)
        } else {
          toFetch.push(id)
        }
      }

      if (toFetch.length > 0) {
        const batchPromise = (async () => {
          // CRITICAL: only ever set `out[id]` (and cache it) on a CONFIRMED
          // answer from a successful, parseable response — including a
          // confirmed negative (id genuinely absent from `paints`, meaning
          // the user has no paint set). On any failure (non-OK, timeout,
          // unparseable body) leave the id OUT of `out` entirely so the
          // per-id key is absent from the response; the content script
          // (paints.js) treats an absent key as "retry later" and never
          // caches it — a transient BG hiccup must never get mistaken for
          // (and mask) a real paint, mirroring the same rule already applied
          // to 7TV cosmetics negative-caching above.
          const out = {}
          try {
            const resp = await fetchWithTimeout(
              `${API_URL}/api/paints?ids=${toFetch.map(encodeURIComponent).join(',')}`,
              {},
              10000,
            )
            if (resp.ok) {
              const data = await resp.json().catch(() => null)
              if (data?.paints && typeof data.paints === 'object') {
                const dataColors = data.colors && typeof data.colors === 'object' ? data.colors : {}
                const dataPlus = data.plus && typeof data.plus === 'object' ? data.plus : {}
                // absent on a server that predates badges: nobody has one
                const dataBadges = data.badges && typeof data.badges === 'object' ? data.badges : {}
                for (const id of toFetch) {
                  const spec = data.paints[id] ?? null
                  setPaintCache(id, spec, dataColors[id] ?? null, dataPlus[id] ?? null, dataBadges[id] ?? null)
                  out[id] = spec
                }
              }
              // else: unparseable/malformed body — leave `out` empty, retry next flush.
            } else {
              resp.body?.cancel?.()
            }
          } catch (_e) {
            /* network error/timeout — leave `out` empty, retry next flush */
          }
          return out
        })()
        // `undefined` (not `null`) is the "unresolved, retry later" sentinel
        // threaded through the inflight-sharing chain — `null` is reserved
        // for a CONFIRMED negative and must never be conflated with it.
        for (const id of toFetch) {
          const idP = batchPromise.then((m) => (id in m ? m[id] : undefined))
          inflightMap.set(id, idP)
          idP.finally(() => {
            if (inflightMap.get(id) === idP) inflightMap.delete(id)
          })
        }
        const batchResult = await batchPromise
        for (const id of toFetch) {
          if (id in batchResult) result[id] = batchResult[id]
        }
      }

      if (pendingInflight.length > 0) {
        await Promise.all(
          pendingInflight.map(async (id) => {
            const p = inflightMap.get(id)
            if (!p) return
            const v = await p
            if (v !== undefined) result[id] = v
          }),
        )
      }

      // `result` only has keys for CONFIRMED ids (positive spec, or a
      // confirmed negative) — an id with no answer yet is simply absent, and
      // paints.js (content script) treats an absent key as "retry next flush".
      // Picked name colours + plus tenure ride along: read them from the
      // cache for every resolved id (inflight-shared ids were cached by
      // their owning batch before their promise resolved, so both are
      // present by now).
      const colors = {}
      const plus = {}
      const badges = {}
      for (const id of Object.keys(result)) {
        const cached = _paintsCache.get(id)
        if (cached?.color) colors[id] = cached.color
        if (cached?.plus) plus[id] = cached.plus
        if (cached?.badge) badges[id] = cached.badge
      }
      sendResponse({ paints: result, colors, plus, badges })
    })()
    return true
  } else if (message.type === 'get_sender_emotes') {
    // Per-sender heatsync + 7TV personal-set resolve. Used by content script to lazy-resolve
    // each unseen sender's emotes once and cache write-once-per-(sender, name) forever.
    // Input:  senderKeys: ["twitch:12345", "kick:somebody", "yt:abcd", ...]
    // Output: { emotes: { "twitch:12345": { "67": {url, source, zeroWidth, hash}, ... }, ... } }
    // Empty inner object = sender has no personal set (caller still caches the miss to avoid refetch).
    const senderKeys = (message.senderKeys || []).slice(0, 30)
    ;(async () => {
      const result = {}
      // Keys whose providers errored this round — clients must NOT replace
      // their cached set with this partial/empty result (raw-text regression)
      const erroredKeys = []
      // Per-key emote-inventory version from the batch reply (absent on old servers)
      const versOut = {}
      // Cache hits inside this background instance (cross-tab dedupe). 6h TTL.
      // Per-name perma is enforced on the content side via mergeSenderEmotes.
      if (!globalThis.__senderEmoteCache) globalThis.__senderEmoteCache = new Map()
      const cache = globalThis.__senderEmoteCache
      const SENDER_EMOTE_CACHE_TTL = 120000 // 2min — matches the panel's re-fetch TTL so the fallback path is a consistent 2min end-to-end (the live emote:added broadcast busts this cache immediately, making this the miss/reconnect fallback, not the primary path)
      // Misses expire much sooner: an empty cached set is the exact window
      // where a sender's brand-new emote renders as plain text for this
      // viewer if the live emote:broadcast was missed. 90s bounds it.
      const SENDER_EMOTE_NEGATIVE_TTL = 90000
      const cacheFresh = (h) => {
        if (!h) return false
        const ttl = h.emotes && Object.keys(h.emotes).length > 0 ? SENDER_EMOTE_CACHE_TTL : SENDER_EMOTE_NEGATIVE_TTL
        return Date.now() - h.ts < ttl
      }
      // Batch-fetch heatsync sets for all numeric ids that aren't cache-fresh, in ONE
      // request. Per-id /api/users/:id calls fired ~15-parallel per flush tripped
      // Cloudflare's 429; one batched call keeps it well under. credentials:'omit' so
      // the *-CORS response isn't rejected (credentialed + ACAO:* is invalid).
      const _missKeys = [
        ...new Set(
          senderKeys
            .filter((k) => !cacheFresh(cache.get(k)))
            .filter((k) => {
              const c = k.indexOf(':')
              return c >= 0 && k.slice(c + 1).length > 0
            }),
        ),
      ]
      // Sentinel so an errored fetch (null from .catch) is distinguishable from
      // an authoritative empty ({} / 404). Poisoning the cache with an empty
      // set on a transient failure made a sender's emotes render as raw text
      // (even the 90s negative TTL is a lie for a network blip) after recovery.
      const SENDER_FETCH_ERR = (globalThis.__senderFetchErr ??= Symbol('sender-fetch-err'))
      let hsBatch = {}
      let _hsBatchErrored = false
      let hsVers = {}
      if (_missKeys.length) {
        // Send platform-prefixed keys (e.g. twitch:12345, kick:username) so the server
        // can resolve all platforms. Response is keyed by the same prefixed strings.
        // v (from a live push's emote-ver) busts the CF edge: TTL refetches keep
        // the shared cacheable URL, push refetches hit a URL the edge never saw.
        const bust = sanitizeVer(message.v)
        const hb = await fetchWithTimeout(
          withNsfwParam(
            `${API_URL}/api/users/emotes/batch?ids=${_missKeys.map(encodeURIComponent).join(',')}${bust ? `&v=${bust}` : ''}`,
          ),
          { credentials: 'omit', noBackoff: true },
        )
          // non-OK (429/5xx) or non-JSON is an error, never an empty set
          .then((r) => (r.ok ? r.json() : SENDER_FETCH_ERR))
          .catch(() => SENDER_FETCH_ERR)
        // Distinguish a transient failure (network/timeout → don't poison the
        // cache with an empty set) from a legit empty response.
        hsBatch = hb === SENDER_FETCH_ERR ? {} : hb?.sets || {}
        hsVers = hb === SENDER_FETCH_ERR ? {} : hb?.vers || {}
        if (hb === SENDER_FETCH_ERR || !hb?.sets) _hsBatchErrored = true
      }
      await Promise.all(
        senderKeys.map(async (key) => {
          const hit = cache.get(key)
          if (cacheFresh(hit)) {
            result[key] = hit.emotes
            if (hit.ver != null) versOut[key] = hit.ver
            return
          }
          const colon = key.indexOf(':')
          if (colon < 0) {
            result[key] = {}
            return
          }
          if (!key.slice(colon + 1)) {
            result[key] = {}
            return
          }
          // A sender's emotes = their heatsync set + their 7TV paid personal set
          // (captured live from EventAPI entitlements) + their BTTV Pro personal
          // set (captured from the socket's lookup_user push). Not their CHANNEL's
          // 7TV/BTTV set: that isn't theirs to post elsewhere — 7TV, BTTV and the
          // site all render it as text — and fetching it cost two third-party
          // calls per new chatter, ~1,500 a minute in a busy chat, mostly 404s.
          const collected = {}
          const hs = { emotes: hsBatch[key] || [] }
          const uid = key.startsWith('twitch:') ? key.slice(7) : null
          // BTTV Pro personal set first, so the same name from 7TV or heatsync wins
          const bttvPersonal = uid ? bttvPersonalSets.get(uid) : null
          if (bttvPersonal) Object.assign(collected, bttvPersonal)
          const personal = uid ? seventvPersonalSets.get(uid) : null
          if (personal) Object.assign(collected, personal)
          // HeatSync personal set — overrides provider entries because it's the
          // sender's curated set (and what they actually post via heatsync). URLs
          // are already absolute (server normalizes /uploads/ → CDN). zero_width
          // arrives from the emotes table (added 2026-05-23, migration 164) so
          // cross-user overlay stacks ("wavE wavE wavE") render correctly. If the
          // server flag is missing (old payload / unmigrated row) we fall back to
          // any zeroWidth already collected via the 7TV personal-set loop above —
          // never blindly overwriting an overlay flag with false.
          const hsEmotes = hs?.emotes || []
          for (const e of hsEmotes) {
            const name = e?.custom_name || e?.name
            if (!name) continue
            // cw stub — the viewer's content filter hid this emote server-side
            // (no url, just the category). Carry it through so chat paints the
            // dashed cyan "hidden by filter" placeholder instead of raw text.
            // Overrides any same-name 7TV/BTTV entry, matching the normal
            // heatsync-set-wins precedence below.
            if (!e?.url && typeof e?.cw === 'string' && e.cw) {
              collected[name] = { url: '', source: 'heatsync', state: 'cw', cw: e.cw, zeroWidth: false, hash: '' }
              continue
            }
            if (!e?.url) continue
            const u = e.url
            // Server stores source:'extension' for ext-added emotes — meaningless to
            // the UI. Derive the real provider from the CDN url for an accurate label.
            const src = /cdn\.7tv\.app/.test(u)
              ? '7tv'
              : /cdn\.betterttv\.net/.test(u)
                ? 'bttv'
                : /cdn\.frankerfacez\.com/.test(u)
                  ? 'ffz'
                  : e.source && e.source !== 'extension'
                    ? e.source
                    : 'heatsync'
            const prevZW = collected[name]?.zeroWidth
            collected[name] = {
              url: u,
              source: src,
              // Inventory-time stamp (epoch ms) — processEmotes gates rendering
              // to messages sent after the sender actually owned the emote, so
              // a fresh collect never retro-imagifies their older messages.
              // heatsync entries only; 7TV/BTTV sets have no ownership time.
              addedAt: emoteAddedAtMs(e.added_at),
              // 2-state model: every pasteable shared emote is just 'global'.
              // processEmotes still upgrades to 'owned' if the viewer has the
              // name in their inventory; otherwise it renders identically to
              // any other global (white hover, click pastes, auto-add at send).
              state: 'global',
              zeroWidth: !!(e.zero_width ?? e.zeroWidth ?? prevZW),
              hash: e.hash || '',
              variants: Array.isArray(e.variants) ? e.variants : undefined,
              nsfw: !!e.nsfw, // v1.6 — cyan dashed border in chat + picker
            }
            // The upper bound, from a historical pairing (a name they USED with an
            // emote they no longer hold): the last time the archive saw them use
            // it. _sGate withholds it from lines sent after that (+ skew pad), or
            // a removed emote draws on the bare word forever. Live rows have no
            // `until` and stay open-ended; set only when bounded.
            const untilAt = emoteAddedAtMs(e.until)
            if (untilAt) collected[name].untilAt = untilAt
          }
          // Only cache when the result is trustworthy: a transient fetch error
          // must NOT be cached — even the 90s negative TTL wrongly blanks this
          // sender after the network recovers. Error-free results (empty or
          // not) cache normally; cacheFresh picks the TTL by emptiness.
          const ver = hsVers[key]
          if (ver != null) versOut[key] = ver
          if (!_hsBatchErrored) {
            // A late stale reply must not overwrite a newer cached set
            if (!(ver != null && cache.get(key)?.ver > ver)) cache.set(key, { emotes: collected, ts: Date.now(), ver })
            // LRU evict: keep most-recent 500.
            if (cache.size > 500) cache.delete(cache.keys().next().value)
          } else {
            erroredKeys.push(key)
          }
          result[key] = collected
        }),
      )
      sendResponse({ emotes: result, errored: erroredKeys, vers: versOut })
    })()
    return true
  } else if (message.type === 'get_bulk_badges') {
    // Synchronous response — must call sendResponse before this handler yields,
    // or the message channel closes and the caller's promise hangs forever.
    // The cold-start "maps not loaded yet" race is handled on the client side:
    // the multichat retry-loader re-requests until non-empty, and initialize()
    // broadcasts a cosmetics_update once the storage restore lands.
    sendResponse(badgeMapsPayload())
    return
  } else if (message.type === 'mention_detected') {
    // Defense-in-depth: blocked users never trigger a mention notification,
    // regardless of which content-script path detected the @mention.
    // userSetMatches checks legacy bare keys first so pre-namespace entries still match.
    if (message.username && userSetMatches(blockedUsers, message.username, message.platform || null, [])) {
      sendResponse({ ok: true })
      return
    }
    // Fire a browser notification if the user has hs_notifications enabled.
    // Show the mention author's pfp (their face), falling back to the logo.
    browser.storage.local
      .get('hs_notifications')
      .then(async (data) => {
        if (!data.hs_notifications) return
        if (!browser.notifications) return
        const pfp = await resolveAvatarUrl(message.username, message.platform)
        const iconUrl = (await toNotifIconDataUrl(pfp)) || browser.runtime.getURL('icon-128.png')
        const notifId = `hs-mention-${Date.now()}`
        browser.notifications
          .create(notifId, {
            type: 'basic',
            iconUrl,
            title: message.username || 'mention',
            message: message.text || '',
          })
          .catch(() => {})
      })
      .catch(() => {})
    sendResponse({ ok: true })
    return
  } else if (message.type === 'resolve_avatar') {
    // Avatar lookup for the multichat panel's own Web Notification toasts.
    // Returns a data URL (resolve → inline) so panel toasts render reliably too.
    ;(async () => {
      try {
        const raw = await resolveAvatarUrl(message.username, message.platform)
        sendResponse({ url: (await toNotifIconDataUrl(raw)) || '' })
      } catch {
        sendResponse({ url: '' })
      }
    })()
    return true // async response
  } else if (message.type === 'resolve_avatar_url') {
    // Raw avatar URL (NOT a data URL) for in-chat avatar rendering — the browser
    // caches the image normally, so per-row avatars stay light on RAM. First-party
    // resolution (Twitch GQL / Kick v2).
    ;(async () => {
      try {
        sendResponse({ url: (await resolveAvatarUrl(message.username, message.platform)) || '' })
      } catch {
        sendResponse({ url: '' })
      }
    })()
    return true // async response
  }
}
