/**
 * Phone engine: connection, clock sync and sample-accurate scheduled playback.
 *
 * This is deliberately plain TypeScript, not React: it handles 100 audio packets a second and must
 * never wait for a render. The UI reads a small store that the engine updates about once a second.
 */
import { chirpBuffer, IntercomPlayer, MicSender, parsePacket, silentLoop, type Packet } from "../lib/audio";
import { Clock } from "../lib/clock";
import { createStore } from "../lib/store";
import { forgetIdentity, identity } from "../lib/identity";
import type { Playlist, QueueApi, QueueInfo } from "../lib/queue";
import type { SearchAnswer, SearchApi } from "../lib/search";
import type { ShareInfo } from "../lib/share";
import { applyTheme, currentTheme } from "../lib/theme";
import type { Clip, MediaState, PhoneConfig, Studio, Target } from "../lib/types";
import { clamp, steadyMedia, store, toast, vibrate, wsUrl } from "../lib/util";
import { bindHost, onHostBuffer, onHostState } from "./hosting";

const params = new URLSearchParams(location.search);
const ua = navigator.userAgent;
export const platform = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) || (/Mac/.test(ua) && navigator.maxTouchPoints > 1) ? "iPad"
  : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "Device";

export interface Stats {
  ahead_ms: number; late: number; late_recent: number; resyncs: number; rtt_ms: number; jitter_ms: number | null;
  need_ms: number | null; out_latency_ms: number | null; rate: number; waiting: boolean;
}
export interface Invite { svg: string; url: string; code: string; link: string }

const DEFAULT_CFG: PhoneConfig = {
  name: "", latency_ms: 250, streaming: true, gain: 1, volume: 1, muted: false, channel: "stereo", offset_ms: 0, eq: "flat",
  speaker: true, speaker_pref: true, perms: {}, zone: "", theme: "forest", mode: "dark", duck: 1, index: 1, https_url: null, secure: false,
};

export const phone = createStore({
  view: "join" as "join" | "main" | "waiting",
  err: "",
  hasToken: !!store.get("pbs.token"),
  handoff: params.has("handoff") || params.has("guest"),
  guest: params.has("guest"),
  cfg: DEFAULT_CFG,
  media: null as MediaState | null,
  mediaAt: 0,
  targets: [] as Target[],
  talkers: [] as { name: string; target: string; device_id?: string }[],
  online: true,
  synced: false,
  tapOver: false,
  pcText: { over: false, focus: null as boolean | null, n: 0 },     // is the PC's pointer / keyboard focus on a text box?
  identify: null as number | null,
  invite: null as Invite | null,
  talking: false,
  talkState: "idle" as "idle" | "connecting" | "live" | "latched",
  stats: null as Stats | null,
  clip: null as Clip | null,
  power: null as { action: string; until: number; total: number; by: string | null } | null,
  studio: null as Studio | null,
});

/** Screen-view frames go straight to whoever is showing them (the touchpad), not through React state. */
export const screenView = {
  onFrame: null as ((jpeg: Blob, cx: number, cy: number, done: () => void) => void) | null,
  onVideo: null as ((frame: VideoFrame, cx: number, cy: number) => void) | null,     // draws, then closes the frame
};

/** Can this phone play the screen as H.264 video (WebCodecs, hardware decoding)? Checked once. */
export const videoSupport = { ok: false };
(async () => {
  try {
    const VD = (window as any).VideoDecoder;
    if (VD) videoSupport.ok = !!(await VD.isConfigSupported({ codec: "avc1.42E01F", optimizeForLatency: true })).supported;
  } catch { videoSupport.ok = false; }
})();

/** "avc1.PPCCLL" from the stream's SPS: what the decoder is told to expect. */
function avcCodec(au: Uint8Array) {
  for (let i = 0; i + 7 < au.length; i++) {
    if (au[i] === 0 && au[i + 1] === 0 && au[i + 2] === 1 && (au[i + 3] & 0x1f) === 7) {
      const h = (b: number) => b.toString(16).padStart(2, "0");
      return "avc1." + h(au[i + 4]) + h(au[i + 5]) + h(au[i + 6]);
    }
  }
  return null;
}

let deviceId = store.get("pbs.device");
let token = store.get("pbs.token");
export const getDeviceId = () => deviceId;
export const initialCode = params.get("code") || "";

const clock = new Clock();
let ws: WebSocket | null = null;
let ctx: AudioContext | null = null;
let keepAlive: HTMLAudioElement | null = null;
let joined = false, stopped = true, backoff = 500;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let pendingHello: { code: string; name: string } = { code: "", name: "" };
const cfg = () => phone.get().cfg;

// Every message carries a running number, and every message from the PC carries the PC's. Each side
// reports the last one it saw, so the PC's record can show that nothing was lost in between.
let txN = 0, rxS = 0, rxCount = 0, rxFirst = 0;
export const send = (m: object) => { if (ws?.readyState === 1) ws.send(JSON.stringify({ ...m, n: ++txN })); };

// ---------------------------------------------------------------- audio graph
// program chunks → duck → EQ chain → out (volume) → speakers        intercom → speakers
let duckGain: GainNode, outGain: GainNode, icGain: GainNode, icPlayer: IntercomPlayer | null = null;
let eqNodes: AudioNode[] = [], eqMode = "flat";

function ensureAudio() {
  if (ctx) return ctx;
  const AC: typeof AudioContext = window.AudioContext || (window as any).webkitAudioContext;
  ctx = new AC({ latencyHint: "interactive" });
  duckGain = ctx.createGain(); outGain = ctx.createGain(); icGain = ctx.createGain();
  outGain.connect(ctx.destination); icGain.connect(ctx.destination);
  buildEq("flat");
  icPlayer = new IntercomPlayer(ctx, icGain);
  const unlock = ctx.createBufferSource(); unlock.buffer = ctx.createBuffer(1, 1, 22050); unlock.connect(ctx.destination); unlock.start();
  ctx.onstatechange = () => { if (ctx!.state !== "running" && joined && !document.hidden) phone.set({ tapOver: true }); };
  return ctx;
}

