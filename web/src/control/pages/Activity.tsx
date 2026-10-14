import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../lib/icons";
import { useStore } from "../../lib/store";
import { Seg, Switch } from "../../lib/ui";
import { cx, toast } from "../../lib/util";
import { SecurityDigest } from "../extras";
import { app, setGlobal } from "../store";

/**
 * One recorded line. d: in = the phone sent it, out = the PC sent it to the phone, sys = noted by the server.
 * n / s: the phone's and the PC's running numbers. r: 1 = the PC carried it out, 0 = refused (why).
 */
interface Ev { t: number; d: "in" | "out" | "sys"; k: string; m?: any; n?: number; s?: number; r?: 0 | 1; why?: string; got?: boolean }
interface Recorded { device_id: string; name: string; platform: string; online: boolean; first: number; last: number; bytes: number; hours: number }

const RANGES = [{ v: "15", label: "15 min" }, { v: "60", label: "1 hour" }, { v: "360", label: "6 hours" }, { v: "1440", label: "24 hours" }, { v: "2880", label: "2 days" }] as const;
const SHOW = [{ v: "did", label: "What it did" }, { v: "got", label: "What it was sent" }, { v: "conn", label: "Connection" }, { v: "traffic", label: "Packets & status" }, { v: "all", label: "Everything" }] as const;
type Show = (typeof SHOW)[number]["v"];
const PAGE = 400;

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
export const stamp = (t: number) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`; };
const day = (t: number) => new Date(t).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
const kb = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} kB`);
const q = (s: unknown) => `"${String(s ?? "").slice(0, 80)}"`;

const kindOf = (e: Ev): Exclude<Show, "all"> | "screen" =>
  e.d === "sys" ? (e.k === "packets" ? "traffic" : "conn") : e.d === "out" ? "got" : e.k === "stats" ? "traffic" : e.k === "hello" ? "conn" : e.k === "snap" ? "screen" : "did";

const PACKETS: Record<string, string> = { audio_out: "sound to the phone", intercom_out: "intercom to the phone", screen_out: "screen pictures to the phone",
  intercom_in: "voice from the phone", host_in: "music from the phone", ping_in: "clock pings", pong_out: "clock answers", media_out: "position updates",
  stats_in: "unchanged status reports", config_out: "unchanged settings", studio_out: "speaker-panel updates", targets_out: "intercom lists" };
const SETTING: Record<string, (v: any) => string> = {
  name: (v) => `name ${q(v)}`, volume: (v) => `volume ${Math.round(v * 100)}%`, muted: (v) => (v ? "muted" : "unmuted"), channel: (v) => `channel ${v}`,
  offset_ms: (v) => `offset ${v} ms`, eq: (v) => `sound ${v}`, zone: (v) => `zone ${q(v)}`, latency_ms: (v) => `buffer ${v} ms`, streaming: (v) => (v ? "streaming on" : "streaming paused"),
  perms: (v) => `may use ${Object.entries(v).filter(([, on]) => on).map(([k]) => k).join(", ") || "nothing"}`, locked: (v) => (v.length ? `locked: ${v.join(", ")}` : "nothing locked"),
  verified: (v) => (v ? "verified" : "not verified"), lockdown: (v) => (v ? "LOCKDOWN on" : "lockdown off"), theme: (v) => `theme ${v}`, mode: (v) => `${v} mode`,
  speaker: (v) => (v ? "speaker on" : "speaker off"), hosting: (v) => (v ? `${v} is hosting` : "nobody hosting"), duck: (v) => (v < 1 ? "music lowered for intercom" : "music back to normal"),
  pending: (v) => `${v.length} phone(s) waiting for approval`,
};

