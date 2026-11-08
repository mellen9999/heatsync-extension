// The shared card model + renderer (lib/card-*.js) are byte-mirrored with the site and hard-code their words in
// english. This puts the extension's language on them without touching the mirror: labels and values on the model
// before it renders, the few literals the renderer owns on the html after. Every table entry is pinned to its english
// source by tests/card-l10n.test.js, so a reworded mirror fails loud instead of quietly going english again.
// Deliberately left english: the action/nav buttons, whose underlined first letter teaches the keyboard hotkey.

// sheet row id (the model's `k`) -> message key. extra rows the host adds already arrive translated and are not here
const CARD_SHEET_LABEL = {
  acctage: 'mc_card_l_age',
  type: 'mc_card_l_type',
  heat: 'lib_opt_heat',
  peak: 'mc_card_l_peak',
  posts: 'mc_tagcard_posts',
  followers: 'mc_tip_row_followers',
  following: 'mc_tagcard_following',
  mutuals: 'mc_card_l_mutuals',
  'followers-live': 'mc_tip_row_followers',
  'following-live': 'mc_tagcard_following',
  'ch-sub': 'mc_tip_row_ch_sub',
  'ch-follow': 'mc_tip_row_ch_follow',
  'ch-follows-you': 'mc_tip_row_follower',
}
// the relationship rows share one id per kind, so their label is told apart by its english word
const CARD_REL_LABEL = { rel: 'mc_card_l_rel', you: 'mc_tip_row_you', they: 'mc_tip_row_they' }
const CARD_TYPE_VALUE = {
  partner: 'content_card_partner',
  affiliate: 'content_card_affiliate',
  admin: 'mc_card_l_admin',
  staff: 'mc_card_l_staff',
}
const CARD_REL_TEXT = {
  mutual: 'content_card_mutual',
  follow: 'content_card_follow',
  'follow you': 'mc_card_l_follow_you',
  'mutual sub': 'content_card_mutual_sub',
}
// english literals the renderer prints itself: [html to find, key, how to rebuild it]. Anchored on the surrounding
// markup, which is escaped everywhere user text goes, so a user can never produce a match
const CARD_HTML_LITERALS = [
  ['<dt>note</dt>', 'content_card_note_title', (s) => `<dt>${escapeHtml(s)}</dt>`],
  ['<span>recent</span>', 'btn_recent', (s) => `<span>${escapeHtml(s)}</span>`],
  ['>add bio</span>', 'mc_card_l_add_bio', (s) => `>${escapeHtml(s)}</span>`],
  ['placeholder="reason (optional)"', 'mc_ms_ub_reason_ph', (s) => `placeholder="${escapeHtml(s)}"`],
  [
    '<div class="hs-card-meta">lookup failed</div>',
    'mc_card_l_lookup_failed',
    (s) => `<div class="hs-card-meta">${escapeHtml(s)}</div>`,
  ],
  [' not following</dd>', 'mc_tagcard_not_following', (s) => ` ${escapeHtml(s)}</dd>`],
  [' · also ', 'mc_card_l_also', (s) => ` · ${escapeHtml(s)} `],
  ['<dd>also ', 'mc_card_l_also', (s) => `<dd>${escapeHtml(s)} `],
]

function cardRelText(text) {
  if (CARD_REL_TEXT[text]) return t(CARD_REL_TEXT[text])
  let m = /^sub T(\d+)$/.exec(text)
  if (m) return t('mc_card_l_sub_tier', [m[1]])
  m = /^sub to you(?: T(\d+))?$/.exec(text)
  if (m) return m[1] ? t('mc_card_l_sub_to_you_tier', [m[1]]) : t('mc_card_l_sub_to_you')
  return text
}

// 'logs' row text: "12 msgs · since 2024-05-01 in #chan", pieces split on the model's own separator
function cardCorpusText(text) {
  return text
    .split(' · ')
    .map((part) => {
      let m = /^(.+) msgs$/.exec(part)
      if (m) return t('mc_tip_corpus_msgs', [m[1]])
      m = /^since (\S+) in #(.+)$/.exec(part)
      if (m) {
        const [, day, channel] = m
        return t('mc_card_l_since_in', [day, channel])
      }
      m = /^since (\S+)$/.exec(part)
      return m ? t('mc_tip_corpus_since', [m[1]]) : part
    })
    .join(' · ')
}

function cardL10nModel(model) {
  if (!model || model.kind === 'error' || model.kind === 'not-found') return model
  const out = { ...model }
  if (model.corpus) {
    out.corpus = { ...model.corpus, label: t('mc_tip_row_logs'), text: cardCorpusText(model.corpus.text || '') }
  }
  if (model.sheet) {
    out.sheet = model.sheet.map((r) => {
      const labelKey = r.k === 'rel-follow' || r.k === 'rel-sub' ? CARD_REL_LABEL[r.label] : CARD_SHEET_LABEL[r.k]
      const row = labelKey ? { ...r, label: t(labelKey) } : r
      if (r.k === 'type' && CARD_TYPE_VALUE[r.value]) return { ...row, value: t(CARD_TYPE_VALUE[r.value]) }
      if ((r.k === 'rel-follow' || r.k === 'rel-sub') && r.value?.text) {
        return { ...row, value: { ...r.value, text: cardRelText(r.value.text) } }
      }
      return row
    })
  }
  if (model.channel) {
    out.channel = {
      ...model.channel,
      rows: model.channel.rows.map((r) => (CARD_SHEET_LABEL[r.k] ? { ...r, label: t(CARD_SHEET_LABEL[r.k]) } : r)),
    }
  }
  return out
}

function cardL10nHtml(html) {
  let out = html
  for (const [find, key, rebuild] of CARD_HTML_LITERALS) {
    if (out.includes(find)) out = out.split(find).join(rebuild(t(key)))
  }
  return out
}

/** hsCardHtml, in the extension's language. Same arguments, same markup, only the words differ. */
function hsCardHtmlL10n(model, opts) {
  return cardL10nHtml(hsCardHtml(cardL10nModel(model), opts))
}
