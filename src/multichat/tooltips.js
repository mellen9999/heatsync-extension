// Tooltips - toast, emote tooltip, user profile card, link preview
// Note: all innerHTML usage passes content through escapeHtml() first (see src/lib/utils.js)

// module scope resets on re-injection, so a fresh instance re-registers
// after the old one's teardown; window-scope survives takeover and leaves
// handlers dead until hard refresh
const _onceGuardsTooltips = {}

function showToast(msg, type) {
  // Routed through HsNotifs (notifs.js) — single source of truth for layers,
  // dedup, lifecycle. Adding/removing notif types happens there.
  try {
    HsNotifs.emit('toast', { text: msg, level: type })
  } catch (_) {
    // Fallback if manager somehow unavailable (shouldn't happen — same IIFE)
    console.warn('[heatsync-mc]', type || 'info', msg)
  }
}

// Badge hover tooltip (4x preview with name)
let badgeTooltip = null

function ensureBadgeTooltip() {
  if (!badgeTooltip || !document.contains(badgeTooltip)) {
    badgeTooltip = document.createElement('div')
    badgeTooltip.id = 'hs-badge-tooltip'
    const img = document.createElement('img')
    const name = document.createElement('span')
    name.className = 'tooltip-name'
    const source = document.createElement('span')
    source.className = 'tooltip-source'
    badgeTooltip.appendChild(img)
    badgeTooltip.appendChild(name)
    badgeTooltip.appendChild(source)
    document.body.appendChild(cleanup.trackNode(badgeTooltip))
  }
  return badgeTooltip
}

// Inline badges render at 18px (1x). The tooltip shows them at 72px, so swap
// to the crispest variant for the 72px preview instead of upscaling 18→72.
// 7TV badges top out at 3x, FFZ at 4, so we list candidates descending and
// probe each (see upgradeBadgeImg). Other sources are single-resolution.
function hiResBadgeCandidates(src) {
  if (!src) return []
  if (src.includes('7tv'))
    return ['4x', '3x', '2x'].map((s) =>
      src.replace(/\/[1-4]x(\.\w+)?(\?.*)?$/i, (_m, ext, q) => `/${s}${ext || ''}${q || ''}`),
    )
  if (src.includes('frankerfacez'))
    return ['4', '2'].map((s) => src.replace(/\/[1-4](\?.*)?$/, (_m, q) => `/${s}${q || ''}`))
  // Twitch native badges (sub/bits/mod/vip) — URLs end in /1, /2, /3 (max 3, no 4x)
  if (src.includes('jtvnw')) return ['3', '2'].map((s) => src.replace(/\/[1-3](\?.*)?$/, (_m, q) => `/${s}${q || ''}`))
  return []
}

// Emote-preview pattern: keep 1x showing, probe each hi-res candidate, swap
// img.src to the first that loads. No blank flash, no broken icon on 404.
function upgradeBadgeImg(img, src) {
  const cands = hiResBadgeCandidates(src).filter((u) => u && u !== src)
  let i = 0
  const tryNext = () => {
    if (i >= cands.length || !img.isConnected) return
    const url = cands[i++]
    const probe = new Image()
    probe.onload = () => {
      if (img.isConnected && img.dataset.hsBadgeOrig === src) img.src = url
    }
    probe.onerror = tryNext
    probe.src = url
  }
  tryNext()
}

function showBadgeTooltip(badgeImg, badgeName) {
  const tooltip = ensureBadgeTooltip()
  document.body.appendChild(cleanup.trackNode(tooltip))
  const img = tooltip.querySelector('img')
  img.dataset.hsBadgeOrig = badgeImg.src
  img.src = badgeImg.src
  upgradeBadgeImg(img, badgeImg.src)
  img.alt = badgeName
  img.style.width = '72px'
  img.style.height = '72px'
  const nameEl = tooltip.querySelector('.tooltip-name')
  if (nameEl) nameEl.textContent = badgeName
  // Detect source from URL
  const src = badgeImg.src
  const sourceLabel = src.includes('betterttv')
    ? 'BTTV'
    : src.includes('frankerfacez')
      ? 'FFZ'
      : src.includes('7tv')
        ? '7TV'
        : src.includes('jtvnw.net')
          ? 'Twitch'
          : src.includes('kick')
            ? 'Kick'
            : src.includes('googleusercontent') || src.includes('ggpht')
              ? 'YouTube'
              : ''
  const sourceEl = tooltip.querySelector('.tooltip-source')
  if (sourceEl) {
    sourceEl.textContent = sourceLabel
    sourceEl.className = 'tooltip-source'
  }

  tooltip.style.left = '-9999px'
  tooltip.style.top = '-9999px'
  tooltip.classList.add('visible')
  positionTooltipAtElement(tooltip, badgeImg)
  requestAnimationFrame(() => positionTooltipAtElement(tooltip, badgeImg))
}

function hideBadgeTooltip() {
  if (badgeTooltip) badgeTooltip.classList.remove('visible')
}

// Emote hover tooltip (4x preview with source color)
let emoteTooltip = null

function ensureEmoteTooltip() {
  if (!emoteTooltip || !document.contains(emoteTooltip)) {
    emoteTooltip = document.createElement('div')
    emoteTooltip.id = 'hs-emote-tooltip'
    emoteTooltip.innerHTML = `
        <img src="" alt="">
        <span class="tooltip-name"></span>
        <span class="tooltip-source"></span>
      `
    // Composite-stack preview container (scaled base+overlays for emote nests).
    // Built via DOM, inserted before the name so it occupies the thumbnail slot.
    const stackBox = document.createElement('span')
    stackBox.className = 'tooltip-stack'
    emoteTooltip.insertBefore(stackBox, emoteTooltip.querySelector('.tooltip-name'))
    document.body.appendChild(cleanup.trackNode(emoteTooltip))
  }
  return emoteTooltip
}

// Set of hi-res URLs we've successfully preloaded. Once an emote is in here,
// skip the 1x→4x swap entirely on next hover (no flicker, no re-fetch).
const _hiResLoaded = new Set()

// Clone a collapsed stack's composited emotes into the tooltip and blow it up
// SCALE×. transform: scale keeps base+overlay grid alignment intact; the outer
// box is sized to the scaled footprint so the tooltip lays out around it.
const STACK_PREVIEW_SCALE = 4
// Largest scale ≤ 4× whose footprint still fits the viewport, so a wide/tall
// composite (a 384×128 overlay → 1536×512 at 4×, or a 50-deep nest) is shown
// WHOLE instead of clipping off-screen — positioning only clamps placement,
// never size. 4× when it fits; auto-fits down when it doesn't. baseW/H are the
// UNSCALED footprint; reserve room for the name + source chip rendered below.
const PREVIEW_VIEWPORT_MARGIN = 12 // edge breathing room
const PREVIEW_RESERVE_V = 96 // tooltip padding + name + source chip
const PREVIEW_RESERVE_H = 16 // tooltip L/R padding
function fitPreviewScale(baseW, baseH) {
  if (!baseW || !baseH) return STACK_PREVIEW_SCALE
  const availW = window.innerWidth - PREVIEW_VIEWPORT_MARGIN * 2 - PREVIEW_RESERVE_H
  const availH = window.innerHeight - PREVIEW_VIEWPORT_MARGIN * 2 - PREVIEW_RESERVE_V
  return Math.min(STACK_PREVIEW_SCALE, availW / baseW, availH / baseH)
}
function buildStackPreview(box, stackEmotes) {
  const liveImgs = [...stackEmotes.querySelectorAll('img')]
  const clone = stackEmotes.cloneNode(true)
  const imgs = [...clone.querySelectorAll('img')]
  imgs.forEach((im, i) => {
    // Blocked pieces stay hidden in the preview too — recovering hsOrigSrc or
    // hi-res-upgrading them would repaint an asset the viewer blocked.
    if (im.closest('.hs-state-blocked') || im.dataset.hsInputBlocked === '1') {
      im.src = HS_TRANSPARENT_PX
      im.style.setProperty('visibility', 'hidden', 'important')
      return
    }
    const orig = im.dataset.hsOrigSrc || im.src
    // Overlay emotes render at native intrinsic size (width:auto +
    // object-fit:none), so swapping their src to the 4x hi-res asset balloons
    // that box 4x — and the stack's own scale(4) below then multiplies it to
    // 16x (the giant tooltip). Pin each overlay to the size it renders at in
    // chat and switch to object-fit:contain so the hi-res asset scales DOWN
    // into that box (sharp, not huge); scale(4) supplies the 4x preview.
    if (im.classList.contains('hs-mc-overlay-emote')) {
      const lw = liveImgs[i]?.offsetWidth,
        lh = liveImgs[i]?.offsetHeight
      if (lw && lh) {
        im.style.setProperty('width', `${lw}px`, 'important')
        im.style.setProperty('height', `${lh}px`, 'important')
        im.style.setProperty('object-fit', 'contain', 'important')
      }
    }
    const hi = getHighResUrl(orig)
    if (hi) im.src = hi
    im.removeAttribute('loading') // force eager — see sizeBox note below
    im.style.filter = ''
  })
  clone.style.transformOrigin = 'top left'
  // Initial 4× guess for first-paint positioning; sizeBox (rAF, below) recomputes
  // the viewport-fit scale once the clone's real footprint is measurable.
  clone.style.transform = `scale(${STACK_PREVIEW_SCALE})`
  box.style.display = 'block'
  box.replaceChildren(clone)
  // Size the box to the clone's OWN footprint, never the live in-chat rect: a
  // stacked emote in a scrolled-off row is a loading="lazy" img that never
  // entered the viewport (naturalWidth 0, the grid collapses it to ~4px), so
  // the old rect was a sliver — the box came out tiny while the now-eager
  // clone loaded full-size and spilled out past it (.tooltip-stack is
  // overflow:visible). offsetWidth/Height ignore the transform, giving the
  // unscaled layout box. Measure in rAF (the tooltip is display:none until
  // .visible is added right after this returns) and re-measure as each lazy /
  // hi-res image finishes loading so the box grows to the real composite.
  const sizeBox = () => {
    const baseW = clone.offsetWidth,
      baseH = clone.offsetHeight
    const scale = fitPreviewScale(baseW, baseH)
    clone.style.transform = `scale(${scale})`
    box.style.width = `${baseW * scale}px`
    box.style.height = `${baseH * scale}px`
  }
  requestAnimationFrame(sizeBox)
  imgs.forEach((im) => {
    if (!im.complete) im.addEventListener('load', sizeBox, { once: true })
  })
}

// ─── Composition line ────────────────────────────────────────────────────────
// A stacked/modified emote is a recipe, and the tooltip used to show only a
// flat "A + B + C" of names with no indication of which modifiers were applied,
// in what order, or which provider each piece came from. Render the whole
// composition instead, colour-coded, base → overlays → effects in order.
//
// Provider is inferred from the token SHAPE: "ffz*" is FrankerFaceZ, anything
// ending in "!" is BetterTTV. Brand colours match the source chips already used
// elsewhere in this tooltip.
const HS_TT_PROVIDER_COLOR = { '7tv': '#29d8f6', bttv: '#d50014', ffz: '#0086c8', twitch: '#9147ff', kick: '#53fc18' }

