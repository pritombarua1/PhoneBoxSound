import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { Icon } from "../../lib/icons";
import { useStore } from "../../lib/store";
import type { MediaState } from "../../lib/types";
import { Art, Range, SeekBar, Seg, Sheet, Skip, SwapIcon } from "../../lib/ui";
import { cx, fmtRate } from "../../lib/util";
import { SearchBox } from "../../lib/search";
import { ShareBox } from "../../lib/share";
import { PlaylistBox, QueueBox } from "../../lib/queue";
import { SpotifyNow } from "../SpotifyNow";
import { cmd, phone, queueApi, searchApi, send, shareInfo } from "../engine";

const Touchpad = lazy(() => import("../Touchpad"));
const Clipboard = lazy(() => import("../Clipboard"));
const Pc = lazy(() => import("../Pc"));
const MODES = [{ v: "media", label: "Media" }, { v: "pad", label: "Touchpad" }, { v: "clip", label: "Clipboard" }, { v: "power", label: "PC" }] as const;
const PRESETS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

function PlayerSheet({ media, close }: { media: MediaState | null; close: () => void }) {
  const pick = (id: string) => { cmd("target", id); close(); };
  const sessions = media?.sessions ?? [];
  return (
    <Sheet title="Control which player?" close={close}>
      <div className="list">
        <div className={cx("item", !media?.pinned && "on")} onClick={() => pick("")}>
          <span className="dot info" /><div style={{ flex: 1, minWidth: 0 }}><b>Automatic</b><small>Follows what you started last</small></div>{!media?.pinned && <Icon name="check" />}
        </div>
        {sessions.map((s) => (
          <div key={s.id} className={cx("item", media?.pinned === s.id && "on")} onClick={() => pick(s.id)}>
            <Art hash={s.art} className="thumb" />
            <div style={{ flex: 1, minWidth: 0 }}><b>{s.app}</b><small>{s.status}{s.title ? " · " + s.title : ""}</small></div>
            {media?.pinned === s.id ? <Icon name="check" /> : media?.active?.id === s.id ? <span className="dot good" /> : null}
          </div>
        ))}
        {!sessions.length && <div className="item muted">No players open on the PC.</div>}
      </div>
    </Sheet>
  );
}

function SpeedSheet({ media, close }: { media: MediaState | null; close: () => void }) {
  const a = media?.active, rate = a?.rate || 1;
  return (
    <Sheet title="Playback speed" close={close}>
      <div className="speed-now">{a?.rate_known ? fmtRate(rate) : "Speed"}
        <small>{!a ? "Nothing playing" : a.rate_known ? a.app : `${a.app} doesn't report its speed, so use the steps`}</small></div>
      <div className="speed-steps">
        <button onClick={() => cmd("speed", "down")}>− Slower</button>
        <button className="mid" onClick={() => cmd("speed", 1)}>1× Normal</button>
        <button onClick={() => cmd("speed", "up")}>Faster +</button>
      </div>
      {a?.can?.rate && <div className="speed-presets">{PRESETS.map((r) => <button key={r} className={Math.abs(r - rate) < 0.01 ? "on" : ""} onClick={() => cmd("speed", r)}>{r}×</button>)}</div>}
    </Sheet>
  );
}

