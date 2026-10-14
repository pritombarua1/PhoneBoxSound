export const THEMES = [
  { id: "midnight", name: "Midnight", desc: "Clean & modern", swatch: "radial-gradient(circle at 35% 30%, #3a4256, #0d1119)" },
  { id: "aurora", name: "Aurora", desc: "Purple vibe", swatch: "linear-gradient(135deg, #6d5dfc, #b06af5 55%, #3b82f6)" },
  { id: "forest", name: "Forest", desc: "Calm & natural", swatch: "radial-gradient(circle at 35% 30%, #2f9c6a, #0e3b27)" },
  { id: "sand", name: "Sand", desc: "Warm & minimal", swatch: "radial-gradient(circle at 35% 30%, #f1c4a5, #d9906b)" },
  { id: "ocean", name: "Ocean", desc: "Cool minimal", swatch: "radial-gradient(circle at 35% 30%, #38a4f5, #0b4fb3)" },
] as const;

const mq = matchMedia("(prefers-color-scheme: light)");
let current = { theme: "forest", mode: "dark" };
let branded = "";
export const currentTheme = () => current.theme;

export function applyTheme(theme?: string | null, mode?: string | null) {
  current = { theme: theme || current.theme, mode: mode || current.mode };
  const resolved = current.mode === "auto" ? (mq.matches ? "light" : "dark") : current.mode;
  const root = document.documentElement;
  if (root.dataset.theme !== current.theme) root.dataset.theme = current.theme;
  if (root.dataset.mode !== resolved) root.dataset.mode = resolved;
  // the mark follows the theme: browser tab, "Add to Home Screen" picture, install info
  if (branded !== current.theme) {
    branded = current.theme;
    const set = (sel: string, href: string) => document.querySelector<HTMLLinkElement>(sel)?.setAttribute("href", href);
    set('link[rel="icon"]', `/icon.svg?theme=${branded}`);
    set('link[rel="apple-touch-icon"]', `/icon-180.png?theme=${branded}`);
    set('link[rel="manifest"]', `/manifest.webmanifest?theme=${branded}`);
  }
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(root).getPropertyValue("--bg").trim() || "#0b0d12";
  return resolved;
}
mq.addEventListener?.("change", () => applyTheme());
