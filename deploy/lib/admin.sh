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

create_first_admin() {
  local name pw1 pw2
  if [ "$FIRST_INSTALL" != 1 ]; then
    return 0
  fi
  if [ "$DASH_DRY_RUN" = 1 ]; then
    echo "+ (prompt for first admin)"
    return 0
  fi
  if [ ! -t 0 ]; then
    ADMIN_SKIPPED=1
    log "no terminal: skipping first admin. Create it later with:"
    admin_command_hint
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
