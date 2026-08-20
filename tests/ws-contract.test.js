import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

/**
 * The websocket is a two-ended contract and only one end was ever checked.
 *
 * If the server starts sending a type the extension has no case for, nothing
 * fails — the message is read, matched against nothing, and dropped. The
 * feature simply does not exist on the client, silently, forever.
 *
 * Skips when the site repo is not checked out, like the site's own cross-repo
 * guard, so this never blocks a standalone clone.
 */

const EXT = join(import.meta.dir, '..', 'chrome', 'background.js')
/**
 * The sibling repo, found from either a normal checkout or a worktree. Inside
 * `.worktrees/<name>/` the projects dir is two levels further up than it looks
 * — the exact trap that made scripts/smoke-extension.ts report "playwright not
 * found" on a machine that had it installed.
 */
const siteRoot = ['..', '../..', '../../..', '../../../..']
  .map((up) => join(import.meta.dir, '..', up, 'heatsync'))
  .find((p) => existsSync(join(p, 'server')))

/** Types handled by handleWSMessage, via the AST — not regex. */
function handledTypes() {
  const src = ts.createSourceFile(EXT, readFileSync(EXT, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  let fn = null
  const findFn = (n) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === 'handleWSMessage') fn = n
    ts.forEachChild(n, findFn)
  }
  findFn(src)
  if (!fn) throw new Error('handleWSMessage not found in background.js')
  const out = new Set()
  const walk = (n) => {
    if (ts.isIfStatement(n)) {
      const t = n.expression.getText(src)
      if (/\b(msg|message|data)\.type\b/.test(t)) for (const m of t.matchAll(/'([^']+)'/g)) out.add(m[1])
    }
    if (ts.isCaseClause(n)) {
      const sw = n.parent?.parent
      if (sw && ts.isSwitchStatement(sw) && /\b(msg|message|data)\.type\b/.test(sw.expression.getText(src))) {
        out.add(n.expression.getText(src).replace(/'/g, ''))
      }
    }
    ts.forEachChild(n, walk)
  }
  walk(fn)
  return out
}

/** Types the server emits near a socket send/broadcast. */
function serverSentTypes(root) {
  const files = []
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (e.name !== 'node_modules') walk(join(d, e.name))
      } else if (e.name.endsWith('.ts')) files.push(join(d, e.name))
    }
  }
  walk(join(root, 'server'))
  const sent = new Map()
  for (const f of files) {
    const s = readFileSync(f, 'utf8')
    for (const m of s.matchAll(/type:\s*'([^']+)'/g)) {
      const ctx = s.slice(Math.max(0, m.index - 260), m.index + 80)
      if (/broadcast|publishTo|wsSend|\.send\(|sendTo|emitTo|WSServerMessage/.test(ctx)) {
        if (!sent.has(m[1])) sent.set(m[1], f.split('/').pop())
      }
    }
  }
  return sent
}

/** Client->server types: the extension sends these, it does not receive them. */
function clientTypes(root) {
  const p = join(root, 'server', 'services', 'ws-protocol.ts')
  if (!existsSync(p)) return new Set()
  const m = readFileSync(p, 'utf8').match(/export type WSClientMessage\s*=([\s\S]*?);\n/)
  return new Set(m ? [...m[1].matchAll(/type:\s*'([^']+)'/g)].map((x) => x[1]) : [])
}

/**
 * Server messages the extension deliberately does not handle, each with the
 * reason. Anything NOT listed here that the server sends is a silent gap.
 */
const NOT_FOR_EXTENSION = new Map([
  // website surfaces the extension has no UI for
  ['reaction:added', 'site feed reactions — no extension surface'],
  ['reaction:removed', 'site feed reactions — no extension surface'],
  ['vote:updated', 'site feedback-board votes — no extension surface'],
  ['dm:message', 'full DM thread UI is site-only; the ext handles dm:new for the badge'],
  ['dm:sent', 'site DM compose echo'],
  ['presence:count', 'site presence counter'],
  ['emote:inventory', 'site inventory page; the ext syncs over http'],
  ['user:blocked', 'site block UI; the ext uses mute:added/removed'],
  ['user:unblocked', 'site block UI'],
  ['whisper:new', 'the ext receives whispers directly from twitch eventsub'],
  // protocol plumbing, not features
  ['batch', 'declared in the union but never emitted — no send site exists'],
  ['pong', 'keepalive, consumed by the socket layer'],
  ['session_expired', 'handled outside handleWSMessage'],
  ['user', 'a payload field, not a message type — matched by the context heuristic'],
  // server-internal relays that never reach a socket the extension owns
  ['privmsg', 'twitch eventsub internal shape; reaches the ext as irc:message'],
  ['clearchat', 'twitch eventsub internal shape'],
  ['clearmsg', 'twitch eventsub internal shape'],
  ['usernotice', 'twitch eventsub internal shape'],
  ['stream:sub', 'twitch eventsub internal shape; reaches the ext as stream:sub-gift'],
  ['chat:send_kick_result', 'send-ack for the kick relay; the ext does not await it'],
  ['chat:send_youtube_result', 'send-ack for the yt relay; the ext does not await it'],

  // ─── KNOWN GAP, not a decision ───────────────────────────────────────────
  // The server sends this to every socket subscribed to a video's chat, with
  // the comment "Live removal — clients match by innertube id or (for bans)
  // authorChannelId". The extension has no case for it, so a message a mod
  // DELETED, and every message from a BANNED user, stays visible in the
  // overlay. The ids needed to match are already carried (ytMsg.id, and
  // authorChannelId via hsPaintUid), so the data is there — the handler is not.
  ['youtube:delete', 'KNOWN GAP: deleted/banned youtube messages stay on screen'],
])

describe('websocket contract', () => {
  test('the extension handles a substantial set of server messages', () => {
    expect(handledTypes().size).toBeGreaterThan(40)
  })

  test.skipIf(!siteRoot)('every type the server sends is handled or explicitly excused', () => {
    const handled = handledTypes()
    const client = clientTypes(siteRoot)
    const gaps = [...serverSentTypes(siteRoot).entries()]
      .filter(([t]) => !handled.has(t) && !client.has(t) && !NOT_FOR_EXTENSION.has(t))
      .map(([t, f]) => `${t} (emitted in ${f})`)
    expect(gaps, 'server sends this and the extension silently drops it — handle it, or list it with a reason').toEqual(
      [],
    )
  })

  test.skipIf(!siteRoot)('no excuse outlives the message it excuses', () => {
    // Otherwise the list rots into permission to ignore things that no longer exist.
    const sent = serverSentTypes(siteRoot)
    const client = clientTypes(siteRoot)
    const stale = [...NOT_FOR_EXTENSION.keys()].filter((t) => !sent.has(t) && !client.has(t))
    expect(stale, 'these are no longer sent by the server — delete the entry').toEqual([])
  })
})
