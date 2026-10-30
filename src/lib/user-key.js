// User block/mute keys — namespaced by platform.
//
// Historically block/mute Sets stored bare lowercase usernames, so blocking
// twitch "alice" also hid an unrelated kick "alice" (a different person). Keys
// are now `platform:username` so same-handle users on different platforms don't
// collide.
//
// Backward compatibility: a stored key WITHOUT a platform prefix is treated as a
// legacy GLOBAL entry and still matches on every platform. Existing stored
// block/mute lists (bare usernames from before namespacing) therefore keep
// working with no migration; only new writes are platform-scoped. Linked
// cross-platform identities (e.g. a kick chatter's 7TV-linked twitch handle) are
// passed in as pre-namespaced `aliasKeys` by the caller, so a block on one
// linked identity still hides the other.
//
// Pure + dependency-free so it can be unit-tested in isolation.

// Canonical platform namespace. Callers pass BOTH forms for YouTube — 'yt'
// (render/row short form via data-platform) and 'youtube' (message model) —
// which used to produce disjoint keys: a mute written as `yt:alice` never
// matched enforcement checking `youtube:alice`, so yt mutes/blocks were
// silent no-ops. One writer normalizes; the matcher also accepts the other
// form for keys persisted before normalization.
export function canonPlatform(platform) {
  return platform === 'yt' ? 'youtube' : platform
}

export function userKey(username, platform) {
  const u = String(username == null ? '' : username)
    .toLowerCase()
    .replace(/^@/, '')
  if (!u) return ''
  const p = canonPlatform(platform)
  return p ? `${p}:${u}` : u
}

// True if `set` contains this user for this platform. Order:
//   1. legacy bare key (global, pre-namespace entries)
//   2. the platform-scoped key
//   3. any caller-supplied alias keys (already namespaced — linked identities)
export function userSetMatches(set, username, platform, aliasKeys) {
  if (!set || set.size === 0) return false
  const u = String(username == null ? '' : username)
    .toLowerCase()
    .replace(/^@/, '')
  if (!u) return false
  if (set.has(u)) return true
  if (set.has(userKey(u, platform))) return true
  // Legacy short-form keys: entries stored as `yt:<name>` before platform
  // canonicalization must keep matching youtube rows.
  if (canonPlatform(platform) === 'youtube' && set.has(`yt:${u}`)) return true
  if (aliasKeys) {
    for (const k of aliasKeys) {
      if (k && set.has(k)) return true
    }
  }
  return false
}
