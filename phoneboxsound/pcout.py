"""The PC's own speakers or headphones, in step with the phones.

Normally Windows plays to the PC's speakers at once, while every phone plays the same sound a moment
later (the sync buffer). The PC is then always ahead. To put it in step, the PC must play a *delayed*
copy itself, timed exactly like a phone: the sound captured at time t leaves the speaker at t + buffer.

That needs two outputs on the PC, because a sound already on its way to a speaker cannot be held back:

    Windows plays to output A (the one PhoneBoxSound captures)   → heard by nobody, or switched off
    PhoneBoxSound plays the delayed copy to output B             → the speakers / headphones you listen on

A spare output (the monitor's HDMI audio with its volume at zero, an unused jack) works as A. A PC with a
single output needs a virtual one (the free VB-CABLE is the usual choice).

Timing is the same idea as on the phones. Each captured block carries its capture time on this PC's
clock. The output device asks for samples in small chunks; for each chunk we know when it will actually
leave the device (now + the device's own delay) and hand over the samples that were captured exactly one
buffer earlier. The capture device and the output device each run on their own crystal and drift apart
by a few samples per second; the difference is measured constantly and corrected by dropping or
repeating single samples, far below what can be heard. A real jump (a stall, a changed buffer) is fixed
in one go.
"""
import collections
import logging
import threading

import numpy as np

from .audio import now_ms

log = logging.getLogger("pbs.pcout")

try:
    import pyaudiowpatch as pyaudio
except Exception:  # not Windows, or not installed
    pyaudio = None


def _com_here():
    """Windows audio is reached through COM, which has to be switched on in every thread that uses it.
    The audio library does that for the thread that started it (the capture thread), not for ours."""
    try:
        import ctypes
        ctypes.windll.ole32.CoInitializeEx(None, 0)      # 0 = multithreaded; a harmless no-op when already on
    except Exception:
        pass


