"""Password-protected storage for everything the server remembers (phones, keys, permissions, tokens).

Once a password is set, config.json is replaced by an encrypted vault:

* The contents are sealed with AES-256-GCM under a random data key. Without the key the file is noise,
  and any change to it (one flipped bit, an older copy, a different file) is detected when it is opened.
* The data key is stored wrapped by a key derived from the password (scrypt). The password itself is
  never stored anywhere, so it cannot be shown again, only changed by someone who knows it.
* For unattended starts the data key can also be wrapped by Windows for the logged-in account (DPAPI).
  Turn that off ("ask for the password when the server starts") and nothing on disk opens the vault.
* A separate seal outside the file (Windows registry) remembers which vault belongs here and how far
  it has advanced. A vault that is missing, swapped for another one or rolled back to an older copy
  makes the server refuse to start instead of quietly starting fresh.

What this cannot do: stop someone who is logged in as you on this PC from deleting both the file and
the seal, or from reading the memory of the running server. It protects the data, not the machine.
"""
import base64
import ctypes
import hashlib
import hmac
import json
import os
import secrets
import sys
import threading

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt

MIN_PASSWORD = 8


class VaultError(Exception):
    """The vault can't be trusted or opened; the message says why in plain words."""


class WrongPassword(VaultError):
    pass


def _b64(b):
    return base64.b64encode(b).decode()


def _kdf(password, salt):
    return Scrypt(salt=salt, length=32, n=2 ** 15, r=8, p=1).derive(password.encode("utf-8"))


def _seal_bytes(key, plain, aad):
    nonce = secrets.token_bytes(12)
    return nonce + AESGCM(key).encrypt(nonce, plain, aad)


def _open_bytes(key, blob, aad):
    return AESGCM(key).decrypt(blob[:12], blob[12:], aad)


# ------------------------------------------------------------------ Windows account protection (DPAPI)

class _Blob(ctypes.Structure):
    _fields_ = [("cbData", ctypes.c_uint32), ("pbData", ctypes.POINTER(ctypes.c_char))]


def _dpapi(data, protect):
    if sys.platform != "win32":
        return None
    try:
        crypt32, kernel32 = ctypes.windll.crypt32, ctypes.windll.kernel32
        buf = ctypes.create_string_buffer(data, len(data))
        src, out = _Blob(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char))), _Blob()
        fn = crypt32.CryptProtectData if protect else crypt32.CryptUnprotectData
        if not fn(ctypes.byref(src), None, None, None, None, 0x01, ctypes.byref(out)):  # 0x01: never show UI
            return None
        try:
            return ctypes.string_at(out.pbData, out.cbData)
        finally:
            kernel32.LocalFree(out.pbData)
    except Exception:
        return None


# ------------------------------------------------------------------ the seal kept outside the file

