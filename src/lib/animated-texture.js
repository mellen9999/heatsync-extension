/**
 * Animated texture — one decode, one GPU texture, N free copies.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * A browser has two ways to animate, and they cost completely different money:
 *
 *   REPAINT    an animated <img>, a moving background-position, a gradient
 *              under background-clip:text — main-thread raster, every frame,
 *              PER ELEMENT. Twenty copies cost twenty times one copy.
 *   COMPOSITE  `transform` on a promoted layer — a GPU quad blit. Twenty
 *              copies cost about what one costs.
 *
 * Everything cosmetic in this app was on the first path, and every mitigation
 * built on top of it (the viewport gate, the mobile animation budgets, the
 * crowd dial, the steps() rate caps) is a way of doing LESS of something that
 * is inherently too expensive. Measured, 414x896 @ dpr3 / cpu 4x, per 3s
 * (`scripts/paint-perf.mjs --composited`, 2026-09-13):
 *
 *   background-clip:text   283.8ms @ 1 copy   3648.3ms @ 20   11454 paints
 *   sprite + transform       0.4ms @ 1 copy      1.5ms @ 20       1 paint
 *
 * The second row is below the STATIC baseline's own measurement noise.
 *
 * So: decode an animated image ONCE into a grid of cells, then play it by
 * translating that grid under a one-frame window — one steps() per axis. The
 * strip is a static bitmap — a transformed static bitmap cannot repaint,
 * whatever it depicts —
 * and two mounts of the same source share one blob URL, which means one decode
 * and one GPU texture. That sharing IS the "dedupe identical animated emotes"
 * everyone wants, and it is exact rather than approximate.
 *
 * ── WHY NO WORKER ───────────────────────────────────────────────────────────
 *
 * The obvious design puts the decode in a Worker. It is not worth it here:
 * `ImageDecoder` already decodes off the main thread in Chrome, so the only
 * main-thread work is one `drawImage` per frame of a 32-pixel image, and a
 * worker would cost a CSP `worker-src` entry, a bundling entry point and a
 * message protocol to save that. Idle-scheduling the build is enough. If a
 * device trace ever says otherwise, this is the comment that was wrong.
 *
 * @module cosmetics/animated-texture
 */

import { logger } from '../services/logger.js'

/** Cache Storage bucket for built strips.
 *
 *  VERSIONED, and it has to be. This used to read "unversioned on purpose: a
 *  strip is a pure function of its source bytes, so a deploy can invalidate
 *  nothing about it" — true only while the function stays the same. v1 strips
 *  were laid out one cell per source frame and played at a flat rate; every
 *  device that had already built one would have kept the mispacing forever,
 *  because nothing about the source bytes changed. Any future change to the
 *  layout needs the same bump. */
const STORE = 'heatsync-sprites-v3'
const STALE_STORES = ['heatsync-sprites-v1', 'heatsync-sprites-v2']

/** Widest and tallest strip we will build, in CSS pixels of the source image.
 *  A texture past the GPU's limit on EITHER axis is silently not uploaded,
 *  which would present as an invisible emote rather than an error. 4096 is
 *  the floor of what any GL implementation we care about guarantees. */
const MAX_STRIP_PX = 4096

/** Most pixels one strip may hold — 2MB of RGBA once uploaded. This, not a
 *  cell count, is what a strip costs: a 32px emote gets 512 cells, a 4:1 wide
 *  one 128, a 128px asset 32. The cell count follows from the source's size;
 *  it is never a ceiling that wide emotes hit first. */
const MAX_STRIP_AREA = 1 << 19

/** Cell ceiling irrespective of size — past this a tick is finer than any
 *  refresh rate we render at, and a longer source is resampled onto it. */
const MAX_CELLS = 512

/** A source past this many frames is not worth two decode passes on a phone.
 *  It stays a raster <img>, which plays it whole and counts against the
 *  animation budget like any other refusal. */
const MAX_SOURCE_FRAMES = 1000

/** Most built strips held in memory. Each is a live blob: URL — a bitmap the
 *  browser keeps until it is revoked — and a tab open for hours (the extension
 *  runs this file inside twitch.tv) meets far more distinct emotes than that.
 *  Past it the oldest strip nothing is showing is revoked; a mounted one never. */
