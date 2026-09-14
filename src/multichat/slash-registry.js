/**
 * Slash command registry — THE source of truth for every heatsync command.
 *
 * Before this file there were six lists: SLASH_COMMANDS and SLASH_HELP_LINES and
 * SLASH_ALIASES here, and SLASH_SUGGESTIONS + SLASH_ALIASES + HELP_LINES in the
 * site repo. They drifted, and the site's copy ended up advertising thirteen
 * commands that Twitch stopped parsing in Feb 2023 — typing /ban on heatsync.org
 * posted the literal text "/ban <name>" into chat. Autocomplete, /help, the
 * public /commands page and the alias map are now all projections of this array,
 * so that class of lie cannot come back.
 *
 * Written as ESM: build.js `stripExports` rewrites `export const` to `const`, so
 * this lands in the extension bundle as a plain top-level const (same mechanism
 * palette.js and send-targets.js already use) while the site repo imports it
 * normally. It MUST be listed in MULTICHAT_MODULES before input.js.
 *
 * Fields:
 *   cmd    canonical name, no slash
 *   args   literal usage; '' when it takes none
 *   desc   plain description — NO metadata in the prose; that is what the
 *          other fields are for
 *   on     'ext' | 'web' | 'both' — which composer actually implements it.
 *          The two surfaces are genuinely not at parity; a list that pretends
 *          otherwise is wrong on one of them.
 *   needs  single strictest requirement: 'none' | 'login' | 'twitch' | 'mod' |
 *          'broadcaster'. Deliberately scalar — a set turns this into a matrix.
 *   does   where the effect lands: 'local' (never leaves the browser) |
 *          'heatsync' | 'twitch' | 'kick' | 'twitch+kick' | 'passthrough'
 *          (the platform parses it, we only format the wire)
 *   alias  optional shorthands; the alias map is derived from these
 *   warn   optional: 'bits' (spends the user's real money) | 'destructive'
 *   hidden optional: implemented but never advertised, so the coverage test can
 *          be total instead of carrying an allowlist
 */

