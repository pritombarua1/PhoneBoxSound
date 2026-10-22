"""Core logic tests that run without audio hardware: `python -m pytest tests`."""
import time
import os
import asyncio
import json
import types

import numpy as np
import pytest

from phoneboxsound.audio import FLAG_SILENT, HEADER, KIND_PROGRAM, pack
from phoneboxsound.calibrate import analyze, chirp
from phoneboxsound.config import Config
from phoneboxsound.hub import Hub


def test_packet_roundtrip():
    pcm = (np.arange(960, dtype=np.int16).reshape(480, 2))
    data = pack(KIND_PROGRAM, 7, 1234.5, 48000, pcm)
    kind, ch, frames, seq, ts, sr, flags = HEADER.unpack_from(data)
    assert (kind, ch, frames, seq, ts, sr, flags) == (0, 2, 480, 7, 1234.5, 48000, 0)
    assert np.array_equal(np.frombuffer(data[HEADER.size:], np.int16).reshape(480, 2), pcm)


def test_silent_packet_has_no_payload():
    data = pack(KIND_PROGRAM, 1, 0.0, 48000, np.zeros((480, 2), np.int16))
    assert len(data) == HEADER.size
    assert HEADER.unpack_from(data)[6] & FLAG_SILENT


def test_calibration_finds_relative_delays():
    sr = 48000
    rec = np.random.default_rng(1).normal(0, 0.01, sr * 4).astype(np.float32)
    c = chirp(sr).astype(np.float32) * 0.3
    true_delays = {"a": 0.0, "b": 23.0, "c": -11.0}  # ms relative to schedule
    beeps = []
    for i, (dev, d) in enumerate(true_delays.items()):
        at = 500 + i * 800
        start = int((at + d) * sr / 1000)
        rec[start:start + len(c)] += c
        beeps.append({"id": dev, "at_ms": at})
    res = analyze(rec, sr, 0.0, beeps)
    # relative to the median phone ("a")
    for dev, d in true_delays.items():
        assert res[dev]["delay_ms"] == pytest.approx(d, abs=0.5)


def make_hub(tmp_path):
    cfg = Config(str(tmp_path / "config.json"))
    capture = types.SimpleNamespace(status="capturing", error=None, active_device="x", devices=[],
                                    configure=lambda *a: None, restart=lambda: None)
    media = types.SimpleNamespace(on_change=None, overlay=None, active=None, sessions=[], pc=None, announce=lambda: asyncio.sleep(0), poll=lambda: asyncio.sleep(0),
                                  public=lambda: {"active": None, "sessions": [], "pc": None},
                                  volume=types.SimpleNamespace(set=lambda **k: None, default_device_id=lambda: None))
    return Hub(cfg, capture, media, {"http": 8080, "https": None})


def test_pairing_token_and_lockout(tmp_path):
    hub = make_hub(tmp_path)
    dev, token, err = hub.authenticate({"device_id": "d1", "code": hub.code}, "10.0.0.5")
    assert err is None and token
    # reconnect with the token, no code needed
    assert hub.authenticate({"device_id": "d1", "token": token}, "10.0.0.5") == ("d1", None, None)
    # a wrong token doesn't get in
    assert hub.authenticate({"device_id": "d1", "token": "nope"}, "10.0.0.5")[2] == "pair"
    # 5 wrong codes lock the address out
    wrong = "0000" if hub.code != "0000" else "1111"
    for _ in range(5):
        assert hub.authenticate({"device_id": "x", "code": wrong}, "10.0.0.9")[2] == "Wrong code"
    assert "Too many" in hub.authenticate({"device_id": "x", "code": hub.code}, "10.0.0.9")[2]
    # other addresses are unaffected
    assert hub.authenticate({"device_id": "y", "code": hub.code}, "10.0.0.10")[2] is None


def test_same_phone_on_other_origin_keeps_settings(tmp_path):
    hub = make_hub(tmp_path)
    old = hub.cfg.device("old")
    old.update(name="Kitchen", channel="left", offset_ms=40, platform="iPhone", last_ip="10.0.0.6", token_hash="h")
    hub.authenticate({"device_id": "new", "code": hub.code}, "10.0.0.6")
    assert hub.adopt_previous("new", "10.0.0.6", "iPhone")
    new = hub.cfg["devices"]["new"]
    assert (new["name"], new["channel"], new["offset_ms"]) == ("Kitchen", "left", 40)
    assert "old" not in hub.cfg["devices"]


def test_auto_latency_raises_then_lowers(tmp_path):
    hub = make_hub(tmp_path)
    hub.cfg["latency_ms"] = 100
    c = types.SimpleNamespace(dev=hub.cfg.device("p"), stats={"need_ms": 180, "played": 1000}, send_json=lambda *a, **k: None)
    c.perms = c.dev["perms"]
    hub.clients = {"p": c}
    hub.push_config = lambda *a: None
    asyncio.run(hub.auto_latency_tick())
    assert hub.cfg["latency_ms"] == 210  # need + 25 margin, rounded up to 10
    c.stats["need_ms"] = 60
    hub.latency_changed_at = 0
    asyncio.run(hub.auto_latency_tick())
    assert hub.cfg["latency_ms"] == 200  # lowers gently, 10 ms at a time


def test_pretty_title():
    from phoneboxsound.players import pretty_title
    assert pretty_title("[MLWBD.COM] Avengers.Inf1n1ty.W@r.2018.2160p.10b1t.mkv") == "Avengers Inf1n1ty W@r (2018)"
    assert pretty_title("MLWBD.COM] Avengers.Inf1n1ty.W@r.2018.2160p.10b1t.mkv") == "Avengers Inf1n1ty W@r (2018)"
    assert pretty_title("The_Matrix_1080p_BluRay.mp4") == "The Matrix"
    assert pretty_title("song.mp3") == "song"


def test_mpc_jump_plan():
    from phoneboxsound.players import MpcProvider
    p = MpcProvider(lambda: {})
    assert p._jump_plan(10, (1, 5, 20)) == ["fwd_m", "fwd_m"]
    assert p._jump_plan(-30, (1, 5, 20)) == ["back_l", "back_m", "back_m"]
    assert p._jump_plan(6, (1, 5, 20)) == ["fwd_m", "fwd_s"]


def test_now_playing_follows_what_you_started(monkeypatch):
    import sys
    sys.coinit_flags = 0
    from phoneboxsound import players
    from phoneboxsound.media import MediaEngine
    monkeypatch.setattr(players, "audio_active", lambda: {})
    m = MediaEngine({})

    def s(sid, app, status, title="t"):
        return {"id": sid, "app": app, "status": status, "title": title, "position": 0, "duration": 0, "provider": "x", "kind": "x"}

    def step(found, now):
        asyncio.run(m._observe(found, now))
        m.sessions = found
        return m._pick()["id"]

    assert step([s("ff", "Firefox", "playing"), s("mpc", "MPC-HC", "paused")], 100) == "ff"
    assert step([s("ff", "Firefox", "playing"), s("mpc", "MPC-HC", "playing")], 110) == "mpc"      # started later wins
    assert step([s("ff", "Firefox", "playing", "next video"), s("mpc", "MPC-HC", "playing")], 120) == "ff"  # new track
    assert step([s("ff", "Firefox", "paused", "next video"), s("mpc", "MPC-HC", "playing")], 130) == "mpc"   # paused one loses
    assert step([s("ff", "Firefox", "paused", "next video"), s("mpc", "MPC-HC", "paused")], 135) == "mpc"    # stays on last
    m.target_id, m._pinned_at = "ff", 136
    assert step([s("ff", "Firefox", "paused", "next video"), s("mpc", "MPC-HC", "paused")], 137) == "ff"     # pin holds
    assert step([s("ff", "Firefox", "paused", "next video"), s("mpc", "MPC-HC", "playing")], 140) == "mpc"   # pin lets go
    assert m.target_id is None


def test_slow_phone_gets_fresh_audio_and_commands_first():
    """A phone that falls behind keeps the newest audio (old packets could only arrive too late),
    and commands always go out before audio."""
    from phoneboxsound.hub import AUDIO_QUEUE, Client

    sent = []

    class FakeWs:
        async def send_bytes(self, b):
            sent.append(b)

        async def send_str(self, s):
            sent.append(s)

    async def run():
        c = Client(FakeWs(), "d", {"perms": {}, "speaker": True}, "10.0.0.2", False)
        for i in range(AUDIO_QUEUE + 20):
            c.send(i.to_bytes(4, "little"), audio=True)
        c.send_frame(b"frame-old")
        c.send_frame(b"frame-new")
        c.send_json({"t": "config"})
        await asyncio.sleep(0.05)
        c.sender.cancel()
        return c

    c = asyncio.run(run())
    assert c.audio_drops == 20
    assert json.loads(sent[0])["t"] == "config"                                # command first
    audio = [int.from_bytes(b, "little") for b in sent[1:-1]]
    assert audio == list(range(20, AUDIO_QUEUE + 20))                  # newest audio, in order, nothing duplicated
    assert sent[-1] == b"frame-new"                                    # only the latest screen frame, last


