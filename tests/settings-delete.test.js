import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('../chrome/background.js', import.meta.url), 'utf8')
const cut = (a, b) => SRC.slice(SRC.indexOf(a), SRC.indexOf(b, SRC.indexOf(a)))
const { planSettingsDelete, omitKey } = new Function(
  `${cut('const UI_SYNC_BLOCKLIST =', 'function splitIncomingUiState(')}
${cut('function planSettingsDelete(', '// Serialized read-modify-write')}
return { planSettingsDelete, omitKey }`,
)()

describe('settings:delete', () => {
  test('background has a handler case', () => {
    expect(SRC).toContain("case 'settings:delete'")
  })
  test('ordinary key is removed from synced ui_settings', () => {
    expect(planSettingsDelete('zebra')).toEqual({ syncKey: 'zebra' })
  })
  test('blocklist key clears its local mirror, not sync', () => {
    expect(planSettingsDelete('keywordHighlights')).toEqual({ overflowKey: 'keyword_highlights' })
  })
  test('device-local and junk keys are ignored', () => {
    expect(planSettingsDelete('platformFilters')).toEqual({})
    expect(planSettingsDelete('')).toEqual({})
    expect(planSettingsDelete(5)).toEqual({})
    expect(planSettingsDelete('__proto__')).toEqual({})
  })
  test('omitKey drops only that key', () => {
    expect(omitKey({ a: 1, b: 2 }, 'a')).toEqual({ b: 2 })
  })
})
