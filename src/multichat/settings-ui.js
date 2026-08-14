// settings tab UI — split out of main.js (2026-07-04).
// Sub-tab bar, search/filter rows, category panes, presets panel, help overlay,
// crash-log/backup blocks, and the settings-tab-only keyboard nav. The settings
// ENGINE (getSetting/setSetting, schema wiring, storage sync/broadcast) stays in
// main.js — this file only builds and drives the tab's DOM.

// Active settings sub-tab — persisted across re-renders
let _settingsSubtab = 'display'

// ─── settings sub-tab helpers ────────────────────────────────────────────

// SVG icons for the settings sub-tabs (16x16 stroke, no fill)
const _SET_SUBTAB_ICONS = {
  display:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1" y="2" width="14" height="10" rx="1"/><line x1="5" y1="14" x2="11" y2="14"/><line x1="8" y1="12" x2="8" y2="14"/></svg>',
  chat: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6l-3 2v-2H3a1 1 0 0 1-1-1V3z"/></svg>',
  notifs:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 2a5 5 0 0 1 5 5v3l1 1H2l1-1V7a5 5 0 0 1 5-5z"/><line x1="6.5" y1="13" x2="9.5" y2="13"/></svg>',
  mod: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 1.5l5 2.5v4c0 3-2.5 5.5-5 6.5C5.5 13.5 3 11 3 8V4l5-2.5z"/></svg>',
  filters:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 4h12M4 8h8M6 12h4"/></svg>',
  tweaks:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 4h3l1-2h4l1 2h3M2 8h12M2 12h3l1 2h4l1-2h3"/></svg>',
  system:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="2.5"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.42 1.42M11.53 11.53l1.42 1.42M3.05 12.95l1.42-1.42M11.53 4.47l1.42-1.42"/></svg>',
}
const _SET_SUBTAB_ORDER = ['display', 'chat', 'notifs', 'mod', 'filters', 'tweaks', 'system']

// Tweaks (twitch ui noise toggles) render straight from the registry
// (`tweak: true` entries); content.js applyUiSettings owns the CSS rules.
function _renderSetSubtabBar() {
  return (
    '<div class="hs-mc-set-subtabs">' +
    _SET_SUBTAB_ORDER
      .map(
        (id) =>
          '<button class="hs-mc-set-subtab' +
          (_settingsSubtab === id ? ' active' : '') +
          '" data-set-subtab="' +
          id +
          '" title="' +
          id +
          '">' +
          _SET_SUBTAB_ICONS[id] +
          '</button>',
      )
      .join('') +
    '</div>'
  )
}

// ─── registry-driven settings renderer ───────────────────────────────
// Every registry entry renders through one emitter per control type,
// reusing the existing DOM/CSS vocabulary (setting-row, toggle-pill,
// size-btns, locale-select, textarea). Categories compose registry
// sections with the few hand-rendered islands (mod toolbar, language,
// muted users, crash log, backup, defaults).

let _setQuery = ''
const _setCollapsed = new Set() // '<category>|<section title>'
let _setFocusRow = null // data-set-row id of keyboard focus
let _setPaneCtx = '' // pane identity for scroll preservation
let _setHelpOpen = false // '?' keybinding overlay
// Opening ~90 settings at once is the single loudest thing a new user meets
// ("very confusing and a lot to learn" — first external tester, 2026-07-25).
// The catalog stays whole; the default VIEW is the dozen rows that actually
// change day one, with everything else one click away. Per-device UI state,
// not a synced setting — it's a view preference, and it must never travel to
// a device where someone already expanded it.
let _setShowAll = false
;(function _loadCollapsedSections() {
  try {
    chrome.storage.local.get(['hs_set_collapsed', 'hs_set_show_all'], (d) => {
      if (Array.isArray(d?.hs_set_collapsed)) {
        for (const id of d.hs_set_collapsed) _setCollapsed.add(String(id))
      }
      if (d?.hs_set_show_all) {
        _setShowAll = true
        // Storage reads land after the first paint on a warm tab — repaint so
        // an expanded view doesn't silently collapse back to basic.
        if (typeof _settingsSubtab !== 'undefined' && document.querySelector('.hs-mc-settings-panel')) {
          try {
            renderSettingsTab()
          } catch (_) {}
        }
      }
    })
  } catch (_) {}
})()
function _saveCollapsedSections() {
  try {
    chrome.storage.local.set({ hs_set_collapsed: [..._setCollapsed] })
  } catch (_) {}
}
function _saveShowAll() {
  try {
    chrome.storage.local.set({ hs_set_show_all: _setShowAll })
  } catch (_) {}
}

function _setLabel(def) {
  return def.labelKey ? t(def.labelKey) : def.label || def.key
}
function _setTip(def) {
  return def.tipKey ? t(def.tipKey) : def.tip || ''
}
function _setSectionTitle(def) {
  return def.sectionKey ? t(def.sectionKey) : def.section || ''
}
function _optLabel(o) {
  return o.labelKey ? t(o.labelKey) : o.label !== undefined ? o.label : String(o.value)
}

function _setLabelSpan(def, extraHtml) {
  var tip = _setTip(def)
  var tipAttr = tip ? ` data-tip="${escapeHtml(tip)}"` : ''
  return `<span class="hs-mc-setting-label"${tipAttr}>${extraHtml || ''}${escapeHtml(_setLabel(def))}</span>`
}

function _depSatisfied(def) {
  if (!def.dependsOn) return true
  var v = getSetting(def.dependsOn.key)
  return 'equals' in def.dependsOn ? v === def.dependsOn.equals : !!v
}

// One renderable row = {id, html, hay}. boolmap/multiselect entries
// expand to one row per option so search and keyboard nav see each.
// Boot-time values for entries that need a reload to apply (reloadApply
// schema field) — snapshot in loadAllSettings, drives the [reload] chip.
const _bootVals = {}

// Does this row's current value differ from its default? (noReset entries
// never show modified — they have no working reset.)
function _rowModified(def, opt) {
  if (def.noReset) return false
  const cur = getSetting(def.key)
  if (def.type === 'boolmap' && opt) return (cur[opt.value] !== false) !== (opt.default !== false)
  if (def.type === 'multiselect' && opt) return cur.includes(opt.value) !== def.default.includes(opt.value)
  return JSON.stringify(cur) !== JSON.stringify(def.default)
}

// Does this row need a page reload before its current value takes effect?
function _reloadPending(def, opt) {
  if (def.key === 'subsystems' && opt && opt.applies === 'reload' && _gatesAtBoot) {
    return (getSetting('subsystems')[opt.value] !== false) !== (_gatesAtBoot[opt.value] !== false)
  }
  if (def.reloadApply && def.key in _bootVals) {
    return JSON.stringify(getSetting(def.key)) !== JSON.stringify(_bootVals[def.key])
  }
  return false
}

// In-place update of the modified edge + the section's orange counter
// after a control change (no full re-render needed for plain pills).
function _syncRowModEdge(el, def, opt) {
  const row = el.closest('.hs-mc-setting-row')
  if (!row) return
  row.classList.toggle('hs-mc-set-mod', _rowModified(def, opt))
  const group = row.closest('.hs-mc-settings-group')
  const title = group?.querySelector('[data-set-fold]')
  if (!title) return
  const count = group.querySelectorAll('.hs-mc-setting-row.hs-mc-set-mod').length
  let cnt = title.querySelector('.hs-mc-set-modcnt')
  if (!count) {
    if (cnt) cnt.remove()
    return
  }
  if (!cnt) {
    cnt = document.createElement('span')
    cnt.className = 'hs-mc-set-modcnt'
    title.appendChild(document.createTextNode(' '))
    title.appendChild(cnt)
  }
  cnt.textContent = `${count}*`
}

