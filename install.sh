#!/usr/bin/env bash
# MACH one-line installer. Run it from the project you want MACH in:
#
#   curl -fsSL https://raw.githubusercontent.com/swiftj/mach-harness/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/swiftj/mach-harness/main/install.sh | bash -s -- uninstall
#
# Arguments are passed to 'mach' (install, uninstall, status, scaffold; --dry-run, --force, --no-studio, --no-floor).
#
# What it installs: the newest MACH release, or MACH_VERSION=<x.y.z>. It downloads that release's
# source archive (mach-<version>-source.tar.gz) and SHA256SUMS, checks the archive against the
# checksum and, when the GitHub CLI is available, verifies the archive's build provenance with
# gh attestation verify (the same rule and words bin/mach uses for the prebuilt programs). All of this
# happens before any downloaded code runs; anything that fails is refused, nothing is installed and
# the downloads are removed. There is no fallback from a failed check to an unchecked source.
# Releases up to v0.12.0 have no source archive: their tag is downloaded and the note says it was
# not verified.
#
# Unverified sources, only by explicit choice: MACH_REF=<branch> (e.g. main) downloads a branch;
# MACH_SOURCE=/path/to/mach-harness uses a local copy. The note then says the source was not verified.
# MACH_REQUIRE_PROVENANCE=1 refuses any source (and any prebuilt program) whose provenance cannot be verified.
# MACH_REPO=owner/name chooses the repository. MACH_STUDIO=skip and MACH_FLOOR=skip skip the prebuilt programs.
set -euo pipefail

REPO="${MACH_REPO:-swiftj/mach-harness}"
COMMAND="${1:-install}"
[ "$#" -gt 0 ] && shift
# The same rule and words as bin/mach (RELEASE_WORKFLOW, NO_GH, GH_AUTH_REQUIRED, check_provenance).
RELEASE_WORKFLOW=".github/workflows/release.yml"
NO_GH="GitHub CLI not available"
GH_AUTH_REQUIRED=4
# The newest release made before source archives were published.
LAST_WITHOUT_ARCHIVE="0.12.0"

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

WORK=""
cleanup() { if [ -n "$WORK" ]; then rm -rf "$WORK"; fi; }
trap cleanup EXIT

refuse() {
  echo "error: $*" >&2
  echo "Nothing was installed, and the downloaded files were removed." >&2
  exit 2
}

required() {
  case "$(printf '%s' "${MACH_REQUIRE_PROVENANCE:-}" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')" in
    1|yes|true|on) return 0 ;;
  esac
  return 1
}

# A source that cannot be verified: refused under MACH_REQUIRE_PROVENANCE=1, otherwise one plain note.
unverified() {  # $1: what the source is; $2: why it could not be verified
  if required; then
    refuse "the MACH source ($1) could not be verified ($2) and MACH_REQUIRE_PROVENANCE=1 requires it, so it was refused"
  fi
  CHECKED="not verified ($2)"
  echo "MACH source: $1; it was not verified ($2)."
}

download() {  # $1: URL, $2: file. Only https (a redirect too); curl -f fails on an HTTP error.
  curl -fsSL --proto '=https' --proto-redir '=https' --retry 2 "$1" -o "$2" 2>/dev/null
}

newest_from_page() {  # prints the newest full release's tag, read from where the release page redirects to
  local url
  url="$(curl -fsSL --proto '=https' --proto-redir '=https' --retry 2 -o /dev/null -w '%{url_effective}' \
    "https://github.com/$REPO/releases/latest" 2>/dev/null)" || return 1
  case "$url" in
    */releases/tag/v*) printf '%s' "${url##*/releases/tag/}" ;;
    *) return 1 ;;
  esac
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    refuse "neither sha256sum nor shasum is installed, so the download cannot be checked"
  fi
}

