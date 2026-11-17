/**
 * Real-site end-to-end hunt. Loads the built extension (dist/chrome, or E2E_EXT) into
 * chromium against live twitch, kick and youtube and runs scenarios built from the bug
 * classes that have shipped. Read-only on the platforms: no login, no sends.
 *
 *   bun run build.js chrome            # a plain (non-minified) build keeps the debug probes
 *   bun scripts/e2e/run.ts             # every scenario (s8 runs an hour: E2E_S8_MIN)
 *   bun scripts/e2e/run.ts --only s2   # one family: s2-twitch, s2-youtube, s2-kick
 *
 * Exit 1 on any finding. Artifacts (report.json, screenshots) go to E2E_OUT.
 */
import { findings, OUT, passes, writeReport } from './lib'
import { s1Tabs } from './s1-tabs'
import { s2Kick, s2Twitch, s2Youtube } from './s2-spa'
import { s3Sw } from './s3-sw'
import { s4Caps } from './s4-caps'
import { s5Outage } from './s5-outage'
import { s6Settings } from './s6-settings'
import { s7Host } from './s7-host'
import { s8Soak } from './s8-soak'
import { s9Firefox } from './s9-firefox'
import { s10Merged } from './s10-merged'
import { s11FirefoxTabs } from './s11-firefox-tabs'
import { s12Popout } from './s12-popout'

const SCENARIOS: [string, () => Promise<unknown>][] = [
  ['s1-tabs', s1Tabs],
  ['s2-twitch', s2Twitch],
  ['s2-youtube', s2Youtube],
  ['s2-kick', s2Kick],
  ['s3-sw', s3Sw],
  ['s4-caps', s4Caps],
  ['s5-outage', s5Outage],
  ['s6-settings', s6Settings],
  ['s7-host', s7Host],
  ['s8-soak', s8Soak],
  ['s9-firefox', s9Firefox],
  ['s10-merged', s10Merged],
  ['s11-firefox-tabs', s11FirefoxTabs],
  ['s12-popout', s12Popout],
]

const args = process.argv.slice(2)
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : ''
// a family by its number: s2 is s2-twitch, s2-youtube and s2-kick; s1 is s1-tabs, never s10 or s11
const picked = SCENARIOS.filter(([id]) => !only || only.split(',').some((o) => id === o || id.startsWith(`${o}-`)))
if (!picked.length) {
  console.error(`no scenario matches "${only}" — have: ${SCENARIOS.map(([id]) => id).join(', ')}`)
  process.exit(2)
}

const ceiling = setTimeout(
  () => {
    console.error('✗ e2e run exceeded its ceiling — aborting')
    writeReport({ aborted: true })
    process.exit(1)
  },
  Number(process.env.E2E_CEILING_MIN || 120) * 60_000,
)

for (const [id, run] of picked) {
  try {
    await run()
  } catch (e) {
    findings.push({ scenario: id, what: `scenario crashed: ${String((e as Error)?.message || e).slice(0, 300)}` })
    console.log(`  ✗ ${id} crashed: ${String((e as Error)?.message || e).slice(0, 300)}`)
  }
}
clearTimeout(ceiling)
writeReport()
console.log(
  `\n${findings.length ? '✗' : '✓'} e2e: ${passes.length} checks passed, ${findings.length} findings — ${OUT}`,
)
for (const f of findings) console.log(`  ✗ [${f.scenario}] ${f.what}`)
process.exit(findings.length ? 1 : 0)