function _rowsForDef(def) {
  var rows = []
  // Custom-rendered entries (e.g. filter rules editor) skip auto-row generation.
  if (def.control === 'custom') return rows
  var base = (
    _setLabel(def) +
    ' ' +
    _setTip(def) +
    ' ' +
    _setSectionTitle(def) +
    ' ' +
    def.category +
    ' ' +
    def.key +
    ' ' +
    (def.alias || '')
  ).toLowerCase()
  var child = def.dependsOn ? ' hs-mc-set-child' : ''
  var glyph = def.dependsOn ? '<span class="hs-mc-set-child-glyph">└ </span>' : ''

  if (def.type === 'boolmap') {
    for (const o of def.options) {
      var on = !!getSetting(def.key)[o.value]
      var prefix = `<span style="color:${o.color}">${o.tag || '◆'}</span> `
      var lbl = _optLabel(o)
      if (o.tag) lbl = lbl.replace(o.tag, '').trim()
      var oTip = o.tipKey ? t(o.tipKey) : o.tip || ''
      var oMod = _rowModified(def, o)
      var oChip = _reloadPending(def, o) ? '<button class="hs-mc-set-reload" data-set-reload>reload</button>' : ''
      rows.push({
        id: `${def.key}:${o.value}`,
        mod: oMod,
        hay: `${base} ${lbl} ${oTip} ${o.value}`.toLowerCase(),
        html:
          '<div class="hs-mc-setting-row' +
          child +
          (oMod ? ' hs-mc-set-mod' : '') +
          '" data-set-row="' +
          def.key +
          ':' +
          o.value +
          '">' +
          glyph +
          '<button class="hs-mc-toggle-pill' +
          (on ? ' active' : '') +
          '" data-set-key="' +
          def.key +
          '" data-set-sub="' +
          o.value +
          '"><span class="hs-mc-toggle-knob"></span></button>' +
          '<span class="hs-mc-setting-label"' +
          (oTip ? ` data-tip="${escapeHtml(oTip)}"` : '') +
          '>' +
          prefix +
          escapeHtml(lbl) +
          '</span>' +
          oChip +
          '</div>',
      })
    }
    return rows
  }

  if (def.type === 'multiselect') {
    for (const o of def.options) {
      var member = getSetting(def.key).includes(o.value)
      var active = def.invertDisplay ? !member : member
      var mMod = _rowModified(def, o)
      var mTag = o.tag
        ? '<span style="font-family:monospace;color:#fff;margin-right:6px;min-width:34px;display:inline-block">' +
          escapeHtml(o.tag) +
          '</span>'
        : ''
      rows.push({
        id: `${def.key}:${o.value}`,
        mod: mMod,
        hay: `${base} ${_optLabel(o)} ${o.value}`.toLowerCase(),
        html:
          '<div class="hs-mc-setting-row' +
          child +
          (mMod ? ' hs-mc-set-mod' : '') +
          '" data-set-row="' +
          def.key +
          ':' +
          o.value +
          '">' +
          glyph +
          '<button class="hs-mc-toggle-pill' +
          (active ? ' active' : '') +
          '" data-set-key="' +
          def.key +
          '" data-set-value="' +
          escapeHtml(String(o.value)) +
          '"><span class="hs-mc-toggle-knob"></span></button>' +
          '<span class="hs-mc-setting-label">' +
          mTag +
          escapeHtml(_optLabel(o)) +
          '</span>' +
          '</div>',
      })
    }
    return rows
  }

  var inner = ''
  var split = true
  var block = false
  var val = getSetting(def.key)

  if (def.type === 'bool') {
    split = false
    inner =
      '<button class="hs-mc-toggle-pill' +
      (val ? ' active' : '') +
      '" data-set-key="' +
      def.key +
      '"><span class="hs-mc-toggle-knob"></span></button>' +
      _setLabelSpan(def)
  } else if (def.type === 'enum' && (def.control === 'sizebtns' || resolveOptions(def, getSetting).length <= 3)) {
    // optionsFor narrows the list to the current state — the font size row uses
    // it so a bitmap face only ever offers the sizes it actually has. Static
    // `options` stays the union, because validate/coerce/lint read it with no
    // access to other settings.
    var sizeOpts = resolveOptions(def, getSetting)
    inner =
      _setLabelSpan(def) +
      '<div class="hs-mc-size-btns">' +
      sizeOpts
        .map(
          (o) =>
            '<button class="hs-mc-size-btn' +
            (o.value === val ? ' active' : '') +
            '" data-set-key="' +
            def.key +
            '" data-set-value="' +
            escapeHtml(String(o.value)) +
            '">' +
            escapeHtml(_optLabel(o)) +
            '</button>',
        )
        .join('') +
      '</div>'
  } else if (def.type === 'enum') {
    inner =
      _setLabelSpan(def) +
      '<select class="hs-mc-locale-select" data-set-key="' +
      def.key +
      '" style="max-width:55%">' +
      def.options
        .map(
          (o) =>
            '<option value="' +
            escapeHtml(String(o.value)) +
            '"' +
            (o.value === val ? ' selected' : '') +
            '>' +
            escapeHtml(_optLabel(o)) +
            '</option>',
        )
        .join('') +
      '</select>'
  } else if (def.type === 'range') {
    var scale = def.displayScale || 1
    inner =
      _setLabelSpan(def) +
      '<div style="display:flex;align-items:center;gap:6px">' +
      '<input class="hs-mc-set-range" type="range" min="' +
      def.options.min * scale +
      '" max="' +
      def.options.max * scale +
      '" step="' +
      def.options.step * scale +
      '" value="' +
      Math.round(val * scale) +
      '" data-set-key="' +
      def.key +
      '">' +
      '<span class="hs-mc-set-range-val">' +
      Math.round(val * scale) +
      '</span>' +
      '</div>'
  } else if (def.control === 'textarea') {
    block = true
    split = false
    var ph = def.placeholderKey ? t(def.placeholderKey) : def.placeholder || ''
    inner =
      _setLabelSpan(def) +
      '<textarea class="hs-mc-setting-textarea" data-set-key="' +
      def.key +
      '" placeholder="' +
      escapeHtml(ph) +
      '" rows="3">' +
      escapeHtml(val) +
      '</textarea>'
  } else {
    // text
    inner =
      _setLabelSpan(def) +
      '<input class="hs-mc-set-text-input" data-set-key="' +
      def.key +
      '" type="text" value="' +
      escapeHtml(val) +
      '" style="width:140px">'
  }

  var sMod = _rowModified(def)
  var sChip = _reloadPending(def) ? '<button class="hs-mc-set-reload" data-set-reload>reload</button>' : ''
  rows.push({
    id: def.key,
    mod: sMod,
    hay:
      base +
      ' ' +
      (def.type === 'enum'
        ? def.options
            .map((o) => `${_optLabel(o)} ${o.value}`)
            .join(' ')
            .toLowerCase()
        : ''),
    html:
      '<div class="hs-mc-setting-row' +
      (split ? ' hs-mc-setting-row-split' : '') +
      (block ? ' hs-mc-setting-row-block' : '') +
      child +
      (sMod ? ' hs-mc-set-mod' : '') +
      '" data-set-row="' +
      def.key +
      '">' +
      glyph +
      inner +
      sChip +
      '</div>',
  })
  return rows
}

function _setQueryTokens() {
  return _setQuery.toLowerCase().split(/\s+/).filter(Boolean)
}
function _rowMatches(hay, tokens) {
  return tokens.every((tk) => hay.indexOf(tk) !== -1)
}

// Render the registry sections of one category. opts.only limits to the
// named sections (lets system interleave hand-rendered islands).
function _regSections(cat, only) {
  var sections = []
  var byTitle = new Map()
  for (const def of SETTINGS) {
    if (def.category !== cat || !_depSatisfied(def)) continue
    // Basic view: only the day-one rows. Search always searches EVERYTHING
    // (_renderSearchResults has its own path) — hiding a setting from a
    // search for its own name would be the bad kind of simple.
    if (!_setShowAll && !def.basic) continue
    var title = _setSectionTitle(def)
    if (only && only.indexOf(def.section) === -1) continue
    var s = byTitle.get(title)
    if (!s) {
      s = { title: title, rows: [] }
      byTitle.set(title, s)
      sections.push(s)
    }
    s.rows.push.apply(s.rows, _rowsForDef(def))
  }
  return sections
    .map((s) => {
      var fold = _setCollapsed.has(`${_settingsSubtab}|${s.title}`)
      var modCount = s.rows.filter((r) => r.mod).length
      var counts = fold
        ? ' <span class="hs-mc-set-cnt">(' +
          s.rows.length +
          (modCount ? ` · <span class="hs-mc-set-modcnt">${modCount}*</span>` : '') +
          ')</span>'
        : modCount
          ? ` <span class="hs-mc-set-modcnt">${modCount}*</span>`
          : ''
      return (
        '<div class="hs-mc-settings-group">' +
        '<div class="hs-mc-settings-group-title" data-set-fold="' +
        escapeHtml(s.title) +
        '">' +
        (fold ? '▸ ' : '▾ ') +
        escapeHtml(s.title) +
        counts +
        '</div>' +
        (fold ? '' : s.rows.map((r) => r.html).join('')) +
        '</div>'
      )
    })
    .join('')
}

// Search across ALL categories — matched rows grouped under clickable
// "category · section" headers (click = jump to that pane + section).
// Current-category groups list first.
function _renderSearchResults() {
  var tokens = _setQueryTokens()
  var groups = []
  var byKey = new Map()
  var total = 0
  var count = 0
  for (const def of SETTINGS) {
    if (!_depSatisfied(def)) continue
    var rows = _rowsForDef(def)
    total += rows.length
    var matched = rows.filter((r) => _rowMatches(r.hay, tokens))
    if (!matched.length) continue
    count += matched.length
    var section = _setSectionTitle(def)
    var gk = `${def.category}|${section}`
    var g = byKey.get(gk)
    if (!g) {
      g = { cat: def.category, section: section, rows: [] }
      byKey.set(gk, g)
      groups.push(g)
    }
    g.rows.push.apply(g.rows, matched)
  }
  groups.sort((a, b) => (a.cat === _settingsSubtab ? 0 : 1) - (b.cat === _settingsSubtab ? 0 : 1))
  var html = groups
    .map(
      (g) =>
        '<div class="hs-mc-settings-group">' +
        '<div class="hs-mc-set-search-hdr" data-set-jump="' +
        escapeHtml(`${g.cat}|${g.section}`) +
        '">' +
        escapeHtml(`${g.cat} · ${g.section}`) +
        '</div>' +
        g.rows.map((r) => r.html).join('') +
        '</div>',
    )
    .join('')
  // action rows (export/import/defaults) — searchable buttons
  var actions = _SET_ACTION_ROWS.filter((a) => _rowMatches(a.hay, tokens))
  total += _SET_ACTION_ROWS.length
  if (actions.length) {
    count += actions.length
    html +=
      '<div class="hs-mc-settings-group">' +
      '<div class="hs-mc-set-search-hdr" data-set-jump="system|backup / restore">system · backup / restore</div>' +
      actions.map((a) => a.html).join('') +
      '</div>'
  }
  if (!count) html = '<div class="hs-mc-setting-row" style="color:#808080">no matches</div>'
  return { html: html, count: count, total: total }
}

