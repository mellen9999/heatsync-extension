// sr-announce — how much of the chat a screen reader says out loud.
//
// The message list is role="log", which is a polite live region: every row that
// is appended gets read. On a busy channel that is a firehose nobody can follow,
// and role="log" was the only knob there was. Setting hs_sr_announce picks:
//
//   all       the log announces everything, as it always has (default)
//   mentions  the log goes quiet; a SECOND, separate polite region says only
//             the lines that @ you
//   off       nothing is announced. Chat is still all there to read by moving
//             through it (row mode, or the screen reader's own keys)
//
// The mentions region (#hs-mc-sr-mentions) is its own element, outside the
// message list, on purpose: the list is re-rendered and emptied all the time,
// and a live region that is wiped and rebuilt is not reliably announced. It is
// in the page from the start and only ever gets lines appended — one child per
// mention, so two mentions in the same breath are both said, in order.

const SR_MODES = ['all', 'mentions', 'off']
const SR_MENTION_KEEP = 5 // lines left in the region; older ones carry no information, only weight
const SR_MENTION_MAX_CHARS = 200

function srMode() {
  const v = getSetting('hs_sr_announce')
  return SR_MODES.includes(v) ? v : 'all'
}

/** The attribute string createOverlay puts on the log: the polite default is kept by saying nothing. */
function srLogLiveAttr(mode = srMode()) {
  return mode === 'all' ? '' : ' aria-live="off"'
}

/** Put the log into `mode` live. Also the setting's applier. */
function srApplyMode(mode = srMode()) {
  const log = document.getElementById('hs-mc-messages')
  if (log) {
    if (mode === 'all') log.removeAttribute('aria-live')
    else log.setAttribute('aria-live', 'off')
  }
  // leaving mentions mode: whatever is still in the region must not be read late
  if (mode !== 'mentions') document.getElementById('hs-mc-sr-mentions')?.replaceChildren()
}

/**
 * Say a mention. Called for every live mention (notifyMention is the one place
 * all three platforms funnel through); a no-op unless the mode is `mentions`.
 * @param {{user?: string, text?: string, channel?: string}} msg
 */
function srAnnounceMention(msg) {
  if (srMode() !== 'mentions') return
  const region = document.getElementById('hs-mc-sr-mentions')
  if (!region || !msg) return
  const text = String(msg.text || '')
  const clipped = text.length > SR_MENTION_MAX_CHARS ? `${text.slice(0, SR_MENTION_MAX_CHARS)}…` : text
  const line = document.createElement('div')
  line.textContent = t('mc_a11y_mention_said', [String(msg.user || ''), clipped])
  region.appendChild(line)
  while (region.children.length > SR_MENTION_KEEP) region.firstElementChild.remove()
}
