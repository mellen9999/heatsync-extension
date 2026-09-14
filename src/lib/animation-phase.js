/**
 * Re-anchor a CSS animation to the wall clock.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * Every cosmetic in HeatSync is phase-locked the same way: a shared CSS rule
 * carries `animation-delay: calc(-1 * mod(var(--hsp-t), <period>))` (paints,
 * via syncDelayCalc) or `animation-delay: -(now % period)ms` (emote sprites),
 * so an element mounted at ANY instant lands on the frame the wall clock says
 * it should. Mount time cancels out. That is what makes twenty copies of one
 * paint show one animation instead of twenty.
 *
 * The offscreen gate then pauses animations with `animation-play-state:paused`
 * and un-pauses them on the way back, on the assumption — written down at
 * client/config/limits.js and believed everywhere else — that "a paused CSS
 * animation resumes phase-locked".
 *
 * IT DOES NOT. Pausing freezes the animation's `currentTime`; resuming ticks
 * on from that frozen value. The negative delay is consumed once, when the
 * animation first starts, and is never re-read. Measured in Chromium with the
 * real `calc(-1 * mod(...))` delay shape, two identical animations, one paused
 * for 2s:
 *
 *     never paused        drift    0ms
 *     paused + resumed    drift 1983ms   (on a 4s period — half a loop out)
 *
 * So every name that scrolled off screen came back offset by exactly how long
 * it had been away, permanently, and independently of every other name. After
 * a few scrolls each painted name is running on its own timing — which is the
 * visible complaint, and the reason this module exists.
 *
 * Refreshing `--hsp-t` does NOT fix it (measured: identical 1983ms drift) —
 * the engine does not re-evaluate `animation-delay` for an animation that has
 * already begun. The phase has to be written directly.
 *
 * ── WHY currentTime AND NOT A RESTART ───────────────────────────────────────
 *
 * The other way to re-read the delay is to restart the animation
 * (`animation-name:none`, force a reflow, restore). Measured equal on accuracy
 * (87ms vs 86ms residual, which is the reference element's own mount lag, not
 * the fix) — but it costs a forced synchronous layout per element, on the
 * scroll path, which is the precise cost the gate exists to avoid. Writing
 * `currentTime` re-anchors with no layout at all.
 *
 * ── WHY THE ARITHMETIC WAS NOT ENOUGH ───────────────────────────────────────
 *
 * Measured on a real phone, 24 copies of ONE paint in a live room. The stamp
 * and the computed delay were both correct and agreed to within 10ms across
 * every copy; the animations did not:
 *
 *     coin        5s loop      652ms spread    16 distinct anchors of 17
 *     tumble    3.4s loop      572ms spread    17% of the loop
 *     backdrop   20s loop     5652ms spread    28% of the loop
 *
 * Two reasons, and the scene planes show both worst.
 *
 * `now % duration` is the wrong fold for an `alternate` animation. Its visual
 * cycle is TWO durations — the compiler says so out loud, syncDelayCalc is
 * handed a doubled period for exactly these — so folding on one duration always
 * lands on iteration 0, always running FORWARD, while a copy that never paused
 * may be halfway through a reverse leg. For half of every cycle the two
 * disagree by a half loop AND by direction.
 *
 * And a re-anchor ran on elements that had never been paused at all: an
 * IntersectionObserver delivers an initial callback for every newly observed
 * target, so every freshly prepended history row was re-anchored the instant it
 * registered. Harmless against correct arithmetic; with the fold above it was
 * the trigger. Reported as "the names that appear from history when i scroll up
 * are all on their own".
 *
 * So the phase is now RESTORED rather than recomputed wherever possible.
 * Remember `startTime` before pausing and a release is "as if it had never
 * paused" — exact, no modulus, iteration parity and direction carried along for
 * free. The arithmetic stays as the fallback for an animation this module never
 * saw pause (one created by a class swap or a span rebuild), and it now folds
 * on the full visual cycle.
 *
 * ── AND THE FALLBACK STOPPED READING THE DELAY ──────────────────────────────
 *
 * That fallback rebuilt the phase as `delay + (now % cycle)`, whose local time
 * is `now % cycle` — the delay cancels straight out of it. Correct while
 * `animation-delay` held exactly one term, the wall-clock sync, since removing
 * it is the entire job. It became wrong the day a letter motion added a SECOND
 * term: `var(--i) * -step`, the per-glyph stagger that IS the motion. Cancelling
 * the delay cancels the stagger with it. Six glyphs, 90ms apart by construction:
 *
 *     before the anchor   1564  1654  1744  1834  1924  2014
 *     after the anchor    1815  1815  1815  1815  1815  1815
 *
 * — a whole row of letters snapping into lockstep the moment it was gated,
 * swept, or scrolled past.
 *
 * The phase is rebuilt from the STAMP now, not from the delay: `now - stamp` is
 * how long the element has been mounted, which is what currentTime would read
 * had the animation started at the instant it was stamped rather than whenever
 * its mount frame happened to end. The delay is left alone to do both of its
 * jobs at once, and this code never has to know which term is which. See
 * phaseFor. Anything with no `--hsp-t` — an emote sprite, whose delay is only
 * ever the sync term — keeps the old fold, where cancelling is still right.
 */

