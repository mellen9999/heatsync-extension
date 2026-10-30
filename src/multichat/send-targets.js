// send-targets.js — pure helpers deciding which linked platforms a chat
// message should be sent to for a given multichat channel config.
//
// No import/export: this file is concatenated (not module-loaded) into the
// multichat-<platform>.js bundle alongside input.js/main.js/channel-mgmt.js
// (see build.js MULTICHAT_MODULES) — plain top-level function declarations
// are shared globals across the whole bundle.

/**
 * @param {{twitch?: boolean, kick?: boolean, youtube?: boolean}|null|undefined} sendTargets
 *   Per-channel override, as persisted on config.channels[].sendTargets. A
 *   platform key that is absent/undefined defaults to ON — a channel with no
 *   sendTargets config behaves identically to before this feature existed.
 * @param {{twitch?: boolean, kick?: boolean, youtube?: boolean}} linkedPlatforms
 *   Which platforms are actually linked to this channel (sendTargets can't
 *   turn on a platform that isn't linked).
 * @returns {{twitch: boolean, kick: boolean, youtube: boolean}}
 */
function resolveSendTargets(sendTargets, linkedPlatforms) {
  const linked = ['twitch', 'kick', 'youtube'].filter((p) => !!linkedPlatforms?.[p])
  const out = { twitch: false, kick: false, youtube: false }
  for (const p of linked) {
    out[p] = sendTargets?.[p] !== false
  }
  // Bulletproof: a corrupted/emptied config can't silently swallow every
  // send — fall back to "all linked" rather than a message that goes nowhere.
  if (linked.length && !linked.some((p) => out[p])) {
    for (const p of linked) out[p] = true
  }
  return out
}

/**
 * Compute the next sendTargets object after toggling one platform on/off.
 * Seeds from "all currently linked platforms" the first time a channel's
 * sendTargets is touched, so flipping one platform never implicitly turns
 * off a platform the user hasn't interacted with (including one linked
 * later). Refuses to produce a config that disables every linked platform —
 * returns null in that case, which callers must treat as a no-op.
 * @param {{twitch?: boolean, kick?: boolean, youtube?: boolean}|null|undefined} currentSendTargets
 * @param {{twitch?: boolean, kick?: boolean, youtube?: boolean}} linkedPlatforms
 * @param {'twitch'|'kick'|'youtube'} platform
 * @param {boolean} enabled
 * @returns {{twitch?: boolean, kick?: boolean, youtube?: boolean}|null}
 */
function nextSendTargets(currentSendTargets, linkedPlatforms, platform, enabled) {
  if (!linkedPlatforms?.[platform]) return currentSendTargets || null
  const seeded = currentSendTargets
    ? { ...currentSendTargets }
    : Object.fromEntries(['twitch', 'kick', 'youtube'].filter((p) => linkedPlatforms[p]).map((p) => [p, true]))
  const next = { ...seeded, [platform]: enabled }
  const anyOn = ['twitch', 'kick', 'youtube'].some((p) => linkedPlatforms[p] && next[p] !== false)
  return anyOn ? next : null
}

/**
 * Pull the 11-char YouTube video id out of a watch / live / youtu.be url.
 * Returns '' for a bare channel url (/@handle, /channel/UC…, /@handle/live) —
 * those have NO fixed video id, and we must never hand background a guessed id
 * that could open (and send to) the wrong stream's chat. Only a concrete video
 * id ever comes back.
 * @param {string} url
 * @returns {string}
 */
function extractYoutubeVideoId(url) {
  const m = String(url || '').match(
    /(?:[?&]v=|\/live\/|\/shorts\/|youtu\.be\/|\/embed\/)([a-zA-Z0-9_-]{11})(?![a-zA-Z0-9_-])/,
  )
  return m ? m[1] : ''
}

// YouTube live chat's server-side message cap. Never confirmed via a public
// spec, but 200 is the long-observed practical ceiling — exceeding it gets
// the send rejected outright rather than truncated, so we treat it as a hard
// wall and skip the prepend rather than risk the send itself failing.
const YT_CHAT_MAX_LEN = 200

/** Per-platform chat message caps (chars). Twitch and Kick both allow 500. */
const CHAT_MAX_LEN = { twitch: 500, kick: 500, youtube: YT_CHAT_MAX_LEN }

