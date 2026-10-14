"""Media engine: finds what's playing on the PC and controls it.

Providers:
  * smtc - Windows "System Media Transport Controls": Chrome, Edge, Firefox, Spotify,
           Windows Media Player, Netflix app, VLC 4, ... (anything that shows in the
           Windows volume flyout)
  * vlc  - VLC 3 through its Web interface (Tools > Preferences > All > Main interfaces)
  * mpv  - mpv started with --input-ipc-server=\\\\.\\pipe\\mpvsocket

Every provider reports sessions in one shape, so the phones never care where media came from.
"""
import asyncio
import base64
import datetime
import hashlib
import json
import logging
import os
import re
import sys
import time

# comtypes (used by pycaw) would otherwise put the main thread in a single-threaded COM
# apartment, which deadlocks the WinRT media calls awaited on the asyncio loop.
sys.coinit_flags = 0  # COINIT_MULTITHREADED

from . import inputctl

log = logging.getLogger("pbs.media")

try:
    from winrt.windows.media.control import (
        GlobalSystemMediaTransportControlsSessionManager as SmtcManager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as SmtcStatus,
    )
    from winrt.windows.storage.streams import Buffer, InputStreamOptions
except Exception:  # not Windows or winrt missing
    SmtcManager = None

try:
    from winrt.windows.media import MediaPlaybackAutoRepeatMode as RepeatMode
except Exception:
    RepeatMode = None

REPEAT_MODES = ("off", "all", "one")

try:
    from pycaw.pycaw import AudioUtilities
    import comtypes
except Exception:
    AudioUtilities = None

APP_NAMES = {
    "chrome": "Chrome", "msedge": "Edge", "firefox": "Firefox", "308046b0af4a39cb": "Firefox",
    "spotify": "Spotify", "vlc": "VLC", "mpv": "mpv", "brave": "Brave", "opera": "Opera",
    "zunemusic": "Media Player", "microsoft.zunevideo": "Movies & TV", "netflix": "Netflix",
    "applemusic": "Apple Music", "tidal": "TIDAL", "deezer": "Deezer", "discord": "Discord",
}
BROWSERS = {"Chrome", "Edge", "Firefox", "Brave", "Opera"}


def app_label(aumid):
    low = (aumid or "").lower()
    for key, name in APP_NAMES.items():
        if key in low:
            return name
    base = os.path.basename(aumid or "App").split("!")[0].split("_")[0]
    return base.replace(".exe", "") or "App"


def app_kind(label):
    if label in BROWSERS:
        return "browser"
    return label.lower()


def _secs(v):
    if isinstance(v, datetime.timedelta):
        return v.total_seconds()
    return float(v or 0)


# ------------------------------------------------------------ PC volume ---


class PcVolume:
    """Master volume and mute of the default Windows output (does not affect loopback capture)."""

    def __init__(self):
        self.ok = AudioUtilities is not None

    def _endpoint(self):
        comtypes.CoInitialize()
        return AudioUtilities.GetSpeakers().EndpointVolume

    def get(self):
        if not self.ok:
            return None
        try:
            ev = self._endpoint()
            return {"volume": round(ev.GetMasterVolumeLevelScalar(), 3), "muted": bool(ev.GetMute())}
        except Exception as e:
            log.debug("volume get failed: %s", e)
            return None

    def set(self, volume=None, muted=None):
        if not self.ok:
            return
        try:
            ev = self._endpoint()
            if volume is not None:
                ev.SetMasterVolumeLevelScalar(max(0.0, min(1.0, float(volume))), None)
            if muted is not None:
                ev.SetMute(1 if muted else 0, None)
        except Exception as e:
            log.warning("volume set failed: %s", e)

    def default_device_id(self):
        if not self.ok:
            return None
        try:
            comtypes.CoInitialize()
            return AudioUtilities.GetSpeakers().id
        except Exception:
            return None


# ------------------------------------------------------------ providers ---


