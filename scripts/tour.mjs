// The guided tour: every screen and every setting, one captioned slide each, and a second, short one about
// adding the browser extension by hand.
//   docs/tour.html, docs/extension-install.html        as pages (play, pause, step, jump, read aloud)
//   docs/media/tour.mp4, docs/media/extension-install.mp4     the same, recorded as videos with a spoken
//                                                             voice and quiet music (scripts/narrate.py)
// All made by `npm run docs`, from the screenshots that run has just taken, so they never show an old screen.
import fs from "node:fs";
import path from "node:path";

// [chapter, screenshot, title, what to say]
export const SLIDES = [
  ["Start", "dashboard", "Start it with one double-click",
    "Double-click start.bat. The first time it fetches what is missing by itself (Python, its packages, the web app), then opens this dashboard at http://localhost:8080. Nothing is ever installed on a phone."],
  ["Start", "qr-themed", "Connect a phone",
    "Point the phone's camera at the QR code, or type the address and the room code. Use the secure (https) address: it gives the phone its own key, which the microphone and PC control need."],
  ["Start", "phone-join", "On the phone it is just a web page",
    "iPhone or Android, any modern browser. Add it to the home screen and it opens like an app."],
  ["Start", "approval", "You decide who gets in",
    "With \"Approve new phones\" on, knowing the code is not enough: a new phone waits here until you press Approve. Deny turns it away, Block keeps its address out."],
  ["Start", "phone-waiting", "What the waiting phone sees",
    "It can do nothing at all until it is approved: no sound, no remote, no PC control."],

  ["Speakers", "phone-speaker", "Every phone is a speaker",
    "The PC's sound plays on all phones at the same moment. Each phone has its own volume, channel (left, right, stereo), sound shape and quality. \"Remote mode\" keeps the controls but plays no sound on this phone."],
  ["Speakers", "devices", "Devices: one row per phone",
    "Rename a phone, set its volume, channel, zone and timing, see its connection quality and which system it runs. Verify its key, block it, or forget it. Blocked addresses sit at the top; Past devices keeps a record of phones that left."],
  ["Speakers", "pc-speaker", "The PC's own speakers, in step",
    "Phones play a moment later than the PC (the sync buffer). Switch this on and the PC's speakers or headphones are delayed by the same amount, so the room is one sound. Windows' default output must be a different device from the one you listen on."],
  ["Speakers", "presets", "Presets: one tap sets the room",
    "Music, Movie, Party, Night and Sync test set every phone's channel, loudness and buffer at once. Change them or restore the defaults."],
  ["Speakers", "phone-studio", "Manage speakers from a phone",
    "A phone with the \"Manage speakers\" permission can change every phone's volume, channel and timing, pause all, and start the bedtime timer."],
  ["Speakers", "phone-host", "Play music from a phone",
    "With \"Host music\", audio files on a phone play on every phone, in place of the PC's sound."],

  ["Media", "nowplaying", "Now Playing: one remote for everything",
    "Whatever plays on the PC shows here: browsers, Spotify, VLC, MPC-HC, mpv, PotPlayer and other Windows apps. Play, pause, skip, seek, volume and speed. Pick which player the remote controls."],
  ["Media", "nowplaying-spotify", "Spotify, properly",
    "Link your Spotify account in Settings and you get the real queue, exact repeat (off, all, this song), shuffle, Liked Songs and your playlists. Spotify does not let other apps reorder or remove queue items."],
  ["Media", "search", "Search and play",
    "Type a song or video: results from YouTube, Spotify and Apple Music come with pictures, and one tap plays it on the PC. Other services (Netflix, Prime and more) open as links."],
  ["Media", "share", "Share what is playing",
    "A link and a QR code for the current song or video, with its picture, so anyone can open it on their own device."],
  ["Media", "phone-remote", "The phone's Remote tab",
    "The same remote in your hand: cover, title, seek bar, play and skip, jump 10 seconds back or forward, volume of the player and of the PC. Swipe the cover left or right to skip."],
  ["Media", "phone-spotify", "Spotify on the phone",
    "Like, repeat, shuffle, the next songs and your playlists, all from the phone."],
  ["Media", "phone-search", "Search on the phone",
    "Tap Search and the keyboard opens at once on a full screen of its own. Results are the only list on screen. Tap one to play it on the PC, or \"Play next\" to queue a Spotify song."],
  ["Media", "phone-playlists", "Playlists",
    "Play one of your playlists, or save the current song into one. If the song is already in that playlist it asks first: add again, or replace so it is there once."],
  ["Media", "phone-players", "Several players at once",
    "When more than one thing is playing, choose which one the remote controls."],

  ["Control the PC", "remote", "Who can control this PC",
    "One switch per phone and per ability. Everything that reaches into the PC is OFF until you switch it on: keyboard and mouse, clipboard, screen view, power, files, commands, hosting music, approving phones, shake to lock down. A legend under the table says what each one allows."],
  ["Control the PC", "phone-touchpad", "Touchpad",
    "Needs \"Keyboard & mouse\". Move the pointer, tap to click, two fingers to scroll or right-click, tap-then-hold to drag. Speed and drag lock are under Pad options."],
  ["Control the PC", "phone-autokeyboard", "The keyboard opens by itself",
    "Tap a text box on the PC and the phone's keyboard comes up; what you type goes to the PC key by key. If the iPhone keeps the keyboard down, the bar says \"Tap here to type\": one tap on it brings it up. The switch for this is under Pad options."],
  ["Control the PC", "phone-keys", "Keys and shortcuts",
    "Ctrl, Shift, Alt, Win, arrows, function keys, ready-made shortcuts and your own. In the type box, Enter starts a new line; Send (or Shift+Enter) types the whole text on the PC."],
  ["Control the PC", "phone-screen", "See the PC's screen",
    "Needs \"Screen view\". The whole screen or only the active window, live, on its own connection so it never disturbs the sound. With the free video helper it plays as smooth video, up to 30 frames a second. Screen mode (Pad options) gives this phone the screen alone, at the best quality, with its sound just behind the picture; the other phones pause until it ends."],
  ["Control the PC", "phone-magnifier", "Magnifier",
    "A zoomed view that follows the pointer, for small buttons and text."],
  ["Control the PC", "phone-clipboard", "Clipboard",
    "Needs \"Clipboard\". Read what was copied on the PC, or send text and pictures to the PC's clipboard."],
  ["Control the PC", "phone-pc", "Commands and power",
    "Press the command buttons you made in Settings. A phone can never create a command."],
  ["Files", "phone-transfer-send", "Photos, videos and files to the PC",
    "Needs Files. Pick as many as you like: they go up exactly as they are, same quality, same date. Each shows its percentage, speed and time left. If the Wi-Fi drops or the phone sleeps, it carries on where it stopped. Transfers pause for a moment whenever the music needs the air."],
  ["Files", "phone-transfer-get", "And from the PC to the phone",
    "Browse the PC's shared folder, with pictures of photos and videos, pick several and download them. On an iPhone, one tap saves them to Photos or Files. The dashboard can also push files to one phone: it is told, and downloads them."],
  ["Control the PC", "phone-power-confirm", "Power asks first",
    "Lock, sleep, restart and shut down each ask for confirmation, then count down so anyone at the PC can cancel."],

  ["Intercom", "intercom", "Intercom and announcements",
    "Talk between phones and the PC. Type an announcement and the PC speaks it on every phone, with a doorbell sound first if you like. Your own voice is never played back to you, so there is no echo."],
  ["Intercom", "phone-intercom", "Intercom on the phone",
    "Hold to talk, to everyone or to one phone. The microphone only works on the secure address."],

  ["Security", "locked", "A password for the dashboard",
    "Set a password and every setting is stored encrypted with it. The dashboard, and optionally every server start, asks for it. Without the password the stored file cannot be read or swapped for another."],
  ["Security", "lockdown", "Lockdown",
    "One button: phones keep playing, but none can control the PC, no new phone can join and the remote API is closed."],
  ["Security", "phone-locked", "What phones see in lockdown",
    "PC controls show as locked on every phone until you lift it."],
  ["Security", "guest-pass", "Guest pass",
    "A QR code for visitors: speaker only, for a few hours, then they are disconnected and their record removed. No remote, no intercom, no PC control."],
  ["Security", "phone-approve", "Approve from a phone",
    "A phone with the \"Approve phones\" permission can let a waiting phone in or turn it away without going to the PC."],
  ["Security", "security-digest", "Security digest",
    "Where things stand (password, strict security, lockdown, phones with their own key) and what happened in the last 30 days: denied attempts, blocks, lockdowns."],
  ["Security", "activity", "Activity: a two-day record per phone",
    "Every tap and every request of each phone with millisecond times, matched to what the PC answered. The switch at the top turns recording off entirely; \"What is recorded?\" explains it. Erase one phone's record or all."],
  ["Security", "replay", "Replay, like a camera recording",
    "Play back what a phone's screen showed, moment by moment, with a timeline to jump along."],

  ["Browser", "extension", "The browser extension",
    "For Chrome, Edge and Firefox: per-tab control of videos and music, with the picture delayed to match the phones so lips stay in sync."],
  ["Browser", "extension-approve", "Each browser asks once",
    "A browser with the extension shows up here and does nothing until you approve it."],

  ["Bedtime", "bedtime", "Bedtime fade",
    "Pick a time: the sound fades out on every phone, and the PC can then lock, sleep or shut down."],

  ["Phone settings", "phone-more", "More: this phone's own settings",
    "Invite another phone with a QR code, choose this phone's theme and text size, fine-tune its timing, switch \"Shake to lock down\" on (three firm shakes lock the PC down, if the permission is given)."],
  ["Phone settings", "phone-textsize", "Text size",
    "Make everything on the phone larger or smaller."],
  ["Phone settings", "phone-speaker-light", "Light or dark, five themes",
    "Phones follow the PC's theme unless they choose their own. Switches, tabs and buttons keep a strong outline in every theme."],
];

