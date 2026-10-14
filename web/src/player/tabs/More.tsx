import { useEffect, useState } from "react";
import { Icon } from "../../lib/icons";
import { useStore } from "../../lib/store";
import { currentTheme, THEMES } from "../../lib/theme";
import { Fold, Seg, Switch } from "../../lib/ui";
import { clamp, copyText, cx, store, toast } from "../../lib/util";
import { applyTextSize, forgetPc, phone, reapplyTheme, send, setShake, shake, stop } from "../engine";
import Host from "../Host";

const SIZES = [{ v: "1", label: "Normal" }, { v: "1.15", label: "Large" }, { v: "1.3", label: "Larger" }, { v: "1.5", label: "Largest" }] as const;

const MODES = [{ v: "pc", label: "PC" }, { v: "dark", label: "Dark" }, { v: "light", label: "Light" }] as const;
const standalone = matchMedia("(display-mode: standalone)").matches || (navigator as any).standalone;

/** Settings for this phone. Only the essentials are open; the rest unfold when needed. */
export default function More() {
  const cfg = useStore(phone, (s) => s.cfg);
  const stats = useStore(phone, (s) => s.stats);
  const invite = useStore(phone, (s) => s.invite);
  const [name, setName] = useState(cfg.name);
  const [editing, setEditing] = useState(false);
  const sh = useStore(shake, (x) => x);
  const [theme, setTheme] = useState(() => store.get("pbs.theme", "pc")!);
  const [mode, setMode] = useState(() => store.get("pbs.mode", "pc")!);
  const [ui, setUi] = useState(() => store.get("pbs.ui", "1")!);
  useEffect(() => { if (!editing) setName(cfg.name); }, [cfg.name, editing]);

  const pickTheme = (t: string) => { store.set("pbs.theme", t); setTheme(t); reapplyTheme(); };
  const pickMode = (m: string) => { store.set("pbs.mode", m); setMode(m); reapplyTheme(); };
  const nudge = (d: number | "reset") => send({ t: "set_self", offset_ms: d === "reset" ? 0 : clamp(cfg.offset_ms + d, -1000, 1000) });
  const share = () => {
    if (!invite) return;
    if (navigator.share) navigator.share({ title: "PhoneBoxSound", text: "Join my PhoneBoxSound speakers", url: invite.link }).catch(() => {});
    else copyText(invite.link).then((ok) => toast(ok ? "Link copied" : invite.link, ok ? 2200 : 6000));
  };
  const warn = !stats || stats.waiting || stats.late_recent > 3;
  const kv: [string, string | number][] = stats ? [
    ["Buffer", stats.ahead_ms + " ms"], ["Ping", stats.rtt_ms + " ms"], ["Jitter", (stats.jitter_ms ?? "–") + " ms"],
    ["Dropouts", stats.late], ["Resyncs", stats.resyncs], ["Output", (stats.out_latency_ms ?? "–") + " ms"],
    ["Sync buffer", cfg.latency_ms + " ms"], ["Offset", cfg.offset_ms + " ms"], ["Rate", stats.rate + "×"],
  ] : [];
  const themeName = theme === "pc" ? "Same as PC" : THEMES.find((t) => t.id === theme)?.name;

  return (
    <>
      {!!cfg.pending?.length && (
        <div className="card secnote approvals">
          <div className="row"><Icon name="shield" /><b style={{ flex: 1 }}>{cfg.pending.length === 1 ? "A phone wants to join" : `${cfg.pending.length} phones want to join`}</b></div>
          {cfg.pending.map((p) => (
            <div className="row" key={p.device_id} style={{ marginTop: 10 }}>
              <div style={{ flex: 1, minWidth: 0 }}><b>{p.name}</b><div className="muted" style={{ fontSize: 12.5 }}>{p.platform || "Device"} · {p.ip}{p.waiting ? "" : " · left"}</div></div>
              <button className="btn sm" onClick={() => send({ t: "approve", device_id: p.device_id, ok: false })}>Deny</button>
              <button className="btn sm accent" onClick={() => send({ t: "approve", device_id: p.device_id, ok: true })}>Approve</button>
            </div>
          ))}
        </div>
      )}
      <div className="card"><div className="list">
        <div className="item"><Icon name="devices" />
          <input className="input" maxLength={32} style={{ flex: 1 }} value={name} onFocus={() => setEditing(true)} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            onBlur={() => { setEditing(false); const n = name.trim(); if (n && n !== cfg.name) { store.set("pbs.name", n); send({ t: "set_self", name: n }); } }} /></div>
        <div className="item"><Icon name="speaker" /><span style={{ flex: 1 }}>Play PC audio here</span>
          <Switch checked={cfg.speaker_pref} disabled={!cfg.perms.speaker} onChange={(v) => send({ t: "set_self", speaker: v })} /></div>
        <div className="item"><Icon name="bell" /><span style={{ flex: 1 }}>Identify this phone</span><button className="btn sm" onClick={() => send({ t: "identify_self" })}>Show</button></div>
      </div></div>

      <Fold title="Security" icon="shield" value={cfg.verified ? "Verified" : cfg.locked?.length ? "Action needed" : "Basic"}>
        <div className="muted" style={{ fontSize: 13.5 }}>
          {cfg.verified
            ? "This phone holds its own security key. The PC checks it on every connection, so no other phone can pose as this one."
            : cfg.can_sign
              ? (cfg.verify_code ? `Waiting for the PC to verify this phone. Number: ${cfg.verify_code}` : "This phone can hold a security key; it is registered the next time it pairs.")
              : "This page is not on the secure link, so this phone can't hold a security key. Speaker, media remote and intercom listening still work."}
        </div>
        <div className="row" style={{ marginTop: 12 }}><div style={{ flex: 1 }}><b>Shake to lock down</b>
            <div className="muted" style={{ fontSize: 12.5 }}>{!cfg.perms.panic
              ? "Not allowed for this phone yet. On the PC: Devices → this phone → Shake to lock down (it needs the secure link)."
              : sh.note || (sh.on ? (sh.count ? `Shake felt (${sh.count} of 3, strength ${sh.peak})…` : "On. Three firm shakes put the PC in lockdown, while this page is open.") : "Three firm shakes put the PC in lockdown.")}</div></div>
          <Switch checked={sh.on} disabled={!cfg.perms.panic} onChange={(v) => setShake(v)} /></div>
        {!cfg.verified && !cfg.can_sign && cfg.https_url && <button className="btn accent" style={{ width: "100%", marginTop: 10 }} onClick={() => send({ t: "handoff" })}>Switch to the secure link</button>}
      </Fold>

      <Fold title="Text size" icon="target" value={SIZES.find((x) => x.v === ui)?.label}>
        <Seg value={ui as any} options={SIZES} onChange={(v) => { store.set("pbs.ui", v); setUi(v); applyTextSize(+v); }} className="full" />
        <div className="muted" style={{ fontSize: 13, marginTop: 8 }}>Makes everything in this app bigger on this phone.</div>
      </Fold>

      {cfg.perms.host && <Fold title="Play music from this phone" icon="music" value={cfg.hosting ? `Host: ${cfg.hosting}` : "Be the host"}><Host /></Fold>}

      <Fold title="Invite another phone" icon="plus" value="QR code" open={!!invite}>
        {!invite && <button className="btn accent" style={{ width: "100%" }} onClick={() => send({ t: "invite", theme: currentTheme() })}>Show QR code</button>}
        {invite && (
          <div className="center">
            <div className="qr-box" dangerouslySetInnerHTML={{ __html: invite.svg }} />
            <div className="mono" style={{ fontSize: 13, marginTop: 8 }}>{invite.url}</div>
            <div style={{ marginTop: 4 }}>Code <b className="tnum" style={{ fontSize: 22, letterSpacing: ".2em" }}>{invite.code}</b></div>
            <button className="btn sm" style={{ margin: "10px 0 0" }} onClick={share}>Share link</button>
          </div>
        )}
        <div className="muted" style={{ fontSize: 13, marginTop: 10 }}>The other phone scans this with its camera and joins straight away (same Wi-Fi).</div>
      </Fold>

      <Fold title="Sync nudge" icon="pulse" value={`${cfg.offset_ms > 0 ? "+" : ""}${cfg.offset_ms} ms`}>
        <div className="row">
          <button className="btn" onClick={() => nudge(-10)}>−10</button><button className="btn" onClick={() => nudge(-2)}>−2</button><div className="spacer" />
          <button className="btn sm ghost" onClick={() => nudge("reset")}>Reset</button><div className="spacer" />
          <button className="btn" onClick={() => nudge(2)}>+2</button><button className="btn" onClick={() => nudge(10)}>+10</button>
        </div>
        <div className="muted" style={{ fontSize: 13, marginTop: 8 }}>If this phone sounds like an echo next to another one: − plays earlier, + plays later. Start the <b>click test</b> and adjust until both phones click as one.</div>
        {cfg.perms.manage && <button className="btn sm" style={{ marginTop: 10 }} onClick={() => send({ t: "click_test" })}><Icon name="pulse" />Click test on / off</button>}
      </Fold>

      <Fold title="Theme" icon="sun" value={themeName}>
        <Seg value={mode as any} options={MODES} onChange={pickMode} className="full" />
        <div className="swatches" style={{ marginTop: 12 }}>
          <button className={cx("pc", theme === "pc" && "on")} onClick={() => pickTheme("pc")}>PC</button>
          {THEMES.map((t) => <button key={t.id} title={t.name} className={theme === t.id ? "on" : ""} style={{ background: t.swatch }} onClick={() => pickTheme(t.id)} />)}
        </div>
      </Fold>

      <Fold title="Connection" icon="wifi" value={warn ? "Check" : "Excellent"}>
        <div className="stats">{kv.map(([k, v]) => <div key={k}><span>{k}</span><b>{v}</b></div>)}</div>
      </Fold>

      {!standalone && (
        <Fold title="Add to Home Screen" icon="download" value="App">
          <div className="muted" style={{ fontSize: 13.5 }}>{/Android/.test(navigator.userAgent) ? "Browser menu → Add to Home screen / Install app." : "Share → Add to Home Screen for an app-like PhoneBoxSound."}</div>
        </Fold>
      )}
      <div className="row">
        <button className="btn" onClick={() => stop("")}><Icon name="logout" />Disconnect</button><div className="spacer" />
        <button className="btn danger" onClick={() => confirm("Forget this PC? You'll need the room code to connect again.") && forgetPc()}>Forget this PC</button>
      </div>
    </>
  );
}
