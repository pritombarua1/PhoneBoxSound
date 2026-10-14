"""Voice and music for the guide videos. Everything is made on this PC: nothing is sent anywhere.

    python scripts/narrate.py speak <slides.json> <work dir>
        one WAV per slide, spoken by Windows' own voice with pauses between sentences and before each step.
        Writes <work dir>/times.json: how long each slide should stay on screen, in milliseconds.

    python scripts/narrate.py mix <work dir> <starts.json> <out.wav>
        lays each spoken slide at the moment its picture started (starts.json, milliseconds), over quiet
        music that is made here from sine waves (so there is nothing to license) and dips while the voice talks.

A more natural voice: install Piper (`pip install piper-tts`), download a voice model, and set
PBS_PIPER_MODEL to the .onnx file. Without it, Windows' built-in voice is used.
"""
import json
import os
import subprocess
import sys
import wave
from xml.sax.saxutils import escape

import numpy as np

RATE = 48000
PAUSE_AFTER = 1.1        # seconds of quiet after a slide's last word, before the next picture
NUMBER = ["one", "two", "three", "four", "five", "six"]


def sentences(slide):
    """What is said for a slide, as (text, pause after it in ms)."""
    out = [(slide["title"], 550)]
    for part in slide["text"].replace(":", ".").split(". "):
        part = part.strip().rstrip(".")
        if part:
            out.append((part, 380))
    for n, step in enumerate(slide.get("steps") or []):
        out.append((f"Step {NUMBER[n] if n < len(NUMBER) else n + 1}", 180))
        out.append((step, 420))
    return out


def clean(text):
    for a, b in (("start.bat", "start dot bat"), ("http://localhost:8080", "local host, port 8080"), ("https", "h t t p s"), ("PhoneBoxSound", "Phone Box Sound"),
                 ("chrome://extensions", "chrome extensions"), ("edge://extensions", "edge extensions"), ("brave://extensions", "brave extensions"), ("opera://extensions", "opera extensions"),
                 ("vivaldi://extensions", "vivaldi extensions"), ("about:debugging", "about debugging"), ("manifest.json", "manifest dot jason"), ("addons.mozilla.org", "add-ons dot mozilla dot org"),
                 ("phoneboxsound.local", "phone box sound dot local"), ("MPC-HC", "M P C"), ("mpv", "M P V"), ("VLC", "V L C"), ("QR", "Q R"), ("API", "A P I"), ('"', ""), ("…", "")):
        text = text.replace(a, b)
    return text


def speak_windows(slides, work):
    jobs = []
    for i, s in enumerate(slides):
        body = "".join(f'<s>{escape(clean(t))}</s><break time="{ms}ms"/>' for t, ms in sentences(s))
        ssml = f'<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"><prosody rate="-8%">{body}</prosody></speak>'
        jobs.append({"ssml": ssml, "out": os.path.join(work, f"s{i:03}.wav")})
    with open(os.path.join(work, "jobs.json"), "w", encoding="utf-8") as f:
        json.dump(jobs, f)
    script = r"""
Add-Type -AssemblyName System.Speech
$v = New-Object System.Speech.Synthesis.SpeechSynthesizer
$want = $env:PBS_VOICE
$names = $v.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name }
if ($want -and ($names -contains $want)) { $v.SelectVoice($want) } elseif ($names -contains 'Microsoft Zira Desktop') { $v.SelectVoice('Microsoft Zira Desktop') }
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(44100, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
foreach ($j in (Get-Content -Raw -Encoding UTF8 $env:PBS_JOBS | ConvertFrom-Json)) {
  $v.SetOutputToWaveFile($j.out, $fmt)
  $v.SpeakSsml($j.ssml)
}
$v.SetOutputToNull(); $v.Dispose()
"""
    env = dict(os.environ, PBS_JOBS=os.path.join(work, "jobs.json"))
    subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script], env=env, check=True, timeout=900)
    return [j["out"] for j in jobs]


def speak_piper(slides, work, model):
    outs = []
    for i, s in enumerate(slides):
        parts = []
        for t, ms in sentences(s):
            tmp = os.path.join(work, "part.wav")
            subprocess.run([sys.executable, "-m", "piper", "-m", model, "-f", tmp], input=clean(t).encode("utf-8"), check=True, timeout=120)
            a = load(tmp)
            parts += [a, np.zeros(int(RATE * ms / 1000), np.float32)]
        out = os.path.join(work, f"s{i:03}.wav")
        save(out, np.concatenate(parts), channels=1)
        outs.append(out)
    return outs


def load(path):
    """A WAV file as mono float32 at RATE."""
    with wave.open(path, "rb") as w:
        sr, ch, n = w.getframerate(), w.getnchannels(), w.getnframes()
        a = np.frombuffer(w.readframes(n), np.int16).astype(np.float32) / 32768
    if ch > 1:
        a = a.reshape(-1, ch).mean(axis=1)
    if sr != RATE and len(a):
        a = np.interp(np.arange(0, len(a), sr / RATE), np.arange(len(a)), a).astype(np.float32)
    return a


