# Adding a second person

The second person gets their own account, sees only the modules you grant, and can reach the dashboard and nothing else on your tailnet.

The admin screens are part of the web app, which is still being finished. Names of buttons below may differ a little. The steps themselves do not change.

## 1. Let their device reach the dashboard (Tailscale)

The second person needs a Tailscale login of their own, on the same tailnet, or the Futro shared with them. Then restrict what they can reach to port 443 of the dashboard machine, using the second rule in `deploy/tailscale-acl.example.jsonc`:

```
{"action": "accept", "src": ["group:second-person"], "dst": ["tag:dashboard:443"]},
```

How to apply it is in `setup-guide.md`, section "Access rules (ACL)". The Futro must carry the tag `tag:dashboard`. Check it from the Futro:

```
tailscale status
```

The example file contains tests. They state that the second person may reach port 443 but not port 22 (SSH) or 8787.

After saving, ask the second person to try opening the dashboard address. SSH to the Futro from their device must time out.

If this goes wrong: if they cannot reach the dashboard, check that the group has their exact login name, and that the Futro really has the tag.

## 2. Create their user

Sign in as administrator, open the user administration, and add a user with the role "member". Give a name and a first password (at least the minimum length the screen asks for). Tell them the password in person and ask them to change it after signing in.

Alternative from the Futro, if the screen is not available. It creates the account on the running system; restart the service afterwards (see `troubleshooting.md`):

```
sudo -u dashboard sh -c 'set -a; . /etc/dashboard/env; set +a; exec node /opt/dashboard/apps/server/dist/cli.js user:create --name Anna --role member'
```

You are asked for the password without it showing. The command prints the new user id. Use their real name instead of `Anna`.

## 3. Grant module levels

A member sees nothing until you give access. For each module there are three levels: none, view, edit.

- none: the module is hidden.
- view: they can see the tiles and data.
- edit: they can also change things.

Administrators always have edit on everything. In the user administration, open the access (grants) screen, find the person and set a level per module. A module that only offers "view" cannot be given "edit".

Changes take effect for sessions already open.

## 4. Install the app on their phone

They turn on Tailscale on the phone, open the dashboard address in the browser, sign in, then:

- iPhone (Safari): Share, then "Add to Home Screen".
- Android (Chrome): menu, then "Install app" or "Add to Home screen".

## 5. Two-factor sign-in (optional)

Each person can switch on a one-time code (authenticator app) in their own account settings. If they lose the phone, an administrator can reset it, see `troubleshooting.md`.

## 6. App passwords for calendar apps

Available once CalDAV ships. The CalDAV calendar feature arrives in a later release; until then there is nothing to connect.

The screen is already prepared. In their own account settings a person can create an "app password" with a label (for example "Phone calendar"). The password is shown once, so they must copy it right away. A calendar app uses their user name and this app password instead of the real password. The person can delete an app password at any time; the calendar app then loses access. App passwords are dropped when an administrator changes the person's role or disables them.

Steps for the phone calendar, once CalDAV ships, will be added here.
