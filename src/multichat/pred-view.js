// pred-view.js — predictions & polls as a full chat-area surface.
//
// The prediction UI used to live ONLY inside the emote picker, under a "twitch"
// sub-tab: a popup, three clicks deep, sized for emote grids. A prediction is a
// thing you watch and bet on while it runs, so it belongs where you are looking.
// This takes over #hs-mc-messages the same way profile-card.js and chat-logs.js
// do, and the chat banner is what opens it.
//
// It renders NOTHING of its own. renderPrediction/renderPoll (twitch-api.js) are
// the same functions the picker mounts, so the two surfaces can never drift into
// two different prediction UIs — that was the whole point of putting it here
// rather than writing a second one.

let activePredView = null // { channel }

// Paint from the caches the picker/banner already fill (_lastPredResult,
// _lastPollData) so opening is instant, then refresh in the background. Opening
// to a spinner when the banner in front of you is already showing live odds
// would be a downgrade from the popup this replaces.
async function openPredView(channel) {
  const ch = channel || (typeof getActiveTwitchChannel === 'function' ? getActiveTwitchChannel() : null)
  if (!ch) {
    showToast(t('mc_input_pp_needs_twitch') || 'this needs a twitch channel tab', 'error')
    return
  }
  // Hide the composer — this view is not a place you type. The flag must move
  // with the class or showInputBar() early-returns forever (see chat-logs.js).
  const inputBar = document.getElementById('hs-mc-inputbar')
  if (inputBar) inputBar.classList.add('hs-hidden')
  inputBarVisible = false

  activePredView = { channel: String(ch).toLowerCase() }
  renderPredView()
  await refreshPredViewData()
}

function closePredView() {
  if (!activePredView) return
  activePredView = null
  showInputBar()
  if (typeof renderMessages === 'function') renderMessages(currentTab)
}

function predViewOpen() {
  return !!activePredView
}

// Re-render in place when new prediction/poll data lands. Called from
// updateChatBanners (twitch-api.js), which already runs on every fetch and
// every pubsub update — one hook rather than a second polling loop.
function refreshPredViewIfOpen() {
  if (!activePredView) return
  renderPredView()
}

async function refreshPredViewData() {
  if (!activePredView) return
  const ch = activePredView.channel
  const [pred, poll] = await Promise.all([fetchPrediction(ch).catch(() => null), fetchPoll(ch).catch(() => null)])
  // The view may have been closed during the await — don't write into a
  // surface the user already left (same isConnected/state guard pattern the
  // async renderers use elsewhere).
  if (!activePredView || activePredView.channel !== ch) return
  if (pred) _lastPredResult = pred
  if (poll) _lastPollData = poll?.poll || poll
  renderPredView()
}

function renderPredView() {
  const msgsEl = document.getElementById('hs-mc-messages')
  if (!msgsEl || !activePredView) return
  msgsEl.textContent = ''

  const wrap = document.createElement('div')
  wrap.className = 'hs-pv-wrap'

  const hdr = document.createElement('div')
  hdr.className = 'hs-pv-hdr'
  const title = document.createElement('div')
  title.className = 'hs-pv-title'
  title.textContent = t('mc_predview_title') || 'predictions & polls'
  const sub = document.createElement('span')
  sub.className = 'hs-pv-sub'
  sub.textContent = `#${activePredView.channel}`
  title.appendChild(sub)
  const close = document.createElement('button')
  close.className = 'hs-pv-close'
  close.textContent = '✕'
  close.title = t('common_close') || 'close'
  close.addEventListener('click', closePredView)
  hdr.appendChild(title)
  hdr.appendChild(close)
  wrap.appendChild(hdr)

  const body = document.createElement('div')
  body.className = 'hs-pv-body'

  // ── prediction ──────────────────────────────────────────────────────────
  const predSlot = document.createElement('div')
  predSlot.dataset.predSlot = '1'
  const pr = _lastPredResult
  if (pr?.prediction) {
    predSlot.appendChild(renderPrediction(pr.prediction, pr.balance, pr.channelId, pr.isMod, pr.cpImage, pr.cpName))
  } else if (pr) {
    predSlot.appendChild(renderNoPrediction(pr.balance, pr.channelId, pr.isMod, pr.cpImage, pr.cpName))
  } else {
    const loading = document.createElement('div')
    loading.className = 'hs-mc-pred-loading'
    loading.textContent = t('common_loading') || 'loading...'
    predSlot.appendChild(loading)
  }
  body.appendChild(predSlot)

  // ── poll ────────────────────────────────────────────────────────────────
  const pollSlot = document.createElement('div')
  pollSlot.dataset.pollSlot = '1'
  const pd = _lastPollData
  if (pd?.id) {
    pollSlot.appendChild(renderPoll(pd, pr?.channelId || null, pr?.isMod || _twitchIsMod))
  } else if (pr?.channelId) {
    pollSlot.appendChild(renderNoPoll(pr.channelId, pr.isMod || _twitchIsMod))
  }
  body.appendChild(pollSlot)

  wrap.appendChild(body)
  msgsEl.appendChild(wrap)

  // Same handler attachment the picker does — the buttons inside the rendered
  // prediction/poll are wired by these, not by the renderers themselves.
  attachPredictionHandlers()
  attachPollHandlers()
}
