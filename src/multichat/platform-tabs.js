// platform-tabs.js — the picker's kick and youtube tabs, the way the twitch tab holds twitch's own
// actions. Kick's are links the page does not already carry; youtube's can't be reproduced (super chat,
// stickers, polls, emoji are YouTube's own flows), so its first row brings the native chat up in
// place of ours until you go back.

const _ptGlyph = { link: '↗', chat: '▤' }

function _ptRow(label, glyph, onClick) {
  const el = document.createElement('div')
  el.className = 'hs-mc-menu-item hs-mc-pred-link'
  el.style.setProperty('--menu-accent', '#ffffff')
  const icon = document.createElement('div')
  icon.className = 'hs-mc-menu-icon'
  icon.textContent = glyph
  const text = document.createElement('div')
  text.className = 'hs-mc-menu-text'
  const title = document.createElement('div')
  title.className = 'hs-mc-menu-title'
  title.textContent = label
  text.appendChild(title)
  const arrow = document.createElement('div')
  arrow.className = 'hs-mc-menu-arrow'
  arrow.textContent = '›'
  el.append(icon, text, arrow)
  el.addEventListener('click', (e) => {
    e.stopPropagation()
    onClick()
  })
  return el
}

function _ptOpen(url) {
  try {
    window.open(url, '_blank', 'noopener')
  } catch (_) {}
}

function _ptFill(id, rows, emptyText) {
  const container = document.getElementById(id)
  if (!container) return
  container.textContent = ''
  const wrap = document.createElement('div')
  wrap.className = 'hs-mc-pred-links'
  if (!rows.length) {
    const empty = document.createElement('div')
    empty.className = 'hs-mc-pred-empty-text'
    empty.textContent = emptyText
    wrap.appendChild(empty)
  }
  for (const r of rows) wrap.appendChild(_ptRow(r.label, r.glyph, r.onClick))
  container.appendChild(wrap)
}

function renderKickTab() {
  const ch = String(getCurrentChannel() || '').toLowerCase()
  const rows = /^[a-z0-9_-]{1,40}$/.test(ch)
    ? [
        { label: 'popout chat', glyph: _ptGlyph.link, onClick: () => _ptOpen(`https://kick.com/popout/${ch}/chat`) },
        { label: 'clips', glyph: _ptGlyph.link, onClick: () => _ptOpen(`https://kick.com/${ch}/clips`) },
        { label: 'videos', glyph: _ptGlyph.link, onClick: () => _ptOpen(`https://kick.com/${ch}/videos`) },
        { label: 'channel page', glyph: _ptGlyph.link, onClick: () => _ptOpen(`https://kick.com/${ch}`) },
      ]
    : []
  _ptFill('hs-mc-tab-kick', rows, 'no channel detected')
}

// The channel that owns the video on screen, as a path ("/@handle") — read off the page's own link, never guessed.
function _ptYtOwnerPath() {
  const href = document
    .querySelector('ytd-watch-metadata ytd-channel-name a, #owner ytd-channel-name a')
    ?.getAttribute('href')
  return href && /^\/(@[\w.-]+|channel\/UC[\w-]+)$/.test(href) ? href : ''
}

function renderYoutubeTab() {
  const owner = _ptYtOwnerPath()
  const rows = [
    { label: 'native chat (super chat, stickers, polls, emoji)', glyph: _ptGlyph.chat, onClick: ytPeekNative },
  ]
  if (owner) {
    rows.push({
      label: 'join channel',
      glyph: _ptGlyph.link,
      onClick: () => _ptOpen(`https://www.youtube.com${owner}/join`),
    })
    rows.push({
      label: 'channel page',
      glyph: _ptGlyph.link,
      onClick: () => _ptOpen(`https://www.youtube.com${owner}`),
    })
  }
  _ptFill('hs-mc-tab-youtube', rows, '')
}

// ── youtube's own chat, in place of ours until "back" ────────────────────────
// The chat frame is normally hidden (and collapsed, which unloads it). Peeking gives it the pane's
// rectangle; checkYtLive leaves it alone while body.hs-yt-peek is set and puts it away after.
function ytPeeking() {
  return document.body.classList.contains('hs-yt-peek')
}

function ytPeekNative() {
  const frame = document.querySelector('ytd-live-chat-frame#chat')
  const pane = document.getElementById('hs-mc-container')
  if (!frame || !pane) return
  if (ytPeeking()) return
  // close the picker first: it changes the pane's height, and the measure below must see the settled pane
  document.getElementById('hs-mc-emote-picker')?.classList.remove('visible')
  const bar = document.createElement('div')
  bar.id = 'hs-yt-peek-bar'
  bar.style.cssText = `position:fixed;z-index:2147483001;height:${YT_PEEK_BAR}px;`
  const back = document.createElement('button')
  back.id = 'hs-yt-peek-back'
  back.type = 'button'
  const arrow = document.createElement('span')
  arrow.className = 'hs-yt-peek-arrow'
  arrow.textContent = '←'
  back.append(arrow, ' back to heatsync chat')
  back.addEventListener('click', ytPeekBack)
  bar.appendChild(back)
  document.body.appendChild(bar)
  ytPeekFit()
  document.body.classList.add('hs-yt-peek')
  frame.style.removeProperty('display')
  delete frame.dataset.hsHidden
  if (frame.hasAttribute('collapsed')) {
    try {
      frame.querySelector('#show-hide-button button')?.click()
    } catch (_) {}
  }
  document.addEventListener('keydown', _ytPeekKey, true)
  // it follows the pane: a window resize or a drag of the chat's own edge re-fits it, it never drops out
  window.addEventListener('resize', ytPeekFit)
  _ytPeekRO = new ResizeObserver(ytPeekFit)
  _ytPeekRO.observe(pane)
}

const YT_PEEK_BAR = 28
let _ytPeekRO = null

// The whole pane, tabs and filter row included (none of it works on native chat); clamped to the window.
function ytPeekFit() {
  const pane = document.getElementById('hs-mc-container')
  if (!pane) return
  const paneR = pane.getBoundingClientRect()
  const top = paneR.top
  const height = Math.min(paneR.bottom, innerHeight) - top
  const root = document.body.style
  root.setProperty('--hs-peek-top', `${Math.round(top + YT_PEEK_BAR)}px`)
  root.setProperty('--hs-peek-left', `${Math.round(paneR.left)}px`)
  root.setProperty('--hs-peek-w', `${Math.round(paneR.width)}px`)
  root.setProperty('--hs-peek-h', `${Math.max(0, Math.round(height - YT_PEEK_BAR))}px`)
  const bar = document.getElementById('hs-yt-peek-bar')
  if (bar) {
    bar.style.top = `${Math.round(top)}px`
    bar.style.left = `${Math.round(paneR.left)}px`
    bar.style.width = `${Math.round(paneR.width)}px`
  }
}

function _ytPeekKey(e) {
  if (e.key === 'Escape') ytPeekBack()
}

function ytPeekBack() {
  document.removeEventListener('keydown', _ytPeekKey, true)
  window.removeEventListener('resize', ytPeekFit)
  _ytPeekRO?.disconnect()
  _ytPeekRO = null
  document.getElementById('hs-yt-peek-bar')?.remove()
  document.body.classList.remove('hs-yt-peek')
  for (const p of ['--hs-peek-top', '--hs-peek-left', '--hs-peek-w', '--hs-peek-h'])
    document.body.style.removeProperty(p)
}