function hsTtModProvider(tok) {
  if (/^ffz/i.test(tok)) return 'ffz'
  if (tok.endsWith('!') || /^c!#/i.test(tok)) return 'bttv'
  return null
}

/** One coloured chip. `dim` renders the connector glyphs, not a value. */
function hsTtChip(text, color, cls) {
  const el = document.createElement('span')
  el.className = `tooltip-piece${cls ? ` ${cls}` : ''}`
  if (color) el.style.color = color
  el.textContent = text
  return el
}

/**
 * Build "BASE + OVERLAY + OVERLAY  ·  w! c!" into nameEl.
 * `pieces` = [{name, source}] in stack order; `mods` = ordered token strings.
 */
function hsTtRenderComposition(nameEl, pieces, mods) {
  nameEl.replaceChildren()
  const MAX = 8
  const shown = pieces.slice(0, MAX)
  shown.forEach((p, i) => {
    if (i) nameEl.appendChild(hsTtChip(' + ', null, 'tooltip-join'))
    nameEl.appendChild(hsTtChip(p.name, HS_TT_PROVIDER_COLOR[p.source] || null, i ? 'tooltip-overlay' : 'tooltip-base'))
  })
  if (pieces.length > MAX) nameEl.appendChild(hsTtChip(` +${pieces.length - MAX} more`, null, 'tooltip-join'))
  if (mods?.length) {
    // Effects are ordered — "w! c!" reads left-to-right as applied.
    nameEl.appendChild(hsTtChip('  ·  ', null, 'tooltip-join'))
    mods.forEach((m, i) => {
      if (i) nameEl.appendChild(hsTtChip(' ', null, 'tooltip-join'))
      const prov = hsTtModProvider(m)
      const chip = hsTtChip(m, HS_TT_PROVIDER_COLOR[prov] || '#c8c8c8', 'tooltip-mod')
      // c!#rrggbb tints — show the actual colour as the chip's own colour.
      const hex = m.match(/^c!#?([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/)
      if (hex) chip.style.color = `#${hex[1]}`
      nameEl.appendChild(chip)
    })
  }
}

/**
 * Park a popover last in <body> — the DOM-order tiebreak that puts it above
 * other max-int siblings — without re-parenting it when it is already there.
 *
 * Moving a connected node is never free: it invalidates style and layout for
 * the document, and Twitch/Kick/YouTube documents are not small. The show*
 * paths run on mouseover, which re-fires whenever chat rebuilds the row under
 * a stationary cursor, so on a busy channel the unconditional append was doing
 * that repeatedly per second for no change in outcome.
 *
 * Counted when hs_tip_debug is set (see hsTipStats) so the cost is measurable
 * rather than argued about.
 */
function hsAppendLastIfNeeded(node) {
  if (node.parentNode === document.body && document.body.lastElementChild === node) {
    hsTipStats.appendSkipped++
    return
  }
  hsTipStats.appendMoved++
  document.body.appendChild(cleanup.trackNode(node))
}

/**
 * Hover-path counters. Free when unused (four integer bumps); `hs_tip_debug` in
 * localStorage additionally installs a longtask observer, so a report of "the
 * whole machine stutters while I hover" can be answered with numbers instead of
 * a third theory. Read it with `window.__hsTipStats` from the page console.
 */
const hsTipStats = { emoteShow: 0, userShow: 0, appendMoved: 0, appendSkipped: 0, longTasks: 0, longestMs: 0 }
try {
  if (typeof window !== 'undefined') {
    window.__hsTipStats = hsTipStats
    if (localStorage.getItem('hs_tip_debug')) {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          hsTipStats.longTasks++
          if (entry.duration > hsTipStats.longestMs) hsTipStats.longestMs = Math.round(entry.duration)
        }
      }).observe({ entryTypes: ['longtask'] })
    }
  }
} catch (_) {
  /* no window (tests) or longtask unsupported — counters still work */
}

/** Ordered effect tokens stamped on a wrapper by _hsMcApplyMods. */
function hsTtModsOf(el) {
  const raw = el?.dataset?.hsMods || el?.closest?.('[data-hs-mods]')?.dataset?.hsMods || ''
  return raw ? raw.split(/\s+/).filter(Boolean) : []
}

function showEmoteTooltip(e, emoteName, emoteUrl, state, source, hoveredImg, owner) {
  // A blocked emote's real asset must never paint here — the 4x preview would
  // defeat the chat-side hiding (and hsOrigSrc exists precisely to recover the
  // hidden url). Name + "blocked" label still show; the image slot stays empty.
  if (state === 'blocked') emoteUrl = HS_TRANSPARENT_PX
  hsTipStats.emoteShow++
  const tooltip = ensureEmoteTooltip()
  // Re-append to body so DOM order tiebreaks above other max-int siblings
  // (reply-stack overlay sits at the same z-index). Only when it isn't already
  // last: chat rebuilds rows constantly, so the cursor sitting still still
  // re-fires mouseover, and re-parenting a live node dirties style+layout for
  // the whole document every time. Being last child is the entire point of the
  // move, so when that already holds there is nothing to do.
  hsAppendLastIfNeeded(tooltip)
  const img = tooltip.querySelector('img')
  const stackBox = tooltip.querySelector('.tooltip-stack')
  const nameEl = tooltip.querySelector('.tooltip-name')
  const stateEl = tooltip.querySelector('.tooltip-source')

  // Emote nest (collapsed stack): preview the whole composite — base + every
  // zero-width overlay — scaled up together, instead of just the one img the
  // cursor happened to land on. Uniform 4× keeps the in-chat overlay alignment.
  const stackEmotes = hoveredImg
    ?.closest?.('.hs-mc-emote-stack:not(.expanded)')
    ?.querySelector(':scope > .hs-mc-emote-stack-emotes')
  if (stackEmotes && stackEmotes.children.length > 1) {
    img.style.display = 'none'
    buildStackPreview(stackBox, stackEmotes)
    // Name lists the emotes in the nest, base first. A deep nest (50 overlays)
    // would otherwise join into a 500-char label that blows the tooltip past the
    // viewport — the composite IMAGE already shows every overlay, so the label
    // only needs to identify them: cap to the first few + a "+N more" tail.
    // Every piece of the nest, colour-coded by provider, plus the ordered
    // effect list gathered from each piece's data-hs-mods.
    const pieces = [...stackEmotes.children]
      .map((w) => ({
        name: w.dataset?.emoteName || w.querySelector('img')?.alt || '',
        source: w.dataset?.source || w.querySelector('img')?.dataset?.source || '',
      }))
      .filter((p) => p.name)
    const stackMods = []
    for (const w of stackEmotes.children) for (const m of hsTtModsOf(w)) stackMods.push(m)
    if (pieces.length) hsTtRenderComposition(nameEl, pieces, stackMods)
    else nameEl.textContent = emoteName
  } else {
    stackBox.style.display = 'none'
    stackBox.replaceChildren()
    img.style.display = ''
    // Same fit-to-viewport cap as the composite path: a lone wide/tall emote
    // (up to 384×128) blown to 4× is 1536×512 — scale down if it would clip.
    // Use the VISUAL (transformed) size so a w!/ffzW/h!-modified emote previews at
    // its modified proportions. offsetWidth ignores the CSS transform, so a wide
    // emote's hover preview would otherwise shrink back to the un-modified base
    // square while the in-chat copies stay wide (reported "shows the base image").
    const _vRect = hoveredImg?.getBoundingClientRect()
    const baseW = _vRect?.width || hoveredImg?.offsetWidth || 28
    const baseH = _vRect?.height || hoveredImg?.offsetHeight || 28
    const scale = fitPreviewScale(baseW, baseH)
    img.style.width = `${baseW * scale}px`
    img.style.height = `${baseH * scale}px`
    // A w!/ffzW/h! emote is stretched by its transform, and we sized the box to
    // that stretched footprint above — so FILL it. The CSS default is
    // object-fit:contain, which would letterbox the base-aspect image inside the
    // wide/tall box (the reported "small version inside the hovered one"). Plain
    // emotes keep contain.
    img.style.objectFit = hoveredImg?.closest?.('.hs-mc-emote-wrapper')?.dataset?.hsModSx ? 'fill' : ''
    img.alt = emoteName
    const hiResUrl = getHighResUrl(emoteUrl)
    if (hiResUrl !== emoteUrl && _hiResLoaded.has(hiResUrl)) {
      // Already preloaded — go straight to hi-res, no swap-flicker.
      img.src = hiResUrl
    } else {
      // First time: show 1x immediately, upgrade in background. The hi-res URL
      // is cached after first load so subsequent hovers are flicker-free.
      img.src = emoteUrl
      if (hiResUrl !== emoteUrl) {
        const hiRes = new Image()
        hiRes.onload = () => {
          _hiResLoaded.add(hiResUrl)
          if (_hiResLoaded.size > 2000) _hiResLoaded.delete(_hiResLoaded.values().next().value)
          if (img.alt === emoteName) img.src = hiResUrl
        }
        hiRes.src = hiResUrl
      }
    }
    // A lone emote can still carry effects ("Kappa w! c!") — show them in the
    // order applied, same colour coding as the stack path.
    const soloMods = hsTtModsOf(hoveredImg)
    if (soloMods.length) hsTtRenderComposition(nameEl, [{ name: emoteName, source }], soloMods)
    else nameEl.textContent = emoteName
  }

  // Show state with source for globals. 2-state model: 'unadded' is no
  // longer a user-facing tier (click pastes, doesn't add — auto-add fires
  // at send time silently), so fall it through to the source-label branch.
  // data-inv marks emotes that render via a heatsync inventory (stamped by
  // processEmotes' _lookup). The label is VIEWER-relative: "inventory" only
  // when it's in YOUR set (state 'owned'); a sender's inventory emote you
  // don't own reads "Heatsync" — it's a heatsync-vouched emote you could
  // add, and the label flips to "inventory" the moment you do.
  const wrapper = (hoveredImg || e.target)?.closest?.('.hs-mc-emote-wrapper')
  const fromInv = wrapper?.dataset.inv === '1' || hoveredImg?.dataset?.inv === '1'
  let label
  if (state === 'owned') {
    label = t('mc_emote_in_set')
  } else if (state === 'blocked') {
    label = t('mc_emote_blocked')
  } else if (fromInv) {
    label = 'Heatsync'
  } else {
    // Global / channel / sub - show source with appropriate scope
    const sourceLabels = {
      '7tv': '7TV',
      bttv: 'BTTV',
      ffz: 'FFZ',
      twitch: 'Twitch',
      kick: 'Kick',
      heatsync: 'Heatsync',
    }
    const sourceName = sourceLabels[source] || source || 'unknown'
    if (state === 'sub') {
      // Twitch sub emote — show broadcaster as scope so it's specific
      label = owner ? `${owner} sub (${sourceName})` : sourceName
    } else {
      label = sourceName
    }
  }
  // Stale-emote ghost hint: append "· removed by @actor" if the hovered
  // wrapper carries data-stale-actor (set by main.js channel_emote_removed).
  const staleActor = wrapper?.dataset.staleActor || ''
  const isStale = wrapper?.classList.contains('hs-state-stale')
  if (isStale) {
    label = staleActor ? `${label} · removed by @${staleActor}` : `${label} · removed from channel`
  }
  // v1.6 NSFW — flagged emotes get an explicit suffix so viewers who
  // opted in know which emotes are filtered for everyone else.
  const pickerWrap = (hoveredImg || e.target)?.closest?.('.hs-mc-picker-emote-wrap')
  const isNsfw =
    wrapper?.classList.contains('hs-state-nsfw') ||
    pickerWrap?.classList.contains('hs-state-nsfw') ||
    hoveredImg?.classList?.contains?.('hs-state-nsfw')
  if (isNsfw) label = `${label} · NSFW`
  stateEl.textContent = label
  const srcClass =
    fromInv && state !== 'owned' && state !== 'blocked'
      ? ' src-heatsync'
      : (state === 'global' || state === 'channel' || state === 'sub') && source
        ? ` src-${source.toLowerCase().replace(/[^a-z0-9]/g, '')}`
        : ''
  stateEl.className = `tooltip-source ${state || 'global'}${srcClass}${isStale ? ' stale' : ''}${isNsfw ? ' nsfw' : ''}`

  // Position: anchor above the emote element
  const anchorEl = hoveredImg || e.target
  tooltip.style.left = '-9999px'
  tooltip.style.top = '-9999px'
  tooltip.classList.add('visible')
  // Double-position: first pass gets approximate, rAF gets exact after layout
  positionTooltipAtElement(tooltip, anchorEl)
  requestAnimationFrame(() => positionTooltipAtElement(tooltip, anchorEl))
}

