"""Builds the browser extension for a given browser: the files in extension/, the right manifest for
that browser's store, icons in the current theme, and this PC's port (never a secret: the extension is
approved on the dashboard instead)."""
import io
import json
import os
import zipfile

from . import branding

BROWSERS = ("chrome", "firefox")      # "chrome" also covers Edge, Brave, Opera, Vivaldi


def manifest(source, browser):
    m = json.loads(source)
    if browser == "firefox":
        m["background"] = {"scripts": m["background"]["scripts"]}
    else:
        m["background"] = {"service_worker": m["background"]["service_worker"]}
        m.pop("browser_specific_settings", None)
    return m


def files(folder, browser="chrome", port=8080, theme="forest"):
    """{name: bytes} for one browser."""
    out = {}
    for f in sorted(os.listdir(folder)):
        path = os.path.join(folder, f)
        if f.startswith(".") or f.endswith(".md") or f in ("config.js",) or not os.path.isfile(path):
            continue
        with open(path, "rb") as h:
            out[f] = h.read()
    out["manifest.json"] = json.dumps(manifest(out["manifest.json"].decode(), browser), indent=2).encode()
    out["config.js"] = ("// Where PhoneBoxSound listens on this PC. Changed by itself when you open the dashboard.\n"
                        f"self.PBS = {json.dumps({'port': int(port)})};\n").encode()
    for size in (16, 32, 48, 128):
        out[f"icon-{size}.png"] = branding.icon_png(branding.valid(theme), size)
    return out


def zipped(folder, browser="chrome", port=8080, theme="forest"):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in files(folder, browser, port, theme).items():
            z.writestr(name, data)
    return buf.getvalue()
