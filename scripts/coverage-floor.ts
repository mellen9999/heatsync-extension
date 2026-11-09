// Overall line + function coverage of `bun test --coverage --coverage-reporter=lcov`
// must not fall below the floor. bun's own coverageThreshold judges every file
// on its own, so one thin module fails it; the floor is the whole-suite number.
// Only files a test loads are counted — bundles eval'd by the rigs are not.
// Raise FLOOR when coverage rises; never lower it without a recorded reason.
import { readFileSync } from 'node:fs'

const FLOOR: Record<string, number> = { lines: 0.64, functions: 0.69 }
const file = process.argv[2] || 'coverage/lcov.info'

let lf = 0, lh = 0, fnf = 0, fnh = 0
for (const line of readFileSync(file, 'utf8').split('\n')) {
  const [k, v] = line.split(':')
  const n = Number(v)
  if (k === 'LF') lf += n
  else if (k === 'LH') lh += n
  else if (k === 'FNF') fnf += n
  else if (k === 'FNH') fnh += n
}
if (!lf || !fnf) {
  console.error(`coverage-floor: ${file} has no line or function records`)
  process.exit(1)
}
const got: Record<string, number> = { lines: lh / lf, functions: fnh / fnf }
let bad = false
for (const k of Object.keys(FLOOR)) {
  const pct = (got[k] * 100).toFixed(2)
  const floor = (FLOOR[k] * 100).toFixed(0)
  if (got[k] < FLOOR[k]) {
    console.error(`coverage-floor: ${k} ${pct}% is under the ${floor}% floor`)
    bad = true
  } else console.log(`coverage-floor: ${k} ${pct}% (floor ${floor}%)`)
}
process.exit(bad ? 1 : 0)
