// The overlay's end of the law's OFFER (docs/emote-law-map.md R13-R14, shared/emote-law.ts): Tab,
// the `:` list and the Tab list are one ranked list over the room the line is going to: the exact
// name, names you use, the room, yours, globals, not loaded yet, emoji. People are not emotes, so
// they are set into the law's list here, the way the site does it (client/emotes/tab-offer.js).
// A match is what the composer has always been handed ({ name, url, source, type, ... }); `_c` is
// the law's candidate behind it, so a late arrival can be ranked after the cursor.

const LAW_TIER_NO = { room: 0, own: 1, global: 2 }
const LAW_PEOPLE_MAX = 50

/**
 * What an offer reads against: the room the open tab's send reaches first, your sets, the globals.
 * @param {object} [o]
 * @param {Array|null} [o.catalog] law emotes no cache holds yet (lawCatalogEmote)
 * @param {Array|null} [o.emoji]
 */
function lawOfferCtx({ catalog, emoji } = {}) {
  const s = lawSendCtx({
    legs: lawOpenLegs(),
    mine: viewerPersonalEmotes,
    globals: emoteCache,
    caches: channelEmoteCaches,
    picks: null,
  })
  const frec = typeof loadEmoteFrecency === 'function' ? loadEmoteFrecency() : null
  // inventory's `at` reads your whole set, the platform emotes in it too
  const views = [s.room?.names, s.own.inventory, s.globals]
  return {
    room: s.room,
    own: s.own,
    globals: s.globals,
    catalog,
    emoji,
    usage: frec ? (n) => frec.get(n) || 0 : null,
    // an emote you blocked, or one hidden from you, is never offered (and the law lets no
    // look-alike of its name in from the catalog)
    blocked: (key) => {
      for (const v of views) {
        const e = v?.at?.(key)
        if (e) return _hsAcEmoteBlocked(e.name, e.raw)
      }
      return false
    },
    suggestOwn: getSetting('suggestInventoryEmotes') !== false,
  }
}

/** a catalog search hit as the law's emote; null when it must never be offered */
function lawCatalogEmote(it) {
  if (!it?.name || !it.url || _hsAcEmoteBlocked(it.name, null)) return null
  const provider = it.provider || '7tv'
  const id = String(it.id || _acPicKey(it.url))
  const zeroWidth = !!it.zeroWidth
  return {
    key: `${provider}:${id}\n${it.name}`,
    name: it.name,
    provider,
    id,
    url: it.url,
    zeroWidth,
    pop: it.uses || 0,
    raw: { url: it.url, source: provider, id: it.id, zeroWidth },
  }
}

/** a law candidate as the match the composer inserts */
function lawMatchOf(c) {
  const e = c.emote
  const raw = e.raw || e
  const m =
    c.tier === 'emoji'
      ? raw
      : {
          name: e.name,
          url: raw.url,
          source: raw.source || raw.provider || e.provider,
          id: raw.id,
          hash: raw.hash,
          animated: raw.animated,
          priority: c.match > 1 ? 1 : 0,
          tier: LAW_TIER_NO[c.tier],
          type: 'emote',
          sub: !!raw.subscription,
          zeroWidth: !!raw.zeroWidth,
          ...(c.tier === 'catalog' && { remote: true }),
          ...(c.shadowed && { shadowed: true }),
        }
  m._c = c
  return m
}

const lawMatchKey = (m) => (m._c ? m._c.emote.key : `chatter:${m.name}`)

/** 7tv's "name0": the base emote read as an overlay, offered when no emote is literally named that */
function lawOverlayOf(base) {
  const c = base._c
  const name = `${base.name}0`
  return {
    ...base,
    name,
    _synthOverlay: true,
    _c: { ...c, emote: { ...c.emote, name, key: `${c.emote.key}0`, zeroWidth: true } },
  }
}

const lawByRecency = (a, b) =>
  (a.recencyRank ?? 1e9) - (b.recencyRank ?? 1e9) ||
  a._b - b._b ||
  a.name.length - b.name.length ||
  hsEmoteLaw.cmpCp(a.name, b.name)

/**
 * The room's people for a bare word, inserted as the plain name (no @ was typed, so no ping is
 * forced): recent talkers first, then the closest name, the shortest, a-z.
 */
function lawPeople(q) {
  const out = []
  const recency = getRecencyMap()
  for (const [lower, display] of _ucDisplay) {
    if (!lower.includes(q) || _isBlockedAnyPlat(lower)) continue
    const name = display.replace(/^@/, '')
    out.push({
      name,
      url: null,
      priority: 0,
      type: 'user',
      recencyRank: recency.get(lower),
      _b: hsEmoteLaw.matchBucket(name, q),
    })
  }
  return out.sort(lawByRecency).slice(0, LAW_PEOPLE_MAX)
}

