/**
 * Hosting music from this phone: pick audio files, and every phone (this one included) plays them in sync.
 *
 * The phone decodes the file and uploads raw audio a little ahead of time; the PC plays it out on its own
 * clock and timestamps it like any other source, which is what keeps all listeners together.
 * (A browser cannot capture another app's sound, so this works with files, not with the Spotify app.)
 */
import { HDR } from "../lib/audio";
import { createStore } from "../lib/store";
import { toast } from "../lib/util";

export interface Track { name: string; buffer: AudioBuffer }
export const hostState = createStore({
  on: false, playing: false, loading: "", index: 0, pos: 0, dur: 0, names: [] as string[],
});

const CHUNK = 4800;        // frames per packet
const TARGET_MS = 1600;    // how far ahead the PC is kept supplied
let tracks: Track[] = [];
let cursor = 0;            // next frame to send from the current track
let seq = 0;
let io: { send: (m: object) => void; sendBinary: (b: ArrayBuffer) => void; ctx: () => AudioContext } | null = null;

export function bindHost(api: NonNullable<typeof io>) { io = api; }

function packet(buf: AudioBuffer, from: number, frames: number) {
  const out = new ArrayBuffer(HDR + frames * 4), dv = new DataView(out);
  dv.setUint8(0, 3); dv.setUint8(1, 2); dv.setUint16(2, frames, true); dv.setUint32(4, ++seq >>> 0, true);
  dv.setFloat64(8, 0, true); dv.setUint32(16, buf.sampleRate, true); dv.setUint32(20, 0, true);
  const pcm = new Int16Array(out, HDR), L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
  for (let i = 0; i < frames; i++) {
    const l = L[from + i], r = R[from + i];
    pcm[i * 2] = l < -1 ? -32768 : l > 1 ? 32767 : l * 32767;
    pcm[i * 2 + 1] = r < -1 ? -32768 : r > 1 ? 32767 : r * 32767;
  }
  return out;
}

/** The PC reports how much audio it still has queued; top it up to the target. */
export function onHostBuffer(ms: number) {
  const s = hostState.get(), t = tracks[s.index];
  if (!s.on || !s.playing || !t || !io) return;
  const sr = t.buffer.sampleRate;
  let need = Math.max(0, TARGET_MS - ms) * sr / 1000;
  while (need > 0) {
    const frames = Math.min(CHUNK, t.buffer.length - cursor);
    if (frames <= 0) { next(true); return; }
    io.sendBinary(packet(t.buffer, cursor, frames));
    cursor += frames; need -= frames;
  }
  // what listeners hear right now is behind what has been sent by the queued amount
  hostState.set({ pos: Math.max(0, cursor / sr - Math.max(ms, 0) / 1000), dur: t.buffer.duration });
}

export function onHostState(on: boolean, msg?: string) {
  if (!on) { hostState.set({ on: false, playing: false }); if (msg) toast(msg); }
  else hostState.set({ on: true });
}

export async function addFiles(files: FileList | File[]) {
  if (!io) return;
  const ctx = io.ctx();
  for (const f of Array.from(files)) {
    hostState.set({ loading: f.name });
    try {
      const buffer = await ctx.decodeAudioData(await f.arrayBuffer());
      tracks.push({ name: f.name.replace(/\.[a-z0-9]{2,5}$/i, ""), buffer });
      hostState.set({ names: tracks.map((t) => t.name) });
    } catch { toast(`Can't play ${f.name}`); }
  }
  hostState.set({ loading: "" });
  if (tracks.length && !hostState.get().on) start();
}

export function start() {
  if (!tracks.length || !io) return;
  io.send({ t: "host_start" });
  cursor = Math.floor(hostState.get().pos * tracks[hostState.get().index].buffer.sampleRate) || 0;
  hostState.set({ playing: true });
}

export function toggle() {
  const s = hostState.get();
  if (!s.on) return start();
  if (s.playing) {   // pause: drop what the PC has queued and remember where listeners actually were
    io?.send({ t: "host_flush" });
    cursor = Math.floor(s.pos * tracks[s.index].buffer.sampleRate);
    hostState.set({ playing: false });
  } else hostState.set({ playing: true });
}

export function play(index: number) {
  if (!tracks[index]) return;
  io?.send({ t: "host_flush" });
  cursor = 0;
  hostState.set({ index, pos: 0, dur: tracks[index].buffer.duration, playing: true });
  if (!hostState.get().on) start();
}

export function next(auto = false) {
  const s = hostState.get();
  if (s.index + 1 < tracks.length) {
    if (!auto) io?.send({ t: "host_flush" });
    cursor = 0;
    hostState.set({ index: s.index + 1, pos: 0 });
  } else if (auto) { hostState.set({ playing: false, pos: 0 }); cursor = 0; }
}
export const previous = () => play(Math.max(0, hostState.get().index - (hostState.get().pos > 3 ? 0 : 1)));

export function seek(seconds: number) {
  const s = hostState.get(), t = tracks[s.index];
  if (!t) return;
  io?.send({ t: "host_flush" });
  cursor = Math.floor(Math.max(0, Math.min(t.buffer.duration - 0.2, seconds)) * t.buffer.sampleRate);
  hostState.set({ pos: cursor / t.buffer.sampleRate });
}

export function stopHosting() {
  io?.send({ t: "host_stop" });
  hostState.set({ on: false, playing: false });
}

export function clearTracks() {
  stopHosting();
  tracks = []; cursor = 0;
  hostState.set({ names: [], index: 0, pos: 0, dur: 0 });
}
