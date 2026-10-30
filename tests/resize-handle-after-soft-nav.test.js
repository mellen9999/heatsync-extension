import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const TWITCH_HOST = readFileSync(join(ROOT, 'src', 'multichat', 'twitch-host.js'), 'utf8')

describe('a channel reached by soft nav gets its resize bar', () => {
  test('the chat-shell reparent creates the handle and honours a non-right position', () => {
    const start = TWITCH_HOST.indexOf('const tryReparent = () => {')
    expect(start).toBeGreaterThan(-1)
    const body = TWITCH_HOST.slice(start, TWITCH_HOST.indexOf('return false', start))
    expect(body).toContain('setupResizeHandle()')
    expect(body).toMatch(/chatPosition !== 'right'\) hidePlatformResizeHandles\(true\)/)
  })
})
