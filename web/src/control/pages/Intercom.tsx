import { useEffect, useState } from "react";
import { Icon } from "../../lib/icons";
import { useStore } from "../../lib/store";
import { Range, Switch } from "../../lib/ui";
import { cx } from "../../lib/util";
import { AnnounceCard } from "../extras";
import { app, prefs, setGlobal, talkStart, talkStop } from "../store";

export default function Intercom() {
  const S = useStore(app, (s) => s.S)!;
  const talking = useStore(app, (s) => s.talking);
  const targets = S.targets.filter((t) => t.id !== "pc");
  const [target, setTarget] = useState("all");
  const [play, setPlay] = useState(prefs.playIntercom);
  const label = (id: string) => S.targets.find((t) => t.id === id)?.label || id;

  useEffect(() => {   // hold Space to talk
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat || /INPUT|TEXTAREA|SELECT/.test((document.activeElement as HTMLElement)?.tagName)) return;
      e.preventDefault(); talkStart(target);
    };
    const up = (e: KeyboardEvent) => { if (e.code === "Space") talkStop(); };
    document.addEventListener("keydown", down); document.addEventListener("keyup", up);
    return () => { document.removeEventListener("keydown", down); document.removeEventListener("keyup", up); talkStop(); };
  }, [target]);

  return (
    <>
    <div style={{ marginBottom: 18 }}><AnnounceCard S={S} /></div>
    <div className="grid g-2">
      <div className="card" style={{ textAlign: "center" }}>
        <div className="card-h"><h3>Talk from this PC</h3></div>
        <select className="input" style={{ maxWidth: 280, margin: "0 auto" }} value={target} onChange={(e) => setTarget(e.target.value)}>
          {targets.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
        <button className={cx("talk", talking && "live")}
          onPointerDown={(e) => { e.preventDefault(); try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ } talkStart(target); }}
          onPointerUp={talkStop} onPointerCancel={talkStop}>
          <span className="col" style={{ alignItems: "center", gap: 6 }}><Icon name="mic" /><span>{talking ? "TALKING" : "HOLD TO TALK"}</span></span>
        </button>
        <p className="note">Hold the button (or the <b>Space</b> key) and speak. Music on the phones ducks while anyone talks.</p>
        <div className="field" style={{ textAlign: "left" }}>
          <div className="lbl"><span>Music level while talking</span><b>{Math.round(S.cfg.duck_level * 100)}%</b></div>
          <Range value={S.cfg.duck_level} step={0.05} onChange={(v) => setGlobal({ duck_level: v })} />
        </div>
        <div className="perm-row" style={{ textAlign: "left" }}>Play phones' intercom on this PC<div className="spacer" />
          <Switch checked={play} onChange={(v) => { prefs.playIntercom = v; setPlay(v); }} /></div>
      </div>
      <div className="col" style={{ gap: 20 }}>
        <div className="card">
          <div className="card-h"><h3>Live</h3></div>
          <div className="col" style={{ gap: 8 }}>
            {!S.talkers.length && <span className="muted">Nobody is talking.</span>}
            {S.talkers.map((t, i) => <div className="row" key={i}><span className="dot bad" /><b>{t.name}</b><span className="muted">talking to {label(t.target)}</span></div>)}
          </div>
        </div>
        <div className="card">
          <div className="card-h"><h3>Phones</h3></div>
          <div className="col" style={{ gap: 6 }}>
            {!S.devices.some((d) => d.online) && <span className="muted">No phones online.</span>}
            {S.devices.filter((d) => d.online).map((d) => (
              <div className="row" key={d.device_id}><span>{d.name}</span><div className="spacer" />
                <span className="pill">{d.perms.intercom ? (d.secure ? "Can talk" : "Listen only (not on secure link)") : "Intercom off"}</span></div>
            ))}
          </div>
          <p className="note">Phone browsers only allow the microphone on a secure (https) page. The phone app offers a one-tap switch on its Intercom tab; accept the certificate warning once.</p>
        </div>
      </div>
    </div>
    </>
  );
}
