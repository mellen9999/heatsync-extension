// settings tab UI — split out of main.js (2026-07-04).
// Sub-tab bar, search/filter rows, category panes, help overlay,
// backup block, and the settings-tab-only keyboard nav. The settings
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
  help: '<span style="font-size:16px;line-height:1">?</span>',
  filters:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 4h12M4 8h8M6 12h4"/></svg>',
  system:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="2.5"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.42 1.42M11.53 11.53l1.42 1.42M3.05 12.95l1.42-1.42M11.53 4.47l1.42-1.42"/></svg>',
}
// One list: the registry's settings cells (tab-registry.js), `help` last.
const _SET_SUBTAB_ORDER = mcSubCells('settings').map((c) => c.id)
let _setHelpFrom = 'display' // cell Esc returns to from help

// Land on a settings cell. True when it changed; remembers where help was
// opened from.
function _setSettingsSubtab(id) {
  if (id === 'help' && _settingsSubtab !== 'help') _setHelpFrom = _settingsSubtab
  const changed = id !== _settingsSubtab
  _settingsSubtab = id
  return changed
}

// Every way of changing cell goes through switchTab, like any other tab's.
function _gotoSetSubtab(id) {
  if (typeof switchTab === 'function') switchTab('settings', id)
  else if (_setSettingsSubtab(id)) renderSettingsTab()
}

// display name of a settings category (the id stays the machine key)
function _setCatLabel(id) {
  const c = mcSubCells('settings').find((x) => x.id === id)
  return c?.labelKey ? t(c.labelKey) : id
}
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
          escapeHtml(_setCatLabel(id)) +
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
// muted users, backup, defaults).

let _setQuery = ''
const _setCollapsed = new Set() // '<category>|<section title>'
let _setFocusRow = null // data-set-row id of keyboard focus
let _setPaneCtx = '' // pane identity for scroll preservation
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

