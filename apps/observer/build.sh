#!/bin/sh
# Build mach-observer with the Control Tower web app embedded, reproducibly (as apps/studio does):
#   1. install the web workspace's locked dependencies (skip with SKIP_INSTALL=1),
#   2. build web/apps/control-tower,
#   3. check the build can run under the observer's Content-Security-Policy,
#   4. copy it over internal/webui/dist and build the binary,
#   5. put the committed placeholder back, so the working tree is unchanged.
# Output: bin/mach-observer (override with OUT=...). Without this script (`make host`), the binary
# serves a placeholder page that says it was built without the app; the API is the same.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
WEB="$ROOT/web"
APP_DIST="$WEB/apps/control-tower/dist"
DIST="$HERE/internal/webui/dist"
OUT=${OUT:-"$HERE/bin/mach-observer"}

STAGE=$(mktemp -d)
cp -R "$DIST" "$STAGE/placeholder"
restore() {
    rm -rf "$DIST"
    cp -R "$STAGE/placeholder" "$DIST"
    rm -rf "$STAGE"
}
trap restore EXIT INT TERM

cd "$WEB"
if [ "${SKIP_INSTALL:-0}" != "1" ]; then
    pnpm install --frozen-lockfile
fi
pnpm --filter @mach/control-tower build

# The observer serves with script-src 'self', style-src 'self' and font-src 'self': no inline
# script or style attribute in the HTML, and no font or script inlined as a data: URI.
if [ ! -f "$APP_DIST/index.html" ]; then
    echo "build.sh: $APP_DIST/index.html was not produced" >&2
    exit 1
fi
if grep -rEl 'data:(font|application)/' "$APP_DIST" >/dev/null 2>&1; then
    echo "build.sh: the build inlines a font or script as a data: URI; the observer's CSP refuses it:" >&2
    grep -rEl 'data:(font|application)/' "$APP_DIST" >&2
    exit 1
fi
if grep -El 'style="|<script>|<script [^>]*>[^<]' "$APP_DIST/index.html" >/dev/null 2>&1; then
    echo "build.sh: index.html has an inline script or style attribute; the observer's CSP refuses it" >&2
    exit 1
fi
if grep -rEl 'https?://' "$APP_DIST" --include='*.html' >/dev/null 2>&1 && grep -Eq '<(script|link)[^>]+(src|href)="https?://' "$APP_DIST/index.html"; then
    echo "build.sh: index.html loads something from another origin; the observer serves everything itself" >&2
    exit 1
fi

rm -rf "$DIST"
cp -R "$APP_DIST" "$DIST"
cd "$HERE"
mkdir -p "$(dirname "$OUT")"
go build -trimpath -o "$OUT" ./cmd/mach-observer
echo "built $OUT with the Control Tower from $APP_DIST"
