# white-album2-web

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Fan-made **WHITE ALBUM 2 Extended Edition** web port, browser visual novel
engine, and asset extraction pipeline — engine + tooling only. Game data and
assets are supplied by the player; gameplay and route parity with the PC
original is the top priority.

![Early Introductory Chapter gameplay in the web port](wa2-web/docs/preview.webp)

*Early Introductory Chapter preview, captured from the author's own
legally-owned build. The repository distributes no game data or asset
files; the only game-derived visual is this promotional screenshot, which
depicts game art and translated text, is never loaded by the engine, and
is not part of any pack.*

## Features

- **Browser visual novel reader:** voices, BGM intro/loop pairs (`_A` + `_B`),
  sound effects, backdrops, event CGs, character sprites, `.AMP` color LUTs,
  weather/shake/calendar overlays, NovelMode prose, EroMode voice filter, and
  timed captions (`data/captions.json`).
- **Interactive flowchart & walkthrough guide:** full scenario branch graph
  with calendar dates, spoiler-safe hidden-unrevealed mode, and route guide.
- **Two English translations, one setting:** the MAO-TLs AI translation
  (default) or the TodokanaiTL human translation, chosen at New game and
  switchable in Settings. Saves stay compatible across both.
- **Native PC save & system import:** import `save_XX.sav` / `save_Q.sav`
  files (with exact `ScriptPos` anchoring when `data/native-pos.json` is
  present) and `Sys.sav` global progress (read lines, endings, CG/music/movie/ero
  unlocks, choice history), plus browser slots, quick save/load, and JSON
  export/import.
- **Extras & Special contents:** CG gallery, music player, and 24-scene replay
  powered by your unlocked profile.
- **Offline & self-contained packaging:** build a portable static web bundle
  via `tools/pack_site.py` or launch locally in one step with `./play.sh`.
- **Asset-free demo mode:** boots with original placeholder prose and a CSS
  winter scene when no game pack is present.

## Quickstart

**Fastest local play:** `cd wa2-web && ./play.sh --game-dir /path/to/game`
(or `--image disc1.iso ...`); it extracts, builds, and serves the web app.
See [`wa2-web/docs/ONECLICK.md`](wa2-web/docs/ONECLICK.md).

**Engine documentation & verification:** see
[`wa2-web/README.md`](wa2-web/README.md) and [`wa2-web/docs/`](wa2-web/docs/).
Third-party translation notices: [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
The original engine and tooling code is MIT-licensed ([`LICENSE`](LICENSE));
game assets and the translation are not covered and must be supplied from your
own legally-owned copy.

## Demo and external packs

Building `wa2-web/web` without local game data or assets boots an
**asset-free engine demo** using original placeholder prose and an
original CSS winter scene. It demonstrates the reader, choices, backlog,
flowchart, guide, saves, and settings without redistributing any game
content.

An independently hosted pack is configured at build time via
`VITE_PACK_URL=https://your-host.example/wa2-pack` (or overridden at
runtime with `?pack=...`; the pack root must contain `data/` and
`assets/manifest.json` and allow CORS). See
[`wa2-web/docs/BYOA.md`](wa2-web/docs/BYOA.md) and
[`wa2-web/docs/LEGAL.md`](wa2-web/docs/LEGAL.md).

## Source build

The reference install this port is built and tested against is the
Extended Edition + tokuten disc image.

## Smoke test

After `npm install` in `wa2-web/web`, a repeatable headless-browser check
boots the asset-free demo, steps through dialogue, writes a save slot,
reloads the page, and loads the slot back:

```sh
cd wa2-web/web && npm run smoke
```

It uses the Playwright Chromium already cached on the author's machine (no
browser download); set `WA2_CHROME=/path/to/chrome` to point it at another
binary, or `WA2_SMOKE_URL=http://127.0.0.1:5173` to test an already-running
server instead of spawning Vite.

## Translation

English scenario data comes from the
[MAO-TLs WHITE ALBUM 2 v2.1.0](https://github.com/MAO-TLs/white-album-2)
release (used as build input via `tools/build.py --mao` / `fetch_mao.py`
drift pin — never redistributed here).

## Credits and peer projects

This project is an independent web engine. The peer project below was used
as a reference and cross-validation source while implementing compatible
behavior. The CK-GAL glyph table and the 24-row scene-replay table are
reproduced from its Apache-2.0 code (credited below); everything else was
reimplemented independently. No game content was taken from it.

### galhack/WhiteAlbum2_iOS

[galhack/WhiteAlbum2_iOS](https://github.com/galhack/WhiteAlbum2_iOS) is an
unofficial **native Godot port** of WHITE ALBUM 2 for Apple platforms; this
repository is an **independent web engine**. Its original porting code is
Apache-2.0 and its WMV video GDExtension is MIT. Ideas and functional data
reimplemented or cross-validated here include:

- **CK-GAL private glyph map (33 glyphs, reproduced)** — decoding
  Chinese-patched save previews and speaker names.
- **PC save layout validation** — `ScriptPos`, jump stack, locals and args,
  plus the fail-closed conversion approach used when a VM tag or layout is
  not proven.
- **LSCR `(4,2)` same-script call / helper-entry semantics** — the
  call-vs-expression interpretation and the 9993–9999 helper-entry range.
- **Weather, shake and calendar behavior** — used as a behavior reference;
  this renderer is independent.
- **Timed caption schema** — inspiration for the BYOA contract in
  [`wa2-web/docs/BYOA.md`](wa2-web/docs/BYOA.md#5-timed-captions-optional);
  our JSON format is independent.
- **CG gallery / scene replay table** — the 24-row scene table is
  reproduced from the peer's Apache-2.0 `Wa2Def.SceneSlots`; the 168-row
  gallery table was cross-validated against it (and our own exe extraction).
- The full Apache-2.0 text is in
  [`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt).

No game content or bundled subtitle data is copied from that project.
Scenario text, images, audio and movies are never redistributed here; all
game assets remain supplied by the user. See
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## Status

Experimental. Voices, BGM/SE, backdrops, event art, sprites, LUT color
grades, weather/shake/calendar presentation, BMP overlays, NovelMode prose,
the original EroMode voice filter, flowchart/guide/saves and the
CG/Music/Scene extras screens work. Native PC `save_XX.sav` /
`save_Q.sav` files import in Save/Load with an exact `ScriptPos` anchor
when `data/native-pos.json` is present (line/choice fallback otherwise);
`Sys.sav` imports read lines, endings, CG/music/movie/ero unlocks and
choice history. Optional timed voice/SE captions come from
`data/captions.json` (BYOA only). Full gate matrix and open parity items:
`wa2-web/docs/QA.md`; self-packaging and size tiers:
`wa2-web/docs/PACKAGING.md`.


