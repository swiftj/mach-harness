#!/bin/sh
# Smoke-test a built mach-studio: start it on a throwaway project, open the one-time link, and ask
# the engine for the project's status through the API. Proves the program runs on this machine,
# serves the embedded app, and reaches the engine.   Usage: smoke.sh <path to mach-studio>
set -eu
BIN=$1
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
WORK=$(mktemp -d)
PID=""
cleanup() {
    [ -n "$PID" ] && kill "$PID" 2>/dev/null || true
    rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

git init -q "$WORK/project"
"$BIN" --project "$WORK/project" --engine "$ROOT/skills/product-studio/scripts/studio.py" --no-open >"$WORK/log" 2>&1 &
PID=$!
LINK=""
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    LINK=$(sed -n 's/^Open: //p' "$WORK/log" | head -1)
    [ -n "$LINK" ] && break
    kill -0 "$PID" 2>/dev/null || { echo "smoke: the host stopped:" >&2; cat "$WORK/log" >&2; exit 1; }
    sleep 0.5
done
[ -n "$LINK" ] || { echo "smoke: no link was printed:" >&2; cat "$WORK/log" >&2; exit 1; }
ORIGIN=${LINK%%/\?*}
case "$ORIGIN" in http://127.0.0.1:*) ;; *) echo "smoke: not a loopback address: $ORIGIN" >&2; exit 1 ;; esac

JAR="$WORK/cookies"
PAGE=$(curl -fsS -L -c "$JAR" -b "$JAR" "$LINK")
echo "$PAGE" | grep -q '<div id="root"' || { echo "smoke: the page is not the app" >&2; exit 1; }
SESSION=$(curl -fsS -b "$JAR" "$ORIGIN/api/session")
TOKEN=$(printf '%s' "$SESSION" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["ok"], d; print(d["data"]["csrf_token"])')
STATUS=$(curl -fsS -b "$JAR" -X POST -H "Origin: $ORIGIN" -H "X-MACH-CSRF: $TOKEN" -H "Content-Type: application/json" -d '{}' "$ORIGIN/api/ops/status")
printf '%s' "$STATUS" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["ok"] and d["data"]["factory_authorized"] is False, d'
echo "smoke: ok ($(basename "$BIN"): page, session and engine status on $ORIGIN)"
