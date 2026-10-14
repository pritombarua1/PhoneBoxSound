"""Desktop players that don't report to Windows media sessions.

* MPC-HC / MPC-BE (incl. the K-Lite build)
    - works with zero setup: found by its window, controlled with its own command IDs,
      play/pause state read from its Windows audio session;
    - "full control" (exact timeline, seek-to, volume, video snapshot as artwork) uses its
      built-in web interface, which PhoneBoxSound can switch on (localhost only).
* PotPlayer - zero setup, through PotPlayer's window-message API (time, state, volume).
"""
import asyncio
import ctypes
import hashlib
import html
import logging
import os
import re
import subprocess
import sys
import time

log = logging.getLogger("pbs.players")
WINDOWS = sys.platform == "win32"

if WINDOWS:
    import winreg
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32
    EnumWindowsProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    user32.SendMessageTimeoutW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM,
                                           wintypes.UINT, wintypes.UINT, ctypes.POINTER(ctypes.c_size_t)]
    user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]

WM_CLOSE, WM_COMMAND, WM_USER = 0x0010, 0x0111, 0x0400
SMTO_ABORTIFHUNG = 0x2


# ---------------------------------------------------------------- win32 ---


def find_windows(classes):
    """Visible top-level windows whose class is in ``classes`` -> [(hwnd, class, title, pid)]."""
    if not WINDOWS:
        return []
    out = []

    def cb(hwnd, _):
        if not user32.IsWindowVisible(hwnd):
            return True
        buf = ctypes.create_unicode_buffer(128)
        user32.GetClassNameW(hwnd, buf, 128)
        if buf.value in classes:
            n = user32.GetWindowTextLengthW(hwnd)
            title = ctypes.create_unicode_buffer(n + 1)
            user32.GetWindowTextW(hwnd, title, n + 1)
            pid = wintypes.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            out.append((hwnd, buf.value, title.value, pid.value))
        return True

    user32.EnumWindows(EnumWindowsProc(cb), 0)
    return out


def send(hwnd, msg, wparam, lparam=0, timeout_ms=300):
    """SendMessage that can't hang us if the player is busy. Returns the signed result or None."""
    res = ctypes.c_size_t()
    ok = user32.SendMessageTimeoutW(hwnd, msg, wparam, lparam, SMTO_ABORTIFHUNG, timeout_ms, ctypes.byref(res))
    if not ok:
        return None
    v = res.value
    return v - (1 << 64) if v >= 1 << 63 else v


def post(hwnd, msg, wparam, lparam=0):
    return bool(user32.PostMessageW(hwnd, msg, wparam, lparam))


def child_windows(hwnd):
    """All descendant windows -> [(hwnd, class, text, width, height, visible, parent)]."""
    out = []

    def cb(c, _):
        buf = ctypes.create_unicode_buffer(128)
        user32.GetClassNameW(c, buf, 128)
        n = user32.GetWindowTextLengthW(c)
        text = ctypes.create_unicode_buffer(n + 1)
        user32.GetWindowTextW(c, text, n + 1)
        r = wintypes.RECT()
        user32.GetClientRect(c, ctypes.byref(r))
        out.append((c, buf.value, text.value, r.right, r.bottom, bool(user32.IsWindowVisible(c)), user32.GetParent(c)))
        return True

    user32.EnumChildWindows(hwnd, EnumWindowsProc(cb), 0)
    return out


def hms(s):
    secs = 0
    for part in s.split(":"):
        secs = secs * 60 + int(part)
    return secs


TIME_RE = re.compile(r"^(-?)(\d+:\d\d(?::\d\d)?)\s*/\s*(\d+:\d\d(?::\d\d)?)$")


def process_path(pid):
    h = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not h:
        return None
    try:
        buf = ctypes.create_unicode_buffer(1024)
        size = wintypes.DWORD(1024)
        if kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
            return buf.value
    finally:
        kernel32.CloseHandle(h)
    return None


