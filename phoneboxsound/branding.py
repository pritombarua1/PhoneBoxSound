"""The PhoneBoxSound mark and QR codes in the colours of each theme.

The same numbers as web/src/styles/shared.css: a theme is a background hue with a tint, and an accent
hue with a saturation.
"""
import colorsys
import io

import segno

THEMES = {  # name: (background hue, tint %, accent hue, accent saturation %)
    "forest": (150, 16, 148, 52), "midnight": (222, 14, 220, 80), "aurora": (262, 22, 266, 78),
    "sand": (24, 30, 12, 58), "ocean": (205, 30, 204, 82),
}
# the waveform of the logo, on a 64 x 64 grid
WAVE = [(8, 34), (15, 34), (20, 18), (28, 46), (34, 26), (38, 36), (41, 34), (56, 34)]


def _hex(h, s, l):
    r, g, b = colorsys.hls_to_rgb(h / 360, l / 100, s / 100)
    return "#%02x%02x%02x" % (round(r * 255), round(g * 255), round(b * 255))


def colours(theme):
    h, tint, ah, sat = THEMES.get(theme, THEMES["forest"])
    return {"bg": _hex(h, tint, 9), "accent": _hex(ah, sat, 64), "ink": _hex(ah, min(sat + 10, 90), 20)}


def valid(theme):
    return theme if theme in THEMES else "forest"


def _wave_path():
    return "M" + " L".join(f"{x} {y}" for x, y in WAVE)


def icon_svg(theme):
    c = colours(theme)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="{c["bg"]}"/>'
            f'<path d="{_wave_path()}" fill="none" stroke="{c["accent"]}" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/></svg>')


def icon_png(theme, size=192, square=False):
    """`square`: no rounded corners or transparency (home-screen icons: the phone rounds them itself)."""
    from PIL import Image, ImageDraw
    c, big = colours(theme), size * 4
    k = big / 64
    im = Image.new("RGBA", (big, big), c["bg"] if square else (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    if not square:
        d.rounded_rectangle([0, 0, big - 1, big - 1], radius=14 * k, fill=c["bg"])
    pts, w = [(x * k, y * k) for x, y in WAVE], 4.5 * k
    d.line(pts, fill=c["accent"], width=round(w), joint="curve")
    for x, y in pts:      # round ends and corners
        d.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=c["accent"])
    out = io.BytesIO()
    im.resize((size, size), Image.LANCZOS).save(out, "PNG")
    return out.getvalue()


def manifest(theme):
    c = colours(theme)
    q = f"?theme={theme}"
    return {
        "name": "PhoneBoxSound", "short_name": "PhoneBox",
        "description": "Your PC sound. Everywhere. Synced speakers, media remote and intercom.",
        "start_url": "/player", "scope": "/", "display": "standalone", "orientation": "portrait",
        "background_color": c["bg"], "theme_color": c["bg"],
        "icons": [{"src": f"/icon-192.png{q}", "sizes": "192x192", "type": "image/png"},
                  {"src": f"/icon-512.png{q}", "sizes": "512x512", "type": "image/png"},
                  {"src": f"/icon-512.png{q}&square=1", "sizes": "512x512", "type": "image/png", "purpose": "maskable"}],
    }


def _order(cells, n, key):
    """The order in which the dots appear. Four routes; which one a code gets depends on the code itself."""
    route = key % 4
    if route == 0:      # a snake along the rows
        return sorted(cells, key=lambda c: (c[1], c[0] if c[1] % 2 == 0 else -c[0]))
    if route == 1:      # a snake along the columns
        return sorted(cells, key=lambda c: (c[0], c[1] if c[0] % 2 == 0 else -c[1]))
    if route == 2:      # a spiral from the outside in
        mid = (n - 1) / 2
        import math
        return sorted(cells, key=lambda c: (-max(abs(c[0] - mid), abs(c[1] - mid)) // 1, math.atan2(c[1] - mid, c[0] - mid)))
    return sorted(cells, key=lambda c: (c[0] + c[1], c[0] if (c[0] + c[1]) % 2 == 0 else -c[0]))     # diagonals, back and forth


def qr_svg(link, theme="forest", scale=8, border=2, animate=True):
    """A QR code in the theme's dark ink on white, with the logo in the middle.

    Dark-on-white is kept on purpose: cameras need the contrast. The highest error-correction level
    lets the code lose 30% of itself; the logo covers under 6%.

    `animate`: the code draws itself in about four seconds: the white tile, the logo, then the dots one
    after another along a route chosen by the code's own contents. It ends as the plain, scannable code,
    and is plain from the start for people who ask their device for less motion.
    """
    import hashlib
    c = colours(theme)
    rows = [list(r) for r in segno.make(link, error="h", boost_error=False).matrix]
    n = len(rows)
    hole = max(5, round(n * 0.24)) | 1                       # odd, so it sits exactly in the centre
    lo, hi = (n - hole) // 2, (n - hole) // 2 + hole
    size = (n + border * 2) * scale
    cells = [(x, y) for y, row in enumerate(rows) for x, dark in enumerate(row) if dark and not (lo <= y < hi and lo <= x < hi)]
    cells = _order(cells, n, hashlib.sha1(link.encode()).digest()[0])
    start, span = 0.75, 3.3
    delay = (lambda i: f' style="animation-delay:{start + span * i / len(cells):.3f}s"') if animate else (lambda i: "")
    dots = "".join(f'<path class="pq-m"{delay(i)} d="M{(x + border) * scale} {(y + border) * scale}h{scale}v{scale}h-{scale}z"/>'
                   for i, (x, y) in enumerate(cells))
    p, s = (lo + border) * scale, hole * scale
    inset = scale * 0.6
    k = (s - inset * 2) / 64
    style = (f".pq-m{{fill:{c['ink']}}}" if not animate else
             f".pq-m{{fill:{c['ink']};opacity:0;transform-box:fill-box;transform-origin:center;animation:pq-dot .26s ease-out forwards}}"
             "@keyframes pq-dot{from{opacity:0;transform:scale(.15)}to{opacity:1;transform:none}}"
             ".pq-bg{animation:pq-bg .4s ease-out both}@keyframes pq-bg{from{opacity:0}}"
             ".pq-logo{opacity:0;transform-box:fill-box;transform-origin:center;animation:pq-logo .55s .3s cubic-bezier(.2,1.5,.4,1) forwards}"
             "@keyframes pq-logo{from{opacity:0;transform:scale(.3) rotate(-25deg)}to{opacity:1;transform:none}}"
             "@media (prefers-reduced-motion:reduce){.pq-m,.pq-logo,.pq-bg{animation:none;opacity:1}}")
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" width="{size}" height="{size}" shape-rendering="crispEdges">'
            f'<style>{style}</style><rect class="pq-bg" width="{size}" height="{size}" fill="#ffffff"/>{dots}'
            f'<g transform="translate({p + inset} {p + inset}) scale({k})" shape-rendering="geometricPrecision"><g class="pq-logo">'
            f'<rect width="64" height="64" rx="14" fill="{c["bg"]}"/>'
            f'<path d="{_wave_path()}" fill="none" stroke="{c["accent"]}" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/></g></g></svg>')
