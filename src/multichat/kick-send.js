// Kick chat sending — routes through background.js → kick.com tab content script

const kickChannelIdCache = new Map()
const KICK_CHANNEL_ID_CACHE_MAX = 200

// Failures we never retry — they're user-actionable, not transient.
const KICK_FATAL_SEND_ERRORS = new Set(['no_channel', 'no_kick_tab', 'kick_not_logged_in', 'missing params'])

// Exceeds the relay POST's own AbortSignal.timeout (10s in content.js
// kick_send_relay) so a timeout here means the POST is done waiting too.
//
// It does NOT mean the send didn't happen. Aborting only stops the client
// listening for the response — if kick already accepted the POST and the
// reply was merely slow, the message IS in chat. Kick's send API has no
// idempotency key, so there is no way to retry without risking a double
// post. This used to auto-retry on the claim that outwaiting the abort made
// the first attempt "dead"; it doesn't, and the guarantee was fiction. A
// timeout now returns unconfirmed and stops, and the user decides.
const KICK_SEND_TIMEOUT_MS = 11000
const KICK_SEND_RETRY_BACKOFF_MS = [750, 1500]

async function resolveKickChannelId(slug) {
  if (kickChannelIdCache.has(slug)) return kickChannelIdCache.get(slug)
  const resp = await safeSendMessage({ type: 'kick_resolve_channel', slug })
  if (resp?.channelId) {
    if (kickChannelIdCache.size >= KICK_CHANNEL_ID_CACHE_MAX) {
      kickChannelIdCache.delete(kickChannelIdCache.keys().next().value)
    }
    kickChannelIdCache.set(slug, resp.channelId)
    return resp.channelId
  }
  return null
}

function _kickSendOnce(channelId, text, reply = null) {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve({ ok: false, error: 'timeout' })
    }, KICK_SEND_TIMEOUT_MS)
    safeSendMessage({ type: 'kick_send_message', channelId, content: text, reply })
      .then((resp) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(resp || { ok: false, error: 'no_response' })
      })
      .catch((e) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ ok: false, error: e?.message || 'send_failed' })
      })
  })
}

async function sendKickMessage(kickSlug, text, reply = null) {
  const channelId = await resolveKickChannelId(kickSlug)
  if (!channelId) return 'no_channel'
  let lastErr = 'send_failed'
  let replyRef = reply
  // Mutable: an INVALID_EMOTE rejection rewrites this to the de-tokenized form.
  let body = text
  for (let attempt = 0; attempt <= KICK_SEND_RETRY_BACKOFF_MS.length; attempt++) {
    try {
      const resp = await _kickSendOnce(channelId, body, replyRef)
      if (resp?.ok) return true
      const err = resp?.error || 'send_failed'
      lastErr = err
      // Reply-shaped send rejected by kick (4xx) → the message itself is fine,
      // only the threading ref was refused. Deliver flat rather than fail.
      // Checked on the relay's own status field, not the (now human-readable,
      // not status-prefixed) error text.
      if (replyRef && resp?.status >= 400 && resp?.status < 500) {
        replyRef = null
        attempt-- // the flat resend shouldn't consume a retry slot
        continue
      }
      // Kick VALIDATES emote tokens and 400s the WHOLE message on a bad one
      // (INVALID_EMOTE_ERROR, confirmed live 2026-07-21). Our outgoing rewrite
      // (kickifyEmoteText) can hand kick an id that has since been removed,
      // gated behind a sub, or belongs to another channel — and then a message
      // that used to send as plain words wouldn't send at all, which is
      // strictly worse than not rendering an emote. Strip the tokens back to
      // bare names and deliver. Checked via the relay's own `code` field, not
      // the error text (which is human copy now, not kick's raw body).
      if (resp?.code === 'invalid_emote' && /\[emote:\d+:/.test(body)) {
        body = typeof _unkickEmotes === 'function' ? _unkickEmotes(body) : body.replace(/\[emote:\d+:([^\]]+)\]/g, '$1')
        attempt-- // the de-tokenized resend shouldn't consume a retry slot
        continue
      }
      // Unresolved, not failed — see KICK_SEND_TIMEOUT_MS. Never auto-retried.
      if (err === 'timeout') return 'kick_unconfirmed'
      if (KICK_FATAL_SEND_ERRORS.has(err)) return err
      if (attempt < KICK_SEND_RETRY_BACKOFF_MS.length) {
        await new Promise((r) => setTimeout(r, KICK_SEND_RETRY_BACKOFF_MS[attempt]))
        continue
      }
      return err
    } catch (e) {
      lastErr = e?.message || 'send_failed'
      if (attempt < KICK_SEND_RETRY_BACKOFF_MS.length) {
        await new Promise((r) => setTimeout(r, KICK_SEND_RETRY_BACKOFF_MS[attempt]))
        continue
      }
      log('Kick send error after retries:', lastErr)
      return 'send_failed'
    }
  }
  return lastErr
}

