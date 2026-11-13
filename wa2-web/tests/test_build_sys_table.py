"""Gates for tools/build_sys_table.py (PE static extraction).

The VA-to-offset helper is tested against a synthetic PE32 image so it runs
without game files. The real WA2.exe checks skip when the executable is
absent, which is the normal CI case (BYOA: the binary is never committed).
"""

import json
import os
import struct
import sys

import pytest

HERE = os.path.dirname(__file__)
DATA = os.path.join(HERE, "..", "data")
TOOLS = os.path.join(HERE, "..", "tools")
sys.path.insert(0, TOOLS)

import build_sys_table as bst  # noqa: E402

WA2_EXE = os.environ.get("WA2_EXE") or os.path.join(
    HERE, "..", "..", ".cache", "game", "WA2.exe")


def have_exe() -> bool:
    return os.path.isfile(WA2_EXE)


def skip_without_exe():
    if not have_exe():
        pytest.skip("WA2_EXE not set and no .cache/game/WA2.exe (BYOA)")


# ------------------------------------------------------- synthetic PE ---
def make_pe(sections):
    """Build a minimal PE32 image.

    `sections` is a list of (name, va, vsize, raw_off, raw_size). The blob is
    sized to hold every section's raw bytes at its raw_off.
    """
    size = max(raw_off + raw_size for _n, _v, _s, raw_off, raw_size
               in sections)
    buf = bytearray(size)
    buf[0:2] = b"MZ"
    pe_off = 0x80
    struct.pack_into("<I", buf, 0x3C, pe_off)
    buf[pe_off:pe_off + 4] = b"PE\x00\x00"
    struct.pack_into("<H", buf, pe_off + 6, len(sections))
    opt_size = 224
    struct.pack_into("<H", buf, pe_off + 20, opt_size)
    opt_off = pe_off + 24
    struct.pack_into("<H", buf, opt_off, 0x10B)
    struct.pack_into("<I", buf, opt_off + 28, 0x400000)
    sec_off = opt_off + opt_size
    for i, (name, va, vsize, raw_off, raw_size) in enumerate(sections):
        o = sec_off + i * 40
        buf[o:o + 8] = name.encode().ljust(8, b"\x00")[:8]
        struct.pack_into("<IIII", buf, o + 8, vsize, va, raw_size, raw_off)
    return bytes(buf)


def test_parse_pe_reads_sections_and_image_base():
    blob = make_pe([(".data", 0x1000, 0x100, 0x400, 0x100),
                    (".rdata", 0x2000, 0x80, 0x500, 0x80)])
    image_base, sections = bst.parse_pe(blob)
    assert image_base == 0x400000
    assert [s["name"] for s in sections] == [".data", ".rdata"]
    assert sections[0]["va"] == 0x1000
    assert sections[0]["raw_off"] == 0x400


def test_parse_pe_rejects_non_pe():
    with pytest.raises(ValueError):
        bst.parse_pe(b"not an executable at all")
    with pytest.raises(ValueError):
        bst.parse_pe(b"MZ" + b"\x00" * 0x100)  # no PE signature


def test_va_to_off_maps_rva_and_rejects_unbacked():
    blob = make_pe([(".data", 0x1000, 0x200, 0x400, 0x100)])
    image_base, sections = bst.parse_pe(blob)
    # file-backed byte
    assert bst.va_to_off(sections, image_base, 0x400000 + 0x1010) == 0x410
    # inside the zero-filled tail of vsize > raw_size: no file image
    assert bst.va_to_off(sections, image_base, 0x400000 + 0x1500) is None
    # outside every section
    assert bst.va_to_off(sections, image_base, 0x400000 + 0x9000) is None


def test_extractors_on_synthetic_tables():
    """Point the table constants at a synthetic .data block and extract."""
    data_va = 0x1000
    blob = bytearray(0x2000)

    # Lay the tables and their string payload into the image. With
    # raw_off 0 the section's VA 0x1000 corresponds to file offset 0, so a
    # file offset f is reachable at VA image_base + 0x1000 + f.
    ids = ["1001", "1002", "1003"]
    ptrs = []
    for i, s in enumerate(ids):
        at = 0x1800 + i * 8
        blob[at:at + len(s) + 1] = s.encode() + b"\x00"
        ptrs.append(0x400000 + data_va + at)
    struct.pack_into("<%dI" % (len(ptrs) + 1), blob, 0, *ptrs, 0)

    choice_off = 0x40
    struct.pack_into("<4I", blob, choice_off, 2003, 2004, 0xFFFFFFFF, 0)

    gallery_off = 0x100
    rows = [[100100, 100200], [100300, 0]]
    words = [v for row in rows for v in row + [0] * 8]
    struct.pack_into("<%dI" % len(words), blob, gallery_off, *words)

    sections = [{"name": ".data", "va": data_va, "vsize": 0x2000,
                 "raw_off": 0, "raw_size": 0x2000}]
    data = bytes(blob)

    orig = (bst.SCRIPT_TABLE_VA, bst.CHOICE_TABLE_VA, bst.GALLERY_TABLE_VA)
    try:
        bst.SCRIPT_TABLE_VA = 0x400000 + data_va
        bst.CHOICE_TABLE_VA = 0x400000 + data_va + choice_off
        bst.GALLERY_TABLE_VA = 0x400000 + data_va + gallery_off
        assert bst.extract_scripts(data, sections, 0x400000) == ids
        assert bst.extract_choice_table(data, sections, 0x400000) == [2003,
                                                                    2004]
        got = bst.extract_cg_rows(data, sections, 0x400000)
        assert got[0][:2] == [100100, 100200]
        assert got[1][0] == 100300
    finally:
        (bst.SCRIPT_TABLE_VA, bst.CHOICE_TABLE_VA,
         bst.GALLERY_TABLE_VA) = orig


