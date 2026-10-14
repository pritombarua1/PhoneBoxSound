"""Start with Windows, on or off: one value under the current user's Run key (no administrator rights,
no service, nothing left behind when it is switched off)."""
import os
import sys

RUN = r"Software\Microsoft\Windows\CurrentVersion\Run"
NAME = "PhoneBoxSound"


def command():
    if getattr(sys, "frozen", False):
        return f'"{sys.executable}" --autostart'
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    pythonw = os.path.join(os.path.dirname(sys.executable), "pythonw.exe")
    if not os.path.exists(pythonw):
        pythonw = sys.executable
    # the Run key has no "start in" folder, so the folder is set by the command itself
    code = f"import os,sys,runpy;os.chdir(r'{root}');sys.path.insert(0,r'{root}');sys.argv=['phoneboxsound','--autostart'];runpy.run_module('phoneboxsound',run_name='__main__')"
    return f'"{pythonw}" -c "{code}"'


def enabled():
    if sys.platform != "win32":
        return False
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN) as k:
            return bool(winreg.QueryValueEx(k, NAME)[0])
    except OSError:
        return False


def refresh():
    """Keep the registered command current (a new version may start differently). Only when it is on."""
    if sys.platform != "win32":
        return
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN, 0, winreg.KEY_READ | winreg.KEY_SET_VALUE) as k:
            if winreg.QueryValueEx(k, NAME)[0] != command():
                winreg.SetValueEx(k, NAME, 0, winreg.REG_SZ, command())
    except OSError:
        pass


def set_enabled(on):
    if sys.platform != "win32":
        raise OSError("Only on Windows")
    import winreg
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN, 0, winreg.KEY_SET_VALUE) as k:
        if on:
            winreg.SetValueEx(k, NAME, 0, winreg.REG_SZ, command())
        else:
            try:
                winreg.DeleteValue(k, NAME)
            except FileNotFoundError:
                pass
    return enabled()
