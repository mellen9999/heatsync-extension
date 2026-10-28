/**
 * Every channel remembers its own volume (chrome/player-volume.js), on the
 * native sites AND inside the player iframes heatsync.org and the chat link
 * embeds draw. ennortix: "i created a js script with chatgpt that overwrites the
 * value of the volume slider and I could separate channel in it with a default
 * volume".
 *
 * The core is held pure; the glue runs for real against happy-dom with a fake
 * <video> and an in-memory storage, including the race that makes this hard:
 * the page restores its OWN volume after the player mounts.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const SRC = readFileSync(join(ROOT, 'chrome', 'player-volume.js'), 'utf8')

function loadCore() {
  globalThis.__hsPlayerVolumeLoaded = false
  globalThis.__HS_PV_TEST__ = true
  new Function(SRC)()
  delete globalThis.__HS_PV_TEST__
  globalThis.__hsPlayerVolumeLoaded = false
  return globalThis.__hsPlayerVolumeCore
}
const core = loadCore()
const L = (hostname, pathname = '/', search = '') => ({ hostname, pathname, search })

describe('channelKey — which channel is this frame playing', () => {
  test('twitch page, popout and moderator view', () => {
    expect(core.channelKey(L('www.twitch.tv', '/NL_Kripp'))).toBe('twitch:nl_kripp')
    expect(core.channelKey(L('www.twitch.tv', '/popout/kripp/chat'))).toBe('twitch:kripp')
    expect(core.channelKey(L('www.twitch.tv', '/moderator/kripp'))).toBe('twitch:kripp')
  })

  test('twitch pages that are not channels have no key', () => {
    for (const p of ['/', '/directory', '/directory/game/Chess', '/videos/123', '/settings', '/p/legal', '/search']) {
      expect(core.channelKey(L('www.twitch.tv', p)), p).toBeNull()
    }
  })

  test('the twitch embed: ?channel= is a stream, ?video= is a vod (no memory)', () => {
    expect(core.channelKey(L('player.twitch.tv', '/', '?channel=Kripp&parent=heatsync.org&muted=true'))).toBe(
      'twitch:kripp',
    )
    expect(core.channelKey(L('player.twitch.tv', '/', '?video=123456&parent=heatsync.org'))).toBeNull()
    expect(core.channelKey(L('player.twitch.tv', '/', '?channel=../evil'))).toBeNull()
  })

  test("kick page and embed, never kick's own pages", () => {
    expect(core.channelKey(L('kick.com', '/cry'))).toBe('kick:cry')
    expect(core.channelKey(L('kick.com', '/popout/cry/chat'))).toBe('kick:cry')
    expect(core.channelKey(L('player.kick.com', '/cry'))).toBe('kick:cry')
    for (const p of ['/', '/categories', '/browse', '/video/abc', '/dashboard']) {
      expect(core.channelKey(L('kick.com', p)), p).toBeNull()
    }
  })

  test('youtube keys on the channel link the page shows, never guesses', () => {
    const watch = L('www.youtube.com', '/watch', '?v=abc')
    expect(core.channelKey(watch, () => 'https://www.youtube.com/@SomeStreamer')).toBe('youtube:@somestreamer')
    expect(core.channelKey(L('www.youtube.com', '/embed/abc'), () => '/channel/UCabcdefghijklmnopqrstuv')).toBe(
      'youtube:ucabcdefghijklmnopqrstuv',
    )
    expect(core.channelKey(watch, () => null)).toBeNull()
    expect(core.channelKey(watch, () => '/playlist?list=1')).toBeNull()
    expect(core.channelKey(L('www.youtube.com', '/shorts/abc'), () => '/@x')).toBeNull()
    expect(core.channelKey(L('www.youtube.com', '/'), () => '/@x')).toBeNull()
  })

  test('a lookalike host is never a player', () => {
    expect(core.channelKey(L('twitch.tv.evil.com', '/kripp'))).toBeNull()
    expect(core.channelKey(L('evil.com', '/kripp'))).toBeNull()
  })
})

describe('the memory', () => {
  test('remember → volumeFor round-trips and clamps', () => {
    let m = core.remember({}, 'twitch:a', 0.15, 1)
    expect(core.volumeFor(m, 'twitch:a', 0)).toBe(0.15)
    m = core.remember(m, 'twitch:a', 7, 2)
    expect(core.volumeFor(m, 'twitch:a', 0)).toBe(1)
  })

  test('no memory → the default, or null to leave the player alone', () => {
    expect(core.volumeFor({}, 'twitch:new', 0.05)).toBe(0.05)
    expect(core.volumeFor({}, 'twitch:new', 0)).toBeNull()
    expect(core.volumeFor(undefined, 'twitch:new', 0)).toBeNull()
  })

  test('memory beats the default', () => {
    const m = core.remember({}, 'kick:cry', 0.4, 1)
    expect(core.volumeFor(m, 'kick:cry', 0.05)).toBe(0.4)
  })

  test('bounded: the oldest-touched channel is the one forgotten', () => {
    let m = {}
    for (let i = 0; i < core.MAX_ENTRIES + 25; i++) m = core.remember(m, `twitch:c${i}`, 0.5, i)
    expect(Object.keys(m).length).toBe(core.MAX_ENTRIES)
    expect(m['twitch:c0']).toBeUndefined()
    expect(m[`twitch:c${core.MAX_ENTRIES + 24}`]).toBeDefined()
    // touching an old one keeps it
    m = core.remember(m, 'twitch:c30', 0.9, 99999)
    for (let i = 0; i < 100; i++) m = core.remember(m, `twitch:z${i}`, 0.5, 100000 + i)
    expect(m['twitch:c30']).toBeDefined()
  })

  test('remember never mutates the map it was given', () => {
    const m = Object.freeze({ 'twitch:a': [0.1, 1] })
    expect(() => core.remember(m, 'twitch:b', 0.2, 2)).not.toThrow()
  })
})

// ── the page glue, for real, in a DOM ────────────────────────────────────────

let Window = null
try {
  Window = (await import('happy-dom')).Window
} catch {
  Window = null
}
const describeDom = Window ? describe : describe.skip

describeDom('the glue — a player mounts, the page races us, the reader decides', () => {
  let win
  let store
  let listeners
  let realSetTimeout = null
  let timers = new Set()
  const real = {}

  /** a <video> that behaves like the part of one we touch */
  const fakeVideo = (win, vol = 1) => {
    const v = win.document.createElement('video')
    let volume = vol
    Object.defineProperty(v, 'volume', {
      get: () => volume,
      set: (n) => {
        volume = n
        v.dispatchEvent(new win.Event('volumechange'))
      },
    })
    Object.defineProperty(v, 'readyState', { get: () => 1 })
    return v
  }
  const flush = (ms = 0) => new Promise((r) => setTimeout(r, ms))

  const boot = async ({ url, local = {}, sync = {} }) => {
    store = { local: { ...local }, sync: { ...sync } }
    listeners = []
    win = new Window({ url })
    const api = {
      storage: {
        local: {
          get: async (k) => ({ [k]: store.local[k] }),
          set: async (o) => {
            Object.assign(store.local, o)
          },
        },
        sync: { get: async (k) => ({ [k]: store.sync[k] }) },
        onChanged: { addListener: (fn) => listeners.push(fn) },
      },
    }
    for (const k of ['window', 'document', 'location', 'MutationObserver', 'Event', 'chrome', 'browser', 'Node'])
      real[k] = globalThis[k]
    globalThis.window = win
    globalThis.document = win.document
    globalThis.location = win.location
    globalThis.MutationObserver = win.MutationObserver
    globalThis.Event = win.Event
    globalThis.chrome = api
    delete globalThis.browser
    globalThis.__hsPlayerVolumeLoaded = false
    // The glue's own retry timers (it looks again for a lagging channel name) run
    // on the global setTimeout and outlive the test; they would then read a
    // `location` the teardown below has already removed, and the error lands on
    // whichever test happens to be running — an order-dependent failure in a
    // different file. Track them here, clear them in afterEach.
    realSetTimeout = globalThis.setTimeout
    timers = new Set()
    globalThis.setTimeout = (fn, ms, ...rest) => {
      const h = realSetTimeout(fn, ms, ...rest)
      timers.add(h)
      return h
    }
    new Function(SRC)()
    await flush(5)
  }

  afterEach(() => {
    if (realSetTimeout) {
      for (const h of timers) clearTimeout(h)
      globalThis.setTimeout = realSetTimeout
      realSetTimeout = null
    }
    for (const k of Object.keys(real)) {
      if (real[k] === undefined) delete globalThis[k]
      else globalThis[k] = real[k]
    }
    globalThis.__hsPlayerVolumeLoaded = false
    win?.close?.()
  })

  const input = () => win.document.dispatchEvent(new win.Event('pointerdown'))

  test('a channel with a memory opens at it', async () => {
    await boot({
      url: 'https://www.twitch.tv/kripp',
      local: { hs_channel_volume: { v: 1, map: { 'twitch:kripp': [0.15, 1] } } },
    })
    const v = fakeVideo(win, 1)
    win.document.body.appendChild(v)
    await flush(5)
    v.dispatchEvent(new win.Event('loadedmetadata'))
    expect(v.volume).toBe(0.15)
  })

  test('the page restoring its own volume afterwards does not win', async () => {
    await boot({
      url: 'https://www.twitch.tv/kripp',
      local: { hs_channel_volume: { v: 1, map: { 'twitch:kripp': [0.15, 1] } } },
    })
    const v = fakeVideo(win, 1)
    win.document.body.appendChild(v)
    await flush(5)
    v.dispatchEvent(new win.Event('loadedmetadata'))
    v.volume = 0.8 // twitch restores ITS volume — no click, no key
    expect(v.volume).toBe(0.15)
  })

  test('the reader moving the slider is remembered, per channel', async () => {
    await boot({ url: 'https://www.twitch.tv/kripp' })
    const v = fakeVideo(win, 1)
    win.document.body.appendChild(v)
    await flush(5)
    v.dispatchEvent(new win.Event('loadedmetadata'))
    input()
    v.volume = 0.3
    await flush(650)
    expect(store.local.hs_channel_volume.map['twitch:kripp'][0]).toBe(0.3)
    expect(Object.keys(store.local.hs_channel_volume.map)).toEqual(['twitch:kripp'])
  })

  test('unmuting is not a volume choice: the page rewriting its level on unmute loses', async () => {
    await boot({
      url: 'https://www.twitch.tv/kripp',
      local: { hs_channel_volume: { v: 1, map: { 'twitch:kripp': [0.15, 1] } } },
    })
    const v = fakeVideo(win, 1)
    const btn = win.document.createElement('button')
    btn.setAttribute('data-a-target', 'player-mute-unmute-button')
    win.document.body.append(v, btn)
    await flush(5)
    v.dispatchEvent(new win.Event('loadedmetadata'))
    await flush(5)
    btn.dispatchEvent(new win.Event('pointerdown', { bubbles: true }))
    v.volume = 0.9 // twitch answers the unmute from its own state
    await flush(650)
    expect(v.volume).toBe(0.15)
    expect(store.local.hs_channel_volume.map['twitch:kripp'][0]).toBe(0.15)
  })

  test('one platform off leaves its players alone, the others keep working', async () => {
    const mem = { hs_channel_volume: { v: 1, map: { 'twitch:kripp': [0.15, 1] } } }
    await boot({
      url: 'https://www.twitch.tv/kripp',
      local: mem,
      sync: { ui_settings: { channelVolumeTwitch: false } },
    })
    const v = fakeVideo(win, 1)
    win.document.body.appendChild(v)
    await flush(5)
    v.dispatchEvent(new win.Event('loadedmetadata'))
    expect(v.volume).toBe(1)
  })

  test('muting does not erase the level', async () => {
    await boot({ url: 'https://www.twitch.tv/kripp' })
    const v = fakeVideo(win, 0.4)
    win.document.body.appendChild(v)
    await flush(5)
    v.dispatchEvent(new win.Event('loadedmetadata'))
    input()
    v.muted = true
    v.volume = 0
    await flush(650)
    expect(store.local.hs_channel_volume).toBeUndefined()
  })

  test('no memory and no default: the player is left exactly alone', async () => {
    await boot({ url: 'https://www.twitch.tv/newchannel' })
    const v = fakeVideo(win, 0.7)
    win.document.body.appendChild(v)
    await flush(5)
    v.dispatchEvent(new win.Event('loadedmetadata'))
    expect(v.volume).toBe(0.7)
  })

  test('no memory but a default: a new channel opens at the default', async () => {
    await boot({ url: 'https://www.twitch.tv/newchannel', sync: { ui_settings: { channelVolumeDefault: 0.05 } } })
    const v = fakeVideo(win, 1)
    win.document.body.appendChild(v)
    await flush(5)
    v.dispatchEvent(new win.Event('loadedmetadata'))
    expect(v.volume).toBe(0.05)
  })

  test('the setting off: it neither restores nor remembers', async () => {
    await boot({
      url: 'https://www.twitch.tv/kripp',
      local: { hs_channel_volume: { v: 1, map: { 'twitch:kripp': [0.15, 1] } } },
      sync: { ui_settings: { channelVolumeMemory: false } },
    })
    const v = fakeVideo(win, 1)
    win.document.body.appendChild(v)
    await flush(5)
    v.dispatchEvent(new win.Event('loadedmetadata'))
    expect(v.volume).toBe(1)
    input()
    v.volume = 0.5
    await flush(650)
    expect(store.local.hs_channel_volume.map['twitch:kripp'][0]).toBe(0.15)
  })

  test('inside the twitch embed the key comes from ?channel=', async () => {
    await boot({
      url: 'https://player.twitch.tv/?channel=kripp&parent=heatsync.org&muted=true',
      local: { hs_channel_volume: { v: 1, map: { 'twitch:kripp': [0.2, 1] } } },
    })
    const v = fakeVideo(win, 1)
    win.document.body.appendChild(v)
    await flush(5)
    v.dispatchEvent(new win.Event('loadedmetadata'))
    expect(v.volume).toBe(0.2)
  })

  test('a vod embed has no key, so no memory is read or written', async () => {
    await boot({ url: 'https://player.twitch.tv/?video=99&parent=heatsync.org' })
    const v = fakeVideo(win, 0.6)
    win.document.body.appendChild(v)
    await flush(5)
    v.dispatchEvent(new win.Event('loadedmetadata'))
    input()
    v.volume = 0.3
    await flush(650)
    expect(store.local.hs_channel_volume).toBeUndefined()
  })
})