// One slide per card on the Settings page. The picture is cut from the page; the words come from here.
export const SETTINGS = [
  [/start with windows/i, "Start with Windows", "On: PhoneBoxSound starts quietly when you sign in to Windows, with its icon in the tray. Off: it only runs when you start it."],
  [/^appearance/i, "Appearance", "Dark, light or follow the system; five colour themes; interface size. Phones follow unless they choose their own."],
  [/^commands/i, "Commands", "Make buttons that run a program or script on this PC. Phones with the \"PC commands\" permission can press them, never create or change them."],
  [/^files/i, "Files", "The one folder phones with the \"Files\" permission can send to and download from."],
  [/^pairing/i, "Pairing & network", "The room code (make a new one any time), the addresses phones use, and the port (changing it moves connected phones along). Switches: advertise as phoneboxsound.local, the secure server, the warning-free https address, Approve new phones, Lockdown, Strict security (PC controls only for phones that proved their key). Disconnect all phones is here too."],
  [/^screen view/i, "Screen view", "How phones see this PC's screen. With the free video helper (one 80 MB download, offered here) the screen is sent as smooth video, up to 30 frames a second, encoded by the PC's own video chip, using a fraction of the Wi-Fi. Without it, or on older phones, it is sent as pictures. Either way the sound always comes first."],
  [/^sync/i, "Sync", "The PC's own speakers in step with the phones; a lighter stream for a phone on poor Wi-Fi (it also tells you to come closer); automatic buffer with its minimum and maximum; lip-sync for VLC, MPC-HC and mpv."],
  [/^player integrations/i, "Player integrations", "Browsers, Spotify and Windows apps work by themselves. VLC, MPC-HC and mpv get a one-click or one-line setup for full timeline control. The browser extension is offered here."],
  [/^search/i, "Search", "Optional keys: a YouTube key (without one, search still works), and your Spotify app's ID to link your account for queue, likes and playlists."],
  [/^password/i, "Password & encrypted storage", "Set, change or remove the dashboard password, and choose whether it is asked at every server start."],
  [/^api/i, "API & automation", "A token and ready-made commands to control PhoneBoxSound from scripts or a smart-home hub, and webhooks that tell other programs when something happens."],
  [/^diagnostics/i, "Diagnostics", "Versions, audio device and health at a glance. Export makes a report with no tokens or passwords in it, to attach to a bug report."],
];

