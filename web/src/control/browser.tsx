import { useState } from "react";
import { Icon } from "../lib/icons";
import { useStore } from "../lib/store";
import type { ServerState } from "../lib/types";
import { Switch } from "../lib/ui";
import { app, send, setGlobal } from "./store";

const STORES = [["chrome", "Chrome, Brave, Opera, Vivaldi"], ["edge", "Edge"], ["firefox", "Firefox"]] as const;
const family = (name: string) => (name === "Firefox" ? "firefox" : name === "Edge" ? "edge" : "chrome");
const mine = () => (/Firefox\//.test(navigator.userAgent) ? "Firefox" : /Edg\//.test(navigator.userAgent) ? "Edge" : "Chrome");

/** One way to get the extension for a browser: the store page once it is published, the packed file until then. */
function GetIt({ S, browser, small }: { S: ServerState; browser: string; small?: boolean }) {
  const store = S.extension_urls[family(browser)] || (family(browser) === "edge" ? S.extension_urls.chrome : "");
  return store
    ? <a className={`btn accent ${small ? "sm" : ""}`} href={store} target="_blank" rel="noreferrer"><Icon name="plus" />Add to {browser}</a>
    : <a className={`btn accent ${small ? "sm" : ""}`} href={`/extension.zip?for=${family(browser) === "firefox" ? "firefox" : "chrome"}`}><Icon name="download" />Get it for {browser}</a>;
}

/** Shown where the music is: a browser is playing, and it could be controlled much better. */
export function BrowserHint() {
  const S = useStore(app, (s) => s.S);
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem("pbs.exthint") || ""; } catch { return ""; } });
  const names = (S?.browser_hint ?? []).filter((n) => !hidden.split(",").includes(n));
  if (!S || !names.length) return null;
  const b = names[0];
  const waiting = S.browsers.find((x) => !x.approved);
  return (
    <div className="card exthint">
      <Icon name="zap" />
      <div style={{ flex: 1, minWidth: 220 }}>
        <b>Two hands are better than one.</b> {b} is playing, but Windows only lets PhoneBoxSound press its media keys: one entry, whichever tab {b} picks, no exact seeking.
        The PhoneBoxSound extension is the second hand inside the browser: every tab that plays becomes its own player on your phone, with the exact position, drag-to-seek, speed and volume, and the picture kept in step with the phones.
      </div>
      {waiting ? <button className="btn accent sm" onClick={() => send({ t: "browser_approve", id: waiting.id, ok: true })}>Approve {waiting.name}</button> : <GetIt S={S} browser={b} small />}
      <button className="btn sm ghost" onClick={() => { const v = [hidden, b].filter(Boolean).join(","); setHidden(v); try { localStorage.setItem("pbs.exthint", v); } catch { /* ignore */ } }}>Not now</button>
    </div>
  );
}

/** Settings: get it, approve it, see it connected. */
export function BrowserExtension({ S }: { S: ServerState }) {
  const [how, setHow] = useState(false), [urls, setUrls] = useState(S.extension_urls), [edit, setEdit] = useState(false);
  const me = mine(), published = !!(S.extension_urls.chrome || S.extension_urls.firefox || S.extension_urls.edge);
  return (
    <div className="ext">
      <div className="row"><b>Browser tabs</b>
        <span className="muted" style={{ fontSize: 12.5, flex: 1 }}>{S.browsers.some((b) => b.connected) ? "connected" : S.browsers.some((b) => !b.approved) ? "a browser is waiting for your approval" : "extension not connected"}</span>
        <GetIt S={S} browser={me} small />
        {!published && <button className="btn sm ghost" onClick={() => setHow(!how)}>{how ? "Hide steps" : "How to add it"}</button>}</div>
      <p className="note"><b>A second hand for your browser.</b> Without it, Windows shows one entry per browser and the browser decides which tab that is. With it, every tab that plays is listed by itself, with exact position, seeking, speed and volume.</p>
      {S.browsers.map((b) => (
        <div className="perm-row" key={b.id ?? b.name}>
          <span className={`dot ${b.connected ? "good" : b.approved ? "" : "warn"}`} style={{ marginRight: 8 }} /><b>{b.name}</b>
          <span className="muted" style={{ marginLeft: 8, fontSize: 12.5 }}>{!b.approved ? "wants to connect" : b.connected ? `${b.tabs} tab${b.tabs === 1 ? "" : "s"} playing` : "not running"}</span><div className="spacer" />
          {!b.approved && <button className="btn sm accent" onClick={() => send({ t: "browser_approve", id: b.id, ok: true })}>Approve</button>}
          {b.id && <button className="btn sm ghost" onClick={() => send({ t: "browser_approve", id: b.id, ok: false })}>{b.approved ? "Remove" : "Deny"}</button>}
        </div>
      ))}
      {how && !published && (
        <ol className="steps">
          <li>Press <b>Get it for {me}</b> and unpack the zip into a folder you will keep.</li>
          {me === "Firefox"
            ? <li>Open <span className="mono">about:debugging#/runtime/this-firefox</span>, press <b>Load Temporary Add-on</b>, choose <span className="mono">manifest.json</span>. Firefox drops add-ons that are not from its store when it closes.</li>
            : <li>Open <span className="mono">{me === "Edge" ? "edge" : "chrome"}://extensions</span>, switch on <b>Developer mode</b>, press <b>Load unpacked</b>, choose the folder.</li>}
          <li>Come back to this page: the browser appears above. Press <b>Approve</b>. That's all; no password is typed anywhere.</li>
          <li className="muted">Browsers only install with one click from their own stores. Until this extension is published there (files and steps: <span className="mono">extension/README.md</span>), these steps are the only way a browser allows. After publishing, paste the store links below and this turns into an "Add to {me}" button.</li>
        </ol>
      )}
      <div className="perm-row">Keep the picture in step with the phones (shows it later by the sync buffer)<div className="spacer" /><Switch checked={S.cfg.browser_delay} onChange={(v) => setGlobal({ browser_delay: v })} /></div>
      <p className="note">Works for ordinary web video (YouTube, Twitch, news and social sites). Copy-protected films (Netflix, Prime Video, Disney+) do not let any program copy their frames, so their picture is left as it is.</p>
      <button className="btn sm ghost" onClick={() => setEdit(!edit)}>{edit ? "Close" : "Store links (after publishing)"}</button>
      {edit && <div className="col" style={{ marginTop: 8 }}>
        {STORES.map(([k, label]) => <input key={k} className="input mono" placeholder={`https://… store page for ${label}`} value={urls[k] || ""} onChange={(e) => setUrls({ ...urls, [k]: e.target.value })} />)}
        <button className="btn sm" onClick={() => { send({ t: "extension_urls", urls }); setEdit(false); }}>Save links</button>
      </div>}
    </div>
  );
}