class SmtcProvider:
    name = "smtc"

    def __init__(self):
        self.mgr = None
        self.art = {}  # session id -> (hash, bytes, content_type)
        self._titles = {}
        self._timeline = {}  # session id -> (position, duration, (title, artist))

    async def sessions(self):
        if SmtcManager is None:
            return []
        if self.mgr is None:
            self.mgr = await SmtcManager.request_async()
        out = []
        for s in self.mgr.get_sessions():
            try:
                d = await self._describe(s)
            except Exception as e:
                log.debug("smtc session read failed: %s", e)
                continue
            if d["album"] != "PhoneBoxSound":  # our own phone page opened on this PC - don't remote-control ourselves
                out.append(d)
        return out

    async def _describe(self, s):
        aumid = s.source_app_user_model_id
        sid = "smtc:" + aumid
        props = await s.try_get_media_properties_async()
        pb = s.get_playback_info()
        tl = s.get_timeline_properties()
        c = pb.controls
        status = {SmtcStatus.PLAYING: "playing", SmtcStatus.PAUSED: "paused",
                  SmtcStatus.STOPPED: "stopped"}.get(pb.playback_status, "idle")
        rate = pb.playback_rate or 1.0
        pos, end = _secs(tl.position), _secs(tl.end_time)
        # Apps only update the timeline now and then; extrapolate from the last update.
        try:
            upd = tl.last_updated_time
            if status == "playing" and upd and upd.year > 2000:
                elapsed = (datetime.datetime.now(datetime.timezone.utc) - upd).total_seconds()
                if 0 < elapsed < 24 * 3600:
                    pos += elapsed * rate
        except Exception:
            pass
        key = (props.title, props.artist)
        # Some players (Firefox) blank the timeline after a seek while paused: keep the last good one.
        cached = self._timeline.get(sid)
        if end <= 0 and cached and cached[2] == key:
            pos, end = cached[0], cached[1]
        elif end > 0:
            self._timeline[sid] = (pos, end, key)
        if end:
            pos = min(pos, end)
        if self._titles.get(sid) != key:
            self._titles[sid] = key
            await self._load_art(sid, props.thumbnail)
        label = app_label(aumid)
        return {
            "id": sid, "provider": "smtc", "app": label, "kind": app_kind(label),
            "title": props.title or "", "artist": props.artist or props.album_artist or "",
            "album": props.album_title or "", "status": status,
            "position": round(max(pos, 0), 2), "duration": round(end, 2), "rate": rate,
            "art": self.art[sid][0] if sid in self.art else None,
            "can": {"play": bool(c.is_play_enabled or c.is_pause_enabled or c.is_play_pause_toggle_enabled),
                    "next": bool(c.is_next_enabled), "previous": bool(c.is_previous_enabled),
                    "seek": bool(c.is_playback_position_enabled) and end > 0,
                    "rate": bool(c.is_playback_rate_enabled), "shuffle": bool(c.is_shuffle_enabled),
                    "repeat": bool(c.is_repeat_enabled)},
            "shuffle": bool(pb.is_shuffle_active), "repeat": self._repeat_of(pb),
            "_session": s, "live_seek": True, "rate_known": True,
        }

    @staticmethod
    def _repeat_of(pb):
        try:
            mode = pb.auto_repeat_mode
            return {1: "one", 2: "all"}.get(int(mode), "off") if mode is not None else "off"
        except Exception:
            return "off"

    async def _load_art(self, sid, ref):
        self.art.pop(sid, None)
        if not ref:
            return
        try:
            stream = await ref.open_read_async()
            size = stream.size
            if not size or size > 8_000_000:
                return
            buf = Buffer(size)
            await stream.read_async(buf, size, InputStreamOptions.READ_AHEAD)
            data = bytes(buf)
            ctype = stream.content_type or "image/png"
            self.art[sid] = (hashlib.sha1(data).hexdigest()[:12], data, ctype)
        except Exception as e:
            log.debug("artwork read failed: %s", e)

    async def command(self, sess, action, value):
        s = sess["_session"]
        if action == "toggle":
            return await s.try_toggle_play_pause_async()
        if action == "play":
            return await s.try_play_async()
        if action == "pause":
            return await s.try_pause_async()
        if action == "stop":
            return await s.try_stop_async()
        if action == "next":
            return await s.try_skip_next_async()
        if action == "previous":
            return await s.try_skip_previous_async()
        if action in ("seek", "seek_to") and sess["can"]["seek"]:
            target = float(value) if action == "seek_to" else sess["position"] + float(value)
            target = max(0.0, min(sess["duration"] or target, target))
            ok = await s.try_change_playback_position_async(int(target * 10_000_000))
            cached = self._timeline.get(sess["id"])
            if ok and cached:
                self._timeline[sess["id"]] = (target, cached[1], cached[2])
            return ok
        if action == "rate" and sess["can"]["rate"]:
            return await s.try_change_playback_rate_async(float(value))
        if action == "shuffle":
            return await s.try_change_shuffle_active_async(not sess["shuffle"])
        if action == "repeat" and RepeatMode is not None:
            mode = {"off": RepeatMode.NONE, "all": RepeatMode.LIST, "one": RepeatMode.TRACK}[value]
            return await s.try_change_auto_repeat_mode_async(mode)
        return False


