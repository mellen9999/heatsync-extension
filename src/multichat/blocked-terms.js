// blocked terms — a twitch channel's blocked-terms list, for its moderators.
// One pane panel (pane-panel.js), opened lazily from /blocked, the mod toolbar
// button and the right-click mod menu. The list lives on twitch; this talks to
// heatsync.org's /api/mod/blocked-terms through the background worker (content
// scripts must not fetch heatsync.org themselves — see resolve_twitch_id).
//
//   openBlockedTerms(login)   → true once the panel is up
//
// Keys (a window capture listener while open, so they win over the page's own):
//   j / k   move      d / x   delete the selected term (y / enter yes, n / esc no)
//   a       add       /       filter      enter in the add field adds      esc closes
//
// Every term is rendered with textContent — a term is attacker-shaped text.

const BT_MIN = 2
const BT_MAX = 500
const BT_RELINK_URL = 'https://heatsync.org/api/auth/login?scopes=blockedterms&return_to=%2Fhome%2Fhot'

// background error code → the view it implies; anything else is the generic failure
function btViewFor(error) {
  if (error === 'relink_required') return 'perm'
  if (error === 'not_moderator') return 'notmod'
  if (error === 'auth_required') return 'auth'
  return 'error'
}

// Terms in the order the panel shows them: newest first as the server sends,
// filtered by a case-insensitive substring. Pure, so the panel's states test.
function btVisible(terms, filter) {
  const q = String(filter || '')
    .trim()
    .toLowerCase()
  return q ? terms.filter((x) => String(x.text).toLowerCase().includes(q)) : terms
}

function btEl(tag, cls, text) {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = text
  return n
}

