# QA — parity verification status and procedures

Gameplay/path parity is the project's #1 priority. This file records what
is proven, what is assumed, and exactly how to close each gap.

## Automated (all green, run on every change)

| gate | command | current |
|---|---|---|
| unit (tools) | `pytest tests/` | 35 passed (bnr 7 + flags 7 + kcap 4 + parse_txt 11 + voice 6) |
| corpus (BYOA) | `WA2_EN_PAK=... pytest tests/` | 205+49 files, census, routers, mega-choices, warnings allowlist |
| web unit | `cd web && vitest run` | 58 passed (text/router/save/assets/bgm/flowgraph) |
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
   ~~standing sprites~~ **SOLVED (2026-10-07)**: sprite show/hide is
   decoded — `(4,154)`/`(4,155) [char_id, face, base, pos, …]` →
   `char\{prefix}{base+face:06d}.tga`, hide = ops `(4,156)/(4,157)` (+ the
   4000 sentinel), backdrop shows wipe all sprites (`sprClear`); corpus
   proof 14315/14319 files exist + position table 0x4be0bc + clear-all
   chain 0x4167e0→0x402680 (docs/PARSING.md "Character sprite
   system"). The player renders the engine-faithful timeline
   (`resolveSprites` + `spriteLeftPct`, test-pinned). ~~Remaining
   sub-item: per-slot screen positions~~ **SOLVED (2026-10-07)**: arg3 =
   position index → x-offset table at .rdata 0x4be0bc.
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

### 2026-10-07 — sprite identity DECODED (replaces the experimental layer)
Followed the parked next step: disassembled dispatch entries 26/27
(ops 154/155, thunks 0x4553f0/0x455590) — both call the sprite function
0x4160e0, which sprintfs `char\%s%06d.tga` at 0x415cbf from slot-state
prefix WORD (+0xf6) + file number (+0xf8). Keyed the full 38-slot prefix
table from .rdata 0x4a2904–0x4a2980 (ids 6–9 dud, never in corpus). Then
the corpus proof: (4,154)/(4,155) push[0] = prefix id (distribution
matches the valid-id set exactly), push[1] = face, push[2] = base, and
base+face names a real char.pak/IC file for 14315/14319 statements
(99.97%; residuals = one garbage-base hide + 3 LF3 digital-novel
statements, excluded via base>=100 guard). Hide = face sentinel 4000
(1008_030 tail hides kaz/set/koh; 143 carries it once but is otherwise
unrelated). decode_bnr.py emits spr/sprHide recs (conf high); the
player's experimental default-frame layer is REMOVED and replaced by the
engine-faithful resolveSprites timeline (test-pinned; positions are a
presentation choice — engine slot x/y not decoded). Data rebuilt
(15,584 shows + 1 hide, 178 scripts), all gates green: pytest 35, tsc
clean, vitest 50, check_flow 32/32, check_bnr_choices 31/31, simulate
clean, MAO pin passed.

### 2026-10-07 — sprite slot model COMPLETED + presentation/input pass
User reports against the first sprite pass ("no scene shows many sprites;
they cycle, max ~2 active") exposed the missing lifecycle in the v1 decode.
Disassembly completed the model:
- arg3 of (4,154)/(4,155) = screen position index (stored to slot record+8,
  dedupe-compared at 0x416189); x-offsets from .rdata table 0x4be0bc =
  [-288,0,+288,-384,+384,-480,+480,-480,-160,+160,+480] px on 1280 wide.
  Slot records are keyed by character id (0x402220), so re-shows replace
  pose/position in place.
- Hides: (4,156) [pid,mode,param] + (4,157) [pid] -> shared clear 0x402610
  (handlers 0x4555e0/0x455640); 831 corpus hides (was 1 via the 4000
  sentinel only).
- Backdrop shows wipe all sprites: image primitive 0x4167e0 reaches the
  clear-all loop 0x402680; corpus-confirmed (per-script max simultaneous
  drops from <=11 to <=5, matching play observation; sprite bursts always
  re-show after bak changes). decode_bnr.py emits sprClear on bak recs;
  resolveSprites applies recs in statement order (test-pinned).
Data rebuilt (15,588 shows + 831 hides). Reader: sprites at engine x
positions, bottom-anchored full-height art, entrance fade, stage is a
proper 16:9 box (was full-width cover-cropped). Flowchart rebuilt as a
tsukiweb-style SVG node graph (pure layout buildChartGraph, test-pinned;
edges = decoded links + terminal chains + spine fillers; current script
highlighted, auto-scrolled into view; click = choice/link detail). Input
follows VN conventions: Enter/click advance (first press completes typing,
repeat ignored), hold-Ctrl skip (read-only-skip setting in Settings),
wheel-up opens backlog, Space no longer advances or skips. Cleared-stage
state fix: resolveStageImageEx distinguishes engine clear-to-black (black
stage, no placeholder) from missing assets (install hint); verified at
closing 2313 (play-scene black stage + sprites). Gates: pytest
35, tsc clean, vitest 58, check_flow 32/32 + check_bnr_choices 31/31
(build), simulate clean walk (31 choices covered).

### 2026-10-07 — MAO en.pak two-stream layout DECODED; JP-spine IR + exact .bnr/.bgm anchors
User reported the scenario read incoherently ("dialogue all over the
place, teleporting between rooms") with sprites/staging from a different
story. Root cause proven at the data level, not the renderer:
- The patched exe runs TWO script streams (exe evidence: 4× `script`
  pushes at 0x4177f5/0x417819/0x417945/0x417977 vs JP's single
  0x41cfe1; `en.pak` string at RVA 0x4a4294). JP `script.pak` is the
  structural spine; MAO `en.pak` overlays payload per token: EN token
  *i* == JP token *i* (naive comma split, corpus-verified 1:1). Old
  EN-standalone parsing produced truncated lines + orphan tail
  fragments = scrambled dialogue/speakers/backdrops.
- Long EN tokens truncate; overflow fragments append at file end in
  source-line order (1002: 35 extras). The exe re-joins them via the
  `.bnr` sync labels: `(3,X)` with label ops `(4,131)` [21577×] /
  `(4,144)` [15288×] / `(131,131)` double form [941×], X = JP
  comma-token index.
- tools/build_ir.py (NEW): JP-spine IR builder — JP tokens, EN
  shape-preserving substitution with classify_bare guard + name_guard,
  spine-classified replay, MAO manuscript text for say/narrate
  (ruby-aware JP containment, 69208 lines) + choice options
  (manuscript `N．text` rows, fullwidth/ASCII digit forms), EN-token
  fallback for untranslated lines (7775). Emit rule: all JP scripts +
  standalone EN-only omake (5200/5400/7000-class, terminals.json
  pins) — NOT MAO's `NNNN_N` splits (2031_2 etc., corpus-verified
  unreachable toolchain splits). Zero event drift corpus-wide.
- tools/bnr_anchor.py (NEW): exact record anchoring from `(3,X)` labels
  (first event with tok >= X); replaces fractional `idx/n_stmts ×
  m_events` in decode_bnr.py (sprites/backdrops/fades/SE/amb) and
  build_bgm.py (`--jp`). Verified 41464/41464 voice anchors exact
  against build_voice's chain; 1002 sprite/backdrop staging matches
  the narrative at every checked cue (184 Chikashi, 218 train Kazusa,
  229 photo set+chi+bak 100700).
- data/endings.json remapped to new flow node ids (option-text match
  old→new); annotate_flow `3904_2` key → `3904` (choice is inline in
  the JP spine; option text now comes from the manuscript pass).
- voicemap: 36241/39133 exact string keys (92.7%), rest legacy numeric
  bnr refs for special-disc variants.
- Gates all green: pytest 43 (+8: bnr_anchor pins, tok on
  latch/jump/choice events, fullwidth OPTION), tsc clean, vitest 58,
  check_flow 34/34, check_bnr_choices 34/34, simulate clean walk
  (32 choices), MAO pin drift audit passed. Headless verification:
  1002 train/photo scenes, 2013 classroom choice, 3904 coda choice
  (EN options + walkthrough date) all coherent; backdrop/sprite/audio
  staging from the same decoded timeline (was: fractional mismatch).
