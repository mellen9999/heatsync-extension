// Cross-platform per-user notes — a private note you write about a chatter that
// follows them across Twitch / Kick / YouTube via the identity graph. Chatterino
// has local single-platform notes; this is the only implementation that keys a
// note to a person, not a handle: note a Twitch user and it surfaces on their
// Kick/YouTube identity too, and syncs across your devices (server sync = future).
//
// Self-contained (mirrors filter-rules.js / automod.js): no imports, functions
// become globals in the concatenated bundle, exports stripped by build.js and
// used only by the unit test. Persistence = chrome.storage.local under one
// versioned key, in a shape a server endpoint can accept verbatim later.

const HS_NOTES_KEY = 'hs_user_notes_v1'
const HS_NOTE_MAX = 2000 // chars — bounded so storage can't be griefed by a paste

// module scope resets on re-injection, so a fresh instance re-registers
// after the old one's teardown; window-scope survives takeover and leaves
// handlers dead until hard refresh
const _onceGuardsUserNotes = {}

// ── in-memory model (source of truth at runtime; storage is the mirror) ─────────
// notes:  canonicalKey -> { text, updatedAt }
// index:  aliasHandle  -> canonicalKey   (every known alias points at one note)
// The index is what makes a note follow a person: when the same chatter is noted
// from a second platform whose alias set overlaps an existing note, both resolve
// to the same canonical key and merge instead of forking.
let _hsnNotes = new Map()
let _hsnIndex = new Map()
let _hsnLoaded = false
let _hsnLoadPromise = null // resolves once the initial storage read completes

function _hsnHasStorage() {
  return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local
}

// Resolve a chatter to their lowercased alias set. Sync path (getUserAliases) for
// render/indicator; the async path (expandUserAliases, also pulls the server
// identity graph) is used on save so a note captures the fullest alias set known.
function _hsnAliasesSync(username, platform) {
  const u = String(username || '').toLowerCase()
  if (!u) return []
  if (typeof getUserAliases === 'function') {
    try {
      const a = getUserAliases(u, platform)
      if (Array.isArray(a) && a.length) return [...new Set(a.map((x) => String(x).toLowerCase()))]
    } catch {}
  }
  return [u]
}

async function _hsnAliasesAsync(username, platform) {
  const u = String(username || '').toLowerCase()
  if (!u) return []
  if (typeof expandUserAliases === 'function') {
    try {
      const a = await expandUserAliases(u, platform)
      if (Array.isArray(a) && a.length) return [...new Set(a.map((x) => String(x).toLowerCase()))]
    } catch {}
  }
  return _hsnAliasesSync(u, platform)
}

// Canonical key for a set of aliases: reuse an existing note's key if any alias
// already maps to one (so we merge), else the lexicographically first alias
// (stable regardless of which platform the note was created from).
function _hsnCanonicalFor(aliases) {
  for (const a of aliases) {
    const c = _hsnIndex.get(a)
    if (c && _hsnNotes.has(c)) return c
    if (_hsnNotes.has(a)) return a // note saved before an index existed
  }
  return aliases.slice().sort()[0] || null
}

function _hsnPersist() {
  if (!_hsnHasStorage()) return
  const payload = {
    notes: Object.fromEntries(_hsnNotes),
    index: Object.fromEntries(_hsnIndex),
  }
  try {
    chrome.storage.local.set({ [HS_NOTES_KEY]: payload }, () => {
      if (chrome.runtime?.lastError) {
        try {
          showToast(t('mc_usernotes_save_failed'), 'error')
        } catch {}
      }
    })
  } catch {}
}

