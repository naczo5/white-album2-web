# QA — parity verification status and procedures

Gameplay/path parity is the project's #1 priority. This file records what
is proven, what is assumed, and exactly how to close each gap.

## Automated (all green, run on every change)

| gate | command | current |
|---|---|---|
| unit + data (tools) | `pytest tests/` | 165 passed + 9 skipped |
| web unit | `cd web && vitest run` | 242 passed + 5 BYOA-skipped |
| real-data playthrough | `WA2_DATA_DIR=build/data vitest run playthrough` | all 11 endings + special scenarios + branch ranges (BYOA) |
| types+build | `tsc --noEmit && npm run build` | clean (`tsc --noEmit` 0 errors) |
| corpus (BYOA) | `WA2_EN_PAK=… pytest tests/` | 172 passed + 2 skipped (517 en.pak entries, zero JP leaks) |
| save corpus (BYOA) | `WA2_NATIVE_SAVES=… WA2_SYS_SAVES=… WA2_DATA_DIR=… vitest run` | 247 passed + 0 skipped (native slots 11/11 + 29 `Global.vrb` vars, `Sys.sav` profile) |
| CFG VM & bytecode | `pytest tests/test_build_cfg.py`; `vitest run cfg-vm playthrough` | 221 `.bnr` scripts compiled into `cfg.json`, zero overlapping `play` spans, `SCall`/`SetSelectMess` parity |
| movie subtitles | `pytest tests/test_subtitles.py`; `vitest run vtt` | ASS→VTT conversion + cue/region parsing pinned (`test_subtitles.py`, `vtt.test.ts`) |
| movie player | `vitest run reader-movie` | HUD/CC/skip/autoplay-fallback/missing-card behaviour, no DOM leak (`reader-movie.test.ts`) |
| `Sys.sav` compatibility | `pytest tests/test_sys_sav.py tests/test_build_sys_table.py`; `vitest run sys-save` | slot map + region decode + read-line bitmap + profile merge (`sys-save.test.ts`, `sys-save.corpus.test.ts`) |
| flow parity | `check_flow.py IR flow.json` | 32/32 nodes, option text exact |
| bnr choice gate | `check_bnr_choices.py IR script.pak` | 32/32 choices carry (4,208) markers |
| flag reference | `build_flags.py script.pak` | 29 vars + 62 gflags, 15/15 pick flags mapped |
| links | `build_links.py IR links.json` | 206 sites: 199 HINT + 7 SWITCH |
| full sim | `simulate.py … routers/first/special` | 153/221 routers, 92/221 first, 49/221 special, 0 stalls |
| MAO pin | `fetch_mao.py IR --clone …` | v2.1.0, 0.988 containment, 171 scripts / 45526 lines |
| assets | `extract_assets.py --selftest` | KCAP+TGA+WAV round-trip |

> Verified 2026-11-06 against the installed JP game directory in
> `.cache/game` plus the MAO v2.1.0 release. `todokanai/subtitles` is absent
> (optional voice-cue timing only). Movies WERE extracted (imageio-ffmpeg
> static `ffmpeg`, 32 movies / 689 MB) via the one-click asset build; media
> stay on disk only, never committed.

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
    **Data now built from the installed JP script.pak + MAO v2.1.0
    en.paks**, pin audit passed (0.988 / 171 scripts / 45526 lines).
15. **Special-disc variant JP text** (blocks exact voice anchoring for 43
   variant scripts): their `.bnr` anchors reference JP variant txts that
   are NOT in script.pak (e.g. `2031_2.txt` only exists in MAO's en.pak,
   partially translated — large JP portions are the official patch's own
   state). Those scripts keep fractional voice assignment (resolved file
   keys, so the right clips play); supplying the special/tokuten JP
   script pak would close the gap via the same chain.
12. **2021/2022/2023 → 2025 SWITCH skips**: decoded now — the JP spine
   encodes them as `CATCH2 [next,2025]` tails, and `build_links.py` keeps
   them as `2020-52`, `2021-300`, `2022-460`, `2023-517` SWITCH sites
   (default = next file). Router still plays the default linearly;
   skipping ahead (including over the 2024 12/31 choice) is plausibly
   flag-gated and remains unproven.
13. **3016 → 3024 / 3017 pair**: decoded as `3016-1018` SWITCH
   `[3024,3017]` (adjacent bare 3024 + `CATCH3` 3017), default 3017.
   The port reads `3016→3017→…→3024` linearly (content-coherent);
   confirm the 3024 short path.
14. **3023 `CATCH3 → {3201, 3101}`**: decoded as `3023-523` SWITCH,
   default 3101 (numeric play order); the 3201 short path is unconfirmed.
15. **IC-chapter backdrop mismatch — RESOLVED (2026-11-13)**: root cause was
    confusing **arg2** (sprite wipe) vs **arg3** (filename layer) on primitive
    **0x4167e0**. Handlers **0x454f30** (146) and **0x454fc0** (147) both use
    arg3=0 → `B%04d%1d%1d.tga` (bak); 147 alone sets arg2=1 (keep sprites).
    Only **0x455050** (148) uses arg3=1 → `v%06d.tga` (grp). The interim
    2026-10-08 fix that decoded 147 as grp was incorrect. Bak stems now include
    the time-of-day digit from **ds:0x5218ac** via **(4,170)** / **0x455800**.
    Reader resolvers remain per-layer (b-only / v-only) with statement-order
    merge (1002 ev 0: last bak cue wins).
