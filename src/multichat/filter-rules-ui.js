// filter-rules-ui — the settings editor for the local chat filter rules
// (chatFilterRules; the engine is filter-rules.js). One form builds a rule: the
// add form at the bottom of the list, or — via the ✎ button — the same form in
// place of the row it edits (same id, same position, cancel puts the row back).
//
//   _getRawFilterRules / _saveFilterRules   read + write the rule list (settings-ui, sound-ui)
//   _renderFilterRulesGroup()               the whole "filter rules" section
//   _handleFilterRuleAction(el)             click dispatcher for [data-fr-action]
//   frBindForm(msgsEl)                      the form's input / change / keydown listeners
//   frBuildRule(draft, base)                form values → rule (or the i18n key of what is wrong)
//   frPreviewHtml(draft)                    "matches N of the last 200 messages"
//
// Under the type select sits a one-line hint with an example, and under the
// value a live count from the real matcher (previewFilterRule) over the rows
// already in memory — so a rule is tried before it is saved, not after.

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

var FR_BTN =
  'background:#000;color:#fff;border:1px solid #ffffff;padding:1px 6px;font-size:13px;cursor:pointer;font-family:inherit;line-height:1.4'
var FR_SEL = 'background:#000;color:#fff;border:1px solid #ffffff;padding:1px 3px;font-size:13px;font-family:inherit'
var FR_INPUT =
  'background:#000;color:#fff;border:1px solid #ffffff;padding:1px 4px;font-size:13px;font-family:inherit;flex:1;min-width:60px'
var FR_TYPES = ['keyword', 'regex', 'user', 'badge', 'msgtype', 'expr']
var FR_PREVIEW_DEBOUNCE_MS = 250

// literal keys, so the i18n call-site check can see every one
function frTypeLabel(type) {
  var labels = {
    keyword: t('mc_set_fr_t_keyword'),
    regex: t('mc_set_fr_t_regex'),
    user: t('mc_set_fr_t_user'),
    badge: t('mc_set_fr_t_badge'),
    msgtype: t('mc_set_fr_t_msgtype'),
    expr: t('mc_set_fr_t_expr'),
  }
  return labels[type] || '?'
}

// one plain line with an example, for the type picked
function frTypeHint(type) {
  var hints = {
    keyword: t('mc_set_fr_hint_keyword'),
    regex: t('mc_set_fr_hint_regex'),
    user: t('mc_set_fr_hint_user'),
    badge: t('mc_set_fr_hint_badge'),
    msgtype: t('mc_set_fr_hint_msgtype'),
    expr: t('mc_set_fr_expr_tip'),
  }
  return hints[type] || ''
}

// ── the form's values ────────────────────────────────────────────────────────
// A draft is what the form holds: {type,value,action,color,sound,vol,cs,scope,notify}.
// It is kept across a repaint, so a re-render of the panel never eats a half-typed rule.
var _frAddDraft = null // the add form
var _frEditId = null // the rule open for editing; null = none
var _frEditDraft = null // its form

function frBlankDraft() {
  return {
    type: 'keyword',
    value: '',
    action: 'highlight',
    color: '#ffff00',
    sound: 'none',
    vol: null, // null = the shared mention volume, as a new rule always started
    cs: false,
    scope: 'all',
    notify: false,
  }
}

