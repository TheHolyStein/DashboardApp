# Setup guide

This guide takes a Fujitsu Futro S7010 from a box in a cardboard carton to a running dashboard. You do it once. Plan about two hours.

Some things can only be checked on the real device. Where that is the case, the guide says so.

You need:

- The Futro, its power supply, a network cable to your router.
- A keyboard and a screen, only for the first steps.
- A USB stick (at least 2 GB) with the Debian installer on it.
- Another computer with an SSH client.
- A free Tailscale account.

## 1. Install Debian

Download the current Debian stable "netinst" image for your CPU from the Debian website and write it to the USB stick. Boot the Futro from it (usually F12 or Esc at power-on opens a boot menu; the exact key must be checked on the device).

Choices in the installer:

- Language, location, keyboard: your own.
- Hostname: `dashboard` (any name works).
- Root password: leave it empty. The installer then makes your user an administrator with `sudo`.
- Partitioning: "Guided - use entire disk", all files in one partition.
- Software selection: untick every desktop environment. Keep only "SSH server" and "standard system utilities".

Debian 12 or newer is required. The installer script refuses anything else.

After the reboot, log in with your user and find the IP address:

```
ip -4 addr show scope global
```

Look for a line like `inet 192.168.1.37/24`. Write the address down.

If this goes wrong: no network address means the cable or the router. Check the link light first.

## 2. Power on after a power loss

A box that stays off after a power cut is no use. Switch on the "restore on AC power loss" behaviour in the BIOS.

Reboot and press the BIOS key at power-on (often Del or F2; check on the device). Look for a setting under a power or advanced menu. Such settings are usually called "After Power Failure", "AC Power Recovery" or "Restore on AC Power Loss". Set it to "Power On" (or "Last State"). The exact menu name on a Futro S7010 must be checked on the device; this guide does not know it.

Test it: shut the box down, pull the power plug, plug it in again. It should start by itself.

## 3. Set up SSH keys (before the installer)

The installer turns off password logins for SSH. It does this only if it finds a key for an administrator account. Without a key it skips that step and prints a warning. Set up the key first.

On your own computer, create a key if you do not have one:

```
ssh-keygen -t ed25519
```

Copy it to the Futro (use your user name and the address from step 1):

```
ssh-copy-id youruser@192.168.1.37
```

Test that the key works:

```
ssh youruser@192.168.1.37
```

You should get a shell without being asked for the account password. (A passphrase for the key itself is fine.)

If this goes wrong: "Permission denied" after `ssh-copy-id` means the password was typed wrong. Run it again.

Keep this SSH window open. If a later step goes wrong you still have a way in.

## 4. Install Tailscale

The dashboard is reachable only over Tailscale. Install it on the Futro, following the Debian instructions on tailscale.com/download. Then sign in:

```
sudo tailscale up
```

It prints a link. Open it on your computer and approve the machine.

Check that it is connected:

```
tailscale status
```

The Futro should be listed. Write down its full name, which looks like `dashboard.tailnet-name.ts.net`.

Now open the Tailscale admin console (login.tailscale.com/admin) in a browser and do two things:

1. Under DNS, switch on MagicDNS.
2. Under DNS, switch on HTTPS Certificates.

The installer needs both. Without them it stops with a message about the tailnet name.

Install Tailscale on your phone and PC too, and sign in with the same account.

### Access rules (ACL)

By default every device on your tailnet can reach everything. To let a second person reach only the dashboard, apply the example rules from the repository: `deploy/tailscale-acl.example.jsonc`. It says:

- the owner reaches every port on every machine;
- the second person reaches port 443 of machines tagged `tag:dashboard`, and nothing else.

Steps:

1. In the admin console open "Access controls".
2. Paste the contents of the example file and replace `owner@example.com` and `partner@example.com` with the real login names.
3. Tag the Futro once. On the Futro:

```
sudo tailscale up --advertise-tags=tag:dashboard
```

If you are asked for more options, repeat the ones you used before. The console may also ask you to approve the tag.

4. Save the policy. The built-in tests in the example file must pass or Tailscale refuses to save.

You can do the ACL later, when the second person is ready (see `second-person.md`).

## 5. Get the code

The code lives in `/opt/dashboard`. Log in over SSH and run:

```
sudo apt-get install -y git
sudo git clone <repository-url> /opt/dashboard
```

Replace `<repository-url>` with the address of your repository. The installer insists on running from `/opt/dashboard`.

## 6. Check the NodeSource key (once, before the first run)

The installer installs Node.js 24 from NodeSource. To be safe it only trusts NodeSource's signing key if the downloaded file holds exactly one key and that key has the fingerprint written into the script (variable `NODESOURCE_KEY_FPR` in `deploy/lib/node.sh`). The script refuses to go on otherwise. Only that one key is handed to apt.

Nobody has compared the value in the script with NodeSource's published value on a real device. Do it yourself before the first run. Show the value in the script:

```
grep NODESOURCE_KEY_FPR /opt/dashboard/deploy/lib/node.sh
```

Compare it, character by character, with the fingerprint that NodeSource publishes for its repository signing key on nodesource.com (look in their installation documentation). Do the comparison on a device you trust.

- Same: go on.
- Different: do not go on. Do not "fix" the script just to make the error go away. Find out which value is right first, and ask whoever maintains the repository.

If this goes wrong: a wrong fingerprint stops the installer with the message "NodeSource key fingerprint mismatch", and a download with more or fewer than one key stops it with "NodeSource key file holds N primary keys, expected exactly 1". It fails closed, so nothing is trusted by mistake.

## 7. Run the installer

```
sudo /opt/dashboard/deploy/install.sh
```

Run it from a real terminal (an SSH session is fine). It asks you to confirm the home network address range for the firewall, and, if the database has no enabled administrator yet, for the name and password of the first administrator (the password twice, not shown).

