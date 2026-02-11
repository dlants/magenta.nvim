#!/usr/bin/env sh

# Install git pre-commit hook. Works in both regular repos and worktrees.
GITDIR="$(git rev-parse --git-dir)"
mkdir -p "$GITDIR/hooks"
cp pre-commit "$GITDIR/hooks/pre-commit"
chmod +x "$GITDIR/hooks/pre-commit"
echo "Git pre-commit hook installed successfully"
