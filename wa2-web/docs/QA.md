# QA — parity verification status and procedures

Gameplay/path parity is the project's #1 priority. This file records what
is proven, what is assumed, and exactly how to close each gap.

## Automated (all green, run on every change)

| gate | command | current |
|---|---|---|
| unit (tools) | `pytest tests/` | 35 passed (bnr 7 + flags 7 + kcap 4 + parse_txt 11 + voice 6) |
| corpus (BYOA) | `WA2_EN_PAK=... pytest tests/` | 205+49 files, census, routers, mega-choices, warnings allowlist |
| web unit | `cd web && vitest run` | 50 passed (text/router/save/assets/bgm) |
| types+build | `tsc --noEmit && npm run build` | clean |
| flow parity | `check_flow.py IR flow.json` | 32/32 nodes, wording exact |
| bnr choice gate | `check_bnr_choices.py IR script.pak` | 31/31 choices carry (4,208) markers |
| flag reference | `build_flags.py script.pak` | 29 vars + 62 gflags, 15/15 pick flags mapped |
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
   visibility (per-node NEEDS_PLAYTEST). Engine side now mapped:
   script.pak `Global.vrb` names every live var (FLG_雪菜/小春/千晶/麻理
   好意度, FLG_かずさ本気度/浮気度, route-kill + per-choice pick flags;
   tools/build_flags.py → build/data/flags.json) and `GFLAG.dat` holds 62
   ending/chapter/replay slots. What remains is numeric: pick→delta
   amounts and gate thresholds. Procedure: save-state diff per choice;
   record pick→flag deltas; update `annotate_flow.py`.
2. **Variant entry rules** (43 files): base tails are branch-free and
   variant heads carry `(4,137)` entry keys N (145-845; bases open [0]),
   so selection is engine-side over GFLAG/replay state — the
   `selectVariant()` seam is correctly placed. What remains is the N
   semantics + flag sweep at each base end.
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
   Residuals: 2 cued tracks (78, 79) have no file in the installed game —
   they ship on the bonus disc (WA2_EE_SC BGM.PAK, cued by bonus scenario
   4009); player sustains previous BGM there; placement is scene-exact,
   ±few lines within a scene (JP-counter vs EN-token drift).
7. **SE triggers — SOLVED statically**: opcode (4,164), statement
   `[SE,255]+(4,164)` (LSCR thunk 0x455720 → SE channel allocator
   0x406450; handler-table base+40 = 164 with 6 corroborating sibling
   slots; 12/12 corpus occurrences address real `SE_%04d` files).
   tools/decode_bnr.py emits them conf="high" into data/bnr.json and the
   player fires them (12 cues: 1002/1004/1005/3001/3002 + specials).
   The old ascending-integer-run lead is positively identified as
   dialogue staging-sync (embeds JP-tick ops, 1:1 with lines) — documented
   in docs/PARSING.md, never emitted.
8. **Dynamic sprites**: grp-layer event art displays with .bnr fade timing;
   standing sprites inventoried (ako face-variants 322×684 need no
   compositing; kaz/set/… full-height slot canvases; prefix table in
   data/sprites.json). Per-line identity + screen slots still unmapped;
   exe disassembly now localizes the machinery (dispatch entries 26/27 →
   0x4160e0–0x416548, `%s%06d.tga` format, per-slot struct stride 0x74 at
   0x5267f0, prefix string table 0x4a2904+) — see docs/PARSING.md
   "Character sprite system". Nothing is guessed on stage.
   **EXPERIMENTAL layer (user-requested, 2026-10-06)**: the player now
   shows a fixed default frame per speaker (sprites.json prefix →
   lowest-numbered manifest frame; narration keeps the last sprite).
   Deliberately NOT engine-faithful — per-line identity remains open and
   this layer must not gate or influence parity work.
   **PARKED NEXT STEP (2026-10-06)**: decode per-line sprite identity —
   instrument `(4,176)` statements whose `(3,X)` toks point at dialogue
   toks (sprite changes likely coincide with speaker turns), and map
   dispatch entries 26/27 ctx layout precisely; then derive file numbers
   (`%s%06d.tga`) corpus-wide to replace the stand-in layer.
9. **Voice take semantics**: third filename field (04/98/00/…) unmapped;
   one clip per line assumed (6 multi-clip lines: first wins).
10. **Coda 31xx/32xx identity** (epilogues vs route tails).
11. **v1.3.6→v2.1.0 structural diff**: 2007 + 3013 choices exist only in
   v2.1.0; build is version-agnostic but flow.json here is v2.1.0.
    **Data now built from the MAO v2.1.0 release paks** (downloaded
    release zip → en.pak × 2), pin audit passed (0.986 / 193 scripts).
15. **Special-disc variant JP text** (blocks exact voice anchoring for 43
   variant scripts): their `.bnr` anchors reference JP variant txts that
   are NOT in script.pak (e.g. `2031_2.txt` only exists in MAO's en.pak,
   partially translated — large JP portions are the official patch's own
   state). Those scripts keep fractional voice assignment (resolved file
   keys, so the right clips play); supplying the special/tokuten JP
   script pak would close the gap via the same chain.
