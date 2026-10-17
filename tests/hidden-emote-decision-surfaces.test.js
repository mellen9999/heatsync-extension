import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// A flagged emote the viewer's filters hide must not put its image on screen
// anywhere: not in chat (cw stub), and not in the picker / composer chip /
// tab-complete either — a border around a visible image is still the image.
const SRC = readFileSync(new URL('../src/multichat/emotes.js', import.meta.url), 'utf8')
const a = SRC.indexOf('const HS_CW_SETTING_BY_CAT')
const b = SRC.indexOf('// Channel 7TV sets are fetched directly')
const c = SRC.indexOf('function hsChannelNsfwHidden')
const d = SRC.indexOf('// cw stub markup shared by every render branch')
const make = (settings) =>
  new Function('getSetting', `${SRC.slice(a, b)}\n${SRC.slice(c, d)}; return hsEmoteHiddenForViewer`)(
    (k) => settings[k],
  )

describe('hsEmoteHiddenForViewer', () => {
  test('channel emote flagged sexual is hidden while the toggle is off', () => {
    expect(make({ viewer_show_sexual: false })({ nsfw: true })).toBe('sexual')
  })
  test('own-inventory category is hidden by its own toggle', () => {
    expect(make({ viewer_show_gore: false })({ cwCats: ['gore'] })).toBe('gore')
  })
  test('shown once the viewer opted in', () => {
    expect(make({ viewer_show_sexual: true })({ nsfw: true })).toBe('')
  })
  test('unflagged emotes are never hidden', () => {
    expect(make({ viewer_show_sexual: false })({})).toBe('')
  })
  test('the picker and chip builders ask the same question', () => {
    expect(
      /function emoteImgHtml[\s\S]*?hsEmoteHiddenForViewer\(emote\)\n\s*if \(hiddenCat\) return _hsCwBoxHtml/.test(SRC),
    ).toBe(true)
    expect(/function createInputEmoteImg[\s\S]*?hsEmoteHiddenForViewer\(emote\)\) return null/.test(SRC)).toBe(true)
  })
})
