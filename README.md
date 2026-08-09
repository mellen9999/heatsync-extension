# heatsync

twitch, kick and youtube live chat in one panel — read every stream you follow and reply into any of them without alt-tabbing. nobody else has to install anything. plus your own emotes in any channel: 5,000 free slots, no streamer setup needed.

**no trackers, no analytics, no third-party telemetry** — emotes and settings sync through heatsync's own servers, never to google, sentry, or any analytics company.

## features

- **multichat overlay** — twitch, kick, and youtube chat in one panel: per-channel tabs, per-platform filters, mentions, twitch whispers, resizable and dockable to any edge. no account needed to read.
- **emote sovereignty** — a free 5,000-slot inventory ([one account](https://heatsync.org)) that follows you into twitch and kick native chat and the overlay — any channel, no streamer opt-in. tab-complete a 7TV emote and hit send; the slot fills silently. one click imports a channel's whole emote inventory.
- **7TV / BTTV / FFZ** — emotes, paints, and badges render automatically, channel and global. heatsync sits next to those extensions — keep them, and add the cross-platform chat and portable emotes they don't do.
- **keyboard-first input** — vim keybindings on the twitch, kick, and multichat inputs (normal/insert, motions, operators, `.` repeat), a wysiwyg emote composer, message history, reply threading, and an instant filter that narrows the live buffer by text or user.
- **moderation + profiles** — a hover mod toolbar (`/ban` `/timeout` `/unban` `/delete`), client-side automod, and mute-or-block that carries a user across twitch and kick. profile cards with socials, badges, and a paginated chat-log archive a click away. one-click twitch clips.
- **light on your machine** — vanilla js, zero runtime dependencies. a capped message buffer and dom render cap hold memory steady through long sessions. the render cap is adjustable down for weak or passively-cooled hardware.

## install

### chrome / edge / brave / arc / opera

**[install from the chrome web store](https://chromewebstore.google.com/detail/heatsync/afadollcanjpemaonbgnkhjddaebjeja)** — one click, auto-updates.

### firefox

**[install from firefox add-ons](https://addons.mozilla.org/firefox/addon/heatsync-chat/)** — one click, auto-updates.

alternative: download the AMO-signed **[heatsync-firefox.xpi](https://github.com/mellen9999/heatsync-extension/releases/latest/download/heatsync-firefox.xpi)** and open it with firefox — installs permanently, and auto-updates from the same link.

## build from source

```bash
bun install
bun run build.js chrome    # → dist/chrome/
bun run build.js firefox   # → dist/firefox/
bun run build.js --package # both + signed zips + source zip
```

`--package` runs `node --check` on every output bundle, minifies, and emits `dist/heatsync-{chrome,firefox}-X.Y.Z.zip` plus `dist/heatsync-source-X.Y.Z.zip` for AMO review.

## release process

push a `v*` tag and `.github/workflows/release.yml` does the rest — build, package, attach versioned zips + versionless aliases + source zip to a new GitHub release. README install links resolve to the latest tag automatically.

## releasing

`scripts/publish.js` is the one-command publisher for the chrome web store and amo (firefox, listed channel). safe by default: without `--publish`, nothing is ever uploaded.

**order: stores first, tag second.** amo version numbers are single-use across channels — the store submission owns the clean `X.Y.Z`, and the tag-triggered self-dist workflow signs its unlisted xpi as `X.Y.Z.1` so the two never collide. run `publish.js --publish`, then push the tag.

```bash
bun scripts/publish.js                                # dry-run, current version, both stores
bun scripts/publish.js --version 1.7.24 --publish      # bump + build + publish both
bun scripts/publish.js --chrome-only --publish
bun scripts/publish.js --firefox-only --publish
bun scripts/publish.js --dry-run                       # force no-network even with --publish
```

### one-time credential setup

credentials live in `~/.config/heatsync/publish.env` (chmod 600, never committed). running `bun scripts/publish.js` with the file missing prints this exact checklist:

```
AMO_JWT_ISSUER=...
AMO_JWT_SECRET=...
CWS_CLIENT_ID=...
CWS_CLIENT_SECRET=...
CWS_REFRESH_TOKEN=...
```

1. **amo (firefox) api keys** — [addons.mozilla.org → Developer Hub → Manage API Keys](https://addons.mozilla.org/en-US/developers/addon/api/key/). generate credentials; keep the tab open, the secret is shown once.
2. **chrome web store api**:
   - Google Cloud Console → pick/create a project → enable **Chrome Web Store API**
   - APIs & Services → Credentials → Create Credentials → OAuth client ID → type **Web application**
   - add `http://127.0.0.1:8976` as an **Authorized redirect URI** (google blocked the old copy-paste "oob" flow, so the token exchange redirects to a local port instead)
3. `bun scripts/publish.js --set-creds` — prompts for all four values with **hidden input** and writes them to `~/.config/heatsync/publish.env` (chmod 600). nothing is echoed, so a secret never lands in a shell transcript.
4. `bun scripts/publish.js --cws-auth` — opens the google consent flow, catches the redirect on `127.0.0.1:8976`, and writes `CWS_REFRESH_TOKEN` for you (never printed).

### what it does

- bumps `package.json` + both manifests when `--version` is passed, then runs the normal `build.js --package` build (which also syncs the built `chrome/manifest.json`)
- **chrome**: refreshes an oauth access token, `PUT`s the zip to the Chrome Web Store upload endpoint, then publishes the item. pending review is hours-to-days.
- **firefox**: uploads the zip to amo's `listed` channel (this is deliberate — unlisted/self uploads don't reach the public listing), polls validation, creates a new version with release notes (auto-composed from `git log` since the last tag) and approval notes (exact reproducible build steps for reviewers), then attaches the source zip. pending review is typically a few days.
- prints a final summary of what was uploaded where and what's still pending.

[MIT](LICENSE)
