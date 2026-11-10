// background part 10 of 11 — kick and yt mirrors, the yt tap, the kick tap.
// build.js concatenates src/background/* in BG_PARTS order into background.js (the service worker cannot import);
// one scope, so a later part may read an earlier part's constants, never the reverse.

// ============================================================================
// BG KICK + YT BUFFER MIRROR — same reload-safe guarantee
// ============================================================================
// Kick + YouTube messages already flow through this SW (heatsync server WS).
// We tee them into per-channel buffers so content tabs hydrate instantly on
// reload — same architecture as the Twitch IRC reader above.

// The archive route serves up to 800 rows (server recent-archive.ts MAX_LIMIT)
// and clamps anything larger. Callers ask for min(that, their own buffer cap):
// requesting more than the circular buffer keeps just pays for rows it drops on
// arrival, and the old flat 200 left the other 600 the archive would gladly
// have handed over unseen, with no "load more" anywhere to reach them.
const BG_ARCHIVE_FETCH_MAX = 800
const BG_KICK_PERSIST_MAX = 3000
const BG_YT_PERSIST_MAX = 500
const BG_KICK = {
  channels: new Map(), // username -> BGCircularBuffer
  persistTimers: new Map(),
  storageRestored: false,
}
const BG_YT = {
  channels: new Map(), // channelId -> BGCircularBuffer
  persistTimers: new Map(),
  storageRestored: false,
}

async function bgKickRestoreFromStorage() {
  if (BG_KICK.storageRestored) return
  BG_KICK.storageRestored = true
  try {
    const all = await browser.storage.local.get(null)
    // Channels no longer in the user's config never hit the live channel:leave
    // cleanup (removed via another device, or before that handler existed) —
    // sweep them here so hs_kick_* doesn't grow forever.
    const kickKeep = new Set(
      (all.heatsync_multichat?.channels || [])
        .filter((c) => c && typeof c === 'object' && typeof c.kick === 'string' && c.kick)
        .map((c) => c.kick.toLowerCase()),
    )
    const toPurge = []
    let n = 0
    for (const [k, v] of Object.entries(all)) {
      if (!k.startsWith('hs_kick_') || k.startsWith('hs_kick_sync_')) continue
      const ch = k.slice('hs_kick_'.length)
      if (ch && !kickKeep.has(ch)) {
        toPurge.push(k)
        continue
      }
      if (!ch || !v?.msgs?.length || Date.now() - v.ts >= 86400000) continue
      const buf = new BGCircularBuffer(BG_KICK_PERSIST_MAX)
      // Live ingest may have created this buffer while get(null) was pending
      // (boot doesn't await this restore) — merge stored history BEFORE the
      // live messages instead of clobbering them.
      const live = BG_KICK.channels.get(ch)?.getAll() || []
      const liveIds = new Set(live.filter((m) => m.id).map((m) => m.id))
      for (const m of v.msgs) {
        if (m.id && liveIds.has(m.id)) continue
        buf.push(m)
      }
      for (const m of live) buf.push(m)
      BG_KICK.channels.set(ch, buf)
      n++
    }
    if (toPurge.length) browser.storage.local.remove(toPurge).catch(() => {})
    log('BG KICK restored', n, `channels${toPurge.length ? `, purged ${toPurge.length} orphaned` : ''}`)
  } catch (e) {
    log('BG KICK restore failed:', e.message)
  }
}

async function bgYtRestoreFromStorage() {
  if (BG_YT.storageRestored) return
  BG_YT.storageRestored = true
  try {
    const all = await browser.storage.local.get(null)
    // Same sweep as the Kick twin above — channels removed from config while
    // this SW wasn't running never hit the live youtube_ws_unsubscribe cleanup.
    const ytKeep = new Set(
      (all.heatsync_multichat?.channels || [])
        .filter((c) => c && typeof c === 'object' && c.youtube && typeof c.id === 'string')
        .map((c) => c.id),
    )
    const toPurge = []
    let n = 0
    for (const [k, v] of Object.entries(all)) {
      if (!k.startsWith('hs_yt_') || k.startsWith('hs_yt_sync_')) continue
      const channelId = k.slice('hs_yt_'.length)
      if (channelId && !ytKeep.has(channelId)) {
        toPurge.push(k)
        continue
      }
      if (!channelId || !v?.msgs?.length || Date.now() - v.ts >= 86400000) continue
      const buf = new BGCircularBuffer(BG_YT_PERSIST_MAX)
      // Same merge-not-clobber as the kick twin — boot doesn't await this.
      const live = BG_YT.channels.get(channelId)?.getAll() || []
      const liveIds = new Set(live.filter((m) => m.id).map((m) => m.id))
      for (const m of v.msgs) {
        if (m.id && liveIds.has(m.id)) continue
        buf.push(m)
      }
      for (const m of live) buf.push(m)
      BG_YT.channels.set(channelId, buf)
      n++
    }
    if (toPurge.length) browser.storage.local.remove(toPurge).catch(() => {})
    log('BG YT restored', n, `channels${toPurge.length ? `, purged ${toPurge.length} orphaned` : ''}`)
  } catch (e) {
    log('BG YT restore failed:', e.message)
  }
}

function bgKickPersistChannel(ch) {
  if (BG_KICK.persistTimers.has(ch)) return
  BG_KICK.persistTimers.set(
    ch,
    setTimeout(() => {
      BG_KICK.persistTimers.delete(ch)
      try {
        const buf = BG_KICK.channels.get(ch)
        if (!buf) return
        const msgs = buf.getAll()
        browser.storage.local.set({ [`hs_kick_${ch}`]: { msgs, ts: Date.now() } }).catch(() => {})
      } catch {}
    }, 1500),
  )
}

function bgYtPersistChannel(channelId) {
  if (BG_YT.persistTimers.has(channelId)) return
  BG_YT.persistTimers.set(
    channelId,
    setTimeout(() => {
      BG_YT.persistTimers.delete(channelId)
      try {
        const buf = BG_YT.channels.get(channelId)
        if (!buf) return
        const msgs = buf.getAll()
        browser.storage.local.set({ [`hs_yt_${channelId}`]: { msgs, ts: Date.now() } }).catch(() => {})
      } catch {}
    }, 1500),
  )
}

// Cross-source live dedupe — the same Kick msg can arrive from the server
// relay AND the kick tap (both call bgKickIngest). FIFO, mirrors _bgLiveIds.
const _bgKickLiveIds = new Set()
const _bgKickLiveIdOrder = []
function bgKickSeenLiveId(id) {
  if (!id) return false
  if (_bgKickLiveIds.has(id)) return true
  _bgKickLiveIds.add(id)
  _bgKickLiveIdOrder.push(id)
  if (_bgKickLiveIdOrder.length > 6000) {
    for (let i = 0; i < 1000; i++) _bgKickLiveIds.delete(_bgKickLiveIdOrder[i])
    _bgKickLiveIdOrder.splice(0, 1000)
  }
  return false
}

function bgKickIngest(data) {
  // data shape from heatsync server kick-chat-message webhook → broadcast;
  // called from the relay case AND the kick tap's _kpHandleChatEvent
  if (!data?.channel) return
  const ch = data.channel.toLowerCase()
  if (data.id && bgKickSeenLiveId(`${ch}:${data.id}`)) return
  const isFirstSightOfChannel = !BG_KICK.channels.has(ch)
  if (isFirstSightOfChannel) {
    BG_KICK.channels.set(ch, new BGCircularBuffer(BG_KICK_PERSIST_MAX))
    if (BG_KICK.channels.size > MAX_BG_KICK_CHANNELS) {
      const oldest = BG_KICK.channels.keys().next().value
      BG_KICK.channels.delete(oldest)
      browser.storage.local.remove(`hs_kick_${oldest}`).catch(() => {})
    }
    // First time we see this Kick channel — pull deep history from postgres
    // archive in addition to the 200-msg server ring (which came via
    // kick-chat-backfill on the WS).
    bgKickFetchArchive(ch).catch(() => {})
  }
  // Build a serializable msg matching what content's KickChat constructs
  const msg = {
    user: data.username || data.user || 'unknown',
    text: data.content || data.message || data.text || '',
    color: data.color || '#53fc18',
    // kick numeric USER id → userId so hydrated history rows thread replies
    // and resolve kick_<id> identity like live rows do (irc.js maps
    // d.senderId → msg.userId on the live path)
    userId: data.senderId != null ? String(data.senderId) : '',
    // Extract Kick badges from the live payload (mirrors kick-chat-backfill).
    // Was hardcoded '' — so BG-buffer history replay (_refreshFromBg) dropped
    // the sub/mod badges that were present when the message arrived live.
    badges: Array.isArray(data.badges)
      ? data.badges.map((b) => `${b.type || b.name || 'badge'}/${b.version || b.count || '1'}`).join(',')
      : '',
    channel: ch,
    time: data.timestamp || data.time || Date.now(),
    platform: 'kick',
    id: data.id || '',
    replyTo: data.replyTo
      ? {
          user: data.replyTo.username || 'unknown',
          text: data.replyTo.content || '',
          id: data.replyTo.id || data.replyTo.message_id || '',
          threadId: data.replyTo.thread_id || data.replyTo.id || data.replyTo.message_id || '',
        }
      : null,
  }
  BG_KICK.channels.get(ch).push(msg)
  bgKickPersistChannel(ch)
}

