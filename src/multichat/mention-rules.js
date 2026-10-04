// mention rules (server) — the settings editor for heatsync.org's server-side
// mention rules (server/routes/mention-rules.ts). The server evaluates them
// against the whole firehose and pushes a hit to the ext (notifs.js
// 'server-mention-rule'); until now only the site could create or edit one.
//
//   mrDraftToBody(draft)   form → request body, mirroring the route's zod bounds
//   mrRuleRowHtml / mrHitsHtml / mrFormHtml / mrGroupHtml   settings-ui markup
//   mrHandleAction(el)     the data-mr-action click dispatcher (settings-ui)
//
// Every call goes through apiFetch → the background api_fetch proxy. Signed
// out: one sign-in line, no form. The bounds below must match the route.

const MR_PATTERN_MAX = 200
const MR_COOLDOWN_MIN = 5
const MR_COOLDOWN_MAX = 3600
const MR_CHANNEL_MAX = 60
const MR_CHANNELS_MAX = 50
const MR_TYPES = ['word', 'phrase', 'regex']
const MR_PLATFORMS = ['twitch', 'kick', 'youtube']
const MR_PLAT_TAG = { twitch: 'T', kick: 'K', youtube: 'Y' }
const MR_NOTIFY_VIA = ['web', 'push']
const MR_RETRY_MS = 15000

const mrState = {
  rules: [],
  hits: [],
  limit: 0,
  loaded: false,
  loading: false,
  editId: null,
  draft: null,
  testMsg: '',
  testResult: null, // true | false | null
  error: '',
  failedAt: 0,
  unauthed: false,
}

function mrBlankDraft() {
  return {
    rule_type: 'word',
    pattern: '',
    channels: '',
    platforms: [],
    case_sensitive: false,
    notify_via: ['web'],
    cooldown_seconds: '',
  }
}

function mrRuleToDraft(r) {
  return {
    rule_type: MR_TYPES.includes(r.rule_type) ? r.rule_type : 'word',
    pattern: String(r.pattern || ''),
    channels: Array.isArray(r.channels) ? r.channels.join(', ') : '',
    platforms: Array.isArray(r.platforms) ? r.platforms.filter((p) => MR_PLATFORMS.includes(p)) : [],
    case_sensitive: !!r.case_sensitive,
    notify_via: Array.isArray(r.notify_via) && r.notify_via.length ? r.notify_via : ['web'],
    cooldown_seconds: r.cooldown_seconds ? String(r.cooldown_seconds) : '',
  }
}