const READY_MAX = 200

/** Most strips kept in Cache Storage. Nothing else ever removes one, so without
 *  a ceiling the bucket only grows, for as long as the device lives. */
const STORE_MAX = 400

/** In-flight builds, keyed by source URL, so N simultaneous mounts of one
 *  emote do ONE decode. */
const strips = new Map()

/** Built strips, keyed by source URL. Separate from `strips` because the
 *  render path needs a SYNCHRONOUS answer — reconcile() cannot await.
 *  Insertion order is recency order: a read re-inserts (see `touch`). */
const ready = new Map()

/** `ready.get`, and a hit moves to the young end. Two map ops, no scan. */
function touch(url) {
    const strip = ready.get(url)
    if (strip) { ready.delete(url); ready.set(url, strip) }
    return strip
}

/** What mountSprite wrote, read back: `url(x)` as written, `url("x")` as Chrome
 *  serializes it. */
const STYLE_URL = /^url\(\s*(["']?)(.*?)\1\s*\)$/

/** Make room: revoke and forget the oldest strips no element is painting, until
 *  `ready` fits READY_MAX. Mounted ones are skipped, so a page showing more than
 *  that simply holds more — bounded by the screen, not the session. `keep` is the
 *  strip that just landed. */
function trimReady(keep) {
    if (ready.size <= READY_MAX) return
    const live = new Set()
    const runs = document.getElementsByClassName(SPRITE_RUN_CLASS)
    for (let n = 0; n < runs.length; n++) {
        const m = STYLE_URL.exec(runs[n].style?.backgroundImage || '')
        if (m) live.add(m[2])
    }
    for (const [url, strip] of ready) {
        if (ready.size <= READY_MAX) break
        if (url === keep || live.has(strip.src)) continue
        ready.delete(url)
        paintableStrips.delete(strip.src)
        URL.revokeObjectURL(strip.src)
    }
}

/** Hosts whose images send no CORS header, so a cross-origin read of their bytes
 *  is refused by the browser. betterttv's cdn is one: `fetch(url, { mode:
 *  'cors' })` fails there, which used to refuse every bttv animated emote for
 *  good. Their bytes are read through the CORS proxy when one is set. */
const NO_CORS_SOURCES = /^https:\/\/cdn\.betterttv\.net\//

/** Where a NO_CORS_SOURCES url is read from: `${base}?url=<source>`, bytes
 *  unchanged. Null (the default) means there is none, and such a url is refused
 *  as before. Everything stays keyed by the ORIGINAL url — the maps, the
 *  refusals, the cooldowns, the stored copy — so no caller or stored strip
 *  depends on which way the bytes arrived. */
let corsProxy = null

/** Set the proxy base for sources without CORS (`/api/emote-proxy` on the
 *  site, its absolute url from the extension), or null for none. */
export function setCorsProxy(base) { corsProxy = typeof base === 'string' && base ? base : null }

/** Called after a build lands, so elements that asked too early can re-ask. */
let onReady = null

/** Register the callback the owner uses to re-drive elements once a strip
 *  exists. One owner (emote-motion) by design — this module decides nothing
 *  about when an emote may move. */
export function setOnReady(fn) { onReady = fn }

/** Sources that cannot be turned into a strip — wrong type, single frame, too
 *  long, nothing to draw on. Final: remembered so a busy room does not retry per
 *  row. A failure that says nothing about the SOURCE is not in here (see
 *  RetryLater). */
const refused = new Set()

/** A build that failed for a reason that may not hold next time — the network
 *  dropped, the cdn answered 5xx, a decode broke part-way. Every other way a
 *  build ends (a null, any other throw) is about the source itself and final.
 *  Before this, one bad moment refused the url for the whole session. */
class RetryLater extends Error {}

/** `p`, but if it rejects the build is retryable rather than refused. */
function flaky(p, what) {
    return p.catch((err) => { throw new RetryLater(`${what}: ${err?.message || err}`, { cause: err }) })
}

/** Wait after the 1st, then the 2nd failure of a url; a 3rd is final. Spaced so
 *  a cdn blip clears but a dead url costs three asks, not one per row. */
const RETRY_MS = [30_000, 120_000]

/** url → { at: performance.now() it may be asked again, tries: failures so far }.
 *  While `at` is ahead, spriteFor answers null with no fetch. */
const retries = new Map()

/** Note a retryable failure of `url`. True while it will be asked again; false
 *  once it has failed RETRY_MS.length + 1 times, which makes it final. */
function coolDown(url, err) {
    const tries = (retries.get(url)?.tries || 0) + 1
    if (tries > RETRY_MS.length) return false
    retries.set(url, { at: performance.now() + RETRY_MS[tries - 1], tries })
    logger.warn(`[sprite] try ${tries} of ${RETRY_MS.length + 1} failed — asking again in ${RETRY_MS[tries - 1] / 1000}s`, url, err.message)
    return true
}

export function supported() {
    return typeof ImageDecoder === 'function'
        && typeof createImageBitmap === 'function'
        && typeof document !== 'undefined'
}

/** Run `fn` when the main thread is not busy, or soon. */
function whenIdle(fn) {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: 2000 })
    else setTimeout(fn, 0)
}

/**
 * A built strip, or null if this source cannot be one.
 * @param {string} url absolute source URL (what the <img> already loads)
 * @returns {Promise<{src:string,frames:number,w:number,h:number,durationMs:number}|null>}
 */
export function spriteFor(url) {
    if (!url || !supported() || refused.has(url)) return Promise.resolve(null)
    const done = touch(url)
    if (done) return Promise.resolve(done)
    const existing = strips.get(url)
    if (existing) return existing
    const wait = retries.get(url)
    if (wait && performance.now() < wait.at) return Promise.resolve(null)
    let why = null
    const p = build(url).catch((err) => { why = err; return null }).then((strip) => {
        strips.delete(url)
        // Loud, not debug, and on EVERY refusal — not only the ones that threw.
        // A refused url is refused FOREVER, and the only symptom downstream is
        // an emote that animates for a moment and then freezes, which is
        // indistinguishable from the mobile budget doing its job on purpose.
        // That is how `await dec.tracks.ready` being missing hid for as long as
        // it did. The quiet half was decodeToStrip resolving null (single
        // frame, tainted canvas, no decoder) — the same permanent refusal, with
        // nothing said about it at all.
        if (!strip) {
            // A bad moment is not a verdict: cool down and let the next ask retry.
            if (why instanceof RetryLater && coolDown(url, why)) return null
            retries.delete(url)
            refused.add(url)
            logger.warn('[sprite] refusing url — this emote stays raster and counts against the animation budget', url, why || '(no strip produced)')
            return null
        }
        retries.delete(url)
        ready.set(url, strip)
        try { trimReady(url) } catch (err) { logger.debug('[sprite] trim threw', err) }
        // Rows that rendered before this landed are still showing the animated
        // <img>; tell the owner so they can switch over.
        try { onReady?.(url, strip) } catch (err) { logger.debug('[sprite] onReady threw', err) }
        return strip
    })
    strips.set(url, p)
    return p
}

async function build(url) {
    const cached = await readStore(url)
    if (cached) return cached
    return new Promise((resolve, reject) => whenIdle(() => decodeToStrip(url).then(resolve, reject)))
}

async function decodeToStrip(url) {
    // The same bytes the <img> already pulled — after the service worker's
    // image cache learned to match on request.destination, this is usually a
    // cache hit rather than a second network trip.
    let from = url
    if (NO_CORS_SOURCES.test(url)) {
        if (!corsProxy) throw new Error('no CORS header and no proxy set')
        from = `${corsProxy}?url=${encodeURIComponent(url)}`
    }
    const resp = await flaky(fetch(from, { mode: 'cors', credentials: 'omit' }), 'fetch')
    if (!resp.ok) throw new RetryLater(`fetch: http ${resp.status}`)
    const type = (resp.headers.get('content-type') || '').split(';')[0].trim()
    if (!/^image\/(webp|gif|apng|png|avif)$/.test(type)) return null
    const data = await flaky(resp.arrayBuffer(), 'body')

    const dec = new ImageDecoder({ data, type })
    try {
        await dec.completed
        // `completed` answers "have all the BYTES been decoded", not "is the
        // track list populated" — those are two different promises in
        // WebCodecs, and selectedTrack is null until `tracks.ready` settles.
        // Without this await it was null EVERY time, for every emote: the
        // guard below then read that as "nothing to animate", returned null,
        // and spriteFor added the url to `refused` permanently. So no emote
        // ever got a sprite, nothing was ever exempt from the mobile
        // concurrent-animation budget, and every animated emote past the
        // twelfth froze to a static frame a second or two after appearing.
        // Measured on prod 2026-09-16: 7tv `edm` reports 315 frames and `EDM`
        // 40 once this is awaited, and null without it.
        await dec.tracks.ready
        const track = dec.tracks.selectedTrack
        // A single-frame image is already free — it has nothing to animate and
        // wrapping it would only add a layer.
        if (!track || !track.animated || track.frameCount < 2) return null

        if (track.frameCount > MAX_SOURCE_FRAMES) {
            logger.warn(`[sprite] ${track.frameCount} frames is past the ${MAX_SOURCE_FRAMES} we will decode — this emote stays raster`)
            return null
        }

        // PASS 1 — the whole timeline. Every frame carries its own delay and
        // nothing short of decoding it says what that is, and the grid cannot
        // be laid out until the total is known. Frames close as they go, so
        // this holds one frame of memory, never the source.
        let w = 0, h = 0
        const durs = []
        for (let i = 0; i < track.frameCount; i++) {
            const { image } = await flaky(dec.decode({ frameIndex: i }), 'decode')
            if (i === 0) { w = image.displayWidth; h = image.displayHeight }
            durs.push(image.duration || 0)
            image.close()
        }
        if (!w || !h) return null
        // A source that declares no delays at all (some GIFs) gets the 100ms
        // browsers themselves default to, evenly.
        if (!durs.some(Boolean)) durs.fill(100_000)

        // ⚠ A LONGER SOURCE IS RESAMPLED, NEVER TRUNCATED. v2 decoded a prefix
        // and looped there — `frames = min(frameCount, 120, floor(4096 / w))`
        // on a one-row strip — so a 4:1 wide emote at 1x (w=128) got 32 cells
        // and any wide emote past 32 frames played its first half, while the
        // <img> it replaced, and every viewer whose device refused a strip,
        // played the whole thing. Two people in one room saw different
        // animations for the same emote. Now the cell count is bounded by
        // pixels and the grid, and a source with more frames than cells is
        // laid out on a coarser tick over its FULL length: every frame, at a
        // lower rate, looping where the source loops.
        const maxCols = Math.floor(MAX_STRIP_PX / w)
        const maxRows = Math.floor(MAX_STRIP_PX / h)
        const maxCells = Math.min(MAX_CELLS, maxCols * maxRows, Math.floor(MAX_STRIP_AREA / (w * h)))
        if (maxCells < 2) return null
        const grid = layout(pace(durs, maxCells), durs, maxCols, maxRows, maxCells)
        if (durs.length > grid.ticks) {
            logger.debug(`[sprite] ${durs.length} frames on ${grid.ticks} cells (${w}x${h}) — whole source, coarser tick`)
        }

        const canvas = makeCanvas(w * grid.cols, h * grid.rows)
        const ctx = canvas.getContext('2d', { alpha: true })
        if (!ctx) return null

        // PASS 2 — only the frames a cell shows, each decoded once and drawn
        // into every cell that holds it. No scratch strip, no second blit.
        // Cells are walked in order, so sources come out ascending and the
        // decoder never has to seek backwards.
        const cellsOf = new Map()
        for (let c = 0; c < grid.ticks; c++) {
            const src = grid.map ? grid.map[c] : c
            const list = cellsOf.get(src)
            if (list) list.push(c); else cellsOf.set(src, [c])
        }
        for (const [src, cells] of cellsOf) {
            const { image } = await flaky(dec.decode({ frameIndex: src }), 'decode')
            for (const c of cells) ctx.drawImage(image, (c % grid.cols) * w, Math.floor(c / grid.cols) * h, w, h)
            image.close()
        }

        const blob = await toBlob(canvas)
        if (!blob) return null
        const strip = {
            src: URL.createObjectURL(blob),
            frames: grid.ticks,
            cols: grid.cols,
            rows: grid.rows,
            w, h,
            // Exactly cells x tick, never the raw source total: the period the
            // CSS animates over and the number of cells it steps through have
            // to describe the same strip, or every frame is off by the drift
            // between them.
            durationMs: grid.durationMs,
        }
        writeStore(url, blob, strip)
        return strip
    } finally {
        try { dec.close() } catch { /* already closed */ }
    }
}

/**
 * ── WHY A STRIP GETS RESAMPLED ──────────────────────────────────────────────
 *
 * A strip is played by a single `steps(n)` over a single duration, so every
 * cell on it is held for exactly `duration / n`. A GIF/WebP does not promise
 * that: each frame carries its own delay, and 8 of the 21 animated emotes
 * measured on prod (2026-09-21, the 1x size the page actually loads) use more
 * than one. `GuitarTime` is 52 frames of 50, 60, 70, 90, 100 and 130ms, and it
 * was being played at a flat 69.2ms — the 130ms holds flashed past at half
 * their length and the 50ms frames dragged to nearly a frame and a half. That
 * is the whole of the "weird frame pacing".
 *
 * So when the source is not already evenly paced, the strip is rebuilt on a
 * uniform tick and frames are REPEATED across as many cells as their real
 * delay covers. The cell rate becomes a lie the source agrees with.
 *
 * The cells are drawn straight from the decoder — a frame that fills several
 * cells is decoded once and drawn into each — and an evenly-paced source (the
 * other 13) that fits its grid lands one frame per cell, byte for byte what
 * it built before.
 */

/** Largest deviation from a flat cell rate we will simply accept. `Clap` is
 *  200ms + 190ms: a 2.6% error, and correcting it would cost 39 cells to buy
 *  5ms nobody can see. `AlienDance` (60/30ms) is 48% off and gets fixed. */
const PACING_TOLERANCE = 0.1

function gcd(a, b) { while (b) { [a, b] = [b, a % b] } return a }

/**
 * The uniform tick to lay `durs` (microseconds) out on, in at most `maxCells`.
 *
 * @returns {{ticks:number, tick:number, map:number[]|null}}
 *   `map` is null when the source is already even and fits — cell i is
 *   frame i — and otherwise holds, per cell, the source frame it shows.
 */
function pace(durs, maxCells) {
    const frames = durs.length
    const totalUs = durs.reduce((a, b) => a + b, 0)
    const flat = totalUs / frames
    let worst = 0
    for (const d of durs) worst = Math.max(worst, Math.abs(d - flat) / flat)
    if (worst <= PACING_TOLERANCE && frames <= maxCells) return { ticks: frames, tick: flat, map: null }

    // Exact when the delays share a factor and the cell count fits; otherwise
    // the finest tick the cap allows, which quantizes each hold to within one
    // tick instead of flattening it — and, for a source with more frames than
    // cells, plays all of it at that coarser rate.
    let tick = durs.reduce((a, b) => gcd(a, b))
    if (!tick || totalUs / tick > maxCells) tick = Math.ceil(totalUs / maxCells)
    const ticks = Math.max(2, Math.min(maxCells, Math.round(totalUs / tick)))
    return { ticks, tick, map: walk(durs, ticks, tick) }
}

/** Cell i shows whatever source frame is on screen at i * tick — exactly what
 *  steps() will do with it. One walk of the source's timeline. */
function walk(durs, ticks, tick) {
    const map = new Array(ticks)
    let src = 0
    let end = durs[0]
    for (let i = 0; i < ticks; i++) {
        const t = i * tick
        while (t >= end && src < durs.length - 1) { src++; end += durs[src] }
        map[i] = src
    }
    return map
}

/**
 * The cells onto a cols x rows grid inside the texture limit.
 *
 * Two independent steps() play the grid, one per axis, so every cell has to
 * be a real cell — a half-empty last row would be shown. A count with a
 * divisor that fits is laid out exactly, widest first, so anything that fits
 * one row IS the one-row strip v2 built. Otherwise (a prime count taller than
 * the texture allows) the timeline is re-walked onto the widest rectangle
 * that fits, at most one tick coarser.
 */
function layout(paced, durs, maxCols, maxRows, maxCells) {
    const { ticks } = paced
    for (let cols = Math.min(ticks, maxCols); cols >= 1; cols--) {
        if (ticks % cols === 0 && ticks / cols <= maxRows) return withGrid(paced, cols, ticks / cols)
    }
    const cols = Math.min(ticks, maxCols)
    const rows = Math.min(maxRows, Math.ceil(ticks / cols), Math.floor(maxCells / cols))
    const cells = cols * rows
    const tick = durs.reduce((a, b) => a + b, 0) / cells
    return withGrid({ ticks: cells, tick, map: walk(durs, cells, tick) }, cols, rows)
}

function withGrid(paced, cols, rows) {
    return { ...paced, cols, rows, durationMs: Math.max(50, Math.round(paced.ticks * paced.tick / 1000)) }
}

function makeCanvas(w, h) {
    if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h)
    const c = document.createElement('canvas')
    c.width = w; c.height = h
    return c
}

