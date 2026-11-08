import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchWithExtension } from '../lib/chromium'
import { startMockIrc } from '../lib/mock-irc'
import { PLATFORMS, closeContext, errors, fail, fixtureHtml, observe, ok, until } from './lib'

/**
 * Highlight-rule sounds: a rule's own audio file, in a real browser.
 *
 * What a source test cannot say: that a stored file is decoded by the real
 * Web Audio and that the AudioBufferSourceNode really does start on a matching
 * message. The content script runs in an ISOLATED world, so the spy has to be
 * installed there (CDP), not with addInitScript — that one patches the page's
 * own world.
 *
 * Covers, in order: a seeded rule + file (plays at the rule's own volume); the
 * audio context parking itself and waking for the next cue; a raid of matches
 * is one cue, not thirty; a rule whose file is not on this device plays the
 * ping; and the real settings UI — pick a file, add the rule, hear it, and an
 * export that carries the name but none of the bytes.
 *
 * NOT covered here: the browser refusing audio until a user gesture. Playwright
 * navigations count as user activation (navigator.userActivation.hasBeenActive
 * is true on arrival, with or without --autoplay-policy), so that path cannot be
 * produced in this harness; tests/chat-sounds.test.js drives it with a context
 * whose resume() stays pending or settles still-suspended.
 */
function wavBytes(seconds: number, hz: number) {
  const rate = 8000
  const n = Math.round(rate * seconds)
  const buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + n * 2, 4)
  buf.write('WAVEfmt ', 8)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(rate, 24)
  buf.writeUInt32LE(rate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 12000), 44 + i * 2)
  return buf
}

const SOUND_SPY = `(() => {
  if (window.__hsSnd) return 'already'
  const log = (window.__hsSnd = { src: [], osc: 0, gains: [], suspends: 0 })
  const ps = AudioBufferSourceNode.prototype.start
  AudioBufferSourceNode.prototype.start = function (...a) {
    log.src.push(this.buffer ? this.buffer.duration : -1)
    return ps.apply(this, a)
  }
  const po = OscillatorNode.prototype.start
  OscillatorNode.prototype.start = function (...a) {
    log.osc++
    return po.apply(this, a)
  }
  const psus = AudioContext.prototype.suspend
  AudioContext.prototype.suspend = function (...a) {
    log.suspends++
    return psus.apply(this, a)
  }
  const pg = AudioParam.prototype.setValueAtTime
  AudioParam.prototype.setValueAtTime = function (v, t) {
    if (this.defaultValue === 1) log.gains.push(v)
    return pg.call(this, v, t)
  }
  return 'ok'
})()`

