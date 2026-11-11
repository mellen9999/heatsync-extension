// part 6 of 8 of the multichat main body — the render pass, live status polling, usernames and mentions.
// one scope with the other main-*.js parts and main.js at bundle time (build.js MAIN_PARTS, in list order).
// no wrapper here: the IIFE is the bundle's.

function _renderMessagesImpl(id, opts) {
  if (editingChannel) return
  // The pinned bar follows the tab on screen (same rooms inside 30s: a repaint only)
  if (typeof pinSync === 'function') pinSync(id)
  // The first-run tour card sits beside it; once it is seen this is one boolean check
  if (typeof tourSync === 'function') tourSync(id)
  // Idempotent — ensures mod toolbar hover works even when extension reloads
  // mid-session (the overlay-init setTimeout doesn't re-fire).
  const _msgsForMod = document.getElementById('hs-mc-messages')
  if (_msgsForMod && !_msgsForMod._hsModToolbarWired) wireModToolbarHover(_msgsForMod)
  // Pre-fetch isMod for the active channel so first hover is instant.
  // (a built-in tab — feed, live, add — is not a twitch login)
  if (typeof id === 'string' && /^[a-z0-9_]{2,40}$/i.test(id) && !mcChromeTabIds().includes(id)) prefetchModFor(id)
  // Symmetric kick warm-up — so the first kick right-click/hover surfaces mod
  // actions without a cold-cache miss (resolve the linked kick slug for this tab).
  const _chForMod = typeof getChannelById === 'function' ? getChannelById(id) : null
  if (_chForMod?.kick) prefetchKickModFor(_chForMod.kick)
  // A confirm panel sits over the pane: leave the rows alone, close repaints
  if (hsPanePanelOpen()) return
  // Profile card overrides normal tab content while open
  if (typeof activeProfileCard !== 'undefined' && activeProfileCard) {
    renderProfileCardView()
    return
  }
  // Predictions/polls take the chat area the same way. Without this guard the
  // next incoming message repaints chat straight over the open view.
  if (typeof predViewOpen === 'function' && predViewOpen()) {
    renderPredView()
    return
  }
  // A full-size picture stays put; nothing repaints over it (← back closes it)
  if (typeof imgViewOpen === 'function' && imgViewOpen()) return
  // Social tabs have their own renderers — banner doesn't apply there
  if (id === 'feed') {
    hideMultistreamBanner()
    renderFeed()
    return
  }
  if (id === 'whispers') {
    hideMultistreamBanner()
    renderWhispersTab()
    return
  }
  if (id === 'discover') {
    hideMultistreamBanner()
    renderDiscoverTab()
    return
  }
  if (id === 'pinned') {
    hideMultistreamBanner()
    renderPinnedTab()
    return
  }
  if (id === 'modlog') {
    hideMultistreamBanner()
    renderModLogTab()
    return
  }
  if (id === 'settings') {
    hideMultistreamBanner()
    renderSettingsTab()
    return
  }
  if (id === 'mentions') {
    hideMultistreamBanner()
  }
  // Banner: streamer-tab only (live or per-channel)
  if (id === 'live') {
    const liveCh = getLiveChannel()
    maybeShowMultistreamBanner(liveCh, hostPlatform)
  } else if (
    id &&
    id !== 'add' &&
    !['mentions', 'feed', 'whispers', 'discover', 'pinned', 'modlog', 'settings'].includes(id)
  ) {
    // Per-channel tab — id may be a username or a linked-tab id; resolve from config
    const ch = getChannelById(id)
    // YT-only channels: extract handle from the youtube URL so the banner can
    // resolve identity ("foo is also live on Twitch + Kick") for them too.
    let ytHandle = null
    if (ch?.youtube && !ch.twitch && !ch.kick) {
      const m = ch.youtube.match(/@([^/?]+)/)
      if (m) ytHandle = m[1]
    }
    const channelName = (ch && (ch.twitch || ch.kick)) || ytHandle || id
    const platHint = ch?.twitch ? 'twitch' : ch?.kick ? 'kick' : ytHandle ? 'youtube' : null
    maybeShowMultistreamBanner(channelName, platHint)
  }

  // If search is active on mentions tab, don't clobber search results
  if (id === 'mentions') {
    const searchInput = document.getElementById('hs-mc-search-input')
    if (searchInput?.value.trim()) return
  }

  const msgsEl = document.getElementById('hs-mc-messages')
  if (!msgsEl) return

  // Consume the cache-restored flag exactly once per render, here — BEFORE the
  // scrolled-up early-return below. If we only reset it at the fast-path site
  // (further down), a scrolled-up render returns early and strands the flag
  // true; the NEXT render — for a different, uncached tab — then wrongly takes
  // the append-only "trust mounted DOM" path and bleeds the prior channel's
  // messages into the new view. Capturing it now scopes it to this one render.
  const _renderT0 = performance.now()
  const justRestored = _cacheJustRestored
  _cacheJustRestored = false

  const newBtn = document.getElementById('hs-mc-new-msgs')

  // Scrolled-up readers normally don't re-render (live msgs just bump the
  // "N new" counter). loadOlderScrollback passes bypassScrollPause so it CAN
  // re-render while paused — to paint older rows — without yanking the view
  // (it anchors scroll itself afterward).
  if (isScrolledUp && !opts?.bypassScrollPause) {
    // Held by hover: nothing new is promised, the release re-renders and shows it all.
    if (hoverHeld) {
      _holdMissedRender = true
      return
    }
    newMessageCount++
    if (newBtn) {
      const arrow = document.createElement('span')
      arrow.className = 'hs-arrow-down'
      arrow.textContent = '▼'
      newBtn.replaceChildren(arrow, ` ${t('mc_new_messages', [String(Number(newMessageCount) || 0)])}`)
      newBtn.style.display = 'flex'
    }
    return
  }

  let msgs = []
  let mtSrcs = null // the merged tab's sources, for mtNoteRender below
  if (id === 'mentions') {
    msgs = mentionsBuffer
  } else if (id === 'add') {
    hideMultistreamBanner()
    renderAddChannelForm(msgsEl)
    return
  } else {
    // live tab or channel tab: twitch + kick + youtube, merged fairly (see
    // merged-tab.js for where each source comes from)
    mtSrcs = mergedTabSources(id, SCROLLBACK_MAX, true)
    msgs = fairMerge(mtSrcs)
  }

  // Merge follow stream events into channel + live tabs (went live,
  // switched game, went offline). Skip mentions: it's reserved for actual
  // @-mentions of the user, not followed-channel stream events. msgs is
  // already chronological from fairMerge, and `missing` is tiny, so
  // binary-insert each at its position instead of re-sorting the whole buffer.
  if (id !== 'mentions' && activityEvents.length > 0 && msgs.length > 0) {
    // Cheap pre-filter first: only scan msgs for existing stream-event texts
    // when there actually are follow-class events to merge — activityEvents
    // is usually all non-follow, and the msgs scan is O(buffer) per render.
    let followEvents = null
    for (const e of activityEvents) {
      if (e.eventClass?.includes('event-follow')) (followEvents ??= []).push(e)
    }
    const existingTexts = followEvents
      ? new Set(msgs.filter((m) => m.type === 'stream-event').map((m) => m.text))
      : null
    const missing = followEvents ? followEvents.filter((e) => !existingTexts.has(e.text)) : []
    for (const e of missing) {
      let lo = 0
      let hi = msgs.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (byTimeStable(msgs[mid], e) < 0) lo = mid + 1
        else hi = mid
      }
      msgs.splice(lo, 0, e)
    }
  }

  updateTabBadges()

  if (msgs.length === 0) {
    _clearMessageIndices()
    msgsEl.textContent = ''
    const empty = document.createElement('div')
    empty.className = 'hs-mc-empty'
    // First-run: a blank "no messages" panel teaches a new user nothing. When
    // no channels are configured, show an actionable CTA pointing at the core
    // multichat value (add streams across platforms) instead of a dead end.
    if (id === 'live' && !config.channels?.length) {
      appendCockpitCta(empty)
    } else if (isTabConnecting(id)) {
      // Not wired up yet — say so rather than claiming an empty chat we
      // haven't actually connected to.
      empty.textContent = t('mc_connecting')
    } else {
      empty.textContent = t('mc_no_messages')
    }
    msgsEl.appendChild(empty)
    return
  }

  // Stale-event guard: drop stream-events older than 2h so the 24h
  // event archive doesn't pile up at the top. Chat volume is bound by the
  // data buffers plus the DOM_RENDER_CAP live-row cap below.
  const STALE_WINDOW_MS = 2 * 60 * 60 * 1000
  let newestTime = 0
  for (let i = msgs.length - 1; i >= 0; i--) {
    const t = msgs[i]?.time
    if (t && t > newestTime) newestTime = t
    if (i < msgs.length - 50 && newestTime > 0) break
  }
  if (newestTime > 0) {
    const cutoff = newestTime - STALE_WINDOW_MS
    const first = msgs[0]
    if (first?.time && first.time < cutoff) {
      msgs = msgs.filter((m) => m.type !== 'stream-event' || !m.time || m.time >= cutoff)
    }
  }

  const _ff = _filterFlags()
  let toRender = msgs.filter((m) => !m?.hidden && !isMsgFiltered(m, _ff))
  if (mtSrcs) toRender = foldSimulcastLegs(toRender)
  if (_ff.dups) {
    const out = []
    let prevText = null
    for (const m of toRender) {
      const txt = typeof m.text === 'string' ? m.text : null
      if (txt !== null && txt === prevText) continue
      if (txt !== null) prevText = txt
      out.push(m)
    }
    toRender = out
  }
  // Live-tab local filter: matcher compiled ONCE per query (not per message)
  // so /regex/ patterns, ReDoS guards, and @user/text modes are all O(1) setup.
  const _liveQ = liveSearchQuery(id)
  const _liveMatcher = _liveQ ? buildLiveSearchMatcher(_liveQ) : null
  const _liveCountEl = document.getElementById('hs-mc-search-count')
  if (_liveMatcher) {
    toRender = toRender.filter((m) => _liveMatcher.test(m))
    if (_liveCountEl) {
      // Plain total normally; "i/N" while an n/N cursor is active. The
      // cursor is keyed by msgKey (not a DOM ref), so its position is
      // re-derived from the freshly filtered array on every render — if
      // the current match dropped out of the filter (dedup, trim, edit),
      // this naturally falls back to the plain total and drops the cursor.
      const _curIdx = _liveSearchCurrentKey ? toRender.findIndex((m) => msgKeyOf(m) === _liveSearchCurrentKey) : -1
      if (_liveSearchCurrentKey && _curIdx === -1) _liveSearchCurrentKey = null
      _liveCountEl.textContent = _curIdx >= 0 ? `${_curIdx + 1}/${toRender.length}` : String(toRender.length)
      _liveCountEl.classList.add('visible')
    }
    if (toRender.length === 0) {
      _clearMessageIndices()
      msgsEl.textContent = ''
      const empty = document.createElement('div')
      empty.className = 'hs-mc-empty'
      empty.textContent = t('common_no_matches')
      msgsEl.appendChild(empty)
      return
    }
  } else {
    if (_liveCountEl) _liveCountEl.classList.remove('visible')
    _clearLiveSearchCursor()
  }
  // Live tail is always DOM_RENDER_CAP; _scrollbackWindow adds older rows
  // when the user has scrolled to the top (loadOlderScrollback). Capped at
  // SCROLLBACK_MAX so the DOM stays bounded on low-RAM hardware.
  const _renderCap = Math.min(DOM_RENDER_CAP + _scrollbackWindow, SCROLLBACK_MAX)
  let _cap = _renderCap
  if (_paintFor === id) _cap = Math.min(_cap, _paintCap)
  else if (
    _paintFor === null &&
    !justRestored &&
    toRender.length > FIRST_PAINT_ROWS &&
    !msgsEl.querySelector('[data-msg-key]')
  ) {
    _paintFor = id
    _paintCap = FIRST_PAINT_ROWS
    _cap = FIRST_PAINT_ROWS
    growFirstPaint(id)
  }
  toRender = toRender.slice(-_cap)
  isProgrammaticScroll = true

  // STABLE-ORDER RENDER:
  // mellen's bulletproof rules: (1) once a msg is in DOM, it never changes
  // position; (2) order is correct BEFORE showing; (3) zebra never flickers.
  //
  // strategy: insert-only diff.
  //   - PASS A: remove DOM children whose msgKey is no longer in `toRender`
  //     (msg trimmed off the buffer cap or filter-toggled out).
  //   - PASS B: walk `toRender` in order. a msg already in the DOM stays
  //     where it is; a NEW msg goes right after the node standing for the
  //     previous desired msg (or first, if none).
  //
  // existing DOM nodes stay put. new msgs slot in at chronologically
  // correct positions (because `toRender` is already chrono-sorted by
  // fairMerge below). no shuffling. no rebuild-from-prefix flash. rows whose
  // data-hs-epoch predates _renderEpoch are rebuilt via same-slot replaceChild
  // in PASS B — even a full invalidation never moves a row. Collections are
  // pooled (_rm* buffers above stableMsgId); zebra lives in zebraOfInsert.
  const desiredKeys = _rmDesiredKeys
  const desiredSet = _rmDesiredSet
  desiredKeys.length = 0
  desiredSet.clear()
  for (let j = 0; j < toRender.length; j++) {
    const k = msgKeyOf(toRender[j])
    desiredKeys.push(k)
    desiredSet.add(k)
  }

  // PASS 0: capture expanded emote stacks (mostly relevant for full rebuilds
  // when _renderEpoch increments — stacks would otherwise reset to collapsed).
  // Short-circuit the per-child scan: an expanded stack is rare (user has to
  // click one open), so one querySelector that stops at the first match beats
  // up to DOM_RENDER_CAP querySelectorAll walks every render. When none is
  // expanded, expandedStacks stays empty and the reapply below no-ops — same
  // result as scanning all children and finding nothing.
  const expandedStacks = []
  if (msgsEl.querySelector('.hs-mc-emote-stack.expanded')) {
    for (const msgDiv of msgsEl.children) {
      const mid = msgDiv.dataset?.msgId
      if (!mid) continue
      const stacks = msgDiv.querySelectorAll('.hs-mc-emote-stack')
      for (let s = 0; s < stacks.length; s++) {
        if (stacks[s].classList.contains('expanded')) expandedStacks.push([mid, s])
      }
    }
  }

  // CACHE-RESTORED FAST PATH: when restoreTabState just mounted a cached
  // fragment, trust its DOM order. Don't remove/reorder — only APPEND
  // msgs the user didn't see yet (those whose key isn't in DOM). This
  // eliminates the brief "reorder shimmer" from fairMerge proportions
  // shifting after new msgs arrived during the user's absence.
  if (justRestored) {
    const _rp0 = performance.now()
    const insertedKeys = _rmInsertedKeys
    insertedKeys.clear()
    for (let j = 0; j < toRender.length; j++) {
      const key = desiredKeys[j]
      if (insertedKeys.has(key)) continue
      insertedKeys.add(key)
      if (_msgKeyIndex.has(key)) continue // already in DOM somewhere — leave it
      const m = toRender[j]
      const div = buildMessageDiv(m, id)
      if (!div) continue
      div.dataset.msgKey = key
      div.dataset.hsEpoch = String(_renderEpoch)
      const prev = msgsEl.lastElementChild
      stampZebra(div, m, prev)
      msgsEl.appendChild(div)
      _indexMessageDiv(div, key)
      _snapCompleteEmotes(div)
    }
    if (msgsEl.children.length > toRender.length) trimMessagesEl(msgsEl, toRender.length)
    const _rp1 = performance.now()
    applyMcMutes()
    const _rp2 = performance.now()
    // Re-apply cleared (ban/timeout/delete) state to cached nodes that were
    // in a DocumentFragment while the mod action fired — buildMessageDiv was
    // skipped for these, so patch the class directly now.
    if (dimTimeouts) {
      const keyToMsg = new Map()
      for (let j = 0; j < toRender.length; j++) keyToMsg.set(desiredKeys[j], toRender[j])
      for (const child of msgsEl.children) {
        const k = child.dataset?.msgKey
        if (!k) continue
        const cm = keyToMsg.get(k)
        if (cm?.cleared) {
          child.classList.add('hs-mc-msg-cleared')
          if (cm.clearedReason) child.dataset.clearedReason = cm.clearedReason
        }
      }
    }
    // Cached fragment was mounted as-is — restored messages bypassed
    // buildMessageDiv, so their 7TV paint/badge was never queued or applied
    // (cached HTML is paint-less). Re-apply for already-resolved users and
    // queue lookups for the rest; updateCosmeticsInPlace repaints via the
    // restored _uidIndex once each resolves.
    // HeatSync paints are a SEPARATE cache from 7TV cosmetics (hsPaintCache
    // in paints.js vs mcUserCosmetics here) — a paint can already be
    // resolved even when mcUserCosmetics has nothing for this uid, so it
    // needs its own re-apply pass here too. Without this, a painted user's
    // restored rows (reload, tab-switch-back) stay unpainted forever: the
    // cache-restored fast path returns below and never calls
    // buildMessageDiv, which is the only other place that applies a paint.
    // Plus tenure has the exact same restored-fragment gap as HeatSync
    // paints above — a cached fragment predates this session's tenure
    // resolution, so an already-active Plus member's restored rows never
    // show the token without this pass.
    const _restoredCosUids = []
    const _restoredPaintUids = []
    const _restoredPlusUids = []
    for (const m of toRender) {
      if (!m.userId) continue
      if (mcUserCosmetics.has(m.userId)) _restoredCosUids.push(m.userId)
      else queueMcCosmeticsLookup(m.userId)
      if (hasResolvedHsPaint(m.userId)) _restoredPaintUids.push(m.userId)
      const since = getHsPlusTenureSince(m.userId)
      if (since || getHsBadgeId(m.userId)) _restoredPlusUids.push(m.userId)
      else if (since === undefined) queuePlusTenureLookup(m.userId)
    }
    const _rp3 = performance.now()
    if (_restoredCosUids.length) updateCosmeticsInPlace([...new Set(_restoredCosUids)])
    const _rp4 = performance.now()
    if (_restoredPaintUids.length) updateHsPaintsInPlace([...new Set(_restoredPaintUids)])
    const _rp5 = performance.now()
    if (_restoredPlusUids.length) applyHsPlusTenureToVisible([...new Set(_restoredPlusUids)])
    const _rp6 = performance.now()
    _restoreParts = {
      prep: Math.round(_rp0 - _renderT0),
      append: Math.round(_rp1 - _rp0),
      mutes: Math.round(_rp2 - _rp1),
      scan: Math.round(_rp3 - _rp2),
      cosmetics: Math.round(_rp4 - _rp3),
      paints: Math.round(_rp5 - _rp4),
      plus: Math.round(_rp6 - _rp5),
      paintUids: _restoredPaintUids.length,
    }
    cleanup.raf(() => {
      isProgrammaticScroll = false
    })
    if (
      !isScrolledUp &&
      !(id === 'feed' || id === 'settings' || id === 'discover' || id === 'pinned' || id === 'modlog')
    ) {
      scrollMsgsToBottom(msgsEl)
    }
    if (mtSrcs) mtNoteRender(id, mtSrcs)
    return
  }

  flushHeldOlder() // the diff below walks the whole list
  // PASS A: index existing DOM by msgKey, dedup pre-existing duplicates,
  // detach yt-status notices for re-pin at end, drop everything else not in
  // desiredSet. Pre-existing dupes can exist when a prior buggy diff (or
  // a code path that bypassed the diff) inserted twice — heal them here so
  // the renderer is self-correcting across reloads of buggy state.
  const existingByKey = _rmExistingByKey
  existingByKey.clear()
  const detachedExtras = []
  // a row removed below another leaves the rows under it a beat out of phase;
  // the lowest such gap is where the upward restripe starts
  let zebraGap = false
  let zebraGapBelow = null
  const dropRow = (c) => {
    if (c.previousElementSibling) {
      zebraGap = true
      zebraGapBelow = c.nextElementSibling
    }
    _unindexMessageDiv(c)
    c.remove()
  }
  // Walk the LIVE HTMLCollection in place instead of materializing
  // [...msgsEl.children] (up to DOM_RENDER_CAP+scrollback nodes, every
  // render). Safe because we only ever advance `i` when the current child
  // is KEPT: removing children[i] slides the next child into that same
  // index, so re-checking index i next iteration is correct — nothing is
  // skipped, and nothing here reorders a kept node.
  for (let i = 0; i < msgsEl.children.length; ) {
    const c = msgsEl.children[i]
    if (c.dataset?.hsYtStatus && c.dataset?.hsYtStatusTab === String(id)) {
      detachedExtras.push(c)
      c.remove() // yt-status pins aren't tracked in indices
      continue
    }
    // the docked/filled video player lives in the scroller but is not a row —
    // sweeping it here killed it on the next full render (popout: instantly)
    if (c.id === 'hs-mc-embed-player') {
      i++
      continue
    }
    const k = c.dataset?.msgKey
    if (k && desiredSet.has(k)) {
      if (existingByKey.has(k)) {
        dropRow(c) // pre-existing dupe — drop the second copy
        continue
      }
      existingByKey.set(k, c)
    } else {
      dropRow(c)
      continue
    }
    i++
  }
  if (zebraGap) zebraRepaintUp(msgsEl, zebraGapBelow?.isConnected ? zebraGapBelow : null)

  // Bulletproof sticky-bottom: if the user hasn't scrolled up via input,
  // we re-pin unconditionally. Geometric "wasAtBottom" snapshot was
  // unreliable — a width rewrap, image-load reflow, or content-visibility
  // resolve could shift scrollTop a few px and flip the gate to false even
  // though the user logically was at-bottom.
  const isStaticRender = id === 'feed' || id === 'settings' || id === 'discover' || id === 'pinned' || id === 'modlog'

  // PASS B: walk desired list, insert NEW nodes at their sorted position.
  // Existing nodes are NEVER moved — rule (1) above is literal: once the
  // user has seen two rows in an order, that order is history and stays.
  // The old code insertBefore'd an existing node whenever fairMerge's fresh
  // sort disagreed with DOM order — but the co-live floor/rest split (and
  // the yt pacer's commit-time stamps) can legally flip already-rendered
  // neighbors between two renders, and each flip was a visible row shuffle
  // (mellen's "order glitches after I post, heals in ~5s", 2026-07-14).
  // Instead we leave the node where it is. New rows anchor on their own
  // desired predecessor, so an out-of-order row can never capture the
  // insertion point and bury later arrivals above it.
  // Duplicate-key accumulation is still impossible — dupes are healed in
  // PASS A, and a found `existing` never builds a second div.
  // Per-render insertedKeys set — even if two buffer entries collide on
  // stableMsgId (rare: same user, same ms post-pacer-commit, same text-
  // prefix), the second occurrence is skipped so DOM stays one-per-key.
  const insertedKeys = _rmInsertedKeys
  insertedKeys.clear()
  // The lowest-in-the-DOM row placed so far. A NEW row goes right after it —
  // never "before whatever DOM row a shared cursor points at". The cursor
  // version stalled forever once one existing row sat out of desired order
  // (it was deferred, the cursor stopped on it, and every later new row was
  // inserted above it: a frozen bottom until that row aged out, ~2 min).
  // Anchored on the low-water mark, a new row lands after everything already
  // placed, however many older rows sit out of order below it. In the sorted
  // case this is exactly "after the previous desired row" (the O(1) path).
  let prevNode = null
  let zebraFrom = null // first row whose stripe may now be out of phase
  let zebraRebuilt = false // a stale row was rebuilt in place
  // The lowest row already on screen. A LIVE line (it carries an ord) is
  // never slotted above one: a kick line a beat behind the twitch line it
  // answers used to land 1-5 rows up, moving every row under it and flipping
  // their stripes under the reader's eyes (~1 in 4 lines on a busy two-
  // platform tab). It goes just under the screen's last row instead, so a
  // live line only ever appends and a shown row never moves or changes
  // stripe. History (no ord) still weaves to its real place. The cost is a
  // line up to LIVE_WEAVE_SKEW_MS out of timestamp order, by design.
  let settledEnd = null
  for (let el = msgsEl.lastElementChild; el; el = el.previousElementSibling) {
    if (el._hsAt !== undefined) {
      settledEnd = el
      break
    }
  }
  for (let j = 0; j < toRender.length; j++) {
    const key = desiredKeys[j]
    if (insertedKeys.has(key)) continue
    insertedKeys.add(key)
    const existing = existingByKey.get(key)
    if (existing) {
      existingByKey.delete(key)
      const _rm = toRender[j]
      let placed = existing
      // Reused div skipped buildMessageDiv — re-queue its cosmetic so a prior
      // failed/absent lookup is retried (resolves on a later flush). Without
      // this, a frozen channel's restored buffer never re-attempts cosmetics.
      if (_rm?.userId && mcCosmeticsNeedLookup(_rm.userId)) queueMcCosmeticsLookup(_rm.userId)
      // Stale epoch → the row's rendered output is invalidated (emote
      // animation toggle, rerender setting, badge bulk-load). Rebuild the
      // div and swap it IN THE SAME SLOT — position, zebra stripe, and
      // scroll geometry all survive. This replaces the old "epoch re-keys
      // everything → teardown + fresh-sort rebuild" path that flashed and
      // reordered the visible list.
      if (existing.dataset.hsEpoch !== String(_renderEpoch)) {
        const nd = buildMessageDiv(_rm, id)
        if (nd) {
          nd.dataset.msgKey = key
          nd.dataset.hsEpoch = String(_renderEpoch)
          // Keep the old row's stripe; one upward pass after the walk settles
          // them all, anchored on the newest row. Recomputing each from the
          // row above mid-walk read neighbours not yet rebuilt (a row out of
          // DOM order is visited early), so a bump could flip hundreds of rows.
          // The pass also strips every stripe when zebra was just turned off.
          if (_NO_ZEBRA_TYPES.has(_rm.type)) nd.dataset.hsNz = '1'
          if (_rm.type === 'stream-event') nd.dataset.hsNotice = '1'
          const keepStripe =
            zebraEnabled &&
            !nd.dataset.hsNz &&
            !nd.classList.contains('hs-filled') &&
            existing.classList.contains('hs-mc-zebra')
          nd.classList.toggle('hs-mc-zebra', keepStripe)
          nd.classList.toggle('hs-zebra', keepStripe)
          zebraRebuilt = true
          _unindexMessageDiv(existing)
          msgsEl.replaceChild(nd, existing)
          _indexMessageDiv(nd, key)
          placed = nd
        } else {
          // Message no longer renderable under new state — keep the old row
          // (dropping it would move neighbors) and stop re-attempting.
          existing.dataset.hsEpoch = String(_renderEpoch)
        }
      }
      // an existing row never moves; it only advances the mark when it is
      // lower in the DOM than everything placed so far
      if (
        !prevNode ||
        placed === prevNode.nextSibling ||
        prevNode.compareDocumentPosition(placed) & Node.DOCUMENT_POSITION_FOLLOWING
      )
        prevNode = placed
      continue
    }
    // Build new msg div at correct position.
    const m = toRender[j]
    const div = buildMessageDiv(m, id)
    if (!div) continue
    div.dataset.msgKey = key
    div.dataset.hsEpoch = String(_renderEpoch)
    let after
    if (prevNode) after = prevNode.nextSibling
    else {
      after = msgsEl.firstElementChild
      if (after?.id === 'hs-mc-embed-player') after = after.nextElementSibling // the player is not a row
    }
    if (
      settledEnd &&
      m.ord != null &&
      after &&
      (after === settledEnd || after.compareDocumentPosition(settledEnd) & Node.DOCUMENT_POSITION_FOLLOWING)
    ) {
      prevNode = settledEnd
      after = settledEnd.nextSibling
    }
    stampZebra(div, m, prevNode)
    if (after) zebraFrom = zebraFrom || div
    msgsEl.insertBefore(div, after)
    _indexMessageDiv(div, key)
    prevNode = div
  }

  // Re-pin yt-status notices to the very end.
  for (const ex of detachedExtras) msgsEl.appendChild(ex)
  if (zebraFrom) zebraRepaint(msgsEl, zebraFrom)
  if (zebraRebuilt) zebraRepaintUp(msgsEl, null)

  // Final safety net: hard-cap DOM so no future regression can OOM the tab.
  // toRender is already sliced to 500; anything beyond that + yt-status
  // pins is a leak. trimMessagesEl removes from the front (oldest first)
  // and keeps indices in sync.
  const hardCap =
    toRender.length + detachedExtras.length + (msgsEl.querySelector(':scope > #hs-mc-embed-player') ? 1 : 0)
  if (msgsEl.children.length > hardCap) trimMessagesEl(msgsEl, hardCap)

  // Re-apply expanded stacks (only relevant when full rebuild fired).
  for (const [mid, idx] of expandedStacks) {
    const m = msgsEl.querySelector(`.hs-mc-msg[data-msg-id="${CSS.escape(mid)}"]`)
    if (!m) continue
    const stacks = m.querySelectorAll('.hs-mc-emote-stack')
    if (stacks[idx]) stacks[idx].classList.add('expanded')
  }

  applyMcMutes()
  if (mtSrcs) mtNoteRender(id, mtSrcs)

  // Scroll behavior: re-pin if user hasn't paused. Static tabs (feed/
  // discover/pinned/settings) skip — they pin the newest at TOP, not
  // bottom. mellen's rule: scrollbar locked at bottom unless user
  // explicitly scrolls up.
  cleanup.raf(() => {
    isProgrammaticScroll = false
  })
  if (!isScrolledUp && !isStaticRender) {
    scrollMsgsToBottom(msgsEl)
  }
}