class VlcProvider:
    """VLC 3 through its web interface (VLC 3 doesn't report to Windows media controls).

    PhoneBoxSound can switch the web interface on by itself (localhost only, random password):
    see enable_full_control(). Until then an open VLC window still shows up, with a setup hint.
    """
    name = "vlc"
    VLCRC = os.path.join(os.environ.get("APPDATA", ""), "vlc", "vlcrc")
    QT_INI = os.path.join(os.environ.get("APPDATA", ""), "vlc", "vlc-qt-interface.ini")

    def __init__(self, get_settings):
        self.get_settings = get_settings
        self.http = None
        self.art = {}

    @staticmethod
    def window():
        from .players import find_windows
        for w in find_windows({"Qt5QWindowIcon", "Qt6QWindowIcon", "QWidget"}):
            if w[2].endswith("VLC media player"):
                return w
        return None

    @staticmethod
    def installed():
        return any(os.path.exists(os.path.join(os.environ.get(v, ""), "VideoLAN", "VLC", "vlc.exe"))
                   for v in ("ProgramFiles", "ProgramFiles(x86)"))

    def status(self):
        s = self.get_settings()
        return {"installed": self.installed() or bool(self.window()), "running": bool(self.window()),
                "web": bool(s.get("enabled") and s.get("password"))}

    def _auth(self):
        pw = self.get_settings().get("password", "")
        return {"Authorization": "Basic " + base64.b64encode(f":{pw}".encode()).decode()}

    async def _req(self, query=""):
        import aiohttp
        if self.http is None:
            self.http = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=0.8))
        port = int(self.get_settings().get("port", 8081))
        async with self.http.get(f"http://127.0.0.1:{port}/requests/status.json{query}", headers=self._auth()) as r:
            if r.status != 200:
                raise RuntimeError(f"VLC HTTP {r.status}")
            return json.loads(await r.text())

    async def sessions(self):
        from .players import audio_active, pretty_title
        st = None
        if self.get_settings().get("enabled"):
            try:
                st = await self._req()
            except Exception:
                st = None
        if st is None:
            w = await asyncio.to_thread(self.window)
            if not w or " - " not in w[2]:
                return []
            name = w[2].rsplit(" - VLC media player", 1)[0]
            playing = (await asyncio.to_thread(audio_active)).get("vlc.exe", False)
            return [{"id": "vlc", "provider": "vlc", "app": "VLC", "kind": "vlc", "title": pretty_title(name), "artist": "VLC",
                     "album": "", "status": "playing" if playing else "paused", "position": 0, "duration": 0, "rate": 1.0,
                     "art": None, "setup": "vlc", "offline": True, "shuffle": False, "_hwnd": w[0],
                     "can": {"play": False, "next": False, "previous": False, "seek": False, "rate": False,
                             "volume": False, "fullscreen": False, "subtitles": False}}]
        if st.get("state") == "stopped" and not st.get("length"):
            return []
        win = await asyncio.to_thread(self.window)
        meta = st.get("information", {}).get("category", {}).get("meta", {})
        length = float(st.get("length", 0) or 0)
        title = meta.get("title") or meta.get("filename") or "VLC"
        return [{
            "id": "vlc", "provider": "vlc", "app": "VLC", "kind": "vlc",
            "title": pretty_title(title) if "." in title else title, "artist": meta.get("artist", "") or "VLC",
            "album": meta.get("album", ""), "status": {"playing": "playing", "paused": "paused"}.get(st.get("state"), "stopped"),
            "position": float(st.get("position", 0) or 0) * length, "duration": length,
            "rate": float(st.get("rate", 1) or 1), "art": None, "volume": min(1.0, int(st.get("volume", 256)) / 256),
            "fullscreen": bool(st.get("fullscreen")), "live_seek": True, "rate_known": True, "_hwnd": win[0] if win else None,
            "can": {"play": True, "next": True, "previous": True, "seek": True, "seek_to": length > 0, "rate": True,
                    "shuffle": True, "repeat": True, "volume": True, "fullscreen": True, "subtitles": True},
            "shuffle": bool(st.get("random")),
            "repeat": "one" if st.get("repeat") else "all" if st.get("loop") else "off",
        }]

    async def command(self, sess, action, value):
        if sess.get("offline"):
            return False
        if action == "repeat":
            cur = sess.get("repeat", "off")
            if (cur == "all") != (value == "all"):
                await self._req("?command=pl_loop")
            if (cur == "one") != (value == "one"):
                await self._req("?command=pl_repeat")
            return True
        q = {"toggle": "?command=pl_pause", "play": "?command=pl_play", "pause": "?command=pl_forcepause",
             "stop": "?command=pl_stop", "next": "?command=pl_next", "previous": "?command=pl_previous",
             "fullscreen": "?command=fullscreen", "shuffle": "?command=pl_random",
             "subtitles": "?command=key&val=subtitle-track"}.get(action)
        if action == "seek":
            v = int(float(value))
            q = f"?command=seek&val={'%2B' if v >= 0 else '-'}{abs(v)}s"
        elif action == "seek_to":
            q = f"?command=seek&val={int(float(value))}"
        elif action == "rate":
            q = f"?command=rate&val={float(value)}"
        elif action == "volume":
            q = f"?command=volume&val={int(float(value) * 256)}"
        if not q:
            return False
        await self._req(q)
        return True

    # -- one-click setup ------------------------------------------------

    def enable_full_control(self, restart):
        """Turn on VLC's web interface: localhost only, port 8081, random password (in VLC's vlcrc)."""
        from .players import WM_CLOSE, post, process_path, wait_exit
        s = self.get_settings()
        w = self.window()
        if w and not restart:
            self._write_vlcrc(s)  # VLC only rewrites vlcrc when you save its preferences, so this sticks
            return "restart_needed"
        exe, reopen = None, None
        if w:
            exe, reopen = process_path(w[3]), self._last_file()
            post(w[0], WM_CLOSE, 0)
            if not wait_exit(w[3], 10):
                return "VLC didn't close. Close it yourself and try again."
        self._write_vlcrc(s)
        if exe:
            import subprocess
            subprocess.Popen([exe] + ([reopen] if reopen else []), close_fds=True, creationflags=0x00000008)
        return "ok"

    def _write_vlcrc(self, s):
        import secrets as _secrets
        s.setdefault("port", 8081)
        if not s.get("password"):
            s["password"] = _secrets.token_urlsafe(12)
        s["enabled"] = True
        pending = {"core": {"extraintf": "http", "http-host": "127.0.0.1", "http-port": str(s["port"])},
                   "lua": {"http-password": s["password"]}}
        try:
            with open(self.VLCRC, encoding="utf-8", errors="ignore") as f:
                lines = f.read().splitlines()
        except OSError:
            lines = []
        out, section = [], None

        def flush(sec):
            for k, v in pending.get(sec, {}).items():
                out.append(f"{k}={v}")
            if sec in pending:
                pending[sec] = {}

        for line in lines:
            if line.startswith("["):
                flush(section)
                section = line.strip()[1:].split("]")[0]
            key = line.lstrip("#").split("=", 1)[0].strip()
            if section in pending and key in pending[section] and "=" in line:
                val = pending[section].pop(key)
                if key == "extraintf" and not line.startswith("#"):
                    # keep only real interface names (people sometimes type "--http-port 8081" in here)
                    parts = [p for p in line.split("=", 1)[1].split(":") if re.fullmatch(r"[a-z_]+", p.strip())]
                    val = ":".join(parts if "http" in parts else parts + ["http"])
                line = f"{key}={val}"
            out.append(line)
        flush(section)
        for sec in ("core", "lua"):
            if pending.get(sec):
                out.append(f"[{sec}]")
                flush(sec)
        os.makedirs(os.path.dirname(self.VLCRC), exist_ok=True)
        with open(self.VLCRC, "w", encoding="utf-8") as f:
            f.write("\n".join(out) + "\n")
        log.info("enabled VLC web interface on 127.0.0.1:%s", s["port"])

    def _last_file(self):
        from urllib.parse import unquote
        try:
            with open(self.QT_INI, encoding="utf-8", errors="ignore") as f:
                for line in f:
                    if line.startswith("list="):
                        first = line.split("=", 1)[1].split(",")[0].strip().strip('"')
                        if first.startswith("file:///"):
                            return unquote(first[8:]).replace("/", "\\")
                        return first or None
        except OSError:
            pass
        return None