def test_typed_text_is_complete():
    """Long messages, new lines and emoji all survive (this used to be cut at 200 characters)."""
    from phoneboxsound.inputctl import text_units
    msg = "x" * 700 + "\nsecond line\t😀 done"
    units = text_units(msg)
    assert sum(1 for k, _ in units if k == "unit") == 700 + len("second line") + 2 + len(" done")   # the emoji is 2 UTF-16 units
    assert [v for k, v in units if k == "key"] == ["enter", "tab"]
    rebuilt = b"".join(v.to_bytes(2, "little") for k, v in units if k == "unit").decode("utf-16-le")
    assert rebuilt == "x" * 700 + "second line" + "😀 done"


def _phone_key():
    """A key pair like a phone's browser makes, and a signer producing WebCrypto-style raw signatures."""
    import base64
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
    key = ec.generate_private_key(ec.SECP256R1())
    n = key.public_key().public_numbers()
    b64u = lambda i: base64.urlsafe_b64encode(i.to_bytes(32, "big")).rstrip(b"=").decode()

    def sign(challenge):
        r, s = decode_dss_signature(key.sign(challenge.encode(), ec.ECDSA(hashes.SHA256())))
        return base64.b64encode(r.to_bytes(32, "big") + s.to_bytes(32, "big")).decode()
    return {"x": b64u(n.x), "y": b64u(n.y)}, sign


def test_only_the_phones_own_key_passes_the_challenge():
    from phoneboxsound import identity
    pub, sign = _phone_key()
    other_pub, other_sign = _phone_key()
    assert identity.clean(pub) == pub and identity.clean({"x": "abc", "y": "def"}) is None
    assert identity.verify(pub, "nonce-1", sign("nonce-1"))
    assert not identity.verify(pub, "nonce-1", other_sign("nonce-1"))     # another phone's key
    assert not identity.verify(pub, "nonce-2", sign("nonce-1"))           # a replayed old signature
    assert not identity.verify(pub, "nonce-1", "not-a-signature")
    assert len(identity.code(pub)) == 4 and identity.code(pub).isdigit() and identity.code(pub) == identity.code(dict(pub))
    # (two different keys nearly always show different numbers; "nearly" is 1 in 10,000, so that is not asserted here)


def test_strict_mode_withholds_pc_control_from_unverified_phones():
    from phoneboxsound.hub import Client

    class FakeWs:
        async def send_bytes(self, b):
            pass

        async def send_str(self, s):
            pass

    async def run():
        dev = {"perms": {"speaker": True, "remote": True, "intercom": True, "input": True, "clipboard": True, "power": True}, "speaker": True}
        plain = Client(FakeWs(), "d", dev, "10.0.0.2", False, {"strict": True}, verified=False)
        proved = Client(FakeWs(), "d", dev, "10.0.0.2", True, {"strict": True}, verified=True)
        relaxed = Client(FakeWs(), "d", dev, "10.0.0.2", False, {"strict": False}, verified=False)
        out = (dict(plain.perms), plain.locked(), dict(proved.perms), proved.locked(), dict(relaxed.perms))
        for c in (plain, proved, relaxed):
            c.sender.cancel()
        return out

    plain, locked, proved, proved_locked, relaxed = asyncio.run(run())
    assert plain["speaker"] and plain["remote"] and not plain["input"] and not plain["clipboard"] and not plain["power"]
    assert sorted(locked) == ["clipboard", "input", "power"]
    assert proved["input"] and proved["power"] and proved_locked == []
    assert relaxed["input"]                                                # strict off: as before


def test_intercom_never_returns_to_the_phone_that_is_talking(tmp_path):
    from phoneboxsound.audio import KIND_INTERCOM

    class Phone:
        def __init__(self, device_id, zone="Main"):
            self.device_id, self.dev, self.got = device_id, {"zone": zone}, []

        def send(self, data, audio=False):
            self.got.append(data)

    hub = make_hub(tmp_path)
    a, a_other_tab, b, c = Phone("A"), Phone("A"), Phone("B"), Phone("C", "Bedroom")
    hub.clients = {1: a, 2: a_other_tab, 3: b, 4: c}
    hub.talkers["k"] = {"name": "A", "target": "all", "device_id": "A", "since": 0}
    voice = HEADER.pack(KIND_INTERCOM, 1, 4, 0, 0.0, 16000, 0) + b"\0" * 8
    hub.on_intercom_audio("k", voice)
    assert not a.got and not a_other_tab.got          # the talker hears nothing of their own voice
    assert b.got == [voice] and c.got == [voice]      # everyone else does
    hub.talkers["k"]["target"] = "device:A"           # even when aimed at themselves
    hub.on_intercom_audio("k", voice)
    assert not a.got and len(b.got) == 1


def test_lockdown_and_missing_permissions_are_enforced_by_the_server(tmp_path):
    from phoneboxsound.hub import Client

    class FakeWs:
        closed = False

        async def send_bytes(self, b):
            pass

        async def send_str(self, s):
            pass

        async def close(self):
            self.closed = True

    async def run():
        hub = make_hub(tmp_path)
        hub.cfg["strict"] = True
        hub.input_log = []                                   # record instead of touching the real mouse
        dev = hub.cfg.device("A")
        dev["perms"].update({"input": True, "power": True})
        full = Client(FakeWs(), "A", dev, "10.0.0.2", True, hub.cfg, verified=True)
        guest = Client(FakeWs(), "B", hub.cfg.device("B"), "10.0.0.3", True, hub.cfg, verified=True)
        hub.clients = {full.id: full, guest.id: guest}
        source = hub.cfg["source"]

        await hub.handle_phone(full, {"t": "input", "kind": "key", "keys": ["a"]})
        assert len(hub.input_log) == 1                       # allowed while it holds the permission

        # a hand-written message from a phone without the permission does nothing, whatever it claims
        await hub.handle_phone(guest, {"t": "input", "kind": "key", "keys": ["win", "r"], "perms": {"input": True}, "verified": True})
        await hub.handle_phone(guest, {"t": "click_test"})
        await hub.handle_phone(guest, {"t": "manage", "cmd": {"t": "set_device", "device_id": "B", "patch": {"perms": {"input": True}}}})
        assert len(hub.input_log) == 1 and hub.cfg["source"] == source and not guest.dev["perms"]["input"]

        # lockdown: even the verified, fully authorised phone is cut off, and nobody new can pair
        hub.cfg["lockdown"] = True
        await hub.handle_phone(full, {"t": "input", "kind": "key", "keys": ["b"]})
        assert len(hub.input_log) == 1 and not full.perms["input"] and full.perms["speaker"]
        assert "input" in full.locked() and "power" in full.locked()
        assert hub.authenticate({"code": hub.code}, "10.0.0.9")[2].startswith("This PC is in lockdown")
        hub.cfg["lockdown"] = False

        # someone hammering at closed doors is disconnected
        for _ in range(20):
            await hub.handle_phone(guest, {"t": "power", "action": "shutdown"})
        await asyncio.sleep(0)
        assert guest.ws.closed and hub.power_pending is None
        for c in (full, guest):
            c.sender.cancel()

    asyncio.run(run())


def test_rename_reaches_everyone(tmp_path):
    async def run():
        hub = make_hub(tmp_path)
        hub.cfg.device("A")["name"] = "Phone"
        hub.talkers["k"] = {"name": "Phone", "target": "all", "device_id": "A", "since": 0}
        await hub.handle_control({"t": "set_device", "device_id": "A", "patch": {"name": "  Bed\x00side \n"}})
        assert hub.cfg["devices"]["A"]["name"] == "Bedside" and hub.talkers["k"]["name"] == "Bedside"
        await hub.rename("A", "x" * 80)
        assert len(hub.cfg["devices"]["A"]["name"]) == 32

    asyncio.run(run())


def test_room_code_never_takes_over_a_paired_phone(tmp_path):
    hub = make_hub(tmp_path)
    victim, token, _ = hub.authenticate({"code": hub.code}, "10.0.0.2")
    hub.cfg["devices"][victim]["perms"]["input"] = True
    # someone who knows the code *and* the victim's device id, but not its token
    hello = {"code": hub.code, "device_id": victim}
    got, new_token, err = hub.authenticate(hello, "10.0.0.66")
    assert err is None and got != victim and new_token and hello["_code"]
    assert not hub.cfg["devices"][got]["perms"]["input"]
    assert hub.authenticate({"device_id": victim, "token": token}, "10.0.0.2")[0] == victim    # the real one still works
    # a client can't talk its way past approval by sending the server's own marker
    sneaky = {"device_id": victim, "token": token, "_code": False}
    hub.authenticate(sneaky, "10.0.0.2")
    assert "_code" not in sneaky


