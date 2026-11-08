// One place a username gets its colour + heatsync paint + 7TV paint.
//
// Every surface that prints a name outside the chat row itself (feed, hot,
// pinned, search, cards, whispers, archive, stream events, input chips) used to
// carry its own half-copy of this decision; most carried none. They all call
// hsNameParts (string html) or hsNameApply (element) now, and a late answer —
// a paint batch, a 7TV batch, a picked colour, a profile lookup — repaints
// every registered element through hsNameSweep, so a row never needs its own
// repaint path.
//
// WHO THE NAME IS: a post/row carries (user_id, platform). hsNameUid maps that
// to the paint id-space exactly like the site's isPaintLookupSafeId
// (lib/paint-spec.js, in scope): twitch/heatsync = the id, kick = kick_<id>,
// youtube = yt_<UC…>. An id that is ALREADY namespaced (a card's users.id) is
// kept as is — mapping it again made kick_kick_<n>. A row with only a login
// borrows the twitch id chat already resolved for that very name.
//
// COLOUR: an explicit colour (the feed API's user_color — already the right
// answer for a feed row; null = none) wins; else the colour chat heard for a
// twitch name; else the picked heatsync colour for kick/youtube; else the
// shared djb2 palette. A TWITCH name never takes a heatsync-picked colour here
// (native colour is the paid perk) — the picked cache is only read for
// kick_/yt_ ids.
//
// A streamer on a went-live row (o.exact) is looked up on the line's OWN
// platform only: a kick streamer takes the kick id and the kick colour (seen in
// kick chat, else the kick profile lookup the hover card uses), never the
// same-named twitch login's.
//
// PRECEDENCE: heatsync paint > 7TV paint (twitch ids only) > flat colour.
//
// A registered name carries: data-hs-nuid (paint id), data-hs-nplat (platform
// the paint decision used; 'twitch' once a twitch id was borrowed),
// data-hs-nsrc (the row's own platform, for the colour rule), data-hs-ncol
// (explicit colour, '-' = none), data-hs-nlogin.

const HS_NAME_NAMESPACED_RE = /^(?:kick_\d+|yt_UC[A-Za-z0-9_-]{22})$/

/** The paint-space id for a (raw id, platform) pair, or '' when there is none. */
function hsNameUid(userId, platform) {
  if (userId === null || userId === undefined || userId === '') return ''
  const raw = String(userId)
  if (HS_NAME_NAMESPACED_RE.test(raw)) return raw
  return isPaintLookupSafeId(raw, platform || '') || ''
}

/** Does this paint-space id belong to the twitch id space (7TV is keyed there)? */
function hsNameIsTwitchSpace(uid) {
  return !!uid && !uid.startsWith('kick_') && !uid.startsWith('yt_')
}

/** The twitch id chat already resolved for a login, or ''. Never invents one. */
function hsNameKnownTwitchUid(login, platform) {
  if (!login || typeof knownUserIds === 'undefined' || typeof userKey !== 'function') return ''
  // keyed by platform: a kick chatter only gets the twitch id linked to HER name
  return knownUserIds.get(userKey(String(login).toLowerCase(), platform || 'twitch')) || ''
}

/** Ask for everything this id can have. Ids reaching here are already namespaced
 * by hsNameUid, which is what paints.js' ID-SPACE SAFETY note demands. */
function hsNameQueue(uid, platform) {
  if (!uid) return
  if (!hsNameIsTwitchSpace(uid)) {
    queuePaintLookup(uid)
    return
  }
  // twitch ids ride the shared choke point (heatsync paint + 7TV together);
  // a heatsync-native id is not 7TV-keyed, so it asks for the paint alone.
  if (platform === 'twitch') queueMcCosmeticsLookup(uid)
  else queuePaintLookup(uid)
}

/** A colour already known for a twitch login (chat, or an earlier profile lookup), or ''. */
function hsNameHeardColour(login) {
  return (
    (typeof knownColors !== 'undefined' && knownColors.get(login)) ||
    (typeof _hsUserColorCache !== 'undefined' && _hsUserColorCache.get(login)) ||
    ''
  )
}

/** A caller's colour as undefined (unknown), null (server says none) or a hex. */
function hsNameColourIn(c) {
  return c ? c : c === null ? null : undefined
}