class MpvProvider:
    """mpv JSON IPC over a Windows named pipe."""
    name = "mpv"
    PIPE = r"\\.\pipe\mpvsocket"

    def __init__(self, get_settings):
        self.get_settings = get_settings

    def _call(self, *commands):
        with open(self.get_settings().get("pipe") or self.PIPE, "r+b", buffering=0) as f:
            out = []
            for i, cmd in enumerate(commands):
                f.write((json.dumps({"command": cmd, "request_id": i}) + "\n").encode())
            pending = {i for i in range(len(commands))}
            results = [None] * len(commands)
            buf = b""
            deadline = time.time() + 0.8
            while pending and time.time() < deadline:
                chunk = f.read(4096)
                if not chunk:
                    break
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    try:
                        m = json.loads(line)
                    except ValueError:
                        continue
                    if m.get("request_id") in pending:
                        pending.discard(m["request_id"])
                        results[m["request_id"]] = m.get("data")
            out = results
            return out

    async def sessions(self):
        if not self.get_settings().get("enabled"):
            return []
        props = ["media-title", "pause", "time-pos", "duration", "speed", "volume", "fullscreen", "sub-visibility",
                 "loop-file", "loop-playlist"]
        try:
            vals = await asyncio.to_thread(self._call, *[["get_property", p] for p in props])
        except Exception:
            return []
        v = dict(zip(props, vals))
        if v["media-title"] is None:
            return []
        return [{
            "id": "mpv", "provider": "mpv", "app": "mpv", "kind": "mpv", "title": v["media-title"] or "mpv",
            "artist": "", "album": "", "status": "paused" if v["pause"] else "playing",
            "position": float(v["time-pos"] or 0), "duration": float(v["duration"] or 0),
            "rate": float(v["speed"] or 1), "art": None, "volume": min(1.0, float(v["volume"] or 100) / 100),
            "fullscreen": bool(v["fullscreen"]), "subtitles": bool(v["sub-visibility"]), "rate_known": True,
            "can": {"play": True, "next": True, "previous": True, "seek": True, "rate": True, "shuffle": False,
                    "repeat": True, "volume": True, "fullscreen": True, "subtitles": True},
            "shuffle": False,
            "repeat": "one" if v["loop-file"] not in (None, False, "no") else "all" if v["loop-playlist"] not in (None, False, "no") else "off",
        }]

    async def command(self, sess, action, value):
        cmd = {"toggle": ["cycle", "pause"], "play": ["set_property", "pause", False],
               "pause": ["set_property", "pause", True], "stop": ["stop"], "next": ["playlist-next"],
               "previous": ["playlist-prev"], "fullscreen": ["cycle", "fullscreen"],
               "subtitles": ["cycle", "sub-visibility"]}.get(action)
        if action == "seek":
            cmd = ["seek", float(value), "relative"]
        elif action == "seek_to":
            cmd = ["seek", float(value), "absolute"]
        elif action == "rate":
            cmd = ["set_property", "speed", float(value)]
        elif action == "volume":
            cmd = ["set_property", "volume", float(value) * 100]
        elif action == "repeat":
            await asyncio.to_thread(self._call, ["set_property", "loop-file", "inf" if value == "one" else "no"],
                                    ["set_property", "loop-playlist", "inf" if value == "all" else "no"])
            return True
        if not cmd:
            return False
        await asyncio.to_thread(self._call, cmd)
        return True


# --------------------------------------------------------------- engine ---


# Keyboard fallbacks, sent to the active window, for things media sessions can't do.
KEY_FALLBACKS = {
    "browser": {"fullscreen": "f", "subtitles": "c", "seek-": "left", "seek+": "right",
                "faster": ("shift", "."), "slower": ("shift", ",")},
    "vlc": {"fullscreen": "f", "subtitles": "v", "faster": "]", "slower": "["},
    "mpv": {"fullscreen": "f", "subtitles": "v", "faster": "]", "slower": "["},
    "default": {"fullscreen": "f", "subtitles": "c", "seek-": "left", "seek+": "right"},
}
RATES = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0]


