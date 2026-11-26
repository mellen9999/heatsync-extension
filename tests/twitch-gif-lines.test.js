/**
 * A twitch gif-keyboard line draws its picture in the multichat pane.
 *
 * The line's text is only a caption ("[Mood Lol GIF by Giphy]"); the picture's url is in the server's
 * EventSub copy and reaches the ext two ways: on the irc:message record (`gifs: [{ text, url }]`), or as
 * the id-keyed room event `chat:gif` (the shape of chat:origin). Born with it (the record carried it, or
 * an event arrived first and was held) or late (the event arrives after the row: that one row is redrawn
 * in place). Matched by message id, never by text. The rules are the site's: the real bundle runs here.
 *
 * Runs the real appendRowMedia + foldEmbeddedMediaUrl (main-messages.js), the real chat embed
 * (feed-embed.js) and the real gif-lines.js over a happy-dom list.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { chatGifsSource, GIFS_GLOBAL } from '../scripts/lib/chat-gifs-bundle.mjs'
import utils from '../src/lib/utils.js'
import { bgSource } from './bg-src.js'
import { mainSource } from './main-src.js'

const ROOT = join(import.meta.dir, '..')
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8')
const EMBED = read('src', 'multichat', 'feed-embed.js')
const GIF_LINES = read('src', 'multichat', 'gif-lines.js')
const MESSAGES = read('src', 'multichat', 'main-messages.js')
const sliceFn = (src, name) => {
  const s = src.indexOf(`function ${name}(`)
  if (s === -1) throw new Error(`function not found: ${name}`)
  return src.slice(s, src.indexOf('\n}\n', s) + 3)
}

const hsChatGifs = new Function(`${chatGifsSource(ROOT)}\nreturn ${GIFS_GLOBAL}`)()
const CAPTION = '[Mood Lol GIF by Giphy]'
const GIPHY = 'https://media.giphy.com/media/joSNxeswxuc74Juo8X/giphy.gif'
const PROXY = 'https://heatsync.org/api/img?url='
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** a fresh world: the pane, the twitch ring, and the real functions over them */
function world({ images = true } = {}) {
  const win = new Window()
  const doc = win.document
  const pane = doc.createElement('div')
  pane.id = 'hs-mc-messages'
  doc.body.appendChild(pane)
  const ring = []
  const irc = { getTail: (_ch, n) => ring.slice(-n) }
  const embed = new Function(
    'escapeHtml',
    'safeUrl',
    't',
    'logPermalinkParts',
    'chatUrlPlayable',
    `${EMBED.slice(EMBED.indexOf('const HS_IMG_DIRECT_HOSTS'), EMBED.indexOf('\nfunction ytEmbed'))}
${EMBED.match(/^const _CHAT_URL_RE = .*$/m)[0]}
${sliceFn(EMBED, 'sanitizeEmbedId')}${sliceFn(EMBED, 'attr')}${sliceFn(EMBED, 'extractChatEmbed')}${sliceFn(EMBED, 'chatEmbedForUrl')}
return { extractChatEmbed, chatEmbedForUrl }`,
  )(
    esc,
    utils.safeUrl,
    (k) => k,
    () => null,
    () => false,
  )
  let lines
  const gifs = new Function(
    'hsChatGifs',
    'irc',
    'document',
    'appendRowMedia',
    `${GIF_LINES}\nreturn { hsGifLive, hsGifsOf, ledger: () => _gifLedger }`,
  )(hsChatGifs, irc, doc, (div, m) => lines.appendRowMedia(div, m))
  lines = new Function(
    'document',
    'mediaEmbedsEnabled',
    'linksEnabled',
    'extractChatEmbed',
    'chatEmbedForUrl',
    'hsChatGifs',
    'hsGifsOf',
    `${sliceFn(MESSAGES, 'appendRowMedia')}${sliceFn(MESSAGES, 'foldEmbeddedMediaUrl')}
return { appendRowMedia }`,
  )(doc, images, true, embed.extractChatEmbed, embed.chatEmbedForUrl, hsChatGifs, gifs.hsGifsOf)
  // hsGifPaint is the module's own: the late event calls it through the scope that holds appendRowMedia
  const rig = { doc, pane, ring, ...gifs, appendRowMedia: lines.appendRowMedia }

  /** a row drawn the way buildMessageDiv leaves it: its text span, then its media */
  rig.draw = (m, { tail = true } = {}) => {
    const div = doc.createElement('div')
    div.className = 'hs-mc-msg'
    div.dataset.msgId = m.id
    div._hsMsg = m
    div.innerHTML = `<span class="hs-mc-name">${m.user}</span>: <span class="hs-mc-text">${esc(m.text)}</span>`
    lines.appendRowMedia(div, m)
    pane.appendChild(div)
    if (tail) ring.push(m)
    return div
  }
  rig.img = (div) => div.querySelector('.hs-mc-media img')
  rig.caption = (div) => div.querySelector('.hs-mc-text')
  rig.fire = (el, type) => el.dispatchEvent(new win.Event(type))
  rig.load = (div) => rig.fire(rig.img(div), 'load')
  return rig
}
const rigOf = world

