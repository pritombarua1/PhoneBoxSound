import { useEffect, useRef, useState, type RefObject } from "react";
import { Icon } from "./icons";
import { Seg } from "./ui";
import { cx, fmtTime, toast } from "./util";

export interface SearchRow { id: string; service: string; label: string; title: string; sub: string; dur: number; thumb: string | null }
export interface SearchAnswer { can_queue?: boolean; q: string; results: SearchRow[]; links: { id: string; service: string; label: string }[]; errors: Record<string, string> }
export interface SearchApi { queue?: (id: string) => Promise<{ error: string | null }>; ask: (q: string, service: string) => Promise<SearchAnswer>; suggest: (q: string) => Promise<string[]>; open: (id: string) => void }

const SERVICES = [{ v: "all", label: "All" }, { v: "youtube", label: "YouTube" }, { v: "spotify", label: "Spotify" }, { v: "apple", label: "Apple Music" }] as const;
const NAMES: Record<string, string> = { youtube: "YouTube", spotify: "Spotify", apple: "Apple Music" };

/** Type once, see what each service has, tap to play it on the PC. Used by the phone app and the dashboard. */
export function SearchBox({ api, autoFocus, inputRef, onClose }: { api: SearchApi; autoFocus?: boolean; inputRef?: RefObject<HTMLInputElement | null>; onClose?: () => void }) {
  const [q, setQ] = useState(""), [service, setService] = useState("all");
  const [hints, setHints] = useState<string[]>([]), [ans, setAns] = useState<SearchAnswer | null>(null), [busy, setBusy] = useState(false);
  const turn = useRef(0);

  const run = (words: string, svc = service) => {
    const w = words.trim();
    if (w.length < 2) { setAns(null); return; }
    const mine = ++turn.current;
    setBusy(true); setHints([]);
    api.ask(w, svc).then((a) => { if (turn.current === mine) setAns(a); }).catch(() => { if (turn.current === mine) toast("The search didn't answer. Is the PC online?"); })
      .finally(() => { if (turn.current === mine) setBusy(false); });
  };

  // while typing: suggestions quickly, results after a short pause
  useEffect(() => {
    const w = q.trim();
    if (w.length < 2) { setHints([]); setAns(null); return; }
    if (ans?.q === w) return;
    const a = setTimeout(() => api.suggest(w).then((l) => { if (q.trim() === w && ans?.q !== w) setHints(l.filter((x) => x.toLowerCase() !== w.toLowerCase())); }).catch(() => {}), 220);
    const b = setTimeout(() => run(w), 750);
    return () => { clearTimeout(a); clearTimeout(b); };
  }, [q]);   // eslint-disable-line react-hooks/exhaustive-deps

  const clear = () => { turn.current++; setQ(""); setAns(null); setHints([]); setBusy(false); };
  const play = (r: SearchRow) => { api.open(r.id); toast(`Playing on the PC: ${r.title}`); };
  return (
    <div className="srch">
      <form className="srch-bar" onSubmit={(e) => { e.preventDefault(); (document.activeElement as HTMLElement | null)?.blur(); run(q); }}>
        {onClose ? <button type="button" className="iconbtn srch-back" aria-label="Close search" onClick={onClose}><Icon name="chevron" /></button> : <Icon name="search" />}
        <input ref={inputRef} className="input" type="text" enterKeyHint="search" onKeyDown={(e) => e.key === "Escape" && (q || ans) && (e.stopPropagation(), clear())} autoFocus={autoFocus} maxLength={120} placeholder="Search songs, videos, artists…" value={q} onChange={(e) => setQ(e.target.value)} />
        {busy && <span className="srch-spin" aria-label="Searching" />}
        {!busy && (q || ans) && <button type="button" className="iconbtn srch-clear" aria-label="Clear the search" title="Clear" onClick={clear}><Icon name="x" /></button>}
      </form>
      <Seg className="srch-svc" value={service as any} options={SERVICES} onChange={(v) => { setService(v); run(q, v); }} />
      {hints.length > 0 && !busy && (
        <div className="srch-hints">{hints.map((h) => <button key={h} className="srch-hint" onClick={() => { setQ(h); run(h); }}><Icon name="search" />{h}</button>)}</div>
      )}
      {ans && <>
        {Object.entries(ans.errors).map(([s, why]) => <div key={s} className="note srch-note"><b>{NAMES[s] || s}:</b> {why}.</div>)}
        <div className="srch-list">
          {ans.results.map((r, i) => (
            <button key={r.id} className={cx("srch-row", r.service)} style={{ animationDelay: Math.min(i, 10) * 28 + "ms" }} onClick={() => play(r)}>
              <span className={cx("srch-pic", r.service !== "youtube" && "sq")}>{r.thumb ? <img src={r.thumb} alt="" loading="lazy" /> : <Icon name="music" />}{r.dur > 0 && <i>{fmtTime(r.dur)}</i>}</span>
              <span className="srch-txt"><b>{r.title}</b><span>{r.sub}</span><em className={r.service}>{r.label}</em></span>
              {r.service === "spotify" && ans.can_queue && api.queue
                ? <span className="btn sm q-add" role="button" title="Add to Spotify's queue" onClick={(e) => { e.stopPropagation(); api.queue!(r.id).then((x) => toast(x.error || `Plays next: ${r.title}`, x.error ? 4500 : 2200)).catch(() => toast("The PC didn't answer")); }}>Play next</span>
                : <Icon name="play" />}
            </button>
          ))}
          {!ans.results.length && !busy && <div className="muted" style={{ padding: 12 }}>Nothing found for "{ans.q}" here. Try the services' own search below.</div>}
        </div>
        <div className="srch-links"><span className="muted">Search "{ans.q}" on the PC in</span>
          {ans.links.map((l) => <button key={l.id} className="btn sm" onClick={() => { api.open(l.id); toast(`Opening ${l.label} on the PC`); }}>{l.label}</button>)}</div>
      </>}
      {!ans && !hints.length && <p className="note" style={{ textAlign: "center" }}>Results come from YouTube, Apple Music and Spotify, with their pictures. Tap one and it opens and plays on the PC. Netflix, Prime Video and Disney+ don't share their results, so for those you get a button that opens their own search on the PC.</p>}
    </div>
  );
}