// Is the row shown at all? Only on the sites it affects, and only while the
// setting it depends on allows it.
function _rowApplies(def) {
  return settingShowsOnHost(def, typeof hostPlatform !== 'undefined' ? hostPlatform : undefined) && _depSatisfied(def)
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
  // Custom-rendered entries (e.g. filter rules editor) skip auto-row generation;
  // the one exception hand-renders its own row (sound-ui.js).
  if (def.control === 'custom') {
    if (def.key === 'mentionSoundName') rows.push(sfxMentionRow(def))
    return rows
  }
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
    if (def.category !== cat || !_rowApplies(def)) continue
    // Basic view: only the day-one rows. Search always searches EVERYTHING
    // (_renderSearchResults has its own path) — hiding a setting from a
    // search for its own name would be the bad kind of simple.
    if (!_setShowAll && !def.basic) continue
    var title = _setSectionTitle(def)
    if (only && only.indexOf(def.section) === -1) continue
    var s = byTitle.get(title)
    if (!s) {
      s = { title: title, id: def.section, rows: [] }
      byTitle.set(title, s)
      sections.push(s)
    }
    s.rows.push.apply(s.rows, _rowsForDef(def))
  }
  // the clear button lives under the switch that decides whether anything is kept
  for (const s of sections) if (cat === 'chat' && s.id === 'input') s.rows.push(_sentClearRow())
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
    if (!_rowApplies(def)) continue
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
        escapeHtml(`${_setCatLabel(g.cat)} · ${g.section}`) +
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
      '<div class="hs-mc-set-search-hdr" data-set-jump="system|backup / restore">' +
      escapeHtml(t('mc_set_system_backup')) +
      '</div>' +
      actions.map((a) => a.html).join('') +
      '</div>'
  }
  var helpActions = _setHelpActionRows()
  var helpHits = helpActions.filter((a) => _rowMatches(a.hay, tokens))
  total += helpActions.length
  if (helpHits.length) {
    count += helpHits.length
    html +=
      '<div class="hs-mc-settings-group">' +
      '<div class="hs-mc-set-search-hdr" data-set-jump="help|">' +
      escapeHtml(_setCatLabel('help')) +
      '</div>' +
      helpHits.map((a) => a.html).join('') +
      '</div>'
  }
  var clearRow = _sentClearRow()
  total += 1
  if (_rowMatches(clearRow.hay, tokens)) {
    count += 1
    html +=
      '<div class="hs-mc-settings-group">' +
      '<div class="hs-mc-set-search-hdr" data-set-jump="chat|' +
      escapeHtml(t('btn_settings_input')) +
      '">' +
      escapeHtml(`${_setCatLabel('chat')} · ${t('btn_settings_input')}`) +
      '</div>' +
      clearRow.html +
      '</div>'
  }
  if (!count)
    html =
      '<div class="hs-mc-setting-row hs-mc-setting-note" style="color:#ffffff">' + t('common_no_matches') + '</div>'
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
      ? `<div class="hs-mc-setting-row hs-mc-setting-note" style="color:#ffffff;font-size:13px">${t('mc_settings_no_muted')}</div>`
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
              hsXButtonHtml(
                'hs-x-inline hs-mc-unmute-btn',
                t('mc_settings_unmute'),
                'data-username="' + escapeHtml(u) + '" title="' + t('mc_settings_unmute') + '"',
              ) +
              '</div>'
            )
          })
          .join('')) +
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
      '<span class="hs-mc-setting-label" data-tip="' +
      escapeHtml(t('mc_set_export_tip')) +
      '">' +
      t('mc_set_export') +
      '</span>' +
      '<button class="hs-mc-settings-btn" data-action="export-settings" style="background:#000;color:#fff;border:1px solid #ffffff;padding:2px 10px;font-size:13px;cursor:pointer;font-family:inherit">' +
      t('mc_set_export_btn') +
      '</button>' +
      '</div>',
  },
  {
    hay: 'import settings restore load json system',
    html:
      '<div class="hs-mc-setting-row hs-mc-setting-row-split">' +
      '<span class="hs-mc-setting-label" data-tip="' +
      escapeHtml(t('mc_set_import_tip')) +
      '">' +
      t('mc_set_import') +
      '</span>' +
      '<button class="hs-mc-settings-btn" data-action="import-settings" style="background:#000;color:#fff;border:1px solid #ffffff;padding:2px 10px;font-size:13px;cursor:pointer;font-family:inherit">' +
      t('mc_set_import_btn') +
      '</button>' +
      '</div>',
  },
  {
    hay: 'default reset all settings factory system',
    html:
      '<div class="hs-mc-setting-row" style="justify-content:flex-end">' +
      '<button class="hs-mc-defaults-btn" title="' +
      escapeHtml(t('mc_set_reset_all_title')) +
      '" style="background:#000;color:#fff;border:1px solid #ffffff;padding:2px 10px;font-size:13px;cursor:pointer;font-family:inherit">' +
      t('mc_set_all_defaults') +
      '</button>' +
      '</div>',
  },
]

// The first-run tour's way back. Lives in settings › ? (and in search): a person
// who closed the card by accident, or wants it again, looks for help.
function _setHelpActionRows() {
  return [
    {
      hay: 'tour welcome intro introduction first run start guide help show again',
      html:
        '<div class="hs-mc-setting-row hs-mc-setting-row-split">' +
        '<span class="hs-mc-setting-label" data-tip="' +
        escapeHtml(t('mc_set_tour_tip')) +
        '">' +
        t('mc_set_tour') +
        '</span>' +
        '<button class="hs-mc-settings-btn" data-action="show-tour" style="background:#000;color:#fff;border:1px solid #ffffff;padding:2px 10px;font-size:13px;cursor:pointer;font-family:inherit">' +
        t('mc_set_tour_btn') +
        '</button>' +
        '</div>',
    },
  ]
}

// "clear sent history" — a button, not a setting. _regSections puts it in chat > input, under
// "remember sent messages"; search finds it like the backup buttons.
function _sentClearRow() {
  return {
    hay: 'clear sent history messages up down arrow recall forget privacy chat input',
    html:
      '<div class="hs-mc-setting-row hs-mc-setting-row-split">' +
      '<span class="hs-mc-setting-label" data-tip="' +
      escapeHtml(t('mc_set_clear_sent_tip')) +
      '">' +
      t('mc_set_clear_sent') +
      '</span>' +
      '<button class="hs-mc-settings-btn" data-action="clear-sent-history" style="background:#000;color:#fff;border:1px solid #ffffff;padding:2px 10px;font-size:13px;cursor:pointer;font-family:inherit">' +
      t('mc_set_clear_sent_btn') +
      '</button>' +
      '</div>',
  }
}

