// HeatSync-native name paints — batch fetch + single injected stylesheet.
//
// Mirrors the site's client/chat/paint-cosmetics.js pipeline, adapted for the
// multichat overlay's IIFE/global-scope bundling (no ES module imports at
// runtime — see build.js's readMultichatModules, which embeds lib/paint-spec.js
// right before this file so compilePaintCss/hashPaintSpec/paintNeedsSpans
// are already free variables in this scope by the time these functions run).
//
// ID-SPACE SAFETY (read before touching call sites): paints are keyed by
// HEATSYNC-side ids, which live in per-platform NAMESPACES: bare numeric ids
// are twitch-space; kick-origin ids are `kick_<kickid>` (server migration 200,
// 2026-07-05). Kick and Twitch numeric ids COLLIDE (a kick numeric id can
// equal an unrelated twitch numeric id — see heatsync_userid_collision_kick_twitch
// in project memory), so the guard here is structural, not a value check: the
// bare/raw platform-native id must NEVER reach queuePaintLookup — every id it
// receives must already be either a resolved twitch id or a `kick_`/`yt_`-
// prefixed namespaced id. There are exactly three call sites, all correct:
//   1. queueMcCosmeticsLookup (main.js) — the same choke point 7TV cosmetics
//      uses. Twitch chatters reach it with their native twitch id (that IS
//      twitch-id-space). Kick chatters reach it only with a RESOLVED twitch
//      id (see flushYtNameLookups in cosmetics.js, which sets m.userId to
//      the linked twitch id returned by the 7TV youtube lookup) — never a
//      bare kick/yt id.
//   2. flushKickNameLookups (cosmetics.js) — mints `kick_` + the numeric kick
//      id returned by BG's get_kick_user_cosmetics and calls queuePaintLookup
//      directly with that namespaced string, bypassing queueMcCosmeticsLookup
//      entirely (that function is twitch-space only; sending it a `kick_` id
//      would misroute it into the 7TV/twitch cosmetics pipeline). The bare
//      numeric kick id from that response is used ONLY to build the
//      namespaced string — it never reaches queuePaintLookup on its own.
//   3. social.js's youtube_chat_message handler — mints `yt_` + the author's
//      UC… channel id directly off the incoming message (msg.authorChannelId)
//      and calls queuePaintLookup with that namespaced string as soon as the
//      message arrives, before any twitch-link resolution. This is why
//      flushYtNameLookups' own 7TV-cosmetics fallback (cosmetics.js) reuses
//      the exact same `yt_<UCid>` string as its mcUserCosmetics key instead
//      of minting a second namespace for the same identity.
// Do not add a fourth call site, and never widen any of the three above to
// accept an unnamespaced platform-native id.
//
// Pipeline:
//   1. queuePaintLookup(uid) batches ids (debounced, <=50/batch) and asks the
//      BG service worker (fetch_paints) — content scripts never fetch
//      heatsync.org directly (Cloudflare edge 503s those; see fetch_recent_messages
//      in chrome/background.js for the exact reasoning).
//   2. compilePaintCss() once per distinct spec hash, appended to a single
//      <style id="hs-mc-paints"> sheet (never re-injected for a hash already
//      present — many users can and will share identical specs).
//   3. hsPaintRender(uid, rawText) is the single render-time helper every
//      username surface uses: returns null when no HS paint is cached (caller
//      keeps its existing 7TV/plain-color rendering), or { cls, html, splitAttr }
//      when one is — callers add `cls` to the element's class list and skip
//      any competing inline color/7TV-paint style (heatsync paint wins).

const HS_PAINT_CACHE_MAX = 500
const HS_PAINT_BATCH_SIZE = 50
const HS_PAINT_BATCH_DELAY = 100
// Mirrors MC_COSMETICS_PENDING_MAX (main.js) — a very busy/firehose channel
// can queue unique uids faster than the batch drain rate; cap so the pending
// Set can't grow unbounded between flushes.
const HS_PAINT_PENDING_MAX = 3000
// Backlog pacing. A firehose channel queues hundreds of distinct chatters, and
// a 500ms gap between batches left the tail of the queue waiting ~10s — names
// sat on their djb2 placeholder colour and paints "took forever to load". The
// API caches each uid 60s server-side, so 50 uids per 120ms is cheap and
// drains the same backlog ~3x faster.
const HS_PAINT_BACKLOG_DELAY = 120

