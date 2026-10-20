// Right-clicking a tab clears its red mention state. That state is rebuilt on
// every refresh from tabSeenAt (applyUnreadIndicatorsFromPersist), so the
// right-click path must stamp tabSeenAt like a normal tab view does — it used
// to clear only the DOM classes and the red came straight back on reload.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const MAIN = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'main.js'), 'utf8')

test('right-click clear stamps tabSeenAt for channel tabs', () => {
  const at = MAIN.indexOf("container.addEventListener('contextmenu'")
  const clear = MAIN.slice(at, MAIN.indexOf('// Live tab gets platform edit context menu', at))
  expect(clear).toContain('markTabRead(tabId)')
  expect(clear).toContain('if (!mcIsReservedTab(tabId)) markTabSeen(tabId)')
})
