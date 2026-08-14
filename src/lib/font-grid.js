/**
 * font-grid.js — which sizes a font actually has.
 *
 * MIRROR of client/utils/font-grid.js in the heatsync site repo. Separate repos
 * cannot share a module, so this file is duplicated on purpose; keep the table
 * and the snap semantics identical in both, or the same account gets different
 * sizes in the extension and on the site.
 *
 * A bitmap face is a grid of cells. Rendered at a size it does not have it is
 * not a smaller font — it is a resampled one, and it smears. CozetteVector is a
 * 6x13 cell: unitsPerEm 2048, advance of `A` = 945 units (→ exactly 6.0px at
 * 13px), ascender 1575 + descender 473 = 2048 (→ exactly 13px). So its only
 * crisp sizes are the integer multiples of 13.
 *
 *   A font declares the sizes it has. The size control offers those and
 *   nothing else. Vector faces declare "any".
 *
 * Before this the extension's size control was a continuous range 10–26, which
 * for CozetteVector is one legal size and fifteen smears.
 */

/** family → native sizes, ascending. Absent = vector face, any size is fine. */
export const FONT_GRID = {
  CozetteVector: [13, 26, 39],
}

/** Sizes unique to vector faces — the in-between sizes no bitmap cell can hit. */
const VECTOR_ONLY = [10, 11, 12, 14, 16, 18, 20, 22]

/**
 * Sizes offered for a face with no grid of its own. DERIVED as the union with
 * every bitmap size, never hand-listed: a vector face renders anything and must
 * not offer FEWER sizes than a bitmap one, or switching family destroys a size
 * choice the new family could have held.
 */
export const VECTOR_SIZES = [...new Set([...VECTOR_ONLY, ...Object.values(FONT_GRID).flat()])].sort((a, b) => a - b)

/** Every size any family may legally hold — the static union, for validation. */
export const ALL_SIZES = [...new Set([...VECTOR_SIZES, ...Object.values(FONT_GRID).flat()])].sort((a, b) => a - b)

/** True when the family renders from a fixed cell and therefore has a grid. */
export function isBitmapFamily(family) {
  return Object.hasOwn(FONT_GRID, family)
}

/**
 * The sizes this family may legally be set to. Never empty.
 * An empty/unknown family is treated as CozetteVector, matching resolveFontStack's
 * fall-through — otherwise the default install would get the vector list.
 */
export function sizesFor(family) {
  if (!family) return FONT_GRID.CozetteVector
  return FONT_GRID[family] || VECTOR_SIZES
}

/**
 * Nearest legal size for a family. Ties resolve DOWN — a user who lands between
 * 13 and 26 is far likelier to have wanted "small and readable" than to have
 * their chat double in size without asking.
 */
export function snapSize(family, px) {
  const sizes = sizesFor(family)
  const n = parseInt(px, 10)
  if (!Number.isFinite(n)) return sizes[0]
  if (sizes.includes(n)) return n
  return sizes.reduce((best, s) => (Math.abs(s - n) < Math.abs(best - n) ? s : best), sizes[0])
}

/** The size a family should start at when it is freshly selected. */
export function nativeSize(family) {
  return sizesFor(family)[0]
}
