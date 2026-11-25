#!/bin/bash
# Retry the Chrome Web Store leg of a release until CWS accepts it.
#
# CWS allows only ONE pending version per item, so publishing X.Y.Z while the
# previous version is still under review fails with ITEM_NOT_UPDATABLE. That is
# a "come back later", not an error — this retries on a timer and disables its
# own systemd timer once the upload lands, so it never needs cleaning up.
#
# The AMO/tag/GitHub-release legs are already done by scripts/publish.js; this
# only ever runs --chrome-only, built from the version's tag (a worktree it makes once).
#
# Usage: cws-retry-publish.sh <version>    (version defaults to package.json)
set -uo pipefail

REPO=/home/mellen/projects/heatsync-extension
LOG=/home/mellen/.local/state/heatsync/cws-retry.log
TIMER=heatsync-cws-retry.timer

mkdir -p "$(dirname "$LOG")"
cd "$REPO" || { echo "$(date -Is) repo missing" >>"$LOG"; exit 1; }

VERSION="${1:-$(grep -m1 '"version"' package.json | cut -d'"' -f4)}"

say() { echo "$(date -Is) $*" >>"$LOG"; }

# Build from the release tag, never from main: the retry can fire days later, after main has
# moved, and publish.js builds the tree it runs in under the version it is given.
TAG="v$VERSION"
SRC="$REPO/.worktrees/release-$TAG"
if [ ! -d "$SRC" ]; then
  if ! { git fetch -q origin tag "$TAG" && git worktree add -q --detach "$SRC" "$TAG" && (cd "$SRC" && bun install --frozen-lockfile >/dev/null 2>&1); } 2>>"$LOG"; then
    say "FAILED: no checkout of $TAG to build from"
    command -v notify-send >/dev/null && notify-send "heatsync" "cws publish failed — see $LOG"
    exit 1
  fi
fi
cd "$SRC" || { say "FAILED: $SRC missing"; exit 1; }
[ "$(git rev-parse HEAD)" = "$(git rev-parse "$TAG^{commit}")" ] || { say "FAILED: $SRC is not at $TAG"; exit 1; }

out=$(bun scripts/publish.js --version "$VERSION" --chrome-only --publish 2>&1)
rc=$?

if [ $rc -eq 0 ] && ! grep -q 'not attempted' <<<"$out"; then
  say "PUBLISHED $VERSION to CWS — disabling $TIMER"
  grep -E 'chrome *:' <<<"$out" >>"$LOG"
  systemctl --user disable --now "$TIMER" 2>>"$LOG"
  command -v notify-send >/dev/null && notify-send "heatsync" "chrome web store: $VERSION published (pending review)"
  exit 0
fi

if grep -q 'ITEM_NOT_UPDATABLE' <<<"$out"; then
  say "still locked (previous version under review) — will retry"
  exit 0
fi

# CWS refuses an upload whose manifest version is not GREATER than the published
# one. When the published version it names is the very version we are pushing,
# the upload already landed (the review cleared between runs) and the goal state
# is reached — that is success, not failure. Without this the timer re-uploads an
# already-published version every hour forever, crying failure each time.
if grep -q 'PKG_INVALID_VERSION_NUMBER' <<<"$out" && grep -q "published package: ${VERSION}" <<<"$out"; then
  say "ALREADY PUBLISHED $VERSION on CWS — disabling $TIMER"
  systemctl --user disable --now "$TIMER" 2>>"$LOG"
  command -v notify-send >/dev/null && notify-send "heatsync" "chrome web store: $VERSION already live"
  exit 0
fi

# Anything else is a real failure worth surfacing rather than retrying blindly.
say "FAILED (rc=$rc): $(tail -3 <<<"$out" | tr '\n' ' ')"
command -v notify-send >/dev/null && notify-send "heatsync" "cws publish failed — see $LOG"
exit 1
