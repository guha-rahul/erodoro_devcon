#!/usr/bin/env bash
# Fetch a genuinely signed Pyth price update from Hermes and emit it as the
# environment the fork suite reads.
#
#   eval "$(script/fetch-hermes.sh 0x<feed-id>)"
#
# The update is signed by Pyth's publishers and verified through Wormhole
# guardian signatures inside Pyth's own contract on the fork. Nothing here
# fabricates a price; if Hermes is down, the fork suite has no quote and says so
# rather than inventing one.
set -euo pipefail

FEED_ID="${1:-${BASE_FEED_ID:-}}"
HERMES="${PYTH_HERMES_URL:-https://hermes.pyth.network}"

if [[ -z "$FEED_ID" ]]; then
  echo "usage: $0 <feed-id-hex>   (or set BASE_FEED_ID)" >&2
  exit 2
fi

ID="${FEED_ID#0x}"
TARGET_TS="${2:-}"
# A supplied timestamp selects the first update at or after a live series
# maturity. Without one, discover the most recent unique update for fork tests.
if [[ -z "$TARGET_TS" ]]; then
  LATEST="$(curl -sSf "${HERMES}/v2/updates/price/latest?ids[]=${ID}&encoding=hex")"
  LATEST_TS="$(printf '%s' "$LATEST" | python3 -c 'import json,sys; print(json.load(sys.stdin)["parsed"][0]["price"]["publish_time"])')"
  TARGET_TS="$((LATEST_TS - 1))"
fi
if [[ ! "$TARGET_TS" =~ ^[0-9]+$ ]]; then
  echo "timestamp must be Unix seconds" >&2
  exit 2
fi
RESP="$(curl -sSf "${HERMES}/v2/updates/price/${TARGET_TS}?ids[]=${ID}&encoding=hex")"

DATA="$(printf '%s' "$RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin)["binary"]["data"][0])')"
TS="$(printf '%s' "$RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin)["parsed"][0]["price"]["publish_time"])')"
PRICE="$(printf '%s' "$RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin)["parsed"][0]["price"]["price"])')"
EXPO="$(printf '%s' "$RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin)["parsed"][0]["price"]["expo"])')"
printf '%s' "$RESP" | python3 -c '
import json,sys
p=json.load(sys.stdin)["parsed"][0]
target=int(sys.argv[1])
if not (p["metadata"]["prev_publish_time"] < target <= p["price"]["publish_time"]):
    raise SystemExit("Hermes update does not satisfy the Pyth uniqueness precondition")
' "$TARGET_TS"

echo "export BASE_FEED_ID=0x${ID}"
echo "export BASE_PYTH_UPDATE=0x${DATA}"
echo "export BASE_PYTH_PUBLISH_TIME=${TS}"
echo "export BASE_PYTH_PRICE=${PRICE}"
echo "export BASE_PYTH_EXPO=${EXPO}"