// chat_archive postgres pull for Kick — heatsync persists every Kick msg
// permanently. /api/archive/search returns up to 100 newest msgs DESC, with
// cursor for older pages. Used to seed the BG buffer beyond the 200-msg ring.
// Rate-limited server-side at 30/min/IP; one call per channel-join is fine.
const BG_KICK_ARCHIVE_COOLDOWN_MS = 5 * 60 * 1000
const BG_KICK_lastArchiveAt = new Map()
async function bgKickFetchArchive(ch, beforeIso) {
  ch = (ch || '').toLowerCase()
  if (!ch) return
  if (!beforeIso) {
    const last = BG_KICK_lastArchiveAt.get(ch) || 0
    if (Date.now() - last < BG_KICK_ARCHIVE_COOLDOWN_MS) return
    BG_KICK_lastArchiveAt.set(ch, Date.now())
    pruneMap(BG_KICK_lastArchiveAt, COOLDOWN_TS_MAX_CHANNELS)
  }
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 12000)
    const params = new URLSearchParams({
      channel: ch,
      platform: 'kick',
      limit: '100',
    })
    if (beforeIso) params.set('cursor', beforeIso)
    const resp = await fetch(`${API_URL}/api/archive/search?${params}`, {
      signal: ctrl.signal,
      credentials: 'omit',
    })
    clearTimeout(timer)
    if (!resp.ok) return
    const data = await resp.json()
    const rows = Array.isArray(data?.results) ? data.results : []
    if (rows.length === 0) return
    if (!BG_KICK.channels.has(ch)) BG_KICK.channels.set(ch, new BGCircularBuffer(BG_KICK_PERSIST_MAX))
    const buf = BG_KICK.channels.get(ch)
    const existing = buf.getAll()
    const existingIds = new Set(existing.filter((m) => m.id).map((m) => m.id))
    const fpKey = (m) => `${m.user}|${m.time}|${(m.text || '').slice(0, 60)}`
    const existingFp = new Set(existing.filter((m) => !m.id).map(fpKey))
    const toAdd = []
    for (const r of rows) {
      const id = r.message_id || r.id || ''
      const text = r.message || r.content || ''
      const user = r.display_name || r.username || 'unknown'
      const ts = r.timestamp ? new Date(r.timestamp).getTime() : Date.now()
      const badgeStr = Array.isArray(r.badges)
        ? r.badges.map((b) => `${b.type || b.name || 'badge'}/${b.version || b.count || '1'}`).join(',')
        : typeof r.badges === 'string'
          ? r.badges
          : ''
      const msg = {
        user,
        text,
        color: '#53fc18',
        badges: badgeStr,
        channel: ch,
        time: ts,
        platform: 'kick',
        id,
        isHistory: true,
        replyTo: r.reply_to_id ? { user: '', text: '', id: r.reply_to_id, threadId: r.reply_to_id } : null,
      }
      if (msg.id && existingIds.has(msg.id)) continue
      if (!msg.id && existingFp.has(fpKey(msg))) continue
      existingIds.add(msg.id)
      if (!msg.id) existingFp.add(fpKey(msg))
      toAdd.push(msg)
    }
    if (toAdd.length === 0) return
    const all = [...existing, ...toAdd].sort((a, b) => (a.time || 0) - (b.time || 0))
    buf.clear()
    for (const m of all) buf.push(m)
    bgKickPersistChannel(ch)
    broadcastToTabs({ type: 'bg_kick_history_merged', channel: ch, count: toAdd.length })
    log('BG KICK archive merged', toAdd.length, 'msgs for', ch)
  } catch (e) {
    log('BG KICK archive fetch failed for', ch, ':', e?.message)
  }
}

// ─── Real-history backfill from GET /api/recent/{platform}/{channel} ───────
// New first-party endpoint (NOT YET DEPLOYED everywhere) that serves up to
// 800 archived messages, newest-last, so a fresh kick/yt join backfills real
// history instead of just replaying whatever the local ring buffer happened
// to catch live. Every failure mode (404/5xx/timeout/malformed body) must
// fail soft and leave the existing local-buffer/relay backfill untouched —
// this is additive, never load-bearing.

// Map one row from the /api/recent response into our internal per-platform
// message shape. Pure — no fetch, no chrome.* — so it's directly unit
// testable. `row` fields per the API contract: { id, ts, channel, sender,
// display_name, text, badges?, emote_refs?, reply_to? } — every field is
// optional/untrusted (server not yet deployed), so every access is guarded
// and a malformed row degrades to plain text rather than throwing.
function mapRecentArchiveRow(platform, row) {
  if (!row || typeof row !== 'object') return null
  const id = row.id != null ? String(row.id) : ''
  const user = row.display_name || row.sender || 'unknown'
  let text = typeof row.text === 'string' ? row.text : ''
  const time = row.ts ? new Date(row.ts).getTime() || Date.now() : Date.now()
  if (!text) return null
  const base = { id, user, text, time, isHistory: true }
  if (platform === 'kick') {
    // Kick's native emotes render as literal [emote:ID:NAME] tokens inline in
    // text (see src/multichat/emotes.js) — the existing /api/archive/search
    // path already stores text with these tokens intact, so only reconstruct
    // from emote_refs when text doesn't already carry them AND the refs carry
    // explicit offsets. Refs without offsets can't be safely positioned —
    // skip reconstruction for those rather than guess (named skip).
    if (Array.isArray(row.emote_refs) && text.indexOf('[emote:') === -1) {
      const refs = row.emote_refs
        .filter(
          (r) =>
            r &&
            r.id != null &&
            r.name &&
            Number.isFinite(r.start) &&
            Number.isFinite(r.end) &&
            r.end >= r.start &&
            r.end <= text.length,
        )
        .sort((a, b) => b.start - a.start)
      for (const r of refs) {
        text = `${text.slice(0, r.start)}[emote:${r.id}:${r.name}]${text.slice(r.end)}`
      }
      base.text = text
    }
    base.color = '#53fc18'
    base.badges = Array.isArray(row.badges)
      ? row.badges.map((b) => `${b?.type || b?.name || 'badge'}/${b?.version || b?.count || '1'}`).join(',')
      : typeof row.badges === 'string'
        ? row.badges
        : ''
    base.platform = 'kick'
    base.replyTo =
      row.reply_to && typeof row.reply_to === 'object'
        ? {
            user: row.reply_to.user || row.reply_to.username || 'unknown',
            text: row.reply_to.text || row.reply_to.content || '',
            id: row.reply_to.id || '',
            threadId: row.reply_to.thread_id || row.reply_to.id || '',
          }
        : null
  } else if (platform === 'youtube') {
    // reply_to intentionally dropped — the YT message pipeline (social.js's
    // youtube_chat_message handler) has no reply-context field at all.
    base.color = '#ff0000'
    base.badges = Array.isArray(row.badges) ? row.badges : []
    base.platform = 'youtube'
    base.msgType = 'text'
  }
  return base
}

// Merge freshly-fetched archive rows into an existing message array. Pure —
// dedup by id first, then ALWAYS by a (user, ~time, text-prefix) content
// fingerprint against every existing row. The double net matters: the server
// serves the platform's own message id (kick uuid / yt id) since c81d5cd0,
// which matches live-caught rows — but legacy archive rows, stale server
// caches, and rows persisted from pre-c81d5cd0 fetches still carry DB row
// ids, so the same message can arrive under two id namespaces. Content fp
// bridges that. Time is bucketed to 10s with adjacent-bucket checks because
// an archive row's ts (server ingest) and a live row's time (client receive)
// differ by transport lag — never by more than a few seconds in practice.
// Cost: an archived repeat of the same user+text within ~20s is dropped from
// backfill — invisible next to rendering every overlap message twice.
// The local buffer always wins a conflict — it carries richer live fields
// (userId, live badges, etc.) than a re-derived archive row ever can — so
// `existing` seeds the dedup sets before any archive row is considered.
// Returns the rows actually appended (`toAdd`) and the time-sorted merge.
const ARCHIVE_FP_BUCKET_MS = 10000
function archiveFpAt(m, bucket) {
  return `${(m.user || '').toLowerCase()}|${bucket}|${(m.text || '').slice(0, 60)}`
}
function mergeRecentArchiveRows(existing, rows, platform) {
  const existingIds = new Set(existing.filter((m) => m.id).map((m) => String(m.id)))
  const existingFp = new Set()
  for (const m of existing) existingFp.add(archiveFpAt(m, Math.floor((m.time || 0) / ARCHIVE_FP_BUCKET_MS)))
  const toAdd = []
  for (const row of rows) {
    const m = mapRecentArchiveRow(platform, row)
    if (!m) continue
    if (m.id && existingIds.has(String(m.id))) continue
    const bucket = Math.floor((m.time || 0) / ARCHIVE_FP_BUCKET_MS)
    if (
      existingFp.has(archiveFpAt(m, bucket)) ||
      existingFp.has(archiveFpAt(m, bucket - 1)) ||
      existingFp.has(archiveFpAt(m, bucket + 1))
    )
      continue
    if (m.id) existingIds.add(String(m.id))
    existingFp.add(archiveFpAt(m, bucket))
    toAdd.push(m)
  }
  const merged = toAdd.length ? [...existing, ...toAdd].sort((a, b) => (a.time || 0) - (b.time || 0)) : existing
  return { toAdd, merged }
}

// Fetch + parse the /api/recent/{platform}/{channel} response. Isolated from
// state mutation so fail-soft behavior (404/5xx/timeout/malformed JSON → empty
// rows, never throws) is directly testable via an injected fetch impl.
// Default and clamp stay literals: the unit harness compiles this function on
// its own via new Function, so a free variable here is a ReferenceError there.
async function fetchRecentArchiveRows(platform, channel, limit = 800) {
  try {
    const url = `${API_URL}/api/recent/${platform}/${encodeURIComponent(channel)}?limit=${Math.min(800, Math.max(1, limit))}`
    const resp = await fetchWithTimeout(url, { credentials: 'omit' }, 8000)
    if (!resp.ok) return []
    const data = await resp.json().catch(() => null)
    return Array.isArray(data?.messages) ? data.messages : []
  } catch {
    return [] // timeout/network/abort — fail soft, caller keeps current behavior
  }
}

// One-shot fire-and-forget kick join backfill. Gated by _kpChannels.has()
// being freshly-set (see kickTapJoin) so this runs once per join, not on
// every reconnect within the SW's lifetime.
async function bgKickFetchRecentArchive(slug) {
  slug = (slug || '').toLowerCase()
  if (!slug) return
  const rows = await fetchRecentArchiveRows('kick', slug, Math.min(BG_ARCHIVE_FETCH_MAX, BG_KICK_PERSIST_MAX))
  if (!rows.length) return
  if (!BG_KICK.channels.has(slug)) BG_KICK.channels.set(slug, new BGCircularBuffer(BG_KICK_PERSIST_MAX))
  const buf = BG_KICK.channels.get(slug)
  const { toAdd, merged } = mergeRecentArchiveRows(buf.getAll(), rows, 'kick')
  for (const m of toAdd) m.channel = slug
  if (!toAdd.length) return
  buf.clear()
  for (const m of merged) buf.push(m)
  bgKickPersistChannel(slug)
  broadcastToTabs({ type: 'bg_kick_history_merged', channel: slug, count: toAdd.length })
  log('BG KICK recent-archive merged', toAdd.length, 'msgs for', slug)
}

// One-shot fire-and-forget YT join backfill. `channelId` is the multichat
// tab's config id (e.g. "yt-1234567890"), NOT a UC id — resolveYtChannelId
// (already used for 7TV/BTTV channel-emote lookups) resolves the real UC...
// id from the join hint URL, since the archive is keyed by UC id, not our
// synthetic tab id. Gated by _ytRecentFetched so it runs once per channelId
// per SW lifetime — youtube_ws_subscribe re-fires on every reconnect/reload,
// unlike kick's join-gated _kpChannels check.
const _ytRecentFetched = new Set()
async function bgYtFetchRecentArchive(channelId, hintUrl) {
  if (!channelId || channelId === 'global' || channelId === '__live_yt_auto__') return
  if (_ytRecentFetched.has(channelId)) return
  _ytRecentFetched.add(channelId)
  if (_ytRecentFetched.size > 500) _ytRecentFetched.delete(_ytRecentFetched.values().next().value)
  const ucid = await resolveYtChannelId(channelId, hintUrl)
  if (!ucid) return
  const rows = await fetchRecentArchiveRows(
    'youtube',
    ucid.toLowerCase(),
    Math.min(BG_ARCHIVE_FETCH_MAX, BG_YT_PERSIST_MAX),
  )
  if (!rows.length) return
  if (!BG_YT.channels.has(channelId)) BG_YT.channels.set(channelId, new BGCircularBuffer(BG_YT_PERSIST_MAX))
  const buf = BG_YT.channels.get(channelId)
  const { toAdd, merged } = mergeRecentArchiveRows(buf.getAll(), rows, 'youtube')
  if (!toAdd.length) return
  buf.clear()
  for (const m of merged) buf.push(m)
  bgYtPersistChannel(channelId)
  // Feed straight into the same replay pipeline the live relay's own history
  // batches use (social.js's youtube_chat_message{replay:true} →
  // ingestReplayYtMsg), so rendering/paints/emotes/dedup all run through the
  // exact code the local buffer (channelYtMessages) already exercises. Rows
  // render PREPENDED into position by real timestamp — ingestReplayYtMsg
  // never reshuffles existing rows.
  for (const m of toAdd) broadcastToTabs(ytReplayMessageFor(channelId, m))
  log('BG YT recent-archive merged', toAdd.length, 'msgs for', channelId)
}