/** A recorded line in plain words. */
export function describe(e: Ev): string {
  const m = e.m || {};
  if (e.d === "sys") switch (e.k) {
    case "connected": return `Connected as ${q(m.name)} from ${m.ip}${m.secure ? ", secure link" : ", plain link"}${m.verified ? ", key verified" : ""}${m.system ? ` · ${m.system}` : ""}`;
    case "disconnected": return `Disconnected after ${m.after_s} s`;
    case "waiting": return `Arrived with the right code and is waiting for approval (${m.ip})`;
    case "approved": return `Approved by ${m.by}`;
    case "denied": return `Denied by ${m.by}`;
    case "refused": return `REFUSED: tried ${m.what}${m.ip ? ` (${m.ip})` : ""}`;
    case "mismatch": return `NOT MATCHED: ${m.missed} ${m.what}`;
    case "system": return `Reports a different system now: ${m.now} (was ${m.was})`;
    case "packets": return "In 10 s: " + Object.entries(m).map(([k, v]: [string, any]) => `${v[0]}× ${PACKETS[k] || k}${v[1] ? ` (${kb(v[1])})` : ""}`).join(" · ");
  }
  if (e.d === "in") switch (e.k) {
    case "ui": return `Tapped ${m.label ? q(m.label) : m.el} at ${m.x}, ${m.y}`;
    case "snap": return `Screen changed (${m.mid?.length ?? 0} of ${m.len} characters)`;
    case "hello": return `Opened the app (screen ${m.vw}×${m.vh}${m.code ? ", with the room code" : ""}${m.can_sign ? ", has a key" : ""}${m.standalone ? ", installed app" : ""})`;
    case "media": return `Media remote: ${m.action}${m.value != null ? ` ${m.value}` : ""}`;
    case "input": switch (m.kind) {
      case "move": return `Moved the PC pointer by ${Math.round(m.dx)}, ${Math.round(m.dy)}`;
      case "click": return `${m.double ? "Double-clicked" : "Clicked"} the ${m.button || "left"} mouse button`;
      case "button": return `${m.down ? "Held down" : "Released"} the ${m.button || "left"} mouse button`;
      case "scroll": return `Scrolled by ${Math.round(m.dy || 0)}${m.dx ? `, ${Math.round(m.dx)} sideways` : ""}`;
      case "key": return `Pressed ${(m.keys || []).join(" + ")}`;
      case "text": return `Typed ${q(m.text)}`;
      default: return `Input: ${m.kind}`;
    }
    case "stats": return `Status: ${m.ahead_ms} ms buffered, ${m.late_recent ?? 0} late, round trip ${m.rtt_ms} ms${m.hidden ? ", screen off / in background" : ""}${m.battery != null ? `, battery ${Math.round(m.battery * 100)}%` : ""}`;
    case "set_self": return `Changed its own settings: ${Object.entries(m).map(([k, v]) => `${k} = ${v}`).join(", ")}`;
    case "clip_get": return "Read the PC clipboard";
    case "clip_set": return m.text != null ? `Sent text to the PC clipboard: ${q(m.text)}${m.paste ? " and pasted it" : ""}` : `Sent a picture to the PC clipboard${m.paste ? " and pasted it" : ""}`;
    case "clip_live": return `Live clipboard ${m.on ? "on" : "off"}`;
    case "screen": return m.mode ? `Started watching the PC screen (${m.mode})` : "Stopped watching the PC screen";
    case "power": return m.cancel ? "Cancelled the power action" : `Asked the PC to ${m.action}`;
    case "command": return `Ran PC command ${m.id}`;
    case "intercom_start": return `Started talking to ${m.target || "everyone"}`;
    case "intercom_stop": return "Stopped talking";
    case "manage": { const c = m.cmd || {}; return c.t === "set_device" ? `Changed phone ${String(c.device_id).slice(0, 6)}: ${Object.entries(c.patch || {}).map(([k, v]) => (SETTING[k] ? SETTING[k](v) : `${k} ${v}`)).join(", ")}` : `Speakers: ${c.t}${c.kind ? ` ${c.kind}` : ""}`; }
    case "manage_watch": return `${m.on ? "Opened" : "Closed"} the all-speakers panel`;
    case "approve": return `${m.ok ? "Approved" : "Denied"} waiting phone ${String(m.device_id).slice(0, 6)}`;
    case "invite": return "Showed an invite QR";
    case "forget": return "Pressed Forget this PC";
    case "handoff": return "Asked for the secure link";
    case "host_start": return "Started hosting music";
    case "host_stop": return "Stopped hosting music";
    case "click_test": return "Toggled the click test";
    case "identify_self": return "Asked to be identified";
    default: return `Sent ${e.k}`;
  }
  switch (e.k) {
    case "welcome": return "Let in";
    case "config": { const parts = Object.entries(m).filter(([k]) => SETTING[k]).map(([k, v]) => SETTING[k](v)); return `${m.first ? "Settings sent" : "Settings changed"}: ${parts.join(", ") || Object.keys(m).join(", ")}`; }
    case "media": return m.active ? `Shown as playing: ${q(m.active.title)} (${m.active.state})` : "Shown: nothing playing";
    case "toast": return `Message shown: ${q(m.msg)}`;
    case "intercom": return m.talkers?.length ? `Told who is talking: ${m.talkers.map((x: any) => x.name).join(", ")}` : "Told nobody is talking";
    case "clip": return m.text != null ? `PC clipboard sent to the phone: ${q(m.text)}` : "PC clipboard picture sent to the phone";
    case "power": return m.action ? `Power countdown shown: ${m.action} in ${m.seconds} s` : "Power countdown cleared";
    case "kicked": return `Disconnected by the PC${m.msg ? `: ${m.msg}` : ""}`;
    case "error": return `Turned away: ${m.msg}`;
    case "identify": return `Identify flash (#${m.index})`;
    case "invite": return "Invite QR sent";
    case "handoff": return "Secure link sent";
    case "moved": return "Told the PC moved to another port";
    default: return `Sent to the phone: ${e.k}`;
  }
}

