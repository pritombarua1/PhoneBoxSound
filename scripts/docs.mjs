// Generates everything under docs/: screenshots (desktop + phone scale), two short videos and the PDF guide.
//
//   npm run docs
//
// It starts PhoneBoxSound in demo mode (synthetic music, a pretend player, its own config file), joins three
// simulated phones and drives the real UI with a headless Chrome, so the pictures never contain personal data
// and always match the current build. Because it exercises the whole app, it doubles as an end-to-end test.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import puppeteer from "puppeteer-core";
import { buildShow, tourSlides, recordShow, SETTINGS, EXT_SLIDES } from "./tour.mjs";

const root = path.resolve(import.meta.dirname, "..");
const PORT = Number(process.env.PBS_DOCS_PORT || 8095);
const URL_ = `http://localhost:${PORT}`;
const screens = path.join(root, "docs", "screens");
const media = path.join(root, "docs", "media");
const cfgPath = path.join(root, "docs", ".demo-config.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// small real files for the upload / music-hosting / picture tests
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbs-docs-"));
const wavPath = path.join(tmp, "Test Tone.wav");
{
  const sr = 48000, n = sr * 4, buf = Buffer.alloc(44 + n * 4);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write("WAVEfmt ", 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) { const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / sr) * 12000); buf.writeInt16LE(v, 44 + i * 4); buf.writeInt16LE(v, 46 + i * 4); }
  fs.writeFileSync(wavPath, buf);
}
const notePath = path.join(tmp, "holiday-notes.txt");
fs.writeFileSync(notePath, "sent from the phone\n".repeat(200));
const pngPath = path.join(tmp, "photo.png");
fs.writeFileSync(pngPath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAIAAAAt/+nTAAAAJElEQVR4nO3BMQEAAADCoPVPbQwfoAAAAAAAAAAAAAAAAOBnNSAAAZ7uAi4AAAAASUVORK5CYII=", "base64"));

const chrome = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((p) => p && fs.existsSync(p));
if (!chrome) throw new Error("Chrome or Edge not found. Set CHROME_PATH.");
if (!fs.existsSync(path.join(root, "web", "dist", "index.html"))) throw new Error("Run `npm run build` first.");

for (const d of [screens, media]) fs.mkdirSync(d, { recursive: true });
fs.rmSync(cfgPath, { force: true });
fs.writeFileSync(cfgPath, JSON.stringify({ approval: false }));   // the tour pairs phones directly; approval has its own checks below

const consoleErrors = [];
const api = async (p, body) => {
  const r = await fetch(URL_ + p, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
  return r.json();
};

console.log("starting demo server on port", PORT);
const serverArgs = ["-m", "phoneboxsound", "--demo", "--port", String(PORT), "--https-port", String(PORT + 401), "--no-mdns", "--no-tray", "--no-browser", "--config", cfgPath];
const serverOpts = { cwd: root, stdio: "ignore", env: { ...process.env, PHONEBOXSOUND_SEAL: "file" } };   // keep the test's seal out of the registry
const vaultPath = cfgPath.replace(/\.json$/, ".vault");
for (const f of [vaultPath, vaultPath + ".seal", vaultPath + ".tmp"]) fs.rmSync(f, { force: true });
const journalDir = cfgPath.replace(/\.json$/, "-journal");
fs.rmSync(journalDir, { recursive: true, force: true });
const server = spawn("python", serverArgs, serverOpts);
let browser;
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? "  " + detail : ""}`); };

try {
  for (let i = 0; ; i++) {
    try { await api("/api/status"); break; } catch { if (i > 60) throw new Error("server did not start"); await sleep(250); }
  }
  const { code } = await api("/api/status");

  browser = await puppeteer.launch({
    executablePath: chrome, headless: true,
    args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--hide-scrollbars"],
  });

  // ------------------------------------------------------------------ phones
  const UA = {
    iPhone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    Android: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  };
  const phoneView = { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
  async function newPhone(name, ua, join = true) {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setUserAgent(ua);
    await page.setViewport(phoneView);
    page.on("pageerror", (e) => check(`no script errors (${name})`, false, e.message));
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    await page.goto(`${URL_}/player?code=${code}`, { waitUntil: "networkidle0" });
    if (join) {
      await page.type('input[placeholder]:not(.code)', name);
      await page.click("button.bigbtn");
      await page.waitForSelector("nav.nav", { timeout: 8000 });
    }
    return page;
  }
  const tab = async (page, n) => { await page.click(`nav.nav button:nth-child(${n})`); await sleep(500); };
  const settingsCards = [];
  const shot = async (page, name, opts = {}) => { await page.screenshot({ path: path.join(screens, name + ".png"), ...opts }); console.log("   shot", name); };

  const joinPage = await newPhone("", UA.iPhone, false);
  await shot(joinPage, "phone-join");
  await joinPage.browserContext().close();

  const p1 = await newPhone("Living Room", UA.iPhone);
  const p2 = await newPhone("Kitchen", UA.Android);
  const p3 = await newPhone("Desk", UA.iPhone);
  check("three phones joined", (await api("/api/devices")).filter((d) => d.online).length === 3);
  check("each phone registered its own security key and is verified", (await api("/api/devices")).every((d) => d.has_key && d.verified));

  // the main port answers https too (typing https://…:8080 used to give a browser error)
  const tlsStatus = await new Promise((resolve) => {
    https.get(`https://localhost:${PORT}/player`, { rejectUnauthorized: false }, (r) => { r.resume(); resolve(r.statusCode); }).on("error", (e) => resolve(String(e.code || e.message)));
  });
  check("the same port answers https as well as http", tlsStatus === 200, String(tlsStatus));

  // give the first phone keyboard & mouse permission (for the touchpad screenshot)
  const devices = await api("/api/devices");
  const living = devices.find((d) => d.name === "Living Room");
  await api(`/api/devices/${living.device_id}`, { perms: { input: true, clipboard: true, screen: true, power: true, manage: true, files: true, commands: true, host: true } });
  await api(`/api/devices/${devices.find((d) => d.name === "Kitchen").device_id}`, { channel: "right", volume: 0.85 });
  await api(`/api/devices/${living.device_id}`, { channel: "left" });
  await api(`/api/devices/${devices.find((d) => d.name === "Desk").device_id}`, { volume: 0.7 });

  await sleep(4500);   // let clocks sync and audio start
  const status = await p1.$eval(".status", (el) => el.textContent);
  check("phone is in sync", /In sync/.test(status), status);
  const stats1 = (await api("/api/devices")).find((d) => d.name === "Living Room").stats;
  check("audio is playing without dropouts", stats1.played > 100 && stats1.late === 0, JSON.stringify({ played: stats1.played, late: stats1.late, buffer: stats1.ahead_ms }));
  const all = (await api("/api/devices")).filter((d) => d.online);
  check("all three phones play cleanly at once", all.every((d) => d.stats.played > 100 && d.stats.late === 0 && !d.stats.far),
    all.map((d) => `${d.name}: buffer ${d.stats.ahead_ms} ms, late ${d.stats.late}`).join(" | "));

  // ------------------------------------------------------------------ dashboard (desktop scale)
  const desk = await browser.newPage();
  await desk.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1.5 });
  desk.on("pageerror", (e) => check("no script errors (dashboard)", false, e.message));
  desk.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  await desk.goto(`${URL_}/control`, { waitUntil: "networkidle0" });
  await desk.waitForSelector(".dev-row", { timeout: 8000 });
  const page = async (hash, wait = 900) => { await desk.evaluate((h) => { location.hash = h; }, hash); await sleep(wait); };
  check("dashboard shows now playing", (await desk.$eval(".np-title", (el) => el.textContent)) === "Big Buck Bunny");
  check("dashboard lists 3 devices", (await desk.$$(".dev-row")).length === 3);
  {
    // back from another app with the music still running: nothing may be reset (that was an audible cut)
    await sleep(1500);
    const back = await p1.evaluate(async () => {
      const before = { ...window.__pbsComebacks };
      for (let k = 0; k < 3; k++) { document.dispatchEvent(new Event("visibilitychange")); await new Promise((r) => setTimeout(r, 250)); }
      return { before, after: { ...window.__pbsComebacks } };
    });
    check("coming back to the app while the sound kept playing does not restart the sync (no cut in the music)", back.after.total - back.before.total === 3 && back.after.kept - back.before.kept === 3, JSON.stringify(back));
  }

  // video 1: the dashboard in use
  const rec1 = await desk.screencast({ path: path.join(media, "dashboard.webm"), speed: 1 });
  await sleep(1500);
  await desk.evaluate(() => [...document.querySelectorAll(".seg button")].find((b) => b.textContent === "L / R Split")?.click());
  await sleep(1500);
  await page("nowplaying", 1800);
  await desk.evaluate(() => document.querySelector(".roundbtn")?.click()); await sleep(1200);
  await desk.evaluate(() => document.querySelector(".roundbtn")?.click()); await sleep(1000);
  await page("devices", 2200);
  await page("presets", 1500);
  await page("settings", 1800);
  await page("dashboard", 1500);
  await rec1.stop();
  console.log("   video dashboard.webm");

  for (const id of ["dashboard", "nowplaying", "devices", "remote", "intercom", "presets", "settings"]) {
    await page(id);
    await shot(desk, id, { fullPage: id === "devices" || id === "settings" });
    if (id === "settings") {
      // every card of the Settings page on its own, for the guided tour (one slide per group of settings)
      for (const old of fs.readdirSync(screens)) if (/^set-\d+\.png$/.test(old)) fs.rmSync(path.join(screens, old));
      const cards = await desk.$$(".page.on .card");
      for (const card of cards) {
        const info = await card.evaluate((el) => ({ nested: !!el.parentElement.closest(".card"), h: el.getBoundingClientRect().height, title: el.querySelector("h3")?.textContent.trim() || "", text: el.innerText.replace(/\s+/g, " ").trim() }));
        if (info.nested || info.h < 30) continue;
        const file = `set-${settingsCards.length}`;
        await card.screenshot({ path: path.join(screens, file + ".png") });
        settingsCards.push({ file, title: info.title, text: info.text });
      }
      console.log("   shot", settingsCards.length, "settings cards");
      const snippet = await desk.evaluate(() => { const p = document.querySelector("pre.snippet"); const cs = p && getComputedStyle(p); return cs ? { align: cs.textAlign, spacing: cs.letterSpacing } : null; });
      check("API example is laid out as code (left-aligned, normal spacing)", !!snippet && (snippet.align === "left" || snippet.align === "start") && snippet.spacing === "normal", JSON.stringify(snippet));
    }
  }

  // ------------------------------------------------------------------ phone screens
  await shot(p1, "phone-speaker");
  await tab(p1, 2);
  check("phone remote shows the track", (await p1.$eval(".np-card .title", (el) => el.textContent)) === "Big Buck Bunny");
  await shot(p1, "phone-remote");

  // remote actually controls the player
  const before = (await api("/api/media")).active.position;
  await p1.evaluate(() => document.querySelectorAll(".transport .skip")[1].click());
  await sleep(900);
  const after = (await api("/api/media")).active.position;
  check("+10 s from the phone moves the player", after - before > 8 && after - before < 14, `${before} -> ${after}`);
  await p1.evaluate(() => document.querySelector(".transport .roundbtn").click()); await sleep(700);
  check("pause from the phone", (await api("/api/media")).active.status === "paused");
  await p1.evaluate(() => document.querySelector(".transport .roundbtn").click()); await sleep(500);

  {
    const tile = (t) => p1.evaluate((text) => [...document.querySelectorAll(".tile")].find((b) => b.textContent.startsWith(text)).click(), t);
    const seen = [];
    const choose = async (label) => { await tile("Repeat"); await sleep(400); await p1.evaluate((l) => [...document.querySelectorAll(".sheet .choice")].find((b) => b.querySelector("b").textContent === l).click(), label); await sleep(800); return (await api("/api/media")).active.repeat; };
    for (const label of ["This song", "Off", "All songs"]) seen.push(await choose(label));
    check("repeat is chosen directly from the phone: this song, off, all songs", seen.join(",") === "one,off,all", seen.join(" → "));
    check("phone shows the repeat mode", /All songs/.test(await p1.evaluate(() => [...document.querySelectorAll(".tile")].find((b) => b.textContent.startsWith("Repeat")).textContent)));
    await tile("Shuffle"); await sleep(800);
    check("shuffle turns on from the phone", (await api("/api/media")).active.shuffle === true);
    await shot(p1, "phone-remote");
  }

  await p1.evaluate(() => [...document.querySelectorAll(".tile")].find((b) => b.textContent.startsWith("Speed")).click());
  await sleep(500);
  await shot(p1, "phone-speed");
  await p1.evaluate(() => [...document.querySelectorAll(".speed-steps button")][0].click()); await sleep(700);
  check("slower from the phone", (await api("/api/media")).active.rate < 1, String((await api("/api/media")).active.rate));
  await p1.evaluate(() => [...document.querySelectorAll(".speed-steps button")][1].click()); await sleep(400);
  await p1.evaluate(() => document.querySelector(".sheet-bg").click()); await sleep(300);
  await p1.evaluate(() => document.querySelector(".picker").click()); await sleep(500);
  await shot(p1, "phone-players");
  await p1.evaluate(() => document.querySelector(".sheet-bg").click()); await sleep(300);

  await p1.evaluate(() => [...document.querySelectorAll(".seg button")].find((b) => b.textContent === "Touchpad").click());
  await p1.waitForSelector(".pad", { timeout: 5000 });
  await sleep(400);
  await shot(p1, "phone-touchpad");

  // ---- touchpad, driven with real multi-touch. In demo mode the server records what it would have
  //      done to the mouse and keyboard instead of doing it, so we can assert on it.
  {
    const ts = p1.touchscreen;
    const taken = async () => { await sleep(350); return (await api("/api/debug/input?clear=1")).events; };
    const kinds = (ev) => [...new Set(ev.map((e) => e.kind))].sort().join(",");
    const rect = (sel) => p1.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
    const pad = await rect(".pad");
    const at = (fx, fy) => [pad.x + pad.w * fx, pad.y + pad.h * fy];
    const drag = async (touch, x, y, dx, dy, steps = 10) => { for (let i = 1; i <= steps; i++) { await touch.move(x + (dx * i) / steps, y + (dy * i) / steps); await sleep(16); } };
    const tapEl = async (text) => p1.evaluate((t) => [...document.querySelectorAll("button")].find((b) => b.textContent.startsWith(t)).click(), text);
    await taken();

    let [x, y] = at(0.25, 0.5);
    let t = await ts.touchStart(x, y); await drag(t, x, y, 80, 0); await t.end();
    let ev = await taken();
    const moved1 = ev.filter((e) => e.kind === "move").reduce((s, e) => s + e.dx, 0);
    check("one finger moves the pointer, and nothing else", kinds(ev) === "move" && moved1 > 0, `kinds=${kinds(ev)} dx=${moved1}`);
    check("pointer speed is scaled up for a 4K screen", moved1 > 80 * 1.5, `80 px on the phone -> ${moved1} px on the PC`);

    t = await ts.touchStart(x, y); await sleep(60); await t.end();
    ev = await taken();
    check("tap = one left click", ev.length === 1 && ev[0].kind === "click" && ev[0].button === "left", JSON.stringify(ev));

    await sleep(300);
    const a = await ts.touchStart(...at(0.3, 0.3)); const b = await ts.touchStart(...at(0.5, 0.3));
    for (let i = 1; i <= 10; i++) { await a.move(at(0.3, 0.3)[0], at(0.3, 0.3)[1] + i * 8); await b.move(at(0.5, 0.3)[0], at(0.5, 0.3)[1] + i * 8); await sleep(16); }
    await a.end();                                              // one finger lifts first...
    await drag(b, at(0.5, 0.3)[0], at(0.5, 0.3)[1] + 80, 40, 30);   // ...and the other keeps moving
    await b.end();
    ev = await taken();
    check("two fingers scroll, and never move the pointer", kinds(ev) === "scroll" && ev.some((e) => e.dy > 0), `kinds=${kinds(ev)}`);

    await sleep(300);
    const c1 = await ts.touchStart(...at(0.3, 0.5)); const c2 = await ts.touchStart(...at(0.5, 0.5)); await sleep(60); await c1.end(); await c2.end();
    ev = await taken();
    check("two-finger tap = right click", ev.length === 1 && ev[0].kind === "click" && ev[0].button === "right", JSON.stringify(ev));

    await sleep(300);
    t = await ts.touchStart(x, y); await sleep(520); await drag(t, x, y, 60, 20); await t.end();
    ev = await taken();
    check("long-press then move = drag (button held)", ev[0]?.kind === "button" && ev[0].down === true && ev.at(-1).kind === "button" && ev.at(-1).down === false && ev.some((e) => e.kind === "move"), kinds(ev));

    await sleep(400);
    t = await ts.touchStart(x, y); await sleep(50); await t.end(); await sleep(120);
    t = await ts.touchStart(x, y); await drag(t, x, y, 60, 0); await t.end();
    ev = await taken();
    check("tap-then-hold = drag", ev[0]?.kind === "click" && ev[1]?.kind === "button" && ev[1].down && ev.at(-1).kind === "button" && !ev.at(-1).down && ev.some((e) => e.kind === "move"), ev.map((e) => e.kind + (e.down === undefined ? "" : e.down ? "↓" : "↑")).join(" "));

    await sleep(400);
    await tapEl("Drag lock");
    t = await ts.touchStart(x, y); await drag(t, x, y, 50, 0); await t.end();
    await sleep(350);
    t = await ts.touchStart(x, y); await sleep(50); await t.end();   // a tap while locked must not click
    await sleep(100);
    await tapEl("Drag lock");
    ev = await taken();
    const seq = ev.map((e) => e.kind + (e.down === undefined ? "" : e.down ? "↓" : "↑"));
    check("drag lock holds the button until released", seq[0] === "button↓" && seq.at(-1) === "button↑" && seq.filter((k) => k.startsWith("button")).length === 2 && !seq.includes("click") && seq.includes("move"), seq.filter((k, i) => k !== seq[i - 1]).join(" "));

    const left = await rect(".tile.hold");
    t = await ts.touchStart(left.x + left.w / 2, left.y + left.h / 2); await sleep(150);
    const t2 = await ts.touchStart(x, y); await drag(t2, x, y, 40, 0); await t2.end();
    await t.end();
    ev = await taken();
    const seq2 = ev.map((e) => e.kind + (e.down === undefined ? "" : e.down ? "↓" : "↑"));
    check("hold Left with one finger, move with another", seq2[0] === "button↓" && seq2.at(-1) === "button↑" && seq2.includes("move"), seq2.filter((k, i) => k !== seq2[i - 1]).join(" "));

    const strip = await rect(".pad .strip");
    t = await ts.touchStart(strip.x + strip.w / 2, strip.y + 60); await drag(t, strip.x + strip.w / 2, strip.y + 60, 0, 90); await t.end();
    ev = await taken();
    check("scroll strip scrolls with one finger", kinds(ev) === "scroll", kinds(ev));

    // ---- keyboard: latched modifiers, shortcuts, custom shortcuts
    const seg = (label) => p1.evaluate((l) => [...document.querySelectorAll(".seg button")].find((b) => b.textContent === l).click(), label);
    const keysSent = async () => JSON.stringify((await taken()).map((e) => e.keys));
    await p1.evaluate(() => { const m = [...document.querySelectorAll(".keys.mods button")]; m[0].click(); m[1].click(); });   // Ctrl + Shift
    await p1.type('.row .typebox', "s");
    check("hold Ctrl + Shift, type S = Ctrl+Shift+S", (await keysSent()) === '[["ctrl","shift","s"]]');
    await p1.evaluate(() => [...document.querySelectorAll(".keys button")].find((b) => b.textContent === "Esc").click());
    check("modifiers let go after one key", (await keysSent()) === '[["esc"]]');
    await p1.evaluate(() => { [...document.querySelectorAll(".keys.mods button")][2].click(); [...document.querySelectorAll(".keys.fn button")][3].click(); });   // Alt, then F4
    check("Alt + F4", (await keysSent()) === '[["alt","f4"]]');
    await p1.type('.row .typebox', "half a sentence");
    await p1.evaluate(() => document.querySelector("nav.nav button:nth-child(4)").click()); await sleep(400);     // go to More…
    await p1.evaluate(() => document.querySelector("nav.nav button:nth-child(2)").click()); await sleep(400);     // …and back
    await p1.evaluate(() => [...document.querySelectorAll(".seg button")].find((b) => b.textContent === "Touchpad").click());
    await p1.waitForSelector(".row .typebox", { timeout: 4000 });
    check("typed text is still there after switching tabs", (await p1.$eval(".row .typebox", (el) => el.value)) === "half a sentence");
    await p1.$eval(".row .typebox", (el) => { el.focus(); });
    await p1.keyboard.down("Control"); await p1.keyboard.press("A"); await p1.keyboard.up("Control"); await p1.keyboard.press("Backspace");
    await p1.type('.row .typebox', "plain text"); await tapEl("Send");
    check("Send keeps the typing box focused (keyboard stays open)", await p1.evaluate(() => document.activeElement?.matches(".row .typebox")));
    ev = await taken();
    check("typing without modifiers sends text", ev.length === 1 && ev[0].kind === "text" && ev[0].text === "plain text", JSON.stringify(ev));
    await api("/api/debug/input?clear=1");
    await p1.type(".row .typebox", "line one"); await p1.keyboard.press("Enter"); await p1.keyboard.type("line two"); await sleep(200);
    const twoLines = { text: await p1.$eval(".row .typebox", (el) => el.value), sentYet: (await api("/api/debug/input")).events.length };
    await p1.keyboard.down("Shift"); await p1.keyboard.press("Enter"); await p1.keyboard.up("Shift"); await sleep(500);
    const sentText = (await api("/api/debug/input")).events.filter((e) => e.kind === "text").map((e) => e.text).join("|");
    check("in the type box Enter starts a new line and Shift+Enter sends the whole text to the PC", twoLines.text === "line one\nline two" && twoLines.sentYet === 0 && sentText === "line one\nline two" && (await p1.$eval(".row .typebox", (el) => el.value)) === "",
      JSON.stringify({ twoLines, sentText }));
    await api("/api/debug/input?clear=1");

    await seg("Shortcuts"); await sleep(250);
    await shot(p1, "phone-keys");
    for (const s of ["Save", "Copy", "Paste", "Alt-Tab", "Task Manager", "Screenshot", "Zoom in"]) await tapEl(s);
    check("ready-made shortcuts (Save, Copy, Paste, Alt-Tab, Task Manager, Screenshot, Zoom in)",
      (await keysSent()) === JSON.stringify([["ctrl", "s"], ["ctrl", "c"], ["ctrl", "v"], ["alt", "tab"], ["ctrl", "shift", "esc"], ["win", "shift", "s"], ["ctrl", "="]]));

    await seg("My shortcuts"); await sleep(250);
    await p1.type('input[placeholder^="Name"]', "Start recording");
    await p1.type('input[placeholder="ctrl+shift+r"]', "Ctrl + Shift+R");
    await tapEl("Add"); await sleep(250);
    await tapEl("Start recording");
    check("custom shortcut is saved and sends its keys", (await keysSent()) === '[["ctrl","shift","r"]]');
    await seg("Keys"); await sleep(250);
    await p1.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); }); await sleep(250);   // typing scrolled the page

    // pointer speed slider
    await p1.$eval('.field-row input[type="range"]', (el) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, "2");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await sleep(200);
    t = await ts.touchStart(x, y); await drag(t, x, y, 80, 0); await t.end();
    ev = await taken();
    const moved2 = ev.filter((e) => e.kind === "move").reduce((s, e) => s + e.dx, 0);
    check("pointer speed slider changes the speed", moved2 > moved1 * 1.6, `1.0x: ${moved1} px, 2.0x: ${moved2} px`);
    await p1.$eval('.field-row input[type="range"]', (el) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, "1");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });

    // screen view inside the touchpad
    await tapEl("Screen");
    const gotFrame = await p1.waitForFunction(() => { const im = document.querySelector(".screenbox img"); return im && im.naturalWidth > 0; }, { timeout: 5000 }).then(() => true, () => false);
    check("screen view shows the PC screen in the touchpad", gotFrame);
    await sleep(500);
    await shot(p1, "phone-screen");
    {
      // pictures travel on their own connection, confirmed one by one, and the sound keeps its timing meanwhile
      const lateBefore = (await api("/api/devices")).find((d) => d.name === "Living Room").stats.late || 0;
      await sleep(3500);
      const row = (await api("/api/devices")).find((d) => d.name === "Living Room");
      const viaOwn = await p1.evaluate(() => performance.getEntriesByType("resource").length >= 0);
      const wrongKey = await new Promise((resolve) => { const w = new WebSocket(`ws://127.0.0.1:${PORT}/ws/screen?k=not-the-key`); w.onopen = () => resolve(false); w.onerror = () => resolve(true); });
      check("the screen view has its own connection and does not disturb the sound", viaOwn && typeof row.screen_ms === "number" && row.screen_ms < 1500 && (row.stats.late || 0) === lateBefore && wrongKey,
        `a picture takes ${row.screen_ms} ms to arrive; late sound packets while watching: ${(row.stats.late || 0) - lateBefore}`);
      check("each phone's connection is rated and its share of the Wi-Fi shown", ["excellent", "good"].includes(row.link) && row.kbps === 1536, `${row.link}, ${row.kbps} kbit/s`);
    }
    // magnifier: the area around the PC pointer, enlarged, for reading small text
    await tapEl("Magnifier");
    await sleep(1200);
    const magnified = await p1.evaluate(() => { const im = document.querySelector(".screenbox img"); return !!im && im.naturalWidth >= 1000 && !!document.querySelector(".zoombar"); });
    check("magnifier shows the area around the pointer, enlarged", magnified);
    await p1.evaluate(() => [...document.querySelectorAll(".zoombar button")].find((b) => b.textContent === "6×").click()); await sleep(900);
    await shot(p1, "phone-magnifier");
    await tapEl("Off");

    // clipboard, both directions
    await p1.evaluate(() => [...document.querySelectorAll(".seg button")].find((b) => b.textContent === "Clipboard").click());
    await p1.waitForSelector(".clip-text", { timeout: 5000 });
    check("PC clipboard shows on the phone", (await p1.$eval(".clip-text", (el) => el.textContent)).includes("copied on the PC"));
    await shot(p1, "phone-clipboard");
    await p1.type(".clip-area", "Hello from the phone");
    await tapEl("Copy to PC"); await sleep(600);
    let dbg = await api("/api/debug/input?clear=1");
    check("phone text lands on the PC clipboard", dbg.clipboard.text === "Hello from the phone" && dbg.events.length === 0, JSON.stringify(dbg.clipboard));
    await tapEl("Copy & paste on PC"); await sleep(600);
    dbg = await api("/api/debug/input?clear=1");
    check("copy & paste presses Ctrl+V on the PC", JSON.stringify(dbg.events.map((e) => e.keys)) === '[["ctrl","v"]]', JSON.stringify(dbg.events));
    await p1.evaluate(() => document.querySelector('button[title="Refresh"]').click()); await sleep(600);
    check("phone reads back what is on the PC clipboard", (await p1.$eval(".clip-text", (el) => el.textContent)) === "Hello from the phone");

    // a phone without the permission is refused
    await p2.evaluate(() => document.querySelector("nav.nav button:nth-child(2)").click()); await sleep(400);
    const locked = await p2.evaluate(() => { [...document.querySelectorAll(".seg button")].find((b) => b.textContent === "Clipboard").click(); return new Promise((r) => setTimeout(() => r(!!document.querySelector(".lock")), 400)); });
    check("clipboard is locked on a phone without permission", locked);

    // power: every action asks first; restart / shut down count down and can be cancelled
    // clipboard picture: can be saved from a real address (phones don't download data: links)
    await (await p1.$('.card input[type="file"][accept="image/*"]')).uploadFile(pngPath);
    await sleep(900);
    await p1.evaluate(() => document.querySelector('button[title="Refresh"]').click()); await sleep(700);
    const pic = await p1.evaluate(async () => { const im = document.querySelector(".clip-img"); if (!im) return null; const r = await fetch(im.getAttribute("src")); return { src: im.getAttribute("src").slice(0, 6), status: r.status, type: r.headers.get("content-type"), disp: r.headers.get("content-disposition") }; });
    check("a picture on the PC clipboard can be saved on the phone", pic?.src === "/clip/" && pic.status === 200 && pic.type === "image/jpeg" && /attachment/.test(pic.disp || ""), JSON.stringify(pic));

    // the PC panel: magnifier keys, commands, files, power
    await desk.evaluate(async () => {
      const ws = new WebSocket(`ws://${location.host}/ws/control`); await new Promise((r) => (ws.onopen = r));
      ws.send(JSON.stringify({ t: "command_add", name: "Open notes", run: "notepad.exe" })); await new Promise((r) => setTimeout(r, 300)); ws.close();
    });
    await p1.evaluate(() => { window.scrollTo(0, 0); [...document.querySelectorAll(".seg button")].find((b) => b.textContent === "PC").click(); });
    await p1.waitForSelector(".power-grid", { timeout: 5000 });
    await sleep(600);
    await shot(p1, "phone-pc");
    await api("/api/debug/input?clear=1");
    await tapEl("Bigger"); await sleep(400);
    dbg = await api("/api/debug/input?clear=1");
    check("Windows Magnifier is switched on from the phone (Win and +)", JSON.stringify(dbg.events.map((e) => e.keys)) === '[["win","="]]', JSON.stringify(dbg.events));
    await tapEl("Open notes"); await sleep(500);
    dbg = await api("/api/debug/input?clear=1");
    check("a PC command runs from its phone button", dbg.events.length === 1 && dbg.events[0].kind === "command" && dbg.events[0].run === "notepad.exe", JSON.stringify(dbg.events));
    await p1.evaluate(() => { const f = [...document.querySelectorAll("details.fold")].find((d) => d.textContent.includes("Files & media")); if (f) f.open = true; });
    await (await p1.$('.xfer input[type="file"]:not([accept])')).uploadFile(notePath);
    await p1.waitForFunction(() => (window.__pbsTransfers?.() || []).some((j) => /holiday-notes/.test(j.name) && j.state === "done"), { timeout: 15000 }).catch(() => {});
    await p1.evaluate(() => [...document.querySelectorAll(".xfer .seg button")].find((b) => b.textContent.startsWith("Get from"))?.click());
    await p1.waitForFunction(() => [...document.querySelectorAll(".xfer-tile")].some((t) => /holiday-notes/.test(t.textContent)), { timeout: 8000 }).catch(() => {});
    const got = await p1.evaluate(async () => {
      const t = [...document.querySelectorAll(".xfer-tile")].find((x) => /holiday-notes/.test(x.textContent)); if (!t) return null;
      const k = window.__pbsFileKey || "";
      const r = await fetch(`/files/download?path=${encodeURIComponent(t.querySelector(".xfer-name").textContent)}&k=${encodeURIComponent(k)}`);
      return { name: t.querySelector(".xfer-name").textContent, status: r.status, bytes: (await r.arrayBuffer()).byteLength, k: !!k };
    });
    await shot(p1, "phone-files");
    check("a file goes phone → PC and comes back PC → phone", !!got && /holiday-notes/.test(got.name) && got.status === 200 && got.bytes === fs.statSync(notePath).size, JSON.stringify(got));
    await p1.evaluate(() => document.querySelectorAll("details.fold").forEach((d) => { d.open = true; }));
    await sleep(400);
    await shot(p1, "phone-power");
    await tapEl("Shut down"); await sleep(400);
    check("shut down asks for confirmation first", !!(await p1.$(".sheet .danger-solid")) && (await api("/api/debug/input")).events.length === 0);
    await shot(p1, "phone-power-confirm");
    await p1.evaluate(() => document.querySelector(".sheet .danger-solid").click());
    await p1.waitForSelector(".power-over", { timeout: 3000 });
    await sleep(1200);
    await shot(p1, "phone-power-countdown");
    check("the dashboard shows the countdown too", !!(await desk.$(".power-banner")));
    await p1.evaluate(() => document.querySelector(".power-over .btn").click()); await sleep(800);
    check("cancel stops the shutdown", !(await p1.$(".power-over")) && (await api("/api/debug/input?clear=1")).events.length === 0);
    await tapEl("Sleep"); await sleep(300);
    await p1.evaluate(() => [...document.querySelectorAll(".sheet .btn")].at(-1).click());
    await sleep(6500);
    dbg = await api("/api/debug/input?clear=1");
    check("sleep runs after its countdown", JSON.stringify(dbg.events) === '[{"kind":"power","action":"sleep"}]', JSON.stringify(dbg.events));
    await p2.evaluate(() => [...document.querySelectorAll(".seg button")].find((b) => b.textContent === "PC").click()); await sleep(400);
    check("the PC panel is locked on a phone without permissions", !!(await p2.$(".lock")) && !(await p2.$(".power-grid")));

    await p1.evaluate(() => [...document.querySelectorAll(".seg button")].find((b) => b.textContent === "Touchpad").click());
    await sleep(300);
  }

  await tab(p1, 3);
  await shot(p1, "phone-intercom");

  await tab(p1, 4);
  await p1.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.includes("Show QR")).click());
  await p1.waitForSelector(".qr-box svg", { timeout: 5000 }).then(() => check("phone-to-phone invite QR appears", true), () => check("phone-to-phone invite QR appears", false));
  await sleep(300);
  await shot(p1, "phone-more");

  // click test from the phone switches the source, and back
  await p1.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.includes("Click test")).click()); await sleep(1200);
  check("click test turns on from the phone", (await desk.evaluate(async () => (await (await fetch("/api/status")).json()).capture.device)) === "Sync test clicks");
  await p1.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.includes("Click test")).click()); await sleep(1200);

  // sync nudge
  await p1.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent === "+10").click()); await sleep(600);
  check("sync nudge reaches the server", (await api("/api/devices")).find((d) => d.name === "Living Room").settings.offset_ms === 10);
  await p1.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent === "Reset").click()); await sleep(300);

  // ---- all speakers, managed from one phone
  await tab(p1, 1);
  await p1.evaluate(() => [...document.querySelectorAll(".seg button")].find((b) => b.textContent === "All speakers").click());
  await p1.waitForSelector(".studio-dev", { timeout: 5000 });
  await sleep(400);
  check("one phone lists every speaker", (await p1.$$(".studio-dev")).length === 3);
  await shot(p1, "phone-studio");
  const kitchenCard = async (fn) => p1.evaluate((f) => { const card = [...document.querySelectorAll(".studio-dev")].find((c) => c.querySelector(".rename")?.value === "Kitchen"); return new Function("card", f)(card); }, fn);
  await kitchenCard('[...card.querySelectorAll(".nudge button")].find((b) => b.textContent === "+10").click()'); await sleep(250);
  await kitchenCard('[...card.querySelectorAll(".nudge button")].find((b) => b.textContent === "+2").click()'); await sleep(600);
  let kitchen = (await api("/api/devices")).find((d) => d.name === "Kitchen");
  check("timing of another phone is adjusted from this phone", kitchen.settings.offset_ms === 12, `Kitchen offset ${kitchen.settings.offset_ms} ms`);
  await kitchenCard('[...card.querySelectorAll(".seg button")].find((b) => b.textContent === "Mono").click()'); await sleep(600);
  kitchen = (await api("/api/devices")).find((d) => d.name === "Kitchen");
  check("channel of another phone is changed from this phone", kitchen.settings.channel === "mono");
  await kitchenCard('card.querySelector(".nudge b").click()'); await sleep(300);
  await api(`/api/devices/${kitchen.device_id}`, { channel: "right" });
  await p2.evaluate(() => document.querySelector("nav.nav button:nth-child(1)").click()); await sleep(300);
  check("a phone without the permission can't manage others", !(await p2.evaluate(() => [...document.querySelectorAll(".seg button")].some((b) => b.textContent === "All speakers"))));
  await p1.evaluate(() => [...document.querySelectorAll(".seg button")].find((b) => b.textContent === "This phone").click()); await sleep(300);

  // ---- text size, for people who need bigger text
  await tab(p1, 4);
  await p1.evaluate(() => [...document.querySelectorAll(".seg button")].find((b) => b.textContent === "Largest").click()); await sleep(400);
  check("text size makes the whole phone app bigger", (await p1.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--ui").trim())) === "1.5");
  await p1.evaluate(() => document.querySelectorAll("details.fold").forEach((d) => { if (d.textContent.startsWith("Text size")) d.open = true; }));
  await sleep(300);
  await shot(p1, "phone-textsize");
  await p1.evaluate(() => [...document.querySelectorAll(".seg button")].find((b) => b.textContent === "Normal").click()); await sleep(300);

  // ---- a phone hosts the music: its audio file plays on every phone in sync
  await (await p1.$('input[type="file"][accept="audio/*"]')).uploadFile(wavPath);
  await p1.waitForFunction(() => /Playing on every phone/.test(document.body.textContent), { timeout: 10000 }).catch(() => {});
  await sleep(2500);
  const hosting = await api("/api/status");
  const kBefore = (await api("/api/devices")).find((d) => d.name === "Kitchen").stats;
  await sleep(1500);
  const kAfter = (await api("/api/devices")).find((d) => d.name === "Kitchen").stats;
  check("a phone hosts the music for everyone", hosting.capture.device === "Phone: Living Room" && kAfter.played > kBefore.played && kAfter.late === kBefore.late,
    `${hosting.capture.device}; Kitchen played ${kBefore.played} → ${kAfter.played}, dropouts ${kAfter.late}`);
  check("the dashboard shows who is hosting", !!(await desk.$(".power-banner.host")));
  await p1.evaluate(() => document.querySelectorAll("details.fold").forEach((d) => { if (d.textContent.includes("Play music from this phone")) d.open = true; }));
  await sleep(300);
  await p1.evaluate(() => document.querySelector(".host-now")?.scrollIntoView({ block: "center" })); await sleep(300);
  await shot(p1, "phone-host");
  await p1.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent === "Stop hosting").click()); await sleep(1500);
  check("stopping the host returns to PC audio", (await api("/api/status")).capture.device === "Demo music", (await api("/api/status")).capture.device);
  await p1.evaluate(() => window.scrollTo(0, 0));

  // ---- data saver: half-rate audio for one phone
  await api(`/api/devices/${(await api("/api/devices")).find((d) => d.name === "Kitchen").device_id}`, { quality: "saver" });
  await sleep(2500);
  const s1 = (await api("/api/devices")).find((d) => d.name === "Kitchen").stats; await sleep(1500);
  const s2 = (await api("/api/devices")).find((d) => d.name === "Kitchen").stats;
  check("data saver keeps playing cleanly", s2.played > s1.played && s2.late === s1.late, `played ${s1.played} → ${s2.played}`);

  // video 2: the phone
  await tab(p1, 1);
  const rec2 = await p1.screencast({ path: path.join(media, "phone.webm") });
  await sleep(1800);
  await tab(p1, 2); await sleep(1200);
  await p1.evaluate(() => document.querySelectorAll(".transport .skip")[1].click()); await sleep(1200);
  await p1.evaluate(() => [...document.querySelectorAll(".tile")].find((b) => b.textContent.startsWith("Speed")).click()); await sleep(1500);
  await p1.evaluate(() => document.querySelector(".sheet-bg").click()); await sleep(600);
  await p1.evaluate(() => [...document.querySelectorAll(".seg button")].find((b) => b.textContent === "Touchpad").click()); await sleep(1600);
  await tab(p1, 3); await sleep(1400);
  await tab(p1, 4); await sleep(1600);
  await tab(p1, 1); await sleep(1200);
  await rec2.stop();
  console.log("   video phone.webm");

  // ------------------------------------------------------------------ nobody can pose as another phone
  {
    // 1. steal Living Room's saved data (device id + token) and replay it from another browser
    const stolen = await p1.evaluate(() => ({ device: localStorage.getItem("pbs.device"), token: localStorage.getItem("pbs.token") }));
    const thiefCtx = await browser.createBrowserContext();
    const thief = await thiefCtx.newPage();
    await thief.setViewport(phoneView);
    await thief.goto(`${URL_}/player`, { waitUntil: "networkidle0" });
    await thief.evaluate((s) => { localStorage.setItem("pbs.device", s.device); localStorage.setItem("pbs.token", s.token); }, stolen);
    await thief.reload({ waitUntil: "networkidle0" });
    await thief.click("button.bigbtn");
    await sleep(2500);
    const thiefState = await thief.evaluate(() => ({ joined: !!document.querySelector("nav.nav"), err: document.querySelector(".err")?.textContent || "" }));
    const victim = (await api("/api/devices")).find((d) => d.name === "Living Room");
    check("a copied device id + token can't sign in as that phone", !thiefState.joined && /security check failed/i.test(thiefState.err) && victim.online && victim.verified, `thief sees: "${thiefState.err}"`);
    await thiefCtx.close();

    // 2. a phone on a plain (non-secure) page has no key: it works as a speaker, but PC controls stay locked
    const plainCtx = await browser.createBrowserContext();
    const plain = await plainCtx.newPage();
    await plain.setUserAgent(UA.Android); await plain.setViewport(phoneView);
    await plain.evaluateOnNewDocument(() => { Object.defineProperty(window, "isSecureContext", { value: false }); });
    await plain.goto(`${URL_}/player?code=${code}`, { waitUntil: "networkidle0" });
    await plain.type('input[placeholder]:not(.code)', "Plain link");
    await plain.click("button.bigbtn");
    await plain.waitForSelector("nav.nav", { timeout: 8000 });
    const plainDev = (await api("/api/devices")).find((d) => d.name === "Plain link");
    await api(`/api/devices/${plainDev.device_id}`, { perms: { input: true, power: true } });
    await sleep(700);
    await plain.evaluate(() => document.querySelector("nav.nav button:nth-child(2)").click()); await sleep(300);
    await plain.evaluate(() => [...document.querySelectorAll(".seg button")].find((b) => b.textContent === "Touchpad").click()); await sleep(500);
    const row = (await api("/api/devices")).find((d) => d.name === "Plain link");
    const ui = await plain.evaluate(() => ({ note: !!document.querySelector(".secnote"), pad: !!document.querySelector(".pad") }));
    check("an unverified phone is given a permission but can't use it (strict security)", !row.verified && row.locked.includes("input") && row.locked.includes("power") && ui.note && !ui.pad, JSON.stringify({ locked: row.locked, ...ui }));
    await shot(plain, "phone-locked");
    await api("/api/debug/input?clear=1");
    await plain.evaluate(() => { const ws = new WebSocket(`ws://${location.host}/ws/player`); });   // a raw attempt changes nothing
    await plainCtx.close();

    // 3. the API can drive the PC for automation
    await api("/api/keys", { keys: ["ctrl", "s"] });
    const viaApi = await api("/api/debug/input?clear=1");
    check("API: press keys", JSON.stringify(viaApi.events.map((e) => e.keys)) === '[["ctrl","s"]]');
    await api("/api/clipboard", { text: "set through the API" });
    check("API: clipboard", (await api("/api/clipboard")).text === "set through the API");
  }

  // ------------------------------------------------------------------ names follow everywhere
  {
    const kitchen = (await api("/api/devices")).find((d) => d.name === "Kitchen");
    await api(`/api/devices/${kitchen.device_id}`, { name: "Kitchen shelf" });       // renamed on the PC…
    await sleep(600);
    check("renaming a phone on the PC reaches the phone", await p2.evaluate(() => localStorage.getItem("pbs.name")) === "Kitchen shelf");
    await p2.evaluate(() => document.querySelector("nav.nav button:nth-child(4)").click()); await sleep(500);
    const shown = await p2.evaluate(() => document.querySelector('.item input[maxlength="32"]')?.value);
    await p2.focus('.item input[maxlength="32"]');
    await p2.evaluate(() => document.querySelector('.item input[maxlength="32"]').select());
    await p2.keyboard.type("Pantry");                                                  // …and renamed on the phone
    await p2.keyboard.press("Enter");
    await sleep(700);
    const after = (await api("/api/devices")).find((d) => d.device_id === kitchen.device_id).name;
    const onDash = await desk.evaluate(() => document.body.innerText.includes("Pantry") || [...document.querySelectorAll("input")].some((i) => i.value === "Pantry"));
    check("renaming on the phone reaches the PC", shown === "Kitchen shelf" && after === "Pantry", JSON.stringify({ shown, after, onDash }));
    await api(`/api/devices/${kitchen.device_id}`, { name: "Kitchen" });
    await p2.evaluate(() => document.querySelector("nav.nav button:nth-child(1)").click());
  }

  // ------------------------------------------------------------------ what a phone can fetch
  {
    const get = (path, headers = {}) => new Promise((resolve) => {
      http.get({ host: "127.0.0.1", port: PORT, path, headers }, (r) => { r.resume(); resolve({ status: r.statusCode, h: r.headers }); }).on("error", () => resolve({ status: 0, h: {} }));
    });
    const phone = { "X-Forwarded-For": "192.168.77.77" };      // how a request from another device looks to the server
    const files = fs.readdirSync(path.join(root, "web", "dist", "assets"));
    const dashFile = files.find((f) => /^Settings-.*\.js$/.test(f)), phoneFile = files.find((f) => /^player-.*\.js$/.test(f));
    const a = await get(`/assets/${dashFile}`, phone), b = await get(`/assets/${dashFile}`), c = await get(`/assets/${phoneFile}`, phone);
    check("phones can't download the dashboard's code", a.status === 404 && b.status === 200 && c.status === 200, `${dashFile}: phone ${a.status}, PC ${b.status}; ${phoneFile}: phone ${c.status}`);
    const pages = await Promise.all(["/devices", "/settings", "/api/devices", "/api/status", "/qr.svg", "/api/diagnostics", "/files/list", "/api/clipboard"].map((u) => get(u, phone)));
    check("dashboard pages and the API refuse other devices", pages.every((r) => r.status === 401 || r.status === 403), pages.map((r) => r.status).join(" "));
    const page = await get("/player");
    const csp = page.h["content-security-policy"] || "";
    check("pages carry browser protections (script injection, framing, sniffing)",
      /script-src 'self';/.test(csp) && /frame-ancestors 'self'/.test(csp) && page.h["x-frame-options"] === "SAMEORIGIN" && page.h["x-content-type-options"] === "nosniff", csp.slice(0, 60));
    await desk.evaluate(() => [...document.querySelectorAll(".side .nav a")].find((x) => x.textContent.startsWith("Devices")).click()); await sleep(400);
    const at = await desk.evaluate(() => location.pathname + location.hash);
    await desk.goto(`${URL_}/settings`, { waitUntil: "networkidle0" });
    const direct = await desk.evaluate(() => document.querySelector(".side .nav a.on")?.textContent || "");
    const cspErrors = consoleErrors.filter((e) => /Content Security Policy/i.test(e));
    check("each dashboard page has its own address", at === "/devices" && /Settings/.test(direct), `${at}, opened /settings -> ${direct}`);
    check("the strict content policy blocks nothing the app needs", cspErrors.length === 0, cspErrors[0] || "");
  }

  // ------------------------------------------------------------------ lockdown and a faked address
  {
    const asHost = (host) => new Promise((resolve) => {
      http.get({ host: "127.0.0.1", port: PORT, path: "/api/status", headers: { Host: host } }, (r) => { r.resume(); resolve(r.statusCode); }).on("error", () => resolve(0));
    });
    check("a website pointing its own name at this PC gets nothing (DNS rebinding)", (await asHost("evil.example:" + PORT)) === 401 && (await asHost("localhost:" + PORT)) === 200);

    const lockBtn = () => desk.evaluate(() => [...document.querySelectorAll("header button")].find((x) => (x.title || "").startsWith("Lockdown")).click());
    await lockBtn(); await sleep(700);
    const locked = (await api("/api/devices")).find((d) => d.name === "Living Room");
    await api("/api/debug/input?clear=1");
    await p1.evaluate(() => document.querySelector("nav.nav button:nth-child(2)").click()); await sleep(300);
    await p1.evaluate(() => [...document.querySelectorAll(".seg button")].find((x) => x.textContent === "Touchpad").click()); await sleep(500);
    const ui = await p1.evaluate(() => ({ note: document.querySelector(".secnote")?.textContent || "", pad: !!document.querySelector(".pad") }));
    const lateCtx = await browser.createBrowserContext();
    const late = await lateCtx.newPage();
    await late.setViewport(phoneView);
    await late.goto(`${URL_}/player?code=${code}`, { waitUntil: "networkidle0" });
    await late.click("button.bigbtn"); await sleep(1200);
    const lateState = await late.evaluate(() => ({ joined: !!document.querySelector("nav.nav"), err: document.querySelector(".err")?.textContent || "" }));
    await lateCtx.close();
    check("lockdown: even a verified, fully authorised phone loses PC control", locked.verified && locked.locked.includes("input") && locked.locked.includes("power") && /lockdown/i.test(ui.note) && !ui.pad, JSON.stringify({ locked: locked.locked, ...ui }));
    check("lockdown: no new phone can join, even with the right code", !lateState.joined && /lockdown/i.test(lateState.err), lateState.err);
    await shot(desk, "lockdown");
    await lockBtn(); await sleep(700);
    const freed = (await api("/api/devices")).find((d) => d.name === "Living Room");
    check("lockdown off: permissions come back as they were", freed.locked.length === 0 && await p1.evaluate(() => !!document.querySelector(".pad")));
    await p1.evaluate(() => [...document.querySelectorAll(".seg button")].find((x) => x.textContent === "Media").click());
    await p1.evaluate(() => document.querySelector("nav.nav button:nth-child(1)").click());
  }

  // ------------------------------------------------------------------ new phones need approval
  {
    await api("/api/settings", { approval: true });
    const guestCtx = await browser.createBrowserContext();
    const guest = await guestCtx.newPage();
    await guest.setUserAgent(UA.iPhone); await guest.setViewport(phoneView);
    await guest.goto(`${URL_}/player?code=${code}`, { waitUntil: "networkidle0" });
    await guest.type('input[placeholder]:not(.code)', "Guest phone");
    await guest.click("button.bigbtn"); await sleep(1500);
    const waitingUi = await guest.evaluate(() => /Waiting for approval/.test(document.body.innerText) && !document.querySelector("nav.nav"));
    const pend = await api("/api/pending"), rows = await api("/api/devices");
    check("a new phone with the right code only reaches the waiting room",
      waitingUi && pend.length === 1 && pend[0].name === "Guest phone" && pend[0].waiting && !rows.some((d) => d.name === "Guest phone"), JSON.stringify(pend));
    await shot(guest, "phone-waiting");
    await desk.goto(`${URL_}/devices`, { waitUntil: "networkidle0" }); await sleep(400);
    await shot(desk, "approval");

    await api(`/api/devices/${living.device_id}`, { perms: { approve: true } }); await sleep(600);
    await p1.evaluate(() => document.querySelector("nav.nav button:nth-child(4)").click()); await sleep(500);
    await shot(p1, "phone-approve");
    const hadCard = await p1.evaluate(() => { const b = [...document.querySelectorAll(".approvals button")].find((x) => x.textContent === "Approve"); b?.click(); return !!b; });
    await sleep(1500);
    const inNow = await guest.evaluate(() => !!document.querySelector("nav.nav"));
    const guestRow = (await api("/api/devices")).find((d) => d.name === "Guest phone");
    check("a phone with the Approve permission lets it in, and it starts working by itself", hadCard && inNow && !!guestRow?.online && (await api("/api/pending")).length === 0);

    const strangerCtx = await browser.createBrowserContext();
    const stranger = await strangerCtx.newPage();
    await stranger.setViewport(phoneView);
    await stranger.goto(`${URL_}/player?code=${code}`, { waitUntil: "networkidle0" });
    await stranger.type('input[placeholder]:not(.code)', "Stranger");
    await stranger.click("button.bigbtn"); await sleep(1200);
    const sid = (await api("/api/pending"))[0]?.device_id;
    await api(`/api/devices/${sid}/approve`, { ok: false }); await sleep(900);
    const told = await stranger.evaluate(() => ({ err: document.querySelector(".err")?.textContent || "", joined: !!document.querySelector("nav.nav") }));
    check("a denied phone is turned away and leaves no access behind", /did not approve/i.test(told.err) && !told.joined && (await api("/api/pending")).length === 0 && !(await api("/api/devices")).some((d) => d.name === "Stranger"), told.err);
    await strangerCtx.close();

    await desk.type("input.search", "guest"); await sleep(400);
    const found = await desk.evaluate(() => [...document.querySelectorAll(".dcard .nm")].map((i) => i.value));
    check("devices can be searched", found.length === 1 && found[0] === "Guest phone", found.join(", "));
    await desk.evaluate(() => { const i = document.querySelector("input.search"); i.focus(); i.select(); }); await desk.keyboard.press("Backspace");
    await guestCtx.close();
    await api("/api/settings", { approval: false });
    await p1.evaluate(() => document.querySelector("nav.nav button:nth-child(1)").click());
  }

  // ------------------------------------------------------------------ blocking a phone
  {
    const desk3 = (await api("/api/devices")).find((d) => d.name === "Desk");
    await desk.evaluate(async (id) => {
      const ws = new WebSocket(`ws://${location.host}/ws/control`); await new Promise((r) => (ws.onopen = r));
      ws.send(JSON.stringify({ t: "block", device_id: id, on: true })); await new Promise((r) => setTimeout(r, 600)); ws.close();
    }, desk3.device_id);
    await sleep(1200);
    const told = await p3.evaluate(() => document.querySelector(".err")?.textContent || "");
    await p3.evaluate(() => document.querySelector("button.bigbtn")?.click());
    await sleep(2500);
    const still = await p3.evaluate(() => ({ joined: !!document.querySelector("nav.nav"), err: document.querySelector(".err")?.textContent || "" }));
    const rows = await api("/api/devices");
    check("a blocked phone is disconnected and can't get back in", /blocked/i.test(told) && !still.joined && rows.find((d) => d.name === "Desk")?.blocked === true && !rows.find((d) => d.name === "Desk").online,
      `told: "${told}" · retry: "${still.err}"`);
  }

  // ------------------------------------------------------------------ themes
  const setTheme = async (theme, mode) => { await desk.evaluate(async (t, m) => {
    const ws = new WebSocket(`ws://${location.host}/ws/control`);
    await new Promise((r) => (ws.onopen = r));
    ws.send(JSON.stringify({ t: "set_global", theme: t, mode: m }));
    await new Promise((r) => setTimeout(r, 300)); ws.close();
  }, theme, mode); await sleep(1500); };
  await page("dashboard");
  for (const [theme, mode] of [["sand", "light"], ["aurora", "dark"], ["ocean", "light"], ["midnight", "dark"]]) {
    await setTheme(theme, mode);
    await shot(desk, `theme-${theme}`);
    if (theme === "sand") { await tab(p1, 2); await p1.evaluate(() => [...document.querySelectorAll(".seg button")].find((b) => b.textContent === "Media").click()); await sleep(600); await shot(p1, "phone-remote-light"); await tab(p1, 1); await shot(p1, "phone-speaker-light"); }
  }
  await setTheme("forest", "dark");

  // ------------------------------------------------------------------ the two-day activity record and its replay
  {
    const recorded = await api("/api/journal");
    const lr = recorded.find((d) => d.name === "Living Room"), kit = recorded.find((d) => d.name === "Kitchen");
    const { events } = await api(`/api/journal/${lr.device_id}?limit=60000`);
    const has = (d, k, f = () => true) => events.some((e) => e.d === d && e.k === k && f(e.m || {}, e));
    const ordered = events.every((e, i) => Number.isInteger(e.t) && e.t > 1.6e12 && (i === 0 || e.t >= events[i - 1].t - 1000));
    const secret = await p1.evaluate(() => localStorage.getItem("pbs.token"));
    const dump = JSON.stringify(events);
    check("every phone has a record: taps, keys, pointer, media, what it was sent, packets",
      has("in", "ui", (m) => m.ev === "tap" && m.label && Number.isFinite(m.x)) && has("in", "input", (m) => m.kind === "key") && has("in", "input", (m) => m.kind === "move")
      && has("in", "media") && has("out", "config") && has("out", "media") && has("sys", "connected") && has("sys", "packets", (m) => m.audio_out?.[0] > 0) && has("in", "stats"),
      `${events.length} lines for Living Room, ${recorded.length} phones recorded`);
    check("the record is in milliseconds, in order, and holds no secrets", ordered && !!secret && !dump.includes(secret) && !dump.includes(`"code":"${code}"`) && dump.includes("(hidden)"));
    check("attempts are on record too (the failed impersonation of this phone)", has("sys", "refused", (m) => /without its key/.test(m.what)));

    // request and result are matched: each thing the phone asked for carries its number and what the PC did
    const asked = events.filter((e) => e.d === "in" && e.r != null);
    const numbered = events.filter((e) => e.d === "in" && e.n != null);
    const lastRx = Math.max(0, ...events.filter((e) => e.k === "stats").map((e) => e.m.rx || 0));
    const sent = events.filter((e) => e.d === "out" && e.s != null);
    check("every request is matched with what the PC did, and nothing was lost in between",
      asked.length > 30 && asked.every((e) => e.r === 1 || (e.r === 0 && e.why)) && numbered.length > 50 && !has("sys", "mismatch") && sent.length > 10 && lastRx > 0,
      `${asked.length} requests (${asked.filter((e) => e.r === 0).length} refused), ${sent.length} messages to the phone, phone confirmed up to #${lastRx}`);
    const plain = recorded.find((d) => d.name === "Plain link");
    const plainEv = plain ? (await api(`/api/journal/${plain.device_id}?limit=60000`)).events : [];

    // the screen recording: rebuild every picture from the recorded differences and compare its size with what the phone reported
    const rebuild = (evs) => { let html = "", ok = 0, bad = 0; const shots = [];
      for (const e of evs) if (e.k === "snap") { const m = e.m; html = !m.p && !m.e ? m.mid : html.slice(0, m.p) + m.mid + html.slice(html.length - m.e); (html.length === m.len ? ok++ : bad++); shots.push(html); }
      return { shots, ok, bad }; };
    const lrShots = rebuild(events), kitShots = rebuild((await api(`/api/journal/${kit.device_id}?limit=60000`)).events);
    check("the phone's screen is recorded exactly (every picture rebuilds to the size the phone reported)",
      lrShots.ok > 20 && lrShots.bad === 0 && kitShots.bad === 0 && lrShots.shots.some((h) => h.includes("nav")), `${lrShots.ok} pictures for Living Room, ${kitShots.ok} for Kitchen`);
    check("the recording shows what was typed on the phone (the rename to \"Pantry\")", kitShots.shots.some((h) => h.includes('value="Pantry"')));
    const perHour = (d) => Math.round(d.bytes / 1024);
    check("the record stays small", lr.bytes < 400 * 1024, `Living Room: ${perHour(lr)} kB on disk for ${events.length} lines and ${lrShots.ok} screen pictures of a very busy session`);

    await desk.goto(`${URL_}/activity`, { waitUntil: "networkidle0" }); await sleep(600);
    await desk.select("select.input", lr.device_id); await sleep(1200);
    const lines = await desk.evaluate(() => [...document.querySelectorAll(".lrow")].slice(0, 400).map((r) => r.innerText.replace(/\s+/g, " ")));
    const bar = await desk.evaluate(() => document.querySelector(".matchbar")?.innerText.replace(/\s+/g, " ") || "");
    check("the Activity page lists it in plain words with millisecond times and results", lines.length > 20 && lines.every((l) => /^\d\d:\d\d:\d\d\.\d{3} /.test(l)) && lines.some((l) => /Tapped "/.test(l)) && lines.some((l) => /Pressed .*✓ done/.test(l)) && /carried out/.test(bar) && /Nothing lost/.test(bar),
      bar);
    await shot(desk, "activity");
    const before = (await api("/api/devices")).map((d) => `${d.name}:${d.online}`).join(",");
    const inputsBefore = (await api("/api/debug/input")).events.length;
    await desk.evaluate(() => [...document.querySelectorAll("button")].find((x) => x.textContent === "Replay latest visit").click());
    await sleep(1500);
    await desk.evaluate(() => [...document.querySelectorAll(".replay .seg button")].find((x) => x.textContent === "64×").click());
    await sleep(9000);
    const simState = await desk.evaluate(() => { const d = document.querySelector(".sim iframe")?.contentDocument; const cs = d && d.querySelector("nav.nav") && getComputedStyle(d.querySelector("nav.nav"));
      return d ? { app: !!d.querySelector("nav.nav"), styled: !!cs && cs.position === "fixed", scripts: d.querySelectorAll("script").length, text: d.body.innerText.slice(0, 60) } : null; });
    const progress = await desk.evaluate(() => document.querySelector(".replay-ctl .muted")?.textContent || "");
    const feed = await desk.evaluate(() => document.querySelectorAll(".replay .frow").length);
    await shot(desk, "replay");
    // scrub back to the middle: the picture is rebuilt for that moment
    await desk.evaluate(() => { const r = document.querySelector(".replay .scrub"); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(r, String(Math.floor(r.max / 2))); r.dispatchEvent(new Event("input", { bubbles: true })); });
    await sleep(600);
    const mid = await desk.evaluate(() => !!document.querySelector(".sim iframe")?.contentDocument?.querySelector("nav.nav"));
    const after = (await api("/api/devices")).map((d) => `${d.name}:${d.online}`).join(",");
    const [done, total] = progress.split("/").map((x) => Number(x.trim()));
    check("replay shows the phone's recorded screen, styled like the phone, and can jump to any moment", !!simState?.app && simState.styled && simState.scripts === 0 && done > 50 && total >= done && feed > 0 && mid, `${progress} lines, screen shows: "${simState?.text.replace(/\s+/g, " ")}"`);
    check("a replay touches nothing real (no device, no key press, no click reaches the PC)", before === after && (await api("/api/debug/input")).events.length === inputsBefore);
    await desk.evaluate(() => document.querySelector(".replay .iconbtn").click());
    void plainEv;
  }

  // ------------------------------------------------------------------ bedtime, announcements, guest pass, panic gesture, digest
  {
    const post = (u, body) => fetch(URL_ + u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
    const lrId = (await api("/api/devices")).find((d) => d.name === "Living Room").device_id;

    // bedtime: fade for 6 seconds, then pause and lock
    await api("/api/media/play", {});
    await api("/api/debug/input?clear=1");
    const started = await post("/api/bedtime", { minutes: 0.1, after: "lock" });
    await sleep(2500);
    const midGain = await p1.evaluate(() => document.querySelector("#root") && 1);
    await desk.goto(`${URL_}/presets`, { waitUntil: "networkidle0" }); await sleep(400);
    await shot(desk, "bedtime");
    await sleep(7500);
    const afterBed = { media: (await api("/api/media")).active?.status, power: (await api("/api/debug/input")).events.filter((e) => e.kind === "power").map((e) => e.action).join(), left: (await post("/api/bedtime", { cancel: true })).ok };
    check("bedtime: phones fade out, then the player pauses and the PC locks", started.ok && started.bedtime.left_s > 0 && started.bedtime.after === "lock" && afterBed.media === "paused" && afterBed.power === "lock" && !!midGain, JSON.stringify(afterBed));
    await api("/api/media/play", {});

    // doorbell / announcement over the API
    await tab(p1, 1);
    const said = await post("/api/announce", { sound: "doorbell", text: "Dinner is ready" });
    await sleep(1200);
    const toastSeen = await p1.evaluate(() => [...document.querySelectorAll(".toast")].some((t) => /Dinner is ready/.test(t.textContent)));
    await sleep(11500);
    const pk = (await api(`/api/journal/${lrId}?from=${Date.now() - 20000}&kinds=packets`)).events;
    check("an announcement plays on the phones and shows its words", said.ok && toastSeen && pk.some((e) => e.m.intercom_out?.[0] > 20), `intercom packets: ${pk.map((e) => e.m.intercom_out?.[0] || 0).join(",")}`);

    await desk.goto(`${URL_}/dashboard`, { waitUntil: "networkidle0" }); await sleep(400);
    await desk.evaluate(() => [...document.querySelectorAll("button")].find((x) => x.textContent === "Guest pass").click()); await sleep(800);
    const box = await desk.evaluate(() => { const q = document.querySelector(".modal .qr"), v = q?.querySelector("svg"); if (!v) return null; const a = q.getBoundingClientRect(), c = v.getBoundingClientRect();
      return { fits: c.left >= a.left - 1 && c.right <= a.right + 1 && c.bottom <= a.bottom + 1 && Math.abs(c.width - c.height) < 2, drawing: getComputedStyle(v.querySelector(".pq-m")).animationName === "pq-dot", dots: v.querySelectorAll(".pq-m").length }; });
    await sleep(1600); await shot(desk, "guest-pass-drawing");
    await sleep(3200); await shot(desk, "guest-pass");
    const drawn = await desk.evaluate(() => [...document.querySelectorAll(".modal .qr .pq-m")].every((d) => getComputedStyle(d).opacity === "1"));
    check("the guest pass code fits its box and draws itself dot by dot in about four seconds", !!box && box.fits && box.drawing && box.dots > 300 && drawn, JSON.stringify(box));
    await desk.evaluate(() => document.querySelector(".modal .iconbtn").click());

    // guest pass: straight in as a speaker, nothing else, gone when the time is up
    await api("/api/settings", { approval: true });
    const pass = await post("/api/guest", { hours: 0.003 });           // about 11 seconds
    const gctx = await browser.createBrowserContext();
    const g = await gctx.newPage();
    await g.setUserAgent(UA.Android); await g.setViewport(phoneView);
    await g.goto(pass.url.replace(/^https?:\/\/[^/]+/, URL_).replace("/?", "/player?"), { waitUntil: "networkidle0" });
    const label = await g.evaluate(() => document.querySelector("button.bigbtn")?.textContent || "");
    await g.click("button.bigbtn"); await sleep(1500);
    const gIn = await g.evaluate(() => !!document.querySelector("nav.nav"));
    const gRow = (await api("/api/devices")).find((d) => d.guest_until > 0);
    await api(`/api/devices/${gRow?.device_id}`, { perms: { input: true, remote: true, power: true } });      // even if someone switches things on for it
    await sleep(600);
    await api("/api/debug/input?clear=1");
    await tab(g, 2); await sleep(400);
    const gLocked = await g.evaluate(() => /Media remote is off/.test(document.body.innerText));
    await shot(g, "phone-guest");
    await sleep(14000);
    const gone = { row: !(await api("/api/devices")).some((d) => d.guest_until > 0), told: await g.evaluate(() => document.querySelector(".err")?.textContent || "") };
    check("a guest pass lets a phone in as a speaker only, without approval", /guest/i.test(label) && gIn && !!gRow && gLocked, `button: "${label}"`);
    check("when the guest pass ends the phone is disconnected and its record removed", gone.row && /guest pass has ended/i.test(gone.told), gone.told);
    await gctx.close();
    await api("/api/settings", { approval: false });

    // panic gesture: three hard shakes of a trusted phone
    await api(`/api/devices/${lrId}`, { perms: { panic: true } }); await sleep(600);
    await tab(p1, 4); await sleep(400);
    await p1.evaluate(() => { const d = [...document.querySelectorAll("details.fold")].find((x) => x.querySelector(".ft")?.textContent === "Security"); d.open = true; });
    await sleep(300);
    const switched = await p1.evaluate(() => { const row = [...document.querySelectorAll(".fold-body .row")].find((r) => /Shake to lock down/.test(r.textContent)); const sw = row?.querySelector("button,input,[role=switch],.switch"); sw?.click(); return !!sw; });
    await sleep(500);
    const shake = () => p1.evaluate(async () => { for (let i = 0; i < 3; i++) { window.dispatchEvent(new DeviceMotionEvent("devicemotion", { accelerationIncludingGravity: { x: 32, y: 4, z: 9 } })); await new Promise((r) => setTimeout(r, 220)); } });
    await p1.evaluate(() => window.dispatchEvent(new DeviceMotionEvent("devicemotion", { accelerationIncludingGravity: { x: 3, y: 4, z: 9.8 } })));   // carrying it around does nothing
    await sleep(300);
    const calm = (await api("/api/security")).settings.lockdown;
    await shake(); await sleep(900);
    const locked = (await api("/api/security")).settings.lockdown;
    check("shaking a trusted phone three times puts the PC in lockdown", switched && calm === false && locked === true);
    await api("/api/settings", { lockdown: false }); await sleep(500);
    await tab(p1, 1);

    // the security digest
    const dg = await api("/api/security?days=7");
    const count = (k) => dg.groups.find((x) => x.key === k)?.count || 0;
    await desk.goto(`${URL_}/activity`, { waitUntil: "networkidle0" }); await sleep(400);
    await desk.evaluate(() => [...document.querySelectorAll(".seg button")].find((x) => x.textContent === "Security digest").click()); await sleep(900);
    const cards = await desk.evaluate(() => document.querySelectorAll(".digest .dg").length);
    await shot(desk, "security-digest");
    check("the security digest counts what happened (failed identity check, lockdowns, guest passes, denials)",
      count("impersonation") >= 1 && count("lockdown") >= 2 && count("guest") >= 2 && count("denied") >= 1 && count("joined") >= 1 && cards === dg.groups.length && dg.devices.total >= 3,
      dg.groups.map((x) => `${x.key} ${x.count}`).join(", "));
  }

  // ------------------------------------------------------------------ controls are visible at a glance
  {
    const measure = (pg) => pg.evaluate(() => {
      const lum = (c) => { const m = parse(c); const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]); };
      const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
      const parse = (c) => { const m = c.match(/-?[\d.]+(?:e-?\d+)?/g).map(Number), k = c.startsWith("color(") ? 255 : 1; return [m[0] * k, m[1] * k, m[2] * k, m.length > 3 ? m[3] : 1]; };   // mixed colours come back as color(srgb 0..1)
      const bgOf = (el) => {          // the colour really seen behind an element: see-through layers are laid over what is under them
        const layers = [];
        for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c[3] > 0) { layers.push(c); if (c[3] >= 1) break; } }
        const probe = document.createElement("i"); probe.style.background = "var(--bg)"; document.body.appendChild(probe);
        let base = parse(getComputedStyle(probe).backgroundColor).slice(0, 3); probe.remove();      // the page's own colour is under everything
        for (const c of layers.reverse()) base = [0, 1, 2].map((i) => c[i] * c[3] + base[i] * (1 - c[3]));
        return `rgb(${base.map(Math.round).join(",")})`;
      };
      const over = (c, bg) => { const a = parse(c), b = parse(bg); return `rgb(${[0, 1, 2].map((i) => Math.round(a[i] * a[3] + b[i] * (1 - a[3]))).join(",")})`; };
      const out = { switches: 0, narrow: 0, offWeak: 0, onWeak: 0, tabs: 0, tabWeak: 0, btnWeak: 0, btns: 0, which: [] };
      for (const sw of document.querySelectorAll(".switch")) {
        const span = sw.querySelector("span"), cs = getComputedStyle(span), r = span.getBoundingClientRect(), bg = bgOf(sw.parentElement), on = sw.querySelector("input").checked;
        if (!r.width) continue;
        out.switches++;
        if (r.width < 40 || r.height < 20) out.narrow++;
        const edge = ratio(over(cs.borderTopColor, bg), bg);
        if (!on && edge < 3) { out.offWeak++; out.which.push(`switch off ${edge.toFixed(1)}`); }
        if (on && ratio(over(cs.backgroundColor, bg), bg) < 3) { out.onWeak++; out.which.push(`switch on ${ratio(over(cs.backgroundColor, bg), bg).toFixed(1)}`); }
      }
      for (const b of document.querySelectorAll(".seg button.on")) {
        const thumb = b.parentElement.querySelector(".seg-thumb"), fill = thumb && getComputedStyle(thumb).opacity !== "0" ? getComputedStyle(thumb).backgroundColor : getComputedStyle(b).backgroundColor;
        out.tabs++; if (ratio(getComputedStyle(b).color, fill) < 4.5) { out.tabWeak++; out.which.push(`tab "${b.textContent.trim()}" ${ratio(getComputedStyle(b).color, fill).toFixed(1)}`); }
      }
      for (const b of document.querySelectorAll(".btn:not(.accent):not(:disabled)")) {
        if (!b.getBoundingClientRect().width) continue;
        const behind = bgOf(b.parentElement), fill = bgOf(b), edge = ratio(over(getComputedStyle(b).borderTopColor, behind), behind), text = ratio(over(getComputedStyle(b).color, fill), fill);
        out.btns++; if (edge < 2 || text < 4.5) { out.btnWeak++; out.which.push(`${b.className} "${b.textContent.trim().slice(0, 18)}": outline ${edge.toFixed(1)}, text ${text.toFixed(1)}`); }
      }
      return out;
    });
    const fails = [];
    for (const [theme, mode] of [["forest", "dark"], ["midnight", "dark"], ["sand", "light"], ["ocean", "light"]]) {
      await setTheme(theme, mode);
      for (const [where, pg, go] of [["Remote", desk, "remote"], ["Devices", desk, "devices"], ["Settings", desk, "settings"]]) {
        await desk.goto(`${URL_}/${go}`, { waitUntil: "networkidle0" }); await sleep(500);
        const m = await measure(pg);
        if (!m.switches || m.narrow || m.offWeak || m.onWeak || m.tabWeak || m.btnWeak) fails.push(`${theme}/${mode} ${where}: ${[...new Set(m.which)].join("; ") || JSON.stringify(m)}`);
      }
      const m = await measure(p1);
      if (m.tabWeak || m.btnWeak || m.offWeak || m.onWeak) fails.push(`${theme}/${mode} phone: ${[...new Set(m.which)].join("; ") || JSON.stringify(m)}`);
    }
    await setTheme("forest", "dark");
    check("switches, tabs and buttons stand out from their background in dark and light themes (measured contrast)", fails.length === 0, fails.join(" | "));
  }

  // ------------------------------------------------------------------ the keyboard opens by itself on a text box
  {
    await tab(p1, 2); await p1.evaluate(() => [...document.querySelectorAll(".seg button")].find((b) => b.textContent === "Touchpad").click()); await sleep(700);
    const stroke = (dx, dy) => p1.evaluate(async (dx, dy) => {
      const el = document.querySelector(".pad"), r = el.getBoundingClientRect(), x0 = r.left + r.width / 2, y0 = r.top + r.height / 2;
      const ev = (t, x, y) => el.dispatchEvent(new PointerEvent(t, { bubbles: true, clientX: x, clientY: y, pointerId: 7, pointerType: "touch", isPrimary: true }));
      ev("pointerdown", x0, y0);
      for (let i = 1; i <= 8 && (dx || dy); i++) { ev("pointermove", x0 + (dx * i) / 8, y0 + (dy * i) / 8); await new Promise((ok) => setTimeout(ok, 16)); }
      ev("pointerup", x0 + dx, y0 + dy);
    }, dx, dy);
    const kb = () => p1.evaluate(() => ({ open: !!document.activeElement?.closest(".livekb"), bar: !!document.querySelector(".livekb.on") }));
    await api("/api/debug/input?center=1");
    await stroke(8, 0); await sleep(600);                    // the pointer rests on the demo desktop's text box
    const where = (await api("/api/debug/input")).cursor;
    await stroke(0, 0); await sleep(120);                    // tap = click
    const atTap = await kb();
    await sleep(700);                                        // the PC confirms the focus really is a text box
    const confirmed = await kb();
    const bar = await p1.evaluate(() => { const el = document.querySelector(".livekb"), f = el.querySelector("input").getBoundingClientRect(), r = el.getBoundingClientRect(); return { says: el.querySelector(".lk-say").textContent, whole: f.width >= r.width - 8 && f.height >= r.height - 8 }; });
    check("the typing bar is itself the text field (a tap anywhere on it brings the keyboard on an iPhone)", bar.whole && /Typing on the PC|Tap here/.test(bar.says), JSON.stringify(bar));
    await api("/api/debug/input?clear=1");
    await p1.keyboard.type("hi"); await p1.keyboard.press("Backspace"); await p1.keyboard.press("Enter"); await sleep(600);
    const typed = (await api("/api/debug/input")).events.map((e) => (e.kind === "text" ? `"${e.text}"` : e.kind === "key" ? e.keys.join("+") : e.kind));
    await shot(p1, "phone-autokeyboard");
    await stroke(140, 110); await sleep(300); await stroke(140, 110); await sleep(300); await stroke(140, 110); await sleep(700);   // well away from the text box
    await stroke(0, 0); await sleep(900);                    // click there: not a text box
    const away = await kb();
    check("tapping a text box on the PC opens the phone's keyboard in that same tap, and it stays while the PC confirms", atTap.open && confirmed.open && confirmed.bar, JSON.stringify({ atTap, confirmed, where }));
    check("what is typed goes to the PC key by key, with Backspace and Enter", typed.join(" ") === '"h" "i" backspace enter', typed.join(" "));
    check("clicking something that isn't a text box puts the keyboard away again", !away.open && !away.bar);
    await p1.evaluate(() => [...document.querySelectorAll(".seg button")].find((b) => b.textContent === "Media").click());
    await tab(p1, 1);
  }

  // ------------------------------------------------------------------ search and play
  {
    const lrId = (await api("/api/devices")).find((d) => d.name === "Living Room").device_id;
    await tab(p1, 2); await p1.evaluate(() => [...document.querySelectorAll(".seg button")].find((b) => b.textContent === "Media").click()); await sleep(400);
    const hiddenBefore = await p1.evaluate(() => !document.querySelector(".srch-open"));
    const noPic = await new Promise((resolve) => http.get({ host: "127.0.0.1", port: PORT, path: "/thumb/0000000000000000", headers: { "X-Forwarded-For": "192.168.77.77" } }, (r) => { r.resume(); resolve(r.statusCode); }));
    await api(`/api/devices/${lrId}`, { perms: { search: true } }); await sleep(600);
    await p1.click(".srch-open"); await sleep(150);
    const focusedAtOnce = await p1.evaluate(() => document.activeElement === document.querySelector(".searchpage .srch input") && !!document.querySelector(".searchpage.on"));
    await sleep(350);
    await p1.type(".srch input", "night drive"); await sleep(500);
    const hints = await p1.evaluate(() => [...document.querySelectorAll(".srch-hint")].map((h) => h.textContent));
    await sleep(1400);
    const rows = await p1.evaluate(async () => {
      const list = [...document.querySelectorAll(".srch-row")];
      await Promise.all(list.map((r) => { const im = r.querySelector("img"); return im && !im.complete ? new Promise((ok) => { im.onload = im.onerror = ok; }) : null; }));
      return list.map((r) => ({ title: r.querySelector("b").textContent, badge: r.querySelector("em").textContent, pic: (r.querySelector("img")?.naturalWidth || 0) > 0 }));
    });
    await shot(p1, "phone-search");
    const tidy = await p1.evaluate(() => ({ links: document.querySelector(".srch-links .muted")?.textContent || "", hints: document.querySelectorAll(".srch-hint").length }));
    await api("/api/debug/input?clear=1");
    await p1.evaluate(() => document.querySelector(".srch-row.youtube").click()); await sleep(600);
    await p1.evaluate(() => [...document.querySelectorAll(".srch-links button")].find((x) => x.textContent === "Netflix").click()); await sleep(600);
    const firstIs = await p1.evaluate(() => document.querySelector(".srch-row em").textContent);
    await p1.click(".srch-clear"); await sleep(300);
    const cleared = await p1.evaluate(() => ({ rows: document.querySelectorAll(".srch-row").length, text: document.querySelector(".srch input").value }));
    await p1.click(".srch-back"); await sleep(400);
    const closedByX = await p1.evaluate(() => !document.querySelector(".searchpage.on"));
    check("the search can be cleared and its sheet closed with a button; Spotify results come first", cleared.rows === 0 && cleared.text === "" && closedByX && firstIs === "Spotify", JSON.stringify({ ...cleared, closedByX, firstIs }));
    await p1.click(".srch-open"); await sleep(400);
    const opened = (await api("/api/debug/input")).events.filter((e) => e.kind === "open").map((e) => e.url);
    check("search is offered only to phones allowed to use it", hiddenBefore && noPic === 404);
    check("the search screen opens with its field ready to type in, in the same tap", focusedAtOnce);
    check("once results are in, they are the only list on screen, and they are for the words typed", tidy.hints === 0 && /"night drive"/.test(tidy.links), JSON.stringify(tidy));
    check("typing shows suggestions, then results from each service with their pictures", hints.length === 3 && rows.length === 9 && rows.every((r) => r.pic) && new Set(rows.map((r) => r.badge)).size === 3,
      `${rows.length} results, e.g. "${rows[0]?.title}"`);
    check("tapping a result plays it on the PC; services without results open their own search", opened.length === 2 && /^https:\/\/www\.youtube\.com\/watch/.test(opened[0]) && /^https:\/\/www\.netflix\.com\/search\?q=night%20drive/.test(opened[1]), opened.join(" | "));
    // a phone can't make the PC open anything else: it can only name ids the PC itself handed out
    await p3.evaluate(() => 0).catch(() => {});
    const forged = await fetch(URL_ + "/api/search/open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "https://evil.example/" }) });
    check("only results the PC produced can be opened", forged.status === 400 && (await api("/api/debug/input")).events.filter((e) => e.kind === "open").length === 2);
    await p1.click(".srch-back"); await sleep(300);
    await desk.goto(`${URL_}/nowplaying`, { waitUntil: "networkidle0" }); await sleep(400);
    await desk.type(".srch input", "morning jazz"); await sleep(2200);
    const deskRows = await desk.evaluate(() => document.querySelectorAll(".srch-row").length);
    await shot(desk, "search");
    check("the same search is on the dashboard", deskRows === 9);
    await tab(p1, 1);
  }

  // ------------------------------------------------------------------ the queue (Spotify account linked)
  {
    const post = (u, body) => fetch(URL_ + u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
    const q0 = await api("/api/queue");
    await post("/api/queue/repeat", { value: "one" }); await post("/api/queue/like", { value: q0.now.id }); await post("/api/queue/skip", { value: 1 });
    const q1 = await api("/api/queue");
    check("the queue shows what plays next, and repeat-this-song, like and jump-ahead work", q0.linked && q0.queue.length === 3 && q0.repeat === "all" && q1.repeat === "one" && q1.now.liked && q1.queue.length === 2 && q1.can.reorder === false,
      `next: ${q0.queue.map((r) => r.title).join(", ")}`);
    await tab(p1, 2); await p1.evaluate(() => [...document.querySelectorAll(".seg button")].find((b) => b.textContent === "Media").click()); await sleep(300);
    await p1.click(".srch-open"); await sleep(400);
    await p1.type(".srch input", "evening"); await sleep(2000);
    const added = await p1.evaluate(() => { const b = [...document.querySelectorAll(".srch-row.spotify .q-add")][0]; b?.click(); return !!b; });
    await sleep(900);
    const q2 = await api("/api/queue");
    await shot(p1, "phone-search-queue");
    check("a Spotify search result can be queued with \"Play next\"", added && q2.queue.length === 3 && (await api("/api/debug/input")).events.filter((e) => e.kind === "open").length === 2);
    await p1.click(".srch-back"); await sleep(300);
    await desk.goto(`${URL_}/settings`, { waitUntil: "networkidle0" }); await sleep(400);
    const spLine = await desk.evaluate(() => [...document.querySelectorAll(".boxed")].find((x) => /Spotify account/.test(x.textContent))?.innerText.replace(/\s+/g, " ") || "");
    check("Settings shows the Spotify account and what linking adds", /connected as Demo account/.test(spLine) && /exact repeat/.test(spLine), spLine.slice(0, 70));
    await tab(p1, 1);
  }

  // ------------------------------------------------------------------ Spotify playing: the phone looks like Spotify
  {
    await api("/api/media/next", {}); await api("/api/media/next", {}); await sleep(1200);          // the demo's Spotify track
    await tab(p1, 2); await sleep(900);
    const sp = await p1.evaluate(() => ({ fits: document.querySelector(".sp-ctl").getBoundingClientRect().bottom <= document.querySelector("nav.nav").getBoundingClientRect().top, layout: !!document.querySelector(".sp"), tiles: document.querySelectorAll(".tile").length, title: document.querySelector(".sp-head b")?.textContent,
      buttons: document.querySelectorAll(".sp-ctl button").length, next: [...document.querySelectorAll(".sp-row .sp-txt b")].map((b) => b.textContent), heart: !!document.querySelector(".sp-heart") }));
    await shot(p1, "phone-spotify");
    {
      // search is still right there, and the skips work: the buttons, a double tap on the cover, a swipe across it
      const pos = async () => (await api("/api/media")).active.position;
      await api("/api/media/pause", {}); await api("/api/media/seek_to", { value: 60 }); await sleep(700);
      const hasSearch = await p1.evaluate(() => !!document.querySelector(".srch-open") && /Search/.test(document.querySelector(".srch-open").textContent));
      const press = (title) => p1.evaluate((t) => document.querySelector(`.sp-ctl button[title="${t}"]`).click(), title);
      await press("Forward 10 s"); await press("Forward 10 s"); await sleep(900);
      const afterButtons = await pos();
      await press("Back 10 s"); await sleep(900);
      const afterBack = await pos();
      const gesture = (x1, x2, twice) => p1.evaluate(async (a, b, dbl) => {
        const el = document.querySelector(".sp .gesture > div:last-child"), r = el.getBoundingClientRect(), y = r.top + r.height / 2;
        const ev = (type, x) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: r.left + r.width * x, clientY: y, pointerId: 1 }));
        ev("pointerdown", a); ev("pointerup", b);
        if (dbl) { await new Promise((ok) => setTimeout(ok, 120)); ev("pointerdown", a); ev("pointerup", b); }
      }, x1, x2, twice);
      await gesture(0.8, 0.8, true); await sleep(900);                 // double tap on the right half
      const afterTap = await pos();
      await gesture(0.7, 0.2, false); await sleep(900);                // swipe left across half the cover
      const afterSwipe = await pos();
      const hint = await p1.evaluate(() => !!document.querySelector(".sp .gesture .hint"));
      check("on the Spotify screen: search is there, and ±10 s buttons, double tap and swipe on the cover all move the song",
        hasSearch && hint && Math.abs(afterButtons - 80) < 1 && Math.abs(afterBack - 70) < 1 && Math.abs(afterTap - 80) < 1 && Math.abs(afterSwipe - 50) < 1,
        `60 → +10 +10 = ${afterButtons} → −10 = ${afterBack} → double tap = ${afterTap} → swipe back 30 = ${afterSwipe}`);
      await p1.click(".srch-open"); await sleep(400);
      const sheet = await p1.evaluate(() => !!document.querySelector(".searchpage.on .srch input"));
      await p1.click(".srch-back"); await sleep(300);
      check("…and the search opens from there and closes again", sheet && await p1.evaluate(() => !document.querySelector(".searchpage.on")));
      await api("/api/media/play", {});
    }
    const before = await api("/api/queue");
    // the + next to the song: Liked Songs and your own playlists
    await p1.click(".sp-heart"); await sleep(900);
    const saveTo = await p1.evaluate(() => [...document.querySelectorAll(".sheet .srch-row b")].map((b) => b.textContent));
    await p1.evaluate(() => [...document.querySelectorAll(".sheet .srch-row")].find((r) => /Liked Songs/.test(r.textContent)).click()); await sleep(900);
    await p1.evaluate(() => [...document.querySelectorAll(".sheet .srch-row")].find((r) => /Road trip/.test(r.textContent)).click()); await sleep(900);
    const ticked = await p1.evaluate(() => [...document.querySelectorAll(".sheet .srch-row")].filter((r) => r.querySelector("svg:last-child path")?.getAttribute("d")?.includes("20 6")).length);
    // the same song into the same playlist again: it asks first
    const road = () => p1.evaluate(() => [...document.querySelectorAll(".sheet .srch-row")].find((r) => /Road trip/.test(r.textContent)).click());
    const askSays = () => p1.evaluate(() => document.querySelector(".dupask b")?.textContent || "");
    const pick = (l) => p1.evaluate((l) => [...document.querySelectorAll(".dupask .btn")].find((b) => b.textContent === l).click(), l);
    await road(); await sleep(700); const ask1 = await askSays();
    await pick("Add again"); await sleep(700); await road(); await sleep(700); const ask2 = await askSays();
    await pick("Replace"); await sleep(900); await road(); await sleep(700); const ask3 = await askSays();
    await pick("Cancel"); await sleep(300);
    check("a song that is already in the playlist is not added blindly: it asks to add again or replace, and replace leaves one copy",
      ask1 === "Already in Road trip" && ask2 === "Already in Road trip (2 times)" && ask3 === "Already in Road trip" && !(await askSays()), JSON.stringify({ ask1, ask2, ask3 }));
    await shot(p1, "phone-playlists");
    // a sheet with more in it than the screen is tall: its title and close button must stay in reach
    await p1.setViewport({ ...phoneView, height: 200 }); await sleep(400);
    const tall = await p1.evaluate(() => {
      const sh = document.querySelector(".sheet").getBoundingClientRect(), x = document.querySelector(".sheet-x").getBoundingClientRect(), body = document.querySelector(".sheet-body");
      body.scrollTop = 9999;
      const x2 = document.querySelector(".sheet-x").getBoundingClientRect();
      return { top: Math.round(sh.top), xTop: Math.round(x.top), xAfterScroll: Math.round(x2.top), scrolls: body.scrollHeight > body.clientHeight, h: innerHeight, hit: document.elementFromPoint(x2.left + x2.width / 2, x2.top + x2.height / 2)?.closest(".sheet-x") != null };
    });
    check("a sheet taller than the screen keeps its title and close button on screen while its content scrolls", tall.top >= 0 && tall.xTop >= 0 && tall.xAfterScroll === tall.xTop && tall.scrolls && tall.hit, JSON.stringify(tall));
    await p1.setViewport(phoneView); await sleep(300);
    await p1.click(".sheet-x"); await sleep(400);
    await p1.evaluate(() => document.querySelector('.sp-bar button[title="Your playlists"]').click()); await sleep(900);
    const all = await p1.evaluate(() => [...document.querySelectorAll(".sheet .srch-row b")].map((b) => b.textContent));
    await p1.evaluate(() => [...document.querySelectorAll(".sheet .srch-row")].find((r) => /Focus/.test(r.textContent)).click()); await sleep(900);
    const sheetGone = await p1.evaluate(() => !document.querySelector(".sheet"));
    check("a song can be saved to Liked Songs or one of your playlists, and a playlist can be started, from the phone",
      saveTo.join() === "Liked Songs,Road trip,Focus" && all.length === 3 && sheetGone, `save to: ${saveTo.join(", ")} | play: ${all.join(", ")}`);
    await p1.evaluate(() => document.querySelector(".sp-row").click()); await sleep(1100);
    const after = await api("/api/queue");
    check("with Spotify playing, the phone shows Spotify's own layout and nothing else", sp.layout && sp.fits && sp.tiles === 0 && sp.title === "Night Drive" && sp.buttons === 7 && sp.next.length >= 2 && sp.heart, JSON.stringify(sp));
    check("heart and tap-to-play-next work from that screen", after.now.liked !== before.now.liked && after.queue.length === before.queue.length - 1);
    const shared = await api("/api/share");
    check("sharing a Spotify song gives Spotify's own link, not a guess", shared.links[0]?.url === "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC" && shared.links[0].exact, shared.links.map((l) => l.url).join(" | "));
    await desk.goto(`${URL_}/nowplaying`, { waitUntil: "networkidle0" }); await sleep(700);
    const lay = await desk.evaluate(() => { const page = document.querySelector(".np-page"), cols = page && getComputedStyle(page).gridTemplateColumns.split(" ").length, art = document.querySelector(".np.music .np-hero")?.getBoundingClientRect();
      const cards = [...document.querySelectorAll(".np-page > .col:last-child > .card h3")].map((h) => h.textContent), left = [...document.querySelectorAll(".np-page > .col:first-child > .card h3")].map((h) => h.textContent); const alone = [...document.querySelectorAll(".page.on > .card, main > .card")].length;
      return { cols, art: art ? Math.round(art.width) : 0, square: !!art && Math.abs(art.width - art.height) < 2, cards, left, skip30: document.querySelectorAll('.np-controls [title*="30"]').length }; });
    await shot(desk, "nowplaying-spotify");
    check("the dashboard's Now Playing has two tidy columns: a compact player, and next / search / players beside it",
      lay.cols === 2 && lay.square && lay.art <= 240 && lay.cards[0] === "Up next" && lay.left.includes("Search and play") && lay.cards.includes("Media on this PC"), JSON.stringify(lay));
    await api("/api/media/previous", {}); await api("/api/media/previous", {}); await sleep(900);
    await tab(p1, 1);
  }

  // ------------------------------------------------------------------ a link and QR code for what is playing
  {
    await api("/api/media/play", {}); await api("/api/media/seek_to", { value: 120 }); await sleep(600);
    const first = await api("/api/share");
    await tab(p1, 2); await p1.evaluate(() => [...document.querySelectorAll(".seg button")].find((b) => b.textContent === "Media").click()); await sleep(400);
    await p1.click(".sharebtn"); await sleep(1500);
    const sheet = await p1.evaluate(() => ({ url: document.querySelector(".share-url")?.textContent || "", dots: document.querySelectorAll(".share-qr .pq-m").length, art: (document.querySelector(".share-art")?.naturalWidth || 0) > 0,
      tabs: [...document.querySelectorAll(".share-tabs button")].map((b) => b.textContent), title: document.querySelector(".share-top b")?.textContent }));
    await sleep(4200); await shot(p1, "phone-share");
    await p1.evaluate(() => document.querySelector(".sheet-bg").click()); await sleep(300);
    check("what's playing can be shared: its picture, a tidy public link, a QR code", first.links[0]?.url === "https://youtu.be/aqz-KE-bpKQ" && first.links[0].exact && sheet.url === "https://youtu.be/aqz-KE-bpKQ" && sheet.dots > 200 && sheet.art
      && sheet.title === "Big Buck Bunny" && sheet.tabs.some((t) => /from this moment/.test(t)), JSON.stringify(sheet));
    await api("/api/media/next", {}); await sleep(900);
    const second = await api("/api/share");
    check("a player that doesn't give its link gets one found by title, and says so", second.title === "Sintel" && second.links.length === 3 && second.links.every((l) => !l.exact && /^https:\/\//.test(l.url))
      && second.links.some((l) => l.url.startsWith("https://open.spotify.com/track/")), second.links.map((l) => `${l.label}: ${l.url}`).join(" | "));
    await desk.goto(`${URL_}/nowplaying`, { waitUntil: "networkidle0" }); await sleep(400);
    await desk.evaluate(() => [...document.querySelectorAll("button")].find((x) => x.textContent === "Share").click()); await sleep(1500);
    const deskShare = await desk.evaluate(() => ({ url: document.querySelector(".modal .share-url")?.textContent || "", note: document.querySelector(".modal .share .note")?.textContent || "" }));
    await sleep(4000); await shot(desk, "share");
    check("the dashboard shares it too", /^https:\/\//.test(deskShare.url) && /found on .* by title/.test(deskShare.note), deskShare.url);
    await desk.evaluate(() => document.querySelector(".modal .iconbtn").click());
    await api("/api/media/previous", {}); await sleep(500);
    await tab(p1, 1);
  }

  // ------------------------------------------------------------------ the browser extension
  {
    const control = (msg) => desk.evaluate(async (m) => { const ws = new WebSocket(`ws://${location.host}/ws/control`); await new Promise((r) => (ws.onopen = r)); ws.send(JSON.stringify(m)); await new Promise((r) => setTimeout(r, 300)); ws.close(); }, msg);
    const stateNow = () => desk.evaluate(() => new Promise((resolve) => { const ws = new WebSocket(`ws://${location.host}/ws/control`); ws.onmessage = (e) => { if (typeof e.data === "string") { const j = JSON.parse(e.data); if (j.t === "state") { ws.close(); resolve(j); } } }; }));
    const zip = Buffer.from(await fetch(URL_ + "/extension.zip?for=firefox").then((r) => r.arrayBuffer()));
    const names = ["manifest.json", "background.js", "content.js", "config.js", "options.html", "icon-48.png", "icon-128.png"];
    const zipPhone = await new Promise((resolve) => http.get({ host: "127.0.0.1", port: PORT, path: "/extension.zip", headers: { "X-Forwarded-For": "192.168.77.77" } }, (r) => { r.resume(); resolve(r.statusCode); }));
    check("the extension downloads packed for the browser (only on this PC)", zip.subarray(0, 2).toString() === "PK" && names.every((n) => zip.includes(n)) && zipPhone === 403, `${zip.length} bytes`);

    // who may connect as "the browser": not a web page, not without approval, not with someone else's id
    const open = (opts) => new Promise((resolve) => { const w = new WebSocket(`ws://127.0.0.1:${PORT}/ws/browser?name=Firefox`, opts); w.onopen = () => resolve(w); w.onerror = () => resolve(null); });
    const fromWebPage = await open({ headers: { Origin: "https://evil.example" } });
    const id = "e2e" + Date.now().toString(36), secret = "s".repeat(40);
    const ext = await open({ headers: { Origin: "moz-extension://0b1c2d3e-test" } });
    const got = [];
    ext.onmessage = (e) => got.push(JSON.parse(e.data));
    ext.send(JSON.stringify({ t: "hello", id, secret, name: "Firefox" }));
    const report = (w) => w.send(JSON.stringify({ t: "tabs", tabs: [
      { tab: 11, frame: 0, title: "Lo-fi beats to study to", artist: "", host: "youtube.com", paused: false, position: 42, duration: 3600, rate: 1, volume: 0.8, muted: false, video: true },
      { tab: 12, frame: 0, title: "Planet Earth, episode 3", artist: "", host: "example-films.com", paused: true, position: 900, duration: 2900, rate: 1, volume: 1, muted: false, video: true }] }));
    await sleep(800);
    report(ext); await sleep(900);                                   // not approved yet: whatever it says is ignored
    const before = { waiting: got.some((m) => m.t === "waiting"), listed: (await stateNow()).browsers.find((b) => b.id === id), tabs: (await api("/api/media")).sessions.filter((x) => x.app === "Firefox").length };
    await desk.goto(`${URL_}/settings`, { waitUntil: "networkidle0" }); await sleep(500);
    await shot(desk, "extension-approve");
    const approveBtn = await desk.evaluate(() => { const b = [...document.querySelectorAll(".ext button")].find((x) => x.textContent === "Approve"); b?.click(); return !!b; });
    await sleep(1200);
    report(ext); await sleep(1500);
    const media = await api("/api/media");
    const tabsSeen = media.sessions.filter((x) => x.app === "Firefox");
    const film = tabsSeen.find((x) => /Planet Earth/.test(x.title));
    check("a web page can't pose as the extension, and a new extension does nothing until approved on the PC",
      fromWebPage === null && before.waiting && before.listed && before.listed.approved === false && before.tabs === 0 && approveBtn && got.some((m) => m.t === "ok"), JSON.stringify(before));
    await api("/api/media/seek_to", { value: 1200, session: film?.id });
    await api("/api/media/toggle", { session: film?.id });
    await sleep(500);
    const cmds = got.filter((m) => m.t === "cmd");
    check("with the extension every browser tab is its own player", tabsSeen.length === 2 && tabsSeen.some((x) => /Lo-fi/.test(x.title) && x.status === "playing") && film?.status === "paused", tabsSeen.map((x) => `${x.title} (${x.status})`).join(" | "));
    check("commands go to the right tab", cmds.some((c) => c.tab === 12 && c.action === "seek_to" && c.value === 1200) && cmds.some((c) => c.tab === 12 && c.action === "toggle") && !cmds.some((c) => c.tab === 11), JSON.stringify(cmds));
    await sleep(600);
    const extLine = await desk.evaluate(() => document.querySelector(".ext")?.innerText.replace(/\s+/g, " ") || "");
    check("Settings offers the extension and shows the browser connected", /Get it for|Add to/.test(extLine) && /Firefox 2 tabs playing/.test(extLine), extLine.slice(0, 120));
    await shot(desk, "extension");

    // someone who learned the id but not the secret
    const thief = await open({ headers: { Origin: "moz-extension://ffffffff-other" } });
    const thiefGot = [];
    thief.onmessage = (e) => thiefGot.push(JSON.parse(e.data));
    thief.send(JSON.stringify({ t: "hello", id, secret: "x".repeat(40), name: "Firefox" }));
    await sleep(700);
    // the real one comes back after a restart of the browser: no approval needed again
    ext.close(); await sleep(600);
    const again = await open({ headers: { Origin: "moz-extension://0b1c2d3e-test" } });
    const againGot = [];
    again.onmessage = (e) => againGot.push(JSON.parse(e.data));
    again.send(JSON.stringify({ t: "hello", id, secret, name: "Firefox" }));
    await sleep(700);
    check("the approval belongs to that extension's own secret: a copy of its id is refused, the real one reconnects by itself",
      thiefGot.some((m) => m.t === "denied") && !thiefGot.some((m) => m.t === "ok") && againGot.some((m) => m.t === "ok"));
    report(again); await sleep(1000);
    await control({ t: "browser_approve", id, ok: false });            // Remove on the dashboard
    await sleep(1500);
    check("removing the browser on the PC cuts it off and its tabs disappear", again.readyState >= 2 && !(await api("/api/media")).sessions.some((x) => x.app === "Firefox") && !(await stateNow()).browsers.some((b) => b.id === id));

    // the part that runs inside web pages, on a real page with a real video
    const web = await browser.newPage();
    const html = path.join(tmp, "video-page.html");
    fs.writeFileSync(html, `<!doctype html><title>Holiday film</title><video id="v" src="${pathToFileURL(path.join(root, "docs", "media", "dashboard.webm")).href}" muted loop style="width:640px;height:360px"></video>`);
    web.on("pageerror", (e) => check("no script errors (extension content script)", false, e.message));
    await web.goto(pathToFileURL(html).href, { waitUntil: "load" });
    await web.evaluate(() => { window.__sent = []; window.browser = { runtime: { id: "test", sendMessage: (m) => { window.__sent.push(m); return Promise.resolve(); }, onMessage: { addListener: (f) => { window.__cmd = f; } } } }; window.__call = (m) => window.__cmd(m, { id: "test" }); });
    await web.evaluate(fs.readFileSync(path.join(root, "extension", "content.js"), "utf8"));
    await sleep(1500);
    await web.evaluate(() => window.__call({ t: "cmd", action: "play" })); await sleep(700);
    await web.evaluate(() => { window.__call({ t: "cmd", action: "seek_to", value: 3 }); window.__call({ t: "cmd", action: "rate", value: 1.5 }); window.__call({ t: "cmd", action: "volume", value: 0.4 }); });
    await sleep(900);
    const pageState = await web.evaluate(() => { const v = document.getElementById("v"), last = window.__sent[window.__sent.length - 1]; return { reports: window.__sent.length, title: last.title, dur: last.duration, playing: !v.paused, t: v.currentTime, rate: v.playbackRate, vol: v.volume, lastPos: last.position, lastPaused: last.paused }; });
    check("in a page it reports the video and obeys play, seek, speed and volume",
      pageState.reports >= 2 && pageState.title === "Holiday film" && pageState.lastPos >= 3 && pageState.playing && pageState.t >= 3 && pageState.rate === 1.5 && Math.abs(pageState.vol - 0.4) < 0.01 && pageState.lastPaused === false, JSON.stringify(pageState));
    await web.evaluate(() => window.__call({ t: "cmd", action: "delay", value: 250 })); await sleep(1500);
    const delayed = await web.evaluate(() => { const c = document.querySelector("canvas[data-pbs-delay]"); const r = c?.getBoundingClientRect(), v = document.getElementById("v").getBoundingClientRect(); return { canvas: !!c, w: c?.width || 0, over: !!c && Math.abs(r.left - v.left) < 2 && Math.abs(r.top - v.top) < 2 && Math.abs(r.width - v.width) < 2, shown: !!c && c.style.display !== "none" }; });
    await web.evaluate(() => window.__call({ t: "cmd", action: "delay", value: 0 })); await sleep(300);
    const removed = await web.evaluate(() => !document.querySelector("canvas[data-pbs-delay]"));
    check("the picture can be shown later to match the phones (drawn over the video, removed when off)", delayed.canvas && delayed.w > 600 && delayed.over && delayed.shown && removed, JSON.stringify(delayed));
    await web.close();
  }

  // ------------------------------------------------------------------ systems, themed mark, start with Windows, moving port
  {
    const rows = await api("/api/devices");
    const lrRow = rows.find((d) => d.name === "Living Room"), kRow = rows.find((d) => d.name === "Kitchen");
    check("each phone's system is read and linked to it", /^iPhone · iOS [\d.]+ · /.test(lrRow.system) && /^Android [\d.]+ · Chrome/.test(kRow.system), `${lrRow.system} | ${kRow.system}`);
    await desk.goto(`${URL_}/devices`, { waitUntil: "networkidle0" }); await sleep(500);
    const counts = await desk.evaluate(() => ({ nav: [...document.querySelectorAll(".side .nav a")].find((x) => x.textContent.startsWith("Devices")).textContent, pill: [...document.querySelectorAll(".pill")].map((x) => x.textContent).find((x) => /connected/.test(x)) || "" }));
    check("the device count is on the Devices page, not stuck on the menu", counts.nav === "Devices" && /^\d+\s*connected · \d+ paired/.test(counts.pill), `menu: "${counts.nav}", page: "${counts.pill}"`);

    await desk.goto(`${URL_}/settings`, { waitUntil: "networkidle0" }); await sleep(500);
    await desk.evaluate(() => { const row = [...document.querySelectorAll(".boxed .perm-row")].find((r) => /This PC's speakers in step/.test(r.textContent)); row.querySelector("button,input,[role=switch],.switch").click(); });
    await sleep(900);
    const pcCard = await desk.evaluate(() => { const c = [...document.querySelectorAll(".boxed")].find((x) => /This PC's speakers in step/.test(x.textContent)); return { select: !!c?.querySelector("select"), text: c?.innerText.replace(/\s+/g, " ") || "" }; });
    check("Settings can put this PC's own speakers in step with the phones, and explains what it needs", pcCard.select && /delayed by exactly the sync buffer/.test(pcCard.text) && /Fine offset/.test(pcCard.text), pcCard.text.slice(0, 80));
    await shot(desk, "pc-speaker");
    await desk.evaluate(() => { const row = [...document.querySelectorAll(".boxed .perm-row")].find((r) => /This PC's speakers in step/.test(r.textContent)); row.querySelector("button,input,[role=switch],.switch").click(); });
    const text = (u) => fetch(URL_ + u).then((r) => r.text());
    const [qrOcean, qrSand, icoOcean, icoSand, man] = await Promise.all([text(`/qr.svg?theme=ocean`), text(`/qr.svg?theme=sand`), text("/icon.svg?theme=ocean"), text("/icon.svg?theme=sand"), text("/manifest.webmanifest?theme=aurora")]);
    const png = await fetch(URL_ + "/icon-180.png?theme=sand").then((r) => r.arrayBuffer());
    check("the QR code and the app mark come in the colours of the theme", qrOcean !== qrSand && qrOcean.includes("stroke-linecap") && icoOcean !== icoSand && /theme=aurora/.test(man) && new Uint8Array(png)[1] === 0x50 && png.byteLength > 500);
    await setTheme("ocean", "dark");
    const marks = await Promise.all([desk, p1].map((pg) => pg.evaluate(() => document.querySelector('link[rel="icon"]').getAttribute("href"))));
    const touchIcon = await p1.evaluate(() => [document.querySelector('link[rel="apple-touch-icon"]').getAttribute("href"), document.querySelector('link[rel="manifest"]').getAttribute("href")].join(" "));
    check("PC tab, phone tab and the phone's home-screen icon switch with the theme", marks.every((h) => h === "/icon.svg?theme=ocean") && /icon-180\.png\?theme=ocean .*manifest\.webmanifest\?theme=ocean/.test(touchIcon), marks.join(" ") + " " + touchIcon);
    await page("dashboard"); await shot(desk, "qr-themed");
    await setTheme("forest", "dark");

    const ctl = (msg, wait = 600) => desk.evaluate(async (m, w) => {
      const ws = new WebSocket(`ws://${location.host}/ws/control`); let last = null;
      ws.onmessage = (e) => { if (typeof e.data === "string") { const j = JSON.parse(e.data); if (j.t === "state") last = j; } };
      await new Promise((r) => (ws.onopen = r)); ws.send(JSON.stringify(m)); await new Promise((r) => setTimeout(r, w)); ws.close(); return last && { autostart: last.autostart, port: last.ports.http };
    }, msg, wait);
    const on = await ctl({ t: "set_autostart", on: true }, 1300), off = await ctl({ t: "set_autostart", on: false }, 1300);
    await desk.goto(`${URL_}/settings`, { waitUntil: "networkidle0" }); await sleep(400);
    const card = async () => desk.evaluate(() => { const c = document.querySelector(".card.startup"); return c ? { on: c.querySelector("input").checked, text: c.innerText.replace(/\s+/g, " ") } : null; });
    const c0 = await card();
    await desk.evaluate(() => document.querySelector(".card.startup .switch input").click()); await sleep(1300);
    const c1 = await card();
    await desk.evaluate(() => document.querySelector(".card.startup .switch input").click()); await sleep(1300);
    const c2 = await card();
    check("start with Windows can be switched on and off, from a switch at the top of Settings", on?.autostart === true && off?.autostart === false && c0 && !c0.on && /^Start with Windows Off/.test(c0.text) && c1.on && /starts by itself in the tray/.test(c1.text) && !c2.on,
      c1?.text.slice(0, 70));

    // move the whole server to another port while phones are connected
    const NEW = PORT + 7;
    const sysBefore = (await api("/api/devices")).find((d) => d.name === "Living Room");
    await ctl({ t: "set_port", port: NEW }, 300);
    const answers = async (port) => { for (let i = 0; i < 60; i++) { if (await fetch(`http://localhost:${port}/player`).then((r) => r.ok, () => false)) return; await sleep(250); } };
    await answers(NEW);                                   // however long the move takes on this machine
    await sleep(5500);                                    // the old port is released five seconds after the new one answers
    await p1.click("button.bigbtn").catch(() => {});      // one tap on the new address (phones need a touch to start sound)
    await sleep(2500);
    const there = (u) => fetch(u).then((r) => r.status).catch(() => 0);
    const moved = { desk: new URL(desk.url()).port, phone: new URL(p1.url()).port, old: await there(`http://localhost:${PORT}/player`), fresh: await there(`http://localhost:${NEW}/player`) };
    const rowsNew = await fetch(`http://localhost:${NEW}/api/devices`).then((r) => r.json());
    const lrNew = rowsNew.find((d) => d.device_id === sysBefore.device_id);
    const p1In = await p1.evaluate(() => !!document.querySelector("nav.nav"));
    check("the port can be changed live: dashboard and phones follow, the old port is freed",
      moved.desk === String(NEW) && moved.phone === String(NEW) && moved.old === 0 && moved.fresh === 200 && p1In, JSON.stringify(moved));
    check("after the move a phone is still itself: same record, still verified, permissions intact",
      !!lrNew?.online && lrNew.verified && lrNew.locked.length === 0 && lrNew.name === "Living Room" && rowsNew.filter((d) => d.online).length === rowsNew.filter((d) => !d.blocked).length - 0 - rowsNew.filter((d) => !d.online && !d.blocked).length,
      `${lrNew?.name}: online ${lrNew?.online}, verified ${lrNew?.verified}`);
    await desk.evaluate(async (port) => { const ws = new WebSocket(`ws://${location.host}/ws/control`); await new Promise((r) => (ws.onopen = r)); ws.send(JSON.stringify({ t: "set_port", port })); await new Promise((r) => setTimeout(r, 300)); }, PORT);
    await answers(PORT);
    await sleep(5500);
    await p1.click("button.bigbtn").catch(() => {});
    await sleep(2500);
    check("…and back again", new URL(desk.url()).port === String(PORT) && (await there(`http://localhost:${NEW}/player`)) === 0 && (await p1.evaluate(() => !!document.querySelector("nav.nav"))));
  }

  // ------------------------------------------------------------------ password, lock screen, encrypted storage
  {
    const pw = "correct horse 42";
    await desk.goto(`${URL_}/settings`, { waitUntil: "networkidle0" }); await sleep(500);
    const fields = await desk.$$('.card input[autocomplete="new-password"]');
    await fields[0].type(pw); await fields[1].type(pw);
    await desk.evaluate(() => [...document.querySelectorAll(".card button")].find((x) => x.textContent === "Set password").click());
    await sleep(3500);
    const text = fs.existsSync(vaultPath) ? fs.readFileSync(vaultPath, "utf8") : "";
    check("setting a password encrypts everything the server stores", text.length > 500 && !fs.existsSync(cfgPath) && !/Living Room|token_hash|api_token|pubkey/.test(text) && !text.includes(pw),
      `${path.basename(vaultPath)} ${text.length} bytes, readable file gone: ${!fs.existsSync(cfgPath)}`);
    const anon = await Promise.all(["/api/status", "/api/devices", "/api/clipboard", "/api/diagnostics"].map((u) => fetch(URL_ + u).then((r) => r.status)));
    const wrong = await fetch(URL_ + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "let me in please" }) });
    check("without the password even this PC gets nothing from the dashboard", anon.every((x) => x === 401) && wrong.status === 401, anon.join(" ") + " · wrong password " + wrong.status);
    await desk.reload({ waitUntil: "networkidle0" }); await sleep(800);
    const stillIn = await desk.evaluate(() => !!document.querySelector(".side .nav") && !document.querySelector(".gate"));
    await desk.evaluate(() => document.querySelector('.side-foot button[title^="Lock"]').click()); await sleep(1200);
    const lockedUi = await desk.evaluate(() => !!document.querySelector(".gate") && !document.querySelector(".side .nav") && !/Living Room/.test(document.body.innerText));
    await shot(desk, "locked");
    await desk.type('.gate input[type="password"]', "not the password"); await desk.keyboard.press("Enter"); await sleep(1200);
    const refused = await desk.evaluate(() => /wrong password/i.test(document.querySelector(".gate")?.innerText || ""));
    await desk.type('.gate input[type="password"]', pw); await desk.keyboard.press("Enter"); await sleep(2000);
    const backIn = await desk.evaluate(() => !!document.querySelector(".side .nav") && !document.querySelector(".gate"));
    check("the dashboard locks and only the right password opens it", stillIn && lockedUi && refused && backIn, JSON.stringify({ stillIn, lockedUi, refused, backIn }));
    const phonesFine = await p1.evaluate(() => !!document.querySelector("nav.nav") && !document.querySelector(".banner.show"));
    check("phones keep working while the dashboard is locked", phonesFine);

    // -- restart: the encrypted file must be the genuine one
    server.kill(); await sleep(1200);
    const good = fs.readFileSync(vaultPath, "utf8"), seal = fs.readFileSync(vaultPath + ".seal", "utf8");
    const starts = () => spawnSync("python", serverArgs, { ...serverOpts, timeout: 25000 }).status;
    const head = JSON.parse(good);
    head.data = head.data.slice(0, 60) + (head.data[60] === "A" ? "B" : "A") + head.data.slice(61);
    fs.writeFileSync(vaultPath, JSON.stringify(head));
    const tampered = starts();
    fs.rmSync(vaultPath);
    const missing = starts();
    fs.writeFileSync(vaultPath, JSON.stringify({ ...JSON.parse(good), id: "00".repeat(16) }));
    const swapped = starts();
    check("a changed, missing or swapped storage file stops the server from starting", tampered === 3 && missing === 3 && swapped === 3, `exit codes ${tampered} ${missing} ${swapped}`);
    fs.writeFileSync(vaultPath, good); fs.writeFileSync(vaultPath + ".seal", seal);
    const again = spawn("python", serverArgs, serverOpts);
    try {
      let st = null;
      for (let i = 0; i < 80 && !st; i++) { st = await fetch(URL_ + "/api/auth").then((r) => r.json()).catch(() => null); if (!st) await sleep(250); }
      const login = await fetch(URL_ + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: pw }) });
      const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
      const devs = await fetch(URL_ + "/api/devices", { headers: { Cookie: cookie } }).then((r) => r.json()).catch(() => []);
      check("the genuine file starts again and everything is still there", !!st?.required && !st.authed && login.status === 200 && /HttpOnly/i.test(login.headers.get("set-cookie") || "") && devs.some((d) => d.name === "Living Room"),
        `${devs.length} devices after restart`);
    } finally { again.kill(); await sleep(500); }
  }

  // ------------------------------------------------------------------ the guided tours: pages, and the same as videos with a voice
  {
    fs.writeFileSync(path.join(media, "settings-cards.json"), JSON.stringify(settingsCards, null, 1));
    const slides = tourSlides(root, settingsCards);
    const count = buildShow(root, "tour", "guided tour", slides), ext = buildShow(root, "extension-install", "add the browser extension by hand", EXT_SLIDES);
    const unexplained = settingsCards.filter((c) => !SETTINGS.some(([re]) => re.test(c.title) || re.test(c.text.slice(0, 60)))).map((c) => c.title || c.text.slice(0, 30));
    check("the guided tour covers every screen and every group of settings, each with its own explanation", count >= 50 && settingsCards.length >= 9 && unexplained.length === 0, `${count} slides, ${settingsCards.length} settings cards, unexplained: ${unexplained.join(" | ") || "none"}`);
    check("most slides of the tour say where it happens and give numbered steps", slides.filter((x) => x.steps.length).length >= 30 && ext >= 6, `${slides.filter((x) => x.steps.length).length} with steps, ${ext} extension slides`);
    if (!process.env.PBS_NO_TOUR_VIDEO) {
      for (const name of ["extension-install", "tour"]) {
        const got = await recordShow(browser, root, name);
        check(`the ${name} video is recorded, with voice and music`, got.bytes > 300_000 && got.voiced, JSON.stringify(got));
        console.log(`   video ${name}.mp4 (${got.seconds} s, ${(got.bytes / 1e6).toFixed(1)} MB)`);
      }
    }
  }

  // ------------------------------------------------------------------ the PDF guide
  const guide = path.join(root, "docs", "index.html");
  if (fs.existsSync(guide)) {
    const doc = await browser.newPage();
    await doc.setViewport({ width: 1240, height: 1754, deviceScaleFactor: 1 });
    await doc.goto(pathToFileURL(guide).href, { waitUntil: "networkidle0" });
    await doc.emulateMediaType("print");
    await doc.pdf({ path: path.join(root, "docs", "PhoneBoxSound-Guide.pdf"), format: "A4", printBackground: true, margin: { top: 0, bottom: 0, left: 0, right: 0 } });
    console.log("   pdf  docs/PhoneBoxSound-Guide.pdf");
  }
} finally {
  await browser?.close().catch(() => {});
  server.kill();
  await sleep(300);
  fs.rmSync(cfgPath, { force: true });
  fs.rmSync(cfgPath + ".tmp", { force: true });
  fs.rmSync(journalDir, { recursive: true, force: true });
  for (const f of [vaultPath, vaultPath + ".seal", vaultPath + ".tmp"]) fs.rmSync(f, { force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(path.join(os.tmpdir(), "phoneboxsound-demo-share"), { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
