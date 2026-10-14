"""npm run package:extension  ->  release/PhoneBoxSound-extension-chrome.zip and -firefox.zip

The two files to upload to the Chrome Web Store / Edge Add-ons and to addons.mozilla.org.
See extension/README.md for the steps and the listing text."""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from phoneboxsound import extpack  # noqa: E402

os.makedirs(os.path.join(ROOT, "release"), exist_ok=True)
for browser in extpack.BROWSERS:
    out = os.path.join(ROOT, "release", f"PhoneBoxSound-extension-{browser}.zip")
    with open(out, "wb") as f:
        f.write(extpack.zipped(os.path.join(ROOT, "extension"), browser))
    print(out, os.path.getsize(out), "bytes")