// Memoized: input color strings are bounded (Twitch colors per session are
// a small set). Cache resets when readableNamesEnabled flips. boostReadability
// does HSL math (parseInt x6, Math.max/min) — was running 2-3x per msg build.
let _colorCacheReadable = readableNamesEnabled
const _colorCache = new Map()
function sanitizeColor(color) {
  if (_colorCacheReadable !== readableNamesEnabled) {
    _colorCache.clear()
    _colorCacheReadable = readableNamesEnabled
  }
  const hit = _colorCache.get(color)
  if (hit !== undefined) return hit
  let out
  if (!COLOR_RE.test(color)) out = '#ffffff'
  else out = readableNamesEnabled ? boostReadability(color) : color
  _colorCache.set(color, out)
  if (_colorCache.size > 500) _colorCache.delete(_colorCache.keys().next().value)
  return out
}

// Get platform overrides for the current live channel (or defaults from URL)
function getLivePlatformNames() {
  const urlCh = getCurrentChannel()?.toLowerCase()
  if (!urlCh) return { twitch: '', kick: '', youtube: '' }
  const overrides = livePlatformMap[urlCh]
  const identity = liveIdentityMap[urlCh]
  // Same-name fallback is only safe between twitch↔kick. On a YouTube page
  // urlCh is a video id or @handle — guessing it as a twitch/kick channel
  // joins junk channels (bogus IRC joins + external history fetches) and can
  // bleed a real same-named twitch/kick chat into this stream. Mirror of the
  // yt-handle-guess rule below: cross-platform on yt pages is explicit-only.
  const sameNameOk = hostPlatform !== 'yt'
  return {
    twitch: overrides?.twitch ?? (identity?.twitch || (sameNameOk ? urlCh : '')),
    kick: overrides?.kick ?? (identity?.kick || (sameNameOk ? urlCh : '')),
    // No YT fallback: a guessed youtube.com/@<urlCh>/live resolves to whoever
    // owns that handle (often a different person) and bleeds their live chat
    // into this channel. YouTube must be linked explicitly — same-name across
    // platforms is a safe assumption for Twitch/Kick, NOT for YouTube handles.
    youtube: overrides?.youtube ?? '',
  }
}

