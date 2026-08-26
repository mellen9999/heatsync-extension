// mod-toolbar + mod-action dispatch — split out of main.js (2026-07-04).
// Hover toolbar UI and the unified ban/timeout/unban/delete dispatch backbone
// shared by every mod-action surface (toolbar/slash/ctx/card).

// =====================================================================
// MOD TOOLBAR — singleton element moved row→row on hover. Mirrors the
// heatsync.org website spec (mod-toolbar.js + mod-toolbar.css).
// Twitch only — GQL APIs already in twitch-api.js. No re-build on hover;
// only the per-row gate runs to show/hide individual buttons.
// =====================================================================
const MOD_BUTTON_CATALOG = {
  delete_message: {
    label: 'x',
    title: 'delete this message',
    action: 'delete',
    durationSec: null,
    needsMsgId: true,
  },
  timeout_1m: {
    label: '1m',
    title: 'timeout 1 minute',
    action: 'timeout',
    durationSec: 60,
    needsMsgId: false,
  },
  timeout_10m: {
    label: '10m',
    title: 'timeout 10 minutes',
    action: 'timeout',
    durationSec: 600,
    needsMsgId: false,
  },
  timeout_1h: {
    label: '1h',
    title: 'timeout 1 hour',
    action: 'timeout',
    durationSec: 3600,
    needsMsgId: false,
  },
  timeout_24h: {
    label: '24h',
    title: 'timeout 24 hours',
    action: 'timeout',
    durationSec: 86400,
    needsMsgId: false,
  },
  timeout_7d: {
    label: '7d',
    title: 'timeout 7 days',
    action: 'timeout',
    durationSec: 604800,
    needsMsgId: false,
  },
  purge: {
    label: 'purge',
    title: 'purge — clear this user’s messages (1s timeout)',
    action: 'timeout',
    durationSec: 1,
    needsMsgId: false,
  },
  ban: { label: '⛔', title: 'permanent ban', action: 'ban', durationSec: null, needsMsgId: false },
  unban: { label: '✓', title: 'unban user', action: 'unban', durationSec: null, needsMsgId: false },
}
// Hover toolbar is fully opt-in: NO buttons default-on. Even the X
// (delete-this-message) is hidden until the user enables it in settings →
// mod toolbar. Timeouts/bans live on the profile-card mod row instead —
// left-click username surfaces the full set at the top of the card.
const DEFAULT_MOD_BUTTONS = []
let modToolbarButtons = [...DEFAULT_MOD_BUTTONS]

// Per-channel mod state. Pre-fetch on tab/render so first hover doesn't lag.
const _modStateCache = new Map()
const _modStatePending = new Map()
async function isModFor(channel) {
  if (!channel) return false
  channel = channel.toLowerCase()
  if (_modStateCache.has(channel)) return _modStateCache.get(channel)
  if (_modStatePending.has(channel)) return _modStatePending.get(channel)
  const p = (async () => {
    try {
      const safe = channel.replace(/[^a-z0-9_]/g, '')
      if (!safe) return false
      const data = await twitchGql(`{ user(login: "${safe}") { self { isModerator } } }`)
      const isMod = !!data?.data?.user?.self?.isModerator
      _modStateCache.set(channel, isMod)
      return isMod
    } catch (_) {
      return false
    } finally {
      _modStatePending.delete(channel)
    }
  })()
  _modStatePending.set(channel, p)
  return p
}
function isModForSync(channel) {
  if (!channel) return false
  const c = channel.toLowerCase()
  return _modStateCache.get(c) === true
}
function prefetchModFor(channel) {
  if (!channel) return
  const c = channel.toLowerCase()
  if (!_modStateCache.has(c) && !_modStatePending.has(c)) isModFor(c)
}

