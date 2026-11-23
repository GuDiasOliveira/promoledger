#!/usr/bin/env bash
# PostToolUse hook: format the file Claude Code just wrote/edited with the same
# tools and config the editor uses on save (Prettier via .prettierrc.json, ruff via
# backend/pyproject.toml), so opening and saving it in Antigravity yields no diff.
# Never blocks Claude: any failure is ignored.
set -u
root="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
file="$(jq -r '.tool_input.file_path // empty' 2>/dev/null)"
[ -n "$file" ] && [ -f "$file" ] || exit 0
case "$file" in "$root"/*) ;; *) exit 0 ;; esac

case "$file" in
  *.py)
    (cd "$root/backend" && uv run --quiet ruff format --quiet "$file") >/dev/null 2>&1
    ;;
  *.md | *.ts | *.tsx | *.mts | *.cts | *.js | *.mjs | *.cjs | *.jsx | *.json | *.yml | *.yaml | *.css)
    prettier="$root/frontend/node_modules/.bin/prettier"
    [ -x "$prettier" ] || exit 0
    # Run from the root so .gitignore/.prettierignore apply like they do in the editor.
    (cd "$root" && "$prettier" --write --ignore-unknown --log-level silent "$file") >/dev/null 2>&1
    ;;
esac
exit 0
