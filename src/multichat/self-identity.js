// Self identity — who "me" is, per platform. One twitch string (currentUsername)
// used to answer for every row, so a kick-only or youtube-only viewer was never
// "me" anywhere: no filter exemption, mod toolbar on their own rows, no pin gate.
//
//   isSelf(msg, platform?)   true when msg.user is this viewer on that platform
//   warnIdentityMismatch(k)  inline banner: chatting under an identity heatsync can't tie to the account
//
// Sources per platform (all lowercase, any that exist):
//   twitch   currentUsername, the auth-irc nick, heatsync twitch_username
//   kick     the kick session's username (kick_session_status), heatsync kick_username
//   youtube  heatsync youtube_username, the author chip in youtube's own chat frame

let selfKickName = '' // set from kick_session_status; no heatsync login needed
let selfHsNames = { twitch: '', kick: '', youtube: '' } // heatsync account's per-platform names
let selfHsAccount = '' // the heatsync account's own name, for messages that name it
let _ytChip = { at: 0, name: '' } // the chip read walks an iframe DOM — cache it

function setSelfHsNames(ui) {
  const low = (v) => (v ? String(v).toLowerCase() : '')
  selfHsNames = { twitch: low(ui?.twitch_username), kick: low(ui?.kick_username), youtube: low(ui?.youtube_username) }
  selfHsAccount = ui?.username ? String(ui.username) : ''
}

function setSelfKickName(name) {
  selfKickName = name ? String(name).toLowerCase() : ''
}

function _selfYtChip() {
  const now = Date.now()
  if (now - _ytChip.at < 5000) return _ytChip.name
  let name = ''
  try {
    name = ytSelfName().toLowerCase()
  } catch (_) {} // not defined yet (pre-init): no chip to read
  _ytChip = { at: now, name }
  return _ytChip.name
}

function selfNamesFor(platform) {
  const raw =
    platform === 'kick'
      ? [selfKickName, selfHsNames.kick]
      : platform === 'youtube'
        ? [selfHsNames.youtube, _selfYtChip()]
        : [
            typeof currentUsername === 'string' ? currentUsername : '',
            typeof authState !== 'undefined' && authState?.nick ? authState.nick : '',
            selfHsNames.twitch,
          ]
  return raw.map((n) => (n ? String(n).toLowerCase() : '')).filter(Boolean)
}

// platform: explicit when the caller knows the transport (an IRC handler); else
// the row's own badgePlatform/platform (irc rows leave both unset = twitch)
function isSelf(msg, platform) {
  const u = msg?.user ? String(msg.user).toLowerCase() : ''
  if (!u) return false
  let p = platform || msg.badgePlatform || msg.platform || 'twitch'
  if (p === 'yt') p = 'youtube'
  return selfNamesFor(p).includes(u)
}

// The chat accounts a send goes out as that the signed-in heatsync account is
// NOT linked to — [{ platform, name }]. Emotes live on the heatsync account,
// but a chat row renders against its sender's account, so an emote added from
// here shows as text on these. A platform whose live session name is unknown
// counts only when heatsync has no account there at all — youtube always, since
// its chip is a display name, not the handle heatsync stores. Signed out → [].
function unlinkedSendAccounts(platforms) {
  if (!selfHsAccount) return []
  const bare = (n) => (n ? String(n).toLowerCase().replace(/^@/, '') : '')
  const out = []
  for (const p of platforms) {
    const hs = bare(selfHsNames[p])
    const live = bare(
      p === 'kick'
        ? selfKickName
        : p === 'youtube'
          ? _selfYtChip()
          : (typeof currentUsername === 'string' && currentUsername) ||
            (typeof authState !== 'undefined' && authState?.nick) ||
            '',
    )
    if (!hs || (live && p !== 'youtube' && live !== hs)) out.push({ platform: p, name: live })
  }
  return out
}

// Identity-mismatch warning: the signed-in HS account can't be resolved from
// the identity the user is chatting under, so their HS emotes render for
// nobody else. Terse inline banner above the composer, once per senderKey per
// session, dismissible for good per (account, key) via ui_settings-style
// storage. Never fires when hsSenderKeys is unknown (old server/logged out).
const _identityWarned = new Set()
function warnIdentityMismatch(senderKey) {
  if (!senderKey || _identityWarned.has(senderKey)) return
  _identityWarned.add(senderKey)
  const dismissKey = `hs_idwarn_${hsCurrentUsername || ''}_${senderKey}`
  api.storage.local
    .get(dismissKey)
    .then((d) => {
      if (d?.[dismissKey]) return
      const bar = document.getElementById('hs-mc-inputbar')
      if (!bar || document.getElementById('hs-mc-idwarn')) return
      const el = document.createElement('div')
      el.id = 'hs-mc-idwarn'
      const acct = hsCurrentUsername || 'unknown'
      const ident = senderKey.replace(':', ' ')
      el.innerHTML = `<span>${t('mc_main_idwarn', [`<b>${escapeHtml(acct)}</b>`, `<b>${escapeHtml(ident)}</b>`, `<a href="https://heatsync.org/settings" target="_blank" rel="noopener">${t('mc_main_idwarn_link')}</a>`])}</span>${hsXButtonHtml('hs-x-inline', t('mc_main_dismiss'), `id="hs-mc-idwarn-x" title="${t('mc_main_dismiss')}"`)}`
      bar.parentNode.insertBefore(el, bar)
      el.querySelector('#hs-mc-idwarn-x')?.addEventListener('click', () => {
        el.remove()
        api.storage.local.set({ [dismissKey]: true })
      })
    })
    .catch(() => {})
}
