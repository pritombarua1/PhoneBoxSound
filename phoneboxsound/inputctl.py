"""Keyboard and mouse injection (Windows SendInput). Used by the phone trackpad/keys remote.

Only devices that were given the "Keyboard & mouse" permission in the dashboard can reach this.
"""
import ctypes
import sys

ENABLED = sys.platform == "win32"

VK = {
    "backspace": 0x08, "tab": 0x09, "enter": 0x0D, "shift": 0x10, "ctrl": 0x11, "alt": 0x12,
    "esc": 0x1B, "space": 0x20, "pageup": 0x21, "pagedown": 0x22, "end": 0x23, "home": 0x24,
    "left": 0x25, "up": 0x26, "right": 0x27, "down": 0x28, "delete": 0x2E, "win": 0x5B,
    "f1": 0x70, "f2": 0x71, "f3": 0x72, "f4": 0x73, "f5": 0x74, "f6": 0x75, "f7": 0x76, "f8": 0x77,
    "f9": 0x78, "f10": 0x79, "f11": 0x7A, "f12": 0x7B,
    "capslock": 0x14, "printscreen": 0x2C, "insert": 0x2D, "menu": 0x5D,
    ";": 0xBA, "=": 0xBB, "-": 0xBD, "/": 0xBF, "`": 0xC0, "\\": 0xDC, "'": 0xDE,
    "volume_mute": 0xAD, "volume_down": 0xAE, "volume_up": 0xAF, "next_track": 0xB0,
    "prev_track": 0xB1, "stop_media": 0xB2, "play_pause": 0xB3,
    ".": 0xBE, ",": 0xBC, "[": 0xDB, "]": 0xDD,
}
EXTENDED = {"left", "up", "right", "down", "pageup", "pagedown", "end", "home", "delete", "win", "insert", "printscreen", "menu",
            "volume_mute", "volume_down", "volume_up", "next_track", "prev_track", "stop_media", "play_pause"}
ALLOWED_KEYS = set(VK) | set("abcdefghijklmnopqrstuvwxyz0123456789")

if ENABLED:
    from ctypes import wintypes

    ULONG_PTR = ctypes.c_size_t

    class MOUSEINPUT(ctypes.Structure):
        _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG), ("mouseData", wintypes.DWORD),
                    ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD), ("dwExtraInfo", ULONG_PTR)]

    class KEYBDINPUT(ctypes.Structure):
        _fields_ = [("wVk", wintypes.WORD), ("wScan", wintypes.WORD), ("dwFlags", wintypes.DWORD),
                    ("time", wintypes.DWORD), ("dwExtraInfo", ULONG_PTR)]

    class HARDWAREINPUT(ctypes.Structure):
        _fields_ = [("uMsg", wintypes.DWORD), ("wParamL", wintypes.WORD), ("wParamH", wintypes.WORD)]

    class _U(ctypes.Union):
        _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("hi", HARDWAREINPUT)]

    class INPUT(ctypes.Structure):
        _fields_ = [("type", wintypes.DWORD), ("u", _U)]

    try:  # report real pixels (4K etc.), not DPI-scaled ones
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass
    _send = ctypes.windll.user32.SendInput
    _send.argtypes = (wintypes.UINT, ctypes.POINTER(INPUT), ctypes.c_int)

KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE = 0x1, 0x2, 0x4
MOUSEEVENTF_MOVE, MOUSEEVENTF_WHEEL, MOUSEEVENTF_HWHEEL = 0x1, 0x800, 0x1000
BUTTONS = {"left": (0x2, 0x4), "right": (0x8, 0x10), "middle": (0x20, 0x40)}


def _emit(items):
    if not ENABLED or not items:
        return
    arr = (INPUT * len(items))(*items)
    _send(len(items), arr, ctypes.sizeof(INPUT))