/** The name's flat colour: explicit, heard in chat, picked, or the palette. */
function hsNameColour(o) {
  const login = o.login ? String(o.login).toLowerCase() : ''
  if (o.colour) return sanitizeColor(o.colour)
  // null = the server said "no colour" (a feed row): straight to the palette
  if (o.colour === null) return hsUsernameColor(login || o.name)
  const plat = o.platform || ''
  if (login && (plat === '' || plat === 'twitch')) {
    // heard in chat, else the persisted profile-lookup colour (input.js)
    const heard =
      (typeof knownColors !== 'undefined' && knownColors.get(login)) ||
      (typeof _hsUserColorCache !== 'undefined' && _hsUserColorCache.get(login))
    if (heard) return sanitizeColor(heard)
  }
  if (login && plat === 'kick') {
    // heard in kick chat, else the kick profile lookup (never a twitch login's)
    const heard =
      (typeof platSeenColors !== 'undefined' && platSeenColors.get(`kick:${login}`)) ||
      _hsKickProfile.get(login)?.colour
    if (heard) return sanitizeColor(heard)
  }
  if (o.uid && !hsNameIsTwitchSpace(o.uid)) {
    const picked = getHsPickedColor(o.uid)
    if (picked) return picked
  }
  // login first: the display text can carry an "@", the colour must not
  return hsUsernameColor(login || o.name)
}

/**
 * Everything a surface needs to print one name.
 * @param {{name:string, userId?:string|number|null, platform?:string, colour?:string|null,
 *   login?:string, resolve?:boolean}} o
 *   `colour`: a hex, null (the server says none) or undefined (unknown).
 *   `resolve`: this surface has only a name — look the profile up in the
 *   background and repaint when the colour/id arrive.
 * @returns {{uid:string, data:object, cls:string, style:string, inner:string, attrs:string, hs:object|null}}
 *   `inner` is escaped markup; `attrs` starts with a space and is safe to splice.
 */
function hsNameParts(o) {
  const name = String(o.name ?? '')
  const platform = o.platform || ''
  const login = o.login ? String(o.login).toLowerCase() : ''
  const colourIn = hsNameColourIn(o.colour)
  let uid = hsNameUid(o.userId, platform)
  let plat = platform
  if (!uid && login && !o.exact) {
    // no id on the row: borrow the twitch id chat resolved for this very name
    uid = hsNameKnownTwitchUid(login, platform)
    if (uid) plat = 'twitch'
  }
  if (uid) {
    hsNameQueue(uid, plat)
    if (colourIn === undefined && !hsNameIsTwitchSpace(uid)) queueNameColorLookup(uid)
  }
  if (o.resolve && login) {
    if (platform === 'kick') {
      // the kick id and colour, from kick's own profile
      if (!uid || colourIn === undefined) hsNameResolveKick(login)
    } else if (!uid || (colourIn === undefined && !hsNameHeardColour(login))) {
      hsNameResolveLogin(login)
    }
  }
  const colour = hsNameColour({ colour: colourIn, platform, login, uid, name })
  const hs = uid ? hsPaintRender(uid, name) : null
  const stv = !hs && uid && plat === 'twitch' ? getMcPaintStyle(uid, colour) : ''
  const style = hs ? `--hsp-t:${paintPhaseNow()};${hsNameColourDecl(colour)}` : stv || `color:${colour}`
  const data = { nuid: uid, nplat: plat, nsrc: platform, nlogin: login }
  if (colourIn !== undefined) data.ncol = colourIn ? colour : '-'
  let attrs = ''
  for (const [k, v] of Object.entries(data)) if (v) attrs += ` data-hs-${escapeHtml(k)}="${escapeHtml(v)}"`
  if (hs) attrs += hs.splitAttr
  return { uid, data, cls: hs ? hs.cls : '', style, inner: hs ? hs.html : escapeHtml(name), attrs, hs }
}

/**
 * The third-party badges (7TV/FFZ/BTTV/chatterino) a name's TWITCH id carries,
 * as html — what a chat row puts before its name. Only when the parts resolved
 * a twitch-space id: a kick/youtube name has no id these maps are keyed on.
 * @param {{uid:string, data:{nplat?:string}}} p  hsNameParts' result
 */
function hsNameBadges(p) {
  if (!p?.uid || p.data.nplat !== 'twitch' || typeof renderThirdPartyBadges !== 'function') return ''
  return renderThirdPartyBadges(p.uid)
}