def test_vault_keeps_data_secret_and_notices_tampering(tmp_path, monkeypatch):
    import json as js
    import shutil
    from phoneboxsound.vault import Vault, VaultError, WrongPassword
    monkeypatch.setenv("PHONEBOXSOUND_SEAL", "file")
    path = str(tmp_path / "config.vault")
    secret = {"devices": {"abc": {"name": "Bedroom iPhone", "token_hash": "t0ken"}}, "api_token": "s3cret"}

    v = Vault(path)
    v.inspect()                                              # nothing there yet: fine, first run
    with pytest.raises(VaultError):
        v.create("short", secret)
    v.create("correct horse 42", secret, autostart=False)
    raw = open(path, encoding="utf-8").read()
    assert "Bedroom" not in raw and "s3cret" not in raw and "correct horse" not in raw

    again = Vault(path)
    again.inspect()
    assert again.open_unattended() is None                   # "ask at start": nothing on disk opens it
    with pytest.raises(WrongPassword):
        again.open_with_password("wrong password")
    assert again.open_with_password("correct horse 42") == secret

    # an older copy put back in place
    shutil.copy(path, path + ".old")
    again.save({**secret, "lockdown": True})
    shutil.copy(path + ".old", path)
    with pytest.raises(VaultError, match="older copy"):
        Vault(path).inspect()
    again.save({**secret, "lockdown": True})

    # one changed character inside the encrypted part
    head = js.load(open(path, encoding="utf-8"))
    good = dict(head)
    head["data"] = head["data"][:40] + ("A" if head["data"][40] != "A" else "B") + head["data"][41:]
    js.dump(head, open(path, "w", encoding="utf-8"))
    with pytest.raises(VaultError, match="changed outside"):
        Vault(path).open_with_password("correct horse 42")
    js.dump(good, open(path, "w", encoding="utf-8"))

    # somebody else's vault dropped in its place, then the file deleted
    other = Vault(str(tmp_path / "other.vault"))
    other.create("attacker password", {"devices": {}})
    shutil.copy(other.path, path)
    with pytest.raises(VaultError, match="replaced by a different"):
        Vault(path).inspect()
    os.remove(path)
    with pytest.raises(VaultError, match="missing"):
        Vault(path).inspect()

    # starting over needs the password even though the file is gone
    with pytest.raises(WrongPassword):
        Vault(path).destroy("guess")
    Vault(path).destroy("correct horse 42")
    Vault(path).inspect()


def test_vault_password_change_and_windows_unlock(tmp_path, monkeypatch):
    from phoneboxsound.vault import Vault, WrongPassword
    monkeypatch.setenv("PHONEBOXSOUND_SEAL", "file")
    path = str(tmp_path / "config.vault")
    v = Vault(path)
    v.create("first password", {"a": 1}, autostart=True)
    if os.name == "nt":
        assert Vault(path).open_unattended() == {"a": 1}    # this Windows account can start the server
    with pytest.raises(WrongPassword):
        v.change_password("not it", "second password", {"a": 1})
    v.change_password("first password", "second password", {"a": 2})
    with pytest.raises(WrongPassword):
        Vault(path).open_with_password("first password")
    assert Vault(path).open_with_password("second password") == {"a": 2}
    assert v.set_autostart("second password", False, {"a": 2}) is False
    assert Vault(path).open_unattended() is None


def test_journal_is_compact_exact_and_forgets_after_two_days(tmp_path, monkeypatch):
    from phoneboxsound import journal as J
    cfg = types.SimpleNamespace(vault=None)
    j = J.Journal(str(tmp_path / "journal"), cfg)
    t = float(int(time.time()) // 3600 * 3600 - 3600)       # the start of the previous hour
    j.write("abc", "in", "hello", {"token": "s3cret-token", "code": "1234", "name": "Bed", "image": "x" * 5000}, t=t)
    for i in range(120):                                             # two seconds of pointer movement, 60 a second
        j.write("abc", "in", "input", {"kind": "move", "dx": i * 0.5, "dy": -1}, t=t + 1 + i / 60, n=10 + i, r=1)
    j.write("abc", "in", "input", {"kind": "key", "keys": ["ctrl", "s"]}, t=t + 3.2, n=130, r=1)
    j.write("abc", "in", "power", {"action": "shutdown"}, t=t + 3.3, n=131, r=0, why="no permission for power control")
    j.write("abc", "out", "toast", {"msg": "hi"}, t=t + 3.4, s=7)
    for _ in range(100):
        j.count("abc", "audio_out", 1924)
    j.close()
    got = j.read("abc", t1=int(t * 1000) + 10_000_000)["events"]
    moves = [e for e in got if e["k"] == "input" and e["m"]["kind"] == "move"]
    assert len(moves) == 120 and moves[5]["m"] == {"kind": "move", "dx": 2.5, "dy": -1.0} and moves[5]["n"] == 15       # every movement, exactly
    assert moves[60]["t"] - moves[0]["t"] == 1000                                                                     # to the millisecond
    assert [e["k"] for e in got if e["k"] != "input"] == ["hello", "power", "toast", "packets"]
    key = next(e for e in got if e["k"] == "input" and e["m"]["kind"] == "key")
    assert key["m"]["keys"] == ["ctrl", "s"] and key["r"] == 1 and key["n"] == 130
    refused = next(e for e in got if e["k"] == "power")
    assert refused["r"] == 0 and "permission" in refused["why"]
    assert next(e for e in got if e["k"] == "toast")["s"] == 7
    assert got[0]["m"]["token"] == "(hidden)" and got[0]["m"]["code"] == "(hidden)" and "5000 characters" in got[0]["m"]["image"]
    assert got[-1]["m"]["audio_out"] == [100, 192400]
    size = sum(os.path.getsize(os.path.join(root, f)) for root, _, fs in os.walk(tmp_path / "journal") for f in fs)
    assert size < 1500, size                                         # 125 events in well under 1.5 kB
    assert j.read("../../etc")["events"] == []                       # ids never become paths

    # with a password set, what is on disk is unreadable without the vault's key
    cfg.vault = types.SimpleNamespace(key=b"k" * 32)
    j.write("abc", "in", "input", {"kind": "text", "text": "my bank password"}, t=t + 5, r=1)
    j.close()
    raw = b"".join(open(os.path.join(root, f), "rb").read() for root, _, fs in os.walk(tmp_path / "journal") for f in fs)
    assert b"my bank password" not in raw and j.read("abc", t1=int(t * 1000) + 10_000_000)["events"][-1]["m"]["text"] == "my bank password"
    cfg.vault = None
    assert all(e["m"].get("kind") != "text" for e in j.read("abc", t1=int(t * 1000) + 10_000_000)["events"] if e["k"] == "input")

    # anything older than two days is dropped
    monkeypatch.setattr(J.time, "time", lambda: t + 3 * 86400)
    j.prune()
    assert j.read("abc", t1=int(t * 1000) + 10_000_000)["events"] == [] and j.summary() == {}


def test_system_is_read_from_the_browser_and_a_change_holds_back_pc_control(tmp_path):
    from phoneboxsound import system
    iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1"
    windows = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0"
    assert system.describe(iphone) == "iPhone · iOS 18.5 · Safari 18.5"
    assert system.describe("Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UQ1A) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36") == "Android 14 · Chrome 141 · Pixel 8"
    assert system.describe("Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0") == "Linux (Ubuntu) · Firefox 143"
    assert system.describe(windows) == "Windows 10/11 · Firefox 143" and system.family(system.describe(windows)) == "Windows"

    class FakeWs:
        closed = False

        async def send_bytes(self, b):
            pass

        async def send_str(self, s):
            pass

        async def send_json(self, o):
            pass

        async def close(self):
            self.closed = True

    async def run():
        hub = make_hub(tmp_path)
        hub.cfg["approval"] = False
        c, err = await hub.join(FakeWs(), {"code": hub.code, "name": "Bed", "ua": iphone, "platform": "iPhone"}, "10.0.0.2", True)
        assert err is None and c.dev["system"].startswith("iPhone")
        c.dev["perms"]["input"] = True
        c.verified = True
        assert c.perms["input"]
        token = json.loads(c.outbox[0])["token"]
        await hub.leave(c)
        # an iOS update is the same phone; an "iPhone" that is suddenly a Windows PC is not
        c2, _ = await hub.join(FakeWs(), {"device_id": c.device_id, "token": token, "ua": iphone.replace("18_5", "19_0")}, "10.0.0.2", True)
        c2.verified = True
        assert c2.perms["input"] and not c2.dev["system_was"]
        await hub.leave(c2)
        c3, _ = await hub.join(FakeWs(), {"device_id": c.device_id, "token": token, "ua": windows}, "10.0.0.9", True)
        c3.verified = True
        assert not c3.perms["input"] and c3.perms["speaker"] and "input" in c3.locked() and c3.dev["system_was"].startswith("iPhone")
        await hub.handle_control({"t": "confirm_system", "device_id": c.device_id})
        assert c3.perms["input"]
        for x in (c, c2, c3):
            x.sender.cancel()

    asyncio.run(run())


def test_branding_follows_the_theme():
    from phoneboxsound import branding
    ocean, sand = branding.colours("ocean"), branding.colours("sand")
    assert ocean != sand and branding.colours("no-such-theme") == branding.colours("forest")
    assert ocean["accent"] in branding.icon_svg("ocean") and branding.icon_png("sand", 64)[:8] == b"\x89PNG\r\n\x1a\n"
    assert "theme=ocean" in branding.manifest("ocean")["icons"][0]["src"]
    svg = branding.qr_svg("https://192-168-0-18.local-ip.sh:8080/?code=1234", "ocean")
    assert ocean["ink"] in svg and ocean["accent"] in svg and "animation-delay" in svg and "prefers-reduced-motion" in svg
    delays = [float(d) for d in __import__("re").findall(r"animation-delay:([\d.]+)s", svg)]
    assert len(delays) > 300 and delays == sorted(delays) and 3.5 < delays[-1] < 4.2          # the dots arrive one after another, done in about 4 s
    other = branding.qr_svg("https://192-168-0-18.local-ip.sh:8080/?code=9999", "ocean")
    first = lambda v: __import__("re").findall(r'd="(M\d+ \d+)h', v)[:12]
    assert first(svg) != first(other)                                                        # each code draws itself its own way
    assert "animation" not in branding.qr_svg("x", "ocean", animate=False)


def test_autostart_command_needs_no_working_folder():
    from phoneboxsound import autostart
    cmd = autostart.command()
    assert "phoneboxsound" in cmd and "--autostart" in cmd and cmd.startswith('"')


def test_themed_qr_with_the_logo_still_scans():
    cv2 = pytest.importorskip("cv2")
    import re
    from phoneboxsound import branding
    for theme in branding.THEMES:
        for link in ("http://192.168.0.18:8080/?code=1234", "https://192-168-0-18.local-ip.sh:8080/?code=1234",
                     "https://192-168-100-118.local-ip.sh:18080/?code=1234&handoff=abcdefghijklmnopqrstuv"):
            svg = branding.qr_svg(link, theme, scale=8)
            size = int(re.search(r'width="(\d+)"', svg).group(1))
            ink = tuple(int(branding.colours(theme)["ink"][i:i + 2], 16) for i in (5, 3, 1))      # BGR
            bg = tuple(int(branding.colours(theme)["bg"][i:i + 2], 16) for i in (5, 3, 1))
            img = np.full((size, size, 3), 255, np.uint8)
            for x, y, w, h in re.findall(r"M(\d+) (\d+)h(\d+)v(\d+)", svg):                       # the dark modules
                img[int(y):int(y) + int(h), int(x):int(x) + int(w)] = ink
            tx, ty, k = map(float, re.search(r"translate\(([\d.]+) ([\d.]+)\) scale\(([\d.]+)\)", svg).groups())
            img[round(ty):round(ty + 64 * k), round(tx):round(tx + 64 * k)] = bg                   # the logo's tile
            text, _, _ = cv2.QRCodeDetector().detectAndDecode(cv2.resize(img, None, fx=2, fy=2, interpolation=cv2.INTER_NEAREST))
            assert text == link, (theme, link)


def test_removing_a_blocked_phone_frees_its_address(tmp_path):
    async def run():
        hub = make_hub(tmp_path)
        dev = hub.cfg.device("A")
        dev.update(name="My phone", last_ip="10.0.0.5", token_hash="x")
        await hub.handle_control({"t": "block", "device_id": "A", "on": True})
        assert hub.cfg["blocked_ips"] == ["10.0.0.5"] and hub.authenticate({"code": hub.code}, "10.0.0.5")[2] == "blocked"
        await hub.handle_control({"t": "forget", "device_id": "A"})
        assert hub.cfg["blocked_ips"] == [] and hub.authenticate({"code": hub.code}, "10.0.0.5")[2] is None      # it can pair again
        assert any("My phone" in e["text"] and "removed" in e["text"] for e in hub.cfg["security_log"])            # and the removal stays on record
        # an address left blocked by an older version can be seen and lifted
        hub.cfg["blocked_ips"] = ["10.0.0.9"]
        assert hub.orphan_blocks() == ["10.0.0.9"]
        await hub.handle_control({"t": "unblock_ip", "ip": "10.0.0.9"})
        assert hub.cfg["blocked_ips"] == []

    asyncio.run(run())


def test_extension_packages_hold_no_secret_and_fit_each_browser():
    import zipfile
    import io
    from phoneboxsound import extpack
    folder = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "extension")
    chrome, firefox = extpack.files(folder, "chrome", 8123), extpack.files(folder, "firefox", 8123)
    mc, mf = json.loads(chrome["manifest.json"]), json.loads(firefox["manifest.json"])
    assert mc["background"] == {"service_worker": "background.js"} and "browser_specific_settings" not in mc
    assert mf["background"] == {"scripts": ["config.js", "background.js"]} and mf["browser_specific_settings"]["gecko"]["id"]
    assert mc["manifest_version"] == 3 and "connect-src ws://127.0.0.1:*" in mc["content_security_policy"]["extension_pages"]
    assert "externally_connectable" not in mc and set(mc["permissions"]) == {"storage", "tabs"}
    assert b"8123" in chrome["config.js"] and b"token" not in chrome["config.js"]
    for name in ("background.js", "content.js", "options.js"):           # nothing that could run what it is sent
        code = chrome[name].decode()
        assert "eval(" not in code and "new Function" not in code and "innerHTML" not in code and "http://" not in code and "https://" not in code
    names = zipfile.ZipFile(io.BytesIO(extpack.zipped(folder, "chrome"))).namelist()
    assert {"manifest.json", "background.js", "content.js", "icon-128.png", "icon-16.png"} <= set(names) and "README.md" not in names


