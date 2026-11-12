#!/bin/sh
# Smoke-test a built mach-observer: start it on a throwaway project on a free port, open the
# one-time link, read the session and a few endpoints through the cookie, check the CSP and that a
# non-GET is refused, then stop it and require a clean exit.   Usage: smoke.sh <path to mach-observer>
set -eu
BIN=$1
WORK=$(mktemp -d)
PID=""
cleanup() {
    [ -n "$PID" ] && kill "$PID" 2>/dev/null || true
    rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

mkdir -p "$WORK/project/.factory/intake" "$WORK/project/.factory/worktrees"
git init -q "$WORK/project"
"$BIN" --project "$WORK/project" >"$WORK/log" 2>&1 &
PID=$!
LINK=""
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    LINK=$(sed -n 's/^Open: //p' "$WORK/log" | head -1)
    [ -n "$LINK" ] && break
    kill -0 "$PID" 2>/dev/null || { echo "smoke: the observer stopped:" >&2; cat "$WORK/log" >&2; exit 1; }
    sleep 0.5
done
[ -n "$LINK" ] || { echo "smoke: no link was printed:" >&2; cat "$WORK/log" >&2; exit 1; }
ORIGIN=${LINK%%/\?*}
case "$ORIGIN" in http://127.0.0.1:*) ;; *) echo "smoke: not a loopback address: $ORIGIN" >&2; exit 1 ;; esac

JAR="$WORK/cookies"
PAGE=$(curl -fsS -L -c "$JAR" -b "$JAR" "$LINK")
echo "$PAGE" | grep -q 'id="root"' || { echo "smoke: the page is not the app (or its placeholder)" >&2; exit 1; }
curl -fsS -D "$WORK/headers" -o /dev/null -b "$JAR" "$ORIGIN/"
grep -qi "^content-security-policy: default-src 'none'" "$WORK/headers" || { echo "smoke: no CSP on the page" >&2; exit 1; }

check() { # check <path> <python assertion on d>
    curl -fsS -b "$JAR" "$ORIGIN$1" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['ok'], d; d=d['data']; assert $2, d"
}
check /api/v1/session "d['read_only'] is True and d['versions']['event']['schema'] == 3 and d['capabilities']['execution'] is False"
check /api/v1/health "d['status'] in ('ok', 'degraded') and 'freshness' in d"
check "/api/v1/events?schema=3&limit=5" "'events' in d and 'next' in d"
check /api/v1/snapshot "'cursor' in d and 'state' in d"
check /api/v1/factory/status "d['factory_present'] is True"
check /api/v1/analytics/metrics "len(d['metrics']) > 40"

code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -X POST "$ORIGIN/api/v1/health")
[ "$code" = 405 ] || { echo "smoke: a POST was answered $code, not 405" >&2; exit 1; }
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" "$ORIGIN/api/v1/events?schema=2")
[ "$code" = 400 ] || { echo "smoke: schema 2 was answered $code, not 400" >&2; exit 1; }
code=$(curl -s -o /dev/null -w '%{http_code}' "$ORIGIN/api/v1/health")
[ "$code" = 401 ] || { echo "smoke: no cookie was answered $code, not 401" >&2; exit 1; }
[ -f "$WORK/project/.factory/local/observer/link" ] || { echo "smoke: no next link was saved" >&2; exit 1; }

kill -TERM "$PID"
STATUS=0
wait "$PID" || STATUS=$?
PID=""
[ "$STATUS" = 0 ] || { echo "smoke: the observer exited $STATUS" >&2; cat "$WORK/log" >&2; exit 1; }
[ ! -f "$WORK/project/.factory/local/observer/link" ] || { echo "smoke: the link file outlived the observer" >&2; exit 1; }
echo "smoke: ok ($(basename "$BIN"): page, session, events, snapshot, status, metrics, CSP, GET only on $ORIGIN)"
