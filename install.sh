#!/usr/bin/env bash
# MACH one-line installer. Run it from the project you want MACH in:
#
#   curl -fsSL https://raw.githubusercontent.com/swiftj/mach-harness/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/swiftj/mach-harness/main/install.sh | bash -s -- uninstall
#
# Arguments are passed to 'mach' (install, uninstall, status, scaffold; --dry-run, --force).
# MACH_REPO=owner/name and MACH_REF=branch choose where to download from.
# MACH_SOURCE=/path/to/mach-harness uses a local copy instead of downloading.
# MACH_STUDIO=skip and MACH_TOWER=skip (or --no-studio, --no-tower) skip the prebuilt programs.
set -euo pipefail

REPO="${MACH_REPO:-swiftj/mach-harness}"
REF="${MACH_REF:-main}"
COMMAND="${1:-install}"
[ "$#" -gt 0 ] && shift

if ! command -v python3 >/dev/null 2>&1; then
  echo "MACH needs python3 (3.8 or later). Install it and run this again." >&2
  exit 1
fi

# Removing or inspecting needs no download once MACH is in the project.
if [ "$COMMAND" != "install" ] && [ "$COMMAND" != "scaffold" ] && [ -f .factory/bin/mach ]; then
  exec python3 .factory/bin/mach "$COMMAND" "$@"
fi

if [ -n "${MACH_SOURCE:-}" ]; then
  SOURCE="$MACH_SOURCE"
else
  SOURCE="$(mktemp -d)"
  trap 'rm -rf "$SOURCE"' EXIT
  echo "Downloading MACH from github.com/$REPO ($REF)..."
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/$REF" | tar -xz -C "$SOURCE" --strip-components=1
fi

python3 "$SOURCE/bin/mach" "$COMMAND" "$@"