const hsPaintCache = new Map() // uid -> { spec: object|null, hash: string|null }
const hsPaintInjectedHashes = new Set()
const hsPaintPending = new Set()
// Priority lane — the viewer's OWN identities (primeSelfHsCosmetics). Drained
// before hsPaintPending and exempt from HS_PAINT_PENDING_MAX: plain FIFO left
// your own name unpainted behind every stranger in the channel, and once the
// pending cap was hit your uid was dropped outright.
const hsPaintPriority = new Set()
let hsPaintBatchTimer = null
let hsPaintSheetEl = null

// ── plus tenure ("+5mo" / "+3y" beside an active Plus member's name) ───────
// Rides the same /api/paints batch (server now returns a `plus` map of
// per-id ISO plus_since). Identity signal, not a cosmetic — resolves
// regardless of the showNamePaints setting, mirrors queueNameColorLookup's
// un-gated queueing below. See lib/plus-tenure.js for the token itself.
const hsPlusCache = new Map() // uid -> ISO plus_since string | null (cached-negative)

// ── picked name colour (users.color) ────────────────────────────────────────
// Rides the same /api/paints batch (server now returns a `colors` map). Applied
// to youtube + kick names ONLY — never twitch, whose custom name colour is the
// prime/turbo paid perk (overriding it would free-trump twitch's model, same
// reasoning as not free-trumping 7TV's paid paints). A resolved HS paint still
// wins over any colour. Youtube (no native colour) also gets a deterministic
// djb2 palette colour at render time so its names aren't monochrome red.
const hsColorCache = new Map() // uid (yt_<UCid> / kick_<id>) -> "#RRGGBB" | null

// djb2 → palette. MUST stay byte-identical to the website
// (client/utils/color-utils.js usernameColor + server chat-log-permalinks.ts)
// so a chatter is the same colour in the extension, on heatsync.org, and on
// SSR /logs pages.
const HS_USERNAME_PALETTE = [
  '#ff7a7a',
  '#ff9d4d',
  '#ffd24d',
  '#b3e833',
  '#5fd75f',
  '#33d9b2',
  '#5fbfd7',
  '#69a8ff',
  '#a675ff',
  '#d76bcb',
  '#ff6e9c',
  '#ff8fc0',
  '#e57373',
  '#f0a23a',
  '#7bc46c',
]
function hsUsernameColor(username) {
  let h = 5381
  const s = String(username || '').toLowerCase()
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return HS_USERNAME_PALETTE[Math.abs(h) % HS_USERNAME_PALETTE.length]
}

const HS_HEX_RE = /^#[0-9a-fA-F]{6}$/
function setHsColorEntry(uid, color) {
  if (!hsColorCache.has(uid)) evictOldestPaintEntry(hsColorCache, HS_PAINT_CACHE_MAX)
  // Validate here so every cached colour is a safe #RRGGBB — callers can then
  // apply it to style.color without re-sanitizing (sanitizeColor is scoped to
  // main.js and not reachable from cosmetics.js).
  hsColorCache.set(uid, typeof color === 'string' && HS_HEX_RE.test(color) ? color : null)
}

/** @returns {string|null} the user's picked #hex colour, or null if none / not
 * yet resolved. Callers treat null as "no picked colour". */
function getHsPickedColor(uid) {
  return hsColorCache.get(uid) ?? null
}

function setHsPlusEntry(uid, since) {
  if (!hsPlusCache.has(uid)) evictOldestPaintEntry(hsPlusCache, HS_PAINT_CACHE_MAX)
  hsPlusCache.set(uid, since || null)
}

/** @returns {string|undefined|null} ISO plus_since if `uid` is an active Plus
 * member, null if looked-up-and-not, undefined if not yet looked up. Callers
 * use undefined to decide whether to trigger an async lookup (queuePlusTenureLookup). */
function getHsPlusTenureSince(uid) {
  if (!hsPlusCache.has(uid)) return undefined
  return hsPlusCache.get(uid)
}

// ── pure helpers (unit-testable without DOM/network) ────────────────────────

/**
 * Evict the oldest entry from `map` if it is at/over `max` capacity.
 * Map iteration order is insertion order, so `.keys().next()` is oldest.
 */
function evictOldestPaintEntry(map, max) {
  if (map.size >= max) {
    const oldest = map.keys().next().value
    if (oldest !== undefined) map.delete(oldest)
  }
}