function _renderBackupGroup() {
  return (
    '<div class="hs-mc-settings-group">' +
    '<div class="hs-mc-settings-group-title">' +
    t('mc_set_backup_restore') +
    '</div>' +
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
  'background:#000;color:#fff;border:1px solid #ffffff;padding:1px 6px;font-size:13px;cursor:pointer;font-family:inherit;line-height:1.4'
var FR_SEL = 'background:#000;color:#fff;border:1px solid #ffffff;padding:1px 3px;font-size:13px;font-family:inherit'
var FR_INPUT =
  'background:#000;color:#fff;border:1px solid #ffffff;padding:1px 4px;font-size:13px;font-family:inherit;flex:1;min-width:60px'

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
    '<span style="color:#ffffff;font-size:13px;min-width:28px;flex-shrink:0">' +
    typeLabel +
    '</span>' +
    '<span style="font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1" title="' +
    val +
    '">' +
    val +
    '</span>' +
    '<span style="color:#ffffff;font-size:13px;flex-shrink:0">▶' +
    aLabel +
    '</span>' +
    (aColor
      ? '<span style="display:inline-block;width:10px;height:10px;background:' +
        aColor +
        ';border:1px solid #ffffff;flex-shrink:0"></span>'
      : '') +
    (r.action === 'highlight' && r.sound
      ? '<button data-fr-action="play" data-fr-id="' +
        id +
        '" style="' +
        FR_BTN +
        ';color:#ffffff;flex-shrink:0;padding:1px 4px" title="' +
        escapeHtml(
          t('mc_set_fr_sound', [String(r.sound === 'custom' ? r.soundName || t('mc_sfx_opt_file') : r.sound)]),
        ) +
        '">♪' +
        (typeof r.soundVolume === 'number' ? escapeHtml(String(Math.round(r.soundVolume))) : '') +
        '</button>'
      : '') +
    '<span style="color:#ffffff;font-size:13px;flex-shrink:0">' +
    scopeLabel +
    '</span>' +
    '</div>' +
    '<button data-fr-action="up" data-fr-id="' +
    id +
    '" style="' +
    FR_BTN +
    ';color:#ffffff;flex-shrink:0;padding:1px 4px" title="' +
    escapeHtml(t('mc_set_fr_up')) +
    '">▲</button>' +
    '<button data-fr-action="down" data-fr-id="' +
    id +
    '" style="' +
    FR_BTN +
    ';color:#ffffff;flex-shrink:0;padding:1px 4px" title="' +
    escapeHtml(t('mc_set_fr_down')) +
    '">▼</button>' +
    hsXButtonHtml(
      'hs-x-inline',
      t('mc_mr_delete'),
      'data-fr-action="delete" data-fr-id="' + id + '" title="' + t('mc_mr_delete') + '"',
    ) +
    '</div>'
  )
}

function _renderFilterRuleAddForm() {
  var channels = typeof config !== 'undefined' && config && config.channels ? config.channels : []
  var chOptions =
    '<option value="all">' +
    t('mc_set_fr_all_channels') +
    '</option>' +
    channels
      .map((ch) => {
        var label = ch.twitch || ch.kick || ch.id || ''
        return `<option value="${escapeHtml(ch.id)}">${escapeHtml(label)}</option>`
      })
      .join('')
  return (
    '<div class="hs-mc-setting-row hs-mc-setting-row-block hs-mc-fr-addform" style="padding:4px 4px 6px">' +
    '<div style="font-size:13px;color:#ffffff;margin-bottom:4px">' +
    t('mc_mr_add') +
    '</div>' +
    '<div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center">' +
    '<select data-fr-field="type" style="' +
    FR_SEL +
    ';width:60px">' +
    '<option value="keyword">' +
    t('mc_set_fr_t_keyword') +
    '</option>' +
    '<option value="regex">' +
    t('mc_set_fr_t_regex') +
    '</option>' +
    '<option value="user">' +
    t('mc_set_fr_t_user') +
    '</option>' +
    '<option value="badge">' +
    t('mc_set_fr_t_badge') +
    '</option>' +
    '<option value="msgtype">' +
    t('mc_set_fr_t_msgtype') +
    '</option>' +
    '<option value="expr" title="' +
    escapeHtml(t('mc_set_fr_expr_tip')) +
    '">' +
    t('mc_set_fr_t_expr') +
    '</option>' +
    '</select>' +
    '<input type="text" data-fr-field="value" placeholder="' +
    escapeHtml(t('mc_set_fr_value_ph')) +
    '" style="' +
    FR_INPUT +
    '">' +
    '<select data-fr-field="action" style="' +
    FR_SEL +
    ';width:68px">' +
    '<option value="highlight">' +
    t('mc_set_fr_a_highlight') +
    '</option>' +
    '<option value="hide">' +
    t('mc_set_fr_a_hide') +
    '</option>' +
    '</select>' +
    '<input type="color" data-fr-field="color" value="#ffff00" style="width:28px;height:22px;border:1px solid #ffffff;background:#000;padding:1px;cursor:pointer;flex-shrink:0" title="' +
    escapeHtml(t('mc_set_fr_color')) +
    '">' +
    '<select data-fr-field="sound" style="' +
    FR_SEL +
    ';width:62px" title="' +
    escapeHtml(t('mc_set_fr_sound_tip')) +
    '">' +
    sfxFormSoundOptions() +
    '</select>' +
    sfxRuleFormHtml() +
    '<label style="display:flex;align-items:center;gap:2px;color:#ffffff;font-size:13px;cursor:pointer;flex-shrink:0" title="' +
    escapeHtml(t('mc_set_fr_case')) +
    '">' +
    '<input type="checkbox" data-fr-field="cs" style="margin:0;cursor:pointer">Aa</label>' +
    '<select data-fr-field="scope" style="' +
    FR_SEL +
    ';max-width:80px">' +
    chOptions +
    '</select>' +
    '<button data-fr-action="add" style="' +
    FR_BTN +
    ';background:#000000">' +
    t('mc_set_fr_add_btn') +
    '</button>' +
    '</div>' +
    sfxNoteHtml(';padding-left:0') +
    '</div>'
  )
}

