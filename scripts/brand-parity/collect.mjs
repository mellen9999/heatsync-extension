// Runs INSIDE the page (site renderer or the real built extension). Returns, per row type, the
// computed styles of the first row of that type. Self-contained: it is serialised into the page.
export function collect(sel) {
  const rows = [...document.querySelectorAll(sel)]
  const kind = (el) => {
    const c = el.className
    if (el.dataset.fx) return `fx-${el.dataset.fx}`
    if (/hs-row-mention/.test(c)) return /zebra/.test(c) ? 'mention-stripe' : 'mention'
    if (/hs-row-seen/.test(c) && !/hs-filled/.test(c)) return 'plain+seen'
    if (/user-intro/.test(c)) return 'user-intro'
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
    const body = el.querySelector('.chat-content, .hs-mc-text, [data-fx-body]')
    const link = body && body.querySelector('.hs-link')
    const men = body && body.querySelector('.hs-mention')
    const rep = el.querySelector('.hs-reply-ctx')
    const col = (n) => (n ? getComputedStyle(n).color : null)
    out[k] = {
      bg: cs.backgroundColor,
      edge: cs.boxShadow,
      fillClass: (/hs-fill-[a-z]+/.exec(el.className) || [''])[0],
      height: Math.round(el.getBoundingClientRect().height),
      padTop: px(cs.paddingTop), padBottom: px(cs.paddingBottom), padLeft: px(cs.paddingLeft), padRight: px(cs.paddingRight),
      fontSize: px(cs.fontSize), lineHeight: cs.lineHeight,
      borderLeft: px(cs.borderLeftWidth), borderTop: px(cs.borderTopWidth),
      label: lab ? getComputedStyle(lab).color : null,
      labelFont: lab ? px(getComputedStyle(lab).fontSize) : null,
      labelLine: lab ? getComputedStyle(lab).lineHeight : null,
      bodyColor: col(body), linkColor: col(link), linkDeco: link ? getComputedStyle(link).textDecorationLine : null,
      mentionColor: col(men), mentionWeight: men ? getComputedStyle(men).fontWeight : null, replyColor: col(rep),
      cutBg: ccs ? ccs.backgroundColor : null, cutPadLeft: ccs ? px(ccs.paddingLeft) : null, cutPadRight: ccs ? px(ccs.paddingRight) : null,
    }
  }
  return out
}

// Fixture rows for the types a harness cannot trigger live (rule-highlight, cheer, user-intro, kicks,
// superchat, redeem, offline): each surface's own base row class + the shared vocabulary, so the shared
// css and the surface's base css meet exactly as they do on a real row. Self-contained (serialised).
export function inject([sel, baseClass]) {
  const host = document.querySelector(sel)
  const FX = [['user-intro', 'purple', ''], ['kicks', 'navy', ''], ['superchat', 'navy', ''], ['redeem', 'teal', ''], ['offline', 'olive', '']]
  const sp = document.createElement('div'); sp.className = baseClass; sp.textContent = 'spacer'; host.appendChild(sp) // a plain row, so no fixture's gap depends on what came before
  for (const [name, fill, style] of FX) {
    const d = document.createElement('div')
    d.className = `${baseClass} hs-filled hs-fill-${fill}`
    d.dataset.fx = name
    if (style) d.setAttribute('style', style.slice(7, -1))
    d.innerHTML = `<span class="hs-row-label">\u25c6 ${name}</span> <span class="hs-name-cut"><span style="color:#0000ff">viewer</span></span> <span data-fx-body>hello <a class="hs-link" href="https://example.com/x">example.com/x</a> <span class="hs-mention">@probeuser</span></span><div class="hs-reply-ctx">\u21b3 earlier message</div>`
    host.appendChild(d)
  }
}