/**
 * Split `queue` (a Set/iterable of ids) into the next batch (<=batchSize,
 * newest-queued first — the user is looking at the bottom of the buffer, so
 * the visible viewport resolves before off-screen/scrolled-away chatters,
 * mirroring flushMcCosmeticsBatch's drain order) and the remainder. Pure —
 * does not mutate the input.
 */
function partitionPaintBatch(queue, batchSize) {
  const all = [...queue]
  return { batch: all.slice(-batchSize), rest: all.slice(0, Math.max(0, all.length - batchSize)) }
}

/** Per-letter span data for a username: `{ mid, letters: [{ch, i}] }`. Matches
 * the site's splitter exactly — mid = (length-1)/2, i = index. */
function computeHsLetterSpans(text) {
  const chars = [...String(text ?? '')]
  return {
    mid: (chars.length - 1) / 2,
    letters: chars.map((ch, i) => ({ ch, i })),
  }
}

/** Build the innerHTML for a letter-split username: one <span> per glyph with
 * --i/--mid custom properties. Takes raw (unescaped) text — each glyph is
 * escaped individually, so this is safe to call on el.textContent directly. */
function splitHsLettersHtml(rawText) {
  const { mid, letters } = computeHsLetterSpans(rawText)
  return letters.map(({ ch, i }) => `<span style="--i:${i};--mid:${mid}">${escapeHtml(ch)}</span>`).join('')
}

/**
 * Local mirror of lib/paint-spec.js's paintNameHtml — the ext bundle
 * concatenates modules and escapes through its own escapeHtml, so the markup
 * DECISION is shared (paintMarkupMode) while the string building stays local.
 *
 * Three shapes: one span per glyph for per-letter motion, ONE span around the
 * whole name for a scene (the fill has to paint above the plate pseudo, and
 * that is all it needs — reusing the per-letter split for this gave every
 * letter a private copy of the gradient), and plain escaped text otherwise.
 */
function hsPaintNameHtml(rawText, spec) {
  const mode = paintMarkupMode(spec)
  if (mode === 'letters') return splitHsLettersHtml(rawText)
  if (mode === 'wrap') return `<span>${escapeHtml(rawText)}</span>`
  return escapeHtml(rawText)
}

// ── settings gate (guarded — this module is imported standalone in tests) ───

function hsPaintsEnabled() {
  if (typeof getSetting !== 'function') return true
  return getSetting('showNamePaints') !== false
}

// ── stylesheet management ────────────────────────────────────────────────────

