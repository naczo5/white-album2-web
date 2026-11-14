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

## Speaker latch validation (`valid_name`)

A bare token immediately followed by a quoted line *may* be a speaker
latch. Every candidate must pass `parse_txt.valid_name`, which rejects:

- empty tokens and anything longer than 28 chars (a sentence, not a name);
- **punctuation anywhere in the token** —
  `~ . , : ; ! ? … ～ ' " “ ” ‘ ’ \ < > [ ] 。 、 ！ ？ 「 」 『 』`.
  The Japanese set is required because JP narration rows
  (e.g. `あ、い。う？「え」`) otherwise latch as the speaker and
  steal the next line's attribution; the ASCII set covers MAO's narration
  fragments (`And then~ she declared:`). The **curly quotes** `“”‘’` are
  MAO typography for a quoted beat — a critic's quoted phrase arrives as
  `“仮語”` and it must stay narration, never become a speaker name
  for the three lines that follow;
- tokens with no word character at all (`…`, `………`, `--`): pure pause
  beats render as their own line and never enter the name census.

`???` / `？？？` are the one punctuation-only exception: they are genuine
unattributed-speaker tags (ASCII from MAO en.pak, fullwidth from the JP
spine) and latch as themselves. `build_ir._replay_spine` normalizes the
fullwidth form to ASCII `???` so the player never shows `？？？` beside an
English cast list, and `parse_tokens` never consumes either form as a
`CATCH` voice-context argument (that dropped the latch and shifted every
later event index: 1007 tok 1187, 3012 tok 288).

Speaker names come from the JP spine, not the EN payload. In the hybrid
stream a latch event carries the EN name in `name`; only a hybrid event
that is *itself* a latch may fall back to its `text`. A hybrid **narrate**
event never donates text as a name — that was the "EN narration promoted
to speaker" regression (`Someone had scolded me for no reason.`).

## Curly quotes and `？？？` normalization

MAO's manuscript typography reaches the IR through two paths:

- `_QMAP` (build_ir) maps `“ ”` → `"` and `‘ ’` → `'` for **manuscript**
  text, so displayed lines carry straight quotes;
- EN **token** payloads are not remapped, so a curly-quoted beat still
  arrives as `“仮語”` and is rejected by `valid_name` as punctuation.

`？？？` → `???` happens in three places, all for display only: the latch
name and speaker replay in `build_ir._replay_spine`, and the
`speaker_name_map` default in `build_voice.py`. The engine tag itself is
never rewritten in the JP txt — only in the emitted IR/speakers.json.

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

## MAO en.pak layout (two-stream overlay — proven)

**The patched WA2.exe runs two script streams: JP `script.pak` is the
spine, MAO `en.pak` is overlaid per line.** Exe evidence: 4× `script`
string pushes at 0x4177f5/0x417819/0x417945/0x417977 (JP exe: one at
0x41cfe1); `en.pak` string at RVA 0x4a4294. Consequences (all
corpus-verified):

- **EN token *i* == JP token *i* (naive comma split, 1:1).** The exe
  displays EN payload over JP structure — EN tokens only ever replace
  the *text* of the JP token at the same ordinal. Parsing the EN txt
  standalone (old pipeline) produced truncated lines + orphan
  fragments = scrambled dialogue/speakers/staging.
- **Long EN tokens are truncated to the engine token budget; overflow
  fragments are appended at file end in source-line order** (1002:
  35 extras; 143/174 scripts differ by >5 tokens). The exe joins them
  via the `.bnr` sync labels: e.g. `(3,204),(4,131),(3,858),(4,131)`
  = "the line at JP token 204 continues at tail token 858".
- **Line-sync labels in `.bnr`/`.bgm` streams carry `(3,X)` where X is
  the JP naive comma-token index.** Label ops: `(4,131)` [21577×],
  `(4,144)` [15288×], `(131,131)` double form [941×] (source+fragment
  pairs). A record executes at the next label at-or-after it →
  **exact anchors** (tools/bnr_anchor.py), replacing the old
  fractional `idx/n_stmts × m_events` guess everywhere
  (decode_bnr.py, build_bgm.py, build_voice.py).