class DemoProvider:
    """A pretend player, for screenshots, demos and tests: no real media or personal data involved."""
    name = "demo"
    TRACKS = [("Big Buck Bunny", "Blender Foundation", "Peach Open Movie", 596, "Demo Player", (86, 160, 110)),
              ("Sintel", "Blender Foundation", "Durian Open Movie", 888, "Demo Player", (170, 96, 80)),
              ("Night Drive", "The Demo Band", "Demo Album", 215, "Spotify", (60, 150, 90))]

    def __init__(self):
        self.i, self.pos, self.playing, self.rate, self.vol, self.at = 0, 204.0, True, 1.0, 0.78, time.time()
        self.shuffle, self.repeat = False, "off"
        self.art = {}

    def _art(self, i):
        if i not in self.art:
            import io
            from PIL import Image, ImageDraw
            base = self.TRACKS[i][5]
            img = Image.new("RGB", (960, 540))
            d = ImageDraw.Draw(img)
            for y in range(540):
                k = y / 540
                d.line([(0, y), (960, y)], fill=tuple(int(c * (1.15 - 0.85 * k)) for c in base))
            d.ellipse((620, 60, 860, 300), fill=tuple(min(255, int(c * 1.6) + 40) for c in base))
            for x, h in ((0, 150), (150, 230), (330, 120), (480, 260), (700, 170), (850, 210)):
                d.polygon([(x - 60, 540), (x + 110, 540 - h), (x + 280, 540)], fill=tuple(int(c * 0.28) for c in base))
            out = io.BytesIO()
            img.save(out, "JPEG", quality=85)
            data = out.getvalue()
            self.art[i] = (hashlib.sha1(data).hexdigest()[:12], data, "image/jpeg")
        return self.art[i][0]

    def _advance(self):
        now = time.time()
        if self.playing:
            self.pos += (now - self.at) * self.rate
        self.at = now
        dur = self.TRACKS[self.i][3]
        if self.pos >= dur:
            if self.repeat == "one":
                self.pos = 0.0
            elif self.repeat == "off" and self.i == len(self.TRACKS) - 1:
                self.pos, self.playing = float(dur), False
            else:
                self.i, self.pos = (self.i + 1) % len(self.TRACKS), 0.0

    async def sessions(self):
        self._advance()
        title, artist, album, dur, app, _ = self.TRACKS[self.i]
        return [{"id": "demo", "provider": "demo", "app": app, "kind": "demo", "title": title, "artist": artist, "album": album,
                 "status": "playing" if self.playing else "paused", "position": self.pos, "duration": dur, "rate": self.rate,
                 "art": self._art(self.i), "volume": self.vol, "live_seek": True, "rate_known": True,
                 "shuffle": self.shuffle, "repeat": self.repeat,
                 "_link": "https://www.youtube.com/watch?v=aqz-KE-bpKQ&feature=share" if self.i == 0 else None, "_shareable": True,
                 "can": {"play": True, "next": True, "previous": True, "seek": True, "seek_to": True, "rate": True, "volume": True,
                         "fullscreen": True, "subtitles": True, "shuffle": True, "repeat": True}}]

    async def command(self, sess, action, value):
        self._advance()
        dur = self.TRACKS[self.i][3]
        if action == "toggle":
            self.playing = not self.playing
        elif action in ("play", "pause"):
            self.playing = action == "play"
        elif action == "stop":
            self.playing, self.pos = False, 0.0
        elif action in ("next", "previous"):
            self.i, self.pos = (self.i + (1 if action == "next" else -1)) % len(self.TRACKS), 0.0
        elif action == "seek":
            self.pos = max(0.0, min(dur, self.pos + float(value)))
        elif action == "seek_to":
            self.pos = max(0.0, min(dur, float(value)))
        elif action == "rate":
            self.rate = float(value)
        elif action == "volume":
            self.vol = max(0.0, min(1.0, float(value)))
        elif action == "shuffle":
            self.shuffle = not self.shuffle
        elif action == "repeat":
            self.repeat = value
        return True