const line = (id, text = CAPTION, extra = {}) => ({
  id,
  user: 'viewer',
  text,
  channel: 'xqc',
  platform: 'twitch',
  ...extra,
})
const event = (messageId, gifs = [{ text: CAPTION, url: GIPHY }], channel = 'xqc') => ({
  type: 'chat_gif',
  platform: 'twitch',
  channel,
  messageId,
  gifs,
})

describe('born with its gif', () => {
  test('a record that carried the gif draws the picture, and the caption folds once it has loaded', () => {
    const w = rigOf()
    const row = w.draw(line('m1', CAPTION, { gifs: [{ text: CAPTION, url: GIPHY }] }))
    expect(w.img(row).getAttribute('src')).toBe(PROXY + encodeURIComponent(GIPHY))
    expect(row.querySelector('.hs-mc-media').dataset.hsSrcUrl).toBe(GIPHY)
    // not before: a picture that never loads must not leave the line blank
    expect(w.caption(row).classList.contains('hs-mc-url-folded')).toBe(false)
    w.load(row)
    expect(w.caption(row).classList.contains('hs-mc-url-folded')).toBe(true)
  })

  test('an event that came before its line is held, and the line is born with the gif', () => {
    const w = rigOf()
    w.hsGifLive(event('m2'))
    const row = w.draw(line('m2'))
    expect(w.img(row)).toBeTruthy()
    expect(row._hsMsg.gifs).toEqual([{ text: CAPTION, url: GIPHY }])
  })

  test('a dead picture keeps the caption', () => {
    const w = rigOf()
    const row = w.draw(line('m3', CAPTION, { gifs: [{ text: CAPTION, url: GIPHY }] }))
    w.fire(w.img(row), 'error')
    expect(w.caption(row).classList.contains('hs-mc-url-folded')).toBe(false)
  })
})

describe('late: the event arrives after the row', () => {
  test('that row is redrawn in place, matched by message id, and the ring copy is born with it later', () => {
    const w = rigOf()
    const other = w.draw(line('o1')) // same caption, another id: a stranger typed it
    const row = w.draw(line('m4'))
    expect(w.img(row)).toBeNull()
    w.hsGifLive(event('m4'))
    expect(w.pane.children[1]).toBe(row) // the same node, not a new pane
    expect(w.img(row).getAttribute('src')).toBe(PROXY + encodeURIComponent(GIPHY))
    expect(w.img(other)).toBeNull() // never by text
    expect(w.ring.find((m) => m.id === 'm4').gifs).toEqual([{ text: CAPTION, url: GIPHY }])
    expect(w.ring.find((m) => m.id === 'o1').gifs).toBeUndefined()
    w.load(row)
    expect(w.caption(row).classList.contains('hs-mc-url-folded')).toBe(true)
  })

  test('a repeat of what the row already holds does nothing', () => {
    const w = rigOf()
    const row = w.draw(line('m5'))
    w.hsGifLive(event('m5'))
    const first = w.img(row)
    w.hsGifLive(event('m5'))
    expect(w.img(row)).toBe(first)
    expect(row.querySelectorAll('.hs-mc-media-wrap')).toHaveLength(1)
  })

  test('the same id in another room, or another platform, is not this line', () => {
    const w = rigOf()
    const row = w.draw(line('m6'))
    const kick = w.draw(line('m6', CAPTION, { platform: 'kick' }))
    w.hsGifLive(event('m6', undefined, 'someoneelse'))
    expect(w.img(row)).toBeNull()
    w.hsGifLive(event('m6'))
    expect(w.img(row)).toBeTruthy()
    expect(w.img(kick)).toBeNull()
  })

  test("a card the line's own url drew makes way for the gif, and what it folded comes back", () => {
    const w = rigOf()
    const url = 'https://example.org/x.png'
    const row = w.draw(line('m7', `${CAPTION} ${url}`))
    // the url's own embed and its folded link
    row.querySelector('.hs-mc-text').innerHTML = `${CAPTION} <a class="hs-mc-link hs-mc-url-folded" href="${url}">x</a>`
    w.hsGifLive(event('m7'))
    expect(row.querySelectorAll('.hs-mc-media-wrap')).toHaveLength(1)
    expect(row.querySelector('.hs-mc-media').dataset.hsSrcUrl).toBe(GIPHY)
    expect(row.querySelector('a.hs-mc-link').classList.contains('hs-mc-url-folded')).toBe(false)
  })
})

