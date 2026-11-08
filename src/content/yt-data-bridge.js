// yt-data-bridge — MAIN world, live_chat frames only.
//
// YouTube's live-chat renderer elements bind the raw innertube JSON to a
// Polymer `.data` property. That is a page-world JS property: the ISOLATED
// world (youtube-content.js) gets its own wrapper and reads `el.data` as
// undefined — which silently killed everything keyed off the author's UC id
// (HeatSync native paints, google-id 7TV cosmetics, deletion author swap).
// This bridge runs in the page world and mirrors the two fields the isolated
// side needs onto DOM attributes, which DO cross worlds:
//   data-hs-author-id  — author UC id (paints, 7TV cosmetics, deletion swap)
//   data-hs-ctx-params — the row's context-menu token, which is the entry point
//                        to YouTube's own moderation flow. Without it the mod
//                        path read `el.data` from the isolated world, got
//                        undefined for every row, and answered
//                        "message_not_found" for every action while the mod
//                        probe never even ran — i.e. yt moderation was wired
//                        end to end except for the one hop that can't work.
//
// Polymer may bind `.data` after the node is inserted, so each field retries
// independently (one may land before the other) on a short backoff.
;(() => {
  if (window.__hsYtDataBridge) return
  window.__hsYtDataBridge = 1

  const SEL = [
    'yt-live-chat-text-message-renderer',
    'yt-live-chat-paid-message-renderer',
    'yt-live-chat-paid-sticker-renderer',
    'yt-live-chat-membership-item-renderer',
    'yt-live-chat-sponsorships-gift-purchase-announcement-renderer',
  ].join(',')

  // attr → read it off the bound data, or null when it isn't there (yet).
  const FIELDS = [
    [
      'data-hs-author-id',
      (d) => (/^UC[\w-]{20,}$/i.test(d.authorExternalChannelId || '') ? d.authorExternalChannelId : null),
    ],
    ['data-hs-ctx-params', (d) => d.contextMenuEndpoint?.liveChatItemContextMenuEndpoint?.params || null],
    // YouTube's own send time (microseconds since epoch) — the DOM-scrape tap
    // (youtube-content.js extractMessage/processNode) otherwise has no way to
    // read the renderer's real timestampUsec and falls back to Date.now(),
    // unlike the innertube-JSON tap (background.js ytTapTimestamp) and the
    // server relay, which both already preserve it.
    ['data-hs-timestamp', (d) => (/^\d+$/.test(String(d.timestampUsec || '')) ? String(d.timestampUsec) : null)],
  ]
  // Polymer usually binds within a frame; a single 80ms retry used to be the
  // whole budget, so a slow bind left a row permanently unstamped (and, for
  // the ctx token, permanently unmoderatable). Three tries over ~600ms costs
  // nothing on a row that binds immediately — the loop stops at the first hit.
  const RETRY_MS = [80, 200, 400]

  const stamp = (el, attempt = 0) => {
    try {
      const d = el.data
      let pending = false
      for (const [attr, read] of FIELDS) {
        if (el.hasAttribute(attr)) continue
        const v = d ? read(d) : null
        if (typeof v === 'string' && v) el.setAttribute(attr, v)
        else pending = true
      }
      if (pending && attempt < RETRY_MS.length) setTimeout(() => stamp(el, attempt + 1), RETRY_MS[attempt])
    } catch {}
  }

  const scan = (root) => {
    if (root.querySelectorAll) for (const el of root.querySelectorAll(SEL)) stamp(el)
  }

  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue
        if (n.matches && n.matches(SEL)) stamp(n)
        else scan(n)
      }
    }
  })

  const arm = () => {
    mo.observe(document.documentElement, { childList: true, subtree: true })
    scan(document)
  }
  if (document.documentElement) arm()
  else addEventListener('DOMContentLoaded', arm, { once: true })
})()
