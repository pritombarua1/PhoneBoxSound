# PhoneBoxSound browser extension

A second hand for your browser. Windows lets PhoneBoxSound press a browser's media keys: one entry per
browser, whichever tab the browser picks, no exact seeking. This extension works inside the browser:
every tab that plays becomes its own player on your phone, with exact position, drag-to-seek, speed and
volume, and (for ordinary web video) the picture kept in step with phones used as speakers.

## One-click install needs the browser stores

Chrome, Edge and Firefox only install an extension with one click from their own store. Anything else
needs developer mode (Chrome, Edge) or disappears when the browser closes (Firefox). That is the
browsers' rule, not a missing feature, so the real one-click install is: publish it once.

```bash
npm run package:extension
```

writes `release/PhoneBoxSound-extension-chrome.zip` and `release/PhoneBoxSound-extension-firefox.zip`.

| Store | Covers | Cost | Upload |
|---|---|---|---|
| Chrome Web Store, https://chrome.google.com/webstore/devconsole | Chrome, Brave, Opera, Vivaldi (and Edge) | 5 USD once | the chrome zip |
| Microsoft Edge Add-ons, https://partner.microsoft.com/dashboard/microsoftedge | Edge | free | the chrome zip |
| Firefox Add-ons, https://addons.mozilla.org/developers | Firefox | free | the firefox zip |

Review takes from hours to a few days. When a listing is live, paste its address into PhoneBoxSound →
Settings → Player integrations → **Store links**. From then on the dashboard shows **Add to Chrome /
Firefox / Edge**, and offers it by itself whenever it sees that browser playing without the extension.

For Firefox there is a middle way without a public listing: on addons.mozilla.org choose "On your own",
upload the zip, and download the signed `.xpi`. Opening that file in Firefox installs it permanently.

### Listing text

**Name:** PhoneBoxSound: a second hand for your browser

**Short description:** Control the video or music in any tab from your phone through PhoneBoxSound on
this PC: play, pause, seek, speed, volume, for every tab separately.

**Why it needs its permissions (the stores ask):**

- *Read and change data on all websites:* to find the `<video>` / `<audio>` element on whatever site is
  playing, read its title, position and state, and carry out play, pause, seek, speed and volume. It reads
  nothing else from pages and changes nothing else.
- *Tabs:* to tell which tab a report came from, to forget a tab when it closes, and to bring a tab to the
  front when asked from the phone.
- *Storage:* its own settings (the port, and the secret it proves itself with).

**Privacy statement:** The extension sends data to exactly one place: the PhoneBoxSound program on the
same computer (address 127.0.0.1). Nothing is sent to the developer or to any server on the internet.
What it sends: for each tab that is playing media, the media title, that tab's address (so the link can
be shared from the phone), the playback
position, duration, speed, volume and whether it is paused. Tabs that play nothing are never reported.
No browsing history, no page content, no
personal data, no analytics. Remote code is not used.

## Adding it by hand

Until a store listing is live, this is how each browser takes it. There is a short video of these steps:
[`docs/media/extension-install.mp4`](../docs/media/extension-install.mp4) (or step through
[`docs/extension-install.html`](../docs/extension-install.html)).

First get the files: dashboard → Settings → Player integrations → **How to add it** → download the zip and
unzip it into a folder you will keep (the browser reads it from there every time it starts).

| Browser | Open | Then |
|---|---|---|
| Chrome | `chrome://extensions` | Developer mode on (top right) → **Load unpacked** → choose the folder |
| Edge | `edge://extensions` | Developer mode on (left side) → **Load unpacked** → choose the folder |
| Brave, Opera, Vivaldi | `brave://extensions`, `opera://extensions`, `vivaldi://extensions` | Developer mode on → **Load unpacked** → choose the folder |
| Firefox | `about:debugging` → This Firefox | **Load Temporary Add-on…** → choose `manifest.json`. It stays until Firefox closes; a signed `.xpi` (see above) installs it for good |

Last step, in every browser: go back to the dashboard and press **Approve** for the browser that appeared.

## How it is kept from being misused

- **Only this PC.** The manifest's content security policy allows connections to `ws://127.0.0.1` and
  nothing else; the code contains no internet address.
- **No password inside.** The download holds no token. The extension makes its own random id and secret,
  shows up on the PhoneBoxSound dashboard as "wants to connect", and is ignored until you press Approve.
  Later connections must present the same secret; a copy of the id alone is refused.
- **Web pages can't reach it.** A web page can open a socket to 127.0.0.1 too, so PhoneBoxSound checks
  where a connection comes from and refuses anything that is not a browser extension or a local program.
  The extension itself accepts messages only from its own scripts (`sender.id` is checked) and declares no
  external messaging.
- **A short, fixed list of orders:** play, pause, stop, seek, seek to, speed, volume, mute, bring the tab
  forward, picture delay, and "open this search result", which the extension itself only follows to a
  fixed list of services (YouTube, Apple Music, Spotify, Netflix, Prime Video, Disney+, Twitch,
  SoundCloud) over https. Values are converted to numbers. Nothing received is run as code or put into a
  page; there is no `eval`, no `innerHTML`, no remote script. The project's tests check this.
- **What a rogue local program could do** if it pretended to be an extension and you approved it: list
  made-up "tabs" under Now Playing. It gets no control over the PC and no data from it.

## Picture in step with the phones

Phones play the PC's sound later by the sync buffer. A page's sound can't be made earlier, but its
picture can be shown later: each frame is copied and painted over the video after the same delay.
This works for ordinary web video. Copy-protected films (Netflix, Prime Video, Disney+ and similar) do
not let any program copy their frames; there the video is left untouched.
