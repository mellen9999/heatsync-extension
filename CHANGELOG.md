# changelog

## [1.7.129] — 2026-11-11

### added
- **profile card** — the underlined letters are real keys.

### fixed
- **send** — a twitch send no longer vanishes until a refresh. the send socket keeps its keepalive across a channel switch, and a send twitch never echoes gets a fresh socket.
- **twitch chat** — a line twitch shows reaches the panel even when the reader missed it, and a reader that keeps missing lines reconnects. timers that should outlive a channel switch now do.
- **merged tabs** — one line sent to twitch and kick shows once, not as [T] and [K].

## [1.7.128] — 2026-11-10

### added
- **dms** — threaded dms arrive live in the whispers tab, with typing.
- **subs** — a single twitch sub shows as an event line.
- **mod warnings** — a warning from a mod shows its reason as a notice that stays, not a toast.
- **logs** — lines removed from the archive leave an open logs view without a reload.
- **profile card** — an open card updates when that person edits their profile, changes color or is followed.

### fixed
- **kick** — messages deleted by a mod disappear again; kick moved its live socket and the old one went quiet. an unpin no longer removes a chat line.
- **feed** — a hidden post is removed from your feed; media that fails its scan is held behind your media toggles.

## [1.7.127] — 2026-11-09

### fixed
- **mod anniversary** — share works: type a message and press enter to post it. before, the prompt closed and nothing was sent.
- **mod anniversary rows** — twitch's mod-anniversary notice is recognised and gets its own green row.

## [1.7.126] — 2026-11-09

### added
- **emotes** — upload your own emote from twitch's own picker too; native chat rows load the size that fits your screen.
- **feed** — embeds load on click; a button names the host, and no third party sees you before you ask.

### changed
- **icons** — every icon is a unicode glyph, including the twitch menu, settings tabs and search.
- **text** — 13px and up everywhere, regular or bold only, no all-caps.
- **badges** — feed quotes and reply headers show your picked badge.
- **languages** — the new-messages pill, the card's unmute label and off-twitch mod errors speak your language.

### fixed
- **mod anniversary** — twitch's mod-anniversary callout is no longer shown as a resub with the wrong month count.
- **highlights** — highlight words and old filters work on native chat again with the overlay off.
- **youtube** — replayed chat no longer fires alerts; mod actions show a notice and land in the mod log; space no longer pauses the video after a heatsync key.
- **tour** — a youtube-only mod sees the mod switch.

## [1.7.125] — 2026-11-08

### added
- **getting started** — the welcome page leads with opening a channel; sign-in comes last and is optional. a six-card tour covers the right-click menu, /help, search, adding a channel, settings and the switches, and can be replayed from settings › ?.
- **sending checklist** — settings › ? shows which of twitch, kick and youtube you can send to, with a sign-in button for the ones you can't.
- **keyboard** — row mode puts a cursor on chat rows (alt+r); the row right-click menu works from the keyboard; alt+1-9, alt+[ ] and alt+r work while typing.
- **screen readers** — read every message, only mentions, or nothing.
- **mod tools** — the mod log survives a reload and names who acted; new mods get a starter set of hover buttons; youtube rows get the toolbar; kick mod panel for blocked words, message filter and chatters (/kickmod).
- **filters** — edit rules in place, live match count, a notify option, and your own sound file and volume for rules and @mentions.
- **emotes** — upload your own emote from the picker; heatsync emotes load the size that fits your screen; bttv pro personal emotes show for everyone.
- **badges** — a heatsync badge shows only when you pick it, in the flame's place.
- **tabs** — right-click a tab to move it left or right.
- **composer** — sent history survives a reload, spellcheck toggle, arrow keys in the picker.
- **languages** — mod actions, key help and the profile card speak your language; plain words instead of bt, mt and purge; right-to-left languages mirror the panel.

### changed
- **pronouns** — looked up through heatsync, so pronoundb never sees you; the pronoundb permission is gone.
- **kick sends** — with no kick tab open, a hidden one opens on demand.

### fixed
- **whispers** — a whisper heard twice (irc and eventsub) shows once.
- **chat emoji** — sit on the line again.
- **background** — reconnects that failed quietly, a failed badge refresh that blocked retries, and requests that never got an answer.
- **security** — twitch login handed to pages less often; only known twitch requests go through the background; page text escaped before it is drawn.

## [1.7.124] — 2026-11-08

### changed
- **went live** — the went-live label is yellow like switched-to; red on the olive fill was unreadable.

### fixed
- **names on filled rows** — the black cutout and the name line up with the message text instead of riding high when an emote makes the line taller.
- **multichat** — a channel live on both twitch and kick opens with both legs on the first run, and a saved one-platform entry heals on load.

## [1.7.123] — 2026-11-07

### changed
- **notification rows** — went live, switched to, first messages, subs, channel points, mentions and announcements get a solid colour fill instead of an outline, the same look as heatsync.org. names sit on a black cutout so every name colour stays readable.

### fixed
- **same-name emotes** — when two emotes share a name, chat shows the right one everywhere: twitch and kick tokens first, then the sender's pick, then the channel's (ffz, 7tv, bttv), then globals. your inventory no longer draws someone else's word.
- **blocking** — a block hides only that exact emote, never every emote with the same name, and survives a reload when logged out.
- **right-click** — acts on the exact emote under the cursor.
- **case** — KEKW and kekw are two emotes in tab-complete, search and the picker.

## [1.7.122] — 2026-11-06

### added
- **hover reply** — an optional reply button on each chat row when you hover it (settings, off by default). reply stays in the row menu either way.

### changed
- **fewer settings** — one chat filter (muted words, highlight words, all-caps and automod patterns fold into it once, nothing lost), one third-party badges switch, one density knob, one reset instead of presets; developer and tuning knobs are gone.

### fixed
- **settings sync** — per-site switches and name-paint mode set on heatsync.org stick instead of switching back; rows show only on the sites they affect.
- **memory** — a twitch page with no stream open no longer loads the feed nobody can see; the feed builds one screenful at a time.

## [1.7.121] — 2026-11-06

### fixed
- **went live** — one line and one desktop notification per streamer: a simulcast's kick or youtube channel coming up, or its biggest platform changing as viewers shift, no longer says they went live again.
- **page zoom** — twitch chat no longer collapses to a thin strip when zoomed in, hover cards stay visible at 200%+, and painted names redraw sharp after a zoom change.

## [1.7.120] — 2026-11-05

### fixed
- **live updates** — blocks, unblocks, deleted settings, whispers, plus, notifications read, bookmarks, mention rules and flair changed on heatsync.org or another device apply at once, no reload.

## [1.7.119] — 2026-11-05

### added
- **temp tab** — the watching tab is now a temp tab, like the site's: the channel you're on takes one unsaved slot; chatting in it or its menu keeps it. popouts get it too.
- **stream lines** — went live and switched to lines show the streamer's own colour and name paint, kick and youtube included; ones missed while away replay from history.
- **name marks** — your own lines wear the flame too.
- **composer** — a merged tab's input shows where a send goes, [TKY] in each platform's colour.

### fixed
- **tabs** — a page without a channel no longer saves its fallback tab over live; the next channel page opens that channel's chat.
- **popouts** — boot straight onto the temp tab or the saved tab covering it; a hidden saved tab no longer covers the page channel.
- **flair** — a flair set or cleared on heatsync.org repaints your rows at once, not after 10 minutes.

## [1.7.118] — 2026-11-05

### added
- **name marks** — twitch lines wear sub flair, flame and heat bar before the name, like the app.
- **notifications** — heatsync replies, mentions and report updates are rows in the mentions tab; reading them clears the badge.
- **emoji** — the picker has an emoji tab: search by name or category, enter takes the first.
- **follows** — a keyboard list of who you follow is live (space f / alt+l): enter opens a tab, w watches.
- **composer** — says when you're banned, timed out or locked by a room rule, and holds the send; an n/limit counter shows near the cap.
- **mod** — `/nuke` works on the site too.

