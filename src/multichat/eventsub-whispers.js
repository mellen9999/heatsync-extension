// EventSub WebSocket — Twitch whisper reception.
// IRC WHISPER delivery is deprecated/silently dropped since Feb 2023;
// the only documented path is EventSub user.whisper.message.

const ESW_URL = 'wss://eventsub.wss.twitch.tv/ws'
const ESW_HELIX_SUBS = 'https://api.twitch.tv/helix/eventsub/subscriptions'
const ESW_HELIX_USERS = 'https://api.twitch.tv/helix/users'
const ESW_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko'

const eswState = {
  ws: null,
  sessionId: null,
  selfUserId: null,
  destroyed: false,
  connecting: false,
  subscribed: false,
  subscribing: false, // a subscribe POST is in flight — block a reconnect-welcome from firing a duplicate
  reconnectTimer: null,
  reconnectDelay: 1000,
  keepaliveTimer: null,
  keepaliveTimeoutMs: 30000,
  lastMessageTime: 0,
  seenIds: new Set(),
  seenIdOrder: [],
}
const ESW_SEEN_MAX = 200

function eswMarkSeen(id) {
  if (!id) return false
  if (eswState.seenIds.has(id)) return true
  eswState.seenIds.add(id)
  eswState.seenIdOrder.push(id)
  if (eswState.seenIdOrder.length > ESW_SEEN_MAX) {
    const old = eswState.seenIdOrder.shift()
    eswState.seenIds.delete(old)
  }
  return false
}

async function eswFetchSelfUserId(token) {
  if (eswState.selfUserId) return eswState.selfUserId
  try {
    const resp = await fetch(ESW_HELIX_USERS, {
      headers: { 'Client-Id': ESW_CLIENT_ID, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    })
    if (!resp.ok) {
      log('EventSub: /helix/users failed', resp.status)
      return null
    }
    const data = await resp.json()
    const id = data?.data?.[0]?.id
    if (id) eswState.selfUserId = id
    return id || null
  } catch (e) {
    log('EventSub: self id fetch failed:', e.message)
    return null
  }
}

async function eswSubscribeWhispers(token) {
  if (!eswState.sessionId || !eswState.selfUserId) return false
  if (eswState.subscribing) return false // POST already in flight — don't double-subscribe
  eswState.subscribing = true
  try {
    const resp = await fetch(ESW_HELIX_SUBS, {
      method: 'POST',
      headers: {
        'Client-Id': ESW_CLIENT_ID,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'user.whisper.message',
        version: '1',
        condition: { user_id: eswState.selfUserId },
        transport: { method: 'websocket', session_id: eswState.sessionId },
      }),
      signal: AbortSignal.timeout(8000),
    })
    if (resp.status === 202) {
      eswState.subscribed = true
      log('EventSub: subscribed user.whisper.message')
      return true
    }
    const txt = await resp.text().catch(() => '')
    log('EventSub: subscribe failed', resp.status, txt.slice(0, 200))
    if (resp.status === 401 || resp.status === 403) {
      // Token lacks user:read:whispers — give up (don't reconnect-loop)
      eswState.destroyed = true
      eswCleanup(true)
    }
    return false
  } catch (e) {
    log('EventSub: subscribe error', e.message)
    return false
  } finally {
    eswState.subscribing = false
  }
}

function eswCleanup(destroy = false) {
  if (destroy) eswState.destroyed = true
  if (eswState.keepaliveTimer) {
    cleanup.clearInterval(eswState.keepaliveTimer)
    eswState.keepaliveTimer = null
  }
  if (eswState.reconnectTimer) {
    cleanup.clearTimeout(eswState.reconnectTimer)
    eswState.reconnectTimer = null
  }
  if (eswState.oldWsCloseTimer) {
    cleanup.clearTimeout(eswState.oldWsCloseTimer)
    eswState.oldWsCloseTimer = null
  }
  if (eswState.oldWs) {
    try {
      eswState.oldWs.close()
    } catch {}
    eswState.oldWs = null
  }
  if (eswState.ws) {
    eswState.ws.onopen = null
    eswState.ws.onclose = null
    eswState.ws.onerror = null
    eswState.ws.onmessage = null
    try {
      eswState.ws.close()
    } catch {}
  }
  eswState.ws = null
  eswState.sessionId = null
  eswState.subscribed = false
  eswState.connecting = false
}

function eswScheduleReconnect(token) {
  if (eswState.destroyed) return
  if (eswState.reconnectTimer) return
  const delay = eswState.reconnectDelay
  eswState.reconnectDelay = Math.min(delay * 2, 30000)
  const jitteredDelay = delay + Math.random() * delay * 0.5
  log(`EventSub reconnect in ${delay}ms`)
  eswState.reconnectTimer = cleanup.setTimeout(() => {
    eswState.reconnectTimer = null
    if (eswState.destroyed) return
    if (eswState.ws?.readyState === WebSocket.OPEN) return
    eswConnect(token)
  }, jitteredDelay)
}

// Pull a known color for a userId from anywhere we've seen them (whisper history, IRC buffers).
function eswResolveUserColor(userId) {
  if (typeof whisperUsers !== 'undefined') {
    for (const [, u] of whisperUsers) {
      if (u?.userId === userId && u?.color) return u.color
    }
  }
  return null
}

