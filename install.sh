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
# MACH_REQUIRE_PROVENANCE=1 refuses a prebuilt program whose build provenance cannot be verified with gh.
set -euo pipefail

REPO="${MACH_REPO:-swiftj/mach-harness}"
REF="${MACH_REF:-main}"
COMMAND="${1:-install}"
[ "$#" -gt 0 ] && shift

# On a Mac, python3 and git come with Apple's command line tools; /usr/bin/python3 exists without
# them but does not run, so it is run here, not just looked up. bin/mach checks Git the same way.
if ! python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)' >/dev/null 2>&1; then
  echo "MACH needs Python 3.8 or later, and it is not installed on this computer (or is older)." >&2
  echo "On a Mac, open Terminal, run  xcode-select --install  and click Install in the window that appears" >&2
  echo "(it installs Apple's command line tools, which include Python 3 and Git); on Linux, install the" >&2
  echo "'python3' package. Then run this again." >&2
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