function showEmojiTooltip(targetEl, emoji, name) {
  const tooltip = ensureEmoteTooltip()
  document.body.appendChild(cleanup.trackNode(tooltip))
  const img = tooltip.querySelector('img')
  const nameEl = tooltip.querySelector('.tooltip-name')
  const stateEl = tooltip.querySelector('.tooltip-source')

  // Hide the image, show emoji character at 4x instead
  img.style.display = 'none'
  const stackBox = tooltip.querySelector('.tooltip-stack')
  if (stackBox) {
    stackBox.style.display = 'none'
    stackBox.replaceChildren()
  }

  // Build emoji preview using safe DOM methods
  nameEl.textContent = ''
  const emojiChar = document.createElement('span')
  Object.assign(emojiChar.style, {
    fontSize: '64px',
    lineHeight: '1',
    fontVariantEmoji: 'emoji',
    display: 'block',
    textAlign: 'center',
  })
  emojiChar.textContent = emoji
  const label = document.createElement('span')
  Object.assign(label.style, { display: 'block', marginTop: '4px' })
  label.textContent = `:${name}:`
  nameEl.appendChild(emojiChar)
  nameEl.appendChild(label)

  stateEl.textContent = t('mc_tip_emoji')
  stateEl.className = 'tooltip-source'

  tooltip.style.left = '-9999px'
  tooltip.style.top = '-9999px'
  tooltip.classList.add('visible')
  positionTooltipAtElement(tooltip, targetEl)
  requestAnimationFrame(() => positionTooltipAtElement(tooltip, targetEl))
}

// Refresh tooltip text/color if it's currently showing the given emote
function refreshEmoteTooltip(emoteName, newState) {
  if (!emoteTooltip?.classList.contains('visible')) return
  const nameEl = emoteTooltip.querySelector('.tooltip-name')
  if (nameEl?.textContent !== emoteName) return
  const stateEl = emoteTooltip.querySelector('.tooltip-source')
  if (!stateEl) return
  const labels = { owned: t('mc_emote_in_set'), blocked: t('mc_emote_blocked') }
  stateEl.textContent = labels[newState] || newState
  stateEl.className = `tooltip-source ${newState || 'global'}`
  // 2-state model: cross-highlight is white for everything except blocked
  // (red). No orange middle tier exists anymore, so the live-resync that
  // used to chase unadded→owned ladder transitions collapses to a single
  // blocked-vs-not check.
  const hl = newState === 'blocked' ? 'var(--hs-danger)' : '#fff'
  document.body.style.setProperty('--hs-highlight-color', hl)
}

function hideEmoteTooltip() {
  if (emoteTooltip) {
    emoteTooltip.classList.remove('visible')
    // Reset img display for next emote hover
    const img = emoteTooltip.querySelector('img')
    if (img) img.style.display = ''
    // Clear any stack composite so the next plain hover isn't oversized
    const stackBox = emoteTooltip.querySelector('.tooltip-stack')
    if (stackBox) {
      stackBox.style.display = 'none'
      stackBox.replaceChildren()
    }
  }
}

function setupEmoteTooltipHandlers() {
  if (_onceGuardsTooltips.emoteTooltipSetup) return
  _onceGuardsTooltips.emoteTooltipSetup = true

  cleanup.addEventListener(
    document,
    'mouseover',
    (e) => {
      const target = e.target

      // Badge hover: show 4x preview with name
      const badgeImg = target.tagName === 'IMG' && target.classList.contains('hs-mc-badge-img') ? target : null
      if (badgeImg) {
        const badgeName = badgeImg.title || badgeImg.alt || ''
        if (badgeName) {
          showBadgeTooltip(badgeImg, badgeName)
        }
        return
      }

      // Emoji hover: show 4x preview
      const emojiSpan = target.closest('.hs-mc-emoji')
      if (emojiSpan) {
        const name = emojiSpan.dataset.emojiName || emojiSpan.title?.replace(/:/g, '') || ''
        showEmojiTooltip(emojiSpan, emojiSpan.textContent, name)
        return
      }

      // Check wrapper first, then IMG. Input chips (.hs-input-emote) also
      // surface the tooltip so users can read name + state without leaving
      // the input box.
      // Picker emotes hide their <img> on hover (green/orange overlay) and
      // blocked picker emotes hide it permanently, so the steady hover target
      // is the .hs-mc-picker-emote-wrap span, not the img. Resolve to the inner
      // img — mirrors findEmoteTarget so the 4x tooltip + name show in-picker.
      const wrapper = target.closest('.hs-mc-emote-wrapper')
      const pickerWrap = !wrapper ? target.closest('.hs-mc-picker-emote-wrap') : null
      // Picker search/discover rows live in .hs-discover-item with an
      // .hs-discover-thumb img — different DOM structure than the grid
      // (.hs-mc-picker-emote-wrap) but the same intent: hover should
      // surface the 4x preview + name + state.
      const discoverItem = !wrapper && !pickerWrap ? target.closest('.hs-discover-item') : null
      const img = wrapper
        ? wrapper.querySelector('img')
        : pickerWrap
          ? pickerWrap.querySelector('img')
          : discoverItem
            ? discoverItem.querySelector('img.hs-discover-thumb')
            : target.tagName === 'IMG' &&
                (target.classList.contains('hs-mc-emote') ||
                  target.classList.contains('hs-mc-picker-emote') ||
                  target.classList.contains('hs-input-emote') ||
                  target.classList.contains('hs-discover-thumb'))
              ? target
              : null
      if (!img && !wrapper && !pickerWrap && !discoverItem) return

      const emoteName =
        wrapper?.dataset.emoteName ||
        pickerWrap?.dataset.name ||
        img?.alt ||
        img?.dataset.emoteName ||
        img?.title?.split(' ')[0]
      if (!emoteName) return

      // For blocked input chips, dataset.hsOrigSrc holds the real image URL
      // (src has been swapped to a 1×1 transparent placeholder).
      const emoteUrl = wrapper?.dataset.emoteUrl || img?.dataset.hsOrigSrc || img?.src
      const state = wrapper?.dataset.state || img?.dataset.state || 'global'
      const source = wrapper?.dataset.source || img?.dataset.source || detectEmoteSource(emoteUrl)
      const owner = wrapper?.dataset.owner || img?.dataset.owner || ''

      showEmoteTooltip(e, emoteName, emoteUrl, state, source, img, owner)

      // Cross-highlight: add highlight to all wrappers with same emote name.
      // For wrappers in collapsed stacks, derive color from the stack's worst
      // state (blocked > unadded > normal) so the same nest always shows the
      // same hover color regardless of which emote inside you happen to land on.
      // 2-state cross-highlight: stack tints red iff ANY emote inside is
      // blocked, else white. Dropped the unadded/orange middle tier with
      // the ladder.
      const stack = wrapper?.closest?.('.hs-mc-emote-stack:not(.expanded)')
      let effectiveState = state
      if (stack) {
        effectiveState = stack.querySelector('.hs-mc-emote-wrapper.hs-state-blocked') ? 'blocked' : 'normal'
      }
      const sourceColor = effectiveState === 'blocked' ? 'var(--hs-danger)' : '#fff'
      document.body.style.setProperty('--hs-highlight-color', sourceColor)
      queryEmoteWrappers(emoteName).forEach((w) => {
        w.classList.add('hs-emote-highlight')
      })
    },
    'mc-emote-tooltip-mouseover',
  )

  cleanup.addEventListener(
    document,
    'mouseout',
    (e) => {
      const target = e.target

      // Badge mouseout
      if (target.tagName === 'IMG' && target.classList.contains('hs-mc-badge-img')) {
        hideBadgeTooltip()
        return
      }

      const wrapper = target.closest('.hs-mc-emote-wrapper')
      const pickerWrap = !wrapper ? target.closest('.hs-mc-picker-emote-wrap') : null
      const img = wrapper
        ? wrapper.querySelector('img')
        : pickerWrap
          ? pickerWrap.querySelector('img')
          : target.tagName === 'IMG' &&
              (target.classList.contains('hs-mc-emote') ||
                target.classList.contains('hs-mc-picker-emote') ||
                target.classList.contains('hs-input-emote'))
            ? target
            : null
      if (!img && !wrapper && !pickerWrap) return

      hideEmoteTooltip()

      // Remove cross-highlight from all wrappers
      const emoteName = wrapper?.dataset.emoteName || img?.alt || img?.dataset.emoteName
      if (emoteName) {
        queryEmoteWrappers(emoteName).forEach((w) => {
          w.classList.remove('hs-emote-highlight')
        })
      }
    },
    'mc-emote-tooltip-mouseout',
  )

  // Hide tooltip+highlight on any scroll (wheel/trackpad/drag — mouseout doesn't fire when elements scroll away)
  let _dismissRafPending = false
  function dismissAllTooltips() {
    if (_dismissRafPending) return
    _dismissRafPending = true
    requestAnimationFrame(() => {
      _dismissRafPending = false
      if (emoteTooltip?.classList.contains('visible')) {
        hideEmoteTooltip()
        document.querySelectorAll('.hs-emote-highlight').forEach((w) => {
          w.classList.remove('hs-emote-highlight')
        })
      }
      hideBadgeTooltip()
      // Skip link tooltip — mouse is still on the link, scroll-driven hides
      // would race with the og fetch and leave the user with nothing.
      if (linkTooltip?.classList.contains('visible') && !_linkHoverUrl) hideLinkTooltip()
      if (userTooltip?.classList.contains('visible')) hideUserTooltip()
    })
  }
  // Wheel dismiss is fine (deliberate user input). Skip the capture-phase
  // scroll listener: per heatsync_menu_scroll_dismiss memory, capture:true
  // here means xqc-tier auto-scrolling chat fires scroll continuously,
  // dismissing picker tooltips ~1 frame after they show. Wheel covers the
  // intentional case (user scrolls); auto-scroll no longer kills hovers.
  cleanup.addEventListener(document, 'wheel', dismissAllTooltips, { passive: true })

  let _tooltipRafPending = false
  cleanup.addEventListener(
    document,
    'mousemove',
    (e) => {
      // RAF-batch tooltip position updates to avoid per-mousemove style writes
      if (_tooltipRafPending) return
      _tooltipRafPending = true
      const target = e.target
      requestAnimationFrame(() => {
        _tooltipRafPending = false
        // This handler only ever HIDES tooltips (show/reposition lives in the
        // mouseover handlers). When nothing is visible — the common state while
        // the cursor sweeps over chat — skip the closest() ancestor walks below.
        if (
          !(
            emoteTooltip?.classList.contains('visible') ||
            badgeTooltip?.classList.contains('visible') ||
            userTooltip?.classList.contains('visible') ||
            linkTooltip?.classList.contains('visible')
          )
        )
          return
        const onEmote =
          target?.closest?.('.hs-mc-emote-wrapper') ||
          target?.closest?.('.hs-mc-picker-emote-wrap') ||
          target?.closest?.('.hs-discover-item') ||
          (target?.tagName === 'IMG' &&
            (target.classList?.contains('hs-mc-emote') ||
              target.classList?.contains('hs-mc-picker-emote') ||
              target.classList?.contains('hs-input-emote') ||
              target.classList?.contains('hs-discover-thumb')))
        const onUser = target?.closest?.('.hs-mc-user')
        const onBadge = target?.tagName === 'IMG' && target.classList?.contains('hs-mc-badge-img')

        // Kill badge tooltip if not on a badge (or the tooltip itself).
        // The 4x tooltip lands under the cursor on small badges; without the
        // tooltip-self check the very next mousemove sees target=tooltip,
        // dismisses, and the user sees a 1-frame flicker.
        if (badgeTooltip?.classList.contains('visible') && !onBadge && !target?.closest?.('#hs-badge-tooltip')) {
          hideBadgeTooltip()
        }

        // Kill emote tooltip instantly if not on an emote (or the tooltip
        // itself). Same self-overlap fix — picker search 4x tooltips covered
        // the cursor and were dismissing on first post-show mousemove.
        if (emoteTooltip?.classList.contains('visible')) {
          if (!onEmote && !target?.closest?.('#hs-emote-tooltip')) {
            hideEmoteTooltip()
            document.querySelectorAll('.hs-emote-highlight').forEach((w) => {
              w.classList.remove('hs-emote-highlight')
            })
          }
          // Don't reposition — stays anchored to element
        }

        // Kill user tooltip instantly if not on a username
        if (userTooltip?.classList.contains('visible')) {
          if (!onUser && !target?.closest?.('#hs-user-tooltip')) {
            hideUserTooltip()
          }
          // Don't reposition — stays anchored to element like website
        }

        // Kill link tooltip if not on a link
        const onLink = target?.closest?.('.hs-mc-link')
        if (linkTooltip?.classList.contains('visible')) {
          if (!onLink) {
            hideLinkTooltip()
          }
          // Don't reposition — stays anchored to element
        }
      })
    },
    'mc-tooltip-mousemove',
  )
}

