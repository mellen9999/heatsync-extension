// mod suite panel — a twitch channel's shield mode, unban requests, automod
// settings and chatters, for its moderators. One pane panel (pane-panel.js),
// opened lazily from /modtools, /shield, /unbanrequests, the right-click mod
// menu and the opt-in toolbar button. Calls live in mod-suite-calls.js.
//
//   openModSuite(login, cell)   → true once the panel is up
//   cell: shield | unban | automod | chatters
//
// Keys (a window capture listener while open, so they win over the page's own):
//   h / l (or 1-4)  switch cell     j / k  move     ?  show the keys     esc  back / close
//   shield    s toggle (turning it ON asks first: y / enter yes, n / esc no)
//   unban     a approve   d deny (a reason is optional; enter sends)   f next status
//   automod   j / k pick a row, 0-4 sets its level   a advanced fold
//   chatters  / filter    enter opens the user card
//
// Every name, request text and reason is rendered with textContent.

const MS_CELLS = ['shield', 'unban', 'automod', 'chatters']
const MS_STATUSES = ['pending', 'approved', 'denied']
const MS_CATS = [
  'disability',
  'aggression',
  'sexuality_sex_or_gender',
  'misogyny',
  'bullying',
  'swearing',
  'race_ethnicity_or_religion',
  'sex_based_terms',
]
const MS_LEVELS = [0, 1, 2, 3, 4]

function msEl(tag, cls, text) {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = text
  return n
}

// Chatters in the order the panel shows them: as the server sends, filtered by a
// case-insensitive substring of login or display name. Pure, so it tests.
function msChattersVisible(list, filter) {
  const q = String(filter || '')
    .trim()
    .toLowerCase()
  return q ? list.filter((c) => `${c.user_login} ${c.user_name}`.toLowerCase().includes(q)) : list
}

