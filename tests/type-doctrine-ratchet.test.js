import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Readable text is ≥13px, emphasis is bold (700) not a mid weight, copy is
// lowercase. Counts only fall: lower a cap when you fix one, never raise it.
// 2026-11-08: the last three (social.js thread status lines) went to 13px; every cap is 0.
const ROOT = join(import.meta.dir, '..')
const ART = new Set(['src/lib/paint-spec.js', 'src/lib/scene-spec.js', 'src/multichat/styles/20-card.css'])
const RULES = {
  'sub-13px text': [/font-size\s*:\s*(?:[0-9]|1[0-2])(?:\.\d+)?px|fontSize\s*=\s*'(?:[0-9]|1[0-2])px'/g, 0],
  'mid font weight': [/font-weight\s*:\s*(?:100|200|300|500|600|800|900)\b|fontWeight\s*=\s*'(?:500|600)'/g, 0],
  uppercase: [/text-transform\s*:\s*uppercase|textTransform\s*=\s*'uppercase'/g, 0],
}

const files = execFileSync('git', ['ls-files', 'src'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .filter((f) => /\.(js|css|html)$/.test(f) && !ART.has(f) && !f.includes('_locales'))

describe('type doctrine ratchet', () => {
  for (const [name, [re, cap]] of Object.entries(RULES)) {
    test(`${name}: at most ${cap} left`, () => {
      const hits = []
      for (const f of files) {
        for (const m of readFileSync(join(ROOT, f), 'utf8').matchAll(re)) hits.push(`${f}: ${m[0]}`)
      }
      expect(hits.length, hits.join('\n')).toBeLessThanOrEqual(cap)
    })
  }
})
