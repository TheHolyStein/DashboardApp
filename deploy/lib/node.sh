# shellcheck shell=bash
# Step 3: Node 24 from NodeSource's signed apt repository, then corepack. Source only.

NODE_MAJOR=24
# NodeSource repository signing key. Pinned: the downloaded key must have this fingerprint.
NODESOURCE_KEY_URL="https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key"
NODESOURCE_KEY_FPR="6F71F525282841EEDAF851B42F59B5F99B1BE0B4"

node_major() {
  local v
  if ! command -v node >/dev/null 2>&1; then
    echo 0
    return 0
  fi
  v="$(node --version)"
  v="${v#v}"
  echo "${v%%.*}"
}

setup_nodesource_repo() {
  local keyring list pin fpr
  keyring="$(rp /etc/apt/keyrings/nodesource.gpg)"
  list="$(rp /etc/apt/sources.list.d/nodesource.sources)"
  pin="$(rp /etc/apt/preferences.d/nodesource)"
  make_tmp
  if [ ! -s "$keyring" ]; then
    run curl -fsSL --proto '=https' --tlsv1.2 -o "$TMP_DIR/nodesource.key" "$NODESOURCE_KEY_URL"
    if [ "$DASH_DRY_RUN" != 1 ]; then
      fpr="$(gpg --batch --show-keys --with-colons "$TMP_DIR/nodesource.key" | awk -F: '/^fpr:/ {print $10; exit}')"
      [ "$fpr" = "$NODESOURCE_KEY_FPR" ] || die "NodeSource key fingerprint mismatch (got '$fpr'); refusing to trust it."
      gpg --batch --dearmor -o "$TMP_DIR/nodesource.gpg" "$TMP_DIR/nodesource.key"
    fi
    run install -D -m 0644 -o root -g root "$TMP_DIR/nodesource.gpg" "$keyring"
    CHANGED=1
  fi
  printf 'Types: deb\nURIs: https://deb.nodesource.com/node_%s.x\nSuites: nodistro\nComponents: main\nSigned-By: /etc/apt/keyrings/nodesource.gpg\n' "$NODE_MAJOR" >"$TMP_DIR/nodesource.sources"
  install_file "$TMP_DIR/nodesource.sources" "$list" 0644 root root
  # Debian's own nodejs package must not win over NodeSource's.
  printf 'Package: nodejs\nPin: origin deb.nodesource.com\nPin-Priority: 600\n' >"$TMP_DIR/nodesource.pin"
  install_file "$TMP_DIR/nodesource.pin" "$pin" 0644 root root
}

install_node() {
  if [ "$(node_major)" != "$NODE_MAJOR" ]; then
    log "installing Node $NODE_MAJOR"
    setup_nodesource_repo
    run apt-get update
    run env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends nodejs
    CHANGED=1
  else
    log "node $(node --version) present"
  fi
  if ! command -v corepack >/dev/null 2>&1; then
    run npm install -g corepack
    CHANGED=1
  fi
  if ! command -v pnpm >/dev/null 2>&1; then
    run corepack enable
    CHANGED=1
  fi
}
