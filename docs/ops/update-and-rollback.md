# Update and rollback

## Update (three commands)

Log in to the Futro over SSH, then:

```
git -C /opt/dashboard pull
sudo /opt/dashboard/deploy/install.sh
sudo /opt/dashboard/deploy/doctor.sh
```

What each one does:

1. `git pull` fetches the new code. Nothing changes on the running dashboard yet.
2. `install.sh` installs what is needed, builds the new version, backs up the database, restarts the service and waits for it to answer. It keeps your settings, your `secret.key` and your data.
3. `doctor.sh` checks that everything is healthy afterwards.

Expected at the end of step 2: a block that starts with `Dashboard is running.` and shows the new revision and the backup file.

Expected at the end of step 3: no FAIL lines. See `troubleshooting.md` for a WARN.

If `git pull` complains about local changes, you edited a file in `/opt/dashboard`. Do not do that. Ask for help before you force anything.

The installer does not ask questions on an update, except the firewall address range if the firewall rules change. Use `--yes` to skip questions.

## What the installer backs up

Before it restarts the service with the new version, the installer saves:

- the database, as a consistent copy, to `/var/lib/dashboard/backups/pre-<version>-<timestamp>.sqlite`;
- the version you had before, as a text file next to it with the same name and the ending `.rev`.

It does not copy `/etc/dashboard/secret.key` (it never changes it) or your Tailscale setup. Keep your own copy of the key, see `troubleshooting.md`.

It skips the build and the backup when the checkout is already the installed version.

## Roll back

If the update fails after the backup step, the installer prints the exact commands to go back. They look like this (your paths and revision will differ). Use the ones it printed, not these:

```
systemctl stop dashboard.service
rm -f '/var/lib/dashboard/dashboard.sqlite' '/var/lib/dashboard/dashboard.sqlite-wal' '/var/lib/dashboard/dashboard.sqlite-shm'
install -m 0640 -o dashboard -g dashboard '/var/lib/dashboard/backups/pre-0.0.0-20261114T120000Z.sqlite' '/var/lib/dashboard/dashboard.sqlite'
git -C '/opt/dashboard' checkout --detach <previous-revision>
'/opt/dashboard/deploy/install.sh' --yes --no-firewall --allow-audit --rebuild
```

Run them as root (put `sudo` before each line). In words:

1. Stop the service.
2. Remove the current database file and its two side files.
3. Put the backed-up database in its place, owned by `dashboard`.
4. Check out the previous version of the code.
5. Run the installer again with `--rebuild`, so that version is built and started.

After a rollback, data entered since the backup is gone. That is the price of going back.

If you need the previous revision later and have the terminal output no more: the file `/var/lib/dashboard/backups/pre-...rev` next to the backup holds it. Read it with:

```
cat /var/lib/dashboard/backups/pre-0.0.0-20261114T120000Z.rev
```

Use the file name you have (list them with `ls -l /var/lib/dashboard/backups`).

After a rollback, to go to the newest code again later, switch back to the branch:

```
git -C /opt/dashboard checkout main
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

3. Still failing: roll back with the commands above, then ask for help with the log lines from step 1.

If this goes wrong: the rollback commands themselves fail only when the backup file is missing. Then the database is untouched by the update, so only the code needs to go back: stop the service, run the `git ... checkout --detach` line, run the installer line.