function _renderFilterRulesGroup() {
  var fold = _setCollapsed.has('filters|rules')
  var rules = _getRawFilterRules()
  var ruleRows =
    rules.length === 0
      ? '<div class="hs-mc-setting-row hs-mc-setting-note" style="color:#ffffff;font-size:13px">' +
        t('mc_set_fr_none') +
        '</div>'
      : rules.map(_renderFilterRuleRow).join('')
  return (
    '<div class="hs-mc-settings-group">' +
    '<div class="hs-mc-settings-group-title" data-set-fold="rules">' +
    (fold ? '▸ ' : '▾ ') +
    t('mc_settings_filter_rules') +
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
      // the rule's own sound file goes with it — nothing else points at it
      if (rules[delIdx].sound === SFX_CUSTOM) sfxRemove(sfxRuleKey(rules[delIdx].id))
      rules.splice(delIdx, 1)
      _saveFilterRules(rules)
    }
    return
  }

  if (action === 'pick' || action === 'preview' || action === 'play') {
    sfxRuleAction(action, el)
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
    var volEl = form.querySelector('[data-fr-field="vol"]')
    var ruleVol = volEl ? Math.round(Number(volEl.value)) : null
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
    var ruleFile = null
    if (ruleAct === 'highlight') {
      newRule.color = ruleCol
      if (ruleSound === SFX_CUSTOM && sfxPending) {
        ruleFile = sfxPending
        newRule.sound = SFX_CUSTOM
        newRule.soundName = ruleFile.n // the name travels with the rule; the file stays on this device
      } else if (ruleSound && ruleSound !== 'none' && ruleSound !== SFX_CUSTOM) {
        newRule.sound = ruleSound
      }
      if (newRule.sound && ruleVol !== null && Number.isFinite(ruleVol)) newRule.soundVolume = ruleVol
    }
    if (!ruleFile) {
      rules.push(newRule)
      _saveFilterRules(rules)
      return
    }
    // the file is saved first: a rule must never point at a sound that failed
    // to land. Rules are re-read after the wait, not trusted from before it.
    sfxSave(sfxRuleKey(newRule.id), ruleFile).then((saved) => {
      if (!saved) {
        showToast(t('mc_sfx_err_save'), 'error')
        return
      }
      sfxPending = null
      var fresh = _getRawFilterRules()
      fresh.push(newRule)
      _saveFilterRules(fresh)
    })
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
    '" title="' +
    escapeHtml(t('mc_set_page_reset_title')) +
    '" style="background:#000;color:#fff;border:1px solid #ffffff;padding:2px 10px;font-size:13px;cursor:pointer;font-family:inherit">' +
    t('mc_set_default') +
    '</button>' +
    '</div>'
  )
}

