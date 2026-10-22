"""Files between phones and this PC, both ways, untouched.

Phone to PC: a file goes up in pieces (resumable). The phone first announces it (name, size, date), then
sends pieces at the offset the PC confirms; if the Wi-Fi drops or the phone sleeps, it asks where the PC got
to and carries on from there. When the last byte is in, the file gets its final name and its original date.
Nothing is converted or compressed: the bytes on the PC are the bytes the phone sent.

PC to phone: the phone browses the shared folder (and folders inside it), with small pictures of photos and
videos, and downloads with ranges (so a big download can resume too). The dashboard can also push files to
one phone: they land in "Sent to <phone>" inside the shared folder and the phone is told about them.

Everything stays inside the shared folder: any path a phone sends is resolved and refused if it would
lead outside it.
"""
import io
import logging
import mimetypes
import os
import secrets
import shutil
import subprocess
import sys
import time
from collections import OrderedDict

log = logging.getLogger("pbs.transfer")

INCOMING = ".incoming"            # unfinished uploads, inside the shared folder, never listed
MAX_FILE = 64 * 1024 ** 3         # a single file may be up to 64 GB (long 4K videos)
KEEP_FREE = 512 * 1024 ** 2       # always leave this much space on the PC's disk
STALE = 2 * 24 * 3600             # unfinished uploads older than this are removed
IMAGE = (".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".heic", ".heif", ".avif", ".tif", ".tiff", ".dng", ".raw")
VIDEO = (".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi", ".3gp", ".wmv", ".mts")
AUDIO = (".mp3", ".m4a", ".aac", ".wav", ".flac", ".ogg", ".opus", ".wma")
NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0


def kind_of(name):
    n = name.lower()
    return "image" if n.endswith(IMAGE) else "video" if n.endswith(VIDEO) else "audio" if n.endswith(AUDIO) else "file"


def clean_name(name):
    name = os.path.basename(str(name or "")).strip()
    name = "".join(ch for ch in name if ch not in '<>:"/\\|?*' and ord(ch) >= 32).strip(" .")
    return name[:180] or "file"


class Refused(Exception):
    """Why a transfer cannot happen, in words for the phone."""


class Transfers:
    def __init__(self, root_fn, ffmpeg_fn=None):
        self.root_fn = root_fn                # the shared folder (it may change in Settings)
        self.ffmpeg_fn = ffmpeg_fn            # the video helper, for pictures of videos (optional)
        self.uploads = {}                     # id -> dict
        self.thumbs = OrderedDict()           # (path, mtime) -> jpeg bytes
        try:
            self.cleanup()
        except Exception as e:
            log.debug("cleanup failed: %s", e)

    # ------------------------------------------------------------------ paths
    @property
    def root(self):
        return os.path.realpath(self.root_fn())

    def resolve(self, rel, must_exist=True):
        """A path inside the shared folder from what a phone sent, or Refused."""
        rel = str(rel or "").replace("\\", "/").strip("/")
        parts = [p for p in rel.split("/") if p not in ("", ".")]
        if any(p == ".." or p.startswith(INCOMING) for p in parts):
            raise Refused("That place is outside the shared folder")
        path = os.path.realpath(os.path.join(self.root, *parts))
        if path != self.root and not path.startswith(self.root + os.sep):
            raise Refused("That place is outside the shared folder")
        if must_exist and not os.path.exists(path):
            raise Refused("It is not there any more")
        return path

    def rel(self, path):
        return os.path.relpath(path, self.root).replace("\\", "/")

    # ------------------------------------------------------------------ PC to phone
    def listdir(self, rel=""):
        d = self.resolve(rel)
        if not os.path.isdir(d):
            raise Refused("That is not a folder")
        dirs, files = [], []
        with os.scandir(d) as it:
            for e in it:
                if e.name.startswith(".") or e.name.endswith(".part"):
                    continue
                try:
                    if e.is_dir(follow_symlinks=False):
                        dirs.append({"name": e.name, "path": self.rel(e.path), "mtime": e.stat().st_mtime})
                    elif e.is_file(follow_symlinks=False):
                        st = e.stat()
                        files.append({"name": e.name, "path": self.rel(e.path), "size": st.st_size, "mtime": st.st_mtime, "kind": kind_of(e.name)})
                except OSError:
                    continue
        dirs.sort(key=lambda x: x["name"].lower())
        files.sort(key=lambda x: -x["mtime"])
        return {"path": "" if d == self.root else self.rel(d), "dirs": dirs, "files": files[:2000], "more": max(0, len(files) - 2000)}

    def file_for_download(self, rel):
        p = self.resolve(rel)
        if not os.path.isfile(p):
            raise Refused("That is not a file")
        return p

    def thumb(self, rel):
        """A small JPEG of a photo or a video, or None."""
        p = self.file_for_download(rel)
        key = (p, os.path.getmtime(p))
        if key in self.thumbs:
            self.thumbs.move_to_end(key)
            return self.thumbs[key]
        data, kind = None, kind_of(p)
        try:
            if kind == "image":
                from PIL import Image, ImageOps
                with Image.open(p) as im:
                    im = ImageOps.exif_transpose(im)
                    im.thumbnail((320, 320))
                    out = io.BytesIO()
                    im.convert("RGB").save(out, "JPEG", quality=72)
                    data = out.getvalue()
            elif kind == "video" and self.ffmpeg_fn:
                ff = self.ffmpeg_fn()
                if ff:
                    r = subprocess.run([ff, "-hide_banner", "-loglevel", "error", "-ss", "1", "-i", p, "-frames:v", "1", "-vf", "scale=320:-2",
                                        "-f", "image2", "-c:v", "mjpeg", "-q:v", "6", "-"], capture_output=True, timeout=15, creationflags=NO_WINDOW)
                    data = r.stdout or None
        except Exception as e:
            log.debug("no picture for %s: %s", p, e)
        self.thumbs[key] = data
        while len(self.thumbs) > 400:
            self.thumbs.popitem(last=False)
        return data

    # ------------------------------------------------------------------ phone to PC
    def start(self, who, name, size, mtime=None, folder=""):
        name = clean_name(name)
        try:
            size = int(size)
        except (TypeError, ValueError):
            raise Refused("The file's size is missing")
        if size < 0 or size > MAX_FILE:
            raise Refused("That file is too big (more than 64 GB)")
        target = self.resolve(folder, must_exist=False)
        os.makedirs(target, exist_ok=True)
        free = shutil.disk_usage(target).free
        if size > free - KEEP_FREE:
            raise Refused(f"The PC's disk is too full for this file ({size / 1e9:.1f} GB needed, {max(0, free - KEEP_FREE) / 1e9:.1f} GB free)")
        inc = os.path.join(self.root, INCOMING)
        os.makedirs(inc, exist_ok=True)
        uid = secrets.token_urlsafe(12)
        part = os.path.join(inc, uid + ".part")
        open(part, "wb").close()
        self.uploads[uid] = {"id": uid, "who": who, "name": name, "size": size, "done": 0, "part": part, "target": target,
                             "mtime": float(mtime) / 1000 if mtime else None, "started": time.time(), "at": time.time(), "mark": 0, "speed": 0.0}
        return uid

    def get(self, uid, who):
        u = self.uploads.get(str(uid))
        if not u or u["who"] != who:
            raise Refused("This transfer is unknown (it may have finished or been cancelled)")
        return u

    async def write(self, uid, who, offset, chunks):
        """Append the bytes from `chunks` (an async iterator) at `offset`. Returns the size now on the PC."""
        u = self.get(uid, who)
        if int(offset) != u["done"]:
            return u["done"]                     # the phone resumes from what the PC really has
        import asyncio
        with open(u["part"], "ab") as f:
            buf = bytearray()

            async def flush():
                if buf:
                    await asyncio.to_thread(f.write, bytes(buf))     # never on the thread that sends the sound
                    u["done"] += len(buf)
                    buf.clear()

            async for chunk in chunks:
                if u["done"] + len(buf) + len(chunk) > u["size"]:
                    raise Refused("More bytes than the file announced")
                buf.extend(chunk)
                if len(buf) < 1 << 20:
                    continue
                await flush()
                now = time.time()
                if now - u["at"] > 0.5:                 # bytes per second, smoothed: for the dashboard
                    inst = (u["done"] - u["mark"]) / (now - u["at"])
                    u["speed"] = inst if not u["speed"] else 0.7 * u["speed"] + 0.3 * inst
                    u["at"], u["mark"] = now, u["done"]
            await flush()
        return u["done"]

    def finish(self, uid, who):
        u = self.get(uid, who)
        if u["done"] != u["size"]:
            raise Refused(f"The file is not complete yet ({u['done']} of {u['size']} bytes)")
        base, ext = os.path.splitext(u["name"])
        path, n = os.path.join(u["target"], u["name"]), 1
        while os.path.exists(path):
            path, n = os.path.join(u["target"], f"{base} ({n}){ext}"), n + 1
        os.replace(u["part"], path)
        if u["mtime"]:
            try:
                os.utime(path, (u["mtime"], u["mtime"]))       # the photo keeps the date it was taken
            except OSError:
                pass
        del self.uploads[uid]
        return {"name": os.path.basename(path), "path": self.rel(path), "size": u["size"]}

    def cancel(self, uid, who):
        u = self.uploads.pop(str(uid), None)
        if u and u["who"] == who:
            try:
                os.remove(u["part"])
            except OSError:
                pass

    def active(self):
        """Uploads in progress, for the dashboard."""
        return [{"name": u["name"], "who": u["who"], "size": u["size"], "done": u["done"], "speed": round(u["speed"])}
                for u in self.uploads.values() if time.time() - u["at"] < 120]

    def cleanup(self):
        inc = os.path.join(self.root, INCOMING)
        if not os.path.isdir(inc):
            return
        for name in os.listdir(inc):
            p = os.path.join(inc, name)
            try:
                if time.time() - os.path.getmtime(p) > STALE:
                    os.remove(p)
            except OSError:
                pass

    # ------------------------------------------------------------------ the dashboard pushes files to a phone
    def save_for(self, phone_name, name):
        """A new, unused path in "Sent to <phone>" for a file the dashboard is sending."""
        folder = os.path.join(self.root, clean_name(f"Sent to {phone_name}"))
        os.makedirs(folder, exist_ok=True)
        name = clean_name(name)
        base, ext = os.path.splitext(name)
        path, n = os.path.join(folder, name), 1
        while os.path.exists(path) or os.path.exists(path + ".part"):
            path, n = os.path.join(folder, f"{base} ({n}){ext}"), n + 1
        return path


def content_type(path):
    return mimetypes.guess_type(path)[0] or "application/octet-stream"
