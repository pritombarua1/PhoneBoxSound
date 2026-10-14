import { Icon } from "../../lib/icons";
import { Art, Skip, Switch } from "../../lib/ui";
import { cx } from "../../lib/util";
import { AppBadge, PlayButton, SetupButton, ShuffleRepeat, subtitleOf, Timeline, useMedia, VolumeRow } from "../media";
import { BrowserHint } from "../browser";
import { SearchBox } from "../../lib/search";
import { useState } from "react";
import { ShareBox } from "../../lib/share";
import { QueueBox } from "../../lib/queue";
import { mediaCmd, queueApi, searchApi, shareInfo } from "../store";

const SPEEDS = [0.5, 1, 1.25, 1.5, 2];

export default function NowPlaying() {
  const { media, a, pc } = useMedia();
  const sessions = media?.sessions ?? [];
  const can = a?.can ?? {};
  const [sharing, setSharing] = useState(false);
  const spotify = !!a && /spotify/i.test(a.app);
  const music = !!a && /spotify|music|tidal|deezer|soundcloud|winamp|foobar/i.test(a.app);      // a cover, not a film: no skip-30, speed, subtitles
  return (
    <>
    {sharing && (
      <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && setSharing(false)}>
        <div className="card modal" style={{ maxWidth: 440 }}>
          <div className="card-h"><h3>Share what's playing</h3><div className="spacer" /><button className="iconbtn" onClick={() => setSharing(false)}><Icon name="x" /></button></div>
          <ShareBox load={shareInfo} />
        </div>
      </div>
    )}
    <BrowserHint />
    <div className="np-page">
      <div className="col" style={{ gap: 20 }}>
      <div className="card">
        <div className={cx("np", music ? "music" : "video")}>
          <Art hash={a?.art} className="np-hero" />
          <div className="np-left">
            <div className="np-head" style={{ margin: "4px 0 14px" }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="np-title" style={{ fontSize: 24 }}>{a ? a.title || a.app : "Nothing playing"}</div>
                <div className="np-artist">{subtitleOf(a)}</div>
              </div>
              <SetupButton a={a} />{a && <button className="btn sm" title="Link and QR code for what is playing" onClick={() => setSharing(true)}><Icon name="link" />Share</button>}<AppBadge a={a} />
            </div>
            <Timeline />
            <div className="np-controls" style={{ justifyContent: "center", gap: 14 }}>
              <ShuffleRepeat />
              <button className="iconbtn" title="Previous" disabled={!!a && !can.previous} onClick={() => mediaCmd("previous")}><Icon name="prev" /></button>
              {!music && <Skip secs={-30} onClick={() => mediaCmd("seek", -30)} />}
              <Skip secs={-10} onClick={() => mediaCmd("seek", -10)} />
              <PlayButton size={64} />
              <Skip secs={10} onClick={() => mediaCmd("seek", 10)} />
              {!music && <Skip secs={30} onClick={() => mediaCmd("seek", 30)} />}
              <button className="iconbtn" title="Next" disabled={!!a && !can.next} onClick={() => mediaCmd("next")}><Icon name="next" /></button>
              {!music && <button className="iconbtn" title="Stop" onClick={() => mediaCmd("stop")}><Icon name="stop" /></button>}
            </div>
            <div className="row" style={{ marginTop: 18, flexWrap: "wrap", gap: 10 }}>
              <VolumeRow />
              {!music && <>
              <div className="seg">
                <button title="Slower" onClick={() => mediaCmd("speed", "down")}>−</button>
                {SPEEDS.map((s) => <button key={s} className={a?.rate_known && Math.abs((a.rate || 1) - s) < 0.01 ? "on" : ""} onClick={() => mediaCmd("speed", s)}>{s}×</button>)}
                <button title="Faster" onClick={() => mediaCmd("speed", "up")}>+</button>
              </div>
              <button className="btn sm" onClick={() => mediaCmd("subtitles")}><Icon name="cc" />Subtitles</button>
              <button className="btn sm" onClick={() => mediaCmd("fullscreen")}><Icon name="fullscreen" />Fullscreen</button>
              </>}
            </div>
          </div>
        </div>
      </div>
      <div className="card"><div className="card-h"><h3>Search and play</h3></div><SearchBox api={searchApi} /></div>
      </div>
      <div className="col" style={{ gap: 20 }}>
        {spotify && <div className="card"><div className="card-h"><h3>Up next</h3><span className="sub">Spotify</span></div>
          <QueueBox api={queueApi} settingsHint="Settings → Search → Connect Spotify." /></div>}
        <div className="card">
          <div className="card-h"><h3>Media on this PC</h3></div>
          <div className="urls">
            <div className={cx("url-row", !media?.pinned && "on")} onClick={() => mediaCmd("target", "")}>
              <Icon name="zap" /><span style={{ flex: 1 }}><b>Automatic</b> <span className="muted">follows what you just started</span></span>
            </div>
            {sessions.map((s) => (
              <div key={s.id} className={cx("url-row session", (media?.pinned === s.id || (!media?.pinned && a?.id === s.id)) && "on")} onClick={() => mediaCmd("target", s.id)}>
                <Art hash={s.art} className="thumb" />
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  <b>{s.app}</b> <span className="muted">{s.title || s.status}</span>
                </span>
                {s.status === "playing" && <span className={cx("dot", s.audible ? "good" : "warn")} title={s.audible ? "Playing" : "Playing (silent)"} />}
                {media?.pinned === s.id && <span className="pill">pinned</span>}
              </div>
            ))}
            {!sessions.length && <p className="note">No media apps found yet. Open a video or some music.</p>}
          </div>
          <p className="note">Automatic follows whichever player you started, resumed or changed last, and prefers the one actually making sound. Click a player to pin it; the pin lets go when you start something else.</p>
        </div>
        <div className="card">
          <div className="card-h"><h3>PC speakers</h3></div>
          <div className="perm-row">Mute PC speakers (phones keep playing)<div className="spacer" /><Switch checked={!!pc?.muted} onChange={(v) => mediaCmd("pc_mute", v)} /></div>
          <p className="note">Windows capture happens before the PC volume, so the PC can be silent while phones play at full volume.</p>
        </div>
      </div>
    </div>
    </>
  );
}
