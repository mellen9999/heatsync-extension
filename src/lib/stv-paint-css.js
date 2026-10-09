/**
 * A 7TV paint → the inline CSS that draws it, exactly the way 7TV's own
 * extension does (SevenTV/Extension src/composable/useCosmetics.ts +
 * src/assets/style/global.scss), so a name looks the same in heatsync as in
 * 7TV's chat.
 *
 * Measured against the whole live catalogue (1043 paints, 2026-10-09): every
 * paint is ONE layer — a linear gradient, a radial gradient or an image — with
 * up to 10 drop-shadows. 7TV animates nothing in CSS; a moving paint is an
 * animated webp under url(). What had drifted from 7TV's output:
 *   - `repeat` was dropped, so 302 paints drew one smooth fade where 7TV draws
 *     repeating-linear/radial-gradient stripes and rings
 *   - stops were rounded to whole percents, smearing 247 hard-stop paints
 *   - image paints were `cover`-cropped; 7TV stretches them `100% 100%`
 *   - no `background-color:currentColor` under the clip, so a stop range that
 *     does not cover the name (or a paint with no stops) lost the chatter's own
 *     colour, and a stop-less paint lost its shadows with it
 *
 * Pure and import-free: the extension ships this file byte for byte
 * (src/lib/stv-paint-css.js, scripts/sync-paint-compiler.sh), pinned by
 * tests/client/ext-paint-compiler-parity.test.js. It is concatenated into one
 * shared scope there, so every top-level name starts with stv.
 */

// every real image paint lives here; anything else never reaches url()
const STV_PAINT_IMG = /^https:\/\/cdn\.7tv\.app\/paint\/[\w/.-]+$/

/** 7TV packs RGBA into a signed int32: (r<<24)|(g<<16)|(b<<8)|a. */
export function stvRgba(n) {
  const v = Number(n) | 0
  return `rgba(${(v >>> 24) & 255}, ${(v >>> 16) & 255}, ${(v >>> 8) & 255}, ${((v & 255) / 255).toFixed(3)})`
}

const stvNum = v => (Number.isFinite(Number(v)) ? Number(v) : 0)
// 7TV's own arithmetic, float noise included (0.07*100 is 7.000000000000001 —
// valid CSS, and the same string 7TV emits)
const stvPct = at => `${stvNum(at) * 100}%`

function stvGradient(paint, fn) {
  const stops = Array.isArray(paint.stops) ? paint.stops : []
  if (!stops.length) return ''
  const head = fn === 'linear' ? `${stvNum(paint.angle)}deg` : (paint.shape === 'ellipse' ? 'ellipse' : 'circle')
  const body = stops.map(s => `${stvRgba(s?.color)} ${stvPct(s?.at)}`).join(', ')
  return `${paint.repeat ? 'repeating-' : ''}${fn}-gradient(${head}, ${body})`
}

/**
 * @param {object|null|undefined} paint a v3 paint: {function, angle, shape,
 *   repeat, stops[{at,color}], image_url, color, shadows[{x_offset,y_offset,radius,color}]}
 * @returns {{style: string, still: string|null}} `style` is '' when there is
 *   nothing to draw; `still` is the first frame of an animated image paint
 *   (7TV publishes `1x_static.webp` beside `1x.webp`), for surfaces that
 *   cannot afford to decode every animation at once.
 */
export function stvPaintCss(paint) {
  const fn = String(paint?.function || '').toLowerCase().replace('_', '-')
  let image = ''
  let still = null
  if (fn === 'linear-gradient' || fn === 'radial-gradient') {
    image = stvGradient(paint, fn.slice(0, fn.indexOf('-')))
  } else if (fn === 'url') {
    const url = String(paint.image_url || '')
    if (STV_PAINT_IMG.test(url)) {
      image = `url("${url}")`
      if (url.endsWith('/1x.webp')) still = `${url.slice(0, -'1x.webp'.length)}1x_static.webp`
    }
  } else {
    return { style: paint?.color ? `color:${stvRgba(paint.color)}` : '', still: null }
  }
  const shadows = (Array.isArray(paint.shadows) ? paint.shadows : [])
    .map(s => `drop-shadow(${stvNum(s?.x_offset)}px ${stvNum(s?.y_offset)}px ${stvNum(s?.radius)}px ${stvRgba(s?.color)})`)
  // nothing to paint at all — leave the name as it is
  if (!image && !shadows.length) return { style: '', still: null }
  let style = image ? `background-image:${image};` : ''
  style += 'background-color:currentColor;background-size:100% 100%;-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent'
  if (shadows.length) style += `;filter:${shadows.join(' ')}`
  return { style, still }
}
