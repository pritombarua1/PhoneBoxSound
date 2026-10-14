import { memo, useRef, useState } from "react";
import { Icon } from "../lib/icons";
import { Seg, useDraft } from "../lib/ui";
import { cx, store, toast, vibrate } from "../lib/util";
import { input } from "./engine";

const MODS = [["ctrl", "Ctrl"], ["shift", "Shift"], ["alt", "Alt"], ["win", "Win"]] as const;
const BASIC: [string, string][] = [
  ["esc", "Esc"], ["tab", "Tab"], ["up", "↑"], ["backspace", "⌫"], ["delete", "Del"],
  ["space", "Space"], ["left", "←"], ["down", "↓"], ["right", "→"], ["enter", "Enter"],
  ["home", "Home"], ["end", "End"], ["pageup", "PgUp"], ["pagedown", "PgDn"], ["insert", "Ins"],
];
const FKEYS = Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, `F${i + 1}`] as [string, string]);
const GROUPS: [string, [string, string][]][] = [
  ["Edit", [["Save", "ctrl+s"], ["Save as", "ctrl+shift+s"], ["Undo", "ctrl+z"], ["Redo", "ctrl+y"], ["Cut", "ctrl+x"], ["Copy", "ctrl+c"], ["Paste", "ctrl+v"],
    ["Select all", "ctrl+a"], ["Find", "ctrl+f"], ["New", "ctrl+n"], ["Open", "ctrl+o"], ["Print", "ctrl+p"]]],
  ["Browser", [["New tab", "ctrl+t"], ["Close tab", "ctrl+w"], ["Reopen tab", "ctrl+shift+t"], ["Next tab", "ctrl+tab"], ["Prev tab", "ctrl+shift+tab"], ["Refresh", "f5"],
    ["Address bar", "ctrl+l"], ["Back", "alt+left"], ["Forward", "alt+right"], ["Zoom in", "ctrl+="], ["Zoom out", "ctrl+-"], ["Zoom reset", "ctrl+0"]]],
  ["Windows", [["Alt-Tab", "alt+tab"], ["Task view", "win+tab"], ["Desktop", "win+d"], ["Close window", "alt+f4"], ["Snap left", "win+left"], ["Snap right", "win+right"],
    ["Maximise", "win+up"], ["Minimise", "win+down"], ["Screenshot", "win+shift+s"], ["Explorer", "win+e"], ["Task Manager", "ctrl+shift+esc"], ["Run", "win+r"],
    ["Settings", "win+i"], ["Emoji", "win+."], ["Start", "win"]]],
  ["Presentation", [["Next slide", "right"], ["Previous", "left"], ["Start show", "f5"], ["From here", "shift+f5"], ["Black screen", "b"], ["End show", "esc"]]],
  ["See better", [["Magnifier +", "win+="], ["Magnifier −", "win+-"], ["Magnifier off", "win+esc"], ["Text bigger", "ctrl+="], ["Text smaller", "ctrl+-"], ["Text reset", "ctrl+0"]]],
];
const TABS = [{ v: "keys", label: "Keys" }, { v: "shortcuts", label: "Shortcuts" }, { v: "mine", label: "My shortcuts" }] as const;

type Custom = { label: string; keys: string };
const loadCustom = (): Custom[] => { try { return JSON.parse(store.get("pbs.shortcuts") || "[]"); } catch { return []; } };
const pretty = (combo: string) => combo.split("+").map((k) => (k.length === 1 ? k.toUpperCase() : k[0].toUpperCase() + k.slice(1))).join(" + ");
/** "Ctrl + Shift+K", "ctrl shift k" → "ctrl+shift+k" */
const parse = (s: string) => s.toLowerCase().replace(/control/g, "ctrl").replace(/windows|cmd|super/g, "win").replace(/escape/g, "esc")
  .split(/[\s+]+/).filter(Boolean).join("+");

/**
 * Keyboard for the PC. Latch any of Ctrl / Shift / Alt / Win, then press a key (or type a character)
 * to send them together: Ctrl+S, Ctrl+Shift+Esc, Win+Shift+S… Plus ready-made and personal shortcuts.
 */
