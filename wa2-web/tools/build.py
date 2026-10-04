"""One-command build: user-supplied en.pak files (v2.1.0) -> playable web data.

    python3 build.py MAIN_EN_PAK [SPECIAL_EN_PAK] [OUT_DIR=../build]

Steps:
  1. extract .txt scenario sources (KCAP) from each en.pak
  2. parse to event IR JSON (two-pass corpus census for mega resolution)
  3. emit web data dir: build/data/{scripts/*.json, flow.json, endings.json,
     links.json, terminals.json} (flow/links from IR; endings/terminals
     from data/*.json after parity check)
  4. run parity gates (all engine choices covered, option text exact)

Install: cp -r build/data/* web/public/data/  (see docs/BYOA.md)
Verify translation pin: tools/fetch_mao.py (needs upstream clone/network)
"""

from __future__ import annotations

import glob
import json
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from extract_kcap import extract  # noqa: E402
import parse_txt  # noqa: E402


def parse_corpus(txt_dirs: list[str], ir_dir: str) -> list[str]:
    """Two-pass parse over all txt dirs (shared latch census)."""
    files: list[tuple[str, str]] = []
    for txt_dir in txt_dirs:
        for fn in sorted(os.listdir(txt_dir)):
            if fn.endswith(".txt"):
                files.append((txt_dir, fn))
    census: set[str] = set()
    cache: dict[tuple[str, str], tuple[list[str], list[dict]]] = {}
    seen: dict[str, str] = {}  # script -> txt_dir (later paks override)
    for txt_dir, fn in files:
        with open(os.path.join(txt_dir, fn), "rb") as f:
            toks = parse_txt.split_tokens(f.read())
        events, _ = parse_txt.parse_tokens(toks)
        census.update(e["name"] for e in events if e["t"] == "latch"
                             and parse_txt.census_name(e["name"]))
        cache[(txt_dir, fn)] = (toks, events)
        if fn[:-4] in seen:
            print(f"override: {fn[:-4]} from {txt_dir} wins over {seen[fn[:-4]]}")
        seen[fn[:-4]] = txt_dir
    print(f"census: {len(census)} speaker names over {len(files)} files")
    index = []
    done: set[str] = set()
    for txt_dir, fn in files:
        if fn[:-4] in done or seen[fn[:-4]] != txt_dir:
            continue  # shadowed by a later pak (special EN beats main stub)
        done.add(fn[:-4])
        toks, events = cache[(txt_dir, fn)]
        warnings: list = []
        events, warnings = parse_txt.resplit_mega(events, census, warnings)
        events, warnings = parse_txt.merge_adjacent_choices(events, warnings)
        ir = {"script": fn[:-4], "tokens": len(toks),
              "events": events, "warnings": warnings}
        with open(os.path.join(ir_dir, fn[:-4] + ".json"), "w",
                  encoding="utf-8") as f:
            json.dump(ir, f, ensure_ascii=False, indent=1)
        index.append(ir["script"])
        for w in warnings:
            print(f"      WARN {ir['script']}: {w}")
    return index


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    paks = []
    out = os.path.join(HERE, "..", "build")
    for a in sys.argv[1:]:
        if a.endswith(".pak"):
            paks.append(a)
        else:
            out = a
    txt_dirs, ir_dir = [], os.path.join(out, "ir")
    data_dir = os.path.join(out, "data")
    os.makedirs(ir_dir, exist_ok=True)

    print("[1/4] extracting scenario sources")
    for i, pak in enumerate(paks):
        stem = os.path.splitext(os.path.basename(pak))[0] or "pak"
        txt_dir = os.path.join(out, f"txt_{i}_{stem}")
        os.makedirs(txt_dir, exist_ok=True)
        m = extract(pak, txt_dir, {"txt"})
        files = [f for f in m["files"] if not f.get("folder")]
        print(f"      {pak}: {len(files)} scenario files")
        txt_dirs.append(txt_dir)

    print("[2/4] parsing scenario IR (two-pass)")
    index = parse_corpus(txt_dirs, ir_dir)

    print("[3/4] deriving flow + links (into build/data; data/ keeps only"
          " hand-authored sources + annotation rules)")
    subprocess.run([sys.executable, os.path.join(HERE, "build_flow.py"),
                    ir_dir, os.path.join(out, "flow.skel.json")], check=True)
    flow_out = os.path.join(data_dir, "flow.json")
    os.makedirs(data_dir, exist_ok=True)
    subprocess.run([sys.executable, os.path.join(HERE, "annotate_flow.py"),
                    os.path.join(out, "flow.skel.json"), flow_out], check=True)
    links_out = os.path.join(data_dir, "links.json")
    subprocess.run([sys.executable, os.path.join(HERE, "build_links.py"),
                    ir_dir, links_out], check=True)

    print("[4/4] staging web data + parity gates")
    scripts_out = os.path.join(data_dir, "scripts")
    os.makedirs(scripts_out, exist_ok=True)
    for s in index:
        shutil.copy(os.path.join(ir_dir, s + ".json"),
                    os.path.join(scripts_out, s + ".json"))
    with open(os.path.join(scripts_out, "index.json"), "w") as f:
        json.dump(index, f)
    for name in ("endings.json", "terminals.json"):
        shutil.copy(os.path.join(HERE, "..", "data", name),
                    os.path.join(data_dir, name))
    r = subprocess.run([sys.executable, os.path.join(HERE, "check_flow.py"),
                        ir_dir, os.path.join(data_dir, "flow.json")])
    if r.returncode != 0:
        print("BUILD FAILED: flow parity gate")
        sys.exit(1)
    print("build ok")


if __name__ == "__main__":
    main()
