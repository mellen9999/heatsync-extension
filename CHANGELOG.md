# changelog

## [unreleased]

### fixed
- **your paints show up on youtube chat again** — heatsync paints stopped rendering on native youtube chat on august 16 and every name has been plain since.
- **removing, renaming and moving an emote stop saying they failed** — the change went through and the panel reported an error anyway. importing a set left the button stuck on "imported N" instead of resetting.
- **tab-completing an emote outside the dropdown works** — cycling with tab when twitch's own list wasn't showing inserted nothing at all.
- **the extension stops looking signed out** — if twitch's name cookie was missing, the extension reported no login at all rather than falling back to the account you're actually signed in as.
- **"retry" on a failed emote load does something** — the button in the picker's error state was inert, so the only way out was closing the panel and reopening it.
- **the toolbar badge clears when you read your notifications** — heatsync.org already told the extension you'd read them; the extension wasn't listening, so the count sat there until the next reconnect.

## [1.7.63] — 2026-08-23

### added
- **a simulcaster's youtube chat merges by itself** — open a channel that also streams on youtube and [Y] messages flow with zero setup; the link resolves from the channel's verified identity instead of waiting for you to paste a url in edit-live-platforms.
- **replies show what they're replying to** — the reply line sits on its own row above the message with a snippet of the quoted text, clipped to one line so it never makes the row taller than that.

### fixed
- **popout chat stops freezing until you refresh** — everything that recovered a frozen tab waited on one browser signal that popout windows can miss; focusing the window now wakes it too, and the extension's background page nudges tabs it can prove are on screen.
- **an automod action that already happened stops reading "action failed"** — approving a message another mod (or an earlier click) already handled now settles the row as expired, and it can't come back on refresh.
- **"resolving…" resolves** — approving or denying a held message flipped the row only when a confirmation broadcast arrived, and a missed broadcast left it stuck forever. the action succeeding is the confirmation now.
- **profile hovers stop claiming nobody follows the channel** — twitch cut off the server's view of follow relationships; followage now resolves from your own browser, which twitch still answers.

## [1.7.62] — 2026-08-20

### fixed
- **the sub-anniversary share button actually shares** — clicking share on your "it's your N months" callout looked like it worked, but nothing ever reached chat and the callout came back on the next reload. it now completes the share itself, with whatever you type as the message.
- **the watch-streak callout shares the same way** — your words became a separate plain message next to twitch's stock celebration instead of being the celebration.
- **a share that can't go through says so** — it used to close the prompt and go quiet.

## [1.7.61] — 2026-08-20

### added
- **the automod queue is there when you open it** — held messages only existed in the moment they arrived: open the pane afterwards, or just refresh, and it was empty while twitch was still holding them. the queue now loads whatever is still held, so it's something you can come back to.
- **paints update while you watch** — a name kept whatever paint it had when its message rendered, so a new one didn't appear and a cleared one never came off. they change in place now.
- **the keyboard cursor has its own colour** — in the emoji, mention and slash menus the row your arrow keys were on looked exactly like the row under your mouse, so with the pointer near the list you couldn't tell what enter would pick. the keyboard's row is orange now, the mouse's stays white.

### fixed
- **held messages stay actionable for the full hour** — the queue greyed them out after six minutes, while twitch keeps accepting allow and deny for sixty.
- **"needs a twitch relink" stops appearing when your twitch link is fine** — a signed-out heatsync session, a mod role you no longer have, and a permission twitch was only missing all reported themselves as a twitch relink, which relinking could never fix. each one says what it actually is.
- **a first-time chatter is purple again — and only them** — someone's first message of the session used the same colour as twitch's real first-message-ever announcement, so every regular's opening line looked like a newcomer and the one row that mattered was buried. that highlight is yellow now.
- **a lapsed plus stops rendering cosmetics** — paints and tenure kept showing on a subscription that had already ended.
- **a fresh install sees real posts** — a brand-new, logged-out install landed on "log in to see your home" with nothing behind it, instead of the feed it's there to show.

## [1.7.60] — 2026-08-16

### added
- **quote a message** — quoting now drops a citation of the original into your composer instead of pasting its text back in, so your reply stays yours and the line you're answering stays attached to it.
- **predictions and polls get the whole chat area** — a running prediction or poll used a cramped strip; it now takes the full width, so the options and the totals are actually readable while they move.

### fixed
- **name paints match the site again** — the paint compiler had drifted out of sync with heatsync's: names were being chopped up letter by letter, the animation had stopped, gradients washed the glyphs out, and the rim never reached gradient fills. paints render the way they were designed to again, on all seven planes.
- **paints stop burning battery off-screen** — a name that has scrolled out of view kept animating. it doesn't now, which matters most on a laptop with several chats open.
- **the broadcaster can start a prediction** — starting one from the extension failed for the person who owns the channel, which is the only person who can start one.
- **native chat comes back by itself** — the safety switch that hands control back to the site's own chat could trip and never release, leaving you without either. it recovers on its own now.
- **discovery stops looking empty** — two filters were both applied on the way in, so the feed could show nothing while there was plenty to show.
- **citing a twitch message** — the cite action did nothing on twitch rows specifically.
- **your own reply keeps its reply bar on kick and youtube** — the bar showing what you replied to vanished from your own message right after you sent it.
- **highlight sounds fire on youtube** — a highlight rule with a sound played on twitch and kick but stayed silent on youtube.
- **sharing a resub** — the share token moved; it is found again when you click share rather than only when the prompt first appears.
- **the reply and thread chips stop smearing cozette** — the bitmap font was being drawn off its pixel grid on those two chips, so the text looked blurred next to everything around it.
- **the overlay stops declaring a colour scheme on pages it doesn't own** — that declaration could push a host page's own theme around.

## [1.7.52 – 1.7.59] — 2026-08-12 → 2026-08-13

a run of same-day builds; grouped here because they shipped as one body of work.

### added
- **a button for starting a thread** — thread creation was a slash command you had to already know about. it's a control in the composer now.
- **typing while reading chat lands in the composer** — you no longer have to click into the box first; start typing anywhere in chat and the keystrokes go where you meant them.
- **the reply pill looks like the button it always was** — it was already clickable and didn't look it.

### fixed
- **pasting an image url no longer turns into a slash command** — a relative url pasted into the composer was read as a command by the platform. the relay keeps it absolute.
- **"first message" only means twitch's real first-message-ever** — the label was appearing on messages that weren't one.
- **the resub prompt stops hijacking share when it can't finish the job** — if we couldn't actually complete the share, we now leave twitch's own flow alone instead of taking it over and failing.
- **highlights say what they mean** — a highlighted message was only a colour, with nothing telling you which of your rules matched.
- **a docked notification can't collapse off-screen** — it could end up somewhere you had no way to reach or dismiss.
- **a reply to you keeps its arrow and its red** — tapping fast enough could win a race against the render and strip both.
- **automod stops telling you to relink twitch** — an expired session was being reported as a broken link, so people relinked an account that was fine. it just refreshes now.
- **a late message lands at the bottom** — a message that arrived out of order was inserted mid-scrollback, where you'd never see it.
- **inline reply context in multichat** — replies show what they're replying to, the way the site does.

## [1.7.51] — 2026-08-12

### fixed
- **an empty composer shows no caret, and modifiers stop rewriting your spacing** — the cursor sat in a box with nothing in it, and applying a modifier quietly reflowed the spaces you'd typed.
- **a modifier attaches to the emote it actually touches** — it could bind to a neighbouring emote instead of the one you put it on.
- **history fetches the depth the server actually serves** — the extension asked for more backfill than the archive would return, so it read the short answer as the end of history.
- **viewer-relative emote labels, and portrait cards for shorts** — emote labels now read from your side rather than the sender's, and vertical streams get a card shaped like the video instead of a letterboxed one.

## [1.7.50] — 2026-08-11

### added
- **feedback / bug report from the popup** — a `feedback` link in the popup footer opens a small form; reports land on heatsync with your extension version and platform attached, so "it's broke" comes with enough context to fix. works signed out too.

### fixed
- **missing single-word messages in twitch history** — history lines whose whole message is one word arrive in a colon-less form the parser treated as malformed and dropped. they parse now, so short messages ("W", "LULW") stop vanishing from backfilled history.

## [1.7.49] — 2026-08-09

### fixed
- **the white-rectangle stream on firefox** — a fix meant purely for chrome's own dark-mode override was running on firefox too, where it doesn't apply and only hurt: it stamped the whole host page as dark, which could collapse the player into a blank white block. firefox never gets that stamp now. chrome is unaffected.

## [1.7.48] — 2026-08-09