function ytReplayMessageFor(channelId, m) {
  return {
    type: 'youtube_chat_message',
    videoId: '',
    channelId,
    id: m.id || undefined,
    user: m.user,
    text: m.text,
    color: m.color,
    time: m.time,
    platform: 'youtube',
    emotes: [],
    msgType: m.msgType,
    amount: '',
    scColor: '',
    sticker: null,
    badges: m.badges,
    source: 'server',
    replay: true,
  }
}

// Replay the BG_YT buffer to ONE tab — the surface that just subscribed.
// The one-shot broadcast above only reaches surfaces alive at merge time;
// a multichat that boots (or a popout opened) AFTER it saw nothing until a
// hard refresh restored persisted storage. This closes that gap at the
// single chokepoint every subscribe path funnels through, targeted so a
// reconnecting surface never storms every other tab. ingestReplayYtMsg's
// dedup absorbs the overlap for surfaces that already hold these rows.
const YT_REPLAY_TO_TAB_MAX = 200
async function bgYtReplayToTab(tabId, channelId) {
  if (!tabId || !channelId || channelId === 'global') return
  try {
    if (!BG_YT.storageRestored) await bgYtRestoreFromStorage()
    const buf = BG_YT.channels.get(channelId)
    if (!buf) return
    const msgs = buf.getAll().slice(-YT_REPLAY_TO_TAB_MAX)
    for (const m of msgs) {
      browser.tabs.sendMessage(tabId, ytReplayMessageFor(channelId, m)).catch(() => {})
    }
  } catch {}
}

// ─── YouTube innertube fallback tap ──────────────────────────────────────────
// Last line of yt chat resilience. Two primaries already cover live chat: the
// heatsync server's innertube poller (relayed over WS as 'youtube:chat') and
// the DOM tap (youtube-content.js scraping the live_chat iframe, relayed as
// 'youtube_chat_message'). Both can go dark independently — a server poller
// crash, or simply no youtube.com tab open (multichat watching a channel from
// a twitch/kick tab only). main.js's per-channel watchdog already escalates
// re-subscribe → unsubscribe+resubscribe → BG WS reconnect at a 180s silence
// threshold (src/multichat/main.js ~13633); if NONE of that revives the
// channel within YT_TAP_SILENCE_MS, this tap opens its own on-demand
// innertube poller straight from the service worker — no page, no iframe,
// just a bootstrap fetch + POST poll loop porting
// heatsync/server/services/youtube-chat.ts. It stands down the instant a
// primary delivers again. One poller at a time (YT_TAP_MAX_POLLERS) — this is
// a last-resort backstop, not a third standing transport.
const YT_TAP_SILENCE_MS = 300000 // 5 min — after the 180s watchdog escalation exhausts itself
const YT_TAP_POLL_MS = 6000
const YT_TAP_FETCH_TIMEOUT_MS = 10000
const YT_TAP_MAX_ERRORS = 5
const YT_TAP_COOLDOWN_MS = 300000
const YT_TAP_MAX_POLLERS = 1
const YT_TAP_WANTED_TTL_MS = 900000 // 15 min

// videoId → ms of last message delivered by a PRIMARY (server relay or DOM
// tap). Tap-fed batches (handleYoutubeChatBatch fromTap:true) never stamp
// this — self-feeding would make the tap look like a perpetually-healthy
// primary and it would never stand down.
const _ytTapLastDelivery = new Map()
// videoId → ms a tab last subscribed to it. TTL'd (see ytTapWantedExpired)
// rather than cleared strictly on unsubscribe, so a brief resubscribe gap
// (nav, reload) doesn't masquerade as a fresh video needing a fresh silence
// window. NEVER seeded from the persisted yt_video_to_channel storage restore
// (~9748) — that map survives across SW restarts for routing, but wantedness
// must reflect an ACTUAL subscribe this session (stale-restore trap: a video
// nobody re-subscribed to would otherwise look permanently "wanted").
const _ytTapWantedAt = new Map()
// videoId → { timer, continuation, apiKey, innertubeContext, seenIds, errorCount }
const _ytTapPollers = new Map()
// videoId → ms cooldown expires (post-close backoff before reopening)
const _ytTapCooldownUntil = new Map()

globalThis.__hsYtTapStats = {
  ticks: 0,
  gate: '',
  opens: 0,
  polls: 0,
  msgs: 0,
  replayMsgs: 0,
  errors: 0,
  lastStatus: 0,
  lastPollLatencyMs: 0,
  active: [],
  cooldowns: 0,
}

// yt-innertube-tap subsystem toggle, mirrored into memory from storage.sync
// ui_settings.subsystems — mirrors the read-boot + onChanged pattern
// content.js uses for its own subsystem gates (content.js ~11738) so the 30s
// check tick never blocks on an async storage read. Defaults ON (matches
// settings-schema.js's subsystems default map).
let _ytTapSubsystemOn = true
browser.storage.sync
  .get(['ui_settings'])
  .then((d) => {
    if (d?.ui_settings?.subsystems?.['yt-innertube-tap'] === false) _ytTapSubsystemOn = false
  })
  .catch(() => {})
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync' || !changes.ui_settings) return
  const subs = changes.ui_settings.newValue?.subsystems
  if (subs) _ytTapSubsystemOn = subs['yt-innertube-tap'] !== false
})

// ── wantedness ──────────────────────────────────────────────────────────────

function ytTapMarkWanted(videoId) {
  if (!videoId) return
  // Seed on FIRST sighting only — activation needs an OBSERVED silence, not
  // "no data since a boot we didn't watch".
  if (!_ytTapLastDelivery.has(videoId)) _ytTapLastDelivery.set(videoId, Date.now())
  _ytTapWantedAt.set(videoId, Date.now())
}

function ytTapUnmarkWanted(videoId) {
  if (!videoId) return
  _ytTapWantedAt.delete(videoId)
  _ytTapLastDelivery.delete(videoId)
  ytTapClose(videoId, 'unwanted')
}

// ── pure helpers (unit-tested) ────────────────────────────────────────────

function ytTapShouldActivate(lastDeliveryMs, nowMs) {
  return !lastDeliveryMs || nowMs - lastDeliveryMs >= YT_TAP_SILENCE_MS
}

function ytTapWantedExpired(wantedAtMs, nowMs) {
  return !wantedAtMs || nowMs - wantedAtMs > YT_TAP_WANTED_TTL_MS
}

// Innertube ships two ytInitialData assignment forms across page variants.
function ytTapExtractInitialData(html) {
  const m = html.match(/window\["ytInitialData"\]\s*=\s*({.+?});/) || html.match(/var\s+ytInitialData\s*=\s*({.+?});/)
  if (!m) return null
  try {
    return JSON.parse(m[1])
  } catch {
    return null
  }
}

// Continuation token rides one of three shapes depending on chat state
// (invalidation = normal live tick, timed = slow-mode-style throttle,
// reload = the chat needs a hard resync). Port of youtube-chat.ts ~699-706.
function ytTapExtractContinuation(continuations) {
  if (!continuations?.length) return null
  return (
    continuations[0]?.invalidationContinuationData?.continuation ||
    continuations[0]?.timedContinuationData?.continuation ||
    continuations[0]?.reloadContinuationData?.continuation ||
    null
  )
}

// Mutates `seenIds` in place: adds a new id and returns true, or returns
// false for a dup. Caps growth by evicting the oldest 500 once past 2000 —
// Set iteration order is insertion order, so "oldest" is well-defined.
function ytTapSeenIdIsNew(seenIds, msgId) {
  if (!msgId) return true
  if (seenIds.has(msgId)) return false
  seenIds.add(msgId)
  if (seenIds.size > 2000) {
    const iter = seenIds.values()
    for (let i = 0; i < 500; i++) iter.next()
    const toKeep = new Set()
    for (const v of iter) toKeep.add(v)
    seenIds.clear()
    for (const v of toKeep) seenIds.add(v)
  }
  return true
}

function ytTapText(node) {
  if (!node) return ''
  if (typeof node.simpleText === 'string') return node.simpleText
  if (Array.isArray(node.runs)) return node.runs.map((r) => r.text || '').join('')
  return ''
}

function ytTapTimestamp(r) {
  return r?.timestampUsec ? Math.floor(Number.parseInt(r.timestampUsec, 10) / 1000) : Date.now()
}

// Flattens a run list into display text + an emotes array. Standard unicode
// emoji ride as their real char (emojiId short, no slash) so clients render
// them natively; yt-exclusive/member emoji are image-only (opaque UCxxx/yyy
// ids) and fall back to a :shortcut:-style alt the emotes array replaces
// with the image. Port of youtube-chat.ts parseRuns (~1002-1037).
function ytTapParseRuns(runs) {
  let text = ''
  const emotes = []
  if (!runs) return { text, emotes }
  for (const run of runs) {
    if (run.text) {
      text += run.text
      continue
    }
    if (!run.emoji) continue
    const url = run.emoji?.image?.thumbnails?.[0]?.url || ''
    const emojiId = run.emoji?.emojiId || ''
    const isUnicode = !!emojiId && emojiId.length <= 8 && !emojiId.includes('/')
    if (isUnicode) {
      text += emojiId
      continue
    }
    const rawAlt = run.emoji?.shortcuts?.[0] || run.emoji?.image?.accessibility?.accessibilityData?.label || ''
    const alt = rawAlt.replace(/<[^>]*>/g, '').trim() || '😀'
    if (url) {
      emotes.push({ type: 'emoji', url, alt })
      text += alt
    }
  }
  return { text, emotes }
}

function ytTapParseTextMessage(r, videoId) {
  const user = r.authorName?.simpleText || ''
  if (!user) return null
  const { text, emotes } = ytTapParseRuns(r.message?.runs)
  if (!text.trim()) return null
  return {
    type: 'text',
    user,
    text,
    emotes,
    timestamp: ytTapTimestamp(r),
    videoId,
    authorChannelId: r.authorExternalChannelId || undefined,
  }
}

