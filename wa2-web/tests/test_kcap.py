"""Unit tests for tools/kcap.py + tools/lzss.py (synthetic round-trip, no assets)."""

import os
import struct
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))

import kcap  # noqa: E402


def pack_entry(flag: int, name: bytes, unk1: int, unk2: int,
               offset: int, length: int) -> bytes:
    name_f = name + b"\x00" * (24 - len(name))
    return struct.pack("<I", flag) + name_f + struct.pack("<IIII", unk1, unk2,
                                                          offset, length)


def test_read_index_round_trip():
    blob = b"KCAP" + struct.pack("<III", 0xFFFFFFFF, 0x0000FFFF, 3)
    blob += pack_entry(0xCCCCCCCC, b"bak", 0xFFFFFFFF, 0x0000FFFF, 0, 0)
    blob += pack_entry(0, b"1001.txt", 0xFFFFFFFF, 0x0000FFFF, 22768, 1538)
    blob += pack_entry(1, b"b101400.tga", 0xFFFFFFFF, 0x0000FFFF, 24306, 22764)
    entries = kcap.read_index(blob)
    assert len(entries) == 3
    assert entries[0].is_folder and entries[0].name == "bak"
    assert not entries[1].is_compressed
    assert (entries[1].offset, entries[1].length) == (22768, 1538)
    assert entries[2].is_compressed
    assert kcap.data_range(entries[1]) == (22768, 24306)


def test_bad_magic():
    try:
        kcap.read_index(b"NOPE" + b"\x00" * 12)
    except ValueError:
        return
    raise AssertionError("expected ValueError")


def test_census():
    blob = b"KCAP" + struct.pack("<III", 0, 0, 2)
    blob += pack_entry(0, b"a.txt", 0, 0, 0, 10)
    blob += pack_entry(1, b"b.bnr", 0, 0, 10, 20)
    c = kcap.census(kcap.read_index(blob))
    assert c == {"total": 2, "folders": 0, "raw": 1, "compressed": 1,
                 "by_ext": {"txt": 1, "bnr": 1}}
