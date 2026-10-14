# Security

PhoneBoxSound lets phones on your network control a PC, so problems here matter.

## Reporting a problem

Please do not open a public issue for a vulnerability. Use GitHub's **Report a vulnerability** button on
the repository's Security tab (private advisory). Include what you did, what happened, and the version
(Settings → Diagnostics). You will get an answer; fixes are released before details are published.

## What the design relies on

- The dashboard and API answer only the PC itself, with the dashboard password (or the API token).
- A phone is identified by a key its browser holds and cannot export; the room code and approval only
  admit a phone, they never take over an existing one.
- Every permission is enforced on the server for every message. Permissions that reach into the PC are
  off by default and withheld from phones that have not proved their key.
- Settings and the activity record are encrypted once a password is set, and a changed or swapped
  settings file stops the server from starting.

## What it does not protect against

- Someone signed in to Windows as you on an unlocked PC.
- Anyone on your Wi-Fi listening to traffic on the plain `http` link, or using the warning-free `https`
  address, whose certificate key is public by design (see the README, "Limits").
- A phone you approved and gave a permission to, using that permission.