class Aligner:
    """Pure timing: blocks in with their capture time, samples out for a given play time.

    Kept free of any audio device so that it can be tested exactly."""

    def __init__(self, sr=48000):
        self.sr = sr
        self.blocks = collections.deque()    # (capture time of first sample in ms, int16 array (n, 2))
        self.pos = 0                         # samples already used from the first block
        self.lock = threading.Lock()
        self.error_ms = 0.0                  # how far what is playing is from where it should be (+ = late)
        self.resyncs = 0
        self.nudges = 0
        self._started = False
        self._avg, self._fresh, self._since = 0.0, True, 0

    def feed(self, ts, sr, stereo):
        with self.lock:
            if sr != self.sr:
                self.sr, self.pos, self._started = sr, 0, False
                self.blocks.clear()
            self.blocks.append((ts, stereo))
            while len(self.blocks) > 400:        # four seconds is far more than any buffer: never grow without end
                self.blocks.popleft()
                self.pos = 0

    def _head(self):
        """Capture time of the next sample to be played, or None when empty."""
        if not self.blocks:
            return None
        return self.blocks[0][0] + self.pos * 1000.0 / self.sr

    def _skip_to(self, want):
        """Throw away everything captured before `want`. Returns False if nothing that late has arrived yet."""
        while self.blocks:
            ts, b = self.blocks[0]
            end = ts + len(b) * 1000.0 / self.sr
            if end <= want:
                self.blocks.popleft()
                self.pos = 0
                continue
            self.pos = max(0, min(len(b) - 1, int(round((want - ts) * self.sr / 1000.0))))
            return True
        return False

    def _take(self, n):
        out, got = np.zeros((n, 2), np.int16), 0
        while got < n and self.blocks:
            ts, b = self.blocks[0]
            m = min(n - got, len(b) - self.pos)
            out[got:got + m] = b[self.pos:self.pos + m]
            got, self.pos = got + m, self.pos + m
            if self.pos >= len(b):
                self.blocks.popleft()
                self.pos = 0
        return out, got

    def pull(self, play_ms, frames, delay_ms):
        """`frames` samples that will leave the speaker starting at `play_ms`: those captured at play_ms - delay_ms."""
        want = play_ms - delay_ms
        with self.lock:
            head = self._head()
            if head is None:
                self._started = False
                return np.zeros((frames, 2), np.int16)       # nothing captured yet (or a stall): silence, then line up again
            err = head - want                                 # + : we would play sound that is too new (we are early); - : too old (late)
            if not self._started or abs(err) > 45:
                # line up in one go: a start, a stall, or the buffer was changed
                if self._started:
                    self.resyncs += 1
                if err > 0:                                   # what we have is from the future: wait in silence until its time comes
                    lead = int(err * self.sr / 1000.0)
                    if lead >= frames:
                        self.error_ms = 0.0
                        return np.zeros((frames, 2), np.int16)
                    self._started, self._fresh = True, True
                    data, _ = self._take(frames - lead)
                    self.error_ms = 0.0
                    return np.concatenate([np.zeros((lead, 2), np.int16), data])
                if not self._skip_to(want):
                    self._started = False
                    return np.zeros((frames, 2), np.int16)
                self._started = True
                err, self._fresh = 0.0, True
            # The moment the device asks varies by a millisecond or two from call to call; that is noise, not
            # drift. Average it, and correct only what remains: one sample at a time, a few times a second.
            self._avg = err if self._fresh else self._avg * 0.92 + err * 0.08
            self._fresh = False
            self._since += 1
            self.error_ms = -self._avg
            step = 0
            if self._since >= 4:
                if self._avg > 0.6:
                    step = 1      # early: repeat one sample
                elif self._avg < -0.6:
                    step = -1     # late: drop one sample
            if step:
                self._since = 0
                self._avg -= step * 1000.0 / self.sr
            if step > 0:
                data, got = self._take(frames - 1)
                data = np.concatenate([data[:1], data]) if frames > 1 else data
                self.nudges += 1
            elif step < 0:
                data, got = self._take(frames + 1)
                data = data[1:]
                self.nudges += 1
            else:
                data, got = self._take(frames)
            return data


