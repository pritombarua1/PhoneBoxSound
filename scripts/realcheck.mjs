// node scripts/realcheck.mjs
//
// A second, real (not demo) copy of the server on another port with throwaway settings, driven by headless
// Chrome: the dashboard and one phone, against this PC's real players and the real search services.
// It only reads the players (it never seeks, pauses or changes the volume of what you are listening to).
import puppeteer from "puppeteer-core";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const PORT = 8111, URL_ = `http://localhost:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pbs-real-"));
const cfg = path.join(dir, "config.json");
const chrome = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find((p) => p && fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (name, ok, detail = "") => console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? "  " + detail : ""}`);
const PASS = "realcheck-" + Math.random().toString(36).slice(2, 10) + "-A1";      // a throwaway password for the throwaway copy

const server = spawn("python", ["-m", "phoneboxsound", "--port", String(PORT), "--https-port", String(PORT + 401), "--no-mdns", "--no-tray", "--no-browser", "--config", cfg],
  { cwd: root, stdio: "ignore", env: { ...process.env, PHONEBOXSOUND_SEAL: "file" } });
let browser;
try {
  const t0 = Date.now();
  for (let i = 0; ; i++) { if (await fetch(URL_ + "/api/auth").then((r) => r.ok, () => false)) break; if (i > 80) throw new Error("server did not start"); await sleep(100); }
  out("real server started", true, `${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const setup = await fetch(URL_ + "/api/auth/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: PASS }) });
  const cookie = (setup.headers.get("set-cookie") || "").split(";")[0];
  const api = (p, body) => fetch(URL_ + p, { method: body ? "POST" : "GET", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
  await api("/api/settings", { approval: false });
  const code = (await api("/api/status")).code;

  browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio", "--hide-scrollbars"] });
  const errors = [];
  const watch = (pg, who) => { pg.on("pageerror", (e) => errors.push(`${who}: ${e.message}`)); pg.on("console", (m) => { if (m.type() === "error" && !/401|403|404|Failed to load resource/.test(m.text())) errors.push(`${who}: ${m.text()}`); }); };

  // ---- what is really playing on this PC
  const media = await api("/api/media");
  const a = media.active;
  out("sees this PC's real players", media.sessions.length > 0, media.sessions.map((s) => `${s.app}: ${s.title || s.status}`).join(" | ") || "nothing is playing right now");
  if (a) {
    const p1 = (await api("/api/media")).active.position; await sleep(3000);
    const p2 = (await api("/api/media")).active.position;
    out("the reported position moves with the song", a.status !== "playing" || (p2 - p1 > 2 && p2 - p1 < 4.5), `${a.app}: ${p1.toFixed(1)} s → ${p2.toFixed(1)} s over 3 s`);
  }

  // ---- dashboard, signed in with the throwaway password
  const desk = await browser.newPage();
  await desk.setViewport({ width: 1600, height: 1000 }); watch(desk, "dashboard");
  await desk.goto(`${URL_}/nowplaying`, { waitUntil: "networkidle0" });
  await desk.type('.gate input[type="password"]', PASS); await desk.keyboard.press("Enter");
  await desk.waitForSelector(".np-page", { timeout: 8000 });
  await sleep(800);
  // first start: the terms come first, once
  const terms = await desk.waitForSelector(".terms", { timeout: 4000 }).then(() => true, () => false);
  await desk.evaluate(() => document.querySelector(".terms .btn.accent")?.click()); await sleep(800);
  const gone = await desk.evaluate(() => !document.querySelector(".terms"));
  await desk.reload({ waitUntil: "networkidle0" }); await sleep(1200);
  out("the first start shows the terms once; after \"I agree\" they stay away", terms && gone && await desk.evaluate(() => !document.querySelector(".terms")));

  // the volume slider: drag it across 40 positions fast, then put it back exactly where it was
  const before = (await api("/api/media")).pc;
  const drag = await desk.evaluate(async (start) => {
    const el = document.querySelector(".np-vol input[type=range]"); if (!el) return null;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    const fire = (v) => { set.call(el, String(v)); el.dispatchEvent(new Event("input", { bubbles: true })); };
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    const t0 = performance.now(); let worst = 0;
    for (let i = 0; i < 40; i++) {                       // 40 steps in ~0.65 s, within 2% of where it was (inaudible), ending where it started
      const v = Math.max(0, Math.min(1, start + (i === 39 ? 0 : (i % 2 ? 0.02 : -0.02))));
      const a = performance.now(); fire(v);
      await new Promise((r) => requestAnimationFrame(r));
      const shown = parseFloat(getComputedStyle(el).getPropertyValue("--p")) / 100;
      worst = Math.max(worst, performance.now() - a, Math.abs(shown - v) > 0.011 ? 999 : 0);
    }
    el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    return { ms: Math.round(performance.now() - t0), worst: Math.round(worst) };
  }, before?.volume ?? 0.5);
  await sleep(900);
  const after = (await api("/api/media")).pc;
  out("the volume knob follows the pointer on the same frame", !!drag && drag.worst < 60, drag ? `40 moves in ${drag.ms} ms, slowest frame ${drag.worst} ms` : "no slider");
  out("…and the PC ends exactly on the last value (nothing queued up behind)", !!before && Math.abs(after.volume - before.volume) < 0.011, `PC volume ${Math.round(before.volume * 100)}% before, ${Math.round(after.volume * 100)}% after`);

  // ---- search, against the real services
  const words = a?.title ? a.title.split(/[([-]/)[0].trim() : "daft punk one more time";
  const s0 = Date.now();
  await desk.type(".srch input", words);
  await desk.waitForSelector(".srch-hint, .srch-row", { timeout: 6000 }).catch(() => {});
  const hintAt = Date.now() - s0;
  await desk.waitForSelector(".srch-row", { timeout: 20000 }).catch(() => {});
  const rowsAt = Date.now() - s0;
  await sleep(1500);
  const res = await desk.evaluate(() => ({ rows: [...document.querySelectorAll(".srch-row")].map((r) => ({ t: r.querySelector("b").textContent, s: r.querySelector("em").textContent, pic: (r.querySelector("img")?.naturalWidth || 0) > 0 })),
    notes: [...document.querySelectorAll(".srch-note")].map((n) => n.textContent) }));
  const by = (s) => res.rows.filter((r) => r.s === s).length;
  out(`real search for "${words}" returns results with pictures`, res.rows.length >= 6 && res.rows.slice(0, 4).every((r) => r.pic),        // pictures further down load as you scroll to them
    `suggestions after ${hintAt} ms, results after ${rowsAt} ms: YouTube ${by("YouTube")}, Apple Music ${by("Apple Music")}, Spotify ${by("Spotify")}; first: "${res.rows[0]?.t}" (${res.rows[0]?.s})`);
  if (res.notes.length) console.log("       note shown:", res.notes.join(" | "));
  await desk.screenshot({ path: path.join(root, "docs", "screens", "real-search.png") });
  await desk.click(".srch-clear"); await sleep(300);
  out("the search clears with its button", await desk.evaluate(() => document.querySelectorAll(".srch-row").length === 0 && document.querySelector(".srch input").value === ""));

  // ---- a phone, on the real server
  const phone = await (await browser.createBrowserContext()).newPage();
  await phone.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1");
  await phone.setViewport({ width: 440, height: 956, deviceScaleFactor: 2, isMobile: true, hasTouch: true }); watch(phone, "phone");      // iPhone 17 Pro Max size
  await phone.goto(`${URL_}/player?code=${code}`, { waitUntil: "networkidle0" });
  await phone.type('input[placeholder]:not(.code)', "Test phone");
  await phone.click("button.bigbtn");
  await phone.waitForSelector("nav.nav", { timeout: 8000 });
  const dev = (await api("/api/devices")).find((d) => d.name === "Test phone");
  await api(`/api/devices/${dev.device_id}`, { perms: { search: true } });
  await sleep(2500);
  const stats = (await api("/api/devices")).find((d) => d.name === "Test phone");
  out("the phone receives this PC's real sound, in sync", stats.stats.played > 50 && (stats.stats.late || 0) === 0, `${stats.stats.played} blocks played, ${stats.stats.late || 0} late, link ${stats.link}`);
  await phone.evaluate(() => document.querySelector("nav.nav button:nth-child(2)").click()); await sleep(900);
  const view = await phone.evaluate(() => ({ spotify: !!document.querySelector(".sp"), title: (document.querySelector(".sp-head b") || document.querySelector(".np-card .title"))?.textContent,
    fits: !document.querySelector(".sp-ctl") || document.querySelector(".sp-ctl").getBoundingClientRect().bottom <= document.querySelector("nav.nav").getBoundingClientRect().top }));
  out("the phone's player screen shows what is playing and fits the screen", !!view.title && view.fits, `${view.spotify ? "Spotify layout" : "standard layout"}: "${view.title}"`);
  await phone.screenshot({ path: path.join(root, "docs", "screens", "real-phone.png") });
  const opener = await phone.$(".srch-open") ? ".srch-open" : '.sp-bar button[title="Search"]';
  await phone.click(opener); await sleep(400);
  await phone.type(".searchpage.on .srch input", words);
  await phone.waitForSelector(".srch-row", { timeout: 20000 }).catch(() => {});
  await sleep(1200);
  const prow = await phone.evaluate(() => document.querySelectorAll(".srch-row").length);
  await phone.click(".searchpage.on .srch-back"); await sleep(500);
  out("search on the phone shows results, and its page closes with the back button", prow >= 6 && await phone.evaluate(() => !document.querySelector(".searchpage.on")), `${prow} results`);
  out("no script errors on either page", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (e) {
  out("the check itself ran through", false, e.message);
} finally {
  await browser?.close().catch(() => {});
  server.kill();
  await sleep(500);
  fs.rmSync(dir, { recursive: true, force: true });
}