export async function soundCheck() {
  console.log('\n── highlight rule sounds: a picked file, a volume, one rate limit ──')
  const irc = startMockIrc()
  if (!irc) {
    console.log('  ! SKIPPED — openssl not available, so the mock irc server has no cert.')
    console.log('    rule sounds are going UNVERIFIED in this run.')
    return
  }
  const { frames, push } = irc
  const prof = mkdtempSync(join(tmpdir(), 'hs-ext-sound-'))
  const wavDir = mkdtempSync(join(tmpdir(), 'hs-ext-sound-wav-'))
  const wavPath = join(wavDir, 'airhorn.wav')
  const wav = wavBytes(0.3, 880)
  writeFileSync(wavPath, wav)
  const c = await launchWithExtension(prof, [
    '--window-size=1500,900',
    `--host-resolver-rules=MAP irc-ws.chat.twitch.tv 127.0.0.1:${irc.port}`,
    '--ignore-certificate-errors',
    '--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests',
  ])
  try {
    await c.route('https://heatsync.org/**', (r: any) => r.abort())
    await c.route(PLATFORMS[0].glob, (r: any) =>
      r.fulfill({ status: 200, contentType: 'text/html', body: fixtureHtml(PLATFORMS[0].body) }),
    )
    await c.addCookies([
      { name: 'auth-token', value: 'harnesstoken0000', domain: '.twitch.tv', path: '/', secure: true },
      { name: 'login', value: 'probeuser', domain: '.twitch.tv', path: '/', secure: true },
    ])
    let sw = c.serviceWorkers()[0]
    if (!sw) sw = await c.waitForEvent('serviceworker', { timeout: 20_000 })
    const id = sw.url().match(/chrome-extension:\/\/([a-p]+)\//)?.[1]
    if (!id) fail('could not resolve the extension id for the sound check')

    // Seed through an extension page: rule 'seeded' has a file on this device,
    // rule 'ghost' points at one that is not here (a rule that synced in from
    // another machine). Volume 40 is NOT the shared default (30), so a cue that
    // ignored the rule's own volume would show up in the gain.
    const seedRules = [
      { id: 'seed1', enabled: true, scope: 'all', match: { type: 'keyword', value: 'seeded', caseSensitive: false }, action: 'highlight', color: '#ffff00', sound: 'custom', soundName: 'airhorn.wav', soundVolume: 40 },
      { id: 'ghost1', enabled: true, scope: 'all', match: { type: 'keyword', value: 'ghost', caseSensitive: false }, action: 'highlight', color: '#ff00ff', sound: 'custom', soundName: 'gone.wav', soundVolume: 40 },
    ]
    const seed = await c.newPage()
    await seed.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'load' })
    await seed.evaluate(
      async ({ rules, b64 }: { rules: unknown[], b64: string }) => {
        // @ts-ignore — extension page
        await chrome.storage.local.set({
          heatsync_multichat: { channels: [{ id: 'probechan', twitch: 'probechan', kick: '', youtube: '' }] },
          user_info: { username: 'probeuser' },
          chat_filter_rules: JSON.stringify(rules),
          hs_sfx_rule_seed1: { n: 'airhorn.wav', t: 'audio/wav', b: b64 },
        })
      },
      { rules: seedRules, b64: wav.toString('base64') },
    )

    const p = await c.newPage()
    p.on('pageerror', (e: unknown) => errors.push(`sound: ${String(e).slice(0, 300)}`))
    const cdp = await c.newCDPSession(p)
    const worlds = new Set<number>()
    cdp.on('Runtime.executionContextCreated', ({ context }: any) => {
      if (context.auxData?.type === 'isolated' && String(context.origin).startsWith('chrome-extension://')) worlds.add(context.id)
    })
    cdp.on('Runtime.executionContextsCleared', () => worlds.clear())
    await cdp.send('Runtime.enable')
    await p.goto('https://www.twitch.tv/probechan', { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('#hs-mc-input', { timeout: 25_000 })
    if (!(await until(p, () => frames.some((f) => f.startsWith('JOIN'))))) fail('the sound check never joined the channel')
    if (!worlds.size) fail('no extension isolated world on the page to spy in')
    for (const contextId of worlds) await cdp.send('Runtime.evaluate', { expression: SOUND_SPY, contextId })

    const spy = async () => {
      let src: number[] = []
      let osc = 0
      let gains: number[] = []
      let suspends = 0
      for (const contextId of worlds) {
        const r = await cdp.send('Runtime.evaluate', { expression: 'JSON.stringify(window.__hsSnd || null)', contextId, returnByValue: true })
        const v = r.result?.value ? JSON.parse(r.result.value) : null
        if (v) {
          src = src.concat(v.src)
          osc += v.osc
          gains = gains.concat(v.gains)
          suspends += v.suspends || 0
        }
      }
      return { src, osc, gains, suspends }
    }
    let msgN = 0
    const say = (text: string) =>
      push(
        `@display-name=viewer;color=#00FF00;user-id=43;id=snd${++msgN} :viewer!v@v.tmi.twitch.tv PRIVMSG #probechan :${text}\r\n`,
      )
    const shown = (text: string) =>
      until(p, async () => (await p.evaluate(() => document.getElementById('hs-mc-messages')?.textContent || '')).includes(text), 8000)

    // ── the rule's file plays at the rule's volume ──────────────────────────
    await p.click('#hs-mc-input')
    say('seeded first match')
    if (!(await until(p, async () => (await spy()).src.length >= 1, 8000))) {
      fail(`a matching message started no AudioBufferSourceNode (spy: ${JSON.stringify(await spy())})`)
    }
    const played = await spy()
    if (Math.abs(played.src[0] - 0.3) > 0.01) fail(`the wrong sound started: duration ${played.src[0]}s, the file is 0.3s`)
    if (!played.gains.includes(0.4)) fail(`the cue did not play at the rule's own volume (40 -> 0.4): gains ${JSON.stringify(played.gains)}`)
    if (played.osc) fail(`a synth tone played alongside the picked file (${played.osc} oscillators)`)
    ok("a matching message plays the rule's own file (0.3s) at the rule's own volume (40 -> gain 0.4)")

    // ── the idle audio device is parked, then wakes for the next cue ────────
    const firstCue = (await spy()).src.length
    // the context parks itself once the cue's tail + the idle grace have passed: watch it happen
    if (!(await until(p, async () => (await spy()).suspends >= 1, 12_000))) {
      fail('the audio device never parked after the cue (AudioContext.suspend was not called)')
    }
    say('seeded after parking')
    if (!(await until(p, async () => (await spy()).src.length > firstCue, 8000))) {
      fail('after the audio device idled, the next matching message started no sound')
    }
    ok('a cue after the idle pause still plays (the parked audio device wakes)')

    // ── a raid is one cue ───────────────────────────────────────────────────
    const startsBefore = (await spy()).src.length
    await observe(p, 1400, 'the rule\'s cue throttle (SFX_THROTTLE_MS, 1.2s) has to pass before the raid starts')
    for (let i = 0; i < 30; i++) say(`seeded raid ${i}`)
    if (!(await shown('seeded raid 29'))) fail('the raid never finished rendering')
    await observe(p, 600, 'a second cue from the raid would start here')
    const raided = (await spy()).src.length - startsBefore
    if (raided !== 1) fail(`30 matching messages started ${raided} sounds, expected exactly 1 (rate limit)`)
    ok('a raid of 30 matching messages is one cue, not thirty')

    // ── a file that is not on this device: the ping, not silence ────────────
    await observe(p, 1400, 'the cue throttle (1.2s) after the raid')
    const oscBefore = (await spy()).osc
    const srcBefore = (await spy()).src.length
    say('ghost rule fires')
    if (!(await until(p, async () => (await spy()).osc > oscBefore, 8000))) {
      fail('a rule whose file is missing on this device played nothing — it must fall back to the ping')
    }
    if ((await spy()).src.length !== srcBefore) fail('a missing file somehow started a file source')
    ok('a rule whose file is missing on this device plays the ping instead of nothing')

    // ── the real settings UI: pick a file, add the rule, hear it ────────────
    await p.click('.hs-mc-tab[data-tab="settings"]')
    await p.click('.hs-mc-set-subtab[data-set-subtab="filters"]')
    await p.waitForSelector('.hs-mc-fr-addform [data-fr-field="value"]', { timeout: 8000 })
    // emote loading still redraws the settings tab in the first seconds; wait
    // for a redraw-free stretch so the typed text is not wiped mid-test
    const formIsQuiet = async () => {
      await p.evaluate(() => document.querySelector('.hs-mc-fr-addform')?.setAttribute('data-probe', '1'))
      await observe(p, 1500, 'this IS the quiet-stretch detector: a redraw inside it drops the probe')
      return p.evaluate(() => document.querySelector('.hs-mc-fr-addform')?.getAttribute('data-probe') === '1')
    }
    if (!(await until(p, formIsQuiet, 12_000))) fail('the settings tab kept redrawing; the add-rule form never held still')
    await p.fill('.hs-mc-fr-addform [data-fr-field="value"]', 'viaui')
    const [chooser] = await Promise.all([
      p.waitForEvent('filechooser', { timeout: 8000 }),
      p.click('.hs-mc-fr-addform [data-fr-action="pick"]'),
    ])
    await chooser.setFiles(wavPath)
    const soundIsCustom = () =>
      p.evaluate(() => (document.querySelector('.hs-mc-fr-addform [data-fr-field="sound"]') as HTMLSelectElement)?.value === 'custom')
    if (!(await until(p, soundIsCustom, 8000))) fail('picking a file did not select "my file" in the sound menu')
    const pickLabel = await p.evaluate(() => document.querySelector('.hs-mc-fr-addform [data-fr-action="pick"]')?.textContent || '')
    if (!pickLabel.includes('airhorn.wav')) fail(`the pick button does not show the file name: ${JSON.stringify(pickLabel)}`)
    await p.evaluate(() => {
      const r = document.querySelector('.hs-mc-fr-addform [data-fr-field="vol"]') as HTMLInputElement
      r.value = '65'
      r.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const note = await p.evaluate(() => document.querySelector('.hs-mc-fr-addform')?.textContent || '')
    if (!/this device/i.test(note)) fail('the add-rule form never says the sound file stays on this device')
    await p.click('.hs-mc-fr-addform [data-fr-action="add"]')
    const readRule = () =>
      seed.evaluate(async () => {
        // @ts-ignore — extension page
        const all = await chrome.storage.local.get(null)
        const rule = JSON.parse(all.chat_filter_rules || '[]').find((r: any) => r.match?.value === 'viaui')
        const rec = rule ? all[`hs_sfx_rule_${rule.id}`] : null
        return { rule, recBytes: rec?.b?.length || 0, recName: rec?.n }
      })
    if (!(await until(seed, async () => !!(await readRule()).rule, 8000))) {
      fail('adding the rule through the form never saved a rule')
    }
    const saved = await readRule()
    if (saved.rule.sound !== 'custom') fail(`the rule did not keep the custom sound: ${JSON.stringify(saved.rule)}`)
    if (saved.rule.soundVolume !== 65) fail(`the rule did not keep the slider's volume: ${JSON.stringify(saved.rule)}`)
    if (saved.rule.soundName !== 'airhorn.wav') fail(`the rule did not keep the file name: ${JSON.stringify(saved.rule)}`)
    if (JSON.stringify(saved.rule).includes(wav.toString('base64').slice(0, 40))) {
      fail('the audio bytes leaked into the synced rule itself')
    }
    if (saved.recBytes < 1000 || saved.recName !== 'airhorn.wav') {
      fail(`the file did not land on this device: ${JSON.stringify({ bytes: saved.recBytes, name: saved.recName })}`)
    }
    await observe(p, 1400, 'the cue throttle (1.2s) after the ghost-rule ping')
    const uiBefore = (await spy()).src.length
    say('viaui matched')
    if (!(await until(p, async () => (await spy()).src.length > uiBefore, 8000))) {
      fail('the rule added through the real form did not play its file')
    }
    ok('the settings form: pick a file, set 65, add -> the rule keeps name + volume, the file lands on this device, and it plays')

    // ── export carries the name and the volume, never the bytes ─────────────
    await p.click('.hs-mc-set-subtab[data-set-subtab="system"]')
    await p.waitForSelector('.hs-mc-settings-btn[data-action="export-settings"]', { timeout: 8000 })
    const [dl] = await Promise.all([
      p.waitForEvent('download', { timeout: 10_000 }),
      p.click('.hs-mc-settings-btn[data-action="export-settings"]'),
    ])
    const exported = readFileSync((await dl.path()) as string, 'utf8')
    if (/hs_sfx_/.test(exported)) fail('the settings export contains a sound file key (hs_sfx_*)')
    if (exported.includes(wav.toString('base64').slice(0, 60))) fail('the settings export contains the audio bytes')
    if (!exported.includes('airhorn.wav') || !exported.includes('soundVolume\\":65')) {
      fail("the settings export lost the rule's sound name or volume")
    }
    if (exported.length > 20_000) fail(`the settings export is ${exported.length} bytes — sound files must not ride it`)
    ok(`export keeps the rule's sound name + volume, none of the audio (${exported.length} bytes)`)

    await seed.close()
  } finally {
    irc.stop()
    await closeContext(c, 'rule sounds', prof)
    rmSync(prof, { recursive: true, force: true })
    rmSync(wavDir, { recursive: true, force: true })
  }
}