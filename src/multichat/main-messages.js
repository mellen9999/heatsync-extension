// part 5 of 8 of the multichat main body — buildMessageDiv, mentions, hashtags, scroll, merge, appendMessage, ordering, multistream, diagnostics.
// one scope with the other main-*.js parts and main.js at bundle time (build.js MAIN_PARTS, in list order).
// no wrapper here: the IIFE is the bundle's.

function buildMessageDiv(m, tabId) {
  // Blocked user — fully hide (skip render entirely). Both the append and the
  // full-rebuild path go through buildMessageDiv, so returning null here hides
  // the message everywhere. Unblock + renderMessages brings them back.
  // m.actor covers stream-events whose sender is carried in actor, not user —
  // channel-point redeems (redeemer, set ~13343) and 7TV emote-change banners
  // (set ~12245). Those have no m.user so the first check misses them. Hiding a
  // blocked user's emote-add banner is desirable too. online/offline/raid/hype/
  // sub events leave actor null, so their banners still render.
  if (m.user && isUserBlocked(m.user, m.platform)) return null
  if (m.actor && isUserBlocked(m.actor, m.platform)) return null
  // Per-tab hide (/hide) — fully drop this user's rows, but only when building
  // for the tab they were hidden in (tabId), never globally.
  if (m.user && isUserHiddenInTab(m.user, m.platform, tabId)) return null
  if (m.actor && isUserHiddenInTab(m.actor, m.platform, tabId)) return null
  // Per-tab platform filter (right-click the tab) — hides every row from a muted platform.
  if (isPlatformHiddenInTab(m, tabId)) return null
  // Stream event — render as magenta inline notification.
  // Render-time gate: skip if the corresponding hermes toggle is off
  // (buffer can hold events saved before a toggle flipped). Mirrors the
  // heatsync.org chat-tile _streamEventEnabled() filter.
  if (m.type === 'stream-event') {
    const cls = m.eventClass || ''
    const tokens = cls.split(/\s+/)
    const last = tokens[tokens.length - 1] || ''
    const evtMap = {
      'event-offline': 'offline',
      'event-online': 'online',
      'event-update': 'gameSwitch',
      'event-raid': 'raid',
      'event-hype': 'hype',
      'event-sub': 'sub',
      'event-redeem': 'redeem',
      'event-pred': 'pred',
      'event-poll': 'poll',
      'event-yt-superchat': 'ytSuperchat',
      'event-yt-supersticker': 'ytSupersticker',
      'event-yt-membership': 'ytMembership',
      'event-yt-milestone': 'ytMilestone',
      'event-yt-gift': 'ytGiftMemberships',
    }
    const hkey = evtMap[last]
    if (hkey && hermesToggles?.[hkey] === false) return null
    const div = document.createElement('div')
    const evFill = eventFill(m.eventClass)
    div.className = `hs-mc-stream-event ${m.eventClass || ''}${evFill ? ` hs-filled hs-fill-${evFill} hs-row-label` : ''}`
    const tsVal = timestampsEnabled && m.time ? formatTimeFromTs(m.time) : ''
    const tsSpan = tsVal ? `<span class="hs-mc-ts">${tsVal}</span>` : ''
    const isYtEvent = m.platform === 'youtube'
    const evtPlat = streamEventPlatform(m.platform)
    // [T]/[K]/[Y] platform badge on every went-live / switch / offline row — the same
    // span and gate as regular chat rows (PLAT_COLORS token, platformBadgesEnabled).
    const evtBadge = { twitch: 'twitch', kick: 'kick', youtube: 'yt' }[evtPlat]
    const platBadge =
      platformBadgesEnabled || evtBadge !== hostPlatform
        ? `<span class="hs-mc-platform-badge hs-mc-pb-${evtBadge}" style="font-size:13px;margin-right:3px;font-weight:700;vertical-align:middle;color:${PLAT_COLORS[evtBadge]}">[${evtBadge === 'yt' ? 'Y' : evtBadge === 'kick' ? 'K' : 'T'}]</span>`
        : ''
    // For redeems, the actor is the redeemer (m.actor). For other events the channel is the actor.
    const ch = m.actor || m.channel || ''
    const chLc = ch.toLowerCase()
    // The streamer's colour, first answer wins: the frame's own colour (m.color:
    // the server's helix colour, or a YT row's DOM scrape) → follow:colors
    // (twitch logins) → the colour seen in that platform's chat → a profile
    // lookup on that platform → the palette. The last three live in
    // hsNameParts, which restyles the row when a later one lands. A kick line
    // never reads a twitch login's colour, id or paint.
    let userColor = m.color || ''
    if (!userColor && evtPlat === 'twitch') userColor = streamColorMap.get(chLc) || ''
    // The streamer's id on this line's platform (the frame's userId, validated)
    // seats the paint and badges at once, before any lookup. A redeem row
    // names the redeemer, not the channel, so the channel's id is not theirs.
    const evtUid = m.actor ? '' : streamEventUserId(evtPlat, m.userId)
    const evt = hsNameParts({
      name: ch,
      userId: evtUid,
      platform: evtPlat,
      colour: userColor,
      login: isYtEvent ? '' : chLc,
      resolve: !isYtEvent,
      exact: true,
    })
    // the badges keyed to the streamer's twitch id, before the name like a chat row
    const evtBadges = evtPlat === 'twitch' ? hsNameBadges(evt) : ''
    // no id yet: the lookup's answer puts the badges in (hsNameSweepLogin)
    if (evtPlat === 'twitch' && !evt.uid) evt.attrs += ' data-hs-nbadge="1"'
    const evtCls = `hs-mc-user hs-evt-user${evt.cls ? ` ${evt.cls}` : ''}`
    // A row whose subject IS the channel (went live, game switch...) knows the
    // channel's handle on the platform it came from, so it links there. A row
    // with an actor (superchat, redeem) names a viewer: YT has no reliable URL
    // from a display name alone, so it stays plain text.
    // data-platform tells the hover card which platform to look the name up
    // on — without it a youtube/kick name is searched as a twitch login (a
    // banned twitch account has no user, so no avatar).
    const platAttr = evtPlat === 'twitch' ? '' : ` data-platform="${evtPlat}"`
    const userLink =
      evtBadges +
      (isYtEvent && m.actor
        ? `<span class="${evtCls}" data-username="${escapeHtml(ch)}"${platAttr}${evt.attrs} style="${escapeHtml(evt.style)}">${evt.inner}</span>`
        : `<a href="${escapeHtml(streamEventUrl(evtPlat, ch).replace(/#hs-live$/, ''))}" target="_blank" rel="noopener noreferrer" class="${evtCls}" data-username="${escapeHtml(ch)}"${platAttr}${evt.attrs} style="${escapeHtml(evt.style)}">${evt.inner}</a>`)
    const textAfterChannel = escapeHtml(m.text).replace(/^\[[^\]]+\]\s*/, '')
    const actionHtml = textAfterChannel.replace(
      /(switched to |now playing |went live \u2014 )(.+)$/,
      '$1<span class="hs-evt-game">$2</span>',
    )
    // switched-to / went-live rows: the name sits on a black cutout (.hs-name-cut) so it
    // reads exactly as in chat, whatever its colour or paint
    const nameBlock = evFill ? `<span class="hs-name-cut">${userLink}</span>` : userLink
    div.innerHTML = `${tsSpan}${platBadge}${nameBlock} ${actionHtml}`
    // The whole row is a shortcut to that channel's page. Clicks that land on
    // the username (or any link/emote) are left alone so the existing
    // profile-card / context-menu behaviour still wins there — only the empty
    // parts of the row open the stream. data-hs-clickable opts it into the
    // universal white-bg/black-text hover, same as the inline DM rows.
    // It opens the platform the event is from (a streamer banned on twitch who
    // only streams on youtube goes live THERE): streamEventUrl picks the page.
    // YT rows with an actor (superchat...) are skipped: a display name gives no
    // reliable channel URL.
    //
    // Only rows whose subject IS the channel get it. `ch` above prefers
    // m.actor, which is set on exactly the rows where the name is NOT a
    // channel — a channel-point redeem carries the redeemer, a 7TV banner the
    // editor. Those rows were opening twitch.tv/<some viewer> and, worse,
    // wearing the white hover plate the whole time they sat there, which
    // advertises a destination on a line that is a notice, not a link. A row
    // announcing that someone redeemed something is not a shortcut to
    // anywhere; the redeemer's own name is still a link for whoever wants it.
    if (ch && !m.actor) {
      div.dataset.hsClickable = ''
      div.style.cursor = 'pointer'
      div.title = t('mc_main_open_on', [ch, isYtEvent ? 'youtube' : evtPlat === 'kick' ? 'kick' : 'twitch'])
      div.addEventListener('click', (e) => {
        if (e.target.closest('a, .hs-mc-user, .hs-mc-emote')) return
        window.open(streamEventUrl(evtPlat, ch), '_blank', 'noopener,noreferrer')
      })
    }
    return div
  }

  // Inline feed post — uses notification type colors from registry
  if (m.type === 'feed-post') {
    const div = document.createElement('div')
    div.className = 'hs-mc-feed-inline'
    div.dataset.msgId = m.base36_id || ''
    const isOp = m.is_op != null ? !!m.is_op : !m.reply_to || m.reply_to === ''
    const isThreadOp = !!m.is_thread_op
    const notifType = isThreadOp ? 'mop' : isOp ? 'op' : 're'
    const typeDef = INLINE_NOTIF_TYPES[notifType]
    const borderColor = m.inlineNotifBorderColor || typeDef?.borderColor || '#fff'
    div.style.borderLeftColor = borderColor
    const tsVal = timestampsEnabled ? formatTimeFromTs(m.time) : ''
    const tsSpan = tsVal ? `<span class="hs-mc-ts">${tsVal}</span>` : ''
    const tagColor = typeDef?.color || 'var(--hs-danger)'
    const tagLabel = isThreadOp || isOp ? '[OP]' : '[RE]'
    const typeTag = `<span class="hs-feed-tag" style="color:${tagColor};font-size:13px;margin-right:3px">${tagLabel}</span>`
    const shortId = (m.base36_id || '').replace(/^0+/, '') || '0'
    // Span (not <a>): falls through to the row click handler below → switchTab('feed') + openThread, in-ext. An anchor would open heatsync.org in a new tab.
    const threadLink = `<span class="hs-feed-thread-link" data-id="${escapeHtml(m.base36_id || '')}" style="cursor:pointer">&gt;&gt;${escapeHtml(shortId)}</span>`
    // Same precedence + resolution chokepoint as the sender/mention/reply-bar
    // sites above: knownUserIds only ever holds a RESOLVED twitch-space id
    // (see paints.js ID-SPACE SAFETY note), populated from real chat activity
    // in joined channels — never invent a second lookup path here. HeatSync
    // paint wins over 7TV, same as everywhere else; queueMcCosmeticsLookup
    // (not queuePaintLookup directly — that must stay the sole call site,
    // see tests/paints.test.js) seeds both caches so a later resolution
    // retro-applies via _mentionIndex (this anchor is indexed generically by
    // _indexMessageDiv purely from its hs-mc-mention class + data-uid, same
    // as any other inline @mention — no bespoke registration needed).
    const feedUid = knownUserIds.get(userKey((m.feedUser || '').toLowerCase(), 'twitch')) || ''
    const feedHsPaint = feedUid ? hsPaintRender(feedUid, m.feedUser || 'anon') : null
    if (feedUid && !feedHsPaint && mcCosmeticsNeedLookup(feedUid)) queueMcCosmeticsLookup(feedUid)
    const feedPaintStyle = feedHsPaint ? '' : feedUid ? getMcPaintStyle(feedUid) : ''
    const userLink = buildFeedQuoteUserLink(m.feedUser, feedUid, feedHsPaint, feedPaintStyle, m.color)
    // Plus tenure — same uid this row's paint already resolved above.
    let feedPlusHtml = ''
    if (feedUid) {
      const feedSince = getHsPlusTenureSince(feedUid)
      if (feedSince === undefined) queuePlusTenureLookup(feedUid)
      else if (feedSince) feedPlusHtml = renderPlusTenureToken(feedSince)
    }
    const content = renderFeedContent(m.text, m.emote_refs)
    // Canonical heat: formatHeat + ° suffix (≥10) + tier color/glow/breathe via heatSpanHtml. Hidden at the baseline 1 — every fresh post starts there and this row never updates, so "name 1:" read as noise.
    const heatHtml = (m.heat || 0) > 1 ? ` ${heatSpanHtml(m.heat)}` : ''
    // All values sanitized — safe innerHTML (heat is numeric, emoji/color are hardcoded)
    // mediaTag is one of gif/img/vid/media with an optional count — built from a
    // fixed set in social.js inlineMediaTag, never post text.
    // mediaSrc (https only, social.js inlineMediaPreview) makes it hoverable: the
    // picture peeks beside it (img-view.js). Not a link — nothing happens on click.
    const mediaSrc = m.mediaSrc ? safeUrl(m.mediaSrc) : ''
    // data-cats: the scanner's flags for the post; img-view.js holds the peek
    // behind the viewer's toggles at hover time, so a changed toggle applies.
    const mediaCats = (Array.isArray(m.mediaCats) ? m.mediaCats : []).filter((c) => /^[a-z_]+$/.test(c)).join(' ')
    const mediaTagHtml = m.mediaTag
      ? ` <span class="hs-feed-media-tag"${mediaSrc ? ` data-src="${escapeHtml(hsProxyImg(mediaSrc))}" data-cats="${escapeHtml(mediaCats)}"` : ''}>[${escapeHtml(m.mediaTag)}]</span>`
      : ''
    div.innerHTML = `${tsSpan}${threadLink}${typeTag}${userLink}${feedPlusHtml}${heatHtml}: <span class="hs-feed-body">${content}</span>${mediaTagHtml}`
    div.addEventListener('click', (e) => {
      const spoiler = e.target.closest('.hs-spoiler')
      if (spoiler) {
        spoiler.classList.toggle('revealed')
        return
      }
      // Only the >>id opens the thread; the rest of the row is plain text.
      if (!e.target.closest('.hs-feed-thread-link')) return
      // Remember where we came from so thread "back" returns here, not the feed.
      threadReturnTab = currentTab === 'feed' ? null : currentTab
      switchTab('feed')
      // A reply row displays >>its-own-id but its thread is the PARENT — open
      // the parent and highlight the clicked reply, else clicking a reply
      // silently dumps you on the parent OP (looked like "wrong post"). Mirrors
      // the feed-tab row handler (social.js buildFeedMessageDiv).
      openThread(m.reply_to || m.base36_id, m.reply_to ? m.base36_id : null)
    })
    return div
  }

  // a heatsync notification (reply / mention / fixed report): its post opens in the feed
  if (m.type === 'inline-notif') {
    const div = document.createElement('div')
    div.className = 'hs-mc-feed-inline hs-mc-notif-inline'
    const color = m.kind === 'reply' ? 'var(--hs-reply)' : m.kind === 'feedback_fixed' ? '#0f0' : '#f00'
    div.style.borderLeftColor = color
    const tsVal = timestampsEnabled ? formatTimeFromTs(m.time) : ''
    const tsSpan = tsVal ? `<span class="hs-mc-ts">${tsVal}</span>` : ''
    const tag = m.kind === 'reply' ? '[reply]' : m.kind === 'feedback_fixed' ? '[fixed]' : '[@]'
    div.innerHTML = `${tsSpan}<span style="color:${color};font-size:13px;font-weight:700;margin-right:4px">${tag}</span><span class="hs-mc-text">${escapeHtml(m.text)}</span>`
    if (m.postId) {
      div.dataset.hsClickable = ''
      div.style.cursor = 'pointer'
      div.addEventListener('click', () => {
        threadReturnTab = currentTab === 'feed' ? null : currentTab
        switchTab('feed')
        openThread(m.postId)
      })
    }
    return div
  }

  // Inline DM/whisper notification
  if (m.type === 'inline-dm') {
    const div = document.createElement('div')
    // Direction color-codes the whole row so an inbound/outbound whisper is
    // unmistakable at a glance: cyan (--hs-reply, the whisper accent) = came
    // IN to you, orange (--hs-brand, self) = went OUT from you. Border, label
    // and the big arrow all share it.
    div.className = `hs-mc-feed-inline hs-mc-dm-inline ${m.outgoing ? 'hs-whisper-out' : 'hs-whisper-in'}${m.failed ? ' hs-whisper-failed' : ''}`
    if (m.sendId) div.dataset.sendId = m.sendId
    const dirColor = m.outgoing ? 'var(--hs-brand)' : 'var(--hs-reply)'
    div.style.borderLeftColor = dirColor
    const tsVal = timestampsEnabled ? formatTimeFromTs(m.time) : ''
    const tsSpan = tsVal ? `<span class="hs-mc-ts">${tsVal}</span>` : ''
    // twitch = whisper, heatsync = native DM — distinct labels so the row
    // says what it actually is (both used to render [DM], which was wrong)
    const labelText = m.platform === 'twitch' ? '[whisper]' : '[DM]'
    const label = `<span style="color:${dirColor};font-size:13px;font-weight:700;margin-right:4px">${labelText}</span>`
    const platBadge =
      m.platform === 'twitch'
        ? '<span style="color:var(--hs-plat-twitch);font-size:13px;font-weight:700;margin-right:3px">[T]</span>'
        : '<span style="color:#fff;font-size:13px;font-weight:700;margin-right:3px">[HS]</span>'
    // Heatsync paint (twitch whispers AND native heatsync DMs), then 7TV on
    // twitch ids, then the flat colour the row carries.
    const dm = hsNameParts({
      name: m.user || '',
      userId: m.userId,
      platform: m.platform,
      colour: m.color,
      login: String(m.user || '').toLowerCase(),
    })
    // Always render the pair "who → who" (sender → recipient). m.user is the
    // OTHER party in both directions (recipient on outgoing, sender on
    // incoming), so the arrow flows away from you on sends, toward you on
    // receives — the same mental model as a chat client's whisper split.
    const otherName = `<span class="hs-dm-name${dm.cls ? ` ${dm.cls}` : ''}"${dm.attrs} style="${escapeHtml(dm.style)}">${dm.inner}</span>`
    const youTok = `<span class="hs-whisper-you">${t('mc_tagcard_you')}</span>`
    const arrow = `<span class="hs-whisper-arrow" style="color:${dirColor}">→</span>`
    const dirPair = m.outgoing ? `${youTok}${arrow}${otherName}` : `${otherName}${arrow}${youTok}`
    // All values sanitized — safe innerHTML
    // @mentions in the DM body paint like anywhere else a person is named —
    // route through highlightMentionsInHtml (skipMentions=true avoids the
    // double-anchor bug), reusing the sender path's HS-paint → 7TV → color
    // precedence + twitch-space id-guard rather than the plain fallback.
    if (m._renderedHtml == null)
      m._renderedHtml = highlightHashtagsInHtml(
        highlightMentionsInHtml(
          processEmotes(escapeHtml(m.text), null, hsAnyChannelEmotes(), undefined, undefined, true),
          m.platform,
        ),
      )
    // All values already sanitized via escapeHtml/processEmotes — safe innerHTML (existing pattern)
    const failMark = m.failed
      ? ` <span class="hs-cmd-mark hs-cmd-fail">${escapeHtml(`✗${m.error ? ` ${m.error}` : ''}`)}</span>`
      : ''
    div.innerHTML = `${tsSpan}${label}${platBadge}${dirPair}: ${m._renderedHtml}${failMark}`
    // Clickable rows must obey the universal hover invert like every other
    // control. role="button" isn't an option — the row contains anchors
    // (@mentions), so it'd nest interactive-in-interactive; the data attribute
    // opts it into the same single rule.
    div.dataset.hsClickable = ''
    div.style.cursor = 'pointer'
    div.addEventListener('click', (e) => {
      if (e.target.closest('a, .hs-mc-emote')) return
      switchTab('whispers')
    })
    return div
  }

  // Slash-command receipt: the command as typed, pending, then a checkmark
  // or an X + failure reason. Always forced (beginCmdReceipt, above) — this
  // is a confirmation of your own action, not a notification to gate.
  if (m.type === 'cmd-receipt') {
    const div = document.createElement('div')
    div.className = `hs-mc-feed-inline hs-mc-cmd-inline${m.status === 'failed' ? ' hs-cmd-failed' : ''}`
    if (m.sendId) div.dataset.sendId = m.sendId
    div.style.borderLeftColor = m.inlineNotifBorderColor || '#ffffff'
    const tsVal = timestampsEnabled ? formatTimeFromTs(m.time) : ''
    const tsSpan = tsVal ? `<span class="hs-mc-ts">${tsVal}</span>` : ''
    const label = `<span style="color:${escapeHtml(m.inlineNotifColor || '#ffffff')};font-size:13px;font-weight:700;margin-right:4px">[cmd]</span>`
    const cmdText = `<span class="hs-cmd-text">${escapeHtml(m.text)}</span>`
    const markCls = m.status === 'ok' ? 'hs-cmd-ok' : m.status === 'failed' ? 'hs-cmd-fail' : 'hs-cmd-pending'
    const markText = m.status === 'ok' ? '✓' : m.status === 'failed' ? `✗${m.reason ? ` ${m.reason}` : ''}` : '…'
    div.innerHTML = `${tsSpan}${label}${cmdText} <span class="hs-cmd-mark ${markCls}">${escapeHtml(markText)}</span>`
    return div
  }

  if (m.type === 'moment') {
    const div = document.createElement('div')
    div.className = 'hs-mc-feed-inline hs-mc-moment-inline'
    div.style.borderLeftColor = m.inlineNotifBorderColor || '#fff'
    const tsVal = timestampsEnabled ? formatTimeFromTs(m.time) : ''
    const tsSpan = tsVal ? `<span class="hs-mc-ts">${tsVal}</span>` : ''
    const label = `<span style="color:${escapeHtml(m.inlineNotifColor || '#fff')};font-size:13px;font-weight:700;margin-right:3px">[🔥]</span>`
    // ¶ permalink → shareable SSR page (right-click copy-link works natively);
    // the row click handler ignores anchors, mirrors the site's moment-card.
    // Shift-click pastes the URL into the chat input instead — the in-chat
    // visibility loop: non-users see a plain heatsync.org link, click =
    // instant value, no wall. Never auto-sends; the user owns the enter key.
    const perma =
      m.momentId && /^\d+$/.test(m.momentId)
        ? ` <a class="hs-mc-moment-perma" href="https://heatsync.org/moment/${encodeURIComponent(m.momentId)}" target="_blank" rel="noopener" title="${t('mc_moment_permalink')}">¶</a>`
        : ''
    div.innerHTML = `${tsSpan}${label}<span style="color:#ffffff">${escapeHtml(m.text || '')}</span>${perma}`
    // Same deal as the inline DM row: clickable, contains an anchor (¶ perma),
    // so it opts into the universal hover via the attribute, not role.
    div.dataset.hsClickable = ''
    div.style.cursor = 'pointer'
    const ch = m.momentChannel
    const plat = m.momentPlatform || 'twitch'
    div.title = t('mc_main_open_chat', [ch])
    div.addEventListener('click', (e) => {
      const permaEl = e.target.closest?.('a.hs-mc-moment-perma')
      if (permaEl && e.shiftKey) {
        e.preventDefault()
        const input = document.getElementById('hs-mc-input')
        if (!input) return
        const momentUrl = permaEl.getAttribute('href')
        const cur = (typeof getInputText === 'function' ? getInputText() : input.value) || ''
        const next = `${(cur.trim() ? `${cur.trimEnd()} ` : '') + momentUrl} `
        if (typeof wysiwygEnabled !== 'undefined' && wysiwygEnabled && typeof restoreWysiwygText === 'function') {
          restoreWysiwygText(input, next)
        } else {
          input.value = next
        }
        try {
          input.focus()
        } catch (_) {}
        return
      }
      if (e.target.closest('a')) return
      // A spike row lands you in the CHAT ROOM, not the stream page: the
      // relevance filter (handleMomentSpike) only surfaces spikes for
      // channels in your tabs or the one you're watching, so a chat tab
      // exists in almost every case — switch to it. The currently-watched
      // channel maps to the live tab. Only a spike with no tab anywhere
      // falls back to opening the stream in a new tab.
      const chLc = (ch || '').toLowerCase()
      const tabCh = (config?.channels || []).find((c) =>
        plat === 'kick' ? c?.kick?.toLowerCase() === chLc : c?.twitch?.toLowerCase() === chLc,
      )
      if (tabCh?.id) {
        switchTab(tabCh.id)
        return
      }
      if (typeof getCurrentChannel === 'function' && (getCurrentChannel() || '').toLowerCase() === chLc) {
        switchTab(liveTarget())
        return
      }
      const url = plat === 'kick' ? `https://kick.com/${ch}` : `https://www.twitch.tv/${ch}`
      try {
        window.open(url, '_blank', 'noopener')
      } catch (_) {}
    })
    return div
  }

  // AutoMod hold-queue row — twitch automod paused a viewer's message in a
  // channel this user moderates. Rendered on its own (not through the usual
  // notice/noticeKind path — mutable status + buttons need custom content).
  // Escaping happens in automod-queue.js's buildAutomodHoldContentHtml so
  // nothing here touches the raw sender/text/terms payload.
  if (m.type === 'automod-hold') {
    const div = document.createElement('div')
    div.className = 'hs-mc-msg hs-mc-automod hs-filled hs-fill-red'
    div.dataset.msgId = m.msgId
    div.dataset.msgChannel = m.broadcasterLogin || ''
    const tsVal = timestampsEnabled ? formatTimeFromTs(m.heldAt) : ''
    const tsSpan = tsVal ? `<span class="hs-mc-ts">${tsVal}</span>` : ''
    const { senderHtml, textHtml, reasonHtml } = buildAutomodHoldContentHtml(m)
    const actionsHtml = renderAutomodHoldActionsHtml(m)
    const safeMsgId = escapeHtml(m.msgId || '')
    // All values pre-escaped (buildAutomodHoldContentHtml) or hardcoded/numeric — safe innerHTML
    div.innerHTML =
      `${tsSpan}<span class="hs-mc-automod-badge">${escapeHtml(t('mc_automod_label'))}</span>` +
      `<span class="hs-mc-automod-chip">${reasonHtml}</span>` +
      `<div class="hs-mc-automod-body"><span class="hs-mc-automod-sender">${senderHtml}</span>: <span class="hs-mc-automod-text">${textHtml}</span></div>` +
      `<div class="hs-mc-automod-actions" data-msg-id="${safeMsgId}">${actionsHtml}</div>`
    return div
  }

  const showChannel = tabId === 'mentions'
  const isSuperChat = m.platform === 'youtube' && (m.msgType === 'superchat' || m.msgType === 'supersticker')
  const isMembership =
    m.platform === 'youtube' &&
    (m.msgType === 'membership' || m.msgType === 'giftpurchase' || m.msgType === 'giftredemption')
  const isKicksEvent = m.kicksEvent === true
  // Map noticeType / msgId to a semantic CSS modifier so each event class
  // (unban, ban, mod-add, mode-change, sub, raid, etc.) can have its own color/icon
  const noticeKind = (() => {
    if (m.type !== 'notice' && m.type !== 'usernotice') return ''
    let id = m.noticeType || m.msgId || ''
    if (!id) return ''
    // shared-chat wrapper: the real event type rides in source-msg-id
    if (id === 'sharedchatnotice' && m.sourceMsgId) id = m.sourceMsgId
    // group related msg-ids into a single semantic class
    if (id === 'unban_success') return 'hs-mc-notice-unban'
    if (id === 'untimeout_success') return 'hs-mc-notice-untimeout'
    if (id === 'ban_success') return 'hs-mc-notice-ban'
    if (id === 'timeout_success') return 'hs-mc-notice-timeout'
    if (id === 'mod_success') return 'hs-mc-notice-mod-add'
    if (id === 'vip_success') return 'hs-mc-notice-vip-add'
    if (id === 'unmod_success') return 'hs-mc-notice-mod-remove'
    if (id === 'unvip_success') return 'hs-mc-notice-vip-remove'
    if (id === 'delete_message_success') return 'hs-mc-notice-delete'
    if (
      id === 'mode_change' ||
      id === 'slow_on' ||
      id === 'slow_off' ||
      id === 'subs_on' ||
      id === 'subs_off' ||
      id === 'emote_only_on' ||
      id === 'emote_only_off' ||
      id === 'followers_on' ||
      id === 'followers_on_zero' ||
      id === 'followers_off' ||
      id === 'r9k_on' ||
      id === 'r9k_off'
    )
      return 'hs-mc-notice-mode'
    if (id === 'sub' || id === 'resub' || id === 'primepaidupgrade' || id === 'extendsub') return 'hs-mc-notice-sub'
    // Kick event names — heatsync server passes Kick-side strings through;
    // normalize to the same CSS classes Twitch sub/gift events use so the
    // sub-purple border, gift-bubble pink, etc. render identically.
    if (
      id === 'subscription' ||
      id === 'channel.subscription.new' ||
      id === 'channel.subscription.renewal' ||
      id === 'resubscription'
    )
      return 'hs-mc-notice-sub'
    if (
      id === 'subgift' ||
      id === 'anonsubgift' ||
      id === 'submysterygift' ||
      id === 'giftpaidupgrade' ||
      id === 'anongiftpaidupgrade' ||
      id === 'rewardgift' ||
      id === 'standardpayforward' ||
      id === 'communitypayforward' ||
      id === 'gift_subscription' ||
      id === 'gifted_subscriptions' ||
      id === 'channel.subscription.gifts'
    )
      return 'hs-mc-notice-gift'
    if (id === 'raid' || id === 'unraid') return 'hs-mc-notice-raid'
    // Kick host events — render same as raid
    if (id === 'host' || id === 'unhost' || id === 'channel.host') return 'hs-mc-notice-raid'
    // Kick "Kicks" gifted events (already wired in irc.js as kicksEvent)
    if (id === 'kicks_gifted' || id === 'kicks') return 'hs-mc-notice-bits'
    if (id === 'announcement') return 'hs-mc-notice-announce'
    if (id === 'bitsbadgetier') return 'hs-mc-notice-bits'
    if (id === 'watchstreak') return 'hs-mc-notice-watchstreak'
    if (id === 'viewermilestone') return 'hs-mc-notice-milestone'
    // mod-anniversary — Twitch ships USERNOTICE every 6 months a user
    // moderates a channel (announced TwitchCon Rotterdam 2026). Same payload
    // shape as sub anniversary; render with mod-add's blue family so the
    // moderator-celebration thread reads consistently.
    if (id === 'mod-anniversary' || id === 'mod_anniversary') return 'hs-mc-notice-mod-anniversary'
    if (id === 'charitydonation' || id === 'charity_donation') return 'hs-mc-notice-charity'
    // ritual = twitch's legacy new-chatter usernotice; render with the
    // user-intro treatment (same "new here" semantics)
    if (id === 'ritual' || id === 'new_chatter') return 'hs-mc-user-intro'
    if (id === 'pin') return 'hs-mc-notice-pin'
    if (
      id === 'msg_banned' ||
      id === 'msg_timedout' ||
      id === 'no_permission' ||
      id.startsWith('bad_') ||
      id.startsWith('usage_')
    )
      return 'hs-mc-notice-error'
    return ''
  })()
  // Guard against messages with no user (malformed IRC / system messages).
  // Sits BELOW the classifier on purpose: user-less NOTICEs (mode changes,
  // msg_banned errors, pin lines) still get their semantic notice color —
  // the old early-return rendered them all as bare grey system rows.
  if (!m.user) {
    if (m.text || m.systemMsg) {
      const div = document.createElement('div')
      div.className = `hs-mc-msg hs-mc-system ${noticeKind}`.trim()
      // .hs-mc-system-text span so the per-kind text-color rules apply
      const span = document.createElement('span')
      span.className = 'hs-mc-system-text'
      span.textContent = m.systemMsg || m.text || ''
      div.appendChild(span)
      const sysFill = rowFill(div)
      if (sysFill) div.classList.add('hs-filled', `hs-fill-${sysFill}`, 'hs-row-label')
      return div
    }
    return null
  }
  const cls =
    tabId === 'mentions'
      ? 'hs-mc-msg mention hs-row-mention'
      : isKicksEvent
        ? 'hs-mc-msg hs-mc-system hs-mc-kicks'
        : isMembership
          ? 'hs-mc-msg hs-mc-system'
          : m.type === 'usernotice' || m.type === 'notice'
            ? `hs-mc-msg hs-mc-system ${noticeKind}`.trim()
            : m.isHighlighted
              ? 'hs-mc-msg hs-mc-highlighted'
              : m.redeemed
                ? 'hs-mc-msg hs-mc-redeemed'
                : isSuperChat
                  ? 'hs-mc-msg hs-mc-superchat'
                  : isMention(m)
                    ? 'hs-mc-msg mention hs-row-mention'
                    : 'hs-mc-msg'
  const channelSpan = showChannel && m.channel ? `<span class="hs-mc-channel">${escapeHtml(m.channel)}</span>` : ''
  // Render badges — YouTube sends array of {type,label,url}, Twitch/Kick send IRC badge string
  let badges = ''
  if (m.platform === 'youtube' && Array.isArray(m.badges)) {
    badges = m.badges
      .map((b) => {
        if (b.url) {
          return `<img class="hs-mc-badge-img" src="${escapeHtml(b.url)}" alt="${escapeHtml(b.label)}" title="${escapeHtml(b.label)}" decoding="async" width="18" height="18" style="width:18px;height:18px;">`
        }
        // Text fallback for owner/mod without image
        const ytBadgeStyles = {
          owner: { bg: '#000000', fg: '#ffff00', label: '\u2606' },
          moderator: { bg: '#000000', fg: '#8888ff', label: '\u2694' },
        }
        const style = ytBadgeStyles[b.type]
        if (style)
          return `<span class="hs-mc-badge" style="background:${style.bg};color:${style.fg}" title="${escapeHtml(b.label)}">${style.label}</span>`
        return ''
      })
      .join('')
  } else {
    // m.badgePlatform preserves the ORIGINAL chat origin (twitch IRC vs
    // Kick WS) when peekSentHost retags m.platform to the user's send-host
    // ('kick' on own msg from kick.com). Badge URL lookup must use the
    // origin platform — mod/sub badges on a Twitch IRC msg always belong
    // to the Twitch badge namespace, regardless of [K]/[T] indicator.
    badges = renderBadges(m.badges, m.channel, m.badgePlatform || m.platform)
  }
  // YT messages don't carry a Twitch ID — resolve via heatsync profile
  // lookup keyed by the YT @handle. If cached, hoist into m.userId so the
  // existing badge + cosmetics pipeline applies; if not, queue a lookup
  // and updateCosmeticsInPlace will repaint after backfill.
  if (!m.userId && m.platform === 'youtube' && m.user) {
    const ytKey = (m.user || '').toLowerCase().replace(/^@/, '')
    const cached = ytNameToTwitchId.get(ytKey)
    if (cached) m.userId = cached
    else if (cached === undefined) queueYtNameToTwitchId(m.user)
  }
  // Kick: resolve via 7TV/v3/users/kick/{name} which also returns the linked
  // twitch_id when present. Hoist into m.userId + m._uidTwitch so the
  // existing cosmetics pipeline applies. Gated on !m._uidTwitch (NOT
  // !m.userId): pusher/relay kick messages always carry the numeric KICK id,
  // which is a different id-space — only the _uidTwitch stamp marks a
  // resolved twitch identity.
  if (m.platform === 'kick' && m.user && !m._uidTwitch) {
    const kKey = (m.user || '').toLowerCase()
    const cached = kickNameResolved.get(kKey)
    if (cached) {
      m.userId = cached
      m._uidTwitch = cached
    } else if (cached === undefined) {
      // m.userId (pre-hoist) is the raw numeric kick id — skips the
      // kick.com username→id lookup when the pusher tap already gave it.
      queueKickNameToCosmetics(m.user, m.userId || null)
    }
  }
  // Kick-space paint uid (kick_<kickid>) — set independent of whether the
  // twitch lookup above resolved (a kick-origin HeatSync account can have
  // its own paint with or without a linked twitch account). Cache-hit path
  // only; a cold lookup lands this via flushKickNameLookups' patchBuf once
  // the batch resolves.
  if (!m.hsPaintUid && m.platform === 'kick' && m.user) {
    const paintUid = kickNamePaintUid.get((m.user || '').toLowerCase())
    if (paintUid) m.hsPaintUid = paintUid
  }
  // ID-SPACE SAFETY: a kick row's userId is the raw numeric KICK id until
  // the hoist above / flushKickNameLookups patches in the linked twitch id
  // (m._uidTwitch). The badge maps, 7TV cosmetics and paint caches below are
  // all TWITCH id-space — a bare kick id collides with an unrelated twitch
  // user's entry, painting the wrong person. Kick rows resolve through the
  // name-keyed kick pipeline (kickNamePaintUid + queueKickNameToCosmetics).
  // A twitch row can arrive with no user id (the page-tap path reads it from
  // the native chat's props, and some rows carry none). Everything below —
  // paint, 7TV cosmetics, the sender's personal emotes — is keyed by it, so
  // that row rendered as a stranger. The same chatter's earlier rows told us
  // the id; use it.
  if (!m.userId && (m.platform === 'twitch' || !m.platform) && m.user) {
    const lowerUser = m.user.toLowerCase()
    m.userId =
      knownUserIds.get(userKey(lowerUser, 'twitch')) ||
      (typeof _hsUserIdCache !== 'undefined' ? _hsUserIdCache.get(lowerUser) : '') ||
      ''
  }
  const uidTwitch = (m.platform === 'kick' ? m._uidTwitch : m.userId) || ''
  if (uidTwitch) {
    badges += renderThirdPartyBadges(uidTwitch)
    if (mcCosmeticsNeedLookup(uidTwitch)) queueMcCosmeticsLookup(uidTwitch)
  }
  const plat =
    m.platform === 'youtube' ? 'yt' : m.platform === 'kick' ? 'kick' : m.platform === 'heatsync' ? 'heatsync' : 'twitch'
  const platLabel = plat === 'yt' ? '[Y]' : plat === 'kick' ? '[K]' : plat === 'heatsync' ? '[H]' : '[T]'
  // after the chatterino badge, before the name: sub flair, 🔥, heat bar (twitch rows only)
  const marksHtml = plat === 'twitch' ? hsMarksRowHtml(m, String(uidTwitch || '')) : ''
  const platformBadge =
    platformBadgesEnabled || plat !== hostPlatform
      ? `<span class="hs-mc-platform-badge hs-mc-pb-${plat}" style="font-size:13px;margin-right:3px;font-weight:700;vertical-align:middle;color:${PLAT_COLORS[plat]}">${platLabel}</span>`
      : ''
  const safeScColor = sanitizeColor(m.scColor || '#ffff00')
  const scBadge =
    isSuperChat && m.amount
      ? `<span class="hs-mc-sc-badge" style="background:${safeScColor};color:#000;padding:0 4px;border-radius:0;font-size:13px;font-weight:700;margin-right:3px;">${escapeHtml(m.amount)}</span>`
      : ''
  const bitsN = m.bits && t('mc_bits_n', [m.bits])
  const bitsBadge = m.bits ? `<span class="hs-mc-bits-badge" title="${bitsN}">${bitsN}</span>` : ''
  // (cheermote rendering is applied inline in processedText via renderCheermotesInText)
  // HeatSync paint (own-platform cosmetic) takes precedence over 7TV — see
  // hsPaintRender in paints.js. Returns null (falls through to the existing
  // 7TV/plain-color path) until/unless one is cached for this uid. A kick
  // chatter's own kick-space uid (m.hsPaintUid, kick_<id>) is a fallback
  // behind their resolved twitch uid — see the ID-SPACE SAFETY note in
  // paints.js: a kick-origin HeatSync account can exist with or without a
  // twitch link, so try twitch first, then the kick-namespaced id.
  // uidTwitch (not raw m.userId): paint caches are twitch-space — a kick
  // row's numeric kick id would fetch/render an unrelated twitch user's paint.
  const hsPaint =
    (uidTwitch ? hsPaintRender(uidTwitch, m.user) : null) || (m.hsPaintUid ? hsPaintRender(m.hsPaintUid, m.user) : null)
  // 7TV paint: twitch-space uid, else the kick_/yt_ namespaced uid (so a re-render
  // keeps a paint that only resolved through the name lookups)
  const paintStyle = hsPaint ? '' : uidTwitch || m.hsPaintUid ? getMcPaintStyle(uidTwitch || m.hsPaintUid) : ''
  // Plus tenure ("+5mo"/"+3y" beside an active Plus member's name) — an
  // identity signal, not a cosmetic, so it resolves regardless of the
  // showNamePaints setting. Same uid precedence as hsPaint above: resolved
  // twitch-space uid first, kick/yt-namespaced hsPaintUid fallback.
  const hsPlusUid = uidTwitch || m.hsPaintUid || ''
  let hsPlusHtml = ''
  if (hsPlusUid) {
    const since = getHsPlusTenureSince(hsPlusUid)
    if (since === undefined) queuePlusTenureLookup(hsPlusUid)
    else hsPlusHtml = (since ? renderPlusTenureToken(since) : '') + renderHsBadgeToken(getHsBadgeId(hsPlusUid))
  }
  // Name colour (when no HS/7TV paint owns the fill): the user's PICKED
  // heatsync colour on youtube + kick ONLY — never twitch, whose custom name
  // colour is the prime/turbo paid perk. YouTube has no native colour, so its
  // names fall back to a deterministic djb2 palette colour (identical to
  // heatsync.org) instead of a flat red. Picked colour resolves async via the
  // same batch as paints (updateHsColorsInPlace repaints in place).
  let hsNameColor = m.color
  // One username, one color: once a twitch name has been heard with its real
  // color, every line of it draws that color. Old lines carry the color the
  // name had when it was sent (or none at all, for history replay and panel
  // echoes), so a chatter who changed color showed a different one per line.
  if (plat === 'twitch') {
    const lc = m.user.toLowerCase()
    if (_nativeTwitchColor.has(lc)) hsNameColor = knownColors.get(lc) || hsNameColor
  }
  if (plat === 'yt' || plat === 'kick') {
    if (m.hsPaintUid) queueNameColorLookup(m.hsPaintUid)
    const picked = m.hsPaintUid ? getHsPickedColor(m.hsPaintUid) : null
    if (picked) hsNameColor = picked
    else if (plat === 'yt') hsNameColor = hsUsernameColor(m.user)
  }
  // Build the channel link for the username. YouTube usernames arrive
  // prefixed with "@" so we strip it before concatenating to avoid
  // youtube.com/@/%40handle-style double-encoding.
  let userHref
  if (plat === 'kick') {
    userHref = `https://kick.com/${encodeURIComponent(m.user)}`
  } else if (plat === 'yt') {
    const ytHandle = (m.user || '').replace(/^@/, '')
    userHref = `https://youtube.com/@${encodeURIComponent(ytHandle)}`
  } else if (plat === 'heatsync') {
    userHref = `https://heatsync.org/${encodeURIComponent(m.user)}`
  } else {
    userHref = `https://twitch.tv/${encodeURIComponent(m.user)}`
  }
  // When painted, drop the inline color decl (the class owns the paint
  // fill) and carry the mount stamp instead so every copy of the paint
  // phase-locks to the wall clock (lib/paint-spec.js syncDelayCalc).
  const userLink = `<a href="${userHref}" target="_blank" rel="noopener noreferrer" class="hs-mc-user${hsPaint ? ` ${hsPaint.cls}` : ''}" data-username="${escapeHtml(m.user.toLowerCase())}" data-platform="${plat}"${hsPaint ? hsPaint.splitAttr : ''} style="${hsPaint ? `--hsp-t:${paintPhaseNow()};${hsNameColourDecl(sanitizeColor(hsNameColor || '#fff'))}` : `color:${sanitizeColor(hsNameColor || '#fff')}${paintStyle ? `;${paintStyle}` : ''}`}">${hsPaint ? hsPaint.html : escapeHtml(m.user)}</a>`
  let avatarHtml = ''
  if (avatarsEnabled) {
    const userKey = m.user.toLowerCase()
    // YouTube messages carry avatar URL directly — cache it and skip the fetch.
    // Same 500-entry LRU as the fetched-avatar path so 30k unique YT chatters
    // can't grow the Map unbounded over an 8h stream.
    if (m.avatar && m.platform === 'youtube') {
      // Protocol-validate before caching — this URL later flows into img.src.
      // Mirrors the fetched avatar path which already routes through safeUrl.
      const safe = safeUrl(m.avatar)
      if (safe) avatarCache.set(userKey, safe)
      if (avatarCache.size > 500) {
        avatarCache.delete(avatarCache.keys().next().value)
      }
    }
    const cachedUrl = avatarCache.get(userKey)
    if (cachedUrl) {
      avatarHtml = `<img class="hs-mc-avatar" src="${escapeHtml(cachedUrl)}" alt="" loading="lazy" decoding="async">`
    } else if (!m.platform || m.platform === 'twitch') {
      // Initials reserve the box immediately; fetchAvatar swaps the real pfp
      // in place on success (zero shift) or it stays as the initial on a
      // miss/failure (no blank gap). Unifies with the kick/yt path below.
      avatarHtml = avatarFallbackHtml(m.user, userKey, true)
      fetchAvatar(userKey)
    } else if (m.platform === 'kick') {
      // Kick real avatars ride the cosmetics pipeline (flushKickNameLookups
      // caches the profile_pic from the same v1/users fetch that resolves
      // cosmetics). Tag the placeholder with data-user so that swap can find
      // and replace it in place — same zero-shift mechanism as twitch.
      avatarHtml = avatarFallbackHtml(m.user, userKey, true)
    } else {
      // YouTube without an inline avatar — neutral initials, no swap path.
      avatarHtml = avatarFallbackHtml(m.user, userKey, false)
    }
  }

  // Process text (emotes + YT emoji + mentions + cheermotes), cached on
  // m._renderedHtml. Shared with reprocessEmoteTextInPlace via this helper so
  // an in-place emote reload produces byte-identical HTML to a full rebuild.
  // Skip text-less rows (system/usernotice with only a systemMsg) — they
  // render via ${systemLine}, never ${processedText}, so computing would just
  // cache a spurious '' (and pointlessly queue a sender-emote fetch).
  const processedText = m.text ? computeMessageText(m) : ''

  // Sticker for super stickers
  let stickerHtml = ''
  if (m.sticker?.url) {
    stickerHtml = ` <img src="${escapeHtml(m.sticker.url)}" alt="${escapeHtml(m.sticker.alt || 'sticker')}" loading="lazy" decoding="async" style="height:48px;vertical-align:middle;" />`
  }

  const div = document.createElement('div')
  div.className = cls
  div._hsMsg = m // back-ref for reprocessEmoteTextInPlace (GC'd with the row)
  div._hsAppliedText = processedText // baseline for reprocess's unchanged-skip
  // uidTwitch, never raw m.userId: data-uid is twitch-id-space only (feeds
  // _uidIndex / updateCosmeticsInPlace). A kick row's numeric kick id here
  // would both collide with an unrelated twitch user's repaint AND block
  // flushKickNameLookups' backfill (it only stamps when data-uid is empty).
  if (uidTwitch) div.dataset.uid = uidTwitch
  // Kick-space paint uid — parallel to data-uid, never a substitute for it
  // (data-uid stays twitch-id-space only). Lets a kick-namespaced
  // HS paint resolution find this row in-place (updateHsPaintsInPlace).
  if (m.hsPaintUid) div.dataset.hsPaintUid = m.hsPaintUid
  // First-time chatter highlight (this session, per channel)
  if (
    firstChatterGlow &&
    m.user &&
    m.channel &&
    !isMembership &&
    !isKicksEvent &&
    m.type !== 'usernotice' &&
    m.type !== 'notice'
  ) {
    // Mark seen regardless so the user's NEXT message isn't mis-flagged yellow,
    // but channel-first (purple hs-mc-first-msg) outranks session-first — don't glow yellow over it.
    const sessionFirst = markChatterSeen(m.channel, m.user)
    if (sessionFirst && !m.isFirstMsg) {
      div.classList.add('hs-first-msg', 'hs-row-seen')
    }
  }
  // Twitch first-msg flag — brand new user to the channel (not just this session)
  if (m.isFirstMsg) {
    div.classList.add('hs-mc-first-msg')
  }
  // Returning chatter — chatted before, back after a long absence (twitch tag).
  if (m.isReturningChatter) div.classList.add('is-returning')
  // "new to chat" intro message (twitch msg-id=user-intro)
  if (m.userIntro) div.classList.add('hs-mc-user-intro')
  // Power-ups: gigantified emote (last emote renders big) + message effect
  // (static fx chip — no motion by design; the effect NAME is the info)
  if (m.gigantified) div.classList.add('hs-mc-gigantified')
  if (m.animationId) {
    div.classList.add('hs-mc-animated')
    div.dataset.hsAnim = String(m.animationId).slice(0, 32)
  }
  // Shared-chat session: message originated in the partner channel. Chip
  // starts as plain 'shared' (CSS default); once the room id resolves to a
  // login it upgrades to 'shared:<login>' via the data attribute — both
  // synchronously for a cache hit and, on a miss, retroactively for every
  // row already on screen from that room (resolveSharedChatLogin below).
  if (m.sharedChat) {
    div.classList.add('hs-mc-shared')
    if (m.sourceRoomId) {
      div.dataset.hsSharedRoom = m.sourceRoomId
      const cachedLogin = _sharedChatLoginCache.get(m.sourceRoomId)
      if (cachedLogin) div.dataset.hsSharedLogin = cachedLogin
      // undefined = never requested; null = request in flight (don't refire);
      // '' = a prior request failed (don't hammer the background on every message)
      else if (cachedLogin === undefined) resolveSharedChatLogin(m.sourceRoomId)
    }
  }
  // Raider — a first message arriving in the window after a raid into this channel.
  if (m.isRaider) div.classList.add('is-raider')
  // Cleared by mod (timeout/ban/delete) — Twitch-native dim + strikethrough on offending content
  if (m.cleared && dimTimeouts) {
    div.classList.add('hs-mc-msg-cleared')
    if (m.clearedReason) div.dataset.clearedReason = m.clearedReason
  }
  // Filter rule highlight — per-rule color accent (hide is handled before buffer insert)
  const _frHL = evaluateFilterRules(m, tabId)
  if (_frHL.highlight) {
    div.classList.add('hs-mc-rule-highlight')
    div.style.setProperty('--hs-rule-hl', _frHL.highlight)
    div.style.setProperty('--hs-rule-bg', ruleFillVar(_frHL.highlight))
  }
  // Reply context bar (Chatterino-style) — all values escaped via escapeHtml
  const replyLower = m.replyTo?.user ? m.replyTo.user.toLowerCase() : ''
  // Paint the reply target's name with their 7TV cosmetic — same person, same
  // paint as their own messages. Twitch carries reply-parent-user-id; Kick
  // (no parent id) falls back to the name→uid map. data-uid lets
  // updateCosmeticsInPlace repaint it once the cosmetic batch lands.
  const replyUid = (m.replyTo && (m.replyTo.userId || knownUserIds.get(userKey(replyLower, m.platform)))) || ''
  // HeatSync paint wins over 7TV here too — same precedence rule as the
  // sender username above.
  const replyHsPaint = replyUid ? hsPaintRender(replyUid, `@${m.replyTo?.user || ''}`) : null
  const replyPaint = replyHsPaint ? '' : replyUid ? userPaintStyle(replyUid, replyLower, m.platform) : ''
  // Mount stamp (not a color decl) when painted — phase-locks this copy to
  // the same wall-clock frame as every other copy of the paint.
  const replyStyle = replyHsPaint
    ? `--hsp-t:${paintPhaseNow()};${hsNameColourDecl(mentionColor(replyLower))}`
    : replyPaint || `color:${mentionColor(replyLower)}`
  const replyUidAttr = replyUid ? ` data-uid="${escapeHtml(replyUid)}"` : ''
  const replyUserCls = `hs-mc-user hs-mc-reply-user${replyHsPaint ? ` ${replyHsPaint.cls}` : ''}`
  const replyUserSplitAttr = replyHsPaint ? replyHsPaint.splitAttr : ''
  const replyUserHtml = replyHsPaint ? replyHsPaint.html : `@${escapeHtml(m.replyTo?.user || '')}`
  // Plus tenure ("+5mo"/"+3y") — identity signal, resolves regardless of
  // the paint setting. Same replyUid the reply-bar paint already resolved.
  let replyPlusHtml = ''
  if (replyUid) {
    const replySince = getHsPlusTenureSince(replyUid)
    if (replySince === undefined) queuePlusTenureLookup(replyUid)
    else if (replySince) replyPlusHtml = renderPlusTenureToken(replySince)
  }
  // A blocked user's name + message snippet must not leak through a reply
  // context bar when someone else replies to them. Show a neutral marker
  // with no name, no text, no profile link.
  const replyBlocked = m.replyTo?.user && isUserBlocked(m.replyTo.user, m.platform)
  const replyBar = replyBlocked
    ? `<span class="hs-mc-reply-ctx hs-reply-ctx">&#8618;${t('mc_reply_blocked')}</span> `
    : m.replyTo?.user
      ? // role/tabindex/aria make the pill the control it always was. Clicking
        // it has opened the thread stack for a long time, but nothing SAID so:
        // it read as static text, so the feature was invisible unless you
        // already knew. The trailing caret is the affordance, aria-expanded is
        // the state, and both the universal hover invert and keyboard
        // activation come free once it is a button.
        `<span class="hs-mc-reply-ctx hs-reply-ctx" role="button" tabindex="0" aria-expanded="false" title="${escapeHtml(m.replyTo.user)}: ${escapeHtml(m.replyTo.text || '')}">&#8618;<a href="https://heatsync.org/user/${encodeURIComponent(m.replyTo.user)}" target="_blank" rel="noopener noreferrer" class="${replyUserCls}" data-username="${escapeHtml(replyLower)}" data-platform="${escapeHtml(m.platform || 'twitch')}"${replyUidAttr}${replyUserSplitAttr} style="${escapeHtml(replyStyle)}">${replyUserHtml}</a>${replyPlusHtml}${m.replyTo.text ? `<span class="hs-mc-reply-snippet">: ${escapeHtml(m.replyTo.text)}</span>` : ''}</span> `
      : ''
  // Redeem label — look up reward title from Hermes cache
  let redeemLabel = ''
  if (m.redeemed && m.rewardId) {
    const reward = redeemTitleMap.get(m.rewardId)
    redeemLabel = reward
      ? `<span class="hs-mc-system-text hs-row-label hs-mc-redeem-label">\u25C6 ${escapeHtml(reward.title)} \u00B7 ${t('mc_main_redeem_pts', [Number(reward.cost).toLocaleString()])}</span>`
      : `<span class="hs-mc-system-text hs-row-label hs-mc-redeem-label">\u25C6 ${t('mc_main_redeem_label')}</span>`
  } else if (m.isHighlighted) {
    redeemLabel = `<span class="hs-mc-system-text hs-row-label hs-mc-highlight-label">\u2728 ${t('mc_main_highlighted')}</span>`
  }
  // First-message rows said what they were with COLOUR ALONE — a magenta bar
  // for a channel-first, a faint inset glow for a session-first. Nobody can
  // read a colour they were never given a key to, and the glow was barely
  // above the background besides. Redeems and highlights next to them have
  // carried a text label all along; these get the same treatment, using the
  // same primitive rather than a new one.
  //
  // Its own variable, not another branch of the chain above: a first message
  // can also be a redeem or a highlight, and those are different facts about
  // the same row. Appending keeps both instead of picking a winner.
  // ONLY twitch's real first-message-ever gets a label. The session-first
  // glow is our own bookkeeping ("first time YOU have seen them since the tab
  // opened") and mellen does not want it announced — it is not a fact about
  // the chatter, it is a fact about your tab, and labelling it competed with
  // the one that matters.
  // filled rows skip striping and carry the name on a black cutout (see fill-family.js)
  const rowFillName = rowFill(div)
  const filledRow = !!rowFillName
  if (filledRow) div.classList.add('hs-filled', `hs-fill-${rowFillName}`)
  // a notice's whole line is its label (as on the site); a chat row keeps a label line above its message
  if (filledRow && div.classList.contains('hs-mc-system')) div.classList.add('hs-row-label')
  let firstMsgLabel = ''
  if (m.isFirstMsg) {
    firstMsgLabel = `<span class="hs-mc-system-text hs-row-label hs-mc-first-label">\u25C7 ${t('mc_main_first_msg')}</span>`
  }
  // USERNOTICE system line (all values go through escapeHtml — same pattern as existing innerHTML above)
  const systemLine =
    (m.systemMsg ? `<span class="hs-mc-system-text">${escapeHtml(m.systemMsg)}</span>` : '') +
    redeemLabel +
    firstMsgLabel
  // Skip the date-format work entirely when the timestamp won't render —
  // formatTimeFromTs builds a Date per call, and at 100msg/s that's free CPU
  // we can give back when timestamps are off.
  const showTs = timestampsEnabled || tabId === 'mentions'
  const ts = showTs ? formatTimeFromTs(m.time) : ''
  const tsHtml = ts ? `<span class="hs-mc-ts">${ts}</span>` : ''
  const msgBody =
    (m.type === 'usernotice' || m.type === 'notice') && !m.text
      ? `${tsHtml}${systemLine}`
      : m.type === 'notice'
        ? `${tsHtml}<span class="hs-mc-text">${processedText}</span>${m.noticeType === 'msg_rejected' ? hsXButtonHtml('hs-x-inline hs-mc-held-x', t('mc_main_dismiss'), `title="${t('mc_main_dismiss')}"`) : ''}`
        : m.isAction
          ? `${tsHtml}${systemLine}${platformBadge}${scBadge}${bitsBadge}${badges}${marksHtml}${avatarHtml}${filledRow ? `<span class="hs-name-cut">${userLink}</span>` : userLink}${hsPlusHtml}${channelSpan} <span class="hs-mc-text" style="color:${sanitizeColor(m.color || '#fff')}">${processedText}</span>${stickerHtml}`
          : `${tsHtml}${systemLine}${platformBadge}${scBadge}${bitsBadge}${badges}${marksHtml}${avatarHtml}${filledRow ? `<span class="hs-name-cut">${userLink}</span>` : userLink}${hsPlusHtml}${channelSpan}: <span class="hs-mc-text">${processedText}</span>${stickerHtml}`
  div.innerHTML = `${replyBar}${msgBody}`
  // Correct emote states based on current inventory + blocked (cached HTML
  // may have stale states). String-includes gate skips the querySelectorAll
  // walk on the >95% of msgs that don't contain heatsync emotes — the gate
  // is a single substring scan, the QSA was iterating div subtree.
  if (processedText.includes('data-source="heatsync"')) reconcileHeatsyncEmoteStates(div)
  // >>id thread refs → open the thread in the overlay feed panel. Mirrors the
  // feed's own per-row handler (social.js:1453) + a switchTab so the panel
  // surfaces when clicked from a chat tab. Class gate skips the QSA on the
  // >99% of messages with no thread ref.
  if (processedText.includes('hs-post-link') && typeof openThread === 'function') {
    div.querySelectorAll('.hs-post-link').forEach((link) => {
      link.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        const targetId = link.dataset.id
        if (!targetId) return
        const target = feedMessages.find((f) => f.base36_id === targetId)
        const threadId = target ? target.reply_to || target.base36_id : targetId
        // Remember where we came from so thread "back" returns here, not the feed.
        threadReturnTab = currentTab === 'feed' ? null : currentTab
        switchTab('feed')
        openThread(threadId, targetId)
      })
    })
  }
  // Row identity for reply + mod actions. YT was excluded here back when a yt
  // message's only id was the videoId (shared by every message in the stream,
  // so it collided) — it isn't anymore: both the DOM tap and the server relay
  // now carry youtube's own per-message innertube id (social.js ytMsg.id), and
  // an id-less message still fails the `m.id` test below. Excluding youtube
  // left its rows with no dataset at all, which silently disabled BOTH the
  // @-mention reply (send-targets ytReplyText) and every yt mod action: the
  // ctx menu reads dataset.msgPlatform, so a yt row read as twitch with an
  // empty channel and the whole mod block was skipped.
  if (m.id) {
    div.dataset.msgId = m.id
    div.dataset.msgUser = m.user
    // True login for mod actions + notice dedup. Twitch display-name ≠ login
    // for non-Latin names (display 田中 / login tanaka123); banning the display
    // name would target a bogus login and silently fail. m.login is the IRC
    // prefix login; kick has no separate display/login so it falls back to user.
    div.dataset.msgLogin = m.login || m.user || ''
    div.dataset.msgChannel = m.channel || ''
    div.dataset.msgPlatform = m.platform || ''
    // Send time (tmi-sent-ts / the platform's own stamp), not receive time —
    // it picks the UTC day in a /search/logs permalink, and the archive stores the
    // same value. Without it a row can be identified but not cited.
    if (m.time) div.dataset.msgTime = String(m.time)
    if (m.ord != null) div.dataset.hsOrd = String(m.ord) // diagnosis: what the row sorted by
    div._hsAt = 1 // marks a row this build drew (see settledEnd in the diff renderer)
    // Mark self-messages so the mod hover toolbar can skip them without
    // re-deriving the viewer's name (which may be null pre-auth). The `isOwn`
    // const above is scoped to the !_renderedHtml branch, so it's undefined
    // when the cached-html path is taken.
    if (isSelf(m)) {
      div.dataset.msgSelf = '1'
    }
    // Thread button — the discoverable way to mint a heatsync thread. The
    // capability already existed as `/op`, a slash command with no UI: 56
    // posts from 2 authors in 41 days, because nobody finds a command they
    // were never shown. `»` mirrors the `>>id` quote syntax the feed already
    // uses. Click drops the composer into quote mode (input.js) — the user
    // still types their own take, they just never have to know /op exists.
    const threadBtn = document.createElement('button')
    threadBtn.className = 'hs-mc-thread-btn'
    threadBtn.textContent = '»'
    threadBtn.title = t('mc_msg_quote_thread') || 'quote into a thread'
    div.appendChild(threadBtn)
  }
  // Reply-thread linkage for hover highlight
  if (m.replyTo) {
    if (m.replyTo.id) div.dataset.replyId = m.replyTo.id
    if (m.replyTo.threadId) div.dataset.replyThreadId = m.replyTo.threadId
  }
  // Inline media — a single lightweight embed (direct img/video, a youtube
  // thumbnail, or a server-resolved rich card) below the text. NEVER a live
  // iframe: chat is high-volume and runs on low-RAM hardware. Appended as a
  // sibling node (outside the cached _renderedHtml) so toggling the setting
  // takes effect on the next rerender. Lazy-loaded, error-guarded, capped.
  if (
    mediaEmbedsEnabled &&
    !m.cleared &&
    m.text &&
    m.type !== 'usernotice' &&
    m.type !== 'notice' &&
    typeof extractChatEmbed === 'function'
  ) {
    const embedHtml = extractChatEmbed(m.text, { partialLinks: linksEnabled })
    if (embedHtml) {
      const holder = document.createElement('div')
      holder.className = 'hs-mc-media-wrap'
      holder.insertAdjacentHTML('afterbegin', embedHtml)
      div.appendChild(holder)
      if (typeof resolvePendingFeedEmbeds === 'function') resolvePendingFeedEmbeds(holder)
      if (typeof attachFeedFallbacks === 'function') attachFeedFallbacks(holder)
      foldEmbeddedMediaUrl(div, holder)
    }
  }
  return div
}