/** startTime at the moment each animation was paused, so a release can put it
 *  back rather than derive it. Keyed on the Animation object: an element whose
 *  animations were replaced gets no entry and falls to the arithmetic, which is
 *  the right answer for an animation that never ran. */
const pausedStartTimes = new WeakMap()

/** Elements whose pause is waiting for their animations to actually START.
 *  Value is a token, so a resume that arrives first can cancel the pause by
 *  moving the token on — a stale deferred pause must never land. */
const pendingPause = new WeakMap()
let pauseToken = 0

/** True while ANY animation on `el` has yet to be handed a startTime.
 *  A CSS animation created in this task is `pending` until the next frame ticks
 *  it; until then there is no phase on it to remember. */
function hasPendingStart(anims) {
    for (const a of anims) {
        if (typeof a.startTime !== 'number' || !Number.isFinite(a.startTime)) return true
    }
    return false
}

/** The full visual cycle. An `alternate` animation reverses on odd iterations,
 *  so its picture repeats every TWO durations — the same doubling syncDelayCalc
 *  is handed for these, and the same condition paint-perf's `--diff` seeks with.
 *  A finite run of fewer than two iterations never reverses. */
function visualCycle(t, d) {
    const alt = /^alternate/.test(String(t.direction || 'normal'))
    return alt && !(t.iterations >= 0 && t.iterations < 2) ? d * 2 : d
}

/**
 * The element's mount stamp in wall-clock ms, or null if it carries none.
 *
 * Inline first because that is where every renderer writes it (and where the
 * async repaint path sets it); the computed read is the fallback for an
 * animation on a descendant that inherits the value rather than owning it.
 *
 * @param {Element|null|undefined} el
 */
function stampOf(el) {
    if (!el) return null
    let raw = el.style?.getPropertyValue?.('--hsp-t') || ''
    if (!raw && typeof getComputedStyle === 'function') {
        try { raw = getComputedStyle(el).getPropertyValue('--hsp-t') || '' } catch (_) { raw = '' }
    }
    const s = parseFloat(String(raw).trim())
    return Number.isFinite(s) && s > 0 ? s * 1000 : null
}

let frameStamp = 0
let frameStampAt = null

/**
 * `Date.now()`, held constant for the whole animation frame.
 *
 * `document.timeline.currentTime` does not advance during a synchronous task,
 * so this is stable across a re-anchor loop however long the loop takes — which
 * is the point. A batch passes its own `now` explicitly, but the emote path
 * re-anchors one element at a time from a per-image reconcile, and those have
 * no batch to belong to; this makes every one of them in a frame agree anyway.
 *
 * The paint compiler carries its own copy of this (paintPhaseNow) because it is
 * mirrored byte-for-byte into the extension and must stay dependency-free.
 */
export function frameNow() {
    const frame = typeof document !== 'undefined' && document.timeline
        ? document.timeline.currentTime : null
    if (frame !== null && frame === frameStampAt) return frameStamp
    frameStamp = Date.now()
    frameStampAt = frame
    return frameStamp
}

function animationsOf(el) {
    if (!el || typeof el.getAnimations !== 'function') return []
    // Subtree: a painted name's motion lives on the name AND on the scene
    // planes under it, and they must not be re-anchored to different instants.
    try { return el.getAnimations({ subtree: true }) } catch (_) {
        try { return el.getAnimations() } catch (_) { return [] }
    }
}

/**
 * Remember where every animation on `el` is, so a later release can restore it
 * instead of deriving it.
 *
 * Call it BEFORE applying whatever pauses the element — once paused, the
 * animation's `startTime` is null and there is nothing left to remember.
 *
 * @param {Element|null|undefined} el
 */
