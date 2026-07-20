#!/usr/bin/env bash
# Forward a Grok/Claude-style hook envelope (JSON on stdin) to the local ACD bridge.
#
# Usage (as a Grok command hook):
#   "command": "/absolute/path/to/forward_acd_hook.sh grok"
#   "command": "/absolute/path/to/forward_acd_hook.sh claude"
#
# Env:
#   ACD_BRIDGE_URL  base URL (default http://127.0.0.1:8787)
#
# Why a command hook (not type:http)? Grok only allows https:// for HTTP hooks;
# the MVP bridge is loopback plain HTTP, so we curl from a shell hook instead.
set -euo pipefail

AGENT="${1:-grok}"
case "$AGENT" in
  grok)   PATH_SUFFIX="/v1/hooks/grok" ;;
  claude|claude-code) PATH_SUFFIX="/v1/hooks/claude" ;;
  *)
    echo "usage: $0 grok|claude" >&2
    exit 1
    ;;
esac

BASE_URL="${ACD_BRIDGE_URL:-http://127.0.0.1:8787}"
URL="${BASE_URL}${PATH_SUFFIX}"

# Fail open for the agent: bridge down should not block tool use.
if ! curl -sS -m 4 -X POST "$URL" \
  -H 'Content-Type: application/json' \
  --data-binary @- \
  -o /dev/null; then
  echo "acd-bridge unreachable at $URL (is acd-bridge serve running?)" >&2
  exit 0
fi
exit 0
