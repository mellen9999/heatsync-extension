// feed engage — upvote, bookmark and reaction chips on feed posts. Same routes
// and semantics as heatsync.org (votes.ts / bookmarks.ts / reactions.ts); every
// call rides apiFetch → the background api_fetch proxy, never a direct fetch.
//
//   upvote    ▲ beside the heat number (not on your own post — the server
//             refuses it). A second click removes it. Optimistic; the reply's
//             score + heat reconcile it, a failure rolls it back.
//   bookmark  row-menu item. State comes from ONE batched check per page of
//             posts, never per post.
//   reactions chip row under the post (emote + count, filled when mine). A chip
//             click toggles my reaction. The server only accepts emotes from the
//             reactor's own inventory, so a refusal surfaces as its toast.
//
// The state helpers are pure (they only touch the message object) so they test
// without a DOM.

const feedBookmarks = new Map() // base36_id → bookmarked?

function feedVoteOptimistic(m) {
  const snap = { user_vote: m.user_vote ?? null, vote_score: Number(m.vote_score) || 0 }
  const on = snap.user_vote !== 1
  m.user_vote = on ? 1 : null
  m.vote_score = Math.max(0, snap.vote_score + (on ? 1 : -1))
  return snap
}

function feedVoteReconcile(m, data) {
  m.user_vote = data.user_vote ?? null
  if (Number.isFinite(data.score)) m.vote_score = data.score
  if (Number.isFinite(data.heat)) m.heat = data.heat
}

function feedVoteRollback(m, snap) {
  m.user_vote = snap.user_vote
  m.vote_score = snap.vote_score
}

// Flip my reaction with `emoteId` on the message's cached list. Returns the
// previous list so a failed request can put it back.
function feedReactionApply(m, emoteId, on) {
  const prev = m.reactions || []
  const next = prev.map((r) => ({ ...r }))
  const hit = next.find((r) => r.emote_id === emoteId)
  if (hit) {
    hit.reacted = on
    hit.count = Math.max(0, (Number(hit.count) || 0) + (on ? 1 : -1))
  }
  m.reactions = next.filter((r) => r.count > 0)
  return prev
}

