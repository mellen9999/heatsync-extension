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

// Tab ids the strip owns. A channel called "live" would shadow the live tab.
const RESERVED_TAB_IDS = ['live', 'feed', 'mentions', 'whispers', 'discover', 'pinned', 'modlog', 'add', 'settings']

/**
 * Why this channel can't be added, as a locale key — or null if it can.
 *
 * One copy on purpose. The add form, the follow-import picker and the paste
 * list all have to agree about what a duplicate is; a guard enforced at only
 * one of three entry points is not a guard.
 */
function channelAddError(twitchVal, kickVal, ytVal) {
  const id = twitchVal || kickVal || ''
  if (id && RESERVED_TAB_IDS.includes(id)) return 'mc_reserved_name'
  if (id && config.channels.some((c) => c.id === id)) return 'mc_channel_exists'
  if (twitchVal && config.channels.some((c) => c.twitch === twitchVal)) return 'mc_twitch_exists'
  if (kickVal && config.channels.some((c) => c.kick === kickVal)) return 'mc_kick_exists'
  // youtube's generated yt-<ts> id is unique every time, so the id check above
  // can never catch a repeat — it needs its own.
  if (ytVal && config.channels.some((c) => c.youtube === ytVal)) return 'mc_channel_exists'
  return null
}

/**
 * Add many channels under ONE commit.
 *
 * saveConfig() is called once after the whole loop, not once per channel:
 * _saveConfigNow does a cross-tab storage union plus a multichat:sync
 * websocket send every time it runs, so a per-channel save turns a 20-channel
 * import into 20 redundant syncs queued behind each other on the serialized
 * save chain. Skips anything channelAddError rejects — including duplicates
 * created earlier in this same batch, since config.channels grows as we go.
 *
 * @param {Array<{twitch?:string,kick?:string,youtube?:string}>} entries
 * @returns {number} how many were actually added
 */
function addChannelsBulk(entries) {
  let added = 0
  for (const e of entries) {
    const twitchVal = e.twitch || ''
    const kickVal = e.kick || ''
    const ytVal = e.youtube || ''
    if (!twitchVal && !kickVal && !ytVal) continue
    if (channelAddError(twitchVal, kickVal, ytVal)) continue

    const id = twitchVal || kickVal || `yt-${Date.now()}-${added}`
    config.channels.push({ id, twitch: twitchVal, kick: kickVal, youtube: ytVal })

    if (twitchVal) {
      irc?.join(twitchVal)
      safeSendMessage({ type: 'join_channel', platform: 'twitch', channel: twitchVal })
    }
    if (kickVal) kickChat?.join(kickVal)
    if (ytVal) {
      youtubeLinks.set(id, { url: ytVal, videoId: '', channelName: '' })
      ytSubscribedUrls.set(id, ytVal)
      ytChanLastSeen.set(id, Date.now())
      ytSubscribe(id, ytVal, id)
    }
    added++
  }
  if (added) {
    saveConfig()
    updateTabBar()
  }
  return added
}

/** Small gray text link, used for the cross-links between the three add views. */
function makeMcLink(text) {
  const a = document.createElement('button')
  a.textContent = text
  a.style.cssText =
    'background:none;border:none;padding:0;color:#808080;font-size:13px;font-family:inherit;cursor:pointer;text-decoration:underline;'
  a.addEventListener('mouseenter', () => (a.style.color = '#ffffff'))
  a.addEventListener('mouseleave', () => (a.style.color = '#808080'))
  return a
}

/** Shared shell for the add/import/paste views so all three look like one thing. */
function makeAddViewShell(msgsEl, titleText, descText) {
  _clearMessageIndices()
  msgsEl.textContent = ''
  const wrapper = document.createElement('div')
  wrapper.style.cssText =
    'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:12px;color:#a8a8a8;font-size:13px;padding:20px;box-sizing:border-box;'
  const title = document.createElement('div')
  title.textContent = titleText
  title.style.cssText = 'font-size:17px;font-weight:700;color:#ffffff;letter-spacing:.5px;'
  wrapper.appendChild(title)
  const desc = document.createElement('div')
  desc.textContent = descText
  desc.style.cssText = 'font-size:13px;color:#808080;margin-bottom:2px;'
  wrapper.appendChild(desc)
  msgsEl.appendChild(wrapper)
  return wrapper
}

