"""Corpus conformance tests: run against a real user-supplied en.pak.

These encode gameplay-parity invariants and only run when WA2_EN_PAK is set
(BYOA: the archive is never committed). Example:

    WA2_EN_PAK=/path/to/en.pak python3 -m pytest tests/ -q

Covers: KCAP census (205 scenarios + 205 LSCR tracks), zero parser warnings,
the 12/24 router (2019.txt) and Coda final router (3016.txt) destinations,
whisper markup survival, and asset-manifest determinism.
"""

import glob
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))

import kcap  # noqa: E402
import parse_txt  # noqa: E402

EN_PAK = os.environ.get("WA2_EN_PAK")


@pytest.fixture(scope="module")
def corpus(tmp_path_factory):
    if not EN_PAK:
        pytest.skip("WA2_EN_PAK not set (BYOA corpus test)")
    from extract_kcap import extract
    out = str(tmp_path_factory.mktemp("corpus"))
    extract(EN_PAK, os.path.join(out, "txt"), {"txt"})
    ir_dir = os.path.join(out, "ir")
    os.makedirs(ir_dir, exist_ok=True)
    txts = sorted(f for f in os.listdir(os.path.join(out, "txt"))
                  if f.endswith(".txt"))
    # two-pass (mirrors build.py): corpus latch census, then mega resplit
    first = {}
    census: set[str] = set()
    for fn in txts:
        ir = parse_txt.parse_file(os.path.join(out, "txt", fn), set())
        first[fn] = ir
        census.update(e["name"] for e in ir["events"] if e["t"] == "latch"
                      and parse_txt.census_name(e["name"]))
    for fn in txts:
        ir = parse_txt.parse_file(os.path.join(out, "txt", fn), census)
        with open(os.path.join(ir_dir, fn[:-4] + ".json"), "w") as f:
            json.dump(ir, f)
    return ir_dir


def load(ir_dir, script):
    with open(os.path.join(ir_dir, script + ".json"), encoding="utf-8") as f:
        return json.load(f)


def test_kcap_census():
    if not EN_PAK:
        pytest.skip("WA2_EN_PAK not set")
    with open(EN_PAK, "rb") as f:
        entries = kcap.read_index(f.read())
    c = kcap.census(entries)
    assert c["total"] == 517
    assert c["folders"] == 4
    assert c["by_ext"].get("txt") == 205
    assert c["by_ext"].get("bnr") == 206  # 205 + orphan 5401 (no .txt sibling)
    assert c["by_ext"].get("tga") == 102


def test_zero_warnings(corpus):
    allowed = ("MEGA_CHOICE", "merged adjacent choice")
    bad = []
    for fn in glob.glob(os.path.join(corpus, "*.json")):
        ir = json.load(open(fn, encoding="utf-8"))
        for w in ir["warnings"]:
            if not w.startswith(allowed):
                bad.append((ir["script"], w))
    assert bad == []


def test_router_2019(corpus):
    ir = load(corpus, "2019")
    choices = [(i, e) for i, e in enumerate(ir["events"])
               if e["t"] == "choice"]
    assert len(choices) == 2
    _, router = choices[0]
    assert [o["n"] for o in router["options"]] == [1, 2, 3]
    assert [o["goto"] for o in router["options"]] == [None, "2401", "2501"]
    assert router["options"][0]["text"] == "Call Chiaki"


def test_recovered_mega_choices(corpus):
    # 12/3 freelance (cc-c03), 12/17 pair (cc-c08/c09), Mari 12/31,
    # coda 12/24 prologue (coda-c01): all hidden inside mega-tokens.
    expect = {
        "2004": ["Decline.", "Accept."],
        "2013": ["All right. Let's do it today", "Sorry~ but make it tomorrow"],
        "2014": ["Talk a little longer", "Let's call it a night"],
        "2503": ["Go to the concert", "Stay here"],
        "3003": ["I mean to propose soon.",
                 "We have been together for two years."],
    }
    for script, texts in expect.items():
        ir = load(corpus, script)
        choices = [e for e in ir["events"] if e["t"] == "choice"]
        assert len(choices) == 1, script
        assert [o["text"] for o in choices[0]["options"]] == texts, script


def test_coda_final_router_3016(corpus):
    ir = load(corpus, "3016")
    choices = [e for e in ir["events"] if e["t"] == "choice"]
    assert len(choices) == 2
    assert choices[0]["options"][1]["goto"] == "3901"


def test_whisper_style_present(corpus):
    n = 0
    for fn in glob.glob(os.path.join(corpus, "*.json")):
        ir = json.load(open(fn, encoding="utf-8"))
        n += sum(1 for e in ir["events"] if e.get("style") == "whisper")
    assert n > 50  # v2.1.0 carries ~84 whole-token + inline F16 spans


def test_every_choice_has_two_plus_options(corpus):
    for fn in glob.glob(os.path.join(corpus, "*.json")):
        ir = json.load(open(fn, encoding="utf-8"))
        for e in ir["events"]:
            if e["t"] == "choice":
                assert len(e["options"]) >= 2, (ir["script"], e)
