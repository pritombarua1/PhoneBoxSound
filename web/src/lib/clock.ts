/**
 * Clock sync: estimates (server clock − local performance.now()) from ping round trips.
 *
 * Only recent, low-latency measurements count. If fresh measurements disagree with the current
 * estimate (the browser froze its timers while the screen was off, the phone changed networks…),
 * the old ones are discarded at once — a stale estimate is exactly what makes audio play seconds late.
 */
interface Sample { rtt: number; off: number; at: number }

export class Clock {
  samples: Sample[] = [];
  offset = 0;
  rtt = 0;
  synced = false;
  disagree = 0;
  jumps = 0;
  lastPong = performance.now();

  reset() {
    this.samples = []; this.offset = 0; this.rtt = 0; this.synced = false; this.disagree = 0;
    this.lastPong = performance.now();
  }

  ping(ws: WebSocket | null | undefined) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: "ping", c: performance.now() }));
  }

  pong(m: { c: number; s: number }) {
    const t1 = performance.now(), rtt = t1 - m.c;
    if (!(rtt >= 0) || rtt > 2000) return;
    const off = m.s - (m.c + t1) / 2;
    this.lastPong = t1;
    if (this.synced && Math.abs(off - this.offset) > 30 + rtt) {
      if (++this.disagree >= 2) { this.samples = []; this.synced = false; this.disagree = 0; this.jumps++; }
    } else this.disagree = 0;
    this.samples.push({ rtt, off, at: t1 });
    this.samples = this.samples.filter((s) => t1 - s.at < 20000).slice(-30);
    const best = [...this.samples].sort((a, b) => a.rtt - b.rtt).slice(0, 5);
    this.offset = best.reduce((s, x) => s + x.off, 0) / best.length;
    this.rtt = best[0].rtt;
    this.synced = this.samples.length >= 4;
  }

  lastPongAge() { return performance.now() - this.lastPong; }
  serverNow() { return performance.now() + this.offset; }
}