// Sub tenure tracking — populated from IRC badge-info (subscriber/N = cumulative months)
const subTenureMap = new Map() // channel -> Map<usernameLC, months>
function trackSubTenure(channel, username, months) {
  if (!channel || !username || !months) return
  let channelMap = subTenureMap.get(channel)
  if (!channelMap) {
    channelMap = new Map()
    subTenureMap.set(channel, channelMap)
    // Cap distinct channels — re-derived from IRC badge-info on next message, so
    // evicting a cold channel is loss-free. Inner map stays capped at 500 below.
    while (subTenureMap.size > 64) subTenureMap.delete(subTenureMap.keys().next().value)
  }
  channelMap.set(username.toLowerCase(), months)
  while (channelMap.size > 500) channelMap.delete(channelMap.keys().next().value)
}
function formatSubTenure(months) {
  // Concise: drop months when years resolve. Matches content.js + formatAge.
  if (months >= 12) return `${Math.floor(months / 12)}y`
  return `${months}mo`
}

// User hover tooltip (profile preview)
let userTooltip = null
const _profileCache = new Map() // platform:username -> { profile, ts }
const _profileInflight = new Map() // cacheKey -> Promise dedup for concurrent hover+ctx-menu+card opens
// 5min TTL: relationship state is patched in-place by pcToggleFollow/Block so
// long-lived cache doesn't make the follow label go stale. Prevents
// /api/profile from being re-hit on every menu open after a single session
// hover. Also raises cache cap from 100 → 500.
const PROFILE_CACHE_TTL = 5 * 60 * 1000
const PROFILE_CACHE_MAX = 500
let _profileGen = 0 // generation counter to prevent stale renders

// Centralized cross-platform identity resolver. ALL identity lookups should go
// through this. Wraps _profileCache + /api/profile, returns a unified shape.
// Used by: pcAddAsChannel, renderAddChannelForm autofill, auto-multichat banner,
// any future awareness feature.
function shapeIdentity(profile) {
  if (!profile) return { ok: false }
  const identity = {
    heatsync: profile.username || null,
    twitch: profile.twitch_username || null,
    kick: profile.kick_username || null,
    youtube: profile.youtube_username || profile.youtube_channel_id || null,
  }
  const linked = [identity.twitch, identity.kick, identity.youtube].filter(Boolean)
  const liveOn = []
  if (profile.twitch_is_live) liveOn.push('twitch')
  if (profile.kick_is_live) liveOn.push('kick')
  if (profile.youtube_is_live) liveOn.push('youtube')
  return {
    ok: true,
    profile,
    identity,
    linkedCount: linked.length,
    isLinked: linked.length >= 2,
    liveOn,
  }
}

async function resolveIdentity(name, opts = {}) {
  if (!name) return { ok: false, error: 'no name' }
  const platform = opts.platform || null
  const cacheKey = `${platform || 'unknown'}:${String(name).toLowerCase()}`
  if (!opts.bust) {
    const cached = _profileCache.get(cacheKey)
    if (cached && Date.now() - cached.ts < PROFILE_CACHE_TTL) {
      return shapeIdentity(cached.profile)
    }
  }
  // Dedup concurrent lookups so hover + ctx-menu + card-open don't burn 3
  // tokens against the per-user rate limit. Also covers the case where the
  // user rapid-right-clicks while a prior fetch is in flight.
  if (_profileInflight.has(cacheKey)) return _profileInflight.get(cacheKey)
  const p = (async () => {
    try {
      const platParam = platform ? `?platform=${encodeURIComponent(platform)}` : ''
      const resp = await apiFetch(`/api/profile/${encodeURIComponent(name)}${platParam}`)
      if (!resp?.ok || !resp.data?.profile) {
        // On 429 / transient error, fall back to stale cache (any age) so
        // the UI keeps the last-known follow/block state instead of flipping
        // back to default ("follow" label) on every menu open.
        const stale = _profileCache.get(cacheKey)
        if (stale) return shapeIdentity(stale.profile)
        // Only flag as truly "not on heatsync" when server returned 404 or
        // 400. Anything else (429, 5xx, network, timeout) is transient — let
        // callers differentiate via `status`/`transient` so they can show
        // "try again" instead of "user isn't on heatsync".
        const status = resp?.status || 0
        const transient = status !== 404 && status !== 400
        return { ok: false, error: resp?.error || 'not found', notFound: !transient, transient, status }
      }
      const profile = resp.data.profile
      _profileCache.set(cacheKey, { profile, ts: Date.now() })
      while (_profileCache.size > PROFILE_CACHE_MAX) _profileCache.delete(_profileCache.keys().next().value)
      return shapeIdentity(profile)
    } catch (e) {
      const stale = _profileCache.get(cacheKey)
      if (stale) return shapeIdentity(stale.profile)
      return { ok: false, error: e.message || 'fetch failed' }
    } finally {
      _profileInflight.delete(cacheKey)
    }
  })()
  _profileInflight.set(cacheKey, p)
  return p
}

let _userTooltipTarget = null
let _userTooltipResizeObs = null
let _userTooltipMutObs = null

// CozetteVector's OTF advance widths aren't integer multiples at 13px
// (~5.984px per glyph), so any flex row of badges accumulates fractional
// X positions on every child after the first. Bitmap glyphs rendered at
// fractional X get sampled at sub-pixel offsets and smear — the "blurry"
// tooltip badges. Rounding each badge's width UP to the next integer
// resets the X of the next sibling to integer, killing the cascade.
// BADGE_LEAFS lists the specific badge classes (visible chips, never
// layout wrappers). Compound stat parents like .hs-pc-stat.op are rounded
// because their .hs-pc-num child has fractional width that pushes the
// sibling text node off integer; rounding the parent fixes the next
// sibling-row badge.
const TOOLTIP_BADGE_LEAFS = new Set([
  'hs-pc-platform',
  'hs-pc-name',
  'hs-pc-age',
  'hs-pc-role',
  'hs-pc-sub-tenure',
  'hs-pc-followage',
  'hs-pc-channel-follows',
  'hs-pc-rel-badge',
  'hs-pc-stat',
  'hs-pc-num',
  'hs-pc-loading',
  'hs-heat-num',
])
function roundTooltipBadgeWidths(tooltip) {
  if (!tooltip) return
  const els = tooltip.querySelectorAll('[class*="hs-pc-"], .hs-heat-num')
  for (const el of els) {
    let isBadge = false
    for (const c of el.classList)
      if (TOOLTIP_BADGE_LEAFS.has(c)) {
        isBadge = true
        break
      }
    if (!isBadge) continue
    if (!el.textContent?.trim()) continue
    el.style.width = ''
    const w = el.getBoundingClientRect().width
    const rounded = Math.ceil(w)
    if (Math.abs(w - rounded) > 0.01) el.style.width = `${rounded}px`
  }
}

