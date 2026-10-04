// mod suite calls — shield, warn, shoutout, unban requests, automod, chatters
// for a twitch channel's moderators, through heatsync.org's /api/mod/* by way of
// the background worker (content scripts must not fetch heatsync.org
// themselves — see resolve_twitch_id). The panel (mod-suite.js), the slash
// commands, the row menu and the toolbar all come through here, so a failure
// reads the same on every surface.
//
//   msCall(channel, op, extra)   → {ok, data} | {ok:false, error, message}
//   msWarnPrompt(channel, login) one-line reason prompt in the pane, then warns
//   msShoutout(channel, login)   one call, the result is a toast
//
// error: relink_required | auth_required | not_moderator | rate_limited | gone | error
// message: the server's own words (twitch's, on a refusal); '' when it had none.

const MS_RELINK_URL = 'https://heatsync.org/api/auth/login?scopes=modsuite&return_to=%2Fhome%2Fhot'
const MS_REASON_MAX = 500

async function msCall(channel, op, extra = {}) {
  return (
    (await safeSendMessage({ type: 'mod_suite', channel, op, ...extra })) || { ok: false, error: 'error', message: '' }
  )
}

// a failed call → the panel view it implies; null = an error that only speaks
function msViewFor(res) {
  if (res?.error === 'relink_required') return 'perm'
  if (res?.error === 'auth_required') return 'auth'
  if (res?.error === 'not_moderator') return 'notmod'
  return null
}

// the words a failure is shown in: the server's, else ours
function msWords(res) {
  const v = msViewFor(res)
  if (v === 'perm') return t('mc_ms_need_perm')
  if (v === 'auth') return t('mc_automod_signin')
  if (v === 'notmod') return t('mc_ms_not_mod')
  return res?.message || t('mc_ms_err')
}

function msAllow() {
  try {
    window.open(MS_RELINK_URL, '_blank', 'noopener')
  } catch (_) {}
}

// a failure as a toast; a missing permission opens the panel, which carries the
// relink button (a toast cannot hold one)
function msToastFail(res, channel) {
  showToast(msWords(res), 'error')
  if (msViewFor(res) === 'perm' && channel && typeof openModSuite === 'function') openModSuite(channel, 'shield')
}

async function msShoutout(channel, login) {
  const res = await msCall(channel, 'shoutout', { user: login })
  if (res.ok) showToast(t('mc_ms_shouted', [login]), 'success')
  else msToastFail(res, channel)
  return res
}

async function msWarn(channel, login, reason) {
  const res = await msCall(channel, 'warn', { user: login, reason })
  if (res.ok) showToast(t('mc_ms_warned', [login]), 'success')
  else msToastFail(res, channel)
  return res
}

// Ask for a warning's reason in the pane (enter sends, esc cancels), then send
// it. Twitch requires a reason, so an empty one is not sent. Resolves the call's
// result, or null when cancelled.
function msWarnPrompt(channel, login) {
  return new Promise((resolve) => {
    const body = document.createElement('div')
    const msg = document.createElement('div')
    msg.className = 'hs-mc-confirm-msg'
    msg.textContent = t('mc_ms_warn_to', [login])
    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'hs-ms-input'
    input.maxLength = MS_REASON_MAX
    input.autocomplete = 'off'
    input.placeholder = t('mc_ms_reason_ph')
    input.setAttribute('aria-label', t('mc_ms_reason_ph'))
    body.append(msg, input)
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'hs-mc-confirm-cancel'
    cancel.textContent = t('mc_ms_cancel')
    const send = document.createElement('button')
    send.type = 'button'
    send.className = 'hs-mc-confirm-ok'
    send.textContent = t('mc_ms_warn_send')
    let finishRef = null
    const submit = () => {
      if (input.value.trim()) finishRef?.(true, true)
      else input.focus()
    }
    cancel.addEventListener('click', () => finishRef?.(false, true))
    send.addEventListener('click', submit)
    const panel = hsPanePanelOpenWith({
      label: t('mc_ms_warn_to', [login]),
      body,
      buttons: [cancel, send],
      onKey: (e) => {
        if (e.key !== 'Enter') return
        e.preventDefault()
        e.stopPropagation()
        submit()
      },
      onDone: (ok) => {
        const reason = input.value.trim().slice(0, MS_REASON_MAX)
        if (ok && reason) msWarn(channel, login, reason).then(resolve)
        else resolve(null)
      },
    })
    if (!panel) return resolve(null)
    finishRef = activePanePanel.finish
    input.focus()
  })
}
