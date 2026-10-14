import { memo, useEffect, useRef, useState } from "react";
import { Icon } from "../../lib/icons";
import { useStore } from "../../lib/store";
import type { DeviceRow, ServerState } from "../../lib/types";
import { Range, Seg, Switch } from "../../lib/ui";
import { accent, copyText, cx, fmtAgo, store, toast } from "../../lib/util";
import { NowPlayingCard } from "../media";
import { GuestPass } from "../extras";
import { app, levels, send, setDevice, setGlobal } from "../store";

export const HEALTH: Record<string, string> = {
  stable: "Stable", jitter: "Minor jitter", buffering: "Buffering", unresponsive: "Not responding", suspended: "Audio suspended",
  remote: "Remote only", offline: "Offline", starting: "Starting",
};
export const HDOT: Record<string, string> = { stable: "good", jitter: "warn", buffering: "bad", unresponsive: "bad", suspended: "bad", remote: "info", offline: "", starting: "warn" };
export const statusLine = (d: DeviceRow) => `${d.guest_until ? `Guest until ${new Date(d.guest_until * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ` : ""}${d.system_note || d.system || d.platform || "Device"} · ${d.online ? `${d.ip} · ${fmtAgo(d.since)}` : `offline · seen ${fmtAgo(d.since)} ago`}`;
export const LAYOUTS = [{ v: "stereo", label: "All Stereo" }, { v: "split", label: "L / R Split" }, { v: "mono", label: "All Mono" }] as const;

// ------------------------------------------------------------------ join card
export function joinUrls(S: ServerState) {
  const out = S.ips.map((ip) => ({ url: `http://${ip}:${S.ports.http}`, label: "Wi-Fi / LAN" }));
  if (S.mdns) out.push({ url: `http://phoneboxsound.local:${S.ports.http}`, label: "Name" });
  if (S.public_url) out.push({ url: S.public_url, label: "Secure" });   // browser-trusted: no warning
  else if (S.ports.https) out.push({ url: `https://${S.ips[0]}:${S.ports.https}`, label: "Secure" });
  return out;
}

export function useJoinUrl(S: ServerState) {
  const list = joinUrls(S);
  const [picked, setPicked] = useState(() => store.get("pbs.qrurl"));
  const selected = list.some((u) => u.url === picked) ? picked! : list[0].url;
  const pick = (url: string) => {
    setPicked(url); store.set("pbs.qrurl", url);
    copyText(`${url}/?code=${S.code}`).then((ok) => toast(ok ? "Link copied, QR updated" : "QR updated"));
  };
  return { list, selected, pick };
}

export function UrlList({ S, short, selected, pick, list }: { S: ServerState; short?: boolean } & ReturnType<typeof useJoinUrl>) {
  const shown = short ? list.filter((u, i) => i === 0 || u.label !== "Wi-Fi / LAN" || u.url === selected) : list;
  return (
    <div className="urls">
      {shown.map((u) => (
        <div key={u.url} className={cx("url-row", u.url === selected && "on")} onClick={() => pick(u.url)}>
          <span className="muted" style={{ width: 74 }}>{u.label}</span><span className="mono">{u.url}</span><Icon name="copy" />
        </div>
      ))}
    </div>
  );
}

function JoinCard({ S }: { S: ServerState }) {
  const j = useJoinUrl(S);
  return (
    <div className="card">
      <div className="card-h"><h3>Connect a phone</h3><div className="spacer" /><GuestPass /><button className="btn sm" onClick={() => send({ t: "new_code" })}><Icon name="refresh" />New code</button></div>
      <div className="code">{S.code}</div>
      <div className="qr"><img src={`/qr.svg?url=${encodeURIComponent(j.selected)}&c=${S.code}&theme=${S.cfg.theme}`} alt="QR code to join" /></div>
      <UrlList S={S} short {...j} />
      <p className="note">Same Wi-Fi as this PC (or its mobile hotspot). Paired phones reconnect by themselves, and any paired phone can invite another from its More tab.</p>
    </div>
  );
}

// ------------------------------------------------------------------ audio card
const Spectrum = memo(function Spectrum() {
  const cv = useRef<HTMLCanvasElement>(null), l = useRef<HTMLElement>(null), r = useRef<HTMLElement>(null);
  useEffect(() => {
    let raf = 0, color = accent(), tick = 0;
    const draw = () => {
      const c = cv.current;
      if (c) {
        const w = c.clientWidth, h = c.clientHeight, dpr = devicePixelRatio || 1;
        if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
        const g = c.getContext("2d")!;
        g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
        if (tick++ % 30 === 0) color = accent();
        const n = levels.bands.length, gap = 3, bw = (w - gap * (n - 1)) / n;
        g.fillStyle = color;
        for (let i = 0; i < n; i++) {
          const b = levels.bands[i], bh = Math.max(2, b * h);
          g.globalAlpha = 0.35 + b * 0.65;
          g.beginPath(); g.roundRect(i * (bw + gap), h - bh, bw, bh, 2); g.fill();
        }
        g.globalAlpha = 1;
      }
      if (l.current) l.current.style.width = Math.min(100, levels.l * 100) + "%";
      if (r.current) r.current.style.width = Math.min(100, levels.r * 100) + "%";
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <>
      <canvas className="spectrum" ref={cv} />
      <div className="meters"><span>L</span><div className="meter"><i ref={l} /></div><span>R</span><div className="meter"><i ref={r} /></div></div>
    </>
  );
});

const SOURCES = [{ v: "system", label: "System" }, { v: "clicks", label: "Sync test" }, { v: "tone", label: "Tone" }] as const;

function AudioCard({ S }: { S: ServerState }) {
  const c = S.cfg, cap = S.capture;
  const note = cap.error ? cap.error
    : c.source === "system" ? `Capturing everything this PC plays${cap.sample_rate ? ` · ${cap.sample_rate / 1000} kHz` : ""}.`
    : c.source === "clicks" ? "Click track: high pitch on beat 1. Phones in sync sound like a single click." : "Test tone: 440 Hz left, 660 Hz right.";
  return (
    <div className="card">
      <div className="card-h"><h3>Audio</h3><div className="spacer" />
        <Seg value={c.source as any} options={SOURCES} onChange={(v) => send({ t: "set_source", source: v, device: c.device })} /></div>
      <select className="input" value={c.device ?? ""} disabled={c.source !== "system"} onChange={(e) => send({ t: "set_source", source: "system", device: e.target.value })}>
        <option value="">Windows default output</option>
        {cap.devices.map((d) => <option key={d} value={d}>{d.replace(" [Loopback]", "")}</option>)}
      </select>
      <Spectrum />
      <div className="field">
        <div className="lbl"><span className="row" style={{ gap: 8 }}><Switch checked={c.auto_latency} onChange={(v) => setGlobal({ auto_latency: v })} /> Auto sync buffer</span>
          <b>{c.latency_ms} ms{c.auto_latency ? " · auto" : ""}</b></div>
        <Range value={c.latency_ms} min={60} max={1000} step={10} onChange={(v) => setGlobal({ latency_ms: v })} />
      </div>
      <div className="field">
        <div className="lbl"><span>Master volume (phones)</span><b>{Math.round(c.master * 100)}%</b></div>
        <Range value={c.master} min={0} max={1.5} onChange={(v) => setGlobal({ master: v })} />
      </div>
      <p className={cx("note", cap.error && "err")}>{note}</p>
    </div>
  );
}

// ------------------------------------------------------------------ devices
const CH = [{ v: "left", label: "L" }, { v: "right", label: "R" }, { v: "stereo", label: "Stereo" }, { v: "mono", label: "Mono" }] as const;

function DeviceMenu({ d, zones, at, close, go }: { d: DeviceRow; zones: string[]; at: DOMRect; close: () => void; go: (p: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: at.bottom + 6, left: at.right - 220 });
  useEffect(() => {
    const m = ref.current!;
    setPos({ top: Math.min(innerHeight - m.offsetHeight - 10, at.bottom + 6), left: Math.max(10, at.right - m.offsetWidth) });
    const out = (e: PointerEvent) => { if (!m.contains(e.target as Node)) close(); };
    document.addEventListener("pointerdown", out);
    return () => document.removeEventListener("pointerdown", out);
  }, [at, close]);
  const act = (fn: () => void) => () => { fn(); close(); };
  const id = d.device_id;
  return (
    <div className="menu" ref={ref} style={pos}>
      <button disabled={!d.online} onClick={act(() => send({ t: "identify", device_id: id }))}><Icon name="bell" />Identify</button>
      <button onClick={act(() => setDevice(id, { muted: !d.settings.muted }))}><Icon name={d.settings.muted ? "volume" : "mute"} />{d.settings.muted ? "Unmute" : "Mute"}</button>
      <button onClick={act(() => setDevice(id, { speaker: !d.settings.speaker }))}><Icon name="speaker" />{d.settings.speaker ? "Use as remote only" : "Use as speaker"}</button>
      <label><Icon name="layers" /><select className="input" style={{ padding: "4px 8px" }} value={d.settings.zone} onChange={(e) => { setDevice(id, { zone: e.target.value }); close(); }}>
        {zones.map((z) => <option key={z}>{z}</option>)}</select></label>
      <button onClick={act(() => go("devices"))}><Icon name="settings" />Details</button>
      <div className="sep" />
      <button disabled={!d.online} onClick={act(() => send({ t: "kick", device_id: id }))}><Icon name="logout" />Disconnect</button>
      <button className="btn danger" style={{ border: 0 }} onClick={act(() => { if (confirm(`Forget ${d.name}? It will need the room code to join again.`)) send({ t: "forget", device_id: id }); })}><Icon name="trash" />Forget device</button>
    </div>
  );
}

function DevicesCard({ S, go }: { S: ServerState; go: (p: string) => void }) {
  const [order, setOrder] = useState<string[] | null>(null);   // local order while dragging
  const [dragId, setDragId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; at: DOMRect } | null>(null);
  const byId = new Map(S.devices.map((d) => [d.device_id, d]));
  const ids = (order ?? S.devices.map((d) => d.device_id)).filter((id) => byId.has(id));
  const online = S.devices.filter((d) => d.online).length;
  const over = (id: string, e: React.DragEvent) => {
    e.preventDefault();
    if (!dragId || dragId === id) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const next = ids.filter((x) => x !== dragId);
    next.splice(next.indexOf(id) + (e.clientY < r.top + r.height / 2 ? 0 : 1), 0, dragId);
    setOrder(next);
  };
  const menuDev = menu && byId.get(menu.id);
  return (
    <div className="card">
      <div className="card-h"><h2>Connected Devices</h2><span className="sub">{online} online</span><div className="spacer" />
        <span className="muted hide-sm" style={{ fontSize: 13 }}>Studio Layout</span>
        <Seg value={null} options={LAYOUTS} onChange={(v) => send({ t: "layout", kind: v })} />
      </div>
      <div className="dev-rows">
        {!ids.length && <div className="empty-np"><Icon name="devices" /><span>No phones yet. Scan the QR code below with a phone.</span></div>}
        {ids.map((id) => {
          const d = byId.get(id)!;
          return (
            <div key={id} className={cx("dev-row", !d.online && "offline", dragId === id && "dragging")} draggable={dragId === id}
              onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; }} onDragOver={(e) => over(id, e)}
              onDragEnd={() => { send({ t: "reorder", order: ids }); setDragId(null); setTimeout(() => setOrder(null), 1200); }}>
              <div className="grip" title="Drag to reorder" onPointerDown={() => { setDragId(id); setOrder(ids); }} onPointerUp={() => setDragId(null)}><Icon name="grip" /></div>
              <div className="phone-ico" />
              <div style={{ minWidth: 0 }}>
                <div className="dev-name"><span className={`dot ${HDOT[d.health]}`} title={HEALTH[d.health]} /><span>{d.name}{d.settings.muted ? " (muted)" : ""}</span></div>
                <div className="dev-meta">{statusLine(d)}</div>
              </div>
              <Seg className="ch" value={d.settings.channel as any} options={CH} onChange={(v) => setDevice(id, { channel: v })} />
              <Range className="vol" value={d.settings.volume} min={0} max={1.5} onChange={(v) => setDevice(id, { volume: v })} />
              <span className="pct tnum">{Math.round(d.settings.volume * 100)}%</span>
              <span className="pill lat tnum" title="Buffer ahead on the phone">{!d.online ? "–" : d.health === "remote" ? "remote" : `${d.stats.ahead_ms ?? "–"} ms`}</span>
              <button className="iconbtn more" title="More" onClick={(e) => setMenu({ id, at: e.currentTarget.getBoundingClientRect() })}><Icon name="more" /></button>
            </div>
          );
        })}
      </div>
      {menuDev && <DeviceMenu d={menuDev} zones={Object.keys(S.cfg.zones)} at={menu!.at} close={() => setMenu(null)} go={go} />}
    </div>
  );
}

function Activity({ S }: { S: ServerState }) {
  return (
    <div className="card">
      <div className="card-h"><h3>Activity</h3></div>
      <div className="feed">
        {!S.events.length && <span className="muted">Connections, scenes and intercom show up here.</span>}
        {S.events.map((e, i) => <div key={e.t + ":" + i}><time>{new Date(e.t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time><span>{e.text}</span></div>)}
      </div>
    </div>
  );
}

export default function Dashboard({ go }: { go: (p: string) => void }) {
  const S = useStore(app, (s) => s.S)!;
  return (
    <div className="grid" style={{ gap: 20 }}>
      <NowPlayingCard />
      <DevicesCard S={S} go={go} />
      <div className="grid g-3"><JoinCard S={S} /><AudioCard S={S} /><Activity S={S} /></div>
    </div>
  );
}
