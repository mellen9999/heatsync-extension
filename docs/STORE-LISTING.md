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
twitch, kick + youtube live chat in one panel — read all your channels at once and reply into any of them without alt-tabbing. a streamer live on all three is one tab. plus your own emotes in any channel: 5,000 free slots, no sub, no streamer setup. other heatsync users see them; everyone else sees the plain name. free.

• cross-platform multichat — twitch, kick + youtube live chat in one tabbed panel: a tab per channel, or one per streamer with all three chats merged. mentions + whispers tabs, a live-follows list, and an import of your twitch + kick follows. resize it, dock it to any edge, or pop it out. no account needed to read.

• your emotes, any channel — upload or import any emote (7tv, bttv, ffz, or your own) into a free 5,000-slot inventory that works in twitch + kick's own chat and in the panel, any channel. tab-complete any 7tv emote and send it — it's added for you. one click copies a whole channel's emotes. gifs + emoji in the picker.

• 7tv / bttv / ffz built in — their emotes, paints + badges render on their own, channel, global and personal. no other extension needed.

• keyboard-first — emotes turn into pictures as you type, message history, replies, and a search box that narrows live chat to a word or @name. opt-in vim keys in every chat box: twitch, kick, youtube + the panel.

• moderation + people — hover mod buttons you pick (delete, timeouts, purge, ban, unban), twitch's automod queue, mod tools (shield mode, unban requests, blocked terms) and a mod log. profile cards with followage, badges, pronouns, private notes and chat history. mute or block follows a person's linked accounts. one-click clips of live twitch streams.

• stream events + filters — going live, raids, hype trains, subs, redeems, predictions, polls, youtube super chats + memberships, each one toggleable. filter rules highlight or hide chat by word, user, badge or kind. channel points claim themselves on twitch.

free · open source (MIT) · no ads, no third-party analytics · your emotes stay yours
```

## translated long description
`docs/store-description/<locale>.txt` holds the long description above in each `_locales` language (edge add-ons shows one per listing language). when the english block changes, re-translate these in the same commit.

## tags / categories
- cws category: social & communication
- cws tags: `chat, streaming, twitch, kick, youtube, emotes, 7tv`
- edge category: social; edge search terms (english listing, ≤7): `twitch chat, kick chat, youtube live chat, multichat, 7tv emotes, bttv, ffz`
- amo tags are a fixed vocabulary (`kick`, `emotes`, `7tv` don't exist): `chat, social media, streaming, twitch, youtube`

## submit checklist
- [ ] `bun run build.js --package` green (build, `node --check`, zips, source zip, tests)
- [ ] screenshots: `bun run shots:store` writes the five 1280x800 shots (fixture data only, in this listing's order) to `store-assets/cws-ready-2026-11/`; look at each before uploading to cws, edge and amo
- [ ] cws: short description comes from the manifest; paste the long description; set tags
- [ ] amo: `scripts/publish.js` attaches `dist/heatsync-source-X.Y.Z.zip` and sends the build steps as reviewer notes; AMO-REVIEW-NOTES has the rest for a reviewer's question
- [ ] amo data form must match the manifest `data_collection_permissions` (category list in `docs/AMO-REVIEW-NOTES.md`): required authentication info, personal communications (dms, whispers, posts, the sent-line report), browsing activity (the open channel) and website content (chat links for previews); optional technical and interaction data for the rotating-id check-in. never "no data collected". no third-party sharing or analytics. twitch/kick/youtube cookies are read locally and never sent to us.
- non-en amo summaries are pushed separately: `bun scripts/publish.js --sync-summaries --publish`
