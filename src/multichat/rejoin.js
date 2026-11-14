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

/** True while some tab other than the one going away still names this twitch login. */
export function mcTwitchStillShown(name, channels, extra = []) {
  const tw = typeof name === 'string' ? name.trim().toLowerCase() : ''
  if (!tw) return false
  const same = (n) => typeof n === 'string' && n.trim().toLowerCase() === tw
  return (channels || []).some((ch) => same(ch?.twitch)) || extra.some(same)
}
