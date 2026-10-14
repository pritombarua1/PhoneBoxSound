import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Icon } from "../../lib/icons";
import { useStore } from "../../lib/store";
import { Art, Seg, Switch } from "../../lib/ui";
import { cx } from "../../lib/util";
import { cmd, intercomLevel, meter, phone, send } from "../engine";

const Studio = lazy(() => import("../Studio"));
const VIEWS = [{ v: "me", label: "This phone" }, { v: "all", label: "All speakers" }] as const;
const CH: Record<string, [string, string]> = { stereo: ["Stereo", "ST"], left: ["Left", "L"], right: ["Right", "R"], mono: ["Mono", "M"], sub: ["Bass only", "SUB"], rear: ["Rear / ambience", "RE"] };

/** The orb pulses with the audio level. Animated by writing a CSS variable, not by re-rendering. */
function Orb({ label, off }: { label: string; off: boolean }) {
  const r1 = useRef<HTMLDivElement>(null), r2 = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const s = (1 + Math.min(Math.max(meter.level, intercomLevel()), 1) * 0.3).toFixed(3);
      r1.current?.style.setProperty("--s", s); r2.current?.style.setProperty("--s", s);
      meter.level *= 0.93;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return <div className="orb-wrap"><div className="ring r2" ref={r2} /><div className="ring" ref={r1} /><div className={cx("orb", off && "off")}>{label}</div></div>;
}

export default function Speaker({ go }: { go: (t: string) => void }) {
  const cfg = useStore(phone, (s) => s.cfg);
  const stats = useStore(phone, (s) => s.stats);
  const synced = useStore(phone, (s) => s.synced);
  const a = useStore(phone, (s) => s.media)?.active ?? null;

  // the connection has been weak for a while: say what helps
  const weak = !!cfg.speaker && (cfg.link === "weak" || cfg.link === "poor") && (cfg.link_weak_s ?? 0) >= 6;
  const closer = cfg.on_hotspot ? "Move closer to the PC (this phone is on the PC's own hotspot)" : "Move closer to your Wi-Fi router, or away from walls and microwaves between you and it";
  let status: React.ReactNode, warn = false;
  if (!cfg.speaker) status = <><b>Remote mode</b> · no audio on this phone</>;
  else if (!cfg.streaming) { status = <><b>Paused</b> from the PC</>; warn = true; }
  else if (!synced) { status = "Syncing clock…"; warn = true; }
  else if (stats?.waiting) { status = <b>Waiting for audio…</b>; warn = true; }
  else if ((stats?.late_recent ?? 0) > 3) { status = <><b>Unstable Wi-Fi</b> · buffer {cfg.latency_ms} ms</>; warn = true; }
  else status = <><b>In sync</b> · {cfg.latency_ms} ms · ping {Math.round(stats?.rtt_ms ?? 0)} ms</>;

  const [view, setView] = useState<"me" | "all">("me");
  const canManage = !!cfg.perms.manage;
  if (canManage && view === "all") {
    return (
      <>
        <Seg value={view} options={VIEWS} onChange={setView} style={{ alignSelf: "center" }} />
        <Suspense fallback={null}><Studio /></Suspense>
      </>
    );
  }
  return (
    <>
      {weak && (
        <div className={`card linkwarn ${cfg.link}`}>
          <Icon name="wifi" />
          <div><b>{cfg.link === "poor" ? "The connection here is poor" : "The connection here is weak"}</b>
            <span>{closer}.{cfg.auto_saver ? " Sound was switched to the lighter stream so it keeps playing; it goes back by itself." : ""}</span></div>
        </div>
      )}
      {canManage && <Seg value={view} options={VIEWS} onChange={setView} style={{ alignSelf: "center" }} />}
      <Orb label={CH[cfg.channel]?.[1] ?? "ST"} off={!cfg.speaker} />
      <div className="center"><div className="pname">{cfg.name}</div><div className={cx("status", warn && "warn")}>{status}</div></div>
      <div className="chips">
        <span className="pill">Channel <b>{CH[cfg.channel]?.[0] ?? "Stereo"}</b></span>
        <span className="pill">Volume <b>{cfg.muted ? "Muted" : Math.round(cfg.volume * 100) + "%"}</b></span>
        <span className="pill">Zone <b>{cfg.zone || "–"}</b></span>
      </div>
      <div className="card" style={{ padding: "14px 16px" }}>
        <div className="row">
          <Icon name="speaker" />
          <div style={{ flex: 1 }}><b>Play PC audio here</b>
            <div className="muted" style={{ fontSize: 12.5 }}>{!cfg.perms.speaker ? "Speaker turned off from the PC" : cfg.speaker_pref ? "This phone is a speaker" : "Remote only (no audio)"}</div></div>
          <Switch checked={cfg.speaker_pref} disabled={!cfg.perms.speaker} onChange={(v) => send({ t: "set_self", speaker: v })} />
        </div>
      </div>
      {a && (
        <div className="card mini" onClick={() => go("remote")}>
          <Art hash={a.art} />
          <div style={{ minWidth: 0, flex: 1 }}><div className="t">{a.title || a.app}</div><div className="a">{a.artist || a.app}</div></div>
          <button className="iconbtn" onClick={(e) => { e.stopPropagation(); cmd("toggle"); }}><Icon name={a.status === "playing" ? "pause" : "play"} /></button>
        </div>
      )}
    </>
  );
}