function ensureUserTooltip() {
  if (!userTooltip || !document.contains(userTooltip)) {
    // Disconnect observers bound to the prior (now-detached) tooltip before
    // recreating, or each SPA reparent leaks a live ResizeObserver +
    // MutationObserver still firing against the stale node. untrackObserver
    // null-guards, so this is a no-op on first run.
    cleanup.untrackObserver(_userTooltipResizeObs)
    _userTooltipResizeObs = null
    cleanup.untrackObserver(_userTooltipMutObs)
    _userTooltipMutObs = null
    userTooltip = document.createElement('div')
    userTooltip.id = 'hs-user-tooltip'
    document.body.appendChild(cleanup.trackNode(userTooltip))
    // Keep tooltip away from the hovered username even as content fills in async
    // (followage badge, sub tenure badge, lazy-loaded data — all change height)
    if (typeof ResizeObserver !== 'undefined') {
      _userTooltipResizeObs = new ResizeObserver(() => {
        if (_userTooltipTarget && userTooltip.classList.contains('visible') && document.contains(_userTooltipTarget)) {
          positionTooltipAtElement(userTooltip, _userTooltipTarget)
        }
      })
      cleanup.trackObserver(_userTooltipResizeObs)
      _userTooltipResizeObs.observe(userTooltip)
    }
    // MutationObserver — round badge widths whenever the tooltip's subtree
    // changes (sync renderProfileCard + async sub-tenure + followage adds
    // children at different times; this catches all paths).
    if (typeof MutationObserver !== 'undefined') {
      _userTooltipMutObs = new MutationObserver(() => roundTooltipBadgeWidths(userTooltip))
      cleanup.trackObserver(_userTooltipMutObs)
      _userTooltipMutObs.observe(userTooltip, { childList: true, subtree: true })
    }
  }
  return userTooltip
}

function formatCompact(n) {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`
  return String(n)
}

function getAccountAge(dateStr) {
  if (!dateStr) return null
  const d = new Date(dateStr)
  if (Number.isNaN(d.getTime())) return null
  const now = new Date()
  const y = now.getFullYear() - d.getFullYear()
  const m = now.getMonth() - d.getMonth()
  const days = now.getDate() - d.getDate()
  if (y > 0) return `${y}y`
  if (m > 0) return `${m}m`
  return `${Math.max(0, days)}d`
}

function getCompactRelTime(dateStr) {
  if (!dateStr) return ''
  const ms = Date.now() - new Date(dateStr).getTime()
  const d = Math.floor(ms / 86400000)
  if (d > 365) return `${Math.floor(d / 365)}y ago`
  if (d > 30) return `${Math.floor(d / 30)}mo ago`
  if (d > 0) return `${d}d ago`
  const h = Math.floor(ms / 3600000)
  if (h > 0) return `${h}h ago`
  return 'just now'
}

function renderProfileCard(p, platform) {
  const pfp = p.twitch_profile_pic || p.kick_profile_pic || p.profile_image_url || 'https://heatsync.org/anon.webp'
  const displayName = p.display_name || p.username || 'unknown'

  // Role
  const bt = p.twitch_broadcaster_type
  let roleStr = '',
    roleCls = ''
  if (bt === 'partner') {
    roleStr = 'partner'
    roleCls = 'val-partner'
  } else if (bt === 'affiliate') {
    roleStr = 'affiliate'
    roleCls = 'val-affiliate'
  } else if (p.role === 'admin') {
    roleStr = 'admin'
    roleCls = 'val-admin'
  } else if (p.role === 'staff') {
    roleStr = 'staff'
    roleCls = 'val-staff'
  }

  // Account age
  const dates = [p.twitch_created_at, p.kick_created_at].filter(Boolean)
  const oldest = dates.length ? dates.reduce((a, b) => (new Date(b) < new Date(a) ? b : a)) : null
  const age = getAccountAge(oldest)

  // Live indicator HTML helper
  const liveStr = (vc) => `<span class="hs-pc-live">${vc > 0 ? `🔴 ${escapeHtml(formatCompact(vc))}` : '🔴'}</span>`

  // Bio with @mention/#tag autolinks
  const bioHtml = p.bio
    ? String(p.bio)
        .split(/(@[A-Za-z0-9_]{3,25}|#[A-Za-z0-9]{1,30})/g)
        .map((s) => {
          if (!s) return ''
          if (s[0] === '@' && s.length >= 4)
            return `<span class="hs-mc-user hs-pc-bio-mention" data-username="${escapeHtml(s.slice(1))}">@${escapeHtml(s.slice(1))}</span>`
          if (s[0] === '#' && s.length >= 2)
            return `<a class="hs-pc-bio-tag" href="https://heatsync.org/tags/${encodeURIComponent(s.slice(1).toLowerCase())}" target="_blank" rel="noopener noreferrer">#${escapeHtml(s.slice(1))}</a>`
          return escapeHtml(s)
        })
        .join('')
    : ''
  const bio = bioHtml ? `<div class="hs-pc-bio">${bioHtml}</div>` : ''

  // Stats
  const stats = p.stats || {}
  const heat = stats.total_heat || 0
  const op = stats.op_count || p.opCount || 0
  const mop = stats.mop_count || p.mopCount || 0
  const re = stats.re_count || p.reCount || 0
  const followers = Math.max(stats.followers || 0, p.twitch_followers || 0, p.kick_followers || 0)

  // Native chat badges (Twitch sub/mod/vip + 7TV/FFZ/BTTV/Chatterino) —
  // mirrors the .hs-pcard-id-chips row in the click-card. Uses the same
  // helpers, which return escaped <img> markup safe for innerHTML.
  let nativeBadges = ''
  try {
    const userId = p.twitch_user_id || p.twitch_id || null
    const uname = p.username || p.twitch_username || p.kick_username || ''
    const recent = uname && typeof getRecentMessagesFromUser === 'function' ? getRecentMessagesFromUser(uname) : []
    const recentTwitch = recent.find((m) => (m.platform || 'twitch') === 'twitch' && m.badges)
    if (recentTwitch && typeof renderBadges === 'function') {
      nativeBadges += renderBadges(recentTwitch.badges, recentTwitch.channel)
    }
    if (userId && typeof renderThirdPartyBadges === 'function') {
      nativeBadges += renderThirdPartyBadges(String(userId))
    }
  } catch {}

  // Build property-sheet rows. data-k attributes let the async update paths
  // (fetchAndShowFollowage etc) locate specific rows after the fetch lands.
  const sheetRows = []
  const sheetRow = (label, value, valCls, key) =>
    sheetRows.push(
      `<dt>${escapeHtml(label)}</dt><dd class="${valCls || ''}" data-k="${escapeHtml(key || label)}">${value}</dd>`,
    )

  // Private note (local) — surfaced on hover so a mod sees their annotation
  // without opening the full card. Top row for at-a-glance; truncated with the
  // full text in the title. hsNoteGet lives in user-notes.js (same bundle) —
  // alias-aware, so a note saved on any linked platform identity surfaces.
  const _noteUser = p.username || p.twitch_username || p.kick_username || ''
  const _note = (typeof hsNoteGet === 'function' && hsNoteGet(_noteUser, null)?.text) || ''
  if (_note) {
    const _short = _note.length > 60 ? `${_note.slice(0, 60)}…` : _note
    sheetRows.push(
      `<dt>note</dt><dd data-k="note" style="color:#fff" title="${escapeHtml(_note)}">${escapeHtml(_short)}</dd>`,
    )
  }

  // Platform identity rows — value text brand-colored, live dot inline.
  if (p.twitch_username) {
    const live = p.twitch_is_live ? ` ${liveStr(Number(p.twitch_viewer_count) || 0)}` : ''
    sheetRow('ttv', escapeHtml(p.twitch_username) + live, 'val-ttv', 'ttv')
  }
  if (p.kick_username) {
    const live = p.kick_is_live ? ` ${liveStr(Number(p.kick_viewer_count) || 0)}` : ''
    sheetRow('kick', escapeHtml(p.kick_username) + live, 'val-kick', 'kick')
  }
  if (p.youtube_username || p.youtube_channel_id) {
    const yname = p.youtube_username || p.youtube_channel_id
    const live = p.youtube_is_live ? ` ${liveStr(Number(p.youtube_viewer_count) || 0)}` : ''
    sheetRow('yt', escapeHtml(yname) + live, 'val-yt', 'yt')
  }
  if (age) sheetRow('acctage', escapeHtml(age), 'val-age', 'acctage')
  if (roleStr) sheetRow('type', escapeHtml(roleStr), roleCls, 'type')
  if (p.twitch_verified) sheetRow('verified', '✓ twitch', 'val-ttv', 'verified-ttv')
  if (p.kick_verified) sheetRow('verified', '✓ kick', 'val-kick', 'verified-kick')

  const heatHtml = heatSpanHtml(heat)
  if (heatHtml) sheetRow('heat', heatHtml, 'val-heat', 'heat')
  const posts = op + mop + re
  if (posts > 0) sheetRow('posts', escapeHtml(formatCompact(posts)), '', 'posts')
  if (followers > 0) sheetRow('followers', escapeHtml(formatCompact(followers)), 'val-followers', 'followers')

  // Relationship — covers all four angles across Twitch and Kick.
  // Timestamps: platform-verified only (Twitch helix followed_at / sub started_at,
  // Kick equivalents). Heatsync's own DB carries created_at sync timestamps that
  // do NOT reflect the actual platform relationship date — they read as the
  // signup/sync date for every profile (e.g. "5mo" everywhere) and lie about
  // multi-year Twitch follows. Show bare label when no platform date exists.
  const rel = p.relationship || {}
  // They → you (follow) — platform-verified flag only
  const followsYou = rel.profileFollowsViewerOnTwitch || rel.profileFollowsViewerOnKick
  if (followsYou) {
    const since = rel.profileFollowsViewerOnTwitchSince || rel.profileFollowsViewerOnKickSince
    const ageStr = since ? ` ${getCompactRelTime(since).replace(' ago', '')}` : ''
    sheetRow('they', escapeHtml(`follow you${ageStr}`), 'val-they-follow', 'follows-you')
  }
  // They → you (sub) — platform-verified flag only
  const subsYou = rel.profileSubbedToViewerOnTwitch || rel.profileSubbedToViewerOnKick
  if (subsYou) {
    const since = rel.profileTwitchSubSince || rel.profileKickSubSince
    const rawTier = rel.profileTwitchSubTier || rel.profileKickSubTier
    const tierNum = typeof rawTier === 'string' ? Math.round(Number(rawTier) / 1000) : rawTier
    const tierStr = tierNum && tierNum > 1 ? ` T${tierNum}` : ''
    const ageStr = since ? ` ${getCompactRelTime(since).replace(' ago', '')}` : ''
    sheetRow('they', escapeHtml(`sub to you${tierStr}${ageStr}`), 'val-they-sub', 'subs-you')
  }
  // You → them (follow) — ?? respects explicit false from canonical youFollow
  const youFollow = rel.youFollow ?? rel.isFollowing ?? rel.followsOnTwitch ?? rel.followsOnKick
  if (youFollow) {
    const since = rel.followsOnTwitchSince || rel.followsOnKickSince
    const ageStr = since ? ` ${getCompactRelTime(since).replace(' ago', '')}` : ''
    sheetRow('you', escapeHtml(`follow${ageStr}`), 'val-you-follow', 'you-follow')
  }
  // You → them (sub) — normalize tier
  const youSub = rel.youSub ?? rel.isSubscribed ?? rel.subscribedOnTwitch ?? rel.subscribedOnKick
  if (youSub) {
    const rawTier = rel.twitchSubTier || rel.kickSubTier || rel.subTier
    const tierNum = typeof rawTier === 'string' ? Math.round(Number(rawTier) / 1000) : rawTier
    const tier = tierNum || 1
    const since = rel.twitchSubSince || rel.kickSubSince
    const ageStr = since ? ` ${getCompactRelTime(since).replace(' ago', '')}` : ''
    sheetRow('you', escapeHtml(`sub${tier > 1 ? ` T${tier}` : ''}${ageStr}`), 'val-you-sub', 'you-sub')
  }
  if (followsYou && youFollow) sheetRow('rel', 'mutual', 'val-mutual', 'mutual-follow')
  if (subsYou && youSub) sheetRow('rel', 'mutual sub', 'val-mutual-sub', 'mutual-sub')

  const sheetHtml = sheetRows.length ? `<dl class="hs-pc-sheet">${sheetRows.join('')}</dl>` : ''

  // Paint the header name with the user's 7TV cosmetic when known.
  const nameUid = String(p.twitch_user_id || p.twitch_id || '')
  const namePaint = userPaintStyle(nameUid, (p.username || p.twitch_username || '').toLowerCase(), platform)
  // HeatSync paint (own-platform cosmetic) wins over 7TV — same precedence rule
  // as the live sender row (see hsPaintRender in paints.js). Twitch-keyed uid.
  const nameHsPaint = nameUid ? hsPaintRender(nameUid, displayName) : null

  // Hero banner placeholder — wraps the whole card so the banner sits behind
  // the avatar/info row. Filled async by pcApplyBanner once the Twitch GQL
  // response lands; until then the gradient placeholder (from CSS) carries
  // the layout so the tooltip doesn't resize after fetch.
  return `
      <div class="hs-pc-hero"><div class="hs-pc-hero-img"></div><div class="hs-pc-hero-scrim"></div></div>
      <div class="hs-pc-body">
        ${pfp ? `<img class="hs-pc-avatar" src="${escapeHtml(pfp)}" alt="${escapeHtml(displayName)}">` : ''}
        <div class="hs-pc-info">
          <div class="hs-pc-header">${nativeBadges || `<span class="hs-pc-name${nameHsPaint ? ` ${nameHsPaint.cls}` : ''}"${nameHsPaint ? nameHsPaint.splitAttr : ''} style="${nameHsPaint ? '' : namePaint}">${nameHsPaint ? nameHsPaint.html : escapeHtml(displayName)}</span>`}</div>
          ${bio}
          ${sheetHtml}
        </div>
      </div>`
}

