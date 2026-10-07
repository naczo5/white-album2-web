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
key gaps. **Exact anchor chain (proven, replaces the fractional guess):**
every `(4,138)` record is followed (within 3 statements) by a `(4,131)`
statement carrying `(3,X)` where **X is the JP comma-token of the voiced
line** — verified 41464/41464 exact against JP `script.pak` (100.00%).
MAO's en.pak builds **rebuild** the `.bnr` payloads (0/174 files identical
to JP script.pak) but preserve the `(4,138)`+`(3,X)` anchors in JP
coordinates (1002 anchors run to X=852 while the EN txt has 560 tokens —
the patched engine keeps the JP txt as its coordinate spine).
tools/build_voice.py resolves each anchor exactly: NNN → (3,X) → JP
display line (tok X) → MAO manuscript line (ruby-aware JP containment +
ordinal gap fill) → EN IR event (fetch_mao normalization containment) →
voice-archive line key (`{base}_{NNN:04d}`, family-base chain for
variants) read from the VOICE.PAK/IC LAC names. 35871/48504 records chain
exact; the rest are special-disc variant scripts whose JP txt is absent
from script.pak — they keep the fractional statement-position assignment
(with resolved keys so the right file plays). Output data/voicemap.json
v2 `{script: {ev: key}}` plus data/speakers.json (JP speaker labels →
MAO `speakerEn` by script-scoped name votes — never text position; a
wrong displayed name is worse than a JP one). Events without NNN are
unvoiced.

Comma-tok coincides with NNN only while a translation stays token-aligned
(1008) and plays wrong-scene clips otherwise: 1002 comma-toks run to 558
while NNN runs 0-353, and 1008 base toks 199-213 collide with 1008_020's
NNN 199-214 (same 16 files — positional truth decides).

## `.bnr` presentation bytecode (LSCR, decoded statically)

Each `NNN.bnr` (LZSS in en.pak) is a u32-LE statement stream split on the
`(6,30)` boundary. Push tags: `(5,3,X)` int, `(5,4,F)` float; ops are
`(2|3|4|6, arg)` pairs. `(3,X)` counters are JP token indices: in the JP
build they index the JP txt stream; MAO's en.pak keeps them in JP
coordinates even though its own txt is restructured (the patched engine
resolves them against the still-installed JP script.pak). Decoders:
tools/proto_bgm.py (report:
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
| `(4,165)` + `[ch, se, fade_ms, loop, vol, ?]` | ambient channel SE play: ch 0-3, fade ms (0/30/60/120 common), loop flag (1: 955×, 0: 3528×), volume 0-255 (255/128/80/180/60 seen); thunk 0x40f400; 645/646 distinct ids are `SE_%04d` in SE.PAK (99%; only id 180 absent, sfx max 9801) | high (dispatch entry 37 → 0x40f400 + census) |
| `(4,166)` + `[ch, V]` | channel volume set (V > 0) / channel stop (V ≤ 0 → emitted as `ambStop`) | high (0x40f590) |
| `(4,168)` + `[ch, 0]` | channel stop guarded by engine skip-state check (0x40ad10) — NOT emitted (in normal play the engine keeps the channel; stopping it would be a wrong silence) | medium (documented only) |
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

## Character sprite system (DECODED — proven ops + corpus proof)

Static findings from WA2.exe (.text 0x401000, .rdata 0x4a1000; see
docs/QA.md verification log):

- LSCR dispatch table: .data 0xc1010 (VA 0x4c2610), 112 handler thunks;
  **handler index = opcode − 128** (validated: entry 36 = op 164 = SE
  thunk 0x455720, entry 37 = op 165 = channel-SE 0x40f400). Push values
  reach handlers from ctx `+0x18 + 0x14*i` (push[i] at 0x18, 0x2c, 0x40…).
- **Sprite show = (4,154)/(4,155), pushes `[prefix_id, face, base, …]` →
  file `char\{prefix}{base+face:06d}.tga`.** Proven end-to-end:
  handlers 0x4553f0/0x455590 call the sprite function 0x4160e0, which
  builds the filename via sprintf at 0x415cbf–0x415cdf with format
  `%s%06d.tga` (0x4a28f8) under `char\%s` (0x4a28f0), taking the prefix
  string from a 38-slot table indexed by the slot-state WORD at
  +0xf6 and the number from DWORD +0xf8. Corpus proof: base+face
  addresses a real char.pak/IC file for **14315/14319** statements
  (99.97%; the 4 residuals are one hide-with-garbage-base and 3
  statements in the LF3 digital novel, excluded as malformed — bases
  < 100 never occur as real bases). A second format `'0@%s%05d%d.tga'`
  exists (5-digit + face digit); not needed for decode.
- **Prefix table** (exe .rdata 0x4a2904–0x4a2980 as a stack array built
  at 0x415bf8; ids 6–9 are dud 'a'/uninitialized slots that never occur
  in the corpus): 0 har, 1 kaz, 2 set, 3 koh, 4 izu, 5 mar, 10 tak,
  11 ioo, 12 chi, 13 pap, 14 mam, 15 oto, 16 you, 17 tan, 18 shi,
  19 tom, 20 sat, 21 hon, 22 nak, 23 say, 24 aco, 25 mih, 26 mhh,
  27 ueh, 28 yos, 29 tan, 30 ham, 31 mat, 32 kiz, 33 suz, 34 saw,
  35 miy, 36 yan. (29 and 17 both reference the 'tan' string — exactly
  as written in the exe; id 17's two statements use tan-range files.)
- **Hide = same ops with face sentinel 4000** (e.g. 1008_030 tail hides
  kaz/set/koh slots with bases 2/1/-1 = don't-care). face==0 is a real
  face (files X000 exist); base values seen 1000..31000 = per-character
  pose/outfit groups.
- `base` is what varies per route/state (e.g. Kazusa base 1000 early,
  101000 late-route 6-digit files); `face` is the expression index.
- The player now renders this timeline (web/src/ui/reader.ts
  resolveSprites, test-pinned): latest show per prefix id wins, hide
  clears the slot, hypothesis recs ignored. Screen positions per slot
  are NOT decoded (the trailing 256/128 pushes are unconfirmed) — the
  player spreads sprites evenly as a presentation choice.
- Corpus tests ruled ops 143/156/159/161/166/168/170/180/185 out as
  sprite-SHOW opcodes (143 appears once with the 4000 sentinel but is
  otherwise unrelated); op 176 is the txt-named image driver (MODE 14 =
  .tga grp, already decoded for event art).

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
