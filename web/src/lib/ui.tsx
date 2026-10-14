import { memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Icon } from "./icons";
import type { MediaSession } from "./types";
import { clamp, cx, fmtTime } from "./util";

/** Slider that shows its fill, and ignores server echoes while the user is dragging it. */
export function Range({ value, onChange, min = 0, max = 1, step = 0.01, className, title }: {
  value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; className?: string; title?: string;
}) {
  const [local, setLocal] = useState<number | null>(null);
  const release = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The knob follows the finger at once; the PC is told about 15 times a second, and always the final value.
  const out = useRef({ last: 0, timer: 0 as unknown as ReturnType<typeof setTimeout>, next: 0 });
  const tell = (n: number) => {
    const o = out.current, now = performance.now();
    o.next = n; clearTimeout(o.timer);
    if (now - o.last >= 66) { o.last = now; onChange(n); } else o.timer = setTimeout(() => { o.last = performance.now(); onChange(o.next); }, 66 - (now - o.last));
  };
  const v = local ?? value ?? 0;
  const pct = ((v - min) / (max - min)) * 100;
  const hold = () => { clearTimeout(release.current); };
  const letGo = () => { clearTimeout(release.current); release.current = setTimeout(() => setLocal(null), 1200); };
  useEffect(() => () => clearTimeout(release.current), []);
  return (
    <input type="range" className={className} title={title} min={min} max={max} step={step} value={v}
      style={{ "--p": pct + "%" } as CSSProperties}
      onPointerDown={() => { hold(); setLocal(v); }} onPointerUp={letGo} onPointerCancel={letGo} onBlur={letGo}
      onChange={(e) => { const n = +e.target.value; hold(); setLocal(n); tell(n); if (!e.nativeEvent.isTrusted) letGo(); }}
      onKeyUp={letGo} />
  );
}

export const Switch = memo(function Switch({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return <label className="switch"><input type="checkbox" checked={!!checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} /><span /></label>;
});

/** Segmented control whose highlight slides to the chosen option. */
export function Seg<T extends string>({ value, options, onChange, className, style }: {
  value: T | null | undefined; options: readonly { v: T; label: ReactNode; title?: string }[]; onChange: (v: T) => void; className?: string; style?: CSSProperties;
}) {
  const root = useRef<HTMLDivElement>(null), thumb = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const r = root.current, t = thumb.current;
    if (!r || !t) return;
    const place = () => {
      const on = r.querySelector<HTMLButtonElement>("button.on");
      if (!on) { t.style.opacity = "0"; return; }
      t.style.opacity = "1";
      t.style.transform = `translate(${on.offsetLeft}px, ${on.offsetTop}px)`;
      t.style.width = on.offsetWidth + "px"; t.style.height = on.offsetHeight + "px";
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(r);
    return () => ro.disconnect();
  });
  return (
    <div className={cx("seg slide", className)} style={style} ref={root}>
      <span className="seg-thumb" ref={thumb} />
      {options.map((o) => <button key={o.v} title={o.title} className={o.v === value ? "on" : ""} onClick={() => onChange(o.v)}>{o.label}</button>)}
    </div>
  );
}

/** A collapsible section: keeps long screens calm. Remembers nothing; closed unless `open`. */
export function Fold({ title, value, icon, open, children }: { title: string; value?: ReactNode; icon?: string; open?: boolean; children: ReactNode }) {
  return (
    <details className="card fold" open={open}>
      <summary>{icon && <Icon name={icon} />}<span className="ft">{title}</span><span className="fv">{value}</span><Icon name="chevron" className="chev" /></summary>
      <div className="fold-body">{children}</div>
    </details>
  );
}

/** Text that survives leaving the screen: switch tabs mid-sentence and it is still there when you come back. */
const drafts = new Map<string, string>();
export function useDraft(key: string): [string, (v: string) => void] {
  const [v, setV] = useState(() => drafts.get(key) ?? (() => { try { return sessionStorage.getItem("pbs.draft." + key) ?? ""; } catch { return ""; } })());
  const set = (next: string) => {
    drafts.set(key, next); setV(next);
    try { if (next) sessionStorage.setItem("pbs.draft." + key, next); else sessionStorage.removeItem("pbs.draft." + key); } catch { /* storage blocked */ }
  };
  return [v, set];
}

