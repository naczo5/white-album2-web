"""Census `(4,id)` LSCR opcode occurrences across `.pak` archives.

Two measures are reported per pak because both are useful for different
checks and they answer different questions:

- ``rawPairs``: every adjacent u32 pair ``(4, id)`` in the decompressed
  `.bnr` payload. This is the cheap corpus-wide pin (en_main = 318,810)
  but it also catches float bit patterns and data words that happen to
  equal 4, so ``rawDistinct`` is inflated.
- ``opPairs`` / ``distinct``: the same count after decoding each LSCR entry
  with the **OP0-width-aware** CFG decoder
  (`build_cfg.decode_entry_insns`). This is the real opcode vocabulary
  (en_main = 83, en_special = 63, JP script.pak = 84 distinct ids) and is
  what docs/PARSING.md and the decoder tables should be checked against.
  `proto_bgm.iter_statements` is intentionally not used here: it does not
  consume OP0 header widths, so it can invent ids (2308) and miss real
  ones (206).

Script ids are deduped across paks (main/special variants can share the
same `.bnr` name). No game text is read or printed.

Usage:
  python3 opcode_census.py PAK [PAK ...]
"""

from __future__ import annotations

import collections
import json
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import build_cfg  # noqa: E402
import kcap  # noqa: E402
import lzss  # noqa: E402


def _read_entry(pak_data: bytes, entry: kcap.KcapEntry) -> bytes:
    blob = pak_data[entry.offset:entry.offset + entry.length]
    if entry.is_compressed:
        orig, lz = lzss.split_datahdr(blob)
        return lzss.decompress(lz, orig)
    return blob


def census_payload(payload: bytes) -> dict:
    """Count raw and statement-level `(4,id)` pairs in one `.bnr` payload."""
    n = len(payload) // 4
    raw_ids: collections.Counter[int] = collections.Counter()
    if n:
        vals = struct.unpack_from(f"<{n}I", payload, 0)
        for i in range(n - 1):
            if vals[i] == 4:
                raw_ids[vals[i + 1]] += 1

    op_ids: collections.Counter[int] = collections.Counter()
    secs, code_start = build_cfg.parse_bnr_header(payload)
    if not secs:
        secs = [(0, code_start)]
    ordered = sorted(secs, key=lambda x: x[1])
    for pos, (_eid, start) in enumerate(ordered):
        # Every LSCR entry (story + the >=9000 helper routines) so the set
        # matches the files; `build_cfg` separately skips helpers for CFG.
        end = ordered[pos + 1][1] if pos + 1 < len(ordered) else len(payload)
        for _off, ins in build_cfg.decode_entry_insns(payload, start, end):
            if ins and ins[0] == 4:
                op_ids[int(ins[1])] += 1

    return {
        "rawPairs": sum(raw_ids.values()),
        "rawDistinct": len(raw_ids),
        "rawIds": dict(sorted(raw_ids.items())),
        "opPairs": sum(op_ids.values()),
        "distinct": len(op_ids),
        "opIds": dict(sorted(op_ids.items())),
    }


def census_paks(paths: list[str]) -> dict:
    paks = []
    scripts: set[str] = set()
    all_ops: set[int] = set()
    total_raw = 0
    total_ops = 0
    for path in paths:
        with open(path, "rb") as f:
            data = f.read()
        entries = [e for e in kcap.read_index(data) if not e.is_folder]
        names = {e.name[:-4] for e in entries if e.name.endswith(".bnr")}
        scripts |= names
        raw_pairs = op_pairs = 0
        pak_raw: set[int] = set()
        pak_ops: set[int] = set()
        for ent in entries:
            if not ent.name.endswith(".bnr"):
                continue
            row = census_payload(_read_entry(data, ent))
            raw_pairs += row["rawPairs"]
            op_pairs += row["opPairs"]
            pak_raw.update(row["rawIds"])
            pak_ops.update(row["opIds"])
        total_raw += raw_pairs
        total_ops += op_pairs
        all_ops.update(pak_ops)
        paks.append({
            "pak": os.path.basename(path),
            "scripts": len(names),
            "rawPairs": raw_pairs,
            "rawDistinct": len(pak_raw),
            "opPairs": op_pairs,
            "distinct": len(pak_ops),
        })
    return {
        "paks": paks,
        "overall": {
            "uniqueScripts": len(scripts),
            "rawPairs": total_raw,
            "opPairs": total_ops,
            "distinct": len(all_ops),
            "opIds": sorted(all_ops),
        },
    }


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    paths = sys.argv[1:]
    for path in paths:
        if not os.path.isfile(path):
            raise SystemExit(f"ERROR: pak not found: {path}")
    print(json.dumps(census_paks(paths), indent=1, sort_keys=True))


if __name__ == "__main__":
    main()
