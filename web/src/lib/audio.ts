/** Wire format and intercom audio helpers. Must match phoneboxsound/audio.py and calibrate.py. */

export const HDR = 24;

export interface Packet {
  kind: number; ch: number; frames: number; seq: number; ts: number; sr: number; flags: number;
  pcm: Int16Array | null;
}

export function parsePacket(buf: ArrayBuffer): Packet {
  const dv = new DataView(buf);
  const flags = dv.getUint32(20, true), kind = dv.getUint8(0);
  return {
    kind, ch: dv.getUint8(1), frames: dv.getUint16(2, true), seq: dv.getUint32(4, true),
    ts: dv.getFloat64(8, true), sr: dv.getUint32(16, true), flags,
    // kind 0 = program audio, 1 = intercom, 2 = screen-view frame (JPEG payload, not samples)
    pcm: flags & 1 || kind > 1 ? null : new Int16Array(buf, HDR),
  };
}

export function makePacket(kind: number, seq: number, sr: number, pcm: Int16Array): ArrayBuffer {
  const buf = new ArrayBuffer(HDR + pcm.length * 2), dv = new DataView(buf);
  dv.setUint8(0, kind); dv.setUint8(1, 1); dv.setUint16(2, pcm.length, true); dv.setUint32(4, seq >>> 0, true);
  dv.setFloat64(8, 0, true); dv.setUint32(16, sr, true); dv.setUint32(20, 0, true);
  new Int16Array(buf, HDR).set(pcm);
  return buf;
}

/** Microphone → 24 kHz mono int16 packets (intercom). */
export class MicSender {
  seq = 0;
  level = 0;
  stream: MediaStream | null = null;
  private src?: MediaStreamAudioSourceNode;
  private proc?: ScriptProcessorNode;
  private sink?: GainNode;

  constructor(private ctx: AudioContext, private onPacket: (p: ArrayBuffer) => void) {}

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const src = this.ctx.createMediaStreamSource(this.stream);
    const proc = this.ctx.createScriptProcessor(1024, 1, 1);
    const out = 24000, ratio = this.ctx.sampleRate / out;
    let pos = 0;
    proc.onaudioprocess = (e) => {
      const x = e.inputBuffer.getChannelData(0);
      const n = Math.max(0, Math.floor((x.length - pos) / ratio));
      const pcm = new Int16Array(n);
      let peak = 0;
      for (let i = 0; i < n; i++) {
        const p = pos + i * ratio, j = Math.floor(p), f = p - j;
        const v = x[j] * (1 - f) + (x[j + 1] ?? x[j]) * f;
        const a = Math.abs(v); if (a > peak) peak = a;
        pcm[i] = Math.max(-32768, Math.min(32767, v * 32767));
      }
      pos = pos + n * ratio - x.length;
      this.level = Math.max(peak, this.level * 0.8);
      if (n) this.onPacket(makePacket(1, ++this.seq, out, pcm));
    };
    const sink = this.ctx.createGain(); sink.gain.value = 0;
    src.connect(proc); proc.connect(sink); sink.connect(this.ctx.destination);
    this.src = src; this.proc = proc; this.sink = sink;
  }

  stop() {
    try { this.src?.disconnect(); this.proc?.disconnect(); this.sink?.disconnect(); } catch { /* ignore */ }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}

/** Plays intercom packets as soon as possible through a small jitter buffer. */
export class IntercomPlayer {
  next = 0;
  level = 0;
  constructor(private ctx: AudioContext, private dest: AudioNode) {}

  play(pkt: Packet) {
    if (!pkt.pcm || !pkt.frames) return;
    const ctx = this.ctx, now = ctx.currentTime;
    if (this.next < now + 0.02 || this.next > now + 0.5) this.next = now + 0.09;
    const ab = ctx.createBuffer(1, pkt.frames, pkt.sr), d = ab.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < pkt.frames; i++) { d[i] = pkt.pcm[i] / 32768; const a = Math.abs(d[i]); if (a > peak) peak = a; }
    const s = ctx.createBufferSource(); s.buffer = ab; s.connect(this.dest); s.start(this.next);
    this.next += pkt.frames / pkt.sr;
    this.level = Math.max(peak, this.level * 0.8);
  }
}

/** Chirp used by auto-calibration. */
export function chirpBuffer(ctx: AudioContext) {
  const sr = ctx.sampleRate, ms = 60, n = Math.floor((sr * ms) / 1000), f0 = 1500, f1 = 7000, k = (f1 - f0) / (ms / 1000);
  const ab = ctx.createBuffer(1, n, sr), d = ab.getChannelData(0);
  for (let i = 0; i < n; i++) {
    const t = i / sr, w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    d[i] = Math.sin(2 * Math.PI * (f0 * t + 0.5 * k * t * t)) * w * 0.95;
  }
  return ab;
}

/** A looping, near-silent <audio>: keeps iOS in playback mode (silent switch, screen off, lock-screen controls). */
export function silentLoop() {
  const sr = 8000, n = sr, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVEfmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, n * 2, true);
  const a = new Audio(URL.createObjectURL(new Blob([buf], { type: "audio/wav" })));
  a.loop = true; a.setAttribute("playsinline", ""); a.volume = 0.01;
  return a;
}
