"""Unit tests for tools/build_flags.py parsers (synthetic, no assets)."""

import json
import os
import struct
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))

from build_flags import choice_flag_targets, parse_fnc, parse_gflag, parse_vrb  # noqa: E402


def test_parse_vrb_sjis_csv():
    blob = "3,FLG_00,0\r\n3,FLG_雪菜好意度,0\r\n".encode("cp932")
    rows = parse_vrb(blob)
    assert rows == [{"type": 3, "name": "FLG_00", "init": 0},
                    {"type": 3, "name": "FLG_雪菜好意度", "init": 0}]


def test_parse_gflag_slots():
    names = ["_GFLAG_EV_A", "_GFLAG_EV_B"]
    blob = struct.pack("<I", 2) + b"\x00" * 4
    for nm in names:
        slot = nm.encode() + b"\x00" * (260 - len(nm))
        blob += slot
    assert parse_gflag(blob) == names


def test_parse_fnc_name_order():
    blob = struct.pack("<I", 3) + b"printEx\x00\x01\x02,SetMessage\x00,,EndMessage\x00"
    assert parse_fnc(blob) == ["printEx", "SetMessage", "EndMessage"]


def test_choice_flag_targets_fullwidth_digits(tmp_path):
    vars_ = [{"type": 3, "name": "FLG_第２部03選択肢１", "init": 0},
             {"type": 3, "name": "FLG_第３部15条件２", "init": 0},
             {"type": 3, "name": "FLG_雪菜好意度", "init": 0}]
    ir = {"script": "2003", "events": [{"t": "choice", "options": []}]}
    (tmp_path / "2003.json").write_text(json.dumps(ir))
    (tmp_path / "3015.json").write_text(json.dumps(
        {"script": "3015", "events": [{"t": "narrate", "text": "x"}]}))
    out = choice_flag_targets(vars_, str(tmp_path))
    # NFKC full-width digits map to scripts; choice kind needs a choice,
    # condition kind only needs the script to exist.
    assert out["FLG_第２部03選択肢１"] == {
        "script": "2003", "option": 1, "kind": "choice", "verified": True}
    assert out["FLG_第３部15条件２"] == {
        "script": "3015", "option": 2, "kind": "condition", "verified": True}
    assert "FLG_雪菜好意度" not in out