def _key(name, up=False):
    name = name.lower()
    if name in VK:
        vk = VK[name]
    elif len(name) == 1 and name.isalnum():
        vk = ord(name.upper())
    else:
        raise ValueError(f"unknown key {name!r}")
    flags = (KEYEVENTF_KEYUP if up else 0) | (KEYEVENTF_EXTENDEDKEY if name in EXTENDED else 0)
    i = INPUT(type=1)
    i.u.ki = KEYBDINPUT(wVk=vk, wScan=0, dwFlags=flags, time=0, dwExtraInfo=0)
    return i


def press(*keys):
    """press("f") or press("shift", ".") - modifiers first, released in reverse."""
    if not ENABLED:
        return
    keys = [k for k in keys if k.lower() in ALLOWED_KEYS][:6]
    _emit([_key(k) for k in keys] + [_key(k, up=True) for k in reversed(keys)])


MAX_TEXT = 10_000
TEXT_CHUNK = 12  # characters per burst: apps drop keystrokes when hundreds arrive at once


def text_units(text):
    """What to send for a piece of text: ("key", name) for Enter/Tab, ("unit", utf16 code unit) otherwise.

    Characters outside the basic plane (emoji) become two UTF-16 units, which is what Windows expects."""
    out = []
    for ch in str(text)[:MAX_TEXT].replace("\r\n", "\n").replace("\r", "\n"):
        if ch == "\n":
            out.append(("key", "enter"))
        elif ch == "\t":
            out.append(("key", "tab"))
        else:
            raw = ch.encode("utf-16-le")
            out += [("unit", int.from_bytes(raw[i:i + 2], "little")) for i in range(0, len(raw), 2)]
    return out


def type_text(text):
    """Types the whole text, in small bursts with a short pause between them so nothing is dropped.
    Blocking (a long message takes a moment): call it from a worker thread."""
    if not ENABLED:
        return
    import time
    batch, count = [], 0

    def flush():
        nonlocal batch, count
        if batch:
            _emit(batch)
            batch, count = [], 0
            time.sleep(0.012)

    for kind, value in text_units(text):
        if kind == "key":
            flush()
            _emit([_key(value), _key(value, up=True)])
            time.sleep(0.02)
            continue
        for up in (False, True):
            i = INPUT(type=1)
            i.u.ki = KEYBDINPUT(wVk=0, wScan=value, dwFlags=KEYEVENTF_UNICODE | (KEYEVENTF_KEYUP if up else 0), time=0, dwExtraInfo=0)
            batch.append(i)
        count += 1
        if count >= TEXT_CHUNK and not (0xD800 <= value <= 0xDBFF):  # never split a surrogate pair across bursts
            flush()
    flush()


def _mouse(flags, dx=0, dy=0, data=0):
    i = INPUT(type=0)
    i.u.mi = MOUSEINPUT(dx=int(dx), dy=int(dy), mouseData=ctypes.c_ulong(int(data) & 0xFFFFFFFF).value,
                        dwFlags=flags, time=0, dwExtraInfo=0)
    return i


def screen_size():
    """Primary monitor in real pixels, e.g. (3840, 2160)."""
    if not ENABLED:
        return (1920, 1080)
    return (ctypes.windll.user32.GetSystemMetrics(0), ctypes.windll.user32.GetSystemMetrics(1))


def move(dx, dy):
    _emit([_mouse(MOUSEEVENTF_MOVE, max(-3000, min(3000, dx)), max(-3000, min(3000, dy)))])


def click(button="left", double=False):
    down, up = BUTTONS.get(button, BUTTONS["left"])
    seq = [_mouse(down), _mouse(up)]
    _emit(seq * (2 if double else 1))


def button(button="left", pressed=True):
    down, up = BUTTONS.get(button, BUTTONS["left"])
    _emit([_mouse(down if pressed else up)])


def scroll(dy=0, dx=0):
    items = []
    if dy:
        items.append(_mouse(MOUSEEVENTF_WHEEL, data=max(-1200, min(1200, int(dy)))))
    if dx:
        items.append(_mouse(MOUSEEVENTF_HWHEEL, data=max(-1200, min(1200, int(dx)))))
    _emit(items)
