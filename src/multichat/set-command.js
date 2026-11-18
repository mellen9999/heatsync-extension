// /set <setting> <value>: change any registry setting from the composer.
// setSetting owns coercion + validation (returns false on unknown key or bad
// value — never corrupts the sync blob), so this is key/alias resolution plus
// the two gaps a raw string can't cross: a switch, where coerceSettingValue
// does !!v and "off" would read as true, and a slider, whose numbers on the
// settings page are not always the stored ones.
function runSetCommand(rest, input) {
  const m = rest.match(/^(\S+)\s+([\s\S]+)$/)
  if (!m) {
    showToast(t('mc_input_usage_set') || '/set <setting> <value>', 'error')
    return
  }
  const rawKey = m[1]
  const lk = rawKey.toLowerCase()
  const def =
    typeof SETTINGS !== 'undefined' ? SETTINGS.find((d) => d.key.toLowerCase() === lk || d.alias === lk) : null
  if (!def) {
    showToast(t('mc_input_set_unknown', [rawKey]) || `unknown setting: ${rawKey}`, 'error')
    return
  }
  if (def.type === 'multiselect' || def.type === 'boolmap' || def.type === 'json') {
    showToast(t('mc_input_set_complex') || 'change that one in the settings panel', 'error')
    return
  }
  let val = m[2].trim()
  if (def.type === 'bool') {
    const on = /^(on|true|1|yes|enabled?|show)$/i.test(val)
    const off = /^(off|false|0|no|disabled?|hide)$/i.test(val)
    if (!on && !off) {
      showToast(t('mc_input_set_bool', [def.key]) || `use on/off for ${def.key}`, 'error')
      return
    }
    val = on
  }
  // A slider's own numbers: volume shows 0-100 and is stored 0-1. "/set … 40", the number on
  // the slider, was clamped to 1 (full volume) and answered "= 40". Outside the slider's
  // range is an error here, not a clamp.
  const scale = (def.type === 'range' && def.displayScale) || 1
  let fits = true
  if (def.type === 'range' && def.options) {
    const n = Number(val)
    fits = val !== '' && Number.isFinite(n) && n >= def.options.min * scale && n <= def.options.max * scale
    val = n / scale
  }
  const ok = fits && typeof setSetting === 'function' && setSetting(def.key, val)
  if (ok) {
    // what was stored, in the numbers the settings page shows
    const now = typeof getSetting === 'function' ? getSetting(def.key) : val
    const shown = def.type === 'range' ? String(Math.round(now * scale * 1000) / 1000) : String(now)
    showToast(t('mc_input_set_done', [def.key, shown]) || `${def.key} = ${shown}`, 'success')
    clearInput(input)
  } else {
    let hint = ''
    if (def.type === 'enum' && Array.isArray(def.options)) hint = ` · ${def.options.map((o) => o.value).join('/')}`
    else if (def.type === 'range' && def.options) hint = ` · ${def.options.min * scale}-${def.options.max * scale}`
    showToast(`${t('mc_input_set_invalid', [def.key]) || `invalid value for ${def.key}`}${hint}`, 'error')
  }
}

export { runSetCommand }