function ensureHsPaintSheet() {
  if (hsPaintSheetEl?.isConnected) return hsPaintSheetEl
  hsPaintSheetEl = document.getElementById('hs-mc-paints')
  if (!hsPaintSheetEl) {
    hsPaintSheetEl = document.createElement('style')
    hsPaintSheetEl.id = 'hs-mc-paints'
    // Single kill-switch: every hsp_* animation pauses when the user turns
    // paint motion off, regardless of how many per-hash rules get appended.
    //
    // Gated on the animatePaints SETTING, not prefers-reduced-motion — the same
    // call already made for emote modifiers (see 10-emotes.css). A paint is
    // content its owner chose and paid for, and the media query is a browser
    // flag, not a per-site preference: a chromium run with
    // --force-prefers-reduced-motion made this rule permanently true, so EVERY
    // paint on the page froze at frame 0 forever with no setting that could
    // turn it back on. Measured on a live channel: 50 animated layers, all 50
    // paused. That also parked each paint's top scene layer (::after,
    // z-index:1) as a static sprite sitting ON the glyphs, which is what read
    // as "the username is blurry / not bitmap" — the layer is meant to sweep
    // past, not sit there.
    //
    // animation-delay:0s too: paints are paused-not-removed, and the phase-lock
    // delay (--hsp-t fold, see lib/paint-spec.js syncDelayCalc) would otherwise
    // freeze each copy at a different mid-cycle pose — zeroing it pins every
    // paused paint at frame 0.
    hsPaintSheetEl.textContent =
      'html[data-hs-paint-anim="never"] [class*="hsp-"],html[data-hs-paint-anim="never"] [class*="hsp-"] *,html[data-hs-paint-anim="never"] [class*="hsp-"]::before,html[data-hs-paint-anim="never"] [class*="hsp-"]::after{animation-play-state:paused !important;animation-delay:0s !important;}' +
      // Hover freeze: pause the paint animation and swap to a plain white/black
      // chip so the name stays fully readable while the pointer is over it.
      // background-clip goes back to border-box (was `text`, see compilePaintCss)
      // so `color` renders as normal solid fill instead of clipping to nothing.
      // Transform-driven effects (letter wave/tumble on spans, coin/heli/swing
      // on the element itself — see lib/paint-spec.js) would freeze mid-rotation
      // (edge-on at rotateX/Y 90deg = invisible), so `transform:none !important`
      // — which beats animation-applied values in the cascade — snaps both the
      // element and its spans flat.
      // .hsp-hover is the JS-synced twin of :hover — installHsPaintHoverSync
      // puts it on EVERY visible copy of the hovered user's name so they all
      // freeze together, not just the pointer target.
      // .hs-mc-row-selected (bulk-select, mod-toolbar.js) reuses the same
      // flatten: a gradient/clip-text paint left un-flattened would render
      // invisible against the selected row's white bg (background:#fff would
      // clip straight through transparent gradient text).
      '[class*="hsp-"]:hover,[class*="hsp-"]:hover span,[class*="hsp-"].hsp-hover,[class*="hsp-"].hsp-hover span,.hs-mc-row-selected [class*="hsp-"],.hs-mc-row-selected [class*="hsp-"] span{animation-play-state:paused !important;background:#fff !important;-webkit-background-clip:border-box !important;background-clip:border-box !important;color:#000 !important;transform:none !important;text-shadow:none !important;}' +
      // Scene plates (v2 ::before/::after dioramas) must vanish entirely on
      // hover/selection — the element's white background paints UNDER a
      // negative-z pseudo, so pausing alone would leave the plate covering
      // the white. text-shadow:none above also drops the scene rim (black
      // smears on white). Same trigger set as the flatten rule.
      '[class*="hsp-"]:hover::before,[class*="hsp-"]:hover::after,[class*="hsp-"].hsp-hover::before,[class*="hsp-"].hsp-hover::after,.hs-mc-row-selected [class*="hsp-"]::before,.hs-mc-row-selected [class*="hsp-"]::after{content:none !important;}' +
      // Off-screen paints stop animating. Measured on the site with the same
      // compiler (scripts/paint-perf.mjs there): the cost of a scene is purely
      // how MANY names animate at once — a full pane of STATIC scene holds
      // 60fps, 250 animating ones is ~20. Multichat is the densest surface
      // there is, two or three panes of 100 rows side by side, so it needs the
      // gate more than the site does.
      //
      // `hs-mc-idle`, deliberately outside the `hsp-` namespace: getHsPaintClass
      // identifies a paint by that prefix, so a marker inside it would make an
      // unpainted name read as painted.
      '.hs-mc-idle,.hs-mc-idle *,.hs-mc-idle::before,.hs-mc-idle::after{animation-play-state:paused !important;}'
    const tracked =
      typeof cleanup !== 'undefined' && cleanup.trackNode ? cleanup.trackNode(hsPaintSheetEl) : hsPaintSheetEl
    document.head.appendChild(tracked)
    installHsPaintHoverSync()
  }
  return hsPaintSheetEl
}

// ── hover-freeze sync ────────────────────────────────────────────────────────
// Hovering a painted name freezes EVERY visible copy of that user's name (the
// CSS :hover rule above only reaches the pointer target). Matches by
// data-username when present (.hs-mc-user rows), falling back to text content
// so mention chips without the attribute sync too. Installed once, alongside
// the sheet.
let _hsPaintHoverInstalled = false
let _hsPaintHoverEls = null
let _hsPaintHoverTarget = null

function _hsPaintHoverKey(el) {
  const raw = el.dataset?.username || el.textContent || ''
  return raw.trim().toLowerCase().replace(/^@/, '')
}

// cleanup-tracked listener when the helper is available (live multichat),
// plain listener otherwise (test harness stubs cleanup with trackNode only).
function _hsPaintHoverOn(target, type, fn, opts) {
  if (typeof cleanup !== 'undefined' && typeof cleanup.addEventListener === 'function') {
    cleanup.addEventListener(target, type, fn, opts)
  } else {
    target.addEventListener(type, fn, opts)
  }
}

