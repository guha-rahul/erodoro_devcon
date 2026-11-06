"""Score for the Rips teaser: 120 bpm, 15 s, a minor house cue. numpy only.

One bar = 2 s, so the picture's cuts (2, 4, 8, 10, 12 s) land on downbeats.
  0-2    intro: filtered chords open up, heartbeat sub on the 1.0 slam, riser
  2-4    build: four-on-the-floor kick under a filter sweep, snare roll, reverse crash
  4-8    drop 1 (the rip): full groove, house bass, organ stabs, ping-pong arp
  8-10   groove, arp an octave up, roll into 10
  10-12  drop 2: crash, the biggest section
  12-15  outro: crash, two chord hits, kick out at 13, last stab rings into reverb
Mix: dry bus + convolution reverb send + tempo-synced delay, kick sidechain,
tape-style saturation, mastered to about -12 LUFS before the composition mix.
Usage: python3 music.py out.wav
"""
import sys
import wave
import numpy as np

SR = 48_000
BPM = 120
BEAT = 60 / BPM
S16 = BEAT / 4
DUR = 15.0
N = int(SR * DUR)
rng = np.random.default_rng(23)


def midi(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def ts(n):
    return np.arange(n) / SR


class Bus:
    def __init__(self):
        self.l = np.zeros(N)
        self.r = np.zeros(N)

    def add(self, at, sig, gain=1.0, pan=0.0):
        i = int(round(at * SR))
        if i >= N or i + len(sig) <= 0:
            return
        j = min(N, i + len(sig))
        s = sig[: j - i] * gain
        self.l[i:j] += s * np.sqrt((1 - pan) / 2) * 1.414
        self.r[i:j] += s * np.sqrt((1 + pan) / 2) * 1.414


def fft_filter(x, lo=0, hi=SR / 2, slope=200.0):
    f = np.fft.rfft(x)
    fr = np.fft.rfftfreq(len(x), 1 / SR)
    g = np.ones_like(fr)
    if lo > 0:
        g *= 1 / (1 + np.exp(-(fr - lo) / (lo / 6 + 1)))
    if hi < SR / 2:
        g *= 1 / (1 + np.exp((fr - hi) / (hi / 6 + 1)))
    return np.fft.irfft(f * g, len(x))


def noise(n):
    return rng.standard_normal(n)


def env(n, a, decay):
    t = ts(n)
    return np.clip(t / max(a, 1e-4), 0, 1) * np.exp(-np.maximum(t - a, 0) / decay)


# ---------------------------------------------------------------- instruments
def kick():
    n = int(0.5 * SR)
    t = ts(n)
    f = 46 + 140 * np.exp(-t / 0.028)
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.22)
    body = np.tanh(body * 1.6)
    click = fft_filter(noise(n), 2500, 9000) * np.exp(-t / 0.003)
    return body + 0.3 * click


def clap():
    n = int(0.35 * SR)
    t = ts(n)
    x = fft_filter(noise(n), 1000, 6000)
    bursts = sum((t >= d) * np.exp(-np.maximum(t - d, 0) / 0.007) for d in (0, 0.009, 0.019))
    tail = (t >= 0.028) * np.exp(-np.maximum(t - 0.028, 0) / 0.11)
    return x * (0.7 * bursts + 0.45 * tail)


def snare(tone=190):
    n = int(0.25 * SR)
    t = ts(n)
    return fft_filter(noise(n), 1200, 9000) * np.exp(-t / 0.07) * 0.8 + np.sin(2 * np.pi * tone * t) * np.exp(-t / 0.05) * 0.6


def hat(length=0.04):
    n = int(max(length * 3, 0.05) * SR)
    return fft_filter(noise(n), 7500, 17000) * np.exp(-ts(n) / length)


def shaker():
    n = int(0.06 * SR)
    t = ts(n)
    return fft_filter(noise(n), 4500, 11000) * np.clip(t / 0.008, 0, 1) * np.exp(-t / 0.018)


