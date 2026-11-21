// Mod log: twitch's own record of who did each action. For a mod who granted
// heatsync's `modlog` pack, the server holds one channel.moderate sub per
// channel they moderate and sends each action to their own sockets
// (modlog:action → background.js → modlog_action here); mod-log.js names the
// entry or adds the unban. This keeps those subs alive for the joined
// channels the user mods (the server drops one nobody refreshed for 48h) and
// learns, from the server's answer, when the pack is not granted yet: the mod
// log tab then offers it. Nothing is asked of anyone who mods nowhere.

const MODLOG_SWEEP_MS = 25 * 60 * 1000
const MODLOG_GRANT_URL = 'https://heatsync.org/api/auth/login?scopes=modlog&return_to=%2Fhome%2Fhot'
let _modlogNeedsPack = false
const _onceGuardsModlog = {}

async function modlogSweep() {
  if (_modlogNeedsPack || typeof config === 'undefined' || !Array.isArray(config?.channels)) return
  for (const ch of config.channels) {
    const login = (ch?.twitch || '').toLowerCase()
    if (!login) continue
    try {
      const self = await automodSelfLogin()
      if (login !== self && !(typeof isModFor === 'function' && (await isModFor(login)))) continue
      const broadcasterId = await resolveAutomodBroadcasterId(login)
      if (!broadcasterId) continue
      const res = await safeSendMessage({ type: 'modlog_watch', broadcasterId })
      if (res?.error === 'needs_pack') {
        _modlogNeedsPack = true
        if (typeof currentTab !== 'undefined' && currentTab === 'modlog') renderModLogTab()
        return
      }
    } catch (_) {
      // one channel's failure is that channel's: the next sweep asks again
    }
  }
}

/** The mod log's "let twitch say who did it" offer, or null when not needed. */
function modlogConnectRow() {
  if (!_modlogNeedsPack) return null
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'hs-modlog-connect'
  btn.textContent = t('mc_modlog_connect')
  btn.addEventListener('click', () => window.open(MODLOG_GRANT_URL, '_blank', 'noopener'))
  return btn
}

function initModLogWatch() {
  if (!_onceGuardsModlog.messageListener) {
    _onceGuardsModlog.messageListener = true
    cleanup.addListener(chrome.runtime?.onMessage, (msg) => {
      if (msg?.type !== 'modlog_action') return
      if (modLogStore.applyFrame(msg) && typeof currentTab !== 'undefined' && currentTab === 'modlog') renderModLogTab()
    })
  }
  cleanup.setTimeout(() => modlogSweep(), 4000)
  cleanup.setInterval(() => modlogSweep(), MODLOG_SWEEP_MS)
}