function buildEq(mode: string, channel = "stereo") {
  const c = ctx!;
  try { duckGain.disconnect(); } catch { /* not connected yet */ }
  eqNodes.forEach((n) => { try { n.disconnect(); } catch { /* ignore */ } });
  const bq = (type: BiquadFilterType, f: number, q: number, g?: number) => {
    const n = c.createBiquadFilter(); n.type = type; n.frequency.value = f; n.Q.value = q; if (g != null) n.gain.value = g; return n;
  };
  if (mode === "clear") eqNodes = [bq("highpass", 140, 0.7), bq("peaking", 3000, 0.9, 3)];
  else if (mode === "bass") eqNodes = [bq("lowshelf", 120, 0.7, 6)];
  else if (mode === "loud") {
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -26; comp.knee.value = 12; comp.ratio.value = 6; comp.attack.value = 0.003; comp.release.value = 0.25;
    const makeup = c.createGain(); makeup.gain.value = 1.9;
    eqNodes = [bq("highpass", 170, 0.7), comp, makeup];
  } else eqNodes = [];
  if (channel === "sub") {   // a phone or tablet used as the "subwoofer": only the low end, pushed up
    const boost = c.createGain(); boost.gain.value = 2.2;
    eqNodes = [bq("lowpass", 150, 0.7), bq("lowpass", 150, 0.7), boost];
  }
  let node: AudioNode = duckGain;
  for (const n of eqNodes) { node.connect(n); node = n; }
  node.connect(outGain);
  eqMode = mode + "|" + (channel === "sub");
}

/** iOS opens the mic only in "play-and-record"; "playback" is what survives the silent switch and a dark screen. */
const audioMode = (m: string) => { try { if ((navigator as any).audioSession) (navigator as any).audioSession.type = m; } catch { /* ignore */ } };

// ---------------------------------------------------------------- sync + playback
let ctxMinusPerf: number | null = null;
function updateCtxMapping() {
  const c = ctx!;
  const ts = c.getOutputTimestamp?.();
  const v = ts && ts.performanceTime && ts.performanceTime > 0
    ? (ts.contextTime ?? 0) - ts.performanceTime / 1000
    : c.currentTime - performance.now() / 1000 - ((c as any).outputLatency || c.baseLatency || 0);
  if (ctxMinusPerf === null || Math.abs(v - ctxMinusPerf) > 0.05) ctxMinusPerf = v;
  else ctxMinusPerf += (v - ctxMinusPerf) * 0.05;
}
const serverToCtx = (ms: number) => (ms - clock.offset) / 1000 + (ctxMinusPerf ?? 0);

let nextTime = 0, rate = 1, lastSeq = 0, lastAudioAt = 0;
export const meter = { level: 0 };   // read by the orb animation each frame
const stats = { late: 0, resyncs: 0, played: 0, gaps: 0, far: 0, unsynced: 0, lateWindow: [] as number[] };
let lastStrain = 0;
(window as any).__pbsAudio = { stats, clock: () => ({ synced: clock.synced, jumps: (clock as any).jumps ?? 0, rtt: (clock as any).rtt ?? 0 }) };   // for the tests
const slack = new Float32Array(1000); let slackN = 0;
const transit = new Float32Array(500); let transitN = 0;

function onProgram(p: Packet) {
  const c = ctx, k = cfg();
  if (!c || !k.streaming || !k.speaker) return;
  if (!clock.synced) { stats.unsynced++; return; }      // the clock is being measured again: this block is not heard
  if (lastSeq && p.seq !== lastSeq + 1) stats.gaps++;
  lastSeq = p.seq; lastAudioAt = performance.now();
  transit[transitN++ % transit.length] = clock.serverNow() - p.ts;
  updateCtxMapping();
  const target = serverToCtx(p.ts + k.latency_ms + k.offset_ms);
  const now = c.currentTime;
  // Sound must never be scheduled far ahead (that is "audio arrives seconds after the picture").
  // A packet can't legitimately be due later than the sync buffer, so our clock must be wrong: re-measure.
  if (target - now > (k.latency_ms + Math.abs(k.offset_ms) + 250) / 1000) {
    stats.far++; nextTime = 0; ctxMinusPerf = null;
    if (clock.synced) { clock.reset(); slackN = 0; transitN = 0; }
    return;
  }
  slack[slackN++ % slack.length] = (target - now) * 1000;
  if (screenSock && (target - now) * 1000 < Math.max(40, k.latency_ms * 0.45)) {
    const t = performance.now();
    if (t - lastStrain > 300) { lastStrain = t; send({ t: "strain" }); }     // pictures make way at once
  }
  let err = nextTime - target;
  if (!nextTime || Math.abs(err) > 0.04) { nextTime = target; err = 0; stats.resyncs++; }
  if (nextTime < now + 0.003) { stats.late++; stats.lateWindow.push(performance.now()); nextTime = 0; return; }
  rate = 1 + clamp(err * 0.5, -0.004, 0.004);   // absorb drift by ±0.4% speed: inaudible, no clicks
  if (p.pcm) {
    const ab = c.createBuffer(2, p.frames, p.sr), L = ab.getChannelData(0), R = ab.getChannelData(1);
    const g = 1 / 32768, mode = k.channel, ch = p.ch, pcm = p.pcm;
    let peak = 0;
    for (let i = 0, j = 0; i < p.frames; i++, j += ch) {
      const l = pcm[j] * g, r = ch > 1 ? pcm[j + 1] * g : l;
      let a: number, b: number;
      if (mode === "left") a = b = l; else if (mode === "right") a = b = r; else if (mode === "mono" || mode === "sub") a = b = (l + r) * 0.5;
      else if (mode === "rear") a = b = (l - r) * 0.7;   // what differs between left and right: the room / ambience
      else { a = l; b = r; }
      L[i] = a; R[i] = b;
      if ((i & 7) === 0) { const m = a > 0 ? a : -a; if (m > peak) peak = m; }
    }
    const src = c.createBufferSource();
    src.buffer = ab; src.playbackRate.value = rate; src.connect(duckGain); src.start(nextTime);
    meter.level = Math.max(meter.level * 0.85, peak * k.gain);
  }
  nextTime += p.frames / p.sr / rate;   // silent packets just advance the playhead
  stats.played++;
}

