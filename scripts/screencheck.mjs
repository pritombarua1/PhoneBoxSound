// Does watching the PC screen on a phone disturb that phone's sound? Measured, not guessed.
//
//   node scripts/screencheck.mjs                    # slow phone (CPU 4x slower) on a busy 10 Mbit/s link
//   node scripts/screencheck.mjs --cpu 6 --mbps 5   # harsher
//
// Starts PhoneBoxSound in demo mode, joins one phone in headless Chrome, plays for a while with screen
// view off, then the same with screen view on, and compares what the phone's sound engine counted:
//   late      blocks that arrived after the moment they had to play (an audible gap)
//   unsynced  blocks dropped because the phone's clock was being measured again (silence)
//   resyncs   times the playback position had to jump
//   jumps     times the clock sync threw its measurements away
// Exit code 1 if screen view causes any audible problem.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";

const root = path.resolve(import.meta.dirname, "..");
const arg = (name, def) => { const i = process.argv.indexOf("--" + name); return i > 0 ? Number(process.argv[i + 1]) : def; };
const CPU = arg("cpu", 4), MBPS = arg("mbps", 10), SECONDS = arg("seconds", 15);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((ok) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const chrome = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome"].find((p) => p && fs.existsSync(p));

const port = await freePort();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbs-screen-"));
const server = spawn("python", ["-m", "phoneboxsound", "--demo", "--port", String(port), "--https-port", String(await freePort()), "--no-mdns", "--no-tray", "--no-browser",
  "--config", path.join(tmp, "config.json")], { cwd: root, env: { ...process.env, PHONEBOXSOUND_SEAL: "file", ...(process.argv.includes("--busy") ? { PHONEBOXSOUND_DEMO_BUSY_SCREEN: "1" } : {}) }, stdio: "ignore" });
const URL_ = `http://127.0.0.1:${port}`;
const api = (p, body) => fetch(URL_ + p, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());

// Everything the PC sends to the phone goes through one queue that empties at the link's speed, the way a
// Wi-Fi router's queue does: a big picture in front of a sound block makes the sound wait.
async function wifiLink(target, mbps) {
  const port = await freePort(), queue = [];       // { sock, data, at }: strictly first in, first out
  let lastAt = 0;
  const bytesPerMs = mbps * 125;
  const send = (sock, data) => { lastAt = Math.max(lastAt, performance.now()) + data.length / bytesPerMs; queue.push({ sock, data, at: lastAt + 4 }); };   // + 4 ms in the air
  const timer = setInterval(() => {
    const now = performance.now();
    while (queue.length && queue[0].at <= now) { const { sock, data } = queue.shift(); if (!sock.destroyed) sock.write(data); }
  }, 1);
  const srv = net.createServer((phoneSide) => {
    const pcSide = net.connect(target, "127.0.0.1");
    // the PC only answers its own address (protection against DNS rebinding): present that one
    const mine = `127.0.0.1:${port}`, its = `127.0.0.1:${target}`;
    phoneSide.on("data", (buf) => { const t = buf.toString("latin1"); pcSide.write(t.includes(mine) ? Buffer.from(t.split(mine).join(its), "latin1") : buf); });
    pcSide.on("data", (buf) => { for (let i = 0; i < buf.length; i += 1460) send(phoneSide, buf.subarray(i, i + 1460)); });
    const end = () => { phoneSide.destroy(); pcSide.destroy(); };
    phoneSide.on("error", end); pcSide.on("error", end); phoneSide.on("close", end); pcSide.on("close", end);
  });
  await new Promise((ok) => srv.listen(port, "127.0.0.1", ok));
  return { port, close: () => { clearInterval(timer); srv.close(); } };
}
let browser, failed = false, link;
try {
  for (let i = 0; ; i++) { try { await api("/api/status"); break; } catch { if (i > 100) throw new Error("server did not start"); await sleep(200); } }
  await api("/api/settings", { approval: false });
  const { code } = await api("/api/status");
  browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  link = MBPS > 0 ? await wifiLink(port, MBPS) : null;
  const PHONE_URL = link ? `http://127.0.0.1:${link.port}` : URL_;
  await page.goto(`${PHONE_URL}/player?code=${code}`, { waitUntil: "networkidle0" });
  if (!(await page.$('input[placeholder]:not(.code)'))) { console.log("page says:", (await page.evaluate(() => document.body.innerText)).slice(0, 300)); await page.screenshot({ path: path.join(os.tmpdir(), "screencheck-join.png") }); }
  await page.type('input[placeholder]:not(.code)', "Screen test");
  await page.click("button.bigbtn");
  await page.waitForSelector("nav.nav", { timeout: 8000 });
  const dev = (await api("/api/devices")).find((d) => d.name === "Screen test");
  await api(`/api/devices/${dev.device_id}`, { perms: { input: true, screen: true } });

  const cdp = await page.createCDPSession();
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU });


  const phase = async (view) => {
    await page.evaluate((v) => localStorage.setItem("pbs.view", v), view);
    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForSelector("nav.nav, button.bigbtn", { timeout: 15000 });
    if (!(await page.$("nav.nav"))) await page.click("button.bigbtn");          // "Connect as …"
    await page.waitForSelector("nav.nav", { timeout: 15000 }).catch(async (e) => { await page.screenshot({ path: path.join(os.tmpdir(), "screencheck-fail.png") }); console.log(await page.evaluate(() => document.body.innerText.slice(0, 300))); throw e; });
    await page.evaluate(() => document.querySelector("nav.nav button:nth-child(2)").click()); await sleep(400);
    await page.evaluate(() => [...document.querySelectorAll(".seg button")].find((b) => b.textContent === "Touchpad")?.click());
    await page.waitForFunction(() => window.__pbsAudio?.stats.played > 30, { timeout: 20000 });   // counted from the first second
    const read = () => page.evaluate(() => { const a = window.__pbsAudio; const im = document.querySelector(".screenbox img"); return { ...a.stats, lateWindow: undefined, ...a.clock(), frames: window.__frames || 0, img: im?.naturalWidth || 0 }; });
    await page.evaluate(() => {          // count every new picture shown, whenever the picture area appears
      window.__frames = 0; let src = "";
      setInterval(() => { const im = document.querySelector(".screenbox img"); if (im && im.src && im.src !== src && im.complete) { src = im.src; window.__frames++; } }, 15);
    });
    const bufA = (await api("/api/status")).latency_ms ?? (await api("/api/status")).cfg?.latency_ms;
    const a = await read();
    const levels = new Set();
    for (let t = 0; t < SECONDS; t++) {
      await sleep(1000);
      const row = (await api("/api/devices")).find((x) => x.name === "Screen test");
      if (row?.link) levels.add(row.link);
    }
    const b = await read();
    const bufB = (await api("/api/status")).latency_ms ?? (await api("/api/status")).cfg?.latency_ms;
    const d = {}; for (const k of ["played", "late", "unsynced", "resyncs", "far", "gaps", "jumps"]) d[k] = b[k] - a[k];
    d.buffer = `${bufA}→${bufB} ms`;
    d.link = [...levels].join("/") || "?";
    d.frames = b.frames; d.fps = +(b.frames / SECONDS).toFixed(1); d.rtt = Math.round(b.rtt);
    return d;
  };
  console.log(`${process.argv.includes("--busy") ? "busy screen, " : ""}phone CPU ${CPU}x slower, ${MBPS ? `Wi-Fi link ${MBPS} Mbit/s` : "no link limit"}, ${SECONDS} s per run`);
  const off = await phase("off");
  const on = await phase("screen");
  for (const [name, r] of [["screen off", off], ["screen on", on]])
    console.log(`${name.padEnd(11)} played ${String(r.played).padStart(5)}  late ${String(r.late).padStart(3)}  unsynced ${String(r.unsynced).padStart(4)}  resyncs ${String(r.resyncs).padStart(3)}  clock jumps ${r.jumps}  clock rtt ${r.rtt} ms  buffer ${r.buffer}  link ${r.link}` + (name === "screen on" ? `  pictures ${r.frames} (${r.fps}/s)` : ""));
  const bad = on.late + on.unsynced + on.jumps + Math.max(0, on.resyncs - 1) + (/weak|poor/.test(on.link) && !/weak|poor/.test(off.link) ? 1 : 0);
  failed = bad > 0 || on.played < off.played * 0.97 || on.frames === 0;
  console.log(failed ? "FAIL: the sound was disturbed while the screen was shown" : "PASS: the sound was not disturbed by the screen");
} finally {
  await browser?.close().catch(() => {});
  link?.close();
  server.kill();
  await sleep(300);
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
