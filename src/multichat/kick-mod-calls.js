// kick mod calls — a kick channel's blocked words, message-filter levels and
// chatters list for its moderators. Kick has no public api for these; they are
// the web.kick.com routes kick's own dashboard calls (read out of its bundle,
// 2026-11), reached the way a ban is: background → a kick.com tab → fetch with
// the session bearer. The request shapes are built in the background
// (kickWebModRequest); this file only asks and reads the answer.
//
//   kmCall(slug, op, extra)  → {ok, data} | {ok:false, view, message}
//     op: words_get | words_edit {add, remove} | rules_get | rules_set {rules} | chatters
//   view: auth (not signed in to kick) | notmod | error
//
// Every reader returns null for an answer it does not recognise, so a changed
// kick reply shows "couldn't reach kick" instead of a wrong list — and a filter
// level is only ever written back from a complete, recognised read.

const KM_RULE_KEYS = ['sexual_content', 'hate_speech', 'violence', 'bullying', 'drugs', 'weapons', 'gibberish', 'spam']
const KM_RULE_MAX = { gibberish: 1, spam: 1 } // toggles; the rest are 0-3
const KM_ROLES = ['moderators', 'vips', 'ogs', 'bots']

function kmRuleMax(key) {
  return KM_RULE_MAX[key] ?? 3
}

// a failed relay answer → the view it implies + the words to show
function kmFail(res) {
  const err = String(res?.error || '')
  if (err === 'kick_not_logged_in' || err === 'no_kick_tab')
    return { ok: false, view: 'auth', message: t('mc_kms_signin') }
  if (res?.status === 401 || res?.status === 403) return { ok: false, view: 'notmod', message: t('mc_ms_not_mod') }
  if (err === 'no_channel' || err === 'missing params') return { ok: false, view: 'error', message: t('mc_kms_err') }
  return { ok: false, view: 'error', message: err || t('mc_kms_err') }
}

async function kmCall(slug, op, extra = {}) {
  const res = await safeSendMessage({ type: 'kick_mod_action', action: op, slug, ...extra })
  return res?.ok ? { ok: true, data: res.data } : kmFail(res)
}

// banned words: [{word, permission}] sorted for reading; null = unrecognised
function kmWords(data) {
  if (!Array.isArray(data?.words)) return null
  const out = []
  for (const w of data.words) {
    if (typeof w?.word !== 'string' || !w.word) return null
    out.push({ word: w.word, permission: typeof w.permission === 'string' ? w.permission : 'PUBLIC' })
  }
  return out.sort((a, b) => a.word.localeCompare(b.word))
}

// filter levels: all eight keys as whole numbers in range, or null
function kmRules(data) {
  const out = {}
  for (const k of KM_RULE_KEYS) {
    const n = data?.[k]
    if (!Number.isInteger(n) || n < 0 || n > kmRuleMax(k)) return null
    out[k] = n
  }
  return out
}

// chatters: [{login, name, role}] — each person once, a role over plain
function kmChatters(data) {
  if (!Array.isArray(data?.chatters)) return null
  const seen = new Map()
  const add = (list, role) => {
    for (const c of Array.isArray(list) ? list : []) {
      const login = String(c?.slug || '').toLowerCase()
      if (!login) continue
      const had = seen.get(login)
      if (had && !role) continue
      seen.set(login, { login, name: String(c?.username || login), role })
    }
  }
  for (const r of KM_ROLES) add(data[r], r.replace(/s$/, ''))
  add(data.chatters, '')
  const list = [...seen.values()]
  return { list, total: Number.isInteger(data.total_count) ? Math.max(data.total_count, list.length) : list.length }
}

// the words in a list that match a filter (case-insensitive substring of login or name)
function kmChattersVisible(list, filter) {
  const q = String(filter || '')
    .trim()
    .toLowerCase()
  return q ? list.filter((c) => `${c.login} ${c.name}`.toLowerCase().includes(q)) : list
}