export function recordAnimationPhase(el) {
    for (const a of animationsOf(el)) {
        const st = a.startTime
        if (typeof st === 'number' && Number.isFinite(st)) pausedStartTimes.set(a, st)
    }
}

/**
 * Pause `el`, but not before its animations have STARTED.
 *
 * ── WHY A FRAME OF DELAY IS THE WHOLE FIX ───────────────────────────────────
 *
 * A CSS animation created in this task has no `startTime` until the next frame
 * ticks it. Gate it in the same task — which is exactly what a history hydrate
 * does, because 200 rows are inserted at once and all but ~17 are above the
 * fold — and there is no phase to remember, so the release falls to the
 * wall-clock arithmetic.
 *
 * That arithmetic is not wrong; it is TOO RIGHT. It puts the animation on the
 * phase the wall clock calls for, while every copy that was never gated is
 * still running on the start it actually got — which lags its stamp by however
 * long the frame that mounted it took. Measured on the device at a cold load:
 *
 *     stamp -> animation start, never-gated rows     245.0 ms
 *     stamp -> animation start, re-anchored rows      68.7 ms
 *     anchor spread between the two groups           176.4 ms   (on EVERY
 *                                                     animation, both groups
 *                                                     internally exact)
 *
 * Two timings for one paint, split precisely by whether a row was gated before
 * it ever started, worst on load because that is the slowest frame there is.
 * Reported as "different timing on the ones i scroll up to in history on load".
 *
 * So let it start. One frame later the animation has a real `startTime`, the
 * exact-restore path takes it, and it comes back on the phase its siblings are
 * actually on rather than the one they ought to be on. The element animates for
 * one extra frame while off screen; that is the entire cost.
 */
function pauseWhenStarted(el, onPause, anims) {
    const token = ++pauseToken
    pendingPause.set(el, token)
    const land = () => {
        // A resume in between moves the token on, and this pause is stale: the
        // row is back on screen and must not be frozen behind the user's back.
        if (pendingPause.get(el) !== token) return
        pendingPause.delete(el)
        // This element mounted and was gated before it ever started, so it also
        // carries its mount frame's lag (see anchorWhenStarted). Put it right
        // BEFORE remembering where it is, or the row freezes on the wrong phase
        // and the restore faithfully puts it back there.
        seekToWallClock(animationsOf(el), frameNow(), stampOf(el))
        recordAnimationPhase(el)
        onPause?.(el)
    }
    // `ready`, not a frame. These animations are transforms, so they run on the
    // compositor and their startTime is assigned when the first commit lands —
    // NOT at the next animation tick. Waiting one rAF leaves startTime null
    // (measured), which lands right back on the arithmetic this exists to avoid.
    const ready = []
    for (const a of anims) {
        const p = a.ready
        if (p && typeof p.then === 'function') ready.push(p.catch(() => { }))
    }
    // No ready promises means nothing is running to be out of phase with.
    if (!ready.length) { land(); return }
    Promise.all(ready).then(land)
}

/** Batched form — same two-pass shape as resumeInPhase, and for the same
 *  reason: `getAnimations()` flushes pending style, so one flush for the batch
 *  beats one per element on a fling. */
export function pauseInPhase(els, pause) {
    regateInPhase({ pause: els }, { onPause: pause })
}

/**
 * One gate crossing, however many elements went each way.
 *
 * Reading a phase flushes pending style and writing a class dirties it, so a
 * pause batch followed by a resume batch costs TWO flushes per scroll frame.
 * Every read first, then every write, costs one — which matters because this
 * runs from an IntersectionObserver on the scroll path, the exact place the
 * gate exists to keep cheap.
 */
