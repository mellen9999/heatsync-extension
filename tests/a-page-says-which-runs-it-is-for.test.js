/**
 * Two questions every job that rings the owner's phone has to answer, and this
 * repo has got each of them wrong once.
 *
 *   1. Does a HANG page?  A job killed by its own `timeout-minutes` concludes
 *      `cancelled`, not `failure`, so a notifier gated on `if: failure()` is
 *      SKIPPED. nightly-heap run 38505736893 (2026-10-13) burned 15m23s
 *      against a 15-minute ceiling and told nobody; the run that failed fast
 *      an hour earlier paged fine. The rail was blind to the expensive half,
 *      and `cancelled` reads like a human did it.
 *
 *   2. Does a HAND DISPATCH page?  It must not. A workflow_dispatch is a
 *      person at a terminal asking a question, already reading the answer, and
 *      a red is their experiment's RESULT. On 2026-10-14 nightly-heap spooled
 *      five pages between 04:11 and 04:36 — five A/B iterations of one
 *      investigation on `claude/yt-hang`, nothing in the extension changed,
 *      and the fifth arrived while a responder worked the first. ci.yml has
 *      carried the right guard (`github.ref == 'refs/heads/main'`) since it
 *      was written; nightly-heap shipped without one.
 *
 * Both answers live in one `if:` on the job, which is the only gate that
 * survives its own job being killed — a step-level `if:` never runs then. So
 * this asserts on that expression, generic over the workflow dir, because the
 * cost of forgetting is paid by the owner's phone and nothing else fails.
 *
 * Source-text invariants (same shape as release-workflow-invariants).
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const WF = new URL('../.github/workflows/', import.meta.url).pathname
const files = readdirSync(WF).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))

/** job blocks, split on the two-space keys under `jobs:` */
function jobs(text) {
  const out = []
  const lines = text.split('\n')
  let name = null
  let buf = []
  for (const l of lines) {
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(l)
    if (m) {
      if (name) out.push({ name, body: buf.join('\n') })
      name = m[1]
      buf = []
    } else if (name) buf.push(l)
  }
  if (name) out.push({ name, body: buf.join('\n') })
  return out
}

/** the job-level `if:` — four-space indent, directly under the job key */
function gate(body) {
  const m = /^ {4}if:\s*(.+)$/m.exec(body)
  return m ? m[1].trim() : ''
}

const pagers = []
for (const f of files) {
  const text = readFileSync(join(WF, f), 'utf8')
  const triggers = /^on:\n([\s\S]*?)(?=^\S)/m.exec(text)?.[1] ?? ''
  for (const j of jobs(text)) {
    if (!j.body.includes('intake/ci')) continue
    pagers.push({ file: f, job: j.name, gate: gate(j.body), triggers })
  }
}

describe('a job that pages says which runs it is for', () => {
  test('the paging jobs are found at all', () => {
    expect(
      pagers.length,
      'no job posting to intake/ci — either the notifiers moved or this test stopped finding them. Move it with them; nothing else asserts a diagnostic run stays off the pager.',
    ).toBeGreaterThan(0)
  })

  test('each one carries a job-level gate', () => {
    for (const p of pagers) {
      expect(
        p.gate,
        `${p.file} > ${p.job} has no job-level \`if:\`. A step-level one never runs when the job itself is killed, so it cannot decide anything about a hang.`,
      ).not.toBe('')
    }
  })

  test('a hang pages, or the job says in so many words that it should not', () => {
    for (const p of pagers) {
      if (!/\bfailure\(\)/.test(p.gate)) continue
      expect(
        /\bcancelled\(\)/.test(p.gate),
        `${p.file} > ${p.job} gate is \`${p.gate}\` — it asks about failure() but never about cancelled(). A job killed by its own timeout-minutes concludes \`cancelled\`, so this notifier is SKIPPED and a HANG pages nobody (run 38505736893, 15m23s, silent). Say which you mean: \`failure() || cancelled()\` to page on a hang, or \`!cancelled() && ...\` to be deliberately quiet on a torn-down run.`,
      ).toBe(true)
    }
  })

  test('a hand dispatch does not page', () => {
    for (const p of pagers) {
      if (!p.triggers.includes('workflow_dispatch')) continue
      expect(
        /github\.event_name/.test(p.gate) || /github\.ref\b/.test(p.gate),
        `${p.file} > ${p.job} gate is \`${p.gate}\` — it never asks what triggered the run, so a hand dispatch on a throwaway branch pages the owner exactly like the cron. Five such pages landed in thirty minutes on 2026-10-14 and not one was the extension. Add \`github.event_name == 'schedule'\` for a nightly, or ci.yml's \`github.ref == 'refs/heads/main'\`.`,
      ).toBe(true)
    }
  })

  test('a scheduled workflow pages for the schedule only', () => {
    const nightlies = pagers.filter((p) => p.triggers.includes('schedule') && p.triggers.includes('workflow_dispatch'))
    expect(
      nightlies.length,
      'no workflow is both scheduled and hand-dispatchable — check the trigger keys were not renamed before trusting this',
    ).toBeGreaterThan(0)
    for (const p of nightlies) {
      expect(
        /github\.event_name\s*==\s*'schedule'/.test(p.gate),
        `${p.file} > ${p.job} gate is \`${p.gate}\`. Its only triggers are a cron and a hand dispatch, so the cron IS the run worth paging about and the dispatch is always somebody's experiment.`,
      ).toBe(true)
    }
  })
})