// ── hand-rendered islands ────────────────────────────────────────────

function _renderMutedGroup() {
  return (
    '<div class="hs-mc-settings-group">' +
    '<div class="hs-mc-settings-group-title">' +
    t('mc_settings_muted_users') +
    '</div>' +
    (mutedUsers.size === 0
      ? `<div class="hs-mc-setting-row" style="color:#808080;font-size:13px">${t('mc_settings_no_muted')}</div>`
      : Array.from(mutedUsers)
          .sort()
          .map((u) => {
            // Display bare username; data-username keeps the full key for deletion.
            const displayU = u.includes(':') ? u.split(':')[1] : u
            return (
              '<div class="hs-mc-setting-row hs-mc-setting-row-split">' +
              '<span class="hs-mc-setting-label" style="font-size:13px">' +
              escapeHtml(displayU) +
              '</span>' +
              '<button class="hs-mc-unmute-btn" data-username="' +
              escapeHtml(u) +
              '" style="background:none;border:1px solid #808080;color:#808080;font-size:13px;cursor:pointer;padding:1px 6px;line-height:1.4" title="' +
              t('mc_settings_unmute') +
              '">✕</button>' +
              '</div>'
            )
          })
          .join('')) +
    '</div>'
  )
}

function _renderCrashLogBlock() {
  var crash = !!getSetting('crashTelemetry')
  return (
    '<div class="hs-mc-setting-row hs-mc-setting-row-block" id="hs-set-crashlog-row"' +
    (!crash ? ' style="display:none"' : '') +
    '>' +
    '<div style="display:flex;justify-content:space-between;align-items:center;width:100%">' +
    '<span class="hs-mc-setting-label">recent errors</span>' +
    '<div style="display:flex;gap:4px">' +
    '<button id="hs-set-crash-copy" style="background:#000;color:#fff;border:1px solid #808080;padding:2px 8px;font-size:13px;cursor:pointer;font-family:inherit">copy</button>' +
    '<button id="hs-set-crash-clear" style="background:#000;color:#fff;border:1px solid #808080;padding:2px 8px;font-size:13px;cursor:pointer;font-family:inherit">clear</button>' +
    '</div>' +
    '</div>' +
    '<pre id="hs-set-crash-pre" class="hs-mc-set-crash-pre">(loading...)</pre>' +
    '</div>'
  )
}

// Action rows — buttons, not settings, but people search for them.
// Shared between the system pane (_renderBackupGroup) and search results.
const _SET_ACTION_ROWS = [
  {
    hay: 'export settings backup download json save system',
    html:
      '<div class="hs-mc-setting-row hs-mc-setting-row-split">' +
      '<span class="hs-mc-setting-label" data-tip="dump ui_settings + all hs_* keys to a JSON file. portable across devices and browsers.">export settings</span>' +
      '<button class="hs-mc-settings-btn" data-action="export-settings" style="background:#000;color:#fff;border:1px solid #808080;padding:2px 10px;font-size:13px;cursor:pointer;font-family:inherit">download .json</button>' +
      '</div>',
  },
  {
    hay: 'import settings restore load json system',
    html:
      '<div class="hs-mc-setting-row hs-mc-setting-row-split">' +
      '<span class="hs-mc-setting-label" data-tip="restore from a previously-exported JSON file. merges into existing settings.">import settings</span>' +
      '<button class="hs-mc-settings-btn" data-action="import-settings" style="background:#000;color:#fff;border:1px solid #808080;padding:2px 10px;font-size:13px;cursor:pointer;font-family:inherit">load .json</button>' +
      '</div>',
  },
  {
    hay: 'default reset all settings factory system',
    html:
      '<div class="hs-mc-setting-row" style="justify-content:flex-end">' +
      '<button class="hs-mc-defaults-btn" title="reset every setting on every page" style="background:#000;color:#fff;border:1px solid #808080;padding:2px 10px;font-size:13px;cursor:pointer;font-family:inherit">all defaults</button>' +
      '</div>',
  },
]

function _renderBackupGroup() {
  return (
    '<div class="hs-mc-settings-group">' +
    '<div class="hs-mc-settings-group-title">backup / restore</div>' +
    _SET_ACTION_ROWS[0].html +
    _SET_ACTION_ROWS[1].html +
    '</div>' +
    '<div class="hs-mc-settings-group">' +
    _SET_ACTION_ROWS[2].html +
    '</div>'
  )
}

// ── filter rules custom settings UI ────────────────────────────────────────
// Reads chatFilterRules (JSON string) from getSetting, renders an editor with
// per-rule rows + an add-rule form. Wired into the click/change handlers below.

var _filterRulesCorrupted = false

function _getRawFilterRules() {
  var raw = getSetting('chatFilterRules') || '[]'
  var arr
  try {
    arr = JSON.parse(raw)
  } catch (e) {
    if (!_filterRulesCorrupted) {
      _filterRulesCorrupted = true
      console.error('[heatsync] chatFilterRules JSON parse failed:', e)
      showToast(t('mc_settingsui_rules_corrupted'), 'error')
    }
    return []
  }
  if (!Array.isArray(arr)) {
    if (!_filterRulesCorrupted) {
      _filterRulesCorrupted = true
      console.error('[heatsync] chatFilterRules is not an array:', arr)
      showToast(t('mc_settingsui_rules_corrupted'), 'error')
    }
    return []
  }
  _filterRulesCorrupted = false
  return arr
}

function _saveFilterRules(rules) {
  // _getRawFilterRules() returns [] both for "no rules yet" and "corrupted
  // JSON" — refuse to write in the corrupted case, or the next add/edit
  // would silently persist over (and permanently lose) the unreadable blob.
  if (_filterRulesCorrupted) {
    showToast(t('mc_settingsui_rules_corrupted_reload'), 'error')
    return
  }
  var json = JSON.stringify(rules)
  saveUiSetting('chatFilterRules', json)
  var parsed = []
  try {
    parsed = JSON.parse(json)
  } catch {}
  compileFilterRules(parsed)
  renderMessages(currentTab)
  if (currentTab === 'settings') renderSettingsTab()
}

var FR_TYPE_LABELS = {
  keyword: 'kw',
  regex: 'rx',
  user: 'user',
  badge: 'badge',
  msgtype: 'type',
  expr: 'expr',
}
var FR_BTN =
  'background:#000;color:#fff;border:1px solid #808080;padding:1px 6px;font-size:13px;cursor:pointer;font-family:inherit;line-height:1.4'
var FR_SEL = 'background:#000;color:#fff;border:1px solid #808080;padding:1px 3px;font-size:13px;font-family:inherit'
var FR_INPUT =
  'background:#000;color:#fff;border:1px solid #808080;padding:1px 4px;font-size:13px;font-family:inherit;flex:1;min-width:60px'

function _renderFilterRuleRow(r) {
  var on = !!r.enabled
  var typeLabel = FR_TYPE_LABELS[r.match?.type] || '?'
  var val = r.match?.value ? escapeHtml(String(r.match.value)) : ''
  var aLabel = r.action === 'hide' ? 'hide' : 'hl'
  var aColor = r.action === 'highlight' && r.color ? escapeHtml(r.color) : ''
  var scopeLabel = r.scope && r.scope !== 'all' ? escapeHtml(String(r.scope)) : 'all'
  var id = escapeHtml(String(r.id))
  return (
    '<div class="hs-mc-setting-row hs-mc-setting-row-split" data-fr-row="' +
    id +
    '" style="gap:4px">' +
    '<div style="display:flex;align-items:center;gap:4px;flex:1;min-width:0;overflow:hidden">' +
    '<button class="hs-mc-toggle-pill' +
    (on ? ' active' : '') +
    '" data-fr-action="toggle" data-fr-id="' +
    id +
    '" style="flex-shrink:0"><span class="hs-mc-toggle-knob"></span></button>' +
    '<span style="color:#808080;font-size:13px;min-width:28px;flex-shrink:0">' +
    typeLabel +
    '</span>' +
    '<span style="font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1" title="' +
    val +
    '">' +
    val +
    '</span>' +
    '<span style="color:#aaa;font-size:13px;flex-shrink:0">▶' +
    aLabel +
    '</span>' +
    (aColor
      ? '<span style="display:inline-block;width:10px;height:10px;background:' +
        aColor +
        ';border:1px solid #444;flex-shrink:0"></span>'
      : '') +
    (r.action === 'highlight' && r.sound
      ? '<span style="color:#808080;font-size:13px;flex-shrink:0" title="sound: ' +
        escapeHtml(String(r.sound)) +
        '">♪</span>'
      : '') +
    '<span style="color:#666;font-size:13px;flex-shrink:0">' +
    scopeLabel +
    '</span>' +
    '</div>' +
    '<button data-fr-action="up" data-fr-id="' +
    id +
    '" style="' +
    FR_BTN +
    ';color:#808080;flex-shrink:0;padding:1px 4px" title="move up (higher priority — first match wins)">▲</button>' +
    '<button data-fr-action="down" data-fr-id="' +
    id +
    '" style="' +
    FR_BTN +
    ';color:#808080;flex-shrink:0;padding:1px 4px" title="move down">▼</button>' +
    '<button data-fr-action="delete" data-fr-id="' +
    id +
    '" style="' +
    FR_BTN +
    ';color:#808080;flex-shrink:0" title="delete rule">✕</button>' +
    '</div>'
  )
}

