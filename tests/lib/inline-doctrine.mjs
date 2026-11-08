// The house style for css that lives inside js/ts: template strings,
// style="…" markup, el.style.x = …, and style objects. The stylesheet guards
// (tests/unit/visual-doctrine.test.ts) never see these, and that split is how
// a removed radius or glow keeps shipping from a component.

/** Somebody's art, not our chrome: paints, scenes and 7tv cosmetics are the format. */
export const ART_FILES = new Set([
  'client/utils/paint-spec.js',
  'client/utils/scene-spec.js',
  'client/utils/paint-authoring.js',
  'client/utils/paint-core.js',
  'client/utils/paint-motion-css.js',
  'client/utils/paint-shuffle.js',
  'client/chat/paint-cosmetics.js',
  'client/chat/seventv-cosmetics.js',
  'client/chat/stv-paint-css.js',
  'client/names/card-name-paint.js',
  'client/cosmetics/glyph-mask.js',
  'client/settings/sections/paint.js',
  'client/settings/sections/paint-fill-editor.js',
  'client/settings/sections/paint-stv-import.js',
  'client/settings/color-field.js',
  'server/routes/paint.ts',
])

const Q = `[\`'"]?\\s*`
const RULES = [
  // square: 0, the shared token, or a 50% status dot
  ['rounded corner', new RegExp(`border-?radius\\s*[:=]\\s*${Q}(?!0(?![.\\d])|50%|var\\(--border-radius\\))[\\d.]`, 'gi')],
  // flat: a shadow may only be a hard 0-offset ring (border emulation), never a blur
  ['blurred shadow', new RegExp(`(?:box|text)-?shadow\\s*[:=]\\s*${Q}(?!none|inherit|initial|unset|var\\()(?:inset\\s+)?(?![-\\d.]+(?:px)?\\s+[-\\d.]+(?:px)?\\s+0(?:px)?[\\s,;'"\`]|0\\s+0\\s+0\\s)[-\\d.]`, 'gi')],
  ['gradient', /\b(?:repeating-)?(?:linear|radial|conic)-gradient\(/g],
  ['glassmorphism', /backdrop-?filter\s*[:=]\s*[`'"]?\s*(?!none)\w/gi],
  ['blur filter', /\bfilter\s*[:=]\s*[`'"]?[^;`'"\n]*\bblur\(\s*[\d.]+\s*(?:px|em|rem)/gi],
]

/** A line that renders somebody's paint inside chrome code carries this
 *  comment, so the exemption is one line, never a whole file. */
export const ART_LINE = 'doctrine: paint art'

/** `text` is comment-stripped (line numbers kept); `raw` is the source, read
 *  only for ART_LINE markers. Returns `line: rule` strings. */
export function inlineDoctrineOffenders(text, raw = '') {
  const rawLines = raw.split('\n')
  const out = []
  for (const [name, re] of RULES) {
    for (const m of text.matchAll(re)) {
      const line = text.slice(0, m.index).split('\n').length
      if (rawLines[line - 1]?.includes(ART_LINE)) continue
      out.push(`${line}: ${name} — ${m[0].trim().slice(0, 60)}`)
    }
  }
  return out
}
