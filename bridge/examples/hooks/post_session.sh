#!/usr/bin/env bash
# Generic shell hook: POST a Session object to the bridge.
# Usage:
#   ./post_session.sh running "Implement feature X"
#   ./post_session.sh idle "Waiting"
#   ./post_session.sh error "Build failed" "permission denied"
set -euo pipefail

BASE_URL="${ACD_BRIDGE_URL:-http://127.0.0.1:8787}"
STATE="${1:-running}"
SUMMARY="${2:-Shell hook update}"
ERROR="${3:-}"
AGENT="${ACD_AGENT:-other}"
ID="${ACD_SESSION_ID:-post:shell:$$}"
TITLE="${ACD_TITLE:-$(basename "$(pwd)")}"
NOW="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

if [[ -n "$ERROR" ]]; then
  BODY=$(jq -n \
    --arg id "$ID" \
    --arg agent "$AGENT" \
    --arg title "$TITLE" \
    --arg summary "$SUMMARY" \
    --arg state "$STATE" \
    --arg updated "$NOW" \
    --arg error "$ERROR" \
    '{id:$id,agent:$agent,title:$title,summary:$summary,state:$state,updated_at:$updated,error:$error,progress:null,detail:null,started_at:null}')
else
  BODY=$(jq -n \
    --arg id "$ID" \
    --arg agent "$AGENT" \
    --arg title "$TITLE" \
    --arg summary "$SUMMARY" \
    --arg state "$STATE" \
    --arg updated "$NOW" \
    '{id:$id,agent:$agent,title:$title,summary:$summary,state:$state,updated_at:$updated,error:null,progress:null,detail:null,started_at:null}')
fi

curl -sS -X POST "$BASE_URL/v1/sessions" \
  -H 'Content-Type: application/json' \
  -d "$BODY" | jq .
