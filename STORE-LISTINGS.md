# Store Listings for Heatsync Extension

**Version:** 1.2.1
**Last Updated:** February 2026

## Firefox Add-ons (AMO)

**Name:** heatsync

**Summary (50 chars max):**
Your emotes in Twitch and Kick chat

**Description:**
Use your heatsync emotes directly in Twitch and Kick chat.

heatsync gives you unlimited emote slots that work across both platforms. Upload any image to heatsync.org, and this extension makes them appear in chat whenever you or others type the emote name.

What it does:
- Replaces emote names with images in Twitch and Kick chat
- Tab-completion for emote names in chat input
- Shows BTTV, FFZ, and 7TV emotes automatically
- Click emotes to add them to your set
- Right-click any emote to block it (syncs across devices)
- Real-time sync when you use emotes

How to use:
1. Log in at heatsync.org with Twitch or Kick
2. Upload emotes to your set
3. Install this extension
4. Open any Twitch or Kick stream
5. Your emotes now work in chat

No tracking, no ads, no data selling. Just emotes.

Source code: https://github.com/mellen9999/heatsync

**Categories:**
- Social & Communication

**Tags:**
twitch, kick, emotes, chat, streaming, bttv, 7tv, ffz

**Support Email:**
privacy@heatsync.org

**Support URL:**
https://heatsync.org

**Privacy Policy URL:**
https://heatsync.org/privacy.html#extension

---

## Chrome Web Store

**Name:** heatsync

**Summary (132 chars max):**
Use your custom heatsync emotes in Twitch and Kick chat. Unlimited slots, syncs across devices, includes BTTV/FFZ/7TV.

**Description:**
Use your heatsync emotes directly in Twitch and Kick chat.

heatsync gives you unlimited emote slots that work across both platforms. Upload any image to heatsync.org, and this extension makes them appear in chat whenever you or others type the emote name.

What it does:
• Replaces emote names with images in Twitch and Kick chat
• Tab-completion for emote names in chat input
• Shows BTTV, FFZ, and 7TV emotes automatically
• Click emotes to add them to your set
• Right-click any emote to block it (syncs across devices)
• Real-time sync when you use emotes

How to use:
1. Log in at heatsync.org with Twitch or Kick
2. Upload emotes to your set
3. Install this extension
4. Open any Twitch or Kick stream
5. Your emotes now work in chat

No tracking, no ads, no data selling. Just emotes.

Source code: https://github.com/mellen9999/heatsync

**Category:**
Social & Communication

**Language:**
English

**Privacy Policy URL:**
https://heatsync.org/privacy.html#extension

---

## Permission Justifications

**Chrome:**
- storage: Save emote set and encrypted auth token locally
- tabs: Send emote updates to all open Twitch/Kick tabs
- Host permissions (twitch.tv, kick.com): Content scripts inject emotes into chat messages
- Host permissions (heatsync.org): Fetch emote set, authenticate, WebSocket sync
- Host permissions (betterttv, frankerfacez, 7tv): Load third-party global emotes
- Host permissions (decapi.me): Resolve Twitch usernames to IDs for 7TV emote lookup

**Firefox (additional):**
- webRequest, webRequestBlocking: Intercept and redirect FFZ-style emote image URLs to correct CDN paths (scoped to static-cdn.jtvnw.net only)

---

## Screenshots Needed

1. Twitch chat with heatsync emotes visible
2. Kick chat with heatsync emotes visible
3. Right-click menu showing "block emote" option
4. The heatsync.org emote set page
5. (Optional) Before/after comparison of chat with extension

Screenshot size: 1280x800 or 640x400 minimum
