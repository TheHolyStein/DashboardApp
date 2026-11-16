# Troubleshooting

Start here:

```
sudo /opt/dashboard/deploy/doctor.sh
```

WARN means "look at it soon". FAIL means "the dashboard is down or about to be". Exit code 1 means at least one FAIL. The log is always the next step:

```
journalctl -u dashboard.service -n 50
```

## The checks, one by one

| Check | OK when | If not OK, try first |
|---|---|---|
| Service active | `dashboard.service` is active | FAIL. `sudo systemctl restart dashboard.service`, then read the log above. |
| Health endpoint | `/api/health` on 127.0.0.1:8787 answers ok | FAIL. The service is up but not serving. Read the log; check `/etc/dashboard/env`. |
| Disk space | more than 15 % free | FAIL. Delete old files in `/var/lib/dashboard/backups` (keep the newest), run `sudo apt-get clean`, or use a bigger disk. |
| Database integrity | SQLite `integrity_check` says ok | FAIL. Stop the service, restore the newest backup (commands in `update-and-rollback.md`, rollback section). |
| Last backup | newest `.sqlite` in `/var/lib/dashboard/backups` is under 26 h old | WARN. "No backups yet" is normal on a new box. The installer only backs up before an update, so this turns WARN again a day after it. |
| Certificate | the HTTPS certificate is valid for more than 14 days | FAIL. `sudo systemctl restart caddy`, then `tailscale cert` problems: check that HTTPS Certificates is on in the admin console and that tailscaled is running. |
| Background jobs | no job has failed 5 times in a row | WARN. The detail names module and job. Usually the outside service is down or a setting is wrong; fix the module's settings. |
| Memory | service memory is under `MemoryHigh` (300 MB) | WARN. Restart the service. If it returns, note which module is busy. |
| Tailscale | state is `Running` | FAIL. `tailscale status`, then `sudo tailscale up`. |
| Firewall | `ufw` is active | WARN. `sudo /opt/dashboard/deploy/ufw.sh` (check the plan first with `--dry-run`). |
| Security updates | none pending | WARN. `sudo apt-get update && sudo apt-get upgrade` (unattended upgrades normally do it). |

A line that says "cannot determine" means the check itself could not run. Its reason follows. For the first three failing checks (service, health, database) an unknown result counts as FAIL.

The firewall check needs root. Run doctor as `sudo /opt/dashboard/deploy/doctor.sh`. Without root it says "run as root to check". The security updates check reads the package lists as they are; it does not refresh them.

## Lost `secret.key`

The file `/etc/dashboard/secret.key` encrypts what modules store as secrets (API keys, passwords for devices) and the two-factor secrets of users. It cannot be recreated. If it is lost or replaced with a new one:

- The service refuses to start if the file is missing in production. If it is gone, restore your copy to `/etc/dashboard/secret.key` with the same owner and mode as before (`root:dashboard`, `0640`; `0600` also works).
- If you have no copy: create a fresh one, then re-enter things.

```
sudo install -m 0640 -o root -g dashboard /dev/null /etc/dashboard/secret.key
sudo sh -c 'head -c 32 /dev/urandom > /etc/dashboard/secret.key'
sudo systemctl restart dashboard.service
```

Afterwards:

1. Module secrets are unreadable. Open each module's settings as administrator and enter its secrets again.
2. Users with two-factor sign-in cannot sign in: their stored secret cannot be read, and the dashboard refuses the login rather than letting anyone in. An administrator resets their two-factor in user administration ("reset two-factor"; internally `resetTotp`). The user then sets it up again in their account settings. If the locked-out person is the only administrator, create another administrator from the Futro first:

```
sudo -u dashboard sh -c 'set -a; . /etc/dashboard/env; set +a; exec node /opt/dashboard/apps/server/dist/cli.js user:create --name Rescue --role admin'
```

   Sign in as that user, reset the other user's two-factor, then disable or remove the rescue user.

If you wonder whether you need a copy: yes. Copy the key to a password manager or a USB stick after the first install.

## User changes made on the command line while the server runs

`user:create` writes straight into the database. The running server keeps some user data in memory, so it may not see the new user. Restart the service:

```
sudo systemctl restart dashboard.service
```

Then sign in with the new user. Changes made in the web screens do not need a restart.

## Locked out by the firewall or SSH

You need a keyboard and a screen on the Futro.

1. Connect them and log in on the console (the console is not affected by the firewall or SSH rules).
2. If the firewall is the problem, look at the rules and switch it off while you fix them:

```
sudo ufw status verbose
sudo ufw disable
```

3. To rebuild the rules for the right home network, preview first, then apply:

```
sudo /opt/dashboard/deploy/ufw.sh --dry-run --lan 192.168.1.0/24
sudo /opt/dashboard/deploy/ufw.sh --lan 192.168.1.0/24
```

Use your own network instead of `192.168.1.0/24`.

4. If SSH refuses your key, the hardening file is `/etc/ssh/sshd_config.d/60-dashboard.conf`. It turns off passwords and root login. To allow passwords again for a moment, remove the file and reload SSH, fix your key, then run `install.sh` again to put it back:

```
sudo rm /etc/ssh/sshd_config.d/60-dashboard.conf
sudo systemctl reload ssh.service
```

5. Check from another computer that SSH works. Then run doctor again.

If another file in `/etc/ssh/sshd_config.d/` sets `PasswordAuthentication yes` and sorts before `60-dashboard.conf`, it wins. Check what SSH really uses:

```
sudo sshd -T | grep passwordauthentication
```

It should say `passwordauthentication no`. If not, rename `60-dashboard.conf` so it sorts earlier (for example `00-dashboard.conf`) and reload SSH.
