// Runs INSIDE the page (site renderer or the real built extension). Returns, per row type, the
// computed styles of the first row of that type. Self-contained: it is serialised into the page.
export function collect(sel) {
  const rows = [...document.querySelectorAll(sel)]
  const kind = (el) => {
    const c = el.className
    if (!/hs-filled/.test(c)) return /zebra/.test(c) ? 'plain-stripe' : 'plain'
    let m = /(?:chat|hs-mc)-notice-([a-z-]+)/.exec(c)
    if (m) return `notice-${m[1]}`
    m = /\bevent-([a-z-]+)/.exec(c)
    if (m) return `event-${m[1]}`
    if (/chat-msg-first|hs-mc-first-msg/.test(c)) return 'first'
    if (/redeemed/.test(c)) return 'redeemed'
    if (/highlighted/.test(c)) return 'highlighted'
    if (/rule-hit|rule-highlight/.test(c)) return 'rule'
    return 'filled-other'
  }
  const px = (v) => Math.round(parseFloat(v) * 10) / 10
  const out = {}
  for (const el of rows) {
    const k = kind(el)
    if (out[k]) continue
    const cs = getComputedStyle(el)
    const lab = el.matches('.hs-row-label') ? el : el.querySelector('.hs-row-label')
    const cut = el.querySelector('.hs-name-cut')
    const ccs = cut && getComputedStyle(cut)
    out[k] = {
      bg: cs.backgroundColor,
      fillClass: (/hs-fill-[a-z]+/.exec(el.className) || [''])[0],
      height: Math.round(el.getBoundingClientRect().height),
      padTop: px(cs.paddingTop), padBottom: px(cs.paddingBottom), padLeft: px(cs.paddingLeft), padRight: px(cs.paddingRight),
      fontSize: px(cs.fontSize), lineHeight: cs.lineHeight,
      borderLeft: px(cs.borderLeftWidth), borderTop: px(cs.borderTopWidth),
      label: lab ? getComputedStyle(lab).color : null,
      labelFont: lab ? px(getComputedStyle(lab).fontSize) : null,
      labelLine: lab ? getComputedStyle(lab).lineHeight : null,
      cutBg: ccs ? ccs.backgroundColor : null, cutPadLeft: ccs ? px(ccs.paddingLeft) : null, cutPadRight: ccs ? px(ccs.paddingRight) : null,
    }
  }
  return out
}
