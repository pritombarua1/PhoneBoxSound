// Screen mode: one phone takes the screen; the others must pause (get no sound) and play again when it ends.
//
//   node scripts/screenmode.mjs
//
// Two phones join a demo PhoneBoxSound. Phone A gets Screen view and Manage speakers and turns on Screen
// mode; phone B is a normal speaker. Checks: A keeps playing with a shorter buffer and gets the screen as
// video (when the video helper is installed) or pictures; B stops receiving sound and says why; a second
// phone asking for the screen is turned away; when A switches the screen off, B plays again.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";

const root = path.resolve(import.meta.dirname, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((ok) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const chrome = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome"].find((p) => p && fs.existsSync(p));
const port = await freePort(), tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbs-mode-"));
const server = spawn("python", ["-m", "phoneboxsound", "--demo", "--port", String(port), "--https-port", String(await freePort()), "--no-mdns", "--no-tray", "--no-browser",
  "--config", path.join(tmp, "config.json")], { cwd: root, env: { ...process.env, PHONEBOXSOUND_SEAL: "file", PHONEBOXSOUND_DEMO_VIDEO: "1" }, stdio: "ignore" });
const URL_ = `http://127.0.0.1:${port}`;
const api = (p, body) => fetch(URL_ + p, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? "  " + detail : ""}`); };
let browser;
try {
  for (let i = 0; ; i++) { try { await api("/api/status"); break; } catch { if (i > 100) throw new Error("server did not start"); await sleep(200); } }
  await api("/api/settings", { approval: false });
  const { code } = await api("/api/status");
  browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"] });
  const join = async (name) => {
    const page = await (await browser.createBrowserContext()).newPage();
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await page.goto(`${URL_}/player?code=${code}`, { waitUntil: "networkidle0" });
    await page.type('input[placeholder]:not(.code)', name); await page.click("button.bigbtn");
    await page.waitForSelector("nav.nav", { timeout: 8000 });
    await page.waitForFunction(() => window.__pbsAudio?.stats.played > 30, { timeout: 20000 });
    return page;
  };
  const A = await join("Phone A"), B = await join("Phone B"), C = await join("Phone C");
  const devs = await api("/api/devices");
  const id = (n) => devs.find((d) => d.name === n).device_id;
  await api(`/api/devices/${id("Phone A")}`, { perms: { screen: true, manage: true, input: true } });
  await api(`/api/devices/${id("Phone C")}`, { perms: { screen: true, input: true } });
  await sleep(800);
  const played = (p) => p.evaluate(() => window.__pbsAudio.stats.played);
  const openScreen = async (p, exclusive) => {
    await p.evaluate((x) => { localStorage.setItem("pbs.screenmode", x ? "1" : "0"); localStorage.setItem("pbs.view", "screen"); }, exclusive);
    await p.reload({ waitUntil: "networkidle0" });
    await p.waitForSelector("nav.nav, button.bigbtn", { timeout: 15000 });
    if (!(await p.$("nav.nav"))) await p.click("button.bigbtn");
    await p.waitForSelector("nav.nav", { timeout: 15000 });
    await p.evaluate(() => document.querySelector("nav.nav button:nth-child(2)").click()); await sleep(300);
    await p.evaluate(() => [...document.querySelectorAll(".seg button")].find((b) => b.textContent === "Touchpad")?.click());
  };
  await openScreen(A, true);
  await sleep(4000);
  const b0 = await played(B), a0 = await played(A);
  await sleep(5000);
  const b1 = await played(B), a1 = await played(A);
  const bSays = await B.evaluate(() => document.body.innerText.includes("is using Screen mode"));
  const status = await api("/api/status");
  const aFrames = await A.evaluate(() => (window.__pbsVideoFrames || 0) + (document.querySelector(".screenbox img")?.naturalWidth ? 1 : 0));
  const f0 = await A.evaluate(() => window.__pbsVideoFrames || 0); await sleep(5000); const f1 = await A.evaluate(() => window.__pbsVideoFrames || 0);
  const lat = await A.evaluate(() => window.__pbsLatency?.() ?? null);
  check("Screen mode: phone A keeps playing and sees the screen", a1 - a0 > 400 && aFrames > 0, `${a1 - a0} blocks in 5 s, ${((f1 - f0) / 5).toFixed(1)} video frames/s once settled, sound buffer ${lat} ms (shared buffer ${status.latency_ms} ms)`);
  check("…phone B is paused (no sound sent) and says why", b1 - b0 < 20 && bSays, `${b1 - b0} blocks in 5 s, notice shown: ${bSays}`);
  // a third phone asking for the screen is turned away
  await openScreen(C, false); await sleep(2500);
  const cFrames = await C.evaluate(() => (window.__pbsVideoFrames || 0) + (document.querySelector(".screenbox img")?.naturalWidth || 0));
  check("…another phone asking for the screen is turned away while Screen mode is on", cFrames === 0, `${cFrames} frames on phone C`);
  // A ends it: B plays again
  await A.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent === "Off")?.click());
  await sleep(2500);
  const b2 = await played(B); await sleep(3000); const b3 = await played(B);
  check("…when phone A turns the screen off, phone B plays again", b3 - b2 > 250, `${b3 - b2} blocks in 3 s`);
} finally {
  await browser?.close().catch(() => {});
  server.kill(); await sleep(300); fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`${results.filter(Boolean).length}/${results.length} checks passed`);
process.exit(results.every(Boolean) ? 0 : 1);
