import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// the 'live' tab is the temp tab: page channel's name, underlined, hidden when a
// saved tab covers that channel or the page has none. internal id stays 'live'.
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
const main = read('../src/multichat/main.js')
const input = read('../src/multichat/input.js')
const css = read('../src/multichat/styles/02-tab-bar.css')
const en = JSON.parse(read('../src/_locales/en/messages.json'))

// the temp-tab block of main.js (liveCoverId .. updateLiveTabLabel), run with fakes
const start = main.indexOf('/** The saved tab that already shows the page channel')
const end = main.indexOf('/** Query background script for all channels')
const block = main.slice(start, end)

function make(o = {}) {
  const env = {
    page: 'forsen',
    host: 'twitch',
    channels: [],
    hidden: new Set(),
    ytName: '',
    ytVideo: null,
    path: '/forsen',
    search: '',
    armed: true,
    tab: 'live',
    override: null,
    ...o,
  }
  const calls = { switched: [], resolved: [] }
  const btn = {
    textContent: '',
    title: '',
    style: { display: '' },
    _c: new Set(),
    classList: { add: (c) => btn._c.add(c), contains: (c) => btn._c.has(c) },
  }
  const f = new Function(
    'env',
    'calls',
    'btn',
    `
    let currentTab = env.tab
    let _bouncedFromLive = ''
    let _autoSwitching = false
    let _keepingLive = false
    let _liveSyncArmed = env.armed
    let liveChannel = env.override
    const hostPlatform = env.host
    const _autoYtVideoId = env.ytVideo
    const hiddenTabs = env.hidden
    const config = { channels: env.channels }
    const location = { pathname: env.path, search: env.search }
    const youtubeLinks = new Map([['__live_yt_auto__', { channelName: env.ytName }]])
    const ytSubscribedUrls = new Map()
    const tabBarElement = { querySelector: () => btn }
    const mcRowOwner = (id) => id
    const t = (k) => ({ mc_tab_live: 'watching', mc_tab_temp_title: 'TEMP' })[k] || k
    const getLiveChannel = () => liveChannel || env.page
    const getCurrentChannel = () => env.page
    const getLivePlatformNames = () => (env.legs || { twitch: '', kick: '', youtube: '' })
    const parseYoutubeChannelType = (p, s) => (/^\\/@/.test(p) ? 'handle' : /v=/.test(s) ? 'video' : null)
    const ytHandleLiveUrl = (p) => 'https://www.youtube.com' + p
    const switchTab = (id) => { calls.switched.push([id, _autoSwitching]); currentTab = id }
    const resolveLiveCandidateToTab = async (c) => { calls.resolved.push(c) }
    ${block}
    return { liveCoverId, liveTabShown, liveTarget, syncLiveTab, keepLiveTab, updateLiveTabLabel,
      st: () => ({ currentTab, _bouncedFromLive, _autoSwitching }),
      go: (o) => { if ('page' in o) env.page = o.page; if ('channels' in o) env.channels = o.channels; if ('tab' in o) currentTab = o.tab } }
  `,
  )(env, calls, btn)
  return { f, calls, btn }
}

describe('label', () => {
  test('shows the page channel name, underlined class, temp tooltip', () => {
    const { f, btn } = make()
    f.updateLiveTabLabel()
    expect(btn.textContent).toBe('forsen')
    expect(btn._c.has('hs-mc-tab-temp')).toBe(true)
    expect(btn.title).toBe('TEMP')
    expect(btn.style.display).toBe('')
  })
  test('underline is the only mark (css)', () => {
    expect(css).toMatch(/\.hs-mc-tab-temp\s*\{\s*text-decoration:\s*underline;\s*\}/)
  })
  test('youtube page with no resolved name falls back to the generic word, never a video id', () => {
    const { f, btn } = make({ host: 'yt', page: 'jfKfPfyJRdk', path: '/watch', search: '?v=jfKfPfyJRdk' })
    f.updateLiveTabLabel()
    expect(btn.textContent).toBe('watching')
  })
  test('locale copy', () => {
    expect(en.mc_tab_temp_title.message).toBe(
      'temporary tab: watching another stream takes its slot · right-click to keep',
    )
    expect(en.mc_tab_keep.message).toBe('keep tab')
  })
})