### fixed
- **firefox direct installs update themselves now** — the `.xpi` you download from github had no update channel wired up, so it stayed on whatever version you installed forever. it now checks for and installs new versions on its own, like the store build does. (installs made before this one still have to be updated by hand once.)
- **pasting an image into the composer** — it failed every time with "upload failed: network error" on twitch, kick and youtube. the upload took a route the browser blocks from a stream page; it goes through the extension proper now. the percentage is gone in exchange — it says "uploading…" instead.
- **hover preview is actually 4x** — wide emotes previewed at well under 4x on twitch's own chat because the preview was capped at 128px. it now scales off the emote's real size, matching the panel.
- **common words stopped turning into mention links** — one person typing "@you" made every plain "you" in every channel a bold coloured link for the rest of the session.

## [1.7.47] — 2026-08-08

### fixed
- **signed in but invisible** — your identity could be fetched and then dropped, leaving you logged in with nothing that knows who you are: no red mentions, no "replied to you", no mention pings, and no message saying why. it sticks now, and an expired session logs you out cleanly instead of parking you in that state.
- **"replying to" bar on twitch** — a reply to you lost its reply bar (and its red) whenever the same message arrived from the page before it arrived from chat.
- **kick reply threads** — the reply id was read under a name kick never sends, which killed reply-thread hover on kick and lost the link in the archive.
- **blank player on a channel page** — the guard that keeps the stream from collapsing was switched off on exactly the page that has a player, whenever twitch's right column overflowed.

## [1.7.46] — 2026-08-07

### fixed
- **hiding twitch's native chat could break the stream** — with native chat hidden, twitch demoted the video into a white rectangle at the bottom of the page. two of our own features breaking the stream between them; almost certainly the "extension breaks the stream / white screen" report.

## [1.7.45] — 2026-08-07

### fixed
- **the extension can no longer leave you with a blank stream** — our player positioning races the platform's own layout code (ad breaks, theatre flips, page nav, resize), and when it lost, the player collapsed to nothing — a white rectangle on a light theme. instead of fighting that race with more css, it now watches the result and, if the player stays broken, drops our geometry and lets the platform lay itself out. worst case chat docks somewhere less pretty; never a blank player.
- **a native reply to you counts as a mention** — on every platform, not just some.
- **@mention hover shows the right platform's profile** — it was looking the person up on the sender's platform.
- **`Tab` applies modifiers again** — typing `w!` or `ffzLeave` onto the previous emote had stopped working.
- **animated emote modifiers follow your animation setting**, and the picker fills the chat box again.
- **resub celebrations stopped drawing twice.**
- youtube links without a host get a playable card instead of plain text; the "N new" jump button is yellow rather than brand orange; non-playable chat cards take the white plate on hover; hovering an emote no longer re-parents the preview on every mouse move.

## [1.7.44] — 2026-08-06

### fixed
- **the extension lets go of its memory again** — with no twitch, kick or youtube tab open, four background timers still woke it every few seconds, so it never shut down and held its whole heap for as long as the browser was running. it now goes fully idle with no stream open and wakes back up the moment you open one.
- **kick's own chat popout** — it briefly drew the docked side-column in a chat-sized window before settling, and the tab strip sat in the wrong place. chat now fills the popout from the first frame.
- **no leftover panel when you disable the extension** — turning it off on kick or twitch left a dead heatsync panel sitting in the page until you reloaded.

## [1.7.43] — 2026-08-05

### fixed
- **a connecting chat says so** — a channel you just opened showed "no messages yet" while it was still wiring up, which read as a dead extension for the first 15-25 seconds. it now says "connecting…" until chat actually lands, and only says "no messages yet" once it's connected and the channel really is quiet.
- **dark pages stay dark** — twitch, kick and youtube no longer get double-inverted by chrome's auto-dark, and the overlay shields itself per element, so strips and dark emotes stop painting white.
- **the selected live tab looks selected** — the active tab takes the white highlight in-page and in the popout, instead of reading as unselected grey.
- **simulcast folds to one row** — a stream running on twitch and kick at once collapses into a single `[H]` row, including legs that arrive out of order or replay at hydration.
- **emote picker search** — dropped bttv results; their search api went auth-only and returned nothing.

## [1.7.42] — 2026-08-03