/** `@` typed: people only, recent talkers first */
function lawAtPeople(q) {
  const out = []
  const recency = getRecencyMap()
  const prefetch = []
  for (const username of usernameCache) {
    if (!username) continue
    const userLower = username.toLowerCase()
    // youtube names arrive as "@handle": matched and inserted on the bare name, or '@' + '@handle'
    // would insert '@@'
    const bare = userLower.startsWith('@') ? userLower.slice(1) : userLower
    if (_isBlockedAnyPlat(bare)) continue
    let color = (typeof knownColors !== 'undefined' && knownColors.get(userLower)) || null
    if (!color && _hsUserColorCache.has(userLower)) color = _hsUserColorCache.get(userLower) || null
    if (!color) prefetch.push(bare)
    if (!bare.startsWith(q)) continue
    out.push({
      name: `@${username.replace(/^@/, '')}`,
      url: null,
      priority: 0,
      type: 'user',
      recencyRank: recency.get(bare),
      _b: 1,
    })
  }
  if (prefetch.length) {
    try {
      hsPrefetchUserColors(prefetch.slice(0, 30))
    } catch {}
  }
  return out.sort(lawByRecency)
}

/**
 * The law's list with the people set in: exact names are both kinds (the emote, then the person
 * typed whole), then the room's emotes, the other people, the rest.
 */
function lawWithPeople(list, people) {
  if (!people?.length) return list
  const exact = people.filter((p) => p._b === 0)
  const rest = people.filter((p) => p._b !== 0)
  let i = 0
  while (i < list.length && list[i]._c.match === 0) i++
  let j = i
  while (j < list.length && list[j]._c.tier === 'room') j++
  return [...list.slice(0, i), ...exact, ...list.slice(i, j), ...rest, ...list.slice(j)]
}

/**
 * One Tab cycle's matches for `typed`. With `prev` + `cursor` it is a late arrival (a catalog
 * answer): everything up to the cursor stays where it is, the rest is the fresh ranking minus it.
 */
function lawTabList(typed, { catalog, emoji, people, prev, cursor = -1 } = {}) {
  const ctx = lawOfferCtx({ catalog, emoji })
  const head = prev ? prev.slice(0, cursor + 1) : []
  const heads = head.filter((m) => m._c).map((m) => m._c)
  const cands = prev ? hsEmoteLaw.extendOffer(heads, heads.length - 1, typed, ctx) : hsEmoteLaw.offer(typed, ctx)
  const all = lawWithPeople(cands.map(lawMatchOf), people)
  if (!prev) return all
  const have = new Set(head.map(lawMatchKey))
  return [...head, ...all.filter((m) => !have.has(lawMatchKey(m)))]
}

/**
 * What Tab, the `:` list and the Tab list offer for the word under the caret.
 * `@word` = people only. `:word` = emotes and emoji. A bare word = emotes with the room's people.
 * @param {string} search the word as typed
 * @param {{catalog?:Array, prev?:Array, cursor?:number}} [more] a late arrival, see lawTabList
 */
function findEmoteMatches(search, more) {
  // an ffz-style modifier token ("w!") never completes, even when an emote is literally named that
  if (hsModClassify(search, { allowPrefix: false }).kind === 'modifier') return []
  const isUserSearch = search.startsWith('@')
  const isColonSearch = !isUserSearch && search.startsWith(':')
  const term = isUserSearch || isColonSearch ? search.slice(1) : search
  const q = term.toLowerCase()
  if (isUserSearch) return lawAtPeople(q)
  if (!q) return []

  let emoji = null
  if (isColonSearch && typeof EMOJI_DATA !== 'undefined') {
    emoji = []
    for (const entry of EMOJI_DATA) {
      if (!entry.name.includes(q)) continue
      const name = `:${entry.name}:`
      emoji.push({
        key: `emoji:${entry.name}`,
        name,
        provider: 'emoji',
        id: entry.name,
        raw: { name, url: null, priority: entry.name.startsWith(q) ? 0 : 1, type: 'emoji', emoji: entry.emoji },
      })
    }
  }
  const list = lawTabList(term, { ...more, emoji, people: isColonSearch ? null : lawPeople(q) })
  // "TriHard0" + Tab confirms TriHard as an overlay though nothing is named TriHard0; an emote that
  // IS literally named that is standalone and is already in the list
  const isEmote = (m, n) => m.type === 'emote' && m.name.toLowerCase() === n
  if (!more?.prev && !isColonSearch && q.length > 2 && q.endsWith('0') && !list.some((m) => isEmote(m, q))) {
    const baseQ = q.slice(0, -1)
    const base = lawTabList(term.slice(0, -1)).find((m) => isEmote(m, baseQ))
    if (base) list.unshift(lawOverlayOf(base))
  }
  return list
}