// Kick mod-status — same shape as the twitch trio, backed by the kick_mod_status
// background handler (credentialed GET on the kick channel → viewer's role).
// Gates the kick mod UI so kick-only channels surface right-click/hover/profile
// mod actions. Fails closed (false) on any error — UI just doesn't appear.
const _kickModStateCache = new Map()
const _kickModStatePending = new Map()
async function isKickModFor(slug) {
  if (!slug) return false
  slug = slug.toLowerCase()
  if (_kickModStateCache.has(slug)) return _kickModStateCache.get(slug)
  if (_kickModStatePending.has(slug)) return _kickModStatePending.get(slug)
  const p = (async () => {
    try {
      const res = await safeSendMessage({ type: 'kick_mod_status', slug })
      const isMod = !!(res?.ok && res?.isMod)
      // Only cache a CONFIRMED answer. safeSendMessage returns {ok:false}
      // (never throws) on a BG-restart/early-load race — caching that false
      // would permanently kill kick mod actions for the session. Leave it
      // uncached so the next interaction retries (mirrors the twitch side,
      // which is immune only because twitchGql throws on error).
      if (res?.ok) _kickModStateCache.set(slug, isMod)
      return isMod
    } catch (_) {
      return false
    } finally {
      _kickModStatePending.delete(slug)
    }
  })()
  _kickModStatePending.set(slug, p)
  return p
}
function isKickModForSync(slug) {
  if (!slug) return false
  return _kickModStateCache.get(slug.toLowerCase()) === true
}
function prefetchKickModFor(slug) {
  if (!slug) return
  const s = slug.toLowerCase()
  if (!_kickModStateCache.has(s) && !_kickModStatePending.has(s)) isKickModFor(s)
}

// YouTube mod-status — youtube-content.js probes YT's OWN message context menu
// on the first message (a mod item present ⇒ this account can moderate here) and
// writes hs_yt_mod_status to storage. Mirror it into memory so the overlay
// ctx-menu can gate its yt mod items synchronously. A yt tab watches one live
// chat, so a single boolean suffices (no per-channel keying). Fails closed.
let _ytModState = false
function isYtModForSync() {
  return _ytModState === true
}
try {
  chrome.storage.local.get('hs_yt_mod_status', (v) => {
    void chrome.runtime.lastError
    _ytModState = !!v?.hs_yt_mod_status?.isMod
  })
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.hs_yt_mod_status) {
      _ytModState = !!changes.hs_yt_mod_status.newValue?.isMod
    }
  })
} catch (_) {}

// Singleton toolbar — built once, moved between rows.
let _modToolbar = null
let _modRow = null
let _modCtx = null
let _modHideTimer = null

