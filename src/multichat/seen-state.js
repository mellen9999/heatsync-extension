// Seen-state — bulletproof unread indicators for mentions/whispers/home.
//
// Source of truth for "when did the user last view this tab" lives on the
// heatsync server (users.{mentions,whispers,home}_seen_at). On boot we GET
// /api/user/seen-state once, on tab-view we POST + the server fans the new
// timestamp out over WS to every other connected client (other tabs, ext on
// Twitch/Kick/YT). Clearing on one surface clears everywhere instantly.
//
// Local "latestAt" (the most recent event we've seen for each surface) lives
// in chrome.storage.local so a hard-refresh / reboot still shows the dot
// until the user views the tab. Cross-browser switch loses latestAt cache
// but new live events repopulate it; the cleared/uncleared state itself is
// always correct because that's server-backed.

// Surface names are server-canonical: the DB columns are
// {mentions,whispers,live}_seen_at and the web chat-tile uses the same set.
// The feed tab's surface is 'live' (NOT 'home') — using 'home' here makes
// the server reject the POST (zod 400) and drop the WS seen:update, so the
// feed dot never clears across a reload.
const SEEN_SURFACES = ['mentions', 'whispers', 'live']
const SEEN_STORAGE_KEY = 'hs_mc_seen_state_v1'

// module scope resets on re-injection, so a fresh instance re-registers
// after the old one's teardown; window-scope survives takeover and leaves
// handlers dead until hard refresh
const _onceGuardsSeenState = {}

// Server-authoritative "last viewed at" for each surface (ms epoch).
const seenAt = { mentions: 0, whispers: 0, live: 0 }
// Local "latest event at" for each surface (ms epoch). Persisted.
const latestAt = { mentions: 0, whispers: 0, live: 0 }

let _seenLoaded = false
let _seenSaveTimer = null

function _saveSeenLocal() {
  if (_seenSaveTimer) cleanup.clearTimeout(_seenSaveTimer)
  _seenSaveTimer = cleanup.setTimeout(() => {
    // Persist both latestAt AND seenAt. For authed users, seenAt is
    // server-authoritative and gets clobbered by the GET on next boot — local
    // serves only as instant-paint before the network lands. For anonymous
    // users, the server skip in loadSeenState means seenAt would reset to 0
    // on every reload and undo their clears; persisting it locally is the
    // only way their bumps survive a refresh.
    try {
      chrome.storage.local.set({ [SEEN_STORAGE_KEY]: { latestAt: { ...latestAt }, seenAt: { ...seenAt } } })
    } catch (e) {
      warn('seen-state save failed:', e?.message)
    }
  }, 500)
}

async function loadSeenState() {
  // Local cache first — instant red-dot accuracy on boot before the
  // /api/user/seen-state round-trip lands.
  try {
    const cached = await browser.storage.local.get(SEEN_STORAGE_KEY)
    const data = cached?.[SEEN_STORAGE_KEY]
    if (data?.latestAt) {
      for (const k of SEEN_SURFACES) {
        if (typeof data.latestAt[k] === 'number') latestAt[k] = data.latestAt[k]
      }
    }
    // …and the CLEARED marks. _saveSeenLocal persists seenAt alongside
    // latestAt, but this only ever restored latestAt — so every reload resumed
    // with seenAt at 0 while latestAt came back at real event times, and
    // hasUnseen() (latestAt > seenAt) relit mentions/whispers/following no
    // matter how many times they'd been cleared. Anonymous users never reach
    // the GET below, so this cache is their ONLY record of what they've read.
    if (data?.seenAt) {
      for (const k of SEEN_SURFACES) {
        if (typeof data.seenAt[k] === 'number') seenAt[k] = data.seenAt[k]
      }
    }
  } catch (e) {
    warn('seen-state local load failed:', e?.message)
  }

  // Anonymous users have no server state — local-only is fine. Bail only on a
  // KNOWN anonymous (=== false): hsAuthToken starts null ("not resolved yet")
  // and loadHsAuth() is fire-and-forget, so a plain falsy check let a logged-in
  // user lose that race and take this path — skipping the cross-device sync for
  // the whole session, since _seenLoaded then blocks any retry. An unresolved
  // token falls through instead; the GET simply 401s for a real anonymous.
  if (typeof hsAuthToken !== 'undefined' && hsAuthToken === false) {
    _seenLoaded = true
    refreshSeenBadges()
    return
  }

  let _seenSynced = false
  try {
    const resp = await apiFetch('/api/user/seen-state')
    if (resp?.ok && resp.data) {
      for (const k of SEEN_SURFACES) {
        if (typeof resp.data[k] === 'number') seenAt[k] = resp.data[k]
      }
      _seenSynced = true
    }
  } catch (e) {
    warn('seen-state GET failed:', e?.message)
  }
  // Only mark loaded when the server state actually arrived. Nothing reads this
  // flag today, but it was set even on a failed GET — so the moment anyone adds
  // the obvious `if (_seenLoaded) return` guard, a transient failure would
  // silently block the retry for the whole session (exactly what the comment
  // above warns about for the anonymous race).
  _seenLoaded = _seenSynced
  refreshSeenBadges()
}

