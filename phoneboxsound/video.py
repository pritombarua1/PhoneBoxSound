"""Screen view as a video stream, the way remote-desktop programs do it.

Instead of a stream of JPEG pictures, the screen is captured straight from the graphics card (Windows'
Desktop Duplication), encoded as H.264 video by the PC's own hardware encoder (NVIDIA, AMD or Intel, else
Windows' built-in encoder, else OpenH264), and decoded by the phone's hardware (WebCodecs). A still screen
then costs almost nothing, a moving one a few Mbit/s, at up to 30 frames a second.

The encoding is done by FFmpeg, run as a separate program. PhoneBoxSound downloads the LGPL build of it
once, when the owner asks for it on the dashboard (it is never bundled into PhoneBoxSound itself), from
the FFmpeg-Builds project on GitHub, checked against that release's published checksums. An FFmpeg the PC
already has (on PATH) is used when it can capture the screen.

Sound always comes first: the hub decides when a video frame may go out (see Hub._video_loop).
"""
import asyncio
import ctypes
import hashlib
import logging
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
import zipfile

log = logging.getLogger("pbs.video")

BUILD = "ffmpeg-n8.1-latest-win64-lgpl-shared-8.1"
BASE_URL = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/"
SIZE_MB = 80
NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0

# best first: the PC's own video chips, then Windows' encoder, then software
ENCODERS = (
    ("h264_nvenc", "NVIDIA", ["-preset", "p1", "-tune", "ull", "-zerolatency", "1", "-delay", "0", "-rc", "cbr"]),
    ("h264_amf", "AMD", ["-usage", "ultralowlatency", "-rc", "cbr"]),
    ("h264_qsv", "Intel", ["-preset", "veryfast"]),
    ("h264_mf", "Windows (hardware)", ["-hw_encoding", "1"]),
    ("libopenh264", "OpenH264 (software)", ["-allow_skip_frames", "1"]),
    ("h264_mf", "Windows (software)", ["-hw_encoding", "0"]),
)


def video_chips():
    """The PC's graphics chips, strongest first: [(name, vendor, dedicated)]. Asked once from Windows."""
    if sys.platform != "win32":
        return []
    try:
        out = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command",
                              "Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name + '|' + $_.AdapterCompatibility }"],
                             capture_output=True, text=True, timeout=15, creationflags=NO_WINDOW).stdout
    except Exception:
        return []
    import re
    chips = []
    for line in out.splitlines():
        name, _, maker = line.strip().partition("|")
        low = (name + " " + maker).lower()
        vendor = "nvidia" if "nvidia" in low else "amd" if ("amd" in low or "radeon" in low or "advanced micro" in low) else "intel" if "intel" in low else None
        if not vendor:
            continue                         # virtual adapters (remote desktop, Parsec…) cannot encode
        dedicated = vendor == "nvidia" or bool(re.search(r"\b(rx\s?\d|radeon pro|radeon vii|firepro|arc\b|arc a|arc b)", low))
        chips.append((name.strip(), vendor, dedicated))
    return sorted(chips, key=lambda c: not c[2])     # dedicated cards before the ones built into the processor


VENDOR_ENCODER = {"nvidia": "h264_nvenc", "amd": "h264_amf", "intel": "h264_qsv"}


class Frame:
    __slots__ = ("data", "key", "t")

    def __init__(self, data, key):
        self.data, self.key, self.t = data, key, time.time()


def _nal_types(data):
    """Types of the NAL units in one access unit (Annex B)."""
    out, i, n = [], 0, len(data)
    while True:
        i = data.find(b"\x00\x00\x01", i)
        if i < 0 or i + 3 >= n:
            return out
        out.append(data[i + 3] & 0x1F)
        i += 3


