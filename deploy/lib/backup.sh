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

# Backups older than this are never re-used for a new attempt (seconds).
BACKUP_REUSE_MAX_AGE=86400

# Needs the backups directory (step 4). A pre-update backup is re-used only while the SAME
# update attempt is retried: a failed attempt may already have migrated the live database, so
# a retry must not replace the pre-migration copy. Backups for this source revision are
# listed oldest first (by the stamp in the name); the oldest one younger than 24 hours is
# re-used. Older ones (an abandoned attempt followed by days on the old version) are kept
# but never re-used, and a fresh backup is taken. When an install finishes successfully,
# mark_backups_done renames <name>.sqlite to <name>.done.sqlite (and .rev likewise). The
# ending stays .sqlite on purpose: doctor ("Last backup") only counts files ending in
# .sqlite, so a finished update's backup keeps counting. The next update from the same
# revision then starts with a fresh backup. Sets BACKUP_FILE (the pre-migration state of this attempt)
# and BACKUP_OTHERS (other backups of the same revision, space separated, for the rollback text).
record_and_backup() {
  local dir tag base f stamp now mtime reuse="" line
  local -a found=()
  dir="$(rp "$DATA_DIR_ABS/backups")"
  BACKUP_FILE=""
  BACKUP_OTHERS=""
  if [ -z "$PRE_REV" ]; then
    log "no earlier revision recorded (first install): no backup taken"
    return 0
  fi
  tag="${PRE_REV:0:12}"
  now="$(date +%s)"
  for f in "$dir"/pre-*-"$tag"-*.rev; do
    [ -e "$f" ] || continue
    case "$f" in *.done.rev) continue ;; esac
    base="${f%.rev}"
    stamp="${base##*-}"
    found+=("$stamp $base")
  done
  if [ "${#found[@]}" -gt 0 ]; then
    while read -r stamp base; do
      mtime="$(stat -c %Y "$base.rev" 2>/dev/null || echo 0)"
      if [ -z "$reuse" ] && [ $((now - mtime)) -lt "$BACKUP_REUSE_MAX_AGE" ]; then
        reuse="$base"
      elif [ -e "$base.sqlite" ]; then
        BACKUP_OTHERS="${BACKUP_OTHERS:+$BACKUP_OTHERS }$base.sqlite"
      fi
    done < <(printf '%s\n' "${found[@]}" | sort)
  fi
  if [ -n "$reuse" ]; then
    if [ -e "$reuse.sqlite" ]; then
      BACKUP_FILE="$reuse.sqlite"
    fi
    log "re-using the backup of revision $tag from the first attempt: ${BACKUP_FILE:-none}"
    return 0
  fi
  if [ -n "$BACKUP_OTHERS" ]; then
    log "earlier backups of revision $tag are older than 24 hours (kept, not re-used); taking a fresh one"
  fi
  base="$dir/pre-$PRE_VERSION-$tag-$STAMP"
  REV_FILE="$base.rev"
  if [ "$DASH_DRY_RUN" = 1 ]; then
    echo "+ (record $PRE_REV in $REV_FILE)"
  else
    printf '%s\n' "$PRE_REV" >"$REV_FILE"
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

# After a fully successful install: the update from PRE_REV is finished, so its backups are
# kept but renamed *.done and never re-used by the next update from the same revision.
mark_backups_done() {
  local dir tag f ext
  [ -n "${PRE_REV:-}" ] || return 0
  dir="$(rp "$DATA_DIR_ABS/backups")"
  tag="${PRE_REV:0:12}"
  for f in "$dir"/pre-*-"$tag"-*.rev "$dir"/pre-*-"$tag"-*.sqlite; do
    [ -e "$f" ] || continue
    case "$f" in *.done.rev | *.done.sqlite) continue ;; esac
    ext="${f##*.}"
    log "update finished; keeping backup as ${f%."$ext"}.done.$ext"
    run mv -- "$f" "${f%."$ext"}.done.$ext"
  done
  if [ -n "${BACKUP_FILE:-}" ] && [ "$DASH_DRY_RUN" != 1 ]; then
    BACKUP_FILE="${BACKUP_FILE%.sqlite}.done.sqlite"
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

# The block is meant to be pasted line by line, so no line may close the shell (no `exit`).
# The destructive step is chained with && behind a check that the backup is a non-empty file,
# and the live database files are moved aside, never deleted.
print_rollback() {
  local db keep f
  db="$(db_path)"
  keep="$db.broken-${STAMP:-before-rollback}"
  {
    echo
    echo "Install failed after the backup step. Rollback commands (one line at a time, top to bottom):"
    echo "  systemctl stop dashboard.service"
    if [ -n "${BACKUP_FILE:-}" ]; then
      echo "  # database as it was before this update: $BACKUP_FILE"
      for f in ${BACKUP_OTHERS:-}; do
        echo "  # other backup of the same revision (not the pre-update state of this attempt): $f"
      done
      echo "  test -s '$BACKUP_FILE' && mv '$db' '$keep' && { mv '$db-wal' '$keep-wal' 2>/dev/null; mv '$db-shm' '$keep-shm' 2>/dev/null; install -m 0640 -o $APP_USER -g $APP_USER '$BACKUP_FILE' '$db'; } || echo 'backup missing or database not moved: do NOT continue'"
    fi
    if [ -n "${PRE_REV:-}" ]; then
      echo "  git -C '$APP_DIR' checkout --detach $PRE_REV"
      echo "  '$APP_DIR/deploy/install.sh' --yes --no-firewall --allow-audit --rebuild"
    else
      echo "  systemctl disable dashboard.service   # first install: no earlier version to restore"
    fi
  } >&2
}