function _renderFilterRuleAddForm() {
  var channels = typeof config !== 'undefined' && config && config.channels ? config.channels : []
  var chOptions =
    '<option value="all">all channels</option>' +
    channels
      .map((ch) => {
        var label = ch.twitch || ch.kick || ch.id || ''
        return `<option value="${escapeHtml(ch.id)}">${escapeHtml(label)}</option>`
      })
      .join('')
  return (
    '<div class="hs-mc-setting-row hs-mc-setting-row-block hs-mc-fr-addform" style="padding:4px 4px 6px">' +
    '<div style="font-size:13px;color:#808080;margin-bottom:4px">add rule</div>' +
    '<div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center">' +
    '<select data-fr-field="type" style="' +
    FR_SEL +
    ';width:60px">' +
    '<option value="keyword">keyword</option>' +
    '<option value="regex">regex</option>' +
    '<option value="user">user</option>' +
    '<option value="badge">badge</option>' +
    '<option value="msgtype">msgtype</option>' +
    '<option value="expr">expr</option>' +
    '</select>' +
    '<input type="text" data-fr-field="value" placeholder="value..." style="' +
    FR_INPUT +
    '">' +
    '<select data-fr-field="action" style="' +
    FR_SEL +
    ';width:68px">' +
    '<option value="highlight">highlight</option>' +
    '<option value="hide">hide</option>' +
    '</select>' +
    '<input type="color" data-fr-field="color" value="#ffff00" style="width:28px;height:22px;border:1px solid #808080;background:#000;padding:1px;cursor:pointer;flex-shrink:0" title="highlight color">' +
    '<select data-fr-field="sound" style="' +
    FR_SEL +
    ';width:62px" title="highlight sound (highlight action only)">' +
    '<option value="none">silent</option>' +
    '<option value="ping">ping</option>' +
    '<option value="blip">blip</option>' +
    '<option value="knock">knock</option>' +
    '<option value="chime">chime</option>' +
    '</select>' +
    '<label style="display:flex;align-items:center;gap:2px;color:#808080;font-size:13px;cursor:pointer;flex-shrink:0" title="case-sensitive match">' +
    '<input type="checkbox" data-fr-field="cs" style="margin:0;cursor:pointer">Aa</label>' +
    '<select data-fr-field="scope" style="' +
    FR_SEL +
    ';max-width:80px">' +
    chOptions +
    '</select>' +
    '<button data-fr-action="add" style="' +
    FR_BTN +
    ';background:#222">+ add</button>' +
    '</div>' +
    '<div style="font-size:13px;color:#808080;margin-top:4px;line-height:1.4">' +
    'expr: compose with &amp;&amp; || ! and ( ). fields user: badge: type: contains: regex: · flags first action reply cheer · bits&gt;100. ' +
    'e.g. <code style="color:#808080">first &amp;&amp; !badge:subscriber</code>' +
    '</div>' +
    '</div>'
  )
}

function _renderFilterRulesGroup() {
  var fold = _setCollapsed.has('filters|rules')
  var rules = _getRawFilterRules()
  var ruleRows =
    rules.length === 0
      ? '<div class="hs-mc-setting-row" style="color:#808080;font-size:13px">no rules — add one below</div>'
      : rules.map(_renderFilterRuleRow).join('')
  return (
    '<div class="hs-mc-settings-group">' +
    '<div class="hs-mc-settings-group-title" data-set-fold="rules">' +
    (fold ? '▸ ' : '▾ ') +
    'filter rules' +
    (rules.length ? ` <span class="hs-mc-set-cnt">(${rules.length})</span>` : '') +
    '</div>' +
    (fold ? '' : ruleRows + _renderFilterRuleAddForm()) +
    '</div>'
  )
}

function _handleFilterRuleAction(el, _panelRoot) {
  var action = el.dataset.frAction
  var id = el.dataset.frId
  var rules = _getRawFilterRules()

  if (action === 'toggle' && id) {
    var toggleRule = rules.find((r) => String(r.id) === id)
    if (toggleRule) {
      toggleRule.enabled = !toggleRule.enabled
      _saveFilterRules(rules)
    }
    return
  }

  if (action === 'delete' && id) {
    var delIdx = rules.findIndex((r) => String(r.id) === id)
    if (delIdx !== -1) {
      rules.splice(delIdx, 1)
      _saveFilterRules(rules)
    }
    return
  }

  if ((action === 'up' || action === 'down') && id) {
    // Reorder = priority. evaluateFilterRules is first-match-wins (hide
    // short-circuits; first highlight's color+sound win), so moving a rule up
    // makes it take precedence.
    var mvIdx = rules.findIndex((r) => String(r.id) === id)
    if (mvIdx === -1) return
    var swapIdx = action === 'up' ? mvIdx - 1 : mvIdx + 1
    if (swapIdx < 0 || swapIdx >= rules.length) return
    var tmp = rules[mvIdx]
    rules[mvIdx] = rules[swapIdx]
    rules[swapIdx] = tmp
    _saveFilterRules(rules)
    return
  }

  if (action === 'add') {
    var form = el.closest('.hs-mc-fr-addform')
    if (!form) return
    var typeEl = form.querySelector('[data-fr-field="type"]')
    var valEl = form.querySelector('[data-fr-field="value"]')
    var actEl = form.querySelector('[data-fr-field="action"]')
    var colEl = form.querySelector('[data-fr-field="color"]')
    var soundEl = form.querySelector('[data-fr-field="sound"]')
    var csEl = form.querySelector('[data-fr-field="cs"]')
    var scopeEl = form.querySelector('[data-fr-field="scope"]')
    var ruleType = typeEl ? typeEl.value : 'keyword'
    var ruleVal = valEl ? valEl.value.trim() : ''
    var ruleAct = actEl ? actEl.value : 'highlight'
    var ruleCol = colEl ? colEl.value : '#ffff00'
    var ruleSound = soundEl ? soundEl.value : 'none'
    var ruleCs = csEl ? !!csEl.checked : false
    var ruleScope = scopeEl ? scopeEl.value : 'all'
    if (!ruleVal) {
      showToast(t('mc_settingsui_rule_value_empty'), 'error')
      return
    }
    // Validate expr syntax up front so a malformed rule toasts instead of
    // silently compiling to nothing (the parser lives in the same bundle).
    if (ruleType === 'expr' && typeof _frParseExpr === 'function' && !_frParseExpr(_frTokenizeExpr(ruleVal))) {
      showToast(t('mc_settingsui_invalid_expression'), 'error')
      return
    }
    var newRule = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      enabled: true,
      scope: ruleScope,
      match: { type: ruleType, value: ruleVal, caseSensitive: ruleCs },
      action: ruleAct,
    }
    if (ruleAct === 'highlight') {
      newRule.color = ruleCol
      if (ruleSound && ruleSound !== 'none') newRule.sound = ruleSound
    }
    rules.push(newRule)
    _saveFilterRules(rules)
    return
  }
}

// Compose one category pane: registry sections + that category's islands.
// Per-page reset — mirrors the site's per-section-header `default` button so
// one click restores THIS page's registry settings without touching the rest.
// (System keeps the all-settings button in _SET_ACTION_ROWS; this one is
// page-scoped.)
function _renderPageDefaultsRow(cat) {
  return (
    '<div class="hs-mc-setting-row" style="justify-content:flex-end;padding-top:6px">' +
    '<button class="hs-mc-pagedefaults-btn" data-set-cat="' +
    escapeHtml(cat) +
    '" title="reset this page to defaults" style="background:#000;color:#fff;border:1px solid #808080;padding:2px 10px;font-size:13px;cursor:pointer;font-family:inherit">default</button>' +
    '</div>'
  )
}

// Basic view must never look like the whole product — a pane that quietly
// drops two-thirds of its rows reads as "that setting is gone". Say what's
// hidden and where it went, every pane, every time.
function _basicHint(cat) {
  if (_setShowAll) return ''
  var hidden = SETTINGS.filter((d) => d.category === cat && !d.basic && _depSatisfied(d)).length
  if (!hidden) return ''
  return (
    '<div class="hs-mc-set-keyhint" data-set-scope-hint="1">' +
    hidden +
    ' more setting' +
    (hidden === 1 ? '' : 's') +
    ' here — <button class="hs-mc-set-scope-btn hs-mc-set-scope-inline">show all</button></div>'
  )
}

function _renderCategoryPane(cat) {
  return _renderCategoryPaneInner(cat) + _basicHint(cat)
}

