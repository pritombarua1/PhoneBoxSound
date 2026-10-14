"""Audio engine: captures system audio (WASAPI loopback) or a test signal.

Every block is timestamped with the moment it was captured on the server clock, which is
what lets every phone play it at the same instant.
"""
import logging
import struct
import threading
import time

import numpy as np

try:
    import pyaudiowpatch as pyaudio
except ImportError:  # non-Windows / contributor machines: test sources still work
    pyaudio = None

log = logging.getLogger("pbs.audio")

BLOCK_MS = 10
SOURCES = ("system", "clicks", "tone", "demo", "silence", "phone")
KIND_HOST = 3  # audio a phone is hosting for everyone

# Audio packet sent to phones:
#   kind u8 (0 = program audio, 1 = intercom), channels u8, frames u16,
#   seq u32, capture timestamp f64 (server ms), sample rate u32, flags u32 (bit0 = silent, no payload)
HEADER = struct.Struct("<BBHIdII")
KIND_PROGRAM, KIND_INTERCOM = 0, 1
FLAG_SILENT = 1


def now_ms():
    return time.perf_counter() * 1000.0


def pack(kind, seq, ts, sr, pcm, force_payload=False):
    """pcm: int16 ndarray shaped (frames, channels)."""
    frames, ch = pcm.shape
    silent = not force_payload and not pcm.any()
    head = HEADER.pack(kind, ch, frames, seq & 0xFFFFFFFF, ts, sr, FLAG_SILENT if silent else 0)
    return head if silent else head + pcm.tobytes()