async function openModSuite(login, cell = 'shield') {
  const channel = String(login || '')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
  if (!channel) return false

  const s = {
    cell: MS_CELLS.includes(cell) ? cell : 'shield',
    v: {}, // per-cell data + status
    sel: 0,
    status: 'pending',
    confirm: null,
    reason: '',
    adv: false,
    filter: '',
    keys: false,
    busy: false,
  }

  const page = msEl('div', 'hs-ms')
  page.tabIndex = -1
  const head = msEl('div', 'hs-ms-head')
  const count = msEl('span', 'hs-ms-count')
  head.append(msEl('span', 'hs-ms-title', `${t('mc_ms_title')} · ${channel}`), count)
  const cells = msEl('div', 'hs-ms-cells')
  cells.setAttribute('role', 'tablist')
  const filter = msEl('input', 'hs-ms-input')
  filter.type = 'text'
  filter.autocomplete = 'off'
  filter.placeholder = t('mc_ms_filter_ph')
  filter.setAttribute('aria-label', t('mc_ms_filter_ph'))
  const msg = msEl('div', 'hs-ms-msg')
  msg.setAttribute('role', 'status')
  const body = msEl('div', 'hs-ms-body')
  const hint = msEl('div', 'hs-ms-hint')
  page.append(head, cells, filter, msg, body, hint)

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
  // A failed call → the view it implies, or just the server's words under the list.
  function route(res, c = s.cell) {
    const view = msViewFor(res)
    if (view) {
      s.v[c] = { status: view }
      render()
      return true
    }
    say(msWords(res), true)
    return false
  }

  const LOADERS = {
    shield: async () => {
      const r = await msCall(channel, 'shield_get')
      return r.ok ? { data: { active: !!r.data.is_active, since: r.data.last_activated_at || null } } : { res: r }
    },
    unban: async () => {
      const r = await msCall(channel, 'unban_list', { status: s.status })
      if (!r.ok) return { res: r }
      const list = [...(r.data.requests || [])].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      return { data: { list } }
    },
    automod: async () => {
      const r = await msCall(channel, 'automod_get')
      return r.ok ? { data: { settings: r.data } } : { res: r }
    },
    chatters: async () => {
      const r = await msCall(channel, 'chatters')
      if (!r.ok) return { res: r }
      const list = r.data.chatters || []
      return { data: { list, total: r.data.total ?? list.length } }
    },
  }

  async function load(c = s.cell) {
    s.v[c] = { status: 'loading' }
    render()
    const out = await LOADERS[c]()
    if (out.data) s.v[c] = { status: 'ok', ...out.data }
    else if (!route(out.res, c)) s.v[c] = { status: 'error' }
    if (c === s.cell) {
      s.sel = 0
      render()
      if (c === 'chatters' && cur()?.status === 'ok') filter.focus()
      else page.focus()
    }
  }

  function go(c) {
    if (!MS_CELLS.includes(c)) return
    s.cell = c
    s.sel = 0
    s.confirm = null
    say('')
    if (!cur() || cur().status === 'error') load(c)
    else render()
  }

  // ── actions ───────────────────────────────────────────────────────────────
  async function toggleShield(on) {
    if (s.busy) return
    s.busy = true
    try {
      const r = await msCall(channel, 'shield_set', { active: on })
      s.confirm = null
      if (r.ok) {
        const active = r.data.is_active != null ? !!r.data.is_active : on
        s.v.shield = { status: 'ok', active, since: active ? new Date().toISOString() : cur()?.since || null }
        say(t(active ? 'mc_ms_shield_now_on' : 'mc_ms_shield_now_off'))
      } else route(r, 'shield')
    } finally {
      s.busy = false
      render()
    }
  }

  async function resolve(req, status) {
    if (s.busy) return
    s.busy = true
    try {
      const text = s.reason.trim()
      const r = await msCall(channel, 'unban_resolve', { id: req.id, status, ...(text ? { text } : {}) })
      s.confirm = null
      if (r.ok) {
        const v = cur()
        v.list = v.list.filter((x) => x.id !== req.id)
        s.reason = ''
        say(t(status === 'approved' ? 'mc_ms_ub_approved' : 'mc_ms_ub_denied', [req.user_name || req.user_login]))
      } else route(r, 'unban')
    } finally {
      s.busy = false
      render()
    }
  }

  // Optimistic: show the new level now, post, put the old one back (and say why) on failure.
  async function setLevel(key, level) {
    const v = cur()
    if (s.busy || v?.status !== 'ok' || v.settings[key] === level) return
    s.busy = true
    const before = { ...v.settings }
    v.settings = { ...v.settings, [key]: level }
    render()
    try {
      const r = await msCall(channel, 'automod_set', { key, level })
      if (r.ok) {
        // changing overall moves every category with it — the server's to say
        if (r.data.settings && typeof r.data.settings === 'object') v.settings = r.data.settings
        say(t('mc_ms_am_saved'))
      } else {
        v.settings = before
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
    if (typeof openProfileCard === 'function') openProfileCard(who, 'twitch')
  }

  // ── views ─────────────────────────────────────────────────────────────────
  const rowsOf = () => {
    const v = cur()
    if (v?.status !== 'ok') return []
    if (s.cell === 'unban') return v.list
    if (s.cell === 'chatters') return msChattersVisible(v.list, s.filter)
    if (s.cell === 'automod') return ['overall_level', ...(s.adv ? MS_CATS : [])]
    return []
  }

  function shieldKey() {
    const v = cur()
    if (v?.status !== 'ok' || s.busy) return
    if (v.active) toggleShield(false)
    else {
      s.confirm = 'shield'
      render()
    }
  }

  function viewShield(v) {
    const state = msEl('div', `hs-ms-state ${v.active ? 'hs-ms-live' : 'hs-ms-calm'}`)
    state.append(msEl('span', 'hs-ms-text', t(v.active ? 'mc_ms_shield_on' : 'mc_ms_shield_off')))
    if (v.since) state.append(msEl('span', 'hs-ms-sub', t('mc_ms_shield_since', [new Date(v.since).toLocaleString()])))
    if (s.confirm === 'shield') {
      state.append(
        msEl('span', 'hs-ms-text', t('mc_ms_shield_confirm')),
        btn(t('mc_ms_yes'), () => toggleShield(true), 'hs-ms-danger'),
        btn(t('mc_ms_no'), () => {
          s.confirm = null
          render()
        }),
      )
    } else {
      state.append(btn(t(v.active ? 'mc_ms_shield_turn_off' : 'mc_ms_shield_turn_on'), shieldKey, 'hs-ms-primary'))
    }
    body.replaceChildren(state)
  }

  function ask(i, status) {
    const req = rowsOf()[i]
    if (!req || req.status !== 'pending' || s.busy) return
    s.sel = i
    s.confirm = { id: req.id, status }
    s.reason = ''
    render()
  }

  function setStatus(st) {
    s.status = st
    s.confirm = null
    delete s.v.unban
    load('unban')
  }

  function viewUnban(v) {
    const subs = msEl('div', 'hs-ms-subs')
    for (const st of MS_STATUSES) {
      subs.append(btn(t(`mc_ms_st_${st}`), () => setStatus(st), `hs-ms-cell${st === s.status ? ' hs-ms-on' : ''}`))
    }
    const rows = v.list.map((req, i) => {
      const r = msEl('div', `hs-ms-row${i === s.sel ? ' hs-ms-sel' : ''}`)
      const who = req.user_name || req.user_login
      r.append(msEl('span', 'hs-ms-text', `${who}: ${req.text || ''}`))
      if (req.resolution_text) r.append(msEl('span', 'hs-ms-sub', req.resolution_text))
      if (s.confirm?.id === req.id) {
        r.classList.add('hs-ms-confirm')
        const verb = s.confirm.status
        const reason = msEl('input', 'hs-ms-input hs-ms-reasonbox')
        reason.type = 'text'
        reason.maxLength = 500
        reason.autocomplete = 'off'
        reason.value = s.reason
        reason.placeholder = t('mc_ms_ub_reason_ph')
        reason.setAttribute('aria-label', t('mc_ms_ub_reason_ph'))
        reason.addEventListener('input', () => {
          s.reason = reason.value
        })
        r.append(
          msEl(
            'span',
            'hs-ms-text',
            t(verb === 'approved' ? 'mc_ms_ub_confirm_approve' : 'mc_ms_ub_confirm_deny', [who]),
          ),
          reason,
          btn(t('mc_ms_yes'), () => resolve(req, verb), 'hs-ms-danger'),
          btn(t('mc_ms_no'), () => {
            s.confirm = null
            render()
          }),
        )
        queueMicrotask(() => reason.focus())
      } else {
        r.addEventListener('click', () => {
          s.sel = i
          render()
        })
        if (req.status === 'pending') {
          r.append(
            btn(t('mc_ms_ub_approve'), () => ask(i, 'approved')),
            btn(t('mc_ms_ub_deny'), () => ask(i, 'denied')),
          )
        }
      }
      return r
    })
    body.replaceChildren(
      subs,
      ...(rows.length ? rows : [msEl('div', 'hs-ms-note', t('mc_ms_ub_empty', [t(`mc_ms_st_${s.status}`)]))]),
    )
  }

  function viewAutomod(v) {
    const row = (key, label, i) => {
      const r = msEl('div', `hs-ms-row${i === s.sel ? ' hs-ms-sel' : ''}`)
      r.dataset.key = key
      const levels = msEl('div', 'hs-ms-levels')
      for (const n of MS_LEVELS) {
        levels.append(
          btn(
            String(n),
            () => {
              s.sel = i
              setLevel(key, n)
            },
            `hs-ms-lvl${v.settings[key] === n ? ' hs-ms-on' : ''}`,
          ),
        )
      }
      r.append(msEl('span', 'hs-ms-text', label), levels)
      r.addEventListener('click', () => {
        s.sel = i
        render()
      })
      return r
    }
    const nodes = [row('overall_level', t('mc_ms_am_overall'), 0), msEl('div', 'hs-ms-note', t('mc_ms_am_scale'))]
    nodes.push(
      btn(
        `${s.adv ? '−' : '+'} ${t('mc_ms_am_advanced')}`,
        () => {
          s.adv = !s.adv
          render()
        },
        'hs-ms-fold',
      ),
    )
    if (s.adv) MS_CATS.forEach((c, i) => nodes.push(row(c, t(`mc_ms_cat_${c}`), i + 1)))
    body.replaceChildren(...nodes)
  }

  function viewChatters(rows) {
    if (!rows.length) return note(t(cur().list.length ? 'mc_ms_no_match' : 'mc_ms_ch_empty'))
    body.replaceChildren(
      ...rows.map((c, i) => {
        const r = msEl('div', `hs-ms-row${i === s.sel ? ' hs-ms-sel' : ''}`)
        r.append(msEl('span', 'hs-ms-text', c.user_name || c.user_login))
        if (c.user_name && c.user_name.toLowerCase() !== c.user_login) r.append(msEl('span', 'hs-ms-sub', c.user_login))
        r.addEventListener('click', () => {
          s.sel = i
          openCard(c.user_login)
        })
        return r
      }),
    )
  }

  function render() {
    const v = cur()
    const ok = v?.status === 'ok'
    cells.replaceChildren(
      ...MS_CELLS.map((c) => {
        const b = btn(t(`mc_ms_cell_${c}`), () => go(c), `hs-ms-cell${c === s.cell ? ' hs-ms-on' : ''}`)
        b.setAttribute('role', 'tab')
        b.setAttribute('aria-selected', String(c === s.cell))
        return b
      }),
    )
    filter.hidden = !(s.cell === 'chatters' && ok)
    const rows = rowsOf()
    s.sel = Math.max(0, Math.min(s.sel, rows.length - 1))
    count.textContent = !ok
      ? ''
      : s.cell === 'unban'
        ? t('mc_ms_ub_count', [String(rows.length)])
        : s.cell === 'chatters'
          ? s.filter.trim()
            ? t('mc_ms_ch_count_of', [String(rows.length), String(v.list.length)])
            : v.total > v.list.length
              ? t('mc_ms_ch_count_part', [String(v.list.length), String(v.total)])
              : t('mc_ms_ch_count', [String(v.total)])
          : ''
    hint.textContent = t('mc_ms_hint') + (s.keys ? `\n${t(`mc_ms_keys_${s.cell}`)}` : '')
    if (!v || v.status === 'loading') return note(t('mc_ms_loading'))
    if (v.status === 'notmod') return note(t('mc_ms_not_mod'))
    if (v.status === 'auth')
      return note(
        t('mc_automod_signin'),
        btn(t('mc_ms_retry'), () => load()),
      )
    if (v.status === 'perm')
      return note(
        t('mc_ms_need_perm'),
        btn(t('mc_ms_allow'), msAllow, 'hs-ms-primary'),
        btn(t('mc_ms_retry'), () => load()),
      )
    if (v.status === 'error')
      return note(
        t('mc_ms_err'),
        btn(t('mc_ms_retry'), () => load()),
      )
    if (s.cell === 'shield') viewShield(v)
    else if (s.cell === 'unban') viewUnban(v)
    else if (s.cell === 'automod') viewAutomod(v)
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
    if (e.target === filter || e.target.classList?.contains('hs-ms-reasonbox')) {
      if (e.target === filter) {
        if (e.key === 'Enter') {
          stop()
          page.focus()
        } else if (e.key === 'Escape' && filter.value) {
          // first esc clears the field, the next one closes the panel
          stop()
          filter.value = ''
          s.filter = ''
          s.sel = 0
          render()
        }
      } else if (e.key === 'Enter') {
        stop()
        const req = rowsOf().find((x) => x.id === s.confirm?.id)
        if (req) resolve(req, s.confirm.status)
      } else if (e.key === 'Escape') {
        stop()
        s.confirm = null
        render()
        page.focus()
      }
      return
    }
    const rows = rowsOf()
    const v = cur()
    const k = e.key
    if (s.confirm) {
      if (k === 'y' || k === 'Enter') {
        stop()
        if (s.confirm === 'shield') toggleShield(true)
        else {
          const req = rows.find((x) => x.id === s.confirm.id)
          if (req) resolve(req, s.confirm.status)
        }
      } else if (k === 'n' || k === 'Escape') {
        stop()
        s.confirm = null
        render()
      }
      return
    }
    if (k === '?') {
      stop()
      s.keys = !s.keys
      render()
      return
    }
    if (k === 'h' || k === 'ArrowLeft') {
      stop()
      go(MS_CELLS[(MS_CELLS.indexOf(s.cell) + MS_CELLS.length - 1) % MS_CELLS.length])
      return
    }
    if (k === 'l' || k === 'ArrowRight') {
      stop()
      go(MS_CELLS[(MS_CELLS.indexOf(s.cell) + 1) % MS_CELLS.length])
      return
    }
    if (k >= '1' && k <= '4' && s.cell !== 'automod') {
      stop()
      go(MS_CELLS[Number(k) - 1])
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
    } else if (s.cell === 'shield' && k === 's') {
      stop()
      shieldKey()
    } else if (s.cell === 'unban') {
      if (k === 'a') {
        stop()
        ask(s.sel, 'approved')
      } else if (k === 'd') {
        stop()
        ask(s.sel, 'denied')
      } else if (k === 'f') {
        stop()
        setStatus(MS_STATUSES[(MS_STATUSES.indexOf(s.status) + 1) % MS_STATUSES.length])
      }
    } else if (s.cell === 'automod') {
      if (k >= '0' && k <= '4' && rows[s.sel]) {
        stop()
        setLevel(rows[s.sel], Number(k))
      } else if (k === 'a') {
        stop()
        s.adv = !s.adv
        render()
      }
    } else if (s.cell === 'chatters') {
      if (k === '/') {
        stop()
        filter.focus()
      } else if (k === 'Enter' && rows[s.sel]) {
        stop()
        openCard(rows[s.sel].user_login)
      }
    }
  }

  filter.addEventListener('input', () => {
    s.filter = filter.value
    s.sel = 0
    render()
  })
  // window capture runs before the panel's own document-level Escape, so esc can
  // back out of a confirm or clear a field before it closes anything
  window.addEventListener('keydown', onKey, true)
  const panel = hsPanePanelOpenWith({
    label: t('mc_ms_title'),
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
