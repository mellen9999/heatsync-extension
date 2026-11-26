/**
 * Emote-only lines — the one answer to "does this line draw its pictures big".
 *
 * docs/emote-law.md ("big emote-only lines") is the prose. shared/emote-only.vectors.json is the
 * contract: the site, the extension and the desktop app run it against their own port (the terminal
 * client draws its pictures too and runs it in its own tests), so a client that answers differently
 * fails its own tests.
 *
 * The rule reads the LAW'S read of a line, never the text: each word of the line, in order, is one of
 *
 *   emote    a picture the law drew: a room / user / global / platform-native emote
 *   emoji    one unicode emoji (a word of three emoji is three of these)
 *   overlay  a zero-width emote, or a `name0`, stacked on the picture before it
 *   mod      a modifier word (`w!`, `ffzX`, a tint) bound to a picture
 *   text     anything else: a word, a link, a mention, punctuation, a name the room does not
 *            know, a taken-down emote, a modifier with nothing to change
 *
 * so there is no second resolver here: whatever the row already drew as a picture is a picture.
 * An overlay and a modifier belong to their picture and are never counted. One text word, anywhere,
 * makes it a normal line. 1 to 5 pictures draw big; 6 or more stay normal (a spam wall stays dense).
 *
 * Pure: no DOM, no clock, no I/O, no module state. O(words).
 */

export type Kind = 'emote' | 'emoji' | 'overlay' | 'mod' | 'text'

/** the most pictures a big line holds; one more and the line is a wall */
export const BIG_MAX = 5
/** big = this many times the line's normal emote height */
export const BIG_SCALE = 2

export interface Verdict {
  size: 'big' | 'normal'
  /** pictures counted: emotes and emoji, never an overlay or a modifier */
  pictures: number
}

const KINDS: readonly string[] = ['emote', 'emoji', 'overlay', 'mod', 'text']

/**
 * An overlay with no picture before it draws inline (the law: it stacks only on a picture right
 * before it), so it is a picture. A caller that follows the law never sends one; this keeps a
 * mislabelled read from counting a line short.
 */
export function emoteOnly(read: readonly Kind[]): Verdict {
  let pictures = 0
  let text = false
  let open = false // a picture is on the line for an overlay to sit on
  for (const k of read) {
    if (!KINDS.includes(k)) throw new Error(`emote-only: unknown kind ${JSON.stringify(k)}`)
    if (k === 'text') text = true
    else if (k === 'emote' || k === 'emoji') { pictures++; open = true }
    else if (k === 'overlay' && !open) { pictures++; open = true }
  }
  return { size: !text && pictures >= 1 && pictures <= BIG_MAX ? 'big' : 'normal', pictures }
}