function saveLivePlatformMap() {
  chrome.storage.local.set({ hs_live_platform_map: livePlatformMap })
}

async function loadLivePlatformMap() {
  try {
    const data = await browser.storage.local.get('hs_live_platform_map')
    if (data.hs_live_platform_map) livePlatformMap = data.hs_live_platform_map
  } catch {}
}

function updateTabIndicator(tabId) {
  const tab = tabBarElement?.querySelector(`[data-tab="${tabId}"]`)
  if (!tab || currentTab === tabId) return
  if (tab.classList.contains('has-new') && (tabId !== 'mentions' || tab.classList.contains('has-mentions'))) return

  // Don't light up duplicate tabs showing the same channel
  // If on live, suppress channel tab indicator for the live channel
  // If on a channel tab, suppress live tab indicator for the same channel
  const liveCh = getLiveChannel()?.toLowerCase()
  if (liveCh) {
    if (currentTab === 'live' && tabId !== 'feed' && tabId !== 'mentions') {
      const chConfig = getChannelById(tabId)
      if (chConfig) {
        const tw = chConfig.twitch?.toLowerCase()
        const ki = chConfig.kick?.toLowerCase()
        if (tw === liveCh || ki === liveCh) return
      }
    }
    if (tabId === 'live') {
      const curConfig = getChannelById(currentTab)
      if (curConfig) {
        const tw = curConfig.twitch?.toLowerCase()
        const ki = curConfig.kick?.toLowerCase()
        if (tw === liveCh || ki === liveCh) return
      }
    }
  }

  tab.classList.add('has-new')
  if (tabId === 'mentions') tab.classList.add('has-mentions')
}

