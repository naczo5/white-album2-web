# BGM scene→track mapping: static reverse-engineering report

## Verdict

BGM selection lives in the `.bnr` LSCR bytecode, opcode **(4,158)**.
Statement shape: `PUSH track, PUSH fade, PUSH 1, PUSH 255, OP(4,158)`,
i.e. u32 stream `05 03 TRACK | 05 03 FADE | 05 03 01 | 05 03 FF | 04 9E`.
Variant: same pushes + prefix op `(6,23)` (channel/flag variant, same arg0).
Stop shape (5 occurrences, main pak): pushes `(-2,1,255)` + ops
`(4,5),(3,X),(4,158)` — no track, X = JP-tok counter (explicit silence).

Prototype: `tools/proto_bgm.py`. Run:
`python3 proto_bgm.py EN_PAK SCRIPT... --bgm-pak BGM.PAK`.

## Evidence chain (all static)

1. `WA2.exe` string table (file offsets): `[bgm_%03d.ogg]`@0xa11d3,
   `BGM_%03d_b.ogg`@0xa11e4, `BGM_%03d_a.ogg`@0xa11f4,
   `BGM_%03d.ogg`@0xa1218, `BGM-PAUSE`@0xa1228 — A/B = loop intro/body,
   matching `BGM.PAK`'s 108 files (`BGM_001_A/B` … `BGM_074`; XOR-0xFF names,
   count 108 at LAC header; IC `BGM.PAK` = 57-file subset).
2. sprintf call sites formatting the track (llvm-objdump of `.text`):
   `0x4069af/406a01/406a4d` push the three `BGM_%03d*` formats; the int
   argument is `%ebp` = function arg0 = requested track number.
3. `0x4068a0` = 7-arg BGM-play (writes 0x2c-stride channel structs at
   `0x4bf63c…`, dedupes: re-request of current track in `0x4bf638` jumps to
   no-op exit at `0x406b1d`). Wrapper `0x40fb80` range-checks
   `cmpl $0xc7,%esi` (track ≤ 199) at `0x40fb85`, else error path.
4. LSCR bridge `0x423d3b`: `push %ebx; push $1; push %edx; push %eax;
   push $-2; push %ecx; call 0x40fb80` — the `-2` and `1` immediates are the
   same constants as bnr pushes `[track,-2,1,255]`; `%ecx` = stack-array
   slot 0 = first-pushed value = track. (`0x423d79` sibling calls `0x4068a0`
   directly with 7 pushes for the `(6,23)` variant path.)
5. Corpus proof (206 main + 49 special `.bnr`): every `(4,158)` play's
   pushes[0] is a shipped BGM number. Main BGM.PAK holds loop pairs plus
   solo `BGM_NNN.OGG` files (004, 005, 019-022, 028, 029, 032 among them —
   an early `track_set()` draft missed solos by splitting on `_`; fixed).
   78/79 ship only on the bonus disc (WA2_EE_SC BGM.PAK, 140 files, cued by
   bonus scenario 4009; JP 4009.bnr agrees stmt-for-stmt). Zero
   counterexamples. Unused numbers `{30,31,34,35,60..71,74}` have no
   in-script cue (movie-scene or spare tracks). 203/206 main files carry
   cues; the 3 without (`1008_020, 1012_020, 3906_2`) inherit the previous
   file's BGM (engine never auto-stops at file boundaries — only 10
   explicit stops exist corpus-wide).

## Bytecode format (new, goes beyond prior attempts)

- Magic variants = section-table sizes: `LSCR 0x14` (code@28, 1 section),
  `LSCR 0x1c` (code@28), `LSCRD 0x44` (68-B header: u32 count=7 + seven
  `(id,offset)` pairs `(9999,76),(9997,316),(9996,504),(9995,556),
  (9994,1124),(9993,1712),(0,1792)`; main code = id-0 section).
  The 9993 prologue calls other sections (`…9995,4,2…`), i.e. subroutines.
- Stream = u32 LE words. `(5,3,X)` = push int X (5495× in 2001).
  `(6,30)` = statement boundary (2290× in 2001 ≈ display steps).
  `(3,X)` = JP-token counter (monotonic 4→~772 in 2001; JP `2001.txt` has
  773 raw tokens vs EN 374 — the bnr counters follow the JP token stream,
  so exact tok mapping needs JP↔EN alignment; the prototype uses fractional
  statement position snapped to the current `bak` scene + nearest dialogue).
- Common idioms: `(5,3,1,4,132)` = dialogue line (445×/2001),
  `(5,3,0,5,3,SCRIPT,4,137)` = script-load (137 = load/jump),
  `(4,146/147)` + `1280.0/720.0` floats (`0x44A00000/0x44340000`) = image
  show, `(5,3,X,5,3,0,5,3,0,4,194)` = timed wait, `(4,154)` = voice cue.

## Sample output (prototype, fractional scene map)

- 2001: 9 plays — stmts 148/382/578/943/1304/1616/1870/2010/2185 →
  tracks 7,1,5,3,1,42,7,41,16 (e.g. stmt148 = `bnr+10240`, frac 0.065,
  ev23/tok26, scene `B990000.tga`).
- 2019: 10 plays → 15,45,16,41,42,40,15,41,40,12.
- 2301: 3 plays → 5,42,41.
- 1008_050: plays 1,15,24 + 2 stops (stmts 9,359, each directly after a play).
- 1001: 1 play → track 8 (stmt19, `bnr+1000`).

## Confidence / limits

- Opcode identity: **high** (exe→LSCR call chain + zero-counterexample
  corpus census + A/B filename cross-check).
- Track numbers: **high** (same proof; `MISSING` flag in prototype output
  fires on zero files).
- Scene/tok placement: **medium** — fractional interpolation between `bak`
  scenes, exact to the scene, ±few lines within it (JP-counter vs EN-token
  drift; single-`bak` files map trivially). Pin to exact lines by aligning
  the `(3,X)` JP counter through a JP↔EN token map (future work).
- Fade/volume args (pushes[1..3], `(6,23)` channel bit): **low** —
  field names guessed from asm arity, values passed through verbatim.
- Files with no cue inherit prior BGM; the web player must NOT stop BGM on
  file change unless a stop shape or a new track occurs.
