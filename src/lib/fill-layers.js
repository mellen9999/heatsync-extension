/**
 * Fill layers — the runtime half of the composited fill.
 *
 * The compiler (utils/paint-spec.js) emits every rule a moving fill needs, all
 * of it gated behind the mask class on the name box. This module is what earns
 * a name that class: it finds a letterform to cut the fill with, stamps the
 * geometry the rules read, and appends the empty `<i>` boxes the gradient
 * actually moves in.
 *
 * Dependency-free on purpose — the masker and the class names are handed in —
 * so the extension can take this file verbatim.
 *
 * ── WHY REAL ELEMENTS, APPENDED HERE ─────────────────────────────────────────
 *
 * A pseudo-element's animation recalculates its owner's style every frame
 * (1100ms against 2.1ms for the same rules on an `<i>`, paint-perf --masked),
 * so the moving boxes are real children. They are appended by the runtime and
 * never by paintNameHtml, because copy, find-in-page, SSR and the pre-built
 * mention markup all rest on that markup being exactly the name's text. The
 * boxes carry no text and are `aria-hidden`, so none of that sees them.
 *
 * ── WHY THE GEOMETRY IS STAMPED ─────────────────────────────────────────────
 *
 * A gradient at an angle is the length of the name's projection onto that
 * angle, and a rotated strip that has to cover the name needs its width AND
 * height. The rules read `--nw`/`--nh` for that, and a split name's glyphs
 * read `--gx`, their offset into the name, so every letter shows its slice of
 * ONE gradient instead of a private copy each. All three come from the masker,
 * which measured the text to rasterise it anyway — nothing here reads layout.
 *
 * @module cosmetics/fill-layers
 */

/** Class every mounted fill box wears, and its per-box index suffix. */
export const FILL_LAYER_CLASS = 'hs-fl'
/** The box that holds the layer boxes and carries the letterform mask — and,
 *  when the fill is modulated (hue / breathe), the filter or opacity too.
 *
 *  The mask lives HERE, not on the name, because everything a name draws
 *  OUTSIDE its letterform lives on the name: a glow's text-shadow, a scene's
 *  rim drop-shadow, neon's breathing halo. A mask on the name box cuts all of
 *  them away; a mask on a child cuts only the fill it holds. */
export const FILL_WRAP_CLASS = 'hs-fw'

function box(doc, cls) {
  const i = doc.createElement('i')
  i.className = cls
  i.setAttribute('aria-hidden', 'true')
  return i
}

/** The masked container with `layers` boxes inside, one append. */
function layerStack(doc, plan, maskCls) {
  const wrap = box(doc, `${FILL_WRAP_CLASS} ${maskCls}`)
  for (let k = 0; k < plan.layers; k++) wrap.appendChild(box(doc, `${FILL_LAYER_CLASS} ${FILL_LAYER_CLASS}${k}`))
  return wrap
}

/** Remove a previous mount — a remount after webfonts land must not stack a
 *  second set of boxes under the first. */
export function unmountFillLayers(nameBox, maskedClass) {
  nameBox.classList.remove(maskedClass)
  for (const el of [...nameBox.querySelectorAll(`i.${FILL_LAYER_CLASS},i.${FILL_WRAP_CLASS}`)]) {
    // Only the top of each stack: removing the container takes its layers.
    if (!el.parentElement?.classList?.contains(FILL_WRAP_CLASS)) el.remove()
  }
}

/**
 * Mount a composited fill on one painted name.
 *
 * All or nothing. A glyph the masker refuses, a name it cannot measure, a
 * browser without mask-image — any of them leaves the name exactly as the
 * compiler's clip-text rest frame paints it, never half-masked: one unmasked
 * letter under a moving layer is a solid block of gradient.
 *
 * @param {Element} nameBox the `.hs-name` element
 * @param {{mode:'glyph'|'name', layers:number, legacy?:boolean}} plan from the compiler
 * @param {{maskedClass:string, font:string, h:number, dpr:number,
 *   maskFor:Function, maskForText:Function}} ctx
 * @returns {boolean} whether the name is now masked
 */
export function mountFillLayers(nameBox, plan, ctx) {
  if (!nameBox || !plan || !ctx) return false
  const { maskedClass, font, h, dpr } = ctx
  if (nameBox.classList.contains(maskedClass)) return true
  // A stale stack from an earlier mount (webfonts landed, a mask was evicted)
  // is cleared first, so a remount always starts from the compiler's markup.
  unmountFillLayers(nameBox, maskedClass)
  const doc = nameBox.ownerDocument

  if (plan.mode === 'glyph') {
    const spans = nameBox.querySelectorAll(':scope > span')
    if (!spans.length) return false
    const masks = []
    for (const s of spans) {
      const m = ctx.maskFor(s.textContent, font, h, dpr)
      if (!m) return false
      masks.push(m)
    }
    // Running advance: each glyph's offset into the name, so its layers can
    // shift into the one gradient that crosses the whole name.
    let gx = 0
    for (let i = 0; i < spans.length; i++) {
      const s = spans[i]
      s.style.setProperty('--gx', `${round(gx)}px`)
      gx += masks[i].w
      if (plan.legacy) {
        // The legacy paint-slot sweep: letterform on the span, one bare box.
        s.classList.add(masks[i].cls)
        s.appendChild(box(doc, `${FILL_LAYER_CLASS} ${FILL_LAYER_CLASS}0`))
      } else {
        s.appendChild(layerStack(doc, plan, masks[i].cls))
      }
    }
    nameBox.style.setProperty('--nw', `${round(gx)}px`)
    nameBox.style.setProperty('--nh', `${round(h)}px`)
  } else {
    const m = ctx.maskForText(nameBox.textContent, font, h, dpr)
    if (!m) return false
    nameBox.style.setProperty('--nw', `${round(m.w)}px`)
    nameBox.style.setProperty('--nh', `${round(h)}px`)
    nameBox.appendChild(layerStack(doc, plan, m.cls))
  }
  nameBox.classList.add(maskedClass)
  return true
}

const round = (n) => Math.round(n * 1000) / 1000