function updateTabMentionIndicator(tabId) {
  const tab = tabBarElement?.querySelector(`[data-tab="${tabId}"]`)
  if (tab && currentTab !== tabId) {
    tab.classList.add('has-new', 'has-mentions')
  }
}

// ============================================
// LIVE STATUS POLLING
// ============================================

let liveStatusInterval = null
let _lastLiveStatusPoll = 0
let _liveStatusInFlight = false
// Cached SW snapshot of followed-user live state. Refreshed by the SW alarm
// every 60s and pushed via `live_followed_updated`. We use it to short-circuit
// /api/platform/live-status calls for channels the SW already covers — at
// 100k users this turns the per-content 30s poll into a no-op for most users.
// (declared beside liveChannelSet at the top — isChannelLive() reads both)

function startLiveStatusPolling() {
  // Seed from SW cached snapshot, so first paint doesn't wait on the network.
  try {
    chrome.runtime
      .sendMessage({ type: 'get_live_followed' })
      .then((resp) => {
        if (resp?.snapshot) _applyFollowedSnapshot(resp.snapshot)
        updateLiveStatus()
      })
      .catch(() => updateLiveStatus())
  } catch {
    updateLiveStatus()
  }
  // Backup poll covers channels the SW doesn't follow (popout / unfollowed).
  // Extended 30s → 90s — SW broadcast handles freshness for the common case.
  liveStatusInterval = cleanup.setInterval(updateLiveStatus, 90000)
}

