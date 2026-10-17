// twitch-callout-token.js — MAIN world, twitch only.
//
// Twitch carries a callout's share token (a sub anniversary, a watch streak) as
// the React KEY of a fiber two levels under the callout container. React's
// fiber pointers are expandos on the DOM node, and expandos live in the world
// that set them: the overlay runs in the isolated world, where the same node
// has none, so a scan from there reads nothing, every time. This answers the
// overlay's question from the world that can see the answer.
//
// Request/reply over window events, JSON in `detail` (the one thing that
// crosses worlds untouched). The reply lists every callout's token in the
// queue; the overlay picks the one that is its own. Read-only: it never clicks
// or edits anything on the page.
;(() => {
  if (window.__hsCalloutToken) return
  window.__hsCalloutToken = true

  const CALLOUT_SEL = '[data-test-selector="chat-private-callout-queue__callout-container"]'
  // base64 of "<userId>:<channelId>:<count>:<kind>" — decoding IS the check
  const SHAPE = /^(\d+):(\d+):(\d+):([a-z_]+)$/i

  function decode(raw) {
    if (typeof raw !== 'string' || raw.length < 16 || raw.length > 200) return null
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return null
    let plain
    try {
      plain = atob(raw)
    } catch {
      return null
    }
    const m = SHAPE.exec(plain)
    return m ? { raw, channelId: m[2], count: Number(m[3]), kind: m[4].toLowerCase() } : null
  }

  // children + siblings of the container's own fiber, never the container's
  // siblings (those are the other callouts in the queue, with their own keys)
  function scan(el) {
    const k = Object.keys(el).find((n) => n.startsWith('__reactFiber$') || n.startsWith('__reactInternalInstance$'))
    const root = k ? el[k] : null
    if (!root) return null
    const queue = [root]
    const seen = new WeakSet()
    for (let steps = 0; queue.length && steps < 400; steps++) {
      const f = queue.shift()
      if (!f || seen.has(f)) continue
      seen.add(f)
      const tok = decode(f.key)
      if (tok) return tok
      if (f.child) queue.push(f.child)
      if (f !== root && f.sibling) queue.push(f.sibling)
    }
    return null
  }

  window.addEventListener('hs-callout-token-req', (e) => {
    let id
    try {
      id = String(JSON.parse(e.detail).id)
    } catch {
      return
    }
    const tokens = []
    try {
      for (const el of document.querySelectorAll(CALLOUT_SEL)) {
        const t = scan(el)
        if (t) tokens.push(t)
      }
    } catch {}
    window.dispatchEvent(new CustomEvent('hs-callout-token-res', { detail: JSON.stringify({ id, tokens }) }))
  })
})()
