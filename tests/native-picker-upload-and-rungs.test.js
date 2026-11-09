/**
 * The NATIVE picker (heatsync-button.js, overlay off) uploads your own emote
 * through the overlay picker's own rules, and native chat rows draw your own
 * emote at the rung that fits the screen.
 *
 * Neither source file can be imported (shared bundle scope, no exports), so the
 * real functions are carved out and run — they cannot pass against a copy.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const CORE = read('src/multichat/emote-upload-core.js')
const NATIVE = read('src/content/native-emote-upload.js')
const RUNGS = read('src/multichat/emote-rungs.js')

const t = (key, subs) => (subs ? `${key}:${subs.join(',')}` : key)

const core = new Function(
  't',
  `${CORE}\nreturn { HS_EU_MAX_BYTES, HS_EU_TYPES, hsEuDefaultName, hsEuFileProblem, hsEuNameOk, hsEuReason, hsEuSubmit }`,
)(t)

const rungs = (dpr) => new Function('devicePixelRatio', `${RUNGS}\nreturn { hsNativeRowUrl }`)(dpr)

const UP = 'https://cdn.heatsync.org/uploads/abc123.webp'

describe('native rows pick your own emote rung by screen', () => {
  const own = { url: UP, variants: ['1x', '2x', '3x', '4x'] }
  test('1x screen draws the 1x copy', () => {
    expect(rungs(1).hsNativeRowUrl(own)).toBe('https://cdn.heatsync.org/uploads/abc123-1x.webp')
  })
  test('dense screen draws the 2x copy', () => {
    expect(rungs(2).hsNativeRowUrl(own)).toBe('https://cdn.heatsync.org/uploads/abc123-2x.webp')
  })
  test('only the rungs that exist: smallest at least as dense, else the canonical file', () => {
    expect(rungs(2).hsNativeRowUrl({ url: UP, variants: ['1x'] })).toBe(UP)
    expect(rungs(2).hsNativeRowUrl({ url: UP, variants: ['1x', '3x'] })).toBe(
      'https://cdn.heatsync.org/uploads/abc123-3x.webp',
    )
  })
  test('no advertised variants = the url, untouched (old uploads, 7tv, bttv)', () => {
    expect(rungs(2).hsNativeRowUrl({ url: UP })).toBe(UP)
    expect(rungs(2).hsNativeRowUrl({ url: 'https://cdn.7tv.app/emote/x/1x.webp' })).toBe(
      'https://cdn.7tv.app/emote/x/1x.webp',
    )
  })
  test('a variants list never retargets a url that is not our own upload', () => {
    const other = 'https://evil.example/uploads/abc123.webp'
    expect(rungs(2).hsNativeRowUrl({ url: other, variants: ['2x'] })).toBe(other)
  })
  test('both native row renderers use it, and the mirror-lag fallback is armed', () => {
    const c = read('src/content/content.js')
    const y = read('src/content/youtube-content.js')
    expect(c).toContain('hsNativeRowUrl(emote)')
    expect(c).toContain('hsOwnCopyFallback(img)')
    expect(y).toContain('hsNativeRowUrl(emote)')
    expect(y).toContain('hsOwnCopyFallback(img)')
  })
})

describe('upload rules are one copy', () => {
  test('same caps, types and name rules the overlay has', () => {
    expect(core.HS_EU_MAX_BYTES).toBe(10 * 1048576)
    expect(core.hsEuFileProblem({ type: 'image/png', size: 10 })).toBe('')
    expect(core.hsEuFileProblem({ type: 'video/mp4', size: 10 })).toBe('mc_emote_upload_bad_type')
    expect(core.hsEuFileProblem({ type: 'image/gif', size: 11 * 1048576 })).toBe('mc_input_upload_too_large:10')
    expect(core.hsEuNameOk('pog')).toBe(true)
    expect(core.hsEuNameOk('two words')).toBe(false)
    expect(core.hsEuNameOk('')).toBe(false)
    expect(core.hsEuDefaultName({ name: 'My Cool-Emote-2x.png' })).toBe('MyCoolEmote')
  })
  test('error copy maps to the existing locale keys', () => {
    expect(core.hsEuReason({ status: 401 })).toBeNull()
    expect(core.hsEuReason({ status: 429 })).toBe('mc_emote_upload_slow')
    expect(core.hsEuReason({ error: 'Content violates community guidelines' })).toBe('mc_emote_upload_blocked')
    expect(core.hsEuReason({ error: 'Daily upload limit reached' })).toBe('mc_emote_upload_limit')
  })
  test('the two request shapes live in exactly one file', () => {
    for (const f of ['src/multichat/emote-upload.js', 'src/content/native-emote-upload.js']) {
      expect(read(f)).not.toContain("'api_upload'")
      expect(read(f)).not.toContain("'add_to_inventory'")
    }
    expect(CORE).toContain("'api_upload'")
  })
  test('the native bundle embeds the core ahead of the form; overlay bundle too', () => {
    const b = read('build.js')
    expect(b).toMatch(/'heatsync-button\.js': \[[^\]]*emote-upload-core\.js[^\]]*native-emote-upload\.js/)
    expect(b.indexOf("'emote-upload-core.js'")).toBeLessThan(b.indexOf("'emote-upload.js'"))
  })
})

// A just-enough DOM: elements by id with the bits the form touches.
function fakePanel() {
  const els = {}
  for (const id of ['btn', 'file', 'form', 'name', 'go', 'cancel', 'status']) {
    const listeners = {}
    els[id] = {
      hidden: id === 'form',
      disabled: false,
      value: '',
      textContent: '',
      files: [],
      listeners,
      classList: { toggle() {} },
      addEventListener(ev, fn) {
        listeners[ev] = fn
      },
      focus() {},
      select() {},
      click() {},
    }
  }
  return { els, querySelector: (sel) => els[sel.replace('#hs-nu-', '')] ?? null }
}

function wire(send) {
  const panel = fakePanel()
  const toasts = []
  const added = []
  const mod = new Function(
    't',
    'browser',
    'HS_EU_TYPES',
    'hsEuFileProblem',
    'hsEuDefaultName',
    'hsEuNameOk',
    'hsEuReason',
    'hsEuSubmit',
    'hsXButtonHtml',
    `${NATIVE}\nreturn hsNativeUploadWire`,
  )(
    t,
    { runtime: { sendMessage: send } },
    core.HS_EU_TYPES,
    core.hsEuFileProblem,
    core.hsEuDefaultName,
    core.hsEuNameOk,
    core.hsEuReason,
    core.hsEuSubmit,
    () => '',
  )
  const h = mod(panel, { toast: (m) => toasts.push(m), added: (n) => added.push(n) })
  return { panel, h, toasts, added }
}

const png = { name: 'pog.png', type: 'image/png', size: 100 }
// FileReader is a DOM global; the core reads the file through it.
globalThis.FileReader = class {
  constructor() {
    this.l = {}
  }
  addEventListener(ev, fn) {
    this.l[ev] = fn
  }
  readAsDataURL() {
    this.result = 'data:image/png;base64,AAAA'
    queueMicrotask(() => this.l.load())
  }
}

describe('native picker upload form', () => {
  test('a good file opens the name form with the default name; the upload button hides', () => {
    const { panel, h } = wire(async () => ({}))
    h.pick(png)
    expect(panel.els.form.hidden).toBe(false)
    expect(panel.els.btn.hidden).toBe(true)
    expect(panel.els.name.value).toBe('pog')
  })

  test('a bad file says why and keeps the form closed', () => {
    const { panel, h } = wire(async () => ({}))
    h.pick({ name: 'a.mp4', type: 'video/mp4', size: 5 })
    expect(panel.els.status.textContent).toBe('mc_emote_upload_bad_type')
    expect(panel.els.form.hidden).toBe(true)
  })

  test('upload then add: both background messages go out, the set refreshes, you are told', async () => {
    const sent = []
    const { panel, h, toasts, added } = wire(async (m) => {
      sent.push(m)
      return m.type === 'api_upload'
        ? { ok: true, url: UP, phash: 'p', width: 128, height: 128 }
        : { success: true, hash: 'h1', slot: 3 }
    })
    h.pick(png)
    await h.submit()
    expect(sent.map((m) => m.type)).toEqual(['api_upload', 'add_to_inventory'])
    expect(sent[0]).toMatchObject({ emote: true, mime: 'image/png', dataUrl: 'data:image/png;base64,AAAA' })
    expect(sent[1]).toMatchObject({
      emoteName: 'pog',
      emoteUrl: UP,
      zeroWidth: false,
      upload: { phash: 'p', width: 128, height: 128 },
    })
    expect(added).toEqual(['pog'])
    expect(toasts).toEqual(['mc_emote_added:pog'])
    expect(panel.els.form.hidden).toBe(true)
  })

  test('a taken name keeps the uploaded file: the retry sends only the add', async () => {
    const sent = []
    let taken = true
    const { panel, h, added } = wire(async (m) => {
      sent.push(m.type)
      if (m.type === 'api_upload') return { ok: true, url: UP }
      return taken ? { success: false, status: 409, error: 'already in inventory' } : { success: true, hash: 'h' }
    })
    h.pick(png)
    await h.submit()
    expect(panel.els.status.textContent).toBe('mc_emote_upload_taken:pog')
    expect(panel.els.form.hidden).toBe(false)
    taken = false
    panel.els.name.value = 'pog2'
    await h.submit()
    expect(sent).toEqual(['api_upload', 'add_to_inventory', 'add_to_inventory'])
    expect(added).toEqual(['pog2'])
  })

  test('a name with a space is refused before anything is sent', async () => {
    const sent = []
    const { panel, h } = wire(async (m) => {
      sent.push(m)
      return {}
    })
    h.pick(png)
    panel.els.name.value = 'two words'
    await h.submit()
    expect(sent).toEqual([])
    expect(panel.els.status.textContent).toBe('mc_emote_upload_name_bad')
  })

  test('not signed in: the login line, a toast, and the form resets', async () => {
    const { panel, h, toasts } = wire(async () => ({ ok: false, status: 401, error: 'not logged in' }))
    h.pick(png)
    await h.submit()
    expect(panel.els.status.textContent).toBe('mc_emote_add_login')
    expect(toasts).toEqual(['mc_emote_add_login'])
    expect(panel.els.form.hidden).toBe(true)
  })

  test('a throwing worker is a plain failure, never a hang', async () => {
    const { panel, h } = wire(async () => {
      throw new Error('Extension context invalidated')
    })
    h.pick(png)
    await h.submit()
    expect(panel.els.status.textContent).toContain('mc_input_upload_failed_why')
    expect(panel.els.go.disabled).toBe(false)
  })
})
