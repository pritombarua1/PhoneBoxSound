import { useEffect, useState } from "react";
import type { PcOut, ServerState } from "../../lib/types";
import { Icon } from "../../lib/icons";
import { useStore } from "../../lib/store";
import { applyTheme, THEMES } from "../../lib/theme";
import { Range, Seg, Switch } from "../../lib/ui";
import { copyText, cx, toast } from "../../lib/util";
import { auth, PasswordCard } from "../auth";
import { BrowserExtension } from "../browser";
import { app, send, setGlobal, setupPlayer } from "../store";
import { UrlList, useJoinUrl } from "./Dashboard";

const MODES = [{ v: "dark", label: "Dark" }, { v: "light", label: "Light" }, { v: "auto", label: "Auto" }] as const;
/** [label, method, path, JSON body] */
const API_EXAMPLES: [string, string, string, string?][] = [
  ["Status", "GET", "/api/status"], ["What's playing", "GET", "/api/media"], ["List phones", "GET", "/api/devices"],
  ["Play / pause", "POST", "/api/media/toggle"], ["Skip forward 30 s", "POST", "/api/media/seek", '{"value":30}'],
  ["Next track", "POST", "/api/media/next"], ["Repeat one song", "POST", "/api/media/repeat", '{"value":"one"}'],
  ["PC volume 40%", "POST", "/api/media/pc_volume", '{"value":0.4}'], ["Pause all phones", "POST", "/api/stream", '{"streaming":false}'],
  ["Phones master volume 70%", "POST", "/api/stream", '{"master":0.7}'], ["Apply scene: Movie", "POST", "/api/scenes/movie"],
  ["Press Ctrl+S", "POST", "/api/keys", '{"keys":["ctrl","s"]}'], ["Type text", "POST", "/api/text", '{"text":"hello"}'],
  ["Read clipboard", "GET", "/api/clipboard"], ["Set clipboard", "POST", "/api/clipboard", '{"text":"hello"}'],
  ["Sleep the PC", "POST", "/api/power/sleep"], ["Cancel sleep / shutdown", "POST", "/api/power/cancel"],
];
const SIZES = [{ v: "1", label: "Normal" }, { v: "1.15", label: "Large" }, { v: "1.3", label: "Larger" }, { v: "1.5", label: "Largest" }] as const;

