// chat-logs.js — chat archive viewer panel.
// Opens via right-click → "chat logs". Hijacks #hs-mc-messages (same pattern
// as profile-card.js). Infinite scroll up via cursor pagination against
// /api/archive/user/:platform/:username/messages?channel=...

let activeChatLogs = null
// Load-more observer — module-scoped so each re-render disconnects the prior
// one. Otherwise every loading/search/scope re-render orphans an observer still
// pinning a detached sentinel node.
let _clLoadMoreObs = null
// Shape: {
//   username, platform, channel,        // channel = null → all-channels view
//   rows: [],                            // newest-first as returned
//   cursor: null,                        // next_cursor for older pagination
//   loading: false,
//   exhausted: false,
//   query: '',                           // search-within filter
//   scope: 'channel' | 'all'             // matches whether channel is set
// }

const HS_CL_PAGE = 100
const HS_CL_PUBLIC_ORIGIN = 'https://heatsync.org'

// HS_LOG_PLATFORMS (the platforms the archive stores) lives in feed-embed.js —
// that file is concatenated BEFORE this one, and a const referenced from an
// earlier file would still be in its temporal dead zone.

// Build a public /logs/ permalink out of the four things that identify one
// archived line. THE canonical builder — the archive viewer, the live-row
// permalink and the thread composer all mint their URLs here.
//
// URL shape mirrors server/routes/chat-log-permalinks.ts:
//   /logs/<platform>/<channel>/<yyyy-mm-dd>?m=<message_id>
//
// The date is the UTC day (the archive partitions on it), taken from the
// message's own timestamp — never from "now", which is a different day for
// anyone reading chat across UTC midnight. It only picks the PAGE: the
// resolver keys off (platform, channel, message_id) and ignores the date
// entirely, so a message whose archived timestamp lands a few hundred ms the
// other side of midnight still quotes correctly, it just anchors on the
// neighbouring day. `m` is best-effort — the channel-day URL is a real page
// on its own when the id is missing.
function buildLogPermalink({ platform, channel, messageId, time }) {
  const p = (platform || '').toLowerCase()
  const c = (channel || '').toLowerCase().replace(/^#/, '')
  if (!HS_LOG_PLATFORMS.has(p) || !c || !time) return null
  const d = new Date(time)
  if (Number.isNaN(d.getTime())) return null
  const ymd = d.toISOString().slice(0, 10)
  let url = `${HS_CL_PUBLIC_ORIGIN}/logs/${encodeURIComponent(p)}/${encodeURIComponent(c)}/${ymd}`
  if (messageId) url += `?m=${encodeURIComponent(messageId)}`
  return url
}

// Archive-viewer row → permalink. Channel falls back to the view's channel
// (the all-channels view carries it per-row instead).
function buildChatLogPermalink(r) {
  if (!activeChatLogs) return null
  return buildLogPermalink({
    platform: activeChatLogs.platform,
    channel: r.channel || activeChatLogs.channel,
    messageId: r.message_id,
    time: r.timestamp,
  })
}

// Live chat row → permalink. Reads the identity the row already carries; the
// row stamps data-msg-time for exactly this (see main.js).
//
// `|| 'twitch'` matches every other row reader (mod-toolbar.js, input.js): a
// twitch IRC message never sets m.platform — only kick and youtube stamp
// themselves — so an empty attribute means twitch by construction. Measured on
// a live channel, 481 of 494 rows were empty, so without this the permalink
// fell back to a retyped quote on all but the handful of rows peekSentHost had
// retagged. The fallback is safe in the direction that matters: a kick or
// youtube row always carries its own value and can never land here.
function buildRowPermalink(row) {
  if (!row) return null
  return buildLogPermalink({
    platform: row.dataset.msgPlatform || 'twitch',
    channel: row.dataset.msgChannel,
    messageId: row.dataset.msgId,
    time: Number(row.dataset.msgTime) || 0,
  })
}

async function copyChatLogPermalink(btn, r) {
  const url = buildChatLogPermalink(r)
  if (!url) return
  let ok = false
  try {
    await navigator.clipboard.writeText(url)
    ok = true
  } catch {
    ok = typeof mcCopyFallback === 'function' && mcCopyFallback(url)
  }
  if (!ok) {
    try {
      showToast(t('mc_chatlogs_copy_failed'), 'error')
    } catch {}
  }
  const prev = btn.textContent
  btn.textContent = ok ? '✓' : '✗'
  if (ok) btn.classList.add('hs-cl-permalink-copied')
  setTimeout(() => {
    btn.textContent = prev
    btn.classList.remove('hs-cl-permalink-copied')
  }, 1200)
}

async function openChatLogsView(username, opts = {}) {
  if (!username) return
  username = String(username).toLowerCase()
  const platform = (opts.platform || 'twitch').toLowerCase()
  const channel = opts.channel ? String(opts.channel).toLowerCase() : null

  // Hide inputbar — no message composition in log view. Flag must move with
  // the class or showInputBar() early-returns forever (composer unreachable).
  const inputBar = document.getElementById('hs-mc-inputbar')
  if (inputBar) inputBar.classList.add('hs-hidden')
  inputBarVisible = false

  activeChatLogs = {
    username,
    platform,
    channel,
    rows: [],
    cursor: null,
    loading: false,
    exhausted: false,
    query: '',
    scope: channel ? 'channel' : 'all',
  }
  renderChatLogsView()
  await fetchChatLogsPage()
}

function closeChatLogsView() {
  if (!activeChatLogs) return
  activeChatLogs = null
  if (_clLoadMoreObs) {
    cleanup.untrackObserver(_clLoadMoreObs)
    _clLoadMoreObs = null
  }
  // showInputBar owns the "may this tab have a composer" call (and keeps the
  // visible flag in step) — the local tab list here was a third copy of it,
  // already out of date: it never included modlog.
  showInputBar()
  if (typeof renderMessages === 'function') renderMessages(currentTab)
}

async function fetchChatLogsPage() {
  if (!activeChatLogs || activeChatLogs.loading || activeChatLogs.exhausted) return
  activeChatLogs.loading = true
  const state = activeChatLogs
  const params = new URLSearchParams()
  if (state.channel) params.set('channel', state.channel)
  params.set('limit', String(HS_CL_PAGE))
  if (state.cursor) params.set('cursor', state.cursor)
  const path = `/api/archive/user/${encodeURIComponent(state.platform)}/${encodeURIComponent(state.username)}/messages?${params.toString()}`
  let resp
  try {
    resp = await apiFetch(path)
  } catch {
    resp = { ok: false }
  }
  if (!activeChatLogs || activeChatLogs !== state) return
  state.loading = false
  if (!resp?.ok || !resp.data) {
    // Do NOT latch `exhausted` on a FAILED request — fetchChatLogsPage
    // early-returns on it, so a single blip would permanently end the archive
    // with no way to retry. Flag the error; the next load-more can try again.
    state.loadError = true
    renderChatLogsView()
    return
  }
  state.loadError = false
  const incoming = resp.data.results || []
  // results are newest-first; append to bottom of list since we're loading older
  state.rows.push(...incoming)
  // Cap accumulated rows so full-repaint cost stays bounded (matches DOM_RENDER_CAP elsewhere)
  if (state.rows.length > 500) state.rows.splice(0, state.rows.length - 500)
  state.cursor = resp.data.next_cursor || null
  if (!state.cursor || incoming.length === 0) state.exhausted = true
  // Server kicked off ivr.fi historical backfill — flag so the UI shows a
  // "fetching history" hint and the user knows to retry shortly.
  if (resp.data.backfill_pending) state.backfillPending = true
  renderChatLogsView()
}

async function refreshChatLogs() {
  if (!activeChatLogs) return
  activeChatLogs.rows = []
  activeChatLogs.cursor = null
  activeChatLogs.exhausted = false
  activeChatLogs.backfillPending = false
  renderChatLogsView()
  await fetchChatLogsPage()
}

async function searchChatLogs(query) {
  if (!activeChatLogs) return
  activeChatLogs.query = query
  if (!query) {
    // Reset to full timeline
    activeChatLogs.rows = []
    activeChatLogs.cursor = null
    activeChatLogs.exhausted = false
    renderChatLogsView()
    await fetchChatLogsPage()
    return
  }
  activeChatLogs.loading = true
  const state = activeChatLogs
  const params = new URLSearchParams()
  params.set('q', query)
  params.set('username', state.username)
  if (state.channel) params.set('channel', state.channel)
  params.set('limit', String(HS_CL_PAGE))
  const path = `/api/archive/search?${params.toString()}`
  let resp
  try {
    resp = await apiFetch(path)
  } catch {
    resp = { ok: false }
  }
  if (!activeChatLogs || activeChatLogs !== state) return
  state.loading = false
  if (!resp?.ok || !resp.data) {
    // Clear the previous query's rows too — leaving them on screen relabels
    // them as results for THIS query. And don't latch exhausted on a failure.
    state.rows = []
    state.loadError = true
    renderChatLogsView()
    return
  }
  state.loadError = false
  state.rows = resp.data.results || []
  state.cursor = null
  state.exhausted = true
  renderChatLogsView()
}

function exportChatLogs(format) {
  if (!activeChatLogs?.rows.length) return
  const { username, channel, rows } = activeChatLogs
  let body, mime, ext
  if (format === 'json') {
    body = JSON.stringify(rows, null, 2)
    mime = 'application/json'
    ext = 'json'
  } else {
    body = rows
      .slice()
      .reverse()
      .map((r) => {
        const d = r.timestamp ? new Date(r.timestamp) : null
        const ts = d && !Number.isNaN(d.getTime()) ? d.toISOString().replace('T', ' ').slice(0, 19) : ''
        const ch = r.channel ? `#${r.channel}` : ''
        return `[${ts}] ${ch} <${r.display_name || r.username}> ${r.message}`
      })
      .join('\n')
    mime = 'text/plain'
    ext = 'txt'
  }
  const blob = new Blob([body], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `chatlogs-${username}${channel ? `-${channel}` : ''}.${ext}`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function renderChatLogsView() {
  const msgsEl = document.getElementById('hs-mc-messages')
  if (!msgsEl || !activeChatLogs) return
  msgsEl.textContent = ''

  const { username, channel, rows, loading, exhausted, query, scope } = activeChatLogs

  const wrap = document.createElement('div')
  wrap.className = 'hs-cl-wrap'

  // Header
  const hdr = document.createElement('div')
  hdr.className = 'hs-cl-hdr'

  const title = document.createElement('div')
  title.className = 'hs-cl-title'
  const tName = document.createElement('span')
  tName.className = 'hs-cl-title-name'
  tName.textContent = username
  const tSub = document.createElement('span')
  tSub.className = 'hs-cl-title-sub'
  tSub.textContent = channel ? `#${channel}` : 'all channels'
  title.appendChild(tName)
  title.appendChild(tSub)
  hdr.appendChild(title)

  const closeBtn = document.createElement('button')
  closeBtn.className = 'hs-cl-close'
  closeBtn.type = 'button'
  closeBtn.title = 'close (Esc)'
  closeBtn.textContent = '×'
  closeBtn.addEventListener('click', closeChatLogsView)
  hdr.appendChild(closeBtn)
  wrap.appendChild(hdr)

  // Controls
  const ctrls = document.createElement('div')
  ctrls.className = 'hs-cl-ctrls'

  const search = document.createElement('input')
  search.type = 'text'
  search.className = 'hs-cl-search'
  search.placeholder = 'search…'
  search.title = `search ${username}'s messages`
  search.value = query || ''
  let searchTimer = null
  search.addEventListener('input', () => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => searchChatLogs(search.value.trim()), 250)
  })
  ctrls.appendChild(search)

  // Scope toggle (channel ↔ all) only meaningful if we have a channel context
  if (channel) {
    const scopeBtn = document.createElement('button')
    scopeBtn.className = 'hs-cl-scope'
    scopeBtn.type = 'button'
    scopeBtn.textContent = scope === 'channel' ? `#${channel}` : 'all'
    scopeBtn.title =
      scope === 'channel'
        ? `currently scoped to #${channel} — click to see all channels`
        : `currently showing all channels — click to scope to #${channel}`
    scopeBtn.addEventListener('click', async () => {
      const newScope = scope === 'channel' ? 'all' : 'channel'
      activeChatLogs.scope = newScope
      activeChatLogs.channel = newScope === 'channel' ? channel : null
      activeChatLogs.rows = []
      activeChatLogs.cursor = null
      activeChatLogs.exhausted = false
      renderChatLogsView()
      await fetchChatLogsPage()
    })
    ctrls.appendChild(scopeBtn)
  }

  const refreshBtn = document.createElement('button')
  refreshBtn.className = 'hs-cl-export'
  refreshBtn.type = 'button'
  refreshBtn.textContent = '↻'
  refreshBtn.title = 'refresh'
  refreshBtn.addEventListener('click', () => refreshChatLogs())
  ctrls.appendChild(refreshBtn)

  const exportTxt = document.createElement('button')
  exportTxt.className = 'hs-cl-export'
  exportTxt.type = 'button'
  exportTxt.textContent = '.txt'
  exportTxt.title = 'export as .txt'
  exportTxt.addEventListener('click', () => exportChatLogs('txt'))
  ctrls.appendChild(exportTxt)

  const exportJson = document.createElement('button')
  exportJson.className = 'hs-cl-export'
  exportJson.type = 'button'
  exportJson.textContent = '.json'
  exportJson.title = 'export as .json'
  exportJson.addEventListener('click', () => exportChatLogs('json'))
  ctrls.appendChild(exportJson)

  // Public archive link — only meaningful when scoped to a channel (the
  // public surface is /logs/<platform>/<channel>/<date>, channel-keyed).
  if (channel) {
    const pub = document.createElement('a')
    pub.className = 'hs-cl-public-archive'
    pub.href = `${HS_CL_PUBLIC_ORIGIN}/logs/${encodeURIComponent(activeChatLogs.platform)}/${encodeURIComponent(channel)}`
    pub.target = '_blank'
    pub.rel = 'noopener noreferrer'
    pub.textContent = 'public archive ↗'
    pub.title = `open #${channel}'s public chat log on heatsync.org`
    ctrls.appendChild(pub)
  }

  wrap.appendChild(ctrls)

  // Body — message list
  const list = document.createElement('div')
  list.className = 'hs-cl-list'

  if (rows.length === 0 && !loading) {
    const empty = document.createElement('div')
    empty.className = 'hs-cl-empty'
    if (activeChatLogs.loadError) {
      // A failed request is not an empty archive — saying "no matches" for a
      // request that never succeeded is the same lie as the rest of this sweep.
      empty.textContent = "couldn't load the archive — search or scroll again to retry"
    } else if (activeChatLogs.backfillPending) {
      const src = activeChatLogs.platform === 'kick' ? 'kick archive' : 'logs.ivr.fi'
      empty.textContent = `fetching historical logs from ${src}… try refresh in ~30s`
    } else {
      empty.textContent = query
        ? `no matches for "${query}"`
        : `no archived messages from ${username}${channel ? ` in #${channel}` : ''} yet`
    }
    list.appendChild(empty)
  } else {
    // Render newest-at-top (matches Twitch viewer card mental model)
    for (const r of rows) list.appendChild(renderChatLogRow(r))
  }

  // Load-more sentinel at the bottom (scroll-down to load older)
  if (!exhausted) {
    const sentinel = document.createElement('div')
    sentinel.className = 'hs-cl-loader'
    sentinel.textContent = loading ? 'loading…' : 'scroll for older'
    list.appendChild(sentinel)
    // IntersectionObserver auto-fires when sentinel scrolls into view
    if (!loading && 'IntersectionObserver' in window) {
      if (_clLoadMoreObs) {
        cleanup.untrackObserver(_clLoadMoreObs)
        _clLoadMoreObs = null
      }
      _clLoadMoreObs = cleanup.trackObserver(
        new IntersectionObserver(
          (entries) => {
            if (entries.some((e) => e.isIntersecting)) {
              if (_clLoadMoreObs) {
                cleanup.untrackObserver(_clLoadMoreObs)
                _clLoadMoreObs = null
              }
              fetchChatLogsPage()
            }
          },
          { root: list, rootMargin: '200px' },
        ),
      )
      _clLoadMoreObs.observe(sentinel)
    }
  }

  wrap.appendChild(list)
  msgsEl.appendChild(wrap)
}

function renderChatLogRow(r) {
  const row = document.createElement('div')
  row.className = 'hs-cl-row'
  if (r.deleted_at) row.classList.add('hs-cl-deleted')

  const ts = document.createElement('span')
  ts.className = 'hs-cl-ts'
  if (r.timestamp) {
    const d = new Date(r.timestamp)
    if (!Number.isNaN(d.getTime())) {
      ts.textContent = d.toISOString().replace('T', ' ').slice(5, 16)
      ts.title = d.toLocaleString()
    }
  }
  row.appendChild(ts)

  if (activeChatLogs && activeChatLogs.scope === 'all' && r.channel) {
    const ch = document.createElement('span')
    ch.className = 'hs-cl-ch'
    ch.textContent = `#${r.channel}`
    row.appendChild(ch)
  }

  const name = document.createElement('span')
  name.className = 'hs-cl-user'
  name.textContent = r.display_name || r.username || '?'
  // Color + paint cosmetics — match the live chat renderer so the viewer's
  // username display is consistent with what the user sees in chat. Walk:
  // 1) knownColors map (live chat color, captured from IRC tags / Helix users)
  // 2) twitch user id from knownUserIds map for the paint lookup
  // 3) getMcPaintStyle returns a complete CSS style string (background-clip
  //    gradient for paints, plain color: rgba(…) for solid-color paints)
  // If neither is available, fall back to plain white (default).
  try {
    const ulow = (r.username || '').toLowerCase()
    let color = null
    if (typeof knownColors !== 'undefined' && knownColors instanceof Map) {
      color = knownColors.get(ulow) || null
    }
    let paintApplied = false
    if (typeof knownUserIds !== 'undefined' && knownUserIds instanceof Map && typeof getMcPaintStyle === 'function') {
      // Platform-scoped key — a twitch and kick chatter sharing this username
      // must never trade 7TV paints in the archive view either.
      const uidKey = typeof userKey === 'function' ? userKey(ulow, r.platform) : ulow
      const uid = knownUserIds.get(uidKey)
      if (uid) {
        // HeatSync paint (own-platform cosmetic) wins over 7TV — same precedence
        // as the live sender row. Twitch-keyed only (see paints.js ID-SPACE note):
        // a kick/yt uid must never index the twitch-space HS paint cache.
        const isTwitch = !r.platform || r.platform === 'twitch'
        if (isTwitch && typeof hasResolvedHsPaint === 'function' && hasResolvedHsPaint(String(uid))) {
          applyHsPaintToElement(name, String(uid))
          paintApplied = true
        } else {
          const paintCss = getMcPaintStyle(String(uid))
          if (paintCss) {
            name.style.cssText = paintCss
            paintApplied = true
          }
        }
      }
    }
    if (!paintApplied && color) name.style.color = color
  } catch {}
  row.appendChild(name)

  const body = document.createElement('span')
  body.className = 'hs-cl-body'
  appendChatLogBody(body, r)
  row.appendChild(body)

  // Permalink copy — hover-revealed ¶ that puts the public /logs/ URL on
  // the clipboard. Matches server's chat-log-permalinks.ts pattern; every
  // copied permalink is a backlink into the SEO acquisition surface.
  if (buildChatLogPermalink(r)) {
    const link = document.createElement('button')
    link.className = 'hs-cl-permalink'
    link.type = 'button'
    link.textContent = '¶'
    link.title = 'copy permalink'
    link.addEventListener('click', (e) => {
      e.stopPropagation()
      copyChatLogPermalink(link, r)
    })
    row.appendChild(link)
  }

  return row
}

const CL_SAFE_EMOTE_ID = /^[A-Za-z0-9_-]{1,64}$/

function clEmoteCdnUrl(platform, id) {
  if (!CL_SAFE_EMOTE_ID.test(id)) return null
  if (platform === 'twitch') return `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/1.0`
  if (platform === 'kick') return `https://files.kick.com/emotes/${id}/fullsize`
  return null
}

function clEmoteImg(host, src, alt) {
  const img = document.createElement('img')
  img.className = 'hs-cl-emote'
  img.src = src
  img.alt = alt
  img.loading = 'lazy'
  host.appendChild(img)
}

// Name/hash-based block gate — same blockedEmoteNames/blockedEmoteHashes sets
// chat and feed check (emotes.js loads before this module in the bundle).
// Fail open on neither set existing yet (never blocked before boot finishes)
// since that mirrors every other blocked-check callsite's `typeof !== undefined` guard.
function clEmoteBlocked(name, idOrHash) {
  if (typeof blockedEmoteNames !== 'undefined' && name && blockedEmoteNames.has(name)) return true
  if (typeof blockedEmoteHashes !== 'undefined' && idOrHash && blockedEmoteHashes.has(String(idOrHash))) return true
  return false
}

// Emote CDN allowlist for the twitch name→url map (shape B, below) — that
// shape's url is a server-relayed string with NO protocol/host check before
// this fix. Fail closed: only these hosts over https ever become an <img src>;
// anything else renders as plain text instead of hotlinking (or worse)
// unverified origins. Keep in sync with the emote-serving subset of
// HS_IMG_DIRECT_HOSTS (feed-embed.js) and manifest img-src.
const CL_EMOTE_HOSTS = new Set([
  'static-cdn.jtvnw.net',
  'cdn.7tv.app',
  'cdn.betterttv.net',
  'cdn.frankerfacez.com',
  'files.kick.com',
  'heatsync.org',
  'cdn.heatsync.org',
])
function clEmoteUrlAllowed(url) {
  if (typeof url !== 'string' || !url) return false
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && CL_EMOTE_HOSTS.has(u.hostname)
  } catch {
    return false
  }
}

