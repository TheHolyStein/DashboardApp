# shellcheck shell=bash
# Step 4: system user and directories. Source only.

ensure_user() {
  if id -u "$APP_USER" >/dev/null 2>&1; then
    return 0
  fi
  log "creating system user $APP_USER"
  run useradd --system --user-group --no-create-home --home-dir "$DATA_DIR_ABS" --shell /usr/sbin/nologin "$APP_USER"
  CHANGED=1
}

ensure_dirs() {
  ensure_dir "$APP_DIR" 0755 root root
  ensure_dir "$(rp "$DATA_DIR_ABS")" 0750 "$APP_USER" "$APP_USER"
  ensure_dir "$(rp "$DATA_DIR_ABS/backups")" 0750 "$APP_USER" "$APP_USER"
  ensure_dir "$(rp "$CONF_DIR_ABS")" 0750 root "$APP_USER"
  # Launcher snippets (plan 08) are imported by the Caddyfile; created empty here.
  ensure_dir "$(rp /etc/caddy/dashboard-apps)" 0755 root root
}
