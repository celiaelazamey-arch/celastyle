#!/usr/bin/env bash
#
# Recover from a dropped workspace snapshot.
#
# The sandbox restores the working directory between turns and excludes
# node_modules from its snapshots. When that happens the tree silently reverts
# to the clone state: `git log` shows the "Initial commit", every file reads as
# untracked, and node_modules is gone. There is no error and no warning.
#
# This restores the tree to the last pushed state and reinstalls exactly what
# was installed when the last green run was measured.
#
# Safe to run at any time. It refuses rather than guess if there is anything it
# would destroy.

set -euo pipefail

BRANCH="${BRANCH:-arena/01a0ec3c-celastyle}"
REMOTE_REF="origin/${BRANCH}"

cd "$(dirname "$0")/.."

say() { printf '\033[2m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

say "▸ fetching ${REMOTE_REF}"
git fetch origin "${BRANCH}:refs/remotes/${REMOTE_REF}" 2>/dev/null \
  || git fetch origin "${BRANCH}:refs/remotes/${REMOTE_REF}"
git fetch --quiet origin || true

remote_sha=$(git rev-parse --verify "${REMOTE_REF}" 2>/dev/null) \
  || die "branch ${BRANCH} does not exist on origin — nothing to recover to"

# ---------------------------------------------------------------------------
# Refuse if this would lose work.
#
# `reset --mixed` does not delete untracked files, so a reverted tree is
# genuinely safe to reset. Commits that were never pushed are not: the reset
# would orphan them, and they would be invisible to anyone reading this output
# later. Five resets have happened in this project already, and the reason
# nothing was lost is that every commit was pushed first. This check is what
# keeps that true.
# ---------------------------------------------------------------------------
if git rev-parse --verify HEAD >/dev/null 2>&1; then
  ahead=$(git rev-list --count "${REMOTE_REF}..HEAD" 2>/dev/null || echo 0)
  if [ "${ahead}" -gt 0 ] 2>/dev/null; then
    warn "⚠ HEAD is ${ahead} commit(s) ahead of ${REMOTE_REF} and not pushed."
    warn "  Resetting now would orphan them."
    git log --oneline "${REMOTE_REF}..HEAD" | sed 's/^/    /'
    die  "push or stash them first:  git push origin ${BRANCH}"
  fi
fi

say "▸ resetting to ${REMOTE_REF} ($(git rev-parse --short "${REMOTE_REF}"))"
# --mixed re-points HEAD and rebuilds the index but leaves every file on disk
# exactly where it is, so untracked files from a reverted tree survive.
git reset --mixed "${REMOTE_REF}" >/dev/null

# node_modules is excluded from snapshots, so it is always gone. `npm ci`
# rather than `npm install`: the lockfile already pins the tree the last green
# run was measured against, and a range resolve would quietly produce a
# different one.
say "▸ npm ci (reproducing the locked tree)"
npm ci --no-audit --no-fund >/dev/null 2>&1 || npm ci >/dev/null

# ---------------------------------------------------------------------------
# Verify, and report what is true rather than what the script hoped for.
# ---------------------------------------------------------------------------
tracked=$(git ls-files | wc -l | tr -d ' ')
dirty=$(git status --porcelain --untracked-files=all | wc -l | tr -d ' ')
read -r behind ahead <<<"$(git rev-list --left-right --count "${REMOTE_REF}...HEAD" 2>/dev/null || echo '? ?')"

printf '\n'
say "  HEAD      $(git rev-parse --short HEAD)  ($(git log -1 --format=%s))"
say "  tracked   ${tracked} files"
say "  dirty     ${dirty}"
say "  delta     ${behind} behind / ${ahead} ahead"

if [ "${behind}${ahead}" != "00" ]; then
  warn ""
  warn "Not synchronized with origin — the number above is not 0 0."
  warn "Any verdict measured now is not trustworthy."
  exit 1
fi

if [ "${dirty}" -ne 0 ]; then
  warn ""
  warn "Working tree has ${dirty} uncommitted change(s). A recovered run will"
  warn "measure those edits, which is usually not what the panel's number means."
  git status --porcelain --untracked-files=all | head -10 | sed 's/^/    /'
fi

printf '\n'
say "Recovered. Re-run the gates before believing any number they report —"
say "a verdict measured before recovery was measuring the damage."
printf '\n'
