"""Settings live in config.json next to the app. Environment variables override the server basics:

  PHONEBOXSOUND_PORT, PHONEBOXSOUND_HTTPS_PORT, PHONEBOXSOUND_BUFFER_MS, PHONEBOXSOUND_API_TOKEN
"""
import copy
import json
import logging
import os
import secrets
import threading

log = logging.getLogger("pbs.config")

DEFAULT_SCENES = [
    {"id": "music", "name": "Music", "icon": "music", "desc": "All phones stereo, auto buffer",
     "set": {"auto_latency": True, "layout": "stereo", "eq": "flat", "master": 1.0, "source": "system"}},
    {"id": "movie", "name": "Movie", "icon": "film", "desc": "Left/right split, clearer dialogue",
     "set": {"auto_latency": True, "layout": "split", "eq": "clear", "master": 1.0, "source": "system", "mute_pc": True}},
    {"id": "party", "name": "Party", "icon": "party", "desc": "Every phone loud and mono",
     "set": {"auto_latency": True, "layout": "mono", "eq": "loud", "master": 1.2, "source": "system"}},
    {"id": "night", "name": "Night", "icon": "moon", "desc": "Quiet, compressed, easy on neighbours",
     "set": {"layout": "mono", "eq": "loud", "master": 0.4}},
    {"id": "synctest", "name": "Sync test", "icon": "pulse", "desc": "Click track to line phones up",
     "set": {"source": "clicks", "layout": "mono", "eq": "flat"}},
]

DEFAULTS = {
    "port": 8080,
    "https_port": 8443,
    "latency_ms": 250,
    "auto_latency": True,
    "min_latency_ms": 80,
    "max_latency_ms": 450,
    "master": 1.0,
    "streaming": True,
    "source": "system",
    "device": None,
    "theme": "forest",
    "mode": "dark",
    "duck_level": 0.25,
    "lip_sync": True,
    "pc_out": {"enabled": False, "device": None, "offset_ms": 0, "volume": 1.0},   # the PC's own output, delayed to match the phones
    "activity": True,         # keep the two-day record of what each phone does
    "terms_accepted": "",     # the version of DISCLAIMER.md accepted on the first start ("" = not yet)
    "auto_keyboard": True,    # tell a phone when the PC's pointer is on a text box, so its keyboard can open by itself
    "auto_quality": True,     # a phone whose connection turns poor gets the lighter stream until it recovers
    "browser_delay": True,    # with the browser extension: show the picture later, to match the phones
    "search": {"youtube_key": "", "spotify_id": "", "spotify_secret": ""},   # optional keys for search results
    "spotify": {"refresh": "", "access": "", "exp": 0, "name": ""},   # the linked Spotify account's tokens
    "browsers": {},           # approved browser extensions: id -> {"name", "hash", "approved", "added"}
    "extension_urls": {"chrome": "", "firefox": "", "edge": ""},   # store pages, once the extension is published
    "mdns": True,
    "https": True,
    "api_token": None,
    "webhooks": [],
    "blocked_ips": [],
    "approval": True,      # a new phone waits until the PC (or a phone allowed to) approves it
    "lockdown": False,     # emergency switch: no phone controls the PC, no new phone pairs, no remote API
    "strict": True,        # PC-control permissions only work for phones that proved their own key
    "public_https": True,  # warning-free https through local-ip.sh (see tls.py)
    "security_log": [],    # 30 days of security events, for the digest
    "commands": [],        # [{"id", "name", "run"}]: only ever defined on the PC, phones can just press them
    "share_dir": None,     # folder for file transfer (default: Downloads/PhoneBoxSound)
    "zones": {"Living Room": {"volume": 1.0, "muted": False}},
    "scenes": DEFAULT_SCENES,
    "devices": {},
    "vlc": {"enabled": False, "port": 8081, "password": ""},
    "mpv": {"enabled": False, "pipe": r"\\.\pipe\mpvsocket"},
}