### fixed
- **tab-complete** — your twitch sub emotes complete even with inventory suggestions off; a name you own completes to your picture, not the channel's.
- **went-live lines** — a streamer chat hasn't heard yet gets their color and badges.
- **youtube** — chat-off and relay-full say so in a row.
- **style** — no more italics; emphasis underlines.

## [1.7.117] — 2026-11-05

### added
- **34 languages** — the multichat panel, menus, slash command descriptions and popup are translated in full; before, many of their strings stayed english.
- **right-click a line** — reply and copy link live in the line's menu; the hover reply button is gone.
- **share a layout** — `/sharelayout` copies a heatsync.org/m link of your tabs, `/layout <link>` opens one.
- **mod commands** — announce, vip, mod, poll, prediction and color work the same as on the site.
- **went-live lines** — the streamer's name wears their badges, and the line carries its [T]/[K]/[Y] tag.
- **twitch** — an optional switch lets you send the same line twice in a row.

### fixed
- **emotes** — a line sent right after picking or swapping an emote shows the one you picked, not your old one of that name.
- **linked accounts** — linking or unlinking a platform on heatsync.org reaches the extension without a restart.
- **tabs** — an older tab list from another device no longer overwrites a newer one.
- **kick** — the overlay stays off kick's sign-in pages.

## [1.7.116] — 2026-11-02

### fixed
- **twitch chat** — the panel no longer stops showing new messages until a page refresh; a chat full of "reconnect" no longer knocks it offline.

## [1.7.115] — 2026-11-02

### fixed
- **youtube send** — a message sent from heatsync.org or the overlay reaches youtube chat while the overlay replaces native chat on the watch page; before, it failed without saying why.
- **youtube mod actions** — delete, timeout and ban work from the overlay the same way.
- **signed in** — unlinking an account no longer shows you as logged out.

## [1.7.114] — 2026-11-01

### added
- **kick events** — kick raids, hosts and polls show as stream rows in chat; a kick host reads as the raider raiding in.
- **import follows** — fill my cockpit also imports your kick follows.
- **unlinked account notice** — sending an emote while your chat account isn't linked to your heatsync account says so, once per emote per session.
- **reddit links** — a reddit post link with no host still links to the post and embeds.
- **paint hover** — hovering a painted name chips every copy of it.

### changed
- **event rows** — celebration rows ring the whole row instead of a left rail; mod notices keep the rail.
- **sign-in** — sign-in links open the twitch, kick and youtube chooser, not twitch oauth.
- **names** — names clear 3:1 contrast on the zebra stripe.
- **chat logs** — follow the tab's platform; youtube gets the right-click entry and @handle rooms.

### fixed
- **accounts without twitch** — your own identity, mentions, send paths, login prompts and slash commands work per platform for kick-only and youtube-only accounts.
- **replies** — a twitch reply keeps its reply bar when the parent's display name is missing; history replay keeps reply context; reply ids and kick numeric ids no longer cross platforms.
- **live dots** — went-live rows keep their platform (link, card, tab); dots are kept per platform; a not-live answer clears a youtube-only tab's dot.
- **kick** — a delete dims its row, and the purge action is hidden on kick.
- **composer** — the over-limit counter uses the tightest cap among your send targets (youtube 200).
- **filters and notes** — filter rules match youtube @handles and list badges; notes, card lines and mod targets are kept per platform and name.
- **paints** — 7tv paints for youtube-only and kick-only chatters show and survive a re-render; painted names anchor when their animation starts; hovering one no longer stalls the page with scene paints.
- **tabs** — unread counts only show on channel tabs; a twitch-only tab picks up its new youtube or kick leg at once.
- **emotes** — a stale sender set no longer wipes an emote you just added; native youtube chat merges only its own channel's emotes.
- **commands** — `/status` reads kick channels from kick; typed mod commands on the live tab target the page's channel.
- **hover** — hovering the name on a notice row inverts only the name.
- **game change** — a game change with no known previous game says switched to, not now playing.

## [1.7.113] — 2026-10-29

### fixed
- **resize bar** — a twitch channel opened from the following or browse page has its chat resize bar; before, it only showed after a reload.
- **resizing** — letting go of the resize bar on twitch, kick and youtube settles about twice as fast, and youtube no longer hitches again a second later.
- **7tv** — an emote added or removed live shows up even when the channel's emote list hadn't loaded, and never replaces the whole list.

## [1.7.112] — 2026-10-29

### fixed
- **refresh** — names, colours, paints, badges and emote sizes are saved, so a reloaded chat paints them in the first frame instead of filling in over the next few seconds.
- **sub and mod badges** — show as pictures right away instead of text chips that swap in later.
- **steady rows** — emotes loading in, a late emote list, badge and paint updates and a restored tab no longer push the chat up a line or make it wobble.
- **broken emote images** — a failed emote retries without collapsing its row to text and jumping back.
- **hover** — hovering an emote lights only the copies on screen, and leaving it repaints far less, so hovers answer faster.

## [1.7.111] — 2026-10-29

### fixed
- **emote stacks** — hovering a stack previews it at full size, and the first hover is no longer mis-anchored while its images load.
- **new pill** — holding a hover no longer raises the "N new" button.

## [1.7.110] — 2026-10-28

### added
- **tab menu** — right-click a channel tab to show or hide a platform and to pick where you send, as green and red buttons like heatsync.org; every channel tab has them, not only multi-platform ones.
- **player volume** — each twitch, kick and youtube channel remembers the volume you last set, in embeds too; an optional starting volume for new channels, with a switch per platform.
- **replies** — `/re` replies to the last `[OP]` in chat (`/opr` still works); `/r` is whispers only.
- **settings** — basic shows every everyday toggle: 45 instead of 16.
- **held media** — giphy, tenor and imgur embeds are checked by heatsync first; flagged media, and flagged feed and thread posts, sit behind your own toggles as a dashed-cyan line with a show button; a revealed post gets a hide button.
- **feed pictures** — the full-size picture closes on click or escape.

### changed
- **op and re rows** — in chat only the `>>id`, links, tags and names are clickable; the `[img]` tag shows its peek on hover only.
- **mature emotes** — weapons, drugs and hate emotes start hidden, like sexual and gore and like the site; the page default button turns the mature switches back off.
- **settings look** — buttons rest as a dim fill, scrollbars and slider tracks are visible on the black panel, and the volume switches say what they do.
- **cards** — hovering a clickable card whitens its banner too.

### fixed
- **your own emotes** — your lines keep an inventory emote that was yours when you sent them, through remove, block and re-add; a line sent just before you add an emote stays text.
- **emotes** — a channel's 7tv, bttv and ffz emotes carry heatsync's category flags, so the weapons, drugs, gore and hate toggles hide them; a censored emote previews its category box; a typed emote name plus space leaves the caret after the space; the source chip keeps its colours after a removal.
- **went live** — a followed channel going live gets its inline line, kick and youtube included.
- **tabs** — `[OP]` and `[RE]` rows copied into every channel no longer make a tab unread on reload; the mentions and whispers tabs are never plain-unread white.
- **speed** — a tab restored from cache shows its newest 100 rows first; boot reads mentions and youtube history alongside settings; hovering a name or emote only touches the copies on screen.
- **picker** — the sticky section header sits above the emotes scrolling under it.

## [1.7.108] — 2026-10-26

### new
- **feed rows** — an `[OP]` row says when the post has media (`[img]`, `[gif]`, `[vid]` or a count); hover the tag to preview the picture, click to open it.
- **console** — `__hsWhy('name')` says why an emote does or doesn't draw in this tab.

