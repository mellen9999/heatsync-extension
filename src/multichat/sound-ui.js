// sound-ui — the settings controls for chat sounds: pick a file, hear it, set
// its volume. settings-ui.js calls in for the highlight-rule form + rule rows
// and for the @mention sound row; the engine and its limits (256 kb, 10 s,
// the rate limit) are sounds.js.
//
//   sfxPickFile()            file dialog → validated sound, or null (toasts why not)
//   sfxRuleFormHtml()        volume + file + play controls for the add-rule form
//   sfxFormSoundOptions()    the form's sound <select> options
//   sfxMentionRow(def)       the @mention sound-file row (registry row object)
//   sfxHandleAction(el)      click dispatcher for [data-sfx-action] (mention row)
//   sfxRuleAction(action,el) click dispatcher for the rule form's pick / preview / play

const SFX_ERR_KEYS = {
  type: 'mc_sfx_err_type',
  size: 'mc_sfx_err_size',
  decode: 'mc_sfx_err_decode',
  long: 'mc_sfx_err_long',
}

// The file chosen in the add-rule form. Held in memory only until the rule is
// added: an abandoned pick leaves nothing in storage.
var sfxPending = null

/**
 * Open the file dialog; resolves a prepared sound ({ n, t, b, buf }) or null.
 * Anything the engine refuses (not audio, over 256 kb, unreadable, over 10 s)
 * is told to the person in one plain line.
 */
function sfxPickFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'audio/*'
    input.style.display = 'none'
    const done = (sound) => {
      input.remove()
      resolve(sound)
    }
    input.addEventListener('cancel', () => done(null))
    input.addEventListener('change', async () => {
      const file = input.files?.[0]
      if (!file) return done(null)
      const res = await sfxPrepareFile(file)
      if (!res.ok) {
        showToast(t(SFX_ERR_KEYS[res.reason] || SFX_ERR_KEYS.decode), 'error')
        return done(null)
      }
      done(res.sound)
    })
    document.body.appendChild(input)
    input.click()
  })
}

// The note every place that can pick a file shows: where the file lives.
function sfxNoteHtml(extraStyle) {
  return `<div class="hs-mc-set-keyhint" style="padding:0 14px 6px${extraStyle || ''}">${escapeHtml(t('mc_sfx_note'))}</div>`
}

// ── highlight-rule form ───────────────────────────────────────────────────────
function sfxFormSoundOptions() {
  return (
    `<option value="none">${t('mc_set_fr_silent')}</option>` +
    Object.keys(SFX_PRESETS)
      .map((n) => `<option value="${n}">${n}</option>`)
      .join('') +
    `<option value="${SFX_CUSTOM}"${sfxPending ? ' selected' : ' disabled'}>${escapeHtml(t('mc_sfx_opt_file'))}</option>`
  )
}

function sfxPickLabel() {
  return `♪ ${sfxPending ? sfxPending.n : t('mc_sfx_pick')}`
}

// A new rule's volume starts at the shared mention volume, so a rule you add
// sounds exactly like the ones you already have until you move the slider.
function sfxRuleFormHtml() {
  const vol = Math.round(Math.min(1, Math.max(0, mentionSoundVolume)) * 100)
  return (
    `<input type="range" class="hs-mc-set-range" data-fr-field="vol" min="0" max="100" step="5" value="${vol}" style="width:70px" title="${escapeHtml(t('mc_sfx_volume'))}">` +
    `<span class="hs-mc-set-range-val">${vol}</span>` +
    `<button data-fr-action="pick" style="${FR_BTN};max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(t('mc_sfx_note'))}">${escapeHtml(sfxPickLabel())}</button>` +
    `<button data-fr-action="preview" style="${FR_BTN};padding:1px 4px" title="${escapeHtml(t('mc_sfx_play'))}">▶</button>`
  )
}

// Shows the freshly picked file in the form without rebuilding it (a rebuild
// would throw away whatever the person had typed).
function _sfxShowPending(form) {
  const sel = form.querySelector('[data-fr-field="sound"]')
  const opt = sel?.querySelector(`option[value="${SFX_CUSTOM}"]`)
  if (opt) opt.disabled = false
  if (sel) sel.value = SFX_CUSTOM
  const btn = form.querySelector('[data-fr-action="pick"]')
  if (btn) btn.textContent = sfxPickLabel()
}

async function _sfxReattachRule(ruleId) {
  const sound = await sfxPickFile()
  if (!sound) return
  if (!(await sfxSave(sfxRuleKey(ruleId), sound))) {
    showToast(t('mc_sfx_err_save'), 'error')
    return
  }
  const rules = _getRawFilterRules()
  const rule = rules.find((r) => String(r.id) === String(ruleId))
  if (rule && rule.soundName !== sound.n) {
    rule.soundName = sound.n
    _saveFilterRules(rules)
  }
}