function _hsnLoad() {
  if (_hsnLoadPromise) return _hsnLoadPromise
  if (!_hsnHasStorage()) {
    _hsnLoaded = true
    _hsnLoadPromise = Promise.resolve()
    return _hsnLoadPromise
  }
  _hsnLoadPromise = new Promise((resolve) => {
    try {
      // 'hs_user_notes' (no _v1) is the retired profile-card-local store —
      // migrated below on first load, then removed.
      chrome.storage.local.get([HS_NOTES_KEY, 'hs_user_notes'], (d) => {
        const raw = d?.[HS_NOTES_KEY]
        if (raw && typeof raw === 'object') {
          if (raw.notes && typeof raw.notes === 'object') {
            for (const [k, v] of Object.entries(raw.notes)) {
              if (v && typeof v.text === 'string') _hsnNotes.set(k, { text: v.text, updatedAt: v.updatedAt || 0 })
            }
          }
          if (raw.index && typeof raw.index === 'object') {
            for (const [k, v] of Object.entries(raw.index)) if (typeof v === 'string') _hsnIndex.set(k, v)
          }
        }
        // One-time legacy migration. v1 wins on conflict (it's what the user
        // has been editing since the popover shipped); a legacy-only username
        // is adopted as its own canonical. The old key is removed ONLY after
        // the merged snapshot persists — a failed write must not lose notes.
        const legacy = d?.hs_user_notes
        if (legacy && typeof legacy === 'object') {
          let migrated = 0
          for (const [k, v] of Object.entries(legacy)) {
            const key = String(k).toLowerCase()
            if (!v || typeof v.text !== 'string' || !v.text.trim()) continue
            if (_hsnNotes.has(key) || _hsnNotes.has(_hsnIndex.get(key) || '')) continue
            _hsnNotes.set(key, { text: v.text.slice(0, 500), updatedAt: v.ts || Date.now() })
            _hsnIndex.set(key, key)
            migrated++
          }
          const _removeLegacy = () => {
            try {
              chrome.storage.local.remove('hs_user_notes', () => void chrome.runtime?.lastError)
            } catch {}
          }
          if (migrated) {
            const payload = { notes: Object.fromEntries(_hsnNotes), index: Object.fromEntries(_hsnIndex) }
            try {
              chrome.storage.local.set({ [HS_NOTES_KEY]: payload }, () => {
                if (!chrome.runtime?.lastError) _removeLegacy()
              })
            } catch {}
          } else {
            // Nothing worth keeping (empty/all-duplicates) — safe to drop now.
            _removeLegacy()
          }
        }
        _hsnLoaded = true
        resolve()
      })
    } catch {
      _hsnLoaded = true
      resolve()
    }
  })
  return _hsnLoadPromise
}

// Cross-tab merge — chrome.storage.local has no per-key transactions, and
// _hsnPersist writes a full snapshot of THIS tab's model. Without this, a tab
// that saves a note before ever loading another tab's note persists a payload
// missing that note, erasing it on the other tab's next read. Mirrors
// mentions.js's onChanged wiring, adapted to merge a Map: last-write-wins per
// note by updatedAt, and a remote note this tab has never seen is always
// adopted. Deliberately never deletes a local note just because it's absent
// from a remote payload — that payload only reflects the OTHER tab's (possibly
// partial) view, so treating absence as "deleted" would just relocate the
// wipe. (Trade-off: a delete can be resurrected by a tab that loaded the note
// before the delete and saves later — no tombstone in the wire format yet.)
if (typeof window !== 'undefined' && _hsnHasStorage() && !_onceGuardsUserNotes.notesOnChangedWired) {
  _onceGuardsUserNotes.notesOnChangedWired = true
  cleanup.addListener(chrome.storage.onChanged, (changes, area) => {
    if (area !== 'local' || !changes[HS_NOTES_KEY]) return
    const raw = changes[HS_NOTES_KEY].newValue
    if (!raw || typeof raw !== 'object') return
    if (raw.notes && typeof raw.notes === 'object') {
      for (const [k, v] of Object.entries(raw.notes)) {
        if (!v || typeof v.text !== 'string') continue
        const local = _hsnNotes.get(k)
        if (!local || (v.updatedAt || 0) >= (local.updatedAt || 0)) {
          _hsnNotes.set(k, { text: v.text, updatedAt: v.updatedAt || 0 })
        }
      }
    }
    if (raw.index && typeof raw.index === 'object') {
      for (const [k, v] of Object.entries(raw.index)) if (typeof v === 'string') _hsnIndex.set(k, v)
    }
  })
}

// ── public API ──────────────────────────────────────────────────────────────

