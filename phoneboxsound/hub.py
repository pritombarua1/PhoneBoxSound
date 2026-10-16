"""The hub: connected devices, pairing, routing of program audio / intercom / remote commands."""
import asyncio
import copy
import collections
import hashlib
import json
import logging
import os
import secrets
import time

import numpy as np

from . import identity, inputctl, system
from .audio import HEADER, KIND_HOST, KIND_INTERCOM, KIND_PROGRAM, SOURCES, Spectrum, now_ms, pack

log = logging.getLogger("pbs.hub")

CHANNEL_MODES = ("stereo", "left", "right", "mono", "sub", "rear")  # sub = bass only, rear = the L-R ambience
PERMS = ("search", "speaker", "remote", "intercom", "input", "clipboard", "screen", "power", "manage", "files", "commands", "host", "approve", "panic")
# What a phone with the "manage" permission may change about the whole setup (never permissions or pairing).
MANAGE_DEVICE_KEYS = ("name", "volume", "channel", "offset_ms", "muted", "eq", "zone", "speaker")


def clean_name(value):
    """A device name as people typed it, minus control characters, at most 32 characters."""
    return "".join(ch for ch in str(value or "") if ch.isprintable()).strip()[:32]
MANAGE_GLOBAL_KEYS = ("master", "latency_ms", "auto_latency", "streaming")
# Permissions that reach into the PC itself. In strict mode they only work for a phone that has proved
# its identity with its own key (see identity.py); a copied token or a spoofed address is not enough.
ELEVATED = ("input", "clipboard", "screen", "power", "manage", "files", "commands", "host", "approve", "panic")
AUDIO_QUEUE = 45  # packets (450 ms): the most audio one phone may have waiting on the server
KIND_SCREEN = 2
EQ_MODES = ("flat", "clear", "loud", "bass")
THEMES = ("midnight", "aurora", "forest", "sand", "ocean")
MODES = ("dark", "light", "auto")


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def hash_token(t):
    return hashlib.sha256(t.encode()).hexdigest()


class Client:
    """One connected phone (or browser acting as a speaker/remote)."""

    def __init__(self, ws, device_id, dev, ip, secure, cfg=None, verified=False):
        self.cfg = cfg
        self.verified = verified   # proved possession of this phone's private key on this connection
        self.pending_pub = None    # a key waiting for approval on the PC
        self.can_sign = False      # the phone's browser is able to hold a key (secure page)
        self.id = secrets.token_hex(4)
        self.ws = ws
        self.device_id = device_id
        self.dev = dev  # persistent record in config (settings, perms, name...)
        self.ip = ip
        self.secure = secure
        self.stats = {}
        self.joined = time.time()
        self.last_msg = time.time()
        # Three queues, sent in this order:
        #   outbox - commands and state: never dropped, always first
        #   audio  - bounded. A phone that falls behind gets the *newest* audio; packets older than
        #            the sync buffer could only arrive too late to be played anyway.
        #   frame  - the latest screen-view picture only (older ones are replaced, not queued)
        self.outbox = collections.deque()
        self.audio = collections.deque(maxlen=AUDIO_QUEUE)
        self.frame = None
        self.wake = asyncio.Event()
        self.audio_drops = 0
        self.screen_mode = None
        self.screen_task = None
        self.clip_live = False
        self.manage_live = False
        self.screen_zoom = 3.0
        self.file_token = secrets.token_urlsafe(18)  # lets this phone use the file-transfer URLs
        self.screen_key = secrets.token_urlsafe(18)  # lets this phone open the separate connection for screen pictures
        self.screen_ws = None
        self.screen_ack = asyncio.Event()
        self.screen_strain = 0.0     # when the phone last said its sound was arriving with too little time to spare
        self.screen_video = False    # this phone can play the screen as video (WebCodecs H.264)
        self.screen_acks = 0         # video frames the phone has shown
        self.screen_need_key = False # the phone's decoder lost track: start the video again from a full frame
        self.screen_ms = None
        self.link_since = (None, time.time())        # (level, since when)
        self.auto_saver = False
        self.clip_image = None                       # last clipboard picture sent to this phone, for a real download link
        self.sender = asyncio.create_task(self._send_loop())

    journal = None       # set by the hub: the two-day activity record (journal.py)
    tx = 0               # running number of messages sent to this phone (it reports the last one it received)
    rx_n = None          # the phone's running number of the last message we received from it
    rx_gaps_seen = 0
    outcome = None       # why the message being handled was not carried out (None = it was)
    _media_logged = None
    _cfg_logged = None
    _stats_logged = (None, 0)

    def send(self, data, audio=False, urgent=False):
        if audio:
            if len(self.audio) == self.audio.maxlen:
                self.audio_drops += 1  # deque(maxlen) discards the oldest packet
            self.audio.append(data)
        else:
            (self.outbox.appendleft if urgent else self.outbox.append)(data)
        self.wake.set()

    def send_frame(self, data):
        self.frame = data
        self.wake.set()

    def send_json(self, obj, urgent=False):
        self.tx += 1
        self.send(json.dumps({**obj, "#": self.tx}), urgent=urgent)  # "#": this message's running number (a name no message of ours uses)
        if self.journal:
            kind, j = obj.get("t"), self.journal
            if kind == "pong":
                j.count(self.device_id, "pong_out")
            elif kind == "media":
                # "what's playing" is re-sent constantly with a new position: recorded when it changes
                a = obj.get("active") or {}
                sig = (a.get("id"), a.get("title"), a.get("state"), a.get("rate"), a.get("duration"))
                if sig != self._media_logged:
                    self._media_logged = sig
                    j.write(self.device_id, "out", kind, {"active": {k: a.get(k) for k in ("app", "title", "artist", "state", "position", "duration", "rate")} if a else None}, s=self.tx)
                else:
                    j.count(self.device_id, "media_out")
            elif kind == "config":
                # recorded as what changed since the last time this phone was sent its settings
                before = self._cfg_logged or {}
                changed = {k: v for k, v in obj.items() if k != "t" and before.get(k) != v}
                self._cfg_logged = dict(obj)
                if changed:
                    j.write(self.device_id, "out", kind, {**changed, "first": True} if not before else changed, s=self.tx)
                else:
                    j.count(self.device_id, "config_out")
            elif kind in ("studio", "targets"):
                j.count(self.device_id, kind + "_out")
            else:
                j.write(self.device_id, "out", kind, obj, s=self.tx)

    async def _send_loop(self):
        try:
            while True:
                await self.wake.wait()
                self.wake.clear()
                while self.outbox or self.audio or self.frame:
                    if self.outbox:
                        m = self.outbox.popleft()
                    elif self.audio:
                        m = self.audio.popleft()
                    else:
                        m, self.frame = self.frame, None
                    if isinstance(m, bytes):
                        await self.ws.send_bytes(m)
                        if self.journal:
                            self.journal.count(self.device_id, ("audio_out", "intercom_out", "screen_out", "audio_out")[m[0] & 3] if m else "audio_out", len(m))
                    else:
                        await self.ws.send_str(m)
        except (ConnectionError, RuntimeError, asyncio.CancelledError):
            pass
        except Exception as e:
            log.debug("send loop ended: %s", e)

    @property
    def perms(self):
        p = self.dev["perms"]
        if self.dev.get("guest_until"):
            return {k: (k == "speaker" and v) for k, v in p.items()}
        if (self.cfg and self.cfg.get("lockdown")) or self.dev.get("system_was"):
            return {k: (v and k not in ELEVATED) for k, v in p.items()}
        if self.verified or not (self.cfg and self.cfg.get("strict")):
            return p
        return {k: (v and k not in ELEVATED) for k, v in p.items()}

    def locked(self):
        """Permissions this phone was given but can't use until it is verified (or lockdown ends)."""
        if (self.cfg and self.cfg.get("lockdown")) or self.dev.get("system_was"):
            return [k for k in ELEVATED if self.dev["perms"].get(k)]
        if self.verified or not (self.cfg and self.cfg.get("strict")):
            return []
        return [k for k in ELEVATED if self.dev["perms"].get(k)]

    def link(self):
        """This phone's connection to the PC, from what it measures itself: round trip of the clock pings,
        how unevenly the sound packets arrive, and how many came too late to play. A browser may not
        read the Wi-Fi signal strength, but these are what a weak signal does to the sound."""
        s = self.stats
        rtt, jitter, late = s.get("rtt_ms"), s.get("jitter_ms") or 0, s.get("late_recent") or 0
        if rtt is None or time.time() - self.last_msg > 6:
            return "unknown"
        if self.screen_mode:
            # pictures share the air while the screen is shown, which makes packets arrive unevenly by design
            # (the sound goes first, the pictures wait). Judge by what can be heard: sound arriving too late.
            if late > 3 or s.get("far"):
                return "poor"
            return "weak" if late > 0 else "good"
        if rtt > 150 or jitter > 70 or late > 3 or s.get("far"):
            return "poor"
        if rtt > 60 or jitter > 35 or late > 0:
            return "weak"
        return "excellent" if rtt < 15 and jitter < 12 else "good"

    def health(self):
        s = self.stats
        idle = time.time() - self.last_msg
        if idle > 6:
            return "unresponsive"
        if not self.dev["speaker"] or not self.perms["speaker"]:
            return "remote"
        if s.get("state") == "suspended":
            return "suspended"
        recent_late = s.get("late_recent", 0)
        if not s.get("played"):
            return "starting"
        if recent_late > 3:
            return "buffering"
        if s.get("jitter_ms", 0) > 40 or recent_late:
            return "jitter"
        return "stable"


