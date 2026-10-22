/**
 * Every permission a phone can be given, in the words the dashboard uses.
 * `pc`: it reaches into the PC itself. Those are off until you switch them on, and are withheld from a phone
 * that has not proved its own key (strict security) or while lockdown is on.
 */
export const PERM_INFO = [
  { key: "speaker", label: "Speaker", what: "Plays the PC's sound on this phone, in sync with the others.", pc: false },
  { key: "remote", label: "Media remote", what: "Play, pause, skip, seek and volume of what is playing; see the queue; share its link.", pc: false },
  { key: "intercom", label: "Intercom", what: "Talk to the other phones and the PC, and hear announcements.", pc: false },
  { key: "search", label: "Search and play", what: "Search YouTube, Spotify and Apple Music and start a result on the PC.", pc: false },
  { key: "input", label: "Keyboard & mouse", what: "Move the PC's pointer, click, scroll and type: full control of whatever is on screen.", pc: true },
  { key: "clipboard", label: "Clipboard", what: "Read what you copied on the PC, and put text or pictures on the PC's clipboard.", pc: true },
  { key: "screen", label: "Screen view", what: "See the PC's screen (or the active window) live on the phone.", pc: true },
  { key: "power", label: "Power", what: "Lock, sleep, restart or shut down the PC, each after a confirmation and a countdown.", pc: true },
  { key: "manage", label: "Manage speakers", what: "Change every phone's volume, channel and timing, pause all, start the bedtime timer.", pc: true },
  { key: "files", label: "Files", what: "Send photos, videos and files to the PC's shared folder, untouched, and browse and download what is in it. Nothing outside that folder.", pc: true },
  { key: "commands", label: "PC commands", what: "Press the command buttons you made in Settings. A phone can never create or change one.", pc: true },
  { key: "host", label: "Host music", what: "Play audio files from this phone on every phone, in place of the PC's sound.", pc: true },
  { key: "approve", label: "Approve phones", what: "Let a waiting phone in, or turn it away, without going to the PC.", pc: true },
  { key: "panic", label: "Shake to lock down", what: "Three firm shakes of this phone put the PC into lockdown.", pc: true },
] as const;
export type PermKey = (typeof PERM_INFO)[number]["key"];