class BrowserProvider:
    """Every tab that plays something, reported by the PhoneBoxSound browser extension (see extension/).

    Windows itself only shows one "now playing" entry per browser, chosen by the browser. The extension
    sees each tab's video or audio element, so each tab becomes its own entry with exact position,
    seeking, speed and volume."""
    name = "browser"

    def __init__(self):
        self.links = {}     # websocket -> {"name", "tabs": {key: report}, "since", "n"}
        self._n = 0

    def attach(self, ws, name, ext_id=None):
        self._n += 1
        self.links[ws] = {"name": str(name or "Browser")[:20], "tabs": {}, "since": time.time(), "n": self._n, "id": ext_id}

    def detach(self, ws):
        self.links.pop(ws, None)

    def update(self, ws, tabs):
        link = self.links.get(ws)
        if not link or not isinstance(tabs, list):
            return
        now, seen = time.time(), {}
        for t in tabs[:60]:
            if isinstance(t, dict) and isinstance(t.get("tab"), int):
                seen[(t["tab"], int(t.get("frame") or 0))] = {**t, "_rx": now}
        link["tabs"] = seen

    def status(self):
        return [{"name": l["name"], "tabs": len(l["tabs"]), "since": int(time.time() - l["since"]), "id": l.get("id")} for l in self.links.values()]

    def drop(self, ext_id):
        """Disconnect an extension that was removed on the dashboard."""
        for ws, link in list(self.links.items()):
            if link.get("id") == ext_id:
                asyncio.ensure_future(ws.close())

    async def sessions(self):
        out, now = [], time.time()
        for ws, link in self.links.items():
            for (tab, frame), t in link["tabs"].items():
                if now - t["_rx"] > 5:
                    continue
                playing = not t.get("paused")
                dur, rate = float(t.get("duration") or 0), float(t.get("rate") or 1)
                pos = float(t.get("position") or 0) + ((now - t["_rx"]) * rate if playing else 0)
                host = str(t.get("host") or "")[:60]
                out.append({
                    "id": f"tab:{link['n']}:{tab}:{frame}", "provider": "browser", "app": link["name"], "kind": link["name"].lower(),
                    "title": str(t.get("title") or t.get("page") or host)[:200], "artist": str(t.get("artist") or host)[:120], "album": str(t.get("album") or "")[:120],
                    "status": "playing" if playing else "paused", "position": min(pos, dur) if dur else pos, "duration": dur, "rate": rate,
                    "art": None, "volume": 0.0 if t.get("muted") else float(t.get("volume") or 0), "live_seek": True, "rate_known": True, "site": host,
                    "can": {"play": True, "next": False, "previous": False, "seek": dur > 0, "seek_to": dur > 0, "rate": True, "volume": True,
                            "fullscreen": False, "subtitles": False, "shuffle": False, "repeat": False},
                    "_ws": ws, "_tab": tab, "_frame": frame, "_link": t.get("url")})
        return out

    async def command(self, sess, action, value):
        if action not in ("toggle", "play", "pause", "stop", "seek", "seek_to", "rate", "volume", "mute", "focus"):
            return False
        try:
            await sess["_ws"].send_json({"t": "cmd", "tab": sess["_tab"], "frame": sess["_frame"], "action": action, "value": value})
            return True
        except Exception:
            return False

    async def open(self, url):
        """Show an address in the browser that has the extension (in the tab it opened last time)."""
        for ws in sorted(self.links, key=lambda w: -self.links[w]["since"]):
            try:
                await ws.send_json({"t": "open", "url": url})
                return True
            except Exception:
                continue
        return False

    async def delay(self, ms):
        """Ask every tab to show its picture `ms` later (0 = normally)."""
        for ws, link in list(self.links.items()):
            if link.get("delay") != ms:
                link["delay"] = ms
                try:
                    await ws.send_json({"t": "delay", "ms": ms})
                except Exception:
                    pass


