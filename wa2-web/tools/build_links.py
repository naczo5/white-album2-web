"""Derive data/links.json: every bare script-id run in the IR.

Semantics (see docs/FLOW_GRAPH.md; established by the 2015-head-link
proof: a bare id at 2015:1 cannot move flow, or the documented choice at
2015:212 would be unreachable):
  HINT    bare ids are loader/voice preload hints; flow-neutral. This covers
          ALL single bare links (every variant-tail HINT equals the numeric
          successor anyway, verified).
  SWITCH  adjacent run of 2+ bare ids at a file tail: runtime candidate set
          for flag selection. The web engine plays the numeric successor
          (recorded as `default`) until play-testing maps the flags.
  DEAD    target script not present in en.pak (5001/5101/5201/5301 novel
          continuations; 5401 has .bnr art only, no .txt).
  BRIDGE  (unused; kept for schema stability) hand-confirmed cross-line
          flow link. Currently none: the single cross-line transition
          (2033 Setsuna-line end -> 3001 Coda prologue) is expressed in
          data/terminals.json, because the bare 3001 hint sits mid-file
          (event 148 of 159) and must NOT cut the closing narration short.

Usage: python3 build_links.py IR_DIR OUT_JSON
"""

from __future__ import annotations

import glob
import json
import os
import sys


def load_ir(ir_dir: str) -> dict:
    out = {}
    for fn in sorted(glob.glob(os.path.join(ir_dir, "*.json"))):
        if fn.endswith("index.json"):
            continue
        with open(fn, encoding="utf-8") as f:
            d = json.load(f)
        out[d["script"]] = d["events"]
    return out


def main() -> None:
    ir_dir, out_path = sys.argv[1], sys.argv[2]
    scripts = load_ir(ir_dir)
    names = set(scripts)
    links = []
    for script in sorted(names):
        evs = scripts[script]
        i = 0
        while i < len(evs):
            e = evs[i]
            if e["t"] == "jump" and e["kind"] == "bare" and e["targets"]:
                run = [(i, e)]
                j = i + 1
                while (j < len(evs) and evs[j]["t"] == "jump"
                       and evs[j]["kind"] == "bare" and evs[j]["targets"]):
                    run.append((j, evs[j]))
                    j += 1
                targets: list[str] = []
                for _, r in run:
                    for t in r["targets"]:
                        if t not in targets:
                            targets.append(t)
                missing = [t for t in targets if t not in names]
                # default: the next base file in play order (variants and
                # self-loops excluded); string sort is wrong here ('3015_2'
                # < '3016' lexically), so compare numerically.
                def sort_key(t: str):
                    parts = t.split("_")
                    return (0 if "_" not in t else 1, int(parts[0]),
                            int(parts[1]) if len(parts) > 1 else 0)
                later = sorted((t for t in targets
                                if t in names and t != script),
                               key=sort_key)
                default = later[0] if later else None
                key = (script, run[0][0])
                if missing and len(missing) == len(targets):
                    status = "DEAD"
                elif len(run) > 1:
                    status = "SWITCH"
                else:
                    status = "HINT"
                links.append({
                    "id": f"{script}-{run[0][0]}",
                    "engine": {"script": script, "events": [r[0] for r in run]},
                    "targets": targets,
                    "missing": missing,
                    "default": default,
                    "status": status,
                })
                i = j
            else:
                i += 1
    counts: dict[str, int] = {}
    for l in links:
        counts[l["status"]] = counts.get(l["status"], 0) + 1
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"version": 1, "counts": counts, "links": links},
                  f, ensure_ascii=False, indent=1)
    print(f"{len(links)} link sites {counts} -> {out_path}")


if __name__ == "__main__":
    main()
