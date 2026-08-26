// The overlay's bare-key command surface.
//
// Two things are locked in here. First, the leader table itself: one registry,
// one dispatch, and a command that declines (wrong tab, nothing to search)
// must report that so the leader stays silent instead of eating the key.
//
// Second — the tripwire that matters — NO bare printable key may fire a mod
// action again. x/t/b/s used to delete/timeout/ban off whatever row the mouse
// happened to rest on whenever the composer was blurred, so the first letter
// of a message could moderate somebody. That regression is invisible in a
// diff (it looks like a keybinding, not a footgun), so it gets a test.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(import.meta.dir, '..', 'src', 'multichat')
const VI = join(import.meta.dir, '..', 'chrome', 'vi-mode.js')
const read = (f) => readFileSync(join(SRC, f), 'utf8')

// Pull the pure registry out of the bundle-scope module and run it for real.
function loadRegistry() {
  const src = read('overlay-keys.js')
  return new Function(
    `${src}\nreturn { registerOverlayKey, runOverlayKey, initOverlayKeys, size: () => _overlayKeyBinds.size }`,
  )()
}

describe('overlay key registry', () => {
  test('runs a bound key and reports it handled', () => {
    const { registerOverlayKey, runOverlayKey } = loadRegistry()
    let hits = 0
    registerOverlayKey('n', () => {
      hits++
      return true
    })
    expect(runOverlayKey('n')).toBe(true)
    expect(hits).toBe(1)
  })

  test('unbound key is not handled and runs nothing', () => {
    const { runOverlayKey } = loadRegistry()
    expect(runOverlayKey('q')).toBe(false)
  })

  test('case matters — n and N are different commands', () => {
    const { registerOverlayKey, runOverlayKey } = loadRegistry()
    const seen = []
    registerOverlayKey('n', () => {
      seen.push('n')
      return true
    })
    registerOverlayKey('N', () => {
      seen.push('N')
      return true
    })
    runOverlayKey('N')
    expect(seen).toEqual(['N'])
  })

  test('a command that declines leaves the key unclaimed', () => {
    const { registerOverlayKey, runOverlayKey } = loadRegistry()
    registerOverlayKey('/', () => false)
    expect(runOverlayKey('/')).toBe(false)
  })

  test('a throwing command never escapes the dispatcher', () => {
    const { registerOverlayKey, runOverlayKey } = loadRegistry()
    registerOverlayKey('x', () => {
      throw new Error('boom')
    })
    expect(runOverlayKey('x')).toBe(false)
  })

  test('re-registering a key replaces it — no double-fire', () => {
    const { registerOverlayKey, runOverlayKey, size } = loadRegistry()
    const seen = []
    registerOverlayKey('n', () => {
      seen.push('first')
      return true
    })
    registerOverlayKey('n', () => {
      seen.push('second')
      return true
    })
    runOverlayKey('n')
    expect(seen).toEqual(['second'])
    expect(size()).toBe(1)
  })

  test('the hook vi-mode calls is installed and torn down with the signal', () => {
    const prev = globalThis.window
    globalThis.window = {}
    try {
      const { initOverlayKeys, registerOverlayKey } = loadRegistry()
      const ac = new AbortController()
      initOverlayKeys(ac.signal)
      registerOverlayKey('n', () => true)
      expect(typeof globalThis.window.__hsOverlayCommand).toBe('function')
      expect(globalThis.window.__hsOverlayCommand('n')).toBe(true)
      expect(globalThis.window.__hsOverlayCommand('q')).toBe(false)
      ac.abort()
      expect(globalThis.window.__hsOverlayCommand).toBeUndefined()
    } finally {
      globalThis.window = prev
    }
  })
})

describe('no bare printable key moderates anyone', () => {
  const modToolbar = read('mod-toolbar.js')

  // The confirm dialog's own Escape/Enter is the ONLY key this file may read.
  // Anything else means a printable-key bind crept back in.
  test('mod-toolbar reads no key but Escape and Enter', () => {
    const keys = [...modToolbar.matchAll(/e\.key\s*===\s*'([^']+)'/g)].map((m) => m[1])
    expect(new Set(keys)).toEqual(new Set(['Escape', 'Enter']))
  })

  test('the button catalog carries no hotkey field', () => {
    expect(modToolbar).not.toContain('hotkey:')
    expect(modToolbar).not.toContain('def.hotkey')
  })

  test('bulk-select is gone, not merely unbound', () => {
    for (const f of ['mod-toolbar.js', 'input.js', 'main.js', 'paints.js']) {
      expect(read(f)).not.toContain('bulkSelect')
      expect(read(f)).not.toContain('hs-mc-row-selected')
    }
  })
})

// vi-mode.js is one closure over a live document, so its keyboard path is
// asserted structurally rather than driven. Ordering IS the correctness
// argument here: the leader has to be consumed before the empty-composer
// branch, which types any printable key and returns.
describe('vi normal-mode leader', () => {
  const vi = readFileSync(VI, 'utf8')

  test('leader is consumed before the empty-composer types-the-key branch', () => {
    const consume = vi.indexOf('if (leaderPending) {')
    const arm = vi.indexOf("if (key === ' ' && !pendingCmd && !operator && !count) {")
    const empty = vi.indexOf('if (len === 0 && !pendingCmd && !operator && !count && key.length === 1) {')
    expect(consume).toBeGreaterThan(-1)
    expect(arm).toBeGreaterThan(consume)
    expect(empty).toBeGreaterThan(arm)
  })

  test('an armed leader never leaks the key into the message', () => {
    const block = vi.slice(vi.indexOf('if (leaderPending) {'), vi.indexOf("if (key === ' ' && !pendingCmd"))
    expect(block).toContain('blockEvent(e)')
    expect(block).toContain('window.__hsOverlayCommand?.(key)')
    expect(block).not.toContain('insertText')
  })

  test('every path out of normal mode disarms the leader', () => {
    for (const fn of ['function enterNormal', 'function enterInsert', 'function attach', 'function detach']) {
      const body = vi.slice(vi.indexOf(fn), vi.indexOf('\n  }', vi.indexOf(fn)))
      expect(body).toContain('leaderPending = false')
    }
  })
})