### fixed
- **`\` hides chat in this tab only** — hiding chat on one stream no longer hides it on every other open tab. the hidden state sticks to the tab (survives reload) and clears when you close it; an old globally-stuck hidden chat heals itself on first load.

## [1.7.39] — 2026-07-27

### fixed
- **blocked emotes stay blocked** — hovering one no longer previewed the real image at 4x, tab-cycling no longer flashed it back into view, and typing a modifier onto the end of the name (`Emotew!`, `EmoteffzX`) no longer slipped past the block. blocks now match on the emote's id too, so the same emote re-listed under a different name in another channel is still blocked.
- **content filters reach every surface** — the feed, thread view, kick's native emote form, the chat-logs panel, and the emote autocomplete all honor your hidden-content settings now; they previously only applied in chat.
- **7tv's own sexual-content flag is respected** — it was fetched and then dropped before render.
- **blocked emotes on kick's native chat** — they were unblockable there.

### changed
- fresh installs connect immediately instead of waiting out an anti-thundering-herd delay meant for auto-updates.
- a new install starts on the live tab, with feed/whispers/mentions/modlog hidden until you sign in.
- a version gate or kill switch now says so on screen instead of silently doing nothing, and stops applying after 24h so a bad value can't brick an install.
- a twitch channel that fails to join can be retried instead of staying permanently empty, and tells you.
- channel-list save failures surface instead of silently reverting on reload.

### performance
- chat no longer accumulates emote layout work while the tab is in the background — that queue could grow all stream and then stall the frame when you came back.
- cheaper per-message text handling on the hot render path.

## [1.7.38] — 2026-07-27

### added
- **typed mod commands work on youtube now** — /ban, /timeout, and /unban reach youtube chats (they were right-click-menu only before). targets the person's most recent message; if they haven't spoken recently you get a clear pointer to the message menu instead of a silent no-op.
- **vi-mode in youtube's own chat box** — the vim editing layer now covers youtube's native input, matching twitch and kick.

### fixed
- **fullscreen on kick no longer leaves a dead gap** — the chat panel's page inset is fully released while anything is fullscreen, same treatment twitch and youtube already had.
- **youtube shorts left alone** — shorts pages no longer get squeezed by the chat panel (they have no live chat and the panel overlapped the like/comment buttons). the shorts shelf on your home feed is also only hidden when heatsync's non-live chat takeover is on — opt out and your youtube stays untouched.

## [1.7.37] — 2026-07-24

### added
- **everyone sees each other's emotes instantly** — the emotes someone uses now ride along with their message, so they render for you the moment it lands instead of after a delay (or as plain text). works across twitch, kick, and youtube.

### fixed
- **not logged in? we tell you now** — using an emote while signed out of heatsync used to silently fail and look broken. you get a clear one-tap "log in" prompt instead.
- clicking someone else's emote to reuse it always renders in your own message now, even if it hadn't saved to your set yet.

## [1.7.33] — 2026-07-22

### added
- **audio and video links play right in the chat row** — no panel, no leaving the page. anything with real controls gets pause and volume where you'd expect them, and the play mark sits on the artwork instead of beside it.

### fixed
- **youtube moderation was unreachable** — the controls existed but nothing could get to them.
- **links that chat actually posts now linkify** — the host-less forms (`heatsync.org/x`, bare `www.`) were being left as plain text.
- the hashtag, mention and thread-reference passes could break a link they ran over.
- twitch commands that no longer exist are refused instead of being chatted out as plain text.
- the wheel is no longer hijacked on youtube shorts and hover-preview players.
- kick pop-out chat fills its window instead of docking to a 340px column.

## [1.7.32] — 2026-07-21

### fixed
- **kick: any script running on kick.com could forge chat messages and mod actions** through the extension's page bridge. it now verifies the sender.
- **text typed after an emote was blurry instead of bitmap-crisp.** a non-square emote scaled to row height has a fractional width, so every character after it landed off the pixel grid — measured at 0.625px out. all four ways a chip can enter the composer now snap it to a whole pixel.
- **emote modifiers went the wrong way for betterttv.** bttv puts the modifier BEFORE the emote (`c! Kappa`) and ffz puts it AFTER (`Kappa ffzX`) — we applied everything backwards, so a bttv user's `c! Kappa` showed a stray `c!` and an unmodified emote. each token now binds the way its own provider binds it, and the "wrong" order still works when there's no ambiguity.
- push notification unsubscribe used the wrong http method and always failed.
- raw message keys (`mc_input_send_channel`) could leak into the ui when a value was still resolving.

### added
- **hovering a stacked or modified emote now shows the whole recipe** — base, every overlay, and the modifiers in the order they were applied, each coloured by the provider it came from.

## [1.7.31] — 2026-07-21

### fixed
- **/highlight could charge your bits twice.** a slow network made the send report "failed" while twitch had already taken the payment; sending again bought a second highlight. the purchase is now idempotent, and an unconfirmed send says so instead of inviting a resend.
- **kick emotes you sent showed up as plain words to everyone else** — heatsync rendered them for you, so it looked fine from your side. they now go out in kick's own format, and a rejected emote falls back to text rather than dropping the whole message.
- **mod actions blamed the wrong thing on a network blip** — ban/timeout/unban/delete/announce said "channel not found" for any hiccup, which reads as "this channel doesn't exist". transient failures now say to try again.
- **blocking an emote said "blocked" before the server agreed.** a rejected block silently reverted later with no explanation; it now confirms, and rolls back with a reason if it fails. same fix on the picker and on block-all.
- **raw message keys leaked into the ui** (e.g. `mc_input_send_channel` in the composer) whenever a value was still resolving.
- youtube chat that never loads now says so instead of sitting blank, and youtube mod errors read as english rather than codes like `message_not_found`.
- a youtube tab added from a video link no longer shows `watch?v=…` as its name; duplicate youtube channels are rejected like twitch and kick already were.
- deleting your own post, following from a card, and mod-card actions no longer fail in silence.
- kick: theatre mode is detected again (kick moved the flag) and the player controls no longer hide under the panel.
- kick: a send that times out is reported as unconfirmed instead of being retried into a double post.

### added
- **chat modes from the composer** — `/slow` and `/followers` on twitch and kick, plus `/subscribers` and `/emoteonly` on kick. every change is confirmed against the channel afterwards, so a command only reports success when the mode really changed.
- **kick subs, gift subs, pinned messages and KICKs gifts now appear** for every channel, not just the few covered by the server relay.

## [1.7.29] — 2026-07-18

### added
- **automod hold queue** — held messages appear inline in the channel tab with one-click allow/deny for mods (opt-in via relink).
- **emote suggestions while typing** — matching emotes pop up on bare words, without a trigger character; enter/tab only navigate after you arrow into the list.
- **emote provider priority setting** — choose which provider wins on name clashes (7tv / ffz / bttv).
- **scroll-wheel volume** on the player.
- **vim n/N cycling** through in-tab search matches.

### fixed
- **messages never reorder or flash** — settings changes (including ones synced from another tab) used to rebuild the whole chat list in a fresh order; rows now update in place and keep their position, scroll, and stripes.
- kick chat-mode banners survive background restarts of the extension; the first flip after a browser start no longer goes missing twice.
- youtube replies no longer double the author's @ in the mention.
- extension pages of other kick/twitch subdomains (creator dashboard etc.) no longer get mistaken for channels.
- history replay on reload is chunked — no more multi-second freeze on fat backlogs.
- rapid-fire lifecycle races (per-instance listener guards, automod init resilience).

## [1.7.28] — 2026-07-17

### fixed
- **chat no longer flickers or smears during scroll** — root-caused a gpu compositing race between animated emotes and scroll; the message list now paints on one stable layer.

### added
- **pronouns on the user card + hover** (via pronoundb).
- **bulk moderation** — mods can select multiple messages and timeout/ban them in one action (select mode via right-click or the `s` hotkey, shift-click for a range, one confirm).

## [1.7.27] — 2026-07-17

### added
- **platform picker in the popout button** — pick twitch / kick / youtube for a bare channel name; a pasted url still auto-detects the platform.
- **kick native channel emotes** now load into the channel pool, picker and tab-complete.
- **kick & youtube history backfill** — joining a kick or youtube channel replays real recent chat from the heatsync archive.

### changed
- emotes other people add to their set now show up for everyone faster (propagation window halved).
- own posted emotes respect their owner's content warnings; filter-hidden emotes render a labeled placeholder instead of raw text.
- channel emotes survive an extension reload and rank higher in tab-complete; the emote catalog pages instead of wrapping.
- the live tab is labeled with its channel, and auto-live reads as selected.

### fixed
- kick page-side fallback chat so a dropped socket keeps chat flowing and the youtube tap reaches every surface.
- kick chat-mode banners (slow / sub-only / emote-only / followers).
- tab / enter reliably keep composer focus for rapid-fire sending.

## [1.7.20] — 2026-07-08

### fixed
- **reply context in popout chat** — replies now show the "replying to" bar in popout and on throttled connections (the native-chat tap was dropping the reply parent).
- **whisper vs dm label** — inline twitch whispers read `[whisper]`; heatsync dms stay `[DM]` (both used to say `[DM]`).

## [1.7.13] — 2026-07-02

### added
- **¶ permalink on 🔥 heat-spike rows** — every moment alert links its shareable heatsync.org/moment page (real chat, real emotes, no install needed to view).

### changed
- **welcome page** — the try-it button now opens the busiest live channel instead of the twitch front page, and the copy leads with what's true: emotes render instantly, no sign-in; the 5,000-slot inventory is the optional upgrade.

## [1.7.9] — 2026-06-29

### added
- **vim buffer nav in the overlay** — `v` selects a range of messages (copy text, copy permalinks, quote); `f` paints hint labels to keyboard-click usernames, links and emotes; with a mode-line indicator. opt-in behind the vi-mode setting.
- **mod-log tab** — a streamer-popout log of mod actions (ban / timeout / unban / delete across channels) you can drag to a second monitor or OBS.
- **per-user purge + configurable ban-reason chips**, and an opt-in **confirm-before-ban** misclick guard.
- **alt+1..9 / alt+[ ] tab navigation** in the overlay.
- **regex + match-count chat search**, plus a **per-rule filter / highlight engine** for live chat.
- **youtube cross-platform aliases** for mute / block.

### changed
- right-click an owned emote now removes it from your set.

### fixed
- firefox: serve 7TV webp where animated avif froze; correct firefox detection.
- emotes: restore cold-start channel-emote hydration; native badges render in place without a rebuild flash.
- security: nonce-gate page hooks, verify the auth token before adopting it, and lock the hardened CSP against silent weakening.

## [1.7.8] — 2026-06-28

### changed
- **re-cut release** — rebuilt to clear a duplicate-1.7.7 upload conflict on amo. no functional change from 1.7.7.

## [1.7.7] — 2026-06-27

### added
- **unified cross-platform mod suite** — ban / timeout / unban / delete plus /followers and chat-mode commands now work the same across twitch and kick, with mod-status gating and reason support.
- **instant mod feedback** — self-initiated mod actions show an immediate gray notice instead of waiting for the round-trip.
- **inline media embeds** — links in live chat render inline (op-only in the following timeline; chat embeds never iframe, to stay light).

### changed
- **following tab** — shows op posts only; the moments band is gone.
- **removed lite / emotes-only mode** — it was buggy and unwanted; the overlay always boots now.
- **removed native-chat escape hatch (⇄) and ⚡ stream-actions button** — too fragile / couldn't work while heatsync replaces native chat.
- **native-chat reliability** — panel collapses cleanly on boot in every chat position, the emote picker fills its space, and the resize bar no longer overlaps native ui.

### fixed
- **blocked users can no longer ping or reach you** — closed every path a blocked user could surface a mention or notification.
- **youtube** — the chat panel no longer appears on vods (chat-replay isn't live); native websocket persists across re-injects to stop reload double-wrap.
- **mentions buffer** — aligned the persisted-mentions cap with the message buffer (200 → 500) so older mentions survive.
- **7tv on kick** — allow hyphens in the kick slug lookup and validate the numeric id before caching.
- **hashtags** — stop magenta-tagging inside escaped html entities (e.g. `&#x27;`).
- **kick** — the docked channel-page chat no longer covers the top nav.

### security
- **deny-by-default csp** — explicit minimal allowlist instead of dropping `default-src`; allow `static-cdn.jtvnw.net` in `connect-src` for notification avatars.
- **websocket override** — must be a constructor, not an arrow fn (the early-inject override was throwing and killing native chat).

## [1.7.5] — 2026-06-21

### changed
- **wedge-first naming + copy** — the extension name, store listing, welcome screen, and logged-out prompts now lead with what heatsync does for you: your own emotes in any twitch, kick, or youtube chat. the short name stays "heatsync" for the toolbar.

## [1.7.4] — 2026-06-21

### fixed
- **youtube suggestions strip** — the opt-in "up next" strip showed an empty box with no thumbnails; the related videos load now. it also no longer floats on its own over normal (non-live) youtube where there's no chat, and the video no longer overshoots/clips or covers the strip after you resize the window.
- **collapse button** — switching channels no longer eats the collapse (`>`) button; it lives in the tab bar.
- **duplicate mod notices** — timeout/ban messages no longer repeat across the different chat connections.
- **copy message** — copying a chat message keeps the text around emotes intact and interleaved instead of dropping it.
- **chat reliability** — queued messages can't be sent to a channel you haven't joined yet; per-channel timers and caches are cleaned up on navigation so long sessions stay light.

