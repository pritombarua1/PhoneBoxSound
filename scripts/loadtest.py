"""How well does the PC keep many phones fed? A measured answer, not a guess.

    python scripts/loadtest.py                 # 1, 10 and 30 simulated phones, 20 seconds each
    python scripts/loadtest.py --phones 50 --seconds 30
    python scripts/loadtest.py --json out.json # also write the numbers to a file

It starts PhoneBoxSound in demo mode (synthetic music, its own temporary settings, a spare port), then
connects simulated phones exactly the way the phone app does: the room code, the clock sync pings, and
the stream of 10 ms audio blocks. For every phone it measures:

  received    audio blocks that arrived, against how many the PC sent in that time
  lost        blocks missing from the running numbers (each block carries one)
  jitter p99  how unevenly blocks arrive (99th percentile of the gap minus 10 ms)
  headroom    how early a block arrives before it has to play (the sync buffer minus the trip);
              the smallest value seen. Negative would be an audible gap on a real phone.
  clock p50   round trip of the clock sync pings, median

It fails (exit code 1) if any phone loses more than 0.5% of its blocks or a block arrives too late to play.
All phones run on this one PC, so this measures the server and its sending, not your Wi-Fi.
"""
import argparse
import asyncio
import json
import os
import socket
import statistics
import subprocess
import sys
import tempfile
import time

import aiohttp

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from phoneboxsound.audio import HEADER, KIND_PROGRAM  # noqa: E402


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Phone:
    def __init__(self, n):
        self.n = n
        self.got, self.lost, self.last_seq = 0, 0, None
        self.gaps, self.headroom, self.rtts = [], [], []
        self.offset = None        # PC clock minus this clock, in ms
        self.latency = 150
        self.last_at = None
        self.error = None

    async def run(self, session, url, code, seconds, start):
        try:
            async with session.ws_connect(url, heartbeat=10, max_msg_size=16 << 20) as ws:
                await ws.send_json({"t": "hello", "code": code, "device_id": f"loadtest-{self.n}", "name": f"Test phone {self.n}",
                                    "platform": "loadtest", "ua": "loadtest", "touch": 5})
                pinger = asyncio.ensure_future(self.ping(ws))
                end = start + seconds
                try:
                    while time.time() < end:
                        msg = await ws.receive(timeout=max(0.1, end - time.time()))
                        now = time.time() * 1000
                        if msg.type == aiohttp.WSMsgType.TEXT:
                            m = json.loads(msg.data)
                            if m.get("t") == "pong" and isinstance(m.get("c"), (int, float)):
                                rtt = now - m["c"]
                                self.rtts.append(rtt)
                                off = m["s"] - (m["c"] + rtt / 2)
                                self.offset = off if self.offset is None else 0.8 * self.offset + 0.2 * off
                            elif m.get("t") == "config" and isinstance(m.get("cfg"), dict):
                                self.latency = m["cfg"].get("latency_ms", self.latency)
                            elif m.get("t") == "error":
                                self.error = m.get("msg")
                                return
                        elif msg.type == aiohttp.WSMsgType.BINARY and len(msg.data) >= HEADER.size:
                            kind, ch, frames, seq, ts, sr, flags = HEADER.unpack_from(msg.data)
                            if kind != KIND_PROGRAM or time.time() < start + 2:      # 2 s to settle
                                self.last_seq, self.last_at = seq, now
                                continue
                            if self.last_seq is not None and seq != self.last_seq + 1:
                                self.lost += max(0, seq - self.last_seq - 1)
                            if self.last_at is not None:
                                self.gaps.append(now - self.last_at - frames / sr * 1000)
                            if self.offset is not None:
                                self.headroom.append(ts + self.latency - (now + self.offset))
                            self.last_seq, self.last_at = seq, now
                            self.got += 1
                        elif msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                            self.error = "connection closed"
                            return
                except asyncio.TimeoutError:
                    pass
                finally:
                    pinger.cancel()
        except Exception as e:
            self.error = str(e)

    async def ping(self, ws):
        while True:
            await ws.send_json({"t": "ping", "c": time.time() * 1000})
            await asyncio.sleep(0.5)


def pct(values, p):
    if not values:
        return None
    v = sorted(values)
    return v[min(len(v) - 1, int(p * len(v)))]


