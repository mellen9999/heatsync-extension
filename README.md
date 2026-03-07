# Heatsync Browser Extension

Injects your personal unlimited heatsync emote set into Twitch and Kick chat.

## Overview

The extension syncs your heatsync emotes to streaming platform chats, allowing you to use your custom emotes anywhere. It also displays emotes from other heatsync users in real-time.

## Platforms

| Platform | Folder | Status |
|----------|--------|--------|
| Chrome | `chrome/` | ✅ Ready (Manifest v3) |
| Firefox | `firefox/` | ✅ Ready (WebExtensions) |

## Features

- **unlimited emote set** - Your personal collection, synced from heatsync.org
- **Global emotes included** - BTTV, FFZ, 7TV globals (refreshed every 24hrs)
- **Real-time broadcasting** - See emotes from other heatsync users in chat
- **Emote autocomplete** - Tab completion with inline preview (FFZ-style)
- **Emote set panel** - Quick access to your emotes from Twitch chat
- **Right-click actions** - Block emotes, mute users instantly
- **Cross-platform** - Works on Twitch and Kick

## Installation

### Chrome (Manifest v3)

**Development:**
```bash
# 1. Open Chrome extensions
chrome://extensions

# 2. Enable "Developer mode" (top right)

# 3. Click "Load unpacked"

# 4. Select: extension/chrome/
```

**Production:** Install from Chrome Web Store (pending)

### Firefox

**Development:**
```bash
# 1. Open Firefox debugging
about:debugging#/runtime/this-firefox

# 2. Click "Load Temporary Add-on"

# 3. Select: extension/firefox/manifest.json
```

**Production:** Install from Firefox Add-ons (pending)

## Architecture

```
extension/
├── chrome/              # Chrome extension (Manifest v3)
│   ├── manifest.json    # Extension config
│   ├── background.js        # Service worker
│   ├── content.js       # Main injection script
│   ├── autocomplete-hook.js # Tab completion
│   ├── chat-injector.js     # Emote rendering
│   ├── heatsync-button.js   # Emote set panel
│   └── platform-detector.js # Twitch/Kick detection
│
├── firefox/             # Firefox extension (WebExtensions)
│   ├── manifest.json    # Extension config
│   ├── background.js    # Background script
│   └── ...              # Similar structure
│
├── dist/                # Built extensions + packaged .zip files
└── STORE-LISTINGS.md    # Store descriptions and metadata
```

## Key Files

| File | Purpose |
|------|---------|
| `autocomplete-hook.js` | Tab completion, inline emote preview |
| `chat-injector.js` | Renders emotes in chat messages |
| `heatsync-button.js` | Emote set panel UI |
| `content.js` | Main orchestration, WebSocket connection |
| `background.js` | Service worker for API calls (Chrome) |

## API Endpoints Used

The extension communicates with heatsync.org (or localhost:3001 in dev):

```
GET  /api/user/emotes          # Fetch user's unlimited inventory
GET  /api/user/emotes/blocked  # Fetch blocked emotes
POST /api/user/emotes/block    # Block emote by hash
GET  /api/emotes/globals       # Global emotes (BTTV, FFZ, 7TV)
WS   /socket.io                # Real-time emote broadcasts
```

## Development

### Testing Changes

1. Make changes to extension files
2. Reload extension:
   - **Chrome:** Click refresh icon on extension card
   - **Firefox:** Click "Reload" in about:debugging
3. Refresh Twitch/Kick page
4. Test in chat

### Building for Store

```bash
bun run extension/build.js --package    # Build + zip both browsers
bun run extension/build.js chrome       # Chrome only
bun run extension/build.js --deploy     # Build + zip + rsync to server
```

### Version Bumping

Update version in:
- `src/manifests/chrome.json`
- `src/manifests/firefox.json`

Then rebuild — `build.js` reads version from `src/manifests/chrome.json`.

## Debugging

**Chrome DevTools:**
- Background: `chrome://extensions` → "Inspect views: service worker"
- Content script: Regular DevTools (F12) → Console

**Firefox DevTools:**
- Background: `about:debugging` → "Inspect"
- Content script: Regular DevTools (F12) → Console

**Common Issues:**

| Issue | Solution |
|-------|----------|
| Emotes not loading | Check if logged into heatsync.org |
| Autocomplete not working | Reload extension, check console for errors |
| WebSocket disconnects | Check network tab for WS connection status |

## Store Listings

See `STORE-LISTINGS.md` for Chrome Web Store and Firefox Add-ons descriptions.

## Related Documentation

- `chrome/README.md` - Chrome extension details + FFZ React hooking guide
- `STORE-LISTINGS.md` - Store listing copy
- `TESTER-GUIDE.md` - Beta tester instructions
