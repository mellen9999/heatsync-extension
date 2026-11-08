/**
 * Visible words that used to be english literals in the panel now go through t(). Each listed file must
 * read its keys, and each key must exist in the default catalog (locale-completeness.test.js then makes
 * every other locale carry it too).
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const EN = JSON.parse(readFileSync(new URL('../src/_locales/en/messages.json', import.meta.url), 'utf8'))
const src = (f) => readFileSync(new URL(`../src/multichat/${f}`, import.meta.url), 'utf8')

const USES = {
  'main.js': ['mc_tagcard_you', 'mc_bits_n', 'mc_reply_blocked', 'mc_moment_permalink'],
  'settings-ui.js': ['mc_set_reload'],
  'sound-ui.js': ['mc_set_snd_ping', 'mc_set_snd_blip', 'mc_set_snd_knock', 'mc_set_snd_chime'],
  'mentions.js': [
    'mc_mention_reply_post',
    'mc_mention_reply_reply',
    'mc_mention_reply_you',
    'mc_mention_fixed',
    'mc_mention_in_post',
    'mc_ircx_anonymous',
  ],
  'tab-mode.js': ['mc_tabmode_fixed', 'mc_tabmode_no_close'],
  'social.js': ['mc_social_anonymous'],
  'name-marks-data.js': ['mc_mark_user', 'lib_opt_heat'],
  'feed-embed.js': [
    'mc_held_media',
    'mc_held_embed',
    'mc_held_show',
    'mc_held_hide',
    'mc_held_nsfw',
    'mc_held_violence',
    'mc_held_weapons',
    'mc_held_drugs',
    'mc_held_hate',
  ],
  'img-view.js': ['mc_held_image'],
}

describe('former literals read the catalog', () => {
  for (const [file, keys] of Object.entries(USES)) {
    test(file, () => {
      const text = src(file)
      for (const k of keys) {
        expect(EN[k], `${k} missing from the en catalog`).toBeDefined()
        expect(text, `${file} no longer reads ${k}`).toContain(`'${k}'`)
      }
    })
  }

  test('the english stays what it was', () => {
    expect(EN.mc_held_media.message).toBe('[media hidden — $WHY$]')
    expect(EN.mc_held_embed.message).toBe('[embed hidden — $WHY$]')
    expect(EN.mc_held_image.message).toBe('[image hidden — $WHY$]')
    expect(EN.mc_held_hate.message).toBe('hate speech')
    expect(EN.mc_bits_n.message).toBe('$COUNT$ bits')
    expect(EN.mc_reply_blocked.message).toBe('[blocked]')
    expect(EN.mc_mention_reply_post.message).toBe('replied to your post')
    expect(EN.mc_social_anonymous.message).toBe('Anonymous')
  })
})