### fixed
- **followed streamers** — a went-live or game-switch from someone you follow shows as a row in the chat you are reading, not just the desktop popup; one go-live is one line.
- **tabs** — right-click clears red, yellow and cyan states only and leaves the unread count alone, so the remove menu opens on a fast chat.
- **your name** — keeps your twitch color; a kick or hashed color no longer stands in for it.
- **suspended channels** — a twitch channel that answers suspended or blocked stops rejoining every 140s.
- **feed** — a post you make or receive with the feed tab open still becomes its chat row.
- **sync** — channels the website synced with a youtube handle are accepted and named by their handle.
- **tab complete** — typing `kek` completes the channel's KEK, not a lowercase lookalike.
- **cards** — a follow or sub is dated from its earliest source; logs link to the user archive.
- **emotes** — a blocked emote's dashed box in an expanded stack stays visible on the white hover bar.

## [1.7.107] — 2026-10-25

### fixed
- **native chat input** — a tab-completed emote draws at full size, and a twitch emote like Kappa no longer flashes a broken image after you send it.
- **tab complete** — one Enter sends (a typed word is no longer swapped for an emote), one Tab completes, and a word that only the 7tv search knows completes on the first Tab.
- **emote stacks** — a wide overlay (curtain0) is centered over its base emote and never stacks onto a badge; a word that is both an emote and a chatter's name draws as the emote.
- **sent emotes** — an emote from 7tv search shows in the row you sent instead of a broken image.
- **blocked emotes** — a blocked emote keeps its dashed outline in native chat and syncs across youtube, twitch, kick and heatsync.org.
- **youtube chat** — emotes show on rows already in the list after a reload, with hover previews.
- **history** — older rows show their badges, and the ones you sent are no longer outlined by a keyword that matches your own name.
- **tagged names** — a tagged name wears that person's saved heatsync paint.
- **badges** — bot and ffz badges are no longer drawn as huge emotes.

## [1.7.106] — 2026-10-25

### fixed
- **tab switch** — switching to another tab and back no longer leaves half the chat gone: a hidden tab keeps all its rows instead of trimming to 100 and rebuilding on return.
- **reply line** — the gray reply line drops the small caret; the leading arrow already says it opens the thread.

## [1.7.105] — 2026-10-24

### fixed
- **zebra stripes** — a shown line never moves or changes stripe: new lines only ever append, so stripes stop flipping when a kick line lands a beat behind a twitch one. lines can sit up to 2s out of timestamp order as a result.

## [1.7.104] — 2026-10-24

### fixed
- **chat freezing** — new lines always land at the bottom: one out-of-order row can no longer bury every later message above it, so the pane never stalls with only the stripes moving.
- **popout chat** — an unfocused popout draws on a short timer instead of arriving in one lump a second later.
- **chat order** — the message clock can run at most 1s past real time, so a stale flood can't sort every fresh line above it.

### added
- **diagnostics** — alt+shift+d writes the pane's whole state to the diagnostics log.

## [1.7.103] — 2026-10-24

### fixed
- **chat freezing** — a popout the browser calls hidden can no longer stall new messages on a twitch + kick tab; the pane keeps drawing until you look.
- **saved channel tabs** — opening a channel from an event row saves it as a tab on every surface and lands on it.
- **chat order** — history merges keep each channel sorted, so new lines never land above a stale tail.
- **zebra stripes** — a line inserted mid-list restripes the rows after it, so stripes never double or flip.
- **tab dots** — the live dot no longer overlaps the unread count.
- **kick wide emotes** — they draw at full height instead of a strip in a square.

### added
- **self-checks** — the pane logs and repairs a stalled repaint, a desynced row index or a silent channel, and records long frames, so a freeze shows up in diagnostics.

## [1.7.102] — 2026-10-24

### added
- **video player** — a ↗ in the video controls opens it on the real site, where a bot wall can clear; the video reloads itself after a sign-in detour, and ↻ reloads it by hand.

### fixed
- **youtube embeds** — youtube cards play from the full youtube host, so signing in changes something.
- **video player** — the filled player survives chat redraws (in a popout it opened and vanished); a parked small player follows its card and keeps its controls inside it.
- **logs** — the extension's logs panel draws 7tv, bttv and ffz emotes as emotes; log-line emotes stay hoverable and sit above the next row.
- **page lag** — emote-stack highlights and card banners no longer make the page restyle on every new row (about 170ms down to 4ms).

## [1.7.101] — 2026-10-23

### added
- **feed pictures** — click a picture in the feed or a thread to open it full size in the chat area; ← back returns.
- **live logs** — new messages from the person whose logs are open appear at the top live.
- **ffz first** — ffz is the default emote provider and leads tab-complete and the picker; the picker shows every upload of an exactly typed name.

### changed
- **cards** — no × on the profile card or logs view, the ← back tab is the way out; the banner backs the card's top section; channel tags in logs go dim.
- **7tv picker** — loads 24 at a time and reads the next page ahead, so load more is instant; a failed tile retries once through heatsync; search uses webp.

### fixed
- **paints** — unhovering resyncs every copy of a name in one pass; a backstop sweep re-anchors drifted names so author, mention and history agree.
- **twitch rows without an id** — they borrow the id from the same chatter's earlier rows, so paint, cosmetics and personal emotes apply.
- **cards and panels** — closing one while scrolled up repaints chat; ← back closes on press; switching tabs with a card open no longer strands its rows; ← back closes a card or logs opened over a filled video first.
- **emote hover** — emotes in logs lines get the hover preview; in card logs the hover highlights the emote, not the whole card.
- **card lookup** — a failed lookup is no longer remembered for 60s and reads as a retryable hiccup.

## [1.7.100] — 2026-10-23

### fixed
- **name paints** — a name and every mention of the same person animate on one clock; new and rebuilt painted names sync once their fill mounts.
- **chat dock** — left, top and bottom docks keep the stream in place after a hard reload; the panel follows the dock side and the video no longer drops to the page bottom or goes dark.
- **offline channels** — the hero video returns to its slot when chat rotates away and back.

### changed
- **lighter twitch/kick pages** — the native-chat script shares the paint compiler instead of carrying its own copy (about 90kb less per page).

## [1.7.98] — 2026-10-23

### added
- **painted names everywhere** — profile cards and their logs show the platform colour plus 7tv and heatsync paints.

### fixed
- **profile logs** — emotes render in logged lines, sit on the text line at 24px, and rows no longer crowd.
- **profile tabs** — the × sits on top and the tab row spans the full width, like chat tabs.

## [1.7.97] — 2026-10-22

### added
- **video in the chat pane** — click a video in chat to play it filling the chat pane; ← back (or esc) returns to chat and pauses it.
- **back tab** — any pane takeover (profile, panels, logs, predictions, video) turns the active tab into ← back.

### changed
- **welcome** — just sign in and close, with one line on why; the import step is gone and the open-twitch button makes no network call.
- **links** — blue, not white.
- **hover** — rows, labels and toasts no longer light up white on hover, only buttons do.

### fixed
- **chat width** — a cache-bypassing reload no longer leaves chat 0 wide and off screen.

## [1.7.96] — 2026-10-21

### added
- **tab read marks** — a channel tab's read mark syncs across your tabs and devices; right-click clear sticks after a refresh.
- **remove an emote** — right-click an emote in your set to remove it; the same-name twin takes over at once.

### fixed
- **removed emotes** — a removed emote leaves the hover label and stays gone, even if a slow inventory refresh lands after.
- **feed** — an upvote shows in both the thread and feed copy, and heat refreshes once after the server recalculates.

## [1.7.95] — 2026-10-19

### added
- **inline rows** — `[OP]` and `[RE]` rows in chat survive an extension reload and come back at their timestamp.

