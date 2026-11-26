// Big emote-only lines (shared/emote-only.ts, the site's docs/emote-law.md): a plain chat line of
// nothing but pictures, 1 to 5 of them, draws them BIG_SCALE times larger.
//
// There is no second reader of the words here. processEmotes already decided every word it drew
// (picture, emoji, overlay, bound modifier, text) and hands that back in `line.read`; the rule
// (hsEmoteLaw.emoteOnly) judges it; a big line is then drawn once more by the same renderer at the
// next rung up, so twice the size stays sharp. The row marks itself (hs-emote-big, --hs-big) and the
// css multiplies the reserved box and the img clamp by the same number, so nothing is measured.

let hsGraphemes = null

/**
 * Feed `read` the kinds of one word made only of emoji: a word of three is three pictures, a flag
 * or a ZWJ family is one. A word with no picture in it (a lone joiner) is text.
 */
function hsReadEmoji(read, word) {
  if (hsGraphemes === null) {
    try {
      hsGraphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    } catch (_) {
      hsGraphemes = false
    }
  }
  let n = hsGraphemes ? 0 : 1
  if (hsGraphemes)
    for (const g of hsGraphemes.segment(word))
      if (/[\p{Extended_Pictographic}\p{Emoji_Presentation}]/u.test(g.segment)) n++
  if (!n) read.push('text')
  while (n-- > 0) read.push('emoji')
}

/** the rule's verdict on the read of one line */
function hsBigLine(read) {
  return hsEmoteLaw.emoteOnly(read).size === 'big'
}

/** the rung a big line draws: the screen's own, BIG_SCALE times, 4 being the top */
function hsBigRung(want) {
  return Math.min(4, want * hsEmoteLaw.BIG_SCALE)
}

/** a big box's width from the normal box learned for the same picture (0 = never seen at the normal rung); the 4px of padding does not scale */
function hsBigBoxW(w) {
  return w ? (w - 4) * hsEmoteLaw.BIG_SCALE + 4 : 0
}

/**
 * May this row draw its line big? Only a plain chat line: never an event, a notice or a filled row,
 * and not one a power-up already enlarges. The setting is read here, when the row is drawn.
 */
function hsBigRowOk(m, div) {
  const k = div.classList
  return (
    m._hsBig === true &&
    !m.gigantified &&
    !k.contains('hs-mc-system') &&
    !k.contains('hs-filled') &&
    getSetting('bigEmoteLines') !== false
  )
}

/** put the row's mark on or take it off: the class, and the number the css multiplies by */
function hsMarkBigRow(div, on) {
  div.classList.toggle('hs-emote-big', on)
  if (on) div.style.setProperty('--hs-big', String(hsEmoteLaw.BIG_SCALE))
  else div.style.removeProperty('--hs-big')
}
