// @ts-check
// Shareable multichat layout links.
//
// Nothing the extension does is visible to anyone who has not installed it —
// which is the recorded reason it has no inherent virality. heatsync.org has
// served `/m/<layout>` all along: an SSR page that recreates a multichat for a
// stranger with no account and no install, with a 1200x630 OG card. The
// extension emitted zero links into it, so the only thing a user could ever
// post was "install my thing".
//
// Grammar — `server/routes/multichat-permalinks.ts` is the source of truth:
//
//   layout := tab ('+' tab)*        '+' separates tabs (one chat column each)
//   tab    := pc (',' pc)*          ',' groups platforms into ONE tab (simulcast)
//   pc     := ('t'|'k'|'y') ':' name
//
//   e.g.  /m/t:xqc,k:xqc+t:asmongold
//
// Every character is a legal unencoded path char, so the link survives a raw
// paste — do NOT percent-encode it.
//
// The validators below MIRROR that file across a repo boundary, so no build
// guard can pin them. Drift degrades safely in both directions: this side emits
// only what it can validate, and the server's parse is total (malformed
// segments are dropped, never thrown). The worst case is a channel missing from
// a link — never a broken page.

const SHARE_ORIGIN = 'https://heatsync.org'
const SHARE_MAX_TABS = 8
const SHARE_MAX_LAYOUT_LEN = 400
// Twitch + Kick slugs. Kick allows hyphens, Twitch doesn't; the union is what
// the server accepts.
const SHARE_NAME_RE = /^[a-z0-9_-]{1,30}$/
// YouTube @handle — dots are legal, and the server's charset is lowercase-only.
const SHARE_YT_HANDLE_RE = /^[a-z0-9_.-]{1,40}$/
// Literal 'UC' + 22 chars, case-SENSITIVE — never lowercase one of these.
const SHARE_UC_ID_RE = /^UC[A-Za-z0-9_-]{22}$/

/**
 * Resolve a channel's youtube identity to a shareable segment value.
 * `ch.youtube` is a URL, not a handle, so this has to dig it out. Order:
 * a resolved handle from youtube_status, then an @handle in the URL, then a
 * /channel/UC… id.
 * @param {{id?: string, youtube?: string}} ch
 * @param {(id: string) => string} [ytHandleFor] resolved handle by channel id
 * @returns {string} '' when nothing valid could be derived
 */
function shareYoutubeValue(ch, ytHandleFor) {
  const resolved = ytHandleFor && ch.id ? ytHandleFor(ch.id) : ''
  const fromResolved = typeof resolved === 'string' ? resolved.replace(/^@/, '') : ''
  if (fromResolved) {
    if (SHARE_UC_ID_RE.test(fromResolved)) return fromResolved
    const lower = fromResolved.toLowerCase()
    if (SHARE_YT_HANDLE_RE.test(lower)) return lower
  }
  const url = typeof ch.youtube === 'string' ? ch.youtube : ''
  if (!url) return ''
  // A UC id can contain hyphens, so anchor on the /channel/ prefix rather than
  // trying to spot one loose in the path.
  const uc = url.match(/\/channel\/(UC[A-Za-z0-9_-]{22})/)
  if (uc && SHARE_UC_ID_RE.test(uc[1])) return uc[1]
  const at = url.match(/@([^/?#&]+)/)
  if (at) {
    const lower = at[1].toLowerCase()
    if (SHARE_YT_HANDLE_RE.test(lower)) return lower
  }
  return ''
}

/**
 * Build one tab segment from a channel entry. A channel carrying both a twitch
 * and a kick name is one simulcast tab, comma-joined — which is the layout
 * worth showing off, so it must not be split into two.
 * @param {{id?: string, twitch?: string, kick?: string, youtube?: string}} ch
 * @param {(id: string) => string} [ytHandleFor]
 * @returns {string} '' when the channel has nothing shareable
 */
function shareTabSegment(ch, ytHandleFor) {
  if (!ch) return ''
  const parts = []
  const tw = typeof ch.twitch === 'string' ? ch.twitch.trim().toLowerCase() : ''
  if (tw && SHARE_NAME_RE.test(tw)) parts.push(`t:${tw}`)
  const ki = typeof ch.kick === 'string' ? ch.kick.trim().toLowerCase() : ''
  if (ki && SHARE_NAME_RE.test(ki)) parts.push(`k:${ki}`)
  const yt = shareYoutubeValue(ch, ytHandleFor)
  if (yt) parts.push(`y:${yt}`)
  return parts.join(',')
}

/**
 * Build the `/m/` layout string for a channel list. Pure.
 *
 * Caps mirror the server so a link is never built that the server would trim:
 * at most SHARE_MAX_TABS tabs, and the whole layout under SHARE_MAX_LAYOUT_LEN.
 * Tabs are dropped from the END when over length, keeping the leftmost — which
 * is the order the user arranged them in.
 *
 * @param {Array<{id?: string, twitch?: string, kick?: string, youtube?: string}>} channels
 * @param {(id: string) => string} [ytHandleFor]
 * @returns {string} '' when nothing is shareable
 */
function buildMultichatLayout(channels, ytHandleFor) {
  if (!Array.isArray(channels)) return ''
  const segments = []
  for (const ch of channels) {
    if (segments.length >= SHARE_MAX_TABS) break
    const seg = shareTabSegment(ch, ytHandleFor)
    if (seg) segments.push(seg)
  }
  while (segments.length && segments.join('+').length > SHARE_MAX_LAYOUT_LEN) segments.pop()
  return segments.join('+')
}

/**
 * Full shareable URL, or '' when there is nothing to share.
 * @param {Array<{id?: string, twitch?: string, kick?: string, youtube?: string}>} channels
 * @param {(id: string) => string} [ytHandleFor]
 * @returns {string}
 */
function buildMultichatShareUrl(channels, ytHandleFor) {
  const layout = buildMultichatLayout(channels, ytHandleFor)
  return layout ? `${SHARE_ORIGIN}/m/${layout}` : ''
}

export {
  buildMultichatLayout,
  buildMultichatShareUrl,
  SHARE_MAX_LAYOUT_LEN,
  SHARE_MAX_TABS,
  shareTabSegment,
  shareYoutubeValue,
}
