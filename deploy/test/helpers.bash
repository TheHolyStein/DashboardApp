# Shared bats helpers. Tests run as root inside the container defined by deploy/test/Dockerfile.

DEPLOY_SRC="$(cd "$BATS_TEST_DIRNAME/.." && pwd -P)"

# stub <name> <sh body>: an executable in $BIN that logs its call and runs the body.
stub() {
  local name="$1" body="$2"
  {
    echo '#!/bin/sh'
    echo "echo \"$name \$*\" >>\"$CALLS\""
    echo "$body"
  } >"$BIN/$name"
  chmod +x "$BIN/$name"
}

# A fake system root with a fixture checkout at $ROOT/opt/dashboard and stubbed externals.
make_env() {
  ROOT="$BATS_TEST_TMPDIR/root"
  BIN="$BATS_TEST_TMPDIR/bin"
  STATE="$BATS_TEST_TMPDIR/state"
  CALLS="$BATS_TEST_TMPDIR/calls.log"
  APP="$ROOT/opt/dashboard"
  DATA="$ROOT/var/lib/dashboard"
  mkdir -p "$ROOT/etc" "$BIN" "$STATE" "$APP"
  : >"$CALLS"

  printf 'ID=debian\nVERSION_ID="13"\n' >"$ROOT/etc/os-release"

  cp -r "$DEPLOY_SRC" "$APP/deploy"
  printf '{\n  "name": "fixture",\n  "version": "1.2.3",\n  "packageManager": "pnpm@12.18.0"\n}\n' >"$APP/package.json"
  # better-sqlite3 and sharp are in the lockfile, @node-rs/argon2 is not, esbuild is not allow-listed
  printf "packages:\n  better-sqlite3@12.0.0:\n  sharp@0.34.0:\n  esbuild@0.28.0:\n" >"$APP/pnpm-lock.yaml"
  git -C "$APP" init -q
  git -C "$APP" add -A
  git -C "$APP" -c user.name=t -c user.email=t@example.com commit -q -m fixture

  stub apt-get 'exit 0'
  stub dpkg-query 'printf "install ok installed"'
  stub node 'echo v24.1.0'
  stub corepack 'exit 0'
  stub caddy 'exit 0'
  stub ufw 'exit 0'
  stub sshd 'exit 0'
  # runs the command after "-u <user> --" as the current user
  stub runuser 'shift 3; exec "$@"'
  stub getent 'case "$1" in
  group) echo "sudo:x:27:alice" ;;
  passwd) echo "alice:x:1000:1000::/home/alice:/bin/bash" ;;
esac'
  local sq
  sq=$(
    cat <<'EOS'
if [ "$1" = -readonly ]; then
  echo "${STUB_ADMIN_COUNT:-0}"
else
  f="${2#.backup \'}"
  f="${f%\'}"
  cp "$1" "$f"
fi
EOS
  )
  stub sqlite3 "$sq"
  stub tailscale 'case "$1" in ip) echo 100.64.1.2 ;; status) echo "{\"Self\": {\"DNSName\": \"futro.tail1234.ts.net.\"}}" ;; esac'
  stub curl '[ -z "${STUB_HEALTH_FAIL:-}" ]'
  stub pnpm "case \"\$1\" in
  --version) echo 12.18.0 ;;
  audit) [ -z \"\${STUB_AUDIT_FAIL:-}\" ] ;;
  build) mkdir -p apps/server/dist apps/web/dist; : >apps/server/dist/main.js; : >apps/web/dist/index.html ;;
esac"
  stub systemctl "unit=\"\"; for a; do unit=\"\$a\"; done
case \"\$1\" in
  is-active) [ -e \"$STATE/active-\$unit\" ] ;;
  is-enabled) [ -e \"$STATE/enabled-\$unit\" ] ;;
  restart|start) touch \"$STATE/active-\$unit\" ;;
  enable) touch \"$STATE/enabled-\$unit\" ;;
esac"
}

# run_install [flags]: the SSH_* variables are removed so a CI run over ssh cannot interfere.
run_install() {
  DASH_ROOT="$ROOT" PATH="$BIN:$PATH" \
    DASH_TS_HOSTNAME=futro.tail1234.ts.net DASH_TS_ADDR=100.64.1.2 \
    DASH_MIN_DISK_MB=1 DASH_MIN_RAM_MB=1 DASH_HEALTH_TIMEOUT=2 \
    run env -u SSH_CONNECTION -u SSH_CLIENT -u SSH_TTY -u SSH_AUTH_SOCK \
    bash "$APP/deploy/install.sh" "$@" </dev/null
}

# new_commit: a new revision in the fixture checkout (an "update").
new_commit() {
  echo "$RANDOM$RANDOM" >>"$APP/change.txt"
  git -C "$APP" add -A
  git -C "$APP" -c user.name=t -c user.email=t@example.com commit -q -m change
}

mode_of() { stat -c '%a %U %G' "$1"; }

snapshot() {
  find "$ROOT" -path "$APP/.git" -prune -o -printf '%p %y %m %u %g %s %T@\n' | sort
}
