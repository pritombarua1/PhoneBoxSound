"""HTTP/HTTPS server, WebSockets, REST API and startup."""
import argparse
import asyncio
import collections
import hashlib
import io
import ipaddress
import json
import logging
import os
import platform
import secrets
import socket
import sys
import time
import webbrowser
from logging.handlers import RotatingFileHandler
from urllib.parse import urlparse

import segno
from aiohttp import WSMsgType, web

from . import __version__
from .audio import Capture, now_ms
from .config import Config
from .discovery import Discovery
from .hub import Hub, clean_name as hub_clean
from .media import MediaEngine

# Running from source, everything lives in the project folder. Packaged as PhoneBoxSound.exe, the web
# app is bundled inside the exe and settings/logs are kept next to it.
FROZEN = getattr(sys, "frozen", False)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOME = os.path.dirname(os.path.abspath(sys.executable)) if FROZEN else ROOT
DIST = os.path.join(getattr(sys, "_MEIPASS", ROOT) if FROZEN else ROOT, "web", "dist")  # the built React app
DATA = os.path.join(HOME, "data")
log = logging.getLogger("pbs")

RECENT_LOGS = collections.deque(maxlen=300)


class _RingHandler(logging.Handler):
    def emit(self, record):
        RECENT_LOGS.append(self.format(record))


def setup_logging(verbose):
    os.makedirs(DATA, exist_ok=True)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
    root = logging.getLogger()
    root.setLevel(logging.DEBUG if verbose else logging.INFO)
    fh = RotatingFileHandler(os.path.join(DATA, "phoneboxsound.log"), maxBytes=1_000_000, backupCount=2, encoding="utf-8")
    ring = _RingHandler()
    for h in (fh, ring):
        h.setFormatter(fmt)
        root.addHandler(h)
    logging.getLogger("aiohttp.access").setLevel(logging.WARNING)


def local_ips():
    ips = []
    try:  # the interface that routes outward is almost always the Wi-Fi/LAN one
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            ips.append(s.getsockname()[0])
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.append(info[4][0])
    except OSError:
        pass
    out = []
    for ip in ips:
        a = ipaddress.ip_address(ip)
        if not (a.is_loopback or a.is_link_local) and ip not in out:
            out.append(ip)
    return out or ["127.0.0.1"]


def client_ip(request):
    """The real client address. Only a proxy on this PC (the Vite dev server) is trusted to forward one."""
    remote = request.remote or ""
    try:
        if ipaddress.ip_address(remote).is_loopback:
            fwd = request.headers.get("X-Forwarded-For", "").split(",")[0].strip()
            if fwd:
                ipaddress.ip_address(fwd)
                return fwd
    except ValueError:
        pass
    return remote


def is_loopback(request):
    try:
        return ipaddress.ip_address(client_ip(request)).is_loopback
    except (TypeError, ValueError):
        return False


class DualListener:
    """Serves http:// and https:// on the same port.

    People type https://…:8080 as often as http://…:8080; answering only one of them gives a cryptic
    browser error. A TLS connection always starts with the byte 0x16, so we look at the first byte of
    each new connection and hand it to the web server with or without TLS accordingly."""

    def __init__(self, loop, protocol_factory, port, ssl_context):
        import concurrent.futures
        self.loop, self.factory, self.ssl = loop, protocol_factory, ssl_context
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        if sys.platform != "win32":
            self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(("0.0.0.0", port))
        self.sock.listen(128)
        self.pool = concurrent.futures.ThreadPoolExecutor(max_workers=16, thread_name_prefix="accept")
        self.closed = False

    def start(self):
        import threading
        threading.Thread(target=self._accept_loop, name="listener", daemon=True).start()

    def _accept_loop(self):
        while not self.closed:
            try:
                conn, _addr = self.sock.accept()
            except OSError:
                break
            self.pool.submit(self._sort, conn)

    def _sort(self, conn):
        try:
            conn.settimeout(8)
            first = conn.recv(1, socket.MSG_PEEK)  # look, don't consume
            if not first:
                conn.close()
                return
            conn.setblocking(False)
            use_tls = first == b"\x16" and self.ssl is not None
            fut = asyncio.run_coroutine_threadsafe(
                self.loop.connect_accepted_socket(self.factory, conn, ssl=self.ssl if use_tls else None), self.loop)
            fut.add_done_callback(lambda f: f.exception())  # failed handshakes (scanners, old clients) are not errors
        except Exception:
            try:
                conn.close()
            except OSError:
                pass

    def close(self):
        self.closed = True
        try:
            self.sock.close()
        except OSError:
            pass
        self.pool.shutdown(wait=False, cancel_futures=True)


NOT_BUILT = """<!doctype html><meta charset=utf-8><title>PhoneBoxSound</title>
<body style="font:16px system-ui;background:#0c1210;color:#e8ecf4;display:grid;place-items:center;height:100vh;margin:0">
<div style="max-width:520px;padding:24px"><h2>The web app isn't built yet</h2>
<p>Run this once in the project folder, then reload:</p>
<pre style="background:#131a17;padding:14px;border-radius:10px">npm install
npm run build</pre>
<p style="opacity:.7">Developing? <code>npm run dev</code> starts the server and a live-reloading UI on port 5173.</p></div>"""


CONTROL_PAGES = ("dashboard", "nowplaying", "devices", "remote", "intercom", "presets", "activity", "settings")

# What a page from this server may do in a browser. Scripts, styles and connections only from this
# server itself: injected <script> tags, inline handlers, foreign frames, forms posting elsewhere and
# plugins are all refused by the browser before they run.
CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
       "media-src 'self' blob:; worker-src 'self'; connect-src 'self' ws://{host} wss://{host}; manifest-src 'self'; "
       "frame-ancestors 'self'; base-uri 'none'; form-action 'self'; object-src 'none'")
SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",            # a file is only ever what the server says it is
    "X-Frame-Options": "SAMEORIGIN",                # never inside another site's frame (clickjacking)
    "Referrer-Policy": "no-referrer",               # the room code in a link is not passed on to other sites
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",  # other sites can't embed or read our files
    "Permissions-Policy": "camera=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()",
}


def public_assets():
    """Files of the build the *phone* app needs. Everything else in /assets belongs to the dashboard
    and is only served to the dashboard, so a phone can't even download that code."""
    try:
        with open(os.path.join(DIST, ".vite", "manifest.json"), encoding="utf-8") as f:
            manifest = json.load(f)
    except (OSError, ValueError):
        return None
    seen, files, todo = set(), set(), ["index.html"]
    while todo:
        key = todo.pop()
        entry = manifest.get(key)
        if key in seen or not entry:
            continue
        seen.add(key)
        files.update([entry.get("file", ""), *entry.get("css", []), *entry.get("assets", [])])
        todo += entry.get("imports", []) + entry.get("dynamicImports", [])
    return {os.path.basename(f) for f in files if f}


@web.middleware
async def cache_headers(request, handler):
    """Hashed build assets never change, so phones may cache them forever; everything else is always
    revalidated. (Without this, phone browsers kept running an old copy of the app after updates.)"""
    try:
        resp = await handler(request)
    except web.HTTPException as e:
        resp = e
    if request.path.startswith("/assets/"):
        resp.headers.setdefault("Cache-Control", "public, max-age=31536000, immutable")
    elif "Cache-Control" not in resp.headers:
        resp.headers["Cache-Control"] = "no-cache"
    for k, v in SECURITY_HEADERS.items():
        resp.headers.setdefault(k, v)
    resp.headers["Content-Security-Policy"] = CSP.format(host=request.host)
    if isinstance(resp, web.HTTPException):
        raise resp
    return resp