/** Artwork that doubles as a gesture area: double-tap a side = ∓10 s, swipe = seek by distance. */
function Gesture({ art, className }: { art?: string | null; className?: string }) {
  const [hint, setHint] = useState<{ side: "L" | "R"; text: string; n: number } | null>(null);
  const g = useRef({ sx: 0, sy: 0, st: 0, lastTap: 0, lastSide: 0 });
  const flash = (side: "L" | "R", text: string) => { const n = Date.now(); setHint({ side, text, n }); setTimeout(() => setHint((h) => (h?.n === n ? null : h)), 650); };
  return (
    <Art hash={art} className={cx("gesture", className)}>
      <div className="hint"><span className={hint?.side === "L" ? "show" : ""}>{hint?.side === "L" ? hint.text : ""}</span><span className={hint?.side === "R" ? "show" : ""}>{hint?.side === "R" ? hint.text : ""}</span></div>
      <div style={{ position: "absolute", inset: 0, touchAction: "none" }}
        onPointerDown={(e) => { g.current.sx = e.clientX; g.current.sy = e.clientY; g.current.st = performance.now(); }}
        onPointerUp={(e) => {
          const s = g.current, dx = e.clientX - s.sx, dy = e.clientY - s.sy, w = e.currentTarget.clientWidth;
          if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
            const secs = Math.abs(dx) > w * 0.6 ? 60 : Math.abs(dx) > w * 0.35 ? 30 : Math.abs(dx) > w * 0.18 ? 10 : 5;
            cmd("seek", dx > 0 ? secs : -secs);
            return flash(dx > 0 ? "R" : "L", dx > 0 ? `${secs}s »` : `« ${secs}s`);
          }
          if (performance.now() - s.st > 300) return;
          const r = e.currentTarget.getBoundingClientRect(), side = e.clientX - r.left < w / 2 ? -1 : 1, now = performance.now();
          if (now - s.lastTap < 350 && side === s.lastSide) { cmd("seek", side * 10); flash(side > 0 ? "R" : "L", side > 0 ? "10s »" : "« 10s"); s.lastTap = 0; }
          else { s.lastTap = now; s.lastSide = side; }
        }} />
    </Art>
  );
}

function Lock({ title }: { title: string }) {
  return <div className="card lock"><Icon name="lock" /><b>{title}</b><span>Turn it on for this phone in the PC dashboard (Devices or Remote page).</span></div>;
}

/** Shown when the PC granted powerful permissions but this connection hasn't proved who it is. */
export function SecurityNote() {
  const cfg = useStore(phone, (s) => s.cfg);
  if (!cfg.locked?.length) return null;
  return (
    <div className="card secnote">
      <div className="row"><Icon name="shield" /><b style={{ flex: 1 }}>Some controls are locked for safety</b></div>
      {cfg.lockdown ? (
        <div className="muted" style={{ fontSize: 13.5, marginTop: 6 }}>The PC is in lockdown. Phones can listen, use the media remote and the intercom, but nothing else until it is switched off on the PC.</div>
      ) : cfg.verify_code ? (
        <>
          <div className="muted" style={{ fontSize: 13.5, marginTop: 6 }}>On the PC, open Devices and press <b>Verify</b> next to this phone. Check that it shows this number:</div>
          <div className="vcode tnum">{cfg.verify_code}</div>
        </>
      ) : cfg.can_sign ? (
        <div className="muted" style={{ fontSize: 13.5, marginTop: 6 }}>Waiting for the PC to confirm this phone.</div>
      ) : (
        <>
          <div className="muted" style={{ fontSize: 13.5, marginTop: 6 }}>Controlling the PC (touchpad, clipboard, screen, files, power…) only works on the secure link, where this phone can prove it's really yours.</div>
          {cfg.https_url && <button className="btn accent bigbtn" style={{ marginTop: 10 }} onClick={() => send({ t: "handoff" })}>Switch to the secure link</button>}
        </>
      )}
    </div>
  );
}

