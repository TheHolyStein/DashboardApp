# shellcheck shell=bash
# Step 11 health check. Source only.

HEALTH_TIMEOUT="${DASH_HEALTH_TIMEOUT:-30}"

wait_for_health() {
  local url="http://127.0.0.1:$DASH_PORT_VALUE/api/health" i
  if [ "$DASH_DRY_RUN" = 1 ]; then
    echo "+ (wait up to ${HEALTH_TIMEOUT}s for $url)"
    return 0
  fi
  log "waiting for $url"
  for ((i = 0; i < HEALTH_TIMEOUT; i++)); do
    if curl -fsS --max-time 2 -o /dev/null "$url" 2>/dev/null; then
      log "healthy"
      return 0
    fi
    sleep 1
  done
  warn "no healthy answer from $url within ${HEALTH_TIMEOUT}s. See: journalctl -u dashboard.service -n 50"
  return 1
}
