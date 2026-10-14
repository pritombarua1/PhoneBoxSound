"""Lock, sleep, restart and shut down the PC.

Only phones given the "Power" permission can ask, the phone asks its user to confirm first, and the
server then waits a few seconds (cancellable from the phone or the dashboard) before doing it.
"""
import ctypes
import logging
import subprocess
import sys

log = logging.getLogger("pbs.power")
ACTIONS = {"lock": "Lock", "sleep": "Sleep", "restart": "Restart", "shutdown": "Shut down"}
DELAY_S = {"lock": 0, "sleep": 5, "restart": 10, "shutdown": 10}


def run(action):
    """Do it now. Raises on failure."""
    if sys.platform != "win32":
        raise RuntimeError("Power control is only available on Windows")
    log.warning("power action: %s", action)
    if action == "lock":
        if not ctypes.windll.user32.LockWorkStation():
            raise RuntimeError("Windows refused to lock")
    elif action == "sleep":
        # (hibernate=False, force=False, disable wake events=False)
        ctypes.windll.powrprof.SetSuspendState(0, 0, 0)
    elif action in ("restart", "shutdown"):
        flag = "/r" if action == "restart" else "/s"
        subprocess.run(["shutdown", flag, "/t", "0"], check=True, creationflags=0x08000000)  # CREATE_NO_WINDOW
    else:
        raise ValueError(f"unknown power action {action!r}")
