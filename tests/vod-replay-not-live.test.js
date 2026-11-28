// A replay row is not a live message. The vod tab draws twitch's own past chat through the pane's
// ordinary append/build path, and that path is full of live-only habits: the first-message glow,
// "seen" tracking, mention styling, highlight rules. A row marked
// `replay` (vod-replay.js) trips none of them, and a live row is untouched by that.
//
// Real code, carved: buildMessageDiv + appendMessage (main-messages.js), isMention (mentions.js),
// rowReplyState (hover-reply.js), the render's follow-event merge and banner block (main-live.js),
// openUserCtxMenu (input.js), the mod toolbar hover (mod-toolbar.js), the popout resolver
// (panel-actions.js). Free identifiers resolve through a recording scope.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { stripComments } from './lib/strip-comments.mjs'

const MC = join(import.meta.dir, '..', 'src', 'multichat')
const read = (f) => readFileSync(join(MC, f), 'utf8')
const MSG = read('main-messages.js')
const LIVE = read('main-live.js')
const MENTIONS = read('mentions.js')
const HOVER = read('hover-reply.js')
const INPUT = read('input.js')
const MODBAR = read('mod-toolbar.js')
const PANEL = read('panel-actions.js')
const VOD = read('vod-replay.js')

/** a top-level function, whole: from its `function` line to the first column-0 closing brace */
function fn(src, name) {
  const s = src.indexOf(`function ${name}(`)
  if (s < 0) throw new Error(`no function ${name}`)
  return src.slice(s, src.indexOf('\n}\n', s) + 2)
}
function carve(src, a, b) {
  const s = src.indexOf(a)
  if (s < 0) throw new Error(`carve start not found: ${a}`)
  const e = src.indexOf(b, s)
  if (e < 0) throw new Error(`carve end not found: ${b}`)
  return src.slice(s, e)
}

let win
beforeEach(() => {
  win = new Window()
})
afterEach(() => win?.happyDOM?.close?.())

/** free identifiers not given resolve to a do-nothing function; real globals stay the real ones (a name
 *  another test file left on globalThis as undefined is not one: the suite shares one global) */
function scopeOf(real) {
  return new Proxy(real, {
    has: (t, k) => typeof k === 'string' && (k in t || globalThis[k] === undefined),
    get: (t, k) => (k in t ? t[k] : () => ''),
  })
}
const run = (src, scope, ret) => new Function('scope', `with (scope) { ${src}\n return ${ret} }`)(scope)

// ── buildMessageDiv: the row a replay line gets ──────────────────────────────────────────────
function pane(over = {}) {
  const calls = { seen: [], lookups: [] }
  const real = {
    document: win.document,
    calls,
    isMsgUserDropped: () => false,
    isPlatformHiddenInTab: () => false,
    hermesToggles: {},
    streamColorMap: new Map(),
    knownUserIds: new Map(),
    knownColors: new Map(),
    _nativeTwitchColor: new Set(),
    _hsUserIdCache: new Map(),
    redeemTitleMap: new Map(),
    _sharedChatLoginCache: new Map(),
    avatarCache: new Map(),
    userKey: (n, p) => `${p}:${n}`,
    platformMark: () => ({ cls: 'twitch', label: 'T', color: '#fff' }),
    hsOriginStamp: () => false,
    isSelf: () => false,
    avatarsEnabled: false,
    firstChatterGlow: true,
    timestampsEnabled: false,
    platformBadgesEnabled: false,
    mediaEmbedsEnabled: false,
    linksEnabled: true,
    dimTimeouts: false,
    hostPlatform: 'twitch',
    escapeHtml: (s) => String(s),
    sanitizeColor: (c) => c,
    t: (k) => k,
    isMention: (m) => !!m.mentionsMe,
    markChatterSeen: (ch, u) => {
      calls.seen.push([ch, u])
      return true
    },
    evaluateFilterRules: (m) => ({ highlight: m.ruleColor || null }),
    ruleScopeOf: () => 'scope',
    ruleFillVar: (c) => c,
    renderBadges: () => '',
    hsPaintRender: () => null,
    getMcPaintStyle: () => '',
    mcCosmeticsNeedLookup: () => false,
    queueMcCosmeticsLookup: (u) => calls.lookups.push(['cosmetics', u]),
    getHsPlusTenureSince: () => null,
    computeMessageText: (m) => String(m.text),
    rowFill: () => '',
    hsBigRowOk: () => false,
    formatTimeFromTs: () => '12:00',
    _unkickEmotes: (s) => s,
    paintPhaseNow: () => 0,
    hsNameColourDecl: () => '',
    appendRowMedia() {},
    // the stamp is vod-replay.js's own, run for real
    vodStampHtml: new Function(
      'escapeHtml',
      't',
      `${fn(VOD, 'vodOffsetSecs')}${fn(VOD, 'vodStampHtml')}\nreturn vodStampHtml`,
    )(
      (s) => String(s),
      (k) => k,
    ),
    ...over,
  }
  const build = run(`${fn(MSG, 'buildMessageDiv')}`, scopeOf(real), 'buildMessageDiv')
  return { build, calls }
}

