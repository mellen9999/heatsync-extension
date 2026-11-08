// Right-clicking a tab clears its red mention state. That state is rebuilt on
// every refresh from tabSeenAt (applyUnreadIndicatorsFromPersist), so the
// right-click path must stamp tabSeenAt like a normal tab view does — it used
// to clear only the DOM classes and the red came straight back on reload.
import { expect, test } from 'bun:test'
import { mainSource } from './main-src.js'

const MAIN = mainSource()

test('right-click clear stamps tabSeenAt for channel tabs', () => {
  const at = MAIN.indexOf("container.addEventListener('contextmenu'")
  const clear = MAIN.slice(at, MAIN.indexOf('// Live tab gets platform edit context menu', at))
  expect(clear).toContain('markTabRead(tabId)')
  expect(clear).toContain('if (!mcIsReservedTab(tabId)) markTabSeen(tabId)')
})
