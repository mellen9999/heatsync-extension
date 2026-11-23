/**
 * Tab-cycle wrap gating — acRemoteEligible (src/multichat/input.js).
 *
 * Regression anchor: cycling @user and :emoji completions never wrapped —
 * after the last match Tab held forever. The hold-at-end is deliberate for
 * bare-emote searches (a remote 7TV/BTTV/FFZ fetch may still append matches),
 * but fetchRemoteEmoteMatches silently bails on @/:/modifier searches without
 * ever flipping remoteDone, so remoteMayCome stayed true and the cycle parked
 * at N/N. acRemoteEligible is the shared predicate: both the fetch gate and
 * the hold-at-end check now agree on which searches remote can ever serve.
 *
 * Carved out of the non-module content-script bundle and evaluated standalone
 * (same rationale as modifier-sweep-scope.test.js's carve).
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const INPUT_SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'input.js'), 'utf8')
const start = INPUT_SRC.indexOf('function acRemoteEligible(')
const end = INPUT_SRC.indexOf('async function fetchRemoteEmoteMatches(')
if (start === -1 || end === -1 || end <= start) throw new Error('acRemoteEligible carve markers not found')

// hsModClassify stub: only 'ffzW'-style modifier shorthands classify as modifier
const hsModClassifyStub = (s) => ({ kind: s === 'ffzW' ? 'modifier' : 'word' })
const acRemoteEligible = new Function('hsModClassify', `${INPUT_SRC.slice(start, end)}; return acRemoteEligible`)(
  hsModClassifyStub,
)

// Mirror of the Tab-cycle hold-at-end condition in handleInputKeydown
const remoteMayCome = (state) => state.remotePending || (!state.remoteDone && acRemoteEligible(state.search))

describe('acRemoteEligible — which searches the remote catalog can serve', () => {
  test('bare emote search is eligible', () => {
    expect(acRemoteEligible('kappa')).toBe(true)
  })

  test('@user search is never eligible (mentions wrap immediately)', () => {
    expect(acRemoteEligible('@wollip')).toBe(false)
  })

  test(':emoji search is never eligible (emoji wrap immediately)', () => {
    expect(acRemoteEligible(':hotdog')).toBe(false)
  })

  test('modifier shorthand is never eligible', () => {
    expect(acRemoteEligible('ffzW')).toBe(false)
  })

  test('short fragments and empty are never eligible', () => {
    expect(acRemoteEligible('k')).toBe(false)
    expect(acRemoteEligible('')).toBe(false)
    expect(acRemoteEligible(null)).toBe(false)
  })
})

describe('hold-at-end vs wrap — remoteMayCome', () => {
  test('@user cycle at end wraps (no hold): remoteMayCome false', () => {
    expect(remoteMayCome({ remotePending: false, remoteDone: false, search: '@wol' })).toBe(false)
  })

  test(':emoji cycle at end wraps (no hold): remoteMayCome false', () => {
    expect(remoteMayCome({ remotePending: false, remoteDone: false, search: ':kap' })).toBe(false)
  })

  test('bare emote with remote not yet fetched holds at end', () => {
    expect(remoteMayCome({ remotePending: false, remoteDone: false, search: 'kap' })).toBe(true)
  })

  test('bare emote with remote fetch in flight holds at end', () => {
    expect(remoteMayCome({ remotePending: true, remoteDone: false, search: 'kap' })).toBe(true)
  })

  test('bare emote after remote done wraps', () => {
    expect(remoteMayCome({ remotePending: false, remoteDone: true, search: 'kap' })).toBe(false)
  })
})