function _renderCategoryPaneInner(cat) {
  if (cat === 'mod') return _renderPageDefaultsRow(cat) + _regSections(cat)
  if (cat === 'filters') {
    // 'rules' section is custom-rendered; exclude it from auto-sections
    return _renderPageDefaultsRow(cat) + _regSections(cat, ['content', 'messages']) + _renderFilterRulesGroup()
  }
  if (cat === 'tweaks') {
    return (
      _renderPageDefaultsRow(cat) +
      '<div class="hs-mc-set-keyhint" style="padding-top:8px">twitch.tv only — kick/youtube unaffected</div>' +
      _regSections(cat)
    )
  }
  if (cat === 'system') {
    // crash log block nests inside the advanced section, after its pill
    var adv = _regSections(cat, ['advanced'])
    var advFolded = _setCollapsed.has(`${cat}|advanced`)
    if (!advFolded && adv.endsWith('</div>')) {
      adv = `${adv.slice(0, -6) + _renderCrashLogBlock()}</div>`
    }
    return _regSections(cat, ['tabs', 'subsystems', 'language']) + _renderMutedGroup() + adv + _renderBackupGroup()
  }
  return _renderPageDefaultsRow(cat) + _regSections(cat)
}

// ─── settings export / import ────────────────────────────────────────────
// Export: dumps ui_settings (sync) + all hs_*/viewer_* keys and registry
// local-mirror keys (local) into a single JSON. Import: file picker → JSON parse → schema-validate → merge into
// storage. Both areas restored. Errors toast, don't throw.
// Private stores that must NEVER ride an export (the preset panel calls
// exports "sharable"): mention/chat buffers, per-user notes, whispers, crash
// ring ("captured locally only"). Import skips the same set so a crafted file
// can't overwrite them either.
var _SETTINGS_PRIVATE_KEY_RE = /^hs_(mentions_v2|user_notes|errors|irc_|kick_|yt_|whisper)/
// local-mirror settings (keyword highlights, filter rules) live under
// unprefixed mirror keys — allowlist them alongside the hs_/viewer_ namespaces
// or the export silently drops them (derived from the registry, never hand-listed)
var _SETTINGS_MIRROR_KEYS = new Set(SETTINGS.filter((d) => d.mirrorKey).map((d) => d.mirrorKey))
async function _exportAllSettings() {
  try {
    var syncObj = await chrome.storage.sync.get(null)
    var localObj = await chrome.storage.local.get(null)
    var hsLocal = {}
    Object.keys(localObj).forEach((k) => {
      if (k.indexOf('hs_') !== 0 && k.indexOf('viewer_') !== 0 && !_SETTINGS_MIRROR_KEYS.has(k)) return
      if (_SETTINGS_PRIVATE_KEY_RE.test(k)) return
      hsLocal[k] = localObj[k]
    })
    var bundle = {
      kind: 'heatsync-settings',
      version: 1,
      exportedAt: new Date().toISOString(),
      sync: { ui_settings: syncObj.ui_settings || {} },
      local: hsLocal,
    }
    var blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
    var url = URL.createObjectURL(blob)
    var a = document.createElement('a')
    a.href = url
    a.download = `heatsync-settings-${new Date().toISOString().slice(0, 10)}.json`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => {
      URL.revokeObjectURL(url)
    }, 1000)
    showToast(t('mc_settingsui_export_ok'), 'info')
  } catch (err) {
    showToast(t('mc_settingsui_export_failed', [err?.message ? err.message : t('mc_common_unknown')]), 'error')
  }
}

async function _importAllSettings() {
  return new Promise((resolve) => {
    var input = document.createElement('input')
    input.type = 'file'
    input.accept = 'application/json,.json'
    input.style.display = 'none'
    input.onchange = async () => {
      var file = input.files?.[0]
      input.remove()
      if (!file) {
        resolve(false)
        return
      }
      if (file.size > 2 * 1024 * 1024) {
        showToast(t('mc_settingsui_file_too_large'), 'error')
        resolve(false)
        return
      }
      try {
        var txt = await file.text()
        var data = JSON.parse(txt)
        if (data?.kind !== 'heatsync-settings') {
          showToast(t('mc_settingsui_not_heatsync_file'), 'error')
          resolve(false)
          return
        }
        var writes = []
        if (data.sync?.ui_settings && typeof data.sync.ui_settings === 'object') {
          // Merge — preserve any keys absent from the import. The SW's serialized
          // rmw chain owns the write (and sanitizes it, so corrupt fields don't
          // leak in); a local get→merge→set would race concurrent writes.
          writes.push(
            writeUiSettings(data.sync.ui_settings).then((ok) => {
              if (!ok) throw new Error('ui_settings write failed')
            }),
          )
        }
        if (data.local && typeof data.local === 'object') {
          var safeLocal = {}
          Object.keys(data.local).forEach((k) => {
            if (k.length < 1 || k.length > 128) return
            if (k.indexOf('hs_') !== 0 && k.indexOf('viewer_') !== 0 && !_SETTINGS_MIRROR_KEYS.has(k)) return
            if (_SETTINGS_PRIVATE_KEY_RE.test(k)) return
            safeLocal[k] = data.local[k]
          })
          if (Object.keys(safeLocal).length) writes.push(chrome.storage.local.set(safeLocal))
        }
        await Promise.all(writes)
        showToast(t('mc_settingsui_import_ok'), 'info')
        setTimeout(() => {
          try {
            location.reload()
          } catch (_) {}
        }, 800)
        resolve(true)
      } catch (err) {
        showToast(
          t('mc_settingsui_import_failed', [err?.message ? err.message : t('mc_settingsui_parse_error')]),
          'error',
        )
        resolve(false)
      }
    }
    document.body.appendChild(input)
    input.click()
  })
}

// _loadServerFilters removed in v1.6 audit pass — fetched /api/user/settings
// expecting a JSONB `settings` blob that the server never produced. The
// 11 toggles it populated were unwired (server didn't read those keys),
// so removing it has no functional change. See _SERVER_FILTER_DEFS deletion.

// Load recent errors + diag snapshot into the system sub-tab pre element.
// Reads hs_errors directly (single source of truth — written by lib/error-reporter).
async function _loadCrashLog() {
  var pre = document.getElementById('hs-set-crash-pre')
  if (!pre) return
  try {
    var cur = await new Promise((r) => {
      chrome.storage.local.get('hs_errors', r)
    })
    var log = Array.isArray(cur?.hs_errors) ? cur.hs_errors : []
    var diag = null
    try {
      diag = (await chrome.runtime.sendMessage({ type: 'get_diag' }))?.diag || null
    } catch (_) {}
    function fmtTs(ts) {
      var d = new Date(ts)
      return d.toISOString().replace('T', ' ').slice(0, 19)
    }
    var head = diag ? `--- diag ---\n${JSON.stringify(diag, null, 2)}\n\n` : ''
    if (log.length === 0) {
      pre.textContent = `${head}(no errors recorded)`
      return
    }
    pre.textContent =
      head +
      log
        .slice()
        .reverse()
        .map(
          (entry) =>
            '[' +
            fmtTs(entry.ts) +
            '] ' +
            (entry.plat || entry.type || '?') +
            ': ' +
            (entry.msg || '') +
            '\n' +
            (entry.stack || '') +
            '\n',
        )
        .join('\n')
  } catch (_) {
    pre.textContent = '(unable to read log)'
  }
}

// ─── presets ("builds") — sparse diffs over defaults ─────────────────
// Built-ins live in settings-schema.js (SETTINGS_PRESETS); customs are
// diff-vs-defaults snapshots in ui_settings.customPresets (synced, and
// sharable via the existing settings export/import). Applying always
// goes through a diff-confirm panel; one-shot undo restores the prior
// values of exactly the keys the preset touched.
let _customPresets = []
let _lastPresetUndo = null
let _presetPending = null // {label, diff} or {savePrompt:true}

