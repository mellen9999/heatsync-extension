// seed-legs.js — the first-run channel seed gets the same-name other leg.
//
// A twitch page seeds {twitch:x}, a kick page {kick:x}. Left single-leg the
// panel shows one platform, and the two hosts' entries (same id) overwrote each
// other. Mirror of the site's tab heal (client/managers/chat-tabs-manager.js):
// adopt the same-name other platform only when heatsync says the channel
// EXISTS (live or offline). Never on a guess — a negative or failed probe
// leaves the entry single-leg. twitch<->kick only; youtube has no such probe.
// Pure and fetch-injected so it is unit-tested alone.

const MC_SEED_INFO_URL = 'https://heatsync.org/api/live/info'

/** The missing leg's name when heatsync confirms it exists, else ''. */
export async function mcSeedProbeLeg(platform, name, doFetch) {
  if ((platform !== 'twitch' && platform !== 'kick') || !name) return ''
  try {
    const res = await doFetch(`${MC_SEED_INFO_URL}?platform=${platform}&channel=${encodeURIComponent(name)}`, {
      credentials: 'omit',
    })
    if (!res || !res.ok) return ''
    const info = await res.json()
    return info?.exists || info?.isLive ? name : ''
  } catch {
    return ''
  }
}

/** Fill the entry's empty twitch/kick leg(s) in place; returns the legs added. */
export async function mcSeedAdoptLegs(entry, doFetch) {
  const added = []
  const name = entry?.twitch || entry?.kick
  if (!name || (entry.twitch && entry.kick)) return added
  const missing = entry.twitch ? 'kick' : 'twitch'
  const found = await mcSeedProbeLeg(missing, name, doFetch)
  if (found && !entry[missing]) {
    entry[missing] = found
    added.push(missing)
  }
  return added
}

/**
 * Merge storage's copy of an entry into ours without losing a leg another tab
 * added. A leg we blank on purpose stays blank: it is only taken from `theirs`
 * when it differs from what we last persisted (`prev`), i.e. someone else set it.
 */
export function mcMergeLegs(mine, theirs, prev) {
  for (const leg of ['twitch', 'kick', 'youtube']) {
    if (!mine[leg] && theirs?.[leg] && (!prev || theirs[leg] !== prev[leg])) mine[leg] = theirs[leg]
  }
  return mine
}
