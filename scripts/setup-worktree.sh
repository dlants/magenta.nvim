#!/usr/bin/env sh
set -e

# Creates a new git worktree and sets it up for development.
# Usage: scripts/setup-worktree.sh <branch-name> [base-branch]
#
# Must be run from within an existing worktree or the bare repo.
# The new worktree is created as a sibling directory.
#
# Examples:
#   scripts/setup-worktree.sh my-feature          # new branch off current HEAD
#   scripts/setup-worktree.sh my-feature main     # new branch off main
#   scripts/setup-worktree.sh main                # check out existing branch

BRANCH="$1"
BASE="$2"

if [ -z "$BRANCH" ]; then
  echo "Usage: scripts/setup-worktree.sh <branch-name> [base-branch]"
  exit 1
fi

REPO_ROOT="$(git rev-parse --git-common-dir)"
PARENT_DIR="$(dirname "$REPO_ROOT")"
WORKTREE_DIR="$PARENT_DIR/$BRANCH"

if [ -d "$WORKTREE_DIR" ]; then
  echo "Error: directory $WORKTREE_DIR already exists"
  exit 1
fi

echo "Creating worktree at $WORKTREE_DIR..."

# Check if the branch already exists
if git rev-parse --verify "$BRANCH" >/dev/null 2>&1; then
  git worktree add "$WORKTREE_DIR" "$BRANCH"
elif [ -n "$BASE" ]; then
  git worktree add -b "$BRANCH" "$WORKTREE_DIR" "$BASE"
else
  git worktree add -b "$BRANCH" "$WORKTREE_DIR"
fi

echo "Setting up tracking..."
git branch --set-upstream-to="origin/$BRANCH" "$BRANCH" 2>/dev/null || true
echo "Setting up hooks..."
cd "$WORKTREE_DIR"
GITDIR="$(git rev-parse --git-dir)"
mkdir -p "$GITDIR/hooks"
cp "$WORKTREE_DIR/pre-commit" "$GITDIR/hooks/pre-commit"
chmod +x "$GITDIR/hooks/pre-commit"

echo "Installing dependencies..."
npm ci

echo "Worktree $BRANCH is ready at $WORKTREE_DIR"
