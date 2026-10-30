// What a stream event says, and which ones a reload brings back — the one
// answer for heatsync.org and the extension (synced verbatim into the
// extension, tests on both sides pin it).
//
// The two clients each hand-wrote this and drifted: the extension and the site
// worded a first-known-game update differently, and the site brought stored
// events back as rows where the extension dropped some. Same event, different
// chat. Users only ever see "went live — X", "switched to X", "went offline".

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
    return `switched to ${e.game}`
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

/** How long a first "switched to" waits for the "went live" that usually rides with it. */
export const GO_LIVE_PAIR_MS = 2000
/** A "switched to" for the game a channel just went live with, inside this, is the same news. */
const GO_LIVE_ECHO_MS = 30000

/**
 * Twitch announces one go-live as two events: `channel.update` (the game, with
 * no previous one — "switched to X") and `stream.online` ("went live — X").
 * Shown raw that is two lines for one thing. This pairs them per channel: a
 * "switched to" with no previous game waits a moment, and a "went live" for
 * the same game replaces it; one that arrives AFTER a go-live for the same game
 * is dropped. A real switch (a previous game) is never held.
 *
 * Pure: the clock and timers are injected so both clients and the tests drive
 * it the same way. `emit(channel, kind, e, text)` is called at most once per line.
 * @param {{ emit: (channel: string, kind: 'update'|'online', e: object, text: string) => void,
 *           now?: () => number, setTimer?: Function, clearTimer?: Function, holdMs?: number }} io
 */
export function createGoLivePairing({ emit, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, holdMs = GO_LIVE_PAIR_MS }) {
  const pending = new Map() // channel -> { timer, game }
  const lastOnline = new Map() // channel -> { game, at }
  return {
    update(channel, e) {
      const text = streamEventBody('update', e)
      if (!text) return
      if (e.prevGame) return emit(channel, 'update', e, text)
      const live = lastOnline.get(channel)
      if (live && live.game === e.game && now() - live.at <= GO_LIVE_ECHO_MS) return
      const held = pending.get(channel)
      if (held) clearTimer(held.timer)
      const timer = setTimer(() => {
        pending.delete(channel)
        emit(channel, 'update', e, text)
      }, holdMs)
      pending.set(channel, { timer, game: e.game })
    },
    online(channel, e) {
      const held = pending.get(channel)
      if (held && held.game === e.game) {
        clearTimer(held.timer)
        pending.delete(channel)
      }
      lastOnline.set(channel, { game: e.game, at: now() })
      emit(channel, 'online', e, streamEventBody('online', e))
    },
    /** Going offline forgets the go-live, so the next one pairs fresh. */
    offline(channel) {
      const held = pending.get(channel)
      if (held) clearTimer(held.timer)
      pending.delete(channel)
      lastOnline.delete(channel)
    },
  }
}
