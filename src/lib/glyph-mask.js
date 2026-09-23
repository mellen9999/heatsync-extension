/**
 * Glyph mask — rasterise a letterform ONCE, then move the fill under it.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * `animated-texture.js` argues the general case and proved it for emotes: a
 * moving `background-position` under `background-clip:text` is a main-thread
 * repaint, every frame, PER ELEMENT, while a `transform` on a promoted layer is
 * a GPU quad blit that costs about the same at twenty copies as at one.
 *
 * The name FILL — the one animation every painted name has — was never
 * converted, and because a letter-split paint puts it on one span per GLYPH,
 * every glyph is its own clip-text layer re-rastering. Measured on today's
 * compiler, 414x896 @ dpr3, cpu 4x, renderer ms per 3s (`paint-perf
 * --composited`):
 *
 *   variant                          1 name    20 names   paint ops
 *   A  background-clip:text (ships)  104.5ms    851.4ms      3704
 *   E  per-glyph mask + transform      1.1ms      6.8ms         1
 *   static (the floor)                 0.9ms      2.5ms         1
 *
 * 851ms per 3s is a third of the wall-clock budget at 4x CPU, on a phone, for
 * ambient motion nobody is tracking.
 *
 * ── PER CHARACTER, AND PER NAME ─────────────────────────────────────────────
 *
 * A letter-split name moves its letters, so each glyph needs its own
 * letterform — maskFor, keyed by CHARACTER, a cache the size of an alphabet.
 * Its fill is still one gradient across the name: each glyph's boxes are
 * offset by the glyph's position in the name (`--gx`, from the advances
 * returned here), not given a private copy each.
 *
 * A name that is not split is one run of text and gets ONE letterform for the
 * whole string — maskForText, keyed by the name. One element per motion under
 * it, however long the name is; the cost is a cache the size of the painted
 * names seen lately, so it is capped harder and its rules leave with it.
 *
 * ── WHY THE TEXT STAYS ──────────────────────────────────────────────────────
 *
 * The spans keep their real text nodes, set to `color:transparent`. The visible
 * pixels come from the masked `::before`. paint-spec.js:586 places the scene
 * planes ahead of the name specifically so "a painted name stays copyable as
 * its own text", and NOTHING tests it — a bitmap glyph would break selection,
 * copy, find-in-page and screen readers silently. A transparent text node still
 * does all four, and using `::before` means the markup does not change at all.
 *
 * @module cosmetics/glyph-mask
 */

/** Injected, not imported: this file is synced verbatim into the extension,
 *  which has its own logger, and a leaf module that reaches for the app's
 *  services is one the extension cannot take as-is. Silent until the owner
 *  hands one in (paint-cosmetics does, at import). */
let maskLog = { debug() { } }
export function setLogger(l) { if (l && typeof l.debug === 'function') maskLog = l }

/** Built masks, keyed by `dpr|box|font|char`. Insertion-ordered, so the first
 *  key is the least recently used — the Map is the LRU. */
const cache = new Map()

/** An alphabet, its punctuation, and room for several scripts at once. Names
 *  repeat their letters hard, so this is a high hit rate at a small size. */
const CACHE_MAX = 512

/** Whole-name masks, same LRU shape. A name is not an alphabet — the cache is
 *  as big as the set of painted names on screen recently, and every entry is a
 *  rule in the sheet, so it is capped harder than the glyphs. */
const textCache = new Map()
const TEXT_CACHE_MAX = 256

/** Characters that cannot be masked — zero advance, canvas refused. Remembered
 *  so a firehose does not retry per row. */
const refused = new Set()

/** Called once webfonts land, so glyphs measured against a fallback face can be
 *  rebuilt against the real one. */
let onReady = null
let fontsHooked = false

export function setOnReady(fn) { onReady = fn }

export function supported() {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return false
    // Safari still needs the prefix; a browser with neither keeps the clip-text
    // path, which is exactly today's behaviour.
    return typeof CSS !== 'undefined' && typeof CSS.supports === 'function'
        && (CSS.supports('mask-image', 'url(a)') || CSS.supports('-webkit-mask-image', 'url(a)'))
}

let ctx = null
/** One measuring context for the module — creating a canvas per call is most of
 *  the cost of measuring one character. */
function measureCtx() {
    if (!ctx) ctx = document.createElement('canvas').getContext('2d')
    return ctx
}

// ── the URL lives in the CSSOM, never on the element ─────────────────────────
//
// The first cut set `--hsp-m` as an inline style per span. It worked and it was
// a disaster: a mask is a few KB of base64, and putting a copy on all 160 spans
// of a twenty-name screen moved the cost from raster to STYLE — paint ops fell
// 3864 -> 1 and raster 46.4ms -> 1.5ms, while UpdateLayoutTree went 346ms ->
// 1453ms and the total got WORSE (paint-perf --masked, the arm that caught it).
//
// So each distinct letterform gets ONE rule in one sheet, and a span references
// it by class. The bytes exist once in the CSSOM however many rows use them,
// which is the same "one texture, N free copies" the rest of this rung is about.
//
// AND THE RULE SETS `mask-image` DIRECTLY, never through a custom property.
// That indirection was the second version and it barely helped: the recalc COUNT
// was identical (180 per 3s either way, one per frame) but each recalc cost 4-5x
// more, because substituting a multi-KB token stream on 160 spans is work that
// happens every single time style is resolved. As a plain declaration in a
// matched rule it is resolved once. 1388ms -> see the table in paint-spec.js.
//
// Scoped under the gate class so dropping the gate drops the mask with it —
// otherwise a name whose masks were invalidated would keep its letterforms
// punched out while the fill went back to the clip-text path.

