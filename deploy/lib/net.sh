# shellcheck shell=bash
# IPv4 helpers (pure bash) shared by ufw.sh and install.sh. Source only.

valid_ipv4() {
  [[ $1 =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
  local o
  for o in "${BASH_REMATCH[@]:1}"; do
    ((10#$o <= 255)) || return 1
  done
}

valid_cidr() {
  [[ $1 == */* ]] || return 1
  local ip="${1%/*}" len="${1#*/}"
  valid_ipv4 "$ip" || return 1
  [[ $len =~ ^[0-9]{1,2}$ ]] || return 1
  ((10#$len <= 32))
}

ip2int() {
  valid_ipv4 "$1" || return 1
  echo $(((10#${BASH_REMATCH[1]} << 24) | (10#${BASH_REMATCH[2]} << 16) | (10#${BASH_REMATCH[3]} << 8) | 10#${BASH_REMATCH[4]}))
}

cidr_mask() {
  local len=$((10#${1#*/}))
  echo $((len == 0 ? 0 : (0xFFFFFFFF << (32 - len)) & 0xFFFFFFFF))
}

# cidr_network 192.168.1.37/24 -> 192.168.1.0/24
cidr_network() {
  local ip mask net
  ip="$(ip2int "${1%/*}")" || return 1
  mask="$(cidr_mask "$1")"
  net=$((ip & mask))
  printf '%d.%d.%d.%d/%d\n' $((net >> 24 & 255)) $((net >> 16 & 255)) $((net >> 8 & 255)) $((net & 255)) $((10#${1#*/}))
}

# ip_in_cidr <ip> <cidr>
ip_in_cidr() {
  local ip mask net
  ip="$(ip2int "$1")" || return 1
  mask="$(cidr_mask "$2")"
  net="$(ip2int "${2%/*}")" || return 1
  [ $((ip & mask)) -eq $((net & mask)) ]
}

# detect_lan_subnet: network of the default route's interface, e.g. 192.168.1.0/24
detect_lan_subnet() {
  local dev addr
  dev="$(ip -4 route show default 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit }}')"
  [ -n "$dev" ] || return 1
  addr="$(ip -4 -o addr show dev "$dev" scope global 2>/dev/null | awk '{print $4; exit}')"
  [ -n "$addr" ] || return 1
  valid_cidr "$addr" || return 1
  cidr_network "$addr"
}