describe('what is refused', () => {
  const bad = [
    'http://media.giphy.com/media/abc/giphy.gif',
    'https://media.giphy.com.attacker.net/media/abc/giphy.gif',
    'https://evil.example/media/abc/giphy.gif',
    'https://user:pw@media.giphy.com/media/abc/giphy.gif',
    'https://media.giphy.com/media/abc/',
    'javascript:alert(1)',
    'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
  ]

  test('an event with an untrusted host or a url that is not https draws nothing and is not held', () => {
    for (const url of bad) {
      const w = rigOf()
      const row = w.draw(line('b1'))
      w.hsGifLive(event('b1', [{ text: CAPTION, url }]))
      expect(w.img(row), url).toBeNull()
      expect(row._hsMsg.gifs, url).toBeUndefined()
      expect(w.ledger(), url).toBeNull()
    }
  })

  test('a record that carries one is checked again at the row: no picture, and no card either', () => {
    for (const url of bad) {
      const w = rigOf()
      const row = w.draw(line('b2', `${CAPTION} https://example.org/x.png`, { gifs: [{ text: CAPTION, url }] }))
      expect(row.querySelector('.hs-mc-media-wrap'), url).toBeNull()
    }
  })

  test('a frame that is not a twitch line, or has no id or no channel, is dropped', () => {
    const w = rigOf()
    const row = w.draw(line('b3'))
    for (const f of [
      { ...event('b3'), platform: 'kick' },
      { ...event('b3'), messageId: '' },
      { ...event('b3'), channel: '' },
      { ...event('b3'), gifs: 'nope' },
      null,
    ]) {
      w.hsGifLive(f)
    }
    expect(w.img(row)).toBeNull()
    expect(w.ledger()).toBeNull()
  })

  test('the query string is stripped: what the sender saw is the picture, not the tracking', () => {
    const w = rigOf()
    const row = w.draw(line('b4'))
    w.hsGifLive(event('b4', [{ text: CAPTION, url: `${GIPHY}?cid=abc&ep=v1_gifs_search` }]))
    expect(row.querySelector('.hs-mc-media').dataset.hsSrcUrl).toBe(GIPHY)
  })
})

describe('images off', () => {
  test('keeps the caption: no picture for a record that carries one, none for a late event', () => {
    const w = rigOf({ images: false })
    const born = w.draw(line('i1', CAPTION, { gifs: [{ text: CAPTION, url: GIPHY }] }))
    expect(born.querySelector('.hs-mc-media-wrap')).toBeNull()
    const late = w.draw(line('i2'))
    w.hsGifLive(event('i2'))
    expect(late.querySelector('.hs-mc-media-wrap')).toBeNull()
    for (const row of [born, late]) expect(w.caption(row).classList.contains('hs-mc-url-folded')).toBe(false)
  })
})

describe('what the caption is', () => {
  test('a line with words besides the caption keeps its words, picture or not', () => {
    const w = rigOf()
    const row = w.draw(line('c1', `so true ${CAPTION} lol`, { gifs: [{ text: CAPTION, url: GIPHY }] }))
    expect(w.img(row)).toBeTruthy()
    w.load(row)
    expect(w.caption(row).classList.contains('hs-mc-url-folded')).toBe(false)
  })

  test('a reply to someone: the @mention is the reply, not words, so the caption still folds', () => {
    const w = rigOf()
    const row = w.draw(
      line('c2', `@streamer ${CAPTION}`, { replyTo: { user: 'streamer' }, gifs: [{ text: CAPTION, url: GIPHY }] }),
    )
    w.load(row)
    expect(w.caption(row).classList.contains('hs-mc-url-folded')).toBe(true)
    // the same words typed by hand (not a reply) are words
    const typed = w.draw(line('c3', `@streamer ${CAPTION}`, { gifs: [{ text: CAPTION, url: GIPHY }] }))
    w.load(typed)
    expect(w.caption(typed).classList.contains('hs-mc-url-folded')).toBe(false)
  })

  test('a line with a gif has that one embed: its own url does not draw a second', () => {
    const w = rigOf()
    const row = w.draw(line('c4', `${CAPTION} https://example.org/x.png`, { gifs: [{ text: CAPTION, url: GIPHY }] }))
    expect(row.querySelectorAll('.hs-mc-media-wrap')).toHaveLength(1)
    expect(row.querySelector('.hs-mc-media').dataset.hsSrcUrl).toBe(GIPHY)
  })

  test('a pasted picture still folds its own link, as it did', () => {
    const w = rigOf()
    const url = 'https://i.imgur.com/abc.png'
    const row = w.doc.createElement('div')
    row.innerHTML = `<span class="hs-mc-text"><a class="hs-mc-link" href="${url}">${url}</a></span>`
    const m = line('c5', url)
    row._hsMsg = m
    w.appendRowMedia(row, m)
    w.fire(row.querySelector('.hs-mc-media img'), 'load')
    expect(row.querySelector('a.hs-mc-link').classList.contains('hs-mc-url-folded')).toBe(true)
    expect(w.caption(row).classList.contains('hs-mc-url-folded')).toBe(false)
  })
})