def same_origin(request):
    """Blocks other websites open on this PC from driving the dashboard/API (CSRF / cross-site WebSocket)."""
    origin = request.headers.get("Origin")
    if not origin:
        return True
    host = urlparse(origin).hostname or ""
    return host in ("localhost", "127.0.0.1", "::1") or host == (request.host.split(":")[0])


def build_app(hub, args):
    routes = web.RouteTableDef()
    cfg = hub.cfg

    def has_token(request):
        tok = request.headers.get("Authorization", "").removeprefix("Bearer ").strip() or request.query.get("token", "")
        return bool(tok) and secrets.compare_digest(tok.encode(), str(cfg["api_token"]).encode())

    def known_host(request):
        """The address in the browser's bar must be one of ours. Stops a website from pointing its own
        name at this PC (DNS rebinding) to borrow the trust given to requests from the PC itself."""
        from .tls import public_host
        host = (request.host or "").rsplit(":", 1)[0].strip("[]").lower()
        return host in {"localhost", "127.0.0.1", "::1", "phoneboxsound.local", *hub.ips, *(public_host(ip) for ip in hub.ips)}

    def local_ok(request):
        """From this PC's own browser, on one of our own addresses, and not through another website."""
        return (is_loopback(request) or args.allow_remote_control) and same_origin(request) and known_host(request)

    vault = cfg.vault
    sessions = {}                    # cookie value -> expiry; in memory only, so a restart signs everyone out
    login_fails = []
    SESSION_S = 12 * 3600

    def session_ok(request):
        tok = request.cookies.get("pbs_session", "")
        if sessions.get(tok, 0) < time.time():
            sessions.pop(tok, None)
            return False
        sessions[tok] = time.time() + SESSION_S
        return True

    def setup_needed():
        return vault is not None and not vault.exists and not args.demo     # a real install must set a password first

    def control_ok(request):
        if has_token(request):
            return is_loopback(request) or not cfg["lockdown"]     # lockdown: the API only from this PC
        if not local_ok(request):
            return False
        if cfg.protected:
            return session_ok(request)                             # sitting at the PC is not enough: the password
        return not setup_needed()

    def login_wait():
        now = time.time()
        login_fails[:] = [t for t in login_fails if now - t < 900]
        return max(0.0, min(300, 2 ** (len(login_fails) - 4)) - (now - login_fails[-1])) if len(login_fails) >= 5 else 0.0

    def sign_in(request, resp):
        tok = secrets.token_urlsafe(32)
        sessions[tok] = time.time() + SESSION_S
        resp.set_cookie("pbs_session", tok, httponly=True, samesite="Strict", secure=request.secure, path="/")
        return resp

    async def close_dashboards():
        for ws in list(hub.controls):
            try:
                await ws.close()
            except Exception:
                pass

    def auth_state(request):
        from .vault import MIN_PASSWORD
        return {"required": cfg.protected, "setup": setup_needed(), "authed": cfg.protected and session_ok(request),
                "autostart": bool(vault and vault.autostart), "wait": round(login_wait(), 1), "min": MIN_PASSWORD}

    def auth_route(handler):
        async def wrapped(request):
            from .vault import VaultError
            if not local_ok(request):
                return web.json_response({"error": "Only on the PC running PhoneBoxSound"}, status=403)
            try:
                b = await request.json() if request.can_read_body else {}
                return await handler(request, b if isinstance(b, dict) else {})
            except VaultError as e:
                return web.json_response({"error": str(e)}, status=400)
            except ValueError:
                return web.json_response({"error": "bad request"}, status=400)
        return wrapped

    @routes.get("/api/auth")
    async def auth_get(request):
        if not local_ok(request):
            return web.json_response({"error": "Only on the PC running PhoneBoxSound"}, status=403)
        return web.json_response(auth_state(request), headers={"Cache-Control": "no-store"})

    @routes.post("/api/auth/setup")
    @auth_route
    async def auth_setup(request, b):
        if cfg.protected or vault is None or vault.exists:
            return web.json_response({"error": "A password is already set"}, status=409)
        await asyncio.to_thread(cfg.protect, str(b.get("password", "")), bool(b.get("autostart", True)))
        hub.event("security", "A dashboard password was set; storage is now encrypted")
        await close_dashboards()
        return sign_in(request, web.json_response({"ok": True}))

    @routes.post("/api/auth/login")
    @auth_route
    async def auth_login(request, b):
        if not cfg.protected:
            return web.json_response({"ok": True})
        if login_wait() > 0:
            return web.json_response({"error": "Too many wrong tries. Wait a little."}, status=429)
        if not await asyncio.to_thread(vault.check_password, str(b.get("password", ""))):
            login_fails.append(time.time())
            hub.event("security", f"Wrong dashboard password ({len(login_fails)} recent)")
            return web.json_response({"error": "Wrong password"}, status=401)
        login_fails.clear()
        return sign_in(request, web.json_response({"ok": True}))

    @routes.post("/api/auth/logout")
    @auth_route
    async def auth_logout(request, b):
        sessions.pop(request.cookies.get("pbs_session", ""), None)
        await close_dashboards()
        resp = web.json_response({"ok": True})
        resp.del_cookie("pbs_session", path="/")
        return resp

    @routes.post("/api/auth/password")
    @auth_route
    async def auth_password(request, b):
        if not cfg.protected or not session_ok(request):
            return web.json_response({"error": "Sign in first"}, status=401)
        if login_wait() > 0:
            return web.json_response({"error": "Too many wrong tries. Wait a little."}, status=429)
        from .vault import WrongPassword
        try:
            await asyncio.to_thread(vault.change_password, str(b.get("current", "")), str(b.get("password", "")), cfg.data)
        except WrongPassword:
            login_fails.append(time.time())
            raise
        mine = request.cookies.get("pbs_session", "")
        for tok in [t for t in sessions if t != mine]:
            del sessions[tok]
        hub.event("security", "The dashboard password was changed")
        return web.json_response({"ok": True})

    @routes.post("/api/auth/autostart")
    @auth_route
    async def auth_autostart(request, b):
        if not cfg.protected or not session_ok(request):
            return web.json_response({"error": "Sign in first"}, status=401)
        from .vault import WrongPassword
        try:
            on = await asyncio.to_thread(vault.set_autostart, str(b.get("current", "")), bool(b.get("on")), cfg.data)
        except WrongPassword:
            login_fails.append(time.time())
            raise
        hub.event("security", "Start-up: Windows opens the storage for this account" if on else "Start-up: the server now waits for the password")
        return web.json_response({"ok": True, "autostart": on})

    def page(name):
        path = os.path.join(DIST, name)
        if not os.path.exists(path):
            return web.Response(text=NOT_BUILT, content_type="text/html")
        return web.FileResponse(path, headers={"Cache-Control": "no-cache"})

    @routes.get("/")
    async def index(request):
        if is_loopback(request) and "player" not in request.query and "handoff" not in request.query:
            raise web.HTTPFound("/dashboard")
        return page("index.html")

    @routes.get("/player")
    async def player(request):
        return page("index.html")

    @routes.get("/control")
    async def control_old(request):
        raise web.HTTPFound("/dashboard")

    @routes.get("/{page:(?:%s)}" % "|".join(CONTROL_PAGES))
    async def control(request):
        if not local_ok(request) and not control_ok(request):
            raise web.HTTPForbidden(text="The PhoneBoxSound dashboard is only available on the PC running it.")
        return page("control.html")

    built = {"at": None, "files": None}

    def phone_files_now():
        """The phone app's files, re-read whenever the web app is rebuilt (its file names change with
        every build; a list read only at start-up would refuse phones the new files)."""
        try:
            at = os.path.getmtime(os.path.join(DIST, ".vite", "manifest.json"))
        except OSError:
            at = 0
        if at != built["at"]:
            built["at"], built["files"] = at, public_assets()
            if built["files"] is None:
                log.warning("build manifest missing: run `npm run build` (dashboard files are not separated from phone files)")
        return built["files"]

    @routes.get("/assets/{name}")
    async def asset(request):
        name = os.path.basename(request.match_info["name"])
        path = os.path.join(DIST, "assets", name)
        if not name or not os.path.isfile(path):
            raise web.HTTPNotFound()
        phone_files = phone_files_now()
        if phone_files is not None and name not in phone_files and not local_ok(request) and not control_ok(request):
            raise web.HTTPNotFound()      # dashboard code: not for phones
        return web.FileResponse(path)

    @routes.get(r"/{name:(?:manifest\.webmanifest|sw\.js|icon\.svg|icon-\d+\.png)}")
    async def root_file(request):
        name, theme = request.match_info["name"], request.query.get("theme")
        if theme and name != "sw.js":
            # the mark in the colours of the theme this device uses: tab icon, home-screen icon, install info
            from . import branding
            theme, day = branding.valid(theme), {"Cache-Control": "public, max-age=86400"}
            if name == "icon.svg":
                return web.Response(text=branding.icon_svg(theme), content_type="image/svg+xml", headers=day)
            if name.endswith(".png"):
                size = min(1024, max(16, int(name[5:-4])))
                png = await asyncio.to_thread(branding.icon_png, theme, size, size == 180 or "square" in request.query)
                return web.Response(body=png, content_type="image/png", headers=day)
            return web.json_response(branding.manifest(theme), content_type="application/manifest+json")
        path = os.path.join(DIST, name)
        if not os.path.exists(path):
            raise web.HTTPNotFound()
        headers = {"Cache-Control": "no-cache"}
        if path.endswith(".webmanifest"):
            headers["Content-Type"] = "application/manifest+json"
        if path.endswith("sw.js"):
            headers["Service-Worker-Allowed"] = "/"
        return web.FileResponse(path, headers=headers)

    @routes.get("/qr.svg")
    async def qr(request):
        if not control_ok(request):
            raise web.HTTPForbidden()
        target = request.query.get("url", "")
        allowed = {hub.http_url(ip) for ip in hub.ips} | ({hub.https_url()} if hub.https_url() else set()) | {
            f"http://phoneboxsound.local:{hub.ports['http']}"}
        if target not in allowed:
            target = hub.http_url()
        from .branding import qr_svg, valid
        svg = qr_svg(f"{target}/?code={hub.code}", valid(request.query.get("theme") or cfg["theme"]))
        return web.Response(text=svg, content_type="image/svg+xml", headers={"Cache-Control": "no-store"})

    @routes.get("/thumb/{key}")
    async def thumb(request):
        """A search result's picture, fetched by this PC so that phones talk to nobody else."""
        ip = client_ip(request)
        if not control_ok(request) and not any(c.ip == ip and (c.perms.get("search") or c.perms.get("remote")) for c in hub.clients.values()):
            raise web.HTTPNotFound()
        try:
            found = await hub.search.thumb(request.match_info["key"])
        except Exception:
            found = None
        if not found:
            raise web.HTTPNotFound()
        return web.Response(body=found[0], content_type=found[1], headers={"Cache-Control": "private, max-age=86400"})

    @routes.get("/art/{hash}")
    async def art(request):
        ip = client_ip(request)
        if not control_ok(request) and not any(c.ip == ip for c in hub.clients.values()):
            raise web.HTTPNotFound()      # artwork of what's playing: only for the dashboard and joined phones
        found = hub.media.art(request.match_info["hash"])
        if not found:
            raise web.HTTPNotFound()
        data, ctype = found
        return web.Response(body=data, content_type=ctype.split(";")[0] or "image/png",
                            headers={"Cache-Control": "private, max-age=86400"})

    # ---------------------------------------------------------- sockets --

    @routes.get("/ws/player")
    async def ws_player(request):
        if not same_origin(request):
            raise web.HTTPForbidden()     # another website trying to talk to the PC through a phone's browser
        ws = web.WebSocketResponse(heartbeat=10, max_msg_size=16 * 1024 * 1024)  # room for a clipboard image
        await ws.prepare(request)
        client = None
        wait = None       # set while this phone sits in the waiting room
        window, count, strangers = time.time(), 0, 0
        challenge = None  # (hello message, nonce) while we wait for the phone's signature
        secure = request.secure
        try:
            async for msg in ws:
                # Flood guard. The app sends ~100 audio blocks and ~60 pointer moves a second at most.
                count += 1
                if time.time() - window > 1:
                    window, count = time.time(), 1
                if client is None and wait and wait[1]["client"]:
                    client = wait[1]["client"]      # approved while waiting
                strangers += client is None and wait is None
                if count > 600 or strangers > 300:
                    if client:
                        hub.event("security", f"{client.dev['name']} was disconnected for flooding the server")
                    break
                if msg.type == WSMsgType.BINARY:
                    if client and hub.journal:
                        hub.journal.count(client.device_id, "host_in" if msg.data[:1] == b"\x03" else "intercom_in", len(msg.data))
                    if client and msg.data[:1] == b"\x03":
                        hub.on_host_audio(client, msg.data)     # this phone is hosting the music
                    elif client and client.perms["intercom"]:
                        hub.on_intercom_audio(("dev", client.device_id), msg.data)
                    continue
                if msg.type != WSMsgType.TEXT:
                    continue
                try:
                    m = json.loads(msg.data)
                except ValueError:
                    continue
                if not isinstance(m, dict):
                    continue
                t = m.get("t")
                if client and hub.journal and t == "ping":
                    hub.journal.count(client.device_id, "ping_in")
                if t == "ping":
                    pong = {"t": "pong", "c": m.get("c"), "s": now_ms()}
                    if client:
                        client.last_msg = time.time()
                        client.send_json(pong, urgent=True)
                    else:
                        await ws.send_json(pong)
                elif t == "hello" and client is None and challenge is None:
                    known = cfg["devices"].get(str(m.get("device_id") or ""))
                    if known and known.get("pubkey") and not known.get("blocked") and not hub.has_pass(m):
                        # This phone registered a key: only a signature made with it gets in. A copied
                        # token is worthless here.
                        if not m.get("can_sign"):
                            await ws.send_json({"t": "error", "need_code": False, "msg": "This phone's security key isn't available on this page. Open the same link you paired with, or forget the phone on the PC and pair again."})
                            break
                        challenge = (m, secrets.token_urlsafe(32))
                        await ws.send_json({"t": "challenge", "nonce": challenge[1]})
                        continue
                    client, err = await hub.join(ws, m, client_ip(request), secure)
                    if err == "waiting":
                        wait = next(((k, w) for k, w in hub.waiting.items() if w["ws"] is ws), None)
                        continue
                    if err:
                        if err == "blocked":
                            await asyncio.sleep(1)
                            err = "This phone has been blocked by the PC"
                        await ws.send_json({"t": "error", "msg": err, "need_code": err in ("pair", "Wrong code")})
                        if err != "pair":
                            await asyncio.sleep(0.3)
                        break
                elif t == "proof" and challenge and client is None:
                    hello, nonce = challenge
                    challenge = None
                    from . import identity
                    known = cfg["devices"].get(str(hello.get("device_id") or ""), {})
                    if not known.get("pubkey") or not identity.verify(known["pubkey"], nonce, str(m.get("sig", ""))):
                        log.warning("failed key check for device %s from %s", hello.get("device_id"), client_ip(request))
                        hub.event("security", f"Refused a phone that failed its security check ({client_ip(request)})")
                        hub.note(str(hello.get("device_id"))[:64], "refused", {"what": "signing in as this phone without its key", "ip": client_ip(request)})
                        await asyncio.sleep(1)
                        await ws.send_json({"t": "error", "need_code": False, "msg": "Security check failed"})
                        break
                    client, err = await hub.join(ws, hello, client_ip(request), secure, proven=True)
                    if err == "waiting":
                        wait = next(((k, w) for k, w in hub.waiting.items() if w["ws"] is ws), None)
                        continue
                    if err:
                        await ws.send_json({"t": "error", "msg": "This phone has been blocked by the PC" if err == "blocked" else err, "need_code": False})
                        break
                elif client:
                    # Every message the phone sends carries its own running number: a jump means one was lost.
                    t0, n = time.time(), m.get("n") if isinstance(m.get("n"), int) else None
                    if n is not None:
                        if client.rx_n is not None and n != client.rx_n + 1:
                            hub.note(client.device_id, "mismatch", {"missed": n - client.rx_n - 1, "what": "messages from the phone did not reach the PC"})
                        client.rx_n = n
                    client.outcome = None
                    await hub.handle_phone(client, m)
                    hub.record(client, t, m, t0, n)      # …and what the PC did with it
        finally:
            client = client or (wait and wait[1]["client"])
            if client:
                await hub.leave(client)
            elif wait:
                await hub.stop_waiting(ws)
        return ws

    @routes.get("/ws/screen")
    async def ws_screen(request):
        """Screen pictures for one phone, on a connection of their own so they can never hold up the sound.
        Opened with a key the phone was given over its main connection; the phone confirms each picture."""
        if not same_origin(request):
            raise web.HTTPForbidden()
        key = request.query.get("k", "")
        c = next((x for x in hub.clients.values() if key and secrets.compare_digest(x.screen_key, key) and x.perms.get("screen")), None)
        if not c:
            raise web.HTTPForbidden()
        ws = web.WebSocketResponse(heartbeat=15, max_msg_size=4096)
        await ws.prepare(request)
        old, c.screen_ws = c.screen_ws, ws
        if old is not None:
            asyncio.ensure_future(old.close())
        try:
            async for msg in ws:
                if msg.type == WSMsgType.TEXT:
                    if msg.data == "key":
                        c.screen_need_key = True    # the phone's video decoder lost track
                    elif msg.data == "novideo":
                        c.screen_video = False      # this phone cannot play the stream: pictures from now on
                    else:
                        c.screen_acks += 1
                        c.screen_ack.set()          # "shown": the next picture may be made
        finally:
            if c.screen_ws is ws:
                c.screen_ws = None
            c.screen_ack.set()
        return ws

    @routes.get("/ws/browser")
    async def ws_browser(request):
        """The browser extension on this PC.

        Who may connect: only this PC itself (loopback), and only a browser extension or a local program:
        an ordinary web page can also open sockets to 127.0.0.1, and is refused by its Origin. The
        extension carries no password. It introduces itself with its own id and secret; the first time, it
        waits until it is approved on the dashboard; afterwards the secret must match what was approved."""
        origin = request.headers.get("Origin", "")
        if not is_loopback(request) or (origin and not origin.startswith(("chrome-extension://", "moz-extension://", "safari-web-extension://"))):
            raise web.HTTPForbidden()
        ws = web.WebSocketResponse(heartbeat=20, max_msg_size=512 * 1024)
        await ws.prepare(request)
        browsers, ext_id, attached = cfg["browsers"], None, False
        try:
            if has_token(request):                      # a script of your own, using the API token
                hub.media.browser.attach(ws, request.query.get("name", "Browser"))
                attached = True
            async for msg in ws:
                if msg.type != WSMsgType.TEXT:
                    continue
                try:
                    m = json.loads(msg.data)
                except ValueError:
                    continue
                if not isinstance(m, dict):
                    continue
                if attached:
                    if m.get("t") == "tabs":
                        hub.media.browser.update(ws, m.get("tabs"))
                    continue
                if m.get("t") != "hello" or ext_id:
                    continue
                ext_id, secret = str(m.get("id") or "")[:40], str(m.get("secret") or "")
                name = hub_clean(m.get("name")) or "Browser"
                if not (8 <= len(ext_id) <= 40 and ext_id.isalnum() and len(secret) >= 32):
                    break
                digest = hashlib.sha256(secret.encode()).hexdigest()
                known = browsers.get(ext_id)
                if known and not secrets.compare_digest(known["hash"], digest):
                    await ws.send_json({"t": "denied"})         # someone else's id
                    break
                if not known:
                    if sum(1 for b in browsers.values() if not b.get("approved")) >= 6:
                        break
                    browsers[ext_id] = known = {"name": name[:20], "hash": digest, "approved": False, "added": time.time()}
                    cfg.save()
                    hub.event("browser", f"A {name} extension on this PC asks to connect: approve it in Settings")
                    await hub.broadcast_state()
                if not known.get("approved"):
                    await ws.send_json({"t": "waiting"})
                    while ext_id in browsers and not browsers[ext_id].get("approved") and not ws.closed:
                        await asyncio.sleep(0.5)
                    if ext_id not in browsers or ws.closed:
                        if not ws.closed:
                            await ws.send_json({"t": "denied"})
                        break
                await ws.send_json({"t": "ok"})
                hub.media.browser.attach(ws, known["name"], ext_id)
                attached = True
                await hub.broadcast_state()
        finally:
            hub.media.browser.detach(ws)
        return ws

    @routes.get("/extension.zip")
    async def extension_zip(request):
        """The browser extension, packed for the browser asking (Chrome-style or Firefox)."""
        if not control_ok(request):
            raise web.HTTPForbidden()
        from . import extpack
        kind = request.query.get("for") or ("firefox" if "Firefox/" in request.headers.get("User-Agent", "") else "chrome")
        kind = kind if kind in extpack.BROWSERS else "chrome"
        folder = os.path.join(getattr(sys, "_MEIPASS", ROOT) if FROZEN else ROOT, "extension")
        data = await asyncio.to_thread(extpack.zipped, folder, kind, hub.ports["http"], cfg["theme"])
        return web.Response(body=data, content_type="application/zip",
                            headers={"Content-Disposition": f'attachment; filename="PhoneBoxSound-extension-{kind}.zip"', "Cache-Control": "no-store"})

    @routes.get("/ws/control")
    async def ws_control(request):
        if not control_ok(request):
            raise web.HTTPForbidden()
        ws = web.WebSocketResponse(heartbeat=10, max_msg_size=256 * 1024)
        await ws.prepare(request)
        hub.controls.add(ws)
        await ws.send_str(json.dumps(hub.state()))
        try:
            async for msg in ws:
                if msg.type == WSMsgType.BINARY:
                    hub.on_intercom_audio(("pc", id(ws)), msg.data)
                    continue
                if msg.type != WSMsgType.TEXT:
                    continue
                try:
                    m = json.loads(msg.data)
                    if m.get("t") == "ping":
                        await ws.send_json({"t": "pong", "c": m.get("c"), "s": now_ms()})
                        continue
                    reply = await hub.handle_control(m, ws)
                    if reply:
                        await ws.send_json(reply)
                except (ValueError, TypeError, KeyError) as e:
                    log.debug("bad control message: %s", e)
        finally:
            hub.controls.discard(ws)
            for key in [k for k in hub.talkers if k == ("pc", id(ws))]:
                await hub.set_talking(key, "PC", None)
        return ws

    # -------------------------------------------------------------- API --

    def api(handler):
        async def wrapped(request):
            if not control_ok(request):
                return web.json_response({"error": "unauthorized"}, status=401)
            try:
                return await handler(request)
            except (ValueError, TypeError, KeyError) as e:
                return web.json_response({"error": str(e)}, status=400)
        return wrapped

    async def body(request):
        if not request.can_read_body:
            return {}
        try:
            return await request.json()
        except ValueError:
            return {}

    @routes.get("/api/status")
    @api
    async def api_status(request):
        s = hub.state()
        return web.json_response({"version": __version__, "streaming": s["cfg"]["streaming"],
                                  "latency_ms": s["cfg"]["latency_ms"], "capture": s["capture"],
                                  "devices_online": sum(d["online"] for d in s["devices"]), "code": hub.code,
                                  "urls": [hub.http_url(ip) for ip in hub.ips], "video": s.get("video")})

    @routes.get("/api/devices")
    @api
    async def api_devices(request):
        return web.json_response(hub.device_rows())

    @routes.post("/api/devices/{device_id}")
    @api
    async def api_device(request):
        await hub.handle_control({"t": "set_device", "device_id": request.match_info["device_id"], "patch": await body(request)})
        return web.json_response({"ok": True})

    @routes.get("/api/media")
    @api
    async def api_media(request):
        return web.json_response(hub.media.public())

    @routes.post("/api/media/{action}")
    @api
    async def api_media_action(request):
        b = await body(request)
        msg = await hub.media_command(request.match_info["action"], b.get("value"), b.get("session"))
        return web.json_response({"ok": True, "message": msg})

    @routes.post("/api/stream")
    @api
    async def api_stream(request):
        b = await body(request)
        await hub.handle_control({"t": "set_global", **{k: b[k] for k in ("streaming", "master", "latency_ms", "auto_latency") if k in b}})
        return web.json_response({"ok": True})

    @routes.post("/api/scenes/{scene_id}")
    @api
    async def api_scene(request):
        await hub.handle_control({"t": "scene_apply", "id": request.match_info["scene_id"]})
        return web.json_response({"ok": True})

    @routes.get("/api/scenes")
    @api
    async def api_scenes(request):
        return web.json_response([{"id": s["id"], "name": s["name"]} for s in cfg["scenes"]])

    @routes.post("/api/keys")
    @api
    async def api_keys(request):
        keys = (await body(request)).get("keys") or []
        hub.do_input({"kind": "key", "keys": keys})
        return web.json_response({"ok": True, "keys": keys})

    @routes.post("/api/text")
    @api
    async def api_text(request):
        hub.do_input({"kind": "text", "text": str((await body(request)).get("text", ""))})
        return web.json_response({"ok": True})

    @routes.get("/api/clipboard")
    @api
    async def api_clip_get(request):
        clip = await asyncio.to_thread(hub.desktop.get_clipboard)
        clip.pop("image", None)  # text and metadata only; pictures are for the phone UI
        return web.json_response(clip)

    @routes.post("/api/clipboard")
    @api
    async def api_clip_set(request):
        await asyncio.to_thread(hub.desktop.set_clipboard_text, str((await body(request)).get("text", "")))
        return web.json_response({"ok": True})

    class _ApiCaller:  # stands in for "the phone that asked" when the API triggers something
        dev = {"name": "API"}

        @staticmethod
        def send_json(*_a, **_k):
            pass

    @routes.post("/api/power/{action}")
    @api
    async def api_power(request):
        action = request.match_info["action"]
        if action == "cancel":
            return web.json_response({"ok": True, "cancelled": hub.power_cancel()})
        await hub.power_request(_ApiCaller, action)
        return web.json_response({"ok": True, "pending": bool(hub.power_pending)})

    @routes.post("/api/commands/{command_id}")
    @api
    async def api_command(request):
        hub.run_command(_ApiCaller, request.match_info["command_id"])
        return web.json_response({"ok": True})

    @routes.post("/api/devices/{device_id}/approve")
    @api
    async def api_approve(request):
        await hub.handle_control({"t": "approve", "device_id": request.match_info["device_id"], "ok": (await body(request)).get("ok", True)})
        return web.json_response({"ok": True})

    @routes.get("/api/search")
    @api
    async def api_search(request):
        return web.json_response(await hub.search.query(request.query.get("q", ""), request.query.get("service", "all")))

    @routes.post("/api/search/open")
    @api
    async def api_search_open(request):
        err = await hub.open_on_pc(hub.search.target((await body(request)).get("id")), by="the API")
        return web.json_response({"ok": not err, "error": err}, status=400 if err else 200)

    @routes.get("/api/spotify/login")
    async def spotify_login(request):
        """Off to Spotify's own sign-in page (from the dashboard only)."""
        if not control_ok(request):
            raise web.HTTPForbidden()
        url = hub.spotify.begin(hub.ports["http"])
        if not url:
            raise web.HTTPBadRequest(text="Save your Spotify app's Client ID in Settings → Search first.")
        raise web.HTTPFound(url)

    @routes.get("/api/spotify/callback")
    async def spotify_callback(request):
        """Spotify sends the browser back here. It arrives as 127.0.0.1 (the address Spotify requires), where
        the dashboard's sign-in does not apply, so it is recognised by the one-time code we gave Spotify."""
        if not is_loopback(request):
            raise web.HTTPForbidden()
        q = request.query
        err = q.get("error") and "Spotify sign-in was cancelled." or await hub.spotify.finish(q.get("state"), q.get("code"))
        if not err:
            hub.event("settings", f"Spotify account connected: {hub.spotify.store().get('name') or 'ok'}")
            await hub.broadcast_state()
        note = "Spotify is connected. You can close this tab." if not err else err
        page = (f'<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="3;url=http://localhost:{hub.ports["http"]}/settings"><title>PhoneBoxSound</title>'
                f'<body style="font:16px system-ui;background:#0c1210;color:#e8ecf4;display:grid;place-items:center;height:100vh;margin:0"><p>{note}</p>')
        return web.Response(text=page, content_type="text/html", status=200 if not err else 400)

    @routes.get("/api/playlists")
    @api
    async def api_playlists(request):
        return web.json_response(await hub.spotify.playlists())

    @routes.get("/api/queue")
    @api
    async def api_queue(request):
        return web.json_response(await hub.spotify.snapshot())

    @routes.post("/api/queue/{action}")
    @api
    async def api_queue_do(request):
        got = await hub.queue_do(request.match_info["action"], (await body(request)).get("value"))
        return web.json_response(got, status=400 if got["error"] else 200)

    @routes.get("/api/share")
    @api
    async def api_share(request):
        info = await hub.share_info()
        return web.json_response({**{k: v for k, v in info.items() if k != "t"}, "links": [{k: v for k, v in l.items() if k != "svg"} for l in info["links"]]})

    @routes.post("/api/announce")
    @api
    async def api_announce(request):
        """For doorbells, timers and home automation: a chime and/or spoken text on the phones."""
        b = await body(request)
        if not (b.get("text") or b.get("sound")):
            raise ValueError('give "text" and/or "sound" (doorbell, ding, alert)')
        asyncio.ensure_future(hub.extras.announce(b.get("text"), str(b.get("sound") or ("ding" if b.get("text") else "")), str(b.get("target") or "all"), by="the API"))
        return web.json_response({"ok": True})

    @routes.post("/api/bedtime")
    @api
    async def api_bedtime(request):
        b = await body(request)
        if b.get("cancel"):
            await hub.extras.bedtime_cancel()
            return web.json_response({"ok": True})
        err = await hub.extras.bedtime_start(b.get("minutes", 30), str(b.get("after") or "pause"), by="the API")
        return web.json_response({"ok": not err, "error": err, "bedtime": hub.extras.bedtime_state()}, status=400 if err else 200)

    @routes.get("/api/security")
    @api
    async def api_security(request):
        return web.json_response(hub.extras.digest(max(1, min(int(request.query.get("days", 7)), 30))), headers={"Cache-Control": "no-store"})

    @routes.post("/api/guest")
    @api
    async def api_guest(request):
        got = await hub.handle_control({"t": "guest_pass", "hours": (await body(request)).get("hours", 2)})
        return web.json_response({k: v for k, v in (got or {}).items() if k != "svg"} or {"error": "lockdown"})

    @routes.get("/api/journal")
    @api
    async def api_journal_index(request):
        rows = await asyncio.to_thread(hub.journal.summary) if hub.journal else {}
        out = []
        for device_id, row in rows.items():
            dev = cfg["devices"].get(device_id)
            out.append({"device_id": device_id, "name": dev["name"] if dev else "(removed phone)", "platform": dev["platform"] if dev else "",
                        "online": bool(hub.online(device_id)), **row})
        return web.json_response(sorted(out, key=lambda r: (not r["online"], r["name"].lower())), headers={"Cache-Control": "no-store"})

    @routes.get("/api/journal/{device_id}")
    @api
    async def api_journal(request):
        q = request.query
        kinds = [k for k in q.get("kinds", "").split(",") if k] or None
        got = await asyncio.to_thread(hub.journal.read, request.match_info["device_id"], int(q.get("from", 0)), int(q["to"]) if q.get("to") else None,
                                      max(1, min(int(q.get("limit", 5000)), 60000)), kinds, q.get("newest") == "1")
        return web.json_response(got, headers={"Cache-Control": "no-store"})

    @routes.post("/api/journal/clear")
    @api
    async def api_journal_clear_all(request):
        await asyncio.to_thread(hub.journal.clear)
        hub.event("security", "All activity records were cleared from the dashboard")
        return web.json_response({"ok": True})

    @routes.post("/api/journal/{device_id}/clear")
    @api
    async def api_journal_clear(request):
        await asyncio.to_thread(hub.journal.clear, request.match_info["device_id"])
        hub.event("security", "An activity record was cleared from the dashboard")
        return web.json_response({"ok": True})

    @routes.get("/api/pending")
    @api
    async def api_pending(request):
        return web.json_response(hub.pending_rows())

    @routes.post("/api/settings")
    @api
    async def api_settings(request):
        b = await body(request)
        await hub.handle_control({"t": "set_global", **{k: b[k] for k in ("approval", "lockdown", "strict", "streaming", "master", "latency_ms", "auto_latency", "activity", "auto_keyboard") if k in b}})
        return web.json_response({"ok": True})

    @routes.post("/api/devices/{device_id}/block")
    @api
    async def api_block(request):
        on = (await body(request)).get("on", True)
        await hub.handle_control({"t": "block", "device_id": request.match_info["device_id"], "on": on})
        return web.json_response({"ok": True, "blocked": bool(on)})

    @routes.post("/api/calibrate/{plan_id}")
    @api
    async def api_calibrate(request):
        data = await request.read()
        if len(data) > 48000 * 2 * 60:
            raise ValueError("recording too long")
        result = await asyncio.to_thread(hub.finish_calibration, request.match_info["plan_id"], data,
                                         int(request.query["sr"]), float(request.query["start"]),
                                         request.query.get("apply", "1") == "1", request.query.get("vol") == "1")
        await hub.broadcast_state()
        return web.json_response({"ok": True, "results": result})

    # ------------------------------------------------- file transfer + clipboard picture (phone side)

    def files_client(request):
        c = hub.client_for_files(request.query.get("k", ""))
        if not c:
            raise web.HTTPForbidden(text="File transfer is off for this phone")
        return c

    @routes.get("/files/list")
    async def files_list(request):
        files_client(request)
        return web.json_response(await asyncio.to_thread(hub.list_files))

    @routes.get("/files/get/{name}")
    async def files_get(request):
        files_client(request)
        name = os.path.basename(request.match_info["name"])
        path = os.path.join(hub.share_dir(), name)
        if not name or not os.path.isfile(path):
            raise web.HTTPNotFound()
        return web.FileResponse(path, headers={"Content-Disposition": f'attachment; filename="{name}"', "Cache-Control": "no-store"})

    @routes.post("/files/put")
    async def files_put(request):
        c = files_client(request)
        name = os.path.basename(request.query.get("name", "")).strip() or "file"
        name = "".join(ch for ch in name if ch not in '<>:"/\\|?*' and ord(ch) >= 32)[:150] or "file"
        folder = hub.share_dir()
        base, ext = os.path.splitext(name)
        path, n = os.path.join(folder, name), 1
        while os.path.exists(path):
            path, n = os.path.join(folder, f"{base} ({n}){ext}"), n + 1
        size = 0
        with open(path + ".part", "wb") as f:
            async for chunk in request.content.iter_chunked(1 << 16):
                size += len(chunk)
                if size > 4 * 1024 ** 3:
                    f.close()
                    os.remove(path + ".part")
                    raise web.HTTPRequestEntityTooLarge(max_size=4 * 1024 ** 3, actual_size=size)
                f.write(chunk)
        os.replace(path + ".part", path)
        hub.event("file", f"{c.dev['name']} sent {os.path.basename(path)} ({size / 1e6:.1f} MB)")
        await hub.broadcast_state()
        return web.json_response({"ok": True, "name": os.path.basename(path), "size": size})

    @routes.get("/clip/{token}/{name}")
    async def clip_image(request):
        c = next((x for x in hub.clients.values() if secrets.compare_digest(x.file_token, request.match_info["token"])), None)
        if not c or not c.clip_image:
            raise web.HTTPNotFound()
        return web.Response(body=c.clip_image, content_type="image/jpeg",
                            headers={"Content-Disposition": f'attachment; filename="{os.path.basename(request.match_info["name"])}"', "Cache-Control": "no-store"})

    @routes.get("/api/debug/input")
    @api
    async def api_debug_input(request):
        """Demo/test mode only: what the phones asked the mouse and keyboard to do (nothing was injected)."""
        if hub.input_log is None:
            raise web.HTTPNotFound()
        events = list(hub.input_log)
        if request.query.get("clear"):
            hub.input_log.clear()
        if request.query.get("center") and hasattr(hub.desktop, "cursor"):
            hub.desktop.cursor[:] = [0.5, 0.5]        # put the pretend pointer back on the pretend text box
        return web.json_response({"events": events, "clipboard": hub.desktop.get_clipboard(), "cursor": list(getattr(hub.desktop, "cursor", []))})

    @routes.get("/api/diagnostics")
    @api
    async def api_diag(request):
        safe_cfg = {k: v for k, v in cfg.data.items() if k not in ("api_token", "devices", "vlc")}
        devices = [{k: v for k, v in d.items() if k != "ip"} for d in hub.device_rows()]
        diag = {
            "version": __version__, "time": time.strftime("%Y-%m-%d %H:%M:%S"),
            "python": sys.version, "platform": platform.platform(), "ips": hub.ips, "ports": hub.ports,
            "mdns": hub.mdns_ok, "capture": {"status": hub.capture.status, "error": hub.capture.error,
                                             "device": hub.capture.active_device, "restarts": hub.capture.restarts,
                                             "devices": hub.capture.devices, "sample_rate": hub.sample_rate},
            "config": safe_cfg, "devices": devices, "media": hub.media.public(), "logs": list(RECENT_LOGS)[-150:],
        }
        return web.json_response(diag, dumps=lambda o: json.dumps(o, indent=2, default=str), headers={
            "Content-Disposition": f"attachment; filename=phoneboxsound-diagnostics-{time.strftime('%Y%m%d-%H%M%S')}.json"})

    app = web.Application(client_max_size=8 * 1024 * 1024, middlewares=[cache_headers])
    app.add_routes(routes)
    return app


