"""A two-day record of everything each phone did and was sent, to the millisecond, in little space.

Format (made for this server; nothing else reads it)
----------------------------------------------------
One file per phone per hour, `<hour>.pbj`, so old hours are dropped by deleting files. A file is a
run of blocks, one per second in which something happened:

    4 bytes length | 1 byte flags | body
    flags bit 0: body is AES-256-GCM encrypted (nonce + ciphertext) with a key derived from the vault's
    body (after decryption): zlib-compressed JSON lines, primed with DICTIONARY below

Each line is one event:

    {"t": 1790000000123, "d": "in", "k": "input", "n": 41, "r": 1, "m": {"kind": "key", "keys": ["ctrl", "s"]}}

    t  PC clock, milliseconds          d  in = from the phone, out = to the phone, sys = noted by the server
    k  message type                    m  the message (secrets removed)
    n  the phone's own running number for what it sent (a missing number = a lost message)
    s  the PC's running number for what it sent to the phone (the phone reports the last one it got)
    r  what the PC did with it: 1 = carried out, 0 = refused ("why" says what was missing)

What keeps it small, without losing an interaction:
  * priming the compressor with the phrases every line shares makes one-second blocks shrink ~8x;
  * pointer movements arrive 60 a second: they are kept individually, as [ms offset, dx, dy] triples
    inside one "moves" line per burst, and handed back as separate events when read;
  * settings sent to a phone are stored as what changed since the last time, not the whole set;
  * "now playing" is stored when it changes, status reports when something in them changes (and at
    least every 10 s), packet counts (sound, pictures, pings) as totals per 10 s;
  * the phone's screen is recorded as the part of the page that changed since the previous picture.
"""
import hashlib
import json
import logging
import os
import re
import secrets
import struct
import time
import zlib

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

log = logging.getLogger("pbs.journal")

KEEP_S = 48 * 3600
SECRET_KEYS = ("token", "code", "sig", "handoff", "file_token", "screen_key", "api_token", "password", "refresh", "access")
BULKY_KEYS = ("svg", "image", "data", "thumb")
SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

# Never change this once files exist: blocks can only be read back with the dictionary they were written with.
DICTIONARY = (
    b'<div class="card"><div class="row"><div class="item"><button class="btn sm"><span class="muted"><svg class="icon " viewBox="0 0 24 24" aria-hidden="true">'
    b'<path d="M</path></svg></button></div></span><input class="input" style="flex: 1 1 0%;"'
    b'"perms":{"speaker":true,"remote":true,"intercom":true,"input":false,"clipboard":false,"screen":false,"power":false,"manage":false,'
    b'"files":false,"commands":false,"host":false,"approve":false},"latency_ms":,"streaming":true,"gain":,"volume":,"muted":false,"channel":"stereo"'
    b',"offset_ms":0,"verified":true,"locked":[],"title":"","artist":"","state":"playing","position":,"duration":,"rate":1'
    b'{"audio_out":[,"ping_in":[,"pong_out":[,"media_out":[,"screen_out":[,"intercom_out":[,"intercom_in":[,"host_in":['
    b',"ahead_ms":,"late":0,"late_recent":0,"resyncs":0,"rtt_ms":,"jitter_ms":,"need_ms":,"hidden":false,"rx":,"rx_gaps":0'
    b',"d":"sys","k":"packets","m":{,"d":"sys","k":"connected","m":{,"d":"sys","k":"disconnected","m":{'
    b',"d":"out","k":"toast","s":,"m":{"msg":","d":"out","k":"media","s":,"m":{,"d":"out","k":"config","s":,"m":{'
    b',"d":"in","k":"stats","n":,"m":{,"d":"in","k":"media","n":,"r":1,"m":{"action":"'
    b',"d":"in","k":"snap","n":,"m":{"p":,"e":,"len":,"sy":0,"mid":"'
    b',"d":"in","k":"ui","n":,"m":{"ev":"tap","x":,"y":,"sy":0,"w":,"h":,"el":"button","label":"'
    b',"d":"in","k":"input","n":,"r":1,"m":{"kind":"click","button":"left"}}\n{"t":17'
    b',"d":"in","k":"input","n":,"r":1,"m":{"kind":"key","keys":["ctrl","'
    b',"d":"in","k":"moves","n":[,"r":1,"m":{"p":[[0,'
)


