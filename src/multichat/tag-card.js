// Tag hover card — hovering a #tag in chat shows posts / followers / last-used
// (and, signed in, whether you follow it). Same shell, position, dismissal and
// label: value rows as the user hover card (tooltips.js); data from
// GET /api/tags/:tag/card via the background api_fetch path, so this script
// never holds the token. A tag heatsync doesn't know shows nothing.
// Note: all innerHTML usage passes content through escapeHtml() first.

const TAG_CARD_TTL = 60 * 1000
const TAG_CARD_MAX = 200
const TAG_CARD_HOVER_MS = 120 // same hover-intent delay as the user card
const TAG_CARD_SCROLL_QUIET_MS = 200 // no fetch within this of a wheel scroll
const TAG_CARD_TOUCH_QUIET_MS = 1000 // a tap fires synthetic mouseovers; ignore them
const TAG_CARD_RE = /^[A-Za-z][A-Za-z0-9_]{1,29}$/ // mirrors highlightHashtagsInHtml
const _tagCardCache = new Map() // tag -> { model, ts } (model null = unknown tag)
const _tagCardInflight = new Map() // tag -> Promise<model|null>

// Pure: apiFetch response -> card model, or null (show nothing).
// `following` only exists when the request was authed, so its absence IS the
// signed-out state and the `you:` row is dropped.
function hsTagCardModel(resp, tr) {
  const d = resp?.ok ? resp.data : null
  if (!d || typeof d.name !== 'string' || !d.name) return null
  const count = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0)
  const stats = [
    { label: tr('mc_tagcard_posts'), value: formatCompact(count(d.post_count)) },
    { label: tr('mc_tagcard_followers'), value: formatCompact(count(d.follower_count)) },
  ]
  if (d.last_used_at) stats.push({ label: tr('mc_tagcard_last'), value: hsCardRelativeTime(d.last_used_at) })
  const you =
    typeof d.following === 'boolean'
      ? { label: tr('mc_tagcard_you'), value: tr(d.following ? 'mc_tagcard_following' : 'mc_tagcard_not_following') }
      : null
  return { name: d.name, stats, you }
}

function hsTagCardRow(r) {
  return `<div class="hs-card-sheet-row"><dt>${escapeHtml(r.label)}</dt><dd>${escapeHtml(r.value)}</dd></div>`
}

function hsTagCardHtml(model) {
  const you = model.you ? `<dl class="hs-card-sheet">${hsTagCardRow(model.you)}</dl>` : ''
  return `<div class="hs-card hs-card-peek hs-card-chatter"><div class="hs-card-name">#${escapeHtml(model.name)}</div><dl class="hs-card-sheet">${model.stats.map(hsTagCardRow).join('')}</dl>${you}</div>`
}

// Resolves the model (cached 60s, unknown tags too), or null. 404 is a real
// answer and is cached; network/other failures are not, so a blip retries.
// `signal` abort resolves null at once and the shared request finishes quietly
// into the cache (the background request itself cannot be cancelled).
function fetchTagCard(tag, signal) {
  const key = String(tag).toLowerCase()
  if (signal?.aborted) return Promise.resolve(null)
  const hit = _tagCardCache.get(key)
  if (hit && Date.now() - hit.ts < TAG_CARD_TTL) return Promise.resolve(hit.model)
  let p = _tagCardInflight.get(key)
  if (!p) {
    p = apiFetch(`/api/tags/${encodeURIComponent(key)}/card`)
      .then((resp) => {
        const model = hsTagCardModel(resp, t)
        if (model || resp?.status === 404) {
          _tagCardCache.set(key, { model, ts: Date.now() })
          if (_tagCardCache.size > TAG_CARD_MAX) _tagCardCache.delete(_tagCardCache.keys().next().value)
        }
        return model
      })
      .catch(() => null)
      .finally(() => {
        _tagCardInflight.delete(key)
      })
    _tagCardInflight.set(key, p)
  }
  if (!signal) return p
  return Promise.race([
    p,
    new Promise((resolve) => signal.addEventListener('abort', () => resolve(null), { once: true })),
  ])
}

function setupTagCardHandlers() {
  if (_onceGuardsTooltips.tagCardSetup) return
  _onceGuardsTooltips.tagCardSetup = true

  let timer = null
  let ctl = null
  let hovered = null
  let lastWheel = 0
  let lastTouch = 0

  function cancel() {
    if (timer) cleanup.clearTimeout(timer)
    timer = null
    ctl?.abort()
    ctl = null
    hovered = null
  }

  async function show(target, tag) {
    const mine = ctl
    const model = await fetchTagCard(tag, mine?.signal)
    if (!model || ctl !== mine || hovered !== target || !document.contains(target)) return
    const tooltip = ensureUserTooltip()
    hsAppendLastIfNeeded(tooltip)
    ++_profileGen
    _userTooltipTarget = target
    // NOTE: innerHTML XSS-safe — hsTagCardHtml escapes every field
    tooltip.innerHTML = hsTagCardHtml(model)
    tooltip.classList.add('visible')
    positionTooltipAtElement(hsExtTooltipPositionTarget(tooltip), target)
  }

  cleanup.addEventListener(document, 'touchstart', () => (lastTouch = Date.now()), { passive: true })
  cleanup.addEventListener(document, 'wheel', () => (lastWheel = Date.now()), { passive: true })

  cleanup.addEventListener(
    document,
    'mouseover',
    (e) => {
      const target = e.target.closest?.('.hs-hashtag')
      if (!target || target === hovered) return
      cancel()
      if (e.sourceCapabilities?.firesTouchEvents || Date.now() - lastTouch < TAG_CARD_TOUCH_QUIET_MS) return
      const tag = target.dataset.tag
      if (!tag || !TAG_CARD_RE.test(tag)) return
      hovered = target
      ctl = new AbortController()
      timer = cleanup.setTimeout(() => {
        timer = null
        if (hovered !== target) return
        if (Date.now() - lastWheel < TAG_CARD_SCROLL_QUIET_MS) return
        show(target, tag)
      }, TAG_CARD_HOVER_MS)
    },
    'mc-tag-card-mouseover',
  )

  cleanup.addEventListener(
    document,
    'mouseout',
    (e) => {
      const target = e.target.closest?.('.hs-hashtag')
      if (!target || target !== hovered) return
      // moving between children of the same tag is not leaving it
      if (e.relatedTarget && target.contains(e.relatedTarget)) return
      cancel()
      if (_userTooltipTarget === target) hideUserTooltip()
    },
    'mc-tag-card-mouseout',
  )
}
