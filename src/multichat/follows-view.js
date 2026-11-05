// follows-view.js — who you follow is live right now: a keyboard list, most
// viewers first, in the pane panel. Port of the site's follow rail and the rust
// app's ctrl-b following screen, over the snapshot the service worker already
// pushes (live_followed_updated) — no new request.
//
//   <Space>f (vi normal mode) or Alt+L   open · j/k or arrows move
//   enter  open as a chat tab (youtube: watch)   w  watch   esc  close
//
// No import/export: concatenated into the multichat bundle (build.js).

const FOLLOWS_MAX = 500
let followsSnap = [] // [{ platform, username, name, viewers, game, startedAt }]
let followsRefresh = null // set while the panel is open: repaint on a new snapshot

function followsAbbrev(n) {
  const v = Number(n) || 0
  if (v >= 1e6) return `${(v / 1e6).toFixed(1).replace(/\.0$/, '')}m`
  if (v >= 1e3) return `${(v / 1e3).toFixed(1).replace(/\.0$/, '')}k`
  return String(v)
}

function followsUptime(startedAt, now = Date.now()) {
  const ms = now - Date.parse(startedAt || '')
  if (!Number.isFinite(ms) || ms < 60000) return ''
  const m = Math.floor(ms / 60000)
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m` : `${m}m`
}

// the SW snapshot → the rows shown: live only, bounded, most viewers first
function followsNormalize(snapshot) {
  if (!Array.isArray(snapshot)) return []
  const out = []
  for (const s of snapshot) {
    const platform = String(s?.platform || '').toLowerCase()
    const username = String(s?.username || '').toLowerCase()
    if (!username || (platform !== 'twitch' && platform !== 'kick' && platform !== 'youtube')) continue
    const st = s.stream || {}
    out.push({
      platform,
      username,
      name: String(s.displayName || username).slice(0, 40),
      viewers: Number(s.viewers ?? st.viewerCount ?? 0) || 0,
      game: String(st.category || st.game || '').slice(0, 60),
      startedAt: String(st.startedAt || st.started_at || ''),
    })
    if (out.length >= FOLLOWS_MAX) break
  }
  return out.sort((a, b) => b.viewers - a.viewers || a.name.localeCompare(b.name))
}

function followsSet(snapshot) {
  followsSnap = followsNormalize(snapshot)
  followsRefresh?.()
}

function followsWatchUrl(f) {
  if (f.platform === 'kick') return `https://kick.com/${encodeURIComponent(f.username)}`
  if (f.platform === 'youtube') return `https://www.youtube.com/@${encodeURIComponent(f.username)}`
  return `https://www.twitch.tv/${encodeURIComponent(f.username)}`
}

// the saved tab for this follow (twitch/kick leg), adding one when there is none
function followsOpenChat(f) {
  if (f.platform === 'youtube') return followsWatch(f)
  const has = config.channels.find((c) => String(c[f.platform] || '').toLowerCase() === f.username)
  if (has) return switchTab(has.id)
  addChannelsBulk([{ [f.platform]: f.username }])
  const added = config.channels.find((c) => String(c[f.platform] || '').toLowerCase() === f.username)
  if (added) switchTab(added.id)
}

function followsWatch(f) {
  window.open(followsWatchUrl(f), '_blank', 'noopener,noreferrer')
}

function openFollowsView() {
  const page = document.createElement('div')
  page.className = 'hs-fl'
  const head = document.createElement('div')
  head.className = 'hs-fl-head'
  const title = document.createElement('span')
  title.className = 'hs-fl-title'
  title.textContent = t('mc_follows_title')
  const count = document.createElement('span')
  count.className = 'hs-fl-count'
  head.append(title, count)
  const list = document.createElement('div')
  list.className = 'hs-fl-list'
  const hint = document.createElement('div')
  hint.className = 'hs-fl-hint'
  hint.textContent = t('mc_follows_hint')
  page.append(head, list, hint)

  let sel = 0
  const render = () => {
    count.textContent = t('mc_follows_count', [String(followsSnap.length)])
    sel = Math.min(sel, Math.max(0, followsSnap.length - 1))
    if (!followsSnap.length) {
      const none = document.createElement('div')
      none.className = 'hs-fl-note'
      none.textContent = t('mc_follows_empty')
      list.replaceChildren(none)
      return
    }
    list.replaceChildren(
      ...followsSnap.map((f, i) => {
        const row = document.createElement('div')
        row.className = `hs-fl-row${i === sel ? ' hs-fl-sel' : ''}`
        const cell = (cls, text) => {
          const s = document.createElement('span')
          s.className = cls
          s.textContent = text
          return s
        }
        row.append(
          cell(`hs-fl-plat hs-fl-${f.platform}`, f.platform === 'youtube' ? 'y' : f.platform[0]),
          cell('hs-fl-name', f.name),
          cell('hs-fl-game', f.game),
          cell('hs-fl-up', followsUptime(f.startedAt)),
          cell('hs-fl-views', followsAbbrev(f.viewers)),
        )
        row.addEventListener('click', () => {
          sel = i
          render()
        })
        row.addEventListener('dblclick', () => followsOpenChat(f))
        return row
      }),
    )
    list.children[sel]?.scrollIntoView?.({ block: 'nearest' })
  }
  const onKey = (e) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return
    const move = e.key === 'j' || e.key === 'ArrowDown' ? 1 : e.key === 'k' || e.key === 'ArrowUp' ? -1 : 0
    if (move) {
      sel = Math.max(0, Math.min(followsSnap.length - 1, sel + move))
      render()
    } else if (e.key === 'Enter' && followsSnap[sel]) {
      closeIt(true)
      followsOpenChat(followsSnap[sel])
    } else if (e.key === 'w' && followsSnap[sel]) {
      followsWatch(followsSnap[sel])
    } else return
    e.preventDefault()
    e.stopPropagation()
  }
  const panel = hsPanePanelOpenWith({
    label: t('mc_follows_title'),
    body: page,
    buttons: [],
    onKey,
    onDone: () => {
      followsRefresh = null
    },
  })
  if (!panel) return false
  const closeIt = (restoreRow) => activePanePanel?.finish(false, restoreRow)
  followsRefresh = render
  render()
  return true
}

function followsKeyHandler(e) {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.key.toLowerCase() !== 'l') return
  const a = document.activeElement
  if (a && a.id !== 'hs-mc-input' && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return
  if (!document.getElementById('hs-mc-messages')) return
  e.preventDefault()
  e.stopPropagation()
  openFollowsView()
}
