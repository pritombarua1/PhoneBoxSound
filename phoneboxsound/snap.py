"""Grab the current picture of a player window, to use as "now playing" artwork.

Used for players that have no cover art of their own (MPC-HC, PotPlayer, VLC): the phone shows the
actual frame you are watching. Uses PrintWindow, so it works even when the window is covered.
"""
import ctypes
import hashlib
import io
import logging
import sys

log = logging.getLogger("pbs.snap")
WINDOWS = sys.platform == "win32"

if WINDOWS:
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    gdi32 = ctypes.windll.gdi32
    user32.GetDC.restype = wintypes.HDC
    user32.GetDC.argtypes = [wintypes.HWND]
    user32.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
    user32.PrintWindow.argtypes = [wintypes.HWND, wintypes.HDC, wintypes.UINT]
    gdi32.CreateCompatibleDC.restype = wintypes.HDC
    gdi32.CreateCompatibleDC.argtypes = [wintypes.HDC]
    gdi32.CreateCompatibleBitmap.restype = wintypes.HBITMAP
    gdi32.CreateCompatibleBitmap.argtypes = [wintypes.HDC, ctypes.c_int, ctypes.c_int]
    gdi32.SelectObject.restype = wintypes.HGDIOBJ
    gdi32.SelectObject.argtypes = [wintypes.HDC, wintypes.HGDIOBJ]
    gdi32.DeleteObject.argtypes = [wintypes.HGDIOBJ]
    gdi32.DeleteDC.argtypes = [wintypes.HDC]
    gdi32.GetDIBits.argtypes = [wintypes.HDC, wintypes.HBITMAP, wintypes.UINT, wintypes.UINT, ctypes.c_void_p,
                                ctypes.c_void_p, wintypes.UINT]

    class BITMAPINFOHEADER(ctypes.Structure):
        _fields_ = [("biSize", wintypes.DWORD), ("biWidth", wintypes.LONG), ("biHeight", wintypes.LONG),
                    ("biPlanes", wintypes.WORD), ("biBitCount", wintypes.WORD), ("biCompression", wintypes.DWORD),
                    ("biSizeImage", wintypes.DWORD), ("biXPelsPerMeter", wintypes.LONG),
                    ("biYPelsPerMeter", wintypes.LONG), ("biClrUsed", wintypes.DWORD), ("biClrImportant", wintypes.DWORD)]

PW_RENDERFULLCONTENT = 2


def _grab(hwnd):
    """Whole window as a PIL image (or None)."""
    from PIL import Image
    if user32.IsIconic(hwnd):
        return None  # minimised windows have nothing to draw
    rect = wintypes.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rect))
    w, h = rect.right - rect.left, rect.bottom - rect.top
    if w < 80 or h < 60 or w > 8000 or h > 8000:
        return None
    wdc = user32.GetDC(hwnd)
    mdc = gdi32.CreateCompatibleDC(wdc)
    bmp = gdi32.CreateCompatibleBitmap(wdc, w, h)
    old = gdi32.SelectObject(mdc, bmp)
    try:
        if not user32.PrintWindow(hwnd, mdc, PW_RENDERFULLCONTENT):
            return None
        bi = BITMAPINFOHEADER()
        bi.biSize = ctypes.sizeof(BITMAPINFOHEADER)
        bi.biWidth, bi.biHeight, bi.biPlanes, bi.biBitCount = w, -h, 1, 32  # negative height = top-down rows
        buf = ctypes.create_string_buffer(w * h * 4)
        if not gdi32.GetDIBits(mdc, bmp, 0, h, buf, ctypes.byref(bi), 0):
            return None
        return Image.frombuffer("RGB", (w, h), buf, "raw", "BGRX", 0, 1), (rect.left, rect.top)
    finally:
        gdi32.SelectObject(mdc, old)
        gdi32.DeleteObject(bmp)
        gdi32.DeleteDC(mdc)
        user32.ReleaseDC(hwnd, wdc)


def _trim_bars(img):
    """Crop black letterbox bars so the thumbnail is all picture."""
    from PIL import ImageChops
    small = img.resize((160, 90))
    box = ImageChops.difference(small, small.point(lambda _: 0)).point(lambda v: 255 if v > 22 else 0).getbbox()
    if not box:
        return img
    sx, sy = img.width / 160, img.height / 90
    l, t, r, b = int(box[0] * sx), int(box[1] * sy), int(box[2] * sx), int(box[3] * sy)
    if (r - l) < img.width * 0.3 or (b - t) < img.height * 0.3:
        return img
    return img.crop((l, t, r, b))


def capture(hwnd, child=None, max_width=960):
    """JPEG of the window (or of the `child` window's area inside it).

    Returns (hash, bytes, "image/jpeg"), or None if the window can't be captured or the frame is black.
    """
    if not WINDOWS:
        return None
    try:
        got = _grab(hwnd)
        if not got:
            return None
        img, (left, top) = got
        if child:
            r = wintypes.RECT()
            user32.GetWindowRect(child, ctypes.byref(r))
            box = (max(0, r.left - left), max(0, r.top - top), min(img.width, r.right - left), min(img.height, r.bottom - top))
            if box[2] - box[0] > 60 and box[3] - box[1] > 40:
                img = img.crop(box)
        img = _trim_bars(img)
        stat = img.resize((32, 18)).convert("L")
        pixels = list(stat.getdata())
        if sum(pixels) / len(pixels) < 6:  # black frame (fade, protected video, nothing rendered)
            return None
        if img.width > max_width:
            img = img.resize((max_width, round(img.height * max_width / img.width)))
        out = io.BytesIO()
        img.save(out, "JPEG", quality=82, optimize=True)
        data = out.getvalue()
        return hashlib.sha1(data).hexdigest()[:12], data, "image/jpeg"
    except Exception as e:
        log.debug("window capture failed: %s", e)
        return None
