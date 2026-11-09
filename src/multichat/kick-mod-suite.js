// kick mod suite panel — a kick channel's blocked words, message filter and
// chatters, for its moderators. Same pane panel + look as the twitch mod suite
// (mod-suite.js); calls live in kick-mod-calls.js. Opened from /kickmod and the
// right-click mod menu on a kick row.
//
//   openKickModSuite(slug, cell)   → true once the panel is up
//   cell: words | filter | chatters
//
// Keys (a window capture listener while open, so they win over the page's own):
//   h / l (or 1-3)  switch cell     j / k  move     ?  show the keys     esc  back / close
//   words     / type a new word (enter adds)   d remove the picked word
//   filter    j / k pick a row, 0-3 sets its level (spam and gibberish: 0 or 1)
//   chatters  / filter    enter opens the user card
//
// Every word and name is rendered with textContent.

const KMS_CELLS = ['words', 'filter', 'chatters']
const KMS_ROLE_KEY = { moderator: 'mod', vip: 'vip', og: 'og', bot: 'bot' }
const KMS_CELL_KEY = { words: 'mc_kms_cell_words', filter: 'mc_kms_cell_filter', chatters: 'mc_ms_cell_chatters' }
const KMS_KEYS_KEY = { words: 'mc_kms_keys_words', filter: 'mc_kms_keys_filter', chatters: 'mc_ms_keys_chatters' }

