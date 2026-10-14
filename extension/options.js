const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
api.storage.local.get(["port", "status"]).then((s) => {
  $("port").value = s.port || 8080;
  $("s").textContent = s.status || "Starting…";
});
api.storage.onChanged.addListener((ch) => {
  if (ch.status) $("s").textContent = ch.status.newValue;
  if (ch.port) $("port").value = ch.port.newValue;
});
$("save").onclick = () => { const p = Number($("port").value); if (Number.isInteger(p) && p > 0 && p < 65536) api.storage.local.set({ port: p }); };
$("again").onclick = () => api.storage.local.set({ reset: Date.now() });