/** Sync note lookup for the current chatter (uses local alias set). null if none. */
function hsNoteGet(username, platform) {
  const aliases = _hsnAliasesSync(username, platform)
  for (const a of aliases) {
    const c = _hsnIndex.get(a)
    if (c && _hsnNotes.has(c)) return _hsnNotes.get(c)
    if (_hsnNotes.has(a)) return _hsnNotes.get(a)
  }
  return null
}

/** Cheap boolean for indicators / menu labels. */
function hsNoteHas(username, platform) {
  const n = hsNoteGet(username, platform)
  return !!n?.text
}

// ── server sync (logged-in only) ───────────────────────────────────────────
// PUT/GET /api/user-notes/:profileId — the SAME note a server-authoritative
// card (site, or this ext once logged in) reads via /api/card's note part
// (server/routes/card.ts calls the identical fetchUserNote). `profileId`
// must be a real heatsync user id — kick_<id>/yt_<id> synth ids (unregistered
// chatters, see pcSynthFromKickEnrich/pcSynthFromYtContext in profile-card.js)
// have no server-side note row to read or write, so those stay local-only,
// same as today.
function hsNoteServerEligible(profileId) {
  return !!profileId && !/^(kick|yt)_/.test(String(profileId))
}

async function hsNoteFetchServer(profileId) {
  if (!hsNoteServerEligible(profileId) || typeof apiFetch !== 'function') return null
  try {
    const resp = await apiFetch(`/api/user-notes/${encodeURIComponent(profileId)}`, { auth: true })
    if (resp?.ok && resp.data) return resp.data.note || ''
  } catch {}
  return null // network/auth failure — distinct from "" (a real, empty server note)
}

async function hsNotePutServer(profileId, text) {
  if (!hsNoteServerEligible(profileId) || typeof apiFetch !== 'function') return false
  try {
    const resp = await apiFetch(`/api/user-notes/${encodeURIComponent(profileId)}`, {
      method: 'PUT',
      auth: true,
      body: { note: text },
    })
    return !!resp?.ok
  } catch {
    return false
  }
}

/**
 * Called once per card open (logged in + a real profileId only). Server is
 * the source of truth once logged in: a server note overwrites the local
 * cache; an EMPTY server note with a local-only, never-synced note left over
 * uploads it once (the one-time local→server migration). A fetch failure
 * touches nothing — never clobber a good local note because the network
 * hiccuped, and `serverSynced` stays false so the next open retries.
 */
async function hsNoteSyncOnOpen(username, platform, profileId) {
  if (!(typeof hsAuthToken !== 'undefined' && hsAuthToken) || !hsNoteServerEligible(profileId)) return false
  await _hsnLoad()
  const serverText = await hsNoteFetchServer(profileId)
  if (serverText === null) return false // fetch failed — local note (if any) is untouched
  const aliases = await _hsnAliasesAsync(username, platform)
  if (!aliases.length) return false
  const local = hsNoteGet(username, platform)
  if (serverText) {
    if (local?.text !== serverText || !local?.serverSynced) {
      const canonical = _hsnCanonicalFor(aliases) || aliases.slice().sort()[0]
      _hsnNotes.set(canonical, { text: serverText, updatedAt: _hsnNow(), serverSynced: true, profileId })
      for (const a of aliases) _hsnIndex.set(a, canonical)
      _hsnPersist()
      return true
    }
    return false
  }
  if (local?.text && !local.serverSynced) {
    const ok = await hsNotePutServer(profileId, local.text)
    if (ok) {
      local.serverSynced = true
      local.profileId = profileId
      _hsnPersist()
    }
    return false // text didn't change, just its sync state — no repaint needed
  }
  return false
}

/**
 * Create/update a note. Async so it can pull the fullest alias set and — when
 * logged in with a real profileId — write through to the server. The local
 * write always happens regardless of the server call's outcome: a failed PUT
 * never loses the note, it just leaves `serverSynced: false` so the next
 * hsNoteSyncOnOpen (or edit) retries it. Empty text deletes.
 */