### fixed
- **feed** — an upvote shows in both the thread and feed copy, and heat refreshes once after the server recalculates; the reply count is a readout, `>>id` is the only way into a thread.
- **tab complete** — cycling off a wide emote drops its pinned width, so narrower emotes don't sit in blank space.

## [1.7.94] — 2026-10-18

### added
- **tag hover** — hover a #tag in chat to see how many posts and followers it has, when it was last used, and whether you follow it.
- **signed-out notice** — if your heatsync login lapses, one quiet line says your own emotes are hidden, with a log-in link.
- **same-name emotes** — type a full emote name and press tab to cycle every 7tv upload with that name, not just the most used one.

### fixed
- **popout** — the twitch popout chat no longer stays blank when a saved chat row carries its badges in an unexpected shape.
- **sub tenure** — a tier 2 or tier 3 sub no longer shows a 170-year tenure on the user card.
- **welcome page** — the "import my emotes" button is readable again.
- **mod tools** — the mod panel no longer opens far off screen over scrolled chat, commands on live and feed tabs target the channel on the page, and the mod check asks twitch again instead of trusting an old no.

### changed
- **inventory emotes** — right-clicking an emote in your inventory removes it; blocking moved to the shift menu.
- **import** — "fill my cockpit" reads "import twitch follows" in every language.

## [1.7.93] — 2026-10-17

### fixed
- **picker** — a section's emotes flow as one wrap, so chunk boundaries stop leaving short rows; the ffz chip gets a blue ring; the popout locks out dark-mode extensions that recolor pages.

## [1.7.92] — 2026-10-17

### added
- **youtube home** — the home feed hides non-video shelves by default; "youtube: show feed shelves" brings them back.

### changed
- **tabs** — the T K Y view-filter buttons at the top are gone and every platform always shows; send-target buttons leave the input bar and live in the edit-channel form.
- **twitch colour** — twitch's lavender is a touch lighter so its T outline matches K and Y.

### fixed
- **name colours** — one username, one colour: a real twitch colour is never overwritten by a kick colour, a heatsync pick or a hash.
- **mentions** — a linked twitch account keeps its twitch colour with the heatsync pick as fallback; a tagged chatter keeps the colour they speak in.
- **youtube** — the home feed's first row stops sliding under the top bar; shelves and promos span the grid row.

## [1.7.91] — 2026-10-16

### changed
- **tabs** — feed is the top-left tab and discover its own tab, hidden by default and brought back by the empty feed card; the watching tab is one word with the channel in its tooltip; mod log is off by default and stays off after first login.

### fixed
- **resub share** — the twitch resub and streak share builds its token from the page, works in a popout, and clears the prompt in your other open windows.
- **theatre** — the player fills the viewport height again and covers the left nav; bouncing off an empty watching tab never sticks or strands the panel.
- **offline channel pages** — twitch keeps the hero player in its area with its controls; collapsed chat no longer leaves the player in a corner of its slot.
- **empty watching tab** — a page with no channel lands on following, never a blank column.
- **badges** — the mod badge sits on twitch green again.
- **feed** — a twitch author's name wears the same paint on posts as in chat.

## [1.7.90] — 2026-10-13

### fixed
- **memory** — the extension no longer piles up memory in the background: a busy chat used to pin up to a couple of gigabytes within minutes, now it stays flat around 10MB. tabs carry about 15MB less each.
- **crashes** — tabs no longer crash ("aw, snap") with several twitch streams open.
- **closed streams** — closing a stream tab now lets go of its chat; it used to keep downloading in the background, and other tabs kept showing it.

### changed
- **emotes in other chats** — someone's own channel emotes show as text when they type them in a different channel, the same as 7tv and bttv do. heatsync emotes and 7tv personal emotes still show everywhere.

## [1.7.89] — 2026-10-08

### added
- **tweet links** — a tweet pasted without `x.com` or `twitter.com` in front still links to x.com and gets the tweet preview card.

### fixed
- **youtube video** — the stream no longer hides behind the title and description on a fresh page load, leaving a black page.
- **name tags** — a tag that leaves out a name's underscores still points to that person.
- **zebra stripes** — alternating line stripes no longer flip a second after chat opens.

## [1.7.88] — 2026-10-05

### changed
- **look** — eight colors on black, buttons and tags are outlined instead of filled, stripes on alternating lines, twitch tags in light purple, mod green, a dim reply line.
- **font** — system monospace everywhere; no font download bundled.
- **rows** — tall enough that p, g and y are no longer cut off.
- **channel tabs** — the summary, logs and status row is gone from channel tabs; `/status` opens them.

## [1.7.87] — 2026-10-04

### fixed
- **kick video size** — the stream is no longer cut off on the right or squeezed beside kick's own chat; it fills the space next to the chat panel.

## [1.7.86] — 2026-10-04

### fixed
- **twitch video size** — the stream no longer shrinks to two-thirds of its space next to the chat panel on a fresh install.

## [1.7.85] — 2026-10-04

### fixed
- **bttv emotes** — non-animated bttv emotes no longer show as broken images with emote animation set to hover or never, or while scrolled offscreen.

## [1.7.84] — 2026-10-04

### added
- **feed votes, bookmarks and reactions** — upvote, bookmark and react on feed posts from the extension; an open thread updates live as others react and vote.
- **mention rules editor** — settings → mention rules: list, add, edit, toggle and test your rules, with recent hits.
- **hide a name paint** — row menu "hide <user>’s paint" turns off one user's name paint; shared with the site.
- **`/user`** — opens that user's profile card.

### fixed
- **`/tab`** — its description now says what it does.

## [1.7.83] — 2026-10-03

### added
- **mod tools** — `/modtools` on a twitch channel you mod: shield mode, unban requests (approve / deny), automod levels, chatters. `/shield [on|off]`, `/warn <user> <reason>`, `/shoutout <user>` (`/so`), `/unbanrequests`. row menu "warn", opt-in toolbar button. one twitch permission on first use.
- **chat modes set from the extension** — the modes cell reads twitch's real settings and every toggle (slow, followers, subs, emote-only, unique) applies through heatsync; `/emoteonly`, `/subscribers`, `/uniquechat` work again (twitch retired their chat commands), with `off` forms.
- **pinned message** — mods pin a line from the row menu or `p`; it sits above chat for every heatsync viewer of that channel with an × (mods unpin for all, viewers hide it).

### fixed
- **new twitch badges show** — an unknown badge version refetches its set instead of falling back to the wrong one; badge titles on hover.

## [1.7.82] — 2026-10-03

### added
- **blocked terms** — `/blocked` on a twitch channel you mod opens its blocked terms list: `a` adds, `d` deletes (inline confirm), `/` filters, `j/k` move, esc closes. also in the right-click menu as "blocked terms" and as an opt-in toolbar button (settings → mod toolbar buttons). the first open asks for one twitch permission. in 34 languages.

## [1.7.81] — 2026-10-02

### changed
- **a user card fills the whole chat panel** — click a name and the card takes everything under the tabs, chat filter included. its places (`profile · logs · chatter · twitch · kick`) sit in the 2nd row while it's open; esc, the ×, or any tab closes it and the row comes back.
- **no links in the middle of a card** — log lines, timestamps, bio mentions and socials are plain text now; the card's one row of places is the only way out of it. the card on the twitch page itself keeps that row at its bottom edge.
- **one close button** — every × in multichat is the same thick, high-contrast cross.
- **mod confirms fill the panel** — a ban or timeout confirm takes the whole pane instead of a small box.

## [1.7.80] — 2026-10-02

### changed
- **every panel has a place in the tab bar** — a 2nd row under the tabs holds the active tab's cells. channel tabs: `chat · summary · logs · status`; live adds `platforms`; feed gets `discover`; settings gets `help`. `/status`, `/modes`, `/help`, the right-click "chat logs" and "edit platforms" now open those cells instead of their own pop-up panels, and esc goes back to chat.
- **stream summary stays in the app** — msgs, chatters, mentions, peak msg/s, top chatters and emotes, live while you watch. the twitch analytics window it used to open is gone. when a stream ends, the summary cell gets a dot instead of a card over chat.