class Seal:
    """A small record stored apart from the vault: its id, the highest serial written, and a password
    check. In the Windows registry by default; in a side file when PHONEBOXSOUND_SEAL=file (tests, other
    systems)."""

    def __init__(self, vault_path):
        self.name = hashlib.sha256(os.path.abspath(vault_path).lower().encode()).hexdigest()[:24]
        self.file = vault_path + ".seal"
        self.registry = sys.platform == "win32" and os.environ.get("PHONEBOXSOUND_SEAL") != "file"

    def read(self):
        try:
            if self.registry:
                import winreg
                with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\PhoneBoxSound\Vaults") as k:
                    return json.loads(winreg.QueryValueEx(k, self.name)[0])
            with open(self.file, encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            return None

    def write(self, record):
        text = json.dumps(record)
        if self.registry:
            import winreg
            with winreg.CreateKey(winreg.HKEY_CURRENT_USER, r"Software\PhoneBoxSound\Vaults") as k:
                winreg.SetValueEx(k, self.name, 0, winreg.REG_SZ, text)
        else:
            with open(self.file, "w", encoding="utf-8") as f:
                f.write(text)

    def delete(self):
        try:
            if self.registry:
                import winreg
                with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\PhoneBoxSound\Vaults", 0, winreg.KEY_SET_VALUE) as k:
                    winreg.DeleteValue(k, self.name)
            else:
                os.remove(self.file)
        except OSError:
            pass


# ------------------------------------------------------------------ the vault

class Vault:
    def __init__(self, path):
        self.path = path
        self.seal = Seal(path)
        self.key = None       # the data key, in memory only while the vault is open
        self.head = None      # the file's header (id, salt, wrapped keys, serial)
        self._lock = threading.Lock()

    @property
    def exists(self):
        return os.path.exists(self.path)

    @property
    def autostart(self):
        return bool(self.head and self.head.get("dpapi"))

    # -- checks before anything is opened

    def inspect(self):
        """Raises VaultError if what is on disk is not the vault that belongs here."""
        seal = self.seal.read()
        if not self.exists:
            if seal:
                raise VaultError("The protected settings file is missing. It was deleted or moved: " + self.path)
            return
        try:
            with open(self.path, encoding="utf-8") as f:
                head = json.load(f)
            assert head.get("v") == 1 and all(k in head for k in ("id", "salt", "pw", "serial", "data"))
        except Exception:
            raise VaultError("The protected settings file is damaged or is not a PhoneBoxSound file: " + self.path) from None
        if seal:
            if seal.get("id") != head["id"]:
                raise VaultError("The protected settings file was replaced by a different one.")
            if int(head["serial"]) < int(seal.get("serial", 0)):
                raise VaultError("The protected settings file was replaced by an older copy of itself.")
        self.head = head

    # -- opening

    def _unseal(self, key):
        head = self.head
        try:
            plain = _open_bytes(key, base64.b64decode(head["data"]), f"{head['id']}:{head['serial']}".encode())
        except (InvalidTag, ValueError):
            raise VaultError("The protected settings file was changed outside PhoneBoxSound and can't be trusted.") from None
        self.key = key
        return json.loads(plain)

    def open_unattended(self):
        """Open with the Windows account's protection. None if the vault insists on the password."""
        if self.head is None:
            self.inspect()
        if not self.head.get("dpapi"):
            return None
        key = _dpapi(base64.b64decode(self.head["dpapi"]), protect=False)
        if not key:
            return None      # another Windows account or another PC: the password is needed
        return self._unseal(key)

    def _key_from_password(self, password):
        head = self.head
        try:
            return _open_bytes(_kdf(password, base64.b64decode(head["salt"])), base64.b64decode(head["pw"]), head["id"].encode())
        except (InvalidTag, ValueError):
            raise WrongPassword("Wrong password") from None

    def open_with_password(self, password):
        if self.head is None:
            self.inspect()
        return self._unseal(self._key_from_password(password))

    def check_password(self, password):
        try:
            return hmac.compare_digest(self._key_from_password(password), self.key or b"")
        except WrongPassword:
            return False

    # -- writing

    def _wrap(self, password, key, autostart):
        salt = secrets.token_bytes(16)
        self.head.update(salt=_b64(salt), pw=_b64(_seal_bytes(_kdf(password, salt), key, self.head["id"].encode())))
        blob = _dpapi(key, protect=True) if autostart else None
        self.head["dpapi"] = _b64(blob) if blob else None
        check_salt = secrets.token_bytes(16)
        self._check = {"salt": _b64(check_salt), "hash": _b64(_kdf(password, check_salt))}

    def create(self, password, data, autostart=True):
        if self.exists or self.seal.read():
            raise VaultError("A protected settings file already exists here.")
        if len(password) < MIN_PASSWORD:
            raise VaultError(f"Use at least {MIN_PASSWORD} characters.")
        self.key = AESGCM.generate_key(256)
        self.head = {"v": 1, "id": secrets.token_hex(16), "serial": 0}
        self._wrap(password, self.key, autostart)
        self.save(data)

    def save(self, data):
        if not self.key:
            raise VaultError("The vault is locked.")
        with self._lock:
            head = self.head
            head["serial"] = int(head["serial"]) + 1
            head["data"] = _b64(_seal_bytes(self.key, json.dumps(data).encode(), f"{head['id']}:{head['serial']}".encode()))
            tmp = self.path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(head, f)
            os.replace(tmp, self.path)
            record = self.seal.read() or {}
            record.update(id=head["id"], serial=head["serial"])
            if getattr(self, "_check", None):
                record["check"], self._check = self._check, None
            self.seal.write(record)

    def change_password(self, current, new, data):
        if not self.check_password(current):
            raise WrongPassword("Wrong password")
        if len(new) < MIN_PASSWORD:
            raise VaultError(f"Use at least {MIN_PASSWORD} characters.")
        self._wrap(new, self.key, self.autostart)
        self.save(data)

    def set_autostart(self, password, on, data):
        if not self.check_password(password):
            raise WrongPassword("Wrong password")
        self._wrap(password, self.key, on)
        self.save(data)
        return self.autostart

    # -- starting over (needs the password even when the file is gone)

    def destroy(self, password):
        seal = self.seal.read()
        ok = False
        if self.exists:
            try:
                self.inspect()
                self._key_from_password(password)
                ok = True
            except VaultError:
                ok = False
        if not ok and seal and seal.get("check"):
            c = seal["check"]
            ok = hmac.compare_digest(_kdf(password, base64.b64decode(c["salt"])), base64.b64decode(c["hash"]))
        if not ok:
            raise WrongPassword("Wrong password")
        for p in (self.path, self.path + ".tmp"):
            try:
                os.remove(p)
            except OSError:
                pass
        self.seal.delete()
        self.key = self.head = None