async function hsNoteSave(username, platform, text, nowMs, profileId) {
  await _hsnLoad() // never build a snapshot from a model the initial read hasn't populated yet
  const clean = String(text == null ? '' : text)
    .slice(0, HS_NOTE_MAX)
    .trim()
  const aliases = await _hsnAliasesAsync(username, platform)
  if (!aliases.length) return null
  if (!clean) return hsNoteDelete(username, platform, profileId)
  const canonical = _hsnCanonicalFor(aliases) || aliases.slice().sort()[0]
  let serverSynced = false
  if (typeof hsAuthToken !== 'undefined' && hsAuthToken && hsNoteServerEligible(profileId)) {
    serverSynced = await hsNotePutServer(profileId, clean)
  }
  const rec = { text: clean, updatedAt: typeof nowMs === 'number' ? nowMs : _hsnNow(), serverSynced, profileId }
  _hsnNotes.set(canonical, rec)
  for (const a of aliases) _hsnIndex.set(a, canonical)
  _hsnPersist()
  return rec
}

/** Delete a note and every alias pointer at it. Best-effort server delete too (empty PUT). */
async function hsNoteDelete(username, platform, profileId) {
  await _hsnLoad()
  const aliases = await _hsnAliasesAsync(username, platform)
  const canonical = _hsnCanonicalFor(aliases)
  if (typeof hsAuthToken !== 'undefined' && hsAuthToken && hsNoteServerEligible(profileId)) {
    await hsNotePutServer(profileId, '') // best-effort — local delete proceeds regardless of outcome
  }
  if (!canonical) return false
  _hsnNotes.delete(canonical)
  for (const [a, c] of [..._hsnIndex]) if (c === canonical) _hsnIndex.delete(a)
  _hsnPersist()
  return true
}

function _hsnNow() {
  // Date.now is fine in the extension runtime; guarded only so the module stays
  // importable in odd sandboxes. Tests pass an explicit nowMs for determinism.
  try {
    return Date.now()
  } catch {
    return 0
  }
}

// ── editor popover ────────────────────────────────────────────────────────────
// One small square terminal-styled popover, reused by the context menu and the
// profile-card "edit" button. Autofocus, char counter, debounced auto-save,
// esc / outside-click to close (saves on close). No modal, no framework.
function hsNoteOpenEditor(username, platform, x, y, onSaved, profileId) {
  if (typeof document === 'undefined') return
  document.getElementById('hs-note-editor')?.remove()
  const existing = hsNoteGet(username, platform)
  const box = document.createElement('div')
  box.id = 'hs-note-editor'
  box.className = 'hs-note-editor'
  box.tabIndex = -1

  const head = document.createElement('div')
  head.className = 'hs-note-editor-head'
  head.textContent = `note · ${String(username || '').toLowerCase()}`
  box.appendChild(head)

  const ta = document.createElement('textarea')
  ta.className = 'hs-note-editor-ta'
  ta.rows = 4
  ta.maxLength = HS_NOTE_MAX
  ta.placeholder = 'private note — only you see this. follows them across platforms.'
  ta.value = existing?.text || ''
  ta.spellcheck = false
  box.appendChild(ta)

  const foot = document.createElement('div')
  foot.className = 'hs-note-editor-foot'
  const status = document.createElement('span')
  status.className = 'hs-note-editor-status'
  status.textContent = 'esc to close'
  const del = document.createElement('button')
  del.className = 'hs-note-editor-del'
  del.textContent = 'delete'
  del.style.visibility = existing?.text ? '' : 'hidden'
  foot.appendChild(status)
  foot.appendChild(del)
  box.appendChild(foot)

  document.body.appendChild(box)
  // Position like showHsCtxMenu — flip near viewport edges.
  box.style.visibility = 'hidden'
  box.style.left = '0px'
  box.style.top = '0px'
  const bw = box.offsetWidth,
    bh = box.offsetHeight
  const vw = window.innerWidth,
    vh = window.innerHeight
  const px = typeof x === 'number' ? x : Math.round(vw / 2 - bw / 2)
  const py = typeof y === 'number' ? y : Math.round(vh / 2 - bh / 2)
  box.style.left = `${px + bw + 8 > vw ? Math.max(4, px - bw) : Math.min(px, vw - bw - 4)}px`
  box.style.top = `${py + bh + 8 > vh ? Math.max(4, py - bh) : Math.min(py, vh - bh - 4)}px`
  box.style.visibility = ''

  let saveTimer = null
  let dirty = false
  const flush = async () => {
    if (!dirty) return
    dirty = false
    await hsNoteSave(username, platform, ta.value, undefined, profileId)
    del.style.visibility = ta.value.trim() ? '' : 'hidden'
    status.textContent = 'saved · esc to close'
    if (typeof onSaved === 'function') {
      try {
        onSaved()
      } catch {}
    }
  }
  ta.addEventListener('input', () => {
    dirty = true
    status.textContent = 'saving…'
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(flush, 350)
  })
  del.addEventListener('click', async () => {
    ta.value = ''
    dirty = false
    await hsNoteDelete(username, platform, profileId)
    if (typeof onSaved === 'function') {
      try {
        onSaved()
      } catch {}
    }
    dismiss()
  })

  function dismiss() {
    if (saveTimer) clearTimeout(saveTimer)
    flush()
    box.remove()
    document.removeEventListener('mousedown', outside, true)
    document.removeEventListener('keydown', keyHandler, true)
  }
  function outside(ev) {
    if (!box.contains(ev.target)) dismiss()
  }
  function keyHandler(ev) {
    if (ev.key === 'Escape') {
      ev.preventDefault()
      dismiss()
    }
  }
  setTimeout(() => {
    document.addEventListener('mousedown', outside, true)
    document.addEventListener('keydown', keyHandler, true)
    try {
      ta.focus()
      ta.setSelectionRange(ta.value.length, ta.value.length)
    } catch {}
  }, 0)
}