def crash(length=1.8):
    n = int(length * SR)
    t = ts(n)
    metal = sum(np.sin(2 * np.pi * f * t + p) for f, p in zip((3170, 4210, 5370, 6930, 8460, 9890), rng.uniform(0, 6, 6)))
    x = fft_filter(noise(n), 3500, 18000) + 0.15 * metal
    return x * env(n, 0.002, length / 3.2)


def sub_note(freq, dur):
    n = int(dur * SR)
    t = ts(n)
    return np.sin(2 * np.pi * freq * t) * np.clip(t / 0.005, 0, 1) * np.clip((dur - t) / 0.03, 0, 1)


def mid_bass(freq, dur):
    n = int(dur * SR)
    t = ts(n)
    out = sum(np.sin(2 * np.pi * k * freq * t) / k * np.exp(-t * (2 + 2.5 * k)) for k in range(1, 12))
    return np.tanh(out * 2.2) * np.clip((dur - t) / 0.02, 0, 1)


def organ_stab(notes, dur=0.32):
    n = int(dur * SR)
    t = ts(n)
    out = np.zeros(n)
    for m in notes:
        f = midi(m)
        for k, a in ((1, 1.0), (2, 0.55), (3, 0.3), (4, 0.18), (6, 0.08)):
            out += a * np.sin(2 * np.pi * k * f * t * (1 + 0.0007 * k))
    return out * env(n, 0.003, 0.11) / len(notes)


def pad(notes, dur, cutoff_fn, start):
    n = int(dur * SR)
    t = ts(n)
    cut = cutoff_fn(start + t)
    out = np.zeros(n)
    for m in notes:
        for det in (-0.08, 0.0, 0.07):
            f = midi(m) * 2 ** (det / 12)
            k = 1
            while k * f < 7000:
                out += (1 / k) * np.clip((cut - k * f) / 500 + 1, 0, 1) * np.sin(2 * np.pi * k * f * t + 1.3 * k * det)
                k += 1
    shape = np.clip(t / 0.35, 0, 1) * np.clip((dur - t) / 0.4, 0, 1)
    return out * shape / len(notes)


def pluck(freq, dur=0.4):
    n = int(dur * SR)
    t = ts(n)
    out = sum(np.sin(2 * np.pi * k * freq * t) * np.exp(-t * (7 + 6 * k)) / k for k in range(1, 7))
    return out * np.clip(t / 0.002, 0, 1)


def riser(dur):
    n = int(dur * SR)
    t = ts(n)
    k = (t / dur) ** 2
    x = noise(n)
    sweep = fft_filter(x, 300, 2500) * (1 - k) + fft_filter(x, 2500, 14000) * k
    tone = np.sin(2 * np.pi * np.cumsum(220 + 1500 * k ** 1.5) / SR) * 0.25
    return (sweep + tone) * k


def impact():
    n = int(1.6 * SR)
    t = ts(n)
    boom = np.sin(2 * np.pi * np.cumsum(38 + 60 * np.exp(-t / 0.06)) / SR) * np.exp(-t / 0.5)
    air = fft_filter(noise(n), 200, 5000) * np.exp(-t / 0.3)
    return np.tanh(boom * 1.5) + 0.35 * air


# ---------------------------------------------------------------- harmony
CHORDS = [  # (pad/stab voicing, bass root) per bar
    ([57, 60, 64, 67, 71], 33),  # am9
    ([53, 57, 60, 64, 67], 29),  # fmaj9
    ([55, 60, 64, 67, 71], 36),  # cmaj7
    ([55, 59, 62, 64, 67], 31),  # g6
    ([57, 60, 64, 67, 71], 33),  # am9
    ([53, 57, 60, 64, 67], 29),  # fmaj9
    ([55, 60, 64, 67, 74], 36),  # cmaj9
    ([55, 60, 64, 67, 74], 36),
]


