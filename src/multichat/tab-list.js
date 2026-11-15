// Tab opens the emote list (setting tabOpensEmoteList, off by default).
//
// With it on, the first Tab on a word shows the same ranked list ":word" pops
// above the composer (showEmojiDropdown, input.js) for the bare word under the
// caret, instead of completing in place. From there the colon list's own keys
// apply: arrows move, Tab or Enter takes the highlighted emote and hands off to
// the Tab cycle (insertEmojiFromDropdown), Esc closes, typing closes it
// (checkEmojiAutocomplete finds no colon). Local caches only, no network, like
// the colon list.
//
// Returns false when nothing local matches: the caller then runs the classic
// first Tab, whose catalog search (7TV/BTTV/FFZ) can still complete the word.
//
// Lives outside input.js because input.js sits at its line ceiling
// (tests/loc-ceilings.txt); it shares the multichat bundle scope, so
// emojiAcState, findEmoteMatches and showEmojiDropdown resolve at call time.
function openTabEmoteList(word) {
  const matches = findEmoteMatches(word).slice(0, EMOJI_DROPDOWN_MAX)
  if (!matches.length) return false
  emojiAcState.active = true
  emojiAcState.matches = matches
  emojiAcState.query = word
  emojiAcState.plain = true
  emojiAcState.index = 0
  showEmojiDropdown(matches, 0)
  return true
}
