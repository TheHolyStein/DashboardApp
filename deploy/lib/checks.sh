# shellcheck shell=bash
# Step 1: preconditions. Source only.

MIN_DISK_MB="${DASH_MIN_DISK_MB:-2048}"
MIN_RAM_MB="${DASH_MIN_RAM_MB:-1024}"

check_root() {
  [ "$(id -u)" -eq 0 ] || die "install.sh must run as root (use sudo)."
}

check_os() {
  local osr id="" ver=""
  osr="$(rp /etc/os-release)"
  if [ -r "$osr" ]; then
    id="$(sed -n 's/^ID=//p' "$osr" | tr -d '"' | head -n 1)"
    ver="$(sed -n 's/^VERSION_ID=//p' "$osr" | tr -d '"' | head -n 1)"
  fi
  if [ "$id" != debian ]; then
    die "this installer supports Debian stable only (found: ${id:-unknown})."
  fi
  case "$ver" in
    '' | *[!0-9]*) die "cannot read the Debian version (VERSION_ID='$ver'); Debian stable required." ;;
  esac
  [ "$ver" -ge 12 ] || die "Debian 12 or newer required (found $ver)."
}

check_arch() {
  local arch
  arch="$(dpkg --print-architecture)"
  case "$arch" in
    amd64 | arm64) ;;
    *) die "unsupported architecture '$arch' (amd64 or arm64 required)." ;;
  esac
}

check_disk() {
  local target avail_kb
  target="$(rp /)"
  [ -d "$target" ] || target=/
  avail_kb="$(df -Pk "$target" | awk 'NR == 2 {print $4}')"
  [ "$((avail_kb / 1024))" -ge "$MIN_DISK_MB" ] ||
    die "need at least ${MIN_DISK_MB} MB free disk, have $((avail_kb / 1024)) MB."
}

check_ram() {
  local mem_kb
  mem_kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)"
  if [ "$((mem_kb / 1024))" -lt "$MIN_RAM_MB" ]; then
    die "need at least ${MIN_RAM_MB} MB RAM, have $((mem_kb / 1024)) MB."
  fi
  if [ "$((mem_kb / 1024))" -lt 2000 ]; then
    warn "less than 2 GB RAM; the production build may need swap."
  fi
}

# Sets TS_HOSTNAME and TS_BIND_ADDR (override with DASH_TS_HOSTNAME / DASH_TS_ADDR).
detect_tailscale() {
  TS_HOSTNAME="${DASH_TS_HOSTNAME:-}"
  TS_BIND_ADDR="${DASH_TS_ADDR:-}"
  if [ -z "$TS_HOSTNAME" ] || [ -z "$TS_BIND_ADDR" ]; then
    command -v tailscale >/dev/null 2>&1 ||
      die "tailscale is not installed or not in PATH. Install it and run 'tailscale up' first (see docs/ops)."
    if [ -z "$TS_BIND_ADDR" ]; then
      TS_BIND_ADDR="$(tailscale ip -4 2>/dev/null | head -n 1)" || true
    fi
    if [ -z "$TS_HOSTNAME" ]; then
      TS_HOSTNAME="$(tailscale status --json 2>/dev/null | sed -n 's/.*"DNSName"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)" || true
      TS_HOSTNAME="${TS_HOSTNAME%.}"
    fi
  fi
  [ -n "$TS_BIND_ADDR" ] || die "tailscale has no IPv4 address; run 'tailscale up' first."
  [ -n "$TS_HOSTNAME" ] || die "cannot read the tailnet name; enable MagicDNS and HTTPS certificates in the Tailscale admin console."
  valid_ipv4 "$TS_BIND_ADDR" || die "unexpected tailscale address '$TS_BIND_ADDR'."
  [[ $TS_HOSTNAME =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || die "unexpected tailnet name '$TS_HOSTNAME'."
}

run_checks() {
  log "checking system"
  check_root
  check_os
  check_arch
  check_disk
  check_ram
  detect_tailscale
}