async def round_(base, code, phones, seconds):
    url = base.replace("http", "ws") + "/ws/player"
    start = time.time()
    async with aiohttp.ClientSession() as session:
        ps = [Phone(i) for i in range(phones)]
        await asyncio.gather(*(p.run(session, url, code, seconds, start) for p in ps))
    measured = seconds - 2
    rows = []
    for p in ps:
        expected = p.got + p.lost
        rows.append({
            "received": p.got, "lost": p.lost, "loss_pct": round(100 * p.lost / expected, 3) if expected else None,
            "jitter_p99_ms": round(pct(p.gaps, 0.99), 2) if p.gaps else None,
            "headroom_min_ms": round(min(p.headroom), 1) if p.headroom else None,
            "clock_rtt_p50_ms": round(statistics.median(p.rtts), 2) if p.rtts else None,
            "error": p.error,
        })
    ok = [r for r in rows if not r["error"]]
    return {
        "phones": phones, "seconds": measured,
        "connected": len(ok),
        "blocks_per_phone_per_s": round(statistics.mean(r["received"] for r in ok) / measured, 1) if ok else 0,
        "loss_pct_max": max((r["loss_pct"] or 0) for r in ok) if ok else None,
        "jitter_p99_ms_worst": max((r["jitter_p99_ms"] or 0) for r in ok) if ok else None,
        "headroom_min_ms": min((r["headroom_min_ms"] for r in ok if r["headroom_min_ms"] is not None), default=None),
        "clock_rtt_p50_ms": round(statistics.median(r["clock_rtt_p50_ms"] for r in ok if r["clock_rtt_p50_ms"]), 2) if ok else None,
        "errors": sorted({r["error"] for r in rows if r["error"]}),
    }


async def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--phones", type=int, nargs="*", default=[1, 10, 30])
    ap.add_argument("--seconds", type=float, default=20)
    ap.add_argument("--json", help="also write the results here")
    a = ap.parse_args()

    port = free_port()
    tmp = tempfile.mkdtemp(prefix="pbs-load-")
    cfg = os.path.join(tmp, "config.json")
    env = dict(os.environ, PHONEBOXSOUND_SEAL="file")
    server = subprocess.Popen([sys.executable, "-m", "phoneboxsound", "--demo", "--port", str(port), "--https-port", str(free_port()),
                               "--no-mdns", "--no-tray", "--no-browser", "--config", cfg],
                              cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    base = f"http://127.0.0.1:{port}"
    try:
        async with aiohttp.ClientSession() as s:
            for _ in range(100):
                try:
                    async with s.get(base + "/api/status") as r:
                        if r.status == 200:
                            break
                except aiohttp.ClientError:
                    pass
                await asyncio.sleep(0.2)
            async with s.post(base + "/api/settings", json={"approval": False}) as r:
                r.raise_for_status()
            async with s.get(base + "/api/status") as r:
                code = (await r.json())["code"]
        results = []
        print(f"{'phones':>6} {'connected':>9} {'blocks/s':>9} {'loss max':>9} {'jitter p99':>11} {'headroom min':>13} {'clock rtt':>10}")
        for n in a.phones:
            r = await round_(base, code, n, a.seconds)
            results.append(r)
            print(f"{r['phones']:>6} {r['connected']:>9} {r['blocks_per_phone_per_s']:>9} {str(r['loss_pct_max']) + ' %':>9} "
                  f"{str(r['jitter_p99_ms_worst']) + ' ms':>11} {str(r['headroom_min_ms']) + ' ms':>13} {str(r['clock_rtt_p50_ms']) + ' ms':>10}"
                  + (f"   errors: {r['errors']}" if r["errors"] else ""))
            await asyncio.sleep(1)
        if a.json:
            with open(a.json, "w") as f:
                json.dump({"when": time.strftime("%Y-%m-%d %H:%M"), "rounds": results}, f, indent=1)
        bad = [r for r in results if r["connected"] < r["phones"] or (r["loss_pct_max"] or 0) > 0.5
               or (r["headroom_min_ms"] is not None and r["headroom_min_ms"] < 0)]
        print("PASS" if not bad else f"FAIL: {len(bad)} round(s) out of bounds")
        return 1 if bad else 0
    finally:
        server.terminate()
        try:
            server.wait(5)
        except subprocess.TimeoutExpired:
            server.kill()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