function percentile(arr: Float32Array, n: number, p: number) {
  const k = Math.min(n, arr.length); if (!k) return null;
  const a = Array.from(arr.subarray(0, k)).sort((x, y) => x - y);
  return a[Math.min(k - 1, Math.floor(p * k))];
}

function applyConfig(prev: PhoneConfig, next: PhoneConfig) {
  const theme = store.get("pbs.theme", "pc"), mode = store.get("pbs.mode", "pc");
  applyTheme(theme === "pc" ? next.theme : theme, mode === "pc" ? next.mode : mode);
  if (!ctx) return;
  const t = ctx.currentTime;
  outGain.gain.setTargetAtTime(next.speaker ? next.gain : 0, t, 0.03);
  duckGain.gain.setTargetAtTime(next.duck, t, 0.08);
  if (next.eq + "|" + (next.channel === "sub") !== eqMode) buildEq(next.eq, next.channel);
  if (prev.offset_ms !== next.offset_ms || Math.abs(prev.latency_ms - next.latency_ms) > 25 || prev.channel !== next.channel) nextTime = 0;
}
export function reapplyTheme() { applyConfig(cfg(), cfg()); }

// ---------------------------------------------------------------- connection
function connect() {
  clearTimeout(reconnectTimer);
  try { ws?.close(); } catch { /* ignore */ }
  const sock = new WebSocket(wsUrl("/ws/player"));
  ws = sock;
  sock.binaryType = "arraybuffer";
  clock.reset(); nextTime = 0; lastSeq = 0; rxS = 0; rxCount = 0; rxFirst = 0;
  sock.onopen = async () => {
    const me = await identity();   // this phone's key pair (secure pages only)
    if (sock.readyState !== 1) return;
    const hello: Record<string, unknown> = {
      t: "hello", device_id: deviceId, token, platform,
      name: pendingHello.name || store.get("pbs.name") || "", rename: !!pendingHello.name,
      can_sign: !!me, pub: me?.pub,
      vw: innerWidth, vh: innerHeight, ...system(),
    };
    if (params.get("handoff")) hello.handoff = params.get("handoff");
    if (params.get("guest")) hello.guest = params.get("guest");
    if (pendingHello.code) hello.code = pendingHello.code;
    sock.send(JSON.stringify(hello));
  };
  sock.onmessage = (e) => {
    if (typeof e.data !== "string") {
      const p = parsePacket(e.data);
      if (p.kind === 0) onProgram(p);
      else if (p.kind === 1) { ensureAudio(); icPlayer!.play(p); }
      else if (p.kind === 2) screenView.onFrame?.(new Blob([e.data.slice(24)], { type: "image/jpeg" }), p.frames === 65535 ? -1 : p.frames / 65534, p.sr === 65535 ? -1 : p.sr / 65534, () => {});
      return;
    }
    const m = JSON.parse(e.data);
    if (typeof m["#"] === "number") { rxCount++; if (!rxFirst) rxFirst = m["#"]; if (m["#"] > rxS) rxS = m["#"]; }   // urgent ones may overtake: count, don't compare neighbours
    switch (m.t) {
      case "pong": clock.pong(m); break;
      case "challenge":   // the PC asks this phone to prove it holds its key
        identity().then((me) => me?.sign(m.nonce)).then((sig) => { if (sig && sock.readyState === 1) sock.send(JSON.stringify({ t: "proof", sig })); });
        break;
      case "waiting":   // right code, but the PC has to approve this phone first
        deviceId = m.device_id; store.set("pbs.device", m.device_id);
        if (m.token) { token = m.token; store.set("pbs.token", m.token); }
        if (m.name) store.set("pbs.name", m.name);
        pendingHello.code = ""; backoff = 1500;
        phone.set({ view: "waiting", online: true, err: "", hasToken: true });
        break;
      case "welcome":
        deviceId = m.device_id; store.set("pbs.device", m.device_id);
        if (m.token) { token = m.token; store.set("pbs.token", m.token); }
        if (params.has("handoff") || params.has("code") || params.has("guest")) history.replaceState(null, "", location.pathname);
        params.delete("handoff"); params.delete("guest"); pendingHello.code = "";
        backoff = 500; joined = true; lastShot = "";
        phone.set({ view: "main", online: true, err: "", hasToken: true, handoff: false });
        break;
      case "config": {
        const prev = cfg(), next = { ...prev, ...m };
        if (next.name) store.set("pbs.name", next.name);   // renamed on the PC: remember it here too
        phone.set({ cfg: next }); applyConfig(prev, next); break;
      }
      case "media": { const st = phone.get(); phone.set({ mediaAt: steadyMedia(st.media, st.mediaAt, m), media: m }); updateMediaSession(m); break; }
      case "targets": phone.set({ targets: m.list }); break;
      case "intercom": phone.set({ talkers: m.talkers }); break;
      case "identify": identify(m.index); break;
      case "toast": toast(m.msg, m.ms); break;
      case "search_results": case "suggestions": case "share_info": case "queue_info": case "queue_done": case "playlists": { const done = asks.get(m.rid); if (done) { asks.delete(m.rid); done(m.t === "suggestions" ? m.list : m); } break; }
      case "handoff": location.href = m.url; break;
      case "invite": phone.set({ invite: { svg: m.svg, url: m.url, code: m.code, link: m.link } }); break;
      case "host_buf": onHostBuffer(m.ms); break;
      case "host_state": onHostState(m.on, m.msg); break;
      case "studio": phone.set({ studio: { cfg: m.cfg, devices: m.devices, bedtime: m.bedtime ?? null, may_power: !!m.may_power } }); break;
      case "power":
        phone.set({ power: m.action ? { action: m.action, until: Date.now() + m.seconds * 1000, total: m.seconds, by: m.by } : null });
        break;
      case "clip":
        phone.set({ clip: { kind: m.kind, text: m.text, image: m.image, url: m.url, w: m.w, h: m.h, auto: m.auto, at: Date.now() } });
        if (m.auto) toast(m.kind === "image" ? "PC copied an image" : "PC clipboard updated");
        break;
      case "calib_beep": calibBeep(m.at); break;
      case "kbd": { const p = phone.get().pcText; phone.set({ pcText: { over: m.over ?? p.over, focus: "focus" in m ? m.focus : p.focus, n: p.n + 1 } }); break; }
      case "moved":   // the PC changed its port: go there with the one-time pass, and stay the same phone
        location.href = `${location.protocol}//${location.hostname}:${m.port}/?handoff=${encodeURIComponent(m.handoff)}&moved=1`;
        break;
      case "kicked":
        if (m.forget) { store.del("pbs.token"); token = null; }
        stop(m.msg || (m.forget ? "This phone was removed from the PC" : "Disconnected by the PC"));
        break;
      case "error":
        if (m.msg === "pair" || m.forget) { store.del("pbs.token"); token = null; stop(m.forget ? m.msg : ""); }
        else stop(m.msg);
        break;
    }
  };
  sock.onclose = () => {
    if (stopped || ws !== sock) return;
    phone.set({ online: false });
    reconnectTimer = setTimeout(connect, backoff);
    backoff = Math.min(backoff * 1.7, 5000);
  };
}