// Async banner fetch + apply for the hover tooltip. Mirrors pcApplyBanner in
// profile-card.js but targets #hs-user-tooltip's hero element. Bails if the
// tooltip moved to a different user/profile while we were fetching.
// Walks the platform chain (twitch > kick > youtube, context-prioritized).
async function applyTooltipBanner(tooltip, profile, platform, username, gen) {
  if (typeof fetchBannerChain !== 'function' || typeof pickBannerChain !== 'function') return
  const chain = pickBannerChain(profile || {}, platform, username)
  if (!chain.length) return
  const banner = await fetchBannerChain(chain)
  if (!banner) return
  if (gen !== _profileGen) return
  const hero = tooltip.querySelector('.hs-pc-hero')
  if (!hero) return
  const heroImg = hero.querySelector('.hs-pc-hero-img')
  // safeUrl gates protocol + escape quote/backslash so a crafted banner URL
  // can't break out of url("…") and inject CSS.
  const safe = safeUrl(banner.bannerUrl || banner.offlineUrl)
  if (safe && heroImg) {
    const probe = new Image()
    probe.onload = () => {
      if (gen !== _profileGen) return
      heroImg.style.backgroundImage = `url("${safe.replace(/\\/g, '%5C').replace(/"/g, '%22')}")`
      hero.classList.add('hs-pc-hero-loaded')
      if (_userTooltipTarget) positionTooltipAtElement(tooltip, _userTooltipTarget)
    }
    probe.referrerPolicy = 'no-referrer'
    probe.src = safe
  }
  // Fallback path leaves the avatar as anon.webp — fill it from the banner
  // fetch's profile_pic (kick api hands this back next to the banner URL).
  // Skip if a real avatar is already in place (success path uses heatsync data).
  if (banner.profileUrl) {
    const avatar = tooltip.querySelector('.hs-pc-avatar')
    if (avatar && (avatar.src || '').includes('anon.webp')) {
      // safeUrl-gate like every other avatar path (social.js/main.js) — profileUrl
      // comes from Kick v2 / YT HTML extraction, neither URL-validated by the BG.
      const safe = safeUrl(banner.profileUrl)
      if (safe) avatar.src = safe
    }
  }
  if (banner.accent) {
    tooltip.style.setProperty('--hs-pc-accent', banner.accent)
    hero.classList.add('hs-pc-hero-accent')
  }
  if (banner.sourcePlatform) hero.dataset.source = banner.sourcePlatform
}

// Async pronoun fetch + apply for the hover tooltip — mirrors
// applyTooltipBanner's fire-and-forget shape. Twitch-only (pronoundb has no
// Kick/YouTube platform). Appends a chip into .hs-pc-header, next to the
// native badges / name. Bails if the tooltip moved to a different user while
// the fetch was in flight (gen check, same pattern as the rest of this file).
async function applyTooltipPronouns(tooltip, twitchUserId, gen) {
  if (!twitchUserId || typeof fetchPronouns !== 'function') return
  const data = await fetchPronouns('twitch', twitchUserId)
  if (gen !== _profileGen) return
  const words = data?.pronouns
  if (!words?.length) return
  const header = tooltip.querySelector('.hs-pc-header')
  if (!header || header.querySelector('.hs-pc-pronoun')) return
  const chip = document.createElement('span')
  chip.className = 'hs-pc-pronoun'
  chip.textContent = words.join('/').toLowerCase()
  header.appendChild(chip)
}

// Determine Twitch channel context for followage lookups
// userPlatform: the platform of the user being looked up (from data-platform)
function getTooltipChannelContext(userPlatform) {
  // If looking up a Twitch user, always resolve to the Twitch channel name
  const wantTwitch = !userPlatform || userPlatform === 'twitch'
  // Live tab → current channel from URL or override
  if (currentTab === 'live') {
    if (wantTwitch && location.hostname.includes('kick.com')) {
      // On Kick live tab but need Twitch channel — find from config
      const liveCh = getLiveChannel()
      const ch = config.channels.find((c) => c.kick === liveCh || c.id === liveCh)
      if (ch?.twitch) return ch.twitch
    }
    return getLiveChannel()
  }
  // Channel tab → look up from config
  const ch = config.channels.find((c) => c.id === currentTab)
  if (ch) {
    // For Twitch users, always return Twitch channel; for Kick users, Kick channel
    if (wantTwitch) return ch.twitch || ch.kick
    return ch.kick || ch.twitch
  }
  return getLiveChannel()
}

