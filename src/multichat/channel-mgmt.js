// channel add/edit/remove UI — split out of main.js (2026-07-04).
// renderAddChannelForm/removeChannel/showEditChannelForm/showEditLivePlatforms +
// applyLivePlatformOverrides. loadConfig/saveConfig, the config/channels state,
// and getLivePlatformNames/save+loadLivePlatformMap (read by the render engine
// and init, not just this UI) stay in main.js.

// Shared dialog button (add/edit/live-platform forms). White border = primary
// action, gray = secondary; hover snaps to white bg + black text, no motion.
function makeMcBtn(text, primary) {
  const btn = document.createElement('button')
  btn.textContent = text
  const base = primary
    ? 'background:transparent;color:#ffffff;border:1px solid #ffffff;'
    : 'background:transparent;color:#808080;border:1px solid #808080;'
  btn.style.cssText =
    base +
    'padding:6px 22px;border-radius:0;cursor:pointer;font-weight:600;font-size:14px;font-family:inherit;min-width:80px;'
  btn.addEventListener('mouseenter', () => {
    btn.style.background = '#ffffff'
    btn.style.color = '#000000'
  })
  btn.addEventListener('mouseleave', () => {
    btn.style.background = 'transparent'
    btn.style.color = primary ? '#ffffff' : '#808080'
  })
  return btn
}