function eswHandleNotification(msg) {
  if (msg.metadata?.subscription_type !== 'user.whisper.message') return
  const event = msg.payload?.event
  if (!event) return

  const msgId = msg.metadata?.message_id
  if (eswMarkSeen(msgId)) return

  const text = event.whisper?.text || ''
  if (!text) return

  // Shape matches handleIncomingWhisper (whispers.js:128)
  handleIncomingWhisper({
    user: event.from_user_name || event.from_user_login || 'unknown',
    userId: event.from_user_id,
    text,
    color: eswResolveUserColor(event.from_user_id) || '#fff',
    time: msg.metadata?.message_timestamp ? new Date(msg.metadata.message_timestamp).getTime() : Date.now(),
    id: event.whisper_id || msgId || '',
    src: 'eventsub',
  })
}

function eswHandleMessage(token) {
  return (event) => {
    eswState.lastMessageTime = Date.now()
    let msg
    try {
      msg = JSON.parse(event.data)
    } catch {
      return
    }
    const type = msg.metadata?.message_type
    if (!type) return

    if (type === 'session_welcome') {
      eswState.sessionId = msg.payload?.session?.id
      const kt = msg.payload?.session?.keepalive_timeout_seconds
      if (typeof kt === 'number') eswState.keepaliveTimeoutMs = (kt + 5) * 1000
      log('EventSub session welcome:', eswState.sessionId)
      // Reconnect-flow welcome carries existing subs over — only subscribe on
      // first connect, and never while a prior POST is still in flight (a fast
      // server reconnect mid-POST would otherwise create a duplicate sub).
      if (!eswState.subscribed && !eswState.subscribing) eswSubscribeWhispers(token)
      if (eswState.keepaliveTimer) cleanup.clearInterval(eswState.keepaliveTimer)
      eswState.keepaliveTimer = cleanup.setInterval(() => {
        if (Date.now() - eswState.lastMessageTime > eswState.keepaliveTimeoutMs) {
          log('EventSub: keepalive timeout — reconnecting')
          eswCleanup()
          eswScheduleReconnect(token)
        }
      }, 5000)
      eswState.reconnectDelay = 1000
      return
    }
    if (type === 'session_keepalive') return
    if (type === 'notification') {
      eswHandleNotification(msg)
      return
    }
    if (type === 'session_reconnect') {
      const newUrl = msg.payload?.session?.reconnect_url
      if (newUrl) {
        log('EventSub: server requested reconnect')
        eswConnect(token, newUrl)
      }
      return
    }
    if (type === 'revocation') {
      log('EventSub: subscription revoked', msg.payload?.subscription?.status)
      eswState.subscribed = false
      eswCleanup()
      eswScheduleReconnect(token)
      return
    }
  }
}

async function eswConnect(token, urlOverride) {
  if (eswState.connecting) return false
  if (!token) return false
  if (!eswState.selfUserId) {
    const id = await eswFetchSelfUserId(token)
    if (!id) {
      log('EventSub: no self user id, abort')
      return false
    }
  }
  eswState.connecting = true
  eswState.destroyed = false

  // Reconnect-URL flow: keep old socket open until new one welcomes,
  // but stop the old keepalive timer so it can't fire against the stale lastMessageTime.
  const oldWs = urlOverride ? eswState.ws : null
  if (urlOverride) {
    if (eswState.keepaliveTimer) {
      cleanup.clearInterval(eswState.keepaliveTimer)
      eswState.keepaliveTimer = null
    }
  } else {
    eswCleanup()
  }

  try {
    const ws = new WebSocket(urlOverride || ESW_URL)
    eswState.ws = ws
    ws.onopen = () => {
      eswState.lastMessageTime = Date.now()
    }
    ws.onmessage = eswHandleMessage(token)
    ws.onclose = () => {
      log('EventSub: socket closed')
      if (eswState.destroyed) return
      eswScheduleReconnect(token)
    }
    ws.onerror = () => {}
    if (oldWs) {
      eswState.oldWs = oldWs
      eswState.oldWsCloseTimer = cleanup.setTimeout(() => {
        eswState.oldWsCloseTimer = null
        if (eswState.oldWs === oldWs) eswState.oldWs = null
        try {
          oldWs.onmessage = null
          oldWs.onclose = null
          oldWs.onerror = null
          oldWs.close()
        } catch {}
      }, 5000)
    }
    eswState.connecting = false
    return true
  } catch (e) {
    log('EventSub: connect failed', e.message)
    eswState.connecting = false
    eswScheduleReconnect(token)
    return false
  }
}

async function startEventSubWhispers() {
  // Async fetch reaches twitch cookies even on Kick/YouTube tabs (via background.js)
  const { token } = await getTwitchAuthTokenAsync()
  if (!token) {
    log('EventSub: no Twitch token, skipping whispers')
    return
  }
  await eswConnect(token)
}

async function reconnectEventSubIfDead() {
  if (eswState.destroyed) return
  if (eswState.ws?.readyState === WebSocket.OPEN) return
  if (eswState.connecting) return
  const { token } = await getTwitchAuthTokenAsync()
  if (!token) return
  log('EventSub: reconnecting (visibility/wake)')
  eswConnect(token)
}
