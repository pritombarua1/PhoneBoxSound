"""Search the music and video services from a phone, see results with pictures, play one on the PC.

Where results come from:
  YouTube      the official Data API if you gave a key in Settings; otherwise yt-dlp if it is installed
               (pip install yt-dlp); suggestions while typing from YouTube's own suggestion service
  Apple Music  Apple's public catalogue search (no key)
  Spotify      Spotify's Web API with the free client id + secret from developer.spotify.com
  Netflix, Prime Video, Disney+ and others have no way for another program to get their results:
               for those there is a button that opens their own search page on the PC.

Safety: a phone never sends an address. It sends words, gets back result ids, and can ask to open an
id. The PC only ever opens addresses this module built itself, on the services listed in OPEN_HOSTS,
and only fetches pictures from the hosts in THUMB_HOSTS (served to the phone through this PC, so the
phone talks to nobody else). Your words do go to the services you search: that is what searching is.
"""
import asyncio
import base64
import collections
import hashlib
import html
import io
import logging
import time
from urllib.parse import quote, urlparse

log = logging.getLogger("pbs.search")

SERVICES = ("spotify", "youtube", "apple")
LABELS = {"youtube": "YouTube", "spotify": "Spotify", "apple": "Apple Music", "netflix": "Netflix", "prime": "Prime Video",
          "disney": "Disney+", "twitch": "Twitch", "soundcloud": "SoundCloud"}
SEARCH_PAGES = {  # each service's own search page, opened on the PC
    "youtube": "https://www.youtube.com/results?search_query={q}", "spotify": "spotify:search:{q}", "apple": "https://music.apple.com/search?term={q}",
    "netflix": "https://www.netflix.com/search?q={q}", "prime": "https://www.primevideo.com/search?phrase={q}",
    "disney": "https://www.disneyplus.com/search?q={q}", "twitch": "https://www.twitch.tv/search?term={q}", "soundcloud": "https://soundcloud.com/search?q={q}",
}
OPEN_HOSTS = ("youtube.com", "music.apple.com", "open.spotify.com", "netflix.com", "primevideo.com", "disneyplus.com", "twitch.tv", "soundcloud.com")
THUMB_HOSTS = ("ytimg.com", "mzstatic.com", "scdn.co", "ggpht.com")


def _country():
    """This PC's country as two letters (for services that only answer per country); US when unknown."""
    import locale
    try:
        code = (locale.getlocale()[0] or "").replace("-", "_").split("_")[-1]
        names = {"United States": "US", "United Kingdom": "GB", "India": "IN", "Bangladesh": "BD", "Canada": "CA", "Australia": "AU", "Germany": "DE", "France": "FR"}
        code = names.get(code, code)
        return code.upper() if len(code) == 2 and code.isalpha() else "US"
    except Exception:
        return "US"


def _host_ok(url, hosts):
    try:
        u = urlparse(url)
    except ValueError:
        return False
    return u.scheme == "https" and any(u.hostname == h or (u.hostname or "").endswith("." + h) for h in hosts)


def may_open(url):
    return url.startswith(("spotify:track:", "spotify:search:", "spotify:album:")) or _host_ok(url, OPEN_HOSTS)


# ------------------------------------------------------------------ turning each service's answer into our rows

def from_apple(data):
    out = []
    for r in data.get("results", []):
        if r.get("trackViewUrl") and r.get("trackName"):
            out.append({"service": "apple", "title": r["trackName"], "sub": " · ".join(x for x in (r.get("artistName"), r.get("collectionName")) if x),
                        "dur": round((r.get("trackTimeMillis") or 0) / 1000), "thumb": (r.get("artworkUrl100") or "").replace("100x100", "300x300"), "url": r["trackViewUrl"]})
    return out