unpack() {  # $1: archive; unpacks into $WORK/src and sets SOURCE
  mkdir "$WORK/src"
  tar -xzf "$1" -C "$WORK/src" --strip-components=1 || refuse "the downloaded MACH source could not be unpacked"
  SOURCE="$WORK/src"
}

set_count=0
for name in MACH_SOURCE MACH_REF MACH_VERSION; do
  if [ -n "${!name:-}" ]; then set_count=$((set_count + 1)); fi
done
[ "$set_count" -le 1 ] || refuse "set only one of MACH_SOURCE, MACH_REF and MACH_VERSION"

if [ -n "${MACH_SOURCE:-}" ]; then
  SOURCE="$MACH_SOURCE"
  unverified "the local copy named by MACH_SOURCE" "a local copy has no checksum or build provenance"
  FROM="a local copy (MACH_SOURCE)"
elif [ -n "${MACH_REF:-}" ]; then
  REF="$MACH_REF"
  [[ "$REF" =~ ^[A-Za-z0-9._/-]+$ ]] || refuse "MACH_REF must be a branch name"
  FROM="github.com/$REPO branch $REF"
  unverified "$FROM" "a branch has no checksum or build provenance; install a release to have it checked"
  WORK="$(mktemp -d)"
  download "https://codeload.github.com/$REPO/tar.gz/refs/heads/$REF" "$WORK/branch.tar.gz" \
    || refuse "branch $REF of github.com/$REPO could not be downloaded; check the name and the internet connection"
  unpack "$WORK/branch.tar.gz"
else
  WORK="$(mktemp -d)"
  VERSION="${MACH_VERSION:-}"
  VERSION="${VERSION#v}"
  if [ -z "$VERSION" ]; then
    if download "https://api.github.com/repos/$REPO/releases/latest" "$WORK/latest.json"; then
      VERSION="$(python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1]))["tag_name"])' "$WORK/latest.json" 2>/dev/null || true)"
    else
      # GitHub's API answers only so many unsigned requests an hour from one address, and some networks
      # block it. The release page needs neither: it redirects to the newest release's own address.
      VERSION="$(newest_from_page || true)"
      [ -n "$VERSION" ] || refuse "the newest MACH release of github.com/$REPO could not be found (GitHub's API did not answer, which also happens when its hourly limit for this network is used up, and the release page did not name one); check the internet connection, or set MACH_VERSION, for example MACH_VERSION=0.14.0"
    fi
    VERSION="${VERSION#v}"
  fi
  # The pattern lives in a variable so that a plain POSIX shell can still parse this file (sh -n).
  version_pattern='^[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$'
  [[ "$VERSION" =~ $version_pattern ]] || refuse "'$VERSION' is not a MACH release version (x.y.z, or x.y.z-rc.N for a release candidate)"

  if python3 -I -c 'import sys; v, last = (tuple(map(int, a.split("-")[0].split("."))) for a in sys.argv[1:]); sys.exit(0 if v <= last else 1)' \
       "$VERSION" "$LAST_WITHOUT_ARCHIVE"; then
    # Made before source archives were published: install it as before, and say it was not verified.
    FROM="github.com/$REPO tag v$VERSION"
    unverified "$FROM" "release v$VERSION predates MACH's source archives, so its source has no checksum or attestation"
    # Nobody asked for this version: it is only the newest full release. If a later release candidate exists,
    # say so, because that one can be verified. Looking it up is best effort and never stops the install.
    if [ -z "${MACH_VERSION:-}" ] && download "https://api.github.com/repos/$REPO/releases?per_page=30" "$WORK/releases.json" 2>/dev/null; then
      NEWER="$(python3 -I -c '
import json, re, sys
def core(v): return tuple(map(int, v.split("-")[0].split(".")))
have = core(sys.argv[2])
for r in json.load(open(sys.argv[1])):
    tag = str(r.get("tag_name", "")).lstrip("v")
    if not r.get("draft") and re.fullmatch(r"\d+\.\d+\.\d+(-rc\.\d+)?", tag) and core(tag) > have:
        print(tag); break
