// What a stream event says, and which ones a reload brings back — the one
// answer for heatsync.org and the extension (synced verbatim into the
// extension, tests on both sides pin it).
//
// The two clients each hand-wrote this and drifted: the extension said "now
// playing" when the previous game was unknown and the site stayed silent; the
// site brought stored events back as rows, the extension dropped some. Same
// event, different chat.

/** A reload re-injects stored events only this young: older ones are news you already missed. */
export const REPLAY_WINDOW_MS = 15 * 60 * 1000

/**
 * The words for a stream event, without the channel (each client prefixes its
 * own: the site "cyr switched to X", the extension "[cyr] ◆ switched to X").
 * @param {'update'|'online'|'offline'} kind
 * @param {{ game?: string, prevGame?: string }} e
 * @returns {string|null} null = nothing worth a line (no new game)
 */
export function streamEventBody(kind, e) {
  if (kind === 'update') {
    if (!e.game || e.prevGame === e.game) return null
    return e.prevGame ? `switched to ${e.game}` : `now playing ${e.game}`
  }
  if (kind === 'online') return e.game ? `went live — ${e.game}` : 'went live'
  if (kind === 'offline') return 'went offline'
  return null
}

/**
 * Whether a stored event comes back on a reload. Game switches and go-offlines
 * inside the window do. "went live" never does: it was shown when it happened,
 * and on a reload every channel that is already live would otherwise stack up
 * as one.
 * @param {'update'|'online'|'offline'} kind
 * @param {number} time - when it happened, ms
 * @param {number} [now]
 */
export function replayKeeps(kind, time, now = Date.now()) {
  if (kind === 'online') return false
  return Number.isFinite(time) && now - time <= REPLAY_WINDOW_MS
}
