import { memo, useEffect, useRef, useState } from "react";
import { Icon } from "../lib/icons";
import { useStore } from "../lib/store";
import { Fold } from "../lib/ui";
import { store, toast, vibrate } from "../lib/util";
import { input, phone, send } from "./engine";
import Power from "./Power";

interface SharedFile { name: string; size: number; mtime: number }
const size = (n: number) => (n > 1e9 ? (n / 1e9).toFixed(1) + " GB" : n > 1e6 ? (n / 1e6).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1e3)) + " KB");

function Files({ token }: { token: string }) {
  const [files, setFiles] = useState<SharedFile[] | null>(null);
  const [busy, setBusy] = useState<{ name: string; pct: number } | null>(null);
  const pick = useRef<HTMLInputElement>(null);
  const load = () => fetch(`/files/list?k=${token}`).then((r) => r.json()).then(setFiles).catch(() => setFiles([]));
  useEffect(() => { load(); }, [token]);

  const upload = async (list: FileList) => {
    for (const f of Array.from(list)) {
      await new Promise<void>((done) => {
        const x = new XMLHttpRequest();
        x.open("POST", `/files/put?k=${token}&name=${encodeURIComponent(f.name)}`);
        x.upload.onprogress = (e) => setBusy({ name: f.name, pct: e.lengthComputable ? (e.loaded / e.total) * 100 : 0 });
        x.onload = () => { toast(x.status === 200 ? `Sent ${f.name}` : `Couldn't send ${f.name}`); done(); };
        x.onerror = () => { toast(`Couldn't send ${f.name}`); done(); };
        setBusy({ name: f.name, pct: 0 });
        x.send(f);
      });
    }
    setBusy(null); load();
  };

  return (
    <>
      <button className="btn accent" style={{ width: "100%" }} onClick={() => pick.current?.click()}><Icon name="plus" />Send files or photos to the PC</button>
      <input ref={pick} type="file" multiple hidden onChange={(e) => { if (e.target.files?.length) upload(e.target.files); e.target.value = ""; }} />
      {busy && <div style={{ marginTop: 10 }}><div className="muted" style={{ fontSize: 13 }}>Sending {busy.name}… {Math.round(busy.pct)}%</div><div className="progress" style={{ marginTop: 6 }}><i style={{ width: busy.pct + "%" }} /></div></div>}
      <div className="row" style={{ margin: "14px 0 4px" }}><span className="label" style={{ flex: 1 }}>In the PC's shared folder</span><button className="iconbtn" title="Refresh" onClick={load}><Icon name="refresh" /></button></div>
      <div className="list">
        {files === null && <div className="muted">Loading…</div>}
        {files?.length === 0 && <div className="muted" style={{ fontSize: 13.5 }}>Nothing yet. Files you send appear here, and anything put in the folder on the PC can be downloaded.</div>}
        {files?.map((f) => (
          <a key={f.name} className="item file" href={`/files/get/${encodeURIComponent(f.name)}?k=${token}`} download={f.name}>
            <Icon name="download" /><span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</span>
            <span className="muted tnum" style={{ fontSize: 12.5 }}>{size(f.size)}</span>
          </a>
        ))}
      </div>
    </>
  );
}

/**
 * Everything about the PC itself: seeing it better, your own commands, files, and power.
 * Each part only appears if the PC allowed it for this phone, and each is folded away until needed.
 */
export default memo(function Pc({ openMagnifier }: { openMagnifier: () => void }) {
  const cfg = useStore(phone, (s) => s.cfg);
  const p = cfg.perms;
  const key = (...keys: string[]) => { input({ kind: "key", keys }); vibrate(8); };
  const nothing = !p.input && !p.screen && !p.commands && !p.files && !p.power;
  return (
    <div className="col" style={{ gap: 12 }}>
      {nothing && <div className="card lock"><Icon name="lock" /><b>Nothing here is switched on for this phone</b><span>On the PC dashboard, open Devices and allow what you need: screen view, keyboard &amp; mouse, commands, files or power.</span></div>}

      {(p.screen || p.input) && (
        <Fold title="See the screen better" icon="target" value="Magnifier" open>
          {p.screen && <>
            <button className="btn accent" style={{ width: "100%" }} onClick={() => { store.set("pbs.view", "zoom"); openMagnifier(); }}><Icon name="target" />Magnify on this phone</button>
            <div className="muted" style={{ fontSize: 13, margin: "8px 0 14px" }}>Shows the area around the PC's pointer, enlarged and sharp, on this phone. Move the pointer with the touchpad and read here.</div>
          </>}
          {p.input && <>
            <div className="label" style={{ marginBottom: 6 }}>Magnify on the monitor (Windows Magnifier)</div>
            <div className="tiles">
              <button className="tile" onClick={() => key("win", "=")}><Icon name="plus" />Bigger</button>
              <button className="tile" onClick={() => key("win", "-")}>−<small>Smaller</small></button>
              <button className="tile" onClick={() => key("win", "esc")}><Icon name="x" />Off</button>
            </div>
            <div className="label" style={{ margin: "12px 0 6px" }}>Text size in the active window</div>
            <div className="tiles">
              <button className="tile" onClick={() => key("ctrl", "=")}>A+<small>Larger</small></button>
              <button className="tile" onClick={() => key("ctrl", "-")}>A−<small>Smaller</small></button>
              <button className="tile" onClick={() => key("ctrl", "0")}>A<small>Reset</small></button>
            </div>
          </>}
        </Fold>
      )}

      {p.commands && (
        <Fold title="Commands" icon="zap" value={`${cfg.commands?.length ?? 0}`}>
          {!cfg.commands?.length && <div className="muted" style={{ fontSize: 13.5 }}>No commands yet. Add some on the PC: Dashboard → Settings → Commands.</div>}
          <div className="keys short" style={{ gridTemplateColumns: "1fr 1fr" }}>
            {cfg.commands?.map((c) => <button key={c.id} onClick={() => { send({ t: "command", id: c.id }); vibrate(10); }}>{c.name}</button>)}
          </div>
        </Fold>
      )}

      {p.files && cfg.file_token && <Fold title="Files" icon="download" value="Send & receive"><Files token={cfg.file_token} /></Fold>}

      {p.power && <Fold title="Power" icon="power" value="Lock · Sleep · Off"><Power /></Fold>}
    </div>
  );
});
