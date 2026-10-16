// Builds docs/results.html: how PhoneBoxSound works (diagrams), what the automatic tests measured on the
// latest version, and how to run the same checks yourself.
//
//   node scripts/results.mjs <folder with loadtest.json, screen-*.json, unit.txt>
//
// GitHub Actions runs this after the tests on every change to main and publishes the docs/ folder as
// the project's website, so the numbers on the page are always from the current code.
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dir = path.resolve(process.argv[2] || path.join(root, "docs", "bench"));
const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { return null; } };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const version = (fs.readFileSync(path.join(root, "phoneboxsound", "__init__.py"), "utf8").match(/__version__ = "(.+)"/) || [])[1] || "?";
const commit = (process.env.GITHUB_SHA || "").slice(0, 7);
const when = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";

const load = read("loadtest.json");
const screens = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^screen-.*\.json$/.test(f)).map(read).filter(Boolean).sort((a, b) => a.mbps - b.mbps) : [];
let unit = "";
try { unit = (fs.readFileSync(path.join(dir, "unit.txt"), "utf8").match(/(\d+) passed/) || [])[1] || ""; } catch { /* not run */ }

const loadRows = (load?.rounds || []).map((r) => `<tr><td>${r.phones}</td><td>${r.connected}</td><td>${r.loss_pct_max ?? "–"} %</td><td>${r.jitter_p99_ms_worst ?? "–"} ms</td><td>${r.headroom_min_ms ?? "–"} ms</td><td>${r.clock_rtt_p50_ms ?? "–"} ms</td></tr>`).join("");
const ok = (r) => r.on.late === 0 && r.on.unsynced === 0 && r.on.jumps === 0 && r.on.resyncs <= 1;
const screenRows = screens.map((r) => `<tr><td>${r.mbps ? r.mbps + " Mbit/s" : "unlimited"}</td><td>${r.on.mode === "video" ? "video" : r.busy ? "pictures, busy screen" : "pictures"}${r.video && r.on.mode !== "video" ? " (video asked; this machine fell back)" : ""}</td><td>${r.cpu}× slower</td>
  <td>${r.on.late}</td><td>${r.on.unsynced}</td><td>${Math.max(0, r.on.resyncs - 1)}</td><td>${esc(r.on.buffer)}</td><td>${esc(r.on.link)}</td><td>${r.on.fps}/s</td><td class="${ok(r) ? "pass" : "fail"}">${ok(r) ? "pass" : "fail"}</td></tr>`).join("");

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>PhoneBoxSound: how it works and how it measures up</title>
<meta name="description" content="Diagrams, automatic test results and do-it-yourself checks for PhoneBoxSound.">
<style>
  :root { --bg: #0b0f0d; --panel: #131a16; --line: #2b3a32; --text: #eef3f0; --muted: #a2afa8; --accent: #5fd08f; --bad: #f06a6a; }
  @media (prefers-color-scheme: light) { :root { --bg: #f5f7f6; --panel: #fff; --line: #d6dfda; --text: #142019; --muted: #556259; --accent: #1f8a52; --bad: #b91c1c; } }
  * { box-sizing: border-box; } body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.6 system-ui, "Segoe UI", Roboto, sans-serif; }
  .wrap { max-width: 1040px; margin: 0 auto; padding: 32px 16px 64px; }
  a { color: var(--accent); } h1 { font-size: clamp(26px, 4vw, 38px); line-height: 1.15; margin: 0 0 8px; } h2 { margin: 40px 0 10px; font-size: 24px; } h3 { margin: 22px 0 8px; }
  .muted { color: var(--muted); } nav a { margin-right: 14px; white-space: nowrap; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 18px; margin: 14px 0; overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: 14.5px; } th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); white-space: nowrap; }
  th { color: var(--muted); font-weight: 600; } .pass { color: var(--accent); font-weight: 700; } .fail { color: var(--bad); font-weight: 700; }
  pre { background: var(--bg); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; overflow-x: auto; font-size: 14px; margin: 8px 0; }
  .mermaid { background: #fff; border-radius: 10px; padding: 12px; text-align: center; }
  .stat { display: inline-block; margin: 0 22px 10px 0; } .stat b { display: block; font-size: 28px; color: var(--accent); }
</style></head>
<body><div class="wrap">
<p class="muted"><a href="index.html">Guide</a> · <a href="tour.html">Guided tour</a> · <a href="https://github.com/pritombarua1/PhoneBoxSound">Source code</a> · <a href="https://github.com/pritombarua1/PhoneBoxSound/releases/latest">Download</a></p>
<h1>How PhoneBoxSound works, and how it measures up</h1>
<p class="muted">Version ${esc(version)}${commit ? ` (commit ${esc(commit)})` : ""}. Tests run automatically on GitHub's Windows machines for every change; this page was made from their results on ${esc(when)}.</p>
<nav><a href="#diagrams">Diagrams</a><a href="#results">Test results</a><a href="#yourself">Check it yourself</a></nav>

<div class="card">
  <span class="stat"><b>${unit || "–"}</b>unit tests passed</span>
  <span class="stat"><b>${(load?.rounds || []).length ? Math.max(...load.rounds.map((r) => r.phones)) : "–"}</b>phones in the load test</span>
  <span class="stat"><b>${(load?.rounds || []).length ? Math.max(...load.rounds.map((r) => r.loss_pct_max ?? 0)) + " %" : "–"}</b>sound blocks lost (worst)</span>
  <span class="stat"><b>${screens.length ? screens.filter(ok).length + " / " + screens.length : "–"}</b>screen-view checks passed</span>
</div>

<h2 id="diagrams">Diagrams</h2>
<h3>What talks to what</h3>
<div class="card"><pre class="mermaid">
flowchart LR
  subgraph PC["Windows PC"]
    direction TB
    CAP["Sound capture (WASAPI loopback, 10 ms blocks)"]
    HUB["PhoneBoxSound server (Python): pairing, permissions, sync buffer, record"]
    PLY["Players: browsers, Spotify, VLC, MPC-HC, mpv"]
    DESK["Mouse, keyboard, screen, clipboard, files, power"]
    EXT["Browser extension (optional)"]
  end
  subgraph PH["Each phone (web page, nothing installed)"]
    direction TB
    SPK["Speaker: plays each block at an exact moment"]
    REM["Remote, search, Spotify queue"]
    PAD["Touchpad, keys, screen view (only if allowed)"]
    MIC["Intercom"]
  end
  CAP --> HUB
  HUB -- "sound blocks + clock" --> SPK
  REM -- "commands" --> HUB --> PLY
  PAD -- "input, if allowed" --> HUB --> DESK
  EXT <-- "tabs, only on this PC" --> HUB
  MIC <-- "voice" --> HUB
</pre></div>

<h3>How every phone plays at the same moment</h3>
<div class="card"><pre class="mermaid">
sequenceDiagram
  participant PC as PC (clock)
  participant P as Phone
  loop every half second
    P->>PC: ping (my time)
    PC->>P: pong (your time, PC time)
    Note over P: keeps only the fastest round trips, offset = PC time minus my time
  end
  PC->>P: sound block, stamped "captured at T"
  Note over P: plays it at T + sync buffer, converted to the phone's own audio clock
  Note over P: small drift is absorbed by playing 0.4 % faster or slower, never by a jump
</pre></div>

<h3>Screen view never gets in front of the sound</h3>
<div class="card"><pre class="mermaid">
flowchart TB
  G["PC makes a picture (lighter on a weak link)"] --> S["Sent in small slices, paced to at most what the sound leaves free"]
  S --> D["Phone puts it together and draws it"]
  D --> A["Phone confirms: 'drawn'"] --> G
  W["Phone sees a sound block arrive with little time to spare"] --> T["'strain' to the PC at once"]
  T --> P["Pictures pause, get lighter and slower"]
  P --> G
</pre></div>

<h3>Screen mode: one phone takes the screen</h3>
<div class="card"><pre class="mermaid">
flowchart LR
  A["Phone A turns on Screen mode (needs Screen view + Manage speakers)"] --> O["A: the screen at the best quality, sound about 100 ms behind the picture"]
  A --> H["Every other phone: paused, sent nothing, says who has the screen"]
  A --> R["Another phone asking for the screen: turned away"]
  O --> E["A turns the screen off"] --> P["Every phone plays again, back on the shared sync buffer"]
</pre></div>

<h3>Who gets in, and what they may do</h3>
<div class="card"><pre class="mermaid">
flowchart LR
  N["New phone with the room code"] --> W{"Approve new phones?"}
  W -- "on" --> Q["Waits until approved on the PC (or by a phone allowed to approve)"]
  W -- "off" --> K
  Q --> K["Phone makes its own key in the browser, signs in with it from then on"]
  K --> P["Speaker, remote, intercom, search: on"]
  K --> X["Mouse and keyboard, clipboard, screen, files, power, commands: OFF until switched on"]
  L["Lockdown"] -.-> X
  S["Strict security: only phones that proved their key"] -.-> X
</pre></div>

<h2 id="results">Test results for this version</h2>
<h3>Many phones at once</h3>
<p class="muted">Simulated phones connect to one PhoneBoxSound exactly like the phone app (room code, clock pings, 10 ms sound blocks). "Time to spare" is how long before its play moment the worst block arrived; above zero means nothing was late.</p>
<div class="card">${loadRows ? `<table><tr><th>Phones</th><th>Connected</th><th>Blocks lost</th><th>Arrival unevenness (p99)</th><th>Time to spare (worst)</th><th>Clock round trip</th></tr>${loadRows}</table>` : `<p class="muted">Not run yet.</p>`}</div>
<h3>Screen view against the sound</h3>
<p class="muted">A phone with a slower processor watches a detailed, fast-changing screen through a simulated Wi-Fi link (one shared queue at the router, the way real Wi-Fi works). Counted from the first second.</p>
<div class="card">${screenRows ? `<table><tr><th>Link</th><th>Sent as</th><th>Phone</th><th>Sound late</th><th>Silent drops</th><th>Playback jumps</th><th>Sync buffer</th><th>Connection shown</th><th>Pictures</th><th>Result</th></tr>${screenRows}</table>` : `<p class="muted">Not run yet.</p>`}</div>
<p class="muted">These run on one machine, so they measure PhoneBoxSound itself. A real home network adds its own delays; the sync buffer exists to absorb them.</p>

<h2 id="yourself">Check it yourself</h2>
<p>Everything above can be repeated on your own PC with the source code (download it from GitHub, then run <code>start.bat</code> once so everything is installed).</p>
<div class="card">
<h3 style="margin-top:0">See it without phones: demo mode</h3>
<p>Synthetic music, a pretend player and a pretend desktop. Open the address it prints in a few browser tabs, or on your phones:</p>
<pre>python -m phoneboxsound --demo</pre>
<h3>Many phones at once</h3>
<pre>python scripts/loadtest.py
python scripts/loadtest.py --phones 100 --seconds 30</pre>
<h3>Screen view against the sound</h3>
<pre>node scripts/screencheck.mjs --busy --cpu 2 --mbps 4
node scripts/screencheck.mjs --busy --cpu 4 --mbps 3      (harsher: very slow phone, weak Wi-Fi)</pre>
<h3>Everything else</h3>
<pre>npm test             (unit tests)
npm run docs         (158 end-to-end checks in a real browser, with multi-touch; also remakes the screenshots)</pre>
<p class="muted">Scenarios worth trying on your own network: one phone far from the router while another shows the PC screen; ten phones at once; a phone switching to another app and back; the PC going to sleep and waking. The dashboard's Devices page shows each phone's connection, and the Activity page records what happened.</p>
</div>

<p class="muted">PhoneBoxSound by Pritom Barua · free for non-commercial use (PolyForm Noncommercial) · <a href="https://github.com/pritombarua1/PhoneBoxSound">github.com/pritombarua1/PhoneBoxSound</a></p>
</div>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js"></script>
<script>mermaid.initialize({ startOnLoad: true, theme: "neutral", securityLevel: "strict" });</script>
</body></html>
`;
fs.writeFileSync(path.join(root, "docs", "results.html"), html);
console.log("docs/results.html:", (load?.rounds || []).length, "load rounds,", screens.length, "screen checks,", unit || "?", "unit tests");
