/**
 * Twitch gif-keyboard lines — what the client knows about a picture the line's
 * text only names.
 *
 * The gif keyboard sends a line whose text is a caption ("[Mood Lol GIF by
 * Giphy]"); the url exists only in the EventSub copy the server reads. It
 * reaches the page two ways, both as `gifs: [{ text, url }]` on the message:
 * stamped on a record the server feeds (the extension's irc:message), or as the
 * id-keyed room event `chat:gif` {platform, channel, messageId, gifs} — the one
 * the site lives on, since it reads twitch chat from its own irc socket and the
 * caption is always the first thing it draws.
 *
 * One validator, shared with the server (shared/gif-links.ts chatGifs): https,
 * a giphy/tenor media host, a picture file, a few at most. A frame that fails it
 * is not "partly applied", it is ignored.
 *
 * @module utils/chat-gifs
 */
import { chatGifs } from '../../shared/gif-links.ts'

/**
 * One `chat:gif` frame → the line it names and the gifs it carries, or null.
 * @param {any} data
 * @returns {{ platform: 'twitch', channel: string, messageId: string, gifs: Array<{text: string, url: string}> } | null}
 */
export function parseChatGifFrame(data) {
  if (!data || data.platform !== 'twitch') return null
  if (typeof data.channel !== 'string' || !data.channel) return null
  if (typeof data.messageId !== 'string' || !data.messageId) return null
  const gifs = chatGifs(data.gifs)
  if (!gifs.length) return null
  return { platform: 'twitch', channel: data.channel.toLowerCase().replace(/^#/, ''), messageId: data.messageId, gifs }
}

/**
 * What an event named for a line that has not been drawn yet. The event rides
 * the site socket and the line rides irc: neither waits for the other, so a
 * line that arrives second must be born with what the first one said. Keyed by
 * channel + id (shared chat shows one id in several rooms), FIFO-bounded.
 * @param {{ max?: number }} [opts]
 */
export function createGifLedger({ max = 300 } = {}) {
  /** @type {Map<string, Array<{text: string, url: string}>>} */
  const held = new Map()
  const keyOf = (platform, channel, id) => `${platform}/${String(channel).toLowerCase()}:${id}`
  return {
    /** How many lines it is holding — most sessions never see a gif line, and ask nothing of it. */
    get size() { return held.size },
    note(platform, channel, id, gifs) {
      const k = keyOf(platform, channel, id)
      held.delete(k)
      held.set(k, gifs)
      if (held.size > max) held.delete(held.keys().next().value)
    },
    get(platform, channel, id) {
      return held.get(keyOf(platform, channel, id))
    },
  }
}

/** Same pictures, same captions, same order — an event repeated is not news. */
export function sameGifs(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  return a.every((g, i) => g.url === b[i].url && g.text === b[i].text)
}

/**
 * Is the caption all the line says? Then the picture replaces the whole text. A
 * reply's leading @mention is the reply, not something said, so it does not
 * count against that; words besides the caption do, and stay.
 * @param {string} content the line's text
 * @param {string} text the gif fragment's text
 * @param {boolean} [isReply]
 */
export function lineIsOnlyCaption(content, text, isReply = false) {
  const line = String(content || '')
  if (!text || !line.includes(text)) return false
  const rest = line.split(text).join('')
  return (isReply ? rest.replace(/^\s*@\S+/, '') : rest).trim() === ''
}