function _presetIsActive(p) {
  return Object.keys(p.diff).every((k) => JSON.stringify(getSetting(k)) === JSON.stringify(p.diff[k]))
}
function _presetChanges(diff) {
  const out = []
  for (const k in diff) {
    const def = _SETTINGS_BY_KEY.get(k)
    if (!def) continue
    const from = getSetting(k)
    if (JSON.stringify(from) !== JSON.stringify(diff[k])) out.push({ key: k, def: def, from: from, to: diff[k] })
  }
  return out
}
function _fmtPresetVal(def, v) {
  if (def.type === 'bool') return v ? 'on' : 'off'
  if (def.type === 'boolmap') {
    const offs = Object.keys(v).filter((k) => v[k] === false)
    return offs.length ? `off: ${offs.join(', ')}` : 'all on'
  }
  if (def.type === 'multiselect') return v.length ? v.join(', ') : 'none'
  return String(v)
}
function _applyPresetDiff(label, diff) {
  const changes = _presetChanges(diff)
  _presetPending = null
  if (!changes.length) {
    showToast(t('mc_settingsui_preset_already_matching', [label]), 'info')
    renderSettingsTab()
    return
  }
  const undo = {}
  for (const c of changes) undo[c.key] = c.from
  _lastPresetUndo = { label: label, diff: undo }
  for (const c of changes) setSetting(c.key, c.to)
  const changeCount = `${changes.length} change${changes.length === 1 ? '' : 's'}`
  showToast(t('mc_settingsui_preset_applied', [label, changeCount]), 'info')
  renderSettingsTab()
}
function _saveCustomPreset(name) {
  name = (name || '').trim().slice(0, 24)
  if (!name) {
    showToast(t('mc_settingsui_preset_needs_name'), 'error')
    return
  }
  const diff = {}
  for (const def of SETTINGS) {
    if (def.noReset) continue
    const cur = getSetting(def.key)
    if (JSON.stringify(cur) !== JSON.stringify(def.default)) diff[def.key] = cur
  }
  const entry = { id: `c_${Date.now().toString(36)}`, name: name, diff: diff, createdAt: Date.now() }
  const next = _customPresets
    .filter((p) => p.name !== name)
    .concat(entry)
    .slice(-8)
  if (JSON.stringify(next).length > 5000) {
    showToast(t('mc_settingsui_presets_storage_full'), 'error')
    return
  }
  _customPresets = next
  saveUiSetting('customPresets', next)
  _presetPending = null
  showToast(t('mc_settingsui_preset_saved', [name]), 'info')
  renderSettingsTab()
}
function _deleteCustomPreset(id) {
  _customPresets = _customPresets.filter((p) => p.id !== id)
  saveUiSetting('customPresets', _customPresets)
  showToast(t('mc_settingsui_preset_deleted'), 'info')
}
function _openPresetMenu(anchorEl) {
  const r = anchorEl.getBoundingClientRect()
  const items = []
  for (const p of SETTINGS_PRESETS) {
    const pLabel = p.labelKey ? t(p.labelKey) : p.label
    items.push({
      label: (_presetIsActive(p) ? '■ ' : '□ ') + pLabel,
      fn: ((preset, lbl) => () => {
        _presetPending = { label: lbl, diff: preset.diff }
        renderSettingsTab()
      })(p, pLabel),
    })
  }
  if (_customPresets.length) {
    items.push('sep')
    for (const p of _customPresets) {
      items.push({
        label: (_presetIsActive(p) ? '■ ' : '□ ') + p.name,
        fn: ((preset) => () => {
          _presetPending = { label: preset.name, diff: preset.diff }
          renderSettingsTab()
        })(p),
      })
    }
    items.push({
      label: 'delete a preset…',
      danger: true,
      fn: () => {
        const delItems = _customPresets.map((p) => ({
          label: `✕ ${p.name}`,
          danger: true,
          fn: () => {
            _deleteCustomPreset(p.id)
          },
        }))
        showHsCtxMenu(r.left, r.bottom + 4, 'delete preset', delItems)
      },
    })
  }
  items.push('sep')
  items.push({
    label: 'save current as…',
    fn: () => {
      _presetPending = { savePrompt: true }
      renderSettingsTab()
    },
  })
  if (_lastPresetUndo) {
    items.push({
      label: `undo: ${_lastPresetUndo.label}`,
      fn: () => {
        const u = _lastPresetUndo
        _lastPresetUndo = null
        _applyPresetDiff(`undo ${u.label}`, u.diff)
      },
    })
  }
  showHsCtxMenu(r.left, r.bottom + 4, 'presets', items)
}
function _renderPresetPanel() {
  if (_presetPending.savePrompt) {
    return (
      '<div class="hs-mc-settings-group">' +
      '<div class="hs-mc-settings-group-title">save current as preset</div>' +
      '<div class="hs-mc-setting-row hs-mc-setting-row-split">' +
      '<input class="hs-mc-set-text-input" id="hs-preset-name" type="text" placeholder="preset name" maxlength="24" style="flex:1">' +
      '<div style="display:flex;gap:4px">' +
      '<button class="hs-mc-settings-btn" data-preset-action="save-custom" style="background:#000;color:#fff;border:1px solid #808080;padding:2px 10px;font-size:13px;cursor:pointer;font-family:inherit">save</button>' +
      '<button class="hs-mc-settings-btn" data-preset-action="cancel" style="background:#000;color:#fff;border:1px solid #808080;padding:2px 10px;font-size:13px;cursor:pointer;font-family:inherit">cancel</button>' +
      '</div>' +
      '</div>' +
      '<div class="hs-mc-set-keyhint">snapshots every setting that differs from defaults — sharable via export settings</div>' +
      '</div>'
    )
  }
  const changes = _presetChanges(_presetPending.diff)
  let rows = ''
  if (!changes.length) {
    rows = '<div class="hs-mc-setting-row" style="color:#808080">already matching — nothing to change</div>'
  }
  for (const c of changes) {
    rows +=
      '<div class="hs-mc-setting-row hs-mc-setting-row-split">' +
      '<span class="hs-mc-setting-label">' +
      escapeHtml(_setLabel(c.def)) +
      '</span>' +
      '<span style="font-size:13px;flex-shrink:0"><span style="color:#808080">' +
      escapeHtml(_fmtPresetVal(c.def, c.from)) +
      '</span>' +
      ' → <span style="color:#fff">' +
      escapeHtml(_fmtPresetVal(c.def, c.to)) +
      '</span></span>' +
      '</div>'
  }
  return (
    '<div class="hs-mc-settings-group">' +
    '<div class="hs-mc-settings-group-title">apply preset: ' +
    escapeHtml(_presetPending.label) +
    '</div>' +
    rows +
    '<div class="hs-mc-setting-row" style="justify-content:flex-end;gap:4px">' +
    (changes.length
      ? '<button class="hs-mc-settings-btn" data-preset-action="apply" style="background:#fff;color:#000;border:none;padding:2px 12px;font-size:13px;cursor:pointer;font-family:inherit">apply</button>'
      : '') +
    '<button class="hs-mc-settings-btn" data-preset-action="cancel" style="background:#000;color:#fff;border:1px solid #808080;padding:2px 10px;font-size:13px;cursor:pointer;font-family:inherit">cancel</button>' +
    '</div>' +
    '</div>'
  )
}

// '?' keybinding overlay — square, two-column key grid; vim block only
// when vi mode is on. Click anywhere on it (or Esc / ?) closes.
function _renderHelpOverlay() {
  var always = [
    ['/', 'search'],
    ['1-7', 'category'],
    ['↑ ↓', 'move'],
    ['← →', 'adjust'],
    ['enter', 'toggle'],
    ['bksp', 'reset row'],
    ['esc', 'close / clear'],
    ['?', 'this help'],
  ]
  var vim = [
    ['j k', 'move'],
    ['h l', 'adjust'],
    ['gg G', 'first / last'],
    ['za', 'fold section'],
    ['d', 'reset row'],
    ['p', 'presets'],
    ['H L', 'prev / next category'],
  ]
  function grid(pairs) {
    return pairs
      .map((kv) => `<span class="hs-mc-set-help-key">${escapeHtml(kv[0])}</span><span>${escapeHtml(kv[1])}</span>`)
      .join('')
  }
  return (
    '<div class="hs-mc-set-help">' +
    '<div class="hs-mc-set-help-grid">' +
    grid(always) +
    '</div>' +
    (viModeEnabled
      ? `<div class="hs-mc-set-help-title">vi</div><div class="hs-mc-set-help-grid">${grid(vim)}</div>`
      : '') +
    '</div>'
  )
}