function installHsPaintHoverSync() {
  if (_hsPaintHoverInstalled) return
  // test harness stubs `document` as a bare object — nothing to install on
  if (typeof document.addEventListener !== 'function' || typeof document.querySelectorAll !== 'function') return
  _hsPaintHoverInstalled = true
  const clear = () => {
    if (!_hsPaintHoverEls) return
    for (const el of _hsPaintHoverEls) el.classList.remove('hsp-hover')
    _hsPaintHoverEls = null
  }
  const clearAll = () => {
    _hsPaintHoverTarget = null
    clear()
  }
  _hsPaintHoverOn(
    document,
    'mouseover',
    (e) => {
      const t = e.target instanceof Element ? e.target.closest('[class*="hsp-"]') : null
      if (!t) return
      // letter-split names refire mouseover per span — same outer element,
      // no work to do (the full-document scan below is the expensive part)
      if (t === _hsPaintHoverTarget) return
      _hsPaintHoverTarget = t
      clear()
      const key = _hsPaintHoverKey(t)
      if (!key) return
      const hit = []
      for (const el of document.querySelectorAll('[class*="hsp-"]')) {
        if (el !== t && _hsPaintHoverKey(el) === key) {
          el.classList.add('hsp-hover')
          hit.push(el)
        }
      }
      if (hit.length) _hsPaintHoverEls = hit
    },
    { passive: true },
  )
  _hsPaintHoverOn(
    document,
    'mouseout',
    (e) => {
      if (!_hsPaintHoverEls) return
      const t = e.target instanceof Element ? e.target.closest('[class*="hsp-"]') : null
      if (!t) return
      // still inside the same painted element (moving across its letter
      // spans) — keep the sync alive
      if (e.relatedTarget instanceof Element && e.relatedTarget.closest('[class*="hsp-"]') === t) return
      clearAll()
    },
    { passive: true },
  )
}

/** Compile + append the CSS for `hash` if not already present. Idempotent. */
function ensureHsPaintRule(spec, hash) {
  if (hsPaintInjectedHashes.has(hash)) return
  const sheet = ensureHsPaintSheet()
  const css = compilePaintCss(spec, `.hsp-${hash}`, { hash })
  if (!css) return
  sheet.textContent += css
  hsPaintInjectedHashes.add(hash)
}

/** Toggle-off hygiene: drop the injected sheet + hash tracking so a later
 * toggle-on recompiles clean rather than leaving stale/duplicate CSS. Cache
 * entries (spec/hash per uid) are kept — no need to re-fetch, only re-inject. */
function clearHsPaintSheet() {
  if (hsPaintSheetEl?.parentNode) hsPaintSheetEl.parentNode.removeChild(hsPaintSheetEl)
  hsPaintSheetEl = null
  hsPaintInjectedHashes.clear()
}

// Toggle-on recovery: rebuild the sheet from every cached spec. clearHsPaintSheet
// dropped the rules but kept the cache (and rows still carry the hsp-<hash> class
// via getHsPaintClass), so without re-injecting, painted names render UNSTYLED
// after off->on until a fresh fetch — which never comes for already-cached uids.
function reinjectHsPaintSheet() {
  for (const entry of hsPaintCache.values()) {
    if (entry?.spec && entry.hash) ensureHsPaintRule(entry.spec, entry.hash)
  }
}

// ── public cache API ─────────────────────────────────────────────────────────

/** @returns {string} the `hsp-<hash>` class to add to the element, or '' if none. */
function getHsPaintClass(userId) {
  if (!hsPaintsEnabled()) return ''
  const entry = hsPaintCache.get(userId)
  if (!entry?.hash) return ''
  return `hsp-${entry.hash}`
}

/** @returns {object|null} the raw validated spec (for paintNeedsSpans checks). */
function getHsPaintSpec(userId) {
  if (!hsPaintsEnabled()) return null
  return hsPaintCache.get(userId)?.spec ?? null
}

/** True if `userId` has a resolved (non-null) HeatSync paint right now. Used
 * by the 7TV cosmetics path to yield precedence — a HeatSync paint is the
 * user's own choice on our platform and always wins over their 7TV paint. */
function hasResolvedHsPaint(userId) {
  return !!getHsPaintSpec(userId)
}

function setHsPaintEntry(userId, spec) {
  if (!spec) {
    if (!hsPaintCache.has(userId)) evictOldestPaintEntry(hsPaintCache, HS_PAINT_CACHE_MAX)
    hsPaintCache.set(userId, { spec: null, hash: null })
    return
  }
  const hash = hashPaintSpec(spec)
  ensureHsPaintRule(spec, hash)
  if (!hsPaintCache.has(userId)) evictOldestPaintEntry(hsPaintCache, HS_PAINT_CACHE_MAX)
  hsPaintCache.set(userId, { spec, hash })
}

