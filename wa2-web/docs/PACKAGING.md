# PACKAGING — self-contained builds and realistic sizes

Short answer: **yes, it self-packages today as a plain static folder** (engine
~69 KB + built data + converted assets). A full-experience package is
media-dominated: the installed reference archives measure ~8.0 GB (main 6.1 + IC 1.9), and the
current lossless-ish extraction lands around **5–7 GB**. With a
web-oriented transcode tier (WebP/AVIF images, Opus voice/SE, AV1/H.264
movies) the same content fits in roughly **2–4 GB**, and an aggressive
tier (smaller movies / stronger image quantization) can approach
**1.2–2.5 GB** without dropping content. Text-only (the entire story, no
art/audio) measured **16.4 MB on disk (12.8 MB compacted) / ~3.0 MB zipped**
for this build.

These are estimates from the measured archive sizes in
[BYOA.md](BYOA.md) and codec ratios; run the packer on a real install for
exact numbers (below).

## Build a package

```sh
cd wa2-web
python3 tools/build.py /path/to/en.pak /path/to/special-en.pak ./build \
  --game /path/to/game --mao /path/to/script-data
python3 tools/extract_assets.py /path/to/game ./build/assets \
  --en-pak /path/to/en.pak --en-pak /path/to/special-en.pak \
  --movie-crf 23 --movie-height 720      # optional web-size movie tier
# optional size pass (WebP images, Opus audio when ffmpeg is installed):
python3 tools/optimize_assets.py ./build/assets --webp-quality 88
python3 tools/pack_site.py --build --compact-json --zip
```

Output: `wa2-web/package/` plus `wa2-web/package.zip`.

```
package/
  index.html, static/*.js,*.css      built player (vite base "./")
  data/scripts/*.json, flow.json …   scenario/flow/audio timelines
  assets/…                           converted images/audio/movies + manifest
  start.sh / start.bat               python3 -m http.server launcher
  package-info.json                  per-section byte counts + zip stats
  README.txt                         personal-use notice
```

It is a static site: no server code, no database, saves stay in the
browser. `vite.config.ts` already uses `base: "./"`, so it works from any
subdirectory or host. A plain `file://` open **cannot** work because
browsers block `fetch()` for local JSON; use `start.sh` / `start.bat`
(or any static server).

`pack_site.py` writes text/JSON with deflate and stores already-compressed
media (PNG/OGG/Opus/MP4/…), so the zip pass is fast. Expect the zip to be
only a few percent smaller than the folder: nearly all bytes are media.
`--compact-json` minifies the shipped scenario/flow JSON (same parsed
content; typically saves 20–40 % of the data section).

## Why the current extractor is bigger than it needs to be

The extractor prioritises fidelity and tool simplicity:

| stage | current output | note |
|---|---|---|
| images | PNG (lossless) | TGA/BMP → PNG; alpha preserved |
| SE | WAV (PCM) | `.w` → RIFF WAV; no transcode |
| BGM | original OGG | already Vorbis |
| voice | original OGG | ~46k clips, already compressed |
| movies | H.264 CRF 21 + AAC | `ffmpeg -preset veryfast` |

A full install therefore lands near the archive total (~8.0 GB) minus
container overhead, or roughly **5–8 GB** after conversion (movies often
shrink; images can grow or shrink depending on the TGA's RLE).

`tools/optimize_assets.py` is the opt-in bridge to the lower tiers: it
converts PNGs to WebP/AVIF (manifest values are rewritten; keys stay
engine ids) and, when ffmpeg is installed, WAV/OGG to Opus at per-table
bitrates. It reports the before/after bytes and is safe to re-run. Keep an
unoptimized copy if you might want lossless assets later. Needs Pillow for
images and ffmpeg (libopus) for audio; a missing tool is reported and that
pass is skipped, not silently claimed.

## Size tiers (estimated, full content)

| tier | images | audio | movies | estimated folder | zipped |
|---|---|---|---|---|---|
| raw game archives (main + IC) | TGA in paks | OGG/WAV in paks | ASF/WMV in paks | **8.0 GB measured** | — |
| current extractor | PNG | OGG + WAV | H.264 CRF21 | 5–8 GB | 4.8–7.7 GB |
| web tier | WebP/AVIF q85–90 | Opus 24–32 kbps voice, 64–96 kbps BGM/SE | AV1/VP9 or H.264 CRF23 | 2–4 GB | 1.9–3.9 GB |
| aggressive | WebP q70–80 / AVIF q50 | Opus 20–24 kbps voice | 540p AV1/H.264 | 1.2–2.5 GB | 1.1–2.4 GB |
| text-only | — | — | — | **16.4 MB data (12.8 compact) + ~69 KB engine** | **~3.0 MB** |

Assumptions: 46k voice clips, 165 BGM tracks (main + IC + bonus), 1,962
SE files, 14.3k sprite statements (unique files fewer), 2.5 GB of movies.
Exact ratios vary with source resolution and clip length; the packer's
`package-info.json` is authoritative for a given install.

### What drives each tier

- **Images** are the largest lever. Lossy WebP/AVIF at q85–90 with alpha
  typically cuts PNG by 60–80 %; CGs/backdrops tolerate this well, while
  UI text art should stay lossless.
- **Voice** is already OGG; re-encoding to Opus 24–32 kbps mono cuts
  roughly 40–60 %. This is a second lossy generation, so keep the original
  paks if archival quality matters.
- **Movies** dominate the raw install (2.5 GB). H.264 CRF23 at 720p is
  usually 40–70 % smaller than the CRF21 `veryfast` default; AV1/VP9 can
  halve it again at the cost of much slower encoding.
- **SE WAV → Opus** is a big win per byte but only ~0.3–0.5 GB total.
- **Data JSON** is small next to media; minifying the emitted scripts and
  serving Brotli/gzip gets it under ~10 MB. Not worth format changes for a
  media-heavy package.

## Notes and limits

- **Legal:** the output contains copyrighted game assets. Build it for
  yourself; do not publish or redistribute it. The repo stays BYOA. See
  [LEGAL.md](LEGAL.md).
- **Single executable?** Possible with Tauri/Electron, but it adds a
  platform runtime (Electron ~100 MB, Tauri ~5–10 MB) and a webview version
  dependency, while the static folder already runs everywhere with Python.
  A PWA/service worker can make repeat visits offline but still needs the
  first load over HTTP.
- **Pruning:** `extract_assets.py` converts every file in every supplied
  pak. Dropping bonus-disc content or unreferenced files is possible, but
  needs a usage audit across every route (including variants). Treat it as
  an optional post-pass, not a default: a missing file is worse than a
  large package.
- **Text-only is the true minimum**, but `build.py` **without `--game`**
  emits the legacy EN-only IR (weaker parity: the JP spine, exact .bnr
  anchors and the JP option joins need `--game`). Text-only *with* `--game`
  keeps full path parity while missing assets render as placeholders; that
  package is ~16.4 MB (12.8 compacted, ~3.0 MB zipped).
