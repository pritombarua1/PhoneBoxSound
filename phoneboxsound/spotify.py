"""Your Spotify account, linked: the real queue, exact repeat, likes, "play next".

Windows only passes on Spotify's title and play/pause. Everything else needs Spotify's own Web API and
your permission, given once on Spotify's own sign-in page (PhoneBoxSound never sees your password).

Sign-in is "Authorization Code with PKCE": only the app's public Client ID is needed, no secret. Spotify
sends you back to http://127.0.0.1:<port>/api/spotify/callback, which must be listed as a Redirect URI in
your app on developer.spotify.com. The tokens Spotify issues are kept with the other settings (encrypted
once a dashboard password is set) and refreshed by themselves.

What Spotify allows other apps to do, and so what this does:
  read    what is playing, the queue (what plays next), repeat and shuffle state, whether a song is liked
  change  repeat off / all / this song, shuffle, add a song to the queue, skip forward to a queued song,
          like / unlike                                (changing playback needs Spotify Premium)
  not     reorder or remove items in the queue: Spotify offers no way to do that from outside its apps
"""
import base64
import hashlib
import logging
import re
import secrets
import time
from urllib.parse import urlencode

log = logging.getLogger("pbs.spotify")

SCOPES = ("user-read-playback-state user-read-currently-playing user-modify-playback-state user-library-read user-library-modify "
          "playlist-read-private playlist-read-collaborative playlist-modify-private playlist-modify-public")
# Spotify moved several addresses in February 2026 (apps in "development mode", which is every personal app).
# Each call below tries the current address first and the earlier one if Spotify says the current one doesn't exist,
# so it works whichever your app is on.
GONE = (400, 404, 405, 410)
REPEAT_TO = {"off": "off", "all": "context", "one": "track"}
REPEAT_FROM = {v: k for k, v in REPEAT_TO.items()}


def challenge(verifier):
    """The PKCE code challenge for a verifier (base64url of its SHA-256, no padding)."""
    return base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()


def explain(status, data):
    """Spotify's refusal, in words that say what to do."""
    reason = ((data or {}).get("error") or {}) if isinstance(data, dict) else {}
    reason = reason.get("reason") or reason.get("message") or "" if isinstance(reason, dict) else str(reason)
    if status == 403 and "SCOPE" in str(reason).upper():
        return "Spotify needs one more permission for this: press Disconnect and then Connect Spotify again in Settings → Search"
    if status == 403 and "PREMIUM" in str(reason).upper():
        return "Spotify only lets Premium accounts be controlled from other apps"
    if status == 404 or "NO_ACTIVE_DEVICE" in str(reason).upper():
        return "Spotify isn't playing anywhere right now: start a song in Spotify first"
    if status == 401:
        return "Spotify wants you to connect the account again (Settings → Search)"
    if status == 429:
        return "Spotify asks to slow down: try again in a moment"
    return f"Spotify refused ({status}{': ' + str(reason) if reason else ''})"


def track_row(t, thumb=None):
    if not t:
        return None
    imgs = (t.get("album") or {}).get("images") or t.get("images") or []
    img = min(imgs, key=lambda i: abs((i.get("width") or 300) - 300))["url"] if imgs else ""
    return {"id": t.get("id"), "uri": t.get("uri"), "title": t.get("name", ""), "artist": ", ".join(a.get("name", "") for a in t.get("artists", [])) or (t.get("show") or {}).get("name", ""),
            "dur": round((t.get("duration_ms") or 0) / 1000), "thumb": thumb(img) if thumb and img else None}


