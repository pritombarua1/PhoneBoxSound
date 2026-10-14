"""What kind of device a phone says it is: "iPhone · iOS 18.5 · Safari", "Android 15 · Chrome 141 · Pixel 8".

Read from what the browser reports when it connects. It is a description, not proof (a browser can claim
anything), which is why a phone is identified by its key and this is only *linked* to it: if a known
phone suddenly reports a different kind of system, its PC-control permissions are held back until the
change is confirmed on the PC.

Browsers deliberately hide detail: Chrome on Android reports the model as "K", desktop browsers do not
name the Linux distribution unless it is in the browser's own build (Ubuntu, Fedora), and Windows 10
and 11 look the same. Where the browser does not say, neither do we.
"""
import re


def _ver(text, pattern, sep="."):
    m = re.search(pattern, text)
    return m.group(1).replace("_", sep) if m else ""


def family(description):
    """The part that should never change for the same device: iPhone, iPad, Android, Windows, macOS, Linux…"""
    return (description or "").split(" · ")[0].split(" ")[0]


def describe(ua, uad=None, touch=0):
    ua, uad = str(ua or ""), uad if isinstance(uad, dict) else {}
    if not ua:
        return ""
    model = ""
    if "iPhone" in ua:
        os_name = "iPhone · iOS " + _ver(ua, r"iPhone OS (\d+(?:_\d+)*)")
    elif "iPad" in ua or ("Macintosh" in ua and int(touch or 0) > 1):
        os_name = "iPad · iPadOS " + (_ver(ua, r"CPU OS (\d+(?:_\d+)*)") or _ver(ua, r"Version/(\d+(?:\.\d+)?)"))
    elif "Android" in ua:
        os_name = "Android " + _ver(ua, r"Android (\d+(?:\.\d+)*)")
        m = re.search(r"Android [\d.]+; ([^;)]+?)(?: Build/[^;)]*)?[;)]", ua)
        if m and m.group(1).strip() not in ("K", "Mobile", "Tablet", "wv") and not m.group(1).startswith(("rv:", "Mobile")):
            model = m.group(1).strip()[:40]
    elif "Windows NT" in ua:
        nt = _ver(ua, r"Windows NT (\d+\.\d+)")
        os_name = "Windows " + {"10.0": "10/11", "6.3": "8.1", "6.2": "8", "6.1": "7"}.get(nt, nt)
    elif "CrOS" in ua:
        os_name = "ChromeOS"
    elif "Mac OS X" in ua or "Macintosh" in ua:
        os_name = "macOS"      # Safari and Chrome freeze the version they report at 10.15.7
    elif "Linux" in ua or "X11" in ua:
        distro = next((d for d in ("Ubuntu", "Fedora", "Debian", "Arch", "Mint", "openSUSE", "SUSE", "Gentoo", "Manjaro", "Raspbian", "SteamOS", "Tizen", "Web0S") if d.lower() in ua.lower()), "")
        os_name = "Linux" + (f" ({distro})" if distro else "")
    else:
        os_name = str(uad.get("platform") or "Unknown system")
    browser = ""
    for name, pattern in (("Edge", r"Edg(?:e|A|iOS)?/(\d+)"), ("Opera", r"OPR/(\d+)"), ("Samsung Internet", r"SamsungBrowser/(\d+)"),
                          ("Firefox", r"(?:Firefox|FxiOS)/(\d+)"), ("Chrome", r"(?:Chrome|CriOS)/(\d+)"), ("Safari", r"Version/(\d+(?:\.\d+)?).*Safari")):
        v = _ver(ua, pattern)
        if v:
            browser = f"{name} {v}"
            break
    return " · ".join(x for x in (os_name.strip(), browser, model) if x)[:120]