def test_search_results_and_what_the_pc_may_open():
    from phoneboxsound import search as S
    apple = S.from_apple({"results": [{"trackName": "One More Time", "artistName": "Daft Punk", "collectionName": "Discovery", "trackTimeMillis": 320357,
                                       "artworkUrl100": "https://is1-ssl.mzstatic.com/image/a/100x100bb.jpg", "trackViewUrl": "https://music.apple.com/us/album/x/1?i=2"}, {"artistName": "no track"}]})
    assert apple == [{"service": "apple", "title": "One More Time", "sub": "Daft Punk · Discovery", "dur": 320, "thumb": "https://is1-ssl.mzstatic.com/image/a/300x300bb.jpg",
                      "url": "https://music.apple.com/us/album/x/1?i=2"}]
    yt = S.from_youtube_api({"items": [{"id": {"videoId": "abc"}, "snippet": {"title": "Rock &amp; Roll", "channelTitle": "Ch", "thumbnails": {"medium": {"url": "https://i.ytimg.com/vi/abc/mq.jpg"}}}}, {"id": {}}]})
    assert yt[0]["title"] == "Rock & Roll" and yt[0]["url"] == "https://www.youtube.com/watch?v=abc" and len(yt) == 1
    assert S.from_ytdlp({"entries": [{"id": "xyz", "title": "T", "channel": "C", "duration": 61.0}]})[0]["thumb"] == "https://i.ytimg.com/vi/xyz/mqdefault.jpg"
    sp = S.from_spotify({"tracks": {"items": [{"id": "T1", "name": "Song", "duration_ms": 200000, "artists": [{"name": "A"}, {"name": "B"}],
                                              "album": {"name": "Alb", "images": [{"url": "https://i.scdn.co/image/big", "width": 640}, {"url": "https://i.scdn.co/image/mid", "width": 300}]}}]}})
    assert sp[0]["url"] == "spotify:track:T1" and sp[0]["sub"] == "A, B · Alb" and sp[0]["thumb"].endswith("/mid")

    # only the services' own addresses, only https
    for ok in ("https://www.youtube.com/watch?v=1", "https://music.apple.com/x", "spotify:track:abc", "https://www.netflix.com/search?q=x"):
        assert S.may_open(ok), ok
    for bad in ("http://www.youtube.com/watch?v=1", "https://youtube.com.evil.example/x", "https://evil.example/?u=youtube.com", "file:///C:/Windows/system32/calc.exe",
                "javascript:alert(1)", "spotify:../../x", "ms-settings:", "C:/Windows/notepad.exe"):
        assert not S.may_open(bad), bad

    async def run():
        s = S.Search(types.SimpleNamespace(setdefault=lambda k, v: v), demo=True)
        got = await s.query("  night   drive ", "all")
        assert got["q"] == "night drive" and len(got["results"]) == 9 and {r["service"] for r in got["results"][:3]} == {"youtube", "spotify", "apple"}     # some of each first
        assert all(r["thumb"].startswith("/thumb/") and "url" not in r for r in got["results"])                # phones get ids and local pictures, never addresses
        assert S.may_open(s.target(got["results"][0]["id"])) and s.target("made-up-id") is None and s.target(None) is None
        assert {l["label"] for l in got["links"]} >= {"Netflix", "Prime Video", "YouTube", "Spotify"} and all(S.may_open(s.target(l["id"])) for l in got["links"])
        assert (await s.thumb(got["results"][0]["thumb"].split("/")[-1]))[1] == "image/jpeg" and await s.thumb("../../etc/passwd") is None
        assert (await s.query("x"))["results"] == [] and len(await s.suggest("night")) == 3
        s._publish([{"service": "youtube", "title": "t", "sub": "", "dur": 0, "thumb": "https://evil.example/track.gif", "url": "https://evil.example/x"}])
        assert not any("evil" in str(v) for v in list(s.targets.values()) + list(s.thumbs.values()))           # a foreign address never gets in
    asyncio.run(run())


