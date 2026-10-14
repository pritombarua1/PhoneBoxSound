// Runs inside docs/tour.html and docs/extension-install.html. `S` (the slides) is defined just above this.
// As a page: play, pause, step, jump to a chapter, and read aloud with the browser's own voice.
// While being recorded (?record): no buttons; each slide lasts as long as its spoken text (window.tourTimes),
// and the moment each one starts is kept in window.tourStarts so the voice can be laid under the picture.
const rec = new URLSearchParams(location.search).has("record");
if (rec) document.body.classList.add("rec");
const ICON = {
  pc: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M2 20h20M9 16v4M15 16v4"/></svg>',
  phone: '<svg viewBox="0 0 24 24"><rect x="7" y="2" width="10" height="20" rx="2.5"/><path d="M11 18.5h2"/></svg>',
  browser: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M6.5 6.5h.01M9.5 6.5h.01"/></svg>',
};
const WHERE = { pc: "On the PC", phone: "On the phone", browser: "In the browser" };
let i = -1, playing = !rec, timer = 0, started = 0, left = 0, voice = false, t0 = 0;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const time = (k) => (window.tourTimes && window.tourTimes[k]) || Math.max(5000, Math.min(16000, 3200 + 48 * (S[k].text.length + (S[k].steps || []).join(" ").length)));
window.tourStarts = [];

function mock(m) {
  return '<div class="mock"><div class="tabs"><i></i><i></i><i></i><b>' + esc(m.browser) + '</b></div>' +
    '<div class="addr"><span style="--w:' + (m.url.length + 1) + 'ch">' + esc(m.url) + '</span></div><div class="body">' +
    m.items.map((it) => '<div class="item' + (it.btn ? " btn" : "") + (it.hit ? " hit" : "") + '"><div>' + esc(it.label) + (it.note ? "<small>" + esc(it.note) + "</small>" : "") + "</div>" + (it.sw ? '<span class="sw"></span>' : "") + "</div>").join("") +
    '</div><div class="cursor"><svg viewBox="0 0 24 24"><path d="M5 3l14 8-6 1.5L10.5 19z"/></svg></div></div>';
}

function show(k) {
  i = Math.max(0, Math.min(S.length - 1, k));
  const s = S[i], dur = time(i);
  window.tourStarts[i] = performance.now() - t0;
  $("pic").className = "pic" + (s.where === "phone" ? " phone" : "");
  $("pic").innerHTML = '<div class="tilt" style="--dur:' + dur + 'ms">' + (s.mock ? mock(s.mock) : '<img alt="" src="screens/' + s.img + '.png">') + "</div>";
  // each step appears when the voice reaches it: the voice speaks at an even pace, so the place in the text gives the time
  const steps = s.steps || [], lens = steps.map((t) => t.length + 14), before = s.title.length + s.text.length + 20, all = before + lens.reduce((a, b) => a + b, 0);
  const at = (j) => ((dur - 1400) / 1000) * ((before + lens.slice(0, j).reduce((a, b) => a + b, 0)) / all);
  $("say").innerHTML = '<div class="where ' + s.where + '">' + ICON[s.where] + WHERE[s.where] + '<span class="dotp"></span></div>' +
    '<div class="ch">' + esc(s.ch) + "</div><h1>" + esc(s.title) + "</h1><p>" + esc(s.text) + "</p>" +
    (steps.length ? '<ol class="steps">' + steps.map((t, j) => '<li style="--at:' + at(j).toFixed(1) + 's">' + esc(t) + "</li>").join("") + "</ol>" : "") +
    '<div class="n">' + (i + 1) + " / " + S.length + "</div>";
  const hit = $("pic").querySelector(".item.hit"), cur = $("pic").querySelector(".cursor");
  if (hit && cur) setTimeout(() => { const a = hit.getBoundingClientRect(), b = hit.closest(".mock").getBoundingClientRect(); cur.style.opacity = "1"; cur.style.transform = "translate(" + (a.left - b.left + (hit.querySelector(".sw") ? a.width - 34 : Math.min(a.width - 30, 150))) + "px," + (a.top - b.top + a.height / 2) + "px)"; }, 1500);
  $("jump").value = s.ch; $("prog").style.width = ((i + 1) / S.length) * 100 + "%";
  left = dur; run(true);
}
function next() { if (i >= S.length - 1) { window.tourDone = true; playing = false; $("play").textContent = "Play again"; } else show(i + 1); }
function run(fresh) {
  clearTimeout(timer); if (window.speechSynthesis) speechSynthesis.cancel();
  if (!playing) return;
  started = performance.now();
  if (voice && !rec && window.speechSynthesis && fresh) {      // read aloud; the next slide waits for the end of the sentence
    const s = S[i], u = new SpeechSynthesisUtterance([s.title, s.text].concat((s.steps || []).map((t, j) => "Step " + (j + 1) + ". " + t)).join(". "));
    u.rate = 0.95; u.onend = () => { timer = setTimeout(next, 900); }; u.onerror = () => { timer = setTimeout(next, left); };
    return speechSynthesis.speak(u);
  }
  timer = setTimeout(next, left);
}
$("play").onclick = () => {
  if (i >= S.length - 1 && !playing) { playing = true; $("play").textContent = "Pause"; return show(0); }
  playing = !playing; $("play").textContent = playing ? "Pause" : "Play";
  if (playing) run(true); else { clearTimeout(timer); if (window.speechSynthesis) speechSynthesis.cancel(); left = Math.max(1200, left - (performance.now() - started)); }
};
$("prev").onclick = () => show(i - 1); $("next").onclick = () => show(i + 1);
$("voice").onclick = () => { voice = !voice; $("voice").classList.toggle("on", voice); $("voice").textContent = voice ? "Voice on" : "Voice off"; if (playing) run(true); };
if (!window.speechSynthesis) $("voice").style.display = "none";
$("jump").onchange = (e) => show(S.findIndex((s) => s.ch === e.target.value));
addEventListener("keydown", (e) => { if (e.key === "ArrowRight") show(i + 1); else if (e.key === "ArrowLeft") show(i - 1); else if (e.key === " ") { e.preventDefault(); $("play").click(); } });
window.tourLength = () => S.reduce((a, s, k) => a + time(k), 0);
window.tourGo = () => { playing = true; t0 = performance.now(); show(0); };
const ready = Promise.all(S.filter((s) => s.img).map((s) => new Promise((ok) => { const im = new Image(); im.onload = im.onerror = ok; im.src = "screens/" + s.img + ".png"; })));
ready.then(() => { window.tourReady = true; if (!rec) window.tourGo(); });