function renderAddChannelForm(msgsEl) {
  _clearMessageIndices()
  msgsEl.textContent = ''
  const wrapper = document.createElement('div')
  wrapper.style.cssText =
    'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:12px;color:#a8a8a8;font-size:13px;padding:20px;box-sizing:border-box;'

  const title = document.createElement('div')
  title.textContent = t('mc_add_channel')
  title.style.cssText = 'font-size:17px;font-weight:700;color:#ffffff;letter-spacing:.5px;'
  wrapper.appendChild(title)

  const desc = document.createElement('div')
  desc.textContent = t('mc_enter_platform')
  desc.style.cssText = 'font-size:13px;color:#808080;margin-bottom:2px;'
  wrapper.appendChild(desc)

  const makeRow = (label, placeholder) => {
    const row = document.createElement('div')
    row.style.cssText = 'display:flex;align-items:center;gap:8px;width:100%;max-width:300px;'
    const lbl = document.createElement('span')
    lbl.textContent = label
    lbl.style.cssText = 'font-size:13px;font-weight:600;min-width:56px;color:#949494;text-transform:lowercase;'
    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'hs-mc-ch-input'
    input.placeholder = placeholder
    // The visible label is a separate <span>, so the input itself is unlabeled
    // to assistive tech — name it explicitly (label is 'twitch'/'kick'/'youtube').
    input.setAttribute('aria-label', label)
    input.style.cssText =
      'flex:1;background:#000;color:#fff;border:1px solid #808080;padding:6px 10px;border-radius:0;font-size:14px;outline:none;font-family:inherit;'
    // Stop YouTube/Kick keyboard shortcuts from stealing keystrokes
    input.addEventListener('keydown', (e) => e.stopPropagation())
    row.appendChild(lbl)
    row.appendChild(input)
    return { row, input }
  }

  const twitch = makeRow('twitch', t('mc_username_placeholder'))
  const kick = makeRow('kick', t('mc_username_placeholder'))
  const yt = makeRow('youtube', t('mc_username_url_placeholder'))

  wrapper.appendChild(twitch.row)
  wrapper.appendChild(kick.row)
  wrapper.appendChild(yt.row)

  // Error message (between inputs and buttons)
  const errEl = document.createElement('div')
  errEl.style.cssText = 'font-size:13px;color:var(--hs-danger);display:none;'
  errEl.setAttribute('role', 'alert')
  wrapper.appendChild(errEl)

  const btnRow = document.createElement('div')
  btnRow.style.cssText = 'display:flex;gap:8px;margin-top:4px;'

  const addBtn = makeMcBtn('add', true)
  const cancelBtn = makeMcBtn('cancel', false)

  btnRow.appendChild(addBtn)
  btnRow.appendChild(cancelBtn)
  wrapper.appendChild(btnRow)

  msgsEl.appendChild(wrapper)

  cancelBtn.addEventListener('click', () => switchTab('live'))

  const showErr = (msg) => {
    errEl.textContent = msg
    errEl.style.display = 'block'
  }

  // Parse a typed/pasted value into a clean platform slug: strip a leading
  // @, and if the user pasted a platform URL (twitch.tv/xqc, kick.com/xqc,
  // popout/mod links) reduce it to just the slug. Without this, pasting a URL
  // or a name with trailing junk created a permanent dead tab that forever
  // showed nothing (Bug #9). A malformed remainder is rejected by the charset
  // check below — a name with spaces/slashes can never be a real channel.
  const parseTwitchLogin = (raw) => {
    let v = (raw || '').trim().replace(/^@/, '')
    const m = v.match(/twitch\.tv\/(?:popout\/|moderator\/)?([^/?#\s]+)/i)
    if (m) v = m[1]
    return v.toLowerCase()
  }
  const parseKickSlug = (raw) => {
    let v = (raw || '').trim().replace(/^@/, '')
    const m = v.match(/kick\.com\/([^/?#\s]+)/i)
    if (m) v = m[1]
    return v.toLowerCase()
  }

  const doAdd = () => {
    errEl.style.display = 'none'
    const twitchVal = parseTwitchLogin(twitch.input.value)
    const kickVal = parseKickSlug(kick.input.value)
    const ytVal = yt.input.value.trim() ? normalizeYtUrl(yt.input.value.trim()) : ''

    if (!twitchVal && !kickVal && !ytVal) {
      showErr(t('mc_enter_platform'))
      return
    }

    // Charset gate — a slug outside the platform's allowed character set can
    // never resolve to a real channel (twitch [a-z0-9_], kick adds '-'), so a
    // typo with spaces or a half-parsed URL is rejected here instead of
    // becoming a silent dead tab. Real channel names always pass.
    if (twitchVal && !/^[a-z0-9_]{1,25}$/.test(twitchVal)) {
      showErr(t('mc_invalid_name'))
      return
    }
    if (kickVal && !/^[a-z0-9_-]{1,25}$/.test(kickVal)) {
      showErr(t('mc_invalid_name'))
      return
    }

    const id = twitchVal || kickVal || `yt-${Date.now()}`
    const reserved = ['live', 'feed', 'mentions', 'whispers', 'discover', 'pinned', 'modlog', 'add', 'settings']
    if (reserved.includes(id)) {
      showErr(t('mc_reserved_name'))
      return
    }
    if (config.channels.some((c) => c.id === id)) {
      showErr(t('mc_channel_exists'))
      return
    }
    // Check duplicate Twitch/Kick username across channels
    if (twitchVal && config.channels.some((c) => c.twitch === twitchVal)) {
      showErr(t('mc_twitch_exists'))
      return
    }
    if (kickVal && config.channels.some((c) => c.kick === kickVal)) {
      showErr(t('mc_kick_exists'))
      return
    }
    // youtube had no duplicate guard while twitch and kick both did — and its
    // generated `yt-<ts>` id is unique every time, so the id check above can
    // never catch it. Adding the same channel twice gave two tabs fed by one
    // subscription.
    if (ytVal && config.channels.some((c) => c.youtube === ytVal)) {
      showErr(t('mc_channel_exists'))
      return
    }

    const channel = { id, twitch: twitchVal, kick: kickVal, youtube: ytVal }
    config.channels.push(channel)
    saveConfig()

    if (twitchVal) {
      irc?.join(twitchVal)
      safeSendMessage({ type: 'join_channel', platform: 'twitch', channel: twitchVal })
    }
    if (kickVal) {
      kickChat?.join(kickVal)
    }
    if (ytVal) {
      youtubeLinks.set(id, { url: ytVal, videoId: '', channelName: '' })
      ytSubscribedUrls.set(id, ytVal)
      ytChanLastSeen.set(id, Date.now())
      // 7TV/BTTV YouTube channel emotes ride along — the emote channelId is a
      // hint (the typed url/handle); background.js resolves the real UC... id.
      ytSubscribe(id, ytVal, id)
    }

    updateTabBar()
    switchTab(id)
  }

  addBtn.addEventListener('click', doAdd)
  // Tab cycles inputs, Enter submits, Escape cancels
  const inputs = [twitch.input, kick.input, yt.input]
  inputs.forEach((inp, i) => {
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault()
        inputs[(i + (e.shiftKey ? inputs.length - 1 : 1)) % inputs.length].focus()
      }
      if (e.key === 'Enter') doAdd()
      if (e.key === 'Escape') switchTab('live')
    })
    // Track user edits per-field so autofill never overwrites typed input
    inp.addEventListener('input', () => {
      inp.dataset.userEdited = '1'
    })
  })

  // Heatsync linkage status indicator (between rows and error)
  const linkStatus = document.createElement('div')
  linkStatus.style.cssText = 'font-size:13px;color:#808080;min-height:14px;font-family:ui-monospace,monospace;'
  wrapper.insertBefore(linkStatus, errEl)

  // Debounced autofill — when user types in any field, look up that name on
  // heatsync and prefill the OTHER fields if they haven't been edited.
  let _autofillGen = 0
  let _autofillTimer = null
  const _autofillCancelable = (handler) => {
    if (_autofillTimer) cleanup.clearTimeout(_autofillTimer)
    _autofillTimer = cleanup.setTimeout(handler, 500)
  }

  async function autofillFromName(name, sourcePlatform) {
    if (!name) {
      linkStatus.textContent = ''
      return
    }
    const gen = ++_autofillGen
    linkStatus.textContent = 'checking heatsync…'
    linkStatus.style.color = '#808080'
    const res =
      typeof resolveIdentity === 'function' ? await resolveIdentity(name, { platform: sourcePlatform }) : { ok: false }
    if (gen !== _autofillGen) return
    if (!res?.ok) {
      linkStatus.textContent = res?.notFound ? 'no heatsync profile — fill manually' : "couldn't reach heatsync"
      linkStatus.style.color = '#666'
      return
    }
    const id = res.identity
    const platforms = []
    // Fill ONLY empty + non-user-edited fields
    const fillIfBlank = (input, value, label) => {
      if (!value) return
      if (input.dataset.userEdited === '1' && input.value.trim()) return
      if (input.value.trim()) return
      input.value = value
      platforms.push(label)
    }
    fillIfBlank(twitch.input, id.twitch, 't')
    fillIfBlank(kick.input, id.kick, 'k')
    fillIfBlank(yt.input, id.youtube, 'yt')
    const linkedLabels = []
    if (id.twitch) linkedLabels.push('t')
    if (id.kick) linkedLabels.push('k')
    if (id.youtube) linkedLabels.push('yt')
    const liveLabels = res.liveOn?.length
      ? ` · live on ${res.liveOn.map((p) => (p === 'twitch' ? 't' : p === 'kick' ? 'k' : p)).join(',')}`
      : ''
    linkStatus.style.color = 'var(--hs-plat-kick)'
    linkStatus.textContent = `✓ matched ${id.heatsync || name} on heatsync — linked: ${linkedLabels.join(',') || 'none'}${liveLabels}${platforms.length ? ` · autofilled: ${platforms.join(',')}` : ''}`
  }

  twitch.input.addEventListener('input', () => {
    const v = twitch.input.value.trim().replace(/^@/, '')
    if (v.length >= 2) _autofillCancelable(() => autofillFromName(v, 'twitch'))
  })
  kick.input.addEventListener('input', () => {
    const v = kick.input.value.trim().replace(/^@/, '')
    if (v.length >= 2) _autofillCancelable(() => autofillFromName(v, 'kick'))
  })

  // Auto-focus twitch input
  cleanup.raf(() => twitch.input.focus())
}

/**
 * Move a channel one slot up or down in the strip. Tab mode's J/K is the only
 * caller — there has never been a reorder path here, drag or otherwise, so the
 * order you added channels in was the order you were stuck with.
 *
 * Refuses at the ends rather than wrapping: the strip also holds the fixed
 * surfaces (feed/mentions/live), so wrapping would look like a channel jumping
 * across them.
 *
 * @param {string} tabId
 * @param {number} delta -1 up, 1 down
 * @returns {boolean} whether it actually moved
 */
function moveChannelOrder(tabId, delta) {
  const list = config?.channels
  if (!Array.isArray(list)) return false
  const from = list.findIndex((c) => c.id === tabId)
  const to = from + delta
  if (from < 0 || to < 0 || to >= list.length) return false
  const [moved] = list.splice(from, 1)
  list.splice(to, 0, moved)
  saveConfig()
  updateTabBar()
  return true
}

function removeChannel(tabId) {
  const ch = getChannelById(tabId)
  config.channels = config.channels.filter((c) => c.id !== tabId)
  saveConfig()
  _dropTabCache(tabId)
  // Drop the tab's unread/heat state too — otherwise re-adding the same
  // channel later inherits a stale count from before it was removed.
  dropTabActivity(tabId)

  const twitchName = ch?.twitch
  if (twitchName) irc?.part(twitchName)

  const kickName = ch?.kick
  if (kickName) kickChat?.part(kickName)

  // Clean up per-channel sub tenure data to prevent stale map growth
  if (twitchName) subTenureMap.delete(twitchName.toLowerCase())
  if (kickName) subTenureMap.delete(kickName.toLowerCase())

  // Unsubscribe per-channel YouTube (pass URL as fallback if videoId not yet received)
  if (ch?.youtube) {
    const link = youtubeLinks.get(tabId)
    chrome.runtime
      .sendMessage({
        type: 'youtube_ws_unsubscribe',
        videoId: link?.videoId || '',
        url: ch.youtube,
        channelId: tabId,
      })
      .catch(() => {})
    clearYtPace(tabId)
    youtubeLinks.delete(tabId)
    channelYtMessages.delete(tabId)
    // Clear YT watchdog state too — otherwise the 180s rejoin loop resurrects
    // a removed channel forever and periodically force-reconnects the shared
    // WS that every channel rides on.
    ytChanLastSeen.delete(tabId)
    ytChanRejoinAttempts.delete(tabId)
    ytSubscribedUrls.delete(tabId)
  }

  // Drop per-tab platform filter state so it can't leak across channel adds/removes
  if (platformFilters?.[tabId]) {
    delete platformFilters[tabId]
    saveUiSetting('platformFilters', platformFilters)
  }

  updateTabBar()
  if (currentTab === tabId) switchTab('live')
}

// Apply live platform overrides — join the correct channels on each platform
function applyLivePlatformOverrides() {
  const names = getLivePlatformNames()
  if (names.twitch) irc?.join(names.twitch)
  if (names.kick) kickChat?.join(names.kick)
  if (names.youtube) {
    ytSubscribedUrls.set('__live_yt_auto__', names.youtube)
    ytChanLastSeen.set('__live_yt_auto__', Date.now())
    ytSubscribe('__live_yt_auto__', names.youtube)
  } else {
    autoResolveLiveYt() // zero-config [Y] via heatsync identity (social.js)
  }
  renderMessages(currentTab)
}

function showEditLivePlatforms() {
  const urlCh = getCurrentChannel()?.toLowerCase()
  if (!urlCh) return
  editingChannel = true
  const names = getLivePlatformNames()

  const msgsEl = document.getElementById('hs-mc-messages')
  if (!msgsEl) return
  _clearMessageIndices()
  msgsEl.textContent = ''

  const wrapper = document.createElement('div')
  wrapper.style.cssText =
    'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:12px;color:#a8a8a8;font-size:13px;padding:20px;box-sizing:border-box;'

  const title = document.createElement('div')
  title.textContent = `edit live — ${urlCh}`
  title.style.cssText = 'font-size:17px;font-weight:700;color:#ffffff;letter-spacing:.5px;'
  wrapper.appendChild(title)

  const makeRow = (label, placeholder, value) => {
    const row = document.createElement('div')
    row.style.cssText = 'display:flex;align-items:center;gap:8px;width:100%;max-width:300px;'
    const lbl = document.createElement('span')
    lbl.textContent = label
    lbl.style.cssText = 'font-size:13px;font-weight:600;min-width:56px;color:#949494;text-transform:lowercase;'
    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'hs-mc-ch-input'
    input.placeholder = placeholder
    input.value = value || ''
    input.style.cssText =
      'flex:1;background:#000;color:#fff;border:1px solid #808080;padding:6px 10px;border-radius:0;font-size:14px;outline:none;font-family:inherit;'
    input.addEventListener('keydown', (e) => e.stopPropagation())
    row.appendChild(lbl)
    row.appendChild(input)
    return { row, input }
  }

  const twitch = makeRow('twitch', 'username', names.twitch)
  const kick = makeRow('kick', 'username', names.kick)
  const yt = makeRow('youtube', 'url or @handle', names.youtube)
  wrapper.appendChild(twitch.row)
  wrapper.appendChild(kick.row)
  wrapper.appendChild(yt.row)

  const btnRow = document.createElement('div')
  btnRow.style.cssText = 'display:flex;gap:8px;margin-top:4px;'

  const saveBtn = makeMcBtn('save', true)
  const cancelBtn = makeMcBtn('cancel', false)
  const resetBtn = makeMcBtn('reset', false)
  btnRow.appendChild(saveBtn)
  btnRow.appendChild(cancelBtn)
  btnRow.appendChild(resetBtn)
  wrapper.appendChild(btnRow)
  msgsEl.appendChild(wrapper)

  cancelBtn.addEventListener('click', () => {
    editingChannel = false
    switchTab('live')
  })

  resetBtn.addEventListener('click', () => {
    delete livePlatformMap[urlCh]
    saveLivePlatformMap()
    editingChannel = false
    applyLivePlatformOverrides()
    switchTab('live')
  })

  const doSave = () => {
    const tw = twitch.input.value.trim().toLowerCase().replace(/^@/, '')
    const ki = kick.input.value.trim().toLowerCase().replace(/^@/, '')
    const ytVal = yt.input.value.trim() ? normalizeYtUrl(yt.input.value.trim()) : ''

    livePlatformMap[urlCh] = { twitch: tw, kick: ki, youtube: ytVal }
    saveLivePlatformMap()
    editingChannel = false
    applyLivePlatformOverrides()
    switchTab('live')
  }

  saveBtn.addEventListener('click', doSave)
  // Enter in any input saves
  ;[twitch.input, kick.input, yt.input].forEach((inp) => {
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        doSave()
      }
    })
  })
  // Esc cancels
  wrapper.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      editingChannel = false
      switchTab('live')
    }
  })
  twitch.input.focus()
}

