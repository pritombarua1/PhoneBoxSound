import { IntercomPlayer, MicSender, parsePacket } from "../lib/audio";
import { Clock } from "../lib/clock";
import type { Playlist, QueueApi, QueueInfo } from "../lib/queue";
import type { SearchAnswer, SearchApi } from "../lib/search";
import type { ShareInfo } from "../lib/share";
import { createStore } from "../lib/store";
import { applyTheme, currentTheme } from "../lib/theme";
import type { MediaState, ServerState } from "../lib/types";
import { steadyMedia, toast, wsUrl } from "../lib/util";

/** Dashboard state. `S` is the server snapshot (1 Hz + on change); `media` updates on its own channel. */
export const app = createStore({
  S: null as ServerState | null,
  media: null as MediaState | null,
  mediaAt: 0,
  connected: false,
  stateAt: 0,
  guest: null as { url: string; svg: string; until: number; hours: number } | null,
  talking: false,
  version: "",
});

/** Audio levels arrive 20×/s: kept outside React and read by the canvas on each animation frame. */
export const levels = { l: 0, r: 0, bands: new Array<number>(28).fill(0) };

export const clock = new Clock();
let ws: WebSocket | null = null;
let onPlan: ((plan: any) => void) | null = null;
export const prefs = { playIntercom: true };

export const send = (m: object) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };
export const setGlobal = (patch: object) => send({ t: "set_global", ...patch });
export const setDevice = (device_id: string, patch: object) => send({ t: "set_device", device_id, patch });
export const mediaCmd = (action: string, value?: unknown, session?: string) => send({ t: "media", action, value, session });
export const setupPlayer = (appName: string, restart = false) => send({ t: "setup_player", app: appName, restart });

function setMedia(m: MediaState) { const s = app.get(); app.set({ mediaAt: steadyMedia(s.media, s.mediaAt, m), media: m }); }

let live = false;
/** Leave the server alone (locked dashboard): no socket, no reconnect attempts. */
export function disconnect() { live = false; try { ws?.close(); } catch { /* ignore */ } ws = null; app.set({ connected: false, S: null }); }

export function connect() {
  if (live && ws && ws.readyState <= 1) return;
  live = true;
  ws = new WebSocket(wsUrl("/ws/control"));
  ws.binaryType = "arraybuffer";
  ws.onopen = () => { clock.reset(); for (let i = 0; i < 6; i++) setTimeout(() => clock.ping(ws), i * 120); app.set({ connected: true });
      };
  ws.onmessage = (e) => {
    if (typeof e.data !== "string") return onIntercomAudio(e.data);
    const m = JSON.parse(e.data);
    switch (m.t) {
      case "state":
        applyTheme(m.cfg.theme, m.cfg.mode);
        app.set({ S: m, stateAt: performance.now() });
        if (m.media) setMedia(m.media);
        break;
      case "levels":
        levels.l = m.l; levels.r = m.r;
        if (m.bands) for (let i = 0; i < levels.bands.length; i++) levels.bands[i] = Math.max(m.bands[i] ?? 0, levels.bands[i] * 0.82);
        break;
      case "media": setMedia(m); break;
      case "pong": clock.pong(m); break;
      case "toast": toast(m.msg); break;
      case "moved":   // the server now answers on another port: follow it (the sign-in carries over)
        toast(`Moved to port ${m.port}…`);
        setTimeout(() => { location.href = `${location.protocol}//${location.hostname}:${m.port}${location.pathname}`; }, 900);
        break;
      case "calib_plan": onPlan?.(m); break;
      case "guest_pass": app.set({ guest: m }); break;
      case "search_results": case "suggestions": case "share_info": case "queue_info": case "queue_done": case "playlists": { const done = asks.get(m.rid); if (done) { asks.delete(m.rid); done(m.t === "suggestions" ? m.list : m); } break; }
      case "setup_confirm": {
        const name = m.app === "vlc" ? "VLC" : "MPC-HC";
        if (confirm(`${name} is open. It has to restart once to turn on full control.\n\nClose and reopen it now? Your video reopens where you left off.`)) setupPlayer(m.app, true);
        break;
      }
    }
  };
  const sock = ws;
  ws.onclose = () => { if (ws !== sock) return; app.set({ connected: false }); if (live) setTimeout(() => { if (live) { ws = null; connect(); } }, 1500); };
}
setInterval(() => clock.ping(ws), 1000);
fetch("/api/status").then((r) => r.json()).then((j) => app.set({ version: j.version })).catch(() => {});

