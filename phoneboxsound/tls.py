"""Self-signed HTTPS certificate so phones can use the microphone (intercom), wake lock and PWA install.

Browsers only allow those on secure origins. The certificate is generated once and reused;
phones need to accept the warning the first time.
"""
import datetime
import ipaddress
import logging
import os
import ssl

log = logging.getLogger("pbs.tls")


def ensure_cert(folder, ips, hostname="phoneboxsound.local"):
    cert_path = os.path.join(folder, "cert.pem")
    key_path = os.path.join(folder, "key.pem")
    ips_path = os.path.join(folder, "cert-ips.txt")
    wanted = ",".join(sorted(ips))
    try:
        with open(ips_path, encoding="utf-8") as f:
            current = f.read().strip()
    except OSError:
        current = None
    if not (os.path.exists(cert_path) and os.path.exists(key_path) and current == wanted):
        _generate(cert_path, key_path, ips, hostname)
        with open(ips_path, "w", encoding="utf-8") as f:
            f.write(wanted)
    ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
    ctx.load_cert_chain(cert_path, key_path)
    return ctx


def _generate(cert_path, key_path, ips, hostname):
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID

    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "PhoneBoxSound")])
    alt = [x509.DNSName(hostname), x509.DNSName("localhost")]
    alt += [x509.IPAddress(ipaddress.ip_address(ip)) for ip in ips]
    alt.append(x509.IPAddress(ipaddress.ip_address("127.0.0.1")))
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - datetime.timedelta(days=1))
            .not_valid_after(now + datetime.timedelta(days=825))
            .add_extension(x509.SubjectAlternativeName(alt), critical=False)
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .sign(key, hashes.SHA256()))
    with open(key_path, "wb") as f:
        f.write(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                  serialization.NoEncryption()))
    with open(cert_path, "wb") as f:
        f.write(cert.public_bytes(serialization.Encoding.PEM))
    log.info("generated self-signed certificate for %s", ", ".join(ips))


# ---------------------------------------------------------------------------------------------
# A warning-free HTTPS address.
#
# No public certificate authority will sign a certificate for 192.168.x.x or for a .local name, so
# a self-signed one always shows a browser warning. local-ip.sh solves that for local networks: it
# publishes a real, browser-trusted wildcard certificate for *.local-ip.sh, and its DNS answers
# "192-168-0-18.local-ip.sh" with 192.168.0.18. Any phone can then open
#     https://192-168-0-18.local-ip.sh:8080
# with no warning and nothing to install.
#
# Be clear about what this is: the certificate's private key is public (that is how the service
# works), so it removes the warning and unlocks secure-page features (microphone, clipboard, keys),
# but someone on your Wi-Fi who actively intercepts traffic could still read it. Who a phone *is*
# is protected separately, by its own key pair (identity.py). Needs internet for DNS and the download.
# ---------------------------------------------------------------------------------------------
PUBLIC_SUFFIX = ".local-ip.sh"
PUBLIC_CERT_URL = "https://local-ip.sh/server.pem"
PUBLIC_KEY_URL = "https://local-ip.sh/server.key"


def public_host(ip):
    return ip.replace(".", "-") + PUBLIC_SUFFIX


def public_cert_stale(folder):
    """True when the saved trusted certificate is missing or older than a week (time to fetch it again)."""
    import time
    cert_path, key_path = os.path.join(folder, "public-cert.pem"), os.path.join(folder, "public-key.pem")
    return not (os.path.exists(cert_path) and os.path.exists(key_path) and time.time() - os.path.getmtime(cert_path) < 7 * 86400)


def fetch_public_cert(folder, download=True):
    """The shared *.local-ip.sh certificate as an SSLContext, or None. `download=False` uses only the saved
    copy: start-up never waits for the internet; the weekly refresh happens in the background afterwards."""
    import urllib.request
    cert_path, key_path = os.path.join(folder, "public-cert.pem"), os.path.join(folder, "public-key.pem")
    if download and public_cert_stale(folder):
        try:
            for url, path in ((PUBLIC_CERT_URL, cert_path), (PUBLIC_KEY_URL, key_path)):
                with urllib.request.urlopen(url, timeout=8) as r:
                    data = r.read()
                if b"BEGIN" not in data or len(data) > 200_000:
                    raise ValueError("unexpected response")
                with open(path + ".tmp", "wb") as f:
                    f.write(data)
                os.replace(path + ".tmp", path)
            log.info("downloaded the trusted certificate for *%s", PUBLIC_SUFFIX)
        except Exception as e:
            log.info("trusted certificate unavailable (%s)%s", e, "; using the saved copy" if os.path.exists(cert_path) else "")
    if not (os.path.exists(cert_path) and os.path.exists(key_path)):
        return None
    try:
        ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
        ctx.load_cert_chain(cert_path, key_path)
        return ctx
    except Exception as e:
        log.info("trusted certificate unusable: %s", e)
        return None


def make_context(folder, ips, use_public=True, download=True):
    """The server's TLS setup: the trusted certificate for *.local-ip.sh names, the self-signed one for
    everything else (IP addresses, localhost, phoneboxsound.local). Returns (context, public_available)."""
    base = ensure_cert(folder, ips)
    public = fetch_public_cert(folder, download) if use_public else None
    if public:
        def pick(sslobj, server_name, _ctx):
            if server_name and server_name.lower().endswith(PUBLIC_SUFFIX):
                sslobj.context = public
        base.sni_callback = pick
    return base, bool(public)
