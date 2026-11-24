/**
 * Kick emoji + heatsync emote autocomplete
 *
 * Lightweight hook for Kick's contenteditable div.editor-input.
 * emoji-data.js must be loaded before this script.
 *
 * One list, two triggers: a bare word >= 2 chars, or `:word` (emotes and emoji). Both ask the emote
 * law's offer (content.js -> multichat-core) over this page's channel: no ranking lives here.
 */
;(() => {
  const DEBUG = false
  const log = DEBUG ? console.log.bind(console, '[hs-kick-ac]') : () => {}

  // Kill previous instance on extension reload
  if (window.__heatsyncKickAcLifecycle) {
    try {
      window.__heatsyncKickAcLifecycle.abort()
    } catch (_) {}
  }

  // Hoisted: abort handler may fire during init (bfcache pagehide race)
  let emoteDropdown = null
  let hsEmoteList = []
  let hsEmoteByName = new Map()
  let emoteDebounceTimer = null

  const lifecycle = new AbortController()
  window.__heatsyncKickAcLifecycle = lifecycle
  const sig = lifecycle.signal
  window.addEventListener('pagehide', () => lifecycle.abort())
  sig.addEventListener('abort', () => {
    clearTimeout(emoteDebounceTimer)
    if (emoteDropdown) {
      try {
        emoteDropdown.remove()
      } catch (_) {}
      emoteDropdown = null
    }
    hsEmoteList = []
  })

  // :shortcode: -> emoji, for the closing colon
  const EMOJI_MAP = {}
  if (typeof EMOJI_DATA !== 'undefined') for (const e of EMOJI_DATA) EMOJI_MAP[e.name] = e.emoji
  if (!Object.keys(EMOJI_MAP).length) {
    log('no emoji data, bailing')
    return
  }

  // ---- heatsync emote cache ----
  // Flat array of { name, url } — refreshed on channel detect or on demand
  // hsEmoteList hoisted above (abort handler references it)
  let hsEmotesLastFetch = 0
  const HS_EMOTE_TTL = 60000 // 1 min

  function getCurrentChannel() {
    // kick.com/channelname or kick.com/channelname/...
    const m = location.pathname.match(/^\/([^/?#]+)/)
    return m ? m[1].toLowerCase() : null
  }

  // the emote strip's lookup by word (not a ranking: the offer is content.js's)
  function buildEmoteList(data) {
    const blocked = new Set(data.blocked || [])
    const seen = new Set()
    const list = []
    // channel first: the first copy of a name is the one this channel draws
    for (const e of [...(data.channelEmotes || []), ...(data.inventoryEmotes || []), ...(data.globalEmotes || [])]) {
      if (!e?.name || blocked.has(e.hash) || seen.has(e.name)) continue
      seen.add(e.name)
      list.push({ name: e.name, url: e.url || e.cdnUrl || '', source: e.source })
    }
    return list
  }

  function refreshEmotes(channel) {
    const now = Date.now()
    if (now - hsEmotesLastFetch < HS_EMOTE_TTL) return
    try {
      chrome.runtime.sendMessage(
        { type: 'get_picker_emotes', channel: channel || getCurrentChannel(), platform: 'kick' },
        (data) => {
          if (chrome.runtime.lastError || !data) return
          hsEmotesLastFetch = now
          hsEmoteList = buildEmoteList(data)
          hsEmoteByName = new Map(hsEmoteList.map((e) => [e.name, e]))
          log('emote list refreshed:', hsEmoteList.length)
        },
      )
    } catch (_) {}
  }

  // the one list: the emote law's, read over this page's channel (content.js, multichat-core)
  const offer = (word) => (typeof window.heatsyncNativeOffer === 'function' ? window.heatsyncNativeOffer(word) : [])

  // ---- shared state ----
  const EMOTE_DROPDOWN_ID = 'hs-kick-emote-dropdown'
  const MAX_RESULTS = 8
  // emoteDropdown, emoteDebounceTimer hoisted above
  let selectedIdx = 0
  let matches = []
  let activeInput = null

  function injectStyles() {
    if (document.getElementById('heatsync-kick-ac-styles')) return
    const style = document.createElement('style')
    style.id = 'heatsync-kick-ac-styles'
    style.textContent = `
      #${EMOTE_DROPDOWN_ID} {
        position: fixed;
        z-index: 99999;
        background: #000000;
        border: 1px solid #ffffff;
        border-radius: 0;
        padding: 4px 0;
        max-height: 280px;
        overflow-y: auto;
        font-family: monospace;
        font-size: 13px;
        display: none;
      }
      #${EMOTE_DROPDOWN_ID} .hs-ac-item {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 12px;
        cursor: pointer;
        color: #fff;
      }
      #${EMOTE_DROPDOWN_ID} .hs-ac-item.selected,
      #${EMOTE_DROPDOWN_ID} .hs-ac-item:hover {
        background: #fff;
        color: #000;
      }
      #${EMOTE_DROPDOWN_ID} .hs-ac-emoji {
        font-size: 18px;
        width: 24px;
        text-align: center;
      }
      #${EMOTE_DROPDOWN_ID} .hs-ac-name {
        color: #ffffff;
        flex: 1;
      }
      #${EMOTE_DROPDOWN_ID} .hs-ac-item.selected .hs-ac-name,
      #${EMOTE_DROPDOWN_ID} .hs-ac-item:hover .hs-ac-name {
        color: #000;
      }
      #${EMOTE_DROPDOWN_ID} .hs-ac-vis {
        flex-shrink: 0;
        margin-left: 8px;
      }
      #${EMOTE_DROPDOWN_ID} .hs-ac-vis.v-all { color: #00ff00; }
      #${EMOTE_DROPDOWN_ID} .hs-ac-vis.v-ext { color: #ffff00; }
      #${EMOTE_DROPDOWN_ID} .hs-ac-vis.v-hs  { color: #fff; }
      #${EMOTE_DROPDOWN_ID} .hs-ac-vis.v-dim { color: #ffffff; }
      #${EMOTE_DROPDOWN_ID} .hs-ac-item.selected .hs-ac-vis,
      #${EMOTE_DROPDOWN_ID} .hs-ac-item:hover .hs-ac-vis { color: #000; }
      #${EMOTE_DROPDOWN_ID} .hs-ac-img {
        width: 28px;
        height: 28px;
        object-fit: contain;
        flex-shrink: 0;
      }
      #${EMOTE_DROPDOWN_ID} .hs-ac-placeholder {
        width: 28px;
        height: 28px;
        background: #000000;
        border-radius: 0;
        flex-shrink: 0;
      }
    `
    document.head.appendChild(style)
  }

  function createEmoteDropdown() {
    if (emoteDropdown) return emoteDropdown
    emoteDropdown = document.createElement('div')
    emoteDropdown.id = EMOTE_DROPDOWN_ID
    document.body.appendChild(emoteDropdown)
    return emoteDropdown
  }

  function hideEmoteDropdown() {
    if (emoteDropdown) emoteDropdown.style.display = 'none'
    matches = []
    selectedIdx = 0
  }

  // Per-row visibility tag — same wedge signal as the cycle readout on the other
  // surfaces: who actually sees this emote if you send it. Color grades by reach:
  // green everyone/native → yellow {provider} (needs that ext) → white heatsync
  // only (your set; non-heatsync viewers get plain text). Unknown source falls back
  // to the neutral category so it never asserts a wrong visibility.
  function hsVisTag(r) {
    if (r.isChatter) return { t: 'everyone', cls: 'v-all' }
    if (r.emoji) return { t: 'emoji', cls: 'v-all' }
    const tier = r.tier ?? 2
    const src = (r.source || '').toLowerCase()
    if (src === 'twitch' || src === 'kick') return { t: src, cls: 'v-all' }
    if (tier === 1 || src === 'heatsync' || src === 'inventory') return { t: 'heatsync', cls: 'v-hs' }
    if (src === '7tv' || src === 'bttv' || src === 'ffz') return { t: src, cls: 'v-ext' }
    return { t: tier === 0 ? 'channel' : tier === 1 ? 'mine' : 'global', cls: 'v-dim' }
  }

  function renderEmoteItems(container, results) {
    container.textContent = ''
    results.forEach((r, i) => {
      const item = document.createElement('div')
      item.className = `hs-ac-item${i === 0 ? ' selected' : ''}`
      item.dataset.idx = i

      if (r.emoji) {
        const glyph = document.createElement('span')
        glyph.className = 'hs-ac-emoji'
        glyph.textContent = r.emoji
        item.appendChild(glyph)
      } else if (r.url && /^https:\/\//.test(r.url)) {
        const img = document.createElement('img')
        img.className = 'hs-ac-img'
        img.src = r.url
        img.alt = r.name
        img.loading = 'lazy'
        item.appendChild(img)
      } else if (!r.isChatter) {
        const ph = document.createElement('span')
        ph.className = 'hs-ac-placeholder'
        item.appendChild(ph)
      }

      const nameSpan = document.createElement('span')
      nameSpan.className = 'hs-ac-name'
      // escapeHtml equivalent — textContent is safe
      nameSpan.textContent = r.name

      item.appendChild(nameSpan)

      const vis = hsVisTag(r)
      const visSpan = document.createElement('span')
      visSpan.className = `hs-ac-vis ${vis.cls}`
      visSpan.textContent = vis.t
      item.appendChild(visSpan)

      item.addEventListener('mousedown', (e) => {
        e.preventDefault()
        insertPick(activeInput, results[i])
      })

      container.appendChild(item)
    })
  }

  function positionAboveInput(el, input) {
    const rect = input.getBoundingClientRect()
    el.style.left = `${rect.left}px`
    el.style.bottom = `${window.innerHeight - rect.top + 4}px`
    el.style.top = 'auto'
    el.style.minWidth = `${Math.min(rect.width, 280)}px`
  }

  function showEmoteDropdown(input, results) {
    if (!results.length) {
      hideEmoteDropdown()
      return
    }
    createEmoteDropdown()
    matches = results
    selectedIdx = 0

    renderEmoteItems(emoteDropdown, results)
    positionAboveInput(emoteDropdown, input)
    emoteDropdown.style.display = 'block'
  }

  function updateSelection() {
    const container = emoteDropdown
    if (!container) return
    container.querySelectorAll('.hs-ac-item').forEach((el, i) => {
      el.classList.toggle('selected', i === selectedIdx)
    })
    const sel = container.querySelector('.selected')
    if (sel) sel.scrollIntoView({ block: 'nearest' })
  }

  // Get text before cursor in contenteditable
  function getTextBeforeCursor(el) {
    const selection = window.getSelection()
    if (!selection.rangeCount) return ''
    const range = selection.getRangeAt(0)
    if (!el.contains(range.startContainer)) return ''
    const preRange = document.createRange()
    preRange.selectNodeContents(el)
    preRange.setEnd(range.startContainer, range.startOffset)
    return preRange.toString()
  }

  // Kick's editor (lexical) learns the selection from `selectionchange`; an edit issued in the same
  // tick as the selection still sees the caret and lands at the end, so "kappa"+Tab left "kappa" behind.
  // Select the word, wait for the editor to take it, and only edit when it holds exactly that word.
  function selectionTaken() {
    return new Promise((resolve) => {
      const done = () => {
        document.removeEventListener('selectionchange', done)
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(done, 80)
      document.addEventListener('selectionchange', done)
    })
  }

  /** replace the `word` just before the caret with `text` */
  async function replaceBefore(input, word, text) {
    input.focus()
    const sel = window.getSelection()
    if (!sel.rangeCount) return false
    for (let i = 0; i < word.length; i++) sel.modify('extend', 'backward', 'character')
    await selectionTaken()
    if (sig.aborted || sel.toString() !== word) return false
    return document.execCommand('insertText', false, text)
  }

  // Replace the word under the caret (`:word` for the colon list) with the picked row
  function insertPick(input, match) {
    const text = getTextBeforeCursor(input)
    const wordMatch = text.match(/(\S+)$/)
    const colonMatch = match.colon && text.match(/:([A-Za-z0-9_+-]*)$/)
    if (!wordMatch || (match.colon && !colonMatch)) {
      hideEmoteDropdown()
      return
    }
    // @-mention rows carry isMention (see the '@' branch in handleInput) —
    // the query itself never keeps the '@' (stripped for the chatter lookup),
    // so restore it here on insert. Not an emote usage, so no MRU bump.
    if (match.isMention) {
      // textContent-safe: usernames are alphanumeric + underscore
      replaceBefore(input, wordMatch[0], `@${match.name} `)
      hideEmoteDropdown()
      log('inserted mention', match.name)
      return
    }
    if (match.emoji) {
      replaceBefore(input, colonMatch[0], `${match.emoji} `)
      hideEmoteDropdown()
      log('inserted', match.name, match.emoji)
      return
    }
    // textContent-safe: emote names are alphanumeric + limited punctuation
    replaceBefore(input, match.colon ? colonMatch[0] : wordMatch[0], `${match.name} `)
    hideEmoteDropdown()
    // chatter rows aren't emote usage — keep usernames out of the shared signal
    if (!match.isChatter) recordRecentEmoteMru(match.name)
    log('inserted emote', match.name)
  }

  // Shared usage signal with the multichat picker/tab-complete (emotes.js) —
  // same origin, same localStorage keys, so kick-native completions feed the
  // frecency the offer reads. Two stores: the legacy MRU list
  // (drives the picker's "recent" section) and the frecency map (use count
  // with a one-week half-life). Logic MUST mirror emotes.js
  // loadEmoteFrecency/bumpEmoteFrecency exactly (same as autocomplete-hook.js).
  const HS_RECENT_EMOTES_KEY = 'hs-mc-recent-emotes'
  const HS_FRECENCY_KEY = 'hs-mc-emote-frecency'
  const HS_FRECENCY_CAP = 200
  const HS_FRECENCY_HALF_LIFE_MS = 7 * 24 * 3600e3
  function _hsFrecScore(entry, now) {
    if (!entry || !(entry.n > 0)) return 0
    const age = Math.max(0, now - (entry.t || 0))
    return entry.n * 2 ** (-age / HS_FRECENCY_HALF_LIFE_MS)
  }
  function _hsFrecRaw() {
    try {
      const r = JSON.parse(localStorage.getItem(HS_FRECENCY_KEY))
      if (r && typeof r === 'object' && !Array.isArray(r)) return r
    } catch (_) {}
    // First run: seed from the legacy MRU list (same migration as emotes.js).
    const seeded = {}
    try {
      const legacy = JSON.parse(localStorage.getItem(HS_RECENT_EMOTES_KEY))
      if (Array.isArray(legacy)) {
        for (let i = 0; i < legacy.length; i++) seeded[legacy[i]] = { n: 1, t: Date.now() - i * 3600e3 }
      }
    } catch (_) {}
    return seeded
  }
  function bumpEmoteFrecency(name) {
    if (!name) return
    try {
      const raw = _hsFrecRaw()
      const now = Date.now()
      raw[name] = { n: _hsFrecScore(raw[name], now) + 1, t: now }
      const names = Object.keys(raw)
      if (names.length > HS_FRECENCY_CAP) {
        names.sort((a, b) => _hsFrecScore(raw[a], now) - _hsFrecScore(raw[b], now))
        for (const dead of names.slice(0, names.length - HS_FRECENCY_CAP)) delete raw[dead]
      }
      localStorage.setItem(HS_FRECENCY_KEY, JSON.stringify(raw))
    } catch (_) {}
  }
  function recordRecentEmoteMru(name) {
    if (!name) return
    try {
      let list = []
      try {
        const r = JSON.parse(localStorage.getItem(HS_RECENT_EMOTES_KEY))
        list = Array.isArray(r) ? r : []
      } catch (_) {}
      list = list.filter((n) => n !== name)
      list.unshift(name)
      if (list.length > 24) list = list.slice(0, 24)
      localStorage.setItem(HS_RECENT_EMOTES_KEY, JSON.stringify(list))
    } catch (_) {}
    bumpEmoteFrecency(name)
  }

  function handleInput(e) {
    const input = e.target.closest('div.editor-input')
    if (!input) return
    activeInput = input

    const text = getTextBeforeCursor(input)

    // Check for closing colon — auto-convert :shortcode:
    const closingMatch = text.match(/:([a-z0-9_+-]+):$/)
    if (closingMatch) {
      const emoji = EMOJI_MAP[closingMatch[1]]
      if (emoji) {
        const sel = window.getSelection()
        if (sel.rangeCount) {
          replaceBefore(input, closingMatch[0], `${emoji} `)
          log(`auto-converted :${closingMatch[1]}: →`, emoji)
          hideEmoteDropdown()
          return
        }
      }
    }

    // `:word` (no closing colon): the `:` list, emotes and emoji, in the order the setting picks
    const colonMatch = text.match(/:([A-Za-z0-9_+-]{1,})$/)
    if (colonMatch) {
      clearTimeout(emoteDebounceTimer)
      const results = offer(colonMatch[0])
        .slice(0, MAX_RESULTS)
        .map((r) => ({ ...r, colon: true }))
      if (activeInput) showEmoteDropdown(activeInput, results)
      return
    }

    // Bare-word emote completion — debounced 60ms
    // Only trigger if word >= 2 chars and not preceded by colon
    clearTimeout(emoteDebounceTimer)
    const wordMatch = text.match(/(?:^|[ \t])([^\s:]{2,})$/)
    if (wordMatch) {
      const query = wordMatch[1]

      // '@' branch: dedicated mention dropdown. the offer never matches
      // '@'-prefixed queries (no emote name starts with '@'), and the
      // recent-chatter lead below explicitly skips them too — so without this
      // branch "@so" showed an empty/junk emote dropdown. Recent chatters
      // only, same source + ranking (newest-first, time-windowed) as the
      // chatter lead, just not gated behind an emote match this time.
      if (query[0] === '@') {
        const mentionQuery = query.slice(1).toLowerCase()
        emoteDebounceTimer = setTimeout(() => {
          if (sig.aborted) return
          let results = []
          try {
            const rc = typeof window.heatsyncGetRecentChatters === 'function' ? window.heatsyncGetRecentChatters() : []
            for (const c of rc) {
              if (c.l?.startsWith(mentionQuery))
                results.push({ name: c.name, url: null, isChatter: true, isMention: true })
            }
          } catch (_) {}
          if (activeInput) showEmoteDropdown(activeInput, results.slice(0, MAX_RESULTS))
        }, 60)
        return
      }

      emoteDebounceTimer = setTimeout(() => {
        if (sig.aborted) return
        refreshEmotes(getCurrentChannel())
        let results = offer(query).slice(0, MAX_RESULTS)
        // Recent-chatter lead (parity with overlay + twitch): a chatter who just
        // talked and whose name prefix-matches leads above all emotes. Source:
        // content.js (ISOLATED, same world) via window.heatsyncGetRecentChatters,
        // newest-first + time-windowed. Inserted as the plain name (no @) — respect
        // what the user typed.
        if (!query.startsWith('@')) {
          try {
            const ql = query.toLowerCase()
            const rc = typeof window.heatsyncGetRecentChatters === 'function' ? window.heatsyncGetRecentChatters() : []
            const chatters = []
            for (const c of rc) {
              if (c.l?.startsWith(ql)) chatters.push({ name: c.name, url: null, isChatter: true })
            }
            if (chatters.length) results = chatters.concat(results)
          } catch (_) {}
        }
        if (activeInput) showEmoteDropdown(activeInput, results)
      }, 60)
    } else {
      hideEmoteDropdown()
    }
  }

  function handleKeydown(e) {
    if (!emoteDropdown || emoteDropdown.style.display === 'none' || !matches.length) return

    if (e.key === 'Tab' || e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      insertPick(activeInput, matches[selectedIdx])
      return
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault()
      selectedIdx = (selectedIdx - 1 + matches.length) % matches.length
      updateSelection()
      return
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      selectedIdx = (selectedIdx + 1) % matches.length
      updateSelection()
      return
    }

    if (e.key === 'Escape') {
      e.preventDefault()
      hideEmoteDropdown()
    }
  }

  // ── Media paste/drop → upload, insert absolute url as text ──────────────────
  // The upload (filter, size caps, background relay, toast) is shared with
  // kick/youtube/twitch via window.HS.uploadMediaFiles (shared-utils.js) —
  // that file loads alongside this one on every kick.com page. Only the
  // insertion below is platform-specific.
  async function handleMediaFiles(fileList) {
    const input = document.querySelector('div.editor-input')
    if (!input) return
    const urls = await window.HS.uploadMediaFiles(fileList)
    if (!urls.length) return
    input.focus()
    document.execCommand('insertText', false, `${urls.join(' ')} `)
    log('inserted media', urls.length, 'file(s)')
  }

  function handleMediaPaste(e) {
    const items = e.clipboardData?.items
    if (!items) return
    const files = []
    for (const item of items) {
      if (item.kind === 'file' && (item.type.startsWith('image/') || item.type.startsWith('video/'))) {
        const file = item.getAsFile()
        if (file) files.push(file)
      }
    }
    if (files.length) {
      e.preventDefault()
      handleMediaFiles(files)
    }
  }

  function handleMediaDrop(e) {
    const files = e.dataTransfer?.files
    if (files?.length) {
      e.preventDefault()
      handleMediaFiles(files)
    }
  }

  // Listeners sit on the document, not on the editor: kick swaps the editor node (chat reopened, channel
  // switched, the heatsync toggle), and listeners on the old node would be listening to nothing.
  const inEditor = (e) => e.target instanceof Element && e.target.closest('div.editor-input')
  const onEditor = (handler) => (e) => {
    if (inEditor(e)) handler(e)
  }
  document.addEventListener('input', onEditor(handleInput), { signal: sig, capture: true })
  document.addEventListener('keydown', onEditor(handleKeydown), { capture: true, signal: sig })
  document.addEventListener(
    'focusout',
    onEditor(() => {
      setTimeout(() => hideEmoteDropdown(), 150)
    }),
    { signal: sig },
  )
  document.addEventListener('paste', onEditor(handleMediaPaste), { signal: sig, capture: true })
  document.addEventListener('drop', onEditor(handleMediaDrop), { signal: sig, capture: true })

  window.HS?.mountEmoteStrip({
    inputOf: (e) => (e.target instanceof Element ? e.target.closest('div.editor-input') : null),
    // a modifier word (BTTV lists `w!` as an emote) is not an emote of its own
    resolve: (word) => (window.HS?.isModifierWord?.(word) ? null : hsEmoteByName.get(word) || null),
    signal: sig,
  })

  injectStyles()
  refreshEmotes(getCurrentChannel())
  // the channel changes under the SPA without a reload: the list follows it
  let lastChannel = getCurrentChannel()
  const channelWatch = setInterval(() => {
    const now = getCurrentChannel()
    if (now === lastChannel) return
    lastChannel = now
    hsEmotesLastFetch = 0
    refreshEmotes(now)
  }, 2000)
  sig.addEventListener('abort', () => clearInterval(channelWatch))
})()