function _applyFollowedSnapshot(snapshot) {
  if (!Array.isArray(snapshot)) return
  followsSet(snapshot)
  _swLiveSet = new Set(
    snapshot
      .filter((s) => s.platform === 'twitch' || s.platform === 'kick' || s.platform === 'youtube')
      .map((s) => (s.username ? liveKey(s.platform, s.username) : ''))
      .filter(Boolean),
  )
  // Re-stamp unconditionally. _swLiveSet has just been REPLACED (not merged),
  // so an empty snapshot is real information — "none of the channels you
  // follow are live" — and has to be able to clear a dot.
  if (!tabBarElement) return
  applyLiveDotsFromCache()
}

// Debounced re-poll — call when user activity suggests stale dots are
// worth refreshing (tab switch, panel re-open, page focus). Skips the
// network round-trip if we polled <5s ago to avoid hammering helix.
function refreshLiveStatusSoon() {
  if (_liveStatusInFlight) return
  if (Date.now() - _lastLiveStatusPoll < 5000) return
  updateLiveStatus()
}

async function updateLiveStatus() {
  if (!tabBarElement) return
  // Split config channels by platform — the live-status API takes twitch
  // names in `channels` and kick slugs in `kickChannels`. Bug #7: the poll
  // used to send every channel as a twitch name, so Kick-only tabs queried
  // helix with their kick slug and always came back not-live (their dots
  // flickered off every 90s). Mirror the picker — query each platform's API.
  const twitchAll = []
  const kickAll = []
  for (const ch of config.channels) {
    // Query BOTH platforms independently. A dual-platform tab (same person on
    // twitch AND kick) must be checked on kick too — the old `else if (kick)`
    // only ran for kick-ONLY tabs, so a streamer live on kick but not twitch
    // got queried on helix (offline) and never on kick, showing no live dot.
    // Kick-only and legacy twitch-id-only paths are unchanged.
    if (ch.twitch) twitchAll.push(ch.twitch)
    if (ch.kick) kickAll.push(ch.kick)
    if (!ch.twitch && !ch.kick && ch.id && !ch.youtube) twitchAll.push(ch.id) // legacy twitch-id-only entries
  }
  const urlCh = getCurrentChannel()
  if (urlCh) {
    const u = urlCh.toLowerCase()
    if (hostPlatform === 'kick') {
      if (!kickAll.some((c) => c.toLowerCase() === u)) kickAll.push(urlCh)
    } else if (hostPlatform === 'twitch' && !twitchAll.some((c) => c.toLowerCase() === u)) {
      // a youtube handle / videoId is not a twitch login
      twitchAll.push(urlCh)
    }
  }
  if (twitchAll.length === 0 && kickAll.length === 0) return

  // Skip the twitch fetch for names the SW live snapshot already covers
  // (most followed channels at scale). The SW snapshot is twitch-only, so
  // kick slugs are always queried fresh.
  const twitchNames = _swLiveSet ? twitchAll.filter((c) => !liveSetHas(_swLiveSet, c, 'twitch')) : twitchAll

  if (twitchNames.length === 0 && kickAll.length === 0) {
    applyLiveDotsFromCache()
    _lastLiveStatusPoll = Date.now()
    return
  }

  _liveStatusInFlight = true
  _lastLiveStatusPoll = Date.now()
  try {
    const data = await browser.runtime.sendMessage({
      type: 'fetch_live_status',
      channels: twitchNames,
      kickChannels: kickAll,
    })
    // If we asked for twitch names but got no twitch array back, the call
    // failed — keep the last good snapshot rather than clobbering dots.
    if (twitchNames.length > 0 && !Array.isArray(data?.live)) {
      applyLiveDotsFromCache()
      return
    }
    // Merge SW snapshot + fresh twitch + fresh kick into one live set, then
    // stamp every tab (both platforms) via the shared cache-applier so
    // Kick-only tabs light up from kickLive, not the twitch set.
    // Poll-owned set ONLY. Folding _swLiveSet in here is what made a stale
    // snapshot entry survive every subsequent poll; isChannelLive() reads both.
    const liveSet = new Set([
      ...(Array.isArray(data?.live) ? data.live.map((c) => liveKey('twitch', c)) : []),
      ...(Array.isArray(data?.kickLive) ? data.kickLive.map((c) => liveKey('kick', c)) : []),
    ])
    liveChannelSet = liveSet
    applyLiveDotsFromCache()

    // Update live tab's own red dot based on selected channel. On a YT
    // host page the "selected channel" is a videoId (e.g. jfKfPfyJRdk),
    // which is never in the Twitch live-set, so we'd always stamp 'false'
    // and clobber the chatframe-based detection. Defer to detectOfflineState.
    if (hostPlatform !== 'yt') {
      const liveTab = tabBarElement?.querySelector('[data-tab="live"]')
      const curLive = getLiveChannel()?.toLowerCase()
      if (liveTab) liveTab.dataset.live = String(!!curLive && liveSetHas(liveSet, curLive, hostPlatform))
    }

    // If override channel went offline, fall back to URL channel or first live
    if (liveChannel && !liveSetHas(liveSet, liveChannel)) {
      liveChannel = null
      syncLiveTab()
      _dropTabCache('live')
      if (currentTab === 'live') renderMessages('live')
    }

    // Auto-select if no override and URL channel isn't live but others are
    if (!liveChannel && urlCh && !liveSetHas(liveSet, urlCh) && liveSet.size > 0) {
      // Don't auto-override — user can pick via the menu
    }
  } catch (_) {
    // Network error — re-apply last known good snapshot so stale dots
    // don't persist past their truth window.
    applyLiveDotsFromCache()
  } finally {
    _liveStatusInFlight = false
  }
}

// Re-stamp data-live on every channel tab from the cached liveChannelSet,
// so a failed fetch / DOM re-render race / late tabbar mutation can't leave
// a stale dot showing. Single source of truth: liveChannelSet.
function applyLiveDotsFromCache() {
  if (!tabBarElement) return
  config.channels.forEach((ch) => {
    const id = ch.id
    const tab = tabBarElement.querySelector(`[data-tab="${id}"]`)
    if (!tab) return
    // Each leg is judged on its own platform's key, so kick-only and twitch+kick
    // pairs with differing handles light up and a same-named twitch/kick pair
    // can't light each other. A youtube-only tab can only turn ON from the
    // followed-live snapshot: its off state is the chat-frame detection's call.
    const isLive = tabIsLiveFromSets(ch)
    if (!ch.twitch && !ch.kick && ch.youtube) {
      if (isLive) tab.dataset.live = 'true'
      return
    }
    tab.dataset.live = String(isLive)
  })
}

// ============================================
// USERNAME & MENTIONS
// ============================================

// Non-channel URL slugs shared by getCurrentChannel + the soft-nav
// prevLiveCh extractor. Prod logs showed the server subscribing to
// 'browse', 'u', 'mellen9' as Kick channels — covers both twitch + kick
// reserved paths so we don't burn API quota (kick rate-limits subscribe;
// each garbage slug eats budget). Single source of truth is
// src/lib/reserved-paths.js, embedded into this bundle's lib scope.
const NON_CHANNEL_PATHS = RESERVED_PATHS