' "$WORK/releases.json" "$VERSION" 2>/dev/null || true)"
      if [ -n "$NEWER" ]; then
        echo "MACH $VERSION is the newest full release. A later release candidate, v$NEWER, is available and its source can be verified."
        echo "To install that one instead, run this again with MACH_VERSION=$NEWER set."
      fi
    fi
    download "https://codeload.github.com/$REPO/tar.gz/refs/tags/v$VERSION" "$WORK/tag.tar.gz" \
      || refuse "release v$VERSION of github.com/$REPO could not be downloaded; check the version and the internet connection"
    unpack "$WORK/tag.tar.gz"
  else
    ARCHIVE="mach-$VERSION-source.tar.gz"
    BASE="https://github.com/$REPO/releases/download/v$VERSION"
    FROM="github.com/$REPO release v$VERSION ($ARCHIVE)"
    download "$BASE/SHA256SUMS" "$WORK/SHA256SUMS" \
      || refuse "release v$VERSION was not found, or it has no checksum file (SHA256SUMS); check the version and the internet connection"
    EXPECTED="$(awk -v n="$ARCHIVE" '$2 == n || $2 == "*" n { print tolower($1); exit }' "$WORK/SHA256SUMS")"
    # A release after v$LAST_WITHOUT_ARCHIVE must carry its source archive: no fallback to an unchecked download.
    [ -n "$EXPECTED" ] || refuse "release v$VERSION does not list $ARCHIVE in its SHA256SUMS, so its source cannot be checked"
    download "$BASE/$ARCHIVE" "$WORK/$ARCHIVE" \
      || refuse "release v$VERSION does not have the file $ARCHIVE, or it could not be downloaded; check the internet connection"
    [ "$(sha256 "$WORK/$ARCHIVE")" = "$EXPECTED" ] \
      || refuse "$ARCHIVE does not match the release's published checksum, so it was refused"
    # Build provenance, before any of the downloaded code runs.
    REASON=""
    if command -v gh >/dev/null 2>&1; then
      code=0
      gh attestation verify "$WORK/$ARCHIVE" --repo "$REPO" --signer-workflow "$REPO/$RELEASE_WORKFLOW" >/dev/null 2>&1 || code=$?
      if [ "$code" -eq "$GH_AUTH_REQUIRED" ]; then
        REASON="$NO_GH"
      elif [ "$code" -ne 0 ]; then
        refuse "$ARCHIVE matched the release's checksum, but its build provenance did not verify (gh attestation verify, $REPO), so it was refused and removed"
      fi
    else
      REASON="$NO_GH"
    fi
    if [ -z "$REASON" ]; then
      CHECKED="checked against the release's checksum and its build provenance was verified with the GitHub CLI (gh attestation verify, $REPO)"
    elif required; then
      refuse "$ARCHIVE: its build provenance could not be verified ($REASON) and MACH_REQUIRE_PROVENANCE=1 requires it, so it was refused"
    else
      CHECKED="checked against the release's checksum; its build provenance was not verified ($REASON)"
    fi
    echo "MACH source: $FROM, $CHECKED."
    unpack "$WORK/$ARCHIVE"
    rm -f "$WORK/$ARCHIVE"
  fi
  INSIDE="$(python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1]))["version"])' "$SOURCE/.claude-plugin/plugin.json" 2>/dev/null || true)"
  [ "$INSIDE" = "$VERSION" ] || refuse "the downloaded source says it is MACH '$INSIDE', not $VERSION, so it was refused"
fi

# bin/mach records where the source came from and how it was checked in the install manifest.
MACH_INSTALL_SOURCE="$FROM" MACH_INSTALL_CHECKED="$CHECKED" python3 "$SOURCE/bin/mach" "$COMMAND" "$@"
