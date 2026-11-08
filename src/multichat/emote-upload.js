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

// Mirrors the server's image cap (UPLOAD_CONFIG.MAX_IMAGE_SIZE).
const MC_EU_MAX_BYTES = 10 * 1048576
const MC_EU_TYPES = ['image/png', 'image/gif', 'image/webp', 'image/jpeg', 'image/avif']

let _mcEuBusy = false
// What a retry reuses: the picked file, or — once it is on the server — its answer.
let _mcEuFile = null
let _mcEuUploaded = null

function mcEmoteUploadHtml() {
  return `<div class="hs-mc-upload" id="hs-mc-upload">
      <button type="button" class="hs-mc-upload-btn" id="hs-mc-upload-btn" title="${escapeHtml(t('mc_emote_upload_tip'))}">⇪ ${escapeHtml(t('mc_emote_upload'))}</button>
      <input type="file" id="hs-mc-upload-file" accept="${MC_EU_TYPES.join(',')}" hidden>
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

// The word you will type in chat: the file's name without its extension or a
// "-2x" size suffix, reduced to letters, digits and underscore.
function mcEuDefaultName(file) {
  const stem = String(file?.name || '')
    .replace(/\.[^.]+$/, '')
    .replace(/-[1-4]x$/i, '')
    .replace(/[^A-Za-z0-9_]/g, '')
  return stem.slice(0, 30) || 'emote'
}

function mcEuPick(file) {
  if (!file) return
  if (!MC_EU_TYPES.includes(file.type)) {
    mcEuStatus(t('mc_emote_upload_bad_type'), true)
    mcEuReset()
    return
  }
  if (file.size > MC_EU_MAX_BYTES) {
    mcEuStatus(t('mc_input_upload_too_large', [String(MC_EU_MAX_BYTES / 1048576)]), true)
    mcEuReset()
    return
  }
  _mcEuFile = file
  _mcEuUploaded = null
  mcEuStatus('')
  document.getElementById('hs-mc-upload-btn').hidden = true
  document.getElementById('hs-mc-upload-form').hidden = false
  const name = document.getElementById('hs-mc-upload-name')
  name.value = mcEuDefaultName(file)
  name.focus()
  name.select()
}

// What the server said, in words anyone can act on. `null` = not signed in (the
// login nudge says that, with a button).
function mcEuReason(r) {
  const status = Number(r?.status) || 0
  const err = String(r?.error || '')
  if (status === 401 || /not logged in|log in/i.test(err)) return null
  if (status === 429) return t('mc_emote_upload_slow')
  if (status === 413 || /^file too large/i.test(err))
    return t('mc_input_upload_too_large', [String(MC_EU_MAX_BYTES / 1048576)])
  if (/community guidelines|violates/i.test(err)) return t('mc_emote_upload_blocked')
  if (/mismatch|unsupported file type|not allowed/i.test(err)) return t('mc_emote_upload_bad_type')
  if (/daily upload limit/i.test(err)) return t('mc_emote_upload_limit')
  return t('mc_input_upload_failed_why', [err.toLowerCase() || t('mc_input_upload_failed')])
}

function mcEuFail(r) {
  const why = mcEuReason(r)
  if (why === null) {
    showEmoteLoginNudge()
    mcEuStatus(t('mc_emote_add_login'), true)
  } else {
    mcEuStatus(why, true)
  }
}

function mcEuReadDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.addEventListener('load', () => resolve(String(fr.result || '')))
    fr.addEventListener('error', () => reject(new Error('could not read file')))
    fr.readAsDataURL(file)
  })
}

async function mcEmoteUploadSubmit() {
  if (_mcEuBusy || !_mcEuFile) return
  const nameEl = document.getElementById('hs-mc-upload-name')
  const name = (nameEl?.value || '').trim()
  if (!name || /\s/.test(name)) {
    mcEuStatus(t('mc_emote_upload_name_bad'), true)
    nameEl?.focus()
    return
  }
  mcEuBusy(true)
  mcEuStatus(t('mc_input_uploading'))
  try {
    if (!_mcEuUploaded) {
      const resp = await safeSendMessage({
        type: 'api_upload',
        emote: true,
        name: _mcEuFile.name || 'emote',
        mime: _mcEuFile.type,
        dataUrl: await mcEuReadDataUrl(_mcEuFile),
      })
      if (!resp?.ok || !resp.url) {
        mcEuFail(resp)
        mcEuReset() // nothing was kept on the server: start over with another file
        return
      }
      _mcEuUploaded = resp
    }
    const up = _mcEuUploaded
    const added = await safeSendMessage({
      type: 'add_to_inventory',
      emoteName: name,
      emoteUrl: up.url,
      zeroWidth: false,
      upload: { phash: up.phash, width: up.width, height: up.height },
    })
    if (!added?.success) {
      if (
        Number(added?.status) === 409 ||
        /already in inventory|held by your upload/i.test(String(added?.error || ''))
      ) {
        mcEuStatus(t('mc_emote_upload_taken', [name]), true)
        nameEl?.focus()
        nameEl?.select()
      } else {
        mcEuFail(added)
      }
      return
    }
    mcEuAdded(name, added, up)
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