function toBlob(canvas) {
    if (canvas.convertToBlob) return canvas.convertToBlob({ type: 'image/webp', quality: 0.92 })
    return new Promise(r => canvas.toBlob(r, 'image/webp', 0.92))
}

// ── persistence ─────────────────────────────────────────────────────────────
//
// The decode happens once per emote PER DEVICE, ever — not once per session.
// Metadata rides as headers on the stored Response so one entry carries both
// the bytes and the frame geometry; a strip whose geometry was lost would be
// unplayable and there is no way to recompute it from the blob alone.

function storeKey(url) {
    return `/__hs-sprite/${encodeURIComponent(url)}`
}

/** Drop superseded strip buckets. Once, lazily, off the first read — a device
 *  that never mounts a sprite never pays for it, and one that does pays a
 *  single `caches.delete` rather than carrying a dead copy of every emote it
 *  has ever seen. */
let reapedStale = false
function reapStaleStores() {
    if (reapedStale || typeof caches === 'undefined') return
    reapedStale = true
    for (const name of STALE_STORES) {
        caches.delete(name).catch(() => { /* never had it, or no quota access */ })
    }
}

async function readStore(url) {
    if (typeof caches === 'undefined') return null
    reapStaleStores()
    try {
        const c = await caches.open(STORE)
        const hit = await c.match(storeKey(url))
        if (!hit) return null
        const cols = +hit.headers.get('x-cols')
        const rows = +hit.headers.get('x-rows')
        const w = +hit.headers.get('x-w')
        const h = +hit.headers.get('x-h')
        const durationMs = +hit.headers.get('x-duration')
        if (!(cols > 0 && rows > 0 && cols * rows > 1 && w > 0 && h > 0 && durationMs > 0)) return null
        const blob = await hit.blob()
        return { src: URL.createObjectURL(blob), frames: cols * rows, cols, rows, w, h, durationMs }
    } catch {
        return null  // private mode, quota, cleared storage — rebuild instead
    }
}

