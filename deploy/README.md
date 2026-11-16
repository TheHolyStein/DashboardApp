# deploy/

Deployment for the Debian host (Fujitsu Futro S7010): install script, systemd units, Caddy,
firewall and SSH hardening. Code lives in `/opt/dashboard` (root-owned), data in
`/var/lib/dashboard`, config in `/etc/dashboard` (`env`, `secret.key`).

## Files

| File | What it is |
|---|---|
| `install.sh` | Ordered driver; idempotent; run as root from `/opt/dashboard/deploy/` |
| `lib/*.sh` | One file per concern: `checks`, `packages`, `node`, `users-dirs`, `secret`, `build`, `backup`, `migrate`, `services`, `health`, `admin`; plus `common` (wrappers) and `net` (IPv4 helpers) |
| `systemd/dashboard.service` | The app, sandboxed |
| `systemd/dashboard-netscan.{socket,service}` | Socket-activated raw-socket helper; inert until `deploy/netscan/dashboard-netscan` exists |
| `systemd/caddy-dashboard.conf` | Drop-in: start Caddy after tailscaled |
| `caddy/Caddyfile.tmpl` | Rendered by `install.sh` (`${TS_HOSTNAME}`, `${TS_BIND_ADDR}`, `${DASH_PORT}` only) to `/etc/caddy/Caddyfile` |
| `ufw.sh` | Firewall rules; `--dry-run`, `--yes`, `--force`, `--lan <cidr>` |
| `ssh/60-dashboard.conf` | SSH drop-in: no passwords, no root login |
| `tailscale-acl.example.jsonc` | Example ACL: second person reaches `tag:dashboard:443` only |
| `test/` | bats tests, `Dockerfile` for the test container |

## What `install.sh` does, in order

1. Checks: root, Debian >= 12, amd64/arm64, >= 2 GB free disk, >= 1 GB RAM, Tailscale up (reads the `*.ts.net` name and address). Remembers the currently deployed revision.
2. Installs apt packages (`curl ca-certificates git sqlite3 caddy ufw unattended-upgrades`, plus `gnupg iproute2`), enables unattended upgrades.
3. Node 24 from NodeSource's signed apt repository (key fingerprint pinned), then `corepack`.
4. User `dashboard` (no login) and directories with their modes.
5. `/etc/dashboard/secret.key` (32 bytes, `0640 root:dashboard`) and `/etc/dashboard/env`, each written once and never overwritten.
6. `pnpm install --frozen-lockfile --ignore-scripts`, `pnpm rebuild better-sqlite3 @node-rs/argon2 sharp`, `pnpm audit --prod --audit-level high`.
7. `pnpm build` with `NODE_OPTIONS=--max-old-space-size=1536`. Steps 6-9 are skipped when the checkout is already the deployed revision (use `--rebuild` to force).
8. Records the previous revision and backs up the database (`sqlite3 .backup`) to `/var/lib/dashboard/backups/pre-<version>-<timestamp>.{sqlite,rev}`. From here on a failure prints the exact rollback commands.
9. Migrations: none separately; the server migrates when it starts and the health check verifies it.
10. Installs units, renders and validates the Caddyfile, lets `caddy` fetch Tailscale certificates (`TS_PERMIT_CERT_UID=caddy` in `/etc/default/tailscaled`), installs the SSH drop-in (only if a sudo-capable user has an `authorized_keys` entry), runs `ufw.sh`.
11. Restarts what changed; waits up to 30 s for `http://127.0.0.1:8787/api/health`.
12. First install only: asks for the first admin (name, password twice, no echo). Without a terminal it prints the command to run later.
13. Prints URL and summary.

Flags: `--no-firewall`, `--allow-audit`, `--yes`, `--rebuild`. Environment: `DASH_DRY_RUN=1` prints mutating commands instead of running them; `DASH_ROOT=<prefix>` redirects file paths (used by the tests); `DASH_TS_HOSTNAME` and `DASH_TS_ADDR` override Tailscale detection.

Caddy runs with `admin off`: apply Caddyfile changes with `systemctl restart caddy`, not `reload`.

## Health check: `doctor.sh`

`sudo /opt/dashboard/deploy/doctor.sh [--json]` loads `/etc/dashboard/env` (plain `KEY=value` lines only) and runs `node apps/server/dist/cli.js doctor` as the `dashboard` user. As root it also reads `ufw status` and passes it on, because the service user cannot. It changes nothing and exits 1 if any check is FAIL. The checks and thresholds are in `apps/server/src/core/doctor.ts`; the guides for the owner are in `docs/ops/`.

## Running the tests

The bats tests need root and Debian tooling, so they run in a container (from the repository root):

    docker build -f deploy/test/Dockerfile -t dashboard-deploy-test .
    docker run --rm dashboard-deploy-test

Locally, without a container, only `bash -n deploy/install.sh deploy/ufw.sh deploy/lib/*.sh` and `deploy/ufw.sh --dry-run --lan 192.168.1.0/24` are safe to run.

## Checks only the device can do

- `systemd-analyze security dashboard.service` exposure score <= 2.5 (record in `docs/ops/security-score.txt`).
- Real `install.sh` run, then a second run that changes nothing.
- `caddy validate` with the Caddy version Debian ships (2.6.x on Debian 13), and a real certificate from tailscaled.
- Reaching `https://<name>.ts.net` from a phone over Tailscale; port 8787 unreachable from the LAN.
- `ufw status verbose` matches `ufw.sh --dry-run`; SSH still works from LAN and tailnet.
- `sshd -T | grep passwordauthentication` says `no` (an earlier file in `sshd_config.d` can override the drop-in).
- Memory/CPU budgets with the service running; `dashboard-netscan.socket` once the helper exists.