/** Bottom sheet (phone) / dialog. Tap outside to close. */
export function Sheet({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  useEffect(() => { const esc = (e: KeyboardEvent) => e.key === "Escape" && close(); addEventListener("keydown", esc); return () => removeEventListener("keydown", esc); }, [close]);
  return (
    <div className="sheet-bg" onClick={(e) => e.target === e.currentTarget && close()}>
      <div className="sheet"><div className="grab" onClick={close} />
        <div className="sheet-h"><h3>{title}</h3><button className="iconbtn sheet-x" aria-label="Close" onClick={close}><Icon name="x" /></button></div>
        <div className="sheet-body">{children}</div></div>
    </div>
  );
}

/** An icon that pops when it changes (play ↔ pause, volume ↔ mute). */
export function SwapIcon({ name, className }: { name: string; className?: string }) {
  return <span className="swap" key={name}><Icon name={name} className={className} /></span>;
}

/** Artwork (cover art or a captured video frame) with an icon fallback. */
export const Art = memo(function Art({ hash, className, style, children }: { hash?: string | null; className?: string; style?: CSSProperties; children?: ReactNode }) {
  return (
    <div className={cx("art", className)} style={style}>
      {hash ? <img src={`/art/${hash}`} alt="" decoding="async" /> : <Icon name="music" />}
      {children}
    </div>
  );
});

export const livePos = (a: MediaSession, at: number) =>
  a.status === "playing" ? Math.min(a.position + ((performance.now() - at) / 1000) * (a.rate || 1), a.duration || Infinity) : a.position;

/**
 * Timeline with skimming: drag to see the time under your finger; players that seek instantly follow
 * while you drag, the rest jump when you let go. Ticks by writing to the DOM directly (no re-render).
 */
export function SeekBar({ active, at, onSeek, className = "seekbar" }: {
  active: MediaSession | null; at: number; onSeek: (seconds: number) => void; className?: string;
}) {
  const root = useRef<HTMLDivElement>(null), bar = useRef<HTMLElement>(null), knob = useRef<HTMLDivElement>(null);
  const bubble = useRef<HTMLDivElement>(null), pos = useRef<HTMLSpanElement>(null);
  const dragging = useRef(false);
  const optimistic = useRef<{ pos: number; at: number } | null>(null);
  const live = useRef({ active, at });
  live.current = { active, at };

  useEffect(() => {
    optimistic.current = null;
  }, [active?.position, active?.id]);

  useEffect(() => {
    const paint = () => {
      if (dragging.current) return;
      const { active: a, at: t } = live.current;
      const o = optimistic.current;
      const p = !a ? 0 : o && performance.now() - o.at < 2500 ? o.pos : livePos(a, t);
      const pct = a?.duration ? (p / a.duration) * 100 : 0;
      if (bar.current) bar.current.style.width = pct + "%";
      if (knob.current) knob.current.style.left = pct + "%";
      if (pos.current) pos.current.textContent = fmtTime(p);
    };
    paint();
    const id = setInterval(paint, 250);
    return () => clearInterval(id);
  }, []);

  const canScrub = !!active?.duration && active.can?.seek_to !== false && active.can?.seek !== false;

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const a = active;
    if (!a || !canScrub) return;
    const el = root.current!;
    try { el.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    dragging.current = true; el.classList.add("drag");
    let lastSent = 0, lastF = -1;
    const frac = (ev: PointerEvent | React.PointerEvent) => { const r = el.getBoundingClientRect(); return clamp((ev.clientX - r.left) / r.width, 0, 1); };
    const move = (ev: PointerEvent | React.PointerEvent) => {
      const f = frac(ev), secs = f * a.duration;
      bar.current!.style.width = knob.current!.style.left = bubble.current!.style.left = f * 100 + "%";
      bubble.current!.textContent = `${fmtTime(secs)} / ${fmtTime(a.duration)}`;
      if (pos.current) pos.current.textContent = fmtTime(secs);
      if (a.live_seek && performance.now() - lastSent > 280 && Math.abs(f - lastF) * a.duration > 1) { lastSent = performance.now(); lastF = f; onSeek(secs); }
    };
    const up = (ev: PointerEvent) => {
      el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); el.removeEventListener("pointercancel", up);
      dragging.current = false; el.classList.remove("drag");
      const secs = frac(ev) * a.duration;
      optimistic.current = { pos: secs, at: performance.now() };   // show the new spot until the player confirms
      onSeek(secs);
    };
    move(e);
    el.addEventListener("pointermove", move); el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up);
  };

  return (
    <>
      <div className={className} ref={root} onPointerDown={onDown} style={{ cursor: canScrub ? "pointer" : "default" }}>
        <div className="progress"><i ref={bar} /></div>
        <div className="knob" ref={knob} /><div className="bubble" ref={bubble} />
      </div>
      <div className="np-times times tnum"><span ref={pos}>0:00</span><span>{active?.duration ? fmtTime(active.duration) : "–:––"}</span></div>
    </>
  );
}

/** Button with the skip-back / skip-forward ring and the seconds inside. */
export function Skip({ secs, onClick, disabled }: { secs: number; onClick: () => void; disabled?: boolean }) {
  return (
    <button className="iconbtn skip" onClick={onClick} disabled={disabled} title={`${secs > 0 ? "Forward" : "Back"} ${Math.abs(secs)} s`}>
      <Icon name={secs > 0 ? "fwd" : "back"} /><b>{Math.abs(secs)}</b>
    </button>
  );
}
