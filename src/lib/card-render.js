/**
 * card-render.js — turns an `hsCardModel` model into an escaped HTML string.
 *
 * Pure: no DOM access, no globals, no imports outside `client/card/`. Every
 * host dependency (escaping, number formatting, bio/badge rendering) is
 * passed in explicitly — that's what lets this file mirror byte-for-byte
 * into the extension's non-ESM bundle and still look native there.
 *
 * One class namespace: everything is `.hs-card-*`. Zero inline styles — the
 * repo's CSP forbids `style=` attributes in templates; every visual rule
 * lives in card.css. Variants control which sections print; the model never
 * changes shape between them (`peek` just renders less of the same model, so
 * switching peek → full on pin/click needs no re-fetch).
 *
 * @module card/card-render
 */

import { hsCardAccountAge, hsCardRelativeTime, hsCardLogTime, hsCardTenureMonths } from './card-time.js'

const HOTKEY_LABEL = {
  follow: 'follow', unfollow: 'unfollow', whisper: 'whisper', dm: 'dm',
  mention: 'mention', mute: 'mute', block: 'block', unblock: 'unblock', report: 'report',
}

/**
 * Underline the hotkey letter inside its own label — NOT the letter plus the
 * whole word (that duplicated the first letter: "follow" with hotkey 'f'
 * rendered as "f" + "follow" = "ffollow"). The hotkey is always the label's
 * own first character; note-edit's label is picked so that holds too.
 *
 * The hotkey span and the rest-of-word text both go inside ONE wrapping
 * span — every caller of this (platform links, actions, note-edit) sits in
 * a `display:flex` container with its own `gap`, and a bare trailing text
 * node next to the hotkey span is its OWN flex item there: "kick" rendered
 * as "k" + gap + "ick" = "k ick". Wrapping them together makes the whole
 * label one flex item, immune to a parent's gap no matter where it's used.
 */
/**
 * The card's own × — 'full' only (a pinned desktop popover or the phone
 * full-screen sheet; 'peek'/'page' dismiss some other way, and the
 * extension's 'panel' variant already has its own sticky × — the host
 * suppresses this one there, see profile-card.js). Wired by the host via
 * `data-hs-card-action="close"`, same delegation contract as follow/block/
 * report. Static markup, no escaping needed.
 */
function closeButtonHtml(variant) {
  return variant === 'full'
    ? '<button type="button" class="hs-card-close" data-hs-card-action="close" aria-label="close">×</button>'
    : ''
}

function hk(label, esc) {
  const first = label.slice(0, 1)
  const rest = label.slice(1)
  return `<span class="hs-card-label"><span class="hs-card-hk">${esc(first)}</span>${esc(rest)}</span>`
}

/**
 * Same hotkey-underline idea, but for a label too short to split without
 * reading as two separate letters (2 chars — "hs"/"yt" split to a lone
 * underlined letter next to a lone plain one, which read like "h s"/"y t").
 * Underline the whole label instead of carving one character off it.
 */
function hkShort(label, esc) {
  return label.length <= 2
    ? `<span class="hs-card-label"><span class="hs-card-hk">${esc(label)}</span></span>`
    : hk(label, esc)
}

function relRow(esc, fmtTime, entry) {
  // {text, since} sheet-row value → "text since"
  const since = entry.since ? ` ${fmtTime(entry.since)}` : ''
  return esc(entry.text) + esc(since)
}

/**
 * @param {object} model output of `hsCardModel`
 * @param {object} opts
 * @param {'peek'|'full'|'page'|'panel'} opts.variant
 * @param {(s: string) => string} opts.escapeHtml
 * @param {(bio: string) => string} [opts.renderBio] host-trusted HTML for the
 *   bio line (mentions/emotes linked) — falls back to plain escaped text
 * @param {(sinceIso: string) => string} [opts.renderPlusBadge] host's own
 *   plus-badge markup — falls back to a bare glyph
 * @param {(hex: string) => string} [opts.paintColor] host's dark-color-boost
 *   (fixDarkColors+safeColor) — stamped as `data-color` on the name element,
 *   never as `style=`. The host applies it via CSSOM at mount
 *   (`el.style.setProperty('color', el.dataset.color)`), same pattern every
 *   other per-user color in this app already uses under CSP. Falls back to
 *   the raw model color, unclamped, when omitted.
 * @param {(model: object) => string} [opts.renderBadges] host-trusted HTML
 *   for a chip row (native chat badges, 7TV/BTTV/FFZ/Chatterino paints) —
 *   the shared model carries no chat-badge data (it's per-message, not
 *   per-profile), so this is purely a host hook, same contract as
 *   `renderBio`. Omitted or empty return → no chip row.
 * @returns {string}
 */