class Stream:
    """One running encoder for one phone. Frames come out on an asyncio queue, newest last."""

    def __init__(self, cmd, loop):
        self.loop = loop
        self.queue = asyncio.Queue(maxsize=90)
        self.proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=NO_WINDOW)
        self.error = ""
        self.alive = True
        threading.Thread(target=self._read, daemon=True, name="video-out").start()
        threading.Thread(target=self._errors, daemon=True, name="video-err").start()

    def _push(self, au):
        if not au:
            return
        f = Frame(bytes(au), 5 in _nal_types(au))
        def put():
            if self.queue.full():
                try:
                    self.queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            self.queue.put_nowait(f)
        self.loop.call_soon_threadsafe(put)

    def _read(self):
        # the encoder writes an "access unit delimiter" before every frame: split the stream there
        buf, aud = bytearray(), b"\x00\x00\x00\x01\x09"
        try:
            while True:
                chunk = self.proc.stdout.read1(1 << 16)
                if not chunk:
                    break
                buf.extend(chunk)
                while True:
                    j = buf.find(aud, 1)
                    if j < 0:
                        break
                    self._push(buf[:j])
                    del buf[:j]
            self._push(buf)
        finally:
            self.alive = False

    def _errors(self):
        for line in self.proc.stderr:
            self.error = line.decode(errors="replace").strip()[:300]

    async def next(self, timeout=2.0):
        return await asyncio.wait_for(self.queue.get(), timeout)

    def stop(self):
        self.alive = False
        try:
            self.proc.kill()
        except Exception:
            pass


