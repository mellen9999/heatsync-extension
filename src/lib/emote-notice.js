// What the extension says when you add, remove, rename, swap, block or unblock an emote of yours.
//
// One rule for every heatsync app (shared/emote-notice.vectors.json, a byte copy of the site's):
// the server's answer picks the line, the line is short and plain, and the panel, the picker and
// the native page all say it through here. Each surface asks its own question of the answer
// (did the background say success? what status did the server give?), then comes here for the id
// and the words; none of them words an emote result itself, and none prints the server's text.
//
// `status` is the HTTP status of the answer, 0 when there was none (offline, timed out, blocked).
// The background carries it on every emote answer (`{ success, status, slot?, error }`); `error`
// stays for the log, it never reaches a notice.
//
// Content scripts and the panel bundle this file (build.js LIB_ORDER); the background cannot
// import it, so it does not word anything: it only answers with the status.

/** the catalog key (src/_locales) that says each id of the contract, by id */
export const EMOTE_NOTICE_KEYS = {
  'add.ok': 'mc_emote_added_slot',
  'add.login': 'hsbtn_login_add',
  'add.dupe': 'mc_emote_add_dupe',
  'add.full': 'mc_emote_add_full',
  'add.busy': 'mc_emote_add_busy',
  'add.failed': 'mc_emote_add_failed',
  'remove.ok': 'cs_removed',
  'remove.failed': 'mc_emote_remove_failed',
  'manage.login': 'cs_login_manage',
  'rename.ok': 'hsbtn_renamed_to',
  'rename.failed': 'hsbtn_rename_failed',
  'swap.ok': 'mc_emote_swapped',
  'swap.kept': 'mc_emote_swap_upload',
  'swap.failed': 'mc_emote_swap_failed',
  'block.ok': 'content_toast_blocked',
  'block.failed': 'content_toast_block_failed',
  'unblock.ok': 'content_toast_unblocked',
  'unblock.failed': 'content_toast_unblock_failed',
}

// a refusal with a plainer reason than "it failed" (every other status is the op's own `.failed`).
// a slot that is already empty is a remove that worked, and so is a block that is already gone.
// Every op the contract has is a key here, so an op that is not one is told apart from one that
// simply has no special answers.
const EMOTE_BY_STATUS = {
  add: { 401: 'add.login', 403: 'add.full', 409: 'add.dupe', 503: 'add.busy' },
  remove: { 401: 'manage.login', 404: 'remove.ok' },
  rename: { 401: 'manage.login', 409: 'add.dupe' },
  swap: { 409: 'swap.kept' },
  block: {},
  unblock: { 404: 'unblock.ok' },
}

/**
 * Which line an answer says. `op` is add, remove, rename, swap, block or unblock; an op not in
 * the contract throws (a typo must not say "failed" quietly). A 2xx is `<op>.ok`, an answer the
 * table has no line for (or none at all, status 0) is `<op>.failed`.
 * @param {string} op
 * @param {number|null|undefined} status - HTTP status, 0/missing = no answer
 * @returns {string} an id of EMOTE_NOTICE_KEYS
 */
export function emoteNoticeId(op, status) {
  if (!Object.hasOwn(EMOTE_BY_STATUS, op)) throw new Error(`unknown op "${op}"`)
  if (status >= 200 && status < 300) return `${op}.ok`
  return EMOTE_BY_STATUS[op][status] || `${op}.failed`
}

/**
 * The notice for an answer: its id, its line in the viewer's language, and the kind of toast.
 * @param {string} op
 * @param {number|null|undefined} status
 * @param {string} name - the emote's name
 * @param {number} [slot] - the slot the server filed an add in (add.ok only)
 * @returns {{ id: string, text: string, kind: 'success'|'info'|'error' }}
 */
export function emoteNotice(op, status, name, slot) {
  const id = emoteNoticeId(op, status)
  let text
  if (id === 'add.ok') {
    // an add whose answer named no slot still says it worked: the plain line, not a made-up number
    text = Number.isInteger(slot) && slot >= 0 ? t(EMOTE_NOTICE_KEYS[id], [name, slot]) : t('mc_emote_added', [name])
  } else {
    text = t(EMOTE_NOTICE_KEYS[id], [name])
  }
  const kind = id.endsWith('.ok') ? 'success' : id.endsWith('.login') ? 'info' : 'error'
  return { id, text, kind }
}

/**
 * The notice for what the background answered a request with: `{ success, status, slot, error }`,
 * or nothing at all when the worker did not answer. Success is the answer saying so, whatever
 * else it carries; a refusal is its status; an answer with no status is no answer.
 * @param {string} op
 * @param {{ success?: boolean, status?: number, slot?: number }|null|undefined} resp
 * @param {string} name
 */
export function emoteNoticeOf(op, resp, name) {
  return emoteNotice(op, resp?.success ? 200 : (resp?.status ?? 0), name, resp?.slot)
}
