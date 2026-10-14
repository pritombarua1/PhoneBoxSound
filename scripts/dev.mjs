// npm run dev: the Python server plus the Vite dev server (live reload) in one command.
// If PhoneBoxSound is already running on the port, it is reused instead of started twice.
import { spawn } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const port = process.env.PHONEBOXSOUND_PORT || 8080;
const children = [];
const run = (name, cmd, args) => {
  const child = spawn(cmd, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
  child.on("exit", (code) => { console.log(`[${name}] exited (${code ?? 0})`); stop(); });
  children.push(child);
};
const stop = () => { for (const c of children) { try { c.kill(); } catch { /* already gone */ } } process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

const running = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false);
if (running) console.log(`[server] PhoneBoxSound is already running on port ${port}: using it`);
else run("server", "python", ["-m", "phoneboxsound", "--no-browser", "--no-tray", "--port", String(port)]);
run("web", "npx", ["vite"]);