/**
 * Queue a resolved-twitch-space uid for a paint lookup. Debounced + batched.
 * See the ID-SPACE SAFETY note at the top of this file — never call this with
 * a raw kick/YouTube id.
 */
function queuePaintLookup(userId) {
  if (!userId) return
  if (hsPaintCache.has(userId)) return
  if (!hsPaintsEnabled()) return
  if (hsPaintPending.size >= HS_PAINT_PENDING_MAX) return
  hsPaintPending.add(userId)
  if (!hsPaintBatchTimer) hsPaintBatchTimer = cleanup.setTimeout(flushHsPaintBatch, HS_PAINT_BATCH_DELAY)
}

/**
 * Queue a youtube/kick uid for its PICKED name colour. Un-gated by the paint
 * setting — a picked colour is a base colour, not a cosmetic paint, so it must
 * resolve even with name-paints off. Rides the same batch/flush as paints
 * (colours piggyback on the /api/paints response). Deduped via hsColorCache.
 */
function queueNameColorLookup(uid) {
  if (!uid) return
  if (hsColorCache.has(uid)) return
  if (hsPaintPending.size >= HS_PAINT_PENDING_MAX) return
  hsPaintPending.add(uid)
  if (!hsPaintBatchTimer) hsPaintBatchTimer = cleanup.setTimeout(flushHsPaintBatch, HS_PAINT_BATCH_DELAY)
}

/**
 * Queue a uid for a PLUS TENURE lookup. Un-gated by the name-paint setting —
 * tenure is a membership badge, not a cosmetic, so it must resolve even with
 * paints off (mirrors queueNameColorLookup). Rides the same batch/flush as
 * paints + picked colour (all three ride the same /api/paints response).
 */
function queuePlusTenureLookup(uid) {
  if (!uid) return
  if (hsPlusCache.has(uid)) return
  if (hsPaintPending.size >= HS_PAINT_PENDING_MAX) return
  hsPaintPending.add(uid)
  if (!hsPaintBatchTimer) hsPaintBatchTimer = cleanup.setTimeout(flushHsPaintBatch, HS_PAINT_BATCH_DELAY)
}

/**
 * Prime the VIEWER'S OWN cosmetics as soon as the heatsync identity is known,
 * before the channel's backlog floods the queue. Seeds the picked colour from
 * the stored user_info (so your own name never renders the placeholder colour
 * and then flips), and puts every id you can speak as into the priority lane.
 * @param {object} ui  storage user_info (background fetchUserInfo)
 */
function primeSelfHsCosmetics(ui) {
  if (!ui) return
  const ids = new Set()
  if (ui.id) ids.add(String(ui.id))
  if (ui.twitch_id) ids.add(String(ui.twitch_id))
  if (ui.kick_id) ids.add(`kick_${ui.kick_id}`)
  if (ui.youtube_channel_id) ids.add(`yt_${ui.youtube_channel_id}`)
  for (const id of ids) {
    // Server truth overwrites on flush; this only covers the pre-flush window.
    if (!hsColorCache.has(id)) setHsColorEntry(id, ui.color || null)
    if (hsPaintCache.has(id)) continue
    hsPaintPending.delete(id)
    hsPaintPriority.add(id)
  }
  if (hsPaintPriority.size && !hsPaintBatchTimer) {
    hsPaintBatchTimer = cleanup.setTimeout(flushHsPaintBatch, HS_PAINT_BATCH_DELAY)
  }
}

