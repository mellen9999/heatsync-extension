// Favorite emotes: pictures you pinned. They lead the picker, and Tab when a name starts with
// what you typed (the law's favorites, shared/emote-law.ts, docs/emote-law.md on the site).
//
// The list is the account's: heatsync.org's synced setting `emoteFavorites`, read and written
// through /api/settings, so the site and every overlay show one list. It is kept in
// chrome.storage.local between loads (the picker never waits on the network), and signed out it
// simply stays on this device. It never rides ui_settings: 32 records would not fit beside
// everything else in chrome.storage.sync's 8 KB.
//
// A favorite is the picture, not the name: the same picture at another size or format is the same
// favorite, and another emote of the same name is not.

const HS_FAV_KEY = 'emote_favorites'
// a change this device made that the account has not taken yet: it is sent again at the next
// load instead of being overwritten by the account's older list
const HS_FAV_UNSENT = 'emote_favorites_unsent'
// the account the stored list belongs to
const HS_FAV_OWNER = 'emote_favorites_owner'
// how many, and how big: heatsync.org's rule for the setting (client/settings/registry.js)
const HS_FAV_MAX = 32
const HS_FAV_BYTES = 9000
const HS_FAV_PROVIDERS = new Set(['7tv', 'bttv', 'ffz', 'twitch', 'kick', 'youtube', 'hs'])
// emotes a platform draws itself: usable only where that platform hands them to you
const HS_FAV_NATIVE = new Set(['twitch', 'kick', 'youtube'])
const HS_FAV_HOST = [
  [/^https:\/\/cdn\.7tv\.app\//, '7tv'],
  [/^https:\/\/cdn\.betterttv\.net\//, 'bttv'],
  [/^https:\/\/cdn\.frankerfacez\.com\//, 'ffz'],
  [/^https:\/\/static-cdn\.jtvnw\.net\//, 'twitch'],
  [/^https:\/\/files\.kick\.com\//, 'kick'],
]
const HS_FAV_7TV = /^https:\/\/cdn\.7tv\.app\/emote\/([0-9A-Za-z]+)\//

let hsFavList = []

/**
 * A stored list as records. Never trusted: the site, another device, an old build or a hand-edited
 * storage wrote it. A record that is not a name and an https picture is dropped.
 */
function hsFavClean(v) {
  const out = []
  if (!Array.isArray(v)) return out
  for (const e of v) {
    if (out.length >= HS_FAV_MAX) break
    if (!e || typeof e !== 'object' || typeof e.name !== 'string' || !e.name || e.name.length > 100) continue
    if (typeof e.url !== 'string' || e.url.length > 400 || !e.url.startsWith('https://')) continue
    const rec = { name: e.name, url: e.url, provider: HS_FAV_PROVIDERS.has(e.provider) ? e.provider : 'hs' }
    if (typeof e.id === 'string' && e.id && e.id.length <= 80) rec.id = e.id
    if (typeof e.hash === 'string' && e.hash && e.hash.length <= 128) rec.hash = e.hash
    if (e.zeroWidth === true) rec.zeroWidth = true
    if (typeof e.animated === 'boolean') rec.animated = e.animated
    out.push(rec)
  }
  return out
}

const HS_FAV_TWITCH = /^https:\/\/static-cdn\.jtvnw\.net\/emoticons\/v2\/([^/]+)\//
const HS_FAV_KICK = /^https:\/\/files\.kick\.com\/emotes\/(\d+)\//
/**
 * The picture behind a url: one emote is met at several (a size, a format, a still, one of our own
 * rungs), and a favorite is the picture whichever of them it was pinned from.
 */
function hsFavPic(url) {
  const u = hsOwnCanonicalUrl(url || '')
  const m = HS_FAV_TWITCH.exec(u) || HS_FAV_KICK.exec(u)
  return m ? `${u.slice(8, u.indexOf('/', 8))}/${m[1]}` : _acPicKey(u)
}
/** is `e` ({ url, hash? }) the picture the record `f` keeps: the same image, or the same upload */
const hsFavSame = (f, e) => hsFavPic(f.url) === hsFavPic(e.url) || (!!f.hash && f.hash === e.hash)
const hsFavAt = (name, e) => hsFavList.findIndex((f) => f.name === name && hsFavSame(f, e))
const hsFavFits = (list) =>
  list.length <= HS_FAV_MAX && new TextEncoder().encode(JSON.stringify(list)).length <= HS_FAV_BYTES

/** is this picture (the word and the image) pinned */
function hsIsFavorite(name, e) {
  return !!name && !!e?.url && hsFavAt(name, e) !== -1
}

/**
 * What is kept of a picture: enough for any client to draw it, pick it and tell it from another
 * emote of its name. `e` is an overlay entry ({ url, source, id, hash, zeroWidth, animated }).
 */
function hsFavRecord(name, e) {
  const canon = hsOwnCanonicalUrl(e.url)
  const stv = HS_FAV_7TV.exec(canon)
  // the site draws webp: a 7tv picture is kept at the one url every client can show
  const url = stv ? `https://cdn.7tv.app/emote/${stv[1]}/2x.webp` : canon
  const host = HS_FAV_HOST.find(([re]) => re.test(url))
  const src = e.provider || e.source
  // "owned" says whose it was when pinned, not where the picture lives
  const provider = host ? host[1] : HS_FAV_NATIVE.has(src) ? src : 'hs'
  const id = typeof e.id === 'string' && e.id ? e.id : _AC_PIC_RE.exec(url)?.[2]
  const rec = { name, url, provider, id, hash: e.hash, zeroWidth: e.zeroWidth === true, animated: e.animated }
  return hsFavClean([rec])[0] || null
}

/** adopt a list from storage or the account; redraws the picker when it really changed */
function hsFavAdopt(v) {
  const next = hsFavClean(v)
  if (JSON.stringify(next) === JSON.stringify(hsFavList)) return false
  hsFavList = next
  if (typeof markPickerDirty === 'function') markPickerDirty()
  return true
}

/** read the account's list; it is the list unless this device holds a change it has not sent */
async function hsFavPull() {
  const r = await apiFetch('/api/settings')
  const remote = r?.ok ? r.data?.settings?.emoteFavorites : undefined
  // the account has never had a list: this device's stays, and nothing is sent until a pin
  if (!Array.isArray(remote)) return
  // a pin made while the answer was on its way is newer than the answer
  if ((await api.storage.local.get(HS_FAV_UNSENT))[HS_FAV_UNSENT]) return
  if (hsFavAdopt(remote)) await api.storage.local.set({ [HS_FAV_KEY]: hsFavList })
}

/** send this device's list to the account; the unsent mark clears only when the account took it */
async function hsFavPush() {
  const sent = JSON.stringify(hsFavList)
  const r = await apiFetch('/api/settings', { method: 'PUT', body: { patches: { emoteFavorites: hsFavList } } })
  // it took it only when it says when: a server that does not know the setting yet answers ok
  // and stores nothing, so the list stays unsent and goes again at the next load
  if (r?.ok && typeof r.ts === 'number') {
    // a pin made while that was in flight is still unsent
    if (sent === JSON.stringify(hsFavList)) await api.storage.local.remove(HS_FAV_UNSENT).catch(() => {})
    return
  }
  // refused outright (not a sign-in, a timeout or a rate limit): the account's list is the list
  if (r?.status >= 400 && r.status < 500 && ![401, 408, 429].includes(r.status)) {
    await api.storage.local.remove(HS_FAV_UNSENT).catch(() => {})
    await hsFavPull()
  }
}

/**
 * Pin or unpin a picture. A new favorite goes last: the order is the order you pinned in.
 * Signed out there is no list to pin to.
 * @param {string} name
 * @param {{url:string, source?:string, provider?:string, id?:string, hash?:string, zeroWidth?:boolean, animated?:boolean}} e
 * @returns {'added'|'removed'|'full'|null} null = nothing to pin
 */
function hsToggleFavorite(name, e) {
  if (!hsAuthToken || !name || typeof e?.url !== 'string' || !e.url.startsWith('https://')) return null
  const at = hsFavAt(name, e)
  const next = hsFavList.slice()
  if (at === -1) {
    const rec = hsFavRecord(name, e)
    if (!rec) return null
    next.push(rec)
    if (!hsFavFits(next)) return 'full'
  } else next.splice(at, 1)
  hsFavList = next
  if (typeof markPickerDirty === 'function') markPickerDirty()
  // the mark, the list and whose it is land together: a load that sees one sees them all
  const own = hsCurrentUserId ? { [HS_FAV_OWNER]: hsCurrentUserId } : {}
  api.storage.local
    .set({ [HS_FAV_KEY]: next, [HS_FAV_UNSENT]: true, ...own })
    .then(hsFavPush)
    .catch(() => {})
  return at === -1 ? 'added' : 'removed'
}

/**
 * Read the list: this device's copy first (instant), then the account's. A change this device
 * never got to send wins over the account's older list and is sent now; otherwise the account's
 * list is the list. A list another account left on this device is dropped, never sent as yours.
 */
async function hsLoadFavorites() {
  try {
    const d = await api.storage.local.get([
      HS_FAV_KEY,
      HS_FAV_UNSENT,
      HS_FAV_OWNER,
      'user_info',
      'auth_token_encrypted',
      'auth_token',
    ])
    if (!(d.auth_token_encrypted || d.auth_token)) {
      hsFavAdopt([])
      return
    }
    const me = d.user_info?.id ? String(d.user_info.id) : null
    const owner = d[HS_FAV_OWNER] || null
    const theirs = !!me && !!owner && owner !== me
    if (theirs) await api.storage.local.remove([HS_FAV_KEY, HS_FAV_UNSENT])
    hsFavAdopt(theirs ? [] : d[HS_FAV_KEY])
    if (me && owner !== me) await api.storage.local.set({ [HS_FAV_OWNER]: me })
    // sent only as the account that made it: until this device knows who is signed in, it waits
    if (d[HS_FAV_UNSENT] && !theirs) {
      if (me && owner === me) await hsFavPush()
      return
    }
    await hsFavPull()
  } catch (_) {}
}

/**
 * Another tab, or the account (a pin made on heatsync.org or another device), changed the list;
 * or someone signed in here.
 */
function hsFavStorageChanged(changes, area) {
  if (area !== 'local') return
  if (changes[HS_FAV_KEY]) hsFavAdopt(changes[HS_FAV_KEY].newValue)
  const tok = changes.auth_token_encrypted || changes.auth_token
  const who = changes.user_info
  const signedIn = tok?.newValue && !tok.oldValue
  const newPerson = who?.newValue?.id && String(who.newValue.id) !== String(who.oldValue?.id || '')
  if (signedIn || newPerson) hsLoadFavorites()
}

let hsFavWatching = false
/** startup: read the list and follow it */
function hsInitFavorites() {
  if (!hsFavWatching) {
    hsFavWatching = true
    cleanup.addListener(api.storage.onChanged, hsFavStorageChanged)
  }
  hsLoadFavorites()
}

/** the overlay entry holding a favorite's picture in one of `maps` (name -> entry), if any */
function hsFavHeld(f, maps) {
  for (const m of maps) {
    const e = m?.get(f.name)
    if (e?.url && hsFavSame(f, e)) return e
  }
  return null
}

/** the overlay's name for where a record's picture is from (its own emotes are 'heatsync') */
const hsFavSource = (f) => (f.provider === 'hs' ? 'heatsync' : f.provider)

/** a favorite nothing here holds, as the picker tile a pick of it draws from */
const hsFavEntry = (f, i) => ({
  url: f.url,
  source: hsFavSource(f),
  state: 'remote',
  // which favorite a click on the tile means: two can share a name
  variant: `fav${i}`,
  zeroWidth: !!f.zeroWidth,
})

/**
 * The favorites row of the picker, in pin order. One this tab holds is that entry; one it does not
 * is drawn from its record and picked like a search result. A platform's own emote is shown only
 * where it is held: anywhere else it could only go out as text.
 * @param {Array<Map>} maps name -> entry, where the picker looks
 * @returns {Array<[string, object]>}
 */
function hsFavTiles(maps) {
  const out = []
  hsFavList.forEach((f, i) => {
    const held = hsFavHeld(f, maps)
    if (held) out.push([f.name, held])
    else if (!HS_FAV_NATIVE.has(f.provider)) out.push([f.name, hsFavEntry(f, i)])
  })
  return out
}

/** the favorites section of the picker: first, and omitted while empty */
function hsFavSection(maps) {
  const emotes = hsFavTiles(maps)
  return emotes.length ? { key: 'favorite', label: t('mc_picker_favorites'), emotes } : null
}

/**
 * The emote behind a picker tile nothing here holds: a search result (mcRemoteEmoteIndex), or a
 * favorite drawn from its record.
 * @returns {{url:string, provider:string, id?:string, zeroWidth?:boolean}|undefined}
 */
function hsRemoteTile(name, variant) {
  const found = mcRemoteEmoteIndex.get(variant ? `${name}#${variant}` : name)
  if (found) return found
  const f = /^fav(\d+)$/.test(variant || '') ? hsFavList[Number(variant.slice(3))] : null
  if (f?.name !== name) return undefined
  return { url: f.url, provider: hsFavSource(f), id: f.id, zeroWidth: !!f.zeroWidth }
}

/**
 * The emote a right-click landed on, as the entry a pin keeps: the tab's own copy of it when there
 * is one (a tile draws a sized or still url, the entry has the real one), a search result or an
 * away favorite from its record, an emote on a chat row from the row.
 */
function hsFavTarget({ emoteName, emoteUrl, source, wrapper, targetEl }) {
  const img = targetEl?.closest?.('.hs-mc-picker-emote-wrap')?.querySelector('img')
  if (img?.dataset.state === 'remote') return hsRemoteTile(emoteName, img.dataset.variant) || null
  const hash = wrapper?.dataset?.emoteHash || undefined
  const held = hsFavHeld({ name: emoteName, url: emoteUrl, hash }, [
    viewerPersonalEmotes,
    ...activeTabEmotePools(),
    emoteCache,
  ])
  return held || (wrapper && emoteUrl ? { url: emoteUrl, source, hash } : null)
}

/**
 * The favorites row of an emote's menu: pin it, or unpin it. None signed out (there is no list),
 * none for a picture that cannot be named.
 * @returns {Array} menu items, ending in a separator
 */
function hsFavMenuItems(info) {
  if (!hsAuthToken || !info?.emoteName) return []
  const e = hsFavTarget(info)
  if (!e?.url?.startsWith('https://')) return []
  const name = info.emoteName
  if (hsIsFavorite(name, e)) return [{ label: t('mc_fav_remove'), fn: () => hsToggleFavorite(name, e) }, 'sep']
  const add = () => {
    if (hsToggleFavorite(name, e) === 'full') showToast(t('mc_fav_full'), 'error')
  }
  return [{ label: t('mc_fav_add'), fn: add }, 'sep']
}

/**
 * The favorites as the law reads them (offer's `favorites`): each with the key its picture has
 * here. `views` are the law's name -> emote views of what is loaded (room, yours, globals).
 */
function lawFavorites(views) {
  const out = []
  for (const f of hsFavList) {
    let here = null
    for (const v of views) {
      const e = v?.get?.(f.name)
      if (e && hsFavSame(f, e.raw || e)) {
        here = e
        break
      }
    }
    // a view's emote is keyed by picture; an offer's row is the word and the picture
    if (here) out.push({ ...here, key: `${here.key}\n${f.name}` })
    else if (!HS_FAV_NATIVE.has(f.provider)) {
      const e = lawCatalogEmote({
        name: f.name,
        url: f.url,
        id: f.id,
        provider: hsFavSource(f),
        zeroWidth: f.zeroWidth,
      })
      if (e) out.push(e)
    }
  }
  return out
}