def bar_of(t):
    return min(int(t // 2.0), 7)


dry, rev_send, dly_send, side = Bus(), Bus(), Bus(), Bus()  # side = sidechained group


# ---------------------------------------------------------------- arrangement
def pad_cut(t):
    t = np.asarray(t)
    return np.select([t < 2.0, t < 4.0, t < 12.0], [350 + 900 * (t / 2.0) ** 2, 1250 + 2200 * ((t - 2.0) / 2.0) ** 2, 3800], 2600)


for b, (notes, _) in enumerate(CHORDS):
    start = b * 2.0
    dur = min(2.4, DUR - start)
    p = pad(notes, dur, pad_cut, start)
    side.add(start, p, 0.16, -0.25)
    side.add(start, pad([x + 12 for x in notes[1:4]], dur, pad_cut, start), 0.05, 0.3)
    rev_send.add(start, p, 0.08)

# heartbeat sub in the intro, landing on the 1.0 slam
for at in (0.0, 1.0, 1.5):
    dry.add(at, sub_note(55, 0.3) * np.exp(-ts(int(0.3 * SR)) / 0.12), 0.5)

kicks = [2.0 + i * BEAT for i in range(int((13.0 - 2.0) / BEAT))]
for at in kicks:
    k = kick()
    gain = 0.9 if at >= 4.0 else 0.55 + 0.35 * (at - 2.0) / 2.0
    dry.add(at, k, gain)

# claps on 2 and 4 from the drop, snare roll into each drop
for at in np.arange(4.0, 13.0, BEAT):
    if round((at % 2.0) / BEAT) in (1, 3):
        c = clap()
        dry.add(at, c, 0.42)
        rev_send.add(at, c, 0.12)
roll = []
t_r, step = 3.0, S16 * 2
while t_r < 4.0 - 1e-6:
    roll.append(t_r)
    if t_r >= 3.5:
        step = S16 / 2
    elif t_r >= 3.25:
        step = S16
    t_r += step
for at in roll:
    x = (at - 3.0)
    dry.add(at, snare(170 + 120 * x), 0.15 + 0.35 * x)
    rev_send.add(at, snare(), 0.1)
for i, at in enumerate(np.arange(9.0, 10.0, S16)):
    dry.add(at, snare(200 + 60 * i / 8), 0.1 + 0.3 * (at - 9.0))

# hats: offbeat open hats in the drops, 16th shaker with swing
for at in np.arange(BEAT / 2, 13.0, BEAT):
    if at < 2.0:
        dry.add(at, hat(0.02), 0.08, 0.3)
    else:
        dry.add(at, hat(0.07 if at >= 4.0 else 0.03), 0.09, 0.25)
for i, at in enumerate(np.arange(4.0, 13.0, S16)):
    swing = 0.018 if i % 2 else 0.0
    accent = 1.0 if i % 4 == 2 else 0.55
    dry.add(at + swing, shaker(), 0.035 * accent, -0.4)

# crashes and reverse crashes into the drops
for at in (4.0, 10.0, 12.0):
    c = crash()
    dry.add(at, c, 0.1, 0.2)
    rev_send.add(at, c, 0.04)
for end in (4.0, 10.0):
    rc = crash(1.0)[::-1]
    dry.add(end - 1.0, rc, 0.1, -0.2)

# risers and impacts
dry.add(0.4, riser(1.6), 0.13)
dry.add(8.6, riser(1.4), 0.12)
for at in (2.0, 4.0, 10.0, 12.0):
    im = impact()
    dry.add(at, im, 0.45 if at != 2.0 else 0.3)
    rev_send.add(at, im, 0.2)

# bass: house offbeat sub + bitten mid bass, from the drop
for b in range(2, 7):
    root = CHORDS[b][1]
    for s in range(8):
        at = b * 2.0 + s * BEAT / 2
        if at >= 13.0:
            break
        if s % 2 == 1 or at < 4.0:  # offbeats in the drops; straight 8ths through the build
            m = root + (12 if s == 7 else 0)
            side.add(at, sub_note(midi(m + 12), BEAT / 2 * 0.85), 0.5)
            side.add(at, mid_bass(midi(m + 24), BEAT / 2 * 0.8), 0.12 if at >= 4.0 else 0.06)

# organ stabs: syncopated house pattern on 16ths
STAB = [0, 3, 6, 10, 14]
for b in range(2, 8):
    start = b * 2.0
    for s16 in STAB:
        at = start + s16 * S16
        if at >= 14.0 or (b == 7 and s16 > 0):
            continue
        st = organ_stab(CHORDS[b][0][1:], 0.3)
        side.add(at, st, 0.32 if b >= 2 else 0.2, 0.15)
        rev_send.add(at, st, 0.12)
        dly_send.add(at, st, 0.1)
# final stab rings into reverb
last = organ_stab(CHORDS[7][0], 0.8)
dry.add(14.0, last, 0.42)
rev_send.add(14.0, last, 0.5)

# arp from the drop, octave up from 8, ping-pong delay
ARP = [0, 2, 4, 2, 1, 3, 4, 3]
for b in range(2, 7):
    oct_ = 24 if b >= 4 else 12
    for s, idx in enumerate(ARP):
        at = b * 2.0 + s * BEAT / 2
        if at < 4.0:
            continue
        pl = pluck(midi(CHORDS[b][0][idx] + oct_))
        side.add(at, pl, 0.1, 0.35 if s % 2 else -0.35)
        dly_send.add(at, pl, 0.12)

# ---------------------------------------------------------------- effects
def reverb_ir(seconds=2.4, decay=0.55):
    n = int(seconds * SR)
    t = ts(n)
    irl = noise(n) * np.exp(-t / decay)
    irr = noise(n) * np.exp(-t / decay)
    irl[:int(0.012 * SR)] = 0  # pre-delay
    irr[:int(0.017 * SR)] = 0
    irl = fft_filter(irl, 250, 9000)
    irr = fft_filter(irr, 250, 9000)
    return irl / np.sqrt(np.sum(irl ** 2)), irr / np.sqrt(np.sum(irr ** 2))


def convolve(x, ir):
    m = len(x) + len(ir) - 1
    nfft = 1 << (m - 1).bit_length()
    y = np.fft.irfft(np.fft.rfft(x, nfft) * np.fft.rfft(ir, nfft), nfft)[: len(x)]
    return y


irl, irr = reverb_ir()
wet_l = convolve(rev_send.l + rev_send.r, irl) * 0.9
wet_r = convolve(rev_send.l + rev_send.r, irr) * 0.9

# ping-pong delay, dotted 8th
d = int(BEAT * 0.75 * SR)
dl, dr = np.zeros(N), np.zeros(N)
src = fft_filter(dly_send.l + dly_send.r, 400, 6000)
fb = 0.45
for k in range(1, 6):
    shift = d * k
    if shift >= N:
        break
    tap = np.zeros(N)
    tap[shift:] = src[: N - shift] * (fb ** (k - 1))
    if k % 2:
        dl += tap
    else:
        dr += tap

# sidechain: duck the side group under every kick
duck = np.ones(N)
for at in kicks:
    i = int(at * SR)
    n = min(N - i, int(0.3 * SR))
    curve = 1 - 0.7 * np.exp(-ts(n) / 0.075)
    duck[i:i + n] = np.minimum(duck[i:i + n], curve)

L = dry.l + side.l * duck + wet_l + dl * 0.8
R = dry.r + side.r * duck + wet_r + dr * 0.8

# master: gentle low-end tidy, glue saturation, fade, normalise
L = fft_filter(L, 28)
R = fft_filter(R, 28)
fade = int(0.9 * SR)
ramp = np.linspace(1, 0, fade) ** 1.6
L[-fade:] *= ramp
R[-fade:] *= ramp
pre = max(np.max(np.abs(L)), np.max(np.abs(R)))
L, R = L / pre, R / pre
drive = 1.25  # glue, not a limiter
L, R = np.tanh(L * drive) / np.tanh(drive), np.tanh(R * drive) / np.tanh(drive)
peak = max(np.max(np.abs(L)), np.max(np.abs(R)))
gain = 10 ** (-1 / 20) / peak
stereo = np.stack([L, R], axis=1) * gain
with wave.open(sys.argv[1] if len(sys.argv) > 1 else "music.wav", "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((stereo * 32767).astype(np.int16).tobytes())
print("wrote music", DUR, "s at", BPM, "bpm")
