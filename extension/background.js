// PhoneBoxSound browser link.
//
// Collects what is playing in each tab (from content.js) and keeps one connection to PhoneBoxSound on
// this PC. Security, in short:
//   * It can only ever connect to 127.0.0.1 (see connect-src in the manifest): never to the internet.
//   * No password or token is stored in it. On first contact it shows up on the PhoneBoxSound dashboard
//     and does nothing until you press Approve there. After that it proves itself with its own secret.
//   * It accepts exactly these orders: play, pause, seek, speed, volume, mute, bring-tab-to-front, and
//     picture delay. Nothing it receives is ever run as code or inserted into a page.
//   * Web pages cannot talk to it: it has no external messaging, and only listens to its own scripts.
if (typeof importScripts === "function" && !self.PBS) { try { importScripts("config.js"); } catch (e) { /* default port is used */ } }
const api = globalThis.browser ?? globalThis.chrome;
const ACTIONS = ["toggle", "play", "pause", "stop", "seek", "seek_to", "rate", "volume", "mute", "delay"];
// "open" (a search result picked on the phone) may only lead to these services, over https.
const OPEN_HOSTS = ["youtube.com", "music.apple.com", "open.spotify.com", "netflix.com", "primevideo.com", "disneyplus.com", "twitch.tv", "soundcloud.com"];
let openedTab = null;
const tabs = new Map();      // "tabId:frameId" -> the latest report from that frame
let cfg = { port: (self.PBS || {}).port || 8080, id: "", secret: "", paired: false };
let ws = null, retry = 0, pushTimer = 0, delayMs = 0, ready = false;

const browserName = () => {
  const ua = navigator.userAgent;
  return /Firefox\//.test(ua) ? "Firefox" : /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : navigator.brave ? "Brave" : /Vivaldi/.test(ua) ? "Vivaldi" : "Chrome";
};
const random = (bytes) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
const setStatus = (s) => { try { api.storage.local.set({ status: s }); } catch (e) { /* ignore */ } };

function connect() {
  if (!cfg.id || (ws && ws.readyState <= 1)) return;
  let sock;
  try { sock = new WebSocket(`ws://127.0.0.1:${cfg.port}/ws/browser?name=${encodeURIComponent(browserName())}`); }
  catch (e) { setStatus("Can't reach PhoneBoxSound: " + e.message); return; }
  ws = sock; ready = false;
  sock.onopen = () => sock.send(JSON.stringify({ t: "hello", id: cfg.id, secret: cfg.secret, name: browserName(), version: api.runtime.getManifest().version }));
  sock.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch (err) { return; }
    if (!m || typeof m !== "object") return;
    if (m.t === "waiting") setStatus("Almost there: open PhoneBoxSound on this PC and press Approve for this browser (Settings → Player integrations).");
    else if (m.t === "ok") { ready = true; retry = 0; cfg.paired = true; api.storage.local.set({ paired: true }); setStatus("Connected. Every tab that plays is now in PhoneBoxSound."); push(true); }
    else if (m.t === "denied") { setStatus("This browser was removed in PhoneBoxSound. Press Start over below to ask again."); try { sock.close(); } catch (err) { /* ignore */ } }
    else if (m.t === "cmd" && ready) command(m);
    else if (m.t === "open" && ready) openUrl(m.url);
    else if (m.t === "delay" && ready) { delayMs = Math.max(0, Math.min(Number(m.ms) || 0, 1500)); for (const s of tabs.values()) send(s.tab, s.frame, "delay", delayMs); }
  };
  sock.onclose = () => {
    if (ws === sock) ws = null;
    if (ready || !cfg.paired) setStatus(cfg.paired ? "PhoneBoxSound isn't running right now. It reconnects by itself." : "Looking for PhoneBoxSound on this PC… open its dashboard once and it is found.");
    ready = false; retry = Math.min(retry + 1, 8); setTimeout(connect, 1500 * retry);
  };
  sock.onerror = () => {};
}

function send(tab, frame, action, value) {
  if (!ACTIONS.includes(action) || !Number.isInteger(tab)) return;
  const v = typeof value === "boolean" ? value : Number(value);
  try { const p = api.tabs.sendMessage(tab, { t: "cmd", action, value: Number.isNaN(v) ? 0 : v }, { frameId: Number(frame) || 0 }); if (p && p.catch) p.catch(() => {}); } catch (e) { /* the tab is gone */ }
}