16. **bak-cue resolver fall-through — RESOLVED (2026-10-08)**: replaced by
    the engine-proven per-layer prefixes above; see item 15.
17. **147/148 sprite-clear semantics — UPDATED (2026-11-13)**: `0x4167e0`
    arg2=0 (146/148) triggers sprite clear `0x402680`; arg2=1 on 147 keeps
    sprites. arg3 selects format, not wipe. `decode_bnr.py` emits
    `sprClear` on 146 and 148 only; 147 bak updates leave sprites on stage.
18. **Special Contents series termination — needs playtest**: terminals end
    5000/5100/5200/5300/5400 immediately while their bare-link runs continue
    through 5004/5104/5209/5303/5401; 4000-4009 and 6001-6005 have no
    terminal, so numeric spine runs 6005/6104 -> 7000 (a different menu
    extra). The special menu also starts each file individually. Map which
    ids are entry points vs continuations before changing routes.
19. **3016 final-router annotations vs file-jump model**: endings.json
    describes `3016-822 opt2 -> 3901` *and* a later `3016-859` pick on the
    same true-ending path, but the router treats opt2 as a hard jump and
    3016-859 is then unreachable. Either the engine returns from 3901 or
    the option-goto heuristic is wrong; needs play-test/save evidence.
20. **Backdrop fade presentation**: the player now crossfades with the .bnr
    fade duration (an animated `<img>` pair; CSS `transition` on
    `background-image` was inert) and clears to true black. Confirm the
    timing/clearance against the PC build at the spotlight scenes.

## Subagent verification log

- 2026-11-02 (real-asset verification + JP-spine rebase):
  - **Assets located**: `.cache/game` is the installed/extracted JP game
    (loose KCAP/LAC paks + `WA2.exe` + `IC/`; 8.0 GB total, no ISOs),
    `.cache/mao_v210` is the extracted MAO v2.1.0 release, and
    `.cache/analysis/{WA2_jp,WA2_mao}.exe` are the static-analysis binaries.
    `todokanai/subtitles` is absent; ffmpeg is absent (movies not converted).
  - **The committed flow/links were stale, not the endings**: a real JP-spine
    build produced 34 nodes because `build_ir.py` was emitting five
    engine-internal scripts (`catch`, `catch2`, `catch3`, `9999`, `LF3` —
    title/menu screens, flag-init, and a Japanese sample scene). Excluding
    them yields the documented 32 choices at the *original* coordinates
    (2019-1484, 2003-242, 3016-822/859, 3014-376), matching endings.json.
    The previous 2026-10-25 remap was against the stale committed flow and
    has been reverted; data/flow.json is now the real 32-node build.
  - **`build_links.py` was dropping every JP CATCH tail branch**: the JP
    spine encodes transitions as `CATCH/CATCH2/CATCH3 [SCRIPT...]`, while
    the tool only read bare ids. It now filters voice-context names, groups
    adjacent jump events, and keeps 206 sites (199 HINT + 7 SWITCH:
    2020/2021/2022/2023→2025, 2402→{2403,2413}, 3016→{3024,3017},
    3023→{3201,3101}). `tests/test_links.py` pins this.
  - **Annotation joins**: eight flow nodes failed the option-prefix join
    because the JP/MAO manuscript wording differs (`Sorry, but…`, `On
    second thought~ come here.`, `No, I don't…`, `Oh, who cares?`). Keys
    updated; the built flow is 30 EXPERT_SOURCED + 2 NEEDS_PLAYTEST, zero
    unannotated.
  - **Ghidra 147/148 resolution**: imported `WA2_jp.exe` (87 s analysis)
    and decompiled `FUN_004167e0`; the `FUN_00402680` sprite-clear call is
    inside `if (param_3 == 0)`, i.e. only 146/backdrop. 147/148 pass mode 1
    and do not wipe. `decode_bnr.py` now emits `sprClear` only for
    `layer=="bak"`; rebuilt bnr has 0 grp wipe flags (all grp recs carry
    `sprClear:false`). This closes old open item 17.
  - **Verification**: `WA2_EN_PAK=… pytest` 84 passed; full build exits 0
    with `check_flow` 32/32, `check_bnr_choices` 32/32, flags 15/15,
    MAO pin 0.988 (171 scripts / 45526 lines), simulate clean
    (routers 153/221, first 92/221, special 49/221), shipped-TS playthrough
    183/221 no throw/stall; web 74 passed + 1 BYOA-skipped; `tsc`/build
    clean (~52 KB engine).
  - **Packaging observation**: raw installed archives measure 8.0 GB
    (main 6.1 GB + IC 1.9 GB), not the 6.7 GB main-only table. Movie
    extraction awaits ffmpeg; text/web-data build is complete.
  - **One-click bootstrap** (`tools/oneclick.py`, `play.sh`,
    docs/ONECLICK.md): installed game / local images / archive.org **item
    metadata cache** -> MD5-verified local files, static extraction
    (7z/bsdtar or pycdlib/py7zr), installer-LAC direct input, JP-spine data
    build, asset extraction, Vite build, local preview. **No network data
    path**: the user downloads the item files and the one-time metadata JSON,
    the script hashes locally and refuses to build otherwise. Adds
    multi-disc IC linking, ISO case normalization, `.cache/venv` auto-deps
    (Pillow/imageio-ffmpeg/pycdlib/py7zr), disk checks, and `--only-serve`.
    **2026-11-09 hash-sheet pass** (advisory verify_sheet +
    `--hashes/--strict-hashes`): see data/archive-checksums.json.
    Tests: 77 base / 84 with `WA2_EN_PAK` (15 one-click, 3 link tests).
  - **Playable full build via oneclick** (2026-11-06): extracted the user's
    share installer-LAC set (8.0 GB -> pipaks), ran data + full asset build
    with movie transcode (32 movies, 689 MB total; converter time ~14 min).
    Result: 53410 asset entries (3641 images, 165 BGM, 1962 SE, 45995 voice,
    32 movies) + 65 non-asset extras (`.scc` text metadata etc.); game boots
    and serves (text/data + HTTP 206 for movie ranges). The un-compacted
    self-contained package is 6.7 GB folder / 6.2 GB zip (zip stores media;
    deflate saves only the ~2.1 MB JSON + JS, so recompressing does not help).
    Local-only verification against the user-supplied archive.org metadata
    JSON: the three disc RARs + cover PNG hash OK (4/4).

