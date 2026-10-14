import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { Icon } from "../lib/icons";
import { useStore } from "../lib/store";
import { applyTheme } from "../lib/theme";
import { SwapIcon } from "../lib/ui";
import { cx } from "../lib/util";
import { auth, lockNow } from "./auth";
import { app, send, setGlobal } from "./store";
import Terms from "./Terms";

// Each page is its own chunk: the dashboard paints first, the rest load when opened.
const pages = {
  dashboard: lazy(() => import("./pages/Dashboard")),
  nowplaying: lazy(() => import("./pages/NowPlaying")),
  devices: lazy(() => import("./pages/Devices")),
  remote: lazy(() => import("./pages/Remote")),
  intercom: lazy(() => import("./pages/Intercom")),
  presets: lazy(() => import("./pages/Presets")),
  activity: lazy(() => import("./pages/Activity")),
  settings: lazy(() => import("./pages/Settings")),
} as const;
type PageId = keyof typeof pages;

const NAV: { id: PageId; label: string; icon: string }[] = [
  { id: "dashboard", label: "Dashboard", icon: "home" },
  { id: "nowplaying", label: "Now Playing", icon: "music" },
  { id: "devices", label: "Devices", icon: "devices" },
  { id: "remote", label: "Remote", icon: "remote" },
  { id: "intercom", label: "Intercom", icon: "mic" },
  { id: "presets", label: "Presets", icon: "presets" },
  { id: "activity", label: "Activity", icon: "pulse" },
  { id: "settings", label: "Settings", icon: "settings" },
];

/** Every page has its own address: /devices, /settings… (old #devices links still land correctly). */
const fromUrl = (): PageId => {
  const old = location.hash.slice(1) as PageId;
  if (old in pages) history.replaceState(null, "", "/" + old);
  const p = location.pathname.slice(1) as PageId;
  return p in pages ? p : "dashboard";
};

export default function App() {
  const [page, setPage] = useState<PageId>(fromUrl);
  const S = useStore(app, (s) => s.S);
  const connected = useStore(app, (s) => s.connected);
  const locked = useStore(auth, (s) => !!s.a?.required);

  useEffect(() => {
    const on = () => setPage(fromUrl());
    window.addEventListener("popstate", on);
    window.addEventListener("hashchange", on);
    return () => { window.removeEventListener("popstate", on); window.removeEventListener("hashchange", on); };
  }, []);
  const go = useCallback((p: string) => { if (location.pathname !== "/" + p) history.pushState(null, "", "/" + p); setPage(p in pages ? (p as PageId) : "dashboard"); window.scrollTo(0, 0); }, []);

  const c = S?.cfg, cap = S?.capture;
  const capOk = cap?.status === "capturing";
  const online = S?.devices.filter((d) => d.online).length ?? 0;
  const dark = document.documentElement.dataset.mode === "dark";
  const Page = pages[page] as React.ComponentType<{ go: (p: string) => void }>;

  return (
    <div className="shell">
      {S && S.terms_ok === false && <Terms />}
      <aside className="side">
        <div className="brand"><Icon name="logo" />PhoneBoxSound</div>
        <nav className="nav">
          {NAV.map((n) => (
            <a key={n.id} href={"/" + n.id} className={cx(page === n.id && "on")} onClick={(e) => { if (e.ctrlKey || e.metaKey || e.shiftKey) return; e.preventDefault(); go(n.id); }}>
              <Icon name={n.icon} />{n.label}{n.id === "devices" && !!S?.pending.length && <span className="badge warn" title="Waiting for approval">{S.pending.length} new</span>}
            </a>
          ))}
        </nav>
        <div className="side-foot">
          <span className={cx("dot", !connected ? "bad" : capOk ? "good" : "warn")} />
          <div><b>{!connected ? "Server stopped" : capOk ? "Server Running" : "Server running (no audio)"}</b>
            <div className="mono">{S ? `${S.ips[0]}:${S.ports.http}` : ""}</div></div>
          {locked && <button className="iconbtn" title="Lock the dashboard now" style={{ marginLeft: "auto" }} onClick={lockNow}><Icon name="lock" /></button>}
        </div>
      </aside>

      <div className="main">
        <header className="top">
          <h1>{NAV.find((n) => n.id === page)!.label}</h1>
          <div className="spacer" />
          {S && <>
            <span className="pill hide-sm"><span className={cx("dot", capOk ? (c!.streaming ? "good" : "warn") : "bad")} />
              {capOk ? (cap!.device || "").replace(" [Loopback]", "") : cap!.status === "error" ? "Capture error" : "Starting…"}</span>
            <span className="pill hide-sm" title="Current sync buffer">Buffer <b>{c!.latency_ms} ms{c!.auto_latency ? " auto" : ""}</b></span>
            <button className="iconbtn" title="Toggle light/dark" onClick={() => { const next = dark ? "light" : "dark"; applyTheme(null, next); setGlobal({ mode: next }); }}>
              <Icon name={dark ? "sun" : "moon"} /></button>
            {S!.bedtime && <span className="pill" title="Bedtime timer running (Presets)"><Icon name="moon" />fading · {Math.ceil(S!.bedtime.left_s / 60)} min</span>}
            <button className={cx("btn", c!.lockdown ? "danger" : "ghost")} title="Lockdown: phones keep playing, but none can control this PC and no new phone can join"
              onClick={() => setGlobal({ lockdown: !c!.lockdown })}><Icon name="shield" /><span className="hide-sm">{c!.lockdown ? "Locked down" : "Lockdown"}</span></button>
            <button className={c!.streaming ? "btn soft" : "btn accent"} onClick={() => setGlobal({ streaming: !c!.streaming })}>
              <SwapIcon name={c!.streaming ? "pause" : "play"} />{c!.streaming ? "Pause All" : "Resume"}</button>
          </>}
        </header>
        {S?.host && (
          <div className="power-banner host"><Icon name="music" /><span><b>{S.host}</b> is hosting the music from their phone</span>
            <div className="spacer" /><button className="btn sm" onClick={() => send({ t: "host_stop" })}>Back to PC audio</button></div>
        )}
        {S?.power && (
          <div className="power-banner"><Icon name="power" />
            <span><b>{({ lock: "Locking", sleep: "Going to sleep", restart: "Restarting", shutdown: "Shutting down" } as Record<string, string>)[S.power.action] ?? S.power.action}</b> in {S.power.seconds} s · asked by {S.power.by}</span>
            <div className="spacer" /><button className="btn sm" onClick={() => send({ t: "power_cancel" })}>Cancel</button></div>
        )}
        <section className="page on" key={page}>
          {S ? <Suspense fallback={null}><Page go={go} /></Suspense> : <p className="muted">Connecting to PhoneBoxSound…</p>}
        </section>
      </div>
    </div>
  );
}