/** Mark each message the PC sent as received once a later status report from the phone covers its number. */
function matchUp(events: Ev[]) {
  let rx: number | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.d === "sys" && (e.k === "disconnected" || e.k === "connected")) rx = null;      // numbers restart with each connection
    else if (e.d === "in" && e.k === "stats" && typeof e.m?.rx === "number") rx = Math.max(rx ?? 0, e.m.rx);
    else if (e.d === "out" && e.s != null) e.got = rx != null && e.s <= rx;
  }
  return events;
}

const jget = (path: string) => fetch(path).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))));

// ------------------------------------------------------------------ replay: the phone's screen, as recorded
const SPEEDS = [{ v: "1", label: "1×" }, { v: "4", label: "4×" }, { v: "16", label: "16×" }, { v: "64", label: "64×" }] as const;
interface Screen { html: string; sy: number; w: number; h: number; css: string; th: string; mo: string; ui: string; ok: boolean }
const BLANK: Screen = { html: "", sy: 0, w: 390, h: 844, css: "", th: "forest", mo: "dark", ui: "1", ok: true };

/** The picture after one more recorded change: only the part that differed was sent. */
function nextScreen(prev: Screen, m: any): Screen {
  const full = !m.p && !m.e;
  const html = full ? m.mid : prev.html.slice(0, m.p) + m.mid + prev.html.slice(prev.html.length - m.e);
  return { html, sy: m.sy ?? 0, w: m.w || prev.w, h: m.h || prev.h, css: m.css ?? prev.css, th: m.th ?? prev.th, mo: m.mo ?? prev.mo, ui: m.ui ?? prev.ui,
    ok: full ? html.length === m.len : prev.ok && html.length === m.len };
}

