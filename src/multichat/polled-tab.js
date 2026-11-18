// polled-tab.js — a tab whose list refreshes itself while it is on screen (discover, pinned).
//
// The first load shows "loading…". A refresh is silent: the list on screen stays until the new
// one is in. The 20s refresh used to wipe the pane to "loading…" first, every time: the tab
// flashed, and a card or confirm open over it was replaced by "loading…" and never came back.
// A failed fetch also left the render to start the next one itself, at once, for as long as
// the api was down. A failed try now keeps what was there; with nothing to show the tab says
// so, and the next tick tries again.

/**
 * @param tab    the tab id this list belongs to
 * @param fetch  async, fills the caller's own lists; resolves true when the answer was usable
 * @param render draws the tab (it asks `placeholder()` first)
 * @param clear  empties the caller's lists
 */
function hsPolledTab({ tab, fetch, render, clear, every = 20000 }) {
  const s = { loaded: false, loading: false, failed: false, timer: null, gen: 0 }
  s.load = async () => {
    if (s.loading) return
    s.loading = true
    const gen = s.gen
    let ok = false
    try {
      ok = !!(await fetch())
    } catch (_) {}
    s.loading = false
    // signed in or out while this was in flight: the answer is for the other session
    if (gen !== s.gen) return void (currentTab === tab && render())
    s.failed = !ok
    if (ok) s.loaded = true
    if (currentTab === tab) render()
  }
  /** Keep refreshing while the tab is the one on screen; leaving it stops the timer. A page
   *  timer: it works on these lists and the network, so a channel switch must not kill it
   *  behind the `if (s.timer)` guard (tests/drained-timers-ratchet.test.js has the rule). */
  s.poll = () => {
    if (s.timer) return
    s.timer = cleanup.setPageIntervalIfVisible(() => {
      if (currentTab === tab) return void s.load()
      cleanup.clearInterval(s.timer)
      s.timer = null
    }, every)
  }
  /** The sign-in changed: what is held was fetched for someone else. */
  s.reset = () => {
    s.gen++
    s.loaded = false
    s.failed = false
    clear()
  }
  /** What to put up instead of the list: 'loading', 'failed', or '' to draw the list. A first
   *  draw starts the first load; after a failure only the timer (or a reset) asks again. */
  s.placeholder = () => {
    if (s.loaded) return ''
    if (!s.loading && !s.failed) s.load()
    return s.loading ? 'loading' : 'failed'
  }
  return s
}

/** The one line a polled tab shows while it has no list. */
function hsPolledNote(msgsEl, state) {
  msgsEl.textContent = ''
  const el = document.createElement('div')
  el.className = 'hs-mc-empty'
  el.textContent = state === 'failed' ? t('mc_whisper_hs_unreachable') : t('common_loading')
  msgsEl.appendChild(el)
}