def test_connection_rating_and_the_lighter_stream(tmp_path):
    from phoneboxsound.hub import Client

    class FakeWs:
        async def send_bytes(self, b):
            pass

        async def send_str(self, s):
            pass

    async def run():
        hub = make_hub(tmp_path)
        dev = hub.cfg.device("A")
        c = Client(FakeWs(), "A", dev, "192.168.137.20", True, hub.cfg, verified=True)
        hub.clients = {c.id: c}
        rate = lambda **st: (c.stats.clear(), c.stats.update(st), c.link())[2]
        assert rate() == "unknown"
        assert rate(rtt_ms=6, jitter_ms=5, late_recent=0) == "excellent"
        assert rate(rtt_ms=30, jitter_ms=20, late_recent=0) == "good"
        assert rate(rtt_ms=80, jitter_ms=20, late_recent=0) == "weak"          # far away: slow answers
        assert rate(rtt_ms=20, jitter_ms=50, late_recent=0) == "weak"          # something in the way: uneven arrival
        assert rate(rtt_ms=20, jitter_ms=20, late_recent=5) == "poor"          # sound actually arriving too late
        assert rate(rtt_ms=200, jitter_ms=10, late_recent=0) == "poor"

        # poor for a while: the lighter stream, and the phone is told (it shows "come closer")
        hub.watch_links()
        assert not c.auto_saver
        c.link_since = ("poor", time.time() - 9)
        hub.watch_links()
        cfg_sent = hub.device_config(c)
        assert c.auto_saver and cfg_sent["link"] == "poor" and cfg_sent["link_weak_s"] >= 9 and cfg_sent["on_hotspot"] and cfg_sent["auto_saver"]
        # good again, but only trusted after it has stayed good
        c.stats.update(rtt_ms=8, jitter_ms=4, late_recent=0)
        hub.watch_links()
        assert c.auto_saver
        c.link_since = ("excellent", time.time() - 46)
        hub.watch_links()
        assert not c.auto_saver and hub.device_config(c)["link_weak_s"] == 0
        # switched off in Settings: never touched
        hub.cfg["auto_quality"] = False
        c.stats.update(rtt_ms=300)
        c.link_since = ("poor", time.time() - 60)
        hub.watch_links()
        assert not c.auto_saver
        c.sender.cancel()

    asyncio.run(run())


def test_share_links_are_public_tidy_and_honest():
    from phoneboxsound import share
    ok = share.public_url
    assert ok("https://www.youtube.com/watch?v=abc123XYZ_-&si=track&utm_source=x&list=PL1") == "https://www.youtube.com/watch?v=abc123XYZ_-&list=PL1"
    for private in ("http://example.com/x", "https://192.168.0.1/admin", "https://localhost:8080/", "https://nas.local/films", "https://router/", "https://user:pw@example.com/",
                    "https://intranet.corp/x", "file:///C:/x.mp4", "", None, "https://[::1]/"):
        assert ok(private) is None, private
    assert share.from_page("https://m.youtube.com/watch?v=FGBhQbmPwH8&list=x", 95) == [
        {"label": "YouTube", "url": "https://youtu.be/FGBhQbmPwH8", "exact": True}, {"label": "YouTube, from this moment", "url": "https://youtu.be/FGBhQbmPwH8?t=95", "exact": True}]
    assert share.from_page("https://www.youtube.com/shorts/abcDEF12345", 3)[0]["url"] == "https://youtu.be/abcDEF12345"
    assert share.from_page("https://www.netflix.com/watch/80100172?trackId=14170286", 500) == [{"label": "Netflix", "url": "https://www.netflix.com/watch/80100172", "exact": True}]
    assert share.to_web("spotify:track:4uLU6hMCjMI75M1A2tKUQC") == "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC" and share.to_web("spotify:../x") == "spotify:../x"
    assert share.same_song("One More Time", "Daft Punk", {"title": "Daft Punk - One More Time (Official Video)", "sub": "Daft Punk"})
    assert share.same_song("One Chance", "MoonDeity", {"title": "One Chance", "sub": "MoonDeity · One Chance"})
    assert not share.same_song("One More Time", "Daft Punk", {"title": "One More Night", "sub": "Maroon 5"})
    assert not share.same_song("Hello", "Adele", {"title": "Hello", "sub": "Lionel Richie"})

    class Finder:
        async def find(self, q):
            return [{"service": "youtube", "title": "Adele - Hello (Official)", "sub": "Adele", "url": "https://www.youtube.com/watch?v=YQHsXMglC9A"},
                    {"service": "spotify", "title": "Hello", "sub": "Adele · 25", "url": "spotify:track:1Yk0cQdMLx5RzzFTYwmuld"},
                    {"service": "apple", "title": "Hello", "sub": "Lionel Richie", "url": "https://music.apple.com/us/album/x/1"},
                    {"service": "youtube", "title": "Hello cover", "sub": "Someone", "url": "https://evil.example/x"}]

    async def run():
        playing = {"provider": "smtc", "app": "Spotify", "title": "Hello", "artist": "Adele", "duration": 295}
        got = await share.links_for(playing, Finder(), "spotify")
        assert got == [{"label": "Spotify", "url": "https://open.spotify.com/track/1Yk0cQdMLx5RzzFTYwmuld", "exact": False},        # the player's own service first
                       {"label": "YouTube", "url": "https://youtu.be/YQHsXMglC9A", "exact": False}]                                  # the wrong artist's version is left out
        assert await share.links_for({"provider": "vlc", "title": "holiday 2024.mkv", "artist": ""}, Finder()) == []                # a file on the PC has no public link
        assert await share.links_for({"provider": "browser", "title": "t", "_link": "https://192.168.0.5/cam"}, Finder()) == []     # nor does something on your own network
        assert await share.links_for(None, Finder()) == []
    asyncio.run(run())


def test_pc_output_plays_each_sample_exactly_one_buffer_after_it_was_captured():
    from phoneboxsound.pcout import Aligner
    sr, block = 48000, 480                                  # 10 ms blocks, like the capture
    a = Aligner(sr)
    # the "sound" is a ramp: sample number n has the value n, so what comes out tells us exactly when it was captured
    ramp = lambda start: np.repeat((np.arange(start, start + block) % 30000).astype(np.int16)[:, None], 2, axis=1)
    t0, delay = 1_000_000.0, 220.0
    for i in range(60):                                     # 600 ms captured
        a.feed(t0 + i * 10, sr, ramp(i * block))
    # the speaker asks for 10 ms that will leave it at t0 + 300: that must be what was captured at t0 + 80
    out = a.pull(t0 + 300, block, delay)
    assert out[0, 0] == int(80 * sr / 1000) and out[-1, 0] == int(80 * sr / 1000) + block - 1 and abs(a.error_ms) < 0.05
    out = a.pull(t0 + 310, block, delay)                    # and the next chunk follows on without a gap
    assert out[0, 0] == int(90 * sr / 1000)

    # the output device's clock runs slightly fast (asks a little early every time): followed by single samples, never a jump
    a2 = Aligner(sr)
    fed, play = 0, t0 + 400
    for step in range(3000):                                # 30 seconds
        while t0 + fed * 10 < play + 100:
            a2.feed(t0 + fed * 10, sr, ramp(fed * block)); fed += 1
        a2.pull(play, block, delay)
        play += 10 * 0.9997                                 # 300 parts per million fast
    assert a2.resyncs == 0 and a2.nudges > 100 and abs(a2.error_ms) < 1.5

    # a stall (the PC was busy for half a second): lined up again in one go, then exact
    a3 = Aligner(sr)
    for i in range(200):
        a3.feed(t0 + i * 10, sr, ramp(i * block))
    a3.pull(t0 + 300, block, delay)
    out = a3.pull(t0 + 900, block, delay)
    assert a3.resyncs == 1 and out[0, 0] == int(680 * sr / 1000) % 30000

    # nothing captured yet, or the sound is still "in the future": silence, not noise
    a4 = Aligner(sr)
    assert not a4.pull(t0, block, delay).any()
    a4.feed(t0, sr, ramp(0))
    assert not a4.pull(t0 + 50, block, delay).any()         # due at t0 + 220
    out = a4.pull(t0 + 215, block, delay)                   # starts 5 ms into this chunk
    assert not out[:239].any() and out[241, 0] == 1 and out[-1, 0] > 200


