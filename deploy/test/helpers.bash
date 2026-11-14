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
  mkdir -p "$ROOT/etc" "$BIN" "$STATE" "$APP"
  : >"$CALLS"

  printf 'ID=debian\nVERSION_ID="13"\n' >"$ROOT/etc/os-release"

  cp -r "$DEPLOY_SRC" "$APP/deploy"
  printf '{\n  "name": "fixture",\n  "version": "1.2.3",\n  "packageManager": "pnpm@12.18.0"\n}\n' >"$APP/package.json"
  : >"$APP/pnpm-lock.yaml"
  git -C "$APP" init -q
  git -C "$APP" add -A
  git -C "$APP" -c user.name=t -c user.email=t@example.com commit -q -m fixture

  stub apt-get 'exit 0'
  stub dpkg-query 'printf "install ok installed"'
  stub node 'echo v24.1.0'
  stub corepack 'exit 0'
  stub caddy 'exit 0'
  stub ufw 'exit 0'
  stub runuser 'exit 0'
  stub tailscale 'case "$1" in ip) echo 100.64.1.2 ;; status) echo "{\"Self\": {\"DNSName\": \"futro.tail1234.ts.net.\"}}" ;; esac'
  stub curl '[ -z "${STUB_HEALTH_FAIL:-}" ]'
  stub pnpm "case \"\$1\" in
  --version) echo 12.18.0 ;;
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

run_install() {
  DASH_ROOT="$ROOT" PATH="$BIN:$PATH" \
    DASH_TS_HOSTNAME=futro.tail1234.ts.net DASH_TS_ADDR=100.64.1.2 \
    DASH_MIN_DISK_MB=1 DASH_MIN_RAM_MB=1 DASH_HEALTH_TIMEOUT=2 \
    run bash "$APP/deploy/install.sh" "$@" </dev/null
}

mode_of() { stat -c '%a %U %G' "$1"; }

snapshot() {
  find "$ROOT" -path "$APP/.git" -prune -o -printf '%p %y %m %u %g %s %T@\n' | sort
}