/** Successful puts this page. The store is trimmed on the first and every 32nd:
 *  one `keys()` listing per 32 writes, not per write. */
let storeWrites = 0

/** Drop the oldest entries past STORE_MAX. `keys()` lists in insertion order. */
function trimStore(c) {
    return c.keys().then((keys) => Promise.all(keys.slice(0, Math.max(0, keys.length - STORE_MAX)).map(k => c.delete(k))))
}

function writeStore(url, blob, strip) {
    if (typeof caches === 'undefined') return
    caches.open(STORE).then(c => c.put(storeKey(url), new Response(blob, {
        headers: {
            'content-type': 'image/webp',
            'x-cols': String(strip.cols),
            'x-rows': String(strip.rows),
            'x-w': String(strip.w),
            'x-h': String(strip.h),
            'x-duration': String(strip.durationMs),
        },
    })).then(() => (storeWrites++ % 32 === 0 ? trimStore(c) : null)))
        .catch(() => { /* quota — the in-memory map still serves this session */ })
}

// ── mounting ────────────────────────────────────────────────────────────────

/** Class the CSS keys off. The rule set is small and lives in cosmetics.css. */
export const SPRITE_CLASS = 'hs-sprite'

/** Put on the host while a sprite is playing, so the <img> under it can be
 *  hidden without collapsing the box it is still providing. */
