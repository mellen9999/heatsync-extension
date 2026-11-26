#!/bin/bash
# Retry one store's leg of a release until the store takes it.
#
# The chrome web store and edge add-ons each hold ONE version in review at a time,
# so publishing X.Y.Z while the last one is still in review is refused
# (chrome: ITEM_NOT_UPDATABLE, edge: InProgressSubmission). That is a "come back
# later", not an error: publish.js arms heatsync-store-retry@<store>.timer when it
# meets the lock, this runs hourly, and it switches its own timer off once the
# store takes the version.
#
# The other legs and the tag are done by publish.js; this only ever runs
# --<store>-only, built from the version's tag (a worktree it makes once).
#
# Usage: store-retry-publish.sh chrome|edge [version]
#   version: the one publish.js armed it for (store-retry-<store>.version beside the log), else main's package.json
set -uo pipefail

REPO=/home/mellen/projects/heatsync-extension
LOG=/home/mellen/.local/state/heatsync/store-retry.log
STORE="${1:-}"
case "$STORE" in
  chrome) LOCKED='ITEM_NOT_UPDATABLE' ;;
  edge) LOCKED='InProgressSubmission' ;;
  *) echo "usage: $0 chrome|edge [version]" >&2; exit 2 ;;
esac
TIMER="heatsync-store-retry@$STORE.timer"

mkdir -p "$(dirname "$LOG")"
say() { echo "$(date -Is) $STORE $*" >>"$LOG"; }
done_now() {
  say "$1 — disabling $TIMER"
  systemctl --user disable --now "$TIMER" 2>>"$LOG"
  command -v notify-send >/dev/null && notify-send "heatsync" "$STORE: $1"
  # the build checkout goes once no other store still waits on it
  systemctl --user list-units 'heatsync-store-retry@*.timer' --state=active --no-legend | grep -q . \
    || git -C "$REPO" worktree remove "$SRC" 2>>"$LOG"
  exit 0
}
cd "$REPO" || { say "repo missing"; exit 1; }

ARMED="$(dirname "$LOG")/store-retry-$STORE.version"
VERSION="${2:-$(cat "$ARMED" 2>/dev/null)}"
VERSION="${VERSION:-$(git show origin/main:package.json 2>/dev/null | grep -m1 '"version"' | cut -d'"' -f4)}"
VERSION="${VERSION:-$(grep -m1 '"version"' package.json | cut -d'"' -f4)}"

# Build from the release tag, never from main: the retry can fire days later, after main has
# moved, and publish.js builds the tree it runs in under the version it is given.
TAG="v$VERSION"
SRC="$REPO/.worktrees/release-$TAG"
# chrome and edge can fire together on one tag: one builds at a time in the shared checkout
exec 9>"$REPO/.worktrees/.release-$TAG.lock"
flock 9
if [ ! -d "$SRC" ]; then
  if ! { git fetch -q origin tag "$TAG" && git worktree add -q --detach "$SRC" "$TAG" && (cd "$SRC" && bun install --frozen-lockfile >/dev/null 2>&1); } 2>>"$LOG"; then
    say "FAILED: no checkout of $TAG to build from (is the tag pushed?)"
    command -v notify-send >/dev/null && notify-send "heatsync" "$STORE publish retry failed — see $LOG"
    exit 1
  fi
fi
cd "$SRC" || { say "FAILED: $SRC missing"; exit 1; }
[ "$(git rev-parse HEAD)" = "$(git rev-parse "$TAG^{commit}")" ] || { say "FAILED: $SRC is not at $TAG"; exit 1; }
# a tag older than its store's leg has a publish.js that would ignore --$STORE-only and run every
# store: refuse it, the next release carries the leg
grep -q -- "--$STORE-only" scripts/publish.js || done_now "$TAG predates the $STORE leg — nothing to retry; the next release publishes there"

out=$(bun scripts/publish.js --version "$VERSION" "--$STORE-only" --publish 2>&1)
rc=$?

# the store's own summary line, not the whole output
if [ $rc -eq 0 ] && grep -qE "^  $STORE *: published" <<<"$out"; then
  done_now "$VERSION submitted (pending review)"
fi
if grep -qE "^  $STORE *: already holds this version" <<<"$out"; then
  done_now "$VERSION already there"
fi

if grep -q "$LOCKED" <<<"$out"; then
  say "$VERSION: still locked (last version under review) — will retry"
  exit 0
fi

# CWS refuses an upload whose manifest version is not GREATER than the published
# one. When the published version it names is the very version we are pushing,
# the review cleared between runs and the goal state is reached.
if [ "$STORE" = chrome ] && grep -q 'PKG_INVALID_VERSION_NUMBER' <<<"$out" && grep -q "published package: ${VERSION}" <<<"$out"; then
  done_now "$VERSION already live"
fi

# Anything else is a real failure worth surfacing rather than retrying blindly.
# no summary line means publish.js stopped before it (build, tests, network): log its last
# lines so the reason is in the log, not lost
why=$(grep -E "^  $STORE *:" <<<"$out" | tail -1 | tr -s ' ')
[ -n "$why" ] || why=$(grep -v '^[[:space:]]*$' <<<"$out" | tail -3 | tr -s ' ' | tr '\n' '|')
say "FAILED (rc=$rc): ${why:-no output}"
command -v notify-send >/dev/null && notify-send "heatsync" "$STORE publish retry failed — see $LOG"
exit 1