def fatal(args, msg):
    """Stop before anything is served, and say why where the user will see it."""
    log.error(msg)
    print("\nPhoneBoxSound did not start:\n  " + msg + "\n", file=sys.stderr)
    if sys.platform == "win32" and not (args.no_tray or args.demo):
        try:
            import ctypes
            ctypes.windll.user32.MessageBoxW(0, msg, "PhoneBoxSound did not start", 0x10)
        except Exception:
            pass
    raise SystemExit(3)


SEALED_PAGE = """<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">{refresh}
<title>PhoneBoxSound is locked</title>
<body style="font-family:system-ui,sans-serif;background:#0b0f0d;color:#e8f0ec;display:grid;place-items:center;min-height:100vh;margin:0">
<form method="post" action="/unlock" style="width:min(380px,90vw);padding:28px;border:1px solid #23302a;border-radius:18px;background:#111815">
<h2 style="margin:0 0 8px">PhoneBoxSound is locked</h2>
<p style="opacity:.75;margin:0 0 18px">{msg}</p>{form}</form></body>"""
SEALED_FORM = """<input name="password" type="password" autofocus autocomplete="current-password" placeholder="Password"
 style="width:100%;box-sizing:border-box;padding:12px 14px;border-radius:12px;border:1px solid #2c3b34;background:#0b0f0d;color:inherit;font-size:16px">
<button style="margin-top:12px;width:100%;padding:12px;border:0;border-radius:12px;background:#6fd3a0;color:#06140d;font-weight:700;font-size:16px">Unlock and start</button>"""


