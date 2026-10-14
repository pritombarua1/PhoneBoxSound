import { useCallback, useEffect, useState } from "react";
import { Icon } from "./icons";
import { cx, fmtTime, toast } from "./util";

export interface QueueRow { id: string; uri: string; title: string; artist: string; dur: number; thumb: string | null; liked?: boolean }
export interface QueueInfo { linked: boolean; service: string; now: QueueRow | null; repeat: "off" | "all" | "one"; shuffle: boolean; queue: QueueRow[]; can: Record<string, boolean>; error: string | null }
export interface Playlist { id: string; name: string; count: number | null; thumb: string | null; mine: boolean }
export interface QueueApi { get: () => Promise<QueueInfo>; act: (action: string, value?: unknown) => Promise<{ error: string | null; dup?: number }>; lists: () => Promise<{ list: Playlist[]; error: string | null }> }

/**
 * Your Spotify playlists. mode "play": tap one and it starts. mode "add": tap one and the song goes into it
 * (`track`: a search result's id; left out = the song that is playing now).
 */
export function PlaylistBox({ api, mode, track, liked, done }: { api: QueueApi; mode: "play" | "add"; track?: string; liked?: boolean | null; done?: () => void }) {
  const [got, setGot] = useState<{ list: Playlist[]; error: string | null } | null>(null), [busy, setBusy] = useState(""), [added, setAdded] = useState<string[]>([]);
  const [isLiked, setLiked] = useState(!!liked);
  const [ask, setAsk] = useState<{ id: string; n: number } | null>(null);       // the song is already in this playlist: what now?
  useEffect(() => { api.lists().then(setGot).catch(() => setGot({ list: [], error: "The PC didn't answer" })); }, [api]);
  if (!got) return <div className="share-wait"><span className="srch-spin" style={{ position: "static" }} /> Reading your playlists…</div>;
  const rows = mode === "add" ? got.list.filter((p) => p.mine) : got.list;
  const tap = async (p: Playlist, dup?: "again" | "replace") => {
    setBusy(p.id); setAsk(null);
    const r: { error: string | null; dup?: number } = await api.act(mode === "add" ? "playlist_add" : "playlist_play", mode === "add" ? { id: p.id, track, dup } : p.id).catch(() => ({ error: "The PC didn't answer" }));
    setBusy("");
    if (r.error) return toast(r.error, 5000);
    if (r.dup) return setAsk({ id: p.id, n: r.dup });
    toast(mode === "play" ? `Playing ${p.name}` : dup === "replace" ? `${p.name} now has it once` : `Added to ${p.name}`);
    if (mode === "add") setAdded((a) => [...a, p.id]); else done?.();
  };
  const like = async () => {
    setBusy("liked");
    const r = await api.act(isLiked ? "unlike" : "like", undefined).catch(() => ({ error: "The PC didn't answer" }));
    setBusy("");
    if (r.error) return toast(r.error, 5000);
    setLiked(!isLiked); toast(isLiked ? "Removed from Liked Songs" : "Saved to Liked Songs");
  };
  return (
    <div className="queue">
      {got.error && <p className="note err">{got.error}.</p>}
      <div className="srch-list">
        {mode === "add" && liked != null && !track && (
          <button className="srch-row" disabled={!!busy} onClick={like}>
            <span className="srch-pic sq liked"><Icon name="star" /></span>
            <span className="srch-txt"><b>Liked Songs</b><span>{isLiked ? "saved: tap to remove" : "tap to save"}</span></span>
            <Icon name={isLiked ? "check" : "plus"} />
          </button>
        )}
        {rows.map((p) => ask?.id === p.id ? (
          <div key={p.id} className="q-panel dupask">
            <b>Already in {p.name}{ask.n > 1 ? ` (${ask.n} times)` : ""}</b>
            <span className="muted">Add again puts in one more copy. Replace leaves exactly one, at the end.</span>
            <div className="btn-row"><button className="btn sm accent" onClick={() => tap(p, "again")}>Add again</button>
              <button className="btn sm" onClick={() => tap(p, "replace")}>Replace</button>
              <button className="btn sm ghost" onClick={() => setAsk(null)}>Cancel</button></div>
          </div>
        ) : (
          <button key={p.id} className="srch-row" disabled={!!busy} onClick={() => tap(p)}>
            <span className="srch-pic sq">{p.thumb ? <img src={p.thumb} alt="" loading="lazy" /> : <Icon name="layers" />}</span>
            <span className="srch-txt"><b>{p.name}</b><span>{p.count != null ? `${p.count} songs` : "playlist"}{!p.mine ? " · not yours: play only" : ""}</span></span>
            <Icon name={mode === "play" ? "play" : added.includes(p.id) ? "check" : "plus"} />
          </button>
        ))}
        {!rows.length && !got.error && <div className="muted" style={{ padding: 10 }}>{mode === "add" ? "No playlists of your own yet. Make one in Spotify and it appears here." : "No playlists found."}</div>}
      </div>
    </div>
  );
}

