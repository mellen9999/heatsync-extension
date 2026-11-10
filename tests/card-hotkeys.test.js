/**
 * The profile card's underlined letters are real keys — the extension half.
 *
 * There is no keymap in profile-card.js any more. The shared model names each key
 * (card-model.js: actions, platform pills, note edit), the shared renderer
 * underlines it inside its label and stamps `data-hs-hotkey` (card-render.js), and
 * `hsCardHotkeyTarget` reads it back. pcOnCardKey is only the guard and the click,
 * and these run it for real: the real shared model + renderer (concatenated the way
 * the bundle does), the real pcOnCardKey / pcSetLabel sliced out of profile-card.js,
 * a real happy-dom page and real keydown events.
 *
 * The site's half is heatsync tests/client/card/card-hotkeys.test.js + card-keys.test.js.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { escapeHtml } from '../src/lib/utils.js'

const ROOT = join(import.meta.dir, '..')
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8')
const CARD = read('src', 'multichat', 'profile-card.js')

// the bundle concatenates these three into one scope (imports dropped, `export` stripped)
const LIB = ['card-time.js', 'card-model.js', 'card-render.js']
  .map((f) =>
    read('src', 'lib', f)
      .replace(/^import .*$/gm, '')
      .replace(/^export\s+/gm, ''),
  )
  .join('\n')

function slice(src, start, end) {
  const a = src.indexOf(start)
  const b = src.indexOf(end, a)
  if (a === -1 || b === -1) throw new Error(`marker not found: ${start} .. ${end}`)
  return src.slice(a, b)
}
const KEYS_SRC = slice(CARD, 'function pcOnCardKey(e) {', '// Dispatches a click on a .hs-card-action button')

let win
let doc
let env
let closed
let panelOpen
let ownedKeyups

function makeEnv() {
  const state = { activeProfileCard: null }
  const make = new Function(
    'state',
    'escapeHtml',
    'closeProfileCard',
    'hsPanePanelOpen',
    'ownKeyup',
    `${LIB}
    ${KEYS_SRC.replace(/activeProfileCard/g, 'state.activeProfileCard')}
    return { hsCardModel, hsCardHtml, hsCardHotkeyTarget, hsCardHotkeySplit, pcOnCardKey, pcSetLabel }`,
  )
  return {
    state,
    ...make(
      state,
      escapeHtml,
      () => {
        closed.push(true)
        state.activeProfileCard = null
      },
      () => panelOpen,
      (e) => ownedKeyups.push(e.key),
    ),
  }
}

const deps = { formatCompactNumber: (n) => String(n) }
// what renderProfileCardView passes, plus report: the shared table maps `r` for any host that shows it
const CAPS = { follow: true, whisper: true, dm: true, mention: true, mute: true, block: true, report: true }

/** The ext-only buttons renderProfileCardView appends: [hotkey, label], read out of the source. */
function extOnlyButtons() {
  const out = []
  const re = /(\w+)Btn\.dataset\.hsHotkey = '(.)'[^\n]*\n\s*pcSetLabel\(\1Btn, '([^']+)'\)/g
  for (let m = re.exec(CARD); m; m = re.exec(CARD)) out.push({ name: m[1], hotkey: m[2], label: m[3] })
  return out
}

/** The panel card exactly as renderProfileCardView builds it: shared render + the ext-only buttons. */
function mountPanelCard({ variant = 'panel', hotkeys = true, profile = {} } = {}) {
  const model = env.hsCardModel(
    {
      profile: {
        id: 'other',
        username: 'x',
        twitch_username: 'x_ttv',
        kick_username: 'x_kick',
        youtube_username: 'x_yt',
        ...profile,
      },
    },
    { viewerId: 'me', hint: { platform: 'twitch', login: 'x' }, capabilities: CAPS },
    deps,
  )
  const wrap = doc.createElement('div')
  wrap.innerHTML = env.hsCardHtml(model, { variant, hotkeys, navInBar: variant === 'panel', escapeHtml })
  const card = wrap.firstElementChild
  doc.body.appendChild(card)
  const row = card.querySelector('.hs-card-actions')
  if (hotkeys) {
    for (const b of extOnlyButtons()) {
      const btn = doc.createElement('button')
      btn.className = 'hs-card-action'
      btn.dataset.hsCardAction = { add: 'addchannel', clip: 'clip', gift: 'gift' }[b.name]
      btn.dataset.hsHotkey = b.hotkey
      env.pcSetLabel(btn, b.label)
      row?.appendChild(btn)
    }
  }
  env.state.activeProfileCard = { username: 'x', platform: 'twitch', cardEl: card }
  return card
}

function press(key, init = {}, target = doc.body) {
  const e = new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(e)
  return e
}

