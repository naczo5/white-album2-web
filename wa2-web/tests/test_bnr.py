"""Unit tests for .bnr decoding + nested-LAC audio names (synthetic, no assets)."""

import os
import struct
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))

from extract_assets import _pak_tag, decode_lac_name, voice_line_key  # noqa: E402
from proto_bgm import find_bgm, find_se, iter_statements  # noqa: E402


def xor_name(s: str) -> bytes:
    return bytes(b ^ 0xFF for b in s.encode()) + b"\x00" * (24 - len(s))


def lscr_payload(words: list[int]) -> bytes:
    return b"LSCR" + struct.pack("<II", 0x14, 0) + b"\x00" * 16 + \
        struct.pack(f"<{len(words)}I", *[w & 0xFFFFFFFF for w in words])


def stmt(words: list[int]) -> list[int]:
    return words + [6, 30]


def pushes(*vals: int) -> list[int]:
    out: list[int] = []
    for v in vals:
        out.extend([5, 3, v & 0xFFFFFFFF])
    return out


def test_decode_lac_name_accepts_bgm_se_voice():
    assert decode_lac_name(xor_name("BGM_001_A.OGG")) == "BGM_001_A.OGG"
    assert decode_lac_name(xor_name("BGM_074.OGG")) == "BGM_074.OGG"
    assert decode_lac_name(xor_name("SE_0000.WAV")) == "SE_0000.WAV"
    assert decode_lac_name(xor_name("1008_199_04.OGG")) == "1008_199_04.OGG"


def test_decode_lac_name_rejects_garbage():
    assert decode_lac_name(b"\x01\x02\x03" + b"\x00" * 21) == ""
    assert decode_lac_name(b"noext" + b"\x00" * 19) == ""


def test_voice_line_key_accepts_variant_script_suffix():
    assert voice_line_key("1008_0199_04.OGG") == ("1008_0199", "OGG")
    # variant scripts can carry their own suffix before the line number
    assert voice_line_key("1008_020_0199_04.OGG") == ("1008_020_0199", "OGG")
    assert voice_line_key("not-a-voice.OGG") is None
    assert voice_line_key("1008_0199.OGG") is None


def test_find_bgm_play_shape():
    payload = lscr_payload(
        stmt([5, 3, 1]) +
        stmt([5, 3, 7, 5, 3, -2, 5, 3, 1, 5, 3, 255, 4, 158]))
    plays, stops, n = find_bgm(payload)
    assert n == 2
    assert len(plays) == 1 and plays[0]["track"] == 7
    assert plays[0]["fade"] == -2
    assert stops == []


def test_find_bgm_stop_shape_is_ops_based():
    # (4,5),(3,X),(4,158): stop even though pushes[0]=120 looks like a track
    payload = lscr_payload(
        stmt([5, 3, 120, 5, 3, 1, 5, 3, 255, 4, 5, 3, 10, 4, 158]))
    plays, stops, _ = find_bgm(payload)
    assert plays == []
    assert len(stops) == 1


def test_find_bgm_channel_variant_is_play():
    payload = lscr_payload(
        stmt([5, 3, 20, 5, 3, 2, 5, 3, 0, 5, 3, 0, 6, 23, 4, 158]))
    plays, stops, _ = find_bgm(payload)
    assert len(plays) == 1 and plays[0]["track"] == 20
    assert stops == []


def test_find_se_shape():
    payload = lscr_payload(
        stmt([5, 3, 1001, 5, 3, 255, 4, 164]) +
        stmt([5, 3, 7, 5, 3, -2, 5, 3, 1, 5, 3, 255, 4, 158]))
    out = find_se(payload)
    assert len(out) == 1 and out[0]["se"] == 1001
    # BGM statement is not an SE statement
    assert out[0]["stmt"] == 0


def test_iter_statements_captures_float_pushes():
    zoom_bits = struct.unpack("<I", struct.pack("<f", 2.0))[0]
    payload = lscr_payload(
        stmt([6, 27, 5, 4, zoom_bits, 5, 3, 1000, 6, 18]))
    rows = list(iter_statements(payload))
    assert len(rows) == 1
    _idx, _off, _pushes, ops, _raw, floats = rows[0]
    assert (6, 27) in ops and (6, 18) in ops
    assert floats == [2.0]