class Capture:
    """Runs on its own thread; calls ``emit(ts_ms, sample_rate, stereo_int16)`` per block."""

    def __init__(self):
        self.emit = None
        self.source = "system" if pyaudio else "clicks"
        self.device_name = None  # loopback device name; None follows the Windows default output
        self.active_device = None
        self.status = "starting"
        self.error = None
        self.devices = []
        self.outputs = []            # names of the PC's outputs that can be played to
        self.restarts = 0
        self._pa = None
        # Windows' audio list is only read when the audio library starts, and it only really restarts when
        # nobody in this program is still holding it. So there is exactly one handle (this one); anything
        # else that plays sound borrows it under this lock and lets go when asked (on_reinit).
        self.pa_lock = threading.RLock()
        self.on_reinit = None
        self._restart = threading.Event()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="capture", daemon=True)
        # "phone" source: audio a phone uploads, played out on the server's clock
        self.host_name = "Phone"
        self._host_lock = threading.Lock()
        self._host_buf = np.zeros((0, 2), dtype=np.int16)
        self._host_sr = 48000

    def start(self):
        self._thread.start()

    def stop(self):
        self._stop.set()
        self._restart.set()

    def configure(self, source, device_name):
        source = source if source in SOURCES else "system"
        if source == "system" and not pyaudio:
            source = "clicks"
        self.source = source
        self.device_name = device_name or None
        self.restart()

    def restart(self):
        self._restart.set()

    # -- thread ------------------------------------------------------------

    def _run(self):
        while not self._stop.is_set():
            self._restart.clear()
            try:
                if self.source == "system":
                    self._reinit_portaudio()
                    self._run_loopback()
                elif self.source == "phone":
                    self._run_phone()
                else:
                    self._run_generator(self.source)
            except Exception as e:  # unplugged device, exclusive mode, driver hiccup - retry
                log.warning("capture error: %s", e)
                self.status, self.error, self.active_device = "error", str(e), None
                self.restarts += 1
                self._restart.wait(2)

    def _reinit_portaudio(self):
        # PortAudio only enumerates devices at init, so re-init to see new/changed devices.
        with self.pa_lock:
            if self.on_reinit:
                try:
                    self.on_reinit()          # borrowers close their streams first
                except Exception as e:
                    log.debug("on_reinit failed: %s", e)
            if self._pa:
                self._pa.terminate()
            self._pa = pyaudio.PyAudio()
            self.devices = [d["name"] for d in self._pa.get_loopback_device_info_generator()]
            self.outputs = self._output_names()

    def _output_names(self):
        pa, out = self._pa, []
        api = pa.get_host_api_info_by_type(pyaudio.paWASAPI)["index"]
        for i in range(pa.get_device_count()):
            d = pa.get_device_info_by_index(i)
            if d["hostApi"] == api and d["maxOutputChannels"] >= 2 and not d.get("isLoopbackDevice") and d["name"] not in out:
                out.append(d["name"])
        return out

    def shared_pa(self):
        """The one audio handle, for borrowers. Call with pa_lock held; made on first use when the capture
        itself isn't using Windows audio (test sources)."""
        if not pyaudio:
            return None
        if self._pa is None:
            self._pa = pyaudio.PyAudio()
            self.outputs = self._output_names()
        return self._pa

    def _loopback_device(self):
        pa = self._pa
        loopbacks = list(pa.get_loopback_device_info_generator())
        if self.device_name:
            for d in loopbacks:
                if d["name"] == self.device_name:
                    return d
        wasapi = pa.get_host_api_info_by_type(pyaudio.paWASAPI)
        default_out = pa.get_device_info_by_index(wasapi["defaultOutputDevice"])
        for d in loopbacks:
            if default_out["name"] in d["name"]:
                return d
        if loopbacks:
            return loopbacks[0]
        raise RuntimeError("No WASAPI loopback device found")

    def _render_device(self, loopback):
        pa = self._pa
        name = loopback["name"].replace(" [Loopback]", "")
        wasapi = pa.get_host_api_info_by_type(pyaudio.paWASAPI)["index"]
        for i in range(pa.get_device_count()):
            d = pa.get_device_info_by_index(i)
            if (d["hostApi"] == wasapi and d["maxOutputChannels"] > 0
                    and not d.get("isLoopbackDevice") and d["name"] == name):
                return d
        return None

    def _run_loopback(self):
        pa = self._pa
        dev = self._loopback_device()
        sr = int(dev["defaultSampleRate"])
        nch = max(1, int(dev["maxInputChannels"]))
        frames = sr * BLOCK_MS // 1000

        # Windows only delivers loopback data while something renders, so play silence
        # into the same device to keep a steady, gap-free stream.
        keepalive = None
        render = self._render_device(dev)
        if render:
            och = int(render["maxOutputChannels"])
            try:
                keepalive = pa.open(
                    format=pyaudio.paInt16, channels=och, rate=sr, output=True,
                    output_device_index=render["index"], frames_per_buffer=frames,
                    stream_callback=lambda _i, n, _t, _s: (bytes(n * och * 2), pyaudio.paContinue))
            except Exception as e:
                log.info("keepalive stream unavailable: %s", e)

        stream = pa.open(format=pyaudio.paInt16, channels=nch, rate=sr, input=True,
                         input_device_index=dev["index"], frames_per_buffer=frames)
        self.active_device, self.status, self.error = dev["name"], "capturing", None
        log.info("capturing %s @ %d Hz, %d ch", dev["name"], sr, nch)
        anchor, count = None, 0
        last_data = time.monotonic()
        try:
            while not self._restart.is_set():
                if stream.get_read_available() < frames:
                    if time.monotonic() - last_data > 3:
                        raise RuntimeError("Audio device stopped delivering data")
                    time.sleep(0.002)
                    continue
                data = stream.read(frames, exception_on_overflow=False)
                last_data = time.monotonic()
                t = now_ms()
                block = np.frombuffer(data, dtype=np.int16).reshape(-1, nch)
                n = len(block)
                if nch >= 2:
                    stereo = block[:, :2]
                else:
                    stereo = np.repeat(block, 2, axis=1)

                # Timestamp = when the block was captured. Reads can arrive in bursts, so
                # derive it from the sample count and let the earliest arrivals pull it back.
                observed = t - n * 1000.0 / sr
                if anchor is None:
                    anchor, count = observed, 0
                drift = observed - (anchor + count * 1000.0 / sr)
                if drift > 80:  # stream stalled; start a new timeline
                    anchor, count = observed, 0
                elif drift < 0:
                    anchor += drift
                else:
                    anchor += drift * 0.001
                ts = anchor + count * 1000.0 / sr
                count += n
                self.emit(ts, sr, np.ascontiguousarray(stereo))
        finally:
            stream.close()
            if keepalive:
                keepalive.close()

    def host_feed(self, sr, stereo):
        """Audio from the hosting phone (int16, shape (n, 2)). Kept in a short queue and paced by _run_phone."""
        with self._host_lock:
            if sr != self._host_sr:
                self._host_sr, self._host_buf = sr, np.zeros((0, 2), dtype=np.int16)
            if len(self._host_buf) < sr * 6:  # never hold more than 6 s
                self._host_buf = np.concatenate((self._host_buf, stereo))

    def host_buffered_ms(self):
        with self._host_lock:
            return int(len(self._host_buf) * 1000 / self._host_sr)

    def host_clear(self):
        with self._host_lock:
            self._host_buf = np.zeros((0, 2), dtype=np.int16)

    def _run_phone(self):
        """Plays the hosting phone's audio at exactly real-time speed (silence while it has nothing queued),
        so every listener - including the hosting phone itself - gets the same timestamps."""
        self.active_device = f"Phone: {self.host_name}"
        self.status, self.error = "capturing", None
        sr = self._host_sr
        start, count = now_ms(), 0
        while not self._restart.is_set():
            if self._host_sr != sr:
                sr, start, count = self._host_sr, now_ms(), 0
            frames = sr * BLOCK_MS // 1000
            ts = start + count * 1000.0 / sr
            wait = ts + BLOCK_MS - now_ms()
            if wait > 0:
                time.sleep(wait / 1000)
            elif wait < -200:
                start, count = now_ms(), 0
                continue
            with self._host_lock:
                if len(self._host_buf) >= frames:
                    block, self._host_buf = self._host_buf[:frames], self._host_buf[frames:]
                else:
                    block = None
            self.emit(ts, sr, np.ascontiguousarray(block) if block is not None else np.zeros((frames, 2), dtype=np.int16))
            count += frames

    def _run_generator(self, kind):
        sr = 48000
        frames = sr * BLOCK_MS // 1000
        beat = sr // 2  # a click every 500 ms, accent every 4th
        click_len = int(sr * 0.04)
        self.active_device = {"clicks": "Sync test clicks", "tone": "Test tone (L 440 Hz / R 660 Hz)",
                              "demo": "Demo music"}.get(kind, "Silence")
        self.status, self.error = "capturing", None
        start, count = now_ms(), 0
        while not self._restart.is_set():
            ts = start + count * 1000.0 / sr
            wait = ts + BLOCK_MS - now_ms()
            if wait > 0:
                time.sleep(wait / 1000)
            elif wait < -200:
                start, count = now_ms(), 0
                continue
            idx = count + np.arange(frames)
            if kind == "clicks":
                pos = idx % beat
                freq = np.where((idx // beat) % 4 == 0, 1760.0, 880.0)
                env = np.where(pos < click_len, np.exp(-pos / (sr * 0.008)), 0.0)
                mono = (np.sin(2 * np.pi * freq * pos / sr) * env * 0.7 * 32767).astype(np.int16)
                stereo = np.column_stack((mono, mono))
            elif kind == "demo":  # a slowly evolving chord, so meters and the spectrum have something to show
                t = idx / sr
                mix = np.zeros(frames)
                for i, f in enumerate((110, 220, 277.2, 329.6, 440, 659.3, 880, 1318.5, 2637, 5274)):
                    amp = 0.5 + 0.5 * np.sin(2 * np.pi * (0.13 + 0.07 * i) * t + i)
                    mix += np.sin(2 * np.pi * f * t) * amp / (1 + i * 0.6)
                beat = np.exp(-((t * 2) % 1) * 6)
                l = mix * (0.10 + 0.08 * beat) * 32767
                r = np.roll(mix, 37) * (0.10 + 0.08 * beat) * 32767
                stereo = np.column_stack((l, r)).astype(np.int16)
            elif kind == "tone":
                l = np.sin(2 * np.pi * 440 * idx / sr) * 0.25 * 32767
                r = np.sin(2 * np.pi * 660 * idx / sr) * 0.25 * 32767
                stereo = np.column_stack((l, r)).astype(np.int16)
            else:
                stereo = np.zeros((frames, 2), dtype=np.int16)
            self.emit(ts, sr, stereo)
            count += frames


class Spectrum:
    """Keeps the last ~40 ms of program audio and turns it into log-spaced bands for the UI."""

    BANDS = 28

    def __init__(self):
        self.buf = np.zeros(2048, dtype=np.float32)
        self.sr = 48000

    def push(self, stereo, sr):
        self.sr = sr
        mono = stereo.mean(axis=1, dtype=np.float32) / 32768
        n = len(mono)
        self.buf = np.roll(self.buf, -n)
        self.buf[-n:] = mono

    def bands(self):
        spec = np.abs(np.fft.rfft(self.buf * np.hanning(len(self.buf))))
        freqs = np.fft.rfftfreq(len(self.buf), 1 / self.sr)
        edges = np.geomspace(40, min(16000, self.sr / 2), self.BANDS + 1)
        out = []
        for lo, hi in zip(edges[:-1], edges[1:]):
            sel = spec[(freqs >= lo) & (freqs < hi)]
            v = float(sel.max()) if len(sel) else 0.0
            db = 20 * np.log10(v + 1e-9)
            out.append(round(max(0.0, min(1.0, (db + 10) / 50)), 3))
        return out
