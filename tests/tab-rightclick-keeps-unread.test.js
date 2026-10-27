/**
 * Right-click on a tab clears red/attention states, never the plain unread
 * count. On a fast chat the count refills at once, so a handler that cleared
 * "has-new" hijacked every right-click and the remove/edit menu was unreachable.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'main.js'), 'utf8')
const at = SRC.indexOf("container.addEventListener('contextmenu', (e) => {")
const handler = SRC.slice(at, SRC.indexOf('// Live tab gets platform edit context menu', at))

describe('tab right-click', () => {
  test('plain unread (has-new) does not trigger the clear', () => {
    const cond = handler.slice(handler.indexOf('if ('), handler.indexOf('e.preventDefault()'))
    expect(cond).toContain('has-mentions')
    expect(cond).toContain('has-stream-event')
    expect(cond).toContain('has-whispers')
    expect(cond).not.toContain('has-new')
  })

  test('the clear leaves has-new and a channel tab count alone', () => {
    expect(handler).toContain("classList.remove('has-mentions', 'has-stream-event', 'has-whispers')")
    expect(handler).toContain('if (mcIsReservedTab(tabId)) markTabRead(tabId)')
  })
})