### fixed
- **clicking a went-live notification focuses the streamer's tab** if you already have it open (popout chat counts), instead of opening another one every time.

## [1.7.79] — 2026-10-01

### changed
- **the health check-in carries a rough install age** — first day / first week / first month / older, computed on your device and counted only in per-range daily totals, so we can see new installs and retention without following anyone. the id still rotates every UTC midnight.

## [1.7.78] — 2026-09-30

### fixed
- **a command's receipt says ✓ only when the command ran** — a bare `/op`, `/follow`, `/mute` and friends used to settle ✓ while nothing happened; a cancelled ban, and a mod command typed while logged out of twitch, did the same. each is ✗ now with the reason on the row.
- **a whisper or dm that bounced says why on its own row**, not only in the whispers tab.
- **an unknown `/word` is refused on every platform** — twitch tabs were sending it on the wire, and kick and youtube tabs posted it as chat.
- **`/help` and autocomplete list every command that exists** — fourteen shipped commands were missing and a debug-only one was listed. one registry drives both, shared with heatsync.org's `/commands` page.
- **chat logs: the time sits right and is the permalink**, like the site.
- **whispers read the server's conversations shape**; the logged-out composer says to log in.

### changed
- **`/opr`, `/follow`, `/unfollow`, `/block`, `/note`, `/delnote` also work on heatsync.org**; the help marks which commands work where.

## [1.7.77] — 2026-09-28

### fixed
- **your own whisper always echoes inline** — and a failed one says so instead of vanishing.

### changed
- **store name says what it does** — `heatsync — twitch, kick + youtube in one chat`, in all 34 languages. the toolbar still says heatsync.
- **dev and unpacked builds are no longer counted as installs** — the daily check-in still runs (it carries the kill-switch), it just sends no id. firefox also sends no id without the data grant.

## [1.7.76] — 2026-09-28

### added
- **profile card** — the hover peek, the overlay panel and the full card come from one shared card that matches the site, in one request instead of up to four; the panel shows live twitch followage; a clip action (hotkey c) on live twitch subjects; every name in overlay chat opens the same card.
- **notes sync** — your user notes sync to your account when logged in, with a local fallback and a one-time upload.
- **paste media** — paste or drop images and video into twitch, kick and youtube's own chat inputs; the composer takes several files and link-only drags, and shows feedback while uploading.
- **welcome import** — a one-click import of your 7tv, bttv and ffz emotes on the welcome page.
- **log links** — shared chat-log links point to the new /search/logs address; old ones still open; tag and profile links point to their new homes.

### fixed
- **emote size** — chat asks for the emote size your screen can actually show instead of upscaling a small file.
- **emotes on a row** — a message with several heatsync emotes shows all of them, not only the first one resolved.
- **7tv** — a static file is only requested for emotes that are animated.
- **youtube** — the chat panel shows only on a page's own live stream unless you opt into chat on every youtube page; the empty panel on home, vods and non-live pages is gone; a video id is no longer mistaken for a channel handle.
- **twitch** — the panel hides on pages with no channel (directory, settings, search) when you have no saved chat tabs.
- **kick** — cosmetics lookups use the numeric kick id when known and back off when kick rate-limits.
- **paints** — heatsync paints draw their composited fill in the overlay.

## [1.7.75] — 2026-09-18

### added
- **a gifs tab in the emote picker** — searches heatsync's own gif library (built from what people actually post in chat) and drops the direct media url in the composer, the same bytes twitch's gif keyboard sends. the grid paints stills and animates only the tile you point at, so opening it is not a space heater. keyboard-first: type, enter inserts, `esc` for normal mode, then `hjkl` to move.
- **the picker's tab bar shows on kick and youtube** — it was only ever drawn when the twitch tab was there, so two platforms out of three had no way to switch tabs at all.

### changed
- **the live tab is called watching**, matching the site.
- **name paints** — pan/base controls mirrored from the site, the eight themed presets removed, and the crowd dial (which the overlay compiled and never turned on) now runs.

## [1.7.73 – 1.7.74] — 2026-09-15 → 2026-09-16

two builds a day apart; grouped here because 1.7.74 fixes what 1.7.73 broke.

### added
- **fill my cockpit** — import the twitch channels you follow, live ones first, in one go; paste a list instead when logged out.

### changed
- **lighter paints** — letter motions run one animation per effect instead of one per letter, every paint is capped at 3 animated layers, and scene planes move without repainting the name.
- **paint motion** — a pan sweeps along its own angle (0° and 180° pans used to stand still).

### fixed
- **paints out of step** — a painted name that scrolled away comes back on the shared clock with every other copy, not offset by how long it was gone.
- **plain painted names** — in 1.7.73 heatsync name paints in the overlay drew as plain text; 1.7.74 restores them.

## [1.7.72] — 2026-09-07

### fixed
- **7tv emotes vanished for some channels and chatters** — 7tv's api can now return a user without an inline emote set and only the set's id. three paths read the inline set alone: a channel's 7tv emotes came back empty, a set change was never noticed again, and a chatter's 7tv emotes rendered as plain text. all three now fetch the set by id when that is all 7tv sends.

## [1.7.71] — 2026-09-07

### fixed
- **firefox: settings, emote size and the blocklist stuck at defaults, feedback form always "failed"** — three of the hand-written scripts awaited `chrome.*` calls, which firefox answers with nothing. every promise-style call now goes through the same `browser` alias the background already used, and a tripwire test keeps it that way.
- **kick send errors read like error pages** — kick's raw response body landed in the toast. followers-only, subs-only, slow mode and bans now say so in the same words twitch does.
- **youtube "top chat" quietly filtered the relay** — youtube defaults big streams to top chat, so the relay read a server-filtered stream and heatsync looked like it dropped messages. the panel switches the view to live chat itself; when it can't, it says so.
- **youtube `/channel/<id>/live` pages join chat** — and a `&pp=` / `&list=` change in the url no longer resubscribes mid-stream.
- **`kick.com/video/<id>` no longer becomes a ghost channel** — one reserved-path list replaces nine copies (video, following, moderator, videos, login, search, u and p were missing from some).
- **m.twitch.tv left alone** — the mobile site has its own dom; nothing injects there anymore.

### changed
- **shared chat names the partner** — the chip reads `shared:<login>` instead of a bare `shared`.
- **profile card and context menu** — real dialog and menu roles, focus lands in the card and returns on close. the hover-card copy is translatable, and a debounce timer no longer shadowed the translator.
- **lighter page hooks** — mount-wait observers watch the app root instead of the whole document, and the youtube paint stylesheet stops growing without bound.

## [1.7.70] — 2026-09-06

### added
- **quote a live chat line into a thread in one click** — `»` on any live message (or right-click → *quote into a thread*) opens the composer in quote mode with the line pinned above it; enter posts a new thread and copies its public link. no more typing `/op` by hand, and the quoted words are pulled from the archive so nobody can put words in a chatter's mouth.

### fixed
- **public thread links** — the extension pointed at `/m/<id>`, which is the multichat layout permalink. threads live at `/share/<id>`.

## [1.7.69] — 2026-09-06

### changed
- **paints** — a scene paint's tint can be any colour.
- **lighter chat** — twitch and kick messages go only to the tabs that want them; youtube chat arrives batched per channel; offscreen animated emotes sit still until they scroll into view; kick stops polling an offline channel every second after ten quick checks; paints skip their scan until one has drawn.

### fixed
- **hidden tabs** — a hidden tab keeps twitch's own chat suppressed instead of letting it render again.

