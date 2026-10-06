# PARSING — Leaf WA2 scenario `.txt` format (as implemented)

Source: 205 + 49 Shift-JIS token streams from KCAP `en.pak` archives
(MAO-TLs v2.1.0). Zero newlines per file; in-text breaks are literal
`\n`, page breaks literal `\k`. Comma-separated with `"` quote awareness.

## Token kinds

| shape | event |
|---|---|
| `""` | noop |
| `"..."` | dialogue (`say`, speaker = latch) |
| bare `Name` + quoted next | speaker latch |
| bare text | narration |
| `mvNN` | movie cue |
| `<img>.tga` + `bak`/`grp` | image cue + layer (also `.ani` + layer) |
| `<name>.AMP` | fullscreen color-grade filter (exact LUT in data/luts.json) |
| `N. text` runs | choice UI (option 1 = fall through) |
| bare `NNNN[_NNN]` | preload HINT (flow-neutral; proof: `2016` at 2015:1, else the documented 2015:212 choice would be unreachable) |
| `CATCH`/`CATCH2`/`CATCH3` | voice/sync marker (flow-neutral; 174/176 mid-file) |
| `<F16"...">`, `[F16...]` | whisper-size line/span (italic, MAO v2.1.0 reader parity) |
| other `<F..>`/`[S..]` | stripped, text kept |
| `<Wn>`/`[Wn]` | per-char timing, stripped |
| `[Rbase^reading]`, `[Rbase\|reading]` | ruby (both separators occur) |

## Mega-tokens (the hard part)

987 tokens across 153 files merge whole conversations (`"A~,B,"C",D,…`)
because quote parity breaks around structural tokens. `resplit_mega`
recovers display units: structural cut (`mv/tga/AMP/CATCH/ids/options/
layers`), then `,Name,` speaker cuts (~240-name validated latch census;
see `valid_name`), `\k` page
cuts; fragments classified by edge quotes (dialogue iff opens/unbalanced).
Adjacent 1-option choices merge (options interleaved with speaker tags).

This recovered 5 walkthrough-documented choices invisible to naive
parsing (2004 accept/decline, 2013 today/tomorrow, 2014 talk/leave,
2503 concert/stay, 3003 propose/together).

## Voice addressing

Voice clips are addressed by the `.bnr` voice index NNN from `(4,138)`
records `[A,256,0,0,NNN]` (A = speaker slot) — NOT by the script
comma-token. The namespace is per scene-family: base 1008 plays NNN
0-198, variant 1008_020 continues 199-214 (main VOICE.PAK), 1008_030
continues 215-376 — proven by 020's 16 records exactly filling ic's 16
key gaps. tools/build_voice.py maps each NNN record's fractional statement
position to EN events (monotonic greedy, data/voicemap.json); events
without NNN are unvoiced.

Comma-tok coincides with NNN only while a translation stays token-aligned
(1008) and plays wrong-scene clips otherwise: 1002 comma-toks run to 558
while NNN runs 0-353, and 1008 base toks 199-213 collide with 1008_020's
NNN 199-214 (same 16 files — positional truth decides).

## `.bnr` presentation bytecode (LSCR, decoded statically)

Each `NNN.bnr` (LZSS in en.pak) is a u32-LE statement stream split on the
`(6,30)` boundary. Push tags: `(5,3,X)` int, `(5,4,F)` float; ops are
`(2|3|4|6, arg)` pairs. `(3,X)` counters follow the JP token stream
(JP `2001.txt` has 773 tokens vs EN 374 — align via fractional position,
not raw index). Decoders: tools/proto_bgm.py (report:
tools/proto_bgm_report.md), tools/build_bgm.py (timeline),
tools/decode_bnr.py (fades/cams).

