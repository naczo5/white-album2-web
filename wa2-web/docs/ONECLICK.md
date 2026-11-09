# ONECLICK — images/install → playable local web app

`tools/oneclick.py` (and `./play.sh`) is the whole path:

```
disc images / installed game
  -> extract (no Wine, no installer execution)
  -> build JP-spine data (flow, .bnr timelines, voices, flags)
  -> extract browser assets (images/audio/movies)
  -> build the Vite app
  -> serve it locally and open the browser
```

It is **generic by design**: the script does not contain or choose archive.org
item IDs. You supply the item URL or local image paths. You must own the game;
archive.org copies are not necessarily authorized, so use this only for your
own legally-owned copy and never redistribute the output.

## Quick start

### Already have the installed/extracted game

```sh
cd wa2-web
./play.sh --game-dir /path/to/game
```

The script also auto-uses `../.cache/game` when it exists (see the README of
your checkout), so a plain `./play.sh` can be enough after a previous
`--game-dir` run.

It auto-detects the MAO release under `../.cache/mao_v210` and the manuscript
clone under `../.cache/upstream/mao-white-album-2`. If they are missing, pass
`--mao-zip` / `--mao-dir` (see below).

### From local disc images

```sh
./play.sh \
  --image /path/disc1.iso \
  --image /path/disc2.iso \
  --mao-zip /path/White_Album_2_Complete_English_Release_v2.1.0.zip \
  --i-own-the-game
```

Multi-disc is supported: extract everything into one staging tree, then find
the main `script.pak` and use the whole tree for asset extraction. `.iso`,
`.mdf`/`.mds`, `.bin`, `.zip`, `.7z`, `.rar`, and split `.7z.001` parts are
accepted where the available extractor supports them (`7z` for `.mdf`/`.bin`).

### From an archive.org item

The script does not download items by itself. You download the files, and
`data/archive-checksums.json` (the repo hash sheet: names, sizes, MD5s for the
copy you verify against) lets the script confirm it locally:

```sh
./play.sh --verify-only --source-dir /path/to/your-download
#   archive copy verified: N/N files        (uses the repo hash sheet)
#   --hashes /path/other.json               (override sheet)
#   --hashes ''                            (skip the check)
#   --strict-hashes                         (fail the build on mismatch)
```

The sheet is advisory for a normal build: if the files you have are a
different edition the step just logs “could not verify … continuing”. Use
`--strict-hashes` if you want the port to refuse. An item-verified run then
needs no network at any step.
```sh
./play.sh \
  --archive-item https://archive.org/details/YOUR_ITEM_ID \
  --mao-zip /path/to/mao-release.zip \
  --i-own-the-game
```

`--archive-item` needs the item metadata JSON — the script never fetches it:
`curl https://archive.org/metadata/<id> > meta.json`, then pass
`--item-metadata meta.json` (or drop it at `.cache/archive-meta.json`). With
`--source-dir` the run verifies your downloaded files (size + MD5), extracts
and builds with no further network. Missing file names are printed with the
rerun hint; `--download-missing` is the opt-in to fetch them from the item and
still requires `--i-own-the-game`. Verify-only mode never needs network.

### Text-only (fast; no images/audio/movies)

```sh
./play.sh --game-dir /path/to/game --no-assets
```

### Reopen after a build

```sh
./play.sh --only-serve            # instant; serves the existing web/dist
```

This is the minimum playable package: full scenario/flow/voice-map data, but
missing art/audio render as placeholders. Data is ~16.4 MB (12.8 MB with --compact-json); zip ~3.0 MB.

## Configuration file

```sh
cp oneclick.example.json oneclick.json
# edit paths/item/MAO settings
./play.sh --config oneclick.json
```

CLI values override the config; repeatable `--image` / `--archive-item`
entries from the config and CLI are combined. The example contains no
copyrighted URLs.

## What it does

