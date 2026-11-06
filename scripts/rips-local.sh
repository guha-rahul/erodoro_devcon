#!/usr/bin/env bash
# Run Rips locally against the Base Sepolia test fixture: the app on
# http://localhost:3100 with dev test buyer/seller wallets, plus a loop that
# refreshes the house quotes (they expire after five minutes). Test-only keys
# and the fixture manifest live outside the repository. Ctrl-C stops both.
set -euo pipefail
cd "$(dirname "$0")/.."

MANIFEST="${RIP_TEST_MANIFEST:-/tmp/erodoro-rips-sepolia-v3.json}"
BUYER_KEY_FILE="${RIP_TEST_BUYER_FILE:-/tmp/erodoro-rips-sepolia-test-buyer.json}"
SELLER_KEY_FILE="${RIP_TEST_SELLER_FILE:-/tmp/erodoro-rips-sepolia-test-seller.json}"
PORT="${PORT:-3100}"
for f in "$MANIFEST" "$BUYER_KEY_FILE" "$SELLER_KEY_FILE"; do
  [ -f "$f" ] || { echo "Missing $f (create the test fixture first)." >&2; exit 1; }
done

refresh_quotes() {
  while true; do
    if out=$(RIP_TEST_MANIFEST="$MANIFEST" node scripts/rips-sepolia.mjs quotes 2>&1); then
      echo "[quotes $(date +%H:%M:%S)] $(echo "$out" | tail -1)"
      # A refresh takes up to a minute; quotes live five, so restart well inside that.
      sleep 150
    else
      # The public RPC drops calls now and then. Retry soon, or the quotes lapse.
      echo "[quotes $(date +%H:%M:%S)] refresh failed, retrying in 15s: $(echo "$out" | grep -m1 -iE 'error|failed' | cut -c1-160)"
      sleep 15
    fi
  done
}
refresh_quotes &
QUOTES_PID=$!
trap 'kill $QUOTES_PID 2>/dev/null' EXIT

cd app
NEXT_PUBLIC_CHAIN_ID=84532 \
NEXT_PUBLIC_RIP_POOL_ADDRESS="$(jq -r .pool "$MANIFEST")" \
NEXT_PUBLIC_RIP_PUT_ADDRESS="$(jq -r .put "$MANIFEST")" \
NEXT_PUBLIC_RIP_DEPLOY_BLOCK="$(jq -r .poolDeployBlock "$MANIFEST")" \
NEXT_PUBLIC_DEV_TEST_WALLET_KEY="$(jq -r .privateKey "$BUYER_KEY_FILE")" \
NEXT_PUBLIC_DEV_TEST_SELLER_KEY="$(jq -r .privateKey "$SELLER_KEY_FILE")" \
  pnpm dev -p "$PORT" --webpack
