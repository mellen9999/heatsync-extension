// A twitch gif-keyboard line: its text is only a caption ("[Mood Lol GIF by Giphy]"), the picture's url is in the
// server's EventSub copy of it. It reaches a row two ways, both as `gifs: [{ text, url }]`: on the record
// (irc:message, bgIrcRecordToExt), or as the id-keyed room event `chat:gif` (the shape of `chat:origin`): the row is
// on screen already and is redrawn in place, or not drawn yet and the event is held so the line is born with it.
// Matched by message id and channel, NEVER by text: a stranger who types the same caption has no gif.
// The rules are the site's, byte for byte (hsChatGifs: scripts/lib/chat-gifs-bundle.mjs); the row draws through
// the same chat media embed a pasted picture gets (appendRowMedia, main-messages.js), so there is one picture policy.

// the event follows its line by a moment, so the line is near the tail
const GIF_SCAN_ROWS = 500
// made by the first event: a session that never sees a gif line holds nothing
let _gifLedger = null

const gifRoom = (m) =>
  String(m?.channel || '')
    .toLowerCase()
    .replace(/^#/, '')
// a drawn [H] row is still the twitch line it was: its platform stays the chat it came from
const gifLineIs = (m, channel, id) =>
  !!m && m.id === id && (m.platform || 'twitch') === 'twitch' && gifRoom(m) === channel

// The gifs a line draws: its own, else what an event named before the line was drawn (hsGifLive held it).
function hsGifsOf(m) {
  if (!m.gifs && _gifLedger?.size && m.id && (m.platform || 'twitch') === 'twitch') {
    const held = _gifLedger.get('twitch', gifRoom(m), m.id)
    if (held) m.gifs = held
  }
  return m.gifs
}

// A drawn row whose line just learned its gif: the gif is the row's one embed, so a card the line's own url drew makes
// way for it, and what that card folded comes back; then the row draws as it would have been born.
function hsGifPaint(div) {
  div.querySelector(':scope > .hs-mc-media-wrap')?.remove()
  for (const el of div.querySelectorAll('.hs-mc-url-folded')) el.classList.remove('hs-mc-url-folded')
  appendRowMedia(div, div._hsMsg)
}

// One `chat_gif` {platform, channel, messageId, gifs} (the background's relay of the `chat:gif` room event).
function hsGifLive(data) {
  const frame = hsChatGifs.parseChatGifFrame(data)
  if (!frame) return
  const { platform, channel, messageId, gifs } = frame
  if (!_gifLedger) _gifLedger = hsChatGifs.createGifLedger()
  _gifLedger.note(platform, channel, messageId, gifs)
  // the ring's copy of the line, so a row drawn from it later is born with the gif
  const tail = irc ? irc.getTail(channel, GIF_SCAN_ROWS) : []
  for (let i = tail.length - 1; i >= 0; i--) {
    if (!gifLineIs(tail[i], channel, messageId)) continue
    tail[i].gifs = gifs
    break
  }
  // the row on screen: redrawn in place, that one row, never the pane; a repeat of what it drew does nothing
  const rows = document.getElementById('hs-mc-messages')?.children
  if (!rows) return
  for (let i = rows.length - 1, n = 0; i >= 0 && n < GIF_SCAN_ROWS; i--, n++) {
    const m = rows[i]._hsMsg
    if (!gifLineIs(m, channel, messageId)) continue
    m.gifs = gifs
    if (!hsChatGifs.sameGifs(rows[i]._hsGifs, gifs)) hsGifPaint(rows[i])
    break
  }
}