def wait_exit(pid, timeout_s):
    h = kernel32.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE
    if not h:
        return True
    try:
        return kernel32.WaitForSingleObject(h, int(timeout_s * 1000)) == 0
    finally:
        kernel32.CloseHandle(h)


_audio_cache = (0.0, {})


def audio_active():
    """{process name (lower): True if it is currently rendering sound}. Cached for 400 ms."""
    global _audio_cache
    if time.time() - _audio_cache[0] < 0.4:
        return _audio_cache[1]
    states = {}
    try:
        import comtypes
        from pycaw.pycaw import AudioUtilities
        comtypes.CoInitialize()
        for s in AudioUtilities.GetAllSessions():
            if s.Process:
                name = s.Process.name().lower()
                states[name] = states.get(name, False) or s.State == 1
    except Exception as e:
        log.debug("audio sessions unavailable: %s", e)
    _audio_cache = (time.time(), states)
    return states


def pretty_title(name):
    """'[MLWBD.COM] Avengers.Inf1n1ty.W@r.2018.2160p.10b1t.mkv' -> 'Avengers Inf1n1ty W@r (2018)'."""
    base = os.path.basename(name or "").strip()
    base = re.sub(r"\.(mkv|mp4|avi|mov|m4v|wmv|webm|ts|m2ts|flv|mp3|flac|wav|m4a|aac|ogg|opus)$", "", base, flags=re.I)
    base = re.sub(r"^\s*\[[^\]]*\]\s*|^[^\]]{1,24}\]\s*", "", base)  # [site] or site] prefixes
    words = re.split(r"[._\s]+", base)
    out, year = [], None
    for w in words:
        if re.fullmatch(r"(19|20)\d\d", w) and out:
            year = w
            break
        if re.fullmatch(r"\d{3,4}p|x26[45]|h\.?26[45]|hevc|web(-?dl|rip)?|bluray|brrip|hdrip|10bit|10b1t|hdr|dts|aac|remux", w, re.I) and out:
            break
        out.append(w)
    title = " ".join(out).strip() or base
    return f"{title} ({year})" if year else title


# ----------------------------------------------------------------- MPC ---

MPC_CLASSES = {"MediaPlayerClassicW", "MPC-BE"}
MPC_REG = r"Software\MPC-HC\MPC-HC\Settings"
MPC = {"play": 887, "pause": 888, "toggle": 889, "stop": 890, "slower": 894, "faster": 895, "normal": 896,
       "back_s": 899, "fwd_s": 900, "back_m": 901, "fwd_m": 902, "back_l": 903, "fwd_l": 904,
       "audio_later": 905, "audio_earlier": 906, "vol_up": 907, "vol_down": 908, "mute": 909, "fullscreen": 830, "previous": 921, "next": 922, "subtitles": 956}


def _reg_get(name, default=None):
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, MPC_REG) as k:
            return winreg.QueryValueEx(k, name)[0]
    except OSError:
        return default


def _ini_path(exe):
    if not exe:
        return None
    base = os.path.splitext(exe)[0] + ".ini"
    return base if os.path.exists(base) else None