// ─── Kick chat modes ────────────────────────────────────────────────────────
// PUT /api/v1/chatrooms/<chatroomId>, relayed through a kick.com tab (kick's
// mutations need that tab's cookies + XSRF + bearer).
//
// Everything here was proven against the live API on 2026-07-21, and two of the
// first guesses were WRONG — worth writing down so nobody re-derives them:
//   · the body is FLAT BOOLEANS, not the nested shape the GET returns. Sending
//     {slow_mode:{enabled:true,...}} 422s with
//     "This field must be true or false [slow mode]."
//   · GET /api/v2/channels/<slug>/chatroom is CACHED — it still reported
//     enabled:false while the row was already true. Useless as a confirmation
//     oracle. The PUT's OWN response body returns the authoritative row, so
//     that is what we verify against (and it costs no extra request).
//   · the slow-mode interval could not be set through this route under any
//     field name tried (message_interval / slow_mode_interval / interval, as
//     number and string — the row came back 0 every time). So kick gets the
//     mode toggled at kick's own interval; only twitch honours an exact N.
const KICK_CHAT_MODE_KEYS = {
  slow: 'slow_mode',
  followers: 'followers_mode',
  subscribers: 'subscribers_mode',
  emoteonly: 'emotes_mode',
}

// mode + value → the flat body kick accepts. Everything is a boolean toggle;
// twitch's -1 "off" encoding collapses to false, and any non-negative duration
// means "on" (kick picks the interval itself — see the note above).
function kickChatModeBody(mode, value) {
  const key = KICK_CHAT_MODE_KEYS[mode]
  if (!key) return null
  let on
  if (mode === 'followers' || mode === 'slow') on = Number(value) >= (mode === 'followers' ? 0 : 1)
  else on = !!value
  const body = { [key]: on }
  // Sent for slow because kick's own client includes it; kick currently ignores
  // it, and the verifier below deliberately does NOT assert on it.
  if (mode === 'slow') body.message_interval = on ? Math.max(1, Number(value) || 1) : 0
  return body
}

// The PUT response row is the source of truth. Only the mode flag is asserted —
// message_interval is knowingly not honoured by this route, so demanding it
// would fail every /slow that actually worked.
function kickChatModeMatches(mode, value, row) {
  const key = KICK_CHAT_MODE_KEYS[mode]
  if (!row || typeof row !== 'object' || !(key in row)) return false
  const want = kickChatModeBody(mode, value)[key]
  return !!row[key] === !!want
}

async function setKickChatMode(slug, mode, value) {
  const body = kickChatModeBody(mode, value)
  if (!body) return { ok: false, error: 'kick has no such chat mode' }
  // BG resolves + caches the chatroom id; the public chatroom read is the
  // fallback so a cold SW can't block a mod action.
  let chatroomId = null
  try {
    chatroomId = (await safeSendMessage({ type: 'kick_chatroom_id', slug }))?.id || null
  } catch {}
  if (!chatroomId) {
    try {
      const r = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}/chatroom`, {
        headers: { accept: 'application/json' },
      })
      if (r.ok) chatroomId = (await r.json())?.id || null
    } catch {}
  }
  if (!chatroomId) return { ok: false, error: 'kick chatroom not found' }
  const resp = await safeSendMessage({ type: 'kick_set_chat_mode', chatroomId, body })
  if (!resp?.ok) return { ok: false, error: resp?.error || 'kick_set_failed' }
  // Confirm against the row kick echoed back. A 200 alone proves nothing — the
  // 422 that caught the nested-body guess returned no change at all.
  if (!kickChatModeMatches(mode, value, resp.row)) {
    return { ok: false, error: 'kick did not apply it (mod rights?)' }
  }
  return { ok: true }
}