def save(path, a, channels=2):
    a = np.clip(a, -1, 1)
    with wave.open(path, "wb") as w:
        w.setnchannels(channels); w.setsampwidth(2); w.setframerate(RATE)
        w.writeframes((a * 32767).astype(np.int16).tobytes())


def trim(a):
    """Without the silence Windows leaves at both ends."""
    loud = np.flatnonzero(np.abs(a) > 0.004)
    return a[max(0, loud[0] - 2000):loud[-1] + 4000] if len(loud) else a[:0]


def music(seconds):
    """Quiet, slow chords with a little movement on top. Stereo float32."""
    n = int(seconds * RATE)
    t = np.arange(n) / RATE
    chords = [(220.0, 261.63, 329.63, 392.0), (174.61, 220.0, 261.63, 329.63), (130.81, 196.0, 261.63, 329.63), (196.0, 246.94, 293.66, 392.0)]   # Am7, Fmaj7, C, G
    bar = 8.0
    left, right = np.zeros(n, np.float32), np.zeros(n, np.float32)
    for k in range(int(seconds / bar) + 1):
        a, b = int(k * bar * RATE), min(n, int((k + 1) * bar * RATE + 2.5 * RATE))      # each chord rings into the next
        if a >= n:
            break
        tt = t[a:b] - k * bar
        env = (np.minimum(1, tt / 2.5) * np.minimum(1, np.maximum(0, (bar + 2.5 - tt) / 2.5))).astype(np.float32)
        for j, f in enumerate(chords[k % 4]):
            for detune, pan in ((0.997, 0.3), (1.003, 0.7)):
                wav = (np.sin(2 * np.pi * f * detune * tt) + 0.25 * np.sin(2 * np.pi * 2 * f * detune * tt)) * env * 0.11 / (1 + j * 0.25)
                left[a:b] += wav * (1 - pan); right[a:b] += wav * pan
        # three soft bell notes per bar, from the same chord
        for j, beat in enumerate((1.0, 3.5, 6.0)):
            s0 = int((k * bar + beat) * RATE)
            if s0 >= n:
                continue
            s1 = min(n, s0 + 3 * RATE)
            tb = np.arange(s1 - s0) / RATE
            f = chords[k % 4][(j + k) % 4] * 2
            bell = np.sin(2 * np.pi * f * tb) * np.exp(-tb * 2.2) * np.minimum(1, tb * 200) * 0.07
            pan = 0.25 + 0.5 * ((j + k) % 2)
            left[s0:s1] += bell * (1 - pan); right[s0:s1] += bell * pan
    out = np.stack([left, right], axis=1)
    fade = min(n, 3 * RATE)
    out[:fade] *= np.linspace(0, 1, fade)[:, None]; out[-fade:] *= np.linspace(1, 0, fade)[:, None]
    return out


def main():
    cmd = sys.argv[1]
    if cmd == "speak":
        slides, work = json.load(open(sys.argv[2], encoding="utf-8")), sys.argv[3]
        os.makedirs(work, exist_ok=True)
        model = os.environ.get("PBS_PIPER_MODEL")
        files = speak_piper(slides, work, model) if model else speak_windows(slides, work)
        times = []
        for f in files:
            a = trim(load(f))
            save(f, a, channels=1)
            times.append(int(max(4.0, len(a) / RATE + 0.35 + PAUSE_AFTER) * 1000))      # the voice starts 0.35 s after the picture
        json.dump(times, open(os.path.join(work, "times.json"), "w"))
        print(f"{len(files)} slides spoken, {sum(times) / 1000:.0f} s in all")
    elif cmd == "mix":
        work, starts, out = sys.argv[2], json.load(open(sys.argv[3])), sys.argv[4]
        times = json.load(open(os.path.join(work, "times.json")))
        total = (starts[-1] + times[-1]) / 1000 + 1.5
        voice = np.zeros(int(total * RATE), np.float32)
        for i, ms in enumerate(starts):
            a = load(os.path.join(work, f"s{i:03}.wav"))
            at = int((ms / 1000 + 0.35) * RATE)
            a = a[:max(0, len(voice) - at)]
            voice[at:at + len(a)] += a
        peak = float(np.max(np.abs(voice))) or 1.0
        voice *= 0.85 / peak
        # the music dips while someone is talking, and comes back in the pauses
        win = int(0.25 * RATE)
        level = np.sqrt(np.convolve(voice ** 2, np.ones(win, np.float32) / win, mode="same"))
        duck = 1 - 0.6 * np.clip(level / 0.03, 0, 1)
        smooth = int(0.4 * RATE)
        duck = np.convolve(duck, np.ones(smooth, np.float32) / smooth, mode="same")
        bed = music(total)[:len(voice)] * 0.5 * duck[:, None]
        save(out, bed + voice[:, None])
        print(f"soundtrack {total:.0f} s")


if __name__ == "__main__":
    main()
