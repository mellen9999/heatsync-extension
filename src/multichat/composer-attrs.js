// composer-attrs.js — what the composer carries that is not behaviour:
// spellcheck, and the ARIA that makes its autocomplete readable by a screen reader.
//
// SPELLCHECK
// Off unless the person turns it on (hs_spellcheck), as the composer always was.
// Both composer shapes (contenteditable div, plain input) take the same
// property, and the setting applier pushes it onto the live node, so a flip
// needs no reload and no rebuild.
//
// ARIA — the WAI-ARIA 1.2 editable combobox with a list popup.
// The composer IS the combobox: role=combobox, aria-autocomplete=list,
// aria-haspopup=listbox. Whichever list is open (":" emotes and emoji, "@"
// names, "/" commands) is its listbox: the list gets role=listbox, each row
// role=option with an id that depends only on its position, and the composer
// points at it with aria-expanded / aria-controls and at the highlighted row
// with aria-activedescendant. DOM focus never leaves the composer.
//
// Tab-complete swaps the word in place and draws no list, so there is no popup
// to expand. Its candidate is announced through the cycle tooltip, which is a
// polite live region ("3/12 KKona").

const HS_AC_LIST_LABELS = {
  'hs-mc-emoji-dropdown': 'mc_a11y_ac_emotes',
  'hs-mc-mention-dropdown': 'mc_a11y_ac_names',
  'hs-mc-slash-dropdown': 'mc_a11y_ac_commands',
}

function hsSpellcheckOn() {
  return getSetting('hs_spellcheck') === true
}

function hsApplySpellcheck(on) {
  const input = document.getElementById('hs-mc-input')
  if (input) input.spellcheck = !!on
}

/** The composer's combobox identity. Idempotent: initInput runs for every rebuilt composer. */
function hsComposerCombobox(input) {
  input.setAttribute('role', 'combobox')
  input.setAttribute('aria-label', t('mc_input_send_message'))
  input.setAttribute('aria-autocomplete', 'list')
  input.setAttribute('aria-haspopup', 'listbox')
  if (!input.hasAttribute('aria-expanded')) input.setAttribute('aria-expanded', 'false')
}

function hsComposerPopup(dd, row) {
  const input = document.getElementById('hs-mc-input')
  if (!input) return
  input.setAttribute('aria-expanded', 'true')
  input.setAttribute('aria-controls', dd.id)
  if (row) input.setAttribute('aria-activedescendant', row.id)
  else input.removeAttribute('aria-activedescendant')
}

/** Move the highlight to row `selected`: class, aria-selected, scroll into view, activedescendant. */
function hsListboxSelect(dd, selected) {
  const rows = dd.children
  for (let i = 0; i < rows.length; i++) {
    const on = i === selected
    rows[i].classList.toggle('selected', on)
    rows[i].setAttribute('aria-selected', on ? 'true' : 'false')
  }
  const row = rows[selected]
  // scroll the list itself, never an ancestor: scrollIntoView would also move the host page
  if (row && dd.clientHeight) {
    if (row.offsetTop < dd.scrollTop) dd.scrollTop = row.offsetTop
    else if (row.offsetTop + row.offsetHeight > dd.scrollTop + dd.clientHeight) {
      dd.scrollTop = row.offsetTop + row.offsetHeight - dd.clientHeight
    }
  }
  hsComposerPopup(dd, row)
}

/**
 * The list was just (re)built from `matches`. Rows are numbered by position, so a
 * rebuild hands the screen reader the same ids it already had.
 */
function hsListboxSync(dd, matches, selected) {
  dd._hsMatches = matches
  dd.setAttribute('role', 'listbox')
  dd.setAttribute('aria-label', t(HS_AC_LIST_LABELS[dd.id]))
  for (let i = 0; i < dd.children.length; i++) {
    dd.children[i].setAttribute('role', 'option')
    dd.children[i].id = `${dd.id}-opt-${i}`
  }
  hsListboxSelect(dd, selected)
}

/**
 * Arrow keys re-call showXDropdown with the SAME matches array and only a new
 * index. Move the highlight in place instead of rebuilding every row: the
 * option the composer's aria-activedescendant names stays the same element, and
 * 30 emote previews are not re-created per keypress.
 */
function hsListboxReuse(dd, matches, selected) {
  if (dd._hsMatches !== matches || dd.style.display === 'none' || dd.children.length !== matches.length) return false
  hsListboxSelect(dd, selected)
  return true
}

/** Hide the list and let go of it on the composer — only if the composer still points at THIS list. */
function hsListboxHide(dd) {
  dd.style.display = 'none'
  const input = document.getElementById('hs-mc-input')
  if (input?.getAttribute('aria-controls') !== dd.id) return
  input.setAttribute('aria-expanded', 'false')
  input.removeAttribute('aria-controls')
  input.removeAttribute('aria-activedescendant')
}

export {
  hsApplySpellcheck,
  hsComposerCombobox,
  hsListboxHide,
  hsListboxReuse,
  hsListboxSelect,
  hsListboxSync,
  hsSpellcheckOn,
}