// Clock pings: once a second normally, fast while the clock isn't trusted.
setInterval(() => {
  if (!ws || stopped || ws.readyState !== 1) return;
  clock.ping(ws);
  if (joined && clock.lastPongAge() > 6000) { try { ws.close(); } catch { /* ignore */ } }   // dead socket (Wi-Fi roam, sleep)
}, 1000);
setInterval(() => { if (ws?.readyState === 1 && !stopped && (!clock.synced || clock.disagree)) clock.ping(ws); }, 120);

let battery: any = null;
(navigator as any).getBattery?.().then((b: any) => (battery = b)).catch(() => {});

setInterval(() => {
  if (!joined || !ws || ws.readyState !== 1) return;
  const now = performance.now(), k = cfg();
  stats.lateWindow = stats.lateWindow.filter((t) => now - t < 10000);
  const p2 = percentile(slack, slackN, 0.02), tr50 = percentile(transit, transitN, 0.5), tr95 = percentile(transit, transitN, 0.95);
  const ahead = nextTime && ctx ? Math.max(0, (nextTime - ctx.currentTime) * 1000) : 0;
  const s: Stats = {
    ahead_ms: Math.round(ahead), late: stats.late, late_recent: stats.lateWindow.length, resyncs: stats.resyncs,
    rtt_ms: Math.round(clock.rtt * 10) / 10, rate: Math.round(rate * 10000) / 10000,
    jitter_ms: tr50 != null && tr95 != null ? Math.round(tr95 - tr50) : null,
    need_ms: p2 != null ? Math.round(k.latency_ms - p2 + 15) : null,
    out_latency_ms: ctx ? Math.round((((ctx as any).outputLatency || ctx.baseLatency || 0)) * 1000) : null,
    waiting: now - lastAudioAt > 3000,
  };
  const out: Record<string, unknown> = {
    t: "stats", ...s, played: stats.played, gaps: stats.gaps, far: stats.far, clock_jumps: clock.jumps,
    sample_rate: ctx?.sampleRate, state: ctx?.state, hidden: document.hidden,
  };
  const net = (navigator as any).connection;      // Android browsers describe the link; iPhones don't
  if (net) out.net = { type: net.effectiveType, down: net.downlink, rtt: net.rtt };
  delete out.waiting;
  if (battery) { out.battery = battery.level; out.charging = battery.charging; }
  out.rx = rxS; out.rx_gaps = rxS ? Math.max(0, rxS - rxFirst + 1 - rxCount) : 0;
  send(out);
  phone.set({ stats: s, synced: clock.synced });
}, 1000);

// ---------------------------------------------------------------- start / stop
export async function start(code: string, name: string) {
  if (!token && !params.get("handoff") && !params.get("guest") && !/^\d{4}$/.test(code)) { phone.set({ err: "Enter the 4-digit code shown on the PC" }); return; }
  phone.set({ err: "" });
  if (name) store.set("pbs.name", name);
  pendingHello = { code, name };
  audioMode("playback");
  const c = ensureAudio();
  // some phones never answer resume() when there was no touch: don't let that hold up connecting
  try { await Promise.race([c.resume(), new Promise((r) => setTimeout(r, 1200))]); } catch { /* resumed on next gesture */ }
  keepAlive ||= silentLoop();
  keepAlive.play().catch(() => {});
  stopped = false;
  connect();
}

export function stop(msg?: string) {
  stopped = true; joined = false;
  clearTimeout(reconnectTimer);
  try { ws?.close(); } catch { /* ignore */ }
  talkStop();
  keepAlive?.pause();
  nextTime = 0;
  phone.set({ view: "join", online: true, hasToken: !!token, ...(msg != null ? { err: msg } : {}) });
}

