/**
 * The release pipeline's ordering is load-bearing, and getting it wrong is
 * silent.
 *
 * Every self-dist firefox install polls
 * releases/latest/download/updates.json, and that alias resolves to the newest
 * NON-prerelease release. So a release promoted to Latest before its firefox
 * assets exist either blinds every install (no updates.json → 404 → no update
 * info at all) or points them at a download that 404s (updates.json without the
 * xpi). Neither surfaces anywhere a human would look.
 *
 * v1.7.62 is why the create step moved first: signing failed on a mozilla 503,
 * `gh release create` ran last and never ran at all, and the chrome zip, source
 * zip and checksums — none of which touch AMO — were thrown away with it.
 *
 * Source-text invariants (the same shape as tests/automod-backfill-wiring).
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const YML = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
const FINISH = readFileSync(new URL('../.github/workflows/release-finish.yml', import.meta.url), 'utf8')

const at = (needle) => {
  const i = YML.indexOf(needle)
  expect(i, `missing from release.yml: ${needle}`).toBeGreaterThan(-1)
  return i
}

describe('the release survives an AMO outage', () => {
  test('the release is created before anything touches mozilla', () => {
    // Anchor on the command, not the word: the step's comment explains the
    // v1.7.62 failure and mentions `gh release create` well above the call.
    expect(at('gh release create "$TAG"')).toBeLessThan(at('web-ext@10.4.0 sign'))
  })

  test('it is created as a prerelease', () => {
    // `latest` skips prereleases, which is the entire protection: an unfinished
    // release cannot displace the one currently serving updates.
    expect(YML).toMatch(/gh release create "\$TAG".*--prerelease/s)
  })

  test('the AMO-independent assets ride with the create, not the promote', () => {
    const create = YML.slice(at('assets=('), at('gh release create "$TAG"'))
    // Regexes, not strings: the ${VERSION} here is shell, and a literal one
    // inside a JS string trips lint/suspicious/noTemplateCurlyInString.
    for (const a of [/heatsync-chrome-\$\{VERSION\}\.zip/, /heatsync-source-\$\{VERSION\}\.zip/, /checksums\.txt/]) {
      expect(create).toMatch(a)
    }
    // These two are the only assets allowed to depend on mozilla.
    expect(create).not.toContain('heatsync-firefox.xpi')
    expect(create).not.toContain('updates.json')
  })

  test('re-running for an existing tag tops assets up instead of exploding', () => {
    // The finisher re-dispatches this workflow for a tag whose release exists.
    expect(YML).toContain('gh release view "$TAG"')
    expect(YML).toMatch(/gh release upload "\$TAG".*--clobber/)
  })
})

describe('the update channel is never pointed at a missing file', () => {
  test('updates.json and the xpi are uploaded in one command', () => {
    const line = YML.split('\n').find((l) => l.includes('gh release upload') && l.includes('updates.json'))
    expect(line, 'updates.json is uploaded without the xpi beside it').toBeTruthy()
    expect(line).toContain('heatsync-firefox.xpi')
  })

  test('promotion to latest happens only after that upload', () => {
    const upload = YML.indexOf('gh release upload "$TAG" dist/heatsync-firefox.xpi')
    expect(upload).toBeGreaterThan(-1)
    expect(upload).toBeLessThan(at('--prerelease=false --latest'))
  })

  test('a failed signing still fails the job', () => {
    // The prerelease stands, but the run must go red — a stranded release that
    // reports success is how this stops getting noticed.
    expect(YML).toMatch(/::error::no signed xpi produced[\s\S]{0,200}exit 1/)
  })
})

describe('waiting on AMO', () => {
  test('health is read from AMO own heartbeat', () => {
    // The addon read API returned 200 while signing was dead, and the upload
    // endpoint answered 401 while validation was dead. Both cost a CI run.
    expect(YML).toContain('addons.mozilla.org/__heartbeat__')
    expect(FINISH).toContain('addons.mozilla.org/__heartbeat__')
  })

  test('signing retries rather than dying on one 503', () => {
    expect(YML).toMatch(/for attempt in 1 2 3/)
  })

  test('the job stays capped in minutes, not hours', () => {
    // v1.7.59 and v1.7.60 each burned github's 6h default and shipped nothing.
    const m = YML.match(/timeout-minutes:\s*(\d+)/)
    expect(m).toBeTruthy()
    expect(Number(m[1])).toBeLessThanOrEqual(60)
  })
})

describe('the finisher', () => {
  test('only ever picks up prereleases that are missing the xpi', () => {
    expect(FINISH).toContain('select(.prerelease)')
    expect(FINISH).toContain('index("heatsync-firefox.xpi") | not')
  })

  test('says what it is leaving behind', () => {
    // Silent skipping reads as "nothing to do" — the opposite of the truth.
    expect(FINISH).toMatch(/leaving stranded for now/)
  })
})
