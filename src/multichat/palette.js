// Palette — the one JS-side platform→accent map. CSS-side doctrine lives in
// styles/00-palette.css; anything a JS-built inline style needs should use
// `var(--hs-*)` rather than a hex from here. Values frozen; scope rule:
// platform hexes render ONLY next to a platform glyph/label ([T]/[K]/[Y]
// tags, dots, source chips), never as free-standing semantic color.
// Both `yt` and `youtube` keys exist — callers disagree on the spelling.
const HS_PLAT_COLORS = {
  twitch: '#ff00ff',
  kick: '#00ff00',
  yt: '#ff0000',
  youtube: '#ff0000',
  heatsync: '#ff8700',
}
