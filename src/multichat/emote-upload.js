// emote-upload.js — upload your own emote from the picker.
//
// Until now uploads only existed on heatsync.org's inventory page. This is the
// same two calls the site makes — POST /api/upload (type=emote), then
// POST /api/user/emotes (source=upload) — driven from a button in the picker's
// header. Both go through the background worker (api_upload, add_to_inventory):
// a content script's own request to heatsync.org is a cross-origin one from
// twitch/kick/youtube, which the host page's CORS and cloudflare's edge both
// refuse. The worker carries the stored token as a Bearer, so no cookie or csrf
// round-trip is involved.
//
// Every outcome is said in plain words next to the button. A file that cannot
// be uploaded closes the form; a name that is taken keeps it (and the file
// already uploaded) open so you only pick another name.

let _mcEuBusy = false
// What a retry reuses: the picked file, or — once it is on the server — its answer.
let _mcEuFile = null
let _mcEuUploaded = null

function mcEmoteUploadHtml() {
  return `<div class="hs-mc-upload" id="hs-mc-upload">
      <button type="button" class="hs-mc-upload-btn" id="hs-mc-upload-btn" title="${escapeHtml(t('mc_emote_upload_tip'))}">⇪ ${escapeHtml(t('mc_emote_upload'))}</button>
      <input type="file" id="hs-mc-upload-file" accept="${HS_EU_TYPES.join(',')}" hidden>
      <span class="hs-mc-upload-form" id="hs-mc-upload-form" hidden>
        <input type="text" id="hs-mc-upload-name" maxlength="100" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(t('mc_emote_upload_name'))}" aria-label="${escapeHtml(t('mc_emote_upload_name'))}">
        <button type="button" id="hs-mc-upload-go">${escapeHtml(t('mc_emote_upload'))}</button>
        ${hsXButtonHtml('', t('mc_emote_upload_cancel'), 'id="hs-mc-upload-cancel"')}
      </span>
      <span class="hs-mc-upload-status" id="hs-mc-upload-status" role="status"></span>
    </div>`
}

function mcEuStatus(msg, isError) {
  const el = document.getElementById('hs-mc-upload-status')
  if (!el) return
  el.textContent = msg || ''
  el.classList.toggle('error', !!isError && !!msg)
}

function mcEuReset() {
  _mcEuFile = null
  _mcEuUploaded = null
  const form = document.getElementById('hs-mc-upload-form')
  if (form) form.hidden = true
  const file = document.getElementById('hs-mc-upload-file')
  if (file) file.value = ''
  const btn = document.getElementById('hs-mc-upload-btn')
  if (btn) btn.hidden = false
}

function mcEuBusy(on) {
  _mcEuBusy = on
  for (const id of ['hs-mc-upload-go', 'hs-mc-upload-name', 'hs-mc-upload-cancel']) {
    const el = document.getElementById(id)
    if (el) el.disabled = on
  }
}

function mcEuPick(file) {
  if (!file) return
  const problem = hsEuFileProblem(file)
  if (problem) {
    mcEuStatus(problem, true)
    mcEuReset()
    return
  }
  _mcEuFile = file
  _mcEuUploaded = null
  mcEuStatus('')
  document.getElementById('hs-mc-upload-btn').hidden = true
  document.getElementById('hs-mc-upload-form').hidden = false
  const name = document.getElementById('hs-mc-upload-name')
  name.value = hsEuDefaultName(file)
  name.focus()
  name.select()
}

function mcEuFail(r) {
  const why = hsEuReason(r)
  if (why === null) {
    showEmoteLoginNudge()
    mcEuStatus(t('mc_emote_add_login'), true)
  } else {
    mcEuStatus(why, true)
  }
}

async function mcEmoteUploadSubmit() {
  if (_mcEuBusy || !_mcEuFile) return
  const nameEl = document.getElementById('hs-mc-upload-name')
  const name = (nameEl?.value || '').trim()
  if (!hsEuNameOk(name)) {
    mcEuStatus(t('mc_emote_upload_name_bad'), true)
    nameEl?.focus()
    return
  }
  mcEuBusy(true)
  mcEuStatus(t('mc_input_uploading'))
  try {
    const res = await hsEuSubmit(safeSendMessage, _mcEuFile, name, _mcEuUploaded)
    if (res.up) _mcEuUploaded = res.up
    if (res.kind === 'upload_failed') {
      mcEuFail(res.r)
      mcEuReset() // nothing was kept on the server: start over with another file
    } else if (res.kind === 'taken') {
      mcEuStatus(t('mc_emote_upload_taken', [name]), true)
      nameEl?.focus()
      nameEl?.select()
    } else if (res.kind === 'failed') {
      mcEuFail(res.r)
    } else {
      mcEuAdded(name, res.added, res.up)
    }
  } catch (e) {
    mcEuFail({ error: e?.message })
  } finally {
    mcEuBusy(false)
  }
}

// In your set: usable right now. The inventory refetch the worker starts fills
// in the server's row (size, smaller copies) a moment later.
function mcEuAdded(name, added, up) {
  inventoryEmotes.add(name)
  if (added.hash) {
    inventoryHashes.set(name, added.hash)
    hashToName.set(added.hash, name)
  }
  viewerPersonalEmotes.set(name, {
    url: up.url,
    source: 'heatsync',
    state: 'owned',
    hash: added.hash,
    slot: added.slot,
    zeroWidth: false,
    addedAt: Date.now(),
  })
  dismissEmoteLoginNudge()
  showToast(t('mc_emote_added', [name]), 'success')
  if (up.flagged?.length) showToast(t('mc_emote_upload_flagged', [up.flagged.join(', ')]), 'info')
  mcEuStatus('')
  mcEuReset()
  document.getElementById('hs-mc-emote-search')?.focus()
}

function mcEmoteUploadWire(picker) {
  const btn = picker.querySelector('#hs-mc-upload-btn')
  const file = picker.querySelector('#hs-mc-upload-file')
  const name = picker.querySelector('#hs-mc-upload-name')
  if (!btn || !file || !name) return
  btn.addEventListener('click', () => file.click())
  file.addEventListener('change', () => mcEuPick(file.files?.[0]))
  picker.querySelector('#hs-mc-upload-go').addEventListener('click', mcEmoteUploadSubmit)
  picker.querySelector('#hs-mc-upload-cancel').addEventListener('click', () => {
    mcEuStatus('')
    mcEuReset()
    btn.focus()
  })
  // Enter adds, Esc backs out of the form only. The picker's own Esc (a
  // document listener) must not also close the whole panel under you.
  name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      mcEmoteUploadSubmit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (_mcEuBusy) return
      mcEuStatus('')
      mcEuReset()
      btn.focus()
    }
  })
}