def test_cg_row_extraction_stops_at_foreign_record():
    """A non-CG word ends the table instead of emitting garbage ids."""
    data_va = 0x1000
    blob = bytearray(0x2000)
    struct.pack_into("<6I", blob, 0, 100100, 0, 0, 0, 0, 0)
    # Row 1 opens a 20-byte-stride record list, as at 0x4c1bf0.
    struct.pack_into("<5I", blob, 40, 0x4A1A68, 80, 101700, 0, 0)
    sections = [{"name": ".data", "va": data_va, "vsize": 0x2000,
                 "raw_off": 0, "raw_size": 0x2000}]
    orig = bst.GALLERY_TABLE_VA
    try:
        bst.GALLERY_TABLE_VA = 0x400000 + data_va
        rows = bst.extract_cg_rows(bytes(blob), sections, 0x400000)
        assert len(rows) == 1
        assert rows[0][0] == 100100
    finally:
        bst.GALLERY_TABLE_VA = orig


def test_check_flow_detects_order_drift(tmp_path):
    flow = tmp_path / "flow.json"
    flow.write_text(json.dumps({"nodes": [
        {"engine": {"script": "2003"}},
        {"engine": {"script": "2004"}},
        {"engine": {"script": "2003"}},  # duplicate is ignored
    ]}), encoding="utf-8")
    assert bst.check_flow([2003, 2004], str(flow)) == []
    problems = bst.check_flow([2004, 2003], str(flow))
    assert problems and "choice table != flow.json order" in problems[0]


# -------------------------------------------------------- real WA2.exe ---
def test_committed_sys_slots_matches_exe():
    """Regenerating from the user's exe reproduces the committed table."""
    skip_without_exe()
    table, problems = bst.build_table(WA2_EXE)
    assert problems == []
    with open(os.path.join(DATA, "sys-slots.json"), encoding="utf-8") as f:
        committed = json.load(f)
    for key in ("scripts", "cgRows", "choiceTable", "endingSlots",
                "endingSlotsConfidence", "gateSlots"):
        assert table[key] == committed[key], f"{key} drifted from the exe"


def test_exe_extraction_counts_and_cross_checks():
    skip_without_exe()
    table, problems = bst.build_table(WA2_EXE)
    assert problems == []
    # Region A slot keys: 185 scripts, NULL-terminated in the exe table.
    scripts = table["scripts"]
    assert len(scripts) == 185
    assert scripts[0] == "1001" and scripts[-1] == "5104"
    # Choice table is numeric u32 ids, matching the flow order.
    assert [int(s) for s in table["choiceTable"]["scriptIds"]] == [
        2003, 2004, 2005, 2007, 2009, 2011, 2013, 2014, 2015, 2016, 2017,
        2018, 2019, 2024, 2503, 3003, 3005, 3009, 3012, 3013, 3014, 3016,
        3904]
    rows = table["cgRows"]
    assert len(rows) == 168
    ids = [v for row in rows for v in row if v]
    assert len(ids) == 272


def test_exe_gallery_table_ends_before_ero_records():
    """0x4c1bf0 - 0x4c01b0 is exactly 168 rows of 10 u32; row 168 differs."""
    skip_without_exe()
    with open(WA2_EXE, "rb") as f:
        data = f.read()
    image_base, sections = bst.parse_pe(data)
    assert (bst.GALLERY_END_VA - bst.GALLERY_TABLE_VA) == (
        bst.GALLERY_ROWS * bst.GALLERY_COLS * 4)
    beyond = bst.read_u32s(data, sections, image_base,
                           bst.GALLERY_END_VA, 4)
    assert not all(bst._is_cg_id(v) for v in beyond if v)
    # The 24 ero-scene records have u32 slots 80, 300..322.
    ero_slots = [bst.read_u32s(data, sections, image_base,
                               bst.GALLERY_END_VA + i * 20 + 4, 1)[0]
                 for i in range(24)]
    assert ero_slots[0] == 80
    assert ero_slots[1:] == list(range(300, 323))
