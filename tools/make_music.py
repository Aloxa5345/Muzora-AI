"""Muzora AI — original audio catalog generator.

Synthesizes 16 original instrumental tracks (one per catalog entry), each shaped
by its mood: chord progressions, bass, drums, arps, pads and textures. Output:
audio/track_XX.wav + audio/manifest.json with real durations.
"""
import json
import os
import random
import wave

import numpy as np

SR = 22050
OUT = os.path.join(os.path.dirname(__file__), "..", "audio")

# ------------------------------- catalog -----------------------------------
TRACKS = [
    dict(id=1,  title="Neon Monsoon",       artist="Aarya Vale",        genre="Dream Pop",     mood="energetic", bpm=128, root=57, prog="minor",    rain=True),
    dict(id=2,  title="Midnight Circuits",  artist="K3RN3L",            genre="Synthwave",     mood="energetic", bpm=112, root=55, prog="minor",    synthwave=True),
    dict(id=3,  title="Saawan Loops",       artist="Meher",             genre="Lo-fi",         mood="calm",      bpm=76,  root=60, prog="maj7",     crackle=True, rain=True, swing=True),
    dict(id=4,  title="Glass Horizon",      artist="Nova Tide",         genre="Ambient",       mood="calm",      bpm=62,  root=53, prog="maj7",     ambient=True),
    dict(id=5,  title="Tarang",             artist="Rivaa & The Waves", genre="Indie",         mood="happy",     bpm=120, root=62, prog="major",    pluck=True),
    dict(id=6,  title="Velocity Bloom",     artist="DJ Anvaya",         genre="EDM",           mood="energetic", bpm=130, root=57, prog="minor",    edm=True),
    dict(id=7,  title="Paper Planes at Dawn", artist="Ilham",           genre="Acoustic",      mood="calm",      bpm=82,  root=59, prog="major",    acoustic=True),
    dict(id=8,  title="Static Bloom",       artist="zephyr.wav",        genre="Chilltrap",     mood="dreamy",    bpm=84,  root=56, prog="add9",     halftime=True),
    dict(id=9,  title="Rooftop Rains",      artist="Kaia Menon",        genre="City Pop",      mood="happy",     bpm=116, root=64, prog="major",    rain=True, funky=True),
    dict(id=10, title="Hyperdrive",         artist="K3RN3L",            genre="Techno",        mood="energetic", bpm=138, root=52, prog="minor",    techno=True),
    dict(id=11, title="Slow Orbit",         artist="Nova Tide",         genre="Ambient",       mood="sleep",     bpm=58,  root=50, prog="drone",    ambient=True),
    dict(id=12, title="Jugnu",              artist="Aarya Vale",        genre="Folktronica",   mood="happy",     bpm=122, root=61, prog="major",    pluck=True),
    dict(id=13, title="Afterglow Study",    artist="Meher",             genre="Lo-fi",         mood="focus",     bpm=104, root=58, prog="maj7",     crackle=True),
    dict(id=14, title="Chrome Petals",      artist="zephyr.wav",        genre="Synthwave",     mood="dreamy",    bpm=92,  root=57, prog="add9",     synthwave=True),
    dict(id=15, title="Floe",               artist="Nova Tide",         genre="Ambient",       mood="focus",     bpm=108, root=60, prog="minor",    ambient=True),
    dict(id=16, title="Midnight Kathak",    artist="DJ Anvaya",         genre="Fusion",        mood="energetic", bpm=126, root=55, prog="minor",    drone=True),
]

MOOD_GAINS = {
    "energetic": dict(kick=1.00, snare=0.70, hat=0.50, bass=0.62, pad=0.34, arp=0.42, lead=0.40, texture=0.12),
    "happy":     dict(kick=0.80, snare=0.60, hat=0.45, bass=0.55, pad=0.38, arp=0.42, lead=0.36, texture=0.10),
    "focus":     dict(kick=0.46, snare=0.16, hat=0.22, bass=0.48, pad=0.46, arp=0.36, lead=0.24, texture=0.14),
    "calm":      dict(kick=0.14, snare=0.00, hat=0.14, bass=0.40, pad=0.55, arp=0.30, lead=0.22, texture=0.14),
    "dreamy":    dict(kick=0.30, snare=0.34, hat=0.18, bass=0.40, pad=0.55, arp=0.34, lead=0.26, texture=0.16),
    "sleep":     dict(kick=0.00, snare=0.00, hat=0.00, bass=0.30, pad=0.60, arp=0.16, lead=0.12, texture=0.10),
}