function buildModToolbarOnce() {
  if (_modToolbar) return _modToolbar
  const bar = document.createElement('div')
  bar.className = 'hs-mod-toolbar'
  bar.setAttribute('role', 'toolbar')
  bar.setAttribute('aria-label', 'message moderation actions')
  bar.addEventListener('mousedown', (e) => e.stopPropagation())
  bar.addEventListener('click', (e) => e.stopPropagation())
  _modToolbar = bar
  rebuildModToolbarButtons()
  return bar
}
function rebuildModToolbarButtons() {
  if (!_modToolbar) return
  _modToolbar.textContent = ''
  for (const id of modToolbarButtons) {
    const def = MOD_BUTTON_CATALOG[id]
    if (!def) continue
    const b = document.createElement('button')
    b.className = `hs-mod-btn hs-mod-${def.action}`
    b.type = 'button'
    b.textContent = def.label
    b.title = def.title
    b.dataset.modBtn = id
    b.tabIndex = -1
    b.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation()
    })
    b.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      runModAction(id)
    })
    _modToolbar.appendChild(b)
  }
}
function gateModButtons(ctx) {
  if (!_modToolbar) return false
  let anyVisible = false
  for (const btn of _modToolbar.querySelectorAll('.hs-mod-btn')) {
    const def = MOD_BUTTON_CATALOG[btn.dataset.modBtn]
    let ok = !!def
    if (ok && def.needsMsgId && !ctx.msgId) ok = false
    if (ok && !ctx.user) ok = false
    btn.style.display = ok ? '' : 'none'
    if (ok) anyVisible = true
  }
  return anyVisible
}
function attachToRow(row) {
  if (_modRow === row && _modToolbar?.parentElement === row) return
  const bar = buildModToolbarOnce()
  const replyBtn = row.querySelector('.hs-mc-reply-btn')
  if (replyBtn) row.insertBefore(bar, replyBtn)
  else row.appendChild(bar)
  _modRow = row
}
function detachModToolbar() {
  if (_modHideTimer) {
    clearTimeout(_modHideTimer)
    _modHideTimer = null
  }
  if (_modToolbar?.parentElement) _modToolbar.parentElement.removeChild(_modToolbar)
  _modRow = null
  _modCtx = null
}
function cancelModHide() {
  if (_modHideTimer) {
    clearTimeout(_modHideTimer)
    _modHideTimer = null
  }
}
function scheduleModHide() {
  cancelModHide()
  // 0ms: detach on next task tick — cancelable by an adjacent-row mouseover
  // firing in the same event-loop turn (sibling row, mod button inside row,
  // or overlay row via the wiring in ensureStackOverlay*). 200ms felt laggy.
  _modHideTimer = setTimeout(detachModToolbar, 0)
}
// ===== Unified mod-action backbone =====
// Mod actions never echo back uniformly: Twitch ban/timeout/delete arrive
// ~1-3s later as actor-less IRC CLEARCHAT/CLEARMSG; unban/untimeout never echo
// (GQL, no channel.moderate sub); Kick echoes nothing at all. So every surface
// (slash, right-click, hover toolbar, profile card) routes through ONE
// dispatcher that fans a user-action out to the right platform(s) and injects
// an instant actor-attributed gray notice the moment each side confirms.
// Duplicate-proof: irc.js collapses the Twitch copy against the real IRC one
// (first-wins, synthetic-aware window); Kick has no competing transport so its
// line is the only one.
function _modActor() {
  return (currentUsername || (typeof authState !== 'undefined' && authState?.nick) || '').toLowerCase()
}
function _modNoticeFields(action, actor, tgt, durationSec) {
  const a = actor || tgt
  if (action === 'ban')
    return { noticeType: 'ban_success', systemMsg: a ? `${a} banned ${tgt}` : `${tgt} was permanently banned` }
  if (action === 'timeout') {
    const d = Math.max(1, durationSec | 0)
    return {
      noticeType: 'timeout_success',
      systemMsg: a ? `${a} timed out ${tgt} for ${d}s` : `${tgt} timed out for ${d}s`,
    }
  }
  if (action === 'unban' || action === 'untimeout')
    return { noticeType: 'unban_success', systemMsg: a ? `${a} unbanned ${tgt}` : `${tgt} is no longer banned` }
  if (action === 'delete')
    return {
      noticeType: 'delete_message_success',
      systemMsg: a
        ? `${a} deleted a message${tgt ? ` from ${tgt}` : ''}`
        : tgt
          ? `${tgt}'s message deleted`
          : 'message deleted',
    }
  return null
}
// Twitch — route through irc._handleMsg (dedup + buffer + render).
function _injectTwitchModNotice({ channel, action, target, durationSec, msgId }) {
  try {
    const ch = String(channel || '')
      .toLowerCase()
      .replace(/^#/, '')
    if (!ch || !irc?.channels?.has(ch)) return
    const tgt = String(target || '').replace(/^@/, '')
    const tgtLc = tgt.toLowerCase()
    const f = _modNoticeFields(action, _modActor(), tgt, durationSec)
    if (!f) return
    irc._handleMsg?.({
      type: 'notice',
      noticeType: f.noticeType,
      user: 'system',
      text: f.systemMsg,
      systemMsg: f.systemMsg,
      color: '#808080',
      badges: '',
      channel: ch,
      time: Date.now(),
      id: `hs-synth-mod-${f.noticeType}-${ch}-${tgtLc || msgId || ''}-${Date.now()}`,
      targetUser: tgtLc,
      targetMsgId: action === 'delete' ? msgId || '' : undefined,
      banDuration: action === 'timeout' ? Math.max(1, durationSec | 0) : 0,
      isSynthetic: true,
    })
  } catch (_) {}
}
// Kick — KickChat has no _handleMsg; push to its buffer + emit directly. The
// Pusher tap reflects mod actions back (kick_moderation), so self-actions are
// registered via noteSelfMod and the reflected line is collapsed there.
function _injectKickModNotice({ channel, action, target, durationSec, msgId }) {
  try {
    const slug = String(channel || '')
      .toLowerCase()
      .replace(/^#/, '')
    const buf = kickChat?.channels?.get(slug)
    if (!buf) return
    const tgt = String(target || '').replace(/^@/, '')
    const tgtLc = tgt.toLowerCase()
    const f = _modNoticeFields(action, _modActor(), tgt, durationSec)
    if (!f) return
    // Arm the Pusher-tap dedup: the tap reflects this same action back within
    // seconds — kickChat drops that reflected system line, keeps the dim.
    try {
      kickChat.noteSelfMod?.(slug, f.noticeType, action === 'delete' ? msgId : tgtLc)
    } catch (_) {}
    const m = {
      type: 'notice',
      noticeType: f.noticeType,
      user: 'system',
      text: f.systemMsg,
      systemMsg: f.systemMsg,
      color: '#808080',
      badges: '',
      channel: slug,
      time: Date.now(),
      platform: 'kick',
      id: `hs-synth-kick-mod-${f.noticeType}-${slug}-${tgtLc || msgId || ''}-${Date.now()}`,
      targetUser: tgtLc,
      isSynthetic: true,
    }
    buf.push(m)
    try {
      kickChat.emit('message', m)
    } catch (_) {}
  } catch (_) {}
}
try {
  globalThis.__hsInjectModNotice = _injectTwitchModNotice
} catch (_) {}

// Resolve a channel descriptor (tab id, twitch login, or kick slug) to its
// linked twitch login + kick slug via the O(1) channel lookup.
function _resolveModTargets(channel, platform) {
  const lookup = typeof getChannelLookup === 'function' ? getChannelLookup() : null
  const raw = String(channel || '').replace(/^#/, '')
  const lc = raw.toLowerCase()
  let entry = null
  if (lookup && raw) {
    entry =
      lookup.byId?.get(raw) ||
      lookup.byId?.get(lc) ||
      lookup.twitch?.get(raw) ||
      lookup.twitch?.get(lc) ||
      lookup.kick?.get(raw) ||
      lookup.kick?.get(lc) ||
      null
  }
  // Trust a found entry: if it's kick-only, twitchName stays null (don't fire a
  // bogus Twitch call with the tab id). Only fall back to the raw channel
  // string when NO entry exists at all (unregistered/anon channel).
  const twitchName = entry ? entry.twitch || null : platform !== 'kick' && lc ? lc : null
  const kickSlug = entry ? entry.kick || null : platform === 'kick' && lc ? lc : null
  return { twitchName, kickSlug }
}

// THE unified dispatch. ban/timeout/unban target a user; delete targets one
// message (lives on one platform). `fanout` (slash /ban) hits every linked
// platform; without it (click surfaces) only the clicked platform is touched,
// so a twitch-only mod never sees "kick failed: not a mod" noise. Returns
// { tResp, kResp, twitchName, kickSlug, anyOk } for the caller's toast.
// Minimal square confirm modal — Promise<boolean>. Keyboard-first (Esc=cancel,
// Enter=confirm), backdrop-click cancels, mounted in the overlay root so it
// works in the popout too. Reusable for any destructive action.
// Resolves to { ok, reason }. `reasons` (optional) renders selectable chips;
// the chosen one is returned (empty if none / cancelled).
function hsConfirm(message, confirmLabel = 'confirm', reasons = []) {
  return new Promise((resolve) => {
    const root = document.getElementById('hs-mc-overlay') || document.body
    const overlay = document.createElement('div')
    overlay.className = 'hs-mc-confirm-overlay'
    const box = document.createElement('div')
    box.className = 'hs-mc-confirm-box'
    const msg = document.createElement('div')
    msg.className = 'hs-mc-confirm-msg'
    msg.textContent = message
    let selectedReason = ''
    const btns = document.createElement('div')
    btns.className = 'hs-mc-confirm-btns'
    const cancelBtn = document.createElement('button')
    cancelBtn.className = 'hs-mc-confirm-cancel'
    cancelBtn.textContent = 'cancel'
    const okBtn = document.createElement('button')
    okBtn.className = 'hs-mc-confirm-ok'
    okBtn.textContent = confirmLabel
    const done = (v) => {
      overlay.remove()
      document.removeEventListener('keydown', onKey, true)
      resolve({ ok: v, reason: v ? selectedReason : '' })
    }
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        done(false)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        done(true)
      }
    }
    cancelBtn.addEventListener('click', () => done(false))
    okBtn.addEventListener('click', () => done(true))
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) done(false)
    })
    document.addEventListener('keydown', onKey, true)
    box.append(msg)
    if (Array.isArray(reasons) && reasons.length) {
      const chips = document.createElement('div')
      chips.className = 'hs-mc-confirm-reasons'
      for (const rsn of reasons) {
        const chip = document.createElement('button')
        chip.className = 'hs-mc-confirm-reason'
        chip.textContent = rsn
        chip.addEventListener('click', () => {
          const wasSel = chip.classList.contains('sel')
          for (const c of chips.querySelectorAll('.hs-mc-confirm-reason')) c.classList.remove('sel')
          if (wasSel) {
            selectedReason = ''
          } else {
            selectedReason = rsn
            chip.classList.add('sel')
          }
        })
        chips.appendChild(chip)
      }
      box.append(chips)
    }
    box.append(btns)
    btns.append(cancelBtn, okBtn)
    overlay.append(box)
    root.appendChild(overlay)
    okBtn.focus()
  })
}