/**
 * Get current channel from URL
 */
function getCurrentChannel() {
  // YouTube: /@handle/live, /watch?v=, /live/videoId, /channel/<UCid>/live
  if (location.hostname.includes('youtube.com')) {
    return parseYoutubeChannel(location.pathname, location.search)
  }

  // Channel pages live on the apex/www/m hosts only. Sibling subdomains
  // (dashboard.kick.com, dashboard.twitch.tv, help.*, dev.*) reuse
  // channel-shaped paths — the kick creator dashboard's /moderation and
  // /stream routes spoofed real channels here and fired FFZ/emote lookups
  // for "moderation". A path blocklist can't keep up with their routes;
  // gate on host instead.
  if (!/^(www\.|m\.)?(twitch\.tv|kick\.com)$/.test(location.hostname)) return null

  // Match /username or /popout/username/chat or /embed/username/chat
  const match = location.pathname.match(/^\/(?:popout\/|embed\/)?([a-zA-Z0-9_-]+)/)
  if (match?.[1]) {
    const channel = match[1].toLowerCase()
    // Skip non-channel pages (shared module-scope Set above).
    if (NON_CHANNEL_PATHS.has(channel)) {
      return null
    }
    return channel
  }
  return null
}

/** Channel the live tab is currently showing (override or URL fallback) */
function getLiveChannel() {
  return liveChannel || getCurrentChannel()
}

/** Lowercase channel-name set the user is *currently viewing* — used by
 *  HsNotifs to scope channel-tagged callouts (resub-share, watchstreak) to
 *  the matching tab only. On non-channel tabs (feed/mentions/whispers/etc)
 *  returns an empty Set so channel-scoped callouts hide. Never returns
 *  null — passing null to setActiveChannels disables the filter, which
 *  would let stale callouts bleed across tabs. */
function getActiveViewedChannels() {
  const out = new Set()
  const addCh = (ch) => {
    if (!ch) return
    if (ch.twitch) out.add(ch.twitch.toLowerCase())
    if (ch.kick) out.add(ch.kick.toLowerCase())
    if (ch.id) out.add(String(ch.id).toLowerCase())
  }
  if (currentTab === 'live') {
    const liveCh = getLiveChannel()?.toLowerCase()
    if (liveCh) {
      out.add(liveCh)
      // Paired channel: live=zackrawrr (twitch) + kick=asmongold belong to
      // the same logical "stream" — show callouts for either side.
      for (const ch of config.channels) {
        const tw = ch.twitch?.toLowerCase()
        const ki = ch.kick?.toLowerCase()
        if (tw === liveCh || ki === liveCh) addCh(ch)
      }
    }
    return out
  }
  const ch = getChannelById(currentTab)
  if (ch) addCh(ch)
  return out
}

// Check if a message belongs to the live tab — direct match OR paired via config
// e.g., on twitch.tv/asmongold with config {twitch:"zackrawrr", kick:"asmongold"}
// → shows both zackrawrr Twitch messages AND asmongold Kick messages
function isLiveChannelMessage(msg) {
  const curCh = getLiveChannel()?.toLowerCase()
  if (!curCh) return false
  const mc = msg.channel?.toLowerCase()
  if (mc === curCh) return true
  // Check configured channel pairs — either side can be the live channel
  return (
    config.channels.some((ch) => {
      const tw = ch.twitch?.toLowerCase()
      const ki = ch.kick?.toLowerCase()
      return (tw === curCh && ki === mc) || (ki === curCh && tw === mc)
    }) ||
    // On Kick, URL channel messages always belong to live tab
    (hostPlatform === 'kick' && mc === getCurrentChannel()?.toLowerCase())
  )
}

/** The saved tab that already shows the page channel, or null. Same legs the
 *  live send resolves (twitch/kick by name, youtube by handle or video), so a
 *  hidden temp tab never leaves a send target behind. A youtube page is never
 *  matched by name against twitch/kick: that guess is not allowed. */
function liveCoverId() {
  const cur = getLiveChannel()
  if (!cur || !config.channels?.length) return null
  const lower = cur.toLowerCase()
  const legs = getLivePlatformNames()
  const tw = new Set()
  const ki = new Set()
  if (hostPlatform !== 'yt') {
    tw.add(lower)
    ki.add(lower)
  }
  if (legs.twitch) tw.add(legs.twitch.toLowerCase())
  if (legs.kick) ki.add(legs.kick.toLowerCase())
  let ytHas = () => false
  if (hostPlatform === 'yt') {
    const isHandle = parseYoutubeChannelType(location.pathname, location.search) === 'handle'
    const handle = (isHandle ? lower : youtubeLinks.get('__live_yt_auto__')?.channelName || '')
      .toLowerCase()
      .replace(/^@/, '')
    const vid = _autoYtVideoId || (isHandle ? '' : cur)
    const explicit = String(legs.youtube || '').toLowerCase()
    ytHas = (url) => {
      const u = String(url || '')
      const ul = u.toLowerCase()
      return (
        !!u && ((handle && ul.includes(`/@${handle}`)) || (vid && u.includes(vid)) || (!!explicit && ul === explicit))
      )
    }
  }
  const hit = config.channels.find(
    (c) =>
      c?.id &&
      // a hidden saved tab can't be shown, so it doesn't cover: the temp tab stands in for it
      !hiddenTabs.has(mcRowOwner(c.id)) &&
      ((c.twitch && tw.has(c.twitch.toLowerCase())) ||
        (c.kick && ki.has(c.kick.toLowerCase())) ||
        (c.youtube && ytHas(c.youtube))),
  )
  return hit ? hit.id : null
}

/** Is the temp tab on the bar: the page has a channel and no saved tab covers it. */
function liveTabShown() {
  return !!getLiveChannel() && !liveCoverId()
}

/** Where "back to the stream" lands: the saved tab covering the page channel,
 *  else the temp tab, else (no page channel) the first saved tab, else the feed. */
function liveTarget() {
  const cover = liveCoverId()
  if (cover) return cover
  if (getLiveChannel()) return 'live'
  const first = config.channels?.find((c) => c?.id && !hiddenTabs.has(mcRowOwner(c.id)))
  return first ? first.id : 'feed'
}

/** Repaint the temp tab and keep the panel off it while it is hidden. Moves
 *  off it (not persisted: _autoSwitching) when it goes away under the user,
 *  and back onto it when it returns. */
function syncLiveTab() {
  updateLiveTabLabel()
  if (!_liveSyncArmed) return
  const shown = liveTabShown()
  if (currentTab === 'live' && !shown) {
    const to = liveTarget()
    if (to === 'live') return
    _autoSwitching = true
    try {
      switchTab(to)
    } finally {
      _autoSwitching = false
    }
    _bouncedFromLive = to
  } else if (_bouncedFromLive && currentTab === _bouncedFromLive && getLiveChannel()) {
    // the page has a channel again: follow it to its tab (the temp tab or the saved one covering it)
    const to = liveTarget()
    if (to === currentTab) return
    _bouncedFromLive = to === 'live' ? '' : to
    _autoSwitching = true
    try {
      switchTab(to)
    } finally {
      _autoSwitching = false
    }
  }
}

// Boot onto bootActiveTab(). A saved "live" means "the page's channel": where it lands on this page
// (feed on a channel-less page, the saved tab covering it) is the page's doing, not a pick, so it is
// not saved over "live" and the next channel page still opens that channel's chat.
function bootSwitch() {
  const to = bootActiveTab()
  const followsPage = _savedActiveTab === 'live' && to !== 'live'
  _autoSwitching = followsPage
  try {
    switchTab(to)
  } finally {
    _autoSwitching = false
  }
  if (followsPage) _bouncedFromLive = to
}

/** Promote the temp tab to a saved channel tab (the existing resolve path does
 *  identity, dedupe and saveConfig; the cover rule then hides the temp tab). */
