/**
 * Unit tests for src/lib/undo-manager.js
 *
 * UndoManager operates on a contenteditable DOM element — it uses:
 *   input.childNodes, input.replaceChildren, input.querySelectorAll
 *   input.contains, input.dispatchEvent
 *   window.getSelection, document.createTreeWalker, document.createRange,
 *   document.createTextNode, NodeFilter, Node (constants)
 *
 * Strategy: stub all required globals on globalThis before importing so the
 * module-level code (including the `capture()` call in the constructor) sees
 * them. Use a minimal fake DOM that records replaceChildren calls.
 *
 * NOTE: _getCharOffset / _setCharOffset depend heavily on
 * window.getSelection / document.createTreeWalker — a full DOM environment.
 * Those paths are exercised at a coarse level (no throw, returns sensible
 * defaults) but cursor positioning precision requires a real browser.
 * The pure stack logic (push, undo, redo, cap, dedup) is tested thoroughly.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'

// installDomStubs() sets globalThis.window = globalThis to simulate a browser.
// Restore the original so this file doesn't pollute later test files.
const ORIGINAL_WINDOW = Object.getOwnPropertyDescriptor(globalThis, 'window')
afterAll(() => {
  if (ORIGINAL_WINDOW) Object.defineProperty(globalThis, 'window', ORIGINAL_WINDOW)
  else delete globalThis.window
})

// ── minimal DOM stubs ────────────────────────────────────────────────────────

/** A fake text node that supports cloneNode and basic textContent. */
function fakeTextNode(text) {
  return {
    nodeType: 3, // Node.TEXT_NODE
    textContent: text,
    cloneNode: () => fakeTextNode(text),
  }
}

/** Create a minimal fake selection/range that satisfies _getCharOffset. */
function makeNullSelection() {
  return {
    rangeCount: 0,
    getRangeAt: () => null,
    removeAllRanges: () => {},
    addRange: () => {},
  }
}

/** Create a fake range whose startContainer is NOT inside the input. */
function makeOrphanRange() {
  return {
    startContainer: {},
    startOffset: 0,
    collapse: () => {},
    setStart: () => {},
    setStartAfter: () => {},
    selectNodeContents: () => {},
  }
}

/** A fake TreeWalker that immediately returns null (no nodes). */
function makeEmptyWalker() {
  return { nextNode: () => null }
}

/**
 * Build a fake input element.
 * @param {Array} childNodes — array of fake nodes (default: one empty text node)
 */
function fakeInput(childNodes = [fakeTextNode('')]) {
  const el = {
    _children: [...childNodes],
    get childNodes() {
      return this._children
    },
    replaceChildren(...nodes) {
      this._children = [...nodes]
    },
    querySelectorAll: () => [],
    contains: () => false,
    dispatchEvent: () => {},
    addEventListener: () => {},
    _undoManager: null,
  }
  return el
}