export const SPRITE_ON_CLASS = 'hs-sprite-on'

/**
 * Class on the strip element itself — the one thing on the page that actually
 * animates. It carries no styling: `.hs-sprite > i` already does that. It
 * exists so base.css's blanket reduced-motion rule can EXEMPT it, which it
 * addresses by class substring and cannot do to an element that has none.
 *
 * Without it the strip was clamped to `0.01ms / 1 iteration`, settled at
 * `transform: none` = frame 0, and the real <img> under it was already
 * `opacity: 0` — so every animated emote on the page was a frozen first frame,
 * unrecoverable by any setting. Android reports `reduce` whenever its animator
 * duration scale is 0, which is why this is a phone symptom first. Same call
 * already made for `img.emote`, `hs-fx-*` and paints: an emote is content
 * someone sent, and the animateEmotes setting is the only owner of whether it
 * moves.
 */
export const SPRITE_RUN_CLASS = 'hs-sprite-run'

/**
 * Play `strip` inside `host`, filling whatever box `host` already has.
 *
 * NOTHING IS MEASURED. The window is `inset:0` over a wrapper that already
 * reserved the emote's box before the bytes landed, the strip is `n` windows
 * wide in percentages, and one period translates it by its own width. A
 * pixel-based version would need a layout read per mount, on the firehose
 * path, for every row — see cosmetics.css for the full geometry note.
 *
 * Phase comes from wall-clock, not from when this row rendered, so every copy
 * of one emote shows the same frame — the same trick the paint compiler's
 * syncDelayCalc uses.
 *
 * @param {HTMLElement} host the .emote-hover-wrapper
 * @param {{src:string,cols:number,rows:number,durationMs:number}} strip
 */
