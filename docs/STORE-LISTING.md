# store listing — source of truth (CWS + AMO)

paste-ready copy and per-store limits. `scripts/amo-update-listing.js` reads the two fenced blocks below, so keep their headings. permission justifications and reviewer notes: [AMO-REVIEW-NOTES.md](./AMO-REVIEW-NOTES.md).

## rules
- lead with multichat: it pays off for one user alone on install. portable emotes are partly social, so they come second.
- every field carries `twitch`, `kick`, `youtube`, `chat` — store search reads the name and short description.
- never market permissions, code quality or security. trust copy stays a footer line.
- no versions, dates or counts that drift.

## name and short description (localized, `manifest_name` + `manifest_description`, all 34 locales)
- name: bare `heatsync` (en value). the toolbar name is the same via `short_name`.
- short description (CWS limit 132, AMO manifest description), en value:
```
one panel for twitch, kick + youtube live chat. plus a free 5,000-slot emote inventory that follows you into any channel
```

## AMO Summary (dashboard, ≤250, paste-ready)
```
twitch, kick + youtube live chat in one tabbed panel — per-channel tabs, mentions, whispers, no account needed to read. plus your own emotes in any channel: 5,000 free slots, one-click 7tv/bttv/ffz import. free, open source.
```

## AMO / CWS Description (long, identical for both stores, paste-ready)
No versions, sizes or dates in copy. 5,000 is `MAX_EMOTES_PER_SOURCE` in `src/lib/config.js`, guarded by `tests/config.test.js`.
```
twitch, kick + youtube live chat in one panel — read every stream you follow and reply into any of them without alt-tabbing. nobody else has to install anything. plus your own emotes in any channel: 5,000 free slots, no sub, no streamer setup. free.

• cross-platform multichat — twitch, kick + youtube live chat in one tabbed panel: per-channel tabs, mentions, twitch whispers, resizable + dockable to any edge. no account needed to read.

• your emotes, any channel — upload or import any emote (7tv, bttv, ffz, or your own) into a free 5,000-slot inventory. tab-complete a name and send — it renders in twitch + kick native chat and the overlay, any channel. one click imports a whole channel's emotes.

• 7tv / bttv / ffz — emotes, paints + badges render automatically, channel and global. runs alongside those extensions — this adds the portable emotes and cross-platform chat they don't do.

• keyboard-first — vim keybindings on twitch, kick + the panel, wysiwyg emote composer, message history, reply threading, instant filter of the live buffer by text or user.

• moderation + profiles — hover mod toolbar (ban/timeout/unban/delete), client-side automod, mute or block that carries a user across twitch and kick, profile cards with a searchable chat-log archive, one-click twitch clips.

free · open source (MIT) · no ads, no third-party analytics · your emotes stay yours
```

## tags / categories
- cws category: social & communication
- cws tags: `chat, streaming, twitch, kick, youtube, emotes, 7tv`
- amo tags are a fixed vocabulary (`kick`, `emotes`, `7tv` don't exist): `chat, social media, streaming, twitch, youtube`

## submit checklist
- [ ] `bun run build.js --package` green (build, `node --check`, zips, source zip, tests)
- [ ] cws: short description comes from the manifest; paste the long description; set tags
- [ ] amo: attach `dist/heatsync-source-X.Y.Z.zip`; paste the reviewer notes from AMO-REVIEW-NOTES
- [ ] amo data form must match the manifest `data_collection_permissions`: authentication info (collected + transmitted to heatsync.org for emote/account sync, plus the synced account data), and technical and interaction data (optional) for the rotating-id health check-in (see the [privacy policy](https://heatsync.org/legal/privacy)). also first-party: hovered chat links go to heatsync.org/api/link-preview (fetched server-side), and open channel names go to heatsync.org so the archive knows what to record. never "no data collected". no third-party sharing or analytics. twitch/kick cookies are read locally and never sent to us.
- non-en amo summaries are pushed separately: `bun scripts/publish.js --sync-summaries --publish`