/** Your own PC commands. They can only be created here, on the PC; allowed phones get a button for each. */
function Commands() {
  const commands = useStore(app, (s) => s.S)!.commands;
  const [name, setName] = useState("");
  const [run, setRun] = useState("");
  const add = () => { if (run.trim()) { send({ t: "command_add", name, run }); setName(""); setRun(""); } };
  return (
    <div className="card">
      <div className="card-h"><h3>Commands</h3><span className="sub">buttons on the phone that run something on this PC</span></div>
      {commands.map((c) => (
        <div className="url-row" key={c.id} style={{ marginBottom: 6, cursor: "default" }}><b style={{ width: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</b>
          <span className="mono">{c.run}</span><button className="iconbtn" title="Delete" onClick={() => send({ t: "command_delete", id: c.id })}><Icon name="trash" /></button></div>
      ))}
      <div className="row" style={{ marginTop: 8 }}>
        <input className="input" placeholder="Name (e.g. Open Netflix)" style={{ maxWidth: 200 }} value={name} onChange={(e) => setName(e.target.value)} />
        <input className="input mono" placeholder='start "" "https://netflix.com"   or   notepad.exe' value={run} onChange={(e) => setRun(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
        <button className="btn accent" onClick={add}><Icon name="plus" />Add</button>
      </div>
      <p className="note">Runs exactly what you type, as you, in a Windows command prompt. Only phones with the <b>Commands</b> permission can press them, and no phone can create or change one.</p>
    </div>
  );
}

/** Which services give real search results, and the optional keys that add more. */
function SearchKeys({ S }: { S: ServerState }) {
  const st = S.search;
  const [yt, setYt] = useState(""), [sid, setSid] = useState(""), [sec, setSec] = useState("");
  const save = () => { send({ t: "set_search", ...(yt ? { youtube_key: yt } : {}), ...(sid ? { spotify_id: sid } : {}), ...(sec ? { spotify_secret: sec } : {}) }); setYt(""); setSid(""); setSec(""); toast("Saved"); };
  const row = (ok: boolean, name: string, how: string) => <div className="perm-row"><span className={`dot ${ok ? "good" : "warn"}`} style={{ marginRight: 8 }} /><b>{name}</b><span className="muted" style={{ marginLeft: 8, fontSize: 12.5 }}>{how}</span></div>;
  return (
    <div className="card">
      <div className="card-h"><h3>Search</h3><span className="sub">results with pictures on the phones; tap to play on this PC</span></div>
      {row(true, "Apple Music", "works by itself (Apple's public catalogue)")}
      {row(st.youtube !== "none", "YouTube", st.youtube === "key" ? "using your API key" : st.youtube === "ytdlp" ? "works by itself (through yt-dlp)" : "needs a key below, or: pip install yt-dlp")}
      {row(st.spotify, "Spotify", st.spotify ? "using your client id and secret" : "needs the free client id and secret below; until then its button opens Spotify's own search")}
      {row(false, "Netflix, Prime Video, Disney+", "don't share results with other programs: their button opens their own search on this PC")}
      <div className="col" style={{ marginTop: 10 }}>
        <input className="input mono" type="password" autoComplete="off" placeholder={st.has.spotify_id ? "Spotify client id (saved; type to replace)" : "Spotify client id (developer.spotify.com → Create app)"} value={sid} onChange={(e) => setSid(e.target.value)} />
        <input className="input mono" type="password" autoComplete="off" placeholder={st.has.spotify_secret ? "Spotify client secret (saved; type to replace)" : "Spotify client secret"} value={sec} onChange={(e) => setSec(e.target.value)} />
        <input className="input mono" type="password" autoComplete="off" placeholder={st.has.youtube_key ? "YouTube API key (saved; type to replace)" : "YouTube Data API key (optional)"} value={yt} onChange={(e) => setYt(e.target.value)} />
        <div className="row"><button className="btn sm" disabled={!yt && !sid && !sec} onClick={save}>Save keys</button>
          {(st.has.youtube_key || st.has.spotify_id) && <button className="btn sm ghost" onClick={() => confirm("Remove the saved search keys?") && send({ t: "set_search", youtube_key: "", spotify_id: "", spotify_secret: "" })}>Remove saved keys</button>}</div>
      </div>
      <div className="boxed" style={{ marginTop: 12 }}>
        <div className="row" style={{ flexWrap: "wrap", gap: 10 }}><b>Spotify account</b>
          <span className="muted" style={{ flex: 1, fontSize: 12.5 }}>{S.spotify.linked ? `connected${S.spotify.name ? ` as ${S.spotify.name}` : ""}` : "not connected"}</span>
          {S.spotify.linked ? <button className="btn sm ghost" onClick={() => confirm("Disconnect the Spotify account?") && send({ t: "spotify_unlink" })}>Disconnect</button>
            : <a className={`btn sm accent ${S.spotify.has_id ? "" : "disabled"}`} href={S.spotify.has_id ? "/api/spotify/login" : undefined} onClick={(e) => { if (!S.spotify.has_id) { e.preventDefault(); toast("Save the Client ID above first"); } }}>Connect Spotify</a>}</div>
        <p className="note">Adds what Windows can't pass on: the queue, exact repeat (this song / all / off), shuffle, like, and "Play next" from search. You sign in on Spotify's own page; PhoneBoxSound never sees your password. Changing playback needs Spotify Premium.</p>
        {!S.spotify.linked && <ol className="steps">
          <li>On <span className="mono">developer.spotify.com/dashboard</span> open your app (or Create app; choose "Web API").</li>
          <li>In the app's Settings, add this <b>Redirect URI</b> exactly, then Save: <span className="mono" style={{ userSelect: "all" }}>{S.spotify.redirect}</span> <button className="btn sm" onClick={async () => toast((await copyText(S.spotify.redirect)) ? "Copied" : "Couldn't copy")}>Copy</button></li>
          <li>Copy the app's <b>Client ID</b> into the first box above and press Save keys. (The Client secret is only needed for search results.)</li>
          <li>Press <b>Connect Spotify</b> and agree on Spotify's page.</li>
        </ol>}
      </div>
      <p className="note">Each phone needs the <b>Search and play</b> permission (Devices). What you type is sent to the services you search, from this PC; phones only ever talk to this PC. Keys are stored with your other settings (encrypted once a password is set).</p>
    </div>
  );
}

/** The PC's own speakers or headphones, delayed to play together with the phones. */
function PcSpeaker({ p }: { p: PcOut }) {
  const set = (patch: object) => send({ t: "set_pc_out", ...patch });
  const windows = (p.capturing || "").replace(" [Loopback]", "");
  const spare = p.outputs.filter((o) => o !== (p.device || windows));
  return (
    <div className="boxed" style={{ marginBottom: 14 }}>
      <div className="perm-row" style={{ marginTop: 0 }}><b>This PC's speakers in step with the phones</b><div className="spacer" /><Switch checked={p.enabled} onChange={(v) => set({ enabled: v })} /></div>
      <p className="note">Windows plays at once; phones play a moment later, so the PC is always ahead. Switched on, PhoneBoxSound plays a copy on the output you choose here, delayed by exactly the sync buffer and kept on the same clock as the phones.</p>
      {p.enabled && <>
        <div className="field" style={{ marginTop: 6 }}><div className="lbl"><span>Play on (the speakers or headphones you listen to)</span></div>
          <select className="input" value={p.device || ""} onChange={(e) => set({ device: e.target.value || null })}>
            <option value="">Choose…</option>
            {p.outputs.map((o) => <option key={o} value={o}>{o}{o === windows ? "  (what you hear now)" : ""}</option>)}
          </select></div>
        {p.status === "playing" ? (
          <div className="linkrow excellent"><span style={{ flex: 1 }}>Playing on <b>{p.playing_on}</b>, in step to within <b>{Math.abs(p.error_ms).toFixed(1)} ms</b></span></div>
        ) : p.device && p.device === windows ? (
          <div className="pcsteps">
            <b>One step left, in Windows.</b>
            <span>Right now Windows sends its sound straight to <b>{windows}</b>, and a sound already on its way to a speaker can't be held back. Tell Windows to send it somewhere else, and PhoneBoxSound will bring it back to <b>{windows}</b>, in step with the phones:</span>
            <ol>
              <li>Open Windows' sound output list: <a className="btn sm accent" href="ms-settings:sound">Open sound settings</a> (or click the speaker icon in the taskbar, then the arrow next to the volume).</li>
              <li>Under <b>Output</b>, choose {spare.length ? <>{spare.map((o, i) => <span key={o}>{i ? " or " : ""}<b>{o}</b></span>)}</> : "another output"}. It is only a place for Windows to send the sound: nothing needs to be plugged into it, and you won't listen to it.</li>
              <li>Come back here. This starts by itself within a few seconds, and you hear everything on <b>{windows}</b> again, now together with the phones.</li>
            </ol>
            <span className="muted">To go back to normal later: switch this off, and choose {windows} in Windows again.</span>
          </div>
        ) : (
          <div className="linkrow poor"><span style={{ flex: 1 }}>{p.error || "Starting…"}</span></div>
        )}
        {!spare.length && <p className="note">This PC has only one sound output, so Windows has nowhere else to send its sound. A virtual output solves that; the free VB-CABLE is the usual choice.</p>}
        <div className="field"><div className="lbl"><span>Fine offset (+ plays later; Bluetooth and USB headsets add their own delay)</span><b className="tnum">{p.offset_ms} ms</b></div>
          <Range value={p.offset_ms} min={-300} max={300} step={1} onChange={(v) => set({ offset_ms: v })} /></div>
        <div className="field"><div className="lbl"><span>Volume here</span><b>{Math.round(p.volume * 100)}%</b></div>
          <Range value={p.volume} min={0} max={1.5} onChange={(v) => set({ volume: v })} /></div>
      </>}
    </div>
  );
}

function PortRow({ port }: { port: number }) {
  const [v, setV] = useState(String(port));
  useEffect(() => setV(String(port)), [port]);
  const n = Number(v), ok = Number.isInteger(n) && n >= 1024 && n <= 65535 && n !== port;
  return (
    <div className="perm-row" style={{ marginTop: 8 }}>Port
      <span className="muted" style={{ fontSize: 12.5, marginLeft: 8 }}>phones and this page follow by themselves</span><div className="spacer" />
      <input className="input mono port" inputMode="numeric" maxLength={5} value={v} onChange={(e) => setV(e.target.value.replace(/\D/g, ""))} onKeyDown={(e) => e.key === "Enter" && ok && send({ t: "set_port", port: n })} />
      <button className="btn sm" disabled={!ok} onClick={() => confirm(`Move PhoneBoxSound from port ${port} to ${n}? Port ${port} is released a few seconds later.`) && send({ t: "set_port", port: n })}>Move</button>
    </div>
  );
}

function PlayerRow({ id, name, note }: { id: string; name: string; note: string }) {
  const p = useStore(app, (s) => s.media)?.players?.[id];
  const status = !p ? "" : !p.installed ? "not found" : p.web ? "full control on"
    : id === "vlc" ? (p.running ? "running · needs one click" : "needs one click") : p.running ? "running · basic control" : "basic control";
  return (
    <>
      <div className="perm-row" style={{ marginTop: 8 }}><b>{name}</b><span className="muted">{status}</span><div className="spacer" />
        <button className="btn sm soft" disabled={!p?.installed || p.web} onClick={() => setupPlayer(id)}>{p?.web ? "Enabled" : "Enable full control"}</button></div>
      <p className="note" style={{ marginTop: 0 }}>{note}</p>
    </>
  );
}

export default function Settings() {
  const S = useStore(app, (s) => s.S)!;
  const version = useStore(app, (s) => s.version);
  const c = S.cfg, cap = S.capture;
  const join = useJoinUrl(S);
  const [hooks, setHooks] = useState((c.webhooks || []).join("\n"));
  const [mpvPipe, setMpvPipe] = useState(c.mpv?.pipe ?? "");
  const [ui, setUi] = useState(() => localStorage.getItem("pbs.ui") || "1");
  useEffect(() => setMpvPipe(c.mpv?.pipe ?? ""), [c.mpv?.pipe]);
  const base = `http://${S.ips[0]}:${S.ports.http}`;
  const [showToken, setShowToken] = useState(false);
  const asks = useStore(auth, (s) => !!s.a?.required && !s.a.autostart);      // "ask for the password every time the server starts"
  const [example, setExample] = useState(0);
  const curl = (real: boolean) => {
    const [, method, path, body] = API_EXAMPLES[example];
    return `curl ${method === "POST" ? "-X POST " : ""}-H "Authorization: Bearer ${real ? S.api_token : "<token>"}"${body ? ` \\\n  -H "Content-Type: application/json" -d '${body}'` : ""} \\\n  ${base}${path}`;
  };
  const diag: [string, string][] = [
    ["Capture", cap.status], ["Device", (cap.device || "–").replace(" [Loopback]", "")], ["Sample rate", cap.sample_rate ? cap.sample_rate + " Hz" : "–"],
    ["Ports", `${S.ports.http}${S.ports.https ? ` / ${S.ports.https} (https)` : ""}`], ["mDNS", S.mdns ? "phoneboxsound.local" : "off"], ["Version", version || "–"],
  ];
  return (
    <>
    <div className="card startup" style={{ marginBottom: 20 }}>
      <Icon name="zap" />
      <div style={{ flex: 1, minWidth: 240 }}>
        <b>Start with Windows</b>
        <span>{S.autostart
          ? (asks ? "On. When you sign in to Windows it starts in the tray and opens the unlock page; phones connect once you've typed the password." : "On. When you sign in to Windows it starts by itself in the tray, and phones reconnect without you doing anything.")
          : "Off. PhoneBoxSound only runs when you start it yourself."}</span>
      </div>
      <Switch checked={S.autostart} onChange={(v) => send({ t: "set_autostart", on: v })} />
    </div>
    <div className="grid g-2">
      <div className="card">
        <div className="card-h"><h3>Appearance</h3><div className="spacer" />
          <Seg value={c.mode as any} options={MODES} onChange={(v) => { applyTheme(null, v); setGlobal({ mode: v }); }} /></div>
        <div className="theme-list">
          {THEMES.map((t) => (
            <button key={t.id} className={cx("theme-opt", t.id === c.theme && "on")} onClick={() => { applyTheme(t.id); setGlobal({ theme: t.id }); }}>
              <span className="sw" style={{ background: t.swatch }} /><span><b>{t.name}</b><small>{t.desc}</small></span><span className="chk"><Icon name="check" /></span>
            </button>
          ))}
        </div>
        <p className="note">Phones follow the PC's theme unless they choose their own.</p>
        <div className="perm-row" style={{ marginTop: 8 }}>Interface size<div className="spacer" />
          <Seg value={ui as any} options={SIZES} onChange={(v) => { setUi(v); localStorage.setItem("pbs.ui", v); document.documentElement.style.setProperty("--ui", v); }} /></div>
      </div>

      <Commands />

      <div className="card">
        <div className="card-h"><h3>Files</h3><div className="spacer" /><button className="btn sm" onClick={() => send({ t: "open_share" })}><Icon name="download" />Open folder</button></div>
        <div className="url-row" style={{ cursor: "default" }}><span className="mono">{S.share_dir}</span></div>
        <p className="note">Phones with the <b>Files</b> permission can send files and photos into this folder and download what's in it. Drop a file here to hand it to a phone.</p>
      </div>

      <div className="card">
        <div className="card-h"><h3>Pairing &amp; network</h3><div className="spacer" /><button className="btn sm" onClick={() => send({ t: "new_code" })}>New code</button></div>
        <div className="row"><span className="muted">Room code</span><b className="tnum" style={{ fontSize: 20, letterSpacing: ".15em" }}>{S.code}</b></div>
        <div style={{ marginTop: 12 }}><UrlList S={S} {...join} /></div>
        <PortRow port={S.ports.http} />
        <div className="perm-row" style={{ marginTop: 8 }}>Advertise as phoneboxsound.local<div className="spacer" /><Switch checked={c.mdns} onChange={(v) => setGlobal({ mdns: v })} /></div>
        <div className="perm-row">Secure server for intercom &amp; app install (restart needed)<div className="spacer" /><Switch checked={c.https} onChange={(v) => setGlobal({ https: v })} /></div>
        <div className="perm-row">Warning-free https address via local-ip.sh (restart needed)<div className="spacer" /><Switch checked={c.public_https} onChange={(v) => setGlobal({ public_https: v })} /></div>
        <div className="perm-row"><b>Approve new phones</b>: the code alone isn't enough<div className="spacer" /><Switch checked={c.approval} onChange={(v) => setGlobal({ approval: v })} /></div>
        <div className="perm-row"><b>Lockdown</b>: no phone controls the PC, no new phones, no remote API<div className="spacer" /><Switch checked={c.lockdown} onChange={(v) => setGlobal({ lockdown: v })} /></div>
        <div className="perm-row"><b>Strict security</b>: PC controls only for verified phones<div className="spacer" /><Switch checked={c.strict} onChange={(v) => setGlobal({ strict: v })} /></div>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn sm danger" onClick={() => confirm("Disconnect every phone?") && send({ t: "disconnect_all" })}><Icon name="logout" />Disconnect all phones</button></div>
        <p className="note">The same port answers http and https. On the secure address every phone creates its own key that never leaves it and signs in with that key, so a copied token or a faked address can't pose as it. With <b>strict security</b> on, touchpad, clipboard, screen view, files, commands, power and managing speakers only work for those verified phones. A wrong code locks an address out for a minute after 5 tries.</p>
        <p className="note">The warning-free address uses a public certificate whose key is public too: it removes the browser warning and unlocks secure-page features, but it is not strong protection against someone on your Wi-Fi. It needs internet access.</p>
      </div>

      <div className="card">
        <div className="card-h"><h3>Sync</h3></div>
        {S.pc_out && <PcSpeaker p={S.pc_out} />}
        <div className="perm-row">Lighter stream for a phone while its connection is poor (back to full by itself)<div className="spacer" /><Switch checked={c.auto_quality} onChange={(v) => setGlobal({ auto_quality: v })} /></div>
        <div className="perm-row">Auto buffer (adapts to your Wi-Fi)<div className="spacer" /><Switch checked={c.auto_latency} onChange={(v) => setGlobal({ auto_latency: v })} /></div>
        <div className="perm-row">Lip-sync: shift the player's audio so phones match the picture (VLC, MPC-HC, mpv)<div className="spacer" /><Switch checked={c.lip_sync} onChange={(v) => setGlobal({ lip_sync: v })} /></div>
        <div className="field"><div className="lbl"><span>Buffer</span><b>{c.latency_ms} ms{c.auto_latency ? " · auto" : ""}</b></div>
          <Range value={c.latency_ms} min={60} max={1000} step={10} onChange={(v) => setGlobal({ latency_ms: v })} /></div>
        <div className="field"><div className="lbl"><span>Auto minimum</span><b>{c.min_latency_ms} ms</b></div>
          <Range value={c.min_latency_ms} min={40} max={500} step={10} onChange={(v) => setGlobal({ min_latency_ms: v })} /></div>
        <div className="field"><div className="lbl"><span>Auto maximum</span><b>{c.max_latency_ms} ms</b></div>
          <Range value={c.max_latency_ms} min={150} max={1500} step={50} onChange={(v) => setGlobal({ max_latency_ms: v })} /></div>
      </div>

      <div className="card">
        <div className="card-h"><h3>Player integrations</h3></div>
        <BrowserExtension S={S} />
        <div className="perm-row"><b>Browsers, Spotify, Windows apps</b><div className="spacer" /><span className="pill">Automatic</span></div>
        <PlayerRow id="mpc" name="MPC-HC / MPC-BE" note="Works right away, with timeline and scrubbing. Full control adds a clean video frame as artwork and live skimming while you drag." />
        <div className="perm-row" style={{ marginTop: 8 }}><b>PotPlayer</b><div className="spacer" /><span className="pill">Automatic</span></div>
        <PlayerRow id="vlc" name="VLC" note="One click turns on VLC's web interface for this PC only (port 8081, random password). VLC restarts once if it's open." />
        <div className="perm-row" style={{ marginTop: 10 }}><b>mpv</b><span className="muted">IPC pipe</span><div className="spacer" /><Switch checked={!!c.mpv?.enabled} onChange={(v) => setGlobal({ mpv: { enabled: v } })} /></div>
        <input className="input mono" value={mpvPipe} onChange={(e) => setMpvPipe(e.target.value)} onBlur={() => mpvPipe !== c.mpv?.pipe && setGlobal({ mpv: { pipe: mpvPipe } })} />
        <p className="note">Start mpv with <code className="inline">--input-ipc-server=\\.\pipe\mpvsocket</code>.</p>
      </div>

      <SearchKeys S={S} />

      <PasswordCard />

      <div className="card">
        <div className="card-h"><h3>API &amp; automation</h3><div className="spacer" /><button className="btn sm" onClick={() => send({ t: "rotate_api_token" })}>New token</button></div>
        <div className="url-row" style={{ cursor: "default" }}><span className="mono">{showToken ? S.api_token : `${S.api_token.slice(0, 4)}••••••••••${S.api_token.slice(-3)}`}</span>
          <button className="iconbtn" title={showToken ? "Hide" : "Show"} onClick={() => setShowToken(!showToken)}><Icon name={showToken ? "lock" : "target"} /></button>
          <button className="iconbtn" title="Copy token" onClick={() => copyText(S.api_token).then((ok) => toast(ok ? "Token copied" : "Couldn't copy: press Show and select it"))}><Icon name="copy" /></button></div>
        <div className="row" style={{ margin: "10px 0 6px", flexWrap: "wrap" }}>
          <select className="input" style={{ flex: 1, minWidth: 220 }} value={example} onChange={(e) => setExample(+e.target.value)}>
            {API_EXAMPLES.map((x, i) => <option key={x[0]} value={i}>{x[0]}</option>)}</select>
          <button className="btn sm" onClick={() => copyText(curl(true)).then((ok) => toast(ok ? "Command copied, with your token" : "Couldn't copy"))}><Icon name="copy" />Copy command</button>
        </div>
        <pre className="snippet">{curl(false)}</pre>
        <div className="field"><div className="lbl"><span>Webhooks (one URL per line)</span><button className="btn sm" onClick={() => { setGlobal({ webhooks: hooks.split("\n") }); toast("Webhooks saved"); }}>Save</button></div>
          <textarea className="input mono" rows={3} placeholder="http://homeassistant.local:8123/api/webhook/phoneboxsound" value={hooks} onChange={(e) => setHooks(e.target.value)} /></div>
        <p className="note">Events: device_connected, device_disconnected, media_changed, intercom_started, intercom_stopped, scene_applied, streaming.</p>
      </div>

      <div className="card">
        <div className="card-h"><h3>Diagnostics</h3><div className="spacer" /><a className="btn sm" href="/api/diagnostics"><Icon name="download" />Export</a></div>
        <div className="kv" style={{ gridTemplateColumns: "repeat(2,1fr)" }}>{diag.map(([k, v]) => <div key={k}><span>{k}</span><b>{v}</b></div>)}</div>
        <p className="note">The export contains settings, device health and recent logs, with no tokens or passwords. Attach it to a GitHub issue.</p>
        <p className="muted" style={{ marginBottom: 0 }}>PhoneBoxSound by Pritom Barua · free software under the GNU GPL v3 ·{" "}
          <a href="https://github.com/pritombarua1/PhoneBoxSound" target="_blank" rel="noreferrer">github.com/pritombarua1/PhoneBoxSound</a></p>
      </div>
    </div>
    </>
  );
}
