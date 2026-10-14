import { useState } from "react";
import { Icon } from "../../lib/icons";
import { useStore } from "../../lib/store";
import { toast } from "../../lib/util";
import { BedtimeCard } from "../extras";
import { app, send } from "../store";

const ICONS: Record<string, string> = { music: "music", film: "film", party: "party", moon: "moon", pulse: "pulse", star: "star" };

export default function Presets() {
  const scenes = useStore(app, (s) => s.S)!.cfg.scenes;
  const [name, setName] = useState("");
  return (
    <>
      <div style={{ marginBottom: 18 }}><BedtimeCard /></div>
      <div className="row" style={{ marginBottom: 18, flexWrap: "wrap", gap: 10 }}>
        <input className="input" placeholder="Name for current setup" style={{ maxWidth: 260 }} value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn accent" onClick={() => { send({ t: "scene_save", name }); setName(""); toast("Scene saved"); }}><Icon name="plus" />Save current as scene</button>
        <div className="spacer" />
        <button className="btn sm ghost" onClick={() => send({ t: "scenes_reset" })}>Restore defaults</button>
      </div>
      <div className="scenes">
        {scenes.map((s) => (
          <div className="card scene" key={s.id}>
            <div className="ico"><Icon name={ICONS[s.icon] || "star"} /></div>
            <h3>{s.name}</h3>
            <div className="muted" style={{ fontSize: 13, minHeight: 36 }}>{s.desc}</div>
            <div className="row">
              <button className="btn accent sm" onClick={() => { send({ t: "scene_apply", id: s.id }); toast(`${s.name} applied`); }}>Apply</button>
              <div className="spacer" />
              <button className="iconbtn" title="Delete" onClick={() => send({ t: "scene_delete", id: s.id })}><Icon name="trash" /></button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