export function switchToCode() { store.del("pbs.token"); token = null; phone.set({ hasToken: false, handoff: false }); }
export function forgetPc() { send({ t: "forget" }); store.del("pbs.token"); store.del("pbs.device"); token = null; deviceId = null; forgetIdentity(); stop(""); }

export const comebacks = { total: 0, kept: 0 };      // returns to the app, and how many found the sound still running
(window as any).__pbsComebacks = comebacks;
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || stopped) return;
  if (ctx && ctx.state !== "running") ctx.resume().then(() => phone.set({ tapOver: ctx!.state !== "running" })).catch(() => phone.set({ tapOver: true }));
  keepAlive?.play().catch(() => {});
  // Back from another app. If the sound kept playing the whole time (it does, with the screen on another app or
  // locked), nothing is touched: starting the clock over here is what used to cut the music for a moment on
  // every return. Only when playback really stopped while away is everything measured from scratch.
  const kept = !!ctx && ctx.state === "running" && ws?.readyState === 1 && clock.synced && performance.now() - lastAudioAt < 1200;
  comebacks.total++; if (kept) comebacks.kept++;
  if (kept) clock.ping(ws!);          // one fresh measurement; the clock corrects itself if it no longer agrees
  else { nextTime = 0; ctxMinusPerf = null; slackN = 0; transitN = 0; clock.reset(); }
  if (!ws || ws.readyState > 1) connect();
});

export async function resumeAudio() {
  // Never leave the app behind the overlay: the tap always dismisses it. If the phone still refuses
  // audio, the overlay returns the next time the phone reports it, but the app stays usable meanwhile.
  phone.set({ tapOver: false });
  try { keepAlive?.play()?.catch(() => {}); await Promise.race([ctx?.resume(), new Promise((r) => setTimeout(r, 1500))]); } catch { /* ignore */ }
  nextTime = 0;
}

bindHost({ send, sendBinary: (b) => { if (ws?.readyState === 1) ws.send(b); }, ctx: () => ensureAudio() });

/** Interface size for people who need bigger text (stored on this phone). */
export function applyTextSize(scale = +(store.get("pbs.ui", "1") || 1)) {
  document.documentElement.style.setProperty("--ui", String(scale));
}
applyTextSize();

// ---------------------------------------------------------------- remote
export function cmd(action: string, value?: unknown) {
  if (!cfg().perms.remote) return toast("Media remote is off for this phone");
  send({ t: "media", action, value });
  vibrate(8);
}
export const input = (m: object) => send({ t: "input", ...m });
/** Change something about the whole setup (needs the "Manage all speakers" permission). */
export const manage = (cmd: object) => send({ t: "manage", cmd });

/** Lock screen / Control Center controls drive the PC. */
let msBound = false;
function updateMediaSession(media: MediaState) {
  const ms = navigator.mediaSession; if (!ms) return;
  const a = media.active;
  try {
    ms.metadata = new MediaMetadata({
      title: a ? a.title || a.app : "PhoneBoxSound", artist: a ? a.artist || a.app : cfg().name || "Speaker", album: "PhoneBoxSound",
      artwork: a?.art ? [{ src: `/art/${a.art}`, sizes: "512x512" }] : [{ src: "/icon-512.png", sizes: "512x512", type: "image/png" }],
    });
    ms.playbackState = a?.status === "playing" ? "playing" : "paused";
    if (a?.duration && ms.setPositionState) ms.setPositionState({ duration: a.duration, position: Math.min(a.position, a.duration), playbackRate: a.rate || 1 });
  } catch { /* unsupported */ }
  if (msBound) return;
  msBound = true;
  const h = (n: MediaSessionAction, f: MediaSessionActionHandler) => { try { ms.setActionHandler(n, f); } catch { /* unsupported */ } };
  h("play", () => { cmd("play"); keepAlive?.play(); });
  h("pause", () => cmd("pause"));
  h("nexttrack", () => cmd("next"));
  h("previoustrack", () => cmd("previous"));
  h("seekbackward", (d) => cmd("seek", -(d.seekOffset || 10)));
  h("seekforward", (d) => cmd("seek", d.seekOffset || 10));
  h("seekto", (d) => cmd("seek_to", d.seekTime));
}

// ---------------------------------------------------------------- intercom
let mic: MicSender | null = null, talkDownAt = 0, latchTimer: ReturnType<typeof setTimeout> | undefined;
export const micSecure = () => window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;

function micError(e: any) {
  const n = e?.name || "";
  if (n === "NotAllowedError" || n === "SecurityError") return "Microphone is blocked. Allow it for this site in the browser's settings, then try again.";
  if (n === "NotFoundError") return "No microphone found on this device.";
  if (n === "NotReadableError") return "Another app is using the microphone.";
  return "Microphone unavailable: " + (e?.message || n || "unknown error");
}

async function talkStart(target: string) {
  if (phone.get().talking) return;
  if (!cfg().perms.intercom) return toast("Intercom is off for this phone (PC dashboard → Devices)");
  if (!micSecure()) return toast("Talking needs secure mode: tap the button below");
  phone.set({ talking: true, talkState: "connecting" });
  vibrate(15);
  try {
    audioMode("play-and-record");
    const c = ensureAudio();
    await c.resume();
    mic = new MicSender(c, (pkt) => ws?.readyState === 1 && ws.send(pkt));
    await mic.start();   // asks for permission the first time
    if (!phone.get().talking) return talkStop();
    store.set("pbs.micok", "1");
    send({ t: "intercom_start", target: target || "all" });
    phone.set({ talkState: phone.get().talkState === "latched" ? "latched" : "live" });
  } catch (e) { toast(micError(e), 4000); talkStop(); }
}