// "#Chan, other" → ['chan','other'] (lowercased, # stripped, de-duplicated)
function mrParseChannels(text) {
  const out = []
  for (const part of String(text || '').split(',')) {
    const c = part.trim().toLowerCase().replace(/^#/, '')
    if (c && !out.includes(c)) out.push(c)
  }
  return out
}

// Form → body. Returns { ok:true, body } or { ok:false, error:<i18n key> }.
// channels/platforms are always sent (null = every channel / platform) so an
// edit can clear them, since PUT is a partial update.
function mrDraftToBody(d) {
  const pattern = String(d.pattern || '').trim()
  if (!pattern || pattern.length > MR_PATTERN_MAX) return { ok: false, error: 'mc_mr_err_pattern' }
  if (!MR_TYPES.includes(d.rule_type)) return { ok: false, error: 'mc_mr_err_pattern' }
  if (d.rule_type === 'regex') {
    try {
      new RegExp(pattern, d.case_sensitive ? '' : 'i')
    } catch {
      return { ok: false, error: 'mc_mr_err_regex' }
    }
  }
  const channels = mrParseChannels(d.channels)
  if (channels.length > MR_CHANNELS_MAX || channels.some((c) => c.length > MR_CHANNEL_MAX)) {
    return { ok: false, error: 'mc_mr_err_channels' }
  }
  const platforms = (d.platforms || []).filter((p) => MR_PLATFORMS.includes(p))
  const via = (d.notify_via || []).filter((v) => MR_NOTIFY_VIA.includes(v))
  if (!via.length) return { ok: false, error: 'mc_mr_err_notify' }
  const body = {
    rule_type: d.rule_type,
    pattern,
    channels: channels.length ? channels : null,
    platforms: platforms.length ? platforms : null,
    case_sensitive: !!d.case_sensitive,
    notify_via: via,
  }
  const cdText = String(d.cooldown_seconds ?? '').trim()
  if (cdText) {
    const cd = Number(cdText)
    if (!Number.isInteger(cd) || cd < MR_COOLDOWN_MIN || cd > MR_COOLDOWN_MAX) {
      return { ok: false, error: 'mc_mr_err_cooldown' }
    }
    body.cooldown_seconds = cd
  }
  return { ok: true, body }
}

function mrHitUrl(h) {
  const when = new Date(h.matched_at)
  if (Number.isNaN(+when)) return ''
  const day = when.toISOString().slice(0, 10)
  const anchor = h.message_id ? `?m=${encodeURIComponent(h.message_id)}` : ''
  return `https://heatsync.org/search/logs/${encodeURIComponent(h.platform || '')}/${encodeURIComponent(h.channel || '')}/${day}${anchor}`
}

function mrHitsHtml(hits) {
  if (!hits.length)
    return `<div class="hs-mc-setting-row" style="color:#ffffff;font-size:13px">${escapeHtml(t('mc_mr_hits_none'))}</div>`
  return hits
    .map((h) => {
      const tag = MR_PLAT_TAG[h.platform] || '?'
      const who = escapeHtml(h.display_name || h.username || '')
      const when = Number.isNaN(new Date(h.matched_at).getTime()) ? '' : escapeHtml(formatRelativeTime(h.matched_at))
      const url = mrHitUrl(h) // '' for a hit with no usable date: shown, just not linked
      const open = url
        ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" style="color:inherit;text-decoration:none;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">`
        : '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'
      return (
        '<div class="hs-mc-setting-row" style="gap:4px;font-size:13px;overflow:hidden">' +
        open +
        `<span style="color:#ffffff">[${tag}] #${escapeHtml(h.channel || '')}</span> ${who}: ${escapeHtml(h.snippet || '')}${url ? '</a>' : '</span>'}` +
        `<span style="color:#ffffff;flex-shrink:0">${when}</span></div>`
      )
    })
    .join('')
}

function mrRuleRowHtml(r) {
  const id = escapeHtml(String(r.id))
  const scope = [
    Array.isArray(r.channels) && r.channels.length ? r.channels.map((c) => `#${c}`).join(' ') : '',
    Array.isArray(r.platforms) && r.platforms.length ? r.platforms.map((p) => MR_PLAT_TAG[p] || '').join('') : '',
  ]
    .filter(Boolean)
    .join(' ')
  return (
    `<div class="hs-mc-setting-row hs-mc-setting-row-split" data-mr-row="${id}" style="gap:4px">` +
    '<div style="display:flex;align-items:center;gap:4px;flex:1;min-width:0;overflow:hidden">' +
    `<button class="hs-mc-toggle-pill${r.enabled ? ' active' : ''}" data-mr-action="toggle" data-mr-id="${id}" style="flex-shrink:0"><span class="hs-mc-toggle-knob"></span></button>` +
    `<span style="color:#ffffff;font-size:13px;min-width:44px;flex-shrink:0">${escapeHtml(r.rule_type || '')}</span>` +
    `<span style="font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1" title="${escapeHtml(r.pattern || '')}">${escapeHtml(r.pattern || '')}</span>` +
    (scope ? `<span style="color:#ffffff;font-size:13px;flex-shrink:0">${escapeHtml(scope)}</span>` : '') +
    (r.dormant
      ? `<span style="color:#ffff00;font-size:13px;flex-shrink:0">${escapeHtml(t('mc_mr_dormant'))}</span>`
      : '') +
    '</div>' +
    `<button data-mr-action="edit" data-mr-id="${id}" style="${FR_BTN};color:#ffffff;flex-shrink:0;padding:1px 4px" title="${escapeHtml(t('mc_mr_edit'))}">✎</button>` +
    hsXButtonHtml(
      'hs-x-inline',
      t('mc_mr_delete'),
      `data-mr-action="delete" data-mr-id="${id}" title="${escapeHtml(t('mc_mr_delete'))}"`,
    ) +
    '</div>'
  )
}

// The current tab's channel names, offered as one-click chips.
function mrTabChannels() {
  const ch = typeof config !== 'undefined' && config?.channels ? config.channels.find((c) => c.id === currentTab) : null
  if (!ch) return []
  return [ch.twitch, ch.kick].filter(Boolean).map((c) => String(c).toLowerCase())
}

function mrFormHtml(d, editing) {
  const opt = (v, cur) => `<option value="${v}"${v === cur ? ' selected' : ''}>${v}</option>`
  const box = (field, value, label, on, title) =>
    `<label style="display:flex;align-items:center;gap:2px;color:#ffffff;font-size:13px;cursor:pointer;flex-shrink:0"${title ? ` title="${escapeHtml(title)}"` : ''}>` +
    `<input type="checkbox" data-mr-field="${field}" value="${value}"${on ? ' checked' : ''} style="margin:0;cursor:pointer">${label}</label>`
  const chips = mrTabChannels()
    .map(
      (c) =>
        `<button data-mr-action="chip" data-mr-chan="${escapeHtml(c)}" style="${FR_BTN};color:#ffffff;padding:0 4px">+#${escapeHtml(c)}</button>`,
    )
    .join('')
  return (
    '<div class="hs-mc-setting-row hs-mc-setting-row-block hs-mc-mr-form" style="padding:4px 4px 6px">' +
    `<div style="font-size:13px;color:#ffffff;margin-bottom:4px">${escapeHtml(t(editing ? 'mc_mr_edit' : 'mc_mr_add'))}</div>` +
    '<div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center">' +
    `<select data-mr-field="type" style="${FR_SEL};width:64px">${MR_TYPES.map((v) => opt(v, d.rule_type)).join('')}</select>` +
    `<input type="text" data-mr-field="pattern" maxlength="${MR_PATTERN_MAX}" value="${escapeHtml(d.pattern)}" placeholder="${escapeHtml(t('mc_mr_pattern_ph'))}" style="${FR_INPUT}">` +
    box('cs', 'cs', 'Aa', d.case_sensitive, t('mc_mr_case')) +
    '</div>' +
    '<div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center;margin-top:4px">' +
    `<input type="text" data-mr-field="channels" value="${escapeHtml(d.channels)}" placeholder="${escapeHtml(t('mc_mr_channels_ph'))}" style="${FR_INPUT}">` +
    chips +
    '</div>' +
    '<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:4px">' +
    MR_PLATFORMS.map((p) => box('plat', p, MR_PLAT_TAG[p], d.platforms.includes(p))).join('') +
    '<span style="color:#ffffff">|</span>' +
    MR_NOTIFY_VIA.map((v) => box('via', v, v, d.notify_via.includes(v))).join('') +
    `<input type="text" inputmode="numeric" data-mr-field="cd" value="${escapeHtml(d.cooldown_seconds)}" placeholder="${escapeHtml(t('mc_mr_cooldown_ph'))}" title="${MR_COOLDOWN_MIN}–${MR_COOLDOWN_MAX}" style="${FR_INPUT};width:64px;flex:none">` +
    `<button data-mr-action="save" style="${FR_BTN};background:#000000">${escapeHtml(t('mc_mr_save'))}</button>` +
    (editing ? `<button data-mr-action="cancel" style="${FR_BTN}">${escapeHtml(t('mc_mr_cancel'))}</button>` : '') +
    '</div>' +
    '<div style="display:flex;gap:4px;align-items:center;margin-top:4px">' +
    `<input type="text" data-mr-field="testmsg" value="${escapeHtml(mrState.testMsg)}" placeholder="${escapeHtml(t('mc_mr_test_ph'))}" style="${FR_INPUT}">` +
    `<button data-mr-action="test" style="${FR_BTN}">${escapeHtml(t('mc_mr_test'))}</button>` +
    (mrState.testResult === null
      ? ''
      : `<span style="font-size:13px;color:${mrState.testResult ? 'var(--hs-ok)' : 'var(--hs-danger)'}">${escapeHtml(t(mrState.testResult ? 'mc_mr_match' : 'mc_mr_nomatch'))}</span>`) +
    '</div>' +
    (mrState.error
      ? `<div style="font-size:13px;color:var(--hs-danger);margin-top:4px">${escapeHtml(mrState.error)}</div>`
      : '') +
    '</div>'
  )
}

function mrGroupHtml() {
  const fold = _setCollapsed.has('notifs|mrules')
  const title =
    `<div class="hs-mc-settings-group-title" data-set-fold="mrules">${fold ? '▸ ' : '▾ '}${escapeHtml(t('mc_mr_title'))}` +
    (mrState.rules.length ? ` <span class="hs-mc-set-cnt">(${mrState.rules.length})</span>` : '') +
    '</div>'
  if (fold) return `<div class="hs-mc-settings-group">${title}</div>`
  if (!hsAuthToken) {
    mrState.loaded = false
    mrState.rules = []
    mrState.hits = []
    return `<div class="hs-mc-settings-group">${title}<div class="hs-mc-setting-row" style="color:#ffffff;font-size:13px">${escapeHtml(t('mc_mr_signin'))}</div></div>`
  }
  if (!mrState.loaded && !mrState.loading && Date.now() - mrState.failedAt > MR_RETRY_MS) mrLoad()
  if (!mrState.loaded && mrState.failedAt) {
    const line = mrState.unauthed ? t('mc_mr_signin') : mrState.error
    return `<div class="hs-mc-settings-group">${title}<div class="hs-mc-setting-row" style="color:#ffffff;font-size:13px">${escapeHtml(line)}</div></div>`
  }
  const rows = mrState.rules.length
    ? mrState.rules.map(mrRuleRowHtml).join('')
    : `<div class="hs-mc-setting-row" style="color:#ffffff;font-size:13px">${escapeHtml(t('mc_mr_none'))}</div>`
  const editing = mrState.editId !== null
  return (
    `<div class="hs-mc-settings-group">${title}${rows}` +
    mrFormHtml(mrState.draft || mrBlankDraft(), editing) +
    `<div class="hs-mc-settings-group-title" style="cursor:default">${escapeHtml(t('mc_mr_hits'))}</div>` +
    mrHitsHtml(mrState.hits) +
    '</div>'
  )
}

// ── data ───────────────────────────────────────────────────────────────────

async function mrLoad() {
  mrState.loading = true
  const [rules, hits] = await Promise.all([
    apiFetch('/api/mention-rules'),
    apiFetch('/api/mention-rules/hits?limit=25'),
  ])
  mrState.loading = false
  if (!rules?.ok) {
    // Not loaded: a 401 keeps the sign-in line up, anything else shows its error,
    // and a later open (after MR_RETRY_MS) tries again instead of showing "none".
    mrState.loaded = false
    mrState.failedAt = Date.now()
    mrState.unauthed = rules?.status === 401
    mrState.error = mrState.unauthed ? '' : mrServerError(rules)
    if (currentTab === 'settings') renderSettingsTab()
    return
  }
  mrState.loaded = true
  mrState.failedAt = 0
  mrState.unauthed = false
  mrState.rules = Array.isArray(rules.data?.rules) ? rules.data.rules : []
  mrState.limit = Number(rules.data?.limit) || 0
  mrState.hits = hits?.ok && Array.isArray(hits.data?.hits) ? hits.data.hits : []
  if (currentTab === 'settings') renderSettingsTab()
}

// Pull what's typed in the form back into state, so a re-render (status, edit,
// chip) never eats a half-written rule.
function mrReadForm(form) {
  if (!form) return mrState.draft || mrBlankDraft()
  const f = (n) => form.querySelector(`[data-mr-field="${n}"]`)
  const all = (n) => [...form.querySelectorAll(`[data-mr-field="${n}"]`)]
  mrState.testMsg = f('testmsg')?.value || ''
  mrState.draft = {
    rule_type: f('type')?.value || 'word',
    pattern: f('pattern')?.value || '',
    channels: f('channels')?.value || '',
    platforms: all('plat')
      .filter((e) => e.checked)
      .map((e) => e.value),
    case_sensitive: !!f('cs')?.checked,
    notify_via: all('via')
      .filter((e) => e.checked)
      .map((e) => e.value),
    cooldown_seconds: f('cd')?.value || '',
  }
  return mrState.draft
}

function mrServerError(r) {
  return r?.status === 401 ? t('mc_social_login_first') : r?.error || t('mc_feed_action_failed')
}

async function mrSave(form) {
  const built = mrDraftToBody(mrReadForm(form))
  if (!built.ok) {
    mrState.error = t(built.error)
    return renderSettingsTab()
  }
  const id = mrState.editId
  const r = await apiFetch(id === null ? '/api/mention-rules' : `/api/mention-rules/${encodeURIComponent(id)}`, {
    method: id === null ? 'POST' : 'PUT',
    body: built.body,
  })
  if (!r?.ok) {
    mrState.error = mrServerError(r)
    return renderSettingsTab()
  }
  mrState.error = ''
  mrState.editId = null
  mrState.draft = null
  mrState.testResult = null
  await mrLoad()
}

async function mrTest(form) {
  const d = mrReadForm(form)
  const built = mrDraftToBody(d)
  if (!built.ok) {
    mrState.error = t(built.error)
    return renderSettingsTab()
  }
  const r = await apiFetch('/api/mention-rules/test', {
    method: 'POST',
    body: {
      message: mrState.testMsg.slice(0, 1000),
      rule_type: built.body.rule_type,
      pattern: built.body.pattern,
      case_sensitive: built.body.case_sensitive,
    },
  })
  mrState.error = r?.ok ? '' : mrServerError(r)
  mrState.testResult = r?.ok ? !!r.data?.matched : null
  renderSettingsTab()
}

async function mrHandleAction(el) {
  const act = el.dataset.mrAction
  const id = el.dataset.mrId
  const form = el.closest('.hs-mc-mr-form') || document.querySelector('.hs-mc-mr-form')
  if (act === 'save') return mrSave(form)
  if (act === 'test') return mrTest(form)
  if (act === 'chip') {
    const d = mrReadForm(form)
    const have = mrParseChannels(d.channels)
    const c = el.dataset.mrChan
    if (c && !have.includes(c)) d.channels = [...have, c].join(', ')
    return renderSettingsTab()
  }
  if (act === 'cancel') {
    mrState.editId = null
    mrState.draft = null
    mrState.error = ''
    mrState.testResult = null
    return renderSettingsTab()
  }
  const rule = mrState.rules.find((r) => String(r.id) === id)
  if (!rule) return
  // keep a half-typed new rule across the reload that follows toggle / delete
  if (act === 'toggle' || act === 'delete') mrReadForm(form)
  if (act === 'edit') {
    mrState.editId = rule.id
    mrState.draft = mrRuleToDraft(rule)
    mrState.error = ''
    mrState.testResult = null
    return renderSettingsTab()
  }
  if (act === 'toggle') {
    const r = await apiFetch(`/api/mention-rules/${encodeURIComponent(rule.id)}`, {
      method: 'PUT',
      body: { enabled: !rule.enabled },
    })
    if (!r?.ok) showToast(mrServerError(r), 'error')
    return mrLoad()
  }
  if (act === 'delete') {
    const r = await apiFetch(`/api/mention-rules/${encodeURIComponent(rule.id)}`, { method: 'DELETE' })
    if (!r?.ok) showToast(mrServerError(r), 'error')
    if (mrState.editId === rule.id) {
      mrState.editId = null
      mrState.draft = null
    }
    return mrLoad()
  }
}