let spriteStamp = 0
let spriteStampFrame = null

/** `Date.now()`, but constant for the whole animation frame — see mountSprite. */
function frameNow() {
    const frame = typeof document !== 'undefined' && document.timeline
        ? document.timeline.currentTime : null
    if (frame !== null && frame === spriteStampFrame) return spriteStamp
    spriteStamp = Date.now()
    spriteStampFrame = frame
    return spriteStamp
}

// Strip srcs proven paintable — one decode per strip, ever, not per mount.
const paintableStrips = new Set()

/**
 * Resolve once the strip at `src` can actually paint.
 *
 * SPRITE_ON_CLASS makes the real <img> `opacity: 0` (cosmetics.css), so the
 * moment it lands the emote's only visible layer is this background image. We
 * used to add it in the same task as the background-image assignment, with
 * nothing fetched or decoded — so there was at least one frame showing neither
 * the img nor the sprite. It read as a single flash on the first row to use
 * each emote, most visibly on your own message, which is the only row rendered
 * twice (local echo, then the platform echo replacing it ~200ms later — exactly
 * the window in which the strip finishes building).
 *
 * Decoding through a detached Image rather than waiting on the host also means
 * a row still sitting in chat-tile's offscreen append holder starts its fetch
 * immediately instead of at attach time.
 *
 * A decode failure deliberately leaves the class OFF: a visible static emote
 * beats a hidden animated one, and hiding on a promise that rejected is how the
 * flash became permanent.
 */