export function hsCardHtml(model, opts) {
  const esc = opts.escapeHtml
  const variant = opts.variant || 'full'
  const fmtTime = (v) => hsCardRelativeTime(v)
  const clickable = !!opts.clickable
  const hideLogsLink = !!opts.hideLogsLink

  if (!model || model.kind === 'not-found') {
    return `<div class="hs-card hs-card-${esc(variant)} hs-card-empty">${closeButtonHtml(variant)}<div class="hs-card-name">${esc(model?.identity?.login || 'unknown')}</div></div>`
  }
  if (model.kind === 'error') {
    return `<div class="hs-card hs-card-${esc(variant)} hs-card-empty">${closeButtonHtml(variant)}<div class="hs-card-name">${esc(model?.identity?.login || 'unknown')}</div><div class="hs-card-meta">lookup failed</div></div>`
  }
  if (model.kind === 'chatter') {
    return renderChatter(model, { esc, variant })
  }
  return renderProfile(model, {
    esc,
    variant,
    fmtTime,
    renderBio: opts.renderBio,
    renderPlusBadge: opts.renderPlusBadge,
    paintColor: opts.paintColor,
    renderBadges: opts.renderBadges,
    clickable,
    hideLogsLink,
  })
}

function renderChatter(model, { esc, variant }) {
  const parts = []
  parts.push(closeButtonHtml(variant))
  parts.push(`<div class="hs-card-name">${esc(model.displayName)}<span class="hs-card-plat">${esc(model.identity.platform)}</span></div>`)
  if (model.corpus) parts.push(renderCorpusRow(model.corpus, esc))
  if (model.links?.chatterUrl) {
    parts.push(`<div class="hs-card-links"><a href="${esc(model.links.chatterUrl)}" target="_blank" rel="noopener">chatter stats →</a></div>`)
  }
  return `<div class="hs-card hs-card-${esc(variant)} hs-card-chatter">${parts.join('')}</div>`
}

function renderCorpusRow(corpus, esc) {
  const bits = []
  if (corpus.text) bits.push(esc(corpus.text))
  if (corpus.also) bits.push(`also ${esc(corpus.also)}`)
  return `<div class="hs-card-sheet-row"><dt>${esc(corpus.label)}</dt><dd>${bits.join(' · ')}</dd></div>`
}

function renderPlatformsRow(platforms, esc) {
  if (!platforms.length) return ''
  const items = platforms.map(p => {
    const live = p.live ? `<span class="hs-card-live" data-tone="live">●${p.viewers ? esc(String(p.viewers)) : ''}</span>` : ''
    const verified = p.verified ? '<span class="hs-card-verified">✓</span>' : ''
    return `<a class="hs-card-plat-link" data-tone="${esc(p.key)}" href="${esc(p.url)}" target="_blank" rel="noopener" title="${esc(p.login)}">${hkShort(p.key, esc)}${verified}${live}</a>`
  }).join('')
  return `<div class="hs-card-platforms">${items}</div>`
}

function renderSheetValue(k, value, esc, fmtTime) {
  if (k === 'acctage') return esc(hsCardAccountAge(value) || '')
  if (value && typeof value === 'object') {
    if ('text' in value) return relRow(esc, fmtTime, value)
    if ('count' in value) {
      const sample = (value.sample || []).slice(0, 3)
      const avatars = sample.map(s => `<img class="hs-card-mutual-av" src="${esc(s.avatar_url || '/anon.webp')}" alt="${esc(s.display_name || s.username || '')}" title="${esc(s.display_name || s.username || '')}">`).join('')
      const more = value.count > sample.length ? ` +${value.count - sample.length}` : ''
      return `${avatars}<span class="hs-card-mutual-n">${esc(String(value.count))}${esc(more)}</span>`
    }
  }
  return esc(String(value))
}

