// A heatsync notification (reply / mention / fixed report) becomes a row in the
// mentions tab, like the rust app's notifs tab; the bg shapes the hostile frame first.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bgSource } from './bg-src.js'
import { t } from './en-t.js'

const ROOT = join(import.meta.dir, '..')
const BG = bgSource()
const MENTIONS = readFileSync(join(ROOT, 'src', 'multichat', 'mentions.js'), 'utf8')

const slice = (src, from, to) => src.slice(src.indexOf(from), src.indexOf(to))
const shape = new Function(
  `${slice(BG, 'function shapeHsNotif(', '// the mentions tab was looked at')}; return shapeHsNotif`,
)()
const text = new Function(
  't',
  `${slice(MENTIONS, 'function hsNotifText(', 'function hsNotifIn(')}; return hsNotifText`,
)(t)

describe('shapeHsNotif', () => {
  test('keeps only bounded fields', () => {
    const s = shape({ kind: 'reply', message_id: 'abc12', content: `a\u0000b${'x'.repeat(400)}`, parent_is_op: true })
    expect(s.kind).toBe('reply')
    expect(s.id).toBe('abc12')
    expect(s.text.length).toBeLessThanOrEqual(300)
    expect(s.text.startsWith('a b')).toBe(true)
    expect(s.op).toBe(true)
  })
  test('a bad id is dropped, not trusted', () => {
    expect(shape({ kind: 'reply', message_id: '../../x' }).id).toBe('')
    expect(shape({ kind: 'reply', message_id: 'toolongid99' }).id).toBe('')
  })
  test('junk in, empty out', () => {
    expect(shape(null)).toMatchObject({ kind: '', id: '', text: '', op: null, anon: false })
  })
})

describe('hsNotifText', () => {
  test('says whose post it answered', () => {
    expect(text({ kind: 'reply', op: true, text: 'hi' })).toBe('replied to your post: hi')
    expect(text({ kind: 'reply', op: false, text: '' })).toBe('replied to your reply')
    expect(text({ kind: 'reply', op: null, text: '' })).toBe('replied to you')
  })
  test('anonymous is named, mention and fixed have defaults', () => {
    expect(text({ kind: 'mention', anon: true, text: '' })).toBe('anonymous: you were mentioned in a post')
    expect(text({ kind: 'feedback_fixed', text: '' })).toBe('your report was fixed')
  })
})
