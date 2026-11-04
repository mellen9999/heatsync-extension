// layout-link.js — heatsync.org/m/<layout> share links, parse + build.
//
// Mirror of the site grammar (server/lib/multichat-layout.ts + the builder in
// chat-tabs-manager.js). Pure: no DOM, no config, so it is unit-tested alone.
//   layout := tab ('+' tab)*   tab := pc (',' pc)*   pc := ('t'|'k'|'y') ':' name
// Parsing is total — junk segments drop, nothing throws. Caps: 8 tabs, 400 chars.

const MC_LAYOUT_BASE = 'https://heatsync.org/m/'
const MC_LAYOUT_MAX_TABS = 8
const MC_LAYOUT_MAX_LEN = 400
const MC_LAYOUT_NAME_RE = /^[a-z0-9_-]{1,30}$/
const MC_LAYOUT_YT_RE = /^[a-z0-9_.-]{1,40}$/
const MC_LAYOUT_UC_RE = /^UC[A-Za-z0-9_-]{22}$/

/** A pasted link, a bare layout, or a path: strip down to the layout segment. */
function mcLayoutSegment(input) {
  let s = String(input ?? '').trim()
  const m = s.match(/heatsync\.org\/m\/([^?#\s]*)/i)
  if (m) s = m[1]
  else s = s.replace(/^\/?m\//i, '')
  try {
    s = decodeURIComponent(s)
  } catch {}
  return s.trim()
}

/**
 * Link or layout -> validated tabs [{twitch,kick,youtube}] (youtube = bare
 * handle or UC id). Never throws; junk dropped; identical tabs deduped.
 */
export function mcLayoutParse(input) {
  const layout = mcLayoutSegment(input)
  if (!layout || layout.length > MC_LAYOUT_MAX_LEN) return []
  const tabs = []
  const seen = new Set()
  for (const tabStr of layout.split('+').slice(0, MC_LAYOUT_MAX_TABS)) {
    const tab = { twitch: '', kick: '', youtube: '' }
    for (const seg of tabStr.split(',').slice(0, 3)) {
      const i = seg.indexOf(':')
      if (i < 1) continue
      const code = seg.slice(0, i).trim().toLowerCase()
      // case kept for youtube: a UC id is case-sensitive, handles are not
      const exact = seg
        .slice(i + 1)
        .trim()
        .replace(/^@/, '')
      const raw = exact.toLowerCase()
      if (code === 't' && MC_LAYOUT_NAME_RE.test(raw)) tab.twitch = raw
      else if (code === 'k' && MC_LAYOUT_NAME_RE.test(raw)) tab.kick = raw
      else if (code === 'y') {
        if (MC_LAYOUT_UC_RE.test(exact)) tab.youtube = exact
        else if (MC_LAYOUT_YT_RE.test(raw)) tab.youtube = raw
      }
    }
    if (!tab.twitch && !tab.kick && !tab.youtube) continue
    const key = `${tab.twitch}|${tab.kick}|${tab.youtube}`
    if (seen.has(key)) continue
    seen.add(key)
    tabs.push(tab)
  }
  return tabs
}

/** Grammar token (handle or UC id) -> the youtube url a channel entry stores. */
export function mcLayoutYtUrl(token) {
  if (MC_LAYOUT_UC_RE.test(token)) return `https://www.youtube.com/channel/${token}/live`
  return `https://www.youtube.com/@${token}/live`
}

/** A stored youtube url -> grammar token, or '' when it has no usable handle/id. */
function mcLayoutYtToken(url) {
  const s = String(url || '')
  const id = s.match(/\/channel\/(UC[A-Za-z0-9_-]{22})(?![A-Za-z0-9_-])/)
  if (id) return id[1]
  const h = s.match(/@([\w.-]+)/)
  const handle = h ? h[1].toLowerCase() : ''
  return MC_LAYOUT_YT_RE.test(handle) ? handle : ''
}

/**
 * Channel entries [{twitch,kick,youtube(url)}] -> layout string. Tabs with no
 * valid leg are skipped; capped at 8 tabs; tail tabs drop until it fits 400
 * (an over-long layout would parse to nothing). '' when nothing is shareable.
 */
export function mcLayoutBuild(channels) {
  const parts = []
  for (const c of channels || []) {
    const segs = []
    if (MC_LAYOUT_NAME_RE.test(c?.twitch || '')) segs.push(`t:${c.twitch}`)
    if (MC_LAYOUT_NAME_RE.test(c?.kick || '')) segs.push(`k:${c.kick}`)
    const yt = mcLayoutYtToken(c?.youtube)
    if (yt) segs.push(`y:${yt}`)
    if (segs.length) parts.push(segs.join(','))
    if (parts.length >= MC_LAYOUT_MAX_TABS) break
  }
  let layout = parts.join('+')
  while (layout.length > MC_LAYOUT_MAX_LEN && parts.length > 1) {
    parts.pop()
    layout = parts.join('+')
  }
  return layout.length > MC_LAYOUT_MAX_LEN ? '' : layout
}

/** Shareable link for the channel entries, or '' when there is nothing to share. */
export function mcLayoutLink(channels) {
  const layout = mcLayoutBuild(channels)
  return layout ? MC_LAYOUT_BASE + layout : ''
}
