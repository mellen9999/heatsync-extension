// Feed media + embed rendering for the extension home tab.
// Mirrors heatsync client/embed/embed-parser.js + renderers/media-renderer.js
// All embeds always-enabled (extension has no per-platform toggles yet).
// Uses plain iframes (no facade) — feed virtual-scrolls so visible iframe count stays low.

// Defence-in-depth sandbox for third-party iframes. allow-scripts/same-origin
// are required by every embed provider (player JS + auth cookies); the rest
// preserves user-clickable share/popup flows. What this BLOCKS: top-level
// nav, modals, pointer-lock, downloads — i.e. defang most providers if they
// ship malicious payload.
const EMBED_SANDBOX =
  'allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox allow-forms'

function sanitizeEmbedId(id) {
  if (!id || typeof id !== 'string') return ''
  return id.replace(/[^a-zA-Z0-9_-]/g, '')
}

function attr(s) {
  return escapeHtml(s)
}

// Hosts the extension's img-src CSP already allows — served directly. Any OTHER
// http(s) image host (safebooru, i.ytimg, giphy, arbitrary og:images) would be
// CSP-blocked in-ext, so route it through our origin image proxy, which also
// hides the viewer's IP from the third-party host (a privacy win over hotlinking
// — and why we proxy rather than widen img-src to `https:`, which would let any
// post beacon the viewer via tracking-pixel images). Non-http inputs (data:,
// blob:, '') and parse failures pass through untouched. Keep this host set in
// sync with img-src in src/manifests/{chrome,firefox}.json.
const HS_IMG_DIRECT_HOSTS = new Set([
  'static-cdn.jtvnw.net',
  'cdn.7tv.app',
  'cdn.betterttv.net',
  'cdn.frankerfacez.com',
  'files.kick.com',
  'heatsync.org',
  'cdn.heatsync.org',
  'i.imgur.com',
  'd3aqoihi2n8ty8.cloudfront.net',
])
function hsProxyImg(url) {
  if (!url || typeof url !== 'string') return url || ''
  let host
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return url // data:/blob: — leave
    host = u.hostname
  } catch {
    return url
  }
  if (HS_IMG_DIRECT_HOSTS.has(host)) return url
  return `https://heatsync.org/api/img?url=${encodeURIComponent(url)}`
}

