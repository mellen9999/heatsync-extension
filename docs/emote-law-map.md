# the emote law in the extension — map

the law: `shared/emote-law.ts` (byte copy of the site's), contract `shared/emote-law.vectors.json`, prose
`docs/emote-law.md` on the site. in the bundle it is one object, `hsEmoteLaw` (scripts/lib/emote-law-bundle.mjs);
`tests/emote-law-vectors.test.ts` runs every case under five shuffles.

this doc is the inventory of every place in the extension that answers "which emote is this word" or "in what
order do we list emotes", what it does today, what replaces it, and what a user would notice. file:line is against
main at the time of writing (b278f6e4).

two ideas the law adds that the extension lacks everywhere:

1. **the row's room, not the open tab.** today R1/R5/R7/R9/R11/R12 read `activeTabEmotePools()` (the OPEN tab's
   pools). the law reads the room the line came from (read) or the room the message goes to (send).
2. **a pick belongs to one message in one box.** today picks are a global name map (`recentRemoteCompletions`,
   cap 300) that outlives edits, sends and deletes, and mutates your inventory on send.

## the resolvers

law calls: read = `readWord` / `readLine`; send = `sendWord` / `sendLine` / `editLine`; offer = `offer` /
`extendOffer` / `browse`. inputs are built with `buildRoom` / `buildOwn` / `buildGlobals`.