class PcOut:
    """Plays the delayed copy on one of the PC's outputs."""

    def __init__(self, cfg, capture):
        self.cfg, self.capture = cfg, capture
        self.align = Aligner()
        self.stream = None
        self.status, self.error, self.device = "off", None, None
        self.gain = 1.0
        self._opened = None          # (device name, sample rate) the stream was opened with
        self._out_lat = 0.0
        self._chirp = None           # (capture time it belongs to, int16 stereo) for calibration

    def settings(self):
        return self.cfg.setdefault("pc_out", {"enabled": False, "device": None, "offset_ms": 0, "volume": 1.0})

    def outputs(self):
        """Names of the PC's outputs that can be played to (the same list Windows shows)."""
        if not pyaudio:
            return []
        if not self.capture.outputs:
            try:
                _com_here()
                with self.capture.pa_lock:
                    self.capture.shared_pa()
            except Exception as e:
                log.debug("listing outputs failed: %s", e)
        return list(self.capture.outputs)

    def public(self):
        st = self.settings()
        return {"enabled": bool(st.get("enabled")), "device": st.get("device"), "offset_ms": st.get("offset_ms", 0), "volume": st.get("volume", 1.0),
                "status": self.status, "error": self.error, "outputs": self.outputs(), "playing_on": self.device,
                "error_ms": round(self.align.error_ms, 1), "resyncs": self.align.resyncs, "capturing": self.capture.active_device}

    def feed(self, ts, sr, stereo):
        """Called from the capture thread for every block."""
        if self.stream is not None:
            self.align.feed(ts, sr, stereo)

    def chirp(self, at_ms):
        """For calibration: sound the test chirp as if it had been captured at `at_ms`, exactly like a phone
        does, so the microphone hears this output with all of its own delay."""
        from .calibrate import chirp
        sig = (chirp(self.align.sr) * 0.6 * 32767).astype(np.int16)
        self._chirp = (float(at_ms), np.repeat(sig[:, None], 2, axis=1))

    def _callback(self, _in, frames, _time, _status):
        st = self.settings()
        delay = float(self.cfg["latency_ms"]) + float(st.get("offset_ms") or 0)
        play = now_ms() + self._out_lat
        data = self.align.pull(play, frames, delay)
        g = self.gain
        if g != 1.0:
            data = np.clip(data.astype(np.float32) * g, -32768, 32767).astype(np.int16)
        c = self._chirp
        if c is not None:
            # where in this chunk does the chirp's first sample fall? (always at full level, like the phones' chirps)
            first = int(round((c[0] - (play - delay)) * self.align.sr / 1000.0))
            if first + len(c[1]) <= 0:
                self._chirp = None
            elif first < frames:
                a, b = max(0, first), min(frames, first + len(c[1]))
                data = data.copy()
                data[a:b] = c[1][a - first:b - first]
        return data.tobytes(), pyaudio.paContinue

    _base = 1.0

    def apply_volume(self):
        """Volume and mute take effect on the very next 10 ms of sound."""
        st = self.settings()
        self.gain = 0.0 if st.get("muted") else self._base * float(st.get("volume", 1.0))

    def close(self):
        """Let go of the output (also called just before the audio library restarts to re-read Windows' devices)."""
        with self.capture.pa_lock:
            s, self.stream = self.stream, None
            if s is not None:
                try:
                    s.stop_stream()
                    s.close()
                except Exception:
                    pass
            self._opened, self.device = None, None

    def tick(self, gain=1.0):
        """Once a second: open, close or re-open the output so that it matches the settings and the capture."""
        st = self.settings()
        self._base = float(gain)
        self.apply_volume()
        if not st.get("enabled"):
            if self.stream is not None:
                self.close()
            self.status, self.error = "off", None
            return
        if not pyaudio:
            self.status, self.error = "error", "Playing on the PC needs Windows audio (pyaudiowpatch)"
            return
        name, sr = st.get("device"), self.align.sr
        source = (self.capture.active_device or "").replace(" [Loopback]", "")
        if not name:
            self.close()
            self.status, self.error = "error", "Choose the output you listen on"
            return
        if name == source:
            self.close()
            self.status, self.error = "error", ("Windows is already playing straight to this output, and a sound on its way to a speaker can't be held back. "
                                                "Set Windows' own output to another device (a spare output, or a virtual cable) and keep this one for PhoneBoxSound.")
            return
        if self.stream is not None and self._opened == (name, sr) and self.stream.is_active():
            self.status, self.error = "playing", None
            return
        self.close()
        try:
          _com_here()
          with self.capture.pa_lock:
            pa = self.capture.shared_pa()
            api = pa.get_host_api_info_by_type(pyaudio.paWASAPI)
            dev = next((pa.get_device_info_by_index(i) for i in range(pa.get_device_count())
                        if pa.get_device_info_by_index(i)["hostApi"] == api["index"] and pa.get_device_info_by_index(i)["name"] == name
                        and pa.get_device_info_by_index(i)["maxOutputChannels"] >= 2 and not pa.get_device_info_by_index(i).get("isLoopbackDevice")), None)
            if dev is None:
                raise OSError("that output is not connected right now")
            self.align = Aligner(sr)
            stream = pa.open(format=pyaudio.paInt16, channels=2, rate=sr, output=True, output_device_index=dev["index"],
                             frames_per_buffer=int(sr / 100), stream_callback=self._callback)
            self._out_lat = stream.get_output_latency() * 1000.0
            self.stream, self._opened, self.device = stream, (name, sr), name
            self.status, self.error = "playing", None
            log.info("PC output in step with the phones on %s (device delay %.0f ms)", name, self._out_lat)
        except Exception as e:
            self.status, self.error = "error", f"Couldn't play on {name}: {e}"
            log.info("pc output failed: %s", e)

