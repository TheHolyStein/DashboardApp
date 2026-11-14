# shellcheck shell=bash
# Step 2: apt packages. Source only.

# gnupg verifies and dearmors the NodeSource key; iproute2 is used for LAN detection.
PACKAGES=(curl ca-certificates git sqlite3 caddy ufw unattended-upgrades gnupg iproute2)

pkg_installed() {
  dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q 'install ok installed'
}

install_packages() {
  local missing=() p
  for p in "${PACKAGES[@]}"; do
    pkg_installed "$p" || missing+=("$p")
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    log "installing packages: ${missing[*]}"
    run apt-get update
    run env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${missing[@]}"
    CHANGED=1
  else
    log "packages present"
  fi
  enable_unattended_upgrades
}

enable_unattended_upgrades() {
  local f
  f="$(rp /etc/apt/apt.conf.d/20auto-upgrades)"
  if [ -e "$f" ]; then
    return 0
  fi
  make_tmp
  printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' >"$TMP_DIR/20auto-upgrades"
  install_file "$TMP_DIR/20auto-upgrades" "$f" 0644 root root
}