export function talkStop() {
  const s = phone.get();
  if (!s.talking && !mic) return;
  clearTimeout(latchTimer);
  mic?.stop(); mic = null;
  audioMode("playback"); nextTime = 0;
  send({ t: "intercom_stop" });
  phone.set({ talking: false, talkState: "idle" });
}

/** Hold = walkie-talkie. A short tap latches it on (tap again to stop): easier during the permission prompt. */
export function talkDown(target: string) {
  const s = phone.get();
  if (s.talking && s.talkState === "latched") { talkStop(); return; }
  talkDownAt = performance.now();
  talkStart(target);
}
export function talkUp() {
  const s = phone.get();
  if (!s.talking || s.talkState === "latched") return;
  const firstTime = store.get("pbs.micok") !== "1";
  if (performance.now() - talkDownAt < 350 || firstTime) {
    phone.set({ talkState: "latched" });
    latchTimer = setTimeout(talkStop, 120000);
  } else talkStop();
}

// ---------------------------------------------------------------- identify & calibration
let identifyTimer: ReturnType<typeof setTimeout> | undefined;
function identify(n: number) {
  phone.set({ identify: n || 0 });
  vibrate([200, 100, 200, 100, 200]);
  if (ctx) {
    const c = ctx, t = c.currentTime + 0.05;
    [0, 0.25, 0.5].forEach((d, i) => {
      const osc = c.createOscillator(), g = c.createGain();
      osc.frequency.value = i === 2 ? 1320 : 880;
      g.gain.setValueAtTime(0.0001, t + d); g.gain.exponentialRampToValueAtTime(0.6, t + d + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.18);
      osc.connect(g).connect(c.destination); osc.start(t + d); osc.stop(t + d + 0.2);
    });
  }
  clearTimeout(identifyTimer);
  identifyTimer = setTimeout(() => phone.set({ identify: null }), 3500);
}

function calibBeep(at: number) {
  if (!ctx) return;
  updateCtxMapping();
  const when = serverToCtx(at + cfg().latency_ms + cfg().offset_ms);
  if (when < ctx.currentTime) return;
  const s = ctx.createBufferSource(); s.buffer = chirpBuffer(ctx); s.connect(ctx.destination); s.start(when);
}

/** Level of incoming intercom, for the orb. */
export const intercomLevel = () => { const l = icPlayer?.level ?? 0; if (icPlayer) icPlayer.level *= 0.9; return l; };

applyTheme(store.get("pbs.theme", "pc") === "pc" ? "forest" : store.get("pbs.theme"), store.get("pbs.mode", "pc") === "pc" ? "dark" : store.get("pbs.mode"));
if ("serviceWorker" in navigator && window.isSecureContext && import.meta.env.PROD) navigator.serviceWorker.register("/sw.js").catch(() => {});


// ---------------------------------------------------------------- what system this is
/** Reported when connecting; the PC keeps it with the phone's record and flags it if it ever changes. */
function system() {
  const d = (navigator as any).userAgentData;
  return { ua: navigator.userAgent.slice(0, 300), uad: d ? { platform: d.platform, mobile: d.mobile, brands: (d.brands || []).map((b: any) => `${b.brand} ${b.version}`).slice(0, 4) } : undefined,
    touch: navigator.maxTouchPoints || 0, standalone: matchMedia("(display-mode: standalone)").matches || !!(navigator as any).standalone, dpr: Math.round(devicePixelRatio * 100) / 100 };
}

// ---------------------------------------------------------------- activity record
// The PC keeps a two-day record of each phone. Messages are recorded by the PC as they arrive. Two
// things only this phone knows are reported here: where the finger touched, and what the screen showed.
addEventListener("pointerdown", (e) => {
  if (!joined || cfg().record === false) return;
  const el = (e.target as HTMLElement | null)?.closest?.("button,a,input,select,textarea,label,[role],.item,.pad,.seg,.card") as HTMLElement | null;
  const field = !!el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
  const label = (el?.getAttribute("aria-label") || el?.title || (field ? el!.getAttribute("placeholder") : el?.textContent) || "").replace(/\s+/g, " ").trim().slice(0, 48);
  send({ t: "ui", ev: "tap", x: Math.round(e.clientX), y: Math.round(e.clientY), sy: Math.round(scrollY), w: innerWidth, h: innerHeight,
    el: el ? (el.classList.contains("pad") ? "touchpad" : el.tagName.toLowerCase()) : "page", label });
  lastTouch = performance.now();
  shootSoon();
}, { capture: true, passive: true });

/**
 * The screen recorder. Whenever the page changes, the PC is sent the part of the page that is different
 * from the previous picture (everything before and after the change is identical, so only the middle
 * travels). Replaying those in order shows exactly what this screen showed. Passwords and the room
 * code are masked; live pictures (the PC screen view, meters) are not included.
 */