function openUrl(url) {
  let u; try { u = new URL(String(url)); } catch (e) { return; }
  if (u.protocol !== "https:" || !OPEN_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith("." + h))) return;
  const fresh = () => api.tabs.create({ url: u.href, active: true }).then((t) => { openedTab = t.id; return api.windows.update(t.windowId, { focused: true }); }).catch(() => {});
  if (openedTab === null) { fresh(); return; }
  // the tab opened last time is reused, so picking ten songs doesn't leave ten tabs
  api.tabs.update(openedTab, { url: u.href, active: true }).then((t) => api.windows.update(t.windowId, { focused: true })).catch(fresh);
}

function command(m) {
  if (m.action === "focus" && Number.isInteger(m.tab)) { api.tabs.update(m.tab, { active: true }).then((t) => t && api.windows.update(t.windowId, { focused: true })).catch(() => {}); return; }
  send(m.tab, m.frame, m.action, m.value);
}

function push(now) {
  if (pushTimer && !now) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = 0;
    const fresh = Date.now() - 6000;
    for (const [k, s] of tabs) if (s.at < fresh) tabs.delete(k);
    if (ws && ws.readyState === 1 && ready) ws.send(JSON.stringify({ t: "tabs", tabs: [...tabs.values()] }));
  }, now ? 0 : 200);
}

api.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || sender.id !== api.runtime.id) return;            // only this extension's own scripts
  if (msg.t === "found" && sender.tab && Number.isInteger(msg.port) && msg.port > 0 && msg.port < 65536) {
    // The PhoneBoxSound dashboard is open in a tab on this PC: that is where it listens. Once paired, the
    // port is only followed while PhoneBoxSound can't be reached on the old one (it was moved).
    if (msg.port !== cfg.port && !(ws && ws.readyState === 1 && ready)) { cfg.port = msg.port; api.storage.local.set({ port: msg.port }); try { if (ws) ws.close(); } catch (e) { /* ignore */ } ws = null; }
    connect();
    return;
  }
  if (msg.t !== "media" || !sender.tab) return;
  const key = sender.tab.id + ":" + (sender.frameId || 0);
  if (msg.none) tabs.delete(key);
  else {
    const fresh = !tabs.has(key);
    let host = ""; try { host = new URL(sender.tab.url || sender.url || "").hostname.replace(/^www\./, ""); } catch (e) { /* no address */ }
    const text = (v, n) => String(v || "").slice(0, n), num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    tabs.set(key, { tab: sender.tab.id, frame: sender.frameId || 0, title: text(msg.title, 200), artist: text(msg.artist, 120), album: text(msg.album, 120), page: text(sender.tab.title, 200), host, url: text(sender.tab.url, 600),
      paused: !!msg.paused, position: num(msg.position), duration: num(msg.duration), rate: num(msg.rate) || 1, volume: num(msg.volume), muted: !!msg.muted, video: !!msg.video,
      active: !!sender.tab.active, audible: !!sender.tab.audible, at: Date.now() });
    if (fresh && delayMs) send(sender.tab.id, sender.frameId || 0, "delay", delayMs);
  }
  connect();
  push();
});
api.tabs.onRemoved.addListener((id) => { if (id === openedTab) openedTab = null; for (const k of [...tabs.keys()]) if (k.startsWith(id + ":")) tabs.delete(k); push(); });
api.storage.onChanged.addListener((ch) => { if (ch.port && ch.port.newValue !== cfg.port || ch.reset) load(); });

async function load() {
  const s = await api.storage.local.get(["port", "id", "secret", "paired", "reset"]);
  if (!s.id || s.reset) { s.id = random(12); s.secret = random(32); s.paired = false; await api.storage.local.set({ id: s.id, secret: s.secret, paired: false }); await api.storage.local.remove("reset"); }
  cfg = { port: s.port || (self.PBS || {}).port || 8080, id: s.id, secret: s.secret, paired: !!s.paired };
  try { if (ws) ws.close(); } catch (e) { /* ignore */ }
  ws = null; connect();
}
load();