/**
 * "fill my cockpit" — pick from the channels you already follow on twitch,
 * instead of typing them in one at a time.
 *
 * Twitch only, and the copy says so rather than implying otherwise: kick's
 * public api has no follow-list endpoint and there is no youtube oauth at all,
 * so "import your follows" would be a promise we can only keep on one of the
 * three platforms in the tab bar. An imported channel is twitch-only; the
 * existing per-channel autofill is how it picks up a kick/youtube counterpart
 * afterwards.
 */
async function renderFollowImportPicker(msgsEl) {
  const wrapper = makeAddViewShell(msgsEl, t('mc_fill_cockpit'), t('mc_fill_cockpit_desc'))

  const status = document.createElement('div')
  status.style.cssText = 'font-size:13px;color:#808080;font-family:ui-monospace,monospace;'
  status.textContent = t('mc_fill_cockpit_loading')
  wrapper.appendChild(status)

  const backRow = document.createElement('div')
  backRow.style.cssText = 'display:flex;gap:12px;margin-top:4px;'
  const manualLink = makeMcLink(t('mc_add_manually'))
  manualLink.addEventListener('click', () => renderAddChannelForm(msgsEl))
  backRow.appendChild(manualLink)
  wrapper.appendChild(backRow)

  let resp
  try {
    resp = await browser.runtime.sendMessage({ type: 'get_twitch_followed_channels' })
  } catch {
    resp = { error: 'twitch_unavailable' }
  }

  // Three failures, three sentences. "you follow nobody", "you're signed out"
  // and "your twitch link is dead" are different problems with different fixes,
  // and showing one message for all three is how someone ends up re-authorising
  // an account that was working fine.
  if (!resp || resp.error) {
    const err = resp?.error || 'twitch_unavailable'
    status.style.color = '#808080'
    if (err === 'login_required') {
      status.textContent = t('mc_fill_cockpit_login')
      const link = document.createElement('a')
      link.href = 'https://heatsync.org/login'
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
      link.textContent = t('mc_sign_in')
      link.style.cssText = 'color:#ffffff;font-size:13px;'
      wrapper.insertBefore(link, backRow)
    } else if (err === 'relink_required') {
      status.textContent = t('mc_fill_cockpit_relink')
      const link = document.createElement('a')
      link.href = 'https://heatsync.org/settings'
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
      link.textContent = t('mc_reconnect_twitch')
      link.style.cssText = 'color:#ffffff;font-size:13px;'
      wrapper.insertBefore(link, backRow)
    } else {
      status.textContent = t('mc_fill_cockpit_unavailable')
    }
    return
  }

  const follows = Array.isArray(resp.channels) ? resp.channels : []
  if (!follows.length) {
    status.textContent = t('mc_no_twitch_follows')
    return
  }

  // Live-sorting costs nothing extra: /api/platform/live-status is already
  // public and already proxied for the tab dots, so this reuses that exact
  // path rather than asking the server for a second opinion.
  let liveSet = new Set()
  try {
    const live = await browser.runtime.sendMessage({
      type: 'fetch_live_status',
      channels: follows.map((f) => f.login),
      kickChannels: [],
    })
    if (Array.isArray(live?.live)) liveSet = new Set(live.live.map((c) => c.toLowerCase()))
  } catch {
    // A failed live check downgrades the sort, it does not fail the import.
  }

  const already = new Set(config.channels.map((c) => c.twitch).filter(Boolean))
  const rows = follows
    .filter((f) => !already.has(f.login))
    .sort((a, b) => {
      const la = liveSet.has(a.login) ? 0 : 1
      const lb = liveSet.has(b.login) ? 0 : 1
      if (la !== lb) return la - lb
      return a.login.localeCompare(b.login)
    })

  if (!rows.length) {
    status.textContent = t('mc_all_follows_added')
    return
  }

  status.textContent = resp.truncated
    ? t('mc_channels_truncated', [String(follows.length)])
    : t('mc_follows_found', [String(rows.length), String(liveSet.size)])

  const list = document.createElement('div')
  list.style.cssText =
    'display:flex;flex-direction:column;gap:2px;width:100%;max-width:320px;max-height:240px;overflow-y:auto;border:1px solid #808080;padding:6px;box-sizing:border-box;'

  const boxes = []
  for (const f of rows) {
    const isLive = liveSet.has(f.login)
    const row = document.createElement('label')
    row.style.cssText =
      'display:flex;align-items:center;gap:8px;padding:3px 4px;cursor:pointer;font-size:13px;color:#d0d0d0;'
    row.addEventListener('mouseenter', () => {
      row.style.background = '#ffffff'
      row.style.color = '#000000'
    })
    row.addEventListener('mouseleave', () => {
      row.style.background = 'transparent'
      row.style.color = '#d0d0d0'
    })
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.checked = isLive
    box.dataset.login = f.login
    box.style.cssText = 'margin:0;accent-color:#ffffff;'
    box.setAttribute('aria-label', f.login)
    const dot = document.createElement('span')
    // The one round thing in here, deliberately — a status dot reads as a dot.
    dot.style.cssText = `width:7px;height:7px;border-radius:50%;flex:0 0 auto;background:${isLive ? 'var(--hs-live, #4ade80)' : '#3a3a3a'};`
    const name = document.createElement('span')
    name.textContent =
      f.displayName && f.displayName.toLowerCase() !== f.login ? `${f.login} (${f.displayName})` : f.login
    name.style.cssText =
      'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,monospace;'
    row.appendChild(box)
    row.appendChild(dot)
    row.appendChild(name)
    list.appendChild(row)
    boxes.push(box)
  }
  wrapper.insertBefore(list, backRow)

  const btnRow = document.createElement('div')
  btnRow.style.cssText = 'display:flex;gap:8px;margin-top:4px;'
  const addBtn = makeMcBtn(t('mc_add_selected'), true)
  const allLiveBtn = makeMcBtn(t('mc_select_all_live'), false)
  const cancelBtn = makeMcBtn('cancel', false)
  btnRow.appendChild(addBtn)
  btnRow.appendChild(allLiveBtn)
  btnRow.appendChild(cancelBtn)
  wrapper.insertBefore(btnRow, backRow)

  allLiveBtn.addEventListener('click', () => {
    for (const b of boxes) b.checked = liveSet.has(b.dataset.login)
  })
  cancelBtn.addEventListener('click', () => switchTab('live'))
  addBtn.addEventListener('click', () => {
    const picked = boxes.filter((b) => b.checked).map((b) => ({ twitch: b.dataset.login }))
    if (!picked.length) {
      status.textContent = t('mc_select_at_least_one')
      return
    }
    const added = addChannelsBulk(picked)
    if (added) switchTab(config.channels[config.channels.length - 1].id)
    else status.textContent = t('mc_nothing_added')
  })
}