- **MAO replaced in-text commas with `~`** (the comma is the token
  delimiter); JP options use fullwidth digits (`１．`), MAO EN uses
  ASCII — the OPTION regex accepts both (parse_txt.py).
- **tools/build_ir.py** (JP-spine IR builder): JP tokens →
  shape-preserving EN substitution → spine-classified events → MAO
  manuscript text for say/narrate (ruby-aware JP containment) and
  choice options (manuscript `N．text` rows). Emit rule: all JP pak
  scripts + standalone EN-only omake ids (5200/5400/7000-class, pinned
  by terminals.json) but NOT MAO's `NNNN_N` EN-only splits (2031_2
  etc. — unreachable toolchain splits of inline JP content).
  Event stream is 1:1 with the JP spine (zero drift corpus-wide),
  so `.bnr` `(3,X)` anchors resolve exactly.

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
| `(4,146)` + `[…,X,Y,F,0,0,0]` | backdrop show (bak): handler **0x454f30** → image primitive **0x4167e0** with **arg2=0** (wipe sprites via 0x402680), **arg3=0** → `B%04d%1d%1d.tga` (.rdata 0x4a2a00; third digit = time-of-day from ds:0x5218ac, see `(4,170)`). X=0 → fade F; X=-2 → clear; else stem `f"{X:04d}{Y}{tod}"` (1001,0,tod 0 → 100100). Missing b* leaves prior backdrop (no b→v fall-through) | high (0x454f30 + 0x4167e0 + corpus) |
| `(4,147)` + `[…,X,Y,F,…]` | backdrop show **keeping sprites**: handler **0x454fc0** — same as 146 except **arg2=1** (sprClear off); still **arg3=0** → same `B%04d%1d%1d.tga` bak stems (not grp / not `v%06d`). Was mis-read when arg2 was confused with arg3 | high (0x454fc0 push diff at 0x416833 vs 0x416919) |
| `(4,148)` + `[…,X,Y,F,…]` | event-visual overlay (grp): handler **0x455050** → **arg2=0**, **arg3=1** → `v%06d.tga` (0x4a2a1c); stems `str(X)+str(Y)` padded + alt (10010,0 → 100100). **341/341** grp hits IC+Main | high (0x455050 + corpus) |
| `(4,170)` + push / `[(4,5),(3,val),…]` | sets global **tod** at **ds:0x5218ac** (handler **0x455800** → 0x401870; default 0). Last int push when non-empty; else val after `(4,5),(3,val)` in ops. Drives the third digit in `B%04d%1d%1d.tga` (0..3) | high (0x41680c load + 0x41696c..97 format) |
| `(4,176)` + `[slot,MODE,2,256,last]` | txt-named image driver (MODE 14 = `.tga` grp, 12/13 = bak/grp; JP toks in `(3,*)` ops match the image context) | high (1007/1008_030 controls) |
| `(4,185)` + `[slot,1,0,0]` after multi-image shows | slot selector for txt-named event art (one per loaded image) | medium (positions unknown) |
| `(4,208)` + `[99,0,0]`/`[99,3,1]`/`[1,1,1]` | choice-present marker (exactly on choice toks; `[99,3,1]` = goto-carrying option) | high (32/32 gate) |
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
- **Sprite show = (4,154)/(4,155), pushes `[char_id, face, base, pos, …]` →
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
- **Slot records are keyed by character id, and arg3 = screen position.**
  The slot-finder 0x402220 scans the 8 sprite slot records (stride 0x74,
  base 0x5267f6) comparing the record's char-id word; 8 = not present.
  The show call maps statement args → 0x4160e0(p1=arg0 char_id, p2=arg1
  face, p3=arg2 base, p4=mode flag, p5=arg3 position, …); p5 is stored to
  record+8 and dedupe-compared (0x416189). Position → x-offset table at
  .rdata/**0x4be0bc**: `[-288, 0, +288, -384, +384, -480, +480, -480,
  -160, +160, +480]` px from centre on the 1280-wide stage (indices 0..10;
  corpus distribution 0/1/2 dominate, 3/4 next, 7-10 rare, one oddball
  form with 100000 emits pos=null). The engine allows multiple chars at
  the same position (they stack, draw order = slot allocation order =
  show order).
- **Hide = dedicated ops (4,156) `[char_id, mode, param]` and (4,157)
  `[char_id]`** → shared sprite-clear routine 0x402610(pid, mode, param)
  (handlers 0x4555e0/0x455640; mode 3 = the (4,157) constant form; corpus
  553+175 = 831 hides, all pids valid char ids). Plus the face==4000
  sentinel inside show ops (1 corpus occurrence, 1008_030 tail).
- **Sprite wipe is arg2 on 0x4167e0, not the bak/grp format choice (arg3).**
  arg2=0 on (4,146) and (4,148) reaches clear-all `0x402680`; (4,147) passes
  arg2=1 and keeps standing sprites while updating the bak layer. arg3=0 on
  146/147 → `B%04d%1d%1d.tga`; arg3=1 on 148 → `v%06d.tga` grp only.
  decode_bnr.py emits `sprClear` on 146/148, not 147; resolveSprites applies
  recs in statement order so same-event re-shows survive.
- The player renders this timeline (web/src/ui/reader.ts
  resolveSprites, test-pinned): char-keyed state, hide/sprClear clear,
  x from the 0x4be0bc table, hypothesis recs ignored.
- Corpus tests ruled ops 143/159/161/166/168/170/180/185 out as
  sprite-SHOW opcodes (143 appears once with the 4000 sentinel but is
  otherwise unrelated; 156/157 are the hide ops above); op 176 is the
  txt-named image driver (MODE 14 =
  .tga grp, already decoded for event art). (4,153) is a color-fade op
  (args are color/intensity values), not sprite-related.

## Engine flag tables (script.pak, decoded statically)

- `Global.vrb`: Shift-JIS CSV `type,name,init` — 29 live vars: timers,
  affection (`FLG_雪菜/小春/千晶/麻理好意度`, `FLG_かずさ本気度`,
  `FLG_かずさ浮気度` = uwaki), route-kill (`FLG_*ルート消滅`), per-choice
  pick flags (`FLG_第２部03選択肢１` → script 2003 option 1; 条件 = branch
  condition, e.g. `FLG_第３部15条件２` proves the 3015 switch is gated).
  15/15 pick flags map to real scripts (tools/build_flags.py --ir).
- `GFLAG.dat`: 4-byte `u32` record count (`62`) followed by 62 × 260 B records
  of `(u32 slot, char name[256])` (`_GFLAG_EV_*` names — chapter clears,
  `２周目以降` replay, novel clears, all route endings, and the choice-band
  base at slot `900`). Record 0 holds `slot 0` (`ic-end`), record 61 holds
  `slot 900`, and two records alias `slot 210`; `build_flags.py` emits that as
  `gflagSlots` in `flags.json`.
- `LFScriptFunc{,Ex}.fnc`: opcode vocabulary (SetGameFlag/GetGameFlag,
  SetSelect/SetSelectMess, LoadBmp/SetBmp*, GetReplayMode, EroMode).
  Group numbers in `(4,X)`/`(6,X)` statements are NOT .fnc indices.
- `tools/build_cfg.py` compiles every `.bnr` LSCR bytecode stream (control-flow
  `op 0` subcodes `IF/ELSEIF/ELSE/FOR/WHILE/SWITCH/GOTO`, locals `op 1`, globals
  `op 2`, txt tokens `op 3`, system calls `op 4`, pushes `op 5`, RPN stack ops
  `op 6`) into `cfg.json` v1 (`play` spans `[from, to)`, `setG`/`setL`,
  `setGFlag`, `if`, `choice`, `sload`, `scall`, `ret`, `gotitle`).

## Native PC save files (sample-backed, static format map)

The original build writes fixed-size slot saves and a separate system save.
The samples used for this map were user-supplied and are not committed.

- `save_%02d.sav` and `save_Q.sav`: **0x54fd0 bytes** (348,112) each.
  Header fields confirmed across 11 independent saves:
  - `0x00` u32 version (2)
  - `0x04` u32 playtime/serial
  - `0x08` `SYSTEMTIME` (8 × u16: year, month, weekday, day, hour,
    minute, second, milliseconds)
  - `0x18` CP932 current-line preview, 64-byte buffer
  - `0x112c2` CP932 full current line (soft-wrapped, `~`/`…` separators,
    literal `\n`)
  - `0x116c4` CP932 speaker
  - `0x11714`/`0x11814`/`0x11914` CP932 choice buffers, 256 bytes apart
  - `0x203d8` CP932 script id (e.g. `2003`, `2503`), followed by a
    route/mode string (`2` for IC, `030` for CC/Coda in the samples)
  - the rest is engine VM/graphics state plus two appended blobs written
    by `WriteFile`/append; it is not needed for position import.
- The current **script id + full line + choice buffers** are enough to map
  back to the web IR: exact normalized text finds the line; if the line
  cannot be matched, the three option buffers match a choice event.
  `native-save.ts` implements this and the BYOA corpus test
  (`WA2_NATIVE_SAVES=… WA2_DATA_DIR=… vitest run native-save.corpus`)
  maps 11/11 sample saves. Identical repeated lines are returned as separate
  candidates; Save/Load shows them as option N/M instead of silently
  choosing a scene.
- `Sys.sav`: **0x269480 bytes** (2,528,384), shared by all slots, with no
  header, magic, version or checksum. Three fixed regions. Byte/bit layout
  below is from static reads of `WA2.exe` plus the 2026-11-13 sample save;
  `tools/build_sys_table.py` regenerates the committed id tables and
  `data/sys-slots.json` holds them (functional ids only — no game text).

  **Region A `0x000000..0x07FFFF`** — read-line bitmaps, 512 KB = 4096
  slots × `0x200` bytes. Bit *i* is at byte `i >> 3` with mask
  `0x80 >> (i & 7)` (MSB-first). The bit index is the **read-line counter**
  within the script: one bit per message line, plus a trailing sentinel, so
  a slot's bit count is at most `messageLines + 1`. Verified against the JP
  `script.pak` scripts for the 2026-11-13 sample (`high`): no slot exceeds
  `lines + 1`, and **82 fully-read slots equal exactly `lines + 1` with a
  contiguous run from bit 0** (`1002`: 503 bits / 502 lines; `1003`:
  380/379; `1004`: 357/356; `1007`: 1439/1438; `1008`: 297/296; …).
  Counterexamples to the strong "always `t`" reading: partially read
  scripts stop early (`1012_030`: 310 of 634 lines), and branching scripts
  can leave gaps in the run (`2023`: 296 bits / 302 lines with a gap at
  22→29; `2313`, `2401`, `2402`, `2504` likewise). The three `catch*`
  helper scripts are image-only and set a single bit. So derive per-line
  read state from the ordered message stream against this counter — never
  from raw token ids.
  Slot index = position in the 185-entry `char*` script table at `0x4be530`
  (NULL-terminated). Slot 0 is **excluded/untrusted (`open`)**: the
  script→slot resolver `0x40ea10` compares the incoming id against every
  table entry (scan bound `0x400`) and falls back to index 0 when nothing
  matches, so ids absent from the table (and internal callers) accumulate
  there. The sample shows slot 0 with 1,710 bits, one 52-bit gap (63→115)
  and a tail to bit 1760 while `1001` alone has only 85 message lines.
  Treat slot 0 as reference data, never as a read profile.

  **Region B `0x080000..0x26847F`** — 2,000,000 bytes, one byte per CG id,
  index = `part * 1_000_000 + cgId` (`part 0` → `v%06d.tga`, `part 1` →
  `h%06d.tga`). Writer `0x405290` stores exactly
  `base[part * 0x0f4240 + cgId]`; `0x4c01b0` is the gallery table the
  gallery UI indexes (168 rows × 10 `u32`, ends at `0x4c1bf0` where the
  20-byte-stride ero-scene record list starts: 272 distinct CG ids).
  Sample-save ids are a strict subset of that table.

  **Region C `0x268480..0x26947F`** — 4,096 bytes = 1024 `u32` LE global
  flags, the array behind `GetGameFlag`/`SetGameFlag` (the guarded setter
  `0x405320` writes the in-memory copy at `0x521930`; `0x4760` flushes the
  0x1000-byte block). Ids are assigned by `GFLAG.dat` (`script.pak`, 4-byte
  `u32` count + 62 records × 260 B of `(u32 slot, char name[256])`, emitted as
  `gflagSlots`). Two shipped records alias slot 210; record 0 holds slot `0`
  (`ic-end`) and record 61 holds slot `900` (`choiceBandBase`). Bands (all
  `high`):

  | slots | meaning |
  | --- | --- |
  | `0,1,2,3,4,5,10..15,20..25,30..33,80` | chapter/route clear + ending flags |
  | `99` | choice-system placeholder (`SetSelectMess` compares `GetGameFlag(99)` == 0; setter rejects 99) |
  | `100 + trackId` | music unlocks (~`101..174` in the sample) |
  | `200 + movieId` | movie unlocks (`201..213`, `220..224`), plus `80` |
  | `300..322` | ero-scene unlocks |
  | `900 + 4*choiceIdx + nodeIdx` | choice bitmasks (see below) |

  - **Choice bitmasks** start at `900 + 4 * scriptIdx + nodeIdx`, where
    `scriptIdx` is the position in the 23-entry `u32` choice table at
    `0x4be4d0` (`0x7d3` = 2003 … `0xffffffff`-terminated). That order is
    identical to the ordered unique scripts of `flow.json`. Bit `k`
    (`1 << k`) means option `k + 1` was chosen at least once. The sample
    save shows values `2/3/7` in that band, i.e. multi-bit option history.
  - **`900` collides**: `GFLAG.dat` also names slot `900` in record 61, so read
    the 23×4 choice band from the choice table first and leave any other
    `900..991` bits unclassified (`open`).
  - **Ending slots** (all 11 `high`, verified 1:1 from `GFLAG.dat` + `.bnr`
    `SetGameFlag`) map to `endings.json` ids: `0 ic-end`, `20 cc-normal1`,
    `21 cc-setsuna`, `22 cc-koharu`, `23 cc-chiaki-true`,
    `24 cc-chiaki-normal`, `25 cc-mari`, `30 coda-normal`,
    `31 coda-kazusa-true`, `32 coda-cheating`, `33 coda-setsuna-true`.
  - **Slot 99 is system-reserved.** The guarded setter `0x405320` rejects
    index `99` (prints a reserved-slot warning at `0x4a2018` and substitutes
    index `0`); `SetSelectMess` uses `flagId = 99` as its dummy/unconditional-false
    lookup (`GetGameFlag(99)` == 0). It is not an ending slot.
  - Gate slots used by the menu logic and scripts: `1` Chiaki-normal (gates
    `2003-242` opt1 + IC replay extras), `2` replay (2nd playthrough),
    `5` coda entered, `21` cc-setsuna cleared (unlocks coda), `99`
    choice-system slot. `0x4138fb` resets the replay/system words on new-game
    setup and calls the guarded setter; `0x428200` is the gallery cell
    reader; `0x44e1d0` is the packed-bit get/set helper (bit width 1/2/4 only),
    and `0x405410` builds the `Sys.sav` path/state. Region C is mirrored at
    `0x521930` (the in-memory array the setters write before `0x4760` flushes
    the 0x1000-byte block).

  The slot saves do not contain this read/choice profile, so importing it
  means reading `Sys.sav`. Consumed through the `sysSlots` bundle key;
  the Slot/Quick import keeps working without it because the shipped
  Router's choice destinations come from `flow.json`.
- `save_XX.sav` also embeds a `Global.vrb` snapshot at `0x54cb0`
  (`high`): `u32 totalBytes = 800` (the whole block, header included),
  `u32 count = 29`, then 29 records of `u32 nameLen` (CP932 name incl. NUL),
  name, `u32 type` (`3` = int), `u8 value`. Records occupy 792 bytes and the
  block ends exactly at the file end `0x54fd0`. These are the same 29
  variables `build_flags.py` reads from `script.pak`, so a save carries its
  own live flag copy (affection, route-kill, per-choice pick flags).
- Save thumbnails: `save.tga` is a separate screenshot file; the slot
  files also contain a 64×96 RGBA preview near `0x58`. Neither is used by
  the importer.

## Display granularity assumption (needs play-test)

One fragment = one advance. Plain narration tokens are comma-free by
construction, so comma-piece granularity only affects mega content.
QA item: compare click counts per scene vs the PC build (docs/QA.md).
