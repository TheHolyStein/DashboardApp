#!/usr/bin/env bash
# Firewall for the dashboard host.
#
#   ufw.sh [--dry-run] [--yes] [--force] [--lan <cidr>]
#
#   --dry-run   print the rules (stdout, one per line, fixed order) and change nothing
#   --yes       do not ask to confirm the detected LAN subnet
#   --force     enable even if the current SSH session's source address would be cut off
#   --lan CIDR  use this LAN subnet instead of detecting it (also: DASH_LAN_SUBNET)
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/net.sh
. "$SCRIPT_DIR/lib/net.sh"

DRY_RUN=0
ASSUME_YES=0
FORCE=0
LAN="${DASH_LAN_SUBNET:-}"

# Tailscale's CGNAT range; SSH from there arrives on tailscale0, which is allowed.
TAILNET_V4=100.64.0.0/10
TAILNET_V6_PREFIX=fd7a:115c:a1e0

msg() { printf '%s\n' "$*" >&2; }
fail() {
  msg "ufw.sh: $*"
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --yes) ASSUME_YES=1 ;;
    --force) FORCE=1 ;;
    --lan)
      [ "$#" -ge 2 ] || fail "--lan needs a CIDR"
      LAN="$2"
      shift
      ;;
    -h | --help)
      sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) fail "unknown option: $1" ;;
  esac
  shift
done

if [ -z "$LAN" ]; then
  LAN="$(detect_lan_subnet)" || fail "cannot detect the LAN subnet; pass --lan <cidr> (for example --lan 192.168.1.0/24)."
fi
valid_cidr "$LAN" || fail "not a valid IPv4 CIDR: $LAN"
LAN="$(cidr_network "$LAN")"

# The complete rule list, in the order it is applied.
print_rules() {
  cat <<RULES
ufw default deny incoming
ufw default allow outgoing
ufw allow in on tailscale0 to any port 443 proto tcp
ufw allow in on tailscale0 to any port 22 proto tcp
ufw allow in from $LAN to any port 22 proto tcp
ufw allow out to 224.0.0.251 port 5353 proto udp
ufw --force enable
RULES
}

if [ "$DRY_RUN" = 1 ]; then
  print_rules
  exit 0
fi

[ "$(id -u)" -eq 0 ] || fail "must run as root."
command -v ufw >/dev/null 2>&1 || fail "ufw is not installed."

# Would the SSH session we are running in be cut off? Established connections survive
# 'ufw enable', but a reconnect would not.
ssh_source_allowed() {
  local src="${SSH_CONNECTION%% *}"
  [ -n "${SSH_CONNECTION:-}" ] || return 0
  if [[ $src == *:* ]]; then
    [ "$src" = "::1" ] || [[ $src == "$TAILNET_V6_PREFIX"* ]]
    return
  fi
  valid_ipv4 "$src" || return 1
  ip_in_cidr "$src" "$LAN" || ip_in_cidr "$src" "$TAILNET_V4" || ip_in_cidr "$src" 127.0.0.0/8
}

if ! ssh_source_allowed; then
  src="${SSH_CONNECTION%% *}"
  if [ "$FORCE" != 1 ]; then
    fail "your SSH session comes from $src, which the rules would not allow (LAN $LAN, tailnet). Refusing to enable the firewall; use --lan with the right subnet, or --force."
  fi
  msg "WARNING: SSH source $src is not allowed by the new rules; continuing because of --force."
fi

if [ "$ASSUME_YES" != 1 ]; then
  [ -t 0 ] || fail "no terminal to confirm on; pass --yes."
  msg "SSH will be allowed from the LAN subnet $LAN and from tailscale0."
  read -r -p "Apply these firewall rules and enable ufw? [y/N] " answer
  case "$answer" in
    y | Y | yes | YES) ;;
    *) fail "aborted." ;;
  esac
fi

while IFS= read -r line; do
  read -r -a parts <<<"$line"
  "${parts[@]}"
done < <(print_rules)
