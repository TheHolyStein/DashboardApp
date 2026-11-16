#!/usr/bin/env bats
# Caddyfile rendering, firewall dry-run and SSH drop-in checks (container, root).

bats_require_minimum_version 1.5.0

DEPLOY="$(cd "$BATS_TEST_DIRNAME/.." && pwd -P)"

render() {
  # shellcheck source=/dev/null
  . "$DEPLOY/lib/common.sh"
  # shellcheck source=/dev/null
  . "$DEPLOY/lib/services.sh"
  TS_HOSTNAME=futro.tail1234.ts.net TS_BIND_ADDR=100.64.1.2 DASH_PORT=8787 \
    render_template "$DEPLOY/caddy/Caddyfile.tmpl" "$1"
}

@test "caddy validate passes on the rendered template" {
  mkdir -p /etc/caddy/dashboard-apps
  render "$BATS_TEST_TMPDIR/Caddyfile"
  run caddy validate --config "$BATS_TEST_TMPDIR/Caddyfile" --adapter caddyfile
  [ "$status" -eq 0 ]
}

@test "rendered Caddyfile has no leftover placeholders and the required directives" {
  render "$BATS_TEST_TMPDIR/Caddyfile"
  f="$BATS_TEST_TMPDIR/Caddyfile"
  ! grep -F '${' "$f"
  grep -q '^futro.tail1234.ts.net {$' "$f"
  grep -q 'bind 100.64.1.2' "$f"
  grep -q 'reverse_proxy 127.0.0.1:8787' "$f"
  grep -q 'flush_interval -1' "$f"
  grep -q 'max_size 25MB' "$f"
  grep -q 'Strict-Transport-Security' "$f"
  grep -q 'redir /.well-known/caldav /dav/ permanent' "$f"
  grep -q 'admin off' "$f"
  grep -q 'header_up X-Forwarded-For {remote_host}' "$f"
  grep -q 'import /etc/caddy/dashboard-apps/\*.caddy' "$f"
}

@test "ufw.sh --dry-run prints exactly the expected rule list" {
  run --separate-stderr bash "$DEPLOY/ufw.sh" --dry-run --lan 192.168.1.37/24
  [ "$status" -eq 0 ]
  expected='ufw default deny incoming
ufw default allow outgoing
ufw allow in on tailscale0 to any port 443 proto tcp
ufw allow in on tailscale0 to any port 22 proto tcp
ufw allow in from 192.168.1.0/24 to any port 22 proto tcp
ufw allow out to 224.0.0.251 port 5353 proto udp
ufw --force enable'
  [ "$output" = "$expected" ]
}

@test "ufw.sh refuses to enable when the SSH session would be cut off" {
  SSH_CONNECTION="203.0.113.9 50000 192.168.1.2 22" run bash "$DEPLOY/ufw.sh" --yes --lan 192.168.1.0/24
  [ "$status" -eq 1 ]
  [[ "$output" == *"Refusing"* ]]
}

@test "ufw.sh refuses when an SSH session exists but its source cannot be determined" {
  run env -u SSH_CONNECTION -u SSH_CLIENT SSH_TTY=/dev/pts/9 bash "$DEPLOY/ufw.sh" --yes --lan 192.168.1.0/24
  [ "$status" -eq 1 ]
  [[ "$output" == *"could not be determined"* ]]
}

@test "the event stream is excluded from compression" {
  render "$BATS_TEST_TMPDIR/Caddyfile"
  grep -q '@compressible not path /api/stream' "$BATS_TEST_TMPDIR/Caddyfile"
  grep -q 'encode @compressible zstd gzip' "$BATS_TEST_TMPDIR/Caddyfile"
}

@test "ip_in_cidr and cidr_network behave" {
  # shellcheck source=/dev/null
  . "$DEPLOY/lib/net.sh"
  ip_in_cidr 192.168.1.50 192.168.1.0/24
  ! ip_in_cidr 192.168.2.50 192.168.1.0/24
  ip_in_cidr 100.100.5.5 100.64.0.0/10
  ! ip_in_cidr 100.128.0.1 100.64.0.0/10
  [ "$(cidr_network 10.1.2.3/16)" = "10.1.0.0/16" ]
}

@test "sshd -t accepts the drop-in" {
  d="$BATS_TEST_TMPDIR/ssh"
  mkdir -p "$d/sshd_config.d" /run/sshd
  cp "$DEPLOY/ssh/60-dashboard.conf" "$d/sshd_config.d/"
  ssh-keygen -q -t ed25519 -N '' -f "$d/hostkey"
  printf 'Include %s/sshd_config.d/*.conf\nHostKey %s/hostkey\n' "$d" "$d" >"$d/sshd_config"
  run sshd -t -f "$d/sshd_config"
  [ "$status" -eq 0 ]
  run sshd -T -f "$d/sshd_config"
  [[ "$output" == *"passwordauthentication no"* ]]
  [[ "$output" == *"permitrootlogin no"* ]]
  [[ "$output" == *"kbdinteractiveauthentication no"* ]]
}
