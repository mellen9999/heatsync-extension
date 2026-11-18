/**
 * The firefox end of s30: what a person does with a mouse and keyboard, sent to real firefox
 * through webdriver, on tabs that may be in front or hidden. The panel scenarios' oracles (panel,
 * rowsFlow, dbg, ringSince, rows, screen) only need `evaluate`, so each tab answers that too —
 * after bringing itself to the front, because firefox draws nothing in a hidden tab.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchFirefox } from '../lib/firefox'
import { bad as bad_, OUT, ok as ok_, sleep } from './lib'

const EL = 'element-6066-11e4-a52e-4f735466cecf'
// webdriver's key codes: what sendKeys turns into real key events
export const KEY = { ctrl: '\uE009', off: '\uE000', backspace: '\uE003', tab: '\uE004', enter: '\uE007' }
// a hidden tab catches up on what it skipped when shown: give it this long
const SETTLE_MS = 800

export type Tab = Awaited<ReturnType<typeof startSession>>['main']

export async function startSession(extDir: string) {
  const ff = await launchFirefox()
  const base = ff.asPage()
  let cur = ''
  try {
    const id = await ff.install(extDir)
    const host = await ff.privileged<string>('return WebExtensionPolicy.getByID(arguments[0]).mozExtensionHostname', [id])
    cur = await ff.wd<string>('GET', '/window')
    const mainHandle = cur

    const visible = async () => (await ff.page<string>('return document.visibilityState')) === 'visible'
    const front = async (h: string) => {
      if (cur === h) return
      await ff.wd('POST', '/window', { handle: h })
      cur = h
      if (!(await visible())) await ff.ensureVisible()
      await sleep(SETTLE_MS)
    }

    const tab = (h: string) => {
      /** The first element matching css (whose text matches `text`; the last such with `last`), once it exists. */
      const el = async (css: string, o: { text?: string; last?: boolean } = {}, ms = 5000) => {
        await front(h)
        const t0 = Date.now()
        for (;;) {
          const hit = await ff.page<Record<string, string> | null>(
            `const [css, src, last] = arguments
             const re = src ? new RegExp(src) : null
             const all = [...document.querySelectorAll(css)].filter((e) => !re || re.test((e.textContent || '').trim()))
             return (last ? all.at(-1) : all[0]) || null`,
            [css, o.text ?? '', !!o.last],
          )
          if (hit) return hit[EL]
          if (Date.now() - t0 > ms) throw new Error(`no ${css}${o.text ? ` with text ${o.text}` : ''} in ${ms / 1000}s`)
          await sleep(250)
        }
      }
      const act = async (id: string, button: number) => {
        // pointer actions do not scroll their target into view, and a live list moves under a
        // stored position: scroll, read the spot and press there with nothing in between
        const at = await ff.page<{ x: number; y: number }>(
          `arguments[0].scrollIntoView({ block: 'center' })
           const r = arguments[0].getBoundingClientRect()
           return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }`,
          [{ [EL]: id }],
        )
        await ff.wd('POST', '/actions', {
          actions: [
            {
              type: 'pointer',
              id: 'mouse',
              parameters: { pointerType: 'mouse' },
              actions: [
                { type: 'pointerMove', origin: 'viewport', x: at.x, y: at.y },
                { type: 'pointerDown', button },
                { type: 'pointerUp', button },
              ],
            },
          ],
        })
        await ff.wd('DELETE', '/actions')
      }
      const t = {
        h,
        front: () => front(h),
        evaluate: async <T>(fn: (arg?: any) => T, arg?: unknown) => {
          await front(h)
          return base.evaluate<T>(fn, arg)
        },
        async goto(url: string) {
          await front(h)
          await ff.goto(url)
          if (!(await visible())) await ff.ensureVisible()
        },
        el,
        /** True once css is on the page. */
        async has(css: string, ms = 5000) {
          return el(css, {}, ms).then(() => true, () => false)
        },
        async click(css: string, o: { text?: string; last?: boolean; right?: boolean } = {}) {
          // a list that redraws between finding an element and pressing it (the picker, after a search): find again
          for (let i = 0; ; i++) {
            try {
              const id = await el(css, o)
              if (o.right) await act(id, 2)
              else await ff.wd('POST', `/element/${id}/click`, {})
              return
            } catch (e) {
              if (i >= 3 || !/stale/.test(String(e))) throw e
              await sleep(300)
            }
          }
        },
        /** Type into the element (it takes focus first). */
        async keys(css: string, text: string) {
          const id = await el(css)
          await ff.wd('POST', `/element/${id}/value`, { text })
        },
        /** An input emptied and typed into. */
        async fill(css: string, text: string) {
          const id = await el(css)
          await ff.wd('POST', `/element/${id}/clear`, {})
          await ff.wd('POST', `/element/${id}/value`, { text })
        },
        /** The panel's input emptied (ctrl+a, backspace) and typed into, a key at a time like a person. */
        async type(text: string) {
          await t.keys('#hs-mc-input', `${KEY.ctrl}a${KEY.off}${KEY.backspace}`)
          await t.keys('#hs-mc-input', text)
        },
        async clearInput() {
          await t.keys('#hs-mc-input', `${KEY.ctrl}a${KEY.off}${KEY.backspace}`)
          await sleep(200)
        },
        async shot(name: string) {
          await front(h)
          const png = await ff.wd<string>('GET', '/screenshot')
          mkdirSync(OUT, { recursive: true })
          writeFileSync(join(OUT, `${name.replace(/\W+/g, '-').slice(0, 80)}.png`), Buffer.from(png, 'base64'))
        },
      }
      return t
    }

    /** A new tab, in front. */
    const newTab = async () => {
      const { handle } = await ff.wd<{ handle: string }>('POST', '/window/new', { type: 'tab' })
      await ff.wd('POST', '/window', { handle })
      cur = handle
      return tab(handle)
    }
    const closeTab = async (t: Tab) => {
      await front(t.h)
      await ff.wd('DELETE', '/window')
      cur = ''
    }

    // the add-on's own page: the only place storage can be read and written from
    let ext: Tab | null = null
    const extRun = async <T>(body: string, a?: unknown): Promise<T> => {
      if (!ext) {
        ext = await newTab()
        await ff.goto(`moz-extension://${host}/popup.html`)
      }
      await front(ext.h)
      const r = await ff.pageAsync<T | { __err: string }>(
        `const done = arguments[arguments.length - 1]
         const a = arguments[0]
         ;(async () => { ${body} })().then(done, (e) => done({ __err: String(e) }))`,
        [a],
      )
      if (r && typeof r === 'object' && '__err' in r) throw new Error(`add-on page: ${(r as { __err: string }).__err}`)
      return r as T
    }

    return {
      ff,
      main: tab(mainHandle),
      newTab,
      closeTab,
      /** One key of storage.local, as the add-on's page sees it. */
      stored: <T>(key: string) => extRun<T>('return (await browser.storage.local.get(a))[a] ?? null', key),
      /** Write keys into storage.local, the way another tab or device would. */
      store: (items: Record<string, unknown>) => extRun<number>('await browser.storage.local.set(a); return 1', items),
      hsErrors: async () => ((await extRun<unknown[] | null>("return (await browser.storage.local.get('hs_errors')).hs_errors ?? null")) || []).length,
      addonErrors: async () => (await ff.addonErrors()).length,
      async close() {
        await ff.close()
      },
    }
  } catch (e) {
    await ff.close()
    throw e
  }
}
export type Session = Awaited<ReturnType<typeof startSession>>

/**
 * One judged step: what it returns is the list of what went wrong, and anything the add-on logged
 * during it (firefox's console, hs_errors) is added. Green or red, said in a plain line.
 */
export function stepper(s: Session, label: string, onRed: (what: string) => Promise<unknown>) {
  return async (what: string, fn: () => Promise<string[]>) => {
    const e0 = await s.addonErrors()
    const h0 = await s.hsErrors()
    const why = await fn().catch((e) => [`threw: ${String(e?.message || e).slice(0, 200)}`])
    const e1 = await s.addonErrors()
    const h1 = await s.hsErrors()
    if (e1 > e0) why.push(`${e1 - e0} add-on error(s) in firefox's console: ${(await s.ff.addonErrors()).at(-1)?.slice(0, 160)}`)
    if (h1 > h0) why.push(`${h1 - h0} new in hs_errors`)
    if (!why.length) return ok_(`${label} ${what}`)
    bad_(`${label} ${what}: ${why.join('; ')}`, await onRed(what).catch(() => undefined))
  }
}
