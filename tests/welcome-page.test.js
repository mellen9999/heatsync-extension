/**
 * The welcome page a new install opens. A 9-year-old has to be able to drive it end to end, so:
 * the first thing it says is how to START (open a stream — reading chat needs no account), with
 * real links to try; step 2 is how to hide and show the chat; signing in comes last and says
 * it is optional. Run for real against happy-dom with chrome.storage faked: the logged-in swap
 * and the language hydrate are behaviour, not text.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'

const ROOT = join(import.meta.dir, '..')
const HTML = readFileSync(join(ROOT, 'chrome', 'welcome.html'), 'utf8')
const JS = readFileSync(join(ROOT, 'chrome', 'welcome.js'), 'utf8')
const EN = JSON.parse(readFileSync(join(ROOT, 'src', '_locales', 'en', 'messages.json'), 'utf8'))

const flush = () => new Promise((r) => setTimeout(r, 5))

// the page as the browser builds it: markup, then the script, with the extension apis faked
async function openPage({ token } = {}) {
  const win = new Window()
  const doc = win.document
  doc.write(HTML.replace(/<script[^>]*src="welcome.js"[^>]*><\/script>/, ''))
  const store = token ? { auth_token_encrypted: token } : {}
  const listeners = []
  const chrome = {
    i18n: { getMessage: (k) => `«${k}»` },
    storage: {
      local: { get: async (k) => (k in store ? { [k]: store[k] } : {}) },
      onChanged: { addListener: (fn) => listeners.push(fn) },
    },
  }
  win.close = () => {}
  new Function('window', 'document', 'chrome', 'browser', JS)(win, doc, chrome, undefined)
  await flush()
  return { win, doc, listeners, store }
}

describe('welcome page: the way a first minute goes', () => {
  test('it opens with how to start, not with a login: steps are 1 open a stream, 2 hide/show, 3 sign in', async () => {
    const { doc } = await openPage()
    const steps = [...doc.querySelectorAll('.steps > li')]
    expect(steps.length).toBe(3)
    expect(steps[0].querySelector('h2').getAttribute('data-i18n')).toBe('welcome_s1_t')
    expect(steps[1].querySelector('h2').getAttribute('data-i18n')).toBe('welcome_s2_t')
    expect(steps[2].querySelector('h2').getAttribute('data-i18n')).toBe('welcome_s3_t')
    // nothing about signing in comes before the third step
    const login = doc.querySelector('a[href="https://heatsync.org/login"]')
    expect(steps[2].contains(login)).toBe(true)
    expect(doc.querySelector('.steps').previousElementSibling.querySelector('a')).toBeNull()
  })

  test('step 1 carries direct links to a twitch, a kick and a youtube page, in new tabs', async () => {
    const { doc } = await openPage()
    const links = [...doc.querySelectorAll('.steps > li:first-child a')]
    const hosts = links.map((a) => new URL(a.href).hostname)
    expect(hosts).toEqual(['www.twitch.tv', 'kick.com', 'www.youtube.com'])
    for (const a of links) {
      expect(a.target).toBe('_blank')
      expect(a.rel).toContain('noopener')
      expect(new URL(a.href).protocol).toBe('https:')
    }
  })

  test('the primary (white) buttons are the stream links; sign-in is the quiet one, and says optional', async () => {
    const { doc } = await openPage()
    const primary = [...doc.querySelectorAll('a.cta')].map((a) => new URL(a.href).hostname)
    expect(primary).toEqual(['www.twitch.tv', 'kick.com', 'www.youtube.com'])
    const signIn = doc.querySelector('a[href="https://heatsync.org/login"]')
    expect(signIn.classList.contains('cta')).toBe(false)
    expect(EN.welcome_s3_t.message).toContain('optional')
    expect(EN.welcome_get_2.message).toContain('no account') // the page leads with it
  })

  test('step 3 says in one line what an account adds', () => {
    const line = EN.welcome_s3_d.message
    expect(line).toMatch(/twitch, kick and youtube at once/)
    expect(line).toMatch(/emotes/)
    expect(line.length).toBeLessThan(120)
  })

  test('step 2 teaches both halves: the hide button, and the strip that brings the chat back', () => {
    expect(EN.welcome_s2_d.message).toMatch(/hide/)
    expect(EN.welcome_s2_d.message).toMatch(/strip/)
    expect(EN.welcome_s2_d.message).toMatch(/back/)
  })

  test('every string on the page is in the catalog, and the page speaks the viewer’s language', async () => {
    const { doc } = await openPage()
    const keys = [...doc.querySelectorAll('[data-i18n]')].map((el) => el.dataset.i18n)
    expect(keys.length).toBeGreaterThan(8)
    for (const k of keys) expect(EN[k], k).toBeDefined()
    for (const el of doc.querySelectorAll('[data-i18n]')) expect(el.textContent).toBe(`«${el.dataset.i18n}»`)
  })

  test('signing in swaps the button for "you’re in" the moment the token lands, and back on sign-out', async () => {
    const { doc, listeners } = await openPage()
    const out = doc.querySelector('[data-when="out"]')
    const inn = doc.querySelector('[data-when="in"]')
    expect(out.hidden).toBe(false)
    expect(inn.hidden).toBe(true)
    for (const fn of listeners) fn({ auth_token_encrypted: { newValue: 'x' } }, 'local')
    expect(out.hidden).toBe(true)
    expect(inn.hidden).toBe(false)
    for (const fn of listeners) fn({ auth_token_encrypted: { newValue: undefined } }, 'local')
    expect(out.hidden).toBe(false)
  })

  test('an already signed-in page opens on "you’re in" with no sign-in button', async () => {
    const { doc } = await openPage({ token: 'abc' })
    expect(doc.querySelector('[data-when="out"]').hidden).toBe(true)
    expect(doc.querySelector('[data-when="in"]').hidden).toBe(false)
  })

  test('the words the page dropped are gone from the catalog, not left to rot in 34 files', () => {
    for (const k of ['welcome_explain', 'welcome_get_title', 'welcome_get_1', 'welcome_get_3', 'welcome_start_title']) {
      expect(EN[k], k).toBeUndefined()
    }
  })
})