// <input type=color> only takes #rrggbb; a stored #rgb or #rrggbbaa would read as black
function frColorForInput(c) {
  if (typeof c !== 'string') return '#ffff00'
  if (/^#[0-9a-f]{6}$/i.test(c)) return c
  var m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(c)
  if (m) return `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`
  var long = /^#([0-9a-f]{6})[0-9a-f]{2}$/i.exec(c)
  return long ? `#${long[1]}` : '#ffff00'
}

function frRuleToDraft(r) {
  return {
    type: FR_TYPES.includes(r.match?.type) ? r.match.type : 'keyword',
    value: String(r.match?.value ?? ''),
    action: r.action === 'hide' ? 'hide' : 'highlight',
    color: frColorForInput(r.color),
    sound: r.sound || 'none',
    vol: typeof r.soundVolume === 'number' ? Math.round(r.soundVolume) : null,
    cs: !!r.match?.caseSensitive,
    scope: r.scope || 'all',
    notify: r.notify === true,
  }
}

function frReadForm(form) {
  var f = (n) => form.querySelector(`[data-fr-field="${n}"]`)
  var vol = f('vol') ? Math.round(Number(f('vol').value)) : null
  return {
    type: f('type')?.value || 'keyword',
    value: f('value')?.value || '',
    action: f('action')?.value === 'hide' ? 'hide' : 'highlight',
    color: f('color')?.value || '#ffff00',
    sound: f('sound')?.value || 'none',
    vol: Number.isFinite(vol) ? vol : null,
    cs: !!f('cs')?.checked,
    scope: f('scope')?.value || 'all',
    notify: !!f('notify')?.checked,
  }
}

/**
 * Form values → a rule. `base` is the rule being edited ({id, enabled, …}) or a
 * fresh {id, enabled:true}. Returns { rule, file } — `file` is a freshly picked
 * sound that must be saved before the rule is — or { error: <i18n key> }.
 */
function frBuildRule(d, base) {
  var value = String(d.value || '').trim()
  if (!value) return { error: 'mc_settingsui_rule_value_empty' }
  // Validate expr syntax up front so a malformed rule toasts instead of
  // silently compiling to nothing (the parser lives in the same bundle).
  if (d.type === 'expr' && typeof _frParseExpr === 'function' && !_frParseExpr(_frTokenizeExpr(value))) {
    return { error: 'mc_settingsui_invalid_expression' }
  }
  var rule = { ...base, scope: d.scope, match: { type: d.type, value: value, caseSensitive: !!d.cs }, action: d.action }
  // everything that only a highlight owns is rebuilt below, so switching to hide leaves none behind
  delete rule.color
  delete rule.sound
  delete rule.soundName
  delete rule.soundVolume
  delete rule.notify
  var file = null
  if (d.action === 'highlight') {
    rule.color = d.color
    if (d.sound === SFX_CUSTOM && sfxPending) {
      file = sfxPending
      rule.sound = SFX_CUSTOM
      rule.soundName = file.n // the name travels with the rule; the file stays on this device
    } else if (d.sound === SFX_CUSTOM && base.sound === SFX_CUSTOM) {
      rule.sound = SFX_CUSTOM // an edit that keeps the file it already has
      rule.soundName = base.soundName
    } else if (d.sound && d.sound !== 'none' && d.sound !== SFX_CUSTOM) {
      rule.sound = d.sound
    }
    if (rule.sound && d.vol !== null && Number.isFinite(d.vol)) rule.soundVolume = d.vol
    if (d.notify) rule.notify = true
  }
  return { rule: rule, file: file }
}

// ── the live count ───────────────────────────────────────────────────────────
// The rows the rule is tried on: its own channel's tab when scoped to one, else
// the chat tab settings was opened from (prevTab), else the live tab — newest
// first-in-memory, own messages left out (a rule never touches those).
function frPreviewRows(scope) {
  try {
    var tab = scope && scope !== 'all' ? scope : prevTab
    if (tab !== 'live' && !(typeof getChannelById === 'function' && getChannelById(tab))) tab = 'live'
    return fairMerge(mergedTabSources(tab, FR_PREVIEW_LIMIT * 2, false)).filter((m) => !isSelf(m))
  } catch {
    return []
  }
}

// { tone, text } for a draft: how many of the last rows the rule would catch
function frPreviewFor(d, rows) {
  if (!String(d.value || '').trim()) return null
  var res = previewFilterRule(
    {
      scope: d.scope,
      match: { type: d.type, value: String(d.value).trim(), caseSensitive: !!d.cs },
      action: d.action,
    },
    rows,
  )
  if (!res.ok) return { tone: 'bad', text: t('mc_set_fr_pv_bad') }
  if (!res.total) return { tone: 'none', text: t('mc_set_fr_pv_empty') }
  if (!res.hits) return { tone: 'none', text: t('mc_set_fr_pv_none', [String(res.total)]) }
  return { tone: 'hit', text: t('mc_set_fr_pv_n', [String(res.hits), String(res.total)]) }
}

function frPreviewHtml(d) {
  var p = frPreviewFor(d, frPreviewRows(d.scope))
  if (!p) return ''
  var color = p.tone === 'hit' ? 'var(--hs-ok)' : p.tone === 'bad' ? 'var(--hs-danger)' : 'var(--hs-muted)'
  return `<span style="color:${color}">${escapeHtml(p.text)}</span>`
}

var _frPreviewTimer = null
function frSchedulePreview(form) {
  if (_frPreviewTimer) cleanup.clearTimeout(_frPreviewTimer)
  _frPreviewTimer = cleanup.setTimeout(() => {
    _frPreviewTimer = null
    var el = form.isConnected ? form.querySelector('[data-fr-preview]') : null
    if (el) el.innerHTML = frPreviewHtml(frReadForm(form))
  }, FR_PREVIEW_DEBOUNCE_MS)
}

// ── markup ───────────────────────────────────────────────────────────────────
function _frScopeLabel(scope) {
  if (!scope || scope === 'all') return t('mc_set_fr_all_channels')
  var ch = typeof config !== 'undefined' && config?.channels ? config.channels.find((c) => c.id === scope) : null
  return ch ? ch.twitch || ch.kick || ch.id || String(scope) : String(scope)
}

function _renderFilterRuleRow(r) {
  var on = !!r.enabled
  var typeLabel = frTypeLabel(r.match?.type)
  var val = r.match?.value ? escapeHtml(String(r.match.value)) : ''
  var aLabel = t(r.action === 'hide' ? 'mc_set_fr_a_hide' : 'mc_set_fr_a_highlight')
  var aColor = r.action === 'highlight' && r.color ? escapeHtml(r.color) : ''
  var scopeLabel = escapeHtml(_frScopeLabel(r.scope))
  var id = escapeHtml(String(r.id))
  var small = `;color:#ffffff;flex-shrink:0;padding:1px 4px`
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
    '<span style="color:#ffffff;font-size:13px;flex-shrink:0">' +
    escapeHtml(typeLabel) +
    '</span>' +
    '<span style="font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1" title="' +
    val +
    '">' +
    val +
    '</span>' +
    '<span style="color:#ffffff;font-size:13px;flex-shrink:0">▶' +
    escapeHtml(aLabel) +
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
        small +
        '" title="' +
        escapeHtml(
          t('mc_set_fr_sound', [String(r.sound === 'custom' ? r.soundName || t('mc_sfx_opt_file') : r.sound)]),
        ) +
        '">♪' +
        (typeof r.soundVolume === 'number' ? escapeHtml(String(Math.round(r.soundVolume))) : '') +
        '</button>'
      : '') +
    (r.action === 'highlight' && r.notify === true
      ? '<span style="color:#ffffff;font-size:13px;flex-shrink:0" title="' +
        escapeHtml(t('mc_set_fr_notify')) +
        '">@</span>'
      : '') +
    '<span style="color:#ffffff;font-size:13px;flex-shrink:0">' +
    scopeLabel +
    '</span>' +
    '</div>' +
    '<button data-fr-action="edit" data-fr-id="' +
    id +
    '" style="' +
    FR_BTN +
    small +
    '" title="' +
    escapeHtml(t('mc_mr_edit')) +
    '">✎</button>' +
    '<button data-fr-action="up" data-fr-id="' +
    id +
    '" style="' +
    FR_BTN +
    small +
    '" title="' +
    escapeHtml(t('mc_set_fr_up')) +
    '">▲</button>' +
    '<button data-fr-action="down" data-fr-id="' +
    id +
    '" style="' +
    FR_BTN +
    small +
    '" title="' +
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

function _frOption(value, label, cur) {
  return `<option value="${escapeHtml(value)}"${value === cur ? ' selected' : ''}>${escapeHtml(label)}</option>`
}

// The one form: `d` is its draft, `editId` the rule it edits (null = the add form).
function _renderFilterRuleForm(d, editId) {
  var editing = editId !== null
  var channels = typeof config !== 'undefined' && config && config.channels ? config.channels : []
  var chOptions =
    _frOption('all', t('mc_set_fr_all_channels'), d.scope) +
    channels.map((ch) => _frOption(String(ch.id), ch.twitch || ch.kick || ch.id || '', d.scope)).join('')
  // a rule scoped to a channel that is no longer on the list keeps its scope on save
  if (d.scope !== 'all' && !channels.some((ch) => String(ch.id) === d.scope)) {
    chOptions += _frOption(d.scope, _frScopeLabel(d.scope), d.scope)
  }
  var base = editing ? _getRawFilterRules().find((r) => String(r.id) === String(editId)) : null
  var hl = d.action === 'highlight'
  var vol = d.vol === null ? undefined : d.vol
  // "my file" only stands when there is a file behind it: one just picked, or the edited rule's own
  var curSound = d.sound === SFX_CUSTOM && !(sfxPending || base?.sound === SFX_CUSTOM) ? 'none' : d.sound
  var attr = editing ? ` data-fr-edit="${escapeHtml(String(editId))}"` : ''
  return (
    '<div class="hs-mc-setting-row hs-mc-setting-row-block hs-mc-fr-addform"' +
    attr +
    ' style="padding:4px 4px 6px">' +
    '<div style="font-size:13px;color:#ffffff;margin-bottom:4px">' +
    escapeHtml(t(editing ? 'mc_mr_edit' : 'mc_mr_add')) +
    '</div>' +
    '<div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center">' +
    '<select data-fr-field="type" style="' +
    FR_SEL +
    '">' +
    FR_TYPES.map((ty) => _frOption(ty, frTypeLabel(ty), d.type)).join('') +
    '</select>' +
    '<input type="text" data-fr-field="value" value="' +
    escapeHtml(d.value) +
    '" placeholder="' +
    escapeHtml(t('mc_set_fr_value_ph')) +
    '" style="' +
    FR_INPUT +
    '">' +
    '</div>' +
    '<div class="hs-mc-set-keyhint" data-fr-hint style="padding:2px 0 4px">' +
    escapeHtml(frTypeHint(d.type)) +
    '</div>' +
    '<div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center">' +
    '<select data-fr-field="action" style="' +
    FR_SEL +
    '">' +
    _frOption('highlight', t('mc_set_fr_a_highlight'), d.action) +
    _frOption('hide', t('mc_set_fr_a_hide'), d.action) +
    '</select>' +
    // colour, sound and alert only mean something for a highlight
    '<span data-fr-hl style="display:' +
    (hl ? 'contents' : 'none') +
    '">' +
    '<input type="color" data-fr-field="color" value="' +
    escapeHtml(frColorForInput(d.color)) +
    '" style="width:28px;height:22px;border:1px solid #ffffff;background:#000;padding:1px;cursor:pointer;flex-shrink:0" title="' +
    escapeHtml(t('mc_set_fr_color')) +
    '">' +
    '<select data-fr-field="sound" style="' +
    FR_SEL +
    '" title="' +
    escapeHtml(t('mc_set_fr_sound_tip')) +
    '">' +
    sfxFormSoundOptions(curSound) +
    '</select>' +
    sfxRuleFormHtml(vol, base?.soundName) +
    '<label style="display:flex;align-items:center;gap:2px;color:#ffffff;font-size:13px;cursor:pointer;flex-shrink:0" title="' +
    escapeHtml(t('mc_set_fr_notify_tip')) +
    '"><input type="checkbox" data-fr-field="notify" style="margin:0;cursor:pointer"' +
    (d.notify ? ' checked' : '') +
    '>' +
    escapeHtml(t('mc_set_fr_notify')) +
    '</label>' +
    '</span>' +
    '<label style="display:flex;align-items:center;gap:2px;color:#ffffff;font-size:13px;cursor:pointer;flex-shrink:0" title="' +
    escapeHtml(t('mc_set_fr_case')) +
    '"><input type="checkbox" data-fr-field="cs" style="margin:0;cursor:pointer"' +
    (d.cs ? ' checked' : '') +
    '>Aa</label>' +
    '<select data-fr-field="scope" style="' +
    FR_SEL +
    ';max-width:120px">' +
    chOptions +
    '</select>' +
    (editing
      ? '<button data-fr-action="save" style="' +
        FR_BTN +
        '">' +
        escapeHtml(t('mc_mr_save')) +
        '</button>' +
        '<button data-fr-action="cancel" style="' +
        FR_BTN +
        '">' +
        escapeHtml(t('mc_mr_cancel')) +
        '</button>'
      : '<button data-fr-action="add" style="' + FR_BTN + '">' + escapeHtml(t('mc_set_fr_add_btn')) + '</button>') +
    '</div>' +
    '<div data-fr-preview style="font-size:13px;padding:4px 0 0">' +
    frPreviewHtml(d) +
    '</div>' +
    sfxNoteHtml(';padding-left:0') +
    '</div>'
  )
}

function _renderFilterRulesGroup() {
  var fold = _setCollapsed.has('filters|rules')
  var rules = _getRawFilterRules()
  var editing = _frEditId !== null && rules.some((r) => String(r.id) === _frEditId)
  if (_frEditId !== null && !editing) {
    // the rule went away under the form (deleted on another device): drop the edit
    _frEditId = null
    _frEditDraft = null
  }
  var ruleRows =
    rules.length === 0
      ? '<div class="hs-mc-setting-row hs-mc-setting-note" style="color:#ffffff;font-size:13px">' +
        t('mc_set_fr_none') +
        '</div>'
      : rules
          .map((r) =>
            editing && String(r.id) === _frEditId
              ? _renderFilterRuleForm(_frEditDraft || frRuleToDraft(r), _frEditId)
              : _renderFilterRuleRow(r),
          )
          .join('')
  return (
    '<div class="hs-mc-settings-group">' +
    '<div class="hs-mc-settings-group-title" data-set-fold="rules">' +
    (fold ? '▸ ' : '▾ ') +
    t('mc_settings_filter_rules') +
    (rules.length ? ` <span class="hs-mc-set-cnt">(${rules.length})</span>` : '') +
    '</div>' +
    // one form at a time: while a rule is open for editing, the add form waits
    (fold ? '' : ruleRows + (editing ? '' : _renderFilterRuleForm(_frAddDraft || frBlankDraft(), null))) +
    '</div>'
  )
}

// ── actions ──────────────────────────────────────────────────────────────────
function _frCloseEdit() {
  _frEditId = null
  _frEditDraft = null
  sfxPending = null
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
      if (_frEditId === id) _frCloseEdit()
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

  if (action === 'edit' && id) {
    var editRule = rules.find((r) => String(r.id) === id)
    if (!editRule) return
    sfxPending = null // a file picked for the add form is not this rule's
    _frEditId = id
    _frEditDraft = frRuleToDraft(editRule)
    renderSettingsTab()
    return
  }

  if (action === 'cancel') {
    _frCloseEdit()
    renderSettingsTab()
    return
  }

  if (action === 'add' || action === 'save') {
    var form = el.closest('.hs-mc-fr-addform')
    if (!form) return
    var adding = action === 'add'
    var editing = adding ? null : rules.find((r) => String(r.id) === _frEditId)
    if (!adding && !editing) {
      _frCloseEdit() // the rule was deleted under the form
      renderSettingsTab()
      return
    }
    var built = frBuildRule(
      frReadForm(form),
      adding ? { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7), enabled: true } : editing,
    )
    if (built.error) {
      showToast(t(built.error), 'error')
      return
    }
    // edit: the rule keeps its id, its on/off state and its place in the list
    var finish = (list) => {
      if (adding) {
        list.push(built.rule)
        _frAddDraft = null
      } else {
        var at = list.findIndex((r) => String(r.id) === String(built.rule.id))
        if (at === -1) return false
        // a custom sound the rule no longer uses has no other owner
        if (list[at].sound === SFX_CUSTOM && built.rule.sound !== SFX_CUSTOM) sfxRemove(sfxRuleKey(list[at].id))
        list[at] = built.rule
        _frCloseEdit()
      }
      _saveFilterRules(list)
      return true
    }
    if (!built.file) {
      finish(rules)
      return
    }
    // the file is saved first: a rule must never point at a sound that failed
    // to land. Rules are re-read after the wait, not trusted from before it.
    sfxSave(sfxRuleKey(built.rule.id), built.file).then((saved) => {
      if (!saved) {
        showToast(t('mc_sfx_err_save'), 'error')
        return
      }
      sfxPending = null
      if (!finish(_getRawFilterRules())) renderSettingsTab()
    })
    return
  }
}