/**
 * Build the profile-card "notes" section (read preview + edit button).
 * `profileId` (the heatsync user id — data.id on the card's profile, absent
 * for kick/yt synth profiles) enables server sync: logged in + a real id →
 * fetches the server note once on open (adopting it, or uploading a
 * local-only note that's never been synced) and repaints when that resolves.
 */
function hsNoteRenderCardSection(username, platform, mkSection, profileId) {
  if (typeof document === 'undefined') return null
  const make = typeof mkSection === 'function' ? mkSection : typeof pcMakeSection === 'function' ? pcMakeSection : null
  const sec = make ? make('notes') : document.createElement('div')
  if (!make) sec.className = 'hs-pcard-section'
  sec.classList.add('hs-pcard-notes')

  const body = document.createElement('div')
  body.className = 'hs-pcard-note-body'
  const btn = document.createElement('button')
  btn.className = 'hs-pcard-note-edit'

  const paint = () => {
    const n = hsNoteGet(username, platform)
    body.textContent = n?.text || 'no note yet'
    body.classList.toggle('hs-pcard-note-empty', !n?.text)
    btn.textContent = n?.text ? 'edit' : 'add note'
  }
  btn.addEventListener('click', (e) => {
    const r = btn.getBoundingClientRect()
    hsNoteOpenEditor(username, platform, e?.clientX || r.left, e?.clientY || r.bottom, paint, profileId)
  })
  paint()
  hsNoteSyncOnOpen(username, platform, profileId).then((changed) => {
    if (changed && sec.isConnected) paint()
  })
  sec.appendChild(body)
  sec.appendChild(btn)
  return sec
}

// Kick off a load at bundle init (no-op in tests where chrome is absent).
_hsnLoad()

// Test-only reset so specs start from a clean model.
function _hsNoteResetForTest(reload = false) {
  _hsnNotes = new Map()
  _hsnIndex = new Map()
  // reload=true re-arms _hsnLoad so tests can exercise the storage-read path
  // (incl. the legacy hs_user_notes migration) against an injected fake
  // chrome.storage; default keeps the old "already loaded" behavior.
  _hsnLoaded = !reload
  _hsnLoadPromise = reload ? null : Promise.resolve()
}

export {
  _hsNoteResetForTest,
  HS_NOTE_MAX,
  hsNoteDelete,
  hsNoteFetchServer,
  hsNoteGet,
  hsNoteHas,
  hsNoteOpenEditor,
  hsNotePutServer,
  hsNoteRenderCardSection,
  hsNoteSave,
  hsNoteServerEligible,
  hsNoteSyncOnOpen,
}
