// Files between the phone and the PC, both ways, checked byte for byte.
//
//   node scripts/transfercheck.mjs
//
// A demo PhoneBoxSound and one phone in headless Chrome. The phone sends photos, small files and a
// 150 MB "video" (Wi-Fi switched off for a moment in the middle); the PC's copies must be identical, with
// their original dates. Then the phone downloads files from the PC, and the dashboard pushes files to the
// phone. The music must not suffer.
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";

const root = path.resolve(import.meta.dirname, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((ok) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const chrome = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome"].find((p) => p && fs.existsSync(p));
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? "  " + detail : ""}`); };

// files to send: two real photos, three small files (one with an accented name), one big "video"
const src = fs.mkdtempSync(path.join(os.tmpdir(), "pbs-xfer-src-"));
spawnSync("python", ["-c", [
  "from PIL import Image", "import sys",
  "for i, c in enumerate([(200, 60, 60), (40, 120, 200)]):",
  "    Image.new('RGB', (1600, 1200), c).save(sys.argv[1] + '/photo-%d.jpg' % i, quality=92)"].join("\n"), src]);
for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(src, `note ${i} é.txt`), crypto.randomBytes(5000 + i * 7000));
fs.writeFileSync(path.join(src, "holiday.mp4"), crypto.randomBytes(150 * 1024 * 1024));
const when = new Date("2024-07-14T10:30:00Z");
for (const f of fs.readdirSync(src)) fs.utimesSync(path.join(src, f), when, when);
const sent = fs.readdirSync(src);

const port = await freePort(), tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbs-xfer-"));
const server = spawn("python", ["-m", "phoneboxsound", "--demo", "--port", String(port), "--https-port", String(await freePort()), "--no-mdns", "--no-tray", "--no-browser",
  "--config", path.join(tmp, "config.json")], { cwd: root, env: { ...process.env, PHONEBOXSOUND_SEAL: "file" }, stdio: "ignore" });
const URL_ = `http://127.0.0.1:${port}`;
const api = (p, body) => fetch(URL_ + p, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
const share = path.join(os.tmpdir(), "phoneboxsound-demo-share");
const clean = () => { for (const f of [...sent, "Sent to Transfer phone"]) fs.rmSync(path.join(share, f), { force: true, recursive: true }); };
let browser;
try {
  for (let i = 0; ; i++) { try { await api("/api/status"); break; } catch { if (i > 100) throw new Error("server did not start"); await sleep(200); } }
  await api("/api/settings", { approval: false });
  clean();
  const { code } = await api("/api/status");
  browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.goto(`${URL_}/player?code=${code}`, { waitUntil: "networkidle0" });
  await page.type("input[placeholder]:not(.code)", "Transfer phone"); await page.click("button.bigbtn");
  await page.waitForSelector("nav.nav", { timeout: 8000 });
  const dev = (await api("/api/devices")).find((d) => d.name === "Transfer phone");
  await api(`/api/devices/${dev.device_id}`, { perms: { files: true } }); await sleep(800);
  await page.waitForFunction(() => window.__pbsAudio?.stats.played > 30, { timeout: 20000 });
  await page.evaluate(() => document.querySelector("nav.nav button:nth-child(2)").click()); await sleep(300);
  await page.evaluate(() => [...document.querySelectorAll(".seg button")].find((b) => b.textContent === "PC")?.click()); await sleep(500);
  await page.evaluate(() => { const f = [...document.querySelectorAll("details.fold")].find((d) => d.textContent.includes("Files & media")); if (f) f.open = true; });
  await page.waitForSelector(".xfer", { timeout: 5000 });
  const late0 = await page.evaluate(() => window.__pbsAudio.stats.late);

  // ---- to the PC, with the Wi-Fi switched off for a moment in the middle of the video
  const input = await page.$(".xfer input[type=file]:not([accept])");
  await input.uploadFile(...sent.map((f) => path.join(src, f)));
  let sawProgress = "", dropped = false, shotSend = false;
  const outage = [0, 0];                       // late blocks before and after the simulated Wi-Fi outage
  for (let t = 0; t < 900; t++) {
    const jobs = await page.evaluate(() => window.__pbsTransfers());
    const big = jobs.find((j) => j.name === "holiday.mp4");
    const text = await page.evaluate(() => document.querySelector(".xfer-jobs")?.innerText || "");
    if (!sawProgress) sawProgress = text.split("\n").find((l) => /\d+%/.test(l) && /(s|min) left/.test(l)) || "";
    if (big && !shotSend && big.done > big.size * 0.15) { shotSend = true; await page.evaluate(() => document.querySelector(".xfer-jobs")?.scrollIntoView({ block: "center" })); await page.screenshot({ path: path.join(root, "docs", "screens", "phone-transfer-send.png") }); }
    if (big && !dropped && big.done > big.size * 0.3) {
      dropped = true;
      outage[0] = await page.evaluate(() => window.__pbsAudio.stats.late);
      await page.setOfflineMode(true); await sleep(2500); await page.setOfflineMode(false);
      for (let w = 0; w < 40; w++) {           // the music itself reconnects after a real outage too; meanwhile, watch the progress
        if (!sawProgress) sawProgress = (await page.evaluate(() => document.querySelector(".xfer-jobs")?.innerText || "")).split("\n").find((l) => /\d+%/.test(l) && /(s|min) left/.test(l)) || "";
        await sleep(100);
      }
      outage[1] = await page.evaluate(() => window.__pbsAudio.stats.late);
    }
    if (jobs.length === sent.length && jobs.every((j) => j.state === "done" || j.state === "failed")) break;
    await sleep(80);
  }
  const jobs = await page.evaluate(() => window.__pbsTransfers());
  const same = sent.filter((f) => fs.existsSync(path.join(share, f)) && sha(path.join(share, f)) === sha(path.join(src, f)));
  const dated = sent.filter((f) => fs.existsSync(path.join(share, f)) && Math.abs(fs.statSync(path.join(share, f)).mtimeMs - when.getTime()) < 2000);
  check("the phone sends photos, files and a 150 MB video to the PC, byte for byte", same.length === sent.length,
    `${same.length} of ${sent.length} identical${jobs.filter((j) => j.state === "failed").map((j) => "; " + j.name + ": " + j.error).join("")}`);
  check("...each file keeps its original date", dated.length === sent.length, `${dated.length} of ${sent.length}`);
  check("...a Wi-Fi drop in the middle of the video is picked up again where it stopped", dropped && same.includes("holiday.mp4"));
  check("...each file shows its percentage and the time left", !!sawProgress, sawProgress.trim());

  const lateUp = (await page.evaluate(() => window.__pbsAudio.stats.late)) - late0 - (outage[1] - outage[0]);
  // ---- from the PC
  await page.evaluate(() => [...document.querySelectorAll(".xfer .seg button")].find((b) => b.textContent.startsWith("Get from"))?.click());
  await page.waitForSelector(".xfer-tile", { timeout: 5000 });
  await sleep(1500);
  const thumbs = await page.evaluate(() => [...document.querySelectorAll(".xfer-tile img")].filter((i) => i.naturalWidth > 0).length);
  await page.evaluate(() => { for (const t of document.querySelectorAll(".xfer-tile")) if (/photo-|note /.test(t.textContent)) t.click(); });
  await sleep(300); await page.evaluate(() => document.querySelector(".xfer-path")?.scrollIntoView({ block: "start" }));
  await page.screenshot({ path: path.join(root, "docs", "screens", "phone-transfer-get.png") });
  await page.evaluate(() => [...document.querySelectorAll(".xfer-pickbar .btn")].find((b) => b.textContent.startsWith("Download"))?.click());
  await page.waitForFunction(() => { const d = window.__pbsTransfers().filter((j) => j.dir === "down"); return d.length >= 5 && d.every((j) => j.state === "done" || j.state === "failed"); }, { timeout: 30000 })
    .catch(async () => console.log("downloads:", JSON.stringify(await page.evaluate(() => window.__pbsTransfers().filter((j) => j.dir === "down").map((j) => [j.name, j.state, j.done, j.size, j.error]))),
      "picked:", await page.evaluate(() => document.querySelectorAll(".xfer-tile.on").length), "tiles:", await page.evaluate(() => [...document.querySelectorAll(".xfer-tile")].map((t) => t.innerText.split(String.fromCharCode(10))[0]).join(" | "))));
  const got = await page.evaluate(async () => {
    const out = {};
    for (const j of window.__pbsTransfers().filter((x) => x.dir === "down" && x.blob)) {
      const h = await crypto.subtle.digest("SHA-256", await j.blob.arrayBuffer());
      out[j.name] = [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
    }
    return out;
  });
  const okDown = Object.entries(got).filter(([n, h]) => fs.existsSync(path.join(src, n)) && sha(path.join(src, n)) === h).length;
  check("the phone browses the PC's folder with pictures and downloads several files, byte for byte", okDown >= 5 && thumbs >= 2, `${okDown} identical downloads, ${thumbs} pictures shown`);

  // ---- the dashboard pushes two files to this phone
  for (const n of ["photo-0.jpg", "note 1 é.txt"]) {
    const r = await fetch(`${URL_}/api/files/send?device=${encodeURIComponent(dev.device_id)}&name=${encodeURIComponent(n)}`, { method: "POST", body: fs.readFileSync(path.join(src, n)) }).then((x) => x.json());
    if (!r.ok) console.log("send:", r);
  }
  await page.waitForFunction(() => document.querySelector(".xfer-incoming"), { timeout: 8000 }).catch(() => {});
  const told = await page.evaluate(() => document.querySelector(".xfer-incoming")?.innerText || "");
  await page.evaluate(() => document.querySelector(".xfer-incoming .btn")?.click());
  await page.waitForFunction(() => window.__pbsTransfers().filter((j) => j.dir === "down" && j.state === "done").length >= 7, { timeout: 30000 }).catch(() => {});
  const pushed = await page.evaluate(() => window.__pbsTransfers().filter((j) => j.dir === "down" && j.state === "done").length);
  check("the dashboard sends files to the phone: it is told, and downloads them", /sent you 2 files/.test(told) && pushed >= 7, `"${told.split("\n")[0]}", ${pushed} downloads done`);

  const late1 = await page.evaluate(() => window.__pbsAudio.stats.late);
  const lateAll = late1 - late0 - (outage[1] - outage[0]);
  check("the music played on while all this moved (apart from the simulated Wi-Fi outage)", lateAll === 0, `${lateAll} late sound blocks (${lateUp} while sending to the PC; the outage itself: ${outage[1] - outage[0]})`);
} finally {
  await browser?.close().catch(() => {});
  server.kill(); await sleep(300);
  fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(src, { recursive: true, force: true });
  clean();
}
console.log(`${results.filter(Boolean).length}/${results.length} checks passed`);
process.exit(results.every(Boolean) ? 0 : 1);
