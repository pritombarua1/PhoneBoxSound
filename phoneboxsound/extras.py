"""Bedtime fade, announcements and doorbell, guest passes, shake-to-lock, and the security digest.

Kept apart from hub.py: each is a small feature on top of things the hub already does (gain, intercom
audio, pairing, lockdown, events).
"""
import asyncio
import logging
import os
import secrets
import subprocess
import tempfile
import time
import types
import wave

import numpy as np

from .audio import KIND_INTERCOM, now_ms, pack

log = logging.getLogger("pbs.extras")

AFTER = ("none", "pause", "lock", "sleep", "shutdown")
RATE = 16000


# ------------------------------------------------------------------ sounds

def chime(kind="ding"):
    """A short, pleasant tone as 16 kHz mono int16. doorbell: two falling notes; ding: one; alert: three rising."""
    notes = {"doorbell": [(659.3, 0.55), (523.3, 0.9)], "ding": [(880.0, 0.7)], "alert": [(587.3, 0.22), (740.0, 0.22), (880.0, 0.5)]}.get(kind)
    if not notes:
        return np.zeros(0, np.int16)
    out = []
    for f, dur in notes:
        t = np.arange(int(RATE * dur)) / RATE
        tone = (np.sin(2 * np.pi * f * t) + 0.35 * np.sin(2 * np.pi * 2 * f * t) + 0.12 * np.sin(2 * np.pi * 3 * f * t)) * np.exp(-t * 4.2)
        tone[:80] *= np.linspace(0, 1, 80)          # no click at the start
        out.append(tone)
    pcm = np.concatenate(out)
    return (pcm / max(1e-9, np.abs(pcm).max()) * 0.62 * 32767).astype(np.int16)


def speak(text):
    """Text to speech with the voice built into Windows. Returns 16 kHz mono int16, or None if unavailable."""
    if os.name != "nt" or not text:
        return None
    path = os.path.join(tempfile.gettempdir(), f"pbs-say-{secrets.token_hex(6)}.wav")
    script = ("Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
              "$f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono); "
              "$s.SetOutputToWaveFile($env:PBS_OUT, $f); $s.Speak($env:PBS_TEXT); $s.Dispose()")
    try:
        # the words travel in an environment variable, never inside the command: nothing typed can become a command
        subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script], timeout=20, check=True, capture_output=True,
                       env={**os.environ, "PBS_TEXT": text, "PBS_OUT": path}, creationflags=0x08000000)
        with wave.open(path, "rb") as w:
            pcm = np.frombuffer(w.readframes(w.getnframes()), np.int16)
        return pcm if len(pcm) else None
    except Exception as e:
        log.info("text to speech unavailable: %s", e)
        return None
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


# ------------------------------------------------------------------ the security digest

DIGEST = (  # (key, label, words that put an event there)
    ("joined", "New phones asked to join", ("wants to join",)),
    ("approved", "Approved", ("was approved",)),
    ("denied", "Denied or blocked", ("was denied", "was blocked")),
    ("refused", "Attempts without permission", ("tried to use", "after repeated attempts", "for flooding", "tried to")),
    ("impersonation", "Failed identity checks", ("failed its security check",)),
    ("password", "Wrong dashboard passwords", ("Wrong dashboard password",)),
    ("system", "Phones reporting a different system", ("now reports to be",)),
    ("lockdown", "Lockdowns", ("Lockdown ON",)),
    ("guest", "Guest passes", ("guest pass", "Guest ")),
    ("changes", "Security settings changed", ("password was", "Start-up:", "storage is now", "confirmed on the PC", "record", "forgot this PC")),
)
LEDGER_KINDS = ("security", "approval", "block", "device", "guest")


