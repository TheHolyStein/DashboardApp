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

# --- Is this run inside an SSH session, and where does it come from? -----------------------
# sudo (the documented way to run this) strips SSH_CONNECTION, so look further:
#   1. SSH_CONNECTION / SSH_CLIENT, if they survived
#   2. an sshd ancestor process: its socket's peer address from `ss`
#   3. `who -m`: the remote host of this terminal's login
# SSH_STATE: none (local console or no session) | known (SSH_SRC set) | unknown (a session
# exists but its source could not be determined). Unknown refuses without --force.
SSH_STATE=none
SSH_SRC=""

ancestor_sshd_pids() {
  local pid=$$ comm
  while [ "$pid" -gt 1 ]; do
    comm="$(cat "/proc/$pid/comm" 2>/dev/null)" || break
    case "$comm" in sshd | sshd-session) echo "$pid" ;; esac
    pid="$(awk '/^PPid:/ {print $2}' "/proc/$pid/status" 2>/dev/null)" || break
    [ -n "$pid" ] || break
  done
}

normalise_peer() {
  local p="$1"
  p="${p%:*}"
  p="${p#[}"
  p="${p%]}"
  p="${p#::ffff:}"
  printf '%s' "$p"
}

detect_ssh_session() {
  local pid peer who_host
  if [ -n "${SSH_CONNECTION:-}" ]; then
    SSH_STATE=known
    SSH_SRC="${SSH_CONNECTION%% *}"
    return 0
  fi
  if [ -n "${SSH_CLIENT:-}" ]; then
    SSH_STATE=known
    SSH_SRC="${SSH_CLIENT%% *}"
    return 0
  fi
  for pid in $(ancestor_sshd_pids); do
    SSH_STATE=unknown
    if command -v ss >/dev/null 2>&1; then
      peer="$(ss -Htnp state established 2>/dev/null | awk -v pat="pid=$pid," 'index($0, pat) {print $4; exit}')"
      if [ -n "$peer" ]; then
        SSH_STATE=known
        SSH_SRC="$(normalise_peer "$peer")"
        return 0
      fi
    fi
  done
  if [ "$SSH_STATE" = unknown ]; then
    return 0
  fi
  who_host="$(who -m 2>/dev/null | sed -n 's/.*(\(.*\))[[:space:]]*$/\1/p' | head -n 1)" || true
  case "$who_host" in
    '' | :*) ;; # no remote host, or a local X display
    *)
      SSH_STATE=known
      SSH_SRC="$who_host"
      ;;
  esac
  if [ "$SSH_STATE" = none ] && { [ -n "${SSH_TTY:-}" ] || [ -n "${SSH_AUTH_SOCK:-}" ]; }; then
    SSH_STATE=unknown
  fi
}

# Would the SSH session we are running in be cut off? Established connections survive
# 'ufw enable', but a reconnect would not.
ssh_source_allowed() {
  local src="$SSH_SRC"
  if [[ $src == *:* ]]; then
    [ "$src" = "::1" ] || [[ $src == "$TAILNET_V6_PREFIX"* ]]
    return
  fi
  valid_ipv4 "$src" || return 1
  ip_in_cidr "$src" "$LAN" || ip_in_cidr "$src" "$TAILNET_V4" || ip_in_cidr "$src" 127.0.0.0/8
}

detect_ssh_session
case "$SSH_STATE" in
  none) ;;
  unknown)
    if [ "$FORCE" != 1 ]; then
      fail "you appear to be connected over SSH, but the source address could not be determined, so the lock-out check cannot run. Refusing to enable the firewall; re-run with --force if you are sure the rules allow your address."
    fi
    msg "WARNING: SSH source address unknown; continuing because of --force."
    ;;
  known)
    if ! ssh_source_allowed; then
      if [ "$FORCE" != 1 ]; then
        fail "your SSH session comes from $SSH_SRC, which the rules would not allow (LAN $LAN, tailnet). Refusing to enable the firewall; use --lan with the right subnet, or --force."
      fi
      msg "WARNING: SSH source $SSH_SRC is not allowed by the new rules; continuing because of --force."
    fi
    ;;
esac

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