function appendChatLogBody(host, r) {
  const text = String(r.message || '')
  const refs = r.emote_refs || null

  // Shape A — position-based (Kick webhooks, IVR backfill). Mirrors the site +
  // server renderers so Kick rows show emotes instead of plain text.
  const list = refs && Array.isArray(refs.emotes) ? refs.emotes : []
  if (list.length > 0) {
    const spans = []
    for (const entry of list) {
      if (!entry || !CL_SAFE_EMOTE_ID.test(entry.emote_id || '') || !Array.isArray(entry.positions)) continue
      for (const p of entry.positions) {
        if (typeof p?.s !== 'number' || typeof p?.e !== 'number') continue
        if (p.s < 0 || p.e < p.s || p.e >= text.length) continue
        spans.push({ s: p.s, e: p.e, emote_id: entry.emote_id })
      }
    }
    if (spans.length > 0) {
      spans.sort((a, b) => a.s - b.s)
      let cursor = 0
      for (const span of spans) {
        if (span.s < cursor) continue
        if (span.s > cursor) appendTextWithHashtags(host, text.slice(cursor, span.s))
        const slice = text.slice(span.s, span.e + 1)
        const altMatch = slice.match(/^\[emote:[^:]+:([^\]]+)\]$/)
        const altName = altMatch ? altMatch[1] : slice
        const src = clEmoteCdnUrl(r.platform, span.emote_id)
        // blocked → plain name, never the real image (matches chat/feed)
        if (src && !clEmoteBlocked(altName, span.emote_id)) clEmoteImg(host, src, altName)
        else host.appendChild(document.createTextNode(src ? altName : slice))
        cursor = span.e + 1
      }
      if (cursor < text.length) appendTextWithHashtags(host, text.slice(cursor))
      return
    }
  }

  // Shape B — twitch name→url map (ext relay)
  const twitchEmotes = refs?.twitch || null
  if (!twitchEmotes) {
    appendTextWithHashtags(host, text)
    return
  }
  const parts = text.split(/(\s+)/)
  for (const part of parts) {
    const emoteUrl = twitchEmotes[part]
    // blocked, OR the url fails the CDN allowlist (untrusted host) → plain
    // text; never set an unvalidated string straight into img.src.
    if (emoteUrl && !clEmoteBlocked(part) && clEmoteUrlAllowed(emoteUrl)) clEmoteImg(host, emoteUrl, part)
    else appendTextWithHashtags(host, part)
  }
}

