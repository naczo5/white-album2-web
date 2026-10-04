# QA — parity verification status and procedures

Gameplay/path parity is the project's #1 priority. This file records what
is proven, what is assumed, and exactly how to close each gap.

## Automated (all green, run on every change)

| gate | command | current |
|---|---|---|
| unit (tools) | `pytest tests/` | 18 passed |
| corpus (BYOA) | `WA2_EN_PAK=... pytest tests/` | 205+49 files, census, routers, mega-choices, warnings allowlist |
| web unit | `cd web && vitest run` | 21 passed (text/router/save) |
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
6. **Voice wiring**: VOICE.PAK order vs CATCH ids; BGM `.AMP` channels;
   movie timing; `.bnr` presentation track (frame-exact sprites/fades —
   explicitly out of scope for v1 text parity).
7. **Coda 31xx/32xx identity** (epilogues vs route tails).
8. **v1.3.6→v2.1.0 structural diff**: 2007 + 3013 choices exist only in
   v2.1.0; build is version-agnostic but flow.json here is v2.1.0.
9. **2021/2022/2023 → 2025 SWITCH skips**: consecutive bare-jump pairs
   offer skipping ahead (including skipping the 2024 12/31 choice).
   Router plays everything linearly; plausibly flag-gated short paths.
10. **3016 → 3024 bare hint**: mid-tail either/or pair with the
    `CATCH3 → 3017` marker (same pattern as the 3015 switch). The port
    reads `3016→3017→…→3024` linearly (content-coherent); confirm.
11. **3023:536 `CATCH3 → {3201, 3101}`** vs linear `3023→3024`: same
    question as 10, same default-plays-linear treatment.

## Subagent verification log

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