// ── listeners ────────────────────────────────────────────────────────────────
// A form control changed: keep the draft, move the type hint, hide what a hide
// rule does not use, and re-run the live count.
function _frFormTouched(form, target) {
  var draft = frReadForm(form)
  if (form.dataset.frEdit !== undefined) _frEditDraft = draft
  else _frAddDraft = draft
  var field = target?.dataset?.frField
  if (field === 'type') {
    var hint = form.querySelector('[data-fr-hint]')
    if (hint) hint.textContent = frTypeHint(draft.type)
  }
  if (field === 'action') {
    var hl = form.querySelector('[data-fr-hl]')
    if (hl) hl.style.display = draft.action === 'highlight' ? 'contents' : 'none'
  }
  if (field === 'vol') {
    var val = target.nextElementSibling
    if (val) val.textContent = target.value
    return // a sound's volume changes nothing about what matches
  }
  frSchedulePreview(form)
}

// Called once per panel paint; replaces the listeners it left on the last one.
function frBindForm(msgsEl) {
  if (msgsEl._hsFrInput) msgsEl.removeEventListener('input', msgsEl._hsFrInput)
  if (msgsEl._hsFrChange) msgsEl.removeEventListener('change', msgsEl._hsFrChange)
  if (msgsEl._hsFrKey) msgsEl.removeEventListener('keydown', msgsEl._hsFrKey)
  var touched = (e) => {
    var form = e.target.closest?.('.hs-mc-fr-addform')
    if (form && e.target.closest('[data-fr-field]')) _frFormTouched(form, e.target)
  }
  msgsEl._hsFrInput = touched
  msgsEl._hsFrChange = touched
  // Enter in the value box saves, Escape on an open edit puts the row back
  msgsEl._hsFrKey = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return
    var form = e.target.closest?.('.hs-mc-fr-addform')
    if (!form || e.target.dataset?.frField !== 'value') return
    if (e.key === 'Enter') {
      e.preventDefault()
      form.querySelector('[data-fr-action="add"], [data-fr-action="save"]')?.click()
    } else if (e.key === 'Escape' && form.dataset.frEdit !== undefined) {
      e.preventDefault()
      _frCloseEdit()
      renderSettingsTab()
    }
  }
  msgsEl.addEventListener('input', msgsEl._hsFrInput)
  msgsEl.addEventListener('change', msgsEl._hsFrChange)
  msgsEl.addEventListener('keydown', msgsEl._hsFrKey)
}
