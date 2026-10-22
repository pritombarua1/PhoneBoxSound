import { memo, useEffect, useRef, useState } from "react";
import { Icon } from "../lib/icons";
import { useStore } from "../lib/store";
import { Seg } from "../lib/ui";
import { cx, toast } from "../lib/util";
import { phone, soundHealth } from "./engine";

/*
 * Files & media, both ways, untouched.
 *
 * To the PC: any number of photos, videos and files. Each goes up in 2 MB pieces at the offset the PC
 * confirms, so a dropped Wi-Fi or a phone going to sleep resumes instead of starting over. Two files at a
 * time. When the sound arrives with too little time to spare, the next piece waits a moment: the music
 * always comes first.
 *
 * From the PC: browse the shared folder (and folders in it) with pictures of photos and videos, pick
 * several, and download them with progress. On an iPhone they can then go to Photos or Files in one go.
 */

interface Entry { name: string; path: string; size: number; mtime: number; kind: "image" | "video" | "audio" | "file" }
interface Folder { name: string; path: string }
interface Listing { path: string; dirs: Folder[]; files: Entry[]; more: number }
type Dir = "up" | "down";
interface Job {
  key: string; dir: Dir; name: string; size: number; done: number; speed: number; started: number;
  state: "waiting" | "going" | "yielding" | "done" | "failed" | "cancelled"; error?: string;
  file?: File; path?: string; blob?: Blob; preview?: string;
}

const CHUNK = 2 * 1024 * 1024;
const IN_MEMORY = 600 * 1024 * 1024;          // bigger downloads go straight to the browser's own downloads
const fmt = (n: number) => (n >= 1e9 ? (n / 1e9).toFixed(2) + " GB" : n >= 1e6 ? (n / 1e6).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1e3)) + " KB");
const eta = (s: number) => (!isFinite(s) || s <= 0 ? "" : s < 60 ? `${Math.ceil(s)} s left` : s < 3600 ? `${Math.ceil(s / 60)} min left` : `${(s / 3600).toFixed(1)} h left`);
const kindOf = (name: string, type = ""): Entry["kind"] => (type.startsWith("image/") || /\.(jpe?g|png|gif|webp|heic|heif|avif|bmp|tiff?|dng)$/i.test(name) ? "image"
  : type.startsWith("video/") || /\.(mp4|mov|m4v|mkv|webm|avi|3gp)$/i.test(name) ? "video" : type.startsWith("audio/") ? "audio" : "file");