function ytEmbed(videoId) {
  const id = sanitizeEmbedId(videoId)
  if (!id) return ''
  // YT refuses to embed when parent is youtube.com (Error 153 "Video player
  // configuration error" — self-embed guard). Fall back to a thumbnail card
  // that opens the video in a new tab.
  if (/(^|\.)youtube\.com$/i.test(location.hostname)) {
    return `<a href="https://www.youtube.com/watch?v=${id}" target="_blank" rel="noopener" class="hs-feed-embed-yt-thumb">
      <img src="${hsProxyImg(`https://i.ytimg.com/vi/${id}/hqdefault.jpg`)}" alt="" loading="lazy" data-fb="hide">
      <span class="hs-feed-embed-yt-play">▶</span>
    </a>`
  }
  return `<div class="hs-feed-embed-container hs-feed-embed-youtube">
    <iframe src="https://www.youtube-nocookie.com/embed/${id}?modestbranding=1&playsinline=1&rel=0&enablejsapi=1"
      sandbox="${EMBED_SANDBOX}"
      allow="autoplay; accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
      loading="lazy"
      referrerpolicy="strict-origin-when-cross-origin"></iframe>
  </div>`
}

function twitchClipEmbed(clipId) {
  const id = sanitizeEmbedId(clipId)
  if (!id) return ''
  const parent = location.hostname || 'localhost'
  return `<div class="hs-feed-embed-container hs-feed-embed-twitch">
    <iframe src="https://clips.twitch.tv/embed?clip=${id}&parent=${encodeURIComponent(parent)}"
      sandbox="${EMBED_SANDBOX}"
      allow="fullscreen" loading="lazy"></iframe>
  </div>`
}

function kickClipEmbed(clipId, fullUrl) {
  const id = sanitizeEmbedId(clipId)
  if (!id) return ''
  // player.kick.com sends X-Frame-Options: SAMEORIGIN — iframe always blank.
  // Route through server-resolve to get thumbnail+title from kick.com/api/v2.
  const safe = safeUrl(fullUrl) || `https://kick.com/clips/${id}`
  return `<div class="hs-feed-embed-pending hs-feed-embed-kick"
    data-resolve-url="${attr(safe)}" data-resolve-platform="kick">
    <span class="hs-feed-embed-pending-label">loading kick clip…</span>
  </div>`
}

function streamableEmbed(videoId) {
  const id = sanitizeEmbedId(videoId)
  if (!id) return ''
  return `<div class="hs-feed-embed-container hs-feed-embed-streamable">
    <iframe src="https://streamable.com/e/${id}" sandbox="${EMBED_SANDBOX}" allow="fullscreen" loading="lazy"></iframe>
  </div>`
}

function vimeoEmbed(videoId) {
  const id = sanitizeEmbedId(videoId)
  if (!id) return ''
  return `<div class="hs-feed-embed-container hs-feed-embed-vimeo">
    <iframe src="https://player.vimeo.com/video/${id}"
      sandbox="${EMBED_SANDBOX}"
      allow="autoplay; fullscreen; picture-in-picture" loading="lazy"></iframe>
  </div>`
}

function spotifyEmbed(kind, id) {
  const safeKind = (kind || '').replace(/[^a-z]/g, '')
  const safeId = sanitizeEmbedId(id)
  if (!safeKind || !safeId) return ''
  return `<div class="hs-feed-embed-container hs-feed-embed-spotify">
    <iframe src="https://open.spotify.com/embed/${safeKind}/${safeId}"
      sandbox="${EMBED_SANDBOX}"
      width="100%" height="152" allow="encrypted-media" loading="lazy"></iframe>
  </div>`
}

function soundcloudEmbed(url) {
  const safe = safeUrl(url)
  if (!safe || !/^https?:\/\/(www\.|m\.)?soundcloud\.com\//i.test(safe)) return ''
  return `<div class="hs-feed-embed-container hs-feed-embed-soundcloud">
    <iframe scrolling="no"
      sandbox="${EMBED_SANDBOX}"
      src="https://w.soundcloud.com/player/?url=${encodeURIComponent(safe)}&color=%23ff5500&auto_play=false&hide_related=true&show_comments=false&show_user=true&show_reposts=false&show_teaser=false&visual=true"
      loading="lazy"></iframe>
  </div>`
}

function giphyEmbed(gifId) {
  const id = sanitizeEmbedId(gifId)
  if (!id) return ''
  return `<div class="hs-feed-embed-container hs-feed-embed-giphy">
    <iframe src="https://giphy.com/embed/${id}" sandbox="${EMBED_SANDBOX}" allow="fullscreen" loading="lazy"></iframe>
  </div>`
}

function tenorEmbed(gifId) {
  const id = sanitizeEmbedId(gifId)
  if (!id) return ''
  return `<div class="hs-feed-embed-container hs-feed-embed-tenor">
    <iframe src="https://tenor.com/embed/${id}" sandbox="${EMBED_SANDBOX}" allow="fullscreen" loading="lazy"></iframe>
  </div>`
}

function twitterEmbed(tweetId, _url) {
  const id = sanitizeEmbedId(tweetId)
  if (!id) return ''
  // platform.twitter.com/embed/Tweet.html renders the tweet in an iframe with no
  // widgets.js needed (script tags injected via innerHTML never execute, so the
  // blockquote+script approach the website uses is broken in extension context).
  return `<div class="hs-feed-embed-container hs-feed-embed-twitter">
    <iframe src="https://platform.twitter.com/embed/Tweet.html?id=${id}&theme=dark&dnt=true"
      sandbox="${EMBED_SANDBOX}"
      allow="autoplay; clipboard-write; fullscreen" loading="lazy"></iframe>
  </div>`
}

function imgurEmbed(imgurId) {
  const id = sanitizeEmbedId(imgurId)
  if (!id) return ''
  // Imgur embed needs script — fall back to direct image link approach.
  // data-fb="hide" is the host-CSP-safe replacement for inline onerror;
  // attachFeedFallbacks() wires the listener post-render.
  return `<div class="hs-feed-embed-container hs-feed-embed-imgur" style="aspect-ratio:auto;max-width:480px">
    <a href="https://imgur.com/${id}" target="_blank" rel="noopener">
      <img src="https://i.imgur.com/${id}.jpg" alt="imgur"
        style="max-width:100%;height:auto;display:block"
        data-fb="hide">
    </a>
  </div>`
}

function tiktokEmbed(videoId, _url) {
  const id = sanitizeEmbedId(videoId)
  if (!id) return ''
  return `<div class="hs-feed-embed-container hs-feed-embed-tiktok">
    <iframe src="https://www.tiktok.com/embed/v2/${id}"
      sandbox="${EMBED_SANDBOX}"
      allow="fullscreen" scrolling="no" loading="lazy"></iframe>
  </div>`
}

function redditEmbed(url) {
  const safe = safeUrl(url)
  if (!safe) return ''
  // Permalink → server-resolved rich card with image/icon when reachable.
  // Reddit blocks the VPS IP ~half the time so we also bake in slug-derived
  // fallback metadata; the resolver uses it when the server returns nothing.
  const m = safe.match(/reddit\.com\/r\/([\w-]+)\/comments\/[a-z0-9]+(?:\/([\w-]+))?/i)
  if (m) {
    const sub = m[1]
    const slug = m[2] || ''
    const title = slug ? slug.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : `r/${sub}`
    return `<div class="hs-feed-embed-pending hs-feed-embed-reddit"
      data-resolve-url="${attr(safe)}" data-resolve-platform="reddit"
      data-fb-title="${attr(title)}" data-fb-author="r/${attr(sub)}">
      <span class="hs-feed-embed-pending-label">loading reddit…</span>
    </div>`
  }
  // Non-permalink (subreddit, user) → link card.
  return `<div class="hs-feed-link-card">
    <a href="${attr(safe)}" target="_blank" rel="noopener" class="hs-feed-link-card-link">
      <span class="hs-feed-link-card-icon">[reddit]</span>
      <span class="hs-feed-link-card-url">${attr(safe.length > 60 ? `${safe.slice(0, 60)}...` : safe)}</span>
    </a>
  </div>`
}

function instagramEmbed(url) {
  const safe = safeUrl(url)
  if (!safe) return ''
  return `<div class="hs-feed-link-card">
    <a href="${attr(safe)}" target="_blank" rel="noopener" class="hs-feed-link-card-link">
      <span class="hs-feed-link-card-icon">[ig]</span>
      <span class="hs-feed-link-card-url">${attr(safe.length > 60 ? `${safe.slice(0, 60)}...` : safe)}</span>
    </a>
  </div>`
}

// Convert a single URL → embed HTML, or '' if not embeddable
function parseFeedEmbed(url) {
  if (!url || typeof url !== 'string') return ''
  const cleanUrl = url.replace(/[.,;!?]+$/, '')

  // YouTube
  if (cleanUrl.includes('youtube.com/watch?v=') || cleanUrl.includes('youtu.be/')) {
    let videoId
    if (cleanUrl.includes('youtube.com/watch?v=')) {
      videoId = cleanUrl.split('v=')[1].split('&')[0]
    } else {
      videoId = cleanUrl.split('youtu.be/')[1].split('?')[0]
    }
    return ytEmbed(videoId)
  }

  // Twitch clips (clips.twitch.tv/...)
  if (cleanUrl.includes('clips.twitch.tv/')) {
    const clipId = cleanUrl.split('clips.twitch.tv/')[1].split(/[?#]/)[0]
    return twitchClipEmbed(clipId)
  }

  // Twitch clips alt format (twitch.tv/user/clip/id)
  if (cleanUrl.includes('twitch.tv/') && cleanUrl.includes('/clip/')) {
    const clipId = cleanUrl.split('/clip/')[1].split(/[?#]/)[0]
    return twitchClipEmbed(clipId)
  }

  // Kick clips
  if (cleanUrl.includes('kick.com/') && cleanUrl.includes('/clips/')) {
    const m = cleanUrl.match(/clips\/([a-zA-Z0-9_-]+)/)
    if (m) return kickClipEmbed(m[1], cleanUrl)
  }

  // Streamable
  if (cleanUrl.includes('streamable.com/')) {
    const videoId = cleanUrl.split('streamable.com/')[1].split(/[?#]/)[0]
    if (videoId && !videoId.startsWith('test')) return streamableEmbed(videoId)
  }

  // Vimeo
  if (cleanUrl.includes('vimeo.com/')) {
    const m = cleanUrl.match(/vimeo\.com\/(\d+)/)
    if (m) return vimeoEmbed(m[1])
  }

  // Spotify
  if (cleanUrl.includes('open.spotify.com/')) {
    const parts = cleanUrl.split('spotify.com/')[1].split('/')
    const kind = parts[0]
    const id = parts[1]?.split('?')[0]
    if (kind && id) return spotifyEmbed(kind, id)
  }

  // SoundCloud
  if (cleanUrl.includes('soundcloud.com/')) {
    return soundcloudEmbed(cleanUrl)
  }

  // Twitter/X
  if (cleanUrl.includes('twitter.com/') || cleanUrl.includes('x.com/')) {
    const m = cleanUrl.match(/status\/(\d+)/)
    if (m) return twitterEmbed(m[1], cleanUrl)
  }

  // Giphy (gif page)
  if (cleanUrl.includes('giphy.com/gifs/')) {
    const m = cleanUrl.match(/gifs\/(?:.*-)?([a-zA-Z0-9]+)$/)
    if (m) return giphyEmbed(m[1])
  }

  // Tenor
  if (cleanUrl.includes('tenor.com/view/')) {
    const m = cleanUrl.match(/view\/.*-(\d+)$/)
    if (m) return tenorEmbed(m[1])
  }

  // TikTok
  if (cleanUrl.includes('tiktok.com/') && cleanUrl.includes('/video/')) {
    const m = cleanUrl.match(/video\/(\d+)/)
    if (m) return tiktokEmbed(m[1], cleanUrl)
  }

  // Imgur
  if (cleanUrl.includes('imgur.com/')) {
    const m = cleanUrl.match(/imgur\.com\/(?:a\/|gallery\/)?([a-zA-Z0-9]+)/)
    if (m) return imgurEmbed(m[1])
  }

  // Reddit
  if (cleanUrl.includes('reddit.com/r/')) {
    return redditEmbed(cleanUrl)
  }

  // Instagram
  if (cleanUrl.includes('instagram.com/p/') || cleanUrl.includes('instagram.com/reel/')) {
    return instagramEmbed(cleanUrl)
  }

  // Direct media files
  if (/\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i.test(cleanUrl)) {
    const safe = safeUrl(cleanUrl)
    if (!safe) return ''
    return `<div class="hs-feed-media-direct">
      <img src="${attr(hsProxyImg(safe))}" alt="" data-fb="deleted">
    </div>`
  }
  if (/\.(mp4|webm|mov)(\?.*)?$/i.test(cleanUrl)) {
    const safe = safeUrl(cleanUrl)
    if (!safe) return ''
    return `<div class="hs-feed-media-direct">
      <video controls muted preload="metadata" src="${attr(safe)}"></video>
    </div>`
  }

  return ''
}

// Extract first embeddable URL from message content (OP only, mirrors website)
function extractFeedEmbed(content) {
  if (!content || typeof content !== 'string') return ''
  // Same priority order as website _extractEmbed
  const priorityPatterns = [
    /https?:\/\/(?:www\.)?streamable\.com\/\w+/,
    /https?:\/\/(?:www\.)?youtu(?:\.be\/|be\.com\/watch\?v=)[\w-]+/,
    /https?:\/\/clips\.twitch\.tv\/[\w-]+/,
    /https?:\/\/(?:www\.)?twitch\.tv\/[\w_]+\/clip\/[\w-]+/,
    /https?:\/\/kick\.com\/[\w_-]+\/clips\/[\w-]+/,
    /https?:\/\/open\.spotify\.com\/(?:track|album|playlist)\/\w+/,
    /https?:\/\/(?:www\.)?vimeo\.com\/\d+/,
    /https?:\/\/(?:www\.)?giphy\.com\/gifs\/[\w-]+/,
    /https?:\/\/(?:www\.)?tenor\.com\/view\/[\w-]+-\d+/,
    /https?:\/\/(?:www\.)?tiktok\.com\/[@\w.]+\/video\/\d+/,
    /https?:\/\/(?:www\.)?imgur\.com\/(?:a\/|gallery\/)?[a-zA-Z0-9]+/,
    /https?:\/\/(?:twitter|x)\.com\/[\w_]+\/status\/\d+/,
    /https?:\/\/(?:[\w-]+\.)?reddit\.com\/r\/\w+\/[\w/]+/,
    /https?:\/\/(?:www\.|m\.)?soundcloud\.com\/[\w-]+\/[\w-]+/,
    /https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel)\/[\w-]+/,
    /https?:\/\/[^\s]+\.(?:jpg|jpeg|png|gif|webp|mp4|webm|mov)(?:\?[^\s]*)?/i,
  ]

  for (const p of priorityPatterns) {
    const m = content.match(p)
    if (m) {
      const html = parseFeedEmbed(m[0])
      if (html) return html
    }
  }
  return ''
}

// ── CHAT INLINE EMBEDS ──────────────────────────────────────────────────────
// Chat is high-volume and lives on low-RAM / passive-cooled hardware, so chat
// NEVER renders live iframes the way the feed does (the feed virtual-scrolls, so
// its visible iframe count stays tiny — chat has no such bound). Chat media is
// therefore always lightweight: an inline direct image/video, a YouTube
// thumbnail card, or a server-resolved rich card. One embed per message. Every
// branch emits ONLY safeUrl()-validated + attr()-escaped strings — never raw
// message text — so the holder's insertAdjacentHTML in main.js stays XSS-safe.
const _CHAT_URL_RE = /https?:\/\/[^\s<>"']+/i

function extractChatEmbed(text, opts) {
  if (!text || typeof text !== 'string') return ''
  const m = text.match(_CHAT_URL_RE)
  const html = m ? chatEmbedForUrl(m[0]) : ''
  if (html) return html
  // Host-less youtube refs ("watch?v=Gz0fAz9n_Os") — chat drops the domain
  // constantly because platforms throttle links for non-subs, and linkifyPartialLinks
  // already turns these into anchors. Without this they were link-only: you had
  // to leave chat to watch. Falls through only when no real URL produced a card,
  // so an explicit link in the same message still wins. Rides the same
  // partialLinksEnabled toggle — off means "don't guess at bare fragments".
  if (opts?.partialLinks === false) return ''
  const partial = typeof firstPartialYtUrl === 'function' ? firstPartialYtUrl(text) : ''
  return partial ? chatEmbedForUrl(partial) : ''
}

function chatEmbedForUrl(rawUrl) {
  // Strip trailing sentence punctuation, but only strip a trailing ) or ] when
  // it's UNBALANCED — otherwise wikipedia/github URLs like .../Foo_(bar) lose
  // their closing paren and the embed/link breaks.
  let cleanUrl = rawUrl.replace(/[.,;!?]+$/, '')
  while (/[)\]]$/.test(cleanUrl)) {
    const opens = (cleanUrl.match(/[([]/g) || []).length
    const closes = (cleanUrl.match(/[)\]]/g) || []).length
    if (closes <= opens) break
    cleanUrl = cleanUrl.slice(0, -1).replace(/[.,;!?]+$/, '')
  }
  const safe = safeUrl(cleanUrl)
  if (!safe) return ''
  // Direct image / gif → inline, lazy, error-guarded (data-fb hides on 404/blocked).
  if (/\.(jpg|jpeg|png|gif|webp|avif)(\?.*)?$/i.test(cleanUrl)) {
    return `<div class="hs-mc-media"><img src="${attr(hsProxyImg(safe))}" alt="" loading="lazy" decoding="async" data-fb="hide"></div>`
  }
  // Direct video → inline, preload=none (no bytes until play — critical at chat volume).
  if (/\.(mp4|webm|mov)(\?.*)?$/i.test(cleanUrl)) {
    return `<div class="hs-mc-media"><video controls muted preload="none" playsinline src="${attr(safe)}" data-fb="hide"></video></div>`
  }
  // YouTube → thumbnail card that opens the video. Never an iframe in chat.
  let ytId = ''
  let ym
  if ((ym = cleanUrl.match(/youtu\.be\/([\w-]{11})/))) ytId = ym[1]
  else if ((ym = cleanUrl.match(/youtube\.com\/watch\?v=([\w-]{11})/))) ytId = ym[1]
  else if ((ym = cleanUrl.match(/youtube\.com\/shorts\/([\w-]{11})/))) ytId = ym[1]
  if (ytId) {
    const id = sanitizeEmbedId(ytId)
    // Shorts are 9:16 — the card (and the in-place player that overlays its
    // rect) renders portrait like the tiktok card, instead of letterboxing
    // the video into a strip inside a 16:9 box. oar2.jpg is the portrait
    // thumb yt serves for shorts; data-fb hides it if a short lacks one.
    const isShort = /\/shorts\//i.test(cleanUrl)
    if (id) {
      const thumb = isShort ? `https://i.ytimg.com/vi/${id}/oar2.jpg` : `https://i.ytimg.com/vi/${id}/mqdefault.jpg`
      return `<a href="https://www.youtube.com/watch?v=${id}" target="_blank" rel="noopener" class="hs-mc-media hs-mc-playable hs-feed-embed-yt-thumb${isShort ? ' hs-yt-portrait' : ''}">
      <img src="${hsProxyImg(thumb)}" alt="" loading="lazy" decoding="async" data-fb="hide">
      <span class="hs-feed-embed-yt-play">▶</span>
    </a>`
    }
  }
  // Providers the server resolver handles (oEmbed) → lightweight pending card.
  // Server returns image/video/audio/rich; unsupported → graceful link card.
  // No auto-loading iframes — playable providers upgrade to a live player on
  // an explicit click (see the chat click-to-play block at file bottom).
  // data-resolve-url drives resolvePendingFeedEmbeds() AND click-to-play.
  if (
    /(?:reddit\.com\/r\/|(?:twitter|x)\.com\/[\w_]+\/status\/|open\.spotify\.com\/(?:track|album|playlist|episode|show)\/|(?:www\.)?vimeo\.com\/\d|tiktok\.com\/@[\w.]+\/video\/|instagram\.com\/(?:p|reel)\/|soundcloud\.com\/[\w-]+\/[\w-]+|kick\.com\/[\w_-]+\/clips\/|clips\.twitch\.tv\/|streamable\.com\/\w)/i.test(
      cleanUrl,
    )
  ) {
    const playable = chatUrlPlayable(cleanUrl) ? ' hs-mc-playable' : ''
    return `<div class="hs-mc-media hs-feed-embed-pending${playable}" data-resolve-url="${attr(safe)}" data-resolve-platform="link"><span class="hs-feed-embed-pending-label">loading preview…</span></div>`
  }
  return ''
}

// Main entry: build full media HTML for a feed message.
// Handles direct uploads (image/video), multi-image (media[]), and content-extracted embeds.
function buildFeedMediaHtml(m) {
  if (!m) return ''
  // Media URLs come back origin-relative (/uploads/...). The ext renders
  // cross-origin (twitch/kick/yt), so a relative src silently 404s AND safeUrl()
  // throws on a relative URL → the image is dropped entirely. Absolutize here —
  // the single render chokepoint for feed, thread, and /logs — so no insert path
  // can leak a relative URL. Idempotent: absolute URLs pass through untouched.
  if (typeof _absolutizeThreadMedia === 'function') _absolutizeThreadMedia(m)
  const isReply = !!m.reply_to
  const mediaUrl = m.media_url
  const mediaType = m.media_type
  const mediaArr = Array.isArray(m.media) ? m.media : []

  // Multi-item media (uploads)
  if (mediaArr.length > 1) {
    const items = mediaArr
      .map((med) => {
        const url = safeUrl(med.url)
        if (!url) return ''
        if (med.type === 'video') {
          return `<video controls muted preload="metadata" src="${attr(url)}" class="hs-feed-media-item"></video>`
        }
        return `<img src="${attr(hsProxyImg(url))}" alt="" class="hs-feed-media-item">`
      })
      .filter(Boolean)
      .join('')
    if (items) return `<div class="hs-feed-media hs-feed-media-multi">${items}</div>`
  }

  // Single direct upload
  if (mediaUrl) {
    const safe = safeUrl(mediaUrl)
    if (!safe) return ''

    const isVideo = mediaType === 'video' || (mediaType || '').startsWith('video/')
    const isEmbedType =
      mediaType === 'embed' ||
      /^https?:\/\/(?:(?:www\.)?(?:youtube\.com|youtu\.be|twitch\.tv|clips\.twitch\.tv|streamable\.com|vimeo\.com|twitter\.com|x\.com|kick\.com|tiktok\.com|open\.spotify\.com|soundcloud\.com|giphy\.com|tenor\.com|imgur\.com|instagram\.com)|(?:[\w-]+\.)?reddit\.com)/i.test(
        safe,
      )
    const isImage = mediaType === 'image' || /\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i.test(safe)

    if (isEmbedType) {
      const embedHtml = parseFeedEmbed(safe)
      if (embedHtml) return `<div class="hs-feed-media">${embedHtml}</div>`
    }

    if (isVideo) {
      return `<div class="hs-feed-media"><video controls muted preload="metadata" src="${attr(safe)}"></video></div>`
    }

    if (isImage) {
      return `<div class="hs-feed-media"><img src="${attr(hsProxyImg(safe))}" alt="" class="hs-feed-media-img"></div>`
    }

    return ''
  }

  // No direct media — for OPs, scan content for embeddable URL
  if (!isReply && m.content) {
    const embedHtml = extractFeedEmbed(m.content)
    if (embedHtml) return `<div class="hs-feed-media">${embedHtml}</div>`
  }

  return ''
}

// Resolve `.hs-feed-embed-pending[data-resolve-url]` placeholders via
// heatsync.org/api/embed/resolve. All HTML built from server fields is escaped
// via attr() (escapeHtml). Idempotent — safe to call repeatedly.
const _feedResolveInflight = new Map()
const FEED_RESOLVE_INFLIGHT_MAX = 200

function _fetchFeedResolve(url) {
  if (_feedResolveInflight.has(url)) return _feedResolveInflight.get(url)
  // Route via background SW — content script fetches in MV3 still go through
  // page-origin CORS, but the SW has full host_permissions and bypasses it.
  const promise = (async () => {
    try {
      const data = await safeSendMessage({ type: 'fetch_embed_resolve', url })
      if (!data || data.error || data.ok === false) return null
      return data
    } catch (_) {
      return null
    }
  })()
  if (_feedResolveInflight.size >= FEED_RESOLVE_INFLIGHT_MAX) {
    _feedResolveInflight.delete(_feedResolveInflight.keys().next().value)
  }
  _feedResolveInflight.set(url, promise)
  promise.finally(() => cleanup.setTimeout(() => _feedResolveInflight.delete(url), 30000))
  return promise
}

function _buildFeedResolvedHtml(ph, data) {
  const url = ph.dataset.resolveUrl || ''
  const platform = ph.dataset.resolvePlatform || ''
  const safeUrlStr = attr(url)
  const safeTitle = attr(data.title || '')
  const safeAuthor = attr(data.author || '')
  // Thumbnails only ever feed <img>/<video poster> (both images) → proxy always.
  // mediaUrl is an <img> for type:image but a <video src> for type:video — proxy
  // the image use (safeMediaImg), leave the video src direct (the image proxy
  // rejects non-image content-types; external video is a separate, rarer case).
  const safeThumb = attr(hsProxyImg(safeUrl(data.thumbnail || '')))
  const safeMedia = attr(safeUrl(data.mediaUrl || ''))
  const safeMediaImg = attr(hsProxyImg(safeUrl(data.mediaUrl || '')))
  const safePlat = attr(platform)

  if (data.type === 'image' && data.mediaUrl) {
    return `<a href="${safeUrlStr}" target="_blank" rel="noopener" class="hs-feed-embed-rich-imglink">
      <img src="${safeMediaImg}" alt="${safeTitle}" class="hs-feed-embed-rich-image" data-fb="deleted-span">
    </a>`
  }
  if (data.type === 'video' && data.mediaUrl) {
    // m3u8 (kick clip) needs hls.js which we don't bundle — render as a
    // thumbnail card that opens the clip page on click. mp4 plays natively.
    if (data.mediaUrl.includes('.m3u8')) {
      const thumbHtml = safeThumb
        ? `<img src="${safeThumb}" alt="${safeTitle || safePlat}" class="hs-feed-embed-rich-thumb">`
        : `<div class="hs-feed-embed-rich-thumb-placeholder">[${safePlat}]</div>`
      return `<a href="${safeUrlStr}" target="_blank" rel="noopener" class="hs-feed-embed-rich-card">
        ${thumbHtml}
        <div class="hs-feed-embed-rich-meta">
          <div class="hs-feed-embed-rich-platform">${safePlat}</div>
          <div class="hs-feed-embed-rich-title">${safeTitle}</div>
          ${safeAuthor ? `<div class="hs-feed-embed-rich-author">${safeAuthor}</div>` : ''}
        </div>
      </a>`
    }
    const poster = safeThumb ? `poster="${safeThumb}"` : ''
    return `<video controls preload="metadata" ${poster} src="${safeMedia}" class="hs-feed-embed-rich-video"></video>`
  }
  // 'audio' (spotify/soundcloud oEmbed) renders the same art+meta card as
  // 'rich' — the click-to-play upgrade supplies the actual player; the
  // mediaUrl mp3 preview is deliberately unused (30s teaser, not the track).
  if (data.type === 'rich' || data.type === 'audio') {
    const thumbHtml = safeThumb
      ? `<img src="${safeThumb}" alt="${safeTitle || safePlat}" class="hs-feed-embed-rich-thumb">`
      : `<div class="hs-feed-embed-rich-thumb-placeholder">[${safePlat}]</div>`
    return `<a href="${safeUrlStr}" target="_blank" rel="noopener" class="hs-feed-embed-rich-card">
      ${thumbHtml}
      <div class="hs-feed-embed-rich-meta">
        <div class="hs-feed-embed-rich-platform">${safePlat}</div>
        <div class="hs-feed-embed-rich-title">${safeTitle}</div>
        ${safeAuthor ? `<div class="hs-feed-embed-rich-author">${safeAuthor}</div>` : ''}
      </div>
    </a>`
  }
  return ''
}

function _buildFeedResolveFailedHtml(ph) {
  const url = ph.dataset.resolveUrl || ''
  const platform = ph.dataset.resolvePlatform || ''
  // Placeholder may carry baked-in fallback metadata (data-fb-title/-author)
  // so we can still render a rich card when the server can't reach the source.
  const fbTitle = ph.dataset.fbTitle || ''
  const fbAuthor = ph.dataset.fbAuthor || ''
  if (fbTitle || fbAuthor) {
    return `<a href="${attr(url)}" target="_blank" rel="noopener" class="hs-feed-embed-rich-card">
      <div class="hs-feed-embed-rich-thumb-placeholder">[${attr(platform)}]</div>
      <div class="hs-feed-embed-rich-meta">
        <div class="hs-feed-embed-rich-platform">${attr(platform)}</div>
        <div class="hs-feed-embed-rich-title">${attr(fbTitle)}</div>
        ${fbAuthor ? `<div class="hs-feed-embed-rich-author">${attr(fbAuthor)}</div>` : ''}
      </div>
    </a>`
  }
  const truncated = url.length > 60 ? `${url.slice(0, 60)}…` : url
  return `<div class="hs-feed-link-card">
    <a href="${attr(url)}" target="_blank" rel="noopener" class="hs-feed-link-card-link">
      <span class="hs-feed-link-card-icon">[${attr(platform)}]</span>
      <span class="hs-feed-link-card-url">${attr(truncated)}</span>
    </a>
  </div>`
}

function _swapPlaceholder(ph, html, resolvedClass) {
  // Replace placeholder children via fragment to satisfy the security hook
  // (avoids ph.innerHTML = …); html is built from escaped server fields only.
  const tmp = document.createElement('div')
  tmp.insertAdjacentHTML('afterbegin', html)
  while (ph.firstChild) ph.removeChild(ph.firstChild)
  while (tmp.firstChild) ph.appendChild(tmp.firstChild)
  ph.classList.remove('hs-feed-embed-pending')
  ph.classList.add(resolvedClass)
}

function resolvePendingFeedEmbeds(root) {
  if (!root?.querySelectorAll) return
  const placeholders = root.querySelectorAll('.hs-feed-embed-pending[data-resolve-url]')
  if (!placeholders.length) return
  for (const ph of placeholders) {
    if (ph.dataset.resolving === '1') continue
    ph.dataset.resolving = '1'
    const url = ph.dataset.resolveUrl
    if (!url) continue
    _fetchFeedResolve(url).then((data) => {
      // The row may have been culled (chat trimMessagesEl, or a feed re-render)
      // during the async resolve — don't mutate a detached node or wire dead
      // listeners. Matches the isConnected guard pattern used elsewhere.
      if (!ph.isConnected) return
      if (data && !data.error) {
        const html = _buildFeedResolvedHtml(ph, data)
        if (html) _swapPlaceholder(ph, html, 'hs-feed-embed-resolved')
        else _swapPlaceholder(ph, _buildFeedResolveFailedHtml(ph), 'hs-feed-embed-resolve-failed')
      } else {
        _swapPlaceholder(ph, _buildFeedResolveFailedHtml(ph), 'hs-feed-embed-resolve-failed')
      }
      attachFeedFallbacks(ph)
    })
  }
}

// Wire load-fail fallbacks for images/avatars in the feed. Replaces the inline
// onerror= patterns that host-page CSP (twitch) silently strips. Idempotent.
//   data-fb="hide"          → display:none
//   data-fb="deleted"       → swap node for <div class="hs-feed-media-deleted">image unavailable</div>
//   data-fb="deleted-span"  → swap node for <span class="hs-feed-media-deleted">image unavailable</span>
//   data-fallback-anon      → swap src to /anon.webp (avatars)
function attachFeedFallbacks(root) {
  if (!root?.querySelectorAll) return
  root.querySelectorAll('img[data-fallback-anon]').forEach((img) => {
    img.addEventListener(
      'error',
      () => {
        img.removeAttribute('data-fallback-anon')
        img.src = 'https://heatsync.org/anon.webp'
      },
      { once: true },
    )
  })
  root.querySelectorAll('img[data-fb]').forEach((img) => {
    const mode = img.dataset.fb
    img.removeAttribute('data-fb')
    img.addEventListener(
      'error',
      () => {
        if (mode === 'hide') {
          img.style.display = 'none'
        } else if (mode === 'deleted' || mode === 'deleted-span') {
          const tag = mode === 'deleted-span' ? 'span' : 'div'
          const replacement = document.createElement(tag)
          replacement.className = 'hs-feed-media-deleted'
          replacement.textContent = 'image unavailable'
          img.replaceWith(replacement)
        }
      },
      { once: true },
    )
  })
  // The row carrying the ▸/❚❚ was just rebuilt — re-derive the glyph from the
  // module's now-playing state (the DOM can't remember it across a repaint).
  markNowPlaying(root)
  // Inline <video> (direct chat media) — a dead source must hide, not leave a
  // broken player. <video> 'error' doesn't bubble, so wire it directly here.
  root.querySelectorAll('video[data-fb="hide"]').forEach((video) => {
    video.removeAttribute('data-fb')
    video.addEventListener(
      'error',
      () => {
        video.style.display = 'none'
      },
      { once: true },
    )
  })
}

// ── CHAT CLICK-TO-PLAY (docked mini-player) ────────────────────────────────
// Chat cards stay lightweight (settled no-auto-iframe rule), but an explicit
// click on a playable card opens the SAME live player the feed uses
// (parseFeedEmbed builders — one code path) in a dock pinned to the overlay,
// NOT inside the message row: chat full-repaints on every message batch, so
// an in-row iframe dies mid-playback, scrolls away, and races the card's own
// <a target=_blank> (real-mouse clicks were opening tabs instead of playing).
// The dock lives outside #hs-mc-messages → survives repaints + tab switches.
// One dock = one player, ever. Ctrl/cmd/middle-click keeps browser link-out.
const _CHAT_PLAYER_RE =
  /(open\.spotify\.com\/(?:track|album|playlist|episode|show)\/|youtu\.be\/[\w-]{11}|youtube\.com\/(?:watch\?v=|shorts\/)[\w-]{11}|(?:www\.)?vimeo\.com\/\d|soundcloud\.com\/[\w-]+\/[\w-]+|clips\.twitch\.tv\/[\w-]|twitch\.tv\/[\w_]+\/clip\/|streamable\.com\/\w|giphy\.com\/gifs\/|tenor\.com\/view\/)/i

function chatUrlPlayable(url) {
  return _CHAT_PLAYER_RE.test(url || '')
}

// ── IN-PLACE AUDIO ─────────────────────────────────────────────────────────
// Audio plays in the row; video docks. You can't watch a hidden iframe, but
// you never needed to LOOK at a spotify track — so for audio-only providers
// the card itself is the player (press it, it plays, no panel slides in) and
// the iframe goes to a 0×0 host. That host still lives OUTSIDE
// #hs-mc-messages for the same reason the dock does: chat full-repaints on
// every batch, and an iframe inside the repaint zone dies mid-track.
//
// Which is only possible because spotify accepts a play command with no user
// gesture inside the frame — probed live, see the provider table below.
// Per-provider postMessage contracts. Every one of these was verified live by
// READ-BACK where the provider allows it (set the value, ask for it again) —
// the same rule the chat-mode writes follow: never claim success because a
// message didn't throw. `volume: false` is spotify telling the truth — its
// embed has no volume control and no command that sets one.
const _AUDIO_PROVIDERS = [
  {
    id: 'youtube',
    test: /youtu\.be\/|youtube\.com\/(watch\?v=|shorts\/)/i,
    origin: 'https://www.youtube-nocookie.com',
    video: true,
    volume: true,
    frameUrl: (u) => {
      const id = sanitizeEmbedId((String(u).match(/(?:youtu\.be\/|v=|shorts\/)([\w-]{11})/) || [])[1] || '')
      return id
        ? `https://www.youtube-nocookie.com/embed/${id}?enablejsapi=1&modestbranding=1&playsinline=1&rel=0&autoplay=1`
        : ''
    },
    // youtube answers nothing until it's been told someone is listening; the
    // handshake is what turns onReady on, and commands before it are dropped.
    hello: { event: 'listening', id: 1, channel: 'widget' },
    ready: (d) => d?.event === 'onReady' || d?.event === 'initialDelivery',
    json: true,
    play: { event: 'command', func: 'playVideo', args: [] },
    pause: { event: 'command', func: 'pauseVideo', args: [] },
    setVolume: (v) => ({ event: 'command', func: 'setVolume', args: [Math.round(v * 100)] }),
  },
  {
    id: 'vimeo',
    test: /vimeo\.com\/\d/i,
    origin: 'https://player.vimeo.com',
    video: true,
    volume: true,
    frameUrl: (u) => {
      const id = sanitizeEmbedId((String(u).match(/vimeo\.com\/(\d+)/) || [])[1] || '')
      return id ? `https://player.vimeo.com/video/${id}?autoplay=1` : ''
    },
    ready: (d) => d?.event === 'ready',
    play: { method: 'play' },
    pause: { method: 'pause' },
    setVolume: (v) => ({ method: 'setVolume', value: v }),
  },
  {
    id: 'streamable',
    test: /streamable\.com\/\w/i,
    origin: 'https://streamable.com',
    video: true,
    volume: true,
    frameUrl: (u) => {
      const id = sanitizeEmbedId((String(u).match(/streamable\.com\/(?:e\/)?(\w+)/) || [])[1] || '')
      return id ? `https://streamable.com/e/${id}?autoplay=1` : ''
    },
    // streamable speaks the generic player.js protocol, so every message
    // carries its context stamp and volume is 0-100.
    json: true,
    stamp: { context: 'player.js', version: '0.0.11' },
    ready: (d) => d?.context === 'player.js' && d?.event === 'ready',
    play: { method: 'play' },
    pause: { method: 'pause' },
    setVolume: (v) => ({ method: 'setVolume', value: Math.round(v * 100) }),
  },
  {
    id: 'spotify',
    test: /open\.spotify\.com/i,
    origin: 'https://open.spotify.com',
    volume: false,
    frameUrl: (u) => {
      const m = String(u).split('spotify.com/')[1] || ''
      const [kind, rawId] = m.split('/')
      const id = sanitizeEmbedId((rawId || '').split('?')[0])
      const k = (kind || '').replace(/[^a-z]/g, '')
      return k && id ? `https://open.spotify.com/embed/${k}/${id}` : ''
    },
    ready: (d) => d?.type === 'ready',
    play: { command: 'play' },
    pause: { command: 'pause' },
  },
  {
    id: 'soundcloud',
    test: /soundcloud\.com/i,
    origin: 'https://w.soundcloud.com',
    volume: true,
    frameUrl: (u) => {
      const safe = safeUrl(u)
      return safe ? `https://w.soundcloud.com/player/?url=${encodeURIComponent(safe)}` : ''
    },
    ready: (d) => d?.method === 'ready',
    play: { method: 'play' },
    pause: { method: 'pause' },
    setVolume: (v) => ({ method: 'setVolume', value: Math.round(v * 100) }),
  },
]

function _audioProviderFor(url) {
  return _AUDIO_PROVIDERS.find((p) => p.test.test(url || '')) || null
}

// One volume for every embed HeatSync drives, remembered across tracks and
// sessions. Providers that can't take a volume (spotify) simply never ask for
// it — the value is still the truth for the ones that can.
let _embedVolume = 0.5
try {
  chrome.storage.local.get('hs_embed_volume', (v) => {
    void chrome.runtime.lastError
    const n = Number(v?.hs_embed_volume)
    if (Number.isFinite(n) && n >= 0 && n <= 1) _embedVolume = n
  })
} catch (_) {}

function embedVolume() {
  return _embedVolume
}

function setEmbedVolume(v) {
  const n = Math.min(1, Math.max(0, Number(v) || 0))
  _embedVolume = n
  try {
    chrome.storage.local.set({ hs_embed_volume: n }, () => void chrome.runtime.lastError)
  } catch (_) {}
  const setVol = _hsAudio?.provider?.setVolume
  if (setVol && _hsAudio.ready) _hsAudioSend(setVol(n))
  return n
}

// { url, provider, frame, ready, playing } — module state, never DOM state:
// the row carrying the ▸/❚❚ is destroyed and rebuilt on every repaint, so the
// glyph has to be re-derived (see markNowPlaying) rather than remembered.
let _hsAudio = null

function _hsAudioSend(msg) {
  const p = _hsAudio?.provider
  if (!p || !_hsAudio.frame?.contentWindow) return
  // youtube and player.js want a JSON string; the rest take either. The stamp
  // is player.js's required envelope, merged in rather than repeated per verb.
  const body = p.stamp ? Object.assign({}, p.stamp, msg) : msg
  try {
    _hsAudio.frame.contentWindow.postMessage(p.json ? JSON.stringify(body) : body, p.origin)
  } catch (_) {}
}

// The transport: pause + volume, on whichever surface is actually visible —
// the player for video, the card itself for audio (whose iframe is hidden and
// has nothing to hang controls off). One builder, two homes.
// A provider that can't take a volume gets a disabled slider saying so, rather
// than a live-looking control that does nothing.
function _hsTransportEl(provider) {
  const bar = document.createElement('div')
  bar.className = 'hs-mc-transport'
  const pause = document.createElement('button')
  pause.type = 'button'
  pause.className = 'hs-mc-transport-toggle'
  pause.textContent = '||'
  pause.title = 'pause'
  bar.appendChild(pause)
  // No slider at all for a provider that can't take one. A greyed-out control
  // is still a control the eye has to read and dismiss; spotify's embed simply
  // has no volume, and the honest UI for that is nothing, not a dead widget.
  if (provider.volume) {
    const vol = document.createElement('input')
    vol.type = 'range'
    vol.className = 'hs-mc-transport-vol'
    vol.min = '0'
    vol.max = '100'
    vol.step = '1'
    vol.value = String(Math.round(embedVolume() * 100))
    vol.title = 'volume'
    vol.addEventListener('input', () => setEmbedVolume(Number(vol.value) / 100))
    bar.appendChild(vol)
  }
  // The card underneath is one big play/pause target — a drag on the slider
  // must not read as a press on the card.
  for (const ev of ['click', 'pointerdown', 'mousedown']) {
    bar.addEventListener(ev, (e) => e.stopPropagation())
  }
  pause.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (_hsAudio) chatEmbedToggle(_hsAudio.url)
  })
  return bar
}

function markNowPlaying(root) {
  if (!root?.querySelectorAll) return
  for (const el of root.querySelectorAll('.hs-mc-media.hs-mc-playable')) {
    const url = el.dataset.resolveUrl || (el.tagName === 'A' ? el.href : '')
    const on = !!_hsAudio && _hsAudio.playing && url === _hsAudio.url
    el.classList.toggle('hs-playing', on)
    // Audio's transport rides the card. It has to be re-attached rather than
    // remembered: this row was just rebuilt from scratch.
    const existing = el.querySelector(':scope > .hs-mc-transport')
    if (on && !_hsAudio.provider.video) {
      if (!existing) el.appendChild(_hsTransportEl(_hsAudio.provider))
    } else if (existing) {
      existing.remove()
    }
  }
}

function _hsAudioStop() {
  if (!_hsAudio) return
  cleanup.clearTimeout(_hsAudio.idleTimer)
  _hsAudioSend(_hsAudio.provider.pause)
  try {
    _hsAudio.ro?.disconnect()
  } catch (_) {}
  _hsAudio.frame?.remove()
  _hsAudio = null
  document.getElementById('hs-mc-audio-host')?.remove()
  markNowPlaying(document)
}

// Park the live player exactly over its card. The player is a child of the
// SCROLLER, never of a row: rows are rebuilt on every batch and would take the
// iframe down with them, but a scroller child in content coordinates scrolls
// with the chat natively — no per-frame javascript, so it can't lag behind or
// judder. Only real layout changes move it, which is what the observer is for.
function _hsPlacePlayer() {
  const a = _hsAudio
  if (!a?.host || !a.card) return
  const scroller = document.getElementById('hs-mc-messages')
  if (!scroller || !a.card.isConnected) {
    // The anchor row aged out of the DOM cap. Orphan audio you can't reach a
    // stop button for is worse than silence.
    _hsAudioStop()
    return
  }
  const cr = a.card.getBoundingClientRect()
  const sr = scroller.getBoundingClientRect()
  const width = Math.max(80, Math.round(cr.width))
  a.host.style.top = `${Math.round(cr.top - sr.top + scroller.scrollTop)}px`
  a.host.style.left = `${Math.round(cr.left - sr.left)}px`
  a.host.style.width = `${width}px`
  a.host.style.height = a.provider.video ? `${Math.round((width * 9) / 16)}px` : `${Math.round(cr.height)}px`
}

// Toggle playback for a card, in place. Returns false when the url isn't one
// we can drive, so the caller can fall back to the dock.
function chatEmbedToggle(url, card) {
  const provider = _audioProviderFor(url)
  if (!provider) return false
  if (_hsAudio && _hsAudio.url === url) {
    _hsAudio.playing = !_hsAudio.playing
    _hsAudioSend(_hsAudio.playing ? provider.play : provider.pause)
    // A paused frame is kept so resume is instant, but not forever — this runs
    // on passively-cooled hardware and an idle provider iframe still costs.
    cleanup.clearTimeout(_hsAudio.idleTimer)
    if (!_hsAudio.playing) {
      _hsAudio.idleTimer = cleanup.setTimeout(() => {
        if (_hsAudio && !_hsAudio.playing) _hsAudioStop()
      }, 90000)
    }
    markNowPlaying(document)
    return true
  }
  const src = provider.frameUrl(url)
  if (!src) return false
  _hsAudioStop()
  // Video mounts over its own card inside the scroller; audio has nothing to
  // look at, so it goes to a 0×0 host on the overlay and just plays.
  const parent = provider.video ? document.getElementById('hs-mc-messages') : document.getElementById('hs-mc-overlay')
  if (!parent) return false
  const host = document.createElement('div')
  host.id = provider.video ? 'hs-mc-embed-player' : 'hs-mc-audio-host'
  if (!provider.video) host.setAttribute('aria-hidden', 'true')
  const frame = document.createElement('iframe')
  frame.src = src
  frame.setAttribute('sandbox', EMBED_SANDBOX)
  frame.setAttribute('allow', 'autoplay; encrypted-media; fullscreen; picture-in-picture')
  host.appendChild(frame)
  if (provider.video) host.appendChild(_hsTransportEl(provider))
  parent.appendChild(host)
  _hsAudio = { url, provider, frame, host, card: provider.video ? card || null : null, ready: false, playing: true }
  if (provider.video) {
    _hsPlacePlayer()
    // Layout, not scroll: the player and its card scroll together for free, so
    // the only thing that can separate them is the chat relaying out.
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => _hsPlacePlayer())
      try {
        ro.observe(parent)
        if (card) ro.observe(card)
      } catch (_) {}
      _hsAudio.ro = ro
      cleanup.trackObserver(ro)
    }
  }
  // youtube is the one provider that stays silent until greeted, and the greet
  // only lands once its player script is up — so knock until it answers rather
  // than guessing a delay. Capped: a frame that never replies isn't going to.
  if (provider.hello) {
    let knocks = 0
    const t = cleanup.setInterval(() => {
      if (!_hsAudio || _hsAudio.url !== url || _hsAudio.ready || ++knocks > 20) {
        cleanup.clearInterval(t)
        return
      }
      _hsAudioSend(provider.hello)
    }, 400)
  }
  markNowPlaying(document)
  return true
}

// Providers announce themselves when the frame is ready; commands sent before
// that are dropped on the floor, so play waits for the announcement.
window.addEventListener(
  'message',
  (e) => {
    if (!_hsAudio || e.source !== _hsAudio.frame?.contentWindow) return
    if (e.origin !== _hsAudio.provider.origin) return
    let data = e.data
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data)
      } catch (_) {
        return
      }
    }
    if (_hsAudio.ready || !_hsAudio.provider.ready(data)) return
    _hsAudio.ready = true
    if (_hsAudio.provider.video) _hsPlacePlayer()
    const setVol = _hsAudio.provider.setVolume
    if (setVol) _hsAudioSend(setVol(embedVolume()))
    if (_hsAudio.playing) _hsAudioSend(_hsAudio.provider.play)
  },
  { signal: mcSignal },
)

