/**
 * D6: spa-nav.js fired a full YT unsub/resub on ANY location.search change —
 * youtube's own &pp=/&list=/&index= replaceState churn (autoplay tracking,
 * playlist position) triggers mid-stream on the SAME video, dropping the WS
 * subscription for no reason. handleMcNav now compares only the `v` param
 * via this helper.
 */

import { describe, expect, test } from 'bun:test'
import { ytSameVideoSearch } from '../src/lib/utils.js'

describe('ytSameVideoSearch', () => {
  test('identical search → same video', () => {
    expect(ytSameVideoSearch('?v=abc123', '?v=abc123')).toBe(true)
  })
  test('different v param → different video', () => {
    expect(ytSameVideoSearch('?v=abc123', '?v=xyz789')).toBe(false)
  })
  test('youtube replaceState churn (pp/list/index) on the same video → same video', () => {
    expect(ytSameVideoSearch('?v=abc123&pp=QAFIAQ%3D%3D', '?v=abc123')).toBe(true)
    expect(ytSameVideoSearch('?v=abc123&list=PL1&index=3', '?v=abc123&list=PL1&index=4')).toBe(true)
  })
  test('no v param on either side → same (both null)', () => {
    expect(ytSameVideoSearch('', '')).toBe(true)
    expect(ytSameVideoSearch('?foo=bar', '?baz=qux')).toBe(true)
  })
  test('gaining or losing the v param → different video', () => {
    expect(ytSameVideoSearch('?v=abc123', '')).toBe(false)
    expect(ytSameVideoSearch('', '?v=abc123')).toBe(false)
  })
})