async function flushHsPaintBatch() {
  hsPaintBatchTimer = null
  if (!hsPaintPending.size && !hsPaintPriority.size) return
  // Own identities drain first — see hsPaintPriority.
  const { batch, rest } = partitionPaintBatch([...hsPaintPriority, ...hsPaintPending], HS_PAINT_BATCH_SIZE)
  hsPaintPriority.clear()
  hsPaintPending.clear()
  for (const id of rest) hsPaintPending.add(id)

  let paints = null
  let colors = null
  let plus = null
  try {
    const resp = await safeSendMessage({ type: 'fetch_paints', userIds: batch })
    if (resp?.paints && typeof resp.paints === 'object') paints = resp.paints
    if (resp?.colors && typeof resp.colors === 'object') colors = resp.colors
    if (resp?.plus && typeof resp.plus === 'object') plus = resp.plus
  } catch (_) {
    paints = null
  }

  // Picked name colours ride the same response. Cache + apply independently of
  // the paint path (colour resolves even with paints off). Only the confirmed
  // batch is cached here; ids absent from `colors` simply have no picked colour.
  if (colors) {
    const colorChanged = []
    for (const id of batch) {
      if (!hsColorCache.has(id)) {
        setHsColorEntry(id, colors[id] || null)
        if (colors[id]) colorChanged.push(id)
      }
    }
    if (colorChanged.length && typeof updateHsColorsInPlace === 'function') updateHsColorsInPlace(colorChanged)
  }

  // Plus tenure rides the same response too — identity signal, cached +
  // applied independently of the paint/colour outcome. Only the confirmed
  // batch is cached; ids absent from `plus` simply aren't active Plus members.
  if (plus) {
    const plusChanged = []
    for (const id of batch) {
      if (!hsPlusCache.has(id)) {
        setHsPlusEntry(id, plus[id] || null)
        if (plus[id]) plusChanged.push(id)
      }
    }
    if (plusChanged.length && typeof applyHsPlusTenureToVisible === 'function') applyHsPlusTenureToVisible(plusChanged)
  }

  if (paints) {
    // BG only includes a key for ids it has a CONFIRMED answer for (positive
    // spec, or a confirmed negative) — see the fetch_paints handler in
    // chrome/background.js. An id absent from `paints` means BG couldn't
    // resolve it this round (transient failure); requeue it instead of
    // caching a false negative that would mask a real paint until reload.
    const changed = []
    for (const id of batch) {
      if (Object.hasOwn(paints, id)) {
        setHsPaintEntry(id, paints[id])
        if (paints[id]) changed.push(id)
      } else {
        hsPaintPending.add(id)
      }
    }
    if (changed.length && typeof updateHsPaintsInPlace === 'function') updateHsPaintsInPlace(changed)
  } else {
    // BG unreachable entirely — put the whole batch back so the next flush
    // retries instead of silently caching everyone in it as "no paint".
    for (const id of batch) hsPaintPending.add(id)
  }

  if ((hsPaintPending.size > 0 || hsPaintPriority.size > 0) && !hsPaintBatchTimer) {
    hsPaintBatchTimer = cleanup.setTimeout(flushHsPaintBatch, HS_PAINT_BACKLOG_DELAY)
  }
}

/**
 * Single render-time helper every username surface (sender row, inline
 * @mention, reply-context bar) calls. Returns null when no HeatSync paint is
 * cached for `userId` — the caller falls back to its existing 7TV/plain-color
 * rendering unchanged. Returns `{ cls, html, splitAttr }` when one is active:
 * `cls` goes on the element's class list, `html` replaces the escaped-name
 * text (already in whatever span shape the spec needs, escaped), `splitAttr`
 * is a ready-to-splice ` data-hs-paint-split="1"` marker so a later in-place
 * repaint (updateHsPaintsInPlace) doesn't re-split already-split text.
 */
function hsPaintRender(userId, rawText) {
  if (!userId) return null
  const cls = getHsPaintClass(userId)
  if (!cls) return null
  const spec = getHsPaintSpec(userId)
  return {
    cls,
    html: hsPaintNameHtml(rawText, spec),
    splitAttr: paintNeedsSpans(spec) ? ' data-hs-paint-split="1"' : '',
  }
}

/** In-place DOM application shared by updateHsPaintsInPlace (main.js) — adds
 * the hsp-<hash> class (dropping any stale one), clears the element's inline
 * style attribute (precedence: a HeatSync paint always wins over whatever
 * 7TV inline style/plain color a prior render or cosmetics batch set — an
 * inline style has higher specificity than any class rule, so it MUST be
 * cleared or the class-based paint would silently lose), and letter-splits
 * the text once if the spec needs it and it hasn't been split yet. */
