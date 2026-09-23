// Module-resolution shim — NOT a synced file, NOT part of the shipped bundle.
//
// fill-layers.js is copied verbatim from the site's client/cosmetics/ into
// this repo's flat src/lib/ (scripts/sync-paint-compiler.sh), byte-identical
// including its own `import { FILL_LAYER_CLASS, FILL_WRAP_CLASS } from
// '../utils/paint-spec.js'` — a path that only resolves on the site, where
// cosmetics/ and utils/ are siblings. build.js's stripExports drops that
// import line entirely before the real bundle ever sees it (the concatenated
// scope gets both consts from paint-spec.js directly), so production never
// touches this file.
//
// A test that imports src/lib/fill-layers.js as a real ES module (rather than
// through the bundle) still needs that path to resolve, though — this is
// where it lands. Just a re-export; the one real copy stays in src/lib.
export * from '../lib/paint-spec.js'
