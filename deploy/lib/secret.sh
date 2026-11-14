# shellcheck shell=bash
# Step 5: secret key and environment file; both written once, never overwritten. Source only.

ensure_secret() {
  local key tmp size
  key="$(rp "$CONF_DIR_ABS/secret.key")"
  if [ -e "$key" ]; then
    size="$(stat -c %s "$key")"
    [ "$size" -eq 32 ] || die "$key exists but is $size bytes, not 32. Not touching it; fix or remove it by hand."
    log "secret key present (kept)"
    return 0
  fi
  log "creating $key"
  if [ "$DASH_DRY_RUN" = 1 ]; then
    echo "+ (generate 32 random bytes into $key, 0640 root:$APP_USER)"
    return 0
  fi
  tmp="$(mktemp "$(dirname "$key")/.secret.XXXXXX")"
  head -c 32 /dev/urandom >"$tmp"
  chmod 0640 "$tmp"
  chown "root:$APP_USER" "$tmp"
  mv -n -- "$tmp" "$key"
  rm -f -- "$tmp"
  CHANGED=1
}

ensure_env_file() {
  local envf tmp
  envf="$(rp "$CONF_DIR_ABS/env")"
  if [ -e "$envf" ]; then
    log "env file present (kept)"
    return 0
  fi
  log "creating $envf"
  if [ "$DASH_DRY_RUN" = 1 ]; then
    echo "+ (write $envf, 0640 root:$APP_USER)"
    return 0
  fi
  tmp="$(mktemp "$(dirname "$envf")/.env.XXXXXX")"
  {
    echo "NODE_ENV=production"
    echo "DASH_DATA_DIR=$DATA_DIR_ABS"
    echo "DASH_CONFIG_DIR=$CONF_DIR_ABS"
    echo "DASH_PORT=$DASH_PORT_VALUE"
    echo "DASH_BASE_URL=https://$TS_HOSTNAME"
    echo "DASH_SECRET_KEY_FILE=$CONF_DIR_ABS/secret.key"
  } >"$tmp"
  chmod 0640 "$tmp"
  chown "root:$APP_USER" "$tmp"
  mv -n -- "$tmp" "$envf"
  rm -f -- "$tmp"
  CHANGED=1
}
