# shellcheck shell=bash
# Steps 6 and 7: dependencies, native rebuilds, audit, build. Source only.

# Native packages whose build steps may run (everything else installs with --ignore-scripts).
NATIVE_ALLOWLIST=(better-sqlite3 @node-rs/argon2 sharp)

build_outputs_present() {
  [ -f "$APP_DIR/apps/server/dist/main.js" ] && [ -f "$APP_DIR/apps/web/dist/index.html" ]
}

build_app() {
  local pm_version native=() p
  pm_version="$(package_manager_version "$APP_DIR")"
  [ -n "$pm_version" ] || die "no pnpm version in $APP_DIR/package.json (\"packageManager\" field)."

  export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  if [ "$(cd "$APP_DIR" && pnpm --version 2>/dev/null || true)" != "$pm_version" ]; then
    log "activating pnpm $pm_version via corepack"
    run corepack prepare "pnpm@$pm_version" --activate
  fi

  log "installing dependencies (frozen lockfile, no scripts)"
  (cd "$APP_DIR" && run pnpm install --frozen-lockfile --ignore-scripts)

  # Rebuild only allow-listed packages that the lockfile actually contains.
  for p in "${NATIVE_ALLOWLIST[@]}"; do
    if [ "$DASH_DRY_RUN" = 1 ] || grep -qF -- "${p}@" "$APP_DIR/pnpm-lock.yaml" 2>/dev/null; then
      native+=("$p")
    fi
  done
  if [ "${#native[@]}" -gt 0 ]; then
    log "rebuilding native dependencies: ${native[*]}"
    (cd "$APP_DIR" && run pnpm rebuild "${native[@]}")
  fi

  log "auditing production dependencies"
  if ! (cd "$APP_DIR" && run pnpm audit --prod --audit-level high); then
    if [ "$ALLOW_AUDIT" = 1 ]; then
      warn "pnpm audit reported high-severity findings; continuing because of --allow-audit."
    else
      die "pnpm audit reported high-severity findings. Fix them or re-run with --allow-audit."
    fi
  fi

  log "building"
  (cd "$APP_DIR" && run env NODE_OPTIONS=--max-old-space-size=1536 pnpm build)
  if [ "$DASH_DRY_RUN" != 1 ]; then
    build_outputs_present || die "build finished but apps/server/dist/main.js or apps/web/dist/index.html is missing."
  fi
  CHANGED=1
  BUILT=1
}
