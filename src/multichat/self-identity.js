// Self identity — who "me" is, per platform. One twitch string (currentUsername)
// used to answer for every row, so a kick-only or youtube-only viewer was never
// "me" anywhere: no filter exemption, mod toolbar on their own rows, no pin gate.
//
//   isSelf(msg, platform?)   true when msg.user is this viewer on that platform
//
// Sources per platform (all lowercase, any that exist):
//   twitch   currentUsername, the auth-irc nick, heatsync twitch_username
//   kick     the kick session's username (kick_session_status), heatsync kick_username
//   youtube  heatsync youtube_username, the author chip in youtube's own chat frame

let selfKickName = '' // set from kick_session_status; no heatsync login needed
let selfHsNames = { twitch: '', kick: '', youtube: '' } // heatsync account's per-platform names
let _ytChip = { at: 0, name: '' } // the chip read walks an iframe DOM — cache it

function setSelfHsNames(ui) {
  const low = (v) => (v ? String(v).toLowerCase() : '')
  selfHsNames = { twitch: low(ui?.twitch_username), kick: low(ui?.kick_username), youtube: low(ui?.youtube_username) }
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