1. **Inputs**
   - `--game-dir` uses a post-install/extracted tree directly.
   - `--image` accepts local paths/direct URLs; `--archive-item` queries
     `https://archive.org/metadata/<id>` and downloads the selected files.
   - Downloads are resumable (`curl -C -`), retried, and MD5-checked when the
     item metadata has a checksum.
2. **Extraction**
   - Prefers `7z`/`7za`/`7zz`/`bsdtar`; otherwise uses pure-Python
     `pycdlib` (ISO) / `py7zr` (7z) from `.cache/venv`.
   - Nested archives (disc → `.7z`/`.zip`/installer `.cab`) are extracted up
     to two levels.
   - `canonicalize_tree()` fixes ISO9660 uppercase names (`SCRIPT.PAK`) to the
     exact names the tools expect (`script.pak`, `VOICE.PAK`, `IC/BGM.PAK`).
   - It never launches `WA2.exe`, Wine, or a setup program.
3. **Data build** — `tools/build.py` with `--game` and `--mao` (JP spine, exact
   `.bnr` anchors, voices, flow, links, flags).
4. **Assets** — `tools/extract_assets.py` with the extracted tree as input.
   If ffmpeg is absent, `.cache/venv` installs `imageio-ffmpeg` and puts its
   static `ffmpeg` on `PATH`; otherwise movies are simply reported missing.
5. **Web build** — preserves manual `web/public/data/novels/*.pdf`, removes
   the generated `web/public/data|assets`, runs `npm ci` if needed and
   `npm run build`, then links `build/data` + `build/assets` into `web/dist`
   (no multi-GB duplicate copies). If symlinks are not available it falls
   back to copying.
6. **Serve** — `vite preview` on `127.0.0.1:8080` (auto-picks the next free
   port) and opens the browser.

## Dependencies

- **Python 3.10+** (the script itself is stdlib-only).
- **Node.js 20+ / npm** for the web build.
- Optional system tools: `7z`/`p7zip-full`, `bsdtar`, `unrar` for
  `.rar`/`.mdf`/`.bin` images. Pure-Python fallbacks cover `.iso` and `.7z`.
- `--auto-deps` (default) creates `.cache/venv` and installs
  `pillow`, `imageio-ffmpeg`, and (when images need them) `pycdlib`,
  `py7zr`. It does not touch system Python.
- `todokanai/subtitles` is optional; without it voice timing is not
  imported, but the game remains playable.

## Practical sizing

- The installed reference (main + `IC/`) is **8.0 GB**.
- Extraction/build needs roughly **20–24 GB** free with disc images kept
(images + extracted tree + assets; runtime data/assets are symlinked, not copied).
  The script checks free space and refuses rather than filling the disk.
- Text-only build: **16.4 MB data (12.8 MB compacted) / ~3.0 MB zipped**.
- Full web tier with the current converter: roughly **5–8 GB**; see
  [PACKAGING.md](PACKAGING.md) for the WebP/Opus/AV1 tiers.

## Failure modes and fixes

| symptom | fix |
|---|---|
| `no script.pak/bak.pak found` | the image is installer-only, or the data is in a nested cab; run with `7z` installed, or unpack the game files manually and use `--game-dir`. |
| `no MAO en.pak found` | pass `--mao-zip` (official MAO v2.1.0 release) or put it under `.cache/mao_v210`. |
| no manuscript text / bad speaker names | pass `--mao-dir` to the script-data folder or let the script clone MAO (network). |
| movies missing | install ffmpeg or allow `imageio-ffmpeg`; without it the movie cues become placeholders. |
| port busy | choose another `--port`; the script already scans the next 30 ports. |
| archive.org selection wrong | use `--include '*.iso'` (or list the item) or pass direct `--image https://archive.org/download/<id>/<file>`. |
| low disk | use `--no-assets` for text-only, or prune the previous `.cache/discs`/`build/assets`. |

## Why this is not a hosted service

The output contains copyrighted game assets. It is a personal BYOA build;
do not expose it publicly or redistribute it. The repo still contains only
engine/tooling and functional metadata.