class MediaEngine:
    def __init__(self, cfg, demo=False):
        self.cfg = cfg
        self.demo = demo
        self.volume = PcVolume()
        from .players import MpcProvider, PotPlayerProvider
        self.mpc = MpcProvider(lambda: self.cfg.setdefault("mpc", {"enabled": True}))
        self.providers = [SmtcProvider(),
                          self.mpc,
                          PotPlayerProvider(lambda: self.cfg.setdefault("potplayer", {"enabled": True})),
                          self._vlc_provider(),
                          MpvProvider(lambda: self.cfg.setdefault("mpv", {}))]
        self.browser = BrowserProvider()
        self.providers.append(self.browser)
        if demo:
            self.providers = [DemoProvider(), self.browser]
            self.volume.ok = False  # never touch the real PC volume in demo mode
        self.players = {}  # setup status of desktop players, for the dashboard
        self._players_at = 0
        self.sessions = []
        self.target_id = None  # user-pinned session; None = automatic
        self.active = None
        self.pc = None
        self.on_change = None
        self.overlay = None
        self._last_public = None
        self._track = {}   # session id -> {"status", "title", "started", "stopped", "audible"}
        self._pinned_at = 0
        self.snaps = {}    # session id -> (hash, jpeg bytes, content type): captured video frames
        self._snap_state = {}

    def _vlc_provider(self):
        self.vlc = VlcProvider(lambda: self.cfg.setdefault("vlc", {"enabled": False, "port": 8081, "password": ""}))
        return self.vlc

    def art(self, art_hash):
        for p in self.providers:
            for h, data, ctype in getattr(p, "art", {}).values():
                if h == art_hash:
                    return data, ctype
        for h, data, ctype in self.snaps.values():
            if h == art_hash:
                return data, ctype
        return None

    async def poll_forever(self):
        while True:
            try:
                await self.poll()
            except Exception as e:
                log.debug("media poll failed: %s", e)
            await asyncio.sleep(0.5)

    async def poll(self):
        found = []
        for p in self.providers:
            try:
                found += await p.sessions()
            except Exception as e:
                log.debug("%s failed: %s", p.name, e)
        # A player with its own integration may also show up as a Windows media session - keep the richer one.
        own = {s["kind"] for s in found if s["provider"] != "smtc"}
        found = [s for s in found if s["provider"] != "smtc" or not any(k in s["app"].lower() for k in own)]
        now = time.time()
        if now - self._players_at > 2 and not self.demo:
            self._players_at = now
            self.players = {"mpc": await asyncio.to_thread(self.mpc.status),
                            "vlc": await asyncio.to_thread(self.vlc.status)}
        await self._observe(found, now)
        self.sessions = found
        self.active = self._pick()
        await self._thumbnail(self.active, now)
        self.pc = await asyncio.to_thread(self.volume.get) if not self.demo else {"volume": 0.78, "muted": False}
        if self.overlay:
            try:
                self.overlay(self)        # what the hub knows better: a seek just made, Spotify's own numbers, the PC output's volume
            except Exception as e:
                log.debug("overlay failed: %s", e)
        public = self.public()
        if public != self._last_public:
            self._last_public = public
            if self.on_change:
                await self.on_change(public)

    PROCESS = {"Chrome": "chrome.exe", "Edge": "msedge.exe", "Firefox": "firefox.exe", "Brave": "brave.exe",
               "Opera": "opera.exe", "Spotify": "spotify.exe", "VLC": "vlc.exe", "mpv": "mpv.exe",
               "MPC-HC": "mpc-hc64.exe", "MPC-BE": "mpc-be64.exe", "PotPlayer": "potplayermini64.exe"}

    async def _observe(self, found, now):
        """Notice *changes*: a player that just started, resumed, changed track or became audible is
        what the user is paying attention to, whatever else still claims to be "playing"."""
        from .players import audio_active
        sounding = await asyncio.to_thread(audio_active) if found else {}
        seen = set()
        for s in found:
            seen.add(s["id"])
            t = self._track.setdefault(s["id"], {"status": None, "title": None, "started": 0, "stopped": 0, "audible": False})
            proc = self.PROCESS.get(s["app"], s["app"].lower() + ".exe")
            audible = bool(sounding.get(proc)) or any(k.startswith(proc.split(".")[0][:6]) and v for k, v in sounding.items())
            playing = s["status"] == "playing"
            if playing and (t["status"] != "playing" or t["title"] != s["title"] or (audible and not t["audible"])):
                t["started"] = now
            if not playing and t["status"] == "playing":
                t["stopped"] = now
            t.update(status=s["status"], title=s["title"], audible=audible)
            s["audible"] = audible
        for sid in [k for k in self._track if k not in seen]:
            del self._track[sid]
            self.snaps.pop(sid, None)
            self._snap_state.pop(sid, None)

    def _pick(self):
        if not self.sessions:
            self.target_id = None
            return None
        by_id = {s["id"]: s for s in self.sessions}
        newest = lambda group: max(group, key=lambda s: self._track[s["id"]]["started"])
        playing = [s for s in self.sessions if s["status"] == "playing"]
        pinned = by_id.get(self.target_id)
        if self.target_id and not pinned:
            self.target_id = None
        if pinned:
            # A pin is a preference, not a cage: if you paused the pinned player and then started
            # something else, follow you there.
            fresh = [s for s in playing if s is not pinned and self._track[s["id"]]["started"] > self._pinned_at]
            if pinned["status"] == "playing" or not fresh:
                return pinned
            self.target_id = None
        if playing:
            audible = [s for s in playing if s.get("audible")]
            return newest(audible or playing)
        # Nothing playing: stay on whatever was playing last.
        return max(self.sessions, key=lambda s: max(self._track[s["id"]]["stopped"], self._track[s["id"]]["started"]))

    async def _thumbnail(self, sess, now):
        """Players without cover art get the frame that's on screen right now as their artwork."""
        if not sess or not sess.get("_hwnd"):
            return
        sid = sess["id"]
        if sess.get("art") and sid not in self.snaps:
            return  # the player supplied its own artwork
        st = self._snap_state.get(sid, {})
        expected = st.get("pos", 0) + (now - st.get("at", now)) * (sess.get("rate") or 1 if st.get("status") == "playing" else 0)
        jumped = abs(sess["position"] - expected) > 3 if sess.get("duration") else False
        changed = st.get("title") != sess["title"] or st.get("status") != sess["status"] or jumped
        age = now - st.get("shot", 0)
        due = changed and age > 0.7 or (sess["status"] == "playing" and age > 6) or (sid not in self.snaps and age > 2)
        self._snap_state[sid] = {**st, "title": sess["title"], "status": sess["status"], "pos": sess["position"], "at": now}
        if due:
            from . import snap
            got = await asyncio.to_thread(snap.capture, sess["_hwnd"], sess.get("_video"))
            self._snap_state[sid]["shot"] = now
            if got:
                self.snaps[sid] = got
        if sid in self.snaps:
            sess["art"] = self.snaps[sid][0]

    async def lip_sync(self, latency_ms):
        """Phones play `latency_ms` after the PC. For players that can shift their own audio, ask them to
        play the sound that much earlier, so what the phones play lines up with the picture."""
        want = round(-latency_ms / 1000, 2)
        # a browser can't play its sound earlier, but with the extension it can show its picture later
        await self.browser.delay(int(latency_ms) if self.cfg.get("browser_delay") else 0)
        state = self.__dict__.setdefault("_lip_state", {})  # player id -> what we last applied
        for s in self.sessions:
            pid = s["id"]
            try:
                if pid == "vlc" and not s.get("offline"):
                    if state.get(pid) != want:
                        await self.vlc._req(f"?command=audiodelay&val={want}")
                        state[pid] = want
                        log.info("VLC audio delay %s s (lip-sync)", want)
                elif pid == "mpv":
                    if state.get(pid) != want:
                        provider = next(p for p in self.providers if p.name == "mpv")
                        await asyncio.to_thread(provider._call, ["set_property", "audio-delay", want])
                        state[pid] = want
                        log.info("mpv audio delay %s s (lip-sync)", want)
                elif pid == "mpc":
                    # MPC-HC only offers "audio delay +10 ms / -10 ms", and starts every file at 0:
                    # press the button as many times as needed, and start over when the file changes.
                    from .players import MPC, WM_COMMAND, post
                    file_key, applied = state.get(pid, (None, 0))
                    if file_key != s.get("file"):
                        file_key, applied = s.get("file"), 0
                    target = int(round(-latency_ms / 10.0)) * 10
                    steps = (target - applied) // 10
                    for _ in range(min(abs(steps), 40)):
                        post(s["_hwnd"], WM_COMMAND, MPC["audio_later" if steps > 0 else "audio_earlier"])
                    applied += (1 if steps > 0 else -1) * min(abs(steps), 40) * 10 if steps else 0
                    state[pid] = (file_key, applied)
            except Exception as e:
                log.debug("lip-sync for %s failed: %s", pid, e)
        for gone in [k for k in state if not any(s["id"] == k for s in self.sessions)]:
            del state[gone]

    @staticmethod
    def _strip(s):
        return {k: v for k, v in s.items() if not k.startswith("_")} if s else None

    async def announce(self):
        """Tell everyone now, if what they should see has changed (without re-reading every player)."""
        if self.overlay:
            try:
                self.overlay(self)
            except Exception:
                pass
        public = self.public()
        if public != self._last_public and self.on_change:
            self._last_public = public
            await self.on_change(public)

    def public(self):
        active = self._strip(self.active)
        if active:
            active["position"] = round(active["position"], 1)
        return {"active": active, "pinned": self.target_id,
                "sessions": [{"id": s["id"], "app": s["app"], "title": s["title"], "status": s["status"],
                              "setup": s.get("setup"), "audible": s.get("audible", False),
                              "art": s.get("art") or (self.snaps[s["id"]][0] if s["id"] in self.snaps else None)}
                             for s in self.sessions],
                "pc": self.pc, "players": self.players}

    async def command(self, action, value=None, session_id=None):
        """Returns a short string describing what happened (shown as a toast)."""
        if action == "target":
            self.target_id = value or None
            self._pinned_at = time.time()
            await self.poll()
            return "Remote target changed"
        if action == "pc_volume":
            await asyncio.to_thread(self.volume.set, float(value), None)
            await self.poll()
            return None
        if action == "pc_mute":
            await asyncio.to_thread(self.volume.set, None, bool(value))
            await self.poll()
            return None

        sess = self.active
        if session_id:
            sess = next((s for s in self.sessions if s["id"] == session_id), sess)
        kind = sess["kind"] if sess else "default"
        keys = KEY_FALLBACKS.get(kind, KEY_FALLBACKS["default"])
        provider = next((p for p in self.providers if sess and p.name == sess["provider"]), None)

        if action == "speed" and sess:
            cur = sess.get("rate") or 1.0
            if sess["can"].get("rate"):
                nxt = min(RATES, key=lambda r: abs(r - float(value))) if value not in ("up", "down") else (
                    next((r for r in RATES if r > cur + 0.01), RATES[-1]) if value == "up"
                    else next((r for r in reversed(RATES) if r < cur - 0.01), RATES[0]))
                await provider.command(sess, "rate", nxt)
                await self.poll()
                return f"Speed {nxt:g}x"
            if sess["can"].get("speed_step"):
                step = value if value in ("up", "down") else (
                    "normal" if abs(float(value) - 1) < 0.01 else "up" if float(value) > cur else "down")
                await provider.command(sess, "speed_step", step)
                return {"up": "Faster", "down": "Slower"}.get(step, "Normal speed")
            key = keys.get("faster" if value != "down" else "slower")
            if key:
                inputctl.press(*key) if isinstance(key, tuple) else inputctl.press(key)
                return "Speed changed"
            return "This player can't change speed"

        if action == "repeat":
            if not sess or not sess["can"].get("repeat"):
                return f"{sess['app'] if sess else 'This player'} can't repeat from here"
            cur = sess.get("repeat", "off")
            mode = value if value in REPEAT_MODES else REPEAT_MODES[(REPEAT_MODES.index(cur) + 1) % 3]
            ok = await provider.command(sess, "repeat", mode)
            await asyncio.sleep(0.15)
            await self.poll()
            if ok is False:
                return f"{sess['app']} ignored the repeat command"
            return {"off": "Repeat off", "all": "Repeat all", "one": "Repeat one"}[mode]

        if action == "shuffle" and sess and not sess["can"].get("shuffle"):
            return f"{sess['app']} can't shuffle from here"

        if action == "volume" and sess and sess["can"].get("volume"):
            await provider.command(sess, "volume", value)
            await self.poll()
            return None

        if action in ("fullscreen", "subtitles"):
            if provider and sess["can"].get(action):
                await provider.command(sess, action, value)
            else:
                inputctl.press(keys.get(action, "f"))
            return "Fullscreen" if action == "fullscreen" else "Subtitles"

        if action == "seek" and sess and not sess["can"]["seek"]:
            # Player doesn't expose seeking; arrow keys move 5 s in most players.
            steps = max(1, round(abs(float(value)) / 5))
            key = keys.get("seek+" if float(value) > 0 else "seek-")
            if key:
                for _ in range(min(steps, 12)):
                    inputctl.press(key)
                return f"{'+' if float(value) > 0 else ''}{int(float(value))}s (keyboard)"
            return "This player can't seek"

        if sess and sess.get("offline"):
            return f"Turn on control for {sess['app']} in the PC dashboard (one click)"
        if not sess or not provider:
            # No session: fall back to the global media keys Windows understands.
            vk = {"toggle": "play_pause", "play": "play_pause", "pause": "play_pause",
                  "next": "next_track", "previous": "prev_track", "stop": "stop_media"}.get(action)
            if vk:
                inputctl.press(vk)
                return None
            return "Nothing is playing"
        ok = await provider.command(sess, action, value)
        await asyncio.sleep(0.15)
        await self.poll()
        return None if ok is not False else "The player ignored that command"
