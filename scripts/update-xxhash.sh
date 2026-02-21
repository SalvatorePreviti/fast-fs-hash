#!/usr/bin/env bash
# update-xxhash.sh — Fetch the latest xxHash release and update the submodule.
#
# Usage:
#   ./scripts/update-xxhash.sh          # update to the latest release tag
#   ./scripts/update-xxhash.sh v0.8.4   # update to a specific tag
#
# After running, review the diff and commit:
#   git add deps/xxHash
#   git commit -m "deps: update xxHash to <version>"

set -euo pipefail

SUBMODULE_DIR="deps/xxHash"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cd "$REPO_ROOT"

# Ensure the submodule is initialised
if [ ! -d "$SUBMODULE_DIR/.git" ] && [ ! -f "$SUBMODULE_DIR/.git" ]; then
  echo "Initialising submodule..."
  git submodule update --init "$SUBMODULE_DIR"
fi

cd "$SUBMODULE_DIR"

# Fetch all tags from upstream
git fetch --tags origin

# Determine target version
if [ $# -ge 1 ]; then
  TARGET_TAG="$1"
else
  # Pick the latest vX.Y.Z tag (sorted by version number)
  TARGET_TAG=$(git tag -l 'v*' | sort -V | tail -n1)
  if [ -z "$TARGET_TAG" ]; then
    echo "ERROR: no version tags found in xxHash repository" >&2
    exit 1
  fi
fi

CURRENT=$(git describe --tags --exact-match 2>/dev/null || git rev-parse --short HEAD)

if [ "$CURRENT" = "$TARGET_TAG" ]; then
  echo "xxHash is already at $TARGET_TAG — nothing to do."
  exit 0
fi

echo "Updating xxHash: $CURRENT → $TARGET_TAG"
git checkout "$TARGET_TAG"

# Extract version number (strip leading 'v')
VERSION="${TARGET_TAG#v}"

cd "$REPO_ROOT"

# ── Update version references in source files ────────────────────────────

update_file() {
  local file="$1"
  local old_pattern="$2"
  local new_text="$3"
  if [ -f "$file" ]; then
    if grep -q "$old_pattern" "$file" 2>/dev/null; then
      sed -i.bak -E "s|$old_pattern|$new_text|g" "$file"
      rm -f "$file.bak"
      echo "  Updated $file"
    fi
  fi
}

# CMakeLists.txt comments
update_file "CMakeLists.txt" \
  "v[0-9]+\.[0-9]+\.[0-9]+" "v${VERSION}"

# NOTICES.md (root and package)
update_file "NOTICES.md" \
  "\(v[0-9]+\.[0-9]+\.[0-9]+\)" "(v${VERSION})"
update_file "packages/fast-fs-hash/NOTICES.md" \
  "\(v[0-9]+\.[0-9]+\.[0-9]+\)" "(v${VERSION})"

echo ""
echo "Done. xxHash updated to $TARGET_TAG."
echo ""
echo "Next steps:"
echo "  1. Rebuild:  npm run build:native"
echo "  2. Test:     npm test"
echo "  3. Commit:   git add -A && git commit -m 'deps: update xxHash to $TARGET_TAG'"