/** pick / preview (rule form) and play (a rule row's ♪) */
function sfxRuleAction(action, el) {
  if (action === 'pick') {
    const form = el.closest('.hs-mc-fr-addform')
    sfxPickFile().then((sound) => {
      if (!sound) return
      sfxPending = sound
      if (form?.isConnected) _sfxShowPending(form)
    })
    return
  }
  if (action === 'preview') {
    const form = el.closest('.hs-mc-fr-addform')
    const name = form?.querySelector('[data-fr-field="sound"]')?.value
    if (!name || name === 'none') return
    const volume = Number(form.querySelector('[data-fr-field="vol"]')?.value) / 100
    sfxPlay({ name, volume, buf: name === SFX_CUSTOM ? sfxPending?.buf : undefined }, 'rule', true)
    return
  }
  // play: the sound of an existing rule, as it would play on a match. A picked
  // file that is not on this device (the rule synced from another one) plays
  // the ping instead — say so, and offer the dialog to pick it again.
  const rule = _getRawFilterRules().find((r) => String(r.id) === el.dataset.frId)
  if (!rule?.sound) return
  const volume = typeof rule.soundVolume === 'number' ? rule.soundVolume / 100 : mentionSoundVolume
  sfxPlay({ name: rule.sound, key: sfxRuleKey(rule.id), volume }, 'rule', true).then((res) => {
    if (res !== 'fallback') return
    showToast(t('mc_sfx_missing'), 'error')
    _sfxReattachRule(rule.id)
  })
}

// ── @mention sound row ────────────────────────────────────────────────────────
function sfxMentionRow(def) {
  const name = getSetting('mentionSoundName')
  const mod = _rowModified(def)
  const label = _setLabel(def)
  return {
    id: def.key,
    mod,
    hay: `${label} ${_setSectionTitle(def)} ${def.category} ${def.key} ${def.alias || ''} ${t('mc_sfx_note')}`.toLowerCase(),
    html:
      `<div class="hs-mc-setting-row hs-mc-setting-row-split hs-mc-set-child${mod ? ' hs-mc-set-mod' : ''}" data-set-row="${def.key}">` +
      '<span class="hs-mc-set-child-glyph">└ </span>' +
      `<span class="hs-mc-setting-label">${escapeHtml(label)}</span>` +
      '<div style="display:flex;align-items:center;gap:4px;min-width:0">' +
      `<span class="hs-mc-set-range-val" style="min-width:0;max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(name || t('mc_sfx_none'))}</span>` +
      `<button data-sfx-action="pick" style="${FR_BTN}">${escapeHtml(t('mc_sfx_pick'))}</button>` +
      `<button data-sfx-action="play" style="${FR_BTN};padding:1px 4px" title="${escapeHtml(t('mc_sfx_play'))}">▶</button>` +
      (name
        ? hsXButtonHtml(
            'hs-x-inline',
            escapeHtml(t('mc_sfx_remove')),
            `data-sfx-action="remove" title="${escapeHtml(t('mc_sfx_remove'))}"`,
          )
        : '') +
      '</div>' +
      '</div>' +
      sfxNoteHtml(),
  }
}

async function _sfxPickMention() {
  const sound = await sfxPickFile()
  if (!sound) return
  if (!(await sfxSave(SFX_MENTION_KEY, sound))) {
    showToast(t('mc_sfx_err_save'), 'error')
    return
  }
  setSetting('mentionSoundName', sound.n)
  setSetting('mentionSound', SFX_CUSTOM) // the pick applier plays it back
  renderSettingsTab()
}

function sfxHandleAction(el) {
  const action = el.dataset.sfxAction
  if (action === 'pick') {
    _sfxPickMention()
  } else if (action === 'play') {
    // Same path a real mention takes; the missing-file case plays the ping and
    // offers the dialog, exactly like a rule's ♪.
    const name = getSetting('mentionSound')
    playMentionPing(getSetting('mentionSoundVolume'), { name, preview: true }).then((res) => {
      if (res !== 'fallback') return
      showToast(t('mc_sfx_missing'), 'error')
      _sfxPickMention()
    })
  } else if (action === 'remove') {
    setSetting('mentionSoundName', '') // its applier deletes the file
    if (getSetting('mentionSound') === SFX_CUSTOM) setSetting('mentionSound', 'ping', { silent: true })
    renderSettingsTab()
  }
}
