import { useState } from "react";
import { Icon } from "../lib/icons";
import { useStore } from "../lib/store";
import type { MediaSession } from "../lib/types";
import { Art, Range, SeekBar, Skip, SwapIcon } from "../lib/ui";
import { app, mediaCmd, setupPlayer } from "./store";

export function useMedia() {
  const media = useStore(app, (s) => s.media);
  const at = useStore(app, (s) => s.mediaAt);
  return { media, at, a: media?.active ?? null, pc: media?.pc ?? null };
}

export const subtitleOf = (a: MediaSession | null) =>
  a ? [a.artist, a.album].filter(Boolean).join(" · ") || a.app : "Play something on the PC and it shows up here";

export function AppBadge({ a }: { a: MediaSession | null }) {
  if (!a) return null;
  return <span className="appbadge"><Icon name={a.kind === "browser" ? "tv" : "music"} />{a.app}</span>;
}

export function SetupButton({ a }: { a: MediaSession | null }) {
  if (!a?.setup) return null;
  return <button className="btn sm soft" onClick={() => setupPlayer(a.setup!)}>Enable full control</button>;
}

/** PC (or player) volume with a mute button. Players that expose their own volume use that. */
export function VolumeRow() {
  const { a, pc } = useMedia();
  const own = !!a?.can?.volume && typeof a.volume === "number";
  const v = own ? (a!.volume as number) : pc?.volume;
  return (
    <div className="np-vol">
      <button className="iconbtn" title="Mute PC speakers" onClick={() => mediaCmd("pc_mute", !pc?.muted)}><Icon name={pc?.muted ? "mute" : "volume"} /></button>
      <Range value={v ?? 0} onChange={(n) => mediaCmd(own ? "volume" : "pc_volume", n)} />
      <span className="muted tnum" style={{ width: 38 }}>{typeof v === "number" ? Math.round(v * 100) + "%" : "–"}</span>
    </div>
  );
}

const REPEAT_LABEL = { off: "Repeat: off", all: "Repeat all", one: "Repeat one" } as const;

/** Shuffle and repeat (off → all → one), lit when active, dimmed when the player can't do it. */
export function ShuffleRepeat() {
  const { a } = useMedia();
  const rep = a?.repeat ?? "off";
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className={`iconbtn ${a?.shuffle ? "active" : ""}`} title={a?.shuffle ? "Shuffle: on" : "Shuffle"} disabled={!!a && !a.can?.shuffle} onClick={() => mediaCmd("shuffle")}><Icon name="shuffle" /></button>
      <button className={`iconbtn ${rep !== "off" ? "active" : ""}`} title={REPEAT_LABEL[rep]} disabled={!!a && !a.can?.repeat} onClick={() => setOpen(!open)}><Icon name={rep === "one" ? "repeat1" : "repeat"} /></button>
      {open && (
        <span className="repmenu" onMouseLeave={() => setOpen(false)}>
          {([["one", "This song"], ["all", "All songs"], ["off", "Off"]] as const).map(([v, label]) => (
            <button key={v} className={`btn sm ${rep === v ? "accent" : ""}`} onClick={() => { mediaCmd("repeat", v); setOpen(false); }}>{label}</button>
          ))}
        </span>
      )}
    </>
  );
}

export function Timeline() {
  const { a, at } = useMedia();
  return <SeekBar active={a} at={at} onSeek={(s) => mediaCmd("seek_to", s)} />;
}

export function PlayButton({ size }: { size?: number }) {
  const { a } = useMedia();
  return (
    <button className="roundbtn" title="Play / Pause" style={size ? { width: size, height: size } : undefined} onClick={() => mediaCmd("toggle")}>
      <SwapIcon name={a?.status === "playing" ? "pause" : "play"} />
    </button>
  );
}

/** Compact card used on the dashboard. */
export function NowPlayingCard() {
  const { a } = useMedia();
  return (
    <div className="card">
      <div className="card-h"><h2>Now Playing</h2><div className="spacer" /><SetupButton a={a} /><AppBadge a={a} /></div>
      <div className="np">
        <div className="np-left">
          <div className="np-head">
            <Art hash={a?.art} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="np-title">{a ? a.title || a.app : "Nothing playing"}</div>
              <div className="np-artist">{subtitleOf(a)}</div>
            </div>
          </div>
          <Timeline />
          <div className="np-controls">
            <ShuffleRepeat />
            <Skip secs={-10} onClick={() => mediaCmd("seek", -10)} />
            <PlayButton />
            <Skip secs={10} onClick={() => mediaCmd("seek", 10)} />
            <VolumeRow />
          </div>
        </div>
        <Art hash={a?.art} className="np-hero" />
      </div>
    </div>
  );
}
