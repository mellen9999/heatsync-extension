// What a TWITCH chat line wears before the name, besides badges: the sub flair, 🔥 for a known heatsync
// user, a heat bar. Every decision lives here so the extension, the site and the rust app agree
// (heatsync-chat docs/contract.md "render rules"). Self-contained — no imports: the site vendors
// this file byte for byte (scripts/sync-ext-copies.sh), so it must stay free of bundle-scope names.
//
// order before the name: chatterino badge (the callers' third-party badges), sub flair, 🔥, heat bar.
// 🔥 and the bar never sit together (someone whose bar shows is plainly on heatsync), and 🔥 is never
// on or beside a heat score. your own lines wear it too: you are a heatsync user by definition. all server data here is hostile: bounded + validated.

const HSM_FLAIR_BATCH = 50
const HSM_FLAIR_TTL = 600000
const HSM_FLAIR_MAX = 500
const HSM_HEAT_BATCH = 25
const HSM_HEAT_TTL = 120000
const HSM_HEAT_MAX = 1000
const HSM_URL_MAX = 512
const HSM_HEAT_CAP = 1e9
const HSM_IMAGE_HOSTS = [
  '7tv.app',
  'betterttv.net',
  'frankerfacez.com',
  'kick.com',
  'ggpht.com',
  'googleusercontent.com',
  'static-cdn.jtvnw.net',
  'heatsync.org',
  'fourtf.com',
  '7tv.io',
  'cdn.heatsync.org',
  'files.kick.com',
]

/** A twitch login as heatsync takes it: lowercase letters, digits, underscore, 1..25. */
function hsMarksValidLogin(s) {
  return typeof s === 'string' && /^[a-z0-9_]{1,25}$/.test(s)
}

/** A score off the wire: finite, >= 0, whole, clamped; anything else is 0. */
function hsMarksScore(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(Math.min(v, HSM_HEAT_CAP)) : 0
}

/** The bar a score draws: { glyph, ink:'w'|'y'|'r' } or null under 5.
 * white while cold, yellow warming, red from 1000; thicker as it climbs. */
function hsMarksBar(heat) {
  const h = hsMarksScore(heat)
  if (h < 5) return null
  if (h < 20) return { glyph: '▎', ink: 'w' }
  if (h < 50) return { glyph: '▍', ink: 'w' }
  if (h < 100) return { glyph: '▍', ink: 'y' }
  if (h < 1000) return { glyph: '▌', ink: 'y' }
  return { glyph: '▊', ink: 'r' }
}

/** Which heat marks a line wears. known: a heatsync user as far as this client can tell;
 * mine: it is your own line (signed in, so known whether or not your emote set has loaded). */
function hsMarksWear(flameOn, barsOn, known, mine, heat) {
  const bar = barsOn ? hsMarksBar(heat) : null
  return { flame: !!(flameOn && (known || mine) && !bar), bar }
}

/** An image on the shared allowlist: https, no userinfo / port / control bytes, <= 512, exact host or `.`-suffix. */
function hsMarksImageOk(url) {
  if (typeof url !== 'string' || url.length > HSM_URL_MAX) return false
  const m = /^https:\/\/([\w.-]+)(?:[/?#]|$)/.exec(url)
  if (!m || /[\u0000- \u007f]/.test(url)) return false
  const h = m[1].toLowerCase()
  return HSM_IMAGE_HOSTS.some((a) => h === a || h.endsWith(`.${a}`))
}

/** One /api/users/flair row -> { url, title } or null. Only a twitch_sub on the allowlist. */
function hsMarksFlair(row) {
  if (!row || typeof row !== 'object' || row.flair_type !== 'twitch_sub') return null
  if (!hsMarksImageOk(row.badge_url)) return null
  const who = String(row.broadcaster_login ?? '')
    .replace(/[^A-Za-z0-9_]/g, '')
    .slice(0, 25)
  return { url: row.badge_url, title: who ? `${who} sub` : 'sub' }
}

function _hsmEsc(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

/** The markup for the marks a line wears (flair already validated by hsMarksFlair), '' for none. */
function hsMarksHtml(flair, wear) {
  let out = ''
  if (flair) {
    const t = _hsmEsc(flair.title)
    out += `<img class="hs-mark-flair" src="${_hsmEsc(flair.url)}" alt="${t}" title="${t}" width="18" height="18" decoding="async">`
  }
  if (wear?.flame) out += '<span class="hs-mark-flame" title="heatsync user">\u{1F525}</span>'
  if (wear?.bar) out += `<span class="hs-mark-heat hs-mark-heat-${wear.bar.ink}" title="heat">${wear.bar.glyph}</span>`
  return out
}

export {
  HSM_FLAIR_BATCH,
  HSM_FLAIR_MAX,
  HSM_FLAIR_TTL,
  HSM_HEAT_BATCH,
  HSM_HEAT_MAX,
  HSM_HEAT_TTL,
  hsMarksBar,
  hsMarksFlair,
  hsMarksHtml,
  hsMarksImageOk,
  hsMarksScore,
  hsMarksValidLogin,
  hsMarksWear,
}
