// chat modes — set a twitch channel's chat modes through heatsync.org.
// Twitch retired the IRC commands for emote-only / subs-only / unique-chat, and
// helix PATCH chat/settings is the only way left; heatsync.org's
// /api/mod/chat-settings does that call with the viewer's linked twitch grant.
// This talks to it through the background worker (content scripts must not
// fetch heatsync.org themselves — see resolve_twitch_id).
//
//   cmSet(channel, cmd, value)     → {ok, settings} | {ok:false, error}
//   cmGet(channel)                 → {ok, settings} | {ok:false, error}
//   cmMountControls(grid, status, channel)   the modes cell: real state, live toggles
//
// cmd: followers|slow|emoteonly|subscribers|unique, value: followers −1=off,
// 0=any follower, N=minutes · slow 0=off, N=seconds · booleans for the rest.

const CM_RELINK_URL = 'https://heatsync.org/api/auth/login?scopes=mod&return_to=%2Fhome%2Fhot'
const CM_SLOW_MIN = 3
const CM_SLOW_MAX = 120
const CM_FOLLOW_MAX = 129600

// cell rows in order; `num` = the mode carries a number the user types
const CM_ROWS = [
  { cmd: 'emoteonly', label: 'mc_cm_emote', on: (s) => s.emote_mode === true },
  {
    cmd: 'followers',
    label: 'mc_cm_follower',
    num: 'mc_cm_min',
    on: (s) => s.follower_mode === true,
    n: (s) => s.follower_mode_duration,
  },
  { cmd: 'subscribers', label: 'mc_cm_sub', on: (s) => s.subscriber_mode === true },
  {
    cmd: 'slow',
    label: 'mc_cm_slow',
    num: 'mc_cm_sec',
    on: (s) => s.slow_mode === true,
    n: (s) => s.slow_mode_wait_time,
  },
  { cmd: 'unique', label: 'mc_cm_unique', on: (s) => s.unique_chat_mode === true },
]

// one mode + value → the POST's settings fields (the helix names); null = unknown mode
function cmBody(cmd, value) {
  if (cmd === 'emoteonly') return { emote_mode: !!value }
  if (cmd === 'subscribers') return { subscriber_mode: !!value }
  if (cmd === 'unique') return { unique_chat_mode: !!value }
  if (cmd === 'followers') {
    const n = Number(value)
    if (!Number.isFinite(n) || n < 0) return { follower_mode: false }
    return { follower_mode: true, follower_mode_duration: Math.min(CM_FOLLOW_MAX, Math.trunc(n)) }
  }
  if (cmd === 'slow') {
    const n = Number(value)
    if (!Number.isFinite(n) || n <= 0) return { slow_mode: false }
    return { slow_mode: true, slow_mode_wait_time: Math.max(CM_SLOW_MIN, Math.min(CM_SLOW_MAX, Math.trunc(n))) }
  }
  return null
}

async function cmGet(channel) {
  return (await safeSendMessage({ type: 'chat_settings', op: 'get', channel })) || { ok: false, error: 'no reply' }
}

async function cmSet(channel, cmd, value) {
  const settings = cmBody(cmd, value)
  if (!settings) return { ok: false, error: 'unknown chat mode' }
  return (
    (await safeSendMessage({ type: 'chat_settings', op: 'set', channel, settings })) || { ok: false, error: 'no reply' }
  )
}

// the account isn't linked for mod calls: 401 either way (no heatsync session,
// or a twitch grant without the mod pack)
function cmNeedsLink(res) {
  return res?.error === 'relink_required' || res?.error === 'auth_required'
}

function cmEl(tag, cls, text) {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = text
  return n
}

// Replace the cell's read-only rows (IRC roomstate) with the channel's real
// settings and controls. `grid` keeps its rows if the viewer can't set modes
// (not a mod, not linked, offline) — `status` then says why when it's fixable.
async function cmMountControls(grid, status, channel) {
  const say = (text, bad) => {
    status.textContent = text || ''
    status.classList.toggle('hs-cm-bad', !!bad)
    status.hidden = !text
  }
  const res = await cmGet(channel)
  if (!grid.isConnected) return false
  if (!res.ok || !res.settings) {
    if (cmNeedsLink(res)) {
      say(t('mc_cm_link'), true)
      const b = cmEl('button', 'hs-cm-btn', t('mc_cm_link_btn'))
      b.type = 'button'
      b.addEventListener('click', () => {
        try {
          window.open(CM_RELINK_URL, '_blank', 'noopener')
        } catch (_) {}
      })
      status.append(' ', b)
    }
    return false
  }
  let settings = res.settings

  const render = () => {
    const rows = CM_ROWS.map((r) => {
      const on = r.on(settings)
      const row = cmEl('div', 'hs-mc-status-row hs-cm-row')
      row.dataset.mode = r.cmd
      const key = cmEl('span', 'hs-mc-status-key', t(r.label))
      const ctl = cmEl('span', 'hs-cm-ctl')
      let num = null
      if (r.num) {
        num = cmEl('input', 'hs-cm-num')
        num.type = 'number'
        num.min = r.cmd === 'slow' ? String(CM_SLOW_MIN) : '0'
        num.max = r.cmd === 'slow' ? String(CM_SLOW_MAX) : String(CM_FOLLOW_MAX)
        num.value = on && r.n(settings) != null ? String(r.n(settings)) : ''
        num.placeholder = t(r.num)
        num.setAttribute('aria-label', `${t(r.label)} ${t(r.num)}`)
        num.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter') return
          e.preventDefault()
          e.stopPropagation()
          const n = Number(num.value)
          if (num.value.trim() === '' || !Number.isFinite(n) || n < 0)
            return say(t('mc_input_usage_mode', [r.cmd]), true)
          apply(r, n)
        })
        num.addEventListener('keyup', (e) => e.stopPropagation())
        ctl.append(num)
      }
      const tog = cmEl('button', `hs-mc-status-val hs-cm-tog ${on ? 'on' : 'off'}`, t(on ? 'mc_cm_on' : 'mc_cm_off'))
      tog.type = 'button'
      tog.setAttribute('aria-pressed', on ? 'true' : 'false')
      tog.addEventListener('click', () => {
        // turning a duration mode on takes what's typed, else twitch's own default
        const typed = num && num.value.trim() !== '' ? Number(num.value) : null
        const onValue = typed != null && Number.isFinite(typed) ? typed : r.cmd === 'slow' ? 30 : 0
        apply(r, on ? (r.cmd === 'followers' ? -1 : r.cmd === 'slow' ? 0 : false) : r.num ? onValue : true)
      })
      ctl.append(tog)
      row.append(key, ctl)
      return row
    })
    grid.replaceChildren(...rows)
  }

  let busy = false
  async function apply(r, value) {
    if (busy) return
    busy = true
    grid.classList.add('hs-cm-busy')
    const out = await cmSet(channel, r.cmd, value)
    busy = false
    grid.classList.remove('hs-cm-busy')
    if (!grid.isConnected) return
    if (out.ok) {
      // the POST answers only {success}: re-read so the cell shows what twitch
      // holds, and fall back to the fields we just sent if the read fails
      const again = await cmGet(channel)
      if (!grid.isConnected) return
      settings = again.ok && again.settings ? again.settings : { ...settings, ...cmBody(r.cmd, value) }
      say('')
      return render()
    }
    if (cmNeedsLink(out)) return say(t('mc_cm_link'), true)
    if (out.error === 'not_moderator') return say(t('mc_cm_not_mod'), true)
    say(t('mc_input_mode_failed', [t(r.label), out.error || '?']), true)
  }

  say('')
  render()
  return true
}