/**
 * hsNameParts, onto an element that already exists (cards, dropdown rows).
 * Replaces the element's children with the name; leaves other classes alone.
 */
function hsNameApply(el, o) {
  if (!el) return
  const p = hsNameParts(o)
  clearHsPaintFromElement(el)
  el.innerHTML = p.inner
  if (p.cls) el.classList.add(p.cls)
  el.setAttribute('style', p.style)
  for (const k of ['nuid', 'nplat', 'nsrc', 'nlogin', 'ncol']) {
    const dk = `hs${k[0].toUpperCase()}${k.slice(1)}`
    if (p.data[k]) el.dataset[dk] = p.data[k]
    else delete el.dataset[dk]
  }
  if (p.hs?.splitAttr) el.dataset.hsPaintSplit = '1'
  else delete el.dataset.hsPaintSplit
}

/** Repaint one registered element from whatever the caches hold right now. */
function hsNameRefresh(el) {
  if (!el) return
  const uid = el.dataset.hsNuid || ''
  const ncol = el.dataset.hsNcol
  const colour = hsNameColour({
    colour: ncol === undefined ? undefined : ncol === '-' ? null : ncol,
    platform: el.dataset.hsNsrc || '',
    login: el.dataset.hsNlogin,
    uid,
    name: el.textContent || '',
  })
  if (uid && hasResolvedHsPaint(uid)) {
    // a painted name owns the fill; the colour rides --hs-name-c for underlays
    el.style.color = colour
    applyHsPaintToElement(el, uid)
    const decl = hsNameColourDecl(colour)
    if (decl) el.style.setProperty('--hs-name-c', decl.slice('--hs-name-c:'.length, -1))
    return
  }
  clearHsPaintFromElement(el)
  const stv = uid && el.dataset.hsNplat === 'twitch' ? getMcPaintStyle(uid, colour) : ''
  el.setAttribute('style', stv || `color:${colour}`)
}

/** A paint / 7TV / colour answer landed for these ids: repaint their names. */
function hsNameSweep(uids) {
  if (typeof document === 'undefined' || !uids?.length) return
  for (const uid of uids) {
    if (!uid) continue
    for (const el of document.querySelectorAll(`[data-hs-nuid="${CSS.escape(uid)}"]`)) hsNameRefresh(el)
  }
}

// ── names known only by login ───────────────────────────────────────────────
const _hsNameLoginPending = new Set()

/** Look a bare name up (colour + twitch id) and repaint every place it shows. */
function hsNameResolveLogin(lower) {
  if (!lower || _hsNameLoginPending.has(lower) || typeof hsResolveUserColor !== 'function') return
  _hsNameLoginPending.add(lower)
  hsResolveUserColor(lower)
    .then(() => hsNameSweepLogin(lower))
    .catch(() => {})
    .finally(() => _hsNameLoginPending.delete(lower))
}

function hsNameSweepLogin(lower) {
  const uid = (typeof _hsUserIdCache !== 'undefined' && _hsUserIdCache.get(lower)) || ''
  for (const el of document.querySelectorAll(`[data-hs-nlogin="${CSS.escape(lower)}"]`)) {
    const src = el.dataset.hsNsrc || ''
    // only a name with no platform (or twitch) may take the twitch id the
    // profile lookup returned — a same-named kick chatter must not.
    if (uid && !el.dataset.hsNuid && (src === '' || src === 'twitch')) {
      el.dataset.hsNuid = uid
      el.dataset.hsNplat = 'twitch'
      hsNameQueue(uid, 'twitch')
      // a name that wanted badges but had no id for them (a went-live row)
      if (el.dataset.hsNbadge) {
        delete el.dataset.hsNbadge
        const html = typeof renderThirdPartyBadges === 'function' ? renderThirdPartyBadges(uid) : ''
        if (html) el.insertAdjacentHTML('beforebegin', html)
      }
    }
    hsNameRefresh(el)
  }
}

// ── kick streamers: the kick id + colour, from kick's own profile ───────────
// login -> { uid: 'kick_<n>' | '', colour } — what the hover card's profile
// lookup (resolveIdentity with platform kick, then kick's public user record)
// says. Bounded; a miss is cached too so a row repaint never re-asks.
const _hsKickProfile = new Map()
const _hsKickPending = new Set()
const HS_KICK_PROFILE_MAX = 500