async function openBlockedTerms(login) {
  const channel = String(login || '')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
  if (!channel) return false
  const broadcasterId = await resolveAutomodBroadcasterId(channel)
  if (!broadcasterId) {
    showToast(t('mc_bt_err'), 'error')
    return false
  }

  const s = { terms: [], filter: '', sel: 0, confirm: null, view: 'loading', busy: false }
  const page = btEl('div', 'hs-bt')
  page.tabIndex = -1
  const head = btEl('div', 'hs-bt-head')
  const count = btEl('span', 'hs-bt-count')
  head.append(btEl('span', 'hs-bt-title', `${t('mc_bt_title')} · ${channel}`), count)
  const filter = btEl('input', 'hs-bt-input')
  filter.type = 'text'
  filter.autocomplete = 'off'
  filter.placeholder = t('mc_bt_filter_ph')
  filter.setAttribute('aria-label', t('mc_bt_filter_ph'))
  const add = btEl('input', 'hs-bt-input')
  add.type = 'text'
  add.autocomplete = 'off'
  add.maxLength = BT_MAX
  add.placeholder = t('mc_bt_add_ph')
  add.setAttribute('aria-label', t('mc_bt_add_ph'))
  const addBtn = btEl('button', 'hs-bt-btn', t('mc_bt_add'))
  addBtn.type = 'button'
  const inputs = btEl('div', 'hs-bt-inputs')
  inputs.append(filter, add, addBtn)
  const msg = btEl('div', 'hs-bt-msg')
  msg.setAttribute('role', 'status')
  const body = btEl('div', 'hs-bt-body')
  body.setAttribute('role', 'listbox')
  page.append(head, inputs, msg, body, btEl('div', 'hs-bt-hint', t('mc_bt_hint')))

  const say = (text, bad) => {
    msg.textContent = text || ''
    msg.classList.toggle('hs-bt-bad', !!bad)
  }
  const btn = (text, fn, cls = '') => {
    const b = btEl('button', `hs-bt-btn ${cls}`.trim(), text)
    b.type = 'button'
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      fn()
    })
    return b
  }
  const note = (text, ...actions) => {
    const d = btEl('div', 'hs-bt-note', text)
    if (actions.length) d.append(btEl('br'), ...actions)
    body.replaceChildren(d)
  }

  function render() {
    const rows = btVisible(s.terms, s.filter)
    s.sel = Math.max(0, Math.min(s.sel, rows.length - 1))
    const live = s.view === 'list'
    inputs.hidden = !live
    count.textContent = !live
      ? ''
      : s.filter.trim()
        ? t('mc_bt_count_of', [String(rows.length), String(s.terms.length)])
        : t('mc_bt_count', [String(s.terms.length)])
    if (s.view === 'loading') return note(t('mc_bt_loading'))
    if (s.view === 'notmod') return note(t('mc_bt_not_mod'))
    if (s.view === 'perm')
      return note(t('mc_bt_need_perm'), btn(t('mc_bt_allow'), allow, 'hs-bt-primary'), btn(t('mc_bt_retry'), load))
    if (s.view === 'auth') return note(t('mc_automod_signin'), btn(t('mc_bt_retry'), load))
    if (s.view === 'error') return note(t('mc_bt_err'), btn(t('mc_bt_retry'), load))
    if (!rows.length) return note(s.terms.length ? t('mc_bt_no_match') : t('mc_bt_empty'))
    body.replaceChildren(...rows.map(row))
    body.querySelector('.hs-bt-sel')?.scrollIntoView?.({ block: 'nearest' })
  }

  function row(term, i) {
    const r = btEl('div', `hs-bt-row${i === s.sel ? ' hs-bt-sel' : ''}`)
    r.setAttribute('role', 'option')
    r.dataset.id = term.id
    if (s.confirm === term.id) {
      r.classList.add('hs-bt-confirm')
      r.append(
        btEl('span', 'hs-bt-text', t('mc_bt_confirm', [String(term.text)])),
        btn(t('mc_bt_yes'), () => remove(term), 'hs-bt-danger'),
        btn(t('mc_bt_no'), () => {
          s.confirm = null
          render()
        }),
      )
    } else {
      const x = btn(
        'x',
        () => {
          s.sel = i
          s.confirm = term.id
          render()
        },
        'hs-bt-x',
      )
      x.setAttribute('aria-label', t('mc_bt_delete'))
      r.append(btEl('span', 'hs-bt-text', String(term.text)), x)
      r.addEventListener('click', () => {
        s.sel = i
        s.confirm = null
        render()
      })
    }
    return r
  }

  function allow() {
    try {
      window.open(BT_RELINK_URL, '_blank', 'noopener')
    } catch (_) {}
  }

  // a failed call → the view it implies; a rate limit or a bad term only speaks
  function fail(res) {
    const error = res?.error
    if (error === 'rate_limited' || error === 'gone') return say(t('mc_bt_err'), true)
    const view = btViewFor(error)
    if (view === 'error') return say(t('mc_bt_err'), true)
    s.view = view
    render()
  }

  async function load() {
    s.view = 'loading'
    render()
    const res = await safeSendMessage({ type: 'blocked_terms', op: 'list', broadcasterId })
    if (!res?.ok) {
      s.view = btViewFor(res?.error)
      return render()
    }
    s.terms = res.terms
    s.view = 'list'
    render()
    page.focus()
  }

  async function addTerm() {
    const text = add.value.trim()
    if (s.busy) return
    if (text.length < BT_MIN || text.length > BT_MAX) return say(t('mc_bt_short'), true)
    s.busy = true
    try {
      const res = await safeSendMessage({ type: 'blocked_terms', op: 'add', broadcasterId, text })
      if (!res?.ok || !res.term) return fail(res)
      s.terms = [res.term, ...s.terms.filter((x) => x.id !== res.term.id)]
      s.sel = 0
      add.value = ''
      say(t('mc_bt_added', [String(res.term.text)]))
      render()
    } finally {
      s.busy = false
    }
  }

  async function remove(term) {
    if (s.busy) return
    s.busy = true
    try {
      const res = await safeSendMessage({ type: 'blocked_terms', op: 'remove', broadcasterId, id: term.id })
      s.confirm = null
      // already gone is the state the mod wanted
      if (res?.ok || res?.error === 'gone') {
        s.terms = s.terms.filter((x) => x.id !== term.id)
        say(t('mc_bt_removed', [String(term.text)]))
        return render()
      }
      fail(res)
      if (s.view === 'list') render()
    } finally {
      s.busy = false
    }
  }

  const onKey = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    const stop = () => {
      e.preventDefault()
      e.stopPropagation()
    }
    if (e.target === filter || e.target === add) {
      if (e.key === 'Escape' && e.target.value) {
        // first esc clears the field, the next one closes the panel
        stop()
        e.target.value = ''
        if (e.target === filter) {
          s.filter = ''
          s.sel = 0
          render()
        }
      } else if (e.key === 'Enter') {
        stop()
        if (e.target === add) addTerm()
        else page.focus()
      }
      return
    }
    if (s.view !== 'list') return
    const rows = btVisible(s.terms, s.filter)
    const cur = rows[s.sel]
    if (s.confirm) {
      if (e.key === 'y' || e.key === 'Enter') {
        stop()
        if (cur) remove(cur)
      } else if (e.key === 'n' || e.key === 'Escape') {
        stop()
        s.confirm = null
        render()
      }
      return
    }
    if (e.key === 'j' || e.key === 'ArrowDown') {
      stop()
      s.sel = Math.min(s.sel + 1, rows.length - 1)
      render()
    } else if (e.key === 'k' || e.key === 'ArrowUp') {
      stop()
      s.sel = Math.max(s.sel - 1, 0)
      render()
    } else if ((e.key === 'd' || e.key === 'x' || e.key === 'Delete') && cur) {
      stop()
      s.confirm = cur.id
      render()
    } else if (e.key === 'a') {
      stop()
      add.focus()
    } else if (e.key === '/') {
      stop()
      filter.focus()
    }
  }

  filter.addEventListener('input', () => {
    s.filter = filter.value
    s.sel = 0
    s.confirm = null
    render()
  })
  addBtn.addEventListener('click', addTerm)
  // window capture runs before the panel's own document-level Escape, so esc can
  // back out of a delete confirm or clear a field before it closes anything
  window.addEventListener('keydown', onKey, true)
  const panel = hsPanePanelOpenWith({
    label: t('mc_bt_title'),
    body: page,
    buttons: [],
    onDone: () => window.removeEventListener('keydown', onKey, true),
  })
  if (!panel) {
    window.removeEventListener('keydown', onKey, true)
    return false
  }
  load()
  return true
}
