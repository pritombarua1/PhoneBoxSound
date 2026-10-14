"""Automatic speaker alignment.

Each phone plays a short chirp at a known moment on the shared timeline. The PC records
all of them with its microphone. Where each chirp lands relative to the others tells us how
early or late that phone really is (speaker latency, Bluetooth, DSP...). Only relative timing
matters, so the microphone's own latency cancels out.
"""
import numpy as np

CHIRP_MS = 60
F0, F1 = 1500.0, 7000.0


def chirp(sr):
    n = int(sr * CHIRP_MS / 1000)
    t = np.arange(n) / sr
    k = (F1 - F0) / (CHIRP_MS / 1000)
    sig = np.sin(2 * np.pi * (F0 * t + 0.5 * k * t * t))
    return sig * np.hanning(n)


def analyze(recording, sr, rec_start_ms, beeps, window_ms=350):
    """recording: float32 mono. beeps: [{id, at_ms}] where at_ms is the server time each phone
    should have *sounded* its chirp. rec_start_ms: estimated server time of recording[0].

    Returns {id: {"delay_ms", "confidence"}} with delay relative to the median phone.
    """
    tmpl = chirp(sr)[::-1]
    n = len(recording) + len(tmpl) - 1
    nfft = 1 << (n - 1).bit_length()
    corr = np.fft.irfft(np.fft.rfft(recording, nfft) * np.fft.rfft(tmpl, nfft), nfft)[:n]
    corr = np.abs(corr[len(tmpl) - 1:])  # index = chirp start sample
    noise = float(np.median(corr)) + 1e-9

    found = {}
    for b in beeps:
        expect = (b["at_ms"] - rec_start_ms) * sr / 1000
        lo = int(max(0, expect - window_ms * sr / 1000))
        hi = int(min(len(corr), expect + window_ms * sr / 1000))
        if hi - lo < 10:
            continue
        seg = corr[lo:hi]
        i = int(np.argmax(seg))
        conf = float(seg[i] / noise)
        found[b["id"]] = {"offset_ms": (lo + i - expect) * 1000 / sr, "confidence": round(conf, 1), "level": float(seg[i])}

    good = [v["offset_ms"] for v in found.values() if v["confidence"] >= 6]
    if not good:
        return {k: {"delay_ms": None, "confidence": v["confidence"], "level": v["level"]} for k, v in found.items()}
    ref = float(np.median(good))
    return {k: {"delay_ms": round(v["offset_ms"] - ref, 1) if v["confidence"] >= 6 else None,
                "confidence": v["confidence"], "level": v["level"]} for k, v in found.items()}
