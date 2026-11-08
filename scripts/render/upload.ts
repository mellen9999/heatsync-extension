import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchWithExtension } from '../lib/chromium'
import { ONE_PX_PNG, PLATFORMS, closeContext, errors, fail, fixtureHtml, ok, until } from './lib'

export async function emoteUploadCheck() {
  console.log('\n── uploading your own emote from the picker ──')
  const prof = mkdtempSync(join(tmpdir(), 'hs-ext-upload-'))
  const c = await launchWithExtension(prof, ['--window-size=1500,900'])
  try {
    const json = (body: unknown, status = 200) => ({
      status,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(body),
    })
    const posted: any[] = []
    let uploads = 0
    let takenOnce = true
    // last-registered-first: blanket abort goes down first
    await c.route('https://heatsync.org/**', (r: any) => r.abort())
    await c.route('https://heatsync.org/api/user/emotes**', (r: any) => {
      const req = r.request()
      if (req.method() !== 'POST') return r.fulfill(json({ emotes: [] }))
      const body = JSON.parse(req.postData() || '{}')
      posted.push(body)
      if (body.emoteName === 'taken' && takenOnce) {
        takenOnce = false
        return r.fulfill(json({ error: 'Emote name already in inventory' }, 409))
      }
      return r.fulfill(json({ success: true, slot: 1, hash: 'abc123' }))
    })
    await c.route('https://heatsync.org/api/upload**', (r: any) => {
      uploads++
      return r.fulfill(
        json({
          success: true,
          url: 'https://cdn.heatsync.org/uploads/abc.webp',
          phash: 'abc123',
          width: 128,
          height: 128,
          moderationResult: { flaggedCategories: [] },
        }),
      )
    })
    await c.route('https://cdn.heatsync.org/**', (r: any) =>
      r.fulfill({ status: 200, contentType: 'image/png', body: ONE_PX_PNG }),
    )
    await c.route(PLATFORMS[0].glob, (r: any) =>
      r.fulfill({ status: 200, contentType: 'text/html', body: fixtureHtml(PLATFORMS[0].body) }),
    )
    await c.addCookies([
      { name: 'auth', value: 'harnesstoken0000', domain: 'heatsync.org', path: '/', secure: true },
    ])

    let sw = c.serviceWorkers()[0]
    if (!sw) sw = await c.waitForEvent('serviceworker', { timeout: 20_000 })
    const id = sw.url().match(/chrome-extension:\/\/([a-p]+)\//)?.[1]
    if (!id) fail('could not resolve the extension id for the upload check')
    const seed = await c.newPage()
    await seed.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'load' })
    await seed.evaluate(async () => {
      // @ts-ignore — extension page
      await chrome.storage.local.set({
        heatsync_multichat: { channels: [{ id: 'probechan', twitch: 'probechan', kick: '', youtube: '' }] },
      })
    })
    await seed.close()

    const p = await c.newPage()
    p.on('pageerror', (e: unknown) => errors.push(`upload: ${String(e).slice(0, 300)}`))
    await p.goto('https://www.twitch.tv/probechan', { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('#hs-mc-input', { timeout: 25_000 })
    await p.click('#hs-mc-input')
    await p.waitForSelector('#hs-mc-emote-btn', { timeout: 10_000 })
    await p.click('#hs-mc-emote-btn')
    await p.waitForSelector('#hs-mc-emote-picker.visible', { timeout: 10_000 })
    await p.waitForSelector('#hs-mc-upload-btn', { timeout: 5000 })
    ok('the picker header carries an upload button')

    const png = { name: 'my-cool_emote-2x.png', mimeType: 'image/png', buffer: ONE_PX_PNG }
    const status = () => p.evaluate(() => document.getElementById('hs-mc-upload-status')?.textContent || '')
    const formShown = () => p.evaluate(() => !(document.getElementById('hs-mc-upload-form') as any)?.hidden)

    // a wrong file type is refused in words, before anything is sent
    await p.setInputFiles('#hs-mc-upload-file', { name: 'x.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') })
    if (!(await until(p, async () => (await status()).length > 0, 5000))) fail('a .txt pick said nothing')
    if (await formShown()) fail('a .txt pick opened the name form')
    if (uploads) fail('a .txt pick reached the server')
    ok(`a wrong file type is refused in words (${JSON.stringify(await status())})`)

    // good file: name defaults from the filename, focus lands in the field
    await p.setInputFiles('#hs-mc-upload-file', png)
    await p.waitForSelector('#hs-mc-upload-name:focus', { timeout: 5000 })
    const def = await p.inputValue('#hs-mc-upload-name')
    if (def !== 'mycool_emote') fail(`default name was ${JSON.stringify(def)}, expected mycool_emote`)
    ok('the name defaults from the file and the field has focus')

    // Esc backs out of the form only, the picker stays open
    await p.keyboard.press('Escape')
    if (await formShown()) fail('Esc left the name form open')
    const stillOpen = await p.evaluate(() =>
      document.getElementById('hs-mc-emote-picker')?.classList.contains('visible'),
    )
    if (!stillOpen) fail('Esc in the name field closed the whole picker')
    ok('Esc cancels the form without closing the picker')

    // Enter uploads and adds
    await p.setInputFiles('#hs-mc-upload-file', png)
    await p.waitForSelector('#hs-mc-upload-name:focus', { timeout: 5000 })
    await p.fill('#hs-mc-upload-name', 'probeEmote')
    await p.keyboard.press('Enter')
    if (!(await until(p, () => posted.length >= 1, 10_000))) fail('Enter never added the emote to the inventory')
    const body = posted[0]
    if (body.emoteName !== 'probeEmote' || body.source !== 'upload') {
      fail(`inventory add sent ${JSON.stringify(body)}, expected source upload + the typed name`)
    }
    if (uploads !== 1) fail(`expected exactly 1 upload call, saw ${uploads}`)
    ok('Enter uploads once, then adds with source=upload under the typed name')
    if (!(await until(p, async () => !(await formShown()), 5000))) fail('the form stayed open after success')

    // a taken name keeps the form open and says so; the file is not re-uploaded
    await p.setInputFiles('#hs-mc-upload-file', png)
    await p.waitForSelector('#hs-mc-upload-name:focus', { timeout: 5000 })
    await p.fill('#hs-mc-upload-name', 'taken')
    await p.keyboard.press('Enter')
    if (!(await until(p, async () => (await status()).includes('taken'), 8000))) {
      fail(`a taken name said ${JSON.stringify(await status())}`)
    }
    if (!(await formShown())) fail('a taken name closed the form')
    const before = uploads
    await p.fill('#hs-mc-upload-name', 'taken2')
    await p.keyboard.press('Enter')
    if (!(await until(p, async () => !(await formShown()), 8000))) fail('retry with a new name did not finish')
    if (uploads !== before) fail('retrying after a name conflict uploaded the file again')
    ok('a taken name keeps the form and the uploaded file; the retry does not re-upload')
  } finally {
    await closeContext(c, 'emote upload', prof)
    rmSync(prof, { recursive: true, force: true })
  }
}