PROGRESSIONS = {
    "minor":  [(0, [0, 3, 7]), (8, [0, 4, 7]), (3, [0, 4, 7]), (10, [0, 4, 7])],
    "major":  [(0, [0, 4, 7]), (7, [0, 4, 7]), (9, [0, 3, 7]), (5, [0, 4, 7])],
    "maj7":   [(0, [0, 4, 7, 11]), (5, [0, 4, 7, 11]), (9, [0, 3, 7, 10]), (2, [0, 3, 7, 10])],
    "add9":   [(0, [0, 3, 7, 14]), (5, [0, 4, 7, 14])],
    "drone":  [(0, [0, 3, 7, 12]), (8, [0, 4, 7, 12])],
}

SCALES = {
    "minor":  [0, 2, 3, 5, 7, 8, 10],
    "major":  [0, 2, 4, 5, 7, 9, 11],
    "maj7":   [0, 2, 4, 5, 7, 9, 11],
    "add9":   [0, 2, 3, 5, 7, 10],
    "drone":  [0, 3, 5, 7, 10],
}


def midi(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def bl_saw(f, n, brightness=40):
    """Band-limited saw (additive) — alias-free."""
    K = max(1, min(brightness, int(9000 / f)))
    t = np.arange(n) / SR
    x = np.zeros(n)
    for k in range(1, K + 1):
        x += np.sin(2 * np.pi * f * k * t) / k
    return x * (2 / np.pi)


def bl_square(f, n):
    K = max(1, min(40, int(9000 / f)))
    t = np.arange(n) / SR
    x = np.zeros(n)
    for k in range(1, K + 1, 2):
        x += np.sin(2 * np.pi * f * k * t) / k
    return x * (2 / np.pi)


def sine(f, n):
    t = np.arange(n) / SR
    return np.sin(2 * np.pi * f * t)


def lowpass(x, fc, order=2):
    X = np.fft.rfft(x)
    fr = np.fft.rfftfreq(len(x), 1 / SR)
    H = 1.0 / (1.0 + (fr / fc) ** (2 * order))
    return np.fft.irfft(X * H, len(x))


def highpass(x, fc, order=2):
    X = np.fft.rfft(x)
    fr = np.fft.rfftfreq(len(x), 1 / SR)
    H = 1.0 - 1.0 / (1.0 + (fr / fc) ** (2 * order))
    return np.fft.irfft(X * H, len(x))


def env_ar(n, attack, release, curve=3.0):
    e = np.ones(n)
    na = max(1, int(attack * SR))
    nr = max(1, int(release * SR))
    if na < n:
        e[:na] = np.linspace(0, 1, na)
        e[na:] = 1.0
    else:
        e = np.linspace(0, 1, n)
    if nr < n:
        e[-nr:] *= np.linspace(1, 0, nr) ** 1.5
    return e


def env_decay(n, tau):
    t = np.arange(n) / SR
    return np.exp(-t / tau)


def place(buf, sig, pos):
    end = min(len(buf), pos + len(sig))
    if end > pos:
        buf[pos:end] += sig[: end - pos]


# ------------------------------ drums ---------------------------------------
def make_kick():
    n = int(0.30 * SR)
    t = np.arange(n) / SR
    f = 44 + 120 * np.exp(-t / 0.028)
    ph = 2 * np.pi * np.cumsum(f) / SR
    x = np.sin(ph) * np.exp(-t / 0.12)
    click = np.random.uniform(-1, 1, n) * np.exp(-t / 0.004) * 0.4
    return x + click


def make_snare():
    n = int(0.20 * SR)
    t = np.arange(n) / SR
    noise = np.random.uniform(-1, 1, n)
    noise = highpass(noise, 1800)
    amp = np.exp(-t / 0.07)
    tone = np.sin(2 * np.pi * 196 * t) * np.exp(-t / 0.045) * 0.5
    return noise * amp * 0.8 + tone


def make_hat(open_=False):
    dur = 0.26 if open_ else 0.055
    n = int(dur * SR)
    t = np.arange(n) / SR
    noise = np.random.uniform(-1, 1, n)
    for _ in range(2):
        noise = np.diff(np.pad(noise, (1, 0)))
    m = np.max(np.abs(noise)) or 1
    return (noise / m) * np.exp(-t / (0.10 if open_ else 0.016))


def make_clap():
    bursts = []
    for i, off in enumerate((0.0, 0.011, 0.023)):
        n = int(0.16 * SR)
        t = np.arange(n) / SR
        noise = highpass(np.random.uniform(-1, 1, n), 1200)
        bursts.append((noise * np.exp(-t / (0.018 if i < 2 else 0.055)), int(off * SR)))
    out = np.zeros(int(0.18 * SR))
    for sig, off in bursts:
        place(out, sig, off)
    m = np.max(np.abs(out)) or 1
    return out / m


# ------------------------------ tonal voices --------------------------------
def pad_chord(freqs, dur, attack=0.9, shimmer=0.0):
    n = int(dur * SR)
    out = np.zeros(n)
    for f in freqs:
        out += bl_saw(f, n, 28)
        out += bl_saw(f * 2 ** (7 / 1200), n, 24)  # detune layer
        if shimmer:
            out += sine(f * 2, n) * 0.3
    out /= (len(freqs) * 2.2)
    out = lowpass(out, 2600)
    return out * env_ar(n, min(attack, dur * 0.45), dur * 0.4)


def bass_note(f, dur, style="saw"):
    n = int(dur * SR)
    if style == "saw":
        x = bl_saw(f, n, 14) * 0.9 + bl_saw(f / 2, n, 8) * 0.4
        x = lowpass(x, 420)
    elif style == "sine":
        x = sine(f, n) + sine(f * 2, n) * 0.25
    else:  # sub
        x = sine(f / 2, n) + sine(f, n) * 0.2
    return x * env_ar(n, 0.008, min(0.08, dur * 0.3)) * 0.9


def pluck(f, dur, bright=6):
    n = int(dur * SR)
    t = np.arange(n) / SR
    x = np.zeros(n)
    for k in range(1, bright + 1):
        x += np.sin(2 * np.pi * f * k * t) / (k ** 0.8) * np.exp(-t * (1.4 + k * 1.1))
    return x * 0.5


def rhodes(f, dur):
    n = int(dur * SR)
    t = np.arange(n) / SR
    trem = 1 + 0.18 * np.sin(2 * np.pi * 5.2 * t)
    x = (np.sin(2 * np.pi * f * t) + 0.4 * np.sin(2 * np.pi * 2 * f * t) * np.exp(-t / 0.25)
         + 0.15 * np.sin(2 * np.pi * 4 * f * t) * np.exp(-t / 0.10))
    return x * env_ar(n, 0.012, dur * 0.35) * trem


def lead_note(f, dur):
    n = int(dur * SR)
    x = bl_saw(f, n, 20) * 0.7 + sine(f, n) * 0.5
    x = lowpass(x, 3200)
    return x * env_ar(n, 0.015, min(0.12, dur * 0.4)) * 0.8


# ------------------------------ textures ------------------------------------
def rain_texture(dur, gain=0.05):
    n = int(dur * SR)
    x = np.random.uniform(-1, 1, n)
    x = lowpass(x, 1400) + lowpass(np.random.uniform(-1, 1, n), 380) * 0.6
    t = np.arange(n) / SR
    lfo = 0.7 + 0.3 * np.sin(2 * np.pi * 0.07 * t)
    return x * lfo * gain


def crackle_texture(dur, gain=0.045):
    n = int(dur * SR)
    x = np.zeros(n)
    idx = np.sort(np.random.choice(n, int(dur * SR * 0.9), replace=False))
    x[idx] = np.random.uniform(-1, 1, len(idx)) ** 3
    return lowpass(x, 5200) * gain * 3


def noise_sweep(dur, gain=0.10):
    n = int(dur * SR)
    x = np.random.uniform(-1, 1, n)
    t = np.arange(n) / SR
    e = (t / dur) ** 2.2
    # chunked rising cutoff (8 static-filter segments approximating a sweep)
    segs = 8
    out = np.zeros(n)
    sl = max(1, n // segs)
    for i in range(segs):
        lo, hi = i * sl, min(n, (i + 1) * sl)
        fc = 900 + 6000 * ((i + 1) / segs) ** 2
        out[lo:hi] = lowpass(x[lo:hi], fc)
    return out * e * gain


# ------------------------------ arrangement ---------------------------------
def arrange(tr):
    rng = random.Random(1000 + tr["id"])
    g = MOOD_GAINS[tr["mood"]]
    bpm = tr["bpm"] + rng.uniform(-2, 2)
    beat = 60.0 / bpm
    bar = beat * 4
    prog = PROGRESSIONS[tr["prog"]]
    scale = SCALES[tr["prog"]]
    root = tr["root"]

    sections = []
    if tr["mood"] == "sleep" or tr.get("ambient"):
        plan = [("intro", 2), ("main", 6), ("break", 2), ("main2", 5), ("outro", 2)]
    elif tr["mood"] in ("energetic",):
        plan = [("intro", 2), ("main", 7), ("break", 2), ("main2", 6), ("outro", 1)]
    else:
        plan = [("intro", 1), ("main", 6), ("break", 2), ("main2", 5), ("outro", 1)]
    total_bars = sum(b for _, b in plan)
    dur = total_bars * bar
    n = int(dur * SR)

    drums = np.zeros(n)
    bass = np.zeros(n)
    pads = np.zeros(n)
    arps = np.zeros(n)
    leads = np.zeros(n)
    extra = np.zeros(n)

    kick, snare, hat_c, hat_o, clap = make_kick(), make_snare(), make_hat(False), make_hat(True), make_clap()

    halftime = tr.get("halftime", False)
    synthwave = tr.get("synthwave", False)
    techno = tr.get("techno", False)
    edm = tr.get("edm", False)
    funky = tr.get("funky", False)
    swing = tr.get("swing", False)
    acoustic = tr.get("acoustic", False)
    plucky = tr.get("pluck", False)
    rhodes_mode = tr.get("crackle", False)

    pos = 0.0
    bar_idx = 0
    for name, bars in plan:
        full = name in ("main", "main2")
        for b in range(bars):
            bstart = int(pos * SR)
            off = (b % len(prog)) if len(prog) < 4 else (bar_idx % len(prog))
            c_off, c_iv = prog[off]
            chord_midis = [root + c_off + iv + 12 for iv in c_iv]
            chord_freqs = [midi(m) for m in chord_midis]
            bass_f = midi(root + c_off - 12)

            # ---- pads ----
            pdur = bar * (0.98 if not tr.get("ambient") else 1.6)
            place(pads, pad_chord(chord_freqs, pdur, attack=beat * (2 if name != "intro" else 4)), bstart)

            # ---- bass ----
            if full or name == "intro":
                if tr["mood"] in ("sleep",) or tr.get("ambient") and not full:
                    place(bass, bass_note(bass_f, bar, "sub"), bstart)
                elif synthwave or techno:
                    for e in range(8):
                        if e % 2 == 0 or techno:
                            place(bass, bass_note(bass_f, beat / 2 * 0.9, "saw"),
                                  int((pos + e * beat / 2) * SR))
                elif funky:
                    pat = [0, 3, 6, 10, 12, 14]
                    for e, st in enumerate(pat):
                        f = bass_f * (2 if e in (2, 4) else 1)
                        place(bass, bass_note(f, beat / 4 * 0.9, "saw"),
                              int((pos + st * beat / 4) * SR))
                else:
                    for e in range(4):
                        if name != "intro" or e in (0, 2):
                            place(bass, bass_note(bass_f, beat * 0.85, "sine" if tr["mood"] == "calm" else "saw"),
                                  int((pos + e * beat) * SR))

            # ---- drums ----
            if full:
                if halftime:
                    place(drums, kick, int((pos + 0 * beat) * SR))
                    place(drums, kick, int((pos + 2.5 * beat) * SR))
                    place(drums, snare, int((pos + 2 * beat) * SR))
                    for e in range(8):
                        place(drums, hat_c, int((pos + e * beat / 2 + beat / 4) * SR))
                elif techno or edm:
                    for e in range(4):
                        place(drums, kick, int((pos + e * beat) * SR))
                    for e in range(4):
                        place(drums, hat_o, int((pos + e * beat + beat / 2) * SR))
                    if bar_idx % 2 == 1:
                        place(drums, clap, int((pos + 2 * beat) * SR))
                elif synthwave:
                    place(drums, kick, int((pos + 0.0) * SR))
                    place(drums, kick, int((pos + 2.5 * beat) * SR))
                    place(drums, snare, int((pos + 2 * beat) * SR))
                    for e in range(8):
                        place(drums, hat_c, int((pos + e * beat / 2) * SR))
                else:
                    for e in range(4):
                        place(drums, kick, int((pos + e * beat) * SR)) if tr["mood"] == "energetic" or e in (0, 2) else None
                    if tr["mood"] == "energetic" or tr.get("drone"):
                        for e in range(4):
                            if e in (1, 3):
                                place(drums, kick, int((pos + e * beat) * SR))
                    place(drums, snare if tr["mood"] != "happy" else clap, int((pos + 1 * beat) * SR))
                    place(drums, snare if tr["mood"] != "happy" else clap, int((pos + 3 * beat) * SR))
                    steps = 8 if swing else 4
                    for e in range(steps):
                        sw = beat * 0.08 * (e % 2) if swing else 0
                        place(drums, hat_c, int((pos + e * beat / (steps / 4) + sw) * SR))
            elif name == "break" and tr["mood"] != "sleep":
                place(drums, kick, bstart)
                place(drums, hat_c, int((pos + 2 * beat) * SR))

            # ---- arp ----
            arp_notes = [root + c_off + iv + 24 for iv in c_iv] + [root + c_off + 12 + c_iv[-1]]
            if full or name == "intro":
                if rhodes_mode:
                    place(arps, rhodes(chord_freqs[0], beat * 3.5), int((pos) * SR))
                    place(arps, rhodes(chord_freqs[2], beat * 1.5), int((pos + 2 * beat) * SR))
                elif acoustic or plucky:
                    pattern = [0, 2, 1, 3, 2, 4, 1, 2] if plucky else [0, 1, 2, 1, 3, 1, 2, 4]
                    for e, pi in enumerate(pattern):
                        if pi < len(arp_notes):
                            place(arps, pluck(midi(arp_notes[pi] - 12), beat / 2 * 0.9, 7),
                                  int((pos + e * beat / 2) * SR))
                elif tr.get("ambient"):
                    if bar_idx % 2 == 0:
                        place(arps, pluck(midi(arp_notes[rng.randrange(len(arp_notes))]), beat * 6, 3),
                              int((pos + beat) * SR))
                else:
                    for e in range(8):
                        ni = arp_notes[e % len(arp_notes)]
                        place(arps, lead_note(midi(ni), beat / 2 * 0.85), int((pos + e * beat / 2) * SR))

            # ---- lead melody in main2 ----
            if name == "main2" and tr["mood"] not in ("sleep",):
                deg = 0
                for e in range(4):
                    if rng.random() < 0.75:
                        step = rng.choice([-2, -1, 1, 2, 0])
                        deg = max(0, min(len(scale) - 1, deg + step))
                        m = root + 24 + scale[deg]
                        ldur = beat * (1 if rng.random() < 0.6 else 0.5)
                        place(leads, lead_note(midi(m), ldur * 0.9), int((pos + e * beat) * SR))

            pos += bar
            bar_idx += 1

        if name == "break" and edm:
            place(extra, noise_sweep(bar * 2, 0.16), int((pos - bar * 2) * SR))

    # ---- textures ----
    if tr.get("rain"):
        extra += rain_texture(dur, 0.05 if tr["mood"] == "calm" else 0.035)
    if tr.get("crackle"):
        extra += crackle_texture(dur)
    if tr.get("drone"):
        extra += lowpass(pad_chord([midi(root - 12), midi(root - 5)], dur, attack=dur * 0.3), 500) * 0.5

    # ---- mix ----
    mix = (drums * 0.95 + bass * g["bass"] + pads * g["pad"] + arps * g["arp"]
           + leads * g["lead"] + extra * g["texture"])
    # per-mood drum balance: kick/snare/hat already baked proportionally
    mix = np.tanh(mix * 1.25) * 0.9
    peak = np.max(np.abs(mix)) or 1
    mix = mix / peak * 0.92

    fade_in = 0.4 if tr["mood"] not in ("sleep",) else 2.0
    fade_out = 2.5 if tr["mood"] not in ("sleep",) else 5.0
    fi = int(fade_in * SR)
    fo = int(fade_out * SR)
    mix[:fi] *= np.linspace(0, 1, fi) ** 0.7
    mix[-fo:] *= np.linspace(1, 0, fo) ** 1.2

    return mix, dur


def save_wav(path, x):
    y = (np.clip(x, -1, 1) * 32767).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(y.tobytes())


def main():
    os.makedirs(OUT, exist_ok=True)
    manifest = []
    for tr in TRACKS:
        fname = f"track_{tr['id']:02d}.wav"
        path = os.path.join(OUT, fname)
        x, dur = arrange(tr)
        save_wav(path, x)
        manifest.append(dict(id=tr["id"], file=fname, duration=round(dur, 2)))
        print(f"  {fname}  {tr['title']:24s} {dur:6.1f}s  {os.path.getsize(path)//1024} KB")
    with open(os.path.join(OUT, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    print("manifest.json written")


if __name__ == "__main__":
    main()
