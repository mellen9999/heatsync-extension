// The workflows run with the repo's secrets, so what they pull in is part of the supply chain.
//
//  - every third-party action is pinned to a full commit SHA (a tag can be moved under us), with the
//    tag it was resolved from in a trailing comment so a human can tell what the SHA is
//  - every job a notifier waits on exists, and the new jobs are actually wired to it
//  - the contract tests cannot skip in ci: no HS_PARITY_SKIP_OK in ci or the nightly, and the site
//    checkout fails loudly when its deploy key is missing

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const GH = join(ROOT, '.github')
const read = (rel) => readFileSync(join(GH, rel), 'utf8')
const yaml = (rel) => Bun.YAML.parse(read(rel))

const workflowFiles = readdirSync(join(GH, 'workflows')).filter((f) => /\.ya?ml$/.test(f))
const files = [...workflowFiles.map((f) => `workflows/${f}`), 'actions/site/action.yml']

/** every `uses:` line: { file, line, ref, comment } */
function usesLines() {
  const out = []
  for (const file of files) {
    read(file)
      .split('\n')
      .forEach((text, i) => {
        const m = /^\s*(?:-\s+)?uses:\s*(\S+)\s*(?:#\s*(.*))?$/.exec(text)
        if (m) out.push({ file, line: i + 1, ref: m[1], comment: (m[2] || '').trim() })
      })
  }
  return out
}

describe('workflow actions are pinned', () => {
  const uses = usesLines()

  test('the scan finds the actions at all', () => {
    expect(uses.length, 'no `uses:` lines found — the pattern stopped matching').toBeGreaterThan(5)
  })

  test('every third-party action is a full 40-hex sha with its tag in a comment', () => {
    for (const u of uses) {
      if (u.ref.startsWith('./')) continue // this repo's own composite action
      expect(u.ref, `${u.file}:${u.line} ${u.ref} is not pinned to a commit sha`).toMatch(
        /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/,
      )
      expect(u.comment, `${u.file}:${u.line} pins ${u.ref} without saying which tag it is`).toMatch(
        /^v\d+\.\d+(\.\d+)?$/,
      )
    }
  })

  test('the local composite action it points at exists', () => {
    for (const u of uses.filter((x) => x.ref.startsWith('./'))) {
      expect(() => read(`${u.ref.replace('./.github/', '')}/action.yml`), `${u.file}:${u.line} ${u.ref}`).not.toThrow()
    }
  })
})

describe('the notifiers wait on every job', () => {
  for (const file of ['workflows/ci.yml', 'workflows/nightly-heap.yml']) {
    test(`${file}: notify-failure needs every other job`, () => {
      const jobs = yaml(file).jobs
      const others = Object.keys(jobs).filter((j) => j !== 'notify-failure')
      const needs = [jobs['notify-failure'].needs].flat()
      expect(needs.sort(), 'a job the notifier does not wait on can fail without paging').toEqual(others.sort())
    })
  }

  test('ci and the nightly both audit dependencies and scan for secrets', () => {
    for (const file of ['workflows/ci.yml', 'workflows/nightly-heap.yml']) {
      const text = read(file)
      expect(text, file).toContain('bun audit --audit-level=high')
      expect(text, file).toMatch(/gitleaks\/gitleaks-action@[0-9a-f]{40}/)
    }
  })
})

describe('the contract tests cannot skip in ci', () => {
  test('neither ci nor the nightly sets HS_PARITY_SKIP_OK', () => {
    for (const file of ['workflows/ci.yml', 'workflows/nightly-heap.yml']) {
      expect(read(file), `${file} lets the contract tests skip`).not.toContain('HS_PARITY_SKIP_OK')
    }
  })

  test('both check the site repo out through the composite action, with the deploy key', () => {
    for (const file of ['workflows/ci.yml', 'workflows/nightly-heap.yml']) {
      expect(read(file), file).toMatch(
        /uses: \.\/\.github\/actions\/site\s+with:\s+ssh-key: \$\{\{ secrets\.SITE_DEPLOY_KEY \}\}/,
      )
    }
  })

  test('the composite action fails with a plain message when the key is missing, before it checks out', () => {
    const steps = yaml('actions/site/action.yml').runs.steps
    expect(steps[0].run).toContain('if [ -z "$SITE_DEPLOY_KEY" ]')
    expect(steps[0].run).toContain('exit 1')
    expect(steps[0].run).toContain('SITE_DEPLOY_KEY')
    expect(steps[1].uses).toMatch(/^actions\/checkout@[0-9a-f]{40}$/)
    expect(steps[1].with.repository).toBe('mellen9999/heatsync')
    expect(steps[1].with['ssh-key']).toBe('${{ inputs.ssh-key }}')
    expect(steps[1].with['persist-credentials']).toBe(false)
    expect(steps[2].run).toContain('HS_SITE_DIR=')
  })
})
