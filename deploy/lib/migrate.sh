# shellcheck shell=bash
# Step 9. Source only.
#
# The server runs its migrations itself when it starts (main.ts: migrateCore), and the
# bundled CLI has no separate `migrate` command. The service start in step 11 and its
# health check are therefore the migration and its verification.

run_migrations() {
  log "migrations run when the service starts (verified by the health check)"
}