def scrub(m, depth=0):
    """A copy of a message that is safe and small enough to keep."""
    if isinstance(m, dict):
        out = {}
        for k, v in m.items():
            if k in SECRET_KEYS:
                if v:
                    out[k] = "(hidden)"
            elif k == "mid" and isinstance(v, str):
                out[k] = v          # a piece of the recorded screen: kept whole, or the pictures can't be rebuilt
            elif k in BULKY_KEYS and isinstance(v, str) and len(v) > 200:
                out[k] = f"({len(v)} characters)"
            else:
                out[k] = scrub(v, depth + 1) if depth < 6 else None
        return out
    if isinstance(m, list):
        return [scrub(v, depth + 1) for v in m[:200]] if depth < 6 else None
    if isinstance(m, str) and len(m) > 4000 and depth > 0:
        return m[:4000] + f"… (+{len(m) - 4000})"
    return m


class Journal:
    def __init__(self, folder, cfg=None):
        self.folder = folder
        self.cfg = cfg
        self.lines = {}     # device_id -> [json line, ...] waiting for the next flush
        self.moves = {}     # device_id -> pointer movements not yet written as a line
        self.counts = {}    # device_id -> {kind: [packets, bytes]}
        self._ticks = 0
        self._pruned = 0
        os.makedirs(folder, exist_ok=True)
        self._drop_old_format()

    def _drop_old_format(self):
        for root, _dirs, files in os.walk(self.folder):
            for f in files:
                if f.endswith(".log"):      # the first, wasteful format
                    try:
                        os.remove(os.path.join(root, f))
                    except OSError:
                        pass

    # ------------------------------------------------------------------ writing

    def _key(self):
        vault = getattr(self.cfg, "vault", None)
        return hashlib.sha256(vault.key + b"|journal").digest() if vault is not None and vault.key else None

    @staticmethod
    def _dir_name(device_id):
        device_id = str(device_id)
        return device_id if SAFE_ID.match(device_id) else "x" + hashlib.sha1(device_id.encode()).hexdigest()[:20]

    def _end_moves(self, device_id):
        mv = self.moves.pop(device_id, None)
        if mv:
            rec = {"t": mv["t"], "d": "in", "k": "moves", "m": {"p": mv["p"]}}
            if mv["n"][0] is not None:
                rec["n"] = mv["n"]
            self.lines.setdefault(device_id, []).append(json.dumps(rec, separators=(",", ":")))

    def on(self):
        """The record can be switched off in the dashboard; then nothing at all is written."""
        get = getattr(self.cfg, "get", None)
        return get("activity", True) is not False if get else True

    def write(self, device_id, direction, kind, data=None, t=None, n=None, s=None, r=None, why=None):
        if not device_id or not self.on():
            return
        ms = int((t or time.time()) * 1000)
        try:
            if direction == "in" and kind == "input" and (data or {}).get("kind") == "move" and r in (None, 1):
                mv = self.moves.get(device_id)
                if not mv:
                    mv = self.moves[device_id] = {"t": ms, "p": [], "n": [n, n]}
                mv["p"].append([ms - mv["t"], round(float(data.get("dx", 0)), 1), round(float(data.get("dy", 0)), 1)])
                mv["n"][1] = n
                return
            self._end_moves(device_id)       # keeps everything in the order it happened
            rec = {"t": ms, "d": direction, "k": str(kind)[:40]}
            if n is not None:
                rec["n"] = n
            if s is not None:
                rec["s"] = s
            if r is not None:
                rec["r"] = r
            if why:
                rec["why"] = why
            if data:
                rec["m"] = scrub({k: v for k, v in data.items() if k not in ("t", "n", "s")}) if isinstance(data, dict) else data
            self.lines.setdefault(device_id, []).append(json.dumps(rec, separators=(",", ":"), default=str))
        except Exception as e:      # the record must never take the server down
            log.debug("journal write failed: %s", e)

    def count(self, device_id, kind, nbytes=0):
        if not self.on():
            return
        c = self.counts.setdefault(device_id, {}).setdefault(kind, [0, 0])
        c[0] += 1
        c[1] += nbytes

    def flush(self):
        """Once a second: pack what happened into one block per phone. Every 10 s: the packet totals."""
        self._ticks += 1
        if self._ticks % 10 == 0:
            counts, self.counts = self.counts, {}
            for device_id, kinds in counts.items():
                self.write(device_id, "sys", "packets", kinds)
        for device_id in list(self.moves):
            self._end_moves(device_id)
        pending, self.lines = self.lines, {}
        key = self._key()
        for device_id, lines in pending.items():
            try:
                hour = json.loads(lines[0])["t"] // 3600000
                z = zlib.compressobj(9, zdict=DICTIONARY)
                body = z.compress("\n".join(lines).encode()) + z.flush()
                flags = 0
                if key:
                    nonce = secrets.token_bytes(12)
                    body, flags = nonce + AESGCM(key).encrypt(nonce, body, None), 1
                folder = os.path.join(self.folder, self._dir_name(device_id))
                os.makedirs(folder, exist_ok=True)
                with open(os.path.join(folder, f"{hour}.pbj"), "ab") as f:
                    f.write(struct.pack(">IB", len(body), flags) + body)
            except Exception as e:
                log.debug("journal flush failed: %s", e)
        if time.time() - self._pruned > 600:
            self._pruned = time.time()
            self.prune()

    def prune(self):
        oldest = int((time.time() - KEEP_S) // 3600)
        for name in os.listdir(self.folder):
            folder = os.path.join(self.folder, name)
            if not os.path.isdir(folder):
                continue
            for f in os.listdir(folder):
                try:
                    if int(f.split(".")[0]) < oldest:
                        os.remove(os.path.join(folder, f))
                except (ValueError, OSError):
                    pass
            try:
                if not os.listdir(folder):
                    os.rmdir(folder)
            except OSError:
                pass

    def close(self):
        self._ticks = 9
        self.flush()

    # ------------------------------------------------------------------ reading

    def _hours(self, device_id):
        folder = os.path.join(self.folder, self._dir_name(device_id))
        try:
            return folder, sorted(int(f.split(".")[0]) for f in os.listdir(folder) if f.endswith(".pbj") and f.split(".")[0].isdigit())
        except OSError:
            return folder, []

    @staticmethod
    def _expand(e):
        """A burst of pointer movements, back as the separate events they were."""
        if e.get("k") != "moves":
            return [e]
        pts, n = e["m"]["p"], (e.get("n") or [None])[0]
        return [{"t": e["t"] + p[0], "d": "in", "k": "input", "r": 1, **({"n": n + i} if n is not None else {}),
                 "m": {"kind": "move", "dx": p[1], "dy": p[2]}} for i, p in enumerate(pts)]

    def _blocks(self, path, key):
        try:
            with open(path, "rb") as f:
                raw = f.read()
        except OSError:
            return
        at = 0
        while at + 5 <= len(raw):
            size, flags = struct.unpack_from(">IB", raw, at)
            body, at = raw[at + 5:at + 5 + size], at + 5 + size
            try:
                if flags & 1:
                    if not key:
                        continue
                    body = AESGCM(key).decrypt(body[:12], body[12:], None)
                z = zlib.decompressobj(zdict=DICTIONARY)
                for line in (z.decompress(body) + z.flush()).decode().split("\n"):
                    yield from self._expand(json.loads(line))
            except Exception:
                continue        # a damaged block loses one second, not the file

    def read(self, device_id, t0=0, t1=None, limit=5000, kinds=None, newest=False):
        """Events with t0 <= t < t1 in time order. More than `limit`: the oldest `limit` (or the newest,
        with newest=True) and more=True, so the caller can ask for the next stretch."""
        t1 = t1 or int(time.time() * 1000) + 1000
        self.flush()
        folder, hours = self._hours(device_id)
        hours = [h for h in hours if t0 // 3600000 <= h <= t1 // 3600000]
        key, out, more = self._key(), [], False
        for h in (reversed(hours) if newest else hours):
            chunk = [e for e in self._blocks(os.path.join(folder, f"{h}.pbj"), key)
                     if t0 <= e["t"] < t1 and (not kinds or e["k"] in kinds)]
            out = chunk + out if newest else out + chunk
            if len(out) >= limit:
                more = len(out) > limit or h != (hours[0] if newest else hours[-1])
                out = out[-limit:] if newest else out[:limit]
                break
        return {"events": out, "more": more}

    def summary(self):
        rows = {}
        try:
            names = os.listdir(self.folder)
        except OSError:
            names = []
        for name in names:
            folder, hours = self._hours(name)
            if hours:
                size = sum(os.path.getsize(os.path.join(folder, f"{h}.pbj")) for h in hours)
                rows[name] = {"first": hours[0] * 3600000, "last": (hours[-1] + 1) * 3600000, "bytes": size, "hours": len(hours)}
        return rows

    def clear(self, device_id=None):
        """Erase one phone's record, or (no id) every record."""
        for name in ([self._dir_name(device_id)] if device_id else os.listdir(self.folder)):
            self.lines.pop(device_id or name, None)
            self.moves.pop(device_id or name, None)
            folder, hours = self._hours(name)
            for h in hours:
                try:
                    os.remove(os.path.join(folder, f"{h}.pbj"))
                except OSError:
                    pass

