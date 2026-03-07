# heatsync Chrome Extension

Syncs your unlimited heatsync emote set to Twitch and Kick chat.

## Features

- **All-in-one emote extension**: No need for BTTV/FFZ/7TV extensions
- **Global emotes included**: BTTV, FFZ, 7TV globals (refreshed every 24hrs)
- **See everyone's emotes**: Anyone with extension sees emotes from ANY heatsync user
- **Real-time broadcasting**: When you use emote → everyone in channel sees it
- **Your emotes**: Your set always renders (priority #1)
- **Others' emotes**: If someone uses heatsync emote → broadcasts to channel via WebSocket
- **Twitch + Kick support**: Works in both platforms
- **Right-click blocking**: Right-click any emote → blocked everywhere
- **Right-click muting**: Right-click username → 24hr mute everywhere
- **Channel-scoped**: Only broadcasts to users watching same channel (performance)
- **Auto-refresh**: Set syncs every 60s, globals every 24hrs

### Emote Priority:
1. Heatsync broadcasts (other users' emotes)
2. Your unlimited set
3. Global emotes (BTTV, FFZ, 7TV)

## Installation (Development)

1. **Load in Chrome**:
   - Open `chrome://extensions`
   - Enable Developer mode
   - Click "Load unpacked" → select `extension/dist/chrome/`

2. **Load in Firefox**:
   - Open `about:debugging#/runtime/this-firefox`
   - Click "Load Temporary Add-on"
   - Select `extension/dist/firefox/manifest.json`

3. **Open Twitch or Kick chat** and verify the extension loads.

## Server Requirements

Extension uses HTTP API at `https://heatsync.org`:
- `GET /api/user/emotes` - Returns user's emotes
- `GET /api/user/emotes/blocked` - Returns blocked emotes
- `POST /api/user/emotes/block` - Block emote by hash

## Files

- `manifest.json` - Extension config
- `background.js` - WebSocket connection to heatsync
- `content.js` - Twitch/Kick chat injection
- `icon-48.png` - Small icon (48x48)
- `icon-96.png` - Large icon (96x96)

## FFZ-Style React Hooking

We use FrankerFaceZ-style techniques (not 7TV) for modifying Twitch chat. FFZ works WITH React instead of fighting it — more stable across Twitch updates, better performance.

### Core Principle

Work WITHIN React, not around it. Never manipulate DOM after React renders.

### React Fiber Discovery

```javascript
function getFiber(el) {
  if (!el) return null
  const key = Object.keys(el).find(k =>
    k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
  )
  return key ? el[key] : null
}

function findComponent(startEl, predicate, maxDepth = 50) {
  let fiber = getFiber(startEl)
  let depth = 0
  while (fiber && depth < maxDepth) {
    try {
      const inst = fiber.stateNode
      if (inst && predicate(inst, fiber)) return { instance: inst, fiber }
    } catch (e) {}
    fiber = fiber.return
    depth++
  }
  return null
}
```

### Render Method Patching

```javascript
function patchRender(component) {
  const inst = component.instance
  if (inst._patched) return
  const originalRender = inst.render.bind(inst)
  inst.render = function() {
    const result = originalRender()
    ensureUIElements()
    return result
  }
  inst._patched = true
  inst.forceUpdate()
}
```

### DOM Injection on Flex Containers

Use CSS `order` instead of `insertBefore` to avoid breaking Twitch layout:

```javascript
container.insertBefore(element, container.firstChild)
element.style.order = '-1' // appears first visually
```

### Re-hooking (React removes injected elements)

```javascript
// MutationObserver
const observer = new MutationObserver(mutations => {
  for (const m of mutations)
    for (const node of m.removedNodes)
      if (node.id === 'my-element') setTimeout(ensureUIElements, 100)
})
observer.observe(document.body, { childList: true, subtree: true })

// Polling fallback for layout changes (theatre mode, popouts)
setInterval(() => {
  if (!document.getElementById('my-element')) ensureUIElements()
}, 1000)
```

### Key Twitch Selectors

```javascript
'[class*="chat-room__content"]'                          // chat container
'[class*="stream-chat"]'                                 // stream chat
'[data-test-selector="chat-room-component"]'             // chat room
'[class*="chat-scrollable-area__message-container"]'     // message area
'[data-a-target="chat-input"]'                           // input (avoid modifying)
```

### What NOT to Do

- Move/reparent Twitch DOM elements (breaks React)
- Use Shadow DOM (breaks native style integration)
- Insert into flex containers without CSS order
- Modify DOM directly after React renders
- Assume elements persist (React re-renders constantly)

### Twitch IRC (Anonymous Read-Only)

```javascript
const ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443')
ws.onopen = () => {
  ws.send(`NICK justinfan${Math.floor(Math.random() * 99999)}\r\n`)
  ws.send('CAP REQ :twitch.tv/tags\r\n')
  ws.send('JOIN #channelname\r\n')
}
```

### Username Detection

```javascript
localStorage.getItem('twilight.user.displayName')
// fallback:
JSON.parse(localStorage.getItem('twilight.user'))?.displayName
```