/** Must match MASKED_CLASS in utils/paint-spec.js, which is what the compiler
 *  gates the composited rules on. Not imported: this module is a leaf, and the
 *  compiler is 70KB. A test holds the two together. */
const GATE_CLASS = 'hs-masked'

let sheet = null
let nextId = 0
/** Class -> nothing; insertion-ordered, which is the order of the rules in the
 *  sheet, so a class's position in this list IS its rule index. */
const ruleOrder = []

function ruleSheet() {
    if (sheet?.isConnected && sheet.sheet) return sheet.sheet
    sheet = document.getElementById('hs-glyph-masks')
    if (!sheet) {
        sheet = document.createElement('style')
        sheet.id = 'hs-glyph-masks'
        document.head.appendChild(sheet)
    }
    // A re-found or re-created sheet starts empty as far as we know: rules we
    // counted into a detached one are gone with it.
    ruleOrder.length = 0
    return sheet.sheet
}

// ── ONE RULE PER MASK, AND IT LEAVES WITH THE MASK ──────────────────────────
//
// This used to append a text node per mask and never remove one. The LRU above
// dropped its entry and the rule stayed — a few KB of base64 per letterform,
// forever, which on a whole-name cache keyed by every painted name that scrolls
// past is a leak measured in megabytes of CSSOM by the end of a stream.
//
// So the rule is inserted through the CSSOM and deleted by index when its cache
// entry goes. And a name still WEARING the evicted class must not be left
// holding the gate: its fill layers would keep rendering with no letterform to
// cut them, which is a solid block of gradient where the name was. Dropping
// the gate puts that name back on the clip-text rest frame the compiler always
// emits underneath.

/** Put one mask in the sheet and hand back the class that selects it. */
function publish(src, prefix) {
    const cls = `${prefix}${nextId++}`
    const url = `url("${src}")`
    const css = ruleSheet()
    if (!css) return null
    // Both forms: a glyph class sits on a span INSIDE the gated box, a whole-name
    // class can sit on the gated box itself.
    css.insertRule(`.${GATE_CLASS}.${cls},.${GATE_CLASS} .${cls}{-webkit-mask-image:${url};mask-image:${url};}`, ruleOrder.length)
    ruleOrder.push(cls)
    return cls
}

function unpublish(cls) {
    const i = ruleOrder.indexOf(cls)
    if (i < 0) return
    try { sheet?.sheet?.deleteRule(i) } catch (err) { maskLog.debug('[glyph-mask] deleteRule failed', err) }
    ruleOrder.splice(i, 1)
    if (typeof document.getElementsByClassName !== 'function') return
    // Live collection — copy before mutating the class it is keyed on.
    for (const el of [...document.getElementsByClassName(cls)]) {
        el.classList.remove(cls)
        const gated = el.classList.contains(GATE_CLASS) ? el : el.closest?.(`.${GATE_CLASS}`)
        gated?.classList.remove(GATE_CLASS)
    }
}

/** Drop every mask, rules included. */
function clearAll() {
    for (const m of cache.values()) unpublish(m.cls)
    for (const m of textCache.values()) unpublish(m.cls)
    cache.clear()
    textCache.clear()
    refused.clear()
}

/** LRU put: evicting an entry deletes its rule. */
function remember(map, max, k, v) {
    if (map.size >= max) {
        const oldest = map.keys().next().value
        const gone = map.get(oldest)
        map.delete(oldest)
        if (gone) unpublish(gone.cls)
    }
    map.set(k, v)
}

/**
 * Wait for webfonts once, then let the owner re-drive.
 *
 * A glyph rasterised before CozetteVector loads is the FALLBACK face's
 * letterform, and it will not line up with the text the browser finally lays
 * out. That is not a reason to block the first paint — it is a reason to drop
 * every mask and rebuild after.
 */
function hookFonts() {
    if (fontsHooked || typeof document === 'undefined' || !document.fonts?.ready) return
    fontsHooked = true
    // Already loaded means every mask built from here on IS the real face.
    // Hooking anyway threw away the first mounts on every page and made the
    // owner rebuild them one tick later for nothing.
    if (document.fonts.status === 'loaded') return
    document.fonts.ready.then(() => {
        clearAll()
        onReady?.()
    }).catch(() => { /* no webfonts is not an error */ })
}