describe('wired into the build', () => {
  const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8')
  test('both manifests run it in every frame of the three platforms, never in youtube live chat', () => {
    for (const f of ['chrome', 'firefox']) {
      const m = JSON.parse(read('src', 'manifests', `${f}.json`))
      const cs = m.content_scripts.find((c) => c.js.includes('player-volume.js'))
      expect(cs, f).toBeDefined()
      expect(cs.all_frames).toBe(true)
      expect(cs.matches).toEqual(
        expect.arrayContaining(['https://*.twitch.tv/*', 'https://*.kick.com/*', 'https://www.youtube.com/*']),
      )
      expect(cs.exclude_matches).toContain('https://www.youtube.com/live_chat*')
    }
  })
  test('the build ships it, and the settings exist in the schema and en locale', () => {
    expect(read('build.js')).toContain("'player-volume.js'")
    const schema = read('src', 'lib', 'settings-schema.js')
    expect(schema).toContain("key: 'channelVolumeMemory'")
    expect(schema).toContain("key: 'channelVolumeDefault'")
    const en = JSON.parse(read('src', '_locales', 'en', 'messages.json'))
    for (const k of [
      'mc_settings_channel_volume',
      'mc_settings_channel_volume_desc',
      'mc_settings_channel_volume_default',
      'mc_settings_channel_volume_default_desc',
    ]) {
      expect(en[k]?.message, k).toBeTruthy()
    }
  })
})