const REPEAT = [["one", "This song"], ["all", "All"], ["off", "Off"]] as const;

/** What plays next, with the controls that the service itself allows: repeat, shuffle, like, jump ahead. */
export function QueueBox({ api, settingsHint }: { api: QueueApi; settingsHint: string }) {
  const [q, setQ] = useState<QueueInfo | null>(null), [busy, setBusy] = useState("");
  const [panel, setPanel] = useState<"add" | "play" | null>(null);
  const load = useCallback(() => api.get().then(setQ).catch(() => {}), [api]);
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);
  const act = async (action: string, value?: unknown, label = "") => {
    setBusy(action + String(value ?? ""));
    const r = await api.act(action, value).catch(() => ({ error: "The PC didn't answer" }));
    setBusy("");
    if (r.error) toast(r.error, 4500); else if (label) toast(label);
    load();
  };
  if (!q) return <div className="share-wait"><span className="srch-spin" style={{ position: "static" }} /> Asking Spotify…</div>;
  if (!q.linked) return <p className="note" style={{ textAlign: "center" }}>Windows only passes on the song's title, not what comes next. To see and steer the queue, connect your Spotify account once: {settingsHint}</p>;
  return (
    <div className="queue">
      {q.error && <p className="note err">{q.error}.</p>}
      {q.now && (
        <div className="q-now">
          <span className="srch-pic sq">{q.now.thumb ? <img src={q.now.thumb} alt="" /> : <Icon name="music" />}</span>
          <span className="srch-txt"><b>{q.now.title}</b><span>{q.now.artist}</span></span>
          <button className={cx("iconbtn", q.now.liked && "active")} title={q.now.liked ? "In your Liked Songs: tap to remove" : "Save to your Liked Songs"} disabled={!!busy}
            onClick={() => act(q.now!.liked ? "unlike" : "like", q.now!.id, q.now!.liked ? "Removed from Liked Songs" : "Saved to Liked Songs")}><Icon name="star" /></button>
        </div>
      )}
      <div className="q-modes">
        <span className="muted">Repeat</span>
        {REPEAT.map(([v, label]) => <button key={v} className={cx("btn sm", q.repeat === v && "accent")} disabled={!!busy} onClick={() => act("repeat", v)}>{label}</button>)}
        <span className="spacer" />
        <button className={cx("btn sm", q.shuffle && "accent")} disabled={!!busy} onClick={() => act("shuffle", !q.shuffle)}><Icon name="shuffle" />Shuffle</button>
      </div>
      <div className="label">Up next</div>
      <div className="srch-list">
        {!q.queue.length && <div className="muted" style={{ padding: 10 }}>Nothing queued after this song.</div>}
        {q.queue.map((r, i) => (
          <button key={r.uri + i} className="srch-row" disabled={!!busy} onClick={() => act("skip", i + 1, `Jumped to ${r.title}`)} title="Jump to this song">
            <span className="q-n tnum">{i + 1}</span>
            <span className="srch-pic sq">{r.thumb ? <img src={r.thumb} alt="" loading="lazy" /> : <Icon name="music" />}{r.dur > 0 && <i>{fmtTime(r.dur)}</i>}</span>
            <span className="srch-txt"><b>{r.title}</b><span>{r.artist}</span></span>
            <Icon name="next" />
          </button>
        ))}
      </div>
      {panel && <div className="q-panel"><div className="row" style={{ marginBottom: 6 }}><b style={{ flex: 1 }}>{panel === "add" ? "Add this song to…" : "Play a playlist"}</b><button className="iconbtn" onClick={() => setPanel(null)}><Icon name="x" /></button></div>
        <PlaylistBox api={api} mode={panel} liked={q.now?.liked ?? null} done={() => { setPanel(null); setTimeout(load, 900); }} /></div>}
      {!panel && <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <button className="btn sm" onClick={() => setPanel("add")}><Icon name="plus" />Add this song to a playlist</button>
        <button className="btn sm" onClick={() => setPanel("play")}><Icon name="layers" />Play a playlist</button></div>}
      <p className="note">Tap a song to jump ahead to it. To add one, search for it and press "Play next". Spotify lets other apps add to the queue but not reorder or remove what is in it; that part can only be done in Spotify itself.</p>
    </div>
  );
}