const LINE = { id: 'a1', user: 'alice', login: 'alice', text: 'hi', channel: 'xqc', time: 1000, color: '#ff0000' }
const REPLAY = { ...LINE, id: 'vod:1:0', replay: true, replayAt: '2:00:14' }

describe('a replay row draws without the live habits', () => {
  test('the first-message glow and the seen set: a live row is marked, a replay row is not, and is never entered', () => {
    const p = pane()
    expect(p.build({ ...LINE }, 'live').classList.contains('hs-first-msg')).toBe(true)
    expect(p.calls.seen).toEqual([['xqc', 'alice']])
    p.calls.seen.length = 0
    const row = p.build({ ...REPLAY }, 'vod')
    expect(row.classList.contains('hs-first-msg')).toBe(false)
    expect(row.classList.contains('hs-row-seen')).toBe(false)
    expect(p.calls.seen).toEqual([]) // a replayed chatter must not turn the live room's first-timer glow off
  })

  test('mention styling: a live row that pings you is marked, a replay row that says the same is not', () => {
    const p = pane()
    expect(p.build({ ...LINE, mentionsMe: true }, 'live').classList.contains('mention')).toBe(true)
    // isMention itself says no to a replay (below); the row follows it
    const q = pane({ isMention: (m) => !m.replay && !!m.mentionsMe })
    expect(q.build({ ...REPLAY, mentionsMe: true }, 'vod').classList.contains('mention')).toBe(false)
  })

  test('a highlight rule accents a live row and not a replay row', () => {
    const p = pane()
    expect(p.build({ ...LINE, ruleColor: '#ffff00' }, 'live').classList.contains('hs-mc-rule-highlight')).toBe(true)
    expect(p.build({ ...REPLAY, ruleColor: '#ffff00' }, 'vod').classList.contains('hs-mc-rule-highlight')).toBe(false)
  })

  test('no row draws a hover thread button, live or replay (quote lives in the row menu)', () => {
    const p = pane()
    expect(p.build({ ...LINE }, 'live').querySelector('.hs-mc-thread-btn')).toBeNull()
    expect(p.build({ ...REPLAY }, 'vod').querySelector('.hs-mc-thread-btn')).toBeNull()
  })

  test('the row says it is a replay row, for every action that reads rows', () => {
    const p = pane()
    expect(p.build({ ...REPLAY }, 'vod').dataset.hsReplay).toBe('1')
    expect(p.build({ ...LINE }, 'live').dataset.hsReplay).toBeUndefined()
  })

  test('names, paints and the rest of a replay row still draw (render lookups are kept)', () => {
    const p = pane({ knownUserIds: new Map([['twitch:alice', '42']]), mcCosmeticsNeedLookup: () => true })
    const row = p.build({ ...REPLAY }, 'vod')
    expect(row.querySelector('.hs-mc-user')?.textContent).toBe('alice')
    expect(row.querySelector('.hs-mc-text')?.textContent).toBe('hi')
    expect(p.calls.lookups).toEqual([['cosmetics', '42']])
  })
})

// ── the stamp: the video's time, not a wall clock ────────────────────────────────────────────
describe('the stamp slot', () => {
  test('timestamps on: a live row shows the clock, a replay row shows the video offset', () => {
    const p = pane({ timestampsEnabled: true })
    expect(p.build({ ...LINE }, 'live').querySelector('.hs-mc-ts')?.textContent).toBe('12:00')
    const ts = p.build({ ...REPLAY }, 'vod').querySelector('.hs-mc-ts')
    expect(ts?.textContent).toBe('2:00:14')
  })
  test('timestamps off: a replay row has no stamp', () => {
    const p = pane({ timestampsEnabled: false })
    expect(p.build({ ...REPLAY }, 'vod').querySelector('.hs-mc-ts')).toBeNull()
  })
  test('a replay row with no offset has no stamp, never a wall clock in its place', () => {
    const p = pane({ timestampsEnabled: true })
    expect(p.build({ ...REPLAY, replayAt: '' }, 'vod').querySelector('.hs-mc-ts')).toBeNull()
  })
  test('the stamp is a button that seeks (the click is tested in vod-replay.test.js)', () => {
    const p = pane({ timestampsEnabled: true })
    const ts = p.build({ ...REPLAY }, 'vod').querySelector('.hs-mc-ts')
    expect(ts?.getAttribute('role')).toBe('button')
    expect(ts?.dataset.hsSeek).toBe('2:00:14')
  })
})

