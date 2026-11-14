#!/usr/bin/env bats
# systemd unit checks. Run as root in the test container; creates the paths the units reference.

UNITS_DIR="$(cd "$BATS_TEST_DIRNAME/../systemd" && pwd -P)"

setup_file() {
  id -u dashboard >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin dashboard
  mkdir -p /opt/dashboard/deploy/netscan /etc/dashboard /var/lib/dashboard
  : >/etc/dashboard/env
  printf '#!/bin/sh\nexit 0\n' >/opt/dashboard/deploy/netscan/dashboard-netscan
  chmod +x /opt/dashboard/deploy/netscan/dashboard-netscan
  [ -x /usr/bin/node ] || { ln -s /bin/true /usr/bin/node && touch /tmp/.node-stub-created; }
}

teardown_file() {
  [ ! -e /tmp/.node-stub-created ] || { rm -f /usr/bin/node /tmp/.node-stub-created; }
}

@test "systemd-analyze verify passes for each unit" {
  # All three at once: the service and socket reference each other.
  run systemd-analyze verify "$UNITS_DIR/dashboard.service" "$UNITS_DIR/dashboard-netscan.service" "$UNITS_DIR/dashboard-netscan.socket"
  echo "$output"
  [ "$status" -eq 0 ]
}

@test "dashboard.service has the required directives" {
  f="$UNITS_DIR/dashboard.service"
  for d in User=dashboard WorkingDirectory=/opt/dashboard EnvironmentFile=/etc/dashboard/env \
    ExecStart='/usr/bin/node apps/server/dist/main.js' Restart=on-failure RestartSec=3 \
    MemoryMax=400M MemoryHigh=300M NoNewPrivileges=yes ProtectSystem=strict \
    ReadWritePaths=/var/lib/dashboard ReadOnlyPaths=/etc/dashboard ProtectHome=yes PrivateTmp=yes \
    PrivateDevices=yes ProtectKernelTunables=yes ProtectControlGroups=yes \
    'RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX' RestrictNamespaces=yes LockPersonality=yes \
    'CapabilityBoundingSet=' 'SystemCallFilter=@system-service' UMask=0027 \
    After=network-online.target Wants=network-online.target ProtectProc=invisible ProtectClock=yes \
    ProtectHostname=yes ProtectKernelModules=yes ProtectKernelLogs=yes RestrictRealtime=yes \
    RestrictSUIDSGID=yes SystemCallArchitectures=native; do
    grep -qxF -- "$d" "$f" || { echo "missing: $d"; return 1; }
  done
}

@test "dashboard.service does not set the forbidden directives" {
  f="$UNITS_DIR/dashboard.service"
  ! grep -E '^(MemoryDenyWriteExecute|IPAddressDeny|IPAddressAllow|StateDirectory)=' "$f"
}

@test "netscan socket and service are restricted and inert until the helper exists" {
  s="$UNITS_DIR/dashboard-netscan.socket"
  v="$UNITS_DIR/dashboard-netscan.service"
  grep -qxF 'ListenStream=/run/dashboard/netscan.sock' "$s"
  grep -qxF 'SocketGroup=dashboard' "$s"
  grep -qxF 'SocketMode=0660' "$s"
  grep -qxF 'ConditionPathExists=/opt/dashboard/deploy/netscan/dashboard-netscan' "$s"
  grep -qxF 'ConditionPathExists=/opt/dashboard/deploy/netscan/dashboard-netscan' "$v"
  grep -qxF 'ExecStart=/opt/dashboard/deploy/netscan/dashboard-netscan' "$v"
  grep -qxF 'CapabilityBoundingSet=CAP_NET_RAW' "$v"
  grep -qxF 'AmbientCapabilities=CAP_NET_RAW' "$v"
  grep -q '^RestrictAddressFamilies=.*AF_PACKET' "$v"
}
