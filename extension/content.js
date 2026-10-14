// PhoneBoxSound, in every page: reports the video or music playing here and carries out play / pause /
// seek / speed / volume when the extension's background asks. It reads nothing else from the page, runs
// in the browser's isolated world (page scripts can't call it), and never inserts anything it is sent.
(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  if (!api || !api.runtime || !api.runtime.id || window.__pbs) return;
  window.__pbs = true;
  let cur = null, timer = 0, alive = true, quiet = false;
  let delayMs = 0, canvas = null, ctx2d = null, queue = [], raf = 0, hooked = null, failed = new WeakSet();

  const tell = (msg) => { try { const p = api.runtime.sendMessage(msg); if (p && p.catch) p.catch(() => {}); return true; } catch (e) { return false; } };

  // The PhoneBoxSound dashboard, open on this PC: tell the background which port it listens on.
  if (window === window.top && /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && document.querySelector('meta[name="phoneboxsound"][content="dashboard"]'))
    tell({ t: "found", port: Number(location.port) || (location.protocol === "https:" ? 443 : 80) });

  const score = (m) => (m.paused ? 0 : 1e9) + (m.muted || m.volume === 0 ? 0 : 1e7) + (m.tagName === "VIDEO" ? m.clientWidth * m.clientHeight : 1) + (isFinite(m.duration) ? Math.min(m.duration, 1e5) : 0);
  const pick = () => {
    const all = [...document.querySelectorAll("video,audio")].filter((m) => m.currentSrc || m.srcObject || m.readyState > 0);
    return all.length ? all.sort((a, b) => score(b) - score(a))[0] : null;
  };

  function state(m) {
    const md = navigator.mediaSession && navigator.mediaSession.metadata;
    return { t: "media", title: (md && md.title) || document.title || location.hostname, artist: (md && md.artist) || "", album: (md && md.album) || "",
      paused: m.paused || m.ended, position: m.currentTime || 0, duration: isFinite(m.duration) ? m.duration : 0, rate: m.playbackRate || 1,
      volume: m.volume, muted: m.muted, video: m.tagName === "VIDEO" && m.videoWidth > 0 };
  }

  function report() {
    if (!alive) return;
    const m = pick();
    if (m !== cur) { cur = m; if (delayMs) startDelay(); }
    if (!m && quiet) return;                 // a page without media says so once, then stays silent
    quiet = !m;
    if (!tell(m ? state(m) : { t: "media", none: true })) { alive = false; clearInterval(timer); stopDelay(); }   // the extension was reloaded: this copy retires
  }

  for (const ev of ["play", "pause", "seeked", "ratechange", "volumechange", "loadedmetadata", "ended", "emptied"])
    document.addEventListener(ev, report, true);
  document.addEventListener("seeking", () => { queue.forEach((f) => f.bmp.close()); queue = []; }, true);   // old frames belong to the old position
  timer = setInterval(report, 1000);
  report();

  api.runtime.onMessage.addListener((msg, sender) => {
    if (!msg || msg.t !== "cmd" || sender.id !== api.runtime.id) return;
    const v = typeof msg.value === "boolean" ? msg.value : Number(msg.value) || 0;
    if (msg.action === "delay") { setDelay(v); return; }
    const m = cur || pick();
    if (!m) return;
    try {
      switch (msg.action) {
        case "toggle": if (m.paused) m.play(); else m.pause(); break;
        case "play": m.play(); break;
        case "pause": case "stop": m.pause(); break;
        case "seek": m.currentTime = Math.max(0, Math.min(isFinite(m.duration) ? m.duration : 1e9, m.currentTime + v)); break;
        case "seek_to": m.currentTime = Math.max(0, v); break;
        case "rate": if (v > 0) m.playbackRate = Math.max(0.1, Math.min(4, v)); break;
        case "volume": m.muted = false; m.volume = Math.max(0, Math.min(1, v)); break;
        case "mute": m.muted = !!msg.value; break;
      }
    } catch (e) { /* the page refused (autoplay rules, for example) */ }
    setTimeout(report, 60);
  });

  // ---- keeping the picture in step with phones -----------------------------------------------------
  // Phones play the PC's sound a fraction of a second later. A page's sound can't be made earlier, but its
  // picture can be shown later: every frame is copied and painted over the video after the same delay.
  // Where a frame can't be copied (copy-protected films such as Netflix, Prime, Disney+), the video is
  // left exactly as it is: nothing is drawn, nothing breaks.
  function setDelay(ms) { delayMs = Math.max(0, Math.min(Number(ms) || 0, 1500)); if (delayMs >= 30) startDelay(); else stopDelay(); }
  function stopDelay() { cancelAnimationFrame(raf); raf = 0; queue.forEach((f) => f.bmp.close()); queue = []; if (canvas) canvas.remove(); canvas = null; hooked = null; }
  function startDelay() {
    const v = cur;
    const usable = v && v.tagName === "VIDEO" && v.requestVideoFrameCallback && window.createImageBitmap && !v.mediaKeys && !failed.has(v);
    if (!usable || delayMs < 30) { stopDelay(); return; }
    if (hooked === v) return;
    stopDelay(); hooked = v;
    canvas = document.createElement("canvas");
    canvas.setAttribute("data-pbs-delay", "");
    canvas.setAttribute("aria-hidden", "true");
    canvas.style.cssText = "position:fixed;z-index:2147483646;pointer-events:none;left:0;top:0;display:none";
    ctx2d = canvas.getContext("2d");
    const grab = () => {
      if (hooked !== v || !delayMs) return;
      if (!document.hidden && v.videoWidth) {
        const scale = Math.min(1, 1920 / v.videoWidth, (Math.max(v.clientWidth, 320) * (window.devicePixelRatio || 1)) / v.videoWidth);
        createImageBitmap(v, { resizeWidth: Math.max(2, Math.round(v.videoWidth * scale)), resizeHeight: Math.max(2, Math.round(v.videoHeight * scale)) })
          .then((bmp) => {
            if (hooked !== v) { bmp.close(); return; }
            queue.push({ bmp, due: performance.now() + delayMs });
            while (queue.length > 96) queue.shift().bmp.close();          // never more than ~1.5 s of frames in memory
          })
          .catch(() => { failed.add(v); stopDelay(); });                   // protected video: leave it alone, and don't retry on it
      }
      v.requestVideoFrameCallback(grab);
    };
    v.requestVideoFrameCallback(grab);
    const paint = () => {
      if (hooked !== v) return;
      if (!v.isConnected) { stopDelay(); return; }
      const host = document.fullscreenElement || document.documentElement;
      if (canvas.parentNode !== host) host.appendChild(canvas);
      const r = v.getBoundingClientRect(), now = performance.now();
      let frame = null;
      while (queue.length && queue[0].due <= now) { if (frame) frame.bmp.close(); frame = queue.shift(); }
      if (frame) {
        const k = Math.min(r.width / frame.bmp.width, r.height / frame.bmp.height), w = frame.bmp.width * k, h = frame.bmp.height * k;   // same letterboxing as the video
        const dpr = window.devicePixelRatio || 1, cw = Math.round(r.width * dpr), ch = Math.round(r.height * dpr);
        if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
        canvas.style.left = r.left + "px"; canvas.style.top = r.top + "px"; canvas.style.width = r.width + "px"; canvas.style.height = r.height + "px";
        ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx2d.fillStyle = "#000"; ctx2d.fillRect(0, 0, r.width, r.height);
        ctx2d.drawImage(frame.bmp, (r.width - w) / 2, (r.height - h) / 2, w, h);
        frame.bmp.close();
        canvas.style.display = "";
      }
      if (v.paused || v.ended || r.width < 40 || document.hidden) canvas.style.display = "none";      // paused: the real frame is the right one
      raf = requestAnimationFrame(paint);
    };
    raf = requestAnimationFrame(paint);
  }
})();
