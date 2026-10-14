"""Windows system tray icon: open dashboard, pause/resume, copy phone link, quit."""
import asyncio
import subprocess
import threading
import webbrowser

import pystray
from PIL import Image, ImageDraw


def make_icon(color=(34, 197, 140)):
    size = 64
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((2, 2, size - 2, size - 2), radius=14, fill=(16, 22, 20, 255))
    pts = [(10, 34), (18, 34), (24, 18), (32, 48), (38, 26), (44, 34), (54, 34)]
    d.line(pts, fill=color, width=5, joint="curve")
    return img


class Tray:
    def __init__(self, hub, loop, port):
        self.hub = hub
        self.loop = loop
        self.port = port
        self.icon = None

    def _call(self, msg):
        asyncio.run_coroutine_threadsafe(self.hub.handle_control(msg), self.loop)

    def start(self):
        hub = self.hub

        def streaming_label(_item):
            return "Pause all phones" if hub.cfg["streaming"] else "Resume streaming"

        def copy_link(_icon, _item):
            subprocess.run("clip", input=f"{hub.http_url()}/?code={hub.code}".encode("utf-16-le"), check=False)

        def quit_app(icon, _item):
            icon.stop()
            self.loop.call_soon_threadsafe(getattr(hub, "request_stop", lambda: None))

        menu = pystray.Menu(
            pystray.MenuItem("Open dashboard", lambda: webbrowser.open(f"http://localhost:{self.port}/dashboard"), default=True),
            pystray.MenuItem(lambda _i: f"Room code: {hub.code}", None, enabled=False),
            pystray.MenuItem(lambda _i: f"{sum(1 for _ in hub.clients)} phone(s) connected", None, enabled=False),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem(streaming_label, lambda: self._call({"t": "set_global", "streaming": not hub.cfg["streaming"]})),
            pystray.MenuItem("Copy phone link", copy_link),
            pystray.MenuItem("New room code", lambda: self._call({"t": "new_code"})),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Start with Windows", lambda: self._call({"t": "set_autostart", "on": not hub.autostart_on()}), checked=lambda _i: hub.autostart_on()),
            pystray.MenuItem("Quit PhoneBoxSound", quit_app),
        )
        self.icon = pystray.Icon("PhoneBoxSound", make_icon(), "PhoneBoxSound", menu)
        threading.Thread(target=self.icon.run, name="tray", daemon=True).start()

    def stop(self):
        if self.icon:
            try:
                self.icon.stop()
            except Exception:
                pass