/**
 * Paste-a-list bulk add — the logged-out path to a populated cockpit.
 *
 * Three boxes rather than one with a `kick:name` prefix syntax: the add form
 * already trained one twitch/kick/youtube shape, and inventing a second one
 * here would be a thing to learn for no gain. Bad lines are reported and
 * skipped, never an all-or-nothing failure — one typo in twenty must not throw
 * the other nineteen away.
 */
function renderPasteListForm(msgsEl) {
  const wrapper = makeAddViewShell(msgsEl, t('mc_paste_list'), t('mc_paste_list_desc'))

  const makeBox = (label, ph) => {
    const row = document.createElement('div')
    row.style.cssText = 'display:flex;flex-direction:column;gap:3px;width:100%;max-width:300px;'
    const lbl = document.createElement('span')
    lbl.textContent = label
    lbl.style.cssText = 'font-size:13px;font-weight:600;color:#949494;text-transform:lowercase;'
    const ta = document.createElement('textarea')
    ta.rows = 3
    ta.placeholder = ph
    ta.setAttribute('aria-label', label)
    ta.style.cssText =
      'background:#000;color:#fff;border:1px solid #808080;padding:6px 10px;border-radius:0;font-size:13px;outline:none;font-family:ui-monospace,monospace;resize:vertical;'
    ta.addEventListener('keydown', (e) => e.stopPropagation())
    row.appendChild(lbl)
    row.appendChild(ta)
    wrapper.appendChild(row)
    return ta
  }
  const twitchTa = makeBox('twitch', t('mc_paste_list_ph'))
  const kickTa = makeBox('kick', t('mc_paste_list_ph'))
  const ytTa = makeBox('youtube', t('mc_username_url_placeholder'))

  const errEl = document.createElement('div')
  errEl.style.cssText = 'font-size:13px;color:var(--hs-danger);display:none;text-align:center;max-width:300px;'
  errEl.setAttribute('role', 'alert')
  wrapper.appendChild(errEl)

  const btnRow = document.createElement('div')
  btnRow.style.cssText = 'display:flex;gap:8px;margin-top:4px;'
  const addBtn = makeMcBtn('add', true)
  const cancelBtn = makeMcBtn('cancel', false)
  btnRow.appendChild(addBtn)
  btnRow.appendChild(cancelBtn)
  wrapper.appendChild(btnRow)

  const manualLink = makeMcLink(t('mc_add_manually'))
  manualLink.addEventListener('click', () => renderAddChannelForm(msgsEl))
  wrapper.appendChild(manualLink)

  cancelBtn.addEventListener('click', () => switchTab('live'))

  // Newlines and commas only — NOT spaces. Splitting on every whitespace run
  // turns a pasted sentence into channels: "not a name!" would become three
  // entries, two of which ("not", "a") pass the charset check and become real
  // dead tabs. One line is one channel, and a line with a space in it is a
  // mistake we can report instead of silently half-accepting.
  const splitLines = (v) =>
    (v || '')
      .split(/[\n,]+/)
      .map((x) => x.trim())
      .filter(Boolean)

  addBtn.addEventListener('click', () => {
    errEl.style.display = 'none'
    const bad = []
    const entries = []
    for (const raw of splitLines(twitchTa.value)) {
      const v = parseTwitchLoginValue(raw)
      if (!/^[a-z0-9_]{1,25}$/.test(v)) bad.push(raw)
      else entries.push({ twitch: v })
    }
    for (const raw of splitLines(kickTa.value)) {
      const v = parseKickSlugValue(raw)
      if (!/^[a-z0-9_-]{1,25}$/.test(v)) bad.push(raw)
      else entries.push({ kick: v })
    }
    for (const raw of splitLines(ytTa.value)) {
      const v = normalizeYtUrl(raw)
      if (!v) bad.push(raw)
      else entries.push({ youtube: v })
    }

    if (!entries.length && !bad.length) {
      errEl.textContent = t('mc_enter_platform')
      errEl.style.display = 'block'
      return
    }

    const added = addChannelsBulk(entries)
    const skipped = entries.length - added
    if (bad.length || skipped) {
      errEl.textContent = t('mc_paste_list_result', [String(added), String(skipped + bad.length)])
      errEl.style.display = 'block'
    }
    if (added) {
      updateTabBar()
      switchTab(config.channels[config.channels.length - 1].id)
    }
  })
}

