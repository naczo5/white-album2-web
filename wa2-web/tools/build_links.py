"""Derive data/links.json: script-id jump runs in the IR.

Semantics (see docs/FLOW_GRAPH.md; established by the 2015-head-link
proof: a bare id at 2015:1 cannot move flow, or the documented choice at
2015:212 would be unreachable):
  HINT    a single script target is a loader/voice preload hint; flow-neutral.
  SWITCH  a jump event with 2+ distinct script targets, or an adjacent run
          of jump events: runtime candidate set for flag selection. The web
          engine plays the numeric successor (recorded as `default`) until
          play-testing maps the flags.
  DEAD    target script not present in the IR.
  BRIDGE  (unused; kept for schema stability) hand-confirmed cross-line
          flow link.

Both encodings occur: the EN toolchain emits bare ids, while the JP spine
emits CATCH/CATCH2/CATCH3 immediately followed by the same target ids
(2020-2023: `CATCH2 [2022,2025]`; 2402: `[2403,2413]`; 3023: `[3201,3101]`).
Voice-context CATCH targets (a speaker name such as `雪菜`, `かずさ`) are
NOT links and are filtered by script-id shape.

Usage: python3 build_links.py IR_DIR OUT_JSON
"""

from __future__ import annotations

import glob
import json
import os
import re
import sys

SCRIPT_ID = re.compile(r"^\d{4}(?:_\d+)?$")


def load_ir(ir_dir: str) -> dict:
    out = {}
    for fn in sorted(glob.glob(os.path.join(ir_dir, "*.json"))):
        if fn.endswith("index.json"):
            continue
        with open(fn, encoding="utf-8") as f:
            d = json.load(f)
        out[d["script"]] = d["events"]
    return out


def script_targets(e: dict) -> list[str]:
    """Script-id targets of a jump event (CATCH voice names filtered)."""
    if e.get("t") != "jump":
        return []
    out = []
    for t in e.get("targets") or []:
        if SCRIPT_ID.match(t) and t not in out:
            out.append(t)
    return out


def derive_links(scripts: dict) -> list[dict]:
    """Pure IR -> link sites (CATCH voice names filtered, bare ids kept)."""
    names = set(scripts)
    links = []
    for script in sorted(names):
        evs = scripts[script]
        i = 0
        while i < len(evs):
            first = script_targets(evs[i])
            if not first:
                i += 1
                continue
            run = [(i, evs[i])]
            j = i + 1
            while j < len(evs) and script_targets(evs[j]):
                run.append((j, evs[j]))
                j += 1
                if len(run) > 8:  # never swallow a whole script
                    break
            targets: list[str] = []
            for _, r in run:
                for t in script_targets(r):
                    if t not in targets:
                        targets.append(t)
            missing = [t for t in targets if t not in names]
            # default: the next base file in play order (string sort is
            # wrong here: '3015_2' < '3016' lexically), variants after base.
            def sort_key(t: str):
                parts = t.split("_")
                return (0 if "_" not in t else 1, int(parts[0]),
                        int(parts[1]) if len(parts) > 1 else 0)
            later = sorted((t for t in targets
                            if t in names and t != script),
                           key=sort_key)
            default = later[0] if later else None
            if missing and len(missing) == len(targets):
                status = "DEAD"
            elif len(targets) > 1 or len(run) > 1:
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
    return links


def main() -> None:
    ir_dir, out_path = sys.argv[1], sys.argv[2]
    links = derive_links(load_ir(ir_dir))
    counts: dict[str, int] = {}
    for l in links:
        counts[l["status"]] = counts.get(l["status"], 0) + 1
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"version": 1, "counts": counts, "links": links},
                  f, ensure_ascii=False, indent=1)
    print(f"{len(links)} link sites {counts} -> {out_path}")


if __name__ == "__main__":
    main()
