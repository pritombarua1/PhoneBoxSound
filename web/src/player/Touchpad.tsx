import { memo, useEffect, useRef, useState } from "react";
import { Icon } from "../lib/icons";
import { useStore } from "../lib/store";
import { Range, Seg, Switch } from "../lib/ui";
import { cx, store, vibrate } from "../lib/util";
import { input, phone, screenLink, screenView, send } from "./engine";
import Keys from "./Keys";

const VIEWS = [{ v: "off", label: "Off" }, { v: "screen", label: "Screen" }, { v: "window", label: "Window" }, { v: "zoom", label: "Magnifier" }] as const;
const ZOOMS = [{ v: "2", label: "2×" }, { v: "3", label: "3×" }, { v: "4", label: "4×" }, { v: "6", label: "6×" }, { v: "8", label: "8×" }] as const;
type View = "off" | "screen" | "window" | "zoom";


/**
 * Laptop-style touchpad.
 *   move = 1 finger · tap = click · double-tap = double click · 2-finger tap = right click
 *   scroll = 2 fingers, or 1 finger on the strip at the right edge
 *   drag = tap-then-hold and move, or long-press, or hold the Left button with another finger, or Drag lock
 * Pointer handling uses native listeners and refs: no React state changes while a finger is moving.
 */
const SENTINEL = "\u200b";      // an invisible character kept in the typing field, so that Backspace always has something to delete

