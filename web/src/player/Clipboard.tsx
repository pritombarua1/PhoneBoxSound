import { memo, useEffect, useRef, useState } from "react";
import { Icon } from "../lib/icons";
import { useStore } from "../lib/store";
import { Switch, useDraft } from "../lib/ui";
import { toast } from "../lib/util";
import { phone, send } from "./engine";

/** Copy text to this phone's clipboard. The async API needs a secure page, so fall back to the classic way. */
async function copyToPhone(text: string) {
  try {
    if (window.isSecureContext && navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through */ }
  const ta = document.createElement("textarea");
  ta.value = text; ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
  document.body.appendChild(ta); ta.focus(); ta.select(); ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { /* unsupported */ }
  ta.remove();
  return ok;
}

/**
 * Save a picture on the phone. Phones don't download "data:" links, so the picture comes from a real
 * address on the PC: the share sheet ("Save Image") where the browser allows it, a normal download otherwise.
 */
async function saveImage(url: string) {
  try {
    const blob = await (await fetch(url)).blob();
    const file = new File([blob], "pc-clipboard.jpg", { type: "image/jpeg" });
    if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file] }); return; }
  } catch (e: any) { if (e?.name === "AbortError") return; }
  const a = document.createElement("a");
  a.href = url; a.download = "pc-clipboard.jpg";
  document.body.appendChild(a); a.click(); a.remove();
  toast("If nothing was saved, press and hold the picture and choose Save", 4000);
}

/** Shrink big photos before sending: the PC clipboard doesn't need 12 megapixels. */
function fileToDataUrl(file: File, max = 2400): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file), im = new Image();
    im.onload = () => {
      const k = Math.min(1, max / Math.max(im.naturalWidth, im.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(im.naturalWidth * k); c.height = Math.round(im.naturalHeight * k);
      c.getContext("2d")!.drawImage(im, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL("image/jpeg", 0.9));
    };
    im.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That file isn't an image")); };
    im.src = url;
  });
}

/**
 * Two-way clipboard between the PC and this phone (text and images).
 * Nothing is read or written until you press a button, unless you switch "Live" on.
 */
export default memo(function Clipboard() {
  const clip = useStore(phone, (s) => s.clip);
  const [text, setText] = useDraft("clip");
  const [live, setLive] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => { send({ t: "clip_get" }); return () => { send({ t: "clip_live", on: false }); }; }, []);

  const pasteFromPhone = async () => {
    try {
      if (window.isSecureContext && navigator.clipboard?.readText) { setText(await navigator.clipboard.readText()); return; }
    } catch { /* permission denied */ }
    toast("Long-press the box below and choose Paste", 3500);
  };
  const sendText = (paste: boolean) => { if (!text) return toast("Type or paste something first"); send({ t: "clip_set", text, paste }); };
  const sendImage = async (f: File | undefined) => {
    if (!f) return;
    try { send({ t: "clip_set", image: await fileToDataUrl(f) }); } catch (e: any) { toast(e?.message || "Couldn't read that image"); }
    if (file.current) file.current.value = "";
  };

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="card">
        <div className="card-h"><h3>PC clipboard</h3><div className="spacer" />
          <span className="muted" style={{ fontSize: 13 }}>Live</span><Switch checked={live} onChange={(v) => { setLive(v); send({ t: "clip_live", on: v }); if (v) send({ t: "clip_get" }); }} />
          <button className="iconbtn" title="Refresh" onClick={() => send({ t: "clip_get" })}><Icon name="refresh" /></button></div>
        {!clip && <div className="muted">Reading…</div>}
        {clip?.kind === "empty" && <div className="muted">The PC clipboard is empty (or holds something that isn't text or a picture).</div>}
        {clip?.kind === "text" && <>
          <pre className="clip-text">{clip.text}</pre>
          <div className="btn-row" style={{ marginTop: 10 }}>
            <button className="btn accent" onClick={async () => toast((await copyToPhone(clip.text || "")) ? "Copied to this phone" : "Select the text above and copy it")}><Icon name="copy" />Copy to this phone</button>
            <button className="btn" onClick={() => setText(clip.text || "")}>Edit below</button>
          </div>
        </>}
        {clip?.kind === "image" && <>
          <img className="clip-img" src={clip.url || clip.image} alt="PC clipboard" />
          <div className="btn-row" style={{ marginTop: 10 }}>
            <button className="btn accent" onClick={() => saveImage(clip.url || clip.image!)}><Icon name="download" />Save to this phone</button>
            <a className="btn" href={clip.url || clip.image} target="_blank" rel="noreferrer">Open</a>
          </div>
          <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>{clip.w}×{clip.h} · you can also press and hold the picture and choose Save to Photos</div>
        </>}
      </div>

      <div className="card">
        <div className="card-h"><h3>Send to the PC</h3><div className="spacer" /><button className="btn sm" onClick={pasteFromPhone}>Paste from phone</button></div>
        <textarea className="input clip-area" placeholder="Type here, or paste what you copied on the phone…" value={text} onChange={(e) => setText(e.target.value)} />
        <div className="btn-row" style={{ marginTop: 10 }}>
          <button className="btn" onClick={() => sendText(false)}>Copy to PC</button>
          <button className="btn accent" onClick={() => sendText(true)}>Copy &amp; paste on PC</button>
        </div>
        <div className="btn-row" style={{ marginTop: 8 }}>
          <button className="btn" onClick={() => file.current?.click()}><Icon name="plus" />Send a picture to the PC clipboard</button>
          <input ref={file} type="file" accept="image/*" hidden onChange={(e) => sendImage(e.target.files?.[0])} />
        </div>
        <div className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>"Copy &amp; paste" puts it on the PC clipboard and presses Ctrl+V in whatever window is active there.</div>
      </div>
    </div>
  );
});
