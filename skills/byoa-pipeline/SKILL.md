---
name: byoa-pipeline
description: Convert a legally-owned game install into browser assets and playable data without committing any game content. Use for extraction, rebuilds, manifest or naming issues, and "missing asset" reports.
---

# BYOA pipeline skill

Nothing under `wa2-web/web/public/`, `.cache/`, or any `*.pak`/`*.zip`/
media extension may ever be staged — check `git status` before every
commit. "Missing asset" reports are usually stale `web/public/` copies,
not pipeline bugs: the loader logs partial loads to the console.

## Extract

```sh
python3 wa2-web/tools/extract_assets.py /path/to/game OUT --jobs 8
```

- KCAP via `kcap.py`/`lzss.py`; non-KCAP falls back to arc_unpacker.
- Name ciphers: nested BGM/SE/VOICE LAC names are XOR-0xFF
  (`decode_lac_name`); voice keys are `{script}_{line}` with `ic/`-prefixed
  IC keys; BGM loop pairs (`_A` intro + `_B` body) prefer `_B`.
- Gotchas already fixed once: cp932-decoding LAC names (writes
  `voice-*` garbage — repair with `fix_audio_names.py`), solo
  `BGM_NNN.OGG` files (no `_A` suffix), manifest values are
  assets-dir-relative (player rebases at load — the single URL choke
  point is `web/src/engine/assets.ts`, never patch URLs elsewhere).

## Build data

```sh
python3 wa2-web/tools/build.py MAIN_EN_PAK [SPECIAL_EN_PAK] OUT --game GAMEDIR
cp -r OUT/data/* wa2-web/web/public/data/
```

Emits scripts IR, flow/links, `bgm.json`, `bnr.json`, `voicemap.json`,
`flags.json` (needs `script.pak`), `luts.json` (needs `grp.pak`).
Hand sources (`wa2-web/data/flow.json`, `endings.json`, `terminals.json`,
`sprites.json`) are copied through — edit those, never the build output.

## Triage order for "X doesn't show/play"

1. `web/public/` staleness (rebuild + hard refresh).
2. Manifest key miss (check `manifest.json` + `missing.json`).
3. Lookup bug (`assets.ts` / timeline resolvers in `reader.ts`).
4. Decoder gap (`docs/PARSING.md` open items) — last, with evidence.
