import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Icon } from "../lib/icons";
import { createStore, useStore } from "../lib/store";
import { Switch } from "../lib/ui";
import { toast } from "../lib/util";
import { app, connect, disconnect } from "./store";

/** required: a password is set. setup: one has to be created first. authed: this browser is signed in. */
export interface AuthState { required: boolean; setup: boolean; authed: boolean; autostart: boolean; wait: number; min: number }
export const auth = createStore({ a: null as AuthState | null });

export async function refreshAuth() {
  try {
    const a: AuthState = await fetch("/api/auth").then((r) => r.json());
    auth.set({ a });
    return a;
  } catch { return auth.get().a; }   // server not reachable: keep what we know
}

async function post(path: string, body: object) {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  await refreshAuth();
  return { ok: r.ok, error: (j.error as string) || "" };
}

export const lockNow = () => post("/api/auth/logout", {});

function SetupForm({ inline }: { inline?: boolean }) {
  const min = useStore(auth, (s) => s.a?.min ?? 8);
  const [pw, setPw] = useState(""), [again, setAgain] = useState(""), [ask, setAsk] = useState(false), [err, setErr] = useState(""), [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pw.length < min) return setErr(`Use at least ${min} characters.`);
    if (pw !== again) return setErr("The two passwords are different.");
    setBusy(true);
    const r = await post("/api/auth/setup", { password: pw, autostart: !ask });
    setBusy(false);
    if (!r.ok) setErr(r.error || "Couldn't set the password."); else if (inline) toast("Password set. Storage is now encrypted.");
  };
  return (
    <form className="col" onSubmit={submit}>
      <input className="input" type="password" autoComplete="new-password" placeholder={`New password (${min}+ characters)`} value={pw} onChange={(e) => { setPw(e.target.value); setErr(""); }} autoFocus={!inline} />
      <input className="input" type="password" autoComplete="new-password" placeholder="Type it again" value={again} onChange={(e) => { setAgain(e.target.value); setErr(""); }} />
      <label className="row" style={{ gap: 10 }}><Switch checked={ask} onChange={setAsk} /><span>Also ask for it every time the server starts</span></label>
      <p className="note" style={{ margin: 0 }}>The password is never stored, so nobody can show it to you again, and there is no reset without it. If you lose it, the saved phones and settings are gone for good. Write it down somewhere safe.</p>
      {err && <div className="note err">{err}</div>}
      <button className="btn accent" disabled={busy}>{busy ? "Encrypting…" : "Set password"}</button>
    </form>
  );
}

function LoginForm() {
  const wait = useStore(auth, (s) => s.a?.wait ?? 0);
  const [pw, setPw] = useState(""), [err, setErr] = useState(""), [busy, setBusy] = useState(false);
  useEffect(() => { if (wait > 0) { const t = setTimeout(refreshAuth, 1000); return () => clearTimeout(t); } }, [wait]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const r = await post("/api/auth/login", { password: pw });
    setBusy(false);
    if (!r.ok) { setErr(r.error || "Wrong password"); setPw(""); }
  };
  return (
    <form className="col" onSubmit={submit}>
      <input className="input" type="password" autoComplete="current-password" placeholder="Password" value={pw} onChange={(e) => { setPw(e.target.value); setErr(""); }} autoFocus />
      {wait > 0 ? <div className="note err">Too many wrong tries. Wait {Math.ceil(wait)} s.</div> : err && <div className="note err">{err}</div>}
      <button className="btn accent" disabled={busy || wait > 0 || !pw}>{busy ? "Checking…" : "Unlock"}</button>
    </form>
  );
}

/** Nothing of the dashboard is shown, and no connection to the server is opened, until this lets you in. */
export function Gate({ children }: { children: ReactNode }) {
  const a = useStore(auth, (s) => s.a);
  const connected = useStore(app, (s) => s.connected);
  const open = !!a && !a.setup && (!a.required || a.authed);
  useEffect(() => { refreshAuth(); }, []);
  useEffect(() => { if (open) connect(); else disconnect(); }, [open]);
  // The connection dropped (server restarted, or locked from another tab): find out whether we're still signed in.
  useEffect(() => { if (open && !connected) { const t = setInterval(refreshAuth, 2000); return () => clearInterval(t); } }, [open, connected]);
  if (!a) return null;
  if (open) return <>{children}</>;
  return (
    <div className="gate">
      <div className="card">
        <div className="brand"><Icon name="logo" />PhoneBoxSound</div>
        {a.setup ? <>
          <h2>Protect this dashboard</h2>
          <p className="muted">Choose a password. It locks the dashboard and encrypts everything the server remembers: phones, their keys and permissions, the API token.</p>
          <SetupForm />
        </> : <>
          <h2><Icon name="lock" /> Locked</h2>
          <p className="muted">Enter the dashboard password. Phones that are already connected keep playing.</p>
          <LoginForm />
        </>}
      </div>
    </div>
  );
}

/** Settings card: set, change, and how the vault opens at start. */
export function PasswordCard() {
  const a = useStore(auth, (s) => s.a);
  const [cur, setCur] = useState(""), [next, setNext] = useState(""), [err, setErr] = useState(""), [busy, setBusy] = useState(false);
  useEffect(() => { refreshAuth(); }, []);
  if (!a) return null;
  const run = async (path: string, body: object, done: string) => {
    if (!cur) return setErr("Enter the current password first.");
    setBusy(true);
    const r = await post(path, { ...body, current: cur });
    setBusy(false);
    if (r.ok) { toast(done); setCur(""); setNext(""); setErr(""); } else setErr(r.error || "That didn't work.");
  };
  return (
    <div className="card">
      <div className="card-h"><h3>Password &amp; encrypted storage</h3><div className="spacer" />
        {a.required && <button className="btn sm" onClick={lockNow}><Icon name="lock" />Lock now</button>}</div>
      {!a.required ? <>
        <p className="note" style={{ marginTop: 0 }}>No password yet: anyone at this PC can open the dashboard, and the settings file is readable. Set one to lock the dashboard and encrypt the storage.</p>
        <SetupForm inline />
      </> : <>
        <p className="note" style={{ marginTop: 0 }}>Storage is encrypted. A changed, swapped or missing file stops the server from starting. The password is never stored, so it can't be displayed; it can only be changed by entering it.</p>
        <div className="col">
          <input className="input" type="password" autoComplete="current-password" placeholder="Current password" value={cur} onChange={(e) => { setCur(e.target.value); setErr(""); }} />
          <div className="row"><input className="input" style={{ flex: 1 }} type="password" autoComplete="new-password" placeholder={`New password (${a.min}+ characters)`} value={next} onChange={(e) => setNext(e.target.value)} />
            <button className="btn" disabled={busy || next.length < a.min} onClick={() => run("/api/auth/password", { password: next }, "Password changed. Other browsers were signed out.")}>Change</button></div>
          <div className="perm-row">Ask for the password every time the server starts<div className="spacer" />
            <Switch checked={!a.autostart} onChange={(v) => run("/api/auth/autostart", { on: !v }, v ? "The server will now wait for the password when it starts." : "Windows will open the storage for your account at start.")} /></div>
          <p className="note" style={{ margin: 0 }}>{a.autostart
            ? "Off: your Windows account can open the storage, so the server starts by itself after a reboot. The dashboard still needs the password."
            : "On: after a reboot nothing works until you type the password on this PC. Nothing on the disk can open the storage."}</p>
          {err && <div className="note err">{err}</div>}
        </div>
      </>}
    </div>
  );
}
