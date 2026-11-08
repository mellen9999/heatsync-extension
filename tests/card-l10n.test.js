/**
 * card-l10n.js puts the extension's language on the shared card model + renderer, which are byte-mirrored
 * with the site and print english. This pins three things:
 *   - in english the wrapper changes nothing (same bytes as the bare renderer);
 *   - every label, value and literal it claims is really emitted by the mirror, and its message is the same
 *     english word (a reworded mirror fails here instead of quietly going english in every other locale);
 *   - in another locale each of them comes out through t().
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { hsCardModel } from '../src/lib/card-model.js'
import { hsCardHtml } from '../src/lib/card-render.js'
import { escapeHtml } from '../src/lib/utils.js'
import { makeCardL10n } from './card-l10n-env.js'
import { t as enT } from './en-t.js'

const EN = JSON.parse(readFileSync(new URL('../src/_locales/en/messages.json', import.meta.url), 'utf8'))
// a locale where every message is visibly its own key
const pseudoT = (key, subs = []) => `«${key}${subs.length ? `:${subs.join(',')}` : ''}»`

const DAY = '2020-01-02T00:00:00Z'
const base = (over) => ({
  id: 7,
  username: 'tester',
  display_name: 'Tester',
  twitch_username: 'tester',
  twitch_created_at: DAY,
  stats: { user_heat: 120, total_heat: 900, op_count: 3, followers: 50, following: 5 },
  ...over,
})
// four relationships and four account types cover every value the model can print
const PROFILES = [
  base({
    twitch_broadcaster_type: 'partner',
    relationship: {
      followsYou: true,
      isFollowing: true,
      followedAt: DAY,
      followsYouSince: DAY,
      subscribesToYou: true,
      isSubscribed: true,
      subscribedAt: DAY,
      mutuals: { count: 3, sample: [] },
    },
  }),
  base({
    twitch_broadcaster_type: 'affiliate',
    relationship: { isFollowing: true, followedAt: DAY, isSubscribed: true, subTier: '2000', subscribedAt: DAY },
  }),
  base({
    role: 'admin',
    relationship: {
      followsYou: true,
      followsYouSince: DAY,
      subscribesToYou: true,
      subscribesToYouTier: '3000',
      subscribesToYouSince: DAY,
    },
  }),
  base({ role: 'staff', relationship: { subscribesToYou: true, subscribesToYouSince: DAY } }),
]
const PAYLOAD = {
  corpus: { messages: 12, firstDay: '2024-05-01', firstChannel: 'somechan', also: ['alpha', 'beta'] },
  followage: { followedAt: DAY, channelFollowedAt: DAY, followerCount: 1000, followingCount: 5 },
  recent: [{ timestamp: 1700000000000, channel: 'somechan', message: 'hi' }],
  note: 'private',
}
const CTX = {
  channel: 'chan',
  chSubMonths: 5,
  hint: { platform: 'twitch', login: 'tester' },
  capabilities: { notes: true },
}
const DEPS = { formatCompactNumber: (n) => String(n) }

const models = PROFILES.map((profile) => hsCardModel({ ...PAYLOAD, profile }, CTX, DEPS))
// a channel the viewer does not follow prints the "not following" literal; a chatter-only card has just the logs row
const notFollowing = hsCardModel({ ...PAYLOAD, profile: PROFILES[0], followage: { followedAt: null } }, CTX, DEPS)
const chatter = hsCardModel(
  { corpus: PAYLOAD.corpus },
  { channel: 'chan', hint: { platform: 'twitch', login: 'tester' } },
  DEPS,
)
const alsoOnly = hsCardModel(
  { corpus: { also: ['alpha'] } },
  { channel: 'chan', hint: { platform: 'twitch', login: 'tester' } },
  DEPS,
)
const allModels = [...models, notFollowing, chatter, alsoOnly]
const opts = (variant) => ({ variant, escapeHtml })

describe('in english the wrapper is the bare renderer', () => {
  const l10n = makeCardL10n(enT)
  for (const variant of ['peek', 'full', 'panel']) {
    test(`variant ${variant}: same bytes for every fixture`, () => {
      for (const m of allModels) expect(l10n.hsCardHtmlL10n(m, opts(variant))).toBe(hsCardHtml(m, opts(variant)))
    })
  }
  test('an error card, a not-found card and a null model pass through', () => {
    for (const m of [{ kind: 'error', identity: { login: 'x' } }, { kind: 'not-found', identity: {} }, null]) {
      expect(l10n.hsCardHtmlL10n(m, opts('peek'))).toBe(hsCardHtml(m, opts('peek')))
    }
  })
})

describe('the tables match what the mirror emits', () => {
  const l10n = makeCardL10n(enT)
  const rows = allModels.flatMap((m) => [...(m.sheet || []), ...(m.channel?.rows || [])])
  const labelOf = (k) => rows.find((r) => r.k === k)?.label

  test('every sheet id is emitted, and its message is the english label', () => {
    for (const [k, key] of Object.entries(l10n.CARD_SHEET_LABEL)) {
      expect(labelOf(k), `row ${k} is no longer emitted by card-model.js`).toBeDefined()
      expect(EN[key].message, `${key} is not the english ${labelOf(k)}`).toBe(labelOf(k))
    }
  })

  test('relationship labels, type values and relationship texts are emitted, and messages are the english words', () => {
    const relLabels = new Set(rows.filter((r) => r.k === 'rel-follow' || r.k === 'rel-sub').map((r) => r.label))
    for (const [word, key] of Object.entries(l10n.CARD_REL_LABEL)) {
      expect(relLabels.has(word), `label ${word}`).toBe(true)
      expect(EN[key].message).toBe(word)
    }
    const types = new Set(rows.filter((r) => r.k === 'type').map((r) => r.value))
    for (const [word, key] of Object.entries(l10n.CARD_TYPE_VALUE)) {
      expect(types.has(word), `type ${word}`).toBe(true)
      expect(EN[key].message).toBe(word)
    }
    const texts = new Set(rows.filter((r) => r.value?.text).map((r) => r.value.text))
    for (const [word, key] of Object.entries(l10n.CARD_REL_TEXT)) {
      expect(texts.has(word), `text ${word}`).toBe(true)
      expect(EN[key].message).toBe(word)
    }
    expect([...texts]).toEqual(expect.arrayContaining(['sub T2', 'sub to you T3', 'sub to you']))
  })

  test('every html literal is printed by the renderer, and its message is the english', () => {
    const html = allModels.map((m) => hsCardHtml(m, opts('panel'))).join('')
    const bio = hsCardHtml({ ...models[0], bio: '', isOwnProfile: true }, { ...opts('panel'), renderBio: undefined })
    const meta = hsCardHtml({ kind: 'error', identity: { login: 'x' } }, opts('peek'))
    const reason = hsCardHtml(
      { ...models[0], mod: { groups: [{ channel: 'c', platform: 'twitch', login: 'x', actions: [] }] } },
      opts('panel'),
    )
    const printed = html + bio + meta + reason
    for (const [find, key] of makeCardL10n(enT).CARD_HTML_LITERALS) {
      expect(printed.includes(find), `renderer no longer prints ${find}`).toBe(true)
      expect(find.includes(EN[key].message), `${key} is not the english inside ${find}`).toBe(true)
    }
  })
})

describe('in another locale every claimed word goes through t()', () => {
  const l10n = makeCardL10n(pseudoT)
  const html = (m, variant = 'panel') => l10n.hsCardHtmlL10n(m, opts(variant))
  const all = allModels.map((m) => html(m)).join('')

  test('sheet labels', () => {
    for (const key of [
      'mc_card_l_age',
      'mc_card_l_type',
      'lib_opt_heat',
      'mc_card_l_peak',
      'mc_tagcard_posts',
      'mc_tip_row_followers',
      'mc_tagcard_following',
      'mc_card_l_mutuals',
      'mc_card_l_rel',
      'mc_tip_row_you',
      'mc_tip_row_they',
      'mc_tip_row_ch_sub',
      'mc_tip_row_ch_follow',
      'mc_tip_row_follower',
    ]) {
      expect(all, key).toContain(`<dt>«${key}»</dt>`)
    }
  })

  test('values: type, relationship, tiers', () => {
    for (const key of [
      'content_card_partner',
      'content_card_affiliate',
      'mc_card_l_admin',
      'mc_card_l_staff',
      'content_card_mutual',
      'content_card_follow',
      'mc_card_l_follow_you',
      'content_card_mutual_sub',
      'mc_card_l_sub_to_you',
    ]) {
      expect(all, key).toContain(`«${key}»`)
    }
    expect(all).toContain('«mc_card_l_sub_tier:2»')
    expect(all).toContain('«mc_card_l_sub_to_you_tier:3»')
  })

  test('logs row: label, counts, first seen, other channels', () => {
    expect(html(chatter)).toContain('<dt>«mc_tip_row_logs»</dt>')
    expect(all).toContain('«mc_tip_corpus_msgs:12»')
    expect(all).toContain('«mc_card_l_since_in:2024-05-01,somechan»')
    expect(all).toContain(' · «mc_card_l_also» #alpha #beta')
    expect(html(chatter)).toContain('<dd>«mc_tip_corpus_msgs:12»')
    expect(html(alsoOnly)).toContain('<dd>«mc_card_l_also» #alpha</dd>')
  })

  test('renderer literals: note, recent, not following, lookup failed', () => {
    expect(all).toContain('<dt>«content_card_note_title»</dt>')
    expect(all).toContain('<span>«btn_recent»</span>')
    expect(html(notFollowing)).toContain('«mc_tagcard_not_following»</dd>')
    expect(l10n.hsCardHtmlL10n({ kind: 'error', identity: { login: 'x' } }, opts('peek'))).toContain(
      '«mc_card_l_lookup_failed»',
    )
  })

  test('user text is never read as a literal', () => {
    const m = { ...models[0], displayName: 'note', bio: '<dt>note</dt> not following</dd> · also ' }
    const out = html(m)
    expect(out).toContain('&lt;dt&gt;note&lt;/dt&gt;')
    expect(out).not.toContain('<dt>note</dt> not following')
  })
})