def test_spotify_link_sign_in_mapping_and_plain_refusals(tmp_path):
    from urllib.parse import parse_qs, urlparse
    from phoneboxsound import spotify as SP
    # the published example from the PKCE standard (RFC 7636, appendix B)
    assert SP.challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk") == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    assert "Premium" in SP.explain(403, {"error": {"reason": "PREMIUM_REQUIRED"}}) and "start a song" in SP.explain(404, {"error": {"reason": "NO_ACTIVE_DEVICE"}})
    assert "connect the account again" in SP.explain(401, None)

    async def run():
        hub = make_hub(tmp_path)
        sp = hub.spotify
        assert sp.begin(8080) is None and not sp.linked                       # no Client ID yet: nowhere to send anyone
        hub.cfg["search"]["spotify_id"] = "abc123clientid"
        url = sp.begin(8080)
        q = parse_qs(urlparse(url).query)
        assert url.startswith("https://accounts.spotify.com/authorize?") and q["redirect_uri"] == ["http://127.0.0.1:8080/api/spotify/callback"]
        assert q["code_challenge_method"] == ["S256"] and q["client_id"] == ["abc123clientid"] and "client_secret" not in url
        state = q["state"][0]
        assert q["code_challenge"] == [SP.challenge(sp.pending[state][0])]
        assert "expired" in await sp.finish("someone-elses-state", "code")       # only the sign-in we started is accepted
        assert state in sp.pending

        # with an account linked: what each button asks Spotify for
        calls = []

        async def fake(method, path, params=None, json=None):
            calls.append((method, path, params))
            if path == "/me/player":
                return 200, {"repeat_state": "context", "shuffle_state": True, "item": {"id": "T0", "uri": "spotify:track:T0", "name": "Now", "artists": [{"name": "A"}], "duration_ms": 200000}}
            if path == "/me/player/queue":
                return 200, {"currently_playing": {"id": "T0", "uri": "spotify:track:T0", "name": "Now", "artists": [{"name": "A"}], "duration_ms": 200000},
                             "queue": [{"id": f"T{i}", "uri": f"spotify:track:T{i}", "name": f"Next {i}", "artists": [{"name": "B"}], "duration_ms": 180000,
                                        "album": {"images": [{"url": "https://i.scdn.co/image/x", "width": 300}]}} for i in (1, 2, 3)]}
            if path == "/me/library/contains":
                return 200, [True]
            if path == "/me/player/repeat" and params["state"] == "track":
                return 403, {"error": {"reason": "PREMIUM_REQUIRED"}}
            return 204, None
        sp.store()["refresh"] = "r"
        sp.call = fake
        snap = await sp.snapshot()
        assert snap["repeat"] == "all" and snap["shuffle"] and snap["now"]["liked"] and [r["title"] for r in snap["queue"]] == ["Next 1", "Next 2", "Next 3"]
        assert snap["queue"][0]["thumb"].startswith("/thumb/") and snap["can"]["reorder"] is False
        calls.clear()
        assert await sp.do("repeat", "off") is None and await sp.do("shuffle", False) is None and await sp.do("add", "spotify:track:T9") is None
        assert await sp.do("like", "T0") is None and await sp.do("unlike", "T0") is None and await sp.do("skip", 3) is None
        assert calls == [("PUT", "/me/player/repeat", {"state": "off"}), ("PUT", "/me/player/shuffle", {"state": "false"}), ("POST", "/me/player/queue", {"uri": "spotify:track:T9"}),
                         ("PUT", "/me/library", {"uris": "spotify:track:T0"}), ("DELETE", "/me/library", {"uris": "spotify:track:T0"})] + [("POST", "/me/player/next", None)] * 3
        assert "Premium" in await sp.do("repeat", "one")                          # Spotify's refusal reaches the user in plain words
        assert "no such action" in await sp.do("add", "https://evil.example/x")   # only a Spotify track can be queued

        # the Repeat button on the remote: through Spotify itself while Spotify is what's playing
        hub.media.active = {"app": "Spotify", "id": "s"}
        hub.media.poll = lambda: asyncio.sleep(0)
        calls.clear()
        assert await hub.media_command("repeat", "off") == "Repeat off" and calls == [("PUT", "/me/player/repeat", {"state": "off"})]
        assert (await hub.queue_do("add", "not-a-result-id"))["error"].startswith("Only Spotify songs")
        sp.unlink()
        assert not sp.linked and not hub.spotify_active()
    asyncio.run(run())


def test_only_the_capture_opens_windows_audio():
    # Windows' device list (and which output is the default) is only re-read when the audio library fully
    # restarts, and it only does while nothing else in the program holds it open. A second holder once made the
    # server keep listening to the old output after Windows was switched to another one: everything went silent.
    folder = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "phoneboxsound")
    holders = [f for f in os.listdir(folder) if f.endswith(".py") and "PyAudio()" in open(os.path.join(folder, f), encoding="utf-8").read()]
    assert holders == ["audio.py"], holders

    from phoneboxsound.audio import Capture
    from phoneboxsound.pcout import PcOut
    cap = Capture()
    out = PcOut({"latency_ms": 200}, cap)
    closed = []
    out.close = lambda: closed.append(1)
    cap.on_reinit = out.close
    assert cap.on_reinit is not None and hasattr(cap, "pa_lock") and not hasattr(out, "pa")


def test_pc_output_chirps_like_a_phone_and_is_calibrated_with_them(tmp_path, monkeypatch):
    from phoneboxsound import pcout as P
    if P.pyaudio is None:
        pytest.skip("Windows audio not available")
    cap = types.SimpleNamespace(active_device="X [Loopback]", outputs=[], pa_lock=__import__("threading").RLock())
    out = P.PcOut({"latency_ms": 200}, cap)
    out.settings().update(enabled=True, offset_ms=30)
    t0 = 5_000_000.0
    for i in range(80):
        out.align.feed(t0 + i * 10, 48000, np.zeros((480, 2), np.int16))
    out.chirp(t0 + 100)                                       # "as if captured at t0 + 100"
    clock = {"now": t0 + 300.0}
    monkeypatch.setattr(P, "now_ms", lambda: clock["now"])
    first = None
    for step in range(20):                                    # the device asks for 10 ms at a time
        data = np.frombuffer(out._callback(None, 480, None, None)[0], np.int16).reshape(-1, 2)
        if first is None and data.any():
            first = clock["now"] + int(np.argmax(data[:, 0] != 0)) / 48.0
        clock["now"] += 10
    assert first is not None and abs(first - (t0 + 100 + 200 + 30)) < 0.2      # sounds at capture time + buffer + its own offset
    assert out._chirp is None                                                  # played once, then gone

    async def run():
        from phoneboxsound import calibrate
        hub = make_hub(tmp_path)
        hub.pcout = out
        dev = hub.cfg.device("A")
        dev["offset_ms"] = 0
        hub.calib = {"id": "p1", "beeps": [{"id": "A", "at_ms": 1.0, "name": "Phone"}, {"id": "pc", "at_ms": 2.0, "name": "This PC (Headset)"}], "created": time.time()}
        monkeypatch.setattr(calibrate, "analyze", lambda *a, **k: {"A": {"delay_ms": 20.0, "confidence": 9, "level": 0.5}, "pc": {"delay_ms": -20.0, "confidence": 8, "level": 0.2}})
        res = hub.finish_calibration("p1", np.zeros(100, np.int16).tobytes(), 48000, 0.0)
        by = {r["device_id"]: r for r in res}
        # the headset was 40 ms ahead of the phone: the phone moves earlier, the headset later, and they meet
        assert by["A"]["offset_ms"] == -20 and by["pc"]["offset_ms"] == 50 and hub.cfg["pc_out"]["offset_ms"] == 50
    asyncio.run(run())


def test_share_gives_spotifys_own_link_when_the_account_is_linked(tmp_path):
    async def run():
        hub = make_hub(tmp_path)
        hub.media.active = {"id": "s", "provider": "smtc", "app": "Spotify", "title": "Balma", "artist": "Riyeor", "position": 98, "duration": 154}
        hub.media.snaps = {}
        hub.spotify.store()["refresh"] = "r"

        async def snap():
            return {"now": {"uri": "spotify:track:4uLU6hMCjMI75M1A2tKUQC", "title": "Balma"}, "repeat": "off", "shuffle": False}
        hub.spotify.snapshot = snap

        async def find(q):
            return [{"service": "youtube", "title": "Riyeor - Balma", "sub": "Riyeor", "url": "https://www.youtube.com/watch?v=abcdefghijk"},
                    {"service": "spotify", "title": "Balma", "sub": "Riyeor", "url": "spotify:track:SOMEOTHERVERSION12345"}]
        hub.search.find = find
        info = await hub.share_info()
        assert info["links"][0]["url"] == "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC" and info["links"][0]["exact"] and "<svg" in info["links"][0]["svg"]
        assert [l["label"] for l in info["links"]] == ["Spotify", "YouTube"]          # the exact one replaces the guess for the same service
        # Spotify reports a different song than Windows does (it just changed): no wrong "exact" link
        hub._share_cache = None

        async def stale():
            return {"now": {"uri": "spotify:track:4uLU6hMCjMI75M1A2tKUQC", "title": "Something Else"}}
        hub.spotify.snapshot = stale
        info = await hub.share_info()
        assert not any(l["exact"] for l in info["links"])
    asyncio.run(run())


def test_sliders_keep_up_and_spotify_is_steered_through_spotify(tmp_path):
    async def run():
        hub = make_hub(tmp_path)
        # a slider dragged fast: 30 values arrive while each takes 20 ms to carry out. Only the newest matters.
        done = []

        async def slow(v):
            await asyncio.sleep(0.02)
            done.append(v)
        await asyncio.gather(*(hub.coalesce("vol", i, slow) for i in range(30)))
        assert done[-1] == 29 and len(done) <= 3, done            # not 30 in a row, 600 ms behind the finger

        # Spotify with its account linked: the timeline and the volume are Spotify's own
        sp = hub.spotify
        sp.store()["refresh"] = "r"
        calls = []

        async def fake(method, path, params=None, json=None):
            calls.append((method, path, params or json))
            return 204, None
        sp.call = fake
        now = time.time()
        sp.live = {"progress": 60.0, "at": now - 2, "playing": True, "dur": 200.0, "volume": 0.4, "repeat": "one", "shuffle": True}
        sess = {"id": "s1", "provider": "smtc", "app": "Spotify", "status": "playing", "position": 12.0, "duration": 0, "rate": 1, "can": {"seek": False}, "shuffle": False, "repeat": "off"}
        hub.media.sessions, hub.media.active = [sess], sess
        hub.overlay(hub.media)
        assert 61.9 < sess["position"] < 62.3 and sess["duration"] == 200.0 and sess["volume"] == 0.4 and sess["repeat"] == "one" and sess["shuffle"] and sess["can"]["seek_to"]
        await hub.media_command("seek_to", 150)
        hub.overlay(hub.media)
        assert ("PUT", "/me/player/seek", {"position_ms": 150000}) in calls and 149.9 < sess["position"] < 150.5      # shown at once, no jump back
        await hub.media_command("volume", 0.55)
        assert ("PUT", "/me/player/volume", {"volume_percent": 55}) in calls and sp.live["volume"] == 0.55
        assert await hub.open_on_pc("spotify:track:4uLU6hMCjMI75M1A2tKUQC") is None
        assert ("PUT", "/me/player/play", {"uris": ["spotify:track:4uLU6hMCjMI75M1A2tKUQC"]}) in calls                 # plays inside Spotify, no window brought up

        # while the PC's own output is in step, "PC volume" is the volume of what you listen on, at once
        hub.pcout = types.SimpleNamespace(status="playing", gain=1.0, _base=1.0, settings=lambda: hub.cfg["pc_out"])
        hub.pcout.apply_volume = lambda: setattr(hub.pcout, "gain", 0.0 if hub.cfg["pc_out"].get("muted") else hub.cfg["pc_out"]["volume"])
        await hub.media_command("pc_volume", 0.3)
        hub.overlay(hub.media)
        assert hub.pcout.gain == 0.3 and hub.media.pc == {"volume": 0.3, "muted": False}
        await hub.media_command("pc_mute", True)
        hub.overlay(hub.media)
        assert hub.pcout.gain == 0.0 and hub.media.pc["muted"] is True
    asyncio.run(run())


