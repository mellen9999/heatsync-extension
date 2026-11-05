// What a stream line needs from its frame: the streamer's own id (validated per
// platform) and the went-live row a twitch tab's history gets at the stream's start.
// Pure, so the tests import it; the bundle concatenates it with the other modules.

/**
 * The streamer's id on the line's own platform, from a server frame — hostile
 * input, so it is checked against the shape each platform really uses and
 * dropped (empty string) when it does not match. Twitch and kick ids are digits;
 * a youtube channel id is UC plus 22 chars.
 * @param {unknown} platform raw event platform
 * @param {unknown} raw
 * @returns {string}
 */
export function streamEventUserId(platform, raw) {
  const id = typeof raw === 'number' && Number.isSafeInteger(raw) ? String(raw) : raw
  if (typeof id !== 'string') return ''
  if (/^(youtube|yt)$/i.test(String(platform))) return /^UC[A-Za-z0-9_-]{22}$/.test(id) ? id : ''
  return /^\d{1,20}$/.test(id) ? id : ''
}

/**
 * The went-live row a twitch tab's history gets at the stream's own start time:
 * null unless the stream is live, started in the past, and the loaded history
 * reaches back that far (a row older than the oldest line shown would just sit
 * stranded at the top). The id is stable per stream, so a second answer can
 * never double it.
 * @param {string} channel lowercase login
 * @param {{ start: number, game?: string, userId?: unknown }} info start = ms epoch
 * @param {number} oldest time of the oldest line in the tab (0/NaN = none loaded)
 * @param {number} [now]
 */
export function historyWentLiveEvent(channel, info, oldest, now = Date.now()) {
  const start = Number(info?.start)
  if (!channel || !Number.isFinite(start) || start <= 0 || start > now) return null
  if (!Number.isFinite(oldest) || oldest <= 0 || oldest > start) return null
  const game = String(info.game || '').slice(0, 200)
  return {
    type: 'stream-event',
    eventClass: 'event-online',
    text: `[${channel}] \u25C6 ${game ? `went live \u2014 ${game}` : 'went live'}`,
    channel,
    actor: null,
    time: start,
    id: `went-live:${channel}:${start}`,
    color: '',
    userId: streamEventUserId('twitch', info.userId),
    histWentLive: true,
  }
}