let lastShot = "", lastCss = "", lastTouch = 0, shotTimer = 0, lastShotAt = 0;
function shoot() {
  shotTimer = 0;
  const root = document.getElementById("root");
  if (!joined || !root || document.hidden || ws?.readyState !== 1 || cfg().record === false) return;
  const copy = root.cloneNode(true) as HTMLElement;
  const live = root.querySelectorAll<HTMLInputElement>("input,textarea,select"), dead = copy.querySelectorAll<HTMLElement>("input,textarea,select");
  live.forEach((el, i) => {
    const c = dead[i]; if (!c) return;
    if (el.type === "checkbox" || el.type === "radio") { if (el.checked) c.setAttribute("checked", ""); else c.removeAttribute("checked"); }
    else if (el.type === "password" || el.classList.contains("code")) c.setAttribute("value", el.value ? "••••" : "");
    else if (el.tagName === "TEXTAREA") c.textContent = el.value;
    else c.setAttribute("value", el.value);
    if (document.activeElement === el) c.setAttribute("data-focus", "");
  });
  copy.querySelectorAll("img").forEach((im) => { if ((im.getAttribute("src") || "").startsWith("blob:")) im.removeAttribute("src"); });
  copy.querySelectorAll("script,iframe").forEach((x) => x.remove());
  const html = copy.innerHTML;
  const css = [...document.styleSheets].map((x) => { try { return x.href ? new URL(x.href).pathname : ""; } catch { return ""; } }).filter(Boolean).join(" ");
  const top = Math.round(scrollY);
    let p = 0, e = 0;
  const max = Math.min(html.length, lastShot.length);
  while (p < max && html.charCodeAt(p) === lastShot.charCodeAt(p)) p++;
  while (e < max - p && html.charCodeAt(html.length - 1 - e) === lastShot.charCodeAt(lastShot.length - 1 - e)) e++;
  const root2 = document.documentElement;
  const m: Record<string, unknown> = { t: "snap", p, e, len: html.length, mid: html.slice(p, html.length - e), sy: top, w: innerWidth, h: innerHeight };
  if (!lastShot || css !== lastCss) Object.assign(m, { css, th: root2.dataset.theme, mo: root2.dataset.mode, ui: root2.style.getPropertyValue("--ui") || "1" });
  if (html === lastShot && css === lastCss && top === lastTop) return;
  lastShot = html; lastCss = css; lastTop = top; lastShotAt = performance.now();
  send(m);
}
let lastTop = -1;
let shotDue = 0;
function shootSoon() {
  // right after a touch: quickly, to catch what the tap did. Otherwise the page is only ticking over
  // (timers, positions): a picture every few seconds is plenty.
  const now = performance.now();
  const due = now + Math.max(now - lastTouch < 3000 ? 140 : 4000, 140 - (now - lastShotAt));
  if (shotTimer && shotDue <= due) return;       // one is already coming at least as soon
  clearTimeout(shotTimer);
  shotDue = due;
  shotTimer = window.setTimeout(shoot, due - now);
}
addEventListener("load", () => {
  const root = document.getElementById("root");
  if (root) new MutationObserver(shootSoon).observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
  addEventListener("scroll", () => { lastTouch = performance.now(); shootSoon(); }, { passive: true });
  addEventListener("input", () => { lastTouch = performance.now(); shootSoon(); }, { capture: true, passive: true });
});

// ---------------------------------------------------------------- panic gesture
// Shake the phone hard three times and the PC goes into lockdown. Only for a phone given that permission,
// only while this page is open (phones don't hand movement to a page in the background).
export const shake = createStore({ on: false, peak: 0, count: 0, note: "" });
let shakes: number[] = [], lastPanic = 0, lastPeak = 0;
function onMotion(e: DeviceMotionEvent) {
  // movement without gravity where the phone offers it (every iPhone and most Androids); otherwise the
  // total, with gravity's 9.8 taken off
  const a = e.acceleration && e.acceleration.x != null ? e.acceleration : null, g = e.accelerationIncludingGravity;
  const force = a ? Math.hypot(a.x || 0, a.y || 0, a.z || 0) : g ? Math.abs(Math.hypot(g.x || 0, g.y || 0, g.z || 0) - 9.81) : 0;
  const now = performance.now();
  if (force > 14 && now - lastPeak > 180) {              // a firm shake; walking and tapping stay below ~8
    lastPeak = now;
    shakes = shakes.filter((t) => now - t < 1800).concat(now);
    shake.set({ peak: Math.round(force), count: shakes.length });
    if (shakes.length >= 3 && now - lastPanic > 6000) {
      lastPanic = now; shakes = [];
      vibrate([200, 80, 200, 80, 400]);
      if (!joined) toast("Shake noticed, but this phone isn't connected to the PC");
      else if (!cfg().perms.panic) toast("Shake noticed. To let it lock the PC, allow \"Shake to lock down\" for this phone on the PC (Devices).", 5000);
      else { send({ t: "panic" }); toast("Lockdown sent to the PC"); }
    }
  } else if (now - lastPeak > 1800 && shake.get().count) shake.set({ count: 0 });
}
function listen(on: boolean) {
  removeEventListener("devicemotion", onMotion);
  if (on) addEventListener("devicemotion", onMotion);
  shake.set({ on, count: 0 });
}
/** Call from a tap: iPhones only hand out movement data after asking, and only when asked from a tap. */
export async function setShake(on: boolean) {
  if (on) {
    if (typeof DeviceMotionEvent === "undefined") { shake.set({ note: "This device has no movement sensor a page can read." }); return false; }
    if (!window.isSecureContext) { shake.set({ note: "Movement is only given to the secure link. Use \"Switch to the secure link\" above." }); return false; }
    try {
      const ask = (DeviceMotionEvent as any).requestPermission;
      if (typeof ask === "function" && (await ask.call(DeviceMotionEvent)) !== "granted") {
        shake.set({ note: "The phone refused. On iPhone: Settings → Apps → Safari → Motion & Orientation Access, then reload this page." });
        return false;
      }
    } catch { shake.set({ note: "The phone didn't answer the request. Reload the page and try again." }); return false; }
  }
  store.set("pbs.shake", on ? "1" : "0");
  shake.set({ note: "" });
  listen(on);
  return on;
}
// Coming back to the page: Android keeps the permission; an iPhone wants to be asked again, and only from a
// touch, so the first touch anywhere does it quietly.
if (store.get("pbs.shake") === "1" && typeof (globalThis as any).DeviceMotionEvent !== "undefined") {
  if (typeof (DeviceMotionEvent as any).requestPermission !== "function") listen(true);
  else addEventListener("pointerup", function arm() { removeEventListener("pointerup", arm); setShake(true); }, { passive: true });
}
export const shakeActive = () => shake.get().on;

