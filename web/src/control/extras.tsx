import { useEffect, useState } from "react";
import { Icon } from "../lib/icons";
import { useStore } from "../lib/store";
import type { ServerState } from "../lib/types";
import { Seg } from "../lib/ui";
import { copyText, fmtTime, toast } from "../lib/util";
import { app, send } from "./store";

const MINUTES = [{ v: "15", label: "15" }, { v: "30", label: "30" }, { v: "45", label: "45" }, { v: "60", label: "60" }, { v: "90", label: "90 min" }] as const;
const AFTER = [{ v: "none", label: "Just fade" }, { v: "pause", label: "Pause" }, { v: "lock", label: "Lock PC" }, { v: "sleep", label: "Sleep" }, { v: "shutdown", label: "Shut down" }] as const;
const AFTER_WORDS: Record<string, string> = { none: "nothing else", pause: "the player pauses", lock: "the player pauses and the PC locks", sleep: "the player pauses and the PC sleeps", shutdown: "the player pauses and the PC shuts down" };

/** Bedtime: every phone fades to silence over the chosen time; then pause, and optionally lock / sleep / shut down. */
export function BedtimeCard() {
  const b = useStore(app, (s) => s.S?.bedtime ?? null);
  const [minutes, setMinutes] = useState("30"), [after, setAfter] = useState("pause");
  const [, tick] = useState(0);
  useEffect(() => { if (b) { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); } }, [!!b]);
  const at = useStore(app, (s) => s.stateAt);
  const left = b ? Math.max(0, b.left_s - (performance.now() - at) / 1000) : 0;
  return (
    <div className="card">
      <div className="card-h"><h3><Icon name="moon" /> Bedtime</h3><span className="sub">fade every phone out, then stop</span></div>
      {b ? <>
        <div className="bedtime-run"><b className="tnum">{fmtTime(left)}</b><span className="muted">left of {b.minutes} min, then {AFTER_WORDS[b.after]}. Started by {b.by}.</span></div>
        <div className="meter" style={{ margin: "10px 0" }}><i style={{ width: `${100 - (left / (b.minutes * 60)) * 100}%` }} /></div>
        <button className="btn" onClick={() => send({ t: "bedtime", cancel: true })}>Cancel and bring the volume back</button>
      </> : <>
        <div className="row" style={{ flexWrap: "wrap", gap: 10 }}><Seg value={minutes as any} options={MINUTES} onChange={(v) => setMinutes(v)} /><Seg value={after as any} options={AFTER} onChange={(v) => setAfter(v)} /></div>
        <p className="note">The volume goes down smoothly over the whole time; afterwards {AFTER_WORDS[after]}. Shut down still shows its 10-second countdown, which any phone with the Power permission can cancel.</p>
        <button className="btn accent" onClick={() => send({ t: "bedtime", minutes: Number(minutes), after })}><Icon name="moon" />Start</button>
      </>}
    </div>
  );
}

const SOUNDS = [{ v: "ding", label: "Ding" }, { v: "doorbell", label: "Doorbell" }, { v: "alert", label: "Alert" }, { v: "none", label: "No sound" }] as const;

/** A chime and/or spoken text on the phones, over the music. The same thing is available to a doorbell or home automation as a web address. */
export function AnnounceCard({ S }: { S: ServerState }) {
  const [text, setText] = useState(""), [sound, setSound] = useState("ding"), [target, setTarget] = useState("all");
  const go = () => { if (!text.trim() && sound === "none") return toast("Type something or pick a sound"); send({ t: "announce", text: text.trim(), sound: sound === "none" ? "" : sound, target }); toast("Announcing…"); };
  const curl = `curl -X POST -H "Authorization: Bearer ${S.api_token}" -H "Content-Type: application/json" -d "{\\"sound\\":\\"doorbell\\",\\"text\\":\\"Someone is at the door\\"}" http://${S.ips[0]}:${S.ports.http}/api/announce`;
  return (
    <div className="card">
      <div className="card-h"><h3><Icon name="bell" /> Announce</h3><span className="sub">a chime and spoken words on the phones</span></div>
      <div className="col">
        <input className="input" maxLength={300} placeholder="Dinner is ready" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && go()} />
        <div className="row" style={{ flexWrap: "wrap", gap: 10 }}>
          <Seg value={sound as any} options={SOUNDS} onChange={(v) => setSound(v)} />
          <select className="input" style={{ maxWidth: 200 }} value={target} onChange={(e) => setTarget(e.target.value)}>{S.targets.filter((t) => t.id !== "pc").map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</select>
          <div className="spacer" /><button className="btn accent" onClick={go}><Icon name="bell" />Announce</button>
        </div>
        <p className="note" style={{ margin: 0 }}>The words are spoken by Windows' own voice on this PC and sent to the phones like an intercom call, so the music dips and comes back. A doorbell, a timer or Home Assistant can do the same by calling one address:</p>
        <div className="row"><pre className="snippet" style={{ flex: 1, margin: 0 }}>POST /api/announce  {"{"}"sound":"doorbell","text":"Someone is at the door"{"}"}</pre>
          <button className="btn sm" onClick={async () => toast((await copyText(curl)) ? "Command copied (contains your API token)" : "Couldn't copy")}><Icon name="copy" />Copy command</button></div>
      </div>
    </div>
  );
}