def test_quick_skips_add_up(tmp_path):
    async def run():
        hub = make_hub(tmp_path)
        sent = []

        async def command(action, value=None, session=None):
            await asyncio.sleep(0.05)                       # the player is slow to act and slower to report
            sent.append((action, round(value, 1)))
        hub.media.command = command
        sess = {"id": "v", "provider": "vlc", "app": "VLC", "status": "paused", "position": 100.0, "duration": 600.0, "rate": 1, "can": {"seek": True, "seek_to": True}}
        hub.media.sessions, hub.media.active = [sess], sess
        await asyncio.gather(hub.media_command("seek", 10), hub.media_command("seek", 10), hub.media_command("seek", 10))
        assert sent[-1] == ("seek_to", 130.0), sent         # three presses of +10: 30 seconds on, not 10
        await asyncio.sleep(0)
        await hub.media_command("seek", -10)
        assert sent[-1] == ("seek_to", 120.0)
        await hub.media_command("seek", -500)
        assert sent[-1] == ("seek_to", 0.0)                 # never before the start
    asyncio.run(run())


def test_spotify_2026_addresses_with_fallback_and_playlists(tmp_path):
    from phoneboxsound import spotify as SP, search as S
    assert "one more permission" in SP.explain(403, {"error": {"message": "Insufficient client scope"}})
    assert "playlist-modify-private" in SP.SCOPES and "playlist-read-private" in SP.SCOPES

    async def run():
        hub = make_hub(tmp_path)
        sp = hub.spotify
        sp.store().update(refresh="r", uid="me")
        calls = []
        old_app = {"on": False}                   # an app still on Spotify's earlier addresses

        async def fake(method, path, params=None, json=None):
            calls.append((method, path, params or json))
            if old_app["on"] and (path.startswith("/me/library") or path.endswith("/items")):
                return 404, {"error": {"message": "Not found"}}
            if path == "/me/playlists":
                return 200, {"items": [{"id": "p1", "name": "Road trip", "owner": {"id": "me"}, "items": {"total": 42}, "images": [{"url": "https://i.scdn.co/image/a"}]},
                                       {"id": "p2", "name": "Top hits", "owner": {"id": "spotify"}, "tracks": {"total": 50}, "images": []}, None], "next": None}
            if path == "/search":
                return (200, {"tracks": {"items": [{"id": "T1", "name": "Sadka", "artists": [{"name": "A"}], "duration_ms": 1000, "album": {"name": "X", "images": []}}]}}) if params["limit"] == "10" else (400, {"error": {"message": "Invalid limit"}})
            if path.endswith("/contains"):
                return 200, [False]
            return 200, {}
        sp.call = fake

        # search: never more than 10 per request (Spotify refuses the whole search otherwise)
        rows = await hub.search._spotify_search("sadka")
        assert rows and rows[0]["url"] == "spotify:track:T1" and calls[-1][2]["limit"] == "10" and calls[-1][2]["market"] == "from_token"

        lists = await sp.playlists()
        assert lists["error"] is None and [(p["name"], p["count"], p["mine"]) for p in lists["list"]] == [("Road trip", 42, True), ("Top hits", 50, False)]
        assert lists["list"][0]["thumb"].startswith("/thumb/")

        calls.clear()
        assert await sp.do("playlist_add", {"id": "p1", "uri": "spotify:track:T1"}) is None and await sp.do("playlist_play", "p1") is None
        assert calls == [("POST", "/playlists/p1/items", {"uris": ["spotify:track:T1"]}), ("PUT", "/me/player/play", {"context_uri": "spotify:playlist:p1"})]
        assert "no such action" in await sp.do("playlist_add", {"id": "p1", "uri": "https://evil.example"})
        calls.clear()
        await sp.do("playlist_add", {"id": "../../me", "uri": "spotify:track:T1"})
        assert calls[0][1] == "/playlists/me/items"                                # an id can never walk to another address

        # an app on the earlier addresses: the same buttons still work
        old_app["on"] = True
        calls.clear()
        assert await sp.do("like", "spotify:track:T1") is None and await sp.do("playlist_add", {"id": "p1", "uri": "spotify:track:T1"}) is None and await sp.is_liked("spotify:track:T1") is False
        assert [c[1] for c in calls] == ["/me/library", "/me/tracks", "/playlists/p1/items", "/playlists/p1/tracks", "/me/library/contains", "/me/tracks/contains"]
        assert calls[1][2] == {"ids": "T1"}

        # from the remote: "add what's playing" and "add this search result"
        old_app["on"] = False

        async def snap():
            return {"now": {"uri": "spotify:track:NOWPLAYING1234567890ab", "title": "Now"}}
        sp.snapshot = snap
        calls.clear()
        assert (await hub.queue_do("playlist_add", {"id": "p1"}))["error"] is None and calls[-1][2] == {"uris": ["spotify:track:NOWPLAYING1234567890ab"]}
        hub.search.targets["res1"] = "spotify:track:FROMSEARCH"
        hub.search.targets["res2"] = "https://www.youtube.com/watch?v=x"
        assert (await hub.queue_do("playlist_add", {"id": "p1", "track": "res1"}))["error"] is None and calls[-1][2] == {"uris": ["spotify:track:FROMSEARCH"]}
        assert "Only Spotify songs" in (await hub.queue_do("playlist_add", {"id": "p1", "track": "res2"}))["error"]
        assert S._country().isalpha() and len(S._country()) == 2
    asyncio.run(run())


@pytest.mark.skipif(os.name != "nt", reason="Windows UI Automation")
def test_windows_text_boxes_are_told_apart_from_everything_else():
    import ctypes
    import threading
    from ctypes import wintypes
    from phoneboxsound.textfocus import TextFocus
    u = ctypes.windll.user32
    u.CreateWindowExW.restype = ctypes.c_void_p
    u.CreateWindowExW.argtypes = [ctypes.c_uint, ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_uint] + [ctypes.c_int] * 4 + [ctypes.c_void_p] * 4
    u.DestroyWindow.argtypes = [ctypes.c_void_p]
    made, ready, stop = [], threading.Event(), threading.Event()

    def windows():      # real controls, never shown and never focused; their thread answers Windows' questions about them
        make = lambda cls, style: u.CreateWindowExW(0, cls, "sample", style, 0, 0, 120, 24, None, None, None, None)
        made.extend([make("EDIT", 0), make("EDIT", 0x0800), make("STATIC", 0), make("BUTTON", 0)])      # text box, read-only box, label, button
        ready.set()
        msg = wintypes.MSG()
        while not stop.is_set():
            while u.PeekMessageW(ctypes.byref(msg), None, 0, 0, 1):
                u.TranslateMessage(ctypes.byref(msg))
                u.DispatchMessageW(ctypes.byref(msg))
            time.sleep(0.005)
        for h in made:
            u.DestroyWindow(h)
    th = threading.Thread(target=windows, daemon=True)
    th.start()
    assert ready.wait(5)
    t = TextFocus()
    try:
        def check():
            if t._uia is None:
                t._start()
            return [t._editable(t._uia.ElementFromHandle(h)) for h in made]
        assert t._pool.submit(check).result(timeout=20) == [True, False, False, False]
        assert isinstance(t.over(), bool) and isinstance(t.focused(), bool)        # the live questions answer without raising
    finally:
        stop.set()
        th.join(3)