// ─── settings keyboard nav — roving focus, vim-first ────────────────
// One document-level listener (bound once). Bare-letter motions
// (j/k/h/l/g/G/d/z) gate on viModeEnabled; arrows, Enter, /, Esc and
// Backspace always work. Letters typed into the search box stay there.
let _setKeysBound = false
let _setPendingKey = ''
function _setVisibleRows() {
  const msgsEl = document.getElementById('hs-mc-messages')
  return msgsEl ? [...msgsEl.querySelectorAll('[data-set-row]')] : []
}
function _setFocusMove(rows, i) {
  if (!rows.length) return
  const next = Math.max(0, Math.min(rows.length - 1, i))
  rows.forEach((r) => {
    r.classList.remove('hs-mc-set-row-focus')
  })
  rows[next].classList.add('hs-mc-set-row-focus')
  _setFocusRow = rows[next].dataset.setRow
  rows[next].scrollIntoView({ block: 'nearest' })
}
function _setRowDef(row) {
  const key = (row.dataset.setRow || '').split(':')[0]
  return _SETTINGS_BY_KEY.get(key)
}
function _setRowActivate(row) {
  const pill = row.querySelector('button.hs-mc-toggle-pill[data-set-key]')
  if (pill) {
    pill.click()
    return
  }
  const seg = row.querySelector('.hs-mc-size-btn[data-set-key]')
  if (seg) {
    _setRowAdjust(row, 1)
    return
  }
  const ctl = row.querySelector('select[data-set-key], input[data-set-key], textarea[data-set-key]')
  if (ctl) ctl.focus()
}
function _setRowAdjust(row, dir) {
  const def = _setRowDef(row)
  if (!def) return
  if (def.type === 'enum') {
    const i = def.options.findIndex((o) => o.value === getSetting(def.key))
    const o = def.options[(i + dir + def.options.length) % def.options.length]
    setSetting(def.key, o.value)
    renderSettingsTab()
  } else if (def.type === 'range') {
    const v = getSetting(def.key) + dir * def.options.step
    setSetting(def.key, v)
    renderSettingsTab()
  }
}
function _setRowReset(row) {
  const def = _setRowDef(row)
  if (!def || def.noReset) return
  // sub-rows (boolmap/multiselect options) reset exactly that option,
  // not the whole map
  const sub = (row.dataset.setRow || '').split(':')[1]
  if (def.type === 'boolmap' && sub !== undefined) {
    const opt = def.options.find((o) => String(o.value) === sub)
    if (opt) {
      const map = Object.assign({}, getSetting(def.key))
      map[opt.value] = opt.default
      setSetting(def.key, map)
    }
  } else if (def.type === 'multiselect' && sub !== undefined) {
    const cur = getSetting(def.key)
    const inDefault = def.default.includes(sub)
    setSetting(def.key, inDefault ? (cur.includes(sub) ? cur : cur.concat(sub)) : cur.filter((x) => x !== sub))
  } else {
    setSetting(def.key, def.default)
  }
  renderSettingsTab()
}
function _bindSettingsKeyboard() {
  if (_setKeysBound) return
  _setKeysBound = true
  document.addEventListener(
    'keydown',
    (e) => {
      if (currentTab !== 'settings') return
      const msgsEl = document.getElementById('hs-mc-messages')
      if (!msgsEl?.querySelector('.hs-mc-settings-panel')) return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const searchEl = msgsEl.querySelector('input.hs-mc-set-search')
      const t = e.target
      const inSearch = t === searchEl
      const typing = t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))
      const rows = _setVisibleRows()
      const idx = rows.findIndex((r) => r.dataset.setRow === _setFocusRow)

      if (inSearch) {
        if (e.key === 'Escape') {
          e.preventDefault()
          _setQuery = ''
          renderSettingsTab()
        } else if (e.key === 'Enter' || e.key === 'ArrowDown') {
          e.preventDefault()
          searchEl.blur()
          _setFocusMove(rows, 0)
        }
        return // everything else is query text
      }
      if (typing) return // free typing in textareas / inputs / selects

      const vim = viModeEnabled
      const k = e.key
      if (k === '/') {
        e.preventDefault()
        if (searchEl) searchEl.focus()
        return
      }
      if (k === '?') {
        e.preventDefault()
        _setHelpOpen = !_setHelpOpen
        renderSettingsTab()
        return
      }
      if (k === 'Escape') {
        if (_setHelpOpen) {
          _setHelpOpen = false
          renderSettingsTab()
          return
        }
        if (_setQuery) {
          _setQuery = ''
          renderSettingsTab()
          return
        }
        rows.forEach((r) => {
          r.classList.remove('hs-mc-set-row-focus')
        })
        _setFocusRow = null
        return
      }
      // 1-7 jump straight to a category
      if (k.length === 1 && k >= '1' && k <= '7') {
        e.preventDefault()
        _settingsSubtab = _SET_SUBTAB_ORDER[+k - 1]
        _setFocusRow = null
        renderSettingsTab()
        return
      }
      if (k === 'ArrowLeft' && idx >= 0) {
        e.preventDefault()
        _setRowAdjust(rows[idx], -1)
        return
      }
      if (k === 'ArrowRight' && idx >= 0) {
        e.preventDefault()
        _setRowAdjust(rows[idx], 1)
        return
      }
      if (k === 'ArrowDown' || (vim && k === 'j')) {
        e.preventDefault()
        _setFocusMove(rows, idx + 1)
        _setPendingKey = ''
        return
      }
      if (k === 'ArrowUp' || (vim && k === 'k')) {
        e.preventDefault()
        _setFocusMove(rows, idx - 1)
        _setPendingKey = ''
        return
      }
      if ((k === 'Enter' || k === ' ') && idx >= 0) {
        e.preventDefault()
        _setRowActivate(rows[idx])
        return
      }
      if (k === 'Backspace' && idx >= 0) {
        e.preventDefault()
        _setRowReset(rows[idx])
        return
      }
      if (!vim) return
      if (k === 'g') {
        if (_setPendingKey === 'g') {
          _setPendingKey = ''
          e.preventDefault()
          _setFocusMove(rows, 0)
        } else _setPendingKey = 'g'
        return
      }
      if (k === 'G') {
        e.preventDefault()
        _setPendingKey = ''
        _setFocusMove(rows, rows.length - 1)
        return
      }
      if (k === 'h' && idx >= 0) {
        e.preventDefault()
        _setRowAdjust(rows[idx], -1)
        return
      }
      if (k === 'l' && idx >= 0) {
        e.preventDefault()
        _setRowAdjust(rows[idx], 1)
        return
      }
      if (k === 'H' || k === 'L') {
        e.preventDefault()
        const cur = _SET_SUBTAB_ORDER.indexOf(_settingsSubtab)
        const len = _SET_SUBTAB_ORDER.length
        _settingsSubtab = _SET_SUBTAB_ORDER[(cur + (k === 'L' ? 1 : len - 1)) % len]
        _setFocusRow = null
        renderSettingsTab()
        return
      }
      if (k === 'd' && idx >= 0) {
        e.preventDefault()
        _setRowReset(rows[idx])
        return
      }
      if (k === 'p') {
        const btn = msgsEl.querySelector('.hs-mc-set-presets-btn')
        if (btn) {
          e.preventDefault()
          _openPresetMenu(btn)
        }
        return
      }
      if (k === 'z') {
        _setPendingKey = 'z'
        return
      }
      if (k === 'a' && _setPendingKey === 'z') {
        _setPendingKey = ''
        if (idx >= 0) {
          const fold = rows[idx].closest('.hs-mc-settings-group')
          const title = fold?.querySelector('[data-set-fold]')
          if (title) {
            e.preventDefault()
            title.click()
          }
        }
        return
      }
      _setPendingKey = ''
    },
    { signal: mcSignal },
  )
}