describe('memory', () => {
  test('a session that never sees a gif holds nothing', () => {
    const w = rigOf()
    for (let i = 0; i < 50; i++) w.draw(line(`n${i}`, 'just a line'))
    expect(w.ledger()).toBeNull()
  })

  test('held events are bounded: the oldest of 300 goes first', () => {
    const w = rigOf()
    for (let i = 0; i < 305; i++) w.hsGifLive(event(`h${i}`))
    expect(w.draw(line('h0'), { tail: false })._hsMsg.gifs).toBeUndefined()
    expect(w.draw(line('h304'), { tail: false })._hsMsg.gifs).toEqual([{ text: CAPTION, url: GIPHY }])
  })
})

describe('the wires', () => {
  test("the record: the server's gifs ride onto the message, only as a list", () => {
    const bg = bgSource()
    const { bgIrcRecordToExt } = new Function(
      'bgIrcSanitizeColor',
      `${sliceFn(bg, 'bgIrcRecordToExt')}\nreturn { bgIrcRecordToExt }`,
    )((c) => c)
    const rec = { type: 'privmsg', id: 'r1', username: 'viewer', content: CAPTION, timestamp: 1 }
    expect(bgIrcRecordToExt({ ...rec, gifs: [{ text: CAPTION, url: GIPHY }] }, 'xqc').gifs).toEqual([
      { text: CAPTION, url: GIPHY },
    ])
    for (const gifs of [undefined, [], 'nope', { text: CAPTION }]) {
      expect(bgIrcRecordToExt({ ...rec, gifs }, 'xqc')).not.toHaveProperty('gifs')
    }
  })

  test('the room event: the worker relays chat:gif to the tabs, and a tab hands it to the row', () => {
    const bg = bgSource()
    const arm = bg.slice(bg.indexOf("case 'chat:gif':"), bg.indexOf("case 'chat:origin_broadcast':"))
    expect(arm).toContain("broadcastToTabs({ ...msg, type: 'chat_gif' })")
    const social = read('src', 'multichat', 'social.js')
    expect(social).toContain("msg.type === 'chat_gif' && msg.messageId")
    expect(social).toContain('hsGifLive(msg)')
  })

  test('every row draws its media through the one function the late event redraws with', () => {
    const body = sliceFn(mainSource(), 'buildMessageDiv')
    expect(body).toContain('appendRowMedia(div, m)')
    expect(sliceFn(mainSource(), 'appendRowMedia')).toContain('hsGifsOf(m)')
    expect(GIF_LINES).toContain('appendRowMedia(div, div._hsMsg)')
  })

  test('the bundle is one global holding the whole api, and no other top-level name', () => {
    const src = chatGifsSource(ROOT)
    // nothing but the one global lands in the shared scope: the bundle's own names stay inside it
    expect(src.startsWith(`var ${GIFS_GLOBAL} = (() => {`)).toBe(true)
    const leaked = new Function(`${src}\nreturn [typeof chatGif, typeof MAX_CHAT_GIFS, typeof CHAT_GIF_HOSTS].join()`)()
    expect(leaked).toBe('undefined,undefined,undefined')
    expect(Object.keys(hsChatGifs).sort()).toEqual([
      'chatGifs',
      'createGifLedger',
      'lineIsOnlyCaption',
      'parseChatGifFrame',
      'sameGifs',
    ])
    // a checkout without the copies fails the build; it never ships a bundle that names what it does not carry
    expect(() => chatGifsSource(join(ROOT, 'tests', 'no-such-root'))).toThrow(/chat-gifs\.js/)
  })

  test("the validator is the site's: the bundle refuses what the site refuses", () => {
    const one = (url) => hsChatGifs.chatGifs([{ text: CAPTION, url }])
    expect(one(GIPHY)).toEqual([{ text: CAPTION, url: GIPHY }])
    expect(one('http://media.giphy.com/media/a/giphy.gif')).toEqual([])
    expect(one('https://evil.example/a.gif')).toEqual([])
    expect(hsChatGifs.chatGifs(Array.from({ length: 9 }, (_, i) => ({ text: `[g${i}]`, url: GIPHY })))).toHaveLength(4)
  })
})
