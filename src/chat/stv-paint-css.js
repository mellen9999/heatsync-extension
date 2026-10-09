// Module-resolution shim — NOT a synced file, NOT part of the shipped bundle.
//
// paint-spec.js is copied verbatim from the site's client/utils/ into this
// repo's flat src/lib/, byte-identical including its own `import { stvShadowList }
// from '../chat/stv-paint-css.js'` — a path that only resolves on the site.
// build.js's stripExports drops that import line (the concatenated scope gets
// stv-paint-css.js ahead of paint-spec.js), so production never touches this
// file. A test importing src/lib/paint-spec.js as a real ES module needs the
// path to resolve; this re-export is where it lands.
export * from '../lib/stv-paint-css.js'
