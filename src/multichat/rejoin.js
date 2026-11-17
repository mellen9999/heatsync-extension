// rejoin.js — a twitch channel the page still shows but dropped comes back.
//
// A tab's twitch feed lives exactly as long as the page's irc holds the channel.
// Paths that part or give up a join (a config change parting a name another tab
// still uses, a join that ran out of retries while the worker restarted) left
// it dropped for good: nothing ever joined it again, so that one tab froze on
// its last line until a refresh while every other tab kept flowing (nl_kripp,
// 2026-11-14). main.js asks this on a 15s tick and rejoins what it returns.
// Pure so it is unit-tested alone.

/** Twitch logins the page should hold but irc does not: saved tabs + extra (page channel), lowercase, once each. */
export function mcDroppedTwitch(channels, joined, extra = []) {
  const out = []
  const want = (name) => {
    const tw = typeof name === 'string' ? name.trim().toLowerCase() : ''
    if (tw && !joined.has(tw) && !out.includes(tw)) out.push(tw)
  }
  for (const ch of channels || []) want(ch?.twitch)
  for (const name of extra) want(name)
  return out
}

/** True while a tab in `channels`, or a name in `extra` (what the stream on this page reads), names this login on `field`. */
function mcStillNamed(field, name, channels, extra) {
  const want = typeof name === 'string' ? name.trim().toLowerCase() : ''
  if (!want) return false
  const same = (n) => typeof n === 'string' && n.trim().toLowerCase() === want
  return (channels || []).some((ch) => same(ch?.[field])) || extra.some(same)
}

/** True while some tab other than the one going away, or the page's stream, still names this twitch login. */
export function mcTwitchStillShown(name, channels, extra = []) {
  return mcStillNamed('twitch', name, channels, extra)
}

/** The same for a kick slug: leaving a room the page's stream reads silences the live tab. */
export function mcKickStillShown(slug, channels, extra = []) {
  return mcStillNamed('kick', slug, channels, extra)
}

/** True when this kick slug is a leg of a saved tab: the saved list owns its room, so a page tearing down never leaves it. */
export function mcKickSaved(slug, channels) {
  return mcStillNamed('kick', slug, channels, [])
}
