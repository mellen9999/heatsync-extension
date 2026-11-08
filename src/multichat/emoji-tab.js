// emoji-tab.js — the picker's emoji tab: search by name or filter by category,
// click (or Enter in the search box) puts the emoji in the composer. Port of
// the site picker's emoji tab (emote-picker.js) over the bundled EMOJI_DATA.
//
// No import/export: concatenated into the multichat bundle (build.js).

const HS_EMOJI_CAP = 200
const HS_EMOJI_CATS = [
  ['smileys', '😀'],
  ['people', '👋'],
  ['animals', '🐱'],
  ['food', '🍕'],
  ['travel', '✈️'],
  ['activities', '⚽'],
  ['objects', '💡'],
  ['symbols', '❤️'],
  ['flags', '🏳️'],
]
let hsEmojiCat = ''

// name-substring + optional category, capped — pure
function hsEmojiFilter(data, q, cat) {
  if (!Array.isArray(data)) return []
  const needle = String(q || '')
    .toLowerCase()
    .trim()
  const out = []
  for (const e of data) {
    if (cat && e.category !== cat) continue
    if (needle && !e.name.includes(needle)) continue
    out.push(e)
    if (out.length >= HS_EMOJI_CAP) break
  }
  return out
}

/** The tab's markup. Built with the panel, like every other tab. */
function hsEmojiTabHtml() {
  const cats = HS_EMOJI_CATS.map(
    ([id, ico]) =>
      `<button type="button" class="hs-mc-emoji-cat" data-cat="${escapeHtml(id)}" title="${escapeHtml(id)}">${escapeHtml(ico)}</button>`,
  ).join('')
  return `<div class="hs-mc-tab-content hs-mc-emoji-tab" id="hs-mc-tab-emoji" style="display: none; flex-direction: column;">
        <div class="hs-mc-picker-header">
          <div class="hs-mc-search-wrap">
            <input type="text" id="hs-mc-emoji-search" placeholder="${escapeHtml(t('mc_emoji_search_placeholder'))}" autocomplete="off" spellcheck="false">
          </div>
          <div class="hs-mc-emoji-cats">${cats}</div>
        </div>
        <div class="hs-mc-picker-scroll hs-mc-emoji-grid" id="hs-mc-emoji-grid"></div>
      </div>`
}

function hsRenderEmoji() {
  const grid = document.getElementById('hs-mc-emoji-grid')
  if (!grid) return
  const q = document.getElementById('hs-mc-emoji-search')?.value || ''
  const rows = hsEmojiFilter(typeof EMOJI_DATA === 'undefined' ? [] : EMOJI_DATA, q, hsEmojiCat)
  if (!rows.length) {
    const none = document.createElement('div')
    none.className = 'hs-mc-picker-empty'
    none.textContent = t(typeof EMOJI_DATA === 'undefined' ? 'mc_emoji_no_data' : 'mc_emoji_none')
    grid.replaceChildren(none)
    return
  }
  const frag = document.createDocumentFragment()
  for (const e of rows) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'hs-mc-emoji-tile'
    b.textContent = e.emoji
    b.title = `:${e.name}:`
    b.dataset.emoji = e.emoji
    frag.append(b)
  }
  grid.replaceChildren(frag)
}

function hsPickEmoji(ch) {
  if (ch) mcQuoteToInput(ch)
}

function hsWireEmojiTab(picker) {
  const input = document.getElementById('hs-mc-emoji-search')
  const grid = document.getElementById('hs-mc-emoji-grid')
  if (!input || !grid) return
  let timer = null
  cleanup.addEventListener(
    input,
    'input',
    () => {
      cleanup.clearTimeout(timer)
      timer = cleanup.setTimeout(hsRenderEmoji, 120)
    },
    'mc-emoji-search',
  )
  // Enter takes the first match, so a typed name is one keystroke from the composer
  cleanup.addEventListener(
    input,
    'keydown',
    (e) => {
      if (e.key !== 'Enter') return
      e.preventDefault()
      hsPickEmoji(grid.querySelector('.hs-mc-emoji-tile')?.dataset.emoji)
    },
    'mc-emoji-enter',
  )
  // a real <button> steals focus on mousedown; the search box keeps it
  cleanup.addEventListener(
    grid,
    'mousedown',
    (e) => e.target.closest('.hs-mc-emoji-tile') && e.preventDefault(),
    'mc-emoji-nofocus',
  )
  cleanup.addEventListener(
    grid,
    'click',
    (e) => {
      const b = e.target.closest('.hs-mc-emoji-tile')
      if (!b) return
      e.stopPropagation()
      hsPickEmoji(b.dataset.emoji)
    },
    'mc-emoji-pick',
  )
  for (const btn of picker.querySelectorAll('.hs-mc-emoji-cat')) {
    cleanup.addEventListener(
      btn,
      'click',
      (e) => {
        e.stopPropagation()
        hsEmojiCat = hsEmojiCat === btn.dataset.cat ? '' : btn.dataset.cat
        for (const o of picker.querySelectorAll('.hs-mc-emoji-cat'))
          o.classList.toggle('active', o.dataset.cat === hsEmojiCat)
        hsRenderEmoji()
      },
      'mc-emoji-cat',
    )
  }
}

/** Called every time the tab becomes the visible one, built or cached. */
function hsOnEmojiTabShown() {
  hsRenderEmoji()
  document.getElementById('hs-mc-emoji-search')?.focus()
}