// A pasted image posts as its URL — that IS the wire payload, chat has no
// attachments. Showing the url AND the picture it renders is noise, so fold
// the url away once its own media is on screen. Direct media only: the
// embed builder marks those with data-hs-src-url, and a link CARD is
// deliberately left alone, because there you're being asked to click through
// and you should get to see where to.
//
// The url goes only when the picture has actually PAINTED — on load, never on
// insert. Hiding it up front and restoring it on error reads as equivalent and
// isn't: chat images are loading="lazy", so one rendered out of view never
// fetches, never errors, and never fires anything at all. That row would have
// sat there as a blank line, url hidden behind an image that was never coming,
// until you happened to scroll it into view. Waiting for the load event has no
// such hole — nothing is hidden until its replacement is on screen.
function foldEmbeddedMediaUrl(row, holder) {
  const media = holder.querySelector('[data-hs-src-url]')
  const src = media?.dataset.hsSrcUrl
  if (!src) return
  // Match on href, not on the visible text: chat truncates long urls for
  // display, and linkifyPartialLinks synthesizes an href for a url that was
  // never fully typed. The href is the only field that means the same thing
  // in both cases.
  const link = Array.from(row.querySelectorAll('a.hs-mc-link')).find(
    (a) => a.getAttribute('href') === src || a.href === src,
  )
  if (!link) return
  const img = media.querySelector('img')
  if (!img) return
  const fold = () => link.classList.add('hs-mc-url-folded')
  // Already decoded — a re-render of a row whose image is in cache.
  if (img.complete && img.naturalWidth > 0) fold()
  else img.addEventListener('load', fold, { once: true })
}

