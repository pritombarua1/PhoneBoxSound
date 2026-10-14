"""The PC's clipboard and screen, for the phone's clipboard sync and "screen view".

Two implementations with the same interface:
  * Desktop      - the real Windows clipboard and screen.
  * DemoDesktop  - an in-memory clipboard and a drawn fake screen, so demo mode, screenshots and
                   tests never read or change anything real.
"""
import base64
import ctypes
import hashlib
import io
import logging
import sys
import time

log = logging.getLogger("pbs.desktop")
WINDOWS = sys.platform == "win32"
CF_UNICODETEXT, CF_DIB = 13, 8
GMEM_MOVEABLE = 0x0002

if WINDOWS:
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32
    user32.OpenClipboard.argtypes = [wintypes.HWND]
    user32.GetClipboardData.restype = ctypes.c_void_p
    user32.GetClipboardData.argtypes = [wintypes.UINT]
    user32.SetClipboardData.restype = ctypes.c_void_p
    user32.SetClipboardData.argtypes = [wintypes.UINT, ctypes.c_void_p]
    kernel32.GlobalAlloc.restype = ctypes.c_void_p
    kernel32.GlobalAlloc.argtypes = [wintypes.UINT, ctypes.c_size_t]
    kernel32.GlobalLock.restype = ctypes.c_void_p
    kernel32.GlobalLock.argtypes = [ctypes.c_void_p]
    kernel32.GlobalUnlock.argtypes = [ctypes.c_void_p]
    kernel32.GlobalSize.restype = ctypes.c_size_t
    kernel32.GlobalSize.argtypes = [ctypes.c_void_p]


def _jpeg(img, max_width, quality):
    if img.mode != "RGB":
        img = img.convert("RGB")
    if img.width > max_width:
        img = img.resize((max_width, max(1, round(img.height * max_width / img.width))))
    out = io.BytesIO()
    img.save(out, "JPEG", quality=quality)
    return out.getvalue()


def data_url(data, ctype="image/jpeg"):
    return f"data:{ctype};base64," + base64.b64encode(data).decode()


def image_from_data_url(url):
    from PIL import Image
    head, _, b64 = url.partition(",")
    if not head.startswith("data:image/"):
        raise ValueError("not an image")
    raw = base64.b64decode(b64)
    if len(raw) > 12_000_000:
        raise ValueError("image too large")
    img = Image.open(io.BytesIO(raw))
    img.load()
    return img


