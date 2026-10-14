import { memo, useEffect, useState } from "react";
import { Icon } from "../lib/icons";
import { useStore } from "../lib/store";
import { Sheet } from "../lib/ui";
import { cx, vibrate } from "../lib/util";
import { phone, send } from "./engine";

const ACTIONS = [
  { id: "lock", label: "Lock", icon: "lock", verb: "Lock", ask: "Lock this PC?", note: "The PC locks straight away. Audio keeps playing.", danger: false },
  { id: "sleep", label: "Sleep", icon: "moon", verb: "Sleep", ask: "Put the PC to sleep?", note: "Audio stops and phones disconnect until the PC wakes up.", danger: false },
  { id: "restart", label: "Restart", icon: "refresh", verb: "Restart", ask: "Restart the PC?", note: "Unsaved work in open apps may be lost.", danger: true },
  { id: "shutdown", label: "Shut down", icon: "power", verb: "Shut down", ask: "Shut down the PC?", note: "Unsaved work in open apps may be lost. You can't turn it back on from here.", danger: true },
] as const;
type Action = (typeof ACTIONS)[number];

/** Power buttons. Every one asks first; restart, shut down and sleep then count down and can be cancelled. */
export default memo(function Power() {
  const [asking, setAsking] = useState<Action | null>(null);
  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="power-grid">
        {ACTIONS.map((a) => (
          <button key={a.id} className={cx("tile power", a.danger && "danger")} onClick={() => { vibrate(10); setAsking(a); }}>
            <span className="ico"><Icon name={a.icon} /></span>{a.label}
          </button>
        ))}
      </div>
      <div className="muted center" style={{ fontSize: 13 }}>Nothing happens until you confirm. Restart and shut down wait 10 seconds so you can still cancel.</div>
      {asking && (
        <Sheet title={asking.ask} close={() => setAsking(null)}>
          <p className="muted" style={{ margin: "0 0 14px" }}>{asking.note}</p>
          <div className="btn-row">
            <button className="btn" onClick={() => setAsking(null)}>Cancel</button>
            <button className={cx("btn", asking.danger ? "danger-solid" : "accent")} onClick={() => { vibrate([20, 40, 20]); send({ t: "power", action: asking.id }); setAsking(null); }}>
              <Icon name={asking.icon} />{asking.verb}
            </button>
          </div>
        </Sheet>
      )}
    </div>
  );
});

/** Full-screen countdown while a power action is pending. Shown on every phone that may use Power. */
export function PowerCountdown() {
  const p = useStore(phone, (s) => s.power);
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (!p) return;
    const tick = () => setLeft(Math.max(0, Math.ceil((p.until - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 200);
    return () => clearInterval(id);
  }, [p]);
  if (!p) return null;
  const a = ACTIONS.find((x) => x.id === p.action);
  const frac = p.total ? Math.max(0, Math.min(1, (p.until - Date.now()) / 1000 / p.total)) : 0;
  return (
    <div className="overlay power-over">
      <div className="count">
        <svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="52" className="bg" /><circle cx="60" cy="60" r="52" className="fg" style={{ strokeDashoffset: 327 * (1 - frac) }} /></svg>
        <b>{left}</b>
      </div>
      <b style={{ fontSize: 22 }}>{a?.label ?? p.action} in {left} s</b>
      <span className="muted">{p.by ? `Asked by ${p.by}` : ""}</span>
      <button className="btn bigbtn" style={{ maxWidth: 280 }} onClick={() => { vibrate(15); send({ t: "power", cancel: true }); }}>Cancel</button>
    </div>
  );
}