function renderSheet(sheet, esc, fmtTime) {
  if (!sheet.length) return ''
  const rows = sheet.map(r => `<div class="hs-card-sheet-row" data-tone="${esc(r.tone || '')}"><dt>${esc(r.label)}</dt><dd>${renderSheetValue(r.k, r.value, esc, fmtTime)}</dd></div>`).join('')
  return `<dl class="hs-card-sheet">${rows}</dl>`
}

function renderChannel(channel, esc, fmtTime) {
  if (!channel) return ''
  const rows = channel.rows.map(r => {
    let value
    if (r.months != null) value = esc(hsCardTenureMonths(r.months) || '')
    else if (r.notFollowing) value = 'not following'
    else if (r.since) value = esc(fmtTime(r.since))
    else value = ''
    return `<div class="hs-card-sheet-row" data-tone="${esc(r.tone || '')}"><dt>${esc(r.label)}</dt><dd>${esc(channel.name)} ${value}</dd></div>`
  }).join('')
  return `<dl class="hs-card-sheet hs-card-channel-sheet">${rows}</dl>`
}

function renderNote(note, esc) {
  if (!note) return ''
  const text = note.text ? `<span class="hs-card-note-text">${esc(note.text)}</span>` : ''
  const btn = note.canEdit ? `<button type="button" class="hs-card-note-edit" data-hs-card-action="note-edit">${hk('edit', esc)}</button>` : ''
  return `<div class="hs-card-sheet-row" data-tone="note"><dt>note</dt><dd>${text}${btn}</dd></div>`
}

function renderRecent(recent, esc, links) {
  if (!recent || !recent.length) return ''
  const rows = [...recent].reverse().map(r => {
    const ts = hsCardLogTime(r.timestamp)
    const tsEl = r.permalink
      ? `<a class="hs-card-log-ts" href="${esc(r.permalink)}" target="_blank" rel="noopener">${esc(ts)}</a>`
      : `<span class="hs-card-log-ts">${esc(ts)}</span>`
    const ch = r.channel ? `<span class="hs-card-log-ch">#${esc(r.channel)}</span>` : ''
    const body = r.messageHtml || esc(r.message)
    return `<div class="hs-card-log-row">${tsEl}${ch}<span class="hs-card-log-body">${body}</span></div>`
  }).join('')
  const all = links?.logsSearchUrl ? `<a class="hs-card-logs-all" href="${esc(links.logsSearchUrl)}" target="_blank" rel="noopener">all →</a>` : ''
  return `<div class="hs-card-recent"><div class="hs-card-recent-head"><span>recent</span>${all}</div><div class="hs-card-recent-list">${rows}</div></div>`
}

function renderTopEmotes(emotes, esc) {
  if (!emotes || !emotes.length) return ''
  const tiles = emotes.map(e => `<span class="hs-card-emote" title="${esc(e.name)} · ${esc(String(e.uses))}×"><img src="${esc(e.url)}" alt="${esc(e.name)}" loading="lazy"><span class="hs-card-emote-n">${esc(String(e.uses))}</span></span>`).join('')
  return `<div class="hs-card-emotes">${tiles}</div>`
}

function renderActions(actions, esc, userId) {
  if (!actions || !actions.length) return ''
  const uid = userId != null ? ` data-user-id="${esc(String(userId))}"` : ''
  const btns = actions.map(a => {
    const label = a.key === 'follow' ? (a.following ? 'unfollow' : 'follow') : a.key === 'block' ? (a.blocked ? 'unblock' : 'block') : HOTKEY_LABEL[a.key] || a.key
    const active = (a.key === 'follow' && a.following) || (a.key === 'block' && a.blocked) ? ' hs-card-active' : ''
    return `<button type="button" class="hs-card-action${active}" data-hs-card-action="${esc(a.key)}"${uid}>${hk(label, esc)}</button>`
  }).join('')
  return `<div class="hs-card-actions">${btns}</div>`
}

function renderSocials(socials, esc) {
  if (!socials?.length) return ''
  const items = socials
    .map((s) =>
      s.href
        ? `<a href="${esc(s.href)}" target="_blank" rel="noopener">${esc(s.label)}</a>`
        : `<span>${esc(s.label)}</span>`,
    )
    .join('')
  return `<div class="hs-card-socials">${items}</div>`
}

