import { readFileSync } from 'node:fs'
import { hsCardHtml } from '../src/lib/card-render.js'
import { escapeHtml } from '../src/lib/utils.js'
import { t as enT } from './en-t.js'

export const CARD_L10N_SRC = readFileSync(new URL('../src/multichat/card-l10n.js', import.meta.url), 'utf8')

/**
 * card-l10n.js evaluated for real against the real (imported) renderer. It has no exports (it is
 * concatenated into the bundle), so the globals it reads are injected: `t` is the message lookup
 * under test, defaulting to the en catalog.
 */
export function makeCardL10n(t = enT) {
  return new Function(
    't',
    'escapeHtml',
    'hsCardHtml',
    `${CARD_L10N_SRC}\nreturn { hsCardHtmlL10n, cardL10nModel, cardL10nHtml, CARD_HTML_LITERALS, CARD_SHEET_LABEL, CARD_REL_LABEL, CARD_TYPE_VALUE, CARD_REL_TEXT }`,
  )(t, escapeHtml, hsCardHtml)
}
