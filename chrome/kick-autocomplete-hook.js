/**
 * Kick emoji + heatsync emote autocomplete
 *
 * Lightweight hook for Kick's contenteditable div.editor-input.
 * emoji-data.js must be loaded before this script.
 *
 * Two modes:
 *   emoji   — triggered by :prefix (existing behaviour)
 *   emote   — triggered by bare word >= 2 chars (heatsync/BTTV/FFZ/7TV)
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
  let dropdown = null
  let emoteDropdown = null
  let hsEmoteList = []
  let emoteDebounceTimer = null

  const lifecycle = new AbortController()
  window.__heatsyncKickAcLifecycle = lifecycle
  const sig = lifecycle.signal
  window.addEventListener('pagehide', () => lifecycle.abort())
  sig.addEventListener('abort', () => {
    clearTimeout(emoteDebounceTimer)
    if (dropdown) {
      try {
        dropdown.remove()
      } catch (_) {}
      dropdown = null
    }
    if (emoteDropdown) {
      try {
        emoteDropdown.remove()
      } catch (_) {}
      emoteDropdown = null
    }
    hsEmoteList = []
  })

  // Build emoji map from emoji-data.js
  const EMOJI_MAP = {}
  const EMOJI_ENTRIES = []
  if (typeof EMOJI_DATA !== 'undefined') {
    for (const e of EMOJI_DATA) {
      EMOJI_MAP[e.name] = e.emoji
      EMOJI_ENTRIES.push(e)
    }
  }

  if (!EMOJI_ENTRIES.length) {
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

  function buildEmoteList(data) {
    const blocked = new Set(data.blocked || [])
    const seen = new Set()
    const list = []
    // Tier rides on each emote so searchEmotes can rank channel > own > global —
    // a channel emote beats own/global even when the latter is a closer match
    // (exact/prefix), e.g. "hug" → channel peepoHug over global "HuG". Channel
    // emotes are listed FIRST so first-seen dedup keeps the CHANNEL image for a
    // name you also own (the channel emote is what renders in this channel).
    const sources = [
      ...(data.channelEmotes || []).map((e) => ({ e, tier: 0 })),
      ...(data.inventoryEmotes || []).map((e) => ({ e, tier: 1 })),
      ...(data.globalEmotes || []).map((e) => ({ e, tier: 2 })),
    ]
    for (const { e, tier } of sources) {
      if (!e?.name) continue
      if (blocked.has(e.hash)) continue
      if (seen.has(e.name)) continue
      seen.add(e.name)
      // Cache lowercase once at build time — searchEmotes runs per keystroke,
      // so per-call toLowerCase on 50k emotes is what we're avoiding here.
      list.push({ name: e.name, url: e.url || e.cdnUrl || '', lower: e.name.toLowerCase(), tier, source: e.source })
    }
    list.sort((a, b) => (a.lower < b.lower ? -1 : a.lower > b.lower ? 1 : 0))
    return list
  }

  function refreshEmotes(channel) {
    const now = Date.now()
    if (now - hsEmotesLastFetch < HS_EMOTE_TTL) return
    hsEmotesLastFetch = now
    try {
      chrome.runtime.sendMessage(
        { type: 'get_picker_emotes', channel: channel || getCurrentChannel(), platform: 'kick' },
        (data) => {
          if (chrome.runtime.lastError || !data) return
          hsEmoteList = buildEmoteList(data)
          log('emote list refreshed:', hsEmoteList.length)
        },
      )
    } catch (_) {}
  }

  // Binary-search prefix lookup over hsEmoteList (sorted by .lower).
  // Falls back to linear substring scan only if cap not met after prefix pass.
  function searchEmotes(query) {
    if (!query || query.length < 2) return []
    const q = query.toLowerCase()
    const len = hsEmoteList.length
    if (!len) return []

    let lo = 0,
      hi = len
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (hsEmoteList[mid].lower < q) lo = mid + 1
      else hi = mid
    }

    const exact = [],
      prefix = [],
      contains = []
    const seen = new Set()
    for (let i = lo; i < len; i++) {
      const e = hsEmoteList[i]
      if (!e.lower.startsWith(q)) break
      if (seen.has(e.name)) continue
      seen.add(e.name)
      if (e.lower === q) exact.push(e)
      else prefix.push(e)
      if (exact.length + prefix.length >= MAX_RESULTS) break
    }

    if (exact.length + prefix.length < MAX_RESULTS) {
      const remaining = MAX_RESULTS - exact.length - prefix.length
      for (let i = 0; i < len; i++) {
        const e = hsEmoteList[i]
        if (seen.has(e.name)) continue
        if (e.lower.startsWith(q)) continue
        if (e.lower.indexOf(q) === -1) continue
        seen.add(e.name)
        contains.push(e)
        if (contains.length >= remaining) break
      }
    }

    // Exact full-name match leads UNCONDITIONALLY — typing the whole name is
    // the intent ("nam" → NaM even never-used vs a channel NAMarrive; reverses
    // the old strong-exact/tier call, keep in lockstep with input.js
    // compareAcMatches + autocomplete-hook.js). Then used-before (frecency —
    // "kko" → your KKona, never the channel's untouched KKonaLand). Never-used:
    // tier outranks match-type — the array is grouped exact→prefix→contains
    // and Array.sort is stable, so a tier-only key preserves match-type order
    // WITHIN a tier.
    const frec = readEmoteFrecency()
    return [...exact, ...prefix, ...contains].sort((a, b) => {
      const ax = a.lower === q ? 0 : 1,
        bx = b.lower === q ? 0 : 1
      if (ax !== bx) return ax - bx
      const af = frec.get(a.name) || 0,
        bf = frec.get(b.name) || 0
      if (af > 0 !== bf > 0) return af > 0 ? -1 : 1
      const at = a.tier ?? 2,
        bt = b.tier ?? 2
      if (af > 0) {
        // both used — typed prefix first, then habit strength, then tier
        const ap = a.lower.startsWith(q) ? 0 : 1,
          bp = b.lower.startsWith(q) ? 0 : 1
        if (ap !== bp) return ap - bp
        if (af !== bf) return bf - af
      }
      return at !== bt ? at - bt : 0
    })
  }

  // ---- shared state ----
  const DROPDOWN_ID = 'hs-kick-emoji-dropdown'
  const EMOTE_DROPDOWN_ID = 'hs-kick-emote-dropdown'
  const MAX_RESULTS = 8
  // dropdown, emoteDropdown, emoteDebounceTimer hoisted above
  let selectedIdx = 0
  let matches = []
  // 'emoji' | 'emote' | null
  let activeMode = null
  let activeInput = null

  function injectStyles() {
    if (document.getElementById('heatsync-kick-ac-styles')) return
    const style = document.createElement('style')
    style.id = 'heatsync-kick-ac-styles'
    style.textContent = `
      #${DROPDOWN_ID},
      #${EMOTE_DROPDOWN_ID} {
        position: fixed;
        z-index: 99999;
        background: #1a1a1a;
        border: 1px solid #333;
        border-radius: 0;
        padding: 4px 0;
        max-height: 280px;
        overflow-y: auto;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 13px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.5);
        display: none;
      }
      #${DROPDOWN_ID} .hs-ac-item,
      #${EMOTE_DROPDOWN_ID} .hs-ac-item {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 12px;
        cursor: pointer;
        color: #fff;
      }
      #${DROPDOWN_ID} .hs-ac-item.selected,
      #${DROPDOWN_ID} .hs-ac-item:hover,
      #${EMOTE_DROPDOWN_ID} .hs-ac-item.selected,
      #${EMOTE_DROPDOWN_ID} .hs-ac-item:hover {
        background: #fff;
        color: #000;
      }
      #${DROPDOWN_ID} .hs-ac-emoji {
        font-size: 18px;
        width: 24px;
        text-align: center;
      }
      #${DROPDOWN_ID} .hs-ac-name,
      #${EMOTE_DROPDOWN_ID} .hs-ac-name {
        color: #ccc;
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
      #${EMOTE_DROPDOWN_ID} .hs-ac-vis.v-all { color: #5fd75f; }
      #${EMOTE_DROPDOWN_ID} .hs-ac-vis.v-ext { color: #ffd75f; }
      #${EMOTE_DROPDOWN_ID} .hs-ac-vis.v-hs  { color: #fff; }
      #${EMOTE_DROPDOWN_ID} .hs-ac-vis.v-dim { color: #9e9e9e; }
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
        background: #333;
        border-radius: 0;
        flex-shrink: 0;
      }
    `
    document.head.appendChild(style)
  }

  function createDropdown() {
    if (dropdown) return dropdown
    dropdown = document.createElement('div')
    dropdown.id = DROPDOWN_ID
    document.body.appendChild(dropdown)
    return dropdown
  }

  function createEmoteDropdown() {
    if (emoteDropdown) return emoteDropdown
    emoteDropdown = document.createElement('div')
    emoteDropdown.id = EMOTE_DROPDOWN_ID
    document.body.appendChild(emoteDropdown)
    return emoteDropdown
  }

  function hideDropdown() {
    if (dropdown) dropdown.style.display = 'none'
    if (activeMode === 'emoji') {
      matches = []
      selectedIdx = 0
      activeMode = null
    }
  }

  function hideEmoteDropdown() {
    if (emoteDropdown) emoteDropdown.style.display = 'none'
    if (activeMode === 'emote') {
      matches = []
      selectedIdx = 0
      activeMode = null
    }
  }

  function hideAll() {
    if (dropdown) dropdown.style.display = 'none'
    if (emoteDropdown) emoteDropdown.style.display = 'none'
    matches = []
    selectedIdx = 0
    activeMode = null
  }

  function renderDropdownItems(container, results) {
    container.textContent = ''
    results.forEach((r, i) => {
      const item = document.createElement('div')
      item.className = `hs-ac-item${i === 0 ? ' selected' : ''}`
      item.dataset.idx = i

      const emojiSpan = document.createElement('span')
      emojiSpan.className = 'hs-ac-emoji'
      emojiSpan.textContent = r.emoji

      const nameSpan = document.createElement('span')
      nameSpan.className = 'hs-ac-name'
      nameSpan.textContent = `:${r.name}:`

      item.appendChild(emojiSpan)
      item.appendChild(nameSpan)

      item.addEventListener('mousedown', (e) => {
        e.preventDefault()
        insertEmoji(activeInput, results[i])
      })

      container.appendChild(item)
    })
  }

  // Per-row visibility tag — same wedge signal as the cycle readout on the other
  // surfaces: who actually sees this emote if you send it. Color grades by reach:
  // green everyone/native → yellow {provider} (needs that ext) → orange heatsync
  // only (your set; non-heatsync viewers get plain text). Unknown source falls back
  // to the neutral category so it never asserts a wrong visibility.
  function hsVisTag(r) {
    if (r.isChatter) return { t: 'everyone', cls: 'v-all' }
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

      if (r.url && /^https:\/\//.test(r.url)) {
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
        insertEmote(activeInput, results[i])
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

  function showDropdown(input, results) {
    if (!results.length) {
      hideDropdown()
      return
    }
    if (emoteDropdown) emoteDropdown.style.display = 'none'
    createDropdown()
    matches = results
    selectedIdx = 0
    activeMode = 'emoji'

    renderDropdownItems(dropdown, results)
    positionAboveInput(dropdown, input)
    dropdown.style.display = 'block'
  }

  function showEmoteDropdown(input, results) {
    if (!results.length) {
      hideEmoteDropdown()
      return
    }
    if (dropdown) dropdown.style.display = 'none'
    createEmoteDropdown()
    matches = results
    selectedIdx = 0
    activeMode = 'emote'

    renderEmoteItems(emoteDropdown, results)
    positionAboveInput(emoteDropdown, input)
    emoteDropdown.style.display = 'block'
  }

  function updateSelection() {
    const container = activeMode === 'emote' ? emoteDropdown : dropdown
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

  // Replace :prefix back to opening colon and insert emoji
  function insertEmoji(input, match) {
    const text = getTextBeforeCursor(input)
    const colonMatch = text.match(/:([a-z0-9_+-]*)$/)
    if (!colonMatch) {
      hideDropdown()
      return
    }

    const deleteCount = colonMatch[0].length // :prefix
    input.focus()
    const sel = window.getSelection()
    if (!sel.rangeCount) return

    // Select backwards to delete the :prefix
    for (let i = 0; i < deleteCount; i++) {
      sel.modify('extend', 'backward', 'character')
    }
    document.execCommand('insertText', false, `${match.emoji} `)
    hideDropdown()
    log('inserted', match.name, match.emoji)
  }

  // Replace bare word prefix and insert heatsync emote name
  function insertEmote(input, match) {
    const text = getTextBeforeCursor(input)
    // Match the current word (non-space sequence) at end of text
    const wordMatch = text.match(/(\S+)$/)
    if (!wordMatch) {
      hideEmoteDropdown()
      return
    }
    // Don't fire on emoji-shortcode words — that path is owned by the emoji
    // autocomplete handler. Prevents corrupting partial :foo: sequences.
    if (wordMatch[0].startsWith(':')) {
      hideEmoteDropdown()
      return
    }

    const deleteCount = wordMatch[0].length
    input.focus()
    const sel = window.getSelection()
    if (!sel.rangeCount) return

    for (let i = 0; i < deleteCount; i++) {
      sel.modify('extend', 'backward', 'character')
    }
    // @-mention rows carry isMention (see the '@' branch in handleInput) —
    // the query itself never keeps the '@' (stripped for the chatter lookup),
    // so restore it here on insert. Not an emote usage, so no MRU bump.
    if (match.isMention) {
      // textContent-safe: usernames are alphanumeric + underscore
      document.execCommand('insertText', false, `@${match.name} `)
      hideEmoteDropdown()
      log('inserted mention', match.name)
      return
    }
    // textContent-safe: emote names are alphanumeric + limited punctuation
    document.execCommand('insertText', false, `${match.name} `)
    hideEmoteDropdown()
    // chatter rows aren't emote usage — keep usernames out of the shared signal
    if (!match.isChatter) recordRecentEmoteMru(match.name)
    log('inserted emote', match.name)
  }

  // Shared usage signal with the multichat picker/tab-complete (emotes.js) —
  // same origin, same localStorage keys, so kick-native completions feed the
  // frecency ranking searchEmotes reads above. Two stores: the legacy MRU list
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
  /** name → decayed score (>0 means the user has actually inserted this) */
  function readEmoteFrecency() {
    const raw = _hsFrecRaw()
    const now = Date.now()
    const out = new Map()
    for (const name of Object.keys(raw)) {
      const s = _hsFrecScore(raw[name], now)
      if (s > 0) out.set(name, s)
    }
    return out
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

  // Search emoji by prefix
  function searchEmoji(query) {
    if (!query) return []
    const q = query.toLowerCase()
    const exact = []
    const prefix = []
    const contains = []
    for (const e of EMOJI_ENTRIES) {
      if (e.name === q) {
        exact.push(e)
        continue
      }
      if (e.name.startsWith(q)) {
        prefix.push(e)
        continue
      }
      if (e.name.includes(q)) contains.push(e)
    }
    return [...exact, ...prefix, ...contains].slice(0, MAX_RESULTS)
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
        const deleteCount = closingMatch[0].length // :name:
        const sel = window.getSelection()
        if (sel.rangeCount) {
          for (let i = 0; i < deleteCount; i++) {
            sel.modify('extend', 'backward', 'character')
          }
          document.execCommand('insertText', false, `${emoji} `)
          log(`auto-converted :${closingMatch[1]}: →`, emoji)
          hideAll()
          return
        }
      }
    }

    // Check for :prefix (no closing colon) — show emoji dropdown
    // Colon-triggered completions stay in emoji mode; heatsync does NOT intercept these
    const colonMatch = text.match(/:([a-z0-9_+-]{1,})$/)
    if (colonMatch) {
      const results = searchEmoji(colonMatch[1])
      showDropdown(input, results)
      if (emoteDropdown) emoteDropdown.style.display = 'none'
      return
    }

    hideDropdown()

    // Bare-word emote completion — debounced 60ms
    // Only trigger if word >= 2 chars and not preceded by colon
    clearTimeout(emoteDebounceTimer)
    const wordMatch = text.match(/(?:^|[ \t])([^\s:]{2,})$/)
    if (wordMatch) {
      const query = wordMatch[1]

      // '@' branch: dedicated mention dropdown. searchEmotes() never matches
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
        let results = searchEmotes(query)
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
    const anyOpen =
      (dropdown && dropdown.style.display !== 'none' && activeMode === 'emoji') ||
      (emoteDropdown && emoteDropdown.style.display !== 'none' && activeMode === 'emote')
    if (!anyOpen || !matches.length) return

    if (e.key === 'Tab' || e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      if (activeMode === 'emote') {
        insertEmote(activeInput, matches[selectedIdx])
      } else {
        insertEmoji(activeInput, matches[selectedIdx])
      }
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
      hideAll()
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

  function findAndHook() {
    const input = document.querySelector('div.editor-input')
    if (!input) return false

    if (input._hsEmojiHooked) return true
    input._hsEmojiHooked = true

    input.addEventListener('input', handleInput, { signal: sig })
    input.addEventListener('keydown', handleKeydown, { capture: true, signal: sig })
    input.addEventListener(
      'blur',
      () => {
        setTimeout(() => hideAll(), 150)
      },
      { signal: sig },
    )
    input.addEventListener('paste', handleMediaPaste, { signal: sig })
    input.addEventListener('drop', handleMediaDrop, { signal: sig })

    // Trigger initial emote fetch for the current channel
    refreshEmotes(getCurrentChannel())

    log('hooked Kick chat input')
    return true
  }

  // Init
  injectStyles()

  let attempts = 0
  function tryInit() {
    if (sig?.aborted) return
    attempts++
    if (findAndHook()) {
      log('ready')
      return
    }
    if (attempts < 20) {
      if (sig?.aborted) return
      const _t = setTimeout(tryInit, 1000)
      sig?.addEventListener('abort', () => clearTimeout(_t), { once: true })
    }
  }

  // Retry on navigation (Kick is an SPA)
  let lastUrl = location.href
  const urlCheckInterval = setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href
      const _nt = setTimeout(() => {
        if (sig?.aborted) return
        const input = document.querySelector('div.editor-input')
        if (input && !input._hsEmojiHooked) findAndHook()
      }, 1500)
      sig?.addEventListener('abort', () => clearTimeout(_nt), { once: true })
    }
  }, 2000)
  sig.addEventListener('abort', () => clearInterval(urlCheckInterval))

  const _initT = setTimeout(tryInit, 500)
  sig?.addEventListener('abort', () => clearTimeout(_initT), { once: true })
})()