// ── isMention ────────────────────────────────────────────────────────────────────────────────
describe('isMention', () => {
  const make = () =>
    new Function(
      'currentUsername',
      '_aliases',
      'isEnabled',
      'isUserBlocked',
      'authState',
      'selfKickName',
      `${MENTIONS.slice(MENTIONS.indexOf('function escapeRegex('), MENTIONS.indexOf('// Browser notifications'))}
       mentionAliases = new Set(_aliases)
       return isMention`,
    )(
      'mellen',
      [],
      () => true,
      () => false,
      { nick: null },
      '',
    )
  test('a live line that names you pings; the same line replayed does not, nor a replayed reply to you', () => {
    const isMention = make()
    expect(isMention({ user: 'a', text: 'hey @mellen' })).toBe(true)
    expect(isMention({ user: 'a', text: 'hey @mellen', replay: true })).toBe(false)
    expect(isMention({ user: 'a', text: 'ok', replyTo: { user: 'mellen' } })).toBe(true)
    expect(isMention({ user: 'a', text: 'ok', replyTo: { user: 'mellen' }, replay: true })).toBe(false)
  })
})

// ── appendMessage: only replay rows land in the vod tab ──────────────────────────────────────
describe('the vod tab takes replay rows only', () => {
  function appender() {
    const rows = []
    const el = {
      get firstElementChild() {
        return rows[0] || null
      },
      get lastElementChild() {
        return rows.at(-1) || null
      },
      get childElementCount() {
        return rows.length
      },
      children: rows,
      appendChild: (r) => rows.push(r),
    }
    const real = {
      editingChannel: false,
      activeProfileCard: null,
      hsPanePanelOpen: () => false,
      predViewOpen: () => false,
      imgViewOpen: () => false,
      isScrolledUp: false,
      currentTab: 'vod',
      _filterFlags: () => ({ dups: false }),
      isMsgFiltered: () => false,
      ruleHides: () => false,
      lclearCutFor: () => 0,
      lastDrawnText: () => null,
      liveSearchQuery: () => '',
      isMultiPlatformTab: () => false,
      _skipHiddenRender: () => false,
      document: { getElementById: () => el },
      msgKeyOf: (m) => m.id,
      _msgKeyIndex: new Set(),
      built: [],
      buildMessageDiv(m) {
        real.built.push(m.id)
        return { dataset: {}, classList: { contains: () => false }, user: m.user }
      },
      _renderEpoch: 0,
      DOM_RENDER_CAP: 500,
      isUserMuted: () => false,
    }
    const append = run(fn(MSG, 'appendMessage'), scopeOf(real), 'appendMessage')
    return { rows, real, append }
  }
  test('a stream event, a notice or any live row aimed at the vod tab is dropped, handled, and never built', () => {
    const a = appender()
    const event = { type: 'stream-event', id: 'ev1', text: 'x switched to Counter-Strike', time: 1 }
    expect(a.append(event, 'vod')).toBe(true) // true = handled: the caller does not repaint the pane
    expect(a.append({ ...LINE }, 'vod')).toBe(true)
    expect(a.real.built).toEqual([])
    expect(a.rows).toHaveLength(0)
  })
  test('a replay row is drawn in it', () => {
    const a = appender()
    expect(a.append({ ...REPLAY }, 'vod')).toBe(true)
    expect(a.real.built).toEqual(['vod:1:0'])
    expect(a.rows).toHaveLength(1)
  })
  test('every other tab is exactly as it was', () => {
    const a = appender()
    a.real.currentTab = 'live'
    a.append({ type: 'stream-event', id: 'ev1', text: 'x', time: 1 }, 'live')
    expect(a.real.built).toEqual(['ev1'])
  })
})

describe('the render never merges live events into the vod buffer', () => {
  const MERGE = carve(LIVE, '  // Merge follow stream events into channel + live tabs', '  updateTabBadges()')
  function merge(id, buffer, activityEvents) {
    const real = { id, msgs: buffer, activityEvents, byTimeStable: (a, b) => (a.time || 0) - (b.time || 0) }
    return new Function('scope', `with (scope) { ${MERGE}\n return msgs }`)(scopeOf(real))
  }
  const follow = {
    type: 'stream-event',
    eventClass: 'event-follow event-update',
    text: 'x switched to Counter-Strike',
    time: 1,
  }
  test('the follow events a live tab merges in (at the top, they are older) do not go into the vod buffer', () => {
    const buf = [{ ...REPLAY, time: 5 }]
    merge('vod', buf, [follow])
    expect(buf).toEqual([{ ...REPLAY, time: 5 }])
  })
  test('a live tab still gets them', () => {
    const msgs = [{ ...LINE, time: 5 }]
    merge('live', msgs, [follow])
    expect(msgs.map((m) => m.type)).toEqual(['stream-event', undefined])
  })
})

