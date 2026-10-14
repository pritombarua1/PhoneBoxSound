import { useEffect, useState } from "react";
import { Icon } from "./icons";
import { copyText, toast } from "./util";

export interface ShareLink { label: string; url: string; exact: boolean; svg: string }
export interface ShareInfo { title: string; artist: string; app: string; art: string | null; links: ShareLink[]; why?: string }

/** The link to what is playing: its picture, a QR code to scan, the address to copy. */
export function ShareBox({ load }: { load: () => Promise<ShareInfo> }) {
  const [info, setInfo] = useState<ShareInfo | null>(null), [pick, setPick] = useState(0), [failed, setFailed] = useState(false);
  useEffect(() => { let on = true; load().then((i) => on && setInfo(i)).catch(() => on && setFailed(true)); return () => { on = false; }; }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  if (failed) return <p className="note">The PC didn't answer. Try again.</p>;
  if (!info) return <div className="share-wait"><span className="srch-spin" style={{ position: "static" }} /> Finding the link…</div>;
  const link = info.links[Math.min(pick, info.links.length - 1)];
  const share = (navigator as any).share ? () => (navigator as any).share({ title: info.title, url: link.url }).catch(() => {}) : null;
  return (
    <div className="share">
      <div className="share-top">
        {info.art ? <img className="share-art" src={`/art/${info.art}`} alt="" /> : <span className="share-art none"><Icon name="music" /></span>}
        <div style={{ minWidth: 0 }}><b>{info.title || "Nothing playing"}</b><span>{[info.artist, info.app].filter(Boolean).join(" · ")}</span></div>
      </div>
      {!link ? <p className="note">{info.why || "There is no public link for this."}</p> : <>
        {info.links.length > 1 && <div className="share-tabs">{info.links.map((l, i) => <button key={l.url} className={`btn sm ${i === pick ? "accent" : ""}`} onClick={() => setPick(i)}>{l.label}</button>)}</div>}
        <div className="qr share-qr" key={link.url} dangerouslySetInnerHTML={{ __html: link.svg }} />
        <div className="share-url"><span className="mono">{link.url}</span></div>
        <div className="row" style={{ justifyContent: "center", gap: 8, flexWrap: "wrap" }}>
          <button className="btn accent" onClick={async () => toast((await copyText(link.url)) ? "Link copied" : "Couldn't copy: press and hold the address instead")}><Icon name="copy" />Copy link</button>
          {share && <button className="btn" onClick={share}><Icon name="link" />Share…</button>}
          <a className="btn" href={link.url} target="_blank" rel="noreferrer noopener"><Icon name="play" />Open here</a>
        </div>
        {!link.exact && <p className="note" style={{ textAlign: "center" }}>{info.app || "This player"} doesn't tell the PC its link, so this one was found on {link.label} by title and artist. It should be the same song.</p>}
      </>}
    </div>
  );
}
