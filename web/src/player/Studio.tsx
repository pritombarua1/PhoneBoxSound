import { memo, useEffect, useState } from "react";
import { Icon } from "../lib/icons";
import { useStore } from "../lib/store";
import type { StudioDevice } from "../lib/types";
import { Range, Seg, Switch } from "../lib/ui";
import { clamp, cx, vibrate } from "../lib/util";
import { manage, phone, send } from "./engine";

const CH = [{ v: "left", label: "L" }, { v: "right", label: "R" }, { v: "stereo", label: "Stereo" }, { v: "mono", label: "Mono" }] as const;
const LAYOUTS = [{ v: "stereo", label: "All stereo" }, { v: "split", label: "L / R split" }, { v: "mono", label: "All mono" }] as const;
const DOT: Record<string, string> = { stable: "good", jitter: "warn", buffering: "bad", unresponsive: "bad", suspended: "bad", remote: "info", offline: "", starting: "warn" };

function Name({ d, onCommit }: { d: StudioDevice; onCommit: (name: string) => void }) {
  const [v, setV] = useState(d.name);
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (!editing) setV(d.name); }, [d.name, editing]);
  return <input className="input rename" maxLength={32} value={v} aria-label="Name" onFocus={() => setEditing(true)} onChange={(e) => setV(e.target.value)}
    onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
    onBlur={() => { setEditing(false); const n = v.trim(); if (n && n !== d.name) onCommit(n); else setV(d.name); }} />;
}

const Device = memo(function Device({ d }: { d: StudioDevice }) {
  const s = d.settings;
  const set = (patch: object) => manage({ t: "set_device", device_id: d.device_id, patch });
  const nudge = (by: number) => { vibrate(6); set({ offset_ms: clamp(s.offset_ms + by, -1000, 1000) }); };
  return (
    <div className={cx("card studio-dev", !d.online && "off")}>
      <div className="row">
        <span className={`dot ${DOT[d.health] ?? ""}`} />
        <Name d={d} onCommit={(name) => set({ name })} />{d.me && <span className="muted" style={{ fontSize: 12.5 }}>this phone</span>}
        <span className="muted tnum" style={{ fontSize: 12.5 }}>{d.online ? (d.buffer != null ? `${d.buffer} ms` : "") : "offline"}</span>
        <button className="iconbtn" title="Identify" disabled={!d.online} onClick={() => manage({ t: "identify", device_id: d.device_id })}><Icon name="bell" /></button>
        <button className={cx("iconbtn", s.muted && "active")} title={s.muted ? "Unmute" : "Mute"} onClick={() => set({ muted: !s.muted })}><Icon name={s.muted ? "mute" : "volume"} /></button>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <Range value={s.volume} min={0} max={1.5} onChange={(v) => set({ volume: v })} />
        <span className="muted tnum" style={{ width: 44, textAlign: "right" }}>{Math.round(s.volume * 100)}%</span>
      </div>
      <Seg value={s.channel as any} options={CH} onChange={(v) => set({ channel: v })} className="full" style={{ marginTop: 8 }} />
      <div className="nudge">
        <span className="muted">Timing</span>
        <button onClick={() => nudge(-10)}>−10</button><button onClick={() => nudge(-2)}>−2</button>
        <b className="tnum" onClick={() => set({ offset_ms: 0 })} title="Tap to reset">{s.offset_ms > 0 ? "+" : ""}{s.offset_ms} ms</b>
        <button onClick={() => nudge(2)}>+2</button><button onClick={() => nudge(10)}>+10</button>
      </div>
    </div>
  );
});

/**
 * Every speaker, from this phone: volume, channel, timing, layout, master volume, click test.
 * So you can line the room up from the sofa instead of walking to the PC.
 */
export default memo(function Studio() {
  const studio = useStore(phone, (s) => s.studio);
  const [after, setAfter] = useState("pause");
  useEffect(() => { send({ t: "manage_watch", on: true }); return () => send({ t: "manage_watch", on: false }); }, []);
  if (!studio) return <div className="muted center">Loading speakers…</div>;
  const c = studio.cfg, clicks = c.source === "clicks";
  const b = studio.bedtime;
  return (
    <>
      <div className="card">
        <div className="row"><Icon name="moon" /><b style={{ flex: 1 }}>Bedtime</b>
          {b ? <><span className="muted tnum">{Math.ceil(b.left_s / 60)} min left</span><button className="btn sm" onClick={() => send({ t: "bedtime", cancel: true })}>Cancel</button></>
            : <select className="input" style={{ maxWidth: 150, padding: "6px 8px" }} value={after} onChange={(e) => setAfter(e.target.value)}>
                <option value="pause">then pause</option><option value="none">just fade</option>
                {studio.may_power && <><option value="lock">then lock PC</option><option value="sleep">then sleep</option><option value="shutdown">then shut down</option></>}
              </select>}
        </div>
        {!b && <div className="row" style={{ marginTop: 10, gap: 8 }}>{[15, 30, 45, 60].map((m) => <button key={m} className="btn sm" style={{ flex: 1 }} onClick={() => send({ t: "bedtime", minutes: m, after })}>{m} min</button>)}</div>}
      </div>
      <div className="card">
        <div className="row"><b style={{ flex: 1 }}>All speakers</b>
          <button className={cx("btn sm", !c.streaming && "accent")} onClick={() => manage({ t: "set_global", streaming: !c.streaming })}><Icon name={c.streaming ? "pause" : "play"} />{c.streaming ? "Pause all" : "Resume"}</button></div>
        <div className="row" style={{ marginTop: 10 }}>
          <Icon name="volume" /><Range value={c.master} min={0} max={1.5} onChange={(v) => manage({ t: "set_global", master: v })} />
          <span className="muted tnum" style={{ width: 44, textAlign: "right" }}>{Math.round(c.master * 100)}%</span>
        </div>
        <Seg value={null} options={LAYOUTS} onChange={(v) => manage({ t: "layout", kind: v })} className="full" style={{ marginTop: 10 }} />
        <div className="row" style={{ marginTop: 12 }}>
          <span style={{ flex: 1 }}>Auto sync buffer <span className="muted tnum">· {c.latency_ms} ms</span></span>
          <Switch checked={c.auto_latency} onChange={(v) => manage({ t: "set_global", auto_latency: v })} />
        </div>
        <button className={cx("btn", clicks && "soft")} style={{ marginTop: 10, width: "100%" }} onClick={() => manage({ t: "click_test" })}>
          <Icon name="pulse" />{clicks ? "Stop the click test" : "Click test: line phones up by ear"}</button>
        {clicks && <div className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>Use Timing −/+ on the phone that sounds off until all phones click as one. − is earlier, + is later.</div>}
      </div>
      {studio.devices.map((d) => <Device key={d.device_id} d={d} />)}
    </>
  );
});
