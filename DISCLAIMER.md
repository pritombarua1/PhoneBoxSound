# Disclaimer and terms of use

PhoneBoxSound is free, open-source software by Pritom Barua, published under the
[GNU General Public License v3](LICENSE) (see [NOTICE.md](NOTICE.md)). By installing,
running, copying, changing or sharing it, you accept the following.

## No warranty, no liability

The software is provided **"as is"**, without warranty of any kind, express or implied, including but not
limited to the warranties of merchantability, fitness for a particular purpose and non-infringement.

In no event shall the authors, contributors or copyright holders be liable for any claim, damages, loss of
data, loss of income, hardware damage, hearing damage or other liability, whether in an action of contract,
tort or otherwise, arising from, out of or in connection with the software or the use of it or other
dealings in it. You use it entirely at your own risk.

## Your responsibility

PhoneBoxSound can give a phone control over the computer it runs on: the pointer and keyboard, the
clipboard, the screen, files in one folder, power (lock, sleep, restart, shut down) and commands you define.
You alone decide which phones get which of these abilities, and you alone are responsible for:

- using it only on computers, networks and devices that you own or are clearly allowed to use;
- the people you let connect, and what they do with what you allowed them;
- keeping your PC, your Wi-Fi and the dashboard password secure;
- the volume you play at, and the people and neighbours who hear it;
- following the laws where you live, including laws on privacy, recording, and remote access to computers;
- the terms of the services you use through it (for example Spotify, YouTube, Apple Music, streaming sites).

**Using PhoneBoxSound, or any part or copy of its code, to harm, spy on, harass, defraud or gain access to
other people's devices, accounts or data without their permission is forbidden.** The authors and
contributors do not support, encourage or take part in any such use, and are not responsible for it, for
modified copies made by others, or for any consequence of how anyone uses this software.

## What gets downloaded, and whose terms apply

PhoneBoxSound itself sends nothing to its authors and has no account, cloud service or analytics. To run
from the source code, `start.bat` may download these from their official publishers, once, after you agree
on its first screen:

| What | From | Licence / terms |
|---|---|---|
| Python 3.13 (if missing) | winget (Microsoft's package installer), or python.org directly | Python Software Foundation License; with winget also the winget source agreement |
| Python packages listed in `requirements.txt` | PyPI (pypi.org) | each package's own open-source licence |
| Node.js 22 LTS, portable, inside this folder (only if the web app is not built yet) | nodejs.org | MIT and the licences listed in its package |
| JavaScript packages listed in `package.json` | npmjs.com | each package's own open-source licence |

When winget is used, `start.bat` passes `--accept-source-agreements --accept-package-agreements`, which
accepts those agreements on your behalf: that is what you agree to on its first screen. The ready-made
Windows download (`PhoneBoxSound-win64.zip` on the Releases page) needs none of these downloads.

Optional features use third-party services only when you switch them on: the Spotify Web API (your own
Spotify app and account), the YouTube Data API (your own key), the iTunes Search API, and the free
local-ip.sh certificate for the warning-free https address. Their own terms apply.

PhoneBoxSound is not affiliated with, endorsed by or sponsored by Microsoft, Google, YouTube, Spotify,
Apple, Mozilla, VideoLAN or any other company or product it mentions. Names are used only to say what it
works with.