const frameDoc = (css: string) => `<!doctype html><html><head><meta charset="utf-8">${css.split(" ").filter(Boolean).map((h) => `<link rel="stylesheet" href="${h.replace(/"/g, "")}">`).join("")}
<style>html{overflow:hidden}#root{pointer-events:none}[data-focus]{outline:2px solid var(--accent)!important}
.cctv-tap{position:fixed;z-index:99999;width:46px;height:46px;margin:-23px 0 0 -23px;border-radius:50%;border:3px solid var(--accent,#4fd49a);background:rgba(120,220,170,.35);animation:cctv .7s ease-out forwards}
@keyframes cctv{from{transform:scale(.4);opacity:1}to{transform:scale(1.5);opacity:0}}</style></head><body><div id="root"></div></body></html>`;

function Replay({ name, events, startAt, close }: { name: string; events: Ev[]; startAt: number; close: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null), padCv = useRef<HTMLCanvasElement>(null);
  const [pos, setPos] = useState(0), [playing, setPlaying] = useState(true), [speed, setSpeed] = useState("1"), [skip, setSkip] = useState(true);
  const [feed, setFeed] = useState<Ev[]>([]), [screen, setScreen] = useState<Screen>(BLANK), [loaded, setLoaded] = useState(0);
  const st = useRef({ pos: 0, screen: BLANK, trail: [] as [number, number, number][], px: 120, py: 75 });
  const pictures = useMemo(() => events.filter((e) => e.k === "snap").length, [events]);

  const drawPad = useCallback(() => {
    const c = padCv.current; if (!c) return;
    const g = c.getContext("2d")!, s = st.current;
    g.clearRect(0, 0, c.width, c.height);
    g.strokeStyle = getComputedStyle(c).color; g.fillStyle = g.strokeStyle; g.lineWidth = 2;
    g.beginPath(); s.trail.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke();
    s.trail.forEach(([x, y, click]) => { if (click) { g.beginPath(); g.arc(x, y, 7, 0, 7); g.stroke(); } });
    g.beginPath(); g.arc(s.px, s.py, 4, 0, 7); g.fill();
  }, []);

  /** Put the recorded picture on the simulated screen. */
  const paint = useCallback((sc: Screen) => {
    const doc = frame.current?.contentDocument, root = doc?.getElementById("root");
    if (!doc || !root) return;
    const html = doc.documentElement;
    html.dataset.theme = sc.th; html.dataset.mode = sc.mo; html.style.setProperty("--ui", sc.ui);
    root.innerHTML = sc.html;
    html.scrollTop = sc.sy; if (doc.body) doc.body.scrollTop = sc.sy;
  }, []);

  /** Apply one recorded line. quiet: while jumping to a moment (no animation, no list). */
  const apply = useCallback((e: Ev, quiet: boolean) => {
    const s = st.current;
    if (e.d === "in" && e.k === "snap") { s.screen = nextScreen(s.screen, e.m); if (!quiet) setScreen(s.screen); return; }
    if (e.d === "in" && e.k === "ui" && !quiet) {
      const doc = frame.current?.contentDocument;
      if (doc?.body) { const dot = doc.createElement("i"); dot.className = "cctv-tap"; dot.style.left = e.m.x + "px"; dot.style.top = e.m.y + "px"; doc.body.appendChild(dot); setTimeout(() => dot.remove(), 750); }
    }
    if (e.d === "in" && e.k === "input") {
      const m = e.m || {};
      if (m.kind === "move") { s.px = Math.max(4, Math.min(236, s.px + m.dx * 0.12)); s.py = Math.max(4, Math.min(146, s.py + m.dy * 0.12)); s.trail.push([s.px, s.py, 0]); }
      if (m.kind === "click") s.trail.push([s.px, s.py, 1]);
      if (s.trail.length > 160) s.trail.splice(0, s.trail.length - 160);
      if (!quiet) drawPad();
    }
    const k = kindOf(e);
    if (!quiet && (k === "did" || k === "conn" || (e.d === "out" && ["toast", "kicked", "error", "power", "config", "media"].includes(e.k))) && !(e.k === "input" && e.m?.kind === "move"))
      setFeed((f) => [e, ...f].slice(0, 9));
  }, [drawPad]);

  /** Jump to a moment: rebuild the picture from the last complete one before it. */
  const seek = useCallback((target: number) => {
    const s = st.current;
    target = Math.max(0, Math.min(target, events.length));
    let from = 0;
    for (let i = target - 1; i >= 0; i--) if (events[i].k === "snap" && !events[i].m.p && !events[i].m.e) { from = i; break; }
    s.screen = BLANK; s.trail = []; s.px = 120; s.py = 75;
    for (let i = from; i < target; i++) apply(events[i], true);
    s.pos = target; setPos(target); setScreen(s.screen); setFeed([]); drawPad();
  }, [events, apply, drawPad]);

  useEffect(() => { seek(startAt); }, [seek, startAt]);
  useEffect(() => { paint(screen); }, [screen, loaded, paint]);

  useEffect(() => {
    if (!playing) return;
    let timer = 0, dead = false;
    const step = () => {
      const s = st.current;
      if (dead) return;
      if (s.pos >= events.length) { setPlaying(false); return; }
      const e = events[s.pos];
      apply(e, false);
      s.pos++; setPos(s.pos);
      const next = events[s.pos];
      let gap = next ? next.t - e.t : 0;
      if (skip) gap = Math.min(gap, 1200);
      timer = window.setTimeout(step, gap / Number(speed));
    };
    timer = window.setTimeout(step, 300);
    return () => { dead = true; clearTimeout(timer); };
  }, [playing, speed, skip, events, apply]);

  const now = events[Math.min(pos, events.length - 1)];
  const scale = Math.min(1, 600 / screen.h);
  const doc = useMemo(() => frameDoc(screen.css), [screen.css]);
  return (
    <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && close()}>
      <div className="card modal replay">
        <div className="card-h"><h3>Replay: {name}</h3><span className="muted tnum">{now ? `${day(now.t)} ${stamp(now.t)}` : ""}</span><div className="spacer" />
          <button className="iconbtn" title="Close" onClick={close}><Icon name="x" /></button></div>
        <div className="replay-body">
          <div className="sim" style={{ width: screen.w * scale, height: screen.h * scale }}>
            {/* no scripts can run in here: it only displays the recorded page */}
            <iframe ref={frame} key={doc} srcDoc={doc} sandbox="allow-same-origin" title="The phone's screen, as recorded" onLoad={() => setLoaded((n) => n + 1)}
              style={{ width: screen.w, height: screen.h, transform: `scale(${scale})` }} />
            {!screen.html && <div className="sim-load">{pictures ? "No picture yet at this moment" : "This visit has no screen recording (the phone ran an older version of the app)"}</div>}
            {!screen.ok && !!screen.html && <div className="sim-warn">A piece of the recording is missing; the picture is exact again at the next full one.</div>}
          </div>
          <div className="side-sim">
            <div className="label">On the PC (pointer the phone moved)</div>
            <canvas ref={padCv} width={240} height={150} className="padsim" />
            <div className="label" style={{ marginTop: 12 }}>What happened</div>
            <div className="feed">
              {!feed.length && <div className="muted">Nothing yet.</div>}
              {feed.map((e, i) => <div key={e.t + ":" + i} className={cx("frow", i === 0 && "new", (e.r === 0 || e.k === "refused" || e.k === "mismatch") && "bad")}>
                <span className="tnum">{stamp(e.t)}</span>{describe(e)}{e.r === 1 && <b className="okmark" title="The PC carried this out"> ✓</b>}{e.r === 0 && <b> ✗ {e.why}</b>}</div>)}
            </div>
            <p className="note">This is the phone's own screen as it recorded it ({pictures} pictures), not a re-enactment: the page it showed, where the finger touched, what was typed (passwords and the room code masked). Sound, the live PC-screen view and level meters are not recorded.</p>
          </div>
        </div>
        <div className="row replay-ctl">
          <button className="btn accent" onClick={() => { if (pos >= events.length) seek(0); setPlaying(!playing); }}><Icon name={playing ? "pause" : "play"} />{playing ? "Pause" : pos >= events.length ? "Again" : "Play"}</button>
          <button className="btn" title="One line at a time" onClick={() => { setPlaying(false); const s = st.current; if (s.pos < events.length) { apply(events[s.pos], false); s.pos++; setPos(s.pos); } }}>Step</button>
          <input type="range" className="scrub" min={0} max={events.length} value={pos} onChange={(e) => seek(Number(e.target.value))} />
          <span className="muted tnum">{pos} / {events.length}</span>
          <Seg value={speed as any} options={SPEEDS} onChange={(v) => setSpeed(v)} />
          <button className={cx("btn sm", skip && "soft")} title="Shorten long pauses where nothing happened" onClick={() => setSkip(!skip)}>Skip pauses</button>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ the page
const VIEWS = [{ v: "records", label: "Phone records" }, { v: "security", label: "Security digest" }] as const;

export default function Activity() {
  const [view, setView] = useState<"records" | "security">("records");
  const on = useStore(app, (s) => s.S?.cfg.activity !== false);
  const [about, setAbout] = useState(false);
  const flip = async (v: boolean) => {
    if (!v && confirm("Recording stops now.\n\nAlso erase everything recorded so far? (OK = erase, Cancel = keep it)")) await fetch("/api/journal/clear", { method: "POST" });
    setGlobal({ activity: v });
  };
  return (
    <>
      <div className="card recbar" style={{ marginBottom: 14 }}>
        <span className={`dot ${on ? "good" : ""}`} />
        <div style={{ flex: 1, minWidth: 220 }}><b>{on ? "Recording what each phone does" : "Recording is off"}</b>
          <span>{on ? "Kept for two days on this PC, then deleted by itself." : "Nothing is written, and phones don't report their taps or screen."}</span></div>
        <button className="btn sm" onClick={() => setAbout(!about)}>{about ? "Hide" : "What is recorded?"}</button>
        <Switch checked={on} onChange={flip} />
      </div>
      {about && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="permlist" style={{ marginTop: 0 }}>
            <div><b>Recorded</b><span>Every request a phone makes (each tap and where, pointer moves, clicks, keys and typed text, media and clipboard actions) with what the PC did about it; what the PC sent the phone; connections, approvals and refused attempts; the phone's own screen as it changed.</span></div>
            <div><b>Not recorded</b><span>The sound itself, the live picture of the PC's screen, passwords, the room code, tokens. Sound and pictures are only counted.</span></div>
            <div><b>Who can see it</b><span>Only this dashboard, behind its password. It is stored on this PC only, encrypted once a password is set, and never leaves it.</span></div>
            <div><b>Good to know</b><span>Typed text and clipboard text are part of the record. If people other than you use the remote, tell them, or switch the record off here.</span></div>
          </div>
        </div>
      )}
      <div style={{ marginBottom: 14 }}><Seg value={view} options={VIEWS} onChange={setView} /></div>
      {view === "records" ? <Records /> : <SecurityDigest />}
    </>
  );
}

function Records() {
  const [list, setList] = useState<Recorded[] | null>(null);
  const [id, setId] = useState("");
  const [range, setRange] = useState("60");
  const [show, setShow] = useState<Show>("did");
  const [query, setQuery] = useState("");
  const [events, setEvents] = useState<Ev[]>([]);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pages, setPages] = useState(1);
  const [open, setOpen] = useState<number | null>(null);
  const [replay, setReplay] = useState<{ events: Ev[]; startAt: number } | null>(null);

  const loadList = useCallback(() => jget("/api/journal").then((l: Recorded[]) => { setList(l); setId((cur) => (l.some((d) => d.device_id === cur) ? cur : l[0]?.device_id || "")); }).catch(() => setList([])), []);
  const load = useCallback(() => {
    if (!id) return;
    setBusy(true);
    jget(`/api/journal/${encodeURIComponent(id)}?from=${Date.now() - Number(range) * 60000}&limit=30000&newest=1`)
      .then((r) => { setEvents(matchUp(r.events)); setMore(r.more); setPages(1); setOpen(null); })
      .catch(() => toast("Couldn't read the record")).finally(() => setBusy(false));
  }, [id, range]);
  useEffect(() => { loadList(); }, [loadList]);
  useEffect(load, [load]);

  const dev = list?.find((d) => d.device_id === id);
  const text = query.trim().toLowerCase();
  const rows = useMemo(() => {
    const out: { e: Ev; s: string }[] = [];
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i], kind = kindOf(e);
      if (show === "all" ? false : kind !== show) continue;
      const s = describe(e);
      if (text && !s.toLowerCase().includes(text) && !e.k.includes(text)) continue;
      out.push({ e, s });
    }
    return out;
  }, [events, show, text]);

  /** Did everything that was asked for happen, and did everything that was sent arrive? */
  const check = useMemo(() => {
    const c = { asked: 0, done: 0, refused: 0, sent: 0, got: 0, lost: 0 };
    for (const e of events) {
      if (e.d === "in" && e.r != null) { c.asked++; if (e.r) c.done++; else c.refused++; }
      if (e.d === "out" && e.s != null) { c.sent++; if (e.got) c.got++; }
      if (e.d === "sys" && e.k === "mismatch") c.lost += e.m?.missed || 1;
    }
    return c;
  }, [events]);

  /** Replay the visit that contains this moment: from its "connected" line to the next one. */
  const startReplay = async (at: number) => {
    let start = 0;
    for (const e of events) if (e.d === "sys" && e.k === "connected" && e.t <= at) start = e.t;
    if (!start) start = events[0]?.t ?? at;
    const end = events.find((e) => e.d === "sys" && e.k === "connected" && e.t > at)?.t;
    try {
      const r = await jget(`/api/journal/${encodeURIComponent(id)}?from=${start - 500}${end ? `&to=${end - 500}` : ""}&limit=60000`);
      const evs: Ev[] = r.events.filter((e: Ev) => !(e.d === "sys" && e.k === "packets") && e.k !== "stats");
      if (!evs.length) return toast("Nothing recorded for that visit");
      setReplay({ events: evs, startAt: at <= start ? 0 : Math.max(0, evs.findIndex((e) => e.t >= at)) });
    } catch { toast("Couldn't read the record"); }
  };
  const lastVisit = [...events].reverse().find((e) => e.d === "sys" && e.k === "connected");
  const erase = (all: boolean) => confirm(all ? "Erase the records of every phone?" : `Erase the whole record of ${dev?.name}?`)
    && fetch(all ? "/api/journal/clear" : `/api/journal/${encodeURIComponent(id)}/clear`, { method: "POST" }).then(() => { setEvents([]); loadList(); load(); });

  if (list && !list.length) return <div className="card empty-np"><Icon name="pulse" /> Nothing recorded yet. Every phone that connects gets a two-day record here.</div>;
  return (
    <>
      <div className="row" style={{ flexWrap: "wrap", gap: 12, marginBottom: 14 }}>
        <select className="input" style={{ maxWidth: 260 }} value={id} onChange={(e) => setId(e.target.value)}>
          {list?.map((d) => <option key={d.device_id} value={d.device_id}>{d.name}{d.online ? " (online)" : ""}</option>)}
        </select>
        <Seg value={range as any} options={RANGES} onChange={(v) => setRange(v)} />
        <div className="spacer" />
        <button className="btn" onClick={() => { loadList(); load(); }} disabled={busy}><Icon name="refresh" />{busy ? "Reading…" : "Refresh"}</button>
        <button className="btn accent" disabled={!lastVisit} onClick={() => lastVisit && startReplay(lastVisit.t)}><Icon name="play" />Replay latest visit</button>
      </div>
      <div className={cx("card matchbar", (check.refused > 0 || check.lost > 0) && "warn")}>
        <Icon name={check.refused || check.lost ? "info" : "check"} />
        <span><b>{check.asked}</b> requests from the phone: <b>{check.done}</b> carried out{check.refused ? <>, <b className="bad">{check.refused} refused</b></> : ""}.</span>
        <span><b>{check.sent}</b> messages to the phone: <b>{check.got}</b> confirmed received{check.sent - check.got ? `, ${check.sent - check.got} not confirmed yet` : ""}.</span>
        <span>{check.lost ? <b className="bad">{check.lost} lost in between</b> : "Nothing lost in between."}</span>
      </div>
      <div className="row" style={{ flexWrap: "wrap", gap: 12, marginBottom: 14 }}>
        <Seg value={show} options={SHOW} onChange={(v) => { setShow(v); setPages(1); }} />
        <input className="input search" type="search" placeholder="Search this record…" value={query} onChange={(e) => { setQuery(e.target.value); setPages(1); }} />
      </div>
      <div className="card">
        <div className="card-h"><h3>{dev?.name || "Record"}</h3>
          <span className="muted">{rows.length} of {events.length} lines{more ? " (the newest 30,000 of this period)" : ""}{dev ? ` · ${kb(dev.bytes)} on disk for ${dev.hours} h` : ""}</span><div className="spacer" />
          <button className="btn sm ghost" onClick={() => erase(false)}><Icon name="trash" />Erase</button>
          <button className="btn sm ghost" onClick={() => erase(true)}>Erase all phones</button></div>
        <div className="log">
          {!rows.length && <div className="muted" style={{ padding: 12 }}>{busy ? "Reading…" : "Nothing in this period matches."}</div>}
          {rows.slice(0, pages * PAGE).map(({ e, s }, i, arr) => (
            <div key={e.t + ":" + i}>
              {(i === 0 || day(arr[i - 1].e.t) !== day(e.t)) && <div className="lday">{day(e.t)}</div>}
              <div className={cx("lrow", e.d, (e.k === "refused" || e.k === "mismatch" || e.r === 0) && "bad", open === i && "open")} onClick={() => setOpen(open === i ? null : i)}>
                <span className="lt tnum">{stamp(e.t)}</span>
                <span className={cx("ld", e.d)} title={e.d === "in" ? "From the phone" : e.d === "out" ? "To the phone" : "Noted by the server"}>{e.d === "in" ? "phone" : e.d === "out" ? "PC" : "server"}</span>
                <span className="ls">{s}{e.r === 0 && ` — refused: ${e.why}`}</span>
                {e.r === 1 && <span className="lm ok" title="The PC received this and carried it out">✓ done</span>}
                {e.r === 0 && <span className="lm no" title={e.why}>✗ refused</span>}
                {e.d === "out" && e.s != null && <span className={cx("lm", e.got ? "ok" : "wait")} title={e.got ? "The phone confirmed it received this" : "No confirmation from the phone (yet)"}>{e.got ? "✓ received" : "… sent"}</span>}
                <button className="btn sm ghost lplay" title="Replay from this moment" onClick={(ev) => { ev.stopPropagation(); startReplay(e.t); }}><Icon name="play" /></button>
              </div>
              {open === i && <pre className="snippet" style={{ margin: "0 0 8px" }}>{JSON.stringify({ time_ms: e.t, direction: e.d, type: e.k, phone_number: e.n, pc_number: e.s, result: e.r == null ? undefined : e.r ? "carried out" : `refused: ${e.why}`, ...(e.m ? { data: e.k === "snap" ? { ...e.m, mid: `(${e.m.mid?.length} characters of the page)` } : e.m } : {}) }, null, 2)}</pre>}
            </div>
          ))}
          {rows.length > pages * PAGE && <button className="btn" style={{ margin: "12px auto", display: "flex" }} onClick={() => setPages(pages + 1)}>Show {Math.min(PAGE, rows.length - pages * PAGE)} older</button>}
        </div>
      </div>
      {replay && <Replay name={dev?.name || "phone"} events={replay.events} startAt={replay.startAt} close={() => setReplay(null)} />}
    </>
  );
}
