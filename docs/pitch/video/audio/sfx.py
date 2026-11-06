"""Sound design for the Rips teaser, synthesized with numpy (no samples).

Cue times mirror the GSAP timeline in index.html (120 bpm, one bar = 2 s).
Usage: python3 sfx.py out.wav
"""
import sys
import wave
import numpy as np

SR = 48_000
DUR = 15.0
N = int(SR * DUR)
rng = np.random.default_rng(7)
L = np.zeros(N)
R = np.zeros(N)
send = np.zeros(N)  # reverb send


def ts(n):
    return np.arange(n) / SR


def fft_filter(x, lo=0, hi=SR / 2):
    f = np.fft.rfft(x)
    fr = np.fft.rfftfreq(len(x), 1 / SR)
    g = np.ones_like(fr)
    if lo > 0:
        g *= 1 / (1 + np.exp(-(fr - lo) / (lo / 6 + 1)))
    if hi < SR / 2:
        g *= 1 / (1 + np.exp((fr - hi) / (hi / 6 + 1)))
    return np.fft.irfft(f * g, len(x))


def add(at, sig, gain=1.0, pan=0.0, verb=0.15):
    i = int(round(at * SR))
    j = min(N, i + len(sig))
    s = sig[: j - i] * gain
    L[i:j] += s * np.sqrt((1 - pan) / 2) * 1.414
    R[i:j] += s * np.sqrt((1 + pan) / 2) * 1.414
    send[i:j] += s * verb


def env(n, a, d):
    t = ts(n)
    return np.clip(t / max(a, 1e-4), 0, 1) * np.exp(-np.maximum(t - a, 0) / d)


def whoosh(dur=0.32, up=False):
    n = int(dur * SR)
    t = ts(n)
    x = rng.standard_normal(n)
    k = t / dur
    sweep = k if up else np.sin(np.pi * k)
    body = fft_filter(x, 250, 3000) * (1 - sweep * 0.6) + fft_filter(x, 3000, 12000) * sweep
    shape = (k ** 2 * np.exp(-((k - 0.85) ** 2) / 0.02) * 3) if up else np.sin(np.pi * k) ** 2
    return body * shape


def slam(dur=0.45):
    n = int(dur * SR)
    t = ts(n)
    body = np.sin(2 * np.pi * np.cumsum(40 + 90 * np.exp(-t / 0.035)) / SR) * env(n, 0.002, 0.14)
    click = fft_filter(rng.standard_normal(n), 1500, 8000) * env(n, 0.0005, 0.01)
    return np.tanh(1.4 * body) + 0.45 * click


def pop(f0=1100, f1=320, dur=0.08):
    n = int(dur * SR)
    t = ts(n)
    f = f1 + (f0 - f1) * np.exp(-t / 0.012)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * env(n, 0.001, 0.022)


def tick(bright=3500):
    n = int(0.03 * SR)
    return fft_filter(rng.standard_normal(n), bright * 0.5, bright * 1.6) * env(n, 0.0004, 0.006)


def ui_click():
    n = int(0.06 * SR)
    t = ts(n)
    return (np.sin(2 * np.pi * 2400 * t) * env(n, 0.0005, 0.008) + 0.6 * np.sin(2 * np.pi * 900 * t) * env(n, 0.001, 0.02))


def rip(dur=0.42):
    n = int(dur * SR)
    t = ts(n)
    base = fft_filter(rng.standard_normal(n), 800, 9000)
    grains = np.zeros(n)
    for _ in range(320):
        k = int(rng.uniform(0, 0.92) ** 1.3 * n)
        m = min(80, n - k)
        grains[k:k + m] += rng.uniform(0.3, 1.0) * np.exp(-np.arange(m) / 15)
    return base * (0.3 + grains) * np.clip(t / 0.01, 0, 1) * np.exp(-t / 0.2)


def flutter(dur=0.6):
    n = int(dur * SR)
    t = ts(n)
    x = fft_filter(rng.standard_normal(n), 1500, 7000)
    am = 0.5 + 0.5 * np.sin(2 * np.pi * (18 - 10 * t / dur) * t)
    return x * am * np.exp(-t / 0.25) * 0.5


def ding(freqs=(1318.5, 1975.5, 2637.0), dur=1.3):
    n = int(dur * SR)
    t = ts(n)
    return sum(np.sin(2 * np.pi * f * t) * 0.6 ** i for i, f in enumerate(freqs)) * env(n, 0.003, 0.32)


def thud():
    n = int(0.4 * SR)
    t = ts(n)
    return np.sin(2 * np.pi * np.cumsum(48 + 60 * np.exp(-t / 0.025)) / SR) * env(n, 0.002, 0.1)