export default memo(function Touchpad() {
  const pad = useRef<HTMLDivElement>(null), dot = useRef<HTMLDivElement>(null), strip = useRef<HTMLDivElement>(null);
  const lockRef = useRef(false);
  const sensRef = useRef(+(store.get("pbs.sens", "1") || 1));
  const [locked, setLocked] = useState(false);
  // The phone's keyboard, opened by itself when you tap a text box on the PC; what you type goes there key by key.
  const live = useRef<HTMLInputElement>(null);
  const [autoKb, setAutoKb] = useState(() => store.get("pbs.autokb", "1") !== "0");
  const autoRef = useRef(autoKb);
  const [typing, setTyping] = useState(false);
  const pcText = useStore(phone, (s) => s.pcText);
  useEffect(() => { autoRef.current = autoKb; send({ t: "kbd_watch", on: autoKb }); return () => send({ t: "kbd_watch", on: false }); }, [autoKb]);
  useEffect(() => {
    const el = live.current;
    if (!el || !autoRef.current || pcText.focus == null) return;
    if (pcText.focus && document.activeElement !== el) el.focus({ preventScroll: true });      // Android opens here; an iPhone already did in the tap
    else if (!pcText.focus && document.activeElement === el && el.dataset.auto === "1") el.blur();   // the click landed on something that isn't a text box
  }, [pcText.n]);   // eslint-disable-line react-hooks/exhaustive-deps
  // An iPhone can put the cursor in a field and still keep its keyboard down, when the focus did not come from
  // a touch. So the bar says what is true: "Typing" once the keyboard is up, "Tap here to type" until then,
  // and the whole bar is the field, so that one tap on it always brings the keyboard.
  const [kbUp, setKbUp] = useState(false);
  const [waited, setWaited] = useState(false);
  const [doneAt, setDoneAt] = useState(-1);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const fit = () => setKbUp(vv.height < window.innerHeight - 120);
    fit(); vv.addEventListener("resize", fit);
    return () => vv.removeEventListener("resize", fit);
  }, []);
  useEffect(() => { setWaited(false); if (!typing) return; const t = setTimeout(() => setWaited(true), 700); return () => clearTimeout(t); }, [typing]);
  const touch = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  const wanted = autoKb && pcText.focus === true && doneAt !== pcText.n;        // the PC is on a text box
  const needTap = wanted && (!typing || (touch && waited && !kbUp));
  const openKeyboard = (auto: boolean) => { const el = live.current; if (!el) return; el.dataset.auto = auto ? "1" : "0"; el.value = SENTINEL; el.focus({ preventScroll: true }); };
  const [sens, setSens] = useState(sensRef.current);
  const canView = useStore(phone, (s) => !!s.cfg.perms.screen);
  const [view, setViewState] = useState<View>(() => (store.get("pbs.view", "off") as View));
  const [zoom, setZoomState] = useState(() => store.get("pbs.zoom", "3")!);
  const setView = (v: View) => { store.set("pbs.view", v); setViewState(v); };
  const setZoom = (z: string) => { store.set("pbs.zoom", z); setZoomState(z); };
  const img = useRef<HTMLImageElement>(null), box = useRef<HTMLDivElement>(null), cur = useRef<HTMLDivElement>(null);

  // Screen view: the PC's picture inside the pad, with the real cursor drawn on it.
  useEffect(() => {
    if (view === "off" || !canView) { send({ t: "screen", mode: null }); screenLink(false); return; }
    let url = "";
    screenView.onFrame = (jpeg, cx, cy, done) => {
      const next = URL.createObjectURL(jpeg), old = url;
      url = next;
      const im = img.current; if (!im) { done(); return; }
      im.onerror = done;
      im.onload = () => {
        done();                                   // drawn: the PC may send the next picture
        if (old) URL.revokeObjectURL(old);
        const p = pad.current, b = box.current; if (!p || !b) return;
        const ar = im.naturalWidth / im.naturalHeight, pw = p.clientWidth, ph = p.clientHeight;
        const w = Math.min(pw, ph * ar);
        b.style.width = w + "px"; b.style.height = w / ar + "px";
      };
      im.src = next;
      const c = cur.current;
      if (c) { c.style.display = cx < 0 ? "none" : "block"; c.style.left = cx * 100 + "%"; c.style.top = cy * 100 + "%"; }
    };
    screenLink(true);
    send({ t: "screen", mode: view, zoom: +zoom });
    return () => { screenView.onFrame = null; send({ t: "screen", mode: null }); screenLink(false); if (url) URL.revokeObjectURL(url); };
  }, [view, canView, zoom]);

  useEffect(() => {
    const el = pad.current!, d = dot.current!, st = strip.current!;
    const pts = new Map<number, { x: number; y: number }>();
    let acc = { dx: 0, dy: 0, sy: 0, sx: 0 };
    let maxPts = 0, downAt = 0, startX = 0, startY = 0, travelled = 0, twoMoved = 0, lastTapUp = 0;
    let holdTimer: ReturnType<typeof setTimeout> | undefined, dragging = false, running = false, stripActive = false, stripY = 0;
    // A 4K screen has twice the pixels of 1080p to cross: scale pointer speed to the PC's real resolution.
    const scale = () => Math.max(1, (phone.get().cfg.screen?.[0] || 1920) / 1920) * sensRef.current;

    const flush = () => {
      const mx = Math.trunc(acc.dx), my = Math.trunc(acc.dy);
      if (mx || my) { input({ kind: "move", dx: mx, dy: my }); acc.dx -= mx; acc.dy -= my; }   // keep sub-pixel remainders for slow, precise moves
      if (Math.abs(acc.sy) >= 12 || Math.abs(acc.sx) >= 12) { input({ kind: "scroll", dy: Math.round(acc.sy), dx: Math.round(acc.sx) }); acc.sy = 0; acc.sx = 0; }
      if (pts.size || stripActive) requestAnimationFrame(flush); else running = false;
    };
    const kick = () => { if (!running) { running = true; requestAnimationFrame(flush); } };
    const setDrag = (on: boolean) => {
      if (dragging === on) return;
      dragging = on; el.classList.toggle("dragging", on || lockRef.current);
      input({ kind: "button", button: "left", down: on });
      vibrate(on ? 20 : 8);
    };
    const place = (e: PointerEvent) => { const r = el.getBoundingClientRect(); d.style.left = e.clientX - r.left + "px"; d.style.top = e.clientY - r.top + "px"; };

    const down = (e: PointerEvent) => {
      if (e.target === st || st.contains(e.target as Node)) return;
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 1) {
        downAt = performance.now(); startX = e.clientX; startY = e.clientY; travelled = 0; maxPts = 1; twoMoved = 0;
        kick();
        if (!lockRef.current) {
          if (downAt - lastTapUp < 320) setDrag(true);   // tap, then touch again and hold = drag
          else holdTimer = setTimeout(() => { if (travelled < 14 && pts.size === 1 && maxPts === 1) setDrag(true); }, 420);
        }
      } else clearTimeout(holdTimer);
      maxPts = Math.max(maxPts, pts.size);
      d.style.display = "block"; place(e);
    };
    const move = (e: PointerEvent) => {
      const p = pts.get(e.pointerId); if (!p) return;
      const evs = e.getCoalescedEvents?.().length ? e.getCoalescedEvents() : [e];   // every sample of a 120 Hz screen
      for (const ev of evs) {
        const dx = ev.clientX - p.x, dy = ev.clientY - p.y;
        p.x = ev.clientX; p.y = ev.clientY;
        if (maxPts >= 2) {
          // Once a second finger has touched, this gesture is a scroll until every finger lifts:
          // the pointer must not jump when one finger leaves before the other.
          if (pts.size >= 2) {
            twoMoved += Math.abs(dx) + Math.abs(dy);
            acc.sy += (dy * 3.2 / pts.size) * sensRef.current; acc.sx += (-dx * 3.2 / pts.size) * sensRef.current;
          }
        } else {
          const speed = Math.hypot(dx, dy), gain = (0.9 + Math.min(speed, 30) * 0.11) * scale();   // slow = precise, fast = far
          acc.dx += dx * gain; acc.dy += dy * gain;
        }
      }
      travelled = Math.max(travelled, Math.hypot(e.clientX - startX, e.clientY - startY));   // distance from where the finger landed: jitter doesn't count
      if (travelled > 14) clearTimeout(holdTimer);
      place(e);
    };
    const up = (e: PointerEvent) => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      if (pts.size) return;
      clearTimeout(holdTimer); d.style.display = "none";
      if (lockRef.current) return;   // while drag lock holds the button, a tap must not click (that would release it)
      const now = performance.now(), quick = now - downAt < 260 && travelled < 14;
      if (dragging && !lockRef.current) {
        setDrag(false);
        if (quick) { input({ kind: "click", button: "left" }); lastTapUp = 0; }   // tap-tap without moving = double click
        return;
      }
      if (quick && e.type !== "pointercancel") {
        if (maxPts >= 2) { if (twoMoved < 30) input({ kind: "click", button: "right" }); lastTapUp = 0; }
        else {
          input({ kind: "click", button: "left" }); lastTapUp = now; tapAt = now;
          // still inside the tap: the only moment an iPhone lets a page bring its keyboard up
          if (autoRef.current && phone.get().pcText.over) openKeyboard(true);
        }
        vibrate(6);
      }
    };
    const block = (e: Event) => e.preventDefault();
    // Older iPhones only count the touch itself (not the pointer event made from it) as "the user asked for this".
    let tapAt = 0;
    const touchEnd = () => { if (performance.now() - tapAt < 120 && autoRef.current && phone.get().pcText.over && document.activeElement !== live.current) openKeyboard(true); };
    el.addEventListener("touchend", touchEnd);
    el.addEventListener("pointerdown", down); el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up);
    for (const ev of ["gesturestart", "gesturechange", "contextmenu", "touchmove"]) el.addEventListener(ev, block, { passive: false });

    const sDown = (e: PointerEvent) => { e.preventDefault(); e.stopPropagation(); try { st.setPointerCapture(e.pointerId); } catch { /* synthetic */ } stripActive = true; stripY = e.clientY; kick(); };
    const sMove = (e: PointerEvent) => { if (!stripActive) return; acc.sy += (e.clientY - stripY) * 4 * sensRef.current; stripY = e.clientY; };
    const sUp = () => { stripActive = false; };
    st.addEventListener("pointerdown", sDown); st.addEventListener("pointermove", sMove); st.addEventListener("pointerup", sUp); st.addEventListener("pointercancel", sUp);

    return () => {
      clearTimeout(holdTimer);
      if (dragging || lockRef.current) input({ kind: "button", button: "left", down: false });   // never leave the PC's button held
      el.removeEventListener("pointerdown", down); el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up); el.removeEventListener("pointercancel", up);
      for (const ev of ["gesturestart", "gesturechange", "contextmenu", "touchmove"]) el.removeEventListener(ev, block);
      st.removeEventListener("pointerdown", sDown); st.removeEventListener("pointermove", sMove); st.removeEventListener("pointerup", sUp); st.removeEventListener("pointercancel", sUp);
    };
  }, []);

  const toggleLock = () => {
    const on = !lockRef.current;
    lockRef.current = on; setLocked(on);
    pad.current?.classList.toggle("dragging", on);
    input({ kind: "button", button: "left", down: on });
    vibrate(on ? 25 : 10);
  };
  // Press-and-hold really holds the mouse button, so one finger can hold while another moves the pointer.
  const holdProps = (button: string) => ({
    onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => { e.preventDefault(); try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ } e.currentTarget.classList.add("down"); input({ kind: "button", button, down: true }); vibrate(8); },
    onPointerUp: (e: React.PointerEvent<HTMLButtonElement>) => { if (e.currentTarget.classList.contains("down")) { e.currentTarget.classList.remove("down"); input({ kind: "button", button, down: false }); } },
    onPointerCancel: (e: React.PointerEvent<HTMLButtonElement>) => { if (e.currentTarget.classList.contains("down")) { e.currentTarget.classList.remove("down"); input({ kind: "button", button, down: false }); } },
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  });

  return (
    <div className="col" style={{ gap: 12 }}>
      <div className={cx("pad", locked && "dragging", view !== "off" && canView && "viewing")} ref={pad}>
        {view !== "off" && canView
          ? <div className="screenwrap"><div className="screenbox" ref={box}><img ref={img} alt="" draggable={false} /><div className="pccursor" ref={cur} /></div></div>
          : <div className="lbl">Tap = click · tap-then-hold or long-press = drag · 2 fingers = scroll / right-click</div>}
        <div className="dotp" ref={dot} /><div className="strip" ref={strip}><span>scroll</span></div>
      </div>
      <div className={cx("livekb", (typing || wanted) && "on", needTap && "ask")}>
        <Icon name="keyboard" />
        <input ref={live} defaultValue={SENTINEL} aria-label="Type on the PC" autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} enterKeyHint="enter"
          onFocus={(e) => { e.currentTarget.value = SENTINEL; setTyping(true); }} onBlur={() => setTyping(false)}
          onKeyDown={(e) => {
            const k = e.key;
            if (k === "Enter") { e.preventDefault(); input({ kind: "key", keys: ["enter"] }); }
            else if (k === "Tab") { e.preventDefault(); input({ kind: "key", keys: e.shiftKey ? ["shift", "tab"] : ["tab"] }); }
            else if (k === "Escape") { input({ kind: "key", keys: ["esc"] }); e.currentTarget.blur(); }
            else if (/^Arrow/.test(k)) { e.preventDefault(); input({ kind: "key", keys: [k.slice(5).toLowerCase()] }); }
          }}
          onInput={(e) => {
            // The field always holds one invisible character. Shorter than that: Backspace was pressed.
            // Longer: what was added is what was typed (one letter, or a whole swiped or dictated word).
            const el = e.currentTarget, v = el.value;
            if (!v.startsWith(SENTINEL)) input({ kind: "key", keys: ["backspace"] });
            else if (v.length > SENTINEL.length) input({ kind: "text", text: v.slice(SENTINEL.length) });
            el.value = SENTINEL;
          }} />
        <span className="lk-say">{needTap ? "Tap here to type on the PC" : "Typing on the PC"}</span>
        <button className="btn sm" onPointerDown={(e) => e.preventDefault()} onClick={() => { setDoneAt(pcText.n); live.current?.blur(); }}>{typing ? "Done" : "Hide"}</button>
      </div>
      {view === "zoom" && canView && (
        <div className="zoombar"><span className="muted">Magnifier</span>
          {ZOOMS.map((z) => <button key={z.v} className={zoom === z.v ? "on" : ""} onClick={() => setZoom(z.v)}>{z.label}</button>)}
          <button onClick={() => setView("off")}><Icon name="x" /></button></div>
      )}
      <details className="fold bare">
        <summary><span className="ft">Pad options</span><span className="fv">{sens.toFixed(1)}× speed{canView ? ` · ${view === "off" ? "screen off" : view === "zoom" ? `magnifier ${zoom}×` : "screen on"}` : ""}</span><Icon name="chevron" className="chev" /></summary>
        <div className="fold-body col" style={{ gap: 10 }}>
          <div className="field-row"><span className="muted">Pointer speed</span>
        <Range value={sens} min={0.4} max={3} step={0.1} onChange={(v) => { sensRef.current = v; setSens(v); store.set("pbs.sens", String(v)); }} />
        <b className="tnum">{sens.toFixed(1)}×</b></div>
          <div className="field-row" style={{ gridTemplateColumns: "1fr auto" }}><span className="muted">Open the keyboard when I tap a text box on the PC</span>
            <Switch checked={autoKb} onChange={(v) => { setAutoKb(v); store.set("pbs.autokb", v ? "1" : "0"); }} /></div>
          <div className="field-row" style={{ gridTemplateColumns: "1fr auto" }}><span className="muted">Keyboard now</span>
            <button className="btn sm" onClick={() => openKeyboard(false)}><Icon name="keyboard" />Open</button></div>
          {canView && <div className="field-row" style={{ gridTemplateColumns: "auto 1fr" }}><span className="muted">Screen view</span>
            <Seg value={view} options={VIEWS} onChange={setView} style={{ justifySelf: "end" }} /></div>}
          {canView && view === "zoom" && <div className="field-row" style={{ gridTemplateColumns: "auto 1fr" }}><span className="muted">Magnify</span>
            <Seg value={zoom as any} options={ZOOMS} onChange={setZoom} style={{ justifySelf: "end" }} /></div>}
        </div>
      </details>
      <div className="tiles">
        <button className="tile hold" {...holdProps("left")}>Left<small>hold to drag</small></button>
        <button className={cx("tile", locked && "on")} onClick={toggleLock}>Drag lock<small>{locked ? "Holding: tap to release" : "Off"}</small></button>
        <button className="tile hold" {...holdProps("right")}>Right<small>click</small></button>
      </div>

      <Keys />
    </div>
  );
});