def test_phone_is_told_when_the_pointer_is_on_a_text_box(tmp_path):
    from phoneboxsound.hub import Client
    from phoneboxsound.desktop import DemoDesktop

    sent = []

    class FakeWs:
        async def send_bytes(self, b):
            pass

        async def send_str(self, s):
            sent.append(s)

    async def run():
        hub = make_hub(tmp_path)
        hub.desktop = hub.textfocus = DemoDesktop()
        hub.input_log = []
        dev = hub.cfg.device("A")
        dev["perms"]["input"] = True
        c = Client(FakeWs(), "A", dev, "10.0.0.2", True, hub.cfg, verified=True)
        hub.clients = {c.id: c}
        told = lambda: [json.loads(x) for x in sent if '"t": "kbd"' in x]
        await hub.handle_phone(c, {"t": "input", "kind": "move", "dx": 1, "dy": 0})
        await asyncio.sleep(0.2)
        assert told() == []                                             # the phone didn't ask for this: nothing is checked or sent
        await hub.handle_phone(c, {"t": "kbd_watch", "on": True})
        for _ in range(30):                                             # a stroke of 30 movements: one check when it rests, not 30
            await hub.handle_phone(c, {"t": "input", "kind": "move", "dx": 1, "dy": 0})
        await asyncio.sleep(0.25)
        assert [(m.get("over"), "focus" in m) for m in told()] == [(True, False)]
        await hub.handle_phone(c, {"t": "input", "kind": "click", "button": "left"})
        await asyncio.sleep(0.35)
        assert told()[-1]["focus"] is True
        await hub.handle_phone(c, {"t": "input", "kind": "move", "dx": 1500, "dy": 900})      # away from the text box
        await asyncio.sleep(0.25)
        assert told()[-1]["over"] is False
        await hub.handle_phone(c, {"t": "input", "kind": "click", "button": "left"})
        await asyncio.sleep(0.35)
        assert told()[-1]["focus"] is False
        hub.cfg["auto_keyboard"] = False                                # switched off on the PC: silence
        n = len(told())
        await hub.handle_phone(c, {"t": "input", "kind": "click", "button": "left"})
        await asyncio.sleep(0.35)
        assert len(told()) == n
        c.sender.cancel()
    asyncio.run(run())


def test_the_running_number_never_hides_what_a_message_says():
    # Each message to a phone carries a running number for the activity record. Twice that number was given a
    # name a real message already used: "s" hid the clock's time (phones could not sync), "q" hid the words of
    # a search (the phone never recognised its own results). It now has a name of its own.
    from phoneboxsound.hub import Client
    sent = []

    class FakeWs:
        async def send_bytes(self, b):
            pass

        async def send_str(self, s):
            sent.append(json.loads(s))

    async def run():
        c = Client(FakeWs(), "d", {"perms": {}, "speaker": True}, "10.0.0.2", False)
        c.send_json({"t": "pong", "c": 1, "s": 123456.5})
        c.send_json({"t": "search_results", "rid": 4, "q": "night drive", "results": []})
        await asyncio.sleep(0.05)
        c.sender.cancel()
    asyncio.run(run())
    assert sent[0]["s"] == 123456.5 and sent[1]["q"] == "night drive" and [m["#"] for m in sent] == [1, 2]


def test_screen_view_never_counts_as_bad_wifi():
    """While a phone shows the PC screen, pictures make its packets arrive unevenly by design; only sound
    arriving late may call its connection weak (that is what would switch it to the lighter stream)."""
    from phoneboxsound.hub import Client

    class FakeWs:
        async def send_bytes(self, b):
            pass

        async def send_str(self, s):
            pass

    async def run():
        c = Client(FakeWs(), "d", {"perms": {}, "speaker": True}, "10.0.0.2", False)
        c.last_msg = time.time()
        c.stats = {"rtt_ms": 180, "jitter_ms": 90, "late_recent": 0}
        before = c.link()
        c.screen_mode = "screen"
        during = c.link()
        c.stats["late_recent"] = 5
        late = c.link()
        c.sender.cancel()
        return before, during, late

    before, during, late = asyncio.run(run())
    assert before == "poor"          # without the screen, that much unevenness is a bad link
    assert during == "good"          # with it, it is the pictures: the sound is fine
    assert late == "poor"            # but sound arriving late is always bad


def test_a_phone_showing_the_screen_does_not_raise_everyones_buffer(tmp_path):
    hub = make_hub(tmp_path)
    hub.cfg["auto_latency"] = True
    hub.cfg["latency_ms"] = 200

    class C:
        def __init__(self, need, screen):
            self.dev, self.perms = {"speaker": True}, {"speaker": True}
            self.stats = {"need_ms": need, "played": 1000, "rtt_ms": 5}
            self.screen_mode = screen

    hub.clients = {"a": C(150, None), "b": C(600, "screen")}
    hub.push_config = lambda *a, **k: None
    asyncio.run(hub.auto_latency_tick())
    assert hub.cfg["latency_ms"] == 200          # the 600 ms the screen viewer asked for is not given to everyone
    hub.clients["b"].screen_mode = None
    asyncio.run(hub.auto_latency_tick())
    assert hub.cfg["latency_ms"] == min(625, hub.cfg["max_latency_ms"])   # without the screen, a phone that needs more gets it (up to the ceiling)


def test_video_frames_are_told_apart():
    """The encoder's output is split into frames at each delimiter; a full frame is one with an IDR slice."""
    from phoneboxsound.video import _nal_types
    key = b"\x00\x00\x00\x01\x09\xf0" + b"\x00\x00\x00\x01\x67\x42\xe0\x1f" + b"\x00\x00\x00\x01\x68\xce" + b"\x00\x00\x01\x65\x88\x84"
    delta = b"\x00\x00\x00\x01\x09\xf0" + b"\x00\x00\x01\x41\x9a\x02"
    assert 5 in _nal_types(key) and 7 in _nal_types(key)
    assert 5 not in _nal_types(delta) and 1 in _nal_types(delta)


def test_screen_video_only_when_everything_allows_it(tmp_path):
    hub = make_hub(tmp_path)

    class V:
        encoder = ("h264_nvenc", "NVIDIA", [])

    class C:
        screen_video, screen_mode, screen_ws = True, "screen", object()

    c = C()
    assert not hub.video_ok(c)          # no helper on this PC: pictures
    hub.video = V()
    assert hub.video_ok(c)
    c.screen_mode = "window"
    assert not hub.video_ok(c)          # a single window and the magnifier stay pictures
    c.screen_mode = "screen"
    c.screen_video = False
    assert not hub.video_ok(c)          # a phone that cannot decode video gets pictures
    c.screen_video = True
    hub.cfg["screen_video"] = False
    assert not hub.video_ok(c)          # switched off in Settings


def test_screen_mode_pauses_the_others_and_needs_permission(tmp_path):
    hub = make_hub(tmp_path)
    sent = []

    class C:
        def __init__(self, cid, perms):
            self.id, self.device_id = cid, cid
            self.perms = perms
            self.dev = {"name": cid, "speaker": True, "perms": perms}
            self.screen_latency = 120

        def send_json(self, m, **k):
            sent.append((self.id, m))

    a = C("A", {"screen": True, "manage": True, "speaker": True})
    b = C("B", {"screen": True, "manage": False, "speaker": True})
    hub.clients = {"A": a, "B": b}
    hub.push_config = lambda *x, **k: None
    hub.set_screen_mode(b, True)
    assert hub.screen_owner is None                       # without Manage speakers: no Screen mode
    assert any("Manage speakers" in m.get("msg", "") for _, m in sent)
    hub.set_screen_mode(a, True)
    assert hub.screen_mode_of(a) == "owner" and hub.screen_mode_of(b) == "held"
    hub.set_screen_mode(a, False)
    assert hub.screen_owner is None and hub.screen_mode_of(b) is None


def test_transfers_stay_inside_the_shared_folder(tmp_path):
    from phoneboxsound.transfer import Refused, Transfers
    share = tmp_path / "share"
    share.mkdir()
    (tmp_path / "secret.txt").write_text("not for phones")
    (share / "sub").mkdir()
    (share / "sub" / "a.jpg").write_bytes(b"x")
    t = Transfers(lambda: str(share))
    for bad in ("../secret.txt", "sub/../../secret.txt", "..\secret.txt", "/../secret.txt", ".incoming/x", str(tmp_path / "secret.txt")):
        with pytest.raises(Refused):
            t.file_for_download(bad)
    assert t.listdir("sub")["files"][0]["path"] == "sub/a.jpg"
    with pytest.raises(Refused):
        t.listdir("..")


def test_a_resumable_upload_lands_untouched_with_its_date(tmp_path):
    from phoneboxsound.transfer import Refused, Transfers
    share = tmp_path / "share"
    share.mkdir()
    t = Transfers(lambda: str(share))
    data = os.urandom(3 * 1024 * 1024 + 123)

    async def pieces(b, size=70_000):
        for i in range(0, len(b), size):
            yield b[i:i + size]

    async def run():
        uid = t.start("phone", "../../evil/holiday.mp4", len(data), mtime=1_700_000_000_000)
        assert await t.write(uid, "phone", 0, pieces(data[:1_500_000])) == 1_500_000    # one piece, complete
        assert await t.write(uid, "phone", 12345, pieces(b"zz")) == 1_500_000           # a wrong offset is told where to resume
        assert await t.write(uid, "phone", 1_500_000, pieces(data[1_500_000:])) == len(data)
        with pytest.raises(Refused):
            t.get(uid, "another phone")                                                   # one phone cannot touch another's upload
        return t.finish(uid, "phone")

    got = asyncio.run(run())
    out = share / got["name"]
    assert got["name"] == "holiday.mp4" and out.read_bytes() == data                      # the name cannot climb out of the folder
    assert abs(out.stat().st_mtime - 1_700_000_000) < 2
    with pytest.raises(Refused):
        t.start("phone", "x.bin", 10 ** 15)                                               # bigger than any disk: refused before anything is written
