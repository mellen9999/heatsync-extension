// Auth IRC - authenticated Twitch IRC connection for sending messages

// Twitch NOTICE msg-id → user-friendly toast. Without this, rejected PRIVMSGs
// (slowmode/followers-only/duplicate/banned/AutoMod/...) silently clear the
// input and never echo back through the BG anonymous socket — the dominant
// "I sent it but it didn't post" symptom. The auth socket is the only socket
// Twitch sends these NOTICEs to. Set from https://dev.twitch.tv/docs/irc/msg-id/.
const TWITCH_SEND_REJECT_NOTICES = new Map([
  ['msg_followersonly', 'mc_irc_notice_followersonly'],
  ['msg_followersonly_followed', 'mc_irc_notice_followersonly_followed'],
  ['msg_followersonly_zero', 'mc_irc_notice_followersonly_zero'],
  ['msg_subsonly', 'mc_irc_notice_subsonly'],
  ['msg_emoteonly', 'mc_irc_notice_emoteonly'],
  ['msg_slowmode', 'mc_irc_notice_slowmode'],
  ['msg_r9k', 'mc_irc_notice_r9k'],
  ['msg_duplicate', 'mc_irc_notice_duplicate'],
  ['msg_banned', 'mc_irc_notice_banned'],
  ['msg_timedout', 'mc_irc_notice_timedout'],
  ['msg_rejected', 'mc_irc_notice_rejected'],
  ['msg_rejected_mandatory', 'mc_irc_notice_rejected_mandatory'],
  ['msg_channel_suspended', 'mc_irc_notice_channel_suspended'],
  ['msg_channel_blocked', 'mc_irc_notice_channel_blocked'],
  ['msg_verified_email', 'mc_irc_notice_verified_email'],
  ['msg_requires_verified_phone_number', 'mc_irc_notice_verified_phone'],
  ['no_permission', 'mc_irc_notice_no_permission'],
  ['unrecognized_cmd', 'mc_irc_notice_unrecognized_cmd'],
  ['tos_ban', 'mc_irc_notice_tos_ban'],
])

function parseNoticeMsgId(line) {
  // Tags arrive before the colon: @msg-id=msg_followersonly;... :tmi.twitch.tv NOTICE ...
  if (!line.startsWith('@')) return null
  const tagsEnd = line.indexOf(' ')
  if (tagsEnd === -1) return null
  for (const kv of line.slice(1, tagsEnd).split(';')) {
    const eq = kv.indexOf('=')
    if (eq === -1) continue
    if (kv.slice(0, eq) === 'msg-id') return kv.slice(eq + 1)
  }
  return null
}

const authState = {
  ws: null,
  ready: false,
  connecting: false,
  destroyed: false,
  joined: new Set(),
  joinWaiters: new Map(),
  lastData: 0,
  pongPending: false,
  token: null,
  nick: null,
  keepaliveTimer: null,
  reconnectTimer: null,
  reconnectDelay: 1000,
  sendQueue: [], // Capped at 50 — drop oldest if full
}
const MAX_SEND_QUEUE = 50

// Push onto the reconnect queue, reporting whether it ACTUALLY landed. At the cap
// the old code skipped the push but the caller still returned 'queued' — telling
// the user their message was saved for reconnect right after throwing it away.
// Callers now distinguish 'queued' (will fire on reconnect) from 'queue_full'
// (gone), so a dropped send surfaces as a real failure with a retry instead of a
// false yellow cue.
function queueForReconnect(channel, text, replyParentId) {
  if (authState.sendQueue.length >= MAX_SEND_QUEUE) return false
  authState.sendQueue.push({ channel, text, replyParentId })
  return true
}
// Expose for devtools inspection — useful when "send disappears with no error"
// is reported, lets you see if the WS is dead / token missing / queued forever.
try {
  globalThis.__hsAuthIrc = authState
} catch {}

function authIrcAlive() {
  return authState.ws?.readyState === WebSocket.OPEN && authState.ready
}

function cleanupAuthIrc(destroy = false) {
  if (destroy) authState.destroyed = true
  if (authState.keepaliveTimer) {
    cleanup.clearInterval(authState.keepaliveTimer)
    authState.keepaliveTimer = null
  }
  if (authState.reconnectTimer) {
    cleanup.clearTimeout(authState.reconnectTimer)
    authState.reconnectTimer = null
  }
  const prevJoined = [...authState.joined]
  if (authState.ws) {
    authState.ws.onopen = null
    authState.ws.onclose = null
    authState.ws.onerror = null
    authState.ws.onmessage = null
    try {
      authState.ws.close()
    } catch {}
  }
  authState.ws = null
  authState.ready = false
  authState.connecting = false
  authState.lastData = 0
  authState.pongPending = false
  authState.joined.clear()
  for (const [, w] of authState.joinWaiters) {
    clearTimeout(w.timer)
    w.resolve(false)
  }
  authState.joinWaiters.clear()
  return prevJoined
}

