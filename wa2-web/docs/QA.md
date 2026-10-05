# QA — parity verification status and procedures

Gameplay/path parity is the project's #1 priority. This file records what
is proven, what is assumed, and exactly how to close each gap.

## Automated (all green, run on every change)

| gate | command | current |
|---|---|---|
| unit (tools) | `pytest tests/` | 21 passed (bnr 6 + kcap 4 + parse_txt 11) |
| corpus (BYOA) | `WA2_EN_PAK=... pytest tests/` | 205+49 files, census, routers, mega-choices, warnings allowlist |
| web unit | `cd web && vitest run` | 35 passed (text/router/save/assets/bgm) |
| types+build | `tsc --noEmit && npm run build` | clean |
| flow parity | `check_flow.py IR flow.json` | 32/32 nodes, wording exact |
| full sim | `simulate.py … routers/first/chiaki/mari/koharu/special` | 202/245 scripts, 0 stalls |
| MAO pin | `fetch_mao.py IR_MAIN IR_SPECIAL --clone …` | v2.1.0, 0.986 containment / 193 scripts |
| assets | `extract_assets.py --selftest` | KCAP+TGA+WAV round-trip |

## Proven by engine evidence

- KCAP/LZSS container (byte-verified vs published `kcap_types.h`).
- 32 engine choices incl. 5 mega-recovered (walkthrough cross-check).
- Bare-id HINT neutrality (2015:1 proof), CATCH sync role (174/176).
- Inline-choice convergence (2004 reversal scene), router gotos,
  2301/2020 parallel-scene split, 2033→3001 bridge content flow.
- Whisper/F-tag/ruby/W-tag projection (mirrors MAO build script).

## Open (play-test against the PC build)

1. **Flag numbers**: affection thresholds, uwaki arithmetic, gate
   visibility (per-node NEEDS_PLAYTEST). Procedure: save-state diff per
   choice; record pick→flag deltas; update `annotate_flow.py`.
2. **Variant entry rules** (43 files): which flags/replay state selects
   each `_2/_3/_020` file. Procedure: flag sweep at each base file end.
3. **Click granularity**: advances per scene vs PC (PARSING.md assumption).
4. **2019-764 frame**: confirm work/stay belongs to the opt1 path and
   2501-path Koharu/Setsuna/Normal split is flag-only (no missing choice).
5. **Endings mapping**: file-end → ending screen (5 route terminals).
6. **BGM track mapping — SOLVED statically** (tools/proto_bgm_report.md):
   `.bnr` opcode (4,158) is BGM play, pushes[0] = track (`BGM_%03d`,
   engine derives `_a/_b` loop pair), pushes[1] = fade; stop shape is
   ops-based `(4,5),(3,X),(4,158)`; track 0 = pause (normalized to stop).
   Provenance: exe sprintf/call-chain disassembly + zero-counterexample
   corpus census. Player timeline in data/bgm.json (242 scripts,
   1288 plays, 10 stops), test-pinned (play/stop/sustain/missing).
   Residuals: 11 cued tracks (4, 5, 19-22, 28, 29, 32, 78, 79) have no
   file in either BGM.PAK — player sustains previous BGM there; placement
   is scene-exact, ±few lines within a scene (JP-counter vs EN-token drift).
7. **SE triggers**: files recovered with real names (`SE_%04d`, 1962 clips;
   pipeline bug fixed + one-shot migration tools/fix_audio_names.py);
   player seam live (seUrl + confidence-gated triggers + volume element).
   Trigger mapping stays open: the ascending-integer-run candidate shape
   (1008_030.bnr offsets 5029-5485) is documented in docs/PARSING.md, but
   corpus-wide filters catch JP token counters too (false positives
   verified), so nothing is auto-played rather than guessing wrong.
8. **Dynamic sprites**: grp-layer event art displays with .bnr fade timing;
   standing sprites inventoried (ako face-variants 322×684 need no
   compositing; kaz/set/… full-height slot canvases; prefix table in
   data/sprites.json). Per-line identity + screen slots need .bnr
   integer-slot decode (no slot floats exist in .bnr — positions are
   integer records or engine defaults). Nothing is guessed on stage.
9. **Voice take semantics**: third filename field (04/98/00/…) unmapped;
   one clip per line assumed (6 multi-clip lines: first wins).
10. **Coda 31xx/32xx identity** (epilogues vs route tails).
11. **v1.3.6→v2.1.0 structural diff**: 2007 + 3013 choices exist only in
   v2.1.0; build is version-agnostic but flow.json here is v2.1.0.
12. **2021/2022/2023 → 2025 SWITCH skips**: consecutive bare-jump pairs
   offer skipping ahead (including skipping the 2024 12/31 choice).
   Router plays everything linearly; plausibly flag-gated short paths.
13. **3016 → 3024 bare hint**: mid-tail either/or pair with the
    `CATCH3 → 3017` marker (same pattern as the 3015 switch). The port
    reads `3016→3017→…→3024` linearly (content-coherent); confirm.
14. **3023:536 `CATCH3 → {3201, 3101}`** vs linear `3023→3024`: same
    question as 13, same default-plays-linear treatment.

## Subagent verification log

- 2026-10-05: three static-only research passes (no game execution):
  BGM opcode RE (found (4,158) + exe call chain + corpus census, now
  tools/proto_bgm.py + tools/build_bgm.py + data/bgm.json timeline),
  sprite/SE inventory (face-variant finding, SE LAC naming bug, prefix
  table data/sprites.json, tools/decode_bnr.py fades/cams), BYOA + static
  QA audit (clean tree, gap list closed out below).
  - audio naming bug fixed (decode_lac_name) + one-shot migration
    (tools/fix_audio_names.py): 165 BGM + 1962 SE files renamed to real
    `BGM_*`/`SE_*` names, manifest tables rebuilt namespaced (ic/ keys).
  - player: BGM timeline playback + bgm volume, confidence-gated SE seam,
    .bnr fade timing on overlays, se audio element, bgm/bnr data loading.
  - static-fix batch from the audit: .gitignore media patterns, QA
    numbering + test counts, BYOA voice paragraph, LEGAL label count.

- 2026-10-04: three research passes (MAO release survey, Leaf engine
  survey, local asset inventory) — findings integrated, specs corrected
  (KCAP field order, LZSS parameters, choice counts).
- 2026-10-04: re-verification subagent (read-only) confirmed every fix
  landed: 0 bad speakers across 245 scripts, endings refs resolve,
  check_flow + 15 unit tests green, all 17 web fixes evidenced
  file:line, tsc + 25 vitest green.
  - parser: latch validation (`valid_name`, 0 bad speakers, census
    308→223), `「」`/`''` dialogue (+22k say events), `\n`/`\k` debris
    stripping, mega CATCH voice-target preservation;
  - flow data: endings.json node-id refresh, cc-mari 12/31 file fix
    (2503-126), stale index cleanup, `check_flow.py` extended to endings
    refs + `play` deliberateness + terminal targets;
  - web: END recording, dead Save button, ended-screen UX, persistent
    BGM node, per-slot export, `play`-override build-gating note,
    backlog position keys, boot normalize+log, video click guard,
    save validation + unique filenames + import checks, spoiler gating
    for destinations/guide, badge titles, dead-code removal.
  - Remaining auditor notes that are accepted limitations (not bugs):
    mega-choice gotos need `.bnr`/play-test; flag thresholds are
    walkthrough-derived; variant entry rules unmapped; 3904_2
    dynamically unreachable until variants map; linear over-inclusion
    at 3016/2021-23 SWITCH sites is invisible to the sim by design.
