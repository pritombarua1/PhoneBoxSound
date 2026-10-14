"""A public link (and QR code) for what is playing, when there is one.

Where the link comes from:
  * a browser tab (through the extension): the page's own address, tidied (YouTube becomes a short
    youtu.be link, with a second one that starts at the current moment);
  * Spotify, Apple Music and other apps: Windows tells us the title and artist but no address, so the
    song is looked up by name on Spotify (if its keys are set), Apple Music and YouTube. Those are marked
    as "found by name": almost always the same song, not guaranteed;
  * a file on this PC (VLC, MPC-HC, mpv): there is no public link, and none is invented.

Only real public web addresses are ever handed out: https, a proper domain, no addresses of this
network, no login details inside the address.
"""
import ipaddress
import re
from urllib.parse import parse_qs, urlparse, urlunparse

SITES = {"youtube.com": "YouTube", "youtu.be": "YouTube", "music.youtube.com": "YouTube Music", "open.spotify.com": "Spotify", "music.apple.com": "Apple Music",
         "netflix.com": "Netflix", "primevideo.com": "Prime Video", "disneyplus.com": "Disney+", "twitch.tv": "Twitch", "soundcloud.com": "SoundCloud",
         "vimeo.com": "Vimeo", "dailymotion.com": "Dailymotion", "bandcamp.com": "Bandcamp", "tidal.com": "TIDAL", "deezer.com": "Deezer"}
PRIVATE_ENDINGS = (".local", ".lan", ".internal", ".home", ".localhost", ".test", ".intranet", ".corp")
TRACKING = re.compile(r"^(utm_|fbclid$|gclid$|si$|feature$|pp$|ref_?$|igshid$|uo$|trackId$|tctx$)")


def public_url(url):
    """The address if it is safe and sensible to hand to someone else, tidied; otherwise None."""
    try:
        u = urlparse(str(url or "").strip())
        host = (u.hostname or "").lower()
    except ValueError:
        return None
    if u.scheme != "https" or not host or "." not in host or len(url) > 600 or u.username or u.password:
        return None
    if host == "localhost" or host.endswith(PRIVATE_ENDINGS):
        return None
    try:
        ipaddress.ip_address(host)
        return None                       # a bare number is somebody's machine, not a public page
    except ValueError:
        pass
    keep = "&".join(p for p in u.query.split("&") if p and not TRACKING.match(p.split("=")[0]))
    return urlunparse(("https", u.netloc.lower(), u.path, "", keep, ""))


def site_name(url):
    host = (urlparse(url).hostname or "").lower().removeprefix("www.")
    return next((name for dom, name in SITES.items() if host == dom or host.endswith("." + dom)), host)


def youtube_id(url):
    u = urlparse(url)
    host = (u.hostname or "").lower().removeprefix("www.").removeprefix("m.")
    if host == "youtu.be":
        return u.path.strip("/")[:20] or None
    if host in ("youtube.com", "music.youtube.com"):
        if u.path == "/watch":
            return (parse_qs(u.query).get("v") or [None])[0]
        m = re.match(r"^/(?:shorts|live|embed)/([\w-]{6,20})", u.path)
        return m.group(1) if m else None
    return None


def from_page(url, position=0, live=False):
    """Links for a page that is playing in a browser tab."""
    url = public_url(url)
    if not url:
        return []
    vid = youtube_id(url)
    if vid and re.fullmatch(r"[\w-]{6,20}", vid):
        out = [{"label": "YouTube", "url": f"https://youtu.be/{vid}", "exact": True}]
        if position > 15 and not live:
            out.append({"label": "YouTube, from this moment", "url": f"https://youtu.be/{vid}?t={int(position)}", "exact": True})
        return out
    return [{"label": site_name(url), "url": url, "exact": True}]


def _words(text):
    return set(re.findall(r"[a-z0-9]+", re.sub(r"\(.*?\)|\[.*?\]", " ", str(text or "").lower())))


def same_song(title, artist, row):
    """Does this search result look like the song that is playing?"""
    want_t, want_a = _words(title), _words(artist)
    got = _words(row.get("title")) | _words(row.get("sub"))
    if not want_t or not want_t <= got | _words(row.get("title")):
        return False
    return not want_a or len(want_a & got) >= max(1, len(want_a) // 2)


def to_web(url):
    """spotify:track:ID is only understood where Spotify is installed; the web address works for everyone."""
    m = re.fullmatch(r"spotify:(track|album):([A-Za-z0-9]{8,40})", url)
    return f"https://open.spotify.com/{m.group(1)}/{m.group(2)}" if m else url


async def links_for(session, search, prefer=None):
    """[{"label", "url", "exact"}] for a "now playing" entry (see the module text for where they come from)."""
    if not session:
        return []
    direct = from_page(session.get("_link"), float(session.get("position") or 0), not session.get("duration"))
    if direct:
        return direct
    title, artist = str(session.get("title") or "").strip(), str(session.get("artist") or "").strip()
    if session.get("provider") != "smtc" and not session.get("_shareable") or len(title) < 2:
        return []                          # a file on this PC: nothing public to point at
    rows = await search.find(f"{artist} {title}".strip())
    out, seen = [], set()
    order = sorted(rows, key=lambda r: (r["service"] != prefer, ("spotify", "apple", "youtube").index(r["service"])))
    for r in order:
        if r["service"] in seen or not same_song(title, artist, r):
            continue
        url = public_url(to_web(r["url"]))
        if url and youtube_id(url):
            url = f"https://youtu.be/{youtube_id(url)}"
        if url:
            seen.add(r["service"])
            out.append({"label": {"youtube": "YouTube", "spotify": "Spotify", "apple": "Apple Music"}[r["service"]], "url": url, "exact": False})
    return out