// Pending bumps that the server didn't ack — replayed on tab visibility.
// Without this, a network blip during clear meant `seenAt` regressed on next
// reload (server still showed the old timestamp) and the dot reappeared.
const _pendingBumps = new Map()

// Push the new "last viewed" up to the server. Optimistic — local state
// updates immediately so the red dot disappears even if the network is slow.
async function bumpSeen(surface, at) {
  if (!SEEN_SURFACES.includes(surface)) return
  const ts = typeof at === 'number' ? at : Date.now()
  // Monotonic locally too — never undo a clear that landed via WS.
  if (ts > seenAt[surface]) seenAt[surface] = ts
  _saveSeenLocal()
  refreshSeenBadges()
  if (typeof hsAuthToken !== 'undefined' && !hsAuthToken) return
  try {
    const resp = await apiFetch('/api/user/seen-state', {
      method: 'POST',
      body: { surface, at: ts },
    })
    if (resp?.ok && typeof resp.data?.at === 'number') {
      // Server may clamp to GREATEST() — accept its value.
      if (resp.data.at > seenAt[surface]) seenAt[surface] = resp.data.at
      _pendingBumps.delete(surface)
      refreshSeenBadges()
    } else {
      _pendingBumps.set(surface, ts)
    }
  } catch (e) {
    warn('seen-state POST failed:', e?.message)
    _pendingBumps.set(surface, ts)
  }
}

// Retry any pending bumps when the tab returns to visible. Most failures are
// transient network blips; one retry usually wins. No exponential backoff —
// if it fails twice the user will clear again later (Map only holds latest
// per surface anyway).
if (!_onceGuardsSeenState.seenRetryInstalled) {
  _onceGuardsSeenState.seenRetryInstalled = true
  try {
    cleanup.addEventListener(document, 'visibilitychange', () => {
      if (document.visibilityState !== 'visible') return
      if (_pendingBumps.size === 0) return
      for (const [surface, ts] of [..._pendingBumps]) {
        _pendingBumps.delete(surface)
        bumpSeen(surface, ts)
      }
    })
  } catch {}
}

// Apply a WS-pushed seen:update from another client.
function applySeenUpdate(surface, at) {
  if (!SEEN_SURFACES.includes(surface)) return
  if (typeof at !== 'number') return
  if (at > seenAt[surface]) {
    seenAt[surface] = at
    refreshSeenBadges()
  }
}

// Register the seen:update WS listener at module load — NOT gated behind
// social tab init like before. Cross-device clears (user clears mentions on
// the website while the ext is open in another tab) used to land before
// listenForSocialEvents() ran and got silently dropped, so the red dot
// stayed lit until the next event landed. seen-state.js is loaded before
// social.js in the build concat, so module-level registration here is the
// earliest possible point.
if (!_onceGuardsSeenState.seenUpdateListener) {
  _onceGuardsSeenState.seenUpdateListener = true
  try {
    cleanup.addListener(chrome.runtime?.onMessage, (msg) => {
      if (msg?.type === 'seen_update') applySeenUpdate(msg.surface, msg.at)
    })
  } catch {}
}

// Note that a new event happened on a surface (incoming whisper, mention,
// feed post). Bumps the local latest-at so the red dot persists across a
// hard refresh until the user views the tab.
function noteSeenEvent(surface, at) {
  if (!SEEN_SURFACES.includes(surface)) return
  const ts = typeof at === 'number' ? at : Date.now()
  if (ts > latestAt[surface]) {
    latestAt[surface] = ts
    _saveSeenLocal()
    refreshSeenBadges()
  }
}

function hasUnseen(surface) {
  return latestAt[surface] > seenAt[surface]
}

// Repaint every surface's tab indicator. Called whenever any of the
// timestamps change.
function refreshSeenBadges() {
  if (!tabBarElement) return
  const map = {
    mentions: { selector: '[data-tab="mentions"]', cls: 'has-mentions' },
    whispers: { selector: '[data-tab="whispers"]', cls: 'has-whispers' },
    live: { selector: '[data-tab="feed"]', cls: 'has-new' },
  }
  for (const surface of SEEN_SURFACES) {
    const { selector, cls } = map[surface]
    const tab = tabBarElement.querySelector(selector)
    if (!tab) continue
    // Suppress while user is actually on that tab — match existing UX.
    const tabId = tab.dataset.tab
    if (currentTab === tabId) {
      tab.classList.remove(cls)
      continue
    }
    tab.classList.toggle(cls, hasUnseen(surface))
  }
}