### added
- **font size slider** — chat font size is a 10–22 slider in settings (replacing the F-/F+ buttons) and applies on first paint.
- **one-click channel import** — an empty inventory offers to pull in the current channel's emotes in one click.
- **moments band** — a live heat-spike band in the multichat feed surfaces what people are reacting to.

### changed
- status, loading, and error banners moved below the search/filter bar so they don't shove the input around on reload.
- performance: trimmed per-message render work (badges, paint, mute/block checks).

## [1.7.1] — 2026-06-15

### fixed
- **ffz modifier emotes** — `ffzW` now works as a wide modifier, and ffz modifier emotes (ffzW/ffzX/ffzY/ffzCursed…) no longer leak into the emote pool as broken placeholder images (they polluted the picker and broke overlay stacks).
- live channel dot is a quiet static dot again — dropped the pulse.

## [1.7.0] — 2026-06-15

### fixed
- **cross-platform emote collision** — a streamer simulcasting under the same name on twitch and kick no longer has one platform's channel emotes overwrite the other's. each platform keeps its own set; the multichat panel merges both.
- **kick live emote updates** — adding or removing a 7tv emote on a kick channel now shows up live (the drift poll was hitting the wrong endpoint and 404ing every cycle).
- **cross-platform follow toggle** — the follow-on-kick toggle did nothing (it read the wrong storage). it works now.
- **stuck send indicator** — a send that fails (e.g. mid extension-update) no longer leaves the pending dot hanging forever.
- **whisper persistence** — dms no longer silently fail to save when storage is full.
- **popout chat** — the toolbar popout opens a normal window that tiles in tiling window managers, instead of a forced floating popup.

### added
- **live channel dot** — channel tabs now show a clear pulsing dot when that channel is live.
- **jankless avatars** — an initials placeholder reserves the avatar box immediately; the real picture swaps in with zero layout shift.

### changed
- **denser layout** — tighter input bar, popup, and welcome spacing; honors small windows.
- am/pm on 12-hour timestamps; the "fix dim usernames" toggle now applies without a reload.
- hardened banner-url handling; capped a 7tv id cache that grew over long sessions.

## [1.6.9] — 2026-06-08

### fixed
- **firefox install** — the github `.xpi` is now amo-signed, so it installs in normal release firefox. previous builds shipped an unsigned zip renamed to `.xpi`, which firefox refuses to install.

## [1.6.7] — 2026-06-03

### added
- **kick chat pusher tap** — full chat capture + render on kick channels the relay doesn't cover yet. Off without it; on, you get the whole channel's chat plus heatsync rendering. Now enabled by default.
- **per-category nsfw emote filter** — the single nsfw pill split into five independent toggles: sexual, gore, weapons, drugs, hate. Filter exactly what you want, default-on stays per-viewer.
- **right-click emoji → copy `:shortcode:`** and **shift+right-click emote → context menu** with provider link + view/copy.
- **settings import/export, mention cues, mod-anniversary callout, anti-features pack.**
- **full-card ambient banner** on the hover profile tooltip.
- **`emotes:refresh` WS event** — bulk inventory changes (mass add/remove) now render live instead of needing a reload.

### changed
- **design-system consistency pass** — square corners everywhere, hover and active states invert to white-on-black, 13px text floor, dropped trendy motion. Matches the terminal-density house style.
- **2-state picker** — right-click toggles block ↔ unblock only; dropped the owned/orange/remove ladder (~150 lines removed). Slot management lives on the panel picker + inventory page.
- **uniform emote hover** — white plate + darkened emote across picker, chat, native, and site; input chips use a drop-shadow halo so light emotes stay visible.
- **removed single-emote gigantify** — emote/emoji size is manual (1x/2x/4x) only; no content-based auto-enlarging.

### fixed
- **`/me` now sends a real action** on every platform (was plain text off twitch).
- **`heatsync-settings-changed` postMessage was attacker-callable** — now nonce-gated. (security)
- **`storage.sync` quota for `ui_settings`** was a silent failure — now handled.
- **exact emote name wins tab-complete** over a longer prefix match.
- **emoji context menu** was overwritten by the user/message menu.
- **white-on-white text** on settings + stream-banner hover.
- **picker click no-op** when an emote outlived its live cache; unresolvable picker emotes now seed from emote info.
- **kick position-based emotes** render in the chat-log viewer.
- **channel-first-message (purple)** outranks session-first-seen (yellow); **profile-card block** hides live messages immediately.
- **`ch?.kick` null-deref** that could freeze chat; hardened sent-echo dedup.
- **`minimum_chrome_version` set to 116** for reliable MV3 service-worker keepalive.

## [1.6.5] — 2026-05-29

### fixed
- **send reliability — fort knox v1**: WS keepalive, context-death detector, send retry with backoff, burst throttle, dual-send echo gating. Messages no longer silently drop after the service worker sleeps or the channel is auto-paired.
- **echo detection** broadened — own-name FIFO fallback when the send-echo text-match misses; silenced false-positive "no echo" and dual-send partial-failure toasts on auto-paired channels.
- **real status code on http errors** instead of a generic failure; silent auto-add on send.
- **duplicate twitch timeout/ban notice** — mods saw the line twice; deduped NOTICE + pending double-toast.
- **usernotice/sub emotes not rendering** — `tags.emotes` now extracted in both irc parsers.
- **reply stack** stayed open while the row scrolled off (was dismissing early); click the reply-pill to open a thread instead of auto-opening on hover.
- **expanded non-channel deny-list** — prod was subscribing to garbage paths.
- **tab-complete catalog quality** — ffz/bttv first, lowercase dedupe, prefix-only.
- **hide broken link-preview images** on load error; emoji-from-nest paste/stack round-trips back into the input.

### removed
- **15 dead settings toggles** + `debugLogging` (did nothing); restored `crossFollowKick`. Renamed misleading "anonymous chat" → "incognito".

## [1.6.4] — 2026-05-27

