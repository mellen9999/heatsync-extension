// Cross-platform follow propagation
//
// When the user follows another user on heatsync, also follow them on Twitch
// and Kick if they have linked accounts there. Twitch's public follow REST
// API was killed Aug 2023; we use the same private GraphQL mutation
// (FollowButton_FollowUser) that Twitch's own UI fires, through the existing
// integrity/relay plumbing in twitch-api.js. Kick has no public follow
// endpoint at all; we POST /api/v2/channels/{slug}/follow with the user's
// own session cookie + XSRF token (same surface as our chat-send relay).
//
// YouTube is intentionally NOT propagated — the Innertube subscribe path
// requires SAPISIDHASH minting in a youtube.com tab, has the highest ToS
// risk of the three, and youtube tabs are rare for HeatSync's user base.
//
// Failure handling: heatsync follow is the source of truth. Platform follows
// are best-effort. If we can't reach a platform right now (no twitch.tv tab
// open + integrity unavailable, kick not logged in, etc.), the action is
// queued to chrome.storage.local.hs_pending_follows and drained on next
// platform tab navigation. The queue collapses follow/unfollow pairs (last
// write wins), caps at 100 entries, and drops items older than 7 days.

const HS_PENDING_KEY = 'hs_pending_follows'
const HS_PENDING_MAX = 100
const HS_PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

// Per-platform user preference. Defaults all on. Read from ui_settings on
// each call so toggling in settings UI applies without a reload.
async function _crossFollowSettings() {
  try {
    // ui_settings is the SYNC blob (settings-schema scope:'sync' → it; every
    // ui_settings write in main.js targets storage.sync). Reading it from
    // storage.local returned {} every time, so crossFollowKick was pinned to
    // its default (true) and the toggle did nothing. Read from sync to match.
    // api.storage.sync.get returns a Promise directly — don't wrap in a
    // callback shim (it's promise-based; a callback never fires).
    const stored = await api.storage.sync.get(['ui_settings'])
    const ui = stored?.ui_settings || {}
    return {
      twitch: ui.crossFollowTwitch !== false,
      kick: ui.crossFollowKick !== false,
      twitchNotifyTarget: ui.crossFollowTwitchNotify !== false,
    }
  } catch {
    return { twitch: true, kick: true, twitchNotifyTarget: true }
  }
}

// ─── Queue helpers ──────────────────────────────────────────────────────────

async function _readQueue() {
  try {
    const stored = await api.storage.local.get([HS_PENDING_KEY])
    const arr = Array.isArray(stored?.[HS_PENDING_KEY]) ? stored[HS_PENDING_KEY] : []
    const cutoff = Date.now() - HS_PENDING_MAX_AGE_MS
    const fresh = arr.filter((x) => x && typeof x.ts === 'number' && x.ts >= cutoff)
    return fresh.slice(-HS_PENDING_MAX)
  } catch {
    return []
  }
}

async function _writeQueue(arr) {
  try {
    await api.storage.local.set({ [HS_PENDING_KEY]: arr })
  } catch {}
}

// Queue writes are read→modify→write on shared storage; overlapping RMWs
// (fire-and-forget propagateFollow calls, drains) would clobber each other's
// entries. Chain them so each RMW sees the previous one's write.
let _queueChain = Promise.resolve()
function _queueTask(fn) {
  const run = _queueChain.then(fn)
  _queueChain = run.catch(() => {})
  return run
}

// Insert / replace. If a previous entry for the same {platform, target}
// exists, the newer one supersedes it — last write wins, so follow/unfollow
// rapid toggles collapse rather than queueing both.
async function _enqueue(item) {
  if (!item?.platform || !item?.target) return
  return _queueTask(async () => {
    const q = await _readQueue()
    const filtered = q.filter((x) => !(x.platform === item.platform && x.target === item.target))
    filtered.push({ ...item, ts: Date.now() })
    await _writeQueue(filtered.slice(-HS_PENDING_MAX))
  })
}

async function _dequeueMatching(platform, target) {
  return _queueTask(async () => {
    const q = await _readQueue()
    const filtered = q.filter((x) => !(x.platform === platform && x.target === target))
    if (filtered.length !== q.length) await _writeQueue(filtered)
  })
}

