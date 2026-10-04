"""Full-game simulation: walk every script event-by-event (parity smoke test).

Mirrors web/src/engine/router.ts exactly (links, detour-once, terminals,
spine). Reports coverage + stalls. See docs/QA.md.

    python3 simulate.py IR_DIR FLOW_JSON LINKS_JSON TERMINALS_JSON [strategy]

Strategies: first | routers (prefer untaken engine gotos) | chiaki (2019
opt1/opt2 path) | mari (2019 opt2) | koharu (2019 opt3).
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


def chapter(s: str) -> str:
    b = int(s.split("_")[0])
    if 1001 <= b <= 1013:
        return "intro"
    if 2001 <= b <= 2517:
        return "closing"
    if 3001 <= b <= 3999 or 5000 <= b <= 5104:
        return "coda"
    return "special"


def main() -> int:
    ir_dir, flow_path, links_path, term_path = sys.argv[1:5]
    strategy = sys.argv[5] if len(sys.argv) > 5 else "routers"
    scripts = load_ir(ir_dir)
    flow = json.load(open(flow_path, encoding="utf-8"))
    links = json.load(open(links_path, encoding="utf-8"))
    terms = json.load(open(term_path, encoding="utf-8"))["terminals"]
    nodes = {(n["engine"]["script"], n["engine"]["event"]): n for n in flow["nodes"]}
    link_by_ev = {}
    for l in links["links"]:
        for e in l["engine"]["events"]:
            link_by_ev[(l["engine"]["script"], e)] = l

    order = sorted(scripts)
    bases = [s for s in order if "_" not in s]

    def spine_next(s: str):
        base = s.split("_")[0]
        if "_" in s:
            i = bases.index(base)
        else:
            i = bases.index(s)
        for nxt in bases[i + 1:]:
            if chapter(nxt) == chapter(base) or "_" in s:
                # variants resume at base successor; base files stop at
                # chapter ends (intro 1013 has explicit 1013->2001 link)
                if "_" in s or chapter(nxt) == chapter(s):
                    return nxt
                return None
        return None

    ROUTER_TARGETS = {"2401", "2501", "3901", "2301"}

    def walk(start: str, script_picks: dict, state: dict):
        pos = [start, 0]
        steps = 0
        while steps < 500000:
            steps += 1
            evs = scripts.get(pos[0])
            if evs is None:
                state["stalls"].append(f"missing script {pos[0]}")
                return
            state["visited"].add(pos[0])
            if pos[1] >= len(evs):
                if pos[0] in terms:
                    t = terms[pos[0]]
                    if t["action"] == "chain" and t["to"] in scripts:
                        pos = [t["to"], 0]
                        continue
                    state["ends"].add(pos[0])
                    return
                nxt = spine_next(pos[0])
                if not nxt:
                    state["ends"].add(pos[0])
                    return
                pos = [nxt, 0]
                continue
            ev = evs[pos[1]]
            if ev["t"] == "choice":
                node = nodes.get((pos[0], pos[1]))
                if node is None:
                    state["stalls"].append(f"{pos[0]}:{pos[1]} no flow node")
                    pos[1] += 1
                    continue
                state["choices"].add((pos[0], pos[1]))
                n = pick_n(node, pos, script_picks, state)
                opt = next(o for o in node["options"] if o["n"] == n)
                dest = opt.get("play") or opt.get("goto")
                if dest and not dest.startswith("END:"):
                    if dest not in scripts:
                        state["stalls"].append(f"{pos[0]}:{pos[1]}->{dest} missing")
                        pos[1] += 1
                    else:
                        state["visited"].add(dest)
                        state["gotos"].add(dest)
                        pos = [dest, 0]
                else:
                    pos[1] += 1
            elif ev["t"] == "jump":
                # Preload/voice sync points; never move flow (see
                # docs/FLOW_GRAPH.md). Cross-line 2033->3001 resolves at
                # end-of-script via terminals.json.
                pos[1] += 1
            else:
                pos[1] += 1
        state["stalls"].append(f"walk from {start} exceeded budget (loop?)")

    def pick_n(node, pos, script_picks, state):
        key = (pos[0], pos[1])
        if strategy in ("mari", "koharu", "chiaki", "routers"):
            taken = script_picks.get(key, set())
            for o in node["options"]:
                dest = o.get("play") or o.get("goto")
                want = {"mari": {"2401"}, "koharu": {"2501"},
                        "chiaki": {"2301"}}.get(strategy, ROUTER_TARGETS)
                if dest in want and dest not in taken:
                    taken.add(dest)
                    script_picks[key] = taken
                    return o["n"]
        if strategy == "chiaki":
            return 2 if key == ("2019", 1516) else 1
        return 1

    starts = {"first": ["1001"], "routers": ["1001", "2019", "2019", "2019",
              "3001", "3016", "3016", "3016"],
              "chiaki": ["1001", "2019", "2019"], "mari": ["1001", "2019"],
              "koharu": ["1001", "2019"],
              "special": ["4000", "5000", "5001", "5101", "5200", "5201",
                          "5301", "5401", "6001", "6101", "7000",
                          "7100", "7200", "7300"]}[strategy]
    state: dict = {"visited": set(), "gotos": set(), "choices": set(),
                   "ends": set(), "stalls": []}
    script_picks: dict = {}
    for s in starts:
        walk(s, script_picks, state)

    print(f"strategy: {strategy}")
    print(f"scripts visited: {len(state['visited'])}/{len(scripts)}")
    missing_scripts = sorted(set(scripts) - state["visited"])
    print(f"unvisited ({len(missing_scripts)}): {missing_scripts[:30]}")
    print(f"route/file ends reached: {sorted(state['ends'])}")
    print(f"gotos taken: {sorted(state['gotos'])}")
    print(f"choices covered: {len(state['choices'])}")
    if state["stalls"]:
        print(f"{len(state['stalls'])} STALLS:")
        for s in state["stalls"][:20]:
            print(" -", s)
        return 1
    print("clean walk, no stalls")
    return 0


if __name__ == "__main__":
    sys.exit(main())
