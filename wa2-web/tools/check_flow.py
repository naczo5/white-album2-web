"""Validate data/flow.json against parsed scenario IR (parity gate).

Checks:
  1. every engine choice event is covered by exactly one flow node
  2. option numbers + texts match the engine tokens (text drift = FAIL;
     translations must not silently change gameplay wording)
  3. engine-evidenced `goto` destinations are preserved (overrides allowed
     only with status VERIFIED_IN_GAME + note)
  4. node ids unique; goto/play targets resolve to known scripts or END:*
  5. every `play` gameplay override is deliberate (node carries a note and
     a status other than NEEDS_REVIEW)
  6. data/endings.json node references (NNNN-NNN patterns) resolve to
     real flow nodes; data/terminals.json chain targets resolve to scripts

Usage: python3 check_flow.py IR_DIR FLOW_JSON [DATA_DIR]
Exit code 0 = parity holds, 1 = report mismatches.
"""

from __future__ import annotations

import glob
import json
import os
import sys


def load_ir(ir_dir: str) -> dict:
    ir = {}
    for fn in sorted(glob.glob(os.path.join(ir_dir, "*.json"))):
        if fn.endswith("index.json"):
            continue
        with open(fn, encoding="utf-8") as f:
            d = json.load(f)
        ir[d["script"]] = d
    return ir


def check_endings_and_terminals(data_dir: str, node_ids: set[str],
                                 scripts: set[str],
                                 errors: list[str]) -> None:
    import re
    ref_re = re.compile(r"\b(\d{4}(?:_\d+)?-\d+)\b")
    end_path = os.path.join(data_dir, "endings.json")
    if os.path.exists(end_path):
        with open(end_path, encoding="utf-8") as f:
            endings = json.load(f)
        for e in endings.get("endings", []):
            for ref in ref_re.findall(e.get("unlock", "")):
                if ref not in node_ids:
                    errors.append(f"endings.json {e.get('id')}: dangling "
                                  f"node ref {ref}")
    term_path = os.path.join(data_dir, "terminals.json")
    if os.path.exists(term_path):
        with open(term_path, encoding="utf-8") as f:
            terms = json.load(f).get("terminals", {})
        for script, t in terms.items():
            if script not in scripts:
                errors.append(f"terminals.json: unknown script {script}")
            if t.get("action") == "chain" and t.get("to") not in scripts:
                errors.append(f"terminals.json {script}: unknown chain "
                              f"target {t.get('to')}")


def main() -> int:
    ir_dir, flow_path = sys.argv[1], sys.argv[2]
    tools_dir = os.path.dirname(os.path.abspath(__file__))
    data_dir = sys.argv[3] if len(sys.argv) > 3 else os.path.join(
        tools_dir, "..", "data")
    ir = load_ir(ir_dir)
    with open(flow_path, encoding="utf-8") as f:
        flow = json.load(f)
    errors: list[str] = []
    # 1. coverage
    engine_choices = {(s, i) for s, d in ir.items()
                      for i, e in enumerate(d["events"]) if e["t"] == "choice"}
    seen = set()
    ids = set()
    for node in flow["nodes"]:
        key = (node["engine"]["script"], node["engine"]["event"])
        if node["id"] in ids:
            errors.append(f"duplicate node id {node['id']}")
        ids.add(node["id"])
        if key in seen:
            errors.append(f"double-covered engine choice {key}")
        seen.add(key)
        if key not in engine_choices:
            errors.append(f"node {node['id']} points at non-choice {key}")
            continue
        ev = ir[key[0]]["events"][key[1]]
        # 2. option parity
        if [o["n"] for o in node["options"]] != [o["n"] for o in ev["options"]]:
            errors.append(f"{node['id']}: option numbers diverged")
        for no, eo in zip(node["options"], ev["options"]):
            if no["text"] != eo["text"]:
                errors.append(f"{node['id']} opt{no['n']}: text drift:\n"
                              f"  flow:   {no['text']!r}\n"
                              f"  engine: {eo['text']!r}")
            # 3. goto preservation
            if eo["goto"] is not None and no.get("goto") != eo["goto"]:
                if node.get("status") != "VERIFIED_IN_GAME":
                    errors.append(f"{node['id']} opt{no['n']}: engine goto "
                                  f"{eo['goto']} overridden without "
                                  f"VERIFIED_IN_GAME status")
        # 4. target resolution (goto + play)
        scripts = set(ir)
        for o in node["options"]:
            for field in ("goto", "play"):
                g = o.get(field)
                if g is None:
                    continue
                if g.startswith("END:"):
                    continue
                if g not in scripts:
                    errors.append(f"{node['id']} opt{o['n']}: unknown {field} target {g}")
            # 5. play overrides must be deliberate, never silent
            if o.get("play") is not None:
                if node.get("status") == "NEEDS_REVIEW" or not node.get("note"):
                    errors.append(f"{node['id']} opt{o['n']}: play override "
                                  f"without deliberate status+note")
    missing = engine_choices - seen
    for key in sorted(missing):
        errors.append(f"engine choice {key} has no flow node")
    check_endings_and_terminals(data_dir, ids, set(ir), errors)
    if errors:
        print(f"{len(errors)} parity errors:")
        for e in errors:
            print(" -", e)
        return 1
    print(f"parity holds: {len(ids)} nodes cover all engine choices")
    return 0


if __name__ == "__main__":
    sys.exit(main())