// ---------------------------------------------------------------- intercom (PC side)
let micCtx: AudioContext | null = null, mic: MicSender | null = null;
let icCtx: AudioContext | null = null, icPlayer: IntercomPlayer | null = null;

function onIntercomAudio(buf: ArrayBuffer) {
  if (!prefs.playIntercom) return;
  if (!icCtx) { icCtx = new AudioContext(); icPlayer = new IntercomPlayer(icCtx, icCtx.destination); }
  if (icCtx.state === "suspended") icCtx.resume();
  icPlayer!.play(parsePacket(buf));
}

export async function talkStart(target: string) {
  if (app.get().talking) return;
  app.set({ talking: true });
  try {
    micCtx ||= new AudioContext();
    await micCtx.resume();
    mic = new MicSender(micCtx, (pkt) => ws?.readyState === 1 && ws.send(pkt));
    await mic.start();
    if (!app.get().talking) return talkStop();
    send({ t: "intercom_start", target: target || "all" });
  } catch (e: any) {
    toast("Microphone not available: " + (e?.message || e));
    talkStop();
  }
}
export function talkStop() {
  if (!app.get().talking && !mic) return;
  mic?.stop(); mic = null;
  app.set({ talking: false });
  send({ t: "intercom_stop" });
}

// ---------------------------------------------------------------- auto-calibration
export interface CalibResult { device_id: string; name: string; delay_ms: number | null; confidence: number; offset_ms: number; volume: number }

/** Records the PC microphone while each phone chirps, then lets the server work out the offsets. */
export async function calibrate(matchVolume: boolean, stage: (s: string, level?: number) => void): Promise<CalibResult[]> {
  stage("listen");
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  const ctx = new AudioContext();
  await ctx.resume();
  const src = ctx.createMediaStreamSource(stream), proc = ctx.createScriptProcessor(4096, 1, 1), sink = ctx.createGain();
  sink.gain.value = 0;
  const chunks: Float32Array[] = [];
  let startPerf: number | null = null;
  proc.onaudioprocess = (e) => {
    const d = e.inputBuffer.getChannelData(0);
    if (startPerf === null) startPerf = performance.now() - (d.length / ctx.sampleRate) * 1000 - (ctx.baseLatency || 0) * 1000;
    chunks.push(new Float32Array(d));
    let p = 0; for (let i = 0; i < d.length; i += 16) p = Math.max(p, Math.abs(d[i]));
    stage("level", p);
  };
  src.connect(proc); proc.connect(sink); sink.connect(ctx.destination);
  const stop = () => { try { src.disconnect(); proc.disconnect(); } catch { /* ignore */ } stream.getTracks().forEach((t) => t.stop()); ctx.close(); };
  try {
    await new Promise((r) => setTimeout(r, 400));
    const plan: any = await new Promise((resolve, reject) => {
      onPlan = resolve; send({ t: "calibrate" });
      setTimeout(() => reject(new Error("No phones answered. Connect a phone as a speaker first.")), 4000);
    });
    stage("chirp");
    while (clock.serverNow() < plan.record_until_ms) await new Promise((r) => setTimeout(r, 100));
    stop();
    const total = chunks.reduce((n, c) => n + c.length, 0), pcm = new Int16Array(total);
    let o = 0;
    for (const c of chunks) for (let i = 0; i < c.length; i++) pcm[o++] = Math.max(-32768, Math.min(32767, c[i] * 32767));
    stage("analyse");
    const res = await fetch(`/api/calibrate/${plan.id}?sr=${ctx.sampleRate}&start=${(startPerf ?? 0) + clock.offset}&vol=${matchVolume ? 1 : 0}`, { method: "POST", body: pcm.buffer }).then((r) => r.json());
    if (res.error) throw new Error(res.error);
    return res.results;
  } catch (e) {
    stop();
    throw e;
  } finally {
    onPlan = null;
  }
}

// ---------------------------------------------------------------- search
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
