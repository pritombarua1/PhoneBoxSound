import { memo, useRef } from "react";
import { Icon } from "../lib/icons";
import { useStore } from "../lib/store";
import { SwapIcon } from "../lib/ui";
import { cx, fmtTime } from "../lib/util";
import { addFiles, clearTracks, hostState, next, play, previous, seek, stopHosting, toggle } from "./hosting";

/** Play audio files from this phone on every phone at once. */
export default memo(function Host() {
  const s = useStore(hostState, (x) => x);
  const file = useRef<HTMLInputElement>(null);
  const pct = s.dur ? Math.min(100, (s.pos / s.dur) * 100) : 0;
  return (
    <div className="col" style={{ gap: 12 }}>
      <button className="btn accent" style={{ width: "100%" }} onClick={() => file.current?.click()}><Icon name="plus" />{s.names.length ? "Add more songs" : "Choose songs from this phone"}</button>
      <input ref={file} type="file" accept="audio/*" multiple hidden onChange={(e) => { if (e.target.files?.length) addFiles(e.target.files); e.target.value = ""; }} />
      {s.loading && <div className="muted" style={{ fontSize: 13 }}>Preparing {s.loading}…</div>}
      {s.names.length > 0 && <>
        <div className="host-now">
          <b>{s.names[s.index]}</b>
          <div className="progress" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); seek(((e.clientX - r.left) / r.width) * s.dur); }}><i style={{ width: pct + "%" }} /></div>
          <div className="times tnum"><span>{fmtTime(s.pos)}</span><span>{s.on ? (s.playing ? "Playing on every phone" : "Paused") : "Not hosting"}</span><span>{fmtTime(s.dur)}</span></div>
          <div className="transport">
            <button className="iconbtn" onClick={previous}><Icon name="prev" /></button>
            <button className="roundbtn" onClick={toggle}><SwapIcon name={s.on && s.playing ? "pause" : "play"} /></button>
            <button className="iconbtn" onClick={() => next()}><Icon name="next" /></button>
          </div>
        </div>
        <div className="list">
          {s.names.map((n, i) => (
            <div key={i} className={cx("item", i === s.index && "on")} onClick={() => play(i)}>
              <Icon name={i === s.index && s.playing ? "volume" : "music"} /><span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{n}</span>
            </div>
          ))}
        </div>
        <div className="btn-row">
          {s.on && <button className="btn" onClick={stopHosting}>Stop hosting</button>}
          <button className="btn ghost" onClick={clearTracks}>Clear list</button>
        </div>
      </>}
      <div className="muted" style={{ fontSize: 12.5 }}>
        Works with audio files stored on this phone. A browser can't capture the Spotify or YouTube app's sound. For Spotify, open its device list and choose this PC ("Spotify Connect"): the PC plays, and every phone follows in sync.
      </div>
    </div>
  );
});