| shape | meaning | confidence |
|---|---|---|
| `(5,3,track),(5,3,fade),(5,3,1),(5,3,255),(4,158)` | BGM play `BGM_%03d` | high (exe call chain + census) |
| same pushes + `(6,23)` prefix | BGM play (channel variant) | high |
| `(fade,1,255),(4,5),(3,X),(4,158)` | BGM stop (fade varies) | high |
| track `0` | pause → normalized to stop | medium (exe `BGM-PAUSE`) |
| `(5,3,mode),(5,3,1000),(6,16)` | backdrop fade, 1000 ms | high (shape; player applies, capped) |
| `(6,27)…(5,4,float)…(6,18)` | camera/zoom | medium (reference only) |
| `(5,3,1),(4,132)` etc. | dialogue-line marker | high (445×/2001) |
| `(5,3,0),(5,3,SCRIPT),(4,137)` | script load/jump | high |
| `(5,3,X),(5,3,0),(5,3,0),(4,194)` | timed wait | medium |
| `(5,3,SE),(5,3,255),(4,164)` | sound effect `SE_%04d` (2 pushes only; vol hardcoded 255) | high (thunk→allocator chain + 12/12 census) |
| `(4,146/147)` + `[M,X,Y,F,0,0,0]` | backdrop show: X=0 → bare fade F (transition timing); X=-2 → clear; else filename stem `(str(X)+str(Y)).ljust(6,"0")` plus the `X+Y:02d` form (1004,0 → 100400; 1008,2 → 100820 + 100802; 9900,0 → 990000); prefix (b/v/tv) resolved at lookup | high (manifest cross-checked; 4176 cues) |
| `(4,148)` + `[M,X,Y,F,…]` | event-visual overlay: stem `str(X)+str(Y)` (10010,0 → 100100; 20000,1 → 200001), v*/tv* preferred | high (358 cues) |
| `(4,176)` + `[slot,MODE,2,256,last]` | txt-named image driver (MODE 14 = `.tga` grp, 12/13 = bak/grp; JP toks in `(3,*)` ops match the image context) | high (1007/1008_030 controls) |
| `(4,185)` + `[slot,1,0,0]` after multi-image shows | slot selector for txt-named event art (one per loaded image) | medium (positions unknown) |
| `(4,208)` + `[99,0,0]`/`[99,3,1]`/`[1,1,1]` | choice-present marker (exactly on choice toks; `[99,3,1]` = goto-carrying option) | high (31/31 gate) |
| `(4,209)` + `[0,0,1]` + `(2,0),(6,27),(4,209),(6,16),(6,0)` | choice-commit (1 per choice; payload identical across options — deltas are engine-side) | high |
| `(4,137)` head `[0,SCRIPT]` vs `[N,SCRIPT]` | script load; head N (145-845) = variant entry/replay key (bases open `[0]`; keyless heads = mid-file splice-ins). Mid-file `[N,-1]` = intra-file label jump (N = label id, −1 = current script). | medium |
| `(4,196)` + single ms value | timing/staging cue (0, 1000, …, 112770 — not audio) | medium |

SE triggers unmapped: ascending integer runs below the SE.PAK entry count
in voice-adjacent records (1008_030.bnr body offsets 5029-5485, X in
447..817, each 1×, all < 1132 yet > token count) are the leading
candidates, but corpus-wide filters catch JP token counters just as easily
(false positives verified), so nothing is emitted. The `(5,4,F)` tag and
`(6,21)/(6,19)` neighbors are the next static leads. `.bnr` files contain
zero filenames (only ASCII run in any `.bnr` is `LSCR`) but address `.txt`
by token index (verified: 1008_030 image anchors 44/46/65/67/90/92/107/109
occur exactly 2× each).

## Engine flag tables (script.pak, decoded statically)

- `Global.vrb`: Shift-JIS CSV `type,name,init` — 29 live vars: timers,
  affection (`FLG_雪菜/小春/千晶/麻理好意度`, `FLG_かずさ本気度`,
  `FLG_かずさ浮気度` = uwaki), route-kill (`FLG_*ルート消滅`), per-choice
  pick flags (`FLG_第２部03選択肢１` → script 2003 option 1; 条件 = branch
  condition, e.g. `FLG_第３部15条件２` proves the 3015 switch is gated).
  15/15 pick flags map to real scripts (tools/build_flags.py --ir).
- `GFLAG.dat`: 62 slots × 260 B, `_GFLAG_EV_*` names — chapter clears,
  `２周目以降` replay, novel clears, all route endings.
- `LFScriptFunc{,Ex}.fnc`: opcode vocabulary (SetGameFlag/GetGameFlag,
  SetSelect/SetSelectMess, LoadBmp/SetBmp*, GetReplayMode, EroMode).
  Group numbers in `(4,X)`/`(6,X)` statements are NOT .fnc indices.

## Display granularity assumption (needs play-test)

One fragment = one advance. Plain narration tokens are comma-free by
construction, so comma-piece granularity only affects mega content.
QA item: compare click counts per scene vs the PC build (docs/QA.md).
