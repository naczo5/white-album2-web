"""Tests for tools/opcode_census.py (synthetic + corpus pin)."""

from __future__ import annotations

import os
import struct
import sys

import pytest

HERE = os.path.dirname(__file__)
ROOT = os.path.join(HERE, "..")
TOOLS = os.path.join(ROOT, "tools")
sys.path.insert(0, TOOLS)

import opcode_census as oc  # noqa: E402

EN_MAIN = os.environ.get("WA2_EN_PAK") or os.path.join(
    ROOT, "..", ".cache", "en_main.pak")
EN_SPECIAL = os.environ.get("WA2_EN_SPECIAL_PAK") or os.path.join(
    ROOT, "..", ".cache", "en_special.pak")
SCRIPT_PAK = os.environ.get("WA2_SCRIPT_PAK") or os.path.join(
    ROOT, "..", ".cache", "game", "script.pak")


def lscr_payload(words: list[int]) -> bytes:
    return (b"LSCR" + struct.pack("<II", 0x14, 0)
            + b"\x00" * 16
            + struct.pack(f"<{len(words)}I",
                          *[w & 0xFFFFFFFF for w in words]))


def stmt(words: list[int]) -> list[int]:
    return words + [6, 30]


def test_census_counts_raw_and_statement_ops():
    one = lscr_payload(
        stmt([5, 3, 7, 5, 3, 1, 5, 3, 255, 4, 158])
        + stmt([3, 0, 4, 131])
    )
    two = lscr_payload(
        stmt([5, 3, 1, 5, 3, 0, 4, 150])
        + stmt([4, 197])
    )
    a = oc.census_payload(one)
    b = oc.census_payload(two)
    assert a["rawPairs"] == 2 and a["opPairs"] == 2
    assert a["rawIds"] == {131: 1, 158: 1}
    assert b["rawPairs"] == 2 and b["opPairs"] == 2
    assert b["rawIds"] == {150: 1, 197: 1}
    assert a["distinct"] == 2 and b["distinct"] == 2


@pytest.mark.skipif(not os.path.isfile(EN_MAIN),
                    reason="BYOA en_main.pak not present")
def test_corpus_en_main_census_pin():
    rows = oc.census_paks([EN_MAIN])
    pak = rows["paks"][0]
    assert pak["scripts"] == 206
    # Raw pair total is the corpus pin; distinct opcode ids come from the
    # decoded statement stream (float/data words inflate rawDistinct).
    assert pak["rawPairs"] == 318810
    assert pak["opPairs"] == 299375
    assert pak["distinct"] == 83
    assert rows["overall"]["uniqueScripts"] == 206
    assert rows["overall"]["distinct"] == 83


@pytest.mark.skipif(not (os.path.isfile(EN_SPECIAL) and
                         os.path.isfile(SCRIPT_PAK)),
                    reason="BYOA special/JP paks not present")
def test_corpus_special_and_jp_op0_aware_pins():
    rows = oc.census_paks([EN_SPECIAL, SCRIPT_PAK])
    spec, jp = rows["paks"]
    # The OP0-width-aware decoder recovers the real vocabulary here; the old
    # iter_statements count reported 58/86 and invented id 2308.
    assert spec["rawPairs"] == 32344
    assert spec["opPairs"] == 28907
    assert spec["distinct"] == 63
    assert jp["rawPairs"] == 319708
    assert jp["opPairs"] == 299575
    assert jp["distinct"] == 84