// Module-scope copies of the two parsers the add form defines inline, so the
// paste list and the picker can reuse them without reaching into a closure.
function parseTwitchLoginValue(raw) {
  let v = (raw || '').trim().replace(/^@/, '')
  const m = v.match(/twitch\.tv\/(?:popout\/|moderator\/)?([^/?#\s]+)/i)
  if (m) v = m[1]
  return v.toLowerCase()
}
function parseKickSlugValue(raw) {
  let v = (raw || '').trim().replace(/^@/, '')
  const m = v.match(/kick\.com\/([^/?#\s]+)/i)
  if (m) v = m[1]
  return v.toLowerCase()
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

  // Two ways out of typing channels in one at a time. Both are links rather
  // than buttons because adding one specific channel is still the common case
  // and should keep the primary action.
  const bulkRow = document.createElement('div')
  bulkRow.style.cssText = 'display:flex;gap:12px;margin-top:2px;'
  const importLink = makeMcLink(t('mc_import_from_twitch'))
  importLink.addEventListener('click', () => renderFollowImportPicker(msgsEl))
  const pasteLink = makeMcLink(t('mc_paste_list'))
  pasteLink.addEventListener('click', () => renderPasteListForm(msgsEl))
  bulkRow.appendChild(importLink)
  bulkRow.appendChild(pasteLink)
  wrapper.appendChild(bulkRow)

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
    // Reserved-id / duplicate rules live in channelAddError so this form, the
    // follow-import picker and the paste list can never disagree about them.
    const addErr = channelAddError(twitchVal, kickVal, ytVal)
    if (addErr) {
      showErr(t(addErr))
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
  }
  autoResolveLiveIdentity() // verified twitch↔kick handle + zero-config [Y] (social.js)
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