def test_pak_tag_finds_nested_ic_disc_layout():
    assert _pak_tag("/g/IC/BGM.PAK", "/g") == "ic"
    assert _pak_tag("/g/disc1/IC/BGM.PAK", "/g") == "ic"
    assert _pak_tag("/g/disc1/BGM.PAK", "/g") == ""


def _decode_syn(*stmts: list[int]):
    from unittest.mock import patch
    import decode_bnr
    payload = lscr_payload(sum((stmt(s) for s in stmts), []))
    with patch.object(decode_bnr.kcap, "read_index", return_value=[]), patch.object(
        decode_bnr, "load_bnr", return_value=(payload, None),
    ):
        return decode_bnr.decode_script(b"", "syn")


def _img_row(recs, **kw):
    rows = [r for r in recs if r.get("layer") in ("bak", "grp") and "stems" in r]
    assert len(rows) == 1, recs
    for k, v in kw.items():
        assert rows[0][k] == v, rows[0]
    return rows[0]


def test_decode_img_op146_bak_sprclear_tod_default():
    recs = _decode_syn(pushes(1, 1001, 0, 60, 0, 0, 0) + [4, 146])
    _img_row(recs, layer="bak", sprClear=True, stems=["100100"])


def test_decode_img_op147_bak_keeps_sprites():
    recs = _decode_syn(pushes(1, 1001, 0, 60, 0, 0, 0) + [4, 147])
    _img_row(recs, layer="bak", sprClear=False, stems=["100100"])


def test_decode_img_op148_grp_sprclear():
    recs = _decode_syn(pushes(1, 10010, 0, 60, 0, 0, 0) + [4, 148])
    row = _img_row(recs, layer="grp", sprClear=True)
    assert "100100" in row["stems"]


def test_decode_tod170_push_list_sets_evening_stem():
    recs = _decode_syn(
        pushes(1) + [4, 170],
        pushes(1, 1001, 0, 60, 0, 0, 0) + [4, 146],
    )
    _img_row(recs, stems=["100101"])


def test_decode_tod170_via_bgm_stop_push():
    recs = _decode_syn(
        [4, 5, 3, 2, 4, 170],
        pushes(1, 1033, 0, 30, 0, 0, 0) + [4, 146],
    )
    _img_row(recs, stems=["103302"])


def test_decode_tod170_multiop_trailing_zero():
    recs = _decode_syn(
        pushes(447, 1600, 10, 0) + [6, 18, 6, 19, 4, 196, 4, 170, 6, 21],
        pushes(1, 1001, 0, 60, 0, 0, 0) + [4, 146],
    )
    _img_row(recs, stems=["100100"])


def test_decode_img_multiop_trailing_6_slice():
    recs = _decode_syn(
        pushes(9, 8, 1, 2001, 1, 45, 0, 0, 0)
        + [6, 18, 6, 19, 4, 196, 4, 148, 6, 21],
    )
    row = _img_row(recs, layer="grp")
    assert row["fade"] == 45
    assert "200101" in row["stems"]


def test_decode_img_trailing_4_132_drop():
    recs = _decode_syn(
        pushes(1, 1001, 0, 60, 0, 0, 0, 99) + [4, 146, 4, 132],
    )
    _img_row(recs, stems=["100100"])


def test_decode_img_6_27_variant_slice():
    recs = _decode_syn(
        [2, 0, 6, 27, 6, 16]
        + pushes(1, 2, 3, 9, 8, 4, 7, 0, 0, 0)
        + [4, 148],
    )
    row = _img_row(recs, layer="grp")
    assert row["fade"] == 7
    assert "908" in row["stems"]


def test_decode_img_3907_resolution_pushes():
    zoom = struct.unpack("<I", struct.pack("<f", 1.0))[0]
    recs = _decode_syn(
        pushes(1, 5010, 2, 90, 0, 0, 0)
        + [6, 23, 6, 18, 5, 4, zoom]
        + pushes(1280, 720)
        + [4, 146],
    )
    _img_row(recs, layer="bak", stems=["501020"], fade=90)
