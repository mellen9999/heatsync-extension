// bun scripts/brand-parity/compare.mjs site.json ext.json — fails on any difference not declared below.
import { readFileSync } from 'node:fs'
const [a, b] = process.argv.slice(2).map((p) => JSON.parse(readFileSync(p, 'utf8')))
// declared overrides: { 'row-kind.prop': 'why' } — ONE named reason each, nothing else may differ
const DECLARED = {
  // 'plain.height': 'e.g. native twitch column',
}
// row types one surface genuinely cannot produce in its harness, each with ONE reason
const ABSENT = {
  'notice-yt-superchat': 'youtube chat needs the youtube transport, not mockable here (fx-superchat covers the css)',
  'event-hype': 'hype events are off by default in the extension',
}
const skip = new Set(['height']) // height follows content (a label's wrap, a badge) — padding + line-height pin the box; reported, not gated
let bad = 0, rows = 0
const kinds = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
console.log(`${'row type'.padEnd(20)} ${'site/ext'.padEnd(9)} differences`)
for (const k of kinds) {
  if (!a[k] || !b[k]) {
    const why = ABSENT[k]
    console.log(`${k.padEnd(20)} ${a[k] ? 'site only' : 'ext only'}${why ? ` (declared: ${why})` : ' — UNDECLARED'}`)
    if (!why) bad++
    continue
  }
  rows++
  const diffs = []
  for (const p of Object.keys(a[k])) {
    if (JSON.stringify(a[k][p]) === JSON.stringify(b[k][p])) continue
    if (DECLARED[`${k}.${p}`]) continue
    diffs.push(`${p}: ${a[k][p]} ≠ ${b[k][p]}${skip.has(p) ? ' (not gated)' : ''}`)
    if (!skip.has(p)) bad++
  }
  console.log(`${k.padEnd(20)} ${(diffs.length ? 'DIFF' : 'same').padEnd(9)} ${diffs.join(' | ')}`)
}
console.log(`\n${rows} row types compared, ${bad} gated differences`)
process.exit(bad ? 1 : 0)
