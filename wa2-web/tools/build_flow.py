"""Emit data/flow.skeleton.json from parsed scenario IR.

For every engine `choice` event, records the authoritative facts:
script id, token index, option numbers + texts, and bare-id `goto`
destinations (option 1 = fall through). Everything else (in-story date,
flag effects, visibility gating, walkthrough cross-refs) is left null with
status NEEDS_REVIEW for annotation in data/flow.json.

Usage: python3 build_flow.py IR_DIR OUT_JSON
"""

from __future__ import annotations

import glob
import json
import os
import sys


def main() -> None:
    ir_dir, out_path = sys.argv[1], sys.argv[2]
    nodes = []
    for fn in sorted(glob.glob(os.path.join(ir_dir, "*.json"))):
        if fn.endswith("index.json"):
            continue
        with open(fn, encoding="utf-8") as f:
            ir = json.load(f)
        for idx, e in enumerate(ir["events"]):
            if e["t"] != "choice":
                continue
            nodes.append({
                "id": f"{ir['script']}-{idx}",
                "engine": {"script": ir["script"], "event": idx},
                "options": [
                    {"n": o["n"], "text": o["text"], "goto": o["goto"]}
                    for o in e["options"]
                ],
                "date": None,
                "effects": {},
                "gated": {},
                "walkthrough": None,
                "status": "NEEDS_REVIEW",
            })
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"version": 1, "nodes": nodes}, f, ensure_ascii=False, indent=1)
    print(f"{len(nodes)} choice nodes -> {out_path}")


if __name__ == "__main__":
    main()
