// emote-rungs.js is concatenated into the multichat bundle, so emotes.js calls its
// helpers as free names. A test that imports emotes.js as a module imports this
// first, and gets them the way the bundle does: as globals.
import * as rungs from './emote-rungs-src.js'

Object.assign(globalThis, rungs)
