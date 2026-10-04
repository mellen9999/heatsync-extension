/**
 * font-grid.js — which sizes a font actually has.
 *
 * SHARED CONTRACT with client/utils/font-grid.js in the site repo — NOT a byte
 * mirror, and it must not become one. Both sides ship no bitmap face any more
 * (system monospace everywhere), so both tables are empty and every face is a
 * vector face that renders any size. The module stays because the size control
 * and the contract are built on it, and a bitmap face may come back.
 *
 * What must never drift is what has to be true for a person using both:
 *   - every face BOTH sides list declares the SAME sizes;
 *   - snapSize/nativeSize/isBitmapFamily resolve the same for those faces;
 *   - VECTOR_SIZES stays DERIVED from the table, never hand-listed.
 * tests/paint-compiler-parity.test.js enforces exactly that and deliberately
 * nothing more; the byte-mirrored files are listed there separately and are
 * synced by scripts/sync-paint-compiler.sh.
 *
 * ALL_SIZES is this side's alone — the settings schema validates against a
 * static union with no access to the current family.
 *
 *   A font declares the sizes it has. The size control offers those and
 *   nothing else. Vector faces declare "any".
 */

/** family → native sizes, ascending. Absent = vector face, any size is fine. */
export const FONT_GRID = {}

/** Sizes unique to vector faces — the in-between sizes no bitmap cell can hit. */
const VECTOR_ONLY = [10, 11, 12, 13, 14, 15, 16, 18, 20, 22]

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

/** The sizes this family may legally be set to. Never empty. */
export function sizesFor(family) {
  return FONT_GRID[family] || VECTOR_SIZES
}

/**
 * Nearest legal size for a family. Ties resolve DOWN — a user who lands between
 * two sizes is far likelier to have wanted "small and readable" than to have
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