function handleAuthIrcMessage(event) {
  authState.lastData = Date.now()
  for (const line of event.data.split('\r\n')) {
    if (!line) continue
    if (line.startsWith('PING')) {
      try {
        authState.ws.send(`${line.replace('PING', 'PONG')}\r\n`)
      } catch {}
      continue
    }
    if (line.includes('PONG')) {
      authState.pongPending = false
      continue
    }

    const joinMatch = line.match(/:(\w+)!\w+@\w+\.tmi\.twitch\.tv JOIN #(\w+)/)
    if (joinMatch) {
      const ch = joinMatch[2].toLowerCase()
      authState.joined.add(ch)
      const w = authState.joinWaiters.get(ch)
      if (w) {
        clearTimeout(w.timer)
        w.resolve(true)
        authState.joinWaiters.delete(ch)
      }
      continue
    }
    const partMatch = line.match(/:(\w+)!\w+@\w+\.tmi\.twitch\.tv PART #(\w+)/)
    if (partMatch) {
      authState.joined.delete(partMatch[2].toLowerCase())
      continue
    }
    if (line.includes(' NOTICE ')) {
      const msgId = parseNoticeMsgId(line)
      if (msgId && TWITCH_SEND_REJECT_NOTICES.has(msgId)) {
        if (typeof showToast === 'function') showToast(t(TWITCH_SEND_REJECT_NOTICES.get(msgId)), 'error')
        // ALSO a persistent inline red row in that channel's chat — the toast
        // alone lasts ~2s, and a rejected send otherwise leaves no trace: the
        // message simply "never appears" (mellen lost a night to exactly this
        // with an automod/duplicate-eaten send). Feed the REAL notice line
        // through the shared parser + pipeline (same path /testnotices raw
        // uses) so it renders, scrolls, and persists like any system row.
        // isSynthetic keeps it out of the archive relay. Site already renders
        // send rejections inline — this is the ext half of that parity.
        try {
          if (typeof irc !== 'undefined' && irc && typeof parseIrcLine === 'function') {
            const parsed = parseIrcLine(line)
            if (parsed) {
              parsed.isSynthetic = true
              if (msgId === 'msg_rejected') {
                // held for a mod, not refused: say so in house copy, and remember WHICH send it is so
                // that message's own echo can retire this row (irc.js)
                parsed.text = parsed.systemMsg = t(TWITCH_SEND_REJECT_NOTICES.get(msgId))
                parsed.heldText = globalThis.__hsPendingTextByChannel?.(parsed.channel) || ''
              }
              irc._handleMsg?.(parsed)
            }
          }
        } catch (_) {}
        // Drop pending-send tracker entries for the rejected channel so the
        // user doesn't get a second "no echo from platform" toast 20s later
        // on top of the specific reason toast above.
        const chMatch = line.match(/ NOTICE #(\w+)/)
        if (chMatch) {
          try {
            globalThis.__hsClearPendingByChannel?.(chMatch[1])
          } catch (_) {}
        }
      }
      if (MC_DEBUG) console.warn('[HS] Auth IRC NOTICE:', line.slice(0, 200))
      continue
    }
    if (line.includes('RECONNECT')) {
      log('Auth IRC: Twitch sent RECONNECT')
      const prev = cleanupAuthIrc()
      scheduleReconnect(prev)
      return
    }
    // Whispers arrive via IRC WHISPER with twitch.tv/commands cap (same as Chatterino)
    if (line.includes('WHISPER')) {
      const msg = parseIrcLine(line)
      if (msg?.type === 'whisper') handleIncomingWhisper(msg)
      continue
    }
    if (line.includes(' 353 ') || line.includes(' 366 ') || line.includes('ROOMSTATE')) continue
    if (MC_DEBUG) console.warn('[HS] IRC ←', line.slice(0, 200))
  }
}

function scheduleReconnect(prevChannels) {
  if (authState.destroyed || !authState.token || !authState.nick) return
  if (authState.reconnectTimer) return
  const delay = authState.reconnectDelay
  authState.reconnectDelay = Math.min(delay * 2, 30000)
  const jitteredDelay = delay + Math.random() * 500
  log(`Auth IRC reconnect in ${delay}ms...`)
  authState.reconnectTimer = cleanup.setTimeout(async () => {
    authState.reconnectTimer = null
    if (authState.destroyed || authIrcAlive()) return
    const ok = await connectAuthIrc(authState.token, authState.nick)
    if (ok === true) {
      for (const ch of prevChannels || []) await joinChannel(ch)
      await drainSendQueue()
      log('Auth IRC reconnected, rejoined:', (prevChannels || []).join(', ') || '(none)')
    } else if (ok !== 'auth_failed') {
      scheduleReconnect(prevChannels)
    }
  }, jitteredDelay)
}

async function connectAuthIrc(token, nick) {
  if (authState.connecting) {
    for (let i = 0; i < 80; i++) {
      await new Promise((r) => setTimeout(r, 100))
      if (authIrcAlive()) return true
      if (!authState.connecting) break
    }
    return authIrcAlive()
  }
  cleanupAuthIrc()
  authState.connecting = true
  authState.token = token
  authState.nick = nick
  authState.destroyed = false
  try {
    const ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443')
    authState.ws = ws
    await new Promise((resolve, reject) => {
      const timeout = cleanup.setTimeout(() => reject(new Error('timeout')), 8000)
      ws.onopen = () => {
        ws.send(`PASS oauth:${token}\r\n`)
        ws.send(`NICK ${nick}\r\n`)
        ws.send('CAP REQ :twitch.tv/commands twitch.tv/tags\r\n')
      }
      ws.onmessage = (event) => {
        if (event.data.includes(' 001 ')) {
          authState.ready = true
          authState.lastData = Date.now()
          authState.reconnectDelay = 1000
          cleanup.clearTimeout(timeout)
          resolve()
        }
        if (event.data.includes('Login authentication failed') || event.data.includes('Login unsuccessful')) {
          cleanup.clearTimeout(timeout)
          reject(new Error('auth_failed'))
        }
        for (const l of event.data.split('\r\n')) {
          if (l.startsWith('PING'))
            try {
              ws.send(`${l.replace('PING', 'PONG')}\r\n`)
            } catch {}
        }
      }
      ws.onerror = () => {
        cleanup.clearTimeout(timeout)
        reject(new Error('ws_error'))
      }
      ws.onclose = () => {
        cleanup.clearTimeout(timeout)
        reject(new Error('ws_closed'))
      }
    })
    // Release handshake closures (timeout/resolve/reject) before reassigning
    ws.onopen = null
    ws.onmessage = null
    ws.onerror = null
    ws.onclose = null
    ws.onmessage = handleAuthIrcMessage
    ws.onclose = () => {
      log('Auth IRC disconnected')
      const prev = cleanupAuthIrc()
      scheduleReconnect(prev)
    }
    ws.onerror = () => {}
    // Keepalive PING every 30s — detect dead sockets fast
    authState.keepaliveTimer = cleanup.setInterval(() => {
      if (!authState.ws || authState.ws.readyState !== WebSocket.OPEN) return
      if (authState.pongPending) {
        log('Auth IRC: PONG timeout, reconnecting')
        const prev = cleanupAuthIrc()
        scheduleReconnect(prev)
        return
      }
      authState.pongPending = true
      try {
        authState.ws.send('PING :hs\r\n')
      } catch {}
    }, 30000)
    authState.connecting = false
    // Pre-join current channel so first send is instant
    const ch = getCurrentChannel()?.toLowerCase()
    if (ch) joinChannel(ch)
    return true
  } catch (e) {
    log('Auth IRC connect failed:', e.message)
    authState.connecting = false
    cleanupAuthIrc()
    return e.message === 'auth_failed' ? 'auth_failed' : false
  }
}

function joinChannel(channel) {
  channel = channel.toLowerCase()
  if (authState.joined.has(channel)) return Promise.resolve(true)
  if (!authIrcAlive()) return Promise.resolve(false)
  try {
    authState.ws.send(`JOIN #${channel}\r\n`)
  } catch {
    return Promise.resolve(false)
  }
  return new Promise((resolve) => {
    // Twitch JOIN ack: usually <100ms, but slow network / mid-reconnect can
    // run to ~1.5s. Old 500ms timeout + faking joined=true silently broke
    // sends for the WS lifetime — every later PRIVMSG to that channel hit
    // tmi.twitch.tv as a never-joined client and dropped without a NOTICE.
    // Now: longer timeout, no fake-success; caller retries via sendIrcMessage.
    const timer = cleanup.setTimeout(() => {
      authState.joinWaiters.delete(channel)
      resolve(false)
    }, 2000)
    authState.joinWaiters.set(channel, { resolve, timer })
  })
}

async function drainSendQueue() {
  // Join-gate every drain. A PRIVMSG to a channel we never JOINed is silently
  // dropped by tmi.twitch.tv (no NOTICE). scheduleReconnect() can lose a queued
  // channel from its rejoin list — it early-returns when a reconnect is already
  // pending (authState.reconnectTimer), discarding the prevChannels passed in —
  // so the queued message would otherwise drain into an unjoined channel. This
  // is the authoritative guard regardless of what got rejoined.
  while (authState.sendQueue.length && authIrcAlive()) {
    const { channel, text, replyParentId } = authState.sendQueue[0] // peek; shift only on success
    if (!authState.joined.has(channel)) {
      const joined = await joinChannel(channel)
      // joinChannel awaits the JOIN ack (or 2s timeout). Bail if the socket died
      // mid-join or the join didn't land — leave this + the rest queued for the
      // next drain (reconnect / tab-focus / keepalive) rather than drop them.
      if (!authIrcAlive() || !joined) break
    }
    try {
      const qPrefix = replyParentId ? `@reply-parent-msg-id=${replyParentId} ` : ''
      // Strip CR/LF: they terminate an IRC line, so a newline in text would let
      // it inject a second command onto the wire. The composer's serializer
      // currently never emits them, but guard structurally at the wire boundary.
      authState.ws.send(`${qPrefix}PRIVMSG #${channel} :${String(text).replace(/[\r\n]/g, ' ')}\r\n`)
      authState.sendQueue.shift()
      log(`Drained queued msg to #${channel}`)
    } catch {
      break // leave at queue head, retry next drain
    }
  }
}

async function sendIrcMessage(channel, text, token, replyParentId, overrideNick) {
  const nick = overrideNick || currentUsername || getCurrentUsername()
  if (!nick) return 'no_user'
  channel = channel.toLowerCase()
  const prefix = replyParentId ? `@reply-parent-msg-id=${replyParentId} ` : ''

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (!authIrcAlive()) {
        const result = await connectAuthIrc(token, nick)
        if (result === 'auth_failed') return 'auth_failed'
        if (!result) {
          if (attempt < 2) continue
          const queuedA = queueForReconnect(channel, text, replyParentId)
          scheduleReconnect([channel])
          log(queuedA ? 'Queued message for reconnect' : 'Send queue FULL — message dropped')
          // 'queued' = yellow cue; it fires when (if) the WS reconnects, not now.
          // 'queue_full' = the message was discarded, so never call it queued.
          return queuedA ? 'queued' : 'queue_full'
        }
      }
      if (!authState.joined.has(channel)) {
        const joined = await joinChannel(channel)
        // joinChannel no longer fakes success on timeout; bail to retry rather
        // than PRIVMSG into a never-joined channel (twitch drops it silently).
        if (!joined) {
          if (attempt < 2) continue
          const queuedB = queueForReconnect(channel, text, replyParentId)
          if (typeof showToast === 'function')
            showToast(queuedB ? t('mc_irc_join_queued', [channel]) : t('mc_irc_queue_full'), 'error')
          return queuedB ? 'queued' : 'queue_full'
        }
      }
      if (!authIrcAlive()) {
        if (attempt < 2) {
          cleanupAuthIrc()
          continue
        }
        const queuedC = queueForReconnect(channel, text, replyParentId)
        scheduleReconnect([channel])
        return queuedC ? 'queued' : 'queue_full'
      }
      // Strip CR/LF at the wire boundary — a newline in text would inject a
      // second IRC command (see the queue-drain send above).
      authState.ws.send(`${prefix}PRIVMSG #${channel} :${String(text).replace(/[\r\n]/g, ' ')}\r\n`)
      if (MC_DEBUG)
        console.warn(
          '[HS] IRC SEND →',
          `#${channel}`,
          `nick=${nick}`,
          replyParentId ? `reply=${replyParentId}` : '',
          text.slice(0, 40),
        )
      return true
    } catch (e) {
      log('Send error attempt', attempt, ':', e.message || e)
      cleanupAuthIrc()
      if (attempt === 2) {
        const queuedD = queueForReconnect(channel, text, replyParentId)
        scheduleReconnect([channel])
        return queuedD ? 'queued' : 'queue_full'
      }
    }
  }
  return 'send_error'
}
