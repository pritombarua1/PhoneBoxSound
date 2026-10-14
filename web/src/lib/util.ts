export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function fmtTime(s: number) {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const mm = String(m).padStart(h ? 2 : 1, "0"), ss = String(sec).padStart(2, "0");
  return h ? `${String(h).padStart(2, "0")}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function fmtAgo(sec: number) {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)} min`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} h`;
  return `${Math.floor(sec / 86400)} d`;
}

export const fmtRate = (r: number) => (r || 1).toFixed(2).replace(/\.?0+$/, "") + "×";

/** localStorage that never throws (private mode, blocked storage). */
export const store = {
  get(k: string, d: string | null = null) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  del(k: string) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

/** Tiny imperative toast: no React state, so high-frequency callers never re-render the tree. */
export function toast(msg: string, ms = 2200) {
  let wrap = document.querySelector(".toast-wrap");
  if (!wrap) { wrap = document.createElement("div"); wrap.className = "toast-wrap"; document.body.appendChild(wrap); }
  const t = document.createElement("div");
  t.className = "toast"; t.textContent = msg;
  wrap.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

/**
 * The PC re-reads the playback position about once a second, and each reading is a little early or late
 * (players only publish their position now and then). Re-anchoring the timeline on every reading made it
 * twitch forwards and backwards. While it is clearly the same playback, keep the clock we already run
 * and only jump when the reading really differs (a seek, another track, pause).
 * Returns the time to count from; may put the steadier position into `next`.
 */
export function steadyMedia(prev: { active: any } | null, prevAt: number, next: { active: any }) {
  const a = prev?.active, b = next.active, now = performance.now();
  if (a && b && a.id === b.id && a.title === b.title && a.status === "playing" && b.status === "playing" && (a.rate || 1) === (b.rate || 1)) {
    const expected = a.position + ((now - prevAt) / 1000) * (a.rate || 1);
    if (Math.abs(b.position - expected) < 1.5) { b.position = a.position; return prevAt; }
  }
  return now;
}

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");
export const vibrate = (p: number | number[]) => { try { navigator.vibrate?.(p); } catch { /* ignore */ } };
export const wsUrl = (path: string) => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${path}`;
export const accent = () => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();

/**
 * Copy text to the clipboard. The modern API only exists on secure pages (https or localhost), so on a
 * plain http address fall back to the classic selection-based copy.
 */
export async function copyText(text: string) {
  try {
    if (window.isSecureContext && navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through */ }
  const ta = document.createElement("textarea");
  ta.value = text; ta.setAttribute("readonly", ""); ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
  document.body.appendChild(ta); ta.focus(); ta.select(); ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { /* unsupported */ }
  ta.remove();
  return ok;
}
