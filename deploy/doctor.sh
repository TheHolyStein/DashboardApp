#!/usr/bin/env bash
# Health check for the dashboard host. Read-only; changes nothing.
#
#   sudo /opt/dashboard/deploy/doctor.sh [--json]
#
# Loads /etc/dashboard/env (KEY=value lines only; nothing is sourced or evaluated), then runs
# `node apps/server/dist/cli.js doctor` as the dashboard user when started as root.
# Exit code: 0 when no check is FAIL, 1 otherwise.
set -euo pipefail

APP_DIR=/opt/dashboard
ENV_FILE="${DASH_ENV_FILE:-/etc/dashboard/env}"
APP_USER=dashboard

if [ -r "$ENV_FILE" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    if [[ $line =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      key="${BASH_REMATCH[1]}"
      val="${BASH_REMATCH[2]}"
      # Strip one pair of surrounding quotes, as systemd does.
      if [[ $val =~ ^\"(.*)\"$ || $val =~ ^\'(.*)\'$ ]]; then val="${BASH_REMATCH[1]}"; fi
      export "$key=$val"
    fi
  done <"$ENV_FILE"
else
  echo "doctor.sh: cannot read $ENV_FILE (run with sudo?)" >&2
fi

cli=("$APP_DIR/apps/server/dist/cli.js" doctor "$@")

if [ "$(id -u)" -eq 0 ]; then
  # Root can read the firewall state; the service user cannot. Hand the text over.
  if command -v ufw >/dev/null 2>&1; then
    ufw_text="$(ufw status 2>/dev/null || true)"
    if [ -n "$ufw_text" ]; then
      export DASH_DOCTOR_UFW_STATUS="$ufw_text"
    fi
  fi
  # The database is opened as the service user so that no root-owned -shm/-wal file appears.
  exec runuser -u "$APP_USER" -- node "${cli[@]}"
fi
exec node "${cli[@]}"