// Basic view must never look like the whole product — a pane that quietly
// drops two-thirds of its rows reads as "that setting is gone". Say what's
// hidden and where it went, every pane, every time.
function _basicHint(cat) {
  if (_setShowAll) return ''
  var hidden = SETTINGS.filter((d) => d.category === cat && !d.basic && _rowApplies(d)).length
  if (!hidden) return ''
  return (
    '<div class="hs-mc-set-keyhint" data-set-scope-hint="1">' +
    t(hidden === 1 ? 'mc_set_basic_hint_one' : 'mc_set_basic_hint_many', [
      String(hidden),
      '<button class="hs-mc-set-scope-btn hs-mc-set-scope-inline">' + t('mc_set_show_all') + '</button>',
    ]) +
    '</div>'
  )
}

function _renderCategoryPane(cat) {
  return _renderCategoryPaneInner(cat) + _basicHint(cat)
}

function _renderCategoryPaneInner(cat) {
  if (cat === 'help') return _renderHelpPane()
  if (cat === 'mod') return _renderPageDefaultsRow(cat) + _regSections(cat)
  if (cat === 'filters') {
    // 'rules' section is custom-rendered; exclude it from auto-sections
    return _renderPageDefaultsRow(cat) + _regSections(cat, ['content', 'messages']) + _renderFilterRulesGroup()
  }
  if (cat === 'notifs') {
    return _renderPageDefaultsRow(cat) + _regSections(cat) + mrGroupHtml()
  }
  if (cat === 'system') {
    return _regSections(cat, ['tabs', 'subsystems', 'language']) + _renderMutedGroup() + _renderBackupGroup()
  }
  return _renderPageDefaultsRow(cat) + _regSections(cat)
}