async function openKickModSuite(slug, cell = 'words') {
  const channel = String(slug || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
  if (!channel) return false

  const s = { cell: KMS_CELLS.includes(cell) ? cell : 'words', v: {}, sel: 0, filter: '', keys: false, busy: false }

  const page = msEl('div', 'hs-ms')
  page.tabIndex = -1
  const head = msEl('div', 'hs-ms-head')
  const count = msEl('span', 'hs-ms-count')
  head.append(msEl('span', 'hs-ms-title', `${t('mc_kms_title')} · ${channel}`), count)
  const cells = msEl('div', 'hs-ms-cells')
  cells.setAttribute('role', 'tablist')
  const add = msEl('input', 'hs-ms-input')
  add.type = 'text'
  add.autocomplete = 'off'
  add.placeholder = t('mc_kms_word_ph')
  add.setAttribute('aria-label', t('mc_kms_word_ph'))
  const filter = msEl('input', 'hs-ms-input')
  filter.type = 'text'
  filter.autocomplete = 'off'
  filter.placeholder = t('mc_ms_filter_ph')
  filter.setAttribute('aria-label', t('mc_ms_filter_ph'))
  const msg = msEl('div', 'hs-ms-msg')
  msg.setAttribute('role', 'status')
  const body = msEl('div', 'hs-ms-body')
  const hint = msEl('div', 'hs-ms-hint')
  page.append(head, cells, add, filter, msg, body, hint)

  const say = (text, bad) => {
    msg.textContent = text || ''
    msg.classList.toggle('hs-ms-bad', !!bad)
  }
  const cur = () => s.v[s.cell]
  const btn = (text, fn, cls = '') => {
    const b = msEl('button', `hs-ms-btn ${cls}`.trim(), text)
    b.type = 'button'
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      fn()
    })
    return b
  }
  const note = (text, ...actions) => {
    const d = msEl('div', 'hs-ms-note', text)
    if (actions.length) d.append(msEl('br'), ...actions)
    body.replaceChildren(d)
  }

  // ── data ──────────────────────────────────────────────────────────────────
  // A failed call → the view it implies, or just kick's words under the list.
  function route(res, c = s.cell) {
    if (res.view === 'auth' || res.view === 'notmod') {
      s.v[c] = { status: res.view }
      render()
      return true
    }
    say(res.message, true)
    return false
  }

  const LOADERS = {
    words: async () => {
      const r = await kmCall(channel, 'words_get')
      const list = r.ok ? kmWords(r.data) : null
      return r.ok ? (list ? { data: { list } } : { res: kmFail({}) }) : { res: r }
    },
    filter: async () => {
      const r = await kmCall(channel, 'rules_get')
      const rules = r.ok ? kmRules(r.data) : null
      return r.ok ? (rules ? { data: { rules } } : { res: kmFail({}) }) : { res: r }
    },
    chatters: async () => {
      const r = await kmCall(channel, 'chatters')
      const out = r.ok ? kmChatters(r.data) : null
      return r.ok ? (out ? { data: out } : { res: kmFail({}) }) : { res: r }
    },
  }

  const load = msCellLoader({ s, LOADERS, render, route, cur, page, getFilter: () => filter })

  function go(c) {
    if (!KMS_CELLS.includes(c)) return
    s.cell = c
    s.sel = 0
    say('')
    if (!cur() || cur().status === 'error') load(c)
    else render()
  }

  // ── actions ───────────────────────────────────────────────────────────────
  // Add or remove one word. The list is only changed after kick says yes.
  async function editWord(word, adding) {
    const v = s.v.words
    const clean = word.trim()
    if (s.busy || v?.status !== 'ok' || !clean) return
    const have = v.list.find((w) => w.word.toLowerCase() === clean.toLowerCase())
    if (adding && have) {
      say(t('mc_kms_word_exists', [clean]), true)
      return
    }
    if (!adding && !have) return
    s.busy = true
    try {
      const entry = adding ? { word: clean, permission: 'PUBLIC' } : have
      const r = await kmCall(channel, 'words_edit', adding ? { add: [entry] } : { remove: [entry] })
      if (r.ok) {
        v.list = adding
          ? [...v.list, entry].sort((a, b) => a.word.localeCompare(b.word))
          : v.list.filter((w) => w !== have)
        if (adding) add.value = ''
        say(t(adding ? 'mc_kms_word_added' : 'mc_kms_word_removed', [clean]))
      } else route(r, 'words')
    } finally {
      s.busy = false
      render()
    }
  }

  // Optimistic: show the new level now, send all eight, put the old ones back on failure.
  async function setLevel(key, level) {
    const v = cur()
    if (s.busy || v?.status !== 'ok' || v.rules[key] === level || level > kmRuleMax(key)) return
    s.busy = true
    const before = v.rules
    v.rules = { ...before, [key]: level }
    render()
    try {
      const r = await kmCall(channel, 'rules_set', { rules: v.rules })
      if (r.ok) say(t('mc_kms_filter_saved'))
      else {
        v.rules = before
        route(r)
      }
    } finally {
      s.busy = false
      render()
    }
  }

  function openCard(who) {
    window.removeEventListener('keydown', onKey, true)
    hsPanePanelAbort()
    if (typeof openProfileCard === 'function') openProfileCard(who, 'kick')
  }

  // ── views ─────────────────────────────────────────────────────────────────
  const rowsOf = () => {
    const v = cur()
    if (v?.status !== 'ok') return []
    if (s.cell === 'words') return v.list
    if (s.cell === 'chatters') return kmChattersVisible(v.list, s.filter)
    if (s.cell === 'filter') return KM_RULE_KEYS
    return []
  }

  function viewWords(v) {
    if (!v.list.length) return note(t('mc_kms_words_empty'))
    body.replaceChildren(
      ...v.list.map((w, i) => {
        const r = msEl('div', `hs-ms-row${i === s.sel ? ' hs-ms-sel' : ''}`)
        r.append(
          msEl('span', 'hs-ms-text', w.word),
          btn(t('mc_kms_word_remove'), () => {
            s.sel = i
            editWord(w.word, false)
          }),
        )
        r.addEventListener('click', () => {
          s.sel = i
          render()
        })
        return r
      }),
    )
  }

  function viewFilter(v) {
    const rows = KM_RULE_KEYS.map((key, i) => {
      const r = msEl('div', `hs-ms-row${i === s.sel ? ' hs-ms-sel' : ''}`)
      r.dataset.key = key
      const levels = msEl('div', 'hs-ms-levels')
      for (let n = 0; n <= kmRuleMax(key); n++) {
        levels.append(
          btn(
            String(n),
            () => {
              s.sel = i
              setLevel(key, n)
            },
            `hs-ms-lvl${v.rules[key] === n ? ' hs-ms-on' : ''}`,
          ),
        )
      }
      const label = key === 'bullying' ? t('mc_ms_cat_bullying') : t(`mc_kms_cat_${key}`)
      r.append(msEl('span', 'hs-ms-text', label), levels)
      r.addEventListener('click', () => {
        s.sel = i
        render()
      })
      return r
    })
    body.replaceChildren(...rows, msEl('div', 'hs-ms-note', t('mc_kms_filter_scale')))
  }

  function viewChatters(rows) {
    if (!rows.length) return note(t(cur().list.length ? 'mc_ms_no_match' : 'mc_ms_ch_empty'))
    body.replaceChildren(
      ...rows.map((c, i) => {
        const r = msEl('div', `hs-ms-row${i === s.sel ? ' hs-ms-sel' : ''}`)
        r.append(msEl('span', 'hs-ms-text', c.name))
        if (c.name.toLowerCase() !== c.login) r.append(msEl('span', 'hs-ms-sub', c.login))
        if (c.role) r.append(msEl('span', 'hs-ms-sub', t(`mc_kms_role_${KMS_ROLE_KEY[c.role]}`)))
        r.addEventListener('click', () => {
          s.sel = i
          openCard(c.login)
        })
        return r
      }),
    )
  }

  function render() {
    const v = cur()
    const ok = v?.status === 'ok'
    cells.replaceChildren(
      ...KMS_CELLS.map((c) => {
        const b = btn(t(KMS_CELL_KEY[c]), () => go(c), `hs-ms-cell${c === s.cell ? ' hs-ms-on' : ''}`)
        b.setAttribute('role', 'tab')
        b.setAttribute('aria-selected', String(c === s.cell))
        return b
      }),
    )
    add.hidden = !(s.cell === 'words' && ok)
    filter.hidden = !(s.cell === 'chatters' && ok)
    const rows = rowsOf()
    s.sel = Math.max(0, Math.min(s.sel, rows.length - 1))
    count.textContent =
      ok && s.cell === 'chatters'
        ? s.filter.trim()
          ? t('mc_ms_ch_count_of', [String(rows.length), String(v.list.length)])
          : v.total > v.list.length
            ? t('mc_ms_ch_count_part', [String(v.list.length), String(v.total)])
            : t('mc_ms_ch_count', [String(v.total)])
        : ''
    hint.textContent = t('mc_ms_hint') + (s.keys ? `\n${t(KMS_KEYS_KEY[s.cell])}` : '')
    if (!v || v.status === 'loading') return note(t('mc_ms_loading'))
    if (v.status === 'notmod') return note(t('mc_ms_not_mod'))
    if (v.status === 'auth')
      return note(
        t('mc_kms_signin'),
        btn(t('mc_ms_retry'), () => load()),
      )
    if (v.status === 'error')
      return note(
        t('mc_kms_err'),
        btn(t('mc_ms_retry'), () => load()),
      )
    if (s.cell === 'words') viewWords(v)
    else if (s.cell === 'filter') viewFilter(v)
    else viewChatters(rows)
    body.querySelector('.hs-ms-sel')?.scrollIntoView?.({ block: 'nearest' })
  }

  // ── keys ──────────────────────────────────────────────────────────────────
  function onKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    const stop = () => {
      e.preventDefault()
      e.stopPropagation()
    }
    if (e.target === add || e.target === filter) {
      if (e.key === 'Enter') {
        stop()
        if (e.target === add) editWord(add.value, true)
        else page.focus()
      } else if (e.key === 'Escape' && e.target.value) {
        // first esc clears the field, the next one closes the panel
        stop()
        e.target.value = ''
        if (e.target === filter) {
          s.filter = ''
          s.sel = 0
          render()
        }
      }
      return
    }
    const rows = rowsOf()
    const v = cur()
    const k = e.key
    if (k === '?') {
      stop()
      s.keys = !s.keys
      render()
      return
    }
    if (k === 'h' || k === 'ArrowLeft') {
      stop()
      go(KMS_CELLS[(KMS_CELLS.indexOf(s.cell) + KMS_CELLS.length - 1) % KMS_CELLS.length])
      return
    }
    if (k === 'l' || k === 'ArrowRight') {
      stop()
      go(KMS_CELLS[(KMS_CELLS.indexOf(s.cell) + 1) % KMS_CELLS.length])
      return
    }
    if (k >= '1' && k <= '3' && s.cell !== 'filter') {
      stop()
      go(KMS_CELLS[Number(k) - 1])
      return
    }
    if (v?.status !== 'ok') return
    if (k === 'j' || k === 'ArrowDown') {
      stop()
      s.sel = Math.min(s.sel + 1, rows.length - 1)
      render()
    } else if (k === 'k' || k === 'ArrowUp') {
      stop()
      s.sel = Math.max(s.sel - 1, 0)
      render()
    } else if (s.cell === 'words') {
      if (k === '/') {
        stop()
        add.focus()
      } else if (k === 'd' && rows[s.sel]) {
        stop()
        editWord(rows[s.sel].word, false)
      }
    } else if (s.cell === 'filter') {
      if (k >= '0' && k <= '3' && rows[s.sel]) {
        stop()
        setLevel(rows[s.sel], Number(k))
      }
    } else if (s.cell === 'chatters') {
      if (k === '/') {
        stop()
        filter.focus()
      } else if (k === 'Enter' && rows[s.sel]) {
        stop()
        openCard(rows[s.sel].login)
      }
    }
  }

  filter.addEventListener('input', () => {
    s.filter = filter.value
    s.sel = 0
    render()
  })
  // window capture runs before the panel's own document-level Escape, so esc can
  // clear a field before it closes anything
  window.addEventListener('keydown', onKey, true)
  const panel = hsPanePanelOpenWith({
    label: t('mc_kms_title'),
    body: page,
    buttons: [],
    onDone: () => window.removeEventListener('keydown', onKey, true),
  })
  if (!panel) {
    window.removeEventListener('keydown', onKey, true)
    return false
  }
  go(s.cell)
  return true
}

// /kickmod — kick answers 403 to a non-mod inside the panel, so this only keeps
// it off a channel the user plainly doesn't mod. Resolves like a slash handler.
async function kickModCommand(slug, input) {
  const fail = (key) => {
    showToast(t(key), 'error')
    return { ok: false, error: t(key) }
  }
  if (!slug) return fail('mc_kms_no_channel')
  if (!(await isKickModFor(slug))) return fail('mc_ms_not_mod')
  if (!(await openKickModSuite(slug, 'words'))) return fail('mc_kms_err')
  clearInput(input)
  return true
}

// the row menu's "mod tools" item: kick's panel on a kick row, twitch's otherwise
function modToolsItem(isKick, channel) {
  return {
    label: t('content_card_mod_tools'),
    fn: () => (isKick ? openKickModSuite(channel) : openModSuite(channel, 'shield')),
  }
}
