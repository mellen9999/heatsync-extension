// The mark a line you sent leaves in the chat when it did not land (the site's red / yellow rail,
// client/components/chat-tile/send.js). A line that posts is simply the normal row its echo makes,
// so only the two bad endings need a row of their own:
//
//   refused      ✗  the platform said no, or the send failed outright: a red rail
//   unconfirmed  ?  nothing came back in time; it may have posted: a yellow rail
//
// The row is a synthetic notice (never archived) put through the same pipeline as every system
// row, so it scrolls, redraws and survives a tab switch. A late echo, or a retry, retires it.
// The toast with the retry button stays: this is the part that is still there afterwards.

// reasons that mean "we do not know", not "it was refused"
const SEND_MARK_UNCONFIRMED = new Set(['no_echo', 'kick_unconfirmed', 'send_not_confirmed', 'bridge_timeout'])

/** the words for why a send failed, in the viewer's language (the toast and the row say the same) */
function sendFailWhy(reason, platforms) {
  const key = {
    auth_failed: 'mc_notif_r_auth_failed',
    no_user: 'mc_notif_r_no_user',
    connect_failed: 'mc_notif_r_connect_failed',
    send_failed: 'mc_notif_r_send_failed',
    kick_not_logged_in: 'mc_notif_r_kick_not_logged_in',
    no_kick_tab: 'mc_notif_r_no_kick_tab',
    kick_bridge_timeout: 'mc_notif_r_kick_bridge_timeout',
    no_channel: 'mc_notif_r_no_channel',
    // not worded as a failure: kick may well have posted it (kick-send.js KICK_SEND_TIMEOUT_MS)
    kick_unconfirmed: 'mc_notif_r_kick_unconfirmed',
    'missing params': 'mc_notif_r_missing_params',
    no_youtube_tab: 'mc_notif_r_no_youtube_tab',
    no_input: 'mc_notif_r_no_input',
    chat_disabled: 'mc_notif_r_chat_disabled',
    send_disabled: 'mc_notif_r_send_disabled',
    send_not_confirmed: 'mc_notif_r_send_not_confirmed',
    bridge_timeout: 'mc_notif_r_bridge_timeout',
  }[reason]
  if (key) return t(key)
  const str = String(reason || '')
  if (str === 'no_echo') {
    // name the platform(s) that never confirmed: a kick or yt no-echo used to blame twitch
    const plat = (platforms || []).map((p) => (p === 'yt' ? 'youtube' : p)).join('+')
    return t('mc_notif_r_no_echo', [plat || t('mc_notif_r_platform')])
  }
  if (str.startsWith('chat_restricted')) {
    // "chat_restricted:<yt's human reason>": surface yt's own words
    const detail = str.includes(':') ? str.slice(str.indexOf(':') + 1).toLowerCase() : ''
    return detail ? t('mc_notif_r_restricted_detail', [detail]) : t('mc_notif_r_restricted')
  }
  return str || t('mc_notif_r_unknown')
}

/** 'refused' | 'unconfirmed' */
function sendMarkKind(reason) {
  return SEND_MARK_UNCONFIRMED.has(String(reason)) ? 'unconfirmed' : 'refused'
}

/** the row's own words: its mark, then why, then what you said */
function sendMarkText(kind, why, text) {
  const snippet = String(text || '').slice(0, 60) + (String(text || '').length > 60 ? '…' : '')
  return `${kind === 'refused' ? '✗' : '?'} ${t('mc_notif_pending_line', [why, snippet])}`
}

/**
 * Put the mark in the chat of the room the line went to. Twitch rooms through the irc client,
 * kick through its buffer; a youtube-only send has no room buffer to put a row in, so it keeps
 * the toast alone.
 * @param {{ synthId: string, text: string, channel: string, platforms?: Iterable<string>, markId?: string }} entry
 * @param {string} reason
 * @returns {string} the row's id ('' when no room could take it)
 */
function injectSendMark(entry, reason) {
  try {
    const ch = String(entry.channel || '')
      .toLowerCase()
      .replace(/^#/, '')
    if (!ch) return ''
    const kind = sendMarkKind(reason)
    const why = sendFailWhy(reason, [...(entry.platforms || [])])
    const id = `hs-synth-send-${kind}-${entry.synthId}`
    const text = sendMarkText(kind, why, entry.text)
    const m = {
      type: 'notice',
      noticeType: kind === 'refused' ? 'hs_send_refused' : 'hs_send_unconfirmed',
      sendMark: kind,
      user: 'system',
      text,
      systemMsg: text,
      color: '#ffffff',
      badges: '',
      channel: ch,
      time: Date.now(),
      id,
      isSynthetic: true,
    }
    if (typeof irc !== 'undefined' && irc?.channels?.has(ch)) {
      irc._handleMsg?.(m)
      return id
    }
    const buf = typeof kickChat !== 'undefined' ? kickChat?.channels?.get(ch) : null
    if (buf) {
      buf.push({ ...m, platform: 'kick' })
      kickChat.emit('message', { ...m, platform: 'kick' })
      return id
    }
  } catch (_) {}
  return ''
}

/** the line posted after all, or is being sent again: its mark stops being true */
function retireSendMark(entry) {
  const id = entry?.markId
  if (!id) return
  entry.markId = ''
  try {
    const ch = String(entry.channel || '')
      .toLowerCase()
      .replace(/^#/, '')
    const held = (typeof irc !== 'undefined' ? irc?.getMessages?.(ch) : null) || []
    const row = held.find((m) => m.id === id)
    if (row) row.resolved = true
    const kb = typeof kickChat !== 'undefined' ? kickChat?.channels?.get(ch) : null
    const krow = kb?.getAll?.().find((m) => m.id === id)
    if (krow) krow.resolved = true
    const safe = CSS.escape ? CSS.escape(id) : id.replace(/"/g, '\\"')
    const el = document.querySelector(`.hs-mc-msg[data-msg-id="${safe}"]`)
    if (el) removeRow(el)
  } catch (_) {}
}