Flags, all optional:

| Flag | Meaning |
|---|---|
| `--no-firewall` | Do not touch the firewall. |
| `--allow-audit` | Go on even if the dependency audit reports serious findings. |
| `--yes` | Do not ask for confirmations (the firewall range). Without a terminal the first administrator is not created; the script prints the command to do it later. |
| `--rebuild` | Rebuild even if this version is already installed. |

The first run takes a while (installing packages, building). When it works it ends with a block like:

```
Dashboard is running.
  URL:        https://dashboard.tailnet-name.ts.net
```

The installer can safely be run again. A second run on an unchanged checkout is designed to change nothing (this was tested only against a fake system root, not on the device).

The firewall step, in detail:

- Run the installer in your SSH session with `sudo`. Before it switches the firewall on, `ufw.sh` finds out where your SSH session comes from and refuses if the new rules would not allow that address (allowed: the home network range, the Tailscale range, the loopback address).
- If it cannot tell where the session comes from, it refuses too, with a message saying so. Then either skip the firewall (`--no-firewall`) and run `sudo /opt/dashboard/deploy/ufw.sh --lan <your network>` afterwards, adding `--force` only if you are sure your address is covered. `install.sh` itself has no `--force` flag.
- On the console (keyboard and screen) there is no SSH session and nothing to check.
- `sudo /opt/dashboard/deploy/ufw.sh --dry-run --lan <your network>` prints the firewall rules, one per line, and changes nothing. The same holds when the installer runs in dry-run mode (`DASH_DRY_RUN=1`, a test setting you do not need): the rules are printed and the firewall is never touched.

If this goes wrong:

- The installer prints what failed. Fix that and run it again.
- If it fails after the backup step, it prints the exact commands to go back. See `update-and-rollback.md`.
- A firewall refusal does not stop the install. It is shown as a warning at the end, with the command to run later.
- The SSH hardening is skipped (with a warning) when no administrator account has a key. Add the key as in step 3 and run the installer again.

The installer also does the following, which is good to know:

- Creates the system user `dashboard`, the folders `/var/lib/dashboard` (data) and `/etc/dashboard` (settings).
- Creates `/etc/dashboard/secret.key` once and never overwrites it. Keep a copy of this file somewhere safe (see `troubleshooting.md`).
- Sets up Caddy for HTTPS and a firewall that allows port 443 and SSH only.

## 8. Sign in for the first time

On your PC, with Tailscale running, open the URL from the summary:

```
https://dashboard.tailnet-name.ts.net
```

Sign in with the administrator name and password you gave the installer. You should see your starter page.

If this goes wrong:

- Page does not load: is Tailscale on, on this PC? Run `tailscale status` on the Futro and `sudo /opt/dashboard/deploy/doctor.sh`.
- No administrator was created (you used `--yes`, or there was no terminal, or the installer could not check): the installer printed a command that starts with `sudo -u dashboard`. Run it, with your name instead of `<NAME>`; it asks for the password without showing it. The installer offers the first administrator whenever the database has no enabled administrator, so running it again also works.

## 9. Install the app on a phone

On the phone, turn on Tailscale. Open the dashboard URL in the browser.

- iPhone (Safari): Share button, then "Add to Home Screen".
- Android (Chrome): the menu, then "Install app" or "Add to Home screen".

The dashboard now starts like an app.

The exact wording differs between browser versions.

## 10. Add the second person

See `second-person.md`. Do this once the dashboard works for you.

## 11. Run doctor

`doctor` checks the box and tells you what is wrong. Run it now, and any time something seems off:

```
sudo /opt/dashboard/deploy/doctor.sh
```

Expected: one line per check, starting with OK, WARN or FAIL, and a summary line.

```
OK    Service active  ...
...
11 OK, 0 WARN, 0 FAIL
```

On a fresh install the "Last backup" line shows WARN ("no backups yet"). The installer only makes a database backup before an update, and doctor looks at the newest file ending in `.sqlite` in `/var/lib/dashboard/backups` (the backups of finished updates are renamed `.done.sqlite` and still count). This line also turns WARN again 26 hours after the last backup, until a regular backup job exists. "Security updates" may also show WARN. A WARN does not make doctor fail. All FAIL lines need action. `troubleshooting.md` explains every line.

Exit code 0 means no FAIL. Exit code 1 means at least one FAIL. Add `--json` for machine-readable output.

## 12. Afterwards

- Updating: `update-and-rollback.md`.
- Something wrong: `troubleshooting.md`.
- Copy `/etc/dashboard/secret.key` to a safe place off the box (a password manager or a USB stick). Without it, stored passwords and keys of modules cannot be recovered.

## What to expect from the Clock module

- Timers are checked every 5 seconds, so a finished timer can notify up to 5 seconds late; this is normal.
- Time and dates follow the saved language and time zone of the signed-in person (Settings, Account), not the phone's.
- A module that an administrator turned off before the last restart is set up when it is turned on again (Settings, Modules). If that fails the screen shows "Module setup failed" with the reason, and the module stays off. Fix the problem and restart the service; after the restart the module is still off, so turn it on again in Settings, Modules.

## Things this guide could not verify

These need the real device and were not checked when this was written:

- The BIOS menu name for power-on after power loss, and the boot-menu key.
- The security score of the service (`systemd-analyze security dashboard.service`; target 2.5 or lower).
- How Caddy gets its certificate from Tailscale on the Debian version you have.
- The NodeSource fingerprint (step 6).
- The SSH lock-out check of the firewall step over a real `sudo` SSH session, and the backup and rollback commands of `update-and-rollback.md`: the install scripts were checked piece by piece on another machine, not run on the Futro.