// Numbered steps for the slides where you have to do something. Keyed by screenshot name.
export const STEPS = {
  "dashboard": ["Double-click start.bat", "Wait for the browser to open the dashboard", "Leave the window open, or use the tray icon"],
  "qr-themed": ["Open the phone's camera", "Point it at the QR code", "Tap the link that appears"],
  "phone-join": ["Type the 4-digit room code", "Tap Join", "Optional: Share, then Add to Home Screen"],
  "approval": ["Open Devices on the PC", "Find the waiting phone", "Press Approve"],
  "phone-speaker": ["Tap \"Play PC audio here\"", "Set this phone's volume", "Pick left, right or stereo"],
  "devices": ["Click a phone's name to rename it", "Drag its volume and timing", "Use Block or Forget to remove it"],
  "pc-speaker": ["Open Settings, then Sync", "Pick the speakers you listen on", "Switch \"PC speakers in step\" on"],
  "presets": ["Open Presets", "Press Music, Movie, Party or Night"],
  "nowplaying-spotify": ["Settings, Search: paste your Spotify app's ID", "Press Connect and sign in to Spotify", "Queue, likes and playlists appear here"],
  "search": ["Type a song or a video", "Click a result to play it on the PC"],
  "share": ["Press the share button", "Scan the QR code, or copy the link"],
  "phone-remote": ["Open the Remote tab", "Use play, skip and the seek bar", "Swipe the cover to change song"],
  "phone-search": ["Tap Search: the keyboard opens", "Type and pick a result", "\"Play next\" queues a Spotify song"],
  "phone-playlists": ["Tap \"Add this song to a playlist\"", "Tap a playlist", "If it is already there: Add again or Replace"],
  "remote": ["Open Remote on the PC", "Find the phone's column", "Switch on only what that phone should do"],
  "phone-touchpad": ["Remote tab, then PC", "Slide a finger to move the pointer", "Tap to click, two fingers to scroll"],
  "phone-autokeyboard": ["Move the pointer onto a text box", "Tap: the keyboard comes up", "Type; press Done when finished"],
  "phone-keys": ["Write in the type box", "Enter makes a new line", "Press Send to type it on the PC"],
  "phone-screen": ["Switch \"Screen view\" on for the phone", "On the phone, open Pad options", "Choose whole screen or active window"],
  "phone-transfer-send": ["Remote tab, then PC, then Files & media", "Tap Photos & videos, or Any files", "Pick several: watch each one's progress"],
  "phone-transfer-get": ["Tap Get from the PC", "Tap the files you want", "Tap Download, then Save to Photos / Files"],
  "phone-power-confirm": ["Tap Lock, Sleep, Restart or Shut down", "Confirm", "Cancel during the countdown if needed"],
  "intercom": ["Open Intercom", "Type an announcement", "Choose a sound and press Announce"],
  "phone-intercom": ["Open the Intercom tab", "Hold the button and talk", "Let go to stop"],
  "locked": ["Settings, Password: set a password", "Choose whether to ask at every start", "Type it here to open the dashboard"],
  "lockdown": ["Press Lockdown at the top", "Press it again to lift it"],
  "guest-pass": ["Devices, then Guest pass", "Pick how many hours", "Let the visitor scan the code"],
  "activity": ["Open Activity", "Pick a phone", "Use the switch at the top to stop recording"],
  "replay": ["Press Replay on a moment", "Drag the timeline", "Close with the cross"],
  "extension": ["Settings, Player integrations", "Press \"How to add it\"", "Follow the steps for your browser"],
  "extension-approve": ["Open the browser with the extension", "Come back to the dashboard", "Press Approve"],
  "bedtime": ["Pick the time", "Choose lock, sleep or shut down", "Press Start"],
  "phone-more": ["Open the More tab", "Pick theme and text size", "Show the QR code to invite a phone"],
};
const SETTINGS_STEPS = {
  "Start with Windows": ["Open Settings", "Flip the first switch"],
  "Screen view": ["Open Settings, Screen view", "Press Download the video helper (once)", "Give a phone the Screen view permission"],
  "Pairing & network": ["\"New code\" changes the room code", "Type a port and press Move to change it", "Flip Approve, Lockdown and Strict as needed"],
  "Commands": ["Type a name and what to run", "Press Add", "Give a phone the \"PC commands\" permission"],
  "Search": ["Paste a YouTube key (optional)", "Paste your Spotify app's ID", "Press Connect"],
  "Password & encrypted storage": ["Type a password twice", "Press Set password", "Keep it safe: it cannot be recovered"],
};