function applyHsPaintToElement(el, userId) {
  if (!el) return
  const cls = getHsPaintClass(userId)
  const spec = getHsPaintSpec(userId)
  if (!cls || !spec) return
  if (!el.classList.contains(cls)) {
    for (const c of [...el.classList]) {
      if (c.startsWith('hsp-')) el.classList.remove(c)
    }
    el.classList.add(cls)
    // A different spec can want a different markup SHAPE. The split marker
    // records "already shaped", so keeping it across a spec change froze the
    // name in the previous spec's markup.
    delete el.dataset.hsPaintSplit
  }
  // Preserve any already-stamped mount time across the style-attribute clear
  // below — a second resolution of the same uid on an already-painted element
  // (e.g. a background cache refresh re-running this) must not re-phase an
  // already-mounted copy out of sync with its siblings (lib/paint-spec.js
  // syncDelayCalc folds --hsp-t onto every compiled animation's cycle).
  const existingPhase = el.style ? el.style.getPropertyValue('--hsp-t') : ''
  if (el.hasAttribute('style')) el.removeAttribute('style')
  // Belt-and-suspenders against any future race that hands us an element
  // whose text was already cleared/moved by something else (e.g. a nested-
  // anchor DOM-correction, a mid-flight rebuild): splitting '' is a silent
  // no-op that would still mark the node as "split" and leave it permanently
  // blank. Never touch innerHTML when there's no text to split.
  if (paintNeedsSpans(spec) && !el.dataset.hsPaintSplit && el.textContent) {
    el.innerHTML = hsPaintNameHtml(el.textContent, spec)
    el.dataset.hsPaintSplit = '1'
  }
  // Mount stamp for phase-locking — restore the preserved value, or stamp a
  // fresh one for an element that never had one (in-place resolve, hover-
  // freeze repaint, restored history; a synchronous render-path element
  // already carries one from buildMessageDiv/mention/reply-bar, so this is
  // idempotent for it too).
  if (el.style) {
    el.style.setProperty('--hsp-t', existingPhase || paintPhaseNow())
  }
  // Freshly painted, so gate it now instead of waiting for the next scroll.
  scheduleHsPaintSweep()
}

// ── viewport gate ───────────────────────────────────────────────────────────

/** Targets handed to the observer, so a sweep can skip them and drop the
 * detached ones — an IntersectionObserver holds its targets strongly and a
 * multichat pane trims to 100 rows continuously. */
const hsObservedNames = new Set()
let hsVisibilityObserver = null
let hsSweepScheduled = false

function ensureHsVisibilityObserver() {
  if (hsVisibilityObserver || typeof IntersectionObserver !== 'function') return hsVisibilityObserver
  // No root: the gate should hold for whichever pane is scrolling without this
  // module knowing which container a name lives in. The margin keeps a screen
  // of rows warm either side so a scroll never uncovers a frozen name.
  hsVisibilityObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) entry.target.classList.toggle('hs-mc-idle', !entry.isIntersecting)
    },
    { rootMargin: '150% 0px' },
  )
  return hsVisibilityObserver
}

/**
 * Put every painted name currently in the overlay under the viewport gate.
 *
 * A sweep rather than a hook on each render path: rows are built as HTML
 * strings with the paint class already in them (hsPaintRender), so a hook
 * would have to be added at every construction site and would still miss the
 * next one. An element the sweep has not reached simply animates — the
 * behaviour that shipped before this — so missing one degrades to the status
 * quo and can never break a paint.
 */
function sweepHsPaintedNames() {
  const io = ensureHsVisibilityObserver()
  if (!io) return
  for (const el of hsObservedNames) {
    if (!el.isConnected) {
      io.unobserve(el)
      hsObservedNames.delete(el)
    }
  }
  for (const el of document.querySelectorAll('[class*="hsp-"]')) {
    if (hsObservedNames.has(el)) continue
    hsObservedNames.add(el)
    io.observe(el)
  }
}

/** One sweep per frame — scrolling fires continuously and the observer does
 * the real visibility work asynchronously anyway. */
function scheduleHsPaintSweep() {
  if (hsSweepScheduled || typeof requestAnimationFrame !== 'function') return
  hsSweepScheduled = true
  requestAnimationFrame(() => {
    hsSweepScheduled = false
    sweepHsPaintedNames()
  })
}

// Scroll is when visibility changes, and also when a pane autoscrolls a new
// message in. Capture so it hears every pane, passive so it never delays one.
if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('scroll', scheduleHsPaintSweep, { capture: true, passive: true })
}

export {
  applyHsPaintToElement,
  clearHsPaintSheet,
  computeHsLetterSpans,
  evictOldestPaintEntry,
  getHsPaintClass,
  getHsPaintSpec,
  getHsPickedColor,
  getHsPlusTenureSince,
  hasResolvedHsPaint,
  hsPaintRender,
  hsUsernameColor,
  partitionPaintBatch,
  primeSelfHsCosmetics,
  queueNameColorLookup,
  queuePaintLookup,
  queuePlusTenureLookup,
  reinjectHsPaintSheet,
  scheduleHsPaintSweep,
  setHsColorEntry,
  setHsPaintEntry,
  setHsPlusEntry,
  splitHsLettersHtml,
  sweepHsPaintedNames,
}