describe('visibility', () => {
  test('hidden when a saved tab covers the page channel', () => {
    const { f, btn } = make({ channels: [{ id: 'forsen', twitch: 'forsen', kick: '', youtube: '' }] })
    f.updateLiveTabLabel()
    expect(f.liveCoverId()).toBe('forsen')
    expect(btn.style.display).toBe('none')
  })
  test('a saved kick leg with the same name covers it too (same rule the live send uses)', () => {
    const { f } = make({ channels: [{ id: 'a', twitch: 'other', kick: 'forsen', youtube: '' }] })
    expect(f.liveTabShown()).toBe(false)
  })
  test('shown when the saved tabs are other channels', () => {
    const { f } = make({ channels: [{ id: 'xqc', twitch: 'xqc', kick: 'xqc', youtube: '' }] })
    expect(f.liveTabShown()).toBe(true)
  })
  test('hidden with no page channel', () => {
    const { f, btn } = make({ page: null, channels: [{ id: 'xqc', twitch: 'xqc' }] })
    f.updateLiveTabLabel()
    expect(btn.style.display).toBe('none')
    expect(f.liveTabShown()).toBe(false)
  })
  test('a youtube page is never covered by a same-name twitch tab', () => {
    const { f } = make({
      host: 'yt',
      page: 'forsen',
      path: '/@forsen',
      channels: [{ id: 'forsen', twitch: 'forsen', kick: 'forsen', youtube: '' }],
    })
    expect(f.liveCoverId()).toBe(null)
  })
  test('a youtube page is covered by a saved tab with that handle or video', () => {
    const a = make({
      host: 'yt',
      page: 'lofi',
      path: '/@lofi',
      channels: [{ id: 'x', youtube: 'https://www.youtube.com/@lofi/live' }],
    })
    expect(a.f.liveCoverId()).toBe('x')
    const b = make({
      host: 'yt',
      page: 'jfKfPfyJRdk',
      path: '/watch',
      search: '?v=jfKfPfyJRdk',
      channels: [{ id: 'y', youtube: 'https://www.youtube.com/watch?v=jfKfPfyJRdk' }],
    })
    expect(b.f.liveCoverId()).toBe('y')
  })
})

describe('liveTarget precedence', () => {
  const ch = [
    { id: 'xqc', twitch: 'xqc' },
    { id: 'forsen', twitch: 'forsen' },
  ]
  test('covering saved tab first', () => {
    expect(make({ channels: ch }).f.liveTarget()).toBe('forsen')
  })
  test('then live when the page has a channel', () => {
    expect(make({ channels: [ch[0]] }).f.liveTarget()).toBe('live')
  })
  test('then the first saved tab, skipping hidden ones', () => {
    expect(make({ page: null, channels: ch, hidden: new Set(['xqc']) }).f.liveTarget()).toBe('forsen')
    expect(make({ page: null, channels: ch }).f.liveTarget()).toBe('xqc')
  })
  test('then the feed', () => {
    expect(make({ page: null }).f.liveTarget()).toBe('feed')
  })
})

describe('sync (auto moves are not persisted, and are handed back)', () => {
  test('off the temp tab when the page loses its channel, back when it returns', () => {
    const { f, calls } = make({ page: null, channels: [{ id: 'xqc', twitch: 'xqc' }] })
    f.syncLiveTab()
    expect(calls.switched).toEqual([['xqc', true]])
    expect(f.st().currentTab).toBe('xqc')
    f.go({ page: 'forsen' })
    f.syncLiveTab()
    expect(calls.switched[1]).toEqual(['live', true])
  })
  test('a tab the user picked is never pulled back', () => {
    const { f, calls } = make({ tab: 'xqc', channels: [{ id: 'xqc', twitch: 'xqc' }] })
    f.syncLiveTab()
    expect(calls.switched).toEqual([])
  })
  test('moves to the covering saved tab', () => {
    const { f, calls } = make({ channels: [{ id: 'forsen', twitch: 'forsen' }] })
    f.syncLiveTab()
    expect(calls.switched).toEqual([['forsen', true]])
  })
  test('does nothing before boot has armed it', () => {
    const { f, calls } = make({ armed: false, page: null })
    f.syncLiveTab()
    expect(calls.switched).toEqual([])
  })
})

