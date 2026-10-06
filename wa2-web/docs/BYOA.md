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

**Disc images (ISO):** the tools never run or install the game — they
read loose `*.pak` files only. Extract them from the disc images once
(ISO9660 is plain data; no Windows/Wine involved):

```sh
7z x disc1.iso -o~/wa2-discs/disc1        # or: sudo mount -o loop,ro disc1.iso /mnt/wa2
# then point the extractor at the dir that now contains the .pak files
```

The extractor reads only `*.pak` files and accepts ANY subset — you do
not need a full installed copy. Copy just the archives you want into a
scratch dir and point the tool at it; missing paks simply leave those
features as placeholders.

| archives (game root, and `IC/` for the intro chapter) | size | unlocks |
|---|---|---|
| `script.pak` | 5M | JP coordinate spine for exact voice anchoring (`--game` builds) |
| `bak.pak` + `fnt.pak` | 0.8G | backdrops, filters, fonts |
| `char.pak` | 0.5G | character sprites |
| `grp.pak` | 0.4G | event CGs, overlays |
| `BGM.PAK` + `SE.PAK` | 1.1G | music + sound effects |
| `VOICE.PAK` | 1.4G | voiced lines |
| `mv*.pak` | 2.5G | movies (also needs ffmpeg) |

Typical light setups:

```sh
# text-only play (no game files at all): stop after section 1
mkdir -p ~/wa2-min && cp /path/to/game/{script,bak,fnt,char,grp}.pak ~/wa2-min/
cp -r /path/to/game/IC ~/wa2-min/          # optional, intro chapter
python3 tools/extract_assets.py ~/wa2-min build/assets \
  --en-pak /tmp/wa2/main/en.pak --en-pak /tmp/wa2/special/en.pak
cp -r build/assets web/public/assets
```

From your INSTALLED game dir it works the same, just slower to scan:

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

Voice: `VOICE.PAK` filenames are XOR-0xFF `{script}_{token}_{take}.OGG`;
the parser records the raw token index (`tok`) on every say/narrate event
and the player auto-plays the clip (46k lines, ic-namespaced).
BGM/SE: `BGM.PAK`/`SE.PAK` names are the same XOR-0xFF cipher
(`BGM_001_A.OGG`, `SE_0000.WAV`); the extractor decodes them to real names
(older builds misnamed them `voice-*` — rerun `tools/fix_audio_names.py`
once per assets copy to repair). Music timing comes from `.bnr` opcode
(4,158) via `tools/build_bgm.py` → `data/bgm.json` (build artifact, kept
next to the other generated data).

## 3. Play

```sh
cd web && npm install && npm run dev     # dev, hot reload
npm run build && npm run preview         # production preview
```

Saves: `Save / Load` screen — progress lives in a file YOU own
(download JSON, re-import anywhere) plus 8 browser slots + autosave.
