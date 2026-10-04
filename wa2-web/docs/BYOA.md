# BYOA setup — run the game with your own assets

You need: (a) a legally-owned Japanese copy of WHITE ALBUM 2 Extended
Edition (installed, or the discs), (b) the MAO-TLs v2.1.0 English release
(`White_Album_2_Complete_English_Release_v2.1.0.zip`), (c) this repo. None
of (a)/(b) is committed or redistributed here.

## 1. Scenario text (required)

```sh
# from the v2.1.0 zip:
unzip -j White_Album_2_Complete_English_Release_v2.1.0.zip \
  "*/Windows/game files/en.pak" -d /tmp/wa2/main
unzip -j White_Album_2_Complete_English_Release_v2.1.0.zip \
  "*/Special Contents/patch/en.pak" -d /tmp/wa2/special
# build web data:
python3 tools/build.py /tmp/wa2/main/en.pak /tmp/wa2/special/en.pak ./build
cp -r build/data/* web/public/data/
```

`build.py` extracts (KCAP), parses (two-pass mega resolution), derives
flow/links, and runs the parity gate. It refuses to continue if any
engine choice is uncovered or any wording drifts.

Pin check (recommended): clone `https://github.com/MAO-TLs/white-album-2`
and run `tools/fetch_mao.py IR_MAIN IR_SPECIAL --clone <dir>` — asserts
script-data is exactly v2.1.0 and audits wording (expect ~0.98).

## 2. Images / audio / movies (optional, text-first without)

From your INSTALLED game dir (the one containing `WA2.exe`, `*.pak`):

```sh
python3 tools/extract_assets.py /path/to/game build/assets \
  --en-pak /tmp/wa2/main/en.pak --en-pak /tmp/wa2/special/en.pak
cp -r build/assets web/public/assets
```

Needs: Python Pillow (`pip install pillow`) for TGA→PNG and `ffmpeg`
for movie transcode (ASF/WMV are not browser-playable). Without them the
tool reports exactly what's missing (`missing.json`) and the player keeps
working with placeholders. Leaf `.px` sprites and `.g` audio need
`arc_unpacker` (`--dec=leaf/...`; archived GPLv3 tool) — see
`tools/extract_assets.py` for the command ladder; contributions welcome.

Voice: `VOICE.PAK` dumps in archive order; per-line voice wiring is an
open QA item (docs/QA.md §6) — files ship browsable, auto-play follows.

## 3. Play

```sh
cd web && npm install && npm run dev     # dev, hot reload
npm run build && npm run preview         # production preview
```

Saves: `Save / Load` screen — progress lives in a file YOU own
(download JSON, re-import anywhere) plus 8 browser slots + autosave.