// NOTE: innerHTML usage is XSS-safe — all user content goes through escapeHtml() in renderProfileCard
// (escapeHtml converts &, <, >, ", ' to HTML entities before any innerHTML assignment)
async function showUserTooltip(targetEl, username, color, platform) {
  hsTipStats.userShow++
  const tooltip = ensureUserTooltip()
  // Re-append only when it isn't already last — see hsAppendLastIfNeeded.
  hsAppendLastIfNeeded(tooltip)
  const gen = ++_profileGen
  _userTooltipTarget = targetEl

  // Get channel from the message element for sub tenure lookup
  const msgChannel = targetEl.closest?.('.hs-mc-msg')?.dataset?.msgChannel

  // Show loading state immediately (username is escaped via escapeHtml)
  tooltip.innerHTML = `<div class="hs-pc-loading" style="color:${color || '#fff'}">${escapeHtml(username)}...</div>`
  tooltip.classList.add('visible')
  positionTooltipAtElement(tooltip, targetEl)

  // Check cache (keyed by platform:username to avoid cross-platform collisions)
  const cacheKey = `${platform || 'unknown'}:${username.toLowerCase()}`
  const cached = _profileCache.get(cacheKey)
  if (cached && Date.now() - cached.ts < PROFILE_CACHE_TTL) {
    if (gen !== _profileGen) return
    // NOTE: innerHTML is XSS-safe — all user content goes through escapeHtml() in renderProfileCard
    tooltip.innerHTML = renderProfileCard(cached.profile, platform)
    appendSubTenureBadge(tooltip, username, msgChannel)
    positionTooltipAtElement(tooltip, targetEl)
    fetchAndShowFollowage(tooltip, username, gen, platform)
    applyTooltipBanner(tooltip, cached.profile, platform, username, gen)
    applyTooltipPronouns(tooltip, cached.profile?.twitch_user_id || cached.profile?.twitch_id, gen)
    return
  }

  // Fetch profile — pass platform so server can disambiguate same-name users across platforms
  const platParam = platform ? `?platform=${encodeURIComponent(platform)}` : ''
  const resp = await apiFetch(`/api/profile/${encodeURIComponent(username)}${platParam}`)
  if (gen !== _profileGen) return // user moved away

  let profile = null
  if (resp?.ok && resp.data?.profile) {
    profile = resp.data.profile
  } else if (platform === 'kick') {
    // Cross-platform probe — most unregistered kick chatters share their
    // handle on twitch. Same-name twitch hit lands a full profile (heat,
    // follows, banner, partner status) for what would otherwise be a bare
    // fallback. Only fires when the kick lookup misses.
    const twResp = await apiFetch(`/api/profile/${encodeURIComponent(username)}?platform=twitch`)
    if (gen !== _profileGen) return
    if (twResp?.ok && twResp.data?.profile) profile = twResp.data.profile
  }

  if (profile) {
    _profileCache.set(cacheKey, { profile, ts: Date.now() })
    while (_profileCache.size > PROFILE_CACHE_MAX) _profileCache.delete(_profileCache.keys().next().value)
    // NOTE: innerHTML XSS-safe — renderProfileCard escapes everything
    tooltip.innerHTML = renderProfileCard(profile, platform)
    appendSubTenureBadge(tooltip, username, msgChannel)
    positionTooltipAtElement(tooltip, targetEl)
    fetchAndShowFollowage(tooltip, username, gen, platform)
    applyTooltipBanner(tooltip, profile, platform, username, gen)
    applyTooltipPronouns(tooltip, profile?.twitch_user_id || profile?.twitch_id, gen)
  } else {
    // Fallback — populated from client-only signals so kick chatters with
    // no heatsync acct still get a real card: chat badges from recent msgs,
    // platform-link row, color-tinted name. applyTooltipBanner extends to
    // also fill the avatar from kick.com profile_pic.
    const safeName = escapeHtml(username)
    const safeColor = sanitizeColor(color || '#fff')
    let nativeBadges = ''
    try {
      const recent = typeof getRecentMessagesFromUser === 'function' ? getRecentMessagesFromUser(username) : []
      const rTwitch = recent.find((m) => (m.platform || 'twitch') === 'twitch' && m.badges)
      if (rTwitch && typeof renderBadges === 'function') nativeBadges += renderBadges(rTwitch.badges, rTwitch.channel)
      const rKick = recent.find((m) => m.platform === 'kick' && m.badges)
      if (rKick && typeof renderBadges === 'function') nativeBadges += renderBadges(rKick.badges, rKick.channel, 'kick')
      const rYt = recent.find((m) => m.platform === 'youtube' && m.badges)
      if (rYt && typeof renderBadges === 'function') nativeBadges += renderBadges(rYt.badges, rYt.channel, 'youtube')
    } catch {}
    const platRow =
      platform === 'kick'
        ? `<dt>kick</dt><dd class="val-kick" data-k="kick">${safeName}</dd>`
        : platform === 'youtube' || platform === 'yt'
          ? `<dt>yt</dt><dd class="val-yt" data-k="yt">${safeName}</dd>`
          : `<dt>ttv</dt><dd class="val-ttv" data-k="ttv">${safeName}</dd>`
    // Resolve the twitch-space uid the same way userPaintStyle does internally,
    // so HeatSync-paint precedence (which needs the uid) can win over 7TV — same
    // rule as the live sender row (see hsPaintRender in paints.js).
    const fbLower = username.toLowerCase()
    const fbUid =
      platform === 'twitch' && typeof knownUserIds !== 'undefined' && typeof userKey === 'function'
        ? knownUserIds.get(userKey(fbLower, 'twitch')) || ''
        : ''
    const namePaint = platform === 'twitch' ? userPaintStyle(fbUid, fbLower, 'twitch') : ''
    const nameHsPaint = fbUid ? hsPaintRender(fbUid, username) : null
    const header = nativeBadges
      ? nativeBadges
      : `<span class="hs-pc-name${nameHsPaint ? ` ${nameHsPaint.cls}` : ''}"${nameHsPaint ? nameHsPaint.splitAttr : ''} style="${nameHsPaint ? '' : namePaint || `color:${safeColor}`}">${nameHsPaint ? nameHsPaint.html : safeName}</span>`
    // NOTE: innerHTML XSS-safe — username via escapeHtml, color via sanitizeColor (hex-only),
    // nativeBadges from renderBadges which emits escaped <img> markup
    tooltip.innerHTML = `<div class="hs-pc-hero"><div class="hs-pc-hero-img"></div><div class="hs-pc-hero-scrim"></div></div><div class="hs-pc-body"><img class="hs-pc-avatar" src="https://heatsync.org/anon.webp" alt=""><div class="hs-pc-info"><div class="hs-pc-header">${header}</div><dl class="hs-pc-sheet">${platRow}</dl></div></div>`
    appendSubTenureBadge(tooltip, username, msgChannel)
    fetchAndShowFollowage(tooltip, username, gen, platform)
    applyTooltipBanner(tooltip, null, platform, username, gen)
    applyTooltipPronouns(tooltip, fbUid, gen)
  }
}

// Append sub tenure as a sheet row (sync, no fetch). Dedupes via data-k.
function appendSubTenureBadge(tooltip, username, msgChannel) {
  const channelLogin = msgChannel || getTooltipChannelContext()
  if (!channelLogin) return
  const channelMap = subTenureMap.get(channelLogin)
  if (!channelMap) return
  const months = channelMap.get(username.toLowerCase())
  if (!months) return
  const sheet = tooltip.querySelector('.hs-pc-sheet')
  if (!sheet) return
  if (sheet.querySelector('dd[data-k="sub-tenure"]')) return
  const isSelfChannel =
    typeof currentUsername === 'string' &&
    currentUsername &&
    channelLogin.toLowerCase() === currentUsername.toLowerCase()
  const dt = document.createElement('dt')
  const dd = document.createElement('dd')
  dd.dataset.k = 'sub-tenure'
  if (isSelfChannel) {
    dt.textContent = 'they'
    dd.className = 'val-they-sub'
    dd.textContent = `sub to you ${formatSubTenure(months)}`
  } else {
    dt.textContent = 'ch sub'
    dd.className = 'val-ch'
    dd.textContent = `${channelLogin} ${formatSubTenure(months)}`
  }
  sheet.appendChild(dt)
  sheet.appendChild(dd)
}

// Async followage fetch — appends to tooltip after profile renders (DOM methods, no innerHTML)
async function fetchAndShowFollowage(tooltip, username, gen, userPlatform) {
  // Only show followage for Twitch users (followage API is Twitch-only)
  if (userPlatform && userPlatform !== 'twitch') return
  const channelLogin = getTooltipChannelContext(userPlatform)
  if (!channelLogin) return
  if (typeof lookupFollowage !== 'function') return
  const result = await lookupFollowage(username, channelLogin)
  if (gen !== _profileGen || !result) return
  // When the channel context IS the viewer (e.g. you're hovering a chatter
  // in your own channel tab), the followage rows duplicate the heatsync
  // "they → you" rel-row. Skip the literal Twitch followage row in that
  // case. Still process channelFollowedAt below for the you-follow age fill.
  const isSelfChannel =
    typeof currentUsername === 'string' &&
    currentUsername &&
    channelLogin.toLowerCase() === currentUsername.toLowerCase()
  const sheetEl = tooltip.querySelector('.hs-pc-sheet')
  const upsertRow = (key, label, value, valCls) => {
    if (!sheetEl) return
    const existing = sheetEl.querySelector(`dd[data-k="${key}"]`)
    if (existing) {
      existing.textContent = value
      if (valCls) existing.className = valCls
      return
    }
    const dt = document.createElement('dt')
    dt.textContent = label
    const dd = document.createElement('dd')
    if (valCls) dd.className = valCls
    dd.dataset.k = key
    dd.textContent = value
    sheetEl.appendChild(dt)
    sheetEl.appendChild(dd)
  }
  if (!isSelfChannel) {
    if (result.followedAt) {
      const age = getCompactRelTime(result.followedAt).replace(' ago', '')
      upsertRow('ch-follow', 'ch follow', `${channelLogin} ${age}`, 'val-ch')
    } else {
      upsertRow('ch-follow', 'ch follow', `not following ${channelLogin}`, 'val-affiliate')
    }
  }
  // Channel follows this user.
  if (result.channelFollowedAt && !isSelfChannel) {
    upsertRow('ch-follows', 'follower', channelLogin, 'val-ch')
  }
  // When channel === viewer, channelFollowedAt is the viewer's authoritative
  // Twitch follow date. Use it to fill in (or override) the you-follow row.
  if (isSelfChannel && result.channelFollowedAt) {
    const sheet = tooltip.querySelector('.hs-pc-sheet')
    const youFollowVal = sheet?.querySelector('dd[data-k="you-follow"]')
    const ageStr = ` ${getCompactRelTime(result.channelFollowedAt).replace(' ago', '')}`
    if (youFollowVal) {
      youFollowVal.textContent = `follow${ageStr}`
    } else if (sheet) {
      const dt = document.createElement('dt')
      dt.textContent = 'you'
      const dd = document.createElement('dd')
      dd.className = 'val-you-follow'
      dd.dataset.k = 'you-follow'
      dd.textContent = `follow${ageStr}`
      sheet.appendChild(dt)
      sheet.appendChild(dd)
    }
  }
  // Update follower count from live data
  const sheet = tooltip.querySelector('.hs-pc-sheet')
  if (sheet && result.followerCount != null) {
    const followerVal = sheet.querySelector('dd[data-k="followers"]')
    if (followerVal) {
      followerVal.textContent = formatCompact(result.followerCount)
    } else {
      const dt = document.createElement('dt')
      dt.textContent = 'followers'
      const dd = document.createElement('dd')
      dd.dataset.k = 'followers'
      dd.textContent = formatCompact(result.followerCount)
      sheet.appendChild(dt)
      sheet.appendChild(dd)
    }
  }
}

function positionTooltipAtElement(tooltip, targetEl) {
  const elRect = targetEl.getBoundingClientRect()
  const tipRect = tooltip.getBoundingClientRect()
  const vw = window.innerWidth
  const vh = window.innerHeight
  const gap = 6 // visible separation so the hovered username is never touched
  const margin = 5 // viewport edge margin

  const spaceTop = elRect.top - margin
  const spaceBottom = vh - elRect.bottom - margin
  const spaceLeft = elRect.left - margin
  const spaceRight = vw - elRect.right - margin
  const needV = tipRect.height + gap
  const needH = tipRect.width + gap

  let x, y, side
  if (spaceTop >= needV) {
    side = 'top'
    y = elRect.top - tipRect.height - gap
    x = elRect.left + elRect.width / 2 - tipRect.width / 2
  } else if (spaceBottom >= needV) {
    side = 'bottom'
    y = elRect.bottom + gap
    x = elRect.left + elRect.width / 2 - tipRect.width / 2
  } else if (spaceRight >= needH) {
    side = 'right'
    x = elRect.right + gap
    y = elRect.top + elRect.height / 2 - tipRect.height / 2
  } else if (spaceLeft >= needH) {
    side = 'left'
    x = elRect.left - tipRect.width - gap
    y = elRect.top + elRect.height / 2 - tipRect.height / 2
  } else {
    // No side has full room — pick the largest and clamp; still nudge off the element
    const maxV = Math.max(spaceTop, spaceBottom)
    const maxH = Math.max(spaceLeft, spaceRight)
    if (maxV >= maxH) {
      side = spaceTop >= spaceBottom ? 'top' : 'bottom'
      y = side === 'top' ? margin : elRect.bottom + gap
      x = elRect.left + elRect.width / 2 - tipRect.width / 2
    } else {
      side = spaceRight >= spaceLeft ? 'right' : 'left'
      x = side === 'right' ? elRect.right + gap : Math.max(margin, elRect.left - tipRect.width - gap)
      y = elRect.top + elRect.height / 2 - tipRect.height / 2
    }
  }

  // Clamp to viewport — but on the "long" axis only, so we don't push the tip back over the element
  if (side === 'top' || side === 'bottom') {
    x = Math.max(margin, Math.min(x, vw - tipRect.width - margin))
  } else {
    y = Math.max(margin, Math.min(y, vh - tipRect.height - margin))
  }

  tooltip.style.left = `${Math.round(x)}px`
  tooltip.style.top = `${Math.round(y)}px`
}

