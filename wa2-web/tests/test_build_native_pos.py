"""Tests for tools/build_native_pos.py (JP ScriptPos label anchors)."""

from __future__ import annotations

import os
import struct
import sys

import pytest

HERE = os.path.dirname(__file__)
ROOT = os.path.join(HERE, "..")
TOOLS = os.path.join(ROOT, "tools")
sys.path.insert(0, TOOLS)

import build_native_pos as bnp  # noqa: E402

GAME = os.environ.get("WA2_GAME_DIR") or os.path.join(
    ROOT, "..", ".cache", "game")
SCRIPT_PAK = os.path.join(GAME, "script.pak")
IC_SCRIPT_PAK = os.path.join(GAME, "IC", "script.pak")


def lscr_payload(words: list[int]) -> bytes:
    """Single-section LSCR blob with the statement stream at offset 28."""
    return (b"LSCR" + struct.pack("<II", 0x14, 0)
            + b"\x00" * 16
            + struct.pack(f"<{len(words)}I",
                          *[w & 0xFFFFFFFF for w in words]))


def stmt(words: list[int]) -> list[int]:
    return words + [6, 30]


def make_pak(files: dict[str, bytes]) -> bytes:
    """Build a minimal raw-entry KCAP archive."""
    count = len(files)
    header = b"KCAP" + struct.pack("<III", 0xFFFFFFFF, 0x0000FFFF, count)
    table = bytearray()
    data = bytearray()
    off = 16 + count * 44
    for name, blob in files.items():
        raw = name.encode("ascii")
        table += struct.pack("<I", 0) + raw.ljust(24, b"\x00")
        table += struct.pack("<IIII", 0xFFFFFFFF, 0x0000FFFF,
                             off + len(data), len(blob))
        data += blob
    return header + bytes(table) + bytes(data)


def test_script_anchors_from_label_statements():
    payload = lscr_payload(
        stmt([3, 0, 4, 131])
        + stmt([3, 1, 4, 144])
        + stmt([4, 197])
    )
    txt = "行一,行二".encode("cp932")
    assert bnp.script_anchors(payload, txt) == [[28, 0], [52, 1]]


def test_extract_pak_anchors_keys_main_and_ic(tmp_path):
    payload = lscr_payload(
        stmt([3, 0, 4, 131])
        + stmt([3, 1, 4, 144])
        + stmt([4, 197])
    )
    txt = "a,b".encode("cp932")
    main = make_pak({"1007.txt": txt, "1007.bnr": payload})
    ic = make_pak({"1007.txt": txt, "1007.bnr": payload})
    main_path = tmp_path / "main.pak"
    ic_path = tmp_path / "ic.pak"
    main_path.write_bytes(main)
    ic_path.write_bytes(ic)

    data = bnp.build_native_pos(str(main_path), str(ic_path))
    assert data["version"] == 1
    assert list(data["anchors"]) == ["1007", "ic/1007"]
    assert data["anchors"]["1007"] == [[28, 0], [52, 1]]
    assert data["anchors"]["ic/1007"] == [[28, 0], [52, 1]]


def test_extract_pak_anchors_fails_without_pairs():
    only_bnr = make_pak({"1007.bnr": lscr_payload(stmt([4, 197]))})
    with pytest.raises(ValueError, match="no .txt/.bnr"):
        bnp.extract_pak_anchors(only_bnr)

    with pytest.raises(ValueError, match="no .bnr"):
        bnp.extract_pak_anchors(make_pak({"1007.txt": b"a"}))


@pytest.mark.skipif(not os.path.isfile(SCRIPT_PAK),
                    reason="BYOA JP script.pak not present")
def test_corpus_native_pos_1007_anchors():
    has_ic = os.path.isfile(IC_SCRIPT_PAK)
    data = bnp.build_native_pos(SCRIPT_PAK, IC_SCRIPT_PAK if has_ic else None)
    rows = data["anchors"].get("1007")
    assert rows, "1007 has no label anchors"
    offs = [r[0] for r in rows]
    assert offs == sorted(offs)
    assert len(rows) == len({(o, e) for o, e in rows})
    assert all(isinstance(o, int) and isinstance(e, int) for o, e in rows)
    if has_ic:
        assert data["anchors"].get("ic/1007")
