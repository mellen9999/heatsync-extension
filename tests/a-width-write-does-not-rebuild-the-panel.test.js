import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const MAIN = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'main.js'), 'utf8')

describe('the column watcher rebuilds only for twitch', () => {
  test('a style-only mutation (our own width write) skips ensureUIElements + renderMessages', () => {
    const start = MAIN.indexOf('function startColumnClassWatcher()')
    const body = MAIN.slice(start, MAIN.indexOf("'column-class-watcher'", start))
    expect(body).toMatch(/records\.some\(\(r\) => r\.attributeName === 'class'\)/)
    const gate = body.indexOf('if (classChanged && rightCol')
    expect(gate).toBeGreaterThan(-1)
    expect(body.indexOf('ensureUIElements()')).toBeGreaterThan(gate)
    expect(body.indexOf('renderMessages(currentTab)')).toBeGreaterThan(gate)
  })
})

const NOTIFS = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'notifs.js'), 'utf8')
const BOOT = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'bootstrap.js'), 'utf8')

describe('layout passes read before they write <html> vars', () => {
  test('layer geometry is measured for every layer before any var is written', () => {
    const start = NOTIFS.indexOf('function updateLayout(ctx)')
    const body = NOTIFS.slice(start, NOTIFS.indexOf('\n  }\n', start))
    expect(body).not.toContain('style.setProperty')
    expect(body.indexOf('for (const [cssName, v] of writes) setRootVar')).toBeGreaterThan(
      body.indexOf('l.def.geometry'),
    )
  })
  test('_updateMcLayout publishes the panel width last, from a width it measured up front', () => {
    const start = MAIN.indexOf('_updateMcLayout = () => {')
    const body = MAIN.slice(start, MAIN.indexOf('// Re-observe on every pass', start))
    const measured = body.indexOf('const panelW = ')
    expect(measured).toBeGreaterThan(-1)
    expect(body.indexOf('HsNotifs.updateLayout')).toBeLessThan(body.lastIndexOf('publishPanelWidth(panelW)'))
    expect(body.indexOf('syncPickerBox()')).toBeLessThan(body.indexOf('HsNotifs.updateLayout'))
  })
  test('setRootVar skips a write that changes nothing', () => {
    expect(BOOT).toMatch(/s\.getPropertyValue\(name\) !== value\) s\.setProperty\(name, value\)/)
  })
})