// LRU cache for processYtEmotes' combined regex. Pattern key is the joined
// alt-text alternation; same emote-set across many messages → same key →
// one RegExp compile per unique set instead of per message.
const _YT_EMOTE_REGEX_CACHE_MAX = 64
const _ytEmoteRegexCache = new Map()
function _getYtCombinedRegex(joined) {
  const hit = _ytEmoteRegexCache.get(joined)
  if (hit) {
    // LRU touch — move to most-recent
    _ytEmoteRegexCache.delete(joined)
    _ytEmoteRegexCache.set(joined, hit)
    return hit
  }
  const re = new RegExp(`(<[^>]*>)|(${joined})`, 'g')
  _ytEmoteRegexCache.set(joined, re)
  if (_ytEmoteRegexCache.size > _YT_EMOTE_REGEX_CACHE_MAX) {
    const oldest = _ytEmoteRegexCache.keys().next().value
    _ytEmoteRegexCache.delete(oldest)
  }
  return re
}

// Process YouTube emotes (inline emoji images from innertube)
// preEscaped=true when input is already HTML-escaped (chained after processEmotes)
function processYtEmotes(text, emotes, preEscaped) {
  if (!emotes || emotes.length === 0) return preEscaped ? text : escapeHtml(text)

  let result = preEscaped ? text : escapeHtml(text)

  // Build replacement map: escaped alt text → img HTML
  const replacements = new Map()
  const altPatterns = []
  for (const emote of emotes) {
    const url = typeof emote.url === 'string' ? emote.url.trim() : ''
    const alt = typeof emote.alt === 'string' ? emote.alt : ''
    if (!alt || !url || !(url.startsWith('http') || url.startsWith('//'))) continue
    // Don't skip names with `<` — escapeHtml() handles them correctly and emotes
    // like `<3`, `<3` need to render. (Alt is set via escaped attribute below.)
    const escaped = escapeHtml(alt)
    if (replacements.has(escaped)) continue
    const imgHtml = `<img src="${escapeHtml(url)}" alt="${escaped}" class="hs-mc-emote" loading="lazy" decoding="async" style="height:1.2em;vertical-align:middle;" />`
    replacements.set(escaped, imgHtml)
    altPatterns.push(escaped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  }

  // Single-pass replacement that skips HTML tags — prevents matching inside
  // attributes of already-rendered emote/emoji spans from processEmotes.
  // RegExp compile is the slow step: cached by joined pattern so the same
  // emote-set across many YT messages reuses a single compiled instance.
  if (altPatterns.length > 0) {
    const combined = _getYtCombinedRegex(altPatterns.join('|'))
    result = result.replace(combined, (match, htmlTag) => {
      if (htmlTag) return htmlTag
      return replacements.get(match) || match
    })
  }

  // Clean up escaped HTML img tag fragments (from emotes with HTML alt text)
  if (result.includes('&lt;img')) {
    // biome-ignore lint/correctness/noEmptyCharacterClassInRegex: [^] is the intentional "any char incl newline" idiom for stripping multi-line img fragments
    result = result.replace(/&lt;img\b(?:[^]*?(?:\/&gt;|&gt;)|[^<]*)/g, '')
  }
  return result
}

// A mentioned user who hasn't spoken in this channel yet has no entry in
// knownColors, so their @mention / reply link would render flat white. Resolve
// their color asynchronously (heatsync → twitch → hash palette, same as input
// chips) and repaint every visible mention/reply anchor for them in place.
const _mentionColorPending = new Set()
function resolveMentionColor(lower) {
  if (!lower || _mentionColorPending.has(lower)) return
  if (typeof hsResolveUserColor !== 'function') return
  _mentionColorPending.add(lower)
  hsResolveUserColor(lower)
    .then((c) => {
      _mentionColorPending.delete(lower)
      let esc
      try {
        esc = CSS.escape(lower)
      } catch {
        esc = lower
      }
      const anchors = document.querySelectorAll(
        `a.hs-mc-mention[data-username="${esc}"], a.hs-mc-reply-user[data-username="${esc}"]`,
      )
      if (c) {
        const safe = sanitizeColor(knownColors.get(lower) || c)
        anchors.forEach((a) => {
          // A HeatSync paint or a 7TV paint cosmetic outranks a flat color —
          // never overwrite either. hasResolvedHsPaint MUST be checked here
          // too (not just getMcPaintStyle/7TV): applyHsPaintToElement clears
          // this exact element's style attribute when it paints it, and if
          // this async color resolve lands afterward it would silently
          // re-add an inline style that outranks the class-based paint by
          // specificity — stomping the paint precedence the class relies on.
          const uid = a.dataset.uid
          if (uid && (getMcPaintStyle(uid) || hasResolvedHsPaint(uid))) return
          a.style.color = safe
        })
      }
      // Twitch uid piggybacked off the same /api/profile/ lookup hsResolveUserColor
      // just made (hsResolveUserId reads the cache it populated — no extra
      // request). Render time had no uid for this name; close the loop now:
      // stamp it on every live anchor, index them so the cosmetics/paint
      // batches (which only know about indexed elements) can retro-paint,
      // and remember it in knownUserIds so the NEXT render of this name
      // hits synchronously instead of taking this async detour again.
      const resolvedUid = typeof _hsUserIdCache !== 'undefined' ? _hsUserIdCache.get(lower) || null : null
      if (!resolvedUid) return
      for (const a of anchors) {
        if (a.dataset.uid) continue // already stamped/indexed (or render-time known)
        // Id-space guard: this uid is Twitch-resolved (twitch_user_id from the
        // profile API), so only stamp anchors that belong to a twitch-platform
        // message — a same-named Kick/YouTube chatter must never inherit a
        // Twitch stranger's uid/cosmetics.
        const row = a.closest('.hs-mc-msg')
        if ((row?._hsMsg?.platform || 'twitch') !== 'twitch') continue
        a.dataset.uid = resolvedUid
        let ms = _mentionIndex.get(resolvedUid)
        if (!ms) {
          ms = new Set()
          _mentionIndex.set(resolvedUid, ms)
        }
        ms.add(a)
        // Keep the row's cached mention list (built once by _indexMessageDiv via
        // querySelectorAll('[data-uid]')) in sync — it excluded this anchor when
        // first indexed because data-uid was empty then, so _unindexMessageDiv's
        // cleanup would otherwise never find it here.
        if (Array.isArray(row?._hsMentionEls) && !row._hsMentionEls.includes(a)) {
          row._hsMentionEls.push(a)
        }
      }
      try {
        setKnownColor(lower, knownColors.get(lower) || c || '#fff', resolvedUid, 'twitch', false)
      } catch {}
      queueMcCosmeticsLookup(resolvedUid)
    })
    .catch(() => {
      _mentionColorPending.delete(lower)
    })
}
// Sanitized color for a mentioned user. Returns a known color synchronously
// (seen this session, or cached from a prior lookup); otherwise queues the
// async resolve+repaint and falls back to white until it lands.
function mentionColor(lower) {
  let c = knownColors.get(lower)
  if (!c && typeof _hsUserColorCache !== 'undefined') c = _hsUserColorCache.get(lower) || null
  if (c) return sanitizeColor(c)
  resolveMentionColor(lower)
  return '#fff'
}

// Everyday words that are never a bare mention, even when someone with that
// login is chatting. "bruh", "what", "yeah", "mods" and "based" are all real
// twitch accounts — without this, one of them speaking anywhere turns every
// ordinary use of the word into a colored link across every channel. The
// bare form is a convenience; @name stays the explicit way to mention them,
// and it is unaffected by this list. Contraction stems ("don", "isn", "didn")
// are here because the regex's boundary set includes the apostrophe, so
// "don't" offers up "don" as a candidate name.
const BARE_MENTION_STOPWORDS = new Set(
  `the and you are for not but all any can has had her him his how its new now old see two way who did let put say she too use man own why yes yet off got run set try war win act add age air bad big end few
     that was with they this have from one were when what where whats which who whom while your yours yourself said there their theirs them these those some such here huh hmm oof will other about out many then would make like into more could than been being both people may down get come made over only just know take well very want because give most also back after work first even need much right think thing things does don isn wasn didn doesn couldn wouldn shouldn won ain dont cant wont thats hes shes youre theyre youve ive lets gonna wanna gotta kinda sorta before between during through under until against having each
     lol lmao lmfao omg wtf wth ngl tbh imo imho fyi idk ikr brb gtg yeah yea yep yup nah nope sure same true real fake bruh bro dude guys chat mods mod stream streamer game good nice best worst cool damn holy actually literally basically honestly seriously bot bots based cringe insane crazy sick wild huge small pog poggers kek lul ggs wow hey hello thanks thank please sorry congrats welcome night morning today tomorrow yesterday time year years day days week hour min sec guy girl kid dog cat food life love hate live dead lose lost play played playing watch watching look looks looking seen saw tell told talk ask asked keep stop start help wait coming going went gone still again never always ever maybe probably definitely absolutely`
    .split(/\s+/)
    .filter(Boolean),
)

// The chatter a typed @name means: itself when that name has spoken (or is a
// known heatsync account), else the one chatter it differs from only by underscores.
// `@sleepyshaman` for `sleepyshaman___` is the same person to everyone
// reading, and drawing it in another color said otherwise. A key two chatters
// share maps to null, so an ambiguous tag stays exactly what was typed.
let _looseNames = null
let _looseNamesSize = -1
function taggedName(lower) {
  // Not knownColors: mentionColor writes a hash color there for every @word,
  // so the typed name would count as known after its first render.
  if (_ucDisplay.has(lower) || (typeof _hsUserIdCache !== 'undefined' && _hsUserIdCache.get(lower))) return lower
  if (!_looseNames || _looseNamesSize !== _ucDisplay.size) {
    _looseNames = new Map()
    _looseNamesSize = _ucDisplay.size
    for (const name of _ucDisplay.keys()) {
      const k = name.replace(/_/g, '')
      _looseNames.set(k, _looseNames.has(k) ? null : name)
    }
  }
  return _looseNames.get(lower.replace(/_/g, '')) || lower
}

// Highlight @mentions and bare known usernames in rendered chat HTML.
// Splits on tags so substitution only happens in text segments.
// Applies 7TV paint cosmetics if the mentioned user's userId + paint are cached.
function highlightMentionsInHtml(html, platform) {
  // Twitch is the implicit default platform — m.platform is UNDEFINED on
  // twitch rows (same convention as buildMessageDiv's `!m.platform ||
  // m.platform === 'twitch'`). Without this, userKey(lower, undefined)
  // never matches the 'twitch'-scoped knownUserIds entries and every
  // twitch mention renders uid-less (unpaintable).
  platform = platform || 'twitch'
  if (!html || (!html.includes('@') && knownColors.size === 0)) return html
  // Skips whole <a>…</a> spans, not just tags — a bare word or @handle inside
  // an already-linkified url must not be re-wrapped, or the nested <a> splits
  // the link (see highlightHashtagsInHtml for the same bug, reported live).
  return outsideTags(
    html,
    /(^|[\s.,!?;:()[\]"'])(@?)([A-Za-z0-9_]{3,25})(?=$|[\s.,!?;:()[\]"'])/g,
    (m, lead, at, name) => {
      const lower = at ? taggedName(name.toLowerCase()) : name.toLowerCase()
      // A bare word only becomes a mention when the name belongs to someone
      // we've actually HEARD SPEAK. knownColors answers "what color", not
      // "is this a person": every @word in chat runs through mentionColor →
      // hsResolveUserColor, which always returns a color (falling back to
      // twitch's hash palette even for logins that don't exist) and writes it
      // into knownColors. So one person typing "@you" — not even a real
      // account — made the literal word "you" a known "user" for the rest of
      // the session, and every plain "you" in every channel rendered as a
      // colored mention link. _ucDisplay is the lowercase mirror of
      // usernameCache, written only by addUsername from real sender paths,
      // so it answers the question knownColors can't. Both are required:
      // color-only or spoke-only would each widen what highlights today.
      const known = knownColors.has(lower) && _ucDisplay.has(lower) && !BARE_MENTION_STOPWORDS.has(lower)
      if (!at && !known) return m
      // @mentions resolve a color even for users we haven't seen (async);
      // bare known names already have one in knownColors.
      const color = at ? mentionColor(lower) : sanitizeColor(knownColors.get(lower) || '#fff')
      const safeName = escapeHtml(name)
      const safeLower = escapeHtml(lower)
      // Platform-scoped lookup — a twitch and kick chatter sharing this
      // lowercase name must never trade 7TV paints/cosmetics. Falls back
      // to the async-resolved uid cache (survives when knownUserIds was
      // never seeded this session — e.g. page reload restored the color
      // cache but the user hasn't chatted yet).
      const uid =
        knownUserIds.get(userKey(lower, platform)) ||
        (platform === 'twitch' && typeof _hsUserIdCache !== 'undefined' ? _hsUserIdCache.get(lower) || '' : '')
      // No uid yet: fire the profile resolve for its uid side-effect even
      // when the COLOR is already cached — mentionColor short-circuits on
      // known colors and would otherwise never fetch the uid, leaving
      // this mention unpaintable forever. Deduped via _mentionColorPending.
      if (!uid && platform === 'twitch') resolveMentionColor(lower)
      let style = `color:${color}`
      let uidAttr = ''
      let mentionCls = 'hs-mc-user hs-mc-mention hs-mention'
      let splitAttr = ''
      let inner = `${at}${safeName}`
      if (uid) {
        uidAttr = ` data-uid="${escapeHtml(uid)}"`
        if (mcCosmeticsNeedLookup(uid)) queueMcCosmeticsLookup(uid)
        // HeatSync paint wins over 7TV — same precedence rule as the
        // sender username / reply-context bar.
        const hsPaint = hsPaintRender(uid, `${at}${name}`)
        if (hsPaint) {
          mentionCls += ` ${hsPaint.cls}`
          splitAttr = hsPaint.splitAttr
          inner = hsPaint.html
          // Mount stamp instead of a color decl — phase-locks this copy
          // to the same wall-clock frame as every other copy of the paint.
          style = `--hsp-t:${paintPhaseNow()};${hsNameColourDecl(color)}`
        } else {
          const paint = getMcPaintStyle(uid)
          if (paint) style = paint
        }
      }
      // No plus-tenure "+" on an inline @mention: the token is a
      // sender-identity mark (shown beside the sender before the colon),
      // not part of a name typed inside message content. The sender's own
      // name and the reply-context header still carry it.
      // data-platform is what the hover card reads to disambiguate a name
      // that exists on more than one platform. Without it the tooltip called
      // /api/profile/<name> with no platform and the server picked whichever
      // identity it liked — hovering @nl_kripp in twitch chat could answer
      // with a youtube shadow user, and the card then rendered thin because
      // followage/banner/pronouns all key off the twitch id it never got.
      // Use the same platform the uid lookup two blocks up already uses, so
      // the mention's identity and its hover card agree by construction.
      return `${lead}<a href="https://heatsync.org/user/${encodeURIComponent(lower)}" target="_blank" rel="noopener noreferrer" class="${mentionCls}" data-username="${safeLower}" data-platform="${escapeHtml(platform)}"${uidAttr}${splitAttr} style="${escapeHtml(style)}">${inner}</a>`
    },
  )
}

// DOM-node twin of highlightHashtagsInHtml for surfaces that build via text
// nodes instead of innerHTML (archive viewer, pinned tab, search results).
// Same regex/route/class so #tags read identically everywhere. stopPropagation
// keeps a tag click from also firing a row-level handler (search/pinned rows).
function appendTextWithHashtags(parent, text) {
  const s = String(text == null ? '' : text)
  if (!s.includes('#')) {
    if (s) parent.appendChild(document.createTextNode(s))
    return
  }
  const parts = s.split(/(#[a-zA-Z][a-zA-Z0-9_]{1,29})\b/g)
  for (const p of parts) {
    if (!p) continue
    if (p[0] === '#' && /^#[a-zA-Z][a-zA-Z0-9_]{1,29}$/.test(p)) {
      const tag = p.slice(1)
      const a = document.createElement('a')
      a.className = 'hs-hashtag'
      a.href = `https://heatsync.org/feed/tags/${encodeURIComponent(tag)}`
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
      a.dataset.tag = tag
      a.textContent = `#${tag}`
      a.addEventListener('click', (e) => e.stopPropagation())
      parent.appendChild(a)
    } else {
      parent.appendChild(document.createTextNode(p))
    }
  }
}

// Magenta #hashtags in chat — same pattern + link target as the feed so tags
// are consistent on every surface. Splits on tags so attrs/img/<a> aren't touched.
function highlightHashtagsInHtml(html) {
  if (!html?.includes('#')) return html
  // outsideTags skips whole <a>…</a> spans, not just tags. A url fragment
  // like ".../2026-07-22?m=…#mb812bf1a-46d8-…" is tag-shaped, and wrapping it
  // put an <a> inside an <a> — invalid html5, so the browser closes the outer
  // link at that point: the fragment rendered magenta and the rest of the url
  // fell out of the link entirely as plain text.
  // (?<!&) — seg is already escaped, so a #tag inside an HTML entity
  // (&#x27; → #x27, &#39; → #39) must NOT match, else an apostrophe renders
  // as a bogus magenta tag.
  return outsideTags(html, /(?<!&)#([a-zA-Z][a-zA-Z0-9_]{1,29})\b/g, (_m, tag) => {
    return `<a href="https://heatsync.org/feed/tags/${encodeURIComponent(tag)}" target="_blank" rel="noopener noreferrer" class="hs-hashtag" data-tag="${escapeHtml(tag)}">#${escapeHtml(tag)}</a>`
  })
}

// Yellow >>id HeatSync thread references in chat — same regex, id format, span
// and yellow style the social feed already ships (social.js renderFeedContent),
// so a thread ref reads identically on every surface. Emits the feed's
// .hs-post-link span (NOT an <a>) so the click opens the thread inside the
// overlay feed panel rather than a new tab — wired per-row in buildMessageDiv.
// Text is HTML-escaped here, so a typed ">>" arrives as "&gt;&gt;".
function highlightThreadRefsInHtml(html) {
  // Gate on the doubled forms — text is HTML-escaped here so a typed ">>" is
  // "&gt;&gt;" (no bare ">"); also accept raw ">>" belt-and-suspenders.
  if (!html || (!html.includes('&gt;&gt;') && !html.includes('>>'))) return html
  // Anchor-aware for the same reason as the two passes above.
  return outsideTags(html, /(?:&gt;&gt;|>>)(\w{1,6})/g, (_m, id) => {
    const paddedId = id.padStart(6, '0')
    const displayId = id.replace(/^0+/, '') || '0'
    return `<span class="hs-post-link" data-id="${escapeHtml(paddedId)}" style="cursor:pointer">&gt;&gt;${escapeHtml(displayId)}</span>`
  })
}

// Scroll helper — reused by both renderMessages and appendMessage
function scrollMsgsToBottom(msgsEl) {
  const newBtn = document.getElementById('hs-mc-new-msgs')
  newMessageCount = 0
  if (newBtn) newBtn.style.display = 'none'
  if (isScrolledUp) return
  // Single sync write — reading scrollHeight forces layout flush so the
  // new content's height is reflected before we set scrollTop. The +rAF
  // catches the rare case where layout settles a frame later (e.g. font
  // metrics changing post-decode). Late image loads / box changes are
  // covered by the capture-phase load+error delegation and ResizeObserver
  // wired in the scroll-listener block above — no need to scan
  // .hs-mc-emote and attach per-image listeners (was O(N) per call,
  // duplicated by delegation, and leaked listeners on rapid bursts).
  isProgrammaticScroll = true
  msgsEl.scrollTop = msgsEl.scrollHeight + 10000
  if (document.hidden || _rafStarved) {
    // No frames coming (believed-hidden or starved-rAF, any flavor): settle
    // synchronously instead of leaving the programmatic flag up for a
    // throttled timer's lifetime — a raised flag eats the user's own
    // scroll events.
    isProgrammaticScroll = false
  } else {
    // rafOrTimeout, not bare rAF: if starvation begins right here, the
    // watchdog still lowers the programmatic flag instead of leaving it
    // eating user scrolls until the next real frame.
    rafOrTimeout(() => {
      if (!isScrolledUp) msgsEl.scrollTop = msgsEl.scrollHeight + 10000
      isProgrammaticScroll = false
    })
  }
}

// rAF that still fires when chrome believes the tab hidden AND a user
// signal (window focus / BG-oracle wedge) says someone is looking. rAF is
// frozen in believed-hidden, so every render/scroll callback riding a bare
// rAF silently never fires there and rows pile up below a stuck viewport.
// The timeout fallback engages ONLY in that user-looking state: a genuinely
// hidden background tab must keep the free rAF pause (a timer fallback
// there would burn 1Hz renders in every backgrounded tab — measured).
//
// Inverse wedge: document.hidden reads FALSE but rAF is frozen — chrome
// occlusion-throttles a covered window without ever delivering the
// visibilitychange (wayland/tiling WMs lose the flip; this failure ships
// zero 'vis' events to the diag ring). A bare rAF then swallows the
// coalesced render forever while the user stares at a frozen pane, and the
// BG-oracle nudge can't help (it only acts when document.hidden is true).
// So every believed-visible rAF races a watchdog timer: rAF wins → timer
// cleared, zero cost. Timer wins → rAF is starved regardless of what the
// visibility API claims; render on a timer cadence — fast when focused,
// 1Hz when not — and keep a probe rAF out so the first real frame ends
// the episode.
function rafOrTimeout(fn) {
  // A popout is a window made to be read, often sitting unfocused beside a
  // game or a stream. Chrome slows (or never runs) rAF there, and the
  // starvation fallback is a 1s timer — chat then arrives as one lump a
  // second and any stall stretches into a visible freeze. Layout work never
  // needed a frame, so a popout just uses a short timer.
  if (document.body?.classList.contains('hs-popout')) {
    cleanup.setTimeout(fn, 16)
    return true
  }
  if (document.hidden) {
    if (document.hasFocus() || _visWedged) {
      cleanup.setTimeout(fn, 16)
      return true
    }
    return cleanup.raf(fn) // genuinely hidden — keep the free rAF pause
  }
  if (_rafStarved) {
    cleanup.setTimeout(fn, document.hasFocus() ? 150 : 1000)
    _probeRafRecovery()
    return true
  }
  let settled = false
  const rafId = cleanup.raf(() => {
    if (settled) return
    settled = true
    cleanup.clearTimeout(watchdog)
    fn()
  })
  const watchdog = cleanup.setTimeout(() => {
    if (settled) return
    settled = true
    cleanup.cancelRaf(rafId)
    _rafStarved = true
    hsDiagLog('raf_starved', { focus: document.hasFocus() })
    _probeRafRecovery()
    fn()
  }, 300)
  return true
}
// One outstanding bare rAF while starved — it firing is proof frames are
// back (window uncovered / occlusion lifted), so the next render returns to
// the free rAF path.
function _probeRafRecovery() {
  if (_rafProbePending) return
  _rafProbePending = true
  cleanup.raf(() => {
    _rafProbePending = false
    if (_rafStarved) {
      _rafStarved = false
      hsDiagLog('raf_recovered')
    }
  })
}

// Coalesced scroll-pin for the single-message append path. Calling
// scrollMsgsToBottom inline per message forced a synchronous layout flush
// (read scrollHeight, write scrollTop) on every message — 60 forced reflows/s
// on a busy solo tab. Batching to one rAF pins once per frame (before paint,
// so no visible lag) and reads layout once instead of per message.
let _scrollPinRaf = null
let _lastSyncPin = 0
function scheduleScrollPin(msgsEl) {
  if (_scrollPinRaf) return
  if (_rafStarved || (document.hidden && (document.hasFocus() || _visWedged))) {
    // Believed-hidden but still appending (focus/wedge override): rAF is
    // dead and timers clamp to ~1s, which reads as "chat stuck at the
    // bottom". Pin synchronously at ≥100ms spacing — bounded reflow cost,
    // fluid enough to read — with a clamped trailing timer as backstop.
    const now = Date.now()
    if (now - _lastSyncPin >= 100) {
      _lastSyncPin = now
      scrollMsgsToBottom(msgsEl)
      return
    }
    _scrollPinRaf = true
    cleanup.setTimeout(() => {
      _scrollPinRaf = null
      _lastSyncPin = Date.now()
      scrollMsgsToBottom(msgsEl)
    }, 120)
    return
  }
  // rafOrTimeout, not bare rAF: starvation beginning while this pin is
  // outstanding would otherwise leave _scrollPinRaf truthy forever and
  // every future pin skipped.
  _scrollPinRaf = rafOrTimeout(() => {
    _scrollPinRaf = null
    scrollMsgsToBottom(msgsEl)
  })
}

// Incremental append for single messages on the active tab (hot path)
// Returns true if handled, false if full rebuild needed
// Check if a tab has multiple platform sources active (needs fair merge)
let _multiPlatformRenderTimer = null
let _multiPlatformRenderAt = 0
// Ask for the real render on the next frame (one request at a time).
function scheduleMergedRender() {
  // The pending handle is only trusted for 500ms: a window the browser
  // calls hidden never runs its rAF, and a handle that never clears would
  // swallow every later message here (frozen pane until a full repaint).
  const nowMp = Date.now()
  if (!_multiPlatformRenderTimer || nowMp - _multiPlatformRenderAt > 500) {
    _multiPlatformRenderAt = nowMp
    let ran = false
    const run = () => {
      if (ran) return
      ran = true
      _multiPlatformRenderTimer = null
      renderMessages(currentTab)
    }
    _multiPlatformRenderTimer = rafOrTimeout(run)
    cleanup.setTimeout(run, 500)
  }
}
function isMultiPlatformTab(tabId) {
  if (tabId === 'live') {
    const curCh = getLiveChannel()
    let count = 0
    if (curCh && irc?.getCount(curCh)) count++
    if (curCh && kickChat?.getCount(curCh)) count++
    if (channelYtMessages.get('__live_yt_auto__')?.length || 0) count++
    if (count < 2) {
      // Also check config-linked platforms (O(1) via the prebuilt lookup)
      const lk = getChannelLookup()
      const linked = lk.twitch.get(curCh) || lk.kick.get(curCh)
      if (linked?.kick && kickChat?.getCount(linked.kick)) count++
      if (linked?.youtube && channelYtMessages.get(linked.id)?.length) count++
    }
    return count > 1
  }
  const ch = getChannelById(tabId)
  if (!ch) return false
  let count = 0
  if (ch.twitch && irc?.getCount(ch.twitch)) count++
  if (ch.kick && kickChat?.getCount(ch.kick)) count++
  // own linked YT only — __live_yt_auto__ no longer merges into per-channel
  // tabs (mirrors renderMessages bleed fix)
  const ytMsgs = channelYtMessages.get(tabId)?.length || 0
  if (ytMsgs) count++
  return count > 1
}

// ─── render-time content filters ──────────────────────────────────────
// Hidden at render, kept in buffers — toggling off un-hides retroactively.
const _BOT_NAMES = new Set([
  'nightbot',
  'streamelements',
  'moobot',
  'fossabot',
  'streamlabs',
  'wizebot',
  'botrix',
  'sery_bot',
  'soundalerts',
  'pokemoncommunitygame',
  'kofistreambot',
  'blerp',
])
// Read the content-filter settings once per render pass — isMsgFiltered
// runs per message in the render hot path (up to 1500 msgs per render).
function _filterFlags() {
  return {
    bots: getSetting('hideBots'),
    cmds: getSetting('hideCommands'),
    dups: getSetting('hideDuplicates'),
    dim: dimTimeouts,
  }
}
// The live-DOM half of the same decision, for rows already on screen when a
// mod acts. The render filter above is the durable answer; this makes it
// immediate instead of "next time anyone says anything".
function markClearedRow(row, title) {
  if (!row) return
  if (!dimTimeouts) {
    // Exactly what the next render pass would do — isMsgFiltered drops it.
    row.remove()
    return
  }
  row.classList.add('hs-mc-msg-cleared')
  if (title) row.dataset.clearedReason = title
}
function isMsgFiltered(m, f) {
  if (m?.type === 'notice' && m.resolved) return true // a held send that has since posted
  if (!m || m.type === 'stream-event' || m.type === 'automod-hold' || m.inlineNotifType) return false
  const u = m.user ? m.user.toLowerCase() : ''
  if (isSelf(m)) return false // never hide own messages
  if (u && f.bots && _BOT_NAMES.has(u)) return true
  // `dim timed-out messages` offers two treatments and only one of them was
  // implemented in the overlay: with it OFF, a moderated message was neither
  // dimmed NOR hidden — it stayed fully readable, the opposite of what
  // "50% opacity instead of hiding" promises. Hiding belongs here, at the
  // render filter, because this is the one platform-blind place every
  // buffer's messages pass through — the dim path is patched into the live
  // DOM from six separate call sites and youtube's, added later, never
  // checked the setting at all.
  if (m.cleared && !f.dim) return true
  if (typeof m.text !== 'string') return false
  if (f.cmds && m.text.charCodeAt(0) === 33) return true
  return false
}
const _lastMsgTextByTab = new Map()

// Cached emote imgs are already `complete` when a row mounts, so their `load`
// event never fires and the msgsEl load listener never snaps them — meaning
// hsSnapEmoteBox's integer-width pin AND its modifier space reservation are
// skipped, leaving wide/tall-modified cached emotes (e.g. a channel "Cabge
// ffzW") overlapping. Enqueue every already-complete emote img so the snap
// runs; non-cached imgs still snap via their load event. hsSnapEmoteBox is
// rAF-batched + idempotent, so this is cheap even in a bulk rebuild.
// Reserve horizontal/vertical space for a wide/tall-modified emote sized to its
// REAL width (fixes runs of "Cabge ffzW" overlapping). offsetWidth is the
// untransformed layout width; the visual is that × scale, so each side needs
// width*(scale-1)/2. Overrides the static 28px-based fallback margins.
// Takes pre-read dimensions — lets the batch caller read all sizes first,
// THEN write all margins, instead of read→write→read→write (which forces a
// layout reflow per wrapper on the per-message append hot path).
function _reserveModWrapSized(wrap, w, h) {
  const sx = Math.abs(parseFloat(wrap.dataset.hsModSx) || 1)
  const sy = Math.abs(parseFloat(wrap.dataset.hsModSy) || 1)
  if (sx > 1 && w) {
    const m = `${Math.round((w * (sx - 1)) / 2)}px`
    wrap.style.setProperty('margin-left', m, 'important')
    wrap.style.setProperty('margin-right', m, 'important')
  }
  if (sy > 1 && h) {
    const m = `${Math.round((h * (sy - 1)) / 2)}px`
    wrap.style.setProperty('margin-top', m, 'important')
    wrap.style.setProperty('margin-bottom', m, 'important')
  }
}
let _hsModReserveRO = null
function _snapCompleteEmotes(root) {
  if (!root?.querySelectorAll) return
  if (typeof hsSnapEmoteBox === 'function') {
    for (const eimg of root.querySelectorAll('img.hs-mc-emote')) {
      if (eimg.complete && eimg.naturalWidth) hsSnapEmoteBox(eimg)
    }
  }
  // Modifier reservation via ResizeObserver — fires exactly when the wrapper
  // gets a real size (img decoded, incl. cached imgs whose `load` never fires),
  // so it never depends on the load event or which render path mounted the row.
  const mods = root.querySelectorAll('.hs-mc-emote-wrapper[data-hs-mod-sx]')
  if (!mods.length) return
  if (!_hsModReserveRO && typeof ResizeObserver !== 'undefined') {
    _hsModReserveRO = new ResizeObserver((entries) => {
      for (const e of entries) {
        const box = e.borderBoxSize?.[0]
        const w = box ? box.inlineSize : e.contentRect.width
        const h = box ? box.blockSize : e.contentRect.height
        if (w) {
          _reserveModWrapSized(e.target, w, h)
          _hsModReserveRO.unobserve(e.target)
        }
      }
    })
    if (typeof cleanup !== 'undefined' && cleanup.trackObserver) cleanup.trackObserver(_hsModReserveRO)
  }
  // Batch: read every wrapper's size FIRST (one reflow), then write all margins
  // + observe — never interleave a layout read after a style write in the loop.
  const sized = []
  for (const wrap of mods) sized.push([wrap, wrap.offsetWidth, wrap.offsetHeight])
  for (const [wrap, w, h] of sized) {
    _reserveModWrapSized(wrap, w, h) // immediate if already sized
    if (_hsModReserveRO) _hsModReserveRO.observe(wrap) // and again once it is
  }
}

// ── optimistic youtube send ──────────────────────────────────────────────────
// YouTube takes ~2s to accept a post and echo it back, so your own line would sit unseen that long.
// The "sending" row is DOM only — never in a buffer, never counted, never through the echo dedup — so
// it cannot be the second copy of anything. It leaves the instant the real echo is about to render,
// the send fails, ten seconds pass, or the pane repaints (a rebuild comes from the buffers, which
// never held it). Every exit removes it; none depends on another.
const _ytSendingRows = [] // oldest first: { id, text, div, timer }
// The signed-in account's name: the chip beside YouTube's own input, in its chat frame (same origin).
const ytSelfName = () => {
  try {
    const doc = document.querySelector('ytd-live-chat-frame#chat iframe')?.contentDocument
    return doc?.querySelector('yt-live-chat-message-input-renderer yt-live-chat-author-chip')?.textContent?.trim() || ''
  } catch (_) {
    return ''
  }
}
const _ytEchoKey = (t) =>
  String(t ?? '')
    .replace(/\s+/g, ' ')
    .trim()

function showYtSendingRow(id, text) {
  try {
    const msgsEl = document.getElementById('hs-mc-messages')
    const name = ytSelfName()
    if (!name || !msgsEl || isScrolledUp || editingChannel || document.hidden) return
    const msg = {
      user: name,
      text,
      color: '#ff0000',
      time: Date.now(),
      ord: visualNowOrd(),
      platform: 'youtube',
      channel: 'youtube',
      msgType: 'text',
      emotes: [],
    }
    const div = buildMessageDiv(msg, currentTab)
    if (!div) return
    div.dataset.hsSending = id
    stampZebra(div, msg, msgsEl.lastElementChild)
    msgsEl.querySelector('.hs-mc-empty')?.remove()
    msgsEl.appendChild(div)
    scheduleScrollPin(msgsEl)
    const row = { id, text: _ytEchoKey(text), div, timer: null }
    row.timer = cleanup.setTimeout(() => clearYtSendingRow(id), 10000)
    _ytSendingRows.push(row)
  } catch (_) {}
}

function clearYtSendingRow(id) {
  const i = _ytSendingRows.findIndex((r) => r.id === id)
  if (i < 0) return
  const [row] = _ytSendingRows.splice(i, 1)
  if (row.timer) cleanup.clearTimeout(row.timer)
  row.div.remove()
}

// The real echo of a line is about to render: its "sending" twin goes first (oldest match, so two
// identical sends take one each).
function claimYtSendingRow(text) {
  if (!_ytSendingRows.length) return
  const key = _ytEchoKey(text)
  const row = _ytSendingRows.find((r) => r.text === key)
  if (row) clearYtSendingRow(row.id)
}

function appendMessage(msg, tabId) {
  if (editingChannel) return false
  // Hidden by share-dedupe (real USERNOTICE replaced our synthetic)
  if (msg?.hidden) return true
  // Skip live append while profile card is open — buffer keeps the msg, restored on close
  if (typeof activeProfileCard !== 'undefined' && activeProfileCard) return true
  if (hsPanePanelOpen()) return true // a confirm panel covers the pane; close repaints
  // Same for the predictions/polls view — it owns the chat area while open.
  if (typeof predViewOpen === 'function' && predViewOpen()) return true
  if (typeof imgViewOpen === 'function' && imgViewOpen()) return true // a picture owns the pane
  if (isScrolledUp || currentTab !== tabId) return false

  // Content filters — hidden at render, buffers keep the message
  const _ff = _filterFlags()
  if (isMsgFiltered(msg, _ff)) return true
  if (typeof msg.text === 'string' && _ff.dups) {
    if (_lastMsgTextByTab.get(tabId) === msg.text) return true
    _lastMsgTextByTab.set(tabId, msg.text)
  }

  // Merged tabs: a plain live line is appended below like on any tab, but
  // never trimmed by it (trimChildren is platform-blind and lets the fastest
  // source push the others out): the trim is the real render's, fair per
  // platform, and it runs soon (merged-tab.js). Anything the render has to see
  // first goes to it now.
  const merged = isMultiPlatformTab(tabId)
  if (merged && !mtCanAppend(msg, tabId, _ff.dups)) {
    scheduleMergedRender()
    return true // tell caller we handled it
  }

  // Hidden tab: skip ALL DOM work (build/append/trim/pin) — buffers keep the
  // message and the visibilitychange handler rebuilds once on return. The
  // multi-platform path above pauses for free (rAF never fires while hidden).
  // hasFocus() and the BG-oracle wedge flag override a stuck 'hidden': if
  // the visibility flip got lost (popout/wayland occlusion) but the window
  // is focused or the BG proved it on-screen, the user IS looking — keep
  // appending instead of freezing the pane.
  // A popout chat window exists to be read: its visibility flag lies often
  // enough (wayland occlusion, tiled windows) that skipping here froze the
  // pane until a full repaint. Only a tab shares the screen with other work.
  if (document.hidden && !document.hasFocus() && !_visWedged && !document.body.classList.contains('hs-popout')) {
    _hiddenSkippedAppend = true
    return true
  }

  const msgsEl = document.getElementById('hs-mc-messages')
  if (!msgsEl) return false

  // Remove "no messages" placeholder. It's always the sole/first child (see
  // isEmptyTab), so an O(1) firstChild check beats a descendant querySelector
  // on every appended message.
  const first = msgsEl.firstElementChild
  if (first?.classList.contains('hs-mc-empty')) first.remove()

  // Compute key first so we can skip if a node with this key already exists
  // (IRC reconnect, replay echo, dual-send race — all paths benefit from
  // a single guard instead of relying on each caller to dedup). Direct
  // iteration vs. CSS attr selector — CSS.escape encodes for identifier
  // grammar, not attribute-value grammar, so a key like "3:@user:t:Tr" was
  // producing a selector that didn't match the literal dataset value and
  // the guard silently failed.
  const msgKeyStr = msgKeyOf(msg)
  if (_msgKeyIndex.has(msgKeyStr)) return true

  const div = buildMessageDiv(msg, tabId)
  if (!div) return true
  // Tag with the same msgKey renderMessages uses, so a later tab switch into a
  // multi-platform view can prefix-match this DOM and avoid a one-shot rebuild.
  div.dataset.msgKey = msgKeyStr
  div.dataset.hsEpoch = String(_renderEpoch)
  // Same rule as every render path, so an epoch rebuild recomputes the same stripes.
  stampZebra(div, msg, msgsEl.lastElementChild)
  msgsEl.appendChild(div)
  _indexMessageDiv(div, msgKeyStr)
  _snapCompleteEmotes(div)

  // Trim oldest rows beyond the live-DOM cap (data buffer keeps more).
  // Hysteresis: let the append hot path overshoot the cap by 50 rows, then
  // trim back down to it — one Range op per ~50 messages instead of one per
  // message at steady state. Every other trim site stays exact-cap (tab
  // restore paths assume ≤ cap).
  if (merged) mtNoteAppend()
  else if (msgsEl.childElementCount > DOM_RENDER_CAP + 50) trimMessagesEl(msgsEl, DOM_RENDER_CAP)

  // Apply mute to just this message — strip content for muted users.
  // msg.user is the sender; avoid a DOM scan to recompute it. Routes
  // through isUserMuted so a kick chatter whose linked twitch handle was
  // muted (or vice-versa) gets stripped on either platform.
  const username = msg.user ? String(msg.user).toLowerCase() : ''
  if (username && isUserMuted(username, msg.platform)) {
    stripMcMutedMessage(div)
  }

  // No updateTabBadges() here: it only refreshes the mentions/whispers/feed
  // "unseen" badges, whose state changes solely via noteSeenEvent/bumpSeen
  // (both already call refreshSeenBadges). A plain incoming chat message can't
  // change it, so calling it per-append was 3 querySelectors/msg of pure waste.
  scheduleScrollPin(msgsEl)
  return true
}

// Render epoch — bumps when external state invalidates already-rendered DOM
// (emote data, settings that change visual output). Each row is stamped with
// the epoch it was built at (data-hs-epoch); after a bump the diff render
// rebuilds stale rows in place — never a teardown, never a reorder.
let _renderEpoch = 0

// Full rebuild — used for tab switches, scroll resume, and initial load
// Invalidate cached rendered HTML on all messages (when emote data changes)
function clearRenderedHtmlCache() {
  const clearBuf = (msgs) => {
    for (const m of msgs) delete m._renderedHtml
  }
  if (irc?.channels) for (const [, buf] of irc.channels) clearBuf(buf.getAll())
  if (kickChat?.channels) for (const [, buf] of kickChat.channels) clearBuf(buf.getAll())
  clearBuf(mentionsBuffer)
  for (const msgs of channelYtMessages.values()) clearBuf(msgs)
  _renderEpoch++
  // Tab caches are keyed by old epoch — drop them all so next switch
  // rebuilds at the new epoch instead of restoring stale-keyed children
  // that the diff would immediately wipe.
  _dropAllTabCaches()
}

// Bump render epoch WITHOUT clearing _renderedHtml. Used when late-arriving
// out-of-band data (Twitch native badges, BTTV/FFZ/Chatterino bulk badge
// maps) needs to re-flow into the DOM. The diff renderer skips identical
// msgKeys, so a bare renderMessages after badge fetch is a no-op — bumping
// the epoch forces a fresh build that recomputes badges while keeping
// cached emote HTML on _renderedHtml.
function bumpRenderEpoch() {
  _renderEpoch++
  _dropAllTabCaches()
}

// Surgical invalidation for a block/unblock of specific emote(s). The full
// clearRenderedHtmlCache() bumps _renderEpoch, which marks EVERY row stale so
// the next render rebuilds each one in place — order-safe, but still a full
// rebuild's worth of work + img churn. block/unblockEmote already correct the
// live DOM in-place, so we only need to (a) drop cached _renderedHtml on the
// messages that actually reference these emotes, so a LATER rebuild reprocesses
// them with current block state, and (b) drop other tabs' cached fragments so
// they rebuild fresh on next visit. No epoch bump → current tab is untouched →
// no flash.
function invalidateRenderedForEmotes(names) {
  const list = Array.isArray(names) ? names : [names]
  const wanted = list.filter(Boolean)
  if (wanted.length === 0) return
  const clearBuf = (msgs) => {
    for (const m of msgs) {
      if (m._renderedHtml == null || !m.text) continue
      for (const n of wanted) {
        if (m.text.includes(n)) {
          delete m._renderedHtml
          break
        }
      }
    }
  }
  if (irc?.channels) for (const [, buf] of irc.channels) clearBuf(buf.getAll())
  if (kickChat?.channels) for (const [, buf] of kickChat.channels) clearBuf(buf.getAll())
  clearBuf(mentionsBuffer)
  for (const msgs of channelYtMessages.values()) clearBuf(msgs)
  _dropAllTabCaches()
}

// Merge multiple platform sources into ~150 messages with proportional
// interleaving. Each platform's messages maintain internal chronological
// order, but platforms are woven together evenly so no single source
// dominates any region of the output — even when their time ranges
// don't overlap (e.g. IRC history from hours ago + YT from seconds ago).
// Merge k already-time-sorted runs into one ascending array, exploiting each
// source's chronological order instead of re-sorting the whole pool every
// frame (fairMerge runs once per render, ~60×/s on a busy tab). Tie policy:
// equal byTimeStable → lowest run index first — deterministic across renders,
// so the insert-only diff stays stable. k is the platform count (≤~4), so the
// linear head-scan beats Array.sort's O(n log n) on the merged buffer.
function mergeSortedRuns(runs) {
  const live = runs.filter((r) => r.length > 0)
  if (live.length === 0) return []
  if (live.length === 1) return live[0].slice()
  const idx = new Array(live.length).fill(0)
  let total = 0
  for (const r of live) total += r.length
  const out = new Array(total)
  let o = 0
  for (;;) {
    let best = -1
    for (let i = 0; i < live.length; i++) {
      if (idx[i] >= live[i].length) continue
      if (best === -1 || byTimeStable(live[i][idx[i]], live[best][idx[best]]) < 0) best = i
    }
    if (best === -1) break
    out[o++] = live[best][idx[best]++]
  }
  return out
}

// A run that is not non-decreasing by ord would make mergeSortedRuns emit a
// scrambled window — new chat inserted above a stale tail, i.e. chat that looks
// frozen. Buffers are kept sorted at every write; this is the net under them:
// one cheap O(n) scan per render, and a (stable) sorted COPY only when a run
// is actually out of order, so no upstream bug can reach the screen.
function _ordSortedRun(run) {
  for (let i = 1; i < run.length; i++) {
    if (ordOf(run[i]) < ordOf(run[i - 1])) {
      // loud in dev builds so the writer that broke the invariant gets found,
      // silent (and repaired) in the packaged one
      if (typeof __HS_DEV_BUILD__ !== 'undefined' && __HS_DEV_BUILD__)
        console.error('[heatsync-ext] fairMerge input run not sorted at index', i, run[i - 1], run[i])
      return run.slice().sort((a, b) => ordOf(a) - ordOf(b))
    }
  }
  return run
}

// Co-live detection. When every source's newest msg lands within ~10 min
// of each other AND is fresh (<1h old), both platforms are streaming now
// — a firehose twitch can drown a trickle YT/kick, so the per-source floor
// below applies to preserve fairness. Otherwise (offline channel with sparse
// recent traffic, or sources timestamps far apart) let chronological order
// rule so older historical msgs from a sparse source don't get amputated.
// ordOf (not raw .time): a live-paced YT source's newest msg may carry a
// true send time far behind its display ord — coLive must read the SAME
// key everything else sorts/merges on, or a paced YT source could look
// "not co-live" by wall-clock time while rendering interleaved as if it were.
// One function, because merged-tab.js asks the same question to know when
// a plain append is still safe.
function fairCoLive(newestOrds) {
  const hi = Math.max(...newestOrds)
  return hi - Math.min(...newestOrds) < 10 * 60 * 1000 && hi > Date.now() - 60 * 60 * 1000
}

function fairMerge(sources) {
  sources = sources.map(_ordSortedRun)
  if (MC_DEBUG)
    log(
      'fairMerge sources:',
      sources.map((s) => s.length),
    )
  const limit = DOM_RENDER_CAP
  const active = sources.filter((s) => s.length > 0)
  if (active.length === 0) return []
  if (active.length === 1) {
    const s = active[0]
    // ALWAYS return a copy — the follow-event merge below splices into the
    // returned array in place. IRC/Kick getMessages/getTail already copy,
    // but YT sources are the raw channelYtMessages arrays; returning one by
    // ref let the splice permanently insert "X went live" events into that
    // buffer, which persistYt then serialized as fake chat history.
    return s.length <= limit ? s.slice() : s.slice(-limit)
  }

  const coLive = fairCoLive(active.map((s) => ordOf(s[s.length - 1]) || 0))

  if (coLive) {
    // Anti-drown WITHOUT retroactive eviction. The old proportional cap
    // (ceil(limit/active.length)) re-sliced every source whenever active
    // count changed — so the moment a quiet platform (e.g. YouTube) started
    // trickling in, active went 2→3, twitch's share dropped 250→167, and
    // ~80 already-visible rows vanished mid-stream. Instead: guarantee each
    // source a small recency FLOOR (so a firehose can't fully bury a
    // trickle), then fill the rest of the budget by pure global recency.
    // A new source going live now only costs its own floor (~40), filled by
    // its own fresh messages — no chunk of another platform disappears.
    const FLOOR = Math.min(40, Math.floor(limit / (active.length + 1)))
    // Each source is already ord-sorted (invariant #1), so its tail slice
    // is too — floorRuns are k already-sorted runs, disjoint by
    // construction (each drawn from a different source array).
    const floorRuns = active.map((s) => s.slice(-FLOOR))
    const seen = new Set()
    for (const run of floorRuns) for (const m of run) seen.add(m)
    // rest = each source's non-floor tail (a sorted run) → k-way merge, not sort.
    const rest = mergeSortedRuns(active.map((s) => s.filter((m) => !seen.has(m))))
    const floorPoolSize = floorRuns.reduce((n, r) => n + r.length, 0)
    const room = Math.max(0, limit - floorPoolSize)
    // rest is itself sorted, so its newest-`room` suffix is too.
    const restTail = room > 0 ? rest.slice(-room) : []
    // floorRuns + restTail are all disjoint, individually-sorted runs —
    // ONE more k-way merge finishes the job with no full-array sort.
    // (mergeSortedRuns' run-index tie-break keeps tied ords deterministic
    // across renders; the old pool.sort(byTimeStable) did the same via
    // stableMsgId — without a deterministic tiebreak the insert-only diff
    // would duplicate flipped pairs.)
    const pool = mergeSortedRuns([...floorRuns, restTail])
    if (typeof __HS_DEV_BUILD__ !== 'undefined' && __HS_DEV_BUILD__) _assertSortedByOrd(pool, 'fairMerge co-live pool')
    return pool.slice(-limit)
  }
  // Non-co-live: each source is already chronological, so merge the sorted
  // tails directly — no full re-sort of the merged buffer this frame.
  const merged = mergeSortedRuns(active.map((s) => s.slice(-limit)))
  if (typeof __HS_DEV_BUILD__ !== 'undefined' && __HS_DEV_BUILD__)
    _assertSortedByOrd(merged, 'fairMerge non-co-live merge')
  return merged.length <= limit ? merged : merged.slice(-limit)
}
// DEV-only correctness net for the merge paths above: mergeSortedRuns is
// only a valid substitute for pool.sort() when every input run truly IS
// sorted by ord (invariant #1 — every buffer stays sorted via insertOrdered/
// sortedInsert). Folds away entirely in packaged builds (__HS_DEV_BUILD__ →
// false, dead-code eliminated) — a violation here would otherwise surface
// as a silent, hard-to-repro row-ordering glitch instead of a loud error.
function _assertSortedByOrd(arr, label) {
  for (let i = 1; i < arr.length; i++) {
    if (ordOf(arr[i]) < ordOf(arr[i - 1])) {
      console.error(`[heatsync-ext] ${label}: not sorted at index ${i}`, arr[i - 1], arr[i])
      return
    }
  }
}
function stableMsgId(m) {
  // Memoize on the message object — id/base36_id/user/time/text are immutable
  // once a chat object is buffered (the only .text rewrite is in irc.js history
  // ingest, before push). The render diff (msgKey, below) + fairMerge sort +
  // appendMessage all rebuild this same fallback string; on a 500-row co-live
  // tab that was tens of thousands of concats per render.
  return m._sid ?? (m._sid = m.id || m.base36_id || `${m.user || ''}:${m.time || ''}:${(m.text || '').slice(0, 32)}`)
}
function byTimeStable(a, b) {
  const dt = ordOf(a) - ordOf(b)
  if (dt !== 0) return dt
  const ka = stableMsgId(a),
    kb = stableMsgId(b)
  return ka < kb ? -1 : ka > kb ? 1 : 0
}
// Stable msgKey (rides stableMsgId's _sid memo). Deliberately EXCLUDES
// _renderEpoch: an epoch-in-the-key meant every bump re-keyed every row, so
// the diff saw 500 strangers, tore the list down and rebuilt it in fresh
// fairMerge order — a visible whole-chat flash AND a row reorder whenever
// the fresh sort disagreed with the never-move history order (mellen's
// "posts flicker/reorder sometimes", 2026-07-17). Staleness now lives on
// the row itself (data-hs-epoch); renderMessages rebuilds stale rows IN
// PLACE, so order and scroll survive a bump by construction.
function msgKeyOf(m) {
  return stableMsgId(m)
}
// Reused render-pass buffers: renderMessages is synchronous and never
// re-enters itself mid-body, so per-run collections are safe to pool.
const _rmDesiredKeys = []
const _rmDesiredSet = new Set()
const _rmExistingByKey = new Map()
const _rmInsertedKeys = new Set()
// Row types that never take a stripe. Stamped on the node too, so a repaint
// can tell them apart without the message object.
const _NO_ZEBRA_TYPES = new Set([
  'stream-event',
  'feed-post',
  'inline-notif',
  'inline-dm',
  'moment',
  'cmd-receipt',
  'automod-hold',
])
function stampZebra(div, m, prevDiv) {
  if (_NO_ZEBRA_TYPES.has(m.type)) div.dataset.hsNz = '1'
  // a notice row (went live / switched to) does not count: the stripe alternates
  // across it, against the last row that was counted (same as the site)
  if (m.type === 'stream-event') div.dataset.hsNotice = '1'
  {
    const stripe = !div.classList.contains('hs-filled') && zebraOfInsert(m, prevDiv)
    div.classList.toggle('hs-mc-zebra', stripe)
    div.classList.toggle('hs-zebra', stripe) // the shared stripe marker (styles/21-brand-rows.css)
  }
}
// Re-derive every stripe from `from` onward. A row inserted mid-list (a kick
// line landing between twitch lines by timestamp) used to leave everything
// after it a beat out of phase — two grey rows or two black ones in a row —
// because each stripe was only computed against the row above at insert time.
function zebraRepaint(msgsEl, from) {
  let prev = from ? from.previousElementSibling : null
  // the row to alternate against is the last counted one: not the player, not a notice
  while (prev && (prev.id === 'hs-mc-embed-player' || prev.dataset?.hsNotice || prev.classList.contains('hs-filled')))
    prev = prev.previousElementSibling
  for (let el = from || msgsEl.firstElementChild; el; el = el.nextElementSibling) {
    if (el.id === 'hs-mc-embed-player') continue
    // the top row has no row above to alternate against — it keeps its stripe
    const filled = el.classList.contains('hs-filled')
    const want = filled
      ? false
      : prev
        ? zebraEnabled && !el.dataset.hsNz && !prev.classList.contains('hs-mc-zebra')
        : zebraEnabled && el.classList.contains('hs-mc-zebra')
    if (el.classList.contains('hs-mc-zebra') !== want) {
      el.classList.toggle('hs-mc-zebra', want)
      el.classList.toggle('hs-zebra', want)
    }
    // a notice or filled row is not a row for parity: the next one alternates against `prev`
    if (el.dataset.hsNotice || filled) continue
    prev = el
  }
}
function zebraOfInsert(m, prevDiv) {
  // the video player sits in the list but is not a row — stripe off the row before it
  // ...and neither does a notice row: stripe off the last row that was counted
  while (
    prevDiv &&
    (prevDiv.id === 'hs-mc-embed-player' || prevDiv.dataset?.hsNotice || prevDiv.classList?.contains('hs-filled'))
  ) {
    prevDiv = prevDiv.previousElementSibling
  }
  if (!zebraEnabled || !prevDiv) return false
  if (_NO_ZEBRA_TYPES.has(m.type) || m.isFirstMsg) return false
  return !prevDiv.classList.contains('hs-mc-zebra')
}

// ─── Multistream auto-detect banner ─────────────────────────────────────
// Tier 1: rely on heatsync server's resolveIdentity. If a streamer is live
// on >=2 platforms and the user hasn't already linked them in config.channels,
// surface a one-click "link channels" suggestion. Right-click dismisses
// permanently for that channel pair.
let _multistreamDismissed = null
let _multistreamLastChecked = ''
let _multistreamLastResult = '' // 'shown' | 'hidden' — sticky per channel/key
async function loadMultistreamDismissed() {
  if (_multistreamDismissed) return _multistreamDismissed
  try {
    const data = await browser.storage.local.get('hs_multistream_dismissed')
    _multistreamDismissed = new Set(data.hs_multistream_dismissed || [])
  } catch {
    _multistreamDismissed = new Set()
  }
  return _multistreamDismissed
}
function persistMultistreamDismissed() {
  try {
    chrome.storage.local.set({ hs_multistream_dismissed: [..._multistreamDismissed] })
  } catch {}
}
function hideMultistreamBanner() {
  const el = document.getElementById('hs-mc-multistream-banner')
  if (el) {
    el.hidden = true
    el.replaceChildren()
  }
}
async function maybeShowMultistreamBanner(channelName, platform) {
  const el = document.getElementById('hs-mc-multistream-banner')
  if (!el) return
  if (!channelName) {
    hideMultistreamBanner()
    return
  }
  const key = `${platform || 'auto'}:${channelName.toLowerCase()}`
  // Avoid redundant API calls when the user re-enters the same channel tab
  // — track last result per key so a 'hidden' decision sticks until channel changes.
  if (_multistreamLastChecked === key) {
    if (_multistreamLastResult === 'shown' && !el.hidden) return
    if (_multistreamLastResult === 'hidden') return
  }
  _multistreamLastChecked = key
  const dismissed = await loadMultistreamDismissed()
  if (_multistreamLastChecked !== key) return
  if (dismissed.has(key)) {
    _multistreamLastResult = 'hidden'
    hideMultistreamBanner()
    return
  }
  if (typeof resolveIdentity !== 'function') {
    _multistreamLastResult = 'hidden'
    hideMultistreamBanner()
    return
  }
  const res = await resolveIdentity(channelName, platform ? { platform } : {})
  if (_multistreamLastChecked !== key) return
  if (!res?.ok || !res.identity) {
    _multistreamLastResult = 'hidden'
    hideMultistreamBanner()
    return
  }
  const id = res.identity
  const liveOn = res.liveOn || []
  if (liveOn.length < 2) {
    _multistreamLastResult = 'hidden'
    hideMultistreamBanner()
    return
  }
  // Find this streamer's config entry (any platform overlap). Suppress only
  // when it already covers every platform they're live on — an entry linked
  // as twitch+kick must still get the nudge when their youtube goes live.
  // config yt values may be full URLs while identity carries a handle, so
  // compare youtube by extracted @handle.
  const lower = channelName.toLowerCase()
  const ytHandleOf = (v) => {
    if (!v) return null
    const m = String(v).match(/@([^/?]+)/)
    return (m ? m[1] : String(v)).toLowerCase()
  }
  const matchEntry = config.channels.find((ch) => {
    const t = ch.twitch?.toLowerCase()
    const k = ch.kick?.toLowerCase()
    const y = ytHandleOf(ch.youtube)
    return (
      t === lower ||
      k === lower ||
      y === lower ||
      (id.twitch && t === id.twitch.toLowerCase()) ||
      (id.kick && k === id.kick.toLowerCase()) ||
      (id.youtube && y === ytHandleOf(id.youtube))
    )
  })
  const missingLive = liveOn.filter((p) => id[p] && !matchEntry?.[p])
  if (matchEntry && missingLive.length === 0) {
    _multistreamLastResult = 'hidden'
    hideMultistreamBanner()
    return
  }
  // Build banner. Copy stays name-free and lowercase — the banner sits on
  // the streamer's own tab, and the panel is ~360px wide: a display name
  // pushes the platform list (the whole point) past the ellipsis.
  const otherPlatforms = liveOn.filter((p) => p !== platform)
  _multistreamLastResult = 'shown'
  el.replaceChildren()
  el.hidden = false
  const text = document.createElement('span')
  text.className = 'hs-mc-multi-text'
  text.textContent = t('mc_main_also_live_on', [otherPlatforms.join(' + ')])
  const linkBtn = document.createElement('button')
  linkBtn.className = 'hs-mc-multi-link'
  linkBtn.textContent = t('mc_main_link_channels')
  linkBtn.addEventListener('click', (e) => {
    e.preventDefault()
    // Merge into the existing entry when there is one — pushing a fresh
    // entry for an already-tabbed streamer would duplicate their tab.
    if (matchEntry) {
      if (id.twitch && !matchEntry.twitch) matchEntry.twitch = id.twitch
      if (id.kick && !matchEntry.kick) matchEntry.kick = id.kick
      if (id.youtube && !matchEntry.youtube) matchEntry.youtube = id.youtube
    } else {
      const entry = { id: `linked_${Date.now()}` }
      if (id.twitch) entry.twitch = id.twitch
      if (id.kick) entry.kick = id.kick
      if (id.youtube) entry.youtube = id.youtube
      config.channels.push(entry)
    }
    saveConfig()
    try {
      updateTabBar()
    } catch {}
    hideMultistreamBanner()
  })
  const dismissBtn = hsXButton('hs-x-inline', t('mc_main_dismiss'))
  dismissBtn.title = t('mc_main_dismiss_rclick')
  const dismissNow = () => {
    _multistreamDismissed.add(key)
    persistMultistreamDismissed()
    hideMultistreamBanner()
  }
  dismissBtn.addEventListener('click', dismissNow)
  if (el._hsCtxDismiss) el.removeEventListener('contextmenu', el._hsCtxDismiss)
  const ctxHandler = (e) => {
    e.preventDefault()
    dismissNow()
  }
  el._hsCtxDismiss = ctxHandler
  el.addEventListener('contextmenu', ctxHandler)
  el.append(text, linkBtn, dismissBtn)
}

// ── live-tab chat search / filter-by-user ─────────────────────────────────
// Server-search + social tabs render their own content; every other tab (live
// + per-channel) is an in-memory buffer the search bar filters locally and
// instantly — no network round-trip.
const _SERVER_TABS = new Set(['mentions', 'feed', 'whispers', 'discover', 'pinned', 'settings', 'add'])
function isLiveSearchTab(id) {
  return typeof id === 'string' && !_SERVER_TABS.has(id)
}
// Active local-filter query for a live tab (trimmed, case preserved), else ''.
// Case preservation is required so /Pattern/i vs /Pattern/ both work correctly.
function liveSearchQuery(id) {
  if (!isLiveSearchTab(id)) return ''
  const el = document.getElementById('hs-mc-search-input')
  return el ? el.value.trim() : ''
}

// Clear the n/N match cursor (both the marked row and the remembered key).
// Called whenever the query changes/clears or the tab switches — the same
// "never bleeds across context" rule the filter query itself follows.
function _clearLiveSearchCursor() {
  if (!_liveSearchCurrentKey) return
  _liveSearchCurrentKey = null
  const cur = document.querySelector('.hs-mc-search-current')
  if (cur) cur.classList.remove('hs-mc-search-current')
}

// n/N cursor step. The filter already renders ONLY matching rows, so every
// .hs-mc-msg in msgsEl is a match — this just walks that list. Position is
// re-derived from the DOM each call (rows.indexOf(prev)) rather than trusted
// from stored state, so a re-render between keypresses (new msg arriving)
// can never leave the cursor pointing at a stale/removed row.
function cycleLiveSearchMatch(dir) {
  const msgsEl = document.getElementById('hs-mc-messages')
  if (!msgsEl) return
  const rows = [...msgsEl.querySelectorAll('.hs-mc-msg[data-msg-key]')]
  if (!rows.length) return
  const prev = msgsEl.querySelector('.hs-mc-search-current')
  if (prev) prev.classList.remove('hs-mc-search-current')
  const prevIdx = prev ? rows.indexOf(prev) : -1
  const idx = prevIdx === -1 ? (dir > 0 ? 0 : rows.length - 1) : (prevIdx + dir + rows.length) % rows.length
  const row = rows[idx]
  row.classList.add('hs-mc-search-current')
  _liveSearchCurrentKey = row.dataset.msgKey
  row.scrollIntoView({ behavior: 'instant', block: 'center' })
  const countEl = document.getElementById('hs-mc-search-count')
  if (countEl) countEl.textContent = `${idx + 1}/${rows.length}`
}

// Upward infinite-scroll: when the user reaches the top, paint the next chunk
// of OLDER buffered messages (already in the 3000-deep ring) by growing the
// render window and re-running the SAME diff renderer — so indexing, zebra,
// mutes, cosmetics and epoch-keying all stay correct by construction. Anchors
// scroll so the viewport doesn't jump when rows prepend above it.
function loadOlderScrollback() {
  if (!isScrolledUp) return // only while the user is paused (scrolled up)
  if (
    currentTab === 'feed' ||
    currentTab === 'settings' ||
    currentTab === 'discover' ||
    currentTab === 'pinned' ||
    currentTab === 'modlog'
  )
    return
  if (_scrollbackWindow >= SCROLLBACK_MAX - DOM_RENDER_CAP) return // at the depth ceiling
  const msgsEl = document.getElementById('hs-mc-messages')
  if (!msgsEl) return
  // Try to grow the window, then check whether older rows actually appeared.
  // We don't pre-guard on a row count — rendered rows can sit just under the
  // cap (content filters, fair-merge) so a "< cap" test would false-bail one
  // short. Instead: bump, render, and revert if nothing older was available.
  const before = msgsEl.children.length
  const prevWindow = _scrollbackWindow
  const oldH = msgsEl.scrollHeight
  const oldTop = msgsEl.scrollTop
  _scrollbackWindow = Math.min(_scrollbackWindow + SCROLLBACK_STEP, SCROLLBACK_MAX - DOM_RENDER_CAP)
  isProgrammaticScroll = true
  try {
    renderMessages(currentTab, { bypassScrollPause: true })
  } catch (_) {}
  if (msgsEl.children.length > before) {
    // Anchor: keep the previously-visible content under the same viewport
    // offset (rows added above shift everything down by the height delta).
    msgsEl.scrollTop = oldTop + (msgsEl.scrollHeight - oldH)
  } else {
    _scrollbackWindow = prevWindow // buffer exhausted — don't inflate uselessly
  }
  cleanup.raf(() => {
    isProgrammaticScroll = false
  })
}

// Trailing collapse for hydration-class FULL rebuilds. On reload, every
// per-channel history merge (twitch/kick/yt BG hydration) ends in its own
// renderMessages(currentTab); several land across consecutive frames and the
// back-to-back teardown+rebuild paints read as jumbled fly-in. Each request
// (re)arms one short trailing window and a single render fires after the
// last, capped at 400ms from the first request so a merge trickle can't
// starve the paint. currentTab is read at fire time; the render only fires
// for channel/live tabs — the old call sites' isCurrent guards never
// repainted own-renderer tabs (settings/feed/…) from hydration, and firing
// into them mid-interaction is the composer-rebuild bug class. User-driven
// renders (tab click, scrollback, send) stay synchronous — never route them
// through here.
let _renderCollapseTimer = null
let _renderCollapseFirstAt = 0
// Newest buffered row for the tab on screen — what a render would put at the
// bottom. Mirrors renderMessages' source choice (live tab vs channel tab).
function _tabNewestBuffered(id) {
  let names
  if (id === 'live') {
    const plat = getLivePlatformNames()
    const cur = getLiveChannel()
    names = { twitch: plat.twitch || cur, kick: plat.kick || cur }
  } else {
    const ch = getChannelById(id)
    names = { twitch: ch?.twitch, kick: ch?.kick }
  }
  let best = null
  const t = names.twitch ? irc?.getTail(String(names.twitch).toLowerCase(), 1)[0] : null
  const k = names.kick ? kickChat?.getTail(String(names.kick).toLowerCase(), 1)[0] : null
  for (const m of [t, k]) if (m && (!best || ordOf(m) > ordOf(best))) best = m
  return best
}

// Last line of defence against a chat that stops painting. Every few seconds:
// is the newest live row the buffer holds actually on screen? If it has been
// sitting there for 4s+ and isn't, something upstream swallowed a render —
// log what was blocking it (hs_diag_ring, so a report carries the cause) and
// repaint. Intentional pauses (scrolled up, a card/panel/editor open, tab
// hidden) are recorded but never fought.
// Diagnosis switch: localStorage hs_noheal=1 keeps every watchdog logging but
// stops them repairing, so a break can be watched instead of masked.
const _noHeal = () => {
  try {
    return localStorage.getItem('hs_noheal') === '1'
  } catch (_) {
    return false
  }
}
let _stallLoggedAt = 0
let _desyncLoggedAt = 0
// The key index must mirror the rows on screen. One stray key (a row dropped
// without unindexing) makes appendMessage and the diff skip that message as
// "already shown" forever — chat freezes while buffers keep filling. The DOM
// is the truth: rebuild the index from it and repaint.
function _reconcileMsgKeyIndex(msgsEl) {
  const dom = new Set()
  for (const el of msgsEl.children) {
    const k = el.dataset?.msgKey
    if (k) dom.add(k)
  }
  let drift = dom.size !== _msgKeyIndex.size
  if (!drift)
    for (const k of _msgKeyIndex)
      if (!dom.has(k)) {
        drift = true
        break
      }
  if (!drift) return
  const now = Date.now()
  if (now - _desyncLoggedAt > 20000) {
    _desyncLoggedAt = now
    try {
      window.__hsDiag?.('index_desync', {
        tab: String(currentTab).slice(0, 24),
        dom: dom.size,
        idx: _msgKeyIndex.size,
      })
    } catch (_) {}
  }
  if (_noHeal()) return
  _msgKeyIndex.clear()
  for (const k of dom) _msgKeyIndex.add(k)
  scheduleRenderMessages()
}
function renderStallCheck() {
  if (document.hidden) return
  if (currentTab !== 'live' && !getChannelById(currentTab)) return
  const msgsEl = document.getElementById('hs-mc-messages')
  if (!msgsEl) return
  _reconcileMsgKeyIndex(msgsEl)
  const m = _tabNewestBuffered(currentTab)
  if (!m || m.isHistory || Date.now() - (m.time || 0) < 4000) return
  if (Date.now() - (m.time || 0) > 120000) return // quiet channel, nothing newer to show
  if (_msgKeyIndex.has(msgKeyOf(m))) return
  const blockers = {
    editing: !!editingChannel,
    panel: !!hsPanePanelOpen(),
    card: typeof activeProfileCard !== 'undefined' && !!activeProfileCard,
    scrolledUp: !!isScrolledUp,
  }
  const now = Date.now()
  if (now - _stallLoggedAt > 20000) {
    _stallLoggedAt = now
    try {
      window.__hsDiag?.('render_stall', {
        tab: String(currentTab).slice(0, 24),
        ageS: Math.round((now - (m.time || 0)) / 1000),
        domN: msgsEl.children.length,
        plat: m.platform || 'twitch',
        ...blockers,
      })
    } catch (_) {}
  }
  if (!blockers.editing && !blockers.panel && !blockers.card && !blockers.scrolledUp && !_noHeal())
    scheduleRenderMessages()
}

// Same idea one step upstream: a busy channel (5 deliveries inside 20s) that
// then goes quiet for 10s+ is not quiet, it is cut off — the BG→tab push died
// (service-worker restart, interest lost, a throttled window). Re-register
// interest and pull the BG's ring, which holds what the push dropped, and say
// so in the diag ring. Pulling is idempotent: the sorted merge dedupes by id.
// Rows churning (added + removed) while the newest row never changes is the
// frozen-but-flashing signature: the renderer is busy, nothing new lands.
// Record it with the buffer's view, then rebuild the pane from scratch.
// Frames that hold the main thread for 400ms+ are what a frozen, flashing
// pane looks like from outside. Chrome says what ran (script sources, forced
// layout) — keep the worst one per 20s in the diag ring.
let _loafLoggedAt = 0
function watchLongFrames() {
  try {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const now = Date.now()
        if (e.duration < 400 || now - _loafLoggedAt < 20000) continue
        _loafLoggedAt = now
        hsDiagLog('long_frame', {
          ms: Math.round(e.duration),
          block: Math.round(e.blockingDuration || 0),
          style: Math.round(e.styleAndLayoutStart ? e.startTime + e.duration - e.styleAndLayoutStart : 0),
          tab: String(currentTab).slice(0, 24),
          rows: document.getElementById('hs-mc-messages')?.children.length || 0,
          scripts: (e.scripts || []).slice(0, 3).map(
            (x) =>
              `${Math.round(x.duration)}ms ${x.invokerType || ''} ${String(x.sourceURL || '')
                .split('/')
                .pop()
                .slice(0, 30)}:${x.sourceFunctionName || ''}`,
          ),
        })
      }
    })
    po.observe({ type: 'long-animation-frame', buffered: false })
  } catch (_) {}
}
// Alt+Shift+D: write the pane's whole state to the diag ring right now. For a
// freeze no watchdog caught — press it while the chat is stuck, then read the
// `manual_dump` entry.
function dumpPaneState() {
  const now = Date.now()
  const age = (m) => (m ? Math.round((now - (m.time || 0)) / 1000) : -1)
  const msgsEl = document.getElementById('hs-mc-messages')
  const rows = msgsEl ? [...msgsEl.children] : []
  const last = rows[rows.length - 1]
  const ch = currentTab === 'live' ? null : getChannelById(currentTab)
  const tw = String((ch ? ch.twitch : getLivePlatformNames().twitch) || '').toLowerCase()
  const kk = String((ch ? ch.kick : getLivePlatformNames().kick) || '').toLowerCase()
  const nb = _tabNewestBuffered(currentTab)
  hsDiagLog('manual_dump', {
    tab: String(currentTab).slice(0, 24),
    rows: rows.length,
    domTailAgeS: last ? Math.round((now - (+last.dataset.msgTime || 0)) / 1000) : -1,
    domQuietS: Math.round((now - _domChangeAt) / 1000),
    lastRenderS: _lastRenderAt ? Math.round((now - _lastRenderAt) / 1000) : -1,
    renderCalls: _renderCalls,
    twTailAgeS: tw ? age(irc?.getTail(tw, 1)?.[0]) : -2,
    kickTailAgeS: kk ? age(kickChat?.getTail(kk, 1)?.[0]) : -2,
    bufNewestAgeS: age(nb),
    bufInIndex: nb ? _msgKeyIndex.has(msgKeyOf(nb)) : null,
    bufInDom: nb ? !!msgsEl?.querySelector(`[data-msg-key="${CSS.escape(msgKeyOf(nb))}"]`) : null,
    idx: _msgKeyIndex.size,
    multi: isMultiPlatformTab(currentTab),
    mpTimer: !!_multiPlatformRenderTimer,
    collapse: _renderCollapseTimer !== null,
    hid: document.hidden,
    foc: document.hasFocus(),
    wedged: _visWedged,
    starved: _rafStarved,
    skipped: _hiddenSkippedAppend,
    up: !!isScrolledUp,
    edit: !!editingChannel,
    card: typeof activeProfileCard !== 'undefined' && !!activeProfileCard,
    panel: !!hsPanePanelOpen(),
    pred: typeof predViewOpen === 'function' && !!predViewOpen(),
    img: typeof imgViewOpen === 'function' && !!imgViewOpen(),
    prog: !!isProgrammaticScroll,
    pin: !!_scrollPinRaf,
    epoch: _renderEpoch,
    gap: msgsEl ? Math.round(msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight) : -1,
  })
}
let _thrashObs = null
let _zebraObs = null
let _zebraFlips = 0
let _midInserts = 0
let _flickerLoggedAt = 0
let _domChangeAt = Date.now()
let _quietLoggedAt = 0
let _thrashEl = null
let _thrashCount = 0
let _thrashTail = null
let _thrashStreak = 0
let _thrashLoggedAt = 0
let _unpinnedStreak = 0
let _unpinLoggedAt = 0
function domThrashCheck() {
  const msgsEl = document.getElementById('hs-mc-messages')
  if (!msgsEl || (document.hidden && !document.body.classList.contains('hs-popout'))) return
  if (_thrashEl !== msgsEl) {
    _thrashObs?.disconnect()
    _thrashEl = msgsEl
    _thrashObs = new MutationObserver((ms) => {
      _domChangeAt = Date.now()
      for (const m of ms) _thrashCount += m.addedNodes.length + m.removedNodes.length
    })
    _thrashObs.observe(msgsEl, { childList: true })
    // Stripe flicker = rows flipping their shade while nothing new shows.
    // Count real flips (zebra class toggled on a message row) and mid-list
    // inserts so a flicker report says which one is driving it.
    _zebraObs?.disconnect()
    _zebraObs = new MutationObserver((ms) => {
      for (const m of ms) {
        if (m.type === 'attributes') {
          if (m.target.parentElement !== msgsEl) continue
          const was = (m.oldValue || '').includes('hs-mc-zebra')
          if (was !== m.target.classList.contains('hs-mc-zebra')) _zebraFlips++
        } else {
          for (const n of m.addedNodes) if (n.nextSibling) _midInserts++
        }
      }
    })
    _zebraObs.observe(msgsEl, {
      attributes: true,
      attributeFilter: ['class'],
      attributeOldValue: true,
      subtree: true,
      childList: true,
    })
    return
  }
  // Rows land but the view sits above the tail: the pin never ran (a pending
  // pin handle that never settles skips every later one). The user sees a
  // frozen pane while rows append off-screen below.
  const gap = msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight
  if (!isScrolledUp && gap > 40 && currentTab !== 'settings' && msgsEl.children.length) {
    if (++_unpinnedStreak >= 2) {
      const now = Date.now()
      if (now - _unpinLoggedAt > 20000) {
        _unpinLoggedAt = now
        hsDiagLog('unpinned', {
          tab: String(currentTab).slice(0, 24),
          gap: Math.round(gap),
          pinPending: !!_scrollPinRaf,
          prog: !!isProgrammaticScroll,
          domN: msgsEl.children.length,
        })
      }
      _unpinnedStreak = 0
      if (_noHeal()) return
      _scrollPinRaf = null
      isProgrammaticScroll = false
      scrollMsgsToBottom(msgsEl)
    }
  } else _unpinnedStreak = 0
  // Busy channel, silent pane: say which side went quiet. A fresh buffer with
  // a still DOM is the render path; a stale buffer is delivery.
  const nowQ = Date.now()
  const quietMs = nowQ - _domChangeAt
  if (quietMs > 4000 && nowQ - _quietLoggedAt > 20000 && (currentTab === 'live' || getChannelById(currentTab))) {
    const nbq = _tabNewestBuffered(currentTab)
    const bufAgeMs = nbq ? nowQ - (nbq.time || 0) : -1
    if (bufAgeMs >= 0 && bufAgeMs < 2500) {
      _quietLoggedAt = nowQ
      hsDiagLog('dom_quiet', {
        tab: String(currentTab).slice(0, 24),
        quietS: Math.round(quietMs / 1000),
        bufAgeMs: Math.round(bufAgeMs),
        mpTimer: !!_multiPlatformRenderTimer,
        collapse: _renderCollapseTimer !== null,
        starved: _rafStarved,
        hid: document.hidden,
        foc: document.hasFocus(),
        up: !!isScrolledUp,
        card: typeof activeProfileCard !== 'undefined' && !!activeProfileCard,
        panel: !!hsPanePanelOpen(),
        edit: !!editingChannel,
        calls: _renderCalls,
      })
    }
  }
  if (_zebraFlips >= 30 && nowQ - _flickerLoggedAt > 20000) {
    _flickerLoggedAt = nowQ
    hsDiagLog('zebra_flicker', {
      tab: String(currentTab).slice(0, 24),
      flips: _zebraFlips,
      mid: _midInserts,
      domN: msgsEl.children.length,
      ep: _renderEpoch,
    })
  }
  _zebraFlips = 0
  _midInserts = 0
  const tail = msgsEl.lastElementChild?.dataset?.msgKey || ''
  const churn = _thrashCount
  _thrashCount = 0
  if (churn >= 4 && tail && tail === _thrashTail) _thrashStreak++
  else _thrashStreak = 0
  _thrashTail = tail
  if (_thrashStreak < 3) return
  _thrashStreak = 0
  const nb = _tabNewestBuffered(currentTab)
  const now = Date.now()
  if (now - _thrashLoggedAt > 20000) {
    _thrashLoggedAt = now
    try {
      window.__hsDiag?.('dom_thrash', {
        tab: String(currentTab).slice(0, 24),
        churn,
        domN: msgsEl.children.length,
        bufAgeS: nb ? Math.round((now - (nb.time || 0)) / 1000) : -1,
        bufInDom: nb ? _msgKeyIndex.has(msgKeyOf(nb)) : null,
        up: !!isScrolledUp,
      })
    } catch (_) {}
  }
  if (_noHeal()) return
  try {
    _dropAllTabCaches()
    msgsEl.textContent = ''
    _clearMessageIndices()
    scheduleRenderMessages()
  } catch (_) {}
}

let _gapLoggedAt = 0
let _gapHealAt = 0
function ingestGapCheck() {
  if (!irc) return
  const tabCh = currentTab === 'live' ? null : getChannelById(currentTab)
  if (currentTab !== 'live' && !tabCh) return
  const ch = String(tabCh ? tabCh.twitch : getLivePlatformNames().twitch || getLiveChannel() || '').toLowerCase()
  const ts = ch ? irc._lastLiveAt?.get(ch) : null
  if (!Array.isArray(ts) || ts.length < 5) return
  const now = Date.now()
  const gap = now - ts[ts.length - 1]
  if (ts[ts.length - 1] - ts[0] > 20000 || gap < 3000 || gap > 120000) return
  if (now - _gapLoggedAt > 20000) {
    _gapLoggedAt = now
    try {
      window.__hsDiag?.('ingest_gap', {
        ch,
        gapS: Math.round(gap / 1000),
        rt: !!chrome.runtime?.id,
        hid: document.hidden,
        foc: document.hasFocus(),
        tab: String(currentTab).slice(0, 24),
      })
    } catch (_) {}
    // does the BG hold newer lines than this tab's ring? yes = delivery
    // died, no = nothing is arriving upstream either
    try {
      browser.runtime
        .sendMessage({ type: 'bg_irc_history', channel: ch })
        .then((resp) => {
          const bgNewest = Math.max(0, ...(resp?.msgs || []).map((x) => x?.time || 0))
          const ringNewest = irc.getTail(ch, 1)?.[0]?.time || 0
          window.__hsDiag?.('ingest_gap_probe', {
            ch,
            bgAheadS: Math.round((bgNewest - ringNewest) / 1000),
            bgAgeS: Math.round((Date.now() - bgNewest) / 1000),
          })
        })
        .catch(() => {})
    } catch (_) {}
  }
  // a 3-10s hitch is recorded above; only a real outage is repaired
  if (gap >= 10000 && now - _gapHealAt > 20000 && !_noHeal()) {
    _gapHealAt = now
    irc._reassertInterest?.()
    irc._refreshFromBg?.(ch)
  }
}

function scheduleRenderMessages() {
  const now = Date.now()
  if (_renderCollapseTimer === null) _renderCollapseFirstAt = now
  else cleanup.clearTimeout(_renderCollapseTimer)
  const wait = Math.min(80, Math.max(16, 400 - (now - _renderCollapseFirstAt)))
  _renderCollapseTimer = cleanup.setTimeout(() => {
    _renderCollapseTimer = null
    if (currentTab === 'live' || getChannelById(currentTab)) renderMessages(currentTab)
  }, wait)
}

// Timing wrapper: a render that eats the main thread starves everything
// (input, appends, scroll pins) and reads as a frozen, flashing pane.
// Boot timing: init() stamps the phases it waits on; the first render that paints rows closes the
// record into the diag ring, so "slow to load" says which phase it was.
let _initMarks = null
const _initMark = (name) => _initMarks?.push([name, Math.round(performance.now())])
function _closeInitMarks() {
  if (!_initMarks) return
  const el = document.getElementById('hs-mc-messages')
  if (!el?.childElementCount) return
  _initMark('rows')
  hsDiag('init-timing', { marks: _initMarks })
  _initMarks = null
}
let _slowRenderLoggedAt = 0
let _renderCalls = 0
let _lastRenderAt = 0
// The first-run call to action: add streams, or pull in the ones you follow.
// Shown on the temp tab when nothing is saved, and on the feed when the page
// has no channel to watch (the temp tab is hidden there).
function appendCockpitCta(el) {
  const title = document.createElement('div')
  title.style.cssText = 'font-weight:600;margin-bottom:4px'
  title.textContent = t('mc_main_add_streams_title')
  const sub = document.createElement('div')
  sub.style.cssText = 'opacity:.7;margin-bottom:10px'
  sub.textContent = t('mc_main_add_streams_sub')
  const btn = document.createElement('button')
  btn.style.cssText =
    'cursor:pointer;padding:6px 12px;border:1px solid currentColor;background:transparent;color:inherit;font:inherit'
  btn.textContent = t('mc_main_add_channel_btn')
  try {
    cleanup.addEventListener(btn, 'click', () => {
      try {
        switchTab('add')
      } catch (_) {}
    })
  } catch (_) {}
  // The primary way out of an empty cockpit: pull in the channels you
  // already follow instead of typing them one at a time. Sits ALONGSIDE
  // the manual button, never replacing it — someone who wants one
  // specific channel should not be routed through a follow list.
  const fillBtn = document.createElement('button')
  fillBtn.style.cssText =
    'cursor:pointer;padding:6px 12px;border:1px solid #fff;background:transparent;color:#fff;font:inherit;margin-bottom:6px'
  fillBtn.textContent = t('mc_fill_cockpit')
  try {
    cleanup.addEventListener(fillBtn, 'click', () => {
      try {
        switchTab('add')
        // switchTab('add') renders the manual form; swap straight to the
        // picker so the button does what it says on one click.
        // Re-query rather than closing over msgsEl: switchTab has just
        // re-rendered the panel, and a captured node is how you end up
        // painting into something already detached.
        const pane = document.getElementById('hs-mc-messages')
        if (typeof renderFollowImportPicker === 'function' && pane) renderFollowImportPicker(pane)
      } catch (_) {}
    })
  } catch (_) {}
  el.appendChild(title)
  el.appendChild(sub)
  el.appendChild(fillBtn)
  el.appendChild(btn)
}

function renderMessages(id, opts) {
  const t0 = performance.now()
  mtNoteRender(id, null) // the pane is about to change; a merged render below says what it left
  _renderCalls++
  _lastRenderAt = Date.now()
  try {
    return _renderMessagesImpl(id, opts)
  } finally {
    const ms = performance.now() - t0
    _closeInitMarks()
    if (ms > 100 && Date.now() - _slowRenderLoggedAt > 15000) {
      _slowRenderLoggedAt = Date.now()
      hsDiagLog('slow_render', { ms: Math.round(ms), tab: String(id).slice(0, 24), calls: _renderCalls })
    }
  }
}