function showEditChannelForm(tabId) {
  const ch = getChannelById(tabId)
  if (!ch) return
  editingChannel = true

  const msgsEl = document.getElementById('hs-mc-messages')
  if (!msgsEl) return
  _clearMessageIndices()
  msgsEl.textContent = ''

  const wrapper = document.createElement('div')
  wrapper.style.cssText =
    'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:12px;color:#a8a8a8;font-size:13px;padding:20px;box-sizing:border-box;'

  const title = document.createElement('div')
  title.textContent = t('mc_edit_channel', [tabId])
  title.style.cssText = 'font-size:17px;font-weight:700;color:#ffffff;letter-spacing:.5px;'
  wrapper.appendChild(title)

  const makeRow = (label, placeholder, value) => {
    const row = document.createElement('div')
    row.style.cssText = 'display:flex;align-items:center;gap:8px;width:100%;max-width:300px;'
    const lbl = document.createElement('span')
    lbl.textContent = label
    lbl.style.cssText = 'font-size:13px;font-weight:600;min-width:56px;color:#949494;text-transform:lowercase;'
    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'hs-mc-ch-input'
    input.placeholder = placeholder
    input.value = value || ''
    input.style.cssText =
      'flex:1;background:#000;color:#fff;border:1px solid #808080;padding:6px 10px;border-radius:0;font-size:14px;outline:none;font-family:inherit;'
    // Stop YouTube/Kick keyboard shortcuts from stealing keystrokes
    input.addEventListener('keydown', (e) => e.stopPropagation())
    row.appendChild(lbl)
    row.appendChild(input)
    return { row, input }
  }

  const twitch = makeRow('twitch', t('mc_username_placeholder'), ch.twitch)
  const kick = makeRow('kick', t('mc_username_placeholder'), ch.kick)
  const yt = makeRow('youtube', t('mc_username_url_placeholder'), ch.youtube)
  wrapper.appendChild(twitch.row)
  wrapper.appendChild(kick.row)
  wrapper.appendChild(yt.row)

  const errEl = document.createElement('div')
  errEl.style.cssText = 'font-size:13px;color:var(--hs-danger);display:none;'
  errEl.setAttribute('role', 'alert')
  wrapper.appendChild(errEl)

  const btnRow = document.createElement('div')
  btnRow.style.cssText = 'display:flex;gap:8px;margin-top:4px;'

  const saveBtn = makeMcBtn('save', true)
  const cancelBtn = makeMcBtn('cancel', false)
  btnRow.appendChild(saveBtn)
  btnRow.appendChild(cancelBtn)
  wrapper.appendChild(btnRow)
  msgsEl.appendChild(wrapper)

  cancelBtn.addEventListener('click', () => switchTab(tabId))
  const showErr = (msg) => {
    errEl.textContent = msg
    errEl.style.display = 'block'
  }

  const doSave = () => {
    errEl.style.display = 'none'
    const twitchVal = twitch.input.value.trim().toLowerCase().replace(/^@/, '')
    const kickVal = kick.input.value.trim().toLowerCase().replace(/^@/, '')
    const ytVal = yt.input.value.trim() ? normalizeYtUrl(yt.input.value.trim()) : ''

    if (!twitchVal && !kickVal && !ytVal) {
      showErr(t('mc_enter_platform'))
      return
    }

    // Check duplicate twitch/kick (excluding self)
    if (twitchVal && config.channels.some((c) => c !== ch && c.twitch === twitchVal)) {
      showErr(t('mc_twitch_exists'))
      return
    }
    if (kickVal && config.channels.some((c) => c !== ch && c.kick === kickVal)) {
      showErr(t('mc_kick_exists'))
      return
    }

    // Part old channels if changed
    const oldTwitch = ch.twitch
    const oldKick = ch.kick
    const oldYt = ch.youtube

    if (oldTwitch && oldTwitch !== twitchVal) irc?.part(oldTwitch)
    if (oldKick && oldKick !== kickVal) kickChat?.part(oldKick)

    // Unsubscribe old YouTube if changed
    if (oldYt && oldYt !== ytVal) {
      const oldLink = youtubeLinks.get(tabId)
      chrome.runtime
        .sendMessage({
          type: 'youtube_ws_unsubscribe',
          videoId: oldLink?.videoId || '',
          url: oldYt,
          channelId: tabId,
        })
        .catch(() => {})
      clearYtPace(tabId)
      youtubeLinks.delete(tabId)
      channelYtMessages.delete(tabId)
      ytChanLastSeen.delete(tabId)
      ytChanRejoinAttempts.delete(tabId)
      ytSubscribedUrls.delete(tabId)
    }

    // Update channel config
    ch.twitch = twitchVal
    ch.kick = kickVal
    ch.youtube = ytVal

    // Update id to match primary platform
    const newId = twitchVal || kickVal || ch.id
    if (newId !== ch.id) {
      // Migrate maps keyed by old id
      const ytData = youtubeLinks.get(tabId)
      const ytMsgs = channelYtMessages.get(tabId)
      if (ytData) {
        youtubeLinks.delete(tabId)
        youtubeLinks.set(newId, ytData)
      }
      if (ytMsgs) {
        channelYtMessages.delete(tabId)
        channelYtMessages.set(newId, ytMsgs)
      }
      for (const map of [ytChanLastSeen, ytChanRejoinAttempts, ytSubscribedUrls]) {
        if (map.has(tabId)) {
          map.set(newId, map.get(tabId))
          map.delete(tabId)
        }
      }
      if (ytVal && ytVal === oldYt) {
        chrome.runtime
          .sendMessage({
            type: 'youtube_ws_unsubscribe',
            videoId: ytData?.videoId || '',
            url: ytVal,
            channelId: tabId,
          })
          .catch(() => {})
        // Pacer state is keyed by channelId — the old key is orphaned by the
        // id migration, so its queued drip would never flush.
        clearYtPace(tabId)
        ytSubscribe(newId, ytVal)
      }
      if (platformFilters?.[tabId]) {
        platformFilters[newId] = platformFilters[tabId]
        delete platformFilters[tabId]
        saveUiSetting('platformFilters', platformFilters)
      }
      _dropTabCache(tabId)
      ch.id = newId
    }
    saveConfig()

    // Join new channels if changed
    if (twitchVal && twitchVal !== oldTwitch) {
      irc?.join(twitchVal)
      safeSendMessage({ type: 'join_channel', platform: 'twitch', channel: twitchVal })
    }
    if (kickVal && kickVal !== oldKick) kickChat?.join(kickVal)
    if (ytVal && ytVal !== oldYt) {
      youtubeLinks.set(newId, { url: ytVal, videoId: '', channelName: '' })
      ytSubscribedUrls.set(newId, ytVal)
      ytChanLastSeen.set(newId, Date.now())
      ytSubscribe(newId, ytVal, newId)
    }

    updateTabBar()
    switchTab(newId)
  }

  saveBtn.addEventListener('click', doSave)
  const inputs = [twitch.input, kick.input, yt.input]
  inputs.forEach((inp, i) => {
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault()
        inputs[(i + (e.shiftKey ? inputs.length - 1 : 1)) % inputs.length].focus()
      }
      if (e.key === 'Enter') doSave()
      if (e.key === 'Escape') switchTab(tabId)
    })
  })
  cleanup.raf(() => twitch.input.focus())
}