let clicks
let removeListener
beforeEach(() => {
  win = new Window()
  doc = win.document
  closed = []
  ownedKeyups = []
  panelOpen = false
  clicks = []
  env = makeEnv()
  // the same registration setupProfileCardHandlers makes
  doc.addEventListener('keydown', env.pcOnCardKey, { capture: true })
  removeListener = () => doc.removeEventListener('keydown', env.pcOnCardKey, { capture: true })
  doc.addEventListener('click', (e) =>
    clicks.push(e.target.closest('[data-hs-card-action]')?.dataset.hsCardAction ?? null),
  )
})
afterEach(() => {
  removeListener()
  win.close()
})

describe('the keys, key -> element', () => {
  test.each([
    ['f', 'follow'],
    ['w', 'whisper'],
    ['d', 'dm'],
    ['@', 'mention'],
    ['m', 'mute'],
    ['b', 'block'],
    ['r', 'report'],
    ['+', 'addchannel'],
    ['=', 'addchannel'],
    ['c', 'clip'],
    ['g', 'gift'],
    ['F', 'follow'],
  ])('%s presses %s', (key, action) => {
    mountPanelCard()
    const e = press(key)
    expect(clicks).toEqual([action])
    expect(e.defaultPrevented).toBe(true)
  })

  test('the keys are not claimed twice: a page handler behind the card never sees them', () => {
    mountPanelCard()
    let page = 0
    doc.addEventListener('keydown', () => page++)
    press('f')
    expect(page).toBe(0)
    expect(ownedKeyups).toEqual(['f']) // youtube acts on keyup for some keys — the card owns that keyup too
  })

  test('every ext-only button is stamped with a key its own label shows', () => {
    const buttons = extOnlyButtons()
    expect(buttons.map((b) => b.name).sort()).toEqual(['add', 'clip', 'gift'])
    for (const b of buttons) expect(env.hsCardHotkeySplit(b.label, b.hotkey), b.label).not.toBeNull()
  })

  test('no ext-only key collides with a model key', () => {
    const card = mountPanelCard({ variant: 'full' })
    const keys = [...card.querySelectorAll('[data-hs-hotkey]')].map((el) => el.dataset.hsHotkey)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('underline <=> the key works', () => {
  test('every keyed cell shows its letter, every shown letter is keyed', () => {
    const card = mountPanelCard()
    const cells = [...card.querySelectorAll('.hs-card-action')]
    expect(cells.length).toBe(10)
    for (const el of cells) {
      expect(!!el.querySelector('.hs-card-hk'), el.dataset.hsCardAction).toBe(el.hasAttribute('data-hs-hotkey'))
    }
  })

  test('"@mention" is underlined on its @, which is the key it answers to', () => {
    const card = mountPanelCard()
    const el = card.querySelector('[data-hs-card-action="mention"]')
    expect(el.textContent).toBe('@mention')
    expect(el.querySelector('.hs-card-hk').textContent).toBe('@')
    expect(el.dataset.hsHotkey).toBe('@')
  })

  test('mention is not mute: m is mute and @ is mention', () => {
    mountPanelCard()
    press('m')
    press('@')
    expect(clicks).toEqual(['mute', 'mention'])
  })

  test('"unfollow" / "unblock" underline the f / b, not the u', () => {
    const card = mountPanelCard({ profile: { relationship: { isFollowing: true } } })
    expect(card.querySelector('[data-hs-card-action="follow"] .hs-card-hk').textContent).toBe('f')
    expect(card.querySelector('[data-hs-card-action="follow"]').textContent).toBe('unfollow')
    press('f')
    expect(clicks).toEqual(['follow'])
  })

  test('the muted repaint ("unmute") keeps the m underlined; a word without the letter rests the key', () => {
    const card = mountPanelCard()
    const mute = card.querySelector('[data-hs-card-action="mute"]')
    env.pcSetLabel(mute, 'unmute')
    expect(mute.querySelector('.hs-card-hk').textContent).toBe('m')
    expect(mute.textContent).toBe('unmute')
    press('m')
    expect(clicks).toEqual(['mute'])

    env.pcSetLabel(mute, 'ミュート解除') // a localized word with no m: plain, and no key
    expect(mute.querySelector('.hs-card-hk')).toBeNull()
    expect(mute.textContent).toBe('ミュート解除')
    clicks.length = 0
    expect(press('m').defaultPrevented).toBe(false)
    expect(clicks).toEqual([])
  })

  test('clip progress words keep the key where they have it', () => {
    const card = mountPanelCard()
    const clip = card.querySelector('[data-hs-card-action="clip"]')
    env.pcSetLabel(clip, 'url copied') // c of "copied"
    expect(clip.querySelector('.hs-card-hk').textContent).toBe('c')
    env.pcSetLabel(clip, 'ok')
    expect(clip.querySelector('.hs-card-hk')).toBeNull()
    expect(env.hsCardHotkeyTarget(card, 'c')).toBeNull()
  })
})

describe('what is not a card key', () => {
  test('typing in the composer or any field', () => {
    mountPanelCard()
    const input = doc.body.appendChild(doc.createElement('input'))
    const area = doc.body.appendChild(doc.createElement('textarea'))
    const rich = doc.body.appendChild(doc.createElement('div'))
    rich.setAttribute('contenteditable', 'true')
    for (const el of [input, area, rich]) expect(press('f', {}, el).defaultPrevented, el.tagName).toBe(false)
    expect(clicks).toEqual([])
  })

  test("a chord: ctrl+f / ctrl+c / cmd+f / alt+m are the browser's and the page's", () => {
    mountPanelCard()
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      expect(press('f', init).defaultPrevented).toBe(false)
      expect(press('c', init).defaultPrevented).toBe(false)
    }
    expect(press('f', { isComposing: true }).defaultPrevented).toBe(false)
    expect(clicks).toEqual([])
  })

  test('a held key is one press', () => {
    mountPanelCard()
    press('f')
    expect(press('f', { repeat: true }).defaultPrevented).toBe(true)
    expect(clicks).toEqual(['follow'])
  })

  test("no open card: every key is the page's", () => {
    mountPanelCard()
    env.state.activeProfileCard = null
    expect(press('f').defaultPrevented).toBe(false)
    expect(clicks).toEqual([])
  })

  test('a confirm panel over the card takes the keyboard', () => {
    mountPanelCard()
    panelOpen = true
    expect(press('b').defaultPrevented).toBe(false)
    expect(clicks).toEqual([])
  })

  test('a button that is disabled right now (clipping) is not pressed', () => {
    const card = mountPanelCard()
    card.querySelector('[data-hs-card-action="clip"]').disabled = true
    expect(press('c').defaultPrevented).toBe(false)
    expect(clicks).toEqual([])
  })

  test("t / k / y: the panel's destinations ride the 2nd row, so no letter is shown and none works", () => {
    mountPanelCard({ variant: 'panel' })
    for (const k of ['t', 'k', 'y', 'h']) expect(press(k).defaultPrevented, k).toBe(false)
  })

  test('the hover tooltip (peek) shows no letter and takes no key', () => {
    const card = mountPanelCard({ variant: 'peek', hotkeys: false })
    expect(card.querySelectorAll('[data-hs-hotkey], .hs-card-hk')).toHaveLength(0)
    for (const k of ['f', 'b', 'm']) expect(press(k).defaultPrevented, k).toBe(false)
    expect(clicks).toEqual([])
  })
})

describe('the floating card draws its own nav row: the pills are keyed', () => {
  test('t / k / y click their pill; h (the profile cell has no h to underline) does nothing', () => {
    const card = mountPanelCard({ variant: 'full' })
    const hits = []
    for (const a of card.querySelectorAll('.hs-card-plat-link')) {
      a.addEventListener('click', (e) => {
        e.preventDefault()
        hits.push(a.dataset.tone)
      })
    }
    press('t')
    press('k')
    press('y')
    expect(hits).toEqual(['ttv', 'kick', 'yt'])
    expect(press('h').defaultPrevented).toBe(false)
    expect(card.querySelector('[data-tone="hs"]').querySelector('.hs-card-hk')).toBeNull()
  })
})

describe('Escape', () => {
  test('closes the card, from the page and from inside a field alike', () => {
    mountPanelCard()
    const input = doc.body.appendChild(doc.createElement('input'))
    expect(press('Escape', {}, input).defaultPrevented).toBe(true)
    expect(closed).toHaveLength(1)
    mountPanelCard()
    press('Escape')
    expect(closed).toHaveLength(2)
  })

  test('with no card open it is not ours', () => {
    expect(press('Escape').defaultPrevented).toBe(false)
    expect(closed).toHaveLength(0)
  })
})

describe('wiring — what keeps the keymap single', () => {
  test('profile-card.js has no keymap of its own: the shared helper is the only lookup', () => {
    expect(CARD).toContain('hsCardHotkeyTarget(activeProfileCard.cardEl, e.key)')
    expect(CARD).not.toMatch(/new Set\(\['t', 'k', 'y', 'h'/)
    expect(CARD).not.toMatch(/\{ f: 'follow'/)
    expect(CARD).not.toMatch(/\.hs-card-plat-link\[data-tone=/)
  })

  test('the card opts in, so its underlines are promises pcOnCardKey keeps', () => {
    expect(CARD).toMatch(/hsCardHtmlL10n\(model, \{[^}]*hotkeys: true/s)
    expect(CARD).toContain('activeProfileCard.cardEl = card')
  })

  test('the listener is registered in the capture phase (the page must not also act on a letter the card took)', () => {
    expect(CARD).toMatch(
      /cleanup\.addEventListener\(document, 'keydown', pcOnCardKey, \{ capture: true \}, 'mc-pcard-keys'\)/,
    )
  })

  test('the hover tooltip does not opt in', () => {
    const tips = read('src', 'multichat', 'tooltips.js')
    expect(tips).not.toContain('hotkeys: true')
  })
})