- 2026-10-25 (static audit; no game files in that checkout):
  - **Why no corpus run**: the machine has no `*.pak`, no `WA2.exe` and no
    built IR, so the BYOA/corpus/flow/sim/MAO gates could not be re-run and
    no new exe disassembly was possible. Ghidra 12.1.4 is present; the
    remaining RE items need the user's executable/archives.
  - **Data/gates**: `data/endings.json` still cited pre-spine node ids
    (2019-1484, 2003-242, 3016-822/859, 3014-376) and would fail
    `check_flow`'s endings check; remapped to the current nodes
    (2019-1488, 2003-241, 3016-826/863, 3014-377) — **later reverted
    2026-11-02**: the real JP-spine build showed the original ids are
    correct and the committed flow was the stale side. `data/flow.json` still
    carried the old EN-split node `3904_2-386` though build_ir excludes
    `NNNN_N`; now `3904-386`. New `tests/test_data.py` pins annotation join,
    unique coords, endings/terminal refs and link counts. `check_flow` now
    also rejects terminal `ending` ids that are absent from endings.json.
  - **Parser**: fullwidth option numbers inside mega segments no longer
    raise `ValueError`; option rows separated by a speaker tag merge into
    one choice UI (previously two forced single-option screens, contrary to
    docs/PARSING's claim); directive shapes are classified before the
    option regex so `1.tga` is an image, not option 1 with text "tga".
  - **Router/sim**: `simulate.spine_next` now mirrors buildSpine for
    variants (a variant at a chapter seam no longer walks into the next
    chapter's first base).
  - **Player parity**: ambient channels resolve as a lifetime timeline
    (cues crossed by skip/img steps and after save-load now play; multiple
    channels at one event no longer drop); SE fires the whole crossed range
    and all ids at an anchor (re-render no longer replays); BGM plays the
    `_A` intro then loops `_B` (was B-only), retries a blocked autoplay
    on the next gesture, and saves/restores the last engine track across a
    mid-scene load (optional `save.bgm` field; legacy saves stay silent
    until the next cue); IC nested-LAC audio probes both `ic/` and `ic-`
    namespaces; sprite lookups use the IC chapter namespace; txt `grp`
    images no longer leak into the backdrop resolver; backdrop changes
    crossfade with the .bnr duration and clear-to-black is actually black.
  - **Saves**: imported JSON is sanitized (missing `updatedAt`, malformed
    backlog rows), and the optional BGM state is validated; a damaged save
    can no longer crash the backlog/save screens.
  - **Input/UI**: skip-read was broken (markRead ran before the isRead
    gate, so every line looked read); the gate now captures pre-render read
    state and is unit-pinned. Manual typewriter completion re-arms
    auto/skip. Settings sliders no longer re-render mid-drag. Overlay Back/
    Esc returns to where the screen was opened (title vs reader) instead of
    always entering the reader. Corrupt/NaN settings are clamped. Scripts
    load with 12-way concurrency instead of 254 serial round trips.
  - **Voice/assets**: legacy numeric voice refs chain to the family base
    (`1008_020` -> `1008_0199`); Special-screen PDF links now say they are
    BYOA and docs/BYOA documents where to put them.
  - **Packaging**: `tools/pack_site.py` (static folder + launchers + zip +
    per-section size report), `tools/optimize_assets.py` (opt-in WebP/AVIF
    image + Opus audio pass), `docs/PACKAGING.md` (size tiers and limits).
  - **Gates**: pytest 58 passed + 7 BYOA-skipped, vitest 74 passed + 1
    BYOA-skipped, `tsc --noEmit` clean, `npm run build` clean (engine ~52 KB),
    headless Chromium smoke: title->chart->back returns to title,
    reader->chart->back returns to reader, read-only skip stops on an unread
    line while skip-all reaches the choice, synthetic backdrop renders with
    the placeholder removed and a bnr clear goes to true black, no console
    errors.
  - **Still open**: QA 17 (147/148 wipe), 18 (special-series terminals),
    19 (3016 annotations vs jump model), 20 (fade timing). No routing was
    changed for those: they need play-test/save-state evidence.

- 2026-10-08 (static RE: image-op layer split, user-reported backdrop bug):
  - **Ops (4,146)/(4,147) separated by disassembly**: handlers 0x454f30
    (146) and 0x454fc0 (147) are byte-identical except one push — 146
    passes mode 0, 147 passes mode 1, to image primitive 0x4167e0, which
    selects the filename format: mode 0 → `B%04d%1d%1d.tga` (.rdata
    0x4a2a00, backdrop), mode 1 → `v%06d.tga` (0x4a2a1c, event visual);
    op 148 (0x455050) also passes mode 1 (0x455122/0x45515a). So 147 was
    mis-decoded as bak: CGs (v-files) leaked through the b→v→tv stem
    fall-through as stage backdrops, with sprites drawn over them —
    exactly the user's "sprites over CGs" report. decode_bnr.py now
    emits 147 as grp; reader resolvers resolve bak stems b-only, grp
    stems v-only, and apply same-event cues in statement order (last
    wins — engine executes statements sequentially).
  - Dispatcher: VM handler table at .data 0x4c2610, entry i → op 128+i
    (sprite ops 154/155 = entries 26/27 = 0x4553f0/0x455590 ✓ matches
    prior evidence; 146/147/148 = entries 18/19/20).
  - Census corpus-wide (en.pak .bnr): 146 stems hit b 1708 / v 135 /
    missing 132; 147 hit b 911 (both-prefix cases) / v 121 / missing 64;
    148 hit v 185 / b 160 / missing 2 — consistent with per-op prefixes.
  - **Deployment**: rebuilt bnr.json (spine + fractional) does NOT
    reproduce the deployed file's event coordinates (deployed data was
    built by an older toolchain state); shipping data unchanged until the
    JP-spine IR rewiring (Open item on pipeline wiring). The resolver fix
    alone eliminates CG-as-backdrop against the deployed data.
- 2026-10-07 (input/skip + stage fixes, headless Chromium against vite):
  - **Ctrl-skip root cause**: `startTypewriter`'s `tick` completion branch
    set `typeTimer = null` without `clearInterval` — the 30 ms interval
    kept firing after the line finished, each tick re-running
    `onDone → scheduleAuto` and thereby perpetually clearing the pending
    120 ms auto/skip timer (skip and auto-mode never advanced) and
    re-rendering the finished box 30×/s (user-visible flicker). Fixed by
    clearing the interval before `onDone`. Separately, `skipping` was
    snapshotted into reader hooks at render time (stale by value); hooks
    now carry a shared mutable `skip: { active }` object mutated by
    `setSkipping()` without re-render.
  - Playwright verification (`?pos=1002:120`, autosave-position probe):
    click advances idle line, click during typing completes, Enter
    advances, Ctrl held 2 s advances 123→155 (≈120 ms/line, repeatable);
    skip-stop returns to normal pacing.
  - **Stage scaling**: user-reported cover-crop (head cut) on 1280×720
    art; `.stage` now uses a `::before` 56.25 % padding spacer and all
    art layers use `contain` (never crop). Verified ratio 1.775 at
    1280×640 and 1280×800 viewports.
  - Backdrop mismatch at 1002 logged as Open item 15 (todo).
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

### 2026-10-08 — browser selection, grp-CG z-order, tail-anchor ev clamp, dev scene-jump

User reports (screenshots): (1) spam-clicking selected page elements
(blue highlight) — native browser text/image selection, not an engine
effect; (2) a standing sprite rendered on top of a full-screen grp CG;
(3) script 1004 showed no sprites at any event; request: dev-mode scene
jump from the flowchart.

- web/style.css: `user-select: none` on `*` — click-to-advance must never
  drag-select the page (engine windows aren't selectable either).
- web/style.css `.stage-ov { z-index: 20 }`: sprites carry inline
  `z-index: 10+i` (slot order); without an explicit overlay z-index the
  sprites painted ABOVE the grp CG regardless of DOM order. Engine draws
  event visuals over the sprite scene. Verified headless at 1013:333:
  overlay v100100 covers the kaz sprite (z 10).
- tools/bnr_anchor.py `anchor_stmts`: statements after the LAST label
  carried `carry = None → 0`, pinning trailing terminator statements
  (bak 990000 + sprClear) to ev 0 at the END of the rec list —
  non-monotonic evs. resolveSprites applies recs in list order, so the
  tail sprClear wiped sprites at EVERY event (1004: 0 sprites at all
  evs; 103 scripts affected). Tail statements now anchor to the last
  label's event (stream order ⇒ event order, monotonic).
- tools/decode_bnr.py: belt-and-braces monotonic ev clamp after anchor
  assignment.
- web/ui/reader.ts `resolveSprites`: stable ev sort before applying —
  list position can no longer reorder time for any unsorted input.
- Deployed `web/public/data/bnr.json` patched with the same clamp
  (119 recs across 103 scripts; rebuild not bit-reproducible from HEAD
  toolchain — data/flow.json pairing drift is the pending re-anchor/
  rewire work). 1004 now resolves sprites at every ev (50: tak001109,
  300: kaz001205).
- web/main.ts + ui/flowchart.ts: `dev` setting (localStorage
  `wa2web.dev`); when on, the flowchart node detail panel shows
  "▶ Jump to <script>" → fresh save at script ev 0 (debug origin).
- Gates: pytest 43, tsc clean, vitest 62, check_bnr_choices 34/34.
  check_flow/simulate currently fail with a PRE-EXISTING IR↔flow.json
  choice-coordinate drift (off-by-one, 58 errors; both inputs untouched
  by this diff — bnr.json is not a gate input) — queued for the
  re-anchor/rewire todos. Playwright: selection suppressed, 1004 sprites
  render, dev jump lands in reader at 1004, overlay covers sprites.

### 2026-10-08 — flowchart showed only 2 closing-chapter nodes (reachability + layout)

User report: "why is there only 2 closing chapter nodes in the
flowchart?" Chart had 20 nodes: intro web + 2001 + 2002, then nothing.

Root causes, two compounding:
1. `buildChartGraph` ran the spine-fill as a SINGLE pass after the
   link-only BFS. 2001 is reached late (via 1013's cross-chapter link,
   processed after the fill), so 2001→2002 (link) got added by the
   trailing loop but 2002's spine successor (2003) never propagated —
   the whole closing/coda chapters dropped out.
2. Deployed `web/public/data/links.json` is stale (74 sites vs 134
   authored in `data/links.json` — missing most closing/coda branch
   edges; the data rebuild is the pending re-anchor/rewire work).

Fixes (web/ui/flowchart.ts):
- Reachability is now a proper closure: one worklist over link/chain
  edges AND spine successors. Chapter seams work because spine.next is
  null there by design and a link/chain takes over (1013→2001 chain,
  2033→3001 chain).
- Layout transposed to vertical flow (depth = row, branch siblings =
  columns): the full route is a ~4700px-tall scrollable chart; the old
  horizontal strip would be ~17000px wide with 160 nodes. Edge beziers
  rotated to match. Chart now renders 160 nodes: intro + all of closing
  (2001-2517 + 23xx/24xx routes) + coda (3001-3211, 3901-3909).
- flowgraph.test.ts axes updated (branch siblings share a row, not a
  column). Gates: tsc clean, vitest 62.

### 2026-11-12 — interface redesign, demo scene, external pack handoff

- Rebuilt the player UI around the original interface plates: deep
  teal/aqua glass header strips and message window, snowflake watermark,
  gold selection/current-node state, script titles, angular buttons.
  Title, reader, choices, backlog, flowchart, guide, saves, settings,
  special contents, mobile portrait layout, focus-visible, and
  reduced-motion behavior were all touched.
- Standing sprites now render at engine height with no `max-width`
  shrink. Some source sprites are hard-cropped at the crown (visible
  alpha row at y=0); shrinking them exposed that cut as a floating flat
  edge. Full-height, bottom-anchored placement sits the cut flush with
  the stage top, matching the original engine.
- Asset-free demo mode now draws an original CSS winter scene (no game
  art) and uses original placeholder prose. A real-asset README preview is
  a single promotional capture, not a runtime asset.
- `?pack=<root>` loads `data/` + `assets/` from an external BYOA host
  (CORS required); manifest URLs rebase against the pack; LUTs and novels
  follow the same root. Pack data is treated as untrusted input:
  interpolated ids/dates/gotos are escaped, malformed scenario/flow nodes
  are skipped, and pack failures fall back to the demo with a title warning.
- Gates: tsc clean; Vitest 77 passed / 1 skipped; pytest 77 passed /
  9 skipped; clean Vite build from a checkout with `public/data` and
  `public/assets` removed.
- Review fixes: pack JSON XSS escaping, quote-safe attribute escaper,
  ignored `public/assets` symlink, local CORS test command, Special novel
  links under a pack, demo chapter labels, mobile text-size/touch-target
  fixes, keyboard Enter on focused controls, reduced-motion typewriter, and
  screenshot/legal wording.

### 2026-11-12 — native PC save import (manual slots / quick save)

- Decoded the original ~0x54fd0-byte slot format from 11 user-supplied
  save_XX/save_Q samples (kept outside git): header SYSTEMTIME, preview,
  full line, speaker, three choice buffers, and script id/route at
  0x203d8. Evidence offsets are in docs/PARSING.md "Native PC save files".
- Added `web/src/engine/native-save.ts`: parses `.sav`, normalizes the
  soft-wrapped CP932 line, matches it against the IR, falls back to choice
  text, and flags duplicate-line ambiguity. Save/Load now imports native
  slots into a separate persistent "Imported game saves" list (not
  limited to the 8 browser slots).
- `Sys.sav` global state is now imported as a separate profile (see the
  2026-11-13 entry below): read lines, gallery/CG unlocks, music/movie
  bands, choice bitmasks and the high-confidence ending slots. Slot 0 (the
  engine's catch-all read bucket) and slot 99 (force-zeroed by the guarded
  setter at `0x405320`) stay excluded/untrusted — documented as open items
  in `data/sys-slots.json`.
- Corpus test (BYOA-gated): `WA2_NATIVE_SAVES=… WA2_DATA_DIR=… vitest run
  native-save.corpus` maps 11/11 samples; save_00's repeated line is
  imported as two candidate rows (option 1/2), not silently chosen.
- Quick save/load and the autosave row were added to Save/Load; the
  reader exposes desktop Q.Save/Q.Load. Keys are namespaced per data source
  (`wa2web.demo.*`, `wa2web.pack-<hash>.*`, default `wa2web.*`), so demo and
  pack progress cannot overwrite each other. Quick save is separate from
  autosave and the 8 slots.
- Gates: tsc clean; Vitest 88 passed / 2 BYOA-skipped; pytest unchanged
  77 passed / 9 skipped; browser smoke: Q.Save → advance → Q.Load restored
  the saved line, Save/Load showed the Quick save and Autosave rows.

### 2026-11-13 — movie subtitles + player, speaker/anchor fixes, `Sys.sav` RE

Static analysis only (no game launch); corpus gates ran against the
installed game in `.cache/game`, the MAO v2.1.0 release, and the
2026-11-13 user save set (`.cache/saves/2026-11-13`, never committed).

- **Movie subtitles** (`tools/extract_assets.py`, `web/src/engine/vtt.ts`,
  `web/src/ui/movie.ts`): MAO's Movie Patcher `.ass` tracks convert to
  WebVTT per movie (`subs/mvNNN.vtt`, listed under `subtitles` in
  `manifest.json`). Timestamp math (ASS centiseconds, `HH:MM:SS.mmm`),
  style-level and inline `\i`/`\b` → `<i>`/`<b>`, `PlayResX/Y` geometry,
  top-vs-bottom/column placement by `line:`/`pos`, chronological sort, and
  drawing-block skipping are pinned by `tests/test_subtitles.py` (25
  tests). The runtime parser additionally sanitises every cue (escape
  first, then re-emit only an `<i>/<b>/<br>` allow-list), maps `line:` to
  the two overlay regions, groups positioned lyric pairs into columns and
  keeps authored line breaks — pinned by `web/src/engine/vtt.test.ts` (30
  tests). `--subs-only` regenerates just the tracks and prunes stale
  manifest keys plus orphaned `.vtt` files, so a renumbered movie can
  never request a missing caption file.
- **Movie player UX** (`web/src/ui/movie.ts`, `reader-movie.test.ts`):
  one persistent layer per reader (no listener stacking), auto-hidden HUD
  with a measured subtitle clearance, CC toggle persisted in
  `wa2web.cc`, Escape reveal-then-skip, M/C shortcuts, Space/Enter on the
  missing-asset card, and an autoplay fallback to muted playback plus a
  "Tap to unmute" pill instead of a black frame. Teardown is idempotent and
  unloads the source; the lookahead `<video>` buffer is released when a
  film starts or the reader leaves. Save/position drift while a film plays
  is pinned (`protects a save that moved on while the film played`), as is
  the lookahead scan limit (26 tests).
- **Speaker/latch + anchor fixes** (`tools/parse_txt.py`,
  `tools/build_ir.py`, `tools/build_voice.py`, `tools/bnr_anchor.py`):
  JP narration rows carrying `、。！？「」『』` and curly-quoted beats
  (`“…”`) are rejected as speaker names, so a full sentence can no longer
  latch and steal the next line's attribution. `_replay_spine` only falls
  back to a hybrid event's `text` when that event is itself a latch (an EN
  narration row must never be promoted to a speaker), and the fullwidth
  unknown-speaker tag normalizes to `???`. Voice speaker votes now join
  MAO `_N` continuation manuscripts (`3906` + `coda-3906_2`), so tail
  characters get their EN names; the map needs ≥3 votes and ≥90 % agreement
  or it keeps the JP name. `bnr_anchor` now *skips* an out-of-range
  `(3,X)` label that follows a settled anchor instead of clamping every
  earlier statement onto the last event (1001's airport/city backdrops had
  collapsed onto ev 80).
- **`Sys.sav` RE + compatibility** (`tools/build_sys_table.py`,
  `data/sys-slots.json`, `web/src/engine/sys-save.ts`, `ui/saves.ts`):
  static reads of `WA2.exe` .data resolved the whole file — Region A
  `0..0x7FFFF` = 4096 × `0x200` MSB-first read-line bitmaps indexed by the
  185-entry script table at `0x4be530` (slot bits = message lines + one
  sentinel; 82 fully-read slots match exactly and contiguously against
  `script.pak`, partially read and branching scripts stop earlier and can
  have gaps); Region B `0x80000..0x26847F` = one byte per
  `part*1e6 + cgId` (gallery table `0x4c01b0`, 168 × 10 ids, ends at
  `0x4c1bf0`; 272 distinct ids); Region C `0x268480..0x26947F` = 1024 `u32`
  global flags behind `GetGameFlag`/`SetGameFlag`, with `GFLAG.dat` record
  `+256` supplying the slot index (now emitted as `gflagSlots`) and
  `900 + 4*choiceIdx + nodeIdx` bitmasks matching the 23-entry choice table
  `0x4be4d0` in `flow.json` order. The player imports the profile as a
  separate global save (read lines, ending slots, music/movie/ero bands,
  choice history) and merges it into read state, endings and the flowchart
  without touching the run save. Gates: `tests/test_sys_sav.py` (slot map
  schema/counts, no game text, choice order, CG uniqueness, ending map,
  bundle delivery, `GFLAG.dat` slot parse, Region A bitmap rule — the
  last two BYOA-gated), `tests/test_build_sys_table.py` (PE/section
  parsing, extractor counts, gallery end, exe cross-checks, BYOA-gated),
  `web/src/engine/sys-save.test.ts`, and
  `web/src/engine/sys-save.corpus.test.ts` (103 read scripts, >30k read
  lines, four high-confidence endings on the sample).
- **Still open on `Sys.sav`** (recorded in `data/sys-slots.json`
  `openItems`): Region A **slot 0 is the engine's catch-all bucket** (the
  `0x40ea10` resolver falls back to index 0 for ids absent from the
  table), so it is excluded from import and kept as reference only; **slot
  99 is force-zeroed** by the guarded setter `0x405320` (coda-setsuna is
  never observable — read other end states instead); the `900` band is
  shared with an ero-scene flag; movie/music ids overlap in the low 200s;
  and affection thresholds remain play-test data (`Global.vrb` snapshots
  in `save_XX.sav` at `0x54cb0` are decoded but not used for gating).
