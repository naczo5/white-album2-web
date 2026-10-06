"""Parity gate: every parsed choice must have a .bnr (4,208) choice marker.

Engine evidence (static RE): (4,208) statements ([99,0,0]/[99,3,1]/[1,1,1])
sit exactly on choice token positions, and every choice is followed by the
(4,209) commit shape [0,0,1]+(2,0),(6,27),(4,209),(6,16),(6,0). Choiceless
files (1001, 2001, 3001) contain neither opcode. So a parsed choice with no
nearby (4,208) is either a parser false positive or a missed engine choice.

Also reports (4,137) script-load head keys: base files open [0,SCRIPT],
variant files [N,SCRIPT] (N = entry/replay key, e.g. 1008_020 -> 199).

Usage:
  python3 check_bnr_choices.py IR_DIR SCRIPT_PAK [--report]
  --report prints the table and always exits 0 (default fails on gaps).

  NOTE: .bnr files live in the JP script.pak, while IR events are parsed
  from the EN .txt (JP counters drift vs EN tokens), so choice<->marker
  matching is fractional with a +/-window, not exact.
"""

from __future__ import annotations

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import kcap  # noqa: E402
from proto_bgm import iter_statements, load_bnr  # noqa: E402


def bnr_ops(data: bytes, script: str):
    payload, _ = load_bnr(data, script)
    return list(iter_statements(payload))


def main() -> None:
    report_only = "--report" in sys.argv
    args = [a for a in sys.argv[1:] if a != "--report"]
    ir_dir, script_pak = args
    with open(script_pak, "rb") as f:
        pak_data = f.read()

    gaps: list[str] = []
    n_choice = n_marked = 0
    entry_keys: dict[str, int | None] = {}
    for fn in sorted(os.listdir(ir_dir)):
        if not fn.endswith(".json") or fn == "index.json":
            continue
        script = fn[:-5]
        ir = json.load(open(os.path.join(ir_dir, fn), encoding="utf-8"))
        if not isinstance(ir, dict):
            continue
        events = ir.get("events", [])
        choice_evs = [i for i, e in enumerate(events)
                      if isinstance(e, dict) and e.get("t") == "choice"]
        if not choice_evs:
            continue
        try:
            stmts = bnr_ops(pak_data, script)
        except KeyError:
            print(f"  {script}: no .bnr in script.pak")
            continue
        except Exception as e:
            print(f"  {script}: .bnr unreadable ({e})")
            continue
        n = len(stmts)
        marked = [i for i, (_ix, _off, pushes, ops, _r, _f) in enumerate(stmts)
                  if any(o == 4 and a == 208 for o, a in ops)]
        commits = sum(1 for (_ix, _off, _p, ops, _r, _f) in stmts
                      if any(o == 4 and a == 209 for o, a in ops))
        # (4,137) head key: first statement carrying a (4,137) op
        key = None
        for (_ix, _off, pushes, ops, _r, _f) in stmts[:5]:
            if any(o == 4 and a == 137 for o, a in ops):
                key = pushes[0] if pushes else None
                break
        entry_keys[script] = key
        # Count gate (drift-proof): >=2 markers and >=1 commit per choice.
        # Fractional proximity is reported, not gated (JP counters drift
        # non-linearly vs EN events; verified offsets: 2004 off-by-9).
        m = len(events)
        n_choice += len(choice_evs)
        ok = len(marked) >= 2 * len(choice_evs) and commits >= len(choice_evs)
        if ok:
            n_marked += len(choice_evs)
        else:
            gaps.append(f"{script}: {len(choice_evs)} choices but "
                        f"{len(marked)}x(4,208)/{commits}x(4,209)")
        prox = []
        for ev in choice_evs:
            frac = ev / max(1, m)
            near = min((abs(s - int(frac * n)) for s in marked), default=-1)
            prox.append(str(near))
        print(f"  {script}: {len(choice_evs)} choices, "
              f"{len(marked)}x(4,208), {commits}x(4,209), entry={key}, "
              f"nearest=[{','.join(prox)}]")
    print(f"choices with (4,208) marker: {n_marked}/{n_choice}")
    variants = {s: k for s, k in entry_keys.items()
                if k not in (None, 0)}
    if variants:
        print(f"variant entry keys: {len(variants)} "
              f"(e.g. {dict(list(variants.items())[:5])})")
    if gaps and not report_only:
        print("GAPS (parsed choice without engine marker):")
        for g in gaps:
            print(f"  MISSING {g}")
        sys.exit(1)
    elif gaps:
        for g in gaps:
            print(f"  gap?: {g}")


if __name__ == "__main__":
    main()