/** A guest pass: a QR that lets a visitor's phone be a speaker for a few hours, then removes it again. */
export function GuestPass() {
  const pass = useStore(app, (s) => s.guest);
  const lockdown = useStore(app, (s) => !!s.S?.cfg.lockdown);
  return (
    <>
      <button className="btn sm" disabled={lockdown} title="A visitor scans it and their phone is a speaker for two hours. Nothing else, and it removes itself." onClick={() => send({ t: "guest_pass", hours: 2 })}><Icon name="star" />Guest pass</button>
      {pass && (
        <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && app.set({ guest: null })}>
          <div className="card modal" style={{ textAlign: "center", maxWidth: 420 }}>
            <div className="card-h"><h3>Guest pass</h3><div className="spacer" /><button className="iconbtn" onClick={() => app.set({ guest: null })}><Icon name="x" /></button></div>
            <div className="qr" dangerouslySetInnerHTML={{ __html: pass.svg }} />
            <p><b>Speaker only, until {new Date(pass.until * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.</b></p>
            <p className="muted">Anyone who scans this in the next {pass.hours} hours joins straight away as a speaker: no remote, no intercom, no PC control, whatever is switched on later. When the time is up they are disconnected and their record is removed. Close this window to hide the code.</p>
            <button className="btn sm" onClick={async () => toast((await copyText(pass.url)) ? "Link copied" : "Couldn't copy")}><Icon name="copy" />Copy link</button>
          </div>
        </div>
      )}
    </>
  );
}

interface Digest { days: number; groups: { key: string; label: string; count: number; last: number | null }[]; events: { t: number; text: string }[];
  devices: { total: number; verified: number; with_pc_control: number; blocked: number; waiting: number }; settings: Record<string, boolean> }
const DAYS = [{ v: "1", label: "Today" }, { v: "7", label: "7 days" }, { v: "30", label: "30 days" }] as const;
const BAD = ["refused", "impersonation", "password", "system"];

/** What happened security-wise, on one page. */
export function SecurityDigest() {
  const [days, setDays] = useState("7"), [d, setD] = useState<Digest | null>(null);
  useEffect(() => { fetch(`/api/security?days=${days}`).then((r) => r.json()).then(setD).catch(() => setD(null)); }, [days]);
  if (!d) return <div className="card empty-np"><Icon name="shield" /> Reading…</div>;
  const worry = d.groups.filter((g) => BAD.includes(g.key)).reduce((n, g) => n + g.count, 0);
  const when = (t: number) => new Date(t * 1000).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return (
    <>
      <div className="row" style={{ marginBottom: 14, gap: 12, flexWrap: "wrap" }}><Seg value={days as any} options={DAYS} onChange={(v) => setDays(v)} />
        <span className={`pill ${worry ? "" : ""}`}><span className={`dot ${worry ? "warn" : "good"}`} />{worry ? `${worry} thing${worry > 1 ? "s" : ""} worth a look` : "Nothing worrying"}</span></div>
      <div className="digest">
        {d.groups.map((g) => <div key={g.key} className={`card dg ${g.count && BAD.includes(g.key) ? "warn" : ""}`}><b className="tnum">{g.count}</b><span>{g.label}</span><i>{g.last ? `last: ${when(g.last)}` : "none"}</i></div>)}
      </div>
      <div className="grid g-2" style={{ marginTop: 16 }}>
        <div className="card">
          <div className="card-h"><h3>Where things stand</h3></div>
          <div className="kv" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
            <div><span>Phones on record</span><b>{d.devices.total}</b></div><div><span>With their own key</span><b>{d.devices.verified}</b></div>
            <div><span>Allowed to control the PC</span><b>{d.devices.with_pc_control}</b></div><div><span>Blocked / waiting</span><b>{d.devices.blocked} / {d.devices.waiting}</b></div>
            <div><span>Dashboard password</span><b>{d.settings.password ? "set" : "NOT SET"}</b></div><div><span>Approve new phones</span><b>{d.settings.approval ? "on" : "OFF"}</b></div>
            <div><span>Strict security</span><b>{d.settings.strict ? "on" : "OFF"}</b></div><div><span>Lockdown</span><b>{d.settings.lockdown ? "ON" : "off"}</b></div>
          </div>
        </div>
        <div className="card">
          <div className="card-h"><h3>What happened</h3><span className="sub">{d.events.length} entries, newest first (kept 30 days)</span></div>
          <div className="log" style={{ maxHeight: "46vh" }}>
            {!d.events.length && <div className="muted" style={{ padding: 8 }}>Nothing in this period.</div>}
            {d.events.map((e, i) => <div className="lrow" key={i}><span className="lt tnum" style={{ width: 150 }}>{when(e.t)}</span><span className="ls" style={{ whiteSpace: "normal" }}>{e.text}</span></div>)}
          </div>
        </div>
      </div>
    </>
  );
}