- **Gates (verified, 2026-11-13)**: `pytest tests/ -q` → **144 passed, 9
  skipped**; `WA2_EN_PAK=… pytest tests/ -q` → **151 passed, 2 skipped**;
  `npx tsc --noEmit` clean; `npx vitest run` → **225 passed, 4 skipped**;
  with the BYOA save corpora (`WA2_NATIVE_SAVES`, `WA2_SYS_SAVES`,
  `WA2_DATA_DIR=build/data`) → **229 passed, 0 skipped** (native slots
  11/11, real-data playthrough 183/221 scripts, `Sys.sav` profile).

- 2026-11-13 (static RE: **(4,147) arg2 vs arg3** + **(4,170) tod**):
  - Handlers **0x454f30** (146), **0x454fc0** (147), **0x455050** (148) →
    **0x4167e0**: arg2=0 wipes sprites (0x402680), arg2=1 keeps them (147);
    arg3=0 → `B%04d%1d%1d.tga` (146+147 bak), arg3=1 → `v%06d.tga` (148 grp).
    **(4,170)** via **0x455800** → **ds:0x5218ac** supplies the third bak
    digit (0x41680c / 0x41696c..97). `tools/decode_bnr.py`:
    `_extract_img_args`, `_update_tod`, `bak_stem`; 147 decoded bak with
    `sprClear: false`. `tests/test_bnr.py`: 10 synthetic LSCR cases;
    `bgm.test.ts`: `sprClear:false` on 147-class bak cue. Docs: PARSING
    image-op table + sprite wipe note; QA items 15/17. Gates:
    `pytest tests/ -q` → **154 passed, 9 skipped**; `npx tsc --noEmit` clean;
    `npx vitest run` → **226 passed, 4 skipped**.