// ESC closes the panel (matches profile-card convention)
document.addEventListener(
  'keydown',
  (e) => {
    if (e.key !== 'Escape') return
    if (activeChatLogs) {
      e.preventDefault()
      closeChatLogsView()
      return
    }
    // Predictions/polls view — same convention, same file so the two takeover
    // surfaces can't disagree about what Escape does.
    if (typeof predViewOpen === 'function' && predViewOpen()) {
      e.preventDefault()
      closePredView()
    }
  },
  { signal: mcSignal, capture: true },
)

// Close-button repaint-race guard — the chat-logs and profile-card views
// full-repaint every time async data lands (fetch pages, enrich, live
// status), replacing their × node. A real mouse click then computes its
// target against the DETACHED old button and never reaches the direct click
// listener — the × silently "does nothing" (worst on popout cold loads,
// where everything is uncached and repaints stack up). Delegate on
// pointerdown instead: its target is whatever node is live at press time,
// so no repaint can outrun it. The direct listeners stay as backup; both
// close fns are idempotent (null-guard) so double-fire is a no-op. The
// paired click is swallowed once (350ms disarm) so whatever repaints in
// under the cursor doesn't receive a stray click.
document.addEventListener(
  'pointerdown',
  (e) => {
    if (e.button !== 0) return
    const x = e.target?.closest?.('.hs-cl-close, .hs-pcard-close, .hs-pv-close')
    if (!x) return
    e.preventDefault()
    e.stopPropagation()
    const swallow = (c) => {
      c.stopPropagation()
      c.preventDefault()
    }
    document.addEventListener('click', swallow, { capture: true, once: true, signal: mcSignal })
    cleanup.setTimeout(() => document.removeEventListener('click', swallow, { capture: true }), 350)
    if (x.classList.contains('hs-cl-close')) closeChatLogsView()
    else if (x.classList.contains('hs-pv-close')) closePredView()
    else if (typeof closeProfileCard === 'function') closeProfileCard()
  },
  { signal: mcSignal, capture: true },
)
