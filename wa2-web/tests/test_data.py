"""Asset-free integrity gates for the committed data/ sources.

These do not replace the corpus gates (tools/check_flow.py needs IR built
from the user's en.pak), but they catch the class of drift that is visible
without game files: stale ending/terminal references after event-index
shifts, annotations that no longer join to their flow node, duplicate
option numbers, and dangling link metadata.
"""

import json
import os
import re
import sys

HERE = os.path.dirname(__file__)
DATA = os.path.join(HERE, "..", "data")
sys.path.insert(0, os.path.join(HERE, "..", "tools"))

import annotate_flow  # noqa: E402


def load(name):
    with open(os.path.join(DATA, name), encoding="utf-8") as f:
        return json.load(f)


def annotation_keys():
    out = set()
    for (script, o1, o2), _a in annotate_flow.A.items():
        out.add((script, o1[:40], (o2[:40] if o2 else None)))
    return out


def node_key(node):
    opts = node.get("options") or []
    o1 = opts[0].get("text", "")[:40] if opts else ""
    o2 = opts[1].get("text", "")[:40] if len(opts) > 1 else None
    return (node["engine"]["script"], o1, o2)


def test_flow_nodes_are_unique_and_well_formed():
    flow = load("flow.json")
    ids = [n["id"] for n in flow["nodes"]]
    coords = [(n["engine"]["script"], n["engine"]["event"]) for n in flow["nodes"]]
    assert len(ids) == len(set(ids))
    assert len(coords) == len(set(coords))
    for n in flow["nodes"]:
        nums = [o["n"] for o in n["options"]]
        assert len(nums) >= 2 and len(nums) == len(set(nums)), n["id"]
        assert all(o.get("text", "").strip() for o in n["options"]), n["id"]
        assert set(n.get("gated") or {}) <= {str(x) for x in nums}, n["id"]
        assert set((n.get("effects") or {}).keys()) <= {str(x) for x in nums}, n["id"]


def test_every_flow_node_has_a_live_annotation():
    """The 32 engine choices must all join to annotate_flow.A.

    An event-index shift that changes the skeleton node id without changing
    option text is caught here; a change in option wording is caught by the
    corpus check_flow gate.
    """
    keys = annotation_keys()
    used = {node_key(n) for n in load("flow.json")["nodes"]}
    assert used - keys == set(), "flow nodes without an annotation"
    assert keys - used == set(), "annotations that no longer join any flow node"


def test_endings_reference_live_flow_nodes():
    flow = load("flow.json")
    ids = {n["id"] for n in flow["nodes"]}
    endings = load("endings.json")
    ref_re = re.compile(r"\b(\d{4}(?:_\d+)?-\d+)\b")
    dangling = []
    seen = set()
    for e in endings["endings"]:
        assert e["id"] not in seen, e["id"]
        seen.add(e["id"])
        for ref in ref_re.findall(e.get("unlock", "")):
            if ref not in ids:
                dangling.append((e["id"], ref))
    assert dangling == []
    for ending in endings.get("recommended_order") or []:
        assert ending in seen, ending


def test_terminals_are_actionable():
    endings = {e["id"] for e in load("endings.json")["endings"]}
    terms = load("terminals.json")["terminals"]
    for script, t in terms.items():
        assert re.fullmatch(r"\d{4}(?:_\d+)?", script), script
        assert t.get("action") in ("end", "chain"), script
        if t["action"] == "end" and t.get("ending"):
            assert t["ending"] in endings, script
        if t["action"] == "chain":
            assert re.fullmatch(r"\d{4}(?:_\d+)?", t.get("to") or ""), script
            assert t["to"] != script, script


def test_links_metadata_resolves():
    links = load("links.json")
    ids = set()
    for link in links["links"]:
        assert link["id"] not in ids, link["id"]
        ids.add(link["id"])
        assert link["status"] in ("HINT", "SWITCH", "DEAD", "BRIDGE")
        assert link["targets"], link["id"]
        assert link["engine"]["events"], link["id"]
        default = link.get("default")
        if default is not None:
            assert default in link["targets"], link["id"]
        assert set(link.get("missing") or []) <= set(link["targets"]), link["id"]
    counts = links.get("counts") or {}
    actual = {}
    for link in links["links"]:
        actual[link["status"]] = actual.get(link["status"], 0) + 1
    assert counts == actual
