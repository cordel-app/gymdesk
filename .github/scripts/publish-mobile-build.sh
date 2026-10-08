#!/usr/bin/env bash
# #1077 (mobile app WP5): publishes one build to the bucket the Cordel → Mobile builds
# page lists, and prunes older ones. The only writer of that page's data.
#
# It uploads the build file and a sidecar describing it:
#
#   cordel/mobile-builds/<app id>/<platform>/<file>
#   cordel/mobile-builds/<app id>/<platform>/<file>.json
#
# The layout and the sidecar's fields are `api/src/domain/mobileBuilds.ts`'s, and
# `api/src/test/mobile-builds.unit.test.ts` fails the build if this file stops writing a
# field the API requires, or keeps a different number than MOBILE_BUILD_RETENTION.
#
# Inputs (environment): BUILD_FILE BUILD_PLATFORM APP_ID APP_NAME ENV_NAME VERSION
#   BUILD_NUMBER GIT_SHA RUN_URL [SIGNER_SHA1], and the R2 settings R2_ENDPOINT
#   R2_BUCKET AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY. With the R2 settings missing it
#   warns and does nothing: a build that cannot be published is still a build.
set -euo pipefail

KEEP=20
ROOT="cordel/mobile-builds"

if [ -z "${R2_ENDPOINT:-}" ] || [ -z "${R2_BUCKET:-}" ] || [ -z "${AWS_ACCESS_KEY_ID:-}" ] || [ -z "${AWS_SECRET_ACCESS_KEY:-}" ]; then
  echo "::warning::No R2 settings in this environment; not publishing $BUILD_FILE to the Mobile builds page."
  exit 0
fi

if ! command -v aws >/dev/null 2>&1; then
  if [ "$(uname)" = "Darwin" ]; then brew install awscli >/dev/null; else echo "aws CLI not found" >&2; exit 1; fi
fi

# R2 rejects the extra checksums newer AWS CLIs add by default.
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required
export AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
export AWS_DEFAULT_REGION=auto

PREFIX="$ROOT/$APP_ID/$BUILD_PLATFORM"
KEY="$PREFIX/$BUILD_FILE"
SIDECAR="$BUILD_FILE.json"

node -e '
const fs = require("fs");
const crypto = require("crypto");
const e = process.env;
const sidecar = {
  app_id: e.APP_ID,
  app_name: e.APP_NAME,
  environment: e.ENV_NAME,
  platform: e.BUILD_PLATFORM,
  version: e.VERSION,
  build_number: Number(e.BUILD_NUMBER),
  git_sha: e.GIT_SHA,
  built_at: new Date().toISOString(),
  file: e.BUILD_FILE,
  sha256: crypto.createHash("sha256").update(fs.readFileSync(e.BUILD_FILE)).digest("hex"),
  run_url: e.RUN_URL,
};
if (e.SIGNER_SHA1) sidecar.signer_sha1 = e.SIGNER_SHA1;
fs.writeFileSync(e.BUILD_FILE + ".json", JSON.stringify(sidecar, null, 2));
'

case "$BUILD_FILE" in
  *.apk) TYPE="application/vnd.android.package-archive" ;;
  *.zip) TYPE="application/zip" ;;
  *) TYPE="application/octet-stream" ;;
esac

# The file first, the sidecar last: the page lists a build by its sidecar, so a build
# is never listed before its file is there.
aws s3 cp "$BUILD_FILE" "s3://$R2_BUCKET/$KEY" --endpoint-url "$R2_ENDPOINT" --content-type "$TYPE" --only-show-errors
aws s3 cp "$SIDECAR" "s3://$R2_BUCKET/$KEY.json" --endpoint-url "$R2_ENDPOINT" --content-type "application/json" --only-show-errors
echo "Published $KEY"

# Retention: keep the newest $KEEP builds of this app and platform, remove the rest
# (each build is its file and its sidecar).
aws s3api list-objects-v2 --endpoint-url "$R2_ENDPOINT" --bucket "$R2_BUCKET" --prefix "$PREFIX/" --output json |
  KEEP="$KEEP" node -e '
    let raw = "";
    process.stdin.on("data", (c) => (raw += c)).on("end", () => {
      const listing = raw.trim() ? JSON.parse(raw) : {};
      const sidecars = (listing.Contents || [])
        .filter((o) => o.Key.endsWith(".json"))
        .sort((a, b) => (a.LastModified < b.LastModified ? 1 : a.LastModified > b.LastModified ? -1 : 0));
      for (const old of sidecars.slice(Number(process.env.KEEP))) {
        console.log(old.Key);
        console.log(old.Key.slice(0, -".json".length));
      }
    });
  ' |
  while read -r stale; do
    echo "Pruning $stale"
    aws s3 rm "s3://$R2_BUCKET/$stale" --endpoint-url "$R2_ENDPOINT" --only-show-errors
  done