describe('the render does not ask who "vod" is', () => {
  const BANNER = carve(LIVE, '  // Banner: streamer-tab only', '  // If search is active on mentions tab')
  function banner(id) {
    const asked = []
    const real = {
      id,
      asked,
      getLiveChannel: () => 'xqc',
      hostPlatform: 'twitch',
      maybeShowMultistreamBanner: (c) => asked.push(c),
      getChannelById: () => null,
      hideMultistreamBanner() {},
    }
    new Function('scope', `with (scope) { ${BANNER} }`)(scopeOf(real))
    return asked
  }
  test('a channel tab asks about its channel; the vod tab asks about nothing (it was an identity lookup for the word "vod")', () => {
    expect(banner('somechan')).toEqual(['somechan'])
    expect(banner('vod')).toEqual([])
  })
})

// ── row actions ──────────────────────────────────────────────────────────────────────────────
describe('hover reply and the row menu reach a replay row only for read-only actions', () => {
  const rowReplyState = new Function(`${fn(HOVER, 'rowReplyState')}\nreturn rowReplyState`)()
  const row = (extra = {}) => ({ dataset: { msgId: 'm1', msgUser: 'alice', msgChannel: 'xqc', ...extra } })
  test('reply: a live row has a target, a replay row has none (the menu, the hover button and row mode all read this)', () => {
    expect(rowReplyState(row())).toMatchObject({ msgId: 'm1', user: 'alice' })
    expect(rowReplyState(row({ hsReplay: '1' }))).toBeNull()
  })

  // the right-click menu, carved whole; the pane's helpers are recorded
  function menu(dataset, { mod = true } = {}) {
    let shown = null
    const el = {
      dataset: { msgId: 'm1', msgUser: 'alice', msgLogin: 'alice', msgChannel: 'xqc', msgPlatform: '', ...dataset },
      querySelector: () => null,
    }
    const real = {
      shown: null,
      t: (k) => k,
      hsRelPeek: () => null,
      isUserBlocked: () => false,
      isUserMuted: () => false,
      isUserHiddenInTab: () => false,
      currentTab: 'vod',
      gateAtBoot: () => true,
      rowReplyState,
      setReplyState() {},
      isSelf: () => false,
      isModForSync: () => mod,
      isKickModForSync: () => false,
      isYtModForSync: () => false,
      getChannelLookup: () => ({ twitch: new Map(), kick: new Map(), byId: new Map() }),
      buildRowPermalink: () => 'https://heatsync.org/logs/x',
      pinRoomOfRow: () => ({ platform: 'twitch', channel: 'xqc', room: 'twitch/xqc' }),
      pinCanAct: () => true,
      pinState: { pins: new Map() },
      hsNoteHas: () => false,
      hsPaintUidOfMsg: () => null,
      isLiveSearchTab: () => true,
      mcCopyToClipboard() {},
      showHsCtxMenu: (_x, _y, _u, items) => {
        shown = items
      },
      resolveIdentity: () => Promise.reject(new Error('no')),
      hsAuthToken: '',
      isOwnFeedPost: () => false,
      feedBookmarks: new Map(),
      _extractMcChainText: () => null,
      _extractMcMsgText: () => 'hi',
    }
    const open = run(fn(INPUT, 'openUserCtxMenu'), scopeOf(real), 'openUserCtxMenu')
    open(0, 0, 'alice', 'twitch', { msg: el })
    return (shown || []).filter((i) => i && i !== 'sep').map((i) => i.label)
  }

  test('a live row, to a mod: reply, op to feed, copy link, quote, the mod block and pin are all there', () => {
    const labels = menu({})
    for (const k of [
      'mc_input_reply',
      'mc_input_op_to_feed',
      'mc_input_copy_link',
      'mc_msg_quote_thread',
      'mc_input_delete_msg',
      'mc_input_timeout_10m',
      'content_card_ban',
      'content_card_unban',
      'mc_pin_menu_pin',
    ])
      expect([k, labels.includes(k)]).toEqual([k, true])
  })
  test('a replay row, to the same mod: no reply, no mod action, no pin, no post of it anywhere', () => {
    const labels = menu({ hsReplay: '1' })
    for (const k of [
      'mc_input_reply',
      'mc_input_op_to_feed',
      'mc_input_copy_link',
      'mc_msg_quote_thread',
      'mc_input_delete_msg',
      'mc_input_timeout_10m',
      'content_card_ban',
      'content_card_unban',
      'mc_pin_menu_pin',
      'mc_pin_menu_unpin',
      'mc_input_warn',
    ])
      expect([k, labels.includes(k)]).toEqual([k, false])
  })
  test('a replay row keeps copy and every read-only action', () => {
    const labels = menu({ hsReplay: '1' })
    for (const k of ['mc_input_copy_message', 'content_card_copy_name', 'mc_input_copy_to_input', 'mc_input_chat_logs'])
      expect([k, labels.includes(k)]).toEqual([k, true])
  })
})

