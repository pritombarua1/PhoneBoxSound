import { Icon } from "../../lib/icons";
import { PERM_INFO } from "../../lib/perms";
import { useStore } from "../../lib/store";
import { Switch } from "../../lib/ui";
import { app, setDevice } from "../store";

const COLS = PERM_INFO.filter((p) => p.key !== "speaker" && p.key !== "intercom").map((p) => [p.key, p.label] as const);
const CAN = [
  ["music", "Play/pause, ±10 s, ±30 s, scrub the timeline, next/previous, volume, speed"],
  ["fullscreen", "Fullscreen and subtitles"],
  ["mouse", "Touchpad: move, tap to click, tap-then-hold to drag, two-finger scroll and right click"],
  ["keyboard", "Keyboard: type text, arrows, Esc, Enter, Copy/Paste, Alt-Tab"],
  ["copy", "Clipboard both ways: copy on the PC, paste on the phone, and the reverse (text and images)"],
  ["tv", "Screen view: the whole screen or the active window, live inside the touchpad"],
  ["lock", "Lock screen controls on the phone drive the PC too"],
];

export default function Remote({ go }: { go: (p: string) => void }) {
  const devices = useStore(app, (s) => s.S)!.devices;
  return (
    <div className="grid g-2">
      <div className="card">
        <div className="card-h"><h3>Who can control this PC</h3></div>
        <div style={{ overflowX: "auto" }}><table className="matrix"><tbody>
          <tr><th>Phone</th>{COLS.map(([, l]) => <th key={l}>{l}</th>)}</tr>
          {!devices.length && <tr><td colSpan={12} className="muted">No phones paired yet.</td></tr>}
          {devices.filter((d) => !d.blocked).map((d) => (
            <tr key={d.device_id}>
              <td><span className={`dot ${d.online ? "good" : ""}`} style={{ display: "inline-block", marginRight: 8 }} />{d.name}</td>
              {COLS.map(([k]) => <td key={k}><Switch checked={d.perms[k]} onChange={(v) => setDevice(d.device_id, { perms: { [k]: v } })} /></td>)}
            </tr>
          ))}
        </tbody></table></div>
        <p className="note">Each switch is one thing that phone may do. The ones marked <b>reaches into the PC</b> are off until you turn them on, and only work for a phone on the secure link that has proved its own key.</p>
        <div className="permlist">{PERM_INFO.map((p) => <div key={p.key} className={p.pc ? "pc" : ""}><b>{p.label}</b><span>{p.what}</span></div>)}</div>
      </div>
      <div className="col" style={{ gap: 20 }}>
        <div className="card">
          <div className="card-h"><h3>What phones can do</h3></div>
          <div className="col" style={{ gap: 8 }}>{CAN.map(([icon, text]) => <div className="row" key={icon}><Icon name={icon} />{text}</div>)}</div>
        </div>
        <div className="card">
          <div className="card-h"><h3>Player integrations</h3><div className="spacer" /><button className="btn sm" onClick={() => go("settings")}>Configure</button></div>
          <p className="note" style={{ marginTop: 0 }}>Browsers, Spotify, MPC-HC (K-Lite) and PotPlayer work automatically. VLC needs one click in Settings.</p>
        </div>
      </div>
    </div>
  );
}