## [1.7.68] — 2026-08-26

### fixed
- **a stray keystroke can no longer moderate anyone** — with the composer unfocused and the mouse resting anywhere on a chat row, `x`, `t` and `b` deleted, timed out and banned whoever wrote it. that was the normal reading position, so the first letter of a message was enough. mod actions now take a deliberate click: the hover toolbar, right-click, or the profile card.
- **`s` no longer drops chat into a white bulk-select mode** — the multi-select ban/timeout surface it opened is removed entirely, hotkey, right-click entry and all.
- **`/` and `n` stop firing twice** — with the chat filter open they both typed the character into the composer *and* ran the search command.
- **a bare `t` no longer opens the tab picker mid-message** — with vi mode on and the composer unfocused, typing anything starting with `t` opened the rover instead. it's `space t` from normal mode now.

### changed
- **vi mode: `space` is a leader** — in normal mode `space` then `/` `n` `N` `1`-`9` `]` `[` `t` `\` runs search, match cycling, tab switching, the tab picker and the chat toggle without leaving the composer. the outline turns orange while it's armed, and `?` lists them.
- **alt+1-9 and alt+]/[ switch tabs from anywhere** — they used to be ignored while you were typing, for no reason: alt+digit isn't text.

## [1.7.67] — 2026-08-26

### fixed
- **the feed tab comes back if it went missing** — the update that was meant to hand the feed tab back could quietly fail on a slow start and then never try again, leaving the tab hidden for good. it now waits until your settings have actually loaded before deciding, retries if they haven't, and gives the tab back to anyone the earlier version missed.

## [1.7.66] — 2026-08-25

### added
- **bttv and ffz emote changes land mid-session** — a streamer adding, renaming or removing a bttv emote reaches your chat within moments over bttv's live socket; ffz has no socket, so it's checked about once a minute. before, both waited until you rejoined the channel. 7tv already worked this way — now all three do.

### fixed
- **loading more feed posts no longer throws you back to the top** — the feed rebuilt every row and reset your scroll position each time it fetched a page; it now appends only the new rows, and stops asking for more once it hits the end instead of fetching forever.
- **a zero-width 7tv emote added mid-stream renders as one** — it used to sit inline like a normal emote until the next full refresh.
- **the emote picker drops bttv search** — the search api behind it only answers signed-in bttv requests, so the option could never return anything but an error.

### changed
- **menus snap** — the context menu and volume flash lost their fade-in delays, images hint the browser to decode off the main thread, and boot sheds three stalls that queued the ui behind background work.

## [1.7.65] — 2026-08-25

### fixed
- **the feed tab is there when you install** — new installs hid it until you logged in, from back when a logged-out feed really was blank. it hasn't been blank since august 16, so the tab was hiding 31 posts behind a login nobody had a reason to do yet. if you installed in the last month it comes back on its own; if you hid it yourself, it stays hidden.

### changed
- **the extension says which of its tabs you opened** — a name like "feed", nothing else, sent with the update check that already runs every few minutes. no ids that survive the day, no timing, no content, nothing stored. it exists because there was no way to tell whether anyone ever reached the social side, and guessing was making bad calls.

## [1.7.64] — 2026-08-24

### added
- **a simulcast link you set spreads to everyone else** — when heatsync can't resolve a channel's youtube by itself and you fill it in, your copy reports the channel's own published youtube link so other viewers get the merge with zero setup. nothing is sent unless the channel lists that link publicly, and the pick prefers the account that's actually live.

### changed
- **the download is a third the size** — the three chat scripts shared almost all their code but each shipped their own copy; they load one shared core now (3.75mb → 1.0mb).
- **the welcome page says almost nothing** — and that's the point.

### fixed
- **popout chat freeze, again, at the root this time** — every recovery path waited on a browser signal that popout and background windows can miss entirely; rendering no longer depends on it. the same root cause made chat crawl when signed-in reads raced the anonymous reader — both races closed.
- **no more dead band above the composer** — switching tabs could leave a gap between the last message and the input that never healed.
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

## [1.7.41] — 2026-08-02

### added
- **sub button** — a $ on each channel tab and links in the right-click menu take you to subscribe to the active channel; simulcast tabs get a picker.
- **multistream banner** — notices youtube live as well as kick, offers newly live platforms and merges into the existing tab.
- **censored emotes** — the censored box keeps the emote's exact width so a filter toggle moves nothing; picker cells and input chips show a category colour (magenta sexual, red gore, green drugs, grey hate, cyan unknown).
- **scene paints** — paints can carry a scene.
- **emote fallback** — an emote image that fails from its provider retries once through heatsync.

### changed
- **stripes** — zebra stripes are visible and the muddy near-black fills are gone; dim greys are readable.

### fixed
- **chat order** — merged twitch, kick and youtube chat keeps every buffer in order by real send time and stops re-sorting every frame.
- **your own message** — no longer shows twice, once as [T] and once as [K].
- **tab complete** — the 7tv catalog search starts on the first tab; the empty bar hides after a send; cycling no longer dies on the first non-overlay match; a word in your message that merely showed up in a catalog search is no longer added to your inventory.
- **composer** — one rule decides which tabs get a composer, and a hidden tab is never restored (typing with no tab selected showed an input that didn't send); the bar hides at once after a send in auto-hide mode; typing no longer scans every emote and username per keystroke.
- **feed** — `[OP]` and `[RE]` rows appear without opening the feed tab; your own `/op` shows up in chat.
- **live dot** — a channel that went offline loses its dot; a 1-second timeout no longer reads as a permanent ban.
- **paints** — a 7tv paint no longer erases a heatsync paint you saved.
- **7tv** — dropped emote sets are unsubscribed and the subscription limit is honoured; a failed channel-emote fetch no longer blacks out live updates.
- **layout** — clicking a stream from browse holds the chat column instead of snapping later.

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

## [1.7.35 – 1.7.36] — 2026-07-23

two same-day builds; grouped here because they shipped as one body of work.

### fixed
- **mention tab** — a mention lights the tab red, not the yellow of a game switch.
- **platform borders** — the T K Y coloured borders stay complete in the top and bottom layouts.
- **live dot** — a tab with both a twitch and a kick handle checks kick too, so a streamer live only on kick shows the dot.

## [1.7.34] — 2026-07-23

### added
- **slash commands** — `/mod` `/unmod` `/vip` `/unvip` (twitch broadcaster), `/tab` switches tab from the composer, `/set` changes any setting, plus commands for polls and predictions (`/poll` `/vote` `/prediction` `/bet` and the rest) and for notes and blocks.

### fixed
- **banners** — poll, prediction and hype banners overlay chat instead of shoving every row down.
- **kick sends** — a slow-but-accepted kick send is no longer posted twice.
- **toasts** — the picker's block and remove toasts say what actually happened; bulk-insert lists only the emotes that saved.
- **youtube** — a send isn't re-driven through a second tab after the first may already have posted; chat ingest reattaches when youtube swaps its chat container.
- **emote and paint lookups** — a 7tv or betterttv hiccup or a kick rate limit no longer hides a chatter's real emotes, paints or badges for minutes.
- **profile banner** — a failed banner fetch is no longer remembered as "no banner".
- **twitch actions** — an action twitch rejects reports the real error instead of timing out after 8 seconds.
- **security** — profile-card avatar urls are checked and line breaks are stripped from sent messages; feed posts neutralize a bare `<`; the insert-emote bridge validates its input.
- **memory** — emote and pending-send caches are bounded, and observers are released on a channel switch.

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

## [1.7.25] — 2026-07-15

### added
- **youtube panel** — the chat panel shows on every youtube page by default.
- **big bttv emotes** — oversized bttv emotes draw at their native height instead of clamped to the baseline.

### fixed
- **scroll smears** — rows no longer draw over each other while scrolling, and rows already on screen never move.
- **composer** — keeps focus after you send; a draft survives twitch swapping its chat container.
- **youtube** — the miniplayer sits clear of a docked panel; the panel stays off chat-replay pages and no longer squeezes the page at boot; a failed send gives youtube's restricted-chat reason; your own message is no longer swallowed.
- **removed channels** — removing a kick or youtube channel clears its saved chat.
- **languages** — 340+ settings labels and toasts go through translations.

## [1.7.24] — 2026-07-14

### added
- **click-to-play embeds** — spotify, youtube, vimeo, soundcloud and clip links in chat turn into a live player on click; audio links get a rich card; cards are compact.
- **plus tenure** — the plus-tenure token shows beside member names, like the site.
- **paint timing** — animated paints lock to the wall clock, so every copy of a name moves together, like the site.

### changed
- **thread links** — `>>id` links are yellow, not orange.

### fixed
- **kick sends** — messages to kick landed nowhere after kick changed its auth and routing; sends, mod actions, follow and status work again.
- **ghost channels** — login and oauth redirect pages no longer join as channels called "login" or "oauth2" and shuffle your tabs.
- **your own paint** — your name gets its paint at once in a busy channel instead of waiting behind strangers.
- **emote inventory** — one sign-in hiccup no longer wipes your warm emote list.
- **youtube layout** — pages with no live chat no longer keep a dead gap on the right.
- **cards** — closing the profile card or chat logs mid-redraw works.
- **twitch tweaks** — the recommended and bell tweaks work again and the stream-title tweak no longer hides more than the title; the dead discover tweak is gone.
- **reliability** — a sweep of about 90 fixes: kick chat rejoins after a restart or a silent socket, notification clicks work after the background sleeps, replies containing a % keep their reply bar, settings export and import include your highlights and filter rules.

## [1.7.22] — 2026-07-11

### changed
- **platform buttons** — the two T K Y groups are labelled show: and send:, and use capital letters everywhere.

### fixed
- **composer** — leaving the page with a draft in the box, a stray ctrl+w included, asks first.

## [1.7.21] — 2026-07-10

### added
- **youtube send** — sending to youtube from the overlay opens a hidden tab that inherits your youtube login, so it works with no youtube tab open; a sign-in tab shows when you're logged out.
- **youtube popout** — the overlay fills youtube's pop-out chat window: chat only, one chat instead of two, composer always visible and focused.
- **emote effects** — full bttv and ffz modifier and effect support, matching the site.
- **picker** — heatsync's own emotes are searchable in the multichat picker.
- **mentions** — a bare @ opens the chatter list at once, recent chatters first; a whisper or dm arriving on another tab gives a toast.
- **whispers** — each whisper row has a reply button that arms `/r`; unseen whispers turn the tab cyan.
- **feed** — posts that name you go mention-red, like chat.
- **tab complete** — in native twitch chat, a remote 7tv emote you tab-complete is added to your set when you send; tab cycling wraps for @user and :emoji.
- **settings** — a default button per page resets just that page; the system page keeps all defaults.
- **name colour** — your picked name colour shows on youtube and kick; youtube names get a stable colour instead of flat red.

### changed
- **vi mode** — auto-hide input works with vi mode; the overlay's f, F and v keys are gone, composer vi is untouched.
- **first messages** — the first-message glow is orange, not a flat yellow bar.
- **right-click** — "quote → input" reads "copy → input".
- **mention red** — a brighter mention-red background.

### fixed
- **youtube theatre** — theatre and fullscreen are youtube's own: the player takes the full row and the chat column is released.
- **youtube chat** — live chat reconnects after moving between videos without a refresh; the panel shows at once on a live stream; a video id is never joined as a twitch or kick channel; youtube mutes and blocks work.
- **kick** — your own mod action prints once; a slow send is no longer posted twice; mixed-emote lines upgrade when the sender's emotes arrive late.
- **emotes** — `<3`-style emotes render; emotes after an emoji sit in the right place; merged-identity and youtube tabs see their channel's emotes in the picker, preview, tab-complete and hover.
- **native chat mentions** — colouring a mention no longer destroys emotes already drawn.
- **composer** — the trailing auto-space stays visible; the first letter typed under vi mode lands in an empty composer; the @mention chip no longer opens your profile; whisper compose reopens without a refresh; a relink prompt shows when whispers need a new scope.
- **echoes** — a reply no longer shows twice; your own youtube popout post is no longer tagged [T]; the badge shows the real send target.
- **paints** — restored history rows of painted users no longer stay on the fallback colour.
- **mod commands** — logged out, they say not logged in instead of channel not found.
- **chat** — a hidden tab's chat isn't trimmed while you are scrolled up.
- **settings** — toggling a setting no longer jumps back to the top; a stale channel list can't open a wall of tabs (capped at 8).
- **security** — page scripts can no longer send chat as you or read your channel, mute and block lists through leftover diagnostics; the login callback must carry the login's own state; graphql mutations are rate-limited.

## [1.7.20] — 2026-07-08

### fixed
- **reply context in popout chat** — replies now show the "replying to" bar in popout and on throttled connections (the native-chat tap was dropping the reply parent).
- **whisper vs dm label** — inline twitch whispers read `[whisper]`; heatsync dms stay `[DM]` (both used to say `[DM]`).

## [1.7.19] — 2026-07-06

### added
- **youtube moderation** — delete, timeout, ban and unban from the overlay on youtube chat, through youtube's own moderation flow.
- **youtube paints** — heatsync and 7tv paints show on youtube chatters in the overlay and in youtube's own chat.
- **kick** — replies thread on send; real avatars instead of initials; bans, timeouts, deletes and unbans by the streamer or any mod dim the row and print a line; native kick chat shows senders' 7tv and heatsync personal emotes.
- **polls** — a new poll alerts you, like predictions.
- **cross-follow** — opt-out switches for twitch follows and their notifications; the notifications switch now works.

### changed
- **fewer permissions** — the extension no longer asks for tabs or web-request access, and redundant host permissions are gone.
- **privacy** — chat history is fetched through heatsync's relay.
- **removed** — the chat tools tab (colour picker, chat modes) and the create-clip action, which stopped working when twitch retired the api behind them; 14 native-chat column toggles and the old native-chat behaviour settings (the hiding stays).
- **notes** — one user-notes system; notes from the old profile-card store move over on first load.
- **chat logs** — the two chat-logs menu entries are one.

### fixed
- **wide and tall emotes** — w!, h! and ffzW emotes draw at the right size, reserve their space, no longer overlap, squish or run off screen; the hover preview shows the modified emote.
- **emote stacks** — overlays centre on the widest emote.
- **emotes** — a failed auto-add rolls back instead of leaving a phantom emote; blocks sync to the picker; a fast double-click can't add twice; late channel emotes upgrade from text to image after a refresh; blocked emotes no longer leak into twitch tab-complete.
- **sending** — two identical messages in a row both send; unwired slash commands no longer post as literal text on kick and youtube; a failed youtube send says so; the send-failure toast gives kick and youtube reasons.
- **tab complete** — tabbing past local matches into 7tv no longer loops back to 1; an exact-name emote wins.
- **picker** — opens filled on an occluded or popout tab instead of blank.
- **mentions** — carry the user's paint and a colour fallback; cosmetics aren't injected when another 7tv, bttv or ffz extension is installed.
- **follow** — unregistered kick and youtube chatters can be followed; a skipped cross-platform sync is shown; report and gift-sub work through the native viewer card.
- **data loss** — a note saved in one tab no longer erases another tab's; a corrupted filter rule list is no longer overwritten with an empty one.
- **security** — the page-to-background graphql relay accepts only a fixed set of operations; a non-hex colour from the backend can't inject css.
- **lighter** — native chat's message pipeline and the extra H button sit idle while the overlay is up; the mute rescan skips when nobody is muted.

## [1.7.18] — 2026-07-05

### added
- **youtube channel emotes** — youtube's own chat loads the streamer's 7tv and bttv emotes without opening the overlay.
- **kick follow** — following a kick channel sends its kick name so heatsync can set the channel up on the spot.

### fixed
- **youtube native chat** — the emote overlay, autocomplete, deleted-message handling and paints work on youtube's own chat again; they had silently stopped. the heatsync button's timers work again too.

## [1.7.17] — 2026-07-05

### fixed
- **emote picker** — clicking a search result (7tv, bttv, ffz) did nothing and multichat clicks were being swallowed; both work again, and a click pastes and keeps the picker open.

## [1.7.16] — 2026-07-04

### added
- **heatsync paints** — your heatsync name paint shows in multichat and wins over a 7tv paint; kick chatters get their 7tv paints too.
- **youtube channel emotes** — a youtube-only channel gets its 7tv and bttv emote sets.
- **cross-device sync** — keyword highlights and chat filter rules follow you across devices.
- **moment links** — shift-click ¶ on a moment pastes its link into chat as a draft.
- **thread refs** — `>>id` becomes a link in twitch, kick and youtube chat.
- **tab complete** — ranked by what you use; a full exact name always wins; use counts where you stop, not at every step of the cycle.
- **emote animation** — always, on hover or never; on hover the emotes sit still and only the row under the pointer animates.
- **painted names** — hovering one freezes every visible copy of it.

### changed
- **lighter pages** — the overlay stops twitch rendering its own hidden chat (a busy channel held about 118mb extra, now about 44mb); background tabs trim to 100 rows; the background closes both sockets when no platform tab is open; static emotes come from the cdn.
- **overlay colour** — links, thread refs, the new-messages pill and the unblock flash use the brand orange instead of yellow; yellow stays for attention rows.

### fixed
- **mod actions** — timeout, ban and delete were silently dead; they go through again.
- **emoji** — `:name` completion works on twitch again.
- **youtube** — each message shows once, not three times; native autocomplete follows its toggle.
- **resize bar** — it is visible again, shows on pages with no channel, and stays under twitch modals and live notifications.
- **navigation** — chat and the bar no longer vanish when you go to the directory.
- **twitch player** — the floating mini-player stops snapping to the top, and the player no longer dies from the overlay's image hook.
- **badges** — mod, vip and sub badges no longer vanish until a reflow; the mod badge is green on history; backfilled rows get fresh badges in every tab.
- **paints** — painted names no longer blank after a mention wrap; paints show on whispers, dms, tooltips, profile cards, chat logs and feed quotes; letter-split paints draw correctly.
- **mentions** — @mentions and reply chips pick up a person's colour and paint even when it arrives after the row drew.
- **picker** — clicks no longer go dead after an extension reload; a blocked emote's dashed box matches the emote.
- **moments** — clicking a moment spike row opens the channel's chat tab instead of the stream page.
- **mute** — a failed mute save shows a message instead of failing silently.

## [1.7.14 – 1.7.15] — 2026-07-02

same-day builds; grouped here because they shipped as one body of work.

### added
- **youtube banners** — super chats, stickers, memberships and gift purchases show as inline banner rows in youtube chat, like twitch's raids and subs.
- **emote picker** — an empty inventory offers a one-click import of the current channel's emotes instead of "no emotes loaded".

### changed
- **privacy** — id lookups, recent chat history and chatterino badges come from heatsync.org instead of decapi, robotty and chatterino; the extension no longer talks to those three.

### fixed
- **7tv paints** — a kick chatter and a twitch chatter with the same name no longer trade paints in mentions, replies, whispers and cards.
- **kick sends** — a failed kick-only send turns the input red with a retry instead of failing quietly.
- **chat history** — recent messages load again when cloudflare answered the page's own request with a 503; the background fetches them now.

## [1.7.13] — 2026-07-02

### added
- **¶ permalink on 🔥 heat-spike rows** — every moment alert links its shareable heatsync.org/moment page (real chat, real emotes, no install needed to view).

### changed
- **welcome page** — the try-it button now opens the busiest live channel instead of the twitch front page, and the copy leads with what's true: emotes render instantly, no sign-in; the 5,000-slot inventory is the optional upgrade.

## [1.7.12] — 2026-07-01

### added
- **filter expressions** — filter rules can be boolean expressions, in the style of chatterino's filters.
- **user notes** — private per-user notes work across platforms, in the overlay and on the native chat card.

## [1.7.11] — 2026-07-01

### fixed
- **heatsync badge** — the [H] mark is orange again; the monochrome pass in 1.7.10 had taken it out.

## [1.7.10] — 2026-07-01

### added
- **/nuke** — bulk-deletes recent messages containing a word within a time window; asks to confirm with the count first.
- **viewer context** — chat rows mark returning chatters and raiders (twitch).
- **user notes** — a private note per user on the profile card; hover a name to see it. it stays on your device.
- **session stats** — the profile card shows how many messages you have from that person, when you first saw them and how many channels.
- **filters** — a sound per highlight rule, case-sensitive matching, and reordering; the order is the priority.
- **op to feed** — right-click a chat message to post it to the feed.
- **site blocks** — blocks you set on heatsync.org carry into the extension.
- **profile card** — shows the same names and live status as the site.

### changed
- **look** — the orange accent is gone from the extension's own screens and heat tiers read as a grey ramp.
- **picker** — section labels (set, 7tv, bttv, ffz) are visible and stick as you scroll.

### fixed
- **cross-platform blocks and mutes** — muting or blocking a name on one platform no longer hits the same name on another.
- **privacy** — chat history is no longer copied into the host page's storage where other scripts could read it; avatar and whisper lookups ask twitch directly and use a third-party lookup only as a last resort.
- **kick** — a reload no longer drops about 1.5 seconds of kick chat.
- **feed** — the merged multichat feed stays smooth with many busy channels.
- **security** — more page messages need the extension's secret before they are accepted; the automod pattern guard catches more runaway patterns.

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

## [1.7.2 – 1.7.3] — 2026-06-14

no user-facing change.

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

## [1.6.8] — 2026-06-08

### added
- **7tv paints** — a chatter's paint shows on their name in replies, whispers, dms and profile cards, not only on their chat messages.
- **tab complete** — recent chatters lead bare-word completion on every chat surface; your own and channel emotes rank above globals; a bare name inserts the plain name, not an @mention.
- **welcome page** — a short "what you get" overview above the setup steps.

### changed
- **timestamps** — chat timestamps show the clock (hh:mm), not a relative age.
- **toasts** — native-chat toasts land in the status bar like the overlay's; the per-emote "not logged in" errors collapse into one "log in to heatsync.org to add emotes" line.

### fixed
- **twitch whispers** — sending a whisper no longer fails with a twitch integrity error.
- **7tv outages** — emotes fall back to heatsync's relay when 7tv blocks your ip or errors out.
- **badge flicker** — a cold load rebuilds chat once instead of strobing as badges, paints and emotes arrive.
- **feed** — a live post that lands mid-refresh is kept, and feed animations pause while the tab is hidden.
- **mentions** — @mentions and reply links get the right colour for chatters you haven't seen yet.
- **replies** — a reply with no parent name no longer breaks the row.
- **ffz emotes** — animated ffz emotes animate instead of showing a still.
- **poll and prediction text** — 15 labels that showed as raw keys read as words again.
- **profile card** — switching cards while one is loading no longer breaks the live poll.
- **security** — a paint can't smuggle css into the page, and other frames on a page can't trigger clear-history or an extension reload.
- **privacy** — message text is no longer written to the console log.
- **long sessions** — memory caps and cleanup keep a long session light, and messages stay in order.

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
