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

Every say/narrate event carries `tok`: the raw comma-token index in its
source file. Voice clips are addressed `{script}_{tok:04d}` (XOR-decoded
VOICE.PAK names), so resplit fragments share their parent token's voice
(played once, on the first fragment). Verified: 1008 tok199 and 2001
tok19 match clip content exactly.

## Display granularity assumption (needs play-test)

One fragment = one advance. Plain narration tokens are comma-free by
construction, so comma-piece granularity only affects mega content.
QA item: compare click counts per scene vs the PC build (docs/QA.md).