function ytTapSuperChatColor(amount) {
  if (amount >= 100) return '#e62117'
  if (amount >= 50) return '#e91e63'
  if (amount >= 20) return '#ff6d00'
  if (amount >= 10) return '#ffd600'
  if (amount >= 5) return '#00c853'
  if (amount >= 2) return '#00bfa5'
  return '#1565c0'
}

function ytTapParseSuperChat(r, videoId) {
  const user = r.authorName?.simpleText || ''
  if (!user) return null
  const { text, emotes } = ytTapParseRuns(r.message?.runs)
  const amount = r.purchaseAmountText?.simpleText || ''
  const numMatch = amount.match(/([\d,.]+)/)
  const num = numMatch ? Number.parseFloat(numMatch[1].replace(',', '')) : 0
  return {
    type: 'superchat',
    user,
    text: text || '',
    emotes,
    timestamp: ytTapTimestamp(r),
    videoId,
    amount,
    color: ytTapSuperChatColor(num),
    authorChannelId: r.authorExternalChannelId || undefined,
  }
}

function ytTapParseSuperSticker(r, videoId) {
  const user = r.authorName?.simpleText || ''
  if (!user) return null
  const amount = r.purchaseAmountText?.simpleText || ''
  const stickerUrl = r.sticker?.thumbnails?.[0]?.url || ''
  const stickerAlt = r.sticker?.accessibility?.accessibilityData?.label || 'sticker'
  const numMatch = amount.match(/([\d,.]+)/)
  const num = numMatch ? Number.parseFloat(numMatch[1].replace(',', '')) : 0
  return {
    type: 'supersticker',
    user,
    text: '',
    emotes: [],
    timestamp: ytTapTimestamp(r),
    videoId,
    amount,
    color: ytTapSuperChatColor(num),
    authorChannelId: r.authorExternalChannelId || undefined,
    sticker: { url: stickerUrl, alt: stickerAlt },
  }
}

function ytTapParseMembership(r, videoId) {
  const user = r.authorName?.simpleText || ''
  if (!user) return null
  const milestone = ytTapText(r.headerPrimaryText)
  const systemMsg = milestone ? `${user}: ${milestone}` : `${user} became a member`
  const { text, emotes } = ytTapParseRuns(r.message?.runs)
  return {
    type: 'membership',
    user,
    text: text || '',
    emotes,
    timestamp: ytTapTimestamp(r),
    videoId,
    systemMsg,
    authorChannelId: r.authorExternalChannelId || undefined,
  }
}

function ytTapParseGiftPurchase(r, videoId) {
  const h = r.header?.liveChatSponsorshipsHeaderRenderer
  const user = h?.authorName?.simpleText || ''
  if (!user) return null
  const primary = ytTapText(h?.primaryText)
  const lead = primary ? primary.charAt(0).toLowerCase() + primary.slice(1) : 'gifted memberships'
  return {
    type: 'giftpurchase',
    user,
    text: '',
    emotes: [],
    timestamp: ytTapTimestamp(r),
    videoId,
    systemMsg: `${user} ${lead}`,
    authorChannelId: r.authorExternalChannelId || undefined,
  }
}

function ytTapParseGiftRedemption(r, videoId) {
  const user = r.authorName?.simpleText || ''
  if (!user) return null
  const detail = ytTapText(r.message) || 'was gifted a membership'
  return {
    type: 'giftredemption',
    user,
    text: '',
    emotes: [],
    timestamp: ytTapTimestamp(r),
    videoId,
    systemMsg: `${user} ${detail}`,
    authorChannelId: r.authorExternalChannelId || undefined,
  }
}

// Port of youtube-chat.ts parseActions (~869-959) — 6 renderer types, id
// attached post-parse so every push shares one dedup-key code path. Mod
// deletions (markChatItemAsDeletedAction / removeChatItemAction and their
// by-author variants) are DELIBERATELY skipped: there is no ext ingest path
// for a tap-sourced deletion (youtube_msg_deleted is DOM-tap-only, keyed off
// a live DOM node this poller never touches) — accepted gap, not a bug.
function ytTapParseActions(actions, videoId, seenIds) {
  const messages = []
  for (const action of actions) {
    const item = action?.addChatItemAction?.item
    if (!item) continue
    const renderer =
      item.liveChatTextMessageRenderer ||
      item.liveChatPaidMessageRenderer ||
      item.liveChatPaidStickerRenderer ||
      item.liveChatMembershipItemRenderer ||
      item.liveChatSponsorshipsGiftPurchaseAnnouncementRenderer ||
      item.liveChatSponsorshipsGiftRedemptionAnnouncementRenderer
    if (!renderer) continue
    const msgId = renderer.id || renderer.timestampUsec || ''
    if (seenIds && msgId && !ytTapSeenIdIsNew(seenIds, msgId)) continue
    const pushWithId = (msg) => {
      if (!msg) return
      if (msgId) msg.id = String(msgId)
      messages.push(msg)
    }
    if (item.liveChatTextMessageRenderer) pushWithId(ytTapParseTextMessage(item.liveChatTextMessageRenderer, videoId))
    if (item.liveChatPaidMessageRenderer) pushWithId(ytTapParseSuperChat(item.liveChatPaidMessageRenderer, videoId))
    if (item.liveChatPaidStickerRenderer) pushWithId(ytTapParseSuperSticker(item.liveChatPaidStickerRenderer, videoId))
    if (item.liveChatMembershipItemRenderer)
      pushWithId(ytTapParseMembership(item.liveChatMembershipItemRenderer, videoId))
    if (item.liveChatSponsorshipsGiftPurchaseAnnouncementRenderer)
      pushWithId(ytTapParseGiftPurchase(item.liveChatSponsorshipsGiftPurchaseAnnouncementRenderer, videoId))
    if (item.liveChatSponsorshipsGiftRedemptionAnnouncementRenderer)
      pushWithId(ytTapParseGiftRedemption(item.liveChatSponsorshipsGiftRedemptionAnnouncementRenderer, videoId))
  }
  return messages
}

// Public innertube web-client key baked into every youtube.com page — not a
// secret, just client identification. Fallback only: the live_chat page's
// own INNERTUBE_API_KEY (extracted below) is used whenever present.
const YT_TAP_FALLBACK_API_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8'
const YT_TAP_DEFAULT_CONTEXT = { client: { clientName: 'WEB', clientVersion: '2.20240101.00.00', hl: 'en', gl: 'US' } }

// Port of youtube-chat.ts fetchInitialChat (~673-741), trimmed to what the
// tap needs (no channel/title/owner extraction — the ext already knows the
// channel via ytChannelsFor; archiving is server-only).
function ytTapParseBootstrap(html, videoId) {
  const ytData = ytTapExtractInitialData(html)
  if (!ytData) return null
  const continuations =
    ytData?.continuationContents?.liveChatContinuation?.continuations ||
    ytData?.contents?.liveChatRenderer?.continuations
  const continuation = ytTapExtractContinuation(continuations)
  if (!continuation) return null
  const keyMatch = html.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/)
  const apiKey = keyMatch?.[1] || YT_TAP_FALLBACK_API_KEY
  let innertubeContext = YT_TAP_DEFAULT_CONTEXT
  const ctxMatch = html.match(/"INNERTUBE_CONTEXT"\s*:\s*({.+?})\s*,\s*"/)
  if (ctxMatch) {
    try {
      innertubeContext = JSON.parse(ctxMatch[1])
    } catch {}
  }
  const actions =
    ytData?.continuationContents?.liveChatContinuation?.actions || ytData?.contents?.liveChatRenderer?.actions || []
  const messages = ytTapParseActions(actions, videoId)
  return { continuation, apiKey, innertubeContext, messages }
}

// ── poller lifecycle ────────────────────────────────────────────────────────

async function ytTapFetchText(url, init) {
  const resp = await fetch(url, { ...init, signal: AbortSignal.timeout(YT_TAP_FETCH_TIMEOUT_MS) })
  if (!resp.ok) return null
  return resp.text()
}

function ytTapSchedulePoll(entry) {
  if (_ytTapPollers.get(entry.videoId) !== entry) return
  entry.timer = setTimeout(() => ytTapPoll(entry), YT_TAP_POLL_MS)
}