describe('keep tab', () => {
  test('promotes through resolveLiveCandidateToTab with the host platform', async () => {
    const { f, calls } = make()
    await f.keepLiveTab()
    expect(calls.resolved).toEqual([{ name: 'forsen', platform: 'twitch' }])
  })
  test('a second keep while one is in flight is dropped', async () => {
    const { f, calls } = make()
    await Promise.all([f.keepLiveTab(), f.keepLiveTab()])
    expect(calls.resolved.length).toBe(1)
  })
  test('nothing to keep when covered or channel-less', async () => {
    const a = make({ channels: [{ id: 'forsen', twitch: 'forsen' }] })
    await a.f.keepLiveTab()
    const b = make({ page: null })
    await b.f.keepLiveTab()
    expect(a.calls.resolved.length + b.calls.resolved.length).toBe(0)
  })
  test('youtube hands over the page url and handle, never a name guess', async () => {
    const { f, calls } = make({ host: 'yt', page: 'lofi', path: '/@lofi' })
    await f.keepLiveTab()
    expect(calls.resolved[0]).toEqual({
      name: 'lofi',
      platform: 'youtube',
      youtubeUrl: 'https://www.youtube.com/@lofi',
    })
    const v = make({ host: 'yt', page: 'jfKfPfyJRdk', path: '/watch', search: '?v=jfKfPfyJRdk' })
    await v.f.keepLiveTab()
    expect(v.calls.resolved[0]._videoId).toBe('jfKfPfyJRdk')
  })
})

describe('wiring', () => {
  test('click selects, picker + keep live in the right-click menu', () => {
    expect(main).not.toMatch(/tabId === 'live'\) \{\s*showLiveChannelPicker\(tab\)/)
    expect(main).toContain("addItem(t('mc_tab_keep'), () => keepLiveTab())")
    expect(main).toContain('showLiveChannelPicker(tab)')
    expect(main).toContain('showEditLivePlatforms()')
  })
  test('the old bounce dance is gone', () => {
    expect(main).not.toContain('_bouncedFromLive = true')
    expect(main).not.toContain("switchTab('feed')\n            _bouncedFromLive")
  })
  test('fallbacks go through liveTarget', () => {
    expect(main).toMatch(/switchTab\(liveTarget\(\)\)/)
    expect(read('../src/multichat/profile-card.js')).toContain('switchTab(liveTarget())')
    expect(read('../src/multichat/channel-mgmt.js')).toContain('switchTab(liveTarget())')
    expect(main).toContain("const want = _savedActiveTab === 'live' ? liveTarget() : _savedActiveTab")
  })
  test('the cta is also on the feed for a channel-less page with no saved tabs', () => {
    expect(read('../src/multichat/social.js')).toContain('appendCockpitCta')
  })
})

describe('promote on chat', () => {
  test('send targets of the temp tab are unchanged: host platform only when anonymous', () => {
    expect(input).toContain("const anonLive = currentTab === 'live' && !ch")
    expect(input).toContain("(anonLive && hostPlatform === 'kick')")
    expect(input).toContain("(anonLive && hostPlatform === 'twitch')")
    expect(input).toContain("const isLiveYt = currentTab === 'live' && hostPlatform === 'yt'")
  })
  test('promotes only from a leg that delivered, never from a failure branch', () => {
    const calls = [...input.matchAll(/keepTempTabAfterSend\(\)/g)].length
    expect(calls).toBe(4) // kick/twitch legs, youtube-only, twitch+youtube
  })
  test('each call sits right after a success check', () => {
    expect(input).toMatch(/if \(kickOk \|\| twitchSent\) \{\s*keepTempTabAfterSend\(\)/)
    expect(input).toMatch(/if \(result === true\) \{\s*keepTempTabAfterSend\(\)/)
    expect(input).toMatch(/\(await ytLeg\) === true\) \{\s*keepTempTabAfterSend\(\)/)
    const failBranches = input.split('markPendingFailed(').slice(1)
    for (const after of failBranches) expect(after.slice(0, 200)).not.toContain('keepTempTabAfterSend')
  })
})