async function keepLiveTab() {
  const cur = getLiveChannel()
  if (!cur || _keepingLive || !liveTabShown()) return
  _keepingLive = true
  try {
    if (hostPlatform === 'yt') {
      const isHandle = parseYoutubeChannelType(location.pathname, location.search) === 'handle'
      const handle = isHandle ? cur : youtubeLinks.get('__live_yt_auto__')?.channelName || ''
      const url =
        ytSubscribedUrls.get('__live_yt_auto__') ||
        (isHandle ? ytHandleLiveUrl(location.pathname) : `https://www.youtube.com/watch?v=${cur}`)
      await resolveLiveCandidateToTab(
        handle
          ? { name: handle.replace(/^@/, ''), platform: 'youtube', youtubeUrl: url }
          : { name: cur, platform: 'youtube', youtubeUrl: url, _videoId: cur },
      )
    } else {
      await resolveLiveCandidateToTab({ name: cur, platform: hostPlatform })
    }
  } finally {
    _keepingLive = false
  }
}

/** Update the temp tab button: the page channel's name, underlined, and hidden
 *  while a saved tab covers that channel or the page has none. */
function updateLiveTabLabel() {
  const liveTab = tabBarElement?.querySelector('[data-tab="live"]')
  if (!liveTab) return
  const cur = getCurrentChannel()?.toLowerCase()
  const override = liveChannel
  let name = ''
  if (override && override !== cur) {
    name = override
  } else if (cur) {
    // youtube: getCurrentChannel is the 11-char videoId — swap for the
    // resolved channel name when we have it, else keep the generic label
    // (never show a raw videoId as the tab name).
    if (hostPlatform === 'yt') {
      name = youtubeLinks.get('__live_yt_auto__')?.channelName || ''
    } else {
      name = cur
    }
  }
  liveTab.textContent = String(name || t('mc_tab_live')).toLowerCase()
  liveTab.classList.add('hs-mc-tab-temp')
  liveTab.title = t('mc_tab_temp_title')
  liveTab.style.display = liveTabShown() ? '' : 'none'
}

/** Query background script for all channels the user has open tabs for */
async function getWatchingChannels() {
  try {
    const resp = await browser.runtime.sendMessage({ type: 'get_watching_channels' })
    return resp?.channels || []
  } catch (_) {
    return []
  }
}

/**
 * Resolve a live candidate ({name, platform, youtubeUrl?}) to a real channel tab.
 * Auto-adds the channel to config.channels so 'live' is a launcher, never the sticky tab.
 */
async function resolveLiveCandidateToTab({ name, platform, youtubeUrl, _videoId }) {
  const lower = name.toLowerCase()
  const reserved = mcReservedTabIds()

  // Resolve all 3 platform identities up-front via /api/profile so the resulting
  // tab pulls Twitch + Kick + YouTube together — not just the platform we
  // anchored on. resolveIdentity is the same path pcAddAsChannel uses.
  //
  // `_videoId` (set by get_watching_channels when its oEmbed handle lookup
  // failed) means `name` is still the raw YouTube video id, not a channel
  // identity — it was never resolved to the owning channel. Hitting
  // /api/profile/<videoId>?platform=youtube with it 404s (or worse, on an
  // id that happens to collide with something else). Skip identity
  // resolution for that case; youtubeUrl (built from the same video id)
  // still points the tab at the right stream, so nothing breaks — the tab
  // just won't have cross-platform (twitch/kick) linkage until a later
  // real resolve fills it in.
  const skipIdentity = platform === 'youtube' && !!_videoId
  let identity = null,
    profile = null
  if (typeof resolveIdentity === 'function' && !skipIdentity) {
    try {
      const res = await resolveIdentity(name, platform ? { platform } : {})
      if (res?.ok && res.identity) {
        identity = res.identity
        profile = res.profile
      }
    } catch {}
  }

  // Build canonical YouTube URL: prefer @handle, fall back to channel id.
  const buildYtUrl = () => (typeof identityYtLiveUrl === 'function' ? identityYtLiveUrl({ identity, profile }) : '')

  // Optimistic fallback: when heatsync has no linkage (shadow profile / unknown
  // streamer), assume the same username on every platform. Most streamers
  // use one handle everywhere; the user can edit the tab if the guess is wrong.
  // EXCEPT when the anchor IS a youtube identity: a yt @handle is not a
  // twitch/kick name (kripparrian's yt vs twitch nl_kripp — the guess filled
  // all 3 slots and joined/sent to a STRANGER's twitch channel). Same rule
  // as getLivePlatformNames: cross-platform from yt is explicit-only.
  const fromYt = platform === 'youtube'
  const twitchName = (identity?.twitch || (fromYt ? '' : lower)).toLowerCase()
  const kickName = (identity?.kick || (fromYt ? '' : lower)).toLowerCase()
  // Twitch/Kick same-name guessing is safe (handles match across those platforms).
  // YouTube is NOT: a fabricated youtube.com/@<name>/live resolves to whoever owns
  // that handle — usually a STRANGER who happens to be live — and bleeds their chat
  // into this tab (see ac4892c + [[heatsync_yt_handle_guess_bleed]]). Bind YT ONLY
  // from an explicit youtubeUrl (user navigated to a YT page) or a real resolved
  // identity (buildYtUrl uses heatsync profile/identity linkage). Never from a name.
  const ytUrl = platform === 'youtube' ? youtubeUrl || buildYtUrl() || '' : buildYtUrl() || ''
  const ytLower = ytUrl.toLowerCase()

  // Find existing channel tab matching any resolved platform.
  let entry = config.channels.find((c) => {
    if (typeof c === 'string') return c.toLowerCase() === lower
    const tw = c.twitch?.toLowerCase()
    const ki = c.kick?.toLowerCase()
    const yt = c.youtube?.toLowerCase()
    if (twitchName && tw === twitchName) return true
    if (kickName && ki === kickName) return true
    if (ytUrl && yt === ytLower) return true
    if (yt) {
      const handleMatch = yt.match(/\/@([^/?]+)/)
      if (handleMatch?.[1] === lower) return true
    }
    return false
  })

  if (!entry) {
    let id = (identity?.heatsync || twitchName || kickName || lower).toLowerCase()
    if (reserved.includes(id) || config.channels.some((c) => c.id === id)) {
      id = platform === 'youtube' ? `yt_${Date.now()}` : `ch_${Date.now()}`
    }
    entry = { id, twitch: twitchName, kick: kickName, youtube: ytUrl }
    config.channels.push(entry)
    try {
      saveConfig()
    } catch {}

    if (entry.twitch) {
      try {
        trackJoin(entry.id, irc?.join?.(entry.twitch))
      } catch {}
      safeSendMessage({ type: 'join_channel', platform: 'twitch', channel: entry.twitch })
    }
    if (entry.kick) {
      try {
        trackJoin(entry.id, kickChat?.join?.(entry.kick))
      } catch {}
    }
    if (entry.youtube) {
      try {
        youtubeLinks.set(entry.id, { url: entry.youtube, videoId: '', channelName: '' })
        // Arm the watchdog — it reads ytChanLastSeen/ytSubscribedUrls, so a
        // sub added without them is never re-subscribed when it goes silent.
        ytSubscribedUrls.set(entry.id, entry.youtube)
        ytChanLastSeen.set(entry.id, Date.now())
      } catch {}
      try {
        ytSubscribe(entry.id, entry.youtube, entry.id)
      } catch {}
    }

    try {
      updateTabBar()
    } catch {}
  } else if (typeof entry !== 'string') {
    // Backfill any platforms missing on the existing entry (don't overwrite).
    let mutated = false
    if (!entry.twitch && twitchName) {
      entry.twitch = twitchName
      mutated = true
      try {
        trackJoin(entry.id, irc?.join?.(twitchName))
      } catch {}
      safeSendMessage({ type: 'join_channel', platform: 'twitch', channel: twitchName })
    }
    if (!entry.kick && kickName) {
      entry.kick = kickName
      mutated = true
      try {
        trackJoin(entry.id, kickChat?.join?.(kickName))
      } catch {}
    }
    if (!entry.youtube && ytUrl) {
      entry.youtube = ytUrl
      mutated = true
      try {
        youtubeLinks.set(entry.id, { url: ytUrl, videoId: '', channelName: '' })
        ytSubscribedUrls.set(entry.id, ytUrl)
        ytChanLastSeen.set(entry.id, Date.now())
      } catch {}
      try {
        ytSubscribe(entry.id, ytUrl, entry.id)
      } catch {}
    }
    if (mutated) {
      try {
        saveConfig()
      } catch {}
      try {
        updateTabBar()
      } catch {}
    }
  }

  const tabId = entry.id
  // Reset liveChannel override — live is no longer the sticky tab.
  liveChannel = null
  _dropTabCache('live')
  switchTab(tabId)
}

