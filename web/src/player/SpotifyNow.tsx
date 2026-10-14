import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Icon } from "../lib/icons";
import type { QueueInfo } from "../lib/queue";
import type { MediaSession } from "../lib/types";
import { Range, SeekBar, Skip, SwapIcon } from "../lib/ui";
import { cx, fmtTime, toast } from "../lib/util";
import { queueApi } from "./engine";

/**
 * Spotify on the phone, laid out the way Spotify lays it out: the cover, the song with its heart, the
 * timeline, five buttons, and what plays next. Nothing else on the screen.
 */
export function SpotifyNow({ a, at, volume, cmd, cover, onShare, onPlayers, onRepeat, onQueue, onLists, onVolume }: {
  a: MediaSession; at: number; volume: number | undefined; cmd: (action: string, value?: unknown) => void;
  onShare: () => void; onPlayers: () => void; onRepeat: () => void; onQueue: () => void; onLists: (mode: "add" | "play", liked: boolean | null) => void; cover: ReactNode; onVolume: (v: number) => void;
}) {
  const [q, setQ] = useState<QueueInfo | null>(null), [busy, setBusy] = useState(false);
  const load = useCallback(() => queueApi.get().then(setQ).catch(() => {}), []);
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load, a.title]);
  const act = async (action: string, value?: unknown, done = "") => {
    setBusy(true);
    const r = await queueApi.act(action, value).catch(() => ({ error: "The PC didn't answer" }));
    setBusy(false);
    toast(r.error || done, r.error ? 4500 : 1800);
    load();
  };
  const linked = !!q?.linked, liked = !!q?.now?.liked;
  const repeat = linked ? q!.repeat : a.repeat ?? "off", shuffle = linked ? q!.shuffle : !!a.shuffle;
  return (
    <div className="sp">
      <div className="sp-bar">
        <button className="iconbtn" title="Choose player" onClick={onPlayers}><Icon name="chevron" /></button>
        <span>Playing on the PC · Spotify</span>
        <span className="row" style={{ gap: 2 }}>
          {linked && <button className="iconbtn" title="Your playlists" onClick={() => onLists("play", null)}><Icon name="layers" /></button>}
          <button className="iconbtn" title="Link and QR code" onClick={onShare}><Icon name="link" /></button>
        </span>
      </div>
      {/* the cover is also the swipe area: swipe to move through the song, double-tap a side for 10 seconds */}
      {cover}
      <div className="sp-head">
        <div style={{ minWidth: 0, flex: 1 }}><b>{a.title || "Spotify"}</b><span>{a.artist}</span></div>
        {linked && q!.now && <button className={cx("iconbtn sp-heart", liked && "on")} disabled={busy} title="Save to Liked Songs or a playlist" onClick={() => onLists("add", liked)}><Icon name={liked ? "check" : "plus"} /></button>}
      </div>
      <SeekBar className="seek" active={a} at={at} onSeek={(s) => cmd("seek_to", s)} />
      <div className="sp-ctl">
        <button className={cx("iconbtn", shuffle && "on")} title="Shuffle" onClick={() => { cmd("shuffle"); setTimeout(load, 700); }}><Icon name="shuffle" /></button>
        <button className="iconbtn big" title="Previous" onClick={() => cmd("previous")}><Icon name="prev" /></button>
        <Skip secs={-10} onClick={() => cmd("seek", -10)} />
        <button className="roundbtn" onClick={() => cmd("toggle")}><SwapIcon name={a.status === "playing" ? "pause" : "play"} /></button>
        <Skip secs={10} onClick={() => cmd("seek", 10)} />
        <button className="iconbtn big" title="Next" onClick={() => { cmd("next"); setTimeout(load, 900); }}><Icon name="next" /></button>
        <button className={cx("iconbtn", repeat !== "off" && "on")} title="Repeat" onClick={onRepeat}><Icon name={repeat === "one" ? "repeat1" : "repeat"} /></button>
      </div>
      <div className="sp-vol">
        <Icon name="volume" /><Range value={volume ?? 0} onChange={onVolume} />
      </div>
      {linked ? (
        <div className="sp-next">
          <div className="sp-next-h"><b>Next</b>{q!.queue.length > 3 && <button className="btn sm ghost" onClick={onQueue}>See all {q!.queue.length}</button>}</div>
          {q!.error && <div className="muted" style={{ fontSize: 13 }}>{q!.error}.</div>}
          {!q!.error && !q!.queue.length && <div className="muted" style={{ fontSize: 13 }}>Nothing queued after this song.</div>}
          {q!.queue.slice(0, 3).map((r, i) => (
            <button key={r.uri + i} className="sp-row" disabled={busy} onClick={() => act("skip", i + 1, `Playing ${r.title}`)}>
              <span className="sp-pic">{r.thumb ? <img src={r.thumb} alt="" loading="lazy" /> : <Icon name="music" />}</span>
              <span className="sp-txt"><b>{r.title}</b><span>{r.artist}</span></span>
              <span className="muted tnum">{r.dur ? fmtTime(r.dur) : ""}</span>
            </button>
          ))}
        </div>
      ) : q && (
        <p className="note" style={{ textAlign: "center", margin: 0 }}>To see what's next and like songs from here, connect your Spotify account once on the PC: Settings → Search → Connect Spotify.</p>
      )}
    </div>
  );
}
