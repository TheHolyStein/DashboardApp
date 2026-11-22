# Update and rollback

Everything here was written against the install scripts in `deploy/`. Nothing in it could be run on the real device while it was written; where that matters it says so.

## Update (three commands)

Log in to the Futro over SSH, then:

```
sudo git -C /opt/dashboard pull
sudo /opt/dashboard/deploy/install.sh
sudo /opt/dashboard/deploy/doctor.sh
```

What each one does:

1. `git pull` fetches the new code. Nothing changes on the running dashboard yet. It needs `sudo` because `/opt/dashboard` belongs to root.
2. `install.sh` installs what is needed, builds the new version, backs up the database, restarts the service and waits for it to answer. It keeps your settings, your `secret.key` and your data.
3. `doctor.sh` checks that everything is healthy afterwards.

Expected at the end of step 2: a block that starts with `Dashboard is running.` and shows the new revision and the backup file.

Expected at the end of step 3: no FAIL lines. See `troubleshooting.md` for a WARN.

If step 1 goes wrong:

- `fatal: detected dubious ownership` or `Permission denied` means the command ran without `sudo`. Run it again exactly as written above.
- `git pull` complaining about local changes means a file in `/opt/dashboard` was edited. Do not do that. Ask for help before you force anything.
- An error about authentication or the repository address means root cannot reach the repository: `sudo` does not use your own SSH key. Ask for help; this cannot be checked without your repository.

The installer asks no questions on an update, with two exceptions: it asks you to confirm the firewall rules (the home network range) on every run, and it asks for a first administrator only if no enabled administrator exists in the database. Add `--yes` to skip the firewall question, or `--no-firewall` to leave the firewall alone.

## What the installer backs up

Before it restarts the service with the new version, the installer saves, in `/var/lib/dashboard/backups`:

- the database, as a consistent copy: `pre-<version>-<first 12 characters of the previous revision>-<timestamp>.sqlite`;
- the previous revision (the code version you had before), as a text file with the same name and the ending `.rev`.

Rules worth knowing:

- A first install has no earlier version and no backup. The "Last backup" line of `doctor.sh` shows WARN until the first update.
- Retrying a failed update re-uses the backup of the first attempt (the failed attempt may already have changed the live database, so a new backup would be worse). It does so for 24 hours. A backup older than that is kept but not used again, and a fresh one is taken.
- When an install finishes successfully, the backup of the old version is kept but renamed: `...<timestamp>.done.sqlite` and `...<timestamp>.done.rev`. That marks the update as finished, so the next update from the same version takes a fresh backup. They still count for the "Last backup" line of `doctor.sh`.
- If the checkout is already the installed version, the build and the backup are skipped.

It does not copy `/etc/dashboard/secret.key` (it never changes it) or your Tailscale setup. Keep your own copy of the key, see `troubleshooting.md`.

## Roll back after a failed install

If the update fails after the backup step, the installer prints the exact commands to go back. They look like this (your paths and revision will differ). Use the ones it printed, not these:

```
systemctl stop dashboard.service
test -s '/var/lib/dashboard/backups/pre-0.0.0-0123456789ab-20261114T120000Z.sqlite' && mv '/var/lib/dashboard/dashboard.sqlite' '/var/lib/dashboard/dashboard.sqlite.broken-20261114T121500Z' && { mv '/var/lib/dashboard/dashboard.sqlite-wal' '/var/lib/dashboard/dashboard.sqlite.broken-20261114T121500Z-wal' 2>/dev/null; mv '/var/lib/dashboard/dashboard.sqlite-shm' '/var/lib/dashboard/dashboard.sqlite.broken-20261114T121500Z-shm' 2>/dev/null; install -m 0640 -o dashboard -g dashboard '/var/lib/dashboard/backups/pre-0.0.0-0123456789ab-20261114T120000Z.sqlite' '/var/lib/dashboard/dashboard.sqlite'; } || echo 'backup missing or database not moved: do NOT continue'
git -C '/opt/dashboard' checkout --detach <previous-revision>
'/opt/dashboard/deploy/install.sh' --yes --no-firewall --allow-audit --rebuild
```

Run them as root, one line at a time, from the top. The simplest way: open a root shell with `sudo -i`, paste the lines there, and type `exit` when you are done (the long second line has several commands in it, so a single `sudo` in front would not cover it). The block contains comment lines starting with `#`; they are safe to paste. In words:

1. Stop the service.
2. The long second line does several things in a fixed order, and stops at the first problem: it checks that the backup file exists and is not empty; it moves the current database file aside (to a name ending `.broken-<timestamp>`, it is not deleted); it moves the two side files `-wal` and `-shm` aside if they exist; it puts the backed-up database in its place, owned by `dashboard`. If the backup file is missing or the database cannot be moved, it prints `backup missing or database not moved: do NOT continue` and changes nothing further. Then stop and ask for help; do not run the next lines.
3. Check out the previous version of the code.
4. Run the installer again with `--rebuild`, so that version is built and started.

Before step 2, look at the backups yourself:

