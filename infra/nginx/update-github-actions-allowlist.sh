#!/usr/bin/env bash
# Refreshes the GitHub Actions IP allowlist used by nginx to guard /billing/ endpoints.
#
# Usage:
#   ./update-github-actions-allowlist.sh [output-file]
#
# Default output: ./github-actions-allowlist.conf
# On the server copy to: /etc/nginx/github-actions-allowlist.conf
#
# After copying, validate and reload nginx:
#   nginx -t && systemctl reload nginx

set -euo pipefail

OUT="${1:-$(dirname "$0")/github-actions-allowlist.conf}"
API="https://api.github.com/meta"
DATE=$(date -u +%Y-%m-%d)

echo "Fetching GitHub Actions IP ranges from $API ..."
RANGES=$(curl -fsSL "$API" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print('\n'.join(d['actions']))
")

COUNT=$(echo "$RANGES" | wc -l | tr -d ' ')
echo "Got $COUNT ranges."

{
  echo "# GitHub Actions IP allowlist — auto-generated from $API (.actions field)"
  echo "# $COUNT ranges as of $DATE"
  echo "#"
  echo "# Run infra/nginx/update-github-actions-allowlist.sh to refresh."
  echo ""
  echo "$RANGES" | while read -r range; do
    echo "allow $range;"
  done
  echo ""
  echo "deny all;"
} > "$OUT"

echo "Written to $OUT"
echo ""
echo "Next steps on the server:"
echo "  scp $OUT root@corback:/etc/nginx/github-actions-allowlist.conf"
echo "  nginx -t && systemctl reload nginx"
