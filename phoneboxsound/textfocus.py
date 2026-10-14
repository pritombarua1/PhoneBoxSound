"""Is the PC waiting for typing? Used to open the phone's keyboard by itself.

Two questions, both answered by Windows' accessibility interface (UI Automation, the same one screen
readers use), so it works across ordinary programs, browsers and editors:

  over()     is the thing under the mouse pointer a box you can type into?
  focused()  is the thing that has the keyboard focus one?

Why both: an iPhone only lets a page bring its keyboard up during a touch. So the phone has to know
*before* you tap that the pointer is on a text box (over), and opens the keyboard in that same tap;
focused() then confirms it, or closes the keyboard again if the click landed on something else.

Everything here only reads what kind of control it is. It never reads what is typed in it.
"""
import concurrent.futures
import ctypes
import logging
import sys

log = logging.getLogger("pbs.textfocus")

EDIT, COMBO, DOCUMENT = 50004, 50003, 50030           # UI Automation control types
VALUE_PATTERN = 10002
EDITOR_CLASSES = ("richedit", "edit", "scintilla", "_wwg", "textbox", "notepad", "consolewindowclass", "cascadia")


class TextFocus:
    def __init__(self):
        self.ok = sys.platform == "win32"
        self._pool = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="uia")   # UI Automation objects stay on one thread
        self._uia = self._mod = None

    def _start(self):
        import comtypes
        import comtypes.client
        try:
            comtypes.CoInitializeEx(comtypes.COINIT_MULTITHREADED)
        except OSError:
            pass        # already switched on for this thread (importing comtypes here does that)
        self._mod = comtypes.client.GetModule("UIAutomationCore.dll")
        self._uia = comtypes.client.CreateObject(self._mod.CUIAutomation, interface=self._mod.IUIAutomation)

    def _editable(self, el):
        if not el:
            return False
        kind = el.CurrentControlType
        if kind not in (EDIT, COMBO, DOCUMENT) or not el.CurrentIsEnabled:
            return False
        try:
            raw = el.GetCurrentPattern(VALUE_PATTERN)
            if raw:
                return not raw.QueryInterface(self._mod.IUIAutomationValuePattern).CurrentIsReadOnly
        except Exception:
            pass
        if kind == EDIT:
            return True
        if kind == DOCUMENT:      # a web page or a PDF is a "document" too; only known editors count without more proof
            cls = (el.CurrentClassName or "").lower()
            return any(k in cls for k in EDITOR_CLASSES)
        return False

    def _ask(self, which):
        try:
            if self._uia is None:
                self._start()
            if which == "focus":
                return self._editable(self._uia.GetFocusedElement())
            pt = ctypes.wintypes.POINT()
            ctypes.windll.user32.GetCursorPos(ctypes.byref(pt))
            return self._editable(self._uia.ElementFromPoint(self._mod.tagPOINT(pt.x, pt.y)))
        except Exception as e:
            log.debug("text focus check failed: %s", e)
            return False

    def _run(self, which):
        if not self.ok:
            return False
        try:
            return bool(self._pool.submit(self._ask, which).result(timeout=1.5))
        except Exception:
            return False

    def over(self):
        return self._run("over")

    def focused(self):
        return self._run("focus")


import ctypes.wintypes  # noqa: E402  (needed by _ask; kept at the bottom so the module imports on any system)
