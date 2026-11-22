#!/usr/bin/env bats
# More install.sh behaviour: update path and backups, build steps, secrets, ssh, firewall,
# first admin, NodeSource key handling. Same fake root and stubs as install.bats.

load helpers

setup() { make_env; }

# --- update path, backups -------------------------------------------------------------------

@test "update with an existing database takes one backup and keeps it across failed retries" {
  run_install --yes --no-firewall
  [ "$status" -eq 0 ]
  rev_a="$(git -C "$APP" rev-parse HEAD)"
  [ "$(cat "$DATA/deployed.rev")" = "$rev_a" ]
  # first attempt of the update fails after the backup
  printf 'v1' >"$DATA/dashboard.sqlite"
  new_commit
  STUB_HEALTH_FAIL=1 run_install --yes --no-firewall
  [ "$status" -ne 0 ]
  backups=("$DATA"/backups/pre-*Z.sqlite)
  [ "${#backups[@]}" -eq 1 ]
  [ "$(cat "${backups[0]}")" = v1 ]
  [ "$(cat "${backups[0]%.sqlite}.rev")" = "$rev_a" ]
  [[ "$output" == *"${backups[0]}"* ]]
  [[ "$output" == *"checkout --detach $rev_a"* ]]
  [ "$(cat "$DATA/deployed.rev")" = "$rev_a" ]
  # the failed attempt migrated the live database; the retry must not replace the backup
  printf 'v2-migrated' >"$DATA/dashboard.sqlite"
  STUB_HEALTH_FAIL=1 run_install --yes --no-firewall
  [ "$status" -ne 0 ]
  backups=("$DATA"/backups/pre-*Z.sqlite)
  [ "${#backups[@]}" -eq 1 ]
  [ "$(cat "${backups[0]}")" = v1 ]
  [[ "$output" == *"${backups[0]}"* ]]
  revs=("$DATA"/backups/pre-*Z.rev)
  [ "${#revs[@]}" -eq 1 ]
  # and a successful retry finishes the update
  run_install --yes --no-firewall
  [ "$status" -eq 0 ]
  [ "$(cat "$DATA/deployed.rev")" = "$(git -C "$APP" rev-parse HEAD)" ]
  # the finished update's backup is kept but renamed, so it cannot be re-used
  live=("$DATA"/backups/pre-*Z.sqlite)
  [ ! -e "${live[0]}" ]
  [ "$(cat "$DATA"/backups/pre-*.done.sqlite)" = v1 ]
}

@test "the rollback block checks the backup, moves the database aside and never deletes it" {
  run_install --yes --no-firewall
  [ "$status" -eq 0 ]
  printf 'v1' >"$DATA/dashboard.sqlite"
  new_commit
  STUB_HEALTH_FAIL=1 run_install --yes --no-firewall
  [ "$status" -ne 0 ]
  [[ "$output" == *"test -s '$DATA/backups/pre-"* ]]
  [[ "$output" == *"&& mv '$DATA/dashboard.sqlite' '$DATA/dashboard.sqlite.broken-"* ]]
  [[ "$output" == *"install -m 0640 -o dashboard -g dashboard"* ]]
  [[ "$output" == *"do NOT continue"* ]]
  if [[ "$output" == *"rm -f"* ]]; then false; fi
  if [[ "$output" == *"exit 1"* ]]; then false; fi
}

@test "after a finished update, the next update from the same revision takes a fresh backup" {
  run_install --yes --no-firewall
  [ "$status" -eq 0 ]
  rev_a="$(git -C "$APP" rev-parse HEAD)"
  printf 'v1' >"$DATA/dashboard.sqlite"
  new_commit
  STUB_HEALTH_FAIL=1 run_install --yes --no-firewall
  [ "$status" -ne 0 ]
  # roll back to A: a successful install on A finishes the attempt
  git -C "$APP" checkout -q --detach "$rev_a"
  run_install --yes --no-firewall --rebuild
  [ "$status" -eq 0 ]
  [ "$(cat "$DATA/deployed.rev")" = "$rev_a" ]
  live=("$DATA"/backups/pre-*Z.sqlite)
  [ ! -e "${live[0]}" ]
  # days later: update A -> C with newer data
  printf 'v3' >"$DATA/dashboard.sqlite"
  new_commit
  STUB_HEALTH_FAIL=1 run_install --yes --no-firewall
  [ "$status" -ne 0 ]
  live=("$DATA"/backups/pre-*Z.sqlite)
  [ "${#live[@]}" -eq 1 ]
  [ "$(cat "${live[0]}")" = v3 ]
}