DEFAULT_DEVICE = {
    "name": "Phone", "volume": 1.0, "channel": "stereo", "offset_ms": 0, "muted": False,
    "zone": "Living Room", "eq": "flat", "speaker": True,
    # Anything that reads or controls the PC itself is off until you enable it for that phone.
    "perms": {"speaker": True, "remote": True, "intercom": True, "input": False, "clipboard": False, "screen": False, "power": False, "manage": False,
              "files": False, "commands": False, "host": False, "approve": False, "panic": False, "search": False},
    "token_hash": None, "platform": "", "last_seen": 0, "last_ip": None, "order": 0,
    "blocked": False, "quality": "full", "pubkey": None,
    "approved": True, "first_seen": 0, "forgotten": 0,
    "guest_until": 0,   # a guest pass: speaker only, removed at this time
    "system": "", "system_note": "", "system_was": "",   # what it reports to be; your own label; set while a change awaits confirmation
}


class Config:
    def __init__(self, path, vault=None, data=None):
        """`vault` + `data`: the settings were read from the encrypted vault (see vault.py) and every
        save goes back into it; otherwise they live in the plain file at `path`."""
        self.path = path
        self.vault = vault
        self.data = copy.deepcopy(DEFAULTS)
        self._lock = threading.Lock()
        try:
            if data is not None:
                self.data.update(data)
            else:
                with open(path, encoding="utf-8") as f:
                    loaded = json.load(f)
                self.data.update(loaded)
        except FileNotFoundError:
            pass
        except (OSError, ValueError) as e:
            log.warning("config.json unreadable (%s); using defaults", e)
            try:
                os.replace(path, path + ".broken")
            except OSError:
                pass
        for k, v in DEFAULTS.items():
            self.data.setdefault(k, copy.deepcopy(v))
        if self.data.get("max_latency_ms") == 1200:  # old default: far too much delay for watching video
            self.data["max_latency_ms"] = 450
            self.data["latency_ms"] = min(self.data["latency_ms"], 450)
        for dev in self.data["devices"].values():
            for k, v in DEFAULT_DEVICE.items():
                dev.setdefault(k, copy.deepcopy(v))
            for k, v in DEFAULT_DEVICE["perms"].items():
                dev["perms"].setdefault(k, v)
        env = os.environ
        if env.get("PHONEBOXSOUND_PORT"):
            self.data["port"] = int(env["PHONEBOXSOUND_PORT"])
        if env.get("PHONEBOXSOUND_HTTPS_PORT"):
            self.data["https_port"] = int(env["PHONEBOXSOUND_HTTPS_PORT"])
        if env.get("PHONEBOXSOUND_BUFFER_MS"):
            self.data["latency_ms"] = int(env["PHONEBOXSOUND_BUFFER_MS"])
            self.data["auto_latency"] = False
        if env.get("PHONEBOXSOUND_API_TOKEN"):
            self.data["api_token"] = env["PHONEBOXSOUND_API_TOKEN"]
        if not self.data.get("api_token"):
            self.data["api_token"] = secrets.token_urlsafe(18)
        self.save()

    def __getitem__(self, k):
        return self.data[k]

    def __setitem__(self, k, v):
        self.data[k] = v

    def get(self, k, default=None):
        return self.data.get(k, default)

    def setdefault(self, k, v):
        return self.data.setdefault(k, v)

    def device(self, device_id):
        dev = self.data["devices"].get(device_id)
        if dev is None:
            dev = copy.deepcopy(DEFAULT_DEVICE)
            dev["order"] = len(self.data["devices"])
            self.data["devices"][device_id] = dev
        return dev

    @property
    def protected(self):
        return bool(self.vault and self.vault.key)

    def protect(self, password, autostart=True):
        """Move everything into the encrypted vault and remove the readable file."""
        self.vault.create(password, self.data, autostart)
        for p in (self.path, self.path + ".tmp", self.path + ".broken"):
            try:
                size = os.path.getsize(p)
                with open(p, "r+b") as f:      # best effort: don't leave the old contents lying in the file
                    f.write(b"\0" * size)
                os.remove(p)
            except OSError:
                pass

    def save(self):
        if self.protected:
            try:
                self.vault.save(self.data)
            except Exception as e:
                log.warning("could not save the protected settings: %s", e)
            return
        if self.vault is not None and self.vault.exists:
            return  # locked vault: never fall back to writing a readable copy
        with self._lock:
            tmp = self.path + ".tmp"
            try:
                with open(tmp, "w", encoding="utf-8") as f:
                    json.dump(self.data, f, indent=2)
                os.replace(tmp, self.path)  # atomic: never leaves a half-written config
            except OSError as e:
                log.warning("could not save config: %s", e)