async function dispatchModAction({
  channel,
  platform,
  action,
  target,
  durationSec,
  msgId,
  reason,
  fanout,
  skipConfirm,
}) {
  // Opt-in ban dialog: confirm (misclick guard) and/or reason chips. Every
  // surface routes through here, so one gate covers toolbar/slash/ctx/
  // card. Shows when confirm is on OR ban reasons are configured.
  // skipConfirm: a caller that already confirmed once for a fan-out (the YT
  // leg of a twitch/kick ban) must not re-prompt per platform.
  if (action === 'ban' && !skipConfirm) {
    const banReasons = String(modBanReasons || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
    if (modConfirmBan || banReasons.length) {
      const tgtName = String(target || '').replace(/^@/, '')
      const res = await hsConfirm(`ban ${tgtName} in #${String(channel || '').replace(/^#/, '')}?`, 'ban', banReasons)
      if (!res.ok) return { tResp: null, kResp: null, twitchName: null, kickSlug: null, anyOk: false, cancelled: true }
      if (res.reason) reason = res.reason
    }
  }
  // YouTube: a message-scoped action driven through YT's own moderation flow in
  // the live_chat content script (needs the message id, not a channel slug). YT
  // "timeout" is a fixed-duration hide, so durationSec is not used. Fixed 4-verb
  // parity with twitch/kick: delete / timeout / ban (hide user) / unban (unhide).
  if (platform === 'youtube' || platform === 'yt') {
    const yTgt = String(target || '').replace(/^@/, '')
    if (!msgId)
      return {
        tResp: null,
        kResp: null,
        yResp: { ok: false, error: 'no_message' },
        twitchName: null,
        kickSlug: null,
        anyOk: false,
      }
    // Carry the tab's videoId (same plumbing as the send path) so BG can
    // target the right stream's live_chat frame — and bridge-fallback when
    // the watch tab's collapsed chat has no frame to relay through.
    let yVid = ''
    try {
      const lkRaw = String(channel || '').replace(/^#/, '')
      const lkEntry =
        getChannelLookup().byId?.get(lkRaw) ||
        getChannelLookup().twitch?.get(lkRaw.toLowerCase()) ||
        getChannelLookup().kick?.get(lkRaw.toLowerCase()) ||
        null
      yVid = typeof currentYoutubeVideoId === 'function' ? currentYoutubeVideoId(lkEntry?.youtube || '') || '' : ''
    } catch (_) {}
    const yResp = await safeSendMessage({ type: 'youtube_mod_action', action, msgId, target: yTgt, videoId: yVid })
    return {
      tResp: null,
      kResp: null,
      yResp: yResp || { ok: false, error: 'no_response' },
      twitchName: null,
      kickSlug: null,
      anyOk: !!yResp?.ok,
    }
  }
  const { twitchName, kickSlug } = _resolveModTargets(channel, platform)
  // No resolvable platform (aggregate tab, empty/garbage channel) — fail clean
  // rather than firing a doomed API call with the tab id as a channel name.
  if (!twitchName && !kickSlug) return { tResp: null, kResp: null, twitchName: null, kickSlug: null, anyOk: false }
  const tgt = String(target || '').replace(/^@/, '')
  const sec = Math.max(1, durationSec | 0)
  const runTwitch = () =>
    action === 'ban'
      ? banTwitchUser(twitchName, tgt, reason || '')
      : action === 'timeout'
        ? timeoutTwitchUser(twitchName, tgt, sec, reason || '')
        : action === 'unban'
          ? unbanTwitchUser(twitchName, tgt)
          : action === 'delete'
            ? deleteTwitchMessage(twitchName, msgId)
            : Promise.resolve(null)
  const runKick = () =>
    safeSendMessage({
      type: 'kick_mod_action',
      action,
      slug: kickSlug,
      username: tgt,
      durationMin: action === 'timeout' ? Math.max(1, Math.round(sec / 60)) : 0,
      reason: reason || '',
      messageId: action === 'delete' ? msgId || '' : '',
    })

  if (action === 'delete') {
    // A message exists on exactly one platform. Known platform → only there;
    // unknown (e.g. /delete <id>) → twitch-first then kick fallback.
    let resp = null,
      plat = null
    if (platform === 'kick' && kickSlug) {
      plat = 'kick'
      resp = await runKick()
    } else if (platform === 'twitch' && twitchName) {
      plat = 'twitch'
      resp = await runTwitch()
    } else if (twitchName) {
      plat = 'twitch'
      resp = await runTwitch()
      if (!resp?.ok && kickSlug) {
        plat = 'kick'
        resp = await runKick()
      }
    } else if (kickSlug) {
      plat = 'kick'
      resp = await runKick()
    }
    if (resp?.ok) {
      if (plat === 'kick') _injectKickModNotice({ channel: kickSlug, action, target: tgt, msgId })
      else _injectTwitchModNotice({ channel: twitchName, action, target: tgt, msgId })
    }
    return {
      tResp: plat === 'twitch' ? resp : null,
      kResp: plat === 'kick' ? resp : null,
      twitchName,
      kickSlug,
      anyOk: !!resp?.ok,
    }
  }

  // ban / timeout / unban
  let doTwitch, doKick
  if (fanout) {
    doTwitch = !!twitchName
    doKick = !!kickSlug
  } else if (platform === 'kick') {
    doKick = !!kickSlug
    doTwitch = !doKick && !!twitchName
  } else {
    doTwitch = !!twitchName
    doKick = !doTwitch && !!kickSlug
  }
  const [tResp, kResp] = await Promise.all([doTwitch ? runTwitch() : null, doKick ? runKick() : null])
  if (tResp?.ok) _injectTwitchModNotice({ channel: twitchName, action, target: tgt, durationSec: sec })
  if (kResp?.ok) _injectKickModNotice({ channel: kickSlug, action, target: tgt, durationSec: sec })
  return { tResp, kResp, twitchName, kickSlug, anyOk: !!(tResp?.ok || kResp?.ok) }
}
try {
  globalThis.__hsDispatchMod = dispatchModAction
} catch (_) {}

// One consistent result toast for every surface.
function showModResultToast(label, target, r) {
  if (r?.cancelled) return // user cancelled the confirm dialog — no result toast
  try {
    const tResp = r?.tResp,
      kResp = r?.kResp
    const tOk = tResp?.ok,
      kOk = kResp?.ok
    if (tResp && kResp) {
      if (tOk && kOk) {
        showToast(t('mc_modtoolbar_result_both', [label, target]), 'success')
        return
      }
      if (tOk) {
        showToast(
          t('mc_modtoolbar_result_twitch_kick_failed', [label, target, kResp.error || t('mc_common_unknown')]),
          'error',
        )
        return
      }
      if (kOk) {
        showToast(
          t('mc_modtoolbar_result_kick_twitch_failed', [label, target, tResp.error || t('mc_common_unknown')]),
          'error',
        )
        return
      }
      showToast(t('mc_modtoolbar_result_both_failed', [label, tResp.error || '?', kResp.error || '?']), 'error')
      return
    }
    const only = tResp || kResp || r?.yResp
    // yt codes get their own copy (youtubeModErrorMessage); twitch/kick errors
    // are already human-readable strings from their APIs.
    const errText =
      only && only === r?.yResp
        ? youtubeModErrorMessage(only?.error)
        : only?.error === 'not_moderator'
          ? t('mc_modtoolbar_not_youtube_mod')
          : only?.error || t('mc_common_unknown')
    showToast(
      only?.ok
        ? t('mc_modtoolbar_result_single_ok', [label, target])
        : t('mc_modtoolbar_result_single_failed', [label, errText]),
      only?.ok ? 'success' : 'error',
    )
  } catch (_) {}
}
try {
  globalThis.__hsModToast = showModResultToast
} catch (_) {}

async function runModAction(id) {
  const def = MOD_BUTTON_CATALOG[id]
  if (!def || !_modCtx) return
  const { channel, user, login, msgId, row } = _modCtx
  const target = login || user
  const wasOp = row?.style?.opacity
  if (row) row.style.opacity = '0.5'
  // Act on the row's own platform (twitch or kick), single-platform.
  const r = await dispatchModAction({
    channel,
    platform: _modCtx.platform || 'twitch',
    action: def.action,
    target,
    durationSec: def.durationSec,
    msgId,
  }).catch((e) => ({ anyOk: false, tResp: { error: e?.message || 'error' } }))
  if (row) row.style.opacity = wasOp || ''
  if (r?.anyOk && def.action === 'delete' && row) markClearedRow(row, 'deleted')
  const label =
    def.action === 'timeout'
      ? t('mc_mod_label_timed_out', [String(def.durationSec)])
      : def.action === 'ban'
        ? t('mc_mod_label_banned')
        : def.action === 'unban'
          ? t('mc_mod_label_unbanned')
          : def.action === 'delete'
            ? t('mc_mod_label_deleted')
            : def.action
  showModResultToast(label, target, r)
  detachModToolbar()
}

function wireModToolbarHover(messagesEl) {
  if (!messagesEl || messagesEl._hsModToolbarWired) return
  messagesEl._hsModToolbarWired = true
  messagesEl.addEventListener(
    'mouseover',
    (e) => {
      const row = e.target.closest('.hs-mc-msg')
      if (!row) return
      if (row === _modRow) {
        cancelModHide()
        return
      }
      const plat = row.dataset.msgPlatform
      // YT mod actions live on the right-click menu (message-scoped, driven via
      // YT's own moderation flow) — the hover toolbar stays twitch/kick only.
      if (plat === 'youtube' || plat === 'yt') return
      const channel = row.dataset.msgChannel
      const user = row.dataset.msgUser
      const login = row.dataset.msgLogin || row.dataset.msgUser
      const msgId = row.dataset.msgId
      if (!channel || !user) return
      // Skip own messages — mod actions on yourself are nonsense UX. Use the
      // data-msg-self flag set at build time (currentUsername may be null at
      // hover time during pre-auth bootstrap); fall back to live compare.
      if (row.dataset.msgSelf === '1') return
      if (currentUsername && user.toLowerCase() === currentUsername.toLowerCase()) return
      // Sync gate per platform: twitch via GQL mod-state, kick via kick_mod_status.
      // Pre-fetch the right one so the next hover in this channel is instant.
      const isKick = plat === 'kick'
      const amMod = isKick ? isKickModForSync(channel) : isModForSync(channel)
      if (!amMod) {
        ;(isKick ? prefetchKickModFor : prefetchModFor)(channel)
        return
      }
      const ctx = { channel, user, login, msgId, row, platform: plat || 'twitch' }
      _modCtx = ctx
      buildModToolbarOnce()
      if (!gateModButtons(ctx)) return
      attachToRow(row)
      cancelModHide()
    },
    true,
  )
  messagesEl.addEventListener(
    'mouseout',
    (e) => {
      if (!_modRow) return
      const to = e.relatedTarget
      if (to && _modRow.contains(to)) return
      scheduleModHide()
    },
    true,
  )
  // Only do work when a toolbar is actually open — the common case is
  // scrolling with none attached, where this must stay a cheap no-op.
  messagesEl.addEventListener(
    'scroll',
    () => {
      if (_modRow || _modHideTimer) detachModToolbar()
    },
    { passive: true },
  )
}

// NO bare-key mod hotkeys. x/t/b/s used to fire off a hovered row whenever the
// composer wasn't focused — but the mouse resting over chat is the normal
// reading position, so the first letter of a message ("thanks" → t) silently
// timed a chatter out, and `s` opened a bulk-select mode nobody asked for.
// Destructive actions take a deliberate click: the hover toolbar buttons, the
// right-click menu, or the profile card. Don't re-add a bare-letter bind here
// — the composer owns printable keys, always.