class MpcProvider:
    name = "mpc"

    def __init__(self, get_settings):
        self.get_settings = get_settings
        self.http = None
        self.art = {}
        self._art_at = 0
        self._art_key = None
        self.last_error = None

    def status(self):
        wins = find_windows(MPC_CLASSES) if WINDOWS else []
        installed = WINDOWS and (_reg_get("SettingsVersion") is not None or bool(wins))
        return {"installed": bool(installed), "running": bool(wins),
                "web": bool(_reg_get("EnableWebServer", 0)), "port": int(_reg_get("WebServerPort", 13579) or 13579)}

    async def _variables(self, port):
        import aiohttp
        if self.http is None:
            self.http = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=0.8))
        async with self.http.get(f"http://127.0.0.1:{port}/variables.html") as r:
            text = await r.text()
        return {k: html.unescape(v) for k, v in re.findall(r'<p id="(\w+)">(.*?)</p>', text, re.S)}

    async def sessions(self):
        if not WINDOWS or not self.get_settings().get("enabled", True):
            return []
        wins = await asyncio.to_thread(find_windows, MPC_CLASSES)
        if not wins:
            return []
        hwnd, cls, title, pid = wins[0]
        app = "MPC-BE" if cls == "MPC-BE" else "MPC-HC"
        port = int(_reg_get("WebServerPort", 13579) or 13579)
        v = None
        if _reg_get("EnableWebServer", 0):
            try:
                v = await self._variables(port)
            except Exception as e:
                self.last_error = str(e)
        jumps = [int(_reg_get(k, d) or d) / 1000 for k, d in (("JumpDistS", 1000), ("JumpDistM", 5000), ("JumpDistL", 20000))]
        base = {"id": "mpc", "provider": "mpc", "app": app, "kind": "mpc", "album": "", "artist": app,
                "_hwnd": hwnd, "_pid": pid, "_port": port, "_jumps": jumps, "shuffle": False}
        if v and v.get("file"):
            state = {"2": "playing", "1": "paused"}.get(v.get("state"), "stopped")
            try:
                rate = float(v.get("playbackrate") or 1)
            except ValueError:
                rate = 1.0
            sess = base | {
                "title": pretty_title(v["file"]), "file": v["file"], "status": state,
                "position": int(v.get("position") or 0) / 1000, "duration": int(v.get("duration") or 0) / 1000, "rate": rate,
                "volume": int(v.get("volumelevel") or 0) / 100, "muted": v.get("muted") == "1", "full": True, "live_seek": True, "rate_known": True,
                "can": {"play": True, "next": True, "previous": True, "seek": True, "rate": False, "speed_step": True,
                        "volume": True, "fullscreen": True, "subtitles": True, "shuffle": False, "repeat": False},
            }
            await self._snapshot(port, sess)
        else:
            clean = re.sub(r"\s*-\s*MPC-(HC|BE).*$", "", title)
            ui = await asyncio.to_thread(self._read_ui, hwnd)
            status = ui["status"]
            if status is None:
                playing = (await asyncio.to_thread(audio_active)).get(os.path.basename(process_path(pid) or "mpc-hc64.exe").lower(), False)
                status = "playing" if playing else "paused"
            sess = base | {
                "title": pretty_title(clean) if clean else app, "file": clean, "status": status,
                "position": ui["position"], "duration": ui["duration"], "rate": 1.0, "full": False, "setup": "mpc",
                "volume": ui["volume"], "_ui": ui, "_video": ui.get("video"),
                "can": {"play": True, "next": True, "previous": True, "seek": True, "seek_to": bool(ui["duration"] and ui["seekbar"]),
                        "rate": False, "speed_step": True, "volume": ui["volume"] is not None, "fullscreen": True,
                        "subtitles": True, "shuffle": False, "repeat": False},
            }
        sess["art"] = self.art["mpc"][0] if "mpc" in self.art else None
        return [sess]

    # -- zero-setup: read MPC's own status bar, seek bar and volume slider ----------

    @staticmethod
    def _read_ui(hwnd):
        ui = {"position": 0, "duration": 0, "status": None, "seekbar": None, "volume": None, "trackbar": None}
        kids = child_windows(hwnd)
        with_kids = {k[6] for k in kids if k[5]}
        for c, cls, text, w, h, vis, _parent in kids:
            if cls == "Static" and text:
                m = TIME_RE.match(text.strip())
                if m:
                    a, b = hms(m.group(2)), hms(m.group(3))
                    ui["duration"] = b
                    ui["position"] = b - a if m.group(1) else a  # "remaining time" display mode
                    continue
                word = text.split("[")[0].strip().lower()
                if word.startswith(("playing", "paused", "stopped")) or word in ("opening...", "closing..."):
                    ui["status"] = "playing" if word.startswith("playing") else "stopped" if word.startswith("stopped") else "paused"
            elif cls == "#32770" and vis and 8 <= h <= 40 and w > 200 and c not in with_kids:
                ui["seekbar"] = (c, w, h)  # the seek bar is the only childless strip-shaped dialog bar
            elif cls in ("VRWindow", "madVR") and vis and w > 60:
                ui["video"] = c
            elif cls == "msctls_trackbar32" and vis:
                pos = send(c, WM_USER, 0)  # TBM_GETPOS
                if pos is not None and 0 <= pos <= 100:
                    ui["volume"], ui["trackbar"] = pos / 100, c
        return ui

    def _click_seekbar(self, bar, fraction):
        c, w, h = bar
        margin = max(6, round(w * 0.008))  # track inset from the bar's edges
        x = int(margin + max(0.0, min(1.0, fraction)) * (w - 2 * margin))
        lp = (int(h // 2) << 16) | (x & 0xFFFF)
        post(c, 0x0201, 0x0001, lp)  # WM_LBUTTONDOWN
        post(c, 0x0202, 0, lp)       # WM_LBUTTONUP

    def _seek_to_basic(self, sess, target):
        """Click the seek bar near the target, read MPC's clock back, then fine-tune with jumps (about 1 s accuracy)."""
        hwnd, ui = sess["_hwnd"], sess["_ui"]
        dur = ui["duration"]
        if not dur or not ui["seekbar"]:
            return False
        target = max(0.0, min(float(target), dur - 1))
        frac, pos = target / dur, ui["position"]
        for _ in range(3):
            self._click_seekbar(ui["seekbar"], frac)
            time.sleep(0.35)
            pos = self._read_ui(hwnd)["position"]
            err = target - pos
            if abs(err) <= 4:
                break
            frac += err / dur
        for cmd in self._jump_plan(target - pos, sess["_jumps"]):
            post(hwnd, WM_COMMAND, MPC[cmd])
        return True

    def _set_volume_basic(self, sess, value):
        ui = sess["_ui"]
        if ui["trackbar"] is None:
            return False
        step = max(1, int(_reg_get("VolumeStep", 5) or 5))
        diff = round((float(value) - ui["volume"]) * 100 / step)
        for _ in range(min(abs(diff), 40)):
            post(sess["_hwnd"], WM_COMMAND, MPC["vol_up" if diff > 0 else "vol_down"])
        return True

    async def _snapshot(self, port, sess):
        # The current video frame is the artwork. Refresh on a new file, and every 20 s while playing.
        key = sess["file"]
        if key == self._art_key and (sess["status"] != "playing" or time.time() - self._art_at < 20):
            return
        try:
            async with self.http.get(f"http://127.0.0.1:{port}/snapshot.jpg") as r:
                if r.status == 200 and r.content_type.startswith("image"):
                    data = await r.read()
                    self.art["mpc"] = (hashlib.sha1(data).hexdigest()[:12], data, r.content_type)
        except Exception:
            pass
        self._art_key, self._art_at = key, time.time()

    async def _web(self, sess, query):
        async with self.http.get(f"http://127.0.0.1:{sess['_port']}/command.html?{query}") as r:
            return r.status == 200

    def _jump_plan(self, seconds, jumps):
        """Express a relative seek with MPC's small/medium/large jump commands."""
        s, m, l = jumps
        fwd = seconds > 0
        left = abs(seconds)
        plan = []
        for dist, key in ((l, "l"), (m, "m"), (s, "s")):
            while dist > 0 and left >= dist - 0.01 and len(plan) < 40:
                plan.append(("fwd_" if fwd else "back_") + key)
                left -= dist
        return plan

    async def command(self, sess, action, value):
        hwnd = sess["_hwnd"]
        full = sess.get("full")
        if action == "seek_to" and full:
            t = max(0, int(float(value)))
            return await self._web(sess, f"wm_command=-1&position={t // 3600:02d}:{t % 3600 // 60:02d}:{t % 60:02d}")
        if action == "seek_to":
            return await asyncio.to_thread(self._seek_to_basic, sess, value)
        if action == "volume" and not full:
            return await asyncio.to_thread(self._set_volume_basic, sess, value)
        if action == "seek":
            if full:
                t = max(0, int(sess["position"] + float(value)))
                return await self._web(sess, f"wm_command=-1&position={t // 3600:02d}:{t % 3600 // 60:02d}:{t % 60:02d}")
            for cmd in self._jump_plan(float(value), sess["_jumps"]):
                post(hwnd, WM_COMMAND, MPC[cmd])
            return True
        if action == "volume" and full:
            return await self._web(sess, f"wm_command=-2&volume={int(float(value) * 100)}")
        if action == "speed_step":
            return post(hwnd, WM_COMMAND, MPC["faster" if value == "up" else "slower" if value == "down" else "normal"])
        if action in MPC:
            return post(hwnd, WM_COMMAND, MPC[action])
        return False

    # -- one-click setup ------------------------------------------------

    def enable_full_control(self, restart):
        """Turns on MPC's web interface (localhost only). MPC saves its settings when it exits,
        so a running player has to close first; with restart=True we close it and reopen the file
        (MPC resumes at the same position)."""
        wins = find_windows(MPC_CLASSES)
        if wins and not restart:
            return "restart_needed"
        exe, reopen = None, None
        if wins:
            hwnd, _cls, _title, pid = wins[0]
            exe = process_path(pid)
            reopen = self._last_file()
            post(hwnd, WM_CLOSE, 0)
            if not wait_exit(pid, 10):
                return "MPC-HC didn't close. Close it yourself and try again."
        ini = _ini_path(exe)
        if ini:
            self._write_ini(ini)
        else:
            with winreg.CreateKey(winreg.HKEY_CURRENT_USER, MPC_REG) as k:
                winreg.SetValueEx(k, "EnableWebServer", 0, winreg.REG_DWORD, 1)
                winreg.SetValueEx(k, "WebServerLocalhostOnly", 0, winreg.REG_DWORD, 1)
        log.info("enabled MPC web interface")
        if exe:
            args = [exe] + ([reopen] if reopen and os.path.exists(reopen) else [])
            subprocess.Popen(args, close_fds=True, creationflags=0x00000008)  # DETACHED_PROCESS
        return "ok"

    @staticmethod
    def _last_file():
        best, best_t = None, ""
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\MPC-HC\MPC-HC\MediaHistory") as root:
                i = 0
                while True:
                    try:
                        sub = winreg.EnumKey(root, i)
                    except OSError:
                        break
                    i += 1
                    with winreg.OpenKey(root, sub) as k:
                        try:
                            t = winreg.QueryValueEx(k, "LastOpened")[0]
                            f = winreg.QueryValueEx(k, "Filename")[0]
                        except OSError:
                            continue
                        if t > best_t:
                            best, best_t = f, t
        except OSError:
            pass
        return best

    @staticmethod
    def _write_ini(path):
        with open(path, encoding="utf-16", errors="ignore") as f:
            lines = f.read().splitlines()
        want = {"EnableWebServer": "1", "WebServerLocalhostOnly": "1"}
        out, in_settings = [], False
        for line in lines:
            if line.startswith("["):
                if in_settings:
                    out += [f"{k}={v}" for k, v in want.items()]
                    want = {}
                in_settings = line.strip() == "[Settings]"
            key = line.split("=", 1)[0]
            if in_settings and key in want:
                line = f"{key}={want.pop(key)}"
            out.append(line)
        out += [f"{k}={v}" for k, v in want.items()]
        with open(path, "w", encoding="utf-16") as f:
            f.write("\n".join(out) + "\n")


# ----------------------------------------------------------- PotPlayer ---

POT_CLASSES = {"PotPlayer64", "PotPlayer"}
POT_GET_VOLUME, POT_SET_VOLUME = 0x5000, 0x5001
POT_GET_TOTAL_TIME, POT_GET_CURRENT_TIME, POT_SET_CURRENT_TIME = 0x5002, 0x5004, 0x5005
POT_GET_PLAY_STATUS, POT_SEND_VIRTUAL_KEY = 0x5006, 0x5010
VK = {"toggle": 0x20, "fullscreen": 0x0D, "next": 0x22, "previous": 0x21, "faster": 0x43, "slower": 0x58, "normal": 0x5A}


class PotPlayerProvider:
    name = "potplayer"

    def __init__(self, get_settings):
        self.get_settings = get_settings
        self.art = {}

    def _read(self):
        wins = find_windows(POT_CLASSES)
        if not wins:
            return None
        hwnd, _cls, title, pid = wins[0]
        state = send(hwnd, WM_USER, POT_GET_PLAY_STATUS)
        cur = send(hwnd, WM_USER, POT_GET_CURRENT_TIME)
        total = send(hwnd, WM_USER, POT_GET_TOTAL_TIME)
        vol = send(hwnd, WM_USER, POT_GET_VOLUME)
        return hwnd, title, pid, state, cur, total, vol

    async def sessions(self):
        if not WINDOWS or not self.get_settings().get("enabled", True):
            return []
        r = await asyncio.to_thread(self._read)
        if not r:
            return []
        hwnd, title, pid, state, cur, total, vol = r
        name = re.sub(r"\s*-\s*PotPlayer.*$", "", title)
        if state in (1, 2):
            status = "playing" if state == 2 else "paused"
        else:
            playing = (await asyncio.to_thread(audio_active)).get(os.path.basename(process_path(pid) or "").lower(), False)
            status = "playing" if playing else ("stopped" if state == -1 else "paused")
        if not name or name == "PotPlayer":
            if status == "stopped":
                return []
        dur = (total or 0) / 1000
        return [{"id": "potplayer", "provider": "potplayer", "app": "PotPlayer", "kind": "potplayer",
                 "title": pretty_title(name) or "PotPlayer", "file": name, "artist": "PotPlayer", "album": "",
                 "status": status, "position": max(0, (cur or 0) / 1000), "duration": max(0, dur), "rate": 1.0,
                 "volume": (vol / 100) if isinstance(vol, int) and 0 <= vol <= 100 else None, "art": None, "full": True, "live_seek": True,
                 "can": {"play": True, "next": True, "previous": True, "seek": dur > 0, "rate": False, "speed_step": True,
                         "volume": isinstance(vol, int) and 0 <= vol <= 100, "fullscreen": True, "subtitles": False,
                         "shuffle": False, "repeat": False},
                 "shuffle": False, "_hwnd": hwnd}]

    async def command(self, sess, action, value):
        hwnd = sess["_hwnd"]
        if action in ("seek", "seek_to"):
            t = float(value) if action == "seek_to" else sess["position"] + float(value)
            t = max(0.0, min(t, sess["duration"] or t))
            return send(hwnd, WM_USER, POT_SET_CURRENT_TIME, int(t * 1000)) is not None
        if action == "volume":
            return send(hwnd, WM_USER, POT_SET_VOLUME, int(float(value) * 100)) is not None
        if action == "speed_step":
            action = {"up": "faster", "down": "slower"}.get(value, "normal")
        if action in ("play", "pause"):
            if (action == "play") == (sess["status"] == "playing"):
                return True
            action = "toggle"
        if action == "stop":
            action = "toggle" if sess["status"] == "playing" else None
        if action in VK:
            return send(hwnd, WM_USER, POT_SEND_VIRTUAL_KEY, VK[action]) is not None
        return False