```
sudo ls -l /var/lib/dashboard/backups
```

The file named in the printed block must be in the list and must not have size 0. If several backups of the same version exist, the printed block names the one taken before this update and mentions the others as comments; use the named one.

After a rollback, data entered since the backup is gone. The moved-aside `dashboard.sqlite.broken-...` files keep the broken state in case it is needed; they can be deleted once the dashboard runs well again (`sudo ls /var/lib/dashboard` shows them).

## Roll back an update that went through but misbehaves

Use this when the installer said `Dashboard is running.` but the new version is wrong, and the terminal output with the commands is gone. Run everything on the Futro over SSH.

1. Print the revision that is running now, and write it down:

```
sudo git -C /opt/dashboard rev-parse HEAD
```

   Then list the finished backups, newest first, with the revision each `.done.rev` file holds:

```
sudo sh -c 'for f in $(ls -t /var/lib/dashboard/backups/*.done.rev); do echo "$f: $(cat "$f")"; done'
```

   Take the newest pair named `pre-<version>-<revision start>-<timestamp>.done.sqlite` and `...done.rev` whose revision is different from the one printed first. Skip every pair whose revision is the current one: a rebuild of the version that is running now (`install.sh --rebuild`) also makes a backup and marks it `.done`, and its database is already the post-update state. The time stamps in the names tell you which pair is from the update you want to undo.

2. Read the previous revision from the `.rev` file (use the file name you have):

```
sudo cat /var/lib/dashboard/backups/pre-0.0.0-0123456789ab-20261114T120000Z.done.rev
```

   It prints a long hexadecimal revision. Write it down.

3. Stop the service:

```
sudo systemctl stop dashboard.service
```

4. Put the old database back. This loses all data entered since the update. Skip this step if you are sure the update did not change the database (then the installer in step 6 simply keeps the current one). Use your own backup file name in both places:

```
sudo test -s /var/lib/dashboard/backups/pre-0.0.0-0123456789ab-20261114T120000Z.done.sqlite && sudo mv /var/lib/dashboard/dashboard.sqlite /var/lib/dashboard/dashboard.sqlite.broken-$(date -u +%Y%m%dT%H%M%SZ) || echo "backup missing or database not moved: do NOT continue"
```

   Only if that printed nothing, continue with the side files and the install. `mv` may say "No such file" for the two side files; that is fine.

```
sudo mv /var/lib/dashboard/dashboard.sqlite-wal /var/lib/dashboard/dashboard.sqlite-wal.broken-$(date -u +%Y%m%dT%H%M%SZ)
sudo mv /var/lib/dashboard/dashboard.sqlite-shm /var/lib/dashboard/dashboard.sqlite-shm.broken-$(date -u +%Y%m%dT%H%M%SZ)
sudo install -m 0640 -o dashboard -g dashboard /var/lib/dashboard/backups/pre-0.0.0-0123456789ab-20261114T120000Z.done.sqlite /var/lib/dashboard/dashboard.sqlite
```

5. Check out the previous code, using the revision from step 2:

```
sudo git -C /opt/dashboard checkout --detach <revision-from-step-2>
```

6. Build and start that version:

```
sudo /opt/dashboard/deploy/install.sh --yes --no-firewall --allow-audit --rebuild
```

7. Check:

```
sudo /opt/dashboard/deploy/doctor.sh
```

Expected: no FAIL lines. Then open the dashboard in the browser.

To go to the newest code again later, switch back to the branch and update as usual (the three commands at the top):

```
sudo git -C /opt/dashboard checkout main
```

Use the branch name of your repository if it is not `main`.

## If the health check fails after an update

The installer waits up to 30 seconds for `http://127.0.0.1:8787/api/health`. If there is no healthy answer it prints a warning with a log command and exits with an error, then the rollback commands.

1. Read the log:

```
journalctl -u dashboard.service -n 50
```

Look for an error line near the end. Typical causes: a missing or unreadable `/etc/dashboard/secret.key`, a wrong value in `/etc/dashboard/env`, a database that cannot be migrated.

2. Try once more, in case it was just slow (an old CPU needs a moment after a build):

```
sudo systemctl restart dashboard.service
sudo /opt/dashboard/deploy/doctor.sh
```

3. Still failing: roll back with the commands the installer printed (section "Roll back after a failed install"), then ask for help with the log lines from step 1.

If this goes wrong: before you run the printed rollback commands, check that the backup file they name is there and not empty:

```
sudo ls -l /var/lib/dashboard/backups
```

The printed block checks this itself and refuses to touch the database when the backup is missing. Do not assume the database is still the old one in that case: the failed update may already have changed it, because the new version migrates the database when it starts. If the backup file is really missing, do not delete anything; ask for help, and keep the `dashboard.sqlite` files in `/var/lib/dashboard` as they are. Going back with the code only (steps 3, 5 and 6 of "Roll back an update that went through but misbehaves": stop the service, check out the previous revision, build and start it; step 4, the database restore, is left out) can leave an old version facing a newer database, so it is not a safe fix on its own.
