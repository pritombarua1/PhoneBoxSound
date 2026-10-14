import { memo, useEffect, useRef, useState } from "react";
import { Icon } from "../../lib/icons";
import { PERM_INFO } from "../../lib/perms";
import { useStore } from "../../lib/store";
import type { DeviceRow, ServerState } from "../../lib/types";
import { Range, Seg, Switch } from "../../lib/ui";
import { accent } from "../../lib/util";
import { app, calibrate, send, setDevice, type CalibResult } from "../store";
import { HEALTH, LAYOUTS, statusLine } from "./Dashboard";

const CH = [{ v: "stereo", label: "Stereo" }, { v: "left", label: "Left" }, { v: "right", label: "Right" }, { v: "mono", label: "Mono" },
  { v: "sub", label: "Bass", title: "Bass only: use a tablet or laptop as the subwoofer" }, { v: "rear", label: "Rear", title: "Ambience (left minus right): place it behind you" }] as const;
const QUALITY = [{ v: "full", label: "Full quality" }, { v: "saver", label: "Data saver (half the data)" }] as const;
const EQ = [{ v: "flat", label: "Flat" }, { v: "clear", label: "Clear" }, { v: "loud", label: "Loud" }, { v: "bass", label: "Bass" }] as const;

const LINK: Record<string, string> = { excellent: "Excellent", good: "Good", weak: "Weak: too far or something in the way", poor: "Poor: sound will stutter here", unknown: "measuring…" };

const matches = (q: string, ...fields: (string | null | undefined)[]) => !q || fields.some((f) => (f || "").toLowerCase().includes(q));

/** Buffer history per device, kept outside React (one point per server update). */
const history = new Map<string, number[]>();

const Spark = memo(function Spark({ id, tick }: { id: string; tick: number }) {
  const cv = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = cv.current!, data = history.get(id) ?? [];
    const w = c.clientWidth, h = c.clientHeight, dpr = devicePixelRatio || 1;
    c.width = w * dpr; c.height = h * dpr;
    const g = c.getContext("2d")!;
    g.scale(dpr, dpr);
    if (data.length < 2) return;
    const max = Math.max(...data, 50);
    g.strokeStyle = accent(); g.lineWidth = 1.5; g.beginPath();
    data.forEach((v, i) => { const x = (i / (data.length - 1)) * w, y = h - 2 - (v / max) * (h - 4); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
    g.stroke();
  }, [id, tick]);
  return <canvas className="spark" ref={cv} />;
});

function NameInput({ value, onCommit, cls = "nm", placeholder, allowEmpty }: { value: string; onCommit: (v: string) => void; cls?: string; placeholder?: string; allowEmpty?: boolean }) {
  const [v, setV] = useState(value);
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (!editing) setV(value); }, [value, editing]);
  return <input className={cls} placeholder={placeholder} maxLength={allowEmpty ? 60 : 32} value={v} onFocus={() => setEditing(true)} onChange={(e) => setV(e.target.value)}
    onBlur={() => { setEditing(false); if ((v.trim() || allowEmpty) && v !== value) onCommit(v.trim()); }} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />;
}

