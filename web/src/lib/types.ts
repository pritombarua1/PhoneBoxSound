/** Shapes of the JSON the Python server sends. Kept loose where the server is the source of truth. */
export interface MediaCan { play?: boolean; next?: boolean; previous?: boolean; seek?: boolean; seek_to?: boolean; rate?: boolean; speed_step?: boolean; volume?: boolean; fullscreen?: boolean; subtitles?: boolean; shuffle?: boolean; repeat?: boolean }
export interface MediaSession {
  id: string; app: string; kind: string; title: string; artist: string; album: string; status: string;
  position: number; duration: number; rate: number; art: string | null; can: MediaCan;
  volume?: number | null; setup?: string | null; live_seek?: boolean; rate_known?: boolean; audible?: boolean; offline?: boolean;
  shuffle?: boolean; repeat?: "off" | "all" | "one";
}
export interface SessionBrief { id: string; app: string; title: string; status: string; setup?: string | null; audible?: boolean; art?: string | null }
export interface PlayerSetup { installed: boolean; running: boolean; web: boolean }
export interface MediaState {
  active: MediaSession | null; pinned: string | null; sessions: SessionBrief[];
  pc: { volume: number; muted: boolean } | null; players?: Record<string, PlayerSetup>;
}
export interface Perms { speaker: boolean; remote: boolean; intercom: boolean; input: boolean; clipboard: boolean; screen: boolean; power: boolean; manage: boolean; files: boolean; commands: boolean; host: boolean; approve: boolean; panic: boolean; search: boolean }
export interface SearchStatus { youtube: "key" | "ytdlp" | "none"; spotify: boolean; apple: boolean; has: Record<string, boolean> }
export interface Bedtime { left_s: number; minutes: number; after: string; by: string }
export interface PcOut { enabled: boolean; device: string | null; offset_ms: number; volume: number; status: "off" | "playing" | "error"; error: string | null;
  outputs: string[]; playing_on: string | null; error_ms: number; resyncs: number; capturing: string | null }
export interface SpotifyStatus { linked: boolean; name: string; has_id: boolean; redirect: string }
export interface BrowserLink { id: string | null; name: string; approved: boolean; connected: boolean; tabs: number }
export interface PendingRow { device_id: string; name: string; platform: string; ip: string | null; waiting: boolean; since: number }
export interface PastRow { device_id: string; name: string; platform: string; ip: string | null; forgotten: number; since: number }
export interface StudioDevice { device_id: string; name: string; online: boolean; health: string; platform: string; me: boolean; buffer?: number | null;
  settings: { volume: number; channel: string; offset_ms: number; muted: boolean } }
export interface Studio { bedtime: Bedtime | null; may_power: boolean; cfg: { master: number; latency_ms: number; auto_latency: boolean; streaming: boolean; source: string }; devices: StudioDevice[] }
export interface Clip { kind: "text" | "image" | "empty"; text?: string; image?: string; w?: number; h?: number; auto?: boolean; at: number; url?: string }
export interface DeviceSettings { volume: number; channel: string; offset_ms: number; muted: boolean; zone: string; eq: string; speaker: boolean; quality: string }
export interface DeviceRow {
  device_id: string; online: boolean; id: string | null; name: string; platform: string; ip: string | null;
  settings: DeviceSettings; perms: Perms; stats: Record<string, any>; health: string; since: number; secure: boolean; blocked: boolean;
  has_key: boolean; verified: boolean; locked: string[]; can_sign: boolean; verify_code: string | null;
  system: string; system_note: string; system_was: string; guest_until: number;
  link: string; auto_saver: boolean; kbps: number; screen_ms: number | null;
}
export interface Scene { id: string; name: string; icon: string; desc?: string }
export interface Target { id: string; label: string }
export interface ServerState {
  code: string; ips: string[]; ports: { http: number; https: number | null }; mdns: boolean; api_token: string;
  cfg: {
    latency_ms: number; auto_latency: boolean; min_latency_ms: number; max_latency_ms: number; master: number; streaming: boolean;
    source: string; device: string | null; theme: string; mode: string; duck_level: number; lip_sync: boolean;
    zones: Record<string, { volume: number; muted: boolean }>; scenes: Scene[]; webhooks: string[];
    vlc: Record<string, any>; mpv: Record<string, any>; mdns: boolean; https: boolean; strict: boolean; public_https: boolean; lockdown: boolean; approval: boolean; browser_delay: boolean; auto_quality: boolean; activity: boolean; auto_keyboard: boolean; screen_video: boolean;
  };
  capture: { status: string; error: string | null; device: string | null; sample_rate: number | null; devices: string[] };
  devices: DeviceRow[]; pending: PendingRow[]; past: PastRow[]; autostart: boolean; terms_ok: boolean; screen_mode: string | null;
  transfers: { name: string; who: string; size: number; done: number; speed: number }[];
  video: { available: boolean; encoder: string | null; installed: boolean; source: string | null; checked: boolean; installing: { done: number; total: number } | null; error: string | null; size_mb: number } | null; bedtime: Bedtime | null; pc_out: PcOut | null; spotify: SpotifyStatus; search: SearchStatus; browsers: BrowserLink[]; browser_hint: string[]; extension_urls: { chrome: string; firefox: string; edge: string }; blocked_ips: string[]; media: MediaState; talkers: { name: string; target: string }[]; targets: Target[];
  events: { t: number; kind: string; text: string }[];
  power: { action: string; by: string; seconds: number } | null;
  commands: { id: string; name: string; run: string }[]; share_dir: string; host: string | null; public_url: string | null;
}
/** What the server pushes to one phone. */
export interface PhoneConfig {
  device_id?: string; name: string; latency_ms: number; streaming: boolean; gain: number; volume: number; muted: boolean;
  channel: string; offset_ms: number; eq: string; speaker: boolean; speaker_pref: boolean; perms: Partial<Perms>;
  zone: string; theme: string; mode: string; duck: number; index: number; https_url: string | null; secure: boolean; screen?: [number, number];
  verified?: boolean; locked?: string[]; can_sign?: boolean; verify_code?: string | null; lockdown?: boolean;
  pending?: PendingRow[]; bedtime?: Bedtime | null; guest_until?: number;
  record?: boolean; screen_mode?: "owner" | "held" | null; screen_mode_by?: string | null; screen_key?: string | null; link?: string; link_weak_s?: number; on_hotspot?: boolean; auto_saver?: boolean;
  file_token?: string | null; commands?: { id: string; name: string }[]; hosting?: string | null;
}