12. **2021/2022/2023 → 2025 SWITCH skips**: consecutive bare-jump pairs
   offer skipping ahead (including skipping the 2024 12/31 choice).
   Router plays everything linearly; plausibly flag-gated short paths.
13. **3016 → 3024 bare hint**: mid-tail either/or pair with the
    `CATCH3 → 3017` marker (same pattern as the 3015 switch). The port
    reads `3016→3017→…→3024` linearly (content-coherent); confirm.
    (Note: FLG_第３部15条件２ in Global.vrb proves the 3015 switch is a
    flag-gated condition, same family — engine evidence, not just pattern.)
14. **3023:536 `CATCH3 → {3201, 3101}`** vs linear `3023→3024`: same
    question as 13, same default-plays-linear treatment.

## Subagent verification log

- 2026-10-06 (third wave, static-only): voice/speaker/ambience overhaul.
  - **Voice anchor proven exact**: every (4,138) NNN record is followed by
    a (4,131) statement carrying (3,X) = the JP comma-token of the voiced
    line — 41464/41464 (100.00%) against JP script.pak corpus-wide.
    MAO's en.pak rebuilds .bnr payloads (0/174 identical) but keeps the
    anchors in JP coordinates — the patched engine holds JP script.pak as
    its coordinate spine (exe loads `patch.pak`/`pak\%s.pak` overlays).
  - **tools/build_voice.py rewritten** (v2): NNN → (3,X) → JP display
    line → MAO manuscript line (ruby-aware JP containment + ordinal gap
    fill) → EN IR event (fetch_mao normalization) → resolved voice key
    from VOICE.PAK/IC LAC names (family-base chain fixes the previously
    silent variant lookups, e.g. 2031_3 → 2031_0612). 35871/48504 exact;
    6865 fractional (special-disc variants without JP txt — QA open 15).
    Legacy `assign_nnn` kept as tested fallback.
  - **speakers.json added**: JP speaker labels → MAO speakerEn by
    script-scoped name votes (13587 overrides / 40 scripts); a
    text-position-based first attempt misattributed names and was
    replaced — wrong displayed names are worse than JP ones.
  - **Ambient channel SE**: (4,165) [ch, se, fade, loop, vol] = channel
    play (dispatch entry 37 → 0x40f400; 645/646 ids are SE.PAK numbers),
    (4,166) [ch,V≤0] = stop. decode_bnr emits 4926 cues + 51 stops
    (conf high); player runs up to 4 looping channel players, stops on
    script switch; skip-guarded (4,168) deliberately not emitted.
  - **Rebuilt all data from MAO v2.1.0 release paks** (v1.3.6 paks were
    stale); MAO pin audit re-passed (0.986 / 193 scripts).
  - Gates: pytest 35, tsc + vitest 48, check_flow + bnr choice gate green
    in build, fetch_mao drift audit green.

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
- 2026-10-06: second static-only RE wave: missing-BGM audit (9 of 11
  "missing" tracks were a `track_set()` solo-file bug — fixed; 78/79 are
  bonus-disc-only, verified in WA2_EE_SC BGM.PAK), flag-table extraction
  (Global.vrb/GFLAG.dat/.fnc → tools/build_flags.py, 15/15 pick flags
  mapped, (4,208)/(4,209) choice gate 31/31 in tools/check_bnr_choices.py),
  SE-opcode-via-dispatcher (found (4,164) → allocator 0x406450, 12 high
  cues now live), sprite/flag negatives with next-probe notes.
- 2026-10-06 (playtest feedback): `.bnr` backdrops were missing from the
  stage — (4,146/147) `[M,X,Y,F]` cues decoded (4176 bak + 358 grp,
  filename stems + clear barriers, prefix resolved at lookup) and merged
  with txt images in the player (latest-wins, clear = barrier); voice map
  gained dialogue/narration kind-affinity via JP token shapes.

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

### 2026-10-06 — experimental default-frame sprite layer (user request)
The user asked for sprites on stage to test despite the open per-line
identity question. Added an explicitly experimental layer: say-lines look
up the EN display speaker in `data/sprites.json` → 3-letter prefix →
`pickDefaultSpriteKey` (web/src/engine/assets.ts, pure/test-pinned) picks
the lowest-numbered `{prefix}NNNNNN.tga` manifest frame; narration keeps
the last sprite; unknown prefixes clear it. Sprite img sits below the grp
overlay. Verified all 19 sprites.json prefixes resolve (manifest frame
coverage 7–527 per prefix; alpha 45–73% so no blank canvases picked).
Gates: pytest 35 (unchanged), tsc clean, vitest 50 passed (+2 picker
tests). Per-line identity work (dispatch entries 26/27) remains the real
solution; this layer must not influence parity tooling.
