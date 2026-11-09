// emote-upload-core.js — the rules and the two calls behind "upload your own
// emote", shared by the overlay picker (emote-upload.js) and the native picker
// (content/heatsync-button.js). Self-contained: no imports, only the global `t`
// every bundle has. One copy of the caps, name rules, error words and request
// shapes — each picker only draws the form and says the outcome its own way.
//
// The same two calls the site makes — POST /api/upload (type=emote), then
// POST /api/user/emotes (source=upload) — both via the background worker
// (api_upload, add_to_inventory): a content script's own request to heatsync.org
// is cross-origin from twitch/kick/youtube, which the host page's CORS and
// cloudflare's edge both refuse. The worker carries the stored token as a Bearer.

// Mirrors the server's image cap (UPLOAD_CONFIG.MAX_IMAGE_SIZE).
const HS_EU_MAX_BYTES = 10 * 1048576
const HS_EU_ACCEPT = 'image/png,image/gif,image/webp,image/jpeg,image/avif'
const HS_EU_TYPES = HS_EU_ACCEPT.split(',')

// The word you will type in chat: the file's name without its extension or a
// "-2x" size suffix, reduced to letters, digits and underscore.
function hsEuDefaultName(file) {
  const stem = String(file?.name || '')
    .replace(/\.[^.]+$/, '')
    .replace(/-[1-4]x$/i, '')
    .replace(/[^A-Za-z0-9_]/g, '')
  return stem.slice(0, 30) || 'emote'
}

// Why this file cannot be uploaded, in plain words, or '' when it can.
function hsEuFileProblem(file) {
  if (!HS_EU_TYPES.includes(file?.type)) return t('mc_emote_upload_bad_type')
  if (file.size > HS_EU_MAX_BYTES) return t('mc_input_upload_too_large', [String(HS_EU_MAX_BYTES / 1048576)])
  return ''
}

// A name is one word: something, with no whitespace.
function hsEuNameOk(name) {
  return !!name && !/\s/.test(name)
}

// What the server said, in words anyone can act on. `null` = not signed in (the
// login nudge says that, with a button).
function hsEuReason(r) {
  const status = Number(r?.status) || 0
  const err = String(r?.error || '')
  if (status === 401 || /not logged in|log in/i.test(err)) return null
  if (status === 429) return t('mc_emote_upload_slow')
  if (status === 413 || /^file too large/i.test(err))
    return t('mc_input_upload_too_large', [String(HS_EU_MAX_BYTES / 1048576)])
  if (/community guidelines|violates/i.test(err)) return t('mc_emote_upload_blocked')
  if (/mismatch|unsupported file type|not allowed/i.test(err)) return t('mc_emote_upload_bad_type')
  if (/daily upload limit/i.test(err)) return t('mc_emote_upload_limit')
  return t('mc_input_upload_failed_why', [err.toLowerCase() || t('mc_input_upload_failed')])
}

function hsEuReadDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.addEventListener('load', () => resolve(String(fr.result || '')))
    fr.addEventListener('error', () => reject(new Error('could not read file')))
    fr.readAsDataURL(file)
  })
}

/**
 * Upload `file` (unless `uploaded` — its earlier answer — is passed) and put it
 * in your set as `name`. `send` is the surface's own message sender.
 *   {kind:'added', added, up}   in your set
 *   {kind:'upload_failed', r}   nothing kept on the server: start over with a file
 *   {kind:'taken', r, up}       name is held: keep `up`, pick another name
 *   {kind:'failed', r, up}      server said no: keep `up`
 */
async function hsEuSubmit(send, file, name, uploaded) {
  let up = uploaded
  if (!up) {
    const resp = await send({
      type: 'api_upload',
      emote: true,
      name: file.name || 'emote',
      mime: file.type,
      dataUrl: await hsEuReadDataUrl(file),
    })
    if (!resp?.ok || !resp.url) return { kind: 'upload_failed', r: resp }
    up = resp
  }
  const added = await send({
    type: 'add_to_inventory',
    emoteName: name,
    emoteUrl: up.url,
    zeroWidth: false,
    upload: { phash: up.phash, width: up.width, height: up.height },
  })
  if (added?.success) return { kind: 'added', added, up }
  const taken =
    Number(added?.status) === 409 || /already in inventory|held by your upload/i.test(String(added?.error || ''))
  return { kind: taken ? 'taken' : 'failed', r: added, up }
}
