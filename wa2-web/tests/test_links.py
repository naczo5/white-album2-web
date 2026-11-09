"""Pure tests for link derivation (CATCH tails + bare ids)."""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))

from build_links import derive_links  # noqa: E402


def j(kind, targets):
    return {"t": "jump", "kind": kind, "targets": targets, "tok": 0}


def test_catch_tail_single_is_hint_and_pair_is_switch():
    scripts = {
        "1001": [j("CATCH", ["1002"])],
        "1002": [],
        "2021": [j("CATCH2", ["2022", "2025"])],
        "2022": [], "2025": [],
        "2402": [j("CATCH2", ["2403", "2413"])],
        "2403": [], "2413": [],
        "2031": [j("CATCH2", ["雪菜"])],  # voice context, not a link
        "9999": [j("bare", ["3001"])],
        "3001": [],
    }
    links = {l["id"]: l for l in derive_links(scripts)}
    assert links["1001-0"]["status"] == "HINT"
    assert links["1001-0"]["default"] == "1002"
    assert links["2021-0"]["status"] == "SWITCH"
    assert links["2021-0"]["targets"] == ["2022", "2025"]
    assert links["2021-0"]["default"] == "2022"
    assert links["2402-0"]["status"] == "SWITCH"
    assert "2031-0" not in links  # speaker-name target filtered out
    assert links["9999-0"]["status"] == "HINT"


def test_adjacent_bare_and_catch_group_into_one_site():
    scripts = {
        "3016": [
            j("bare", ["3024"]),
            j("CATCH3", ["3017"]),
        ],
        "3017": [{"t": "narrate", "text": "x"}],
        "3024": [],
    }
    links = {l["id"]: l for l in derive_links(scripts)}
    site = links["3016-0"]
    assert site["status"] == "SWITCH"
    assert site["engine"]["events"] == [0, 1]
    assert site["targets"] == ["3024", "3017"]
    # numeric play order chooses 3017 over 3024
    assert site["default"] == "3017"


def test_missing_target_is_dead():
    scripts = {"1001": [j("CATCH", ["9998"])]}
    links = derive_links(scripts)
    assert links[0]["status"] == "DEAD"
    assert links[0]["missing"] == ["9998"]
    assert links[0]["default"] is None
