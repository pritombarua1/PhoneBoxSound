import { useState } from "react";
import { Icon } from "../../lib/icons";
import { useStore } from "../../lib/store";
import { cx, store } from "../../lib/util";
import { getDeviceId, micSecure, phone, send, talkDown, talkUp } from "../engine";

const LABEL = { idle: "HOLD OR TAP TO TALK", connecting: "CONNECTING…", live: "TALKING", latched: "TAP TO STOP" } as const;

export default function Intercom() {
  const cfg = useStore(phone, (s) => s.cfg);
  const targets = useStore(phone, (s) => s.targets);
  const talkers = useStore(phone, (s) => s.talkers);
  const talkState = useStore(phone, (s) => s.talkState);
  const mine = `device:${getDeviceId()}`;
  const options = targets.filter((t) => t.id !== mine);
  const [picked, setPicked] = useState(() => store.get("pbs.ictarget") || "all");
  const target = options.some((o) => o.id === picked) ? picked : "all";
  const canTalk = !!cfg.perms.intercom, secure = micSecure();
  const others = talkers.filter((t) => t.device_id !== getDeviceId());

  return (
    <>
      <div className="card">
        <div className="label" style={{ marginBottom: 6 }}>Talk to</div>
        <select className="input" value={target} onChange={(e) => { setPicked(e.target.value); store.set("pbs.ictarget", e.target.value); }}>
          {options.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
        <button className={cx("talk", talkState !== "idle" && "live", (!canTalk || !secure) && "dim")}
          onPointerDown={(e) => { e.preventDefault(); try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ } talkDown(target); }}
          onPointerUp={talkUp} onPointerCancel={talkUp} onContextMenu={(e) => e.preventDefault()}>
          <span className="col" style={{ alignItems: "center", gap: 6 }}><Icon name="mic" /><span>{LABEL[talkState]}</span></span>
        </button>
        <div className="center muted" style={{ fontSize: 13 }}>
          {!secure ? "Listening works now. Talking needs secure mode (below)." : "Hold and speak, or tap once to stay on and tap again to stop."}
        </div>
      </div>
      {others.length > 0 && <div className="incoming"><Icon name="volume" /><span>{others.map((t) => `${t.name} is talking`).join(", ")}</span></div>}
      {canTalk && !secure && cfg.https_url && (
        <div className="card">
          <div className="row" style={{ marginBottom: 8 }}><Icon name="shield" /><b>Enable the microphone</b></div>
          <div className="muted" style={{ fontSize: 13.5 }}>Phone browsers only allow the mic on a secure page. Tap below, then choose <b>Show details → visit this website</b> (Safari) or <b>Advanced → Proceed</b> (Chrome). You only do this once.</div>
          <button className="btn accent bigbtn" style={{ marginTop: 12 }} onClick={() => send({ t: "handoff" })}>Switch to secure mode</button>
        </div>
      )}
      {!canTalk && <div className="card lock"><Icon name="lock" /><b>Intercom is off for this phone</b></div>}
    </>
  );
}