class Spotify:
    def __init__(self, cfg, demo=False):
        self.cfg, self.demo = cfg, demo
        self.session = None
        self.pending = {}        # state -> (code verifier, redirect uri, started)
        self.thumb = None        # set by the hub: turns a picture address into one served by this PC
        self.live = None         # what Spotify itself last reported: {"progress", "at", "playing", "dur", "volume", "repeat", "shuffle"}
        self._demo = {"repeat": "all", "shuffle": False, "liked": False, "queue": [("d1", "City Lights", "The Demo Band"), ("d2", "Morning Jazz", "Trio Demo"), ("d3", "Rain on Glass", "Demo & Co")]}

    # -------------------------------------------------------------- settings and sign-in

    def store(self):
        return self.cfg.setdefault("spotify", {"refresh": "", "access": "", "exp": 0, "name": ""})

    def client_id(self):
        return (self.cfg.get("search") or {}).get("spotify_id") or ""

    @property
    def linked(self):
        return self.demo or bool(self.store().get("refresh"))

    def status(self, port=8080):
        return {"linked": self.linked, "name": "Demo account" if self.demo else self.store().get("name") or "", "has_id": bool(self.client_id()) or self.demo,
                "redirect": self.redirect(port)}

    @staticmethod
    def redirect(port):
        return f"http://127.0.0.1:{port}/api/spotify/callback"

    def begin(self, port):
        """The address of Spotify's sign-in page for this app, or None without a Client ID."""
        if not self.client_id():
            return None
        verifier, state = secrets.token_urlsafe(64), secrets.token_urlsafe(24)
        self.pending = {k: v for k, v in self.pending.items() if time.time() - v[2] < 600}
        self.pending[state] = (verifier, self.redirect(port), time.time())
        return "https://accounts.spotify.com/authorize?" + urlencode({
            "response_type": "code", "client_id": self.client_id(), "scope": SCOPES, "redirect_uri": self.redirect(port),
            "state": state, "code_challenge_method": "S256", "code_challenge": challenge(verifier)})

    async def _http(self):
        if self.session is None:
            import aiohttp
            self.session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=8))
        return self.session

    async def _token(self, form):
        s = await self._http()
        async with s.post("https://accounts.spotify.com/api/token", data={**form, "client_id": self.client_id()}) as r:
            data = await r.json(content_type=None)
            if r.status != 200:
                raise RuntimeError((data or {}).get("error_description") or f"Spotify answered {r.status}")
        st = self.store()
        st["access"], st["exp"] = data["access_token"], time.time() + int(data.get("expires_in", 3600)) - 60
        if data.get("refresh_token"):
            st["refresh"] = data["refresh_token"]
        self.cfg["spotify"] = st
        self.cfg.save()

    async def finish(self, state, code):
        """Spotify sent the user back: swap the code for tokens. Returns a message on failure."""
        pend = self.pending.pop(str(state or ""), None)
        if not pend or time.time() - pend[2] > 600 or not code:
            return "That sign-in link has expired. Start again from Settings."
        try:
            await self._token({"grant_type": "authorization_code", "code": str(code), "redirect_uri": pend[1], "code_verifier": pend[0]})
            _, me = await self.call("GET", "/me")
            self.store()["name"] = str((me or {}).get("display_name") or (me or {}).get("id") or "")[:60]
            self.store()["uid"] = str((me or {}).get("id") or "")
            self.cfg.save()
        except Exception as e:
            return f"Spotify did not complete the sign-in: {e}"
        return None

    def unlink(self):
        self.cfg["spotify"] = {"refresh": "", "access": "", "exp": 0, "name": ""}
        self.cfg.save()

    # -------------------------------------------------------------- talking to Spotify

    async def call(self, method, path, params=None, json=None):
        """(status, data). Refreshes the access token when it has run out."""
        st = self.store()
        if not st.get("refresh") and not st.get("access"):
            return 401, None
        if st.get("exp", 0) < time.time() and st.get("refresh"):
            await self._token({"grant_type": "refresh_token", "refresh_token": st["refresh"]})
            st = self.store()
        s = await self._http()
        async with s.request(method, "https://api.spotify.com/v1" + path, params=params, json=json, headers={"Authorization": "Bearer " + st["access"]}) as r:
            try:
                data = await r.json(content_type=None) if r.status != 204 and r.content_length != 0 else None
            except Exception:
                data = None
            return r.status, data

    def _note(self, player, at=None):
        if not player:
            self.live = None
            return
        dev = player.get("device") or {}
        self.live = {"progress": (player.get("progress_ms") or 0) / 1000.0, "at": at or time.time(), "playing": bool(player.get("is_playing")),
                     "dur": ((player.get("item") or {}).get("duration_ms") or 0) / 1000.0, "volume": dev["volume_percent"] / 100.0 if dev.get("volume_percent") is not None and dev.get("supports_volume", True) else None,
                     "repeat": REPEAT_FROM.get(player.get("repeat_state"), "off"), "shuffle": bool(player.get("shuffle_state"))}

    async def refresh_live(self):
        """Every couple of seconds while Spotify is playing: where the song really is, and its own volume.
        Windows only hears about Spotify's position now and then, which made the timeline lag and jump."""
        if self.demo or not self.linked:
            return
        try:
            sent = time.time()
            status, player = await self.call("GET", "/me/player")
            if status == 200:
                self._note(player, (sent + time.time()) / 2)
            elif status == 204:
                self.live = None
        except Exception as e:
            log.debug("spotify live failed: %s", e)

    async def snapshot(self):
        """Everything the "up next" sheet shows."""
        if self.demo:
            d = self._demo
            return {"linked": True, "service": "Spotify", "now": {"id": "4uLU6hMCjMI75M1A2tKUQC", "uri": "spotify:track:4uLU6hMCjMI75M1A2tKUQC", "title": "Night Drive", "artist": "The Demo Band", "dur": 215, "thumb": None, "liked": d["liked"]},
                    "repeat": d["repeat"], "shuffle": d["shuffle"], "queue": [{"id": i, "uri": f"spotify:track:{i}", "title": t, "artist": a, "dur": 180, "thumb": None} for i, t, a in d["queue"]],
                    "can": {"reorder": False, "remove": False, "add": True, "like": True}, "error": None}
        if not self.linked:
            return {"linked": False, "service": "Spotify", "now": None, "repeat": "off", "shuffle": False, "queue": [], "can": {}, "error": None}
        try:
            ps, player = await self.call("GET", "/me/player")
            qs, q = await self.call("GET", "/me/player/queue")
            if ps == 401 or qs == 401:
                return {"linked": True, "service": "Spotify", "now": None, "repeat": "off", "shuffle": False, "queue": [], "can": {}, "error": explain(401, None)}
            player, q = player or {}, q or {}
            self._note(player)
            now = track_row(q.get("currently_playing") or player.get("item"), self.thumb)
            if now and now["id"]:
                now["liked"] = await self.is_liked(now["uri"] or f"spotify:track:{now['id']}")
            queue = [r for r in (track_row(t, self.thumb) for t in (q.get("queue") or [])[:30]) if r]
            # With nothing lined up, Spotify answers with the playing song over and over. That is not a queue.
            if now and queue and all(r["id"] == now["id"] for r in queue):
                queue = []
            return {"linked": True, "service": "Spotify", "now": now, "repeat": REPEAT_FROM.get(player.get("repeat_state"), "off"), "shuffle": bool(player.get("shuffle_state")),
                    "queue": queue,
                    "can": {"reorder": False, "remove": False, "add": True, "like": True},
                    "error": None if player else "Spotify isn't playing anywhere right now: start a song in Spotify first"}
        except Exception as e:
            log.info("spotify snapshot failed: %s", e)
            return {"linked": True, "service": "Spotify", "now": None, "repeat": "off", "shuffle": False, "queue": [], "can": {}, "error": f"Spotify can't be reached: {e}"}

    async def is_liked(self, uri):
        status, got = await self.call("GET", "/me/library/contains", params={"uris": uri})
        if status in GONE:
            status, got = await self.call("GET", "/me/tracks/contains", params={"ids": uri.split(":")[-1]})
        return bool(got and got[0]) if isinstance(got, list) else False

    async def playlist_has(self, pid, uri):
        """How many times this song is already in the playlist (0 = not there; None = couldn't find out).
        Spotify has no "is it in there?" question for playlists, so the list is read, up to 1000 songs."""
        if self.demo:
            return sum(1 for i, u in self._demo.get("added", []) if i == pid and u == uri)
        if not self.linked:
            return None
        pid = re.sub(r"[^A-Za-z0-9]", "", str(pid or ""))
        try:
            found, offset, path = 0, 0, f"/playlists/{pid}/items"
            while offset < 1000:
                status, data = await self.call("GET", path, params={"limit": "50", "offset": str(offset)})
                if status in GONE and path.endswith("/items") and not offset:
                    path = f"/playlists/{pid}/tracks"
                    continue
                if status != 200:
                    return None
                rows = data.get("items") or []
                found += sum(1 for it in rows if ((it or {}).get("track") or (it or {}).get("item") or {}).get("uri") == uri)
                if not data.get("next") or not rows:
                    break
                offset += 50
            return found
        except Exception:
            return None

    async def playlists(self):
        """Your playlists: {"list": [{"id", "name", "count", "thumb", "mine"}], "error"}. `mine`: you may add to it."""
        if self.demo:
            return {"list": [{"id": "pl1", "name": "Road trip", "count": 42, "thumb": None, "mine": True}, {"id": "pl2", "name": "Focus", "count": 18, "thumb": None, "mine": True},
                             {"id": "pl3", "name": "Top hits (by Spotify)", "count": 50, "thumb": None, "mine": False}], "error": None}
        if not self.linked:
            return {"list": [], "error": "Connect your Spotify account first (Settings → Search)"}
        try:
            uid = self.store().get("uid")
            if not uid:
                _, me = await self.call("GET", "/me")
                uid = self.store()["uid"] = str((me or {}).get("id") or "")
            out, offset = [], 0
            while offset < 200:
                status, data = await self.call("GET", "/me/playlists", params={"limit": "50", "offset": str(offset)})
                if status != 200:
                    return {"list": out, "error": explain(status, data)}
                for p in data.get("items") or []:
                    if not p:
                        continue
                    imgs = p.get("images") or []
                    count = (p.get("items") or p.get("tracks") or {}).get("total")
                    out.append({"id": p.get("id"), "name": p.get("name") or "Playlist", "count": count,
                                "thumb": self.thumb(imgs[-1]["url"]) if imgs and self.thumb else None,
                                "mine": (p.get("owner") or {}).get("id") == uid or bool(p.get("collaborative"))})
                if not data.get("next"):
                    break
                offset += 50
            return {"list": out, "error": None}
        except Exception as e:
            return {"list": [], "error": f"Spotify can't be reached: {e}"}

    async def do(self, action, value=None):
        """Carry out one change. Returns None when done, or what went wrong in plain words."""
        if self.demo:
            d = self._demo
            if action == "repeat" and value in REPEAT_TO:
                d["repeat"] = value
            elif action == "shuffle":
                d["shuffle"] = bool(value) if value is not None else not d["shuffle"]
            elif action in ("like", "unlike"):
                d["liked"] = action == "like"
            elif action == "add":
                d["queue"].append((str(value).split(":")[-1], "Added song", "From search"))
            elif action == "skip":
                d["queue"] = d["queue"][max(1, int(value or 1)):]
            elif action == "playlist_add":
                d.setdefault("added", []).append((value.get("id"), value.get("uri")))
            elif action == "playlist_remove":
                d["added"] = [x for x in d.get("added", []) if x != (value.get("id"), value.get("uri"))]
            elif action == "playlist_play":
                d["playing_list"] = value
            return None
        if not self.linked:
            return "Connect your Spotify account first (Settings → Search)"
        try:
            if action == "repeat" and value in REPEAT_TO:
                status, data = await self.call("PUT", "/me/player/repeat", params={"state": REPEAT_TO[value]})
            elif action == "shuffle":
                status, data = await self.call("PUT", "/me/player/shuffle", params={"state": "true" if value else "false"})
            elif action == "add" and str(value).startswith("spotify:track:"):
                status, data = await self.call("POST", "/me/player/queue", params={"uri": str(value)})
            elif action in ("like", "unlike") and value:
                uri = str(value) if str(value).startswith("spotify:") else f"spotify:track:{value}"
                verb = "PUT" if action == "like" else "DELETE"
                status, data = await self.call(verb, "/me/library", params={"uris": uri})
                if status in GONE:
                    status, data = await self.call(verb, "/me/tracks", params={"ids": uri.split(":")[-1]})
            elif action == "playlist_add" and isinstance(value, dict) and str(value.get("uri", "")).startswith("spotify:track:"):
                pid = re.sub(r"[^A-Za-z0-9]", "", str(value.get("id") or ""))
                status, data = await self.call("POST", f"/playlists/{pid}/items", json={"uris": [value["uri"]]})
                if status in GONE:
                    status, data = await self.call("POST", f"/playlists/{pid}/tracks", json={"uris": [value["uri"]]})
            elif action == "playlist_remove" and isinstance(value, dict) and str(value.get("uri", "")).startswith("spotify:track:"):
                pid = re.sub(r"[^A-Za-z0-9]", "", str(value.get("id") or ""))      # every copy of the song leaves the playlist
                status, data = await self.call("DELETE", f"/playlists/{pid}/items", json={"items": [{"uri": value["uri"]}]})
                if status in GONE:
                    status, data = await self.call("DELETE", f"/playlists/{pid}/tracks", json={"tracks": [{"uri": value["uri"]}]})
            elif action == "playlist_play" and value:
                pid = re.sub(r"[^A-Za-z0-9]", "", str(value))
                status, data = await self.call("PUT", "/me/player/play", json={"context_uri": f"spotify:playlist:{pid}"})
            elif action == "seek":
                status, data = await self.call("PUT", "/me/player/seek", params={"position_ms": max(0, int(value))})
                if status < 300 and self.live:
                    self.live.update(progress=max(0, int(value)) / 1000.0, at=time.time())
            elif action == "volume":
                pct = max(0, min(100, int(round(float(value) * 100))))
                status, data = await self.call("PUT", "/me/player/volume", params={"volume_percent": pct})
                if status < 300 and self.live:
                    self.live["volume"] = pct / 100.0
            elif action == "play" and str(value).startswith("spotify:track:"):
                status, data = await self.call("PUT", "/me/player/play", json={"uris": [str(value)]})
            elif action == "skip":
                status, data = 204, None
                for _ in range(max(1, min(int(value or 1), 15))):       # Spotify has no "jump to": step forward to it
                    status, data = await self.call("POST", "/me/player/next")
                    if status >= 300:
                        break
            else:
                return "Spotify has no such action"
        except Exception as e:
            return f"Spotify can't be reached: {e}"
        return None if status < 300 else explain(status, data)