class Video:
    def __init__(self, data_dir, demo=False):
        self.dir = os.path.join(data_dir, "tools", "ffmpeg")
        self.demo = demo
        self.encoder = None            # (codec, label, args) that worked on this PC
        self.chips = []
        self.checked = False
        self.installing = None         # {"done": bytes, "total": bytes} while downloading
        self.error = None
        self._lock = asyncio.Lock()

    # ---------------------------------------------------------------- finding FFmpeg
    def ffmpeg(self):
        own = os.path.join(self.dir, "ffmpeg.exe" if sys.platform == "win32" else "ffmpeg")
        if os.path.exists(own):
            return own, "downloaded"
        found = shutil.which("ffmpeg")
        return (found, "this PC") if found else (None, None)

    def status(self):
        path, source = self.ffmpeg()
        if self.demo and not os.environ.get("PHONEBOXSOUND_DEMO_VIDEO"):
            path, source = None, None          # the demo shows the offer, as on a PC that has never had it
        return {"available": bool(self.encoder), "encoder": self.encoder[1] if self.encoder else None,
                "installed": bool(path), "source": source, "checked": self.checked,
                "installing": self.installing, "error": self.error, "size_mb": SIZE_MB}

    def _input(self, fps):
        if self.demo:          # tests and the demo: a moving test picture instead of the desktop
            return ["-re", "-f", "lavfi", "-i", f"testsrc2=size=1280x720:rate={fps}"], "format=nv12"
        return ["-f", "lavfi", "-i", f"ddagrab=output_idx=0:framerate={fps}:draw_mouse=0"], None

    def command(self, enc, width=1280, fps=24, kbps=1500):
        path, _ = self.ffmpeg()
        inp, vf = self._input(fps)
        codec, _, extra = enc
        vf = vf or f"hwdownload,format=bgra,scale={width}:-2,format=nv12"
        if self.demo:
            vf = f"scale={width}:-2,format=nv12"
        return [path, "-hide_banner", "-loglevel", "error", "-nostdin", *inp, "-vf", vf, "-c:v", codec, *extra,
                "-b:v", f"{kbps}k", "-maxrate", f"{kbps}k", "-bufsize", f"{max(200, kbps // 2)}k",
                "-g", str(fps * 2), "-bf", "0", "-fps_mode", "passthrough",
                "-bsf:v", "h264_metadata=aud=insert", "-an", "-f", "h264", "-"]

    async def check(self, force=False):
        """Find an encoder that works on this PC (a 1-second test each, best first)."""
        async with self._lock:
            if self.checked and not force:
                return self.encoder
            self.encoder, self.error = None, None
            path, _ = self.ffmpeg()
            only = os.environ.get("PHONEBOXSOUND_VIDEO_ENCODERS")     # tests: "none", or e.g. "h264_mf,libopenh264"
            # the strongest chip's encoder first (a dedicated card before the one built into the processor)
            chips = [] if self.demo else await asyncio.to_thread(video_chips)
            self.chips = chips
            order = [VENDOR_ENCODER[v] for _, v, _ in chips]
            ranked = sorted(ENCODERS, key=lambda e: order.index(e[0]) if e[0] in order else len(order) + ENCODERS.index(e))
            candidates = [e for e in ranked if only is None or e[0] in only.split(",")]
            if path:
                for enc in candidates:
                    ok = await asyncio.to_thread(self._try, enc)
                    if ok:
                        chip = next((n for n, v, _ in chips if VENDOR_ENCODER.get(v) == enc[0]), None)
                        self.encoder = (enc[0], chip or enc[1], enc[2])
                        log.info("screen video: %s (%s)", enc[1], enc[0])
                        break
                if not self.encoder:
                    self.error = "No video encoder worked on this PC; screen view uses pictures."
            self.checked = True
            return self.encoder

    def _try(self, enc):
        cmd = self.command(enc, 640, 15, 500)
        at = cmd.index("-an")
        cmd[at:at] = ["-frames:v", "8"]
        try:
            r = subprocess.run(cmd, capture_output=True, timeout=5, creationflags=NO_WINDOW)
            return r.returncode == 0 and r.stdout.count(b"\x00\x00\x00\x01\x09") >= 4
        except Exception:
            return False

    def start(self, width=1280, fps=24, kbps=1500):
        if not self.encoder:
            return None
        return Stream(self.command(self.encoder, width, fps, kbps), asyncio.get_running_loop())

    # ---------------------------------------------------------------- the one-time download
    async def install(self, on_progress=None):
        """Download the LGPL FFmpeg build, check it against the published checksum, keep only the program."""
        if self.installing:
            return
        self.installing, self.error = {"done": 0, "total": SIZE_MB << 20}, None
        try:
            await asyncio.to_thread(self._install, on_progress)
        except Exception as e:
            self.error = f"The download did not work: {e}"
            log.warning("ffmpeg download failed: %s", e)
        finally:
            self.installing = None
        await self.check(force=True)
        if on_progress:
            on_progress()

    def _install(self, on_progress):
        sums = urllib.request.urlopen(BASE_URL + "checksums.sha256", timeout=30).read().decode()
        want = next((line.split()[0] for line in sums.splitlines() if line.strip().endswith(BUILD + ".zip")), None)
        if not want:
            raise RuntimeError("the checksum for the build is not published")
        os.makedirs(self.dir, exist_ok=True)
        tmp = os.path.join(self.dir, "download.zip")
        h, last = hashlib.sha256(), 0
        with urllib.request.urlopen(BASE_URL + BUILD + ".zip", timeout=60) as r, open(tmp, "wb") as f:
            self.installing["total"] = int(r.headers.get("Content-Length") or self.installing["total"])
            while True:
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                f.write(chunk)
                h.update(chunk)
                self.installing["done"] += len(chunk)
                if on_progress and time.time() - last > 0.5:
                    last = time.time()
                    on_progress()
        if h.hexdigest() != want:
            os.remove(tmp)
            raise RuntimeError("the file does not match its published checksum")
        with zipfile.ZipFile(tmp) as z:
            for name in z.namelist():
                base = os.path.basename(name)
                if ("/bin/" in name and base.endswith((".exe", ".dll")) and base != "ffplay.exe") or base == "LICENSE.txt":
                    with z.open(name) as src, open(os.path.join(self.dir, base), "wb") as dst:
                        shutil.copyfileobj(src, dst)
        os.remove(tmp)


def cursor_on_screen():
    """Where the pointer is on the main screen, 0..1 (or -1, -1 when it is on another screen)."""
    if sys.platform != "win32":
        return -1.0, -1.0
    try:
        pt = ctypes.wintypes.POINT()
        ctypes.windll.user32.GetCursorPos(ctypes.byref(pt))
        w, h = ctypes.windll.user32.GetSystemMetrics(0), ctypes.windll.user32.GetSystemMetrics(1)
        if 0 <= pt.x < w and 0 <= pt.y < h:
            return pt.x / w, pt.y / h
    except Exception:
        pass
    return -1.0, -1.0


import ctypes.wintypes  # noqa: E402