export function regateInPhase({ pause = [], resume = [] }, { onPause, onResume } = {}) {
    const toPause = [], toResume = []
    for (const el of pause) { if (el) toPause.push(el) }
    for (const el of resume) { if (el) toResume.push(el) }
    if (!toPause.length && !toResume.length) return
    // One clock read for the batch. The read has to happen BEFORE the loop, not
    // inside it: every getAnimations() in there flushes style, so the loop takes
    // real time and a per-element read would hand each row its own phase.
    const now = frameNow()
    // A resume cancels any pause still waiting on this element's animations to
    // start (pauseWhenStarted), and must do so BEFORE that pause can land.
    for (const el of toResume) pendingPause.delete(el)
    const deferred = new Map()
    for (const el of toPause) {
        // ONE getAnimations() per element: it flushes style, so asking twice
        // (once to test, once to record) would double the cost of the gate.
        const anims = animationsOf(el)
        if (hasPendingStart(anims)) { deferred.set(el, anims); continue }
        for (const a of anims) pausedStartTimes.set(a, a.startTime)
    }
    for (const el of toResume) resyncAnimationPhase(el, now)
    for (const el of toPause) { if (!deferred.has(el)) onPause?.(el) }
    for (const el of toResume) onResume?.(el)
    // Held back until they have a phase worth remembering.
    for (const [el, anims] of deferred) pauseWhenStarted(el, onPause, anims)
}

/**
 * Put every animation on `el` (and its subtree and pseudo-elements) back on the
 * phase the wall clock calls for, so it agrees with every other copy that has
 * been running all along.
 *
 * Call it BEFORE releasing whatever is pausing the element: setting the phase
 * of a paused animation is what makes it resume already in step, rather than
 * stepping visibly as it catches up.
 *
 * Idempotent — an animation already in phase is written the same value it has.
 *
 * ONE CLOCK READ FOR THE WHOLE BATCH, which is why `now` is a parameter.
 *
 * Reading it inside here was correct for one element and wrong for a row of
 * them: `getAnimations()` flushes pending style, so on a phone each call costs
 * real milliseconds, and a loop over N elements spans that many. Every element
 * then got a different `now` and therefore a different phase — the very drift
 * this function exists to remove, reintroduced by the loop that calls it.
 * Measured on the device at 160.9ms of spread across 17 names, uniform across
 * every animation on them, which is ~9.5ms per element of flush. Worst on load,
 * because that is when the most rows enter at once.
 *
 * @param {Element|null|undefined} el
 * @param {number} [now] wall clock for this batch; defaults to a fresh read
 */
/**
 * Put these animations on the phase the wall clock calls for, and forget any
 * remembered startTime for them.
 *
 * Forgetting is what makes this safe to run in any order against the gate: once
 * an animation has been anchored, the arithmetic IS its phase, so a later
 * release that falls back to the arithmetic lands in the same place a restore
 * would have. Whichever of the two settles first, the result is identical.
 */
function seekToWallClock(anims, now, stamp = null) {
    for (const a of anims) {
        const t = a?.effect?.getTiming?.()
        const d = t?.duration
        if (typeof d !== 'number' || !Number.isFinite(d) || d <= 0) continue
        try { a.currentTime = phaseFor(t, d, now, stamp) } catch (_) { /* not seekable */ }
        pausedStartTimes.delete(a)
    }
}

/**
 * Where an animation should be, in its own currentTime.
 *
 * ── WHY THE STAMPED FORM EXISTS ─────────────────────────────────────────────
 *
 * `delay + (now % cycle)` has a local time of exactly `now % cycle` — the delay
 * cancels out of it. That was right while `animation-delay` held ONE term, the
 * wall-clock sync `-mod(var(--hsp-t), P)`, because cancelling it is the whole
 * job. It stopped being right the moment a letter motion put a SECOND term in
 * there: the per-glyph stagger `var(--i) * -step` (paint-spec buildLetterMotionCss).
 * Cancelling the delay cancels the stagger with it, so every glyph of an
 * anchored row lands on one phase and the letters move in lockstep. Measured on
 * a six-glyph row, glyphs 90ms apart by construction:
 *
 *     before the anchor   1564  1654  1744  1834  1924  2014   (staggered)
 *     after the anchor    1815  1815  1815  1815  1815  1815   (flattened)
 *
 * So do not reconstruct the phase from the delay — reconstruct it from the
 * STAMP, which is the thing the delay was derived from in the first place.
 * `now - stamp` is "how long this element has been mounted", which is what
 * currentTime would read had the animation started at the instant it was
 * stamped instead of whenever its mount frame happened to end. The delay is
 * then left alone to do both of its jobs, and this never has to know which term
 * is which. It also carries the iteration index, so an `alternate` animation
 * comes back on the right leg with no folding at all.
 *
 * The unstamped fold stays for everything that has no `--hsp-t` — animated
 * emote textures, whose delay is only ever the sync term, so cancelling it is
 * still exactly right there.
 */