function feedBookmarkUnknown(ids) {
  const seen = new Set()
  const out = []
  for (const id of ids) {
    if (!id || seen.has(id) || feedBookmarks.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

// One POST per ≤100 unknown ids (the route's cap) — feed pages are 30-150.
async function feedBookmarksLoad(msgs) {
  if (!hsAuthToken) return
  const ids = feedBookmarkUnknown((msgs || []).map((m) => m.base36_id))
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100)
    const r = await apiFetch('/api/bookmarks/check', { method: 'POST', body: { message_ids: chunk } })
    const map = r?.ok ? r.data?.bookmarked : null
    if (!map) return
    for (const id of chunk) feedBookmarks.set(id, map[id] === true)
  }
}

function feedFail(r) {
  if (r?.status === 401) showToast(t('mc_social_login_first'), 'error')
  else showToast(r?.error || t('mc_feed_action_failed'), 'error')
}

function feedPostRows(id) {
  return document.querySelectorAll(`.hs-feed-msg[data-msg-id="${CSS.escape(id)}"]`)
}

function feedUpvoteHtml(m) {
  if (!hsAuthToken || isOwnFeedPost(m) || !m.base36_id) return ''
  const on = m.user_vote === 1
  return `<span class="hs-feed-stat hs-feed-up${on ? ' on' : ''}" role="button" aria-pressed="${on}" title="${escapeHtml(t(on ? 'mc_feed_upvote_remove' : 'mc_feed_upvote'))}">▲</span>`
}

function feedPaintVote(m) {
  for (const row of feedPostRows(m.base36_id)) {
    const up = row.querySelector('.hs-feed-up')
    if (up) {
      const on = m.user_vote === 1
      up.classList.toggle('on', on)
      up.setAttribute('aria-pressed', String(on))
      up.title = t(on ? 'mc_feed_upvote_remove' : 'mc_feed_upvote')
    }
    const n = row.querySelector('.hs-heat-n')
    if (n && Number.isFinite(Number(m.heat))) n.textContent = formatHeat(Number(m.heat))
  }
}

async function feedUpvote(m) {
  if (!hsAuthToken) return showToast(t('mc_social_login_first'), 'error')
  const snap = feedVoteOptimistic(m)
  feedPaintVote(m)
  const r = await apiFetch(`/api/messages/${encodeURIComponent(m.base36_id)}/vote`, {
    method: 'POST',
    body: { vote_type: 1 },
  })
  if (r?.ok && r.data?.success) feedVoteReconcile(m, r.data)
  else {
    feedVoteRollback(m, snap)
    feedFail(r)
  }
  feedPaintVote(m)
}

async function feedBookmarkToggle(id) {
  if (!hsAuthToken) return showToast(t('mc_social_login_first'), 'error')
  const was = feedBookmarks.get(id) === true
  const r = await apiFetch(`/api/bookmarks/${encodeURIComponent(id)}`, { method: was ? 'DELETE' : 'POST' })
  if (!r?.ok) return feedFail(r)
  feedBookmarks.set(id, !was)
  showToast(t(was ? 'mc_feed_bookmark_removed' : 'mc_feed_bookmarked'), 'success')
}

function feedReactionsHtml(m) {
  const rs = (m.reactions || []).filter((r) => r.count > 0)
  if (!rs.length) return ''
  const chips = rs
    .map((r) => {
      const name = escapeHtml(r.emote_name || '')
      const url = r.emote_url ? safeUrl(r.emote_url) : ''
      const img = url ? `<img class="hs-feed-chip-img" src="${escapeHtml(url)}" alt="${name}" loading="lazy">` : ''
      const on = !!r.reacted
      return `<span class="hs-feed-chip${on ? ' on' : ''}" role="button" aria-pressed="${on}" data-emote-id="${Number(r.emote_id) || 0}" title="${name} (${Number(r.count) || 0})">${img}<span class="hs-feed-chip-n">${Number(r.count) || 0}</span></span>`
    })
    .join('')
  return `<div class="hs-feed-reactions">${chips}</div>`
}

function feedPaintReactions(m) {
  for (const row of feedPostRows(m.base36_id)) {
    row.querySelector('.hs-feed-reactions')?.remove()
    const html = feedReactionsHtml(m)
    if (html) row.insertAdjacentHTML('beforeend', html)
  }
}

async function feedReactionToggle(m, emoteId) {
  if (!hsAuthToken) return showToast(t('mc_social_login_first'), 'error')
  const had = !!(m.reactions || []).find((r) => r.emote_id === emoteId)?.reacted
  const prev = feedReactionApply(m, emoteId, !had)
  feedPaintReactions(m)
  const base = `/api/messages/${encodeURIComponent(m.base36_id)}/react`
  const r = had
    ? await apiFetch(`${base}/${emoteId}`, { method: 'DELETE' })
    : await apiFetch(base, { method: 'POST', body: { emote_id: emoteId } })
  if (r?.ok) return
  m.reactions = prev
  feedPaintReactions(m)
  feedFail(r)
}

// One delegated listener per row — covers the ▲ and every chip, including
// chips painted in later by feedPaintReactions.
function feedEngageWire(div, m) {
  div.addEventListener('click', (e) => {
    const up = e.target.closest('.hs-feed-up')
    if (up) {
      e.stopPropagation()
      feedUpvote(m)
      return
    }
    const chip = e.target.closest('.hs-feed-chip')
    if (chip) {
      e.stopPropagation()
      feedReactionToggle(m, Number(chip.dataset.emoteId))
    }
  })
}

// ── live thread frames ──────────────────────────────────────────────────────
// The server fans reaction:added / reaction:removed / vote:updated to the room
// `feed:thread:<id>`; a socket joins it with feed:join `thread:<id>`. The
// background owns the socket, so the thread view only tells it which room this
// tab is looking at (one at a time — naming a new one swaps, null leaves) and
// it re-joins on reconnect. Frames arrive as broadcasts and are applied here.

const FEED_THREAD_ROOM_RE = /^[a-z0-9]{1,8}$/i
let feedThreadRoom = null

function feedThreadRoomFor(id) {
  return typeof id === 'string' && FEED_THREAD_ROOM_RE.test(id) ? `thread:${id.toLowerCase()}` : null
}

// Called when the thread on screen changes (open / switch / close).
function feedThreadSync(id) {
  const room = id ? feedThreadRoomFor(id) : null
  if (room === feedThreadRoom) return
  feedThreadRoom = room
  safeSendMessage({ type: 'feed_thread', room })
}

// Apply one frame to a cached post. Returns 'reactions' | 'vote' | null (what
// changed). My own reaction frames are skipped — the click already applied it
// optimistically; votes carry absolute numbers, so re-applying is harmless.
function feedFrameApply(m, frame, selfId) {
  if (!m || !frame) return null
  if (frame.type === 'vote:updated') {
    if (Number.isFinite(frame.score)) m.vote_score = frame.score
    if (Number.isFinite(frame.heat)) m.heat = frame.heat
    return 'vote'
  }
  if (frame.type !== 'reaction:added' && frame.type !== 'reaction:removed') return null
  if (selfId != null && String(frame.user_id) === String(selfId)) return null
  const emoteId = Number(frame.emote_id)
  if (!emoteId) return null
  const list = (m.reactions || []).map((r) => ({ ...r }))
  const hit = list.find((r) => r.emote_id === emoteId)
  if (frame.type === 'reaction:added') {
    if (hit) hit.count = (Number(hit.count) || 0) + 1
    else {
      // an image the server stamped nsfw / content-warned is shown as a name only
      const gated = frame.nsfw || (frame.cw_cats && frame.cw_cats.length)
      list.push({
        emote_id: emoteId,
        emote_name: frame.emote_name || '',
        emote_url: gated ? '' : frame.emote_url || '',
        count: 1,
        reacted: false,
      })
    }
  } else if (hit) hit.count = Math.max(0, (Number(hit.count) || 0) - 1)
  m.reactions = list.filter((r) => r.count > 0)
  return 'reactions'
}

function feedOnFrame(frame) {
  const m = feedFindMsg(frame?.message_id)
  const changed = feedFrameApply(m, frame, hsCurrentUserId)
  if (changed === 'reactions') feedPaintReactions(m)
  else if (changed === 'vote') feedPaintVote(m)
}
