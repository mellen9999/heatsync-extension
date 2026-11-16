// Page-side channel emote set eviction. One scope with the rest of the multichat
// bundle (build.js): reads config, channelEmoteCaches and the page's channel getters.

// The page holds up to 20 channel sets; past that, the oldest one nothing here
// shows goes. It used to drop the oldest, full stop: with more than 20 saved
// channels (each twitch one brings its kick leg) every set arriving at boot
// pushed out the stream on screen, and its rows drew emote names as text until
// its set came round again (s4 e2e, 11-15; the worker had the same bug, #5).
const CHANNEL_EMOTE_CACHES_MAX = 20
function channelEmoteCachesInUse() {
  const keep = new Set()
  const add = (v) => {
    if (typeof v === 'string' && v) keep.add(v.toLowerCase())
  }
  try {
    for (const c of config?.channels || []) {
      if (typeof c === 'string') add(c)
      else if (c) [c.id, c.twitch, c.kick].forEach(add)
    }
    add(getCurrentChannel?.())
    add(getLiveChannel?.())
    const live = getLivePlatformNames?.()
    if (live) [live.twitch, live.kick].forEach(add)
  } catch (_) {}
  return keep
}
function evictChannelEmoteCaches(building) {
  const keys = Object.keys(channelEmoteCaches)
  if (keys.length <= CHANNEL_EMOTE_CACHES_MAX) return
  const inUse = channelEmoteCachesInUse()
  const spare = keys.filter((k) => k !== building && !inUse.has(k.toLowerCase()))
  for (const old of spare.slice(0, keys.length - CHANNEL_EMOTE_CACHES_MAX)) delete channelEmoteCaches[old]
}