export const SLASH_REGISTRY = [
  // ── everyday ──────────────────────────────────────────────────────────────
  {
    cmd: 'op',
    args: '<text>',
    desc: 'post a thread to your heatsync feed',
    on: 'both',
    needs: 'login',
    does: 'heatsync',
    alias: ['post'],
  },
  {
    cmd: 'opr',
    args: '<text>',
    desc: 'reply to the last [OP] shown in chat',
    on: 'ext',
    needs: 'login',
    does: 'heatsync',
  },
  {
    cmd: 'dm',
    args: '<user> <msg>',
    desc: 'send a heatsync DM; no message opens the conversation',
    on: 'both',
    needs: 'login',
    does: 'heatsync',
  },
  {
    cmd: 'w',
    args: '<user> <msg>',
    desc: 'send a twitch whisper',
    on: 'both',
    needs: 'twitch',
    does: 'twitch',
    alias: ['whisper'],
  },
  {
    cmd: 'r',
    args: '<msg>',
    desc: 'reply to the last whisper you received',
    on: 'ext',
    needs: 'twitch',
    does: 'twitch',
    alias: ['re', 'reply'],
  },
  {
    cmd: 'user',
    args: '<name>',
    desc: 'open a profile card with recent logs',
    on: 'web',
    needs: 'none',
    does: 'heatsync',
    alias: ['u'],
  },
  {
    cmd: 'follow',
    args: '<user>',
    desc: 'follow on heatsync, mirrored to twitch and kick',
    on: 'ext',
    needs: 'login',
    does: 'heatsync',
  },
  {
    cmd: 'unfollow',
    args: '<user>',
    desc: 'unfollow on heatsync, mirrored to twitch and kick',
    on: 'ext',
    needs: 'login',
    does: 'heatsync',
  },
  { cmd: 'me', args: '<action>', desc: 'send an action message', on: 'both', needs: 'none', does: 'twitch+kick' },
  { cmd: 'shrug', args: '[text]', desc: 'append ¯\\_(ツ)_/¯', on: 'both', needs: 'none', does: 'local' },
  { cmd: 'tableflip', args: '[text]', desc: 'append (╯°□°)╯︵ ┻━┻', on: 'both', needs: 'none', does: 'local' },
  { cmd: 'unflip', args: '[text]', desc: 'append ┬─┬ノ( ゜-゜ノ)', on: 'both', needs: 'none', does: 'local' },
  { cmd: 'help', args: '', desc: 'list commands', on: 'both', needs: 'none', does: 'local', alias: ['?'] },

  // ── this window only — nothing leaves the browser ─────────────────────────
  {
    cmd: 'lclear',
    args: '',
    desc: 'clear the current tab for you only',
    on: 'both',
    needs: 'none',
    does: 'local',
    alias: ['lc'],
  },
  {
    cmd: 'mute',
    args: '<user>',
    desc: 'mute someone for 24h, across their linked accounts',
    on: 'ext',
    needs: 'none',
    does: 'local',
  },
  { cmd: 'unmute', args: '<user>', desc: 'clear a mute', on: 'ext', needs: 'none', does: 'local' },
  { cmd: 'block', args: '<user>', desc: 'toggle a block', on: 'ext', needs: 'login', does: 'heatsync' },
  {
    cmd: 'hide',
    args: '<user>',
    desc: 'hide someone in this tab only, until reload',
    on: 'ext',
    needs: 'none',
    does: 'local',
  },
  { cmd: 'unhide', args: '<user>', desc: 'undo a hide', on: 'ext', needs: 'none', does: 'local' },
  {
    cmd: 'note',
    args: '<user> <text>',
    desc: 'save a private note on someone',
    on: 'ext',
    needs: 'login',
    does: 'heatsync',
  },
  { cmd: 'delnote', args: '<user>', desc: 'remove your note', on: 'ext', needs: 'login', does: 'heatsync' },
  {
    cmd: 'set',
    args: '<setting> <value>',
    desc: 'change a setting, e.g. /set zebra off',
    on: 'ext',
    needs: 'none',
    does: 'local',
  },
  {
    cmd: 'tab',
    args: '<name>',
    desc: 'switch tab: live, feed, mentions, whispers, settings, or a channel',
    on: 'ext',
    needs: 'none',
    does: 'local',
  },
  {
    cmd: 'status',
    args: '[channel]',
    desc: 'show chat modes and stream info',
    on: 'ext',
    needs: 'none',
    does: 'local',
    alias: ['modes'],
  },

  // ── moderation ────────────────────────────────────────────────────────────
  {
    cmd: 'ban',
    args: '<user> [reason]',
    desc: 'permanently ban someone from the channel',
    on: 'ext',
    needs: 'mod',
    does: 'twitch+kick',
    alias: ['b'],
  },
  {
    cmd: 'timeout',
    args: '<user> [secs] [reason]',
    desc: 'time someone out, default 10 minutes',
    on: 'ext',
    needs: 'mod',
    does: 'twitch+kick',
    alias: ['to'],
  },
  {
    cmd: 'unban',
    args: '<user>',
    desc: 'lift a ban or end a timeout',
    on: 'ext',
    needs: 'mod',
    does: 'twitch+kick',
    alias: ['untimeout', 'unto'],
  },
  {
    cmd: 'delete',
    args: '<msg-id>',
    desc: 'delete a single message',
    on: 'ext',
    needs: 'mod',
    does: 'twitch+kick',
    alias: ['del'],
  },
  {
    cmd: 'nuke',
    args: '<term> [secs]',
    desc: 'bulk-delete recent messages containing a term',
    on: 'ext',
    needs: 'mod',
    does: 'twitch',
    warn: 'destructive',
  },
  {
    cmd: 'announce',
    args: '<msg>',
    desc: 'post an announcement, optionally coloured',
    on: 'ext',
    needs: 'mod',
    does: 'twitch',
    alias: ['announceblue', 'announcegreen', 'announceorange', 'announcepurple'],
  },
  { cmd: 'vip', args: '<user>', desc: 'grant VIP', on: 'ext', needs: 'broadcaster', does: 'twitch' },
  { cmd: 'unvip', args: '<user>', desc: 'remove VIP', on: 'ext', needs: 'broadcaster', does: 'twitch' },
  { cmd: 'mod', args: '<user>', desc: 'grant moderator', on: 'ext', needs: 'broadcaster', does: 'twitch' },
  { cmd: 'unmod', args: '<user>', desc: 'remove moderator', on: 'ext', needs: 'broadcaster', does: 'twitch' },

  // ── chat modes ────────────────────────────────────────────────────────────
  {
    cmd: 'slow',
    args: '[secs|off]',
    desc: 'slow mode, default 30s',
    on: 'ext',
    needs: 'mod',
    does: 'twitch+kick',
    alias: ['slowmode'],
  },
  {
    cmd: 'followers',
    args: '[mins|off]',
    desc: 'followers-only mode',
    on: 'ext',
    needs: 'mod',
    does: 'twitch+kick',
    alias: ['followersonly', 'followeronly'],
  },
  {
    cmd: 'emoteonly',
    args: '[off]',
    desc: 'emote-only mode',
    on: 'ext',
    needs: 'mod',
    does: 'twitch+kick',
    alias: ['emote', 'emoteonlymode'],
  },
  {
    cmd: 'subscribers',
    args: '[off]',
    desc: 'subscribers-only mode',
    on: 'ext',
    needs: 'mod',
    does: 'twitch+kick',
    alias: ['subonly', 'subsonly', 'subscribersonly', 'subs'],
  },
  {
    cmd: 'unique',
    args: '[off]',
    desc: 'unique-chat mode; twitch only, kick has no equivalent',
    on: 'ext',
    needs: 'mod',
    does: 'twitch',
    alias: ['uniquechat', 'r9k', 'r9kbeta'],
  },

  // ── polls, predictions, bits ──────────────────────────────────────────────
  {
    cmd: 'poll',
    args: '<q> | <a> | <b> [| …] [| secs]',
    desc: 'create a poll, 2-5 choices',
    on: 'ext',
    needs: 'broadcaster',
    does: 'twitch',
  },
  { cmd: 'endpoll', args: '', desc: 'end the active poll', on: 'ext', needs: 'broadcaster', does: 'twitch' },
  {
    cmd: 'vote',
    args: '<n>',
    desc: 'vote for choice n in the active poll',
    on: 'ext',
    needs: 'twitch',
    does: 'twitch',
  },
  {
    cmd: 'prediction',
    args: '<title> | <a> | <b> [| …] [| secs]',
    desc: 'start a prediction, 2-10 outcomes',
    on: 'ext',
    needs: 'broadcaster',
    does: 'twitch',
    alias: ['pred', 'predict'],
  },
  {
    cmd: 'bet',
    args: '<n> <points>',
    desc: 'bet channel points on outcome n',
    on: 'ext',
    needs: 'twitch',
    does: 'twitch',
  },
  { cmd: 'lockpred', args: '', desc: 'lock the active prediction', on: 'ext', needs: 'broadcaster', does: 'twitch' },
  {
    cmd: 'resolvepred',
    args: '<n>',
    desc: 'resolve the prediction to outcome n',
    on: 'ext',
    needs: 'broadcaster',
    does: 'twitch',
  },
  {
    cmd: 'cancelpred',
    args: '',
    desc: 'cancel the active prediction',
    on: 'ext',
    needs: 'broadcaster',
    does: 'twitch',
  },
  {
    cmd: 'highlight',
    args: '<msg>',
    desc: 'highlight your message in twitch chat',
    on: 'ext',
    needs: 'twitch',
    does: 'twitch',
    alias: ['hl'],
    warn: 'bits',
  },

  // ── never advertised ──────────────────────────────────────────────────────
  {
    cmd: 'testnotices',
    args: '[raw]',
    desc: 'render one synthetic row per twitch event type',
    on: 'ext',
    needs: 'none',
    does: 'local',
    hidden: true,
  },
]

