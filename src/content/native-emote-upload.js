// native-emote-upload.js — "upload your own emote" in the NATIVE picker
// (heatsync-button.js, the overlay off). The form is drawn here; every rule and
// both server calls are the overlay picker's own (multichat/emote-upload-core.js,
// embedded ahead of this file) — same caps, name rule, error words.
//
// Self-contained: embedded by build.js (ENTRY_MODULES). Needs the globals `t`,
// `hsXButtonHtml` (x-glyph) and `browser`.

const HS_NU_IDS = ['btn', 'file', 'form', 'name', 'go', 'cancel', 'status']

const HS_NU_CSS = `
      .hs-nu { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; padding: 3px 8px; background: #000; border-bottom: 1px solid #fff; flex-shrink: 0; font-size: 13px; }
      .hs-nu [hidden] { display: none !important; }
      .hs-nu-form { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; }
      .hs-nu button:not(.hs-x) { background: transparent; color: #fff; border: 1px solid #fff; border-radius: 0; font: inherit; font-size: 13px; font-weight: 700; padding: 3px 8px; line-height: 15px; cursor: pointer; transition: none; }
      .hs-nu button:not(.hs-x):hover, .hs-nu button:not(.hs-x):active, .hs-nu button:not(.hs-x):focus-visible { background: #fff !important; color: #000 !important; outline: none; }
      .hs-nu button:not(.hs-x):disabled { opacity: 1; text-decoration: line-through; cursor: default; }
      #hs-nu-name { flex: 1; min-width: 0; padding: 4px 8px; background: #000; color: #fff; border: 1px solid #fff; border-radius: 0; font: inherit; font-size: 13px; outline: none; box-sizing: border-box; }
      .hs-nu-status { color: #fff; }
      .hs-nu-status.error { color: #ff0000; }
`

function hsNativeUploadHtml() {
  return `<style>${HS_NU_CSS}</style><div class="hs-nu" id="hs-nu">
      <button type="button" id="hs-nu-btn" title="${t('mc_emote_upload_tip')}">⇪ ${t('mc_emote_upload')}</button>
      <input type="file" id="hs-nu-file" accept="${HS_EU_TYPES.join(',')}" hidden>
      <span class="hs-nu-form" id="hs-nu-form" hidden>
        <input type="text" id="hs-nu-name" maxlength="100" autocomplete="off" spellcheck="false" placeholder="${t('mc_emote_upload_name')}" aria-label="${t('mc_emote_upload_name')}">
        <button type="button" id="hs-nu-go">${t('mc_emote_upload')}</button>
        ${hsXButtonHtml('', t('mc_emote_upload_cancel'), 'id="hs-nu-cancel"')}
      </span>
      <span class="hs-nu-status" id="hs-nu-status" role="status"></span>
    </div>`
}

/**
 * Wire the form inside `panel`. `hooks.toast(msg)` says an outcome in the
 * picker's own toast; `hooks.added(name)` runs once the emote is in your set.
 * Returns the state machine's handles for tests: { pick, submit }.
 */
function hsNativeUploadWire(panel, hooks) {
  const $ = (id) => panel.querySelector(`#hs-nu-${id}`)
  if (HS_NU_IDS.some((id) => !$(id))) return null
  let busy = false
  let file = null
  let uploaded = null // once on the server: its answer, so a retry only picks another name

  const status = (msg, isError) => {
    $('status').textContent = msg || ''
    $('status').classList.toggle('error', !!isError && !!msg)
  }
  const reset = () => {
    file = null
    uploaded = null
    $('form').hidden = true
    $('file').value = ''
    $('btn').hidden = false
  }
  const setBusy = (on) => {
    busy = on
    for (const id of ['go', 'name', 'cancel']) $(id).disabled = on
  }
  const fail = (r) => {
    const why = hsEuReason(r)
    if (why === null) {
      status(t('mc_emote_add_login'), true)
      hooks.toast(t('mc_emote_add_login'))
    } else {
      status(why, true)
    }
  }
  const send = async (msg) => {
    try {
      return await browser.runtime.sendMessage(msg)
    } catch (e) {
      return { ok: false, success: false, error: e?.message || 'failed' }
    }
  }

  const pick = (f) => {
    if (!f) return
    const problem = hsEuFileProblem(f)
    if (problem) {
      status(problem, true)
      reset()
      return
    }
    file = f
    uploaded = null
    status('')
    $('btn').hidden = true
    $('form').hidden = false
    $('name').value = hsEuDefaultName(f)
    $('name').focus()
    $('name').select()
  }

  const submit = async () => {
    if (busy || !file) return
    const name = $('name').value.trim()
    if (!hsEuNameOk(name)) {
      status(t('mc_emote_upload_name_bad'), true)
      $('name').focus()
      return
    }
    setBusy(true)
    status(t('mc_input_uploading'))
    try {
      const res = await hsEuSubmit(send, file, name, uploaded)
      if (res.up) uploaded = res.up
      if (res.kind === 'upload_failed') {
        fail(res.r)
        reset()
      } else if (res.kind === 'taken') {
        status(t('mc_emote_upload_taken', [name]), true)
        $('name').focus()
        $('name').select()
      } else if (res.kind === 'failed') {
        fail(res.r)
      } else {
        status('')
        reset()
        hooks.toast(t('mc_emote_added', [name]))
        if (res.up?.flagged?.length) hooks.toast(t('mc_emote_upload_flagged', [res.up.flagged.join(', ')]))
        hooks.added(name)
      }
    } catch (e) {
      fail({ error: e?.message })
    } finally {
      setBusy(false)
    }
  }

  $('btn').addEventListener('click', () => $('file').click())
  $('file').addEventListener('change', () => pick($('file').files?.[0]))
  $('go').addEventListener('click', submit)
  const cancel = () => {
    status('')
    reset()
    $('btn').focus()
  }
  $('cancel').addEventListener('click', cancel)
  // Enter adds, Esc backs out of the form only — not out of the whole picker.
  $('name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      submit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (!busy) cancel()
    }
  })
  return { pick, submit }
}
