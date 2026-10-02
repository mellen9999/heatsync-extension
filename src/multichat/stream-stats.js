// Stream stats - per-channel message/mention/chatter/emote counters + summary card

// Stream stats (per channel, lowercase). Reset on stream:online; read by the
// channel tab's `summary` cell (live-refreshing; titled "ended" once endedAt is
// set by stream:offline).
// { msgCount, mentionCount, startedAt, endedAt?, peakMps, chatters:
//   Map<user,count>, chattersFloor, emotes: Map<name,count> }
const streamStats = new Map()
const STREAM_STATS_TOP_N = 5
function getStats(channel) {
  if (!channel) return null
  const key = channel.toLowerCase()
  let s = streamStats.get(key)
  if (!s) {
    s = {
      msgCount: 0,
      mentionCount: 0,
      startedAt: Date.now(),
      peakMps: 0,
      _sec: 0,
      _secN: 0,
      chatters: new Map(),
      chattersFloor: 0, // unique count seen before a trim; the total is at least this
      emotes: new Map(),
    }
    streamStats.set(key, s)
    if (streamStats.size > 50) streamStats.delete(streamStats.keys().next().value)
  }
  return s
}
// Hot-path counters only — emote scan is deferred to an idle queue so the
// IRC message handler stays branch-light. The summary card only renders on
// stream:offline (and reads the maps fresh) so a few hundred ms lag in
// emote-count accuracy is invisible.
const _statsScanQueue = []
let _statsScanScheduled = false
function _flushStatsScanQueue() {
  _statsScanScheduled = false
  if (typeof emoteCache === 'undefined') {
    _statsScanQueue.length = 0
    return
  }
  const start = performance.now()
  while (_statsScanQueue.length && performance.now() - start < 4) {
    const job = _statsScanQueue.shift()
    const s = streamStats.get(job.key)
    if (!s) continue
    const text = job.text
    // split(' ') beats split(/\s+/) by ~3x and chat lines almost never use tabs/newlines
    const words = text.split(' ')
    const cap = Math.min(words.length, 50)
    for (let i = 0; i < cap; i++) {
      const word = words[i]
      if (!word || word.length > 30) continue
      if (emoteCache.has(word)) {
        s.emotes.set(word, (s.emotes.get(word) || 0) + 1)
      }
    }
    if (s.emotes.size > 2000) {
      const arr = [...s.emotes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 500)
      s.emotes = new Map(arr)
    }
  }
  if (_statsScanQueue.length) _scheduleStatsScan()
}
function _scheduleStatsScan() {
  if (_statsScanScheduled) return
  _statsScanScheduled = true
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(_flushStatsScanQueue, { timeout: 1000 })
  } else {
    cleanup.setTimeout(_flushStatsScanQueue, 50)
  }
}