def from_youtube_api(data):
    out = []
    for it in data.get("items", []):
        vid, sn = (it.get("id") or {}).get("videoId"), it.get("snippet") or {}
        if vid:
            th = sn.get("thumbnails") or {}
            out.append({"service": "youtube", "title": html.unescape(sn.get("title", "")), "sub": html.unescape(sn.get("channelTitle", "")), "dur": 0,
                        "thumb": (th.get("medium") or th.get("default") or {}).get("url", ""), "url": f"https://www.youtube.com/watch?v={vid}"})
    return out


def from_ytdlp(info):
    out = []
    for e in (info or {}).get("entries") or []:
        vid = e.get("id")
        if vid and e.get("title"):
            out.append({"service": "youtube", "title": e["title"], "sub": e.get("channel") or e.get("uploader") or "", "dur": int(e.get("duration") or 0),
                        "thumb": f"https://i.ytimg.com/vi/{vid}/mqdefault.jpg", "url": f"https://www.youtube.com/watch?v={vid}"})
    return out


def from_spotify(data):
    out = []
    for t in (data.get("tracks") or {}).get("items", []):
        imgs = (t.get("album") or {}).get("images") or []
        img = min(imgs, key=lambda i: abs((i.get("width") or 300) - 300))["url"] if imgs else ""
        out.append({"service": "spotify", "title": t.get("name", ""), "sub": " · ".join(x for x in (", ".join(a["name"] for a in t.get("artists", [])), (t.get("album") or {}).get("name")) if x),
                    "dur": round((t.get("duration_ms") or 0) / 1000), "thumb": img, "url": f"spotify:track:{t['id']}"})
    return out


def _demo_rows(q):
    return [{"service": s, "title": f"{q.title()} ({LABELS[s]} result {i + 1})", "sub": "Demo artist", "dur": 180 + 30 * i, "thumb": f"demo:{s}:{i}",
             "url": {"youtube": f"https://www.youtube.com/watch?v=demo{i}", "spotify": f"spotify:track:demo{i}", "apple": f"https://music.apple.com/us/album/demo/{i}"}[s]}
            for s in SERVICES for i in range(3)]