class Desktop:
    demo = False

    # ------------------------------------------------------------ clipboard

    def _open(self):
        for _ in range(10):  # another app may hold the clipboard for a moment
            if user32.OpenClipboard(None):
                return True
            time.sleep(0.02)
        return False

    def clipboard_seq(self):
        return user32.GetClipboardSequenceNumber() if WINDOWS else 0

    def get_clipboard(self):
        """{"kind": "text", "text"} | {"kind": "image", "image": data-url, "w", "h"} | {"kind": "empty"}"""
        if not WINDOWS:
            return {"kind": "empty"}
        text = None
        if self._open():
            try:
                h = user32.GetClipboardData(CF_UNICODETEXT)
                if h:
                    p = kernel32.GlobalLock(h)
                    if p:
                        try:
                            text = ctypes.wstring_at(p)
                        finally:
                            kernel32.GlobalUnlock(h)
            finally:
                user32.CloseClipboard()
        if text:
            return {"kind": "text", "text": text[:200_000]}
        try:
            from PIL import Image, ImageGrab
            got = ImageGrab.grabclipboard()
            if isinstance(got, list):  # files copied in Explorer
                names = [str(p) for p in got]
                first = names[0] if names else ""
                if first.lower().endswith((".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif")):
                    got = Image.open(first)
                else:
                    return {"kind": "text", "text": "\n".join(names)}
            if got is not None:
                w, h = got.size
                return {"kind": "image", "image": data_url(_jpeg(got, 1600, 85)), "w": w, "h": h}
        except Exception as e:
            log.debug("clipboard image read failed: %s", e)
        return {"kind": "empty"}

    def _set(self, fmt, data):
        if not self._open():
            raise RuntimeError("The clipboard is busy, try again")
        try:
            user32.EmptyClipboard()
            h = kernel32.GlobalAlloc(GMEM_MOVEABLE, len(data))
            p = kernel32.GlobalLock(h)
            ctypes.memmove(p, data, len(data))
            kernel32.GlobalUnlock(h)
            if not user32.SetClipboardData(fmt, h):
                raise RuntimeError("Windows refused the clipboard data")
        finally:
            user32.CloseClipboard()

    def set_clipboard_text(self, text):
        self._set(CF_UNICODETEXT, (str(text)[:200_000] + "\0").encode("utf-16-le"))

    def set_clipboard_image(self, img):
        out = io.BytesIO()
        img.convert("RGB").save(out, "BMP")
        self._set(CF_DIB, out.getvalue()[14:])  # a DIB is a BMP file without its 14-byte file header

    # --------------------------------------------------------------- screen

    def grab(self, mode="screen", max_width=1280, quality=55, zoom=3.0):
        """JPEG of the whole screen, the active window, or (mode "zoom") the area around the cursor at
        full sharpness - a magnifier. Also returns where the cursor is inside the picture (0..1).

        Returns (jpeg bytes, cursor_x, cursor_y) with cursor -1 when it is outside the picture."""
        from PIL import ImageGrab
        pt = wintypes.POINT()
        user32.GetCursorPos(ctypes.byref(pt))
        if mode == "zoom":
            sw, sh = user32.GetSystemMetrics(0), user32.GetSystemMetrics(1)
            w, h = int(sw / zoom), int(sh / zoom)
            left = max(0, min(sw - w, pt.x - w // 2))
            top = max(0, min(sh - h, pt.y - h // 2))
            img = ImageGrab.grab(bbox=(left, top, left + w, top + h))
            # no downscaling below the phone's needs: text stays sharp, that is the whole point
            return _jpeg(img, max(max_width, 1600), 72), (pt.x - left) / w, (pt.y - top) / h
        if mode == "window":
            hwnd = user32.GetForegroundWindow()
            r = wintypes.RECT()
            if hwnd and user32.GetWindowRect(hwnd, ctypes.byref(r)) and r.right - r.left > 40:
                from . import snap
                got = snap._grab(hwnd)
                if got:
                    img, (left, top) = got
                    cx, cy = (pt.x - left) / img.width, (pt.y - top) / img.height
                    inside = 0 <= cx <= 1 and 0 <= cy <= 1
                    return _jpeg(img, max_width, quality), cx if inside else -1, cy if inside else -1
        img = ImageGrab.grab()
        return _jpeg(img, max_width, quality), pt.x / img.width, pt.y / img.height


class DemoDesktop(Desktop):
    """Nothing real is read or written: a private clipboard and a drawn desktop."""
    demo = True

    def __init__(self):
        self.clip = {"kind": "text", "text": "https://github.com/phoneboxsound - copied on the PC"}
        self.seq = 1
        self.cursor = [0.52, 0.46]

    def clipboard_seq(self):
        return self.seq

    def get_clipboard(self):
        return dict(self.clip)

    def set_clipboard_text(self, text):
        self.clip = {"kind": "text", "text": str(text)}
        self.seq += 1

    def set_clipboard_image(self, img):
        self.clip = {"kind": "image", "image": data_url(_jpeg(img, 1600, 85)), "w": img.width, "h": img.height}
        self.seq += 1

    # demo / tests: the middle of the pretend screen is a "text box"
    def over(self):
        return 0.4 <= self.cursor[0] <= 0.6 and 0.4 <= self.cursor[1] <= 0.6

    focused = over

    def move_cursor(self, dx, dy):
        self.cursor[0] = min(1, max(0, self.cursor[0] + dx / 3840))
        self.cursor[1] = min(1, max(0, self.cursor[1] + dy / 2160))

    def grab(self, mode="screen", max_width=1280, quality=55, zoom=3.0):
        if mode == "zoom":
            from PIL import Image
            import io as _io
            full, cx, cy = self.grab("screen", 1280, 90)
            img = Image.open(_io.BytesIO(full))
            w, h = int(img.width / zoom), int(img.height / zoom)
            left = max(0, min(img.width - w, int(cx * img.width) - w // 2))
            top = max(0, min(img.height - h, int(cy * img.height) - h // 2))
            crop = img.crop((left, top, left + w, top + h)).resize((1280, 720), Image.LANCZOS)
            return _jpeg(crop, 1600, 80), (cx * img.width - left) / w, (cy * img.height - top) / h
        from PIL import Image, ImageDraw
        w, h = 1280, 720
        img = Image.new("RGB", (w, h))
        d = ImageDraw.Draw(img)
        for y in range(h):
            k = y / h
            d.line([(0, y), (w, y)], fill=(int(18 + 30 * k), int(40 + 50 * k), int(52 + 40 * (1 - k))))
        d.rectangle((0, h - 44, w, h), fill=(14, 18, 22))
        for i in range(7):
            d.rounded_rectangle((20 + i * 52, h - 36, 56 + i * 52, h - 8), 7, fill=(52 + i * 9, 110, 96))
        if mode == "window":
            d.rectangle((0, 0, w, h), fill=(16, 22, 20))
        x0, y0, x1, y1 = (160, 70, 1120, 610) if mode != "window" else (0, 0, w, h - 1)
        d.rounded_rectangle((x0, y0, x1, y1), 14, fill=(20, 28, 25), outline=(60, 90, 78), width=2)
        d.rounded_rectangle((x0, y0, x1, y0 + 40), 14, fill=(28, 40, 35))
        d.text((x0 + 18, y0 + 13), "Demo Player - Big Buck Bunny", fill=(210, 230, 220))
        d.rectangle((x0 + 24, y0 + 60, x1 - 24, y1 - 70), fill=(46, 110, 80))
        d.ellipse((x1 - 250, y0 + 90, x1 - 110, y0 + 230), fill=(170, 240, 200))
        d.polygon([(x0 + 24, y1 - 70), (x0 + 260, y0 + 250), (x0 + 520, y1 - 70)], fill=(22, 60, 44))
        d.polygon([(x0 + 380, y1 - 70), (x0 + 640, y0 + 200), (x1 - 24, y1 - 70)], fill=(18, 48, 36))
        d.rounded_rectangle((x0 + 24, y1 - 46, x1 - 24, y1 - 40), 3, fill=(60, 80, 72))
        d.rounded_rectangle((x0 + 24, y1 - 46, x0 + 24 + int((x1 - x0 - 48) * ((time.time() % 60) / 60)), y1 - 40), 3, fill=(88, 207, 154))
        return _jpeg(img, max_width, quality), self.cursor[0], self.cursor[1]


def frame_hash(data):
    return hashlib.blake2b(data, digest_size=8).digest()
