// Normalize a message's RENDER-shape emote_refs (lineRefs' output —
// {name: {hash?,url,name,provider,zeroWidth,width,height,id?,animated?}})
// into the durable per-message shape message_emote_refs stores and
// server/lib/message-emote-refs.ts validates: {name: {p,id,a?}}, never a url.
// See migrations/315.
//
// p is 'hs' for anything with a `hash` — an owned-inventory ref, regardless
// of the emote's original CDN, because the id that matters for permanence is
// the heatsync row (identified by its content hash — see lineRefs'
// own comment: "hash is the primary render key"), not the upstream one. A
// catalog pick (registerRemoteEmoteRef — Tab-cycle or a picker tile click)
// keeps its real provider + the provider's own id, carried through from the
// search result (see registerRemoteEmoteRef). A ref with neither — no hash,
// no provider id — has nothing this table can validate and is dropped; the
// server-side validator would reject it anyway (ownership/id-format checks),
// so this only saves a wasted round trip.

const KNOWN_PROVIDERS = new Set(['7tv', 'bttv', 'ffz'])

/**
 * @param {Record<string, {hash?:string,provider?:string,id?:string,animated?:boolean}>|null|undefined} emote_refs
 * @returns {Record<string, {p:string,id:string,a?:boolean}>}
 */
export function normalizeEmoteRefsForSend(emote_refs) {
  const out = {}
  if (!emote_refs) return out
  for (const [name, ref] of Object.entries(emote_refs)) {
    // a name-match (`nm`) is a guess about the sender, never something they shipped: not stored as a pick
    if (!ref || ref.nm) continue
    if (ref.hash) {
      out[name] = { p: 'hs', id: ref.hash }
      continue
    }
    const fromUrl = ref.id ? null : idFromCdnUrl(ref.url)
    const p = fromUrl ? fromUrl.p : ref.provider
    const id = ref.id || fromUrl?.id
    if (id && KNOWN_PROVIDERS.has(p)) {
      out[name] = { p, id, ...(typeof ref.animated === 'boolean' ? { a: ref.animated } : {}) }
    }
  }
  return out
}

// The provider's own id is in its CDN path. A ref that reached the send with
// only a url — a search pick whose registration carried no id, or an owned
// entry missing for a moment while the inventory reloads — used to be dropped
// here, and with it the message's only permanent record of that emote: text
// after the next reload (mellen 10-04, KKonaSmile). The server re-checks the
// id grammar, so a wrong match is refused there, never stored.
const CDN_ID = [
  { p: '7tv', re: /^https:\/\/cdn\.7tv\.app\/emote\/([0-9A-Za-z]{24,26})\// },
  { p: 'bttv', re: /^https:\/\/cdn\.betterttv\.net\/emote\/([a-f0-9]{24})\// },
  { p: 'ffz', re: /^https:\/\/cdn\.frankerfacez\.com\/(?:emote|emoticon)\/([0-9]{1,9})\// },
]

/** @param {unknown} url @returns {{p:string,id:string}|null} */
export function idFromCdnUrl(url) {
  if (typeof url !== 'string') return null
  for (const { p, re } of CDN_ID) {
    const m = url.match(re)
    if (m) return { p, id: m[1] }
  }
  return null
}