- 2026-11-14 (Phase 1 static RE: **LSCR CFG compiler**, **multi-part MAO alignment**, **GFLAG off-by-one fix**, & **route attribution**):
  - **Multi-part MAO alignment + JP speaker leaks** (`tools/build_ir.py`,
    `tools/build_voice.py`): independent per-part anchor matching
    (`match_jp_to_mao_parts` / `manuscript_parts`) eliminates ~5,500 stale JP
    lines across the 14 interleaved H-scene scripts (`2031`, `2312`, `2313`,
    `2401`, `2402`, `2504`, `2507`, `2511`, `3001`, `3015`, `3210`, `3902`,
    `3906`, `3907`), passes `jp_events` to `_choice_pass` so canonical MAO
    manuscript choice text resolves even against older EN `.pak` tokens
    (`2016`), and clears all JP speaker leaks (`speakers.json`: 0 overrides).
  - **LSCR CFG compiler (`tools/build_cfg.py`)**: compiles all 221 scripts
    into `cfg.json` v1 (`Global.vrb` 29 vars, `play` spans `[from, to)`,
    `setG`/`setL`/`setGFlag`/`if`/`choice`/`sload`/`scall`/`ret`/`gotitle`),
    integrated into `tools/build.py` and bundled as `bundle.json["cfg"]` via
    `tools/pack_bundle.py`. Zero overlapping `play` spans across all scripts;
    32/32 choices covered with exact `SetSelectMess` gates.
  - **`GFLAG.dat` +1 off-by-one fix & route correction**
    (`tools/build_flags.py`, `tools/build_sys_table.py`,
    `data/sys-slots.json`, `data/endings.json`, `data/terminals.json`,
    `tools/annotate_flow.py`, `data/flow.json`, `tools/simulate.py`):
    `GFLAG.dat` records are `(u32 slot, char[256] name)` after a 4-byte count,
    so all 11 ending slots (`0, 20..25, 30..33`) are `high`-confidence, slot
    `99` is the `SetSelectMess` choice-system placeholder, and `2019`/`3016`
    route attributions (`24xx`=Chiaki, `25xx`=Mari, `23xx`=Koharu,
    `3901`=Kazusa Cheating, `31xx`=Kazusa True, `32xx`=Setsuna True) match
    `.bnr` `SLoad` ground truth.