class Search:
    def __init__(self, cfg, demo=False):
        self.cfg, self.demo = cfg, demo
        self.session = None
        self.targets = collections.OrderedDict()   # result id -> address the PC may open
        self.thumbs = collections.OrderedDict()    # picture key -> address, then (bytes, type) once fetched
        self._spotify = (None, 0)                  # (access token, expires)
        self._cache = collections.OrderedDict()    # (service, words) -> (time, rows)
        self.spotify = None                        # the linked account (spotify.Spotify), set by the hub

    def settings(self):
        return self.cfg.setdefault("search", {"youtube_key": "", "spotify_id": "", "spotify_secret": ""})

    def status(self):
        """What the dashboard shows: which services give real results, and why not the others."""
        s = self.settings()
        try:
            import yt_dlp  # noqa: F401
            ytdlp = True
        except Exception:
            ytdlp = False
        return {"youtube": "key" if s.get("youtube_key") else "ytdlp" if ytdlp or self.demo else "none", "spotify": bool(s.get("spotify_id") and s.get("spotify_secret")) or self.demo or bool(self.spotify is not None and self.spotify.linked),
                "apple": True, "has": {k: bool(s.get(k)) for k in ("youtube_key", "spotify_id", "spotify_secret")}}

    async def _http(self):
        if self.session is None:
            import aiohttp
            self.session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=8), headers={"User-Agent": "PhoneBoxSound"})
        return self.session

    async def _json(self, url, **kw):
        s = await self._http()
        async with s.get(url, **kw) as r:
            if r.status != 200:
                raise RuntimeError(f"answered {r.status}")
            return await r.json(content_type=None)

    # -------------------------------------------------------------- one service at a time

    async def _youtube(self, q):
        key = self.settings().get("youtube_key")
        if key:
            return from_youtube_api(await self._json("https://www.googleapis.com/youtube/v3/search", params={"part": "snippet", "type": "video", "maxResults": "12", "q": q, "key": key}))

        def run():
            import yt_dlp
            with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "extract_flat": True, "skip_download": True, "socket_timeout": 8}) as y:
                return y.extract_info(f"ytsearch12:{q}", download=False)
        try:
            import yt_dlp  # noqa: F401
        except Exception:
            raise RuntimeError("needs a YouTube API key in Settings, or yt-dlp installed") from None
        return from_ytdlp(await asyncio.wait_for(asyncio.to_thread(run), 14))

    async def _apple(self, q):
        return from_apple(await self._json("https://itunes.apple.com/search", params={"term": q, "media": "music", "entity": "song", "limit": "12"}))

    async def _spotify_search(self, q):
        st = self.settings()
        if self.spotify is not None and self.spotify.linked and not self.spotify.demo:
            # the linked account can search by itself: no client secret needed
            # Spotify allows at most 10 results per request since February 2026 (asking for more is refused outright)
            status, data = await self.spotify.call("GET", "/search", params={"q": q, "type": "track", "limit": "10", "market": "from_token"})
            if status == 200:
                return from_spotify(data)
            if not (st.get("spotify_id") and st.get("spotify_secret")):
                from .spotify import explain
                raise RuntimeError(explain(status, data))
        if not (st.get("spotify_id") and st.get("spotify_secret")):
            raise RuntimeError("connect your Spotify account in Settings (or add the client secret)")
        token, exp = self._spotify
        if not token or exp < time.time() + 30:
            s = await self._http()
            basic = base64.b64encode(f"{st['spotify_id']}:{st['spotify_secret']}".encode()).decode()
            async with s.post("https://accounts.spotify.com/api/token", data={"grant_type": "client_credentials"}, headers={"Authorization": "Basic " + basic}) as r:
                if r.status != 200:
                    raise RuntimeError("Spotify did not accept the client id / secret")
                j = await r.json()
            token = j["access_token"]
            self._spotify = (token, time.time() + int(j.get("expires_in", 3600)))
        # without a signed-in user Spotify needs to be told a country, or it treats every song as unavailable
        return from_spotify(await self._json("https://api.spotify.com/v1/search", params={"q": q, "type": "track", "limit": "10", "market": _country()}, headers={"Authorization": "Bearer " + token}))

    # -------------------------------------------------------------- what the phone asks for

    async def find(self, q):
        """Raw results (with their addresses) from every service that answers: used to find the public
        link of a song that is playing. Never sent to a phone as they are."""
        q = " ".join(str(q or "").split())[:120]
        if len(q) < 2:
            return []
        if self.demo:
            return [{"service": s, "title": q, "sub": "", "dur": 200, "thumb": "", "url": u} for s, u in
                    (("spotify", "spotify:track:4uLU6hMCjMI75M1A2tKUQC"), ("apple", "https://music.apple.com/us/album/demo/1?i=2"), ("youtube", "https://www.youtube.com/watch?v=aqz-KE-bpKQ"))]
        runs = {"youtube": self._youtube, "apple": self._apple, "spotify": self._spotify_search}
        todo = [s for s in SERVICES if s != "spotify" or self.status()["spotify"]]
        done = await asyncio.gather(*(runs[s](q) for s in todo), return_exceptions=True)
        return [r for got in done if not isinstance(got, Exception) for r in got[:5]]

    def _publish(self, rows):
        """Give each row an id and a picture address on this PC; remember what each id may open."""
        out = []
        for r in rows:
            if not may_open(r["url"]):
                continue
            rid = hashlib.sha1(r["url"].encode()).hexdigest()[:14]
            self.targets[rid] = r["url"]
            thumb = None
            if r.get("thumb", "").startswith("demo:") or _host_ok(r.get("thumb", ""), THUMB_HOSTS):
                key = hashlib.sha1(r["thumb"].encode()).hexdigest()[:16]
                self.thumbs.setdefault(key, r["thumb"])
                thumb = f"/thumb/{key}"
            out.append({"id": rid, "service": r["service"], "label": LABELS[r["service"]], "title": r["title"][:160], "sub": r["sub"][:160], "dur": r["dur"], "thumb": thumb})
        for store, cap in ((self.targets, 600), (self.thumbs, 400)):
            while len(store) > cap:
                store.popitem(last=False)
        return out

    def links(self, q):
        """Each service's own search page, as ids the phone can ask the PC to open."""
        out = []
        for s, page in SEARCH_PAGES.items():
            url = page.format(q=quote(q))
            rid = "p" + hashlib.sha1(url.encode()).hexdigest()[:13]
            self.targets[rid] = url
            out.append({"id": rid, "service": s, "label": LABELS[s]})
        return out

    async def query(self, q, service="all"):
        q = " ".join(str(q or "").split())[:120]
        if len(q) < 2:
            return {"q": q, "results": [], "links": [], "errors": {}}
        wanted = [s for s in SERVICES if service in ("all", s)]
        if self.demo:
            rows, errors = [r for r in _demo_rows(q) if r["service"] in wanted], {}
        else:
            runs = {"youtube": self._youtube, "apple": self._apple, "spotify": self._spotify_search}
            rows, errors, todo = [], {}, []
            for s in wanted:
                hit = self._cache.get((s, q.lower()))
                if hit and time.time() - hit[0] < 300:
                    rows += hit[1]
                else:
                    todo.append(s)
            done = await asyncio.gather(*(runs[s](q) for s in todo), return_exceptions=True)
            for s, got in zip(todo, done):
                if isinstance(got, Exception):
                    errors[s] = str(got) or got.__class__.__name__
                    log.info("search %s failed: %s", s, got)
                else:
                    self._cache[(s, q.lower())] = (time.time(), got)
                    rows += got
            while len(self._cache) > 60:
                self._cache.popitem(last=False)
        # a little of each service first, then the rest: the best of every shop on the first screen
        by = {s: [r for r in rows if r["service"] == s] for s in wanted}
        mixed = [r for i in range(12) for s in wanted for r in by[s][i:i + 1]]
        return {"q": q, "results": self._publish(mixed), "links": self.links(q), "errors": errors}

    async def suggest(self, q):
        q = " ".join(str(q or "").split())[:80]
        if len(q) < 2:
            return []
        if self.demo:
            return [f"{q} live", f"{q} remix", f"{q} playlist"]
        try:
            data = await self._json("https://suggestqueries.google.com/complete/search", params={"client": "firefox", "ds": "yt", "q": q})
            return [str(x)[:80] for x in data[1][:8]]
        except Exception:
            return []      # typing help is a nicety: no fuss when it is unavailable

    async def thumb(self, key):
        got = self.thumbs.get(key)
        if got is None:
            return None
        if isinstance(got, tuple):
            return got
        if got.startswith("demo:"):
            from PIL import Image, ImageDraw
            hue = int(hashlib.sha1(got.encode()).hexdigest()[:2], 16)
            img = Image.new("RGB", (320, 180), (40 + hue // 3, 90, 140 - hue // 4))
            ImageDraw.Draw(img).ellipse((120, 50, 200, 130), fill=(235, 240, 245))
            buf = io.BytesIO()
            img.save(buf, "JPEG", quality=80)
            data, ctype = buf.getvalue(), "image/jpeg"
        else:
            s = await self._http()
            async with s.get(got) as r:
                ctype = r.headers.get("Content-Type", "").split(";")[0]
                if r.status != 200 or not ctype.startswith("image/"):
                    return None
                data = await r.content.read(1_500_000)
        self.thumbs[key] = (data, ctype)
        return data, ctype

    def target(self, rid):
        return self.targets.get(str(rid or ""))