function hsNameResolveKick(login) {
  if (!login || _hsKickProfile.has(login) || _hsKickPending.has(login)) return
  if (typeof resolveIdentity !== 'function') return
  _hsKickPending.add(login)
  ;(async () => {
    let uid = ''
    let colour = ''
    const r = await resolveIdentity(login, { platform: 'kick' }).catch(() => null)
    const prof = r?.ok ? r.profile : null
    if (prof) {
      uid = hsNameUid(prof.kick_user_id ?? prof.kick_id, 'kick')
      if (!uid && /^kick_\d+$/.test(String(prof.id || ''))) uid = String(prof.id)
      colour = String(prof.color || prof.user_color || prof.userColor || '')
    }
    if (!uid && typeof pcFetchKickEnrich === 'function') {
      const k = await pcFetchKickEnrich(login).catch(() => null)
      if (k?.kick_user_id != null) uid = hsNameUid(String(k.kick_user_id), 'kick')
    }
    if (_hsKickProfile.size >= HS_KICK_PROFILE_MAX) _hsKickProfile.delete(_hsKickProfile.keys().next().value)
    _hsKickProfile.set(login, { uid, colour })
  })()
    .then(() => hsNameSweepKick(login))
    .catch(() => {})
    .finally(() => _hsKickPending.delete(login))
}

function hsNameSweepKick(login) {
  if (typeof document === 'undefined') return
  const uid = _hsKickProfile.get(login)?.uid || ''
  for (const el of document.querySelectorAll(`[data-hs-nlogin="${CSS.escape(login)}"]`)) {
    if (el.dataset.hsNsrc !== 'kick') continue
    if (uid && !el.dataset.hsNuid) {
      el.dataset.hsNuid = uid
      el.dataset.hsNplat = 'kick'
      hsNameQueue(uid, 'kick')
      queueNameColorLookup(uid)
    }
    hsNameRefresh(el)
  }
}

// ── user cards (peek tooltip + profile panel) ───────────────────────────────
// card-render.js is pure and mirrored from the site, so it only stamps WHO the
// name is (data-paint-uid + data-platform + data-paint-pending) and the colour
// (data-color). This is the host half, same contract as the site's
// names/card-name-paint.js: resolve the id, queue the lookups, paint now if
// cached and again when the batch lands (hsNameSweep finds the element by the
// marker set here). Idempotent: a name is handled once per mount.
function hsNameCardsIn(root) {
  if (!root?.querySelectorAll) return 0
  // the card's recent-logs lines come from the server with site-relative emote
  // urls (/e/7tv/<id>); on twitch.tv that resolves to twitch.tv and breaks
  for (const img of root.querySelectorAll('img[src^="/e/"]')) {
    img.src = `https://heatsync.org${img.getAttribute('src')}`
  }
  let n = 0
  for (const el of root.querySelectorAll('.hs-card-name[data-color]')) {
    if (el.dataset.hsNdone) continue
    el.dataset.hsNdone = '1'
    const pending = el.hasAttribute('data-paint-pending')
    delete el.dataset.paintPending
    const platform = el.dataset.platform || 'twitch'
    const uid = pending ? hsNameUid(el.dataset.paintUid, platform) : ''
    // a card wears what chat shows: on twitch the colour heard from them (the
    // native colour is the perk, a picked one never beats it), else the profile
    // colour, else the shared palette — never plain white.
    const login = String(el.dataset.username || el.textContent).toLowerCase()
    const heard = platform === 'twitch' && typeof knownColors !== 'undefined' ? knownColors.get(login) : ''
    el.dataset.hsNcol = heard
      ? sanitizeColor(heard)
      : hsNameColour({ colour: el.dataset.color || undefined, login, platform, name: el.textContent })
    if (!uid) {
      if (el.dataset.hsNcol) el.style.color = el.dataset.hsNcol
      continue
    }
    n++
    el.dataset.hsNuid = uid
    el.dataset.hsNplat = platform
    el.dataset.hsNsrc = platform
    hsNameQueue(uid, platform)
    hsNameRefresh(el)
  }
  return n
}

export {
  hsNameApply,
  hsNameBadges,
  hsNameCardsIn,
  hsNameColour,
  hsNameParts,
  hsNameRefresh,
  hsNameResolveKick,
  hsNameResolveLogin,
  hsNameSweep,
  hsNameUid,
}