async function ytTapPoll(entry) {
  const stats = globalThis.__hsYtTapStats
  if (_ytTapPollers.get(entry.videoId) !== entry) return // closed while scheduled
  stats.polls++
  const pollStart = Date.now()
  const onErrorTick = () => {
    entry.errorCount++
    stats.errors++
    if (entry.errorCount > YT_TAP_MAX_ERRORS) {
      ytTapClose(entry.videoId, 'max-errors')
      _ytTapCooldownUntil.set(entry.videoId, Date.now() + YT_TAP_COOLDOWN_MS)
      stats.cooldowns++
      return
    }
    ytTapSchedulePoll(entry)
  }
  try {
    const resp = await fetch(`https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=${entry.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: entry.innertubeContext, continuation: entry.continuation }),
      signal: AbortSignal.timeout(YT_TAP_FETCH_TIMEOUT_MS),
    })
    if (_ytTapPollers.get(entry.videoId) !== entry) return // closed mid-fetch
    stats.lastStatus = resp.status
    stats.lastPollLatencyMs = Date.now() - pollStart
    if (!resp.ok) {
      onErrorTick()
      return
    }
    const data = await resp.json().catch(() => null)
    if (_ytTapPollers.get(entry.videoId) !== entry) return
    entry.errorCount = 0
    const continuations = data?.continuationContents?.liveChatContinuation?.continuations
    if (!continuations?.length) {
      // Stream ended. Close + cooldown, but do NOT emit youtube:status
      // 'ended' — that signal belongs to the primaries (server relay /
      // watchdog); the tap only ever reacts to silence, never declares a
      // stream over.
      ytTapClose(entry.videoId, 'ended')
      _ytTapCooldownUntil.set(entry.videoId, Date.now() + YT_TAP_COOLDOWN_MS)
      stats.cooldowns++
      return
    }
    const newCont = ytTapExtractContinuation(continuations)
    if (newCont) entry.continuation = newCont // never persisted — memory-only
    const actions = data?.continuationContents?.liveChatContinuation?.actions || []
    const messages = ytTapParseActions(actions, entry.videoId, entry.seenIds)
    if (messages.length) {
      stats.msgs += messages.length
      handleYoutubeChatBatch(
        { type: 'youtube:chat', videoId: entry.videoId, messages, replay: false },
        { fromTap: true },
      )
    }
    ytTapSchedulePoll(entry)
  } catch (e) {
    if (_ytTapPollers.get(entry.videoId) !== entry) return
    if (e?.name === 'AbortError' || e?.name === 'TimeoutError') {
      // Timeout — reschedule without counting as an error (transient).
      ytTapSchedulePoll(entry)
      return
    }
    onErrorTick()
  }
}

async function ytTapOpen(videoId) {
  if (_ytTapPollers.has(videoId) || _ytTapPollers.size >= YT_TAP_MAX_POLLERS) return
  const stats = globalThis.__hsYtTapStats
  const entry = {
    videoId,
    timer: null,
    continuation: null,
    apiKey: null,
    innertubeContext: null,
    seenIds: new Set(),
    errorCount: 0,
  }
  _ytTapPollers.set(videoId, entry) // reserve the slot before the async gap
  stats.opens++
  stats.active = [..._ytTapPollers.keys()]
  try {
    const html = await ytTapFetchText(`https://www.youtube.com/live_chat?v=${encodeURIComponent(videoId)}`)
    if (_ytTapPollers.get(videoId) !== entry) return // closed mid-fetch (toggle-off, unwanted, etc.)
    const boot = html && ytTapParseBootstrap(html, videoId)
    if (!boot) {
      _ytTapPollers.delete(videoId)
      stats.active = [..._ytTapPollers.keys()]
      _ytTapCooldownUntil.set(videoId, Date.now() + YT_TAP_COOLDOWN_MS)
      stats.cooldowns++
      return
    }
    entry.continuation = boot.continuation
    entry.apiKey = boot.apiKey
    entry.innertubeContext = boot.innertubeContext
    if (boot.messages.length) {
      stats.replayMsgs += boot.messages.length
      // Gap-fill path: replay:true so the surface's replay pipeline (bulk
      // buffer + one render) takes these, not the live drip pacer — the
      // pacer rewrites arrival times, which would smear a burst of
      // already-real timestamps across several seconds for no reason.
      handleYoutubeChatBatch(
        { type: 'youtube:chat', videoId, messages: boot.messages, replay: true },
        { fromTap: true },
      )
    }
    ytTapSchedulePoll(entry)
  } catch {
    if (_ytTapPollers.get(videoId) === entry) {
      _ytTapPollers.delete(videoId)
      stats.active = [..._ytTapPollers.keys()]
    }
    _ytTapCooldownUntil.set(videoId, Date.now() + YT_TAP_COOLDOWN_MS)
    stats.cooldowns++
  }
}

function ytTapClose(videoId, reason) {
  const entry = _ytTapPollers.get(videoId)
  if (!entry) return
  if (entry.timer) clearTimeout(entry.timer)
  _ytTapPollers.delete(videoId)
  const stats = globalThis.__hsYtTapStats
  stats.active = [..._ytTapPollers.keys()]
  stats.gate = `closed:${videoId}:${reason}`
}

// ── check tick (rides the 'keepalive' alarm, ~30s) ──────────────────────────

function ytTapCheck() {
  const stats = globalThis.__hsYtTapStats
  stats.ticks++
  if (!_ytTapSubsystemOn) {
    stats.gate = 'toggle-off'
    for (const vid of [..._ytTapPollers.keys()]) ytTapClose(vid, 'toggle-off')
    return
  }
  const now = Date.now()
  for (const [vid, at] of [..._ytTapWantedAt]) {
    if (ytTapWantedExpired(at, now)) {
      _ytTapWantedAt.delete(vid)
      _ytTapLastDelivery.delete(vid)
      ytTapClose(vid, 'wanted-expired')
    }
  }
  // Candidates: wanted AND still bound to a real channel (ytChannelsFor is
  // the same routing table youtube:chat itself resolves against).
  const candidates = [..._ytTapWantedAt.keys()].filter((vid) => ytChannelsFor(vid).length > 0)
  const candidateSet = new Set(candidates)
  for (const vid of [..._ytTapPollers.keys()]) {
    if (!candidateSet.has(vid)) {
      ytTapClose(vid, 'unbound')
      continue
    }
    if (!ytTapShouldActivate(_ytTapLastDelivery.get(vid), now)) ytTapClose(vid, 'primary-recovered')
  }
  if (_ytTapPollers.size >= YT_TAP_MAX_POLLERS) {
    stats.gate = `active:${[..._ytTapPollers.keys()].join(',')}`
    return
  }
  let best = null
  for (const vid of candidates) {
    if (_ytTapPollers.has(vid)) continue
    if ((_ytTapCooldownUntil.get(vid) || 0) > now) continue
    if (!ytTapShouldActivate(_ytTapLastDelivery.get(vid), now)) continue
    const wantedAt = _ytTapWantedAt.get(vid) || 0
    if (!best || wantedAt > best.wantedAt) best = { vid, wantedAt }
  }
  if (best) {
    stats.gate = `opening:${best.vid}`
    ytTapOpen(best.vid)
  } else {
    stats.gate = candidates.length ? 'primary-healthy' : 'no-candidates'
  }
}

// ─── Kick chat tap (client-side, anonymous, centrifugo) ─────────────────────
// Reads Kick chat straight from Kick's own realtime stream instead of waiting on
// the server webhook relay — lower latency, no per-app subscription cap, and it
// survives server hiccups. Each message carries the Kick message_id, so the
// overlay's KickChat id-dedup silently drops the duplicate from the (still
// running) server relay. If this tap can't connect/resolve a channel, that
// channel simply keeps flowing through the server relay — automatic fallback.
//
// Kick moved from pusher to centrifugo (2026-11). Where to connect and the
// guest token are asked fresh on EVERY connect — the answer changes. The event
// names and payloads inside a publication are unchanged from the pusher era, so
// everything below the transport (the _kpHandle* family) is untouched.
const KICK_TAP = true
const KICK_REALTIME_API = 'https://web.kick.com/api'
// Kick's channel-scoped scope (KICKs gifts, pins, polls, hosts ride it) — a
// chatroom id and a channel id are different numbers, see _kpResolveChatroomId.
const KICK_CHANNEL_SCOPE = 'channel_'
const KP_MAX_REFUSALS = 5 // consecutive refusals before the tap stands down
const KP_REARM_MS = 30 * 60 * 1000 // …and re-arms on the next join or after this
let _kpWs = null
let _kpConnected = false
let _kpConnecting = false // discovery in flight
let _kpReconnectMs = 1000
let _kpReconnectTimer = null
let _kpTtlTimer = null
let _kpLastData = 0
let _kpConnectingAt = 0
let _kpNextId = 1
const _kpPending = new Map() // command id -> centrifugo channel it subscribed
const _kpChannels = new Map() // slug -> chatroomId (currently subscribed)
const _kpChatroomCache = new Map() // slug -> chatroomId (resolved)
// slug -> kick CHANNEL id (a different number from the chatroom id). Kept
// separately because only some events ride the channel-scoped channel.
const _kpChannelIdCache = new Map()
const _kpSubbedChannelIds = new Map() // slug -> channelId (currently subscribed)
// The tap's backoff has an end. `streak` counts refusals in a row (discovery
// declined, socket error, close before the connect ack); a refused subscribe is
// counted per CHANNEL in subFails, never against the transport.
const _kpNet = {
  streak: 0,
  stopped: false,
  stoppedAt: 0,
  lastReason: '',
  refusals: 0,
  connects: 0,
  rearms: 0,
  recycles: 0,
  subFails: new Map(), // centrifugo channel -> consecutive refused subscribes
}
// Per-source delivery counters — the tap and the server relay fail silently
// (resolve miss, unmatched chatroom, dead socket); counters make "which source
// delivered the last message for this slug" answerable from a live probe.
const _kickSrcStats = { tap: new Map(), relay: new Map(), tapUnmatched: 0, net: _kpNet } // slug -> {n, lastAt, lastId}
function _kickSrcBump(map, slug, id) {
  const e = map.get(slug) || { n: 0, lastAt: 0, lastId: '' }
  e.n++
  e.lastAt = Date.now()
  e.lastId = id || ''
  map.set(slug, e)
}

async function _kpResolveChatroomId(slug) {
  if (_kpChatroomCache.has(slug)) return _kpChatroomCache.get(slug)
  try {
    const r = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`, { credentials: 'include' })
    if (!r.ok) return null
    const j = await r.json()
    const id = j?.chatroom?.id
    // The CHANNEL id is a different number from the chatroom id, and the same
    // response carries both. KICKs ride `channel_<channelId>`, not the chatroom
    // channel — captured live 2026-07-21 — so grab it here rather than paying a
    // second round-trip later.
    if (j?.id != null) {
      if (_kpChannelIdCache.size >= 200) _kpChannelIdCache.delete(_kpChannelIdCache.keys().next().value)
      _kpChannelIdCache.set(slug, j.id)
    }
    if (id) {
      if (_kpChatroomCache.size >= 200) _kpChatroomCache.delete(_kpChatroomCache.keys().next().value)
      _kpChatroomCache.set(slug, id)
      return id
    }
  } catch {}
  return null
}

// Where to connect and with what, for one connection. Never throws — every
// failure on this path is a refusal and reaches the caller as a reason.
async function _kpDiscover(channelId) {
  const post = async (path, body) => {
    try {
      const r = await fetch(`${KICK_REALTIME_API}${path}`, {
        method: 'POST',
        credentials: 'omit',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      })
      if (!r.ok) return null
      const j = await r.json()
      return j && typeof j === 'object' ? j : null
    } catch {
      return null
    }
  }
  if (channelId == null) return { reason: 'no channel id' }
  const clientId = crypto.randomUUID()
  const conn = await post(`/v1/realtime/channels/${encodeURIComponent(channelId)}/chat/connection`, {
    client: { id: clientId, type: 'web' },
    // Both, in kick's own order: naming only centrifugo would make this the
    // reason a future move back to pusher reads as an outage.
    capabilities: { accepted_providers: [{ provider: 'pusher' }, { provider: 'centrifugo' }] },
  })
  if (!conn) return { reason: 'realtime endpoint declined' }
  if (conn.data?.mode !== 'websocket') return { reason: `realtime mode ${String(conn.data?.mode).slice(0, 16)}` }
  const list = Array.isArray(conn.data?.connections) ? conn.data.connections : []
  const url = list.find((c) => c && c.provider === 'centrifugo')?.credentials?.url
  if (typeof url !== 'string' || !url.startsWith('wss://')) return { reason: 'no centrifugo url offered' }
  const auth = await post('/v1/realtime/auth/connection', { client_id: clientId })
  if (!auth) return { reason: 'realtime auth declined' }
  const token = auth.data?.token
  if (typeof token !== 'string' || !token) return { reason: 'no connection token' }
  return { url, token }
}

// Centrifugo json frames -> a short list of what we act on. Pure. Replies may
// be packed several to a message, newline-delimited; a frame we can't read is
// skipped, never thrown on (nothing is left to catch it in a socket callback).
//   {}                                  -> ping (answer with {})
//   {id, error:{code}}                  -> error
//   {id, connect:{ttl}}                 -> connect
//   {id, subscribe:{}}                  -> subscribed (matched by id, names nothing)
//   {push:{channel, pub:{data:{event,data}}}} -> pub, the pusher-era {event, channel, data}
//   {push:{channel, unsubscribe}}       -> unsub
function _kpFrames(raw) {
  const out = []
  for (const line of String(raw).split('\n')) {
    if (!line.trim()) continue
    let f
    try {
      f = JSON.parse(line)
    } catch {
      continue
    }
    if (!f || typeof f !== 'object' || Array.isArray(f)) continue
    if (!Object.keys(f).length) {
      out.push({ kind: 'ping' })
      continue
    }
    const id = typeof f.id === 'number' ? f.id : null
    if (f.error && typeof f.error === 'object') {
      out.push({ kind: 'error', id, code: Number(f.error.code) || 0 })
    } else if (f.connect && typeof f.connect === 'object') {
      out.push({ kind: 'connect', ttl: Number(f.connect.ttl) || 0 })
    } else if (f.subscribe && typeof f.subscribe === 'object' && id !== null) {
      out.push({ kind: 'subscribed', id })
    } else if (f.push && typeof f.push === 'object') {
      const channel = typeof f.push.channel === 'string' ? f.push.channel : ''
      const inner = f.push.pub?.data
      if (inner && typeof inner === 'object' && typeof inner.event === 'string') {
        out.push({ kind: 'pub', event: inner.event, channel, data: inner.data })
      } else if (f.push.unsubscribe) {
        out.push({ kind: 'unsub', channel })
      }
    }
  }
  return out
}

function _kpSend(obj) {
  if (!_kpConnected || !_kpWs) return false
  try {
    _kpWs.send(JSON.stringify(obj))
    return true
  } catch {
    return false
  }
}
function _kpSub(channel) {
  if ((_kpNet.subFails.get(channel) || 0) >= KP_MAX_REFUSALS) return // given up on this one
  const id = _kpNextId + 1
  if (!_kpSend({ subscribe: { channel }, id })) return
  _kpNextId = id
  _kpPending.set(id, channel)
}
function _kpUnsub(channel) {
  _kpNet.subFails.delete(channel)
  if (_kpSend({ unsubscribe: { channel }, id: _kpNextId + 1 })) _kpNextId++
}
const _kpRoom = (chatroomId) => `chatrooms.${chatroomId}.v2`
const _kpScope = (channelId) => `${KICK_CHANNEL_SCOPE}${channelId}`
function _kpSubscribe(chatroomId) {
  _kpSub(_kpRoom(chatroomId))
}
// Second subscription per joined channel, for the events kick does NOT put on
// the chatroom channel. One extra command on the socket we already hold.
function _kpSubscribeChannelScoped(channelId) {
  if (channelId != null) _kpSub(_kpScope(channelId))
}
function _kpUnsubscribeChannelScoped(channelId) {
  if (channelId != null) _kpUnsub(_kpScope(channelId))
}
function _kpUnsubscribe(chatroomId) {
  _kpUnsub(_kpRoom(chatroomId))
}
function _kpSlugForChannelId(channelId) {
  for (const [slug, id] of _kpSubbedChannelIds) if (String(id) === String(channelId)) return slug
  return null
}

function _kpClearTimers() {
  if (_kpReconnectTimer) clearTimeout(_kpReconnectTimer)
  if (_kpTtlTimer) clearTimeout(_kpTtlTimer)
  _kpReconnectTimer = null
  _kpTtlTimer = null
}
function _kpScheduleReconnect() {
  if (_kpReconnectTimer || !KICK_TAP || _kpNet.stopped || !_kpChannels.size) return
  _kpReconnectTimer = setTimeout(() => {
    _kpReconnectTimer = null
    _kpConnect()
  }, _kpReconnectMs)
  _kpReconnectMs = Math.min(_kpReconnectMs * 2, 30000)
}
// One refusal: discovery declined, the socket errored, or it closed before the
// connect ack. KP_MAX_REFUSALS in a row and the tap stands down — the server
// relay carries on — until the next join or KP_REARM_MS (the watchdog alarm
// checks the clock; no timer is left running for it).
function _kpRefuse(reason) {
  _kpNet.refusals++
  _kpNet.lastReason = reason
  if (++_kpNet.streak >= KP_MAX_REFUSALS) {
    _kpNet.stopped = true
    _kpNet.stoppedAt = Date.now()
    _kpClearTimers()
    log(`KP: ${reason} x${_kpNet.streak} — standing down`)
    return
  }
  _kpScheduleReconnect()
}
function _kpRearm() {
  if (!_kpNet.stopped) return
  _kpNet.stopped = false
  _kpNet.streak = 0
  _kpNet.rearms++
  _kpNet.subFails.clear()
  _kpReconnectMs = 1000
}
function _kpDetach() {
  const ws = _kpWs
  _kpWs = null
  _kpConnected = false
  _kpPending.clear()
  if (ws) {
    try {
      ws.close()
    } catch {}
  }
}

async function _kpConnect() {
  if (_kpWs || _kpConnecting || !KICK_TAP || _kpNet.stopped || !_kpChannels.size) return
  _kpConnecting = true
  let ep
  try {
    ep = await _kpDiscover(_kpSubbedChannelIds.values().next().value ?? _kpChannelIdCache.values().next().value)
  } finally {
    _kpConnecting = false
  }
  // the world moved during the await — a join/leave/another connect won
  if (_kpWs || _kpNet.stopped || !_kpChannels.size) return
  if (ep.reason) return _kpRefuse(ep.reason)
  // Capture the socket locally — a stale socket's late close/error/message
  // events must never clobber a newer _kpWs (leave→join races spawn orphaned
  // duplicate-subscribed sockets otherwise).
  let ws
  try {
    ws = new WebSocket(ep.url)
  } catch {
    return _kpRefuse('socket unopenable')
  }
  _kpWs = ws
  _kpConnectingAt = Date.now()
  let why = '' // what the server said, for the close that follows it
  ws.onopen = () => {
    if (_kpWs !== ws) return
    _kpLastData = Date.now()
    // centrifugo says nothing until spoken to: connect FIRST
    try {
      ws.send(JSON.stringify({ connect: { token: ep.token, name: 'js' }, id: 1 }))
    } catch {}
  }
  ws.onmessage = (e) => {
    if (_kpWs !== ws) return
    _kpLastData = Date.now()
    for (const fr of _kpFrames(e.data)) {
      if (fr.kind === 'ping') {
        try {
          ws.send('{}')
        } catch {}
      } else if (fr.kind === 'connect') {
        _kpConnected = true
        _kpNet.connects++
        // Reset the streak/backoff only on a fully-established session —
        // resetting in onopen lets connect-then-drop failures retry at 1s forever.
        _kpNet.streak = 0
        _kpReconnectMs = 1000
        // the token expires: come back (with a fresh discovery) before it does
        if (fr.ttl > 0) _kpTtlTimer = setTimeout(_kpRecycle, Math.max(60, fr.ttl * 0.9) * 1000)
        for (const id of _kpChannels.values()) _kpSubscribe(id) // (re)assert all subs
        for (const id of _kpSubbedChannelIds.values()) _kpSubscribeChannelScoped(id)
      } else if (fr.kind === 'subscribed') {
        const ch = _kpPending.get(fr.id)
        _kpPending.delete(fr.id)
        if (ch) _kpNet.subFails.delete(ch)
      } else if (fr.kind === 'error') {
        const ch = fr.id == null ? undefined : _kpPending.get(fr.id)
        if (ch === undefined) {
          // a refused connect (or a command we never tracked): the transport
          why = `connect refused (${fr.code})`
          try {
            ws.close()
          } catch {}
          return
        }
        _kpPending.delete(fr.id)
        _kpNet.subFails.set(ch, (_kpNet.subFails.get(ch) || 0) + 1)
        _kpNet.lastReason = `subscribe refused (${fr.code})`
      } else if (fr.kind === 'unsub') {
        _kpNet.subFails.set(fr.channel, (_kpNet.subFails.get(fr.channel) || 0) + 1)
      } else if (fr.kind === 'pub') {
        _kpDispatch(fr)
      }
    }
  }
  ws.onclose = () => {
    if (_kpWs !== ws) return
    const acked = _kpConnected
    _kpDetach()
    if (_kpTtlTimer) clearTimeout(_kpTtlTimer)
    _kpTtlTimer = null
    if (!_kpChannels.size) return
    if (acked) _kpScheduleReconnect()
    else _kpRefuse(why || 'closed before connect ack')
  }
  ws.onerror = () => {
    try {
      ws.close()
    } catch {}
  }
}
// The connection token is about to expire: swap sockets, fresh discovery. Not a
// refusal. Detaching first makes the old socket's late close a no-op.
function _kpRecycle() {
  _kpTtlTimer = null
  if (!_kpWs) return
  _kpNet.recycles++
  _kpDetach()
  _kpConnect()
}

// Zombie/half-open detection — a socket's protocol-level pings are answered by
// the browser's network stack and never reach JS, but centrifugo also sends an
// app-level `{}` every ~25s, so data silence is a real liveness signal. Fired
// from the hs-ws-watchdog alarm, which is also what re-arms a stood-down tap.
function _kpWatchdogCheck() {
  if (!KICK_TAP || !_kpChannels.size) return
  if (_kpNet.stopped) {
    if (Date.now() - _kpNet.stoppedAt < KP_REARM_MS) return
    _kpRearm()
  }
  if (!_kpWs) {
    if (!_kpReconnectTimer) _kpConnect()
    return
  }
  if (!_kpConnected && Date.now() - _kpConnectingAt > 30000) {
    log('KP: connect stuck — closing')
    try {
      _kpWs.close()
    } catch {}
    return
  }
  if (_kpConnected && _kpLastData && Date.now() - _kpLastData > 120000) {
    log('KP: zombie detected — reconnecting')
    try {
      _kpWs.close()
    } catch {}
  }
}

// Pusher-era event names carry an `App\Events\` prefix; centrifugo keeps it.
// Matching is EXACT on the bare name — a substring match once let
// PinnedMessageDeletedEvent hit the MessageDeletedEvent branch, so an unpin
// deleted the pinned chat line and the pin bar never cleared.
function _kpEventName(event) {
  const s = typeof event === 'string' ? event : ''
  return s.startsWith('App\\Events\\') ? s.slice(11) : s
}
function _kpDispatch(d) {
  switch (_kpEventName(d.event)) {
    case 'ChatMessageEvent':
      return _kpHandleChatEvent(d)
    case 'MessageDeletedEvent':
      return _kpHandleModEvent(d, 'delete')
    case 'UserBannedEvent':
      return _kpHandleModEvent(d, 'ban')
    case 'UserUnbannedEvent':
      return _kpHandleModEvent(d, 'unban')
    case 'KicksGifted':
      return _kpHandleKicksEvent(d)
    case 'StreamHostEvent':
      return _kpHandleHostEvent(d)
    case 'PollUpdateEvent':
      return _kpHandlePollEvent(d)
    case 'PinnedMessageCreatedEvent':
      return _kpHandlePinEvent(d, true)
    case 'PinnedMessageDeletedEvent':
      return _kpHandlePinEvent(d, false)
    case 'GiftedSubscriptionsEvent':
      return _kpHandleGiftSubEvent(d)
    case 'SubscriptionEvent':
      return _kpHandleSubEvent(d)
    case 'ChatroomUpdatedEvent':
      // Async (storage.session baseline load) — a rejection here is otherwise
      // an invisible unhandled promise in the SW; pin it for dbg_kick_tap.
      return _kpHandleChatroomUpdated(d).catch((e) => {
        _kpModeStats.lastError = e?.message || 'unknown'
      })
  }
}

function _kpSlugForChatroom(chatroomId) {
  for (const [slug, id] of _kpChannels) if (id === chatroomId) return slug
  return null
}

// Kick chat-mode banners — Twitch parity (see bgIrcHandleLine's roomstate
// branch, ~line 10571). Kick's chatroom channel emits ChatroomUpdatedEvent
// whenever a mod changes slow/sub-only/emote-only/followers mode. Some
// deployments nest the payload under `chatroom` — handle both. Parsed
// defensively: any missing/malformed field is left unset (undefined) rather
// than coerced to a wrong default, so a partial payload only diffs the fields
// it actually carries.
function kpNormalizeChatroomModes(raw) {
  const src = raw && typeof raw.chatroom === 'object' && raw.chatroom ? raw.chatroom : raw
  if (!src || typeof src !== 'object') return {}
  const out = {}
  if (src.slow_mode && typeof src.slow_mode === 'object') {
    out.slow = src.slow_mode.enabled ? Math.max(0, Number(src.slow_mode.message_interval) || 0) : 0
  }
  if (src.subscribers_mode && typeof src.subscribers_mode === 'object') {
    out.subsOnly = !!src.subscribers_mode.enabled
  }
  if (src.emotes_mode && typeof src.emotes_mode === 'object') {
    out.emoteOnly = !!src.emotes_mode.enabled
  }
  if (src.followers_mode && typeof src.followers_mode === 'object') {
    // Kick's min_duration is minutes already (unlike Twitch's seconds-based
    // slow mode) — -1 mirrors Twitch's ROOMSTATE followers=-1 (off) encoding.
    out.followersOnly = src.followers_mode.enabled ? Math.max(0, Number(src.followers_mode.min_duration) || 0) : -1
  }
  // account_age / advanced_bot_protection have no Twitch ROOMSTATE equivalent
  // — intentionally not mapped (no banner surface for them yet).
  return out
}

// Diff two mode-state snapshots into Twitch-parity notice text lines. `prev`
// being {} means "first snapshot for this chatroom" (join replay) — callers
// must skip emitting in that case, same guard Twitch's ROOMSTATE handler uses
// (Object.keys(prev).length) to avoid a banner storm on join.
function kpModeChanges(prev, next) {
  const changes = []
  if (next.slow != null && next.slow !== prev.slow) {
    changes.push(next.slow > 0 ? `slow mode on (${next.slow}s)` : 'slow mode off')
  }
  if (next.subsOnly != null && next.subsOnly !== prev.subsOnly) {
    changes.push(next.subsOnly ? 'sub-only mode on' : 'sub-only mode off')
  }
  if (next.emoteOnly != null && next.emoteOnly !== prev.emoteOnly) {
    changes.push(next.emoteOnly ? 'emote-only mode on' : 'emote-only mode off')
  }
  if (next.followersOnly != null && next.followersOnly !== prev.followersOnly) {
    if (next.followersOnly === -1) changes.push('follower-only mode off')
    else if (next.followersOnly === 0) changes.push('follower-only mode on')
    else changes.push(`follower-only mode on (${next.followersOnly}m)`)
  }
  return changes
}

// slug -> last known {slow, subsOnly, emoteOnly, followersOnly}. Mirrored to
// storage.session: kick does NOT replay ChatroomUpdatedEvent on subscribe
// (live-probed 2026-07-17 — subscription_succeeded carries {}), so a baseline
// only ever forms from a real mode change. In-memory-only meant every MV3 SW
// respawn wiped it and silently swallowed the NEXT real change per channel.
// session scope (not local) still re-arms cleanly across browser restarts.
const _kpModes = new Map()
const _kpModeStats = { events: 0, broadcasts: 0, baselines: 0, lastError: null }
let _kpModesLoadPromise = null
function _kpModesEnsureLoaded() {
  // Memoized as a promise (not a bool): two events in one ws burst must BOTH
  // wait for the seed, or the second reads an empty map and re-baselines.
  _kpModesLoadPromise ??= (async () => {
    try {
      const stored = (await browser.storage.session?.get('kp_modes'))?.kp_modes
      if (stored && typeof stored === 'object') {
        // Seed only slugs a live event hasn't already written this SW lifetime.
        for (const [slug, modes] of Object.entries(stored)) {
          if (!_kpModes.has(slug) && modes && typeof modes === 'object') _kpModes.set(slug, modes)
        }
      }
    } catch {}
  })()
  return _kpModesLoadPromise
}
function _kpModesPersist() {
  try {
    browser.storage.session?.set({ kp_modes: Object.fromEntries(_kpModes) }).catch(() => {})
  } catch {}
}

async function _kpHandleChatroomUpdated(d) {
  let ev
  try {
    ev = typeof d.data === 'string' ? JSON.parse(d.data) : d.data
  } catch {
    return
  }
  if (!ev) return
  const m = /chatrooms\.(\d+)\.v2/.exec(d.channel || '')
  const slug = m ? _kpSlugForChatroom(Number(m[1])) : null
  if (!slug) return
  _kpModeStats.events++
  await _kpModesEnsureLoaded()
  const next = kpNormalizeChatroomModes(ev)
  const prev = _kpModes.get(slug) || {}
  const hadPrev = Object.keys(prev).length > 0
  const merged = { ...prev, ...next }
  _kpModes.set(slug, merged)
  _kpModesPersist()
  if (!hadPrev) {
    _kpModeStats.baselines++
    return // first sighting this browser session — baseline, no banner
  }
  const changes = kpModeChanges(prev, next)
  if (!changes.length) return
  _kpModeStats.broadcasts += changes.length
  const buf = BG_KICK.channels.get(slug)
  for (const text of changes) {
    const evt = {
      type: 'notice',
      noticeType: 'mode_change',
      user: 'system',
      text,
      color: '#ffffff',
      badges: '',
      channel: slug,
      time: Date.now(),
      platform: 'kick',
      id: `kickmode-${slug}-${Date.now()}-${text.slice(0, 16)}`,
      systemMsg: text,
    }
    if (buf) buf.push(evt)
    bgKickPersistChannel(slug)
    broadcastToTabs({ type: 'kick_mode_change', channel: slug, msg: evt })
  }
}

function _kpHandleChatEvent(d) {
  let ev
  try {
    ev = typeof d.data === 'string' ? JSON.parse(d.data) : d.data
  } catch {
    return
  }
  if (!ev) return
  const m = /chatrooms\.(\d+)\.v2/.exec(d.channel || '')
  const slug = m ? _kpSlugForChatroom(Number(m[1])) : null
  if (!slug) {
    _kickSrcStats.tapUnmatched++
    return
  }
  // Match the server webhook relay's data shape exactly (see kick-chat-webhooks
  // handleChatMessage) so the overlay renders identically + dedups by id.
  const payload = {
    platform: 'kick',
    channel: slug,
    username: ev.sender?.username || 'unknown',
    displayName: ev.sender?.username || 'Unknown',
    // kick numeric USER id — reply-threading + kick_<id> identity lookups
    senderId: ev.sender?.id ?? null,
    content: ev.content || '',
    color: ev.sender?.identity?.color || '#53fc18',
    badges: ev.sender?.identity?.badges || [],
    timestamp: ev.created_at ? Date.parse(ev.created_at) || Date.now() : Date.now(),
    id: ev.id || '',
    // Kick threads a reply via metadata.original_sender/original_message — the
    // server relay already forwards this; the kick tap used to drop it (every
    // tapped reply rendered flat). Match the relay's replyTo shape.
    replyTo: ev.metadata?.original_message
      ? {
          username: ev.metadata.original_sender?.username || 'unknown',
          content: ev.metadata.original_message.content || '',
          id: ev.metadata.original_message.id || '',
        }
      : null,
  }
  // Tee into the BG buffer — for tap-only channels this is the ONLY live
  // source, so without it bg_kick_history serves the SW-boot-age snapshot.
  // bgKickIngest dedups by id, so relay+tap doubles don't double-buffer.
  try {
    bgKickIngest(payload)
  } catch {}
  _kickSrcBump(_kickSrcStats.tap, slug, payload.id)
  broadcastToTabs({ type: 'kick_chat_message', data: payload })
}

// Kick broadcasts moderation on the same chatroom channel as chat. Mirror
// Twitch's CLEARCHAT/CLEARMSG so bans/timeouts/deletes by the streamer or ANY
// mod reflect in the ext (dim the offender's messages + a system line), not just
// self-actions. Emits a notice-shaped payload the overlay's platform-agnostic
// mod handler already understands (irc.js → irc.on('message')).
function _kpHandleModEvent(d, kind) {
  let ev
  try {
    ev = typeof d.data === 'string' ? JSON.parse(d.data) : d.data
  } catch {
    return
  }
  if (!ev) return
  const m = /chatrooms\.(\d+)\.v2/.exec(d.channel || '')
  const slug = m ? _kpSlugForChatroom(Number(m[1])) : null
  if (!slug) return
  if (kind === 'delete') {
    const targetMsgId = ev.message?.id || ev.id || ''
    if (!targetMsgId) return
    broadcastToTabs({ type: 'kick_moderation', action: 'delete', channel: slug, targetMsgId: String(targetMsgId) })
  } else if (kind === 'ban') {
    const targetUser = ev.user?.username || ''
    if (!targetUser) return
    // expires_at present ⇒ it was a TIMEOUT. Permanence is the ABSENCE of an
    // expiry, never "the expiry already passed" — the old `expMs > Date.now()`
    // reclassified every short timeout as a permanent ban, because a 1s timeout
    // has always elapsed by the time we process the event (and every replayed
    // one has elapsed by definition). That printed "was permanently banned"
    // about a person who was muted for one second.
    const expMs = ev.expires_at ? Date.parse(ev.expires_at) : 0
    const isTimeout = !!expMs
    // Remaining time can be <=0 for an already-elapsed timeout; report at least
    // 1s rather than a nonsense negative duration.
    const remainingSec = Math.max(1, Math.round((expMs - Date.now()) / 1000))
    broadcastToTabs({
      type: 'kick_moderation',
      action: isTimeout ? 'timeout' : 'ban',
      channel: slug,
      targetUser,
      targetUserId: ev.user?.id != null ? String(ev.user.id) : '',
      banDuration: isTimeout ? remainingSec : 0,
    })
  } else if (kind === 'unban') {
    const targetUser = ev.user?.username || ''
    if (!targetUser) return
    broadcastToTabs({ type: 'kick_moderation', action: 'unban', channel: slug, targetUser })
  }
}
// Kick's chatroom channel carries the celebration events too — subs and
// gift subs. The server webhook relay already renders both, but a webhook only
// fires for channels whose broadcaster authorised the heatsync kick app, which
// is a handful; the tap sees them for EVERY joined channel. Broadcast shapes
// match the relay's exactly (server kick-stream-webhooks handleSubscription*)
// so the overlay has one render path, and irc.js dedups source-blind when a
// channel happens to have both transports.
const _kpEventStats = { subs: 0, gifts: 0, pins: 0, kicks: 0, raids: 0, polls: 0, dropped: 0 }
function _kpEventParse(d) {
  try {
    return typeof d.data === 'string' ? JSON.parse(d.data) : d.data
  } catch {
    return null
  }
}
// Accepts the v1 chatroom channel as well as v2 — we only subscribe to v2
// today, but kick has moved events between the two before and a frame that
// arrives on v1 should resolve rather than land in the unmatched bucket.
function _kpEventSlug(d) {
  const m = /chatrooms\.(\d+)(?:\.v2)?$/.exec(d.channel || '')
  return m ? _kpSlugForChatroom(Number(m[1])) : null
}

function _kpHandleSubEvent(d) {
  const ev = _kpEventParse(d)
  const slug = ev && _kpEventSlug(d)
  if (!slug) return
  const username = ev.username || ev.user?.username || ''
  if (!username) {
    _kpEventStats.dropped++
    return
  }
  const months = Math.max(1, Number(ev.months) || 1)
  const isResub = months > 1
  _kpEventStats.subs++
  broadcastToTabs({
    type: 'kick_sub_event',
    channel: slug,
    eventType: isResub ? 'renewal' : 'new',
    username,
    months,
    message: isResub ? `${username} resubscribed for ${months} months!` : `${username} subscribed!`,
  })
}

function _kpHandleGiftSubEvent(d) {
  const ev = _kpEventParse(d)
  const slug = ev && _kpEventSlug(d)
  if (!slug) return
  const gifter = ev.gifter_username || ev.gifter?.username || 'anonymous'
  const names = ev.gifted_usernames || ev.usernames || ev.giftees
  const giftees = Array.isArray(names)
    ? names.map((g) => (typeof g === 'string' ? g : g?.username)).filter(Boolean)
    : []
  // Count from the giftee list, never from a field we haven't seen — a gift
  // event we can't size is worth dropping (and counting) rather than
  // announcing "gifted 0 subs".
  const count = giftees.length
  if (!count) {
    _kpEventStats.dropped++
    return
  }
  _kpEventStats.gifts++
  broadcastToTabs({
    type: 'kick_sub_event',
    channel: slug,
    eventType: 'gift',
    username: gifter,
    gifter,
    giftees,
    message: `${gifter} gifted ${count} sub${count !== 1 ? 's' : ''}!`,
  })
}

// Pinned messages — twitch's pubsub pin has rendered as a gold notice line
// since the event-coverage pass; kick broadcasts the same thing on the chatroom
// channel and it was going in the bin. Kick wraps native emotes as
// [emote:ID:name]; the systemMsg surface is plain text (emote parsing happens
// in the message-text pipeline), so the token collapses to the emote's name
// rather than shipping the raw literal into a notice line.
function _kpPinPlainText(s) {
  return String(s || '')
    .replace(/\[emote:\d+:([^\]]+)\]/g, '$1')
    .slice(0, 200)
    .trim()
}
function _kpHandlePinEvent(d, pinned) {
  const ev = _kpEventParse(d)
  const slug = ev && _kpEventSlug(d)
  if (!slug) return
  if (!pinned) {
    _kpEventStats.pins++
    broadcastToTabs({ type: 'kick_pin_event', channel: slug, pinned: false })
    return
  }
  const text = _kpPinPlainText(ev.message?.content)
  if (!text) {
    _kpEventStats.dropped++
    return
  }
  _kpEventStats.pins++
  broadcastToTabs({
    type: 'kick_pin_event',
    channel: slug,
    pinned: true,
    sender: ev.message?.sender?.username || '',
    text,
  })
}

// KICKs — kick's paid gift currency, their answer to bits. The overlay has
// rendered these since the server webhook relay shipped, but the webhook only
// fires for channels whose broadcaster authorised the heatsync kick app, and
// the event does not ride the chatroom channel at all, so the tap never saw
// one. Live payload (2026-07-21, channel_<id>):
//   { gift_transaction_id, message, sender:{username,...},
//     gift:{gift_id, name, amount, type, tier, ...}, created_at }
// Broadcast shape matches the relay's exactly (server kick-stream-webhooks
// handleKicksGifted); irc.js dedups source-blind when both transports deliver.
function _kpHandleKicksEvent(d) {
  const ev = _kpEventParse(d)
  if (!ev) return
  const m = /^channel_(\d+)$/.exec(d.channel || '')
  const slug = m ? _kpSlugForChannelId(m[1]) : null
  if (!slug) return
  const amount = Math.max(0, Number(ev.gift?.amount) || 0)
  if (!amount) {
    // A gift we can't price would render as "gifted 0 KICKs" — drop it and
    // count it instead, so a shape change shows up in dbg_kick_tap.
    _kpEventStats.dropped++
    return
  }
  _kpEventStats.kicks++
  broadcastToTabs({
    type: 'kick_kicks_event',
    channel: slug,
    username: ev.sender?.username || 'anonymous',
    amount,
    giftName: ev.gift?.name || '',
    message: typeof ev.message === 'string' ? ev.message : '',
  })
}

// Raids/hosts + polls. Both ride the chatroom channel. They go out as the same
// stream_event the server's stream:* push uses, so the overlay renders them
// with the twitch raid/poll row builders (main.js stream_event listener) and
// its 60s text dedup collapses a channel that also gets them from the server.
// StreamHostEvent: { chatroom_id, optional_message, number_viewers, host_username }
function _kpHandleHostEvent(d) {
  const ev = _kpEventParse(d)
  const slug = ev && _kpEventSlug(d)
  if (!slug) return
  const target = String(ev.host_username || '').slice(0, 40)
  if (!target) {
    _kpEventStats.dropped++
    return
  }
  _kpEventStats.raids++
  // The host event lands in the RECEIVING channel's chatroom: host_username is
  // the raider coming in, not a channel this one raided (that is stream:raid).
  broadcastToTabs({
    type: 'stream_event',
    eventType: 'stream:raid-in',
    platform: 'kick',
    channel: slug,
    from: target,
    viewers: Math.max(0, Number(ev.number_viewers) || 0),
  })
}

// PollUpdateEvent fires on every vote tick, not just at creation. Announce a
// poll once: key on slug+title, remembered for the poll's duration (+ slack).
const _kpPollSeen = new Map()
function _kpHandlePollEvent(d) {
  const ev = _kpEventParse(d)
  const slug = ev && _kpEventSlug(d)
  const title = String(ev?.poll?.title || '')
    .slice(0, 120)
    .trim()
  if (!slug || !title) {
    if (slug) _kpEventStats.dropped++
    return
  }
  const now = Date.now()
  const key = `${slug}|${title}`
  if ((_kpPollSeen.get(key) || 0) > now) return
  const secs = Math.min(3600, Math.max(30, Number(ev.poll.duration) || 0))
  _kpPollSeen.set(key, now + (secs + 30) * 1000)
  if (_kpPollSeen.size > 50) for (const [k, until] of _kpPollSeen) if (until <= now) _kpPollSeen.delete(k)
  _kpEventStats.polls++
  broadcastToTabs({ type: 'stream_event', eventType: 'stream:poll-start', platform: 'kick', channel: slug, title })
}

async function kickTapJoin(slug) {
  if (!KICK_TAP) return
  slug = (slug || '').toLowerCase()
  if (!slug || _kpChannels.has(slug)) return
  // 'login' etc. are REAL kick channels — a ghost join here streams a
  // stranger's chat into the overlay. Last line of defense for callers that
  // bypass the joinedExtraChannels gate.
  if (RESERVED_PATHS.has(slug)) return
  const chatroomId = await _kpResolveChatroomId(slug)
  if (!chatroomId) return // couldn't resolve -> leave this channel to the server relay
  _kpChannels.set(slug, chatroomId)
  // A fresh join is a new reason to try again: re-arm a stood-down tap, and
  // forgive this channel's refused subscribes.
  _kpRearm()
  _kpNet.subFails.delete(_kpRoom(chatroomId))
  // _kpResolveChatroomId stashed the channel id from the same response.
  const channelId = _kpChannelIdCache.get(slug)
  if (channelId != null) {
    _kpSubbedChannelIds.set(slug, channelId)
    _kpNet.subFails.delete(_kpScope(channelId))
  }
  _kpConnect()
  _kpSubscribe(chatroomId)
  _kpSubscribeChannelScoped(channelId)
  // Fire-and-forget real-history backfill — the _kpChannels.has() guard above
  // means this line only runs on a genuinely fresh join, not every reconnect.
  bgKickFetchRecentArchive(slug).catch(() => {})
}
function kickTapLeave(slug) {
  if (!KICK_TAP) return
  slug = (slug || '').toLowerCase()
  const chatroomId = _kpChannels.get(slug)
  if (chatroomId == null) return
  _kpUnsubscribe(chatroomId)
  _kpChannels.delete(slug)
  _kpModes.delete(slug)
  const leftChannelId = _kpSubbedChannelIds.get(slug)
  if (leftChannelId != null) {
    _kpUnsubscribeChannelScoped(leftChannelId)
    _kpSubbedChannelIds.delete(slug)
  }
  if (!_kpChannels.size) {
    // Kill any pending reconnect/recycle too — otherwise it opens a
    // zero-subscription socket after the last channel leaves.
    _kpClearTimers()
    _kpDetach()
  }
}

function bgYtIngest(payload) {
  // payload is the youtube_chat_message we'd broadcast — store it under channelId
  if (!payload?.channelId || payload.channelId === 'global') return
  const channelId = payload.channelId
  if (!BG_YT.channels.has(channelId)) {
    BG_YT.channels.set(channelId, new BGCircularBuffer(BG_YT_PERSIST_MAX))
    if (BG_YT.channels.size > MAX_BG_YT_CHANNELS) {
      const oldest = BG_YT.channels.keys().next().value
      BG_YT.channels.delete(oldest)
      browser.storage.local.remove(`hs_yt_${oldest}`).catch(() => {})
    }
  }
  // Strip transient flags before storing. `id` (innertube) is NOT transient —
  // it's the only cross-source-stable identity a yt message has. Without it a
  // replayed buffer row can't be id-deduped by the surface, and the content
  // fallback misses because the surface pacer rewrites live msg times.
  const msg = {
    id: payload.id || undefined,
    user: payload.user,
    text: payload.text,
    color: payload.color,
    time: payload.time,
    platform: 'youtube',
    emotes: payload.emotes,
    msgType: payload.msgType,
    amount: payload.amount,
    scColor: payload.scColor,
    sticker: payload.sticker,
    avatar: payload.avatar,
    badges: payload.badges,
    systemMsg: payload.systemMsg,
  }
  BG_YT.channels.get(channelId).push(msg)
  bgYtPersistChannel(channelId)
}
