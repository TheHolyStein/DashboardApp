# shellcheck shell=bash
# Shared helpers for deploy/install.sh and deploy/ufw.sh. Source only; do not execute.
#
# Test seams:
#   DASH_ROOT     filesystem prefix for every path the scripts write (default: empty = real system)
#   DASH_DRY_RUN  1 = mutating commands are printed instead of run

DASH_ROOT="${DASH_ROOT:-}"
DASH_DRY_RUN="${DASH_DRY_RUN:-0}"

APP_USER=dashboard
APP_DIR_ABS=/opt/dashboard
DATA_DIR_ABS=/var/lib/dashboard
CONF_DIR_ABS=/etc/dashboard
DASH_PORT_VALUE=8787

# Set to 1 by any step that changed the system; steps decide on restarts with it.
CHANGED=0

rp() { printf '%s%s' "$DASH_ROOT" "$1"; }

log() { printf '==> %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

# Run a mutating command, or print it in dry-run mode.
run() {
  if [ "$DASH_DRY_RUN" = 1 ]; then
    printf '+'
    printf ' %q' "$@"
    printf '\n'
    return 0
  fi
  "$@"
}

TMP_DIR=""
make_tmp() {
  if [ -z "$TMP_DIR" ]; then
    TMP_DIR="$(mktemp -d)"
  fi
}
cleanup_tmp() {
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    rm -rf -- "$TMP_DIR"
  fi
}

# ensure_dir <path> <mode> <owner> <group>: create or fix; no-op when already right.
ensure_dir() {
  local path="$1" mode="$2" owner="$3" group="$4" cur
  if [ -d "$path" ]; then
    cur="$(stat -c '%a %U %G' "$path")"
    if [ "$cur" = "${mode#0} $owner $group" ]; then
      return 0
    fi
  fi
  log "directory $path ($mode $owner:$group)"
  run install -d -m "$mode" -o "$owner" -g "$group" "$path"
  CHANGED=1
}

# install_file <src> <dest> <mode> <owner> <group>: copy only when content or mode differs.
# Sets CHANGED and FILE_CHANGED=1 when it wrote.
FILE_CHANGED=0
install_file() {
  local src="$1" dest="$2" mode="$3" owner="$4" group="$5"
  FILE_CHANGED=0
  if [ -f "$dest" ] && cmp -s -- "$src" "$dest" &&
    [ "$(stat -c '%a %U %G' "$dest")" = "${mode#0} $owner $group" ]; then
    return 0
  fi
  log "install $dest"
  run install -D -m "$mode" -o "$owner" -g "$group" "$src" "$dest"
  CHANGED=1
  FILE_CHANGED=1
}

# Read the pnpm version from the root package.json "packageManager" field.
package_manager_version() {
  sed -n 's/.*"packageManager"[[:space:]]*:[[:space:]]*"pnpm@\([0-9][^"+]*\).*/\1/p' "$1/package.json" | head -n 1
}

package_version() {
  sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1/package.json" | head -n 1
}