export default function Remote() {
  const media = useStore(phone, (s) => s.media);
  const at = useStore(phone, (s) => s.mediaAt);
  const perms = useStore(phone, (s) => s.cfg.perms);
  const locked = useStore(phone, (s) => s.cfg.locked);
  const held = (p: string) => !!locked?.includes(p);   // granted by the PC, withheld until this phone is verified
  const [mode, setMode] = useState<"media" | "pad" | "clip" | "power">("media");
  const [sheet, setSheet] = useState<"players" | "speed" | "repeat" | "queue" | null>(null);
  const [finding, setFinding] = useState(false);
  const searchField = useRef<HTMLInputElement>(null);
  const openSearch = () => { setFinding(true); searchField.current?.focus({ preventScroll: true }); };
  const closeSearch = () => { searchField.current?.blur(); setFinding(false); };
  useEffect(() => {
    // the screen ends where the keyboard begins, so results are never hidden behind it
    const vv = window.visualViewport;
    if (!vv) return;
    const fit = () => document.documentElement.style.setProperty("--vvh", vv.height + "px");
    fit(); vv.addEventListener("resize", fit); vv.addEventListener("scroll", fit);
    return () => { vv.removeEventListener("resize", fit); vv.removeEventListener("scroll", fit); };
  }, []);
  useEffect(() => { if (mode !== "media" && finding) setFinding(false); }, [mode]);   // eslint-disable-line react-hooks/exhaustive-deps
  const [sharing, setSharing] = useState(false);
  const [lists, setLists] = useState<{ mode: "add" | "play"; liked: boolean | null } | null>(null);
  const a = media?.active ?? null, pc = media?.pc;
  const spotify = !!a && /spotify/i.test(a.app);
  const own = !!a?.can?.volume && typeof a.volume === "number";
  const vol = own ? (a!.volume as number) : pc?.volume;
  const needsSetup = a?.setup && (a.setup === "vlc" || !a.duration);

  return (
    <>
      <Seg value={mode} options={MODES} onChange={setMode} className="modes" style={{ alignSelf: "center" }} />
      {mode !== "media" && <SecurityNote />}

      {mode === "power" && <Suspense fallback={null}><Pc openMagnifier={() => setMode("pad")} /></Suspense>}

      {mode === "clip" && (perms.clipboard ? <Suspense fallback={null}><Clipboard /></Suspense> : !held("clipboard") && <Lock title="Clipboard sharing is off for this phone" />)}

      {mode === "pad" && (perms.input ? <Suspense fallback={null}><Touchpad /></Suspense> : !held("input") && <Lock title="Keyboard & mouse is off for this phone" />)}

      {mode === "media" && !perms.remote && <Lock title="Media remote is off for this phone" />}
      {mode === "media" && perms.search && (
        <button className={cx("card srch-open", spotify && "slim")} onClick={openSearch}><Icon name="search" /><span>Search YouTube, Spotify, Apple Music…</span></button>
      )}
      {sharing && <Sheet title="Share what's playing" close={() => setSharing(false)}><ShareBox load={shareInfo} /></Sheet>}
      {/* Always in the page, off-screen until opened: its field can then be focused inside the very tap that opens
          it, which is the only way an iPhone brings the keyboard up on the right field the first time. */}
      {perms.search && (
        <div className={cx("searchpage", finding && "on")} aria-hidden={!finding}>
          <SearchBox api={searchApi} inputRef={searchField} onClose={closeSearch} />
        </div>
      )}
      {mode === "media" && perms.remote && spotify && (
        <SpotifyNow a={a!} at={at} volume={vol} cmd={cmd} onShare={() => setSharing(true)} onPlayers={() => setSheet("players")} onRepeat={() => setSheet("repeat")}
          onQueue={() => setSheet("queue")} onLists={(mode, liked) => setLists({ mode, liked })} cover={<Gesture art={a!.art} className="sp-art" />} onVolume={(v) => cmd(own ? "volume" : "pc_volume", v)} />
      )}
      {mode === "media" && perms.remote && !spotify && (
        <div className="col" style={{ gap: 14 }}>
          <div className="card np-card">
            <div className="top">
              <Art hash={a?.art} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="title">{a ? a.title || a.app : "Nothing playing"}</div>
                <div className="artist">{a ? [a.artist, a.album].filter(Boolean).join(" · ") || a.app : "Play something on the PC"}</div>
              </div>
              {a && <button className="iconbtn sharebtn" title="Link and QR code for this" onClick={() => setSharing(true)}><Icon name="link" /></button>}
              <button className="appbadge picker" title="Choose player" onClick={() => setSheet("players")}><span>{a ? a.app : "Players"}</span><Icon name="chevron" className="rot" /></button>
            </div>
            {needsSetup && <div className="basic">{a!.setup === "vlc"
              ? <><b>VLC needs one click</b> on the PC: Dashboard → Settings → VLC → Enable full control.</>
              : <>Basic control. Turn on <b>full control</b> for this player in the PC dashboard for the timeline.</>}</div>}
            <Gesture art={a?.art} />
            <SeekBar className="seek" active={a} at={at} onSeek={(s) => cmd("seek_to", s)} />
            <div className="transport">
              <Skip secs={-10} onClick={() => cmd("seek", -10)} />
              <button className="roundbtn" onClick={() => cmd("toggle")}><SwapIcon name={a?.status === "playing" ? "pause" : "play"} /></button>
              <Skip secs={10} onClick={() => cmd("seek", 10)} />
            </div>
            <div className="volrow">
              <button className="iconbtn" onClick={() => cmd("pc_mute", !pc?.muted)}><Icon name={pc?.muted ? "mute" : "volume"} /></button>
              <Range value={vol ?? 0} onChange={(v) => cmd(own ? "volume" : "pc_volume", v)} />
              <span className="muted tnum" style={{ width: 40, textAlign: "right" }}>{typeof vol === "number" ? Math.round(vol * 100) + "%" : "–"}</span>
            </div>
          </div>
          <div className="tiles two">
            <button className="tile" onClick={() => cmd("previous")}><Icon name="prev" />Previous</button>
            <button className="tile" onClick={() => cmd("next")}><Icon name="next" />Next</button>
          </div>
          <div className="tiles">
            <button className="tile" onClick={() => setSheet("speed")}><Icon name="speed" />Speed <small>{a?.rate_known ? fmtRate(a.rate) : "Adjust"}</small></button>
            <button className="tile" onClick={() => cmd("subtitles")}><Icon name="cc" />Subtitles <small>Toggle</small></button>
            <button className="tile" onClick={() => cmd("fullscreen")}><Icon name="fullscreen" />Fullscreen <small>Toggle</small></button>
          </div>
          <div className="tiles two">
            <button className={cx("tile", a?.shuffle && "on", a && !a.can?.shuffle && "dim")} onClick={() => cmd("shuffle")}><Icon name="shuffle" />Shuffle <small>{a?.shuffle ? "On" : "Off"}</small></button>
            <button className={cx("tile", !!a?.repeat && a.repeat !== "off" && "on", a && !a.can?.repeat && "dim")} onClick={() => setSheet("repeat")}>
              <Icon name={a?.repeat === "one" ? "repeat1" : "repeat"} />Repeat <small>{a?.repeat === "one" ? "One song" : a?.repeat === "all" ? "All songs" : "Off"}</small></button>
          </div>
          <div className="tiles two">
            <button className="tile" onClick={() => cmd("seek", -30)}><Icon name="back" />−30 s</button>
            <button className="tile" onClick={() => cmd("seek", 30)}><Icon name="fwd" />+30 s</button>
          </div>
        </div>
      )}
      {sheet === "players" && <PlayerSheet media={media} close={() => setSheet(null)} />}
      {sheet === "speed" && <SpeedSheet media={media} close={() => setSheet(null)} />}
      {sheet === "queue" && <Sheet title="Up next on Spotify" close={() => setSheet(null)}><QueueBox api={queueApi} settingsHint="on the PC, open Settings → Search → Connect Spotify." /></Sheet>}
      {lists && <Sheet title={lists.mode === "add" ? "Save this song to…" : "Your playlists"} close={() => setLists(null)}>
        <PlaylistBox api={queueApi} mode={lists.mode} liked={lists.liked} done={() => setLists(null)} /></Sheet>}
      {sheet === "repeat" && (
        <Sheet title="Repeat" close={() => setSheet(null)}>
          {/* say which one you want, instead of tapping through them */}
          <div className="col" style={{ gap: 8 }}>
            {([["one", "repeat1", "This song", "plays the same song again and again"], ["all", "repeat", "All songs", "starts the list again at the end"], ["off", "x", "Off", "stops at the end"]] as const).map(([v, icon, label, what]) => (
              <button key={v} className={cx("btn choice", (a?.repeat ?? "off") === v && "accent")} onClick={() => { cmd("repeat", v); setSheet(null); }}>
                <Icon name={icon} /><span><b>{label}</b><small>{what}</small></span></button>
            ))}
          </div>
          {a && !a.can?.repeat && <p className="note">{a.app} doesn't let other programs change this.</p>}
        </Sheet>
      )}
    </>
  );
}
