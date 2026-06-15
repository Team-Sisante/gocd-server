#!/bin/bash
# Installs the pre-commit security hook to the current git repository

HOOK_DIR=".git/hooks"
HOOK_FILE="$HOOK_DIR/pre-commit"
SOURCE_HOOK="/home/solomiosisante/gocd-server/Scripts/pre-commit-security-check.sh"

echo "Installing security pre-commit hook..."
mkdir -p "$HOOK_DIR"
ln -sf "$SOURCE_HOOK" "$HOOK_FILE"
chmod +x "$HOOK_FILE"
echo "Security hook installed at $HOOK_FILE"
