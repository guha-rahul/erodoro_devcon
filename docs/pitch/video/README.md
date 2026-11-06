# Rips teaser (HyperFrames)

The 15-second teaser as a [HyperFrames](https://github.com/heygen-com/hyperframes) composition: `index.html` holds the scenes and one paused GSAP timeline, and two `<audio>` clips carry the music bed and the sound effects.

Everything sits on a 120 bpm grid (one bar = 2 s), so every scene cut lands on a downbeat.

- `audio/music.py` writes `assets/music.wav`: an a-minor house cue with an intro, a build with a snare roll, two drops (the rip at 4 s, the positioning line at 10 s) and an outro. It has layered drums, a house bass, organ stabs, a ping-pong arp, convolution reverb, a kick sidechain and glue saturation.
- `audio/sfx.py` writes `assets/sfx.wav`: whooshes, slams, a UI tap, the pack rip with paper flutter, reel ticks, the landing ding, pops and chimes, with their own reverb, on the same cue times as the timeline.
- Fonts (Source Serif 4, Inter, IBM Plex Mono; SIL OFL) and GSAP are vendored under `assets/` so a render needs no network.

Both audio scripts need only Python 3 and numpy.

```sh
python3 audio/music.py assets/music.wav
python3 audio/sfx.py assets/sfx.wav
npx --yes hyperframes@0.8.147 check
npx --yes hyperframes@0.8.147 render -f 30 -q high -o ../rips-teaser.mp4
```

Set `HYPERFRAMES_BROWSER_PATH` to a local Chrome headless shell if the CLI can't download one.