- 2026-11-14 (Ghidra/REA pass: **voice subsystem decompiled**, **LAC layout proven**, **deploy drift root-caused**):
  - **RE tooling**: REA 6.9.0 MCP registered for Cursor with Ghidra
    12.1.4 (`GHIDRA_INSTALL_DIR=/home/debian/tools/ghidra_12.1.4_PUBLIC`);
    `WA2.exe` sha256 `c395d93f…3990b` decompiled headless to 2,111
    functions (`rea decompile-all`). Evidence below is from that dump.
  - **Voice filename/probe order (high, decompiled)**: `FUN_0040eda0`
    formats `"%04d_%04d_%02d.ogg"` via `wsprintfA` with
    `(script, line, take)`; probes CC `FUN_00461400(...,2,...)` first,
    IC `(...,5,...)` only on failure (`PLAY_CC`/`ERR_NO_FILE_CC` →
    `PLAY_IC`/`ERR_NO_FILE_IC`). `web/src/engine/assets.ts` `voiceUrl()`
    already tries main then `ic/` in that order — parity holds.
  - **Argument mapping validated against the archive**: the 5 hardcoded
    cues in `0x41f990` format to `2503_0099_01`, `2002_0242_02`,
    `2027_0223_03`, `2001_0086_04`, `2001_0198_05` — all 5 present in
    `VOICE.PAK`, confirming positions and CC-before-IC.
  - **LAC layout (high)**: 32-byte XOR-0xFF name + u32 size + u32 offset =
    40-byte records; payload at `8 + count*40`. Main `38736*40+8 =
    1549448` = first `OggS`, and `sum(sizes) == 1447111922` = bytes after
    that offset. `extract_assets.py`/`build_voice.py` already use stride
    40 with a 24/32-byte name read — both yield the same key set.
  - **Voicemap parity (0 misses)**: all 40,741 `voicemap.map` entries
    (census taken from `build/data/voicemap.json`, which is byte-identical
    to `bundle.json["voicemap"]` — the map the client actually serves;
    the stale `web/public/data/voicemap.json` fallback holds only
    39,182/36,290/2,892 and is not used when a bundle is present)
    verified against both archives — 37,849 string keys resolve, 2,892
    numeric fallbacks resolve to **nothing** (silence, never a wrong
    clip). This is the desired failure direction.
  - **Known unmodelled field**: line base `DAT_00a391ec` is added to the
    voice line number and persists at save slot `[0x445]`
    (`0x423a1c` write — `mov [ebx+0x1114], edx`, `0x1114/4 = 0x445`;
    `0x423e31` restore — `mov [0xa391ec], ebx`).
    `native-save.ts` does not read `0x445`; it is 0 in all 13 observed
    saves, so no current divergence. Left as a tracked gap, not guessed.
  - **Root cause of "voices stopped" (deploy, not engine)**: the R2 bucket
    held 762/1888 `.vpk` chunks, all 762 with stale sizes, while
    `manifest.json` was current. Voice is `.vpk`-packed; BGM is loose
    `.ogg` — hence music ok / voice silent. Slicing a current manifest
    range out of a stale chunk yields garbage Ogg pages with **HTTP 200**,
    so nothing surfaced as an error. Fixed by re-syncing all chunks;
    `tools/upload_to_r2.sh` now runs `rclone check --one-way` over
    `assets/` and `data/` after upload and **exits 1** on mismatch.
  - **End-to-end proof of the voice fix (43/43)**: re-fetching
    `vpk/voice_ic_1002_000.vpk` from R2 after upload and slicing it with
    the same manifest ranges the client uses gives **43 valid Ogg ranges
    out of 43**. The pre-fix chunk of the same path yields **1 of 43**
    (only the `0-…` range, which happens to start at byte 0). Every later
    range was misaligned by the size delta, so it decoded to garbage while
    still returning HTTP 200. This is the concrete confirmation that the
    "voices silent / music fine" report was pure deploy drift.