@test "a backup older than 24 hours is kept but not re-used; the rollback text names the fresh one" {
  run_install --yes --no-firewall
  [ "$status" -eq 0 ]
  printf 'v1' >"$DATA/dashboard.sqlite"
  new_commit
  STUB_HEALTH_FAIL=1 run_install --yes --no-firewall
  [ "$status" -ne 0 ]
  old=("$DATA"/backups/pre-*Z.sqlite)
  old_base="${old[0]%.sqlite}"
  # make it three days old, with an older stamp in its name
  stale="${old_base%-*}-20200101T000000Z"
  mv "$old_base.sqlite" "$stale.sqlite"
  mv "$old_base.rev" "$stale.rev"
  touch -d '3 days ago' "$stale.rev" "$stale.sqlite"
  printf 'v2' >"$DATA/dashboard.sqlite"
  STUB_HEALTH_FAIL=1 run_install --yes --no-firewall
  [ "$status" -ne 0 ]
  [ "$(cat "$stale.sqlite")" = v1 ]
  fresh=()
  for f in "$DATA"/backups/pre-*Z.sqlite; do
    [ "$f" = "$stale.sqlite" ] || fresh+=("$f")
  done
  [ "${#fresh[@]}" -eq 1 ]
  [ "$(cat "${fresh[0]}")" = v2 ]
  [[ "$output" == *"database as it was before this update: ${fresh[0]}"* ]]
  [[ "$output" == *"other backup of the same revision"*"$stale.sqlite"* ]]
  # a retry now re-uses the fresh one, not the stale one
  printf 'v2-migrated' >"$DATA/dashboard.sqlite"
  STUB_HEALTH_FAIL=1 run_install --yes --no-firewall
  [ "$status" -ne 0 ]
  [ "$(cat "${fresh[0]}")" = v2 ]
  [[ "$output" == *"database as it was before this update: ${fresh[0]}"* ]]
}