// Adding the browser extension by hand. [chapter, browser window, title, what to say, steps]
const item = (label, o = {}) => ({ label, ...o });
export const EXT_SLIDES = [
  { ch: "Before you start", where: "pc", img: "extension", title: "Get the extension from your own PC",
    text: "The extension is inside PhoneBoxSound. Until it is in the browser stores, you add it by hand: about a minute per browser.",
    steps: ["Open Settings, then Player integrations", "Press \"How to add it\"", "Download the zip and unzip it into a folder you will keep"] },
  { ch: "Chrome", where: "browser", title: "Google Chrome",
    mock: { browser: "Google Chrome", url: "chrome://extensions", items: [item("Developer mode", { sw: 1, hit: 1, note: "top right corner" }), item("Load unpacked", { btn: 1 }), item("PhoneBoxSound", { note: "appears here when it is loaded" })] },
    text: "Chrome only loads an extension from a folder when Developer mode is on.",
    steps: ["Type chrome://extensions in the address bar", "Switch Developer mode on, top right", "Press Load unpacked", "Choose the unzipped folder"] },
  { ch: "Edge", where: "browser", title: "Microsoft Edge",
    mock: { browser: "Microsoft Edge", url: "edge://extensions", items: [item("Developer mode", { sw: 1, hit: 1, note: "left side, near the bottom" }), item("Load unpacked", { btn: 1 }), item("PhoneBoxSound", { note: "appears here when it is loaded" })] },
    text: "Edge works the same way; its Developer mode switch is on the left.",
    steps: ["Type edge://extensions in the address bar", "Switch Developer mode on, on the left", "Press Load unpacked", "Choose the unzipped folder"] },
  { ch: "Brave, Opera, Vivaldi", where: "browser", title: "Brave, Opera and Vivaldi",
    mock: { browser: "Brave", url: "brave://extensions", items: [item("Developer mode", { sw: 1, hit: 1 }), item("Load unpacked", { btn: 1 }), item("PhoneBoxSound", { note: "appears here when it is loaded" })] },
    text: "These are built like Chrome. Only the address differs: brave://extensions, opera://extensions or vivaldi://extensions.",
    steps: ["Open the browser's extensions page", "Switch Developer mode on", "Press Load unpacked", "Choose the unzipped folder"] },
  { ch: "Firefox", where: "browser", title: "Mozilla Firefox",
    mock: { browser: "Mozilla Firefox", url: "about:debugging#/runtime/this-firefox", items: [item("This Firefox"), item("Load Temporary Add-on…", { btn: 1, hit: 1 }), item("PhoneBoxSound", { note: "stays until Firefox is closed" })] },
    text: "Firefox loads it for this session only: after closing Firefox you load it again. A signed file from addons.mozilla.org installs it for good.",
    steps: ["Type about:debugging in the address bar", "Click This Firefox", "Press Load Temporary Add-on", "Choose manifest.json in the unzipped folder"] },
  { ch: "Approve it", where: "pc", img: "extension-approve", title: "Approve the browser once",
    text: "The new browser shows up on the dashboard as \"wants to connect\". It can do nothing until you approve it. It only ever talks to PhoneBoxSound on this same PC.",
    steps: ["Go back to the dashboard", "Find the browser under Player integrations", "Press Approve"] },
  { ch: "Use it", where: "phone", img: "phone-players", title: "Every tab is its own player",
    text: "Each tab that plays shows up on the phone by itself, with exact seeking, speed and volume, and the picture kept in step with the phones.",
    steps: ["Play a video in the browser", "Open Remote on the phone", "Pick the tab and control it"] },
];

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const here = import.meta.dirname;

