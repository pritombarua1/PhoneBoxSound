"""A phone's identity is a key pair that never leaves the phone.

The phone's browser creates an ECDSA P-256 key pair marked non-extractable (even the page's own
script cannot read the private half) and gives the PC only the public half. To connect, the phone must
sign a fresh random challenge. Copying a phone's saved data, or sniffing the network, is therefore not
enough to pretend to be that phone: there is no reusable secret to steal.
"""
import base64
import hashlib

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature


def _b64u(s):
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def clean(pub):
    """Returns {"x", "y"} if `pub` is a well-formed P-256 public key, else None."""
    try:
        x, y = str(pub["x"]), str(pub["y"])
        if len(_b64u(x)) != 32 or len(_b64u(y)) != 32:
            return None
        ec.EllipticCurvePublicNumbers(int.from_bytes(_b64u(x), "big"), int.from_bytes(_b64u(y), "big"), ec.SECP256R1()).public_key()
        return {"x": x, "y": y}
    except Exception:
        return None


def verify(pub, challenge, signature_b64):
    """True if `signature_b64` (raw r||s, as WebCrypto produces) is the phone's signature of `challenge`."""
    try:
        sig = base64.b64decode(signature_b64)
        if len(sig) != 64:
            return False
        key = ec.EllipticCurvePublicNumbers(int.from_bytes(_b64u(pub["x"]), "big"), int.from_bytes(_b64u(pub["y"]), "big"),
                                            ec.SECP256R1()).public_key()
        der = encode_dss_signature(int.from_bytes(sig[:32], "big"), int.from_bytes(sig[32:], "big"))
        key.verify(der, challenge.encode(), ec.ECDSA(hashes.SHA256()))
        return True
    except (InvalidSignature, Exception):
        return False


def code(pub):
    """A 4-digit number derived from the key. The phone and the dashboard both show it, so the person
    at the PC can confirm they are approving the phone in their hand and not someone else's."""
    digest = hashlib.sha256((pub["x"] + "." + pub["y"]).encode()).digest()
    return f"{int.from_bytes(digest[:4], 'big') % 10000:04d}"
