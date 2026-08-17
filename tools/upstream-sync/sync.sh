#!/usr/bin/env bash
# sync.sh — port new commits from the allegorithm exploration branch.
#
# Hot Glue was carved out of trieloff/allegorithm, where the work continues on
# a long-lived branch. This script replays that carve: it filters the upstream
# branch down to the Hot Glue paths, flattens src/hotglue and test/hotglue into
# src and test, rewrites the path references those files carry in their own
# text, drops the four artifacts this repository builds rather than commits,
# and applies whatever is newer than the sha in UPSTREAM as ordinary commits.
#
#   ./sync.sh --check     Has upstream moved? Exit 0 if not, 3 if it has.
#   ./sync.sh             Port everything newer than UPSTREAM onto a branch.
#
# The transform is deterministic: run against the sha already in UPSTREAM it
# reproduces this repository's tree byte for byte. That is what lets the
# patches apply cleanly, and it is worth re-proving if you ever edit the rule
# files — see --verify.
#
#   ./sync.sh --verify    Rebuild the current tree from upstream and diff.
#
# Requires: git, python3, curl. git-filter-repo is fetched to .cache/ if it is
# neither on PATH nor cached already.

set -euo pipefail

UPSTREAM_URL="https://github.com/trieloff/allegorithm.git"
UPSTREAM_BRANCH="claude/wasm-macro-design-tszl1h"
FILTER_REPO_URL="https://raw.githubusercontent.com/newren/git-filter-repo/main/git-filter-repo"

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(git -C "$DIR" rev-parse --show-toplevel)"
MODE="${1:-}"

die() { printf 'sync: %s\n' "$*" >&2; exit 1; }
note() { printf '\033[2m%s\033[0m\n' "$*" >&2; }

[ -r "$DIR/UPSTREAM" ] || die "missing $DIR/UPSTREAM"
MARKER="$(tr -d '[:space:]' < "$DIR/UPSTREAM")"
[ ${#MARKER} -eq 40 ] || die "UPSTREAM should hold one 40-char sha, got '$MARKER'"

# --- where has upstream got to? -------------------------------------------

HEAD_SHA="$(git ls-remote "$UPSTREAM_URL" "refs/heads/$UPSTREAM_BRANCH" | cut -f1)"
[ -n "$HEAD_SHA" ] || die "no branch $UPSTREAM_BRANCH at $UPSTREAM_URL"

if [ "$MODE" != "--verify" ] && [ "$HEAD_SHA" = "$MARKER" ]; then
  echo "up to date — upstream is still at ${MARKER:0:7}"
  exit 0
fi

if [ "$MODE" = "--check" ]; then
  echo "upstream moved: ${MARKER:0:7} -> ${HEAD_SHA:0:7}"
  exit 3
fi

if [ "$MODE" != "--verify" ] && [ -n "$(git -C "$ROOT" status --porcelain)" ]; then
  die "working tree is dirty — git am needs it clean"
fi

# --- git-filter-repo ------------------------------------------------------

if command -v git-filter-repo >/dev/null 2>&1; then
  FR="$(command -v git-filter-repo)"
else
  FR="$DIR/.cache/git-filter-repo"
  if [ ! -x "$FR" ]; then
    note "fetching git-filter-repo into tools/upstream-sync/.cache/"
    mkdir -p "$DIR/.cache"
    curl -sSfL "$FILTER_REPO_URL" -o "$FR"
    chmod +x "$FR"
  fi
fi

# --- replay the carve -----------------------------------------------------

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

TARGET="$HEAD_SHA"
[ "$MODE" = "--verify" ] && TARGET="$MARKER"

note "cloning $UPSTREAM_BRANCH at ${TARGET:0:7}"
git clone -q --no-checkout "$UPSTREAM_URL" "$WORK/up"
git -C "$WORK/up" checkout -q -B port "$TARGET"
git -C "$WORK/up" remote remove origin
git -C "$WORK/up" for-each-ref --format='%(refname)' refs/remotes |
  while read -r ref; do git -C "$WORK/up" update-ref -d "$ref"; done

# paths.txt names web/playground.template.html rather than web/, because
# playground.html is generated and must not be carried. If upstream grows a
# third file under web/ it would be dropped silently — so say so instead.
UNEXPECTED="$(git -C "$WORK/up" ls-tree --name-only "$TARGET" web/ |
  grep -vE '^web/playground(\.template)?\.html$' || true)"
[ -z "$UNEXPECTED" ] || note "note: upstream web/ has files paths.txt does not carry:
$UNEXPECTED"

( cd "$WORK/up" && python3 "$FR" --force --prune-empty always \
    --paths-from-file "$DIR/paths.txt" \
    --replace-text "$DIR/replacements.txt" \
    --path-rename src/nacre/:src/ \
    --path-rename src/hotglue/:src/ \
    --path-rename test/nacre/:test/ \
    --path-rename test/hotglue/:test/ \
    --strip-blobs-bigger-than 500K >/dev/null )

MAP="$WORK/up/.git/filter-repo/commit-map"
[ -r "$MAP" ] || die "filter-repo wrote no commit-map"

# --- verify mode: does the transform still reproduce this repository? ------

if [ "$MODE" = "--verify" ]; then
  status=0
  while IFS= read -r path; do
    if ! git -C "$WORK/up" show "HEAD:$path" 2>/dev/null | diff -q - "$ROOT/$path" >/dev/null 2>&1; then
      echo "DIFFERS: $path"; status=1
    fi
  done < <(git -C "$WORK/up" ls-tree -r --name-only HEAD)
  [ $status -eq 0 ] && echo "verified — the transform reproduces the tree at ${MARKER:0:7}"
  exit $status
fi

# --- port ------------------------------------------------------------------

FROM="$(awk -v m="$MARKER" '$1==m{print $2}' "$MAP")"
[ -n "$FROM" ] || die "UPSTREAM sha ${MARKER:0:7} is not in the filtered history.
Either it predates the carve, or a rule file changed. Try --verify."

COUNT="$(git -C "$WORK/up" rev-list --count "$FROM..HEAD")"
[ "$COUNT" -gt 0 ] || die "upstream moved, but no new commit touches a Hot Glue path.
Advance UPSTREAM to $HEAD_SHA by hand if that is genuinely all that happened."

BRANCH="upstream-sync-${HEAD_SHA:0:7}"
note "porting $COUNT commit(s) onto $BRANCH"
git -C "$WORK/up" format-patch --stdout "$FROM..HEAD" > "$WORK/port.mbox"

git -C "$ROOT" checkout -q -B "$BRANCH"
git -C "$ROOT" am -3 "$WORK/port.mbox"

printf '%s\n' "$HEAD_SHA" > "$DIR/UPSTREAM"
git -C "$ROOT" add tools/upstream-sync/UPSTREAM
git -C "$ROOT" commit -q -m "Track upstream through ${HEAD_SHA:0:7}

$COUNT commit(s) ported from $UPSTREAM_BRANCH by tools/upstream-sync/sync.sh."

echo
echo "ported $COUNT commit(s) onto $BRANCH — upstream marker now ${HEAD_SHA:0:7}"
echo "next: npm ci && npm test, then open a PR"
