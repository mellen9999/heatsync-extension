// Runs at document_start on kick. Kick's tailwind writes its group-has-*
// utilities as `.x:is(:where(.group\/card):has(...) *)`. For that shape chrome
// can't tell what a DOM change might flip, so every element added or removed
// anywhere re-styles the whole page under <body>: ~190ms with 500 chat rows
// (twitch and youtube have no such rules: 2-5ms). The same rule written as a
// plain descendant, `:where(.group\/card):has(...) .x`, matches the same
// elements at the same specificity and costs nothing. Each kick stylesheet
// that has the shape is swapped for a copy with it rewritten; any failure
// leaves kick's own sheet in place, just slower.
;(() => {
  const MARK = ':is(:where(.group\\/'

  const escaped = (css, k) => {
    let n = 0
    while (k - n - 1 >= 0 && css[k - n - 1] === '\\') n++
    return n % 2 === 1
  }

  /** index of the ')' that closes the '(' at `open`, or -1 */
  const closeOf = (css, open) => {
    let depth = 1
    for (let j = open + 1; j < css.length; j++) {
      const c = css[j]
      if (c === '\\') j++
      else if (c === '"' || c === "'") {
        j = css.indexOf(c, j + 1)
        if (j === -1) return -1
      } else if (c === '(') depth++
      else if (c === ')' && --depth === 0) return j
    }
    return -1
  }

  /** start of the compound just before `at`, when it opens its selector; -1 when it does not */
  const compoundStart = (css, at) => {
    for (let k = at - 1; k >= 0; k--) {
      if (escaped(css, k)) continue
      const c = css[k]
      if (c === ',' || c === '{' || c === '}' || c === ';') return k + 1
      if (c === '(' || c === ')' || c === '>' || c === '+' || c === '~' || /\s/.test(c)) return -1
    }
    return 0
  }

  function rewrite(css) {
    let out = ''
    let from = 0
    for (let i = css.indexOf(MARK); i !== -1; i = css.indexOf(MARK, i + MARK.length)) {
      const close = closeOf(css, i + 3)
      const start = compoundStart(css, i)
      if (close === -1 || start < from || start === i) continue
      const inner = css.slice(i + 4, close)
      if (!inner.endsWith(' *') || !inner.includes(':has(')) continue
      out += `${css.slice(from, start)}${inner.slice(0, -2)} ${css.slice(start, i)}`
      from = close + 1
    }
    return from === 0 ? css : out + css.slice(from)
  }

  globalThis.__hsKickCssRewrite = rewrite
  if (typeof document === 'undefined' || !/(^|\.)kick\.com$/.test(location.hostname)) return

  const api = typeof browser !== 'undefined' ? browser : chrome
  const KICK_CSS = /^https:\/\/assets\.kick\.com\/[\w./%-]+\.css(\?[\w=&.%-]*)?$/
  const done = new WeakSet()

  async function swap(link) {
    if (done.has(link) || !link.relList?.contains('stylesheet') || !KICK_CSS.test(link.href)) return
    done.add(link)
    try {
      const css = await api.runtime.sendMessage({ type: 'kick_css_text', url: link.href })
      const fixed = typeof css === 'string' ? rewrite(css) : null
      if (!fixed || fixed === css || !link.parentNode) return
      const style = document.createElement('style')
      style.textContent = fixed
      link.parentNode.insertBefore(style, link)
      link.disabled = true
    } catch {
      // kick's own sheet stays on
    }
  }

  const scan = (root) => {
    for (const link of root.querySelectorAll('link[rel~="stylesheet"]')) swap(link)
  }

  const watch = (head) => {
    scan(head)
    new MutationObserver((muts) => {
      for (const m of muts) for (const n of m.addedNodes) if (n.nodeName === 'LINK') swap(n)
    }).observe(head, { childList: true })
  }

  if (document.head) watch(document.head)
  else {
    const boot = new MutationObserver(() => {
      if (!document.head) return
      boot.disconnect()
      watch(document.head)
    })
    boot.observe(document, { childList: true, subtree: true })
  }
})()