/** Install all required browser globals on globalThis. */
function installDomStubs() {
  globalThis.Node = { TEXT_NODE: 3, ELEMENT_NODE: 1 }
  globalThis.NodeFilter = { SHOW_ALL: 0xffffffff }
  globalThis.window = globalThis

  // getSelection returns a selection with no range by default
  globalThis.window.getSelection = () => makeNullSelection()

  globalThis.document = {
    createTreeWalker: () => makeEmptyWalker(),
    createRange: () => makeOrphanRange(),
    createTextNode: (t) => fakeTextNode(t),
  }

  globalThis.Event = class Event {
    constructor(type, opts) {
      this.type = type
      this.bubbles = opts?.bubbles || false
    }
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

let UndoManager, installUndoManager

/** Load the module fresh (re-import each describe via dynamic import with cache-bust). */
async function loadModule() {
  // Bun caches dynamic imports by URL — append a dummy param to force reload
  const url = new URL('../src/lib/undo-manager.js', import.meta.url).href
  const mod = await import(url)
  UndoManager = mod.UndoManager
  installUndoManager = mod.installUndoManager
  return mod
}

// ── suite ────────────────────────────────────────────────────────────────────

describe('UndoManager — constructor', () => {
  beforeEach(() => {
    installDomStubs()
  })

  test('constructs without throwing', async () => {
    await loadModule()
    const input = fakeInput()
    expect(() => new UndoManager(input)).not.toThrow()
  })

  test('initial stack has exactly one entry (the capture on construct)', async () => {
    await loadModule()
    const input = fakeInput([fakeTextNode('hello')])
    const m = new UndoManager(input)
    expect(m.stack.length).toBe(1)
    expect(m.index).toBe(0)
  })

  test('default max is 100', async () => {
    await loadModule()
    const input = fakeInput()
    const m = new UndoManager(input)
    expect(m.max).toBe(100)
  })

  test('custom max option is respected', async () => {
    await loadModule()
    const input = fakeInput()
    const m = new UndoManager(input, { max: 10 })
    expect(m.max).toBe(10)
  })
})

describe('UndoManager — undo/redo basic sequence', () => {
  beforeEach(() => {
    installDomStubs()
  })

  /**
   * Helper: push a new state by mutating input.childNodes and calling capture().
   * Each state has distinct text so _signatureMatch returns false.
   */
  function pushState(m, input, text) {
    input._children = [fakeTextNode(text)]
    m.capture()
  }

  test('undo returns false on a fresh single-entry stack', async () => {
    await loadModule()
    const input = fakeInput([fakeTextNode('a')])
    const m = new UndoManager(input)
    expect(m.undo()).toBe(false)
  })

  test('redo returns false when at top of stack', async () => {
    await loadModule()
    const input = fakeInput([fakeTextNode('a')])
    const m = new UndoManager(input)
    expect(m.redo()).toBe(false)
  })

  test('undo after one push returns true and decrements index', async () => {
    await loadModule()
    const input = fakeInput([fakeTextNode('a')])
    const m = new UndoManager(input)
    pushState(m, input, 'b')
    expect(m.index).toBe(1)
    const result = m.undo()
    expect(result).toBe(true)
    expect(m.index).toBe(0)
  })

  test('redo after undo returns true and increments index', async () => {
    await loadModule()
    const input = fakeInput([fakeTextNode('a')])
    const m = new UndoManager(input)
    pushState(m, input, 'b')
    m.undo()
    const result = m.redo()
    expect(result).toBe(true)
    expect(m.index).toBe(1)
  })

  test('redo at top of stack returns false', async () => {
    await loadModule()
    const input = fakeInput([fakeTextNode('a')])
    const m = new UndoManager(input)
    pushState(m, input, 'b')
    m.undo()
    m.redo()
    expect(m.redo()).toBe(false)
  })

  test('three-step undo walks back to index 0', async () => {
    await loadModule()
    const input = fakeInput([fakeTextNode('a')])
    const m = new UndoManager(input)
    pushState(m, input, 'b')
    pushState(m, input, 'c')
    pushState(m, input, 'd')
    expect(m.index).toBe(3)
    m.undo()
    m.undo()
    m.undo()
    expect(m.index).toBe(0)
    expect(m.undo()).toBe(false) // already at bottom
  })
})

describe('UndoManager — redo invalidation after new push', () => {
  beforeEach(() => {
    installDomStubs()
  })

  function pushState(m, input, text) {
    input._children = [fakeTextNode(text)]
    m.capture()
  }

  /**
   * After undo() calls _restore(), _suppress is set to true.
   * The first capture() call will clear _suppress and return early (no push).
   * The second capture() with new content actually pushes the new state.
   * This mirrors the real flow: _restore dispatches 'input' (clears suppress),
   * then the user's next keystroke triggers a second capture with new content.
   */
  function pushStateAfterUndo(m, input, text) {
    m.capture() // consume the _suppress flag set by _restore
    input._children = [fakeTextNode(text)]
    m.capture() // actually push the new state
  }

  test('new capture after undo truncates the redo stack', async () => {
    await loadModule()
    const input = fakeInput([fakeTextNode('a')])
    const m = new UndoManager(input)
    pushState(m, input, 'b')
    pushState(m, input, 'c')
    m.undo() // index → 1, _suppress = true
    pushStateAfterUndo(m, input, 'd') // truncates 'c', pushes 'd'
    expect(m.stack.length).toBe(3) // 'a', 'b', 'd'
    expect(m.redo()).toBe(false) // 'd' is now the top
  })

  test('redo is unavailable after a new capture mid-history', async () => {
    await loadModule()
    const input = fakeInput([fakeTextNode('a')])
    const m = new UndoManager(input)
    pushState(m, input, 'b')
    pushState(m, input, 'c')
    pushState(m, input, 'd')
    m.undo()
    m.undo() // index → 1, _suppress = true
    pushStateAfterUndo(m, input, 'x')
    // stack is now ['a', 'b', 'x'] — length 3, index 2
    expect(m.stack.length).toBe(3)
    expect(m.redo()).toBe(false)
  })
})

describe('UndoManager — stack cap', () => {
  beforeEach(() => {
    installDomStubs()
  })

  test('stack never grows beyond max', async () => {
    await loadModule()
    const input = fakeInput([fakeTextNode('0')])
    const m = new UndoManager(input, { max: 5 })
    for (let i = 1; i <= 20; i++) {
      input._children = [fakeTextNode(String(i))]
      m.capture()
    }
    expect(m.stack.length).toBeLessThanOrEqual(5)
  })

  test('stack at max still supports undo', async () => {
    await loadModule()
    const input = fakeInput([fakeTextNode('0')])
    const m = new UndoManager(input, { max: 3 })
    input._children = [fakeTextNode('1')]
    m.capture()
    input._children = [fakeTextNode('2')]
    m.capture()
    input._children = [fakeTextNode('3')]
    m.capture()
    input._children = [fakeTextNode('4')]
    m.capture()
    // stack capped at 3: contains ['2','3','4'] (oldest evicted)
    expect(m.stack.length).toBe(3)
    expect(m.undo()).toBe(true)
  })
})

describe('UndoManager — deduplication (signature match)', () => {
  beforeEach(() => {
    installDomStubs()
  })

  test('identical consecutive capture() does not grow the stack', async () => {
    await loadModule()
    const input = fakeInput([fakeTextNode('same')])
    const m = new UndoManager(input)
    const lenBefore = m.stack.length
    m.capture() // same content
    m.capture() // same content
    expect(m.stack.length).toBe(lenBefore)
  })

  test('changed content does grow the stack', async () => {
    await loadModule()
    const input = fakeInput([fakeTextNode('a')])
    const m = new UndoManager(input)
    input._children = [fakeTextNode('b')]
    m.capture()
    expect(m.stack.length).toBe(2)
  })

  test('an identical capture never clones the live nodes (cheap signature check runs first)', async () => {
    await loadModule()
    const node = fakeTextNode('same')
    let cloneCalls = 0
    const realClone = node.cloneNode.bind(node)
    node.cloneNode = (deep) => {
      cloneCalls++
      return realClone(deep)
    }
    const input = fakeInput([node])
    const m = new UndoManager(input) // constructor capture() clones once (empty stack)
    expect(cloneCalls).toBe(1)
    m.capture() // no change — must skip the clone entirely
    expect(cloneCalls).toBe(1)
  })

  test('a changed capture still clones (the skip is content-gated, not unconditional)', async () => {
    await loadModule()
    const input = fakeInput([fakeTextNode('a')])
    const m = new UndoManager(input)
    const nextNode = fakeTextNode('b')
    let cloneCalls = 0
    const realClone = nextNode.cloneNode.bind(nextNode)
    nextNode.cloneNode = (deep) => {
      cloneCalls++
      return realClone(deep)
    }
    input._children = [nextNode]
    m.capture()
    expect(cloneCalls).toBe(1)
    expect(m.stack.length).toBe(2)
  })
})

describe('UndoManager — reset', () => {
  beforeEach(() => {
    installDomStubs()
  })

  test('reset clears stack and re-captures initial state', async () => {
    await loadModule()
    const input = fakeInput([fakeTextNode('a')])
    const m = new UndoManager(input)
    input._children = [fakeTextNode('b')]
    m.capture()
    input._children = [fakeTextNode('c')]
    m.capture()
    m.reset()
    expect(m.stack.length).toBe(1)
    expect(m.index).toBe(0)
    expect(m.undo()).toBe(false)
    expect(m.redo()).toBe(false)
  })
})

describe('UndoManager — _restore side-effects', () => {
  beforeEach(() => {
    installDomStubs()
  })

  test('undo calls replaceChildren on the input element', async () => {
    await loadModule()
    let replaceCalled = false
    const input = fakeInput([fakeTextNode('a')])
    input.replaceChildren = (...nodes) => {
      replaceCalled = true
      input._children = [...nodes]
    }
    const m = new UndoManager(input)
    input._children = [fakeTextNode('b')]
    m.capture()
    m.undo()
    expect(replaceCalled).toBe(true)
  })

  test('undo dispatches an input event on the element', async () => {
    await loadModule()
    let eventDispatched = false
    const input = fakeInput([fakeTextNode('a')])
    input.dispatchEvent = (e) => {
      if (e.type === 'input') eventDispatched = true
    }
    const m = new UndoManager(input)
    input._children = [fakeTextNode('b')]
    m.capture()
    m.undo()
    expect(eventDispatched).toBe(true)
  })

  test('_suppress flag prevents double-capture during restore', async () => {
    await loadModule()
    const input = fakeInput([fakeTextNode('a')])
    const m = new UndoManager(input)
    input._children = [fakeTextNode('b')]
    m.capture()
    const stackLen = m.stack.length
    // _restore sets _suppress = true; a capture() call right after returns early
    m._suppress = true
    m.capture()
    expect(m.stack.length).toBe(stackLen) // not grown
    expect(m._suppress).toBe(false) // cleared by the call
  })
})

describe('installUndoManager', () => {
  beforeEach(() => {
    installDomStubs()
  })

  test('returns a UndoManager instance', async () => {
    await loadModule()
    const input = fakeInput()
    const m = installUndoManager(input)
    expect(m).toBeInstanceOf(UndoManager)
  })

  test('installs _undoManager property on the element', async () => {
    await loadModule()
    const input = fakeInput()
    const m = installUndoManager(input)
    expect(input._undoManager).toBe(m)
  })

  test('calling installUndoManager twice returns the same instance', async () => {
    await loadModule()
    const input = fakeInput()
    const m1 = installUndoManager(input)
    const m2 = installUndoManager(input)
    expect(m1).toBe(m2)
  })
})
