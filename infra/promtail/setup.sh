#!/usr/bin/env bash
# Run on each VPS (corback / corfront) as root.
# Usage: HOSTNAME=corback bash setup.sh
# The $HOSTNAME variable determines which config file is installed.
set -euo pipefail

HOSTNAME="${HOSTNAME:-$(hostname)}"
PROMTAIL_VERSION="3.4.2"
ARCH="arm64"   # Oracle Ampere = aarch64
INSTALL_DIR="/usr/local/bin"
CONFIG_DIR="/etc/promtail"

echo "==> Installing promtail $PROMTAIL_VERSION on $HOSTNAME"

# 1. Download promtail binary
TMP=$(mktemp -d)
curl -fsSL \
  "https://github.com/grafana/loki/releases/download/v${PROMTAIL_VERSION}/promtail-linux-${ARCH}.zip" \
  -o "$TMP/promtail.zip"
unzip -q "$TMP/promtail.zip" -d "$TMP"
install -m 755 "$TMP/promtail-linux-${ARCH}" "$INSTALL_DIR/promtail"
rm -rf "$TMP"
echo "  promtail binary installed at $INSTALL_DIR/promtail"

# 2. Create dedicated system user
if ! id promtail &>/dev/null; then
  useradd --system --no-create-home --shell /sbin/nologin promtail
  # Allow promtail to read journald logs
  usermod -aG systemd-journal promtail
  echo "  promtail user created"
fi

# 3. Install config
mkdir -p "$CONFIG_DIR"
cp "config-${HOSTNAME}.yml" "$CONFIG_DIR/config.yml"
chown root:promtail "$CONFIG_DIR/config.yml"
chmod 640 "$CONFIG_DIR/config.yml"
echo "  config installed at $CONFIG_DIR/config.yml"

# 4. Secrets file (one-time manual step — do NOT commit)
if [[ ! -f "$CONFIG_DIR/secrets" ]]; then
  echo "==> Create $CONFIG_DIR/secrets with this content:"
  echo "    GRAFANA_CLOUD_API_KEY=<your-grafana-api-token>"
  echo "    (chmod 600 $CONFIG_DIR/secrets)"
  echo ""
  echo "    Then re-run this script, or run: systemctl enable --now promtail"
fi

# 5. Install and enable systemd unit
cp promtail.service /etc/systemd/system/promtail.service
systemctl daemon-reload
systemctl enable promtail

if [[ -f "$CONFIG_DIR/secrets" ]]; then
  systemctl restart promtail
  echo "==> promtail started. Check status: systemctl status promtail"
  echo "    Tail logs: journalctl -u promtail -f"
else
  echo "==> promtail NOT started — create $CONFIG_DIR/secrets first, then:"
  echo "    systemctl start promtail"
fi
