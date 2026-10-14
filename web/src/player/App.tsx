import { lazy, Suspense, useState } from "react";
import { Icon } from "../lib/icons";
import { useStore } from "../lib/store";
import { cx, store } from "../lib/util";
import { forgetPc, getDeviceId, initialCode, phone, platform, resumeAudio, start, switchToCode } from "./engine";
import { PowerCountdown } from "./Power";
import Speaker from "./tabs/Speaker";

const Remote = lazy(() => import("./tabs/Remote"));
const Intercom = lazy(() => import("./tabs/Intercom"));
const More = lazy(() => import("./tabs/More"));

const TABS = [
  { id: "speaker", label: "Speaker", icon: "home" },
  { id: "remote", label: "Remote", icon: "remote" },
  { id: "intercom", label: "Intercom", icon: "mic" },
  { id: "more", label: "More", icon: "settings" },
] as const;
type TabId = (typeof TABS)[number]["id"];

function Join() {
  const err = useStore(phone, (s) => s.err);
  const hasToken = useStore(phone, (s) => s.hasToken);
  const handoff = useStore(phone, (s) => s.handoff);
  const guest = useStore(phone, (s) => s.guest);
  const [code, setCode] = useState(initialCode);
  const [name, setName] = useState(store.get("pbs.name") || "");
  const quick = hasToken || handoff;
  return (
    <div className="app">
      <div className="join">
        <div className="hero"><Icon name="logo" /><h1>PhoneBoxSound</h1><div className="muted">Your PC sound. Everywhere.</div></div>
        {quick ? (
          <div className="col">
            <button className="btn accent bigbtn" onClick={() => start("", "")}>{guest ? "Join as a guest speaker" : <>Connect{handoff ? " in secure mode" : name ? ` as ${name}` : ""}</>}</button>
            {guest && <div className="muted" style={{ textAlign: "center" }}>A guest pass: this phone plays the music for a couple of hours, then it is removed again.</div>}
            {!handoff && <button className="btn ghost" onClick={switchToCode}>Use a room code instead</button>}
          </div>
        ) : (
          <form className="col" onSubmit={(e) => { e.preventDefault(); start(code.trim(), name.trim()); }}>
            <div><div className="label" style={{ marginBottom: 6 }}>Room code</div>
              <input className="input code" inputMode="numeric" maxLength={4} autoComplete="off" placeholder="••••" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} /></div>
            <div><div className="label" style={{ marginBottom: 6 }}>Speaker name</div>
              <input className="input" maxLength={32} autoComplete="off" placeholder={`${platform} ${String(getDeviceId() || "").slice(0, 3).toUpperCase()}`.trim() || "Kitchen, TV Left…"} value={name} onChange={(e) => setName(e.target.value)} /></div>
            <button className="btn accent bigbtn" type="submit">Join</button>
          </form>
        )}
        <div className="err">{err}</div>
      </div>
    </div>
  );
}

function Waiting() {
  const online = useStore(phone, (s) => s.online);
  return (
    <div className="app">
      <div className="join">
        <div className="hero"><Icon name="shield" /><h1>Waiting for approval</h1>
          <div className="muted">The code was right. Now this phone has to be approved on the PC: open <b>Devices</b> and press <b>Approve</b> next to <b>{store.get("pbs.name") || "this phone"}</b>.</div></div>
        <div className="waitdots" aria-hidden="true"><i /><i /><i /></div>
        <div className="muted" style={{ textAlign: "center", fontSize: 13.5 }}>{online ? "This page continues by itself once you're approved." : "Reconnecting…"}</div>
        <button className="btn ghost" onClick={forgetPc}>Cancel</button>
      </div>
    </div>
  );
}

function Main() {
  const [tab, setTab] = useState<TabId>(() => (store.get("pbs.tab", "speaker") as TabId));
  const online = useStore(phone, (s) => s.online);
  const go = (t: string) => { setTab(t as TabId); store.set("pbs.tab", t); window.scrollTo(0, 0); };
  const active = TABS.some((t) => t.id === tab) ? tab : "speaker";
  return (
    <>
      <div className="app">
        <div className="bar">
          <div className="brand"><Icon name="logo" />PhoneBoxSound</div><div className="spacer" />
          <span className={cx("dot", online ? "good" : "warn")} />
          <button className="iconbtn" onClick={() => go("more")}><Icon name="settings" /></button>
        </div>
        <section className="tab on" key={active}>
          <Suspense fallback={null}>
            {active === "speaker" && <Speaker go={go} />}
            {active === "remote" && <Remote />}
            {active === "intercom" && <Intercom />}
            {active === "more" && <More />}
          </Suspense>
        </section>
      </div>
      <nav className="nav"><div>
        {TABS.map((t) => <button key={t.id} className={active === t.id ? "on" : ""} onClick={() => go(t.id)}><Icon name={t.icon} />{t.label}</button>)}
      </div></nav>
    </>
  );
}

export default function App() {
  const view = useStore(phone, (s) => s.view);
  const online = useStore(phone, (s) => s.online);
  const tapOver = useStore(phone, (s) => s.tapOver);
  const identify = useStore(phone, (s) => s.identify);
  const name = useStore(phone, (s) => s.cfg.name);
  return (
    <>
      <div className={cx("banner", view === "main" && !online && "show")}>Reconnecting…</div>
      {view === "join" ? <Join /> : view === "waiting" ? <Waiting /> : <Main />}
      {identify !== null && (
        <div className="overlay identify" onClick={() => phone.set({ identify: null })}>
          <div className="n">#{identify || "?"}</div><div className="nm">{name}</div><div>PhoneBoxSound</div>
        </div>
      )}
      {view === "main" && <PowerCountdown />}
      {tapOver && view === "main" && (
        <div className="overlay tapover" onClick={resumeAudio}>
          <Icon name="volume" /><b style={{ fontSize: 20 }}>Tap to resume audio</b>
          <span className="muted">The phone paused audio (a call, Siri or another app).</span>
          <button className="btn accent bigbtn" style={{ maxWidth: 280 }}>Resume</button>
        </div>
      )}
    </>
  );
}
