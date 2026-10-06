"""Unit tests for .bnr decoding + nested-LAC audio names (synthetic, no assets)."""

import os
import struct
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))

from extract_assets import decode_lac_name  # noqa: E402
from proto_bgm import find_bgm, find_se, iter_statements  # noqa: E402


def xor_name(s: str) -> bytes:
    return bytes(b ^ 0xFF for b in s.encode()) + b"\x00" * (24 - len(s))


def lscr_payload(words: list[int]) -> bytes:
    return b"LSCR" + struct.pack("<II", 0x14, 0) + b"\x00" * 16 + \
        struct.pack(f"<{len(words)}I", *[w & 0xFFFFFFFF for w in words])


def stmt(words: list[int]) -> list[int]:
    return words + [6, 30]


def test_decode_lac_name_accepts_bgm_se_voice():
    assert decode_lac_name(xor_name("BGM_001_A.OGG")) == "BGM_001_A.OGG"
    assert decode_lac_name(xor_name("BGM_074.OGG")) == "BGM_074.OGG"
    assert decode_lac_name(xor_name("SE_0000.WAV")) == "SE_0000.WAV"
    assert decode_lac_name(xor_name("1008_199_04.OGG")) == "1008_199_04.OGG"


def test_decode_lac_name_rejects_garbage():
    assert decode_lac_name(b"\x01\x02\x03" + b"\x00" * 21) == ""
    assert decode_lac_name(b"noext" + b"\x00" * 19) == ""


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
