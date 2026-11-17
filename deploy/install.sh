#!/usr/bin/env bash
# Installs or updates the dashboard on a Debian host. Run as root from /opt/dashboard:
#
#   sudo /opt/dashboard/deploy/install.sh [--no-firewall] [--allow-audit] [--yes] [--rebuild]
#
#   --no-firewall  do not touch ufw
#   --allow-audit  continue when 'pnpm audit' reports high-severity findings
#   --yes          do not ask for confirmations (firewall LAN subnet); without a terminal the
#                  first-admin step is skipped and its command printed
#   --rebuild      rebuild even if the checked-out commit is already deployed
#
# Idempotent: a second run on an unchanged checkout changes nothing.
# Test seams: DASH_ROOT=<prefix> redirects file paths, DASH_DRY_RUN=1 prints mutating commands.
set -euo pipefail
umask 022

DEPLOY_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(dirname -- "$DEPLOY_DIR")"

# shellcheck source=lib/common.sh
. "$DEPLOY_DIR/lib/common.sh"
for f in net checks packages node users-dirs secret build backup migrate services health admin; do
  # shellcheck source=/dev/null
  . "$DEPLOY_DIR/lib/$f.sh"
done

NO_FIREWALL=0
ALLOW_AUDIT=0
ASSUME_YES=0
REBUILD=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-firewall) NO_FIREWALL=1 ;;
    --allow-audit) ALLOW_AUDIT=1 ;;
    --yes) ASSUME_YES=1 ;;
    --rebuild) REBUILD=1 ;;
    -h | --help)
      sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
  shift
done

APP_DIR="$(rp "$APP_DIR_ABS")"
BUILT=0
UNITS_CHANGED=0
CADDY_CHANGED=0
FIREWALL_FAILED=0
ADMIN_SKIPPED=0
ROLLBACK_ARMED=0
BACKUP_FILE=""
BACKUP_OTHERS=""
PRE_REV=""

on_exit() {
  local rc=$?
  trap - EXIT
  cleanup_tmp
  if [ "$rc" -ne 0 ] && [ "$ROLLBACK_ARMED" = 1 ]; then
    print_rollback
  fi
  exit "$rc"
}
trap on_exit EXIT

# The scripts must come from the checkout that is deployed.
if [ ! -d "$APP_DIR" ] || [ "$(cd -- "$APP_DIR" && pwd -P)" != "$REPO_ROOT" ]; then
  die "run this script from the checkout at $APP_DIR_ABS:  git clone <repo> $APP_DIR_ABS && sudo $APP_DIR_ABS/deploy/install.sh"
fi

# 1. checks (and what is deployed right now, before anything changes)
run_checks
capture_previous_state

# 2-5. packages, node, user and directories, secrets
install_packages
install_node
ensure_user
ensure_dirs
ensure_secret
ensure_env_file

# 6-9. build only when the checkout changed (or --rebuild), back up before the service restarts
NEED_BUILD=0
if [ "$REBUILD" = 1 ] || [ "$HEAD_REV" != "$PRE_REV" ] || ! build_outputs_present; then
  NEED_BUILD=1
fi
if [ "$NEED_BUILD" = 1 ]; then
  build_app
  record_and_backup
  ROLLBACK_ARMED=1
  run_migrations
else
  log "revision $HEAD_REV already deployed; skipping build and backup"
fi

# 10. units, caddy, tailscale permission, ssh, firewall
install_units
ensure_tailscale_cert_permission
install_caddy
install_ssh_dropin
install_firewall

# 11. restart what changed, then the health check
if [ "$BUILT" = 1 ] || [ "$UNITS_CHANGED" = 1 ] || ! systemctl is-active --quiet dashboard.service 2>/dev/null; then
  log "starting dashboard.service"
  run systemctl restart dashboard.service
fi
if [ "$CADDY_CHANGED" = 1 ] || ! systemctl is-active --quiet caddy.service 2>/dev/null; then
  log "restarting caddy.service"
  run systemctl restart caddy.service
fi
wait_for_health
record_deployed
if [ "$ROLLBACK_ARMED" = 1 ]; then
  mark_backups_done
  ROLLBACK_ARMED=0
fi

# 12. first admin (offered when the users table has no enabled admin)
create_first_admin

# 13. summary
cat <<SUMMARY

Dashboard is running.
  URL:        https://$TS_HOSTNAME
  Revision:   $HEAD_REV
  Logs:       journalctl -u dashboard.service -f
  Config:     $CONF_DIR_ABS/env   (kept across updates)
SUMMARY
if [ -n "$BACKUP_FILE" ]; then
  echo "  Backup:     $BACKUP_FILE"
fi
if [ "$ADMIN_SKIPPED" = 1 ]; then
  echo "  No admin user exists (or it could not be checked). Create one with:"
  admin_command_hint
fi
if [ "$FIREWALL_FAILED" = 1 ]; then
  echo "  Firewall NOT enabled; see the warning above."
fi
if [ "$NO_FIREWALL" = 1 ]; then
  echo "  Firewall skipped (--no-firewall)."
fi