// Host-only mod actions (ctx.modGroups — see card-model.js doc). Pure escaped
// HTML with data-hs-card-mod-* attributes; the host wires real handlers via
// event delegation on the card root, same discipline as the actions row.
function renderMod(mod, esc) {
  if (!mod?.groups?.length) return ''
  const reason = `<input type="text" class="hs-card-mod-reason" placeholder="reason (optional)" maxlength="200">`
  const groups = mod.groups
    .map((g) => {
      const chLabel = g.platform === 'kick' ? `#${g.channel} (kick)` : `#${g.channel}`
      const attrs = (extra) =>
        `data-hs-card-mod-channel="${esc(g.channel)}" data-hs-card-mod-platform="${esc(g.platform)}" data-hs-card-mod-login="${esc(g.login)}"${g.msgId ? ` data-hs-card-mod-msg-id="${esc(g.msgId)}"` : ''}${extra}`
      const actionBtns = (g.actions || [])
        .map(
          (a) =>
            `<button type="button" class="hs-card-mod-btn${a.danger ? ' hs-card-mod-btn-danger' : ''}" ${attrs(` data-hs-card-mod-action="${esc(a.action)}"${a.durationSec ? ` data-hs-card-mod-duration="${esc(String(a.durationSec))}"` : ''}`)}${a.disabled ? ' disabled' : ''} title="${esc(a.title || '')}">${esc(a.label)}</button>`,
        )
        .join('')
      const roleBtns = (g.roleActions || [])
        .map(
          (a) =>
            `<button type="button" class="hs-card-mod-btn" data-hs-card-mod-role="${esc(a.kind)}" data-hs-card-mod-add="${a.add ? '1' : '0'}" data-hs-card-mod-channel="${esc(g.channel)}" title="${esc(a.title || '')}">${esc(a.label)}</button>`,
        )
        .join('')
      return `<div class="hs-card-mod-group"><div class="hs-card-mod-ch">${esc(chLabel)}</div>${actionBtns ? `<div class="hs-card-mod-row">${actionBtns}</div>` : ''}${roleBtns ? `<div class="hs-card-mod-row">${roleBtns}</div>` : ''}</div>`
    })
    .join('')
  return `<div class="hs-card-mod">${reason}${groups}</div>`
}

function renderFooterLinks(model, esc, hideLogsLink) {
  const links = []
  if (model.links.profileUrl) links.push(`<a href="${esc(model.links.profileUrl)}" target="_blank" rel="noopener">profile →</a>`)
  if (!hideLogsLink && model.links.logsUrl) links.push(`<a href="${esc(model.links.logsUrl)}" target="_blank" rel="noopener">logs →</a>`)
  if (model.links.chatterUrl) links.push(`<a href="${esc(model.links.chatterUrl)}" target="_blank" rel="noopener">stats →</a>`)
  if (!links.length) return ''
  return `<div class="hs-card-links">${links.join('')}</div>`
}