const iconFor = (k: Entry["kind"]) => (k === "image" ? "star" : k === "video" ? "film" : k === "audio" ? "music" : "download");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default memo(function Transfer({ token }: { token: string }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const jobsRef = useRef<Job[]>([]);
  const [listing, setListing] = useState<Listing | null>(null);
  const [dir, setDir] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [tab, setTab] = useState<"send" | "get">("send");
  const incoming = useStore(phone, (s) => s.incoming);
  const pickMedia = useRef<HTMLInputElement>(null), pickAny = useRef<HTMLInputElement>(null);
  const running = useRef(0);
  const q = (path: string) => `${path}${path.includes("?") ? "&" : "?"}k=${encodeURIComponent(token)}`;

  // Progress is kept at once, but the list is redrawn at most four times a second: redrawing on every
  // progress event would keep the page busy at exactly the moment the music needs it.
  const redraw = useRef(0);
  const flush = () => { redraw.current = 0; setJobs(jobsRef.current); };
  const update = (key: string, change: Partial<Job>) => {
    jobsRef.current = jobsRef.current.map((j) => (j.key === key ? { ...j, ...change } : j));
    const quiet = Object.keys(change).every((k) => k === "done" || k === "speed");
    if (!quiet) { if (redraw.current) clearTimeout(redraw.current); flush(); }
    else if (!redraw.current) redraw.current = window.setTimeout(flush, 250);
  };
  (window as any).__pbsFileKey = token;   // for the tests
  (window as any).__pbsTransfers = () => jobsRef.current.map((j) => ({ name: j.name, dir: j.dir, state: j.state, size: j.size, done: j.done, error: j.error, blob: j.blob }));   // for the tests
  const cancelled = (key: string) => jobsRef.current.find((j) => j.key === key)?.state === "cancelled";

  const browse = (to = dir) => fetch(q(`/files/browse?dir=${encodeURIComponent(to)}`)).then((r) => r.json())
    .then((l) => { if (l.error) { toast(l.error); return; } setListing(l); setDir(l.path); setPicked([]); }).catch(() => setListing({ path: to, dirs: [], files: [], more: 0 }));
  useEffect(() => { if (tab === "get") browse(dir); }, [tab]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (incoming.length) setTab("get"); }, [incoming.length]);

  // keep the screen on while something is moving (a phone that sleeps pauses its Wi-Fi)
  const lock = useRef<any>(null);
  const busy = jobs.some((j) => j.state === "waiting" || j.state === "going" || j.state === "yielding");
  useEffect(() => {
    const nav = navigator as any;
    if (busy && !lock.current && nav.wakeLock) nav.wakeLock.request("screen").then((l: any) => { lock.current = l; }).catch(() => {});
    if (!busy && lock.current) { lock.current.release?.(); lock.current = null; }
  }, [busy]);

  // ------------------------------------------------------------------ to the PC
  const putPiece = (id: string, offset: number, blob: Blob, onSent: (n: number) => void) => new Promise<number>((ok, fail) => {
    const x = new XMLHttpRequest();
    x.open("PUT", q(`/files/chunk?id=${id}&offset=${offset}`));
    x.timeout = 120000;
    x.upload.onprogress = (e) => onSent(e.loaded);
    x.onload = () => { try { const r = JSON.parse(x.responseText); if (x.status === 200) ok(r.offset); else fail(new Error(r.error || `error ${x.status}`)); } catch { fail(new Error(`error ${x.status}`)); } };
    x.onerror = () => fail(new Error("network")); x.ontimeout = () => fail(new Error("timeout"));
    x.send(blob);
  });

  const upload = async (job: Job) => {
    const f = job.file!;
    update(job.key, { state: "going", started: Date.now() });
    const st = await fetch(q("/files/start"), { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: f.name, size: f.size, mtime: f.lastModified }) }).then((r) => r.json()).catch(() => ({ error: "The PC did not answer" }));
    if (st.error) { update(job.key, { state: "failed", error: st.error }); return; }
    let offset = 0, tries = 0, lastT = performance.now(), lastB = 0, speed = 0;
    while (offset < f.size) {
      if (cancelled(job.key)) { fetch(q(`/files/cancel?id=${st.id}`), { method: "POST" }).catch(() => {}); return; }
      if (performance.now() - soundHealth.tightAt < 800) { update(job.key, { state: "yielding" }); await sleep(400); continue; }
      update(job.key, { state: "going" });
      const end = Math.min(f.size, offset + CHUNK);
      try {
        offset = await putPiece(st.id, offset, f.slice(offset, end), (sent) => {
          const now = performance.now(), b = offset + sent;
          if (now - lastT > 400) { const inst = ((b - lastB) / (now - lastT)) * 1000; speed = speed ? 0.7 * speed + 0.3 * inst : inst; lastT = now; lastB = b; }
          update(job.key, { done: b, speed });
        });
        tries = 0;
        update(job.key, { done: offset });
      } catch (e: any) {
        // Wi-Fi dropped, the phone slept, the PC restarted its connection: ask where it got to, carry on
        if (++tries > 40) { update(job.key, { state: "failed", error: "The connection kept dropping" }); return; }
        await sleep(Math.min(5000, 500 * tries));
        const s = await fetch(q(`/files/status?id=${st.id}`)).then((r) => r.json()).catch(() => null);
        if (s?.error) { update(job.key, { state: "failed", error: s.error }); return; }
        if (s && typeof s.offset === "number") offset = s.offset;
        if (String(e?.message || "").length && !/network|timeout|error 5/.test(e.message) && s == null) { update(job.key, { state: "failed", error: e.message }); return; }
      }
    }
    const fin = await fetch(q(`/files/finish?id=${st.id}`), { method: "POST" }).then((r) => r.json()).catch(() => ({ error: "The PC did not answer" }));
    if (fin.error) update(job.key, { state: "failed", error: fin.error });
    else update(job.key, { state: "done", done: f.size, name: fin.name || f.name });
  };

  // ------------------------------------------------------------------ from the PC
  const download = async (job: Job) => {
    update(job.key, { state: "going", started: Date.now() });
    const url = q(`/files/download?path=${encodeURIComponent(job.path!)}`);
    if (job.size > IN_MEMORY) {         // too big to hold in the page: the browser's own download takes it
      const a = document.createElement("a"); a.href = url; a.download = job.name; document.body.appendChild(a); a.click(); a.remove();
      update(job.key, { state: "done", done: job.size, error: "Downloading in the browser (see its downloads)" });
      return;
    }
    let tries = 0;
    const parts: BlobPart[] = [];
    let got = 0, lastT = performance.now(), lastB = 0, speed = 0;
    while (got < job.size || job.size === 0) {
      if (cancelled(job.key)) return;
      try {
        const r = await fetch(url, got ? { headers: { Range: `bytes=${got}-` } } : {});
        if (!r.ok || !r.body) throw new Error(`error ${r.status}`);
        const reader = r.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          parts.push(value); got += value.byteLength;
          const now = performance.now();
          if (now - lastT > 400) { const inst = ((got - lastB) / (now - lastT)) * 1000; speed = speed ? 0.7 * speed + 0.3 * inst : inst; lastT = now; lastB = got; }
          update(job.key, { done: got, speed });
          if (cancelled(job.key)) { reader.cancel(); return; }
        }
        if (job.size === 0) break;
      } catch {
        if (++tries > 20) { update(job.key, { state: "failed", error: "The connection kept dropping" }); return; }
        await sleep(Math.min(5000, 500 * tries));      // and carry on from the byte it got to
      }
    }
    const blob = new Blob(parts, { type: job.blob?.type || "" });
    update(job.key, { state: "done", done: got, blob });
    const canShare = !!(navigator as any).canShare;
    if (!canShare) {                  // Android, computers: straight to the downloads
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = job.name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    }
  };

  // two at a time; the queue keeps going until everything waiting is done
  const pump = () => {
    while (running.current < 2) {
      const next = jobsRef.current.find((j) => j.state === "waiting");
      if (!next) return;
      running.current++;
      update(next.key, { state: "going" });
      (next.dir === "up" ? upload(next) : download(next)).finally(() => { running.current--; pump(); });
    }
  };

  const addUploads = (list: FileList) => {
    const add: Job[] = Array.from(list).map((f, i) => ({ key: `u${Date.now()}-${i}`, dir: "up", name: f.name, size: f.size, done: 0, speed: 0, started: 0, state: "waiting", file: f,
      preview: kindOf(f.name, f.type) === "image" && f.size < 30e6 ? URL.createObjectURL(f) : undefined }));
    jobsRef.current = [...jobsRef.current, ...add]; setJobs(jobsRef.current); pump();
  };
  const addDownloads = (entries: { name: string; path: string; size: number }[]) => {
    const add: Job[] = entries.map((e, i) => ({ key: `d${Date.now()}-${i}`, dir: "down", name: e.name, size: e.size, done: 0, speed: 0, started: 0, state: "waiting", path: e.path,
      preview: ["image", "video"].includes(kindOf(e.name)) ? q(`/files/thumb?path=${encodeURIComponent(e.path)}`) : undefined }));
    jobsRef.current = [...jobsRef.current, ...add]; setJobs(jobsRef.current); pump();
    phone.set({ incoming: phone.get().incoming.filter((x) => !entries.some((e) => e.path === x.path)) });
  };

  const saveAll = async () => {       // iPhone: one share sheet with every downloaded file: Save to Photos / Files
    const ready = jobsRef.current.filter((j) => j.dir === "down" && j.state === "done" && j.blob);
    const files = ready.map((j) => new File([j.blob!], j.name, { type: j.blob!.type || undefined }));
    try { await (navigator as any).share({ files }); } catch (e: any) { if (e?.name !== "AbortError") toast("Couldn't open the save sheet: try fewer files at once"); }
  };

  // ------------------------------------------------------------------ what you see
  const active = jobs.filter((j) => j.state !== "cancelled");
  const moving = active.filter((j) => j.state !== "done" && j.state !== "failed");
  const total = moving.reduce((n, j) => n + j.size, 0), doneB = moving.reduce((n, j) => n + j.done, 0);
  const rate = moving.reduce((n, j) => n + (j.state === "going" ? j.speed : 0), 0);
  const savable = jobs.filter((j) => j.dir === "down" && j.state === "done" && j.blob).length;
  const canShare = !!(navigator as any).canShare;

  return (
    <div className="xfer">
      <Seg className="full" style={{ marginBottom: 12 }} value={tab} onChange={setTab}
        options={[{ v: "send", label: "Send to the PC" }, { v: "get", label: `Get from the PC${incoming.length ? ` (${incoming.length} new)` : ""}` }] as const} />

      {tab === "send" && <>
        <div className="btn-row">
          <button className="btn accent" onClick={() => pickMedia.current?.click()}><Icon name="star" />Photos & videos</button>
          <button className="btn" onClick={() => pickAny.current?.click()}><Icon name="plus" />Any files</button>
        </div>
        <input ref={pickMedia} type="file" multiple accept="image/*,video/*" hidden onChange={(e) => { if (e.target.files?.length) addUploads(e.target.files); e.target.value = ""; }} />
        <input ref={pickAny} type="file" multiple hidden onChange={(e) => { if (e.target.files?.length) addUploads(e.target.files); e.target.value = ""; }} />
        <p className="muted xfer-note">Sent exactly as they are: same file, same quality, same date. On an iPhone, the photo picker may offer
          a smaller "Most Compatible" copy: to send the true original (HEIC, 4K HDR video), choose <b>Options → Current</b> in the picker if it
          is there, or pick the file through <b>Any files</b>. Files land in the PC's shared folder.</p>
      </>}

      {tab === "get" && <>
        {incoming.length > 0 && (
          <div className="note xfer-incoming">
            <b>The PC sent you {incoming.length === 1 ? incoming[0].name : `${incoming.length} files`}</b>
            <button className="btn sm accent" onClick={() => addDownloads(incoming)}><Icon name="download" />Download {incoming.length > 1 ? "all" : ""}</button>
          </div>
        )}
        <div className="xfer-path">
          {dir && <button className="btn sm ghost xfer-up" onClick={() => browse(dir.split("/").slice(0, -1).join("/"))}><Icon name="chevron" />Up</button>}
          <span className="muted">Shared folder{dir ? " / " + dir.split("/").join(" / ") : ""}</span>
          <div className="spacer" />
          <button className="iconbtn" title="Refresh" onClick={() => browse(dir)}><Icon name="refresh" /></button>
        </div>
        {listing === null && <div className="muted">Loading…</div>}
        {listing && listing.dirs.map((d) => (
          <button key={d.path} className="item xfer-dir" onClick={() => browse(d.path)}><Icon name="layers" /><span>{d.name}</span><Icon name="chevron" /></button>
        ))}
        {listing && listing.files.length === 0 && listing.dirs.length === 0 && <div className="muted" style={{ fontSize: 13.5 }}>Nothing here yet. Anything put in this folder on the PC can be downloaded here.</div>}
        {listing && listing.files.length > 0 && <>
          <div className="xfer-pickbar">
            <button className="btn sm ghost" onClick={() => setPicked(picked.length === listing.files.length ? [] : listing.files.map((f) => f.path))}>{picked.length === listing.files.length ? "Select none" : "Select all"}</button>
            <div className="spacer" />
            <button className="btn sm accent" disabled={!picked.length} onClick={() => { addDownloads(listing.files.filter((f) => picked.includes(f.path))); setPicked([]); }}>
              <Icon name="download" />Download {picked.length || ""}</button>
          </div>
          <div className="xfer-grid">
            {listing.files.map((f) => (
              <button key={f.path} className={cx("xfer-tile", picked.includes(f.path) && "on")} onClick={() => setPicked((now) => (now.includes(f.path) ? now.filter((p) => p !== f.path) : [...now, f.path]))}>
                <span className="xfer-pic">
                  {f.kind === "image" || f.kind === "video" ? <img src={q(`/files/thumb?path=${encodeURIComponent(f.path)}`)} alt="" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} /> : null}
                  <Icon name={iconFor(f.kind)} />
                  {picked.includes(f.path) && <span className="xfer-check"><Icon name="check" /></span>}
                </span>
                <span className="xfer-name">{f.name}</span>
                <span className="muted xfer-size">{fmt(f.size)}</span>
              </button>
            ))}
          </div>
          {listing.more > 0 && <div className="muted" style={{ fontSize: 12.5 }}>and {listing.more} more (open the folder on the PC to see them all)</div>}
        </>}
      </>}

      {active.length > 0 && (
        <div className="xfer-jobs">
          <div className="xfer-sum">
            {moving.length ? <><b>{moving.length} moving</b><span className="muted"> · {fmt(doneB)} of {fmt(total)}{rate > 0 ? ` · ${fmt(rate)}/s · ${eta((total - doneB) / rate)}` : ""}</span></>
              : <b>All done</b>}
            <div className="spacer" />
            {canShare && savable > 0 && <button className="btn sm accent" onClick={saveAll}>Save {savable} to Photos / Files</button>}
            <button className="btn sm ghost" onClick={() => { jobsRef.current = jobsRef.current.filter((j) => !["done", "failed", "cancelled"].includes(j.state)); setJobs(jobsRef.current); }}>Clear finished</button>
          </div>
          {moving.length > 0 && <div className="progress"><i style={{ width: `${total ? (100 * doneB) / total : 0}%` }} /></div>}
          {active.map((j) => {
            const pct = j.size ? Math.min(100, (100 * j.done) / j.size) : j.state === "done" ? 100 : 0;
            return (
              <div key={j.key} className={cx("xfer-job", j.state)}>
                <span className="xfer-pic sm">{j.preview && <img src={j.preview} alt="" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />}<Icon name={j.dir === "up" ? "plus" : "download"} /></span>
                <span className="xfer-info">
                  <b>{j.name}</b>
                  <span className="muted tnum">
                    {j.dir === "up" ? "to the PC" : "from the PC"} · {fmt(j.done)} of {fmt(j.size)} · {Math.floor(pct)}%
                    {j.state === "going" && j.speed > 0 ? ` · ${fmt(j.speed)}/s · ${eta((j.size - j.done) / j.speed)}` : ""}
                    {j.state === "waiting" ? " · waiting" : j.state === "yielding" ? " · pausing a moment for the music" : j.state === "done" ? (j.error ? ` · ${j.error}` : " · done") : j.state === "failed" ? ` · ${j.error || "failed"}` : ""}
                  </span>
                  <span className="progress"><i style={{ width: `${pct}%` }} /></span>
                </span>
                {(j.state === "waiting" || j.state === "going" || j.state === "yielding") && <button className="iconbtn" title="Stop" onClick={() => update(j.key, { state: "cancelled" })}><Icon name="x" /></button>}
                {j.state === "failed" && <button className="iconbtn" title="Try again" onClick={() => { update(j.key, { state: "waiting", done: 0, error: undefined }); pump(); }}><Icon name="refresh" /></button>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});
