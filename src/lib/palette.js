import { escapeHtml } from './utils.js'

// Palette — the ONE source of the brand hexes in JS (and, with 00-palette.css's
// tokens, anywhere). Lives in lib/ so content scripts, the schema and the overlay
// all read it instead of re-typing a hex. The one JS-side platform→accent map. CSS-side doctrine lives in
// styles/00-palette.css; anything a JS-built inline style needs should use
// `var(--hs-*)` rather than a hex from here. Values frozen; scope rule:
// platform hexes render ONLY next to a platform glyph/label ([T]/[K]/[Y]
// tags, dots, source chips), never as free-standing semantic color.
// Both `yt` and `youtube` keys exist — callers disagree on the spelling.
// moderator green — Twitch's real mod badge colour. The ONE place it is spelled in JS
// (the CSS twin is --hs-mod in styles/00-palette.css).
export const HS_MOD_GREEN = '#00ad03'

export const HS_PLAT_COLORS = {
  twitch: '#c8a8ff',
  kick: '#00ff00',
  yt: '#ff0000',
  youtube: '#ff0000',
  heatsync: '#ff8700',
}

// THE platform mark: every [T]/[K]/[Y]/[H] on every surface comes from here.
// Input is a row's own platform (aliases fold in: yt/tw/Twitch/k/hs); a chat row
// that carries none is the twitch convention and passes 'twitch' at the call site.
// Anything else is '[?]' — an ingest bug made visible, never a silent [T].
const MARK_ALIAS = { yt: 'youtube', tw: 'twitch', k: 'kick', hs: 'heatsync' }
const MARKS = {
  twitch: { cls: 'twitch', letter: 'T', color: HS_PLAT_COLORS.twitch },
  kick: { cls: 'kick', letter: 'K', color: HS_PLAT_COLORS.kick },
  youtube: { cls: 'yt', letter: 'Y', color: HS_PLAT_COLORS.youtube },
  heatsync: { cls: 'heatsync', letter: 'H', color: HS_PLAT_COLORS.heatsync },
}
const MARK_UNKNOWN = { cls: 'unknown', letter: '?', color: '#ffff00' }
const markReported = new Set()
export function platformMark(platform) {
  const raw = String(platform ?? '')
    .trim()
    .toLowerCase()
  const key = MARK_ALIAS[raw] || raw
  const hit = MARKS[key]
  if (hit) return { key, ...hit, label: `[${hit.letter}]` }
  if (!markReported.has(raw)) {
    markReported.add(raw)
    try {
      console.warn('[heatsync] row with no known platform renders [?]:', JSON.stringify(raw))
    } catch {}
  }
  return { key: 'unknown', ...MARK_UNKNOWN, label: '[?]' }
}

// The mark span every chat/event row wears. `host` is the page's platform
// ('twitch'|'kick'|'yt'): with the platform-badges setting off, only the page's
// OWN platform's mark is hidden (documented rule, same for every platform).
export function platformMarkHtml(platform, { enabled = true, host = '' } = {}) {
  const mk = platformMark(platform)
  if (!enabled && mk.key === platformMark(host).key) return ''
  return `<span class="hs-mc-platform-badge hs-mc-pb-${escapeHtml(mk.cls)}" style="font-size:13px;margin-right:3px;font-weight:700;vertical-align:middle;color:${escapeHtml(mk.color)}">${escapeHtml(mk.label)}</span>`
}