export default memo(function Keys() {
  const [tab, setTab] = useState<"keys" | "shortcuts" | "mine">("keys");
  const [mods, setModsState] = useState<string[]>([]);
  // The ref is the source of truth: two quick taps (Alt, then F4) must not race a re-render.
  const modsRef = useRef<string[]>([]);
  const setMods = (next: string[]) => { modsRef.current = next; setModsState(next); };
  const [text, setText] = useDraft("type");
  const [custom, setCustom] = useState<Custom[]>(loadCustom);
  const [label, setLabel] = useState("");
  const [combo, setCombo] = useState("");

  const sendKeys = (keys: string[]) => { input({ kind: "key", keys }); vibrate(6); };
  const combo_ = (c: string) => sendKeys(c.split("+").map((k) => k || "+"));
  /** A key press: includes whatever modifiers are latched, then lets them go. */
  const key = (k: string) => {
    const held = modsRef.current;
    sendKeys([...held, k]);
    if (held.length) { toast(pretty([...held, k].join("+")), 900); setMods([]); }
  };
  const toggleMod = (m: string) => { const cur = modsRef.current; setMods(cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m]); vibrate(6); };
  const onType = (v: string) => {
    if (modsRef.current.length && v) { key(v.slice(-1).toLowerCase()); setText(""); }   // with a modifier held, a typed character is a shortcut
    else setText(v);
  };
  const field = useRef<HTMLTextAreaElement>(null);
  // Send must not close the phone keyboard: the button never takes focus, and the box is re-focused.
  const sendText = () => { if (text) { input({ kind: "text", text }); setText(""); vibrate(6); } field.current?.focus(); };
  const keepFocus = { onPointerDown: (e: React.PointerEvent) => e.preventDefault(), onMouseDown: (e: React.MouseEvent) => e.preventDefault() };
  const save = (list: Custom[]) => { setCustom(list); store.set("pbs.shortcuts", JSON.stringify(list)); };
  const add = () => {
    const keys = parse(combo);
    if (!keys) return toast("Type a combination, like ctrl+shift+k");
    save([...custom, { label: label.trim() || pretty(keys), keys }]); setLabel(""); setCombo("");
  };

  return (
    <div className="col" style={{ gap: 10 }}>
      <Seg value={tab} options={TABS} onChange={setTab} style={{ alignSelf: "center" }} />

      {tab === "keys" && <>
        <div className="keys mods">
          {MODS.map(([m, l]) => <button key={m} className={cx(mods.includes(m) && "on")} onClick={() => toggleMod(m)}>{l}</button>)}
        </div>
        <div className="muted" style={{ fontSize: 12.5, textAlign: "center", minHeight: 18 }}>
          {mods.length ? <>Holding <b style={{ color: "var(--accent)" }}>{pretty(mods.join("+"))}</b>: now press a key or type a letter</> : "Tap Ctrl, Shift, Alt or Win to hold it for the next key"}
        </div>
        <div className="keys">{BASIC.map(([k, l]) => <button key={k} onClick={() => key(k)}>{l}</button>)}</div>
        <div className="keys fn">{FKEYS.map(([k, l]) => <button key={k} onClick={() => key(k)}>{l}</button>)}</div>
        <div className="row">
          <textarea ref={field} className="input typebox" rows={Math.min(5, text.split("\n").length)} placeholder={mods.length ? `Type a letter for ${pretty(mods.join("+"))} + …` : "Type on the PC…"} autoComplete="off" autoCapitalize="off" autoCorrect="off"
            enterKeyHint="enter" value={text} onChange={(e) => onType(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              if (modsRef.current.length) { e.preventDefault(); key("enter"); }
              else if (e.shiftKey) { e.preventDefault(); sendText(); }      // plain Enter is left alone: it starts a new line
            }} />
          <button className="btn icon-only" title="Enter" {...keepFocus} onClick={() => { key("enter"); field.current?.focus(); }}>⏎</button>
          <button className="btn accent" {...keepFocus} onClick={sendText}>Send</button>
        </div>
        <div className="muted" style={{ textAlign: "center", fontSize: 12 }}>Enter = new line · Send (or Shift+Enter) types it on the PC · ⏎ presses Enter on the PC</div>
      </>}

      {tab === "shortcuts" && GROUPS.map(([name, items]) => (
        <div key={name}>
          <div className="label" style={{ margin: "4px 0 6px" }}>{name}</div>
          <div className="keys short">{items.map(([l, c]) => <button key={c} title={pretty(c)} onClick={() => combo_(c)}>{l}<small>{pretty(c)}</small></button>)}</div>
        </div>
      ))}

      {tab === "mine" && <>
        {!custom.length && <div className="muted" style={{ fontSize: 13.5, textAlign: "center" }}>Save the combinations you use most: OBS hotkeys, editor commands, game binds…</div>}
        <div className="keys short">
          {custom.map((c, i) => (
            <button key={i} onClick={() => combo_(c.keys)}>{c.label}<small>{pretty(c.keys)}</small>
              <span className="del" onClick={(e) => { e.stopPropagation(); save(custom.filter((_, j) => j !== i)); }}><Icon name="x" /></span></button>
          ))}
        </div>
        <div className="card" style={{ padding: 14 }}>
          <div className="row"><input className="input" placeholder="Name (e.g. Start recording)" value={label} onChange={(e) => setLabel(e.target.value)} /></div>
          <div className="row" style={{ marginTop: 8 }}>
            <input className="input mono" placeholder="ctrl+shift+r" autoCapitalize="off" autoCorrect="off" value={combo} onChange={(e) => setCombo(e.target.value)} />
            <button className="btn accent" onClick={add}><Icon name="plus" />Add</button>
          </div>
          <div className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>Join keys with +. Modifiers: ctrl, shift, alt, win. Keys: letters, digits, f1–f12, enter, esc, tab, space, arrows (left, up…), home, end, delete…</div>
        </div>
      </>}
    </div>
  );
});
