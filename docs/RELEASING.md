# releasing

maintainer runbook. the stores and the github release are two legs of one release: **stores first, tag second.**

## the order that works

1. pick the number: `curl -s https://addons.mozilla.org/api/v5/addons/addon/heatsync-chat/ | jq -r .current_version.version` and the newest tag (`git tag --sort=-v:refname | head -1`). amo numbers are single-use across channels, so a number amo already burned can never be reused, tag or no tag.
2. add a `## [X.Y.Z] — yyyy-mm-dd` entry to `CHANGELOG.md`. the github release notes are cut from that block, and a test fails if a released version has no entry.
3. `git diff <last tag> HEAD -- src/manifests/chrome.json` — a new permission needs its justification typed into the chrome web store dashboard (privacy practices tab) **before** publishing, or the chrome publish fails with a 400. there is no api for it.
4. `bun scripts/publish.js --version X.Y.Z --publish` from the landed main. it bumps `package.json` and both manifests (the build syncs `chrome/manifest.json`; `tests/check-versions.js` holds all four together), builds, and uploads to all three stores (chrome, firefox, edge).
5. tag the same commit and push the tag by name: `git tag -a vX.Y.Z -m vX.Y.Z && git push origin vX.Y.Z`. a lightweight tag is skipped by `git push --follow-tags`, and then no release runs.

## what the tag does

pushing a `v*` tag runs `.github/workflows/release.yml`:

- builds and tests, then creates the github release as a **prerelease** with `heatsync-chrome-X.Y.Z.zip`, `heatsync-chrome.zip`, `heatsync-firefox-X.Y.Z.zip`, `heatsync-source-X.Y.Z.zip` and `checksums.txt` (sha256)
- signs the self-distributed firefox xpi on amo's unlisted channel as `X.Y.Z.1` — the store submission owns the clean `X.Y.Z`, so the two never collide
- attaches `heatsync-firefox.xpi` + `updates.json` and promotes the release to latest. the README's xpi link and every self-dist install's update check read `releases/latest/download/`, so a release only becomes latest once both files are on it

if amo is down, the release stays a prerelease and nothing breaks: `release-finish.yml` retries stranded prereleases every 30 minutes, or run it by hand.

## the source zip rebuilds the release

`heatsync-source-X.Y.Z.zip` is every file the repo is made of (`scripts/lib/tracked-files.mjs`), and amo reviewers rebuild from it. to prove a zip by hand:

```bash
bun run build.js --package
d=$(mktemp -d) && cd "$d" && unzip -q ~/projects/heatsync-extension/dist/heatsync-source-X.Y.Z.zip
bun install --frozen-lockfile && bun run build.js firefox --package
diff -r dist/firefox ~/projects/heatsync-extension/dist/firefox && echo same build
```

an outsider has no site repo beside the zip: the parity tests skip there (they fail only in ci or with `HS_REQUIRE_SITE=1`).

## publish.js

`scripts/publish.js` publishes to the chrome web store, amo (firefox, listed channel) and edge add-ons. safe by default: without `--publish`, nothing is ever uploaded.

```bash
bun scripts/publish.js                                # dry-run, current version, all three stores
bun scripts/publish.js --version 1.7.24 --publish      # bump + build + publish all three
bun scripts/publish.js --chrome-only --publish
bun scripts/publish.js --firefox-only --publish
bun scripts/publish.js --edge-only --publish
bun scripts/publish.js --dry-run                       # force no-network even with --publish
bun scripts/publish.js --sync-summaries --publish      # push the per-language amo listing summaries only
```

what it does:

- bumps `package.json` + both manifests when `--version` is passed, then runs the normal `build.js --package` build
- **chrome**: refreshes an oauth access token, uploads the zip to the chrome web store, then publishes the item. review takes hours to days
- **firefox**: uploads the zip to amo's `listed` channel (deliberate — unlisted uploads never reach the public listing), polls validation, creates the version with release notes (`git log` since the last tag, cut at amo's 3000-character cap) and reviewer notes (exact build steps), then attaches the source zip. review typically takes a few days
- **edge**: uploads the chrome zip as-is to the product's draft, waits for it to process, then submits it for review with notes for the reviewers (how to test, the source tag, the commits). review takes up to 7 business days
- prints what was uploaded where and what's still pending

## when a leg fails

- **each store is its own leg.** one that fails never keeps the others from the version; the summary says `FAILED` for that store and the run exits 1. finish it alone with `--chrome-only`, `--firefox-only` or `--edge-only` plus `--publish`.
- **a store still reviewing the last version** (chrome `ITEM_NOT_UPDATABLE`, edge `InProgressSubmission`) — chrome and edge hold one review at a time. publish.js starts `heatsync-store-retry@<store>.timer` for you: every hour `scripts/store-retry-publish.sh <store>` builds the version main's `package.json` holds from its tag, in its own worktree, publishes once the store takes it, and switches itself off. its log is `~/.local/state/heatsync/store-retry.log`. the units live in `scripts/systemd/`; on a fresh box, once:
  ```bash
  cp scripts/systemd/heatsync-store-retry@.* ~/.config/systemd/user/ && systemctl --user daemon-reload
  ```
- **never re-run the chrome leg after main moved past the tag** — it rebuilds HEAD under the same version. submit the draft that's already uploaded from the dashboard instead.

## one-time credential setup

credentials live in `~/.config/heatsync/publish.env` (chmod 600, never committed). running `bun scripts/publish.js` with the file missing prints this exact checklist:

```
AMO_JWT_ISSUER=...
AMO_JWT_SECRET=...
CWS_CLIENT_ID=...
CWS_CLIENT_SECRET=...
CWS_REFRESH_TOKEN=...
EDGE_CLIENT_ID=...
EDGE_API_KEY=...
```

1. **amo (firefox) api keys** — [addons.mozilla.org → Developer Hub → Manage API Keys](https://addons.mozilla.org/en-US/developers/addon/api/key/). generate credentials; keep the tab open, the secret is shown once.
2. **chrome web store api**:
   - Google Cloud Console → pick/create a project → enable **Chrome Web Store API**
   - APIs & Services → Credentials → Create Credentials → OAuth client ID → type **Web application**
   - add `http://127.0.0.1:8976` as an **Authorized redirect URI** (google blocked the old copy-paste "oob" flow, so the token exchange redirects to a local port instead)
3. **edge add-ons api** — [partner center → microsoft edge → publish api](https://partner.microsoft.com/dashboard/microsoftedge/publishapi). turn on the api (or **new api key**), keep the tab open: the key is shown once. the page lists its expiry date; an expired key answers `the api key was refused`, and the fix is a new key here.
4. `bun scripts/publish.js --set-creds` — prompts for every value with **hidden input** and writes them to `~/.config/heatsync/publish.env` (chmod 600). nothing is echoed, so a secret never lands in a shell transcript.
5. `bun scripts/publish.js --cws-auth` — opens the google consent flow, catches the redirect on `127.0.0.1:8976`, and writes `CWS_REFRESH_TOKEN` for you (never printed).

the release workflow signs the xpi with its own `AMO_JWT_ISSUER` / `AMO_JWT_SECRET` repo secrets.
