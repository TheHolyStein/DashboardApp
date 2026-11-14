# shellcheck shell=bash
# Step 10: systemd units, Caddy, SSH drop-in, firewall. Source only.

SYSTEMD_DIR_ABS=/etc/systemd/system
UNITS=(dashboard.service dashboard-netscan.service dashboard-netscan.socket)

install_units() {
  local u changed=0
  for u in "${UNITS[@]}"; do
    install_file "$DEPLOY_DIR/systemd/$u" "$(rp "$SYSTEMD_DIR_ABS/$u")" 0644 root root
    [ "$FILE_CHANGED" = 1 ] && changed=1
  done
  # Caddy must start after Tailscale, because it binds to the Tailscale address.
  install_file "$DEPLOY_DIR/systemd/caddy-dashboard.conf" \
    "$(rp "$SYSTEMD_DIR_ABS/caddy.service.d/dashboard.conf")" 0644 root root
  [ "$FILE_CHANGED" = 1 ] && changed=1
  if [ "$changed" = 1 ]; then
    run systemctl daemon-reload
    UNITS_CHANGED=1
  fi
  if ! systemctl is-enabled --quiet dashboard.service 2>/dev/null; then
    run systemctl enable dashboard.service
    CHANGED=1
  fi
  if ! systemctl is-enabled --quiet dashboard-netscan.socket 2>/dev/null; then
    # --now is a no-op until the helper binary exists (ConditionPathExists on the unit).
    run systemctl enable --now dashboard-netscan.socket
    CHANGED=1
  fi
}

# Let the caddy user fetch the node's certificate from tailscaled.
ensure_tailscale_cert_permission() {
  local f
  f="$(rp /etc/default/tailscaled)"
  if [ -f "$f" ] && grep -qx 'TS_PERMIT_CERT_UID=caddy' "$f"; then
    return 0
  fi
  log "allowing user caddy to request Tailscale certificates"
  if [ "$DASH_DRY_RUN" = 1 ]; then
    echo "+ (set TS_PERMIT_CERT_UID=caddy in $f)"
    return 0
  fi
  make_tmp
  if [ -f "$f" ]; then
    grep -v '^TS_PERMIT_CERT_UID=' "$f" >"$TMP_DIR/tailscaled.default" || true
  else
    : >"$TMP_DIR/tailscaled.default"
  fi
  echo 'TS_PERMIT_CERT_UID=caddy' >>"$TMP_DIR/tailscaled.default"
  install_file "$TMP_DIR/tailscaled.default" "$f" 0644 root root
  warn "restarting tailscaled; a Tailscale-based SSH session may drop for a moment."
  run systemctl restart tailscaled.service
}

# render_template <src> <dest>: replaces ${NAME} for the named variables only. Everything
# else, including Caddy's own {placeholders}, is left alone.
RENDER_VARS=(TS_HOSTNAME TS_BIND_ADDR DASH_PORT)
render_template() {
  local src="$1" dest="$2" content var val pat
  content="$(<"$src")"
  for var in "${RENDER_VARS[@]}"; do
    val="${!var:?$var is not set}"
    [[ $val =~ ^[A-Za-z0-9.:-]+$ ]] || die "refusing to render $var='$val' (unexpected characters)."
    pat="\${${var}}"
    content="${content//"$pat"/$val}"
  done
  if [[ $content == *'${'* ]]; then
    die "unreplaced placeholder left in rendered $src."
  fi
  printf '%s\n' "$content" >"$dest"
}

install_caddy() {
  local target dist
  target="$(rp /etc/caddy/Caddyfile)"
  make_tmp
  DASH_PORT="$DASH_PORT_VALUE" render_template "$DEPLOY_DIR/caddy/Caddyfile.tmpl" "$TMP_DIR/Caddyfile"
  run caddy validate --config "$TMP_DIR/Caddyfile" --adapter caddyfile
  # Keep the distribution's Caddyfile once, if it is not ours.
  dist="$target.orig"
  if [ -f "$target" ] && ! grep -q 'Managed by dashboard install.sh' "$target" && [ ! -e "$dist" ]; then
    run cp -p -- "$target" "$dist"
  fi
  install_file "$TMP_DIR/Caddyfile" "$target" 0644 root root
  if [ "$FILE_CHANGED" = 1 ]; then
    CADDY_CHANGED=1
  fi
  if ! systemctl is-enabled --quiet caddy.service 2>/dev/null; then
    run systemctl enable caddy.service
    CHANGED=1
  fi
}

# Install the SSH hardening drop-in only when at least one sudo-capable user has a key,
# so the owner of a headless box cannot be locked out.
sudo_user_has_key() {
  local u home f
  for u in $(getent group sudo | cut -d: -f4 | tr ',' ' '); do
    home="$(getent passwd "$u" | cut -d: -f6)"
    [ -n "$home" ] || continue
    f="$(rp "$home")/.ssh/authorized_keys"
    if [ -s "$f" ] && grep -qE '^[[:space:]]*(ssh-|ecdsa-|sk-)' "$f"; then
      return 0
    fi
  done
  return 1
}

install_ssh_dropin() {
  local dest
  dest="$(rp /etc/ssh/sshd_config.d/60-dashboard.conf)"
  if ! sudo_user_has_key; then
    warn "no authorized_keys entry for any sudo-capable user: NOT installing the SSH hardening drop-in (it would disable password logins)."
    warn "add a key (ssh-copy-id), then re-run install.sh."
    return 0
  fi
  install_file "$DEPLOY_DIR/ssh/60-dashboard.conf" "$dest" 0644 root root
  if [ "$FILE_CHANGED" = 1 ] && [ "$DASH_DRY_RUN" != 1 ]; then
    if command -v sshd >/dev/null 2>&1 && ! sshd -t; then
      rm -f -- "$dest"
      die "sshd rejected the configuration with the drop-in; it was removed again."
    fi
    run systemctl reload ssh.service
  fi
  if command -v sshd >/dev/null 2>&1 && [ "$DASH_DRY_RUN" != 1 ] && [ -z "$DASH_ROOT" ]; then
    if sshd -T 2>/dev/null | grep -qi '^passwordauthentication yes'; then
      warn "sshd still allows password authentication: an earlier file in /etc/ssh/sshd_config.d/ wins over 60-dashboard.conf."
    fi
  fi
}

install_firewall() {
  if [ "$NO_FIREWALL" = 1 ]; then
    log "skipping firewall (--no-firewall)"
    return 0
  fi
  local args=()
  [ "$ASSUME_YES" = 1 ] && args+=(--yes)
  if ! "$DEPLOY_DIR/ufw.sh" "${args[@]}"; then
    FIREWALL_FAILED=1
    warn "firewall NOT enabled (see message above). Fix and run: $DEPLOY_DIR/ufw.sh"
  fi
}