class Extras:
    def __init__(self, hub):
        self.hub = hub
        self.fade = 1.0            # multiplies every phone's volume while a bedtime timer runs
        self.bedtime = None        # {"until", "minutes", "after", "task", "by"}
        self.passes = {}           # token -> {"until", "hours", "used"}
        self._seq = 0
        self._announcing = asyncio.Lock()

    # -------------------------------------------------------------- security ledger (30 days, in the settings)

    def remember(self, kind, text):
        if kind not in LEDGER_KINDS:
            return
        cfg = self.hub.cfg
        ledger = cfg.setdefault("security_log", [])
        ledger.append({"t": round(time.time(), 3), "text": text})
        cut = time.time() - 30 * 86400
        if len(ledger) > 600 or ledger[0]["t"] < cut:
            cfg["security_log"] = [e for e in ledger if e["t"] >= cut][-600:]
        cfg.save()

    def digest(self, days=7):
        since = time.time() - days * 86400
        events = [e for e in self.hub.cfg.get("security_log", []) if e["t"] >= since]
        groups = []
        for key, label, words in DIGEST:
            hits = [e for e in events if any(w in e["text"] for w in words)]
            groups.append({"key": key, "label": label, "count": len(hits), "last": hits[-1]["t"] if hits else None})
        rows = self.hub.cfg["devices"]
        return {"days": days, "groups": groups, "events": events[::-1][:300],
                "devices": {"total": len(rows), "verified": sum(1 for d in rows.values() if d.get("pubkey")),
                            "with_pc_control": sum(1 for d in rows.values() if any(d["perms"].get(k) for k in ("input", "clipboard", "screen", "power", "files", "commands"))),
                            "blocked": sum(1 for d in rows.values() if d.get("blocked")), "waiting": sum(1 for d in rows.values() if not d.get("approved", True))},
                "settings": {k: bool(self.hub.cfg[k]) for k in ("strict", "approval", "lockdown")} | {"password": self.hub.cfg.protected}}

    # -------------------------------------------------------------- bedtime fade

    def bedtime_state(self):
        b = self.bedtime
        return {"left_s": max(0, round(b["until"] - time.time())), "minutes": b["minutes"], "after": b["after"], "by": b["by"]} if b else None

    async def bedtime_start(self, minutes, after="pause", by="the PC", may_power=True):
        hub = self.hub
        try:
            minutes = max(0.05, min(float(minutes), 600))
        except (TypeError, ValueError):
            return "Give the number of minutes"
        after = after if after in AFTER else "pause"
        if after in ("lock", "sleep", "shutdown") and not may_power:
            return "This phone may not lock or shut down the PC (Power permission)"
        await self.bedtime_cancel(quiet=True)
        total = minutes * 60

        async def run():
            try:
                start = time.time()
                while time.time() - start < total:
                    left = 1 - (time.time() - start) / total
                    self.fade = max(0.0, left) ** 1.6          # ears hear loudness in ratios: a curve sounds like a steady fade
                    hub.push_config()
                    await asyncio.sleep(min(2.0, max(0.25, total / 120)))
                self.fade = 0.0
                hub.push_config()
                if after != "none":
                    try:
                        await hub.media.command("pause")
                    except Exception as e:
                        log.debug("bedtime pause failed: %s", e)
                await asyncio.sleep(1.2)
                self.bedtime, self.fade = None, 1.0            # tomorrow's music starts at normal volume
                hub.push_config()
                hub.event("bedtime", f"Bedtime: faded out over {minutes:g} min" + ("" if after in ("none", "pause") else f", then {after}"))
                if after in ("lock", "sleep", "shutdown"):
                    await hub.power_request(types.SimpleNamespace(dev={"name": "the bedtime timer"}), after)
                await hub.broadcast_state()
            except asyncio.CancelledError:
                pass

        self.bedtime = {"until": time.time() + total, "minutes": minutes, "after": after, "by": by, "task": asyncio.create_task(run())}
        hub.event("bedtime", f"Bedtime timer started by {by}: {minutes:g} min, then {after}")
        await hub.broadcast_state()
        return None

    async def bedtime_cancel(self, quiet=False):
        b, self.bedtime = self.bedtime, None
        if b:
            b["task"].cancel()
            self.fade = 1.0
            self.hub.push_config()
            if not quiet:
                self.hub.event("bedtime", "Bedtime timer cancelled")
                await self.hub.broadcast_state()

    # -------------------------------------------------------------- announcements / doorbell

    async def announce(self, text="", sound="ding", target="all", by="the PC"):
        """Play a chime and/or spoken text on the phones, over the music (which dips like for the intercom)."""
        hub = self.hub
        text = "".join(ch for ch in str(text or "") if ch.isprintable()).strip()[:300]
        parts = [chime(sound)]
        if text:
            voice = await asyncio.to_thread(speak, text) if hub.input_log is None else None     # tests: no real speech engine
            if voice is not None:
                parts += [np.zeros(RATE // 5, np.int16), voice]
        pcm = np.concatenate(parts + [np.zeros(RATE // 4, np.int16)])
        if len(pcm) <= RATE // 4 and not text:
            return "Nothing to announce"
        spoken = len(parts) > 1
        async with self._announcing:
            key = ("announce", secrets.token_hex(3))
            await hub.set_talking(key, "Announcement", target)
            hub.event("announce", f"Announcement by {by}: " + (f'"{text}"' if text else sound) + ("" if spoken or not text else " (shown as text: no speech engine)"))
            listeners = hub.intercom_targets(target)
            if text:
                for c in listeners:
                    c.send_json({"t": "toast", "msg": f"📣 {text}", "ms": 6000})
            await asyncio.sleep(0.25)                          # let the music dip first
            step, started = RATE // 50, time.perf_counter()
            for i in range(0, len(pcm), step):
                block = pcm[i:i + step].reshape(-1, 1)
                self._seq += 1
                data = pack(KIND_INTERCOM, self._seq, now_ms(), RATE, block, force_payload=True)
                for c in listeners:
                    c.send(data, audio=True)
                for ws in list(hub.controls):
                    asyncio.ensure_future(hub._safe_send_bytes(ws, data))
                wait = started + (i + step) / RATE - time.perf_counter()
                if wait > 0:
                    await asyncio.sleep(wait)
            await asyncio.sleep(0.3)
            await hub.set_talking(key, "Announcement", None)
        return None

    # -------------------------------------------------------------- guest passes

    def guest_pass(self, hours=2.0):
        hours = max(0.25 if self.hub.input_log is None else 0.001, min(float(hours or 2), 24))   # (tests use seconds)
        token = secrets.token_urlsafe(9)
        self.passes[token] = {"until": time.time() + hours * 3600, "hours": hours, "used": 0}
        self.hub.event("guest", f"A guest pass was made: speaker only, {hours:g} h")
        return token

    def guest_ok(self, token):
        p = self.passes.get(str(token or ""))
        return p if p and p["until"] > time.time() else None

    async def sweep(self):
        """Every few seconds: guests whose time is up are disconnected and their record removed."""
        hub, now = self.hub, time.time()
        self.passes = {k: v for k, v in self.passes.items() if v["until"] > now}
        gone = [i for i, d in hub.cfg["devices"].items() if d.get("guest_until") and d["guest_until"] < now]
        for device_id in gone:
            c = hub.online(device_id)
            name = hub.cfg["devices"].pop(device_id)["name"]
            hub.event("guest", f"Guest {name}: time is up, removed")
            if c:
                c.send_json({"t": "kicked", "forget": True, "msg": "The guest pass has ended. Thanks for listening!"}, urgent=True)
                await asyncio.sleep(0.2)
                await c.ws.close()
        if gone:
            hub.cfg.save()
            await hub.broadcast_state()
