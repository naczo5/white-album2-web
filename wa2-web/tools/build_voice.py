"""Build per-line voice map from .bnr voice records (static, no game run).

Voice clips are addressed by the .bnr voice index NNN from (4,138)
records `[2,256,0,0,NNN]` — NOT by the script comma-token. The two
numberings coincide while a translation stays token-aligned (1008:
313/313) and diverge otherwise (1002: comma-toks run to 558 while NNN
runs 0-353; every NNN exists as a file, 30 extra keys unaddressed).
Mapping by comma-tok plays wrong-scene clips in divergent files.

Method (mirrors build_bgm.py): each NNN record's fractional statement
position maps to EN events via monotonic greedy assignment — records in
statement order take the nearest still-unassigned voiced event at/after
the previous assignment. Order-preserving, collision-free; events without
NNN are unvoiced (silence), exactly like the engine hitting a display step
with no voice record. Comma-tok is NOT consulted: it coincides with NNN
only while a translation stays token-aligned, and plays wrong-scene clips
otherwise (1008 base toks 199-213 vs 1008_020's NNN 199-214 share the same
16 files — positional truth decides).

Output (build artifact): {version: 1, map: {script: {ev: nnn}}}
Files with no (4,138) records (1001 prologue) get no entry.

Usage: python3 build_voice.py MAIN_EN_PAK [SPECIAL_EN_PAK] OUT_JSON --ir IR_DIR
"""

from __future__ import annotations

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import kcap  # noqa: E402
import lzss  # noqa: E402
import parse_txt  # noqa: E402
from proto_bgm import iter_statements, load_bnr, s32  # noqa: E402


def voice_records(data: bytes, script: str):
    """(stmt_idx, n_stmts, nnn) for every (4,138) voice record."""
    payload, _ = load_bnr(data, script)
    stmts = list(iter_statements(payload))
    n = len(stmts)
    out = []
    for idx, _off, pushes, ops, _raw, _floats in stmts:
        if any(o == 4 and a == 138 for o, a in ops) and len(pushes) >= 5:
            out.append((idx, n, s32(pushes[4])))
    return out


def assign_nnn(fracs: list[tuple[float, int]], voiced: list[int],
               m: int) -> dict[int, int]:
    """Monotonic greedy: records in statement order take the nearest
    still-unassigned voiced event (by fractional target). Pure; tested."""
    used: set[int] = set()
    rows: dict[int, int] = {}
    for frac, nnn in fracs:
        target = frac * m
        best: int | None = None
        best_key = None
        for ev in voiced:
            if ev in used:
                continue
            key = (abs(ev - target), ev)
            if best_key is None or key < best_key:
                best_key = key
                best = ev
        # monotonicity: never assign behind the previous assignment
        if best is None:
            continue
        if rows:
            prev_max = max(rows)
            if best < prev_max:
                later = [ev for ev in voiced
                         if ev not in used and ev >= prev_max]
                if not later:
                    continue
                best = min(later, key=lambda ev: (abs(ev - target), ev))
        used.add(best)
        rows[best] = nnn
    return rows


def main() -> None:
    argv = sys.argv[1:]
    ir_dir = None
    if "--ir" in argv:
        i = argv.index("--ir")
        ir_dir = argv[i + 1]
        del argv[i:i + 2]
    *paks, out_path = argv
    if ir_dir is None:
        print("need --ir IR_DIR")
        sys.exit(2)
    src: dict[str, bytes] = {}
    for pak_path in paks:
        with open(pak_path, "rb") as f:
            data = f.read()
        for e in kcap.read_index(data):
            if e.is_folder or not e.name.endswith(".bnr"):
                continue
            src[e.name[:-4]] = data
    vmap: dict[str, dict[str, int]] = {}
    n_rec = n_hit = 0
    for script in sorted(src):
        fn = os.path.join(ir_dir, script + ".json")
        if not os.path.isfile(fn):
            continue
        ir = json.load(open(fn, encoding="utf-8"))
        if not isinstance(ir, dict):
            continue
        events = ir.get("events", [])
        voiced = [i for i, e in enumerate(events)
                  if isinstance(e, dict) and e.get("t") in ("say", "narrate")]
        if not voiced:
            continue
        try:
            recs = voice_records(src[script], script)
        except KeyError:
            continue
        m = len(events)
        fracs = [(idx / max(1, n), nnn) for idx, n, nnn in recs]
        placed = assign_nnn(fracs, voiced, m)
        n_rec += len(recs)
        n_hit += len(placed)
        rows = {str(ev): nnn for ev, nnn in placed.items()}
        if rows:
            vmap[script] = rows
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"version": 1, "map": vmap}, f)
    print(f"voice: {len(vmap)} scripts, {n_hit}/{n_rec} records placed "
          f"-> {out_path}")


if __name__ == "__main__":
    main()
