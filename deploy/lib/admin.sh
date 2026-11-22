# shellcheck shell=bash
# Step 12: first admin. Source only.

admin_command_hint() {
  cat <<HINT
  sudo -u $APP_USER sh -c 'set -a; . $CONF_DIR_ABS/env; set +a; exec node $APP_DIR_ABS/apps/server/dist/cli.js user:create --name <NAME> --role admin'
HINT
}

# Runs the CLI as the service user with the env file loaded. The password travels only
# in the DASH_PASSWORD environment variable of this one process.
run_cli_as_service_user() {
  runuser -u "$APP_USER" -- sh -c 'set -a; . "$1"; set +a; shift; exec node "$@"' sh \
    "$(rp "$CONF_DIR_ABS/env")" "$APP_DIR/apps/server/dist/cli.js" "$@"
}

# present | absent | unknown: is there an enabled admin in the users table? Read-only, run as
# the service user so no root-owned -shm/-wal files appear next to the database.
admin_status() {
  local db n
  db="$(db_path)"
  if [ ! -f "$db" ] || ! command -v sqlite3 >/dev/null 2>&1; then
    echo unknown
    return 0
  fi
  if ! n="$(runuser -u "$APP_USER" -- sqlite3 -readonly "$db" "SELECT count(*) FROM users WHERE role='admin' AND disabled=0;" 2>/dev/null)"; then
    echo unknown
    return 0
  fi
  case "$n" in
    '' | *[!0-9]*) echo unknown ;;
    0) echo absent ;;
    *) echo present ;;
  esac
}

create_first_admin() {
  local name pw1 pw2 st
  if [ "$DASH_DRY_RUN" = 1 ]; then
    echo "+ (check for an admin user; prompt for the first admin if none)"
    return 0
  fi
  st="$(admin_status)"
  case "$st" in
    present) return 0 ;;
    unknown)
      ADMIN_SKIPPED=1
      log "could not check for an admin user; not guessing"
      return 0
      ;;
  esac
  if [ ! -t 0 ]; then
    ADMIN_SKIPPED=1
    log "no admin user yet and no terminal: skipping the prompt"
    return 0
  fi
  read -r -p "First admin name: " name
  [ -n "$name" ] || die "admin name must not be empty."
  read -r -s -p "Password: " pw1
  echo
  read -r -s -p "Repeat password: " pw2
  echo
  [ "$pw1" = "$pw2" ] || die "passwords do not match."
  [ -n "$pw1" ] || die "password must not be empty."
  DASH_PASSWORD="$pw1" run_cli_as_service_user user:create --name "$name" --role admin >/dev/null
  pw1="" pw2=""
  log "admin '$name' created"
}