const DeviceCard = memo(function DeviceCard({ d, zones, tick }: { d: DeviceRow; zones: string[]; tick: number }) {
  const id = d.device_id, s = d.settings, st = d.stats || {};
  const kv: [string, string | number][] = [
    ["Buffer", st.ahead_ms != null ? st.ahead_ms + " ms" : "–"], ["Ping", st.rtt_ms != null ? st.rtt_ms + " ms" : "–"],
    ["Jitter", st.jitter_ms != null ? st.jitter_ms + " ms" : "–"], ["Needs", st.need_ms != null ? st.need_ms + " ms" : "–"],
    ["Output", st.out_latency_ms != null ? st.out_latency_ms + " ms" : "–"], ["Dropouts", st.late ?? "–"],
    ["Clock fixes", st.clock_jumps ?? "–"], ["Battery", st.battery != null ? Math.round(st.battery * 100) + "%" + (st.charging ? " ⚡" : "") : "–"],
  ];
  if (d.blocked) {
    return (
      <div className="card dcard" style={{ opacity: 0.75 }}>
        <div className="head"><div className="phone-ico" style={{ margin: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}><b>{d.name}</b><div className="dev-meta">{d.platform || "Device"} · blocked</div></div>
          <span className="health-label health-buffering">Blocked</span></div>
        <p className="note" style={{ marginTop: 0 }}>This phone and its network address are refused, even with the room code.</p>
        <div className="row"><button className="btn sm accent" onClick={() => send({ t: "block", device_id: id, on: false })}>Unblock</button><div className="spacer" />
          <button className="btn sm danger" onClick={() => send({ t: "forget", device_id: id })}><Icon name="trash" />Remove</button></div>
      </div>
    );
  }
  return (
    <div className="card dcard" style={{ opacity: d.online ? 1 : 0.6 }}>
      <div className="head"><div className="phone-ico" style={{ margin: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}><NameInput value={d.name} onCommit={(name) => setDevice(id, { name })} /><div className="dev-meta">{statusLine(d)}{d.secure ? " · secure" : ""}</div></div>
        <span className={`health-label health-${d.health}`}>{HEALTH[d.health]}</span></div>
      <div className={`idrow ${d.verify_code || d.locked.length ? "warn" : d.verified ? "ok" : ""}`}>
        <Icon name="shield" />
        <span style={{ flex: 1 }}>
          {d.verify_code ? <>Wants to register its security key. The phone shows <b className="tnum">{d.verify_code}</b>.</>
            : d.verified ? "Verified: holds its own security key"
            : d.locked.length ? (d.can_sign ? "Not verified yet" : "On the plain link: PC controls are locked until it uses the secure link")
            : d.has_key ? "Has a security key" : d.online ? "Basic: no security key (plain link)" : "No security key yet"}
        </span>
        {d.verify_code && <button className="btn sm accent" onClick={() => send({ t: "verify_device", device_id: id })}>Verify</button>}
        {d.has_key && <button className="btn sm ghost" title="Use if this phone lost its key (browser data cleared). It must be verified again." onClick={() => confirm(`Reset the security key of ${d.name}? It will have to be verified again.`) && send({ t: "reset_key", device_id: id })}>Reset key</button>}
      </div>
      {d.system_was && (
        <div className="idrow warn"><Icon name="info" />
          <span style={{ flex: 1 }}>Now reports to be <b>{d.system}</b>; it was <b>{d.system_was}</b>. PC control is held back.</span>
          <button className="btn sm accent" onClick={() => confirm(`Is ${d.name} really the same device, now on ${d.system}?`) && send({ t: "confirm_system", device_id: id })}>It's the same device</button>
        </div>
      )}
      <div className="field" style={{ marginTop: 0 }}><div className="lbl"><span>System (detected: {d.system || "not reported yet"})</span></div>
        <NameInput cls="input" placeholder="Your own label, e.g. Mum's Galaxy S24" value={d.system_note} allowEmpty onCommit={(v) => setDevice(id, { system_note: v })} /></div>
      <div className="label" style={{ marginBottom: 6 }}>Channel</div>
      <Seg className="ch" value={s.channel as any} options={CH} onChange={(v) => setDevice(id, { channel: v })} />
      <div className="label" style={{ margin: "12px 0 6px" }}>Sound</div>
      <Seg className="eq" value={s.eq as any} options={EQ} onChange={(v) => setDevice(id, { eq: v })} />
      <div className="field"><div className="lbl"><span>Volume</span><b>{Math.round(s.volume * 100)}%</b></div>
        <Range value={s.volume} min={0} max={1.5} onChange={(v) => setDevice(id, { volume: v })} /></div>
      <div className="field"><div className="lbl"><span>Fine offset (+ plays later)</span><b className="tnum">{s.offset_ms} ms</b></div>
        <Range value={s.offset_ms} min={-300} max={300} step={1} onChange={(v) => setDevice(id, { offset_ms: v })} /></div>
      <div className="label" style={{ margin: "12px 0 6px" }}>Wi-Fi use</div>
      <Seg className="ch" value={(s.quality || "full") as any} options={QUALITY} onChange={(v) => setDevice(id, { quality: v })} />
      <div className="field"><div className="lbl"><span>Zone</span></div>
        <select className="input" value={s.zone} onChange={(e) => setDevice(id, { zone: e.target.value })}>{zones.map((z) => <option key={z}>{z}</option>)}</select></div>
      <div className="label" style={{ margin: "14px 0 2px" }}>Permissions</div>
      {PERM_INFO.map((p) => (
        <div className="perm-row" key={p.key}><span><b style={{ fontWeight: 600 }}>{p.label}</b><span className="what">{p.what}</span></span><div className="spacer" />
          <Switch checked={d.perms[p.key]} onChange={(v) => setDevice(id, { perms: { [p.key]: v } })} /></div>
      ))}
      {d.online && <div className={`linkrow ${d.link}`}><span className="bars" aria-hidden="true"><i /><i /><i /><i /></span>
        <span style={{ flex: 1 }}>Connection: <b>{LINK[d.link] || d.link}</b>{d.auto_saver ? " · on the lighter stream until it recovers" : ""}{d.screen_ms != null ? ` · screen picture ${d.screen_ms} ms` : ""}</span>
        <span className="muted tnum">{d.kbps ? `${(d.kbps / 1000).toFixed(1)} Mbit/s` : "no sound"}</span></div>}
      <div className="kv">{kv.map(([k, v]) => <div key={k}><span>{k}</span><b>{v}</b></div>)}</div>
      <Spark id={id} tick={tick} />
      <div className="row" style={{ marginTop: 12, flexWrap: "wrap" }}>
        <button className="btn sm" onClick={() => send({ t: "identify", device_id: id })}><Icon name="bell" />Identify</button>
        <button className="btn sm" onClick={() => setDevice(id, { muted: !s.muted })}>{s.muted ? "Unmute" : "Mute"}</button>
        <div className="spacer" />
        <button className="btn sm" onClick={() => send({ t: "kick", device_id: id })}>Disconnect</button>
        <button className="btn sm danger" title="Disconnect it and refuse it from now on, even with the room code"
          onClick={() => confirm(`Block ${d.name}? It is disconnected and can't join again until you unblock it.`) && send({ t: "block", device_id: id, on: true })}>Block</button>
        <button className="btn sm danger" onClick={() => confirm(`Forget ${d.name}?`) && send({ t: "forget", device_id: id })}><Icon name="trash" />Forget</button>
      </div>
    </div>
  );
});

function Zones({ S }: { S: ServerState }) {
  const [name, setName] = useState("");
  const add = () => { if (name.trim()) { send({ t: "zone_add", name: name.trim() }); setName(""); } };
  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="card-h"><h3>Zones</h3><span className="sub">Group phones by room and control each room's volume</span><div className="spacer" />
        <input className="input" placeholder="New zone name" style={{ width: 180, padding: "6px 10px" }} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
        <button className="btn sm" onClick={add}><Icon name="plus" />Add</button></div>
      {Object.entries(S.cfg.zones).map(([z, v]) => {
        const count = S.devices.filter((d) => d.settings.zone === z).length;
        return (
          <div className="zone" key={z}>
            <ZoneName value={z} />
            <Range value={v.volume} min={0} max={1.5} onChange={(n) => send({ t: "zone_set", name: z, volume: n })} />
            <span className="tnum muted">{Math.round(v.volume * 100)}%</span>
            <span className="muted" style={{ fontSize: 12.5 }}>{count} phone{count === 1 ? "" : "s"}</span>
            <span className="row" style={{ gap: 6 }}>
              <button className="btn sm" onClick={() => send({ t: "zone_set", name: z, muted: !v.muted })}>{v.muted ? "Unmute" : "Mute"}</button>
              <button className="iconbtn" title="Delete zone" onClick={() => send({ t: "zone_delete", name: z })}><Icon name="trash" /></button>
            </span>
          </div>
        );
      })}
    </div>
  );
}
function ZoneName({ value }: { value: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return <input className="input" value={v} onChange={(e) => setV(e.target.value)} onBlur={() => v.trim() && v !== value && send({ t: "zone_set", name: value, rename: v.trim() })} />;
}

// ------------------------------------------------------------------ calibration dialog
function CalibrateDialog({ close }: { close: () => void }) {
  const pcOut = useStore(app, (s) => (s.S?.pc_out?.status === "playing" ? s.S.pc_out.playing_on : null));
  const [stage, setStage] = useState<"intro" | "listen" | "chirp" | "analyse" | "done" | "error">("intro");
  const [matchVol, setMatchVol] = useState(true);
  const [results, setResults] = useState<CalibResult[]>([]);
  const [error, setError] = useState("");
  const meter = useRef<HTMLElement>(null);
  const run = async () => {
    try {
      const res = await calibrate(matchVol, (s, level) => {
        if (s === "level") { if (meter.current) meter.current.style.width = Math.min(100, (level || 0) * 300) + "%"; } else setStage(s as any);
      });
      setResults(res); setStage("done");
    } catch (e: any) { setError(e?.message || String(e)); setStage("error"); }
  };
  const missed = results.some((r) => r.delay_ms == null);
  return (
    <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && stage !== "listen" && stage !== "chirp" && close()}>
      <div className="card modal">
        <div className="card-h"><h3>Auto-calibrate speakers</h3><div className="spacer" />
          {stage !== "listen" && stage !== "chirp" && <button className="iconbtn" aria-label="Close" onClick={close}><Icon name="x" /></button>}</div>
        {stage === "intro" && <>
          <p>Place the phones where you'll use them, turn their volume up, and keep the room quiet.</p>
          <p className="muted">Each phone chirps once while this PC's microphone listens. Offsets are then set so every phone hits at exactly the same moment.</p>
          {pcOut && <p className="note"><b>This PC's {pcOut} takes part too</b> and chirps last. A headset's microphone can't hear its own earcups while you wear it: take the headset off and hold one earcup right against its microphone, with the phones close by.</p>}
          <label className="row" style={{ margin: "12px 0" }}><Switch checked={matchVol} onChange={setMatchVol} /> Also match loudness between phones</label>
          <div className="row" style={{ justifyContent: "flex-end" }}><button className="btn" onClick={close}>Cancel</button><button className="btn accent" onClick={run}>Start</button></div>
        </>}
        {(stage === "listen" || stage === "chirp") && <>
          <p>{stage === "listen" ? "Listening… (allow the microphone if asked)" : "Phones are chirping… keep quiet."}</p>
          <div className="meter"><i ref={meter} /></div>
        </>}
        {stage === "analyse" && <p>Analysing…</p>}
        {stage === "error" && <><p className="note err">{error}</p><div className="row" style={{ justifyContent: "flex-end" }}><button className="btn" onClick={close}>Close</button></div></>}
        {stage === "done" && <>
          <table className="res"><tbody>
            <tr><th>Phone</th><th>Was off by</th><th>New offset</th><th>Volume</th><th>Signal</th></tr>
            {results.map((r) => (
              <tr key={r.device_id}><td>{r.name}</td>
                <td className="tnum">{r.delay_ms == null ? <span className="muted">not heard</span> : `${r.delay_ms > 0 ? "+" : ""}${r.delay_ms} ms`}</td>
                <td className="tnum">{r.offset_ms} ms</td><td className="tnum">{Math.round(r.volume * 100)}%</td><td className="tnum muted">{r.confidence}</td></tr>
            ))}
          </tbody></table>
          <p className="note">{missed ? 'Phones marked "not heard" were too quiet or too far from the PC mic. Raise their volume and run again.' : "Done. Run it again whenever you move the phones."}</p>
          <div className="row" style={{ justifyContent: "flex-end", marginTop: 12 }}><button className="btn accent" onClick={close}>Close</button></div>
        </>}
      </div>
    </div>
  );
}

export default function Devices() {
  const S = useStore(app, (s) => s.S)!;
  const [calib, setCalib] = useState(false);
  const tick = useRef(0);
  // one history point per server snapshot
  const seen = useRef<ServerState | null>(null);
  if (seen.current !== S) {
    seen.current = S; tick.current++;
    for (const d of S.devices) {
      if (!d.online || typeof d.stats.ahead_ms !== "number") continue;
      const h = history.get(d.device_id) ?? [];
      h.push(d.stats.ahead_ms); if (h.length > 90) h.shift();
      history.set(d.device_id, h);
    }
  }
  const zones = Object.keys(S.cfg.zones);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const q = query.trim().toLowerCase();
  const shown = S.devices.filter((d) => matches(q, d.name, d.platform, d.system, d.system_note, d.ip, d.device_id, d.settings.zone, d.online ? "online" : "offline", d.blocked ? "blocked" : "", d.verified ? "verified" : ""));
  const pending = S.pending.filter((d) => matches(q, d.name, d.platform, d.ip, d.device_id, "waiting pending"));
  const past = S.past.filter((d) => matches(q, d.name, d.platform, d.ip, d.device_id, "forgotten past"));
  return (
    <>
      {S.blocked_ips.length > 0 && (
        <div className="card pending" style={{ marginBottom: 18 }}>
          <div className="card-h"><h3><Icon name="lock" /> Blocked addresses</h3><span className="muted">A phone on one of these addresses is refused, even with the right code. They were blocked together with a phone that has since been removed.</span><div className="spacer" />
            {S.blocked_ips.length > 1 && <button className="btn sm accent" onClick={() => S.blocked_ips.forEach((ip) => send({ t: "unblock_ip", ip }))}>Unblock all</button>}</div>
          {S.blocked_ips.map((ip) => (
            <div className="prow" key={ip}><div style={{ flex: 1 }}><b className="mono">{ip}</b></div>
              <button className="btn sm accent" onClick={() => send({ t: "unblock_ip", ip })}>Unblock</button></div>
          ))}
        </div>
      )}
      {pending.length > 0 && (
        <div className="card pending" style={{ marginBottom: 18 }}>
          <div className="card-h"><h3><Icon name="shield" /> Waiting for your approval</h3><span className="muted">They had the right code. Until you approve, they get nothing: no sound, no controls.</span></div>
          {pending.map((p) => (
            <div className="prow" key={p.device_id}>
              <div style={{ flex: 1, minWidth: 0 }}><b>{p.name}</b><div className="dev-meta">{p.platform || "Device"} · {p.ip} · {p.waiting ? "waiting now" : "left, can come back"} · id {p.device_id.slice(0, 6)}</div></div>
              <button className="btn sm danger" onClick={() => send({ t: "block", device_id: p.device_id, on: true })}>Block</button>
              <button className="btn sm" onClick={() => send({ t: "approve", device_id: p.device_id, ok: false })}>Deny</button>
              <button className="btn sm accent" onClick={() => send({ t: "approve", device_id: p.device_id, ok: true })}>Approve</button>
            </div>
          ))}
        </div>
      )}
      <div className="row" style={{ flexWrap: "wrap", marginBottom: 18, gap: 12 }}>
        <Seg value={null} options={LAYOUTS} onChange={(v) => send({ t: "layout", kind: v })} />
        <span className="pill" title="Phones connected right now / phones paired"><span className={`dot ${S.devices.some((d) => d.online) ? "good" : ""}`} /><b>{S.devices.filter((d) => d.online).length}</b>&nbsp;connected · {S.devices.filter((d) => !d.blocked).length} paired{S.pending.length ? ` · ${S.pending.length} waiting` : ""}</span>
        <span className="pill" title="What the phones' sound takes from your Wi-Fi, all together. Full quality is 1.5 Mbit/s per phone, the lighter stream half of that.">Wi-Fi load <b>{(S.devices.reduce((n, d) => n + (d.online ? d.kbps : 0), 0) / 1000).toFixed(1)} Mbit/s</b></span>
        <input className="input search" type="search" placeholder="Search name, address, system, id, zone…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="spacer" />
        <button className={S.cfg.source === "clicks" ? "btn soft" : "btn"} onClick={() => send({ t: "set_source", source: S.cfg.source === "clicks" ? "system" : "clicks", device: S.cfg.device })}>
          <Icon name="pulse" />{S.cfg.source === "clicks" ? "Stop sync test" : "Sync test clicks"}</button>
        <button className="btn accent" onClick={() => setCalib(true)}><Icon name="target" />Auto-calibrate</button>
      </div>
      <Zones S={S} />
      <div className="grid g-auto">
        {!S.devices.length && <div className="card empty-np"><Icon name="devices" /> No phones paired yet.</div>}
        {!!S.devices.length && !shown.length && <div className="card empty-np"><Icon name="devices" /> No phone matches "{query}".</div>}
        {shown.map((d) => <DeviceCard key={d.device_id} d={d} zones={zones} tick={tick.current} />)}
      </div>
      {past.length > 0 && (
        <div className="card" style={{ marginTop: 18 }}>
          <div className="card-h"><h3>Past devices</h3><span className="muted">Phones that pressed "Forget this PC". Kept on record; they can't come back without pairing and approval.</span><div className="spacer" />
            <button className="btn sm ghost" onClick={() => setPicked(picked.length === past.length ? [] : past.map((p) => p.device_id))}>{picked.length === past.length ? "Select none" : "Select all"}</button>
            <button className="btn sm danger" disabled={!picked.length} onClick={() => confirm(`Delete ${picked.length} record${picked.length > 1 ? "s" : ""}? This can't be undone.`) && (picked.forEach((device_id) => send({ t: "forget", device_id })), setPicked([]))}><Icon name="trash" />Delete selected{picked.length ? ` (${picked.length})` : ""}</button>
            <button className="btn sm danger" onClick={() => confirm(`Delete all ${past.length} past device records? This can't be undone.`) && (past.forEach((p) => send({ t: "forget", device_id: p.device_id })), setPicked([]))}>Delete all</button></div>
          {past.map((p) => (
            <label className="prow pick" key={p.device_id}>
              <input type="checkbox" checked={picked.includes(p.device_id)} onChange={(e) => setPicked(e.target.checked ? [...picked, p.device_id] : picked.filter((x) => x !== p.device_id))} />
              <div style={{ flex: 1, minWidth: 0 }}><b>{p.name}</b><div className="dev-meta">{p.platform || "Device"} · last address {p.ip || "unknown"} · id {p.device_id.slice(0, 6)}</div></div>
              <button className="btn sm danger" onClick={(e) => { e.preventDefault(); send({ t: "block", device_id: p.device_id, on: true }); }}>Block</button>
              <button className="btn sm ghost" onClick={(e) => { e.preventDefault(); if (confirm(`Delete the record of ${p.name}?`)) send({ t: "forget", device_id: p.device_id }); }}><Icon name="trash" />Delete</button>
            </label>
          ))}
        </div>
      )}
      {calib && <CalibrateDialog close={() => setCalib(false)} />}
    </>
  );
}