def swoosh_up(dur=0.45):
    n = int(dur * SR)
    t = ts(n)
    k = t / dur
    tone = np.sin(2 * np.pi * np.cumsum(300 + 2200 * k ** 2) / SR) * 0.3
    air = fft_filter(rng.standard_normal(n), 1500, 12000) * 0.7
    return (tone + air) * np.sin(np.pi * k) ** 1.5


# --------------------------------------------------------------- cue sheet
# A: cold open
for i in range(6):  # mono label ticks in
    add(0.15 + i * 0.045, tick(4200), 0.25, 0.3)
add(1.0, slam(), 0.85)
for i in range(10):  # counter 0c -> 10c
    add(1.0 + i * 0.04, tick(2800), 0.18)
add(1.82, whoosh(0.3), 0.55, -0.3)          # rust wipe
# B: kinetic question
for i, at in enumerate((2.0, 2.25, 2.5, 2.75)):
    add(at, pop(900 + i * 110, 320), 0.42, -0.3 + 0.2 * i)
add(3.0, slam(), 0.9, verb=0.3)
add(3.55, whoosh(0.45, up=True), 0.6)       # zoom through
# C: product
add(4.0, thud(), 0.9)
add(4.0, whoosh(0.35), 0.35, 0.3)
add(4.95, ui_click(), 0.55, 0.1, verb=0.2)
add(5.0, swoosh_up(0.3), 0.45)
add(5.5, rip(), 0.95, -0.1, verb=0.2)
add(5.55, flutter(), 0.6, 0.3)
n_items, spin0, land = 39, 5.62, 6.5
for k in range(1, n_items + 1):
    x = 1 - (1 - k / n_items) ** 0.25  # power3.out inverse
    add(spin0 + x * (land - spin0), tick(), 0.45, 0.0)
add(land, ding(), 0.55, verb=0.5)
add(land, slam(0.3), 0.55)
for i in range(3):
    add(land + 0.15 + i * 0.15, pop(1000 + i * 120, 380), 0.3)
add(7.85, whoosh(0.3), 0.5, 0.3)
# D: mechanic
for i in range(3):
    add(8.0 + i * 0.5, pop(950 + i * 150, 330), 0.45, -0.4 + 0.4 * i)
    add(8.15 + i * 0.5, tick(5000), 0.15)
add(9.85, whoosh(0.3), 0.5, -0.3)
# E: positioning
add(10.05, pop(700, 250, 0.1), 0.5)
add(10.4, swoosh_up(0.45), 0.6, 0.4, verb=0.3)
add(10.5, slam(), 0.95, verb=0.3)
add(11.85, whoosh(0.3), 0.5, 0.3)
# F: end card
for i in range(7):
    add(12.0 + i * 0.06, tick(3000 + i * 250), 0.3, -0.45 + 0.15 * i)
add(12.5, slam(0.35), 0.7)
add(13.0, ding((1046.5, 1568.0, 2093.0)), 0.3, verb=0.6)
add(13.25, pop(1300, 600, 0.06), 0.25)
add(13.5, ding((1568.0, 2349.3, 3136.0)), 0.22, verb=0.6)

# --------------------------------------------------------------- reverb + master
n = int(1.6 * SR)
t = ts(n)
irl = fft_filter(rng.standard_normal(n) * np.exp(-t / 0.4), 300, 9000)
irr = fft_filter(rng.standard_normal(n) * np.exp(-t / 0.4), 300, 9000)
irl /= np.sqrt(np.sum(irl ** 2))
irr /= np.sqrt(np.sum(irr ** 2))
m = N + n - 1
nfft = 1 << (m - 1).bit_length()
S = np.fft.rfft(send, nfft)
L += np.fft.irfft(S * np.fft.rfft(irl, nfft), nfft)[:N] * 0.8
R += np.fft.irfft(S * np.fft.rfft(irr, nfft), nfft)[:N] * 0.8

peak = max(np.max(np.abs(L)), np.max(np.abs(R)))
L, R = np.tanh(1.2 * L / peak) / np.tanh(1.2), np.tanh(1.2 * R / peak) / np.tanh(1.2)
stereo = np.stack([L, R], axis=1) * 10 ** (-1 / 20)
fade = int(0.3 * SR)
stereo[-fade:] *= np.linspace(1, 0, fade)[:, None]
with wave.open(sys.argv[1] if len(sys.argv) > 1 else "sfx.wav", "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((stereo * 32767).astype(np.int16).tobytes())
print("wrote sfx", DUR, "s")
