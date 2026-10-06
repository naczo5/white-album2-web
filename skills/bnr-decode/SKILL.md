---
name: bnr-decode
description: Decode Leaf LSCR presentation bytecode (.bnr) into playback timelines. Use for BGM/SE/voice/backdrop mapping, opcode identification, or any question about what the engine shows or plays at a given script position.
---

# BNR decode skill

Statements live in `en.pak` / `script.pak` `NNN.bnr` files (LZSS inside
KCAP — see `kcap.py`, `lzss.py`). Split with `proto_bgm.iter_statements`
(u32-LE words, `(6,30)` boundaries): `(5,3,X)` = int push, `(5,4,F)` =
float push, `(2|3|4|6,arg)` = ops. `(3,X)` counters follow the **JP**
token stream (JP `2001.txt` = 773 parts vs EN 374) — map fractionally or
via anchors, never by raw index.

## Proven opcodes (high confidence, exe + census backed)

| shape | meaning | owner |
|---|---|---|
| `[track,fade,1,255]+(4,158)` | BGM play `BGM_%03d` (`_a/_b` loop pair) | `build_bgm.py` |
| `(fade,1,255)+(4,5),(3,X),(4,158)` / track 0 | BGM stop / pause | `build_bgm.py` |
| `[SE,255]+(4,164)` | SE play `SE_%04d` | `decode_bnr.py` (conf high) |
| `[A,256,0,0,NNN]+(4,138)` | voice line NNN (A = speaker slot; per scene-family namespace) | `build_voice.py` |
| `[M,X,Y,F,…]+(4,146/147)` | backdrop (X=0 fade-only, X=-2 clear, else stems) | `decode_bnr.py` |
| `[M,X,Y,F,…]+(4,148)` | event-visual overlay | `decode_bnr.py` |
| `[99,…]+(4,208)` / `[0,0,1]+(4,209)` | choice-present / choice-commit | `check_bnr_choices.py` |
| `[0,SCRIPT]+(4,137)` head / `[N,-1]` mid-file | script load / label jump | reference |

Full table + evidence: `wa2-web/docs/PARSING.md`. Exe proof pattern:
`WA2.exe` sprintf sites → wrapper → LSCR bridge immediates matching bnr
push constants (see `wa2-web/tools/proto_bgm_report.md`).

## Rules

- New opcode claims need an exe call chain AND a zero-counterexample
  corpus sweep — value-shape matches alone are worthless here (SEQ/JP
  counters triple-cover small ints; documented false positives).
- Emit `conf: "high"` only for proven shapes; everything else is
  `"hypothesis"` reference data the player ignores (`docs/QA.md`).
- Placement is fractional (statement/n) snapped to EN events —
  scene-exact, ±lines. Never renumber EN tokens to fit.