| id | where | job | order today | law call | a user would notice |
|---|---|---|---|---|---|
| R1 ✓ closed | `src/multichat/emotes.js:4527` `processEmotes` (`_lookup` 4581, name0 4880-4922, suffix peel 4928-4961) | read | exact case; row's own channel. 1 twitch tag cache, 2 `msgRefs` (server `hsEmotes` + own click refs), 3 the sender's whole merged set, 4 `channelEmoteCaches[channel]` (twitch+kick share one bare-name map), 5 global cache, 6 removed fallback / `pastOwnershipAt` (own rows) | `readLine(text, tokens, ctx)` with `ctx.room` = the row's room, `ctx.refs` = only what the sender's app shipped, `ctx.sender` = their 7tv personal (and heatsync on their own lines) | a streamer's own heatsync emote wins over a same-name 7tv one in their room; a kick row no longer draws the twitch channel's same-name emote; your own `W` no longer beats the room's `W` on your line unless you picked it |
| R2 ✓ closed | `src/multichat/main-tabs.js:1499` `computeMessageText` | read (builds R1's inputs) | own row: sender set = `viewerPersonalEmotes`; others: `getSenderEmotes(key)`; `msgRefs` = server `hsEmotes` (1562-1588) + own `clickPastedRefs` (1593); `twitchExtra` = IRC tags | builds `ReadCtx` once per row: `room`, `refs` (shipped only; a server name-match is not a ref), `sender`, `globals`, `fold` | an emote the server only name-matched stops claiming to be the sender's pick |
| R3 ✓ closed | `src/multichat/emotes.js:3632` `_buildChannelEmoteCache`, `:3841` global load, `src/lib/utils.js:722,739` `resolveEmoteProviderWinner` / `EMOTE_TIER_ORDER` | pool shaping | channel list ffz, 7tv, bttv, twitch, kick; globals 7tv, bttv, ffz, twitch; a source outside the list (`heatsync`) means "incoming overwrites", so array order decides | `buildRoom(platform, channel, { owner, third, native })` and `buildGlobals(list)` — they sort before they index | the streamer's heatsync set stops losing to a provider of the same name; a heatsync global stops beating 7tv/bttv/ffz (law: heatsync last) |
| R4 ✓ closed | `src/background/07-handle-message.js:2457-2531` `get_sender_emotes`; `src/multichat/emotes.js:3177` `getSenderEmotes` | sender set build | one merged map per sender, later wins: bttv pro personal, 7tv personal, heatsync (wins same-name) | split: 7tv personal → `ReadCtx.sender.personal` (above the room); heatsync inventory → `sender.inventory` (below the room). bttv personal has no law tier | a sender's heatsync emote no longer outranks the room on their line; their 7tv personal still does |
| R5 ✓ closed for reads (row passes its own room; send/offer callers remain) | `src/multichat/emotes.js:3387` `activeTabEmotePools`, `:3411` `activeTabChannelEmote` | pool pick (OPEN tab) | pools of the open tab: currentTab, its twitch, kick, yt handle, `getLiveChannel()`, `getCurrentChannel()`; first pool wins here, last wins in `_getMergedAcEmotes` | deleted as a resolver. callers hold a `Room` built from the row's / the send's room | same word, same emote whichever tab is open |
| R6 | `src/multichat/emotes.js:3420` `lookupEmote` | state / hover / block / add | yours, global, open-tab pools, removed fallback, blocked fallback | stays a lookup of *the thing a name is in my sets* for block/add/hover (not a resolve); its read/send uses go through R1/R7 | none for block/add; hover shows the emote the row drew |
| R7 ✓ closed (send) | `src/multichat/emotes.js:3468` `lookupEmoteRenderOrder`, `:3551` `lookupEmoteWithOverlay`, `:1962` `createInputEmoteImg` | send preview (composer chip) | yours, open-tab pools, globals, removed, blocked; literal name first, then `name0` as overlay base; `zeroWidthFromAnyCache` recovers the flag | `sendWord(word, ctx)` (chip = what ships; `sendLine().chips` for a whole draft) | the chip shows what will really send: the room's emote first, yours only where the room has none or you picked it |
| R8 ✓ closed (send) | `src/multichat/emotes.js:3461` `lookupOwnedEmote`; `src/multichat/input.js:4128` `handleInputChange` (4327, 4450) | send (type-then-space auto-chip) | yours only | `sendWord` — the auto-chip becomes the law's chip, so a typed word that the room owns no longer turns into *your* copy | typing a word the room has no longer silently chips your look-alike |
| R9 ✓ closed (send) | `src/multichat/emotes.js:3484` `lookupEmoteWireOrder`, `:3440` `kickifyEmoteText`; call at `src/multichat/input.js:9226` | send (kick wire) | open-tab pools, yours, globals, removed, blocked; only `source==='kick'` words become `[emote:id:word]`; plain words if > 500 | `sendLine(...).wire.kick` (law ships kick-own emotes as `[emote:id:name]`, falls back to plain words over 500 and says so) | the chip and the kick wire stop disagreeing (today R7 and R9 pick opposite orders) |
| R10 ✓ closed (send) | `src/multichat/input.js:8633` `autoAddInputEmotes`, `:753` `trackCompletionForAutoAdd`, `:789` `registerClickPasteForAutoAdd`; `src/multichat/emotes.js:2852` `clickPastedRefs`, `:1601-1650` picker click; `src/multichat/input.js:5705` `insertCompletionWysiwyg` | send (picks) | no `emote_refs` for chat sends. a pick is a name-keyed global record (cap 300); a pick found in the sent text is *added to your inventory* (swap only if from the catalog) | picks held per box (`ctx.picks`, see `draftPicks` in `emote-refs.js`); `sendLine` returns `refs`; no auto-add-to-inventory in the law (see "inputs the law cannot express") | a pick no longer lingers after you delete the chip or send; chat sends carry refs so viewers without your sets see what you saw |
| R11 ✓ closed (send) | `src/multichat/social.js:2970` `buildFeedEmoteRefs` → `src/lib/emote-refs.js:315` `buildEmoteRefs`; callers `social.js:3031`, `input.js:3187` | send (feed post, quote op) | per word (+ base of `…0`): any-age pick, then `lookupEmoteRenderOrder` (yours, open-tab room, globals) | `sendLine(text, { room: null, own, globals, picks })` — no room: pick → yours → globals | a post carries the emote you meant even if the open tab's room has a same-name one |
| R12 | `src/multichat/social.js:2521` `renderFeedContent` (`lookupPublicEmote` 2653, `emotes.js:3479`) | read (feed/thread rows) | the post's `emote_refs` by exact name; bare words: open-tab pools then globals (never yours); blocked-name box | `readLine(text, null, { room: null, refs, sender: null, globals })` | a bare word in a post reads as a global, not as whatever room the open tab is |
| R13 ✓ closed (offer) | `src/multichat/emote-law-offer.js` `findEmoteMatches` → the law's `offer` (was `input.js` `findEmoteMatches` + `_getMergedAcEmotes` + `compareAcMatches`, both deleted) | offer (Tab, `:` list, tab-list) | exact-name map; insert globals, yours (if `suggestInventoryEmotes`), open-tab pools (later overwrites); starts-with then includes (no word-start); sort: lowercase-exact, typed-spelling, tier 0, local before remote, used-before-unused, then frecency/prefix/tier, remote order, `@user` recency, shorter, `localeCompare` | `offer(typed, ctx, limit)` / `extendOffer` (law: exact, used+starts-with, room, yours, globals, not-loaded, emoji; ties end in character order) | `pog` stops pulling `MegaPog` over the room's `PogU`; the list never reorders under the cursor; same list on every machine whatever loaded first |
| R14 ✓ closed (offer) | `src/multichat/input.js` `fetchRemoteEmoteMatches` → the law's `extendOffer` after the cursor (`_acMergeRemoteMatches` deleted) | offer (not-loaded catalog) | append-only after local; ffz first (`emotes.js:37`), 7tv, bttv; ffz by `uses`; substring; same picture dropped, different picture kept as a "variant"; a global name is dropped | `OfferCtx.catalog` (+ `pop`) | a catalog look-alike of a name you can already reach is dropped (the copy here is the one that sends) |
| R15 | `src/multichat/emotes.js:89` `mcRerenderSearch` | offer (picker search) | lowercased query; yours, open-tab pools, globals, remote; prefix/includes; sort: match quality, loc, `pop` (Map order), `localeCompare`; no frecency, no typed-spelling lead | `offer(typed, ctx)` | same ranking as Tab; stable across loads |
| R16 | `src/multichat/emotes.js:1278` `pickerBaseEmotes`, `:993` `groupEmotes`, `:983` `buildRecentSection`, `:847` `SECTION_ORDER`, frecency `:897-978` | offer (picker, nothing typed) | Map first-wins: yours, pools, globals; sections: recent (24 names), set, 7tv, bttv, ffz, twitch, kick, heatsync; insertion order within | `browse(ctx, recents)` (recents are pictures; each section most-used then a–z) | recents the room cannot reach vanish; sections stop depending on load order |
| R17 | `src/content/content.js:5473` `processMessage`, `:2694` `rebuildEmoteMapIfDirty`, `:4688` `layeredEmoteMap`, `:6206` `replaceEmotesWithStacking` | read (native twitch/kick rows) | this page's channel only; others: `layeredEmoteMap([live 10s broadcast, sender set, channel, non-inventory])`; sourceless owner/heatsync entries skipped (`:2738`); own rows: inventory, channel, global | `readLine` with the page's room; content.js needs the law in its own bundle (see below) | the streamer's heatsync emotes draw on native rows |
| R18 | `src/content/content.js:9290` `buildEmoteMap`, `:9372` `findEmoteMatches`, `:9644` `setupTabCompletion` | offer (legacy kick Tab) | lowercase-keyed (case twins collapse); channel (sourced only), inventory, globals; `includes` only; sort tier then `localeCompare` | `offer` | case twins offered separately, typed spelling leads |
| R19 | `src/content/autocomplete-hook.js:1046` (getMatches override; fuzzy 1167, sort 1296-1337), `:617` `getAllEmotesForCycling`, cycle build `:1981-2063`, `:662` `fetch7tvCycleMatches`; bridge `content.js:9514` | offer (native twitch) | channel (0), inventory (1), globals (2) first-seen; native twitch subs tier 0, others 2; subsequence fuzzy; the Tab cycle lowercases the typed word | `offer` (twitch native look-alikes offered but marked) | one order for dropdown and cycle |
| R20 | `src/content/kick-autocomplete-hook.js:77` `buildEmoteList`, `:123` `searchEmotes`, strip `:824` `mountEmoteStrip` | offer (kick bare-word list) | channel (0), inventory (1), globals (2) first-seen; list sorted by lowercase; binary-search prefix then substring (cap 8) | `offer` | same list as every other surface |
| R21 | `src/content/youtube-content.js:71` `rebuildEmoteMap`, `:298` `replaceEmotesInElement`, `:1656` `findEmoteMatches` | read + offer (yt native) | versions per name: only my owner's channel set, then inventory, then globals; render map = channel + globals (no sender sets); offer tier, exact, prefix, `localeCompare` | `readLine` / `offer` with the youtube room | a sender's own emotes draw on youtube rows |
| R22 | `src/content/heatsync-button.js:3403` `renderSearchResults`, `:135` `fuzzyScore`, `:2500` `renderEmoteGrid` | offer (native picker) | pools: channel, global-minus-channel-names, inventory; dedup by hash; score (typed-spelling twin 3.5, substring, subsequence); then providers 7tv, bttv, ffz, then hs index; browse: channel raw order, globals, mine | `offer` / `browse` | same ranking as the overlay picker |
| R23 | `src/multichat/chat-logs.js:870` `appendArchiveHtmlBody`, `:895` `appendChatLogBody` | read (archive) | server `message_html` read as data (img allowlist), else position-based `emote_refs`; no local order | none — the server rendered it. out of scope | none |

R17-R22 live in the content-script bundles (content.js, autocomplete-hook.js, kick-autocomplete-hook.js,
youtube-content.js, heatsync-button.js), which do not carry the multichat bundle. routing them needs the law in
those bundles too (≈10KB each, minified) or a message to the overlay. that is a separate decision from R1-R16.

## where today's answer differs from the law

- **read: the sender's whole merged set beats the room** (R1 step 3 / R4). law: only their 7tv personal set is above the room; their heatsync set is tier 4, below it. on your own rows it is your entire inventory (`main-tabs.js:1541`). — closed (READ): only `personal: true` entries (7tv/bttv personal sets) read above the room
- **read: `hsEmotes` is used as a pick** (R2). law: a server name-match is not a pick. — closed (READ): a ref the server marked `nm` reads as the sender's inventory (`named`), below the room; a ref without it is what the sender's app shipped, a pick. an old server sends no `nm`, so every ref reads as a pick, as before
- **read: a provider overwrites the streamer's heatsync set of the same name** (R3, `resolveEmoteProviderWinner`). law: owner heatsync first. — closed (READ): `EMOTE_TIER_ORDER.channel` starts with heatsync
- **read: a heatsync global overwrites 7tv/bttv/ffz** (R3). law: heatsync is last of the globals. — closed (READ): `EMOTE_TIER_ORDER.global` ends with heatsync
- **read: native rows skip the streamer's set** (R17, `content.js:2738`).
- **read: twitch+kick share one bare-name map** (`emotes.js:3642`): a kick row can draw the twitch channel's emote. law: the platform's own channel emotes. — still open: the shared map is built per channel key; the adapter hardcodes `platform: 'twitch'`
- **read: dms use `hsAnyChannelEmotes()`** (R1) as if every loaded channel were a platform token. law: no room → no room rule (picks, sender, globals). — closed (READ): the any-channel map is `processEmotes`' last resort for a roomless line (a word nothing else answered), first channel by name, never by load order. feed rows (R12) are still outside
- **read: youtube native rows and dms never draw the sender's own sets** (R21).
- **read: the case setting is not wired** — exact case is the only mode. law: exact first, then a folded match for words nothing matched.
- **send: the typed word is not the room's** (R7 yours > room > globals; R9 room > yours > globals; disagree with each other and with the law, which is room > yours). — closed (SEND): the chip (`lookupEmoteWithOverlay`), the wire and the refs are one answer, `lawChip` / `lawShip` over `sendWord` / `sendLine`: pick, room, yours, globals. `kickifyEmoteText` and `lookupEmoteWireOrder` are gone.
- **send: picks are global, not per message / box** (R10). `draftPicks` exists in `emote-refs.js` but nothing in the extension calls it. — closed (SEND): every Tab step, picker tile and clicked emote pins to the composer's own draft (`lawPin`); `keepPicksIn` drops a pick whose word left the box; the draft ends with the message (`endComposerPicks`). auto-add on send only fires for a word the box still holds as that very pick. `clickPastedRefs` (a never-cleared own-row fallback by name) is gone: the own echo draws what the send shipped.
- **send: platform-own emotes are not modelled** (law send tier 1) and kick-own beats picks only partly.
- **send: chat sends carry no `emote_refs`** (R10). law: every emote either is marked by the platform or travels as a ref. — closed (SEND) for twitch (`chat:origin_tag` refs) and kick (the own-echo witness posts refs + the typed text), in the stored shape `{p,id,a}` via the site's normaliser (byte copy). still open: a youtube send made from the extension goes browser → youtube with no server witness that can file refs (the poller files only server-relayed sends).
- **send: posts use the open tab's room** (R11). law: no room → pick, yours, globals. — closed (SEND): a post reads the composer's own picks, then yours, then globals; a chat line quoted into the feed reads its room, then globals, never yours.
- **send: no "resolve once against the first platform"** — each leg gets raw words (R9 for kick). — closed (SEND): `sendLine` resolves once against the first leg (twitch, else kick, else youtube) and writes kick's wire form for the kick leg only.
- **offer: a used name jumps every never-used name**, a used substring above an unused prefix (R13). law: only a used name that *starts with* the typed text jumps, inside its tier.
- **offer: no word-start bucket** (R13/R15/R22); R19/R22 add subsequence fuzzy the law does not have.
- **offer: ties end in `localeCompare` or Map insertion order** (R13, R15, R16, R18, R19, R21, R22). law: character order, never locale, never load order. no "carried by more channels" tie-break exists.
- **offer: tier order differs per surface** — R13 room before yours except `keepOwn`; R15/R16 yours before room; R19-R21 channel > own > global.
- **offer: copies of a name are not in send order** — `keepOwn`, first-vs-last pool wins (R5), catalog variants (R14).
- **offer: typed-spelling lead is missing** in R15, the R19 cycle (it lowercases), R18, R21.
- **offer: reach** — R13/R15/R16 offer your twitch sub emotes on kick/youtube tabs. law: only what the message's room can reach; twitch look-alikes marked.
- **offer: reshuffles** — R15 re-sorts the whole list when each provider lands; R13's local list is rebuilt from caches whose Map order changes with loads.
- **offer: recents are names** (24, R16), not pictures.

## things the law's inputs cannot express

these stay in the extension, around the law, not inside it. none changes *which emote a word is*; they change how
the answer is drawn or whether it is allowed.

- modifiers `w!` `h!` `c!#hex` `ffz*` and the inline suffix peel — `emotes.js:4689-4778`, `4928-4961`.
- size rungs, our own uploads' smaller copies, bttv oversize, animation mode / static src — `emotes.js:791`, `493`, `3596-3616`; `emote-rungs.js:23`.
- kick crop and CDN fallback for tokens — `emotes.js:4826-4829`, `3438`, 500-char fallback `3453`.
- nsfw / content-warning hiding (own filters, server `{cw}` stub with no url, channel nsfw flag) — `emotes.js:4407`, `4425`, `4434`; `main-tabs.js:1574`.
- removed / blocked fallbacks that keep a name resolvable after the sets dropped it — `emotes.js:3424`, `3429`, `4546-4550`, `4614`, `4893`, `5150`; block by hash/url/name `:732`. the law's "taken-down is text" and "blocking hides, it does not re-route" cover the intent; the placeholder image is ours.
- past ownership by message time (intervals, skew pads, tombstones, `untilAt`) — `emotes.js:4561`, `2921`, `3190`; `background/07-handle-message.js:2529`. the law has no clock: a row's `sender` set must be built for the row's time before it reaches the law.
- per-sender sets with server versions, LRU, persistence — `emotes.js:3233-3248`, `3257`.
- the live 10s emote broadcast overlay — `content.js:5648-5667`.
- stale-emote ghosts from channel-removal events — `emotes.js:5012-5039`.
- youtube emoji tokens and `:shortcode:` emoji as stackable bases — `emotes.js:5098-5143`; `main-tabs.js:1608`. the law lists emoji only at the bottom of an offer.
- twitch sub "locked" state for emotes you cannot post — `main-tabs.js:1505-1523`; `input.js:2236`.
- the inventory render opt-out and suggest toggle — `emotes.js:4545`, `input.js:5128`. (`suggestOwn` exists in `OfferCtx`; the render opt-out does not.)
- **auto-add-on-send mutates "yours"** (add, swap, optimistic seed, rollback) — `input.js:8633-8713`, `emotes.js:1604-1640`. the law's send is a pure resolve and never edits a set. this is the biggest behaviour question for the SEND step: keep it as a step *after* `sendLine`, driven by `Shipped.chips`.
- click-pasted own-echo refs that survive a failed add — `emotes.js` `clickPastedRefs`. they are `named`: a fallback below the room for your own echo, never a lasting pick.
- server-rendered archive rows — `chat-logs.js:812-893`.

## design note: one on-disk law copy for the content-script bundles (no code yet)

R17-R22 would each need the law. inlining it per bundle costs ~10KB minified x5 and five drifting copies. instead:
one file `lib/emote-law.js` (the law bundle as an iife defining `hsEmoteLaw`), listed in `web_accessible_resources`
and loaded by each content script through `chrome.runtime.getURL` + a classic script tag, or declared once in the
manifest `content_scripts[].js` list ahead of the bundle (preferred: no async, one copy on disk, ~10KB once, shared
by every script of the same isolated world). gotchas: MV3 content scripts of one extension share an isolated world per
frame, so a global defined by an earlier listed file is visible to later ones, but NOT to the page world or to the
background service worker (that one imports its own copy via `importScripts`); firefox MV3 matches this but needs the
file in `content_scripts` order, not dynamic injection, to stay synchronous; a `web_accessible_resources` entry is
fingerprintable by pages, so prefer the manifest-list route (nothing exposed); the build must write the file once
and pin its hash in the budget file so a stale copy cannot ship.

## open calls

- **auto-add-on-send stays as is** for now (`input.js:8633-8713`: a pick found in the sent text is added to your inventory). recommendation: it should never happen on a click. a send should be a pure resolve; adding to a set is its own explicit action, so a click on a picker emote never edits what you own as a side effect.

## order of work

1. READ (R1-R4, R12): one adapter `src/multichat/emote-law.js` (like the site's `client/emotes/law.js`) builds `ReadCtx` from the row's room, once per map version; `processEmotes` keeps its markup/overlay/size code and asks `readLine` which emote each word is.
2. SEND (R7-R11): `sendCtx` / `lineRefs` / `chip` over `sendLine` / `editLine`; picks per box.
3. OFFER (R13-R16): R13 + R14 (Tab, the `:` list, the Tab list, the late catalog) go through the law's `offer` / `extendOffer` (`emote-law-offer.js`). R15 + R16 (the picker's search and its nothing-typed view) are next.

### what Tab does differently since R13/R14 (each is the law, each is also what the site does)

- **one order**: the exact name (the spelling typed leads its case twin), names you use that start with what you typed, the room, yours, globals, not loaded yet, emoji. before: any used name jumped every unused one, ties ended in locale or load order.
- **the room is the one the line goes to** (the send's first leg), not every pool the open tab has.
- **copies of a name sit in send order**: the room's, then yours, then the global. before: yours replaced the room's in the list (`keepOwn`).
- **the catalog adds no second picture under a name something loaded answers to, and one copy (the most carried) of any other name.** before: a different-picture catalog IDK joined the channel's IDK in the cycle, and a name typed in full listed every upload. another IDK is picked in the picker's search, which shows every picture.
- **people**: `@` = people only (unchanged). a bare word: the exact emote, the person typed whole, the room's emotes, the other people, the rest. before: any recent talker whose name started with the word led every emote, and other names only appeared when no emote matched.
- **`name0`**: the base emote typed whole is offered as an overlay. before: every emote the base prefix-matched got a `name0` entry.
- a fetched catalog page registers nothing for auto-add; only the hit the box shows does.
4. content-script bundles (R17-R22): decide separately (size).
