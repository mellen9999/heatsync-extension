/**
 * The vod tab's chrome: it is a replay, not a temporary stream tab. Its own plain title, no keep /
 * save / move / rename, no popout button, and no path that puts a vod into config.channels.
 * Real code carved from the source (the repo's pattern), free names resolved through a stub scope.
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { mainSource } from './main-src.js'

const ROOT = join(import.meta.dir, '..')
const MC = join(ROOT, 'src', 'multichat')
const read = (f) => readFileSync(join(MC, f), 'utf8')
const fn = (src, name) => {
  const s = src.indexOf(`function ${name}(`)
  if (s < 0) throw new Error(`no ${name}`)
  const from = src.slice(s - 6, s) === 'async ' ? s - 6 : s
  return src.slice(from, src.indexOf('\n}\n', s) + 3)
}
const any = new Proxy(() => {}, { get: (_t, k) => (k === Symbol.toPrimitive ? () => '' : any), apply: () => undefined })
// free names not given resolve to a do-nothing function; real globals stay real (a name another test
// file left on globalThis as undefined is not one: the suite shares one global)
const scopeOf = (own) =>
  new Proxy(own, {
    has: (t, k) => typeof k === 'string' && (k in t || globalThis[k] === undefined),
    get: (t, k) => (k === Symbol.unscopables ? undefined : k in t ? t[k] : any),
    set: (o, k, v) => {
      o[k] = v
      return true
    },
  })
const runIn = (own, code) => new Function('scope', `with (scope) { ${code} }`)(scopeOf(own))

const MT = read('main-tabs.js')
const PA = read('panel-actions.js')
const VR = read('vod-replay.js')
const MAIN = mainSource()
const CM = read('channel-mgmt.js')
const en = JSON.parse(readFileSync(join(ROOT, 'src/_locales/en/messages.json'), 'utf8'))

function stripWith(currentTab, extra = {}) {
  const win = new Window({ url: 'https://www.twitch.tv/videos/2934223993' })
  const doc = win.document
  doc.body.innerHTML = '<div id="bar"><button class="hs-mc-popout-btn" style="">x</button></div>'
  const own = {
    document: doc,
    tabBarElement: doc.getElementById('bar'),
    currentTab,
    config: { channels: [] },
    hostPlatform: 'twitch',
    _autoSwitching: false,
    _restoreParts: null,
    _bouncedFromLive: '',
    _liveSyncArmed: false,
    vodId: '2934223993',
    twitchVodId: () => own.vodId,
    setVod: (v) => (own.vodId = v),
    mcCanonTab: (id, sub) => ({ id, sub }),
    log() {},
    _isChatTab: () => true,
    getLiveChannel: () => 'owner',
    liveTarget: () => 'live',
    performance: { now: () => 0 },
    location: { pathname: '/videos/2934223993' },
    vodNew: (id, prev) => ({ id, prev }),
    vodTick() {},
    cleanup: { addEventListener: () => () => {}, setTimeout: () => 0, clearTimeout() {} },
    vodStopWatching() {},
    ...extra,
  }
  return { own, btn: doc.querySelector('.hs-mc-popout-btn') }
}
const SYNC = `${fn(PA, 'resolvePopoutContext')}\n${fn(PA, 'updatePopoutBtnVisibility')}\n${fn(VR, 'vodTabEl')}\n${fn(VR, 'vodGoTo')}\n${fn(VR, 'vodSync')}\nlet _vod = null, _vodClickOff = null;`

describe('no popout button on the vod tab', () => {
  test('landing on the vod tab through the real vodSync hides the button, whatever the switch did', () => {
    // a switch that only flips the tab (the strip's button is not its business)
    const { own, btn } = stripWith('live', { switchTab: (id) => (own.currentTab = id) })
    runIn(own, `${SYNC}\n vodSync()`)
    expect(own.currentTab).toBe('vod')
    expect(btn.style.display).toBe('none')
  })

  test('landing through the real switchTab hides it too, and leaving the vod brings it back', () => {
    const { own, btn } = stripWith('live')
    own.liveTarget = () => 'live'
    runIn(own, `${fn(MT, 'switchTab')}\n${SYNC}\n vodSync()`)
    expect(own.currentTab).toBe('vod')
    expect(btn.style.display).toBe('none')
  })

  test('the leave path: back on the tab the reader was on, the button follows that tab', () => {
    const { own, btn } = stripWith('live', { switchTab: (id) => (own.currentTab = id) })
    own.getLiveChannel = () => 'owner'
    runIn(
      own,
      `${SYNC}
 vodSync(); setVod(''); vodSync()`,
    )
    expect(own.currentTab).toBe('live')
    expect(btn.style.display).toBe('')
  })
})

describe('the vod tab reads as a replay, not a temporary tab', () => {
  test('its title is its own, and says it closes when you leave', () => {
    expect(en.mc_tab_vod_title.message).toBe("this vod's replay chat · closes when you leave")
    const html = runIn(
      { escapeHtml: (s) => s, t: (k) => en[k]?.message ?? k },
      `${fn(MAIN, 'mcTabButtonHtml')}\n return mcTabButtonHtml({ id: 'vod', labelKey: 'mc_tab_vod', titleKey: 'mc_tab_vod_title', temp: true })`,
    )
    expect(html).toContain('title="this vod\'s replay chat')
    expect(html).not.toContain('right-click to keep')
    const live = runIn(
      { escapeHtml: (s) => s, t: (k) => en[k]?.message ?? k },
      `${fn(MAIN, 'mcTabButtonHtml')}\n return mcTabButtonHtml({ id: 'live', labelKey: 'mc_tab_live', temp: true })`,
    )
    expect(live).toContain('right-click to keep')
  })

  test('the real registry gives the vod tab that title', () => {
    const reg = read('tab-registry.js')
    expect(reg).toMatch(/id: 'vod',[^}]*titleKey: 'mc_tab_vod_title'/)
  })

  test('34 locales carry the title', () => {
    const dirs = readdirSync(join(ROOT, 'src/_locales'))
    expect(dirs.length).toBe(34)
    for (const d of dirs) {
      const m = JSON.parse(readFileSync(join(ROOT, 'src/_locales', d, 'messages.json'), 'utf8'))
      expect([d, typeof m.mc_tab_vod_title?.message]).toEqual([d, 'string'])
    }
  })
})

describe('a vod can never be saved', () => {
  function rightClick(tabId, over = {}) {
    let handler
    const container = {
      addEventListener: (t, f) => {
        if (t === 'contextmenu') handler = f
      },
      querySelector: () => null,
    }
    const at = MAIN.indexOf("container.addEventListener('contextmenu', (e) => {")
    const code = MAIN.slice(at, MAIN.indexOf('  return container', at))
    const win = new Window()
    const calls = { keep: 0, items: [], prevented: 0 }
    const own = {
      container,
      document: win.document,
      cleanup: { setTimeout: () => 0 },
      mcSignal: undefined,
      keepLiveTab: () => calls.keep++,
      mcIsReservedTab: (id) => ['live', 'vod', 'feed'].includes(id),
      t: (k) => k,
      ...over,
    }
    runIn(own, code)
    const tab = { dataset: { tab: tabId }, classList: { contains: () => false, remove() {} } }
    handler({
      target: { closest: () => tab },
      preventDefault: () => calls.prevented++,
      clientX: 1,
      clientY: 1,
    })
    return { calls, menu: win.document.getElementById('hs-mc-ctx-menu') }
  }

  test('right-click on the vod tab opens no menu, so there is no keep', () => {
    const { calls, menu } = rightClick('vod')
    expect(menu).toBeNull()
    expect(calls.keep).toBe(0)
    expect(calls.prevented).toBe(1)
  })

  test('right-click on the live temp tab still offers keep', () => {
    const { menu } = rightClick('live')
    expect(menu?.textContent).toContain('mc_tab_keep')
  })

  test('keepLiveTab itself refuses on the vod tab: config.channels never gains an entry', () => {
    const saves = []
    const own = {
      currentTab: 'vod',
      _keepingLive: false,
      getLiveChannel: () => 'owner',
      liveTabShown: () => true,
      hostPlatform: 'twitch',
      resolveLiveCandidateToTab: (c) => saves.push(c),
      config: { channels: [] },
    }
    runIn(own, `${fn(MAIN, 'keepLiveTab')}\n keepLiveTab()`)
    expect(saves).toEqual([])
    expect(own.config.channels).toEqual([])
    own.currentTab = 'live'
    runIn(own, `${fn(MAIN, 'keepLiveTab')}\n keepLiveTab()`)
    expect(saves.length).toBe(1) // the guard is the vod's, not a blanket refusal
  })

  test('move / remove / edit leave a vod id alone (no config row to act on)', () => {
    const own = { config: { channels: [{ id: 'xqc' }, { id: 'a' }] }, getChannelById: () => null }
    const r = runIn(
      own,
      `${fn(CM, 'moveChannelOrder')}\n${fn(CM, 'channelMoveOptions')}\n return [moveChannelOrder('vod', 1), channelMoveOptions('vod')]`,
    )
    expect(r[0]).toBe(false)
    expect(r[1]).toEqual([])
    expect(own.config.channels.map((c) => c.id)).toEqual(['xqc', 'a'])
  })
})