/** Show picker for choosing which live channel to view */
async function showLiveChannelPicker(anchorEl) {
  document.getElementById('hs-mc-live-picker')?.remove()

  const urlCh = getCurrentChannel()?.toLowerCase()
  const watching = await getWatchingChannels()

  // Split watching by platform — API supports `channels` (twitch) + `kick_channels`
  const twitchNames = []
  const kickNames = []
  for (const w of watching) {
    if (w.platform === 'kick') kickNames.push(w.name)
    else if (w.platform === 'twitch') twitchNames.push(w.name)
  }
  if (urlCh && hostPlatform === 'twitch' && !twitchNames.includes(urlCh)) twitchNames.push(urlCh)
  if (urlCh && hostPlatform === 'kick' && !kickNames.includes(urlCh)) kickNames.push(urlCh)

  let twitchLive = liveNames(liveChannelSet, 'twitch')
  let kickLive = new Set()
  if (twitchNames.length > 0 || kickNames.length > 0) {
    try {
      const resp = await browser.runtime.sendMessage({
        type: 'fetch_live_status',
        channels: twitchNames,
        kickChannels: kickNames,
      })
      if (resp?.live) twitchLive = new Set(resp.live.map((c) => c.toLowerCase()))
      if (resp?.kickLive) kickLive = new Set(resp.kickLive.map((c) => c.toLowerCase()))
    } catch (_) {
      /* use cached liveChannelSet */
    }
  }

  // Only show channels that are actually live; dedupe same name across platforms (twitch > kick > youtube)
  const priority = { twitch: 3, kick: 2, youtube: 1 }
  // Unlike twitch/kick, a "watching" youtube entry is only a URL-shape match
  // (tab sitting on /@handle/live, /live/<id>, /watch?v=<id>) — background.js
  // has no way to tell a live broadcast from a tab that's still parked on
  // that URL after the stream ended (YT swaps live→replay in-place, no
  // navigation). So it's never real evidence the way a helix/kick API hit
  // is. Treat it as a live candidate ONLY when nothing else confirmed-live
  // exists this round — a stale youtube tab must never outrank (or get
  // auto-selected over) an actually-live twitch/kick channel.
  const anyRealLive = watching.some(
    (w) =>
      (w.platform === 'twitch' && twitchLive.has(w.name.toLowerCase())) ||
      (w.platform === 'kick' && kickLive.has(w.name.toLowerCase())),
  )
  const byName = new Map()
  for (const w of watching) {
    const ch = w.name.toLowerCase()
    let isLive = false
    if (w.platform === 'twitch') isLive = twitchLive.has(ch)
    else if (w.platform === 'kick') isLive = kickLive.has(ch)
    else if (w.platform === 'youtube') isLive = !anyRealLive
    if (!isLive) continue
    const existing = byName.get(ch)
    if (!existing || priority[w.platform] > priority[existing.platform]) {
      byName.set(ch, { name: w.name, platform: w.platform, youtubeUrl: w.youtubeUrl, isCurrent: ch === urlCh })
    }
  }
  const channels = Array.from(byName.values())

  if (channels.length <= 1) {
    if (channels.length === 1) {
      // In-overlay switch everywhere, including popouts. The overlay renders
      // chat from HS's own streams (independent of the native page underneath)
      // and send resolves the target per-tab (relay/IRC, not the page URL), so
      // a popout switches channels in place — no destructive reload/navigation.
      await resolveLiveCandidateToTab(channels[0])
      return
    }
    // 0 candidates — fall back to urlCh (auto-add) so something opens; else just sit on live.
    if (urlCh && (hostPlatform === 'twitch' || hostPlatform === 'kick')) {
      await resolveLiveCandidateToTab({ name: urlCh, platform: hostPlatform })
      return
    }
    switchTab('live')
    return
  }

  const menu = document.createElement('div')
  menu.id = 'hs-mc-live-picker'
  const rect = anchorEl.getBoundingClientRect()
  menu.style.cssText = `position:fixed;z-index:99999;background:#000;border:1px solid #ffffff;padding:4px 0;min-width:130px;font-size:13px;font-family:inherit;left:${rect.left}px;top:${rect.bottom + 2}px;`

  const curLive = getLiveChannel()?.toLowerCase()

  for (const ch of channels) {
    const item = document.createElement('div')
    const isActive = ch.name.toLowerCase() === curLive

    // Red dot — all channels in picker are confirmed live
    const dot = document.createElement('span')
    dot.style.cssText = `display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--hs-danger);margin-right:6px;vertical-align:middle`
    item.appendChild(dot)
    item.appendChild(document.createTextNode(ch.name))

    const baseColor = isActive ? '#fff' : '#fff'
    item.style.cssText = `padding:6px 12px;cursor:pointer;color:${baseColor};white-space:nowrap;`
    item.addEventListener('mouseenter', () => {
      item.style.background = '#fff'
      item.style.color = '#000'
    })
    item.addEventListener('mouseleave', () => {
      item.style.background = 'none'
      item.style.color = baseColor
    })
    item.addEventListener('click', async () => {
      menu.remove()
      // In-overlay switch in every context, popout included — no navigation,
      // no destructive reload, no spawned window. The overlay is self-sufficient
      // (chat from HS streams, send per-tab), so picking a channel just switches.
      await resolveLiveCandidateToTab(ch)
    })
    menu.appendChild(item)
  }

  // The live tab's own settings live in its dropdown (right-click stays a
  // shortcut to the same form).
  const edit = document.createElement('div')
  edit.textContent = t('mc_main_edit_platforms')
  edit.style.cssText =
    'padding:6px 12px;cursor:pointer;color:#fff;white-space:nowrap;border-top:1px solid #ffffff;margin-top:4px;'
  edit.addEventListener('mouseenter', () => {
    edit.style.background = '#fff'
    edit.style.color = '#000'
  })
  edit.addEventListener('mouseleave', () => {
    edit.style.background = 'none'
    edit.style.color = '#fff'
  })
  edit.addEventListener('click', () => {
    menu.remove()
    showEditLivePlatforms()
  })
  menu.appendChild(edit)

  document.body.appendChild(menu)

  // Clamp position so menu stays fully visible
  const menuRect = menu.getBoundingClientRect()
  if (menuRect.right > window.innerWidth) {
    menu.style.left = `${Math.max(0, window.innerWidth - menuRect.width - 4)}px`
  }
  if (menuRect.bottom > window.innerHeight) {
    menu.style.top = `${Math.max(0, rect.top - menuRect.height - 2)}px`
  }

  // Dismiss on outside click
  const dismiss = (e) => {
    if (!menu.contains(e.target) && e.target !== anchorEl) {
      menu.remove()
      document.removeEventListener('click', dismiss, true)
    }
  }
  cleanup.setTimeout(() => document.addEventListener('click', dismiss, { capture: true, signal: mcSignal }), 0)
}

function getCurrentUsername() {
  // Method 1: localStorage displayName
  try {
    const displayName = localStorage.getItem('twilight.user.displayName')
    if (displayName) {
      const name = displayName.replace(/"/g, '').trim()
      if (name && name.length > 0 && name.length < 30) {
        return name.toLowerCase()
      }
    }
  } catch (_) {}

  // Method 2: localStorage user object
  try {
    const twilight = localStorage.getItem('twilight.user')
    if (twilight) {
      const data = JSON.parse(twilight)
      if (data?.displayName) return data.displayName.toLowerCase()
    }
  } catch (_) {}

  // Method 3: Twitch 'name'/'login' cookies (work in popout chat, and exist
  // for every logged-in twitch user regardless of heatsync login). 'login'
  // matters: it is the canonical lowercase login twitch pairs with the
  // auth-token cookie — the exact NICK the authed IRC upgrade must send.
  // Relying on heatsync's user_info alone left every heatsync-logged-out
  // user on an anonymous reader, which twitch starves (live messages
  // trickle — reads as "chat is slow").
  try {
    const cookies = document.cookie.split(';')
    for (const cookie of cookies) {
      const [key, value] = cookie.trim().split('=')
      if ((key === 'login' || key === 'name') && value) {
        const name = decodeURIComponent(value).toLowerCase()
        if (name.length > 0 && name.length < 30) {
          log('Found username from cookie:', name)
          return name
        }
      }
    }
  } catch (_) {}

  // Kick — DOM selectors keep getting stripped (current redesign moved login to
  // an unlabeled person-icon button with no /profile link). Cross-platform
  // mention detection now falls back to ui.username via mentionAliases, so we
  // don't fight the moving target here. Returning null is fine.

  return null
}
