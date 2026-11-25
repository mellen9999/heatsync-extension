// A site module embedded in the multichat bundle, in a scope of its own.
//
// The bundle concatenates every file into ONE scope, which works for files written for it and
// not for a site module copied byte for byte: client/cosmetics/animated-texture.js has top-level
// names (frameNow, build, layout, ready...) that already mean something else in that scope
// (animation-phase.js declares its own frameNow), and a second `function frameNow` in one scope
// is a SyntaxError that takes the whole bundle with it. So the copy stays untouched and is
// wrapped in a function whose parameters are the module's imports and whose return value is
// its exports — the same shape ESM gave it on the site.
//
//   scopeSiteModule(src, 'hsSpriteTexture', { logger: 'hsSpriteLogger' })
//     → const hsSpriteTexture = ((logger) => { …module… return { spriteFor, … } })(hsSpriteLogger)
//
// Shared by build.js and the tests, so a test runs the exact text the bundle ships.

const EXPORT_RE = /^export\s+(?:async\s+function|function|const|let|class)\s+(\w+)/gm

export function scopeSiteModule(src, name, imports = {}) {
  const exported = [...src.matchAll(EXPORT_RE)].map((m) => m[1])
  if (!exported.length) throw new Error(`scopeSiteModule: ${name} exports nothing`)
  const body = src
    .replace(/^import\s*\{[\s\S]*?\}\s*from\s*['"]\.\.?\/[^'"]+['"];?\s*$/gm, '')
    .replace(/^export\s+(async\s+function|function|const|let|class)\s+/gm, '$1 ')
  if (/^(?:import|export)\s/m.test(body)) throw new Error(`scopeSiteModule: ${name} has module syntax this does not strip`)
  return `const ${name} = ((${Object.keys(imports).join(', ')}) => {\n${body}\nreturn { ${exported.join(', ')} }\n})(${Object.values(imports).join(', ')})\n`
}