/** The slides of the main tour. `cards`: [{ file, title, text }] cut from the Settings page by the docs run. */
export function tourSlides(root, cards = []) {
  const has = (n) => fs.existsSync(path.join(root, "docs", "screens", n + ".png"));
  const slides = [];
  for (const [ch, img, title, text] of SLIDES) {
    if (!has(img)) { console.log("   tour: no screenshot for", img); continue; }
    slides.push({ ch, img, title, text, steps: STEPS[img] || [], where: img.startsWith("phone-") ? "phone" : "pc" });
    if (ch === "Bedtime") {      // the settings come after the features and before the phone's own settings
      for (const c of cards) {
        const known = SETTINGS.find(([re]) => re.test(c.title) || re.test(c.text.slice(0, 60)));
        if (!has(c.file)) continue;
        const name = known ? known[1] : c.title || "Settings";
        slides.push({ ch: "Settings", img: c.file, title: name, text: known ? known[2] : c.text.slice(0, 220), steps: SETTINGS_STEPS[name] || [], where: "pc" });
      }
    }
  }
  return slides;
}

/** Writes docs/<name>.html and docs/media/<name>.json (what the voice says for each slide). */
export function buildShow(root, name, heading, slides) {
  slides = slides.filter((s) => !s.img || fs.existsSync(path.join(root, "docs", "screens", s.img + ".png")));
  const chapters = [...new Set(slides.map((s) => s.ch))];
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>PhoneBoxSound: ${esc(heading)}</title>
<style>
${fs.readFileSync(path.join(here, "tour-page.css"), "utf8")}</style></head>
<body>
<div class="glow"><i></i><i></i></div>
<div class="stage"><div class="pic" id="pic"></div><div class="say" id="say"></div></div>
<div class="bar"><button class="ctl" id="prev" aria-label="Previous">&#9664;</button><button class="ctl" id="play">Pause</button><button class="ctl" id="next" aria-label="Next">&#9654;</button>
  <button class="ctl" id="voice">Voice off</button>
  <div class="prog"><i id="prog"></i></div>
  <select class="ctl" id="jump" aria-label="Chapter">${chapters.map((c) => `<option>${esc(c)}</option>`).join("")}</select></div>
<script>
const S = ${JSON.stringify(slides).replace(/</g, "\\u003c")};
${fs.readFileSync(path.join(here, "tour-page.js"), "utf8")}</script>
</body></html>
`;
  fs.writeFileSync(path.join(root, "docs", name + ".html"), html);
  fs.mkdirSync(path.join(root, "docs", "media"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "media", name + ".json"), JSON.stringify(slides.map((s) => ({ title: s.title, text: s.text, steps: s.steps || [] })), null, 1));
  return slides.length;
}

/**
 * Records docs/<name>.html as docs/media/<name>.webm, with the spoken voice and quiet music under it.
 * Returns { seconds, bytes, voiced }. Without Python's voice step or ffmpeg it still records, silently.
 */
export async function recordShow(browser, root, name, log = console.log) {
  const { spawnSync } = await import("node:child_process");
  const { pathToFileURL } = await import("node:url");
  const os = await import("node:os");
  const media = path.join(root, "docs", "media"), work = fs.mkdtempSync(path.join(os.tmpdir(), "pbs-tour-"));
  const out = path.join(media, name + ".mp4"), silent = path.join(work, "picture.webm");
  let times = null;
  const spoke = spawnSync("python", [path.join(here, "narrate.py"), "speak", path.join(media, name + ".json"), work], { encoding: "utf8" });
  if (spoke.status === 0) times = JSON.parse(fs.readFileSync(path.join(work, "times.json"), "utf8"));
  else log("   tour: no voice (" + String(spoke.stderr || spoke.error || "").trim().split("\n").pop() + ")");

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  if (times) await page.evaluateOnNewDocument((t) => { window.tourTimes = t; }, times);
  await page.goto(pathToFileURL(path.join(root, "docs", name + ".html")).href + "?record=1", { waitUntil: "load" });
  await page.waitForFunction("window.tourReady === true", { timeout: 30000 });
  const length = await page.evaluate(() => window.tourLength());
  const rec = await page.screencast({ path: silent });
  await page.evaluate(() => window.tourGo());
  // asked again every second: one long wait would run into the browser driver's own time limit on a long video
  for (const until = Date.now() + length + 90000; !(await page.evaluate(() => window.tourDone === true));) {
    if (Date.now() > until) throw new Error("the tour did not reach its end");
    await new Promise((r) => setTimeout(r, 1000));
  }
  await new Promise((r) => setTimeout(r, 1200));
  const starts = await page.evaluate(() => window.tourStarts);
  await rec.stop();
  await page.close();

  let voiced = false;
  if (times) {
    fs.writeFileSync(path.join(work, "starts.json"), JSON.stringify(starts));
    const sound = path.join(work, "sound.wav");
    const mixed = spawnSync("python", [path.join(here, "narrate.py"), "mix", work, path.join(work, "starts.json"), sound], { encoding: "utf8" });
    const muxed = mixed.status === 0 && spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", silent, "-i", sound, "-c:v", "libx264", "-preset", "medium", "-crf", "27", "-r", "24", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-shortest", out], { encoding: "utf8", maxBuffer: 1 << 26 });
    voiced = !!muxed && muxed.status === 0;
    if (!voiced) log("   tour: sound not added (" + String((mixed.status ? mixed.stderr : muxed && muxed.stderr) || "ffmpeg not found").trim().split("\n").pop() + ")");
  }
  if (!voiced) {       // no voice or no ffmpeg: keep the silent picture as it was recorded
    fs.copyFileSync(silent, path.join(media, name + ".webm"));
    fs.rmSync(work, { recursive: true, force: true });
    return { seconds: Math.round(length / 1000), bytes: fs.statSync(path.join(media, name + ".webm")).size, voiced };
  }
  fs.rmSync(path.join(media, name + ".webm"), { force: true });
  fs.rmSync(work, { recursive: true, force: true });
  return { seconds: Math.round(length / 1000), bytes: fs.statSync(out).size, voiced };
}

// `node scripts/tour.mjs`: rebuild both pages and both videos from the screenshots that are already there.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(here, "tour.mjs")) {
  const root = path.resolve(here, "..");
  const puppeteer = (await import("puppeteer-core")).default;
  const chrome = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find((p) => p && fs.existsSync(p));
  const cardsFile = path.join(root, "docs", "media", "settings-cards.json");
  const cards = fs.existsSync(cardsFile) ? JSON.parse(fs.readFileSync(cardsFile, "utf8")) : [];
  console.log("tour:", buildShow(root, "tour", "guided tour", tourSlides(root, cards)), "slides · extension:", buildShow(root, "extension-install", "add the browser extension by hand", EXT_SLIDES), "slides");
  if (!process.argv.includes("--pages")) {
    const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--hide-scrollbars", "--mute-audio"] });
    try { const only = process.argv.slice(2).filter((x) => !x.startsWith("--"));      // e.g. `node scripts/tour.mjs extension-install`
      for (const name of only.length ? only : ["extension-install", "tour"]) console.log(name, await recordShow(browser, root, name)); } finally { await browser.close(); }
  }
}