function hideUserTooltip() {
  _profileGen++
  _userTooltipTarget = null
  if (userTooltip) {
    userTooltip.classList.remove('visible')
  }
}

function setupUserTooltipHandlers() {
  if (_onceGuardsTooltips.userTooltipSetup) return
  _onceGuardsTooltips.userTooltipSetup = true

  // 120ms hover-intent debounce: scrolling chat passes the cursor across
  // 10+ usernames in a single scroll-tick. Without debounce every one
  // fires apiFetch immediately. Cache hits already render instantly so
  // those bypass the debounce; only cold lookups wait.
  let _userHoverTimer = null
  let _userHoverTarget = null
  function clearUserHoverTimer() {
    if (_userHoverTimer) {
      cleanup.clearTimeout(_userHoverTimer)
      _userHoverTimer = null
    }
    _userHoverTarget = null
  }

  cleanup.addEventListener(
    document,
    'mouseover',
    (e) => {
      const target = e.target.closest('.hs-mc-user')
      if (target) {
        const username = target.dataset.username || target.textContent.replace(/^@/, '')
        const color = target.style.color
        const platform = target.dataset.platform || null
        const cacheKey = `${platform || 'unknown'}:${username.toLowerCase()}`
        const cached = _profileCache.get(cacheKey)
        if (cached && Date.now() - cached.ts < PROFILE_CACHE_TTL) {
          // Cache hit: render synchronously, no debounce needed.
          clearUserHoverTimer()
          showUserTooltip(target, username, color, platform)
        } else {
          // Cold lookup: debounce + show skeleton immediately so the user
          // sees acknowledgement of the hover even while the fetch runs.
          clearUserHoverTimer()
          _userHoverTarget = target
          showUserSkeleton(target, username, color)
          _userHoverTimer = cleanup.setTimeout(() => {
            _userHoverTimer = null
            if (_userHoverTarget !== target || !document.contains(target)) return
            showUserTooltip(target, username, color, platform)
          }, 120)
        }

        // Highlight all matching usernames
        const name = target.dataset.username
        if (name) {
          const overlay = document.getElementById('hs-mc-overlay')
          if (overlay) {
            overlay.querySelectorAll(`.hs-mc-user[data-username="${CSS.escape(name)}"]`).forEach((el) => {
              el.classList.add('hs-user-highlight')
            })
          }
        }
      }
    },
    'mc-user-tooltip-mouseover',
  )

  cleanup.addEventListener(
    document,
    'mouseout',
    (e) => {
      const target = e.target.closest('.hs-mc-user')
      if (target) {
        clearUserHoverTimer()
        hideUserTooltip()

        // Remove all username highlights
        const overlay = document.getElementById('hs-mc-overlay')
        if (overlay) {
          overlay.querySelectorAll('.hs-user-highlight').forEach((el) => {
            el.classList.remove('hs-user-highlight')
          })
        }
      }
    },
    'mc-user-tooltip-mouseout',
  )
}

// Synchronous skeleton — username + color, no fetch. Replaced by full
// card when the apiFetch resolves (showUserTooltip post-debounce).
// Uses textContent (no innerHTML) so the username string is never parsed as HTML.
function showUserSkeleton(targetEl, username, color) {
  const tooltip = ensureUserTooltip()
  document.body.appendChild(cleanup.trackNode(tooltip))
  _userTooltipTarget = targetEl
  while (tooltip.firstChild) tooltip.removeChild(tooltip.firstChild)
  const loading = document.createElement('div')
  loading.className = 'hs-pc-loading'
  if (color) loading.style.color = color
  else loading.style.color = '#fff'
  loading.textContent = `${username}…`
  tooltip.appendChild(loading)
  tooltip.classList.add('visible')
  positionTooltipAtElement(tooltip, targetEl)
}

// Link preview tooltip (Chatterino-style)
let linkTooltip = null
const _linkPreviewCache = new Map() // url -> { title, description, image } | null
let _linkHoverUrl = null
let _linkFetchInFlight = null

function ensureLinkTooltip() {
  if (linkTooltip) return linkTooltip
  linkTooltip = document.createElement('div')
  linkTooltip.id = 'hs-link-tooltip'
  document.body.appendChild(cleanup.trackNode(linkTooltip))
  return linkTooltip
}

let _linkTargetEl = null

function showLinkTooltip(e, url) {
  if (!linksEnabled || !linkPreviewsEnabled || !url) return
  _linkHoverUrl = url
  _linkTargetEl = e.target.closest('.hs-mc-link') || e.target
  const tip = ensureLinkTooltip()
  document.body.appendChild(cleanup.trackNode(tip))
  let hostname = ''
  try {
    hostname = new URL(url).hostname
  } catch {
    hostname = url
  }

  // Show loading state immediately
  const loadWrap = document.createElement('div')
  loadWrap.className = 'link-text'
  const loadSpan = document.createElement('span')
  loadSpan.className = 'link-loading'
  loadSpan.textContent = t('common_loading')
  const domainSpan = document.createElement('span')
  domainSpan.className = 'link-domain'
  domainSpan.textContent = hostname
  loadWrap.appendChild(loadSpan)
  loadWrap.appendChild(domainSpan)
  tip.replaceChildren(loadWrap)
  tip.classList.add('visible')
  positionTooltipAtElement(tip, _linkTargetEl)

  // Check cache
  if (_linkPreviewCache.has(url)) {
    const cached = _linkPreviewCache.get(url)
    if (_linkHoverUrl === url) renderLinkPreview(tip, cached, url)
    return
  }

  // Fetch from background
  _linkFetchInFlight = url
  safeSendMessage({ type: 'fetch_link_preview', url }).then((data) => {
    // Only cache a real hit. Caching `null` here would make one transient
    // failure (timeout, network blip) permanently kill previews for this
    // URL for the rest of the session — leave it uncached so the next hover
    // just retries.
    if (data) {
      _linkPreviewCache.set(url, data)
      while (_linkPreviewCache.size > 500) _linkPreviewCache.delete(_linkPreviewCache.keys().next().value)
    }
    if (_linkFetchInFlight === url) _linkFetchInFlight = null
    if (_linkHoverUrl === url && tip.classList.contains('visible')) {
      renderLinkPreview(tip, data, url)
    }
  })
}

// Background-prefetch link preview without showing the tooltip — fired on
// mousedown (click-intent) so the og fetch lands before the user releases.
// No-op when cache already has it. Used by mousedown handler in setupLinkTooltipHandlers.
function prefetchLinkPreview(url) {
  if (!url || _linkPreviewCache.has(url)) return
  safeSendMessage({ type: 'fetch_link_preview', url })
    .then((data) => {
      // See showLinkTooltip: don't cache a failed lookup so a later real
      // hover on this URL gets a fresh retry instead of a permanent miss.
      if (data) {
        _linkPreviewCache.set(url, data)
        while (_linkPreviewCache.size > 500) _linkPreviewCache.delete(_linkPreviewCache.keys().next().value)
      }
    })
    .catch(() => {})
}

function renderLinkPreview(tip, data, url) {
  let hostname = ''
  try {
    hostname = new URL(url).hostname
  } catch {
    hostname = url
  }
  tip.replaceChildren() // clear
  let hasContent = false
  const textWrap = document.createElement('div')
  textWrap.className = 'link-text'
  if (data) {
    if (data.image && /^https?:\/\//i.test(data.image)) {
      const img = document.createElement('img')
      img.src = data.image
      img.alt = ''
      img.loading = 'lazy'
      img.onerror = () => {
        img.remove()
        if (_linkTargetEl) positionTooltipAtElement(tip, _linkTargetEl)
      }
      tip.appendChild(img)
      hasContent = true
    }
    if (data.title) {
      const t = document.createElement('span')
      t.className = 'link-title'
      t.textContent = data.title
      textWrap.appendChild(t)
      hasContent = true
    }
    if (data.description) {
      const d = document.createElement('span')
      d.className = 'link-desc'
      d.textContent = data.description
      textWrap.appendChild(d)
      hasContent = true
    }
  }
  // If no og data at all, show full URL instead of just domain
  const dom = document.createElement('span')
  dom.className = 'link-domain'
  dom.textContent = hasContent ? hostname : url
  textWrap.appendChild(dom)
  tip.appendChild(textWrap)
  // Reposition after content changed size
  if (_linkTargetEl) positionTooltipAtElement(tip, _linkTargetEl)
}

function hideLinkTooltip() {
  _linkHoverUrl = null
  if (linkTooltip) linkTooltip.classList.remove('visible')
}

let _linkHideTimer = null
function cancelLinkHide() {
  if (_linkHideTimer) {
    cleanup.clearTimeout(_linkHideTimer)
    _linkHideTimer = null
  }
}
function scheduleLinkHide(delay = 250) {
  cancelLinkHide()
  // If a fetch is in flight, wait for it so the user gets to see the result
  // even if chat scroll dragged the link out from under their cursor.
  const wait = _linkFetchInFlight ? Math.max(delay, 1500) : delay
  _linkHideTimer = cleanup.setTimeout(() => {
    _linkHideTimer = null
    hideLinkTooltip()
  }, wait)
}

function setupLinkTooltipHandlers() {
  if (_onceGuardsTooltips.linkTooltipSetup) return
  _onceGuardsTooltips.linkTooltipSetup = true

  cleanup.addEventListener(
    document,
    'mouseover',
    (e) => {
      const link = e.target.closest('.hs-mc-link')
      if (link) {
        cancelLinkHide()
        showLinkTooltip(e, link.href)
        return
      }
      // Hovering the tooltip itself keeps it open (lets user read/click image).
      if (e.target.closest?.('#hs-link-tooltip')) cancelLinkHide()
    },
    'mc-link-tooltip-mouseover',
  )

  cleanup.addEventListener(
    document,
    'mouseout',
    (e) => {
      const link = e.target.closest('.hs-mc-link')
      if (link) scheduleLinkHide()
      else if (e.target.closest?.('#hs-link-tooltip')) scheduleLinkHide()
    },
    'mc-link-tooltip-mouseout',
  )

  // Click-intent prefetch: mousedown fires ~150ms before click. Warm the
  // og cache so users who click without hovering long enough don't wait.
  cleanup.addEventListener(
    document,
    'mousedown',
    (e) => {
      const link = e.target.closest?.('.hs-mc-link')
      if (link?.href) prefetchLinkPreview(link.href)
    },
    'mc-link-prefetch-mousedown',
  )
}