// ─── settings export / import ────────────────────────────────────────────
// Export: dumps ui_settings (sync) + all hs_*/viewer_* keys and registry
// local-mirror keys (local) into a single JSON. Import: file picker → JSON parse → schema-validate → merge into
// storage. Both areas restored. Errors toast, don't throw.
// Private stores that must NEVER ride an export: mention/chat buffers, per-user notes, whispers, crash
// ring ("captured locally only"), and the picked sound files (hs_sfx_*: up to
// 256 kb each, per device by design — rules and the mention sound export only
// the file's name), and the sent-message history (hs_sent_history: what you typed, this device only). Import skips the same set so a crafted file can't overwrite
// them either.
var _SETTINGS_PRIVATE_KEY_RE = /^hs_(mentions_v2|user_notes|errors|irc_|kick_|yt_|whisper|sfx_|sent_history)/
// local-mirror settings (keyword highlights, filter rules) live under
// unprefixed mirror keys — allowlist them alongside the hs_/viewer_ namespaces
// or the export silently drops them (derived from the registry, never hand-listed)
var _SETTINGS_MIRROR_KEYS = new Set(SETTINGS.filter((d) => d.mirrorKey).map((d) => d.mirrorKey))
async function _exportAllSettings() {
  try {
    var syncObj = await browser.storage.sync.get(null)
    var localObj = await browser.storage.local.get(null)
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
          if (Object.keys(safeLocal).length) writes.push(browser.storage.local.set(safeLocal))
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

// settings › help — the one help: keys for this pane, then the slash commands.
// Esc (or ?) goes back to the cell it was opened from.
const _SET_HELP_KEYS = [
  ['/', 'mc_set_h_search'],
  ['1-7', 'mc_set_h_category'],
  ['↑ ↓', 'mc_set_h_move'],
  ['← →', 'mc_set_h_adjust'],
  ['enter', 'mc_set_h_toggle'],
  ['bksp', 'mc_set_h_reset_row'],
  ['esc', 'mc_set_h_close_clear'],
  ['?', 'mc_set_h_this_help'],
]
const _SET_HELP_VIM = [
  ['j k', 'mc_set_h_move'],
  ['h l', 'mc_set_h_adjust'],
  ['gg G', 'mc_set_h_first_last'],
  ['za', 'mc_set_h_fold'],
  ['d', 'mc_set_h_reset_row'],
  ['H L', 'mc_set_h_prev_next'],
]
function _renderHelpPane() {
  function grid(pairs) {
    return pairs
      .map((kv) => `<span class="hs-mc-set-help-key">${escapeHtml(kv[0])}</span><span>${escapeHtml(t(kv[1]))}</span>`)
      .join('')
  }
  return (
    '<div class="hs-mc-set-help-pane">' +
    _setHelpActionRows()
      .map((a) => a.html)
      .join('') +
    '<div class="hs-mc-set-help-title">' +
    t('mc_set_h_keys') +
    '</div>' +
    `<div class="hs-mc-set-help-grid">${grid(_SET_HELP_KEYS)}</div>` +
    (viModeEnabled
      ? `<div class="hs-mc-set-help-title">vi</div><div class="hs-mc-set-help-grid">${grid(_SET_HELP_VIM)}</div>`
      : '') +
    '<div class="hs-mc-set-help-title">' +
    t('mc_set_h_commands') +
    '</div>' +
    `<pre class="hs-mc-set-help-cmds">${escapeHtml(`${slashHelpText('ext')}\n\n${t('mc_set_h_full_list')}`)}</pre>` +
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
  if (ctl) {
    ctl.focus()
    return
  }
  row.querySelector('[data-sfx-action="pick"]')?.click() // the sound-file row: Enter opens the dialog
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
        _gotoSetSubtab(_settingsSubtab === 'help' ? _setHelpFrom : 'help')
        return
      }
      if (k === 'Escape') {
        if (_settingsSubtab === 'help') {
          _gotoSetSubtab(_setHelpFrom)
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
        _setFocusRow = null
        _gotoSetSubtab(_SET_SUBTAB_ORDER[+k - 1])
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
        _setFocusRow = null
        _gotoSetSubtab(_SET_SUBTAB_ORDER[(cur + (k === 'L' ? 1 : len - 1)) % len])
        return
      }
      if (k === 'd' && idx >= 0) {
        e.preventDefault()
        _setRowReset(rows[idx])
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
  var paneCtx = `${_settingsSubtab}|${_setQuery}`
  // The panel is position:absolute inset:0 and ONLY .hs-mc-set-subtab-body
  // scrolls — #hs-mc-messages itself never does, so preserving its scrollTop was
  // always 0 and every toggle reset the view to the top. Capture the inner body.
  var oldBody = msgsEl.querySelector('.hs-mc-set-subtab-body')
  var keepScroll = hadPanel && paneCtx === _setPaneCtx && oldBody ? oldBody.scrollTop : 0

  var searchActive = _setQueryTokens().length > 0
  var bodyContent
  var countLabel = ''
  if (searchActive) {
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
    '<input class="hs-mc-set-search" type="search" placeholder="' +
    escapeHtml(t('mc_set_search_ph')) +
    '" value="' +
    escapeHtml(_setQuery) +
    '">' +
    '<span class="hs-mc-set-search-count">' +
    countLabel +
    '</span>' +
    '<button class="hs-mc-set-scope-btn" title="' +
    (_setShowAll ? t('mc_set_scope_all_tip') : t('mc_set_scope_basic_tip')) +
    '">' +
    (_setShowAll ? t('mc_set_scope_all') : t('mc_set_scope_basic')) +
    '</button>' +
    '</div>' +
    '<div class="hs-mc-set-subtab-body">' +
    bodyContent +
    '</div>' +
    '</div>'

  // Controls render with live values inline (getSetting); only keyboard
  // focus needs restoring.
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
      if (next && next !== _settingsSubtab) _gotoSetSubtab(next)
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
      } else if (action === 'show-tour' && typeof tourReopen === 'function') {
        tourReopen()
      } else if (action === 'clear-sent-history') {
        hsSentHistoryClear().then(() => showToast(t('mc_set_clear_sent_done'), 'info'))
      }
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
      _setQuery = ''
      _setFocusRow = null
      _setSettingsSubtab(jump[0])
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

    // Chat sound file controls (@mention sound row) — data-sfx-action
    var sfxEl = e.target.closest('[data-sfx-action]')
    if (sfxEl) {
      sfxHandleAction(sfxEl)
      return
    }

    // Mention rule editor (server-side rules) — data-mr-action
    var mrEl = e.target.closest('[data-mr-action]')
    if (mrEl && !/^(SELECT|INPUT|TEXTAREA)$/.test(mrEl.tagName)) {
      mrHandleAction(mrEl)
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
    var frVol = e.target.closest('[data-fr-field="vol"]')
    if (frVol) {
      var frVolVal = frVol.nextElementSibling
      if (frVolVal) frVolVal.textContent = frVol.value
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
        var fam = regSel.value
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
