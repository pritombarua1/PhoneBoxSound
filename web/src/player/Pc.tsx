import { memo, useEffect, useRef, useState } from "react";
import { Icon } from "../lib/icons";
import { useStore } from "../lib/store";
import { Fold } from "../lib/ui";
import { store, toast, vibrate } from "../lib/util";
import { input, phone, send } from "./engine";
import Power from "./Power";
import Transfer from "./Transfer";

/**
 * Everything about the PC itself: seeing it better, your own commands, files, and power.
 * Each part only appears if the PC allowed it for this phone, and each is folded away until needed.
 */
export default memo(function Pc({ openMagnifier }: { openMagnifier: () => void }) {
  const cfg = useStore(phone, (s) => s.cfg);
  const incoming = useStore(phone, (s) => s.incoming);
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

      {p.files && cfg.file_token && <Fold title="Files & media" icon="download" value={incoming.length ? `${incoming.length} new from the PC` : "Send & receive"} open={incoming.length > 0}><Transfer token={cfg.file_token} /></Fold>}

      {p.power && <Fold title="Power" icon="power" value="Lock · Sleep · Off"><Power /></Fold>}
    </div>
  );
});
