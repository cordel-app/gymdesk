#!/usr/bin/env bash
# Installs a SECOND self-hosted runner on corfront, registered to the private repo
# cordel-app/cordel-web, next to the gymdesk one (which this script never touches).
#
# Its own directory (~/actions-runner-cordel-web) and its own user unit
# (actions-runner-cordel-web.service): nothing here stops, rewrites or restarts
# actions-runner.service, which is the gymdesk runner. Idempotent: re-running
# keeps an existing registration and only rewrites the unit.
#
# Required environment:
#   RUNNER_TOKEN  registration token of cordel-app/cordel-web (valid 1 hour),
#                 only to register a new runner. Read from the environment,
#                 never stored and never printed.
set -euo pipefail

REPO_URL="https://github.com/cordel-app/cordel-web"
NAME="corfront-dev-cordel-web"
DIR="$HOME/actions-runner-cordel-web"
UNIT="actions-runner-cordel-web.service"
UNIT_DIR="$HOME/.config/systemd/user"

if [ "$(id -u)" -eq 0 ]; then echo "Run as the 'podman' user, not root." >&2; exit 1; fi
[ "$(uname -m)" = "aarch64" ] || { echo "This installs the Linux arm64 runner; got $(uname -m)." >&2; exit 1; }

VERSION="$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest \
  | sed -n 's/.*"tag_name": *"v\([^"]*\)".*/\1/p' | head -1)"
[ -n "$VERSION" ] || { echo "Could not determine the runner version." >&2; exit 1; }

mkdir -p "$DIR" "$UNIT_DIR"
cd "$DIR"

if [ ! -f .version ] || [ "$(cat .version)" != "$VERSION" ]; then
  echo "Installing runner $VERSION into $DIR"
  TARBALL="actions-runner-linux-arm64-${VERSION}.tar.gz"
  curl -fsSL -o "$TARBALL" "https://github.com/actions/runner/releases/download/v${VERSION}/${TARBALL}"
  EXPECTED="$(curl -fsSL "https://api.github.com/repos/actions/runner/releases/tags/v${VERSION}" \
    | grep -o "actions-runner-linux-arm64-${VERSION}.tar.gz[^<]*<!-- *BEGIN SHA linux-arm64 *-->[0-9a-f]\{64\}" \
    | grep -o '[0-9a-f]\{64\}$' | head -1 || true)"
  if [ -n "$EXPECTED" ]; then
    echo "$EXPECTED  $TARBALL" | sha256sum -c -
  else
    echo "WARNING: no published SHA-256 found for $TARBALL; skipping verification" >&2
  fi
  systemctl --user stop "$UNIT" 2>/dev/null || true
  tar xzf "$TARBALL"
  rm -f "$TARBALL"
  echo "$VERSION" > .version
fi

if [ ! -f .runner ]; then
  : "${RUNNER_TOKEN:?RUNNER_TOKEN is required to register a new runner}"
  ./config.sh --unattended --replace \
    --url "$REPO_URL" \
    --token "$RUNNER_TOKEN" \
    --name "$NAME" \
    --labels "self-hosted,linux,ARM64,corfront,dev" \
    --work _work
else
  echo "Runner already registered (.runner exists); keeping its registration."
fi

cat > "$UNIT_DIR/$UNIT" <<UNITEOF
[Unit]
Description=GitHub Actions runner (${NAME})
Wants=network-online.target
After=network-online.target

[Service]
ExecStart=%h/actions-runner-cordel-web/run.sh
WorkingDirectory=%h/actions-runner-cordel-web
Restart=always
RestartSec=5
KillMode=process
KillSignal=SIGTERM
TimeoutStopSec=5min

[Install]
WantedBy=default.target
UNITEOF

systemctl --user daemon-reload
systemctl --user enable "$UNIT"
systemctl --user restart "$UNIT"
sleep 2
systemctl --user is-active "$UNIT"
echo "Runner ${NAME} is installed and running."
