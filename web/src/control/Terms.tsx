import { Icon } from "../lib/icons";
import { send } from "./store";

/** Shown once, the first time the dashboard opens: what this program can do, and who is responsible for what. */
export default function Terms() {
  return (
    <div className="modal-bg">
      <div className="card modal terms" role="dialog" aria-modal="true" aria-labelledby="terms-h">
        <div className="card-h"><Icon name="shield" /><h3 id="terms-h">Before you start</h3></div>
        <p><b>PhoneBoxSound can give a phone control over this PC.</b> Pointer and keyboard, clipboard, screen view, files,
          power and your own commands are all <b>off</b> until you switch them on for a phone, on the Remote page.
          New phones wait for your approval.</p>
        <ul>
          <li>Use it only on computers, networks and devices you own or are allowed to use.</li>
          <li>You decide who connects and what they may do, and you are responsible for that.</li>
          <li>Using it to harm, spy on or get into other people's devices or accounts is forbidden.</li>
          <li>Mind the volume, your hearing and your neighbours.</li>
        </ul>
        <p className="muted">It is free open-source software by Pritom Barua under the GNU GPL v3, provided <b>as is</b>, without any warranty.
          The authors and contributors are not liable for any damage or loss, or for how anyone uses it or a copy of it.
          Nothing is sent to the authors; there is no account and no cloud. The full text is in DISCLAIMER.md, next to the program.</p>
        <div className="row" style={{ justifyContent: "flex-end", gap: 10 }}>
          <button className="btn accent" autoFocus onClick={() => send({ t: "accept_terms" })}><Icon name="check" />I understand and agree</button>
        </div>
      </div>
    </div>
  );
}
