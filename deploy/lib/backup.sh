# shellcheck shell=bash
# Step 8 and rollback support. Source only.

DB_FILE_NAME=dashboard.sqlite

db_path() { rp "$DATA_DIR_ABS/$DB_FILE_NAME"; }

# Capture what is currently deployed, before anything changes. deployed.rev is written only
# after a fully successful install, so after a `git pull` it still names the previous version.
capture_previous_state() {
  local deployed
  deployed="$(rp "$DATA_DIR_ABS/deployed.rev")"
  PRE_REV=""
  if [ -f "$deployed" ]; then
    PRE_REV="$(head -n 1 "$deployed")"
  fi
  HEAD_REV="$(git -C "$APP_DIR" rev-parse HEAD)"
  PRE_VERSION="$(package_version "$APP_DIR")"
  [ -n "$PRE_VERSION" ] || PRE_VERSION=unknown
  STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
  if [ -f "$(db_path)" ]; then DB_EXISTED=1; else DB_EXISTED=0; fi
}

# Needs the backups directory (step 4).
record_and_backup() {
  local base
  base="$(rp "$DATA_DIR_ABS/backups")/pre-$PRE_VERSION-$STAMP"
  BACKUP_FILE=""
  REV_FILE="$base.rev"
  if [ "$DASH_DRY_RUN" = 1 ]; then
    echo "+ (record ${PRE_REV:-$HEAD_REV} in $REV_FILE)"
  else
    printf '%s\n' "${PRE_REV:-$HEAD_REV}" >"$REV_FILE"
    chown "$APP_USER:$APP_USER" "$REV_FILE"
    chmod 0640 "$REV_FILE"
  fi
  if [ "$DB_EXISTED" = 1 ]; then
    BACKUP_FILE="$base.sqlite"
    log "backing up database to $BACKUP_FILE"
    # .backup is consistent even while the service has the database open.
    run runuser -u "$APP_USER" -- sqlite3 "$(db_path)" ".backup '$BACKUP_FILE'"
  fi
}

record_deployed() {
  local f
  f="$(rp "$DATA_DIR_ABS/deployed.rev")"
  if [ "$DASH_DRY_RUN" = 1 ]; then
    echo "+ (record $HEAD_REV in $f)"
    return 0
  fi
  if [ ! -f "$f" ] || [ "$(head -n 1 "$f")" != "$HEAD_REV" ]; then
    printf '%s\n' "$HEAD_REV" >"$f"
    chown "root:$APP_USER" "$f"
    chmod 0640 "$f"
  fi
}

print_rollback() {
  {
    echo
    echo "Install failed after the backup step. Rollback commands:"
    echo "  systemctl stop dashboard.service"
    if [ -n "${BACKUP_FILE:-}" ]; then
      echo "  rm -f '$(db_path)' '$(db_path)-wal' '$(db_path)-shm'"
      echo "  install -m 0640 -o $APP_USER -g $APP_USER '$BACKUP_FILE' '$(db_path)'"
    fi
    if [ -n "${PRE_REV:-}" ]; then
      echo "  git -C '$APP_DIR' checkout --detach $PRE_REV"
      echo "  '$APP_DIR/deploy/install.sh' --yes --no-firewall --allow-audit --rebuild"
    else
      echo "  systemctl disable dashboard.service   # first install: no earlier version to restore"
    fi
  } >&2
}
