import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

/**
 * The MV3 message contract, enforced on the router.
 *
 * chrome.runtime.onMessage has one rule that silently ruins things: if a
 * handler does async work it must `return true` to keep the port open, and if
 * it returns true it must eventually call sendResponse. Break the first and the
 * reply is discarded; break the second and the SENDER's promise never settles.
 * Neither throws. handleMessage is ~2,577 lines and 63 branches, and until this
 * existed nothing checked either half.
 *
 * Parsed with the TypeScript compiler API rather than regex, deliberately.
 * Three hand-rolled attempts at this file each produced a number that had to be
 * retracted: line numbers computed on comment-stripped text, a pattern that
 * missed switch cases and compound conditions, and a brace matcher that read
 * 6,462 lines for a 2,577-line function because it did not understand strings.
 */

const FILE = join(import.meta.dir, '..', 'chrome', 'background.js')
const src = ts.createSourceFile(FILE, readFileSync(FILE, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
const lineOf = (n) => src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1

function findHandler() {
  let fn = null
  const walk = (n) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === 'handleMessage') fn = n
    ts.forEachChild(n, walk)
  }
  walk(src)
  return fn
}

const contains = (node, pred) => {
  let hit = false
  const walk = (n) => {
    if (hit) return
    if (pred(n)) {
      hit = true
      return
    }
    ts.forEachChild(n, walk)
  }
  walk(node)
  return hit
}

function branches(fn) {
  const out = []
  const walk = (n) => {
    if (ts.isIfStatement(n) && /\b(message|msg)\.type\b/.test(n.expression.getText(src))) {
      out.push({
        names: [...n.expression.getText(src).matchAll(/'([^']+)'/g)].map((m) => m[1]),
        node: n.thenStatement,
        line: lineOf(n),
      })
    }
    if (ts.isCaseClause(n)) {
      const sw = n.parent?.parent
      if (sw && ts.isSwitchStatement(sw) && /\b(message|msg)\.type\b/.test(sw.expression.getText(src))) {
        out.push({ names: [n.expression.getText(src).replace(/'/g, '')], node: n, line: lineOf(n) })
      }
    }
    ts.forEachChild(n, walk)
  }
  walk(fn)
  return out
}

/**
 * Handlers whose reply is deliberately discarded. Verified at EVERY call site:
 * both are sent with `.catch(() => {})` and no sender reads a response, so the
 * missing `return true` costs nothing. Anything new landing here has to be
 * checked the same way — the danger is a handler whose caller DOES await.
 */
const FIRE_AND_FORGET = new Set(['youtube_ws_subscribe', 'mention_detected'])

describe('message router contract', () => {
  const fn = findHandler()

  test('the router is found and parsed', () => {
    expect(fn).toBeTruthy()
    expect(branches(fn).length).toBeGreaterThan(40)
  })

  test('no handler returns true without ever answering — a hung caller never times out', () => {
    const hung = branches(fn)
      .filter((b) => {
        const returnsTrue = contains(
          b.node,
          (x) => ts.isReturnStatement(x) && x.expression?.kind === ts.SyntaxKind.TrueKeyword,
        )
        const answers = contains(b.node, (x) => ts.isCallExpression(x) && x.expression.getText(src) === 'sendResponse')
        return returnsTrue && !answers
      })
      .map((b) => `background.js:${b.line} ${b.names.join('|')}`)
    expect(hung, 'returned true to keep the port open, then never responded').toEqual([])
  })

  test('no handler answers asynchronously without keeping the port open', () => {
    const dropped = branches(fn)
      .filter((b) => {
        const isAsync = contains(
          b.node,
          (x) =>
            x.kind === ts.SyntaxKind.AwaitExpression ||
            (ts.isCallExpression(x) && /\.then$/.test(x.expression.getText(src))),
        )
        const answers = contains(b.node, (x) => ts.isCallExpression(x) && x.expression.getText(src) === 'sendResponse')
        const returnsTrue = contains(
          b.node,
          (x) => ts.isReturnStatement(x) && x.expression?.kind === ts.SyntaxKind.TrueKeyword,
        )
        return isAsync && answers && !returnsTrue
      })
      .filter((b) => !b.names.some((n) => FIRE_AND_FORGET.has(n)))
      .map((b) => `background.js:${b.line} ${b.names.join('|')}`)
    expect(dropped, 'async reply with no `return true` — the port closes first and the reply is discarded').toEqual([])
  })
})
