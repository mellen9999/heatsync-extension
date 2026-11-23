// multichat's `log` is bootstrap.js's `if (MC_DEBUG) console.log(...)`, MC_DEBUG a const false: a release
// build never runs it, so its calls and the strings they carry are dead weight. esbuild's `pure`
// only reaches names that are not bound in the file, so the two definitions are renamed away first
// (bootstrap's, and utils.js's runtime-toggled one it shadows in this scope; no other bundle is touched)
// and `log` becomes the unbound name `pure` drops. a use that is not a call would then throw at runtime,
// so after the minify the name is bound again to an empty function, for the few calls whose result is
// used (`.catch((e) => log(...))`) and `typeof log`. dropped: the calls nothing reads. pinned by
// tests/debug-log-is-dropped.test.js.
export function unbindDebugLog(src) {
  let n = 0
  const out = src.replace(/function log\(\.\.\.args\) \{\n {2}if \((?:MC_)?DEBUG\)/g, (m) => {
    n++
    return m.replace('function log(', 'function __hsDebugLog(')
  })
  if (n !== 2) throw new Error(`build: expected the 2 debug log definitions in multichat-core.js, found ${n}`)
  return out
}

/** The minified bundle's IIFE opens with `log` bound to nothing, as MC_DEBUG=false always had it. */
export function rebindDebugLog(code) {
  const out = code.replace(/^("use strict";\(\(\)=>\{)/, '$1function log(){}')
  if (out === code) throw new Error('build: multichat-core.js does not open with the iife the debug log is rebound in')
  return out
}