function phaseFor(t, d, now, stamp) {
    if (stamp !== null && Number.isFinite(stamp) && now >= stamp) return now - stamp
    const delay = Number.isFinite(t.delay) ? t.delay : 0
    return delay + (now % visualCycle(t, d))
}

/**
 * Put freshly mounted elements on the wall clock, once their animations exist.
 *
 * ── WHY THE CSS DELAY IS NOT ENOUGH ON ITS OWN ──────────────────────────────
 *
 * `animation-delay: -(stamp mod P)` is exact only if the animation STARTS at
 * the instant that was stamped. It starts when the frame that mounted it
 * finishes, so a row carries a phase error equal to that frame's length — and
 * frames are not all the same length. A history hydrate is one long frame; a
 * single live message arriving later is a short one. Measured, same page, one
 * paint, neither row ever gated:
 *
 *     mounted inside a 250ms frame    stamp -> start   241.0 ms
 *     mounted in a quiet frame        stamp -> start     6.5 ms
 *     phase between the two                            234.4 ms
 *
 * Nothing corrected it, because correction only ever ran on the gate, and
 * neither row was gated. That is "the ones i scroll up to in history are a
 * different timing than the ones visible on load": the load rows are the long
 * frame, everything after is a short one.
 *
 * So the stamp gets the row close and this puts it exactly right, once, when
 * its animations are real. After it, every copy of a paint is on the same
 * clock no matter what the page was doing when it mounted.
 *
 * Batched deliberately: the first `getAnimations()` flushes pending style and
 * the rest of the loop is then cheap, which is the same reason the gate reads
 * every element before writing any.
 *
 * @param {Iterable<Element>} els elements whose animations were just created
 */
export function anchorWhenStarted(els) {
    const pairs = []
    for (const el of els) {
        if (!el) continue
        const anims = animationsOf(el)
        // The stamp is read HERE, beside the animations it belongs to — the
        // seek lands a frame or more later and the element may be gone by then.
        if (anims.length) pairs.push([anims, stampOf(el)])
    }
    if (!pairs.length) return
    const ready = []
    for (const [anims] of pairs) {
        for (const a of anims) {
            const p = a.ready
            if (p && typeof p.then === 'function') ready.push(p.catch(() => { }))
        }
    }
    // `ready`, not a frame: a composited transform is handed its startTime when
    // the first commit lands, and seeking before that is seeking nothing.
    const land = () => {
        const now = frameNow()
        for (const [anims, stamp] of pairs) seekToWallClock(anims, now, stamp)
    }
    if (!ready.length) land(); else Promise.all(ready).then(land)
}

export function resyncAnimationPhase(el, now = frameNow()) {
    const anims = animationsOf(el)
    if (!anims.length) return
    const stamp = stampOf(el)
    for (const a of anims) {
        const t = a?.effect?.getTiming?.()
        const d = t?.duration
        // `duration` is 'auto' for animations with no resolved duration, and
        // an infinite/zero period has no phase to speak of.
        if (typeof d !== 'number' || !Number.isFinite(d) || d <= 0) continue

        // THE EXACT PATH. We watched this animation pause, so we know where it
        // would be now had it not: the same distance past the startTime it was
        // running on. currentTime is unbounded, so the iteration index — and
        // with it an `alternate` animation's direction — comes back too.
        const wasAt = pausedStartTimes.get(a)
        const tl = a.timeline?.currentTime
        if (typeof wasAt === 'number' && typeof tl === 'number' && Number.isFinite(tl)) {
            try { a.currentTime = tl - wasAt } catch (_) { /* not seekable */ }
            pausedStartTimes.delete(a)
            continue
        }

        // THE FALLBACK, for an animation this module never saw pause. Derived
        // from the element's own mount stamp where it has one, so a per-glyph
        // stagger in `animation-delay` survives — see phaseFor.
        try { a.currentTime = phaseFor(t, d, now, stamp) } catch (_) { /* not seekable */ }
    }
}

/**
 * The batched form, and the one the scroll path should use.
 *
 * `getAnimations()` flushes pending style, so interleaving re-anchor and
 * class-removal per element would flush once per element on a fling. Doing
 * every re-anchor first and every release second costs one flush for the whole
 * batch, however many rows crossed the boundary in that frame.
 *
 * @param {Iterable<Element>} els
 * @param {(el: Element) => void} release — drops whatever pauses the element
 */
export function resumeInPhase(els, release) {
    regateInPhase({ resume: els }, { onResume: release })
}