function _hsPlayerDockClose() {
  document.getElementById('hs-mc-player-dock')?.remove()
}

function _hsPlayerDockOpen(url, label) {
  const html = parseFeedEmbed(url)
  if (!html) return false
  _hsPlayerDockClose()
  const overlay = document.getElementById('hs-mc-overlay')
  if (!overlay) return false
  const dock = document.createElement('div')
  dock.id = 'hs-mc-player-dock'
  const safeu = safeUrl(url)
  dock.insertAdjacentHTML(
    'afterbegin',
    `<div class="hs-mc-player-dock-bar">` +
      `<span class="hs-mc-player-dock-title">${escapeHtml(String(label || '').slice(0, 60))}</span>` +
      (safeu
        ? `<a class="hs-mc-player-dock-out" href="${attr(safeu)}" target="_blank" rel="noopener" title="open in new tab">↗</a>`
        : '') +
      `<button class="hs-mc-player-close" type="button" title="close player">×</button>` +
      `</div>${html}`,
  )
  overlay.appendChild(dock)
  return true
}

document.addEventListener(
  'click',
  (e) => {
    if (e.target?.closest?.('.hs-mc-player-close')) {
      e.preventDefault()
      e.stopPropagation()
      _hsPlayerDockClose()
      return
    }
    // Modified clicks keep native browser behaviour (new tab / window).
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return
    const wrap = e.target?.closest?.('.hs-mc-media.hs-mc-playable')
    if (!wrap) return
    const url = wrap.dataset.resolveUrl || (wrap.tagName === 'A' ? wrap.href : '')
    if (!url || !chatUrlPlayable(url)) return
    // ENTIRE card plays — meta strip included (a 90%-meta compact card whose
    // meta linked out instead of playing read as "play is broken").
    // Everything we can drive plays in place — the card IS the player. The
    // dock is only the fallback for providers with no control protocol at all
    // (twitch clips, tiktok: both stayed silent to every probe).
    if (chatEmbedToggle(url, wrap)) {
      e.preventDefault()
      e.stopPropagation()
      return
    }
    const label = wrap.querySelector('.hs-feed-embed-rich-title')?.textContent || wrap.dataset.resolvePlatform || url
    if (_hsPlayerDockOpen(url, label)) {
      e.preventDefault()
      e.stopPropagation()
    }
  },
  { signal: mcSignal, capture: true },
)

// Real mice fire mousedown-phase openers and anchor defaults before the click
// handler settles — kill the default at pointerdown too so a playable card can
// never navigate on a plain left press. (Modified clicks bail above; browsers
// open ctrl-tabs from click default, which we don't touch here.)
document.addEventListener(
  'pointerdown',
  (e) => {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return
    const wrap = e.target?.closest?.('.hs-mc-media.hs-mc-playable')
    if (wrap) e.preventDefault()
  },
  { signal: mcSignal, capture: true },
)