/** Sections for /help and the public /commands page, in reading order. */
export const SLASH_SECTIONS = [
  {
    key: 'everyday',
    title: 'everyday',
    cmds: ['op', 'opr', 'dm', 'w', 'r', 'user', 'follow', 'unfollow', 'me', 'shrug', 'tableflip', 'unflip', 'help'],
  },
  {
    key: 'local',
    title: 'this window only',
    cmds: ['lclear', 'mute', 'unmute', 'block', 'hide', 'unhide', 'note', 'delnote', 'set', 'tab', 'status'],
  },
  {
    key: 'mod',
    title: 'moderation',
    cmds: ['ban', 'timeout', 'unban', 'delete', 'nuke', 'announce', 'vip', 'unvip', 'mod', 'unmod'],
  },
  { key: 'modes', title: 'chat modes', cmds: ['slow', 'followers', 'emoteonly', 'subscribers', 'unique'] },
  {
    key: 'events',
    title: 'polls, predictions, bits',
    cmds: ['poll', 'endpoll', 'vote', 'prediction', 'bet', 'lockpred', 'resolvepred', 'cancelpred', 'highlight'],
  },
]

/** Commands safe to advertise on a given surface. */
export function slashCommandsFor(surface) {
  return SLASH_REGISTRY.filter((c) => !c.hidden && (c.on === 'both' || c.on === surface))
}

/** alias -> canonical, derived so the two can never disagree. */
export function slashAliasMap(surface) {
  const src = surface ? slashCommandsFor(surface) : SLASH_REGISTRY.filter((c) => !c.hidden)
  const out = {}
  for (const c of src) for (const a of c.alias || []) out[a] = c.cmd
  return out
}

/**
 * Plain-text help, column-aligned by padEnd rather than by hand. The old
 * hand-counted version is why nobody maintained it: it advertised a debug-only
 * command and omitted fourteen shipped ones.
 */
export function slashHelpText(surface) {
  const cmds = slashCommandsFor(surface)
  const usage = (c) => `/${c.cmd}${c.args ? ' ' + c.args : ''}`
  const lines = []
  for (const sec of SLASH_SECTIONS) {
    const rows = sec.cmds.map((n) => cmds.find((c) => c.cmd === n)).filter(Boolean)
    if (!rows.length) continue
    // per-section width: one global column makes /prediction's long signature
    // pad every short row in the list out to nothing
    const width = Math.min(34, Math.max(...rows.map((c) => usage(c).length)) + 2)
    if (lines.length) lines.push('')
    lines.push(`── ${sec.title}`)
    for (const c of rows) lines.push(`${usage(c).padEnd(width)}${c.desc}`)
  }
  return lines.join('\n')
}