function renderProfile(
  model,
  { esc, variant, fmtTime, renderBio, renderPlusBadge, paintColor, renderBadges, clickable, hideLogsLink },
) {
  const peek = variant === 'peek'
  const cls = [`hs-card`, `hs-card-${esc(variant)}`, model.isOwnProfile ? 'hs-card-own' : ''].filter(Boolean).join(' ')
  const nameColor = paintColor ? paintColor(model.color) : model.color
  // Whole-card navigation (search results) — click-delegation.js's
  // setupProfileCardClickHandler matches this exact attribute contract.
  // tabindex/role make it a real Tab stop with Enter/Space activation
  // (same handler) — a hover-only CSS invert with nothing focusable to
  // trigger it was half a feature.
  const clickAttrs = (clickable && model.identity.userId != null)
    ? ` data-user-id="${esc(String(model.identity.userId))}" data-clickable="true" tabindex="0" role="link"${model.identity.platform ? ` data-platform="${esc(model.identity.platform)}" data-username="${esc(model.identity.login)}"` : ''}${model.links.profileUrl ? ` data-profile-url="${esc(model.links.profileUrl)}"` : ''}`
    : ''
  // Same CSSOM-at-mount discipline as data-color/paintColor above — the host
  // reads this and calls el.style.setProperty('--hs-card-accent', ...) once
  // it has a value (often resolved asynchronously, after a banner fetch).
  const accentAttr = ` data-accent="${esc(model.accent || '')}"`

  const plusBadge = model.plusSince
    ? (renderPlusBadge ? renderPlusBadge(model.plusSince) : `<span class="hs-card-plus" title="plus">+</span>`)
    : ''
  const flair = model.flair
    ? `<img class="hs-card-flair" src="${esc(model.flair.badgeUrl)}" alt="${esc(model.flair.broadcasterLogin)} sub" title="${esc(model.flair.broadcasterLogin)} sub" width="16" height="16">`
    : ''
  const ember = model.ember ? `<span class="hs-card-ember" title="${esc(model.ember.name)}">🜂</span>` : ''
  const pronouns = model.pronouns ? `<span class="hs-card-pronouns">${esc(model.pronouns)}</span>` : ''

  const identityRow = `
    <div class="hs-card-identity">
      <img class="hs-card-avatar" src="${esc(model.avatarUrl)}" alt="${esc(model.displayName)}" data-imgerr-src="/anon.webp">
      <strong class="hs-card-name" data-color="${esc(nameColor)}">${esc(model.displayName)}</strong>
      ${pronouns}${plusBadge}${flair}${ember}
    </div>`

  // Host-only chat-badge chip row (native + 7TV/BTTV/FFZ/Chatterino) — see
  // opts.renderBadges doc. Shown on peek too (the old hover tooltip had it).
  const badgesInner = renderBadges ? renderBadges(model) : ''
  const badgesHtml = badgesInner ? `<div class="hs-card-badges">${badgesInner}</div>` : ''

  // Own-profile bio carries the inline-edit affordance (click-delegation.js
  // setupBioEditHandler) — kept on its legacy class names (.profile-bio-line/
  // .profile-bio-text/.bio-edit-trigger) since that handler is DOM-structure
  // generic and this is the lowest-risk reuse, same rationale as the
  // follow/block/report action classes below.
  const bioInner = model.bio ? (renderBio ? renderBio(model.bio) : esc(model.bio)) : ''
  const bioHtml = model.isOwnProfile
    ? `<div class="hs-card-bio profile-bio-line"><span class="profile-bio-text" data-userid="${esc(String(model.identity.userId ?? ''))}">${model.bio ? bioInner : '<span class="bio-edit-trigger">add bio</span>'}</span></div>`
    : model.bio ? `<div class="hs-card-bio">${bioInner}</div>` : ''

  const platformsHtml = renderPlatformsRow(model.platforms, esc)

  if (peek) {
    return `<div class="${cls}"${clickAttrs}${accentAttr}>
      <div class="hs-card-hero" data-banner-pending="1" data-username="${esc(model.identity.login || '')}" data-platform="${esc(model.identity.platform || '')}"><div class="hs-card-hero-img"></div><div class="hs-card-hero-scrim"></div></div>
      <div class="hs-card-body">
        ${identityRow}
        ${badgesHtml}
        ${platformsHtml}
        ${bioHtml}
        ${renderSheet(model.sheet, esc, fmtTime)}
      </div>
    </div>`
  }

  return `<div class="${cls}"${clickAttrs}${accentAttr}>
    ${closeButtonHtml(variant)}
    <div class="hs-card-hero" data-banner-pending="1" data-username="${esc(model.identity.login || '')}" data-platform="${esc(model.identity.platform || '')}"><div class="hs-card-hero-img"></div><div class="hs-card-hero-scrim"></div></div>
    <div class="hs-card-body">
      ${identityRow}
      ${badgesHtml}
      ${platformsHtml}
      ${bioHtml}
      ${renderSocials(model.socials, esc)}
      ${renderSheet(model.sheet, esc, fmtTime)}
      ${renderChannel(model.channel, esc, fmtTime)}
      ${model.corpus ? `<dl class="hs-card-sheet">${renderCorpusRow(model.corpus, esc)}</dl>` : ''}
      ${renderNote(model.note, esc)}
      ${renderTopEmotes(model.topEmotes, esc)}
      ${renderFooterLinks(model, esc, hideLogsLink)}
      ${renderRecent(model.recent, esc, model.links)}
      ${renderMod(model.mod, esc)}
    </div>
    ${renderActions(model.actions, esc, model.identity.userId)}
  </div>`
}
