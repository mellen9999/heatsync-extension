// A tab hidden with \ keeps that through a reload (sessionStorage). Boot reads the tab's own
// flag in loadChatPosition and the stored position in loadAllSettings, side by side; the settings
// load lands last and wrote the stored side ('right') over the tab's 'hidden', so every reload
// brought chat back (seen on twitch and kick, 11-17). The registry's own binding and applier
// run here for real.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'main-settings.js'), 'utf8')

function entry(head) {
  const s = SRC.indexOf(head)
  if (s < 0) throw new Error(`no ${head}`)
  return SRC.slice(s, SRC.indexOf('\n  },\n', s) + 5)
}

function world({ hidden }) {
  const calls = []
  return new Function(
    'applyChatPosition',
    '_saveChatHiddenLocal',
    'saveUiSetting',
    `let chatPosition = ${hidden ? "'hidden'" : "'right'"}, chatHiddenLocal = ${hidden}, chatPositionPrevious = 'right'
     const bridge = { ${entry('  chatPosition: {\n    get: () => chatPosition,')} }
     const appliers = { ${entry('  chatPosition: (v, _def, _onLoad, isRemote) => {')} }
     return {
       load: (v) => bridge.chatPosition.set(v),
       pick: (v) => (bridge.chatPosition.set(v), appliers.chatPosition(v, 'right', false, false)),
       remote: (v) => (bridge.chatPosition.set(v), appliers.chatPosition(v, 'right', false, true)),
       state: () => ({ chatPosition, chatHiddenLocal, chatPositionPrevious }),
     }`,
  )(
    () => calls.push('apply'),
    () => calls.push('save-local'),
    () => {},
  )
}

describe('a tab hidden with \\', () => {
  test('stays hidden when settings load after it', () => {
    const w = world({ hidden: true })
    w.load('right')
    expect(w.state()).toMatchObject({ chatPosition: 'hidden', chatHiddenLocal: true })
  })

  test('a position picked in this tab shows chat there', () => {
    const w = world({ hidden: true })
    w.pick('bottom')
    expect(w.state()).toMatchObject({ chatPosition: 'bottom', chatHiddenLocal: false, chatPositionPrevious: 'bottom' })
  })

  test('a position picked in another tab only moves where it comes back to', () => {
    const w = world({ hidden: true })
    w.remote('left')
    expect(w.state()).toMatchObject({ chatPosition: 'hidden', chatHiddenLocal: true, chatPositionPrevious: 'left' })
  })

  test('a tab that is not hidden takes the stored position as before', () => {
    const w = world({ hidden: false })
    w.load('bottom')
    expect(w.state().chatPosition).toBe('bottom')
  })
})
