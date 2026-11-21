#!/usr/bin/env bash
# Build the release package and its checksum from an allowlist of files.
#
# Usage: deploy/build-release.sh <release-id> <out-dir>
#
# The output is <out-dir>/<release-id>.tar.gz and <out-dir>/<release-id>.tar.gz.sha256.
# The script refuses a package with a link, or with a file that the allowlist excludes.
set -euo pipefail

die() {
  echo "build-release: $*" >&2
  exit 1
}

[ "$#" -eq 2 ] || die "usage: build-release.sh <release-id> <out-dir>"
ID=$1
OUT=$2
id_re='^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7,40}$'
[[ "$ID" =~ $id_re ]] || die "invalid release id: $ID"

here=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
R=$WORK/release

# 1. Copy the allowlisted files only.
mkdir -p "$R/app/backend" "$R/app/frontend" "$OUT"
cp -R "$here/app/backend/src" "$here/app/backend/migrations" "$R/app/backend/"
cp "$here/app/backend/package.json" "$here/app/backend/package-lock.json" "$R/app/backend/"
cp "$here/app/frontend/index.html" "$here/app/frontend/core.js" "$here/app/frontend/filters.js" "$here/app/frontend/list.js" "$here/app/frontend/bulk.js" "$here/app/frontend/review.js" "$here/app/frontend/bulk-drawer.js" "$here/app/frontend/keys.js" "$here/app/frontend/context.js" "$here/app/frontend/app.js" "$here/app/frontend/datetime.js" "$here/app/frontend/rules.js" "$here/app/frontend/styles.css" "$R/app/frontend/"
cp -R "$here/app/frontend/fonts" "$R/app/frontend/"
cp "$here/deploy/ecosystem.config.cjs" "$R/ecosystem.config.cjs"
# The release id, read by the server for /api/me.
printf '%s\n' "$ID" > "$R/VERSION"

# 2. Production dependencies. The scripts do not run. The .bin links are removed, because the
# activate script refuses links.
(cd "$R/app/backend" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
find "$R/app/backend/node_modules" -name .bin -type d -prune -exec rm -rf {} +

# 3. Refuse links. The activate script refuses them too.
if [ -n "$(find "$R" -type l -print -quit)" ]; then
  die "the package contains a link"
fi

# 4. Create the archive. macOS adds metadata files unless COPYFILE_DISABLE is set.
COPYFILE_DISABLE=1 tar -czf "$OUT/$ID.tar.gz" -C "$R" .

# 5. Refuse excluded files. Dependencies are checked separately, so their own test folders do not
# stop the build.
excluded='(^|/)(sync\.py|tests|test|data|docs|\.git|\.github|\.env[^/]*|sync-log\.jsonl)(/|$)|\.csv$'
bad=$(tar -tzf "$OUT/$ID.tar.gz" | grep -v '^\./app/backend/node_modules/' | grep -E "$excluded" || true)
[ -z "$bad" ] || { echo "$bad" >&2; die "the package contains excluded files"; }

# 6. Checksum. The file name in the checksum file must match the upload name.
(cd "$OUT" && { sha256sum "$ID.tar.gz" 2>/dev/null || shasum -a 256 "$ID.tar.gz"; } > "$ID.tar.gz.sha256")

echo "build-release: $OUT/$ID.tar.gz"
echo "build-release: files: $(tar -tzf "$OUT/$ID.tar.gz" | grep -vc '/$')"