// Drain all pending items for a platform. Called from background SW after it
// detects the user navigated to twitch.com / kick.com (or by hand via a
// debug command). Each item gets one retry; if it fails again, stays queued.
async function drainPendingFollows(platform) {
  if (!platform) return { ok: false, drained: 0 }
  const q = await _readQueue()
  const mine = q.filter((x) => x.platform === platform)
  if (!mine.length) return { ok: true, drained: 0 }
  let drained = 0
  const drainedItems = []
  for (const item of mine) {
    let result = { error: 'unknown platform' }
    if (platform === 'twitch') {
      // Use _twitchFollow (full chain incl. DOM-click) when slug available,
      // otherwise fall back to id-only path which only attempts the GQL routes.
      if (item.username) {
        result = await _twitchFollow(item.target, item.action === 'follow', item.disableNotifications, item.username)
      } else {
        result = await (typeof followTwitchUserById === 'function'
          ? followTwitchUserById(item.target, item.action === 'follow', item.disableNotifications)
          : { error: 'no helper' })
      }
    } else if (platform === 'kick') {
      result = await _kickFollow(item.target, item.action === 'follow')
    }
    if (result?.ok) {
      drained++
      drainedItems.push(item)
      await _dequeueMatching(platform, item.target)
    }
  }
  // Log drain attempt outcome — useful to see in console why a pending follow
  // didn't sync (e.g. apollo path failed silently). One line per drain cycle.
  try {
    if (mine.length) console.warn('[heatsync] drained', platform, drained, 'of', mine.length, 'pending')
  } catch {}
  // Soft success toast so the user knows their queued follows just synced.
  if (drained > 0 && typeof showToast === 'function') {
    const sample = drainedItems[0]?.username || drainedItems[0]?.target || ''
    const verb = drainedItems[0]?.action === 'unfollow' ? 'unfollowed' : 'followed'
    if (drained === 1 && sample) {
      showToast(
        t(verb === 'unfollowed' ? 'mc_crossfollow_drain_one_unfollow' : 'mc_crossfollow_drain_one_follow', [
          sample,
          platform,
        ]),
        'success',
      )
    } else {
      showToast(t('mc_crossfollow_drain_synced', [String(drained), platform]), 'success')
    }
  }
  return { ok: true, drained }
}

// Expose for background SW: a content-script listener that drains on demand.
if (typeof api !== 'undefined' && api?.runtime?.onMessage) {
  api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'cross_follow_drain' && typeof msg.platform === 'string') {
      drainPendingFollows(msg.platform)
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, error: e?.message }))
      return true
    }
    return false
  })
}

// ─── Kick follow ────────────────────────────────────────────────────────────
//
// SW direct fetch with credentials:include + XSRF cookie. No relay needed
// since the extension has host_permissions for kick.com/* and the user's
// own session cookie travels naturally. If XSRF missing → kick not logged
// in → queue.

async function _kickFollow(slug, follow) {
  if (!slug) return { error: 'no slug' }
  const safeSlug = String(slug)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 64)
  if (!safeSlug) return { error: 'invalid slug' }
  try {
    const resp = await safeSendMessage({
      type: 'kick_follow',
      slug: safeSlug,
      follow: !!follow,
    })
    if (resp?.ok) return { ok: true, idempotent: !!resp.idempotent }
    if (resp?.error === 'kick_not_logged_in') return { error: 'kick_not_logged_in', queueable: true }
    return { error: resp?.error || 'kick follow failed', queueable: true }
  } catch (e) {
    return { error: e?.message || 'kick follow throw', queueable: true }
  }
}

// ─── Twitch follow ──────────────────────────────────────────────────────────
//
// Twitch's public follow REST API was killed Aug 2023. Only programmatic path
// left is the FollowButton_FollowUser GQL mutation — but only when fired
// through Twitch's OWN Apollo client (so the link chain attaches the strong
// per-mutation integrity tokens Twitch's anti-bot demands). Direct gql.twitch.tv
// fetches with even a freshly-minted /integrity token get rejected as
// "failed integrity check" — the strong tokens only validate when added by
// Apollo's link middleware. Verified 2026-05-26.
//
// _followMutation (twitch-api.js) handles all the routing:
//   - on twitch.tv: apolloMutate via MAIN-world finder (Document + fragment deps
//     resolved via recursive webpack require — see early-inject-main.js)
//   - off twitch.tv: relay through any open twitch.tv tab (background SW
//     picks the tab + executes the script there)
//   - no twitch.tv tab open: queueable — drained next time user visits twitch.tv
async function _twitchFollow(targetID, follow, disableNotifications, _targetSlug) {
  if (!targetID) return { error: 'no target id' }
  if (typeof followTwitchUserById !== 'function') return { error: 'follow helper missing' }
  return followTwitchUserById(targetID, follow, disableNotifications)
}

