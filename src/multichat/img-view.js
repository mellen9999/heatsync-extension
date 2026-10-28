// img-view.js — a feed/thread picture, full size, in the chat area.
//
// A thumbnail in the feed is a postage stamp; clicking it should show the
// picture, not do nothing. Same shape as pred-view.js: it takes over
// #hs-mc-messages, the active tab reads ← back (takeover.js), and closing hands
// the pane back to the tab it came from. The composer hides while it is open —
// this is not a place you type.

let activeImgView = null // { src }

function openImgView(src) {
  const msgsEl = document.getElementById('hs-mc-messages')
  if (!msgsEl || !src) return
  const inputBar = document.getElementById('hs-mc-inputbar')
  if (inputBar) inputBar.classList.add('hs-hidden')
  inputBarVisible = false
  activeImgView = { src }
  msgsEl.textContent = ''
  const wrap = document.createElement('div')
  wrap.className = 'hs-iv-wrap'
  const im = document.createElement('img')
  im.className = 'hs-iv-img'
  im.alt = ''
  im.src = src
  // A picture that will not load must not strand you on a blank pane.
  im.addEventListener('error', closeImgView, { once: true })
  wrap.appendChild(im)
  msgsEl.appendChild(wrap)
  msgsEl.scrollTop = 0
  hsTakeoverSync()
}

function closeImgView() {
  if (!activeImgView) return
  activeImgView = null
  hsTakeoverSync()
  showInputBar()
  if (typeof renderMessages === 'function') renderMessages(currentTab, { bypassScrollPause: true })
}

// A tab switch tears the view down without touching the pane: the switch
// repaints it for the new tab itself.
function imgViewDrop() {
  activeImgView = null
}

function imgViewOpen() {
  return !!activeImgView
}

// Hover an [img]/[gif] tag on an op/re row: the picture floats beside it (a box
// instead when the post is held). Fixed and pointer-events:none, so the row never
// shifts under the scroll. The tag itself is not clickable.
let peekEl = null
function hidePeek() {
  if (peekEl) peekEl.remove()
  peekEl = null
}
document.addEventListener(
  'mouseover',
  (e) => {
    const tag = e.target?.closest?.('.hs-feed-media-tag[data-src]')
    if (!tag) return hidePeek()
    if (peekEl && peekEl.dataset.for === tag.dataset.src) return
    hidePeek()
    const box = document.createElement('div')
    box.id = 'hs-img-peek'
    box.dataset.for = tag.dataset.src
    const cat = hsHeldMediaCat((tag.dataset.cats || '').split(' ').filter(Boolean))
    if (cat) {
      // flagged and not opted in: the box, never the picture
      const held = document.createElement('div')
      held.className = 'hs-img-peek-held'
      held.textContent = `[image hidden — ${HS_MEDIA_LABEL[cat] || cat}]`
      box.appendChild(held)
    } else {
      const im = document.createElement('img')
      im.alt = ''
      im.addEventListener('error', hidePeek, { once: true })
      im.src = tag.dataset.src
      box.appendChild(im)
    }
    document.body.appendChild(box)
    peekEl = box
    const r = tag.getBoundingClientRect()
    box.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - 324))}px`
    // above the tag unless it is near the top of the screen
    if (r.top > 260) box.style.bottom = `${window.innerHeight - r.top + 4}px`
    else box.style.top = `${r.bottom + 4}px`
  },
  { signal: mcSignal, passive: true },
)
document.addEventListener('scroll', hidePeek, { signal: mcSignal, capture: true, passive: true })

// A feed/thread picture inside the chat pane opens here. Capture, so the row's
// own click handlers (open thread, select) never see it.
document.addEventListener(
  'click',
  (e) => {
    if (e.button > 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    const im = e.target?.closest?.(
      '#hs-mc-messages img.hs-feed-media-img, #hs-mc-messages img.hs-feed-media-item, #hs-mc-messages img.hs-feed-embed-rich-image',
    )
    if (!im) return
    const src = im.currentSrc || im.src
    if (!src) return
    e.preventDefault()
    e.stopPropagation()
    openImgView(src)
  },
  { signal: mcSignal, capture: true },
)
