import { describe, expect, test } from 'bun:test'
import { SETTINGS } from '../src/lib/settings-schema.js'

/**
 * The filters page `default` button resets every row that is not noReset.
 * The five mature-content switches must be among them (all off by default),
 * or `default` silently leaves a viewer's adult categories on.
 */
describe('default button and the content filters', () => {
  const cw = SETTINGS.filter((d) => d.apply === 'cwServerPatch')

  test('there are five, one per mature category', () => {
    expect(cw.map((d) => d.cw.stateKey).sort()).toEqual(['drug', 'gore', 'hate', 'sexual', 'weapon'])
  })

  test('each is off by default and is reset by default', () => {
    for (const d of cw) {
      expect(d.default).toBe(false)
      expect(d.noReset).toBeFalsy()
    }
  })
})