/**
 * The composer's length cap for what the next send reaches: the tightest cap
 * among the active legs (a mirrored youtube leg is rejected past 200, not
 * truncated). No leg known → the 500 default.
 * @param {{twitch?: boolean, kick?: boolean, youtube?: boolean}|null|undefined} legs
 * @returns {number}
 */
function composerCharLimit(legs) {
  let lim = 500
  for (const p of ['twitch', 'kick', 'youtube']) if (legs?.[p]) lim = Math.min(lim, CHAT_MAX_LEN[p])
  return lim
}

/**
 * YouTube live chat has no reply-threading API — sending the bare text drops
 * the reply context entirely. Degrade gracefully with the standard YT-chat
 * convention: prepend "@<author> " so the viewer sees who this was aimed at.
 * Twitch/Kick carry real reply metadata and must NEVER pass through this —
 * it's YT-leg-only.
 *
 * - No reply author → passthrough, untouched.
 * - User already typed the mention at the start (any case) → don't double it.
 * - Prepending would blow YouTube's length cap → skip the prepend rather than
 *   truncate anything; the plain text still sends.
 * @param {string} text
 * @param {string|null|undefined} replyAuthor
 * @returns {string}
 */
function ytReplyText(text, replyAuthor) {
  const body = String(text || '')
  // yt authors arrive with their own @ (handle form) — strip it or the
  // prepend doubles to "@@name" (seen live 2026-07-18)
  const author = String(replyAuthor || '')
    .trim()
    .replace(/^@+/, '')
  if (!author) return body
  const escapedAuthor = author.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const already = new RegExp(`^@${escapedAuthor}(?:\\s|$)`, 'i').test(body)
  if (already) return body
  const withMention = `@${author} ${body}`
  if (withMention.length > YT_CHAT_MAX_LEN) {
    log(`yt reply mention skipped — @${author} would push send over ${YT_CHAT_MAX_LEN} chars`)
    return body
  }
  return withMention
}

/**
 * Map a YouTube send-relay error code → a short, lowercase, actionable line.
 * YouTube has no send API usable at scale (Data API ≈ 50 msgs/day per project),
 * so every send drives a real logged-in youtube.com tab; each failure is about
 * that tab — missing, logged-out, still loading, or YT refusing the message.
 * @param {string} err
 * @returns {string}
 */
function youtubeSendErrorMessage(err) {
  // "chat_restricted:<yt's human reason>" — reason travels on the code string
  // (sendYoutubeMessage keeps the string protocol its callers compare against).
  const s = String(err || '')
  if (s.startsWith('chat_restricted')) {
    const reason = s.includes(':') ? s.slice(s.indexOf(':') + 1) : ''
    return reason ? t('mc_yt_send_restricted_reason', [reason.toLowerCase()]) : t('mc_yt_send_restricted')
  }
  switch (err) {
    case 'no_youtube_tab':
    case 'no_video':
      return t('mc_yt_send_open_stream')
    case 'chat_disabled':
      return t('mc_yt_send_login')
    case 'no_input':
      return t('mc_yt_send_loading')
    case 'send_disabled':
      return t('mc_yt_send_blocked')
    case 'send_not_confirmed':
      return t('mc_yt_send_not_confirmed')
    case 'bridge_timeout':
      return t('mc_yt_send_bridge_timeout')
    default:
      return t('mc_yt_send_failed')
  }
}

/**
 * Same job as youtubeSendErrorMessage, for the mod verbs. Only 'not_moderator'
 * had copy — every other code from youtube-content.js's handleYtModAction
 * reached the toast raw, so a mod would read "delete failed: message_not_found".
 * @param {string} err code from the yt mod relay
 * @returns {string}
 */
function youtubeModErrorMessage(err) {
  switch (err) {
    case 'not_moderator':
      return t('mc_yt_mod_not_moderator')
    case 'message_not_found':
      return t('mc_yt_mod_message_not_found')
    case 'no_context_menu':
      return t('mc_yt_mod_no_context_menu')
    case 'action_unmapped':
      return t('mc_yt_mod_action_unmapped')
    case 'yt_rejected':
      return t('mc_yt_mod_rejected')
    case 'not_signed_in':
      return t('mc_yt_mod_not_signed_in')
    case 'no_message':
      return t('mc_yt_mod_no_message')
    default:
      // An unknown code still beats nothing — pass it through rather than
      // flattening every future yt error into one useless sentence.
      return err ? String(err) : t('mc_common_unknown')
  }
}