function whenStripPaintable(src) {
    const img = new Image()
    img.src = src
    const decoded = typeof img.decode === 'function' ? img.decode() : Promise.resolve()
    return decoded.then(() => { paintableStrips.add(src); return true }, () => false)
}

export function mountSprite(host, strip) {
    if (!host || !strip) return null
    let el = host.querySelector(`:scope > .${SPRITE_CLASS}`)
    if (!el) {
        el = document.createElement('span')
        el.className = SPRITE_CLASS
        el.setAttribute('aria-hidden', 'true')
        const frameStrip = document.createElement('i')
        frameStrip.className = SPRITE_RUN_CLASS
        el.appendChild(frameStrip)
        host.appendChild(el)
    }
    const i = el.firstElementChild
    // A sprite mounted before this class existed (a warm page across a deploy,
    // or any host this function is handed twice) still has a bare <i>.
    if (!i.classList.contains(SPRITE_RUN_CLASS)) i.classList.add(SPRITE_RUN_CLASS)
    i.style.setProperty('--hs-sp-cols', String(strip.cols))
    i.style.setProperty('--hs-sp-rows', String(strip.rows))
    i.style.setProperty('--hs-sp-dur', `${strip.durationMs}ms`)
    // The column pass runs once per row: its period is the grid's divided by
    // its rows, in full float precision, because the two animations only
    // agree on which cell is up if that quotient is exact.
    i.style.setProperty('--hs-sp-row-dur', `${strip.durationMs / strip.rows}ms`)
    // The step counts as LITERALS, not through the custom properties.
    //
    // `--hs-sp-cols` / `--hs-sp-rows` still drive the grid's SIZE, where a
    // var() in calc() is ordinary. They must not drive `steps()`: that wants an <integer>, the
    // substitution only happens at computed-value time, and an engine that
    // refuses it there invalidates the whole declaration — which, while this
    // was written as the `animation` shorthand, took `animation-name` with it
    // and stopped every sprite on that engine dead. We know N right here, so
    // nothing has to be substituted at all. See cosmetics.css.
    const steps = `steps(${strip.cols}), steps(${strip.rows})`
    if (i.style.animationTimingFunction !== steps) i.style.animationTimingFunction = steps
    // ONE CLOCK READ PER FRAME, for the same reason the paint compiler's
    // paintPhaseNow does it: this animation will start at the FRAME's timeline
    // time, so two copies mounted in one frame start together — but a per-mount
    // Date.now() gives them different delays, which is different phases. The
    // sync this function exists for was accurate only to how long the mounting
    // loop took.
    i.style.setProperty('--hs-sp-delay', `${-(frameNow() % strip.durationMs)}ms`)
    // Compare before assigning: re-running reconcile is supposed to be free,
    // and re-setting background-image to the same url still invalidates.
    const want = `url("${strip.src}")`
    if (i.style.backgroundImage !== want) i.style.backgroundImage = `url(${strip.src})`
    // Hide the real <img> only once this strip is known to paint. Warm path —
    // every row after the first for a given emote — is synchronous, so the
    // common case costs nothing and stays in the same frame as the mount.
    if (paintableStrips.has(strip.src)) {
        host.classList.add(SPRITE_ON_CLASS)
    } else {
        whenStripPaintable(strip.src).then((ok) => {
            // Re-check the mount: reconcile may have unmounted or re-pointed
            // this host while the decode was in flight.
            if (!ok) return
            if (i.style.backgroundImage !== want && i.style.backgroundImage !== `url(${strip.src})`) return
            host.classList.add(SPRITE_ON_CLASS)
        })
    }
    return el
}

/** Remove the sprite layer from `host`, if it has one. */
export function unmountSprite(host) {
    if (!host?.querySelector) return
    const el = host.querySelector(`:scope > .${SPRITE_CLASS}`)
    if (el) el.remove()
    host.classList?.remove(SPRITE_ON_CLASS)
}

/** True once this source has been refused for good — it will never be a
 *  sprite, so whatever the budget does to it is permanent. */
export function spriteRefused(url) {
    return !!url && refused.has(url)
}

/**
 * The strip for `url` if it is ALREADY built, else undefined.
 *
 * reconcile() runs on the render path and must not await anything: a sprite
 * that is not ready yet simply is not used for this pass, and the build's
 * completion re-runs reconcile for the elements that asked.
 */
export function peekSprite(url) {
    return touch(url)
}

/** Test seam — drops every memo so a case starts from nothing. */
export function _resetForTests() {
    for (const [, s] of ready) { if (s?.src) URL.revokeObjectURL(s.src) }
    strips.clear()
    ready.clear()
    refused.clear()
    retries.clear()
    corsProxy = null
    paintableStrips.clear()
    storeWrites = 0
    onReady = null
}