async def sealed_unlock(args, vault, port):
    """The vault insists on the password and nothing on disk can open it: serve one tiny page, to this
    PC only, until the right password is typed. No phone can reach the server in this state."""
    if os.environ.get("PHONEBOXSOUND_PASSWORD"):
        try:
            return vault.open_with_password(os.environ["PHONEBOXSOUND_PASSWORD"])
        except Exception as e:
            fatal(args, str(e))
    done, fails = asyncio.get_running_loop().create_future(), []
    headers = {"Cache-Control": "no-store", "X-Frame-Options": "DENY", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'"}

    def show(msg, form=True, refresh=""):
        return web.Response(text=SEALED_PAGE.format(msg=msg, form=SEALED_FORM if form else "", refresh=refresh), content_type="text/html", headers=headers)

    async def page(request):
        return show("The storage is encrypted and set to ask for the password at every start. Phones can't connect until you unlock it.")

    async def unlock(request):
        now = time.time()
        fails[:] = [t for t in fails if now - t < 900]
        if len(fails) >= 5 and now - fails[-1] < min(300, 2 ** (len(fails) - 4)):
            return show("Too many wrong tries. Wait a little and try again.")
        form = await request.post()
        try:
            data = await asyncio.to_thread(vault.open_with_password, str(form.get("password", "")))
        except Exception as e:
            fails.append(now)
            log.warning("wrong start-up password")
            return show(str(e) + ". Try again.")
        if not done.done():
            done.set_result(data)
        return show("Unlocked. Starting…", form=False, refresh='<meta http-equiv="refresh" content="2;url=/dashboard">')

    app = web.Application(client_max_size=4096)
    app.add_routes([web.post("/unlock", unlock), web.get("/{tail:.*}", page)])
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    await web.TCPSite(runner, "127.0.0.1", port).start()
    log.info("locked: waiting for the password at http://localhost:%s", port)
    print(f"\n  PhoneBoxSound is locked. Open http://localhost:{port} on this PC and enter the password.\n")
    if not args.no_browser or args.autostart:
        # …except this one page: started by Windows and locked, nothing would ever tell you it is waiting
        webbrowser.open(f"http://localhost:{port}/")
    data = await done
    await asyncio.sleep(0.15)        # let the "unlocked" page go out, then free the port for the real server
    await runner.cleanup()
    return data


def port_free(port):
    """Instant: can this port still be taken by us? (Asking the port over the network instead costs 1.5 s
    on Windows when nothing is there, which used to be the longest single step of every start.)"""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        if sys.platform == "win32":
            s.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)   # fails if anyone holds it on any address
        s.bind(("0.0.0.0", port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def already_running(port):
    """True if a PhoneBoxSound (running or waiting for its password) already answers on this port."""
    if port_free(port):
        return False
    import urllib.request
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/auth", timeout=1.5) as r:
            body = r.read(600).decode("utf-8", "replace")
        return '"required"' in body or "PhoneBoxSound is locked" in body
    except Exception:
        return False


async def run(args):
    began = time.perf_counter()
    setup_logging(args.verbose)
    if args.autostart:
        args.no_browser = True       # no dashboard popping up at every sign-in…
    if not args.demo and not args.reset_protection:
        from . import autostart
        await asyncio.to_thread(autostart.refresh)      # before anything can wait: the start-up entry always matches this version
    from .vault import Vault, VaultError
    path = args.config or os.environ.get("PHONEBOXSOUND_CONFIG") or os.path.join(HOME, "config.json")
    if not args.reset_protection:
        guess = args.port or int(os.environ.get("PHONEBOXSOUND_PORT") or 8080)
        if await asyncio.to_thread(already_running, guess):
            # Started twice (the tray icon, a shortcut and "start with Windows" make that easy): don't fight
            # over the port, just show the one that is running.
            print(f"\n  PhoneBoxSound is already running. Opening http://localhost:{guess}\n")
            if not args.no_browser:
                webbrowser.open(f"http://localhost:{guess}/")
            return
    vault = Vault(os.path.splitext(path)[0] + ".vault")
    if args.reset_protection:
        import getpass
        try:
            vault.destroy(getpass.getpass("Dashboard password: "))
        except VaultError as e:
            raise SystemExit(str(e))
        print("Protected settings erased. The next start begins from scratch.")
        return
    try:
        vault.inspect()
        data = vault.open_unattended() if vault.exists else None
    except VaultError as e:
        fatal(args, f"{e}\n\nThe server will not run with settings it can't trust. Put the original file back, or erase "
                    "everything and start over with:  phoneboxsound --reset-protection  (asks for the password).")
    if vault.exists and data is None:
        data = await sealed_unlock(args, vault, args.port or int(os.environ.get("PHONEBOXSOUND_PORT") or 8080))
    cfg = Config(path, vault=vault, data=data)
    from .journal import Journal
    default_path = os.path.abspath(path) == os.path.abspath(os.path.join(HOME, "config.json"))
    journal = Journal(os.path.join(DATA, "journal") if default_path else os.path.splitext(path)[0] + "-journal", cfg)
    http_port = args.port or cfg["port"]
    https_port = None if args.no_https or not cfg["https"] else (args.https_port or cfg["https_port"])

    capture = Capture()
    media = MediaEngine(cfg, demo=args.demo)
    from .desktop import DemoDesktop
    hub = Hub(cfg, capture, media, {"http": http_port, "https": https_port}, DemoDesktop() if args.demo else None)
    hub.ips = local_ips()
    hub.search.demo = hub.spotify.demo = args.demo
    if args.terms_accepted:
        hub.accept_terms()
    if not args.demo:
        from .textfocus import TextFocus
        hub.textfocus = TextFocus()
    from .video import Video
    hub.video = Video(DATA, demo=args.demo)
    if not args.demo or os.environ.get("PHONEBOXSOUND_DEMO_VIDEO"):
        asyncio.get_running_loop().call_later(2, lambda: asyncio.ensure_future(hub.video.check()))   # after start-up, off the critical path
    else:
        hub.video.checked = True                     # the demo shows pictures unless a test asks for video
    hub.journal = journal
    loop = asyncio.get_running_loop()

    def quiet(lp, ctx):
        # a phone dropping off Wi-Fi mid-send is normal, not worth a traceback in the log
        if not isinstance(ctx.get("exception"), (ConnectionResetError, ConnectionAbortedError)):
            lp.default_exception_handler(ctx)
    loop.set_exception_handler(quiet)
    from .pcout import PcOut
    hub.pcout = PcOut(cfg, capture)
    capture.on_reinit = hub.pcout.close      # it borrows the capture's audio handle and must let go when that restarts

    def emit(ts, sr, stereo):
        hub.pcout.feed(ts, sr, stereo)            # straight from the capture thread: its timing must not wait for anything
        loop.call_soon_threadsafe(hub.on_audio, ts, sr, stereo)
    capture.emit = emit
    if args.demo:
        cfg["source"] = "demo"  # so "back to what was playing" never reaches for the real sound card
    source = "clicks" if args.test else cfg["source"]
    capture.configure(source, cfg["device"])
    capture.start()

    runner = web.AppRunner(build_app(hub, args), access_log=None)
    await runner.setup()
    ssl_ctx = None
    if https_port:
        try:
            from .tls import make_context
            # the saved certificate only: the weekly download happens after start-up, in the background
            ssl_ctx, hub.public_https = await asyncio.to_thread(make_context, DATA, hub.ips, cfg["public_https"] and not args.demo, False)
            await web.TCPSite(runner, "0.0.0.0", https_port, ssl_context=ssl_ctx).start()
        except Exception as e:
            log.warning("HTTPS disabled: %s", e)
            hub.ports["https"], ssl_ctx, hub.public_https = None, None, False
    # The main port speaks both http and https, whichever the browser asks for.
    try:
        listener = DualListener(loop, runner.server, http_port, ssl_ctx)
    except OSError:
        capture.stop()
        if already_running(http_port):
            print(f"\n  PhoneBoxSound is already running on port {http_port}.\n")
            return
        fatal(args, f"Port {http_port} is being used by another program.\n\nClose that program, or start PhoneBoxSound on another port:\n"
                    f"  python -m phoneboxsound --port {http_port + 1}\n(the port can then be changed for good in Settings).")
    listener.start()

    discovery = Discovery()
    if cfg["mdns"] and not args.no_mdns:
        hub.mdns_ok = await discovery.start(hub.ips, http_port)

    live = {"listener": listener}
    log.info("ready in %.1f s", time.perf_counter() - began)

    async def refresh_certificate():
        """Fetch the trusted certificate when the saved one is a week old (or absent), then switch to it."""
        from .tls import make_context, public_cert_stale
        if not (https_port and ssl_ctx and cfg["public_https"] and not args.demo and public_cert_stale(DATA)):
            return
        try:
            fresh, ok = await asyncio.to_thread(make_context, DATA, hub.ips, True, True)
            if ok:
                live["listener"].ssl = fresh          # new connections use it; nothing restarts
                hub.public_https = True
                await hub.broadcast_state()
        except Exception as e:
            log.info("certificate refresh failed: %s", e)
    asyncio.ensure_future(refresh_certificate())

    async def open_port(port):
        """Start answering on another port; the old one is released a few seconds later, once every
        phone and the dashboard have been told where to go."""
        try:
            fresh = DualListener(loop, runner.server, port, ssl_ctx)
        except OSError:
            return f"Port {port} is being used by another program"
        fresh.start()
        old, live["listener"] = live["listener"], fresh
        loop.call_later(5, old.close)
        if cfg["mdns"] and not args.no_mdns:
            try:
                await discovery.stop()
                hub.mdns_ok = await discovery.start(hub.ips, port)
            except Exception as e:
                log.info("mDNS not re-advertised: %s", e)
        log.info("now on port %s", port)
        return None
    hub.open_port = open_port

    banner = [f"\n  PhoneBoxSound {__version__} is running\n",
              f"  Dashboard (this PC):  http://localhost:{http_port}/dashboard"]
    banner += [f"  Phones open:          http://{ip}:{http_port}" for ip in hub.ips]
    if hub.mdns_ok:
        banner.append(f"                        http://phoneboxsound.local:{http_port}")
    if hub.https_url():
        banner.append(f"  Secure{' (no warning)' if getattr(hub, 'public_https', False) else ''}:{'' if getattr(hub, 'public_https', False) else '              '}  {hub.https_url()}")
    banner += [f"  Room code:            {hub.code}\n", "  Press Ctrl+C to stop.\n"]
    if sys.stdout:  # the windowed .exe has no console
        print("\n".join(banner), flush=True)
    log.info("started on port %d", http_port)

    tray = None
    if not args.no_tray:
        try:
            from .tray import Tray
            tray = Tray(hub, loop, http_port)
            tray.start()
        except Exception as e:
            log.info("tray icon unavailable: %s", e)

    if not args.no_browser:
        webbrowser.open(f"http://localhost:{http_port}/dashboard")

    stop = asyncio.Event()
    hub.request_stop = stop.set
    tasks = [asyncio.create_task(hub.periodic()), asyncio.create_task(media.poll_forever())]
    try:
        await stop.wait()
    finally:
        for t in tasks:
            t.cancel()
        journal.close()
        hub.pcout.close()
        capture.stop()
        live["listener"].close()
        if tray:
            tray.stop()
        await discovery.stop()
        await runner.cleanup()


def main():
    ap = argparse.ArgumentParser(prog="phoneboxsound", description="Turn phones into synced wireless speakers and remotes for this PC.")
    ap.add_argument("--port", type=int, help="HTTP port (default 8080)")
    ap.add_argument("--https-port", type=int, help="HTTPS port for intercom/PWA (default 8443)")
    ap.add_argument("--no-https", action="store_true", help="don't start the HTTPS server")
    ap.add_argument("--no-browser", action="store_true", help="don't open the dashboard on start")
    ap.add_argument("--no-tray", action="store_true", help="no system tray icon")
    ap.add_argument("--no-mdns", action="store_true", help="don't advertise phoneboxsound.local")
    ap.add_argument("--test", action="store_true", help="use the click-track test source (no audio capture needed)")
    ap.add_argument("--demo", action="store_true", help="demo mode: synthetic music and a fake player (for screenshots and tests)")
    ap.add_argument("--config", help="path to the config file (default: config.json next to the app)")
    ap.add_argument("--autostart", action="store_true", help="started by Windows at sign-in: stay in the tray; only show a page if the password is needed")
    ap.add_argument("--terms-accepted", action="store_true", help="the terms were already accepted (start.bat asks before it starts the program)")
    ap.add_argument("--reset-protection", action="store_true", help="erase the encrypted settings and start over (asks for the password)")
    ap.add_argument("--allow-remote-control", action="store_true", help="allow the dashboard from other devices on the network")
    ap.add_argument("-v", "--verbose", action="store_true")
    try:
        asyncio.run(run(ap.parse_args()))
    except KeyboardInterrupt:
        pass
