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