function renderSettingsTab() {
  var msgsEl = document.getElementById('hs-mc-messages')
  if (!msgsEl) return

  _clearMessageIndices()

  // Scroll preservation — #hs-mc-messages is the actual scroll parent
  // (the panel grows inside it); keep its scroll across re-renders of
  // the same logical pane (toggle/applier-triggered rebuilds)
  var hadPanel = !!msgsEl.querySelector('.hs-mc-settings-panel')
  var paneCtx = `${_settingsSubtab}|${_setQuery}|${!!_presetPending}`
  // The panel is position:absolute inset:0 and ONLY .hs-mc-set-subtab-body
  // scrolls — #hs-mc-messages itself never does, so preserving its scrollTop was
  // always 0 and every toggle reset the view to the top. Capture the inner body.
  var oldBody = msgsEl.querySelector('.hs-mc-set-subtab-body')
  var keepScroll = hadPanel && paneCtx === _setPaneCtx && oldBody ? oldBody.scrollTop : 0

  var searchActive = _setQueryTokens().length > 0
  var bodyContent
  var countLabel = ''
  if (_presetPending) {
    bodyContent = _renderPresetPanel()
  } else if (searchActive) {
    var res = _renderSearchResults()
    bodyContent = res.html
    countLabel = `${res.count}/${res.total}`
  } else {
    bodyContent = _renderCategoryPane(_settingsSubtab)
  }

  // All values in the template are from module state or escapeHtml'd -- no raw user input
  msgsEl.innerHTML =
    '<div class="hs-mc-settings-panel">' +
    _renderSetSubtabBar() +
    '<div class="hs-mc-set-searchbar">' +
    '<input class="hs-mc-set-search" type="search" placeholder="/ search settings..." value="' +
    escapeHtml(_setQuery) +
    '">' +
    '<span class="hs-mc-set-search-count">' +
    countLabel +
    '</span>' +
    '<button class="hs-mc-set-scope-btn" title="' +
    (_setShowAll
      ? 'showing every setting — click for the basics only'
      : 'showing the basics — click for every setting') +
    '">' +
    (_setShowAll ? 'all' : 'basic') +
    '</button>' +
    '<button class="hs-mc-set-presets-btn">presets</button>' +
    '<button class="hs-mc-set-help-btn" title="keybindings">?</button>' +
    '</div>' +
    '<div class="hs-mc-set-subtab-body">' +
    bodyContent +
    '</div>' +
    (_setHelpOpen ? _renderHelpOverlay() : '') +
    '</div>'

  // Controls render with live values inline (getSetting); only the crash
  // log pre needs an async fill, and keyboard focus needs restoring.
  if (_settingsSubtab === 'system' && !searchActive && getSetting('crashTelemetry')) _loadCrashLog()
  if (_setFocusRow) {
    var fr = msgsEl.querySelector(`[data-set-row="${CSS.escape(_setFocusRow)}"]`)
    if (fr) fr.classList.add('hs-mc-set-row-focus')
    else _setFocusRow = null
  }
  _setPaneCtx = paneCtx
  // Restore onto the freshly-rebuilt inner body (innerHTML replaced the old one).
  if (keepScroll) {
    var newBody = msgsEl.querySelector('.hs-mc-set-subtab-body')
    if (newBody) newBody.scrollTop = keepScroll
  }

  // Wire up toggles via event delegation
  if (msgsEl._hsSettingsClick) msgsEl.removeEventListener('click', msgsEl._hsSettingsClick)
  msgsEl._hsSettingsClick = function settingsClick(e) {
    // Sub-tab navigation
    var subtabBtn = e.target.closest('.hs-mc-set-subtab[data-set-subtab]')
    if (subtabBtn) {
      var next = subtabBtn.dataset.setSubtab
      if (next && next !== _settingsSubtab) {
        _settingsSubtab = next
        renderSettingsTab()
      }
      return
    }

    // Settings export / import buttons
    var settingsActionBtn = e.target.closest('.hs-mc-settings-btn[data-action]')
    if (settingsActionBtn) {
      var action = settingsActionBtn.dataset.action
      if (action === 'export-settings') {
        _exportAllSettings()
      } else if (action === 'import-settings') {
        _importAllSettings()
      }
      return
    }

    // '?' help — button toggles, clicking the overlay closes
    if (e.target.closest('.hs-mc-set-help-btn')) {
      _setHelpOpen = !_setHelpOpen
      renderSettingsTab()
      return
    }
    if (e.target.closest('.hs-mc-set-help')) {
      _setHelpOpen = false
      renderSettingsTab()
      return
    }

    // [reload] chip — value differs from the boot snapshot; apply it now
    if (e.target.closest('[data-set-reload]')) {
      location.reload()
      return
    }

    // search result header — jump to that category + section
    var jumpHdr = e.target.closest('[data-set-jump]')
    if (jumpHdr) {
      var jump = jumpHdr.dataset.setJump.split('|')
      _settingsSubtab = jump[0]
      _setQuery = ''
      _setFocusRow = null
      renderSettingsTab()
      var tgt = [...msgsEl.querySelectorAll('[data-set-fold]')].find((el2) => el2.dataset.setFold === jump[1])
      if (tgt) tgt.scrollIntoView({ block: 'start' })
      return
    }

    // basic ⇄ all
    var scopeBtn = e.target.closest('.hs-mc-set-scope-btn')
    if (scopeBtn) {
      _setShowAll = !_setShowAll
      _saveShowAll()
      renderSettingsTab()
      return
    }

    // Presets dropdown + diff-confirm actions
    var presetsBtn = e.target.closest('.hs-mc-set-presets-btn')
    if (presetsBtn) {
      _openPresetMenu(presetsBtn)
      return
    }
    var presetAction = e.target.closest('[data-preset-action]')
    if (presetAction) {
      var pAct = presetAction.dataset.presetAction
      if (pAct === 'apply' && _presetPending) _applyPresetDiff(_presetPending.label, _presetPending.diff)
      else if (pAct === 'save-custom') _saveCustomPreset(msgsEl.querySelector('#hs-preset-name')?.value)
      else if (pAct === 'cancel') {
        _presetPending = null
        renderSettingsTab()
      }
      return
    }

    // Section fold/unfold
    var foldTitle = e.target.closest('.hs-mc-settings-group-title[data-set-fold]')
    if (foldTitle) {
      var foldId = `${_settingsSubtab}|${foldTitle.dataset.setFold}`
      if (_setCollapsed.has(foldId)) _setCollapsed.delete(foldId)
      else _setCollapsed.add(foldId)
      _saveCollapsedSections()
      renderSettingsTab()
      return
    }

    // Filter rule actions (toggle/delete/add) — data-fr-action
    var frEl = e.target.closest('[data-fr-action]')
    if (frEl && !/^(SELECT|INPUT|TEXTAREA)$/.test(frEl.tagName)) {
      _handleFilterRuleAction(frEl, msgsEl)
      return
    }

    // Registry controls — data-set-key (registry-rendered) covers every
    // pill, size button, and multiselect chip; selects/inputs/textareas
    // are handled by the change/input listeners below.
    var regCtl = e.target.closest('[data-set-key]')
    if (regCtl && !/^(SELECT|INPUT|TEXTAREA)$/.test(regCtl.tagName)) {
      handleRegistryControl(regCtl)
      return
    }

    var unmuteBtn = e.target.closest('.hs-mc-unmute-btn[data-username]')
    if (unmuteBtn) {
      var username = unmuteBtn.dataset.username
      if (username) {
        // data-username stores the full namespaced key (e.g. twitch:alice); also
        // clear legacy bare form so old storage entries don't linger.
        var unmuteBare = username.includes(':') ? username.split(':')[1] : username
        mutedUsers.delete(username)
        if (unmuteBare !== username) mutedUsers.delete(unmuteBare)
        safeSendMessage({ type: 'unmute_user', username: username })
        restoreMcUnmutedDom(unmuteBare)
        renderMessages(currentTab)
        renderSettingsTab()
      }
      return
    }

    // Crash log buttons
    if (e.target.id === 'hs-set-crash-copy') {
      var pre = document.getElementById('hs-set-crash-pre')
      if (pre?.textContent) {
        var copyBtn = e.target
        navigator.clipboard.writeText(pre.textContent).then(
          () => {
            copyBtn.textContent = 'copied'
          },
          () => {
            copyBtn.textContent = 'copy failed'
          },
        )
        cleanup.setTimeout(() => {
          copyBtn.textContent = 'copy'
        }, 1500)
      }
      return
    }
    if (e.target.id === 'hs-set-crash-clear') {
      chrome.storage.local.remove('hs_errors', () => {
        void chrome.runtime.lastError
      })
      _loadCrashLog()
      return
    }

    var defaultsBtn = e.target.closest('.hs-mc-defaults-btn')
    if (defaultsBtn) {
      resetSettingsToDefaults()
      if (typeof showToast === 'function') showToast(t('mc_settingsui_reset_all'), 'success')
      return
    }
    var pageDefaultsBtn = e.target.closest('.hs-mc-pagedefaults-btn')
    if (pageDefaultsBtn) {
      var _pdCat = pageDefaultsBtn.dataset.setCat
      resetSettingsToDefaults(_pdCat)
      if (typeof showToast === 'function') showToast(t('mc_settingsui_reset_category', [_pdCat]), 'success')
      return
    }
  }
  msgsEl.addEventListener('click', msgsEl._hsSettingsClick)

  // Input handler — search box, registry text/textarea (debounced) + range
  if (msgsEl._hsSettingsInput) msgsEl.removeEventListener('input', msgsEl._hsSettingsInput)
  var _setInputDebounce = {}
  var _setSearchDebounce = null
  msgsEl._hsSettingsInput = function settingsInput(e) {
    var search = e.target.closest('input.hs-mc-set-search')
    if (search) {
      if (_setSearchDebounce) cleanup.clearTimeout(_setSearchDebounce)
      _setSearchDebounce = cleanup.setTimeout(() => {
        _setQuery = search.value
        renderSettingsTab()
        // re-render replaced the input — restore focus + caret
        var fresh = msgsEl.querySelector('input.hs-mc-set-search')
        if (fresh) {
          fresh.focus()
          fresh.setSelectionRange(fresh.value.length, fresh.value.length)
        }
      }, 150)
      return
    }
    var regInput = e.target.closest('[data-set-key]')
    if (regInput) {
      var def = _SETTINGS_BY_KEY.get(regInput.dataset.setKey)
      if (!def) return
      if (def.type === 'range') {
        var scale = def.displayScale || 1
        setSetting(def.key, parseFloat(regInput.value) / scale)
        var valEl = regInput.parentElement.querySelector('.hs-mc-set-range-val')
        if (valEl) valEl.textContent = regInput.value
        _syncRowModEdge(regInput, def)
        return
      }
      if (def.type === 'text') {
        if (_setInputDebounce[def.key]) cleanup.clearTimeout(_setInputDebounce[def.key])
        _setInputDebounce[def.key] = cleanup.setTimeout(() => {
          setSetting(def.key, regInput.value)
          _syncRowModEdge(regInput, def)
        }, 400)
        return
      }
    }
  }
  msgsEl.addEventListener('input', msgsEl._hsSettingsInput)

  // Change handler — registry selects
  if (msgsEl._hsSettingsChange) msgsEl.removeEventListener('change', msgsEl._hsSettingsChange)
  msgsEl._hsSettingsChange = function settingsChange(e) {
    var regSel = e.target.closest('select[data-set-key]')
    if (regSel) {
      var selKey = regSel.dataset.setKey
      if (selKey === 'fontFamily') {
        // Bitmap fonts render crisp at their native size only — snap the
        // size to the font's design size. silent: the fontFamily write
        // below runs the (shared) fonts applier once with both values.
        var fam = regSel.value
        // Keep the size when the new family HAS it, snap when it does not.
        // This used to force 13 for CozetteVector *and* for 'twitch' — Inter,
        // a vector face with no grid at all — while never snapping to 26, so a
        // 2x user lost it on any family toggle. One rule, from font-grid.js.
        var snapped = snapSize(fam, getSetting('fontSize'))
        if (snapped !== getSetting('fontSize')) setSetting('fontSize', snapped, { silent: true })
        setSetting('fontFamily', fam) // fonts applier + settings re-render
        return
      }
      setSetting(selKey, regSel.value)
      return
    }
  }
  msgsEl.addEventListener('change', msgsEl._hsSettingsChange)

  _bindSettingsKeyboard()

  // Custom tooltip for settings labels (native title attribute blocked in content scripts)
  var tip = document.getElementById('hs-settings-tip')
  if (!tip) {
    tip = document.createElement('div')
    tip.id = 'hs-settings-tip'
    document.body.appendChild(cleanup.trackNode(tip))
  }
  if (!msgsEl._hsSettingsTipBound) {
    msgsEl._hsSettingsTipBound = true
    msgsEl.addEventListener(
      'mouseenter',
      (e) => {
        var label = e.target.closest('.hs-mc-setting-label[data-tip]')
        if (!label) return
        var tipEl = document.getElementById('hs-settings-tip')
        if (!tipEl) return
        tipEl.textContent = label.dataset.tip
        var rect = label.getBoundingClientRect()
        tipEl.style.left = `${rect.left}px`
        tipEl.style.top = `${rect.bottom + 4}px`
        tipEl.classList.add('visible')
      },
      { capture: true, signal: mcSignal },
    )
    msgsEl.addEventListener(
      'mouseleave',
      (e) => {
        var label = e.target.closest('.hs-mc-setting-label[data-tip]')
        if (label) {
          var tipEl = document.getElementById('hs-settings-tip')
          if (tipEl) tipEl.classList.remove('visible')
        }
      },
      { capture: true, signal: mcSignal },
    )
  }
}
