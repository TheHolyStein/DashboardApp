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
| Disk space | more than 15 % free | FAIL. Free space as shown in "Disk space is low" below, or use a bigger disk. |
| Database integrity | SQLite `integrity_check` says ok | FAIL. Restore the newest backup with the steps in "Restore the database only" below. |
| Last backup | newest file ending in `.sqlite` in `/var/lib/dashboard/backups` (finished updates' `.done.sqlite` files count) is under 26 h old | WARN. "No backups yet" is normal on a new box. The installer only backs up before an update, so this turns WARN again a day after it. |
| Certificate | the HTTPS certificate is valid for more than 14 days | FAIL. `sudo systemctl restart caddy`, then `tailscale cert` problems: check that HTTPS Certificates is on in the admin console and that tailscaled is running. |
| Background jobs | no job has failed 5 times in a row | WARN. The detail names module and job. Usually the outside service is down or a setting is wrong; fix the module's settings. |
| Memory | service memory is under `MemoryHigh` (300 MB) | WARN. Restart the service. If it returns, note which module is busy. |
| Tailscale | state is `Running` | FAIL. `tailscale status`, then `sudo tailscale up`. |
| Firewall | `ufw` is active | WARN. `sudo /opt/dashboard/deploy/ufw.sh` (check the plan first with `--dry-run`). |
| Security updates | none pending | WARN. `sudo apt-get update && sudo apt-get upgrade` (unattended upgrades normally do it). |

A line that says "cannot determine" means the check itself could not run. Its reason follows. For the checks Service active, Health endpoint and Database integrity an unknown result counts as FAIL; for every other check it counts as WARN.

The firewall check needs root. Run doctor as `sudo /opt/dashboard/deploy/doctor.sh`. Without root it says "run as root to check". The security updates check reads the package lists as they are; it does not refresh them.

## Disk space is low

The backups are the part you control. List them with their sizes:

```
sudo ls -lh /var/lib/dashboard/backups
```

Files ending in `.done.sqlite` and `.done.rev` belong to updates that finished. Remove old ones, one pair at a time, using the file names you see (this example is made up):

```
sudo rm /var/lib/dashboard/backups/pre-0.0.0-0123456789ab-20261001T120000Z.done.sqlite /var/lib/dashboard/backups/pre-0.0.0-0123456789ab-20261001T120000Z.done.rev
```

Keep the newest `.done` pair, and never remove a backup whose name does not contain `.done`: that one belongs to an update that has not finished (see `update-and-rollback.md`). Then:

```
sudo apt-get clean
```

## Restore the database only

The "Database integrity" check failed, or the data is damaged, and the code is fine. This puts a backup in place of the database. Everything written to the dashboard after that backup is lost. A code rollback is a different thing (see `update-and-rollback.md`).

1. Stop the service:

```
sudo systemctl stop dashboard.service
```

2. Choose the backup. List them and take the newest file ending in `.sqlite` that is not empty (the time stamp is in the name):

```
sudo ls -lh /var/lib/dashboard/backups
```

3. Move the database and its two side files aside (nothing is deleted). Use your own backup file name instead of the example in the first line; the line stops if the backup is missing:

```
sudo test -s /var/lib/dashboard/backups/pre-0.0.0-0123456789ab-20261114T120000Z.done.sqlite && sudo mv /var/lib/dashboard/dashboard.sqlite /var/lib/dashboard/dashboard.sqlite.broken-$(date -u +%Y%m%dT%H%M%SZ) || echo "backup missing or database not moved: do NOT continue"
sudo mv /var/lib/dashboard/dashboard.sqlite-wal /var/lib/dashboard/dashboard.sqlite-wal.broken-$(date -u +%Y%m%dT%H%M%SZ)
sudo mv /var/lib/dashboard/dashboard.sqlite-shm /var/lib/dashboard/dashboard.sqlite-shm.broken-$(date -u +%Y%m%dT%H%M%SZ)
```

   The last two lines may say "No such file"; that is fine. If the first line printed "do NOT continue", stop here and start the service again with `sudo systemctl start dashboard.service`.

4. Put the backup in place, owned by the service user (this is the owner and mode the installer uses):

```
sudo install -m 0640 -o dashboard -g dashboard /var/lib/dashboard/backups/pre-0.0.0-0123456789ab-20261114T120000Z.done.sqlite /var/lib/dashboard/dashboard.sqlite
```

5. Start the service and check:

```
sudo systemctl start dashboard.service
sudo /opt/dashboard/deploy/doctor.sh
```

If the integrity check still fails, repeat with the next older backup. If there is no usable backup, ask for help and keep the `.broken-...` files.

## Lost `secret.key`

The file `/etc/dashboard/secret.key` encrypts what modules store as secrets (API keys, passwords for devices) and the two-factor secrets of users. It cannot be recreated. If it is lost or replaced with a new one:

- The service refuses to start if the file is missing in production. If it is gone, restore your copy to `/etc/dashboard/secret.key` with the same owner and mode as before: owner `root`, group `dashboard`, mode `0640`. Mode `0600` is only right if the file is owned by `dashboard`; a `0600` file owned by `root` cannot be read by the service, and it fails to start. Check with `ls -l /etc/dashboard/secret.key`; the installer corrects a wrong owner or mode the next time it runs, and never changes the contents.
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

3. To rebuild the rules for the right home network, preview first (this prints the rules and changes nothing), then apply. Applying also switches the firewall on again, which undoes the `ufw disable` above:

```
sudo /opt/dashboard/deploy/ufw.sh --dry-run --lan 192.168.1.0/24
sudo /opt/dashboard/deploy/ufw.sh --lan 192.168.1.0/24
```

Use your own network instead of `192.168.1.0/24`. At the console there is no SSH session, so the script's lock-out check does not stand in the way. Over SSH it refuses if it cannot tell that your own address is allowed; `--force` overrides that, so use it only when you are sure.

4. If SSH refuses your key, the hardening file is `/etc/ssh/sshd_config.d/60-dashboard.conf`. It turns off passwords and root login. To allow passwords again for a moment, remove the file and reload SSH, then fix your key:

```
sudo rm /etc/ssh/sshd_config.d/60-dashboard.conf
sudo systemctl reload ssh.service
```

5. Afterwards, put things back. Fixing the key alone is not enough: the firewall must be on again (step 3, or check with `sudo ufw status`) and the SSH hardening must be restored. The installer puts the drop-in back, but only when a sudo user has a key in `authorized_keys`:

```
sudo /opt/dashboard/deploy/install.sh --yes --no-firewall
sudo ls /etc/ssh/sshd_config.d/
```

6. There must be exactly one dashboard drop-in there: `60-dashboard.conf`. If you made a copy or renamed one earlier, remove the extra file, because the installer always writes `60-dashboard.conf` and a second file would be a second, forgotten setting.
7. Check from another computer that SSH works with your key. Then run doctor again.

If another file in `/etc/ssh/sshd_config.d/` (or `/etc/ssh/sshd_config` itself) sets `PasswordAuthentication yes`, it can win over `60-dashboard.conf`: SSH uses the first value it reads, and the files are read in alphabetical order. Check what SSH really uses, and which file sets it:

```
sudo sshd -T | grep passwordauthentication
sudo grep -ri passwordauthentication /etc/ssh/sshd_config /etc/ssh/sshd_config.d/
```

It should say `passwordauthentication no`. If not, change the `PasswordAuthentication yes` line in the file the second command names to `no` (leave `60-dashboard.conf` where it is), then check the configuration and reload SSH:

```
sudo sshd -t
sudo systemctl reload ssh.service
```

This guide could not check on the device how your Debian version orders these files; trust the output of `sshd -T`, not the explanation.
