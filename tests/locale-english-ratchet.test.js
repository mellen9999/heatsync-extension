// A string left in english inside another language's file is a leak nothing else catches: the
// key exists, the placeholders match, every other locale test is green. Three tab and composer
// strings sat in english in all 33 languages that way (found 11-17).
//
// locale-same-as-english.json is the list of what is the same as english ON PURPOSE (a command,
// a brand, a loanword, "1x"). It only shrinks:
//   - a string equal to english that is not on the list fails here. Translate it. Only a string
//     that is right in english for that language goes on the list, by hand.
//   - a listed string that has since been translated fails too, so the list stays the truth.
//     Drop those with: LOCALE_RATCHET_PRUNE=1 bun test tests/locale-english-ratchet.test.js
import { expect, test } from 'bun:test'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', 'src', '_locales')
const LIST = join(import.meta.dir, 'locale-same-as-english.json')
const load = (c) => JSON.parse(readFileSync(join(ROOT, c, 'messages.json'), 'utf8'))
const en = load('en')
const codes = readdirSync(ROOT)
  .filter((c) => c !== 'en')
  .sort()
const allowed = JSON.parse(readFileSync(LIST, 'utf8'))

const same = {} // key -> locales whose string is english's, right now
for (const code of codes) {
  const loc = load(code)
  for (const k of Object.keys(en)) {
    if (loc[k]?.message !== en[k].message) continue
    same[k] ||= []
    same[k].push(code)
  }
}

if (process.env.LOCALE_RATCHET_PRUNE) {
  const kept = Object.keys(allowed)
    .sort()
    .map((k) => [k, allowed[k].filter((c) => same[k]?.includes(c))])
    .filter(([, cs]) => cs.length)
  writeFileSync(LIST, `{\n${kept.map(([k, cs]) => `  ${JSON.stringify(k)}: ${JSON.stringify(cs)}`).join(',\n')}\n}\n`)
}

test('no string is left in english that is not listed as english on purpose', () => {
  const leaks = []
  for (const [k, cs] of Object.entries(same))
    for (const c of cs) if (!allowed[k]?.includes(c)) leaks.push(`${c}: ${k} = ${JSON.stringify(en[k].message)}`)
  expect(leaks).toEqual([])
})

test('the list holds nothing that has been translated since (it only shrinks)', () => {
  if (process.env.LOCALE_RATCHET_PRUNE) return
  const stale = []
  for (const [k, cs] of Object.entries(allowed)) for (const c of cs) if (!same[k]?.includes(c)) stale.push(`${c}: ${k}`)
  expect(stale).toEqual([])
})

test('the three strings that leaked are translated everywhere', () => {
  for (const k of ['mc_tab_temp_title', 'mc_tab_keep', 'mc_input_send_tag_title'])
    expect([k, same[k] || []]).toEqual([k, []])
})