// Does the viewer have a session on this platform at all? A kick-only or
// twitch-only user must not get "follow queued" toasts (or queue entries that
// can never drain) for the platform they don't use. Both probes read the
// platform's own cookies in the background; a failed probe reads as no session.
async function _hasPlatformSession(platform) {
  try {
    if (platform === 'twitch') return !!(await getTwitchAuthTokenAsync()).token
    return !!(await safeSendMessage({ type: 'kick_session_status' }))?.loggedIn
  } catch (_) {
    return false
  }
}

// ─── Main entry: called from pcToggleFollow + pcToggleBlock ─────────────────
//
// target shape: { twitch_id, twitch_username, kick_username, youtube_channel_id, youtube_username }
// follow=true → propagate follow; follow=false → propagate unfollow.
// Returns: { twitch: {...}, kick: {...} } — caller can surface diagnostics
// in dev mode but the default UX is silent best-effort.
async function propagateFollow(follow, target) {
  if (!target) return { kick: { skipped: 'no target' } }
  const settings = await _crossFollowSettings()
  // Distinct skip reasons — a user-disabled toggle is not a privacy signal
  // and callers (pcToggleFollow's skip toast) must never conflate the two.
  const out = {
    twitch: { skipped: settings.twitch ? 'no twitch id' : 'disabled' },
    kick: { skipped: settings.kick ? 'no kick username' : 'disabled' },
  }

  if (settings.twitch && target.twitch_id && !(await _hasPlatformSession('twitch'))) {
    out.twitch = { skipped: 'no twitch session' }
  } else if (settings.twitch && target.twitch_id) {
    const verb = follow ? 'follow' : 'unfollow'
    const r = await _twitchFollow(target.twitch_id, follow, !settings.twitchNotifyTarget, target.twitch_username)
    if (r?.ok) {
      out.twitch = { ok: true, idempotent: !!r.idempotent }
      await _dequeueMatching('twitch', String(target.twitch_id))
    } else {
      out.twitch = { error: r?.error || 'twitch follow failed' }
      if (r?.queueable) {
        await _enqueue({
          platform: 'twitch',
          target: String(target.twitch_id),
          username: target.twitch_username ? String(target.twitch_username).toLowerCase() : undefined,
          action: follow ? 'follow' : 'unfollow',
          disableNotifications: false,
        })
      }
      // Surface 2fa requirement — user has to satisfy it on twitch.tv
      if (r?.error === '2fa_required' && typeof showToast === 'function') {
        showToast(t(verb === 'follow' ? 'mc_crossfollow_2fa_follow' : 'mc_crossfollow_2fa_unfollow'), 'info')
      } else if (r?.queueable && typeof showToast === 'function') {
        // Queued (no twitch.tv tab to relay through) — say so instead of the
        // silent enqueue; drains ~2.5s after the next twitch.tv visit.
        showToast(
          t(verb === 'follow' ? 'mc_crossfollow_twitch_queued_follow' : 'mc_crossfollow_twitch_queued_unfollow'),
          'info',
        )
      }
    }
  }

  if (settings.kick && target.kick_username && !(await _hasPlatformSession('kick'))) {
    out.kick = { skipped: 'no kick session' }
  } else if (settings.kick && target.kick_username) {
    const verb = follow ? 'follow' : 'unfollow'
    const r = await _kickFollow(target.kick_username, follow)
    if (r?.ok) {
      out.kick = { ok: true, idempotent: !!r.idempotent }
      await _dequeueMatching('kick', String(target.kick_username).toLowerCase())
    } else {
      out.kick = { error: r?.error || 'kick follow failed' }
      if (r?.queueable) {
        await _enqueue({
          platform: 'kick',
          target: String(target.kick_username).toLowerCase(),
          action: follow ? 'follow' : 'unfollow',
        })
      }
      // Surface only login-needed; treat other transient kick errors as silent
      // (heatsync follow already toasted; we don't want noise on each follow).
      if (r?.error === 'kick_not_logged_in' && typeof showToast === 'function') {
        showToast(
          t(verb === 'follow' ? 'mc_crossfollow_kick_queued_follow' : 'mc_crossfollow_kick_queued_unfollow'),
          'info',
        )
      }
    }
  }
  return out
}