class Hub:
    def __init__(self, cfg, capture, media, ports, desktop=None):
        from .desktop import Desktop
        self.desktop = desktop or Desktop()
        self.input_log = collections.deque(maxlen=2000) if self.desktop.demo else None  # demo: record instead of inject
        self.clip_seq = self.desktop.clipboard_seq()
        self.power_pending = None  # {"action", "by", "at", "task"}: a power action counting down
        self.host = None           # the phone currently hosting music for everyone
        self.host_prev_source = None
        self.cfg = cfg
        self.capture = capture
        self.media = media
        self.ports = ports  # {"http": 8080, "https": 8443 or None}
        self.code = self._new_code()
        self.clients = {}  # client id -> Client
        self.controls = set()
        self.spectrum = Spectrum()
        self.peak = [0.0, 0.0]
        self.sample_rate = None
        self.seq = 0
        self.ips = ["127.0.0.1"]
        self.mdns_ok = False
        self.fails = collections.defaultdict(list)  # ip -> recent failed pairing timestamps
        self.handoffs = {}  # one-time token -> (device_id, expires)
        self.journal = None  # journal.Journal, set at start-up
        self.pcout = None    # pcout.PcOut, set at start-up
        self.video = None    # video.Video, set at start-up: screen view as video
        self.textfocus = self.desktop if hasattr(self.desktop, "over") else None    # textfocus.TextFocus on a real PC (set at start-up)
        from .search import Search
        from .spotify import Spotify
        self.search = Search(cfg, demo=False)   # app.py switches it to demo answers in demo mode
        self.spotify = Spotify(cfg)
        self.spotify.thumb = self._thumb
        self.search.spotify = self.spotify
        self._jobs, self._seeked = {}, {}
        if hasattr(media, "overlay"):
            media.overlay = self.overlay
        from .extras import Extras
        self.extras = Extras(self)
        self.waiting = {}   # device_id -> phone that joined with the code and waits to be approved
        self.talkers = {}  # talker key -> {"name", "target", "since"}
        self.calib = None
        self.events = collections.deque(maxlen=60)  # activity feed for the dashboard
        self.latency_changed_at = 0
        self.webhook_session = None
        self.last_default_dev = None
        self.audio_started = time.time()
        media.on_change = self.on_media

    # ------------------------------------------------------------ helpers --

    @staticmethod
    def _new_code():
        return f"{secrets.randbelow(10000):04d}"

    def event(self, kind, text, **data):
        self.events.appendleft({"t": time.time(), "kind": kind, "text": text})
        self.extras.remember(kind, text)
        self.fire_webhook(kind, data | {"text": text})

    def fire_webhook(self, event, data):
        urls = self.cfg.get("webhooks") or []
        if not urls:
            return

        async def post():
            import aiohttp
            if self.webhook_session is None:
                self.webhook_session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=3))
            for url in urls:
                try:
                    await self.webhook_session.post(url, json={"event": event, "time": time.time(), **data})
                except Exception as e:
                    log.debug("webhook %s failed: %s", url, e)
        asyncio.ensure_future(post())

    def online(self, device_id):
        return next((c for c in self.clients.values() if c.device_id == device_id), None)

    def zone_of(self, dev):
        zones = self.cfg["zones"]
        return zones.get(dev.get("zone")) or {"volume": 1.0, "muted": False}

    def device_config(self, c):
        dev, zone = c.dev, self.zone_of(c.dev)
        speaking = bool(self.talkers)
        return {
            "t": "config", "device_id": c.device_id, "name": dev["name"],
            "latency_ms": self.cfg["latency_ms"], "streaming": self.cfg["streaming"],
            "gain": 0 if (dev["muted"] or zone["muted"]) else round(self.cfg["master"] * zone["volume"] * dev["volume"] * self.extras.fade, 4),
            "bedtime": self.extras.bedtime_state(), "guest_until": dev.get("guest_until") or 0,
            "screen_key": c.screen_key if c.perms.get("screen") else None,
            "link": c.link(), "link_weak_s": round(time.time() - c.link_since[1]) if c.link_since[0] in ("weak", "poor") else 0,
            "on_hotspot": c.ip.startswith("192.168.137."), "auto_saver": c.auto_saver,
            "volume": dev["volume"], "muted": dev["muted"], "channel": dev["channel"], "offset_ms": dev["offset_ms"],
            "eq": dev["eq"], "speaker": dev["speaker"] and dev["perms"]["speaker"], "speaker_pref": dev["speaker"],
            "perms": c.perms, "zone": dev["zone"], "theme": self.cfg["theme"], "mode": self.cfg["mode"],
            "verified": c.verified, "locked": c.locked(), "can_sign": c.can_sign, "lockdown": bool(self.cfg["lockdown"]),
            "verify_code": identity.code(c.pending_pub) if c.pending_pub else None,
            "duck": self.cfg["duck_level"] if speaking else 1.0,
            "index": sorted(self.cfg["devices"], key=lambda k: self.cfg["devices"][k]["order"]).index(c.device_id) + 1,
            "https_url": self.https_url(), "secure": c.secure, "screen": list(inputctl.screen_size()),
            "file_token": c.file_token if c.perms.get("files") else None,
            "record": bool(self.cfg.get("activity", True)),     # off: the phone doesn't report taps or its screen either
            "commands": [{"id": x["id"], "name": x["name"]} for x in self.cfg["commands"]] if c.perms.get("commands") else [],
            "hosting": self.host.dev["name"] if self.host else None,
            "pending": self.pending_rows() if c.perms.get("approve") else [],
        }

    def note(self, device_id, kind, data=None, d="sys"):
        """Add a line to this phone's activity record."""
        if self.journal:
            self.journal.write(device_id, d, kind, data)

    def record(self, c, kind, m, t0, n):
        """One line in the phone's record for a message it sent, with what became of it."""
        j = self.journal
        if not j:
            return
        if kind == "stats":
            missed = int(m.get("rx_gaps") or 0)
            pending, c._gap_pending = getattr(c, "_gap_pending", 0), missed
            if missed > c.rx_gaps_seen and missed == pending:      # still missing a second later: not just overtaken
                self.note(c.device_id, "mismatch", {"missed": missed - c.rx_gaps_seen, "what": "messages from the PC did not reach the phone"})
                c.rx_gaps_seen = missed
            sig = tuple(m.get(k) for k in ("late", "resyncs", "gaps", "far", "state", "hidden", "rx_gaps", "clock_jumps"))
            if sig == c._stats_logged[0] and t0 - c._stats_logged[1] < 10:
                j.count(c.device_id, "stats_in")
                return
            c._stats_logged = (sig, t0)
            j.write(c.device_id, "in", kind, {k: m.get(k) for k in ("ahead_ms", "late", "late_recent", "resyncs", "rtt_ms", "jitter_ms", "hidden", "battery", "rx", "rx_gaps") if m.get(k) is not None}, t=t0, n=n)
        elif kind in ("ui", "snap"):
            if len(str(m.get("mid", ""))) < 400_000:
                j.write(c.device_id, "in", kind, m, t=t0, n=n)
        else:
            j.write(c.device_id, "in", kind, m, t=t0, n=n, r=0 if c.outcome else 1, why=c.outcome)

    def push_config(self, clients=None):
        for c in clients or list(self.clients.values()):
            self.enforce(c)
            c.send_json(self.device_config(c))

    def enforce(self, c):
        """Stop anything this phone is doing right now that it is no longer allowed to do."""
        p = c.perms
        if c.screen_mode and not p.get("screen"):
            c.screen_mode = None
        if not p.get("clipboard"):
            c.clip_live = False
        if not p.get("manage"):
            c.manage_live = False
        if self.host is c and not p.get("host"):
            asyncio.ensure_future(self.host_stop(c))

    def denied(self, c, what):
        """A phone asked for something it has no permission for. The official app never does that more
        than now and then, so a burst means someone is poking at the server by hand: cut it off."""
        now = time.time()
        c.denials = [t for t in getattr(c, "denials", []) if now - t < 60] + [now]
        c.outcome = f"no permission for {what}"
        if len(c.denials) == 1:
            self.event("security", f"{c.dev['name']} tried to use {what} without permission")
        if len(c.denials) >= 15:
            self.event("security", f"{c.dev['name']} was disconnected after repeated attempts without permission")
            asyncio.ensure_future(c.ws.close())
            return
        c.send_json({"t": "toast", "msg": "Not allowed. Enable it for this phone in the PC dashboard."})

    async def rename(self, device_id, name):
        """One place for every rename (dashboard, the phone itself, a managing phone, the API)."""
        dev, name = self.cfg["devices"].get(device_id), clean_name(name)
        if not dev or not name or dev["name"] == name:
            return
        self.event("device", f"{dev['name']} is now called {name}")
        dev["name"] = name
        self.cfg.save()
        for talk in self.talkers.values():
            if talk.get("device_id") == device_id:
                talk["name"] = name
        if self.host and self.host.device_id == device_id:
            self.capture.host_name = name
        self.push_config()                      # the phone itself, and "X is hosting" on the others
        self.broadcast_targets()
        info = {"t": "intercom", "talkers": [{"name": v["name"], "target": v["target"], "device_id": v.get("device_id")}
                                             for v in self.talkers.values()]}
        for c in self.clients.values():
            c.send_json(info)
        self.push_studio()
        await self.broadcast_state()

    def https_url(self):
        """The best secure address: the warning-free name on the main port when available."""
        if getattr(self, "public_https", False):
            from .tls import public_host
            return f"https://{public_host(self.ips[0])}:{self.ports['http']}"
        if not self.ports.get("https"):
            return None
        return f"https://{self.ips[0]}:{self.ports['https']}"

    def http_url(self, ip=None):
        return f"http://{ip or self.ips[0]}:{self.ports['http']}"

    # ------------------------------------------------------------- audio ---

    def on_audio(self, ts, sr, stereo):
        self.sample_rate = sr
        l, r = stereo[:, 0], stereo[:, 1]
        self.peak[0] = max(self.peak[0], max(int(l.max()), -int(l.min())) / 32768)
        self.peak[1] = max(self.peak[1], max(int(r.max()), -int(r.min())) / 32768)
        self.spectrum.push(stereo, sr)
        if not self.cfg["streaming"]:
            return
        self.seq += 1
        packet = pack(KIND_PROGRAM, self.seq, ts, sr, stereo)
        saver = None
        for c in self.clients.values():
            if c.dev["speaker"] and c.perms["speaker"]:
                if c.dev.get("quality") == "saver" or c.auto_saver:
                    if saver is None:  # half the sample rate = half the data; built once, only if someone wants it
                        n = len(stereo) // 2 * 2
                        half = ((stereo[0:n:2].astype(np.int32) + stereo[1:n:2]) // 2).astype(np.int16)
                        saver = pack(KIND_PROGRAM, self.seq, ts, sr // 2, half)
                    c.send(saver, audio=True)
                else:
                    c.send(packet, audio=True)

    # ------------------------------------------------------- a phone hosting the music

    def on_host_audio(self, c, data):
        if self.host is not c or len(data) < HEADER.size:
            return
        kind, ch, frames, _seq, _ts, sr, _flags = HEADER.unpack_from(data)
        if kind != KIND_HOST or ch != 2 or not (8000 <= sr <= 48000) or len(data) != HEADER.size + frames * 4:
            return
        self.capture.host_feed(sr, np.frombuffer(data, dtype=np.int16, offset=HEADER.size).reshape(-1, 2))

    async def host_start(self, c):
        if self.host and self.host is not c:
            self.host.send_json({"t": "host_state", "on": False, "msg": f"{c.dev['name']} took over as host"})
        if self.host is None:
            self.host_prev_source = self.cfg["source"] if self.cfg["source"] != "phone" else "system"
        self.host = c
        self.capture.host_name = c.dev["name"]
        self.capture.host_clear()
        self.cfg["source"] = "phone"
        self.cfg["streaming"] = True
        self.capture.configure("phone", self.cfg["device"])
        c.send_json({"t": "host_state", "on": True})
        self.event("host", f"{c.dev['name']} is hosting the music")
        self.push_config()
        await self.broadcast_state()

    async def host_stop(self, c=None):
        if not self.host or (c and self.host is not c):
            return
        host, self.host = self.host, None
        self.capture.host_clear()
        self.cfg["source"] = self.host_prev_source or "system"
        self.capture.configure(self.cfg["source"], self.cfg["device"])
        host.send_json({"t": "host_state", "on": False})
        self.event("host", f"{host.dev['name']} stopped hosting")
        await self.broadcast_state()

    # --------------------------------------------------- files and PC commands

    def share_dir(self):
        d = self.cfg.get("share_dir")
        if self.desktop.demo:
            import tempfile
            d = os.path.join(tempfile.gettempdir(), "phoneboxsound-demo-share")
        elif not d:
            d = os.path.join(os.path.expanduser("~"), "Downloads", "PhoneBoxSound")
        os.makedirs(d, exist_ok=True)
        return d

    def list_files(self):
        d = self.share_dir()
        out = []
        for name in os.listdir(d):
            p = os.path.join(d, name)
            if os.path.isfile(p) and not name.endswith(".part"):
                out.append({"name": name, "size": os.path.getsize(p), "mtime": os.path.getmtime(p)})
        return sorted(out, key=lambda f: -f["mtime"])[:200]

    def client_for_files(self, token):
        return next((c for c in self.clients.values() if token and secrets.compare_digest(c.file_token, token) and c.perms.get("files")), None)

    def run_command(self, c, command_id):
        cmd = next((x for x in self.cfg["commands"] if x["id"] == command_id), None)
        if not cmd:
            return
        self.event("command", f"{c.dev['name']} ran \"{cmd['name']}\"")
        if self.input_log is not None:  # demo / test: record only
            self.input_log.append({"kind": "command", "name": cmd["name"], "run": cmd["run"]})
        else:
            import subprocess
            try:
                subprocess.Popen(cmd["run"], shell=True, cwd=os.path.expanduser("~"), creationflags=0x08000000)
            except Exception as e:
                c.send_json({"t": "toast", "msg": f"Couldn't run it: {e}"})
                return
        c.send_json({"t": "toast", "msg": f"Ran: {cmd['name']}"})

    def toggle_click_test(self):
        if self.cfg["source"] == "clicks":
            self.cfg["source"] = getattr(self, "_before_clicks", None) or "system"
        else:
            self._before_clicks = self.cfg["source"]
            self.cfg["source"] = "clicks"
        self.capture.configure(self.cfg["source"], self.cfg["device"])
        self.cfg.save()

    # ------------------------------------------------- managing all speakers from a phone

    def studio(self, me):
        return {"t": "studio", "bedtime": self.extras.bedtime_state(), "may_power": bool(me.perms.get("power")),
                "cfg": {k: self.cfg[k] for k in ("master", "latency_ms", "auto_latency", "streaming", "source")},
                "devices": [{"device_id": d["device_id"], "name": d["name"], "online": d["online"], "health": d["health"],
                             "platform": d["platform"], "me": d["device_id"] == me.device_id,
                             "settings": {k: d["settings"][k] for k in ("volume", "channel", "offset_ms", "muted")},
                             "buffer": d["stats"].get("ahead_ms")} for d in self.device_rows()]}

    def push_studio(self):
        for c in self.clients.values():
            if c.manage_live and c.perms.get("manage"):
                c.send_json(self.studio(c))

    async def manage(self, c, cmd):
        t = cmd.get("t")
        if t == "set_device":
            patch = {k: v for k, v in (cmd.get("patch") or {}).items() if k in MANAGE_DEVICE_KEYS}
            await self.handle_control({"t": "set_device", "device_id": cmd.get("device_id"), "patch": patch})
        elif t == "set_global":
            await self.handle_control({"t": "set_global", **{k: cmd[k] for k in MANAGE_GLOBAL_KEYS if k in cmd}})
        elif t == "layout":
            await self.handle_control({"t": "layout", "kind": cmd.get("kind")})
        elif t == "identify":
            await self.handle_control({"t": "identify", "device_id": cmd.get("device_id")})
        elif t == "click_test":
            self.toggle_click_test()
            await self.broadcast_state()
        elif t == "scene_apply":
            await self.handle_control({"t": "scene_apply", "id": cmd.get("id")})
        self.push_studio()

    # ---------------------------------------------------------------- power

    def _power_notice(self):
        p = self.power_pending
        msg = {"t": "power", "action": p["action"] if p else None, "seconds": max(0, round(p["at"] - time.time())) if p else 0,
               "by": p["by"] if p else None}
        for c in self.clients.values():
            if c.perms.get("power"):
                c.send_json(msg, urgent=True)

    async def power_request(self, c, action):
        from . import power
        if action not in power.ACTIONS:
            return
        self.power_cancel(quiet=True)
        delay = power.DELAY_S[action]
        name = c.dev["name"]

        async def go():
            try:
                await asyncio.sleep(delay)
                self.power_pending = None
                self._power_notice()
                self.event("power", f"{power.ACTIONS[action]} (asked by {name})")
                if self.input_log is not None:  # demo / test mode: record, do nothing
                    self.input_log.append({"kind": "power", "action": action})
                    return
                await asyncio.sleep(0.3)  # let the notice reach the phones
                await asyncio.to_thread(power.run, action)
            except asyncio.CancelledError:
                pass
            except Exception as e:
                log.warning("power action failed: %s", e)
                c.send_json({"t": "toast", "msg": f"{power.ACTIONS[action]} failed: {e}"})

        self.power_pending = {"action": action, "by": name, "at": time.time() + delay, "task": asyncio.create_task(go())}
        if delay:
            self.event("power", f"{name} asked to {power.ACTIONS[action].lower()} the PC in {delay} s")
        self._power_notice()
        await self.broadcast_state()

    def power_cancel(self, quiet=False):
        p = self.power_pending
        if not p:
            return False
        p["task"].cancel()
        self.power_pending = None
        if not quiet:
            self.event("power", "Power action cancelled")
            self._power_notice()
        return True

    # ------------------------------------------------------ clipboard + screen

    async def clip_to_phone(self, c, quiet=False):
        clip = await asyncio.to_thread(self.desktop.get_clipboard)
        if clip.get("kind") == "image":
            import base64
            c.clip_image = base64.b64decode(clip["image"].split(",", 1)[1])
            clip["url"] = f"/clip/{c.file_token}/pc-clipboard-{int(time.time())}.jpg"
        c.send_json({"t": "clip", **clip, "auto": quiet})

    async def clip_from_phone(self, c, m):
        try:
            if m.get("image"):
                from .desktop import image_from_data_url
                img = await asyncio.to_thread(image_from_data_url, str(m["image"]))
                await asyncio.to_thread(self.desktop.set_clipboard_image, img)
                what = "an image"
            else:
                text = str(m.get("text", ""))
                await asyncio.to_thread(self.desktop.set_clipboard_text, text)
                what = f"{len(text)} characters"
            self.clip_seq = self.desktop.clipboard_seq()  # our own change: don't echo it back
            if m.get("paste"):
                await asyncio.sleep(0.05)
                self.do_input({"kind": "key", "keys": ["ctrl", "v"]})
            c.send_json({"t": "toast", "msg": f"PC clipboard set ({what})" + (" and pasted" if m.get("paste") else "")})
            self.event("clipboard", f"{c.dev['name']} sent {what} to the PC clipboard")
        except Exception as e:
            c.send_json({"t": "toast", "msg": f"Couldn't set the PC clipboard: {e}"})

    async def watch_clipboard(self):
        """Live clipboard: phones that asked for it get the PC clipboard whenever it changes."""
        live = [c for c in self.clients.values() if c.clip_live and c.perms.get("clipboard")]
        if not live:
            return
        seq = await asyncio.to_thread(self.desktop.clipboard_seq)
        if seq == self.clip_seq:
            return
        self.clip_seq = seq
        for c in live:
            await self.clip_to_phone(c, quiet=True)

    # Screen pictures, from sharp to light. The loop moves down this ladder when a picture takes long to
    # arrive (or the phone's sound starts to suffer) and back up when the link has room.
    SCREEN_LADDER = ((1280, 55), (1120, 50), (960, 44), (800, 40), (640, 36), (520, 32))

    async def _screen_loop(self, c):
        """Screen view for one phone. The sound always comes first; the picture gets what is left.

        Pictures travel on their own connection (/ws/screen), never on the one that carries the sound,
        and one picture is in flight at a time: the next is made only when the phone has drawn the last.
        That alone is not enough on a weak link: Wi-Fi delivers everything to the phone through one queue
        at the router, so a 100 kB picture sent in one go makes every sound block behind it wait. So:

        - a picture leaves in small slices with pauses in between, using at most half of what this phone's
          link has been measured to carry; sound blocks (every 10 ms) slip through between the slices;
        - the phone says "strain" the moment sound arrives with too little time to spare, and pictures
          then pause, shrink and slow down at once (c.screen_strain);
        - pictures get lighter when they are slow, and sharper again only after a calm stretch."""
        from .desktop import frame_hash
        last, seq, level, quick = None, 0, 3, 0
        rate = 100_000.0          # bytes per second the pictures may use: start gentle, grow while the sound is calm
        enc = lambda v: 65535 if v < 0 else int(max(0.0, min(1.0, v)) * 65534)
        try:
            while c.screen_mode and self.clients.get(c.id) is c and c.perms.get("screen"):
                started = time.time()
                ws = c.screen_ws
                suffering = len(c.audio) >= 8 or (c.stats.get("late_recent") or 0) > 2
                strained = time.time() - c.screen_strain < 1.5
                if strained:
                    level = min(level + 1, len(self.SCREEN_LADDER) - 1)
                    rate = max(40_000.0, rate * 0.6)
                    c.screen_strain = 0.0
                    await asyncio.sleep(1.0)          # give the sound the whole link for a moment
                    continue
                if ws is None and (c.frame is not None or suffering):
                    await asyncio.sleep(0.12)          # old app without the picture connection: wait for it to catch up
                    continue
                width, quality = self.SCREEN_LADDER[level]
                jpg, cx, cy = await asyncio.to_thread(self.desktop.grab, c.screen_mode, width, quality, c.screen_zoom)
                h = (frame_hash(jpg), round(cx, 3), round(cy, 3))
                took = 0.0
                if h != last:
                    last, seq = h, seq + 1
                    if ws is None:
                        c.send_frame(HEADER.pack(KIND_SCREEN, 0, enc(cx), seq & 0xFFFFFFFF, 0.0, enc(cy), 0) + jpg)
                    else:
                        # slices small enough to cross the link in ~12 ms each, sent at most at half its speed
                        piece = int(max(4_000, min(16_000, rate * 2 * 0.012)))
                        parts = [jpg[k:k + piece] for k in range(0, len(jpg), piece)] or [b""]
                        count = len(parts)
                        sent = time.time()
                        c.screen_ack.clear()
                        try:
                            for idx, part in enumerate(parts):
                                flags = 0 if count == 1 else ((count << 16) | idx)
                                await ws.send_bytes(HEADER.pack(KIND_SCREEN, 0, enc(cx), seq & 0xFFFFFFFF, 0.0, enc(cy), flags) + part)
                                if idx < count - 1:
                                    await asyncio.sleep(len(part) / rate)
                                if time.time() - c.screen_strain < 0.2:
                                    break                         # the sound is suffering: stop this picture here
                            await asyncio.wait_for(c.screen_ack.wait(), 2.0)
                        except asyncio.TimeoutError:
                            pass
                        except Exception:
                            c.screen_ws = None
                            continue
                        took = time.time() - sent
                        if self.journal:
                            self.journal.count(c.device_id, "screen_out", len(jpg))
                        c.screen_ms = round(took * 1000)
                        # a little faster after each calm picture; much slower the moment the sound strains (above)
                        if time.time() - c.screen_strain > 3:
                            rate = min(1_500_000.0, rate * 1.08)
                        # lighter when a picture is slow or the sound is struggling; sharper after a calm stretch
                        if took > 0.25 or suffering:
                            level, quick = min(level + 1, len(self.SCREEN_LADDER) - 1), 0
                        elif took < 0.08:
                            quick += 1
                            if quick >= 6:
                                level, quick = max(level - 1, 0), 0
                        else:
                            quick = 0
                # leave the air free for at least as long as the picture used it: sound comes first
                await asyncio.sleep(max(0.05, min(0.6, took * 0.5), 0.11 - (time.time() - started)))
        except asyncio.CancelledError:
            pass
        except Exception as e:
            log.info("screen view stopped: %s", e)
        finally:
            c.screen_mode = None

    def video_ok(self, c):
        return bool(self.video and self.video.encoder and self.cfg.get("screen_video", True)
                    and c.screen_video and c.screen_mode == "screen" and c.screen_ws is not None)

    async def _screen_any(self, c):
        """Video while the phone and the PC can do it; pictures otherwise (and as soon as video fails)."""
        while c.screen_mode and self.clients.get(c.id) is c:
            for _ in range(10):                  # the picture connection opens a moment after the request
                if c.screen_ws is not None:
                    break
                await asyncio.sleep(0.1)
            if self.video_ok(c):
                if await self._video_loop(c):
                    continue                     # stopped for a reason that allows trying again (new settings)
                c.screen_video = False           # video did not work for this phone: pictures from now on
            await self._screen_loop(c)
            return

    async def _video_loop(self, c):
        """Screen view as H.264 video, the sound always first.

        Each frame goes out in small paced slices, like the pictures. When the phone says "strain" (sound
        arriving with little time to spare) the video stops at once and starts again a moment later at a
        lower bitrate, from a full frame (so nothing half-decoded is left on the phone). After a calm
        stretch it steps back up. At most a few frames are in flight: when the phone falls behind, the
        frames in between are dropped and the video restarts from a full frame."""
        from .audio import HEADER as H
        enc = lambda v: 65535 if v < 0 else int(max(0.0, min(1.0, v)) * 65534)
        from .video import cursor_on_screen
        kbps, width, seq, sent_count = 1500, 1280, 0, 0
        calm_since, rate = time.time(), 400_000.0
        while self.video_ok(c):
            fps = 30 if kbps >= 2500 else 24 if kbps >= 900 else 15
            stream = self.video.start(width if kbps >= 700 else 960, fps, kbps)
            if stream is None:
                return False
            c.screen_need_key, base = False, c.screen_acks
            sent_here, got_any, restart = 0, False, None
            try:
                while self.video_ok(c) and restart is None:
                    try:
                        f = await stream.next(3.0)
                    except asyncio.TimeoutError:
                        if not stream.alive or not got_any:
                            log.info("screen video stopped: %s", stream.error or "no frames")
                            return False
                        continue
                    got_any = True
                    if time.time() - c.screen_strain < 1.0:
                        restart = "strain"
                        break
                    if c.screen_need_key:
                        restart = "key"
                        break
                    if sent_here - (c.screen_acks - base) > 4:
                        restart = "behind"            # the phone fell behind: skip ahead from a full frame
                        break
                    cx, cy = (self.desktop.cursor if self.desktop.demo else cursor_on_screen())
                    seq += 1
                    piece = int(max(4_000, min(16_000, rate * 0.012)))
                    parts = [f.data[k:k + piece] for k in range(0, len(f.data), piece)] or [b""]
                    ws = c.screen_ws
                    for idx, part in enumerate(parts):
                        flags = 0 if len(parts) == 1 else ((len(parts) << 16) | idx)
                        await ws.send_bytes(H.pack(KIND_SCREEN, 2 if f.key else 1, enc(cx), seq & 0xFFFFFFFF, f.t * 1000.0, enc(cy), flags) + part)
                        if idx < len(parts) - 1:
                            await asyncio.sleep(len(part) / rate)
                    sent_here += 1
                    sent_count += 1
                    if self.journal:
                        self.journal.count(c.device_id, "screen_out", len(f.data))
                    c.screen_ms = round(1000 / fps)
                    if time.time() - calm_since > 15 and kbps < 6000 and time.time() - c.screen_strain > 15:
                        restart = "calm"
            except Exception as e:
                log.info("screen video ended: %s", e)
                return False
            finally:
                stream.stop()
            if restart == "strain":
                kbps, rate = max(300, int(kbps * 0.6)), max(100_000.0, rate * 0.6)
                calm_since = time.time()
                await asyncio.sleep(1.0)              # the whole link for the sound for a moment
            elif restart == "calm":
                kbps, rate = min(6000, int(kbps * 1.3)), min(1_500_000.0, rate * 1.3)
                calm_since = time.time()
        return True

    def set_screen(self, c, mode, zoom=None):
        c.screen_mode = mode if mode in ("screen", "window", "zoom") else None
        if zoom:
            c.screen_zoom = clamp(float(zoom), 1.5, 10)
        if c.screen_mode and (c.screen_task is None or c.screen_task.done()):
            c.screen_task = asyncio.create_task(self._screen_any(c))
            self.event("screen", f"{c.dev['name']} is viewing the PC screen")

    def intercom_targets(self, target, exclude=None):
        """target: "all" | "zone:<name>" | "device:<device_id>" | "pc"."""
        out = []
        for c in self.clients.values():
            if c.device_id == exclude:
                continue
            if target == "all" or (target.startswith("zone:") and c.dev["zone"] == target[5:]) or \
                    target == f"device:{c.device_id}":
                out.append(c)
        return out

    def on_intercom_audio(self, talker_key, data):
        talk = self.talkers.get(talker_key)
        if not talk or len(data) < HEADER.size:
            return
        kind, ch, frames, _seq, _ts, sr, _flags = HEADER.unpack_from(data)
        if kind != KIND_INTERCOM or ch != 1 or frames > 4800 or len(data) != HEADER.size + frames * 2 or sr > 48000:
            return
        for c in self.intercom_targets(talk["target"], exclude=talk.get("device_id")):
            c.send(data, audio=True)
        if talk["target"] in ("pc", "all") and talk.get("device_id"):
            for ws in list(self.controls):
                asyncio.ensure_future(self._safe_send_bytes(ws, data))

    @staticmethod
    async def _safe_send_bytes(ws, data):
        try:
            await ws.send_bytes(data)
        except Exception:
            pass

    async def set_talking(self, key, name, target, device_id=None):
        if target is None:
            if self.talkers.pop(key, None):
                self.event("intercom_stopped", f"{name} stopped talking")
        else:
            self.talkers[key] = {"name": name, "target": target, "device_id": device_id, "since": time.time()}
            self.event("intercom_started", f"{name} is talking to {self.target_label(target)}")
        info = {"t": "intercom", "talkers": [{"name": v["name"], "target": v["target"], "device_id": v.get("device_id")}
                                             for v in self.talkers.values()]}
        for c in self.clients.values():
            c.send_json(info, urgent=True)
        self.push_config()
        await self.broadcast_state()

    def target_label(self, target):
        if target == "all":
            return "everyone"
        if target == "pc":
            return "the PC"
        if target.startswith("zone:"):
            return target[5:]
        dev = self.cfg["devices"].get(target[7:])
        return dev["name"] if dev else "a phone"

    def intercom_target_list(self):
        out = [{"id": "all", "label": "All phones"}, {"id": "pc", "label": "PC"}]
        out += [{"id": f"zone:{z}", "label": z} for z in self.cfg["zones"]]
        out += [{"id": f"device:{c.device_id}", "label": c.dev["name"]} for c in self.clients.values()]
        return out

    # ------------------------------------------------------------ pairing --

    def pairing_blocked(self, ip):
        recent = [t for t in self.fails[ip] if time.time() - t < 60]
        self.fails[ip] = recent
        return len(recent) >= 5

    def authenticate(self, m, ip):
        """Returns (device_id, new_token or None, error or None)."""
        m.pop("_code", None)
        m.pop("_rebind", None)
        m.pop("_guest", None)
        device_id = str(m.get("device_id") or "")[:64]
        token = str(m.get("token") or "")
        known = self.cfg["devices"].get(device_id)
        if ip in self.cfg["blocked_ips"] or (known and known.get("blocked")):
            return None, None, "blocked"
        # A one-time pass comes first: it was handed to this very phone a moment ago, and on the address
        # it now arrives at, the browser may still hold an older id and key (a port used before).
        handoff = m.get("handoff")
        if handoff and handoff in self.handoffs:
            hid, exp, was_verified = self.handoffs.pop(handoff)
            if time.time() < exp and not self.cfg["devices"].get(hid, {}).get("blocked"):
                m["_rebind"] = was_verified
                return self._issue(hid)
        if known and token and known.get("token_hash") and secrets.compare_digest(known["token_hash"], hash_token(token)):
            return device_id, None, None
        if self.cfg["lockdown"]:
            return None, None, "This PC is in lockdown: new phones can't join right now."
        if m.get("guest"):
            p = self.extras.guest_ok(m["guest"])
            if not p:
                return None, None, "This guest pass has ended. Ask for a new one."
            p["used"] += 1
            m["_guest"] = p["until"]
            return self._issue(secrets.token_hex(8))
        if self.pairing_blocked(ip):
            return None, None, "Too many wrong codes. Wait a minute and try again."
        if str(m.get("code", "")).strip() == self.code:
            # The code never takes over a record that still has its own credentials: whoever claims that
            # id without the token or key simply becomes a new device (and waits for approval).
            if not device_id or (known and (known.get("token_hash") or known.get("pubkey"))):
                device_id = secrets.token_hex(8)
            m["_code"] = True
            return self._issue(device_id)
        if m.get("code"):
            self.fails[ip].append(time.time())
            return None, None, "Wrong code"
        return None, None, "pair"

    def _issue(self, device_id):
        token = secrets.token_urlsafe(24)
        self.cfg.device(device_id)["token_hash"] = hash_token(token)
        self.cfg.save()
        return device_id, token, None

    def has_pass(self, m):
        """True if this hello carries a one-time pass that is still good."""
        h = self.handoffs.get(str(m.get("handoff") or ""))
        return bool(h and h[1] > time.time())

    def new_handoff(self, device_id, verified=False):
        """A one-time pass, sent only over the phone's own authenticated connection, that lets the same
        phone come back on another address of this PC (the secure link, a new port). `verified`: the phone
        had proved its key, so on the new address (where browsers give it a fresh key) it may register
        that key without being verified again."""
        t = secrets.token_urlsafe(16)
        self.handoffs = {k: v for k, v in self.handoffs.items() if v[1] > time.time()}
        self.handoffs[t] = (device_id, time.time() + 120, verified)
        return t

    # ------------------------------------------------------------- phones --

    def adopt_previous(self, device_id, ip, platform):
        """A phone that pairs again from the same address (e.g. switched between the http and https
        pages, which have separate browser storage) keeps its name and settings instead of duplicating."""
        for old_id, old in list(self.cfg["devices"].items()):
            if old_id == device_id or self.online(old_id) or old.get("blocked") or old.get("forgotten") or not old.get("approved", True):
                continue      # never inherit from a phone that is in use, blocked, gone or not yet approved
            if old.get("last_ip") == ip and old.get("platform") == platform:
                dev = self.cfg["devices"][device_id]
                for k in ("name", "volume", "channel", "offset_ms", "muted", "zone", "eq", "speaker", "perms", "order"):
                    dev[k] = copy.deepcopy(old[k])
                for k in ELEVATED:      # an address and a system name are not proof: PC control is never inherited
                    dev["perms"][k] = False
                del self.cfg["devices"][old_id]
                log.info("device %s adopted settings of %s", device_id, old_id)
                return True
        return False

    def pending_rows(self):
        return [{"device_id": i, "name": d["name"], "platform": d.get("system") or d["platform"], "ip": d.get("last_ip"), "waiting": i in self.waiting,
                 "since": int(time.time() - (d.get("first_seen") or time.time()))}
                for i, d in self.cfg["devices"].items() if not d.get("approved", True) and not d.get("blocked")]

    def past_rows(self):
        return [{"device_id": i, "name": d["name"], "platform": d.get("system") or d["platform"], "ip": d.get("last_ip"),
                 "forgotten": int(time.time() - d["forgotten"]), "since": int(time.time() - (d.get("last_seen") or time.time()))}
                for i, d in self.cfg["devices"].items() if d.get("forgotten")]

    def push_approvers(self):
        self.push_config([c for c in self.clients.values() if c.perms.get("approve")])

    async def _wait(self, ws, m, ip, secure, proven, device_id, token):
        dev = self.cfg["devices"][device_id]
        old = self.waiting.pop(device_id, None)
        if old and old["ws"] is not ws:
            asyncio.ensure_future(old["ws"].close())
        self.waiting[device_id] = {"ws": ws, "m": m, "ip": ip, "secure": secure, "proven": proven, "client": None}
        await ws.send_json({"t": "waiting", "device_id": device_id, "token": token, "name": dev["name"]})
        self.note(device_id, "hello", m, d="in")
        self.note(device_id, "waiting", {"name": dev["name"], "ip": ip, "secure": secure})
        if not old:
            self.event("approval", f"{dev['name']} ({ip}) wants to join: approve or deny it on the Devices page", device=dev["name"], ip=ip)
        self.push_approvers()
        await self.broadcast_state()
        return None, "waiting"

    async def stop_waiting(self, ws):
        for device_id in [k for k, w in self.waiting.items() if w["ws"] is ws]:
            del self.waiting[device_id]
        self.push_approvers()
        await self.broadcast_state()

    async def decide(self, device_id, ok, by="the PC"):
        """Approve or deny a phone that is waiting to join."""
        dev = self.cfg["devices"].get(device_id)
        if not dev or dev.get("approved", True):
            return
        w = self.waiting.pop(device_id, None)
        self.note(device_id, "approved" if ok else "denied", {"by": by})
        if ok:
            dev["approved"] = True
            self.cfg.save()
            self.event("approval", f"{dev['name']} was approved by {by}")
            if w and not w["ws"].closed:
                w["client"], _ = await self.join(w["ws"], w["m"], w["ip"], w["secure"], w["proven"], preauth=device_id)
        else:
            self.event("approval", f"{dev['name']} was denied by {by}")
            del self.cfg["devices"][device_id]
            self.cfg.save()
            if w and not w["ws"].closed:
                await w["ws"].send_json({"t": "error", "msg": "The PC did not approve this phone", "need_code": False, "forget": True})
                asyncio.ensure_future(w["ws"].close())
        self.push_approvers()
        await self.broadcast_state()

    async def join(self, ws, m, ip, secure, proven=False, preauth=None):
        """`proven`: the phone has just signed our challenge with the key registered for this device.
        `preauth`: a waiting phone that has just been approved (it already passed the code check)."""
        existed = set(self.cfg["devices"])
        was_known = False
        if preauth:
            device_id, token, was_known = preauth, None, True
        elif proven:
            device_id, token = str(m.get("device_id"))[:64], None
            if ip in self.cfg["blocked_ips"] or self.cfg["devices"].get(device_id, {}).get("blocked"):
                return None, "blocked"
        else:
            device_id, token, err = self.authenticate(m, ip)
            if err:
                return None, err
        # "known" is about the record it ended up as (a hand-off link names no id but leads to an existing
        # record), not about the id it claimed.
        was_known = was_known or device_id in existed
        fresh = token is not None and (not was_known or bool(m.get("_code")))   # came in with the room code
        if fresh and self.cfg["approval"] and sum(not d.get("approved", True) for d in self.cfg["devices"].values()) > 20:
            del self.cfg["devices"][device_id]
            return None, "Too many phones are waiting for approval. Ask the PC's owner."
        adopted = fresh and self.adopt_previous(device_id, ip, str(m.get("platform", ""))[:40])
        old = self.online(device_id)
        if old:  # same phone reconnecting: replace the stale socket
            self.clients.pop(old.id, None)
            old.sender.cancel()
            asyncio.ensure_future(old.ws.close())
        dev = self.cfg.device(device_id)
        name = clean_name(m.get("name"))
        if name and not adopted and (dev["name"] == "Phone" or (m.get("rename") and token is not None)):
            dev["name"] = name
        dev["platform"] = str(m.get("platform", ""))[:40]
        dev["last_seen"] = time.time()
        dev["last_ip"] = ip
        if dev["zone"] not in self.cfg["zones"]:
            dev["zone"] = next(iter(self.cfg["zones"]), "Living Room")
        dev["forgotten"] = 0
        reported = system.describe(m.get("ua"), m.get("uad"), m.get("touch"))
        if reported:
            was = dev.get("system") or ""
            if was and system.family(was) != system.family(reported) and not fresh:
                # The same phone does not turn from an iPhone into a Windows PC. Keep it as a speaker,
                # hold back PC control, and ask on the PC.
                dev["system_was"] = dev.get("system_was") or was
                self.event("security", f"{dev['name']} now reports to be {reported} (was {was}): PC control is held back until you confirm it")
                self.note(device_id, "system", {"now": reported, "was": was})
            dev["system"] = reported
        if fresh:
            dev["first_seen"] = time.time()
            dev["approved"] = not self.cfg["approval"]     # the right code only gets a phone into the waiting room
        if m.get("_guest"):
            # the pass itself is the approval: a speaker for a few hours, nothing else, then gone
            dev.update(approved=True, guest_until=m["_guest"], name=clean_name(m.get("name")) or f"Guest {device_id[:3].upper()}")
            dev["perms"] = {k: k == "speaker" for k in PERMS}
            self.event("guest", f"{dev['name']} joined with a guest pass ({ip})")
        self.cfg.save()
        if not dev.get("approved", True):
            return await self._wait(ws, m, ip, secure, proven, device_id, token)
        c = Client(ws, device_id, dev, ip, secure, self.cfg, verified=proven)
        c.can_sign = bool(m.get("can_sign"))
        pub = identity.clean(m.get("pub")) if not proven and (not dev.get("pubkey") or m.get("_rebind")) else None
        if pub and m.get("_rebind"):
            dev["pubkey"], c.verified = pub, True       # the verified phone itself, arriving on its new address
            self.cfg.save()
        elif pub:
            if any(dev["perms"].get(k) for k in ELEVATED):
                # This device already holds powerful permissions (set earlier, or carried over from the
                # same phone's other address). Don't hand them to a key we've never seen: ask the PC.
                c.pending_pub = pub
            else:
                dev["pubkey"], c.verified = pub, True
                self.cfg.save()
        c.journal = self.journal
        self.note(device_id, "hello", m, d="in")
        self.note(device_id, "connected", {"name": dev["name"], "ip": ip, "secure": secure, "verified": c.verified, "platform": dev["platform"], "system": dev.get("system")})
        self.clients[c.id] = c
        c.send_json({"t": "welcome", "id": c.id, "device_id": device_id, "token": token})
        self.push_config([c])
        c.send_json({"t": "media", **self.media.public()})
        c.send_json({"t": "intercom", "talkers": [{"name": v["name"], "target": v["target"], "device_id": v.get("device_id")}
                                                  for v in self.talkers.values()]})
        c.send_json({"t": "targets", "list": self.intercom_target_list()})
        self.event("device_connected", f"{dev['name']} connected", device=dev["name"], ip=ip)
        self.broadcast_targets()
        await self.broadcast_state()
        return c, None

    async def leave(self, c):
        if self.clients.get(c.id) is c:
            self.clients.pop(c.id, None)
            c.dev["last_seen"] = time.time()
            self.event("device_disconnected", f"{c.dev['name']} disconnected", device=c.dev["name"])
            self.note(c.device_id, "disconnected", {"after_s": round(time.time() - c.joined, 1)})
        c.sender.cancel()
        if self.host is c:
            await self.host_stop(c)
        c.screen_mode = None
        if c.screen_task:
            c.screen_task.cancel()
        for key in [k for k, v in self.talkers.items() if v.get("device_id") == c.device_id]:
            await self.set_talking(key, c.dev["name"], None)
        self.broadcast_targets()
        await self.broadcast_state()

    def broadcast_targets(self):
        msg = {"t": "targets", "list": self.intercom_target_list()}
        for c in self.clients.values():
            c.send_json(msg)

    async def handle_phone(self, c, m):
        c.last_msg = time.time()
        t = m.get("t")
        if t == "stats":
            keep = ("ahead_ms", "late", "late_recent", "resyncs", "rtt_ms", "jitter_ms", "need_ms", "out_latency_ms", "far", "clock_jumps",
                    "sample_rate", "rate", "played", "state", "gaps", "hidden", "battery", "charging")
            c.stats.update({k: m[k] for k in keep if k in m})
        elif t == "set_self":
            if "speaker" in m:
                c.dev["speaker"] = bool(m["speaker"])
            if m.get("name"):
                await self.rename(c.device_id, m["name"])
            if "offset_ms" in m:  # the phone's own "sync nudge"
                c.dev["offset_ms"] = int(clamp(float(m["offset_ms"]), -1000, 1000))
            self.cfg.save()
            self.push_config([c])
            await self.broadcast_state()
        elif t == "media" and c.perms["remote"]:
            msg = await self.media_command(m.get("action"), m.get("value"), m.get("session"))
            if msg:
                c.send_json({"t": "toast", "msg": msg})
        elif t == "input" and c.perms["input"]:
            c.outcome = self.do_input(m)
            self.keyboard_hint(c, m)
        elif t == "strain":
            c.screen_strain = time.time()       # pictures make way for the sound at once
            c.outcome = "noted"
        elif t == "kbd_watch":
            c.kbd_watch = bool(m.get("on")) and bool(c.perms["input"])
            c.kbd_over = None
        elif t == "command" and c.perms.get("commands"):
            self.run_command(c, m.get("id"))
        elif t == "host_start" and c.perms.get("host"):
            await self.host_start(c)
        elif t == "host_stop":
            await self.host_stop(c)
        elif t == "host_flush" and self.host is c:
            self.capture.host_clear()
        elif t in ("command", "host_start"):
            self.denied(c, "PC commands" if t == "command" else "hosting music")
        elif t == "manage_watch":
            c.manage_live = bool(m.get("on")) and bool(c.perms.get("manage"))
            if c.manage_live:
                c.send_json(self.studio(c))
        elif t == "manage" and c.perms.get("manage") and isinstance(m.get("cmd"), dict):
            await self.manage(c, m["cmd"])
        elif t == "manage":
            self.denied(c, "speaker management")
        elif t == "power" and c.perms.get("power"):
            if m.get("cancel"):
                self.power_cancel()
                await self.broadcast_state()
            else:
                await self.power_request(c, str(m.get("action")))
        elif t == "power":
            self.denied(c, "power control")
        elif t == "clip_get" and c.perms.get("clipboard"):
            await self.clip_to_phone(c)
        elif t == "clip_set" and c.perms.get("clipboard"):
            await self.clip_from_phone(c, m)
        elif t == "clip_live" and c.perms.get("clipboard"):
            c.clip_live = bool(m.get("on"))
            self.clip_seq = self.desktop.clipboard_seq()
        elif t == "screen" and (c.perms.get("screen") or not m.get("mode")):
            c.screen_video = bool(m.get("video"))
            self.set_screen(c, m.get("mode"), m.get("zoom"))
        elif t in ("input", "clip_get", "clip_set", "clip_live", "screen") or (t == "media" and not c.perms["remote"]):
            self.denied(c, {"input": "keyboard & mouse", "screen": "screen view", "media": "the media remote"}.get(t, "the clipboard"))
        elif t == "intercom_start" and c.perms["intercom"]:
            await self.set_talking(("dev", c.device_id), c.dev["name"], str(m.get("target") or "all"), c.device_id)
        elif t == "intercom_stop":
            await self.set_talking(("dev", c.device_id), c.dev["name"], None)
        elif t == "handoff":
            c.send_json({"t": "handoff", "url": f"{self.https_url()}/?handoff={self.new_handoff(c.device_id, c.verified)}"})
        elif t == "forget":
            # The phone forgets the PC; the PC keeps the record (name, address, history) and takes away
            # everything that could be used to come back as this device.
            c.dev.update(token_hash=None, pubkey=None, forgotten=time.time())
            for k in ELEVATED:
                c.dev["perms"][k] = False
            self.cfg.save()
            self.event("device", f"{c.dev['name']} forgot this PC (kept in past devices)")
        elif t == "approve" and c.perms.get("approve"):
            await self.decide(str(m.get("device_id") or ""), bool(m.get("ok")), by=c.dev["name"])
        elif t == "approve":
            self.denied(c, "approving phones")
        elif t == "invite" and self.cfg["lockdown"]:
            c.send_json({"t": "toast", "msg": "The PC is in lockdown: no new phones right now."})
        elif t == "invite":
            # Phone-to-phone sharing: a paired phone shows a QR that another phone scans to join.
            import io
            import segno
            url = self.https_url() if c.secure and self.https_url() else self.http_url()
            link = f"{url}/?code={self.code}"
            from .branding import qr_svg, valid
            c.send_json({"t": "invite", "url": url, "code": self.code, "link": link, "svg": qr_svg(link, valid(str(m.get("theme") or self.cfg["theme"])), scale=6)})
            self.event("invite", f"{c.dev['name']} is inviting another phone")
        elif t == "click_test" and not c.perms.get("manage"):
            self.denied(c, "the click test")       # it replaces what every phone hears
        elif t == "click_test":
            self.toggle_click_test()
            c.send_json({"t": "toast", "msg": "Click test on: adjust until phones click as one" if self.cfg["source"] == "clicks" else "Click test off"})
            await self.broadcast_state()
        elif t == "panic" and c.perms.get("panic"):
            if not self.cfg["lockdown"]:
                await self.handle_control({"t": "set_global", "lockdown": True})
                self.event("security", f"Lockdown ON: {c.dev['name']} was shaken (panic gesture)")
                await self.toast_controls(f"Lockdown switched on from {c.dev['name']}")
            c.send_json({"t": "toast", "msg": "Lockdown is on. Only the PC can switch it off."})
        elif t == "panic":
            self.denied(c, "the panic gesture")
        elif t == "bedtime" and c.perms.get("manage"):
            if m.get("cancel"):
                await self.extras.bedtime_cancel()
            else:
                c.outcome = await self.extras.bedtime_start(m.get("minutes"), str(m.get("after") or "pause"), by=c.dev["name"], may_power=bool(c.perms.get("power")))
                if c.outcome:
                    c.send_json({"t": "toast", "msg": c.outcome})
            self.push_studio()
        elif t == "bedtime":
            self.denied(c, "the bedtime timer")
        elif t == "playlists_get" and c.perms["remote"]:
            c.send_json({"t": "playlists", "rid": m.get("rid"), **await self.spotify.playlists()})
        elif t == "queue_get" and c.perms["remote"]:
            c.send_json({"t": "queue_info", "rid": m.get("rid"), **await self.spotify.snapshot()})
        elif t == "queue_do" and c.perms["remote"]:
            got = await self.queue_do(str(m.get("action")), m.get("value"))
            c.outcome = got["error"]
            c.send_json({"t": "queue_done", "rid": m.get("rid"), **got})
        elif t in ("queue_get", "queue_do", "playlists_get"):
            self.denied(c, "the media remote")
        elif t == "share" and c.perms["remote"]:
            c.send_json({**await self.share_info(m.get("theme")), "rid": m.get("rid")})
        elif t == "share":
            self.denied(c, "the media remote")
        elif t in ("search", "suggest", "search_open") and c.perms.get("search"):
            if t == "search":
                c.send_json({"t": "search_results", "rid": m.get("rid"), "can_queue": self.spotify.linked, **await self.search.query(m.get("q"), str(m.get("service") or "all"))})
            elif t == "suggest":
                c.send_json({"t": "suggestions", "rid": m.get("rid"), "list": await self.search.suggest(m.get("q"))})
            else:
                c.outcome = await self.open_on_pc(self.search.target(m.get("id")), by=c.dev["name"])
                if c.outcome:
                    c.send_json({"t": "toast", "msg": c.outcome})
        elif t in ("search", "suggest", "search_open"):
            self.denied(c, "search")
        elif t == "identify_self":
            c.send_json({"t": "identify", "index": self.device_config(c)["index"]})

    async def _type_after(self, previous, text):
        if previous:
            await asyncio.gather(previous, return_exceptions=True)  # keep messages in the order they were sent
        await asyncio.to_thread(inputctl.type_text, text)

    def do_input(self, m):
        kind = m.get("kind")
        if self.input_log is not None:  # demo / test mode: record what would have happened, touch nothing
            self.input_log.append({k: v for k, v in m.items() if k != "t"})
            if kind == "move" and hasattr(self.desktop, "move_cursor"):
                self.desktop.move_cursor(float(m.get("dx", 0)), float(m.get("dy", 0)))
            return
        try:
            if kind == "move":
                inputctl.move(float(m.get("dx", 0)), float(m.get("dy", 0)))
            elif kind == "click":
                inputctl.click(m.get("button", "left"), bool(m.get("double")))
            elif kind == "button":
                inputctl.button(m.get("button", "left"), bool(m.get("down")))
            elif kind == "scroll":
                inputctl.scroll(float(m.get("dy", 0)), float(m.get("dx", 0)))
            elif kind == "key":
                keys = [str(k) for k in (m.get("keys") or [])][:6]  # e.g. ctrl+shift+alt+win+key
                inputctl.press(*keys)
            elif kind == "text":
                # typed in order, off the event loop (a long message takes a moment and must not stall audio)
                text = str(m.get("text", ""))
                self._typing = asyncio.ensure_future(self._type_after(getattr(self, "_typing", None), text))
        except Exception as e:
            log.debug("input failed: %s", e)
            return f"Windows did not accept it: {e}"

    # ----------------------------------------------------------- dashboard --

    def device_rows(self):
        rows = []
        for device_id, dev in sorted(self.cfg["devices"].items(), key=lambda kv: kv[1]["order"]):
            c = self.online(device_id)
            if not dev.get("approved", True) or dev.get("forgotten"):
                continue  # listed separately: waiting for approval / past devices
            if not c and not dev.get("token_hash") and not dev.get("blocked"):
                continue  # never fully paired
            rows.append({
                "device_id": device_id, "online": bool(c), "id": c.id if c else None,
                "name": dev["name"], "platform": dev["platform"], "ip": c.ip if c else None,
                "settings": {k: dev[k] for k in ("volume", "channel", "offset_ms", "muted", "zone", "eq", "speaker", "quality")},
                "guest_until": dev.get("guest_until") or 0,
                "link": c.link() if c else "offline", "auto_saver": bool(c and c.auto_saver), "screen_ms": c.screen_ms if c and c.screen_mode else None,
                "kbps": (0 if not (c and c.dev["speaker"] and c.perms["speaker"] and self.cfg["streaming"]) else 768 if (dev.get("quality") == "saver" or c.auto_saver) else 1536),
                "system": dev.get("system") or "", "system_note": dev.get("system_note") or "", "system_was": dev.get("system_was") or "",
                "blocked": bool(dev.get("blocked")), "has_key": bool(dev.get("pubkey")), "verified": bool(c and c.verified),
                "locked": c.locked() if c else [], "can_sign": bool(c and c.can_sign),
                "verify_code": identity.code(c.pending_pub) if c and c.pending_pub else None,
                "perms": dev["perms"], "stats": c.stats if c else {}, "health": c.health() if c else "offline",
                "since": int(time.time() - (c.joined if c else dev.get("last_seen") or time.time())),
                "secure": c.secure if c else False, "server_drops": c.audio_drops if c else 0,
            })
        return rows

    def state(self):
        cfg = {k: self.cfg[k] for k in ("latency_ms", "auto_latency", "min_latency_ms", "max_latency_ms", "master",
                                        "streaming", "source", "device", "theme", "mode", "duck_level", "zones",
                                        "scenes", "webhooks", "vlc", "mpv", "mdns", "https", "lip_sync", "strict", "public_https", "lockdown", "approval", "browser_delay", "auto_quality", "auto_keyboard", "activity", "screen_video")}
        return {
            "t": "state", "code": self.code, "ips": self.ips, "ports": self.ports, "mdns": self.mdns_ok,
            "cfg": cfg, "api_token": self.cfg["api_token"],
            "terms_ok": self.terms_ok(),
            "video": self.video.status() if self.video else None,
            "capture": {"status": self.capture.status, "error": self.capture.error, "device": self.capture.active_device,
                        "sample_rate": self.sample_rate, "devices": self.capture.devices},
            "devices": self.device_rows(), "pending": self.pending_rows(), "past": self.past_rows(), "media": self.media.public(),
            "talkers": [{"name": v["name"], "target": v["target"]} for v in self.talkers.values()],
            "targets": self.intercom_target_list(), "events": list(self.events)[:25],
            "public_url": self.https_url() if getattr(self, "public_https", False) else None,
            "pc_out": self.pcout.public() if self.pcout else None, "spotify": self.spotify.status(self.ports["http"]),
            "autostart": self.autostart_on(), "bedtime": self.extras.bedtime_state(), "search": self.search.status(),
            "browsers": self.browser_rows(), "browser_hint": self.browser_hint(), "extension_urls": self.extension_urls(),
            "blocked_ips": self.orphan_blocks(),
            "commands": self.cfg["commands"], "share_dir": self.share_dir() if self.input_log is None else r"Downloads\PhoneBoxSound", "host": self.host.dev["name"] if self.host else None,
            "power": {"action": self.power_pending["action"], "by": self.power_pending["by"],
                      "seconds": max(0, round(self.power_pending["at"] - time.time()))} if self.power_pending else None,
        }

    async def toast_controls(self, msg):
        for ws in list(self.controls):
            await self._safe_send_str(ws, json.dumps({"t": "toast", "msg": msg}))

    @staticmethod
    async def _safe_send_str(ws, text):
        try:
            await ws.send_str(text)
        except Exception:
            pass

    async def change_port(self, port):
        """Move the whole server to another port, now. Returns a message if it could not."""
        if not getattr(self, "open_port", None):
            return "Changing the port isn't available in this mode"
        err = await self.open_port(port)          # the new port answers before anyone is sent there
        if err:
            return err
        old = self.ports["http"]
        self.ports["http"] = self.cfg["port"] = port
        self.cfg.save()
        self.event("settings", f"Moved from port {old} to port {port}")
        for c in list(self.clients.values()):     # each phone gets its own one-time pass to the new address
            c.send_json({"t": "moved", "port": port, "handoff": self.new_handoff(c.device_id, c.verified)}, urgent=True)
        for ws in list(self.controls):
            await self._safe_send_str(ws, json.dumps({"t": "moved", "port": port}))
        await self.broadcast_state()
        return None

    BROWSER_APPS = ("Chrome", "Edge", "Firefox", "Brave", "Opera", "Vivaldi")

    def browser_rows(self):
        """Browser extensions: approved, waiting for approval, and whether each is connected now."""
        live = {l["id"]: l for l in (self.media.browser.status() if getattr(self.media, "browser", None) else []) if l.get("id")}
        rows = [{"id": i, "name": b["name"], "approved": bool(b.get("approved")), "connected": i in live, "tabs": live[i]["tabs"] if i in live else 0}
                for i, b in self.cfg["browsers"].items()]
        rows += [{"id": None, "name": l["name"], "approved": True, "connected": True, "tabs": l["tabs"]}
                 for l in (self.media.browser.status() if getattr(self.media, "browser", None) else []) if not l.get("id")]
        return rows

    def browser_hint(self):
        """Browsers that are playing something right now without the extension: the dashboard offers it."""
        have = {r["name"] for r in self.browser_rows() if r["connected"]}
        seen = []
        for s in getattr(self.media, "sessions", []):
            app = next((b for b in self.BROWSER_APPS if s.get("provider") == "smtc" and b.lower() in str(s.get("app", "")).lower()), None)
            if app and app not in have and app not in seen:
                seen.append(app)
        return seen

    def orphan_blocks(self):
        """Blocked addresses that no longer belong to a phone on record (so they can still be lifted)."""
        owned = {d.get("last_ip") for d in self.cfg["devices"].values() if d.get("blocked")}
        return [ip for ip in self.cfg["blocked_ips"] if ip not in owned]

    async def share_info(self, theme=None):
        """What is playing, with its public link(s) and a QR code for each (see share.py)."""
        from . import share
        from .branding import qr_svg, valid
        a = self.media.active
        if not a:
            return {"t": "share_info", "title": "", "artist": "", "app": "", "art": None, "links": [], "why": "Nothing is playing."}
        key = (a.get("id"), a.get("title"), bool(a.get("_link")), int(float(a.get("position") or 0)) // 30)
        cached = getattr(self, "_share_cache", None)
        if not cached or cached[0] != key:
            prefer = next((s for s in ("spotify", "apple", "youtube") if s in str(a.get("app", "")).lower()), None)
            try:
                exact = []
                if self.spotify_active():
                    # Spotify itself says which song is playing: that is the link, not a guess by title
                    now = (await self.spotify.snapshot()).get("now") or {}
                    uri = str(now.get("uri") or "")
                    if uri.startswith("spotify:track:") and (not a.get("title") or share._words(now.get("title")) & share._words(a.get("title"))):
                        exact = [{"label": "Spotify", "url": share.to_web(uri), "exact": True}]
                found = await asyncio.wait_for(share.links_for(a, self.search, prefer), 15)
                links = exact + [l for l in found if not (exact and l["label"] == "Spotify")]
            except Exception as e:
                log.info("share lookup failed: %s", e)
                links = []
            self._share_cache = cached = (key, links)
        theme = valid(str(theme or self.cfg["theme"]))
        art = a.get("art") or (self.media.snaps[a["id"]][0] if a["id"] in self.media.snaps else None)
        return {"t": "share_info", "title": a.get("title") or "", "artist": a.get("artist") or "", "app": a.get("app") or "", "art": art,
                "links": [{**l, "svg": qr_svg(l["url"], theme, scale=6)} for l in cached[1]],
                "why": None if cached[1] else ("This is playing from a file on the PC, so there is no public link." if a.get("provider") not in ("smtc", "browser", "demo")
                                               else "No public link could be found for this.")}

    def _thumb(self, url):
        """A picture address on this PC for a picture on one of the services (phones never fetch from outside)."""
        from .search import THUMB_HOSTS, _host_ok
        if not _host_ok(url, THUMB_HOSTS):
            return None
        key = hashlib.sha1(url.encode()).hexdigest()[:16]
        self.search.thumbs.setdefault(key, url)
        return f"/thumb/{key}"

    def spotify_active(self):
        """Spotify is what's playing, and its account is linked: its own controls are exact."""
        a = self.media.active
        return bool(self.spotify.linked and a and "spotify" in str(a.get("app", "")).lower())

    async def coalesce(self, key, value, fn):
        """Sliders send a stream of values. Carrying each one out in turn made them lag behind the finger;
        only the newest matters, so anything that arrives while one is being carried out replaces the rest."""
        job = self._jobs.setdefault(key, {"running": False, "has": False})
        job["pending"], job["has"] = value, True
        if job["running"]:
            return
        job["running"] = True
        try:
            while job["has"]:
                job["has"] = False
                await fn(job["pending"])
        finally:
            job["running"] = False

    def overlay(self, media):
        """Corrections to what the players report, applied on every refresh (see MediaEngine.poll)."""
        now, live = time.time(), self.spotify.live if self.spotify.linked else None
        for s in media.sessions:
            if s.get("provider") != "smtc":
                continue
            sk = self._seeked.get(s["id"])
            fresh_seek = bool(sk and now - sk[1] < 5)
            if live and now - live["at"] < 8 and "spotify" in str(s.get("app", "")).lower():
                # Spotify's own numbers: exact, where Windows' copy of them lags
                if not (fresh_seek and sk[1] > live["at"]):
                    s["position"] = live["progress"] + ((now - live["at"]) if live["playing"] else 0)
                    fresh_seek = False
                if live["dur"]:
                    s["duration"] = live["dur"]
                s["shuffle"], s["repeat"] = live["shuffle"], live["repeat"]
                s["can"].update(seek=True, seek_to=True, shuffle=True, repeat=True)
                if live["volume"] is not None:
                    s["volume"] = live["volume"]
                    s["can"]["volume"] = True
            if fresh_seek:      # we just moved it: show that, until the player's own report catches up
                s["position"] = sk[0] + ((now - sk[1]) * (s.get("rate") or 1) if s.get("status") == "playing" else 0)
        if self.pcout and self.pcout.status == "playing":
            # the speakers you listen on are the ones PhoneBoxSound plays to: that is "the PC volume" now
            st = self.pcout.settings()
            media.pc = {"volume": min(1.0, float(st.get("volume", 1.0))), "muted": bool(st.get("muted"))}

    async def media_command(self, action, value=None, session=None):
        """Media remote commands, with the fast paths: sliders are coalesced, the volume goes to the output
        you actually listen on, and Spotify is steered through Spotify itself when its account is linked."""
        a = self.media.active
        own = not session or (a and session == a.get("id"))
        spotify = own and self.spotify_active() and not self.spotify.demo

        if action in ("pc_volume", "pc_mute") and self.pcout and self.pcout.status == "playing":
            st = self.pcout.settings()
            if action == "pc_volume":
                st["volume"], st["muted"] = clamp(float(value), 0, 1.5), False
            else:
                st["muted"] = bool(value)
            self.cfg["pc_out"] = st
            self.pcout.apply_volume()
            await self.media.announce()
            self._save_soon()
            return None
        if action == "pc_volume":
            async def set_pc(v):
                await asyncio.to_thread(self.media.volume.set, float(v), None)
                if self.media.pc:
                    self.media.pc = {**self.media.pc, "volume": float(v)}
                await self.media.announce()
            await self.coalesce("pc_volume", value, set_pc)
            return None
        if action == "volume" and spotify:
            async def set_sp(v):
                err = await self.spotify.do("volume", v)
                if err:
                    await self.toast_controls(err)
                await self.media.announce()
            await self.coalesce("sp_volume", value, set_sp)
            return None
        if action == "volume":
            async def set_app(v):
                await self.media.command("volume", v, session)
            await self.coalesce(f"volume:{session}", value, set_app)
            return None

        if action in ("seek", "seek_to") and a and own:
            try:
                now = time.time()
                at = float(a.get("position") or 0)
                # two quick presses of "+10" mean +20: count from where the last press is taking us, not from
                # where the player still says it is
                sk = self._seeked.get(a["id"])
                base = sk[0] + ((now - sk[1]) if a.get("status") == "playing" else 0) if sk and now - sk[1] < 2.5 else at
                target = float(value) if action == "seek_to" else base + float(value)
                target = max(0.0, min(target, float(a.get("duration") or target)))
            except (TypeError, ValueError):
                return None
            self._seeked[a["id"]] = (target, now)
            if spotify:
                async def seek_sp(v):
                    err = await self.spotify.do("seek", int(v * 1000))
                    self._seeked[a["id"]] = (v, time.time())
                    await self.media.announce()
                    if err:
                        await self.toast_controls(err)
                await self.coalesce("sp_seek", target, seek_sp)
                return None
            async def seek_any(v):
                await self.media.command("seek_to" if a.get("can", {}).get("seek_to", True) else "seek", v if a.get("can", {}).get("seek_to", True) else v - at, session)
            await self.coalesce(f"seek:{a['id']}", target, seek_any)
            await self.media.announce()
            return None

        if action in ("repeat", "shuffle") and own and self.spotify_active():
            if action == "repeat" and value not in ("off", "all", "one"):
                snap = await self.spotify.snapshot()
                value = {"off": "all", "all": "one", "one": "off"}[snap["repeat"]]
            if action == "shuffle" and value is None:
                value = not (await self.spotify.snapshot())["shuffle"]
            err = await self.spotify.do(action, value)
            if not err and self.spotify.live:
                self.spotify.live[action] = value
            await self.media.announce()
            return err or ({"off": "Repeat off", "all": "Repeat all", "one": "Repeat this song"}[value] if action == "repeat" else f"Shuffle {'on' if value else 'off'}")
        return await self.media.command(action, value, session)

    def _save_soon(self):
        """Settings touched by a slider are written once the slider rests, not on every step."""
        if getattr(self, "_save_task", None) and not self._save_task.done():
            return

        async def later():
            await asyncio.sleep(1.5)
            self.cfg.save()
        self._save_task = asyncio.ensure_future(later())

    async def queue_do(self, action, value=None):
        """One change to the queue of whatever is playing. Returns {"error": None | message}."""
        if action == "add":          # value is a search result id: only a Spotify track can go into Spotify's queue
            url = self.search.target(value) or ""
            if not url.startswith("spotify:track:"):
                return {"error": "Only Spotify songs can be added to Spotify's queue"}
            value = url
        if action in ("like", "unlike") and not value:
            value = ((await self.spotify.snapshot()).get("now") or {}).get("uri")
        if action == "playlist_add":
            # {"id": playlist, "track": a search result id}; without a track, the song that is playing now
            v = value if isinstance(value, dict) else {}
            uri = self.search.target(v.get("track")) if v.get("track") else ((await self.spotify.snapshot()).get("now") or {}).get("uri")
            if not str(uri or "").startswith("spotify:track:"):
                return {"error": "Only Spotify songs can be added to a Spotify playlist"}
            value = {"id": v.get("id"), "uri": uri}
            # Already in there? Then the phone asks first: "again" adds a second copy, "replace" leaves exactly one.
            again = v.get("dup")
            if again not in ("again", "replace"):
                n = await self.spotify.playlist_has(value["id"], uri)
                if n:
                    return {"error": None, "dup": n}
            elif again == "replace":
                err = await self.spotify.do("playlist_remove", value)
                if err:
                    return {"error": err}
        err = await self.spotify.do(action, value)
        if not err and action == "playlist_play":
            asyncio.ensure_future(self.spotify.refresh_live())
        return {"error": err}

    async def open_on_pc(self, url, by="the PC"):
        """Open one of the search module's own addresses on this PC. Returns what to tell the asker."""
        from .search import may_open
        if not url or not may_open(url):
            return "That result is no longer available. Search again."
        self.event("search", f"{by} opened {url.split('?')[0][:80]}")
        if self.input_log is not None:        # demo / tests: record, open nothing
            self.input_log.append({"kind": "open", "url": url})
            return None
        try:
            if url.startswith("spotify:track:") and self.spotify.linked:
                err = await self.spotify.do("play", url)      # plays in Spotify without bringing its window up
                if not err:
                    asyncio.ensure_future(self.spotify.refresh_live())
                    return None
            if url.startswith("https://") and await self.media.browser.open(url):
                return None                    # the extension reuses its tab instead of piling up new ones
            if url.startswith("spotify:"):
                await asyncio.to_thread(os.startfile, url)
            else:
                import webbrowser
                await asyncio.to_thread(webbrowser.open, url)
        except OSError as e:
            return f"The PC couldn't open it: {e}"
        return None

    def watch_links(self):
        """Once a second: note how each phone's connection is doing, tell the phone when it has been weak
        for a while, and move a phone with a poor connection to the lighter stream until it recovers."""
        now = time.time()
        for c in list(self.clients.values()):
            level = c.link()
            group = "bad" if level in ("weak", "poor") else "ok"
            was = "bad" if c.link_since[0] in ("weak", "poor") else "ok"
            if c.link_since[0] is None or group != was:
                c.link_since = (level, now)
            else:
                c.link_since = (level, c.link_since[1])
            lasted, changed = now - c.link_since[1], False
            speaker = c.dev["speaker"] and c.perms["speaker"]
            if self.cfg.get("auto_quality", True) and speaker and c.dev.get("quality") != "saver":
                if level == "poor" and lasted > 8 and not c.auto_saver:
                    c.auto_saver, changed = True, True
                    self.note(c.device_id, "link", {"now": "data saver", "why": "the connection stayed poor"})
                elif c.auto_saver and group == "ok" and lasted > 45:
                    c.auto_saver, changed = False, True
                    self.note(c.device_id, "link", {"now": "full quality", "why": "the connection recovered"})
            elif c.auto_saver:
                c.auto_saver, changed = False, True
            # the phone shows its own "come closer" notice from these; send when the answer changes
            told = (level, lasted > 6 if group == "bad" else False, c.auto_saver)
            if changed or told != getattr(c, "_link_told", None):
                c._link_told = told
                self.push_config([c])

    def keyboard_hint(self, c, m):
        """After the pointer moved or clicked: is the PC now on a text box? The phone opens (or closes) its
        keyboard from that. Checked once the pointer rests, not on every movement."""
        if not (self.textfocus and getattr(c, "kbd_watch", False) and self.cfg.get("auto_keyboard", True)):
            return
        kind = m.get("kind")
        if kind == "move":
            want, delay = "over", 0.09
        elif kind == "click" and m.get("button", "left") == "left":
            want, delay = "focus", 0.22          # give the click time to move the focus
        else:
            return
        timers = c.__dict__.setdefault("kbd_timers", {})
        if timers.get(want):
            timers[want].cancel()
        timers[want] = asyncio.get_running_loop().call_later(delay, lambda: asyncio.ensure_future(self._keyboard_check(c, want)))

    async def _keyboard_check(self, c, want):
        tf = self.textfocus
        try:
            value = bool(await asyncio.to_thread(tf.focused if want == "focus" else tf.over))
        except Exception:
            return
        if self.clients.get(c.id) is not c:
            return
        if want == "focus":
            c.kbd_over = value
            c.send_json({"t": "kbd", "focus": value, "over": value}, urgent=True)
        elif value != getattr(c, "kbd_over", None):
            c.kbd_over = value
            c.send_json({"t": "kbd", "over": value}, urgent=True)

    def extension_urls(self):
        """Where to get the extension: a link set in Settings, else the published store pages that ship with
        this version (extension/stores.json)."""
        own = self.cfg.get("extension_urls") or {}
        try:
            from .extpack import shipped_stores
            shipped = shipped_stores()
        except Exception:
            shipped = {}
        return {k: own.get(k) or shipped.get(k) or "" for k in ("chrome", "firefox", "edge")}

    def autostart_on(self):
        if self.input_log is not None:           # demo / tests never touch the real registry
            return bool(getattr(self, "_demo_autostart", False))
        if not hasattr(self, "_autostart"):
            from . import autostart
            self._autostart = autostart.enabled()
        return self._autostart

    async def broadcast_state(self):
        self.push_studio()
        if not self.controls:
            return
        msg = json.dumps(self.state())
        for ws in list(self.controls):
            try:
                await ws.send_str(msg)
            except Exception:
                self.controls.discard(ws)

    async def on_media(self, public):
        msg = json.dumps({"t": "media", **public})
        for c in self.clients.values():
            c.send(msg)
        for ws in list(self.controls):
            try:
                await ws.send_str(msg)
            except Exception:
                self.controls.discard(ws)
        active = public.get("active")
        key = (active or {}).get("title"), (active or {}).get("status")
        if key != getattr(self, "_media_key", None):
            self._media_key = key
            if active:
                self.fire_webhook("media_changed", {"app": active["app"], "title": active["title"], "status": active["status"]})

    def set_layout(self, kind):
        i = 0
        for device_id, dev in sorted(self.cfg["devices"].items(), key=lambda kv: kv[1]["order"]):
            if kind == "split":
                if self.online(device_id):
                    dev["channel"] = ("left", "right")[i % 2]
                    i += 1
            elif kind in CHANNEL_MODES:
                dev["channel"] = kind

    def apply_scene(self, scene_id):
        scene = next((s for s in self.cfg["scenes"] if s["id"] == scene_id), None)
        if not scene:
            return
        s = scene["set"]
        if "auto_latency" in s:
            self.cfg["auto_latency"] = bool(s["auto_latency"])
        if "latency_ms" in s:
            self.cfg["latency_ms"] = int(s["latency_ms"])
        if "master" in s:
            self.cfg["master"] = float(s["master"])
        if "layout" in s:
            self.set_layout(s["layout"])
        for device_id, channel in scene.get("channels", {}).items():
            if device_id in self.cfg["devices"] and channel in CHANNEL_MODES:
                self.cfg["devices"][device_id]["channel"] = channel
        if "eq" in s:
            for dev in self.cfg["devices"].values():
                dev["eq"] = s["eq"]
        if "source" in s and s["source"] != self.cfg["source"]:
            self.cfg["source"] = s["source"]
            self.capture.configure(self.cfg["source"], self.cfg["device"])
        if s.get("mute_pc"):
            self.media.volume.set(muted=True)
        self.cfg["streaming"] = True
        self.cfg.save()
        self.push_config()
        self.event("scene_applied", f"Scene: {scene['name']}", scene=scene["name"])

    TERMS = "1"     # raise when DISCLAIMER.md changes in a way people must see again

    def terms_ok(self):
        return self.cfg.get("terms_accepted") == self.TERMS or self.desktop.demo

    def accept_terms(self):
        if self.cfg.get("terms_accepted") != self.TERMS:
            self.cfg["terms_accepted"] = self.TERMS
            self.cfg.save()
            self.event("security", "The terms of use were accepted")

    async def handle_control(self, m, ws=None):
        """Dashboard commands. Returns an optional reply dict."""
        t = m.get("t")
        cfg = self.cfg
        reply = None
        if t == "video_install" and self.video:
            async def run():
                await self.video.install(lambda: asyncio.ensure_future(self.broadcast_state()))
                self.event("system", "Screen video: " + (f"ready ({self.video.encoder[1]})" if self.video.encoder else self.video.error or "not available"))
                await self.broadcast_state()
            asyncio.ensure_future(run())
            await self.broadcast_state()
        elif t == "video_check" and self.video:
            await self.video.check(force=True)
            await self.broadcast_state()
        if t == "accept_terms":
            self.accept_terms()
            await self.broadcast_state()
        if t == "set_global":
            if "latency_ms" in m:
                cfg["latency_ms"] = int(clamp(float(m["latency_ms"]), 40, 2000))
                cfg["auto_latency"] = False
            for key, lo, hi in (("min_latency_ms", 40, 1000), ("max_latency_ms", 100, 2000)):
                if key in m:
                    cfg[key] = int(clamp(float(m[key]), lo, hi))
            if "auto_latency" in m:
                cfg["auto_latency"] = bool(m["auto_latency"])
            if "master" in m:
                cfg["master"] = clamp(float(m["master"]), 0, 1.5)
            if "duck_level" in m:
                cfg["duck_level"] = clamp(float(m["duck_level"]), 0, 1)
            if "streaming" in m:
                cfg["streaming"] = bool(m["streaming"])
                self.event("streaming", "Streaming resumed" if cfg["streaming"] else "Streaming paused")
            if m.get("theme") in THEMES:
                cfg["theme"] = m["theme"]
            if m.get("mode") in MODES:
                cfg["mode"] = m["mode"]
            for key in ("mdns", "https", "lip_sync", "strict", "public_https", "lockdown", "approval", "browser_delay", "auto_quality", "auto_keyboard", "activity", "screen_video"):
                if key in m:
                    cfg[key] = bool(m[key])
            if "activity" in m:
                self.event("security", "The activity record was switched " + ("on" if cfg["activity"] else "off"))
                self.push_config()
            if "lockdown" in m:
                self.event("security", "Lockdown ON: phones can't control the PC, new phones can't join" if cfg["lockdown"] else "Lockdown off")
            if "webhooks" in m:
                cfg["webhooks"] = [str(u).strip() for u in m["webhooks"] if str(u).strip().startswith(("http://", "https://"))][:10]
            for integ in ("vlc", "mpv"):
                if isinstance(m.get(integ), dict):
                    cfg[integ].update({k: v for k, v in m[integ].items() if k in ("enabled", "port", "password", "pipe")})
            cfg.save()
            self.push_config()
            self.broadcast_targets()
        elif t == "set_source":
            cfg["source"] = m.get("source") if m.get("source") in SOURCES else "system"
            cfg["device"] = m.get("device") or None
            cfg.save()
            self.capture.configure(cfg["source"], cfg["device"])
        elif t == "set_device" and m.get("device_id") in cfg["devices"]:
            dev = cfg["devices"][m["device_id"]]
            p = m.get("patch", {})
            if "volume" in p:
                dev["volume"] = clamp(float(p["volume"]), 0, 1.5)
            if p.get("channel") in CHANNEL_MODES:
                dev["channel"] = p["channel"]
            if p.get("eq") in EQ_MODES:
                dev["eq"] = p["eq"]
            if p.get("quality") in ("full", "saver"):
                dev["quality"] = p["quality"]
            if "offset_ms" in p:
                dev["offset_ms"] = int(clamp(float(p["offset_ms"]), -1000, 1000))
            for key in ("muted", "speaker"):
                if key in p:
                    dev[key] = bool(p[key])
            if p.get("zone") in cfg["zones"]:
                dev["zone"] = p["zone"]
            if "system_note" in p:
                dev["system_note"] = clean_name(p["system_note"])[:60]
            if isinstance(p.get("perms"), dict):
                for k in PERMS:
                    if k in p["perms"]:
                        dev["perms"][k] = bool(p["perms"][k])
            cfg.save()
            c = self.online(m["device_id"])
            if c:
                self.push_config([c])
            if "name" in p:
                await self.rename(m["device_id"], p["name"])
        elif t == "reorder" and isinstance(m.get("order"), list):
            for i, device_id in enumerate(m["order"]):
                if device_id in cfg["devices"]:
                    cfg["devices"][device_id]["order"] = i
            cfg.save()
            self.push_config()
        elif t == "layout":
            self.set_layout(m.get("kind"))
            cfg.save()
            self.push_config()
        elif t == "identify":
            c = self.online(m.get("device_id"))
            if c:
                c.send_json({"t": "identify", "index": self.device_config(c)["index"]}, urgent=True)
        elif t == "kick":
            c = self.online(m.get("device_id"))
            if c:
                c.send_json({"t": "kicked"}, urgent=True)
                await asyncio.sleep(0.2)
                await c.ws.close()
        elif t == "approve":
            await self.decide(str(m.get("device_id") or ""), bool(m.get("ok")))
        elif t == "forget" and m.get("device_id") in cfg["devices"]:
            c = self.online(m["device_id"])
            gone = cfg["devices"].pop(m["device_id"])
            if gone.get("blocked") and gone.get("last_ip"):
                # removing a blocked phone lifts the block on its address too: otherwise the address stays
                # shut with nothing left on screen to open it again
                cfg["blocked_ips"] = [x for x in cfg["blocked_ips"] if x != gone["last_ip"]]
            self.event("device", f"{gone['name']} ({gone.get('system') or gone.get('platform') or 'unknown system'}, {gone.get('last_ip') or 'no address'}) was removed on the PC")
            cfg.save()
            if c:
                c.send_json({"t": "kicked", "forget": True}, urgent=True)
                await asyncio.sleep(0.2)
                await c.ws.close()
        elif t == "disconnect_all":
            for c in list(self.clients.values()):
                c.send_json({"t": "kicked"}, urgent=True)
            await asyncio.sleep(0.2)
            for c in list(self.clients.values()):
                await c.ws.close()
        elif t == "new_code":
            self.code = self._new_code()
        elif t == "zone_add":
            name = str(m.get("name", "")).strip()[:32]
            if name and name not in cfg["zones"]:
                cfg["zones"][name] = {"volume": 1.0, "muted": False}
        elif t == "zone_set" and m.get("name") in cfg["zones"]:
            z = cfg["zones"][m["name"]]
            if "volume" in m:
                z["volume"] = clamp(float(m["volume"]), 0, 1.5)
            if "muted" in m:
                z["muted"] = bool(m["muted"])
            new = str(m.get("rename") or "").strip()[:32]
            if new and new not in cfg["zones"]:
                cfg["zones"][new] = cfg["zones"].pop(m["name"])
                for dev in cfg["devices"].values():
                    if dev["zone"] == m["name"]:
                        dev["zone"] = new
            self.push_config()
            self.broadcast_targets()
        elif t == "zone_delete" and m.get("name") in cfg["zones"] and len(cfg["zones"]) > 1:
            cfg["zones"].pop(m["name"])
            first = next(iter(cfg["zones"]))
            for dev in cfg["devices"].values():
                if dev["zone"] == m["name"]:
                    dev["zone"] = first
            self.push_config()
            self.broadcast_targets()
        elif t == "scene_apply":
            self.apply_scene(m.get("id"))
        elif t == "scene_save":
            name = str(m.get("name", "")).strip()[:32] or "My scene"
            online_channels = {d: cfg["devices"][d]["channel"] for d in cfg["devices"]}
            cfg["scenes"].append({
                "id": secrets.token_hex(4), "name": name, "icon": "star", "desc": "Saved from current setup",
                "set": {"auto_latency": cfg["auto_latency"], "latency_ms": cfg["latency_ms"], "master": cfg["master"],
                        "source": cfg["source"], "eq": next(iter({d["eq"] for d in cfg["devices"].values()}), "flat")},
                "channels": online_channels})
        elif t == "scene_delete":
            cfg["scenes"] = [s for s in cfg["scenes"] if s["id"] != m.get("id")]
        elif t == "scenes_reset":
            from .config import DEFAULT_SCENES
            cfg["scenes"] = json.loads(json.dumps(DEFAULT_SCENES))
        elif t == "media":
            msg = await self.media_command(m.get("action"), m.get("value"), m.get("session"))
            if msg:
                reply = {"t": "toast", "msg": msg}
        elif t == "intercom_start":
            await self.set_talking(("pc", id(ws)), "PC", str(m.get("target") or "all"))
        elif t == "intercom_stop":
            await self.set_talking(("pc", id(ws)), "PC", None)
        elif t == "setup_player" and m.get("app") in ("mpc", "vlc"):
            app = m["app"]
            player = self.media.mpc if app == "mpc" else self.media.vlc
            result = await asyncio.to_thread(player.enable_full_control, bool(m.get("restart")))
            if result == "restart_needed":
                reply = {"t": "setup_confirm", "app": app}
            else:
                self.media._players_at = 0
                label = "MPC-HC" if app == "mpc" else "VLC"
                msg = f"{label} full control is on" + (". Reopening your video…" if m.get("restart") else "") if result == "ok" else result
                self.event("integration", msg)
                reply = {"t": "toast", "msg": msg}
        elif t == "verify_device":
            c = self.online(m.get("device_id"))
            if c and c.pending_pub:
                c.dev["pubkey"], c.pending_pub, c.verified = c.pending_pub, None, True
                self.event("security", f"{c.dev['name']} was verified")
                self.push_config([c])
        elif t == "bedtime":
            err = None if not m.get("cancel") else await self.extras.bedtime_cancel()
            if not m.get("cancel"):
                err = await self.extras.bedtime_start(m.get("minutes"), str(m.get("after") or "pause"))
            if err:
                await self.toast_controls(err)
        elif t == "announce":
            asyncio.ensure_future(self.extras.announce(m.get("text"), str(m.get("sound") or "ding"), str(m.get("target") or "all")))
        elif t == "guest_pass":
            if cfg["lockdown"]:
                await self.toast_controls("Lockdown is on: no guest passes")
            else:
                from .branding import qr_svg, valid
                token = self.extras.guest_pass(m.get("hours") or 2)
                url = (self.https_url() or self.http_url()) + f"/?guest={token}"
                reply = {"t": "guest_pass", "url": url, "until": self.extras.passes[token]["until"], "hours": self.extras.passes[token]["hours"],
                         "svg": qr_svg(url, valid(cfg["theme"]))}
        elif t == "playlists_get":
            reply = {"t": "playlists", "rid": m.get("rid"), **await self.spotify.playlists()}
        elif t == "queue_get":
            reply = {"t": "queue_info", "rid": m.get("rid"), **await self.spotify.snapshot()}
        elif t == "queue_do":
            reply = {"t": "queue_done", "rid": m.get("rid"), **await self.queue_do(str(m.get("action")), m.get("value"))}
        elif t == "spotify_unlink":
            self.spotify.unlink()
            self.event("settings", "The Spotify account was disconnected")
        elif t == "share":
            reply = {**await self.share_info(m.get("theme")), "rid": m.get("rid")}
        elif t == "search":
            reply = {"t": "search_results", "rid": m.get("rid"), "can_queue": self.spotify.linked, **await self.search.query(m.get("q"), str(m.get("service") or "all"))}
        elif t == "suggest":
            reply = {"t": "suggestions", "rid": m.get("rid"), "list": await self.search.suggest(m.get("q"))}
        elif t == "search_open":
            err = await self.open_on_pc(self.search.target(m.get("id")))
            if err:
                await self.toast_controls(err)
        elif t == "set_search":
            st = self.search.settings()
            for k in ("youtube_key", "spotify_id", "spotify_secret"):
                if isinstance(m.get(k), str):
                    st[k] = m[k].strip()[:200]
            cfg["search"] = st
            self.search._spotify = (None, 0)
            self.search._cache.clear()
            cfg.save()
        elif t == "set_pc_out" and self.pcout:
            st = self.pcout.settings()
            if "enabled" in m:
                st["enabled"] = bool(m["enabled"])
            if "device" in m:
                st["device"] = str(m["device"])[:200] if m["device"] else None
            if "offset_ms" in m:
                st["offset_ms"] = int(clamp(float(m["offset_ms"]), -500, 500))
            if "volume" in m:
                st["volume"] = clamp(float(m["volume"]), 0, 1.5)
            cfg["pc_out"] = st
            cfg.save()
            if self.input_log is None:
                await asyncio.to_thread(self.pcout.tick, (cfg["master"] * self.extras.fade) if cfg["streaming"] else 0.0)
        elif t == "unblock_ip":
            cfg["blocked_ips"] = [x for x in cfg["blocked_ips"] if x != m.get("ip")]
            cfg.save()
            self.event("block", f"The address {m.get('ip')} was unblocked")
        elif t == "browser_approve" and m.get("id") in cfg["browsers"]:
            b = cfg["browsers"][m["id"]]
            if m.get("ok", True):
                b["approved"] = True
                self.event("browser", f"The {b['name']} extension was approved")
            else:
                del cfg["browsers"][m["id"]]
                self.media.browser.drop(m["id"])
                self.event("browser", f"The {b['name']} extension was removed")
            cfg.save()
        elif t == "extension_urls" and isinstance(m.get("urls"), dict):
            cfg["extension_urls"] = {k: (str(m["urls"].get(k) or "").strip()[:300] if str(m["urls"].get(k) or "").startswith("https://") else "") for k in ("chrome", "firefox", "edge")}
            cfg.save()
        elif t == "set_autostart":
            if self.input_log is not None:
                self._demo_autostart = bool(m.get("on"))
            else:
                from . import autostart
                try:
                    self._autostart = autostart.set_enabled(bool(m.get("on")))
                except OSError as e:
                    await self.toast_controls(f"Couldn't change it: {e}")
            self.event("settings", "Starts with Windows" if self.autostart_on() else "No longer starts with Windows")
        elif t == "set_port":
            try:
                port = int(m.get("port"))
            except (TypeError, ValueError):
                port = 0
            err = "Choose a port between 1024 and 65535" if not 1024 <= port <= 65535 else \
                "That is the secure server's own port" if port == self.ports.get("https") else \
                None if port != self.ports["http"] else "That is already the port"
            err = err or await self.change_port(port)
            if err:
                await self.toast_controls(err)
        elif t == "confirm_system" and m.get("device_id") in cfg["devices"]:
            dev = cfg["devices"][m["device_id"]]
            dev["system_was"] = ""
            cfg.save()
            self.event("security", f"{dev['name']}: the change of system was confirmed on the PC")
            self.push_config()
        elif t == "reset_key" and m.get("device_id") in cfg["devices"]:
            cfg["devices"][m["device_id"]]["pubkey"] = None
            c = self.online(m["device_id"])
            if c:
                c.verified = False
                c.send_json({"t": "kicked", "msg": "Security key reset on the PC. Connect again."}, urgent=True)
                await asyncio.sleep(0.2)
                await c.ws.close()
        elif t == "block" and m.get("device_id") in cfg["devices"]:
            dev = cfg["devices"][m["device_id"]]
            dev["blocked"] = bool(m.get("on", True))
            dev["approved"], dev["forgotten"] = True, 0      # shown as a blocked phone; pairing again needs approval anyway
            w = self.waiting.pop(m["device_id"], None)
            if w and dev["blocked"]:
                asyncio.ensure_future(w["ws"].close())
            ip = dev.get("last_ip")
            if ip and ip not in ("127.0.0.1", "::1"):
                cfg["blocked_ips"] = [x for x in cfg["blocked_ips"] if x != ip] + ([ip] if dev["blocked"] else [])
            c = self.online(m["device_id"])
            if dev["blocked"]:
                dev["token_hash"] = None
                self.event("block", f"{dev['name']} was blocked")
                if c:
                    c.send_json({"t": "kicked", "forget": True, "msg": "This phone was blocked by the PC"}, urgent=True)
                    await asyncio.sleep(0.2)
                    await c.ws.close()
            else:
                self.event("block", f"{dev['name']} was unblocked")
        elif t == "command_add" and str(m.get("run", "")).strip():
            cfg["commands"].append({"id": secrets.token_hex(4), "name": str(m.get("name") or m["run"]).strip()[:40], "run": str(m["run"]).strip()[:500]})
            self.push_config()
        elif t == "command_delete":
            cfg["commands"] = [x for x in cfg["commands"] if x["id"] != m.get("id")]
            self.push_config()
        elif t == "open_share":
            if not self.desktop.demo:
                os.startfile(self.share_dir())
        elif t == "host_stop":
            await self.host_stop()
        elif t == "power_cancel":
            self.power_cancel()
        elif t == "rotate_api_token":
            cfg["api_token"] = secrets.token_urlsafe(18)
        elif t == "calibrate":
            reply = self.start_calibration()
        cfg.save()
        await self.broadcast_state()
        return reply

    # ------------------------------------------------------- calibration --

    def start_calibration(self):
        speakers = [c for c in self.clients.values() if c.dev["speaker"] and c.perms["speaker"]]
        if len(speakers) < 1:
            return {"t": "toast", "msg": "Connect at least one phone first"}
        start = now_ms() + 1500
        beeps = []
        for i, c in enumerate(speakers):
            at = start + i * 800
            beeps.append({"id": c.device_id, "at_ms": at + self.cfg["latency_ms"], "name": c.dev["name"]})
            c.send_json({"t": "calib_beep", "at": at}, urgent=True)
        slots = len(speakers)
        if self.pcout and self.pcout.status == "playing":
            # this PC's own speakers / headphones chirp too, in the next slot, timed like a phone
            at = start + slots * 800
            self.pcout.chirp(at)
            beeps.append({"id": "pc", "at_ms": at + self.cfg["latency_ms"], "name": f"This PC ({self.pcout.device})"})
            slots += 1
        self.calib = {"id": secrets.token_hex(4), "beeps": beeps, "created": time.time()}
        return {"t": "calib_plan", "id": self.calib["id"], "beeps": beeps,
                "record_until_ms": start + slots * 800 + self.cfg["latency_ms"] + 800}

    def finish_calibration(self, plan_id, pcm, sr, rec_start_ms, apply=True, match_volume=False):
        from .calibrate import analyze
        if not self.calib or self.calib["id"] != plan_id:
            raise ValueError("Calibration expired, start again")
        rec = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768
        result = analyze(rec, sr, rec_start_ms, self.calib["beeps"])
        out = []
        # Loudness matching: every chirp is played at the same digital level, so how loud the mic heard
        # each one tells us how loud that phone is from where you sit. Bring all down to the quietest.
        heard = [r["level"] for k, r in result.items() if k != "pc" and r.get("delay_ms") is not None and r.get("level", 0) > 0]
        quietest = min(heard) if heard else None
        for b in self.calib["beeps"]:
            r = result.get(b["id"], {"delay_ms": None, "confidence": 0})
            if b["id"] == "pc" and self.pcout:
                st = self.pcout.settings()
                new = st.get("offset_ms", 0)
                if apply and r["delay_ms"] is not None and abs(r["delay_ms"]) < 400:
                    new = int(round(clamp(new - r["delay_ms"], -500, 500)))
                    st["offset_ms"] = new
                    self.cfg["pc_out"] = st
                out.append({"device_id": "pc", "name": b["name"], **{k: v for k, v in r.items() if k != "level"}, "offset_ms": new, "volume": st.get("volume", 1.0)})
                continue
            dev = self.cfg["devices"].get(b["id"])
            if dev is None:
                continue
            new = dev["offset_ms"]
            if apply and r["delay_ms"] is not None and abs(r["delay_ms"]) < 400:
                new = int(round(clamp(dev["offset_ms"] - r["delay_ms"], -1000, 1000)))
                dev["offset_ms"] = new
                if match_volume and quietest and r.get("level"):
                    dev["volume"] = round(clamp(quietest / r["level"], 0.15, 1.0), 2)
            r = {k: v for k, v in r.items() if k != "level"}
            out.append({"device_id": b["id"], "name": b["name"], **r, "offset_ms": new, "volume": dev["volume"]})
        self.cfg.save()
        self.push_config()
        self.calib = None
        return out

    # -------------------------------------------------------------- loops --

    async def auto_latency_tick(self):
        cfg = self.cfg
        if not cfg["auto_latency"]:
            return
        # Ignore phones whose measurement can't be trusted right now (clock being re-measured, page in
        # the background, absurd values) so one confused phone can't drag everyone's delay up.
        needs = [c.stats["need_ms"] for c in self.clients.values()
                 if c.dev["speaker"] and c.perms["speaker"] and isinstance(c.stats.get("need_ms"), (int, float))
                 and c.stats.get("played", 0) > 300 and not c.stats.get("hidden")
                 and 0 < c.stats["need_ms"] < 2000 and c.stats.get("rtt_ms", 0) < 400
                 # a phone showing the PC screen measures the pictures' traffic too; it is protected by the
                 # pictures making way (see _screen_loop), and must not delay every phone's sound for them
                 and not getattr(c, "screen_mode", None)]
        if not needs:
            return
        target = int(clamp(max(needs) + 25, cfg["min_latency_ms"], cfg["max_latency_ms"]))
        target = (target + 9) // 10 * 10
        cur = cfg["latency_ms"]
        now = time.time()
        if target > cur + 5:
            cfg["latency_ms"] = target  # raise at once: protects against dropouts
            self.latency_changed_at = now
            log.info("auto buffer raised to %d ms", target)
        elif target < cur - 30 and now - self.latency_changed_at > 20:
            cfg["latency_ms"] = cur - 10  # lower gently; phones absorb 10 ms steps without a glitch
            self.latency_changed_at = now - 15
        else:
            return
        cfg.save()
        self.push_config()

    async def periodic(self):
        tick = 0
        while True:
            await asyncio.sleep(0.05)
            tick += 1
            if tick % 20 == 0 and self.journal:
                self.journal.flush()
            if self.controls:
                msg = json.dumps({"t": "levels", "l": round(self.peak[0], 3), "r": round(self.peak[1], 3),
                                  "bands": self.spectrum.bands() if tick % 2 == 0 else None})
                for ws in list(self.controls):
                    try:
                        await ws.send_str(msg)
                    except Exception:
                        self.controls.discard(ws)
            self.peak = [0.0, 0.0]
            if tick % 20 == 0:
                await self.broadcast_state()
            if tick % 40 == 0:
                await self.auto_latency_tick()
            if tick % 100 == 50:
                await self.extras.sweep()
            if tick % 20 == 5:
                self.watch_links()
            if tick % 40 == 30 and self.spotify_active():
                asyncio.ensure_future(self.spotify.refresh_live())
            if tick % 20 == 15 and self.pcout and self.input_log is None:
                # the PC's own output follows the same switches as the phones: paused, master volume, bedtime fade
                await asyncio.to_thread(self.pcout.tick, (self.cfg["master"] * self.extras.fade) if self.cfg["streaming"] else 0.0)
            if tick % 60 == 0:
                await self.follow_default_device()
            if tick % 20 == 10:
                await self.watch_clipboard()
            if tick % 5 == 0 and self.host:
                self.host.send_json({"t": "host_buf", "ms": self.capture.host_buffered_ms()})
            if tick % 40 == 20:
                speakers = any(c.dev["speaker"] and c.perms["speaker"] for c in self.clients.values())
                await self.media.lip_sync(self.cfg["latency_ms"] if speakers and self.cfg["streaming"] and self.cfg.get("lip_sync", True) else 0)

    async def follow_default_device(self):
        # Windows default output changed (headphones plugged in, etc.) - follow it.
        if self.cfg["source"] != "system" or self.cfg["device"]:
            return
        dev_id = await asyncio.to_thread(self.media.volume.default_device_id)
        if dev_id and self.last_default_dev and dev_id != self.last_default_dev:
            log.info("default output changed, restarting capture")
            self.event("device", "Windows output changed, switching capture")
            self.capture.restart()
        self.last_default_dev = dev_id or self.last_default_dev
