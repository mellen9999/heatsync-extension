// Runs at document_start on kick. Kick's tailwind writes its group-has-*
// utilities as `.x:is(:where(.group\/card):has(...) *)`. For that shape chrome
// can't tell what a DOM change might flip, so every element added or removed
// anywhere re-styles the whole page under <body>: ~190ms with 500 chat rows
// (twitch and youtube have no such rules: 2-5ms). The same rule written as a
// plain descendant, `:where(.group\/card):has(...) .x`, matches the same
// elements at the same specificity and costs nothing. Each kick stylesheet
// that has the shape is swapped for a copy with it rewritten; any failure
// leaves kick's own sheet in place, just slower.
//
// One rule keeps a tag as its subject (`... .x :is(a,button,[role=button])`,
// pointer-events for links inside directory cards) and chrome re-styles every
// a/button on the page per insertion for it — the 1500 in a full chat cost
// 35ms. It is cut out into its own <style>, which is switched off on channel
// pages, where there are no cards.
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

  /** `heavy`: a rewritten rule still has a selector after the group (see the header) */
  function rewriteChunk(css) {
    let out = ''
    let from = 0
    let heavy = false
    for (let i = css.indexOf(MARK); i !== -1; i = css.indexOf(MARK, i + MARK.length)) {
      const close = closeOf(css, i + 3)
      const start = compoundStart(css, i)
      if (close === -1 || start < from || start === i) continue
      const inner = css.slice(i + 4, close)
      if (!inner.endsWith(' *') || !inner.includes(':has(')) continue
      if (/^\s*[^\s{,]/.test(css.slice(close + 1, close + 3))) heavy = true
      out += `${css.slice(from, start)}${inner.slice(0, -2)} ${css.slice(start, i)}`
      from = close + 1
    }
    return { text: from === 0 ? css : out + css.slice(from), heavy }
  }

  const rewrite = (css) => rewriteChunk(css).text

  /** kick's sheet is a run of `@layer x{...}` blocks; split on the top-level ones */
  function topLevelChunks(css) {
    const chunks = []
    let depth = 0
    let from = 0
    for (let j = 0; j < css.length; j++) {
      const c = css[j]
      if (c === '\\') j++
      else if (c === '"' || c === "'") {
        j = css.indexOf(c, j + 1)
        if (j === -1) break
      } else if (c === '{') depth++
      else if ((c === '}' && --depth === 0) || (c === ';' && depth === 0)) {
        chunks.push(css.slice(from, j + 1))
        from = j + 1
      }
    }
    if (from < css.length) chunks.push(css.slice(from))
    return chunks
  }

  const wrapped = (wrap, body) => wrap.reduceRight((inner, head) => `${head}{${inner}}`, body)

  /** the rules of a chunk, each with the at-rule heads around it */
  function leaves(chunk, wrap = []) {
    const open = chunk.indexOf('{')
    const head = chunk.slice(0, open).trim()
    if (open === -1 || !chunk.endsWith('}') || !/^@(layer|media|supports|container)\b/.test(head)) {
      return [{ wrap, css: chunk }]
    }
    return topLevelChunks(chunk.slice(open + 1, -1)).flatMap((c) => leaves(c, [...wrap, head]))
  }

  /** the rewritten sheet as runs of css, in the original order; `heavy` runs hold the one costly rule */
  function plan(css) {
    const runs = []
    const push = (text, heavy) => {
      const last = runs[runs.length - 1]
      if (last && last.heavy === heavy) last.css += text
      else runs.push({ css: text, heavy })
    }
    for (const chunk of topLevelChunks(css)) {
      const whole = rewriteChunk(chunk)
      if (!whole.heavy) {
        push(whole.text, false)
        continue
      }
      // kick's utilities are one big `@layer utilities{...}`: cut the costly rule out of it
      let group = null
      const flush = () => group && push(wrapped(group.wrap, group.parts.join('')), group.heavy)
      for (const leaf of leaves(chunk)) {
        const { text, heavy } = rewriteChunk(leaf.css)
        const key = leaf.wrap.join('\u0000')
        if (!group || group.key !== key || group.heavy !== heavy) {
          flush()
          group = { key, wrap: leaf.wrap, heavy, parts: [] }
        }
        group.parts.push(text)
      }
      flush()
    }
    return runs
  }

  globalThis.__hsKickCssFix = { rewrite, plan }
  // a test loads this for rewrite/plan alone; the page work needs both a page and its address
  if (typeof document === 'undefined' || typeof location === 'undefined' || !/(^|\.)kick\.com$/.test(location.hostname)) return

  const api = typeof browser !== 'undefined' ? browser : chrome
  const KICK_CSS = /^https:\/\/assets\.kick\.com\/[\w./%-]+\.css(\?[\w=&.%-]*)?$/
  const done = new WeakSet()

  // Literal copy of src/lib/reserved-paths.js (this runs before any bundle);
  // build.js checkReservedPathsParity fails the build if it drifts.
  const RESERVED_PATHS = new Set([
    'about',
    'accessibility',
    'activate',
    'admin',
    'agency',
    'agent',
    'api',
    'auth',
    'authorize',
    'bits',
    'blog',
    'broadcast',
    'browse',
    'bug',
    'careers',
    'categories',
    'category',
    'checkout',
    'clip',
    'clips',
    'collections',
    'community',
    'company',
    'contact',
    'dashboard',
    'directory',
    'dmca',
    'downloads',
    'drops',
    'embed',
    'feedback',
    'following',
    'friends',
    'games',
    'help',
    'inventory',
    'jobs',
    'kickbot',
    'leaderboards',
    'login',
    'logout',
    'messages',
    'moderation',
    'moderator',
    'notifications',
    'oauth',
    'oauth2',
    'p',
    'partner',
    'partners',
    'password',
    'popout',
    'press',
    'prime',
    'privacy',
    'products',
    'profile',
    'redeem',
    'referrals',
    'responsible-disclosure',
    'rules',
    'schedule',
    'search',
    'settings',
    'signup',
    'store',
    'subs',
    'subscriptions',
    'support',
    'team',
    'teams',
    'terms',
    'turbo',
    'turbo-faq',
    'u',
    'vault',
    'verify',
    'video',
    'videos',
    'vip',
    'vods',
    'wallet',
  ])

  /** a channel page: one path segment that is not a site section */
  const onChannel = () => {
    const m = location.pathname.match(/^\/([a-zA-Z0-9_-]{1,40})\/?$/)
    return !!m && !RESERVED_PATHS.has(m[1].toLowerCase())
  }

  const cards = new Set()
  const gate = () => {
    const off = onChannel()
    for (const style of cards) style.disabled = off
  }
  // kick-nav-watcher.js (page world) posts this on every pushState/replaceState
  window.addEventListener('message', (e) => {
    if (e.source === window && e.data?.type === 'heatsync-nav') gate()
  })
  window.addEventListener('popstate', gate)

  async function swap(link) {
    if (done.has(link) || !link.relList?.contains('stylesheet') || !KICK_CSS.test(link.href)) return
    done.add(link)
    try {
      const css = await api.runtime.sendMessage({ type: 'kick_css_text', url: link.href })
      const runs = typeof css === 'string' ? plan(css) : []
      if (!link.parentNode || runs.map((r) => r.css).join('') === css) return
      for (const run of runs) {
        const style = document.createElement('style')
        style.textContent = run.css
        link.parentNode.insertBefore(style, link)
        if (run.heavy) {
          style.disabled = onChannel()
          cards.add(style)
        }
      }
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
