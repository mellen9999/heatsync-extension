import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'

// every store-facing line that names the inventory size says 5,000 (MAX_EMOTES_PER_SOURCE), written the way that
// locale writes it. the table is explicit, not Intl at test time: separators differ between ICU versions.
// NB = no-break space, NN = narrow no-break space (fr): the number must never wrap across a line.
const NB = String.fromCharCode(0xa0)
const NN = String.fromCharCode(0x202f)
const FIVE_THOUSAND = {
  ar: '5,000',
  bg: `5${NB}000`,
  cs: `5${NB}000`,
  da: '5.000',
  de: '5.000',
  el: '5.000',
  en: '5,000',
  es: '5.000',
  fi: `5${NB}000`,
  fr: `5${NN}000`,
  he: '5,000',
  hi: '5,000',
  hu: `5${NB}000`,
  id: '5.000',
  it: '5.000',
  ja: '5,000',
  ko: '5,000',
  ms: '5,000',
  nl: '5.000',
  no: `5${NB}000`,
  pl: `5${NB}000`,
  pt_BR: '5.000',
  pt_PT: `5${NB}000`,
  ro: '5.000',
  ru: `5${NB}000`,
  sk: `5${NB}000`,
  sv: `5${NB}000`,
  th: '5,000',
  tl: '5,000',
  tr: '5.000',
  uk: `5${NB}000`,
  vi: '5.000',
  zh_CN: '5,000',
  zh_TW: '5,000',
}
const KEYS = ['manifest_description', 'popup_inv_slots', 'popup_inv_slots_of']
// any way of writing the figure, including the ungrouped one that used to ship in the store line
const ANY_5000 = new RegExp(`(?<![\\d.,])5[ ,.${NB}${NN}]?000(?!\\d)`, 'g')
const CWS_SUMMARY_MAX = 132

const locales = readdirSync(new URL('../src/_locales', import.meta.url)).sort()
const read = (loc) => JSON.parse(readFileSync(new URL(`../src/_locales/${loc}/messages.json`, import.meta.url), 'utf8'))

describe('store copy: inventory size', () => {
  test('the table covers every shipped locale', () => {
    expect(Object.keys(FIVE_THOUSAND).sort()).toEqual(locales)
  })

  for (const loc of locales) {
    test(`${loc}: ${KEYS.join(', ')} write 5,000 in the locale's own format`, () => {
      const msgs = read(loc)
      for (const key of KEYS) {
        const found = msgs[key].message.match(ANY_5000) || []
        expect(found, `${loc}.${key}`).toEqual([FIVE_THOUSAND[loc]])
      }
    })

    test(`${loc}: the store summary fits the chrome web store cap`, () => {
      expect(read(loc).manifest_description.message.length).toBeLessThanOrEqual(CWS_SUMMARY_MAX)
    })
  }

  test('the patch seeds cannot reintroduce a stale store line', () => {
    for (const loc of locales) {
      const url = new URL(`../tools/patches/${loc}.json`, import.meta.url)
      if (!existsSync(url)) continue
      const seed = JSON.parse(readFileSync(url, 'utf8')).manifest_description
      if (seed === undefined) continue
      expect(seed, `tools/patches/${loc}.json`).toBe(read(loc).manifest_description.message)
    }
  })
})
