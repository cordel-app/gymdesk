#!/usr/bin/env bash
# Installs or repairs the GitHub Actions self-hosted runner on a VPS (#2042/#2043).
#
# Run as the unprivileged user `podman` (the user that owns the Quadlet units).
# No sudo: the runner is a *user* systemd unit and `loginctl enable-linger`
# (allowed for one's own user) keeps it alive across logouts and reboots.
#
# Required environment:
#   RUNNER_HOST   corfront | corback            (becomes a label)
#   RUNNER_ENV    dev | pro                     (becomes a label)
# Needed only to (re-)register — a new runner, or one whose registration is gone:
#   RUNNER_TOKEN  registration token from Settings -> Actions -> Runners -> New
#                 runner (valid 1 hour). Read from the environment, never stored
#                 and never printed.
# Optional:
#   RUNNER_REPO_URL   default https://github.com/cordel-app/gymdesk
#   RUNNER_VERSION    default: latest release (e.g. 2.329.0)
#
# Idempotent: re-running updates the runner binary when the version differs,
# rewrites the unit and restarts it; it never creates a second runner.
set -euo pipefail

: "${RUNNER_HOST:?RUNNER_HOST must be corfront or corback}"
: "${RUNNER_ENV:?RUNNER_ENV must be dev or pro}"
case "$RUNNER_HOST" in corfront|corback) ;; *) echo "RUNNER_HOST must be corfront or corback" >&2; exit 1;; esac
case "$RUNNER_ENV" in dev|pro) ;; *) echo "RUNNER_ENV must be dev or pro" >&2; exit 1;; esac

REPO_URL="${RUNNER_REPO_URL:-https://github.com/cordel-app/gymdesk}"
DIR="$HOME/actions-runner"
UNIT_DIR="$HOME/.config/systemd/user"
NAME="${RUNNER_HOST}-${RUNNER_ENV}"

if [ "$(id -u)" -eq 0 ]; then echo "Run as the 'podman' user, not root." >&2; exit 1; fi
[ "$(uname -m)" = "aarch64" ] || { echo "This script installs the Linux arm64 runner; got $(uname -m)." >&2; exit 1; }

VERSION="${RUNNER_VERSION:-}"
if [ -z "$VERSION" ]; then
  VERSION="$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest \
    | sed -n 's/.*"tag_name": *"v\([^"]*\)".*/\1/p' | head -1)"
fi
[ -n "$VERSION" ] || { echo "Could not determine the runner version." >&2; exit 1; }

mkdir -p "$DIR" "$UNIT_DIR"
cd "$DIR"

INSTALLED=""
[ -f .version ] && INSTALLED="$(cat .version)"
if [ "$INSTALLED" != "$VERSION" ]; then
  echo "Installing runner $VERSION (was: ${INSTALLED:-none})"
  TARBALL="actions-runner-linux-arm64-${VERSION}.tar.gz"
  curl -fsSL -o "$TARBALL" "https://github.com/actions/runner/releases/download/v${VERSION}/${TARBALL}"
  # The release notes publish the SHA-256 of each tarball.
  EXPECTED="$(curl -fsSL "https://api.github.com/repos/actions/runner/releases/tags/v${VERSION}" \
    | grep -o "actions-runner-linux-arm64-${VERSION}.tar.gz[^<]*<!-- *BEGIN SHA linux-arm64 *-->[0-9a-f]\{64\}" \
    | grep -o '[0-9a-f]\{64\}$' | head -1 || true)"
  if [ -n "$EXPECTED" ]; then
    echo "$EXPECTED  $TARBALL" | sha256sum -c -
  else
    echo "WARNING: no published SHA-256 found for $TARBALL; skipping verification" >&2
  fi
  systemctl --user stop actions-runner.service 2>/dev/null || true
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
    --labels "self-hosted,linux,ARM64,${RUNNER_HOST},${RUNNER_ENV}" \
    --work _work
else
  echo "Runner already registered (.runner exists); keeping its registration."
fi

cat > "$UNIT_DIR/actions-runner.service" <<UNIT
[Unit]
Description=GitHub Actions runner (${NAME})
Wants=network-online.target
After=network-online.target

[Service]
ExecStart=%h/actions-runner/run.sh
WorkingDirectory=%h/actions-runner
Restart=always
RestartSec=5
KillMode=process
KillSignal=SIGTERM
TimeoutStopSec=5min

[Install]
WantedBy=default.target
UNIT

loginctl enable-linger "$(id -un)"
systemctl --user daemon-reload
systemctl --user enable actions-runner.service
systemctl --user restart actions-runner.service
sleep 2
systemctl --user is-active actions-runner.service
echo "Runner ${NAME} is installed and running."