### Parity status by subsystem (measured, not asserted)

Do not read the gate table as "1:1 with the engine". Gates prove the
paths we implement behave correctly; they do not prove we implement
everything. Current state, with the evidence behind each line:

| subsystem | status | evidence |
|---|---|---|
| voices | **1:1 proven** | `FUN_0040eda0` filename format + CC→IC probe order decompiled; 5 hardcoded cues validated against `VOICE.PAK`; 43/43 manifest ranges decode as real Ogg |
| backgrounds | high | handler addrs verified via dispatch table; `B%04d%1d%1d.tga` stem proven |
| sprites | high (99.97%) | 14,315/14,319 statements resolve to real `char.pak` files |
| CGs / grp | high (341/341) | `v%06d.tga` overlay, every hit present |
| SE | high (645/646) | only id 180 absent from `SE.PAK` |
| routing | **partially proven** | 11/11 endings, 32/32 choices, 2146/2147 jump targets on instruction boundaries — but several opcode semantics are still inferred |
| music | medium on some rows | BGM pause, camera/zoom, timed wait are `medium` in PARSING.md |

**The concrete gap:** 83 distinct `(4,id)` opcodes appear across the 206
`en_main.pak` scripts. Only **29** have a documented row in PARSING.md.
Those 29 account for **97.47%** of the 1,682,125 `(4,*)` statements, so
**42,641 statements (2.53%) are unimplemented**. The CFG VM's `default`
branches return 0/`cur`, i.e. unknown ops are skipped rather than guessed
— the intended confidence-gated behaviour, but it is not parity.

Largest undocumented by volume: `(4,159)` 7,223 · `(4,225)` 3,103 ·
`(4,210)` 2,859 · `(4,172)` 2,508 · `(4,171)` 2,466 · `(4,2)` 2,145 ·
`(4,195)` 2,089 · `(4,139)` 2,036 · `(4,203)` 1,618 · `(4,207)` 1,558.
The 2xx block is the UI/system layer, so skipping it drops menu and
effect behaviour rather than stage content.

To close it: for each undocumented id, index the dispatch table at
`0x4c2610 + (id-128)*4`, decompile the handler, and either implement it
or record why it is a no-op. That addressing is now settled, so this is
mechanical work over 54 handlers, not an open research problem.