@test "first install takes no backup" {
  run_install --yes --no-firewall
  [ "$status" -eq 0 ]
  backups=("$DATA"/backups/*)
  [ ! -e "${backups[0]}" ]
}

# --- build steps ----------------------------------------------------------------------------

@test "install runs a frozen, script-less pnpm install and rebuilds only allow-listed packages" {
  run_install --yes --no-firewall
  [ "$status" -eq 0 ]
  grep -qx 'pnpm install --frozen-lockfile --ignore-scripts' "$CALLS"
  grep -qx 'pnpm rebuild better-sqlite3 sharp' "$CALLS"
  grep -qx 'pnpm audit --prod --audit-level high' "$CALLS"
  grep -qx 'pnpm build' "$CALLS"
}

@test "audit findings stop the install unless --allow-audit is given" {
  STUB_AUDIT_FAIL=1 run_install --yes --no-firewall
  [ "$status" -ne 0 ]
  [[ "$output" == *"audit"* ]]
  if grep -qx 'pnpm build' "$CALLS"; then false; fi
  STUB_AUDIT_FAIL=1 run_install --yes --no-firewall --allow-audit
  [ "$status" -eq 0 ]
  grep -qx 'pnpm build' "$CALLS"
}

# --- secrets and env ------------------------------------------------------------------------

@test "existing env is kept; wrong owner or mode on key and env is corrected without touching contents" {
  run_install --yes --no-firewall
  [ "$status" -eq 0 ]
  echo 'EXTRA=1' >>"$ROOT/etc/dashboard/env"
  key_before="$(sha256sum <"$ROOT/etc/dashboard/secret.key")"
  chmod 0600 "$ROOT/etc/dashboard/secret.key"
  chown root:root "$ROOT/etc/dashboard/env"
  chmod 0644 "$ROOT/etc/dashboard/env"
  run_install --yes --no-firewall --rebuild
  [ "$status" -eq 0 ]
  grep -qx 'EXTRA=1' "$ROOT/etc/dashboard/env"
  [ "$(mode_of "$ROOT/etc/dashboard/env")" = "640 root dashboard" ]
  [ "$(mode_of "$ROOT/etc/dashboard/secret.key")" = "640 root dashboard" ]
  [ "$key_before" = "$(sha256sum <"$ROOT/etc/dashboard/secret.key")" ]
  [[ "$output" == *"correcting"* ]]
}

@test "a tighter dashboard-owned 0600 secret.key is left alone" {
  run_install --yes --no-firewall
  [ "$status" -eq 0 ]
  key="$ROOT/etc/dashboard/secret.key"
  chown dashboard:dashboard "$key"
  chmod 0600 "$key"
  run_install --yes --no-firewall --rebuild
  [ "$status" -eq 0 ]
  [ "$(mode_of "$key")" = "600 dashboard dashboard" ]
  [[ "$output" != *"correcting owner/mode of $key"* ]]
  # 0640 root:dashboard is the other accepted state
  chown root:dashboard "$key"
  chmod 0640 "$key"
  run_install --yes --no-firewall --rebuild
  [ "$(mode_of "$key")" = "640 root dashboard" ]
  # root-owned 0600 would lock the service out: corrected
  chmod 0600 "$key"
  run_install --yes --no-firewall --rebuild
  [ "$(mode_of "$key")" = "640 root dashboard" ]
}

# --- ssh drop-in ----------------------------------------------------------------------------

@test "ssh drop-in is skipped with a warning when no sudo user has a key" {
  run_install --yes --no-firewall
  [ "$status" -eq 0 ]
  [ ! -e "$ROOT/etc/ssh/sshd_config.d/60-dashboard.conf" ]
  [[ "$output" == *"NOT installing"* ]]
}

@test "ssh drop-in is installed when a sudo user has an authorized_keys entry" {
  mkdir -p "$ROOT/home/alice/.ssh"
  echo 'ssh-ed25519 AAAAC3Nza test@example' >"$ROOT/home/alice/.ssh/authorized_keys"
  run_install --yes --no-firewall
  [ "$status" -eq 0 ]
  cmp "$ROOT/etc/ssh/sshd_config.d/60-dashboard.conf" "$DEPLOY_SRC/ssh/60-dashboard.conf"
  [ "$(mode_of "$ROOT/etc/ssh/sshd_config.d/60-dashboard.conf")" = "644 root root" ]
}

# --- firewall -------------------------------------------------------------------------------

@test "firewall rules are applied unless --no-firewall" {
  DASH_LAN_SUBNET=10.9.8.0/24 run_install --yes
  [ "$status" -eq 0 ]
  grep -qx 'ufw allow in from 10.9.8.0/24 to any port 22 proto tcp' "$CALLS"
  grep -qx 'ufw --force enable' "$CALLS"
  : >"$CALLS"
  run_install --yes --no-firewall --rebuild
  if grep -q '^ufw ' "$CALLS"; then false; fi
}

@test "a dry run of install.sh prints the firewall rules and changes nothing" {
  DASH_DRY_RUN=1 DASH_LAN_SUBNET=10.9.8.0/24 run_install --yes
  [ "$status" -eq 0 ]
  [[ "$output" == *"ufw --force enable"* ]]
  if grep -q '^ufw ' "$CALLS"; then false; fi
  # read-only queries (is-active, is-enabled) are fine; no state-changing systemctl call
  if grep -Eq '^systemctl (restart|start|enable|disable|daemon-reload|reload)' "$CALLS"; then false; fi
  [ ! -e "$ROOT/etc/dashboard" ]
  [ ! -e "$ROOT/var/lib/dashboard" ]
}

# --- first admin ----------------------------------------------------------------------------

@test "first admin is offered when no admin row exists even though the database file does" {
  run_install --yes --no-firewall
  [ "$status" -eq 0 ]
  printf 'db' >"$DATA/dashboard.sqlite"
  STUB_ADMIN_COUNT=0 run_install --yes --no-firewall --rebuild
  [ "$status" -eq 0 ]
  [[ "$output" == *"user:create"* ]]
  STUB_ADMIN_COUNT=1 run_install --yes --no-firewall --rebuild
  [ "$status" -eq 0 ]
  [[ "$output" != *"user:create"* ]]
}

# --- nodesource key -------------------------------------------------------------------------

@test "NodeSource key export takes exactly one pinned key and rejects a second one" {
  # shellcheck source=/dev/null
  . "$DEPLOY_SRC/lib/common.sh"
  # shellcheck source=/dev/null
  . "$DEPLOY_SRC/lib/node.sh"
  export GNUPGHOME="$BATS_TEST_TMPDIR/gh"
  mkdir -m 700 "$GNUPGHOME"
  gpg --batch --quiet --passphrase '' --quick-gen-key 'a <a@example.com>' ed25519 sign never
  gpg --batch --quiet --passphrase '' --quick-gen-key 'b <b@example.com>' ed25519 sign never
  NODESOURCE_KEY_FPR="$(gpg --with-colons --list-keys a@example.com | awk -F: '/^fpr:/ {print $10; exit}')"
  TMP_DIR="$BATS_TEST_TMPDIR"
  gpg --batch --export a@example.com >"$BATS_TEST_TMPDIR/one.gpg"
  gpg --batch --export a@example.com b@example.com >"$BATS_TEST_TMPDIR/two.gpg"
  run export_pinned_nodesource_key "$BATS_TEST_TMPDIR/one.gpg" "$BATS_TEST_TMPDIR/out.gpg"
  [ "$status" -eq 0 ]
  [ "$(gpg --batch --show-keys --with-colons "$BATS_TEST_TMPDIR/out.gpg" | grep -c '^pub:')" -eq 1 ]
  run export_pinned_nodesource_key "$BATS_TEST_TMPDIR/two.gpg" "$BATS_TEST_TMPDIR/out2.gpg"
  [ "$status" -eq 1 ]
  [[ "$output" == *"2 primary keys"* ]]
  NODESOURCE_KEY_FPR=0000000000000000000000000000000000000000
  run export_pinned_nodesource_key "$BATS_TEST_TMPDIR/one.gpg" "$BATS_TEST_TMPDIR/out3.gpg"
  [ "$status" -eq 1 ]
  [[ "$output" == *"mismatch"* ]]
}
