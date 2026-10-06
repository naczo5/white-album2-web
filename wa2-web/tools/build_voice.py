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

Usage: python3 build_voice.py MAIN_EN_PAK [SPECIAL_EN_PAK] OUT_JSON --ir IR_DIR [--jp SCRIPT_PAK]
(--jp enables dialogue/narration affinity via JP token shapes.)
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


def voice_records(data: bytes, script: str, jp_data: bytes | None = None):
    """(stmt_idx, n_stmts, nnn, is_dialog) for every (4,138) voice record.

    is_dialog comes from JP token shapes near the record (quoted JP comma
    tokens); None when no JP pak was given. Voice records sit next to
    dialogue ~always (1002: 328/328, 2001: 316/316); the exceptions are
    voiced narration (Haruki's thoughts, e.g. 1008 concert), which is why
    the flag only biases assignment instead of filtering.
    """
    payload, _ = load_bnr(data, script)
    stmts = list(iter_statements(payload))
    n = len(stmts)
    jt = None
    if jp_data is not None:
        try:
            jt = jp_tokens(jp_data, script)
        except KeyError:
            jt = None
    out = []
    for idx, _off, pushes, ops, _raw, _floats in stmts:
        if any(o == 4 and a == 138 for o, a in ops) and len(pushes) >= 5:
            is_dialog = None
            if jt is not None:
                xs = []
                for j in range(max(0, idx - 8), min(n, idx + 9)):
                    xs += [a for o, a in stmts[j][3] if o == 3]
                is_dialog = any(
                    0 <= x < len(jt) and jt[x].strip().startswith(('"', "「"))
                    for x in xs)
            out.append((idx, n, s32(pushes[4]), is_dialog))
    return out


def jp_tokens(jp_data: bytes, script: str) -> list[str]:
    for e in kcap.read_index(jp_data):
        if not e.is_folder and e.name == script + ".txt":
            s, e2 = kcap.data_range(e)
            blob = jp_data[s:e2]
            if e.is_compressed:
                orig, lz = lzss.split_datahdr(blob)
                blob = lzss.decompress(lz, orig)
            return parse_txt.split_tokens(blob)
    raise KeyError(script + ".txt")


def assign_nnn(fracs: list[tuple[float, int, bool | None]],
               voiced: list[tuple[int, str]], m: int) -> dict[int, int]:
    """Monotonic greedy: records in statement order take the nearest
    still-unassigned voiced event. Kind affinity first: a dialogue-shaped
    record prefers say events (narration-shaped prefers narrate) with a
    2%-of-file distance penalty for mismatches, so voiced thoughts still
    map when nothing else is near. Pure; tested."""
    penalty = max(1, m // 50)
    used: set[int] = set()
    rows: dict[int, int] = {}
    for frac, nnn, is_dialog in fracs:
        target = frac * m
        want = "say" if is_dialog else ("narrate" if is_dialog is False else None)
        best: int | None = None
        best_key = None
        for ev, kind in voiced:
            if ev in used:
                continue
            key = (abs(ev - target) + (0 if want is None or kind == want else penalty), ev)
            if best_key is None or key < best_key:
                best_key = key
                best = ev
        # monotonicity: never assign behind the previous assignment
        if best is None:
            continue
        if rows:
            prev_max = max(rows)
            if best < prev_max:
                later = [ev for ev, _k in voiced
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
    jp_path = None
    if "--ir" in argv:
        i = argv.index("--ir")
        ir_dir = argv[i + 1]
        del argv[i:i + 2]
    if "--jp" in argv:
        i = argv.index("--jp")
        jp_path = argv[i + 1]
        del argv[i:i + 2]
    *paks, out_path = argv
    if ir_dir is None:
        print("need --ir IR_DIR")
        sys.exit(2)
    jp_data = open(jp_path, "rb").read() if jp_path else None
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
        voiced = [(i, e.get("t")) for i, e in enumerate(events)
                  if isinstance(e, dict) and e.get("t") in ("say", "narrate")]
        if not voiced:
            continue
        try:
            recs = voice_records(src[script], script, jp_data)
        except KeyError:
            continue
        m = len(events)
        fracs = [(idx / max(1, n), nnn, is_dialog)
                 for idx, n, nnn, is_dialog in recs]
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