### changed
- **flagged-emote indicator: cyan `#00d7d7` → teal `#008080`** (xterm-256 #30, heatsync ANSI palette). Less attention-grabbing on busy chat surfaces, better fit with the muted indicator style elsewhere.
- **border scoped to decision surfaces only** — picker grid/search rows + input-bar chip keep the dashed border; chat-row rendering drops the border (the "·NSFW" tooltip suffix on hover still surfaces flag state). Reasoning: when a viewer deliberately opts in to see flagged emotes, painting a border on every one in chat is visual noise without useful signal. Border survives where you're MAKING DECISIONS about the emote (picker → add it, input chip → send it); it's gone where you're just READING.

### fixed
- **double border in picker** — CSS applied the border to both the picker `<span>` wrapper AND the inner `<img>`. Removed the wrapper selector; only the img paints now.

## [1.6.3] — 2026-05-27

### fixed
- **self-hosted emotes silently filtered from inventory** — `EMOTE_CDN_PATTERN` in chrome/background.js allowed `heatsync.org/uploads/*` but NOT `cdn.heatsync.org/uploads/*`. The server's `toAbsoluteEmoteUrl` rewrites `/uploads/` to the cdn subdomain for edge caching, so EVERY user upload was being rejected by `sanitizeEmote` and never made it into the ext's `emoteInventory`. Picker, popup, autocomplete all silently missing self-hosted emotes. The v1.6 NSFW flag worked correctly server-side — users just never saw their flagged emote in the ext because the emote itself was filtered out before the cyan border could paint.
- Pattern now: `cdn.(betterttv|7tv|frankerfacez|heatsync).net|app|com|org` + the existing host-allowlist entries.

## [1.6.2] — 2026-05-27

### fixed
- **profile-card hotkeys were dead** — the keydown handler queried `[data-pc-key]` but nothing set the attribute. Pressing `t/k/y/h/f/w/d/@/m/b/+` did nothing for ~every session this code shipped in. Now wired: `t/k/y/h` jump to twitch/kick/youtube/heatsync profile pills, `f` follow, `w` whisper, `d` dm, `@` mention, `m` mute, `b` block, `+` add channel.
- **crash telemetry toggle copy was misleading** — said "capture errors locally (never auto-uploaded)" implying the toggle controls capture. Capture runs unconditionally; the toggle only shows/hides the diagnostic panel. Relabeled "show diagnostic errors" with accurate tip — privacy promise unchanged, expectation now matches reality.

### related (server-side, deployed in heatsync@9353b61e — no client change required)
- **moderation cache no longer leaks trust-tier results across users** — trusted-user bypass at scanText was caching its `allow` result under sha256(text), so the next untrusted/banned caller inherited the free pass. Cache write removed for trust-based bypass; deterministic tier-0 results still cache (correct).
- **upload + emote-add now honor SIGHTENGINE_FAIL_CLOSED on scan throws** — previous try/catch logged the error and let the file through with `moderationResult=undefined`, inverting the env var. Now rejects + cleans the file when fail-closed mode is on.
- **cleanup.ts deletes from the right path** — previously resolved against cwd()/public; files lived at UPLOAD_DIR. Every delete ENOENT'd silently and disk grew unbounded.
- **phash dedup works on /uploads/** — added UPLOAD_DIR to candidate base paths; previously only checked /opt/heatsync/dist + cwd()/public, neither of which contained the actual files post-Caddyfile-fix.
- **upload.ts UPLOAD_DIR prod fallback aligned with Caddyfile** — defaults to /var/lib/heatsync/uploads when the env var is missing.

## [1.6.1] — 2026-05-27

### added
- **cross-tab / cross-device settings sync** — toggling the NSFW pill on any surface (tab, second laptop, future heatsync.org settings page) instantly mirrors on every other surface for that user. server PATCH commits the column then broadcasts `user_settings:update` over WS to every active connection. BG-side handler in chrome/background.js updates `viewerShowNsfw` + writes `chrome.storage.local`; existing `chrome.storage.onChanged` listener live-updates the visible toggle pill DOM in any open settings panel without a re-render.
- **chat repaints immediately on toggle** — `refresh_all` now also clears the sender-emote LRU cache so cross-user inventory sets re-fetch with the new `include_nsfw` param. Previously the 5min TTL would delay repaint.

### infrastructure
- **WSServerMessage union extended** — `{ type: 'user_settings:update', show_nsfw_emotes?: boolean, ts: number }`. Future column-stored prefs join the same payload shape (no schema migration when adding fields).
- **WS handler gate avoids double-action on origin tab** — `(msg.show_nsfw_emotes !== viewerShowNsfw)` short-circuits on the tab that initiated the PATCH (its local-write already updated state), so refresh_all only fires on receiving devices.

### v1.6 architectural direction (locked)
- ext multichat panel is the primary surface for content filter settings — not duplicated on heatsync.org
- new filter categories ship one-at-a-time as full features (server filter logic + UI toggle), never as placeholder UI
- sync layer added here applies automatically to every future toggle that lives on `users.*` columns

## [1.6.0] — 2026-05-27

### added
- **per-viewer NSFW emote filter** — emotes scored ≥0.7 confidence on sexual / gore SightEngine categories (the soft band below the existing 0.85 hard-ban / CSAM quarantine threshold) are now hidden by default. flip the toggle in ⚙ → filters → content to receive them; flagged emotes render with a 2px dashed cyan (#00d7d7) border and the tooltip suffixes " · NSFW" so you always know what's flagged for everyone else. weapon / drugs / offensive categories don't trigger the filter — too false-positive heavy.
- **own inventory always renders to you** — your own NSFW-flagged emotes always show in your set regardless of the toggle. the filter applies to other senders' emotes (cross-user rendering paths: `/api/users/:id/emotes`, `/api/users/emotes/batch`, `/api/emotes/user/:name`, `/api/emotes/hot`).
- **server settings endpoint** — `GET` / `PATCH /api/user/settings` for the `show_nsfw_emotes` boolean. lives on `users.show_nsfw_emotes` (direct column) rather than the `user_settings.settings` JSONB blob so the emote-fetch hot path can SELECT it without JSON-parse cost.

### infrastructure
- **migration 165** — emotes gains `nsfw_score REAL`, `nsfw_categories JSONB`, and `nsfw_flagged BOOLEAN GENERATED ALWAYS AS (...) STORED` + partial index on flagged=true. existing rows default to score=0 / categories={} until backfilled. users gains `show_nsfw_emotes BOOLEAN NOT NULL DEFAULT false`. the generated column casts the 0.7 threshold to REAL so exact-boundary rows flag correctly (REAL 0.7 → ~0.69999998 in double-precision space silently slides under).
- **scanImage now returns nsfw subcategory snapshot** — `ModerationResult` gains optional `nsfw_score` + `nsfw_categories` keys (`nudity_raw` / `nudity_partial` / `nudity_suggestive` / `sexual_activity` / `gore`). populated only by `parseImageResponse`; text-scan results leave them undefined. emote-add layer reads them off the modResult and persists.
- **self-hosted upload moderation reuse** — emote-add for `/uploads/` URLs now calls scanImage with `PUBLIC_URL`-prefixed URL so the cache key aligns with the upload-time scan; nsfw fields recover from cache without paying for a second SightEngine call.
- **backfill script** — `scripts/backfill-nsfw.ts` re-scans existing emotes via SightEngine and stamps the new columns. idempotent (`nsfw_categories = '{}'` is the "never scanned" marker — any real scan response writes at least one subcategory key). supports `--dry-run` for cost preview and `--limit=N` for bounded runs.

### scoped
- **source scope locked to self-hosted uploads only** — only emotes hosted by heatsync (`/uploads/`) flow through SightEngine. platform CDNs (Twitch / Kick / 7TV / BTTV / FFZ) trust upstream moderation — parallel scanning wasted API spend and would create policy conflicts with their moderators. v1.6 filter is "viewer control over content heatsync hosts", not "second-guess 7TV".

### audit pass (caught + fixed pre-release)
- **upload-time scans never actually ran** — pre-existing silent bug. `server/moderation/trusted-cdns.ts` included `heatsync.org`, so `scanImage('https://heatsync.org/uploads/...')` short-circuited to `allow` before reaching SightEngine. v1.6 would have inherited the bug — flagged emotes would have never been flagged because no scan ran. removed heatsync.org from the trusted list. cost delta: +$0.002 per genuine upload, zero per downstream reference (cache-by-URL-hash hits the upload-time scan).
- **dead ext settings UI removed** — the multichat ⚙ → filters subtab previously rendered 11 `allow_nsfw_*` toggles fetching `/api/user/settings` for a JSONB blob the server never returned. toggles stayed disabled forever, confusing UX. removed `_SERVER_FILTER_DEFS` + `_loadServerFilters` + `[data-server-setting]` handler. subtab now shows only the v1.6 content / NSFW toggle.
- **CORS allow-methods explicit list** — `@elysiajs/cors`'s per-path method discovery only saw the first endpoint registered at `/api/user/settings`, so PATCH preflight returned `Allow-Methods: GET` and silently denied PATCH requests client-side. fixed via explicit `methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS']` in the cors plugin config.
- **fragment-composition swapped for two-query split** — `/api/emotes/hot` + `/api/emotes/user/:name` used `const nsfwClause = sql\`AND NOT...\`` with the postgres.js fragment pattern. fine in prod (returns a Fragment), broke vitest's sql mock (returns a Promise → unhandled rejection in error-path tests). switched to inline conditional with two full SELECTs. trivial query duplication, deploy test gate passes again.

### deferred
- **channel emote filter (`/api/channel/:name/emotes`)** — external CDN-sourced (BTTV / FFZ / 7TV channel sets, not in our DB) so per-row `nsfw_flagged` is unavailable. filtering would require a per-URL DB JOIN that fights the 1h browser + 24h CF cache. NSFW emotes that get added to inventory via the auto-add-on-send flow then DO flow through the v1.6 filter on the cross-user path. revisit if NSFW slips through here at scale.
- **broader content filters (NSFW text, hate speech, violence, etc.)** — out of scope for v1.6. those settings belong on a heatsync.org settings page (user-account-level) rather than in the ext, since they affect feed posts / comments / bios across surfaces, not just chat. v1.7+ work.
- **backfill existing self-hosted emotes** — the 9 pre-v1.6 self-hosted uploads on prod have `nsfw_score=0` because the upload-time scan was a no-op (per the audit-pass bug). low-risk: existing rows render unfiltered (default-safe), and going forward every new upload is scanned. backfill via `bun scripts/backfill-nsfw.ts` on prod is optional polish, ~$0.018 for 9 rows.

## [1.5.4] — 2026-05-26

### perf
- **senderEmoteSets memory pressure on busy chats** — the cap was 5000 senders × Map<emoteName, emoteData> (typically 50-100 entries each). on xqc-tier channels (thousands of unique chatters firing per session) this dominated heap growth (~14 MB/sec → GC pauses every few seconds → video stutter + chat chunk + animated emotes freezing for ~1s). cap lowered to 500; evicted senders re-fetch their set on next message (small API hit, big memory win).
- **sender_emote_sets boot-load was uncapped** — even after lowering the live cap, the persisted store from prior versions still had ~5000 entries, and `loadSenderEmoteSets` restored all of them at boot — heap ~500 MB before any chat fired. now truncates the boot load to LRU max (keeps the most-recent 500 via insertion order) AND re-persists the truncated set so storage shrinks too.
- **persist debounce 500 ms → 4000 ms** — on busy chat the storage write fired 2× per second; each write serialized the whole map to JSON (~30-100 ms of main-thread blocking). 4s catches a session's adds before unload; visibilitychange-style flush still works.
- **persist body wrapped in requestIdleCallback** — JSON serialize + storage write now run between frames instead of competing with chat render. the 1-second animated-emote freezes during persist bursts should be gone.
- **7TV search perPage 200 → 60** — picker search was rendering 200 result imgs simultaneously, blasting cdn.7tv.app with concurrent fetches (CDN burst-dropped some, jank from 200-img layout pass). 60 is enough to find the emote you want; user can refine.

### fixed
- **picker tooltip flickered for ~1 frame on hover** — three compounding causes:
  1. the `mousemove` dismiss-guard didn't except the tooltip element itself, so when the 4× tooltip rendered under the cursor the next mousemove saw target=tooltip → onEmote=false → instant dismiss. added `target.closest('#hs-emote-tooltip')` + `#hs-badge-tooltip` exceptions.
  2. picker search/discover rows render as `.hs-discover-item` containing `.hs-discover-thumb` — the show path + dismiss-guard only recognized `.hs-mc-picker-emote-wrap` (grid). search hovers either fired no tooltip or fired then instantly dismissed. both paths now accept `.hs-discover-item` + `.hs-discover-thumb`.
  3. the document-level capture-phase scroll dismiss caught xqc-tier chat auto-scroll (continuous scroll events on the chat container), killing picker tooltips ~1 frame after they appeared. `heatsync_menu_scroll_dismiss` memory already documented this. removed the capture-phase scroll listener entirely; wheel events still dismiss intentional user scrolls.
- **stale `channel_emotes_map` cache corruption** — v1.5.3 stopped wiping channel_emotes_map on every ext reload (correctly, to preserve warm cache across upgrades). but long-corrupt entries from prior versions sat there orphaned — e.g. a Chatterino badge row leaked into `channelEmotesMap[xqc]` sometime in a past version and never got cleaned because no clean re-fetch ever ran. on xqc the picker showed exactly 1 emote ("Chatterino Supporter") and refetch never fired because the cold-cache trigger requires `length === 0`. added a one-time `migrated_emote_cache_v154` migration that wipes the cache on first v1.5.4 boot; `fetchChannelOwnerEmotes` repopulates per channel as visited.

### polish
- **C / T / F- / F+ / ⚙ / ⛶ util buttons rendered blurry** — Cozette is a bitmap font that needs the full crisp render block (`-webkit-font-smoothing: none`, `font-smooth: never`, `text-rendering: optimizeSpeed`, `font-feature-settings`) to render sharp at 13 px. the util buttons inherited the family but not the render block. additionally, `line-height: 1` (= 13 px) inside an 18 px box with `align-items: center` placed the glyph at a 2.5 px (half-pixel) offset — bitmap glyphs need integer-pixel baseline. switched to `line-height: 18px` (= box height) + `display: inline-block` + `text-align: center` so the baseline lands on an integer pixel. button dimensions unchanged (still 18 × 18).

## [1.5.3] — 2026-05-26

### changed
- welcome page rebuilt as a 3-step visual onboarding focused on the personal-emote-set wedge (replaces the prior 4-line landing). uses Cozette + i18n step keys; mobile-collapsing grid.
- copy reframe across acquisition surfaces (welcome page, README hero, store listing, reviewer notes): leads with "5000-slot personal emote set, no streamer approval, no subscription" and explicitly surfaces the left-click-to-add mechanic that was already in the code but never documented in user-facing copy. multichat reframed as supporting feature.
- welcome page wedge-critical strings (tagline, step 2 desc, step 3 title + desc) are hardcoded inline rather than pulled from `messages.json` — the new wedge framing renders for all locales without waiting on a 34-locale `messages.json` translation pass. `messages.json` keeps its prior strings for future i18n alignment.

### fixed
- **half emotes missing after ext reload** — `onInstalled` was wiping `channel_emotes_map` on every reload (incl. `reason='update'`). channel emotes (BTTV + FFZ + 7TV channel sets, heatsync per-channel sets) only refilled when the user clicked each multichat tab. cache now only nukes on first install; the existing 30-min TTL + per-fetch failure backdating already cover staleness.
- **twitch sends silently dropped with no feedback** — auth IRC was discarding `NOTICE` lines (msg-id=msg_followersonly/msg_subsonly/msg_slowmode/msg_duplicate/msg_banned/msg_rejected/etc). twitch sends these to the auth socket only — the bg anonymous socket never sees them — so the input would clear with no echo and no toast. now parses msg-id and shows a specific toast ("followers-only mode — follow the channel to chat", etc).
- **own messages not appearing until refresh** — `bg_irc_join` was using raw `chrome.runtime.sendMessage` (no cold-SW-wake retry). on SW eviction the join request silently dropped, BG never joined the channel, the auth socket's PRIVMSG echo never reached the multichat panel. now routes through `safeSendMessage` which retries on cold wake.
- **permanent silent send-drop after slow first join** — `joinChannel()` faked success on its 500ms timeout (`authState.joined.add(channel)`) without an actual JOIN ack. subsequent PRIVMSGs went to a never-joined channel and were dropped silently for the full WS lifetime. timeout now 2000ms (matches actual twitch JOIN ack distribution); on timeout we leave `joined` empty so the caller retries / queues / toasts.
- **cross-device seen-state didn't sync** — the `seen_update` WS forward (BG → tab) was handled inside `listenForSocialEvents()`, which only ran AFTER social/feed init. clears made on the website didn't reach the ext until the next event landed. registration moved to `seen-state.js` module load — fires before social init.
- **feed red dot blind on boot after sleep** — `latestAt.live` was bumped only on WS `new-message` events. opening the ext after hours of sleep with 12 unread feed posts produced no red dot until the 13th event arrived. now seeded from the newest post in the feed GET response when the feed loads.
- **anonymous-user seen-state erased on reload** — `bumpSeen` skips POST for anonymous users (no server) and `_saveSeenLocal` only persisted `latestAt`, so anon users' clears reverted to `seenAt=0` on every reload — red dot reappeared even after they'd cleared. local persist now includes `seenAt` too.
- **YouTube sends reported success even when rejected** — `youtube_send_relay` was dispatched without `awaitConfirm:true`, so the BG returned `ok:true` as soon as the click animation ran, even if YT rate-limited / slow-moded / disabled the button. now waits for the 2.5s observer race in youtube-content.js to actually confirm the message landed.
- **whisper dedup collisions on long messages** — `_whisperDedupKey` hashed only the first 64 chars of text for whispers without a Twitch id (Kick/heatsync DMs). long whispers sharing an intro collided, one silently dropped, no unread badge. now hashes the full text via djb2.
- **bumpSeen network failure regressed clears** — POST was fire-and-forget; on a network blip the local clear stuck for the session but the server timestamp lagged, so the red dot reappeared on next reload (server-authoritative path). now: failed bumps stash to an in-memory pending map and replay on the next `visibilitychange → visible` event.
- **channel emotes stayed empty on cold-cache page-load** — `loadInventory` in content.js short-circuited the storage path when globals were warm; even if `channel_emotes_map` had no entry for the current channel, no explicit refetch fired. join_channel-driven refetch could race the live paint of existing DOM messages. now: if `myChannel && channelEmotes.length === 0`, fire a `get_picker_emotes` refetch from the storage path.
- **multichat extra channels rendered raw text until clicked** — on SW boot the restore path replayed `channel:join` over the WS for every channel in `joinedExtraChannels`, but never called `fetchChannelOwnerEmotes` for those channels. only the page channel's emotes refetched. now: each restored channel gets a 50ms-staggered `fetchChannelOwnerEmotes` so every multichat tab has emotes ready when first opened.
- **emoji-only chat rows clipped emoji at the top** — `.hs-mc-emoji` had `font-size: calc(1em * 2)` (~26px in chat context) but `line-height: 18px` hardcoded, so the inline-block reported itself as 18px tall, the 26px glyph centered and extended 4px above the line box, and `.hs-mc-msg`'s `overflow: hidden` clipped that overflow. emote-bearing rows survived because the 32px emote img forced the line box larger. fix: `line-height: var(--hs-emote-size, 32px)` so the emoji span height matches emote-img height — gives ~3px headroom above and below the 26px glyph (accommodates Noto Color Emoji 1-2px bleed), and makes emoji+text rows visually consistent with emote+text rows.
- **vertical-mode util row had empty side gap** — `.hs-mc-util-btn` was pinned to 18px in `hs-tabs-right`/`hs-tabs-left`, leaving leftover column space (visible most in popout where C is hidden, but present in in-page overlay too with 5-6 buttons). now flex:1 each so the row stretches to fill the column as one segmented control matching the channel tabs above.
- **popout still rendered the in-page resize handle** — the orange `#hs-mc-resize-handle` makes sense in-page (drag to reclaim host video space) but is nonsensical in popout (chat IS the whole window). hidden via `.hs-popout #hs-mc-resize-handle { display: none }`.
- **"went live" 5-burst on ext reload** — the connect-snapshot grace was 30s, but SW WS auth + snapshot burst can take 20-60s on slow connects or cold SW boot. all 5+ currently-live channels would burst as fresh transitions past the 30s window. grace bumped to 90s; covers the slow path comfortably. genuine off→on transitions during a long grace are rare and still resurface on the next offline/online cycle.
- store listing now discloses that personal emote set, feed, and whispers require a heatsync.org login (free); third-party emote and cosmetic rendering works without an account. previous copy could leave a reader thinking nothing required auth.
- twitch chat backfill paths (persisted-buffer restore, robotty backfill, justlog backfill) now skip `roomstate`/`userstate`/`whisper` types. those non-renderable types were filling the 500-msg render ring with null divs and presenting as empty chat on restored channels.

### error-log noise (from production error-reporter)
- `[heatsync] fetchEmoteInventory failed: signal is aborted without reason` was logged as console.error on every SW reinit / extension reload. expected behavior (AbortController cancels in-flight fetch on teardown), not a real failure. now suppressed when `error.name === 'AbortError'` or the message includes 'aborted'.
- `[heatsync-mc] Feed fetch failed — full resp: {...429}` spammed on the rate-limit response when the user has multichat open across many tabs racing /api/messages. 429 is expected throttling, not a server fault — logged via debug `log()` instead of console.error. 5xx / 401 still console.error.
- `Cannot read properties of null (reading 'querySelectorAll')` in `reapplyBadgesToExistingMessages` — twitch SPA-nav can reparent the chat tree between `findChatContainer()` returning and the next sync tick, leaving a stale reference. added a defensive `typeof container.querySelectorAll === 'function'` guard before iterating.
- `ResizeObserver loop completed with undelivered notifications` — chrome-internal warning, every SPA with observers raises this. added an `_isNoise` filter in `lib/error-reporter.js` so it never enters the buffer.
- `Document is not focused` (Clipboard API) — fires when user copies via the multichat context menu while the page tab is unfocused. four `navigator.clipboard.writeText` calls in `input.js` used sync `try {...} catch {}` which doesn't catch promise rejections; now properly chain `.catch(() => {})`. also filtered in `_isNoise` as a safety net.
- `Connection timeout` from `background.js:3368` — fires when the bg WS handshake times out; the same handler already calls `scheduleReconnect()` which recovers. now filtered in `_isNoise` so the recovery path stays quiet.
- general: the error reporter now silences a small set of known-noise patterns (ResizeObserver, AbortError, ext context invalidated, cold-SW retry, doc-not-focused, WS connection timeout) at capture time so the user-facing "errors (N)" counter reflects actionable failures only.

### removed
- options page (`options.html`) deleted; `options_ui` removed from both manifests; "settings" link removed from the popup. settings now live solely inside the in-chat ⚙ button. previous options page was a one-paragraph stub that just told you to open chat — redundant surface.

### internal
- added `hs-dbg-render-deep` and `hs-dbg-emotes` event listeners in multichat bootstrap for inspecting render-merge state and emote-cache state during debug sessions.
- removed three unguarded `console.log` breadcrumbs in `src/multichat/main.js` (resub-share fired ok, watchstreak-share fiber, watchstreak-share DOM click). these fired on every share user action and leaked to production console; now routed through `MC_DEBUG`-gated `log()`.

### permissions / privacy disclosure
- added `https://api.7tv.app/*` to chrome and firefox host_permissions. the 7TV v4 GraphQL search endpoint was being fetched from three content-script sites (heatsync-button.js, autocomplete-hook.js, src/multichat/emotes.js) without an explicit declaration. it worked today because 7TV serves permissive CORS, but the host should be declared for store review and reliability.
- added `youtube-keyboard-guard.js` to the firefox manifest content_scripts (MAIN world, document_start, www.youtube.com). previously chrome-only; firefox YT users were missing the YT hotkey isolation that lets multichat input swallow keystrokes intended for it instead of triggering YT's page-level shortcuts.
- privacy policy: docs/PRIVACY.md updated to disclose `api.7tv.app` (emote search), `logs.zonian.dev` (already declared but undocumented), and corrected the YouTube row from "DOM only" to call out the oembed and live-page metadata fetches that route chat messages. store-assets/copy/PRIVACY.md re-synced from the canonical so the version pasted into store consoles matches.
- store listing host table now lists `api.7tv.app` and `logs.zonian.dev`.

## [1.5.2] — 2026-05-22

### added
- FFZ-style modifiers (`w!` `h!` `l!` `c!`) now apply to emoji too, not just emotes — the modifier folds into the emoji span

### fixed
- live type-and-space auto-convert only imagifies emotes you own (heatsync inventory + native subs); channel/global/3rd-party words like a lowercase "what" emote stay plain text until Tab
- input box no longer collapses on youtube — pinned `box-sizing` + `min-height` so the placeholder stays inside the white box
- emote picker no longer shows a blank strip above the input on kick/youtube — dropped the hardcoded `max-height` that subtracted a tabs-bar height only present on twitch

## [1.5.1] — 2026-05-21

### fixed
- broken avatar images now hide via the delegated chat error handler instead of an inline `onerror` — the inline handler was silently stripped by Twitch/Kick/YouTube page CSP, leaving blank avatar boxes
- recent emotes row now records emotes inserted via tab-complete, not only picker clicks
- kick: chat-hidden collapse now reclaims video space (the side-panel rule outranked the generic hide); bare emote chips no longer break onto their own line on tab-complete
- youtube: stream no longer re-mutes after you manually unmute it

### removed
- default-mute streams (guard, observer, settings toggle) — out of scope for a chat extension and the source of the youtube re-mute loop

### internal
- search-result rows render via `textContent` instead of pre-escaped `innerHTML`
- auto-claim, resub/watchstreak share, and youtube resize timers are now lifecycle-tracked so they cancel on SPA-nav teardown

## [1.5.0] — 2026-05-21

### added
- recent emotes row at the top of the emote picker (local MRU, cap 24)
- emote/emoji overlay via name0 convention — appending `0` to an emote name or emoji stacks it zero-width onto the left; committed on Tab, not live; emoji spans marked contenteditable=false so overlay stacking survives caret moves
- `\` key toggles chat panel hide/show; edge-pill restores last edge
- statusbar — inline toast status line with collapse button (position-aware arrow); hides Twitch's native collapse button
- universal right-click menu for any user or feed post — follow, block, mute, whisper wired in order
- block/remove context menus on emotes with numbered keybinds (bottom-up); owned-emote tooltip goes green, unowned orange
- mod toolbar — hover row shows delete/timeout/ban per message; per-button settings, hotkeys, prefetched mod state; singleton with absolute positioning
- profile card: compact hero layout, lean mod toolbar integration, clip-URL copy
- twitch picker sub-tabs: events, bits, chat, links; cheer popup flow; toast dedup + repositioning
- channel-scoped callouts + custom-body resub share via GQL
- tab re-completion across emote chips; settings cheatsheet — emote colors, 0-overlay/modifier syntax, keybind reference, right-click guide
- infinite tab-cycle via 7tv search fallback when local set exhausted
- provider search in emote pickers + two-click add flow for unowned emotes
- tab-complete ranked by 7TV popularity (TOP_ALL_TIME), not alphabetical
- owned sub emotes reachable from tab completion
- cross-platform Twitch GQL wrapper + scheduler for emote actions

### changed
- tagline updated to "twitch + kick + youtube, one chat" across manifest and 34 locales; home tab renamed to feed across all locales
- welcome page reduced to minimal landing style; readme tagline updated
- emote size spec aligned to website: true /1.0 native at 1x, emoji 2x default, 1x/2x/4x widget variants
- bitmap font rendering fully landed: AA disabled, faux-bold/italic synthesis off, integer line-heights, emoji fallback, kerning + OT features, left-aligned channel tabs so text origin lands on integer X; matches heatsync.org base.css exactly
- font-size auto-switches to native (13/14px) when bitmap font is selected
- sender heatsync emote sets fetched in a single batched request, exempted from shared backoff, with credentials=omit for CORS; sets updated in place on source change rather than discarded and refetched
- emote auth: bearer-only on mutations (cookie was tripping server CSRF check)
- emote-picker stays open on context-menu clicks; blocked state visible in search results
- blocked emotes render dashed box at real emote dimensions (not a fixed square)
- blocked emote left-click: steps to unadded state first, not straight to owned; re-adding recovers real URL via emote lookup, never the broken src; re-added emotes no longer store a blank
- emote chip colors carry provider brand; YT keyboard guard rewritten
- picker hover rects: green for owned, orange for addable, dashed for blocked
- feed emotes wrapped in emote-wrapper so right-click block hides them live
- message right-click menu: copy=2, mute/unmute=1, numbered bottom-up
- resub-share broadcast: fiber onClick + stored-button + DOM-click fallbacks
- emote modifiers toggle relabeled as BTTV & FFZ (supports both)
- live tab pinned to #808080 at rest/active; white-bg hover like normal tabs
- util-btn font-weight set to 400 — bold was pushing Cozette off bitmap path
- dropped www.heatsync.org host permission (unused)

### fixed
- feed unread surface corrected from `home` to `live` (matches DB + server schema); default-mute all streams on first load
- 7TV cosmetics dropping on busy or restored channels (per-user cap now clears full ~2000-user buffer)
- broken 7TV badges on QUIC drop — retry with insert-before-src fallback instead of hiding
- badge tooltip loads real hi-res CDN variant (4x), not upscaled 18px
- panel init made resilient; badge fetch made synchronous
- cross-user heatsync emotes now render in native Twitch chat and in the multichat panel; newly-added emotes propagate on re-validation
- shared emotes show as addable (orange) with 'extension' label, not owned (green)
- tab-completed 3rd-party emotes and blocked names persist across refresh
- overlay emotes stack onto emoji in the input box
- emote hover-highlight color re-syncs on state change
- removing an emote drops it from the auto-add-on-send registry
- own-badge seeded per-channel from USERSTATE rawBadges on join
- full chat scrollback shown on reload — stale-guard narrowed to stream events only
- deep-history sources fired on restored channels, not only fresh joins
- no chat flash on block/unblock
- chat not flashing on block/unblock cycles
- Twitch dashboard reflows correctly under no-channel page squeeze
- live-tab hover CSS ported into src so rebuild no longer reverts it
- picker hover rect tracks emote bounds, not img padding-box
- feed post-link fixes + reply-thread hover stack
- mod toolbar: singleton enforcement + absolute positioning + hotkey wiring

### perf
- live chat DOM capped at 500 rendered rows, decoupled from 1500-row data buffer; measured −67% nodes, −134 MB
- memory + 100k-scale audit pass: allocations and lookup paths audited across cosmetics, emote render, and observer surfaces

## [1.4.1] — 2026-05-15

### fixed
- long input text wraps instead of overflowing into the tab area

## [1.4.0] — 2026-05-14

### added
- popout button in multichat tab bar — opens host platform's native chat in a clean window (Twitch /popout, Kick /chatroom, YouTube /live_chat) right of the settings cog
- unified UndoManager for multichat input — Ctrl+Z / Ctrl+Shift+Z across chip insertions, modifier chains, vi-mode edits with one stack
- server-controlled kill-switch + version-floor — ops can disable misbehaving features or force-update without a store push
- thread-walk replies — multi-hop conversation traversal in the multichat overlay
- tier-drop emote removal + multi-platform channel banners
- moderation commands wired through GQL: `/ban`, `/unban`, `/timeout`, `/delete` with dismissible toasts
- chat input tips group in settings (overlay-0, FFZ modifiers, Tab auto-space)

### changed
- centralized inline Twitch/Kick selectors into a single SELECTORS map (3 callsites → 1)
- multichat hides discover tab; tighter input-tip surface
- whitespace handling: real keyboard space after Tab; auto-space stays nbsp at chip boundaries to survive trailing-collapse
- smart unwrap preserves chips around the touching boundary; backspace deletes chip + auto-space atomically

### perf
- multichat scroll on Twitch — main-thread stalls cut by hoisting hot selector lookups
- dropped util-btn min-width 18→14px in vertical multichat mode

### fixed
- 3 untracked memory leaks now flow through the cleanup system
- robotty CLEARCHAT cross-references on backfill + SW-wake gap-fill alignment with reply-stack overlay
- error reporter noise: synthetic stacks + filtered transient errors; storage warn dedup; chat-injector non-channel skip; fetchUserInfo JSON safety
- maroon mention rows force white text + black channel-tag (was unreadable)
- stack-internal overlay imgs no longer unwrap on chip edits
- twitch right-column slot zeroed on no-channel pages
- popout button visible on live tab + whitelisted in updateTabBar selector
- live-imagify nbsp fallbacks → regular space for parity with website

## [1.3.9] — 2026-05-12

### fixed
- content.js failed to parse on load — a stray backtick inside a CSS comment terminated the `style.textContent` template literal, throwing SyntaxError. effect: emote replacement and cosmetics silently dead since 1.3.7. now caught by `node --check` over every built bundle during `bun run build.js`.

### changed
- build pipeline: post-build syntax check on every js output (chrome + firefox)
- build pipeline: `--source` flag (auto-enabled with `--package`) emits `heatsync-source-X.Y.Z.zip` for AMO review
- release workflow: `.github/workflows/release.yml` builds + packages + attaches versioned zips, source zip, and versionless `heatsync-chrome.zip` / `heatsync-firefox.xpi` aliases on every `v*` tag push

## [1.3.8] — 2026-05-12

### note
- shipped to chrome web store but never published — superseded by 1.3.9 before review cleared. firefox upload was rejected by amo validator (same parse error caught later).

## [1.3.7] — 2026-05-11

### added
- service-worker-owned twitch irc with cross-device unread sync and ui_state insta-sync
- wysiwyg modifier system: `w!`, `h!`, `ffzX`, `c!#hex` chains over emote stacks
- kick persistent overlay survives spa nav; profile card v2 with quick actions
- emote picker context-menu rename; stack-click adds unowned emotes; paste drops blocked
- yt user pool merges into @-completion; recency-weighted ordering
- keyword highlights, per-user colors, mod toggle; resub-share callout via HsNotifs

### changed
- multi-variant emote fallback; smooth block-state cross-fade across panel + picker
- whisper-send routes through gqlMutation with directly minted Client-Integrity
- server-side feature sync (mutes, settings, mention rules, eventsub) wired into ext

### perf
- emote picker decoupled, lazy-loaded, scroll-locked; 7tv assets static
- per-tab dom cache → flash-free tab switching
- three chat observers folded into one unified observer
- hot intervals gated; wide layout-observer dropped
- css animations paused on host hidden; selectors scoped
- orange c-handle uses ghost overlay during drag

### fixed
- twitch miniplayer-restore: chat off-screen + missing resize bar
- autocompleted emoji wrapped in span — stops caret snap on U+FE0F
- ghost-render for removed emotes via hs-state-stale
- reply-ctx stays black on olive reply-stack — no chat-jump
- channel badges retry on failure; fake "follows you 5mo" on streamers removed
- popout fills window; vertical-tab util row stretches; twitch quick-links restored

## [1.3.5] — 2026-05-08

### fixed
- feed YT embed: youtube.com self-embed Error 153 → thumbnail-card fallback
- feed Kick clip embed: X-Frame-Options:SAMEORIGIN blocked iframe → server-resolved rich card
- feed Reddit embed: VPS IP-block fallback uses slug-derived title/author when scraper returns nothing
- feed video card: m3u8 (kick clip) now renders as thumbnail-link (no hls.js bundled)

## [1.3.4] — 2026-05-08

### changed
- store-listing copy aligned to 5000-slot limit (was incorrectly "unlimited")
- privacy URL canonicalized to `heatsync.org/privacy` (no redirect)
- removed dead `scripting` permission row from store-listing permissions table

### perf
- multichat picker right-click block/unblock fixes
- 30k-user scale gating + jitter for backend stability
- WebSocket emote-broadcast and heat push at scale via heatsync cosmetics proxy

### fixed
- multichat picker pointer cursor on emote wrap
- right-click on blocked emote now unblocks
- right-click on twitch sub emote blocks instead of erroring
- vi-mode treats overlay-emote stacks as single atoms

## [1.3.1] — 2026-04-29

### changed
- multichat tabbar flattened — channel tabs, +, T/K/YT filters, C/T/F-/F+/⚙ all share a single wrapping row in horizontal mode; column-stack with scrollable channel area in vertical
- removed H util-toggle button (no longer needed — buttons just wrap inline)

### perf
- multichat near-instant cold-load boot

## [1.2.1] — 2026-04-01

### added
- github actions CI pipeline (`bun test`, build verification, version sync check)
- test suite: build output validation, manifest field checks, CSP presence, content script file existence
- unit tests for `escapeHtml` and fuzzy match scorer
- `CONTRIBUTING.md`, `CHANGELOG.md`, `SECURITY.md`

### fixed
- version sync now enforced in CI (package.json, chrome manifest, firefox manifest must match)

---

_earlier history not recorded — see git log_