/**
 * The mask for one character, building it if needed.
 *
 * Synchronous on purpose. Unlike an emote strip there is nothing to decode —
 * this is one `fillText` into a box the size of a letter — and the render path
 * needs an answer in the tick it shapes the span. The cache is what keeps it
 * off the firehose.
 *
 * @param {string} ch a single character, exactly as it renders
 * @param {string} font a CSS `font` shorthand, as `getComputedStyle().font` gives it
 * @param {number} boxH the span's box height in CSS px (its line box)
 * @param {number} dpr device pixel ratio to rasterise at
 * @returns {{src:string,w:number,h:number,cls:string}|null} `cls` is the class
 *   to put on the span — the URL itself lives in the sheet, once. `w` is the
 *   glyph's advance, the width the inline-block span will take.
 */
export function maskFor(ch, font, boxH, dpr) {
    if (!ch || !font || !(boxH > 0) || !supported()) return null
    const k = `${dpr}|${boxH}|${font}|${ch}`
    if (refused.has(k)) return null
    const hit = cache.get(k)
    if (hit) {
        // Touch for LRU — delete+set moves it to the end of the insertion order.
        cache.delete(k)
        cache.set(k, hit)
        return hit
    }
    hookFonts()
    try {
        const built = build(ch, font, boxH, dpr)
        if (!built) { refused.add(k); return null }
        remember(cache, CACHE_MAX, k, built)
        return built
    } catch (err) {
        maskLog.debug('[glyph-mask] build failed', err)
        refused.add(k)
        return null
    }
}

function build(text, font, boxH, dpr, prefix = 'hs-g') {
    const m = measureCtx()
    m.font = font
    const metrics = m.measureText(text)
    const w = metrics.width
    if (!(w > 0)) return null

    // The glyph is drawn on the span's own baseline, not the canvas's middle:
    // the mask has to register with the text the browser lays out underneath it,
    // and a mask a pixel out reads as a smeared letter rather than as a bug.
    // Centre the face's own box inside the line box to find that baseline.
    const ascent = metrics.fontBoundingBoxAscent || metrics.actualBoundingBoxAscent || boxH * 0.8
    const descent = metrics.fontBoundingBoxDescent || metrics.actualBoundingBoxDescent || boxH * 0.2
    const baseline = (boxH - (ascent + descent)) / 2 + ascent

    // The EXACT ratio, never rounded up. The mask is stretched to its box
    // (mask-size:100% 100%), so a canvas rastered at ceil(1.25) = 2 is scaled
    // back down by 0.625 — resampled, and a resampled letterform is a soft one.
    // Whole device pixels are still whole: the canvas is sized to round(w*dpr)
    // and the scale is corrected to land the text exactly on that grid.
    const scale = Math.max(1, dpr || 1)
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(w * scale))
    c.height = Math.max(1, Math.round(boxH * scale))
    const g = c.getContext('2d')
    if (!g) return null
    g.scale(c.width / w, c.height / boxH)
    g.font = font
    g.textBaseline = 'alphabetic'
    // White on transparent: a mask reads the ALPHA channel, so drawing the
    // letterform opaque is what lets the fill show through exactly it.
    g.fillStyle = '#fff'
    g.fillText(text, 0, baseline)

    const src = c.toDataURL()
    const cls = publish(src, prefix)
    return cls ? { src, w, h: boxH, cls } : null
}

/**
 * The mask for a WHOLE name, building it if needed.
 *
 * The per-glyph mask exists because a letter-split name's fill was per-glyph
 * local. A name that is not split has no such excuse — it is one run of text,
 * and one gradient should cross it. So it gets one letterform for the whole
 * string, and the fill layers move under THAT: one element per motion, however
 * long the name is.
 *
 * Same contract as maskFor — synchronous, cached, refused once — keyed by the
 * whole string, and capped harder because a name is not an alphabet.
 *
 * @returns {{src:string,w:number,h:number,cls:string}|null} `w` is the laid-out
 *   advance of the whole run, which is the name box's width.
 */
export function maskForText(text, font, boxH, dpr) {
    if (!text || !font || !(boxH > 0) || !supported()) return null
    const k = `${dpr}|${boxH}|${font}|${text}`
    if (refused.has(`T${k}`)) return null
    const hit = textCache.get(k)
    if (hit) {
        textCache.delete(k)
        textCache.set(k, hit)
        return hit
    }
    hookFonts()
    try {
        const built = build(text, font, boxH, dpr, 'hs-t')
        if (!built) { refused.add(`T${k}`); return null }
        remember(textCache, TEXT_CACHE_MAX, k, built)
        return built
    } catch (err) {
        maskLog.debug('[glyph-mask] text build failed', err)
        refused.add(`T${k}`)
        return null
    }
}

/** The mask for `ch` if it is ALREADY built, else undefined. */
export function peekMask(ch, font, boxH, dpr) {
    return cache.get(`${dpr}|${boxH}|${font}|${ch}`)
}

/** Test seam — drops every memo so a case starts from nothing. */
export function _resetForTests() {
    cache.clear()
    textCache.clear()
    refused.clear()
    ruleOrder.length = 0
    onReady = null
    fontsHooked = false
    maskLog = { debug() { } }
    ctx = null
    sheet?.remove?.()
    sheet = null
    nextId = 0
}