// ---------------------------------------------------------------- search (YouTube, Spotify, Apple Music…)
const asks = new Map<number, (answer: any) => void>();
let askN = 0;
function ask<T>(msg: object): Promise<T> {
  return new Promise((resolve, reject) => {
    const rid = ++askN;
    asks.set(rid, resolve);
    send({ ...msg, rid });
    setTimeout(() => { if (asks.delete(rid)) reject(new Error("no answer")); }, 20000);
  });
}
export const shareInfo = () => ask<ShareInfo>({ t: "share", theme: currentTheme() });
export const searchApi: SearchApi = {
  ask: (q, service) => ask<SearchAnswer>({ t: "search", q, service }),
  suggest: (q) => ask<string[]>({ t: "suggest", q }),
  open: (id) => send({ t: "search_open", id }),
  queue: (id) => ask<{ error: string | null }>({ t: "queue_do", action: "add", value: id }),
};
export const queueApi: QueueApi = {
  get: () => ask<QueueInfo>({ t: "queue_get" }),
  act: (action, value) => ask<{ error: string | null }>({ t: "queue_do", action, value }),
  lists: () => ask<{ list: Playlist[]; error: string | null }>({ t: "playlists_get" }),
};

// ---------------------------------------------------------------- screen pictures on their own connection
// The PC screen view used to share the connection that carries the sound, and a big picture in front of
// the audio held the audio up. Pictures now come over a second connection; each is confirmed, which is
// what lets the PC send exactly as much as this phone's Wi-Fi can take.
let screenSock: WebSocket | null = null;
export function screenLink(on: boolean) {
  const key = cfg().screen_key;
  if (!on || !key) { try { screenSock?.close(); } catch { /* ignore */ } screenSock = null; return; }
  if (screenSock && screenSock.readyState <= 1) return;
  const sock = new WebSocket(wsUrl(`/ws/screen?k=${encodeURIComponent(key)}`));
  sock.binaryType = "arraybuffer";
  // A picture may come in slices (the PC paces them so the sound slips through in between). Put it
  // back together, and say "ok" only once it is on screen: the PC sends the next one after that.
  let parts: ArrayBuffer[] = [], partsOf = -1;
  const ack = () => { if (sock.readyState === 1) sock.send("ok"); };
  // Video: decoded by the phone's own hardware. A decoder that loses track asks for a full frame ("key").
  let decoder: any = null, codec = "", needKey = true, failures = 0;
  const cursorAt = new Map<number, [number, number]>();
  const resetDecoder = () => {
    try { decoder?.close(); } catch { /* closed */ }
    decoder = null; codec = ""; needKey = true;
    // a phone that cannot decode this stream gets pictures instead: never a blank screen
    if (sock.readyState === 1) sock.send(++failures >= 3 ? "novideo" : "key");
  };
  const playVideo = (au: Uint8Array, key: boolean, ts: number, cx: number, cy: number) => {
    if (needKey && !key) return;
    if (key) {
      const c = avcCodec(au);
      if (!c) { resetDecoder(); return; }
      if (!decoder || c !== codec) {
        try { decoder?.close(); } catch { /* closed */ }
        const VD = (window as any).VideoDecoder;
        decoder = new VD({
          output: (frame: VideoFrame) => {
            const at = cursorAt.get(frame.timestamp) || [-1, -1];
            cursorAt.delete(frame.timestamp);
            failures = 0;
            if (screenView.onVideo) screenView.onVideo(frame, at[0], at[1]); else frame.close();
            ack();
          },
          error: () => resetDecoder(),
        });
        decoder.configure({ codec: c, optimizeForLatency: true, hardwareAcceleration: "prefer-hardware" });
        codec = c;
      }
      needKey = false;
    }
    if (!decoder) return;
    const t = Math.round(ts * 1000);
    cursorAt.set(t, [cx, cy]);
    if (cursorAt.size > 60) cursorAt.delete(cursorAt.keys().next().value as number);
    try { decoder.decode(new (window as any).EncodedVideoChunk({ type: key ? "key" : "delta", timestamp: t, data: au })); } catch { resetDecoder(); }
  };
  sock.onmessage = (e) => {
    if (typeof e.data === "string") return;
    const p = parsePacket(e.data);
    if (p.kind !== 2) return;
    const count = p.flags >>> 16, idx = p.flags & 0xffff;
    if (count > 1) {
      if (p.seq !== partsOf) { parts = []; partsOf = p.seq; }
      parts[idx] = e.data.slice(24);
      if (parts.filter(Boolean).length < count) return;
    } else parts = [e.data.slice(24)];
    if (p.ch === 1 || p.ch === 2) {            // video: 1 = a "what changed" frame, 2 = a full frame
      const size = parts.reduce((n, b) => n + b.byteLength, 0), au = new Uint8Array(size);
      let at = 0; for (const b of parts) { au.set(new Uint8Array(b), at); at += b.byteLength; }
      parts = []; partsOf = -1;
      playVideo(au, p.ch === 2, p.ts, p.frames === 65535 ? -1 : p.frames / 65534, p.sr === 65535 ? -1 : p.sr / 65534);
      return;
    }
    const jpeg = new Blob(parts, { type: "image/jpeg" });
    parts = []; partsOf = -1;
    let acked = false;
    const done = () => { if (!acked) { acked = true; ack(); } };
    setTimeout(done, 1500);                 // never let a lost "drawn" stop the pictures
    if (screenView.onFrame) screenView.onFrame(jpeg, p.frames === 65535 ? -1 : p.frames / 65534, p.sr === 65535 ? -1 : p.sr / 65534, done);
    else done();
  };
  sock.onclose = () => { if (screenSock === sock) screenSock = null; try { decoder?.close(); } catch { /* closed */ } };
  screenSock = sock;
}