function bumpStreamStats(channel, msg, isMent) {
  if (!isEnabled('stream-stats')) return // live subsystem gate
  const s = getStats(channel)
  if (!s || !msg) return
  s.msgCount++
  if (isMent) s.mentionCount++
  const sec = (Date.now() / 1000) | 0
  if (sec !== s._sec) {
    s._sec = sec
    s._secN = 0
  }
  if (++s._secN > s.peakMps) s.peakMps = s._secN
  if (msg.user) {
    const u = msg.user
    s.chatters.set(u, (s.chatters.get(u) || 0) + 1)
    if (s.chatters.size > 5000) {
      // Keep top by trimming smallest
      s.chattersFloor = Math.max(s.chattersFloor, s.chatters.size)
      const arr = [...s.chatters.entries()].sort((a, b) => b[1] - a[1]).slice(0, 1000)
      s.chatters = new Map(arr)
    }
  }
  const text = msg.text || ''
  if (text) {
    _statsScanQueue.push({ key: channel.toLowerCase(), text })
    if (_statsScanQueue.length > 500) _statsScanQueue.splice(0, _statsScanQueue.length - 500)
    _scheduleStatsScan()
  }
}
function topN(map, n) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
}
function fmtDuration(ms) {
  const m = Math.floor(ms / 60000)
  const h = Math.floor(m / 60)
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`
}
function fmtClock(ms) {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// One summary card for `channel`, read fresh from the counters. `ended` (or a
// stream:offline stamp on the stats) titles it as the offline recap. Counting
// starts when multichat first sees the channel's chat, so the window is
// labelled by that instant, never by twitch's stream uptime. `onClose` adds a
// × that calls it (the cell's way back to chat); without it there is no ×.
function buildStreamSummary(channel, ended, onClose) {
  const key = (channel || '').toLowerCase()
  const s = streamStats.get(key)
  const card = document.createElement('div')
  card.className = 'hs-mc-stream-summary'

  const title = document.createElement('div')
  title.className = 'hs-mc-summary-title'
  const titleText = document.createElement('span')
  titleText.textContent = ended || s?.endedAt ? `${key} stream ended` : `${key} stream summary`
  title.append(titleText)
  if (onClose) {
    const dismiss = hsXButton('hs-x-inline', 'back to chat', (e) => {
      e.stopPropagation()
      onClose()
    })
    dismiss.title = 'back to chat (Esc)'
    title.append(dismiss)
  }
  card.append(title)

  const line = (cls, text) => {
    const el = document.createElement('div')
    el.className = cls
    el.textContent = text
    card.append(el)
  }
  if (!isEnabled('stream-stats')) {
    line('hs-mc-summary-dim', 'stream stats are off in settings')
    return card
  }
  if (!s || s.msgCount === 0) {
    line('hs-mc-summary-dim', 'no chat counted yet — it fills in as messages arrive')
    return card
  }
  const n = (v) => v.toLocaleString('en-US')
  const chatters = s.chattersFloor > s.chatters.size ? `${n(s.chattersFloor)}+` : n(s.chatters.size)
  line(
    'hs-mc-summary-stats',
    `${n(s.msgCount)} msgs · ${chatters} chatters · ${n(s.mentionCount)} mentions · ${s.peakMps}/s peak`,
  )
  line('hs-mc-summary-dim', `since ${fmtClock(s.startedAt)} · ${fmtDuration(Date.now() - s.startedAt)}`)
  const top = (label, items) => {
    if (items.length === 0) return
    const row = document.createElement('div')
    row.className = 'hs-mc-summary-row'
    const lbl = document.createElement('span')
    lbl.className = 'hs-mc-summary-dim'
    lbl.textContent = `${label} `
    const list = document.createElement('span')
    list.textContent = items.map(([k, v]) => `${k} ${n(v)}`).join(' · ')
    row.append(lbl, list)
    card.append(row)
  }
  top('top chatters', topN(s.chatters, STREAM_STATS_TOP_N))
  top('top emotes', topN(s.emotes, STREAM_STATS_TOP_N))
  return card
}

// stream:offline: stamp the stats as ended and keep them an hour so the
// summary cell can still be read. True when there was chat worth a recap.
function markStreamEnded(channel) {
  const key = (channel || '').toLowerCase()
  const s = streamStats.get(key)
  if (!s || s.msgCount === 0) return false
  s.endedAt = Date.now()
  cleanup.setTimeout(
    () => {
      if (streamStats.get(key) === s) {
        streamStats.delete(key)
        if (typeof clearSummaryDots === 'function') clearSummaryDots(key)
      }
    },
    60 * 60 * 1000,
  )
  return true
}

// Live summary mounted in `slot`, redrawn every 2s while it stays attached.
function mountLiveStreamSummary(slot, channel, onClose) {
  const draw = () => slot.replaceChildren(buildStreamSummary(channel, false, onClose))
  const timer = cleanup.setInterval(() => {
    if (!slot.isConnected) return cleanup.clearInterval(timer)
    draw()
  }, 2000)
  draw()
}
