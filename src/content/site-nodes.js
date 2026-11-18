// The site's own renderer (react, on kick) owns the nodes it drew in a chat row, and a node it
// later removes has to sit where it left it. Kick takes every child out of a message's text
// span when a mod deletes the message: a text node we had swapped for our own threw inside its
// renderer, and the whole chat fell to "something went wrong" — every moderated channel, within
// a minute of native mode (e2e s24 and a side-by-side run with no extension, 11-18).
// So the site's text node is never moved or removed. It stays in place, emptied, and its words
// go into a span of ours right after it. When the site redraws the span, what is ours in it
// goes and any text of its own still there gets its words back.
// Kick never rewrites a drawn message's text in place (0 in 2700 rows watched), so a changed
// value on a parked node is not watched for.
// Self-contained — deps come in through createSiteText, so tests import it.

const SITE_OURS_SEL = '.hs-textfrag, .heatsync-emote-stack, .heatsync-emote-wrapper'

/**
 * @param {object} d
 * @param {typeof MutationObserver} d.MutationObserver
 * @param {(o: MutationObserver) => MutationObserver} [d.track]  the page lifecycle's observer list
 * @param {(span: Element) => void} [d.onRedrawn]  the site redrew a text span that held ours
 */
function createSiteText(d) {
  const parked = new WeakMap() // the site's text node -> the words it held
  let obs = null
  const isOurs = (n) => n.nodeType === 1 && n.matches(SITE_OURS_SEL)

  const giveBack = (leaf) => {
    for (const n of Array.from(leaf.childNodes)) {
      if (isOurs(n)) n.remove()
      else if (n.nodeType === 3 && parked.has(n)) {
        if (n.nodeValue === '') n.nodeValue = parked.get(n)
        parked.delete(n)
      }
    }
  }

  const watch = (leaf) => {
    if (!obs) {
      obs = new d.MutationObserver((records) => {
        const redrawn = new Set()
        for (const r of records) for (const n of r.removedNodes) if (!isOurs(n)) redrawn.add(r.target)
        for (const leaf of redrawn) {
          giveBack(leaf)
          d.onRedrawn?.(leaf)
        }
      })
      d.track?.(obs)
    }
    obs.observe(leaf, { childList: true })
  }

  return {
    /** the site's text node `tn` keeps its place; returns our span holding its words */
    park(tn) {
      const span = tn.ownerDocument.createElement('span')
      span.className = 'hs-textfrag'
      span.textContent = tn.nodeValue
      parked.set(tn, tn.nodeValue)
      tn.after(span)
      tn.nodeValue = ''
      watch(tn.parentNode)
      return span
    },
  }
}

export { createSiteText, SITE_OURS_SEL }
