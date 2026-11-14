#!/usr/bin/env bats
# Runs install.sh against a fake root with stubbed externals. Needs root (useradd, chown).

load helpers

setup() { make_env; }

@test "fresh run creates user, dirs, key with correct modes" {
  run_install --yes --no-firewall
  [ "$status" -eq 0 ]
  id -u dashboard
  [ "$(mode_of "$ROOT/opt/dashboard")" = "755 root root" ]
  [ "$(mode_of "$ROOT/var/lib/dashboard")" = "750 dashboard dashboard" ]
  [ "$(mode_of "$ROOT/var/lib/dashboard/backups")" = "750 dashboard dashboard" ]
  [ "$(mode_of "$ROOT/etc/dashboard")" = "750 root dashboard" ]
  [ "$(mode_of "$ROOT/etc/dashboard/secret.key")" = "640 root dashboard" ]
  [ "$(stat -c %s "$ROOT/etc/dashboard/secret.key")" -eq 32 ]
  [ "$(mode_of "$ROOT/etc/dashboard/env")" = "640 root dashboard" ]
  grep -qx 'NODE_ENV=production' "$ROOT/etc/dashboard/env"
  grep -qx 'DASH_PORT=8787' "$ROOT/etc/dashboard/env"
  grep -qx 'DASH_BASE_URL=https://futro.tail1234.ts.net' "$ROOT/etc/dashboard/env"
  [ -f "$ROOT/etc/systemd/system/dashboard.service" ]
  grep -q 'futro.tail1234.ts.net {' "$ROOT/etc/caddy/Caddyfile"
  # the first-admin step is skipped without a terminal and prints the command
  [[ "$output" == *"user:create"* ]]
}

@test "second run changes nothing and exits 0" {
  run_install --yes --no-firewall
  [ "$status" -eq 0 ]
  before="$(snapshot)"
  : >"$CALLS"
  run_install --yes --no-firewall
  [ "$status" -eq 0 ]
  after="$(snapshot)"
  [ "$before" = "$after" ]
  # no rebuild and no service restart on an unchanged checkout
  ! grep -q '^pnpm build' "$CALLS"
  ! grep -q '^systemctl restart' "$CALLS"
}

@test "existing secret.key is not overwritten" {
  run_install --yes --no-firewall
  [ "$status" -eq 0 ]
  printf 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' >"$ROOT/etc/dashboard/secret.key"
  before="$(sha256sum "$ROOT/etc/dashboard/secret.key")"
  run_install --yes --no-firewall --rebuild
  [ "$status" -eq 0 ]
  [ "$before" = "$(sha256sum "$ROOT/etc/dashboard/secret.key")" ]
}

@test "non-Debian exits 1 with message" {
  printf 'ID=ubuntu\nVERSION_ID="24.04"\n' >"$ROOT/etc/os-release"
  run_install --yes --no-firewall
  [ "$status" -eq 1 ]
  [[ "$output" == *"Debian"* ]]
}

@test "failed health check exits non-zero and prints rollback command" {
  STUB_HEALTH_FAIL=1 run_install --yes --no-firewall
  [ "$status" -ne 0 ]
  [[ "$output" == *"Rollback commands"* ]]
  [[ "$output" == *"systemctl stop dashboard.service"* ]]
}