describe('the mod toolbar and the popout', () => {
  test('hovering a replay row never builds the mod toolbar, a live row does', () => {
    const msgs = win.document.createElement('div')
    msgs.innerHTML =
      '<div class="hs-mc-msg" id="live" data-msg-id="m1" data-msg-user="alice" data-msg-channel="xqc"></div>' +
      '<div class="hs-mc-msg" id="rep" data-msg-id="vod:1:0" data-msg-user="alice" data-msg-channel="xqc" data-hs-replay="1"></div>'
    const built = []
    const real = {
      _modRow: null,
      isYtPlatform: () => false,
      isSelf: () => false,
      isModForSync: () => true,
      isKickModForSync: () => false,
      isYtModForSync: () => false,
      cancelModHide() {},
      buildModToolbarOnce: () => built.push('toolbar'),
      gateModButtons: () => true,
      attachToRow: (r) => built.push(r.id),
    }
    run(fn(MODBAR, 'wireModToolbarHover'), scopeOf(real), 'wireModToolbarHover')(msgs)
    const over = (el) => el.dispatchEvent(new win.MouseEvent('mouseover', { bubbles: true }))
    over(msgs.querySelector('#rep'))
    expect(built).toEqual([])
    over(msgs.querySelector('#live'))
    expect(built).toEqual(['toolbar', 'live'])
  })

  test('the popout button is hidden while the vod tab is active, and shown for a channel tab', () => {
    const btn = { hidden: false }
    const real = {
      currentTab: 'vod',
      tabBarElement: { querySelector: () => btn },
      // a saved channel that happens to be named vod (an old or imported config) must not get the button on the replay tab
      config: {
        channels: [
          { id: 'xqc', twitch: 'xqc' },
          { id: 'vod', twitch: 'vod' },
        ],
      },
      _isChatTab: (id) => id !== 'feed',
      getLiveChannel: () => 'xqc',
      hostPlatform: 'twitch',
    }
    const f = run(
      `${fn(PANEL, 'resolvePopoutContext')}\n${fn(PANEL, 'updatePopoutBtnVisibility')}`,
      scopeOf(real),
      '{ resolvePopoutContext, updatePopoutBtnVisibility }',
    )
    f.updatePopoutBtnVisibility()
    expect(f.resolvePopoutContext()).toBeNull()
    expect(btn.hidden).toBe(true)
    real.currentTab = 'xqc'
    f.updatePopoutBtnVisibility()
    expect(btn.hidden).toBe(false)
  })
})

describe('the vod tab is its own buffer, off every live path', () => {
  const SRC = stripComments(VOD)
  test('the module never touches a live buffer, the mentions list, the seen state, a counter or a relay', () => {
    for (const name of [
      'irc.channels',
      'kickChat',
      'channelYtMessages',
      'mentionsBuffer',
      'persistMentions',
      'notifyMention',
      'playFilterRuleSound',
      'noteSeenEvent',
      'bumpSeen',
      'bumpTabActivity',
      'updateTabIndicator',
      'bumpStreamStats',
      'markChatterSeen',
      'chatLogsLive',
      'chat:origin',
      'twitch:chat:relay',
      'saveStreamEvent',
      'setKnownColor',
    ])
      expect([name, SRC.includes(name)]).toEqual([name, false])
  })
  test('the pane has no way to reach a replay row but through appendMessage and the render of vodBuffer', () => {
    // every live fan-out (the message handlers) reads irc/kick/yt buffers; none reads vodBuffer
    const all = [MSG, LIVE, INPUT, read('main.js'), read('social.js'), read('irc.js')].join('\n')
    const readers = (all.match(/\bvodBuffer\b/g) || []).length
    expect(readers).toBe(1) // the render's one `msgs = vodBuffer`
  })
})
